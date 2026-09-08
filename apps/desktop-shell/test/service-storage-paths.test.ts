import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createOwnedServiceController, type OwnedServiceController } from "../src/service/controller.js";
import { canonicalServicePath } from "../src/service/storage-paths.js";
import { resolveOwnedNodeRuntime } from "../src/main/owned-runtime.js";

const roots: string[] = [], controllers: OwnedServiceController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.stop().catch(() => undefined);
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), "desktop-storage-boundary-"))) throw new Error("UNOWNED_FIXTURE");
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "desktop-storage-boundary-")); roots.push(root); return root; }
async function controller(storageParent: string, dataRoot: string): Promise<OwnedServiceController> {
  const appRoot = resolve(import.meta.dirname, "..");
  const value = createOwnedServiceController({ storageParent, dataRoot, initialMode: "normal", childPath: join(appRoot, "dist", "service", "child.js"), execPath: process.platform === "win32" ? await resolveOwnedNodeRuntime(appRoot) : process.execPath });
  controllers.push(value); return value;
}
function shortPath(root: string): string {
  // Native FOR expansion avoids starting PowerShell and COM for an owned fixture.
  // Keep input/output quoted and delayed expansion off for literal path characters.
  const output = execFileSync("cmd.exe", ["/d", "/v:off", "/s", "/c", 'for %I in ("%AI_DEV_OS_OWNED_ALIAS_FIXTURE%") do @echo "%~sI"'], {
    env: { ...process.env, AI_DEV_OS_OWNED_ALIAS_FIXTURE: root }, encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true, timeout: 5_000, maxBuffer: 16_384,
  }).trim();
  if (!/^"[^"\r\n]+"$/.test(output)) throw new Error("INVALID_OWNED_SHORT_PATH");
  return output.slice(1, -1);
}

it("resolves a missing descendant without creating it", async () => {
  const root = await fixture(), next = join(root, "absent", "runtime");
  expect(await canonicalServicePath(next)).toBe(join(await realpath(root), "absent", "runtime"));
  await expect(access(join(root, "absent"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["transport", "durable"] as const)("refuses a %s ancestor link before creating descendants", async (kind) => {
  const root = await fixture(), outside = join(root, "retained"), alias = join(root, "linked");
  await mkdir(outside); await symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
  const service = await controller(kind === "transport" ? join(alias, "new-runtime") : join(root, "runtime"), kind === "durable" ? join(alias, "new-data") : join(root, "saved"));
  await expect(service.start()).rejects.toThrow("SERVICE_STORAGE_UNSAFE");
  expect(service.ownedProcessIdForTest()).toBeNull();
  await expect(access(join(outside, kind === "transport" ? "new-runtime" : "new-data"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.runIf(process.platform === "win32")("starts and reopens the actual pinned child through an 8.3 storage alias", async () => {
  const root = await fixture(), canonical = await realpath(root), alias = shortPath(root);
  expect(alias.toLowerCase()).not.toBe(canonical.toLowerCase());
  expect((await realpath(alias)).toLowerCase()).toBe(canonical.toLowerCase());
  const service = await controller(join(alias, "runtime"), join(alias, "saved"));
  await service.start();
  expect(service.snapshot().phase).toBe("ready");
  const state = await service.planning({ kind: "snapshot", projectId: null });
  const runtime = service.ownedRuntimeRootForTest()!;
  expect(runtime).toBe(await realpath(runtime));
  await service.terminateOwnedChildForTest(); await service.retry();
  expect(await service.planning({ kind: "snapshot", projectId: null })).toEqual(state);
  await expect(access(runtime)).rejects.toMatchObject({ code: "ENOENT" });
  await service.stop();
  expect((await readFile(join(canonical, "saved", "planning.sqlite"))).length).toBeGreaterThan(0);
}, 30_000);

it.runIf(process.platform === "win32")("refuses durable overlap hidden by an 8.3 alias before making a transport root", async () => {
  const root = await fixture(), canonical = await realpath(root), alias = shortPath(root);
  expect(alias.toLowerCase()).not.toBe(canonical.toLowerCase());
  const service = await controller(join(alias, "saved", "runtime"), join(canonical, "saved"));
  await expect(service.start()).rejects.toThrow("SERVICE_DURABLE_ROOT_OVERLAP");
  expect(service.ownedProcessIdForTest()).toBeNull();
  await expect(access(join(canonical, "saved"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves an unknown replacement of its transport directory on shutdown", async () => {
  const root = await fixture(), service = await controller(join(root, "runtime"), join(root, "saved"));
  await service.start();
  const runtime = service.ownedRuntimeRootForTest()!, retained = join(root, "retained-original-runtime");
  await rename(runtime, retained); await mkdir(runtime); await writeFile(join(runtime, "unknown.txt"), "preserve this unrelated replacement", { flag: "wx" });
  await expect(service.stop()).rejects.toThrow("SERVICE_ROOT_OWNERSHIP_REFUSED");
  expect(service.ownedProcessIdForTest()).toBeNull();
  expect(await readFile(join(runtime, "unknown.txt"), "utf8")).toBe("preserve this unrelated replacement");
}, 30_000);
