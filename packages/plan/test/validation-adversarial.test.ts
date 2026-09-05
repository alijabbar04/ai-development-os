import { describe, expect, it } from "vitest";
import {
  assemblePlan,
  computeCoverageDigest,
  computeProposalDigest,
  computeSpecificationDigest,
  parsePlanAssemblyRequest,
  parsePlanProposal,
  parseProductSpecificationMirror,
  parseRequirementTaskCoverageMirror,
  transformPlanSpecification,
  type PlanAssemblyRequest,
} from "../src/index.js";
import {
  enumText,
  literal,
  parseAuthenticatedOperatorEvidence,
  planIdentifier,
  planText,
  safeInteger,
  strictArray,
  strictRecord,
} from "../src/validation.js";
import { planSha256 } from "../src/testing/index.js";
import { T0, acceptedHead, complexAssemblyRequest, project, rawAssemblyRequest } from "./fixtures.js";

function clone<T>(value: T): T { return structuredClone(value); }

function rebound(value: unknown): PlanAssemblyRequest {
  const raw = clone(value) as Record<string, unknown>;
  raw["expectedProposalDigest"] = "0".repeat(64);
  raw["expectedSpecificationDigest"] = raw["specificationInput"] === null ? null : "0".repeat(64);
  raw["expectedCoverageDigest"] = raw["specificationInput"] === null ? null : "0".repeat(64);
  const specification = computeSpecificationDigest(raw, planSha256);
  const coverage = computeCoverageDigest(raw, planSha256);
  const withDigests = { ...raw, expectedSpecificationDigest: specification, expectedCoverageDigest: coverage };
  return parsePlanAssemblyRequest({ ...withDigests, expectedProposalDigest: computeProposalDigest(withDigests, planSha256) });
}

function assemble(request: PlanAssemblyRequest) {
  return assemblePlan(request, project(), acceptedHead(), {
    planId: request.newPlanId, revision: 1, supersedes: null, state: "drafting", createdAt: T0, updatedAt: T0, sealedAt: null,
  }, planSha256);
}

describe("PV-9..PV-20 hostile parsing and provenance", () => {
  it("covers every derived-from variant and both operator evidence node kinds", () => {
    const references = [
      ["brief", { kind: "brief-objective", briefId: "brf:plan-test" }],
      ["brief", { kind: "brief-outcome", briefId: "brf:plan-test", index: 0 }],
      ["brief", { kind: "brief-non-goal", briefId: "brf:plan-test", index: 0 }],
      ["brief", { kind: "brief-constraint", briefId: "brf:plan-test", constraintId: "constraint:tokens" }],
      ["brief", { kind: "brief-assumption", briefId: "brf:plan-test", index: 0 }],
      ["specification", { kind: "requirement", specificationId: "product-specification:plan-test", requirementId: "req:core" }],
    ] as const;
    for (const [origin, derivedFrom] of references) {
      const proposal = clone(rawAssemblyRequest().proposal) as unknown as Record<string, unknown>;
      const stage = (proposal["stages"] as Record<string, unknown>[])[0]!;
      (stage["provenance"] as Record<string, unknown>)["title"] = { origin, derivedFrom, verbatim: origin === "brief" };
      expect(parsePlanProposal(proposal).stages[0]!.provenance.title?.derivedFrom).toEqual(derivedFrom);
    }
    expect(parseAuthenticatedOperatorEvidence([
      { nodeKind: "stage", nodeId: "stg:core", fieldPath: "title", value: "Stage" },
      { nodeKind: "task", nodeId: "tsk:core", fieldPath: "objective", value: "Task" },
    ])).toHaveLength(2);
    expect(() => parseAuthenticatedOperatorEvidence([
      { nodeKind: "stage", nodeId: "stg:core", fieldPath: "title", value: "Stage" },
      { nodeKind: "stage", nodeId: "stg:core", fieldPath: "title", value: "Duplicate" },
    ])).toThrow();
  });

  it("covers operator/model/deterministic source variants and provenance refusal classes", () => {
    const operator = clone(rawAssemblyRequest().proposal) as unknown as Record<string, unknown>;
    operator["source"] = { kind: "operator", authority: "none" };
    expect(parsePlanProposal(operator).source.kind).toBe("operator");

    const model = clone(operator);
    model["source"] = { kind: "model", authority: "none", routeFingerprint: "a".repeat(64), contributionDigest: "b".repeat(64), narrativeRef: null };
    ((model["stages"] as Record<string, unknown>[])[0]!["provenance"] as Record<string, unknown>)["title"] = { origin: "operator", derivedFrom: null, verbatim: false };
    expect(() => parsePlanProposal(model)).toThrow();

    for (const row of [
      { origin: "repository", derivedFrom: null, verbatim: false },
      { origin: "model", derivedFrom: { kind: "brief-objective", briefId: "brf:plan-test" }, verbatim: false },
      { origin: "brief", derivedFrom: null, verbatim: true },
      { origin: "specification", derivedFrom: { kind: "brief-objective", briefId: "brf:plan-test" }, verbatim: false },
    ]) {
      const proposal = clone(rawAssemblyRequest().proposal) as unknown as Record<string, unknown>;
      ((proposal["stages"] as Record<string, unknown>[])[0]!["provenance"] as Record<string, unknown>)["title"] = row;
      expect(() => parsePlanProposal(proposal)).toThrow();
    }
  });

  it("resolves brief-constraint and specification prose and refuses unverbatim or unresolved references", () => {
    const constraint = clone(rawAssemblyRequest()) as unknown as Record<string, unknown>;
    const constraintTask = (((constraint["proposal"] as Record<string, unknown>)["tasks"] as Record<string, unknown>[])[0]!);
    constraintTask["title"] = "Keep the plan within the token and action ceiling.";
    (constraintTask["provenance"] as Record<string, unknown>)["title"] = { origin: "brief", derivedFrom: { kind: "brief-constraint", briefId: "brf:plan-test", constraintId: "constraint:tokens" }, verbatim: true };
    expect(assemble(rebound(constraint)).plan.tasks[0]!.title).toBe(constraintTask["title"]);

    const specification = clone(rawAssemblyRequest()) as unknown as Record<string, unknown>;
    const specTask = (((specification["proposal"] as Record<string, unknown>)["tasks"] as Record<string, unknown>[])[0]!);
    specTask["title"] = "Implement the plan contract";
    (specTask["provenance"] as Record<string, unknown>)["title"] = { origin: "specification", derivedFrom: { kind: "requirement", specificationId: "product-specification:plan-test", requirementId: "req:core" }, verbatim: false };
    expect(assemble(rebound(specification)).plan.tasks[0]!.title).toBe("Implement the plan contract");

    const unverbatim = clone(constraint);
    (((unverbatim["proposal"] as Record<string, unknown>)["tasks"] as Record<string, unknown>[])[0]!)["title"] = "Not verbatim";
    expect(() => assemble(rebound(unverbatim))).toThrow();
    const unresolved = clone(constraint);
    const row = ((((unresolved["proposal"] as Record<string, unknown>)["tasks"] as Record<string, unknown>[])[0]!["provenance"] as Record<string, unknown>)["title"] as Record<string, unknown>);
    (row["derivedFrom"] as Record<string, unknown>)["constraintId"] = "constraint:missing";
    expect(() => assemble(rebound(unresolved))).toThrow();
  });

  it("exercises validation-command, disposition, waiver-binding, and null-specification shapes", () => {
    const command = clone(rawAssemblyRequest().proposal) as unknown as Record<string, unknown>;
    const task = (command["tasks"] as Record<string, unknown>[])[0]!;
    ((task["acceptance"] as Record<string, unknown>[])[0]!)["validationCommand"] = ["npm", "test"];
    expect(parsePlanProposal(command).tasks[0]!.acceptance[0]!.validationCommand).toEqual(["npm", "test"]);

    for (const disposition of [
      { constraintId: "constraint:tokens", disposition: "enforced-by-task", taskId: "tsk:core", waiverDecisionId: null },
      { constraintId: "constraint:tokens", disposition: "waived-by-decision", taskId: null, waiverDecisionId: `dec:${"a".repeat(32)}` },
    ]) {
      const proposal = clone(rawAssemblyRequest().proposal) as unknown as Record<string, unknown>;
      (proposal["constraintDispositions"] as Record<string, unknown>[])[1] = disposition;
      expect(parsePlanProposal(proposal).constraintDispositions[1]!.disposition).toBe(disposition.disposition);
    }

    const waiver = clone(rawAssemblyRequest()) as unknown as Record<string, unknown>;
    ((waiver["specificationInput"] as Record<string, unknown>)["waiverBindings"] as unknown[]) = [{ requirementId: "req:core", waiverDecisionId: `dec:${"b".repeat(32)}` }];
    expect(parsePlanAssemblyRequest(waiver).specificationInput!.waiverBindings).toHaveLength(1);

    const without = clone(rawAssemblyRequest()) as unknown as Record<string, unknown>;
    without["specificationInput"] = null;
    without["expectedSpecificationDigest"] = null;
    without["expectedCoverageDigest"] = null;
    const parsed = rebound(without);
    expect(computeSpecificationDigest(parsed, planSha256)).toBeNull();
    expect(computeCoverageDigest(parsed, planSha256)).toBeNull();
    expect(assemble(parsed).plan).toMatchObject({ specificationRef: null, coverageRef: null });
  });

  it("rejects malformed core primitives and exact-key/container violations", () => {
    for (const value of [null, [], new Date(), Object.create({ polluted: true })]) expect(() => strictRecord(value)).toThrow();
    expect(strictRecord(Object.create(null))).toEqual({});
    expect(() => strictArray({ 0: "x", length: 1 }, (x) => x)).toThrow();
    expect(() => strictArray(new Array(1), (x) => x)).toThrow();
    expect(() => planText("e\u0301")).toThrow();
    expect(() => planText("zero\u0000byte")).toThrow();
    expect(() => planIdentifier("wrong", "pln:")).toThrow();
    expect(() => safeInteger(-1)).toThrow();
    expect(() => safeInteger(2, "plan", 1)).toThrow();
    expect(literal("x", "x", "plan")).toBe("x");
    expect(() => literal("x", "y", "plan")).toThrow();
    expect(enumText("x", ["x", "y"] as const, "plan")).toBe("x");
    expect(() => enumText("z", ["x", "y"] as const, "plan")).toThrow();
  });
});

describe("S-1..S-6 specification mirror and transform", () => {
  it("G-9 rejects aggregate budget laundering when each task is individually below the ceiling", () => {
    const raw = clone(complexAssemblyRequest()) as unknown as Record<string, unknown>;
    const ceiling = (raw["proposal"] as Record<string, unknown>)["budgetCeiling"] as Record<string, unknown>;
    ceiling["maximumInputTokens"] = 40;
    const parsed = rebound(raw);
    expect(parsed.taskBudgetAllocations.every((allocation) => allocation.budget.maximumInputTokens <= 40)).toBe(true);
    expect(parsed.taskBudgetAllocations.reduce((sum, allocation) => sum + allocation.budget.maximumInputTokens, 0)).toBeGreaterThan(40);
    expect(() => assemble(parsed)).toThrowError(expect.objectContaining({
      code: "PLAN_VALIDATION_REFUSED",
      ruleId: "plan.budget.sum-exceeds-ceiling",
      path: "planBudget",
    }));
  });

  it("preserves complete owner provenance and normalizes set-like evidence arrays", () => {
    const request = clone(rawAssemblyRequest()) as unknown as Record<string, unknown>;
    const input = request["specificationInput"] as Record<string, unknown>;
    const spec = input["specification"] as Record<string, unknown>;
    const requirement = (spec["requirements"] as Record<string, unknown>[])[0]!;
    requirement["candidateIds"] = ["candidate:z", "candidate:a"];
    requirement["dissentIds"] = ["dissent:b"];
    requirement["provenance"] = [{ contributionId: "contribution:one", phaseId: "phase:one", routeKey: "route:one", sourceFingerprint: "f".repeat(64), candidateId: "candidate:a" }];
    spec["findingIds"] = ["finding:one"];
    spec["questionIds"] = ["question:one"];
    spec["dissentIds"] = ["dissent:one"];
    const parsed = rebound(request);
    const binding = transformPlanSpecification(parsed.specificationInput!, parsed.expectedSpecificationDigest!, parsed.expectedCoverageDigest!, parsed.proposal.tasks, planSha256);
    expect(binding.requirements[0]!.sourceProvenance).toEqual(requirement["provenance"]);
    expect(binding.approvedBy).toEqual({ actorId: "actor:product-owner", authority: "product-owner" });
  });

  it("converts throwing and malformed specification digest ports into typed refusals", () => {
    const parsed = rebound(rawAssemblyRequest());
    for (const sha256 of [
      () => { throw new Error("digest port fault"); },
      () => "not-a-digest",
    ]) {
      expect(() => transformPlanSpecification(
        parsed.specificationInput!,
        parsed.expectedSpecificationDigest!,
        parsed.expectedCoverageDigest!,
        parsed.proposal.tasks,
        { sha256 },
      )).toThrowError(expect.objectContaining({
        code: "PLAN_VALIDATION_REFUSED",
        ruleId: "plan.specification.digest-mismatch",
        path: "planSpecification",
      }));
    }
  });

  it("rejects incoherent mirrors and every coverage/mapping authority mismatch after valid digest binding", () => {
    const cases: Array<(raw: Record<string, unknown>) => void> = [
      (raw) => { const input = raw["specificationInput"] as Record<string, unknown>; input["coverage"] = []; },
      (raw) => { const row = ((((raw["specificationInput"] as Record<string, unknown>)["coverage"] as Record<string, unknown>[])[0]!)); row["requirementDigest"] = "9".repeat(64); },
      (raw) => { const row = ((((raw["specificationInput"] as Record<string, unknown>)["coverage"] as Record<string, unknown>[])[0]!)); row["executable"] = false; },
      (raw) => { const map = (((raw["specificationInput"] as Record<string, unknown>)["taskIdMap"] as Record<string, unknown>[])[0]!); map["planTaskId"] = "tsk:missing"; },
      (raw) => { const task = (((raw["proposal"] as Record<string, unknown>)["tasks"] as Record<string, unknown>[])[0]!); task["requirementIds"] = []; },
    ];
    for (const change of cases) {
      const raw = clone(rawAssemblyRequest()) as unknown as Record<string, unknown>;
      change(raw);
      expect(() => assemble(rebound(raw))).toThrow();
    }

    const nonExecutable = clone(rawAssemblyRequest()) as unknown as Record<string, unknown>;
    const input = nonExecutable["specificationInput"] as Record<string, unknown>;
    const requirement = (((input["specification"] as Record<string, unknown>)["requirements"] as Record<string, unknown>[])[0]!);
    const coverage = ((input["coverage"] as Record<string, unknown>[])[0]!);
    requirement["disposition"] = "deferred";
    coverage["disposition"] = "deferred";
    coverage["executable"] = false;
    expect(() => assemble(rebound(nonExecutable))).toThrow();
  });

  it("rejects duplicate ids/provenance, bad timestamps, bad booleans, and plan version zero", () => {
    const specification = clone(rawAssemblyRequest().specificationInput!.specification) as unknown as Record<string, unknown>;
    specification["planVersion"] = 0;
    expect(() => parseProductSpecificationMirror(specification)).toThrow();
    specification["planVersion"] = 1;
    specification["approvedAt"] = "not-a-timestamp";
    expect(() => parseProductSpecificationMirror(specification)).toThrow();
    specification["approvedAt"] = T0;
    specification["findingIds"] = ["finding:one", "finding:one"];
    expect(() => parseProductSpecificationMirror(specification)).toThrow();
    const coverage = clone(rawAssemblyRequest().specificationInput!.coverage[0]) as unknown as Record<string, unknown>;
    coverage["executable"] = "yes";
    expect(() => parseRequirementTaskCoverageMirror(coverage)).toThrow();
  });
});
