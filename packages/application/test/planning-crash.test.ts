import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createSavedPlanningApplication } from "../src/planning.js";
import { openPlanningStorage } from "../src/planning-storage.js";
import type { PlanningProjectView } from "../src/planning-contracts.js";

async function killAndDrain(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done, fail) => {
    const timeout = setTimeout(() => fail(new Error("CRASH_CHILD_NOT_DRAINED")), 5000);
    child.once("exit", () => { clearTimeout(timeout); done(); }); child.kill("SIGKILL");
  });
}
it.each(["before-commit", "after-commit"] as const)("recovers a real killed SQLite owner %s without partial scope authority or duplicate consumption", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "saved-planning-crash-")); await mkdir(join(root, "repository"));
  const child = fork(resolve(import.meta.dirname, "../dist/testing/planning-crash-child.js"), [root, mode], { execPath: process.execPath, execArgv: [], windowsHide: true,
    env: Object.fromEntries(["SYSTEMROOT", "WINDIR", "TEMP", "TMP"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])), silent: true });
  let drained = false, diagnostics = "";
  child.stderr!.on("data", (part) => { diagnostics = `${diagnostics}${part}`.slice(-4000); });
  try {
    const reached = await new Promise<unknown>((done, fail) => {
      const timeout = setTimeout(() => fail(new Error("CRASH_FAULT_DEADLINE")), 15000);
      child.once("message", (value) => { clearTimeout(timeout); done(value); });
      child.once("error", fail); child.once("exit", () => { clearTimeout(timeout); fail(new Error(`CRASH_CHILD_EARLY_EXIT ${diagnostics}`)); });
    });
    expect(reached).toEqual({ kind: mode === "before-commit" ? "uncommitted-seal-journal" : "committed-reply-lost" });
    await killAndDrain(child); drained = true;
    const baseline = JSON.parse(await readFile(join(root, "baseline.json"), "utf8")) as PlanningProjectView;
    const storage = await openPlanningStorage(join(root, "saved"));
    const app = createSavedPlanningApplication({ persistence: storage.persistence, artifactRoot: storage.artifactRoot, operator: { confirm: async () => true, selectRepository: async () => null, selectResult: async () => null } });
    try {
      await app.initialize(); let restored = (await app.snapshot(baseline.projectId)).selected!;
      const observed = await app.observe("crash:seal");
      if (mode === "before-commit") {
        expect(restored.plan).toEqual(baseline.plan); expect(restored.approvals).toEqual(baseline.approvals);
        expect(observed.kind).toBe("not-recorded");
        const sealed = await app.command({ kind: "approve-scope", commandId: "crash:explicit-new-seal", projectId: baseline.projectId, expectedPlanVersion: baseline.plan!.version, scopeRequest: baseline.plan!.scopeApproval!.subject });
        expect(sealed.kind).toBe("committed"); restored = sealed.workspace!.selected!;
      } else { expect(observed.kind).toBe("committed"); }
      expect(restored.plan?.state).toBe("sealed"); expect(restored.approvals[0]?.state).toBe("consumed");
      const repeated = await app.command({ kind: "approve-scope", commandId: "crash:seal", projectId: baseline.projectId, expectedPlanVersion: baseline.plan!.version, scopeRequest: baseline.plan!.scopeApproval!.subject });
      expect(repeated.kind).toBe(mode === "before-commit" ? "not-recorded" : "committed");
      expect((await app.snapshot(baseline.projectId)).selected?.history).toEqual(restored.history);
      const pair = await storage.persistence.transact((tx) => tx.aggregates.get("approval-request", restored.approvals[0]!.approvalId));
      expect((pair!.payload as { record: { consumptionCount: number } }).record.consumptionCount).toBe(1);
    } finally { await app.drain(); await storage.close(); }
  } finally {
    await killAndDrain(child); drained = true;
    if (drained && resolve(root).startsWith(join(resolve(tmpdir()), "saved-planning-crash-"))) await rm(root, { recursive: true, force: true });
  }
}, 25000);
