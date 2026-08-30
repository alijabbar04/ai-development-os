import { describe, expect, it } from "vitest";
import { PersistenceError, computeChecksumOfText, preparePayload } from "@ai-dev-os/persistence";
import {
  createPostgresPersistenceAdapterForTesting,
  postgresAdapterTesting,
} from "../src/testing.js";
import { POSTGRES_MIGRATIONS, type PostgresAdapterOptions } from "../src/index.js";
import { createFakePoolFactory, FakePostgresDatabase } from "./fake-pool.js";

function options(overrides: Partial<PostgresAdapterOptions> = {}): PostgresAdapterOptions {
  return {
    connection: {
      host: "127.0.0.1",
      port: 5432,
      database: "testdb",
      user: "testuser",
      password: "canary-password",
      ssl: false,
    },
    schema: "adapter_test",
    ...overrides,
  };
}

async function open(database = new FakePostgresDatabase(), raw = options()) {
  const adapter = await createPostgresPersistenceAdapterForTesting(raw, {
    poolFactory: createFakePoolFactory(database),
  });
  return { adapter, database };
}

describe("PostgreSQL adapter configuration and finite failures", () => {
  it("normalizes every explicit connection, TLS, pool, and timeout option", async () => {
    const database = new FakePostgresDatabase();
    const { adapter } = await open(database, options({
      connection: {
        host: "db.internal",
        port: 6543,
        database: "team-db",
        user: "team-user",
        password: "secret-canary",
        ssl: { rejectUnauthorized: true, ca: "test-ca" },
      },
      schema: "team_schema",
      maximumPoolSize: 2,
      connectionTimeoutMs: 100,
      idlePoolTimeoutMs: 200,
      statementTimeoutMs: 300,
      queryTimeoutMs: 400,
      lockTimeoutMs: 50,
      idleTransactionTimeoutMs: 500,
      transactionTimeoutMs: 600,
      shutdownTimeoutMs: 700,
    }));
    expect(database.configurations).toEqual([
      expect.objectContaining({
        host: "db.internal",
        port: 6543,
        database: "team-db",
        user: "team-user",
        password: "secret-canary",
        ssl: { rejectUnauthorized: true, ca: "test-ca" },
        maximumPoolSize: 2,
      }),
    ]);
    await adapter.close();
  });

  it.each([
    ["unknown option", { ...options(), unexpected: true }],
    ["unknown connection option", { ...options(), connection: { ...options().connection, url: "secret" } }],
    ["bad host", { ...options(), connection: { ...options().connection, host: "bad host" } }],
    ["bad port", { ...options(), connection: { ...options().connection, port: 0 } }],
    ["bad database", { ...options(), connection: { ...options().connection, database: "bad/name" } }],
    ["bad user", { ...options(), connection: { ...options().connection, user: "bad user" } }],
    ["NUL password", { ...options(), connection: { ...options().connection, password: "bad\u0000secret" } }],
    ["unverified TLS", { ...options(), connection: { ...options().connection, ssl: { rejectUnauthorized: false } } }],
    ["bad schema", { ...options(), schema: "Bad-Schema" }],
    ["shared public schema", { ...options(), schema: "public" }],
    ["information schema", { ...options(), schema: "information_schema" }],
    ["PostgreSQL catalog schema", { ...options(), schema: "pg_catalog" }],
    ["PostgreSQL reserved schema prefix", { ...options(), schema: "pg_task_owned" }],
    ["bad pool", { ...options(), maximumPoolSize: 0 }],
    ["bad timeout order", { ...options(), statementTimeoutMs: 20, transactionTimeoutMs: 10 }],
    ["bad query timeout order", { ...options(), statementTimeoutMs: 20, queryTimeoutMs: 10 }],
  ])("rejects %s before constructing a pool", async (_label, input) => {
    const database = new FakePostgresDatabase();
    await expect(createPostgresPersistenceAdapterForTesting(input as PostgresAdapterOptions, {
      poolFactory: createFakePoolFactory(database),
    })).rejects.toBeDefined();
    expect(database.configurations).toHaveLength(0);
  });

  it.each([
    ["top-level", { ...options(), "secret-canary-top-level": true }],
    ["connection", {
      ...options(),
      connection: { ...options().connection, "secret-canary-connection": true },
    }],
    ["TLS", {
      ...options(),
      connection: {
        ...options().connection,
        ssl: { rejectUnauthorized: true, "secret-canary-tls": true },
      },
    }],
  ])("redacts a hostile %s option key before constructing a pool", async (_label, input) => {
    const database = new FakePostgresDatabase();
    const error = await createPostgresPersistenceAdapterForTesting(
      input as PostgresAdapterOptions,
      { poolFactory: createFakePoolFactory(database) },
    ).catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "STORAGE_FAILURE",
      details: { reason: "storage", retryable: false },
    });
    expect(JSON.stringify((error as PersistenceError).toJSON())).not.toContain("secret-canary");
    expect(database.configurations).toHaveLength(0);
  });

  it("maps only finite SQLSTATE classifications and redacts driver text", () => {
    const cases = [
      ["40001", "serialization-failure", true],
      ["40P01", "deadlock", true],
      ["55P03", "lock-timeout", true],
      ["57014", "query-timeout", true],
      ["53300", "capacity", true],
      ["08006", "connection", true],
      ["57P01", "connection", true],
      ["57P04", "connection", true],
      ["23514", "storage", false],
      ["not-safe", "storage", false],
    ] as const;
    for (const [code, reason, retryable] of cases) {
      const error = Object.assign(new Error("secret-driver-canary"), { code, detail: "secret-body" });
      const mapped = postgresAdapterTesting.storageFailure(error);
      expect(mapped.details).toMatchObject({ reason, retryable });
      expect(mapped.code).toBe(code === "40001" ? "CONCURRENCY_CONFLICT" : "STORAGE_FAILURE");
      expect(JSON.stringify(mapped.toJSON())).not.toContain("secret");
    }
    expect(postgresAdapterTesting.safeSqlState(null)).toBeNull();
    expect(postgresAdapterTesting.safeSqlState({ code: 1 })).toBeNull();
    const original = new PersistenceError("NOT_FOUND", "safe");
    expect(postgresAdapterTesting.storageFailure(original)).toBe(original);
  });

  it("fails closed after an idle-pool failure and on a later connect failure", async () => {
    const first = await open();
    first.database.emitPoolError();
    await expect(first.adapter.transact(() => 1)).rejects.toMatchObject({
      code: "STORAGE_FAILURE",
      details: { reason: "connection" },
    });
    await first.adapter.close();

    const second = await open();
    second.database.connectFailure = Object.assign(new Error("credential-canary"), { code: "08001" });
    await expect(second.adapter.transact(() => 1)).rejects.toMatchObject({
      code: "STORAGE_FAILURE",
      details: { reason: "connection" },
    });
    await second.adapter.close();
  });

  it("rolls back a failed query without leaking SQL or payload data", async () => {
    const { adapter, database } = await open();
    database.queryFailure = {
      tag: "ados:aggregate-create",
      error: Object.assign(new Error("raw-sql secret-body"), { code: "57014" }),
    };
    const failure = await adapter.transact((tx) => tx.aggregates.create({
      aggregateType: "project",
      aggregateId: "project-1",
      schemaVersion: 1,
      payload: { canary: "secret-body" },
    })).catch((error: unknown) => error as PersistenceError);
    expect(failure).toMatchObject({ code: "STORAGE_FAILURE", details: { reason: "query-timeout" } });
    expect(JSON.stringify(failure.toJSON())).not.toContain("secret-body");
    await adapter.close();
  });

  it("uses a transaction-health probe after a caught driver rejection", async () => {
    const { adapter, database } = await open();
    database.queryFailures.push(
      {
        tag: "ados:event-append",
        error: Object.assign(new Error("driver failure"), { code: "23514" }),
      },
      {
        tag: "ados:transaction-probe",
        error: Object.assign(new Error("transaction aborted"), { code: "25P02" }),
      },
    );
    await expect(
      adapter.transact(async (tx) => {
        await tx.aggregates.create({
          aggregateType: "project",
          aggregateId: "project-probe",
          schemaVersion: 1,
          payload: { committed: false },
        });
        await tx.events.append({
          eventId: "event-probe",
          aggregateType: "project",
          aggregateId: "project-probe",
          aggregateVersion: 1,
          eventType: "project.created",
          eventSchemaVersion: 1,
          payload: {},
          occurredAt: "2026-08-10T22:00:00.000Z",
        }).catch(() => undefined);
        return "callback-resolved";
      }),
    ).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
    await expect(
      adapter.transact((tx) => tx.aggregates.get("project", "project-probe")),
    ).resolves.toBeNull();
    await adapter.close();
  });

  it("closes the transaction context before draining operations started by the callback", async () => {
    const { adapter, database } = await open();
    const pause = database.pauseNextQuery("ados:aggregate-get");
    let escaped: Parameters<Parameters<typeof adapter.transact>[0]>[0] | undefined;
    const transaction = adapter.transact((tx) => {
      escaped = tx;
      void tx.aggregates.get("project", "project-drain");
      return "callback-resolved";
    });
    await pause.entered;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      Promise.resolve().then(() => escaped?.aggregates.get("project", "project-late")),
    ).rejects.toMatchObject({ code: "TRANSACTION_COMPLETED" });
    pause.release();
    await expect(transaction).resolves.toBe("callback-resolved");
    await adapter.close();
  });

  it("applies one whole-transaction deadline to post-callback operation draining", async () => {
    const { adapter, database } = await open(new FakePostgresDatabase(), options({
      statementTimeoutMs: 5,
      queryTimeoutMs: 20,
      transactionTimeoutMs: 10,
    }));
    const pause = database.pauseNextQuery("ados:aggregate-get");
    const transaction = adapter.transact((tx) => {
      void tx.aggregates.get("project", "project-drain-timeout");
      return "callback-resolved";
    });
    await pause.entered;
    await expect(transaction).rejects.toMatchObject({
      code: "STORAGE_FAILURE",
      details: { reason: "transaction-timeout", retryable: true },
    });
    pause.release();
    await adapter.close();
  });

  it("enforces a callback wall-time bound and rejects later context use", async () => {
    const { adapter } = await open(new FakePostgresDatabase(), options({
      statementTimeoutMs: 1,
      transactionTimeoutMs: 5,
    }));
    let escaped: Parameters<Parameters<typeof adapter.transact>[0]>[0] | undefined;
    await expect(adapter.transact(async (tx) => {
      escaped = tx;
      await new Promise<never>(() => undefined);
    })).rejects.toMatchObject({ code: "STORAGE_FAILURE", details: { reason: "transaction-timeout" } });
    await expect(Promise.resolve().then(() => escaped?.aggregates.get("project", "late"))).rejects.toMatchObject({
      code: "TRANSACTION_COMPLETED",
    });
    await adapter.close();
  });

  it("bounds rollback cleanup and destroys a session that cannot roll back", async () => {
    const database = new FakePostgresDatabase();
    const { adapter } = await open(database, options({
      statementTimeoutMs: 5,
      queryTimeoutMs: 5,
      transactionTimeoutMs: 5,
    }));
    database.queryFailure = {
      tag: "ados:aggregate-create",
      error: Object.assign(new Error("query-canary"), { code: "57014" }),
    };
    database.queryHangTag = "ROLLBACK";
    const started = performance.now();
    await expect(adapter.transact((tx) => tx.aggregates.create({
      aggregateType: "project",
      aggregateId: "project-rollback-timeout",
      schemaVersion: 1,
      payload: {},
    }))).rejects.toMatchObject({ code: "STORAGE_FAILURE", details: { reason: "query-timeout" } });
    expect(performance.now() - started).toBeLessThan(250);
    expect(database.destroyedReleaseCount).toBe(1);
    database.queryHangTag = null;
    await adapter.close();
  });

  it("normalizes migration-status and shutdown failures and keeps close idempotent", async () => {
    const first = await open();
    first.database.queryFailure = {
      tag: ".schema_migrations",
      error: Object.assign(new Error("migration secret"), { code: "08006" }),
    };
    await expect(first.adapter.migrationStatus()).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
    await first.adapter.close();
    await first.adapter.close();

    const second = await open();
    second.database.endFailure = Object.assign(new Error("shutdown secret"), { code: "08006" });
    await expect(second.adapter.close()).rejects.toMatchObject({
      code: "STORAGE_FAILURE",
      details: { reason: "connection" },
    });
  });

  it("bounds pool cleanup after migration startup fails while preserving the original error", async () => {
    const database = new FakePostgresDatabase();
    database.queryFailure = {
      tag: "CREATE TABLE aggregates",
      error: Object.assign(new Error("migration-canary"), { code: "42601" }),
    };
    database.endHangs = true;
    const started = performance.now();
    await expect(open(database, options({ shutdownTimeoutMs: 5 }))).rejects.toMatchObject({
      code: "MIGRATION_FAILED",
    });
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe("PostgreSQL migrations and row validation", () => {
  it("refuses checksum drift and unknown future history on reopen", async () => {
    const database = new FakePostgresDatabase();
    const first = await open(database);
    await first.adapter.close();
    database.tamperMigrationChecksum("0001-initial-schema");
    await expect(open(database)).rejects.toMatchObject({ code: "MIGRATION_CHECKSUM_MISMATCH" });

    const ahead = new FakePostgresDatabase();
    const seeded = await open(ahead);
    await seeded.adapter.close();
    ahead.addUnknownMigration("9999-future-schema");
    await expect(open(ahead)).rejects.toMatchObject({ code: "SCHEMA_TOO_NEW" });
  });

  it("bounds migration definitions and forged future history before allocation grows", async () => {
    const oversizedDefinitions = Array.from({ length: 1_025 }, (_value, index) => ({
      id: `${String(index + 1).padStart(4, "0")}-bounded`,
      content: "SELECT 1;",
    }));
    const oversizedDatabase = new FakePostgresDatabase();
    await expect(createPostgresPersistenceAdapterForTesting(options(), {
      poolFactory: createFakePoolFactory(oversizedDatabase),
      migrations: oversizedDefinitions,
    })).rejects.toMatchObject({
      code: "MIGRATION_FAILED",
      details: { maximumMigrationDefinitions: 1_024 },
    });
    expect(oversizedDatabase.configurations).toHaveLength(0);

    const ahead = new FakePostgresDatabase();
    const seeded = await open(ahead);
    await seeded.adapter.close();
    for (let ordinal = 2; ordinal <= 200; ordinal += 1) {
      ahead.addUnknownMigration(`${String(ordinal).padStart(4, "0")}-future-schema`);
    }
    const error = await open(ahead).catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "SCHEMA_TOO_NEW",
      details: { unknownMigrationIds: ["0002-future-schema"] },
    });
  });

  it("reports migration status against the exact injected definition set", async () => {
    const database = new FakePostgresDatabase();
    const second = Object.freeze({
      id: "0002-testing-extension",
      content: "CREATE TABLE aggregates",
    });
    const adapter = await createPostgresPersistenceAdapterForTesting(options(), {
      poolFactory: createFakePoolFactory(database),
      migrations: Object.freeze([POSTGRES_MIGRATIONS[0]!, second]),
    });
    expect(await adapter.migrationStatus()).toMatchObject({
      applied: [
        { id: "0001-initial-schema", ordinal: 1 },
        { id: "0002-testing-extension", ordinal: 2 },
      ],
      pending: [],
      databaseSchemaAhead: false,
    });
    await adapter.close();
  });

  it("rolls back a failed migration, redacts it, and resumes cleanly", async () => {
    const database = new FakePostgresDatabase();
    database.queryFailures.push({
      tag: "CREATE TABLE aggregates",
      error: Object.assign(new Error("secret migration SQL"), { code: "55P03" }),
    });
    await expect(open(database)).rejects.toMatchObject({
      code: "MIGRATION_FAILED",
      details: { migrationId: "0001-initial-schema", postgresCode: "55P03" },
    });
    const reopened = await open(database);
    expect(await reopened.adapter.migrationStatus()).toMatchObject({ pending: [] });
    await reopened.adapter.close();
  });

  it("keeps the released prefix after an injected C7 failure and applies 0004 once on resume", async () => {
    const database = new FakePostgresDatabase();
    const releasedPrefix = Object.freeze(POSTGRES_MIGRATIONS.slice(0, 3));
    const seeded = await createPostgresPersistenceAdapterForTesting(options(), {
      poolFactory: createFakePoolFactory(database),
      migrations: releasedPrefix,
    });
    await seeded.close();

    database.queryFailures.push({
      tag: "ALTER TABLE aggregates DROP CONSTRAINT",
      error: Object.assign(new Error("secret C7 migration SQL"), { code: "42601" }),
    });
    await expect(open(database)).rejects.toMatchObject({
      code: "MIGRATION_FAILED",
      details: { migrationId: "0004-project-persistence-aggregates", postgresCode: "42601" },
    });

    const prefixReopen = await createPostgresPersistenceAdapterForTesting(options(), {
      poolFactory: createFakePoolFactory(database),
      migrations: releasedPrefix,
    });
    expect((await prefixReopen.migrationStatus()).applied.map((migration) => migration.id))
      .toEqual(releasedPrefix.map((migration) => migration.id));
    await prefixReopen.close();

    const corrected = await open(database);
    expect((await corrected.adapter.migrationStatus()).applied.map((migration) => migration.id))
      .toEqual(POSTGRES_MIGRATIONS.map((migration) => migration.id));
    await corrected.adapter.close();
  });

  it("destroys a session when rollback or advisory-unlock fails", async () => {
    const rollback = new FakePostgresDatabase();
    rollback.queryFailures.push(
      { tag: "CREATE TABLE aggregates", error: Object.assign(new Error("first"), { code: "40001" }) },
      { tag: "ROLLBACK", error: Object.assign(new Error("second"), { code: "08006" }) },
    );
    await expect(open(rollback)).rejects.toMatchObject({ code: "MIGRATION_FAILED" });

    const unlock = new FakePostgresDatabase();
    unlock.queryFailure = {
      tag: "pg_advisory_unlock",
      error: Object.assign(new Error("unlock"), { code: "08006" }),
    };
    const opened = await open(unlock);
    await opened.adapter.close();
  });

  it("validates numeric rows and turns invalid stored records into finite corruption", () => {
    const payload = "{}";
    const checksum = computeChecksumOfText(payload);
    const envelope = postgresAdapterTesting.rowToEnvelope({
      aggregate_type: "project",
      aggregate_id: "project-1",
      schema_version: 1,
      aggregate_version: 1,
      payload,
      checksum_algorithm: checksum.algorithm,
      checksum_hex: checksum.hex,
      created_at: "2026-08-10T22:00:00.000Z",
      updated_at: "2026-08-10T22:00:00.000Z",
      trace_id: null,
    });
    expect(envelope.aggregateVersion).toBe(1);
    expect(() => postgresAdapterTesting.rowToEnvelope({
      ...envelope,
      aggregate_type: "unknown",
      aggregate_id: "project-1",
      schema_version: "1",
      aggregate_version: "1",
      checksum_algorithm: checksum.algorithm,
      checksum_hex: checksum.hex,
      created_at: envelope.createdAt,
      updated_at: envelope.updatedAt,
      trace_id: null,
    })).toThrow();
  });

  it("rejects command-impossible stored identities, kinds, timestamps, canonical text, and outbox states", () => {
    const payload = "{}";
    const checksum = computeChecksumOfText(payload);
    const aggregate = {
      aggregate_type: "project",
      aggregate_id: "project-1",
      schema_version: "1",
      aggregate_version: "1",
      payload,
      checksum_algorithm: checksum.algorithm,
      checksum_hex: checksum.hex,
      created_at: "2026-08-10T22:00:00.000Z",
      updated_at: "2026-08-10T22:00:00.000Z",
      trace_id: null,
    } as const;
    const event = {
      event_id: "event-1",
      aggregate_type: "project",
      aggregate_id: "project-1",
      aggregate_version: "1",
      event_type: "project.created",
      event_schema_version: "1",
      payload,
      checksum_algorithm: checksum.algorithm,
      checksum_hex: checksum.hex,
      occurred_at: "2026-08-10T22:00:00.000Z",
      recorded_at: "2026-08-10T22:00:00.000Z",
      global_sequence: "1",
      trace_id: null,
      causation_id: null,
    } as const;
    const outbox = {
      message_id: "message-1",
      topic: "work.ready",
      schema_version: "1",
      payload,
      checksum_algorithm: checksum.algorithm,
      checksum_hex: checksum.hex,
      idempotency_key: "idempotency-1",
      status: "pending",
      attempt_count: "0",
      created_at: "2026-08-10T22:00:00.000Z",
      available_at: "2026-08-10T22:00:00.000Z",
      lease_owner: null,
      lease_expires_at: null,
      acknowledged_at: null,
      dead_lettered_at: null,
      last_failure_category: null,
      sequence: "1",
      trace_id: null,
    } as const;

    expect(postgresAdapterTesting.rowToEnvelope(aggregate)).toMatchObject({ aggregateId: "project-1" });
    expect(postgresAdapterTesting.rowToEvent(event)).toMatchObject({ eventType: "project.created" });
    expect(postgresAdapterTesting.rowToOutbox(outbox)).toMatchObject({ status: "pending" });
    for (const corrupt of [
      () => postgresAdapterTesting.rowToEnvelope({ ...aggregate, trace_id: "bad identity" }),
      () => postgresAdapterTesting.rowToEnvelope({
        ...aggregate,
        payload: " { } ",
        checksum_hex: computeChecksumOfText(" { } ").hex,
      }),
      () => postgresAdapterTesting.rowToEnvelope({
        ...aggregate,
        payload: "{",
        checksum_hex: computeChecksumOfText("{").hex,
      }),
      () => postgresAdapterTesting.rowToEvent({ ...event, event_type: "Project.Created" }),
      () => postgresAdapterTesting.rowToEvent({
        ...event,
        payload: "{",
        checksum_hex: computeChecksumOfText("{").hex,
      }),
      () => postgresAdapterTesting.rowToEvent({ ...event, recorded_at: "not-a-timestamp" }),
      () => postgresAdapterTesting.rowToOutbox({ ...outbox, topic: "Bad Topic" }),
      () => postgresAdapterTesting.rowToOutbox({ ...outbox, idempotency_key: "bad key" }),
      () => postgresAdapterTesting.rowToOutbox({
        ...outbox,
        payload: "{",
        checksum_hex: computeChecksumOfText("{").hex,
      }),
      () => postgresAdapterTesting.rowToOutbox({
        ...outbox,
        status: "leased",
        attempt_count: "1",
      }),
      () => postgresAdapterTesting.rowToOutbox({
        ...outbox,
        status: "dead-lettered",
        attempt_count: "1",
        dead_lettered_at: "2026-08-10T22:00:01.000Z",
      }),
    ]) {
      expect(corrupt).toThrowError(expect.objectContaining({ code: "CORRUPTION_DETECTED" }));
    }
  });

  it("maps matching-checksum malformed artifact JSON to finite corruption", async () => {
    const { adapter, database } = await open();
    const descriptor = {
      schemaVersion: 1,
      id: "artifact-malformed",
      displayName: "malformed artifact",
      kind: "structured-data",
      role: "output",
      mediaType: "application/json",
      sizeBytes: 1,
      digest: { algorithm: "sha-256", hex: "a".repeat(64) },
      classification: "internal",
      location: { type: "content-addressed", store: "local" },
      provenance: {
        producedBy: { type: "user" }, runId: null, taskId: null,
        taskRunId: null, traceId: null,
      },
      parents: [],
      createdAt: "2026-08-10T22:00:00.000Z",
    } as const;
    await adapter.transact(async (tx) => {
      await tx.artifacts.putDescriptor(descriptor);
      await tx.artifacts.putManifest({
        schemaVersion: 1,
        manifestId: "manifest-malformed",
        taskRunId: null,
        artifacts: [descriptor],
        createdAt: "2026-08-10T22:00:00.000Z",
      });
    });
    const checksum = computeChecksumOfText("{");
    database.tamperArtifactRecord("descriptor", descriptor.id, {
      payload: "{",
      checksum_algorithm: checksum.algorithm,
      checksum_hex: checksum.hex,
    });
    database.tamperArtifactRecord("manifest", "manifest-malformed", {
      payload: "{",
      checksum_algorithm: checksum.algorithm,
      checksum_hex: checksum.hex,
    });

    await expect(adapter.transact((tx) => tx.artifacts.getDescriptor(descriptor.id)))
      .rejects.toMatchObject({ code: "CORRUPTION_DETECTED" });
    await expect(adapter.transact((tx) => tx.artifacts.listDescriptors({})))
      .rejects.toMatchObject({ code: "CORRUPTION_DETECTED" });
    await expect(adapter.transact((tx) => tx.artifacts.getManifest("manifest-malformed")))
      .rejects.toMatchObject({ code: "CORRUPTION_DETECTED" });
    await adapter.close();
  });

  it("binds stored artifact and manifest payload identities to their physical row keys", async () => {
    const { adapter, database } = await open();
    const descriptor = (id: string) => ({
      schemaVersion: 1,
      id,
      displayName: `artifact ${id}`,
      kind: "structured-data",
      role: "output",
      mediaType: "application/json",
      sizeBytes: 1,
      digest: { algorithm: "sha-256", hex: "a".repeat(64) },
      classification: "internal",
      location: { type: "content-addressed", store: "local" },
      provenance: {
        producedBy: { type: "user" }, runId: null, taskId: null,
        taskRunId: null, traceId: null,
      },
      parents: [],
      createdAt: "2026-08-10T22:00:00.000Z",
    });
    await adapter.transact(async (tx) => {
      await tx.artifacts.putDescriptor(descriptor("artifact-a"));
      await tx.artifacts.putDescriptor(descriptor("artifact-c"));
      await tx.artifacts.putManifest({
        schemaVersion: 1,
        manifestId: "manifest-a",
        taskRunId: null,
        artifacts: [descriptor("artifact-a")],
        createdAt: "2026-08-10T22:00:00.000Z",
      });
    });
    const wrongDescriptor = preparePayload(descriptor("artifact-b"), "test.descriptor");
    database.tamperArtifactRecord("descriptor", "artifact-a", {
      payload: wrongDescriptor.text,
      checksum_algorithm: wrongDescriptor.checksum.algorithm,
      checksum_hex: wrongDescriptor.checksum.hex,
    });
    const wrongManifest = preparePayload({
      schemaVersion: 1,
      manifestId: "manifest-b",
      taskRunId: null,
      artifacts: [descriptor("artifact-b")],
      createdAt: "2026-08-10T22:00:00.000Z",
    }, "test.manifest");
    database.tamperArtifactRecord("manifest", "manifest-a", {
      payload: wrongManifest.text,
      checksum_algorithm: wrongManifest.checksum.algorithm,
      checksum_hex: wrongManifest.checksum.hex,
    });
    database.tamperArtifactRecord("descriptor", "artifact-c", {
      checksum_algorithm: "unknown",
    });

    await expect(adapter.transact((tx) => tx.artifacts.getDescriptor("artifact-a")))
      .rejects.toMatchObject({ code: "CORRUPTION_DETECTED" });
    await expect(adapter.transact((tx) => tx.artifacts.listDescriptors({})))
      .rejects.toMatchObject({ code: "CORRUPTION_DETECTED" });
    await expect(adapter.transact((tx) => tx.artifacts.getManifest("manifest-a")))
      .rejects.toMatchObject({ code: "CORRUPTION_DETECTED" });
    await expect(adapter.transact((tx) => tx.artifacts.getDescriptor("artifact-c")))
      .rejects.toMatchObject({ code: "CORRUPTION_DETECTED" });
    await adapter.close();
  });
});
