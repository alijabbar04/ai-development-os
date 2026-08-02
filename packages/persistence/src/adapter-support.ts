import { AsyncLocalStorage } from "node:async_hooks";
import { ValidationError } from "@ai-dev-os/domain";
import { PersistenceError } from "./errors.js";
import type {
  Clock,
  OperationOutcome,
  PersistenceObserver,
} from "./ports.js";
import type { AggregateType } from "./records.js";

/**
 * Adapter-support utilities shared by concrete adapters so that memory and
 * SQLite report and behave identically. Not part of the persistence
 * contract consumed by application code.
 */

/** Maps a thrown error to a structured operation outcome. */
export function outcomeOfError(error: unknown): OperationOutcome {
  if (error instanceof ValidationError) {
    return "validation-failed";
  }
  if (error instanceof PersistenceError) {
    switch (error.code) {
      case "CONCURRENCY_CONFLICT":
      case "OUTBOX_STATE_CONFLICT":
        return "conflict";
      case "NOT_FOUND":
        return "not-found";
      case "DUPLICATE_ID":
      case "DUPLICATE_IDEMPOTENCY_KEY":
        return "duplicate";
      case "CORRUPTION_DETECTED":
        return "corruption";
      default:
        return "error";
    }
  }
  return "error";
}

/**
 * Runs one store operation, reporting a structured record to the observer.
 * The record never contains payloads or identifiers beyond the aggregate
 * type. Observer failures are deliberately not swallowed silently into
 * results: a throwing observer is a programming error and propagates.
 */
export async function observeOperation<T>(
  observer: PersistenceObserver | undefined,
  clock: Clock,
  operation: string,
  aggregateType: AggregateType | null,
  work: () => Promise<T> | T,
): Promise<T> {
  if (observer === undefined) {
    return await work();
  }
  const startedAt = clock.now().valueOf();
  try {
    const result = await work();
    observer(
      Object.freeze({
        operation,
        outcome: "success" as const,
        aggregateType,
        durationMs: Math.max(0, clock.now().valueOf() - startedAt),
      }),
    );
    return result;
  } catch (error) {
    observer(
      Object.freeze({
        operation,
        outcome: outcomeOfError(error),
        aggregateType,
        durationMs: Math.max(0, clock.now().valueOf() - startedAt),
      }),
    );
    throw error;
  }
}

/**
 * Detects transact() calls made from inside an active transaction callback
 * (including across awaits) without blocking legitimate concurrent callers.
 */
export class TransactionGuard {
  readonly #storage = new AsyncLocalStorage<true>();

  assertNotNested(): void {
    if (this.#storage.getStore() === true) {
      throw new PersistenceError(
        "NESTED_TRANSACTION",
        "Nested transactions are not supported; complete the active transaction first.",
      );
    }
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    return this.#storage.run(true, work);
  }
}

/** Shared session flag backing use-after-completion and closed-adapter checks. */
export class SessionGate {
  #active = true;
  readonly #code: "TRANSACTION_COMPLETED" | "ADAPTER_CLOSED";
  readonly #message: string;

  constructor(code: "TRANSACTION_COMPLETED" | "ADAPTER_CLOSED", message: string) {
    this.#code = code;
    this.#message = message;
  }

  close(): void {
    this.#active = false;
  }

  get active(): boolean {
    return this.#active;
  }

  assertActive(): void {
    if (!this.#active) {
      throw new PersistenceError(this.#code, this.#message);
    }
  }
}
