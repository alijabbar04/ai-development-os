import { isProjectStopActive } from "@ai-dev-os/project";
import type { ApprovalControls, ApprovalHashPort, ApprovalHead, ApprovalOutcome, ApprovalPreparation } from "./contracts.js";
import { parseApprovalControls } from "./evaluation.js";
import { assertApprovalRecord, assertSpendingRecord, parseApprovalProposal, parsePreparedApproval } from "./request.js";
import { oneOf, same, timestamp } from "./validation.js";

const approvalWords = Object.freeze({
  requested: "Decision needed", approved: "Approval recorded", rejected: "Declined",
  expired: "Approval expired", voided: "Approval invalidated", consumed: "Approval used",
  partially_consumed: "Partial consumption recorded", revoked: "Approval revoked",
});
const spendingWords = Object.freeze({
  drafted: "Preparation only", quoted: "Quote recorded", awaiting_approval: "Awaiting a decision",
  authorized: "Authorized record — external action remains manual", declined: "Spending request declined",
  quote_expired: "Quote expired", operator_executed: "Operator reported external action",
  withdrawn: "Spending request withdrawn", reconciled: "Operator reference recorded",
});
const outcomeWords = Object.freeze({
  committed: "Change recorded", refused: "Request refused", conflict: "Request does not match the current record",
  corrupt: "Stored evidence could not be verified", "not-recorded": "Checked: this attempt was not recorded",
  unknown: "Save not confirmed", "idempotent-replay": "Existing request found",
});
const reasons = Object.freeze({
  "scope-review": "Inferred project scope needs an operator decision.",
  "paid-resource-required": "A paid resource has been proposed.",
  "operator-requested-change": "A change to the requested terms needs a fresh decision.",
});
const recordedReasons = Object.freeze({
  "scope-review": "The request describes a proposed project scope change.",
  "paid-resource-required": "The request describes a proposed paid resource.",
  "operator-requested-change": "The request describes a proposed change to terms.",
});
const alternatives = Object.freeze({
  "no-cost-option": "Suggested no-cost option; availability has not been checked.",
  "existing-entitlement": "Check a separately configured entitlement; availability has not been checked.",
  defer: "Leave the request for later; its expiry stays the same.",
});
const unavailable = "Application commands are not connected.";
function action(kind: string, label: string) { return Object.freeze({ kind, label, available: false as const, reason: unavailable }); }

/** Display only. The mode never selects an issuer, writer, provider or permission. */
export function projectApproval(
  preparation: ApprovalPreparation, head: ApprovalHead,
  context: Readonly<{ mode: "normal" | "developer"; serverNow: string; controls: ApprovalControls | null; outcome: ApprovalOutcome | null }>,
  hash: ApprovalHashPort,
) {
  const mode = oneOf(context.mode, ["normal", "developer"] as const), now = timestamp(context.serverNow);
  const pendingQuote = preparation.kind === "awaiting-quote";
  const request = preparation.kind === "ready" ? parsePreparedApproval(preparation.request, hash) : null;
  const proposal = request?.proposal ?? parseApprovalProposal(preparation.kind === "awaiting-quote" ? preparation.proposal : null);
  const approval = request === null || head.approval === null ? null : assertApprovalRecord(request, head.approval);
  const spending = request === null || head.spending === null ? null : assertSpendingRecord(request, head.spending);
  const controls = context.controls === null ? null : parseApprovalControls(context.controls);
  const inactive = controls !== null && !controls.projectActive;
  const stopped = controls !== null && controls.stops.some((s) => s.projectId === proposal.binding.scope.projectId && isProjectStopActive(s));
  const stale = controls !== null && !same(controls.binding, proposal.binding);
  const pendingApproval = approval === null || approval.state === "requested" || approval.state === "approved";
  // The validity window gates unused decisions, not recorded manual history.
  // Keep its timestamp as evidence and state applicability explicitly.
  const expiryApplicable = pendingApproval, expired = expiryApplicable && proposal.expiresAt <= now;
  const outcome = context.outcome === null ? null : oneOf(context.outcome.kind, ["committed", "refused", "conflict", "corrupt", "not-recorded", "unknown", "idempotent-replay"] as const);
  const recoveryRequired = outcome === "unknown" || outcome === "corrupt";
  const blocked = stopped || inactive || stale;
  const freshDecision = pendingApproval && approval?.state !== "approved" && !expired && !blocked && !recoveryRequired;
  const expiryWords = approval?.state === "approved" || approval?.decidedAt !== null && approval?.decidedAt !== undefined ? "Approval expired" : "Request expired";
  const recordedApprovalStatus = approval === null ? "No stored approval supplied"
    : approval.state === "expired" ? expiryWords : approvalWords[approval.state];
  const approvalStatus = expired ? approval === null ? "Request expired (no stored approval supplied)" : expiryWords
    : approval?.state === "requested" && !freshDecision ? "Request recorded" : recordedApprovalStatus;
  const spendingStatus = spending === null ? null
    : pendingApproval && expired ? "Request validity expired"
      : pendingApproval && spending.state === "awaiting_approval"
        ? approval?.state === "approved" ? blocked || recoveryRequired ? "Approval recorded; authorization is unavailable" : "Approval recorded; authorization is not connected"
          : !freshDecision ? "Request recorded; authorization is unavailable" : spendingWords.awaiting_approval
        : spendingWords[spending.state];
  const terms = proposal.spending;
  const status = outcome === "unknown" ? outcomeWords.unknown : outcome === "corrupt" ? outcomeWords.corrupt
    : pendingApproval ? stopped ? "Project stopped" : inactive ? "Project inactive" : stale ? "Request binding changed"
      : expired ? expiryWords : pendingQuote ? "Waiting for quote details" : approval?.state === "approved" ? recordedApprovalStatus
        : spending?.state === "quoted" ? spendingWords.quoted : approval === null ? "Request prepared" : recordedApprovalStatus
      : approval.state !== "consumed" ? recordedApprovalStatus : spendingStatus ?? recordedApprovalStatus;
  const actions = outcome === "unknown" ? [action("observe", "Check what was saved")]
    : outcome === "corrupt" || pendingApproval && (stopped || inactive) ? []
      : pendingApproval && (stale || expired) ? [action("fresh-request", "Review a newly bound request")]
        : pendingQuote ? [action("waiting", "Waiting for a supplied quote")]
          : spending?.state === "authorized" ? [action("report-executed", "Record an action you performed"), action("withdraw", "Withdraw")]
            : spending?.state === "operator_executed" ? [action("record-receipt", "Record your reference")]
              : approval?.state === "approved" ? [action("revoke", "Revoke the unused approval"), ...(spending === null ? [] : [action("replace", "Create a request with changed terms")])]
                : approval?.state === "requested" && (spending === null || spending.state === "awaiting_approval")
                  ? [action("approve", "Approve the exact terms"), action("decline", "Decline"), ...(spending === null ? [] : [action("replace", "Create a request with changed terms")])]
                  : [];
  const explanation = proposal.explanation;
  const value = Object.freeze({
    headline: freshDecision ? terms === null ? "Review project scope" : "Review a spending request"
      : pendingApproval ? terms === null ? "Project scope decision record" : "Spending request record"
        : terms === null ? "Project scope decision history" : "Spending request history",
    status, approvalStatus, spendingStatus,
    serverNow: now, expiresAt: proposal.expiresAt, expiryApplicable, expired,
    outcome: outcome === null ? null : outcomeWords[outcome],
    recovery: outcome === "unknown" ? "Your change may or may not have been recorded. Nothing is retried automatically. Each requested check is a bounded read."
      : outcome === "not-recorded" ? "Checked: this attempt was not recorded. A new decision would be a new explicit attempt."
        : outcome === "conflict" ? "This attempt was refused because the request material or stored version did not match. Review the current request."
          : outcome === "corrupt" ? "The stored evidence needs investigation before another decision." : null,
    ceiling: terms === null || terms.amount.kind === "unknown" ? null : Object.freeze({ amountMinorUnits: terms.amount.minorUnits, currency: terms.currency }),
    expectedMinorUnits: explanation.expectedMinorUnits,
    recurrence: terms?.recurrence ?? null,
    renewal: explanation.renewal === "automatic-at-vendor" ? "The vendor may renew this arrangement. Any change or cancellation remains manual."
      : explanation.renewal === "manual" ? "Renewal is manual." : explanation.renewal === "unknown" ? "Renewal terms are unknown." : "No recurring charge is described.",
    quote: terms?.quote === null || terms?.quote === undefined ? null : Object.freeze({ quotedAt: terms.quote.quotedAt, expiresAt: terms.quote.expiresAt, provenance: "provided-input" }),
    reason: freshDecision ? reasons[explanation.reason] : recordedReasons[explanation.reason],
    alternatives: Object.freeze(freshDecision ? explanation.alternatives.map((kind) => alternatives[kind]) : []),
    alternativesKnown: freshDecision && explanation.alternatives.length > 0,
    consequenceOfRefusal: !freshDecision ? null : explanation.consequence === "work-can-continue-partially" ? "The request describes partial continuation; execution readiness has not been established." : "The proposed work waits for a decision.",
    caveats: Object.freeze([
      ...(explanation.taxAndFees === "unknown" ? ["Tax and fee details are unknown."] : []),
      ...(explanation.foreignExchange === "unknown" ? ["Currency conversion exposure is unknown."] : []),
      ...(explanation.entitlement === "existing-entitlement" ? ["The request describes an existing entitlement. Approval does not establish its availability."] : []),
      ...(stale ? ["The current binding differs from this recorded request."] : []),
      ...(inactive ? ["The project is currently inactive."] : []),
      ...(stopped ? ["An active project stop currently applies."] : []),
      ...(recoveryRequired ? ["Displayed records do not confirm the outcome of the attempted change."] : []),
    ]),
    truth: "An approval records one decision. External purchases and subscription changes remain manual. Approval does not start work or establish production readiness.",
    waiting: approval?.state === "approved" && !expired && !blocked && !recoveryRequired
      ? terms === null ? "Your scope decision is recorded. Joint approval consumption and plan sealing are not connected."
        : "Your spending decision is recorded. Application authorization is not connected. External action remains manual." : null,
    externalOutcome: spending?.state === "operator_executed" || spending?.state === "reconciled" ? "The operator reported this external action; it has not been independently verified." : null,
    // Untrusted prose has its own provenance and quoted-content channel. It is
    // never interpolated into state, reasons, refusal, authority or actions.
    untrustedQuotes: Object.freeze([
      Object.freeze({ label: "Untrusted quoted note", provenance: explanation.note.origin, text: explanation.note.text }),
      ...(terms === null ? [] : [Object.freeze({ label: "Untrusted quoted vendor name", provenance: "provided-input", text: terms.vendor.name })]),
    ]),
    actions: Object.freeze(actions),
  });
  return Object.freeze({ mode, authority: "none" as const, commands: Object.freeze([] as const),
    value: mode === "normal" ? value : Object.freeze({ ...value, audit: Object.freeze({ label: "Decision and binding evidence", approvalRequestId: request?.approval.approvalRequestId ?? null, spendingRequestId: request?.spending?.spendingRequestId ?? null, binding: proposal.binding, subjectDigest: request?.approval.subjectDigest ?? null, operatorAssertedReceiptReference: spending?.externalReceiptRef ?? null, productionEnabled: false }) }),
  });
}
