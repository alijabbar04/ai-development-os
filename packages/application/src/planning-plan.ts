import { parseBudgetAccountState, type BudgetAccountState } from "@ai-dev-os/domain";
import type { AggregateEnvelope, TransactionContext } from "@ai-dev-os/persistence";
import { isProjectStopActive, parseDecision, parseProject, parseProjectStop, type Decision, type Project, type ProjectPlan, type ProjectStop } from "@ai-dev-os/project";
import { assemblePlan, blockingOpenQuestionIds, computeCoverageDigest, computePlanCommitContentDigest, computeProposalDigest, computeSpecificationDigest, parsePlanAssemblyRequest, parsePlanCommitRequest, projectStopSnapshotDigestMaterial, resolveProjectCeiling, supersedeForRevision,
  type AcceptedBriefBinding, type AcceptedBriefHead, type AuthenticatedOperatorClaimEvidence, type PlanAssemblyRequest, type PlanCommitRequest, type PlanHeadEventPayload, type PlanLineageHead, type PlanMutationControlEvidence, type PlanReviewEvidence } from "@ai-dev-os/plan";
import { createPlanPersistenceBoundary } from "@ai-dev-os/plan/persistence-boundary";
import type { PlanningCommand } from "./planning-contracts.js";
import { listPlanningAggregates, planningTransactionAdapter, verifyPlanningEnvelope, type PlanningConfirmation } from "./planning-ledger.js";
import { digestPlanning, planningHash, refusePlanning } from "./planning-validation.js";

export interface PlanningFoundations {
  readonly project: Project; readonly projectEnvelope: AggregateEnvelope;
  readonly budget: BudgetAccountState; readonly budgetEnvelope: AggregateEnvelope;
  readonly stops: readonly ProjectStop[]; readonly stopped: boolean;
  readonly accepted: AcceptedBriefHead | null; readonly head: PlanLineageHead | null;
  readonly controls: PlanMutationControlEvidence;
}
export async function readPlanningFoundations(tx: TransactionContext, projectId: string): Promise<PlanningFoundations> {
  const projectEnvelope = await tx.aggregates.get("project", projectId);
  if (projectEnvelope === null) return refusePlanning("project.absent");
  verifyPlanningEnvelope(projectEnvelope, "project", projectId);
  let project: Project;
  try { project = parseProject(projectEnvelope.payload); } catch { return refusePlanning("project.corrupt", "corrupt"); }
  if (project.projectId !== projectId) return refusePlanning("project.identity-corrupt", "corrupt");
  const budgetEnvelope = await tx.aggregates.get("budget-account", project.budgetAccountId);
  if (budgetEnvelope === null) return refusePlanning("budget.absent");
  verifyPlanningEnvelope(budgetEnvelope, "budget-account", project.budgetAccountId);
  let budget: BudgetAccountState;
  try { budget = parseBudgetAccountState(budgetEnvelope.payload); } catch { return refusePlanning("budget.corrupt", "corrupt"); }
  if (budget.scope.scopeType !== "project" || budget.scope.scopeId !== projectId) return refusePlanning("budget.binding-corrupt", "corrupt");
  const matching: AggregateEnvelope[] = [], stops: ProjectStop[] = [];
  for (const row of await listPlanningAggregates(tx, "project-stop")) {
    let stop: ProjectStop; try { stop = parseProjectStop(row.payload); } catch { return refusePlanning("stop.corrupt", "corrupt"); }
    if (stop.projectStopId !== row.aggregateId) return refusePlanning("stop.identity-corrupt", "corrupt");
    if (stop.projectId === projectId) { matching.push(row); stops.push(stop); }
  }
  const store = createPlanPersistenceBoundary(planningTransactionAdapter(tx), { take: () => null });
  const acceptedRead = await store.readAcceptedBriefHead(projectId), headRead = await store.readHead(projectId);
  if (acceptedRead.kind === "invalid-proof" || headRead.kind === "corrupt") return refusePlanning("planning.history-corrupt", "corrupt");
  if (acceptedRead.kind === "unresolved" || headRead.kind === "unavailable") return refusePlanning("planning.history-unavailable");
  return Object.freeze({ project, projectEnvelope, budget, budgetEnvelope, stops: Object.freeze(stops), stopped: stops.some(isProjectStopActive),
    accepted: acceptedRead.kind === "accepted" ? acceptedRead.head : null, head: headRead.kind === "head" ? headRead.head : null,
    controls: Object.freeze({ projectAggregateVersion: projectEnvelope.aggregateVersion, projectContentDigest: projectEnvelope.checksum.hex, projectStatus: "active", activeProjectStopIds: Object.freeze([] as const),
      projectStopSnapshotDigest: projectStopSnapshotDigestMaterial(projectId, matching as unknown as readonly Readonly<Record<string, unknown>>[], planningHash) }),
  });
}
export function assertPlanningAdmission(f: PlanningFoundations): void {
  if (f.project.status !== "active") return refusePlanning("project.not-active");
  if (f.stopped) return refusePlanning("project.stopped");
}
export function acceptedPlanningBinding(head: AcceptedBriefHead): AcceptedBriefBinding {
  return Object.freeze({ projectId: head.projectId, briefId: head.brief.briefId, briefAggregateVersion: head.aggregateVersion, briefContentDigest: head.briefContentDigest, acceptedCandidateDigest: head.acceptedCandidateDigest, acceptanceEventId: head.acceptanceEventId });
}
export function planningCeiling(f: PlanningFoundations) {
  if (f.accepted === null) return refusePlanning("brief.acceptance-required");
  return resolveProjectCeiling(f.project.budgetAccountId, f.budget, { aggregateVersion: f.budgetEnvelope.aggregateVersion, contentDigest: f.budgetEnvelope.checksum.hex }, f.accepted);
}
export function planningDecision(kind: "scope-accepted" | "plan-revision-accepted", plan: ProjectPlan, confirmation: PlanningConfirmation): Decision {
  const material = { schemaVersion: 1, revision: 1, projectId: plan.projectId, scope: { planId: plan.planId, planRevision: plan.revision, stageId: null, taskId: null }, kind, decidedBy: "operator",
    statement: kind === "scope-accepted" ? "The operator accepted this exact local planning scope." : "The operator accepted this exact manual plan revision.", rationale: null,
    supersedes: null, subjectDigest: plan.planDigest, decidedAt: confirmation.confirmedAt };
  return parseDecision({ ...material, decisionId: `dec:${digestPlanning(material).slice(0, 32)}` });
}
export type PlanningUnboundStep = Readonly<{ expectedState: ProjectPlan["state"] | null; event: Omit<PlanHeadEventPayload, "binding"> }>;
export function bindPlanningSteps(f: PlanningFoundations, commandId: string, steps: readonly PlanningUnboundStep[], at: string): PlanCommitRequest {
  if (f.accepted === null || steps.length < 1 || steps.length > 2) return refusePlanning("plan.binding-unavailable");
  const accepted = acceptedPlanningBinding(f.accepted), version = f.head?.aggregateVersion ?? 0, previousId = f.head?.plan.planId ?? null;
  const raw = { schemaVersion: 1, projectId: f.project.projectId, binding: { contentDigest: "0".repeat(64), expectedHeadPlanId: previousId, expectedAggregateVersion: version }, acceptedBrief: accepted, expectedControls: f.controls,
    steps: steps.map((step, index) => ({ eventId: `plan-event:${digestPlanning([commandId, index]).slice(0, 32)}`, expectedState: step.expectedState, plan: step.event.plan, envelope: { occurredAt: at, traceId: null, causationId: commandId },
      event: { ...step.event, binding: { ...accepted, contentDigest: "0".repeat(64), planId: step.event.plan.planId, planRevision: step.event.plan.revision, planDigest: step.event.plan.planDigest,
        proposalDigest: step.event.review.proposalDigest, expectedHeadPlanId: previousId, expectedAggregateVersion: version, resultAggregateVersion: version + index + 1, resultState: step.event.plan.state,
        headAdvanced: true, stepIndex: index + 1, stepCount: steps.length, briefBlockingQuestionIds: blockingOpenQuestionIds(f.accepted!.brief) } } })),
  } as unknown as PlanCommitRequest;
  const contentDigest = computePlanCommitContentDigest(raw, planningHash);
  return parsePlanCommitRequest({ ...raw, binding: { ...raw.binding, contentDigest }, steps: raw.steps.map((step) => ({ ...step, event: { ...step.event, binding: { ...step.event.binding, contentDigest } } })) }, planningHash);
}
function manualAssembly(command: Extract<PlanningCommand, { kind: "save-plan" }>, f: PlanningFoundations, confirmation: PlanningConfirmation): PlanAssemblyRequest {
  if (f.accepted === null) return refusePlanning("brief.acceptance-required");
  const id = digestPlanning(command.commandId).slice(0, 24), stageId = `stg:${id}`, planId = `pln:${id}`;
  const provenance = Object.freeze({ origin: "operator" as const, derivedFrom: null, verbatim: true });
  const ids = command.tasks.map((_task, index) => `${id}-${index.toString().padStart(2, "0")}`);
  const requirements = command.tasks.map((task, index) => ({ requirementId: `req:${ids[index]}`, requirementDigest: digestPlanning(task), title: task.objective, category: "capability" as const,
    disposition: "required" as const, decisionId: `scope-decision:${ids[index]}`, candidateIds: [], provenance: [], dissentIds: [] }));
  // This is an operator-authored specification adapter, with a real native
  // confirmation reference. It does not invent model contributions or run PLN-02.
  const specificationInput = { schemaVersion: 1 as const, specification: { schemaVersion: 1 as const, specificationId: `product-specification:${id}`, planId: `manual-plan:${id}`, planVersion: 1,
    intentDigest: f.accepted.briefContentDigest, decisionSetDigest: digestPlanning(requirements), requirements, findingIds: [], questionIds: [], dissentIds: [],
    approvedBy: { actorId: confirmation.identityRef, authority: "product-owner" as const }, approvalReference: confirmation.reviewId, approvedAt: confirmation.confirmedAt,
    approvalDigest: digestPlanning({ confirmation, requirements }) },
    coverage: requirements.map((r, index) => ({ requirementId: r.requirementId, requirementDigest: r.requirementDigest, decisionId: r.decisionId, disposition: r.disposition, executable: true, taskId: `requirement-task:${ids[index]}` })),
    taskIdMap: ids.map((id) => ({ upstreamTaskId: `requirement-task:${id}`, planTaskId: `tsk:${id}` })), waiverBindings: [],
  };
  const zeroBudget = { maximumInputTokens: 0, maximumOutputTokens: 0, maximumCostMicros: 0, maximumToolCalls: 0, maximumTurns: 0 };
  const proposal = { schemaVersion: 1 as const, projectId: f.project.projectId, briefId: f.accepted.brief.briefId, source: { kind: "operator" as const, authority: "none" as const },
    stages: [{ stageId, title: command.title, intent: command.title, exitCriteria: command.tasks[0]!.acceptanceCriteria, taskIds: ids.map((id) => `tsk:${id}`),
      provenance: Object.fromEntries([["title", provenance], ["intent", provenance], ...command.tasks[0]!.acceptanceCriteria.map((_value, index) => [`exitCriteria[${index}]`, provenance])]) }],
    tasks: command.tasks.map((task, index) => ({ taskId: `tsk:${ids[index]}`, stageId, title: task.title, objective: task.objective,
      requirements: { kind: "implement" as const, complexity: 1 as const, risk: "low" as const, reasoning: "low" as const }, acceptance: task.acceptanceCriteria.map((criterion) => ({ criterion, validationCommand: null })),
      requirementIds: [requirements[index]!.requirementId], provenance: Object.fromEntries([["title", provenance], ["objective", provenance], ...task.acceptanceCriteria.map((_value, index) => [`acceptance[${index}].criterion`, provenance])]) })),
    dependencies: [], budgetCeiling: planningCeiling(f).ceiling,
    constraintDispositions: f.accepted.brief.constraints.map((c) => ({ constraintId: c.constraintId, disposition: "satisfied-by-design" as const, taskId: null, waiverDecisionId: null })),
  };
  const preliminary = { schemaVersion: 1 as const, newPlanId: planId, proposal, expectedProposalDigest: "0".repeat(64), expectedSpecificationDigest: "0".repeat(64), expectedCoverageDigest: "0".repeat(64),
    taskBudgetAllocations: ids.map((id) => ({ taskId: `tsk:${id}`, budget: zeroBudget })), specificationInput };
  const digestBound = { ...preliminary, expectedSpecificationDigest: computeSpecificationDigest(preliminary, planningHash), expectedCoverageDigest: computeCoverageDigest(preliminary, planningHash) };
  return parsePlanAssemblyRequest({ ...digestBound, expectedProposalDigest: computeProposalDigest(digestBound, planningHash) });
}
export function operatorPlanningEvidence(review: PlanReviewEvidence): readonly AuthenticatedOperatorClaimEvidence[] {
  const proposal = review.assemblyRequest.proposal;
  return Object.freeze([
    ...proposal.stages.flatMap((stage) => [{ nodeKind: "stage" as const, nodeId: stage.stageId, fieldPath: "title", value: stage.title }, { nodeKind: "stage" as const, nodeId: stage.stageId, fieldPath: "intent", value: stage.intent }, ...stage.exitCriteria.map((value, index) => ({ nodeKind: "stage" as const, nodeId: stage.stageId, fieldPath: `exitCriteria[${index}]`, value }))]),
    ...proposal.tasks.flatMap((task) => [{ nodeKind: "task" as const, nodeId: task.taskId, fieldPath: "title", value: task.title }, { nodeKind: "task" as const, nodeId: task.taskId, fieldPath: "objective", value: task.objective }, ...task.acceptance.map((item, index) => ({ nodeKind: "task" as const, nodeId: task.taskId, fieldPath: `acceptance[${index}].criterion`, value: item.criterion }))]),
  ]) as readonly AuthenticatedOperatorClaimEvidence[];
}
export function draftPlanningRequest(command: Extract<PlanningCommand, { kind: "save-plan" }>, f: PlanningFoundations, confirmation: PlanningConfirmation): PlanCommitRequest {
  assertPlanningAdmission(f);
  if (f.accepted === null) return refusePlanning("brief.acceptance-required");
  const prior = f.head?.plan ?? null;
  if (prior !== null && !["drafting", "proposed", "sealed"].includes(prior.state)) return refusePlanning("plan.revision-unavailable");
  const sameBrief = prior?.briefId === f.accepted.brief.briefId, revising = prior !== null && prior.state !== "drafting";
  const request = manualAssembly(command, f, confirmation);
  const assembled = assemblePlan(request, f.project, f.accepted, { planId: request.newPlanId, revision: prior === null || !sameBrief ? 1 : prior.revision + (revising ? 1 : 0),
    supersedes: !sameBrief ? null : revising ? prior!.planId : prior!.supersedes, state: "drafting", createdAt: confirmation.confirmedAt, updatedAt: confirmation.confirmedAt, sealedAt: null }, planningHash);
  const review = { ...assembled.review, authenticatedOperatorEvidence: operatorPlanningEvidence(assembled.review) };
  const stamped = prior === null ? null : revising ? supersedeForRevision(prior, confirmation.confirmedAt) : prior;
  const predecessor = stamped === null ? null : { planId: stamped.planId, revision: stamped.revision, supersedes: stamped.supersedes, state: stamped.state, planDigest: stamped.planDigest, sealedAt: stamped.sealedAt, sealedByApprovalId: stamped.sealedByApprovalId };
  const rebase = prior === null || sameBrief ? revising ? null : f.head?.headEvent.payload.rebase ?? null : { kind: "plan.rebased", replaces: prior.planId, replacesRevision: prior.revision,
    previousDisposition: revising ? { kind: "superseded", from: prior.state, to: "superseded" } : { kind: "draft-replaced", from: "drafting" }, ...acceptedPlanningBinding(f.accepted) };
  const event = { schemaVersion: 1, kind: revising ? "plan.revised" : "plan.drafted", operation: revising ? { kind: "revise", mode: sameBrief ? "R1" : "R2" } : { kind: "draft", mode: prior === null ? "create" : "redraft" },
    plan: assembled.plan, controls: f.controls, review, decisions: revising ? [planningDecision("plan-revision-accepted", assembled.plan, confirmation)] : [], predecessor, rebase, seal: null, budgetExtension: null } as unknown as Omit<PlanHeadEventPayload, "binding">;
  return bindPlanningSteps(f, command.commandId, [{ expectedState: prior?.state ?? null, event }], confirmation.confirmedAt);
}
