import { describe, expect, it } from "vitest";
import type { AiPlanningSessionView, PlanningCommandResult } from "@ai-dev-os/application/planning-contracts";
import { aiPlanningReasonMessage, aiPlanningRequestMessage, aiSavedAnswerReadiness, planningRecoveryDirective, planningResultMessage } from "../src/presentation/adapter.js";

function result(reason: string, kind: PlanningCommandResult["kind"] = "refused"): PlanningCommandResult {
  return { kind, reason, commandId: "owned-command", projectId: "owned-project", workspace: null, projectionWarning: null };
}
const question = Object.freeze({ questionId: "period", question: "Which reminder period?", whyItMatters: "Sets the schedule.", proposedDefault: "Weekly", blocking: true });
const answer = Object.freeze({ questionId: question.questionId, value: "I decline a reminder schedule." });
function session(answers: AiPlanningSessionView["draft"]["answers"]): Pick<AiPlanningSessionView, "questions" | "draft" | "clarificationHistory"> {
  return { questions: [question], draft: { description: "Garden journal", includeRepositorySummary: false, answers, understanding: null, proposal: null },
    clarificationHistory: [{ round: 1, requestId: "request-1", questions: [question], answers, materialChangeReason: null }] };
}

describe("actionable AI planning recovery presentation", () => {
  it.each([
    ["ai.LIVE_ROUTE_BLOCKED", "isolation checks"],
    ["ai.previous-clarification-unanswered", "save your planning edits"],
    ["ai.clarification-answer-required", "never accepted for you"],
    ["ai.local-request-cap", "three AI requests and two clarification rounds"],
    ["ai.clarification-material-change-required", "material change"],
    ["ai.context-conflict", "earlier context"],
    ["ai.route-changed", "fresh consent"],
    ["ai.provider.MALFORMED_RESPONSE", "unsupported tool data"],
    ["ai.provider.QUOTA_EXCEEDED", "usage limit"],
    ["ai.provider.RATE_LIMITED", "will not retry automatically"],
    ["ai.provider.AUTHENTICATION_FAILED", "existing subscription sign-in"],
    ["ai.provider.POLICY_DENIED", "disclosure checks"],
    ["ai.provider.DEADLINE_EXCEEDED", "does not prove"],
    ["ai.history-capacity", "Existing work is preserved"],
  ])("gives the same next step for %s in both modes", (reason, expected) => {
    const normal = planningResultMessage(result(reason), "AI planning");
    const developer = planningResultMessage(result(reason), "AI planning", true);
    expect(normal).toContain(expected);
    expect(normal).not.toContain(reason);
    expect(developer).toBe(`${normal} Details: ${reason}`);
    expect(planningRecoveryDirective(result(reason), "owned-command")).toEqual({ pendingCommandId: null, reloadRequired: false });
  });

  it("keeps uncertain command observation and corrupt-data protections ahead of retry guidance", () => {
    for (const kind of ["unknown", "corrupt"] as const) {
      const command = result("ai.command-outcome-unconfirmed", kind);
      expect(planningResultMessage(command, "AI planning")).toMatch(/Observe this exact command|Keep the exact command for observation/u);
      expect(planningRecoveryDirective(command, "owned-command")).toEqual({ pendingCommandId: "owned-command", reloadRequired: kind === "corrupt" });
    }
  });

  it("does not turn cancellation, timeout or unknown usage into a no-call claim", () => {
    const request = { state: "outcome-unknown" as const, reason: "ai.provider.DEADLINE_EXCEEDED", usageState: "unknown" as const };
    const normal = aiPlanningRequestMessage(request)!;
    expect(normal).toContain("neither retries it"); expect(normal).toContain("Provider usage is unknown"); expect(normal).not.toContain("No provider call");
    expect(aiPlanningRequestMessage(request, true)).toBe(`${normal} Details: ${request.reason}`);
    expect(aiPlanningRequestMessage({ state: "cancelled", reason: "operator.cancelled", usageState: "reported" })).toContain("Reported provider usage remains");
    expect(aiPlanningRequestMessage({ state: "cancelled", reason: "operator.cancelled", usageState: "not-called" })).toContain("No provider call is recorded");
    expect(aiPlanningRequestMessage({ state: "stale", reason: "ai.context-changed-after-dispatch", usageState: "reported" })).toContain("cannot overwrite or be adopted");
  });

  it("retains the model's bounded incomplete-output explanation and hides unknown codes in Normal", () => {
    const incomplete = "The model output is incomplete for an editable brief or task plan. Its original contribution remains saved.";
    expect(aiPlanningReasonMessage(incomplete)).toContain(incomplete);
    const unknown = { state: "refused" as const, reason: "ai.future-reason", usageState: "not-called" as const };
    expect(aiPlanningRequestMessage(unknown)).not.toContain(unknown.reason);
    expect(aiPlanningRequestMessage(unknown, true)).toContain(unknown.reason);
    expect(aiPlanningRequestMessage({ state: "succeeded", reason: null, usageState: "reported" })).toBeNull();
  });
});

describe("saved clarification answers control both display modes", () => {
  it("never substitutes a proposed default, another question's answer or empty typing", () => {
    for (const answers of [[], [{ questionId: "other-question", value: "Weekly" }], [{ questionId: question.questionId, value: "  " }]]) {
      const value = session(answers);
      expect(aiSavedAnswerReadiness(value)).toMatchObject({ ready: false });
      expect(aiSavedAnswerReadiness(value).reason).toContain("Defaults are never selected");
    }
    const value = session([answer]), before = JSON.stringify(value);
    expect(aiSavedAnswerReadiness(value)).toEqual({ ready: true, reason: null });
    expect(JSON.stringify(value)).toBe(before);
  });

  it("requires retained earlier-round answers as well as the current saved answer", () => {
    const nextQuestion = { ...question, questionId: "day", question: "Which day?" }, nextAnswer = { questionId: "day", value: "Monday" };
    const previous = session([]), value = { ...previous, questions: [nextQuestion], draft: { ...previous.draft, answers: [nextAnswer] }, clarificationHistory: [...previous.clarificationHistory,
      { round: 2 as const, requestId: "request-2", questions: [nextQuestion], answers: [nextAnswer], materialChangeReason: "Saved answers changed." }] };
    expect(aiSavedAnswerReadiness(value)).toMatchObject({ ready: false });
    expect(aiSavedAnswerReadiness(value).reason).toContain("earlier clarification");
    const complete = { ...value, clarificationHistory: value.clarificationHistory.map(round => round.round === 1 ? { ...round, answers: [answer] } : round) };
    expect(aiSavedAnswerReadiness(complete)).toEqual({ ready: true, reason: null });
  });
});
