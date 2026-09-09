import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PersistenceError, canonicalizeWithChecksum, type PersistenceAdapter, type TransactionContext } from "@ai-dev-os/persistence";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import { IntakeError } from "@ai-dev-os/intake";
import { PlanContractError } from "@ai-dev-os/plan";
import { createSavedPlanningApplication, type PlanningNativeReview } from "../src/planning.js";
import { openPlanningStorage } from "../src/planning-storage.js";
import { aiPlanningRecordId, parseAiRecord, readAiRecord } from "../src/planning-ai-storage.js";
import { readPlanningFoundations } from "../src/planning-plan.js";
import type { AiPlanningDraft, PlanningCommand, PlanningProjectView } from "../src/planning-contracts.js";
import { createOwnedAiTestPort, ownedAiOutput } from "../src/testing/planning-ai-fixture.js";

let ordinal = 0;
const id = () => `ai-history-test:${++ordinal}`;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanups.splice(0)) await dispose(); });

async function fixture(sqlite = false, processOptions: Parameters<typeof createOwnedAiTestPort>[0] = {}) {
  const parent = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(parent, "owned-ai-history-")));
  await mkdir(join(root, "repository"));
  let store = sqlite ? await openPlanningStorage(join(root, "saved")) : null;
  let persistence: PersistenceAdapter = store?.persistence ?? createMemoryPersistenceAdapter();
  const port = createOwnedAiTestPort(processOptions), reviews: PlanningNativeReview[] = [];
  let hideSession = false;
  const fault: { aggregateType: "project-brief" | "project-plan" | "planning-ai-session" | null; mode: "storage" | "corrupt" | "lost-commit" | null; confirmationError: Error | null } = { aggregateType: null, mode: null, confirmationError: null };
  const decorate = (): PersistenceAdapter => ({ ...persistence, transact: async (work) => {
    let loseCommitReply = false;
    const value = await persistence.transact((tx) => work({ ...tx, aggregates: { ...tx.aggregates,
      get: async (type, aggregateId) => hideSession && type === "planning-ai-session" ? null : tx.aggregates.get(type, aggregateId),
    }, events: { ...tx.events, append: async (input) => {
      const event = await tx.events.append(input);
      if (input.aggregateType === fault.aggregateType) {
        const mode = fault.mode; fault.aggregateType = null; fault.mode = null;
        if (mode === "storage") throw new PersistenceError("STORAGE_FAILURE", "OWNED_CANONICAL_WRITE_UNCONFIRMED");
        if (mode === "corrupt") throw new PlanContractError("PLAN_STORE_CORRUPT", "plan.store.corrupt", "planStore");
        loseCommitReply = mode === "lost-commit";
      }
      return event;
    } } }));
    if (loseCommitReply) throw new Error("OWNED_CANONICAL_COMMIT_REPLY_LOST");
    return value;
  } });
  const compose = () => createSavedPlanningApplication({ persistence: decorate(), artifactRoot: join(root, "saved", "artifacts"), planningProcess: port.host,
    operator: { async confirm(review) { reviews.push(review); const error = fault.confirmationError; fault.confirmationError = null; if (error !== null) throw error; return true; }, selectRepository: async () => join(root, "repository"), selectResult: async () => null } });
  let app = compose();
  cleanups.push(async () => {
    await app.drain(); if (store === null) await persistence.close(); else await store.close();
    const target = await realpath(root);
    if (target !== root || dirname(target) !== parent || !basename(target).startsWith("owned-ai-history-")) throw new Error("REFUSE_UNOWNED_AI_HISTORY_CLEANUP");
    await rm(target, { recursive: true, force: true });
  });
  await app.initialize();
  const created = await app.command({ kind: "create-project", commandId: id(), name: "Clarification history", objective: "Keep local field observations", outcomes: ["Retain notes after reopening"], budgetMinorUnits: 1000, currency: "GBP" });
  expect(created.kind, JSON.stringify(created)).toBe("committed"); const projectId = created.projectId!;
  const f = { port, reviews, projectId, get persistence() { return persistence; }, get app() { return app; },
    hideSession() { hideSession = true; },
    fault(aggregateType: "project-brief" | "project-plan" | "planning-ai-session", mode: "storage" | "corrupt" | "lost-commit") { fault.aggregateType = aggregateType; fault.mode = mode; },
    rejectConfirmation(error: Error) { fault.confirmationError = error; },
    async project() { return (await app.snapshot(projectId)).selected!; },
    async commit(command: PlanningCommand): Promise<PlanningProjectView> { const result = await app.command(command); expect(result.kind, JSON.stringify(result)).toBe("committed"); return result.workspace!.selected!; },
    async start() { const p = await f.project(); return f.commit({ kind: "start-ai-planning", commandId: id(), projectId, expectedSessionVersion: p.aiPlanning.version, description: "Keep local field observations", includeRepositorySummary: false }); },
    async subject(kind: "request-ai-understanding" | "request-ai-proposal" | "accept-ai-brief" | "adopt-ai-proposal") {
      const p = await f.project(); return { kind, commandId: id(), projectId, sessionId: p.aiPlanning.currentSession!.sessionId, expectedSessionVersion: p.aiPlanning.version, contextDigest: p.aiPlanning.contextDigest };
    },
    async action(kind: "request-ai-understanding" | "request-ai-proposal" | "accept-ai-brief" | "adopt-ai-proposal") { return f.commit(await f.subject(kind)); },
    async save(change: (draft: AiPlanningDraft) => AiPlanningDraft) { const p = await f.project(); return f.commit({ kind: "save-ai-planning-draft", commandId: id(), projectId, sessionId: p.aiPlanning.currentSession!.sessionId, expectedSessionVersion: p.aiPlanning.version, draft: change(p.aiPlanning.currentSession!.draft) }); },
    async answer(value: string) { const p = await f.project(); return f.save((draft) => ({ ...draft, answers: p.aiPlanning.currentSession!.questions.map((q) => ({ questionId: q.questionId, value })) })); },
    async terminal() {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) { const p = await f.project(); if (p.aiPlanning.currentSession!.activeRequestId === null) return p; await new Promise((done) => setTimeout(done, 5)); }
      throw new Error("OWNED_AI_HISTORY_TERMINAL_DEADLINE");
    },
    async first() { await f.start(); await f.action("request-ai-understanding"); return f.terminal(); },
    async reopen() { await app.drain(); if (store !== null) { await store.close(); store = await openPlanningStorage(join(root, "saved")); persistence = store.persistence; } app = compose(); await app.initialize(); return f.project(); },
  };
  return f;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function canonicalSubject(f: Fixture, aggregateType: "project-brief" | "project-plan") {
  await f.first(); await f.answer("Text observations only.");
  if (aggregateType === "project-plan") {
    await f.action("accept-ai-brief"); f.port.setOutput(ownedAiOutput("proposal")); await f.action("request-ai-proposal"); await f.terminal();
  }
  return f.subject(aggregateType === "project-brief" ? "accept-ai-brief" : "adopt-ai-proposal");
}
async function commandEvidence(f: Fixture, commandId: string) {
  return f.persistence.transact(async (tx) => {
    const rows = await tx.aggregates.list({ aggregateType: "planning-command" });
    const row = rows.items.find((r) => (r.payload as unknown as { commandId: string }).commandId === commandId)!;
    return { row, journal: await tx.events.list({ aggregateType: "planning-command", aggregateId: row.aggregateId }) };
  });
}

describe("saved AI clarification round history", { timeout: 30_000 }, () => {
  it("retains distinct first-round answers through a second round, canonical C8 acceptance, plan adoption and physical reopen", async () => {
    const f = await fixture(true), first = await f.first(), firstQuestion = first.aiPlanning.currentSession!.questions[0]!;
    await f.answer("Text observations only; photographs are excluded.");
    f.port.setOutput({ ...ownedAiOutput("understanding"), openQuestions: ["How long should the saved field observations remain available?"] });
    await f.action("request-ai-understanding"); const second = await f.terminal(), secondQuestion = second.aiPlanning.currentSession!.questions[0]!;
    expect(secondQuestion.questionId).not.toBe(firstQuestion.questionId);
    expect(second.aiPlanning.currentSession!.clarificationHistory[0]?.answers).toEqual([{ questionId: firstQuestion.questionId, value: "Text observations only; photographs are excluded." }]);
    expect(second.aiPlanning.currentSession!.clarificationHistory[1]?.materialChangeReason).toContain("saved answers");
    expect(second.aiPlanning.currentSession!.draft.answers).toEqual([]);
    await f.answer("Retain observations for one year.");
    await f.action("accept-ai-brief");
    const foundations = await f.persistence.transact((tx) => readPlanningFoundations(tx, f.projectId));
    expect(foundations.accepted?.brief.assumptions.some((a) => a.text.includes("photographs are excluded"))).toBe(true);
    expect(foundations.accepted?.brief.assumptions.some((a) => a.text.includes("one year"))).toBe(true);
    const journal = await f.persistence.transact((tx) => tx.events.list({ aggregateType: "project-brief", aggregateId: foundations.accepted!.aggregateId }));
    const decisions = (journal.items[0]!.payload as unknown as { decisions: { kind: string; rationale: string }[] }).decisions.filter((d) => d.kind === "clarification-answer");
    expect(decisions).toHaveLength(2);
    const rounds = decisions.map((d) => JSON.parse(d.rationale) as { ordinal: number; materialChangeReason: string | null; resolutions: { kind: string; value: string }[] });
    expect(rounds.map((r) => r.ordinal)).toEqual([1, 2]); expect(rounds[0]?.materialChangeReason).toBeNull(); expect(rounds[1]?.materialChangeReason).toContain("saved answers");
    expect(rounds.map((r) => r.resolutions[0])).toEqual([{ kind: "answered", questionId: firstQuestion.questionId, value: "Text observations only; photographs are excluded." }, { kind: "answered", questionId: secondQuestion.questionId, value: "Retain observations for one year." }]);
    const acceptReview = f.reviews.find((r) => r.action === "accept-ai-brief")!;
    expect(acceptReview.detail).toContain("photographs are excluded"); expect(acceptReview.detail).toContain("one year");
    f.port.setOutput(ownedAiOutput("proposal")); await f.action("request-ai-proposal"); await f.terminal(); const adopted = await f.action("adopt-ai-proposal"), reopened = await f.reopen();
    expect(reopened.plan?.digest).toBe(adopted.plan?.digest); expect(reopened.aiPlanning.currentSession?.clarificationHistory).toEqual(adopted.aiPlanning.currentSession?.clarificationHistory);
    expect(await f.app.command(await f.subject("request-ai-understanding"))).toMatchObject({ kind: "refused", reason: "ai.local-request-cap" }); expect(f.port.dispatched).toHaveLength(3);
  });

  it("does not send a second clarification request until previous questions have explicit saved answers", async () => {
    const f = await fixture(); await f.first();
    expect(await f.app.command(await f.subject("request-ai-understanding"))).toMatchObject({ kind: "refused", reason: "ai.previous-clarification-unanswered" });
    expect(f.port.dispatched).toHaveLength(1); expect((await f.project()).aiPlanning.currentSession?.requestCount).toBe(1);
    expect(await f.app.command(await f.subject("accept-ai-brief"))).toMatchObject({ kind: "refused", reason: "ai.clarification-answer-required" });
  });

  it("deduplicates a repeated model question while retaining the original answered round and both C8 rounds", async () => {
    const f = await fixture(); await f.first(); await f.answer("Text only."); await f.action("request-ai-understanding"); const second = await f.terminal();
    expect(second.aiPlanning.currentSession!.questions).toEqual([]); expect(second.aiPlanning.currentSession!.clarificationHistory).toHaveLength(2);
    expect(second.aiPlanning.currentSession!.clarificationHistory[0]?.answers[0]?.value).toBe("Text only."); expect(second.aiPlanning.currentSession!.clarificationHistory[1]?.answers).toEqual([]);
    expect(second.aiPlanning.currentSession!.requests[1]?.modelNotes?.openQuestions).toContain("Should field notes include photographs?");
    await f.action("accept-ai-brief");
    const foundations = await f.persistence.transact((tx) => readPlanningFoundations(tx, f.projectId));
    expect(foundations.accepted?.brief.assumptions.filter((a) => a.text.includes("Text only.")).length).toBe(1);
    const current = await f.persistence.transact((tx) => readAiRecord(tx, f.projectId)), raw = structuredClone(current.record);
    (raw.sessions[0]!.clarificationHistory[0]!.answers[0] as { value: string }).value = "Invented earlier answer.";
    expect(() => parseAiRecord(raw)).toThrow();
  });

  it("does not invent a material-change reason when a question-free understanding is requested again unchanged", async () => {
    const f = await fixture(); f.port.setOutput({ ...ownedAiOutput("understanding"), status: "viable", openQuestions: [] }); await f.first();
    expect(await f.app.command(await f.subject("request-ai-understanding"))).toMatchObject({ kind: "refused", reason: "ai.clarification-material-change-required" });
    expect(f.port.dispatched).toHaveLength(1);
    await f.save((draft) => ({ ...draft, description: "Keep local observations for a full annual research cycle." })); await f.action("request-ai-understanding"); const second = await f.terminal();
    expect(second.aiPlanning.currentSession!.clarificationHistory[1]?.materialChangeReason).toContain("changed the saved project description");
    expect((await f.action("accept-ai-brief")).brief?.objective).toBe("Keep local observations for a full annual research cycle.");
  });

  it("refuses a missing session aggregate with retained history and preserves the original records", async () => {
    const f = await fixture(); const started = await f.start(), recordId = aiPlanningRecordId(f.projectId);
    const before = await f.persistence.transact(async (tx) => ({ row: await tx.aggregates.get("planning-ai-session", recordId), events: await tx.events.list({ aggregateType: "planning-ai-session", aggregateId: recordId }) }));
    f.hideSession();
    await expect(f.app.snapshot(f.projectId)).rejects.toMatchObject({ kind: "corrupt", reason: "ai.session-journal-corrupt" });
    expect(await f.app.command({ kind: "start-ai-planning", commandId: id(), projectId: f.projectId, expectedSessionVersion: 0, description: "Attempt a replacement", includeRepositorySummary: false })).toMatchObject({ kind: "corrupt", reason: "ai.session-journal-corrupt" });
    const after = await f.persistence.transact(async (tx) => ({ row: await tx.aggregates.get("planning-ai-session", recordId), events: await tx.events.list({ aggregateType: "planning-ai-session", aggregateId: recordId }) }));
    expect(after).toEqual(before); expect(started.aiPlanning.currentSession).not.toBeNull(); expect(f.port.dispatched).toHaveLength(0);
  });

  it("rejects checksum-valid history questions that differ from the immutable model contribution", async () => {
    const f = await fixture(); await f.first();
    const current = await f.persistence.transact((tx) => readAiRecord(tx, f.projectId)), raw = structuredClone(current.record);
    const session = raw.sessions[0]!, changed = { ...session.questions[0]!, question: "A question never present in the model contribution." };
    (session as unknown as { questions: unknown; clarificationHistory: unknown }).questions = [changed];
    (session.clarificationHistory[0] as unknown as { questions: unknown }).questions = [changed];
    const fault = (tx: TransactionContext): TransactionContext => ({ ...tx, aggregates: { ...tx.aggregates, get: async (type, aggregateId) => {
      const row = await tx.aggregates.get(type, aggregateId); return type === "planning-ai-session" && row !== null ? { ...row, payload: raw as never, checksum: canonicalizeWithChecksum(raw).checksum } : row;
    } }, events: { ...tx.events, list: async (input) => {
      const page = await tx.events.list(input); if (input?.aggregateType !== "planning-ai-session") return page;
      return { ...page, items: page.items.map((event) => { if (event.aggregateVersion !== current.version) return event; const payload = { ...event.payload as object, record: raw }; return { ...event, payload: payload as never, checksum: canonicalizeWithChecksum(payload).checksum }; }) };
    } } });
    await expect(f.persistence.transact((tx) => readAiRecord(fault(tx), f.projectId))).rejects.toMatchObject({ kind: "corrupt", reason: "ai.clarification-history-corrupt" });
    expect((await f.reopen()).aiPlanning.currentSession!.questions[0]?.question).toBe("Should field notes include photographs?");
  });

  it.each(["project-brief", "project-plan"] as const)("retains an uncertain %s write as unknown until Observe proves the rolled-back transaction", async (aggregateType) => {
    const f = await fixture(), command = await canonicalSubject(f, aggregateType);
    const before = await f.persistence.transact((tx) => readPlanningFoundations(tx, f.projectId));
    f.fault(aggregateType, "storage");
    const result = await f.app.command(command);
    expect(result).toMatchObject({ kind: "unknown", reason: aggregateType === "project-brief" ? "intake.persistence.unknown" : "ai.command-outcome-unconfirmed" });
    const evidence = await commandEvidence(f, command.commandId);
    expect(evidence.row.payload).toMatchObject({ kind: "planning-command-intent" });
    expect(evidence.journal.items.map((e) => e.eventType)).toEqual(["planning-command.intent"]);
    const after = await f.persistence.transact((tx) => readPlanningFoundations(tx, f.projectId));
    expect(after.accepted).toEqual(before.accepted); expect(after.head).toEqual(before.head);
    expect(await f.app.observe(command.commandId)).toMatchObject({ kind: "not-recorded", reason: "command.interrupted-before-commit" });
    expect(await f.app.command(command)).toMatchObject({ kind: "not-recorded" });
    expect(await commandEvidence(f, command.commandId)).toEqual(evidence);
  });

  it.each(["project-brief", "project-plan"] as const)("recovers a lost outer commit reply for %s from its original committed receipt without rewriting it", async (aggregateType) => {
    const f = await fixture(), command = await canonicalSubject(f, aggregateType);
    f.fault(aggregateType, "lost-commit");
    expect(await f.app.command(command)).toMatchObject({ kind: "unknown", reason: "ai.command-outcome-unconfirmed" });
    const evidence = await commandEvidence(f, command.commandId);
    expect(evidence.row.payload).toMatchObject({ result: { kind: "committed" } });
    expect(evidence.journal.items.map((e) => e.eventType)).toEqual(["planning-command.intent", "planning-command.completed"]);
    const saved = await f.persistence.transact((tx) => readPlanningFoundations(tx, f.projectId));
    if (aggregateType === "project-brief") expect(saved.accepted).not.toBeNull(); else expect(saved.head?.plan.state).toBe("drafting");
    expect(await f.app.observe(command.commandId)).toMatchObject({ kind: "committed" });
    expect(await f.app.command(command)).toMatchObject({ kind: "committed" });
    expect(await commandEvidence(f, command.commandId)).toEqual(evidence);
    expect(await f.persistence.transact((tx) => readPlanningFoundations(tx, f.projectId))).toEqual(saved);
  });

  it("preserves a C9 store-corruption classification and does not turn it into a refusal receipt", async () => {
    const f = await fixture(), command = await canonicalSubject(f, "project-plan");
    f.fault("project-plan", "corrupt");
    expect(await f.app.command(command)).toMatchObject({ kind: "corrupt", reason: "plan.store.corrupt" });
    const evidence = await commandEvidence(f, command.commandId);
    expect(evidence.row.payload).toMatchObject({ kind: "planning-command-intent" });
    expect(evidence.journal.items.map((e) => e.eventType)).toEqual(["planning-command.intent"]);
    expect((await f.persistence.transact((tx) => readPlanningFoundations(tx, f.projectId))).head).toBeNull();
  });

  it.each(["cancel-ai-request", "stop-project"] as const)("still aborts the owned request after consented %s loses its commit acknowledgement", async (kind) => {
    let aborted = false;
    const f = await fixture(false, { execute: async (input) => new Promise((done) => {
      input.signal.addEventListener("abort", () => { aborted = true; done({ state: "cancelled", exitCode: null, stdout: new Uint8Array(), stderrBytes: 0, truncated: false, terminationConfirmed: true }); }, { once: true });
    }) });
    await f.start(); await f.action("request-ai-understanding");
    const deadline = Date.now() + 10_000;
    while (f.port.dispatched.length === 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5));
    expect(f.port.dispatched).toHaveLength(1);
    const p = await f.project(), session = p.aiPlanning.currentSession!, commandId = id();
    const command: PlanningCommand = kind === "cancel-ai-request"
      ? { kind, commandId, projectId: f.projectId, sessionId: session.sessionId, requestId: session.activeRequestId! }
      : { kind, commandId, projectId: f.projectId, expectedProjectVersion: p.version };
    f.fault("planning-ai-session", "lost-commit");
    expect(await f.app.command(command)).toMatchObject({ kind: "unknown", reason: kind === "cancel-ai-request" ? "ai.command-outcome-unconfirmed" : "command.outcome-unconfirmed" });
    expect(aborted).toBe(true); expect(f.port.dispatched[0]!.signal.aborted).toBe(true);
    expect(f.reviews.some((review) => review.action === kind)).toBe(true);
    const evidence = await commandEvidence(f, commandId);
    expect(evidence.row.payload).toMatchObject({ result: { kind: "committed" } });
    expect(evidence.journal.items.map((e) => e.eventType)).toEqual(["planning-command.intent", "planning-command.completed"]);
    expect(await f.app.observe(commandId)).toMatchObject({ kind: "committed" });
    const after = await f.project();
    expect(after.stopped).toBe(kind === "stop-project");
    expect(after.aiPlanning.currentSession?.requests[0]).toMatchObject({ state: "cancelled", usageState: "unknown" });
    expect(after.aiPlanning.currentSession?.draft.understanding).toBeNull();
    expect(await commandEvidence(f, commandId)).toEqual(evidence);
  });

  it.each([
    { error: new IntakeError("intake.persistence.unknown", "store"), kind: "unknown", reason: "intake.persistence.unknown" },
    { error: new PlanContractError("PLAN_STORE_CORRUPT", "plan.store.corrupt", "planStore"), kind: "corrupt", reason: "plan.store.corrupt" },
  ] as const)("keeps a trusted-port $kind exception distinct from semantic refusal", async ({ error, kind, reason }) => {
    const f = await fixture(), p = await f.project(), command = { kind: "start-ai-planning" as const, commandId: id(), projectId: f.projectId, expectedSessionVersion: p.aiPlanning.version, description: "Keep local field observations", includeRepositorySummary: false };
    f.rejectConfirmation(error);
    expect(await f.app.command(command)).toMatchObject({ kind, reason });
    const evidence = await commandEvidence(f, command.commandId);
    expect(evidence.row.payload).toMatchObject({ kind: "planning-command-intent" }); expect(evidence.journal.items).toHaveLength(1);
    expect((await f.project()).aiPlanning.currentSession).toBeNull(); expect(f.port.dispatched).toHaveLength(0);
  });
});
