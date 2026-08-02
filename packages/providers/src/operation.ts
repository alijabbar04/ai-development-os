import { toCanonicalJson } from "@ai-dev-os/domain";
import { ProviderError, toProviderError } from "./errors.js";
import {
  isTerminalEventKind,
  createEventSequenceValidator,
  FIRST_EVENT_SEQUENCE,
  type ProviderEventBase,
  type TerminalEventKind,
} from "./events.js";
import {
  type CancellationReason,
  type ExecutionTraceMetadata,
  type ProviderOperationId,
  PROVIDER_CONTRACT_SCHEMA_VERSION,
} from "./common.js";

/** Injectable time source (same convention as every other stage). */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = Object.freeze({
  now: (): Date => new Date(),
});

/**
 * One provider operation: an ordered single-use event stream plus a result
 * promise that settles in agreement with the stream's terminal event.
 *
 * - `events()` may be called exactly once; a second call throws.
 * - `result` settles when the terminal event is produced. Draining the
 *   stream is NOT required for the result to settle: events are buffered
 *   internally (bounded), so a caller may await only the result. The
 *   result promise never triggers unhandled-rejection warnings.
 * - `cancel()` is idempotent; the first terminal outcome wins every race.
 */
export interface ProviderOperation<TEvent, TResult> {
  readonly operationId: ProviderOperationId;
  events(): AsyncIterable<TEvent>;
  readonly result: Promise<TResult>;
  cancel(reason?: CancellationReason): Promise<void>;
}

export const MAX_BUFFERED_EVENTS = 10_000;
/** Maximum UTF-8 size of canonical JSON retained for unread events. */
export const MAX_BUFFERED_EVENT_CANONICAL_BYTES = 16 * 1_024 * 1_024;

// Non-terminal writes reserve enough of the aggregate budget for the
// controller's small, structured terminal-failure event. This keeps an
// overflow observable through a contiguous, valid terminal stream.
const TERMINAL_EVENT_CANONICAL_BYTE_RESERVE = 512 * 1_024;

type EventFactory<TEvent> = (base: {
  schemaVersion: typeof PROVIDER_CONTRACT_SCHEMA_VERSION;
  operationId: ProviderOperationId;
  sequence: number;
  occurredAt: string;
  trace: ExecutionTraceMetadata;
}) => TEvent;

export interface OperationController<TEvent extends ProviderEventBase, TResult> {
  readonly operation: ProviderOperation<TEvent, TResult>;
  /** True once a terminal outcome has been produced. */
  readonly isTerminal: boolean;
  readonly cancellationReason: CancellationReason | null;
  /** Emits a non-terminal event; throws after a terminal outcome. */
  emit(build: EventFactory<TEvent>): void;
  /** Terminal success: emits the completed event and resolves the result. */
  complete(buildEvent: EventFactory<TEvent>, result: TResult): void;
  /** Terminal failure: emits the failed event and rejects the result. */
  fail(buildEvent: EventFactory<TEvent>, error: ProviderError): void;
  /** Registers the terminal-cancelled event builder used when cancel() wins. */
  onCancel(handler: (reason: CancellationReason) => void): void;
}

/**
 * Invariant-enforcing machinery for adapters and fakes: sequences,
 * timestamps, single terminal outcome, result/event agreement, and bounded
 * buffering all hold by construction for any provider built on it.
 */
export function createOperationController<
  TEvent extends ProviderEventBase & { readonly kind: string },
  TResult,
>(options: {
  readonly operationId: ProviderOperationId;
  readonly clock: Clock;
  readonly trace: ExecutionTraceMetadata;
  readonly buildCancelledEvent: (
    base: Parameters<EventFactory<TEvent>>[0],
    reason: CancellationReason,
  ) => TEvent;
  readonly onTerminal?: (outcome: {
    readonly kind: TerminalEventKind;
    readonly error: ProviderError | null;
    readonly cancellationReason: CancellationReason | null;
  }) => void;
}): OperationController<TEvent, TResult> {
  const { operationId, clock, trace } = options;
  let sequence = FIRST_EVENT_SEQUENCE;
  let terminalKind: TerminalEventKind | null = null;
  let cancellationReason: CancellationReason | null = null;
  type BufferedEvent = { readonly event: TEvent; readonly canonicalBytes: number };
  const buffered: Array<BufferedEvent | undefined> = [];
  let bufferHead = 0;
  let unreadEventCount = 0;
  let bufferedCanonicalBytes = 0;
  const waiters: Array<() => void> = [];
  let streamConsumed = false;
  const cancelHandlers: Array<(reason: CancellationReason) => void> = [];

  let resolveResult!: (value: TResult) => void;
  let rejectResult!: (error: ProviderError) => void;
  const result = new Promise<TResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // The result must never produce an unhandled rejection when a caller
  // only consumes the event stream.
  result.catch(() => undefined);

  function nextBase(): Parameters<EventFactory<TEvent>>[0] {
    const base = {
      schemaVersion: PROVIDER_CONTRACT_SCHEMA_VERSION,
      operationId,
      sequence,
      occurredAt: clock.now().toISOString(),
      trace,
    };
    sequence += 1;
    return base;
  }

  function utf8ByteLength(text: string): number {
    let bytes = 0;
    for (let index = 0; index < text.length; index += 1) {
      const codeUnit = text.charCodeAt(index);
      if (codeUnit <= 0x7f) {
        bytes += 1;
      } else if (codeUnit <= 0x7ff) {
        bytes += 2;
      } else if (
        codeUnit >= 0xd800 &&
        codeUnit <= 0xdbff &&
        index + 1 < text.length &&
        text.charCodeAt(index + 1) >= 0xdc00 &&
        text.charCodeAt(index + 1) <= 0xdfff
      ) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    }
    return bytes;
  }

  function eventCanonicalBytes(event: TEvent): number {
    return utf8ByteLength(toCanonicalJson(event));
  }

  function wakeStreamConsumers(): void {
    const pending = waiters.splice(0, waiters.length);
    for (const wake of pending) {
      wake();
    }
  }

  function enqueue(event: TEvent, canonicalBytes: number): void {
    buffered.push(Object.freeze({ event, canonicalBytes }));
    unreadEventCount += 1;
    bufferedCanonicalBytes += canonicalBytes;
    wakeStreamConsumers();
  }

  function overflow(event: TEvent, attemptedCanonicalBytes: number): never {
    const error = new ProviderError(
      "PROTOCOL_VIOLATION",
      "The operation exceeded its bounded event buffer.",
      {
        bufferedEventCount: unreadEventCount,
        bufferedCanonicalBytes,
        attemptedEventCanonicalBytes: attemptedCanonicalBytes,
        maximumEventCount: MAX_BUFFERED_EVENTS,
        maximumCanonicalBytes: MAX_BUFFERED_EVENT_CANONICAL_BYTES,
      },
      { operationId, traceId: trace.traceId },
    );
    const terminalEvent = {
      schemaVersion: event.schemaVersion,
      operationId: event.operationId,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      trace: event.trace,
      kind: "operation-failed",
      payload: {
        code: error.code,
        message: error.message,
        retryStrategy: error.retry.strategy,
      },
    } as unknown as TEvent;
    const terminalBytes = eventCanonicalBytes(terminalEvent);
    // The fixed reserve is deliberately larger than any validated terminal
    // failure event. Keep this defensive check so a future schema expansion
    // cannot silently defeat the aggregate bound.
    if (
      terminalBytes > TERMINAL_EVENT_CANONICAL_BYTE_RESERVE ||
      unreadEventCount + 1 > MAX_BUFFERED_EVENTS ||
      bufferedCanonicalBytes + terminalBytes > MAX_BUFFERED_EVENT_CANONICAL_BYTES
    ) {
      throw new ProviderError(
        "INTERNAL_FAILURE",
        "The bounded operation buffer could not retain its terminal event.",
        {
          maximumEventCount: MAX_BUFFERED_EVENTS,
          maximumCanonicalBytes: MAX_BUFFERED_EVENT_CANONICAL_BYTES,
        },
        { operationId, traceId: trace.traceId },
      );
    }
    enqueue(terminalEvent, terminalBytes);
    settleTerminal("operation-failed", error);
    rejectResult(error);
    throw error;
  }

  function push(event: TEvent): void {
    const canonicalBytes = eventCanonicalBytes(event);
    const terminal = isTerminalEventKind(event.kind);
    const countLimit = terminal ? MAX_BUFFERED_EVENTS : MAX_BUFFERED_EVENTS - 1;
    const byteLimit = terminal
      ? MAX_BUFFERED_EVENT_CANONICAL_BYTES
      : MAX_BUFFERED_EVENT_CANONICAL_BYTES - TERMINAL_EVENT_CANONICAL_BYTE_RESERVE;
    if (
      unreadEventCount + 1 > countLimit ||
      bufferedCanonicalBytes + canonicalBytes > byteLimit
    ) {
      overflow(event, canonicalBytes);
    }
    enqueue(event, canonicalBytes);
  }

  function assertNotTerminal(): void {
    if (terminalKind !== null) {
      throw new ProviderError(
        "PROTOCOL_VIOLATION",
        "The operation already produced its terminal outcome.",
        { terminalKind },
      );
    }
  }

  function settleTerminal(kind: TerminalEventKind, error: ProviderError | null): void {
    terminalKind = kind;
    options.onTerminal?.(Object.freeze({ kind, error, cancellationReason }));
  }

  const operation: ProviderOperation<TEvent, TResult> = Object.freeze({
    operationId,
    events(): AsyncIterable<TEvent> {
      if (streamConsumed) {
        throw new ProviderError("PROTOCOL_VIOLATION", "The event stream is single-use.", {});
      }
      streamConsumed = true;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<TEvent>> {
              for (;;) {
                if (unreadEventCount > 0) {
                  const entry = buffered[bufferHead];
                  if (entry === undefined) {
                    throw new ProviderError(
                      "INTERNAL_FAILURE",
                      "The operation event buffer became inconsistent.",
                      {},
                    );
                  }
                  buffered[bufferHead] = undefined;
                  bufferHead += 1;
                  unreadEventCount -= 1;
                  bufferedCanonicalBytes -= entry.canonicalBytes;
                  if (bufferHead >= 1_024 && bufferHead * 2 >= buffered.length) {
                    buffered.splice(0, bufferHead);
                    bufferHead = 0;
                  }
                  return { done: false, value: entry.event };
                }
                if (terminalKind !== null) {
                  return { done: true, value: undefined };
                }
                await new Promise<void>((wake) => {
                  waiters.push(wake);
                });
              }
            },
          };
        },
      };
    },
    result,
    async cancel(reason: CancellationReason = "caller-requested"): Promise<void> {
      if (terminalKind !== null) {
        return;
      }
      cancellationReason = reason;
      const event = options.buildCancelledEvent(nextBase(), reason);
      push(event);
      settleTerminal("operation-cancelled", null);
      rejectResult(
        new ProviderError("CANCELLED", "The operation was cancelled.", { reason }, {
          operationId,
          traceId: trace.traceId,
        }),
      );
      for (const handler of cancelHandlers.splice(0, cancelHandlers.length)) {
        handler(reason);
      }
      // Wake any pending stream consumers so they observe the terminal.
      for (const wake of waiters.splice(0, waiters.length)) {
        wake();
      }
    },
  });

  return {
    operation,
    get isTerminal(): boolean {
      return terminalKind !== null;
    },
    get cancellationReason(): CancellationReason | null {
      return cancellationReason;
    },
    emit(build: EventFactory<TEvent>): void {
      assertNotTerminal();
      const event = build(nextBase());
      if (isTerminalEventKind(event.kind)) {
        throw new ProviderError(
          "PROTOCOL_VIOLATION",
          "Terminal events must be emitted through complete(), fail(), or cancel().",
          {},
        );
      }
      push(event);
    },
    complete(buildEvent: EventFactory<TEvent>, value: TResult): void {
      assertNotTerminal();
      push(buildEvent(nextBase()));
      settleTerminal("operation-completed", null);
      resolveResult(value);
      for (const wake of waiters.splice(0, waiters.length)) {
        wake();
      }
    },
    fail(buildEvent: EventFactory<TEvent>, error: ProviderError): void {
      assertNotTerminal();
      push(buildEvent(nextBase()));
      settleTerminal("operation-failed", error);
      rejectResult(error);
      for (const wake of waiters.splice(0, waiters.length)) {
        wake();
      }
    },
    onCancel(handler: (reason: CancellationReason) => void): void {
      if (cancellationReason !== null) {
        handler(cancellationReason);
        return;
      }
      cancelHandlers.push(handler);
    },
  };
}

/**
 * Consumer-side validation: wraps ANY provider operation so that a
 * transport-level success can never bypass result validation. The wrapped
 * stream re-validates every event (schema + ordering invariants) and
 * cross-checks the terminal event against the result's settlement; the
 * wrapped result re-validates the result value. Full stream/result
 * agreement checking requires draining the stream; the result value alone
 * is still always schema-validated.
 */
export function guardProviderOperation<TEvent extends ProviderEventBase & { kind: string }, TResult>(
  operation: ProviderOperation<TEvent, TResult>,
  options: {
    readonly parseEvent: (value: unknown) => TEvent;
    readonly parseResult: (value: unknown) => TResult;
  },
): ProviderOperation<TEvent, TResult> {
  let resultState: "pending" | "resolved" | "rejected" = "pending";
  operation.result.then(
    () => {
      resultState = "resolved";
    },
    () => {
      resultState = "rejected";
    },
  );

  const guardedResult = operation.result.then((value) => options.parseResult(value));
  guardedResult.catch(() => undefined);

  return Object.freeze({
    operationId: operation.operationId,
    events(): AsyncIterable<TEvent> {
      const source = operation.events();
      const validator = createEventSequenceValidator(operation.operationId);
      return (async function* guarded(): AsyncIterable<TEvent> {
        for await (const raw of source) {
          const event = options.parseEvent(raw);
          validator.check(event);
          if (isTerminalEventKind(event.kind)) {
            // Give the result promise a chance to settle before comparing.
            await Promise.resolve();
            await Promise.resolve();
            const kind = event.kind as TerminalEventKind;
            if (kind === "operation-completed" && resultState === "rejected") {
              throw new ProviderError(
                "PROTOCOL_VIOLATION",
                "The stream reported completion but the result rejected.",
                {},
              );
            }
            if (kind !== "operation-completed" && resultState === "resolved") {
              throw new ProviderError(
                "PROTOCOL_VIOLATION",
                "The stream reported failure or cancellation but the result resolved.",
                { terminalKind: kind },
              );
            }
          }
          yield event;
        }
        validator.finish();
      })();
    },
    result: guardedResult,
    cancel: (reason?: CancellationReason) => operation.cancel(reason),
  });
}

/** Normalizes unknown thrown values at the provider boundary. */
export function ensureProviderError(value: unknown): ProviderError {
  return toProviderError(value);
}
