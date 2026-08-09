import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(packageRoot, "..", "..");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function productionSchedulerSource(): string {
  return readdirSync(resolve(packageRoot, "src"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => read(resolve(packageRoot, "src", entry.name)))
    .join("\n");
}

describe("Stage 18A static policy", () => {
  it("keeps the scheduler modular, production-disabled, and free of direct authority surfaces", () => {
    const source = productionSchedulerSource();
    for (const forbidden of [
      "node:child_process",
      "node:fs",
      "node:http",
      "node:https",
      "node:net",
      "process.env",
      "fetch(",
      "import(",
      "require(",
      "account-manager",
      "playwright",
      "electron",
      "discord",
      "telegram",
      "whatsapp",
    ]) {
      expect(source.toLowerCase(), forbidden).not.toContain(forbidden);
    }
    expect(source).toContain("STAGE_18A_PRODUCTION_ENABLED = false");
    expect(read(resolve(packageRoot, "src", "index.ts"))).not.toContain("createDurableSchedulerForTesting");
    expect(read(resolve(packageRoot, "src", "testing", "index.ts"))).toContain("createDurableSchedulerForTesting");
  });

  it("declares only the reviewed scheduler runtime dependencies and bounded package files", () => {
    const manifest = JSON.parse(read(resolve(packageRoot, "package.json"))) as {
      readonly dependencies: Record<string, string>;
      readonly files: readonly string[];
      readonly exports: Record<string, unknown>;
    };
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@ai-dev-os/domain", "@ai-dev-os/persistence"]);
    expect(manifest.files).toEqual(["dist", "README.md"]);
    expect(Object.keys(manifest.exports).sort()).toEqual([".", "./testing"]);
  });

  it("keeps the Codex SDK seam injected, dependency-free, and unable to spawn or load a live SDK", () => {
    const manifest = JSON.parse(read(resolve(repositoryRoot, "packages", "provider-codex", "package.json"))) as {
      readonly dependencies: Record<string, string>;
    };
    const seam = read(resolve(repositoryRoot, "packages", "provider-codex", "src", "sdk-seam.ts"));
    expect(Object.keys(manifest.dependencies)).not.toContain("@openai/codex-sdk");
    for (const forbidden of [
      'from "@openai/codex-sdk"',
      "import(",
      "node:child_process",
      "process.env",
      "new codex(",
      "apikey",
      "credential",
    ]) {
      expect(seam.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    }
    expect(seam).toContain('CODEX_SDK_COMPATIBILITY_VERSION = "0.147.0"');
    expect(seam).toContain("CODEX_SDK_RUNTIME_DEPENDENCY_ENABLED = false");
  });

  it("does not place paths, credentials, endpoints, or executable authority in the task envelope", () => {
    const types = read(resolve(packageRoot, "src", "types.ts"));
    const envelope = types.slice(types.indexOf("export interface OrchestrationTaskEnvelope"), types.indexOf("export const FAILURE_CLASSIFICATIONS"));
    for (const forbidden of ["path", "directory", "credential", "secret", "endpoint", "executable", "command", "environment", "processid"] ) {
      expect(envelope.toLowerCase(), forbidden).not.toContain(forbidden);
    }
    expect(envelope).toContain("readonly workspace: WorkspaceIdentity");
  });
});
