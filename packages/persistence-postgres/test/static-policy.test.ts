import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { migrationChecksum } from "@ai-dev-os/persistence";
import { POSTGRES_MIGRATIONS } from "../src/index.js";

const EXPECTED_AGGREGATE_TYPES = Object.freeze([
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

function aggregateTypeVocabularies(sql: string): readonly (readonly string[])[] {
  return [...sql.matchAll(/CHECK \(aggregate_type IN \(([^)]+)\)\)/gu)].map((match) =>
    Object.freeze([...match[1]!.matchAll(/'([^']+)'/gu)].map((literal) => literal[1]!)),
  );
}

const packageRoot = resolve(import.meta.dirname, "..");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function sources(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? sources(path)
      : entry.isFile() && entry.name.endsWith(".ts")
        ? [read(path)]
        : [];
  });
}

describe("PostgreSQL package static policy", () => {
  it("has no ambient credential/configuration path or logging authority", () => {
    const source = sources(resolve(packageRoot, "src")).join("\n");
    for (const forbidden of [
      "process.env",
      "connectionString",
      "console.log",
      "console.error",
      "pg-native",
      "error.message",
      "error.detail",
      "error.hint",
      "error.query",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("pins the native locking, sequence, checksum, and migration invariants", () => {
    expect(POSTGRES_MIGRATIONS).toHaveLength(5);
    const migration = POSTGRES_MIGRATIONS[0];
    const evaluationMigration = POSTGRES_MIGRATIONS[1];
    const integrationMigration = POSTGRES_MIGRATIONS[2];
    const projectMigration = POSTGRES_MIGRATIONS[3];
    const planningMigration = POSTGRES_MIGRATIONS[4];
    expect(migration?.id).toBe("0001-initial-schema");
    expect(migrationChecksum(migration!).hex).toBe(
      "34413d60368bc485b1cbdc088d5000baa4ce31829c71ff0947d813aae1545f11",
    );
    expect(evaluationMigration?.id).toBe("0002-evaluation-run-aggregate");
    expect(migrationChecksum(evaluationMigration!).hex).toBe(
      "aeeee92ba9db56fb762e6f44dfcb782a840897582d3cc135d6b1cfb7a2e594a3",
    );
    expect(evaluationMigration?.content).toContain("'evaluation-run'");
    expect(integrationMigration?.id).toBe("0003-integration-run-aggregate");
    expect(migrationChecksum(integrationMigration!).hex).toBe(
      "595f8bea3d06baae44370aeeca5f1a21f57cadf55f2970fb20b054e9ad29c065",
    );
    expect(integrationMigration?.content).toContain("'integration-run'");
    expect(projectMigration?.id).toBe("0004-project-persistence-aggregates");
    expect(migrationChecksum(projectMigration!).hex).toBe(
      "5de038634e296881ba4f258f5b784fe749117515e6758c6cde77818b3e1ce5aa",
    );
    expect(aggregateTypeVocabularies(projectMigration!.content)).toEqual([
      EXPECTED_AGGREGATE_TYPES,
      EXPECTED_AGGREGATE_TYPES,
    ]);
    const plantedMismatch = projectMigration!.content.replace("'project-stop'", "'project-stopped'");
    expect(() => expect(aggregateTypeVocabularies(plantedMismatch)).toEqual([
      EXPECTED_AGGREGATE_TYPES,
      EXPECTED_AGGREGATE_TYPES,
    ])).toThrow();
    expect(planningMigration?.id).toBe("0005-saved-planning-aggregates");
    expect(migrationChecksum(planningMigration!).hex).toBe(
      "c0dce7bfc3b4d20c1fca85f86408dc30002548c81cd4685b2ca81b15a38b97f5",
    );
    const planningVocabulary = [...EXPECTED_AGGREGATE_TYPES, "planning-command", "planning-workspace", "planning-handover"];
    expect(aggregateTypeVocabularies(planningMigration!.content)).toEqual([planningVocabulary, planningVocabulary]);
    const incompletePlanning = planningMigration!.content.replace(",'planning-handover'", "");
    expect(() => expect(aggregateTypeVocabularies(incompletePlanning)).toEqual([planningVocabulary, planningVocabulary])).toThrow();
    const adapter = read(resolve(packageRoot, "src", "postgres-adapter.ts"));
    const migrations = read(resolve(packageRoot, "src", "migrations.ts"));
    expect(adapter).toContain("FOR UPDATE SKIP LOCKED");
    expect(adapter).toContain("pg_advisory_xact_lock");
    expect(adapter).toContain("BEGIN ISOLATION LEVEL SERIALIZABLE");
    expect(adapter).toContain("ON CONFLICT (aggregate_type, aggregate_id) DO NOTHING");
    expect(migrations).toContain("pg_advisory_lock");
    expect(migrations).toContain("ORDER BY ordinal ASC LIMIT $1");
    expect(migrations).toContain("GENERATED BY DEFAULT AS IDENTITY");
    expect(migrations).toContain("COLLATE \"C\"");
  });

  it("publishes only reviewed files and the direct pure-JavaScript driver stack", () => {
    const manifest = JSON.parse(read(resolve(packageRoot, "package.json"))) as {
      readonly dependencies: Record<string, string>;
      readonly devDependencies: Record<string, string>;
      readonly files: readonly string[];
      readonly exports: Record<string, unknown>;
      readonly scripts: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({
      "@ai-dev-os/artifacts": "^0.1.0",
      "@ai-dev-os/domain": "^0.1.0",
      "@ai-dev-os/persistence": "^0.1.0",
      pg: "8.23.0",
      "pg-pool": "3.14.0",
    });
    expect(manifest.devDependencies).toEqual({
      "@ai-dev-os/integrator": "^0.1.0",
      "@types/pg": "8.21.0",
    });
    expect(manifest.files).toEqual(["dist", "README.md"]);
    expect(Object.keys(manifest.exports).sort()).toEqual([".", "./testing"]);
    expect(manifest.scripts["pretest"]).toBe("npm run build && npm --prefix ../integrator run build");
    expect(manifest.scripts["pretest:live"]).toBe("npm run build && npm --prefix ../integrator run build");
    expect(manifest.scripts["pretest:coverage"]).toBe("npm run build && npm --prefix ../integrator run build");

    const pgManifest = JSON.parse(read(resolve(packageRoot, "..", "..", "node_modules", "pg", "package.json"))) as {
      readonly version: string;
      readonly license: string;
      readonly scripts?: Record<string, string>;
    };
    expect(pgManifest).toMatchObject({ version: "8.23.0", license: "MIT" });
    expect(pgManifest.scripts?.["install"]).toBeUndefined();
    expect(pgManifest.scripts?.["preinstall"]).toBeUndefined();
    expect(pgManifest.scripts?.["postinstall"]).toBeUndefined();
  });
});
