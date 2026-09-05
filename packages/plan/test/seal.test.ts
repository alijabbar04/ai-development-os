import { describe, expect, it } from "vitest";
import { parseApprovalRequest, parseProjectPlan, type ApprovalRequest } from "@ai-dev-os/project";
import {
  assemblePlan,
  computeCoverageDigest,
  computeProposalDigest,
  computeSpecificationDigest,
  evaluateSealConditions,
  parsePlanAssemblyRequest,
  projectSealReadinessView,
  resolveProjectCeiling,
  scopeApprovalSatisfiesCondition6,
  type PlanAssemblyRequest,
  type SealEvaluationInput,
} from "../src/index.js";
import { planSha256 } from "../src/testing/index.js";
import { SHA_A, SHA_B, T0, T1, acceptedHead, budgetAccount, project, projectionContext, rawAssemblyRequest } from "./fixtures.js";

function rebound(value: unknown): PlanAssemblyRequest {
  const input = structuredClone(value) as Record<string, unknown>;
  input["expectedProposalDigest"] = "0".repeat(64);
  input["expectedSpecificationDigest"] = "0".repeat(64);
  input["expectedCoverageDigest"] = "0".repeat(64);
  const specification = computeSpecificationDigest(input, planSha256);
  const coverage = computeCoverageDigest(input, planSha256);
  const upstream = { ...input, expectedSpecificationDigest: specification, expectedCoverageDigest: coverage };
  return parsePlanAssemblyRequest({ ...upstream, expectedProposalDigest: computeProposalDigest(upstream, planSha256) });
}

function evaluation(request: PlanAssemblyRequest = rawAssemblyRequest()): SealEvaluationInput {
  const accepted = acceptedHead();
  const projectValue = project();
  const result = assemblePlan(request, projectValue, accepted, {
    planId: request.newPlanId, revision: 1, supersedes: null, state: "proposed",
    createdAt: T0, updatedAt: T1, sealedAt: null,
  }, planSha256);
  const ceiling = resolveProjectCeiling(projectValue.budgetAccountId, budgetAccount(), {
    aggregateVersion: 1,
    contentDigest: SHA_A,
  }, accepted);
  return Object.freeze({
    plan: result.plan,
    review: result.review,
    acceptedBrief: accepted,
    project: projectValue,
    controls: {
      projectAggregateVersion: 1,
      projectContentDigest: SHA_A,
      projectStatus: "active",
      projectStopSnapshotDigest: SHA_B,
      activeProjectStopIds: [],
    },
    resolvedProjectCeiling: ceiling,
    authenticatedDecisions: [],
    scopeApproval: null,
  });
}

function consumedScopeApproval(input: SealEvaluationInput): ApprovalRequest {
  return parseApprovalRequest({
    schemaVersion: 1,
    approvalRequestId: "apr:plan-scope",
    class: "scope-expansion",
    actions: ["approval"],
    risk: "high",
    scope: { projectId: input.plan.projectId, taskId: null, providerInstanceId: null, workspaceId: null, operationId: null, traceId: null },
    subjectDigest: input.plan.planDigest,
    subjectSummary: {
      what: "Approve inferred plan scope.", why: "Condition six requires it.", changes: "No execution authority.",
      where: "The project plan.", reversible: false, scope: "One exact plan.",
      effects: ["Approve the exact inferred scope."], exclusions: ["No task execution."],
    },
    usage: "one-shot",
    scopePattern: null,
    consumptionCeiling: null,
    consumptionCount: 1,
    retryAllowance: 0,
    effects: ["Approve the exact inferred scope."],
    exclusions: ["No task execution."],
    money: null,
    requestedBy: { kind: "system", runId: null, reason: "The plan contains inferred scope." },
    state: "consumed",
    createdAt: T0,
    expiresAt: "2026-09-05T10:00:00.000Z",
    decidedAt: T0,
    approverClass: "user",
    consumedAt: T0,
    revokedAt: null,
    voidedBy: null,
  });
}

describe("G-1..G-14 six-condition sealing", () => {
  it("passes all six conditions for complete non-inferred scope", () => {
    const input = evaluation();
    expect(evaluateSealConditions(input).map((row) => [row.condition, row.passed, row.ruleIds])).toEqual([
      [1, true, []], [2, true, []], [3, true, []], [4, true, []], [5, true, []], [6, true, []],
    ]);
  });

  it("enforces the orthogonal account total: 60/60 fails and 60/40 passes", () => {
    const base = structuredClone(rawAssemblyRequest()) as unknown as Record<string, unknown>;
    const setBudget = (maximumOutputTokens: number) => {
      const candidate = structuredClone(base) as Record<string, unknown>;
      const ceiling = (candidate["proposal"] as Record<string, unknown>)["budgetCeiling"] as Record<string, unknown>;
      ceiling["maximumOutputTokens"] = maximumOutputTokens;
      const allocation = ((candidate["taskBudgetAllocations"] as Record<string, unknown>[])[0]!["budget"] as Record<string, unknown>);
      allocation["maximumOutputTokens"] = maximumOutputTokens;
      return evaluation(rebound(candidate));
    };
    expect(evaluateSealConditions(setBudget(60))[4]).toMatchObject({ condition: 5, passed: false, ruleIds: ["plan.seal.condition-5"] });
    expect(evaluateSealConditions(setBudget(40))[4]).toMatchObject({ condition: 5, passed: true, ruleIds: [] });
  });

  it("treats model-authored authority text as inferred and only the pure synthetic predicate can satisfy it", () => {
    const raw = structuredClone(rawAssemblyRequest()) as unknown as Record<string, unknown>;
    const proposal = raw["proposal"] as Record<string, unknown>;
    proposal["source"] = { kind: "model", authority: "none", routeFingerprint: "a".repeat(64), contributionDigest: "b".repeat(64), narrativeRef: null };
    const stage = ((proposal["stages"] as Record<string, unknown>[])[0]!);
    (stage["provenance"] as Record<string, unknown>)["title"] = { origin: "model", derivedFrom: null, verbatim: false };
    const input = evaluation(rebound(raw));
    expect(evaluateSealConditions(input)[5]).toEqual({
      condition: 6,
      passed: false,
      ruleIds: ["plan.seal.condition-6"],
    });
    const approval = consumedScopeApproval(input);
    expect(scopeApprovalSatisfiesCondition6(approval, input.plan)).toBe(true);
    expect(evaluateSealConditions({ ...input, scopeApproval: approval })[5]).toMatchObject({ condition: 6, passed: true });
    expect(scopeApprovalSatisfiesCondition6({ ...approval, approvalRequestId: "forged" } as never, input.plan)).toBe(false);
    expect(scopeApprovalSatisfiesCondition6({ ...approval, state: "approved" } as never, input.plan)).toBe(false);
    expect(scopeApprovalSatisfiesCondition6({ ...approval, subjectDigest: SHA_A }, input.plan)).toBe(false);
    expect(scopeApprovalSatisfiesCondition6({ ...approval, scope: { ...approval.scope, projectId: "prj:other" } }, input.plan)).toBe(false);
  });

  it("requires a non-empty specification and keeps total-token evidence Developer-only", () => {
    const input = evaluation();
    const noSpecification = {
      ...input,
      review: { ...input.review, specification: null, specificationDigest: null, coverageDigest: null },
      plan: parseProjectPlan({ ...input.plan, specificationRef: null, coverageRef: null }),
    };
    expect(evaluateSealConditions(noSpecification)[2].ruleIds).toContain("plan.specification.absent");
    const verdicts = evaluateSealConditions(input);
    const context = projectionContext();
    const normal = projectSealReadinessView(verdicts, 0, input.resolvedProjectCeiling, "normal", context, planSha256);
    const developer = projectSealReadinessView(verdicts, 0, input.resolvedProjectCeiling, "developer", context, planSha256);
    expect("accountMaximumTotalTokens" in normal.value).toBe(false);
    expect(developer.value["accountMaximumTotalTokens"]).toBe(100);
    expect(normal.authority).toBe(developer.authority);
    expect(normal.commands).toEqual(developer.commands);
  });
});
