import { describe, expect, it } from "vitest";
import {
  APPROVAL_CONSUMPTION_STATES,
  REFUSAL_CODES,
  REFUSAL_COPY,
  formatUnknownRefusalCode,
  parseApiRefusal,
  projectRefusal,
  type RefusalCode,
} from "../src/index.js";

function detailsFor(code: RefusalCode): unknown {
  switch (code) {
    case "SEAL_CONDITION_FAILED": return { condition: 1 };
    case "APPROVAL_REQUIRED": return { approvalClassId: "approval.paid-usage" };
    case "EXPANSION_BOUND_EXCEEDED": return { boundId: "revision.scope" };
    case "NOT_ELIGIBLE": return { ruleIds: ["AL-5"] };
    case "OPTION_PRECONDITION_UNMET": return { reasonId: "evidence.pending" };
    case "APPROVAL_NOT_CONSUMABLE": return { approvalState: "expired" };
    default: return null;
  }
}

describe("finite refusal taxonomy", () => {
  it("contains and projects every reconciled refusal variant", () => {
    expect(REFUSAL_CODES).toHaveLength(70);
    expect(new Set(REFUSAL_CODES).size).toBe(70);
    for (const code of REFUSAL_CODES) {
      const parsed = parseApiRefusal({ code, details: detailsFor(code) });
      const projected = projectRefusal(parsed);
      expect(projected.code).toBe(code);
      expect(projected.nextStepId).toMatch(/^[a-z][a-z0-9-]*$/u);
      if (code === "IDEMPOTENCY_REPLAY") expect(projected.sentence).toBeNull();
      else expect(projected.sentence?.length).toBeGreaterThan(0);
      expect(Object.isFrozen(REFUSAL_COPY[code])).toBe(true);
    }
  });

  it.each([1, 2, 3, 4, 5, 6] as const)("accepts seal condition %s and refuses bounds", (condition) => {
    expect(parseApiRefusal({ code: "SEAL_CONDITION_FAILED", details: { condition } }).details).toEqual({ condition });
  });

  it.each(APPROVAL_CONSUMPTION_STATES)("accepts finite approval state %s", (approvalState) => {
    expect(parseApiRefusal({ code: "APPROVAL_NOT_CONSUMABLE", details: { approvalState } }).details).toEqual({ approvalState });
  });

  it("strictly validates all parameterized details", () => {
    expect(parseApiRefusal({ code: "APPROVAL_REQUIRED", details: { approvalClassId: "approval.external-message" } }).details).toEqual({ approvalClassId: "approval.external-message" });
    expect(parseApiRefusal({ code: "EXPANSION_BOUND_EXCEEDED", details: { boundId: "revision.tasks" } }).details).toEqual({ boundId: "revision.tasks" });
    expect(parseApiRefusal({ code: "OPTION_PRECONDITION_UNMET", details: { reasonId: "quote.pending" } }).details).toEqual({ reasonId: "quote.pending" });
    expect(parseApiRefusal({ code: "NOT_ELIGIBLE", details: { ruleIds: ["RULE-B", "RULE-A"] } }).details).toEqual({ ruleIds: ["RULE-A", "RULE-B"] });

    expect(() => parseApiRefusal({ code: "SEAL_CONDITION_FAILED", details: { condition: 7 } })).toThrow(/safe integer/u);
    expect(() => parseApiRefusal({ code: "NOT_ELIGIBLE", details: { ruleIds: [] } })).toThrow(/at least one/u);
    expect(() => parseApiRefusal({ code: "NOT_ELIGIBLE", details: { ruleIds: ["AL-5", "AL-5"] } })).toThrow(/duplicate/u);
    expect(() => parseApiRefusal({ code: "APPROVAL_NOT_CONSUMABLE", details: { approvalState: "other" } })).toThrow(/must be one of/u);
  });

  it("rejects unknown, missing, extra, and misplaced details", () => {
    expect(() => parseApiRefusal({ code: "NEW_CODE", details: null })).toThrow(/must be one of/u);
    expect(() => parseApiRefusal({ code: "RATE_LIMITED" })).toThrow(/required/u);
    expect(() => parseApiRefusal({ code: "RATE_LIMITED", details: null, prose: "untrusted" })).toThrow(/unexpected fields/u);
    expect(() => parseApiRefusal({ code: "RATE_LIMITED", details: {} })).toThrow(/must be null/u);
    expect(() => parseApiRefusal({ code: "APPROVAL_REQUIRED", details: null })).toThrow(/plain data object/u);
    expect(() => parseApiRefusal({ code: "APPROVAL_REQUIRED", details: { approvalClassId: "approval.paid", extra: true } })).toThrow(/unexpected fields/u);
  });

  it("bounds unknown-code display without accepting it as a known refusal", () => {
    expect(formatUnknownRefusalCode("FUTURE_CODE_2")).toBe("Refused (FUTURE_CODE_2)");
    expect(formatUnknownRefusalCode("a".repeat(65))).toBe("Refused (UNKNOWN)");
    expect(formatUnknownRefusalCode("unsafe code")).toBe("Refused (UNKNOWN)");
    expect(formatUnknownRefusalCode(12)).toBe("Refused (UNKNOWN)");
  });
});
