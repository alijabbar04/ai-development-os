import { describe, expect, it } from "vitest";
import { defaultDataHandlingPolicy } from "@ai-dev-os/domain";
import {
  createDeterministicPolicyBroker, createManualPolicyClock, parsePolicyRequest, parsePolicyRule, parseApprovalRequirement,
  type ApprovalEvidence, type ApprovalRequirement, type ApprovalUsage,
} from "../src/index.js";
const T0 = "2026-08-02T00:00:00.000Z";
function rule(usage: ApprovalUsage = "one-shot", id = "approval") {
  return parsePolicyRule({ schemaVersion: 1, id, authority: "project", effect: "conditional", actions: ["workspace-write"], classifications: [], risks: [], requiredTransformations: [], approval: { approverClass: "user", usage, ttlMs: 600_000 }, requiredLocality: "any", forbidInputLogging: false, forbidOutputLogging: false, forbidArtifactPersistence: false, forbidRetention: false, maxRetentionDays: null, forbiddenCapabilities: [] });
}
function request(approvalEvidence: readonly ApprovalEvidence[] = []) {
  return parsePolicyRequest({ schemaVersion: 1, action: "workspace-write", classification: "public", handlingPolicy: defaultDataHandlingPolicy("public"), risk: "low", locality: "local", provider: null, model: null,
    scope: { projectId: "project", taskId: null, providerInstanceId: null, workspaceId: "workspace", operationId: "operation", traceId: "trace" }, subjectDigest: "a".repeat(64), requestedCapabilities: [], transformationsApplied: [], approvalEvidence, retentionDays: null,
    trace: { traceId: "trace", runId: null, taskId: null, taskRunId: null }, requesterKind: "user" });
}
function evidence(r: ApprovalRequirement, changes: Partial<ApprovalEvidence> = {}): ApprovalEvidence {
  return { approvalRequestId: r.approvalRequestId, action: r.action, risk: r.risk, scope: r.scope, subjectDigest: r.subjectDigest, usage: r.usage, approverClass: r.approverClass, approverIdentityRef: "operator:fixture", result: "approved", decidedAt: T0, expiresAt: r.expiresAt, revokedAt: null, consumedAt: null, evidenceRef: "evidence:fixture", ...changes };
}
function setup(usage: ApprovalUsage = "one-shot") {
  const clock = createManualPolicyClock(T0), rules = [rule(usage)];
  const broker = createDeterministicPolicyBroker({ policyVersion: "v1", rules, clock });
  const original = broker.evaluate(request()).requiredApprovals[0]!;
  return { clock, broker, original, rules };
}
describe("SEC-01 and SEC-02 original approval requirements", () => {
  it.each(["one-shot", "reusable"] as const)("refuses crossed %s evidence on repeated evaluations", (usage) => {
    const { broker, original } = setup(usage);
    const crossed = evidence(original, { usage: usage === "one-shot" ? "reusable" : "one-shot" });
    for (let i = 0; i < 2; i++) {
      const decision = broker.evaluate(request([crossed]));
      expect(decision.outcome).toBe("conditional"); expect(decision.approvalsToConsume).toEqual([]);
    }
    const matching = broker.evaluate(request([evidence(original)]));
    expect(matching.outcome).toBe("allowed");
    expect(matching.approvalsToConsume).toEqual(usage === "one-shot" ? [original.approvalRequestId] : []);
  });
  it.each([
    { decidedAt: "2026-08-02T00:01:00.000Z" },
    { expiresAt: "2026-08-02T00:11:00.000Z" },
    { revokedAt: "2026-08-02T00:00:00.000Z" },
    { consumedAt: "2026-08-02T00:00:00.000Z" },
    { subjectDigest: "b".repeat(64) },
  ])("refuses invalid evidence %j", (change) => {
    const { broker, original } = setup();
    expect(broker.evaluate(request([evidence(original, change)])).outcome).toBe("conditional");
  });
  it("does not slide expiry forward as time passes, and restores an exact trusted original after restart", () => {
    const { broker, clock, original, rules } = setup();
    clock.advance(60_000);
    expect(broker.evaluate(request([evidence(original)])).outcome).toBe("allowed");
    expect(broker.evaluate(request()).requiredApprovals[0]).toEqual(original);
    const restored = createDeterministicPolicyBroker({ policyVersion: "v1", rules, clock, originalRequirements: [original] });
    expect(restored.evaluate(request([evidence(original)])).outcome).toBe("allowed");
    const withoutOriginal = createDeterministicPolicyBroker({ policyVersion: "v1", rules, clock });
    expect(withoutOriginal.evaluate(request([evidence(original)])).outcome).toBe("conditional");
    clock.advance(540_000);
    expect(broker.evaluate(request([evidence(original)])).outcome).toBe("conditional");
    expect(broker.evaluate(request()).requiredApprovals[0]!.expiresAt).toBe("2026-08-02T00:10:00.000Z");
  });
  it("rejects a future original and an evidence decision before issuance", () => {
    const { original, rules } = setup();
    const future = parseApprovalRequirement({ ...original, issuedAt: "2026-08-02T00:01:00.000Z" });
    const broker = createDeterministicPolicyBroker({ policyVersion: "v1", rules, clock: createManualPolicyClock(), originalRequirements: [future] });
    expect(broker.evaluate(request([evidence(future)])).outcome).toBe("conditional");
  });
  it("binds policy revision and normalized rule contents even with a colliding custom ID source", () => {
    const clock = createManualPolicyClock(), rules = [rule()], idSource = () => "fixed-approval-id";
    const original = createDeterministicPolicyBroker({ policyVersion: "v1", rules, clock, idSource }).evaluate(request()).requiredApprovals[0]!;
    for (const options of [{ policyVersion: "v2", rules }, { policyVersion: "v1", rules: [rule("reusable")] }]) {
      const broker = createDeterministicPolicyBroker({ ...options, clock, idSource, originalRequirements: [original] });
      const decision = broker.evaluate(request([evidence(original)]));
      expect(decision.outcome).toBe("denied");
      expect(decision.reasons.map((r) => r.code)).toContain("APPROVAL_REQUIREMENT_STALE");
    }
  });
  it("does not turn future or mis-scoped denial prose into a current decision", () => {
    const { broker, original } = setup();
    expect(broker.evaluate(request([evidence(original, { result: "denied", decidedAt: "2026-08-02T00:01:00.000Z" })])).outcome).toBe("conditional");
    expect(broker.evaluate(request([evidence(original, { result: "denied", scope: { ...original.scope, workspaceId: null } })])).outcome).toBe("conditional");
  });
  it("strictly parses original records, including shape and validity", () => {
    const { original, rules, clock } = setup();
    expect(parseApprovalRequirement(original)).toEqual(original);
    for (const changed of [{ ...original, issuedAt: original.expiresAt }, { ...original, invented: true }, { ...original, policyFingerprint: "invalid" }]) expect(() => parseApprovalRequirement(changed)).toThrow();
    expect(() => createDeterministicPolicyBroker({ policyVersion: "v1", rules, clock, originalRequirements: [original, original] })).toThrow();
  });
});
describe("policy canonical code-unit ordering", () => {
  it("orders mixed-case and punctuation IDs independently and keeps fingerprints stable under permutation", () => {
    const { original, rules, clock } = setup();
    const ids = ["a", "A:", "A.", "Z", "A-", "A"];
    const values = ids.map((id) => evidence(original, { approvalRequestId: id, evidenceRef: id }));
    expect(request(values).approvalEvidence.map((e) => e.approvalRequestId)).toEqual(["A", "A-", "A.", "A:", "Z", "a"]);
    const broker = createDeterministicPolicyBroker({ policyVersion: "v1", rules, clock });
    expect(broker.evaluate(request(values)).fingerprint).toBe(broker.evaluate(request([...values].reverse())).fingerprint);
  });
});
