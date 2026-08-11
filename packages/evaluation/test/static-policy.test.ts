import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : entry.isFile() && entry.name.endsWith(".ts")
        ? [readFileSync(path, "utf8")]
        : [];
  });
}

describe("evaluation static authority policy", () => {
  it("contains no provider, workspace, Git, process, network, credential, or dynamic-code authority", () => {
    const source = sourceFiles(resolve(packageRoot, "src")).join("\n");
    for (const forbidden of [
      "node:child_process",
      "node:fs",
      "node:http",
      "node:https",
      "node:net",
      "node:tls",
      "process.env",
      "@ai-dev-os/providers",
      "@ai-dev-os/workspace",
      "@ai-dev-os/process-broker",
      "simple-git",
      "isomorphic-git",
      "eval(",
      "new Function",
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).not.toContain("productionEnabled: true");
  });

  it("publishes only the reviewed production-disabled package surface", () => {
    const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
      readonly dependencies: Record<string, string>;
      readonly devDependencies: Record<string, string>;
      readonly files: readonly string[];
      readonly exports: Record<string, unknown>;
    };
    expect(manifest.dependencies).toEqual({
      "@ai-dev-os/domain": "^0.1.0",
      "@ai-dev-os/persistence": "^0.1.0",
    });
    expect(manifest.devDependencies).toEqual({
      "@ai-dev-os/persistence-memory": "^0.1.0",
      "@ai-dev-os/persistence-sqlite": "^0.1.0",
    });
    expect(manifest.files).toEqual(["dist", "README.md"]);
    expect(Object.keys(manifest.exports)).toEqual(["."]);
  });
});
