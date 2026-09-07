import { describe, expect, it } from "vitest";
import { parseProjectPlan, planDigestMaterial, type Dependency, type ProjectPlan } from "@ai-dev-os/project";
import {
  PlanContractError,
  assemblePlan,
  assertPlanBounds,
  assertPlanRecordInvariants,
  assertPlanReviewCoherent,
  computePlanOrder,
  computeProposalDigest,
  isPlanContractError,
  type PlanAssemblyRequest,
} from "../src/index.js";
import { planSha256 } from "../src/testing/index.js";
import { T0, T1, acceptedHead, assembled, complexAssemblyRequest, project, rawAssemblyRequest } from "./fixtures.js";

function graph(taskIds: readonly string[], stages: readonly { stageId: string; ordinal: number; taskIds: readonly string[] }[], dependencies: readonly Dependency[]): ProjectPlan {
  return { tasks: taskIds.map((taskId) => ({ taskId, stageId: stages.find((stage) => stage.taskIds.includes(taskId))?.stageId ?? "stg:one" })), stages, dependencies } as unknown as ProjectPlan;
}

function ruleOf(run: () => unknown): string {
  try { run(); } catch (error) { if (error instanceof PlanContractError) return error.ruleId; throw error; }
  return "none";
}

function assembleRaw(raw: unknown) {
  return assemblePlan(raw, project(), acceptedHead(), { planId: "pln:plan-test", revision: 1, supersedes: null, state: "drafting", createdAt: T0, updatedAt: T0, sealedAt: null }, planSha256);
}

describe("P-1/P-2 graph and record invariants", () => {
  it("enforces every explicit graph bound and semantic stage ordering", () => {
    const tooManyStages = graph([], Array.from({ length: 65 }, (_, index) => ({ stageId: `stg:${index}`, ordinal: index + 1, taskIds: [] })), []);
    expect(ruleOf(() => assertPlanBounds(tooManyStages))).toBe("plan.graph.too-many-stages");
    const tooManyTaskIds = Array.from({ length: 513 }, (_, index) => `tsk:${index}`);
    expect(ruleOf(() => assertPlanBounds(graph(tooManyTaskIds, [{ stageId: "stg:one", ordinal: 1, taskIds: [] }], [])))).toBe("plan.graph.too-many-tasks");
    const tooManyDependencies = Array.from({ length: 1025 }, () => ({ fromTaskId: "tsk:a", toTaskId: "tsk:b", kind: "advisory" as const, artifactKind: null }));
    expect(ruleOf(() => assertPlanBounds(graph(["tsk:a", "tsk:b"], [{ stageId: "stg:one", ordinal: 1, taskIds: ["tsk:a", "tsk:b"] }], tooManyDependencies)))).toBe("plan.graph.too-many-dependencies");
    const oversizedStageIds = Array.from({ length: 65 }, (_, index) => `tsk:${index}`);
    expect(ruleOf(() => assertPlanBounds(graph(oversizedStageIds, [{ stageId: "stg:one", ordinal: 1, taskIds: oversizedStageIds }], [])))).toBe("plan.graph.stage-too-large");

    const parallel = [
      { fromTaskId: "tsk:a", toTaskId: "tsk:b", kind: "finish-to-start", artifactKind: null },
      { fromTaskId: "tsk:a", toTaskId: "tsk:b", kind: "advisory", artifactKind: null },
    ] as const;
    expect(ruleOf(() => assertPlanBounds(graph(["tsk:a", "tsk:b"], [{ stageId: "stg:one", ordinal: 1, taskIds: ["tsk:a", "tsk:b"] }], parallel)))).toBe("plan.graph.parallel-edge");

    const fanOutIds = Array.from({ length: 34 }, (_, index) => `tsk:${index}`);
    const fanOut = fanOutIds.slice(1).map((id) => ({ fromTaskId: fanOutIds[0]!, toTaskId: id, kind: "finish-to-start" as const, artifactKind: null }));
    expect(ruleOf(() => assertPlanBounds(graph(fanOutIds, [{ stageId: "stg:one", ordinal: 1, taskIds: fanOutIds }], fanOut)))).toBe("plan.graph.fan-out");
    const fanIn = fanOutIds.slice(1).map((id) => ({ fromTaskId: id, toTaskId: fanOutIds[0]!, kind: "finish-to-start" as const, artifactKind: null }));
    expect(ruleOf(() => assertPlanBounds(graph(fanOutIds, [{ stageId: "stg:one", ordinal: 1, taskIds: fanOutIds }], fanIn)))).toBe("plan.graph.fan-in");

    const chainIds = Array.from({ length: 33 }, (_, index) => `tsk:${index}`);
    const chain = chainIds.slice(1).map((id, index) => ({ fromTaskId: chainIds[index]!, toTaskId: id, kind: "finish-to-start" as const, artifactKind: null }));
    expect(ruleOf(() => assertPlanBounds(graph(chainIds, [{ stageId: "stg:one", ordinal: 1, taskIds: chainIds }], chain)))).toBe("plan.graph.too-deep");

    const reverse = [{ fromTaskId: "tsk:late", toTaskId: "tsk:early", kind: "finish-to-start", artifactKind: null }] as const;
    expect(ruleOf(() => assertPlanBounds(graph(["tsk:early", "tsk:late"], [
      { stageId: "stg:early", ordinal: 1, taskIds: ["tsk:early"] },
      { stageId: "stg:late", ordinal: 2, taskIds: ["tsk:late"] },
    ], reverse)))).toBe("plan.graph.stage-order-inconsistent");
  });

  it("ignores advisory edges for acyclic order while retaining deterministic order", () => {
    const value = assembled(complexAssemblyRequest()).plan;
    const advisory = { fromTaskId: "tsk:docs", toTaskId: "tsk:core", kind: "advisory" as const, artifactKind: null };
    const withoutOrderingDependencies = parseProjectPlan({ ...value, dependencies: [advisory] });
    expect(computePlanOrder(withoutOrderingDependencies)).toEqual(["tsk:core", "tsk:docs", "tsk:quality"]);
    const advisoryCycle = {
      ...value,
      dependencies: [
        advisory,
        { fromTaskId: "tsk:core", toTaskId: "tsk:docs", kind: "advisory", artifactKind: null },
      ],
    };
    expect(ruleOf(() => computePlanOrder(advisoryCycle))).toBe("plan.seal.condition-1");
    expect(() => computePlanOrder({ broken: true })).toThrow();
  });

  it("checks digest, gates, pending state, fixed policy, approval metadata, and out-of-scope states", () => {
    const value = assembled().plan;
    expect(assertPlanRecordInvariants(value, planSha256)).toEqual(value);
    const cases: Array<[string, (plan: Record<string, unknown>) => void]> = [
      ["plan.proposal.digest-mismatch", (plan) => { plan["planDigest"] = "f".repeat(64); }],
      ["plan.proposal.malformed", (plan) => { ((plan["stages"] as Record<string, unknown>[])[0]!)["gate"] = "automatic"; }],
      ["plan.task.not-pending", (plan) => { ((plan["tasks"] as Record<string, unknown>[])[0]!)["state"] = "ready"; }],
      ["plan.proposal.malformed", (plan) => { ((plan["tasks"] as Record<string, unknown>[])[0]!)["idempotencyClass"] = "replayable"; }],
      ["plan.proposal.malformed", (plan) => { plan["sealedByApprovalId"] = "apr:forged"; }],
      ["plan.state.out-of-scope", (plan) => { plan["state"] = "executing"; plan["sealedAt"] = T1; }],
    ];
    for (const [expected, mutate] of cases) {
      const candidate = structuredClone(value) as unknown as Record<string, unknown>;
      mutate(candidate);
      if (expected !== "plan.proposal.digest-mismatch") candidate["planDigest"] = planSha256.sha256(planDigestMaterial(candidate as unknown as ProjectPlan));
      expect(ruleOf(() => assertPlanRecordInvariants(candidate, planSha256))).toBe(expected);
    }
  });

  it("provides finite, content-free diagnostics", () => {
    const error = new PlanContractError("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", "attacker.secret.path");
    const nonStringPath = new PlanContractError("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed", null as never);
    expect(isPlanContractError(error)).toBe(true);
    expect(isPlanContractError({})).toBe(false);
    expect(nonStringPath.path).toBe("plan");
    expect(error.toJSON()).toEqual({
      name: "PlanContractError", code: "PLAN_VALIDATION_REFUSED", ruleId: "plan.proposal.malformed",
      path: "plan", condition: null, message: "The plan contract was refused.",
    });
  });
});

describe("PV assembly refusal precision", () => {
  it("refuses project, lineage, brief-content, proposal, allocation, constraint, and stage-list mismatches", () => {
    const request = rawAssemblyRequest();
    expect(ruleOf(() => assemblePlan(request, project({ projectId: "prj:other" }), acceptedHead(), { planId: request.newPlanId, revision: 1, supersedes: null, state: "drafting", createdAt: T0, updatedAt: T0, sealedAt: null }, planSha256))).toBe("plan.project.mismatch");
    expect(ruleOf(() => assemblePlan(request, project(), acceptedHead(), { planId: "pln:other", revision: 1, supersedes: null, state: "drafting", createdAt: T0, updatedAt: T0, sealedAt: null }, planSha256))).toBe("plan.lineage.not-successor");
    expect(ruleOf(() => assemblePlan(request, project(), { ...acceptedHead(), briefContentDigest: "f".repeat(64) }, { planId: request.newPlanId, revision: 1, supersedes: null, state: "drafting", createdAt: T0, updatedAt: T0, sealedAt: null }, planSha256))).toBe("plan.brief.content-digest-mismatch");
    const stale = structuredClone(request) as unknown as Record<string, unknown>;
    ((stale["proposal"] as Record<string, unknown>)["budgetCeiling"] as Record<string, unknown>)["maximumTurns"] = 1;
    expect(ruleOf(() => assembleRaw(stale))).toBe("plan.proposal.digest-mismatch");

    const malformedAllocation = structuredClone(request) as unknown as Record<string, unknown>;
    malformedAllocation["taskBudgetAllocations"] = [];
    malformedAllocation["expectedProposalDigest"] = computeProposalDigest(malformedAllocation, planSha256);
    expect(ruleOf(() => assembleRaw(malformedAllocation))).toBe("plan.proposal.malformed");

    const excess = structuredClone(request) as unknown as Record<string, unknown>;
    ((((excess["taskBudgetAllocations"] as Record<string, unknown>[])[0]!)["budget"] as Record<string, unknown>)["maximumInputTokens"]) = 61;
    excess["expectedProposalDigest"] = computeProposalDigest(excess, planSha256);
    expect(ruleOf(() => assembleRaw(excess))).toBe("plan.budget.task-exceeds-ceiling");

    const missingConstraint = structuredClone(request) as unknown as Record<string, unknown>;
    ((missingConstraint["proposal"] as Record<string, unknown>)["constraintDispositions"] as unknown[]) = [];
    missingConstraint["expectedProposalDigest"] = computeProposalDigest(missingConstraint, planSha256);
    expect(ruleOf(() => assembleRaw(missingConstraint))).toBe("plan.constraint.no-disposition");

    const wrongStage = structuredClone(request) as unknown as Record<string, unknown>;
    (((wrongStage["proposal"] as Record<string, unknown>)["stages"] as Record<string, unknown>[])[0]!)["taskIds"] = ["tsk:missing"];
    wrongStage["expectedProposalDigest"] = computeProposalDigest(wrongStage, planSha256);
    expect(ruleOf(() => assembleRaw(wrongStage))).toBe("plan.proposal.malformed");
  });

  it("refuses throwing or malformed digest ports and incoherent review evidence", () => {
    const request = rawAssemblyRequest();
    expect(() => computeProposalDigest(request, { sha256: () => { throw new Error("fault"); } })).toThrow();
    expect(() => computeProposalDigest(request, { sha256: () => "not-a-digest" })).toThrow();
    const result = assembled();
    expect(() => assertPlanReviewCoherent(result)).not.toThrow();
    const corrupted = structuredClone(result) as unknown as Record<string, unknown>;
    const review = corrupted["review"] as Record<string, unknown>;
    const assemblyRequest = review["assemblyRequest"] as Record<string, unknown>;
    const proposal = assemblyRequest["proposal"] as Record<string, unknown>;
    ((proposal["stages"] as Record<string, unknown>[])[0]!)["title"] = "Adapter-substituted review title.";
    expect(ruleOf(() => assertPlanReviewCoherent(corrupted as unknown as ReturnType<typeof assembled>)))
      .toBe("plan.coverage.provenance-inconsistent");
  });
});
