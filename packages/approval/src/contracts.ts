import type { ApprovalRequest, SpendingRequest, ProjectStop, SpendingDigestPort } from "@ai-dev-os/project";

export const APPROVAL_PRODUCTION_ENABLED = false as const;
export const APPROVAL_AUTHORITY = "none" as const;
export const APPROVAL_AVAILABLE_COMMANDS = Object.freeze([] as const);
export const APPROVAL_RUNTIME_CAPABILITIES = Object.freeze([] as const);
export const APPROVAL_CLASSES = Object.freeze(["scope-expansion", "paid-usage", "purchase", "subscription", "spending-limit"] as const);
export type ApprovalClass = typeof APPROVAL_CLASSES[number];
export type ApprovalHashPort = SpendingDigestPort;

export interface ApprovalBinding {
  readonly project: Readonly<{ projectId: string; version: number; contentDigest: string; budgetAccountId: string }> | null;
  readonly scope: ApprovalRequest["scope"];
  readonly accountRef: string | null;
  readonly providerModelId: string | null;
  readonly policy: Readonly<{ version: string; fingerprint: string }>;
  readonly plan: Readonly<{
    planId: string; revision: number; version: number; planDigest: string;
    briefId: string; briefVersion: number; briefContentDigest: string;
    acceptedCandidateDigest: string; acceptanceEventId: string;
    specificationDigest: string | null; coverageDigest: string | null;
    sealVerdictDigest: string; requirementIds: readonly string[];
    taskIds: readonly string[]; stageIds: readonly string[];
  }> | null;
}

export interface SpendingTerms {
  readonly vendor: SpendingRequest["vendor"];
  readonly amount: Readonly<{ kind: "known"; minorUnits: number }> | Readonly<{ kind: "unknown" }>;
  readonly currency: string;
  readonly recurrence: SpendingRequest["recurrence"];
  readonly quote: Readonly<{ digest: string; quotedAt: string; expiresAt: string }> | null;
}
export interface ApprovalExplanation {
  readonly reason: "scope-review" | "paid-resource-required" | "operator-requested-change";
  readonly alternatives: readonly ("no-cost-option" | "existing-entitlement" | "defer")[];
  readonly consequence: "waits-for-decision" | "work-can-continue-partially";
  readonly expectedMinorUnits: number | null;
  readonly renewal: "not-recurring" | "manual" | "automatic-at-vendor" | "unknown";
  readonly taxAndFees: "included" | "unknown";
  readonly foreignExchange: "none" | "unknown";
  readonly entitlement: "new-spend" | "existing-entitlement" | "unknown";
  readonly note: Readonly<{ origin: "model" | "operator" | "system"; text: string }>;
}
export interface ApprovalProposal {
  readonly schemaVersion: 1;
  readonly class: ApprovalClass;
  readonly risk: ApprovalRequest["risk"];
  readonly binding: ApprovalBinding;
  readonly spending: SpendingTerms | null;
  readonly explanation: ApprovalExplanation;
  readonly createdAt: string;
  readonly expiresAt: string;
}
export interface PreparedApproval {
  readonly proposal: ApprovalProposal;
  readonly approval: ApprovalRequest;
  readonly spending: SpendingRequest | null;
  readonly identityDigest: string;
}
export type ApprovalPreparation = Readonly<{ kind: "ready"; request: PreparedApproval }>
  | Readonly<{ kind: "awaiting-quote"; proposal: ApprovalProposal }>;

export const APPROVAL_OPERATIONS = Object.freeze([
  "create", "request-approval", "approve", "decline", "authorize", "revoke", "expire",
  "invalidate", "replace", "report-executed", "record-receipt", "withdraw",
] as const);
export type ApprovalOperationKind = typeof APPROVAL_OPERATIONS[number];
export interface ApprovalOperation {
  readonly schemaVersion: 1;
  readonly kind: ApprovalOperationKind;
  readonly operationId: string;
  readonly request: PreparedApproval;
  readonly successor: PreparedApproval | null;
  readonly expectedApprovalVersion: number;
  readonly expectedSpendingVersion: number;
  readonly at: string;
  readonly receiptRef: string | null;
}
export interface OperatorDecisionEvidence {
  readonly kind: "operator";
  readonly identityRef: string;
  readonly approverClass: NonNullable<ApprovalRequest["approverClass"]>;
}
export interface ApprovalControls {
  readonly binding: ApprovalBinding;
  readonly projectActive: boolean;
  readonly stops: readonly ProjectStop[];
  readonly stopScanComplete: true;
  readonly observedAt: string;
}
export interface ApprovalHead {
  readonly approval: ApprovalRequest | null;
  readonly spending: SpendingRequest | null;
}
export interface ApprovalMutation {
  readonly aggregateType: "approval-request" | "spending-request";
  readonly aggregateId: string;
  readonly expectedVersion: number;
  readonly proposal: ApprovalProposal;
  readonly record: ApprovalRequest | SpendingRequest;
}

declare const approvalAuthorizationBrand: unique symbol;
/** Non-serializable identity capability; a cast or public object proves nothing. */
export interface ApprovalAuthorization { readonly [approvalAuthorizationBrand]: never }
export type ApprovalOutcomeKind = "committed" | "refused" | "conflict" | "corrupt" | "not-recorded" | "unknown" | "idempotent-replay";
export interface ApprovalOutcome {
  readonly kind: ApprovalOutcomeKind;
  readonly operationId: string;
  readonly reason: string | null;
}

/**
 * Future owner: @ai-dev-os/application's authenticated operator-action adapter.
 * Issuance is separate from pure evaluation and transaction ownership. The owner
 * authenticates an operator, binds the exact parsed operation and identity, then
 * issues one non-serializable capability through its private identity registry.
 * The transaction owner re-reads binding, complete stop evidence, and versions;
 * derives all two/four-record mutations in ONE transaction and appends their
 * exact events. Neither a boolean nor caller-created evidence is authorization.
 * There is NO production implementation or production issuer in this package.
 */
export interface ApprovalApplicationAdapter {
  attempt(operation: ApprovalOperation, authorization: ApprovalAuthorization): Promise<ApprovalOutcome>;
  /** Each explicit call is a bounded read of the exact attempted operation. */
  observe(operation: ApprovalOperation): Promise<ApprovalOutcome>;
}
