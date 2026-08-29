import type { DataClassification, JsonObject, TaskRequirements } from "@ai-dev-os/domain";
import type { ApprovalScope, ApproverClass, PolicyAction } from "@ai-dev-os/policy";
import type { BackendSecurityClass } from "@ai-dev-os/process-broker";
import type { SecretRef } from "@ai-dev-os/secrets";
import type {
  FailureClassification,
  NormalizedUsage,
  OrchestrationBudget,
  OrchestrationRetryPolicy,
  OrchestrationTimeoutPolicy,
  PermissionMode,
  RunStatus,
  RuntimeUsageReservation,
  SelectedRoute,
  TaskPriority as SchedulerTaskPriority,
  WorkspaceIdentity,
} from "@ai-dev-os/scheduler";

export const PROJECT_SCHEMA_VERSION = 1 as const;
export const PROJECT_PRODUCTION_ENABLED = false as const;

export const PROJECT_TIMESTAMP_RANGE = Object.freeze({
  minimum: "2000-01-01T00:00:00.000Z",
  maximum: "9999-12-31T23:59:59.999Z",
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

export const DATA_CLASSIFICATION_VALUES = Object.freeze([
  "public", "internal", "proprietary-source", "personal", "secret",
] as const satisfies readonly DataClassification[]);
type _DataClassificationParity = Assert<Equal<DataClassification, (typeof DATA_CLASSIFICATION_VALUES)[number]>>;

export const PERMISSION_MODE_VALUES = Object.freeze([
  "contained-default", "scoped-autonomous", "trusted-full-access",
] as const satisfies readonly PermissionMode[]);
type _PermissionModeParity = Assert<Equal<PermissionMode, (typeof PERMISSION_MODE_VALUES)[number]>>;

export const RUN_STATUS_VALUES = Object.freeze([
  "new", "queued", "dispatched", "running", "awaiting-approval", "retry-wait",
  "policy-blocked", "completed", "failed", "cancelled",
] as const satisfies readonly RunStatus[]);
type _RunStatusParity = Assert<Equal<RunStatus, (typeof RUN_STATUS_VALUES)[number]>>;

export const BACKEND_SECURITY_CLASS_VALUES = Object.freeze([
  "secure-enforcing", "constrained-incomplete", "unsafe-development", "unavailable",
] as const satisfies readonly BackendSecurityClass[]);
type _BackendSecurityClassParity = Assert<Equal<BackendSecurityClass, (typeof BACKEND_SECURITY_CLASS_VALUES)[number]>>;

export const FAILURE_CLASSIFICATION_VALUES = Object.freeze([
  "authentication", "authorization", "capacity", "deadline", "disconnected",
  "invalid-result", "policy", "provider", "usage", "unknown",
] as const satisfies readonly FailureClassification[]);
type _FailureClassificationParity = Assert<Equal<FailureClassification, (typeof FAILURE_CLASSIFICATION_VALUES)[number]>>;

export const PROJECT_STATUSES = Object.freeze(["active", "paused", "archived"] as const);
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PLAN_STATES = Object.freeze([
  "drafting", "clarifying", "proposed", "awaiting_scope_approval", "rejected",
  "sealed", "executing", "expanding", "stage_gate", "halted", "completed",
  "abandoned", "superseded",
] as const);
export type PlanState = (typeof PLAN_STATES)[number];

export const PLAN_STATE_DISPLAY_WORDS = Object.freeze([
  "Describing", "Needs your decisions", "Ready to review",
  "Needs your approval to start", "Not admitted — revise the brief or the scope",
  "Ready to start", "Running", "Reviewing a change",
  "At a checkpoint — your review", "Stopped", "Completed", "Abandoned",
  "Superseded",
] as const);
export type PlanStateDisplayWord = (typeof PLAN_STATE_DISPLAY_WORDS)[number];

export const TASK_STATES = Object.freeze([
  "pending", "ready", "running", "waiting", "needs_resolution", "succeeded",
  "failed", "blocked", "cancelled",
] as const);
export type ProjectTaskState = (typeof TASK_STATES)[number];

export const AGENT_RUN_STATES = Object.freeze([
  "leased", "running", "succeeded", "failed", "cancelled", "abandoned",
] as const);
export type AgentRunState = (typeof AGENT_RUN_STATES)[number];

export const SESSION_STATES = Object.freeze([
  "requested", "preparing", "starting", "running", "awaiting_input", "stopping",
  "stopped", "failed", "lost", "orphaned", "termination_unconfirmed", "archived",
] as const);
export type SessionState = (typeof SESSION_STATES)[number];

export const HANDOVER_STATES = Object.freeze([
  "assembled", "queued", "acknowledged", "expired", "voided",
] as const);
export type HandoverState = (typeof HANDOVER_STATES)[number];

export const APPROVAL_STATES = Object.freeze([
  "requested", "approved", "rejected", "expired", "voided", "consumed",
  "partially_consumed", "revoked",
] as const);
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export const SPENDING_STATES = Object.freeze([
  "drafted", "quoted", "awaiting_approval", "authorized", "declined", "quote_expired",
  "operator_executed", "withdrawn", "reconciled",
] as const);
export type SpendingState = (typeof SPENDING_STATES)[number];

export const BLOCKER_STATES = Object.freeze(["open", "cleared"] as const);
export type BlockerState = (typeof BLOCKER_STATES)[number];

export const NOTIFICATION_DELIVERY_STATES = Object.freeze([
  "pending", "sent", "failed", "suppressed", "expired",
] as const);
export type NotificationDeliveryState = (typeof NOTIFICATION_DELIVERY_STATES)[number];

export const CONSTRAINT_KINDS = Object.freeze([
  "budget-money", "budget-tokens", "deadline", "technology-required",
  "technology-forbidden", "provider-required", "provider-forbidden", "path-scope",
  "network", "data-residency", "quality-bar", "compatibility", "operator-rule",
] as const);
export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];

export const BLOCKER_KINDS = Object.freeze([
  "awaiting-approval", "awaiting-clarification", "awaiting-spending-decision",
  "usage-capped", "usage-stale", "provider-unavailable", "dependency-failed",
  "policy-denied", "production-refused", "workspace-conflict", "budget-exhausted",
  "emergency-stop", "operator-paused",
] as const);
export type BlockerKind = (typeof BLOCKER_KINDS)[number];

export const DECISION_KINDS = Object.freeze([
  "clarification-answer", "scope-accepted", "scope-deferred", "scope-rejected",
  "stage-gate-accepted", "plan-revision-accepted", "brief-revision-accepted",
  "conflict-resolution", "waiver-granted", "provider-override", "emergency-stop-review",
  "resume-accepted", "budget-extension-accepted",
] as const);
export type DecisionKind = (typeof DECISION_KINDS)[number];

export const NOTIFICATION_CATEGORIES = Object.freeze([
  "approval-requested", "spending-decision-requested", "task-completed", "task-blocked",
  "task-failed", "stage-gate-ready", "usage-stale", "provider-unavailable",
  "emergency-stop-activated", "session-termination-unconfirmed", "engine-lifecycle",
  "daily-summary", "input-requested",
] as const);
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const PROJECT_DEEP_LINK_ROUTES = Object.freeze([
  "home", "project", "plan", "task", "session", "approval", "spending",
  "activity", "providers", "emergency-stop",
] as const);
export type ProjectDeepLinkRoute = (typeof PROJECT_DEEP_LINK_ROUTES)[number];
export type ProjectDeepLink =
  | Readonly<{ route: "home" | "providers" | "emergency-stop"; params: Readonly<Record<string, never>> }>
  | Readonly<{ route: "project" | "plan" | "activity"; params: Readonly<{ projectId: string }> }>
  | Readonly<{ route: "task"; params: Readonly<{ projectId: string; taskId: string }> }>
  | Readonly<{ route: "session"; params: Readonly<{ projectId: string; sessionId: string }> }>
  | Readonly<{ route: "approval"; params: Readonly<{ projectId: string; approvalRequestId: string }> }>
  | Readonly<{ route: "spending"; params: Readonly<{ projectId: string; spendingRequestId: string }> }>;

export const NEEDS_YOU_KINDS = Object.freeze([
  "approval", "money", "question", "blocker", "stage-gate",
] as const);
export type NeedsYouKind = (typeof NEEDS_YOU_KINDS)[number];

export const APPROVAL_CLASSES = Object.freeze([
  "credential-use", "live-provider-request", "elevation", "destructive-filesystem",
  "git-publication", "external-communication", "install-update", "application-restart",
  "paid-usage", "purchase", "subscription", "spending-limit", "ui-automation",
  "scope-expansion",
] as const);
export type ApprovalClass = (typeof APPROVAL_CLASSES)[number];

export const PROJECT_POLICY_ACTION_ADDITIONS = Object.freeze([
  "elevation", "application-restart", "external-message", "paid-usage", "purchase",
  "subscription", "spending-limit", "editor-launch", "ui-automation",
] as const);
export type ProjectPolicyAction = PolicyAction | (typeof PROJECT_POLICY_ACTION_ADDITIONS)[number];

export const PROJECT_POLICY_ACTION_VALUES = Object.freeze([
  "provider-disclosure", "model-eligibility", "cloud-execution", "local-execution",
  "artifact-persistence", "input-logging", "output-logging", "workspace-read",
  "workspace-write", "command-execution", "network-access", "tool-invocation",
  "secret-access", "approval", "retention", "export", "deletion", "package-install",
  "git-write", ...PROJECT_POLICY_ACTION_ADDITIONS,
] as const satisfies readonly ProjectPolicyAction[]);

export const PROJECT_RECORD_KINDS = Object.freeze([
  "project", "project-brief", "constraint", "project-plan", "plan-stage", "task",
  "dependency", "agent-run", "session", "handover", "decision", "approval-request",
  "spending-request", "usage-reservation", "evidence-record", "deliverable", "blocker",
  "notification", "communication-thread", "external-integration", "project-health",
  "project-stop",
] as const);
export type ProjectRecordKind = (typeof PROJECT_RECORD_KINDS)[number];

export interface Project {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly revision: number;
  readonly displayName: string;
  readonly repositoryRoots: readonly string[];
  readonly defaultBranch: string | null;
  readonly dataClassification: DataClassification;
  readonly permissionMode: PermissionMode;
  readonly budgetAccountId: string;
  readonly effectiveConfigDigest: string;
  readonly status: ProjectStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ClarificationQuestion {
  readonly questionId: string;
  readonly theme: "scope" | "quality-bar" | "constraints" | "environment" | "delivery" | "risk";
  readonly question: string;
  readonly whyItMatters: string;
  readonly options: readonly string[] | null;
  readonly proposedDefault: string;
  readonly consequenceIfDefaulted: string;
  readonly blocking: boolean;
}

export interface Constraint {
  readonly constraintId: string;
  readonly kind: ConstraintKind;
  readonly statement: string;
  readonly enforcement: "hard" | "advisory";
  readonly machineForm: JsonObject | null;
  readonly origin: "operator" | "repository" | "model";
  readonly authority: "none" | "operator";
}

export interface ProjectBrief {
  readonly schemaVersion: 1;
  readonly briefId: string;
  readonly projectId: string;
  readonly revision: 1;
  readonly supersedes: string | null;
  readonly origin: "operator";
  readonly objective: string;
  readonly outcomes: readonly string[];
  readonly nonGoals: readonly string[];
  readonly audiences: readonly string[];
  readonly constraints: readonly Constraint[];
  readonly assumptions: readonly {
    readonly text: string;
    readonly source: "operator" | "repository" | "model";
    readonly confirmed: boolean;
  }[];
  readonly openQuestions: readonly ClarificationQuestion[];
  readonly sourceThreadId: string | null;
  readonly createdAt: string;
}

export interface PlanStage {
  readonly stageId: string;
  readonly ordinal: number;
  readonly title: string;
  readonly intent: string;
  readonly exitCriteria: readonly string[];
  readonly exitEvidenceKinds: readonly string[];
  readonly taskIds: readonly string[];
  readonly gate: "automatic" | "operator-review";
}

export interface HandoverPolicy {
  readonly requires: "none" | "optional" | "required";
  readonly acceptFrom: readonly string[];
  readonly maximumAgeMs: number | null;
}

export interface ProjectTask {
  readonly taskId: string;
  readonly stageId: string;
  readonly title: string;
  readonly objective: string;
  readonly requirements: TaskRequirements;
  readonly requirementIds: readonly string[];
  readonly workspaceMode: "none" | "snapshot" | "worktree";
  readonly acceptance: readonly {
    readonly criterion: string;
    readonly validationCommand: readonly string[] | null;
  }[];
  readonly expectedOutputSchema: JsonObject;
  readonly idempotencyClass: "pure" | "replayable" | "reconcilable" | "approval-bound" | "irreversible";
  readonly budget: OrchestrationBudget;
  readonly retry: OrchestrationRetryPolicy;
  readonly timeout: OrchestrationTimeoutPolicy;
  readonly priority: SchedulerTaskPriority;
  readonly workloadClass: "general" | "fable";
  readonly handoverPolicy: HandoverPolicy;
  readonly state: ProjectTaskState;
  readonly stateRevision: number;
}

/** Canonical dossier name; `ProjectTask` remains the unambiguous local name. */
export type Task = ProjectTask;

export interface Dependency {
  readonly fromTaskId: string;
  readonly toTaskId: string;
  readonly kind: "finish-to-start" | "artifact" | "advisory";
  readonly artifactKind: string | null;
}

export interface ProjectPlan {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly projectId: string;
  readonly briefId: string;
  readonly briefRevision: number;
  readonly revision: number;
  readonly supersedes: string | null;
  readonly state: PlanState;
  readonly stages: readonly PlanStage[];
  readonly tasks: readonly ProjectTask[];
  readonly dependencies: readonly Dependency[];
  readonly specificationRef: string | null;
  readonly coverageRef: string | null;
  readonly planDigest: string;
  readonly sealedAt: string | null;
  readonly sealedByApprovalId: string | null;
  readonly budgetCeiling: OrchestrationBudget;
  readonly origin: "model";
  readonly authority: "none";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type EffectPhase = "pre-dispatch" | "possibly-dispatched" | "response-received" | "post-response";

export interface AgentRun {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly projectId: string;
  readonly planId: string;
  readonly planRevision: number;
  readonly taskId: string;
  readonly attempt: number;
  readonly workId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly route: SelectedRoute;
  readonly reservationId: string | null;
  readonly dispatchId: string | null;
  readonly sessionId: string | null;
  readonly grantDigest: string;
  readonly consumedApprovalIds: readonly string[];
  readonly consumedHandoverId: string | null;
  readonly state: AgentRunState;
  readonly usage: NormalizedUsage;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly terminal: {
    readonly outcome: "completed" | "failed" | "cancelled";
    readonly classification: FailureClassification | null;
    readonly code: string;
    readonly effectPhase: EffectPhase;
  } | null;
}

export interface Session {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly projectId: string;
  readonly providerId: string;
  readonly providerSessionRef: string | null;
  readonly workspace: WorkspaceIdentity;
  readonly worktreePath: string | null;
  readonly containment: {
    readonly backendId: string;
    readonly securityClass: BackendSecurityClass;
    readonly jobObjectBound: boolean;
    readonly terminationConfirmable: boolean;
  };
  readonly state: SessionState;
  readonly lastHeartbeatAt: string | null;
  readonly heartbeatIntervalMs: number;
  readonly ownerRunId: string | null;
  readonly resumable: boolean;
  readonly archivedAt: string | null;
  readonly archiveRef: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Handover {
  readonly schemaVersion: 1;
  readonly handoverId: string;
  readonly revision: 1;
  readonly supersedes: string | null;
  readonly projectId: string;
  readonly planId: string;
  readonly planRevision: number;
  readonly fromRunId: string;
  readonly toTaskId: string;
  readonly sequence: number;
  readonly state: HandoverState;
  readonly repository: {
    readonly repositoryRoot: string;
    readonly snapshotId: string;
    readonly baseRevision: string;
    readonly branch: string | null;
    readonly worktreeDisposition: "reuse" | "fresh-from-base" | "fresh-from-result";
    readonly resultRevision: string | null;
  };
  readonly goals: readonly string[];
  readonly nonGoals: readonly string[];
  readonly completed: readonly { readonly claim: string; readonly evidenceIds: readonly string[] }[];
  readonly remaining: readonly { readonly item: string; readonly requirementIds: readonly string[] }[];
  readonly risks: readonly { readonly risk: string; readonly severity: "low" | "medium" | "high"; readonly mitigated: boolean }[];
  readonly operatorDecisionIds: readonly string[];
  readonly consumedApprovalIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly budgetRemaining: OrchestrationBudget;
  readonly expectedOutputSchema: JsonObject;
  readonly origin: "system";
  readonly authority: "none";
  readonly modelNarrativeRef: string | null;
  readonly createdAt: string;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedByRunId: string | null;
}

export interface Decision {
  readonly schemaVersion: 1;
  readonly decisionId: string;
  readonly revision: 1;
  readonly projectId: string;
  readonly scope: { readonly planId: string | null; readonly planRevision: number | null; readonly stageId: string | null; readonly taskId: string | null };
  readonly kind: DecisionKind;
  readonly decidedBy: "operator" | "policy" | "deterministic-evaluation";
  readonly statement: string;
  readonly rationale: string | null;
  readonly supersedes: string | null;
  readonly subjectDigest: string;
  readonly decidedAt: string;
}

export interface SubjectSummary {
  readonly what: string;
  readonly why: string;
  readonly changes: string;
  readonly where: string;
  readonly reversible: boolean;
  readonly scope: string;
  readonly effects: readonly string[];
  readonly exclusions: readonly string[];
}

export type ScopePattern =
  | { readonly kind: "git-publication"; readonly projectId: string; readonly remote: string; readonly refPrefix: string; readonly forcePush: false }
  | { readonly kind: "external-communication"; readonly integrationId: string; readonly channelRef: string; readonly recipientRef: string; readonly redactionClass: "summary-only" | "status-only" }
  | { readonly kind: "paid-usage"; readonly providerInstanceId: string; readonly modelId: string; readonly currency: string; readonly ceilingMinorUnits: number };

export interface MoneyBinding {
  readonly vendor: { readonly name: string; readonly instanceRef: string };
  readonly amountMinorUnits: number;
  readonly currency: string;
  readonly kind: "one-time" | "per-period" | "ceiling";
  readonly period: "monthly" | "annual" | null;
  readonly occurrences: number | null;
  readonly quoteDigest: string | null;
  readonly quotedAt: string | null;
  readonly quoteExpiresAt: string | null;
}

export interface ApprovalRequest {
  readonly schemaVersion: 1;
  readonly approvalRequestId: string;
  readonly class: ApprovalClass;
  readonly actions: readonly ProjectPolicyAction[];
  readonly risk: "low" | "medium" | "high" | "critical";
  readonly scope: ApprovalScope;
  readonly subjectDigest: string;
  readonly subjectSummary: SubjectSummary;
  readonly usage: "one-shot" | "bounded-recurring" | "standing-revocable";
  readonly scopePattern: ScopePattern | null;
  readonly consumptionCeiling: number | null;
  readonly consumptionCount: number;
  readonly retryAllowance: number;
  readonly effects: readonly string[];
  readonly exclusions: readonly string[];
  readonly money: MoneyBinding | null;
  readonly requestedBy: { readonly kind: "system"; readonly runId: string | null; readonly reason: string };
  readonly state: ApprovalState;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly approverClass: ApproverClass | null;
  readonly consumedAt: string | null;
  readonly revokedAt: string | null;
  readonly voidedBy: string | null;
}

export interface SpendingRequest {
  readonly schemaVersion: 1;
  readonly spendingRequestId: string;
  readonly projectId: string | null;
  readonly kind: "paid-usage" | "purchase" | "subscription" | "recurring-limit-change";
  readonly vendor: { readonly name: string; readonly instanceRef: string };
  readonly amountMinorUnits: number;
  readonly currency: string;
  readonly recurrence: null | { readonly period: "monthly" | "annual"; readonly occurrences: number | null };
  readonly quotedAt: string;
  readonly quoteExpiresAt: string;
  readonly quoteDigest: string;
  readonly justification: string;
  readonly linkedApprovalRequestId: string;
  readonly state: SpendingState;
  readonly executedAt: string | null;
  readonly externalReceiptRef: string | null;
  readonly createdAt: string;
}

export type UsageReservation = RuntimeUsageReservation;

export interface EvidenceRecord {
  readonly schemaVersion: 1;
  readonly evidenceId: string;
  readonly revision: 1;
  readonly supersedes: string | null;
  readonly projectId: string;
  readonly runId: string;
  readonly kind: string;
  readonly sha256: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly producedBy: "deterministic-validation" | "workspace-reconciliation" | "provider" | "operator";
  readonly claimsSupported: readonly string[];
  readonly sensitivity: DataClassification;
  readonly retentionClass: "permanent" | "bounded" | "diagnostic";
  readonly createdAt: string;
}

export interface Deliverable {
  readonly schemaVersion: 1;
  readonly deliverableId: string;
  readonly projectId: string;
  readonly stageId: string | null;
  readonly title: string;
  readonly kind: "commit" | "branch" | "patch" | "document" | "report" | "artifact-set";
  readonly evidenceIds: readonly string[];
  readonly repositoryRef: { readonly revision: string; readonly branch: string | null } | null;
  readonly acceptance: "pending" | "accepted" | "rejected";
  readonly acceptedByDecisionId: string | null;
  readonly createdAt: string;
}

export interface Blocker {
  readonly schemaVersion: 1;
  readonly blockerId: string;
  readonly projectId: string;
  readonly scope: { readonly planId: string | null; readonly stageId: string | null; readonly taskId: string | null; readonly runId: string | null };
  readonly kind: BlockerKind;
  readonly ruleIds: readonly string[];
  readonly statement: string;
  readonly unblockedBy: readonly string[];
  readonly operatorActionable: boolean;
  readonly state: BlockerState;
  readonly openedAt: string;
  readonly clearedAt: string | null;
  readonly clearedBy: string | null;
}

export interface NotificationDelivery {
  readonly channel: "in-app" | "windows-toast" | "discord" | "telegram" | "whatsapp";
  readonly state: NotificationDeliveryState;
  readonly attempt: number;
  readonly idempotencyKey: string;
  readonly lastAttemptAt: string | null;
  readonly failureCode: string | null;
}

export interface Notification {
  readonly schemaVersion: 1;
  readonly notificationId: string;
  readonly projectId: string | null;
  readonly category: NotificationCategory;
  readonly severity: "info" | "success" | "warning" | "danger" | "urgent";
  readonly episodeKey: string;
  readonly title: string;
  readonly body: string;
  readonly deepLink: ProjectDeepLink | null;
  readonly actionable: boolean;
  readonly createdAt: string;
  readonly quietHoursDeferredUntil: string | null;
  readonly deliveries: readonly NotificationDelivery[];
  readonly acknowledgedAt: string | null;
  readonly expiresAt: string | null;
}

export interface CommunicationThread {
  readonly schemaVersion: 1;
  readonly threadId: string;
  readonly projectId: string | null;
  readonly channel: "in-app" | "discord" | "telegram" | "whatsapp";
  readonly participantRef: string;
  readonly messages: readonly {
    readonly messageId: string;
    readonly direction: "inbound" | "outbound";
    readonly at: string;
    readonly bodyRef: string;
    readonly trust: "untrusted-input" | "system-generated";
    readonly derivedRecordIds: readonly string[];
  }[];
  readonly createdAt: string;
}

export interface ExternalIntegration {
  readonly schemaVersion: 1;
  readonly integrationId: string;
  readonly kind: "editor" | "messaging" | "usage-source" | "repository-host";
  readonly implementationId: string;
  readonly state: "planned" | "configured" | "unavailable" | "revoked";
  readonly capabilities: readonly string[];
  readonly credentialRef: SecretRef | null;
  readonly allowlist: readonly string[];
  readonly boundVersion: string | null;
  readonly boundDigest: string | null;
  readonly lastVerifiedAt: string | null;
  readonly createdAt: string;
}

export interface ProjectHealthProjection {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly computedAt: string;
  readonly sourceSequence: number;
  readonly planState: PlanState | null;
  readonly stageProgress: readonly { readonly stageId: string; readonly done: number; readonly total: number; readonly gate: "automatic" | "operator-review" }[];
  readonly counts: { readonly running: number; readonly queued: number; readonly blocked: number; readonly awaitingApproval: number; readonly failed: number; readonly completed: number };
  readonly openBlockers: readonly { readonly blockerId: string; readonly kind: BlockerKind; readonly operatorActionable: boolean }[];
  readonly coverage: { readonly required: { readonly covered: number; readonly total: number }; readonly expectedQuality: { readonly covered: number; readonly total: number } } | null;
  readonly budget: { readonly reservedMicros: number; readonly actualMicros: number; readonly ceilingMicros: number };
  readonly capacity: readonly { readonly profileId: string; readonly windowStatus: "active" | "inactive" | "stale" | "unavailable"; readonly headroomBasisPoints: number | null }[];
  readonly confidence: "current" | "stale";
  readonly staleReason: string | null;
}

export interface ProjectStop {
  readonly schemaVersion: 1;
  readonly projectStopId: string;
  readonly revision: number;
  readonly projectId: string;
  readonly engagedAt: string;
  readonly effects: {
    readonly cancelledTaskIds: readonly string[];
    readonly stoppingSessionIds: readonly string[];
    readonly unconfirmedSessionIds: readonly string[];
    readonly voidedApprovalIds: readonly string[];
    readonly voidedHandoverIds: readonly string[];
    readonly releasedReservationIds: readonly string[];
    readonly retainedReservationIds: readonly string[];
  };
  readonly resumedAt: string | null;
}

export interface ProjectSummaryProjection {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly displayName: string;
  readonly status: ProjectStatus | "stopped";
  readonly planState: PlanStateDisplayWord | null;
  readonly currentStage: { readonly ordinal: number; readonly title: string; readonly gate: "automatic" | "operator-review" } | null;
  readonly nextMilestone: { readonly title: string; readonly expectedBy: string | null } | null;
  readonly counts: { readonly running: number; readonly waiting: number; readonly blocked: number; readonly awaitingApproval: number; readonly queued: number; readonly done: number; readonly total: number };
  readonly needsYou: readonly { readonly kind: NeedsYouKind; readonly title: string; readonly expiresAt: string | null; readonly deepLink: ProjectDeepLink }[];
  readonly usage: { readonly reservedBp: number; readonly actualBp: number; readonly currency: string; readonly estimateMicros: number; readonly actualMicros: number; readonly pricingAt: string };
  readonly capacity: readonly { readonly alias: string; readonly ownership: "owned" | "authorized-borrowed"; readonly windowStatus: "active" | "inactive" | "stale" | "unavailable"; readonly eligible: boolean; readonly blockingRuleId: string | null; readonly resetAt: string | null }[];
  readonly confidence: "current" | "stale";
  readonly sourceSequence: number;
  readonly computedAt: string;
}

export type CanonicalProjectRecord =
  | Project | ProjectBrief | Constraint | ProjectPlan | PlanStage | ProjectTask | Dependency
  | AgentRun | Session | Handover | Decision | ApprovalRequest | SpendingRequest
  | UsageReservation | EvidenceRecord | Deliverable | Blocker | Notification
  | CommunicationThread | ExternalIntegration | ProjectHealthProjection | ProjectStop;

// These names are intentionally referenced so strict isolated builds prove the
// type-only imports remain compatible with the owning packages.
export type ProjectContractCompatibility = Readonly<{
  dataClassification: _DataClassificationParity;
  permissionMode: _PermissionModeParity;
  runStatus: _RunStatusParity;
  backendSecurityClass: _BackendSecurityClassParity;
  failureClassification: _FailureClassificationParity;
  secretReference: ExternalIntegration["credentialRef"];
}>;
