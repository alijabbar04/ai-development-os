import type { JsonObject } from "@ai-dev-os/domain";

export const INTEGRATION_SCHEMA_VERSION = 1 as const;
export const INTEGRATION_PRODUCTION_ENABLED = false as const;

export const INTEGRATION_STRATEGIES = Object.freeze(["fast-forward", "merge"] as const);
export type IntegrationStrategy = (typeof INTEGRATION_STRATEGIES)[number];

export const INTEGRATION_CONFLICT_KINDS = Object.freeze([
  "structural",
  "textual",
  "semantic",
  "scope",
  "intent",
  "specification",
] as const);
export type IntegrationConflictKind = (typeof INTEGRATION_CONFLICT_KINDS)[number];

export const INTEGRATION_STATUSES = Object.freeze([
  "pending",
  "leased",
  "prepared",
  "effect-uncertain",
  "committed",
  "reconciling",
  "manual-reconciliation-required",
  "completed",
  "failed",
  "cancelled",
] as const);
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const INTEGRATION_EVENT_TYPES = Object.freeze([
  "integration.accepted",
  "integration.leased",
  "integration.retry-scheduled",
  "integration.prepared",
  "integration.effect-started",
  "integration.receipt-recorded",
  "integration.recovery-started",
  "integration.recovery-exhausted",
  "integration.completed",
  "integration.failed",
  "integration.cancelled",
  "integration.reconciled",
] as const);
export type IntegrationEventType = (typeof INTEGRATION_EVENT_TYPES)[number];

export interface RepositoryIntegrationIdentity {
  readonly repositoryId: string;
  readonly objectFormat: "sha1" | "sha256";
  readonly targetRef: string;
  readonly expectedTargetCommit: string;
  readonly expectedTargetTree: string;
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly expectedIntegratedCommit: string;
  readonly expectedIntegratedTree: string;
  /** Exact final commit parents, in order. Empty only for fast-forward. */
  readonly expectedParents: readonly string[];
  /** Reviewed deterministic merge-commit timestamp. Null only for fast-forward. */
  readonly mergeCommitTimestamp: string | null;
}

/** Exact upstream task-result artifact authorized for this integration. */
export interface IntegrationCandidateArtifact {
  readonly taskId: string;
  readonly taskResultDigest: string;
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly manifestId: string;
  readonly manifestDigest: string;
  readonly bindingDigest: string;
}

export interface IntegrationAdmission {
  readonly evaluationRunId: string;
  readonly evaluationRequestDigest: string;
  readonly evaluationResultDigest: string;
  readonly evaluationSubjectDigest: string;
  readonly evaluationDecision: "accepted";
  readonly authorityConfigurationFingerprint: string;
  readonly criterionManifestDigest: string;
  readonly deterministicEvidenceDigest: string;
  readonly productSpecificationId: string;
  readonly productSpecificationDigest: string;
  readonly requirementIds: readonly string[];
  readonly requirementCoverageDigest: string;
  readonly waiverDigests: readonly string[];
  readonly dissentDigest: string;
  readonly securityFindingsDigest: string;
  readonly feasibilityFindingsDigest: string;
  readonly admissionDigest: string;
}

export interface IntegrationValidationPlan {
  readonly planId: string;
  readonly validatorId: string;
  readonly validatorSchemaVersion: 1;
  readonly routeFingerprint: string;
  readonly configurationDigest: string;
  /** Closed identifiers resolved by the injected validator; never raw commands. */
  readonly commandIds: readonly string[];
  readonly requiredCriterionIds: readonly string[];
  readonly thresholdDigest: string;
  readonly allowSkips: false;
  readonly planDigest: string;
}

/** Advisory model output. It has deliberately literal zero authority. */
export interface IntegrationResolutionProposal {
  readonly proposalId: string;
  readonly authority: "none";
  readonly conflictIds: readonly string[];
  readonly patchArtifactDigest: string;
  readonly resultingTree: string;
  readonly allowedPaths: readonly string[];
  readonly validationPlanDigest: string;
  readonly proposalDigest: string;
}

export interface ReviewedResolutionAuthorization {
  readonly proposalDigest: string;
  readonly authorityDigest: string;
  readonly approvalReference: string;
  readonly approvedAt: string;
  readonly authorizationDigest: string;
}

export interface IntegrationRetryPolicy {
  readonly maximumAttempts: number;
  readonly retryableFailureCodes: readonly string[];
  readonly automaticRetryBeforeEffectOnly: true;
}

export interface IntegrationBounds {
  readonly maximumPaths: number;
  readonly maximumFiles: number;
  readonly maximumBytes: number;
  readonly maximumConflicts: number;
  readonly maximumWallTimeMs: number;
  readonly maximumWorktrees: 1;
}

export interface IntegrationRequest {
  readonly schemaVersion: typeof INTEGRATION_SCHEMA_VERSION;
  readonly runId: string;
  readonly repository: RepositoryIntegrationIdentity;
  readonly gitPortId: string;
  readonly gitPortSchemaVersion: 1;
  readonly gitRouteFingerprint: string;
  /** Physical repository namespace used for cross-route target serialization. */
  readonly gitTargetFingerprint: string;
  readonly strategy: IntegrationStrategy;
  readonly allowedPaths: readonly string[];
  readonly candidateArtifact: IntegrationCandidateArtifact;
  readonly admission: IntegrationAdmission;
  readonly validationPlan: IntegrationValidationPlan;
  readonly resolutionProposal: IntegrationResolutionProposal | null;
  readonly resolutionAuthorization: ReviewedResolutionAuthorization | null;
  readonly authorityDigest: string;
  readonly idempotencyKey: string;
  readonly retryPolicy: IntegrationRetryPolicy;
  readonly bounds: IntegrationBounds;
  readonly createdAt: string;
  readonly deadline: string;
  readonly requestDigest: string;
}

export interface IntegrationAuthorityConfiguration {
  readonly schemaVersion: typeof INTEGRATION_SCHEMA_VERSION;
  readonly configurationId: string;
  readonly authorizedRequestDigests: readonly string[];
  readonly authorizedAuthorityDigests: readonly string[];
  readonly authorizedAdmissionDigests: readonly string[];
  readonly authorizedResolutionDigests: readonly string[];
  readonly configurationFingerprint: string;
}

export interface IntegrationConflict {
  readonly conflictId: string;
  readonly kind: IntegrationConflictKind;
  readonly path: string | null;
  readonly ruleCode: string;
  readonly blocking: true;
}

export interface IntegrationPreflightResult {
  readonly schemaVersion: typeof INTEGRATION_SCHEMA_VERSION;
  readonly preflightId: string;
  readonly requestDigest: string;
  readonly repositoryId: string;
  readonly targetRef: string;
  readonly targetCommit: string;
  readonly targetTree: string;
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly clean: boolean;
  readonly changedPaths: readonly string[];
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly conflicts: readonly IntegrationConflict[];
  readonly checkedAt: string;
  readonly preflightDigest: string;
}

export interface IntegrationValidationResult {
  readonly schemaVersion: typeof INTEGRATION_SCHEMA_VERSION;
  readonly resultId: string;
  readonly validatorId: string;
  readonly validatorSchemaVersion: 1;
  readonly phase: "pre-integration" | "post-integration";
  readonly planId: string;
  readonly configurationDigest: string;
  readonly headCommit: string;
  readonly treeId: string;
  readonly passed: boolean;
  readonly executedCommandIds: readonly string[];
  readonly commandResultDigests: readonly string[];
  readonly evaluatedCriterionIds: readonly string[];
  readonly criterionResultDigests: readonly string[];
  readonly thresholdDigest: string;
  readonly coverageDigest: string;
  readonly conflicts: readonly IntegrationConflict[];
  readonly failedRuleCodes: readonly string[];
  readonly skippedCount: number;
  readonly evaluatedAt: string;
  readonly resultDigest: string;
}

export interface IntegrationLease {
  readonly leaseId: string;
  readonly owner: string;
  readonly fencingToken: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export interface IntegrationEffectIntent {
  readonly intentId: string;
  readonly requestDigest: string;
  readonly preflightDigest: string;
  readonly validationResultDigest: string;
  readonly resolutionAuthorizationDigest: string | null;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly createdAt: string;
  readonly intentDigest: string;
}

export interface IntegrationReceipt {
  readonly schemaVersion: typeof INTEGRATION_SCHEMA_VERSION;
  readonly receiptId: string;
  readonly intentDigest: string;
  readonly repositoryId: string;
  readonly targetRef: string;
  readonly previousTargetCommit: string;
  readonly integratedCommit: string;
  readonly integratedTree: string;
  readonly parents: readonly string[];
  readonly strategy: IntegrationStrategy;
  readonly refUpdated: true;
  readonly worktreeId: string;
  readonly changedPaths: readonly string[];
  readonly artifactDigest: string;
  /**
   * `observed` is emitted by the live boundary at the instant it observes its
   * successful ref transaction. `recovered-observation` is emitted only by
   * reconciliation when the original process did not durably retain that
   * observation; in that case `committedAt` is the trusted recovery
   * observation time, not a claim about the unknown physical update instant.
   */
  readonly timingBasis: "observed" | "recovered-observation";
  readonly committedAt: string;
  readonly receiptDigest: string;
}

export interface IntegrationRecoveryState {
  readonly state: "no-effect" | "prepared" | "commit-created" | "ref-published" | "diverged";
  readonly effectGuardState: "revoked" | "absent";
  readonly intentDigest: string;
  readonly observedTargetCommit: string | null;
  readonly observedTargetTree: string | null;
  readonly receipt: IntegrationReceipt | null;
  readonly observedAt: string;
  readonly recoveryDigest: string;
}

export interface IntegrationCleanupResult {
  readonly worktreeId: string;
  readonly cleaned: boolean;
  readonly preservedEvidence: boolean;
  readonly failureCode: string | null;
  readonly observedAt: string;
}

export interface IntegrationTerminalResult {
  readonly outcome: "completed" | "failed" | "cancelled";
  readonly receiptDigest: string | null;
  readonly validationResultDigest: string | null;
  readonly failureCode: string | null;
  readonly cleanup: IntegrationCleanupResult | null;
  readonly completedAt: string;
  readonly terminalDigest: string;
}

export interface IntegrationRunSnapshot {
  readonly schemaVersion: typeof INTEGRATION_SCHEMA_VERSION;
  readonly productionEnabled: typeof INTEGRATION_PRODUCTION_ENABLED;
  readonly runId: string;
  readonly aggregateVersion: number;
  readonly eventSequence: number;
  readonly status: IntegrationStatus;
  readonly attemptsUsed: number;
  readonly retriesScheduled: number;
  readonly recoveryAttempts: number;
  readonly nextFencingToken: number;
  readonly request: IntegrationRequest;
  readonly authorityConfiguration: IntegrationAuthorityConfiguration;
  readonly lease: IntegrationLease | null;
  readonly preflight: IntegrationPreflightResult | null;
  readonly preValidation: IntegrationValidationResult | null;
  readonly intent: IntegrationEffectIntent | null;
  readonly receipt: IntegrationReceipt | null;
  readonly postValidation: IntegrationValidationResult | null;
  readonly recovery: IntegrationRecoveryState | null;
  readonly terminal: IntegrationTerminalResult | null;
  readonly lastFailureCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IntegrationEventCommand {
  readonly commandId: string;
  readonly submittedAt: string;
  readonly expectedVersion: number | null;
  readonly owner: string | null;
  readonly leaseId: string | null;
  readonly fencingToken: number | null;
  readonly leaseExpiresAt: string | null;
  readonly reasonCode: string | null;
  readonly evidenceDigest: string | null;
  readonly commandFingerprint: string;
}

export interface IntegrationEvent {
  readonly schemaVersion: typeof INTEGRATION_SCHEMA_VERSION;
  readonly eventId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly aggregateVersion: number;
  readonly type: IntegrationEventType;
  readonly occurredAt: string;
  readonly beforeDigest: string | null;
  readonly afterDigest: string;
  readonly command: IntegrationEventCommand;
  readonly snapshot: IntegrationRunSnapshot;
}

export interface IntegrationValidationInput {
  readonly phase: IntegrationValidationResult["phase"];
  readonly request: IntegrationRequest;
  readonly headCommit: string;
  readonly treeId: string;
  readonly plan: IntegrationValidationPlan;
}

export interface IntegrationGitPort {
  readonly portId: string;
  readonly schemaVersion: 1;
  readonly routeFingerprint: string;
  readonly targetFingerprint: string;
  preflight(request: IntegrationRequest, signal: AbortSignal): Promise<IntegrationPreflightResult>;
  integrate(intent: IntegrationEffectIntent, request: IntegrationRequest, signal: AbortSignal): Promise<IntegrationReceipt>;
  reconcile(
    intent: IntegrationEffectIntent,
    request: IntegrationRequest,
    persistedReceipt: IntegrationReceipt | null,
    signal: AbortSignal,
  ): Promise<IntegrationRecoveryState>;
  cleanup(worktreeId: string, signal: AbortSignal): Promise<IntegrationCleanupResult>;
}

export interface IntegrationValidationPort {
  readonly portId: string;
  readonly schemaVersion: 1;
  readonly routeFingerprint: string;
  validate(input: IntegrationValidationInput, signal: AbortSignal): Promise<IntegrationValidationResult>;
}

export interface IntegrationAuditRecord {
  readonly operation: string;
  readonly outcome: "succeeded" | "failed" | "duplicate";
  readonly runVersion: number | null;
  readonly code: string | null;
}

export interface ProductionDisabledIntegrationService {
  readonly productionEnabled: typeof INTEGRATION_PRODUCTION_ENABLED;
  accept(input: unknown): Promise<IntegrationRunSnapshot>;
  claim(input: unknown): Promise<IntegrationRunSnapshot>;
  prepare(input: unknown): Promise<IntegrationRunSnapshot>;
  execute(input: unknown): Promise<IntegrationRunSnapshot>;
  reconcile(input: unknown): Promise<IntegrationRunSnapshot>;
  cancel(input: unknown): Promise<IntegrationRunSnapshot>;
  get(runId: string): Promise<IntegrationRunSnapshot | null>;
  history(runId: string): Promise<readonly IntegrationEvent[]>;
}

/** Finite, body-free fixture diagnostics; never a command output or source body. */
export type IntegrationDiagnostic = JsonObject;
