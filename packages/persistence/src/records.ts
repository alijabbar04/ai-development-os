import { validation, type JsonValue } from "@ai-dev-os/domain";
import {
  canonicalizeWithChecksum,
  type Checksum,
} from "./checksum.js";

const { ensureNullable, ensureSafeInteger, ensureString, ensureTimestamp, fail } =
  validation;

/**
 * Aggregate types persisted in Stage 3. This union is deliberately closed:
 * later stages extend it when their aggregates exist, so the storage layer
 * never accepts unknown aggregate kinds.
 */
export const AGGREGATE_TYPES = Object.freeze([
  "artifact-manifest",
  "budget-account",
  "project",
  "task-graph",
  "task-run",
  "telemetry-ledger",
] as const);

export type AggregateType = (typeof AGGREGATE_TYPES)[number];

export const MAX_AGGREGATE_VERSION = Number.MAX_SAFE_INTEGER;
export const MAX_SCHEMA_VERSION = 1_000_000;
/** Serialized canonical payloads above this size are rejected on write. */
export const MAX_PAYLOAD_TEXT_LENGTH = 10_000_000;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KIND_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

export function parsePersistedId(value: unknown, path: string): string {
  return ensureString(value, path, {
    maxLength: 128,
    pattern: ID_PATTERN,
    patternName: "identifier",
  });
}

function parseKind(value: unknown, path: string): string {
  return ensureString(value, path, {
    maxLength: 64,
    pattern: KIND_PATTERN,
    patternName: "kind",
  });
}

export function parseAggregateType(value: unknown, path = "aggregateType"): AggregateType {
  return validation.ensureEnum(value, path, AGGREGATE_TYPES);
}

function parseSchemaVersion(value: unknown, path: string): number {
  return ensureSafeInteger(value, path, 1, MAX_SCHEMA_VERSION);
}

function parseOptionalId(value: unknown, path: string): string | null {
  return ensureNullable(value, (id) => parsePersistedId(id, path));
}

/**
 * Canonicalizes an untrusted payload and computes its checksum. The
 * returned text is what adapters persist; the returned value is the frozen
 * canonical form handed back to callers. Oversized payloads are rejected.
 */
export function preparePayload(
  payload: unknown,
  path: string,
): { readonly text: string; readonly checksum: Checksum } {
  const prepared = canonicalizeWithChecksum(payload, path);
  if (prepared.text.length > MAX_PAYLOAD_TEXT_LENGTH) {
    fail(path, "payload_too_large", `serialized payload cannot exceed ${MAX_PAYLOAD_TEXT_LENGTH} characters.`);
  }
  return prepared;
}

// ---------------------------------------------------------------------------
// Aggregate envelopes
// ---------------------------------------------------------------------------

export interface AggregateEnvelope {
  readonly aggregateType: AggregateType;
  readonly aggregateId: string;
  /** Version of the payload's own schema, declared by the caller. */
  readonly schemaVersion: number;
  /**
   * Optimistic-concurrency version. Creation stores version 1; every
   * successful update increments it by exactly 1.
   */
  readonly aggregateVersion: number;
  readonly payload: JsonValue;
  readonly checksum: Checksum;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly traceId: string | null;
}

export interface CreateAggregateInput {
  readonly aggregateType: AggregateType;
  readonly aggregateId: string;
  readonly schemaVersion: number;
  readonly payload: unknown;
  readonly traceId?: string | null;
}

export interface UpdateAggregateInput extends CreateAggregateInput {
  /** Must equal the currently stored aggregateVersion. */
  readonly expectedVersion: number;
}

export interface ValidatedAggregateWrite {
  readonly aggregateType: AggregateType;
  readonly aggregateId: string;
  readonly schemaVersion: number;
  readonly payloadText: string;
  readonly checksum: Checksum;
  readonly traceId: string | null;
}

export function validateCreateAggregateInput(
  input: CreateAggregateInput,
  path = "createAggregate",
): ValidatedAggregateWrite {
  const prepared = preparePayload(input.payload, `${path}.payload`);
  return Object.freeze({
    aggregateType: parseAggregateType(input.aggregateType, `${path}.aggregateType`),
    aggregateId: parsePersistedId(input.aggregateId, `${path}.aggregateId`),
    schemaVersion: parseSchemaVersion(input.schemaVersion, `${path}.schemaVersion`),
    payloadText: prepared.text,
    checksum: prepared.checksum,
    traceId: parseOptionalId(input.traceId, `${path}.traceId`),
  });
}

export function validateUpdateAggregateInput(
  input: UpdateAggregateInput,
  path = "updateAggregate",
): ValidatedAggregateWrite & { readonly expectedVersion: number } {
  const base = validateCreateAggregateInput(input, path);
  return Object.freeze({
    ...base,
    expectedVersion: ensureSafeInteger(
      input.expectedVersion,
      `${path}.expectedVersion`,
      1,
      MAX_AGGREGATE_VERSION,
    ),
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface EventRecord {
  readonly eventId: string;
  readonly aggregateType: AggregateType;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly eventType: string;
  readonly eventSchemaVersion: number;
  readonly payload: JsonValue;
  readonly checksum: Checksum;
  /** When the fact happened, supplied by the caller. */
  readonly occurredAt: string;
  /** When the store persisted it, stamped by the adapter clock. */
  readonly recordedAt: string;
  /** Adapter-assigned strictly increasing global sequence (starts at 1). */
  readonly globalSequence: number;
  readonly traceId: string | null;
  readonly causationId: string | null;
}

export interface AppendEventInput {
  readonly eventId: string;
  readonly aggregateType: AggregateType;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly eventType: string;
  readonly eventSchemaVersion: number;
  readonly payload: unknown;
  readonly occurredAt: string;
  readonly traceId?: string | null;
  readonly causationId?: string | null;
}

export interface ValidatedEventAppend {
  readonly eventId: string;
  readonly aggregateType: AggregateType;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly eventType: string;
  readonly eventSchemaVersion: number;
  readonly payloadText: string;
  readonly checksum: Checksum;
  readonly occurredAt: string;
  readonly traceId: string | null;
  readonly causationId: string | null;
}

export function validateAppendEventInput(
  input: AppendEventInput,
  path = "appendEvent",
): ValidatedEventAppend {
  const prepared = preparePayload(input.payload, `${path}.payload`);
  return Object.freeze({
    eventId: parsePersistedId(input.eventId, `${path}.eventId`),
    aggregateType: parseAggregateType(input.aggregateType, `${path}.aggregateType`),
    aggregateId: parsePersistedId(input.aggregateId, `${path}.aggregateId`),
    aggregateVersion: ensureSafeInteger(
      input.aggregateVersion,
      `${path}.aggregateVersion`,
      1,
      MAX_AGGREGATE_VERSION,
    ),
    eventType: parseKind(input.eventType, `${path}.eventType`),
    eventSchemaVersion: parseSchemaVersion(
      input.eventSchemaVersion,
      `${path}.eventSchemaVersion`,
    ),
    payloadText: prepared.text,
    checksum: prepared.checksum,
    occurredAt: ensureTimestamp(input.occurredAt, `${path}.occurredAt`),
    traceId: parseOptionalId(input.traceId, `${path}.traceId`),
    causationId: parseOptionalId(input.causationId, `${path}.causationId`),
  });
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

export const OUTBOX_STATUSES = Object.freeze([
  "pending",
  "leased",
  "acknowledged",
  "dead-lettered",
] as const);

export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export interface OutboxMessage {
  readonly messageId: string;
  readonly topic: string;
  readonly schemaVersion: number;
  readonly payload: JsonValue;
  readonly checksum: Checksum;
  readonly idempotencyKey: string;
  readonly status: OutboxStatus;
  /** Number of times the message has been claimed for delivery. */
  readonly attemptCount: number;
  readonly createdAt: string;
  /** The message is claimable once the adapter clock reaches this time. */
  readonly availableAt: string;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly deadLetteredAt: string | null;
  /** Short caller-supplied failure code; never an error message or payload. */
  readonly lastFailureCategory: string | null;
  /** Adapter-assigned strictly increasing enqueue sequence (starts at 1). */
  readonly sequence: number;
  readonly traceId: string | null;
}

export interface EnqueueOutboxInput {
  readonly messageId: string;
  readonly topic: string;
  readonly schemaVersion: number;
  readonly payload: unknown;
  readonly idempotencyKey: string;
  /** Defaults to the adapter clock's current time. */
  readonly availableAt?: string | null;
  readonly traceId?: string | null;
}

export interface ValidatedOutboxEnqueue {
  readonly messageId: string;
  readonly topic: string;
  readonly schemaVersion: number;
  readonly payloadText: string;
  readonly checksum: Checksum;
  readonly idempotencyKey: string;
  readonly availableAt: string | null;
  readonly traceId: string | null;
}

export function validateEnqueueOutboxInput(
  input: EnqueueOutboxInput,
  path = "enqueueOutbox",
): ValidatedOutboxEnqueue {
  const prepared = preparePayload(input.payload, `${path}.payload`);
  return Object.freeze({
    messageId: parsePersistedId(input.messageId, `${path}.messageId`),
    topic: parseKind(input.topic, `${path}.topic`),
    schemaVersion: parseSchemaVersion(input.schemaVersion, `${path}.schemaVersion`),
    payloadText: prepared.text,
    checksum: prepared.checksum,
    idempotencyKey: ensureString(input.idempotencyKey, `${path}.idempotencyKey`, {
      maxLength: 256,
      pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/,
      patternName: "idempotency key",
    }),
    availableAt: ensureNullable(input.availableAt, (at) =>
      ensureTimestamp(at, `${path}.availableAt`),
    ),
    traceId: parseOptionalId(input.traceId, `${path}.traceId`),
  });
}

export interface ClaimOutboxInput {
  readonly owner: string;
  readonly leaseDurationMs: number;
  readonly limit?: number;
}

export interface ValidatedOutboxClaim {
  readonly owner: string;
  readonly leaseDurationMs: number;
  readonly limit: number;
}

export const MAX_LEASE_DURATION_MS = 86_400_000;
export const MAX_CLAIM_LIMIT = 100;

export function validateClaimOutboxInput(
  input: ClaimOutboxInput,
  path = "claimOutbox",
): ValidatedOutboxClaim {
  return Object.freeze({
    owner: parsePersistedId(input.owner, `${path}.owner`),
    leaseDurationMs: ensureSafeInteger(
      input.leaseDurationMs,
      `${path}.leaseDurationMs`,
      1,
      MAX_LEASE_DURATION_MS,
    ),
    limit:
      input.limit === undefined || input.limit === null
        ? 1
        : ensureSafeInteger(input.limit, `${path}.limit`, 1, MAX_CLAIM_LIMIT),
  });
}

export function parseFailureCategory(value: unknown, path: string): string {
  return parseKind(value, path);
}
