import { mkdtemp, mkdir, readFile, rm, writeFile, link, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSavedPlanningApplication, type PlanningNativeReview, type SavedPlanningApplication } from "../src/planning.js";
import { openPlanningStorage, type PlanningStorage } from "../src/planning-storage.js";
import type { PlanningCommand, PlanningCommandResult, PlanningProjectView } from "../src/planning-contracts.js";
import { createPlanningApprovalOwner, readPlanningApprovalControls, readPlanningApprovalPair, verifyPlanningMoneyHistory } from "../src/planning-approval.js";
import { digestPlanning, planningHash } from "../src/planning-validation.js";
import { parsePlanningHandover } from "../src/planning-handover.js";
import { seedOwnedPlanningHistoryForTesting } from "../src/testing/planning-history-fixture.js";
import { readPlanningFoundations } from "../src/planning-plan.js";
import { observePlanningReceipt, recordPlanningIntent, type PlanningConfirmation } from "../src/planning-ledger.js";
import { parseApprovalOperation, prepareApprovalRequest, type ApprovalBinding, type ApprovalOperationKind } from "@ai-dev-os/approval";
import { parseProject } from "@ai-dev-os/project";
import { canonicalizeWithChecksum } from "@ai-dev-os/persistence";

const owned: { root: string; app: SavedPlanningApplication; store: PlanningStorage }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0)) {
    await item.app.drain(); await item.store.close();
    if (!item.root.startsWith(join(tmpdir(), "saved-planning-test-"))) throw new Error("FIXTURE_ROOT_NOT_OWNED");
    await rm(item.root, { recursive: true, force: true });
  }
});
async function fixture(confirm: (review: PlanningNativeReview) => Promise<boolean> = async () => true) {
  const root = await mkdtemp(join(tmpdir(), "saved-planning-test-")), store = await openPlanningStorage(join(root, "saved"));
  await mkdir(join(root, "repository"));
  let resultFile: { name: string; text: string } | null = null;
  const reviews: PlanningNativeReview[] = [];
  const fault: { event: string | null; loseNextCommittedReply: boolean } = { event: null, loseNextCommittedReply: false };
  const diagnosticPersistence = { ...store.persistence, async transact<T>(work: Parameters<typeof store.persistence.transact<T>>[0]): Promise<T> {
    let completed = false;
    const value = await store.persistence.transact((base) => work({ ...base, events: { ...base.events, async append(input) {
      if (input.eventType === fault.event) { fault.event = null; throw new Error("SYNTHETIC_JOURNAL_FAILURE"); }
      if (input.eventType === "planning-command.completed") completed = true;
      return await base.events.append(input);
    } } }));
    if (completed && fault.loseNextCommittedReply) { fault.loseNextCommittedReply = false; throw new Error("SYNTHETIC_ACK_LOST_AFTER_COMMIT"); }
    return value;
  } };
  const app = createSavedPlanningApplication({ persistence: diagnosticPersistence, artifactRoot: store.artifactRoot, operator: {
    async confirm(review) { reviews.push(review); return await confirm(review); }, async selectRepository() { return join(root, "repository"); }, async selectResult() { return resultFile; },
  } });
  await app.initialize(); owned.push({ root, app, store });
  return { root, app, store, reviews, fault, setResultFile(value: { name: string; text: string }) { resultFile = value; } };
}
let ordinal = 0;
const id = (): string => `test-command:${++ordinal}`;
async function committed(app: SavedPlanningApplication, command: PlanningCommand): Promise<PlanningProjectView> {
  const value = await app.command(command);
  expect(value, JSON.stringify({ command: command.kind, value })).toMatchObject({ kind: "committed", reason: null });
  expect(value.workspace?.selected).not.toBeNull();
  return value.workspace!.selected!;
}
async function project(app: SavedPlanningApplication) {
  return await committed(app, { kind: "create-project", commandId: id(), name: "Garden observations", objective: "Record seasonal garden observations", outcomes: ["Keep a searchable local garden journal"], budgetMinorUnits: 1500, currency: "GBP" });
}
async function accepted(app: SavedPlanningApplication) {
  const p = await project(app);
  expect(p.candidate?.ready).toBe(true);
  return await committed(app, { kind: "accept-brief", commandId: id(), projectId: p.projectId, candidateId: p.candidate!.candidateId, candidateDigest: p.candidate!.digest, expectedBriefVersion: 0 });
}
async function draft(app: SavedPlanningApplication, p: PlanningProjectView, scope: "within-brief" | "scope-expansion" = "scope-expansion") {
  return await committed(app, { kind: "save-plan", commandId: id(), projectId: p.projectId, expectedPlanVersion: p.plan?.version ?? 0, title: "Garden journal foundation", scope,
    tasks: [{ title: "Record observations", objective: scope === "within-brief" ? p.brief!.outcomes[0]! : "Add a seasonal comparison view", acceptanceCriteria: ["An operator can record an observation", "A saved observation is visible after reopening"] }] });
}
// Each case performs a sequence of real DELETE/FULL SQLite commands and reads.
// Bound the whole workflow independently of the application's operation deadlines;
// a default five-second test budget is insufficient on loaded Windows CI hosts.
describe("application-owned saved planning workflow", { timeout: 30_000 }, () => {
  it("saves newly selected bounded repository facts and refuses repository changes during exact scope review", async () => {
    const f = await fixture(); let p = await accepted(f.app);
    const git = join(f.root, "repository", ".git"); await mkdir(join(git, "refs", "heads"), { recursive: true });
    await writeFile(join(git, "HEAD"), "ref: refs/heads/owned-fixture\n");
    await writeFile(join(git, "refs", "heads", "owned-fixture"), "b".repeat(40) + "\n");
    await writeFile(join(f.root, "repository", "package.json"), "{\"name\":\"owned-reference-only\"}");
    p = await committed(f.app, { kind: "select-repository", commandId: id(), projectId: p.projectId, expectedProjectVersion: p.version });
    expect(p.repository).toMatchObject({ branch: "owned-fixture", head: "b".repeat(40), state: "partial" });
    expect(p.repository!.facts.length).toBeGreaterThan(1);
    expect((await f.app.snapshot(p.projectId)).selected?.repository).toEqual(p.repository);
    const proposed = await f.app.command({ kind: "draft-brief", projectId: p.projectId, expectedBriefVersion: p.brief!.version, objective: "A bounded repository planning record", outcomes: ["Reopen the saved repository observation"], audiences: [], nonGoals: [] });
    const candidate = proposed.workspace!.selected!.candidate!;
    p = await committed(f.app, { kind: "accept-brief", commandId: id(), projectId: p.projectId, expectedBriefVersion: p.brief!.version, candidateId: candidate.candidateId, candidateDigest: candidate.digest });
    p = await draft(f.app, p);
    p = await committed(f.app, { kind: "prepare-plan", commandId: id(), projectId: p.projectId, expectedPlanVersion: p.plan!.version });
    expect(await f.app.command({ kind: "select-repository", commandId: id(), projectId: p.projectId, expectedProjectVersion: p.version })).toMatchObject({ kind: "refused", reason: "repository.scope-review-pending" });
    const unchanged = (await f.app.snapshot(p.projectId)).selected!;
    expect(unchanged.repository).toEqual(p.repository); expect(unchanged.plan).toEqual(p.plan); expect(unchanged.approvals).toEqual(p.approvals);
  });
  it.each(["project-shape", "project-identity", "budget-shape", "budget-binding", "stop-shape", "stop-identity"] as const)("refuses saved %s corruption before admitting a new plan", async (kind) => {
    const f = await fixture(), p = await accepted(f.app);
    await f.store.persistence.transact(async (tx) => {
      const facts = await readPlanningFoundations(tx, p.projectId);
      if (kind.startsWith("project")) await tx.aggregates.update({ aggregateType: "project", aggregateId: p.projectId, schemaVersion: 1, expectedVersion: p.version, payload: kind === "project-shape" ? {} : { ...facts.project, projectId: "prj:wrong" } });
      else if (kind.startsWith("budget")) await tx.aggregates.update({ aggregateType: "budget-account", aggregateId: facts.project.budgetAccountId, schemaVersion: 1, expectedVersion: facts.budgetEnvelope.aggregateVersion, payload: kind === "budget-shape" ? {} : { ...facts.budget, scope: { scopeType: "project", scopeId: "prj:wrong" } } });
      else await tx.aggregates.create({ aggregateType: "project-stop", aggregateId: "pst:owned-corrupt", schemaVersion: 1, payload: kind === "stop-shape" ? {} : { schemaVersion: 1, revision: 1, projectStopId: "pst:wrong", projectId: p.projectId, engagedAt: new Date().toISOString(), resumedAt: null, effects: { cancelledTaskIds: [], stoppingSessionIds: [], unconfirmedSessionIds: [], voidedApprovalIds: [], voidedHandoverIds: [], releasedReservationIds: [], retainedReservationIds: [] } } });
    });
    const result = await f.app.command({ kind: "save-plan", commandId: id(), projectId: p.projectId, expectedPlanVersion: 0, title: "Refused plan", scope: "within-brief", tasks: [{ title: "Local task", objective: p.brief!.objective, acceptanceCriteria: ["Does not bypass corrupted authority"] }] });
    expect(result.kind).toBe("corrupt");
    expect(await f.store.persistence.transact(async (tx) => (await tx.aggregates.list({ aggregateType: "project-plan", limit: 10 })).items)).toEqual([]);
  });
  it("preserves a cancelled confirmation as an exact replay without project effects", async () => {
    const f = await fixture(async () => false), command = { kind: "create-project" as const, commandId: id(), name: "Cancelled project", objective: "Do not save this proposal", outcomes: [], budgetMinorUnits: 0, currency: "GBP" };
    expect((await f.app.command(command)).kind).toBe("cancelled"); expect((await f.app.command(command)).kind).toBe("cancelled");
    expect(f.reviews).toHaveLength(1); expect((await f.app.snapshot(null)).projects).toEqual([]);
    expect((await f.app.command({ ...command, objective: "Changed proposal" })).kind).toBe("conflict");
    expect((await f.app.observe("unknown:command")).kind).toBe("not-recorded");
    expect((await f.app.observe("../escape")).kind).toBe("refused");
    await f.app.drain(); expect((await f.app.command({ ...command, commandId: id() })).reason).toBe("workspace.unavailable");
    expect((await f.app.observe(command.commandId)).kind).toBe("unknown");
  });
  it("rejects stale versions and changed server facts after native review, then accepts a fresh manual revision", async () => {
    let callback: (() => Promise<void>) | null = null;
    const f = await fixture(async () => { if (callback !== null) { const action = callback; callback = null; await action(); } return true; });
    let p = await accepted(f.app);
    const save = { kind: "save-plan" as const, commandId: id(), projectId: p.projectId, expectedPlanVersion: 0, title: "First manual content", tasks: [{ title: "Keep notes", objective: p.brief!.objective, acceptanceCriteria: ["Can reopen notes"] }], scope: "within-brief" as const };
    callback = async () => { await f.store.persistence.transact(async (tx) => { const facts = await readPlanningFoundations(tx, p.projectId); await tx.aggregates.update({ aggregateType: "project", aggregateId: p.projectId, schemaVersion: 1, expectedVersion: p.version, payload: parseProject({ ...facts.project, displayName: "Changed while reviewing", revision: 2, updatedAt: new Date().toISOString() }) }); }); };
    expect(await f.app.command(save)).toMatchObject({ kind: "conflict", reason: "confirmation.subject-changed" });
    p = await committed(f.app, { ...save, commandId: id() });
    expect((await f.app.command({ ...save, commandId: id() })).reason).toBe("command.version-conflict");
    const redrafted = await draft(f.app, p, "within-brief"); expect(redrafted.plan?.revision).toBe(1); expect(redrafted.plan?.version).toBe(2);
    p = await committed(f.app, { kind: "prepare-plan", commandId: id(), projectId: p.projectId, expectedPlanVersion: redrafted.plan!.version });
    p = await committed(f.app, { kind: "seal-plan", commandId: id(), projectId: p.projectId, expectedPlanVersion: p.plan!.version });
    p = await committed(f.app, { kind: "export-handover", commandId: id(), projectId: p.projectId, expectedPlanVersion: p.plan!.version });
    const revised = await draft(f.app, p, "within-brief"); expect(revised.plan?.revision).toBe(2); expect(revised.plan?.sealedByApprovalId).toBeNull(); expect(revised.handovers[0]?.stale).toBe(true);
    expect((await f.app.handover(p.projectId, revised.handovers[0]!.handoverId)).stale).toBe(true);
    const draftBrief = await f.app.command({ kind: "draft-brief", projectId: p.projectId, expectedBriefVersion: p.brief!.version, objective: "A different accepted direction", outcomes: ["Review a planting calendar"], audiences: [], nonGoals: [] });
    const candidate = draftBrief.workspace!.selected!.candidate!;
    p = await committed(f.app, { kind: "accept-brief", commandId: id(), projectId: p.projectId, expectedBriefVersion: p.brief!.version, candidateId: candidate.candidateId, candidateDigest: candidate.digest });
    p = await draft(f.app, p, "within-brief"); expect(p.plan?.revision).toBe(1); expect(p.plan?.state).toBe("drafting");
  });
  it("keeps the project safe when approval history is incomplete and distinguishes persisted corruption from new caller mismatch", async () => {
    const f = await fixture(); let p = await draft(f.app, await accepted(f.app));
    p = await committed(f.app, { kind: "prepare-plan", commandId: id(), projectId: p.projectId, expectedPlanVersion: p.plan!.version });
    const pair = await f.store.persistence.transact((tx) => readPlanningApprovalPair(tx, p.approvals[0]!.approvalId));
    await f.store.persistence.transact((tx) => tx.aggregates.update({ aggregateType: "approval-request", aggregateId: pair!.approval.approvalRequestId, schemaVersion: 1, expectedVersion: pair!.approvalEnvelope.aggregateVersion, payload: pair!.approvalEnvelope.payload }));
    await expect(f.app.snapshot(p.projectId)).rejects.toMatchObject({ kind: "corrupt", reason: "approval.history-corrupt" });
    const failed = await f.app.command({ kind: "approve-scope", commandId: id(), projectId: p.projectId, expectedPlanVersion: p.plan!.version, scopeRequest: p.plan!.scopeApproval!.subject });
    expect(failed.kind).toBe("corrupt");
    expect((await f.store.persistence.transact((tx) => readPlanningFoundations(tx, p.projectId))).head?.plan.state).toBe("awaiting_scope_approval");
    const command = { kind: "stop-project" as const, commandId: id(), projectId: p.projectId, expectedProjectVersion: p.version };
    // This command's transaction commits, but its corrupt workspace cannot be
    // projected. Its own durable identity is still checked before caller drift.
    await f.app.command(command);
    const receiptId = `planning-command:${digestPlanning(command.commandId).slice(0, 32)}`;
    await f.store.persistence.transact(async (tx) => { const row = (await tx.aggregates.get("planning-command", receiptId))!; await tx.aggregates.update({ aggregateType: "planning-command", aggregateId: receiptId, schemaVersion: 1, expectedVersion: row.aggregateVersion, payload: { ...(row.payload as object), material: { ...command, commandId: "forged:material" } } }); });
    expect((await f.app.command({ ...command, expectedProjectVersion: 999 })).kind).toBe("corrupt");
  });
  it("recovers atomic handover publication, preserves unknown files, and rejects forged or malformed returned authority", async () => {
    const f = await fixture(); let p = await draft(f.app, await accepted(f.app), "within-brief");
    const exportCommand = { kind: "export-handover" as const, commandId: id(), projectId: p.projectId, expectedPlanVersion: p.plan!.version };
    p = await committed(f.app, exportCommand); const target = p.handovers[0]!.fileName, original = await readFile(target, "utf8"), document = JSON.parse(original) as { returnTemplate: Record<string, unknown> };
    // Exact crash window: a fully written staging inode was linked atomically
    // as the target, but the process died before unlinking its staging name.
    const staging = `${target}.00000000-0000-4000-8000-000000000000.pending`;
    await link(target, staging); expect((await f.app.observe(exportCommand.commandId)).kind).toBe("committed");
    await expect(readFile(staging)).rejects.toMatchObject({ code: "ENOENT" });
    await unlink(target); await writeFile(`${target}.11111111-1111-4111-8111-111111111111.pending`, "partial");
    expect((await f.app.observe(exportCommand.commandId)).kind).toBe("committed"); expect(await readFile(target, "utf8")).toBe(original);
    for (const input of ["{bad json", JSON.stringify({ ...document.returnTemplate, authority: "execute", text: "Forged" }), JSON.stringify({ ...document.returnTemplate, projectId: "prj:other", text: "Wrong project" }), JSON.stringify({ ...document.returnTemplate, text: "password=owned-synthetic-marker" }), "x".repeat(65537)]) {
      f.setResultFile({ name: "untrusted.json", text: input });
      const result = await f.app.command({ kind: "attach-result", commandId: id(), projectId: p.projectId, handoverId: p.handovers[0]!.handoverId });
      expect(["refused", "conflict"]).toContain(result.kind); expect((await f.app.snapshot(p.projectId)).selected?.handovers[0]?.result).toBeNull();
    }
    const saved = await f.store.persistence.transact((tx) => tx.aggregates.get("planning-handover", p.handovers[0]!.handoverId));
    expect(() => parsePlanningHandover({ ...(saved!.payload as object), authority: "execute" })).toThrow();
    expect(() => parsePlanningHandover({ ...(saved!.payload as object), document: { ...JSON.parse(original), returnTemplate: { ...document.returnTemplate, planDigest: "a".repeat(64) } } })).toThrow();
    await writeFile(target, "unknown-existing-content");
    expect(await f.app.observe(exportCommand.commandId)).toMatchObject({ kind: "committed", projectionWarning: "handover-files" }); expect(await readFile(target, "utf8")).toBe("unknown-existing-content");
  });
  it("accepts a real brief, atomically consumes exact scope and seals; reopens and observes without duplicates", async () => {
    const f = await fixture(); let p = await draft(f.app, await accepted(f.app));
    p = await committed(f.app, { kind: "prepare-plan", commandId: id(), projectId: p.projectId, expectedPlanVersion: p.plan!.version });
    expect(p.plan?.state).toBe("awaiting_scope_approval"); expect(p.approvals).toHaveLength(1);
    const command = { kind: "approve-scope" as const, commandId: id(), projectId: p.projectId, expectedPlanVersion: p.plan!.version, scopeRequest: p.plan!.scopeApproval!.subject };
    p = await committed(f.app, command);
    expect(p.plan).toMatchObject({ state: "sealed", version: 5, sealedByApprovalId: p.approvals[0]!.approvalId });
    expect(p.approvals[0]?.state).toBe("consumed");
    const original = await f.app.observe(command.commandId);
    expect((await f.app.command(command)).kind).toBe("committed");
    expect((await f.app.command({ ...command, expectedPlanVersion: 999 })).kind).toBe("conflict");
    await f.app.drain(); await f.store.close();
    const store = await openPlanningStorage(join(f.root, "saved")), app = createSavedPlanningApplication({ persistence: store.persistence, artifactRoot: store.artifactRoot, operator: { confirm: async () => { throw new Error("NO_REPLAY_CONFIRMATION"); }, selectRepository: async () => null, selectResult: async () => null } });
    owned[owned.length - 1] = { root: f.root, app, store }; await app.initialize();
    const reopened = await app.snapshot(p.projectId);
    expect(reopened.selected?.plan).toEqual(p.plan); expect(reopened.selected?.approvals).toEqual(p.approvals); expect(reopened.selected?.candidate).toBeNull();
    expect((await app.observe(command.commandId)).workspace?.selected?.history).toEqual(original.workspace?.selected?.history);
    expect(f.reviews.find((review) => review.action === "approve-scope")?.detail).toContain(p.plan!.digest);
  });
  it("seals within accepted scope and saves an authority-none handover with append-only untrusted return", async () => {
    const f = await fixture(); let p = await draft(f.app, await accepted(f.app), "within-brief");
    p = await committed(f.app, { kind: "prepare-plan", commandId: id(), projectId: p.projectId, expectedPlanVersion: p.plan!.version });
    p = await committed(f.app, { kind: "seal-plan", commandId: id(), projectId: p.projectId, expectedPlanVersion: p.plan!.version });
    expect(p.plan?.sealedByApprovalId).toBeNull(); expect(p.approvals).toHaveLength(0);
    p = await committed(f.app, { kind: "export-handover", commandId: id(), projectId: p.projectId, expectedPlanVersion: p.plan!.version });
    const artifact = JSON.parse(await readFile(p.handovers[0]!.fileName, "utf8")) as { authority: string; kind: string; returnTemplate: Record<string, unknown> };
    expect(artifact).toMatchObject({ kind: "planning-handover", authority: "none" });
    const reviewCount = f.reviews.length, document = await f.app.handover(p.projectId, p.handovers[0]!.handoverId);
    expect(document).toMatchObject({ schemaVersion: 1, authority: "none", projectId: p.projectId, stale: false });
    expect(document.text).toBe(await readFile(p.handovers[0]!.fileName, "utf8")); expect(f.reviews).toHaveLength(reviewCount);
    expect((await f.app.snapshot(p.projectId)).selected?.history).toEqual(p.history);
    await expect(f.app.handover(p.projectId, "handover:absent")).rejects.toMatchObject({ reason: "handover.absent" });
    await expect(f.app.handover(p.projectId, "../escape")).rejects.toThrow();
    const other = await project(f.app);
    await expect(f.app.handover(other.projectId, p.handovers[0]!.handoverId)).rejects.toMatchObject({ reason: "handover.project-mismatch" });
    f.setResultFile({ name: "manual-result.json", text: JSON.stringify({ ...artifact.returnTemplate, text: "I manually reviewed the planning context. Nothing was executed." }) });
    p = await committed(f.app, { kind: "attach-result", commandId: id(), projectId: p.projectId, handoverId: p.handovers[0]!.handoverId });
    expect(p.handovers[0]?.result?.attribution).toBe("operator-supplied-untrusted");
    expect((await f.app.command({ kind: "attach-result", commandId: id(), projectId: p.projectId, handoverId: p.handovers[0]!.handoverId })).kind).toBe("conflict");
    p = await committed(f.app, { kind: "stop-project", commandId: id(), projectId: p.projectId, expectedProjectVersion: p.version });
    expect((await f.app.handover(p.projectId, p.handovers[0]!.handoverId)).text).toBe(document.text);
    await f.app.drain(); await expect(f.app.handover(p.projectId, p.handovers[0]!.handoverId)).rejects.toMatchObject({ reason: "workspace.unavailable" });
  });
  it("rejects forged authority fields before asking native confirmation or writing", async () => {
    const f = await fixture(); const p = await accepted(f.app), count = f.reviews.length;
    const bad = await f.app.command({ kind: "save-plan", commandId: id(), projectId: p.projectId, expectedPlanVersion: 0, title: "Forged", tasks: [], scope: "within-brief", operatorConfirmed: true, actor: "owner" });
    expect(bad.kind).toBe("refused"); expect(f.reviews).toHaveLength(count); expect((await f.app.snapshot(p.projectId)).selected?.plan).toBeNull();
  });
  it("keeps in-flight observation unknown and rejects a native confirmation after concurrent stop", async () => {
    let release: (value: boolean) => void = () => undefined, entered: () => void = () => undefined;
    const enteredPromise = new Promise<void>((r) => { entered = r; });
    const f = await fixture(async (review) => { if (review.action !== "save-plan") return true; entered(); return await new Promise<boolean>((r) => { release = r; }); });
    const p = await accepted(f.app), commandId = id();
    const pending = f.app.command({ kind: "save-plan", commandId, projectId: p.projectId, expectedPlanVersion: 0, title: "Interrupted plan", tasks: [{ title: "Journal", objective: p.brief!.objective, acceptanceCriteria: ["Can save an observation"] }], scope: "within-brief" });
    await enteredPromise; expect((await f.app.observe(commandId)).kind).toBe("unknown");
    const stopped = await committed(f.app, { kind: "stop-project", commandId: id(), projectId: p.projectId, expectedProjectVersion: p.version });
    release(true); expect(await pending).toMatchObject({ kind: "refused", reason: "project.stopped" }); expect(stopped.stopped).toBe(true);
    expect((await f.app.snapshot(p.projectId)).selected?.plan).toBeNull();
    const resumed = await committed(f.app, { kind: "resume-project", commandId: id(), projectId: p.projectId, expectedProjectVersion: stopped.version });
    expect(resumed.stopped).toBe(false); expect(resumed.plan).toBeNull();
  });
  it("rolls back scope approval, consumption and both plan transitions if the seal journal fails", async () => {
    const f = await fixture(); let p = await draft(f.app, await accepted(f.app));
    p = await committed(f.app, { kind: "prepare-plan", commandId: id(), projectId: p.projectId, expectedPlanVersion: p.plan!.version });
    f.fault.event = "plan.sealed";
    const command = { kind: "approve-scope" as const, commandId: id(), projectId: p.projectId, expectedPlanVersion: p.plan!.version, scopeRequest: p.plan!.scopeApproval!.subject };
    const failed = await f.app.command(command);
    expect(failed.kind).toBe("unknown");
    expect(await f.app.observe(command.commandId)).toMatchObject({ kind: "not-recorded", reason: "command.interrupted-before-commit" });
    const after = (await f.app.snapshot(p.projectId)).selected!;
    expect(after.plan).toEqual(p.plan); expect(after.approvals).toEqual(p.approvals); expect(after.history).toEqual(p.history);
    expect(after.approvals[0]?.state).toBe("requested");
    p = await committed(f.app, { kind: "stop-project", commandId: id(), projectId: p.projectId, expectedProjectVersion: p.version });
    p = await committed(f.app, { kind: "resume-project", commandId: id(), projectId: p.projectId, expectedProjectVersion: p.version });
    p = await committed(f.app, { kind: "approve-scope", commandId: id(), projectId: p.projectId, expectedPlanVersion: p.plan!.version, scopeRequest: p.plan!.scopeApproval!.subject });
    expect(p.plan?.state).toBe("sealed"); expect(p.approvals[0]?.state).toBe("consumed");
  });
  it("observes a lost commit reply and a drained interrupted intent without repeating writes", async () => {
    const f = await fixture(); const p = await accepted(f.app), command = { kind: "stop-project" as const, commandId: id(), projectId: p.projectId, expectedProjectVersion: p.version };
    f.fault.loseNextCommittedReply = true;
    expect((await f.app.command(command)).kind).toBe("unknown");
    const observed = await f.app.observe(command.commandId); expect(observed.kind).toBe("committed"); expect(observed.workspace?.selected?.stopped).toBe(true);
    expect((await f.app.command(command)).workspace?.selected?.history).toEqual(observed.workspace?.selected?.history);
    const interrupted = { kind: "resume-project" as const, commandId: id(), projectId: p.projectId, expectedProjectVersion: p.version };
    await f.store.persistence.transact((tx) => recordPlanningIntent(tx, { commandId: interrupted.commandId, commandKind: interrupted.kind, inputDigest: digestPlanning(interrupted), projectId: p.projectId, at: new Date().toISOString() }));
    expect((await f.app.observe(interrupted.commandId)).kind).toBe("not-recorded");
    expect((await f.app.command(interrupted)).kind).toBe("not-recorded");
    expect((await f.app.snapshot(p.projectId)).selected?.stopped).toBe(true);
  });
  it("uses the public clarification and acceptance path without persisting an unaccepted candidate", async () => {
    const f = await fixture(), p = await project(f.app);
    const proposed = await f.app.command({ kind: "draft-brief", projectId: p.projectId, objective: "Organize volunteer planting", outcomes: [], nonGoals: ["No paid services"], audiences: ["Local volunteers"], expectedBriefVersion: 0 });
    expect(proposed.kind).toBe("ready"); const candidate = proposed.workspace!.selected!.candidate!;
    expect(candidate.ready).toBe(false); expect(candidate.questions).toHaveLength(1);
    const answered = await f.app.command({ kind: "answer-clarification", projectId: p.projectId, candidateId: candidate.candidateId, answers: [{ questionId: candidate.questions[0]!.questionId, value: "Keep a local list of planned planting sessions" }] });
    expect(answered.kind).toBe("ready"); const ready = answered.workspace!.selected!.candidate!; expect(ready.ready).toBe(true);
    const saved = await committed(f.app, { kind: "accept-brief", commandId: id(), projectId: p.projectId, candidateId: ready.candidateId, candidateDigest: ready.digest, expectedBriefVersion: 0 });
    expect(saved.brief?.outcomes).toContain("Keep a local list of planned planting sessions");
    const persisted = await f.store.persistence.transact(async (tx) => await tx.aggregates.list({ aggregateType: "planning-command", limit: 100 }));
    expect(JSON.stringify(persisted)).not.toContain("Organize volunteer planting\",\"outcomes\":[]");
  });
  it("records authenticated N6 historical reports after binding drift and stop, preserving consumed authority", async () => {
    const f = await fixture(); let p = await accepted(f.app);
    const at = new Date().toISOString(), future = new Date(Date.parse(at) + 3600000).toISOString();
    const binding = await f.store.persistence.transact(async (tx) => {
      const facts = await readPlanningFoundations(tx, p.projectId);
      const lookup: ApprovalBinding = { project: { projectId: p.projectId, version: p.version, contentDigest: facts.projectEnvelope.checksum.hex, budgetAccountId: facts.project.budgetAccountId },
        scope: { projectId: p.projectId, taskId: null, providerInstanceId: null, workspaceId: null, operationId: "synthetic:past-purchase", traceId: null }, accountRef: null, providerModelId: null, policy: { version: "lookup", fingerprint: "a".repeat(64) }, plan: null };
      return (await readPlanningApprovalControls(tx, lookup, at)).binding;
    });
    const prepared = prepareApprovalRequest({ schemaVersion: 1, class: "purchase", risk: "low", binding,
      spending: { vendor: { name: "Synthetic historical vendor", instanceRef: "vendor:synthetic" }, amount: { kind: "known", minorUnits: 500 }, currency: "GBP", recurrence: null,
        quote: { digest: "a".repeat(64), quotedAt: at, expiresAt: future } },
      explanation: { reason: "paid-resource-required", alternatives: ["defer"], consequence: "waits-for-decision", expectedMinorUnits: null, renewal: "not-recurring", taxAndFees: "unknown", foreignExchange: "none", entitlement: "unknown", note: { origin: "operator", text: "Owned synthetic historical record; no purchase or quote retrieval occurred." } }, createdAt: at, expiresAt: future }, at, planningHash);
    expect(prepared.kind).toBe("ready"); if (prepared.kind !== "ready") throw new Error("FIXTURE_NOT_READY");
    const owner = createPlanningApprovalOwner(f.store.persistence, { now: () => new Date(at) });
    const confirmation: PlanningConfirmation = { reviewId: "native-review:owned-synthetic-history", identityRef: "operator:local-desktop", approverClass: "project-owner", confirmedAt: at, subjectDigest: digestPlanning(prepared.request) };
    for (const kind of ["create", "request-approval", "approve", "authorize"] as ApprovalOperationKind[]) {
      const pair = await f.store.persistence.transact((tx) => readPlanningApprovalPair(tx, prepared.request.approval.approvalRequestId));
      const operation = parseApprovalOperation({ schemaVersion: 1, kind, operationId: `synthetic-history:${kind}`, request: prepared.request, successor: null, expectedApprovalVersion: pair?.approvalEnvelope.aggregateVersion ?? 0, expectedSpendingVersion: pair?.spendingEnvelope?.aggregateVersion ?? 0, at, receiptRef: null }, planningHash);
      expect(await owner.adapter.attempt(operation, {} as never)).toMatchObject({ kind: "refused", reason: "authorization.not-issued" });
      expect(await owner.attemptConfirmed(operation, confirmation)).toMatchObject({ kind: "committed" });
      expect(await owner.adapter.observe(operation)).toMatchObject({ kind: "committed" });
      expect(await owner.attemptConfirmed(operation, confirmation)).toMatchObject({ kind: "idempotent-replay" });
      expect((await owner.adapter.observe({ ...operation, operationId: "unknown:history-operation" })).kind).toBe("not-recorded");
    }
    const original = await f.store.persistence.transact((tx) => readPlanningApprovalPair(tx, prepared.request.approval.approvalRequestId));
    await f.store.persistence.transact(async (tx) => {
      const facts = await readPlanningFoundations(tx, p.projectId);
      await tx.aggregates.update({ aggregateType: "project", aggregateId: p.projectId, schemaVersion: 1, expectedVersion: p.version, payload: parseProject({ ...facts.project, displayName: "Garden project revised", revision: 2, updatedAt: new Date().toISOString() }) });
    });
    p = (await f.app.snapshot(p.projectId)).selected!;
    p = await committed(f.app, { kind: "stop-project", commandId: id(), projectId: p.projectId, expectedProjectVersion: p.version });
    let history = p.approvals.find((a) => a.approvalId === prepared.request.approval.approvalRequestId)!;
    expect(history.context).toContain("bindings have changed"); expect(history.context).toContain("stopped"); expect(history.actions).toContain("report-executed");
    p = await committed(f.app, { kind: "historical-money", commandId: id(), projectId: p.projectId, approvalId: history.approvalId, expectedApprovalVersion: history.version, expectedSpendingVersion: history.spendingVersion, action: "report-executed", receiptRef: null });
    history = p.approvals.find((a) => a.approvalId === history.approvalId)!;
    expect(history.state).toBe("operator_executed"); expect(history.actions).toContain("record-receipt");
    p = await committed(f.app, { kind: "historical-money", commandId: id(), projectId: p.projectId, approvalId: history.approvalId, expectedApprovalVersion: history.version, expectedSpendingVersion: history.spendingVersion, action: "record-receipt", receiptRef: "Manual receipt reference 1" });
    const final = await f.store.persistence.transact(async (tx) => { const pair = (await readPlanningApprovalPair(tx, history.approvalId))!; await verifyPlanningMoneyHistory(tx, pair); return pair; });
    expect(final.approval).toEqual(original!.approval); expect(final.spending?.state).toBe("reconciled"); expect(final.spending?.amountMinorUnits).toBe(original!.spending?.amountMinorUnits);
    expect(p.approvals.find((a) => a.approvalId === history.approvalId)?.actions).toEqual([]);
  });
  it("allows only legal historical withdrawal under later drift and stop, without voiding or consuming the approval again", async () => {
    const f = await fixture(); let p = await accepted(f.app);
    const seeded = await seedOwnedPlanningHistoryForTesting(f.store.persistence, p.projectId, "synthetic-history:withdraw");
    p = (await f.app.snapshot(p.projectId)).selected!;
    p = await committed(f.app, { kind: "stop-project", commandId: id(), projectId: p.projectId, expectedProjectVersion: p.version });
    const history = p.approvals.find((item) => item.approvalId === seeded.approvalId)!;
    expect(history.actions).toContain("withdraw");
    const action = { kind: "historical-money" as const, commandId: id(), projectId: p.projectId, approvalId: history.approvalId, expectedApprovalVersion: history.version, expectedSpendingVersion: history.spendingVersion, action: "withdraw" as const, receiptRef: null };
    expect((await f.app.command({ ...action, commandId: id(), expectedSpendingVersion: 999 })).kind).toBe("conflict");
    p = await committed(f.app, action);
    const pair = (await f.store.persistence.transact((tx) => readPlanningApprovalPair(tx, history.approvalId)))!;
    expect(pair.approval.state).toBe("consumed"); expect(pair.approval.consumptionCount).toBe(1); expect(digestPlanning(pair.approval)).toBe(seeded.approvalDigest);
    expect(pair.spending?.amountMinorUnits).toBe(seeded.amountMinorUnits); expect(pair.spending?.state).toBe("withdrawn"); expect(p.stopped).toBe(true);
    expect(p.approvals.find((item) => item.approvalId === history.approvalId)?.actions).toEqual([]);
    expect((await f.app.command({ ...action, commandId: id(), expectedSpendingVersion: pair.spendingEnvelope!.aggregateVersion })).kind).toBe("refused");
  });
  it("shows legacy historical money without exposing completion when authenticated receipts are unavailable", async () => {
    const f = await fixture(), p = await accepted(f.app), seeded = await seedOwnedPlanningHistoryForTesting(f.store.persistence, p.projectId, "synthetic-history:legacy");
    const original = (await f.store.persistence.transact((tx) => readPlanningApprovalPair(tx, seeded.approvalId)))!;
    let legacy = false;
    const persistence = { ...f.store.persistence, async transact<T>(work: Parameters<typeof f.store.persistence.transact<T>>[0]): Promise<T> {
      return await f.store.persistence.transact((tx) => work({ ...tx, events: { ...tx.events, list: async (input) => {
        const page = await tx.events.list(input);
        if (!legacy || !["approval-request", "spending-request"].includes(input.aggregateType ?? "")) return page;
        return { ...page, items: page.items.map((row) => {
          const source = row.payload as Record<string, unknown>;
          const payload = { schemaVersion: source["schemaVersion"], operation: source["operation"], actor: source["actor"], controls: source["controls"], writes: source["writes"] };
          return { ...row, payload, checksum: canonicalizeWithChecksum(payload).checksum };
        }) };
      } } }));
    } };
    const view = createSavedPlanningApplication({ persistence, artifactRoot: f.store.artifactRoot, operator: { confirm: async () => true, selectRepository: async () => null, selectResult: async () => null } });
    try {
      await view.initialize(); legacy = true;
      const history = (await view.snapshot(p.projectId)).selected!.approvals.find((row) => row.approvalId === seeded.approvalId)!;
      expect(history.actions).toEqual([]); expect(history.context).toContain("Required trusted history is unavailable");
      expect((await view.command({ kind: "historical-money", commandId: id(), projectId: p.projectId, approvalId: history.approvalId, expectedApprovalVersion: history.version, expectedSpendingVersion: history.spendingVersion, action: "report-executed", receiptRef: null })).kind).toBe("refused");
      const pair = (await f.store.persistence.transact((tx) => readPlanningApprovalPair(tx, seeded.approvalId)))!;
      expect(pair.approval).toEqual(original.approval); expect(pair.spending).toEqual(original.spending);
    } finally { await view.drain(); }
  });
  it("distinguishes a corrupt historical pair from unavailable history without admitting any write", async () => {
    const f = await fixture(), p = await accepted(f.app), seeded = await seedOwnedPlanningHistoryForTesting(f.store.persistence, p.projectId, "synthetic-history:corrupt");
    const pair = (await f.store.persistence.transact((tx) => readPlanningApprovalPair(tx, seeded.approvalId)))!;
    await f.store.persistence.transact((tx) => tx.aggregates.update({ aggregateType: "spending-request", aggregateId: pair.spending!.spendingRequestId, schemaVersion: 1, expectedVersion: pair.spendingEnvelope!.aggregateVersion, payload: {} }));
    await expect(f.app.snapshot(p.projectId)).rejects.toMatchObject({ kind: "corrupt", reason: "approval.pair-corrupt" });
    expect((await f.app.command({ kind: "historical-money", commandId: id(), projectId: p.projectId, approvalId: seeded.approvalId, expectedApprovalVersion: pair.approvalEnvelope.aggregateVersion, expectedSpendingVersion: pair.spendingEnvelope!.aggregateVersion + 1, action: "report-executed", receiptRef: null })).kind).toBe("corrupt");
  });
});
