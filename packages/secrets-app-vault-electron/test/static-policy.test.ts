import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertAppVaultElectronVersion, APP_VAULT_ELECTRON_FLOOR } from "../src/electron-version.js";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

function productionSources(): readonly string[] {
  const root = fileURLToPath(new URL("../src", import.meta.url));
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => readFileSync(`${root}/${entry.name}`, "utf8"));
}

describe("Electron adapter static authority", () => {
  it("pins the newest patched stable line in dev/peer fields only", () => {
    const manifest = JSON.parse(source("../package.json")) as { dependencies: Record<string, string>; devDependencies: Record<string, string>; peerDependencies: Record<string, string>; scripts: Record<string, string> };
    expect(manifest.dependencies).toEqual({ "@ai-dev-os/secrets-app-vault": "^0.1.0" });
    expect(manifest.peerDependencies.electron).toBe(">=42.4.1");
    expect(manifest.devDependencies.electron).toBe("~43.4.1");
    for (const hook of ["preinstall", "install", "postinstall", "prepare"]) expect(manifest.scripts[hook]).toBeUndefined();
  });

  it("contains no plaintext fallback or synchronous crypto invocation", () => {
    const combined = productionSources().join("\n");
    expect(combined).not.toContain("setUsePlainTextEncryption");
    expect(combined).not.toMatch(/\.encryptString\s*\(/u);
    expect(combined).not.toMatch(/\.decryptString\s*\(/u);
    expect(combined).toContain("encryptStringAsync");
    expect(combined).toContain("decryptStringAsync");
  });

  it("uses a lazy Electron import and no environment-controlled production vault path", async () => {
    const index = source("../src/index.ts");
    expect(index).toContain('await import("electron")');
    expect(index).not.toContain("process.env");
    expect(index).toContain('resolve(appDataRoot, name, "secrets")');
    expect(index).toContain("applicationDirectoryName(electron.app.getName())");
    const runtime = await import("../src/index.js");
    expect(Object.keys(runtime).sort()).toEqual([
      "APP_VAULT_ELECTRON_FLOOR",
      "assertAppVaultElectronVersion",
      "createAppVaultManager",
      "createAppVaultSecretBroker",
    ].sort());
    expect(runtime).not.toHaveProperty("createElectronSafeStorageCryptoPort");
  });

  it("enforces the patched asynchronous Electron floor", () => {
    expect(APP_VAULT_ELECTRON_FLOOR).toBe("42.4.1");
    expect(() => assertAppVaultElectronVersion("42.4.1")).not.toThrow();
    expect(() => assertAppVaultElectronVersion("43.4.1")).not.toThrow();
    expect(() => assertAppVaultElectronVersion("42.4.0")).toThrow();
    expect(() => assertAppVaultElectronVersion("41.9.9")).toThrow();
    expect(() => assertAppVaultElectronVersion("43.4.2-beta.1")).toThrow();
    expect(() => assertAppVaultElectronVersion("invalid")).toThrow();
    expect(() => assertAppVaultElectronVersion(`${"9".repeat(400)}.4.1`)).toThrow();
  });

  it("keeps raw filesystem construction out of the production export", async () => {
    const production = await import("../src/index.js");
    const testing = await import("../src/testing/index.js");
    expect(production).not.toHaveProperty("createNodeFileAppVaultStoragePort");
    expect(testing).toHaveProperty("createNodeFileAppVaultStoragePort");
  });
});
