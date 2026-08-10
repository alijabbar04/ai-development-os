import { createHash } from "node:crypto";
import { validation, type JsonObject } from "@ai-dev-os/domain";
import type { AggregateEnvelope, PersistenceAdapter, TransactionContext } from "@ai-dev-os/persistence";
import { SchedulerError } from "./errors.js";
import { createOrchestrationEvent } from "./events.js";
import { parseOrchestrationEvent, parseOrchestrationTaskEnvelope, taskFingerprint } from "./schema.js";
import { applyOrchestrationEvent, replayOrchestrationEvents, stateEquals } from "./state-machine.js";
import type { OrchestrationEvent, OrchestrationEventType, OrchestrationRunState, OrchestrationTaskEnvelope } from "./types.js";

const { ensureExactKeys, ensureRecord } = validation;
const AGGREGATE_TYPE = "task-run" as const;
const EVENT_SCHEMA_VERSION = 1;

function stableTextCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type StoreFaultPoint = "after-aggregate-before-event";

export interface OrchestrationStoreOptions {
  readonly adapter: PersistenceAdapter;
  readonly fault?: (point: StoreFaultPoint) => Promise<void> | void;
}

export interface SubmitResult {
  readonly outcome: "created" | "duplicate";
  readonly state: OrchestrationRunState;
}

function aggregateIdFor(idempotencyKey: string): string {
  return `orchestration:${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 40)}`;
}

async function listEvents(tx: TransactionContext, aggregateId: string): Promise<readonly OrchestrationEvent[]> {
  const events: OrchestrationEvent[] = [];
  let cursor: string | null = null;
  do {
    const page = await tx.events.list({ aggregateType: AGGREGATE_TYPE, aggregateId, limit: 100, cursor });
    for (const record of page.items) {
      const payload = ensureRecord(record.payload, "persistedEvent.payload");
      ensureExactKeys(payload, ["event"], "persistedEvent.payload");
      const event = parseOrchestrationEvent(payload["event"], "persistedEvent.payload.event");
      if (record.eventId !== event.eventId || record.eventType !== event.type || record.aggregateVersion !== event.sequence) {
        throw new SchedulerError("STATE_CORRUPTION", "Persisted event metadata is inconsistent.");
      }
      events.push(event);
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return Object.freeze(events);
}

async function loadState(
  tx: TransactionContext,
  aggregateId: string,
  envelope?: AggregateEnvelope | null,
): Promise<OrchestrationRunState | null> {
  const current = envelope === undefined ? await tx.aggregates.get(AGGREGATE_TYPE, aggregateId) : envelope;
  if (current === null) return null;
  const events = await listEvents(tx, aggregateId);
  const state = replayOrchestrationEvents(events);
  if (state.sequence !== current.aggregateVersion || !stateEquals(state, current.payload)) {
    throw new SchedulerError("STATE_CORRUPTION", "The task-run checkpoint does not match its append-only journal.");
  }
  return state;
}

export interface OrchestrationStore {
  submit(task: unknown, occurredAt: string): Promise<SubmitResult>;
  get(idempotencyKey: string): Promise<OrchestrationRunState | null>;
  list(): Promise<readonly OrchestrationRunState[]>;
  history(idempotencyKey: string): Promise<readonly OrchestrationEvent[]>;
  append(
    idempotencyKey: string,
    type: OrchestrationEventType,
    payload: unknown,
    occurredAt: string,
  ): Promise<OrchestrationRunState>;
  close(): Promise<void>;
}

export function createOrchestrationStore(options: OrchestrationStoreOptions): OrchestrationStore {
  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw new SchedulerError("STATE_CORRUPTION", "The orchestration store is closed.");
  };
  return Object.freeze({
    async submit(rawTask: unknown, occurredAt: string): Promise<SubmitResult> {
      assertOpen();
      const task: OrchestrationTaskEnvelope = parseOrchestrationTaskEnvelope(rawTask);
      const fingerprint = taskFingerprint(task);
      const aggregateId = aggregateIdFor(task.idempotencyKey);
      return options.adapter.transact(async (tx) => {
        const existing = await tx.aggregates.get(AGGREGATE_TYPE, aggregateId);
        if (existing !== null) {
          const state = await loadState(tx, aggregateId, existing);
          if (state === null) throw new SchedulerError("STATE_CORRUPTION", "An existing task-run could not be loaded.");
          if (state.taskFingerprint !== fingerprint) {
            throw new SchedulerError("IDEMPOTENCY_CONFLICT", "An idempotency key was reused with a different task payload.");
          }
          return Object.freeze({ outcome: "duplicate" as const, state });
        }
        const event = createOrchestrationEvent({ taskId: task.taskId, sequence: 1, occurredAt, type: "queued", payload: { task, taskFingerprint: fingerprint } });
        const state = replayOrchestrationEvents([event]);
        await tx.aggregates.create({ aggregateType: AGGREGATE_TYPE, aggregateId, schemaVersion: 1, payload: state, traceId: task.correlationId });
        await options.fault?.("after-aggregate-before-event");
        await tx.events.append({
          eventId: event.eventId,
          aggregateType: AGGREGATE_TYPE,
          aggregateId,
          aggregateVersion: 1,
          eventType: event.type,
          eventSchemaVersion: EVENT_SCHEMA_VERSION,
          payload: { event },
          occurredAt,
          traceId: task.correlationId,
          causationId: null,
        });
        return Object.freeze({ outcome: "created" as const, state });
      });
    },

    async get(idempotencyKey: string): Promise<OrchestrationRunState | null> {
      assertOpen();
      return options.adapter.transact((tx) => loadState(tx, aggregateIdFor(idempotencyKey)));
    },

    async list(): Promise<readonly OrchestrationRunState[]> {
      assertOpen();
      return options.adapter.transact(async (tx) => {
        const states: OrchestrationRunState[] = [];
        let cursor: string | null = null;
        do {
          const page = await tx.aggregates.list({ aggregateType: AGGREGATE_TYPE, limit: 100, cursor });
          for (const envelope of page.items) {
            if (!envelope.aggregateId.startsWith("orchestration:")) continue;
            const state = await loadState(tx, envelope.aggregateId, envelope);
            if (state !== null) states.push(state);
          }
          cursor = page.nextCursor;
        } while (cursor !== null);
        return Object.freeze(states.sort((left, right) =>
          stableTextCompare(left.task.createdAt, right.task.createdAt) ||
          stableTextCompare(left.task.taskId, right.task.taskId)));
      });
    },

    async history(idempotencyKey: string): Promise<readonly OrchestrationEvent[]> {
      assertOpen();
      return options.adapter.transact((tx) => listEvents(tx, aggregateIdFor(idempotencyKey)));
    },

    async append(idempotencyKey: string, type: OrchestrationEventType, payload: unknown, occurredAt: string): Promise<OrchestrationRunState> {
      assertOpen();
      const aggregateId = aggregateIdFor(idempotencyKey);
      return options.adapter.transact(async (tx) => {
        const envelope = await tx.aggregates.get(AGGREGATE_TYPE, aggregateId);
        if (envelope === null) throw new SchedulerError("NOT_FOUND", "The task-run does not exist.");
        const state = await loadState(tx, aggregateId, envelope);
        if (state === null) throw new SchedulerError("STATE_CORRUPTION", "The task-run state is unavailable.");
        const event = createOrchestrationEvent({ taskId: state.task.taskId, sequence: state.sequence + 1, occurredAt, type, payload });
        const next = applyOrchestrationEvent(state, event);
        const aggregateVersion = envelope.aggregateVersion + 1;
        await tx.aggregates.update({
          aggregateType: AGGREGATE_TYPE,
          aggregateId,
          schemaVersion: 1,
          payload: next as unknown as JsonObject,
          expectedVersion: envelope.aggregateVersion,
          traceId: state.task.correlationId,
        });
        await options.fault?.("after-aggregate-before-event");
        await tx.events.append({
          eventId: event.eventId,
          aggregateType: AGGREGATE_TYPE,
          aggregateId,
          aggregateVersion,
          eventType: event.type,
          eventSchemaVersion: EVENT_SCHEMA_VERSION,
          payload: { event },
          occurredAt,
          traceId: state.task.correlationId,
          causationId: state.lastEventId,
        });
        return next;
      });
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await options.adapter.close();
    },
  });
}
