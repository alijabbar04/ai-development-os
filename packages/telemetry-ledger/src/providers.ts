import type { ClaudeCapacitySnapshot, ClaudeObservation, ClaudeUsageCounts } from "@ai-dev-os/provider-claude-code";
import type { CodexAccountUsageSnapshot, CodexRateLimitSnapshot } from "@ai-dev-os/provider-codex";
import type { GatewayRuntimeStatus, RuntimeQuotaObservation } from "@ai-dev-os/provider-gateway";
import type { OllamaCapacitySnapshot, OllamaObservation } from "@ai-dev-os/provider-ollama";
import type { OpenAiObservation } from "@ai-dev-os/provider-openai";
import type {
  CodingAgentEvent,
  CodingAgentResult,
  InferenceEvent,
  InferenceResult,
  ProviderCost,
  ProviderHealth,
  ProviderUsage,
  RateLimitInformation,
} from "@ai-dev-os/providers";
import { TelemetryError } from "./errors.js";
import type {
  NormalizedTokenUsage,
  ProviderIdentity,
  TelemetryObservationDraft,
  TelemetryProvenance,
  TelemetryScope,
  TelemetrySource,
} from "./types.js";

export interface TelemetryBridgeContext {
  readonly ledgerId: string;
  readonly observationId: string;
  readonly idempotencyKey: string;
  readonly scope: TelemetryScope;
  readonly traceId: string | null;
  readonly operationId: string | null;
  readonly parentOperationId: string | null;
  readonly identity: ProviderIdentity;
  readonly sourceCategory: TelemetrySource["category"];
  readonly sourceObservationId: string;
  readonly sourceFingerprint: string;
  readonly observedAt: string;
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
  readonly resetsAt: string | null;
  readonly staleAt: string | null;
  readonly terminalAt: string | null;
  readonly confidence: "reported" | "high" | "medium" | "low" | "none";
  readonly pricingSource: string | null;
  readonly pricingEffectiveAt: string | null;
  readonly derivation: string | null;
  readonly previousObservationId: string | null;
  readonly correctedObservationId: string | null;
  readonly detailCodes: readonly string[];
}

function suffix(value: string, ending: string, maximum: number): string {
  const room = maximum - ending.length - 1;
  return `${value.slice(0, Math.max(1, room))}-${ending}`;
}

function draft(
  context: TelemetryBridgeContext,
  ending: string,
  kind: TelemetryObservationDraft["kind"],
  data: TelemetryObservationDraft["data"],
  override: Partial<Pick<TelemetryObservationDraft, "operationId" | "resetsAt" | "staleAt" | "terminalAt" | "confidence">> = {},
): TelemetryObservationDraft {
  const provenance: TelemetryProvenance = Object.freeze({
    sourceFingerprint: context.sourceFingerprint,
    pricingSource: context.pricingSource,
    pricingEffectiveAt: context.pricingEffectiveAt,
    derivation: context.derivation,
    sampleObservationIds: Object.freeze([]),
  });
  return Object.freeze({
    ledgerId: context.ledgerId,
    observationId: suffix(context.observationId, ending, 128),
    idempotencyKey: suffix(context.idempotencyKey, ending, 256),
    scope: context.scope,
    traceId: context.traceId,
    operationId: override.operationId ?? context.operationId,
    parentOperationId: context.parentOperationId,
    identity: context.identity,
    source: Object.freeze({ category: context.sourceCategory, sourceObservationId: suffix(context.sourceObservationId, ending, 128) }),
    observedAt: context.observedAt,
    effectiveFrom: context.effectiveFrom,
    effectiveUntil: context.effectiveUntil,
    resetsAt: override.resetsAt ?? context.resetsAt,
    staleAt: override.staleAt ?? context.staleAt,
    terminalAt: override.terminalAt ?? context.terminalAt,
    confidence: override.confidence ?? context.confidence,
    provenance,
    previousObservationId: context.previousObservationId,
    correctedObservationId: context.correctedObservationId,
    detailCodes: context.detailCodes,
    kind,
    data,
  } as TelemetryObservationDraft);
}

export function normalizedProviderUsage(usage: ProviderUsage): NormalizedTokenUsage {
  return Object.freeze({
    uncachedInputTokens: usage.tokens.inputTokens,
    cacheWriteInputTokens: 0,
    cachedReadInputTokens: usage.tokens.cachedInputTokens,
    visibleOutputTokens: usage.tokens.outputTokens,
    reasoningTokens: usage.tokens.reasoningTokens,
    unknownCombinedTokens: 0,
    toolCalls: usage.toolCalls,
    categoryCompleteness: "generic-four-category",
  });
}

export function genericProviderEventObservation(
  event: InferenceEvent | CodingAgentEvent,
  context: TelemetryBridgeContext,
): TelemetryObservationDraft | null {
  if (event.kind !== "usage-update") return null;
  return draft(context, `usage-${event.sequence}`, "cumulative-usage", {
    usage: normalizedProviderUsage(event.payload.usage), sequence: event.sequence, quality: "partial",
  }, { operationId: event.operationId });
}

function costComponents(cost: ProviderCost, context: TelemetryBridgeContext): readonly {
  readonly componentId: string;
  readonly semanticClass: "provider-billed" | "locally-computed-estimate" | "unknown";
  readonly currency: string | null;
  readonly amountMicros: number | null;
  readonly authority: "billing" | "planning" | "none";
  readonly priceSourceFingerprint: string | null;
  readonly priceEffectiveAt: string | null;
}[] {
  const result = [];
  if (cost.providerReported !== null) result.push({ componentId: "provider-reported", semanticClass: "provider-billed" as const, currency: cost.providerReported.currency, amountMicros: cost.providerReported.amountMicros, authority: "billing" as const, priceSourceFingerprint: null, priceEffectiveAt: null });
  if (cost.locallyComputed !== null) result.push({ componentId: "locally-computed", semanticClass: "locally-computed-estimate" as const, currency: cost.locallyComputed.currency, amountMicros: cost.locallyComputed.amountMicros, authority: "planning" as const, priceSourceFingerprint: context.sourceFingerprint, priceEffectiveAt: context.pricingEffectiveAt });
  if (result.length === 0) result.push({ componentId: "unknown", semanticClass: "unknown" as const, currency: null, amountMicros: null, authority: "none" as const, priceSourceFingerprint: null, priceEffectiveAt: null });
  return Object.freeze(result);
}

export function genericTerminalObservations(
  result: InferenceResult | CodingAgentResult,
  outcome: "succeeded" | "failed" | "cancelled",
  context: TelemetryBridgeContext,
): readonly TelemetryObservationDraft[] {
  const terminal = draft(context, "terminal", "terminal-reconciliation", {
    usage: normalizedProviderUsage(result.usage), sequence: null, outcome, quality: "complete",
  }, { operationId: result.operationId, terminalAt: context.terminalAt ?? context.observedAt });
  const cost = draft(context, "cost", "cost", { components: costComponents(result.cost, context) }, { operationId: result.operationId });
  return Object.freeze([terminal, cost]);
}

export function genericRateLimitObservation(rate: RateLimitInformation, context: TelemetryBridgeContext): TelemetryObservationDraft {
  return draft(context, "rate-limit", "quota-window", {
    state: rate.remaining === 0 ? "exhausted" : rate.remaining === null ? "unknown" : "limited",
    dimension: "requests", window: "provider-defined", providerWindowId: null,
    remaining: rate.remaining, limit: rate.limit, usedBasisPoints: null, remainingBasisPoints: null, durationMs: null,
  }, { resetsAt: rate.resetsAt });
}

export function providerHealthObservation(health: ProviderHealth, context: TelemetryBridgeContext): TelemetryObservationDraft {
  const state = health.status === "ready" ? "healthy" : health.status === "degraded" ? "degraded" : "unavailable";
  return draft(context, "health", "provider-health", { state, latencyMs: null }, { staleAt: context.staleAt });
}

export function ollamaObservationDrafts(observation: OllamaObservation, context: TelemetryBridgeContext): readonly TelemetryObservationDraft[] {
  if (observation.kind === "health-check") return Object.freeze([draft(context, "ollama-health", "provider-health", { state: observation.category === "healthy" ? "healthy" : observation.category === "degraded" || observation.category === "overloaded" ? "degraded" : "unavailable", latencyMs: null })]);
  if (observation.kind === "operation") {
    const usage: NormalizedTokenUsage = Object.freeze({ uncachedInputTokens: observation.inputTokens, cacheWriteInputTokens: 0, cachedReadInputTokens: 0, visibleOutputTokens: observation.outputTokens, reasoningTokens: 0, unknownCombinedTokens: 0, toolCalls: 0, categoryCompleteness: "partial" });
    return Object.freeze([
      draft(context, "ollama-terminal", "terminal-reconciliation", { usage, sequence: null, outcome: observation.outcome, quality: "partial" }, { terminalAt: context.terminalAt ?? context.observedAt }),
      draft(context, "ollama-cost", "cost", { components: [{ componentId: "local-cost-unknown", semanticClass: "unknown", currency: null, amountMicros: null, authority: "none", priceSourceFingerprint: null, priceEffectiveAt: null }] }),
    ]);
  }
  if (observation.kind === "admission") return Object.freeze([draft(context, "ollama-admission", "capacity", { state: observation.category === "admitted" ? "available" : "limited", dimension: "concurrency", available: null, limit: null, queued: null, reserved: null, window: null, providerWindowId: null })]);
  return Object.freeze([]);
}

export function ollamaCapacityObservations(snapshot: OllamaCapacitySnapshot, context: TelemetryBridgeContext): readonly TelemetryObservationDraft[] {
  const concurrency = draft(context, "ollama-concurrency", "capacity", { state: snapshot.closed ? "unavailable" : snapshot.queuedOperations > 0 ? "limited" : "available", dimension: "concurrency", available: null, limit: null, queued: snapshot.queuedOperations, reserved: snapshot.activeOperations, window: null, providerWindowId: null });
  const memory = snapshot.capacityBudgetBytes === null ? draft(context, "ollama-memory", "capacity", { state: "unknown", dimension: "memory-bytes", available: null, limit: null, queued: null, reserved: snapshot.reservedBytes, window: null, providerWindowId: null }) : draft(context, "ollama-memory", "capacity", { state: snapshot.reservedBytes >= snapshot.capacityBudgetBytes ? "exhausted" : "available", dimension: "memory-bytes", available: Math.max(0, snapshot.capacityBudgetBytes - snapshot.reservedBytes), limit: snapshot.capacityBudgetBytes, queued: null, reserved: snapshot.reservedBytes, window: null, providerWindowId: null });
  return Object.freeze([concurrency, memory]);
}

function basisPoints(percentage: number | null): number | null {
  if (percentage === null) return null;
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) throw new TelemetryError("INVALID_OBSERVATION", "percentage-out-of-range");
  return Math.round(percentage * 100);
}

export function claudeUsageObservation(counts: ClaudeUsageCounts, sequence: number, context: TelemetryBridgeContext): TelemetryObservationDraft {
  const usage: NormalizedTokenUsage = Object.freeze({ uncachedInputTokens: counts.inputTokens, cacheWriteInputTokens: counts.cacheCreationInputTokens, cachedReadInputTokens: counts.cacheReadInputTokens, visibleOutputTokens: counts.outputTokens, reasoningTokens: 0, unknownCombinedTokens: 0, toolCalls: 0, categoryCompleteness: "exact" });
  return draft(context, `claude-usage-${sequence}`, "cumulative-usage", { usage, sequence, quality: "partial" });
}

export function claudeCapacityObservations(snapshot: ClaudeCapacitySnapshot, context: TelemetryBridgeContext): readonly TelemetryObservationDraft[] {
  const make = (name: "five-hour" | "seven-day", used: number | null, resetsAt: string | null): TelemetryObservationDraft => {
    const state = snapshot.status !== "known" ? snapshot.status
      : used === null ? "unknown"
        : used >= 100 ? "exhausted"
          : used > 0 ? "limited"
            : "available";
    return draft(context, `claude-${name}`, "quota-window", { state, dimension: "usage-percentage", window: name, providerWindowId: name, remaining: null, limit: null, usedBasisPoints: basisPoints(used), remainingBasisPoints: used === null ? null : 10_000 - basisPoints(used)!, durationMs: name === "five-hour" ? 18_000_000 : 604_800_000 }, { resetsAt, staleAt: snapshot.staleAt, confidence: snapshot.confidence === "none" ? "none" : snapshot.confidence === "derived" ? "medium" : "reported" });
  };
  return Object.freeze([make("five-hour", snapshot.fiveHour.usedPercentage, snapshot.fiveHour.resetsAt), make("seven-day", snapshot.sevenDay.usedPercentage, snapshot.sevenDay.resetsAt)]);
}

export function claudeTerminalObservations(observation: Extract<ClaudeObservation, { readonly kind: "operation-terminal" }>, context: TelemetryBridgeContext): readonly TelemetryObservationDraft[] {
  const usage: NormalizedTokenUsage = Object.freeze({ uncachedInputTokens: observation.inputTokens, cacheWriteInputTokens: 0, cachedReadInputTokens: observation.cachedInputTokens, visibleOutputTokens: observation.outputTokens, reasoningTokens: 0, unknownCombinedTokens: 0, toolCalls: observation.toolCalls, categoryCompleteness: "generic-four-category" });
  const costSemantic = observation.costSemantics === "billed-api-cost" ? "provider-billed" : observation.costSemantics === "subscription-equivalent-estimate" ? "subscription-equivalent-estimate" : "unknown";
  const component = costSemantic === "unknown" || observation.reportedCostMicros === null
    ? { componentId: "claude-cost-unknown", semanticClass: "unknown" as const, currency: null, amountMicros: null, authority: "none" as const, priceSourceFingerprint: null, priceEffectiveAt: null }
    : { componentId: "claude-reported", semanticClass: costSemantic as "provider-billed" | "subscription-equivalent-estimate", currency: "USD", amountMicros: observation.reportedCostMicros, authority: costSemantic === "provider-billed" ? "billing" as const : "planning" as const, priceSourceFingerprint: context.sourceFingerprint, priceEffectiveAt: context.pricingEffectiveAt };
  return Object.freeze([
    draft(context, "claude-terminal", "terminal-reconciliation", { usage, sequence: null, outcome: observation.category, quality: "complete" }, { terminalAt: context.terminalAt ?? context.observedAt }),
    draft(context, "claude-cost", "cost", { components: [component] }),
  ]);
}

export function codexRateLimitObservations(snapshot: CodexRateLimitSnapshot, context: TelemetryBridgeContext): readonly TelemetryObservationDraft[] {
  if (snapshot.status !== "reported") return Object.freeze([draft(context, `codex-${snapshot.status}`, "quota-window", { state: snapshot.status, dimension: "usage-percentage", window: "provider-defined", providerWindowId: null, remaining: null, limit: null, usedBasisPoints: null, remainingBasisPoints: null, durationMs: null })]);
  return Object.freeze(snapshot.windows.map((window, index) => draft(context, `codex-${window.window}-${index}`, "quota-window", { state: window.stale ? "stale" : window.usedPercent >= 100 ? "exhausted" : window.usedPercent > 0 ? "limited" : "available", dimension: "usage-percentage", window: window.window, providerWindowId: window.limitId, remaining: null, limit: null, usedBasisPoints: basisPoints(window.usedPercent), remainingBasisPoints: 10_000 - basisPoints(window.usedPercent)!, durationMs: window.durationMinutes === null ? null : window.durationMinutes * 60_000 }, { resetsAt: window.resetsAt, staleAt: window.stale ? context.observedAt : context.staleAt })));
}

export function codexAccountUsageObservations(snapshot: CodexAccountUsageSnapshot, context: TelemetryBridgeContext): readonly TelemetryObservationDraft[] {
  if (snapshot.status !== "reported") return Object.freeze([draft(context, `codex-account-${snapshot.status}`, "account-usage", { period: "lifetime", periodStart: null, tokens: null, status: snapshot.status })]);
  const result: TelemetryObservationDraft[] = [];
  if (snapshot.summary?.lifetimeTokens !== null && snapshot.summary?.lifetimeTokens !== undefined) result.push(draft(context, "codex-lifetime", "account-usage", { period: "lifetime", periodStart: null, tokens: snapshot.summary.lifetimeTokens, status: "reported" }));
  for (const bucket of snapshot.dailyBuckets ?? []) result.push(draft(context, `codex-day-${bucket.startDate.replaceAll("-", "")}`, "account-usage", { period: "daily", periodStart: bucket.startDate, tokens: bucket.tokens, status: "reported" }));
  return Object.freeze(result);
}

export function openAiObservationDrafts(observation: OpenAiObservation, context: TelemetryBridgeContext): readonly TelemetryObservationDraft[] {
  if (observation.kind === "operation") {
    const uncached = observation.inputTokens - observation.cachedInputTokens - observation.cacheWriteTokens;
    const visibleOutput = observation.outputTokens - observation.reasoningTokens;
    if (!Number.isSafeInteger(uncached) || uncached < 0 || !Number.isSafeInteger(visibleOutput) || visibleOutput < 0) throw new TelemetryError("INVALID_OBSERVATION", "openai-token-split-contradiction");
    const usage: NormalizedTokenUsage = Object.freeze({ uncachedInputTokens: uncached, cacheWriteInputTokens: observation.cacheWriteTokens, cachedReadInputTokens: observation.cachedInputTokens, visibleOutputTokens: visibleOutput, reasoningTokens: observation.reasoningTokens, unknownCombinedTokens: 0, toolCalls: observation.toolCalls, categoryCompleteness: "exact" });
    const cost = observation.costMicros === null || observation.costCurrency === null ? { componentId: "openai-cost-unknown", semanticClass: "unknown" as const, currency: null, amountMicros: null, authority: "none" as const, priceSourceFingerprint: null, priceEffectiveAt: null } : { componentId: "openai-computed", semanticClass: "locally-computed-estimate" as const, currency: observation.costCurrency, amountMicros: observation.costMicros, authority: "planning" as const, priceSourceFingerprint: context.sourceFingerprint, priceEffectiveAt: context.pricingEffectiveAt };
    return Object.freeze([draft(context, "openai-terminal", "terminal-reconciliation", { usage, sequence: null, outcome: observation.outcome, quality: "complete" }, { terminalAt: context.terminalAt ?? context.observedAt }), draft(context, "openai-cost", "cost", { components: [cost] })]);
  }
  if (observation.kind === "http") {
    const reset = observation.rateLimitResetMs === null ? null : new Date(Date.parse(context.observedAt) + observation.rateLimitResetMs).toISOString();
    return Object.freeze([draft(context, `openai-http-${observation.attempt}`, "quota-window", { state: observation.rateLimitRemaining === null ? "unknown" : observation.rateLimitRemaining === 0 ? "exhausted" : "available", dimension: "requests", window: "provider-defined", providerWindowId: observation.route.replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 128) || null, remaining: observation.rateLimitRemaining, limit: null, usedBasisPoints: null, remainingBasisPoints: null, durationMs: observation.rateLimitResetMs }, { resetsAt: reset })]);
  }
  return Object.freeze([]);
}

export function gatewayQuotaObservation(quota: RuntimeQuotaObservation, context: TelemetryBridgeContext): readonly TelemetryObservationDraft[] {
  const result: TelemetryObservationDraft[] = [];
  for (const [dimension, remaining] of [["requests", quota.requestsRemaining], ["tokens", quota.tokensRemaining]] as const) result.push(draft(context, `gateway-${dimension}`, "quota-window", { state: quota.state, dimension, window: "provider-defined", providerWindowId: null, remaining, limit: null, usedBasisPoints: null, remainingBasisPoints: null, durationMs: null }, { resetsAt: quota.resetsAt }));
  return Object.freeze(result);
}

export function gatewayRuntimeObservations(status: GatewayRuntimeStatus, context: TelemetryBridgeContext): readonly TelemetryObservationDraft[] {
  if (context.identity.configuredInstanceId !== status.instance.instanceId || (context.identity.catalogFingerprint !== null && context.identity.catalogFingerprint !== status.instance.catalog.catalogFingerprint)) throw new TelemetryError("IDENTITY_CONFLICT", "gateway-instance-provenance-mismatch");
  return Object.freeze([providerHealthObservation(status.health, context), ...gatewayQuotaObservation(status.quota, context)]);
}
