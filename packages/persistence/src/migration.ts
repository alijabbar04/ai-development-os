import { validation } from "@ai-dev-os/domain";
import { computeChecksumOfText, parseChecksum, type Checksum } from "./checksum.js";
import { PersistenceError } from "./errors.js";

const { ensureRecord, ensureExactKeys, ensureSafeInteger, ensureString, ensureTimestamp } =
  validation;

/**
 * Migration identifiers are ordered lexicographically by a fixed-width
 * numeric prefix, e.g. "0001-initial-schema". Definitions are immutable
 * after release: the checksum of a released migration's content must never
 * change.
 */
const MIGRATION_ID_PATTERN = /^[0-9]{4}-[a-z0-9][a-z0-9-]{0,63}$/;

export interface MigrationDefinition {
  readonly id: string;
  /** The full migration content (for SQLite adapters, the SQL text). */
  readonly content: string;
}

export interface AppliedMigration {
  readonly id: string;
  readonly checksum: Checksum;
  readonly appliedAt: string;
  /** 1-based position in the application order. */
  readonly ordinal: number;
}

export interface MigrationStatus {
  readonly applied: readonly AppliedMigration[];
  readonly pending: readonly string[];
  /** True when the database contains migrations this build does not know. */
  readonly databaseSchemaAhead: boolean;
}

export function parseMigrationId(value: unknown, path = "migrationId"): string {
  return ensureString(value, path, {
    maxLength: 69,
    pattern: MIGRATION_ID_PATTERN,
    patternName: "migration identifier",
  });
}

export function migrationChecksum(definition: MigrationDefinition): Checksum {
  return computeChecksumOfText(definition.content);
}

export function parseAppliedMigration(value: unknown, path = "appliedMigration"): AppliedMigration {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["id", "checksum", "appliedAt", "ordinal"], path);
  return Object.freeze({
    id: parseMigrationId(record["id"], `${path}.id`),
    checksum: parseChecksum(record["checksum"], `${path}.checksum`),
    appliedAt: ensureTimestamp(record["appliedAt"], `${path}.appliedAt`),
    ordinal: ensureSafeInteger(record["ordinal"], `${path}.ordinal`, 1, 1_000_000),
  });
}

function validateDefinitions(
  definitions: readonly MigrationDefinition[],
): readonly MigrationDefinition[] {
  const seen = new Set<string>();
  definitions.forEach((definition, index) => {
    const id = parseMigrationId(definition.id, `migrations[${index}].id`);
    ensureString(definition.content, `migrations[${index}].content`, {
      maxLength: 1_000_000,
    });
    if (seen.has(id)) {
      throw new PersistenceError("MIGRATION_FAILED", "Duplicate migration identifier.", {
        migrationId: id,
      });
    }
    seen.add(id);
    const previous = definitions[index - 1];
    if (previous !== undefined && previous.id >= id) {
      throw new PersistenceError(
        "MIGRATION_FAILED",
        "Migration definitions must be strictly ordered by identifier.",
        { migrationId: id, previousId: previous.id },
      );
    }
  });
  return definitions;
}

/**
 * Computes the deterministic migration plan.
 *
 * The applied history must be an exact ordered, checksum-matching prefix of
 * the defined migrations. Any divergence is a structured failure:
 *
 * - an applied migration unknown to this build → SCHEMA_TOO_NEW
 * - an applied migration whose checksum differs → MIGRATION_CHECKSUM_MISMATCH
 * - applied history out of order or with gaps → MIGRATION_FAILED
 */
export function planMigrations(
  definitions: readonly MigrationDefinition[],
  applied: readonly AppliedMigration[],
): {
  readonly toApply: readonly MigrationDefinition[];
  readonly status: MigrationStatus;
} {
  const validDefinitions = validateDefinitions(definitions);
  const definitionIds = new Set(validDefinitions.map((definition) => definition.id));

  const ahead = applied.filter((migration) => !definitionIds.has(migration.id));
  if (ahead.length > 0) {
    throw new PersistenceError(
      "SCHEMA_TOO_NEW",
      "The database contains migrations newer than this application supports.",
      { unknownMigrationIds: Object.freeze(ahead.map((migration) => migration.id)) },
    );
  }

  applied.forEach((migration, index) => {
    const definition = validDefinitions[index];
    if (definition === undefined || definition.id !== migration.id || migration.ordinal !== index + 1) {
      throw new PersistenceError(
        "MIGRATION_FAILED",
        "The applied migration history does not match the defined migration order.",
        { position: index + 1, appliedId: migration.id },
      );
    }
    const expected = migrationChecksum(definition);
    if (expected.hex !== migration.checksum.hex || expected.algorithm !== migration.checksum.algorithm) {
      throw new PersistenceError(
        "MIGRATION_CHECKSUM_MISMATCH",
        "An already-applied migration has a different checksum in this build.",
        { migrationId: migration.id },
      );
    }
  });

  const toApply = validDefinitions.slice(applied.length);
  return Object.freeze({
    toApply: Object.freeze(toApply),
    status: Object.freeze({
      applied: Object.freeze([...applied]),
      pending: Object.freeze(toApply.map((definition) => definition.id)),
      databaseSchemaAhead: false,
    }),
  });
}
