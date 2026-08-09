import type { JsonObject } from "@ai-dev-os/domain";

export const ORCHESTRATION_SCHEMA_VERSION = 1 as const;
export const ORCHESTRATION_EVENT_SCHEMA_VERSION = 1 as const;

export const PERMISSION_MODES = Object.freeze([
  "contained-default",
  "scoped-autonomous",
  "trusted-full-access",
] as const);
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const AGENT_CAPABILITIES = Object.freeze([
  "repository-read",
  "repository-write",
  "shell",
  "tests",
  "network",
  "structured-output",
  "resumability",
] as const);
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

export const PROFILE_OWNERSHIP_CLASSES = Object.freeze([
  "owned",
  "authorized-borrowed",
] as const);
export type ProfileOwnershipClass = (typeof PROFILE_OWNERSHIP_CLASSES)[number];

export const TASK_PRIORITIES = Object.freeze(["low", "normal", "high", "critical"] as const);
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface WorkspaceIdentity {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly snapshotId: string;
  readonly baseRevision: string;
}

export interface RequestedRoute {
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly profileId: string | null;
  readonly ownership: ProfileOwnershipClass | null;
}

export interface OrchestrationBudget {
  readonly maximumInputTokens: number;
  readonly maximumOutputTokens: number;
  readonly maximumCostMicros: number;
  readonly maximumToolCalls: number;
  readonly maximumTurns: number;
}

export interface OrchestrationRetryPolicy {
  readonly maximumAttempts: number;
  readonly initialBackoffMs: number;
  readonly maximumBackoffMs: number;
  readonly retryableFailures: readonly FailureClassification[];
}

export interface OrchestrationTimeoutPolicy {
  readonly dispatchMs: number;
  readonly attemptMs: number;
}

export interface OrchestrationTaskEnvelope {
  readonly schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION;
  readonly taskId: string;
  readonly parentTaskId: string | null;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly objective: string;
  readonly workspace: WorkspaceIdentity;
  readonly requestedRoute: RequestedRoute;
  readonly capabilities: readonly AgentCapability[];
  readonly permissionMode: PermissionMode;
  readonly budget: OrchestrationBudget;
  readonly retry: OrchestrationRetryPolicy;
  readonly timeout: OrchestrationTimeoutPolicy;
  readonly expectedResultSchema: JsonObject;
  readonly priority: TaskPriority;
  readonly createdAt: string;
  readonly deadline: string;
}

export const FAILURE_CLASSIFICATIONS = Object.freeze([
  "authentication",
  "authorization",
  "capacity",
  "deadline",
  "disconnected",
  "invalid-result",
  "policy",
  "provider",
  "usage",
  "unknown",
] as const);
export type FailureClassification = (typeof FAILURE_CLASSIFICATIONS)[number];

export interface NormalizedUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly toolCalls: number;
  readonly costMicros: number | null;
}

export interface ArtifactReference {
  readonly artifactId: string;
  readonly kind: string;
  readonly sha256: string;
}

export interface EvidenceReference {
  readonly evidenceId: string;
  readonly kind: string;
  readonly sha256: string;
}

export interface ProviderThreadIdentity {
  readonly providerId: string;
  readonly modelId: string;
  readonly profileId: string;
  readonly threadId: string;
  readonly providerRunId: string;
}

export interface OrchestrationTerminalResult {
  readonly schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION;
  readonly outcome: "completed" | "failed" | "cancelled" | "policy-blocked";
  readonly artifacts: readonly ArtifactReference[];
  readonly evidence: readonly EvidenceReference[];
  readonly usage: NormalizedUsage;
  readonly startedAt: string | null;
  readonly finishedAt: string;
  readonly provider: ProviderThreadIdentity | null;
  readonly failure: {
    readonly classification: FailureClassification;
    readonly code: string;
    readonly retryable: boolean;
  } | null;
  readonly nonclaims: readonly string[];
}

export const RUN_STATUSES = Object.freeze([
  "new",
  "queued",
  "dispatched",
  "running",
  "awaiting-approval",
  "retry-wait",
  "policy-blocked",
  "completed",
  "failed",
  "cancelled",
] as const);
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface SelectedRoute {
  readonly candidateId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly profileId: string;
  readonly ownership: ProfileOwnershipClass;
}

export interface DispatchReceipt {
  readonly dispatchId: string;
  readonly attempt: number;
  readonly route: SelectedRoute;
  readonly leaseExpiresAt: string;
}

export interface PolicyBlock {
  readonly blockId: string;
  readonly operationFingerprint: string;
  readonly ruleIds: readonly string[];
  readonly reason: string;
  readonly humanResumable: boolean;
}

export interface OrchestrationRunState {
  readonly schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION;
  readonly task: OrchestrationTaskEnvelope;
  readonly taskFingerprint: string;
  readonly status: RunStatus;
  readonly sequence: number;
  readonly lastEventId: string | null;
  readonly lastOccurredAt: string | null;
  readonly attempt: number;
  readonly turns: number;
  readonly routingDecisionId: string | null;
  readonly routingOutcome: "selected" | "denied" | null;
  readonly route: SelectedRoute | null;
  readonly dispatch: DispatchReceipt | null;
  readonly threadId: string | null;
  readonly providerRunId: string | null;
  readonly nextAttemptAt: string | null;
  readonly usage: NormalizedUsage;
  readonly approvalId: string | null;
  readonly block: PolicyBlock | null;
  readonly result: OrchestrationTerminalResult | null;
}

export const ORCHESTRATION_EVENT_TYPES = Object.freeze([
  "queued",
  "routing_decision",
  "dispatched",
  "started",
  "progress",
  "checkpoint",
  "usage_snapshot",
  "approval_required",
  "policy_blocked",
  "retry_scheduled",
  "completed",
  "failed",
  "cancelled",
  "recovered",
] as const);
export type OrchestrationEventType = (typeof ORCHESTRATION_EVENT_TYPES)[number];

export interface OrchestrationEvent {
  readonly schemaVersion: typeof ORCHESTRATION_EVENT_SCHEMA_VERSION;
  readonly eventId: string;
  readonly taskId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly type: OrchestrationEventType;
  readonly payload: JsonObject;
}

export interface SchedulerAuditRecord {
  readonly taskId: string;
  readonly sequence: number;
  readonly eventType: OrchestrationEventType;
  readonly status: RunStatus;
  readonly occurredAt: string;
  readonly ruleIds: readonly string[];
}

export interface SchedulerClock {
  now(): Date;
}

export interface SchedulerConfiguration {
  readonly maximumConcurrency: number;
  readonly leaseDurationMs: number;
  readonly usageFreshnessMs: number;
}

export const STAGE_18A_PRODUCTION_ENABLED = false as const;
