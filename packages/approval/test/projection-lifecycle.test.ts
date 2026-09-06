import { describe, expect, it } from "vitest";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import { projectApproval, prepareApprovalRequest, type ApprovalClass, type ApprovalHead, type ApprovalOperationKind, type ApprovalOutcomeKind } from "../src/index.js";
import { approvalSha256 as hash } from "../src/testing/index.js";
import { B, T0, T1, T2, controls, harness, prepared, proposal, stop } from "./fixtures.js";

const AFTER = "2026-09-05T13:00:01.000Z";
// All stored pairs come from successful existing lifecycle operations. In
// particular, closed spending is never paired with a fabricated consumed row.
async function fixture(state: string, kind: ApprovalClass = "purchase") {
  const request = prepared(proposal(kind));
  if (state === "prepared") return { request, head: { approval: null, spending: null } as ApprovalHead };
  const adapter = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
  try {
    const h = await harness(adapter, request);
    async function step(operation: ApprovalOperationKind) {
      const result = await h.run(operation, operation === "record-receipt" ? { receiptRef: "operator reference 42" } : {});
      expect(result.outcome.kind, `reachable ${state}: ${operation}`).toBe("committed");
    }
    await step("create");
    if (kind !== "scope-expansion") await step("request-approval");
    if (!["requested", "rejected", "expired-request"].includes(state)) await step("approve");
    if (["authorized", "operator_executed", "reconciled", "withdrawn"].includes(state)) await step("authorize");
    if (["operator_executed", "reconciled"].includes(state)) { h.setTime(T1); await step("report-executed"); }
    if (state === "reconciled") await step("record-receipt");
    if (state === "withdrawn") await step("withdraw");
    if (state === "rejected") await step("decline");
    if (state === "revoked") await step("revoke");
    if (state === "voided") { h.setBinding({ ...request.proposal.binding, policy: { version: "policy:later", fingerprint: B } }); await step("invalidate"); }
    if (state.startsWith("expired")) { h.setTime(T2); await step("expire"); }
    const rows = await h.heads();
    return { request, head: { approval: (rows.approval!.payload as any).record, spending: rows.spending === null ? null : (rows.spending.payload as any).record } as ApprovalHead };
  } finally { await adapter.close(); }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function views(f: Fixture, now: string, condition = "match", outcome: ApprovalOutcomeKind | null = null) {
  const base = controls(f.request), drift = condition === "drift" || condition === "combined";
  const context = { serverNow: now, controls: { ...base, observedAt: now,
    binding: drift ? { ...base.binding, policy: { version: "policy:later", fingerprint: B } } : base.binding,
    projectActive: condition !== "inactive" && condition !== "combined",
    stops: condition === "stop" || condition === "combined" ? [stop()] : [] },
  outcome: outcome === null ? null : { kind: outcome, operationId: "projection:attempt", reason: "UNTRUSTED RECOVERY PROSE" } };
  const preparation = { kind: "ready" as const, request: f.request };
  const normal = projectApproval(preparation, f.head, { ...context, mode: "normal" }, hash);
  const developer = projectApproval(preparation, f.head, { ...context, mode: "developer" }, hash);
  expect(normal.authority).toBe("none"); expect(developer.authority).toBe("none");
  expect(normal.commands).toEqual([]); expect(developer.commands).toEqual([]);
  expect(developer.value).toMatchObject(normal.value);
  expect(normal.value.actions.every((a) => a.available === false)).toBe(true);
  expect(JSON.stringify(normal)).not.toContain("UNTRUSTED RECOVERY PROSE");
  return { value: normal.value, developer: developer.value };
}
function noFreshDecision(value: ReturnType<typeof views>["value"]) {
  expect(value.waiting).toBeNull(); expect(value.alternatives).toEqual([]);
  expect(value.alternativesKnown).toBe(false); expect(value.consequenceOfRefusal).toBeNull();
  expect(value.reason).not.toMatch(/needs an operator decision|needs a fresh decision/);
}

describe("pending presentation uses one effective validity decision", () => {
  const cases = (["purchase", "scope-expansion"] as const).flatMap((kind) =>
    ["prepared", "requested", "approved"].flatMap((state) => [T1, T2, AFTER].map((now) => ({ kind, state, now }))));
  it.each(cases)("$kind $state at $now", async ({ kind, state, now }) => {
    const { value } = views(await fixture(state, kind), now), expired = now >= T2;
    const label = state === "approved" ? "Approval expired" : "Request expired";
    expect(value).toMatchObject({ status: expired ? label : state === "prepared" ? "Request prepared" : state === "requested" ? "Decision needed" : "Approval recorded",
      approvalStatus: expired ? state === "prepared" ? "Request expired (no stored approval supplied)" : label
        : state === "prepared" ? "No stored approval supplied" : state === "requested" ? "Decision needed" : "Approval recorded",
      spendingStatus: kind === "scope-expansion" || state === "prepared" ? null : expired ? "Request validity expired"
        : state === "approved" ? "Approval recorded; authorization is not connected" : "Awaiting a decision",
      expiresAt: T2, expiryApplicable: true, expired, externalOutcome: null,
      caveats: ["Tax and fee details are unknown."] });
    expect(value.actions.map((a) => a.kind)).toEqual(expired ? ["fresh-request"] : state === "prepared" ? [] : state === "requested"
      ? ["approve", "decline", ...(kind === "purchase" ? ["replace"] : [])] : ["revoke", ...(kind === "purchase" ? ["replace"] : [])]);
    if (expired) { noFreshDecision(value); expect(value.headline).not.toContain("Review"); }
    else if (state === "approved") {
      expect(value.waiting).toContain(kind === "purchase" ? "Application authorization is not connected" : "Joint approval consumption and plan sealing are not connected");
      expect(value.consequenceOfRefusal).toBeNull(); expect(value.alternatives).toEqual([]);
    } else expect(value.waiting).toBeNull();
  });
  it.each([T1, T2, AFTER])("unknown quote preparation at %s cannot outlive request validity", (now) => {
    const p = proposal(), preparation = prepareApprovalRequest({ ...p, spending: { ...p.spending!, amount: { kind: "unknown" }, quote: null } }, T0, hash);
    const value = projectApproval(preparation, { approval: null, spending: null }, { mode: "normal", serverNow: now, controls: null, outcome: null }, hash).value;
    expect(value.status).toBe(now < T2 ? "Waiting for quote details" : "Request expired");
    expect(value.expiryApplicable).toBe(true); expect(value.expired).toBe(now >= T2);
    expect(value.actions.map((a) => a.kind)).toEqual([now < T2 ? "waiting" : "fresh-request"]);
    if (now >= T2) noFreshDecision(value);
  });
});

describe("durable paired history survives current conditions and elapsed validity", () => {
  const cases = [
    ["authorized", "match", T1, "Authorized record — external action remains manual", "Approval used", "authorized"],
    ["authorized", "combined", AFTER, "Authorized record — external action remains manual", "Approval used", "authorized"],
    ["operator_executed", "drift", AFTER, "Operator reported external action", "Approval used", "operator_executed"],
    ["reconciled", "stop", AFTER, "Operator reference recorded", "Approval used", "reconciled"],
    ["reconciled", "combined", AFTER, "Operator reference recorded", "Approval used", "reconciled"],
    ["withdrawn", "inactive", AFTER, "Spending request withdrawn", "Approval used", "withdrawn"],
    ["rejected", "drift", AFTER, "Declined", "Declined", "declined"],
    ["revoked", "stop", AFTER, "Approval revoked", "Approval revoked", "declined"],
    ["voided", "match", AFTER, "Approval invalidated", "Approval invalidated", "declined"],
    ["voided", "combined", AFTER, "Approval invalidated", "Approval invalidated", "declined"],
    ["expired-request", "inactive", AFTER, "Request expired", "Request expired", "quote_expired"],
    ["expired-approved", "match", AFTER, "Approval expired", "Approval expired", "quote_expired"],
  ] as const;
  it.each(cases)("%s with %s at %s retains %s", async (state, condition, now, status, approvalStatus, spendingState) => {
    const { value, developer } = views(await fixture(state), now, condition);
    const spendLabels = { authorized: "Authorized record — external action remains manual", operator_executed: "Operator reported external action",
      reconciled: "Operator reference recorded", withdrawn: "Spending request withdrawn", declined: "Spending request declined", quote_expired: "Quote expired" };
    expect(value).toMatchObject({ headline: "Spending request history", status, approvalStatus, spendingStatus: spendLabels[spendingState],
      expiresAt: T2, expiryApplicable: false, expired: false,
      externalOutcome: state === "operator_executed" || state === "reconciled" ? "The operator reported this external action; it has not been independently verified." : null });
    expect(value.actions.map((a) => a.kind)).toEqual(state === "authorized" ? ["report-executed", "withdraw"] : state === "operator_executed" ? ["record-receipt"] : []);
    expect(value.caveats).toEqual(["Tax and fee details are unknown.",
      ...(["drift", "combined"].includes(condition) ? ["The current binding differs from this recorded request."] : []),
      ...(["inactive", "combined"].includes(condition) ? ["The project is currently inactive."] : []),
      ...(["stop", "combined"].includes(condition) ? ["An active project stop currently applies."] : [])]);
    expect((developer as any).audit.operatorAssertedReceiptReference).toBe(state === "reconciled" ? "operator reference 42" : null);
    noFreshDecision(value);
  });
  it.each(["drift", "stop", "inactive", "combined"])("unused approval still reflects current %s refusal", async (condition) => {
    const { value } = views(await fixture("approved"), T1, condition);
    expect(value.status).toBe(condition === "drift" ? "Request binding changed" : condition === "inactive" ? "Project inactive" : "Project stopped");
    expect(value.approvalStatus).toBe("Approval recorded");
    expect(value.spendingStatus).toBe("Approval recorded; authorization is unavailable");
    expect(value.expiryApplicable).toBe(true); expect(value.expired).toBe(false);
    expect(value.actions.map((a) => a.kind)).toEqual(condition === "drift" ? ["fresh-request"] : []);
    expect(value.externalOutcome).toBeNull(); noFreshDecision(value);
  });
  it.each(["unknown", "corrupt"] as const)("%s recovery suppresses waiting without confirming a new operation", async (outcome) => {
    for (const kind of ["purchase", "scope-expansion"] as const) {
      const f = await fixture("approved", kind);
      for (const condition of ["match", "combined"]) {
        const { value } = views(f, T1, condition, outcome);
        expect(value.status).toBe(outcome === "unknown" ? "Save not confirmed" : "Stored evidence could not be verified");
        expect(value.actions.map((a) => a.kind)).toEqual(outcome === "unknown" ? ["observe"] : []);
        expect(value.approvalStatus).toBe("Approval recorded");
        expect(value.spendingStatus).toBe(kind === "purchase" ? "Approval recorded; authorization is unavailable" : null);
        expect(value.expired).toBe(false); expect(value.expiryApplicable).toBe(true); expect(value.externalOutcome).toBeNull();
        expect(value.caveats).toContain("Displayed records do not confirm the outcome of the attempted change.");
        noFreshDecision(value);
      }
    }
    const { value } = views(await fixture("reconciled"), AFTER, "combined", outcome);
    expect(value.status).toBe(outcome === "unknown" ? "Save not confirmed" : "Stored evidence could not be verified");
    expect(value).toMatchObject({ approvalStatus: "Approval used", spendingStatus: "Operator reference recorded", expired: false, expiryApplicable: false });
    expect(value.externalOutcome).toContain("has not been independently verified");
    expect(value.caveats).toContain("Displayed records do not confirm the outcome of the attempted change.");
    noFreshDecision(value);
  });
});
