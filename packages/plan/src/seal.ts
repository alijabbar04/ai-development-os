import { compareCanonicalIds } from "./order.js";
import {
  parseApprovalRequest,
  parseProjectPlan,
  serializeCanonicalProjectJson,
  type ApprovalRequest,
  type Decision,
  type ProjectBrief,
  type ProjectPlan,
} from "@ai-dev-os/project";
import { EXECUTABLE_DISPOSITIONS } from "./constants.js";
import type {
  AcceptedBriefHead,
  AuthenticatedOperatorClaimEvidence,
  PlanDigestPort,
  PlanReviewEvidence,
  PlanSealConditionVerdict,
  ResolvedProjectCeilingEvidence,
  SealEvaluationInput,
} from "./contracts.js";
import { assertPlanBounds, computePlanOrder } from "./assembly.js";
import { refusePlan } from "./errors.js";
import {
  assertOperatorEvidenceTargets,
  exactKeys,
  planDigest,
  planIdentifier,
  safeInteger,
  strictRecord,
} from "./validation.js";

export interface ParsedBudgetAccountLike {
  readonly schemaVersion: 1;
  readonly scope: Readonly<{ scopeType: string; scopeId: string }>;
  readonly budget: Readonly<{
    tokens: Readonly<{
      maxTotalTokens: number;
      maxInputTokens: number | null;
      maxOutputTokens: number | null;
      softMaxTotalTokens: number | null;
    }> | null;
    money: Readonly<{
      limit: Readonly<{ currency: string; amountMicros: number }>;
      softLimit: Readonly<{ currency: string; amountMicros: number }> | null;
    }> | null;
    time: unknown | null;
  }>;
  readonly status: string;
  readonly version: number;
  readonly reservations: readonly unknown[];
}

export interface BudgetAccountEnvelopeEvidence {
  readonly aggregateVersion: number;
  readonly contentDigest: string;
}

function minimum(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.min(...values);
}

function parseHardBudgetMoney(value: unknown): Readonly<{ currency: string; maximumCostMicros: number }> {
  const input = strictRecord(value, "planBudget");
  exactKeys(input, ["currency", "maximumCostMicros"], "planBudget");
  if (typeof input["currency"] !== "string" || !/^[A-Z]{3}$/u.test(input["currency"])) {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.constraint.machine-form-unrecognised", "planConstraint");
  }
  return Object.freeze({ currency: input["currency"], maximumCostMicros: safeInteger(input["maximumCostMicros"], "planBudget") });
}

function parseHardBudgetTokens(value: unknown): ProjectPlan["budgetCeiling"] {
  const input = strictRecord(value, "planBudget");
  exactKeys(input, ["maximumInputTokens", "maximumOutputTokens", "maximumToolCalls", "maximumTurns"], "planBudget");
  return Object.freeze({
    maximumInputTokens: safeInteger(input["maximumInputTokens"], "planBudget", 1_000_000_000_000),
    maximumOutputTokens: safeInteger(input["maximumOutputTokens"], "planBudget", 1_000_000_000_000),
    maximumCostMicros: 0,
    maximumToolCalls: safeInteger(input["maximumToolCalls"], "planBudget", 100_000),
    maximumTurns: safeInteger(input["maximumTurns"], "planBudget", 100_000),
  });
}

export function resolveProjectCeiling(
  budgetAccountId: string,
  account: ParsedBudgetAccountLike,
  accountEnvelope: BudgetAccountEnvelopeEvidence,
  brief: AcceptedBriefHead,
): ResolvedProjectCeilingEvidence {
  if (account.status !== "open" || account.scope.scopeType !== "project" || account.scope.scopeId !== brief.projectId) {
    refusePlan("PLAN_PRECONDITION_REFUSED", "plan.budget.ceiling-conflict", "planBudget");
  }
  const inputCandidates: number[] = [];
  const outputCandidates: number[] = [];
  const costCandidates: number[] = [];
  const toolCandidates: number[] = [];
  const turnCandidates: number[] = [];
  const accountTokens = account.budget.tokens;
  const accountMoney = account.budget.money;
  const accountMaximumTotalTokens = accountTokens?.maxTotalTokens ?? null;
  if (accountTokens !== null) {
    inputCandidates.push(accountTokens.maxInputTokens ?? accountTokens.maxTotalTokens);
    outputCandidates.push(accountTokens.maxOutputTokens ?? accountTokens.maxTotalTokens);
  }
  if (accountMoney !== null) costCandidates.push(accountMoney.limit.amountMicros);
  else costCandidates.push(0);

  for (const constraint of brief.brief.constraints) {
    if (constraint.enforcement !== "hard") continue;
    if (constraint.kind === "budget-tokens") {
      const parsed = parseHardBudgetTokens(constraint.machineForm);
      const accountInput = accountTokens === null ? null : accountTokens.maxInputTokens ?? accountTokens.maxTotalTokens;
      const accountOutput = accountTokens === null ? null : accountTokens.maxOutputTokens ?? accountTokens.maxTotalTokens;
      if (accountInput !== null && parsed.maximumInputTokens > accountInput
        || accountOutput !== null && parsed.maximumOutputTokens > accountOutput) {
        refusePlan("PLAN_PRECONDITION_REFUSED", "plan.budget.ceiling-conflict", "planBudget");
      }
      inputCandidates.push(parsed.maximumInputTokens);
      outputCandidates.push(parsed.maximumOutputTokens);
      toolCandidates.push(parsed.maximumToolCalls);
      turnCandidates.push(parsed.maximumTurns);
      continue;
    }
    if (constraint.kind === "budget-money") {
      const parsed = parseHardBudgetMoney(constraint.machineForm);
      if (accountMoney !== null && (parsed.currency !== accountMoney.limit.currency || parsed.maximumCostMicros > accountMoney.limit.amountMicros)) {
        refusePlan("PLAN_PRECONDITION_REFUSED", "plan.budget.ceiling-conflict", "planBudget");
      }
      costCandidates.push(parsed.maximumCostMicros);
      continue;
    }
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.constraint.machine-form-unrecognised", "planConstraint");
  }

  return Object.freeze({
    budgetAccountId,
    budgetAccountAggregateVersion: accountEnvelope.aggregateVersion,
    budgetAccountContentDigest: planDigest(accountEnvelope.contentDigest, "planBudget"),
    budgetAccountStateVersion: account.version,
    briefContentDigest: brief.briefContentDigest,
    accountMaximumTotalTokens,
    ceiling: Object.freeze({
      maximumInputTokens: minimum(inputCandidates),
      maximumOutputTokens: minimum(outputCandidates),
      maximumCostMicros: minimum(costCandidates),
      maximumToolCalls: minimum(toolCandidates),
      maximumTurns: minimum(turnCandidates),
    }),
  });
}

export function blockingOpenQuestionIds(brief: ProjectBrief): readonly string[] {
  return Object.freeze(brief.openQuestions.filter((question) => question.blocking).map((question) => question.questionId).sort());
}

function condition(condition: 1 | 2 | 3 | 4 | 5 | 6, rules: readonly string[]): PlanSealConditionVerdict {
  const ruleIds = Object.freeze([...new Set(rules)].sort());
  return Object.freeze({ condition, passed: ruleIds.length === 0, ruleIds });
}

function sameDecision(left: Decision, right: Decision): boolean {
  return serializeCanonicalProjectJson(left) === serializeCanonicalProjectJson(right);
}

function authenticatedDecision(
  id: string,
  decisions: readonly Decision[],
  kind: Decision["kind"],
  plan: ProjectPlan,
): boolean {
  return decisions.some((decision) => decision.decisionId === id
    && decision.kind === kind
    && decision.projectId === plan.projectId
    && decision.scope.planId === plan.planId
    && decision.scope.planRevision === plan.revision);
}

function operatorEvidenceKey(row: AuthenticatedOperatorClaimEvidence): string {
  return `${row.nodeKind}|${row.nodeId}|${row.fieldPath}|${row.value}`;
}

export function assertAuthenticatedOperatorEvidence(
  review: PlanReviewEvidence,
  issuedRows: readonly AuthenticatedOperatorClaimEvidence[],
): void {
  const issued = new Set(issuedRows.map(operatorEvidenceKey));
  if (issued.size !== issuedRows.length
    || review.authenticatedOperatorEvidence.length !== issuedRows.length
    || review.authenticatedOperatorEvidence.some((row) => !issued.has(operatorEvidenceKey(row)))) {
    refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.provenance.operator-claim-unbacked", "planProposal");
  }
  assertOperatorEvidenceTargets(review.assemblyRequest, issuedRows);
}

function fieldValue(
  node: PlanReviewEvidence["assemblyRequest"]["proposal"]["stages"][number] | PlanReviewEvidence["assemblyRequest"]["proposal"]["tasks"][number],
  path: string,
): string | null {
  if (path === "title") return node.title;
  if ("intent" in node) {
    if (path === "intent") return node.intent;
    const match = /^exitCriteria\[(\d+)\]$/u.exec(path);
    return match === null ? null : node.exitCriteria[Number(match[1])] ?? null;
  }
  if (path === "objective") return node.objective;
  const match = /^acceptance\[(\d+)\]\.criterion$/u.exec(path);
  return match === null ? null : node.acceptance[Number(match[1])]?.criterion ?? null;
}

function hasMaterialInference(input: SealEvaluationInput): boolean {
  const binding = input.review.specification;
  if (binding === null) return false;
  const evidence = new Set(input.review.authenticatedOperatorEvidence.map(operatorEvidenceKey));
  const stageById = new Map(input.plan.stages.map((stage) => [stage.stageId, stage]));
  const taskById = new Map(input.plan.tasks.map((task) => [task.taskId, task]));
  const proposalStage = new Map(input.review.assemblyRequest.proposal.stages.map((stage) => [stage.stageId, stage]));
  const proposalTask = new Map(input.review.assemblyRequest.proposal.tasks.map((task) => [task.taskId, task]));

  for (const requirement of binding.requirements) {
    if (!(["required", "expected-quality"] as readonly string[]).includes(requirement.disposition)) continue;
    if (requirement.sourceProvenance.length > 0) return true;
    if (requirement.taskId === null) continue;
    const task = taskById.get(requirement.taskId);
    const stage = task === undefined ? undefined : stageById.get(task.stageId);
    const nodes = [
      ...(task === undefined ? [] : [{ kind: "task" as const, id: task.taskId, fields: proposalTask.get(task.taskId)?.provenance }]),
      ...(stage === undefined ? [] : [{ kind: "stage" as const, id: stage.stageId, fields: proposalStage.get(stage.stageId)?.provenance }]),
    ];
    for (const node of nodes) {
      for (const [path, row] of Object.entries(node.fields ?? {})) {
        if (row.origin === "model" || row.origin === "operator-edit" || row.origin === "specification" || row.origin === "brief" && !row.verbatim) return true;
        if (row.origin === "operator") {
          const value = fieldValue(node.kind === "stage" ? proposalStage.get(node.id)! : proposalTask.get(node.id)!, path);
          if (value === null || !evidence.has(`${node.kind}|${node.id}|${path}|${value}`)) return true;
        }
      }
    }
  }
  return false;
}

export function scopeApprovalSatisfiesCondition6(
  approvalValue: ApprovalRequest | null,
  plan: ProjectPlan,
): boolean {
  if (approvalValue === null) return false;
  let approval: ApprovalRequest;
  try { approval = parseApprovalRequest(approvalValue); }
  catch { return false; }
  return approval.class === "scope-expansion"
    && approval.state === "consumed"
    && approval.subjectDigest === plan.planDigest
    && approval.scope.projectId === plan.projectId
    && approval.scope.taskId === null
    && approval.scope.providerInstanceId === null
    && approval.scope.workspaceId === null;
}

function coverageRules(input: SealEvaluationInput): readonly string[] {
  const binding = input.review.specification;
  if (binding === null || binding.requirements.length === 0) {
    return ["plan.seal.condition-3", "plan.specification.absent"];
  }
  const rules: string[] = [];
  for (const requirement of binding.requirements) {
    const executable = (EXECUTABLE_DISPOSITIONS as readonly string[]).includes(requirement.disposition);
    if (requirement.executable !== executable) rules.push("plan.coverage.executable-mismatch");
    if (!executable && requirement.taskId !== null) rules.push("plan.coverage.non-executable-covered");
    if ((["required", "expected-quality"] as readonly string[]).includes(requirement.disposition)
      && requirement.taskId === null
      && (requirement.waiverDecisionId === null || !authenticatedDecision(requirement.waiverDecisionId, input.authenticatedDecisions, "waiver-granted", input.plan))) {
      rules.push("plan.seal.condition-3");
    }
    if (requirement.disposition === "waived"
      && (requirement.taskId !== null || requirement.waiverDecisionId === null || !authenticatedDecision(requirement.waiverDecisionId, input.authenticatedDecisions, "waiver-granted", input.plan))) {
      rules.push("plan.coverage.waiver-unbound", "plan.seal.condition-3");
    }
  }
  for (const task of input.plan.tasks) {
    if (!binding.requirements.some((requirement) => requirement.taskId === task.taskId)) {
      rules.push("plan.coverage.unmapped-task", "plan.seal.condition-3");
    }
  }
  return rules;
}

function constraintRules(input: SealEvaluationInput): readonly string[] {
  const rules: string[] = [];
  const dispositions = new Map(input.review.constraintDispositions.map((item) => [item.constraintId, item]));
  for (const constraint of input.acceptedBrief.brief.constraints) {
    const disposition = dispositions.get(constraint.constraintId);
    if (disposition === undefined) rules.push("plan.constraint.no-disposition", "plan.seal.condition-4");
    if (constraint.enforcement === "hard" && !["budget-money", "budget-tokens"].includes(constraint.kind)) {
      rules.push("plan.constraint.machine-form-unrecognised", "plan.seal.condition-4");
    }
    if (disposition?.disposition === "waived-by-decision"
      && (disposition.waiverDecisionId === null || !authenticatedDecision(disposition.waiverDecisionId, input.authenticatedDecisions, "waiver-granted", input.plan))) {
      rules.push("plan.constraint.waiver-unbound", "plan.seal.condition-4");
    }
  }
  return rules;
}

function budgetRules(plan: ProjectPlan, evidence: ResolvedProjectCeilingEvidence): readonly string[] {
  const value = plan.budgetCeiling;
  const maximum = evidence.ceiling;
  const ordinary = value.maximumInputTokens <= maximum.maximumInputTokens
    && value.maximumOutputTokens <= maximum.maximumOutputTokens
    && value.maximumCostMicros <= maximum.maximumCostMicros
    && value.maximumToolCalls <= maximum.maximumToolCalls
    && value.maximumTurns <= maximum.maximumTurns;
  const total = evidence.accountMaximumTotalTokens;
  const combined = total === null || value.maximumInputTokens <= total
    && value.maximumOutputTokens <= total - value.maximumInputTokens;
  return ordinary && combined ? [] : ["plan.seal.condition-5"];
}

export function evaluateSealConditions(input: SealEvaluationInput): readonly [
  PlanSealConditionVerdict & Readonly<{ condition: 1 }>,
  PlanSealConditionVerdict & Readonly<{ condition: 2 }>,
  PlanSealConditionVerdict & Readonly<{ condition: 3 }>,
  PlanSealConditionVerdict & Readonly<{ condition: 4 }>,
  PlanSealConditionVerdict & Readonly<{ condition: 5 }>,
  PlanSealConditionVerdict & Readonly<{ condition: 6 }>,
] {
  const condition1: string[] = [];
  try {
    parseProjectPlan(input.plan);
    computePlanOrder(input.plan);
  } catch { condition1.push("plan.seal.condition-1"); }
  const condition2: string[] = [];
  try { assertPlanBounds(input.plan); }
  catch (error) {
    const rule = error instanceof Error && "ruleId" in error && typeof error.ruleId === "string" ? error.ruleId : "plan.seal.condition-2";
    condition2.push("plan.seal.condition-2", rule);
  }
  const condition3 = coverageRules(input);
  const condition4 = constraintRules(input);
  const condition5 = budgetRules(input.plan, input.resolvedProjectCeiling);
  const materialInference = hasMaterialInference(input);
  const condition6 = materialInference && !scopeApprovalSatisfiesCondition6(input.scopeApproval, input.plan)
    ? ["plan.seal.condition-6"]
    : [];
  return Object.freeze([
    condition(1, condition1) as PlanSealConditionVerdict & Readonly<{ condition: 1 }>,
    condition(2, condition2) as PlanSealConditionVerdict & Readonly<{ condition: 2 }>,
    condition(3, condition3) as PlanSealConditionVerdict & Readonly<{ condition: 3 }>,
    condition(4, condition4) as PlanSealConditionVerdict & Readonly<{ condition: 4 }>,
    condition(5, condition5) as PlanSealConditionVerdict & Readonly<{ condition: 5 }>,
    condition(6, condition6) as PlanSealConditionVerdict & Readonly<{ condition: 6 }>,
  ]);
}

export function assertSealConditions(input: SealEvaluationInput): ReturnType<typeof evaluateSealConditions> {
  const verdicts = evaluateSealConditions(input);
  const failed = verdicts.find((verdict) => !verdict.passed);
  if (failed !== undefined) {
    refusePlan("PLAN_SEAL_CONDITION_FAILED", `plan.seal.condition-${failed.condition}`, "planSeal", failed.condition);
  }
  const blocking = blockingOpenQuestionIds(input.acceptedBrief.brief);
  if (blocking.length > 0) refusePlan("PLAN_PRECONDITION_REFUSED", "plan.brief.blocking-unanswered", "planBrief");
  return verdicts;
}

export function decisionsMatchAuthorization(values: readonly Decision[], issued: readonly Decision[]): boolean {
  return values.length === issued.length && values.every((decision) => issued.some((candidate) => sameDecision(decision, candidate)));
}

export function projectStopSnapshotDigestMaterial(
  projectId: string,
  stops: readonly Readonly<Record<string, unknown>>[],
  digest: PlanDigestPort,
): string {
  const checkedProjectId = planIdentifier(projectId, "prj:", "planStore");
  const sorted = [...stops].sort((left, right) => compareCanonicalIds(String(left["aggregateId"]), String(right["aggregateId"]))
    || Number(left["aggregateVersion"]) - Number(right["aggregateVersion"]));
  try {
    return planDigest(
      digest.sha256(serializeCanonicalProjectJson({ schemaVersion: 1, projectId: checkedProjectId, stops: sorted })),
      "planStore",
    );
  } catch {
    return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.digest-mismatch", "planStore");
  }
}
