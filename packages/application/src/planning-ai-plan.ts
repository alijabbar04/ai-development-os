import { parseDecision, type ProjectPlan } from "@ai-dev-os/project";
import {
  assemblePlan,
  computeCoverageDigest,
  computeModelPlanProposalDigest,
  computeProposalDigest,
  computeSpecificationDigest,
  parsePlanAssemblyRequest,
  parsePlanProposal,
  prepareModelPlanAdoption,
  supersedeForRevision,
  type PlanCommitRequest,
  type PlanHeadEventPayload,
  type PlanModelFieldEdit,
  type PlanProposal,
} from "@ai-dev-os/plan";
import type { AiPlanningProposal } from "./planning-ai-contracts.js";
import { aiDigest, parseAiProposal } from "./planning-ai-validation.js";
import { parsePlanningConfirmation, type PlanningConfirmation } from "./planning-ledger.js";
import { acceptedPlanningBinding, assertPlanningAdmission, bindPlanningSteps, planningCeiling, type PlanningFoundations } from "./planning-plan.js";
import { canonicalPlanning, digestPlanning, planningHash, planningId, refusePlanning } from "./planning-validation.js";

export interface BuildAiPlanRequestInput {
  readonly commandId: string;
  readonly original: AiPlanningProposal;
  readonly edited: AiPlanningProposal;
  readonly contributionDigest: string;
  readonly requestId: string;
  readonly routeFingerprint: string;
  readonly narrativeRef: string | null;
  readonly foundations: PlanningFoundations;
  readonly confirmation: PlanningConfirmation;
}

function requireSameStructure(original: AiPlanningProposal, edited: AiPlanningProposal): void {
  const structure = (proposal: AiPlanningProposal) => proposal.tasks.map((task) => ({ taskId: task.taskId, dependsOn: task.dependsOn, criterionCount: task.acceptanceCriteria.length }));
  if (canonicalPlanning(structure(original)) !== canonicalPlanning(structure(edited))) {
    refusePlanning("ai.proposal-structure-changed", "conflict");
  }
}

function revisionDecision(plan: ProjectPlan, confirmation: PlanningConfirmation) {
  const material = { schemaVersion: 1, revision: 1, projectId: plan.projectId, scope: { planId: plan.planId, planRevision: plan.revision, stageId: null, taskId: null }, kind: "plan-revision-accepted",
    decidedBy: "operator", statement: "The operator adopted this exact model proposal as a saved plan revision.", rationale: null, supersedes: null, subjectDigest: plan.planDigest, decidedAt: confirmation.confirmedAt };
  return parseDecision({ ...material, decisionId: `dec:${digestPlanning(material).slice(0, 32)}` });
}

/**
 * The application first proves the immutable contribution, current context and
 * exact native confirmation. This deterministic helper prepares a canonical C9
 * draft; it issues no capability and never grants scope or execution authority.
 */
export function buildAiPlanRequest(input: BuildAiPlanRequestInput): PlanCommitRequest {
  const commandId = planningId(input.commandId), requestId = planningId(input.requestId), contributionDigest = aiDigest(input.contributionDigest), routeFingerprint = aiDigest(input.routeFingerprint);
  if (!requestId.startsWith("ai-request:")) return refusePlanning("ai.request-binding");
  const original = parseAiProposal(input.original), edited = parseAiProposal(input.edited), confirmation = parsePlanningConfirmation(input.confirmation), f = input.foundations;
  assertPlanningAdmission(f);
  if (f.accepted === null) return refusePlanning("brief.acceptance-required");
  const prior = f.head?.plan ?? null;
  if (prior !== null && !["drafting", "proposed", "sealed"].includes(prior.state)) return refusePlanning("plan.revision-unavailable");
  requireSameStructure(original, edited);
  const adoptionId = digestPlanning(commandId).slice(0, 24), stem = digestPlanning([f.project.projectId, contributionDigest]).slice(0, 24), stageId = `stg:ai-${stem}`, planId = `pln:ai-${adoptionId}`;
  const ids = new Map(original.tasks.map((task) => [task.taskId, digestPlanning([stem, task.taskId]).slice(0, 24)]));
  const taskId = (id: string): string => `tsk:ai-${ids.get(id)!}`;
  const model = Object.freeze({ origin: "model" as const, derivedFrom: null, verbatim: false });
  const fields = (names: readonly string[]) => Object.fromEntries(names.map((name) => [name, model]));
  const source: PlanProposal["source"] = { kind: "model", authority: "none", routeFingerprint, contributionDigest, narrativeRef: input.narrativeRef };
  const proposal = parsePlanProposal({ schemaVersion: 1, projectId: f.project.projectId, briefId: f.accepted.brief.briefId, source,
    stages: [{ stageId, title: original.title, intent: original.title, exitCriteria: original.tasks[0]!.acceptanceCriteria, taskIds: original.tasks.map((task) => taskId(task.taskId)),
      provenance: fields(["title", "intent", ...original.tasks[0]!.acceptanceCriteria.map((_value, at) => `exitCriteria[${at}]`)]) }],
    tasks: original.tasks.map((task) => ({ taskId: taskId(task.taskId), stageId, title: task.title, objective: task.objective,
      requirements: { kind: "implement", complexity: 1, risk: "low", reasoning: "low" }, acceptance: task.acceptanceCriteria.map((criterion) => ({ criterion, validationCommand: null })),
      requirementIds: [`req:ai-${ids.get(task.taskId)!}`], provenance: fields(["title", "objective", ...task.acceptanceCriteria.map((_value, at) => `acceptance[${at}].criterion`)]) })),
    dependencies: original.tasks.flatMap((task) => task.dependsOn.map((dependency) => ({ fromTaskId: taskId(dependency), toTaskId: taskId(task.taskId), kind: "finish-to-start", artifactKind: null }))),
    budgetCeiling: planningCeiling(f).ceiling,
    constraintDispositions: f.accepted.brief.constraints.map((constraint) => ({ constraintId: constraint.constraintId, disposition: "satisfied-by-design", taskId: null, waiverDecisionId: null })),
  });
  const edits: PlanModelFieldEdit[] = [];
  const record = (nodeKind: "stage" | "task", nodeId: string, fieldPath: string, before: string, value: string): void => {
    if (before !== value) edits.push({ nodeKind, nodeId, fieldPath, value });
  };
  record("stage", stageId, "title", original.title, edited.title);
  record("stage", stageId, "intent", original.title, edited.title);
  original.tasks[0]!.acceptanceCriteria.forEach((before, at) => record("stage", stageId, `exitCriteria[${at}]`, before, edited.tasks[0]!.acceptanceCriteria[at]!));
  original.tasks.forEach((task, index) => {
    const next = edited.tasks[index]!, id = taskId(task.taskId);
    record("task", id, "title", task.title, next.title); record("task", id, "objective", task.objective, next.objective);
    task.acceptanceCriteria.forEach((before, at) => record("task", id, `acceptance[${at}].criterion`, before, next.acceptanceCriteria[at]!));
  });
  const adoption = prepareModelPlanAdoption({ proposal, expectedModelProposalDigest: computeModelPlanProposalDigest(proposal, planningHash), edits }, planningHash);
  // This is the operator's exact draft-adoption specification, with retained
  // model contribution references. It does not claim an ADR0016 assembly or a
  // PLN-02 completeness audit ran, and is not the separate scope/seal decision.
  const requirements = edited.tasks.map((task, index) => ({ requirementId: `req:ai-${ids.get(task.taskId)!}`, requirementDigest: digestPlanning({ task, acceptedBrief: f.accepted!.briefContentDigest, contributionDigest }), title: task.objective,
    category: "capability" as const, disposition: "required" as const, decisionId: `ai-adoption:${adoptionId}-${index}`, candidateIds: [`ai-candidate:${ids.get(task.taskId)!}`],
    provenance: [{ contributionId: `ai-contribution:${contributionDigest}`, phaseId: requestId, routeKey: `ai-route:${routeFingerprint.slice(0, 32)}`, sourceFingerprint: contributionDigest, candidateId: `ai-candidate:${ids.get(task.taskId)!}` }], dissentIds: [] }));
  const specificationInput = { schemaVersion: 1 as const, specification: { schemaVersion: 1 as const, specificationId: `product-specification:ai-${adoptionId}`, planId: `ai-adopted-proposal:${adoptionId}`, planVersion: 1,
    intentDigest: f.accepted.briefContentDigest, decisionSetDigest: digestPlanning(requirements), requirements, findingIds: [], questionIds: [], dissentIds: [],
    approvedBy: { actorId: confirmation.identityRef, authority: "product-owner" as const }, approvalReference: confirmation.reviewId, approvedAt: confirmation.confirmedAt,
    approvalDigest: digestPlanning({ confirmation, requirements, originalProposalDigest: computeModelPlanProposalDigest(proposal, planningHash) }) },
    coverage: requirements.map((requirement, index) => ({ requirementId: requirement.requirementId, requirementDigest: requirement.requirementDigest, decisionId: requirement.decisionId, disposition: requirement.disposition, executable: true, taskId: `requirement-task:ai-${ids.get(edited.tasks[index]!.taskId)!}` })),
    taskIdMap: edited.tasks.map((task) => ({ upstreamTaskId: `requirement-task:ai-${ids.get(task.taskId)!}`, planTaskId: taskId(task.taskId) })), waiverBindings: [] };
  const zeroBudget = { maximumInputTokens: 0, maximumOutputTokens: 0, maximumCostMicros: 0, maximumToolCalls: 0, maximumTurns: 0 };
  const preliminary = { schemaVersion: 1 as const, newPlanId: planId, proposal: adoption.proposal, expectedProposalDigest: "0".repeat(64), expectedSpecificationDigest: "0".repeat(64), expectedCoverageDigest: "0".repeat(64),
    taskBudgetAllocations: edited.tasks.map((task) => ({ taskId: taskId(task.taskId), budget: zeroBudget })), specificationInput };
  const bound = { ...preliminary, expectedSpecificationDigest: computeSpecificationDigest(preliminary, planningHash), expectedCoverageDigest: computeCoverageDigest(preliminary, planningHash) };
  const request = parsePlanAssemblyRequest({ ...bound, expectedProposalDigest: computeProposalDigest(bound, planningHash) });
  const sameBrief = prior?.briefId === f.accepted.brief.briefId, revising = prior !== null && prior.state !== "drafting";
  const assembled = assemblePlan(request, f.project, f.accepted, { planId, revision: prior === null || !sameBrief ? 1 : prior.revision + (revising ? 1 : 0),
    supersedes: !sameBrief ? null : revising ? prior!.planId : prior!.supersedes, state: "drafting", createdAt: confirmation.confirmedAt, updatedAt: confirmation.confirmedAt, sealedAt: null }, planningHash);
  const review = { ...assembled.review, authenticatedOperatorEvidence: adoption.authenticatedOperatorEvidence };
  const stamped = prior === null ? null : revising ? supersedeForRevision(prior, confirmation.confirmedAt) : prior;
  const predecessor = stamped === null ? null : { planId: stamped.planId, revision: stamped.revision, supersedes: stamped.supersedes, state: stamped.state, planDigest: stamped.planDigest, sealedAt: stamped.sealedAt, sealedByApprovalId: stamped.sealedByApprovalId };
  const rebase = prior === null || sameBrief ? revising ? null : f.head?.headEvent.payload.rebase ?? null : { kind: "plan.rebased", replaces: prior.planId, replacesRevision: prior.revision,
    previousDisposition: revising ? { kind: "superseded", from: prior.state, to: "superseded" } : { kind: "draft-replaced", from: "drafting" }, ...acceptedPlanningBinding(f.accepted) };
  const event = { schemaVersion: 1, kind: revising ? "plan.revised" : "plan.drafted", operation: revising ? { kind: "revise", mode: sameBrief ? "R1" : "R2" } : { kind: "draft", mode: prior === null ? "create" : "redraft" },
    plan: assembled.plan, controls: f.controls, review, decisions: revising ? [revisionDecision(assembled.plan, confirmation)] : [], predecessor, rebase, seal: null, budgetExtension: null } as unknown as Omit<PlanHeadEventPayload, "binding">;
  return bindPlanningSteps(f, commandId, [{ expectedState: prior?.state ?? null, event }], confirmation.confirmedAt);
}
