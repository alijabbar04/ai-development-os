import { toCanonicalJson, type JsonObject } from "@ai-dev-os/domain";
import { TaskGraph, type TaskDefinition, type TaskGraphEvent, type TaskGraphSnapshot } from "@ai-dev-os/task-graph";
import { PlanningError } from "./errors.js";
import {
  PRODUCT_PLANNING_SCHEMA_VERSION,
  PLANNING_PHASE_STATUSES,
  type ApproveSpecificationInput,
  type BudgetReconciliationIntent,
  type BudgetReservationIntent,
  type CandidateRequirement,
  type DeduplicatedRequirement,
  type DissentItem,
  type FeasibilityFinding,
  type PendingPlanningChanges,
  type PlanningContribution,
  type PlanningContributionEvidence,
  type PlanningEvent,
  type PlanningEventType,
  type PlanningPhase,
  type ProductIntent,
  type ProductIntentInput,
  type ProductPlanSnapshot,
  type ProductPlanningConfiguration,
  type ProductSpecification,
  type ProductSpecificationRequirement,
  type RequirementProvenance,
  type RequirementTaskCoverage,
  type ScopeDecision,
  type ScopeDecisionInput,
  type TrustedPlanningRoute,
  type UnresolvedQuestion,
} from "./contracts.js";
import {
  assertExecutableDisposition,
  canonicalBytes,
  comparePlanningText,
  createProductIntent,
  decisionSetDigest,
  normalizeRequirementKey,
  parseApproveSpecificationInput,
  parsePlanningContributionDraft,
  parsePlanningContributionEvidence,
  parseProductPlanSnapshot,
  parseScopeDecisionInput,
  phaseBudgetAllocation,
  planningDigest,
  stablePlanningId,
  sumUsage,
} from "./schema.js";

export interface ProductPlanRuntimeOptions {
  readonly clock?: { now(): Date };
}

const systemClock = Object.freeze({ now: (): Date => new Date() });

function assertExactObjectKeys(value: unknown, expected: readonly string[], label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlanningError("PERSISTENCE_MISMATCH", `${label} is not an exact object.`);
  }
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new PlanningError("PERSISTENCE_MISMATCH", `${label} has an inexact persisted shape.`);
  }
}

function routeByKey(configuration: ProductPlanningConfiguration, routeKey: string): TrustedPlanningRoute {
  const route = configuration.routes.find((item) => item.routeKey === routeKey);
  if (route === undefined) throw new PlanningError("INVALID_INPUT", "Planning phase route is unavailable.", { routeKey });
  return route;
}

function phaseIdentity(intent: ProductIntent, kind: PlanningPhase["kind"], specialistId: string | null): {
  readonly phaseId: string;
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
} {
  const qualifier = specialistId ?? kind;
  const phaseId = stablePlanningId("phase", intent.planId, kind, qualifier);
  return Object.freeze({
    phaseId,
    taskId: stablePlanningId("planning-task", intent.planId, phaseId),
    idempotencyKey: stablePlanningId("planning-idempotency", intent.planId, phaseId),
    inputDigest: planningDigest({ intentDigest: intent.intentDigest, kind, specialistId }),
  });
}

function createPhases(intent: ProductIntent, configuration: ProductPlanningConfiguration): readonly PlanningPhase[] {
  const definitions: Array<{ readonly kind: PlanningPhase["kind"]; readonly specialistId: string | null; readonly routeKey: string }> = [
    { kind: "product-discovery", specialistId: null, routeKey: configuration.discoveryRouteKey },
    ...configuration.specialists.map((specialist) => ({
      kind: "specialist-gap-analysis" as const,
      specialistId: specialist.specialistId,
      routeKey: specialist.routeKey,
    })),
    { kind: "engineering-feasibility", specialistId: null, routeKey: configuration.engineeringRouteKey },
    { kind: "plan-synthesis", specialistId: null, routeKey: configuration.synthesisRouteKey },
  ];
  return Object.freeze(definitions.map((definition) => Object.freeze({
    ...phaseIdentity(intent, definition.kind, definition.specialistId),
    kind: definition.kind,
    specialistId: definition.specialistId,
    route: routeByKey(configuration, definition.routeKey),
    status: "queued" as const,
    attempt: 0,
    resultId: null,
    contributionId: null,
    failureCode: null,
  })));
}

function initialTaskDefinitions(phases: readonly PlanningPhase[]): readonly TaskDefinition[] {
  const discovery = phases.find((phase) => phase.kind === "product-discovery")!;
  const specialists = phases.filter((phase) => phase.kind === "specialist-gap-analysis");
  const engineering = phases.find((phase) => phase.kind === "engineering-feasibility")!;
  const synthesis = phases.find((phase) => phase.kind === "plan-synthesis")!;
  return Object.freeze([
    {
      id: discovery.taskId,
      kind: "product-planning-phase",
      title: "Product discovery",
      metadata: { phaseId: discovery.phaseId, phaseKind: discovery.kind, idempotencyKey: discovery.idempotencyKey },
    },
    ...specialists.map((phase) => ({
      id: phase.taskId,
      kind: "product-planning-phase",
      title: `Specialist gap analysis: ${phase.specialistId}`,
      dependencies: [discovery.taskId],
      metadata: { phaseId: phase.phaseId, phaseKind: phase.kind, specialistId: phase.specialistId!, idempotencyKey: phase.idempotencyKey },
    })),
    {
      id: engineering.taskId,
      kind: "product-planning-phase",
      title: "Engineering feasibility",
      dependencies: specialists.length === 0 ? [discovery.taskId] : specialists.map((phase) => phase.taskId),
      metadata: { phaseId: engineering.phaseId, phaseKind: engineering.kind, idempotencyKey: engineering.idempotencyKey },
    },
    {
      id: synthesis.taskId,
      kind: "product-planning-phase",
      title: "Plan synthesis",
      dependencies: [engineering.taskId],
      metadata: { phaseId: synthesis.phaseId, phaseKind: synthesis.kind, idempotencyKey: synthesis.idempotencyKey },
    },
  ]);
}

function assertIndependentRoutes(intent: ProductIntent, configuration: ProductPlanningConfiguration): void {
  if (intent.risk === "routine") return;
  const discovery = routeByKey(configuration, configuration.discoveryRouteKey);
  const engineering = routeByKey(configuration, configuration.engineeringRouteKey);
  const synthesis = routeByKey(configuration, configuration.synthesisRouteKey);
  if (discovery.independenceKey === synthesis.independenceKey || engineering.independenceKey === synthesis.independenceKey) {
    throw new PlanningError(
      "INDEPENDENCE_REQUIRED",
      "Material and high-risk plans require distinct trusted discovery, engineering, and synthesis route evidence.",
    );
  }
}

function assertIntentLimits(intent: ProductIntent, configuration: ProductPlanningConfiguration): void {
  const limits = configuration.limits;
  if (Date.parse(intent.deadline) - Date.parse(intent.createdAt) > limits.maximumWallTimeMs) {
    throw new PlanningError("LIMIT_EXCEEDED", "Planning wall-time preview exceeds its configured bound.");
  }
  if (intent.budget.maximumInputTokens + intent.budget.maximumOutputTokens > limits.maximumTotalTokens ||
      intent.budget.maximumCostMicros > limits.maximumMoneyMicros ||
      intent.budget.maximumProviderCalls > limits.maximumProviderCalls) {
    throw new PlanningError("LIMIT_EXCEEDED", "Planning budget preview exceeds a configured hard limit.");
  }
}

function assertPlanAdmission(
  intent: ProductIntent,
  configuration: ProductPlanningConfiguration,
  phases: readonly PlanningPhase[],
  persisted = false,
): void {
  try {
    assertIntentLimits(intent, configuration);
    assertIndependentRoutes(intent, configuration);
    if (phases.length > configuration.limits.maximumPhases || phases.length > configuration.limits.maximumGraphNodes) {
      throw new PlanningError("LIMIT_EXCEEDED", "Planning phase or initial graph-node count exceeds its bound.");
    }
    if (phases.length > configuration.limits.maximumContributions ||
        phases.length > configuration.limits.maximumProviderCalls ||
        phases.length > intent.budget.maximumProviderCalls ||
        intent.budget.maximumInputTokens < phases.length ||
        intent.budget.maximumOutputTokens < phases.length) {
      throw new PlanningError("LIMIT_EXCEEDED", "Plan budgets cannot fund every mandatory phase.");
    }
  } catch (error) {
    if (!persisted) throw error;
    throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted plan violates bounded admission invariants.", {
      causeCode: error instanceof PlanningError ? error.code : "invalid-admission",
    });
  }
}

function assertCumulativeContributionLimits(
  contributions: readonly PlanningContribution[],
  intent: ProductIntent,
  configuration: ProductPlanningConfiguration,
  code: "LIMIT_EXCEEDED" | "PERSISTENCE_MISMATCH",
): void {
  const candidateCount = contributions.reduce((sum, item) => sum + item.candidates.length, 0);
  const totalBytes = contributions.reduce((sum, item) => sum + item.outputBytes, 0);
  const usage = sumUsage(contributions.map((item) => item.usage));
  const inputTokens = usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteInputTokens;
  const outputTokens = usage.outputTokens + usage.reasoningTokens;
  const totalTokens = inputTokens + outputTokens;
  if (contributions.length > configuration.limits.maximumContributions ||
      candidateCount > configuration.limits.maximumCandidateRequirements ||
      totalBytes > configuration.limits.maximumTotalOutputBytes ||
      contributions.length > configuration.limits.maximumProviderCalls ||
      contributions.length > intent.budget.maximumProviderCalls ||
      totalTokens > configuration.limits.maximumTotalTokens ||
      inputTokens > intent.budget.maximumInputTokens || outputTokens > intent.budget.maximumOutputTokens ||
      (usage.costMicros !== null &&
        (usage.costMicros > configuration.limits.maximumMoneyMicros || usage.costMicros > intent.budget.maximumCostMicros))) {
    throw new PlanningError(code, "Planning contributions exceed a cumulative hard limit.");
  }
}

function contributionPayload(value: Omit<PlanningContribution, "contributionDigest" | "applied">): unknown {
  return value;
}

function decisionPayload(value: Omit<ScopeDecision, "decisionDigest">): unknown {
  return value;
}

function requirementPayload(value: Omit<DeduplicatedRequirement, "requirementDigest" | "currentDecisionId">): unknown {
  return value;
}

function specificationPayload(value: Omit<ProductSpecification, "approvalDigest">): unknown {
  return value;
}

function buildContribution(
  planId: string,
  phase: PlanningPhase,
  evidenceValue: PlanningContributionEvidence,
  draftValue: unknown,
  configuration: ProductPlanningConfiguration,
  maximumAttempts: number,
): PlanningContribution {
  const evidence = parsePlanningContributionEvidence(evidenceValue, phase.route);
  if (evidence.phaseId !== phase.phaseId || evidence.inputDigest !== phase.inputDigest ||
      evidence.schedulerTaskId !== phase.taskId || evidence.schedulerIdempotencyKey !== phase.idempotencyKey) {
    throw new PlanningError("CONFLICT", "Contribution evidence is bound to a different phase input or scheduler identity.");
  }
  if (evidence.attempt > maximumAttempts) {
    throw new PlanningError("LIMIT_EXCEEDED", "Contribution attempt exceeds the bounded retry policy.", { attempt: evidence.attempt });
  }
  const draft = parsePlanningContributionDraft(draftValue);
  const outputBytes = canonicalBytes(draft);
  if (outputBytes > configuration.limits.maximumContributionBytes) {
    throw new PlanningError("LIMIT_EXCEEDED", "Contribution output exceeds its byte limit.", { outputBytes });
  }
  const contributionId = stablePlanningId("contribution", planId, phase.phaseId, evidence.resultId);
  const proposals: CandidateRequirement[] = draft.candidates.map((candidate) => Object.freeze({
    candidateId: stablePlanningId("candidate", contributionId, "proposal", candidate.localKey),
    contributionId,
    sourceKind: "proposal" as const,
    localKey: candidate.localKey,
    normalizedKey: normalizeRequirementKey(candidate.title),
    title: candidate.title,
    description: candidate.description,
    rationale: candidate.rationale,
    category: candidate.category,
    proposedDisposition: candidate.proposedDisposition,
    dependsOnKeys: Object.freeze([...new Set(candidate.dependsOn)].sort()),
  }));
  const unresolvedQuestions: UnresolvedQuestion[] = draft.unresolvedQuestions.map((question, index) => {
    const questionId = stablePlanningId("question", contributionId, String(index), question.question);
    return Object.freeze({
      ...question,
      questionId,
      contributionId,
      normalizedKey: normalizeRequirementKey(question.question),
      candidateId: stablePlanningId("candidate", contributionId, "question", questionId),
    });
  });
  const questionCandidates: CandidateRequirement[] = unresolvedQuestions.map((question) => Object.freeze({
    candidateId: question.candidateId,
    contributionId,
    sourceKind: "question" as const,
    localKey: question.questionId,
    normalizedKey: question.normalizedKey,
    title: question.question,
    description: question.question,
    rationale: "Explicit unresolved planning question preserved for scope disposition.",
    category: "unresolved-question" as const,
    proposedDisposition: question.material ? "blocked" as const : "deferred" as const,
    dependsOnKeys: Object.freeze([]),
  }));
  const dissent: DissentItem[] = draft.dissent.map((item, index) => {
    const dissentId = stablePlanningId("dissent", contributionId, String(index), item.subject, item.position);
    return Object.freeze({
      ...item,
      dissentId,
      contributionId,
      normalizedKey: normalizeRequirementKey(item.subject),
      candidateId: stablePlanningId("candidate", contributionId, "dissent", dissentId),
    });
  });
  const dissentCandidates: CandidateRequirement[] = dissent.map((item) => Object.freeze({
    candidateId: item.candidateId,
    contributionId,
    sourceKind: "dissent" as const,
    localKey: item.dissentId,
    normalizedKey: item.normalizedKey,
    title: item.subject,
    description: item.position,
    rationale: item.rationale,
    category: "risk" as const,
    proposedDisposition: "blocked" as const,
    dependsOnKeys: Object.freeze([]),
  }));
  const candidates = Object.freeze([...proposals, ...questionCandidates, ...dissentCandidates]
    .sort((left, right) => comparePlanningText(left.candidateId, right.candidateId)));
  const findings: readonly FeasibilityFinding[] = Object.freeze(draft.findings.map((finding, index) => Object.freeze({
    ...finding,
    findingId: stablePlanningId("finding", contributionId, String(index), finding.summary),
    contributionId,
  })));
  const withoutDigest = Object.freeze({
    contributionId,
    planId,
    phaseId: phase.phaseId,
    resultId: evidence.resultId,
    attempt: evidence.attempt,
    inputDigest: evidence.inputDigest,
    schedulerTaskId: evidence.schedulerTaskId,
    schedulerIdempotencyKey: evidence.schedulerIdempotencyKey,
    route: evidence.route,
    sourceFingerprint: evidence.sourceFingerprint,
    completedAt: evidence.completedAt,
    authority: "none" as const,
    candidates,
    findings,
    unresolvedQuestions: Object.freeze(unresolvedQuestions),
    dissent: Object.freeze(dissent),
    usage: evidence.usage,
    outputBytes,
  });
  return Object.freeze({
    ...withoutDigest,
    contributionDigest: planningDigest(contributionPayload(withoutDigest)),
    applied: false,
  });
}

function currentDecisionByRequirement(decisions: readonly ScopeDecision[]): Map<string, ScopeDecision> {
  const superseded = new Set(decisions.map((decision) => decision.supersedesDecisionId).filter((id): id is string => id !== null));
  const current = new Map<string, ScopeDecision>();
  for (const decision of decisions) {
    if (!superseded.has(decision.decisionId)) current.set(decision.requirementId, decision);
  }
  return current;
}

function rebuildRequirements(
  planId: string,
  contributions: readonly PlanningContribution[],
  decisions: readonly ScopeDecision[],
): readonly DeduplicatedRequirement[] {
  const groups = new Map<string, CandidateRequirement[]>();
  const contributionMap = new Map(contributions.map((contribution) => [contribution.contributionId, contribution]));
  for (const contribution of contributions) {
    for (const candidate of contribution.candidates) {
      const group = groups.get(candidate.normalizedKey) ?? [];
      group.push(candidate);
      groups.set(candidate.normalizedKey, group);
    }
  }
  const current = currentDecisionByRequirement(decisions);
  return Object.freeze([...groups.entries()].map(([normalizedKey, values]) => {
    const candidates = [...values].sort((left, right) => comparePlanningText(left.candidateId, right.candidateId));
    const canonical = [...candidates].sort((left, right) =>
      comparePlanningText(left.title, right.title) || comparePlanningText(left.candidateId, right.candidateId),
    )[0]!;
    const requirementId = stablePlanningId("requirement", planId, normalizedKey);
    const provenance: RequirementProvenance[] = candidates.map((candidate) => {
      const contribution = contributionMap.get(candidate.contributionId)!;
      return Object.freeze({
        contributionId: contribution.contributionId,
        phaseId: contribution.phaseId,
        routeKey: contribution.route.routeKey,
        sourceFingerprint: contribution.sourceFingerprint,
        candidateId: candidate.candidateId,
      });
    }).sort((left, right) => comparePlanningText(left.candidateId, right.candidateId));
    const dissentIds = contributions.flatMap((contribution) => contribution.dissent
      .filter((item) => item.normalizedKey === normalizedKey)
      .map((item) => item.dissentId)).sort();
    const withoutDigest = Object.freeze({
      requirementId,
      normalizedKey,
      title: canonical.title,
      category: canonical.category,
      candidateIds: Object.freeze(candidates.map((candidate) => candidate.candidateId)),
      provenance: Object.freeze(provenance),
      dissentIds: Object.freeze(dissentIds),
      proposedDispositions: Object.freeze([...new Set(candidates.map((candidate) => candidate.proposedDisposition))].sort()),
      dependencyKeys: Object.freeze([...new Set(candidates.flatMap((candidate) => candidate.dependsOnKeys))].sort()),
    });
    const requirementDigest = planningDigest(requirementPayload(withoutDigest));
    const decision = current.get(requirementId);
    return Object.freeze({
      ...withoutDigest,
      requirementDigest,
      currentDecisionId: decision?.requirementDigest === requirementDigest ? decision.decisionId : null,
    });
  }).sort((left, right) => comparePlanningText(left.requirementId, right.requirementId)));
}

function validateContribution(value: PlanningContribution, planId: string): void {
  assertExactObjectKeys(value, [
    "contributionId", "planId", "phaseId", "resultId", "attempt", "inputDigest", "schedulerTaskId",
    "schedulerIdempotencyKey", "route", "sourceFingerprint", "completedAt", "authority", "candidates",
    "findings", "unresolvedQuestions", "dissent", "usage", "outputBytes", "contributionDigest", "applied",
  ], "Persisted contribution");
  assertExactObjectKeys(value.route, [
    "routeKey", "providerId", "modelId", "profileId", "ownership", "configurationFingerprint", "independenceKey",
  ], "Persisted contribution route");
  assertExactObjectKeys(value.usage, [
    "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningTokens", "toolCalls", "costMicros",
  ], "Persisted contribution usage");
  if (value.planId !== planId || value.authority !== "none") throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted contribution authority or plan identity is invalid.");
  const { contributionDigest, applied: _applied, ...payload } = value;
  if (planningDigest(contributionPayload(payload)) !== contributionDigest) {
    throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted contribution digest mismatch.", { contributionId: value.contributionId });
  }
  for (const candidate of value.candidates) {
    assertExactObjectKeys(candidate, [
      "candidateId", "contributionId", "sourceKind", "localKey", "normalizedKey", "title", "description",
      "rationale", "category", "proposedDisposition", "dependsOnKeys",
    ], "Persisted candidate");
    if (candidate.contributionId !== value.contributionId || candidate.normalizedKey !== normalizeRequirementKey(candidate.title)) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted candidate identity or normalization mismatch.");
    }
  }
  value.findings.forEach((finding, index) => {
    assertExactObjectKeys(finding, ["findingId", "contributionId", "kind", "summary", "severity"], "Persisted finding");
    if (finding.contributionId !== value.contributionId ||
        finding.findingId !== stablePlanningId("finding", value.contributionId, String(index), finding.summary)) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted finding identity mismatch.");
    }
  });
  value.unresolvedQuestions.forEach((question, index) => {
    assertExactObjectKeys(question, ["questionId", "contributionId", "normalizedKey", "candidateId", "question", "material"], "Persisted question");
    const questionId = stablePlanningId("question", value.contributionId, String(index), question.question);
    if (question.contributionId !== value.contributionId || question.questionId !== questionId ||
        question.normalizedKey !== normalizeRequirementKey(question.question) ||
        question.candidateId !== stablePlanningId("candidate", value.contributionId, "question", questionId)) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted question identity mismatch.");
    }
  });
  value.dissent.forEach((dissent, index) => {
    assertExactObjectKeys(dissent, ["dissentId", "contributionId", "normalizedKey", "candidateId", "subject", "position", "rationale", "severity"], "Persisted dissent");
    const dissentId = stablePlanningId("dissent", value.contributionId, String(index), dissent.subject, dissent.position);
    if (dissent.contributionId !== value.contributionId || dissent.dissentId !== dissentId ||
        dissent.normalizedKey !== normalizeRequirementKey(dissent.subject) ||
        dissent.candidateId !== stablePlanningId("candidate", value.contributionId, "dissent", dissentId)) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted dissent identity mismatch.");
    }
  });
}

function validateDecision(value: ScopeDecision, planId: string): void {
  assertExactObjectKeys(value, [
    "decisionId", "planId", "planVersion", "requirementId", "requirementDigest", "disposition", "actor", "reason",
    "approvalReference", "decidedAt", "supersedesDecisionId", "decisionDigest",
  ], "Persisted scope decision");
  assertExactObjectKeys(value.actor, ["actorId", "authority"], "Persisted scope actor");
  if (value.planId !== planId) throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted decision plan identity mismatch.");
  const parsed = parseScopeDecisionInput({
    requirementId: value.requirementId,
    requirementDigest: value.requirementDigest,
    expectedPlanVersion: Math.max(1, value.planVersion - 1),
    disposition: value.disposition,
    actor: value.actor,
    reason: value.reason,
    approvalReference: value.approvalReference,
    decidedAt: value.decidedAt,
  });
  const expectedId = stablePlanningId(
    "scope-decision", planId, parsed.requirementId, parsed.requirementDigest, parsed.disposition,
    parsed.actor.actorId, parsed.actor.authority, parsed.reason, parsed.approvalReference ?? "none", parsed.decidedAt,
  );
  const executable = assertExecutableDisposition(value.disposition);
  if (value.decisionId !== expectedId || value.planVersion < 2 ||
      (executable || value.disposition === "waived") && value.approvalReference === null ||
      executable && !["operator", "product-owner"].includes(value.actor.authority) ||
      value.disposition === "waived" && !["operator", "security-reviewer"].includes(value.actor.authority) ||
      value.actor.authority === "deterministic-rule" && !["duplicate", "superseded"].includes(value.disposition)) {
    throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted scope-decision authority or generated identity is invalid.");
  }
  const { decisionDigest, ...payload } = value;
  if (planningDigest(decisionPayload(payload)) !== decisionDigest) {
    throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted scope-decision digest mismatch.", { decisionId: value.decisionId });
  }
}

function contributionDraftProjection(value: PlanningContribution): unknown {
  return {
    candidates: value.candidates.filter((candidate) => candidate.sourceKind === "proposal").map((candidate) => ({
      localKey: candidate.localKey,
      title: candidate.title,
      description: candidate.description,
      rationale: candidate.rationale,
      category: candidate.category,
      proposedDisposition: candidate.proposedDisposition,
      dependsOn: candidate.dependsOnKeys,
    })),
    findings: value.findings.map(({ kind, summary, severity }) => ({ kind, summary, severity })),
    unresolvedQuestions: value.unresolvedQuestions.map(({ question, material }) => ({ question, material })),
    dissent: value.dissent.map(({ subject, position, rationale, severity }) => ({ subject, position, rationale, severity })),
  };
}

function assertGraphDepth(
  executable: readonly DeduplicatedRequirement[],
  maximumDepth: number,
): void {
  const byKey = new Map(executable.map((requirement) => [requirement.normalizedKey, requirement]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (requirement: DeduplicatedRequirement): number => {
    const known = memo.get(requirement.requirementId);
    if (known !== undefined) return known;
    if (visiting.has(requirement.requirementId)) throw new PlanningError("INVALID_INPUT", "Executable requirement dependencies contain a cycle.");
    visiting.add(requirement.requirementId);
    let value = 1;
    for (const dependencyKey of requirement.dependencyKeys) {
      const dependency = byKey.get(dependencyKey);
      if (dependency === undefined) throw new PlanningError("INVALID_INPUT", "Executable requirement has an absent or non-executable dependency.", { dependencyKey });
      value = Math.max(value, 1 + depth(dependency));
    }
    visiting.delete(requirement.requirementId);
    memo.set(requirement.requirementId, value);
    return value;
  };
  for (const requirement of executable) {
    if (depth(requirement) > maximumDepth) throw new PlanningError("LIMIT_EXCEEDED", "Requirement dependency depth exceeds its bound.");
  }
}

function assertCombinedGraphBounds(
  snapshot: TaskGraphSnapshot,
  configuration: ProductPlanningConfiguration,
): void {
  if (snapshot.tasks.length > configuration.limits.maximumGraphNodes) {
    throw new PlanningError("LIMIT_EXCEEDED", "Planning graph node count exceeds its configured bound.");
  }
  const byId = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (taskId: string): number => {
    const known = memo.get(taskId);
    if (known !== undefined) return known;
    if (visiting.has(taskId)) throw new PlanningError("PERSISTENCE_MISMATCH", "Planning graph contains a dependency cycle.");
    const task = byId.get(taskId);
    if (task === undefined) throw new PlanningError("PERSISTENCE_MISMATCH", "Planning graph contains an absent dependency.");
    if (task.dependencies.length > configuration.limits.maximumDependencyFanOut) {
      throw new PlanningError("LIMIT_EXCEEDED", "Planning graph dependency fan-out exceeds its configured bound.", { taskId });
    }
    visiting.add(taskId);
    let value = 1;
    for (const dependencyId of task.dependencies) value = Math.max(value, depth(dependencyId) + 1);
    visiting.delete(taskId);
    memo.set(taskId, value);
    return value;
  };
  for (const task of snapshot.tasks) {
    if (depth(task.id) > configuration.limits.maximumGraphDepth) {
      throw new PlanningError("LIMIT_EXCEEDED", "Planning graph depth exceeds its configured bound.", { taskId: task.id });
    }
  }
}

export class ProductPlan {
  readonly #configuration: ProductPlanningConfiguration;
  readonly #clock: { now(): Date };
  readonly #intent: ProductIntent;
  readonly #reservationIntent: BudgetReservationIntent;
  #aggregateVersion: number;
  #eventSequence: number;
  #phases: PlanningPhase[];
  #stagedContributions: PlanningContribution[];
  #contributions: PlanningContribution[];
  #requirements: DeduplicatedRequirement[];
  #decisions: ScopeDecision[];
  #specification: ProductSpecification | null;
  #coverage: RequirementTaskCoverage[];
  #reconciliationIntent: BudgetReconciliationIntent | null;
  #graph: TaskGraph;
  readonly #createdAt: string;
  #updatedAt: string;
  #pendingEvents: PlanningEvent[];
  #pendingGraphEvents: TaskGraphEvent[];

  private constructor(options: {
    readonly configuration: ProductPlanningConfiguration;
    readonly clock: { now(): Date };
    readonly snapshot: ProductPlanSnapshot;
    readonly graph: TaskGraph;
    readonly pendingEvents?: readonly PlanningEvent[];
    readonly pendingGraphEvents?: readonly TaskGraphEvent[];
  }) {
    const snapshot = options.snapshot;
    this.#configuration = options.configuration;
    this.#clock = options.clock;
    this.#intent = snapshot.intent;
    this.#reservationIntent = snapshot.reservationIntent;
    this.#aggregateVersion = snapshot.aggregateVersion;
    this.#eventSequence = snapshot.eventSequence;
    this.#phases = [...snapshot.phases];
    this.#stagedContributions = [...snapshot.stagedContributions];
    this.#contributions = [...snapshot.contributions];
    this.#requirements = [...snapshot.requirements];
    this.#decisions = [...snapshot.decisions];
    this.#specification = snapshot.specification;
    this.#coverage = [...snapshot.coverage];
    this.#reconciliationIntent = snapshot.reconciliationIntent;
    this.#graph = options.graph;
    this.#createdAt = snapshot.createdAt;
    this.#updatedAt = snapshot.updatedAt;
    this.#pendingEvents = [...(options.pendingEvents ?? [])];
    this.#pendingGraphEvents = [...(options.pendingGraphEvents ?? [])];
  }

  static create(
    intentValue: ProductIntentInput,
    configuration: ProductPlanningConfiguration,
    options: ProductPlanRuntimeOptions = {},
  ): ProductPlan {
    const intent = createProductIntent(intentValue);
    const phases = createPhases(intent, configuration);
    assertPlanAdmission(intent, configuration, phases);
    const clock = options.clock ?? systemClock;
    const graph = TaskGraph.create(
      { graphId: stablePlanningId("planning-graph", intent.planId), projectId: intent.projectId },
      { clock: () => clock.now() },
    );
    graph.addTasks(initialTaskDefinitions(phases));
    graph.seal();
    assertCombinedGraphBounds(graph.toSnapshot(), configuration);
    const graphEvents = graph.peekEvents();
    graph.acknowledgeEvents(graph.eventSequence);
    const reservationIntent = Object.freeze({
      reservationId: stablePlanningId("planning-reservation", intent.planId, intent.intentDigest),
      planId: intent.planId,
      preview: intent.budget,
      status: "intended" as const,
    });
    const initial: ProductPlanSnapshot = Object.freeze({
      schemaVersion: PRODUCT_PLANNING_SCHEMA_VERSION,
      planId: intent.planId,
      aggregateVersion: 1,
      eventSequence: 1,
      intent,
      configurationFingerprint: configuration.configurationFingerprint,
      phases,
      stagedContributions: Object.freeze([]),
      contributions: Object.freeze([]),
      requirements: Object.freeze([]),
      decisions: Object.freeze([]),
      specification: null,
      coverage: Object.freeze([]),
      reservationIntent,
      reconciliationIntent: null,
      taskGraph: graph.toSnapshot(),
      createdAt: intent.createdAt,
      updatedAt: intent.createdAt,
    });
    const afterDigest = planningDigest(initial);
    const event: PlanningEvent = Object.freeze({
      schemaVersion: PRODUCT_PLANNING_SCHEMA_VERSION,
      eventId: stablePlanningId("planning-event", intent.planId, "1", afterDigest),
      planId: intent.planId,
      sequence: 1,
      aggregateVersion: 1,
      type: "plan.accepted",
      occurredAt: intent.createdAt,
      beforeDigest: null,
      afterDigest,
      snapshot: initial,
    });
    return new ProductPlan({ configuration, clock, snapshot: initial, graph, pendingEvents: [event], pendingGraphEvents: graphEvents });
  }

  static hydrate(
    value: unknown,
    configuration: ProductPlanningConfiguration,
    options: ProductPlanRuntimeOptions = {},
  ): ProductPlan {
    try {
      const snapshot = parseProductPlanSnapshot(value, configuration);
      const clock = options.clock ?? systemClock;
      const graph = TaskGraph.hydrate(snapshot.taskGraph, { clock: () => clock.now() });
      assertCombinedGraphBounds(graph.toSnapshot(), configuration);
      const expectedPhases = createPhases(snapshot.intent, configuration);
      assertPlanAdmission(snapshot.intent, configuration, expectedPhases, true);
      if (expectedPhases.length !== snapshot.phases.length) throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted phase count mismatch.");
      if (toCanonicalJson(snapshot.phases.map((phase) => phase.phaseId)) !==
          toCanonicalJson(expectedPhases.map((phase) => phase.phaseId))) {
        throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted phase ordering is non-canonical.");
      }
      for (const expected of expectedPhases) {
        const actual = snapshot.phases.find((phase) => phase.phaseId === expected.phaseId);
        if (actual !== undefined) {
          assertExactObjectKeys(actual, [
            "phaseId", "kind", "specialistId", "taskId", "idempotencyKey", "inputDigest", "route", "status",
            "attempt", "resultId", "contributionId", "failureCode",
          ], "Persisted planning phase");
          assertExactObjectKeys(actual.route, [
            "routeKey", "providerId", "modelId", "profileId", "ownership", "configurationFingerprint", "independenceKey",
          ], "Persisted planning phase route");
        }
        if (actual === undefined || actual.taskId !== expected.taskId || actual.idempotencyKey !== expected.idempotencyKey ||
            actual.kind !== expected.kind || actual.specialistId !== expected.specialistId ||
            actual.inputDigest !== expected.inputDigest || toCanonicalJson(actual.route) !== toCanonicalJson(expected.route) ||
            !(PLANNING_PHASE_STATUSES as readonly string[]).includes(actual.status) ||
            !Number.isSafeInteger(actual.attempt) || actual.attempt < 0 ||
            (actual.status === "failed") !== (actual.failureCode !== null)) {
          throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted planning phase identity mismatch.");
        }
      }
      for (let phaseIndex = 0; phaseIndex < snapshot.phases.length; phaseIndex += 1) {
        const phase = snapshot.phases[phaseIndex]!;
        const allocation = phaseBudgetAllocation(snapshot.intent, configuration, phaseIndex, snapshot.phases.length, phase.kind === "plan-synthesis");
        if (phase.attempt > allocation.maximumAttempts ||
            phase.failureCode !== null && !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(phase.failureCode)) {
          throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted phase attempt or failure classification exceeds its bound.");
        }
      }
      const initialDefinitionList = initialTaskDefinitions(expectedPhases);
      const initialDefinitions = new Map(initialDefinitionList.map((definition) => [definition.id, definition]));
      const initialOrder = new Map(initialDefinitionList.map((definition, index) => [definition.id, index]));
      for (const phase of snapshot.phases) {
        const task = graph.getTask(phase.taskId);
        const definition = initialDefinitions.get(phase.taskId)!;
        const dependencies = definition.dependencies ?? [];
        const validStatus = phase.status === "completed" ? task.status === "succeeded"
          : phase.status === "failed" ? task.status === "failed"
            : phase.status === "cancelled" ? task.status === "cancelled" || task.status === "blocked"
              : phase.kind === "plan-synthesis" && phase.contributionId !== null ? task.status === "running"
                : task.status === "pending" || task.status === "ready";
        const expectedFailure = phase.status === "failed"
          ? { code: "PLANNING_PHASE_FAILED", message: "The bounded planning phase failed.", retryable: false }
          : null;
        if (task.kind !== definition.kind || task.title !== definition.title ||
            task.description !== (definition.description ?? null) || task.priority !== (definition.priority ?? 0) ||
            task.order !== initialOrder.get(phase.taskId) || task.outputArtifactIds.length !== 0 ||
            toCanonicalJson(task.failure) !== toCanonicalJson(expectedFailure) ||
            toCanonicalJson(task.dependencies) !== toCanonicalJson(dependencies) ||
            toCanonicalJson(task.metadata) !== toCanonicalJson(definition.metadata ?? {}) || !validStatus) {
          throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted planning phase and task-graph projection differ.");
        }
      }
      const allContributions = snapshot.stagedContributions;
      const stagedByPhase = new Map<string, PlanningContribution>();
      const stagedIds = new Set<string>();
      const stagedResultIds = new Set<string>();
      for (const contribution of allContributions) {
        validateContribution(contribution, snapshot.planId);
        const phaseIndex = snapshot.phases.findIndex((phase) => phase.phaseId === contribution.phaseId);
        const phase = snapshot.phases[phaseIndex];
        if (phase === undefined) throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted contribution has no planning phase.");
        if (contribution.completedAt < snapshot.intent.createdAt || contribution.completedAt > snapshot.intent.deadline) {
          throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted contribution completion time is outside the plan window.");
        }
        const allocation = phaseBudgetAllocation(snapshot.intent, configuration, phaseIndex, snapshot.phases.length, phase.kind === "plan-synthesis");
        const rebuilt = buildContribution(snapshot.planId, phase, {
          phaseId: contribution.phaseId,
          resultId: contribution.resultId,
          attempt: contribution.attempt,
          inputDigest: contribution.inputDigest,
          schedulerTaskId: contribution.schedulerTaskId,
          schedulerIdempotencyKey: contribution.schedulerIdempotencyKey,
          route: contribution.route,
          sourceFingerprint: contribution.sourceFingerprint,
          completedAt: contribution.completedAt,
          usage: contribution.usage,
        }, contributionDraftProjection(contribution), configuration, allocation.maximumAttempts);
        if (toCanonicalJson({ ...rebuilt, applied: contribution.applied }) !== toCanonicalJson(contribution)) {
          throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted contribution does not rebuild exactly from bounded evidence and content.");
        }
      }
      for (const contribution of allContributions) {
        if (stagedByPhase.has(contribution.phaseId) || stagedIds.has(contribution.contributionId) || stagedResultIds.has(contribution.resultId)) {
          throw new PlanningError("PERSISTENCE_MISMATCH", "A persisted planning phase has multiple staged results.");
        }
        stagedByPhase.set(contribution.phaseId, contribution);
        stagedIds.add(contribution.contributionId);
        stagedResultIds.add(contribution.resultId);
      }
      assertCumulativeContributionLimits(allContributions, snapshot.intent, configuration, "PERSISTENCE_MISMATCH");
      if (toCanonicalJson(allContributions.map((item) => item.contributionId)) !==
          toCanonicalJson([...allContributions].map((item) => item.contributionId).sort(comparePlanningText))) {
        throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted staged contribution ordering is non-canonical.");
      }
      if (new Set(snapshot.contributions.map((item) => item.contributionId)).size !== snapshot.contributions.length) {
        throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted applied contributions contain duplicate identities.");
      }
      for (const contribution of snapshot.contributions) {
        validateContribution(contribution, snapshot.planId);
        const staged = allContributions.find((item) => item.contributionId === contribution.contributionId);
        if (!contribution.applied || staged === undefined || toCanonicalJson(staged) !== toCanonicalJson(contribution)) {
          throw new PlanningError("PERSISTENCE_MISMATCH", "Applied contribution staging linkage is invalid.");
        }
      }
      const appliedIds = new Set(snapshot.contributions.map((item) => item.contributionId));
      if (allContributions.some((item) => item.applied !== appliedIds.has(item.contributionId)) ||
          toCanonicalJson(snapshot.contributions.map((item) => item.contributionId)) !==
            toCanonicalJson([...snapshot.contributions].map((item) => item.contributionId).sort(comparePlanningText))) {
        throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted applied contribution projection is non-canonical.");
      }
      const decisionIds = new Set<string>();
      const finalRequirementWithoutDecisions = new Map(
        rebuildRequirements(snapshot.planId, snapshot.contributions, []).map((requirement) => [requirement.requirementId, requirement]),
      );
      const currentByRequirement = new Map<string, ScopeDecision>();
      const decisionVersions = new Set<number>();
      for (const decision of [...snapshot.decisions].sort((left, right) => left.planVersion - right.planVersion)) {
        validateDecision(decision, snapshot.planId);
        const priorDecision = currentByRequirement.get(decision.requirementId) ?? null;
        const finalRequirement = finalRequirementWithoutDecisions.get(decision.requirementId);
        const proposedBlockedAtKnownDigest = finalRequirement?.requirementDigest === decision.requirementDigest &&
          finalRequirement.proposedDispositions.includes("blocked") && decision.disposition !== "blocked";
        if (decision.decidedAt < snapshot.intent.createdAt || decision.decidedAt > snapshot.intent.deadline ||
            (priorDecision?.disposition === "blocked" || proposedBlockedAtKnownDigest) && decision.approvalReference === null) {
          throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted scope decision violates its plan window or escalation policy.");
        }
        if (decisionIds.has(decision.decisionId) || decisionVersions.has(decision.planVersion) ||
            decision.planVersion > snapshot.aggregateVersion ||
            decision.supersedesDecisionId !== (priorDecision?.decisionId ?? null)) {
          throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted scope-decision chain is duplicated or branched.");
        }
        decisionIds.add(decision.decisionId);
        decisionVersions.add(decision.planVersion);
        currentByRequirement.set(decision.requirementId, decision);
      }
      for (const phase of snapshot.phases) {
        const staged = stagedByPhase.get(phase.phaseId);
        const applied = phase.contributionId === null
          ? null
          : snapshot.contributions.find((item) => item.contributionId === phase.contributionId) ?? null;
        if ((staged === undefined) !== (phase.resultId === null) ||
            staged !== undefined && staged.resultId !== phase.resultId ||
            (applied === null) !== (phase.contributionId === null) ||
            applied !== null && (staged?.contributionId !== applied.contributionId || !applied.applied) ||
            phase.status === "completed" && applied === null ||
            phase.status === "running" && staged === undefined ||
            phase.status === "failed" && staged !== undefined ||
            staged === undefined && phase.attempt !== 0 ||
            staged !== undefined && phase.attempt !== staged.attempt ||
            phase.status === "running" && applied !== null && phase.kind !== "plan-synthesis" ||
            phase.status === "cancelled" && applied !== null && phase.kind !== "plan-synthesis" ||
            phase.kind === "plan-synthesis" && (phase.status === "completed") !== (snapshot.specification !== null) ||
            phase.status === "queued" && staged !== undefined) {
          throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted phase, result, and contribution links are inconsistent.");
        }
      }
      const projected = rebuildRequirements(snapshot.planId, snapshot.contributions, snapshot.decisions);
      if (snapshot.decisions.some((decision) => !projected.some((requirement) => requirement.requirementId === decision.requirementId))) {
        throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted scope decision refers to no durable requirement.");
      }
      if (toCanonicalJson(projected) !== toCanonicalJson(snapshot.requirements)) {
        throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted requirement projection does not replay exactly.");
      }
      const expectedReservation = Object.freeze({
        reservationId: stablePlanningId("planning-reservation", snapshot.planId, snapshot.intent.intentDigest),
        planId: snapshot.planId,
        preview: snapshot.intent.budget,
        status: "intended" as const,
      });
      if (toCanonicalJson(snapshot.reservationIntent) !== toCanonicalJson(expectedReservation)) {
        throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted planning reservation intent is inconsistent.");
      }
      let expectedRequirementTaskIds: string[] = [];
      if (snapshot.specification !== null) {
        assertExactObjectKeys(snapshot.specification, [
          "schemaVersion", "specificationId", "planId", "planVersion", "intentDigest", "decisionSetDigest", "requirements",
          "findingIds", "questionIds", "dissentIds", "approvedBy", "approvalReference", "approvedAt", "approvalDigest",
        ], "Persisted product specification");
        assertExactObjectKeys(snapshot.specification.approvedBy, ["actorId", "authority"], "Persisted specification actor");
        parseApproveSpecificationInput({
          expectedPlanVersion: Math.max(1, snapshot.specification.planVersion - 1),
          decisionSetDigest: snapshot.specification.decisionSetDigest,
          actor: snapshot.specification.approvedBy,
          approvalReference: snapshot.specification.approvalReference,
          approvedAt: snapshot.specification.approvedAt,
        });
        if (snapshot.specification.schemaVersion !== PRODUCT_PLANNING_SCHEMA_VERSION ||
            !["operator", "product-owner"].includes(snapshot.specification.approvedBy.authority) ||
            snapshot.specification.approvedAt < snapshot.intent.createdAt ||
            snapshot.specification.approvedAt > snapshot.intent.deadline || snapshot.requirements.length === 0 ||
            snapshot.phases.some((phase) => phase.status !== "completed")) {
          throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted specification approval authority is invalid.");
        }
        const { approvalDigest, ...payload } = snapshot.specification;
        const currentDecisions = currentDecisionByRequirement(snapshot.decisions);
        const expectedSpecificationRequirements = snapshot.requirements.map((requirement) => {
          const decision = currentDecisions.get(requirement.requirementId);
          if (decision === undefined || decision.decisionId !== requirement.currentDecisionId ||
              decision.requirementDigest !== requirement.requirementDigest || decision.disposition === "blocked") {
            throw new PlanningError("PERSISTENCE_MISMATCH", "Approved requirement has no exact current non-blocked decision.");
          }
          return Object.freeze({
            requirementId: requirement.requirementId,
            requirementDigest: requirement.requirementDigest,
            title: requirement.title,
            category: requirement.category,
            disposition: decision.disposition,
            decisionId: decision.decisionId,
            candidateIds: requirement.candidateIds,
            provenance: requirement.provenance,
            dissentIds: requirement.dissentIds,
          });
        });
        const expectedCoverage = snapshot.requirements.map((requirement) => {
          const decision = currentDecisions.get(requirement.requirementId)!;
          const executable = assertExecutableDisposition(decision.disposition);
          return Object.freeze({
            requirementId: requirement.requirementId,
            requirementDigest: requirement.requirementDigest,
            decisionId: decision.decisionId,
            disposition: decision.disposition,
            executable,
            taskId: executable ? stablePlanningId("requirement-task", snapshot.planId, requirement.requirementId, requirement.requirementDigest) : null,
          });
        });
        const executableRequirements = snapshot.requirements.filter((requirement) =>
          assertExecutableDisposition(currentDecisions.get(requirement.requirementId)!.disposition));
        const executableByKey = new Map(executableRequirements.map((requirement) => [requirement.normalizedKey, requirement]));
        expectedRequirementTaskIds = executableRequirements.map((requirement) =>
          stablePlanningId("requirement-task", snapshot.planId, requirement.requirementId, requirement.requirementDigest));
        const synthesis = snapshot.phases.find((phase) => phase.kind === "plan-synthesis")!;
        for (const [requirementTaskIndex, coverage] of expectedCoverage.filter((item) => item.executable).entries()) {
          const requirement = snapshot.requirements.find((item) => item.requirementId === coverage.requirementId)!;
          const task = graph.getTask(coverage.taskId!);
          const dependencyIds = requirement.dependencyKeys.map((key) => {
            const dependency = executableByKey.get(key);
            if (dependency === undefined) throw new PlanningError("PERSISTENCE_MISMATCH", "Approved requirement task has an absent or non-executable dependency.");
            return stablePlanningId("requirement-task", snapshot.planId, dependency.requirementId, dependency.requirementDigest);
          });
          if (task.kind !== "product-requirement" || task.title !== requirement.title ||
              task.description !== null || task.priority !== 0 ||
              task.order !== initialDefinitionList.length + requirementTaskIndex ||
              !["pending", "ready"].includes(task.status) || task.blockedBy.length !== 0 ||
              task.outputArtifactIds.length !== 0 || task.failure !== null ||
              toCanonicalJson(task.dependencies) !== toCanonicalJson([synthesis.taskId, ...dependencyIds]) ||
              toCanonicalJson(task.metadata) !== toCanonicalJson({
                planId: snapshot.planId,
                requirementId: requirement.requirementId,
                requirementDigest: requirement.requirementDigest,
                decisionId: coverage.decisionId,
              })) {
            throw new PlanningError("PERSISTENCE_MISMATCH", "Approved requirement task projection is inconsistent.");
          }
        }
        const expectedUsage = sumUsage(snapshot.contributions.map((contribution) => contribution.usage));
        const expectedReconciliation = Object.freeze({
          reconciliationId: stablePlanningId("planning-reconciliation", snapshot.planId, snapshot.reservationIntent.reservationId, approvalDigest),
          planId: snapshot.planId,
          reservationId: snapshot.reservationIntent.reservationId,
          usage: expectedUsage,
          costKnown: snapshot.contributions.every((contribution) => contribution.usage.costMicros !== null),
          status: "intended" as const,
        });
        if (planningDigest(specificationPayload(payload)) !== approvalDigest || snapshot.specification.planId !== snapshot.planId ||
            snapshot.specification.planVersion !== snapshot.aggregateVersion || snapshot.specification.intentDigest !== snapshot.intent.intentDigest ||
            snapshot.specification.decisionSetDigest !== decisionSetDigest(snapshot.decisions) ||
            snapshot.specification.specificationId !== stablePlanningId("product-specification", snapshot.planId, snapshot.intent.intentDigest, snapshot.specification.decisionSetDigest) ||
            toCanonicalJson(snapshot.specification.requirements) !== toCanonicalJson(expectedSpecificationRequirements) ||
            toCanonicalJson(snapshot.specification.findingIds) !== toCanonicalJson(snapshot.contributions.flatMap((contribution) => contribution.findings.map((finding) => finding.findingId)).sort()) ||
            toCanonicalJson(snapshot.specification.questionIds) !== toCanonicalJson(snapshot.contributions.flatMap((contribution) => contribution.unresolvedQuestions.map((question) => question.questionId)).sort()) ||
            toCanonicalJson(snapshot.specification.dissentIds) !== toCanonicalJson(snapshot.contributions.flatMap((contribution) => contribution.dissent.map((dissent) => dissent.dissentId)).sort()) ||
            toCanonicalJson(snapshot.coverage) !== toCanonicalJson(expectedCoverage) ||
            toCanonicalJson(snapshot.reconciliationIntent) !== toCanonicalJson(expectedReconciliation)) {
          throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted approved specification or coverage digest mismatch.");
        }
      } else if (snapshot.coverage.length !== 0 || snapshot.reconciliationIntent !== null) {
        throw new PlanningError("PERSISTENCE_MISMATCH", "Unapproved plan contains approval-only projections.");
      }
      const expectedTaskIds = [...initialDefinitionList.map((definition) => definition.id), ...expectedRequirementTaskIds]
        .sort(comparePlanningText);
      const actualTaskIds = graph.toSnapshot().tasks.map((task) => task.id).sort(comparePlanningText);
      if (toCanonicalJson(actualTaskIds) !== toCanonicalJson(expectedTaskIds)) {
        throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted product graph contains missing or extraneous tasks.");
      }
      return new ProductPlan({ configuration, clock, snapshot, graph });
    } catch (error) {
      if (error instanceof PlanningError && error.code === "PERSISTENCE_MISMATCH") throw error;
      if (error instanceof PlanningError) {
        throw new PlanningError("PERSISTENCE_MISMATCH", "Product-plan snapshot violates a command invariant.", {
          causeCode: error.code,
        });
      }
      throw new PlanningError("PERSISTENCE_MISMATCH", "Product-plan snapshot validation failed closed.", {
        causeName: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  get planId(): string { return this.#intent.planId; }
  get version(): number { return this.#aggregateVersion; }
  get eventSequence(): number { return this.#eventSequence; }

  toSnapshot(): ProductPlanSnapshot {
    return Object.freeze({
      schemaVersion: PRODUCT_PLANNING_SCHEMA_VERSION,
      planId: this.planId,
      aggregateVersion: this.#aggregateVersion,
      eventSequence: this.#eventSequence,
      intent: this.#intent,
      configurationFingerprint: this.#configuration.configurationFingerprint,
      phases: Object.freeze([...this.#phases]),
      stagedContributions: Object.freeze([...this.#stagedContributions]),
      contributions: Object.freeze([...this.#contributions]),
      requirements: Object.freeze([...this.#requirements]),
      decisions: Object.freeze([...this.#decisions]),
      specification: this.#specification,
      coverage: Object.freeze([...this.#coverage]),
      reservationIntent: this.#reservationIntent,
      reconciliationIntent: this.#reconciliationIntent,
      taskGraph: this.#graph.toSnapshot(),
      createdAt: this.#createdAt,
      updatedAt: this.#updatedAt,
    });
  }

  peekChanges(): PendingPlanningChanges {
    return Object.freeze({
      planningEvents: Object.freeze([...this.#pendingEvents]),
      taskGraphEvents: Object.freeze([...this.#pendingGraphEvents]),
    });
  }

  acknowledgeChanges(): void {
    this.#pendingEvents = [];
    this.#pendingGraphEvents = [];
  }

  stageContribution(evidence: PlanningContributionEvidence, draft: unknown): PlanningContribution {
    if (this.#specification !== null) throw new PlanningError("INVALID_TRANSITION", "An approved plan accepts no later contributions.");
    const phase = this.#phases.find((item) => item.phaseId === evidence.phaseId);
    if (phase === undefined) throw new PlanningError("NOT_FOUND", "Contribution phase does not exist.");
    const phaseIndex = this.#phases.findIndex((item) => item.phaseId === phase.phaseId);
    const allocation = phaseBudgetAllocation(
      this.#intent,
      this.#configuration,
      phaseIndex,
      this.#phases.length,
      phase.kind === "plan-synthesis",
    );
    const contribution = buildContribution(this.planId, phase, evidence, draft, this.#configuration, allocation.maximumAttempts);
    const duplicate = this.#stagedContributions.find((item) => item.contributionId === contribution.contributionId || item.resultId === contribution.resultId);
    if (duplicate !== undefined) {
      if (duplicate.contributionDigest === contribution.contributionDigest) return duplicate;
      throw new PlanningError("CONFLICT", "A contribution or provider result identity was reused with different content.");
    }
    if (phase.contributionId !== null || phase.status === "completed" || phase.status === "cancelled" || phase.status === "failed") {
      throw new PlanningError("INVALID_TRANSITION", "Planning phase no longer accepts a contribution.");
    }
    const priorForPhase = this.#stagedContributions.find((item) => item.phaseId === phase.phaseId);
    if (priorForPhase !== undefined || phase.resultId !== null) {
      throw new PlanningError("CONFLICT", "A planning phase already has a different durable staged result.");
    }
    if (evidence.attempt < phase.attempt || evidence.completedAt < this.#intent.createdAt || evidence.completedAt > this.#intent.deadline) {
      throw new PlanningError("CONFLICT", "Contribution attempt or completion time is stale or outside the plan.");
    }
    assertCumulativeContributionLimits(
      [...this.#stagedContributions, contribution],
      this.#intent,
      this.#configuration,
      "LIMIT_EXCEEDED",
    );
    const before = planningDigest(this.toSnapshot());
    this.#stagedContributions = [...this.#stagedContributions, contribution]
      .sort((left, right) => comparePlanningText(left.contributionId, right.contributionId));
    this.#phases = this.#phases.map((item) => item.phaseId === phase.phaseId
      ? Object.freeze({ ...item, status: "running" as const, attempt: evidence.attempt, resultId: evidence.resultId })
      : item);
    this.#commit("contribution.staged", evidence.completedAt, before);
    return contribution;
  }

  applyStagedContribution(contributionId: string, expectedPlanVersion: number): PlanningContribution {
    const existing = this.#contributions.find((item) => item.contributionId === contributionId);
    if (existing !== undefined) return existing;
    this.#assertVersion(expectedPlanVersion);
    const staged = this.#stagedContributions.find((item) => item.contributionId === contributionId);
    if (staged === undefined) throw new PlanningError("NOT_FOUND", "Staged contribution does not exist.");
    const phase = this.#phases.find((item) => item.phaseId === staged.phaseId)!;
    if (phase.resultId !== staged.resultId || phase.contributionId !== null) throw new PlanningError("CONFLICT", "Staged result no longer matches its phase checkpoint.");
    const before = planningDigest(this.toSnapshot());
    const graph = TaskGraph.hydrate(this.#graph.toSnapshot(), { clock: () => this.#clock.now() });
    if (graph.getTask(phase.taskId).status !== "ready") {
      throw new PlanningError("INVALID_TRANSITION", "A reordered phase result cannot apply before its dependencies complete.", { phaseId: phase.phaseId });
    }
    graph.startTask(phase.taskId);
    if (phase.kind !== "plan-synthesis") graph.succeedTask(phase.taskId);
    assertCombinedGraphBounds(graph.toSnapshot(), this.#configuration);
    const applied = Object.freeze({ ...staged, applied: true });
    const nextContributions = [...this.#contributions, applied]
      .sort((left, right) => comparePlanningText(left.contributionId, right.contributionId));
    const nextRequirements = rebuildRequirements(this.planId, nextContributions, this.#decisions);
    if (nextRequirements.length > this.#configuration.limits.maximumCandidateRequirements) {
      throw new PlanningError("LIMIT_EXCEEDED", "Deduplicated requirements exceed their configured bound.");
    }
    const graphEvents = graph.peekEvents();
    graph.acknowledgeEvents(graph.eventSequence);
    this.#graph = graph;
    this.#pendingGraphEvents.push(...graphEvents);
    this.#contributions = nextContributions;
    this.#requirements = [...nextRequirements];
    this.#stagedContributions = this.#stagedContributions.map((item) => item.contributionId === contributionId ? applied : item);
    this.#phases = this.#phases.map((item) => item.phaseId === phase.phaseId
      ? Object.freeze({ ...item, status: phase.kind === "plan-synthesis" ? "running" as const : "completed" as const, contributionId })
      : item);
    this.#commit("contribution.applied", staged.completedAt, before);
    return applied;
  }

  decideScope(value: ScopeDecisionInput): ScopeDecision {
    const input = parseScopeDecisionInput(value);
    const requirement = this.#requirements.find((item) => item.requirementId === input.requirementId);
    if (requirement === undefined) throw new PlanningError("NOT_FOUND", "Scope decision requirement does not exist.");
    if (requirement.requirementDigest !== input.requirementDigest) throw new PlanningError("CONFLICT", "Scope decision uses a stale requirement digest.");
    const current = requirement.currentDecisionId === null ? null : this.#decisions.find((item) => item.decisionId === requirement.currentDecisionId) ?? null;
    const nextVersion = this.#aggregateVersion + 1;
    const withoutDigest = Object.freeze({
      decisionId: stablePlanningId(
        "scope-decision", this.planId, input.requirementId, input.requirementDigest, input.disposition,
        input.actor.actorId, input.actor.authority, input.reason, input.approvalReference ?? "none", input.decidedAt,
      ),
      planId: this.planId,
      planVersion: nextVersion,
      requirementId: input.requirementId,
      requirementDigest: input.requirementDigest,
      disposition: input.disposition,
      actor: input.actor,
      reason: input.reason,
      approvalReference: input.approvalReference,
      decidedAt: input.decidedAt,
      supersedesDecisionId: current?.decisionId ?? null,
    });
    const decision = Object.freeze({ ...withoutDigest, decisionDigest: planningDigest(decisionPayload(withoutDigest)) });
    const duplicate = this.#decisions.find((item) => item.decisionId === decision.decisionId);
    if (duplicate !== undefined) return duplicate;
    this.#assertVersion(input.expectedPlanVersion);
    if (this.#specification !== null) throw new PlanningError("INVALID_TRANSITION", "Approved scope is immutable.");
    if (input.decidedAt < this.#intent.createdAt || input.decidedAt > this.#intent.deadline) throw new PlanningError("INVALID_INPUT", "Scope-decision time is outside the plan window.");
    const approvalRequired = assertExecutableDisposition(input.disposition) || input.disposition === "waived" ||
      current?.disposition === "blocked" ||
      requirement.proposedDispositions.includes("blocked") && input.disposition !== "blocked";
    if (approvalRequired && input.approvalReference === null) throw new PlanningError("POLICY_DENIED", "This scope decision requires exact approval evidence.");
    if (assertExecutableDisposition(input.disposition) && !["operator", "product-owner"].includes(input.actor.authority)) {
      throw new PlanningError("POLICY_DENIED", "Only operator or product-owner authority may promote executable scope.");
    }
    if (input.disposition === "waived" && !["operator", "security-reviewer"].includes(input.actor.authority)) {
      throw new PlanningError("POLICY_DENIED", "Only operator or security-reviewer authority may waive scope.");
    }
    if (input.actor.authority === "deterministic-rule" && !["duplicate", "superseded"].includes(input.disposition)) {
      throw new PlanningError("POLICY_DENIED", "Deterministic rules cannot promote, reject, block, or waive scope.");
    }
    const before = planningDigest(this.toSnapshot());
    this.#decisions = [...this.#decisions, decision];
    this.#requirements = [...rebuildRequirements(this.planId, this.#contributions, this.#decisions)];
    this.#commit("scope.decided", input.decidedAt, before);
    return decision;
  }

  currentDecisionSetDigest(): string {
    return decisionSetDigest(this.#decisions);
  }

  approveSpecification(value: ApproveSpecificationInput): ProductSpecification {
    const input = parseApproveSpecificationInput(value);
    if (this.#specification !== null) {
      if (this.#specification.decisionSetDigest === input.decisionSetDigest &&
          this.#specification.approvalReference === input.approvalReference &&
          this.#specification.approvedBy.actorId === input.actor.actorId &&
          this.#specification.approvedBy.authority === input.actor.authority &&
          this.#specification.approvedAt === input.approvedAt) return this.#specification;
      throw new PlanningError("CONFLICT", "An approved specification cannot be replaced.");
    }
    this.#assertVersion(input.expectedPlanVersion);
    if (!["operator", "product-owner"].includes(input.actor.authority)) throw new PlanningError("POLICY_DENIED", "Specification approval requires operator or product-owner authority.");
    if (input.approvedAt < this.#intent.createdAt || input.approvedAt > this.#intent.deadline) throw new PlanningError("INVALID_INPUT", "Specification approval time is outside the plan window.");
    const currentDigest = this.currentDecisionSetDigest();
    if (input.decisionSetDigest !== currentDigest) throw new PlanningError("CONFLICT", "Specification approval uses a stale decision-set digest.");
    if (this.#requirements.length === 0) throw new PlanningError("INVALID_TRANSITION", "An empty product scope cannot be approved.");
    const current = currentDecisionByRequirement(this.#decisions);
    for (const requirement of this.#requirements) {
      const decision = current.get(requirement.requirementId);
      if (decision === undefined || decision.decisionId !== requirement.currentDecisionId || decision.requirementDigest !== requirement.requirementDigest) {
        throw new PlanningError("INVALID_TRANSITION", "Every requirement needs one current digest-bound scope decision.");
      }
      if (decision.disposition === "blocked") throw new PlanningError("INVALID_TRANSITION", "Blocked scope cannot enter an approved specification.");
    }
    const synthesis = this.#phases.find((phase) => phase.kind === "plan-synthesis")!;
    if (synthesis.status !== "running" || synthesis.contributionId === null ||
        this.#phases.some((phase) => phase.kind !== "plan-synthesis" && phase.status !== "completed")) {
      throw new PlanningError("INVALID_TRANSITION", "All planning phases and synthesis contribution must complete before approval.");
    }
    const executable = this.#requirements.filter((requirement) => {
      const decision = current.get(requirement.requirementId)!;
      return assertExecutableDisposition(decision.disposition);
    });
    for (const requirement of executable) {
      if (requirement.dependencyKeys.length > this.#configuration.limits.maximumDependencyFanOut) {
        throw new PlanningError("LIMIT_EXCEEDED", "Requirement dependency fan-out exceeds its bound.");
      }
    }
    assertGraphDepth(executable, this.#configuration.limits.maximumGraphDepth);
    if (this.#graph.size + executable.length > this.#configuration.limits.maximumGraphNodes) {
      throw new PlanningError("LIMIT_EXCEEDED", "Compiled planning graph would exceed its node bound.");
    }
    const byKey = new Map(executable.map((requirement) => [requirement.normalizedKey, requirement]));
    const taskIdByRequirement = new Map(executable.map((requirement) => [
      requirement.requirementId,
      stablePlanningId("requirement-task", this.planId, requirement.requirementId, requirement.requirementDigest),
    ]));
    const definitions: TaskDefinition[] = executable.map((requirement) => {
      const dependencyIds = requirement.dependencyKeys.map((key) => {
        const dependency = byKey.get(key);
        if (dependency === undefined) throw new PlanningError("INVALID_INPUT", "Executable requirement depends on absent or non-executable scope.", { dependencyKey: key });
        return taskIdByRequirement.get(dependency.requirementId)!;
      });
      return {
        id: taskIdByRequirement.get(requirement.requirementId)!,
        kind: "product-requirement",
        title: requirement.title,
        dependencies: [synthesis.taskId, ...dependencyIds],
        metadata: {
          planId: this.planId,
          requirementId: requirement.requirementId,
          requirementDigest: requirement.requirementDigest,
          decisionId: current.get(requirement.requirementId)!.decisionId,
        },
      };
    });
    const graph = TaskGraph.hydrate(this.#graph.toSnapshot(), { clock: () => this.#clock.now() });
    if (definitions.length > 0) graph.appendTasks(definitions);
    graph.succeedTask(synthesis.taskId);
    assertCombinedGraphBounds(graph.toSnapshot(), this.#configuration);
    const coverage: RequirementTaskCoverage[] = this.#requirements.map((requirement) => {
      const decision = current.get(requirement.requirementId)!;
      const executableDecision = assertExecutableDisposition(decision.disposition);
      return Object.freeze({
        requirementId: requirement.requirementId,
        requirementDigest: requirement.requirementDigest,
        decisionId: decision.decisionId,
        disposition: decision.disposition,
        executable: executableDecision,
        taskId: executableDecision ? taskIdByRequirement.get(requirement.requirementId)! : null,
      });
    });
    const requirements: ProductSpecificationRequirement[] = this.#requirements.map((requirement) => {
      const decision = current.get(requirement.requirementId)!;
      return Object.freeze({
        requirementId: requirement.requirementId,
        requirementDigest: requirement.requirementDigest,
        title: requirement.title,
        category: requirement.category,
        disposition: decision.disposition,
        decisionId: decision.decisionId,
        candidateIds: requirement.candidateIds,
        provenance: requirement.provenance,
        dissentIds: requirement.dissentIds,
      });
    });
    const nextVersion = this.#aggregateVersion + 1;
    const withoutDigest = Object.freeze({
      schemaVersion: PRODUCT_PLANNING_SCHEMA_VERSION,
      specificationId: stablePlanningId("product-specification", this.planId, this.#intent.intentDigest, currentDigest),
      planId: this.planId,
      planVersion: nextVersion,
      intentDigest: this.#intent.intentDigest,
      decisionSetDigest: currentDigest,
      requirements: Object.freeze(requirements),
      findingIds: Object.freeze(this.#contributions.flatMap((contribution) => contribution.findings.map((finding) => finding.findingId)).sort()),
      questionIds: Object.freeze(this.#contributions.flatMap((contribution) => contribution.unresolvedQuestions.map((question) => question.questionId)).sort()),
      dissentIds: Object.freeze(this.#contributions.flatMap((contribution) => contribution.dissent.map((dissent) => dissent.dissentId)).sort()),
      approvedBy: input.actor,
      approvalReference: input.approvalReference,
      approvedAt: input.approvedAt,
    });
    const specification = Object.freeze({ ...withoutDigest, approvalDigest: planningDigest(specificationPayload(withoutDigest)) });
    const usage = sumUsage(this.#contributions.map((contribution) => contribution.usage));
    const reconciliationIntent = Object.freeze({
      reconciliationId: stablePlanningId("planning-reconciliation", this.planId, this.#reservationIntent.reservationId, specification.approvalDigest),
      planId: this.planId,
      reservationId: this.#reservationIntent.reservationId,
      usage,
      costKnown: this.#contributions.every((contribution) => contribution.usage.costMicros !== null),
      status: "intended" as const,
    });
    const before = planningDigest(this.toSnapshot());
    const graphEvents = graph.peekEvents();
    graph.acknowledgeEvents(graph.eventSequence);
    this.#graph = graph;
    this.#pendingGraphEvents.push(...graphEvents);
    this.#coverage = coverage;
    this.#specification = specification;
    this.#reconciliationIntent = reconciliationIntent;
    this.#phases = this.#phases.map((phase) => phase.phaseId === synthesis.phaseId
      ? Object.freeze({ ...phase, status: "completed" as const })
      : phase);
    this.#commit("specification.approved", input.approvedAt, before);
    return specification;
  }

  cancel(reason: string, expectedPlanVersion: number): void {
    const normalizedReason = typeof reason === "string" ? reason.normalize("NFKC").trim().replace(/\s+/g, " ") : "";
    if (normalizedReason.length < 1 || normalizedReason.length > 2_000) throw new PlanningError("INVALID_INPUT", "Cancellation reason is outside its bound.");
    if (this.#specification !== null || this.#phases.every((phase) =>
      phase.status === "completed" || phase.status === "cancelled" || phase.status === "failed")) return;
    this.#assertVersion(expectedPlanVersion);
    const occurredAt = this.#now();
    const before = planningDigest(this.toSnapshot());
    const graph = TaskGraph.hydrate(this.#graph.toSnapshot(), { clock: () => new Date(occurredAt) });
    graph.cancelRemaining({ reason: normalizedReason });
    const graphEvents = graph.peekEvents();
    graph.acknowledgeEvents(graph.eventSequence);
    this.#graph = graph;
    this.#pendingGraphEvents.push(...graphEvents);
    this.#phases = this.#phases.map((phase) => phase.status === "completed" || phase.status === "failed"
      ? phase
      : Object.freeze({ ...phase, status: "cancelled" as const }));
    this.#commit("plan.cancelled", occurredAt, before);
  }

  failPhase(phaseId: string, failureCode: string, expectedPlanVersion: number): void {
    const phase = this.#phases.find((item) => item.phaseId === phaseId);
    if (phase === undefined) throw new PlanningError("NOT_FOUND", "Planning phase does not exist.", { phaseId });
    const code = typeof failureCode === "string" ? failureCode.normalize("NFKC").trim().toLocaleLowerCase("en-US") : "";
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(code)) throw new PlanningError("INVALID_INPUT", "Planning failure code is invalid.");
    if (phase.status === "failed") {
      if (phase.failureCode === code) return;
      throw new PlanningError("CONFLICT", "Planning phase already has a different terminal failure.");
    }
    this.#assertVersion(expectedPlanVersion);
    if (this.#specification !== null || phase.status === "completed" || phase.status === "cancelled" || phase.resultId !== null) {
      throw new PlanningError("INVALID_TRANSITION", "Planning phase cannot transition to failed.");
    }
    const occurredAt = this.#now();
    const before = planningDigest(this.toSnapshot());
    const graph = TaskGraph.hydrate(this.#graph.toSnapshot(), { clock: () => new Date(occurredAt) });
    graph.failTask(phase.taskId, {
      code: "PLANNING_PHASE_FAILED",
      message: "The bounded planning phase failed.",
      retryable: false,
    }, { reason: code });
    const graphEvents = graph.peekEvents();
    graph.acknowledgeEvents(graph.eventSequence);
    this.#graph = graph;
    this.#pendingGraphEvents.push(...graphEvents);
    this.#phases = this.#phases.map((item) => {
      const graphStatus = graph.getTask(item.taskId).status;
      if (item.phaseId === phaseId) return Object.freeze({ ...item, status: "failed" as const, failureCode: code });
      if (item.status !== "completed" && (graphStatus === "blocked" || graphStatus === "cancelled")) {
        return Object.freeze({ ...item, status: "cancelled" as const });
      }
      return item;
    });
    this.#commit("plan.failed", occurredAt, before);
  }

  #assertVersion(expected: number): void {
    if (!Number.isSafeInteger(expected) || expected !== this.#aggregateVersion) {
      throw new PlanningError("CONCURRENCY_CONFLICT", "Planning aggregate version is stale.", {
        expectedVersion: Number.isSafeInteger(expected) ? expected : -1,
        actualVersion: this.#aggregateVersion,
      });
    }
  }

  #now(): string {
    const now = this.#clock.now();
    if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new PlanningError("INVALID_INPUT", "Planning clock returned an invalid instant.");
    const timestamp = now.toISOString();
    if (timestamp < this.#updatedAt) throw new PlanningError("INVALID_INPUT", "Planning clock moved backwards.");
    return timestamp;
  }

  #commit(type: PlanningEventType, occurredAt: string, beforeDigest: string): void {
    if (this.#aggregateVersion >= Number.MAX_SAFE_INTEGER || this.#eventSequence >= Number.MAX_SAFE_INTEGER) {
      throw new PlanningError("LIMIT_EXCEEDED", "Planning aggregate counters are exhausted.");
    }
    if (occurredAt < this.#updatedAt) throw new PlanningError("INVALID_INPUT", "Planning event time moved backwards.");
    this.#aggregateVersion += 1;
    this.#eventSequence += 1;
    this.#updatedAt = occurredAt;
    const snapshot = this.toSnapshot();
    const afterDigest = planningDigest(snapshot);
    this.#pendingEvents.push(Object.freeze({
      schemaVersion: PRODUCT_PLANNING_SCHEMA_VERSION,
      eventId: stablePlanningId("planning-event", this.planId, String(this.#eventSequence), afterDigest),
      planId: this.planId,
      sequence: this.#eventSequence,
      aggregateVersion: this.#aggregateVersion,
      type,
      occurredAt,
      beforeDigest,
      afterDigest,
      snapshot,
    }));
  }
}

function samePlanningProjection(left: unknown, right: unknown): boolean {
  return planningDigest(left) === planningDigest(right);
}

function assertUnchangedPlanningFields(
  before: ProductPlanSnapshot,
  after: ProductPlanSnapshot,
  fields: readonly (keyof ProductPlanSnapshot)[],
): void {
  for (const field of fields) {
    if (!samePlanningProjection(before[field], after[field])) {
      throw new PlanningError("PERSISTENCE_MISMATCH", `Planning event rewrote unrelated '${field}' state.`);
    }
  }
}

function assertPriorItemsUnchanged<T>(
  before: readonly T[],
  after: readonly T[],
  identity: (value: T) => string,
  exceptId: string | null = null,
): void {
  for (const prior of before) {
    const id = identity(prior);
    if (id === exceptId) continue;
    const next = after.find((item) => identity(item) === id);
    if (next === undefined || !samePlanningProjection(prior, next)) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Planning event rewrote or removed prior collection state.");
    }
  }
}

function assertExactPlanningEventDelta(
  type: PlanningEventType,
  before: ProductPlanSnapshot | null,
  after: ProductPlanSnapshot,
): void {
  if (before === null) {
    if (type !== "plan.accepted" || after.aggregateVersion !== 1 || after.eventSequence !== 1 ||
        after.updatedAt !== after.intent.createdAt || after.createdAt !== after.intent.createdAt ||
        after.stagedContributions.length !== 0 || after.contributions.length !== 0 ||
        after.requirements.length !== 0 || after.decisions.length !== 0 || after.specification !== null ||
        after.coverage.length !== 0 || after.reconciliationIntent !== null ||
        after.taskGraph.version !== 2 ||
        after.phases.some((phase) => phase.status !== "queued" || phase.attempt !== 0 ||
          phase.resultId !== null || phase.contributionId !== null || phase.failureCode !== null)) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Initial planning checkpoint is not command-exact.");
    }
    return;
  }

  assertUnchangedPlanningFields(before, after, [
    "schemaVersion", "planId", "intent", "configurationFingerprint", "reservationIntent", "createdAt",
  ]);
  if (after.aggregateVersion !== before.aggregateVersion + 1 || after.eventSequence !== before.eventSequence + 1) {
    throw new PlanningError("PERSISTENCE_MISMATCH", "Planning event counters are not a single command delta.");
  }

  if (type === "contribution.staged") {
    assertUnchangedPlanningFields(before, after, [
      "contributions", "requirements", "decisions", "specification", "coverage", "reconciliationIntent", "taskGraph",
    ]);
    if (after.stagedContributions.length !== before.stagedContributions.length + 1) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Contribution-staged event has an invalid collection delta.");
    }
    assertPriorItemsUnchanged(before.stagedContributions, after.stagedContributions, (item) => item.contributionId);
    const beforeIds = new Set(before.stagedContributions.map((item) => item.contributionId));
    const added = after.stagedContributions.find((item) => !beforeIds.has(item.contributionId));
    if (added === undefined || added.applied || after.updatedAt !== added.completedAt) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Contribution-staged event did not add one exact pending result.");
    }
    const priorPhase = before.phases.find((phase) => phase.phaseId === added.phaseId);
    const nextPhase = after.phases.find((phase) => phase.phaseId === added.phaseId);
    if (priorPhase === undefined || nextPhase === undefined || priorPhase.status !== "queued" ||
        !samePlanningProjection(nextPhase, {
          ...priorPhase,
          status: "running",
          attempt: added.attempt,
          resultId: added.resultId,
        })) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Contribution-staged event has an inexact phase delta.");
    }
    assertPriorItemsUnchanged(before.phases, after.phases, (phase) => phase.phaseId, added.phaseId);
    return;
  }

  if (type === "contribution.applied") {
    assertUnchangedPlanningFields(before, after, ["decisions", "specification", "coverage", "reconciliationIntent"]);
    if (after.contributions.length !== before.contributions.length + 1 ||
        after.stagedContributions.length !== before.stagedContributions.length) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Contribution-applied event has an invalid collection delta.");
    }
    assertPriorItemsUnchanged(before.contributions, after.contributions, (item) => item.contributionId);
    const beforeIds = new Set(before.contributions.map((item) => item.contributionId));
    const applied = after.contributions.find((item) => !beforeIds.has(item.contributionId));
    const priorStaged = applied === undefined ? undefined : before.stagedContributions.find((item) => item.contributionId === applied.contributionId);
    const nextStaged = applied === undefined ? undefined : after.stagedContributions.find((item) => item.contributionId === applied.contributionId);
    if (applied === undefined || priorStaged === undefined || nextStaged === undefined || priorStaged.applied ||
        !samePlanningProjection(applied, { ...priorStaged, applied: true }) ||
        !samePlanningProjection(nextStaged, applied) || after.updatedAt !== applied.completedAt) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Contribution-applied event did not apply one exact staged result.");
    }
    const expectedGraphVersions = priorStaged.phaseId ===
      before.phases.find((phase) => phase.kind === "plan-synthesis")?.phaseId ? 1 : 2;
    if (after.taskGraph.version !== before.taskGraph.version + expectedGraphVersions) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Contribution-applied event has extra or missing task-graph command batches.");
    }
    assertPriorItemsUnchanged(before.stagedContributions, after.stagedContributions, (item) => item.contributionId, applied.contributionId);
    const priorPhase = before.phases.find((phase) => phase.phaseId === applied.phaseId);
    const nextPhase = after.phases.find((phase) => phase.phaseId === applied.phaseId);
    if (priorPhase === undefined || nextPhase === undefined || priorPhase.status !== "running" ||
        !samePlanningProjection(nextPhase, {
          ...priorPhase,
          status: priorPhase.kind === "plan-synthesis" ? "running" : "completed",
          contributionId: applied.contributionId,
        })) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Contribution-applied event has an inexact phase delta.");
    }
    assertPriorItemsUnchanged(before.phases, after.phases, (phase) => phase.phaseId, applied.phaseId);
    return;
  }

  if (type === "scope.decided") {
    assertUnchangedPlanningFields(before, after, [
      "phases", "stagedContributions", "contributions", "specification", "coverage", "reconciliationIntent", "taskGraph",
    ]);
    if (after.decisions.length !== before.decisions.length + 1) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Scope-decision event has an invalid collection delta.");
    }
    assertPriorItemsUnchanged(before.decisions, after.decisions, (decision) => decision.decisionId);
    const beforeIds = new Set(before.decisions.map((decision) => decision.decisionId));
    const added = after.decisions.find((decision) => !beforeIds.has(decision.decisionId));
    if (added === undefined || added.planVersion !== after.aggregateVersion || added.decidedAt !== after.updatedAt) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Scope-decision event did not append its exact versioned decision.");
    }
    return;
  }

  if (type === "specification.approved") {
    assertUnchangedPlanningFields(before, after, ["stagedContributions", "contributions", "requirements", "decisions"]);
    if (before.specification !== null || after.specification === null ||
        after.specification.approvedAt !== after.updatedAt || before.coverage.length !== 0 ||
        before.reconciliationIntent !== null) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Specification-approved event has an invalid approval delta.");
    }
    const expectedGraphVersions = after.coverage.some((item) => item.executable) ? 2 : 1;
    if (after.taskGraph.version !== before.taskGraph.version + expectedGraphVersions) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Specification-approved event has extra or missing task-graph command batches.");
    }
    const synthesisBefore = before.phases.find((phase) => phase.kind === "plan-synthesis");
    const synthesisAfter = after.phases.find((phase) => phase.kind === "plan-synthesis");
    if (synthesisBefore === undefined || synthesisAfter === undefined || synthesisBefore.status !== "running" ||
        !samePlanningProjection(synthesisAfter, { ...synthesisBefore, status: "completed" })) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Specification-approved event has an inexact synthesis delta.");
    }
    assertPriorItemsUnchanged(before.phases, after.phases, (phase) => phase.phaseId, synthesisBefore.phaseId);
    return;
  }

  if (type === "plan.failed") {
    assertUnchangedPlanningFields(before, after, [
      "stagedContributions", "contributions", "requirements", "decisions", "specification", "coverage", "reconciliationIntent",
    ]);
    const newlyFailed = after.phases.filter((phase) => phase.status === "failed" &&
      before.phases.find((prior) => prior.phaseId === phase.phaseId)?.status !== "failed");
    if (newlyFailed.length !== 1) throw new PlanningError("PERSISTENCE_MISMATCH", "Plan-failed event lacks one new failed phase.");
    if (after.taskGraph.version !== before.taskGraph.version + 1) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Plan-failed event has extra or missing task-graph command batches.");
    }
    for (const prior of before.phases) {
      const next = after.phases.find((phase) => phase.phaseId === prior.phaseId)!;
      if (next.phaseId === newlyFailed[0]!.phaseId) {
        if (prior.resultId !== null || next.failureCode === null ||
            !samePlanningProjection(next, { ...prior, status: "failed", failureCode: next.failureCode })) {
          throw new PlanningError("PERSISTENCE_MISMATCH", "Plan-failed event has an inexact terminal phase delta.");
        }
      } else if (!samePlanningProjection(prior, next) &&
          !(prior.status !== "completed" && prior.status !== "failed" &&
            samePlanningProjection(next, { ...prior, status: "cancelled" }))) {
        throw new PlanningError("PERSISTENCE_MISMATCH", "Plan-failed event rewrote an unrelated phase.");
      }
    }
    return;
  }

  if (type === "plan.cancelled") {
    assertUnchangedPlanningFields(before, after, [
      "stagedContributions", "contributions", "requirements", "decisions", "specification", "coverage", "reconciliationIntent",
    ]);
    if (before.specification !== null) throw new PlanningError("PERSISTENCE_MISMATCH", "Approved plan cannot emit cancellation.");
    if (after.taskGraph.version !== before.taskGraph.version + 1) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Plan-cancelled event has extra or missing task-graph command batches.");
    }
    for (const prior of before.phases) {
      const next = after.phases.find((phase) => phase.phaseId === prior.phaseId)!;
      const expected = prior.status === "completed" || prior.status === "failed"
        ? prior
        : { ...prior, status: "cancelled" };
      if (!samePlanningProjection(next, expected)) {
        throw new PlanningError("PERSISTENCE_MISMATCH", "Plan-cancelled event has an inexact phase delta.");
      }
    }
    return;
  }

  throw new PlanningError("PERSISTENCE_MISMATCH", "Planning event type cannot follow the current checkpoint.");
}

export function replayPlanningEvents(
  values: readonly PlanningEvent[],
  configuration: ProductPlanningConfiguration,
): ProductPlanSnapshot {
  if (!Array.isArray(values) || values.length === 0) throw new PlanningError("PERSISTENCE_MISMATCH", "Planning replay requires at least one event.");
  let current: ProductPlanSnapshot | null = null;
  let digest: string | null = null;
  let planId: string | null = null;
  for (let index = 0; index < values.length; index += 1) {
    const event = values[index]!;
    if (event.schemaVersion !== PRODUCT_PLANNING_SCHEMA_VERSION || event.sequence !== index + 1 || event.aggregateVersion !== index + 1 ||
        event.beforeDigest !== digest || (planId !== null && event.planId !== planId) ||
        (index === 0 && event.type !== "plan.accepted") || (index > 0 && event.type === "plan.accepted") ||
        (current !== null && event.occurredAt < current.updatedAt)) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Planning journal sequence, version, or digest chain is invalid.");
    }
    const snapshot = ProductPlan.hydrate(event.snapshot, configuration).toSnapshot();
    const afterDigest = planningDigest(snapshot);
    if (afterDigest !== event.afterDigest || snapshot.planId !== event.planId || snapshot.eventSequence !== event.sequence ||
        snapshot.aggregateVersion !== event.aggregateVersion || snapshot.updatedAt !== event.occurredAt ||
        event.eventId !== stablePlanningId("planning-event", event.planId, String(event.sequence), afterDigest)) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Planning journal checkpoint does not match its event envelope.");
    }
    assertExactPlanningEventDelta(event.type, current, snapshot);
    current = snapshot;
    digest = afterDigest;
    planId = event.planId;
  }
  return current!;
}

export function requirementTaskMetadata(coverage: RequirementTaskCoverage): JsonObject {
  return Object.freeze({
    requirementId: coverage.requirementId,
    requirementDigest: coverage.requirementDigest,
    decisionId: coverage.decisionId,
    disposition: coverage.disposition,
    executable: coverage.executable,
    taskId: coverage.taskId,
  });
}
