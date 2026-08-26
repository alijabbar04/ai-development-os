import {
  parseApiRefusal,
  projectRefusal,
  type ApiRefusal,
  type RefusalPresentation,
} from "@ai-dev-os/api";

const SEAL_CONDITION_SENTENCES = Object.freeze({
  1: "Two tasks depend on each other — the plan cannot start.",
  2: "A task has no time or token budget.",
  3: "A required outcome has no task covering it.",
  4: "A hard constraint is not satisfied by the plan.",
  5: "The plan exceeds the project budget.",
  6: "Inferred scope needs your approval before work starts.",
} as const);

const APPROVAL_CLASS_WORDS = Object.freeze({
  "approval.credential-use": "using a saved credential",
  "approval.provider-call": "contacting a provider",
  "approval.elevation": "administrator access",
  "approval.destructive": "a destructive change",
  "approval.git-publication": "publishing repository changes",
  "approval.external-message": "sending an external message",
  "approval.install": "installing software",
  "approval.restart": "restarting a managed service",
  "approval.paid": "paid usage",
  "approval.paid-usage": "paid usage",
  "approval.purchase": "a purchase",
  "approval.subscription": "a subscription",
  "approval.spending-limit": "a spending limit",
  "approval.ui-automation": "controlling another application",
  "approval.scope-expansion": "the inferred scope",
} as const satisfies Record<string, string>);

const EXPANSION_SENTENCES = Object.freeze({
  "revision.scope": "That scope change is larger than a revision may be — it needs a new plan revision you review.",
  "revision.tasks": "That task-set change is larger than a revision may be — it needs a new plan revision you review.",
} as const satisfies Record<string, string>);

const ELIGIBILITY_SENTENCES = Object.freeze({
  "AL-5": "This option cannot use a borrowed account.",
  "ROUTE-PROVIDER-AVAILABLE": "This option needs an available provider.",
  "ROUTE-HEALTH-FRESH": "This option needs current provider health evidence.",
  "USAGE-AUTHORIZATION-REQUIRED": "This option needs confirmed profile authorisation.",
  "USAGE-REVOCATION-REFUSED": "This option is blocked because access is revoked or unconfirmed.",
} as const satisfies Record<string, string>);

const OPTION_REASON_WORDS = Object.freeze({
  "evidence.pending": "required evidence is still being checked",
  "quote.pending": "the quote is still being prepared",
  "reconciliation.pending": "the previous attempt is still being checked",
  "approval.pending": "the required approval is still open",
  "provider.unavailable": "the required provider is unavailable",
  "session.running": "the current session must finish first",
} as const satisfies Record<string, string>);

const APPROVAL_STATE_WORDS = Object.freeze({
  requested: "still waiting for a decision",
  approved: "already approved for a different effect",
  consumed: "already used",
  partially_consumed: "partly used and no longer valid for this effect",
  revoked: "revoked",
  rejected: "rejected",
  expired: "expired",
  voided: "voided",
} as const);

function fixedPresentation(
  refusal: ApiRefusal,
  sentence: string,
): RefusalPresentation {
  const base = projectRefusal(refusal);
  return Object.freeze({ code: base.code, sentence, nextStepId: base.nextStepId });
}

/**
 * C5 product-owned copy for the six parameterized C2 refusals. Source detail
 * values select from finite dictionaries; no caller-provided prose is echoed.
 */
export function projectC5Refusal(value: unknown): RefusalPresentation {
  const refusal = parseApiRefusal(value);
  switch (refusal.code) {
    case "SEAL_CONDITION_FAILED":
      return fixedPresentation(refusal, SEAL_CONDITION_SENTENCES[refusal.details.condition]);
    case "APPROVAL_REQUIRED": {
      const words = APPROVAL_CLASS_WORDS[refusal.details.class as keyof typeof APPROVAL_CLASS_WORDS]
        ?? "a protected action";
      return fixedPresentation(refusal, `Needs your approval first: ${words}.`);
    }
    case "EXPANSION_BOUND_EXCEEDED":
      return fixedPresentation(
        refusal,
        EXPANSION_SENTENCES[refusal.details.bound as keyof typeof EXPANSION_SENTENCES]
          ?? "That change is larger than a revision may be — it needs a new plan revision you review.",
      );
    case "NOT_ELIGIBLE": {
      const sentence = refusal.details.ruleIds
        .map((ruleId) => ELIGIBILITY_SENTENCES[ruleId as keyof typeof ELIGIBILITY_SENTENCES])
        .find((candidate) => candidate !== undefined)
        ?? "This option is not eligible under the current rules.";
      return fixedPresentation(refusal, sentence);
    }
    case "OPTION_PRECONDITION_UNMET": {
      const reason = OPTION_REASON_WORDS[refusal.details.reason as keyof typeof OPTION_REASON_WORDS]
        ?? "a required condition is not satisfied";
      return fixedPresentation(refusal, `That option is not available yet: ${reason}.`);
    }
    case "APPROVAL_NOT_CONSUMABLE":
      return fixedPresentation(
        refusal,
        `This approval can no longer be used (${APPROVAL_STATE_WORDS[refusal.details.state]}) — nothing happened.`,
      );
    default:
      return projectRefusal(refusal);
  }
}
