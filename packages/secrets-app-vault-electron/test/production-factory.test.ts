import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { appVaultReferenceForSlot } from "@ai-dev-os/secrets-app-vault";
import { parseSecretAccessContext } from "@ai-dev-os/secrets";

const state = vi.hoisted(() => ({
  ready: true,
  available: true,
  name: "AI Development OS Factory Test",
  appDataPath: "C:\\Users\\Operator\\AppData\\Roaming",
  memory: null as null | { port: unknown; replacePrimary(bytes: Uint8Array | null): void },
}));

vi.mock("electron", () => ({
  app: {
    isReady: () => state.ready,
    getName: () => state.name,
    getPath: () => state.appDataPath,
  },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => state.available,
    encryptStringAsync: async (plainText: string) => {
      const input = new TextEncoder().encode(plainText);
      const output = new Uint8Array(input.byteLength + 1);
      output[0] = 0x7a;
      output.set(input, 1);
      input.fill(0);
      return output;
    },
    decryptStringAsync: async (cipher: Uint8Array) => ({
      result: new TextDecoder().decode(cipher.subarray(1)),
      shouldReEncrypt: false,
    }),
  },
}));

vi.mock("../src/file-store-port.js", async () => {
  const testing = await import("@ai-dev-os/secrets-app-vault/testing");
  return { createNodeFileAppVaultStoragePort: async () => {
    state.memory ??= testing.createMemoryAppVaultStoragePort();
    return state.memory.port;
  } };
});

const originalElectronVersion = Object.getOwnPropertyDescriptor(process.versions, "electron");
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function setElectronVersion(value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.versions, "electron");
  else Object.defineProperty(process.versions, "electron", { configurable: true, enumerable: true, value });
}

function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { configurable: true, enumerable: true, value });
}

function context() {
  return parseSecretAccessContext({
    operationId: "production-factory-test",
    providerInstanceId: "anthropic-default",
    purpose: "provider-authentication",
    requestedLifetimeMs: 10_000,
    accessForm: "text",
    classification: "internal",
    projectId: null,
    taskId: null,
    approvalEvidenceRefs: [],
    disclosureDecisionFingerprint: null,
    locality: "local",
    trace: { traceId: "production-factory-test.trace", runId: null, taskId: null, taskRunId: null },
    deadline: null,
    signal: undefined,
  });
}

beforeEach(() => {
  state.ready = true;
  state.available = true;
  state.name = "AI Development OS Factory Test";
  state.appDataPath = "C:\\Users\\Operator\\AppData\\Roaming";
  state.memory = null;
  setElectronVersion("43.4.1");
  setPlatform("win32");
});

afterAll(() => {
  if (originalElectronVersion === undefined) Reflect.deleteProperty(process.versions, "electron");
  else Object.defineProperty(process.versions, "electron", originalElectronVersion);
  if (originalPlatform !== undefined) Object.defineProperty(process, "platform", originalPlatform);
});

describe("production Electron vault composition", () => {
  it("constructs the production manager and broker and resolves only through the broker callback", async () => {
    const production = await import("../src/index.js");
    const clock = Object.freeze({ now: () => new Date("2026-08-19T09:00:00.000Z") });
    const audits: unknown[] = [];
    const audit = (record: unknown) => { audits.push(record); };
    const manager = await production.createAppVaultManager({ schemaVersion: 1, clock, audit });
    expect(await manager.describeSnapshot()).toMatchObject({ vaultState: "absent", revision: null });
    await expect(manager.create({ slotId: "anthropic", secret: "SYNTHETIC-PRODUCTION-FACTORY", expectRevision: null })).resolves.toMatchObject({ revision: 1, state: "present" });
    const reference = appVaultReferenceForSlot("anthropic");
    const broker = await production.createAppVaultSecretBroker({ schemaVersion: 1, reference, clock, audit });
    await expect(broker.withSecret(reference, context(), (material) => material.useText((text) => text))).resolves.toBe("SYNTHETIC-PRODUCTION-FACTORY");
    expect(production).not.toHaveProperty("createElectronSafeStorageCryptoPort");
    expect(audits.length).toBeGreaterThan(0);
    await broker.close();
    await manager.close();
  });

  it("fails closed for runtime readiness, version, names, paths, options and async unavailability", async () => {
    const production = await import("../src/index.js");
    const clock = Object.freeze({ now: () => new Date("2026-08-19T09:00:00.000Z") });
    state.ready = false;
    await expect(production.createAppVaultManager({ schemaVersion: 1, clock })).rejects.toMatchObject({ code: "APP_NOT_READY" });
    state.ready = true;
    setElectronVersion(undefined);
    await expect(production.createAppVaultManager({ schemaVersion: 1, clock })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    setElectronVersion("43.4.1");
    state.name = "..";
    await expect(production.createAppVaultManager({ schemaVersion: 1, clock })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    state.name = "AI Development OS Factory Test";
    state.appDataPath = "x";
    await expect(production.createAppVaultManager({ schemaVersion: 1, clock })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    state.appDataPath = "C:\\Users\\Operator\\AppData\\Roaming";
    await expect(production.createAppVaultManager(new Proxy({ schemaVersion: 1, clock }, {}) as never)).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    let getterCalls = 0;
    const accessor = Object.defineProperty({ schemaVersion: 1 }, "clock", { enumerable: true, get() { getterCalls += 1; return clock; } });
    for (const candidate of [
      { schemaVersion: 1, clock, extra: true },
      { schemaVersion: 1 },
      { schemaVersion: 2, clock },
      { schemaVersion: 1, clock, audit: "invalid" },
      { schemaVersion: 1, clock, [Symbol("hidden")]: true },
      accessor,
    ]) await expect(production.createAppVaultManager(candidate as never)).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(getterCalls).toBe(0);
    setPlatform("linux");
    await expect(production.createAppVaultManager({ schemaVersion: 1, clock })).rejects.toMatchObject({ code: "PLATFORM_UNSUPPORTED" });
    setPlatform("win32");
    state.available = false;
    const manager = await production.createAppVaultManager({ schemaVersion: 1, clock });
    await expect(manager.create({ slotId: "anthropic", secret: "SYNTHETIC", expectRevision: null })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await manager.close();
  });
});
