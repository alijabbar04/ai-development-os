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
    return entry.isFile() && entry.name.endsWith(".ts") ? [read(path)] : [];
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
    };
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      "@ai-dev-os/domain",
      "@ai-dev-os/persistence",
      "@ai-dev-os/persistence-sqlite",
      "@ai-dev-os/scheduler",
    ]);
    expect(manifest.files).toEqual(["dist", "README.md"]);
    expect(Object.keys(manifest.exports).sort()).toEqual([".", "./testing"]);
  });
});
