import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONNECTION_DESCRIPTOR_FILE,
  INSTANCE_LOCK_FILE,
  ControlServiceError,
  createControlArtifactStore,
  createLaunchIdentity,
  establishSingleInstance,
  type ConnectionDescriptor,
  type InstanceLock,
} from "../src/index.js";

const roots: string[] = [];
const NOW = "2026-08-26T10:00:00.000Z";

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "ai-dev-os-c3-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  for (const value of roots.splice(0)) await rm(value, { recursive: true, force: true });
});

function pair(processId = 700, byte = 3): { descriptor: ConnectionDescriptor; lock: InstanceLock } {
  const identity = createLaunchIdentity({ now: NOW, random: (size) => Buffer.alloc(size, byte) });
  const common = { schemaVersion: 1 as const, serviceVersion: "0.1.0", processId, startNonce: identity.startNonce, issuedAt: identity.issuedAt };
  return {
    descriptor: { ...common, host: "127.0.0.1", port: 41111, bearerToken: identity.bearerToken, expiresAt: identity.expiresAt },
    lock: common,
  };
}

describe("C3 exact-name artifact store", () => {
  it("uses create-only promotion, exact reads, and identity-bound cleanup", async () => {
    const directory = await root();
    const store = createControlArtifactStore({ root: directory });
    await store.prepare();
    const values = pair();
    const descriptorLease = await store.writeDescriptor(values.descriptor);
    const lockLease = await store.writeLock(values.lock);
    await expect(store.writeDescriptor(values.descriptor)).rejects.toMatchObject({ code: "ARTIFACT_CONFLICT" });
    expect((await store.readDescriptor()).value).toEqual(values.descriptor);
    expect((await store.readLock()).value).toEqual(values.lock);
    expect((await readFile(join(directory, CONNECTION_DESCRIPTOR_FILE), "utf8"))).not.toContain("extra");
    await store.removeOwned(descriptorLease);
    await store.removeOwned(lockLease);
    await expect(store.readDescriptor()).rejects.toMatchObject({ code: "ARTIFACT_MISSING" });
  });

  it("refuses oversized, malformed, linked, and replaced exact artifacts", async () => {
    const directory = await root();
    const store = createControlArtifactStore({ root: directory });
    await store.prepare();
    const values = pair();
    await writeFile(join(directory, CONNECTION_DESCRIPTOR_FILE), "x".repeat(5_000), "utf8");
    await expect(store.readDescriptor()).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
    await unlink(join(directory, CONNECTION_DESCRIPTOR_FILE));
    const lease = await store.writeDescriptor(values.descriptor);
    await unlink(join(directory, CONNECTION_DESCRIPTOR_FILE));
    await writeFile(join(directory, CONNECTION_DESCRIPTOR_FILE), JSON.stringify(values.descriptor), "utf8");
    await expect(store.removeOwned(lease)).rejects.toMatchObject({ code: "ARTIFACT_FOREIGN" });
    expect(await readFile(join(directory, CONNECTION_DESCRIPTOR_FILE), "utf8")).toContain(values.descriptor.startNonce);
    await unlink(join(directory, CONNECTION_DESCRIPTOR_FILE));
    const outside = join(directory, "outside.json");
    await writeFile(outside, JSON.stringify(values.descriptor), "utf8");
    try {
      await symlink(outside, join(directory, CONNECTION_DESCRIPTOR_FILE), "file");
      await expect(store.readDescriptor()).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EPERM")) throw error;
    }
  });

  it("removes only its just-promoted identity when the durability barrier fails", async () => {
    const directory = await root();
    const store = createControlArtifactStore({
      root: directory,
      syncEntry: async () => { throw Object.assign(new Error("test barrier"), { code: "EIO" }); },
    });
    await store.prepare();
    await expect(store.writeDescriptor(pair().descriptor)).rejects.toMatchObject({ code: "STORAGE_UNSAFE" });
    await expect(store.readDescriptor()).rejects.toMatchObject({ code: "ARTIFACT_MISSING" });
  });

  it("refuses linked roots, UNC/device roots, and alternate-stream syntax", async () => {
    expect(() => createControlArtifactStore({ root: "\\\\server\\share\\control" })).toThrow();
    expect(() => createControlArtifactStore({ root: "\\\\?\\C:\\control" })).toThrow();
    if (process.platform === "win32") expect(() => createControlArtifactStore({ root: "C:\\control:stream" })).toThrow();
    const parent = await root();
    const actual = join(parent, "actual");
    const linked = join(parent, "linked");
    const actualStore = createControlArtifactStore({ root: actual });
    await actualStore.prepare();
    try {
      await symlink(actual, linked, process.platform === "win32" ? "junction" : "dir");
      await expect(createControlArtifactStore({ root: linked }).prepare()).rejects.toMatchObject({ code: "STORAGE_UNSAFE" });
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EPERM")) throw error;
    }
  });
});

describe("C3 single-instance ownership", () => {
  it("acquires a fresh lock without consulting liveness", async () => {
    const directory = await root();
    const store = createControlArtifactStore({ root: directory });
    await store.prepare();
    let inspected = false;
    const result = await establishSingleInstance({
      store,
      requestedLock: pair(699, 2).lock,
      liveness: { inspect: async () => { inspected = true; return "ambiguous"; } },
    });
    expect(result.kind).toBe("acquired");
    expect(inspected).toBe(false);
  });

  it("acquires once and refuses a concurrent ambiguous owner regardless of age", async () => {
    const directory = await root();
    const store = createControlArtifactStore({ root: directory });
    await store.prepare();
    const old = pair(701, 4);
    await store.writeLock({ ...old.lock, issuedAt: "2020-01-01T00:00:00.000Z" });
    await store.writeDescriptor({ ...old.descriptor, issuedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-01-01T00:15:00.000Z" });
    await expect(establishSingleInstance({ store, requestedLock: pair(702, 5).lock, liveness: { inspect: async () => "ambiguous" } }))
      .rejects.toMatchObject({ code: "LIVENESS_AMBIGUOUS" });
    expect((await store.readLock()).value.processId).toBe(701);
  });

  it("adopts only a live matching owner and refuses PID-reuse/foreign evidence", async () => {
    const directory = await root();
    const store = createControlArtifactStore({ root: directory });
    await store.prepare();
    const old = pair(703, 6);
    await store.writeLock(old.lock);
    await store.writeDescriptor(old.descriptor);
    const adopted = await establishSingleInstance({ store, requestedLock: pair(704, 7).lock, liveness: { inspect: async () => "live" } });
    expect(adopted).toEqual({ kind: "adopt", descriptor: old.descriptor });
    await unlink(join(directory, CONNECTION_DESCRIPTOR_FILE));
    await writeFile(join(directory, CONNECTION_DESCRIPTOR_FILE), JSON.stringify(pair(703, 8).descriptor), "utf8");
    await expect(establishSingleInstance({ store, requestedLock: pair(704, 7).lock, liveness: { inspect: async () => "live" } }))
      .rejects.toSatisfy((error: unknown) => error instanceof ControlServiceError && ["ARTIFACT_FOREIGN", "ARTIFACT_INVALID"].includes(error.code));
  });

  it("replaces only matching artifacts after affirmative dead-PID evidence", async () => {
    const directory = await root();
    const store = createControlArtifactStore({ root: directory });
    await store.prepare();
    const old = pair(705, 9);
    const fresh = pair(706, 10);
    await store.writeLock(old.lock);
    await store.writeDescriptor(old.descriptor);
    const result = await establishSingleInstance({ store, requestedLock: fresh.lock, liveness: { inspect: async (pid) => pid === 705 ? "dead" : "ambiguous" } });
    expect(result.kind).toBe("acquired");
    expect((await store.readLock()).value).toEqual(fresh.lock);
    await expect(store.readDescriptor()).rejects.toMatchObject({ code: "ARTIFACT_MISSING" });
  });

  it.each(["live", "dead"] as const)("refuses a %s lock whose matching descriptor is missing", async (status) => {
    const directory = await root();
    const store = createControlArtifactStore({ root: directory });
    await store.prepare();
    await store.writeLock(pair(707, 13).lock);
    await expect(establishSingleInstance({
      store,
      requestedLock: pair(708, 14).lock,
      liveness: { inspect: async () => status },
    })).rejects.toMatchObject({ code: status === "live" ? "ARTIFACT_FOREIGN" : "ARTIFACT_INVALID" });
  });
});
