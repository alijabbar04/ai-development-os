import {
  deriveMoneyBinding, parseApprovalRequest, parseSpendingRequest,
  serializeCanonicalProjectJson, spendingSubjectMaterial,
  type ApprovalRequest, type SpendingRequest,
} from "@ai-dev-os/project";
import {
  APPROVAL_CLASSES, APPROVAL_OPERATIONS,
  type ApprovalBinding, type ApprovalExplanation, type ApprovalHashPort,
  type ApprovalOperation, type ApprovalPreparation, type ApprovalProposal,
  type OperatorDecisionEvidence, type PreparedApproval, type SpendingTerms,
} from "./contracts.js";
import { array, digest, identifier, ids, integer, nullable, oneOf, record, refuse, same, text, timestamp } from "./validation.js";

export function parseApprovalBinding(value: unknown): ApprovalBinding {
  const b = record(value, ["project", "scope", "accountRef", "providerModelId", "policy", "plan"]);
  const project = nullable(b["project"], (value) => {
    const p = record(value, ["projectId", "version", "contentDigest", "budgetAccountId"]);
    return Object.freeze({ projectId: identifier(p["projectId"], "prj:"), version: integer(p["version"], 1), contentDigest: digest(p["contentDigest"]), budgetAccountId: identifier(p["budgetAccountId"]) });
  });
  const s = record(b["scope"], ["projectId", "taskId", "providerInstanceId", "workspaceId", "operationId", "traceId"]);
  const scope = Object.freeze({
    projectId: nullable(s["projectId"], (v) => identifier(v, "prj:")),
    taskId: nullable(s["taskId"], (v) => identifier(v, "tsk:")),
    providerInstanceId: nullable(s["providerInstanceId"], identifier), workspaceId: nullable(s["workspaceId"], identifier),
    operationId: identifier(s["operationId"]), traceId: nullable(s["traceId"], identifier),
  });
  const policy = record(b["policy"], ["version", "fingerprint"]);
  const plan = nullable(b["plan"], (value) => {
    const p = record(value, ["planId", "revision", "version", "planDigest", "briefId", "briefVersion", "briefContentDigest", "acceptedCandidateDigest", "acceptanceEventId", "specificationDigest", "coverageDigest", "sealVerdictDigest", "requirementIds", "taskIds", "stageIds"]);
    return Object.freeze({
      planId: identifier(p["planId"], "pln:"), revision: integer(p["revision"], 1), version: integer(p["version"], 1), planDigest: digest(p["planDigest"]),
      briefId: identifier(p["briefId"], "brf:"), briefVersion: integer(p["briefVersion"], 1), briefContentDigest: digest(p["briefContentDigest"]),
      acceptedCandidateDigest: digest(p["acceptedCandidateDigest"]), acceptanceEventId: identifier(p["acceptanceEventId"]),
      specificationDigest: nullable(p["specificationDigest"], digest), coverageDigest: nullable(p["coverageDigest"], digest), sealVerdictDigest: digest(p["sealVerdictDigest"]),
      requirementIds: ids(p["requirementIds"]), taskIds: ids(p["taskIds"], "tsk:"), stageIds: ids(p["stageIds"], "stg:"),
    });
  });
  if (scope.projectId !== (project?.projectId ?? null) || plan !== null && project === null || scope.taskId !== null && plan === null) return refuse("binding.scope-mismatch");
  return Object.freeze({ project, scope, plan, accountRef: nullable(b["accountRef"], identifier), providerModelId: nullable(b["providerModelId"], identifier), policy: Object.freeze({ version: identifier(policy["version"]), fingerprint: digest(policy["fingerprint"]) }) });
}

function parseTerms(value: unknown): SpendingTerms {
  const s = record(value, ["vendor", "amount", "currency", "recurrence", "quote"]);
  const vendor = record(s["vendor"], ["name", "instanceRef"]);
  const a = record(s["amount"], (s["amount"] as { kind?: unknown } | null)?.kind === "unknown" ? ["kind"] : ["kind", "minorUnits"]);
  const amount = a["kind"] === "unknown" ? Object.freeze({ kind: "unknown" as const })
    : Object.freeze({ kind: oneOf(a["kind"], ["known"] as const), minorUnits: integer(a["minorUnits"], 1) });
  const currency = text(s["currency"], 3);
  if (!/^[A-Z]{3}$/u.test(currency)) return refuse("request.malformed");
  const recurrence = nullable(s["recurrence"], (value) => {
    const r = record(value, ["period", "occurrences"]);
    const occurrences = nullable(r["occurrences"], (v) => integer(v, 1));
    if (occurrences !== null && occurrences > 10_000) return refuse("request.malformed");
    return Object.freeze({ period: oneOf(r["period"], ["monthly", "annual"] as const), occurrences });
  });
  const quote = nullable(s["quote"], (value) => {
    const q = record(value, ["digest", "quotedAt", "expiresAt"]);
    const quotedAt = timestamp(q["quotedAt"]), expiresAt = timestamp(q["expiresAt"]);
    if (expiresAt <= quotedAt) return refuse("quote.invalid");
    return Object.freeze({ digest: digest(q["digest"]), quotedAt, expiresAt });
  });
  return Object.freeze({ vendor: Object.freeze({ name: text(vendor["name"], 256), instanceRef: identifier(vendor["instanceRef"]) }), amount, currency, recurrence, quote });
}

function parseExplanation(value: unknown): ApprovalExplanation {
  const e = record(value, ["reason", "alternatives", "consequence", "expectedMinorUnits", "renewal", "taxAndFees", "foreignExchange", "entitlement", "note"]);
  const note = record(e["note"], ["origin", "text"]);
  const alternatives = array(e["alternatives"], (v) => oneOf(v, ["no-cost-option", "existing-entitlement", "defer"] as const), 3);
  if (new Set(alternatives).size !== alternatives.length) return refuse("request.malformed");
  return Object.freeze({
    reason: oneOf(e["reason"], ["scope-review", "paid-resource-required", "operator-requested-change"] as const), alternatives,
    consequence: oneOf(e["consequence"], ["waits-for-decision", "work-can-continue-partially"] as const),
    expectedMinorUnits: nullable(e["expectedMinorUnits"], (v) => integer(v, 1)),
    renewal: oneOf(e["renewal"], ["not-recurring", "manual", "automatic-at-vendor", "unknown"] as const),
    taxAndFees: oneOf(e["taxAndFees"], ["included", "unknown"] as const), foreignExchange: oneOf(e["foreignExchange"], ["none", "unknown"] as const),
    entitlement: oneOf(e["entitlement"], ["new-spend", "existing-entitlement", "unknown"] as const),
    note: Object.freeze({ origin: oneOf(note["origin"], ["model", "operator", "system"] as const), text: text(note["text"]) }),
  });
}

export function parseApprovalProposal(value: unknown): ApprovalProposal {
  const p = record(value, ["schemaVersion", "class", "risk", "binding", "spending", "explanation", "createdAt", "expiresAt"]);
  if (p["schemaVersion"] !== 1) return refuse("request.malformed");
  const approvalClass = oneOf(p["class"], APPROVAL_CLASSES);
  const binding = parseApprovalBinding(p["binding"]), spending = nullable(p["spending"], parseTerms), explanation = parseExplanation(p["explanation"]);
  // C10 admits project-bound proposals only. Generic C6 bindings remain nullable;
  // no global stop ownership or migration is implied by those generic types.
  if (binding.project === null) return refuse("binding.project-absent");
  const createdAt = timestamp(p["createdAt"]), expiresAt = timestamp(p["expiresAt"]);
  if (expiresAt <= createdAt) return refuse("approval.expired");
  if ((approvalClass === "scope-expansion") !== (spending === null)) return refuse("money.class-mismatch");
  if (approvalClass === "scope-expansion" && (binding.plan === null || binding.plan.requirementIds.length === 0
    || binding.scope.taskId !== null || binding.scope.providerInstanceId !== null || binding.scope.workspaceId !== null)) return refuse("binding.scope-mismatch");
  if (approvalClass === "paid-usage" && (binding.scope.providerInstanceId === null || binding.providerModelId === null || binding.accountRef === null)) return refuse("binding.scope-mismatch");
  if (approvalClass !== "paid-usage" && binding.providerModelId !== null) return refuse("binding.scope-mismatch");
  if (spending !== null) {
    if ((approvalClass === "subscription") !== (spending.recurrence !== null)) return refuse("money.recurrence-mismatch");
    if ((spending.recurrence === null) !== (explanation.renewal === "not-recurring")) return refuse("money.recurrence-mismatch");
    if (spending.amount.kind === "known" && explanation.expectedMinorUnits !== null && explanation.expectedMinorUnits > spending.amount.minorUnits) return refuse("money.expectation-exceeds-limit");
    if (spending.quote !== null && (spending.quote.quotedAt < createdAt || expiresAt > spending.quote.expiresAt)) return refuse("quote.invalid");
  }
  return Object.freeze({ schemaVersion: 1, class: approvalClass, risk: oneOf(p["risk"], ["low", "medium", "high", "critical"] as const), binding, spending, explanation, createdAt, expiresAt });
}

export function approvalIdentityMaterial(proposal: ApprovalProposal, money: ApprovalRequest["money"]): string {
  return serializeCanonicalProjectJson({ schemaVersion: 1, class: proposal.class, risk: proposal.risk, binding: proposal.binding, money, usage: "one-shot", expiresAt: proposal.expiresAt });
}

function construct(proposal: ApprovalProposal, hash: ApprovalHashPort): PreparedApproval | null {
  const terms = proposal.spending;
  if (terms !== null && (terms.amount.kind === "unknown" || terms.quote === null)) return null;
  const spendingBase = terms === null ? null : parseSpendingRequest({
    schemaVersion: 1, spendingRequestId: "spd:pending", projectId: proposal.binding.scope.projectId,
    kind: proposal.class === "spending-limit" ? "recurring-limit-change" : proposal.class,
    vendor: terms.vendor, amountMinorUnits: terms.amount.kind === "known" ? terms.amount.minorUnits : refuse("quote.absent"),
    currency: terms.currency, recurrence: terms.recurrence, quotedAt: terms.quote!.quotedAt, quoteExpiresAt: terms.quote!.expiresAt, quoteDigest: terms.quote!.digest,
    justification: proposal.explanation.note.text, linkedApprovalRequestId: "apr:pending", state: "quoted", executedAt: null, externalReceiptRef: null, createdAt: proposal.createdAt,
  });
  const money = spendingBase === null ? null : deriveMoneyBinding(spendingBase);
  const identityDigest = digest(hash.sha256(approvalIdentityMaterial(proposal, money)));
  const subjectDigest = spendingBase === null ? proposal.binding.plan!.planDigest : digest(hash.sha256(spendingSubjectMaterial(spendingBase)));
  const effects = ["Record one bounded operator decision."];
  const exclusions = ["No task execution, payment, subscription change or production admission."];
  const approval = parseApprovalRequest({
    schemaVersion: 1, approvalRequestId: `apr:${identityDigest.slice(0, 32)}`, class: proposal.class,
    actions: [proposal.class === "scope-expansion" ? "approval" : proposal.class], risk: proposal.risk,
    scope: proposal.binding.scope, subjectDigest,
    subjectSummary: { what: "Review a bounded request.", why: "An operator decision is required.", changes: "Record the decision only.", where: "The bound scope.", reversible: false, scope: "One exact request.", effects, exclusions },
    usage: "one-shot", scopePattern: null, consumptionCeiling: null, consumptionCount: 0, retryAllowance: 0,
    effects, exclusions, money, requestedBy: { kind: "system", runId: null, reason: "A bounded decision is required." },
    state: "requested", createdAt: proposal.createdAt, expiresAt: proposal.expiresAt, decidedAt: null, approverClass: null, consumedAt: null, revokedAt: null, voidedBy: null,
  });
  const spending = spendingBase === null ? null : parseSpendingRequest({ ...spendingBase,
    linkedApprovalRequestId: approval.approvalRequestId,
    spendingRequestId: `spd:${digest(hash.sha256(serializeCanonicalProjectJson({ subject: spendingSubjectMaterial(spendingBase), projectId: spendingBase.projectId, approvalRequestId: approval.approvalRequestId }))).slice(0, 32)}`,
  });
  return Object.freeze({ proposal, approval, spending, identityDigest });
}

export function prepareApprovalRequest(value: unknown, evaluatedAt: string, hash: ApprovalHashPort): ApprovalPreparation {
  const proposal = parseApprovalProposal(value), now = timestamp(evaluatedAt);
  if (proposal.createdAt > now || proposal.expiresAt <= now) return refuse("approval.expired");
  if (proposal.spending?.quote !== null && proposal.spending?.quote !== undefined
    && (proposal.spending.quote.quotedAt > now || proposal.spending.quote.expiresAt <= now)) return refuse("quote.expired");
  const request = construct(proposal, hash);
  return request === null ? Object.freeze({ kind: "awaiting-quote", proposal }) : Object.freeze({ kind: "ready", request });
}

export function parsePreparedApproval(value: unknown, hash: ApprovalHashPort): PreparedApproval {
  const p = record(value, ["proposal", "approval", "spending", "identityDigest"]);
  const request = construct(parseApprovalProposal(p["proposal"]), hash);
  if (request === null || !same(request, p)) return refuse("request.binding-mismatch");
  return request;
}

/** Prove supplied immutable material. Only a store decoder can establish that
 * a mismatch is intrinsic to persisted evidence and classify it as corruption. */
export function assertApprovalRecord(request: PreparedApproval, value: unknown): ApprovalRequest {
  const a = parseApprovalRequest(value);
  const original = request.approval;
  if (!same(a, { ...original, state: a.state, decidedAt: a.decidedAt, approverClass: a.approverClass,
    consumedAt: a.consumedAt, revokedAt: a.revokedAt, voidedBy: a.voidedBy, consumptionCount: a.consumptionCount })) return refuse("request.binding-mismatch");
  return a;
}
export function assertSpendingRecord(request: PreparedApproval, value: unknown): SpendingRequest {
  const s = parseSpendingRequest(value);
  if (request.spending === null || !same(s, { ...request.spending, state: s.state, executedAt: s.executedAt, externalReceiptRef: s.externalReceiptRef })) return refuse("request.binding-mismatch");
  return s;
}

export function parseOperatorDecisionEvidence(value: unknown): OperatorDecisionEvidence {
  const a = record(value, ["kind", "identityRef", "approverClass"]);
  return Object.freeze({ kind: oneOf(a["kind"], ["operator"] as const), identityRef: identifier(a["identityRef"]), approverClass: oneOf(a["approverClass"], ["user", "project-owner", "organization-admin"] as const) });
}
export function parseApprovalOperation(value: unknown, hash: ApprovalHashPort): ApprovalOperation {
  const p = record(value, ["schemaVersion", "kind", "operationId", "request", "successor", "expectedApprovalVersion", "expectedSpendingVersion", "at", "receiptRef"]);
  if (p["schemaVersion"] !== 1) return refuse("request.malformed");
  const kind = oneOf(p["kind"], APPROVAL_OPERATIONS), successor = nullable(p["successor"], (v) => parsePreparedApproval(v, hash));
  const receiptRef = nullable(p["receiptRef"], (v) => text(v, 128));
  if ((kind === "replace") !== (successor !== null) || (kind === "record-receipt") !== (receiptRef !== null)) return refuse("request.malformed");
  if (receiptRef !== null && (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/u.test(receiptRef) || /[A-Fa-f0-9]{32}/u.test(receiptRef))) return refuse("request.unsafe-text");
  return Object.freeze({ schemaVersion: 1, kind, operationId: identifier(p["operationId"]), request: parsePreparedApproval(p["request"], hash), successor,
    expectedApprovalVersion: integer(p["expectedApprovalVersion"]), expectedSpendingVersion: integer(p["expectedSpendingVersion"]), at: timestamp(p["at"]), receiptRef });
}
