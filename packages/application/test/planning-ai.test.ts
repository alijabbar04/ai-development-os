import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import type { PersistenceAdapter, TransactionContext } from "@ai-dev-os/persistence";
import { assembleCandidate, createC7IntakeStore, createClarificationSession, prepareCandidateAcceptance, type PreparedAcceptance } from "@ai-dev-os/intake";
import { createSavedPlanningApplication, type PlanningNativeReview, type SavedPlanningApplication } from "../src/planning.js";
import { openPlanningStorage } from "../src/planning-storage.js";
import { createOwnedAiTestPort, ownedAiOutput, ownedAiResult } from "../src/testing/planning-ai-fixture.js";
import type { AiPlanningCommand, PlanningCommand, PlanningProjectView } from "../src/planning-contracts.js";
import { readAiRecord, aiPlanningRecordId, readAiContribution, aiContributionId } from "../src/planning-ai-storage.js";
import { readPlanningFoundations } from "../src/planning-plan.js";
import { digestPlanning, parsePlanningCommand, planningHash } from "../src/planning-validation.js";
import { observePlanningReceipt } from "../src/planning-ledger.js";

let ordinal = 0;
const id = () => `ai-test:${++ordinal}`;
const owned: { root: string; app: SavedPlanningApplication; close(): Promise<void> }[] = [];
afterEach(async () => { for (const f of owned.splice(0)) { await f.app.drain(); await f.close(); if (!resolve(f.root).startsWith(join(resolve(tmpdir()), "owned-ai-planning-"))) throw new Error("FIXTURE_OWNERSHIP"); await rm(f.root, { recursive: true, force: true }); } });
async function fixture(options: { sqlite?: boolean; blocked?: boolean; execute?: Parameters<typeof createOwnedAiTestPort>[0]["execute"] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "owned-ai-planning-")); await mkdir(join(root, "repository"));
  let store = options.sqlite ? await openPlanningStorage(join(root, "saved")) : null;
  let persistence: PersistenceAdapter = store?.persistence ?? createMemoryPersistenceAdapter();
  const port = createOwnedAiTestPort(options.execute === undefined ? {} : { execute: options.execute }), reviews: PlanningNativeReview[] = [];
  let confirmAction: (review: PlanningNativeReview) => Promise<boolean> = async () => true;
  const fault: { loseEvent: string | null; failEvent: string | null } = { loseEvent: null, failEvent: null };
  const decorate = (): PersistenceAdapter => ({ ...persistence, async transact<T>(work: (tx: TransactionContext) => Promise<T> | T): Promise<T> {
    let lose = false;
    const value = await persistence.transact((tx) => work({ ...tx, events: { ...tx.events, async append(input) {
      if (input.eventType === fault.failEvent) { fault.failEvent = null; throw new Error("OWNED_TRANSACTION_ROLLBACK"); }
      const event = await tx.events.append(input); if (input.eventType === fault.loseEvent) { fault.loseEvent = null; lose = true; } return event;
    } } }));
    if (lose) throw new Error("OWNED_COMMIT_ACK_LOST"); return value;
  } });
  const compose = () => createSavedPlanningApplication({ persistence: decorate(), artifactRoot: join(root, "saved", "artifacts"),
    ...(options.blocked ? {} : { planningProcess: port.host }), operator: { async confirm(review) { reviews.push(review); return confirmAction(review); }, selectRepository: async () => join(root, "repository"), selectResult: async () => null } });
  let app = compose(); await app.initialize();
  const owner = { root, app, close: async () => { await persistence.close(); } }; owned.push(owner);
  const initial = await app.command({ kind: "create-project", commandId: id(), name: "Field journal", objective: "Keep local field observations", outcomes: ["Retain notes after reopening"], budgetMinorUnits: 1000, currency: "GBP" });
  expect(initial.kind, JSON.stringify(initial)).toBe("committed"); const projectId = initial.projectId!;
  const f = { root, port, reviews, fault, projectId,
    get app() { return app; }, get persistence() { return persistence; },
    confirm(value: typeof confirmAction) { confirmAction = value; },
    async project() { return (await app.snapshot(projectId)).selected!; },
    async run(command: PlanningCommand) { return app.command(command); },
    async start() { const p = await f.project(); return f.commit({ kind: "start-ai-planning", commandId: id(), projectId, expectedSessionVersion: p.aiPlanning.version, description: "Keep local field observations", includeRepositorySummary: false }); },
    async commit(command: PlanningCommand): Promise<PlanningProjectView> { const result = await app.command(command); expect(result.kind, JSON.stringify(result)).toBe("committed"); expect(result.workspace?.selected, JSON.stringify(result)).toBeTruthy(); return result.workspace!.selected!; },
    async action(kind: "request-ai-understanding" | "request-ai-proposal" | "accept-ai-brief" | "adopt-ai-proposal", commandId = id()) {
      const p = await f.project(); return f.commit({ kind, commandId, projectId, sessionId: p.aiPlanning.currentSession!.sessionId, expectedSessionVersion: p.aiPlanning.version, contextDigest: p.aiPlanning.contextDigest });
    },
    async save(change: (draft: NonNullable<PlanningProjectView["aiPlanning"]["currentSession"]>["draft"]) => NonNullable<PlanningProjectView["aiPlanning"]["currentSession"]>["draft"]) {
      const p = await f.project(); return f.commit({ kind: "save-ai-planning-draft", commandId: id(), projectId, sessionId: p.aiPlanning.currentSession!.sessionId, expectedSessionVersion: p.aiPlanning.version, draft: change(p.aiPlanning.currentSession!.draft) });
    },
    async terminal() {
      const until = Date.now() + 10_000;
      while (Date.now() < until) { const p = await f.project(); if (p.aiPlanning.currentSession!.activeRequestId === null) return p; await new Promise((done) => setTimeout(done, 5)); }
      throw new Error(`AI_TERMINAL_DEADLINE ${JSON.stringify(await f.project())}`);
    },
    async understood() { await f.start(); await f.action("request-ai-understanding"); const p = await f.terminal(); expect(p.aiPlanning.currentSession!.requests.at(-1)?.state, JSON.stringify(p.aiPlanning)).toBe("succeeded"); return p; },
    async accepted() { const p = await f.understood(); await f.save((draft) => ({ ...draft, answers: p.aiPlanning.currentSession!.questions.map((q) => ({ questionId: q.questionId, value: "No, text notes only." })) })); return f.action("accept-ai-brief"); },
    async proposed() { await f.accepted(); port.setPurpose("proposal"); await f.action("request-ai-proposal"); const p = await f.terminal(); expect(p.aiPlanning.currentSession!.requests.at(-1)?.state, JSON.stringify(p.aiPlanning)).toBe("succeeded"); return p; },
    async reopen() {
      await app.drain(); if (store !== null) { await store.close(); store = await openPlanningStorage(join(root, "saved")); persistence = store.persistence; }
      app = compose(); owner.app = app; await app.initialize(); return f.project();
    },
  };
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function subject(f: Fixture, kind: "request-ai-understanding" | "request-ai-proposal" | "accept-ai-brief" | "adopt-ai-proposal"): Promise<AiPlanningCommand> {
  const p = await f.project(); return { kind, commandId: id(), projectId: f.projectId, sessionId: p.aiPlanning.currentSession!.sessionId, expectedSessionVersion: p.aiPlanning.version, contextDigest: p.aiPlanning.contextDigest };
}
function deferred() { let release!: (result: ReturnType<typeof ownedAiResult>) => void; const pending = new Promise<ReturnType<typeof ownedAiResult>>((done) => { release = done; }); return { pending, release }; }

describe("saved development AI planning application", { timeout: 30_000 }, () => {
  it("performs the complete real SQLite describe/clarify/accept/propose/edit/adopt/reopen journey with immutable model provenance", async () => {
    const f = await fixture({ sqlite: true }), proposed = await f.proposed();
    expect(proposed.brief?.objective).toBe("Keep local field observations"); expect(proposed.plan).toBeNull();
    const originalDigest = proposed.aiPlanning.currentSession!.proposalContributionDigest!;
    await f.save((draft) => ({ ...draft, proposal: { ...draft.proposal!, tasks: draft.proposal!.tasks.map((t, i) => i === 0 ? { ...t, title: "Record a field observation", acceptanceCriteria: ["A saved note survives two reopenings."] } : t) } }));
    const adopted = await f.action("adopt-ai-proposal"), head = await f.persistence.transact((tx) => readPlanningFoundations(tx, f.projectId));
    expect(adopted.plan?.state).toBe("drafting"); expect(adopted.plan?.actions).toEqual(["prepare-plan"]);
    expect(head.head!.headEvent.payload.review.assemblyRequest.proposal.source).toMatchObject({ kind: "model", authority: "none", contributionDigest: originalDigest, adoption: { edits: expect.any(Array) } });
    expect(head.head!.headEvent.payload.review.authenticatedOperatorEvidence).toContainEqual(expect.objectContaining({ fieldPath: "title", value: "Record a field observation" }));
    expect(head.head!.plan.dependencies).toHaveLength(1); expect(head.head!.plan.tasks.every((t) => t.budget.maximumTurns === 0 && t.budget.maximumToolCalls === 0)).toBe(true);
    const model = await f.persistence.transact((tx) => readAiContribution(tx, originalDigest, f.projectId, adopted.aiPlanning.currentSession!.sessionId));
    expect(model.output).toMatchObject({ tasks: [expect.objectContaining({ title: "Capture a field note" }), expect.anything()] });
    const reopened = await f.reopen(); expect(reopened.brief).toEqual(adopted.brief); expect(reopened.plan).toEqual(adopted.plan); expect(reopened.aiPlanning).toEqual(adopted.aiPlanning); expect(f.port.dispatched).toHaveLength(2);
    const prepared = await f.commit({ kind: "prepare-plan", commandId: id(), projectId: f.projectId, expectedPlanVersion: reopened.plan!.version });
    expect(prepared.plan?.state).toBe("awaiting_scope_approval"); expect(prepared.approvals[0]?.state).toBe("requested");
    expect(f.reviews.filter((r) => r.action.startsWith("request-ai-")).every((r) => r.detail.includes("synthetic-fixture") && r.detail.includes("remainingVendorAllowance"))).toBe(true);
  });
  it("refuses the default unqualified route before native request review or inference while retaining the description", async () => {
    const f = await fixture({ blocked: true }); await f.start(); const count = f.reviews.length;
    expect(await f.run(await subject(f, "request-ai-understanding"))).toMatchObject({ kind: "refused", reason: "ai.LIVE_ROUTE_BLOCKED" });
    expect(f.reviews).toHaveLength(count); expect(f.port.dispatched).toHaveLength(0); expect((await f.reopen()).aiPlanning.currentSession).toMatchObject({ requestCount: 0, draft: { description: "Keep local field observations" } });
  });
  it.each(["request-ai-understanding", "accept-ai-brief", "adopt-ai-proposal"] as const)("cancelled %s has no model/canonical effect and can be separately confirmed later", async (kind) => {
    const f = await fixture(); if (kind === "adopt-ai-proposal") await f.proposed(); else if (kind === "accept-ai-brief") { const p = await f.understood(); await f.save((d) => ({ ...d, answers: p.aiPlanning.currentSession!.questions.map((q) => ({ questionId: q.questionId, value: "Text only" })) })); } else await f.start();
    const before = await f.project(), calls = f.port.dispatched.length; f.confirm(async (r) => r.action !== kind);
    expect(await f.run(await subject(f, kind))).toMatchObject({ kind: "cancelled", reason: "operator.cancelled" });
    const after = await f.project(); expect(after.aiPlanning).toEqual(before.aiPlanning); expect(after.brief).toEqual(before.brief); expect(after.plan).toEqual(before.plan); expect(f.port.dispatched).toHaveLength(calls);
  });
  it("refuses acceptance until the requested clarification is explicitly answered", async () => {
    const f = await fixture(); await f.understood(); expect(await f.run(await subject(f, "accept-ai-brief"))).toMatchObject({ kind: "refused", reason: "ai.clarification-answer-required" }); expect((await f.project()).brief).toBeNull();
  });
  it("keeps operator-edited suggested requirements distinct in canonical C8 acceptance", async () => {
    const f = await fixture(), p = await f.understood(); await f.save((d) => ({ ...d, understanding: { ...d.understanding!, outcomes: ["Retain text notes after a restart"] }, answers: p.aiPlanning.currentSession!.questions.map((q) => ({ questionId: q.questionId, value: "Text only" })) }));
    const accepted = await f.action("accept-ai-brief"); expect(accepted.brief?.outcomes).toEqual(["Retain text notes after a restart"]); expect(accepted.aiPlanning.currentSession?.draft.understanding?.summary).toBe("Plan a local field journal");
  });
  it("replaying an admitted request does not call the model twice or erase its established command outcome", async () => {
    const f = await fixture(); await f.start(); const request = await subject(f, "request-ai-understanding"); await f.commit(request); await f.terminal();
    expect(await f.run(request)).toMatchObject({ kind: "committed" }); expect(await f.app.observe(request.commandId)).toMatchObject({ kind: "committed" }); expect(f.port.dispatched).toHaveLength(1);
    expect(await f.run({ ...request, contextDigest: "0".repeat(64) })).toMatchObject({ kind: "conflict", reason: "command.material-conflict" });
  });
  it("binds confirmation to the current exact session and refuses stale actions", async () => {
    const f = await fixture(); await f.start(); const stale = await subject(f, "request-ai-understanding"); await f.save((d) => ({ ...d, description: "A different explicitly saved objective" }));
    expect(await f.run(stale)).toMatchObject({ kind: "conflict", reason: "ai.context-conflict" }); expect(f.port.dispatched).toHaveLength(0);
  });
  it("does not overwrite edits made while a request is in flight and retains the late model contribution", async () => {
    const hold = deferred(), f = await fixture({ execute: async () => hold.pending }); await f.start(); await f.action("request-ai-understanding");
    while (f.port.dispatched.length === 0) await new Promise((done) => setTimeout(done, 2));
    await f.save((d) => ({ ...d, description: "A revised objective during the request" })); hold.release(ownedAiResult(ownedAiOutput("understanding")));
    const p = await f.terminal(); expect(p.aiPlanning.currentSession?.draft.description).toBe("A revised objective during the request"); expect(p.aiPlanning.currentSession?.draft.understanding).toBeNull();
    expect(p.aiPlanning.currentSession?.requests[0]).toMatchObject({ state: "stale", contributionDigest: expect.any(String) });
  });
  it("allows one active request per project and retains unknown usage after explicit cancellation and late output", async () => {
    const hold = deferred(), f = await fixture({ execute: async () => hold.pending }); await f.start(); await f.action("request-ai-understanding");
    while (f.port.dispatched.length === 0) await new Promise((done) => setTimeout(done, 2));
    expect(await f.run(await subject(f, "request-ai-understanding"))).toMatchObject({ kind: "refused", reason: "ai.request-in-flight" });
    const p = await f.project(), session = p.aiPlanning.currentSession!;
    await f.commit({ kind: "cancel-ai-request", commandId: id(), projectId: f.projectId, sessionId: session.sessionId, requestId: session.activeRequestId! });
    hold.release(ownedAiResult(ownedAiOutput("understanding"))); await new Promise((done) => setTimeout(done, 20));
    const after = await f.reopen(); expect(after.aiPlanning.currentSession?.draft.understanding).toBeNull(); expect(after.aiPlanning.currentSession?.requests[0]).toMatchObject({ state: "cancelled", usageState: "unknown" }); expect(f.port.dispatched).toHaveLength(1);
  });
  it("stop revokes active inference, preserves requests, and resume dispatches nothing", async () => {
    const hold = deferred(), f = await fixture({ execute: async () => hold.pending }); await f.start(); await f.action("request-ai-understanding"); while (!f.port.dispatched.length) await new Promise((done) => setTimeout(done, 2));
    let p = await f.project(); p = await f.commit({ kind: "stop-project", commandId: id(), projectId: f.projectId, expectedProjectVersion: p.version });
    expect(p.stopped).toBe(true); expect(p.aiPlanning.currentSession?.requests[0]).toMatchObject({ state: "cancelled", usageState: "unknown" }); hold.release(ownedAiResult(ownedAiOutput("understanding")));
    p = await f.commit({ kind: "resume-project", commandId: id(), projectId: f.projectId, expectedProjectVersion: p.version }); expect(p.stopped).toBe(false); expect(f.port.dispatched).toHaveLength(1); expect(p.aiPlanning.currentSession?.draft.understanding).toBeNull();
  });
  it("enforces three explicit requests and two clarification rounds, with a separately confirmed new session", async () => {
    const f = await fixture(); const first = await f.understood(); await f.save((d) => ({ ...d, answers: first.aiPlanning.currentSession!.questions.map((q) => ({ questionId: q.questionId, value: "Text only" })) })); await f.action("request-ai-understanding"); await f.terminal();
    expect(await f.run(await subject(f, "request-ai-understanding"))).toMatchObject({ kind: "refused", reason: "ai.local-request-cap" });
    const p = await f.project(); await f.save((d) => ({ ...d, answers: p.aiPlanning.currentSession!.questions.map((q) => ({ questionId: q.questionId, value: "Text only" })) })); await f.action("accept-ai-brief"); f.port.setPurpose("proposal"); await f.action("request-ai-proposal"); await f.terminal();
    expect(await f.run(await subject(f, "request-ai-proposal"))).toMatchObject({ kind: "refused", reason: "ai.local-request-cap" }); const next = await f.start(); expect(next.aiPlanning.sessions).toHaveLength(2); expect(next.aiPlanning.sessions[0]?.requests).toHaveLength(3); expect(next.aiPlanning.currentSession?.requestCount).toBe(0); expect(f.port.dispatched).toHaveLength(3);
  });
  it("includes repository metadata only after explicit selection and exact native review", async () => {
    const f = await fixture(); await f.start(); await f.save((d) => ({ ...d, includeRepositorySummary: true })); await f.action("request-ai-understanding"); await f.terminal();
    const record = await f.persistence.transact((tx) => readAiRecord(tx, f.projectId)); expect(record.record.sessions[0]?.requests[0]?.context).toMatchObject({ repositorySummary: { rootLeaf: "repository" } });
    expect(f.reviews.find((r) => r.action === "request-ai-understanding")?.detail).toContain('"repositorySummary"'); expect(f.reviews.find((r) => r.action === "request-ai-understanding")?.detail).not.toContain(f.root);
  });
  it("refuses plan generation without explicit canonical brief acceptance", async () => { const f = await fixture(); await f.understood(); expect(await f.run(await subject(f, "request-ai-proposal"))).toMatchObject({ kind: "refused", reason: "ai.accepted-brief-required" }); expect(f.port.dispatched).toHaveLength(1); });
  it("retains valid blocked model limitations without creating an adoptable plan", async () => {
    const f = await fixture(); await f.accepted(); f.port.setPurpose("proposal"); f.port.setOutput({ ...ownedAiOutput("proposal"), status: "blocked", tasks: [], openQuestions: ["Which retention period is required?"] }); await f.action("request-ai-proposal"); const p = await f.terminal();
    expect(p.aiPlanning.currentSession?.draft.proposal).toBeNull(); expect(p.aiPlanning.currentSession?.requests.at(-1)).toMatchObject({ state: "refused", usageState: "reported", contributionDigest: expect.any(String), modelNotes: { openQuestions: ["Which retention period is required?"] } }); expect(p.plan).toBeNull();
  });
  it.each(["malformed", "missing-reply", "quota"] as const)("retains a terminal %s refusal with no automatic retry or false not-called usage", async (kind) => {
    const f = await fixture({ execute: async (_input, result) => kind === "missing-reply" ? { ...result, state: "termination-unconfirmed", exitCode: null, terminationConfirmed: false, stdout: new Uint8Array() } : kind === "quota" ? { ...result, exitCode: 1, stdout: Buffer.from(JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, errors: ["usage limit"] })) } : { ...result, stdout: Buffer.from("not-json") } }); await f.start(); await f.action("request-ai-understanding"); const p = await f.terminal();
    expect(p.aiPlanning.currentSession?.requests[0]?.state).not.toBe("succeeded"); expect(p.aiPlanning.currentSession?.requests[0]?.usageState).toBe("unknown"); expect(p.aiPlanning.currentSession?.draft.understanding).toBeNull(); expect((await f.reopen()).aiPlanning.currentSession?.requestCount).toBe(1); expect(f.port.dispatched).toHaveLength(1);
  });
  it("retains an incomplete but schema-valid model contribution as a finite refusal across reopen", async () => {
    const f = await fixture({ sqlite: true });
    await f.start();
    f.port.setOutput({ ...ownedAiOutput("understanding"), assumptions: ["Text notes only; the audience is unresolved."] });
    await f.action("request-ai-understanding");
    const p = await f.terminal(), request = p.aiPlanning.currentSession!.requests[0]!;
    expect(request).toMatchObject({ state: "refused", usageState: "reported", contributionDigest: expect.any(String),
      reason: "The model output is incomplete for an editable brief or task plan. Its original contribution remains saved." });
    expect(p.aiPlanning.currentSession!.draft.understanding).toBeNull();
    const retained = await f.reopen();
    expect(retained.aiPlanning.currentSession!.requests[0]).toEqual(request);
    expect(f.port.dispatched).toHaveLength(1);
  });
  it.each(["ai.request-dispatched", "ai.request-terminal"] as const)("a lost %s commit reply preserves its actual evidence and does not resend", async (event) => {
    const f = await fixture(); await f.start(); f.fault.loseEvent = event; const request = await subject(f, "request-ai-understanding"); await f.commit(request);
    if (event === "ai.request-terminal") await f.terminal(); else { while ((await f.project()).aiPlanning.currentSession?.requests[0]?.state === "admitted") await new Promise((done) => setTimeout(done, 2)); }
    const p = await f.reopen(); expect(await f.app.observe(request.commandId)).toMatchObject({ kind: "committed" }); expect(f.port.dispatched).toHaveLength(event === "ai.request-dispatched" ? 0 : 1);
    expect(p.aiPlanning.currentSession?.requests[0]?.usageState).toBe(event === "ai.request-dispatched" ? "unknown" : "reported");
  });
  it("a failed terminal transaction retains dispatched-unknown evidence for recovery", async () => {
    const f = await fixture(); await f.start(); f.fault.failEvent = "ai.request-terminal"; await f.action("request-ai-understanding"); while (!f.port.dispatched.length) await new Promise((done) => setTimeout(done, 2));
    await new Promise((done) => setTimeout(done, 20)); const p = await f.reopen(); expect(p.aiPlanning.currentSession?.requests[0]).toMatchObject({ state: "outcome-unknown", usageState: "unknown" }); expect(p.aiPlanning.currentSession?.draft.understanding).toBeNull(); expect(f.port.dispatched).toHaveLength(1);
  });
  it("does not permit editing an adopted artifact's marker or grafting a different dependency graph", async () => {
    const f = await fixture(); let p = await f.proposed(), s = p.aiPlanning.currentSession!;
    expect(await f.run({ kind: "save-ai-planning-draft", commandId: id(), projectId: f.projectId, sessionId: s.sessionId, expectedSessionVersion: p.aiPlanning.version, draft: { ...s.draft, proposal: { ...s.draft.proposal!, tasks: s.draft.proposal!.tasks.map((t) => ({ ...t, dependsOn: [] })) } } })).toMatchObject({ kind: "refused", reason: "ai.proposal-structure-edit-refused" });
    p = await f.action("adopt-ai-proposal"); s = p.aiPlanning.currentSession!;
    expect(await f.run({ kind: "save-ai-planning-draft", commandId: id(), projectId: f.projectId, sessionId: s.sessionId, expectedSessionVersion: p.aiPlanning.version, draft: { ...s.draft, description: "Hide the adopted plan" } })).toMatchObject({ kind: "refused", reason: "ai.adopted-draft-locked" }); expect((await f.project()).aiPlanning.currentSession?.adoptedPlanDigest).toBe(p.plan?.digest);
  });
  it("keeps genuine session and immutable contribution corruption visible", async () => {
    const f = await fixture(); const p = await f.understood(), c = p.aiPlanning.currentSession!.understandingContributionDigest!;
    await f.persistence.transact(async (tx) => { const row = (await tx.aggregates.get("planning-ai-contribution", aiContributionId(c)))!; await tx.aggregates.update({ aggregateType: row.aggregateType, aggregateId: row.aggregateId, schemaVersion: 1, expectedVersion: 1, payload: row.payload }); });
    await expect(f.app.snapshot(f.projectId)).rejects.toMatchObject({ kind: "corrupt", reason: "ai.contribution-corrupt" });
    const other = await fixture(); await other.start(); await other.persistence.transact(async (tx) => { const row = (await tx.aggregates.get("planning-ai-session", aiPlanningRecordId(other.projectId)))!; await tx.aggregates.update({ aggregateType: row.aggregateType, aggregateId: row.aggregateId, schemaVersion: 1, expectedVersion: row.aggregateVersion, payload: { ...row.payload as object, authority: "operator" } }); });
    await expect(other.app.snapshot(other.projectId)).rejects.toMatchObject({ kind: "corrupt", reason: "ai.session-corrupt" });
  });
  it("provides a separate scope approval path even when model task objectives repeat the accepted brief exactly", async () => {
    const f = await fixture(); await f.accepted(); f.port.setPurpose("proposal"); const raw = ownedAiOutput("proposal"); f.port.setOutput({ ...raw, tasks: [raw.tasks[0]] });
    await f.action("request-ai-proposal"); await f.terminal(); let p = await f.action("adopt-ai-proposal");
    expect(p.plan?.scope).toBe("scope-expansion"); p = await f.commit({ kind: "prepare-plan", commandId: id(), projectId: f.projectId, expectedPlanVersion: p.plan!.version });
    expect(p.plan?.state).toBe("awaiting_scope_approval"); expect(p.plan?.actions).toEqual(["approve-scope"]);
    p = await f.commit({ kind: "approve-scope", commandId: id(), projectId: f.projectId, expectedPlanVersion: p.plan!.version, scopeRequest: p.plan!.scopeApproval!.subject });
    expect(p.plan?.state).toBe("sealed"); expect(p.approvals[0]?.state).toBe("consumed"); expect(f.port.dispatched).toHaveLength(2);
  });
  it("retains model authorship when proposed collections are deleted or reordered", async () => {
    const f = await fixture(); f.port.setOutput({ ...ownedAiOutput("understanding"), completionCriteria: ["Retain the note", "Find the note"], assumptions: ["Audience: Field researchers", "Audience: Journal reviewers", "Non-goal: Cloud synchronization", "Non-goal: Photo uploads", "An operator reviews requirements.", "A reviewer checks retention."] });
    const p = await f.understood(); await f.save((d) => ({ ...d, understanding: { ...d.understanding!, outcomes: [d.understanding!.outcomes[1]!], audiences: [...d.understanding!.audiences].reverse(), nonGoals: [...d.understanding!.nonGoals].reverse(), assumptions: [d.understanding!.assumptions[1]!] }, answers: p.aiPlanning.currentSession!.questions.map((q) => ({ questionId: q.questionId, value: "Text only" })) }));
    const command = await subject(f, "accept-ai-brief"); await f.commit(command); const receipt = await f.persistence.transact((tx) => observePlanningReceipt(tx, command.commandId)); const candidate = (receipt!.material as { prepared: PreparedAcceptance }).prepared.candidate;
    expect([...candidate.outcomes, ...candidate.audiences, ...candidate.nonGoals].every((field) => field.provenance.source === "model-proposed")).toBe(true); expect(candidate.assumptions.find((a) => a.text === "A reviewer checks retention.")).toMatchObject({ source: "model", provenance: { source: "model-proposed" } });
  });
  it("carries inherited operator and model constraints through canonical AI brief acceptance", async () => {
    const f = await fixture(), field = (value: string) => ({ value, provenance: { source: "operator-supplied" as const, acceptedByOperator: true } });
    const constraints = [
      { value: { constraintId: "constraint:runtime", kind: "technology-required" as const, statement: "Use Node.js 22 or later.", enforcement: "hard" as const, machineForm: { runtime: "node", minimumMajor: 22 }, origin: "operator" as const, authority: "operator" as const }, possible: true, provenance: { source: "operator-supplied" as const, acceptedByOperator: true } },
      { value: { constraintId: "constraint:suggestion", kind: "technology-required" as const, statement: "Consider a portable local storage format.", enforcement: "advisory" as const, machineForm: null, origin: "model" as const, authority: "none" as const }, possible: true, provenance: { source: "model-proposed" as const, acceptedByOperator: true } },
    ];
    const candidate = assembleCandidate({ projectId: f.projectId, objective: field("Keep local field observations"), outcomes: [field("Retain notes")], nonGoals: [], audiences: [field("Field researchers")], constraints, assumptions: [], openQuestions: [], sourceThreadId: null }, planningHash);
    const prepared = prepareCandidateAcceptance({ candidate, presentedDigest: candidate.candidateDigest, expectedHead: null, expectedAggregateVersion: 0, clarification: createClarificationSession(), operatorConfirmed: true }, { digest: planningHash, clock: { now: () => new Date() } });
    expect((await createC7IntakeStore(f.persistence, planningHash).attempt(prepared)).kind).toBe("committed");
    await f.accepted(); const head = await f.persistence.transact((tx) => readPlanningFoundations(tx, f.projectId)); expect(head.accepted!.brief.constraints).toEqual(constraints.map((c) => c.value));
  });
  it("attempts owned cancellation during shutdown even when the durable revoke write fails", async () => {
    let aborted = false;
    const f = await fixture({ execute: async (input) => new Promise((done) => { input.signal.addEventListener("abort", () => { aborted = true; done({ state: "cancelled", exitCode: null, stdout: new Uint8Array(), stderrBytes: 0, truncated: false, terminationConfirmed: true }); }, { once: true }); }) });
    await f.start(); await f.action("request-ai-understanding"); const until = Date.now() + 5000; while (!f.port.dispatched.length && Date.now() < until) await new Promise((done) => setTimeout(done, 2)); expect(f.port.dispatched).toHaveLength(1);
    f.fault.failEvent = "ai.requests-revoked"; await expect(f.app.drain()).rejects.toThrow("AI_DRAIN_WRITE_UNCONFIRMED"); expect(aborted).toBe(true); expect((await f.reopen()).aiPlanning.currentSession?.requests[0]).toMatchObject({ state: "cancelled", usageState: "unknown" });
  });
  it.each(["executable", "modelId", "authority", "credentialRef", "clock", "fallback"])("rejects renderer-supplied %s instead of accepting a host capability", async (key) => {
    const f = await fixture(); await f.start(); const request = await subject(f, "request-ai-understanding"); expect(() => parsePlanningCommand({ ...request, [key]: "forged" })).toThrow(); expect(f.port.dispatched).toHaveLength(0);
  });
});
