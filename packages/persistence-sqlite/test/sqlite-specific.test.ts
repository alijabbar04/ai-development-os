import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ValidationError } from "@ai-dev-os/domain";
import {
  PersistenceError,
  isPersistenceError,
  migrationChecksum,
  type MigrationDefinition,
} from "@ai-dev-os/persistence";
import { createManualClock } from "@ai-dev-os/persistence/testing";
import { createSqlitePersistenceAdapter } from "../src/index.js";
import { openSqliteDatabase } from "../src/driver.js";
import { SQLITE_MIGRATIONS, applyMigrations, readAppliedMigrations } from "../src/migrations.js";

const cleanups: Array<() => void> = [];

function tempDatabaseFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "aidevos-sqlite-spec-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5 }));
  return join(directory, "test.db");
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe("adapter construction and path safety", () => {
  it("rejects ambiguous, missing, relative, URI, and hostile locations", () => {
    expect(() => createSqlitePersistenceAdapter({})).toThrow(ValidationError);
    expect(() =>
      createSqlitePersistenceAdapter({ memory: true, file: "C:/x.db" }),
    ).toThrow(ValidationError);
    expect(() => createSqlitePersistenceAdapter({ file: "relative/path.db" })).toThrow(
      ValidationError,
    );
    expect(() =>
      createSqlitePersistenceAdapter({ file: "file:C:/traversal.db?mode=ro" }),
    ).toThrow(ValidationError);
    expect(() =>
      createSqlitePersistenceAdapter({ file: `C:/x${"\u0000"}.db` }),
    ).toThrow(ValidationError);
    try {
      createSqlitePersistenceAdapter({
        file: join(tmpdir(), "aidevos-definitely-missing-dir", "sub", "x.db"),
      });
      expect.unreachable();
    } catch (error) {
      expect(isPersistenceError(error, "STORAGE_FAILURE")).toBe(true);
      expect((error as PersistenceError).details["reason"]).toBe("parent-directory-missing");
    }
  });

  it("configures WAL journal mode, busy timeout, and foreign keys for file databases", async () => {
    const file = tempDatabaseFile();
    const adapter = createSqlitePersistenceAdapter({ file, busyTimeoutMs: 1_234 });
    await adapter.transact((tx) =>
      tx.aggregates.create({
        aggregateType: "project",
        aggregateId: "proj-1",
        schemaVersion: 1,
        payload: {},
      }),
    );
    await adapter.close();

    const raw = openSqliteDatabase(file);
    try {
      expect(raw.pragma("journal_mode", { simple: true })).toBe("wal");
    } finally {
      raw.close();
    }

    const deleteMode = createSqlitePersistenceAdapter({ file, journalMode: "delete" });
    await deleteMode.close();
    expect(() =>
      createSqlitePersistenceAdapter({ file, journalMode: "truncate" as never }),
    ).toThrow(ValidationError);
    expect(() => createSqlitePersistenceAdapter({ file, busyTimeoutMs: -1 })).toThrow(
      ValidationError,
    );
  });

  it("does not expose the raw connection through the public adapter", () => {
    const adapter = createSqlitePersistenceAdapter({ memory: true });
    expect(Object.keys(adapter).sort()).toEqual(["close", "migrationStatus", "transact"]);
  });
});

describe("migrations", () => {
  it("opens an empty database, records checksummed migrations, and reopens cleanly", async () => {
    const file = tempDatabaseFile();
    const clock = createManualClock();
    const adapter = createSqlitePersistenceAdapter({ file, clock });
    const status = await adapter.migrationStatus();
    expect(status.applied.map((migration) => migration.id)).toEqual(
      SQLITE_MIGRATIONS.map((migration) => migration.id),
    );
    expect(status.applied[0]!.checksum).toEqual(migrationChecksum(SQLITE_MIGRATIONS[0]!));
    expect(status.applied[0]!.appliedAt).toBe("2026-08-02T12:00:00.000Z");
    expect(status.pending).toHaveLength(0);
    await adapter.close();

    const reopened = createSqlitePersistenceAdapter({ file });
    const secondStatus = await reopened.migrationStatus();
    expect(secondStatus.applied).toHaveLength(SQLITE_MIGRATIONS.length);
    await reopened.close();
  });

  it("rejects a tampered migration checksum on reopen", async () => {
    const file = tempDatabaseFile();
    const adapter = createSqlitePersistenceAdapter({ file });
    await adapter.close();

    const raw = openSqliteDatabase(file);
    try {
      raw
        .prepare("UPDATE schema_migrations SET checksum_hex = ? WHERE ordinal = 1")
        .run("f".repeat(64));
    } finally {
      raw.close();
    }

    try {
      createSqlitePersistenceAdapter({ file });
      expect.unreachable();
    } catch (error) {
      expect(isPersistenceError(error, "MIGRATION_CHECKSUM_MISMATCH")).toBe(true);
    }
  });

  it("rejects a database from a newer application version", async () => {
    const file = tempDatabaseFile();
    const adapter = createSqlitePersistenceAdapter({ file });
    await adapter.close();

    const raw = openSqliteDatabase(file);
    try {
      raw
        .prepare(
          "INSERT INTO schema_migrations (id, checksum_algorithm, checksum_hex, applied_at, ordinal) VALUES (?, ?, ?, ?, ?)",
        )
        .run("0999-future-schema", "sha-256", "a".repeat(64), "2027-01-01T00:00:00.000Z", 2);
    } finally {
      raw.close();
    }

    try {
      createSqlitePersistenceAdapter({ file });
      expect.unreachable();
    } catch (error) {
      expect(isPersistenceError(error, "SCHEMA_TOO_NEW")).toBe(true);
    }
  });

  it("recovers cleanly after a failed migration", () => {
    const file = tempDatabaseFile();
    const clock = createManualClock();
    const good: MigrationDefinition = {
      id: "0001-initial-schema",
      content: "CREATE TABLE demo (id TEXT PRIMARY KEY) STRICT;",
    };
    const broken: MigrationDefinition = {
      id: "0002-broken",
      content: "CREATE TABLE broken (id TEXT PRIMARY KEY) STRICT; THIS IS NOT SQL;",
    };
    const fixed: MigrationDefinition = {
      id: "0002-broken",
      content: "CREATE TABLE fixed (id TEXT PRIMARY KEY) STRICT;",
    };

    const first = openSqliteDatabase(file);
    try {
      try {
        applyMigrations(first, [good, broken], clock);
        expect.unreachable();
      } catch (error) {
        expect(isPersistenceError(error, "MIGRATION_FAILED")).toBe(true);
        expect((error as PersistenceError).details["migrationId"]).toBe("0002-broken");
        const serialized = JSON.stringify((error as PersistenceError).toJSON());
        expect(serialized).not.toContain("NOT SQL");
      }
      // The failed migration left no partial application: only 0001 recorded.
      expect(readAppliedMigrations(first).map((migration) => migration.id)).toEqual([
        "0001-initial-schema",
      ]);
      // A corrected build applies the fixed migration from where it stopped.
      const status = applyMigrations(first, [good, fixed], clock);
      expect(status.applied.map((migration) => migration.id)).toEqual([
        "0001-initial-schema",
        "0002-broken",
      ]);
      expect(status.pending).toHaveLength(0);
    } finally {
      first.close();
    }
  });
});

describe("durability details", () => {
  it("preserves exact integer and timestamp semantics across reopen", async () => {
    const file = tempDatabaseFile();
    const clock = createManualClock();
    const adapter = createSqlitePersistenceAdapter({ file, clock });
    const bigMicros = Number.MAX_SAFE_INTEGER;
    await adapter.transact((tx) =>
      tx.aggregates.create({
        aggregateType: "budget-account",
        aggregateId: "acct-1",
        schemaVersion: 1,
        payload: { amountMicros: bigMicros, at: "2026-08-02T12:00:00.000Z" },
      }),
    );
    await adapter.close();

    const reopened = createSqlitePersistenceAdapter({ file, clock });
    const envelope = await reopened.transact((tx) =>
      tx.aggregates.get("budget-account", "acct-1"),
    );
    expect((envelope?.payload as { amountMicros: number }).amountMicros).toBe(bigMicros);
    expect(envelope?.createdAt).toBe("2026-08-02T12:00:00.000Z");
    await reopened.close();
  });

  it("detects checksum substitution (consistent checksum, altered payload)", async () => {
    const file = tempDatabaseFile();
    const adapter = createSqlitePersistenceAdapter({ file });
    await adapter.transact((tx) =>
      tx.aggregates.create({
        aggregateType: "project",
        aggregateId: "proj-1",
        schemaVersion: 1,
        payload: { value: 1 },
      }),
    );
    await adapter.close();

    // Substitute BOTH payload and a validly-shaped checksum for other content.
    const raw = openSqliteDatabase(file);
    try {
      raw
        .prepare("UPDATE aggregates SET payload = ?, checksum_hex = ? WHERE aggregate_id = ?")
        .run('{"value":2}', "b".repeat(64), "proj-1");
    } finally {
      raw.close();
    }

    const reopened = createSqlitePersistenceAdapter({ file });
    await expect(
      reopened.transact((tx) => tx.aggregates.get("project", "proj-1")),
    ).rejects.toMatchObject({ code: "CORRUPTION_DETECTED" });
    await reopened.close();
  });
});
