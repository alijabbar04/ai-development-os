import {
  ensureEnum,
  ensureEnumArray,
  ensureExactKeys,
  ensureNullable,
  ensureRecord,
  ensureSafeInteger,
  fail,
} from "./internal/guards.js";
import type { Branded } from "./ids.js";
import {
  DATA_CLASSIFICATIONS,
  type DataClassification,
} from "./classification.js";

export const TASK_KINDS = Object.freeze([
  "plan",
  "architecture",
  "implement",
  "refactor",
  "debug",
  "review",
  "test",
  "document",
  "shell",
  "explain",
  "transform",
] as const);

export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_RISKS = Object.freeze(["low", "medium", "high", "critical"] as const);
export type TaskRisk = (typeof TASK_RISKS)[number];

export const REASONING_DEMANDS = Object.freeze(["low", "medium", "high", "extreme"] as const);
export type ReasoningDemand = (typeof REASONING_DEMANDS)[number];

export const EDIT_SCOPES = Object.freeze(["none", "single-file", "multi-file", "cross-package"] as const);
export type EditScope = (typeof EDIT_SCOPES)[number];

export const TASK_CAPABILITIES = Object.freeze([
  "reasoning",
  "repository-read",
  "code-edit",
  "shell",
  "testing",
  "documentation",
  "vision",
  "structured-output",
  "tool-use",
] as const);

export type TaskCapability = (typeof TASK_CAPABILITIES)[number];

export type TaskComplexity = 1 | 2 | 3 | 4 | 5;

/** Priority is an integer in [-1000, 1000]; larger runs first (matches task-graph). */
export type TaskPriority = number & Branded<"TaskPriority">;

export const TASK_PRIORITY_RANGE = Object.freeze({ minimum: -1_000, maximum: 1_000 });

export const MAX_TOKEN_COUNT = 1_000_000_000_000;
export const MAX_DURATION_MS = 10_000_000_000_000;

export function parseTaskKind(value: unknown, path = "taskKind"): TaskKind {
  return ensureEnum(value, path, TASK_KINDS);
}

export function parseTaskRisk(value: unknown, path = "taskRisk"): TaskRisk {
  return ensureEnum(value, path, TASK_RISKS);
}

export function parseTaskComplexity(value: unknown, path = "taskComplexity"): TaskComplexity {
  return ensureSafeInteger(value, path, 1, 5) as TaskComplexity;
}

export function parseTaskPriority(value: unknown, path = "taskPriority"): TaskPriority {
  return ensureSafeInteger(
    value,
    path,
    TASK_PRIORITY_RANGE.minimum,
    TASK_PRIORITY_RANGE.maximum,
  ) as TaskPriority;
}

export interface TaskRequirements {
  readonly kind: TaskKind;
  readonly complexity: TaskComplexity;
  readonly risk: TaskRisk;
  readonly reasoning: ReasoningDemand;
  readonly editScope: EditScope;
  readonly capabilities: readonly TaskCapability[];
  readonly dataClassification: DataClassification;
  readonly expectedInputTokens: number | null;
  readonly expectedOutputTokens: number | null;
}

export interface TaskRequirementsInput {
  readonly kind: TaskKind;
  readonly complexity: TaskComplexity;
  readonly risk: TaskRisk;
  readonly reasoning: ReasoningDemand;
  readonly editScope: EditScope;
  readonly capabilities: readonly TaskCapability[];
  readonly dataClassification: DataClassification;
  readonly expectedInputTokens?: number | null;
  readonly expectedOutputTokens?: number | null;
}

export function parseTaskRequirements(value: unknown, path = "taskRequirements"): TaskRequirements {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "kind",
      "complexity",
      "risk",
      "reasoning",
      "editScope",
      "capabilities",
      "dataClassification",
      "expectedInputTokens",
      "expectedOutputTokens",
    ],
    path,
  );

  const editScope = ensureEnum(record["editScope"], `${path}.editScope`, EDIT_SCOPES);
  const capabilities = ensureEnumArray(
    record["capabilities"],
    `${path}.capabilities`,
    TASK_CAPABILITIES,
    TASK_CAPABILITIES.length,
  );

  if (editScope !== "none" && !capabilities.includes("code-edit")) {
    fail(
      `${path}.capabilities`,
      "missing_code_edit",
      `must include "code-edit" when editScope is "${editScope}".`,
    );
  }

  return Object.freeze({
    kind: parseTaskKind(record["kind"], `${path}.kind`),
    complexity: parseTaskComplexity(record["complexity"], `${path}.complexity`),
    risk: parseTaskRisk(record["risk"], `${path}.risk`),
    reasoning: ensureEnum(record["reasoning"], `${path}.reasoning`, REASONING_DEMANDS),
    editScope,
    capabilities,
    dataClassification: ensureEnum(
      record["dataClassification"],
      `${path}.dataClassification`,
      DATA_CLASSIFICATIONS,
    ),
    expectedInputTokens: ensureNullable(record["expectedInputTokens"], (tokenValue) =>
      ensureSafeInteger(tokenValue, `${path}.expectedInputTokens`, 0, MAX_TOKEN_COUNT),
    ),
    expectedOutputTokens: ensureNullable(record["expectedOutputTokens"], (tokenValue) =>
      ensureSafeInteger(tokenValue, `${path}.expectedOutputTokens`, 0, MAX_TOKEN_COUNT),
    ),
  });
}

export function createTaskRequirements(input: TaskRequirementsInput): TaskRequirements {
  return parseTaskRequirements(input);
}

export const RETRY_BACKOFFS = Object.freeze(["none", "fixed", "exponential"] as const);
export type RetryBackoff = (typeof RETRY_BACKOFFS)[number];

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoff: RetryBackoff;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  /** Integer percentage (100 = 1.0x) so backoff stays exact. Used by "exponential". */
  readonly backoffMultiplierPercent: number;
}

export function parseRetryPolicy(value: unknown, path = "retryPolicy"): RetryPolicy {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    ["maxAttempts", "backoff", "initialDelayMs", "maxDelayMs", "backoffMultiplierPercent"],
    path,
  );

  const backoff = ensureEnum(record["backoff"], `${path}.backoff`, RETRY_BACKOFFS);
  const initialDelayMs = ensureSafeInteger(
    record["initialDelayMs"],
    `${path}.initialDelayMs`,
    0,
    MAX_DURATION_MS,
  );
  const maxDelayMs = ensureSafeInteger(
    record["maxDelayMs"],
    `${path}.maxDelayMs`,
    0,
    MAX_DURATION_MS,
  );
  if (initialDelayMs > maxDelayMs) {
    fail(`${path}.initialDelayMs`, "delay_order", "cannot exceed maxDelayMs.");
  }
  const backoffMultiplierPercent = ensureSafeInteger(
    record["backoffMultiplierPercent"],
    `${path}.backoffMultiplierPercent`,
    100,
    10_000,
  );
  if (backoff === "exponential" && backoffMultiplierPercent === 100) {
    fail(
      `${path}.backoffMultiplierPercent`,
      "no_growth",
      "must exceed 100 when backoff is exponential.",
    );
  }

  return Object.freeze({
    maxAttempts: ensureSafeInteger(record["maxAttempts"], `${path}.maxAttempts`, 1, 100),
    backoff,
    initialDelayMs,
    maxDelayMs,
    backoffMultiplierPercent,
  });
}

export function createRetryPolicy(input: RetryPolicy): RetryPolicy {
  return parseRetryPolicy(input);
}

/**
 * Deterministic integer backoff. `attempt` is 1-based: the delay applied
 * before retry attempt N (N >= 2). Attempt 1 has no delay.
 */
export function computeRetryDelayMs(policy: RetryPolicy, attempt: number): number {
  const attemptNumber = ensureSafeInteger(attempt, "attempt", 1, 100);
  if (attemptNumber === 1 || policy.backoff === "none") {
    return 0;
  }
  if (policy.backoff === "fixed") {
    return policy.initialDelayMs;
  }

  let delay = BigInt(policy.initialDelayMs);
  const multiplier = BigInt(policy.backoffMultiplierPercent);
  const maxDelay = BigInt(policy.maxDelayMs);
  for (let step = 2; step < attemptNumber; step += 1) {
    delay = (delay * multiplier) / 100n;
    if (delay >= maxDelay) {
      return policy.maxDelayMs;
    }
  }
  return delay >= maxDelay ? policy.maxDelayMs : Number(delay);
}

export interface TimeoutPolicy {
  readonly executionTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly heartbeatTimeoutMs: number | null;
}

export function parseTimeoutPolicy(value: unknown, path = "timeoutPolicy"): TimeoutPolicy {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["executionTimeoutMs", "totalTimeoutMs", "heartbeatTimeoutMs"], path);

  const executionTimeoutMs = ensureSafeInteger(
    record["executionTimeoutMs"],
    `${path}.executionTimeoutMs`,
    1,
    MAX_DURATION_MS,
  );
  const totalTimeoutMs = ensureSafeInteger(
    record["totalTimeoutMs"],
    `${path}.totalTimeoutMs`,
    1,
    MAX_DURATION_MS,
  );
  if (executionTimeoutMs > totalTimeoutMs) {
    fail(`${path}.executionTimeoutMs`, "timeout_order", "cannot exceed totalTimeoutMs.");
  }
  const heartbeatTimeoutMs = ensureNullable(record["heartbeatTimeoutMs"], (heartbeatValue) =>
    ensureSafeInteger(heartbeatValue, `${path}.heartbeatTimeoutMs`, 1, MAX_DURATION_MS),
  );
  if (heartbeatTimeoutMs !== null && heartbeatTimeoutMs > executionTimeoutMs) {
    fail(`${path}.heartbeatTimeoutMs`, "timeout_order", "cannot exceed executionTimeoutMs.");
  }

  return Object.freeze({ executionTimeoutMs, totalTimeoutMs, heartbeatTimeoutMs });
}

export interface ExecutionConstraints {
  readonly timeout: TimeoutPolicy;
  readonly retry: RetryPolicy;
  readonly maxToolCalls: number;
  readonly maxOutputBytes: number;
  readonly maxSubtaskDepth: number;
}

export function parseExecutionConstraints(
  value: unknown,
  path = "executionConstraints",
): ExecutionConstraints {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    ["timeout", "retry", "maxToolCalls", "maxOutputBytes", "maxSubtaskDepth"],
    path,
  );

  return Object.freeze({
    timeout: parseTimeoutPolicy(record["timeout"], `${path}.timeout`),
    retry: parseRetryPolicy(record["retry"], `${path}.retry`),
    maxToolCalls: ensureSafeInteger(record["maxToolCalls"], `${path}.maxToolCalls`, 0, 100_000),
    maxOutputBytes: ensureSafeInteger(
      record["maxOutputBytes"],
      `${path}.maxOutputBytes`,
      1,
      1_000_000_000_000,
    ),
    maxSubtaskDepth: ensureSafeInteger(record["maxSubtaskDepth"], `${path}.maxSubtaskDepth`, 0, 128),
  });
}

export function createExecutionConstraints(input: ExecutionConstraints): ExecutionConstraints {
  return parseExecutionConstraints(input);
}
