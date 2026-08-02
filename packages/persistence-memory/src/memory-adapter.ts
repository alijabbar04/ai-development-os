import {
  parseArtifactDescriptor,
  parseArtifactManifest,
  type ArtifactDescriptor,
  type ArtifactManifest,
} from "@ai-dev-os/artifacts";
import { parseJsonText, validation } from "@ai-dev-os/domain";
import {
  AsyncMutex,
  OUTBOX_STATUSES,
  PersistenceError,
  SessionGate,
  TransactionGuard,
  applyAcknowledge,
  applyClaim,
  applyDeadLetter,
  applyScheduleRetry,
  buildPage,
  decodeCursor,
  isClaimable,
  leaseExpiry,
  normalizePageSize,
  observeOperation,
  parseAggregateType,
  parsePersistedId,
  preparePayload,
  systemClock,
  validateAppendEventInput,
  validateClaimOutboxInput,
  validateCreateAggregateInput,
  validateEnqueueOutboxInput,
  validateUpdateAggregateInput,
  verifyChecksum,
  type AdapterOptions,
  type AggregateEnvelope,
  type AggregateStore,
  type AggregateType,
  type ArtifactMetadataStore,
  type Checksum,
  type Clock,
  type EventRecord,
  type EventStore,
  type MigrationStatus,
  type OutboxMessage,
  type OutboxStore,
  type Page,
  type PersistenceAdapter,
  type PersistenceObserver,
  type TransactionContext,
} from "@ai-dev-os/persistence";

const { ensureEnum, fail } = validation;

interface StoredAggregate {
  readonly aggregateType: AggregateType;
  readonly aggregateId: string;
  readonly schemaVersion: number;
  readonly aggregateVersion: number;
  readonly payloadText: string;
  readonly checksum: Checksum;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly traceId: string | null;
}

interface StoredEvent {
  readonly eventId: string;
  readonly aggregateType: AggregateType;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly eventType: string;
  readonly eventSchemaVersion: number;
  readonly payloadText: string;
  readonly checksum: Checksum;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly globalSequence: number;
  readonly traceId: string | null;
  readonly causationId: string | null;
}

type StoredOutbox = Omit<OutboxMessage, "payload"> & { readonly payloadText: string };

interface StoredArtifact {
  readonly id: string;
  readonly payloadText: string;
  readonly checksum: Checksum;
}

interface MemoryState {
  aggregates: Map<AggregateType, Map<string, StoredAggregate>>;
  events: Map<string, StoredEvent>;
  eventSequence: number;
  outbox: Map<string, StoredOutbox>;
  idempotencyKeys: Map<string, string>;
  outboxSequence: number;
  artifacts: Map<string, StoredArtifact>;
  manifests: Map<string, StoredArtifact>;
}

interface StateSnapshot {
  readonly aggregates: Map<AggregateType, Map<string, StoredAggregate>>;
  readonly events: Map<string, StoredEvent>;
  readonly eventSequence: number;
  readonly outbox: Map<string, StoredOutbox>;
  readonly idempotencyKeys: Map<string, string>;
  readonly outboxSequence: number;
  readonly artifacts: Map<string, StoredArtifact>;
  readonly manifests: Map<string, StoredArtifact>;
}

function snapshotState(state: MemoryState): StateSnapshot {
  const aggregates = new Map<AggregateType, Map<string, StoredAggregate>>();
  for (const [type, byId] of state.aggregates) {
    aggregates.set(type, new Map(byId));
  }
  return {
    aggregates,
    events: new Map(state.events),
    eventSequence: state.eventSequence,
    outbox: new Map(state.outbox),
    idempotencyKeys: new Map(state.idempotencyKeys),
    outboxSequence: state.outboxSequence,
    artifacts: new Map(state.artifacts),
    manifests: new Map(state.manifests),
  };
}

function restoreState(state: MemoryState, snapshot: StateSnapshot): void {
  state.aggregates = snapshot.aggregates;
  state.events = snapshot.events;
  state.eventSequence = snapshot.eventSequence;
  state.outbox = snapshot.outbox;
  state.idempotencyKeys = snapshot.idempotencyKeys;
  state.outboxSequence = snapshot.outboxSequence;
  state.artifacts = snapshot.artifacts;
  state.manifests = snapshot.manifests;
}

function toEnvelope(stored: StoredAggregate): AggregateEnvelope {
  verifyChecksum(stored.payloadText, stored.checksum, {
    recordKind: "aggregate",
    recordId: stored.aggregateId,
  });
  return Object.freeze({
    aggregateType: stored.aggregateType,
    aggregateId: stored.aggregateId,
    schemaVersion: stored.schemaVersion,
    aggregateVersion: stored.aggregateVersion,
    payload: parseJsonText(stored.payloadText, "aggregate.payload"),
    checksum: stored.checksum,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    traceId: stored.traceId,
  });
}

function toEventRecord(stored: StoredEvent): EventRecord {
  verifyChecksum(stored.payloadText, stored.checksum, {
    recordKind: "event",
    recordId: stored.eventId,
  });
  const { payloadText, ...rest } = stored;
  return Object.freeze({
    ...rest,
    payload: parseJsonText(payloadText, "event.payload"),
  });
}

function toOutboxMessage(stored: StoredOutbox): OutboxMessage {
  verifyChecksum(stored.payloadText, stored.checksum, {
    recordKind: "outbox-message",
    recordId: stored.messageId,
  });
  const { payloadText, ...rest } = stored;
  return Object.freeze({
    ...rest,
    payload: parseJsonText(payloadText, "outbox.payload"),
  });
}

function sortedBySequence<T extends { readonly sequence: number }>(values: Iterable<T>): T[] {
  return [...values].sort((a, b) => a.sequence - b.sequence);
}

function createContext(
  state: MemoryState,
  clock: Clock,
  observer: PersistenceObserver | undefined,
  gate: SessionGate,
): TransactionContext {
  const run = <T>(
    operation: string,
    aggregateType: AggregateType | null,
    work: () => T,
  ): Promise<T> =>
    observeOperation(observer, clock, operation, aggregateType, () => {
      gate.assertActive();
      return work();
    });

  const byType = (aggregateType: AggregateType): Map<string, StoredAggregate> => {
    let map = state.aggregates.get(aggregateType);
    if (map === undefined) {
      map = new Map();
      state.aggregates.set(aggregateType, map);
    }
    return map;
  };

  const aggregates: AggregateStore = {
    create: (raw) =>
      run("aggregates.create", raw?.aggregateType ?? null, () => {
        const input = validateCreateAggregateInput(raw);
        const map = byType(input.aggregateType);
        const existing = map.get(input.aggregateId);
        if (existing !== undefined) {
          throw new PersistenceError(
            "CONCURRENCY_CONFLICT",
            "Cannot create an aggregate that already exists.",
            {
              aggregateType: input.aggregateType,
              aggregateId: input.aggregateId,
              actualVersion: existing.aggregateVersion,
            },
          );
        }
        const nowIso = clock.now().toISOString();
        const stored: StoredAggregate = {
          aggregateType: input.aggregateType,
          aggregateId: input.aggregateId,
          schemaVersion: input.schemaVersion,
          aggregateVersion: 1,
          payloadText: input.payloadText,
          checksum: input.checksum,
          createdAt: nowIso,
          updatedAt: nowIso,
          traceId: input.traceId,
        };
        map.set(input.aggregateId, stored);
        return toEnvelope(stored);
      }),

    update: (raw) =>
      run("aggregates.update", raw?.aggregateType ?? null, () => {
        const input = validateUpdateAggregateInput(raw);
        const map = byType(input.aggregateType);
        const existing = map.get(input.aggregateId);
        if (existing === undefined) {
          throw new PersistenceError("NOT_FOUND", "Cannot update a missing aggregate.", {
            aggregateType: input.aggregateType,
            aggregateId: input.aggregateId,
          });
        }
        if (existing.aggregateVersion !== input.expectedVersion) {
          throw new PersistenceError(
            "CONCURRENCY_CONFLICT",
            "The aggregate was modified by another writer.",
            {
              aggregateType: input.aggregateType,
              aggregateId: input.aggregateId,
              expectedVersion: input.expectedVersion,
              actualVersion: existing.aggregateVersion,
            },
          );
        }
        const stored: StoredAggregate = {
          ...existing,
          schemaVersion: input.schemaVersion,
          aggregateVersion: input.expectedVersion + 1,
          payloadText: input.payloadText,
          checksum: input.checksum,
          updatedAt: clock.now().toISOString(),
          traceId: input.traceId,
        };
        map.set(input.aggregateId, stored);
        return toEnvelope(stored);
      }),

    get: (aggregateType, aggregateId) =>
      run("aggregates.get", aggregateType ?? null, () => {
        const type = parseAggregateType(aggregateType);
        const id = parsePersistedId(aggregateId, "aggregateId");
        const stored = state.aggregates.get(type)?.get(id);
        return stored === undefined ? null : toEnvelope(stored);
      }),

    list: (query) =>
      run("aggregates.list", query?.aggregateType ?? null, () => {
        const type = parseAggregateType(query.aggregateType);
        const limit = normalizePageSize(query.limit);
        const after =
          query.cursor === undefined || query.cursor === null
            ? null
            : decodeCursor(query.cursor, "string-key").lastKey;
        const items = [...(state.aggregates.get(type)?.values() ?? [])]
          .sort((a, b) => (a.aggregateId < b.aggregateId ? -1 : 1))
          .filter((stored) => after === null || stored.aggregateId > after)
          .slice(0, limit + 1)
          .map(toEnvelope);
        return buildPage(items, limit, (item) => ({
          kind: "string-key",
          lastKey: item.aggregateId,
        }));
      }),
  };

  const events: EventStore = {
    append: (raw) =>
      run("events.append", raw?.aggregateType ?? null, () => {
        const input = validateAppendEventInput(raw);
        if (state.events.has(input.eventId)) {
          throw new PersistenceError("DUPLICATE_ID", "The event id was already recorded.", {
            eventId: input.eventId,
          });
        }
        state.eventSequence += 1;
        const stored: StoredEvent = {
          eventId: input.eventId,
          aggregateType: input.aggregateType,
          aggregateId: input.aggregateId,
          aggregateVersion: input.aggregateVersion,
          eventType: input.eventType,
          eventSchemaVersion: input.eventSchemaVersion,
          payloadText: input.payloadText,
          checksum: input.checksum,
          occurredAt: input.occurredAt,
          recordedAt: clock.now().toISOString(),
          globalSequence: state.eventSequence,
          traceId: input.traceId,
          causationId: input.causationId,
        };
        state.events.set(input.eventId, stored);
        return toEventRecord(stored);
      }),

    list: (query) =>
      run("events.list", query?.aggregateType ?? null, () => {
        const type =
          query?.aggregateType === undefined ? null : parseAggregateType(query.aggregateType);
        const id =
          query?.aggregateId === undefined
            ? null
            : parsePersistedId(query.aggregateId, "aggregateId");
        if (id !== null && type === null) {
          fail("events.list", "missing_aggregate_type", "aggregateType is required when filtering by aggregateId.");
        }
        const limit = normalizePageSize(query?.limit);
        const after =
          query?.cursor === undefined || query.cursor === null
            ? null
            : decodeCursor(query.cursor, "sequence").lastSequence;
        const items = [...state.events.values()]
          .sort((a, b) => a.globalSequence - b.globalSequence)
          .filter(
            (stored) =>
              (type === null || stored.aggregateType === type) &&
              (id === null || stored.aggregateId === id) &&
              (after === null || stored.globalSequence > after),
          )
          .slice(0, limit + 1)
          .map(toEventRecord);
        return buildPage(items, limit, (item) => ({
          kind: "sequence",
          lastSequence: item.globalSequence,
        }));
      }),
  };

  const outbox: OutboxStore = {
    enqueue: (raw) =>
      run("outbox.enqueue", null, () => {
        const input = validateEnqueueOutboxInput(raw);
        if (state.outbox.has(input.messageId)) {
          throw new PersistenceError("DUPLICATE_ID", "The outbox message id already exists.", {
            messageId: input.messageId,
          });
        }
        if (state.idempotencyKeys.has(input.idempotencyKey)) {
          throw new PersistenceError(
            "DUPLICATE_IDEMPOTENCY_KEY",
            "The idempotency key was already used by another outbox message.",
            { idempotencyKey: input.idempotencyKey },
          );
        }
        const nowIso = clock.now().toISOString();
        state.outboxSequence += 1;
        const stored: StoredOutbox = {
          messageId: input.messageId,
          topic: input.topic,
          schemaVersion: input.schemaVersion,
          payloadText: input.payloadText,
          checksum: input.checksum,
          idempotencyKey: input.idempotencyKey,
          status: "pending",
          attemptCount: 0,
          createdAt: nowIso,
          availableAt: input.availableAt ?? nowIso,
          leaseOwner: null,
          leaseExpiresAt: null,
          acknowledgedAt: null,
          deadLetteredAt: null,
          lastFailureCategory: null,
          sequence: state.outboxSequence,
          traceId: input.traceId,
        };
        state.outbox.set(input.messageId, stored);
        state.idempotencyKeys.set(input.idempotencyKey, input.messageId);
        return toOutboxMessage(stored);
      }),

    claim: (raw) =>
      run("outbox.claim", null, () => {
        const input = validateClaimOutboxInput(raw);
        const now = clock.now();
        const nowIso = now.toISOString();
        const expiresAt = leaseExpiry(now, input.leaseDurationMs);
        const claimed: OutboxMessage[] = [];
        for (const stored of sortedBySequence(state.outbox.values())) {
          if (claimed.length >= input.limit) {
            break;
          }
          if (!isClaimable(stored, nowIso)) {
            continue;
          }
          const next = applyClaim(stored, { owner: input.owner, leaseExpiresAt: expiresAt });
          state.outbox.set(next.messageId, next);
          claimed.push(toOutboxMessage(next));
        }
        return Object.freeze(claimed);
      }),

    acknowledge: (raw) =>
      run("outbox.acknowledge", null, () => {
        const messageId = parsePersistedId(raw.messageId, "acknowledge.messageId");
        const stored = requireMessage(messageId);
        const result = applyAcknowledge(stored, {
          owner: raw.owner,
          nowIso: clock.now().toISOString(),
        });
        if (result.changed) {
          state.outbox.set(messageId, result.message);
        }
        return toOutboxMessage(result.message);
      }),

    scheduleRetry: (raw) =>
      run("outbox.scheduleRetry", null, () => {
        const messageId = parsePersistedId(raw.messageId, "scheduleRetry.messageId");
        const next = applyScheduleRetry(requireMessage(messageId), {
          owner: raw.owner,
          retryAt: raw.retryAt,
          failureCategory: raw.failureCategory ?? null,
        });
        state.outbox.set(messageId, next);
        return toOutboxMessage(next);
      }),

    deadLetter: (raw) =>
      run("outbox.deadLetter", null, () => {
        const messageId = parsePersistedId(raw.messageId, "deadLetter.messageId");
        const next = applyDeadLetter(requireMessage(messageId), {
          owner: raw.owner,
          failureCategory: raw.failureCategory,
          nowIso: clock.now().toISOString(),
        });
        state.outbox.set(messageId, next);
        return toOutboxMessage(next);
      }),

    get: (messageId) =>
      run("outbox.get", null, () => {
        const id = parsePersistedId(messageId, "messageId");
        const stored = state.outbox.get(id);
        return stored === undefined ? null : toOutboxMessage(stored);
      }),

    list: (query) =>
      run("outbox.list", null, () => {
        const status =
          query?.status === undefined
            ? null
            : ensureEnum(query.status, "outbox.list.status", OUTBOX_STATUSES);
        const limit = normalizePageSize(query?.limit);
        const after =
          query?.cursor === undefined || query.cursor === null
            ? null
            : decodeCursor(query.cursor, "sequence").lastSequence;
        const items = sortedBySequence(state.outbox.values())
          .filter(
            (stored) =>
              (status === null || stored.status === status) &&
              (after === null || stored.sequence > after),
          )
          .slice(0, limit + 1)
          .map(toOutboxMessage);
        return buildPage(items, limit, (item) => ({
          kind: "sequence",
          lastSequence: item.sequence,
        }));
      }),
  };

  const requireMessage = (messageId: string): StoredOutbox => {
    const stored = state.outbox.get(messageId);
    if (stored === undefined) {
      throw new PersistenceError("NOT_FOUND", "The outbox message does not exist.", {
        messageId,
      });
    }
    return stored;
  };

  const readArtifact = <T>(
    map: Map<string, StoredArtifact>,
    id: string,
    recordKind: string,
    parse: (payload: unknown) => T,
  ): T | null => {
    const stored = map.get(id);
    if (stored === undefined) {
      return null;
    }
    verifyChecksum(stored.payloadText, stored.checksum, { recordKind, recordId: id });
    return parse(parseJsonText(stored.payloadText, recordKind));
  };

  const artifacts: ArtifactMetadataStore = {
    putDescriptor: (raw) =>
      run("artifacts.putDescriptor", null, () => {
        const descriptor: ArtifactDescriptor = parseArtifactDescriptor(raw);
        if (state.artifacts.has(descriptor.id)) {
          throw new PersistenceError("DUPLICATE_ID", "The artifact id already exists.", {
            artifactId: descriptor.id,
          });
        }
        const prepared = preparePayload(descriptor, "artifactDescriptor");
        state.artifacts.set(descriptor.id, {
          id: descriptor.id,
          payloadText: prepared.text,
          checksum: prepared.checksum,
        });
        return descriptor;
      }),

    getDescriptor: (artifactId) =>
      run("artifacts.getDescriptor", null, () => {
        const id = parsePersistedId(artifactId, "artifactId");
        return readArtifact(state.artifacts, id, "artifact-descriptor", parseArtifactDescriptor);
      }),

    listDescriptors: (query) =>
      run("artifacts.listDescriptors", null, () => {
        const limit = normalizePageSize(query?.limit);
        const after =
          query?.cursor === undefined || query.cursor === null
            ? null
            : decodeCursor(query.cursor, "string-key").lastKey;
        const items = [...state.artifacts.keys()]
          .sort()
          .filter((id) => after === null || id > after)
          .slice(0, limit + 1)
          .map(
            (id) =>
              readArtifact(
                state.artifacts,
                id,
                "artifact-descriptor",
                parseArtifactDescriptor,
              ) as ArtifactDescriptor,
          );
        return buildPage(items, limit, (item) => ({ kind: "string-key", lastKey: item.id }));
      }),

    putManifest: (raw) =>
      run("artifacts.putManifest", null, () => {
        const manifest: ArtifactManifest = parseArtifactManifest(raw);
        if (state.manifests.has(manifest.manifestId)) {
          throw new PersistenceError("DUPLICATE_ID", "The manifest id already exists.", {
            manifestId: manifest.manifestId,
          });
        }
        const prepared = preparePayload(manifest, "artifactManifest");
        state.manifests.set(manifest.manifestId, {
          id: manifest.manifestId,
          payloadText: prepared.text,
          checksum: prepared.checksum,
        });
        return manifest;
      }),

    getManifest: (manifestId) =>
      run("artifacts.getManifest", null, () => {
        const id = parsePersistedId(manifestId, "manifestId");
        return readArtifact(state.manifests, id, "artifact-manifest", parseArtifactManifest);
      }),
  };

  return Object.freeze({ aggregates, events, outbox, artifacts });
}

/**
 * In-memory reference implementation of the persistence contract, plus
 * test-only fault-injection hooks used by the shared contract suite. The
 * hooks corrupt committed stored text without touching checksums so that
 * corruption detection paths can be exercised.
 */
export interface MemoryPersistenceAdapter extends PersistenceAdapter {
  corruptAggregatePayload(aggregateType: string, aggregateId: string): void;
  corruptEventPayload(eventId: string): void;
  corruptOutboxPayload(messageId: string): void;
  corruptArtifactPayload(artifactId: string): void;
}

const EMPTY_MIGRATION_STATUS: MigrationStatus = Object.freeze({
  applied: Object.freeze([]),
  pending: Object.freeze([]),
  databaseSchemaAhead: false,
});

export function createMemoryPersistenceAdapter(
  options: AdapterOptions = {},
): MemoryPersistenceAdapter {
  const clock = options.clock ?? systemClock;
  const observer = options.observer;
  const mutex = new AsyncMutex();
  const guard = new TransactionGuard();
  const closedGate = new SessionGate("ADAPTER_CLOSED", "The persistence adapter is closed.");
  const state: MemoryState = {
    aggregates: new Map(),
    events: new Map(),
    eventSequence: 0,
    outbox: new Map(),
    idempotencyKeys: new Map(),
    outboxSequence: 0,
    artifacts: new Map(),
    manifests: new Map(),
  };

  function corrupt(mutate: () => boolean, kind: string, id: string): void {
    closedGate.assertActive();
    if (!mutate()) {
      throw new PersistenceError("NOT_FOUND", `Cannot corrupt a missing ${kind}.`, {
        recordId: id,
      });
    }
  }

  return {
    async transact<T>(work: (tx: TransactionContext) => Promise<T> | T): Promise<T> {
      guard.assertNotNested();
      return mutex.run(async () => {
        closedGate.assertActive();
        const snapshot = snapshotState(state);
        const txGate = new SessionGate(
          "TRANSACTION_COMPLETED",
          "The transaction has already completed.",
        );
        const context = createContext(state, clock, observer, txGate);
        try {
          const result = await guard.run(async () => await work(context));
          txGate.close();
          return result;
        } catch (error) {
          txGate.close();
          restoreState(state, snapshot);
          throw error;
        }
      });
    },

    async migrationStatus(): Promise<MigrationStatus> {
      closedGate.assertActive();
      return EMPTY_MIGRATION_STATUS;
    },

    async close(): Promise<void> {
      await mutex.run(() => {
        closedGate.close();
      });
    },

    corruptAggregatePayload(aggregateType: string, aggregateId: string): void {
      corrupt(
        () => {
          const map = state.aggregates.get(aggregateType as AggregateType);
          const stored = map?.get(aggregateId);
          if (map === undefined || stored === undefined) {
            return false;
          }
          map.set(aggregateId, { ...stored, payloadText: `${stored.payloadText} ` });
          return true;
        },
        "aggregate",
        aggregateId,
      );
    },

    corruptEventPayload(eventId: string): void {
      corrupt(
        () => {
          const stored = state.events.get(eventId);
          if (stored === undefined) {
            return false;
          }
          state.events.set(eventId, { ...stored, payloadText: `${stored.payloadText} ` });
          return true;
        },
        "event",
        eventId,
      );
    },

    corruptOutboxPayload(messageId: string): void {
      corrupt(
        () => {
          const stored = state.outbox.get(messageId);
          if (stored === undefined) {
            return false;
          }
          state.outbox.set(messageId, { ...stored, payloadText: `${stored.payloadText} ` });
          return true;
        },
        "outbox message",
        messageId,
      );
    },

    corruptArtifactPayload(artifactId: string): void {
      corrupt(
        () => {
          const stored = state.artifacts.get(artifactId);
          if (stored === undefined) {
            return false;
          }
          state.artifacts.set(artifactId, { ...stored, payloadText: `${stored.payloadText} ` });
          return true;
        },
        "artifact",
        artifactId,
      );
    },
  };
}
