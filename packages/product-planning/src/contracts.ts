import type { JsonObject, JsonValue } from "@ai-dev-os/domain";
import type { NormalizedUsage, OrchestrationRunState, ProfileOwnershipClass, WorkspaceIdentity } from "@ai-dev-os/scheduler";
import type { TaskGraphEvent, TaskGraphSnapshot } from "@ai-dev-os/task-graph";

export const PRODUCT_PLANNING_SCHEMA_VERSION = 1 as const;
export const PRODUCT_PLANNING_PRODUCTION_ENABLED = false as const;

export const PLAN_RISKS = Object.freeze(["routine", "material", "high"] as const);
export type PlanRisk = (typeof PLAN_RISKS)[number];

export const PLANNING_PHASE_KINDS = Object.freeze([
  "product-discovery",
  "specialist-gap-analysis",
  "engineering-feasibility",
  "plan-synthesis",
] as const);
export type PlanningPhaseKind = (typeof PLANNING_PHASE_KINDS)[number];

export const PLANNING_PHASE_STATUSES = Object.freeze([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const);
export type PlanningPhaseStatus = (typeof PLANNING_PHASE_STATUSES)[number];

export const SCOPE_DISPOSITIONS = Object.freeze([
  "required",
  "expected-quality",
  "delight-candidate",
  "deferred",
  "rejected",
  "duplicate",
  "superseded",
  "blocked",
  "waived",
] as const);
export type ScopeDisposition = (typeof SCOPE_DISPOSITIONS)[number];

export const EXECUTABLE_DISPOSITIONS = Object.freeze([
  "required",
  "expected-quality",
  "delight-candidate",
] as const);
export type ExecutableDisposition = (typeof EXECUTABLE_DISPOSITIONS)[number];

export const SCOPE_AUTHORITIES = Object.freeze([
  "operator",
  "product-owner",
  "security-reviewer",
  "deterministic-rule",
] as const);
export type ScopeAuthority = (typeof SCOPE_AUTHORITIES)[number];

export const REQUIREMENT_CATEGORIES = Object.freeze([
  "capability",
  "quality",
  "risk",
  "constraint",
  "unresolved-question",
] as const);
export type RequirementCategory = (typeof REQUIREMENT_CATEGORIES)[number];

export const FINDING_KINDS = Object.freeze(["feasibility", "risk", "constraint"] as const);
export type FindingKind = (typeof FINDING_KINDS)[number];
export const SEVERITIES = Object.freeze(["low", "medium", "high", "critical"] as const);
export type Severity = (typeof SEVERITIES)[number];

export interface PlanningLimits {
  readonly maximumPhases: number;
  readonly maximumSpecialists: number;
  readonly maximumContributions: number;
  readonly maximumCandidateRequirements: number;
  readonly maximumProviderCalls: number;
  readonly maximumTotalTokens: number;
  readonly maximumMoneyMicros: number;
  readonly maximumContributionBytes: number;
  readonly maximumTotalOutputBytes: number;
  readonly maximumWallTimeMs: number;
  readonly maximumSynthesisRounds: number;
  readonly maximumRetriesPerPhase: number;
  readonly maximumGraphNodes: number;
  readonly maximumGraphDepth: number;
  readonly maximumDependencyFanOut: number;
}

export interface TrustedPlanningRoute {
  readonly routeKey: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly profileId: string;
  readonly ownership: ProfileOwnershipClass;
  readonly configurationFingerprint: string;
  readonly independenceKey: string;
}

export interface PlanningSpecialist {
  readonly specialistId: string;
  readonly focus: string;
  readonly routeKey: string;
}

export interface ProductPlanningConfiguration {
  readonly schemaVersion: typeof PRODUCT_PLANNING_SCHEMA_VERSION;
  readonly instanceId: string;
  readonly discoveryRouteKey: string;
  readonly engineeringRouteKey: string;
  readonly synthesisRouteKey: string;
  readonly routes: readonly TrustedPlanningRoute[];
  readonly specialists: readonly PlanningSpecialist[];
  readonly limits: PlanningLimits;
  readonly configurationFingerprint: string;
}

export interface ProductPlanningConfigurationInput {
  readonly instanceId: string;
  readonly discoveryRouteKey: string;
  readonly engineeringRouteKey: string;
  readonly synthesisRouteKey: string;
  readonly routes: readonly Omit<TrustedPlanningRoute, "independenceKey">[];
  readonly specialists?: readonly PlanningSpecialist[];
  readonly limits?: Partial<PlanningLimits>;
}

export interface PlanningBudgetPreview {
  readonly maximumInputTokens: number;
  readonly maximumOutputTokens: number;
  readonly maximumCostMicros: number;
  readonly maximumProviderCalls: number;
}

export interface ProductIntentInput {
  readonly planId: string;
  readonly projectId: string;
  readonly title: string;
  readonly problem: string;
  readonly desiredOutcomes: readonly string[];
  readonly constraints: readonly string[];
  readonly nonGoals: readonly string[];
  readonly risk: PlanRisk;
  readonly workspace: WorkspaceIdentity;
  readonly budget: PlanningBudgetPreview;
  readonly createdAt: string;
  readonly deadline: string;
}

export interface ProductIntent extends ProductIntentInput {
  readonly schemaVersion: typeof PRODUCT_PLANNING_SCHEMA_VERSION;
  readonly intentDigest: string;
}

export interface PlanningPhase {
  readonly phaseId: string;
  readonly kind: PlanningPhaseKind;
  readonly specialistId: string | null;
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly route: TrustedPlanningRoute;
  readonly status: PlanningPhaseStatus;
  readonly attempt: number;
  readonly resultId: string | null;
  readonly contributionId: string | null;
  readonly failureCode: string | null;
}

export interface CandidateRequirementDraft {
  readonly localKey: string;
  readonly title: string;
  readonly description: string;
  readonly rationale: string;
  readonly category: Exclude<RequirementCategory, "unresolved-question">;
  readonly proposedDisposition: ScopeDisposition;
  readonly dependsOn: readonly string[];
}

export interface FeasibilityFindingDraft {
  readonly kind: FindingKind;
  readonly summary: string;
  readonly severity: Severity;
}

export interface UnresolvedQuestionDraft {
  readonly question: string;
  readonly material: boolean;
}

export interface DissentDraft {
  readonly subject: string;
  readonly position: string;
  readonly rationale: string;
  readonly severity: Severity;
}

export interface PlanningContributionDraft {
  readonly candidates: readonly CandidateRequirementDraft[];
  readonly findings: readonly FeasibilityFindingDraft[];
  readonly unresolvedQuestions: readonly UnresolvedQuestionDraft[];
  readonly dissent: readonly DissentDraft[];
}

export interface PlanningContributionEvidence {
  readonly phaseId: string;
  readonly resultId: string;
  readonly attempt: number;
  readonly inputDigest: string;
  readonly schedulerTaskId: string;
  readonly schedulerIdempotencyKey: string;
  readonly route: TrustedPlanningRoute;
  readonly sourceFingerprint: string;
  readonly completedAt: string;
  readonly usage: NormalizedUsage;
}

export interface CandidateRequirement {
  readonly candidateId: string;
  readonly contributionId: string;
  readonly sourceKind: "proposal" | "question" | "dissent";
  readonly localKey: string;
  readonly normalizedKey: string;
  readonly title: string;
  readonly description: string;
  readonly rationale: string;
  readonly category: RequirementCategory;
  readonly proposedDisposition: ScopeDisposition;
  readonly dependsOnKeys: readonly string[];
}

export interface FeasibilityFinding extends FeasibilityFindingDraft {
  readonly findingId: string;
  readonly contributionId: string;
}

export interface UnresolvedQuestion extends UnresolvedQuestionDraft {
  readonly questionId: string;
  readonly contributionId: string;
  readonly normalizedKey: string;
  readonly candidateId: string;
}

export interface DissentItem extends DissentDraft {
  readonly dissentId: string;
  readonly contributionId: string;
  readonly normalizedKey: string;
  readonly candidateId: string;
}

export interface PlanningContribution {
  readonly contributionId: string;
  readonly planId: string;
  readonly phaseId: string;
  readonly resultId: string;
  readonly attempt: number;
  readonly inputDigest: string;
  readonly schedulerTaskId: string;
  readonly schedulerIdempotencyKey: string;
  readonly route: TrustedPlanningRoute;
  readonly sourceFingerprint: string;
  readonly completedAt: string;
  readonly authority: "none";
  readonly candidates: readonly CandidateRequirement[];
  readonly findings: readonly FeasibilityFinding[];
  readonly unresolvedQuestions: readonly UnresolvedQuestion[];
  readonly dissent: readonly DissentItem[];
  readonly usage: NormalizedUsage;
  readonly outputBytes: number;
  readonly contributionDigest: string;
  readonly applied: boolean;
}

export interface RequirementProvenance {
  readonly contributionId: string;
  readonly phaseId: string;
  readonly routeKey: string;
  readonly sourceFingerprint: string;
  readonly candidateId: string;
}

export interface DeduplicatedRequirement {
  readonly requirementId: string;
  readonly normalizedKey: string;
  readonly requirementDigest: string;
  readonly title: string;
  readonly category: RequirementCategory;
  readonly candidateIds: readonly string[];
  readonly provenance: readonly RequirementProvenance[];
  readonly dissentIds: readonly string[];
  readonly proposedDispositions: readonly ScopeDisposition[];
  readonly dependencyKeys: readonly string[];
  readonly currentDecisionId: string | null;
}

export interface ScopeActor {
  readonly actorId: string;
  readonly authority: ScopeAuthority;
}

export interface ScopeDecisionInput {
  readonly requirementId: string;
  readonly requirementDigest: string;
  readonly expectedPlanVersion: number;
  readonly disposition: ScopeDisposition;
  readonly actor: ScopeActor;
  readonly reason: string;
  readonly approvalReference: string | null;
  readonly decidedAt: string;
}

export interface ScopeDecision extends Omit<ScopeDecisionInput, "expectedPlanVersion"> {
  readonly decisionId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly supersedesDecisionId: string | null;
  readonly decisionDigest: string;
}

export interface RequirementTaskCoverage {
  readonly requirementId: string;
  readonly requirementDigest: string;
  readonly decisionId: string;
  readonly disposition: ScopeDisposition;
  readonly executable: boolean;
  readonly taskId: string | null;
}

export interface ProductSpecificationRequirement {
  readonly requirementId: string;
  readonly requirementDigest: string;
  readonly title: string;
  readonly category: RequirementCategory;
  readonly disposition: ScopeDisposition;
  readonly decisionId: string;
  readonly candidateIds: readonly string[];
  readonly provenance: readonly RequirementProvenance[];
  readonly dissentIds: readonly string[];
}

export interface ProductSpecification {
  readonly schemaVersion: typeof PRODUCT_PLANNING_SCHEMA_VERSION;
  readonly specificationId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly intentDigest: string;
  readonly decisionSetDigest: string;
  readonly requirements: readonly ProductSpecificationRequirement[];
  readonly findingIds: readonly string[];
  readonly questionIds: readonly string[];
  readonly dissentIds: readonly string[];
  readonly approvedBy: ScopeActor;
  readonly approvalReference: string;
  readonly approvedAt: string;
  readonly approvalDigest: string;
}

export interface BudgetReservationIntent {
  readonly reservationId: string;
  readonly planId: string;
  readonly preview: PlanningBudgetPreview;
  readonly status: "intended";
}

export interface BudgetReconciliationIntent {
  readonly reconciliationId: string;
  readonly planId: string;
  readonly reservationId: string;
  readonly usage: NormalizedUsage;
  readonly costKnown: boolean;
  readonly status: "intended";
}

export interface ProductPlanSnapshot {
  readonly schemaVersion: typeof PRODUCT_PLANNING_SCHEMA_VERSION;
  readonly planId: string;
  readonly aggregateVersion: number;
  readonly eventSequence: number;
  readonly intent: ProductIntent;
  readonly configurationFingerprint: string;
  readonly phases: readonly PlanningPhase[];
  readonly stagedContributions: readonly PlanningContribution[];
  readonly contributions: readonly PlanningContribution[];
  readonly requirements: readonly DeduplicatedRequirement[];
  readonly decisions: readonly ScopeDecision[];
  readonly specification: ProductSpecification | null;
  readonly coverage: readonly RequirementTaskCoverage[];
  readonly reservationIntent: BudgetReservationIntent;
  readonly reconciliationIntent: BudgetReconciliationIntent | null;
  readonly taskGraph: TaskGraphSnapshot;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const PLANNING_EVENT_TYPES = Object.freeze([
  "plan.accepted",
  "contribution.staged",
  "contribution.applied",
  "scope.decided",
  "specification.approved",
  "plan.failed",
  "plan.cancelled",
] as const);
export type PlanningEventType = (typeof PLANNING_EVENT_TYPES)[number];

export interface PlanningEvent {
  readonly schemaVersion: typeof PRODUCT_PLANNING_SCHEMA_VERSION;
  readonly eventId: string;
  readonly planId: string;
  readonly sequence: number;
  readonly aggregateVersion: number;
  readonly type: PlanningEventType;
  readonly occurredAt: string;
  readonly beforeDigest: string | null;
  readonly afterDigest: string;
  readonly snapshot: ProductPlanSnapshot;
}

export interface ProductPlanAcceptanceInput {
  readonly intent: ProductIntentInput;
}

export interface ApproveSpecificationInput {
  readonly expectedPlanVersion: number;
  readonly decisionSetDigest: string;
  readonly actor: ScopeActor;
  readonly approvalReference: string;
  readonly approvedAt: string;
}

export interface ProductPlanningStore {
  accept(input: ProductPlanAcceptanceInput): Promise<ProductPlanSnapshot>;
  get(planId: string): Promise<ProductPlanSnapshot | null>;
  history(planId: string): Promise<readonly PlanningEvent[]>;
  stageContribution(planId: string, evidence: PlanningContributionEvidence, draft: unknown): Promise<ProductPlanSnapshot>;
  applyStagedContribution(planId: string, contributionId: string, expectedPlanVersion: number): Promise<ProductPlanSnapshot>;
  decideScope(planId: string, input: ScopeDecisionInput): Promise<ProductPlanSnapshot>;
  approveSpecification(planId: string, input: ApproveSpecificationInput): Promise<ProductPlanSnapshot>;
  failPhase(planId: string, phaseId: string, failureCode: string, expectedPlanVersion: number): Promise<ProductPlanSnapshot>;
  cancel(planId: string, reason: string, expectedPlanVersion: number): Promise<ProductPlanSnapshot>;
}

export interface ProductPlanningCoordinator {
  readonly productionEnabled: false;
  health(): Promise<{ readonly status: "unavailable" | "healthy" | "closed"; readonly detailCode: string }>;
  accept(input: ProductPlanAcceptanceInput): Promise<ProductPlanSnapshot>;
  submitReadyPhases(planId: string): Promise<readonly OrchestrationRunState[]>;
  reconcilePhase(planId: string, phaseId: string): Promise<ProductPlanSnapshot>;
  close(): Promise<void>;
}

export interface PendingPlanningChanges {
  readonly planningEvents: readonly PlanningEvent[];
  readonly taskGraphEvents: readonly TaskGraphEvent[];
}

export interface PlanningAuditRecord {
  readonly operation: string;
  readonly outcome: "succeeded" | "failed" | "duplicate";
  readonly planVersion: number | null;
  readonly eventSequence: number | null;
  readonly code: string | null;
}

export interface PlanningCoordinatorTestingOptions {
  readonly store: ProductPlanningStore;
  readonly scheduler: import("@ai-dev-os/scheduler").DurableScheduler;
  readonly clock: { now(): Date };
  readonly configuration: ProductPlanningConfiguration;
}

export interface InferencePlanningAdapterResolution {
  readonly inferenceRequest: import("@ai-dev-os/providers").InferenceRequest;
  readonly evidence: Omit<PlanningContributionEvidence, "resultId" | "completedAt" | "usage">;
  stage(resultId: string, completedAt: string, usage: NormalizedUsage, draft: JsonValue): Promise<{ readonly contributionId: string; readonly contributionDigest: string }>;
}

export interface InferencePlanningAdapterOptions {
  readonly provider: import("@ai-dev-os/providers").InferenceProvider;
  readonly clock: { now(): Date };
  resolve(request: import("@ai-dev-os/scheduler").AgentAdapterRequest): Promise<InferencePlanningAdapterResolution> | InferencePlanningAdapterResolution;
}

export type PlanningJsonObject = JsonObject;
