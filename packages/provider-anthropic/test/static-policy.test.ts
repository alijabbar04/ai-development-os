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
    .join("\n");
}

describe("Anthropic package boundary", () => {
  it("contains no ambient transport, process, SDK, UI, or dynamic-load authority", () => {
    const source = productionSource().toLowerCase();
    for (const forbidden of [
      "node:child_process",
      "node:http",
      "node:https",
      "node:net",
      "process.env",
      "fetch(",
      "import(",
      "require(",
      "@anthropic-ai/sdk",
      "claude code",
      "playwright",
      "electron",
      "browser",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it("exports the fake factory only from the testing subpath", () => {
    const productionIndex = read(resolve(packageRoot, "src", "index.ts"));
    const testingIndex = read(resolve(packageRoot, "src", "testing", "index.ts"));
    const validationIndex = read(resolve(packageRoot, "src", "validation", "index.ts"));
    expect(productionIndex).not.toContain("createAnthropicProviderForTesting");
    expect(productionIndex).not.toContain("createAnthropicLiveCanary");
    expect(testingIndex).toContain("createAnthropicProviderForTesting");
    expect(testingIndex).toContain("createAnthropicLiveCanary");
    expect(testingIndex).not.toContain("createDirectAnthropicLiveCanaryTransportForTesting");
    expect(validationIndex).toContain("createProductionDisabledAnthropicValidation");
    expect(validationIndex).not.toContain("createAnthropicProviderForTesting");
  });

  it("declares only reviewed first-party dependencies and bounded package files", () => {
    const manifest = JSON.parse(read(resolve(packageRoot, "package.json"))) as {
      readonly dependencies: Record<string, string>;
      readonly files: readonly string[];
      readonly exports: Record<string, unknown>;
      readonly scripts: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      "@ai-dev-os/domain",
      "@ai-dev-os/policy",
      "@ai-dev-os/providers",
      "@ai-dev-os/secrets",
    ]);
    expect(manifest.files).toEqual(["dist", "README.md"]);
    expect(Object.keys(manifest.exports).sort()).toEqual([".", "./testing", "./validation"]);
    expect(JSON.stringify(manifest)).not.toContain("@anthropic-ai/sdk");
    expect(manifest.scripts["test"]).toBe("vitest run");
  });
});
