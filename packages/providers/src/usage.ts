import {
  parseMoney,
  parseTokenUsage,
  totalTokens,
  validation,
  type Money,
  type TokenUsage,
} from "@ai-dev-os/domain";

const { ensureExactKeys, ensureNullable, ensureRecord, ensureSafeInteger } = validation;

const MAX_COUNT = 1_000_000_000;
const MAX_DURATION_MS = 10_000_000_000_000;

/**
 * Actual measured consumption of one provider operation. Token categories
 * reuse the exact Stage 2 vocabulary (disjoint categories, safe integers).
 * Streaming usage-update events carry CUMULATIVE SNAPSHOTS of this shape,
 * never deltas; each snapshot's total must be >= the previous one.
 */
export interface ProviderUsage {
  readonly tokens: TokenUsage;
  readonly toolCalls: number;
}

export function parseProviderUsage(value: unknown, path = "usage"): ProviderUsage {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["tokens", "toolCalls"], path);
  return Object.freeze({
    tokens: parseTokenUsage(record["tokens"], `${path}.tokens`),
    toolCalls: ensureSafeInteger(record["toolCalls"], `${path}.toolCalls`, 0, MAX_COUNT),
  });
}

/**
 * Exact monetary cost. `providerReported` is what the provider billed or
 * claimed; `locallyComputed` is derived from Stage 2 pricing metadata.
 * Both null means the cost is unknown. Floating-point currency is
 * unrepresentable: both fields are Stage 2 integer-micro Money.
 */
export interface ProviderCost {
  readonly providerReported: Money | null;
  readonly locallyComputed: Money | null;
}

export function parseProviderCost(value: unknown, path = "cost"): ProviderCost {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["providerReported", "locallyComputed"], path);
  return Object.freeze({
    providerReported: ensureNullable(record["providerReported"], (raw) =>
      parseMoney(raw, `${path}.providerReported`),
    ),
    locallyComputed: ensureNullable(record["locallyComputed"], (raw) =>
      parseMoney(raw, `${path}.locallyComputed`),
    ),
  });
}

/** Scalar used to validate that streamed usage snapshots are cumulative. */
export function totalOfUsage(usage: ProviderUsage): number {
  return totalTokens(usage.tokens) + usage.toolCalls;
}

export const UNKNOWN_COST: ProviderCost = Object.freeze({
  providerReported: null,
  locallyComputed: null,
});

/** Wall-clock characteristics measured with the adapter's injected clock. */
export interface ProviderLatency {
  readonly firstEventMs: number | null;
  readonly totalMs: number;
}

export function parseProviderLatency(value: unknown, path = "latency"): ProviderLatency {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["firstEventMs", "totalMs"], path);
  const totalMs = ensureSafeInteger(record["totalMs"], `${path}.totalMs`, 0, MAX_DURATION_MS);
  return Object.freeze({
    firstEventMs: ensureNullable(record["firstEventMs"], (raw) =>
      ensureSafeInteger(raw, `${path}.firstEventMs`, 0, totalMs),
    ),
    totalMs,
  });
}

/**
 * Caller-estimated consumption, carried on requests so a later scheduler can
 * reconcile reservations against the actual usage in the result. Estimates
 * never mix with actuals: this type appears only on requests.
 */
export interface EstimatedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export function parseEstimatedUsage(value: unknown, path = "estimatedUsage"): EstimatedUsage {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["inputTokens", "outputTokens"], path);
  return Object.freeze({
    inputTokens: ensureSafeInteger(record["inputTokens"], `${path}.inputTokens`, 0, 1_000_000_000_000),
    outputTokens: ensureSafeInteger(record["outputTokens"], `${path}.outputTokens`, 0, 1_000_000_000_000),
  });
}

export const ZERO_PROVIDER_USAGE: ProviderUsage = Object.freeze({
  tokens: parseTokenUsage({
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  }),
  toolCalls: 0,
});

/** Outcome category shared by results and observability records. */
export const PROVIDER_OUTCOMES = Object.freeze(["succeeded", "failed", "cancelled"] as const);
export type ProviderOutcomeCategory = (typeof PROVIDER_OUTCOMES)[number];

/**
 * Structured observability record emitted at operation end. Never contains
 * prompts, responses, tool arguments, command output, or artifact content.
 */
export interface ProviderOperationRecord {
  readonly providerKind: "inference" | "coding-agent";
  readonly providerId: string;
  readonly instanceId: string;
  readonly modelId: string | null;
  readonly outcome: ProviderOutcomeCategory;
  readonly errorCode: string | null;
  readonly retryStrategy: string | null;
  readonly latencyMs: number;
  readonly totalTokens: number;
  readonly deadlineExpired: boolean;
  readonly cancelled: boolean;
}

export type ProviderObserver = (record: ProviderOperationRecord) => void;
