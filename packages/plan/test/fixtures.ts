import { createBudgetAccount, parseAggregateBudget, type BudgetAccountState } from "@ai-dev-os/domain";
import {
  acceptCandidate,
  assembleCandidate,
  createC7IntakeStore,
  createClarificationSession,
  intakeSha256,
  type CandidateDraftInput,
} from "@ai-dev-os/intake";
import type { AggregateEnvelope, Clock, PersistenceAdapter } from "@ai-dev-os/persistence";
import {
  parseProject,
  parseProjectBrief,
  parseProjectPlan,
  serializeCanonicalProjectJson,
  type Project,
  type ProjectBrief,
  type ProjectPlan,
} from "@ai-dev-os/project";
import {
  assemblePlan,
  computeCoverageDigest,
  computePlanCommitContentDigest,
  computeProposalDigest,
  computeSpecificationDigest,
  parsePlanAssemblyRequest,
  parsePlanCommitRequest,
  projectStopSnapshotDigestMaterial,
  resolveProjectCeiling,
  type AcceptedBriefBinding,
  type AcceptedBriefHead,
  type PlanAssemblyRequest,
  type PlanCommitRequest,
  type PlanEventBinding,
  type PlanEventEnvelopeInput,
  type PlanHeadEventPayload,
  type PlanJournalEventPayload,
  type PlanLineageHead,
  type PlanMutationControlEvidence,
  type PlanProjectionContext,
  type PlanRecordCoordinates,
  type PlanReviewEvidence,
} from "../src/index.js";
import {
  c8AcceptedBriefAggregateId,
  createC8C7PlanStore,
  planSha256,
} from "../src/testing/index.js";

export const T0 = "2026-09-04T10:00:00.000Z";
export const T1 = "2026-09-04T10:01:00.000Z";
export const T2 = "2026-09-04T10:02:00.000Z";
export const SHA_A = "a".repeat(64);
export const SHA_B = "b".repeat(64);

export const fixedClock: Clock = Object.freeze({ now: () => new Date(T0) });

export const planBudget = Object.freeze({
  maximumInputTokens: 60,
  maximumOutputTokens: 40,
  maximumCostMicros: 1_000,
  maximumToolCalls: 2,
  maximumTurns: 2,
});

export function project(overrides: Partial<Project> = {}): Project {
  return parseProject({
    schemaVersion: 1,
    projectId: "prj:plan-test",
    revision: 1,
    displayName: "Plan Test",
    repositoryRoots: ["C:\\Projects\\PlanTest"],
    defaultBranch: "main",
    dataClassification: "internal",
    permissionMode: "contained-default",
    budgetAccountId: "budget:plan-test",
    effectiveConfigDigest: SHA_A,
    status: "active",
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });
}

export function brief(overrides: Partial<ProjectBrief> = {}): ProjectBrief {
  return parseProjectBrief({
    schemaVersion: 1,
    briefId: "brf:plan-test",
    projectId: "prj:plan-test",
    revision: 1,
    supersedes: null,
    origin: "operator",
    objective: "Build a deterministic plan contract.",
    outcomes: ["Produce a reviewable plan."],
    nonGoals: ["Do not execute project tasks."],
    audiences: ["Local development operators."],
    constraints: [
      {
        constraintId: "constraint:tokens",
        kind: "budget-tokens",
        statement: "Keep the plan within the token and action ceiling.",
        enforcement: "hard",
        machineForm: {
          maximumInputTokens: 100,
          maximumOutputTokens: 100,
          maximumToolCalls: 2,
          maximumTurns: 2,
        },
        origin: "operator",
        authority: "operator",
      },
      {
        constraintId: "constraint:money",
        kind: "budget-money",
        statement: "Keep the plan within the cost ceiling.",
        enforcement: "hard",
        machineForm: { currency: "GBP", maximumCostMicros: 1_000 },
        origin: "operator",
        authority: "operator",
      },
    ],
    assumptions: [],
    openQuestions: [],
    sourceThreadId: null,
    createdAt: T0,
    ...overrides,
  });
}

export function acceptedHead(value: ProjectBrief = brief()): AcceptedBriefHead {
  return Object.freeze({
    projectId: value.projectId,
    aggregateId: c8AcceptedBriefAggregateId(value.projectId),
    aggregateVersion: 1,
    brief: value,
    briefContentDigest: planSha256.sha256(serializeCanonicalProjectJson(value)),
    acceptedCandidateDigest: SHA_B,
    acceptanceEventId: "intake:plan-test",
  });
}

function briefRef(kind: "brief-objective" | "brief-outcome" | "brief-non-goal", index?: number) {
  return kind === "brief-objective"
    ? Object.freeze({ kind, briefId: "brf:plan-test" })
    : Object.freeze({ kind, briefId: "brf:plan-test", index: index ?? 0 });
}

export function rawAssemblyRequest(overrides: Partial<PlanAssemblyRequest> = {}): PlanAssemblyRequest {
  const specificationInput = {
    schemaVersion: 1 as const,
    specification: {
      schemaVersion: 1 as const,
      specificationId: "product-specification:plan-test",
      planId: "product-plan:plan-test",
      planVersion: 1,
      intentDigest: "1".repeat(64),
      decisionSetDigest: "2".repeat(64),
      requirements: [{
        requirementId: "req:core",
        requirementDigest: "3".repeat(64),
        title: "Implement the plan contract",
        category: "capability" as const,
        disposition: "required" as const,
        decisionId: "scope-decision:core",
        candidateIds: [],
        provenance: [],
        dissentIds: [],
      }],
      findingIds: [],
      questionIds: [],
      dissentIds: [],
      approvedBy: { actorId: "actor:product-owner", authority: "product-owner" as const },
      approvalReference: "approval-reference:plan-test",
      approvedAt: T0,
      approvalDigest: "4".repeat(64),
    },
    coverage: [{
      requirementId: "req:core",
      requirementDigest: "3".repeat(64),
      decisionId: "scope-decision:core",
      disposition: "required" as const,
      executable: true,
      taskId: "requirement-task:core",
    }],
    taskIdMap: [{ upstreamTaskId: "requirement-task:core", planTaskId: "tsk:core" }],
    waiverBindings: [],
  };
  const proposal = {
    schemaVersion: 1 as const,
    projectId: "prj:plan-test",
    briefId: "brf:plan-test",
    source: { kind: "deterministic" as const, authority: "none" as const, generatorId: "generator:fixture" },
    stages: [{
      stageId: "stg:core",
      title: "Build a deterministic plan contract.",
      intent: "Produce a reviewable plan.",
      exitCriteria: ["Do not execute project tasks."],
      taskIds: ["tsk:core"],
      provenance: {
        title: { origin: "brief" as const, derivedFrom: briefRef("brief-objective"), verbatim: true },
        intent: { origin: "brief" as const, derivedFrom: briefRef("brief-outcome"), verbatim: true },
        "exitCriteria[0]": { origin: "brief" as const, derivedFrom: briefRef("brief-non-goal"), verbatim: true },
      },
    }],
    tasks: [{
      taskId: "tsk:core",
      stageId: "stg:core",
      title: "Build a deterministic plan contract.",
      objective: "Produce a reviewable plan.",
      requirements: { kind: "implement" as const, complexity: 3 as const, risk: "medium" as const, reasoning: "high" as const },
      acceptance: [{ criterion: "Do not execute project tasks.", validationCommand: null }],
      requirementIds: ["req:core"],
      provenance: {
        title: { origin: "brief" as const, derivedFrom: briefRef("brief-objective"), verbatim: true },
        objective: { origin: "brief" as const, derivedFrom: briefRef("brief-outcome"), verbatim: true },
        "acceptance[0].criterion": { origin: "brief" as const, derivedFrom: briefRef("brief-non-goal"), verbatim: true },
      },
    }],
    dependencies: [],
    budgetCeiling: planBudget,
    constraintDispositions: [
      { constraintId: "constraint:money", disposition: "satisfied-by-design" as const, taskId: null, waiverDecisionId: null },
      { constraintId: "constraint:tokens", disposition: "satisfied-by-design" as const, taskId: null, waiverDecisionId: null },
    ],
  };
  const preliminary = {
    schemaVersion: 1 as const,
    newPlanId: "pln:plan-test",
    proposal,
    expectedProposalDigest: "0".repeat(64),
    expectedSpecificationDigest: "0".repeat(64),
    expectedCoverageDigest: "0".repeat(64),
    taskBudgetAllocations: [{ taskId: "tsk:core", budget: planBudget }],
    specificationInput,
    ...overrides,
  };
  const specificationDigest = computeSpecificationDigest(preliminary, planSha256);
  const coverageDigest = computeCoverageDigest(preliminary, planSha256);
  const withUpstream = {
    ...preliminary,
    expectedSpecificationDigest: specificationDigest,
    expectedCoverageDigest: coverageDigest,
  };
  return parsePlanAssemblyRequest({
    ...withUpstream,
    expectedProposalDigest: computeProposalDigest(withUpstream, planSha256),
  });
}

/**
 * A deliberately non-trivial, still-small request used to exercise canonical
 * ordering and durable nested-evidence parsing.  Keep the simpler fixture for
 * tests whose assertion is clearer with one task.
 */
export function complexAssemblyRequest(): PlanAssemblyRequest {
  const raw = structuredClone(rawAssemblyRequest()) as unknown as Record<string, unknown>;
  const proposal = raw["proposal"] as Record<string, unknown>;
  const stages = proposal["stages"] as Record<string, unknown>[];
  const tasks = proposal["tasks"] as Record<string, unknown>[];
  const specificationInput = raw["specificationInput"] as Record<string, unknown>;
  const specification = specificationInput["specification"] as Record<string, unknown>;
  const requirements = specification["requirements"] as Record<string, unknown>[];
  const coverage = specificationInput["coverage"] as Record<string, unknown>[];
  const sourceProvenance = (suffix: string) => [{
    contributionId: `contribution:${suffix}`,
    phaseId: "phase:scope",
    routeKey: "route:product-owner",
    sourceFingerprint: suffix.repeat(64),
    candidateId: `candidate:${suffix}`,
  }];

  requirements[0]!["candidateIds"] = ["candidate:a"];
  requirements[0]!["provenance"] = sourceProvenance("a");
  requirements.push(
    {
      requirementId: "req:quality",
      requirementDigest: "5".repeat(64),
      title: "Verify the plan contract",
      category: "quality",
      disposition: "expected-quality",
      decisionId: "scope-decision:quality",
      candidateIds: ["candidate:b"],
      provenance: sourceProvenance("b"),
      dissentIds: [],
    },
    {
      requirementId: "req:waived-a",
      requirementDigest: "6".repeat(64),
      title: "Optional compatibility A",
      category: "capability",
      disposition: "waived",
      decisionId: "scope-decision:waived-a",
      candidateIds: ["candidate:c"],
      provenance: sourceProvenance("c"),
      dissentIds: [],
    },
    {
      requirementId: "req:waived-b",
      requirementDigest: "7".repeat(64),
      title: "Optional compatibility B",
      category: "capability",
      disposition: "waived",
      decisionId: "scope-decision:waived-b",
      candidateIds: ["candidate:d"],
      provenance: sourceProvenance("d"),
      dissentIds: [],
    },
  );
  coverage.push(
    {
      requirementId: "req:quality",
      requirementDigest: "5".repeat(64),
      decisionId: "scope-decision:quality",
      disposition: "expected-quality",
      executable: true,
      taskId: "requirement-task:quality",
    },
    {
      requirementId: "req:waived-a",
      requirementDigest: "6".repeat(64),
      decisionId: "scope-decision:waived-a",
      disposition: "waived",
      executable: false,
      taskId: null,
    },
    {
      requirementId: "req:waived-b",
      requirementDigest: "7".repeat(64),
      decisionId: "scope-decision:waived-b",
      disposition: "waived",
      executable: false,
      taskId: null,
    },
  );
  specificationInput["taskIdMap"] = [
    { upstreamTaskId: "requirement-task:quality", planTaskId: "tsk:quality" },
    { upstreamTaskId: "requirement-task:core", planTaskId: "tsk:core" },
  ];
  specificationInput["waiverBindings"] = [
    { requirementId: "req:waived-b", waiverDecisionId: "dec:waived-b" },
    { requirementId: "req:waived-a", waiverDecisionId: "dec:waived-a" },
  ];

  const second = structuredClone(tasks[0]!);
  second["taskId"] = "tsk:quality";
  second["title"] = "Verify the plan contract";
  second["requirementIds"] = ["req:quality"];
  (second["provenance"] as Record<string, unknown>)["title"] = {
    origin: "specification",
    derivedFrom: {
      kind: "requirement",
      specificationId: specification["specificationId"],
      requirementId: "req:quality",
    },
    verbatim: true,
  };
  const third = structuredClone(tasks[0]!);
  third["taskId"] = "tsk:docs";
  third["title"] = "Build a deterministic plan contract.";
  third["requirementIds"] = [];
  tasks.push(second, third);
  stages[0]!["taskIds"] = ["tsk:docs", "tsk:quality", "tsk:core"];
  proposal["dependencies"] = [
    { fromTaskId: "tsk:quality", toTaskId: "tsk:docs", kind: "finish-to-start", artifactKind: null },
    { fromTaskId: "tsk:core", toTaskId: "tsk:quality", kind: "artifact", artifactKind: "plan-contract" },
  ];
  raw["taskBudgetAllocations"] = [
    { taskId: "tsk:quality", budget: { maximumInputTokens: 20, maximumOutputTokens: 15, maximumCostMicros: 300, maximumToolCalls: 1, maximumTurns: 1 } },
    { taskId: "tsk:docs", budget: { maximumInputTokens: 20, maximumOutputTokens: 10, maximumCostMicros: 300, maximumToolCalls: 0, maximumTurns: 0 } },
    { taskId: "tsk:core", budget: { maximumInputTokens: 20, maximumOutputTokens: 15, maximumCostMicros: 400, maximumToolCalls: 1, maximumTurns: 1 } },
  ];

  raw["expectedSpecificationDigest"] = computeSpecificationDigest(raw, planSha256);
  raw["expectedCoverageDigest"] = computeCoverageDigest(raw, planSha256);
  raw["expectedProposalDigest"] = computeProposalDigest(raw, planSha256);
  return parsePlanAssemblyRequest(raw);
}

export function assemblyRequestForBrief(
  value: ProjectBrief,
  overrides: Partial<PlanAssemblyRequest> = {},
): PlanAssemblyRequest {
  const base = rawAssemblyRequest();
  const rebind = (row: { readonly origin: string; readonly derivedFrom: unknown; readonly verbatim: boolean }) => {
    if (row.derivedFrom === null || typeof row.derivedFrom !== "object") return row;
    const reference = row.derivedFrom as Readonly<Record<string, unknown>>;
    if (typeof reference.kind !== "string" || !reference.kind.startsWith("brief-")) return row;
    return Object.freeze({ ...row, derivedFrom: Object.freeze({ ...reference, briefId: value.briefId }) });
  };
  const proposal = {
    ...base.proposal,
    briefId: value.briefId,
    stages: base.proposal.stages.map((stage) => ({
      ...stage,
      provenance: Object.fromEntries(Object.entries(stage.provenance).map(([path, row]) => [path, rebind(row)])),
    })),
    tasks: base.proposal.tasks.map((task) => ({
      ...task,
      provenance: Object.fromEntries(Object.entries(task.provenance).map(([path, row]) => [path, rebind(row)])),
    })),
  };
  const preliminary = {
    ...base,
    proposal,
    ...overrides,
    expectedProposalDigest: "0".repeat(64),
    expectedSpecificationDigest: base.specificationInput === null ? null : "0".repeat(64),
    expectedCoverageDigest: base.specificationInput === null ? null : "0".repeat(64),
  };
  const specificationDigest = computeSpecificationDigest(preliminary, planSha256);
  const coverageDigest = computeCoverageDigest(preliminary, planSha256);
  const withUpstream = { ...preliminary, expectedSpecificationDigest: specificationDigest, expectedCoverageDigest: coverageDigest };
  return parsePlanAssemblyRequest({ ...withUpstream, expectedProposalDigest: computeProposalDigest(withUpstream, planSha256) });
}

export function assembled(
  request: PlanAssemblyRequest = rawAssemblyRequest(),
  projectValue: Project = project(),
  accepted: AcceptedBriefHead = acceptedHead(),
  coordinates: Partial<PlanRecordCoordinates> = {},
) {
  return assemblePlan(request, projectValue, accepted, Object.freeze({
    planId: request.newPlanId,
    revision: 1,
    supersedes: null,
    state: "drafting",
    createdAt: T0,
    updatedAt: T0,
    sealedAt: null,
    ...coordinates,
  }), planSha256);
}

export function acceptedBinding(head: AcceptedBriefHead): AcceptedBriefBinding {
  return Object.freeze({
    projectId: head.projectId,
    briefId: head.brief.briefId,
    briefAggregateVersion: head.aggregateVersion,
    briefContentDigest: head.briefContentDigest,
    acceptedCandidateDigest: head.acceptedCandidateDigest,
    acceptanceEventId: head.acceptanceEventId,
  });
}

export function mutationControls(): PlanMutationControlEvidence {
  return Object.freeze({
    projectAggregateVersion: 1,
    projectContentDigest: SHA_A,
    projectStatus: "active",
    projectStopSnapshotDigest: SHA_B,
    activeProjectStopIds: Object.freeze([] as const),
  });
}

export function lineageHead(
  result: ReturnType<typeof assembled>,
  overrides: Partial<PlanLineageHead> = {},
): PlanLineageHead {
  const accepted = acceptedBinding(acceptedHead());
  const request = draftRequest(result.plan, result.review, accepted, mutationControls());
  const step = request.steps[0];
  if (step.plan === null) throw new Error("The fixture must create a head event.");
  const payloadChecksum = planSha256.sha256(serializeCanonicalProjectJson(step.event));
  const head: PlanLineageHead = Object.freeze({
    aggregateId: result.plan.projectId,
    aggregateVersion: 1,
    plan: result.plan,
    payloadChecksum,
    acceptedBrief: accepted,
    headEvent: Object.freeze({
      eventId: step.eventId,
      aggregateType: "project-plan",
      aggregateId: result.plan.projectId,
      aggregateVersion: 1,
      eventType: step.event.kind,
      eventSchemaVersion: 1,
      payload: step.event,
      payloadChecksum,
      occurredAt: step.envelope.occurredAt,
      recordedAt: step.envelope.occurredAt,
      globalSequence: 1,
      traceId: step.envelope.traceId,
      causationId: step.envelope.causationId,
    }),
    ...overrides,
  });
  return head;
}

export function projectionContext(overrides: Partial<PlanProjectionContext> = {}): PlanProjectionContext {
  const head = acceptedHead();
  const accepted = acceptedBinding(head);
  return Object.freeze({
    computedAt: T2,
    sessionState: "review-required",
    planAggregateVersion: 0,
    acceptedBrief: accepted,
    acceptedBriefAggregateId: head.aggregateId,
    currentBrief: accepted,
    unconfirmedAssumptionCount: 0,
    openQuestionCount: 0,
    notice: null,
    historicalHead: null,
    ...overrides,
  });
}

function eventBinding(
  plan: ProjectPlan,
  review: PlanReviewEvidence,
  accepted: AcceptedBriefBinding,
  controls: PlanMutationControlEvidence,
  expectedHead: PlanLineageHead | null,
  resultVersion: number,
  stepIndex = 1,
  stepCount = 1,
): PlanEventBinding {
  void controls;
  return Object.freeze({
    ...accepted,
    contentDigest: "0".repeat(64),
    planId: plan.planId,
    planRevision: plan.revision,
    planDigest: plan.planDigest,
    proposalDigest: review.proposalDigest,
    expectedHeadPlanId: expectedHead?.plan.planId ?? null,
    expectedAggregateVersion: expectedHead?.aggregateVersion ?? 0,
    resultAggregateVersion: resultVersion,
    resultState: plan.state,
    headAdvanced: true,
    stepIndex: stepIndex as 1 | 2,
    stepCount: stepCount as 1 | 2,
    briefBlockingQuestionIds: [],
  });
}

export function draftRequest(
  plan: ProjectPlan,
  review: PlanReviewEvidence,
  accepted: AcceptedBriefBinding,
  controls: PlanMutationControlEvidence,
  expectedHead: PlanLineageHead | null = null,
): PlanCommitRequest {
  const binding = eventBinding(plan, review, accepted, controls, expectedHead, (expectedHead?.aggregateVersion ?? 0) + 1);
  const event: PlanHeadEventPayload = Object.freeze({
    schemaVersion: 1,
    kind: "plan.drafted",
    operation: Object.freeze({ kind: "draft", mode: "create" }),
    plan,
    binding,
    controls,
    review,
    decisions: Object.freeze([] as const),
    rebase: null,
    predecessor: null,
    seal: null,
    budgetExtension: null,
  });
  const raw = {
    schemaVersion: 1 as const,
    projectId: plan.projectId,
    binding: { contentDigest: "0".repeat(64), expectedHeadPlanId: binding.expectedHeadPlanId, expectedAggregateVersion: binding.expectedAggregateVersion },
    acceptedBrief: accepted,
    expectedControls: controls,
    steps: [{ eventId: `plan-event:${plan.planId.slice(4)}:draft`, expectedState: null, plan, envelope: { occurredAt: plan.createdAt, traceId: null, causationId: null }, event }],
  } as unknown as PlanCommitRequest;
  const contentDigest = computePlanCommitContentDigest(raw, planSha256);
  const reboundEvent = { ...event, binding: { ...event.binding, contentDigest } };
  return parsePlanCommitRequest({
    ...raw,
    binding: { ...raw.binding, contentDigest },
    steps: [{ ...raw.steps[0], event: reboundEvent }],
  }, planSha256);
}

export interface UnboundPlanStep {
  readonly eventId: string;
  readonly expectedState: ProjectPlan["state"] | null;
  readonly plan: ProjectPlan | null;
  readonly envelope: PlanEventEnvelopeInput;
  readonly event: Omit<PlanJournalEventPayload, "binding">;
}

export function boundCommitRequest(
  projectId: string,
  accepted: AcceptedBriefBinding,
  controls: PlanMutationControlEvidence,
  expectedHead: PlanLineageHead | null,
  unbound: readonly UnboundPlanStep[],
): PlanCommitRequest {
  let resultVersion = expectedHead?.aggregateVersion ?? 0;
  const stepCount = unbound.length as 1 | 2;
  const steps = unbound.map((step, index) => {
    const headAdvanced = step.event.kind !== "plan.budget-extended";
    if (headAdvanced) resultVersion += 1;
    const binding = eventBinding(
      step.event.plan,
      step.event.review,
      accepted,
      controls,
      expectedHead,
      resultVersion,
      index + 1,
      stepCount,
    );
    return {
      eventId: step.eventId,
      expectedState: step.expectedState,
      plan: step.plan,
      envelope: step.envelope,
      event: { ...step.event, binding: { ...binding, headAdvanced } },
    };
  });
  const raw = {
    schemaVersion: 1,
    projectId,
    binding: {
      contentDigest: "0".repeat(64),
      expectedHeadPlanId: expectedHead?.plan.planId ?? null,
      expectedAggregateVersion: expectedHead?.aggregateVersion ?? 0,
    },
    acceptedBrief: accepted,
    expectedControls: controls,
    steps,
  } as unknown as PlanCommitRequest;
  const contentDigest = computePlanCommitContentDigest(raw, planSha256);
  return parsePlanCommitRequest({
    ...raw,
    binding: { ...raw.binding, contentDigest },
    steps: raw.steps.map((step) => ({
      ...step,
      event: { ...step.event, binding: { ...step.event.binding, contentDigest } },
    })),
  }, planSha256);
}

function candidateInput(projectId: string): CandidateDraftInput {
  const operator = Object.freeze({ source: "operator-supplied" as const, acceptedByOperator: true });
  const field = (value: string) => Object.freeze({ value, provenance: operator });
  const value = brief({ projectId, briefId: "brf:placeholder" });
  return Object.freeze({
    projectId,
    objective: field(value.objective),
    outcomes: value.outcomes.map(field),
    nonGoals: value.nonGoals.map(field),
    audiences: value.audiences.map(field),
    constraints: value.constraints.map((constraint) => Object.freeze({ value: constraint, provenance: operator, possible: true })),
    assumptions: [],
    openQuestions: [],
    sourceThreadId: null,
  });
}

export function budgetAccount(projectId = "prj:plan-test"): BudgetAccountState {
  return createBudgetAccount({
    scope: { scopeType: "project", scopeId: projectId },
    budget: parseAggregateBudget({
      tokens: { maxTotalTokens: 100, maxInputTokens: null, maxOutputTokens: null, softMaxTotalTokens: null },
      money: { limit: { currency: "GBP", amountMicros: 1_000 }, softLimit: null },
      time: null,
    }),
  });
}

export interface SeededFoundations {
  readonly project: Project;
  readonly projectEnvelope: AggregateEnvelope;
  readonly budgetAccount: BudgetAccountState;
  readonly budgetEnvelope: AggregateEnvelope;
  readonly accepted: AcceptedBriefHead;
  readonly controls: PlanMutationControlEvidence;
}

export async function seedFoundations(adapter: PersistenceAdapter): Promise<SeededFoundations> {
  const projectValue = project();
  const account = budgetAccount(projectValue.projectId);
  const { projectEnvelope, budgetEnvelope } = await adapter.transact(async (tx) => ({
    projectEnvelope: await tx.aggregates.create({ aggregateType: "project", aggregateId: projectValue.projectId, schemaVersion: 1, payload: projectValue }),
    budgetEnvelope: await tx.aggregates.create({ aggregateType: "budget-account", aggregateId: projectValue.budgetAccountId, schemaVersion: 1, payload: account }),
  }));
  const candidate = assembleCandidate(candidateInput(projectValue.projectId), intakeSha256);
  const outcome = await acceptCandidate({
    candidate,
    presentedDigest: candidate.candidateDigest,
    expectedHead: null,
    expectedAggregateVersion: 0,
    clarification: createClarificationSession(),
    operatorConfirmed: true,
  }, { digest: intakeSha256, clock: fixedClock, store: createC7IntakeStore(adapter) });
  if (outcome.status === "not-recorded" || outcome.status === "outcome-unknown") throw new Error("C8 acceptance did not commit.");
  const planStore = createC8C7PlanStore(adapter);
  const read = await planStore.readAcceptedBriefHead(projectValue.projectId);
  if (read.kind !== "accepted") throw new Error(`C8 accepted head was not proven: ${read.kind}`);
  const controls = Object.freeze({
    projectAggregateVersion: projectEnvelope.aggregateVersion,
    projectContentDigest: projectEnvelope.checksum.hex,
    projectStatus: "active" as const,
    projectStopSnapshotDigest: projectStopSnapshotDigestMaterial(projectValue.projectId, [], planSha256),
    activeProjectStopIds: Object.freeze([] as const),
  });
  return Object.freeze({ project: projectValue, projectEnvelope, budgetAccount: account, budgetEnvelope, accepted: read.head, controls });
}

export async function acceptNextBrief(
  adapter: PersistenceAdapter,
  previous: AcceptedBriefHead,
): Promise<AcceptedBriefHead> {
  const candidate = assembleCandidate(candidateInput(previous.projectId), intakeSha256);
  const outcome = await acceptCandidate({
    candidate,
    presentedDigest: candidate.candidateDigest,
    expectedHead: previous.brief,
    expectedAggregateVersion: previous.aggregateVersion,
    clarification: createClarificationSession(),
    operatorConfirmed: true,
  }, {
    digest: intakeSha256,
    clock: Object.freeze({ now: () => new Date(T1) }),
    store: createC7IntakeStore(adapter),
  });
  if (outcome.status === "not-recorded" || outcome.status === "outcome-unknown") throw new Error("C8 revision did not commit.");
  const read = await createC8C7PlanStore(adapter).readAcceptedBriefHead(previous.projectId);
  if (read.kind !== "accepted") throw new Error(`C8 revised head was not proven: ${read.kind}`);
  return read.head;
}

export function resolvedCeiling(seed: SeededFoundations) {
  return resolveProjectCeiling(seed.project.budgetAccountId, seed.budgetAccount, {
    aggregateVersion: seed.budgetEnvelope.aggregateVersion,
    contentDigest: seed.budgetEnvelope.checksum.hex,
  }, seed.accepted);
}

export function withPlanState(plan: ProjectPlan, state: ProjectPlan["state"], updatedAt: string, sealedAt: string | null = null): ProjectPlan {
  return parseProjectPlan({ ...plan, state, updatedAt, sealedAt, sealedByApprovalId: null });
}
