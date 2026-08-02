import type { ArtifactDescriptor, ArtifactManifest } from "@ai-dev-os/artifacts";
import type { Page } from "./cursor.js";
import type { MigrationStatus } from "./migration.js";
import type {
  AggregateEnvelope,
  AggregateType,
  AppendEventInput,
  ClaimOutboxInput,
  CreateAggregateInput,
  EnqueueOutboxInput,
  EventRecord,
  OutboxMessage,
  OutboxStatus,
  UpdateAggregateInput,
} from "./records.js";

/** Injectable time source. Adapters must never read the system clock directly. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = Object.freeze({
  now: (): Date => new Date(),
});

export const OPERATION_OUTCOMES = Object.freeze([
  "success",
  "conflict",
  "not-found",
  "duplicate",
  "corruption",
  "validation-failed",
  "error",
] as const);

export type OperationOutcome = (typeof OPERATION_OUTCOMES)[number];

/**
 * Structured operation metadata for metrics. Never contains payloads,
 * identifiers beyond the aggregate type, SQL, or error messages.
 */
export interface OperationRecord {
  readonly operation: string;
  readonly outcome: OperationOutcome;
  readonly aggregateType: AggregateType | null;
  readonly durationMs: number;
}

export type PersistenceObserver = (record: OperationRecord) => void;

export interface AdapterOptions {
  readonly clock?: Clock;
  readonly observer?: PersistenceObserver;
}

/**
 * Versioned aggregate documents. `create` requires the aggregate to be
 * absent and stores aggregateVersion 1. `update` requires the exact current
 * version and stores expectedVersion + 1. Listing is ordered by aggregateId
 * ascending with keyset pagination.
 */
export interface AggregateStore {
  create(input: CreateAggregateInput): Promise<AggregateEnvelope>;
  update(input: UpdateAggregateInput): Promise<AggregateEnvelope>;
  get(aggregateType: AggregateType, aggregateId: string): Promise<AggregateEnvelope | null>;
  list(query: {
    readonly aggregateType: AggregateType;
    readonly limit?: number;
    readonly cursor?: string | null;
  }): Promise<Page<AggregateEnvelope>>;
}

/**
 * Append-only event journal. Events are totally ordered by an
 * adapter-assigned global sequence; per-aggregate order follows from
 * appending events in the same transaction as the aggregate update.
 * Duplicate event ids are rejected. Listing is ordered by globalSequence
 * ascending; a filter may scope to one aggregate.
 */
export interface EventStore {
  append(input: AppendEventInput): Promise<EventRecord>;
  list(query?: {
    readonly aggregateType?: AggregateType;
    readonly aggregateId?: string;
    readonly limit?: number;
    readonly cursor?: string | null;
  }): Promise<Page<EventRecord>>;
}

/**
 * Transactional outbox with leased delivery.
 *
 * State machine:
 *
 * ```text
 * enqueue          -> pending
 * claim            -> leased        (pending & available, or leased with an
 *                                    expired lease; attemptCount increments)
 * acknowledge      -> acknowledged  (leased, same owner; terminal;
 *                                    re-acknowledging is an idempotent no-op)
 * scheduleRetry    -> pending       (leased, same owner; availableAt moves)
 * deadLetter       -> dead-lettered (leased, same owner; terminal)
 * ```
 *
 * Any other transition, or a transition by a non-owner, fails with
 * OUTBOX_STATE_CONFLICT. Claims are ordered by enqueue sequence.
 */
export interface OutboxStore {
  enqueue(input: EnqueueOutboxInput): Promise<OutboxMessage>;
  claim(input: ClaimOutboxInput): Promise<readonly OutboxMessage[]>;
  acknowledge(input: { readonly messageId: string; readonly owner: string }): Promise<OutboxMessage>;
  scheduleRetry(input: {
    readonly messageId: string;
    readonly owner: string;
    readonly retryAt: string;
    readonly failureCategory?: string | null;
  }): Promise<OutboxMessage>;
  deadLetter(input: {
    readonly messageId: string;
    readonly owner: string;
    readonly failureCategory: string;
  }): Promise<OutboxMessage>;
  get(messageId: string): Promise<OutboxMessage | null>;
  list(query?: {
    readonly status?: OutboxStatus;
    readonly limit?: number;
    readonly cursor?: string | null;
  }): Promise<Page<OutboxMessage>>;
}

/**
 * Immutable artifact metadata. Descriptors and manifests are validated with
 * the @ai-dev-os/artifacts contracts on write and on read; they are
 * create-only (a duplicate id is a structured error) and never updated.
 * Listing is ordered by id ascending.
 */
export interface ArtifactMetadataStore {
  putDescriptor(descriptor: unknown): Promise<ArtifactDescriptor>;
  getDescriptor(artifactId: string): Promise<ArtifactDescriptor | null>;
  listDescriptors(query?: {
    readonly limit?: number;
    readonly cursor?: string | null;
  }): Promise<Page<ArtifactDescriptor>>;
  putManifest(manifest: unknown): Promise<ArtifactManifest>;
  getManifest(manifestId: string): Promise<ArtifactManifest | null>;
}

/**
 * All stores reached through one context share a single atomic boundary:
 * either every write in the callback commits, or none do.
 */
export interface TransactionContext {
  readonly aggregates: AggregateStore;
  readonly events: EventStore;
  readonly outbox: OutboxStore;
  readonly artifacts: ArtifactMetadataStore;
}

export interface PersistenceAdapter {
  /**
   * Runs `work` inside one transaction. Resolution commits; rejection rolls
   * back completely. Transactions are serialized per adapter; calling
   * transact from inside an active transaction throws NESTED_TRANSACTION.
   * Using the context after the callback settles throws
   * TRANSACTION_COMPLETED.
   */
  transact<T>(work: (tx: TransactionContext) => Promise<T> | T): Promise<T>;
  migrationStatus(): Promise<MigrationStatus>;
  /**
   * Waits for in-flight work, then releases resources. Idempotent. All
   * later operations fail with ADAPTER_CLOSED.
   */
  close(): Promise<void>;
}
