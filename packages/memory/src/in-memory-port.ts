/**
 * The deterministic reference adapter.
 *
 * It is the executable definition of the port's semantics: atomic
 * entry-plus-event application, strict version checking, scope-keyed storage
 * with no cross-scope path, and a stable listing order. Because JavaScript
 * runs the whole `apply` body without interleaving, atomicity is free here;
 * a durable adapter has to earn it, and the contract suite is written to
 * notice if it does not.
 */

import { memoryFailure, MemoryError } from "./errors.js";
import {
  type ApplyOutcome,
  type MemoryApplyCommand,
  type MemoryEntry,
  type MemoryEvent,
  type MemoryStorePort,
} from "./port.js";

interface ScopeBucket {
  readonly entries: Map<string, MemoryEntry>;
  readonly byIdempotencyKey: Map<string, string>;
  readonly events: MemoryEvent[];
}

export interface InMemoryMemoryStore extends MemoryStorePort {
  /** Total events across every scope; used by tests to prove auditability. */
  eventCount(): number;
  /** True once `close()` has run. */
  isClosed(): boolean;
}

export function createInMemoryMemoryStore(): InMemoryMemoryStore {
  const scopes = new Map<string, ScopeBucket>();
  let sequence = 0;
  let closed = false;

  function assertOpen(): void {
    if (closed) {
      throw new MemoryError("STORE_CLOSED", "The memory store is closed.");
    }
  }

  function bucket(scopeKey: string): ScopeBucket {
    let existing = scopes.get(scopeKey);
    if (existing === undefined) {
      existing = { entries: new Map(), byIdempotencyKey: new Map(), events: [] };
      scopes.set(scopeKey, existing);
    }
    return existing;
  }

  return Object.freeze({
    get: async (scopeKey: string, recordId: string): Promise<MemoryEntry | null> => {
      assertOpen();
      return bucket(scopeKey).entries.get(recordId) ?? null;
    },

    list: async (scopeKey: string): Promise<readonly MemoryEntry[]> => {
      assertOpen();
      return Object.freeze(
        [...bucket(scopeKey).entries.values()].sort((a, b) =>
          a.record.recordId < b.record.recordId ? -1 : a.record.recordId > b.record.recordId ? 1 : 0,
        ),
      );
    },

    findByIdempotencyKey: async (scopeKey: string, key: string): Promise<MemoryEntry | null> => {
      assertOpen();
      const scope = bucket(scopeKey);
      const recordId = scope.byIdempotencyKey.get(key);
      return recordId === undefined ? null : (scope.entries.get(recordId) ?? null);
    },

    apply: async (command: MemoryApplyCommand): Promise<ApplyOutcome> => {
      assertOpen();
      const scope = bucket(command.scopeKey);
      const recordId = command.entry.record.recordId;
      const existing = scope.entries.get(recordId);

      if (command.expectedVersion === null) {
        if (existing !== undefined) {
          return "already-exists";
        }
      } else if (existing === undefined) {
        return "missing";
      } else if (existing.version !== command.expectedVersion) {
        return "version-conflict";
      }

      if (command.entry.record.scope === undefined) {
        throw new MemoryError("STORE_FAILURE", "The entry carries no scope.", {});
      }

      // Both writes happen here, together. Nothing observes an intermediate
      // state because nothing can run between these statements.
      sequence += 1;
      scope.entries.set(recordId, command.entry);
      if (command.entry.idempotencyKey !== null) {
        scope.byIdempotencyKey.set(command.entry.idempotencyKey, recordId);
      }
      scope.events.push(Object.freeze({ ...command.event, sequence }));
      return "applied";
    },

    listEvents: async (scopeKey: string, limit: number): Promise<readonly MemoryEvent[]> => {
      assertOpen();
      if (!Number.isSafeInteger(limit) || limit < 0) {
        throw new MemoryError("STORE_FAILURE", "The event limit is out of range.");
      }
      return Object.freeze(bucket(scopeKey).events.slice(0, limit));
    },

    close: async (): Promise<void> => {
      closed = true;
      scopes.clear();
    },

    eventCount: (): number => sequence,
    isClosed: (): boolean => closed,
  });
}

/**
 * Wraps a port so that a chosen operation fails once. Used by the contract
 * suite to prove that a store failure is surfaced conservatively rather than
 * being swallowed into a partially-applied state.
 */
export function withInjectedFailure(
  port: MemoryStorePort,
  failOn: { readonly operation: "apply" | "get" | "list"; readonly times: number },
): MemoryStorePort {
  let remaining = failOn.times;
  const maybeFail = (operation: string): void => {
    if (operation === failOn.operation && remaining > 0) {
      remaining -= 1;
      throw new MemoryError("STORE_FAILURE", "Injected store failure.", { operation });
    }
  };
  return Object.freeze({
    get: async (scopeKey: string, recordId: string) => {
      maybeFail("get");
      return port.get(scopeKey, recordId);
    },
    list: async (scopeKey: string) => {
      maybeFail("list");
      return port.list(scopeKey);
    },
    findByIdempotencyKey: (scopeKey: string, key: string) =>
      port.findByIdempotencyKey(scopeKey, key),
    apply: async (command: MemoryApplyCommand) => {
      maybeFail("apply");
      return port.apply(command);
    },
    listEvents: (scopeKey: string, limit: number) => port.listEvents(scopeKey, limit),
    close: () => port.close(),
  });
}

/** The failure a store adapter's own defect maps to. Never leaks its message. */
export function storeFailure(operation: string): ReturnType<typeof memoryFailure> {
  return memoryFailure("STORE_FAILURE", "The memory store adapter failed.", { operation });
}
