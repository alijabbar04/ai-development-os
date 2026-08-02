import { describe, expect, it } from "vitest";
import { defaultDataHandlingPolicy, ValidationError } from "@ai-dev-os/domain";
import { createTrace } from "@ai-dev-os/providers";
import { POLICY_ACTIONS, PolicyError, createDeterministicPolicyBroker, createManualPolicyClock, parseApprovalEvidence, parseApprovalScope, parsePolicyRequest, parsePolicyRule } from "../src/index.js";

describe("policy validation and safety", () => {
  it("rejects empty approval scopes, unsupported schemas, duplicate rules, and hostile objects", () => {
    expect(() => parseApprovalScope({ projectId: null, taskId: null, providerInstanceId: null, workspaceId: null, operationId: null, traceId: null })).toThrow(ValidationError);
    expect(() => parsePolicyRule({ schemaVersion: 2 })).toThrow();
    const base = parsePolicyRule({ schemaVersion: 1, id: "duplicate", authority: "organization", effect: "allow", actions: ["workspace-read"], classifications: [], risks: [], requiredTransformations: [], approval: null, requiredLocality: "any", forbidInputLogging: false, forbidOutputLogging: false, forbidArtifactPersistence: false, forbidRetention: false, maxRetentionDays: null, forbiddenCapabilities: [] });
    expect(() => createDeterministicPolicyBroker({ policyVersion: "v1", rules: [base, base], clock: createManualPolicyClock() })).toThrow(PolicyError);
    expect(() => parsePolicyRequest(Object.create({ polluted: true }))).toThrow(ValidationError);
  });
  it("validates approval timestamps and never echoes rejected values", () => {
    const canary = "policy-secret-canary";
    expect(() => parseApprovalEvidence({ approvalRequestId: canary })).toThrow();
    try { parsePolicyRequest({ schemaVersion: 1, apiKey: canary }); } catch (error) { expect(JSON.stringify(error)).not.toContain(canary); }
  });
  it("accepts every normalized action and rejects non-normalized action forms and mismatched trace scopes", () => {
    const base = { schemaVersion: 1, action: "workspace-read", classification: "public", handlingPolicy: defaultDataHandlingPolicy("public"), risk: "low", locality: "local", provider: null, model: null, scope: { projectId: "p", taskId: null, providerInstanceId: null, workspaceId: null, operationId: null, traceId: "trace" }, subjectDigest: null, requestedCapabilities: [], transformationsApplied: [], approvalEvidence: [], retentionDays: null, trace: createTrace("trace"), requesterKind: "user" };
    for (const action of POLICY_ACTIONS) { expect(parsePolicyRequest({ ...base, action }).action).toBe(action); expect(() => parsePolicyRequest({ ...base, action: action.toUpperCase() })).toThrow(ValidationError); }
    expect(() => parsePolicyRequest({ ...base, scope: { ...base.scope, traceId: "other" } })).toThrow(ValidationError);
  });
  it("canonicalizes multiple approval records, rejects classification mismatches, and serializes structured errors", () => {
    const scope = { projectId: "p", taskId: null, providerInstanceId: null, workspaceId: null, operationId: null, traceId: "trace" };
    const evidence = (id: string) => ({ approvalRequestId: id, action: "workspace-read", risk: "low", scope, subjectDigest: "a".repeat(64), usage: "reusable", approverClass: "user", approverIdentityRef: "identity", result: "approved", decidedAt: "2026-08-02T00:00:00.000Z", expiresAt: "2026-08-02T01:00:00.000Z", revokedAt: null, consumedAt: null, evidenceRef: `evidence-${id}` });
    const parsed = parsePolicyRequest({ schemaVersion: 1, action: "workspace-read", classification: "public", handlingPolicy: defaultDataHandlingPolicy("public"), risk: "low", locality: "local", provider: null, model: null, scope, subjectDigest: "a".repeat(64), requestedCapabilities: [], transformationsApplied: [], approvalEvidence: [evidence("z"), evidence("a")], retentionDays: 1, trace: createTrace("trace"), requesterKind: "user" });
    expect(parsed.approvalEvidence.map((item) => item.approvalRequestId)).toEqual(["a", "z"]);
    expect(() => parsePolicyRequest({ ...parsed, classification: "internal" })).toThrow(ValidationError);
    const error = new PolicyError("INVALID_POLICY", "Invalid.", { causeName: "fixture" });
    expect(error.toJSON()).toEqual(expect.objectContaining({ code: "INVALID_POLICY" }));
  });
  it("uses the injected clock and reports observer failures safely", () => {
    const clock = createManualPolicyClock(); clock.advance(1_000);
    const allow = parsePolicyRule({ schemaVersion: 1, id: "allow", authority: "organization", effect: "allow", actions: ["workspace-read"], classifications: [], risks: [], requiredTransformations: [], approval: null, requiredLocality: "any", forbidInputLogging: false, forbidOutputLogging: false, forbidArtifactPersistence: false, forbidRetention: false, maxRetentionDays: null, forbiddenCapabilities: [] });
    const broker = createDeterministicPolicyBroker({ policyVersion: "v1", rules: [allow], clock, observer: () => { throw new Error("observer-secret"); } });
    const request = parsePolicyRequest({ schemaVersion: 1, action: "workspace-read", classification: "public", handlingPolicy: defaultDataHandlingPolicy("public"), risk: "low", locality: "local", provider: null, model: null, scope: { projectId: "p", taskId: null, providerInstanceId: null, workspaceId: null, operationId: null, traceId: "trace" }, subjectDigest: null, requestedCapabilities: [], transformationsApplied: [], approvalEvidence: [], retentionDays: null, trace: createTrace("trace"), requesterKind: "user" });
    expect(() => broker.evaluate(request)).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });
  it("sorts multiple approval requirements deterministically", () => {
    const makeRule = (id: string) => parsePolicyRule({ schemaVersion: 1, id, authority: "organization", effect: "conditional", actions: ["workspace-write"], classifications: [], risks: [], requiredTransformations: [], approval: { approverClass: "user", usage: "one-shot", ttlMs: 60_000 }, requiredLocality: "any", forbidInputLogging: false, forbidOutputLogging: false, forbidArtifactPersistence: false, forbidRetention: false, maxRetentionDays: null, forbiddenCapabilities: [] });
    const broker = createDeterministicPolicyBroker({ policyVersion: "v1", rules: [makeRule("z-approval"), makeRule("a-approval")], clock: createManualPolicyClock() });
    const request = parsePolicyRequest({ schemaVersion: 1, action: "workspace-write", classification: "public", handlingPolicy: defaultDataHandlingPolicy("public"), risk: "low", locality: "local", provider: null, model: null, scope: { projectId: "p", taskId: null, providerInstanceId: null, workspaceId: "w", operationId: null, traceId: "trace" }, subjectDigest: "a".repeat(64), requestedCapabilities: [], transformationsApplied: [], approvalEvidence: [], retentionDays: null, trace: createTrace("trace"), requesterKind: "user" });
    const decision = broker.evaluate(request);
    expect(decision.requiredApprovals).toHaveLength(2);
    expect(decision.requiredApprovals.map((item) => item.approvalRequestId)).toEqual([...decision.requiredApprovals.map((item) => item.approvalRequestId)].sort());
  });
});
