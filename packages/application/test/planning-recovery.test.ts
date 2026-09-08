import { mkdtemp, mkdir, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSavedPlanningApplication, type PlanningNativeReview, type SavedPlanningApplication } from "../src/planning.js";
import { openPlanningStorage, type PlanningStorage } from "../src/planning-storage.js";
import type { PlanningCommand, PlanningProjectView } from "../src/planning-contracts.js";
import { readPlanningApprovalPair, verifyPlanningApprovalHistory } from "../src/planning-approval.js";
import { listPlanningAggregates, listPlanningEvents, observePlanningReceipt } from "../src/planning-ledger.js";
import { readPlanningMetadata } from "../src/planning-metadata.js";
import { readPlanningFoundations } from "../src/planning-plan.js";
import { parseProject } from "@ai-dev-os/project";
import type { PersistenceAdapter } from "@ai-dev-os/persistence";

const owned: { root: string; app: SavedPlanningApplication; store: PlanningStorage }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0)) {
    await item.app.drain(); await item.store.close();
    const base = await realpath(tmpdir()), root = await realpath(item.root);
    if (!root.startsWith(base + sep) || !root.startsWith(join(base, "saved-recovery-test-"))) throw new Error("FIXTURE_ROOT_NOT_OWNED");
    await rm(root, { recursive: true, force: true });
  }
});
let ordinal = 0;
const commandId = (): string => `recovery-test:${++ordinal}`;
async function fixture() {
  // Windows TEMP may use an equivalent short/case spelling. Compare owned
  // mutation paths in the same canonical spelling returned by the real store.
  const root = await realpath(await mkdtemp(join(tmpdir(), "saved-recovery-test-"))); await mkdir(join(root, "repository"));
  const time = { value: Date.parse("2026-09-08T00:00:00.000Z") }, clock = { now: () => new Date(time.value) };
  const reviews: PlanningNativeReview[] = [];
  const control = { confirm: async (_review: PlanningNativeReview): Promise<boolean> => true };
  const fault = { event: null as string | null, loseReply: false, afterCommit: null as (() => Promise<void>) | null, snapshotUnavailable: false, hideCompleted: false };
  const operator = { async confirm(review: PlanningNativeReview) { reviews.push(review); return control.confirm(review); }, async selectRepository() { return join(root, "repository"); }, async selectResult() { return null; } };
  function application(store: PlanningStorage) {
    const persistence: PersistenceAdapter = { ...store.persistence, async transact(work) {
      let completed = false;
      const value = await store.persistence.transact((base) => work({ ...base,
        aggregates: { ...base.aggregates, async list(input) {
          if (fault.snapshotUnavailable && input.aggregateType === "planning-handover") throw new Error("OWNED_SNAPSHOT_READ_FAILURE");
          return base.aggregates.list(input);
        } },
        events: { ...base.events, async append(input) {
          if (input.eventType === fault.event) { fault.event = null; throw new Error("OWNED_ATOMIC_WRITE_FAILURE"); }
          if (input.eventType === "planning-command.completed") completed = true;
          return base.events.append(input);
        }, async list(input) {
          const page = await base.events.list(input);
          return fault.hideCompleted ? { ...page, items: page.items.filter((event) => event.eventType !== "planning-command.completed") } : page;
        } },
      }));
      if (completed && fault.afterCommit !== null) { const hook = fault.afterCommit; fault.afterCommit = null; await hook(); }
      if (completed && fault.loseReply) { fault.loseReply = false; throw new Error("OWNED_ACK_LOST_AFTER_COMMIT"); }
      return value;
    } };
    return createSavedPlanningApplication({ persistence, artifactRoot: store.artifactRoot, operator, clock });
  }
  const store = await openPlanningStorage(join(root, "saved"));
  const item = { root, store, app: application(store) };
  owned.push(item); await item.app.initialize();
  return Object.assign(item, { time, reviews, control, fault, async reopen() {
    await item.app.drain(); await item.store.close(); item.store = await openPlanningStorage(join(root, "saved"));
    item.app = application(item.store);
    await item.app.initialize();
  } });
}
async function saved(app: SavedPlanningApplication, command: PlanningCommand): Promise<PlanningProjectView> {
  const result = await app.command(command); expect(result, JSON.stringify(result)).toMatchObject({ kind: "committed", reason: null });
  expect(result.workspace?.selected).toBeTruthy(); return result.workspace!.selected!;
}
async function draft(app: SavedPlanningApplication): Promise<PlanningProjectView> {
  let p = await saved(app, { kind: "create-project", commandId: commandId(), name: "Recovery field notes", objective: "Keep reliable local field notes", outcomes: ["Reopen saved field notes"], budgetMinorUnits: 2000, currency: "GBP" });
  p = await saved(app, { kind: "accept-brief", commandId: commandId(), projectId: p.projectId, expectedBriefVersion: 0, candidateId: p.candidate!.candidateId, candidateDigest: p.candidate!.digest });
  return await saved(app, { kind: "save-plan", commandId: commandId(), projectId: p.projectId, expectedPlanVersion: 0, title: "Field note review", scope: "scope-expansion", tasks: [{ title: "Compare seasons", objective: "Compare this season with earlier observations", acceptanceCriteria: ["Saved comparisons reopen without losing notes"] }] });
}
function scopeCommand(p: PlanningProjectView, kind: "request-scope-again" | "approve-scope" = "request-scope-again") {
  return { kind, commandId: commandId(), projectId: p.projectId, expectedPlanVersion: p.plan!.version, scopeRequest: p.plan!.scopeApproval!.subject } as const;
}
async function awaiting(f: Awaited<ReturnType<typeof fixture>>, expire = true) {
  let p = await draft(f.app);
  p = await saved(f.app, { kind: "prepare-plan", commandId: commandId(), projectId: p.projectId, expectedPlanVersion: p.plan!.version });
  if (expire) f.time.value = Date.parse(p.plan!.scopeApproval!.expiresAt);
  return (await f.app.snapshot(p.projectId)).selected!;
}
async function authority(f: Awaited<ReturnType<typeof fixture>>, p: PlanningProjectView) {
  return f.store.persistence.transact(async (tx) => {
    const metadata = await readPlanningMetadata(tx, p.projectId), pairs = [];
    for (const row of await listPlanningAggregates(tx, "approval-request")) {
      const pair = (await readPlanningApprovalPair(tx, row.aggregateId))!; await verifyPlanningApprovalHistory(tx, pair);
      pairs.push({ pair, events: await listPlanningEvents(tx, "approval-request", row.aggregateId) });
    }
    const head = (await readPlanningFoundations(tx, p.projectId)).head!;
    const planEvents = await listPlanningEvents(tx, "project-plan", head.aggregateId); expect(planEvents.length).toBeGreaterThan(0);
    return { metadata, pairs, head, planEvents };
  });
}

// These cases perform complete real DELETE/FULL SQLite workflows. Keep their
// finite whole-case budget separate from the unchanged application deadlines.
describe("saved workflow recovery", { timeout: 30_000 }, () => {
  it("validates the temporary brief before creating a project so rejection cannot contradict its receipt", async () => {
    const f = await fixture(), command = { kind: "create-project" as const, commandId: commandId(), name: "Honest project outcome", objective: "Keep field notes in C:/owned-fixture/notes", outcomes: ["Reopen saved field notes"], budgetMinorUnits: 2000, currency: "GBP" };
    const outcome = await f.app.command(command), observed = await f.app.observe(command.commandId), projects = (await f.app.snapshot(null)).projects;
    expect({ reported: outcome.kind, observed: observed.kind, savedProjects: projects.length }).toEqual({ reported: "refused", observed: "refused", savedProjects: 0 });
    expect(f.reviews).toHaveLength(0);
  });

  it("offers explicit scope-request recovery at exact expiry after close and reopen", async () => {
    const f = await fixture(); let p = await draft(f.app);
    p = await saved(f.app, { kind: "prepare-plan", commandId: commandId(), projectId: p.projectId, expectedPlanVersion: p.plan!.version });
    const approval = await f.store.persistence.transact((tx) => readPlanningApprovalPair(tx, p.approvals[0]!.approvalId));
    expect(approval?.approval.state).toBe("requested"); f.time.value = Date.parse(approval!.approval.expiresAt);
    await f.reopen(); const reopened = (await f.app.snapshot(p.projectId)).selected!;
    expect(reopened.plan).toMatchObject({ state: "awaiting_scope_approval", version: p.plan!.version, digest: p.plan!.digest });
    expect(reopened.plan!.actions).toContain("request-scope-again");
    const before = await authority(f, p), renewed = await saved(f.app, scopeCommand(reopened));
    expect(renewed.plan).toMatchObject({ state: "awaiting_scope_approval", version: p.plan!.version, digest: p.plan!.digest, revision: p.plan!.revision });
    expect(renewed.plan!.actions).toEqual(["approve-scope"]);
    const after = await authority(f, p), oldId = reopened.plan!.scopeApproval!.subject.approvalId, newId = renewed.plan!.scopeApproval!.subject.approvalId;
    expect(after.head).toEqual(before.head);
    expect(newId).not.toBe(oldId); expect(after.planEvents).toEqual(before.planEvents);
    const old = after.pairs.find((item) => item.pair.approval.approvalRequestId === oldId)!, successor = after.pairs.find((item) => item.pair.approval.approvalRequestId === newId)!;
    expect(old.pair.request).toEqual(before.pairs[0]!.pair.request); expect(old.events.slice(0, -1)).toEqual(before.pairs[0]!.events);
    expect(old.pair.approval).toMatchObject({ state: "expired", consumptionCount: 0 });
    expect(successor.pair.approval).toMatchObject({ state: "requested", consumptionCount: 0 }); expect(successor.pair.spending).toBeNull();
    expect(successor.pair.request.proposal.binding).toEqual(old.pair.request.proposal.binding);
    expect(after.metadata.value.plan!.scopeApprovalId).toBe(newId);
    expect(f.reviews.find((review) => review.action === "prepare-plan")!.detail).toContain(p.plan!.scopeApproval!.expiresAt);
    const renewalReview = f.reviews.find((review) => review.action === "request-scope-again")!;
    for (const text of [oldId, newId, p.plan!.digest, renewed.plan!.scopeApproval!.expiresAt, "separate action", "unconsumed"]) expect(renewalReview.detail).toContain(text);
    await f.reopen(); expect((await f.app.snapshot(p.projectId)).selected!.plan).toEqual(renewed.plan);
    const sealed = await saved(f.app, scopeCommand(renewed, "approve-scope"));
    expect(sealed.plan).toMatchObject({ state: "sealed", sealedByApprovalId: newId });
    expect(f.reviews.find((review) => review.action === "approve-scope")!.detail).toContain(renewed.plan!.scopeApproval!.expiresAt);
    await f.reopen(); expect((await f.app.snapshot(p.projectId)).selected!.plan!.sealedByApprovalId).toBe(newId);
    const final = await authority(f, p); expect(final.pairs.find((item) => item.pair.approval.approvalRequestId === newId)!.pair.approval.consumptionCount).toBe(1);
  });

  it("refuses renewal before expiry and preserves cancellation without automatically retrying", async () => {
    const f = await fixture(), p = await awaiting(f, false), before = await authority(f, p), reviews = f.reviews.length;
    expect(await f.app.command(scopeCommand(p))).toMatchObject({ kind: "refused", reason: "approval.not-expired" }); expect(f.reviews).toHaveLength(reviews);
    f.time.value = Date.parse(p.plan!.scopeApproval!.expiresAt); f.control.confirm = async () => false;
    const cancelled = scopeCommand(p); expect((await f.app.command(cancelled)).kind).toBe("cancelled");
    f.control.confirm = async () => { throw new Error("CANCELLED_COMMAND_MUST_NOT_RECONFIRM"); };
    expect((await f.app.command(cancelled)).kind).toBe("cancelled"); expect((await f.app.observe(cancelled.commandId)).kind).toBe("cancelled");
    await f.reopen(); expect(await authority(f, p)).toEqual(before); expect((await f.app.snapshot(p.projectId)).selected!.plan!.actions).toEqual(["request-scope-again"]);
  });

  it.each(["approvalId", "approvalVersion", "metadataId", "metadataVersion", "metadataDigest"] as const)("refuses stale %s before native confirmation", async (key) => {
    const f = await fixture(), p = await awaiting(f), command = scopeCommand(p), before = await authority(f, p), reviews = f.reviews.length;
    const value = command.scopeRequest[key], changed = typeof value === "number" ? value + 1 : key === "metadataDigest" ? "f".repeat(64) : `${value}:stale`;
    expect(await f.app.command({ ...command, scopeRequest: { ...command.scopeRequest, [key]: changed } })).toMatchObject({ kind: "conflict", reason: "scope.subject-conflict" });
    expect(f.reviews).toHaveLength(reviews); expect(await authority(f, p)).toEqual(before);
  });

  it.each(["stop", "binding-drift"] as const)("rechecks %s after native renewal confirmation", async (change) => {
    const f = await fixture(), p = await awaiting(f), before = await authority(f, p);
    f.control.confirm = async (review) => {
      if (review.action !== "request-scope-again") return true;
      if (change === "stop") await saved(f.app, { kind: "stop-project", commandId: commandId(), projectId: p.projectId, expectedProjectVersion: p.version });
      else await f.store.persistence.transact(async (tx) => {
        const row = (await tx.aggregates.get("project", p.projectId))!, project = parseProject(row.payload);
        await tx.aggregates.update({ aggregateType: "project", aggregateId: p.projectId, schemaVersion: 1, expectedVersion: row.aggregateVersion, payload: parseProject({ ...project, revision: project.revision + 1, displayName: "Owned changed binding", updatedAt: new Date(f.time.value).toISOString() }) });
      });
      return true;
    };
    const outcome = await f.app.command(scopeCommand(p)); expect(["refused", "conflict"]).toContain(outcome.kind);
    const after = await authority(f, p); expect(after.pairs).toEqual(before.pairs); expect(after.metadata).toEqual(before.metadata); expect(after.planEvents).toEqual(before.planEvents);
    expect((await f.app.snapshot(p.projectId)).selected!.plan!.actions).toEqual([]);
  });

  it("serializes competing renewals and never retargets stale approval or replays into another request", async () => {
    const f = await fixture(), p = await awaiting(f), first = scopeCommand(p), second = scopeCommand(p), staleApproval = scopeCommand(p, "approve-scope");
    let release!: () => void, entered!: () => void, count = 0;
    const waiting = new Promise<void>((resolve) => { entered = resolve; }), hold = new Promise<void>((resolve) => { release = resolve; });
    f.control.confirm = async (review) => { if (review.action === "request-scope-again" && ++count === 1) { entered(); await hold; } return true; };
    const pending = f.app.command(first); await waiting;
    expect((await f.app.command(first)).kind).toBe("unknown"); expect((await f.app.observe(first.commandId)).kind).toBe("unknown");
    const winner = await saved(f.app, second); release(); expect(await pending).toMatchObject({ kind: "conflict", reason: "scope.subject-conflict" });
    expect(await f.app.command(staleApproval)).toMatchObject({ kind: "conflict", reason: "scope.subject-conflict" });
    const before = await authority(f, p), reviews = f.reviews.length;
    expect((await f.app.command(second)).kind).toBe("committed"); expect((await f.app.observe(second.commandId)).kind).toBe("committed");
    expect(f.reviews).toHaveLength(reviews); expect(await authority(f, p)).toEqual(before); expect(winner.approvals).toHaveLength(2);
  });

  it("observes a lost renewal acknowledgment exactly once after full reopen", async () => {
    const f = await fixture(), p = await awaiting(f), command = scopeCommand(p); f.fault.loseReply = true;
    expect((await f.app.command(command)).kind).toBe("unknown"); await f.reopen();
    const outcome = await f.app.observe(command.commandId); expect(outcome.kind).toBe("committed");
    const before = await authority(f, p); expect(before.pairs).toHaveLength(2);
    expect((await f.app.command(command)).kind).toBe("committed"); expect(await authority(f, p)).toEqual(before);
  });

  it.each(["approval.create", "project.planning-updated"])("rolls back expiry, successor and receipts when %s fails", async (event) => {
    const f = await fixture(), p = await awaiting(f), before = await authority(f, p), command = scopeCommand(p); f.fault.event = event;
    expect((await f.app.command(command)).kind).toBe("unknown");
    expect((await f.app.observe(command.commandId)).kind).toBe("not-recorded");
    const inner = await f.store.persistence.transact(async (tx) => [await observePlanningReceipt(tx, `${command.commandId}:expire`), await observePlanningReceipt(tx, `${command.commandId}:create`)]);
    expect(inner).toEqual([null, null]); expect(await authority(f, p)).toEqual(before);
    await f.reopen(); expect(await authority(f, p)).toEqual(before);
    const renewed = await saved(f.app, scopeCommand(p)); expect(renewed.plan!.state).toBe("awaiting_scope_approval"); expect(renewed.approvals).toHaveLength(2);
  });

  it("does not create a successor whose confirmed validity has itself expired", async () => {
    const f = await fixture(), p = await awaiting(f), before = await authority(f, p);
    f.control.confirm = async () => { f.time.value += 24 * 60 * 60 * 1000; return true; };
    expect(await f.app.command(scopeCommand(p))).toMatchObject({ kind: "refused", reason: "approval.expired" });
    expect(await authority(f, p)).toEqual(before);
  });

  it("refuses approval when its validity expires during the separate confirmation", async () => {
    const f = await fixture(), p = await awaiting(f, false), before = await authority(f, p);
    f.control.confirm = async () => { f.time.value = Date.parse(p.plan!.scopeApproval!.expiresAt); return true; };
    expect(await f.app.command(scopeCommand(p, "approve-scope"))).toMatchObject({ kind: "refused", reason: "approval.expired" });
    expect(await authority(f, p)).toEqual(before);
  });

  it("keeps a committed Stop and its observed outcome known after an export is edited", async () => {
    const f = await fixture(); let p = await draft(f.app);
    p = await saved(f.app, { kind: "export-handover", commandId: commandId(), projectId: p.projectId, expectedPlanVersion: p.plan!.version });
    const target = p.handovers[0]!.fileName, original = await readFile(target, "utf8"), changed = original.replaceAll("\n", "\r\n");
    expect(resolve(target).startsWith(resolve(f.store.artifactRoot) + sep)).toBe(true); await writeFile(target, changed);
    const command = { kind: "stop-project" as const, commandId: commandId(), projectId: p.projectId, expectedProjectVersion: p.version };
    const outcome = await f.app.command(command); expect(outcome).toMatchObject({ kind: "committed", projectionWarning: "handover-files" });
    expect(outcome.workspace!.selected!.handovers[0]!.artifactState).toBe("differs-on-disk");
    expect(await f.app.observe(command.commandId)).toMatchObject({ kind: "committed", projectionWarning: "handover-files" });
    expect((await f.app.snapshot(p.projectId)).selected?.stopped).toBe(true); expect(await readFile(target, "utf8")).toBe(changed);
    p = await saved(f.app, { kind: "resume-project", commandId: commandId(), projectId: p.projectId, expectedProjectVersion: p.version });
    const second = { kind: "export-handover" as const, commandId: commandId(), projectId: p.projectId, expectedPlanVersion: p.plan!.version };
    p = await saved(f.app, second); expect(p.handovers).toHaveLength(2); expect(p.handovers.filter((h) => h.artifactState === "published")).toHaveLength(1);
    const healthy = p.handovers.find((h) => h.artifactState === "published")!;
    expect(await readFile(healthy.fileName, "utf8")).toBe((await f.app.handover(p.projectId, healthy.handoverId)).text);
    const other = await draft(f.app), beforeHistory = (await f.app.snapshot(p.projectId)).selected!.history;
    await f.reopen(); expect((await f.app.snapshot(other.projectId)).selected!.plan!.digest).toBe(other.plan!.digest);
    expect((await f.app.snapshot(p.projectId)).projects).toHaveLength(2); expect((await f.app.handover(p.projectId, outcome.workspace!.selected!.handovers[0]!.handoverId)).text).toBe(original);
    expect((await f.app.command(command)).kind).toBe("committed"); expect((await f.app.command(second)).kind).toBe("committed");
    expect((await f.app.snapshot(p.projectId)).selected!.history).toEqual(beforeHistory); expect(await readFile(target, "utf8")).toBe(changed);
    await writeFile(target, original); expect((await f.app.snapshot(p.projectId)).selected!.handovers.every((h) => h.artifactState === "published")).toBe(true);
  });

  it("reopens saved projects when an exported file differs from the authoritative record", async () => {
    const f = await fixture(); let p = await draft(f.app);
    p = await saved(f.app, { kind: "export-handover", commandId: commandId(), projectId: p.projectId, expectedPlanVersion: p.plan!.version });
    const target = p.handovers[0]!.fileName, savedText = (await f.app.handover(p.projectId, p.handovers[0]!.handoverId)).text;
    const changed = "An operator edited this exported copy.\n"; await writeFile(target, changed);
    await f.reopen(); const reopened = (await f.app.snapshot(p.projectId)).selected!;
    expect(reopened.plan).toEqual(p.plan); expect((await f.app.handover(p.projectId, p.handovers[0]!.handoverId)).text).toBe(savedText);
    expect(await readFile(target, "utf8")).toBe(changed);
  });

  it("keeps the database accessible when the artifact root is unavailable and refreshes after recovery", async () => {
    const f = await fixture(); let p = await draft(f.app);
    p = await saved(f.app, { kind: "export-handover", commandId: commandId(), projectId: p.projectId, expectedPlanVersion: p.plan!.version });
    const artifactRoot = resolve(f.store.artifactRoot), backup = join(resolve(f.root), "preserved-artifacts");
    expect(artifactRoot.startsWith(resolve(f.root) + sep)).toBe(true); expect(backup.startsWith(resolve(f.root) + sep)).toBe(true);
    await rename(artifactRoot, backup); await writeFile(artifactRoot, "Owned unavailable-root fixture", { flag: "wx" });
    await f.reopen(); expect((await f.app.snapshot(p.projectId)).selected!.handovers[0]!.artifactState).toBe("unavailable");
    const outcome = await f.app.command({ kind: "stop-project", commandId: commandId(), projectId: p.projectId, expectedProjectVersion: p.version });
    expect(outcome).toMatchObject({ kind: "committed", projectionWarning: "handover-files" });
    expect((await f.app.handover(p.projectId, p.handovers[0]!.handoverId)).artifactState).toBe("unavailable"); expect(await readFile(artifactRoot, "utf8")).toBe("Owned unavailable-root fixture");
    await unlink(artifactRoot); await rename(backup, artifactRoot);
    expect((await f.app.snapshot(p.projectId)).selected!.handovers[0]!.artifactState).toBe("published");
  });

  it.each(["unavailable", "corrupt"] as const)("preserves known command/Observe outcomes if workspace enrichment is %s", async (mode) => {
    const f = await fixture(), p = await draft(f.app), command = { kind: "stop-project" as const, commandId: commandId(), projectId: p.projectId, expectedProjectVersion: p.version };
    f.fault.afterCommit = async () => {
      if (mode === "unavailable") f.fault.snapshotUnavailable = true;
      else await f.store.persistence.transact(async (tx) => {
        const m = await readPlanningMetadata(tx, p.projectId);
        await tx.aggregates.update({ aggregateType: "planning-workspace", aggregateId: m.envelope.aggregateId, expectedVersion: m.envelope.aggregateVersion, schemaVersion: 1, payload: {} });
      });
    };
    const expected = { kind: "committed", workspace: null, projectionWarning: `workspace-${mode}` };
    expect(await f.app.command(command)).toMatchObject(expected); expect(await f.app.observe(command.commandId)).toMatchObject(expected); expect(await f.app.command(command)).toMatchObject(expected);
    const receipt = await f.store.persistence.transact((tx) => observePlanningReceipt(tx, command.commandId));
    expect(receipt!.result.kind).toBe("committed");
    const stops = await f.store.persistence.transact((tx) => listPlanningAggregates(tx, "project-stop")); expect(stops).toHaveLength(1);
    const journal = await f.store.persistence.transact((tx) => listPlanningEvents(tx, "project-stop", stops[0]!.aggregateId)); expect(journal).toHaveLength(1);
    // Use the receipt's actual stored aggregate identity, not an assumed prefix.
    const commands = await f.store.persistence.transact((tx) => listPlanningAggregates(tx, "planning-command")), stored = commands.find((row) => (row.payload as { commandId: string }).commandId === command.commandId)!;
    const completed = await f.store.persistence.transact((tx) => listPlanningEvents(tx, "planning-command", stored.aggregateId));
    expect(completed.filter((row) => row.eventType === "planning-command.completed")).toHaveLength(1);
    if (mode === "corrupt") { await f.reopen(); await expect(f.app.snapshot(p.projectId)).rejects.toMatchObject({ kind: "corrupt" }); }
  });

  it("keeps an unverifiable lost-reply receipt corrupt, without a projection warning or duplicate writes", async () => {
    const f = await fixture(), p = await draft(f.app), command = { kind: "stop-project" as const, commandId: commandId(), projectId: p.projectId, expectedProjectVersion: p.version };
    f.fault.loseReply = true; expect((await f.app.command(command)).kind).toBe("unknown"); f.fault.hideCompleted = true;
    expect(await f.app.observe(command.commandId)).toMatchObject({ kind: "corrupt", workspace: null, projectionWarning: null });
    expect((await f.app.command(command)).kind).toBe("corrupt");
    expect(await f.store.persistence.transact((tx) => listPlanningAggregates(tx, "project-stop"))).toHaveLength(1);
    f.fault.hideCompleted = false; expect((await f.app.observe(command.commandId)).kind).toBe("committed");
  });

  it("refuses a corrupt durable handover instead of labeling it an export-file warning", async () => {
    const f = await fixture(); let p = await draft(f.app);
    p = await saved(f.app, { kind: "export-handover", commandId: commandId(), projectId: p.projectId, expectedPlanVersion: p.plan!.version });
    const handover = p.handovers[0]!, bytes = await readFile(handover.fileName);
    await f.store.persistence.transact(async (tx) => {
      const row = (await tx.aggregates.get("planning-handover", handover.handoverId))!;
      await tx.aggregates.update({ aggregateType: "planning-handover", aggregateId: row.aggregateId, expectedVersion: row.aggregateVersion, schemaVersion: 1, payload: {} });
    });
    await expect(f.app.snapshot(p.projectId)).rejects.toMatchObject({ kind: "corrupt", reason: "handover.corrupt" });
    await expect(f.reopen()).rejects.toMatchObject({ kind: "corrupt" }); expect(await readFile(handover.fileName)).toEqual(bytes);
  });
});
