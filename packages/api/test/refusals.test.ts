import { describe, expect, it } from "vitest";
import {
  APPROVAL_STATES,
  REFUSAL_CODES,
  REFUSAL_COPY,
  formatUnknownRefusalCode,
  parseApiRefusal,
  projectRefusal,
  type RefusalCode,
} from "../src/index.js";

const EXPECTED_REFUSAL_CATALOGUE = [
  ["BLOCKED_BY_ESTOP", { sentence: "Emergency stop is engaged — commands are refused until you resume.", nextStepId: "review-emergency-stop" }],
  ["BLOCKED_BY_PROJECT_STOP", { sentence: "This project is stopped — its commands are refused until you resume the project.", nextStepId: "resume-project-stop" }],
  ["BLOCKED_DISPATCH_PAUSED", { sentence: "You paused new work. Running sessions continue; nothing new starts until you resume.", nextStepId: "resume-new-work" }],
  ["SERVICE_NOT_READY", { sentence: "Reconnecting to the engine — commands are paused until the connection returns.", nextStepId: "wait-for-engine" }],
  ["IDENTITY_MISMATCH", { sentence: "The engine that answered is not the one this app started — not connecting.", nextStepId: "relaunch-application" }],
  ["SCHEMA_AHEAD", { sentence: "This app is older than the engine's data — update the app before continuing.", nextStepId: "open-about" }],
  ["IDEMPOTENCY_REPLAY", { sentence: null, nextStepId: "show-earlier-result" }],
  ["PAYLOAD_TOO_LARGE", { sentence: "That is too long to send — shorten it.", nextStepId: "focus-source-field" }],
  ["RATE_LIMITED", { sentence: "Too many requests — try again in a moment.", nextStepId: "wait-served-delay" }],
  ["DIGEST_MISMATCH", { sentence: "The request changed since it was raised — nothing happened. The task will raise a fresh request.", nextStepId: "wait-for-fresh-request" }],
  ["ROOT_UNREADABLE", { sentence: "That folder cannot be read.", nextStepId: "choose-another-folder" }],
  ["ROOT_NOT_CONTAINED", { sentence: "That folder is outside the locations this app may use.", nextStepId: "review-approved-roots" }],
  ["BRIEF_SUPERSEDED", { sentence: "The brief moved on while you were writing — review the current version.", nextStepId: "reload-brief" }],
  ["BLOCKING_UNANSWERED", { sentence: "Two questions still need an answer before work can be planned.", nextStepId: "focus-blocking-question" }],
  ["SET_SUPERSEDED", { sentence: "These questions were replaced by a newer set.", nextStepId: "show-current-question-set" }],
  ["PLAN_SEALED", { sentence: "The plan is already sealed — changes go through a revision.", nextStepId: "propose-plan-change" }],
  ["REVISION_STALE", { sentence: "The plan changed since you opened it — review the latest revision.", nextStepId: "reload-plan" }],
  ["SEAL_CONDITION_FAILED", { sentence: "The plan has not met every seal condition.", nextStepId: "review-seal-condition" }],
  ["APPROVAL_REQUIRED", { sentence: "This action needs your approval first.", nextStepId: "open-approval-request" }],
  ["EXPANSION_BOUND_EXCEEDED", { sentence: "That change is larger than a revision may be — it needs a new plan revision you review.", nextStepId: "review-new-revision" }],
  ["PLAN_NOT_EXECUTING", { sentence: "The plan is not running, so there is nothing to expand.", nextStepId: "none" }],
  ["GATE_NOT_READY", { sentence: "This stage has not met its exit criteria yet.", nextStepId: "review-stage-criteria" }],
  ["NOT_ELIGIBLE", { sentence: "This option is not eligible under the current rules.", nextStepId: "review-eligibility" }],
  ["PRODUCTION_REFUSED", { sentence: "Refused before starting — production execution is disabled at this stage.", nextStepId: "open-about" }],
  ["LIVE_SESSION_EXISTS", { sentence: "This task already has a live session.", nextStepId: "open-live-session" }],
  ["PAID_ROUTE_REQUIRES_APPROVAL", { sentence: "That route costs money — approve paid usage first.", nextStepId: "open-paid-usage-request" }],
  ["PROJECT_PAUSED", { sentence: "This project is paused — resume it to start work.", nextStepId: "resume-project" }],
  ["PROJECT_STOPPED", { sentence: "This project is stopped — resume it before starting work.", nextStepId: "resume-project-stop" }],
  ["HANDOVER_NOT_READY", { sentence: "Waiting for the previous session's context to be prepared.", nextStepId: "wait-for-handover" }],
  ["NO_OPEN_QUESTION", { sentence: "The agent is no longer waiting for an answer.", nextStepId: "refresh-view" }],
  ["SESSION_NOT_AWAITING", { sentence: "This session is not waiting for input.", nextStepId: "none" }],
  ["TEXT_TOO_LONG", { sentence: "Keep the note under 2 000 characters.", nextStepId: "focus-source-field" }],
  ["TASK_NOT_OPEN", { sentence: "This task is not waiting or blocked, so a note cannot be delivered.", nextStepId: "none" }],
  ["BOUND_VIOLATION", { sentence: "That note could not be delivered as written.", nextStepId: "review-input-bound" }],
  ["BLOCKER_CLEARED", { sentence: "This is no longer blocked.", nextStepId: "refresh-view" }],
  ["OPTION_PRECONDITION_UNMET", { sentence: "That option is not available yet.", nextStepId: "choose-another-option" }],
  ["RETRY_EXHAUSTED", { sentence: "This task has used all its retries — decide what happens next.", nextStepId: "review-blocker-options" }],
  ["RECONCILIATION_PENDING", { sentence: "The last attempt's work is still being checked.", nextStepId: "open-activity" }],
  ["IRREVERSIBLE_REQUIRES_APPROVAL", { sentence: "The last attempt may have had an irreversible effect — approve before repeating it.", nextStepId: "open-approval-request" }],
  ["HANDOVER_ALREADY_CONSUMED", { sentence: "That context was already used by an earlier attempt; this attempt continues from the same records.", nextStepId: "none" }],
  ["SESSION_NOT_RUNNING", { sentence: "This session is not running.", nextStepId: "none" }],
  ["TERMINATION_UNCONFIRMED", { sentence: "This session did not confirm it stopped — acknowledge it before continuing.", nextStepId: "acknowledge-termination" }],
  ["BINDING_MISMATCH", { sentence: "Cannot continue that conversation (configuration changed) — starting fresh.", nextStepId: "start-fresh-session" }],
  ["NOT_RESUMABLE", { sentence: "This session cannot be resumed.", nextStepId: "start-fresh-session" }],
  ["SESSION_TERMINAL", { sentence: "This session has already ended.", nextStepId: "none" }],
  ["UNPROVEN_TERMINATION", { sentence: "This session must be acknowledged as stopped before it can be archived.", nextStepId: "acknowledge-termination" }],
  ["RUN_NOT_TERMINAL", { sentence: "The session must stop before its work can be handed over.", nextStepId: "stop-session" }],
  ["PLAN_REVISION_MOVED", { sentence: "The plan changed since this context was prepared — it was set aside.", nextStepId: "wait-for-fresh-handover" }],
  ["TASK_NOT_IN_PLAN", { sentence: "That task is not in the current plan.", nextStepId: "none" }],
  ["APPROVAL_NOT_OPEN", { sentence: "This request was already decided.", nextStepId: "show-approval-decision" }],
  ["APPROVAL_EXPIRED", { sentence: "This approval expired — nothing happened.", nextStepId: "none" }],
  ["ACTOR_NOT_OPERATOR", { sentence: "Only you can decide this.", nextStepId: "none" }],
  ["NOT_REVOCABLE", { sentence: "One-time approvals cannot be revoked once used.", nextStepId: "none" }],
  ["AMOUNT_OUT_OF_BOUNDS", { sentence: "That amount is outside the range the task can use.", nextStepId: "focus-source-field" }],
  ["QUOTE_LOCKED", { sentence: "This quote can no longer change — reject it and ask for a new one.", nextStepId: "request-new-quote" }],
  ["NOT_AUTHORIZED_STATE", { sentence: "This can only be recorded for an approved, not-yet-executed request.", nextStepId: "none" }],
  ["REMINDER_TOO_LATE", { sentence: "That reminder would be after the request expires.", nextStepId: "choose-earlier-time" }],
  ["PROJECT_ARCHIVED", { sentence: "This project is archived.", nextStepId: "none" }],
  ["ESTOP_NOT_READY", { sentence: "A stop is already in progress.", nextStepId: "review-emergency-stop" }],
  ["ESTOP_PARTIAL", { sentence: "One session has not confirmed it stopped — acknowledge it before resuming.", nextStepId: "acknowledge-termination" }],
  ["ESTOP_NOT_ENGAGED", { sentence: "There is no stop to resume.", nextStepId: "none" }],
  ["SESSION_NOT_UNCONFIRMED", { sentence: "This session is not waiting for acknowledgement.", nextStepId: "none" }],
  ["EDITOR_UNAVAILABLE", { sentence: "VS Code was not found or could not be verified.", nextStepId: "show-editor-path" }],
  ["PATH_NOT_APPROVED", { sentence: "That folder is outside the project.", nextStepId: "none" }],
  ["DESCRIPTOR_UNVERIFIED", { sentence: "The editor's descriptor could not be verified — not launching.", nextStepId: "open-providers" }],
  ["REFRESH_LIMIT", { sentence: "Usage was already refreshed for this window.", nextStepId: "none" }],
  ["CATEGORY_LOCKED", { sentence: "This notification cannot be turned off.", nextStepId: "none" }],
  ["APPROVAL_NOT_CONSUMABLE", { sentence: "This approval can no longer be used — nothing happened.", nextStepId: "request-fresh-approval" }],
  ["SCOPE_MISMATCH", { sentence: "That action is outside what was approved — nothing happened.", nextStepId: "request-fresh-approval" }],
  ["EFFECT_FAILED", { sentence: "The action failed, so the approval was not used.", nextStepId: "retry-or-request-fresh-approval" }],
] as const satisfies readonly (readonly [RefusalCode, Readonly<{ sentence: string | null; nextStepId: string }>])[];

function detailsFor(code: RefusalCode): unknown {
  switch (code) {
    case "SEAL_CONDITION_FAILED": return { condition: 1 };
    case "APPROVAL_REQUIRED": return { class: "approval.paid-usage" };
    case "EXPANSION_BOUND_EXCEEDED": return { bound: "revision.scope" };
    case "NOT_ELIGIBLE": return { ruleIds: ["AL-5"] };
    case "OPTION_PRECONDITION_UNMET": return { reason: "evidence.pending" };
    case "APPROVAL_NOT_CONSUMABLE": return { state: "expired" };
    default: return null;
  }
}

describe("finite refusal taxonomy", () => {
  it("contains and projects every reconciled refusal variant", () => {
    const expectedCodes = EXPECTED_REFUSAL_CATALOGUE.map(([code]) => code);
    const expectedCopy = Object.fromEntries(EXPECTED_REFUSAL_CATALOGUE);
    expect(REFUSAL_CODES).toEqual(expectedCodes);
    expect(REFUSAL_COPY).toEqual(expectedCopy);
    expect(new Set(expectedCodes).size).toBe(70);
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

  it.each(APPROVAL_STATES)("accepts finite approval state %s", (approvalState) => {
    expect(parseApiRefusal({ code: "APPROVAL_NOT_CONSUMABLE", details: { state: approvalState } }).details).toEqual({ state: approvalState });
  });

  it("strictly validates all parameterized details", () => {
    expect(APPROVAL_STATES).toEqual([
      "requested", "approved", "consumed", "partially_consumed",
      "revoked", "rejected", "expired", "voided",
    ]);
    expect(parseApiRefusal({ code: "APPROVAL_REQUIRED", details: { class: "approval.external-message" } }).details).toEqual({ class: "approval.external-message" });
    expect(parseApiRefusal({ code: "EXPANSION_BOUND_EXCEEDED", details: { bound: "revision.tasks" } }).details).toEqual({ bound: "revision.tasks" });
    expect(parseApiRefusal({ code: "OPTION_PRECONDITION_UNMET", details: { reason: "quote.pending" } }).details).toEqual({ reason: "quote.pending" });
    expect(parseApiRefusal({ code: "NOT_ELIGIBLE", details: { ruleIds: ["RULE-B", "RULE-A"] } }).details).toEqual({ ruleIds: ["RULE-A", "RULE-B"] });

    expect(() => parseApiRefusal({ code: "SEAL_CONDITION_FAILED", details: { condition: 7 } })).toThrow(/safe integer/u);
    expect(() => parseApiRefusal({ code: "NOT_ELIGIBLE", details: { ruleIds: [] } })).toThrow(/at least one/u);
    expect(() => parseApiRefusal({ code: "NOT_ELIGIBLE", details: { ruleIds: ["AL-5", "AL-5"] } })).toThrow(/duplicate/u);
    expect(() => parseApiRefusal({ code: "APPROVAL_NOT_CONSUMABLE", details: { state: "other" } })).toThrow(/must be one of/u);
  });

  it("rejects unknown, missing, extra, and misplaced details", () => {
    expect(() => parseApiRefusal({ code: "NEW_CODE", details: null })).toThrow(/must be one of/u);
    expect(() => parseApiRefusal({ code: "RATE_LIMITED" })).toThrow(/required/u);
    expect(() => parseApiRefusal({ code: "RATE_LIMITED", details: null, prose: "untrusted" })).toThrow(/unexpected fields/u);
    expect(() => parseApiRefusal({ code: "RATE_LIMITED", details: {} })).toThrow(/must be null/u);
    expect(() => parseApiRefusal({ code: "APPROVAL_REQUIRED", details: null })).toThrow(/plain data object/u);
    expect(() => parseApiRefusal({ code: "APPROVAL_REQUIRED", details: { class: "approval.paid", extra: true } })).toThrow(/unexpected fields/u);
  });

  it("bounds unknown-code display without accepting it as a known refusal", () => {
    expect(formatUnknownRefusalCode("FUTURE_CODE_2")).toBe("Refused (FUTURE_CODE_2)");
    expect(formatUnknownRefusalCode("a".repeat(65))).toBe("Refused (UNKNOWN)");
    expect(formatUnknownRefusalCode("unsafe code")).toBe("Refused (UNKNOWN)");
    expect(formatUnknownRefusalCode(12)).toBe("Refused (UNKNOWN)");
  });
});
