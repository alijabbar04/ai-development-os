import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "testing" ? [] : sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [readFileSync(path, "utf8")] : [];
  });
}

describe("integrator static authority policy", () => {
  it("keeps production source free of filesystem, process, network, credentials, workspace, and raw Git authority", () => {
    const source = sourceFiles(resolve(packageRoot, "src")).join("\n");
    for (const forbidden of [
      "node:child_process",
      "node:fs",
      "node:http",
      "node:https",
      "node:net",
      "node:tls",
      "process.env",
      "@ai-dev-os/workspace",
      "@ai-dev-os/process-broker",
      "simple-git",
      "isomorphic-git",
      "exec(",
      "spawn(",
      "productionEnabled: true",
    ]) expect(source).not.toContain(forbidden);
    expect(source).toContain("INTEGRATION_PRODUCTION_ENABLED = false");
    const store = readFileSync(resolve(packageRoot, "src", "store.ts"), "utf8");
    for (const operation of ["prepare", "execute", "reconcile"]) {
      expect(store).toMatch(new RegExp(`async ${operation}\\(value: unknown\\): Promise<IntegrationRunSnapshot> \\{\\s*assertEffectsEnabled\\(\\);`));
    }
  });

  it("publishes the reviewed root and explicitly separated disposable-fixture surface", () => {
    const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
      readonly dependencies: Record<string, string>;
      readonly devDependencies: Record<string, string>;
      readonly files: readonly string[];
      readonly exports: Record<string, unknown>;
      readonly scripts: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({
      "@ai-dev-os/domain": "^0.1.0",
      "@ai-dev-os/persistence": "^0.1.0",
      "@ai-dev-os/workspace": "^0.1.0",
    });
    expect(manifest.devDependencies).toEqual({
      "@ai-dev-os/persistence-memory": "^0.1.0",
      "@ai-dev-os/persistence-sqlite": "^0.1.0",
    });
    expect(manifest.files).toEqual(["dist", "README.md"]);
    expect(Object.keys(manifest.exports)).toEqual([".", "./testing"]);
    expect(manifest.scripts["prebuild"]).toContain("npm --prefix ../workspace run build");
    expect(manifest.scripts["pretypecheck"]).toContain("npm --prefix ../workspace run build");
    const realGitPort = readFileSync(resolve(packageRoot, "src", "testing", "real-git-port.ts"), "utf8");
    expect(realGitPort).not.toContain("Promise.all([");
  });

  it("pins the append-only PostgreSQL integration aggregate migration", () => {
    const migrationSource = readFileSync(resolve(packageRoot, "..", "persistence-postgres", "src", "migrations.ts"), "utf8");
    expect(migrationSource).toContain('id: "0003-integration-run-aggregate"');
    expect(migrationSource).toContain("'integration-run'");
    expect(migrationSource).toContain('id: "0002-evaluation-run-aggregate"');
  });
});
