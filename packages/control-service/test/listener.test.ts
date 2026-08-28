import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
  type ControlServiceBootstrap,
  type ControlServiceHandle,
} from "../src/index.js";
import { projectionDataset, startControlServiceForTest } from "./testing.js";
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

function startupSentence(input: ControlServiceBootstrap): string {
  return input.mode === "adopted"
    ? `Reconnecting to ${input.runningSessions} running sessions`
    : `${input.stoppedByRestart} sessions were stopped by the restart — checking their work`;
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
    expect(handle.bootstrap).toEqual({
      scope: "client-attachment",
      mode: "fresh",
      presentationMode: "normal",
      stoppedByRestart: 0,
    });
    expect(startupSentence(handle.bootstrap)).toBe(
      "0 sessions were stopped by the restart — checking their work",
    );
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
      payload: {
        ready: true,
        serviceVersion: "0.1.0",
        startNonce: handle.descriptor.startNonce,
        presentationMode: "normal",
      },
    });
    expect(Object.keys((health.json as { payload: Record<string, unknown> }).payload).sort()).toEqual([
      "presentationMode", "ready", "serviceVersion", "startNonce",
    ]);
    expect(health.text).not.toContain(handle.descriptor.bearerToken);
    expect(health.headers["cache-control"]).toBe("no-store");
    expect(health.headers["access-control-allow-origin"]).toBeUndefined();

    const session = await httpGet(handle.descriptor, "/v1/session");
    expect(session.statusCode).toBe(200);
    expect(session.json).toMatchObject({
      sequence: 2,
      productionEnabled: false,
      payload: {
        serviceVersion: "0.1.0",
        startNonce: handle.descriptor.startNonce,
        presentationMode: "normal",
        runningSessions: 0,
        state: "active",
      },
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
    const activeDataset = projectionDataset(NOW);
    (activeDataset["health"] as Record<string, unknown>)["runningSessions"] = 3;
    const first = await start({ storageRoot, projectionDataset: activeDataset });
    const unusedAdopterDataset = projectionDataset(NOW);
    (unusedAdopterDataset["health"] as Record<string, unknown>)["startupMode"] = "adopted";
    (unusedAdopterDataset["health"] as Record<string, unknown>)["runningSessions"] = 9_999;
    const second = await start({
      storageRoot,
      random: (size) => Buffer.alloc(size, 22),
      projectionDataset: unusedAdopterDataset,
    });
    expect(second.startupMode).toBe("adopted");
    expect(second.bootstrap).toEqual({
      scope: "client-attachment",
      mode: "adopted",
      presentationMode: "normal",
      runningSessions: 3,
    });
    expect(startupSentence(second.bootstrap)).toBe("Reconnecting to 3 running sessions");
    expect(second.ownsListener).toBe(false);
    expect(second.descriptor).toEqual(first.descriptor);
    expect(second.lifecycle()).toMatchObject({ state: "ready", startupMode: "adopted", recovery: "identity-adopted" });
    await second.close();
    expect((await httpGet(first.descriptor, "/v1/health", { token: null })).statusCode).toBe(200);
    const processHealth = await httpGet(first.descriptor, "/v1/projections/health");
    expect((processHealth.json as { payload: Record<string, unknown> }).payload).toMatchObject({
      startup: {
        scope: "service-process",
        mode: "fresh",
        stoppedByRestart: 0,
        recoveredSessions: 0,
        unresolvedRuns: 0,
        unconfirmedSessions: 0,
        sweepCompletedAt: null,
      },
    });
  });

  it("refuses cross-presentation adoption before any projection can be consumed", async () => {
    for (const [existingMode, requestedMode] of [
      ["developer", "normal"],
      ["normal", "developer"],
    ] as const) {
      const storageRoot = await root();
      const first = await start({ storageRoot, presentationMode: existingMode });
      await expect(startControlServiceForTest({
        storageRoot,
        clock: () => NOW,
        random: (size) => Buffer.alloc(size, 29),
        presentationMode: requestedMode,
        projectionDataset: projectionDataset(NOW),
      })).rejects.toMatchObject({ code: "ADOPTION_REFUSED" });

      const existingHealth = await httpGet(first.descriptor, "/v1/projections/health");
      const existingPayload = (existingHealth.json as { payload: Record<string, unknown> }).payload;
      expect(first.descriptor.presentationMode).toBe(existingMode);
      if (existingMode === "developer") expect(existingPayload).toHaveProperty("pid");
      else expect(existingPayload).not.toHaveProperty("pid");
      await first.close();
      handles.splice(handles.indexOf(first), 1);
    }
  });

  it("reports the actual mode when a matching Developer client adopts", async () => {
    const storageRoot = await root();
    const first = await start({ storageRoot, presentationMode: "developer" });
    const second = await start({ storageRoot, presentationMode: "developer" });
    expect(second.bootstrap).toEqual({
      scope: "client-attachment",
      mode: "adopted",
      presentationMode: "developer",
      runningSessions: 0,
    });
    expect(second.descriptor.presentationMode).toBe("developer");
    expect(second.descriptor).toEqual(first.descriptor);
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
    const first = await startControlService({
      storageRoot,
      presentationMode: "normal",
      projectionDataset: projectionDataset(NOW),
    });
    handles.push(first);
    expect(first.descriptor.host).toBe("127.0.0.1");
    expect(first.descriptor.port).toBeGreaterThan(0);
    expect(first.lifecycle().productionEnabled).toBe(false);
    const adopted = await startControlService({
      storageRoot,
      presentationMode: "normal",
      projectionDataset: projectionDataset(NOW),
    });
    handles.push(adopted);
    expect(adopted.startupMode).toBe("adopted");
    expect(adopted.descriptor).toEqual(first.descriptor);
  });

  it("refuses unknown public composition fields and cleans invalid fresh datasets without residue", async () => {
    const storageRoot = await root();
    await expect(startControlService({
      storageRoot,
      presentationMode: "normal",
      projectionDataset: projectionDataset(NOW),
      transport: "caller-controlled",
    } as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await readdir(storageRoot)).toEqual([]);

    const invalid = projectionDataset(NOW);
    invalid["unexpected"] = true;
    await expect(startControlService({
      storageRoot,
      presentationMode: "normal",
      projectionDataset: invalid,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await readdir(storageRoot)).toEqual([]);

    const falseStartup = projectionDataset(NOW);
    (falseStartup["health"] as Record<string, unknown>)["startupMode"] = "adopted";
    await expect(startControlService({
      storageRoot,
      presentationMode: "normal",
      projectionDataset: falseStartup,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await readdir(storageRoot)).toEqual([]);
  });
});
