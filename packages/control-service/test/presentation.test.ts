import { APPROVAL_STATES } from "@ai-dev-os/api";
import { describe, expect, it } from "vitest";
import { projectC5Refusal } from "../src/index.js";

describe("C5 condition-specific refusal presentation", () => {
  it.each([
    [1, "Two tasks depend on each other — the plan cannot start."],
    [2, "A task has no time or token budget."],
    [3, "A required outcome has no task covering it."],
    [4, "A hard constraint is not satisfied by the plan."],
    [5, "The plan exceeds the project budget."],
    [6, "Inferred scope needs your approval before work starts."],
  ] as const)("projects seal condition %s with its exact product sentence", (condition, sentence) => {
    expect(projectC5Refusal({ code: "SEAL_CONDITION_FAILED", details: { condition } })).toEqual({
      code: "SEAL_CONDITION_FAILED",
      sentence,
      nextStepId: "review-seal-condition",
    });
  });

  it("uses finite approval, expansion, eligibility, and option dictionaries", () => {
    expect(projectC5Refusal({
      code: "APPROVAL_REQUIRED", details: { class: "approval.paid-usage" },
    }).sentence).toBe("Needs your approval first: paid usage.");
    expect(projectC5Refusal({
      code: "EXPANSION_BOUND_EXCEEDED", details: { bound: "revision.tasks" },
    }).sentence).toBe("That task-set change is larger than a revision may be — it needs a new plan revision you review.");
    expect(projectC5Refusal({
      code: "NOT_ELIGIBLE", details: { ruleIds: ["AL-5"] },
    }).sentence).toBe("This option cannot use a borrowed account.");
    expect(projectC5Refusal({
      code: "OPTION_PRECONDITION_UNMET", details: { reason: "evidence.pending" },
    }).sentence).toBe("That option is not available yet: required evidence is still being checked.");
  });

  it.each(APPROVAL_STATES)("names approval state %s without changing refusal semantics", (state) => {
    const output = projectC5Refusal({ code: "APPROVAL_NOT_CONSUMABLE", details: { state } });
    expect(output).toMatchObject({
      code: "APPROVAL_NOT_CONSUMABLE",
      nextStepId: "request-fresh-approval",
    });
    expect(output.sentence).toContain("This approval can no longer be used (");
    expect(output.sentence).toContain("— nothing happened.");
  });

  it("never echoes unknown identifiers or rule ids into product copy", () => {
    const canary = "untrusted.payload";
    const approval = projectC5Refusal({ code: "APPROVAL_REQUIRED", details: { class: canary } });
    const expansion = projectC5Refusal({ code: "EXPANSION_BOUND_EXCEEDED", details: { bound: canary } });
    const option = projectC5Refusal({ code: "OPTION_PRECONDITION_UNMET", details: { reason: canary } });
    const eligibility = projectC5Refusal({ code: "NOT_ELIGIBLE", details: { ruleIds: ["UNTRUSTED-PAYLOAD"] } });
    for (const output of [approval, expansion, option, eligibility]) {
      expect(output.sentence).not.toContain(canary);
      expect(output.sentence).not.toContain("UNTRUSTED-PAYLOAD");
    }
  });

  it("preserves the accepted C2 presentation for unparameterized refusals", () => {
    expect(projectC5Refusal({ code: "RATE_LIMITED", details: null })).toEqual({
      code: "RATE_LIMITED",
      sentence: "Too many requests — try again in a moment.",
      nextStepId: "wait-served-delay",
    });
  });
});
