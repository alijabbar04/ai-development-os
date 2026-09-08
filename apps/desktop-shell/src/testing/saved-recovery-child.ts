import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { runOwnedServiceChild } from "../service/child.js";
import { canonicalServicePath } from "../service/storage-paths.js";
import { exactPlanningRecord } from "../shared/planning-ipc.js";

// Synthetic time is available only in this separately launched fixture entry.
// The parent must fully stop the app and edit its owned marker before reopening;
// no renderer command, production environment variable or live clock setter exists.
runOwnedServiceChild(async (dataRoot) => {
  const root = await canonicalServicePath(dirname(resolve(dataRoot))), parent = dirname(root);
  if (basename(root) !== "owned-saved-recovery-user-data" || !basename(parent).startsWith("ai-dev-os-desktop-saved-smoke-")
    || basename(dataRoot) !== "saved-workspace") throw new Error("RECOVERY_CLOCK_FIXTURE_NOT_OWNED");
  const marker = join(root, "synthetic-clock.json"), stat = await lstat(marker);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256) throw new Error("RECOVERY_CLOCK_FIXTURE_INVALID");
  const value = exactPlanningRecord(JSON.parse(await readFile(marker, "utf8")), ["kind", "at"]);
  if (value["kind"] !== "owned-saved-recovery-clock" || !["2026-09-08T00:00:00.000Z", "2026-09-09T00:00:00.000Z"].includes(String(value["at"]))) throw new Error("RECOVERY_CLOCK_FIXTURE_INVALID");
  const at = String(value["at"]);
  return { now: () => new Date(at) };
});
