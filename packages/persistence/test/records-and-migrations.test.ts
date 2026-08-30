import { describe, expect, it } from "vitest";
import { ValidationError } from "@ai-dev-os/domain";
import {
  AGGREGATE_TYPES,
  MAX_PAYLOAD_TEXT_LENGTH,
  PersistenceError,
  applyAcknowledge,
  applyClaim,
  applyDeadLetter,
  applyScheduleRetry,
  isClaimable,
  isPersistenceError,
  leaseExpiry,
  migrationChecksum,
  parseAggregateType,
  parseAppliedMigration,
  parseMigrationId,
  parsePersistedId,
  planMigrations,
  preparePayload,
  validateAppendEventInput,
  validateClaimOutboxInput,
  validateCreateAggregateInput,
  validateEnqueueOutboxInput,
  validateUpdateAggregateInput,
  type AggregateType,
  type AppliedMigration,
  type MigrationDefinition,
  type OutboxMessage,
} from "../src/index.js";

const ORIGINAL_AGGREGATE_TYPES = Object.freeze([
  "artifact-manifest",
  "budget-account",
  "evaluation-run",
  "integration-run",
  "project",
  "product-plan",
  "task-graph",
  "task-run",
  "telemetry-ledger",
  "worker-run",
] as const);

const C7_PROJECT_AGGREGATE_TYPES = Object.freeze([
  "project-brief",
  "project-plan",
  "agent-session",
  "handover",
  "approval-request",
  "spending-request",
  "notification",
  "communication-thread",
  "external-integration",
  "project-stop",
] as const);

const EXPECTED_AGGREGATE_TYPES = Object.freeze([
  ...ORIGINAL_AGGREGATE_TYPES,
  ...C7_PROJECT_AGGREGATE_TYPES,
] as const);

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Condition extends true> = Condition;
type _AggregateTypeRuntimeParity = Assert<
  Equal<AggregateType, (typeof EXPECTED_AGGREGATE_TYPES)[number]>
>;

const T0 = "2026-08-02T12:00:00.000Z";

describe("record validation", () => {
  it("keeps the exact independently enumerated 20-member aggregate vocabulary", () => {
    expect(ORIGINAL_AGGREGATE_TYPES).toHaveLength(10);
    expect(C7_PROJECT_AGGREGATE_TYPES).toHaveLength(10);
    expect(AGGREGATE_TYPES).toEqual(EXPECTED_AGGREGATE_TYPES);
    expect(new Set(AGGREGATE_TYPES).size).toBe(20);
    for (const aggregateType of EXPECTED_AGGREGATE_TYPES) {
      expect(parseAggregateType(aggregateType)).toBe(aggregateType);
    }
  });

  it("refuses aggregate vocabulary drift and keeps embedded or derived project records out", () => {
    const refused = [
      "unknown",
      "Project-brief",
      "project-brief ",
      "pr\u043eject-brief",
      "plan-stage",
      "task",
      "dependency",
      "decision",
      "usage-reservation",
      "evidence-record",
      "deliverable",
      "blocker",
      "constraint",
      "project-health",
      "project-summary",
    ] as const;
    for (const aggregateType of refused) {
      expect(() => parseAggregateType(aggregateType), aggregateType).toThrow(ValidationError);
    }
  });

  it("validates and canonicalizes aggregate writes", () => {
    const validated = validateCreateAggregateInput({
      aggregateType: "project",
      aggregateId: "proj-1",
      schemaVersion: 3,
      payload: { b: 1, a: 2 },
    });
    expect(validated.payloadText).toBe('{"a":2,"b":1}');
    expect(validated.traceId).toBeNull();
    expect(validated.checksum.hex).toHaveLength(64);

    const update = validateUpdateAggregateInput({
      aggregateType: "task-run",
      aggregateId: "run-1",
      schemaVersion: 1,
      payload: [],
      expectedVersion: 7,
      traceId: "trace-1",
    });
    expect(update.expectedVersion).toBe(7);
    expect(update.traceId).toBe("trace-1");
  });

  it("rejects hostile aggregate inputs", () => {
    const base = {
      aggregateType: "project" as const,
      aggregateId: "proj-1",
      schemaVersion: 1,
      payload: {},
    };
    expect(() =>
      validateCreateAggregateInput({ ...base, aggregateType: "user-table" as never }),
    ).toThrow(ValidationError);
    expect(() =>
      validateCreateAggregateInput({ ...base, aggregateId: "id with spaces" }),
    ).toThrow(ValidationError);
    expect(() => validateCreateAggregateInput({ ...base, schemaVersion: 0 })).toThrow(
      ValidationError,
    );
    expect(() =>
      validateUpdateAggregateInput({ ...base, expectedVersion: 0 }),
    ).toThrow(ValidationError);
    expect(() =>
      validateUpdateAggregateInput({ ...base, expectedVersion: 1.5 }),
    ).toThrow(ValidationError);
    expect(() =>
      validateCreateAggregateInput({ ...base, payload: { fn: () => 1 } }),
    ).toThrow();
  });

  it("rejects oversized payloads", () => {
    expect(() => preparePayload("x".repeat(MAX_PAYLOAD_TEXT_LENGTH), "payload")).toThrow();
  });

  it("validates event and outbox inputs", () => {
    const event = validateAppendEventInput({
      eventId: "evt-1",
      aggregateType: "task-graph",
      aggregateId: "graph-1",
      aggregateVersion: 2,
      eventType: "task.added",
      eventSchemaVersion: 1,
      payload: { taskId: "t-1" },
      occurredAt: T0,
    });
    expect(event.causationId).toBeNull();

    expect(() =>
      validateAppendEventInput({
        eventId: "evt-1",
        aggregateType: "task-graph",
        aggregateId: "graph-1",
        aggregateVersion: 0,
        eventType: "task.added",
        eventSchemaVersion: 1,
        payload: {},
        occurredAt: T0,
      }),
    ).toThrow(ValidationError);

    const enqueue = validateEnqueueOutboxInput({
      messageId: "msg-1",
      topic: "events.publish",
      schemaVersion: 1,
      payload: {},
      idempotencyKey: "run-1:msg-1",
    });
    expect(enqueue.availableAt).toBeNull();

    expect(() =>
      validateEnqueueOutboxInput({
        messageId: "msg-1",
        topic: "Events.Publish",
        schemaVersion: 1,
        payload: {},
        idempotencyKey: "k",
      }),
    ).toThrow(ValidationError);

    const claim = validateClaimOutboxInput({ owner: "worker-1", leaseDurationMs: 500 });
    expect(claim.limit).toBe(1);
    expect(() =>
      validateClaimOutboxInput({ owner: "worker-1", leaseDurationMs: 0 }),
    ).toThrow(ValidationError);
    expect(() =>
      validateClaimOutboxInput({ owner: "worker-1", leaseDurationMs: 500, limit: 101 }),
    ).toThrow(ValidationError);
  });

  it("exposes id and aggregate-type parsers", () => {
    expect(parsePersistedId("ok-id", "id")).toBe("ok-id");
    expect(() => parsePersistedId("", "id")).toThrow(ValidationError);
    expect(parseAggregateType("budget-account")).toBe("budget-account");
    expect(parseAggregateType("telemetry-ledger")).toBe("telemetry-ledger");
    expect(parseAggregateType("worker-run")).toBe("worker-run");
    expect(parseAggregateType("evaluation-run")).toBe("evaluation-run");
    expect(parseAggregateType("integration-run")).toBe("integration-run");
    expect(() => parseAggregateType("wallet")).toThrow(ValidationError);
  });
});

describe("outbox transition logic", () => {
  const message: OutboxMessage = Object.freeze({
    messageId: "msg-1",
    topic: "events.publish",
    schemaVersion: 1,
    payload: {},
    checksum: { algorithm: "sha-256", hex: "0".repeat(64) },
    idempotencyKey: "key-1",
    status: "pending",
    attemptCount: 0,
    createdAt: T0,
    availableAt: T0,
    leaseOwner: null,
    leaseExpiresAt: null,
    acknowledgedAt: null,
    deadLetteredAt: null,
    lastFailureCategory: null,
    sequence: 1,
    traceId: null,
  });

  it("computes claimability from status, availability, and lease expiry", () => {
    expect(isClaimable(message, T0)).toBe(true);
    expect(isClaimable({ ...message, availableAt: "2026-08-02T12:00:00.001Z" }, T0)).toBe(false);
    const leased = applyClaim(message, {
      owner: "worker-a",
      leaseExpiresAt: "2026-08-02T12:01:00.000Z",
    });
    expect(isClaimable(leased, T0)).toBe(false);
    expect(isClaimable(leased, "2026-08-02T12:01:00.000Z")).toBe(true);
    expect(isClaimable({ ...message, status: "acknowledged" }, T0)).toBe(false);
    expect(isClaimable({ ...message, status: "dead-lettered" }, T0)).toBe(false);
  });

  it("acknowledges only for the lease owner and is idempotent afterwards", () => {
    const leased = applyClaim(message, { owner: "worker-a", leaseExpiresAt: T0 });
    expect(leased.attemptCount).toBe(1);
    const acknowledged = applyAcknowledge(leased, { owner: "worker-a", nowIso: T0 });
    expect(acknowledged.changed).toBe(true);
    expect(acknowledged.message.status).toBe("acknowledged");
    const again = applyAcknowledge(acknowledged.message, { owner: "anyone", nowIso: T0 });
    expect(again.changed).toBe(false);
    expect(again.message).toBe(acknowledged.message);
    expect(() => applyAcknowledge(leased, { owner: "worker-b", nowIso: T0 })).toThrow(
      PersistenceError,
    );
    expect(() => applyAcknowledge(message, { owner: "worker-a", nowIso: T0 })).toThrow(
      PersistenceError,
    );
  });

  it("schedules retries and dead-letters with owner checks", () => {
    const leased = applyClaim(message, { owner: "worker-a", leaseExpiresAt: T0 });
    const retried = applyScheduleRetry(leased, {
      owner: "worker-a",
      retryAt: "2026-08-02T12:05:00.000Z",
      failureCategory: "provider-timeout",
    });
    expect(retried.status).toBe("pending");
    expect(retried.lastFailureCategory).toBe("provider-timeout");
    const retriedKeepingCategory = applyScheduleRetry(
      applyClaim(retried, { owner: "worker-a", leaseExpiresAt: T0 }),
      { owner: "worker-a", retryAt: T0 },
    );
    expect(retriedKeepingCategory.lastFailureCategory).toBe("provider-timeout");
    expect(() =>
      applyScheduleRetry(leased, { owner: "worker-b", retryAt: T0 }),
    ).toThrow(PersistenceError);

    const dead = applyDeadLetter(leased, {
      owner: "worker-a",
      failureCategory: "poison",
      nowIso: T0,
    });
    expect(dead.status).toBe("dead-lettered");
    expect(() =>
      applyDeadLetter(dead, { owner: "worker-a", failureCategory: "poison", nowIso: T0 }),
    ).toThrow(PersistenceError);
    expect(() =>
      applyDeadLetter(leased, { owner: "worker-a", failureCategory: "Bad Category!", nowIso: T0 }),
    ).toThrow(ValidationError);
  });

  it("computes lease expiry and rejects overflow", () => {
    expect(leaseExpiry(new Date(T0), 60_000)).toBe("2026-08-02T12:01:00.000Z");
    expect(() => leaseExpiry(new Date(8.64e15), 86_400_000)).toThrow(PersistenceError);
  });
});

describe("migration planning", () => {
  const migrations: readonly MigrationDefinition[] = Object.freeze([
    { id: "0001-initial-schema", content: "CREATE TABLE a(x);" },
    { id: "0002-add-index", content: "CREATE INDEX i ON a(x);" },
  ]);

  const appliedOf = (
    definition: MigrationDefinition,
    ordinal: number,
  ): AppliedMigration => ({
    id: definition.id,
    checksum: migrationChecksum(definition),
    appliedAt: T0,
    ordinal,
  });

  it("plans pending migrations for an empty database", () => {
    const plan = planMigrations(migrations, []);
    expect(plan.toApply.map((migration) => migration.id)).toEqual([
      "0001-initial-schema",
      "0002-add-index",
    ]);
    expect(plan.status.pending).toEqual(["0001-initial-schema", "0002-add-index"]);
    expect(plan.status.databaseSchemaAhead).toBe(false);
  });

  it("plans nothing for an up-to-date database", () => {
    const plan = planMigrations(migrations, [
      appliedOf(migrations[0]!, 1),
      appliedOf(migrations[1]!, 2),
    ]);
    expect(plan.toApply).toHaveLength(0);
    expect(plan.status.applied).toHaveLength(2);
  });

  it("rejects changed checksums for applied migrations", () => {
    const tampered = { ...appliedOf(migrations[0]!, 1), checksum: migrationChecksum(migrations[1]!) };
    try {
      planMigrations(migrations, [tampered]);
      expect.unreachable();
    } catch (error) {
      expect(isPersistenceError(error, "MIGRATION_CHECKSUM_MISMATCH")).toBe(true);
    }
  });

  it("rejects a database newer than the application", () => {
    const future: AppliedMigration = {
      id: "0009-from-the-future",
      checksum: migrationChecksum({ id: "0009-from-the-future", content: "SELECT 1;" }),
      appliedAt: T0,
      ordinal: 3,
    };
    try {
      planMigrations(migrations, [appliedOf(migrations[0]!, 1), future]);
      expect.unreachable();
    } catch (error) {
      expect(isPersistenceError(error, "SCHEMA_TOO_NEW")).toBe(true);
    }
  });

  it("rejects duplicate, unordered, and out-of-order histories", () => {
    expect(() =>
      planMigrations([migrations[0]!, migrations[0]!], []),
    ).toThrow(PersistenceError);
    expect(() => planMigrations([migrations[1]!, migrations[0]!], [])).toThrow(
      PersistenceError,
    );
    expect(() =>
      planMigrations(migrations, [appliedOf(migrations[1]!, 1)]),
    ).toThrow(PersistenceError);
    expect(() =>
      planMigrations(migrations, [appliedOf(migrations[0]!, 2)]),
    ).toThrow(PersistenceError);
    expect(() => planMigrations([{ id: "bad id", content: "x" }], [])).toThrow(
      ValidationError,
    );
  });

  it("parses applied-migration records defensively", () => {
    const applied = parseAppliedMigration({
      id: "0001-initial-schema",
      checksum: migrationChecksum(migrations[0]!),
      appliedAt: T0,
      ordinal: 1,
    });
    expect(applied.ordinal).toBe(1);
    expect(() => parseAppliedMigration({ id: "0001-initial-schema" })).toThrow(
      ValidationError,
    );
    expect(parseMigrationId("0001-initial-schema")).toBe("0001-initial-schema");
    expect(() => parseMigrationId("1-x")).toThrow(ValidationError);
  });
});
