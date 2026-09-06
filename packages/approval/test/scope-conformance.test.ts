import { describe, expect, it } from "vitest";
import { parseApprovalRequest, parseProjectPlan, planDigestMaterial } from "@ai-dev-os/project";
import { assertConsumedScopeApproval } from "../src/index.js";
import { approvalSha256 as hash } from "../src/testing/index.js";
import { recordFixtures } from "../../project/test/fixtures.js";
import { B, T0, T1, controls, prepared, proposal, stop } from "./fixtures.js";

function fixture() {
  const base = proposal("scope-expansion");
  const raw = { ...(recordFixtures["project-plan"] as object), planId: "pln:fixture", briefId: "brf:fixture", projectId: base.binding.scope.projectId };
  const first = parseProjectPlan(raw), plan = parseProjectPlan({ ...first, planDigest: hash.sha256(planDigestMaterial(first)) });
  const request = prepared({ ...base, binding: { ...base.binding, plan: { ...base.binding.plan!, planDigest: plan.planDigest, taskIds: ["tsk:one"], stageIds: ["stg:one"], requirementIds: ["req:one"], specificationDigest: null, coverageDigest: null } } });
  // Synthetic value representing what ONLY the later joint transaction may
  // produce. No C10 store operation creates or persists this consumed approval.
  const approval = parseApprovalRequest({ ...request.approval, state: "consumed", consumptionCount: 1, decidedAt: T0, consumedAt: T0, approverClass: "user" });
  return { plan, evidence: { request, approval, aggregateVersion: 3, consumptionEventId: "consumption:joint-fixture" }, current: controls(request) };
}
describe("R2 consumed scope evidence conformance, no plan writes", () => {
  it.each([{ requirementIds: ["req:absent"] }, { taskIds: ["tsk:absent"] }, { stageIds: ["stg:absent"] }, { specificationDigest: B }, { coverageDigest: B }])("rejects internally inconsistent plan evidence %j", (change) => {
    const f = fixture(), base = f.evidence.request.proposal;
    const request = prepared({ ...base, binding: { ...base.binding, plan: { ...base.binding.plan!, ...change } } });
    const approval = parseApprovalRequest({ ...request.approval, state: "consumed", consumptionCount: 1, decidedAt: T0, consumedAt: T0, approverClass: "user" });
    expect(() => assertConsumedScopeApproval({ ...f.evidence, request, approval }, controls(request), f.plan, hash)).toThrow("binding.stale");
  });
  it("checks full original/current binding and the actual plan digest", () => {
    const f = fixture();
    expect(() => assertConsumedScopeApproval(f.evidence, f.current, f.plan, hash)).not.toThrow();
    expect(() => assertConsumedScopeApproval(f.evidence, f.current, { ...f.plan, planId: "pln:other" }, hash)).toThrow();
    expect(() => assertConsumedScopeApproval(f.evidence, f.current, { ...f.plan, budgetCeiling: { ...f.plan.budgetCeiling!, maximumCostMicros: 10 } }, hash)).toThrow();
    expect(() => assertConsumedScopeApproval(f.evidence, { ...f.current, binding: { ...f.current.binding, plan: { ...f.current.binding.plan!, version: 2 } } }, f.plan, hash)).toThrow();
    expect(() => assertConsumedScopeApproval(f.evidence, { ...f.current, binding: { ...f.current.binding, policy: { version: "policy:two", fingerprint: B } } }, f.plan, hash)).toThrow();
  });
  it("requires actual consumption, current stop evidence and supported shape", () => {
    const f = fixture();
    expect(() => assertConsumedScopeApproval({ ...f.evidence, approval: f.evidence.request.approval }, f.current, f.plan, hash)).toThrow("scope.consumption-unproven");
    expect(() => assertConsumedScopeApproval({ ...f.evidence, aggregateVersion: 1 }, f.current, f.plan, hash)).toThrow();
    expect(() => assertConsumedScopeApproval(f.evidence, { ...f.current, stops: [stop()] }, f.plan, hash)).toThrow("project.stopped");
    expect(() => assertConsumedScopeApproval(f.evidence, { ...f.current, projectActive: false }, f.plan, hash)).toThrow();
    expect(() => assertConsumedScopeApproval(f.evidence, { ...f.current, observedAt: "2026-09-05T11:59:00.000Z" }, f.plan, hash)).toThrow("scope.consumption-unproven");
    const money = prepared();
    const usedMoney = parseApprovalRequest({ ...money.approval, state: "consumed", consumptionCount: 1, decidedAt: T0, consumedAt: T0, approverClass: "user" });
    expect(() => assertConsumedScopeApproval({ ...f.evidence, request: money, approval: usedMoney }, controls(money), f.plan, hash)).toThrow("scope.consumption-unproven");
  });
});
