import {
  parseArtifactDescriptor,
  parseArtifactManifest,
  type ArtifactDescriptor,
  type ArtifactManifest,
} from "@ai-dev-os/artifacts";
import { DomainError, parseJsonText, ValidationError, validation } from "@ai-dev-os/domain";
import {
  AGGREGATE_TYPES,
  AsyncMutex,
  MAX_AGGREGATE_VERSION,
  MAX_SCHEMA_VERSION,
  OUTBOX_STATUSES,
  PersistenceError,
  SessionGate,
  TransactionGuard,
  applyAcknowledge,
  applyClaim,
  applyDeadLetter,
  applyScheduleRetry,
  buildPage,
  computeChecksumOfText,
  decodeCursor,
  leaseExpiry,
  normalizePageSize,
  observeOperation,
  planMigrations,
  parseAggregateType,
  parseChecksum,
  parseFailureCategory,
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
  type Clock,
  type EventRecord,
  type EventStore,
  type MigrationDefinition,
  type MigrationStatus,
  type OutboxMessage,
  type OutboxStatus,
  type OutboxStore,
  type PersistenceAdapter,
  type PersistenceObserver,
  type TransactionContext,
} from "@ai-dev-os/persistence";
import {
  createDatabasePool,
  type DatabaseClient,
  type DatabasePool,
  type DatabasePoolConfiguration,
} from "./driver.js";
import {
  POSTGRES_MIGRATIONS,
  applyPostgresMigrations,
  migrationStatus as readMigrationStatus,
} from "./migrations.js";

const {
  ensureEnum,
  ensureExactKeys,
  ensureRecord,
  ensureSafeInteger,
  ensureString,
  ensureTimestamp,
  fail,
} = validation;

const MAX_BIGINT = Number.MAX_SAFE_INTEGER;
const SCHEMA_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const HOST_PATTERN = /^[A-Za-z0-9._:-]{1,255}$/;
const CONNECTION_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

export interface PostgresSslOptions {
  readonly rejectUnauthorized: true;
  readonly ca?: string;
}

export interface PostgresConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly ssl: false | PostgresSslOptions;
}

export interface PostgresAdapterOptions extends AdapterOptions {
  readonly connection: PostgresConnectionOptions;
  readonly schema?: string;
  readonly maximumPoolSize?: number;
  readonly connectionTimeoutMs?: number;
  readonly idlePoolTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly queryTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly idleTransactionTimeoutMs?: number;
  readonly transactionTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

export interface PostgresTestingOptions {
  readonly poolFactory?: (configuration: DatabasePoolConfiguration) => DatabasePool;
  readonly migrations?: readonly MigrationDefinition[];
}

interface NormalizedOptions {
  readonly poolConfiguration: DatabasePoolConfiguration;
  readonly schema: string;
  readonly transactionTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly clock: Clock;
  readonly observer: PersistenceObserver | undefined;
}

interface AggregateRow extends Readonly<Record<string, unknown>> {
  readonly aggregate_type: unknown;
  readonly aggregate_id: unknown;
  readonly schema_version: unknown;
  readonly aggregate_version: unknown;
  readonly payload: unknown;
  readonly checksum_algorithm: unknown;
  readonly checksum_hex: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly trace_id: unknown;
}

interface EventRow extends Readonly<Record<string, unknown>> {
  readonly event_id: unknown;
  readonly aggregate_type: unknown;
  readonly aggregate_id: unknown;
  readonly aggregate_version: unknown;
  readonly event_type: unknown;
  readonly event_schema_version: unknown;
  readonly payload: unknown;
  readonly checksum_algorithm: unknown;
  readonly checksum_hex: unknown;
  readonly occurred_at: unknown;
  readonly recorded_at: unknown;
  readonly global_sequence: unknown;
  readonly trace_id: unknown;
  readonly causation_id: unknown;
}

interface OutboxRow extends Readonly<Record<string, unknown>> {
  readonly message_id: unknown;
  readonly topic: unknown;
  readonly schema_version: unknown;
  readonly payload: unknown;
  readonly checksum_algorithm: unknown;
  readonly checksum_hex: unknown;
  readonly idempotency_key: unknown;
  readonly status: unknown;
  readonly attempt_count: unknown;
  readonly created_at: unknown;
  readonly available_at: unknown;
  readonly lease_owner: unknown;
  readonly lease_expires_at: unknown;
  readonly acknowledged_at: unknown;
  readonly dead_lettered_at: unknown;
  readonly last_failure_category: unknown;
  readonly sequence: unknown;
  readonly trace_id: unknown;
}

interface ArtifactRow extends Readonly<Record<string, unknown>> {
  readonly payload: unknown;
  readonly checksum_algorithm: unknown;
  readonly checksum_hex: unknown;
}

function nullableTimestamp(value: unknown, path: string): string | null {
  return value === null ? null : ensureTimestamp(value, path);
}

function nullablePersistedId(value: unknown, path: string): string | null {
  return value === null ? null : parsePersistedId(value, path);
}

function nullableFailureCategory(value: unknown, path: string): string | null {
  return value === null ? null : parseFailureCategory(value, path);
}

function databaseInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    return ensureSafeInteger(parsed, path, minimum, maximum);
  }
  return ensureSafeInteger(value, path, minimum, maximum);
}

function safeSqlState(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const value = (error as { readonly code?: unknown }).code;
  return typeof value === "string" && /^[0-9A-Z]{5}$/.test(value) ? value : null;
}

function storageFailure(error: unknown, fallbackReason = "storage"): PersistenceError {
  if (error instanceof PersistenceError) {
    return error;
  }
  if (error instanceof ValidationError) {
    return new PersistenceError("CORRUPTION_DETECTED", "A PostgreSQL record failed validation.", {
      reason: "invalid-record",
    });
  }
  const postgresCode = safeSqlState(error);
  if (postgresCode === "40001") {
    return new PersistenceError(
      "CONCURRENCY_CONFLICT",
      "The PostgreSQL transaction conflicted with concurrent work.",
      { reason: "serialization-failure", retryable: true, postgresCode },
    );
  }
  const reason =
    postgresCode === "40P01"
        ? "deadlock"
        : postgresCode === "55P03"
          ? "lock-timeout"
          : postgresCode === "57014"
            ? "query-timeout"
            : postgresCode === "53300"
              ? "capacity"
              : postgresCode?.startsWith("08") === true ||
                  ["57P01", "57P02", "57P03", "57P04"].includes(postgresCode ?? "")
                ? "connection"
                : fallbackReason;
  return new PersistenceError("STORAGE_FAILURE", "A PostgreSQL operation failed.", {
    reason,
    retryable: ["deadlock", "lock-timeout", "query-timeout", "connection", "capacity"].includes(reason),
    postgresCode,
  });
}

function parseSsl(value: unknown): false | PostgresSslOptions {
  if (value === false) {
    return false;
  }
  const record = ensureRecord(value, "postgres.options.connection.ssl");
  ensureExactKeys(record, ["rejectUnauthorized", "ca"], "postgres.options.connection.ssl");
  if (record["rejectUnauthorized"] !== true) {
    fail(
      "postgres.options.connection.ssl.rejectUnauthorized",
      "tls_verification_required",
      "must be the literal true when TLS is enabled.",
    );
  }
  const ca =
    record["ca"] === undefined
      ? undefined
      : ensureString(record["ca"], "postgres.options.connection.ssl.ca", {
          minLength: 1,
          maxLength: 100_000,
        });
  return Object.freeze({ rejectUnauthorized: true as const, ...(ca === undefined ? {} : { ca }) });
}

function boundedMilliseconds(
  value: unknown,
  path: string,
  defaultValue: number,
  minimum = 1,
): number {
  return ensureSafeInteger(value ?? defaultValue, path, minimum, 600_000);
}

function normalizeOptions(options: PostgresAdapterOptions): NormalizedOptions {
  const record = ensureRecord(options, "postgres.options");
  ensureExactKeys(
    record,
    [
      "connection",
      "schema",
      "maximumPoolSize",
      "connectionTimeoutMs",
      "idlePoolTimeoutMs",
      "statementTimeoutMs",
      "queryTimeoutMs",
      "lockTimeoutMs",
      "idleTransactionTimeoutMs",
      "transactionTimeoutMs",
      "shutdownTimeoutMs",
      "clock",
      "observer",
    ],
    "postgres.options",
  );
  const connection = ensureRecord(record["connection"], "postgres.options.connection");
  ensureExactKeys(
    connection,
    ["host", "port", "database", "user", "password", "ssl"],
    "postgres.options.connection",
  );
  const host = ensureString(connection["host"], "postgres.options.connection.host", {
    maxLength: 255,
    pattern: HOST_PATTERN,
    patternName: "TCP host",
  });
  const database = ensureString(connection["database"], "postgres.options.connection.database", {
    maxLength: 128,
    pattern: CONNECTION_NAME_PATTERN,
    patternName: "database name",
  });
  const user = ensureString(connection["user"], "postgres.options.connection.user", {
    maxLength: 128,
    pattern: CONNECTION_NAME_PATTERN,
    patternName: "user name",
  });
  const password = ensureString(connection["password"], "postgres.options.connection.password", {
    minLength: 1,
    maxLength: 4_096,
  });
  if (password.includes("\u0000")) {
    fail("postgres.options.connection.password", "nul_character", "must not contain NUL.");
  }
  const schema = ensureString(record["schema"] ?? "ai_dev_os", "postgres.options.schema", {
    maxLength: 63,
    pattern: SCHEMA_PATTERN,
    patternName: "PostgreSQL schema identifier",
  });
  if (schema === "public" || schema === "information_schema" || schema.startsWith("pg_")) {
    fail(
      "postgres.options.schema",
      "reserved_schema",
      "must identify a dedicated application schema, not a PostgreSQL-reserved or shared schema.",
    );
  }
  const connectionTimeoutMs = boundedMilliseconds(
    record["connectionTimeoutMs"],
    "postgres.options.connectionTimeoutMs",
    5_000,
  );
  const statementTimeoutMs = boundedMilliseconds(
    record["statementTimeoutMs"],
    "postgres.options.statementTimeoutMs",
    30_000,
  );
  const queryTimeoutMs = boundedMilliseconds(
    record["queryTimeoutMs"],
    "postgres.options.queryTimeoutMs",
    35_000,
  );
  if (queryTimeoutMs < statementTimeoutMs) {
    fail(
      "postgres.options.queryTimeoutMs",
      "timeout_order",
      "must be greater than or equal to statementTimeoutMs.",
    );
  }
  const lockTimeoutMs = boundedMilliseconds(
    record["lockTimeoutMs"],
    "postgres.options.lockTimeoutMs",
    5_000,
  );
  const idleTransactionTimeoutMs = boundedMilliseconds(
    record["idleTransactionTimeoutMs"],
    "postgres.options.idleTransactionTimeoutMs",
    30_000,
  );
  const transactionTimeoutMs = boundedMilliseconds(
    record["transactionTimeoutMs"],
    "postgres.options.transactionTimeoutMs",
    60_000,
  );
  if (transactionTimeoutMs < statementTimeoutMs) {
    fail(
      "postgres.options.transactionTimeoutMs",
      "timeout_order",
      "must be greater than or equal to statementTimeoutMs.",
    );
  }
  return Object.freeze({
    schema,
    transactionTimeoutMs,
    shutdownTimeoutMs: boundedMilliseconds(
      record["shutdownTimeoutMs"],
      "postgres.options.shutdownTimeoutMs",
      30_000,
    ),
    clock: (record["clock"] as Clock | undefined) ?? systemClock,
    observer: record["observer"] as PersistenceObserver | undefined,
    poolConfiguration: Object.freeze({
      host,
      port: ensureSafeInteger(connection["port"], "postgres.options.connection.port", 1, 65_535),
      database,
      user,
      password,
      ssl: parseSsl(connection["ssl"]),
      maximumPoolSize: ensureSafeInteger(
        record["maximumPoolSize"] ?? 4,
        "postgres.options.maximumPoolSize",
        1,
        16,
      ),
      connectionTimeoutMs,
      idlePoolTimeoutMs: boundedMilliseconds(
        record["idlePoolTimeoutMs"],
        "postgres.options.idlePoolTimeoutMs",
        30_000,
      ),
      statementTimeoutMs,
      queryTimeoutMs,
      lockTimeoutMs,
      idleTransactionTimeoutMs,
    }),
  });
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function query(
  client: DatabaseClient,
  text: string,
  values: readonly unknown[] = [],
): Promise<{ readonly rows: readonly Readonly<Record<string, unknown>>[]; readonly rowCount: number }> {
  try {
    return await client.query(text, values);
  } catch (error) {
    throw storageFailure(error);
  }
}

function sequenceCommitOrderKey(schema: string): number {
  const unsigned = Number.parseInt(
    computeChecksumOfText(`sequence-order:${schema}`).hex.slice(0, 8),
    16,
  );
  return unsigned > 0x7fff_ffff ? unsigned - 0x1_0000_0000 : unsigned;
}

async function lockCommitOrderedSequence(
  client: DatabaseClient,
  schemaKey: number,
): Promise<void> {
  await query(
    client,
    "SELECT pg_catalog.pg_advisory_xact_lock($1, $2)",
    [1_092_874_307, schemaKey],
  );
}

function rowString(row: Readonly<Record<string, unknown>>, key: string, maximum = 10_000_000): string {
  return ensureString(row[key], `postgres.row.${key}`, { maxLength: maximum });
}

function storedRecord<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof PersistenceError) {
      throw error;
    }
    if (error instanceof DomainError) {
      throw new PersistenceError(
        "CORRUPTION_DETECTED",
        "A PostgreSQL record failed validation.",
        { reason: "invalid-record" },
      );
    }
    throw error;
  }
}

function assertCanonicalStoredPayload(
  storedText: string,
  canonicalText: string,
  path: string,
): void {
  if (storedText !== canonicalText) {
    fail(path, "noncanonical_payload", "must contain the canonical payload representation.");
  }
}

function rowToEnvelope(raw: Readonly<Record<string, unknown>>): AggregateEnvelope {
  return storedRecord(() => {
    const row = raw as AggregateRow;
    const aggregateId = parsePersistedId(row.aggregate_id, "postgres.aggregate.aggregateId");
    const payloadText = rowString(row, "payload");
    const payload = parseJsonText(payloadText, "postgres.aggregate.payload");
    const checksum = parseChecksum(
      { algorithm: row.checksum_algorithm, hex: row.checksum_hex },
      "postgres.aggregate.checksum",
    );
    verifyChecksum(payloadText, checksum, { recordKind: "aggregate", recordId: aggregateId });
    const validated = validateCreateAggregateInput({
      aggregateType: parseAggregateType(row.aggregate_type, "postgres.aggregate.aggregateType"),
      aggregateId,
      schemaVersion: databaseInteger(row.schema_version, "postgres.aggregate.schemaVersion", 1, MAX_SCHEMA_VERSION),
      payload,
      traceId: nullablePersistedId(row.trace_id, "postgres.aggregate.traceId"),
    }, "postgres.aggregate");
    assertCanonicalStoredPayload(payloadText, validated.payloadText, "postgres.aggregate.payload");
    return Object.freeze({
      aggregateType: validated.aggregateType,
      aggregateId: validated.aggregateId,
      schemaVersion: validated.schemaVersion,
      aggregateVersion: databaseInteger(row.aggregate_version, "postgres.aggregate.aggregateVersion", 1, MAX_AGGREGATE_VERSION),
      payload,
      checksum,
      createdAt: ensureTimestamp(row.created_at, "postgres.aggregate.createdAt"),
      updatedAt: ensureTimestamp(row.updated_at, "postgres.aggregate.updatedAt"),
      traceId: validated.traceId,
    });
  });
}

function rowToEvent(raw: Readonly<Record<string, unknown>>): EventRecord {
  return storedRecord(() => {
    const row = raw as EventRow;
    const eventId = parsePersistedId(row.event_id, "postgres.event.eventId");
    const payloadText = rowString(row, "payload");
    const payload = parseJsonText(payloadText, "postgres.event.payload");
    const checksum = parseChecksum(
      { algorithm: row.checksum_algorithm, hex: row.checksum_hex },
      "postgres.event.checksum",
    );
    verifyChecksum(payloadText, checksum, { recordKind: "event", recordId: eventId });
    const validated = validateAppendEventInput({
      eventId,
      aggregateType: parseAggregateType(row.aggregate_type, "postgres.event.aggregateType"),
      aggregateId: parsePersistedId(row.aggregate_id, "postgres.event.aggregateId"),
      aggregateVersion: databaseInteger(row.aggregate_version, "postgres.event.aggregateVersion", 1, MAX_AGGREGATE_VERSION),
      eventType: row.event_type as string,
      eventSchemaVersion: databaseInteger(row.event_schema_version, "postgres.event.eventSchemaVersion", 1, MAX_SCHEMA_VERSION),
      payload,
      occurredAt: row.occurred_at as string,
      traceId: nullablePersistedId(row.trace_id, "postgres.event.traceId"),
      causationId: nullablePersistedId(row.causation_id, "postgres.event.causationId"),
    }, "postgres.event");
    assertCanonicalStoredPayload(payloadText, validated.payloadText, "postgres.event.payload");
    return Object.freeze({
      eventId: validated.eventId,
      aggregateType: validated.aggregateType,
      aggregateId: validated.aggregateId,
      aggregateVersion: validated.aggregateVersion,
      eventType: validated.eventType,
      eventSchemaVersion: validated.eventSchemaVersion,
      payload,
      checksum,
      occurredAt: validated.occurredAt,
      recordedAt: ensureTimestamp(row.recorded_at, "postgres.event.recordedAt"),
      globalSequence: databaseInteger(row.global_sequence, "postgres.event.globalSequence", 1, MAX_BIGINT),
      traceId: validated.traceId,
      causationId: validated.causationId,
    });
  });
}

function assertStoredOutboxState(message: OutboxMessage): void {
  const invalid = (reason: string): never =>
    fail("postgres.outbox.status", "invalid_stored_state", reason);
  if (message.status === "pending") {
    if (message.leaseOwner !== null || message.leaseExpiresAt !== null || message.acknowledgedAt !== null || message.deadLetteredAt !== null) {
      invalid("pending messages cannot retain lease or terminal fields.");
    }
    return;
  }
  if (message.status === "leased") {
    if (message.attemptCount < 1 || message.leaseOwner === null || message.leaseExpiresAt === null || message.acknowledgedAt !== null || message.deadLetteredAt !== null) {
      invalid("leased messages require one active lease and no terminal fields.");
    }
    return;
  }
  if (message.status === "acknowledged") {
    if (message.attemptCount < 1 || message.leaseOwner !== null || message.leaseExpiresAt !== null || message.acknowledgedAt === null || message.deadLetteredAt !== null) {
      invalid("acknowledged messages require acknowledgement evidence and no active lease.");
    }
    return;
  }
  if (message.attemptCount < 1 || message.leaseOwner !== null || message.leaseExpiresAt !== null || message.acknowledgedAt !== null || message.deadLetteredAt === null || message.lastFailureCategory === null) {
    invalid("dead-lettered messages require terminal failure evidence and no active lease.");
  }
}

function rowToOutbox(raw: Readonly<Record<string, unknown>>): OutboxMessage {
  return storedRecord(() => {
    const row = raw as OutboxRow;
    const messageId = parsePersistedId(row.message_id, "postgres.outbox.messageId");
    const payloadText = rowString(row, "payload");
    const payload = parseJsonText(payloadText, "postgres.outbox.payload");
    const checksum = parseChecksum(
      { algorithm: row.checksum_algorithm, hex: row.checksum_hex },
      "postgres.outbox.checksum",
    );
    verifyChecksum(payloadText, checksum, { recordKind: "outbox-message", recordId: messageId });
    const validated = validateEnqueueOutboxInput({
      messageId,
      topic: row.topic as string,
      schemaVersion: databaseInteger(row.schema_version, "postgres.outbox.schemaVersion", 1, MAX_SCHEMA_VERSION),
      payload,
      idempotencyKey: row.idempotency_key as string,
      availableAt: row.available_at as string,
      traceId: nullablePersistedId(row.trace_id, "postgres.outbox.traceId"),
    }, "postgres.outbox");
    assertCanonicalStoredPayload(payloadText, validated.payloadText, "postgres.outbox.payload");
    const message = Object.freeze({
      messageId: validated.messageId,
      topic: validated.topic,
      schemaVersion: validated.schemaVersion,
      payload,
      checksum,
      idempotencyKey: validated.idempotencyKey,
      status: ensureEnum(row.status, "postgres.outbox.status", OUTBOX_STATUSES),
      attemptCount: databaseInteger(row.attempt_count, "postgres.outbox.attemptCount", 0, MAX_BIGINT),
      createdAt: ensureTimestamp(row.created_at, "postgres.outbox.createdAt"),
      availableAt: validated.availableAt ?? fail(
        "postgres.outbox.availableAt",
        "invalid_stored_state",
        "stored messages must have an availability timestamp.",
      ),
      leaseOwner: nullablePersistedId(row.lease_owner, "postgres.outbox.leaseOwner"),
      leaseExpiresAt: nullableTimestamp(row.lease_expires_at, "postgres.outbox.leaseExpiresAt"),
      acknowledgedAt: nullableTimestamp(row.acknowledged_at, "postgres.outbox.acknowledgedAt"),
      deadLetteredAt: nullableTimestamp(row.dead_lettered_at, "postgres.outbox.deadLetteredAt"),
      lastFailureCategory: nullableFailureCategory(row.last_failure_category, "postgres.outbox.lastFailureCategory"),
      sequence: databaseInteger(row.sequence, "postgres.outbox.sequence", 1, MAX_BIGINT),
      traceId: validated.traceId,
    });
    assertStoredOutboxState(message);
    return message;
  });
}

function timeout<T>(promise: Promise<T>, milliseconds: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new PersistenceError("STORAGE_FAILURE", "A PostgreSQL operation exceeded its time bound.", {
        reason,
        retryable: true,
      }));
    }, milliseconds);
  });
  return Promise.race([promise, expired]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

function timeoutFailure(reason: string): PersistenceError {
  return new PersistenceError("STORAGE_FAILURE", "A PostgreSQL operation exceeded its time bound.", {
    reason,
    retryable: true,
  });
}

async function createAdapter(
  rawOptions: PostgresAdapterOptions,
  testing: PostgresTestingOptions = {},
): Promise<PersistenceAdapter> {
  let options: NormalizedOptions;
  try {
    options = normalizeOptions(rawOptions);
  } catch {
    throw new PersistenceError(
      "STORAGE_FAILURE",
      "The PostgreSQL adapter configuration is invalid.",
      { reason: "storage", retryable: false },
    );
  }
  const migrations = testing.migrations ?? POSTGRES_MIGRATIONS;
  void planMigrations(migrations, []);
  const pool = (testing.poolFactory ?? createDatabasePool)(options.poolConfiguration);
  let poolHealthy = true;
  pool.onError(() => {
    poolHealthy = false;
  });
  try {
    await applyPostgresMigrations(
      pool,
      options.schema,
      options.clock,
      migrations,
    );
  } catch (error) {
    try {
      await timeout(pool.end(), options.shutdownTimeoutMs, "shutdown-timeout");
    } catch {
      // The original finite migration/connection error remains authoritative.
    }
    throw storageFailure(error, "migration");
  }

  const mutex = new AsyncMutex();
  const guard = new TransactionGuard();
  const closedGate = new SessionGate("ADAPTER_CLOSED", "The persistence adapter is closed.");
  const schemaSql = quoteIdentifier(options.schema);
  const sequenceLockKey = sequenceCommitOrderKey(options.schema);

  function createContext(
    client: DatabaseClient,
    txGate: SessionGate,
    operations: Promise<unknown>[],
  ): TransactionContext {
    const run = <T>(
      operation: string,
      aggregateType: AggregateType | null,
      work: () => Promise<T>,
    ): Promise<T> => {
      txGate.assertActive();
      const operationPromise = observeOperation(
        options.observer,
        options.clock,
        operation,
        aggregateType,
        async () => {
          txGate.assertActive();
          return work();
        },
      );
      operations.push(operationPromise);
      void operationPromise.catch(() => undefined);
      return operationPromise;
    };

    const outboxForUpdate = async (messageId: string): Promise<OutboxMessage> => {
      const result = await query(
        client,
        "/*ados:outbox-lock*/ SELECT * FROM outbox WHERE message_id = $1 FOR UPDATE",
        [messageId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new PersistenceError("NOT_FOUND", "The outbox message does not exist.", { messageId });
      }
      return rowToOutbox(row);
    };

    const updateOutbox = async (message: OutboxMessage): Promise<OutboxMessage> => {
      const result = await query(
        client,
        `/*ados:outbox-update*/ UPDATE outbox SET status=$1, attempt_count=$2, available_at=$3,
           lease_owner=$4, lease_expires_at=$5, acknowledged_at=$6, dead_lettered_at=$7,
           last_failure_category=$8 WHERE message_id=$9 RETURNING *`,
        [
          message.status,
          message.attemptCount,
          message.availableAt,
          message.leaseOwner,
          message.leaseExpiresAt,
          message.acknowledgedAt,
          message.deadLetteredAt,
          message.lastFailureCategory,
          message.messageId,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new PersistenceError("NOT_FOUND", "The outbox message does not exist.", {
          messageId: message.messageId,
        });
      }
      return rowToOutbox(row);
    };

    const aggregates: AggregateStore = {
      create: (raw) =>
        run("aggregates.create", raw?.aggregateType ?? null, async () => {
          const input = validateCreateAggregateInput(raw);
          const nowIso = options.clock.now().toISOString();
          const inserted = await query(
            client,
            `/*ados:aggregate-create*/ INSERT INTO aggregates
              (aggregate_type, aggregate_id, schema_version, aggregate_version, payload,
               checksum_algorithm, checksum_hex, created_at, updated_at, trace_id)
             VALUES ($1,$2,$3,1,$4,$5,$6,$7,$7,$8)
             ON CONFLICT (aggregate_type, aggregate_id) DO NOTHING RETURNING *`,
            [
              input.aggregateType,
              input.aggregateId,
              input.schemaVersion,
              input.payloadText,
              input.checksum.algorithm,
              input.checksum.hex,
              nowIso,
              input.traceId,
            ],
          );
          const row = inserted.rows[0];
          if (row !== undefined) {
            return rowToEnvelope(row);
          }
          const existing = await query(
            client,
            "/*ados:aggregate-version*/ SELECT aggregate_version FROM aggregates WHERE aggregate_type=$1 AND aggregate_id=$2",
            [input.aggregateType, input.aggregateId],
          );
          throw new PersistenceError("CONCURRENCY_CONFLICT", "Cannot create an aggregate that already exists.", {
            aggregateType: input.aggregateType,
            aggregateId: input.aggregateId,
            actualVersion: databaseInteger(existing.rows[0]?.["aggregate_version"], "postgres.aggregate.actualVersion", 1, MAX_BIGINT),
          });
        }),

      update: (raw) =>
        run("aggregates.update", raw?.aggregateType ?? null, async () => {
          const input = validateUpdateAggregateInput(raw);
          const updated = await query(
            client,
            `/*ados:aggregate-update*/ UPDATE aggregates SET schema_version=$1,
               aggregate_version=$2, payload=$3, checksum_algorithm=$4, checksum_hex=$5,
               updated_at=$6, trace_id=$7
             WHERE aggregate_type=$8 AND aggregate_id=$9 AND aggregate_version=$10 RETURNING *`,
            [
              input.schemaVersion,
              input.expectedVersion + 1,
              input.payloadText,
              input.checksum.algorithm,
              input.checksum.hex,
              options.clock.now().toISOString(),
              input.traceId,
              input.aggregateType,
              input.aggregateId,
              input.expectedVersion,
            ],
          );
          const row = updated.rows[0];
          if (row !== undefined) {
            return rowToEnvelope(row);
          }
          const existing = await query(
            client,
            "/*ados:aggregate-version*/ SELECT aggregate_version FROM aggregates WHERE aggregate_type=$1 AND aggregate_id=$2",
            [input.aggregateType, input.aggregateId],
          );
          const existingRow = existing.rows[0];
          if (existingRow === undefined) {
            throw new PersistenceError("NOT_FOUND", "Cannot update a missing aggregate.", {
              aggregateType: input.aggregateType,
              aggregateId: input.aggregateId,
            });
          }
          throw new PersistenceError("CONCURRENCY_CONFLICT", "The aggregate was modified by another writer.", {
            aggregateType: input.aggregateType,
            aggregateId: input.aggregateId,
            expectedVersion: input.expectedVersion,
            actualVersion: databaseInteger(existingRow["aggregate_version"], "postgres.aggregate.actualVersion", 1, MAX_BIGINT),
          });
        }),

      get: (aggregateType, aggregateId) =>
        run("aggregates.get", aggregateType ?? null, async () => {
          const type = parseAggregateType(aggregateType);
          const id = parsePersistedId(aggregateId, "aggregateId");
          const result = await query(
            client,
            "/*ados:aggregate-get*/ SELECT * FROM aggregates WHERE aggregate_type=$1 AND aggregate_id=$2",
            [type, id],
          );
          return result.rows[0] === undefined ? null : rowToEnvelope(result.rows[0]);
        }),

      list: (raw) =>
        run("aggregates.list", raw?.aggregateType ?? null, async () => {
          const type = parseAggregateType(raw.aggregateType);
          const limit = normalizePageSize(raw.limit);
          const after = raw.cursor == null ? "" : decodeCursor(raw.cursor, "string-key").lastKey;
          const result = await query(
            client,
            "/*ados:aggregate-list*/ SELECT * FROM aggregates WHERE aggregate_type=$1 AND aggregate_id>$2 ORDER BY aggregate_id ASC LIMIT $3",
            [type, after, limit + 1],
          );
          return buildPage(result.rows.map(rowToEnvelope), limit, (item) => ({
            kind: "string-key",
            lastKey: item.aggregateId,
          }));
        }),
    };

    const events: EventStore = {
      append: (raw) =>
        run("events.append", raw?.aggregateType ?? null, async () => {
          const input = validateAppendEventInput(raw);
          await lockCommitOrderedSequence(client, sequenceLockKey);
          const inserted = await query(
            client,
            `/*ados:event-append*/ INSERT INTO events
              (event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
               event_schema_version, payload, checksum_algorithm, checksum_hex, occurred_at,
               recorded_at, trace_id, causation_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             ON CONFLICT (event_id) DO NOTHING RETURNING *`,
            [
              input.eventId,
              input.aggregateType,
              input.aggregateId,
              input.aggregateVersion,
              input.eventType,
              input.eventSchemaVersion,
              input.payloadText,
              input.checksum.algorithm,
              input.checksum.hex,
              input.occurredAt,
              options.clock.now().toISOString(),
              input.traceId,
              input.causationId,
            ],
          );
          const row = inserted.rows[0];
          if (row === undefined) {
            throw new PersistenceError("DUPLICATE_ID", "The event id was already recorded.", {
              eventId: input.eventId,
            });
          }
          return rowToEvent(row);
        }),

      list: (raw) =>
        run("events.list", raw?.aggregateType ?? null, async () => {
          const type = raw?.aggregateType === undefined ? null : parseAggregateType(raw.aggregateType);
          const id = raw?.aggregateId === undefined ? null : parsePersistedId(raw.aggregateId, "aggregateId");
          if (id !== null && type === null) {
            fail("events.list", "missing_aggregate_type", "aggregateType is required when filtering by aggregateId.");
          }
          const limit = normalizePageSize(raw?.limit);
          const after = raw?.cursor == null ? 0 : decodeCursor(raw.cursor, "sequence").lastSequence;
          const result =
            type !== null && id !== null
              ? await query(client, "/*ados:event-list-aggregate*/ SELECT * FROM events WHERE aggregate_type=$1 AND aggregate_id=$2 AND global_sequence>$3 ORDER BY global_sequence ASC LIMIT $4", [type, id, after, limit + 1])
              : type !== null
                ? await query(client, "/*ados:event-list-type*/ SELECT * FROM events WHERE aggregate_type=$1 AND global_sequence>$2 ORDER BY global_sequence ASC LIMIT $3", [type, after, limit + 1])
                : await query(client, "/*ados:event-list*/ SELECT * FROM events WHERE global_sequence>$1 ORDER BY global_sequence ASC LIMIT $2", [after, limit + 1]);
          return buildPage(result.rows.map(rowToEvent), limit, (item) => ({
            kind: "sequence",
            lastSequence: item.globalSequence,
          }));
        }),
    };

    const outbox: OutboxStore = {
      enqueue: (raw) =>
        run("outbox.enqueue", null, async () => {
          const input = validateEnqueueOutboxInput(raw);
          const nowIso = options.clock.now().toISOString();
          await lockCommitOrderedSequence(client, sequenceLockKey);
          const inserted = await query(
            client,
            `/*ados:outbox-enqueue*/ INSERT INTO outbox
              (message_id, topic, schema_version, payload, checksum_algorithm, checksum_hex,
               idempotency_key, status, attempt_count, created_at, available_at, trace_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',0,$8,$9,$10)
             ON CONFLICT DO NOTHING RETURNING *`,
            [
              input.messageId,
              input.topic,
              input.schemaVersion,
              input.payloadText,
              input.checksum.algorithm,
              input.checksum.hex,
              input.idempotencyKey,
              nowIso,
              input.availableAt ?? nowIso,
              input.traceId,
            ],
          );
          const row = inserted.rows[0];
          if (row !== undefined) {
            return rowToOutbox(row);
          }
          const byId = await query(client, "/*ados:outbox-get*/ SELECT * FROM outbox WHERE message_id=$1", [input.messageId]);
          if (byId.rows[0] !== undefined) {
            throw new PersistenceError("DUPLICATE_ID", "The outbox message id already exists.", {
              messageId: input.messageId,
            });
          }
          throw new PersistenceError("DUPLICATE_IDEMPOTENCY_KEY", "The idempotency key was already used by another outbox message.", {
            idempotencyKey: input.idempotencyKey,
          });
        }),

      claim: (raw) =>
        run("outbox.claim", null, async () => {
          const input = validateClaimOutboxInput(raw);
          const now = options.clock.now();
          const nowIso = now.toISOString();
          const expiresAt = leaseExpiry(now, input.leaseDurationMs);
          const selected = await query(
            client,
            `/*ados:outbox-claim*/ SELECT * FROM outbox
             WHERE (status='pending' AND available_at<=$1)
                OR (status='leased' AND lease_expires_at IS NOT NULL AND lease_expires_at<=$1)
             ORDER BY sequence ASC FOR UPDATE SKIP LOCKED LIMIT $2`,
            [nowIso, input.limit],
          );
          const claimed: OutboxMessage[] = [];
          for (const row of selected.rows) {
            const next = applyClaim(rowToOutbox(row), { owner: input.owner, leaseExpiresAt: expiresAt });
            claimed.push(await updateOutbox(next));
          }
          return Object.freeze(claimed);
        }),

      acknowledge: (raw) =>
        run("outbox.acknowledge", null, async () => {
          const messageId = parsePersistedId(raw.messageId, "acknowledge.messageId");
          const result = applyAcknowledge(await outboxForUpdate(messageId), {
            owner: raw.owner,
            nowIso: options.clock.now().toISOString(),
          });
          return result.changed ? updateOutbox(result.message) : result.message;
        }),

      scheduleRetry: (raw) =>
        run("outbox.scheduleRetry", null, async () => {
          const messageId = parsePersistedId(raw.messageId, "scheduleRetry.messageId");
          return updateOutbox(
            applyScheduleRetry(await outboxForUpdate(messageId), {
              owner: raw.owner,
              retryAt: raw.retryAt,
              failureCategory: raw.failureCategory ?? null,
            }),
          );
        }),

      deadLetter: (raw) =>
        run("outbox.deadLetter", null, async () => {
          const messageId = parsePersistedId(raw.messageId, "deadLetter.messageId");
          return updateOutbox(
            applyDeadLetter(await outboxForUpdate(messageId), {
              owner: raw.owner,
              failureCategory: raw.failureCategory,
              nowIso: options.clock.now().toISOString(),
            }),
          );
        }),

      get: (messageId) =>
        run("outbox.get", null, async () => {
          const id = parsePersistedId(messageId, "messageId");
          const result = await query(client, "/*ados:outbox-get*/ SELECT * FROM outbox WHERE message_id=$1", [id]);
          return result.rows[0] === undefined ? null : rowToOutbox(result.rows[0]);
        }),

      list: (raw) =>
        run("outbox.list", null, async () => {
          const status = raw?.status === undefined ? null : ensureEnum(raw.status, "outbox.list.status", OUTBOX_STATUSES);
          const limit = normalizePageSize(raw?.limit);
          const after = raw?.cursor == null ? 0 : decodeCursor(raw.cursor, "sequence").lastSequence;
          const result = status === null
            ? await query(client, "/*ados:outbox-list*/ SELECT * FROM outbox WHERE sequence>$1 ORDER BY sequence ASC LIMIT $2", [after, limit + 1])
            : await query(client, "/*ados:outbox-list-status*/ SELECT * FROM outbox WHERE status=$1 AND sequence>$2 ORDER BY sequence ASC LIMIT $3", [status, after, limit + 1]);
          return buildPage(result.rows.map(rowToOutbox), limit, (item) => ({
            kind: "sequence",
            lastSequence: item.sequence,
          }));
        }),
    };

    const readArtifact = async <T>(
      table: "artifacts" | "artifact_manifests",
      idColumn: "artifact_id" | "manifest_id",
      id: string,
      kind: string,
      parse: (input: unknown) => T,
      identity: (value: T) => string,
    ): Promise<T | null> => {
      const result = await query(client, `/*ados:artifact-get*/ SELECT payload, checksum_algorithm, checksum_hex FROM ${table} WHERE ${idColumn}=$1`, [id]);
      const raw = result.rows[0];
      if (raw === undefined) {
        return null;
      }
      return storedRecord(() => {
        const row = raw as ArtifactRow;
        const payload = rowString(row, "payload");
        const checksum = parseChecksum({ algorithm: row.checksum_algorithm, hex: row.checksum_hex }, `${kind}.checksum`);
        verifyChecksum(payload, checksum, { recordKind: kind, recordId: id });
        const parsed = parse(parseJsonText(payload, kind));
        if (identity(parsed) !== id) {
          fail(kind, "stored_identity_mismatch", "stored identity must match its row key.");
        }
        assertCanonicalStoredPayload(payload, preparePayload(parsed, kind).text, kind);
        return parsed;
      });
    };

    const artifacts: ArtifactMetadataStore = {
      putDescriptor: (raw) =>
        run("artifacts.putDescriptor", null, async () => {
          const descriptor: ArtifactDescriptor = parseArtifactDescriptor(raw);
          const prepared = preparePayload(descriptor, "artifactDescriptor");
          const inserted = await query(
            client,
            "/*ados:artifact-put*/ INSERT INTO artifacts (artifact_id,payload,checksum_algorithm,checksum_hex) VALUES ($1,$2,$3,$4) ON CONFLICT (artifact_id) DO NOTHING RETURNING artifact_id",
            [descriptor.id, prepared.text, prepared.checksum.algorithm, prepared.checksum.hex],
          );
          if (inserted.rows[0] === undefined) {
            throw new PersistenceError("DUPLICATE_ID", "The artifact id already exists.", { artifactId: descriptor.id });
          }
          return descriptor;
        }),

      getDescriptor: (artifactId) =>
        run("artifacts.getDescriptor", null, async () => {
          const id = parsePersistedId(artifactId, "artifactId");
          return readArtifact("artifacts", "artifact_id", id, "artifact-descriptor", parseArtifactDescriptor, (value) => value.id);
        }),

      listDescriptors: (raw) =>
        run("artifacts.listDescriptors", null, async () => {
          const limit = normalizePageSize(raw?.limit);
          const after = raw?.cursor == null ? "" : decodeCursor(raw.cursor, "string-key").lastKey;
          const result = await query(client, "/*ados:artifact-list*/ SELECT artifact_id,payload,checksum_algorithm,checksum_hex FROM artifacts WHERE artifact_id>$1 ORDER BY artifact_id ASC LIMIT $2", [after, limit + 1]);
          const items = result.rows.map((rawRow) =>
            storedRecord(() => {
              const row = rawRow as ArtifactRow & { readonly artifact_id: unknown };
              const id = parsePersistedId(row.artifact_id, "artifact.id");
              const payload = rowString(row, "payload");
              const checksum = parseChecksum({ algorithm: row.checksum_algorithm, hex: row.checksum_hex }, "artifact-descriptor.checksum");
              verifyChecksum(payload, checksum, { recordKind: "artifact-descriptor", recordId: id });
              const descriptor = parseArtifactDescriptor(parseJsonText(payload, "artifact-descriptor"));
              if (descriptor.id !== id) {
                fail("artifact-descriptor", "stored_identity_mismatch", "stored identity must match its row key.");
              }
              assertCanonicalStoredPayload(
                payload,
                preparePayload(descriptor, "artifact-descriptor").text,
                "artifact-descriptor",
              );
              return descriptor;
            }),
          );
          return buildPage(items, limit, (item) => ({ kind: "string-key", lastKey: item.id }));
        }),

      putManifest: (raw) =>
        run("artifacts.putManifest", null, async () => {
          const manifest: ArtifactManifest = parseArtifactManifest(raw);
          const prepared = preparePayload(manifest, "artifactManifest");
          const inserted = await query(
            client,
            "/*ados:manifest-put*/ INSERT INTO artifact_manifests (manifest_id,payload,checksum_algorithm,checksum_hex) VALUES ($1,$2,$3,$4) ON CONFLICT (manifest_id) DO NOTHING RETURNING manifest_id",
            [manifest.manifestId, prepared.text, prepared.checksum.algorithm, prepared.checksum.hex],
          );
          if (inserted.rows[0] === undefined) {
            throw new PersistenceError("DUPLICATE_ID", "The manifest id already exists.", { manifestId: manifest.manifestId });
          }
          return manifest;
        }),

      getManifest: (manifestId) =>
        run("artifacts.getManifest", null, async () => {
          const id = parsePersistedId(manifestId, "manifestId");
          return readArtifact("artifact_manifests", "manifest_id", id, "artifact-manifest", parseArtifactManifest, (value) => value.manifestId);
        }),
    };

    return Object.freeze({ aggregates, events, outbox, artifacts });
  }

  return Object.freeze({
    async transact<T>(work: (tx: TransactionContext) => Promise<T> | T): Promise<T> {
      guard.assertNotNested();
      return mutex.run(async () => {
        closedGate.assertActive();
        if (!poolHealthy) {
          throw storageFailure({ code: "08006" });
        }
        let client: DatabaseClient;
        try {
          client = await pool.connect();
        } catch (error) {
          throw storageFailure(error, "connection");
        }
        let destroy = false;
        const txGate = new SessionGate("TRANSACTION_COMPLETED", "The transaction has already completed.");
        const operations: Promise<unknown>[] = [];
        const deadline = performance.now() + options.transactionTimeoutMs;
        const withinTransactionDeadline = <U>(work: () => Promise<U>): Promise<U> => {
          const remaining = Math.ceil(deadline - performance.now());
          return remaining <= 0
            ? Promise.reject(timeoutFailure("transaction-timeout"))
            : timeout(work(), remaining, "transaction-timeout");
        };
        try {
          await withinTransactionDeadline(() => query(client, "BEGIN ISOLATION LEVEL SERIALIZABLE"));
          await withinTransactionDeadline(() => query(client, `SET LOCAL search_path TO ${schemaSql}, pg_catalog`));
          const context = createContext(client, txGate, operations);
          const result = await withinTransactionDeadline(() => {
            const callback = guard.run(async () => await work(context));
            void callback.catch(() => undefined);
            return callback;
          });
          txGate.close();
          let checked = 0;
          while (checked < operations.length) {
            const batch = operations.slice(checked);
            checked = operations.length;
            await withinTransactionDeadline(() => Promise.allSettled(batch));
          }
          // Callback resolution is the public commit decision. A caught local
          // store rejection may be recoverable, but a driver error leaves the
          // PostgreSQL transaction aborted; this probe distinguishes the two.
          await withinTransactionDeadline(() => query(client, "/*ados:transaction-probe*/ SELECT 1"));
          await withinTransactionDeadline(() => query(client, "COMMIT"));
          client.release();
          return result;
        } catch (error) {
          txGate.close();
          try {
            await timeout(
              client.query("ROLLBACK"),
              Math.min(options.transactionTimeoutMs, options.poolConfiguration.queryTimeoutMs),
              "rollback-timeout",
            );
          } catch {
            destroy = true;
          }
          client.release(destroy);
          throw error;
        }
      });
    },

    async migrationStatus(): Promise<MigrationStatus> {
      return mutex.run(async () => {
        closedGate.assertActive();
        try {
          return await readMigrationStatus(pool, options.schema, migrations);
        } catch (error) {
          throw storageFailure(error, "migration");
        }
      });
    },

    async close(): Promise<void> {
      await mutex.run(async () => {
        if (!closedGate.active) {
          return;
        }
        closedGate.close();
        try {
          await timeout(pool.end(), options.shutdownTimeoutMs, "shutdown-timeout");
        } catch (error) {
          throw storageFailure(error, "shutdown");
        }
      });
    },
  });
}

export async function createPostgresPersistenceAdapter(
  options: PostgresAdapterOptions,
): Promise<PersistenceAdapter> {
  return createAdapter(options);
}

export async function createPostgresPersistenceAdapterForTesting(
  options: PostgresAdapterOptions,
  testing: PostgresTestingOptions,
): Promise<PersistenceAdapter> {
  return createAdapter(options, testing);
}

export { POSTGRES_MIGRATIONS };

export const postgresAdapterTesting = Object.freeze({
  normalizeOptions,
  rowToEnvelope,
  rowToEvent,
  rowToOutbox,
  safeSqlState,
  storageFailure,
});
