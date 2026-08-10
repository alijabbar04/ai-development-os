import type {
  NormalizedCanonicalUsageSnapshot,
  NormalizedUsage,
  OrchestrationTaskEnvelope,
  OrchestrationTerminalResult,
  RouteCandidate,
  SchedulerClock,
} from "../src/index.js";

export const BASE_TIME = "2026-08-10T10:00:00.000Z";
export const LATER_TIME = "2026-08-10T10:01:00.000Z";
export const DEADLINE = "2026-08-10T12:00:00.000Z";

export class ManualClock implements SchedulerClock {
  private value: Date;

  constructor(value = BASE_TIME) {
    this.value = new Date(value);
  }

  now(): Date {
    return new Date(this.value.valueOf());
  }

  set(value: string): void {
    this.value = new Date(value);
  }

  advance(milliseconds: number): void {
    this.value = new Date(this.value.valueOf() + milliseconds);
  }
}

export function task(overrides: Partial<OrchestrationTaskEnvelope> = {}): OrchestrationTaskEnvelope {
  return {
    schemaVersion: 1,
    taskId: "task:stage18a",
    parentTaskId: null,
    correlationId: "correlation:stage18a",
    idempotencyKey: "idempotency:stage18a:0001",
    objective: "Perform one deterministic bounded fake orchestration turn.",
    workspace: {
      projectId: "project:stage18a",
      workspaceId: "workspace:stage18a",
      snapshotId: "snapshot:stage18a",
      baseRevision: "0123456789abcdef0123456789abcdef01234567",
    },
    requestedRoute: { providerId: null, modelId: null, profileId: null, ownership: null },
    capabilities: ["repository-read", "repository-write", "resumability", "structured-output"],
    permissionMode: "contained-default",
    budget: {
      maximumInputTokens: 100_000,
      maximumOutputTokens: 20_000,
      maximumCostMicros: 10_000_000,
      maximumToolCalls: 100,
      maximumTurns: 4,
    },
    retry: {
      maximumAttempts: 3,
      initialBackoffMs: 100,
      maximumBackoffMs: 1_000,
      retryableFailures: ["capacity", "disconnected", "provider"],
    },
    timeout: { dispatchMs: 1_000, attemptMs: 60_000 },
    expectedResultSchema: { type: "object", additionalProperties: false },
    priority: "normal",
    createdAt: BASE_TIME,
    deadline: DEADLINE,
    ...overrides,
  };
}

export function candidate(overrides: Partial<RouteCandidate> = {}): RouteCandidate {
  const ownership = overrides.ownership ?? "owned";
  return {
    schemaVersion: 1,
    candidateId: "candidate:fake",
    providerId: "provider:fake",
    modelId: "model:fake",
    profileId: "profile:owned",
    ownership,
    borrowedPolicy: overrides.borrowedPolicy === undefined
      ? (ownership === "authorized-borrowed"
          ? { taskClass: "claude-code", taskAuthorized: true, modelAllowed: true }
          : null)
      : overrides.borrowedPolicy,
    authorized: true,
    availability: "available",
    health: "healthy",
    healthObservedAt: BASE_TIME,
    capabilities: ["repository-read", "repository-write", "resumability", "structured-output"],
    permissionModes: ["contained-default"],
    qualityScore: 800,
    costScore: 600,
    predictedFiveHourBasisPoints: 100,
    predictedWeeklyBasisPoints: 100,
    ...overrides,
    ownership,
  };
}

export function usageSnapshot(overrides: Partial<NormalizedCanonicalUsageSnapshot> = {}): NormalizedCanonicalUsageSnapshot {
  return {
    schemaVersion: 2,
    compatibility: "native-v2",
    snapshotId: "usage:owned:1",
    sourceAdapterId: "adapter:usage:test",
    sourceAdapterVersion: "version:2",
    sourceFingerprint: "a".repeat(64),
    sourceClass: "provider-authoritative",
    authoritative: true,
    confidence: "high",
    profileId: "profile:owned",
    providerId: "provider:fake",
    ownership: "owned",
    authorization: "authorized",
    revocation: "not-revoked",
    timezone: "Europe/London",
    observedAt: BASE_TIME,
    freshUntil: "2026-08-10T10:15:00.000Z",
    fiveHour: {
      windowId: "window:five-hour:1",
      usedBasisPoints: 1_000,
      remainingBasisPoints: 9_000,
      resetAt: "2026-08-10T13:00:00.000Z",
    },
    weekly: {
      windowId: "window:weekly:1",
      usedBasisPoints: 2_000,
      remainingBasisPoints: 8_000,
      resetAt: "2026-08-17T00:00:00.000Z",
    },
    ...overrides,
  };
}

export const ZERO_USAGE: NormalizedUsage = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  toolCalls: 0,
  costMicros: null,
});

export function normalizedUsage(overrides: Partial<NormalizedUsage> = {}): NormalizedUsage {
  return { ...ZERO_USAGE, inputTokens: 10, outputTokens: 5, ...overrides };
}

export function terminalResult(
  outcome: "completed" | "failed" | "cancelled" | "policy-blocked" = "completed",
  overrides: Partial<OrchestrationTerminalResult> = {},
): OrchestrationTerminalResult {
  const failed = outcome === "failed" || outcome === "policy-blocked";
  return {
    schemaVersion: 1,
    outcome,
    artifacts: [],
    evidence: [],
    usage: normalizedUsage(),
    startedAt: BASE_TIME,
    finishedAt: BASE_TIME,
    provider: {
      providerId: "provider:fake",
      modelId: "model:fake",
      profileId: "profile:owned",
      threadId: "thread:fake",
      providerRunId: "run:fake",
    },
    failure: failed ? { classification: outcome === "policy-blocked" ? "policy" : "provider", code: "scripted-failure", retryable: false } : null,
    nonclaims: ["deterministic-fake-only"],
    ...overrides,
  };
}

export function dispatchInput(overrides: {
  readonly candidates?: readonly RouteCandidate[];
  readonly usageSnapshots?: readonly NormalizedCanonicalUsageSnapshot[];
} = {}) {
  return {
    workloadClass: "general" as const,
    preference: "balanced" as const,
    candidates: overrides.candidates ?? [candidate()],
    usageSnapshots: overrides.usageSnapshots ?? [usageSnapshot()],
  };
}
