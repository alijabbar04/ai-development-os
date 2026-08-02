import { statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
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
  parseChecksum,
  parsePersistedId,
  planMigrations,
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
  type MigrationStatus,
  type OutboxMessage,
  type OutboxStatus,
  type OutboxStore,
  type PersistenceAdapter,
  type PersistenceObserver,
  type TransactionContext,
} from "@ai-dev-os/persistence";
import { openSqliteDatabase, type SqliteDatabase, type SqliteStatement } from "./driver.js";
import {
  SQLITE_MIGRATIONS,
  applyMigrations,
  
  readAppliedMigrations,
  readSqliteCode,
} from "./migrations.js";

const { ensureEnum, ensureSafeInteger, fail } = validation;

export interface SqliteAdapterOptions extends AdapterOptions {
  /** Absolute path of the database file. Mutually exclusive with `memory`. */
  readonly file?: string;
  /** Use a private in-memory database. Mutually exclusive with `file`. */
  readonly memory?: boolean;
  /** PRAGMA busy_timeout in milliseconds. Default 5000. */
  readonly busyTimeoutMs?: number;
  /**
   * Journal mode for file-backed databases. Default "wal": write-ahead
   * logging with synchronous=NORMAL, the standard durable desktop
   * configuration (a power loss may roll back the most recent commits but
   * never corrupts the database). Choose "delete" with synchronous=FULL for
   * strict commit-by-commit durability at lower write throughput.
   */
  readonly journalMode?: "wal" | "delete";
}

/** Translates a driver failure into a stable persistence error (never SQL text). */
function storageFailure(error: unknown): PersistenceError {
  if (error instanceof PersistenceError) {
    return error;
  }
  return new PersistenceError("STORAGE_FAILURE", "A SQLite operation failed.", {
    sqliteCode: readSqliteCode(error),
  });
}

function resolveLocation(options: SqliteAdapterOptions): string {
  if (options.memory === true) {
    if (options.file !== undefined) {
      fail("sqlite.options", "ambiguous_location", "specify either file or memory, not both.");
    }
    return ":memory:";
  }
  const file =
    options.file ??
    fail("sqlite.options", "missing_location", "specify a database file path or memory: true.");
  if (
    typeof file !== "string" ||
    file.length === 0 ||
    file.length > 1_024 ||
    file.includes("\u0000")
  ) {
    fail("sqlite.options.file", "bad_path", "must be a non-empty path without NUL characters.");
  }
  if (file.startsWith("file:")) {
    fail("sqlite.options.file", "uri_path", "URI filenames are not supported; pass a plain path.");
  }
  if (!isAbsolute(file)) {
    fail("sqlite.options.file", "relative_path", "must be an absolute path.");
  }
  try {
    if (!statSync(dirname(file)).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new PersistenceError(
      "STORAGE_FAILURE",
      "The parent directory of the database file does not exist.",
      { reason: "parent-directory-missing" },
    );
  }
  return file;
}

interface AggregateRow {
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly schema_version: number;
  readonly aggregate_version: number;
  readonly payload: string;
  readonly checksum_algorithm: string;
  readonly checksum_hex: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly trace_id: string | null;
}

interface EventRow {
  readonly event_id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_version: number;
  readonly event_type: string;
  readonly event_schema_version: number;
  readonly payload: string;
  readonly checksum_algorithm: string;
  readonly checksum_hex: string;
  readonly occurred_at: string;
  readonly recorded_at: string;
  readonly global_sequence: number;
  readonly trace_id: string | null;
  readonly causation_id: string | null;
}

interface OutboxRow {
  readonly message_id: string;
  readonly topic: string;
  readonly schema_version: number;
  readonly payload: string;
  readonly checksum_algorithm: string;
  readonly checksum_hex: string;
  readonly idempotency_key: string;
  readonly status: string;
  readonly attempt_count: number;
  readonly created_at: string;
  readonly available_at: string;
  readonly lease_owner: string | null;
  readonly lease_expires_at: string | null;
  readonly acknowledged_at: string | null;
  readonly dead_lettered_at: string | null;
  readonly last_failure_category: string | null;
  readonly sequence: number;
  readonly trace_id: string | null;
}

interface ArtifactRow {
  readonly payload: string;
  readonly checksum_algorithm: string;
  readonly checksum_hex: string;
}

function rowToEnvelope(row: AggregateRow): AggregateEnvelope {
  const checksum = parseChecksum(
    { algorithm: row.checksum_algorithm, hex: row.checksum_hex },
    "aggregate.checksum",
  );
  verifyChecksum(row.payload, checksum, {
    recordKind: "aggregate",
    recordId: row.aggregate_id,
  });
  return Object.freeze({
    aggregateType: row.aggregate_type as AggregateType,
    aggregateId: row.aggregate_id,
    schemaVersion: row.schema_version,
    aggregateVersion: row.aggregate_version,
    payload: parseJsonText(row.payload, "aggregate.payload"),
    checksum,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    traceId: row.trace_id,
  });
}

function rowToEventRecord(row: EventRow): EventRecord {
  const checksum = parseChecksum(
    { algorithm: row.checksum_algorithm, hex: row.checksum_hex },
    "event.checksum",
  );
  verifyChecksum(row.payload, checksum, { recordKind: "event", recordId: row.event_id });
  return Object.freeze({
    eventId: row.event_id,
    aggregateType: row.aggregate_type as AggregateType,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    eventType: row.event_type,
    eventSchemaVersion: row.event_schema_version,
    payload: parseJsonText(row.payload, "event.payload"),
    checksum,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    globalSequence: row.global_sequence,
    traceId: row.trace_id,
    causationId: row.causation_id,
  });
}

function rowToOutboxMessage(row: OutboxRow): OutboxMessage {
  const checksum = parseChecksum(
    { algorithm: row.checksum_algorithm, hex: row.checksum_hex },
    "outbox.checksum",
  );
  verifyChecksum(row.payload, checksum, {
    recordKind: "outbox-message",
    recordId: row.message_id,
  });
  return Object.freeze({
    messageId: row.message_id,
    topic: row.topic,
    schemaVersion: row.schema_version,
    payload: parseJsonText(row.payload, "outbox.payload"),
    checksum,
    idempotencyKey: row.idempotency_key,
    status: row.status as OutboxStatus,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    acknowledgedAt: row.acknowledged_at,
    deadLetteredAt: row.dead_lettered_at,
    lastFailureCategory: row.last_failure_category,
    sequence: row.sequence,
    traceId: row.trace_id,
  });
}

export function createSqlitePersistenceAdapter(
  options: SqliteAdapterOptions,
): PersistenceAdapter {
  const clock: Clock = options.clock ?? systemClock;
  const observer: PersistenceObserver | undefined = options.observer;
  const busyTimeoutMs = ensureSafeInteger(
    options.busyTimeoutMs ?? 5_000,
    "sqlite.options.busyTimeoutMs",
    0,
    600_000,
  );
  const journalMode =
    options.journalMode === undefined
      ? "wal"
      : ensureEnum(options.journalMode, "sqlite.options.journalMode", ["delete", "wal"] as const);
  const location = resolveLocation(options);
  const isMemory = location === ":memory:";

  let db: SqliteDatabase;
  try {
    db = openSqliteDatabase(location);
  } catch (error) {
    throw storageFailure(error);
  }

  try {
    db.pragma("foreign_keys = ON");
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    if (!isMemory) {
      db.pragma(`journal_mode = ${journalMode}`);
      db.pragma(journalMode === "wal" ? "synchronous = NORMAL" : "synchronous = FULL");
    }
    applyMigrations(db, SQLITE_MIGRATIONS, clock);
  } catch (error) {
    db.close();
    throw storageFailure(error);
  }

  const sql = <T>(work: () => T): T => {
    try {
      return work();
    } catch (error) {
      throw storageFailure(error);
    }
  };

  const statements = sql(() => ({
    aggregateGet: db.prepare(
      "SELECT * FROM aggregates WHERE aggregate_type = ? AND aggregate_id = ?",
    ),
    aggregateInsert: db.prepare(
      `INSERT INTO aggregates (aggregate_type, aggregate_id, schema_version, aggregate_version,
         payload, checksum_algorithm, checksum_hex, created_at, updated_at, trace_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    aggregateUpdate: db.prepare(
      `UPDATE aggregates SET schema_version = ?, aggregate_version = ?, payload = ?,
         checksum_algorithm = ?, checksum_hex = ?, updated_at = ?, trace_id = ?
       WHERE aggregate_type = ? AND aggregate_id = ?`,
    ),
    aggregateList: db.prepare(
      `SELECT * FROM aggregates WHERE aggregate_type = ? AND aggregate_id > ?
       ORDER BY aggregate_id ASC LIMIT ?`,
    ),
    eventExists: db.prepare("SELECT 1 FROM events WHERE event_id = ?"),
    eventMaxSequence: db.prepare(
      "SELECT COALESCE(MAX(global_sequence), 0) AS max_sequence FROM events",
    ),
    eventInsert: db.prepare(
      `INSERT INTO events (event_id, aggregate_type, aggregate_id, aggregate_version,
         event_type, event_schema_version, payload, checksum_algorithm, checksum_hex,
         occurred_at, recorded_at, global_sequence, trace_id, causation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    eventListAll: db.prepare(
      "SELECT * FROM events WHERE global_sequence > ? ORDER BY global_sequence ASC LIMIT ?",
    ),
    eventListByType: db.prepare(
      `SELECT * FROM events WHERE aggregate_type = ? AND global_sequence > ?
       ORDER BY global_sequence ASC LIMIT ?`,
    ),
    eventListByAggregate: db.prepare(
      `SELECT * FROM events WHERE aggregate_type = ? AND aggregate_id = ? AND global_sequence > ?
       ORDER BY global_sequence ASC LIMIT ?`,
    ),
    outboxGet: db.prepare("SELECT * FROM outbox WHERE message_id = ?"),
    outboxByIdempotencyKey: db.prepare(
      "SELECT message_id FROM outbox WHERE idempotency_key = ?",
    ),
    outboxMaxSequence: db.prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM outbox",
    ),
    outboxInsert: db.prepare(
      `INSERT INTO outbox (message_id, topic, schema_version, payload, checksum_algorithm,
         checksum_hex, idempotency_key, status, attempt_count, created_at, available_at,
         lease_owner, lease_expires_at, acknowledged_at, dead_lettered_at,
         last_failure_category, sequence, trace_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    outboxUpdateState: db.prepare(
      `UPDATE outbox SET status = ?, attempt_count = ?, available_at = ?, lease_owner = ?,
         lease_expires_at = ?, acknowledged_at = ?, dead_lettered_at = ?,
         last_failure_category = ?
       WHERE message_id = ?`,
    ),
    outboxClaimable: db.prepare(
      `SELECT * FROM outbox
       WHERE (status = 'pending' AND available_at <= ?)
          OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
       ORDER BY sequence ASC LIMIT ?`,
    ),
    outboxListAll: db.prepare(
      "SELECT * FROM outbox WHERE sequence > ? ORDER BY sequence ASC LIMIT ?",
    ),
    outboxListByStatus: db.prepare(
      "SELECT * FROM outbox WHERE status = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?",
    ),
    artifactGet: db.prepare(
      "SELECT payload, checksum_algorithm, checksum_hex FROM artifacts WHERE artifact_id = ?",
    ),
    artifactInsert: db.prepare(
      "INSERT INTO artifacts (artifact_id, payload, checksum_algorithm, checksum_hex) VALUES (?, ?, ?, ?)",
    ),
    artifactList: db.prepare(
      `SELECT artifact_id, payload, checksum_algorithm, checksum_hex FROM artifacts
       WHERE artifact_id > ? ORDER BY artifact_id ASC LIMIT ?`,
    ),
    manifestGet: db.prepare(
      "SELECT payload, checksum_algorithm, checksum_hex FROM artifact_manifests WHERE manifest_id = ?",
    ),
    manifestInsert: db.prepare(
      "INSERT INTO artifact_manifests (manifest_id, payload, checksum_algorithm, checksum_hex) VALUES (?, ?, ?, ?)",
    ),
    artifactExists: db.prepare("SELECT 1 FROM artifacts WHERE artifact_id = ?"),
    manifestExists: db.prepare("SELECT 1 FROM artifact_manifests WHERE manifest_id = ?"),
  }));

  const mutex = new AsyncMutex();
  const guard = new TransactionGuard();
  const closedGate = new SessionGate("ADAPTER_CLOSED", "The persistence adapter is closed.");

  function createContext(txGate: SessionGate): TransactionContext {
    const run = <T>(
      operation: string,
      aggregateType: AggregateType | null,
      work: () => T,
    ): Promise<T> =>
      observeOperation(observer, clock, operation, aggregateType, () => {
        txGate.assertActive();
        return work();
      });

    const readOutboxRow = (messageId: string): OutboxRow => {
      const row = sql(() => statements.outboxGet.get(messageId)) as OutboxRow | undefined;
      if (row === undefined) {
        throw new PersistenceError("NOT_FOUND", "The outbox message does not exist.", {
          messageId,
        });
      }
      return row;
    };

    const writeOutboxMessage = (message: OutboxMessage): void => {
      sql(() =>
        statements.outboxUpdateState.run(
          message.status,
          message.attemptCount,
          message.availableAt,
          message.leaseOwner,
          message.leaseExpiresAt,
          message.acknowledgedAt,
          message.deadLetteredAt,
          message.lastFailureCategory,
          message.messageId,
        ),
      );
    };

    const aggregates: AggregateStore = {
      create: (raw) =>
        run("aggregates.create", raw?.aggregateType ?? null, () => {
          const input = validateCreateAggregateInput(raw);
          const existing = sql(() =>
            statements.aggregateGet.get(input.aggregateType, input.aggregateId),
          ) as AggregateRow | undefined;
          if (existing !== undefined) {
            throw new PersistenceError(
              "CONCURRENCY_CONFLICT",
              "Cannot create an aggregate that already exists.",
              {
                aggregateType: input.aggregateType,
                aggregateId: input.aggregateId,
                actualVersion: existing.aggregate_version,
              },
            );
          }
          const nowIso = clock.now().toISOString();
          sql(() =>
            statements.aggregateInsert.run(
              input.aggregateType,
              input.aggregateId,
              input.schemaVersion,
              1,
              input.payloadText,
              input.checksum.algorithm,
              input.checksum.hex,
              nowIso,
              nowIso,
              input.traceId,
            ),
          );
          return rowToEnvelope(
            sql(() => statements.aggregateGet.get(input.aggregateType, input.aggregateId)) as AggregateRow,
          );
        }),

      update: (raw) =>
        run("aggregates.update", raw?.aggregateType ?? null, () => {
          const input = validateUpdateAggregateInput(raw);
          const existing = sql(() =>
            statements.aggregateGet.get(input.aggregateType, input.aggregateId),
          ) as AggregateRow | undefined;
          if (existing === undefined) {
            throw new PersistenceError("NOT_FOUND", "Cannot update a missing aggregate.", {
              aggregateType: input.aggregateType,
              aggregateId: input.aggregateId,
            });
          }
          if (existing.aggregate_version !== input.expectedVersion) {
            throw new PersistenceError(
              "CONCURRENCY_CONFLICT",
              "The aggregate was modified by another writer.",
              {
                aggregateType: input.aggregateType,
                aggregateId: input.aggregateId,
                expectedVersion: input.expectedVersion,
                actualVersion: existing.aggregate_version,
              },
            );
          }
          sql(() =>
            statements.aggregateUpdate.run(
              input.schemaVersion,
              input.expectedVersion + 1,
              input.payloadText,
              input.checksum.algorithm,
              input.checksum.hex,
              clock.now().toISOString(),
              input.traceId,
              input.aggregateType,
              input.aggregateId,
            ),
          );
          return rowToEnvelope(
            sql(() => statements.aggregateGet.get(input.aggregateType, input.aggregateId)) as AggregateRow,
          );
        }),

      get: (aggregateType, aggregateId) =>
        run("aggregates.get", aggregateType ?? null, () => {
          const type = parseAggregateType(aggregateType);
          const id = parsePersistedId(aggregateId, "aggregateId");
          const row = sql(() => statements.aggregateGet.get(type, id)) as AggregateRow | undefined;
          return row === undefined ? null : rowToEnvelope(row);
        }),

      list: (query) =>
        run("aggregates.list", query?.aggregateType ?? null, () => {
          const type = parseAggregateType(query.aggregateType);
          const limit = normalizePageSize(query.limit);
          const after =
            query.cursor === undefined || query.cursor === null
              ? ""
              : decodeCursor(query.cursor, "string-key").lastKey;
          const rows = sql(() =>
            statements.aggregateList.all(type, after, limit + 1),
          ) as AggregateRow[];
          return buildPage(rows.map(rowToEnvelope), limit, (item) => ({
            kind: "string-key",
            lastKey: item.aggregateId,
          }));
        }),
    };

    const events: EventStore = {
      append: (raw) =>
        run("events.append", raw?.aggregateType ?? null, () => {
          const input = validateAppendEventInput(raw);
          const exists = sql(() => statements.eventExists.get(input.eventId)) !== undefined;
          if (exists) {
            throw new PersistenceError("DUPLICATE_ID", "The event id was already recorded.", {
              eventId: input.eventId,
            });
          }
          const maxRow = sql(() => statements.eventMaxSequence.get()) as {
            readonly max_sequence: number;
          };
          const globalSequence = maxRow.max_sequence + 1;
          const recordedAt = clock.now().toISOString();
          sql(() =>
            statements.eventInsert.run(
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
              recordedAt,
              globalSequence,
              input.traceId,
              input.causationId,
            ),
          );
          return rowToEventRecord(
            sql(() =>
              statements.eventListByAggregate.get(
                input.aggregateType,
                input.aggregateId,
                globalSequence - 1,
                1,
              ),
            ) as EventRow,
          );
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
            fail(
              "events.list",
              "missing_aggregate_type",
              "aggregateType is required when filtering by aggregateId.",
            );
          }
          const limit = normalizePageSize(query?.limit);
          const after =
            query?.cursor === undefined || query.cursor === null
              ? 0
              : decodeCursor(query.cursor, "sequence").lastSequence;
          const rows = sql(() => {
            if (type !== null && id !== null) {
              return statements.eventListByAggregate.all(type, id, after, limit + 1);
            }
            if (type !== null) {
              return statements.eventListByType.all(type, after, limit + 1);
            }
            return statements.eventListAll.all(after, limit + 1);
          }) as EventRow[];
          return buildPage(rows.map(rowToEventRecord), limit, (item) => ({
            kind: "sequence",
            lastSequence: item.globalSequence,
          }));
        }),
    };

    const outbox: OutboxStore = {
      enqueue: (raw) =>
        run("outbox.enqueue", null, () => {
          const input = validateEnqueueOutboxInput(raw);
          if (sql(() => statements.outboxGet.get(input.messageId)) !== undefined) {
            throw new PersistenceError("DUPLICATE_ID", "The outbox message id already exists.", {
              messageId: input.messageId,
            });
          }
          if (sql(() => statements.outboxByIdempotencyKey.get(input.idempotencyKey)) !== undefined) {
            throw new PersistenceError(
              "DUPLICATE_IDEMPOTENCY_KEY",
              "The idempotency key was already used by another outbox message.",
              { idempotencyKey: input.idempotencyKey },
            );
          }
          const nowIso = clock.now().toISOString();
          const maxRow = sql(() => statements.outboxMaxSequence.get()) as {
            readonly max_sequence: number;
          };
          sql(() =>
            statements.outboxInsert.run(
              input.messageId,
              input.topic,
              input.schemaVersion,
              input.payloadText,
              input.checksum.algorithm,
              input.checksum.hex,
              input.idempotencyKey,
              "pending",
              0,
              nowIso,
              input.availableAt ?? nowIso,
              null,
              null,
              null,
              null,
              null,
              maxRow.max_sequence + 1,
              input.traceId,
            ),
          );
          return rowToOutboxMessage(readOutboxRow(input.messageId));
        }),

      claim: (raw) =>
        run("outbox.claim", null, () => {
          const input = validateClaimOutboxInput(raw);
          const now = clock.now();
          const nowIso = now.toISOString();
          const expiresAt = leaseExpiry(now, input.leaseDurationMs);
          const rows = sql(() =>
            statements.outboxClaimable.all(nowIso, nowIso, input.limit),
          ) as OutboxRow[];
          const claimed: OutboxMessage[] = [];
          for (const row of rows) {
            const message = rowToOutboxMessage(row);
            if (!isClaimable(message, nowIso)) {
              continue;
            }
            const next = applyClaim(message, { owner: input.owner, leaseExpiresAt: expiresAt });
            writeOutboxMessage(next);
            claimed.push(next);
          }
          return Object.freeze(claimed);
        }),

      acknowledge: (raw) =>
        run("outbox.acknowledge", null, () => {
          const messageId = parsePersistedId(raw.messageId, "acknowledge.messageId");
          const message = rowToOutboxMessage(readOutboxRow(messageId));
          const result = applyAcknowledge(message, {
            owner: raw.owner,
            nowIso: clock.now().toISOString(),
          });
          if (result.changed) {
            writeOutboxMessage(result.message);
          }
          return result.message;
        }),

      scheduleRetry: (raw) =>
        run("outbox.scheduleRetry", null, () => {
          const messageId = parsePersistedId(raw.messageId, "scheduleRetry.messageId");
          const next = applyScheduleRetry(rowToOutboxMessage(readOutboxRow(messageId)), {
            owner: raw.owner,
            retryAt: raw.retryAt,
            failureCategory: raw.failureCategory ?? null,
          });
          writeOutboxMessage(next);
          return next;
        }),

      deadLetter: (raw) =>
        run("outbox.deadLetter", null, () => {
          const messageId = parsePersistedId(raw.messageId, "deadLetter.messageId");
          const next = applyDeadLetter(rowToOutboxMessage(readOutboxRow(messageId)), {
            owner: raw.owner,
            failureCategory: raw.failureCategory,
            nowIso: clock.now().toISOString(),
          });
          writeOutboxMessage(next);
          return next;
        }),

      get: (messageId) =>
        run("outbox.get", null, () => {
          const id = parsePersistedId(messageId, "messageId");
          const row = sql(() => statements.outboxGet.get(id)) as OutboxRow | undefined;
          return row === undefined ? null : rowToOutboxMessage(row);
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
              ? 0
              : decodeCursor(query.cursor, "sequence").lastSequence;
          const rows = sql(() =>
            status === null
              ? statements.outboxListAll.all(after, limit + 1)
              : statements.outboxListByStatus.all(status, after, limit + 1),
          ) as OutboxRow[];
          return buildPage(rows.map(rowToOutboxMessage), limit, (item) => ({
            kind: "sequence",
            lastSequence: item.sequence,
          }));
        }),
    };

    const readStoredArtifact = <T>(
      statement: SqliteStatement,
      id: string,
      recordKind: string,
      parse: (payload: unknown) => T,
    ): T | null => {
      const row = sql(() => statement.get(id)) as ArtifactRow | undefined;
      if (row === undefined) {
        return null;
      }
      const checksum = parseChecksum(
        { algorithm: row.checksum_algorithm, hex: row.checksum_hex },
        `${recordKind}.checksum`,
      );
      verifyChecksum(row.payload, checksum, { recordKind, recordId: id });
      return parse(parseJsonText(row.payload, recordKind));
    };

    const artifacts: ArtifactMetadataStore = {
      putDescriptor: (raw) =>
        run("artifacts.putDescriptor", null, () => {
          const descriptor: ArtifactDescriptor = parseArtifactDescriptor(raw);
          if (sql(() => statements.artifactExists.get(descriptor.id)) !== undefined) {
            throw new PersistenceError("DUPLICATE_ID", "The artifact id already exists.", {
              artifactId: descriptor.id,
            });
          }
          const prepared = preparePayload(descriptor, "artifactDescriptor");
          sql(() =>
            statements.artifactInsert.run(
              descriptor.id,
              prepared.text,
              prepared.checksum.algorithm,
              prepared.checksum.hex,
            ),
          );
          return descriptor;
        }),

      getDescriptor: (artifactId) =>
        run("artifacts.getDescriptor", null, () => {
          const id = parsePersistedId(artifactId, "artifactId");
          return readStoredArtifact(
            statements.artifactGet,
            id,
            "artifact-descriptor",
            parseArtifactDescriptor,
          );
        }),

      listDescriptors: (query) =>
        run("artifacts.listDescriptors", null, () => {
          const limit = normalizePageSize(query?.limit);
          const after =
            query?.cursor === undefined || query.cursor === null
              ? ""
              : decodeCursor(query.cursor, "string-key").lastKey;
          const rows = sql(() =>
            statements.artifactList.all(after, limit + 1),
          ) as ReadonlyArray<ArtifactRow & { readonly artifact_id: string }>;
          const items = rows.map((row) => {
            const checksum = parseChecksum(
              { algorithm: row.checksum_algorithm, hex: row.checksum_hex },
              "artifact-descriptor.checksum",
            );
            verifyChecksum(row.payload, checksum, {
              recordKind: "artifact-descriptor",
              recordId: row.artifact_id,
            });
            return parseArtifactDescriptor(parseJsonText(row.payload, "artifact-descriptor"));
          });
          return buildPage(items, limit, (item) => ({ kind: "string-key", lastKey: item.id }));
        }),

      putManifest: (raw) =>
        run("artifacts.putManifest", null, () => {
          const manifest: ArtifactManifest = parseArtifactManifest(raw);
          if (sql(() => statements.manifestExists.get(manifest.manifestId)) !== undefined) {
            throw new PersistenceError("DUPLICATE_ID", "The manifest id already exists.", {
              manifestId: manifest.manifestId,
            });
          }
          const prepared = preparePayload(manifest, "artifactManifest");
          sql(() =>
            statements.manifestInsert.run(
              manifest.manifestId,
              prepared.text,
              prepared.checksum.algorithm,
              prepared.checksum.hex,
            ),
          );
          return manifest;
        }),

      getManifest: (manifestId) =>
        run("artifacts.getManifest", null, () => {
          const id = parsePersistedId(manifestId, "manifestId");
          return readStoredArtifact(
            statements.manifestGet,
            id,
            "artifact-manifest",
            parseArtifactManifest,
          );
        }),
    };

    return Object.freeze({ aggregates, events, outbox, artifacts });
  }

  return {
    async transact<T>(work: (tx: TransactionContext) => Promise<T> | T): Promise<T> {
      guard.assertNotNested();
      return mutex.run(async () => {
        closedGate.assertActive();
        sql(() => db.exec("BEGIN IMMEDIATE"));
        const txGate = new SessionGate(
          "TRANSACTION_COMPLETED",
          "The transaction has already completed.",
        );
        const context = createContext(txGate);
        try {
          const result = await guard.run(async () => await work(context));
          txGate.close();
          sql(() => db.exec("COMMIT"));
          return result;
        } catch (error) {
          txGate.close();
          if (db.inTransaction) {
            db.exec("ROLLBACK");
          }
          throw error;
        }
      });
    },

    async migrationStatus(): Promise<MigrationStatus> {
      return mutex.run(() => {
        closedGate.assertActive();
        return sql(() => planMigrations(SQLITE_MIGRATIONS, readAppliedMigrations(db)).status);
      });
    },

    async close(): Promise<void> {
      await mutex.run(() => {
        if (closedGate.active) {
          closedGate.close();
          sql(() => {
            if (db.open) {
              db.close();
            }
          });
        }
      });
    },
  };
}
