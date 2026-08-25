import { validation } from "@ai-dev-os/domain";
import { API_LIMITS } from "./constants.js";
import {
  apiFail,
  ensureExactAndPresent,
  ensureIdentifier,
  ensureRuleId,
  readSafeArray,
  readSafeRecord,
} from "./structural.js";

export interface RefusalCopy {
  readonly sentence: string | null;
  readonly nextStepId: string;
}

const RAW_REFUSAL_COPY = {
  BLOCKED_BY_ESTOP: { sentence: "Emergency stop is engaged — commands are refused until you resume.", nextStepId: "review-emergency-stop" },
  BLOCKED_BY_PROJECT_STOP: { sentence: "This project is stopped — its commands are refused until you resume the project.", nextStepId: "resume-project-stop" },
  BLOCKED_DISPATCH_PAUSED: { sentence: "You paused new work. Running sessions continue; nothing new starts until you resume.", nextStepId: "resume-new-work" },
  SERVICE_NOT_READY: { sentence: "Reconnecting to the engine — commands are paused until the connection returns.", nextStepId: "wait-for-engine" },
  IDENTITY_MISMATCH: { sentence: "The engine that answered is not the one this app started — not connecting.", nextStepId: "relaunch-application" },
  SCHEMA_AHEAD: { sentence: "This app is older than the engine's data — update the app before continuing.", nextStepId: "open-about" },
  IDEMPOTENCY_REPLAY: { sentence: null, nextStepId: "show-earlier-result" },
  PAYLOAD_TOO_LARGE: { sentence: "That is too long to send — shorten it.", nextStepId: "focus-source-field" },
  RATE_LIMITED: { sentence: "Too many requests — try again in a moment.", nextStepId: "wait-served-delay" },
  DIGEST_MISMATCH: { sentence: "The request changed since it was raised — nothing happened. The task will raise a fresh request.", nextStepId: "wait-for-fresh-request" },
  ROOT_UNREADABLE: { sentence: "That folder cannot be read.", nextStepId: "choose-another-folder" },
  ROOT_NOT_CONTAINED: { sentence: "That folder is outside the locations this app may use.", nextStepId: "review-approved-roots" },
  BRIEF_SUPERSEDED: { sentence: "The brief moved on while you were writing — review the current version.", nextStepId: "reload-brief" },
  BLOCKING_UNANSWERED: { sentence: "Questions still need an answer before work can be planned.", nextStepId: "focus-blocking-question" },
  SET_SUPERSEDED: { sentence: "These questions were replaced by a newer set.", nextStepId: "show-current-question-set" },
  PLAN_SEALED: { sentence: "The plan is already sealed — changes go through a revision.", nextStepId: "propose-plan-change" },
  REVISION_STALE: { sentence: "The plan changed since you opened it — review the latest revision.", nextStepId: "reload-plan" },
  SEAL_CONDITION_FAILED: { sentence: "The plan has not met every seal condition.", nextStepId: "review-seal-condition" },
  APPROVAL_REQUIRED: { sentence: "This action needs your approval first.", nextStepId: "open-approval-request" },
  EXPANSION_BOUND_EXCEEDED: { sentence: "That change is larger than a revision may be — it needs a new plan revision you review.", nextStepId: "review-new-revision" },
  PLAN_NOT_EXECUTING: { sentence: "The plan is not running, so there is nothing to expand.", nextStepId: "none" },
  GATE_NOT_READY: { sentence: "This stage has not met its exit criteria yet.", nextStepId: "review-stage-criteria" },
  NOT_ELIGIBLE: { sentence: "This option is not eligible under the current rules.", nextStepId: "review-eligibility" },
  PRODUCTION_REFUSED: { sentence: "Refused before starting — production execution is disabled at this stage.", nextStepId: "open-about" },
  LIVE_SESSION_EXISTS: { sentence: "This task already has a live session.", nextStepId: "open-live-session" },
  PAID_ROUTE_REQUIRES_APPROVAL: { sentence: "That route costs money — approve paid usage first.", nextStepId: "open-paid-usage-request" },
  PROJECT_PAUSED: { sentence: "This project is paused — resume it to start work.", nextStepId: "resume-project" },
  PROJECT_STOPPED: { sentence: "This project is stopped — resume it before starting work.", nextStepId: "resume-project-stop" },
  HANDOVER_NOT_READY: { sentence: "Waiting for the previous session's context to be prepared.", nextStepId: "wait-for-handover" },
  NO_OPEN_QUESTION: { sentence: "The agent is no longer waiting for an answer.", nextStepId: "refresh-view" },
  SESSION_NOT_AWAITING: { sentence: "This session is not waiting for input.", nextStepId: "none" },
  TEXT_TOO_LONG: { sentence: "Keep the note under 2,000 characters.", nextStepId: "focus-source-field" },
  TASK_NOT_OPEN: { sentence: "This task is not waiting or blocked, so a note cannot be delivered.", nextStepId: "none" },
  BOUND_VIOLATION: { sentence: "That note could not be delivered as written.", nextStepId: "review-input-bound" },
  BLOCKER_CLEARED: { sentence: "This is no longer blocked.", nextStepId: "refresh-view" },
  OPTION_PRECONDITION_UNMET: { sentence: "That option is not available yet.", nextStepId: "choose-another-option" },
  RETRY_EXHAUSTED: { sentence: "This task has used all its retries — decide what happens next.", nextStepId: "review-blocker-options" },
  RECONCILIATION_PENDING: { sentence: "The last attempt's work is still being checked.", nextStepId: "open-activity" },
  IRREVERSIBLE_REQUIRES_APPROVAL: { sentence: "The last attempt may have had an irreversible effect — approve before repeating it.", nextStepId: "open-approval-request" },
  HANDOVER_ALREADY_CONSUMED: { sentence: "That context was already used by an earlier attempt; this attempt continues from the same records.", nextStepId: "none" },
  SESSION_NOT_RUNNING: { sentence: "This session is not running.", nextStepId: "none" },
  TERMINATION_UNCONFIRMED: { sentence: "This session did not confirm it stopped — acknowledge it before continuing.", nextStepId: "acknowledge-termination" },
  BINDING_MISMATCH: { sentence: "Cannot continue that conversation because its configuration changed — starting fresh.", nextStepId: "start-fresh-session" },
  NOT_RESUMABLE: { sentence: "This session cannot be resumed.", nextStepId: "start-fresh-session" },
  SESSION_TERMINAL: { sentence: "This session has already ended.", nextStepId: "none" },
  UNPROVEN_TERMINATION: { sentence: "This session must be acknowledged as stopped before it can be archived.", nextStepId: "acknowledge-termination" },
  RUN_NOT_TERMINAL: { sentence: "The session must stop before its work can be handed over.", nextStepId: "stop-session" },
  PLAN_REVISION_MOVED: { sentence: "The plan changed since this context was prepared — it was set aside.", nextStepId: "wait-for-fresh-handover" },
  TASK_NOT_IN_PLAN: { sentence: "That task is not in the current plan.", nextStepId: "none" },
  APPROVAL_NOT_OPEN: { sentence: "This request was already decided.", nextStepId: "show-approval-decision" },
  APPROVAL_EXPIRED: { sentence: "This approval expired — nothing happened.", nextStepId: "none" },
  ACTOR_NOT_OPERATOR: { sentence: "Only you can decide this.", nextStepId: "none" },
  NOT_REVOCABLE: { sentence: "One-time approvals cannot be revoked once used.", nextStepId: "none" },
  AMOUNT_OUT_OF_BOUNDS: { sentence: "That amount is outside the range the task can use.", nextStepId: "focus-source-field" },
  QUOTE_LOCKED: { sentence: "This quote can no longer change — reject it and ask for a new one.", nextStepId: "request-new-quote" },
  NOT_AUTHORIZED_STATE: { sentence: "This can only be recorded for an approved, not-yet-executed request.", nextStepId: "none" },
  REMINDER_TOO_LATE: { sentence: "That reminder would be after the request expires.", nextStepId: "choose-earlier-time" },
  PROJECT_ARCHIVED: { sentence: "This project is archived.", nextStepId: "none" },
  ESTOP_NOT_READY: { sentence: "A stop is already in progress.", nextStepId: "review-emergency-stop" },
  ESTOP_PARTIAL: { sentence: "One session has not confirmed it stopped — acknowledge it before resuming.", nextStepId: "acknowledge-termination" },
  ESTOP_NOT_ENGAGED: { sentence: "There is no stop to resume.", nextStepId: "none" },
  SESSION_NOT_UNCONFIRMED: { sentence: "This session is not waiting for acknowledgement.", nextStepId: "none" },
  EDITOR_UNAVAILABLE: { sentence: "VS Code was not found or could not be verified.", nextStepId: "show-editor-path" },
  PATH_NOT_APPROVED: { sentence: "That folder is outside the project.", nextStepId: "none" },
  DESCRIPTOR_UNVERIFIED: { sentence: "The editor's descriptor could not be verified — not launching.", nextStepId: "open-providers" },
  REFRESH_LIMIT: { sentence: "Usage was already refreshed for this window.", nextStepId: "none" },
  CATEGORY_LOCKED: { sentence: "This notification cannot be turned off.", nextStepId: "none" },
  APPROVAL_NOT_CONSUMABLE: { sentence: "This approval can no longer be used — nothing happened.", nextStepId: "request-fresh-approval" },
  SCOPE_MISMATCH: { sentence: "That action is outside what was approved — nothing happened.", nextStepId: "request-fresh-approval" },
  EFFECT_FAILED: { sentence: "The action failed, so the approval was not used.", nextStepId: "retry-or-request-fresh-approval" },
} as const satisfies Record<string, RefusalCopy>;

for (const copy of Object.values(RAW_REFUSAL_COPY)) Object.freeze(copy);
export const REFUSAL_COPY = Object.freeze(RAW_REFUSAL_COPY);
export const REFUSAL_CODES = Object.freeze(Object.keys(REFUSAL_COPY) as RefusalCode[]);
export type RefusalCode = keyof typeof RAW_REFUSAL_COPY;

export const APPROVAL_CONSUMPTION_STATES = Object.freeze([
  "requested", "deferred-reminder", "approved", "partially-used",
  "consumed", "rejected", "expired", "voided",
] as const);
export type ApprovalConsumptionState = (typeof APPROVAL_CONSUMPTION_STATES)[number];

export type RefusalDetails =
  | null
  | Readonly<{ condition: 1 | 2 | 3 | 4 | 5 | 6 }>
  | Readonly<{ approvalClassId: string }>
  | Readonly<{ boundId: string }>
  | Readonly<{ ruleIds: readonly string[] }>
  | Readonly<{ reasonId: string }>
  | Readonly<{ approvalState: ApprovalConsumptionState }>;

export interface ApiRefusal {
  readonly code: RefusalCode;
  readonly details: RefusalDetails;
}

export interface RefusalPresentation {
  readonly code: RefusalCode;
  readonly sentence: string | null;
  readonly nextStepId: string;
}

const PARAMETERIZED_CODES = new Set<RefusalCode>([
  "SEAL_CONDITION_FAILED", "APPROVAL_REQUIRED", "EXPANSION_BOUND_EXCEEDED",
  "NOT_ELIGIBLE", "OPTION_PRECONDITION_UNMET", "APPROVAL_NOT_CONSUMABLE",
]);

function frozenDetails(key: string, value: unknown): RefusalDetails {
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  output[key] = value;
  return Object.freeze(output) as RefusalDetails;
}

function parseParameterizedDetails(code: RefusalCode, value: unknown, path: string): RefusalDetails {
  const details = readSafeRecord(value, path);
  switch (code) {
    case "SEAL_CONDITION_FAILED": {
      ensureExactAndPresent(details, ["condition"], path);
      const condition = validation.ensureSafeInteger(details["condition"], `${path}.condition`, 1, 6);
      return frozenDetails("condition", condition);
    }
    case "APPROVAL_REQUIRED":
      ensureExactAndPresent(details, ["approvalClassId"], path);
      return frozenDetails("approvalClassId", ensureIdentifier(details["approvalClassId"], `${path}.approvalClassId`, 64));
    case "EXPANSION_BOUND_EXCEEDED":
      ensureExactAndPresent(details, ["boundId"], path);
      return frozenDetails("boundId", ensureIdentifier(details["boundId"], `${path}.boundId`, 64));
    case "NOT_ELIGIBLE": {
      ensureExactAndPresent(details, ["ruleIds"], path);
      const items = readSafeArray(details["ruleIds"], `${path}.ruleIds`, API_LIMITS.maxRuleIds);
      if (items.length === 0) apiFail(`${path}.ruleIds`, "empty_rule_ids", "must contain at least one rule identifier.");
      const ruleIds = items.map((item, index) => ensureRuleId(item, `${path}.ruleIds[${index}]`));
      if (new Set(ruleIds).size !== ruleIds.length) apiFail(`${path}.ruleIds`, "duplicate_rule_id", "cannot contain duplicate rule identifiers.");
      return frozenDetails("ruleIds", Object.freeze([...ruleIds].sort()));
    }
    case "OPTION_PRECONDITION_UNMET":
      ensureExactAndPresent(details, ["reasonId"], path);
      return frozenDetails("reasonId", ensureIdentifier(details["reasonId"], `${path}.reasonId`, 64));
    case "APPROVAL_NOT_CONSUMABLE":
      ensureExactAndPresent(details, ["approvalState"], path);
      return frozenDetails("approvalState", validation.ensureEnum(details["approvalState"], `${path}.approvalState`, APPROVAL_CONSUMPTION_STATES));
    default:
      apiFail(path, "unexpected_details", "details are not defined for this refusal code.");
  }
}

export function parseApiRefusal(value: unknown, path = "refusal"): ApiRefusal {
  const record = readSafeRecord(value, path);
  ensureExactAndPresent(record, ["code", "details"], path);
  const code = validation.ensureEnum(record["code"], `${path}.code`, REFUSAL_CODES);
  let details: RefusalDetails;
  if (PARAMETERIZED_CODES.has(code)) {
    details = parseParameterizedDetails(code, record["details"], `${path}.details`);
  } else {
    if (record["details"] !== null) apiFail(`${path}.details`, "details_must_be_null", "must be null for this refusal code.");
    details = null;
  }
  return Object.freeze({ code, details });
}

export function projectRefusal(refusal: ApiRefusal): RefusalPresentation {
  const parsed = parseApiRefusal(refusal);
  const copy = REFUSAL_COPY[parsed.code];
  return Object.freeze({ code: parsed.code, sentence: copy.sentence, nextStepId: copy.nextStepId });
}

export function formatUnknownRefusalCode(value: unknown): string {
  if (typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value)) {
    return `Refused (${value})`;
  }
  return "Refused (UNKNOWN)";
}
