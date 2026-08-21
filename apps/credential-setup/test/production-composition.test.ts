import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_VAULT_SLOTS } from "@ai-dev-os/secrets-app-vault";

const factories = vi.hoisted(() => ({
  manager: vi.fn(),
  broker: vi.fn(),
}));

vi.mock("@ai-dev-os/secrets-app-vault-electron", () => ({
  createAppVaultManager: factories.manager,
  createAppVaultSecretBroker: factories.broker,
}));

import { createProductionCredentialHost, credentialRendererRoot } from "../src/main/production-composition.js";

const temporaryRoots: string[] = [];

function fakeBroker(name: string, close = vi.fn(async () => undefined)) {
  return Object.freeze({
    async withSecret() { throw new Error(`unused-${name}`); },
    async availability() { return Object.freeze({ state: "missing", detail: null }); },
    async close() { await close(); },
    describeContainerBinding() { return Object.freeze({ schemaVersion: 1, backendKind: "electron-safe-storage-async", digest: name.padEnd(64, "0").slice(0, 64) }); },
    async describeRecord() { throw new Error(`unused-${name}`); },
  });
}

function memoryManager(close = vi.fn(async () => undefined)) {
  const absent = () => APP_VAULT_SLOTS.map((slot) => Object.freeze({ slotId: slot.slotId, state: "absent", revision: null, generation: null, createdAt: null, rotatedAt: null, revokedAt: null, lastValidation: null }));
  let snapshot: any = Object.freeze({ vaultState: "absent", revision: null, slots: Object.freeze(absent()), issue: null, recovery: null });
  return Object.freeze({
    async describeSnapshot() { return snapshot; },
    async describeSlots() { return snapshot.slots; },
    async create(input: { slotId: string }) {
      const created = Object.freeze({ slotId: input.slotId, state: "present", revision: 1, generation: 1, createdAt: "2026-08-20T10:00:00.000Z", rotatedAt: null, revokedAt: null, lastValidation: null });
      snapshot = Object.freeze({ vaultState: "ready", revision: 1, slots: Object.freeze(snapshot.slots.map((slot: any) => slot.slotId === input.slotId ? created : Object.freeze({ ...slot, revision: 1 }))), issue: null, recovery: null });
      return created;
    },
    async rotate() { throw new Error("unused-rotate"); },
    async remove() { throw new Error("unused-remove"); },
    async forget() { throw new Error("unused-forget"); },
    async restoreBackup() { throw new Error("unused-restore"); },
    async startOver() { throw new Error("unused-start-over"); },
    async rebind() { throw new Error("unused-rebind"); },
    async close() { await close(); },
  });
}

beforeEach(() => {
  factories.manager.mockReset();
  factories.broker.mockReset();
});

afterEach(async () => {
  const roots = temporaryRoots.splice(0);
  await Promise.all(roots.map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("production credential-host composition", () => {
  it("constructs the sole manager, all fixed brokers, metadata root, and disabled host", async () => {
    const appData = await mkdtemp(join(tmpdir(), "credential-composition-"));
    temporaryRoots.push(appData);
    const managerClose = vi.fn(async () => undefined);
    const manager = memoryManager(managerClose);
    const brokerCloses = APP_VAULT_SLOTS.map(() => vi.fn(async () => undefined));
    factories.manager.mockImplementation(async (options) => {
      options.clock.now();
      for (let index = 0; index < 130; index += 1) options.audit?.({ operation: "synthetic" });
      return manager;
    });
    factories.broker.mockImplementation(async (options) => {
      options.clock.now();
      options.audit?.({ operation: "synthetic" });
      const index = factories.broker.mock.calls.length - 1;
      return fakeBroker(APP_VAULT_SLOTS[index]!.slotId, brokerCloses[index]);
    });
    const clipboardClear = vi.fn();
    const availability = vi.fn(async () => true);
    const service = await createProductionCredentialHost({ app: { getPath: () => appData, getName: () => "Credential Composition Test" }, clipboard: { clear: clipboardClear }, safeStorage: { isAsyncEncryptionAvailable: availability } } as never);
    expect(factories.manager).toHaveBeenCalledOnce();
    expect(factories.broker).toHaveBeenCalledTimes(4);
    expect(factories.broker.mock.calls.map((call) => call[0].reference.providerInstanceId)).toEqual(APP_VAULT_SLOTS.map((slot) => slot.providerInstanceId));
    expect(await service.describe({ schemaVersion: 1, requestId: "1".repeat(32), sessionToken: "2".repeat(64), operation: "describe" })).toMatchObject({ ok: true, kind: "slots", vaultState: "absent", validationEnabled: false, productionDisabled: true });
    expect(availability).toHaveBeenCalledOnce();
    expect(await service.save({ schemaVersion: 1, requestId: "3".repeat(32), sessionToken: "2".repeat(64), operation: "save", slotId: "anthropic", secret: "SYNTHETIC_PRODUCTION_COMPOSITION", nickname: "Synthetic", ownership: "owned", authorizedBy: "", clearClipboard: true })).toMatchObject({ ok: true, kind: "saved", clipboard: { requested: true, outcome: "cleared" } });
    expect(clipboardClear).toHaveBeenCalledOnce();
    await service.close();
    expect(managerClose).toHaveBeenCalledOnce();
    expect(brokerCloses.every((close) => close.mock.calls.length === 1)).toBe(true);
    expect(credentialRendererRoot(appData)).toBe(join(appData, "dist", "renderer", "credential"));
  });

  it("settles every created resource when a later broker construction fails", async () => {
    const managerClose = vi.fn(async () => { throw new Error("manager-close-failure"); });
    const brokerCloses = [vi.fn(async () => { throw new Error("broker-close-failure"); }), vi.fn(async () => undefined)];
    factories.manager.mockResolvedValue(memoryManager(managerClose));
    factories.broker.mockImplementation(async () => {
      const index = factories.broker.mock.calls.length - 1;
      if (index === 2) throw new Error("broker-construction-failure");
      return fakeBroker(`broker-${index}`, brokerCloses[index]);
    });
    await expect(createProductionCredentialHost({ app: { getPath: () => resolve("bounded-app-data"), getName: () => "Credential Test" }, clipboard: { clear() {} } } as never)).rejects.toThrow("broker-construction-failure");
    expect(managerClose).toHaveBeenCalledOnce();
    expect(brokerCloses[0]).toHaveBeenCalledOnce();
    expect(brokerCloses[1]).toHaveBeenCalledOnce();
  });

  it("settles a broker when resolver binding capture rejects its malformed surface", async () => {
    const managerClose = vi.fn(async () => undefined);
    const brokerClose = vi.fn(async () => undefined);
    factories.manager.mockResolvedValue(memoryManager(managerClose));
    factories.broker.mockResolvedValue(Object.freeze({ async close() { await brokerClose(); } }));

    await expect(createProductionCredentialHost({ app: { getPath: () => resolve("bounded-app-data"), getName: () => "Credential Test" }, clipboard: { clear() {} } } as never)).rejects.toThrow();
    expect(factories.broker).toHaveBeenCalledOnce();
    expect(managerClose).toHaveBeenCalledOnce();
    expect(brokerClose).toHaveBeenCalledOnce();
  });

  it("settles the manager and all brokers when the fixed metadata root is invalid", async () => {
    const managerClose = vi.fn(async () => undefined);
    const brokerCloses = APP_VAULT_SLOTS.map(() => vi.fn(async () => undefined));
    factories.manager.mockResolvedValue(memoryManager(managerClose));
    factories.broker.mockImplementation(async () => {
      const index = factories.broker.mock.calls.length - 1;
      return fakeBroker(`broker-${index}`, brokerCloses[index]);
    });
    await expect(createProductionCredentialHost({ app: { getPath: () => resolve("bounded-app-data"), getName: () => ".." }, clipboard: { clear() {} } } as never)).rejects.toThrow("CREDENTIAL_METADATA_PATH_INVALID");
    expect(managerClose).toHaveBeenCalledOnce();
    expect(brokerCloses.every((close) => close.mock.calls.length === 1)).toBe(true);
  });
});
