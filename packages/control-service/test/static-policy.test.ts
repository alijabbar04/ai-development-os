import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = [
  "adoption.ts", "artifacts.ts", "contracts.ts", "errors.ts", "identity.ts",
  "index.ts", "lifecycle.ts", "listener.ts", "routes.ts", "single-instance.ts",
  "structural.ts", "transport.ts",
];

describe("C3 static security boundary", () => {
  it("contains no provider, credential, repository, command, or process-launch imports", async () => {
    const text = (await Promise.all(SOURCES.map(async (name) => await readFile(join(PACKAGE_ROOT, "src", name), "utf8")))).join("\n");
    for (const forbidden of [
      "@ai-dev-os/application", "@ai-dev-os/scheduler", "@ai-dev-os/process-broker",
      "@ai-dev-os/workspace", "@ai-dev-os/secrets", "child_process", "node:cluster",
    ]) expect(text).not.toContain(forbidden);
    expect(text).toContain("timingSafeEqual");
    expect(text).toContain('host: CONTROL_HOST');
  });

  it("has no executable entry point or ambient identity configuration", async () => {
    const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8")) as Record<string, unknown>;
    expect(manifest["bin"]).toBeUndefined();
    const text = (await Promise.all(SOURCES.map(async (name) => await readFile(join(PACKAGE_ROOT, "src", name), "utf8")))).join("\n");
    expect(text).not.toMatch(/process\.env|process\.argv/u);
    expect(text).not.toMatch(/productionEnabled\s*:\s*true/u);
  });

  it("makes wildcard, IPv6-any, environment, CLI, and caller-selected hosts absent", async () => {
    const listener = await readFile(join(PACKAGE_ROOT, "src", "listener.ts"), "utf8");
    expect(listener).not.toContain('"0.0.0.0"');
    expect(listener).not.toContain('"::"');
    expect(listener).not.toMatch(/process\.env|process\.argv|options\.host|config\.host/u);
    expect(listener).toContain("host: CONTROL_HOST");
    const identity = await readFile(join(PACKAGE_ROOT, "src", "identity.ts"), "utf8");
    expect(identity).toContain('CONTROL_HOST = "127.0.0.1"');
    const index = await readFile(join(PACKAGE_ROOT, "src", "index.ts"), "utf8");
    expect(index).not.toContain("testing");
  });

  it("pins Fastify exactly with no optional listener plugins", async () => {
    const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies["fastify"]).toBe("5.12.1");
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@ai-dev-os/api", "@ai-dev-os/domain", "fastify"]);
  });
});
