import { lstat, mkdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { createSqlitePersistenceAdapter } from "@ai-dev-os/persistence-sqlite";
import type { PersistenceAdapter } from "@ai-dev-os/persistence";
import { canonicalPlanningDirectory } from "./planning-repository.js";

/** The application's durable planning store, independent of transport artifacts. */
export interface PlanningStorage {
  readonly persistence: PersistenceAdapter;
  readonly artifactRoot: string;
  close(): Promise<void>;
}

export async function openPlanningStorage(dataRoot: string): Promise<PlanningStorage> {
  if (!isAbsolute(dataRoot) || process.platform === "win32" && (!/^[A-Za-z]:[\\/]/u.test(dataRoot) || dataRoot.slice(2).includes(":"))) throw new Error("PLANNING_DATA_ROOT_INVALID");
  // Refuse an existing link before recursive mkdir could create a directory
  // through it. Post-creation canonical checks alone are too late.
  let existing = resolve(dataRoot);
  for (let count = 0; ; count++) {
    if (count >= 128) throw new Error("PLANNING_DATA_ROOT_INVALID");
    try { await lstat(existing); await canonicalPlanningDirectory(existing); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(existing); if (parent === existing) throw new Error("PLANNING_DATA_ROOT_INVALID"); existing = parent;
  }
  await mkdir(resolve(dataRoot), { recursive: true });
  const root = await canonicalPlanningDirectory(dataRoot);
  const artifactRoot = join(root, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  await canonicalPlanningDirectory(artifactRoot);
  for (const name of ["planning.sqlite", "planning.sqlite-journal", "planning.sqlite-wal", "planning.sqlite-shm"]) {
    try { const value = await lstat(join(root, name)); if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1) throw new Error("PLANNING_DATABASE_LINK_REFUSED"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  // The OS owns this exclusive lifetime lock. A killed Windows child releases
  // it automatically; timestamps and abandoned command intents grant no lease.
  const identity = createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex");
  const socket = process.platform === "win32" ? `\\\\.\\pipe\\ai-dev-os-planning-${identity}` : process.platform === "linux" ? `\0ai-dev-os-planning-${identity}` : join(root, "planning-owner.sock");
  const owner = createServer((connection) => connection.destroy());
  await new Promise<void>((resolveOwner, rejectOwner) => { owner.once("error", rejectOwner); owner.listen(socket, () => { owner.removeListener("error", rejectOwner); resolveOwner(); }); });
  // Acknowledged decisions and their journals require FULL durability. Keep the
  // general adapter's WAL/NORMAL default unchanged for its other consumers.
  const release = async (): Promise<void> => {
    await new Promise<void>((resolveOwner, rejectOwner) => owner.close((error) => error === undefined ? resolveOwner() : rejectOwner(error)));
    if (process.platform !== "win32" && process.platform !== "linux") { try { await unlink(socket); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  };
  try {
    const persistence = createSqlitePersistenceAdapter({ file: join(root, "planning.sqlite"), journalMode: "delete" });
    let closing: Promise<void> | null = null;
    return Object.freeze({ persistence, artifactRoot, close: () => closing ??= (async () => { try { await persistence.close(); } finally { await release(); } })() });
  } catch (error) { await release(); throw error; }
}
