import { describe, expect, it } from "vitest";
import type { ClaudeCapacitySnapshot, ClaudeObservation, ClaudeUsageCounts } from "@ai-dev-os/provider-claude-code";
import type { CodexAccountUsageSnapshot, CodexRateLimitSnapshot } from "@ai-dev-os/provider-codex";
import type { GatewayRuntimeStatus } from "@ai-dev-os/provider-gateway";
import type { OllamaCapacitySnapshot, OllamaObservation } from "@ai-dev-os/provider-ollama";
import type { OpenAiObservation } from "@ai-dev-os/provider-openai";
import type { InferenceEvent, InferenceResult } from "@ai-dev-os/providers";
import {
  DEFAULT_TELEMETRY_LEDGER_CONFIGURATION,
  TelemetryError,
  currentEffectiveObservation,
  forecastCapacity,
} from "../src/index.js";
import {
  claudeCapacityObservations,
  claudeTerminalObservations,
  claudeUsageObservation,
  codexAccountUsageObservations,
  codexRateLimitObservations,
  gatewayQuotaObservation,
  gatewayRuntimeObservations,
  genericProviderEventObservation,
  genericRateLimitObservation,
  genericTerminalObservations,
  ollamaCapacityObservations,
  ollamaObservationDrafts,
  openAiObservationDrafts,
  providerHealthObservation,
} from "../src/providers.js";
import { bridgeContext, IDENTITY, LATER, makeDraft, materialize, NOW } from "./helpers.js";

function quota(id: string, observedAt: string, remaining: number, resetsAt = "2026-01-02T05:00:00.000Z") {
  return materialize(makeDraft("quota-window", { state: remaining === 0 ? "exhausted" : "limited", dimension: "requests", window: "fixed", providerWindowId: "window-1", remaining, limit: 100, usedBasisPoints: null, remainingBasisPoints: null, durationMs: 3_600_000 }, { observationId: id, operationId: null, observedAt, resetsAt, staleAt: "2026-01-03T00:00:00.000Z" }));
}

describe("capacity derivation", () => {
  it("uses fixed-point burn and bounded deterministic confidence", () => {
    const samples = [quota("q1", "2026-01-02T03:00:00.000Z", 100), quota("q2", "2026-01-02T03:10:00.000Z", 90), quota("q3", "2026-01-02T03:20:00.000Z", 80)];
    const forecast = forecastCapacity(samples, { now: "2026-01-02T03:20:00.000Z", configuration: DEFAULT_TELEMETRY_LEDGER_CONFIGURATION });
    expect(forecast).toMatchObject({ status: "available", sampleCount: 3, confidence: "medium", burnUnitsPerMillionMs: 16 });
    expect(forecast.estimatedExhaustionAt).toBe("2026-01-02T04:40:00.000Z");
  });

  it("refuses incomparable, insufficient, non-burning, reset-crossing, and out-of-horizon samples", () => {
    expect(forecastCapacity([quota("q1", NOW, 100)], { now: NOW, configuration: DEFAULT_TELEMETRY_LEDGER_CONFIGURATION }).unavailableReason).toBe("insufficient-samples");
    expect(forecastCapacity([quota("q1", NOW, 100), quota("q2", LATER, 100)], { now: LATER, configuration: DEFAULT_TELEMETRY_LEDGER_CONFIGURATION }).unavailableReason).toBe("nonpositive-burn");
    expect(forecastCapacity([quota("q1", "2026-01-02T03:00:00.000Z", 100), quota("q2", "2026-01-02T03:01:00.000Z", 80), quota("q3", "2026-01-02T03:02:00.000Z", 90)], { now: "2026-01-02T03:02:00.000Z", configuration: DEFAULT_TELEMETRY_LEDGER_CONFIGURATION }).unavailableReason).toBe("non-monotonic-samples");
    const otherIdentity = quota("other", LATER, 90); const changed = { ...otherIdentity, identity: { ...otherIdentity.identity, configuredInstanceId: "instance-2" } };
    expect(forecastCapacity([quota("q1", NOW, 100), changed], { now: LATER, configuration: DEFAULT_TELEMETRY_LEDGER_CONFIGURATION }).unavailableReason).toBe("incomparable-samples");
    expect(forecastCapacity([quota("q1", NOW, 100), quota("q2", LATER, 90, "2026-01-03T05:00:00.000Z")], { now: LATER, configuration: DEFAULT_TELEMETRY_LEDGER_CONFIGURATION }).unavailableReason).toBe("insufficient-samples");
    const short = { ...DEFAULT_TELEMETRY_LEDGER_CONFIGURATION, forecast: { ...DEFAULT_TELEMETRY_LEDGER_CONFIGURATION.forecast, horizonMs: 1_000 } };
    expect(forecastCapacity([quota("q1", NOW, 100), quota("q2", LATER, 99)], { now: LATER, configuration: short }).unavailableReason).toBe("outside-forecast-horizon");
  });

  it("uses authority, freshness, and stable identity without averaging windows", () => {
    const old = quota("old", NOW, 80);
    const current = quota("current", LATER, 70);
    const stale = { ...current, observationId: "stale", staleAt: NOW, source: { category: "provider-api" as const, sourceObservationId: "stale" } };
    expect(currentEffectiveObservation([old, current, stale], LATER)?.observationId).toBe("current");
    const expired = { ...current, observationId: "expired", effectiveUntil: LATER, source: { category: "provider-reported" as const, sourceObservationId: "expired" } };
    const future = { ...current, observationId: "future", effectiveFrom: "2026-01-02T03:06:05.000Z", source: { category: "provider-reported" as const, sourceObservationId: "future" } };
    expect(currentEffectiveObservation([old, expired, future], LATER)?.observationId).toBe("old");
    expect(currentEffectiveObservation([], NOW)).toBeNull();
  });
});

describe("released provider bridges", () => {
  it("maps generic cumulative events, terminal results, health, and rate-limit facts", () => {
    const usage = { tokens: { inputTokens: 3, cachedInputTokens: 2, outputTokens: 4, reasoningTokens: 1 }, toolCalls: 1 };
    const event = { kind: "usage-update", operationId: "operation-1", sequence: 7, payload: { usage } } as unknown as InferenceEvent;
    expect(genericProviderEventObservation(event, bridgeContext())).toMatchObject({ kind: "cumulative-usage", data: { sequence: 7, usage: { uncachedInputTokens: 3, cachedReadInputTokens: 2 } } });
    const result = { operationId: "operation-1", usage, cost: { providerReported: { currency: "USD", amountMicros: 10 }, locallyComputed: { currency: "USD", amountMicros: 8 } }, latency: { firstEventMs: 1, totalMs: 2 } } as unknown as InferenceResult;
    expect(genericTerminalObservations(result, "succeeded", bridgeContext()).map((item) => item.kind)).toEqual(["terminal-reconciliation", "cost"]);
    expect(genericRateLimitObservation({ retryAfterMs: 1_000, limit: 10, remaining: 0, resetsAt: LATER }, bridgeContext()).data).toMatchObject({ state: "exhausted", remaining: 0 });
    expect(providerHealthObservation({ status: "ready", checkedAt: NOW, detailCode: null, activeOperations: 0 }, bridgeContext()).data).toMatchObject({ state: "healthy" });
    expect(genericProviderEventObservation({ kind: "warning" } as unknown as InferenceEvent, bridgeContext())).toBeNull();
    expect(genericRateLimitObservation({ retryAfterMs: null, limit: null, remaining: null, resetsAt: null }, bridgeContext()).data).toMatchObject({ state: "unknown" });
    expect(genericRateLimitObservation({ retryAfterMs: null, limit: 10, remaining: 5, resetsAt: null }, bridgeContext()).data).toMatchObject({ state: "limited" });
    expect(providerHealthObservation({ status: "degraded", checkedAt: NOW, detailCode: null, activeOperations: 0 }, bridgeContext()).data).toMatchObject({ state: "degraded" });
    expect(providerHealthObservation({ status: "closed", checkedAt: NOW, detailCode: null, activeOperations: 0 }, bridgeContext()).data).toMatchObject({ state: "unavailable" });
    const unknownResult = { ...result, cost: { providerReported: null, locallyComputed: null } } as unknown as InferenceResult;
    expect(genericTerminalObservations(unknownResult, "failed", bridgeContext())[1]).toMatchObject({ data: { components: [{ semanticClass: "unknown" }] } });
  });

  it("preserves Claude cache creation, subscription estimates, and distinct windows", () => {
    const counts: ClaudeUsageCounts = { inputTokens: 3, cacheCreationInputTokens: 2, cacheReadInputTokens: 4, outputTokens: 5 };
    expect(claudeUsageObservation(counts, 1, bridgeContext()).data).toMatchObject({ usage: { uncachedInputTokens: 3, cacheWriteInputTokens: 2, cachedReadInputTokens: 4 } });
    const capacity: ClaudeCapacitySnapshot = { status: "known", source: "host-supplied-status-snapshot", confidence: "reported", fiveHour: { usedPercentage: 25.5, resetsAt: LATER }, sevenDay: { usedPercentage: 75, resetsAt: "2026-01-09T00:00:00.000Z" }, observedAt: NOW, staleAt: LATER, model: "model-1", effort: null };
    expect(claudeCapacityObservations(capacity, bridgeContext()).map((item) => [item.data.window, item.data.usedBasisPoints])).toEqual([["five-hour", 2550], ["seven-day", 7500]]);
    expect(claudeCapacityObservations(capacity, bridgeContext()).map((item) => item.data.state)).toEqual(["limited", "limited"]);
    expect(claudeCapacityObservations({ ...capacity, fiveHour: { ...capacity.fiveHour, usedPercentage: 100 }, sevenDay: { ...capacity.sevenDay, usedPercentage: 0 } }, bridgeContext()).map((item) => item.data.state)).toEqual(["exhausted", "available"]);
    const terminal = { kind: "operation-terminal", category: "succeeded", inputTokens: 3, outputTokens: 4, cachedInputTokens: 1, toolCalls: 0, costSemantics: "subscription-equivalent-estimate", reportedCostMicros: 9 } as unknown as Extract<ClaudeObservation, { kind: "operation-terminal" }>;
    expect(claudeTerminalObservations(terminal, bridgeContext())[1]).toMatchObject({ kind: "cost", data: { components: [{ semanticClass: "subscription-equivalent-estimate" }] } });
    expect(claudeTerminalObservations({ ...terminal, costSemantics: "billed-api-cost" }, bridgeContext())[1]).toMatchObject({ data: { components: [{ semanticClass: "provider-billed", authority: "billing" }] } });
    expect(claudeTerminalObservations({ ...terminal, costSemantics: "unknown", reportedCostMicros: null }, bridgeContext())[1]).toMatchObject({ data: { components: [{ semanticClass: "unknown" }] } });
    const unknownCapacity: ClaudeCapacitySnapshot = { ...capacity, status: "unknown", confidence: "none", fiveHour: { usedPercentage: null, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null } };
    expect(claudeCapacityObservations(unknownCapacity, bridgeContext())[0]).toMatchObject({ confidence: "none", data: { state: "unknown", usedBasisPoints: null } });
    expect(claudeCapacityObservations({ ...capacity, confidence: "derived" }, bridgeContext())[0]).toMatchObject({ confidence: "medium" });
    expect(() => claudeCapacityObservations({ ...capacity, fiveHour: { ...capacity.fiveHour, usedPercentage: 101 } }, bridgeContext())).toThrowError(TelemetryError);
  });

  it("keeps Codex primary/secondary, unsupported, and overlap-safe daily snapshots distinct", () => {
    const rates: CodexRateLimitSnapshot = { status: "reported", resetCreditsAvailable: null, observedAt: NOW, windows: [
      { limitId: "main", limitName: null, window: "primary", usedPercent: 10, durationMinutes: 300, resetsAt: LATER, planType: "plus", credits: null, observedAt: NOW, stale: false, source: "account/rateLimits/read" },
      { limitId: "main", limitName: null, window: "secondary", usedPercent: 90, durationMinutes: 10_080, resetsAt: LATER, planType: "plus", credits: null, observedAt: NOW, stale: false, source: "account/rateLimits/read" },
    ] };
    expect(codexRateLimitObservations(rates, bridgeContext()).map((item) => item.data.window)).toEqual(["primary", "secondary"]);
    expect(codexRateLimitObservations({ status: "unsupported", windows: [], resetCreditsAvailable: null, observedAt: NOW }, bridgeContext())[0]).toMatchObject({ data: { state: "unsupported" } });
    const account: CodexAccountUsageSnapshot = { status: "reported", observedAt: NOW, summary: { lifetimeTokens: 100, peakDailyTokens: 10, longestRunningTurnSeconds: null, currentStreakDays: null, longestStreakDays: null }, dailyBuckets: [{ startDate: "2026-01-01", tokens: 10 }, { startDate: "2026-01-02", tokens: 20 }] };
    const drafts = codexAccountUsageObservations(account, bridgeContext());
    expect(drafts.map((item) => item.observationId)).toHaveLength(new Set(drafts.map((item) => item.observationId)).size);
    expect(drafts.map((item) => item.kind)).toEqual(["account-usage", "account-usage", "account-usage"]);
    expect(codexAccountUsageObservations({ status: "unsupported", observedAt: NOW, summary: null, dailyBuckets: null }, bridgeContext())[0]).toMatchObject({ data: { status: "unsupported", tokens: null } });
    expect(codexAccountUsageObservations({ status: "reported", observedAt: NOW, summary: null, dailyBuckets: null }, bridgeContext())).toEqual([]);
    const edgeRates: CodexRateLimitSnapshot = { ...rates, windows: [
      { ...rates.windows[0]!, usedPercent: 0, durationMinutes: null },
      { ...rates.windows[1]!, usedPercent: 100, stale: true },
    ] };
    expect(codexRateLimitObservations(edgeRates, bridgeContext()).map((item) => item.data.state)).toEqual(["available", "stale"]);
  });

  it("maps OpenAI exact cache-write usage and refuses impossible splits", () => {
    const operation: OpenAiObservation = { kind: "operation", modelId: "model-1", outcome: "succeeded", errorCode: null, executionMode: "synchronous", inputTokens: 10, cachedInputTokens: 3, cacheWriteTokens: 2, outputTokens: 8, reasoningTokens: 2, toolCalls: 1, costMicros: 5, costCurrency: "USD", pricingSource: "catalog", totalMs: 100 };
    expect(openAiObservationDrafts(operation, bridgeContext())[0]).toMatchObject({ data: { usage: { uncachedInputTokens: 5, cacheWriteInputTokens: 2, cachedReadInputTokens: 3, visibleOutputTokens: 6 } } });
    expect(() => openAiObservationDrafts({ ...operation, cacheWriteTokens: 8 }, bridgeContext())).toThrowError(TelemetryError);
    const http: OpenAiObservation = { kind: "http", route: "responses", status: 429, requestId: null, rateLimitRemaining: 0, rateLimitResetMs: 60_000, retryAfterMs: 1_000, serviceTier: null, attempt: 1 };
    expect(openAiObservationDrafts(http, bridgeContext())[0]).toMatchObject({ data: { state: "exhausted" }, resetsAt: LATER });
    expect(openAiObservationDrafts({ ...http, rateLimitRemaining: null, rateLimitResetMs: null }, bridgeContext())[0]).toMatchObject({ data: { state: "unknown" }, resetsAt: null });
    expect(openAiObservationDrafts({ ...http, rateLimitRemaining: 2 }, bridgeContext())[0]).toMatchObject({ data: { state: "available" } });
    expect(openAiObservationDrafts({ kind: "catalog", catalogVersion: "1", catalogFingerprint: "0".repeat(64), offeredModelCount: 1 }, bridgeContext())).toEqual([]);
  });

  it("keeps Ollama local cost unknown and maps actual capacity", () => {
    const operation = { kind: "operation", model: "local-model", outcome: "succeeded", errorCode: null, inputTokens: 2, outputTokens: 3, totalDurationMs: 1, loadDurationMs: 1, promptEvalDurationMs: 1, evalDurationMs: 1 } satisfies OllamaObservation;
    expect(ollamaObservationDrafts(operation, bridgeContext())[1]).toMatchObject({ kind: "cost", data: { components: [{ semanticClass: "unknown" }] } });
    const snapshot: OllamaCapacitySnapshot = { activeOperations: 1, queuedOperations: 2, activeByModel: [], reservedBytes: 40, capacityBudgetBytes: 100, capacitySafetyMarginBytes: 10, closed: false };
    expect(ollamaCapacityObservations(snapshot, bridgeContext())[1]).toMatchObject({ data: { dimension: "memory-bytes", available: 60, limit: 100 } });
    expect(ollamaObservationDrafts({ kind: "health-check", category: "overloaded", serverReachable: true, apiCompatible: true }, bridgeContext())[0]).toMatchObject({ data: { state: "degraded" } });
    expect(ollamaObservationDrafts({ kind: "admission", category: "rejected", model: "model", errorCode: "OVERLOADED" }, bridgeContext())[0]).toMatchObject({ data: { state: "limited" } });
    expect(ollamaObservationDrafts({ kind: "residency", action: "load", model: "model", category: "applied" }, bridgeContext())).toEqual([]);
    expect(ollamaCapacityObservations({ ...snapshot, queuedOperations: 0, closed: true, capacityBudgetBytes: null }, bridgeContext())).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ state: "unavailable" }) }),
      expect.objectContaining({ data: expect.objectContaining({ state: "unknown" }) }),
    ]);
    expect(ollamaCapacityObservations({ ...snapshot, reservedBytes: 100 }, bridgeContext())[1]).toMatchObject({ data: { state: "exhausted", available: 0 } });
  });

  it("maps gateway quota without turning catalog claims into capacity and checks instance provenance", () => {
    expect(gatewayQuotaObservation({ schemaVersion: 1, state: "unknown", checkedAt: NOW, source: "unobserved", requestsRemaining: null, tokensRemaining: null, resetsAt: null, detailCode: null }, bridgeContext())).toHaveLength(2);
    const status = { instance: { instanceId: "other", catalog: { catalogFingerprint: "0".repeat(64) } }, health: { status: "ready", checkedAt: NOW, detailCode: null, activeOperations: 0 }, quota: { schemaVersion: 1, state: "unknown", checkedAt: NOW, source: "unobserved", requestsRemaining: null, tokensRemaining: null, resetsAt: null, detailCode: null } } as unknown as GatewayRuntimeStatus;
    expect(() => gatewayRuntimeObservations(status, bridgeContext({ identity: IDENTITY }))).toThrowError(TelemetryError);
    const matching = { ...status, instance: { ...status.instance, instanceId: "instance-1" } } as GatewayRuntimeStatus;
    expect(gatewayRuntimeObservations(matching, bridgeContext())).toHaveLength(3);
  });
});
