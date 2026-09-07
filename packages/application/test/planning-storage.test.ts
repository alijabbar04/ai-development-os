import { access, lstat, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openPlanningStorage } from "../src/planning-storage.js";

const owned: string[] = [];
afterEach(async () => {
  for (const root of owned.splice(0)) {
    const canonical = await realpath(root), parent = await realpath(tmpdir());
    if (dirname(canonical).toLowerCase() !== parent.toLowerCase() || !basename(root).startsWith("saved-storage-boundary-") || (await lstat(root)).isSymbolicLink()) throw new Error("STORAGE_FIXTURE_NOT_OWNED");
    await rm(canonical, { recursive: true });
  }
});
it("rejects an ancestor junction before making any directory through the link", async () => {
  const root = await mkdtemp(join(tmpdir(), "saved-storage-boundary-")); owned.push(root);
  const target = join(root, "outside-grant"), alias = join(root, "alias"); await mkdir(target);
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
  await expect(openPlanningStorage(join(alias, "new", "saved"))).rejects.toThrow();
  await expect(access(join(target, "new"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("creates and reopens a new nested owned directory and releases its exclusive lifetime owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "saved-storage-boundary-")); owned.push(root);
  const path = join(root, "new", "saved"), first = await openPlanningStorage(path);
  await first.persistence.transact((tx) => tx.aggregates.create({ aggregateType: "planning-workspace", aggregateId: "storage:owned", schemaVersion: 1, payload: { owned: true } }));
  await expect(openPlanningStorage(path)).rejects.toMatchObject({ code: "EADDRINUSE" });
  await first.close(); const second = await openPlanningStorage(path);
  try { expect((await second.persistence.transact((tx) => tx.aggregates.get("planning-workspace", "storage:owned")))?.payload).toEqual({ owned: true }); }
  finally { await second.close(); }
});
