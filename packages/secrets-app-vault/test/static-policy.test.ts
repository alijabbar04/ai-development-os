import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

function sourceFiles(): readonly string[] {
  const directory = fileURLToPath(new URL("../src", import.meta.url));
  const visit = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = `${path}/${entry.name}`;
    return entry.isDirectory() ? visit(child) : entry.name.endsWith(".ts") ? [child] : [];
  });
  return visit(directory);
}

describe("pure app-vault authority", () => {
  it("has no filesystem, Electron, network, shell or process-launch import", () => {
    const combined = sourceFiles().map((path) => readFileSync(path, "utf8")).join("\n");
    for (const forbidden of [
      'from "electron"', 'import("electron")', 'from "node:fs', 'from "node:http', 'from "node:https',
      'from "node:net', 'from "node:tls', 'from "node:dns', 'from "node:child_process',
      "fetch(", "XMLHttpRequest", "WebSocket", "exec(", "spawn(", "process.env",
    ]) expect(combined).not.toContain(forbidden);
  });

  it("keeps document reads and decryption in the broker module", () => {
    for (const path of sourceFiles()) {
      const text = readFileSync(path, "utf8");
      if (path.endsWith("broker.ts")) continue;
      expect(text).not.toMatch(/storage\.read\s*\(/u);
      expect(text).not.toMatch(/crypto\.decrypt\s*\(/u);
    }
    expect(source("../src/broker.ts")).toContain("storage.read()");
    expect(source("../src/broker.ts")).toContain("crypto.decrypt(cipher)");
  });

  it("keeps the manager thin and exposes no secret-returning or enumeration API", async () => {
    const manager = source("../src/manager.ts");
    expect(manager).not.toContain(".storage.read(");
    expect(manager).not.toContain(".writeAtomic(");
    expect(manager).not.toContain(".crypto.decrypt(");
    expect(manager).toContain("await broker.replace(");
    expect(manager).toContain("await broker.revoke(");
    const runtime = await import("../src/index.js");
    const exports = Object.keys(runtime);
    for (const forbidden of ["get", "read", "reveal", "copy", "dump", "list", "export", "plaintext"]) {
      expect(exports.some((name) => name.toLocaleLowerCase("en-US") === forbidden || name.toLocaleLowerCase("en-US").startsWith(`${forbidden}secret`))).toBe(false);
    }
    expect(exports).toContain("createAppVaultSecretBroker");
    expect(exports).toContain("createAppVaultManager");
    for (const internal of ["parseVaultDocument", "serializeVaultDocument", "vaultCipherBytes", "AppVaultDocument", "AppVaultRecord"]) {
      expect(exports).not.toContain(internal);
    }
    expect(exports).toContain("inspectVaultDocument");
  });

  it("uses no lifecycle install hooks and publishes only production and testing entries", () => {
    const manifest = JSON.parse(source("../package.json")) as { scripts: Record<string, string>; exports: Record<string, unknown>; dependencies: Record<string, string> };
    for (const hook of ["preinstall", "install", "postinstall", "prepare"]) expect(manifest.scripts[hook]).toBeUndefined();
    expect(Object.keys(manifest.exports)).toEqual([".", "./testing"]);
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@ai-dev-os/domain", "@ai-dev-os/secrets"]);
    expect(JSON.stringify(manifest)).not.toContain("electron");
  });
});
