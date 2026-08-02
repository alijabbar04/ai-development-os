import type { SqliteDatabase } from "./driver.js";
import {
  PersistenceError,
  migrationChecksum,
  planMigrations,
  type AppliedMigration,
  type Clock,
  type MigrationDefinition,
  type MigrationStatus,
} from "@ai-dev-os/persistence";

/**
 * Released migrations are immutable: never edit an entry after it ships;
 * append a new one instead. Checksums of applied migrations are verified on
 * every open.
 */
export const SQLITE_MIGRATIONS: readonly MigrationDefinition[] = Object.freeze([
  {
    id: "0001-initial-schema",
    content: `
CREATE TABLE aggregates (
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  aggregate_version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  checksum_algorithm TEXT NOT NULL,
  checksum_hex TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  trace_id TEXT,
  PRIMARY KEY (aggregate_type, aggregate_id)
) STRICT;

CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  event_schema_version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  checksum_algorithm TEXT NOT NULL,
  checksum_hex TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  global_sequence INTEGER NOT NULL UNIQUE,
  trace_id TEXT,
  causation_id TEXT
) STRICT;

CREATE INDEX idx_events_aggregate
  ON events (aggregate_type, aggregate_id, global_sequence);

CREATE TABLE outbox (
  message_id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  checksum_algorithm TEXT NOT NULL,
  checksum_hex TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  acknowledged_at TEXT,
  dead_lettered_at TEXT,
  last_failure_category TEXT,
  sequence INTEGER NOT NULL UNIQUE,
  trace_id TEXT
) STRICT;

CREATE INDEX idx_outbox_claim ON outbox (status, available_at, sequence);

CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  checksum_algorithm TEXT NOT NULL,
  checksum_hex TEXT NOT NULL
) STRICT;

CREATE TABLE artifact_manifests (
  manifest_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  checksum_algorithm TEXT NOT NULL,
  checksum_hex TEXT NOT NULL
) STRICT;
`,
  },
]);

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  checksum_algorithm TEXT NOT NULL,
  checksum_hex TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  ordinal INTEGER NOT NULL UNIQUE
) STRICT;
`;

interface MigrationRow {
  readonly id: string;
  readonly checksum_algorithm: string;
  readonly checksum_hex: string;
  readonly applied_at: string;
  readonly ordinal: number;
}

export function readAppliedMigrations(db: SqliteDatabase): readonly AppliedMigration[] {
  const rows = db
    .prepare("SELECT id, checksum_algorithm, checksum_hex, applied_at, ordinal FROM schema_migrations ORDER BY ordinal ASC")
    .all() as readonly MigrationRow[];
  return rows.map((row) =>
    Object.freeze({
      id: row.id,
      checksum: Object.freeze({
        algorithm: row.checksum_algorithm as "sha-256",
        hex: row.checksum_hex,
      }),
      appliedAt: row.applied_at,
      ordinal: row.ordinal,
    }),
  );
}

/**
 * Bootstraps the migration table and applies every pending migration, each
 * in its own transaction, recording id, checksum, and application time. A
 * failing migration rolls back completely, leaving the database at the last
 * successful migration; reopening retries from there.
 */
export function applyMigrations(
  db: SqliteDatabase,
  definitions: readonly MigrationDefinition[],
  clock: Clock,
): MigrationStatus {
  db.exec(BOOTSTRAP_SQL);
  const applied = readAppliedMigrations(db);
  const plan = planMigrations(definitions, applied);

  const insert = db.prepare(
    "INSERT INTO schema_migrations (id, checksum_algorithm, checksum_hex, applied_at, ordinal) VALUES (?, ?, ?, ?, ?)",
  );

  let ordinal = applied.length;
  for (const definition of plan.toApply) {
    ordinal += 1;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(definition.content);
      const checksum = migrationChecksum(definition);
      insert.run(
        definition.id,
        checksum.algorithm,
        checksum.hex,
        clock.now().toISOString(),
        ordinal,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      if (error instanceof PersistenceError) {
        throw error;
      }
      throw new PersistenceError("MIGRATION_FAILED", "A schema migration failed to apply.", {
        migrationId: definition.id,
        sqliteCode: readSqliteCode(error),
      });
    }
  }

  return planMigrations(definitions, readAppliedMigrations(db)).status;
}

export function readSqliteCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}
