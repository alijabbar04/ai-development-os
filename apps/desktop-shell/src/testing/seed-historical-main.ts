import { basename, isAbsolute, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { seedOwnedPlanningHistoryForTesting, verifyOwnedPlanningHistoryForTesting } from "@ai-dev-os/application/testing";
import { createSavedPlanningApplication } from "@ai-dev-os/application/planning";
import type { PlanningProjectView } from "@ai-dev-os/application/planning-contracts";
import { openPlanningStorage } from "@ai-dev-os/application/planning-storage";

const root = process.argv[2]!;
if (!isAbsolute(root) || !basename(root).startsWith("ai-dev-os-desktop-saved-smoke-") || process.versions.electron !== undefined) throw new Error("HISTORY_REQUIRES_OWNED_NODE_FIXTURE");
const storage = await openPlanningStorage(join(root, "user-data", "saved-workspace"));
const app = createSavedPlanningApplication({ persistence: storage.persistence, artifactRoot: storage.artifactRoot, operator: { confirm: async () => true, selectRepository: async () => null, selectResult: async () => null } });
try {
  await app.initialize();
  if (process.argv[3] === "--verify-result") {
    const fixture = JSON.parse(await readFile(join(root, "historical-fixture.json"), "utf8")) as Awaited<ReturnType<typeof seedOwnedPlanningHistoryForTesting>> & { projectId: string; originalPlan: PlanningProjectView["plan"]; originalScopeApproval: PlanningProjectView["approvals"][number] };
    const proof = await verifyOwnedPlanningHistoryForTesting(storage.persistence, fixture), saved = (await app.snapshot(fixture.projectId)).selected!;
    if (!saved.stopped || JSON.stringify(saved.plan) !== JSON.stringify(fixture.originalPlan) || JSON.stringify(saved.approvals.find((row) => row.approvalId === fixture.originalScopeApproval.approvalId)) !== JSON.stringify(fixture.originalScopeApproval)) throw new Error("HISTORY_SAVED_CONTEXT_CHANGED");
    process.stdout.write(`${JSON.stringify({ ok: true, kind: "owned-synthetic-history-verification", ...proof, stillStopped: true, planUnchanged: true, scopeApprovalUnchanged: true })}\n`);
  } else {
  const initial = await app.snapshot(null);
  if (initial.projects.length !== 1) throw new Error("HISTORY_FIXTURE_PROJECT_REQUIRED");
  const projectId = initial.projects[0]!.projectId, original = (await app.snapshot(projectId)).selected!;
  if (original.plan?.state !== "sealed" || original.stopped) throw new Error("HISTORY_FIXTURE_SEALED_PROJECT_REQUIRED");
  const seeded = await seedOwnedPlanningHistoryForTesting(storage.persistence, projectId, "synthetic-history:electron");
  const changed = (await app.snapshot(projectId)).selected!;
  const stop = await app.command({ kind: "stop-project", commandId: "synthetic-history:electron-stop", projectId, expectedProjectVersion: changed.version });
  if (stop.kind !== "committed") throw new Error("HISTORY_FIXTURE_STOP_FAILED");
  const p = stop.workspace!.selected!, historical = p.approvals.find((approval) => approval.approvalId === seeded.approvalId)!;
  if (!historical.context.includes("bindings have changed") || !historical.context.includes("stopped") || !historical.actions.includes("report-executed")) throw new Error("HISTORY_FIXTURE_CONTEXT_NOT_EXPOSED");
  await writeFile(join(root, "historical-fixture.json"), JSON.stringify({ schemaVersion: 1, ...seeded, projectId, project: p, originalPlan: original.plan, originalScopeApproval: original.approvals[0] }), { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ ok: true, kind: "owned-synthetic-history-fixture", projectId, approvalId: seeded.approvalId, provenance: seeded.fixtureProvenance })}\n`);
  }
} finally { await app.drain(); await storage.close(); }
