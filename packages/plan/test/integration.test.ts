import { describe, expect, it } from "vitest";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import { createSqlitePersistenceAdapter } from "@ai-dev-os/persistence-sqlite";
import type { OperationRecord, PersistenceAdapter, TransactionContext } from "@ai-dev-os/persistence";
import { parseDecision, parseProject, parseProjectPlan, parseProjectStop, serializeCanonicalProjectJson, type Decision, type ProjectBrief, type ProjectPlan } from "@ai-dev-os/project";
import {
  ProductPlan,
  createProductPlanningConfiguration,
  planningDigest,
  type PlanningContributionDraft,
  type ProductPlanSnapshot,
} from "@ai-dev-os/product-planning";
import {
  assemblePlan,
  abandonDraft,
  canonicalPlanDigestMaterial,
  computePlanCommitContentDigest,
  computeCoverageDigest,
  computeProposalDigest,
  computeSpecificationDigest,
  evaluateSealConditions,
  observePlanCommit,
  parsePlanAssemblyRequest,
  parsePlanCommitRequest,
  projectStopSnapshotDigestMaterial,
  promoteDraft,
  rejectPlanScope,
  sealProposedPlan,
  supersedeForRevision,
} from "../src/index.js";
import {
  createC8C7PlanStore,
  issueSyntheticPlanCommitAuthorization,
  planSha256,
} from "../src/testing/index.js";
import {
  T0,
  T1,
  T2,
  acceptNextBrief,
  acceptedBinding,
  assemblyRequestForBrief,
  boundCommitRequest,
  draftRequest,
  resolvedCeiling,
  seedFoundations,
  type SeededFoundations,
  type UnboundPlanStep,
} from "./fixtures.js";

type Store = ReturnType<typeof createC8C7PlanStore>;

function ownerProducedSpecification(projectId: string): ProductPlanSnapshot {
  let milliseconds = Date.parse(T0);
  const clock = Object.freeze({ now: () => new Date(milliseconds) });
  const configuration = createProductPlanningConfiguration({
    instanceId: "planning:g14",
    discoveryRouteKey: "route:g14-discovery",
    engineeringRouteKey: "route:g14-engineering",
    synthesisRouteKey: "route:g14-synthesis",
    routes: [
      { routeKey: "route:g14-discovery", providerId: "provider:g14", modelId: "model:g14-discovery", profileId: "profile:g14-discovery", ownership: "owned", configurationFingerprint: "1".repeat(64) },
      { routeKey: "route:g14-engineering", providerId: "provider:g14", modelId: "model:g14-engineering", profileId: "profile:g14-engineering", ownership: "owned", configurationFingerprint: "2".repeat(64) },
      { routeKey: "route:g14-synthesis", providerId: "provider:g14", modelId: "model:g14-synthesis", profileId: "profile:g14-synthesis", ownership: "owned", configurationFingerprint: "3".repeat(64) },
    ],
    specialists: [],
  });
  const plan = ProductPlan.create({
    planId: "product-plan:g14",
    projectId,
    title: "Owner-produced C9 scope",
    problem: "A product owner needs traceable plan requirements.",
    desiredOutcomes: ["Every approved requirement retains provenance."],
    constraints: ["Production remains disabled."],
    nonGoals: ["No task execution."],
    risk: "material",
    workspace: {
      projectId,
      workspaceId: "workspace:g14",
      snapshotId: "snapshot:g14",
      baseRevision: "0123456789abcdef0123456789abcdef01234567",
    },
    budget: { maximumInputTokens: 10_000, maximumOutputTokens: 5_000, maximumCostMicros: 100_000, maximumProviderCalls: 3 },
    createdAt: T0,
    deadline: "2026-09-04T12:00:00.000Z",
  }, configuration, { clock });
  const usage = Object.freeze({
    inputTokens: 100,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 50,
    reasoningTokens: 0,
    toolCalls: 0,
    costMicros: 100,
  });
  const apply = (kind: "product-discovery" | "engineering-feasibility" | "plan-synthesis", draft: PlanningContributionDraft) => {
    const phase = plan.toSnapshot().phases.find((candidate) => candidate.kind === kind)!;
    const staged = plan.stageContribution({
      phaseId: phase.phaseId,
      resultId: `result:g14:${kind}`,
      attempt: 1,
      inputDigest: phase.inputDigest,
      schedulerTaskId: phase.taskId,
      schedulerIdempotencyKey: phase.idempotencyKey,
      route: phase.route,
      sourceFingerprint: planningDigest({ phaseId: phase.phaseId, kind }),
      completedAt: new Date(milliseconds).toISOString(),
      usage,
    }, draft);
    plan.applyStagedContribution(staged.contributionId, plan.version);
    milliseconds += 1_000;
  };
  const empty = { findings: [], unresolvedQuestions: [], dissent: [] } as const;
  apply("product-discovery", {
    ...empty,
    candidates: [{
      localKey: "core",
      title: "Implement the owner-approved plan",
      description: "The core capability is represented in the C9 plan.",
      rationale: "The accepted product outcome requires an implementation task.",
      category: "capability",
      proposedDisposition: "required",
      dependsOn: [],
    }],
  });
  apply("engineering-feasibility", {
    ...empty,
    candidates: [{
      localKey: "quality",
      title: "Verify the owner-approved plan",
      description: "The plan has an independently reviewable quality task.",
      rationale: "The accepted product outcome requires deterministic verification.",
      category: "quality",
      proposedDisposition: "expected-quality",
      dependsOn: ["Implement the owner-approved plan"],
    }],
  });
  apply("plan-synthesis", { ...empty, candidates: [] });
  for (const requirement of plan.toSnapshot().requirements) {
    plan.decideScope({
      requirementId: requirement.requirementId,
      requirementDigest: requirement.requirementDigest,
      expectedPlanVersion: plan.version,
      disposition: requirement.proposedDispositions.includes("expected-quality") ? "expected-quality" : "required",
      actor: { actorId: "actor:g14-owner", authority: "product-owner" },
      reason: "The product owner retained this exact requirement and its source provenance.",
      approvalReference: `approval:${requirement.requirementId.slice(-16)}`,
      decidedAt: new Date(milliseconds).toISOString(),
    });
    milliseconds += 1_000;
  }
  plan.approveSpecification({
    expectedPlanVersion: plan.version,
    decisionSetDigest: plan.currentDecisionSetDigest(),
    actor: { actorId: "actor:g14-owner", authority: "product-owner" },
    approvalReference: "approval:g14-specification",
    approvedAt: new Date(milliseconds).toISOString(),
  });
  return plan.toSnapshot();
}

function assemblyRequestFromOwner(snapshot: ProductPlanSnapshot, acceptedBrief: ProjectBrief) {
  if (snapshot.specification === null) throw new Error("G-14 producer did not emit an approved specification.");
  const raw = structuredClone(assemblyRequestForBrief(acceptedBrief)) as unknown as Record<string, unknown>;
  const proposal = raw["proposal"] as Record<string, unknown>;
  const stages = proposal["stages"] as Record<string, unknown>[];
  const template = (proposal["tasks"] as Record<string, unknown>[])[0]!;
  const specification = snapshot.specification;
  const executable = snapshot.coverage.filter((row) => row.executable && row.taskId !== null);
  const requirementById = new Map(specification.requirements.map((requirement) => [requirement.requirementId, requirement]));
  const tasks = executable.map((coverage, index) => {
    const requirement = requirementById.get(coverage.requirementId)!;
    const taskId = `tsk:g14-${index + 1}`;
    return {
      ...structuredClone(template),
      taskId,
      title: requirement.title,
      requirementIds: [requirement.requirementId],
      provenance: {
        title: {
          origin: "specification",
          derivedFrom: {
            kind: "requirement",
            specificationId: specification.specificationId,
            requirementId: requirement.requirementId,
          },
          verbatim: true,
        },
        objective: {
          origin: "brief",
          derivedFrom: { kind: "brief-outcome", briefId: acceptedBrief.briefId, index: 0 },
          verbatim: true,
        },
        "acceptance[0].criterion": {
          origin: "brief",
          derivedFrom: { kind: "brief-non-goal", briefId: acceptedBrief.briefId, index: 0 },
          verbatim: true,
        },
      },
    };
  });
  proposal["tasks"] = tasks;
  stages[0]!["taskIds"] = tasks.map((task) => task.taskId);
  proposal["dependencies"] = [];
  raw["taskBudgetAllocations"] = tasks.map((task) => ({
    taskId: task.taskId,
    budget: { maximumInputTokens: 20, maximumOutputTokens: 10, maximumCostMicros: 200, maximumToolCalls: 0, maximumTurns: 0 },
  }));
  raw["specificationInput"] = {
    schemaVersion: 1,
    specification,
    coverage: snapshot.coverage,
    taskIdMap: executable.map((coverage, index) => ({ upstreamTaskId: coverage.taskId, planTaskId: `tsk:g14-${index + 1}` })),
    waiverBindings: [],
  };
  raw["expectedSpecificationDigest"] = "0".repeat(64);
  raw["expectedCoverageDigest"] = "0".repeat(64);
  raw["expectedProposalDigest"] = "0".repeat(64);
  raw["expectedSpecificationDigest"] = computeSpecificationDigest(raw, planSha256);
  raw["expectedCoverageDigest"] = computeCoverageDigest(raw, planSha256);
  raw["expectedProposalDigest"] = computeProposalDigest(raw, planSha256);
  return parsePlanAssemblyRequest(raw);
}

function decision(plan: ProjectPlan, kind: Decision["kind"], taskId: string | null = null): Decision {
  const material = {
    schemaVersion: 1,
    revision: 1,
    projectId: plan.projectId,
    scope: { planId: plan.planId, planRevision: plan.revision, stageId: null, taskId },
    kind,
    decidedBy: "operator",
    statement: `Authorize ${kind} for the exact plan.`,
    rationale: null,
    supersedes: null,
    subjectDigest: plan.planDigest,
    decidedAt: T1,
  };
  return parseDecision({ ...material, decisionId: `dec:${planSha256.sha256(serializeCanonicalProjectJson(material)).slice(0, 32)}` });
}

function requestWithBudget(
  acceptedBrief: ProjectBrief,
  maximumInputTokens: number,
  maximumOutputTokens: number,
): ReturnType<typeof assemblyRequestForBrief> {
  const raw = structuredClone(assemblyRequestForBrief(acceptedBrief)) as unknown as Record<string, unknown>;
  const proposal = raw["proposal"] as Record<string, unknown>;
  const ceiling = proposal["budgetCeiling"] as Record<string, unknown>;
  ceiling["maximumInputTokens"] = maximumInputTokens;
  ceiling["maximumOutputTokens"] = maximumOutputTokens;
  const allocation = ((raw["taskBudgetAllocations"] as Record<string, unknown>[])[0]!["budget"] as Record<string, unknown>);
  allocation["maximumInputTokens"] = maximumInputTokens;
  allocation["maximumOutputTokens"] = maximumOutputTokens;
  raw["expectedSpecificationDigest"] = "0".repeat(64);
  raw["expectedCoverageDigest"] = "0".repeat(64);
  raw["expectedProposalDigest"] = "0".repeat(64);
  raw["expectedSpecificationDigest"] = computeSpecificationDigest(raw, planSha256);
  raw["expectedCoverageDigest"] = computeCoverageDigest(raw, planSha256);
  raw["expectedProposalDigest"] = computeProposalDigest(raw, planSha256);
  return parsePlanAssemblyRequest(raw);
}

async function reclassifyProject(adapter: PersistenceAdapter, seed: SeededFoundations, marker: string) {
  const project = parseProject({
    ...seed.project,
    revision: seed.project.revision + 1,
    displayName: `Reclassified ${marker}`,
    dataClassification: "proprietary-source",
    updatedAt: T1,
  });
  const envelope = await adapter.transact((tx) => tx.aggregates.update({
    aggregateType: "project",
    aggregateId: project.projectId,
    schemaVersion: 1,
    payload: project,
    expectedVersion: seed.projectEnvelope.aggregateVersion,
  }));
  return Object.freeze({
    project,
    controls: Object.freeze({
      ...seed.controls,
      projectAggregateVersion: envelope.aggregateVersion,
      projectContentDigest: envelope.checksum.hex,
    }),
  });
}

async function mustHead(store: Store, projectId: string) {
  const read = await store.readHead(projectId);
  expect(read.kind).toBe("head");
  if (read.kind !== "head") throw new Error("Expected a proven plan head.");
  return read.head;
}

function event(
  head: Awaited<ReturnType<typeof mustHead>>,
  plan: ProjectPlan,
  kind: string,
  operation: Readonly<Record<string, string>>,
  additions: Readonly<Record<string, unknown>> = {},
): UnboundPlanStep["event"] {
  return {
    schemaVersion: 1,
    kind,
    operation,
    plan,
    controls: head.headEvent.payload.controls,
    review: head.headEvent.payload.review,
    decisions: [],
    rebase: null,
    predecessor: null,
    seal: null,
    budgetExtension: null,
    ...additions,
  } as unknown as UnboundPlanStep["event"];
}

async function bootstrap(adapter: PersistenceAdapter): Promise<Readonly<{ adapter: PersistenceAdapter; store: Store; seed: SeededFoundations; head: Awaited<ReturnType<typeof mustHead>> }>> {
  const seed = await seedFoundations(adapter);
  const assemblyRequest = assemblyRequestForBrief(seed.accepted.brief);
  const result = assemblePlan(assemblyRequest, seed.project, seed.accepted, {
    planId: assemblyRequest.newPlanId,
    revision: 1,
    supersedes: null,
    state: "drafting",
    createdAt: T0,
    updatedAt: T0,
    sealedAt: null,
  }, planSha256);
  const request = draftRequest(result.plan, result.review, acceptedBinding(seed.accepted), seed.controls);
  const store = createC8C7PlanStore(adapter);
  expect(await store.commit(request, issueSyntheticPlanCommitAuthorization(request))).toMatchObject({ kind: "committed", aggregateVersion: 1 });
  return Object.freeze({ adapter, store, seed, head: await mustHead(store, seed.project.projectId) });
}

async function commitPromote(store: Store, seed: SeededFoundations, draft: Awaited<ReturnType<typeof mustHead>>, id: string) {
  const proposed = promoteDraft(draft.plan, T1, false)[0]!;
  const request = boundCommitRequest(seed.project.projectId, acceptedBinding(seed.accepted), seed.controls, draft, [{
    eventId: `plan-event:${id}:promote`, expectedState: "drafting", plan: proposed,
    envelope: { occurredAt: T1, traceId: null, causationId: null },
    event: event(draft, proposed, "plan.proposed", { kind: "promote" }),
  }]);
  expect(await store.commit(request, issueSyntheticPlanCommitAuthorization(request))).toMatchObject({ kind: "committed" });
  return mustHead(store, seed.project.projectId);
}

function predecessor(plan: ProjectPlan, state: "drafting" | "superseded", updatedAt: string) {
  const value = state === "drafting" ? plan : parseProjectPlan({ ...plan, state, updatedAt });
  return {
    planId: value.planId,
    revision: value.revision,
    supersedes: value.supersedes,
    state,
    planDigest: value.planDigest,
    sealedAt: value.sealedAt,
    sealedByApprovalId: null,
  } as const;
}

async function exerciseFirstDraft(adapter: PersistenceAdapter): Promise<void> {
  const seed = await seedFoundations(adapter);
  const assemblyRequest = assemblyRequestForBrief(seed.accepted.brief);
  const result = assemblePlan(assemblyRequest, seed.project, seed.accepted, {
    planId: assemblyRequest.newPlanId,
    revision: 1,
    supersedes: null,
    state: "drafting",
    createdAt: T0,
    updatedAt: T0,
    sealedAt: null,
  }, planSha256);
  const request = draftRequest(result.plan, result.review, acceptedBinding(seed.accepted), seed.controls);
  const authorization = issueSyntheticPlanCommitAuthorization(request, [], []);
  const store = createC8C7PlanStore(adapter);

  expect(await observePlanCommit(store, request, planSha256)).toEqual({ kind: "not-recorded", aggregateVersion: 0 });
  expect(await store.commit(request, authorization)).toEqual({ kind: "committed", aggregateVersion: 1, evidence: "receipt" });
  expect(await observePlanCommit(store, request, planSha256)).toEqual({ kind: "committed", aggregateVersion: 1, evidence: "head-observation" });
  const head = await store.readHead(seed.project.projectId);
  expect(head.kind).toBe("head");
  if (head.kind === "head") {
    expect(head.head.plan).toEqual(result.plan);
    expect(head.head.headEvent.payload.review.assemblyRequest).toEqual(assemblyRequest);
    expect(head.head.headEvent.payload.binding.contentDigest).toBe(request.binding.contentDigest);
  }
  expect(await store.commit(request, authorization)).toMatchObject({ kind: "refused", code: "PLAN_AUTHORITY_VIOLATION" });
  expect(await store.commit(request, {} as never)).toMatchObject({ kind: "refused", code: "PLAN_AUTHORITY_VIOLATION" });

  const forged = structuredClone(request) as unknown as Record<string, unknown>;
  forged["transport"] = {};
  expect(() => parsePlanCommitRequest(forged, planSha256)).toThrow();
}

describe("P-1..P-35 persistence composition", () => {
  it("commits, reopens, and refuses replay/raw capabilities over memory", async () => {
    await exerciseFirstDraft(createMemoryPersistenceAdapter());
  });

  it("runs the same first-write proof over the real SQLite adapter", async () => {
    await exerciseFirstDraft(createSqlitePersistenceAdapter({ memory: true }));
  });

  it("plants the historical sealed-first-write bypass witness over both adapters", async () => {
    for (const [name, factory] of [
      ["memory", () => createMemoryPersistenceAdapter()],
      ["sqlite", () => createSqlitePersistenceAdapter({ memory: true })],
    ] as const) {
      const adapter = factory();
      const seed = await seedFoundations(adapter);
      const assemblyRequest = assemblyRequestForBrief(seed.accepted.brief, { newPlanId: `pln:${name}-sealed-first` });
      const assembled = assemblePlan(assemblyRequest, seed.project, seed.accepted, {
        planId: assemblyRequest.newPlanId, revision: 1, supersedes: null, state: "drafting", createdAt: T0, updatedAt: T0, sealedAt: null,
      }, planSha256);
      const sealed = parseProjectPlan({ ...assembled.plan, state: "sealed", sealedAt: T0, sealedByApprovalId: null });
      const scopeDecision = decision(sealed, "scope-accepted");
      const ceiling = resolvedCeiling(seed);
      const verdicts = evaluateSealConditions({
        plan: sealed,
        review: assembled.review,
        acceptedBrief: seed.accepted,
        project: seed.project,
        controls: seed.controls,
        resolvedProjectCeiling: ceiling,
        authenticatedDecisions: [scopeDecision],
        scopeApproval: null,
      });
      const request = boundCommitRequest(seed.project.projectId, acceptedBinding(seed.accepted), seed.controls, null, [{
        eventId: `plan-event:${name}:sealed-first`,
        expectedState: null,
        plan: sealed,
        envelope: { occurredAt: T0, traceId: null, causationId: null },
        event: {
          schemaVersion: 1,
          kind: "plan.sealed",
          operation: { kind: "seal" },
          plan: sealed,
          controls: seed.controls,
          review: assembled.review,
          decisions: [scopeDecision],
          rebase: null,
          predecessor: null,
          seal: { verdicts, blockingQuestionIds: [], resolvedProjectCeiling: ceiling, sealedAt: T0, sealedByApprovalId: null },
          budgetExtension: null,
        },
      }]);
      const store = createC8C7PlanStore(adapter);
      expect(await store.commit(request, issueSyntheticPlanCommitAuthorization(request, [], [scopeDecision])))
        .toMatchObject({ kind: "refused", code: "PLAN_PRECONDITION_REFUSED", ruleId: "plan.head.absent" });
      expect(await store.readHead(seed.project.projectId)).toEqual({ kind: "absent" });
    }
  });

  it("classifies bounded head reconciliation without turning incomplete evidence into success", async () => {
    const { store, seed, head: draft } = await bootstrap(createMemoryPersistenceAdapter());
    const proposed = promoteDraft(draft.plan, T1, false)[0]!;
    const request = boundCommitRequest(seed.project.projectId, acceptedBinding(seed.accepted), seed.controls, draft, [{
      eventId: "plan-event:observation:promote",
      expectedState: "drafting",
      plan: proposed,
      envelope: { occurredAt: T1, traceId: null, causationId: draft.headEvent.eventId },
      event: event(draft, proposed, "plan.proposed", { kind: "promote" }),
    }]);
    const withHead = (readHead: Store["readHead"]): Store => Object.freeze({
      readHead,
      readAcceptedBriefHead: store.readAcceptedBriefHead,
      commit: store.commit,
      readJournal: store.readJournal,
    });
    expect(await observePlanCommit(withHead(async () => ({ kind: "head", head: draft })), request, planSha256))
      .toEqual({ kind: "not-recorded", aggregateVersion: 1 });
    expect(await observePlanCommit(withHead(async () => ({ kind: "head", head: { ...draft, aggregateVersion: 99 } })), request, planSha256))
      .toEqual({ kind: "conflict", actualVersion: 99 });
    expect(await observePlanCommit(withHead(async () => ({ kind: "absent" })), request, planSha256)).toEqual({ kind: "unknown" });
    expect(await observePlanCommit(withHead(async () => ({ kind: "corrupt", ruleId: "plan.store.corrupt" })), request, planSha256)).toEqual({ kind: "unknown" });
    expect(await observePlanCommit(store, { ...request, schemaVersion: 2 } as never, planSha256)).toEqual({ kind: "unknown" });
  });

  it("G-14 carries real owner-produced provenance to condition 6 and the durable seal writes nothing", async () => {
    const adapter = createMemoryPersistenceAdapter();
    const seed = await seedFoundations(adapter);
    const ownerSnapshot = ownerProducedSpecification(seed.project.projectId);
    expect(ownerSnapshot.specification).not.toBeNull();
    expect(ownerSnapshot.specification!.requirements.every((requirement) => requirement.candidateIds.length > 0 && requirement.provenance.length > 0)).toBe(true);
    expect(ownerSnapshot.specification!.requirements.map((requirement) => requirement.disposition).sort()).toEqual(["expected-quality", "required"]);

    const assemblyRequest = assemblyRequestFromOwner(ownerSnapshot, seed.accepted.brief);
    const result = assemblePlan(assemblyRequest, seed.project, seed.accepted, {
      planId: assemblyRequest.newPlanId,
      revision: 1,
      supersedes: null,
      state: "drafting",
      createdAt: T0,
      updatedAt: T0,
      sealedAt: null,
    }, planSha256);
    expect(result.review.specification?.requirements.every((requirement) => requirement.sourceProvenance.length > 0)).toBe(true);

    const store = createC8C7PlanStore(adapter);
    const first = draftRequest(result.plan, result.review, acceptedBinding(seed.accepted), seed.controls);
    expect(await store.commit(first, issueSyntheticPlanCommitAuthorization(first))).toMatchObject({ kind: "committed", aggregateVersion: 1 });
    const draft = await mustHead(store, seed.project.projectId);
    const proposed = promoteDraft(draft.plan, T1, false)[0]!;
    const promote = boundCommitRequest(seed.project.projectId, acceptedBinding(seed.accepted), seed.controls, draft, [{
      eventId: "plan-event:g14:promote",
      expectedState: "drafting",
      plan: proposed,
      envelope: { occurredAt: T1, traceId: null, causationId: draft.headEvent.eventId },
      event: event(draft, proposed, "plan.proposed", { kind: "promote" }),
    }]);
    expect(await store.commit(promote, issueSyntheticPlanCommitAuthorization(promote))).toMatchObject({ kind: "committed", aggregateVersion: 2 });

    const proposedHead = await mustHead(store, seed.project.projectId);
    const sealed = sealProposedPlan(proposedHead.plan, T2);
    const scopeDecision = decision(sealed, "scope-accepted");
    const ceiling = resolvedCeiling(seed);
    const verdicts = evaluateSealConditions({
      plan: sealed,
      review: proposedHead.headEvent.payload.review,
      acceptedBrief: seed.accepted,
      project: seed.project,
      controls: seed.controls,
      resolvedProjectCeiling: ceiling,
      authenticatedDecisions: [scopeDecision],
      scopeApproval: null,
    });
    expect(verdicts.map((verdict) => verdict.passed)).toEqual([true, true, true, true, true, false]);
    expect(verdicts[5]!.ruleIds).toEqual(["plan.seal.condition-6"]);
    const seal = boundCommitRequest(seed.project.projectId, acceptedBinding(seed.accepted), seed.controls, proposedHead, [{
      eventId: "plan-event:g14:seal-refused",
      expectedState: "proposed",
      plan: sealed,
      envelope: { occurredAt: T2, traceId: null, causationId: proposedHead.headEvent.eventId },
      event: event(proposedHead, sealed, "plan.sealed", { kind: "seal" }, {
        decisions: [scopeDecision],
        seal: { verdicts, blockingQuestionIds: [], resolvedProjectCeiling: ceiling, sealedAt: T2, sealedByApprovalId: null },
      }),
    }]);
    const before = await store.readJournal(seed.project.projectId, { limit: 128, cursor: null });
    expect(await store.commit(seal, issueSyntheticPlanCommitAuthorization(seal, [], [scopeDecision])))
      .toMatchObject({ kind: "refused", code: "PLAN_SEAL_CONDITION_FAILED", ruleId: "plan.seal.condition-6" });
    const after = await store.readJournal(seed.project.projectId, { limit: 128, cursor: null });
    expect(after).toEqual(before);
    expect((await mustHead(store, seed.project.projectId)).plan.state).toBe("proposed");
  });

  it("refuses forged capabilities before any I/O and caller-forged plan bytes before any write", async () => {
    const operations: OperationRecord[] = [];
    const { store, seed, head } = await bootstrap(createMemoryPersistenceAdapter({ observer: (record) => operations.push(record) }));
    const proposed = promoteDraft(head.plan, T1, false)[0]!;
    const valid = boundCommitRequest(seed.project.projectId, acceptedBinding(seed.accepted), seed.controls, head, [{
      eventId: "plan-event:oracle:promote", expectedState: "drafting", plan: proposed,
      envelope: { occurredAt: T1, traceId: null, causationId: head.headEvent.eventId },
      event: event(head, proposed, "plan.proposed", { kind: "promote" }),
    }]);
    const beforeRaw = operations.length;
    expect(await store.commit(valid, {} as never)).toMatchObject({ kind: "refused", code: "PLAN_AUTHORITY_VIOLATION" });
    expect(operations).toHaveLength(beforeRaw);

    const forgedPlan = structuredClone(proposed) as unknown as Record<string, unknown>;
    forgedPlan["createdAt"] = "2026-09-04T09:59:00.000Z";
    const forged = boundCommitRequest(seed.project.projectId, acceptedBinding(seed.accepted), seed.controls, head, [{
      eventId: "plan-event:oracle:forged", expectedState: "drafting", plan: forgedPlan as unknown as ProjectPlan,
      envelope: { occurredAt: T1, traceId: null, causationId: head.headEvent.eventId },
      event: event(head, forgedPlan as unknown as ProjectPlan, "plan.proposed", { kind: "promote" }),
    }]);
    const writesBefore = operations.filter((record) => ["aggregates.create", "aggregates.update", "events.append"].includes(record.operation)).length;
    expect(await store.commit(forged, issueSyntheticPlanCommitAuthorization(forged))).toMatchObject({ kind: "refused", ruleId: "plan.revision.stale" });
    const writesAfter = operations.filter((record) => ["aggregates.create", "aggregates.update", "events.append"].includes(record.operation)).length;
    expect(writesAfter).toBe(writesBefore);
    expect((await mustHead(store, seed.project.projectId)).aggregateVersion).toBe(1);
  });

  it("M-23/P-35 refuses every recomputed 21-field plan substitution at the raw store boundary", async () => {
    const mutations: Readonly<Record<string, (plan: Record<string, unknown>) => void>> = Object.freeze({
      schemaVersion: (plan) => { plan["schemaVersion"] = 2; },
      planId: (plan) => { plan["planId"] = "pln:substituted"; },
      projectId: (plan) => { plan["projectId"] = "prj:substituted"; },
      briefId: (plan) => { plan["briefId"] = "brf:substituted"; },
      briefRevision: (plan) => { plan["briefRevision"] = 2; },
      revision: (plan) => { plan["revision"] = 2; },
      supersedes: (plan) => { plan["supersedes"] = "pln:substituted-prior"; },
      state: (plan) => { plan["state"] = "awaiting_scope_approval"; },
      stages: (plan) => {
        const stages = structuredClone(plan["stages"] as Record<string, unknown>[]);
        stages[0]!["title"] = "Substituted stage title.";
        plan["stages"] = stages;
      },
      tasks: (plan) => {
        const tasks = structuredClone(plan["tasks"] as Record<string, unknown>[]);
        tasks[0]!["objective"] = "Substituted task objective.";
        plan["tasks"] = tasks;
      },
      dependencies: (plan) => {
        const taskId = ((plan["tasks"] as Record<string, unknown>[])[0]!["taskId"] as string);
        plan["dependencies"] = [{ fromTaskId: taskId, toTaskId: "tsk:missing", kind: "finish-to-start", artifactKind: null }];
      },
      specificationRef: (plan) => { plan["specificationRef"] = `spec:${"f".repeat(32)}`; },
      coverageRef: (plan) => { plan["coverageRef"] = `coverage:${"f".repeat(32)}`; },
      planDigest: (plan) => { plan["planDigest"] = "f".repeat(64); },
      sealedAt: (plan) => { plan["sealedAt"] = T0; },
      sealedByApprovalId: (plan) => { plan["sealedByApprovalId"] = "approval:substituted"; },
      budgetCeiling: (plan) => {
        plan["budgetCeiling"] = { ...(plan["budgetCeiling"] as Record<string, unknown>), maximumTurns: 1 };
      },
      origin: (plan) => { plan["origin"] = "operator"; },
      authority: (plan) => { plan["authority"] = "operator"; },
      createdAt: (plan) => { plan["createdAt"] = "2026-09-04T09:59:00.000Z"; },
      updatedAt: (plan) => { plan["updatedAt"] = T2; },
    });
    for (const [adapterName, factory] of [
      ["memory", () => createMemoryPersistenceAdapter()],
      ["sqlite", () => createSqlitePersistenceAdapter({ memory: true })],
    ] as const) {
      const { store, seed, head } = await bootstrap(factory());
      const proposed = promoteDraft(head.plan, T1, false)[0]!;
      const valid = boundCommitRequest(seed.project.projectId, acceptedBinding(seed.accepted), seed.controls, head, [{
        eventId: `plan-event:${adapterName}:field-oracle`, expectedState: "drafting", plan: proposed,
        envelope: { occurredAt: T1, traceId: null, causationId: head.headEvent.eventId },
        event: event(head, proposed, "plan.proposed", { kind: "promote" }),
      }]);
      expect(Object.keys(mutations).sort()).toEqual(Object.keys(proposed).sort());
      const before = await store.readJournal(seed.project.projectId, { limit: 128, cursor: null });
      for (const [field, mutate] of Object.entries(mutations)) {
        const raw = structuredClone(valid) as unknown as Record<string, unknown>;
        const step = (raw["steps"] as Record<string, unknown>[])[0]!;
        const candidate = step["plan"] as Record<string, unknown>;
        mutate(candidate);
        if (field !== "planDigest") {
          candidate["planDigest"] = planSha256.sha256(canonicalPlanDigestMaterial(candidate as unknown as ProjectPlan));
        }
        const payload = step["event"] as Record<string, unknown>;
        payload["plan"] = structuredClone(candidate);
        const eventBinding = payload["binding"] as Record<string, unknown>;
        eventBinding["planId"] = candidate["planId"];
        eventBinding["planRevision"] = candidate["revision"];
        eventBinding["planDigest"] = candidate["planDigest"];
        eventBinding["resultState"] = candidate["state"];
        (raw["binding"] as Record<string, unknown>)["contentDigest"] = "0".repeat(64);
        eventBinding["contentDigest"] = "0".repeat(64);
        const contentDigest = computePlanCommitContentDigest(raw as unknown as Parameters<typeof computePlanCommitContentDigest>[0], planSha256);
        (raw["binding"] as Record<string, unknown>)["contentDigest"] = contentDigest;
        eventBinding["contentDigest"] = contentDigest;
        const request = raw as unknown as Parameters<typeof store.commit>[0];
        expect(await store.commit(request, issueSyntheticPlanCommitAuthorization(request)), field)
          .toMatchObject({ kind: "refused" });
      }
      expect(await store.readJournal(seed.project.projectId, { limit: 128, cursor: null })).toEqual(before);
      expect((await mustHead(store, seed.project.projectId)).aggregateVersion).toBe(1);
    }
  });

  it("fails closed for inactive projects, active stops, and caller-refreshed Project drift", async () => {
    for (const status of ["paused", "archived"] as const) {
      const adapter = createMemoryPersistenceAdapter();
      const seed = await seedFoundations(adapter);
      const requestValue = assemblyRequestForBrief(seed.accepted.brief);
      const result = assemblePlan(requestValue, seed.project, seed.accepted, { planId: requestValue.newPlanId, revision: 1, supersedes: null, state: "drafting", createdAt: T0, updatedAt: T0, sealedAt: null }, planSha256);
      const request = draftRequest(result.plan, result.review, acceptedBinding(seed.accepted), seed.controls);
      const inactive = parseProject({ ...seed.project, revision: 2, status, updatedAt: T1 });
      await adapter.transact((tx) => tx.aggregates.update({ aggregateType: "project", aggregateId: seed.project.projectId, schemaVersion: 1, payload: inactive, expectedVersion: 1 }));
      const store = createC8C7PlanStore(adapter);
      expect(await store.commit(request, issueSyntheticPlanCommitAuthorization(request))).toMatchObject({ kind: "refused", ruleId: "plan.project.not-active" });
      expect(await store.readHead(seed.project.projectId)).toEqual({ kind: "absent" });
    }

    {
      const adapter = createMemoryPersistenceAdapter();
      const seed = await seedFoundations(adapter);
      const requestValue = assemblyRequestForBrief(seed.accepted.brief);
      const result = assemblePlan(requestValue, seed.project, seed.accepted, { planId: requestValue.newPlanId, revision: 1, supersedes: null, state: "drafting", createdAt: T0, updatedAt: T0, sealedAt: null }, planSha256);
      const request = draftRequest(result.plan, result.review, acceptedBinding(seed.accepted), seed.controls);
      const stop = parseProjectStop({
        schemaVersion: 1, projectStopId: "pst:active", revision: 1, projectId: seed.project.projectId, engagedAt: T1,
        effects: { cancelledTaskIds: [], stoppingSessionIds: [], unconfirmedSessionIds: [], voidedApprovalIds: [], voidedHandoverIds: [], releasedReservationIds: [], retainedReservationIds: [] },
        resumedAt: null,
      });
      await adapter.transact((tx) => tx.aggregates.create({ aggregateType: "project-stop", aggregateId: stop.projectStopId, schemaVersion: 1, payload: stop }));
      const store = createC8C7PlanStore(adapter);
      expect(await store.commit(request, issueSyntheticPlanCommitAuthorization(request))).toMatchObject({ kind: "refused", ruleId: "plan.project.stopped" });
      expect(await store.readHead(seed.project.projectId)).toEqual({ kind: "absent" });
    }

    {
      const adapter = createMemoryPersistenceAdapter();
      const { store, seed, head } = await bootstrap(adapter);
      const changed = parseProject({ ...seed.project, revision: 2, displayName: "Changed after assembly", updatedAt: T1 });
      const envelope = await adapter.transact((tx) => tx.aggregates.update({ aggregateType: "project", aggregateId: seed.project.projectId, schemaVersion: 1, payload: changed, expectedVersion: 1 }));
      const refreshed = { ...seed.controls, projectAggregateVersion: envelope.aggregateVersion, projectContentDigest: envelope.checksum.hex };
      const proposed = promoteDraft(head.plan, T1, false)[0]!;
      const request = boundCommitRequest(seed.project.projectId, acceptedBinding(seed.accepted), refreshed, head, [{
        eventId: "plan-event:drift:promote", expectedState: "drafting", plan: proposed,
        envelope: { occurredAt: T1, traceId: null, causationId: head.headEvent.eventId },
        event: event(head, proposed, "plan.proposed", { kind: "promote" }, { controls: refreshed }),
      }]);
      expect(await store.commit(request, issueSyntheticPlanCommitAuthorization(request))).toMatchObject({ kind: "refused", ruleId: "plan.proposal.stale" });
      expect((await mustHead(store, seed.project.projectId)).aggregateVersion).toBe(1);
    }
  });

  it("filters foreign stops and digest-binds a same-project resumed stop", async () => {
    const adapter = createMemoryPersistenceAdapter();
    const seed = await seedFoundations(adapter);
    const effects = {
      cancelledTaskIds: [], stoppingSessionIds: [], unconfirmedSessionIds: [], voidedApprovalIds: [],
      voidedHandoverIds: [], releasedReservationIds: [], retainedReservationIds: [],
    };
    const foreignActive = parseProjectStop({
      schemaVersion: 1, projectStopId: "pst:foreign-active", revision: 1, projectId: "prj:foreign",
      engagedAt: T1, effects, resumedAt: null,
    });
    const resumed = parseProjectStop({
      schemaVersion: 1, projectStopId: "pst:local-resumed", revision: 1, projectId: seed.project.projectId,
      engagedAt: T1, effects, resumedAt: T2,
    });
    const envelopes = await adapter.transact(async (tx) => ({
      foreign: await tx.aggregates.create({ aggregateType: "project-stop", aggregateId: foreignActive.projectStopId, schemaVersion: 1, payload: foreignActive }),
      resumed: await tx.aggregates.create({ aggregateType: "project-stop", aggregateId: resumed.projectStopId, schemaVersion: 1, payload: resumed }),
    }));
    const digestEnvelope = (envelope: typeof envelopes.resumed) => Object.freeze({
      aggregateType: envelope.aggregateType,
      aggregateId: envelope.aggregateId,
      schemaVersion: envelope.schemaVersion,
      aggregateVersion: envelope.aggregateVersion,
      payload: envelope.payload,
      checksum: envelope.checksum,
      createdAt: envelope.createdAt,
      updatedAt: envelope.updatedAt,
      traceId: envelope.traceId,
    });
    const controls = Object.freeze({
      ...seed.controls,
      projectStopSnapshotDigest: projectStopSnapshotDigestMaterial(seed.project.projectId, [digestEnvelope(envelopes.resumed)], planSha256),
    });
    expect(controls.projectStopSnapshotDigest).not.toBe(projectStopSnapshotDigestMaterial(
      seed.project.projectId,
      [digestEnvelope(envelopes.foreign), digestEnvelope(envelopes.resumed)],
      planSha256,
    ));
    const assemblyRequest = assemblyRequestForBrief(seed.accepted.brief);
    const result = assemblePlan(assemblyRequest, seed.project, seed.accepted, {
      planId: assemblyRequest.newPlanId, revision: 1, supersedes: null, state: "drafting", createdAt: T0, updatedAt: T0, sealedAt: null,
    }, planSha256);
    const request = draftRequest(result.plan, result.review, acceptedBinding(seed.accepted), controls);
    const store = createC8C7PlanStore(adapter);
    expect(await store.commit(request, issueSyntheticPlanCommitAuthorization(request)))
      .toMatchObject({ kind: "committed", aggregateVersion: 1 });
  });

  it("rolls back aggregate creation when the paired event append faults and consumes the one-shot token", async () => {
    const base = createMemoryPersistenceAdapter();
    const seed = await seedFoundations(base);
    const requestValue = assemblyRequestForBrief(seed.accepted.brief);
    const result = assemblePlan(requestValue, seed.project, seed.accepted, { planId: requestValue.newPlanId, revision: 1, supersedes: null, state: "drafting", createdAt: T0, updatedAt: T0, sealedAt: null }, planSha256);
    const request = draftRequest(result.plan, result.review, acceptedBinding(seed.accepted), seed.controls);
    const faulty = {
      ...base,
      transact: <T>(work: (tx: TransactionContext) => Promise<T> | T): Promise<T> => base.transact((tx) => work({
        ...tx,
        events: { ...tx.events, append: async () => { throw new Error("synthetic append fault"); } },
      })),
    } satisfies PersistenceAdapter;
    const store = createC8C7PlanStore(faulty);
    const authorization = issueSyntheticPlanCommitAuthorization(request);
    expect(await store.commit(request, authorization)).toEqual({ kind: "unknown" });
    expect(await createC8C7PlanStore(base).readHead(seed.project.projectId)).toEqual({ kind: "absent" });
    expect(await store.commit(request, authorization)).toMatchObject({ kind: "refused", code: "PLAN_AUTHORITY_VIOLATION" });
  });

  it("P-2b atomically rolls back both steps when the second promote event append faults", async () => {
    for (const factory of [
      () => createMemoryPersistenceAdapter(),
      () => createSqlitePersistenceAdapter({ memory: true }),
    ]) {
      const base = factory();
      const { seed, head: draft } = await bootstrap(base);
      const [proposed, awaiting] = promoteDraft(draft.plan, T1, true);
      const request = boundCommitRequest(seed.project.projectId, acceptedBinding(seed.accepted), seed.controls, draft, [
        {
          eventId: "plan-event:atomic-two-step:proposed",
          expectedState: "drafting",
          plan: proposed!,
          envelope: { occurredAt: T1, traceId: null, causationId: draft.headEvent.eventId },
          event: event(draft, proposed!, "plan.proposed", { kind: "promote" }),
        },
        {
          eventId: "plan-event:atomic-two-step:approval-required",
          expectedState: "proposed",
          plan: awaiting!,
          envelope: { occurredAt: T1, traceId: null, causationId: "plan-event:atomic-two-step:proposed" },
          event: event(draft, awaiting!, "plan.scope-approval-required", { kind: "require-scope-approval" }),
        },
      ]);
      let appendCalls = 0;
      const faulty = {
        ...base,
        transact: <T>(work: (tx: TransactionContext) => Promise<T> | T): Promise<T> => base.transact((tx) => work({
          ...tx,
          events: {
            ...tx.events,
            append: async (input) => {
              appendCalls += 1;
              if (appendCalls === 2) throw new Error("synthetic second-step append fault");
              return tx.events.append(input);
            },
          },
        })),
      } satisfies PersistenceAdapter;
      const store = createC8C7PlanStore(faulty);
      const authorization = issueSyntheticPlanCommitAuthorization(request);

      expect(await store.commit(request, authorization)).toEqual({ kind: "unknown" });
      expect(appendCalls).toBe(2);
      const retained = await mustHead(createC8C7PlanStore(base), seed.project.projectId);
      expect(retained.aggregateVersion).toBe(1);
      expect(retained.plan.state).toBe("drafting");
      expect(await store.commit(request, authorization)).toMatchObject({ kind: "refused", code: "PLAN_AUTHORITY_VIOLATION" });
      expect(appendCalls).toBe(2);
    }
  });

  for (const [name, factory] of [
    ["memory", () => createMemoryPersistenceAdapter()],
    ["SQLite", () => createSqlitePersistenceAdapter({ memory: true })],
  ] as const) {
    it(`promotes, annotates, seals, and reconciles exact events over ${name}`, async () => {
      const { store, seed, head: draft } = await bootstrap(factory());
      const proposed = promoteDraft(draft.plan, T1, false)[0]!;
      const promoteRequest = boundCommitRequest(seed.project.projectId, acceptedBinding(seed.accepted), seed.controls, draft, [{
        eventId: `plan-event:${name}:promote`,
        expectedState: "drafting",
        plan: proposed,
        envelope: { occurredAt: T1, traceId: null, causationId: null },
        event: event(draft, proposed, "plan.proposed", { kind: "promote" }),
      }]);
      expect(await store.commit(promoteRequest, issueSyntheticPlanCommitAuthorization(promoteRequest))).toMatchObject({ kind: "committed", aggregateVersion: 2 });

      const promoted = await mustHead(store, seed.project.projectId);
      const task = promoted.plan.tasks[0]!;
      const budgetDecision = decision(promoted.plan, "budget-extension-accepted", task.taskId);
      const annotationRequest = boundCommitRequest(seed.project.projectId, acceptedBinding(seed.accepted), seed.controls, promoted, [{
        eventId: `plan-event:${name}:budget`,
        expectedState: "proposed",
        plan: null,
        envelope: { occurredAt: T1, traceId: null, causationId: `plan-event:${name}:promote` },
        event: event(promoted, promoted.plan, "plan.budget-extended", { kind: "record-budget-extension" }, {
          decisions: [budgetDecision],
          budgetExtension: { taskId: task.taskId, previousBudget: task.budget, requestedBudget: { ...task.budget, maximumInputTokens: task.budget.maximumInputTokens + 1 }, decisionId: budgetDecision.decisionId },
        }),
      }]);
      expect(await store.commit(annotationRequest, issueSyntheticPlanCommitAuthorization(annotationRequest, [], [budgetDecision]))).toMatchObject({ kind: "committed", aggregateVersion: 2 });
      const completeJournal = await store.readJournal(seed.project.projectId, { limit: 128, cursor: null });
      expect(completeJournal.kind).toBe("page");
      if (completeJournal.kind !== "page") throw new Error("Expected a complete journal page.");
      const targetIndex = completeJournal.page.events.findIndex((entry) => entry.eventId === annotationRequest.steps[0].eventId);
      expect(targetIndex).toBeGreaterThan(0);
      const pagedStore: Store = Object.freeze({
        readHead: store.readHead,
        readAcceptedBriefHead: store.readAcceptedBriefHead,
        commit: store.commit,
        readJournal: async (_projectId, window) => window.cursor === null
          ? Object.freeze({ kind: "page" as const, page: Object.freeze({ events: completeJournal.page.events.slice(0, targetIndex), nextCursor: "synthetic:second-page" }) })
          : window.cursor === "synthetic:second-page"
            ? Object.freeze({ kind: "page" as const, page: Object.freeze({ events: completeJournal.page.events.slice(targetIndex), nextCursor: null }) })
            : Object.freeze({ kind: "cursor-invalid" as const, ruleId: "plan.store.cursor-invalid" as const }),
      });
      expect(await observePlanCommit(pagedStore, annotationRequest, planSha256))
        .toEqual({ kind: "committed", aggregateVersion: 2, evidence: "journal-observation" });
      expect(await observePlanCommit(store, annotationRequest, planSha256)).toEqual({ kind: "committed", aggregateVersion: 2, evidence: "journal-observation" });

      const afterAnnotation = await mustHead(store, seed.project.projectId);
      expect(afterAnnotation.plan).toEqual(promoted.plan);
      const sealed = sealProposedPlan(afterAnnotation.plan, T2);
      const scopeDecision = decision(sealed, "scope-accepted");
      const ceiling = resolvedCeiling(seed);
      const verdicts = evaluateSealConditions({
        plan: sealed,
        review: afterAnnotation.headEvent.payload.review,
        acceptedBrief: seed.accepted,
        project: seed.project,
        controls: seed.controls,
        resolvedProjectCeiling: ceiling,
        authenticatedDecisions: [scopeDecision],
        scopeApproval: null,
      });
      const buildSealRequest = (
        suffix: string,
        sealEvidence: Readonly<Record<string, unknown>> = {
          verdicts,
          blockingQuestionIds: [],
          resolvedProjectCeiling: ceiling,
          sealedAt: T2,
          sealedByApprovalId: null,
        },
      ) => boundCommitRequest(seed.project.projectId, acceptedBinding(seed.accepted), seed.controls, afterAnnotation, [{
        eventId: `plan-event:${name}:seal${suffix}`,
        expectedState: "proposed",
        plan: sealed,
        envelope: { occurredAt: T2, traceId: null, causationId: `plan-event:${name}:promote` },
        event: event(afterAnnotation, sealed, "plan.sealed", { kind: "seal" }, {
          decisions: [scopeDecision],
          seal: sealEvidence,
        }),
      }]);
      for (const [suffix, changedTotal] of [["-null-total", null], ["-changed-total", 101]] as const) {
        const forged = buildSealRequest(suffix, {
          verdicts,
          blockingQuestionIds: [],
          resolvedProjectCeiling: { ...ceiling, accountMaximumTotalTokens: changedTotal },
          sealedAt: T2,
          sealedByApprovalId: null,
        });
        expect(await store.commit(forged, issueSyntheticPlanCommitAuthorization(forged, [], [scopeDecision])))
          .toMatchObject({ kind: "refused", code: "PLAN_AUTHORITY_VIOLATION", ruleId: "plan.seal.metadata" });
      }
      const forgedVerdicts = verdicts.map((verdict) => verdict.condition === 5
        ? { condition: 5 as const, passed: false, ruleIds: ["plan.seal.condition-5"] }
        : verdict);
      const forgedVerdictRequest = buildSealRequest("-forged-verdict", {
        verdicts: forgedVerdicts,
        blockingQuestionIds: [],
        resolvedProjectCeiling: ceiling,
        sealedAt: T2,
        sealedByApprovalId: null,
      });
      expect(await store.commit(forgedVerdictRequest, issueSyntheticPlanCommitAuthorization(forgedVerdictRequest, [], [scopeDecision])))
        .toMatchObject({ kind: "refused", code: "PLAN_AUTHORITY_VIOLATION", ruleId: "plan.seal.metadata" });
      const sealRequest = buildSealRequest("");
      expect(await store.commit(sealRequest, issueSyntheticPlanCommitAuthorization(sealRequest)))
        .toMatchObject({ kind: "refused", code: "PLAN_AUTHORITY_VIOLATION" });
      const syntheticApproval = structuredClone(sealRequest) as unknown as Record<string, unknown>;
      syntheticApproval["scopeApproval"] = { state: "consumed" };
      expect(await store.commit(syntheticApproval as never, issueSyntheticPlanCommitAuthorization(sealRequest, [], [scopeDecision])))
        .toMatchObject({ kind: "refused", code: "PLAN_VALIDATION_REFUSED" });
      expect((await mustHead(store, seed.project.projectId)).aggregateVersion).toBe(2);
      expect(await store.commit(sealRequest, issueSyntheticPlanCommitAuthorization(sealRequest, [], [scopeDecision]))).toMatchObject({ kind: "committed", aggregateVersion: 3 });
      expect(await observePlanCommit(store, sealRequest, planSha256)).toEqual({ kind: "committed", aggregateVersion: 3, evidence: "head-observation" });
      const final = await mustHead(store, seed.project.projectId);
      expect(final.plan.state).toBe("sealed");
      expect(final.plan.sealedByApprovalId).toBeNull();
      expect(final.plan.tasks.every((value) => value.state === "pending" && value.stateRevision === 1)).toBe(true);

      const sealedTask = final.plan.tasks[0]!;
      const lateDecision = decision(final.plan, "budget-extension-accepted", sealedTask.taskId);
      const lateAnnotation = boundCommitRequest(seed.project.projectId, acceptedBinding(seed.accepted), seed.controls, final, [{
        eventId: `plan-event:${name}:late-budget`,
        expectedState: "sealed",
        plan: null,
        envelope: { occurredAt: T2, traceId: null, causationId: final.headEvent.eventId },
        event: event(final, final.plan, "plan.budget-extended", { kind: "record-budget-extension" }, {
          decisions: [lateDecision],
          budgetExtension: {
            taskId: sealedTask.taskId,
            previousBudget: sealedTask.budget,
            requestedBudget: { ...sealedTask.budget, maximumInputTokens: sealedTask.budget.maximumInputTokens + 1 },
            decisionId: lateDecision.decisionId,
          },
        }),
      }]);
      expect(await store.commit(lateAnnotation, issueSyntheticPlanCommitAuthorization(lateAnnotation, [], [lateDecision])))
        .toEqual({ kind: "refused", code: "PLAN_PRECONDITION_REFUSED", ruleId: "plan.state.illegal" });
      expect(await observePlanCommit(store, lateAnnotation, planSha256))
        .toEqual({ kind: "not-recorded", aggregateVersion: 3 });
    });

    it(`refuses a 60/60 seal against an orthogonal total of 100 over ${name}`, async () => {
      const adapter = factory();
      const seed = await seedFoundations(adapter);
      const assemblyRequest = requestWithBudget(seed.accepted.brief, 60, 60);
      const result = assemblePlan(assemblyRequest, seed.project, seed.accepted, {
        planId: assemblyRequest.newPlanId,
        revision: 1,
        supersedes: null,
        state: "drafting",
        createdAt: T0,
        updatedAt: T0,
        sealedAt: null,
      }, planSha256);
      const store = createC8C7PlanStore(adapter);
      const first = draftRequest(result.plan, result.review, acceptedBinding(seed.accepted), seed.controls);
      expect(await store.commit(first, issueSyntheticPlanCommitAuthorization(first))).toMatchObject({ kind: "committed" });
      const proposedHead = await commitPromote(store, seed, await mustHead(store, seed.project.projectId), `${name}:total-overrun`);
      const sealed = sealProposedPlan(proposedHead.plan, T2);
      const scopeDecision = decision(sealed, "scope-accepted");
      const ceiling = resolvedCeiling(seed);
      const verdicts = evaluateSealConditions({
        plan: sealed,
        review: proposedHead.headEvent.payload.review,
        acceptedBrief: seed.accepted,
        project: seed.project,
        controls: seed.controls,
        resolvedProjectCeiling: ceiling,
        authenticatedDecisions: [scopeDecision],
        scopeApproval: null,
      });
      expect(verdicts[4]).toEqual({ condition: 5, passed: false, ruleIds: ["plan.seal.condition-5"] });
      const request = boundCommitRequest(seed.project.projectId, acceptedBinding(seed.accepted), seed.controls, proposedHead, [{
        eventId: `plan-event:${name}:total-overrun:seal`,
        expectedState: "proposed",
        plan: sealed,
        envelope: { occurredAt: T2, traceId: null, causationId: proposedHead.headEvent.eventId },
        event: event(proposedHead, sealed, "plan.sealed", { kind: "seal" }, {
          decisions: [scopeDecision],
          seal: { verdicts, blockingQuestionIds: [], resolvedProjectCeiling: ceiling, sealedAt: T2, sealedByApprovalId: null },
        }),
      }]);
      const before = await store.readJournal(seed.project.projectId, { limit: 128, cursor: null });
      expect(await store.commit(request, issueSyntheticPlanCommitAuthorization(request, [], [scopeDecision])))
        .toMatchObject({ kind: "refused", code: "PLAN_SEAL_CONDITION_FAILED", ruleId: "plan.seal.condition-5" });
      expect(await store.readJournal(seed.project.projectId, { limit: 128, cursor: null })).toEqual(before);
      expect((await mustHead(store, seed.project.projectId)).plan.state).toBe("proposed");
    });

    it(`reconstructs redraft, R1, and R2 assembly branches over ${name}`, async () => {
      {
        const { adapter, store, seed, head } = await bootstrap(factory());
        const current = await reclassifyProject(adapter, seed, `${name} redraft`);
        const request = assemblyRequestForBrief(seed.accepted.brief, { newPlanId: `pln:${name.toLowerCase()}-redraft` });
        const result = assemblePlan(request, current.project, seed.accepted, {
          planId: request.newPlanId, revision: 1, supersedes: null, state: "drafting", createdAt: T1, updatedAt: T1, sealedAt: null,
        }, planSha256);
        const mutation = boundCommitRequest(seed.project.projectId, acceptedBinding(seed.accepted), current.controls, head, [{
          eventId: `plan-event:${name}:redraft`, expectedState: "drafting", plan: result.plan,
          envelope: { occurredAt: T1, traceId: null, causationId: head.headEvent.eventId },
          event: event(head, result.plan, "plan.drafted", { kind: "draft", mode: "redraft" }, {
            controls: current.controls, review: result.review, predecessor: predecessor(head.plan, "drafting", T1), rebase: null,
          }),
        }]);
        expect(await store.commit(mutation, issueSyntheticPlanCommitAuthorization(mutation))).toMatchObject({ kind: "committed", aggregateVersion: 2 });
        const redrafted = (await mustHead(store, seed.project.projectId)).plan;
        expect(redrafted.planId).toBe(request.newPlanId);
        expect(redrafted.tasks.every((task) => task.requirements.dataClassification === "proprietary-source")).toBe(true);
      }

      {
        const { adapter, store, seed, head: draft } = await bootstrap(factory());
        const proposed = await commitPromote(store, seed, draft, `${name}:r1`);
        const current = await reclassifyProject(adapter, seed, `${name} R1`);
        const request = assemblyRequestForBrief(seed.accepted.brief, { newPlanId: `pln:${name.toLowerCase()}-r1` });
        const result = assemblePlan(request, current.project, seed.accepted, {
          planId: request.newPlanId, revision: 2, supersedes: proposed.plan.planId, state: "drafting", createdAt: T2, updatedAt: T2, sealedAt: null,
        }, planSha256);
        const revisionDecision = decision(result.plan, "plan-revision-accepted");
        const mutation = boundCommitRequest(seed.project.projectId, acceptedBinding(seed.accepted), current.controls, proposed, [{
          eventId: `plan-event:${name}:r1`, expectedState: "proposed", plan: result.plan,
          envelope: { occurredAt: T2, traceId: null, causationId: proposed.headEvent.eventId },
          event: event(proposed, result.plan, "plan.revised", { kind: "revise", mode: "R1" }, {
            controls: current.controls, review: result.review, decisions: [revisionDecision], predecessor: predecessor(proposed.plan, "superseded", T2),
          }),
        }]);
        expect(await store.commit(mutation, issueSyntheticPlanCommitAuthorization(mutation, [], [revisionDecision]))).toMatchObject({ kind: "committed", aggregateVersion: 3 });
        const revised = (await mustHead(store, seed.project.projectId)).plan;
        expect(revised).toMatchObject({ revision: 2, supersedes: proposed.plan.planId, state: "drafting" });
        expect(revised.tasks.every((task) => task.requirements.dataClassification === "proprietary-source")).toBe(true);
      }

      {
        const { adapter, store, seed, head: draft } = await bootstrap(factory());
        const proposed = await commitPromote(store, seed, draft, `${name}:r2`);
        const nextBrief = await acceptNextBrief(adapter, seed.accepted);
        const current = await reclassifyProject(adapter, seed, `${name} R2`);
        const request = assemblyRequestForBrief(nextBrief.brief, { newPlanId: `pln:${name.toLowerCase()}-r2` });
        const result = assemblePlan(request, current.project, nextBrief, {
          planId: request.newPlanId, revision: 1, supersedes: null, state: "drafting", createdAt: T2, updatedAt: T2, sealedAt: null,
        }, planSha256);
        const revisionDecision = decision(result.plan, "plan-revision-accepted");
        const rebase = {
          kind: "plan.rebased" as const,
          replaces: proposed.plan.planId,
          replacesRevision: proposed.plan.revision,
          previousDisposition: { kind: "superseded" as const, from: "proposed" as const, to: "superseded" as const },
          ...acceptedBinding(nextBrief),
        };
        const mutation = boundCommitRequest(seed.project.projectId, acceptedBinding(nextBrief), current.controls, proposed, [{
          eventId: `plan-event:${name}:r2`, expectedState: "proposed", plan: result.plan,
          envelope: { occurredAt: T2, traceId: null, causationId: proposed.headEvent.eventId },
          event: event(proposed, result.plan, "plan.revised", { kind: "revise", mode: "R2" }, {
            controls: current.controls, review: result.review, decisions: [revisionDecision], predecessor: predecessor(proposed.plan, "superseded", T2), rebase,
          }),
        }]);
        expect(await store.commit(mutation, issueSyntheticPlanCommitAuthorization(mutation, [], [revisionDecision]))).toMatchObject({ kind: "committed", aggregateVersion: 3 });
        const revised = (await mustHead(store, seed.project.projectId)).plan;
        expect(revised).toMatchObject({ revision: 1, supersedes: null, briefId: nextBrief.brief.briefId, state: "drafting" });
        expect(revised.tasks.every((task) => task.requirements.dataClassification === "proprietary-source")).toBe(true);
      }

      {
        const { adapter, store, seed, head: draft } = await bootstrap(factory());
        const nextBrief = await acceptNextBrief(adapter, seed.accepted);
        const current = await reclassifyProject(adapter, seed, `${name} draft R2`);
        const request = assemblyRequestForBrief(nextBrief.brief, { newPlanId: `pln:${name.toLowerCase()}-draft-r2` });
        const result = assemblePlan(request, current.project, nextBrief, {
          planId: request.newPlanId, revision: 1, supersedes: null, state: "drafting", createdAt: T1, updatedAt: T1, sealedAt: null,
        }, planSha256);
        const rebase = {
          kind: "plan.rebased" as const,
          replaces: draft.plan.planId,
          replacesRevision: draft.plan.revision,
          previousDisposition: { kind: "draft-replaced" as const, from: "drafting" as const },
          ...acceptedBinding(nextBrief),
        };
        const mutation = boundCommitRequest(seed.project.projectId, acceptedBinding(nextBrief), current.controls, draft, [{
          eventId: `plan-event:${name}:draft-r2`, expectedState: "drafting", plan: result.plan,
          envelope: { occurredAt: T1, traceId: null, causationId: draft.headEvent.eventId },
          event: event(draft, result.plan, "plan.drafted", { kind: "draft", mode: "redraft" }, {
            controls: current.controls, review: result.review, predecessor: predecessor(draft.plan, "drafting", T1), rebase,
          }),
        }]);
        expect(await store.commit(mutation, issueSyntheticPlanCommitAuthorization(mutation))).toMatchObject({ kind: "committed", aggregateVersion: 2 });
        const redrafted = (await mustHead(store, seed.project.projectId)).plan;
        expect(redrafted.briefId).toBe(nextBrief.brief.briefId);
        expect(redrafted.tasks.every((task) => task.requirements.dataClassification === "proprietary-source")).toBe(true);
      }
    });

    it(`persists the approval-required/rejected, abandon, and supersede variants over ${name}`, async () => {
      {
        const { store, seed, head: draft } = await bootstrap(factory());
        const [proposed, awaiting] = promoteDraft(draft.plan, T1, true);
        const escalation = boundCommitRequest(seed.project.projectId, acceptedBinding(seed.accepted), seed.controls, draft, [
          {
            eventId: `plan-event:${name}:propose-two-step`, expectedState: "drafting", plan: proposed!,
            envelope: { occurredAt: T1, traceId: null, causationId: null },
            event: event(draft, proposed!, "plan.proposed", { kind: "promote" }),
          },
          {
            eventId: `plan-event:${name}:approval-required`, expectedState: "proposed", plan: awaiting!,
            envelope: { occurredAt: T1, traceId: null, causationId: `plan-event:${name}:propose-two-step` },
            event: event(draft, awaiting!, "plan.scope-approval-required", { kind: "require-scope-approval" }),
          },
        ]);
        expect(await store.commit(escalation, issueSyntheticPlanCommitAuthorization(escalation))).toMatchObject({ kind: "committed", aggregateVersion: 3 });
        const awaitingHead = await mustHead(store, seed.project.projectId);
        expect(awaitingHead.plan.state).toBe("awaiting_scope_approval");
        const rejected = rejectPlanScope(awaitingHead.plan, T2);
        const scopeDecision = decision(rejected, "scope-rejected");
        const rejection = boundCommitRequest(seed.project.projectId, acceptedBinding(seed.accepted), seed.controls, awaitingHead, [{
          eventId: `plan-event:${name}:scope-rejected`, expectedState: "awaiting_scope_approval", plan: rejected,
          envelope: { occurredAt: T2, traceId: null, causationId: awaitingHead.headEvent.eventId },
          event: event(awaitingHead, rejected, "plan.scope-rejected", { kind: "reject-scope" }, { decisions: [scopeDecision] }),
        }]);
        expect(await store.commit(rejection, issueSyntheticPlanCommitAuthorization(rejection, [], [scopeDecision]))).toMatchObject({ kind: "committed", aggregateVersion: 4 });
        expect((await mustHead(store, seed.project.projectId)).plan.state).toBe("rejected");
      }

      {
        const { store, seed, head: draft } = await bootstrap(factory());
        const abandoned = abandonDraft(draft.plan, T1);
        const request = boundCommitRequest(seed.project.projectId, acceptedBinding(seed.accepted), seed.controls, draft, [{
          eventId: `plan-event:${name}:abandon`, expectedState: "drafting", plan: abandoned,
          envelope: { occurredAt: T1, traceId: null, causationId: draft.headEvent.eventId },
          event: event(draft, abandoned, "plan.abandoned", { kind: "abandon" }),
        }]);
        expect(await store.commit(request, issueSyntheticPlanCommitAuthorization(request))).toMatchObject({ kind: "committed", aggregateVersion: 2 });
      }

      {
        const { store, seed, head: draft } = await bootstrap(factory());
        const proposed = await commitPromote(store, seed, draft, `${name}:supersede`);
        const superseded = supersedeForRevision(proposed.plan, T2);
        const request = boundCommitRequest(seed.project.projectId, acceptedBinding(seed.accepted), seed.controls, proposed, [{
          eventId: `plan-event:${name}:supersede`, expectedState: "proposed", plan: superseded,
          envelope: { occurredAt: T2, traceId: null, causationId: proposed.headEvent.eventId },
          event: event(proposed, superseded, "plan.superseded", { kind: "discard-stale" }),
        }]);
        expect(await store.commit(request, issueSyntheticPlanCommitAuthorization(request))).toMatchObject({ kind: "committed", aggregateVersion: 3 });
      }
    });
  }
});
