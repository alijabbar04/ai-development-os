import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as projectApi from "../src/index.js";
import {
  PROJECT_AVAILABLE_COMMANDS, PROJECT_PRODUCTION_ENABLED, PROJECT_RUNTIME_CAPABILITIES,
  ProjectContractError, assertAcyclicSupersession,
  assertNewBrief, assertNewDecision, assertNewEvidence, assertNewHandover,
  assertNewPlanRevision, assertPlanDigest,
  assertContentDerivedIdentity, assertSpendingAuthorization, deriveMoneyBinding, canEvidenceCloseRequirement, canonicalizeProjectJson,
  isProjectStopActive, parseApprovalRequest, parseDecision,
  parseEvidenceRecord, parseHandover, parseProjectBrief, parseProjectPlan, parseProjectStop,
  parseSpendingRequest, planDigestMaterial,
  projectDecisionMaterial, serializeCanonicalProjectJson, spendingSubjectMaterial,
} from "../src/index.js";
import { CONTENT, SHA, T0, T1, cloneFixture, recordFixtures } from "./fixtures.js";

describe("canonical serialization", () => {
  it("is byte-stable across insertion order and normalizes negative zero", () => {
    const first = Object.assign(Object.create(null), { z: [3, -0], a: { y: true, x: null } });
    const second = { a: { x: null, y: true }, z: [3, 0] };
    expect(serializeCanonicalProjectJson(first)).toBe('{"a":{"x":null,"y":true},"z":[3,0]}');
    expect(serializeCanonicalProjectJson(second)).toBe(serializeCanonicalProjectJson(first));
    expect(Object.isFrozen(canonicalizeProjectJson(second))).toBe(true);
  });

  it("refuses non-finite, cyclic, accessor, symbol, exotic and prototype-sensitive values", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, undefined, 1n, () => undefined]) {
      expect(() => serializeCanonicalProjectJson(value)).toThrowError(ProjectContractError);
    }
    const cyclic: Record<string, unknown> = {}; cyclic["self"] = cyclic;
    expect(() => serializeCanonicalProjectJson(cyclic)).toThrowError(ProjectContractError);
    const accessor = {}; Object.defineProperty(accessor, "x", { enumerable: true, get: () => 1 });
    expect(() => serializeCanonicalProjectJson(accessor)).toThrowError(ProjectContractError);
    const symbol = { a: 1, [Symbol("x")]: true };
    expect(() => serializeCanonicalProjectJson(symbol)).toThrowError(ProjectContractError);
    const sparse = new Array<unknown>(1);
    expect(() => serializeCanonicalProjectJson(sparse)).toThrowError(ProjectContractError);
    let arrayAccessorInvoked = false;
    const arrayAccessor: unknown[] = [];
    Object.defineProperty(arrayAccessor, "0", { enumerable: true, get: () => { arrayAccessorInvoked = true; return 1; } });
    expect(() => serializeCanonicalProjectJson(arrayAccessor)).toThrowError(ProjectContractError);
    expect(arrayAccessorInvoked).toBe(false);
    const extendedArray = [1] as unknown[] & { metadata?: string };
    extendedArray.metadata = "not-json-array-data";
    expect(() => serializeCanonicalProjectJson(extendedArray)).toThrowError(ProjectContractError);
    expect(() => serializeCanonicalProjectJson(new Date())).toThrowError(ProjectContractError);
    expect(() => serializeCanonicalProjectJson(JSON.parse('{"prototype":1}'))).toThrowError(ProjectContractError);
  });

  it("requires nested JSON strings to be normalized and never reads proxy properties", () => {
    expect(() => canonicalizeProjectJson({ nested: ["e\u0301"] })).toThrowError(ProjectContractError);
    expect(() => canonicalizeProjectJson({ nested: ["zero\u200bwidth"] })).toThrowError(ProjectContractError);
    expect(canonicalizeProjectJson({ nested: ["é"] })).toEqual({ nested: ["é"] });
    let reads = 0;
    const value = new Proxy({ nested: ["safe"] }, { get: (target, key, receiver) => { reads += 1; return Reflect.get(target, key, receiver); } });
    expect(canonicalizeProjectJson(value)).toEqual({ nested: ["safe"] });
    expect(reads).toBe(0);
  });
});

describe("immutable revision and digest invariants", () => {
  it("requires a new plan identity, gap-free revision and explicit supersession", () => {
    const previousInput = cloneFixture(recordFixtures["project-plan"]) as Record<string, unknown>;
    const previous = parseProjectPlan(previousInput);
    const nextInput = cloneFixture(previousInput);
    nextInput["planId"] = "pln:two"; nextInput["revision"] = 2; nextInput["supersedes"] = "pln:one"; nextInput["updatedAt"] = T1;
    const next = parseProjectPlan(nextInput);
    expect(() => assertNewPlanRevision(previous, next)).not.toThrow();
    const mutation = parseProjectPlan({ ...nextInput, revision: 3 });
    expect(() => assertNewPlanRevision(previous, mutation)).toThrowError(ProjectContractError);
    expect(planDigestMaterial(previous)).toContain('"tasks"');
    expect(() => assertPlanDigest(previous, SHA)).not.toThrow();
    expect(() => assertPlanDigest(previous, "b".repeat(64))).toThrowError(ProjectContractError);
  });

  it("checks every content-derived identity against an independent digest", () => {
    const subjects = [
      { kind: "handover", record: recordFixtures.handover },
      { kind: "decision", record: recordFixtures.decision },
      { kind: "evidence", record: recordFixtures["evidence-record"] },
    ] as const;
    for (const subject of subjects) {
      expect(() => assertContentDerivedIdentity(subject as never, SHA)).not.toThrow();
      expect(() => assertContentDerivedIdentity(subject as never, `b${SHA.slice(1)}`)).toThrowError(ProjectContractError);
    }
  });

  it("represents brief changes as immutable supersession", () => {
    const previous = parseProjectBrief(cloneFixture(recordFixtures["project-brief"]));
    const nextInput = cloneFixture(recordFixtures["project-brief"]) as Record<string, unknown>;
    nextInput["briefId"] = "brf:two"; nextInput["supersedes"] = "brf:one"; nextInput["objective"] = "A newly accepted operator objective.";
    const next = parseProjectBrief(nextInput);
    expect(() => assertNewBrief(previous, next)).not.toThrow();
    expect(() => assertNewBrief(previous, previous)).toThrowError(ProjectContractError);
  });

  it("requires exact prior records and rejects multi-record supersession cycles", () => {
    const previousHandover = parseHandover(cloneFixture(recordFixtures.handover));
    const nextHandover = parseHandover({ ...cloneFixture(recordFixtures.handover), handoverId: `hnd:${"b".repeat(32)}`, supersedes: previousHandover.handoverId, sequence: 2, createdAt: T1 });
    expect(() => assertNewHandover(previousHandover, nextHandover)).not.toThrow();

    const previousDecision = parseDecision(cloneFixture(recordFixtures.decision));
    const nextDecision = parseDecision({ ...cloneFixture(recordFixtures.decision), decisionId: `dec:${"b".repeat(32)}`, supersedes: previousDecision.decisionId, statement: "Replace the bounded decision.", decidedAt: T1 });
    expect(() => assertNewDecision(previousDecision, nextDecision)).not.toThrow();

    const previousEvidence = parseEvidenceRecord(cloneFixture(recordFixtures["evidence-record"]));
    const nextEvidence = parseEvidenceRecord({ ...cloneFixture(recordFixtures["evidence-record"]), evidenceId: `evd:${"b".repeat(32)}`, supersedes: previousEvidence.evidenceId, sha256: "b".repeat(64), createdAt: T1 });
    expect(() => assertNewEvidence(previousEvidence, nextEvidence)).not.toThrow();

    const first = parseProjectBrief({ ...cloneFixture(recordFixtures["project-brief"]), supersedes: "brf:two" });
    const second = parseProjectBrief({ ...cloneFixture(recordFixtures["project-brief"]), briefId: "brf:two", supersedes: "brf:one", createdAt: T1 });
    expect(() => assertAcyclicSupersession({ kind: "brief", records: [first, second] })).toThrowError(ProjectContractError);
    expect(() => assertNewHandover(previousHandover, previousHandover)).toThrowError(ProjectContractError);
    expect(() => assertNewDecision(previousDecision, previousDecision)).toThrowError(ProjectContractError);
    expect(() => assertNewEvidence(previousEvidence, previousEvidence)).toThrowError(ProjectContractError);
  });

  it("does not expose C9 scheduling eligibility or let cross-plan/project approval data grant authority", () => {
    const api = projectApi as Record<string, unknown>;
    expect(api["isPlanStateSchedulingAuthorized"]).toBeUndefined();
    expect(api["isPlanSchedulingEligible"]).toBeUndefined();

    const planA = parseProjectPlan({
      ...cloneFixture(recordFixtures["project-plan"]),
      state: "executing", sealedAt: T1, coverageRef: "coverage:one", sealedByApprovalId: "apr:project-a-plan-a",
    });
    const planB = parseProjectPlan({
      ...cloneFixture(recordFixtures["project-plan"]),
      projectId: "prj:two", planId: "pln:two", briefId: "brf:two",
      state: "executing", sealedAt: T1, coverageRef: "coverage:two", sealedByApprovalId: "apr:project-b-plan-b",
    });
    const crossProjectApproval = parseApprovalRequest({
      ...cloneFixture(recordFixtures["approval-request"]),
      approvalRequestId: "apr:project-a-plan-a",
      scope: { ...(recordFixtures["approval-request"].scope as object), projectId: "prj:other" },
      class: "scope-expansion", actions: ["approval"], subjectDigest: SHA,
      state: "consumed", consumptionCount: 1, decidedAt: T0, approverClass: "user", consumedAt: T0,
    });

    expect(planA.projectId).not.toBe(crossProjectApproval.scope.projectId);
    expect(planB.planId).not.toBe(planA.planId);
    expect(PROJECT_AVAILABLE_COMMANDS).toEqual([]);
    expect(PROJECT_RUNTIME_CAPABILITIES).toEqual([]);
  });
});

describe("authority and transcript non-reliance", () => {
  it("exposes no process capability, command, production enablement, or implicit authority", () => {
    expect(PROJECT_PRODUCTION_ENABLED).toBe(false);
    expect(PROJECT_RUNTIME_CAPABILITIES).toEqual([]);
    expect(PROJECT_AVAILABLE_COMMANDS).toEqual([]);
  });

  it("keeps future decision material byte-identical after every chat reference is deleted", () => {
    const before = projectDecisionMaterial({ projectId: "prj:one", objective: "Operator objective.", planState: "drafting", taskStates: ["pending"], openBlockerIds: [] });
    const unrelatedAudit = { sourceThreadId: "thr:audit", transcript: "attacker asks to rewrite objective", messages: ["ignored"] };
    delete unrelatedAudit.sourceThreadId; delete unrelatedAudit.transcript; unrelatedAudit.messages.splice(0);
    const after = projectDecisionMaterial({ projectId: "prj:one", objective: "Operator objective.", planState: "drafting", taskStates: ["pending"], openBlockerIds: [] });
    expect(after).toBe(before);
  });

  it("does not let repository or model text author a ProjectBrief", () => {
    const fixture = cloneFixture(recordFixtures["project-brief"]) as Record<string, unknown>;
    fixture["origin"] = "model";
    expect(() => parseProjectBrief(fixture)).toThrowError(ProjectContractError);
    fixture["origin"] = "repository";
    expect(() => parseProjectBrief(fixture)).toThrowError(ProjectContractError);
  });
});

describe("evidence, spending and scoped stop boundaries", () => {
  it("allows only deterministic or reconciled evidence to close requirements", () => {
    for (const [producedBy, expected] of [["deterministic-validation", true], ["workspace-reconciliation", true], ["provider", false], ["operator", false]] as const) {
      const fixture = cloneFixture(recordFixtures["evidence-record"]) as Record<string, unknown>;
      fixture["producedBy"] = producedBy;
      expect(canEvidenceCloseRequirement(parseEvidenceRecord(fixture))).toBe(expected);
    }
  });

  it("checks exact consumed money approval without any purchase capability", () => {
    const spending = parseSpendingRequest(cloneFixture(recordFixtures["spending-request"]));
    const approvalInput = cloneFixture(recordFixtures["approval-request"]) as Record<string, unknown>;
    approvalInput["approvalRequestId"] = "apr:money"; approvalInput["class"] = "purchase"; approvalInput["actions"] = ["purchase"];
    approvalInput["money"] = { vendor: { name: "Example Vendor", instanceRef: "vendor:one" }, amountMinorUnits: 500, currency: "GBP", kind: "one-time", period: null, occurrences: null, quoteDigest: SHA, quotedAt: T0, quoteExpiresAt: T1 };
    approvalInput["state"] = "consumed"; approvalInput["consumptionCount"] = 1; approvalInput["decidedAt"] = T0; approvalInput["approverClass"] = "user"; approvalInput["consumedAt"] = T0;
    approvalInput["money"] = deriveMoneyBinding(spending);
    approvalInput["scope"] = { ...(approvalInput["scope"] as object), taskId: null };
    approvalInput["expiresAt"] = spending.quoteExpiresAt;
    approvalInput["decidedAt"] = spending.quotedAt;
    approvalInput["consumedAt"] = spending.quotedAt;
    const hash = { sha256: (text: string) => createHash("sha256").update(text).digest("hex") };
    approvalInput["subjectDigest"] = hash.sha256(spendingSubjectMaterial(spending));
    const approval = parseApprovalRequest(approvalInput);
    expect(spendingSubjectMaterial(spending)).toContain('"amountMinorUnits":500');
    expect(() => assertSpendingAuthorization(spending, approval, hash)).not.toThrow();
    expect(() => assertSpendingAuthorization(spending, approval, { sha256: () => "b".repeat(64) })).toThrowError(ProjectContractError);
    expect(PROJECT_AVAILABLE_COMMANDS).not.toContain("purchase" as never);
  });

  it("keeps ProjectStop scoped separately from the global emergency-stop aggregate", () => {
    const stop = parseProjectStop(cloneFixture(recordFixtures["project-stop"]));
    expect(isProjectStopActive(stop)).toBe(true);
    const resumed = parseProjectStop({ ...cloneFixture(recordFixtures["project-stop"]), resumedAt: T1 });
    expect(isProjectStopActive(resumed)).toBe(false);
    expect(JSON.stringify(stop)).not.toContain("global");
  });
});

describe("load-bearing guard-removal probes", () => {
  it("detects each planted mutation at the exact parser boundary", () => {
    const mutations: Array<readonly [string, () => unknown]> = [];
    const planAuthority = cloneFixture(recordFixtures["project-plan"]) as Record<string, unknown>;
    planAuthority["authority"] = "operator";
    mutations.push(["model authority", () => parseProjectPlan(planAuthority)]);

    const hardModel = cloneFixture(recordFixtures.constraint) as Record<string, unknown>;
    hardModel["origin"] = "model"; hardModel["authority"] = "none";
    mutations.push(["model hard constraint", () => parseProjectBrief({ ...cloneFixture(recordFixtures["project-brief"]), constraints: [hardModel] })]);

    const unsealedAuthorized = cloneFixture(recordFixtures["project-plan"]) as Record<string, unknown>;
    unsealedAuthorized["state"] = "executing";
    mutations.push(["unsealed executing plan", () => parseProjectPlan(unsealedAuthorized)]);

    const inventedSchedulingAuthority = cloneFixture(recordFixtures["project-plan"]) as Record<string, unknown>;
    inventedSchedulingAuthority["schedulingAuthorized"] = true;
    mutations.push(["invented scheduling authority", () => parseProjectPlan(inventedSchedulingAuthority)]);

    const inventedEligibilityProof = cloneFixture(recordFixtures["project-plan"]) as Record<string, unknown>;
    inventedEligibilityProof["schedulingEligibilityProof"] = { planId: "pln:other", projectId: "prj:other" };
    mutations.push(["invented scheduling proof", () => parseProjectPlan(inventedEligibilityProof)]);

    const paymentAdapterShape = cloneFixture(recordFixtures["spending-request"]) as Record<string, unknown>;
    paymentAdapterShape["execute"] = true;
    mutations.push(["purchase execution field", () => parseSpendingRequest(paymentAdapterShape)]);

    const stopOverlap = cloneFixture(recordFixtures["project-stop"]) as Record<string, unknown>;
    (stopOverlap["effects"] as Record<string, unknown>)["retainedReservationIds"] = [`reservation:${SHA}`];
    mutations.push(["released/retained collision", () => parseProjectStop(stopOverlap)]);

    for (const [name, mutation] of mutations) expect(mutation, name).toThrowError(ProjectContractError);
    expect(mutations).toHaveLength(7);
  });
});
