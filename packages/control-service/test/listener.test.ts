import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONNECTION_DESCRIPTOR_FILE,
  INSTANCE_LOCK_FILE,
  ControlServiceError,
  createControlArtifactStore,
  parseConnectionDescriptor,
  startControlService,
  type ControlArtifactStore,
  type ControlServiceHandle,
} from "../src/index.js";
import { startControlServiceForTest } from "./testing.js";
import { httpGet } from "./http-helpers.js";

const NOW = "2026-08-26T10:00:00.000Z";
const roots: string[] = [];
const handles: ControlServiceHandle[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "ai-dev-os-c4-"));
  roots.push(value);
  return value;
}

async function start(options: Partial<Parameters<typeof startControlServiceForTest>[0]> = {}): Promise<ControlServiceHandle> {
  const storageRoot = options.storageRoot ?? await root();
  const handle = await startControlServiceForTest({
    storageRoot,
    clock: () => NOW,
    random: (size) => Buffer.alloc(size, 21),
    ...options,
  });
  handles.push(handle);
  return handle;
}

afterEach(async () => {
  for (const handle of handles.splice(0).reverse()) {
    try { await handle.close(); } catch { /* assertions cover owned cleanup failures */ }
  }
  for (const value of roots.splice(0)) await rm(value, { recursive: true, force: true });
});

describe("C4 loopback listener lifecycle", () => {
  it("starts on an ephemeral literal IPv4 loopback port and publishes only after readiness", async () => {
    const storageRoot = await root();
    const handle = await start({ storageRoot });
    expect(handle.startupMode).toBe("fresh");
    expect(handle.ownsListener).toBe(true);
    expect(handle.descriptor).toMatchObject({ host: "127.0.0.1", processId: process.pid });
    expect(handle.descriptor.port).toBeGreaterThan(0);
    expect(handle.lifecycle()).toMatchObject({ state: "ready", startupMode: "fresh", productionEnabled: false });
    const published = parseConnectionDescriptor(JSON.parse(await readFile(join(storageRoot, CONNECTION_DESCRIPTOR_FILE), "utf8")) as unknown);
    expect(published).toEqual(handle.descriptor);
    expect(await readFile(join(storageRoot, INSTANCE_LOCK_FILE), "utf8")).toContain(handle.descriptor.startNonce);

    const health = await httpGet(handle.descriptor, "/v1/health", { token: null });
    expect(health.statusCode).toBe(200);
    expect(health.json).toMatchObject({
      schemaVersion: 1, productionEnabled: false, ok: true, kind: "success",
      payload: { ready: true, serviceVersion: "0.1.0", startNonce: handle.descriptor.startNonce },
    });
    expect(Object.keys((health.json as { payload: Record<string, unknown> }).payload).sort()).toEqual(["ready", "serviceVersion", "startNonce"]);
    expect(health.text).not.toContain(handle.descriptor.bearerToken);
    expect(health.headers["cache-control"]).toBe("no-store");
    expect(health.headers["access-control-allow-origin"]).toBeUndefined();

    const session = await httpGet(handle.descriptor, "/v1/session");
    expect(session.statusCode).toBe(200);
    expect(session.json).toMatchObject({
      sequence: 2,
      productionEnabled: false,
      payload: { serviceVersion: "0.1.0", startNonce: handle.descriptor.startNonce, state: "active" },
    });
  });

  it("stops cleanly, removes only owned artifacts, and is idempotent", async () => {
    const storageRoot = await root();
    const handle = await start({ storageRoot });
    await handle.close();
    await handle.close();
    expect(handle.lifecycle().state).toBe("closed");
    const store = createControlArtifactStore({ root: storageRoot });
    await store.prepare();
    await expect(store.readDescriptor()).rejects.toMatchObject({ code: "ARTIFACT_MISSING" });
    await expect(store.readLock()).rejects.toMatchObject({ code: "ARTIFACT_MISSING" });
    await expect(httpGet(handle.descriptor, "/v1/health", { token: null })).rejects.toBeDefined();
    handles.splice(handles.indexOf(handle), 1);
  });

  it("can retry exact artifact cleanup after a transient shutdown failure", async () => {
    const storageRoot = await root();
    const base = createControlArtifactStore({ root: storageRoot });
    let failOnce = true;
    const store: ControlArtifactStore = Object.freeze({
      prepare: async () => { await base.prepare(); },
      writeDescriptor: async (value) => await base.writeDescriptor(value),
      writeLock: async (value) => await base.writeLock(value),
      readDescriptor: async () => await base.readDescriptor(),
      readLock: async () => await base.readLock(),
      async removeOwned(lease) {
        if (failOnce) {
          failOnce = false;
          throw Object.assign(new Error("transient cleanup fixture"), { code: "EBUSY" });
        }
        await base.removeOwned(lease);
      },
    });
    const handle = await start({ storageRoot, store });
    await expect(handle.close()).rejects.toMatchObject({ code: "EBUSY" });
    expect(handle.lifecycle().state).toBe("draining");
    expect((await base.readDescriptor()).value.startNonce).toBe(handle.descriptor.startNonce);
    expect((await base.readLock()).value.startNonce).toBe(handle.descriptor.startNonce);
    await expect(handle.close()).resolves.toBeUndefined();
    expect(handle.lifecycle().state).toBe("closed");
    await expect(base.readDescriptor()).rejects.toMatchObject({ code: "ARTIFACT_MISSING" });
    await expect(base.readLock()).rejects.toMatchObject({ code: "ARTIFACT_MISSING" });
    handles.splice(handles.indexOf(handle), 1);
  });

  it("adopts a live matching instance instead of creating a duplicate listener", async () => {
    const storageRoot = await root();
    const first = await start({ storageRoot });
    const second = await start({ storageRoot, random: (size) => Buffer.alloc(size, 22) });
    expect(second.startupMode).toBe("adopted");
    expect(second.ownsListener).toBe(false);
    expect(second.descriptor).toEqual(first.descriptor);
    expect(second.lifecycle()).toMatchObject({ state: "ready", startupMode: "adopted", recovery: "identity-adopted" });
    await second.close();
    expect((await httpGet(first.descriptor, "/v1/health", { token: null })).statusCode).toBe(200);
  });

  it("cleans the lock after a port conflict before descriptor publication", async () => {
    const holder = createServer((_request, response) => response.end("held"));
    await new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.listen(0, "127.0.0.1", resolve);
    });
    const address = holder.address();
    if (address === null || typeof address === "string") throw new Error("test holder did not bind");
    const storageRoot = await root();
    await expect(startControlServiceForTest({
      storageRoot,
      clock: () => NOW,
      random: (size) => Buffer.alloc(size, 23),
      port: address.port,
    })).rejects.toMatchObject({ code: "BIND_REFUSED" });
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    const store = createControlArtifactStore({ root: storageRoot });
    await store.prepare();
    await expect(store.readDescriptor()).rejects.toMatchObject({ code: "ARTIFACT_MISSING" });
    await expect(store.readLock()).rejects.toMatchObject({ code: "ARTIFACT_MISSING" });
  });

  it("tears the listener and lock down when descriptor publication fails", async () => {
    const storageRoot = await root();
    let syncs = 0;
    const store = createControlArtifactStore({
      root: storageRoot,
      syncEntry: async () => {
        syncs += 1;
        if (syncs === 2) throw Object.assign(new Error("descriptor barrier fixture"), { code: "EIO" });
      },
    });
    await expect(startControlServiceForTest({
      storageRoot,
      store,
      clock: () => NOW,
      random: (size) => Buffer.alloc(size, 24),
    })).rejects.toMatchObject({ code: "STORAGE_UNSAFE" });
    await expect(store.readDescriptor()).rejects.toMatchObject({ code: "ARTIFACT_MISSING" });
    await expect(store.readLock()).rejects.toMatchObject({ code: "ARTIFACT_MISSING" });
  });

  it("keeps the public start surface ephemeral and production-disabled", async () => {
    const storageRoot = await root();
    const first = await startControlService({ storageRoot });
    handles.push(first);
    expect(first.descriptor.host).toBe("127.0.0.1");
    expect(first.descriptor.port).toBeGreaterThan(0);
    expect(first.lifecycle().productionEnabled).toBe(false);
    const adopted = await startControlService({ storageRoot });
    handles.push(adopted);
    expect(adopted.startupMode).toBe("adopted");
    expect(adopted.descriptor).toEqual(first.descriptor);
  });
});
