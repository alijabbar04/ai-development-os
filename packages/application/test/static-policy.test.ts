import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function productionSources(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "testing" ? [] : productionSources(path);
    }
    // The saved workspace holds one OS socket exclusively for process lifetime.
    // It accepts no commands or data; no other network import is admitted.
    return entry.isFile() && entry.name.endsWith(".ts") ? [entry.name === "planning-storage.ts" ? read(path).replace('import { createServer } from "node:net";', "") : read(path)] : [];
  });
}

describe("Stage 18C application static policy", () => {
  it("contains no ambient process, network, browser, credential, or live-account authority", () => {
    const source = productionSources(resolve(packageRoot, "src"))
      .join("\n")
      .toLowerCase();
    for (const forbidden of [
      "node:child_process",
      "node:http",
      "node:https",
      "node:net",
      "process.env",
      "fetch(",
      "playwright",
      "selenium",
      "electron",
      "ipcmain",
      "ipcrenderer",
      "claude_config_dir",
      ".credentials.json",
      "api key",
      "cookie",
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain("account_manager_live_access_enabled = false");
  });

  it("publishes only the reviewed package files and dependencies", () => {
    const manifest = JSON.parse(read(resolve(packageRoot, "package.json"))) as {
      readonly dependencies: Record<string, string>;
      readonly files: readonly string[];
      readonly exports: Record<string, unknown>;
      readonly scripts: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      "@ai-dev-os/approval",
      "@ai-dev-os/config",
      "@ai-dev-os/context",
      "@ai-dev-os/domain",
      "@ai-dev-os/intake",
      "@ai-dev-os/persistence",
      "@ai-dev-os/persistence-postgres",
      "@ai-dev-os/persistence-sqlite",
      "@ai-dev-os/plan",
      "@ai-dev-os/policy",
      "@ai-dev-os/project",
      "@ai-dev-os/prompt-compiler",
      "@ai-dev-os/provider-claude-code",
      "@ai-dev-os/providers",
      "@ai-dev-os/scheduler",
      "@ai-dev-os/thinker",
    ]);
    expect(manifest.files).toEqual(["dist", "README.md"]);
    expect(Object.keys(manifest.exports).sort()).toEqual([".", "./planning", "./planning-contracts", "./planning-storage", "./testing"]);
    expect(manifest.scripts["pretest"]).toBe(
      "npm run build && npm --prefix ../persistence-memory run build",
    );
    expect(manifest.scripts["pretest:coverage"]).toBe(
      "npm run build && npm --prefix ../persistence-memory run build",
    );
  });

  it("exports injected Account Manager readers only through testing", () => {
    expect(read(resolve(packageRoot, "src", "index.ts")))
      .not.toContain("createAccountManagerSupportedUsageAdapterForTesting");
    expect(read(resolve(packageRoot, "src", "testing", "index.ts")))
      .toContain("createAccountManagerSupportedUsageAdapterForTesting");
  });

  it("keeps development planning host-owned without test-only inference or canonical issuers", () => {
    const source = productionSources(resolve(packageRoot, "src")).join("\n");
    for (const forbidden of [
      'from "@ai-dev-os/thinker/testing"',
      'from "@ai-dev-os/policy/testing"',
      'from "@ai-dev-os/config/testing"',
      'from "@ai-dev-os/plan/testing"',
      'from "./testing/planning-ai-fixture.js"',
      "createProductPlanningCoordinatorForTesting",
    ]) expect(source).not.toContain(forbidden);
    const owner = read(resolve(packageRoot, "src", "planning-ai.ts"));
    expect(owner).toContain("options.planningProcess ?? createBlockedPlanningProcessPort()");
    expect(read(resolve(packageRoot, "src", "planning-ai-thinker.ts"))).toContain("createThinker({");
  });
});
