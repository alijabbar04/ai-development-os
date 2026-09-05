import {
  PLAN_STATES,
  assertAcyclicSupersession,
  canonicalizeProjectJson,
  parseDecision,
  parseProjectPlan,
  serializeCanonicalProjectJson,
  type Decision,
  type ProjectPlan,
} from "@ai-dev-os/project";
import { PLAN_EVENT_TYPES, PLAN_LIMITS } from "./constants.js";
import { SCOPE_AUTHORITIES, SCOPE_DISPOSITIONS } from "./constants.js";
import { assertPlanRecordInvariants, assertPlanReviewCoherent, computeProposalDigest } from "./assembly.js";
import { transformPlanSpecification } from "./specification.js";
import type {
  AcceptedBriefBinding,
  BoundRequirement,
  PlanCommitRequest,
  PlanDigestPort,
  PlanEventBinding,
  PlanEventEnvelopeInput,
  PlanHeadEventPayload,
  PlanHeadStep,
  PlanJournalEventPayload,
  PlanMutationControlEvidence,
  PlanOperationKind,
  PlanReviewEvidence,
  PlanSealConditionVerdict,
  PlanSealEvidence,
  PlanRebaseLink,
  PlanPredecessorEvidence,
  PlanBudgetExtensionEvidence,
  ResolvedProjectCeilingEvidence,
  SpecificationBinding,
  UpstreamRequirementProvenance,
} from "./contracts.js";
import { refusePlan } from "./errors.js";
import {
  assertOperatorEvidenceTargets,
  canonicalPlanValue,
  enumText,
  exactKeys,
  literal,
  parseAuthenticatedOperatorEvidence,
  parsePlanBudget,
  parsePlanAssemblyRequest,
  planDigest,
  planIdentifier,
  safeInteger,
  sameCanonicalValue,
  strictArray,
  strictRecord,
} from "./validation.js";

export function planLineageId(projectId: string): string {
  return planIdentifier(projectId, "prj:", "planLineage");
}

function nullableId(value: unknown, prefix: string, path: string): string | null {
  return value === null ? null : planIdentifier(value, prefix, path);
}

function timestamp(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== value
    || value < "2000-01-01T00:00:00.000Z"
    || value > "9999-12-31T23:59:59.999Z") {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
  }
  return value;
}

export function parseAcceptedBriefBinding(value: unknown): AcceptedBriefBinding {
  const input = strictRecord(value, "planBrief");
  exactKeys(input, ["projectId", "briefId", "briefAggregateVersion", "briefContentDigest", "acceptedCandidateDigest", "acceptanceEventId"], "planBrief");
  return Object.freeze({
    projectId: planIdentifier(input["projectId"], "prj:", "planBrief"),
    briefId: planIdentifier(input["briefId"], "brf:", "planBrief"),
    briefAggregateVersion: safeIntegerAtLeastOne(input["briefAggregateVersion"], "planBrief"),
    briefContentDigest: planDigest(input["briefContentDigest"], "planBrief"),
    acceptedCandidateDigest: planDigest(input["acceptedCandidateDigest"], "planBrief"),
    acceptanceEventId: planIdentifier(input["acceptanceEventId"], "", "planBrief"),
  });
}

function safeIntegerAtLeastOne(value: unknown, path: string): number {
  const parsed = safeInteger(value, path);
  if (parsed < 1) return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", path);
  return parsed;
}

export function parsePlanMutationControls(value: unknown): PlanMutationControlEvidence {
  const input = strictRecord(value, "planStore");
  exactKeys(input, ["projectAggregateVersion", "projectContentDigest", "projectStatus", "projectStopSnapshotDigest", "activeProjectStopIds"], "planStore");
  literal(input["projectStatus"], "active", "planStore");
  strictArray(input["activeProjectStopIds"], () => refusePlan("PLAN_PRECONDITION_REFUSED", "plan.project.stopped", "planStore"), "planStore", 0, 0);
  return Object.freeze({
    projectAggregateVersion: safeIntegerAtLeastOne(input["projectAggregateVersion"], "planStore"),
    projectContentDigest: planDigest(input["projectContentDigest"], "planStore"),
    projectStatus: "active",
    projectStopSnapshotDigest: planDigest(input["projectStopSnapshotDigest"], "planStore"),
    activeProjectStopIds: Object.freeze([] as const),
  });
}

function parseEventBinding(value: unknown): PlanEventBinding {
  const input = strictRecord(value, "planStore");
  exactKeys(input, [
    "projectId", "briefId", "briefAggregateVersion", "briefContentDigest",
    "acceptedCandidateDigest", "acceptanceEventId", "contentDigest", "planId",
    "planRevision", "planDigest", "proposalDigest", "expectedHeadPlanId",
    "expectedAggregateVersion", "resultAggregateVersion", "resultState",
    "headAdvanced", "stepIndex", "stepCount", "briefBlockingQuestionIds",
  ], "planStore");
  const accepted = parseAcceptedBriefBinding({
    projectId: input["projectId"],
    briefId: input["briefId"],
    briefAggregateVersion: input["briefAggregateVersion"],
    briefContentDigest: input["briefContentDigest"],
    acceptedCandidateDigest: input["acceptedCandidateDigest"],
    acceptanceEventId: input["acceptanceEventId"],
  });
  const stepIndex = safeIntegerAtLeastOne(input["stepIndex"], "planStore");
  const stepCount = safeIntegerAtLeastOne(input["stepCount"], "planStore");
  if (![1, 2].includes(stepIndex) || ![1, 2].includes(stepCount) || stepIndex > stepCount || typeof input["headAdvanced"] !== "boolean") {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planStore");
  }
  const questions = strictArray(input["briefBlockingQuestionIds"], (entry) => planIdentifier(entry, "", "planBrief"), "planBrief");
  if (new Set(questions).size !== questions.length || [...questions].sort().some((entry, index) => entry !== questions[index])) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planBrief");
  }
  return Object.freeze({
    ...accepted,
    contentDigest: planDigest(input["contentDigest"], "planStore"),
    planId: planIdentifier(input["planId"], "pln:", "planStore"),
    planRevision: safeIntegerAtLeastOne(input["planRevision"], "planStore"),
    planDigest: planDigest(input["planDigest"], "planStore"),
    proposalDigest: planDigest(input["proposalDigest"], "planStore"),
    expectedHeadPlanId: nullableId(input["expectedHeadPlanId"], "pln:", "planStore"),
    expectedAggregateVersion: safeInteger(input["expectedAggregateVersion"], "planStore"),
    resultAggregateVersion: safeIntegerAtLeastOne(input["resultAggregateVersion"], "planStore"),
    resultState: enumText(input["resultState"], PLAN_STATES, "planStore"),
    headAdvanced: input["headAdvanced"],
    stepIndex: stepIndex as 1 | 2,
    stepCount: stepCount as 1 | 2,
    briefBlockingQuestionIds: questions,
  });
}

function parseDecisions(value: unknown, digest: PlanDigestPort): readonly Decision[] {
  const decisions = strictArray(value, (entry) => {
    try {
      const decision = parseDecision(entry);
      const { decisionId: _decisionId, ...material } = decision;
      const expected = `dec:${digest.sha256(serializeCanonicalProjectJson(material)).slice(0, 32)}`;
      if (decision.decisionId !== expected) throw new Error("decision identity mismatch");
      return decision;
    }
    catch { return refusePlan("PLAN_VALIDATION_REFUSED", "plan.decision.kind-out-of-scope", "planDecision"); }
  }, "planDecision");
  if (new Set(decisions.map((decision) => decision.decisionId)).size !== decisions.length) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.decision.kind-out-of-scope", "planDecision");
  }
  try { assertAcyclicSupersession({ kind: "decision", records: decisions }); }
  catch { refusePlan("PLAN_VALIDATION_REFUSED", "plan.decision.kind-out-of-scope", "planDecision"); }
  return decisions;
}

function parseUpstreamProvenance(value: unknown): UpstreamRequirementProvenance {
  const input = strictRecord(value, "planCoverage");
  exactKeys(input, ["contributionId", "phaseId", "routeKey", "sourceFingerprint", "candidateId"], "planCoverage");
  return Object.freeze({
    contributionId: planIdentifier(input["contributionId"], "", "planCoverage"),
    phaseId: planIdentifier(input["phaseId"], "", "planCoverage"),
    routeKey: planIdentifier(input["routeKey"], "", "planCoverage"),
    sourceFingerprint: planDigest(input["sourceFingerprint"], "planCoverage"),
    candidateId: planIdentifier(input["candidateId"], "", "planCoverage"),
  });
}

function parseBoundRequirement(value: unknown): BoundRequirement {
  const input = strictRecord(value, "planCoverage");
  exactKeys(input, [
    "requirementId", "requirementDigest", "decisionId", "disposition",
    "sourceProvenance", "executable", "upstreamTaskId", "taskId", "waiverDecisionId",
  ], "planCoverage");
  if (typeof input["executable"] !== "boolean") refusePlan("PLAN_VALIDATION_REFUSED", "plan.specification.incoherent", "planCoverage");
  const rows = strictArray(input["sourceProvenance"], parseUpstreamProvenance, "planCoverage");
  if (new Set(rows.map((row) => serializeCanonicalProjectJson(row))).size !== rows.length) {
    refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.coverage.provenance-inconsistent", "planCoverage");
  }
  return Object.freeze({
    requirementId: planIdentifier(input["requirementId"], "", "planCoverage"),
    requirementDigest: planDigest(input["requirementDigest"], "planCoverage"),
    decisionId: planIdentifier(input["decisionId"], "", "planCoverage"),
    disposition: enumText(input["disposition"], SCOPE_DISPOSITIONS, "planCoverage"),
    sourceProvenance: rows,
    executable: input["executable"],
    upstreamTaskId: nullableId(input["upstreamTaskId"], "requirement-task:", "planCoverage"),
    taskId: nullableId(input["taskId"], "tsk:", "planCoverage"),
    waiverDecisionId: nullableId(input["waiverDecisionId"], "dec:", "planCoverage"),
  });
}

function parseSpecificationBinding(value: unknown): SpecificationBinding {
  const input = strictRecord(value, "planSpecification");
  exactKeys(input, [
    "specificationId", "upstreamPlanId", "upstreamPlanVersion", "intentDigest",
    "decisionSetDigest", "approvedBy", "approvalReference", "approvedAt",
    "approvalDigest", "specificationRef", "coverageRef", "requirements",
  ], "planSpecification");
  const approvedBy = strictRecord(input["approvedBy"], "planSpecification");
  exactKeys(approvedBy, ["actorId", "authority"], "planSpecification");
  return Object.freeze({
    specificationId: planIdentifier(input["specificationId"], "product-specification:", "planSpecification"),
    upstreamPlanId: planIdentifier(input["upstreamPlanId"], "", "planSpecification"),
    upstreamPlanVersion: safeIntegerAtLeastOne(input["upstreamPlanVersion"], "planSpecification"),
    intentDigest: planDigest(input["intentDigest"], "planSpecification"),
    decisionSetDigest: planDigest(input["decisionSetDigest"], "planSpecification"),
    approvedBy: Object.freeze({
      actorId: planIdentifier(approvedBy["actorId"], "", "planSpecification"),
      authority: enumText(approvedBy["authority"], SCOPE_AUTHORITIES, "planSpecification"),
    }),
    approvalReference: planIdentifier(input["approvalReference"], "", "planSpecification"),
    approvedAt: timestamp(input["approvedAt"], "planSpecification"),
    approvalDigest: planDigest(input["approvalDigest"], "planSpecification"),
    specificationRef: planIdentifier(input["specificationRef"], "spec:", "planSpecification"),
    coverageRef: planIdentifier(input["coverageRef"], "coverage:", "planCoverage"),
    requirements: strictArray(input["requirements"], parseBoundRequirement, "planCoverage"),
  });
}

function expectedProvenance(assemblyRequest: PlanReviewEvidence["assemblyRequest"]): PlanReviewEvidence["provenance"] {
  const stageOrdinal = new Map(assemblyRequest.proposal.stages.map((stage, index) => [stage.stageId, index]));
  return Object.freeze({
    stages: Object.freeze(assemblyRequest.proposal.stages.map((stage) => Object.freeze({ stageId: stage.stageId, fields: stage.provenance }))),
    tasks: Object.freeze([...assemblyRequest.proposal.tasks]
      .sort((left, right) => (stageOrdinal.get(left.stageId) ?? 0) - (stageOrdinal.get(right.stageId) ?? 0) || left.taskId.localeCompare(right.taskId))
      .map((task) => Object.freeze({ taskId: task.taskId, fields: task.provenance }))),
  });
}

export function parsePlanReviewEvidence(value: unknown, digest: PlanDigestPort): PlanReviewEvidence {
  const input = strictRecord(value, "planStore");
  exactKeys(input, ["assemblyRequest", "proposalDigest", "specification", "specificationDigest", "coverageDigest", "constraintDispositions", "provenance", "authenticatedOperatorEvidence"], "planStore");
  const assemblyRequest = parsePlanAssemblyRequest(input["assemblyRequest"]);
  const proposalDigest = planDigest(input["proposalDigest"], "planStore");
  const specificationDigest = input["specificationDigest"] === null ? null : planDigest(input["specificationDigest"], "planSpecification");
  const coverageDigest = input["coverageDigest"] === null ? null : planDigest(input["coverageDigest"], "planCoverage");
  const specification = input["specification"] === null ? null : parseSpecificationBinding(input["specification"]);
  const provenance = expectedProvenance(assemblyRequest);
  const suppliedProvenance = canonicalizeProjectJson(input["provenance"]);
  const suppliedDispositions = canonicalizeProjectJson(input["constraintDispositions"]);
  const authenticatedOperatorEvidence = parseAuthenticatedOperatorEvidence(input["authenticatedOperatorEvidence"]);
  assertOperatorEvidenceTargets(assemblyRequest, authenticatedOperatorEvidence);
  if (proposalDigest !== assemblyRequest.expectedProposalDigest
    || specificationDigest !== assemblyRequest.expectedSpecificationDigest
    || coverageDigest !== assemblyRequest.expectedCoverageDigest
    || !sameCanonicalValue(suppliedDispositions, assemblyRequest.proposal.constraintDispositions)
    || !sameCanonicalValue(suppliedProvenance, provenance)
    || (specification === null) !== (assemblyRequest.specificationInput === null)) {
    refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.coverage.provenance-inconsistent", "planStore");
  }
  if (computeProposalDigest(assemblyRequest, digest) !== proposalDigest) {
    refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.coverage.provenance-inconsistent", "planStore");
  }
  const expectedSpecification = assemblyRequest.specificationInput === null
    ? null
    : transformPlanSpecification(
        assemblyRequest.specificationInput,
        assemblyRequest.expectedSpecificationDigest!,
        assemblyRequest.expectedCoverageDigest!,
        assemblyRequest.proposal.tasks,
        digest,
      );
  if (!sameCanonicalValue(specification, expectedSpecification)) {
    refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.coverage.provenance-inconsistent", "planStore");
  }
  return Object.freeze({
    assemblyRequest,
    proposalDigest,
    specification,
    specificationDigest,
    coverageDigest,
    constraintDispositions: assemblyRequest.proposal.constraintDispositions,
    provenance,
    authenticatedOperatorEvidence,
  });
}

function parseOperation(kind: PlanJournalEventPayload["kind"], value: unknown): PlanJournalEventPayload["operation"] {
  const input = strictRecord(value, "planStore");
  switch (kind) {
    case "plan.drafted": {
      exactKeys(input, ["kind", "mode"], "planStore");
      literal(input["kind"], "draft", "planStore");
      return Object.freeze({ kind: "draft", mode: enumText(input["mode"], ["create", "redraft"] as const, "planStore") });
    }
    case "plan.proposed": exactKeys(input, ["kind"], "planStore"); literal(input["kind"], "promote", "planStore"); return Object.freeze({ kind: "promote" });
    case "plan.scope-approval-required": exactKeys(input, ["kind"], "planStore"); literal(input["kind"], "require-scope-approval", "planStore"); return Object.freeze({ kind: "require-scope-approval" });
    case "plan.scope-rejected": exactKeys(input, ["kind"], "planStore"); literal(input["kind"], "reject-scope", "planStore"); return Object.freeze({ kind: "reject-scope" });
    case "plan.sealed": exactKeys(input, ["kind"], "planStore"); literal(input["kind"], "seal", "planStore"); return Object.freeze({ kind: "seal" });
    case "plan.revised": exactKeys(input, ["kind", "mode"], "planStore"); literal(input["kind"], "revise", "planStore"); return Object.freeze({ kind: "revise", mode: enumText(input["mode"], ["R1", "R2"] as const, "planStore") });
    case "plan.superseded": exactKeys(input, ["kind"], "planStore"); literal(input["kind"], "discard-stale", "planStore"); return Object.freeze({ kind: "discard-stale" });
    case "plan.abandoned": exactKeys(input, ["kind"], "planStore"); literal(input["kind"], "abandon", "planStore"); return Object.freeze({ kind: "abandon" });
    case "plan.budget-extended": exactKeys(input, ["kind"], "planStore"); literal(input["kind"], "record-budget-extension", "planStore"); return Object.freeze({ kind: "record-budget-extension" });
  }
}

function exactDecisionKinds(kind: PlanJournalEventPayload["kind"], decisions: readonly Decision[]): void {
  const kinds = decisions.map((decision) => decision.kind);
  const exactOne = (expected: Decision["kind"]): boolean => kinds.length === 1 && kinds[0] === expected;
  if (["plan.drafted", "plan.proposed", "plan.scope-approval-required", "plan.superseded", "plan.abandoned"].includes(kind)) {
    if (kinds.length !== 0) refusePlan("PLAN_OUT_OF_SCOPE", "plan.decision.kind-out-of-scope", "planDecision");
    return;
  }
  if (kind === "plan.scope-rejected" && !exactOne("scope-rejected")
    || kind === "plan.revised" && !exactOne("plan-revision-accepted")
    || kind === "plan.budget-extended" && !exactOne("budget-extension-accepted")) {
    refusePlan("PLAN_OUT_OF_SCOPE", "plan.decision.kind-out-of-scope", "planDecision");
  }
  if (kind === "plan.sealed") {
    if (kinds.length === 0 || !(["scope-accepted", "scope-deferred"] as readonly string[]).includes(kinds[0] ?? "")
      || kinds.slice(1).some((entry) => !(["waiver-granted", "conflict-resolution"] as readonly string[]).includes(entry))) {
      refusePlan("PLAN_OUT_OF_SCOPE", "plan.decision.kind-out-of-scope", "planDecision");
    }
    const supplemental = decisions.slice(1).map((decision) => decision.decisionId);
    if ([...supplemental].sort().some((id, index) => id !== supplemental[index])) {
      refusePlan("PLAN_OUT_OF_SCOPE", "plan.decision.kind-out-of-scope", "planDecision");
    }
  }
}

function parsePredecessor(value: unknown): PlanPredecessorEvidence {
  const input = strictRecord(value, "planLineage");
  exactKeys(input, ["planId", "revision", "supersedes", "state", "planDigest", "sealedAt", "sealedByApprovalId"], "planLineage");
  const state = enumText(input["state"], ["drafting", "superseded"] as const, "planLineage");
  const sealedAt = input["sealedAt"] === null ? null : timestamp(input["sealedAt"], "planLineage");
  if (input["sealedByApprovalId"] !== null || state === "drafting" && sealedAt !== null) {
    refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.seal.approval-binding", "planLineage");
  }
  return Object.freeze({
    planId: planIdentifier(input["planId"], "pln:", "planLineage"),
    revision: safeIntegerAtLeastOne(input["revision"], "planLineage"),
    supersedes: nullableId(input["supersedes"], "pln:", "planLineage"),
    state,
    planDigest: planDigest(input["planDigest"], "planLineage"),
    sealedAt,
    sealedByApprovalId: null,
  }) as PlanPredecessorEvidence;
}

function parseRebase(value: unknown): PlanRebaseLink {
  const input = strictRecord(value, "planLineage");
  exactKeys(input, [
    "kind", "replaces", "replacesRevision", "previousDisposition",
    "projectId", "briefId", "briefAggregateVersion", "briefContentDigest",
    "acceptedCandidateDigest", "acceptanceEventId",
  ], "planLineage");
  literal(input["kind"], "plan.rebased", "planLineage");
  const accepted = parseAcceptedBriefBinding({
    projectId: input["projectId"],
    briefId: input["briefId"],
    briefAggregateVersion: input["briefAggregateVersion"],
    briefContentDigest: input["briefContentDigest"],
    acceptedCandidateDigest: input["acceptedCandidateDigest"],
    acceptanceEventId: input["acceptanceEventId"],
  });
  const disposition = strictRecord(input["previousDisposition"], "planLineage");
  const dispositionKind = enumText(disposition["kind"], ["draft-replaced", "superseded"] as const, "planLineage");
  if (dispositionKind === "draft-replaced") {
    exactKeys(disposition, ["kind", "from"], "planLineage");
    literal(disposition["from"], "drafting", "planLineage");
    return Object.freeze({
      kind: "plan.rebased",
      replaces: planIdentifier(input["replaces"], "pln:", "planLineage"),
      replacesRevision: safeIntegerAtLeastOne(input["replacesRevision"], "planLineage"),
      previousDisposition: Object.freeze({ kind: "draft-replaced", from: "drafting" }),
      ...accepted,
    });
  }
  exactKeys(disposition, ["kind", "from", "to"], "planLineage");
  const from = enumText(disposition["from"], ["proposed", "sealed"] as const, "planLineage");
  literal(disposition["to"], "superseded", "planLineage");
  return Object.freeze({
    kind: "plan.rebased",
    replaces: planIdentifier(input["replaces"], "pln:", "planLineage"),
    replacesRevision: safeIntegerAtLeastOne(input["replacesRevision"], "planLineage"),
    previousDisposition: Object.freeze({ kind: "superseded", from, to: "superseded" }),
    ...accepted,
  });
}

export function parseResolvedProjectCeilingEvidence(value: unknown): ResolvedProjectCeilingEvidence {
  const input = strictRecord(value, "planBudget");
  exactKeys(input, [
    "budgetAccountId", "budgetAccountAggregateVersion", "budgetAccountContentDigest",
    "budgetAccountStateVersion", "briefContentDigest", "accountMaximumTotalTokens", "ceiling",
  ], "planBudget");
  const total = input["accountMaximumTotalTokens"] === null
    ? null
    : safeInteger(input["accountMaximumTotalTokens"], "planBudget", 1_000_000_000_000);
  return Object.freeze({
    budgetAccountId: planIdentifier(input["budgetAccountId"], "", "planBudget"),
    budgetAccountAggregateVersion: safeIntegerAtLeastOne(input["budgetAccountAggregateVersion"], "planBudget"),
    budgetAccountContentDigest: planDigest(input["budgetAccountContentDigest"], "planBudget"),
    budgetAccountStateVersion: safeInteger(input["budgetAccountStateVersion"], "planBudget"),
    briefContentDigest: planDigest(input["briefContentDigest"], "planBudget"),
    accountMaximumTotalTokens: total,
    ceiling: parsePlanBudget(input["ceiling"], "planBudget"),
  });
}

function parseVerdict(value: unknown, expectedCondition: 1 | 2 | 3 | 4 | 5 | 6): PlanSealConditionVerdict {
  const input = strictRecord(value, "planSeal");
  exactKeys(input, ["condition", "passed", "ruleIds"], "planSeal");
  literal(input["condition"], expectedCondition, "planSeal");
  if (typeof input["passed"] !== "boolean") refusePlan("PLAN_VALIDATION_REFUSED", "plan.seal.metadata", "planSeal");
  const ruleIds = strictArray(input["ruleIds"], (entry) => planIdentifier(entry, "plan.", "planSeal"), "planSeal");
  if (new Set(ruleIds).size !== ruleIds.length
    || [...ruleIds].sort().some((ruleId, index) => ruleId !== ruleIds[index])
    || input["passed"] !== (ruleIds.length === 0)) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.seal.metadata", "planSeal");
  }
  return Object.freeze({ condition: expectedCondition, passed: input["passed"], ruleIds });
}

export function parsePlanSealVerdicts(value: unknown): PlanSealEvidence["verdicts"] {
  const rawVerdicts = strictArray(value, (entry) => entry, "planSeal", 6, 6);
  return Object.freeze([1, 2, 3, 4, 5, 6].map(
    (condition, index) => parseVerdict(rawVerdicts[index], condition as 1 | 2 | 3 | 4 | 5 | 6),
  )) as PlanSealEvidence["verdicts"];
}

function parseSealEvidence(value: unknown): PlanSealEvidence {
  const input = strictRecord(value, "planSeal");
  exactKeys(input, ["verdicts", "blockingQuestionIds", "resolvedProjectCeiling", "sealedAt", "sealedByApprovalId"], "planSeal");
  const verdicts = parsePlanSealVerdicts(input["verdicts"]);
  const blockingQuestionIds = strictArray(input["blockingQuestionIds"], (entry) => planIdentifier(entry, "", "planBrief"), "planBrief");
  if (new Set(blockingQuestionIds).size !== blockingQuestionIds.length
    || [...blockingQuestionIds].sort().some((id, index) => id !== blockingQuestionIds[index])
    || input["sealedByApprovalId"] !== null) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.seal.metadata", "planSeal");
  }
  return Object.freeze({
    verdicts,
    blockingQuestionIds,
    resolvedProjectCeiling: parseResolvedProjectCeilingEvidence(input["resolvedProjectCeiling"]),
    sealedAt: timestamp(input["sealedAt"], "planSeal"),
    sealedByApprovalId: null,
  });
}

function parseBudgetExtension(value: unknown): PlanBudgetExtensionEvidence {
  const input = strictRecord(value, "planBudget");
  exactKeys(input, ["taskId", "previousBudget", "requestedBudget", "decisionId"], "planBudget");
  return Object.freeze({
    taskId: planIdentifier(input["taskId"], "tsk:", "planBudget"),
    previousBudget: parsePlanBudget(input["previousBudget"], "planBudget"),
    requestedBudget: parsePlanBudget(input["requestedBudget"], "planBudget"),
    decisionId: planIdentifier(input["decisionId"], "dec:", "planBudget"),
  });
}

function requireNulls(kind: PlanJournalEventPayload["kind"], input: StrictPayload): void {
  if (kind !== "plan.sealed" && input.seal !== null
    || kind !== "plan.budget-extended" && input.budgetExtension !== null
    || !["plan.drafted", "plan.revised"].includes(kind) && (input.rebase !== null || input.predecessor !== null)) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planStore");
  }
  if (kind === "plan.sealed" && input.seal === null || kind === "plan.budget-extended" && input.budgetExtension === null) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planStore");
  }
}

interface StrictPayload {
  readonly rebase: unknown;
  readonly predecessor: unknown;
  readonly seal: unknown;
  readonly budgetExtension: unknown;
}

export function parsePlanJournalEvent(value: unknown, digest: PlanDigestPort): PlanJournalEventPayload {
  const input = strictRecord(value, "planStore");
  exactKeys(input, ["schemaVersion", "kind", "operation", "plan", "binding", "controls", "review", "decisions", "rebase", "predecessor", "seal", "budgetExtension"], "planStore");
  literal(input["schemaVersion"], 1, "planStore");
  const kind = enumText(input["kind"], PLAN_EVENT_TYPES, "planStore");
  let plan: ProjectPlan;
  try { plan = parseProjectPlan(input["plan"]); }
  catch { return refusePlan("PLAN_STORE_CORRUPT", "plan.store.corrupt", "planStore"); }
  assertPlanRecordInvariants(plan, digest);
  const binding = parseEventBinding(input["binding"]);
  const controls = parsePlanMutationControls(input["controls"]);
  const review = parsePlanReviewEvidence(input["review"], digest);
  assertPlanReviewCoherent({ plan, review });
  const decisions = parseDecisions(input["decisions"], digest);
  exactDecisionKinds(kind, decisions);
  requireNulls(kind, input as unknown as StrictPayload);
  const operation = parseOperation(kind, input["operation"]);
  const expectedState = kind === "plan.drafted" || kind === "plan.revised" ? "drafting"
    : kind === "plan.proposed" ? "proposed"
      : kind === "plan.scope-approval-required" ? "awaiting_scope_approval"
        : kind === "plan.scope-rejected" ? "rejected"
          : kind === "plan.sealed" ? "sealed"
            : kind === "plan.superseded" ? "superseded"
              : kind === "plan.abandoned" ? "abandoned" : plan.state;
  if (binding.planId !== plan.planId
    || binding.planRevision !== plan.revision
    || binding.planDigest !== plan.planDigest
    || binding.resultState !== plan.state
    || plan.state !== expectedState
    || binding.projectId !== plan.projectId
    || binding.briefId !== plan.briefId
    || binding.proposalDigest !== review.proposalDigest
    || binding.briefBlockingQuestionIds.length !== 0
    || review.assemblyRequest.proposal.projectId !== plan.projectId
    || review.assemblyRequest.proposal.briefId !== plan.briefId
    || review.assemblyRequest.newPlanId !== plan.planId
    || plan.specificationRef !== review.specification?.specificationRef && review.specification !== null
    || plan.coverageRef !== review.specification?.coverageRef && review.specification !== null
    || review.specification === null && (plan.specificationRef !== null || plan.coverageRef !== null)) {
    refusePlan("PLAN_STORE_CORRUPT", "plan.store.corrupt", "planStore");
  }
  if (decisions.some((decision) => decision.projectId !== plan.projectId
    || decision.scope.planId !== plan.planId
    || decision.scope.planRevision !== plan.revision)) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.decision.stale-binding", "planDecision");
  }
  if (kind === "plan.drafted" && operation.kind === "draft" && operation.mode === "create" && (input["rebase"] !== null || input["predecessor"] !== null)) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planStore");
  }
  if (kind === "plan.drafted" && operation.kind === "draft" && operation.mode === "redraft" && input["predecessor"] === null) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planStore");
  }
  if (kind === "plan.revised" && operation.kind === "revise") {
    if (input["predecessor"] === null || operation.mode === "R1" && input["rebase"] !== null || operation.mode === "R2" && input["rebase"] === null) {
      refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planStore");
    }
  }
  const rebase = input["rebase"] === null ? null : parseRebase(input["rebase"]);
  const predecessor = input["predecessor"] === null ? null : parsePredecessor(input["predecessor"]);
  const seal = input["seal"] === null ? null : parseSealEvidence(input["seal"]);
  const budgetExtension = input["budgetExtension"] === null ? null : parseBudgetExtension(input["budgetExtension"]);
  if (kind === "plan.drafted" && operation.kind === "draft") {
    if (operation.mode === "create" && (rebase !== null || predecessor !== null)
      || operation.mode === "redraft" && (predecessor?.state !== "drafting" || rebase?.previousDisposition.kind === "superseded")) {
      refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planLineage");
    }
  }
  if (kind === "plan.revised" && operation.kind === "revise") {
    if (predecessor?.state !== "superseded"
      || operation.mode === "R1" && rebase !== null
      || operation.mode === "R2" && rebase?.previousDisposition.kind !== "superseded") {
      refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planLineage");
    }
  }
  if (kind === "plan.sealed" && (seal === null || seal.sealedAt !== plan.sealedAt || seal.sealedByApprovalId !== null)
    || kind === "plan.budget-extended" && (budgetExtension === null || budgetExtension.decisionId !== decisions[0]?.decisionId)) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.seal.metadata", "planStore");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind,
    operation,
    plan,
    binding,
    controls,
    review,
    decisions,
    rebase,
    predecessor,
    seal,
    budgetExtension,
  }) as unknown as PlanJournalEventPayload;
}

function parseEnvelope(value: unknown): PlanEventEnvelopeInput {
  const input = strictRecord(value, "planStore");
  exactKeys(input, ["occurredAt", "traceId", "causationId"], "planStore");
  return Object.freeze({
    occurredAt: timestamp(input["occurredAt"], "planStore"),
    traceId: nullableId(input["traceId"], "", "planStore"),
    causationId: nullableId(input["causationId"], "", "planStore"),
  });
}

function parseStep(value: unknown, digest: PlanDigestPort): PlanCommitRequest["steps"][number] {
  const input = strictRecord(value, "planStore");
  exactKeys(input, ["eventId", "expectedState", "plan", "envelope", "event"], "planStore");
  const event = parsePlanJournalEvent(input["event"], digest);
  const eventId = planIdentifier(input["eventId"], "", "planStore");
  const expectedState = input["expectedState"] === null ? null : enumText(input["expectedState"], PLAN_STATES, "planStore");
  const envelope = parseEnvelope(input["envelope"]);
  if (event.kind === "plan.budget-extended") {
    if (input["plan"] !== null || expectedState === null) refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planStore");
    return Object.freeze({ eventId, expectedState, plan: null, envelope, event });
  }
  let plan: ProjectPlan;
  try { plan = parseProjectPlan(input["plan"]); }
  catch { return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planStore"); }
  if (!sameCanonicalValue(plan, event.plan)) refusePlan("PLAN_STORE_CORRUPT", "plan.store.corrupt", "planStore");
  return Object.freeze({ eventId, expectedState, plan, envelope, event });
}

export function planCommitDigestMaterial(request: PlanCommitRequest): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: 1,
    projectId: request.projectId,
    requestBinding: Object.freeze({
      expectedHeadPlanId: request.binding.expectedHeadPlanId,
      expectedAggregateVersion: request.binding.expectedAggregateVersion,
    }),
    acceptedBrief: request.acceptedBrief,
    expectedControls: request.expectedControls,
    steps: Object.freeze(request.steps.map((step) => Object.freeze({
      eventId: step.eventId,
      expectedState: step.expectedState,
      plan: step.plan,
      envelope: step.envelope,
      event: Object.freeze({
        ...step.event,
        binding: Object.freeze({ ...step.event.binding, contentDigest: null }),
      }),
    }))),
  });
}

export function computePlanCommitContentDigest(request: PlanCommitRequest, digest: PlanDigestPort): string {
  let result: unknown;
  try { result = digest.sha256(serializeCanonicalProjectJson(planCommitDigestMaterial(request))); }
  catch { return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.digest-mismatch", "planStore"); }
  return planDigest(result, "planStore");
}

export function parsePlanCommitRequest(value: unknown, digest: PlanDigestPort): PlanCommitRequest {
  const input = strictRecord(value, "planStore");
  exactKeys(input, ["schemaVersion", "projectId", "binding", "acceptedBrief", "expectedControls", "steps"], "planStore", "plan.proposal.unknown-field");
  literal(input["schemaVersion"], 1, "planStore");
  const bindingInput = strictRecord(input["binding"], "planStore");
  exactKeys(bindingInput, ["contentDigest", "expectedHeadPlanId", "expectedAggregateVersion"], "planStore");
  const contentDigest = planDigest(bindingInput["contentDigest"], "planStore");
  const binding = Object.freeze({
    contentDigest,
    expectedHeadPlanId: nullableId(bindingInput["expectedHeadPlanId"], "pln:", "planStore"),
    expectedAggregateVersion: safeInteger(bindingInput["expectedAggregateVersion"], "planStore"),
  });
  const steps = strictArray(input["steps"], (entry) => parseStep(entry, digest), "planStore", 1, 2);
  if (new Set(steps.map((step) => step.eventId)).size !== steps.length) refusePlan("PLAN_VALIDATION_REFUSED", "plan.event.duplicate-id", "planStore");
  if (steps.length === 2 && steps.some((step) => step.event.kind === "plan.budget-extended")) refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planStore");
  const acceptedBrief = parseAcceptedBriefBinding(input["acceptedBrief"]);
  const expectedControls = parsePlanMutationControls(input["expectedControls"]);
  const request = Object.freeze({
    schemaVersion: 1 as const,
    projectId: planIdentifier(input["projectId"], "prj:", "planStore"),
    binding,
    acceptedBrief,
    expectedControls,
    steps: Object.freeze(steps),
  }) as PlanCommitRequest;
  if (request.projectId !== acceptedBrief.projectId
    || request.steps.some((step, index) => step.event.binding.contentDigest !== contentDigest
      || step.event.binding.stepIndex !== index + 1
      || step.event.binding.stepCount !== steps.length
      || step.event.binding.expectedHeadPlanId !== binding.expectedHeadPlanId
      || step.event.binding.expectedAggregateVersion !== binding.expectedAggregateVersion
      || !sameCanonicalValue(step.event.controls, expectedControls)
      || !sameCanonicalValue(pickAccepted(step.event.binding), acceptedBrief))) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.digest-mismatch", "planStore");
  }
  const computed = computePlanCommitContentDigest(request, digest);
  if (computed !== contentDigest) refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.digest-mismatch", "planStore");
  for (const step of request.steps) {
    if (serializeCanonicalProjectJson(step.event).length > PLAN_LIMITS.maxEventBytes) {
      refusePlan("PLAN_BOUND_EXCEEDED", "plan.event.too-large", "planStore");
    }
  }
  return request;
}

function pickAccepted(binding: PlanEventBinding): AcceptedBriefBinding {
  return Object.freeze({
    projectId: binding.projectId,
    briefId: binding.briefId,
    briefAggregateVersion: binding.briefAggregateVersion,
    briefContentDigest: binding.briefContentDigest,
    acceptedCandidateDigest: binding.acceptedCandidateDigest,
    acceptanceEventId: binding.acceptanceEventId,
  });
}

export function operationKindsOf(request: PlanCommitRequest): readonly PlanOperationKind[] {
  return Object.freeze(request.steps.map((step) => {
    switch (step.event.operation.kind) {
      case "draft": return "draft";
      case "promote": return "promote";
      case "require-scope-approval": return "require-scope-approval";
      case "reject-scope": return "reject-scope";
      case "seal": return "seal";
      case "revise": return "revise";
      case "discard-stale": return "discard-stale";
      case "abandon": return "abandon";
      case "record-budget-extension": return "record-budget-extension";
    }
  }));
}

export function isHeadEvent(event: PlanJournalEventPayload): event is PlanHeadEventPayload {
  return event.kind !== "plan.budget-extended";
}

export function assertCompleteMutationShape(request: PlanCommitRequest): void {
  if (request.steps.length === 2
    && (request.steps[0].event.kind !== "plan.proposed"
      || request.steps[1].event.kind !== "plan.scope-approval-required")) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "planStore");
  }
  let expectedVersion = request.binding.expectedAggregateVersion;
  let expectedHead = request.binding.expectedHeadPlanId;
  for (const step of request.steps) {
    const event = step.event;
    if (event.binding.resultAggregateVersion !== expectedVersion + (event.binding.headAdvanced ? 1 : 0)) {
      refusePlan("PLAN_VALIDATION_REFUSED", "plan.revision.stale", "planStore");
    }
    if (isHeadEvent(event)) {
      if (!event.binding.headAdvanced || step.plan === null || event.plan.planId !== step.plan.planId) {
        refusePlan("PLAN_VALIDATION_REFUSED", "plan.revision.stale", "planStore");
      }
      expectedVersion = event.binding.resultAggregateVersion;
      expectedHead = event.plan.planId;
    } else if (event.binding.headAdvanced || event.plan.planId !== expectedHead || event.binding.resultAggregateVersion !== expectedVersion) {
      refusePlan("PLAN_VALIDATION_REFUSED", "plan.revision.stale", "planStore");
    }
  }
}

export function canonicalRequestBytes(request: PlanCommitRequest): string {
  return canonicalPlanValue(request);
}
