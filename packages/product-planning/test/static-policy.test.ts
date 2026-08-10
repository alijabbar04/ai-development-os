import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function productionSource(): string {
  return readdirSync(resolve(packageRoot, "src"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => read(resolve(packageRoot, "src", entry.name)))
    .join("\n")
    .toLowerCase();
}

describe("product-planning package boundary", () => {
  it("contains no ambient process, filesystem, network, UI, or dynamic-load authority", () => {
    const source = productionSource();
    for (const forbidden of [
      "node:child_process",
      "node:fs",
      "node:http",
      "node:https",
      "node:net",
      "process.env",
      "fetch(",
      "require(",
      "@anthropic-ai/sdk",
      "playwright",
      "electron",
      "account-manager",
      "discord",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    for (const dynamicImport of ["await import(", "return import(", "= import("]) {
      expect(source, dynamicImport).not.toContain(dynamicImport);
    }
  });

  it("keeps all exercising factories behind the testing-only subpath", () => {
    const publicIndex = read(resolve(packageRoot, "src", "index.ts"));
    const testingIndex = read(resolve(packageRoot, "src", "testing", "index.ts"));
    expect(publicIndex).not.toContain("createProductPlanningCoordinatorForTesting");
    expect(publicIndex).not.toContain("createInferencePlanningAgentAdapter");
    expect(testingIndex).toContain("createProductPlanningCoordinatorForTesting");
    expect(testingIndex).toContain("createInferencePlanningAgentAdapter");
    expect(read(resolve(packageRoot, "src", "contracts.ts"))).toContain("PRODUCT_PLANNING_PRODUCTION_ENABLED = false as const");
  });

  it("declares only reviewed first-party dependencies and bounded package files", () => {
    const manifest = JSON.parse(read(resolve(packageRoot, "package.json"))) as {
      readonly dependencies: Record<string, string>;
      readonly devDependencies: Record<string, string>;
      readonly files: readonly string[];
      readonly exports: Record<string, unknown>;
      readonly scripts: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      "@ai-dev-os/domain",
      "@ai-dev-os/persistence",
      "@ai-dev-os/providers",
      "@ai-dev-os/scheduler",
      "@ai-dev-os/task-graph",
    ]);
    expect(Object.keys(manifest.devDependencies).sort()).toEqual([
      "@ai-dev-os/persistence-memory",
      "@ai-dev-os/persistence-sqlite",
      "@ai-dev-os/provider-anthropic",
      "@ai-dev-os/provider-testkit",
    ]);
    expect(manifest.files).toEqual(["dist", "README.md"]);
    expect(Object.keys(manifest.exports).sort()).toEqual([".", "./testing"]);
    expect(manifest.scripts["test"]).toBe("vitest run");
  });

  it("does not define credential or provider-wire payload fields in planning contracts", () => {
    const contracts = read(resolve(packageRoot, "src", "contracts.ts"));
    for (const forbiddenField of ["apiKey:", "credential:", "secret:", "rawBody:", "responseBody:", "requestBody:"]) {
      expect(contracts, forbiddenField).not.toContain(forbiddenField);
    }
  });
});
