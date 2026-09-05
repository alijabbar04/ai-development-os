import { describe, expect, it } from "vitest";
import { planDigestMaterial, serializeCanonicalProjectJson } from "@ai-dev-os/project";
import {
  PLAN_FIXED_HANDOVER,
  PLAN_FIXED_RETRY,
  PLAN_FIXED_TIMEOUT,
  assemblePlan,
  assertPlanRecordInvariants,
  canonicalPlanDigestMaterial,
  computeCoverageDigest,
  computePlanOrder,
  computeProposalDigest,
  computeSpecificationDigest,
  parsePlanAssemblyRequest,
  parsePlanJournalEvent,
  parsePlanProposal,
} from "../src/index.js";
import { planSha256 } from "../src/testing/index.js";
import {
  T0,
  acceptedBinding,
  acceptedHead,
  assembled,
  complexAssemblyRequest,
  draftRequest,
  project,
  rawAssemblyRequest,
} from "./fixtures.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("PV-9..PV-20 exact request, provenance, and deterministic assembly", () => {
  it("recomputes three non-recursive digests and assembles deterministic C6 records", () => {
    const request = rawAssemblyRequest();
    expect(computeProposalDigest(request, planSha256)).toBe(request.expectedProposalDigest);
    expect(computeSpecificationDigest(request, planSha256)).toBe(request.expectedSpecificationDigest);
    expect(computeCoverageDigest(request, planSha256)).toBe(request.expectedCoverageDigest);

    const first = assembled(request);
    const second = assembled(clone(request));
    expect(second).toEqual(first);
    expect(first.plan.planDigest).toBe(planSha256.sha256(planDigestMaterial(first.plan)));
    expect(canonicalPlanDigestMaterial(first.plan)).toBe(planDigestMaterial(first.plan));
    expect(assertPlanRecordInvariants(first.plan, planSha256)).toEqual(first.plan);
    expect(computePlanOrder(first.plan)).toEqual(["tsk:core"]);
    expect(first.plan.specificationRef).toBe(`spec:${request.expectedSpecificationDigest!.slice(0, 32)}`);
    expect(first.plan.coverageRef).toBe(`coverage:${request.expectedCoverageDigest!.slice(0, 32)}`);
    expect(first.review.assemblyRequest).toEqual(request);
    expect(first.review.provenance.stages[0]?.fields).toEqual(request.proposal.stages[0]?.provenance);
  });

  it("pins pending tasks and all five C9-owned execution-policy fields", () => {
    const task = assembled().plan.tasks[0]!;
    expect(task.state).toBe("pending");
    expect(task.stateRevision).toBe(1);
    expect(task.retry).toEqual(PLAN_FIXED_RETRY);
    expect(task.timeout).toEqual(PLAN_FIXED_TIMEOUT);
    expect(task.priority).toBe("normal");
    expect(task.workloadClass).toBe("general");
    expect(task.handoverPolicy).toEqual(PLAN_FIXED_HANDOVER);
    expect(task.requirements.dataClassification).toBe(project().dataClassification);
  });

  it("invalidates a retained digest after every authority-bearing class of mutation", () => {
    const mutate = (change: (request: Record<string, unknown>) => void) => {
      const request = clone(rawAssemblyRequest()) as unknown as Record<string, unknown>;
      change(request);
      expect(() => assemblePlan(request, project(), acceptedHead(), {
        planId: "pln:plan-test", revision: 1, supersedes: null, state: "drafting",
        createdAt: T0, updatedAt: T0, sealedAt: null,
      }, planSha256)).toThrow();
    };
    mutate((request) => ((request["proposal"] as Record<string, unknown>)["budgetCeiling"] as Record<string, unknown>)["maximumTurns"] = 1);
    mutate((request) => (((request["proposal"] as Record<string, unknown>)["tasks"] as Record<string, unknown>[])[0]!["title"] = "Changed title"));
    mutate((request) => (((request["taskBudgetAllocations"] as Record<string, unknown>[])[0]!["budget"] as Record<string, unknown>)["maximumOutputTokens"] = 39));
    mutate((request) => ((((request["specificationInput"] as Record<string, unknown>)["coverage"] as Record<string, unknown>[])[0]!["executable"] = false)));
    mutate((request) => ((((request["specificationInput"] as Record<string, unknown>)["taskIdMap"] as Record<string, unknown>[])[0]!["planTaskId"] = "tsk:other")));
  });

  it("rejects self-certification, proposer-owned ordinal/policy, bidi, and suspicious literals", () => {
    const request = clone(rawAssemblyRequest()) as unknown as Record<string, unknown>;
    request["operatorEvidence"] = [];
    expect(() => parsePlanAssemblyRequest(request)).toThrow();

    const ordinal = clone(rawAssemblyRequest().proposal) as unknown as Record<string, unknown>;
    ((ordinal["stages"] as Record<string, unknown>[])[0]!)["ordinal"] = 1;
    expect(() => parsePlanProposal(ordinal)).toThrow();

    const policy = clone(rawAssemblyRequest().proposal) as unknown as Record<string, unknown>;
    ((policy["tasks"] as Record<string, unknown>[])[0]!)["retry"] = PLAN_FIXED_RETRY;
    expect(() => parsePlanProposal(policy)).toThrow();

    for (const text of ["Unsafe\u202Etext", "https://example.invalid/free-text", "sk-ant-secretvalue1234"]) {
      const hostile = clone(rawAssemblyRequest().proposal) as unknown as Record<string, unknown>;
      ((hostile["stages"] as Record<string, unknown>[])[0]!)["title"] = text;
      expect(() => parsePlanProposal(hostile)).toThrow();
    }
  });

  it("accepts only the opaque nullable narrativeRef on the model source variant", () => {
    const proposal = clone(rawAssemblyRequest().proposal) as unknown as Record<string, unknown>;
    proposal["source"] = { kind: "model", authority: "none", routeFingerprint: "c".repeat(64), contributionDigest: "a".repeat(64), narrativeRef: `nar:${"b".repeat(64)}` };
    expect(parsePlanProposal(proposal).source).toMatchObject({ kind: "model", narrativeRef: `nar:${"b".repeat(64)}` });
    for (const narrativeRef of ["C:\\secret.txt", "https://example.invalid", "provider:anthropic", "nar:ABC", "free text", undefined]) {
      const hostile = clone(proposal);
      (hostile["source"] as Record<string, unknown>)["narrativeRef"] = narrativeRef;
      expect(() => parsePlanProposal(hostile)).toThrow();
    }
    const deterministic = clone(rawAssemblyRequest().proposal) as unknown as Record<string, unknown>;
    (deterministic["source"] as Record<string, unknown>)["narrativeRef"] = null;
    expect(() => parsePlanProposal(deterministic)).toThrow();
  });

  it("never serializes a self-referential proposal digest", () => {
    const request = rawAssemblyRequest();
    const bytes = serializeCanonicalProjectJson(request.proposal);
    expect(bytes).not.toContain("expectedProposalDigest");
    expect(bytes).not.toContain(request.expectedProposalDigest);
  });

  it("canonicalizes and durably reparses a multi-task specification with provenance and waivers", () => {
    const request = complexAssemblyRequest();
    const result = assembled(request);
    expect(computePlanOrder(result.plan)).toEqual(["tsk:core", "tsk:quality", "tsk:docs"]);
    expect(result.review.specification?.requirements).toHaveLength(4);
    expect(result.review.specification?.requirements[0]?.sourceProvenance).toHaveLength(1);
    const commit = draftRequest(result.plan, result.review, acceptedBinding(acceptedHead()), {
      projectAggregateVersion: 1,
      projectContentDigest: "a".repeat(64),
      projectStatus: "active",
      projectStopSnapshotDigest: "b".repeat(64),
      activeProjectStopIds: [],
    });
    expect(parsePlanJournalEvent(structuredClone(commit.steps[0]!.event), planSha256)).toEqual(commit.steps[0]!.event);
  });
});
