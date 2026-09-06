import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertSpendingAuthorization, deriveMoneyBinding, parseApprovalRequest, parseSpendingRequest, spendingSubjectMaterial, type ApprovalRequest } from "../src/index.js";
import { cloneFixture, recordFixtures, T0, T1, T2 } from "./fixtures.js";
const hash = { sha256: (text: string) => createHash("sha256").update(text).digest("hex") };
function pair(kind: "purchase" | "subscription" | "paid-usage" | "recurring-limit-change" = "purchase") {
  const spending = parseSpendingRequest({ ...cloneFixture(recordFixtures["spending-request"]), kind, recurrence: kind === "subscription" ? { period: "monthly", occurrences: 12 } : null });
  const approval = parseApprovalRequest({ ...cloneFixture(recordFixtures["approval-request"]),
    approvalRequestId: spending.linkedApprovalRequestId, class: kind === "recurring-limit-change" ? "spending-limit" : kind,
    actions: [kind === "recurring-limit-change" ? "spending-limit" : kind],
    scope: { projectId: spending.projectId, taskId: null, providerInstanceId: null, workspaceId: null, operationId: "op:money", traceId: null },
    money: deriveMoneyBinding(spending), subjectDigest: hash.sha256(spendingSubjectMaterial(spending)),
    state: "consumed", consumptionCount: 1, decidedAt: T1, consumedAt: T1, approverClass: "user", expiresAt: T2,
  });
  return { spending, approval };
}
describe("SEC-07 derives actual money and exact scope", () => {
  it.each(["purchase", "subscription", "paid-usage", "recurring-limit-change"] as const)("authorizes only a matching parsed %s record", (kind) => {
    const { spending, approval } = pair(kind);
    expect(() => assertSpendingAuthorization(spending, approval, hash)).not.toThrow();
  });
  it("rejects valid cross-project substitution even though old subject bytes and all money terms are identical", () => {
    const { spending, approval } = pair();
    const substituted = parseSpendingRequest({ ...spending, projectId: "prj:another" });
    expect(spendingSubjectMaterial(substituted)).toBe(spendingSubjectMaterial(spending));
    expect(deriveMoneyBinding(substituted)).toEqual(approval.money);
    // Planted historical digest-only predicate accepts this exact negative.
    const historical = substituted.linkedApprovalRequestId === approval.approvalRequestId && approval.state === "consumed"
      && approval.class === substituted.kind && approval.subjectDigest === hash.sha256(spendingSubjectMaterial(substituted));
    expect(historical).toBe(true);
    expect(() => assertSpendingAuthorization(substituted, approval, hash)).toThrow();
  });
  it("uses explicit global-only null project semantics", () => {
    const { spending, approval } = pair();
    const global = parseSpendingRequest({ ...spending, projectId: null });
    expect(() => assertSpendingAuthorization(global, approval, hash)).toThrow();
    const globalApproval = parseApprovalRequest({ ...approval, scope: { ...approval.scope, projectId: null } });
    expect(() => assertSpendingAuthorization(global, globalApproval, hash)).not.toThrow();
    expect(() => assertSpendingAuthorization(spending, globalApproval, hash)).toThrow();
  });
  it.each([
    { amountMinorUnits: 1 }, { currency: "USD" }, { vendor: { name: "Another vendor", instanceRef: "vendor:other" } },
    { kind: "ceiling" }, { quoteDigest: "b".repeat(64) }, { quotedAt: T0 }, { quoteExpiresAt: "2026-09-06T13:00:00.000Z" },
  ])("rejects independently altered money %j", (change) => {
    const { spending, approval } = pair();
    const altered = parseApprovalRequest({ ...approval, money: { ...approval.money, ...change } });
    expect(() => assertSpendingAuthorization(spending, altered, hash)).toThrow();
  });
  it.each([{ period: "annual" }, { occurrences: 11 }])("rejects altered recurrence %j", (change) => {
    const { spending, approval } = pair("subscription");
    const altered = parseApprovalRequest({ ...approval, money: { ...approval.money, ...change } });
    expect(() => assertSpendingAuthorization(spending, altered, hash)).toThrow();
  });
  it.each(["taskId", "providerInstanceId", "workspaceId"] as const)("requires actual %s coordinates", (key) => {
    const { spending, approval } = pair();
    const value = key === "taskId" ? "tsk:one" : "scope:one";
    const bound = parseApprovalRequest({ ...approval, scope: { ...approval.scope, [key]: value } });
    expect(() => assertSpendingAuthorization(spending, bound, hash)).toThrow();
    const scope = { taskId: null, providerInstanceId: null, workspaceId: null, [key]: value };
    expect(() => assertSpendingAuthorization(spending, bound, hash, scope)).not.toThrow();
  });
  it("rejects subject, class, identity, timing and unknown-field substitutions", () => {
    const { spending, approval } = pair();
    for (const change of [{ subjectDigest: "b".repeat(64) }, { approvalRequestId: "apr:other" }, { class: "subscription", actions: ["subscription"] }, { consumedAt: T0, decidedAt: T0 }, { extra: true }]) {
      expect(() => assertSpendingAuthorization(spending, { ...approval, ...change } as ApprovalRequest, hash)).toThrow();
    }
  });
});
