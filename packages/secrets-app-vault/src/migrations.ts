import { toCanonicalJson } from "@ai-dev-os/domain";
import { AppVaultError } from "./errors.js";

export interface AppVaultMigration {
  readonly from: number;
  readonly to: number;
  migrate(document: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
}

function cipherProjection(value: Readonly<Record<string, unknown>>): string {
  const records = Array.isArray(value["records"]) ? value["records"] : [];
  return toCanonicalJson(records.map((record) => {
    if (typeof record !== "object" || record === null) return null;
    const data = record as Record<string, unknown>;
    return Object.freeze({ slotId: data["slotId"] ?? null, cipherText: data["cipherText"] ?? null });
  }));
}

function frozenClone(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  let cloned: unknown;
  try { cloned = JSON.parse(toCanonicalJson(value)) as unknown; }
  catch { throw new AppVaultError("MIGRATION_GAP", "The app-vault migration input is not canonical data."); }
  const freeze = (candidate: unknown): unknown => {
    if (typeof candidate !== "object" || candidate === null) return candidate;
    for (const nested of Object.values(candidate)) freeze(nested);
    return Object.freeze(candidate);
  };
  return freeze(cloned) as Readonly<Record<string, unknown>>;
}

export function validateMigrationRegistry(migrations: readonly AppVaultMigration[]): readonly AppVaultMigration[] {
  const sorted = [...migrations].sort((left, right) => left.from - right.from);
  for (let index = 0; index < sorted.length; index += 1) {
    const migration = sorted[index]!;
    if (!Number.isSafeInteger(migration.from) || migration.from < 1 || migration.to !== migration.from + 1 || typeof migration.migrate !== "function") {
      throw new AppVaultError("MIGRATION_GAP", "The app-vault migration registry is invalid.");
    }
    if (index > 0 && sorted[index - 1]!.to !== migration.from) {
      throw new AppVaultError("MIGRATION_GAP", "The app-vault migration registry contains a gap.");
    }
  }
  return Object.freeze(sorted);
}

export function runVaultMigrations(
  document: Readonly<Record<string, unknown>>,
  targetVersion: number,
  migrations: readonly AppVaultMigration[],
): Readonly<Record<string, unknown>> {
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 1) {
    throw new AppVaultError("MIGRATION_GAP", "The app-vault migration target is invalid.");
  }
  const registry = validateMigrationRegistry(migrations);
  let current = frozenClone(document);
  const initialVersion = current["schemaVersion"];
  if (typeof initialVersion !== "number" || !Number.isSafeInteger(initialVersion) || initialVersion < 1 || targetVersion < initialVersion) {
    throw new AppVaultError("MIGRATION_GAP", "The app-vault document cannot be migrated by this registry.");
  }
  let version: number = initialVersion;
  const originalInput = toCanonicalJson(document);
  const originalCiphertext = cipherProjection(document);
  while (version < targetVersion) {
    const migration = registry.find((candidate) => candidate.from === version);
    if (migration === undefined) throw new AppVaultError("MIGRATION_GAP", "The app-vault migration registry contains a gap.");
    let first: Readonly<Record<string, unknown>>;
    let second: Readonly<Record<string, unknown>>;
    try {
      first = migration.migrate(frozenClone(current));
      second = migration.migrate(frozenClone(current));
    } catch { throw new AppVaultError("MIGRATION_GAP", "The app-vault migration is impure or mutated its input."); }
    if (toCanonicalJson(document) !== originalInput || toCanonicalJson(first) !== toCanonicalJson(second) || cipherProjection(first) !== originalCiphertext || first["schemaVersion"] !== migration.to) {
      throw new AppVaultError("MIGRATION_GAP", "The app-vault migration is impure or changed ciphertext.");
    }
    current = frozenClone(first);
    version = migration.to;
  }
  return Object.freeze(current);
}

/** Schema version 1 is the first format, so the initial ordered registry is empty. */
export const APP_VAULT_MIGRATIONS: readonly AppVaultMigration[] = validateMigrationRegistry([]);
