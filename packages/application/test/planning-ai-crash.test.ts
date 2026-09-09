import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createSavedPlanningApplication } from "../src/planning.js";
import { openPlanningStorage } from "../src/planning-storage.js";
import { createOwnedAiTestPort } from "../src/testing/planning-ai-fixture.js";
import { listPlanningAggregates } from "../src/planning-ledger.js";

async function killAndDrain(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done, fail) => { const timer = setTimeout(() => fail(new Error("AI_CRASH_CHILD_UNDRAINED")), 5000); child.once("exit", () => { clearTimeout(timer); done(); }); child.kill("SIGKILL"); });
}
it.each(["after-admission", "after-dispatch", "before-terminal", "after-terminal"] as const)("reopens a killed real Windows SQLite owner %s without resending or inventing unused allowance", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "ai-planning-crash-")); await mkdir(join(root, "repository"));
  const child = fork(resolve(import.meta.dirname, "../dist/testing/planning-ai-crash-child.js"), [root, mode], { execPath: process.execPath, execArgv: [], windowsHide: true, silent: true,
    env: Object.fromEntries(["SYSTEMROOT", "WINDIR", "TEMP", "TMP"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])) });
  let diagnostics = ""; child.stderr!.on("data", (value) => { diagnostics = `${diagnostics}${value}`.slice(-4000); });
  try {
    const phase = await new Promise<unknown>((done, fail) => { const timer = setTimeout(() => fail(new Error(`AI_CRASH_PHASE_DEADLINE ${diagnostics}`)), 15000);
      child.once("message", (message) => { clearTimeout(timer); done(message); }); child.once("error", fail); child.once("exit", () => { clearTimeout(timer); fail(new Error(`AI_CRASH_EARLY_EXIT ${diagnostics}`)); }); });
    expect(phase).toEqual({ kind: mode }); await killAndDrain(child);
    const baseline = JSON.parse(await readFile(join(root, "baseline.json"), "utf8")), storage = await openPlanningStorage(join(root, "saved")), port = createOwnedAiTestPort();
    const app = createSavedPlanningApplication({ persistence: storage.persistence, artifactRoot: storage.artifactRoot, planningProcess: port.host, operator: { confirm: async () => true, selectRepository: async () => null, selectResult: async () => null } });
    try {
      await app.initialize(); const p = (await app.snapshot(baseline.projectId)).selected!, s = p.aiPlanning.currentSession!;
      expect(s.sessionId).toBe(baseline.sessionId); expect(s.requestCount).toBe(1); expect(s.activeRequestId).toBeNull(); expect(port.dispatched).toHaveLength(0);
      expect(await app.observe("crash:ai-request")).toMatchObject({ kind: "committed" });
      expect(s.requests[0]).toMatchObject({ state: mode === "after-terminal" ? "succeeded" : mode === "after-admission" ? "refused" : "outcome-unknown", usageState: mode === "after-terminal" ? "reported" : mode === "after-admission" ? "not-called" : "unknown" });
      expect(s.draft.understanding === null).toBe(mode !== "after-terminal");
      const contributions = await storage.persistence.transact((tx) => listPlanningAggregates(tx, "planning-ai-contribution")); expect(contributions).toHaveLength(mode === "after-terminal" ? 1 : 0);
      await app.snapshot(baseline.projectId); expect(port.dispatched).toHaveLength(0); expect(p.brief).toBeNull(); expect(p.plan).toBeNull();
    } finally { await app.drain(); await storage.close(); }
  } finally { await killAndDrain(child); if (!resolve(root).startsWith(join(resolve(tmpdir()), "ai-planning-crash-"))) throw new Error("AI_CRASH_ROOT_UNOWNED"); await rm(root, { recursive: true, force: true }); }
}, 25000);
