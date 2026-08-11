import type { JsonObject } from "@ai-dev-os/domain";

export const EVALUATION_SCHEMA_VERSION = 1 as const;
export const EVALUATION_PRODUCTION_ENABLED = false as const;

export const EVALUATION_KINDS = Object.freeze([
  "output-schema",
  "changed-paths",
  "compilation",
  "tests",
  "static-analysis",
  "acceptance-criteria",
  "requirement-coverage",
  "repository-state",
] as const);
export type EvaluationKind = (typeof EVALUATION_KINDS)[number];

export const EVALUATION_CRITICALITIES = Object.freeze([
  "required",
  "expected-quality",
  "delight",
  "deferred",
] as const);
export type EvaluationCriticality = (typeof EVALUATION_CRITICALITIES)[number];

export interface RequirementCoverageEdge {
  readonly requirementId: string;
  readonly taskId: string;
  readonly resultId: string;
}

export const EVALUATION_RUN_STATUSES = Object.freeze([
  "pending",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const);
export type EvaluationRunStatus = (typeof EVALUATION_RUN_STATUSES)[number];

export const CRITERION_OUTCOMES = Object.freeze(["passed", "failed", "waived", "missing"] as const);
export type CriterionOutcome = (typeof CRITERION_OUTCOMES)[number];

export interface EvaluationSubject {
  readonly repositoryId: string;
  readonly headSha: string;
  readonly treeSha: string;
  readonly productSpecificationId: string;
  readonly productSpecificationDigest: string;
  readonly requirementIds: readonly string[];
  readonly taskIds: readonly string[];
  readonly resultIds: readonly string[];
  readonly coverageEdges: readonly RequirementCoverageEdge[];
  readonly subjectDigest: string;
}

export interface EvaluationCriterion {
  readonly criterionId: string;
  readonly kind: EvaluationKind;
  readonly criticality: EvaluationCriticality;
  readonly requirementId: string | null;
  readonly description: string;
  readonly evaluatorId: string;
  readonly evaluatorVersion: string;
  readonly configurationDigest: string;
  readonly evidenceContractDigest: string;
  readonly expectedArtifactDigests: readonly string[];
}

export interface EvidenceBase {
  readonly evidenceId: string;
  readonly criterionId: string;
  readonly kind: EvaluationKind;
  readonly evaluatorId: string;
  readonly evaluatorVersion: string;
  readonly configurationDigest: string;
  readonly subjectDigest: string;
  readonly repositoryId: string;
  readonly headSha: string;
  readonly treeSha: string;
  readonly inputDigest: string;
  readonly artifactDigests: readonly string[];
  readonly observedAt: string;
  readonly validUntil: string;
}

export type EvaluationEvidence = EvidenceBase & {
  readonly data: JsonObject;
};

export interface EvaluationWaiver {
  readonly waiverId: string;
  readonly criterionId: string;
  readonly subjectDigest: string;
  readonly configurationDigest: string;
  readonly authority: "operator" | "product-owner" | "security-reviewer";
  readonly approvalReference: string;
  readonly reason: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
}

export interface EvaluationAuthorityConfiguration {
  readonly schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  readonly configurationId: string;
  readonly authorizedCriterionManifestDigests: readonly string[];
  readonly authorizedEvidenceDigests: readonly string[];
  readonly authorizedWaiverDigests: readonly string[];
  readonly configurationFingerprint: string;
}

export interface ModelAdvisory {
  readonly advisoryId: string;
  readonly criterionId: string;
  readonly routeIndependenceKey: string;
  readonly recommendation: "pass" | "fail" | "uncertain";
  readonly summary: string;
  readonly observedAt: string;
}

export interface EvaluationRequest {
  readonly schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  readonly runId: string;
  readonly subject: EvaluationSubject;
  readonly criteria: readonly EvaluationCriterion[];
  readonly evidence: readonly EvaluationEvidence[];
  readonly waivers: readonly EvaluationWaiver[];
  readonly advisories: readonly ModelAdvisory[];
  readonly createdAt: string;
  readonly deadline: string;
  readonly maximumAttempts: number;
  readonly requestDigest: string;
}

export interface CriterionEvaluation {
  readonly criterionId: string;
  readonly kind: EvaluationKind;
  readonly criticality: EvaluationCriticality;
  readonly outcome: CriterionOutcome;
  readonly evidenceIds: readonly string[];
  readonly waiverId: string | null;
  readonly ruleCodes: readonly string[];
}

export interface EvaluationDisagreement {
  readonly disagreementId: string;
  readonly criterionId: string;
  readonly advisoryId: string;
  readonly deterministicOutcome: CriterionOutcome;
  readonly advisoryRecommendation: ModelAdvisory["recommendation"];
}

export interface EvaluationResult {
  readonly schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  readonly runId: string;
  readonly subjectDigest: string;
  readonly requestDigest: string;
  readonly authorityConfigurationFingerprint: string;
  readonly criterionManifestDigest: string;
  readonly requestRuleCodes: readonly string[];
  readonly decision: "accepted" | "rejected";
  readonly criteria: readonly CriterionEvaluation[];
  readonly disagreements: readonly EvaluationDisagreement[];
  readonly blockingCriterionIds: readonly string[];
  readonly evaluatedAt: string;
  readonly resultDigest: string;
}

export interface CompletenessFinding {
  readonly findingId: string;
  readonly criterionId: string;
  readonly outcome: CriterionOutcome;
  readonly blocking: boolean;
  readonly proposedCorrectiveTaskKey: string | null;
}

export interface CompletenessAudit {
  readonly schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  readonly auditId: string;
  readonly resultDigest: string;
  readonly authority: "none";
  readonly mayAuthorizeExecution: false;
  readonly mayApproveWaiver: false;
  readonly mayWidenScope: false;
  readonly findings: readonly CompletenessFinding[];
  readonly auditDigest: string;
}

export interface EvaluationRunSnapshot {
  readonly schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  readonly productionEnabled: false;
  readonly runId: string;
  readonly aggregateVersion: number;
  readonly eventSequence: number;
  readonly status: EvaluationRunStatus;
  readonly attemptsUsed: number;
  readonly request: EvaluationRequest;
  readonly authorityConfiguration: EvaluationAuthorityConfiguration;
  readonly result: EvaluationResult | null;
  readonly lastFailureCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const EVALUATION_EVENT_TYPES = Object.freeze([
  "evaluation.accepted",
  "evaluation.completed",
  "evaluation.attempt-failed",
  "evaluation.cancelled",
] as const);
export type EvaluationEventType = (typeof EVALUATION_EVENT_TYPES)[number];

export interface EvaluationEventCommand {
  readonly expectedVersion: number | null;
  readonly failureCode: string | null;
  readonly retryable: boolean | null;
  readonly reasonCode: string | null;
}

export interface EvaluationEvent {
  readonly schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  readonly eventId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly aggregateVersion: number;
  readonly type: EvaluationEventType;
  readonly occurredAt: string;
  readonly beforeDigest: string | null;
  readonly afterDigest: string;
  readonly command: EvaluationEventCommand;
  readonly snapshot: EvaluationRunSnapshot;
}

export interface EvaluationStore {
  accept(input: unknown): Promise<EvaluationRunSnapshot>;
  get(runId: string): Promise<EvaluationRunSnapshot | null>;
  history(runId: string): Promise<readonly EvaluationEvent[]>;
  evaluate(runId: string, expectedVersion: number, evaluatedAt: string): Promise<EvaluationRunSnapshot>;
  failAttempt(runId: string, expectedVersion: number, failureCode: string, retryable: boolean, occurredAt: string): Promise<EvaluationRunSnapshot>;
  cancel(runId: string, expectedVersion: number, reasonCode: string, occurredAt: string): Promise<EvaluationRunSnapshot>;
}

export interface ProductionDisabledEvaluationService extends EvaluationStore {
  readonly productionEnabled: false;
  completenessAudit(result: unknown): CompletenessAudit;
}
