import { describe, expect, it } from "vitest";
import { AppVaultError, runVaultMigrations, validateMigrationRegistry, type AppVaultMigration } from "../src/index.js";

describe("ordered pure migration registry", () => {
  const base = Object.freeze({ schemaVersion: 1, records: Object.freeze([{ slotId: "anthropic", cipherText: "opaque" }]) });

  it("sorts a contiguous registry and applies deterministic metadata-only steps", () => {
    const migrations: readonly AppVaultMigration[] = [
      { from: 2, to: 3, migrate: (value) => Object.freeze({ ...value, schemaVersion: 3, third: true }) },
      { from: 1, to: 2, migrate: (value) => Object.freeze({ ...value, schemaVersion: 2, second: true }) },
    ];
    expect(validateMigrationRegistry(migrations).map((item) => item.from)).toEqual([1, 2]);
    expect(runVaultMigrations(base, 3, migrations)).toMatchObject({ schemaVersion: 3, second: true, third: true });
  });

  it("rejects gaps, invalid edges, missing steps, downgrade and ciphertext changes", () => {
    expect(() => validateMigrationRegistry([{ from: 1, to: 3, migrate: (value) => value }])).toThrowError(AppVaultError);
    expect(() => validateMigrationRegistry([{ from: 1, to: 2, migrate: (value) => value }, { from: 3, to: 4, migrate: (value) => value }])).toThrowError(AppVaultError);
    expect(() => runVaultMigrations(base, 2, [])).toThrowError(expect.objectContaining({ code: "MIGRATION_GAP" }));
    for (const target of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() => runVaultMigrations(base, target, [])).toThrowError(expect.objectContaining({ code: "MIGRATION_GAP" }));
    }
    expect(() => runVaultMigrations({ schemaVersion: "one" }, 2, [])).toThrowError(AppVaultError);
    expect(() => runVaultMigrations(base, 2, [{ from: 1, to: 2, migrate: (value) => ({ ...value, schemaVersion: 2, records: [{ slotId: "anthropic", cipherText: "changed" }] }) }])).toThrowError(AppVaultError);
    let calls = 0;
    expect(() => runVaultMigrations(base, 2, [{ from: 1, to: 2, migrate: (value) => ({ ...value, schemaVersion: 2, calls: calls++ }) }])).toThrowError(AppVaultError);
    const mutable = { schemaVersion: 1, records: [{ slotId: "anthropic", cipherText: "opaque" }], metadata: { keep: true } };
    expect(() => runVaultMigrations(mutable, 2, [{ from: 1, to: 2, migrate: (value) => {
      (value["metadata"] as { keep: boolean }).keep = false;
      return { ...value, schemaVersion: 2 };
    } }])).toThrowError(expect.objectContaining({ code: "MIGRATION_GAP" }));
    expect(mutable.metadata.keep).toBe(true);
  });

  it("handles non-record projections and rejects non-canonical migration input", () => {
    expect(runVaultMigrations({ schemaVersion: 1, records: [null, {}] }, 1, [])).toMatchObject({ schemaVersion: 1 });
    expect(runVaultMigrations({ schemaVersion: 1, records: null }, 1, [])).toMatchObject({ schemaVersion: 1 });
    expect(() => runVaultMigrations({ schemaVersion: 1n } as never, 1, [])).toThrowError(expect.objectContaining({ code: "MIGRATION_GAP" }));
  });
});
