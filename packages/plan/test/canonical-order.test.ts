import { describe, expect, it } from "vitest";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import { createSqlitePersistenceAdapter } from "@ai-dev-os/persistence-sqlite";
import { parseProjectPlan, planDigestMaterial, serializeCanonicalProjectJson } from "@ai-dev-os/project";
import {
  assemblePlan, assertPlanRecordInvariants, computePlanOrder, computeProposalDigest,
  computeCoverageDigest, computeSpecificationDigest, parsePlanAssemblyRequest,
  projectStopSnapshotDigestMaterial, type PlanAssemblyRequest,
} from "../src/index.js";
import { createC8C7PlanStore, issueSyntheticPlanCommitAuthorization, planSha256 } from "../src/testing/index.js";
import { acceptedBinding, assembled, assemblyRequestForBrief, draftRequest, fixedClock, rawAssemblyRequest, seedFoundations, T0, T1 } from "./fixtures.js";

const IDS = ["tsk:a", "tsk:A.", "tsk:Z", "tsk:A-"];
const EXPECTED = ["tsk:A-", "tsk:A.", "tsk:Z", "tsk:a"];
function mixed(base = rawAssemblyRequest(), permutation = IDS): PlanAssemblyRequest {
  const task = base.proposal.tasks[0]!, stage = base.proposal.stages[0]!;
  const input = { ...base,
    proposal: { ...base.proposal,
      budgetCeiling: { ...base.proposal.budgetCeiling, maximumTurns: 4 },
      // Stage presentation bytes remain part of the proposal identity. Permute
      // the collections actually normalized by the canonical comparators.
      stages: [{ ...stage, taskIds: IDS }],
      tasks: permutation.map((taskId) => ({ ...task, taskId, requirementIds: taskId === "tsk:a" ? task.requirementIds : [] })),
    },
    specificationInput: { ...base.specificationInput!, taskIdMap: [{ upstreamTaskId: "requirement-task:core", planTaskId: "tsk:a" }] },
    taskBudgetAllocations: permutation.map((taskId) => ({ taskId, budget: { maximumInputTokens: 1, maximumOutputTokens: 1, maximumCostMicros: 1, maximumToolCalls: 0, maximumTurns: 1 } })),
  };
  const upstream = { ...input, expectedSpecificationDigest: computeSpecificationDigest(input, planSha256), expectedCoverageDigest: computeCoverageDigest(input, planSha256) };
  return parsePlanAssemblyRequest({ ...upstream, expectedProposalDigest: computeProposalDigest(upstream, planSha256) });
}
describe("canonical order independent of runtime locale", () => {
  it("uses independently specified mixed-case/punctuation task order and stable permutation digests", () => {
    const first = mixed(), reversed = mixed(rawAssemblyRequest(), [...IDS].reverse());
    const a = assembled(first), b = assembled(reversed);
    expect(a.plan.tasks.map((t) => t.taskId)).toEqual(EXPECTED);
    expect(a.plan.stages[0]!.taskIds).toEqual(EXPECTED);
    expect(computePlanOrder(a.plan)).toEqual(EXPECTED);
    expect(a.plan.planDigest).toBe(b.plan.planDigest);
    expect(first.expectedProposalDigest).toBe(reversed.expectedProposalDigest);
    expect(first.expectedCoverageDigest).toBe(reversed.expectedCoverageDigest);
    expect(first.expectedSpecificationDigest).toBe(reversed.expectedSpecificationDigest);
  });
  it("keeps numeric stop-version precedence and independently specified canonical bytes", () => {
    const rows = [{ aggregateId: "pst:a", aggregateVersion: 1 }, { aggregateId: "pst:A-", aggregateVersion: 10 }, { aggregateId: "pst:A-", aggregateVersion: 2 }, { aggregateId: "pst:A.", aggregateVersion: 1 }];
    const expected = '{"projectId":"prj:one","schemaVersion":1,"stops":[{"aggregateId":"pst:A-","aggregateVersion":2},{"aggregateId":"pst:A-","aggregateVersion":10},{"aggregateId":"pst:A.","aggregateVersion":1},{"aggregateId":"pst:a","aggregateVersion":1}]}';
    const expectedDigest = planSha256.sha256(expected);
    expect(projectStopSnapshotDigestMaterial("prj:one", rows, planSha256)).toBe(expectedDigest);
    expect(projectStopSnapshotDigestMaterial("prj:one", [...rows].reverse(), planSha256)).toBe(expectedDigest);
  });
  it.each(["memory", "sqlite"])("round-trips mixed identifiers and digests through %s persisted reconstruction", async (kind) => {
    const adapter = kind === "memory" ? createMemoryPersistenceAdapter({ clock: fixedClock }) : await createSqlitePersistenceAdapter({ memory: true, clock: fixedClock });
    try {
      const seed = await seedFoundations(adapter), input = mixed(assemblyRequestForBrief(seed.accepted.brief));
      const result = assemblePlan(input, seed.project, seed.accepted, { planId: input.newPlanId, revision: 1, supersedes: null, state: "drafting", createdAt: T0, updatedAt: T0, sealedAt: null }, planSha256);
      const request = draftRequest(result.plan, result.review, acceptedBinding(seed.accepted), seed.controls), store = createC8C7PlanStore(adapter);
      expect(await store.commit(request, issueSyntheticPlanCommitAuthorization(request))).toMatchObject({ kind: "committed" });
      const read = await store.readHead(seed.project.projectId); expect(read.kind).toBe("head");
      if (read.kind !== "head") throw new Error("Persisted round trip failed");
      expect(read.head.plan.tasks.map((t) => t.taskId)).toEqual(EXPECTED);
      expect(read.head.plan.planDigest).toBe(result.plan.planDigest);
      expect(read.head.headEvent.payload.review.proposalDigest).toBe(input.expectedProposalDigest);
    } finally { await adapter.close(); }
  });
  it("fails closed on differing earlier canonical order without rewriting sealed bytes", () => {
    const current = assembled(mixed()).plan;
    // Explicit earlier ordering example, not generated by the new comparator.
    const earlierOrder = ["tsk:a", "tsk:A-", "tsk:A.", "tsk:Z"];
    const old = { ...current, state: "sealed", sealedAt: T1, updatedAt: T1,
      tasks: earlierOrder.map((id) => current.tasks.find((t) => t.taskId === id)!),
      stages: current.stages.map((s) => ({ ...s, taskIds: earlierOrder })),
    } as typeof current;
    const legacy = parseProjectPlan({ ...old, planDigest: planSha256.sha256(planDigestMaterial(old)) });
    const bytes = serializeCanonicalProjectJson(legacy);
    expect(() => assertPlanRecordInvariants(legacy, planSha256)).toThrow();
    expect(serializeCanonicalProjectJson(legacy)).toBe(bytes);
  });
});
