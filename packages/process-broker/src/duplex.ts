/**
 * Bounded queues for long-lived bidirectional process sessions.
 *
 * A duplex session is intentionally byte-oriented. Protocol framing belongs
 * to the caller, while the broker owns memory bounds, write serialization,
 * process lifetime, and admission. Output chunks remain separated by stream.
 */

import { invalidRequest } from "./errors.js";
import type { OutputStreamName } from "./output.js";

export interface DuplexSessionLimits {
  /** Largest individual write accepted by write(). */
  readonly maxMessageBytes: number;
  /** Bytes accepted but not yet acknowledged by the backend. */
  readonly maxQueuedWriteBytes: number;
  /** Cumulative bytes accepted across the session. */
  readonly maxTotalWriteBytes: number;
  /** Largest output event exposed to a consumer. Larger backend chunks split. */
  readonly maxEventBytes: number;
  /** Events retained while the consumer is not reading. */
  readonly maxQueuedEvents: number;
  /** Output bytes retained while the consumer is not reading. */
  readonly maxQueuedEventBytes: number;
}

export const DEFAULT_DUPLEX_SESSION_LIMITS: DuplexSessionLimits = Object.freeze({
  maxMessageBytes: 1_048_576,
  maxQueuedWriteBytes: 2_097_152,
  maxTotalWriteBytes: 16_777_216,
  maxEventBytes: 262_144,
  maxQueuedEvents: 256,
  maxQueuedEventBytes: 2_097_152,
});

const LIMIT_KEYS = [
  "maxMessageBytes",
  "maxQueuedWriteBytes",
  "maxTotalWriteBytes",
  "maxEventBytes",
  "maxQueuedEvents",
  "maxQueuedEventBytes",
] as const;

function readLimit(
  record: Readonly<Record<string, unknown>>,
  name: (typeof LIMIT_KEYS)[number],
  maximum: number,
  path: string,
): number {
  const value = record[name];
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw invalidRequest("A duplex-session limit is out of range.", {
      field: `${path}.${name}`,
    });
  }
  return value as number;
}

export function parseDuplexSessionLimits(
  value: unknown,
  path = "limits",
): DuplexSessionLimits {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidRequest("Duplex-session limits must be an object.", { field: path });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidRequest("Duplex-session limits must be a plain data object.", { field: path });
  }
  const record = value as Readonly<Record<string, unknown>>;
  const actual = Object.keys(record).sort();
  const expected = [...LIMIT_KEYS].sort();
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    throw invalidRequest("Duplex-session limits contain unknown or missing fields.", {
      field: path,
    });
  }

  const limits: DuplexSessionLimits = {
    maxMessageBytes: readLimit(record, "maxMessageBytes", 16_777_216, path),
    maxQueuedWriteBytes: readLimit(record, "maxQueuedWriteBytes", 67_108_864, path),
    maxTotalWriteBytes: readLimit(record, "maxTotalWriteBytes", 1_073_741_824, path),
    maxEventBytes: readLimit(record, "maxEventBytes", 16_777_216, path),
    maxQueuedEvents: readLimit(record, "maxQueuedEvents", 65_536, path),
    maxQueuedEventBytes: readLimit(record, "maxQueuedEventBytes", 67_108_864, path),
  };
  if (limits.maxQueuedWriteBytes < limits.maxMessageBytes) {
    throw invalidRequest("The queued-write limit must admit one complete message.", { field: path });
  }
  if (limits.maxTotalWriteBytes < limits.maxMessageBytes) {
    throw invalidRequest("The total-write limit must admit one complete message.", { field: path });
  }
  if (limits.maxQueuedEventBytes < limits.maxEventBytes) {
    throw invalidRequest("The queued-event byte limit must admit one complete event.", {
      field: path,
    });
  }
  return Object.freeze(limits);
}

export function createDuplexSessionLimits(
  overrides: Partial<DuplexSessionLimits> = {},
): DuplexSessionLimits {
  return parseDuplexSessionLimits({ ...DEFAULT_DUPLEX_SESSION_LIMITS, ...overrides });
}

export interface DuplexSessionOutputEvent {
  readonly sequence: number;
  readonly stream: OutputStreamName;
  readonly chunk: Uint8Array;
}

interface PendingRead {
  readonly resolve: (result: IteratorResult<DuplexSessionOutputEvent>) => void;
}

/** Internal bounded async queue. Exported only for focused contract tests. */
export class BoundedDuplexEventQueue implements AsyncIterable<DuplexSessionOutputEvent> {
  readonly #limits: DuplexSessionLimits;
  readonly #events: DuplexSessionOutputEvent[] = [];
  readonly #readers: PendingRead[] = [];
  #queuedBytes = 0;
  #sequence = 0;
  #finished = false;
  #consumerClosed = false;

  constructor(limits: DuplexSessionLimits) {
    this.#limits = limits;
  }

  get queuedEvents(): number {
    return this.#events.length;
  }

  get queuedBytes(): number {
    return this.#queuedBytes;
  }

  /** Returns false without retaining the chunk when queue bounds would be crossed. */
  push(stream: OutputStreamName, chunk: Uint8Array): boolean {
    if (this.#finished || this.#consumerClosed) {
      return true;
    }
    for (let offset = 0; offset < chunk.byteLength; offset += this.#limits.maxEventBytes) {
      const part = chunk.subarray(offset, offset + this.#limits.maxEventBytes);
      const event = Object.freeze({
        sequence: (this.#sequence += 1),
        stream,
        chunk: new Uint8Array(part),
      });
      const reader = this.#readers.shift();
      if (reader !== undefined) {
        reader.resolve({ done: false, value: event });
        continue;
      }
      if (
        this.#events.length >= this.#limits.maxQueuedEvents ||
        this.#queuedBytes + event.chunk.byteLength > this.#limits.maxQueuedEventBytes
      ) {
        return false;
      }
      this.#events.push(event);
      this.#queuedBytes += event.chunk.byteLength;
    }
    return true;
  }

  finish(): void {
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    if (this.#events.length === 0) {
      for (const reader of this.#readers.splice(0)) {
        reader.resolve({ done: true, value: undefined });
      }
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<DuplexSessionOutputEvent> {
    return {
      next: async (): Promise<IteratorResult<DuplexSessionOutputEvent>> => {
        const event = this.#events.shift();
        if (event !== undefined) {
          this.#queuedBytes -= event.chunk.byteLength;
          return { done: false, value: event };
        }
        if (this.#finished || this.#consumerClosed) {
          return { done: true, value: undefined };
        }
        return await new Promise<IteratorResult<DuplexSessionOutputEvent>>((resolve) => {
          this.#readers.push({ resolve });
        });
      },
      return: async (): Promise<IteratorResult<DuplexSessionOutputEvent>> => {
        this.#consumerClosed = true;
        this.#events.splice(0);
        this.#queuedBytes = 0;
        for (const reader of this.#readers.splice(0)) {
          reader.resolve({ done: true, value: undefined });
        }
        return { done: true, value: undefined };
      },
    };
  }
}
