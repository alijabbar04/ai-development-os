import { describe, expect, it } from "vitest";
import { createBudgetAccount, parseAggregateBudget } from "@ai-dev-os/domain";
import { assembleCandidate, createC7IntakeStore, createClarificationSession, prepareCandidateAcceptance } from "@ai-dev-os/intake";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import type { PersistenceAdapter } from "@ai-dev-os/persistence";
import { parseProject } from "@ai-dev-os/project";
import { operationKindsOf, promoteDraft, type PlanCommitAuthorization, type PlanCommitRequest, type PlanHeadEventPayload } from "@ai-dev-os/plan";
import { createPlanPersistenceBoundary } from "@ai-dev-os/plan/persistence-boundary";
import { buildAiPlanRequest, type BuildAiPlanRequestInput } from "../src/planning-ai-plan.js";
import type { AiPlanningProposal } from "../src/planning-ai-contracts.js";
import { bindPlanningSteps, readPlanningFoundations, type PlanningFoundations } from "../src/planning-plan.js";
import { digestPlanning, planningHash } from "../src/planning-validation.js";
import type { PlanningConfirmation } from "../src/planning-ledger.js";

const at = "2026-09-09T00:00:00.000Z", later = "2026-09-09T00:01:00.000Z";
const projectId = "prj:ai-adoption-test", contributionDigest = "a".repeat(64), routeFingerprint = "b".repeat(64), requestId = "ai-request:owned-proposal";
const original: AiPlanningProposal = Object.freeze({ title: "Keep useful local field notes", tasks: [
  { taskId: "capture", title: "Capture a note", objective: "Save a local field note", acceptanceCriteria: ["A saved note remains after reopening", "A cancelled edit preserves the previous note"], dependsOn: [] },
  { taskId: "search", title: "Find a note", objective: "Search the saved field notes", acceptanceCriteria: ["A matching note appears in search results"], dependsOn: ["capture"] },
] });
const edited: AiPlanningProposal = { ...original, title: "Review and retain local field notes", tasks: original.tasks.map((task, index) => index === 0 ? { ...task, title: "Capture an observation", acceptanceCriteria: ["A saved note survives two reopenings", task.acceptanceCriteria[1]!] } : task) };

function confirmation(commandId: string, time = at): PlanningConfirmation {
  return { reviewId: `native-review:${commandId}`, identityRef: "operator:local-desktop", approverClass: "project-owner", confirmedAt: time, subjectDigest: digestPlanning({ commandId, original, edited }) };
}

async function acceptBrief(adapter: PersistenceAdapter, foundations: PlanningFoundations | null = null) {
  const operator = { source: "operator-supplied" as const, acceptedByOperator: true }, model = { source: "model-proposed" as const, acceptedByOperator: false };
  const candidate = assembleCandidate({ projectId, objective: { value: "Keep searchable local field notes.", provenance: operator }, outcomes: [{ value: foundations === null ? "Retain field notes after reopening." : "Retain and search field notes after reopening.", provenance: model }], nonGoals: [], audiences: [{ value: "A local field observer", provenance: model }], constraints: [], assumptions: [], openQuestions: [], sourceThreadId: null }, planningHash);
  const prepared = prepareCandidateAcceptance({ candidate, presentedDigest: candidate.candidateDigest, expectedHead: foundations?.accepted?.brief ?? null, expectedAggregateVersion: foundations?.accepted?.aggregateVersion ?? 0, clarification: createClarificationSession(), operatorConfirmed: true }, { digest: planningHash, clock: { now: () => new Date(foundations === null ? at : later) } });
  expect((await createC7IntakeStore(adapter, planningHash).attempt(prepared)).kind).toBe("committed");
}

async function fixture() {
  const adapter = createMemoryPersistenceAdapter();
  const project = parseProject({ schemaVersion: 1, projectId, revision: 1, displayName: "Owned AI adoption fixture", repositoryRoots: ["C:\\OwnedFixtures\\AiAdoption"], defaultBranch: null,
    dataClassification: "internal", permissionMode: "contained-default", budgetAccountId: "budget:ai-adoption-test", effectiveConfigDigest: "c".repeat(64), status: "active", createdAt: at, updatedAt: at });
  const budget = createBudgetAccount({ scope: { scopeType: "project", scopeId: projectId }, budget: parseAggregateBudget({ tokens: null, money: { limit: { currency: "GBP", amountMicros: 20_000_000 }, softLimit: null }, time: null }) });
  await adapter.transact(async (tx) => {
    await tx.aggregates.create({ aggregateType: "project", aggregateId: projectId, schemaVersion: 1, payload: project });
    await tx.aggregates.create({ aggregateType: "budget-account", aggregateId: project.budgetAccountId, schemaVersion: 1, payload: budget });
  });
  await acceptBrief(adapter);
  const read = () => adapter.transact((tx) => readPlanningFoundations(tx, projectId));
  const foundations = await read();
  return { adapter, foundations, read };
}

function input(foundations: PlanningFoundations, commandId = "adopt-one"): BuildAiPlanRequestInput {
  return { commandId, original, edited, requestId, contributionDigest, routeFingerprint, narrativeRef: null, foundations, confirmation: confirmation(commandId, foundations.head === null ? at : later) };
}

async function commit(adapter: PersistenceAdapter, request: PlanCommitRequest) {
  const token = Object.freeze(Object.create(null)) as PlanCommitAuthorization;
  let available = true;
  const store = createPlanPersistenceBoundary(adapter, { take(value) {
    if (value !== token || !available) return null;
    available = false;
    return { projectId: request.projectId, contentDigest: request.binding.contentDigest, operationKinds: operationKindsOf(request), eventIds: request.steps.map((step) => step.eventId),
      authenticatedOperatorEvidence: request.steps[0].event.review.authenticatedOperatorEvidence, decisions: request.steps.flatMap((step) => step.event.decisions) };
  } });
  return store.commit(request, token);
}

describe("canonical saved AI proposal adoption", () => {
  it("builds and commits a model-attributed draft with edited prose, actual request provenance and preserved dependencies", async () => {
    const f = await fixture();
    try {
      const request = buildAiPlanRequest(input(f.foundations)), step = request.steps[0], review = step.event.review;
      expect(step.event.kind).toBe("plan.drafted");
      expect(step.plan?.state).toBe("drafting"); expect(step.plan?.sealedByApprovalId).toBeNull(); expect(step.event.decisions).toEqual([]);
      expect(review.assemblyRequest.proposal.source).toMatchObject({ kind: "model", authority: "none", contributionDigest, routeFingerprint, narrativeRef: null });
      expect(review.authenticatedOperatorEvidence.length).toBe(5);
      expect(review.provenance.tasks.some((task) => task.fields["title"]?.origin === "model")).toBe(true);
      expect(review.provenance.tasks.some((task) => task.fields["title"]?.origin === "operator-edit")).toBe(true);
      expect(step.plan?.dependencies).toHaveLength(1);
      const captured = step.plan!.tasks.find((task) => task.title === edited.tasks[0]!.title)!, search = step.plan!.tasks.find((task) => task.title === edited.tasks[1]!.title)!;
      expect(step.plan?.dependencies[0]).toMatchObject({ fromTaskId: captured.taskId, toTaskId: search.taskId, kind: "finish-to-start" });
      expect(step.plan!.tasks.every((task) => task.state === "pending" && task.budget.maximumTurns === 0 && task.budget.maximumToolCalls === 0 && task.workspaceMode === "none")).toBe(true);
      expect(review.specification?.intentDigest).toBe(f.foundations.accepted!.briefContentDigest);
      expect(review.specification?.requirements.every((requirement) => requirement.sourceProvenance[0]?.contributionId === `ai-contribution:${contributionDigest}` && requirement.sourceProvenance[0]?.phaseId === requestId)).toBe(true);
      expect((await commit(f.adapter, request)).kind).toBe("committed");
      const head = await f.read();
      expect(head.head?.headEvent.payload.review).toEqual(review);
      expect(head.accepted?.brief).toEqual(f.foundations.accepted?.brief);
    } finally { await f.adapter.close(); }
  });

  it.each(["task-id", "task-order", "dependency", "criteria-count", "extra-authority"] as const)("refuses unsupported edits before canonical writes: %s", async (change) => {
    const f = await fixture();
    try {
      const changed = structuredClone(edited) as { title: string; tasks: { taskId: string; title: string; objective: string; acceptanceCriteria: string[]; dependsOn: string[] }[] };
      if (change === "task-id") { changed.tasks[0]!.taskId = "different"; changed.tasks[1]!.dependsOn = ["different"]; }
      if (change === "task-order") changed.tasks.reverse();
      if (change === "dependency") changed.tasks[1]!.dependsOn = [];
      if (change === "criteria-count") changed.tasks[0]!.acceptanceCriteria.pop();
      if (change === "extra-authority") Object.assign(changed, { approvalId: "apr:invented" });
      expect(() => buildAiPlanRequest({ ...input(f.foundations), edited: changed })).toThrow();
      expect((await f.read()).head).toBeNull();
    } finally { await f.adapter.close(); }
  });

  it("requires a real accepted brief, active controls and syntactically bound source/confirmation metadata", async () => {
    const f = await fixture();
    try {
      expect(() => buildAiPlanRequest({ ...input(f.foundations), foundations: { ...f.foundations, accepted: null } })).toThrow();
      expect(() => buildAiPlanRequest({ ...input(f.foundations), foundations: { ...f.foundations, stopped: true } })).toThrow();
      expect(() => buildAiPlanRequest({ ...input(f.foundations), contributionDigest: "not-a-digest" })).toThrow();
      expect(() => buildAiPlanRequest({ ...input(f.foundations), routeFingerprint: "not-a-route" })).toThrow();
      expect(() => buildAiPlanRequest({ ...input(f.foundations), requestId: "invented:phase" })).toThrow();
      expect(() => buildAiPlanRequest({ ...input(f.foundations), narrativeRef: "ai-request:unsupported-ref" })).toThrow();
      expect(() => buildAiPlanRequest({ ...input(f.foundations), confirmation: { ...confirmation("adopt-one"), identityRef: "model:operator" } as never })).toThrow();
    } finally { await f.adapter.close(); }
  });

  it("preserves an unchanged proposal without inventing operator-edited fields", async () => {
    const f = await fixture();
    try {
      const request = buildAiPlanRequest({ ...input(f.foundations), edited: original });
      expect(request.steps[0].event.review.authenticatedOperatorEvidence).toEqual([]);
      expect((await commit(f.adapter, request)).kind).toBe("committed");
    } finally { await f.adapter.close(); }
  });

  it("uses current plan versions for redrafts and refuses a concurrent stale adoption", async () => {
    const f = await fixture();
    try {
      const one = buildAiPlanRequest(input(f.foundations)), stale = buildAiPlanRequest(input(f.foundations, "adopt-concurrent"));
      expect((await commit(f.adapter, one)).kind).toBe("committed");
      expect((await commit(f.adapter, stale)).kind).toBe("conflict");
      const current = await f.read(), two = buildAiPlanRequest(input(current, "adopt-two"));
      expect(two.steps[0].event.operation).toEqual({ kind: "draft", mode: "redraft" });
      expect(two.steps[0].event.predecessor?.planId).toBe(one.steps[0].plan?.planId);
      expect(two.steps[0].plan?.planId).not.toBe(one.steps[0].plan?.planId);
      expect((await commit(f.adapter, two)).kind).toBe("committed");
    } finally { await f.adapter.close(); }
  });

  it("rebases a draft to a newly accepted brief while retaining the predecessor and explicit adoption proof", async () => {
    const f = await fixture();
    try {
      const one = buildAiPlanRequest(input(f.foundations));
      expect((await commit(f.adapter, one)).kind).toBe("committed");
      const current = await f.read(); await acceptBrief(f.adapter, current);
      const next = await f.read(), two = buildAiPlanRequest(input(next, "adopt-new-brief"));
      expect(two.steps[0].event.rebase).toMatchObject({ kind: "plan.rebased", replaces: one.steps[0].plan?.planId, briefId: next.accepted?.brief.briefId, previousDisposition: { kind: "draft-replaced", from: "drafting" } });
      expect(two.steps[0].plan?.revision).toBe(1);
      expect((await commit(f.adapter, two)).kind).toBe("committed");
    } finally { await f.adapter.close(); }
  });

  it("records a truthful model revision after proposal and refuses replacement during scope approval", async () => {
    const f = await fixture();
    try {
      const one = buildAiPlanRequest(input(f.foundations)); expect((await commit(f.adapter, one)).kind).toBe("committed");
      const current = await f.read(), promoted = promoteDraft(current.head!.plan, later, false)[0]!;
      const event = { schemaVersion: 1, kind: "plan.proposed", operation: { kind: "promote" }, plan: promoted, controls: current.controls, review: current.head!.headEvent.payload.review, decisions: [], predecessor: null, rebase: null, seal: null, budgetExtension: null } as unknown as Omit<PlanHeadEventPayload, "binding">;
      expect((await commit(f.adapter, bindPlanningSteps(current, "promote-one", [{ expectedState: "drafting", event }], later))).kind).toBe("committed");
      const proposed = await f.read(), two = buildAiPlanRequest(input(proposed, "adopt-revision"));
      expect(two.steps[0].event.operation).toEqual({ kind: "revise", mode: "R1" });
      expect(two.steps[0].event.decisions[0]?.statement).toContain("model proposal");
      expect(two.steps[0].event.decisions[0]?.statement).not.toContain("manual");
      expect(two.steps[0].plan?.revision).toBe(2);
      expect((await commit(f.adapter, two)).kind).toBe("committed");
      expect(() => buildAiPlanRequest(input({ ...proposed, head: { ...proposed.head!, plan: { ...proposed.head!.plan, state: "awaiting_scope_approval" } } }, "adopt-blocked"))).toThrow();
    } finally { await f.adapter.close(); }
  });
});
