import { describe, expect, it } from "vitest";
import {
  DEFAULT_TELEMETRY_LEDGER_CONFIGURATION,
  createTelemetryObservation,
  deterministicPartition,
  observationPayloadFingerprint,
  parseNormalizedTokenUsage,
  parseTelemetryLedgerConfiguration,
  parseTelemetryLedgerExtension,
  parseTelemetryObservation,
  telemetryLedgerConfigurationFingerprint,
  telemetrySnapshotFingerprint,
} from "../src/index.js";
import { makeDraft, materialize, NOW, usage } from "./helpers.js";

describe("telemetry schemas and configuration", () => {
  it("strictly parses and deeply freezes every persisted envelope", () => {
    const observation = materialize(makeDraft("cumulative-usage", { usage: usage(2), sequence: 1, quality: "partial" }));
    expect(parseTelemetryObservation(observation)).toEqual(observation);
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.data)).toBe(true);
    expect(observationPayloadFingerprint(observation)).toBe(observation.canonicalPayloadFingerprint);
    expect(() => parseTelemetryObservation({ ...observation, prompt: "armed-canary" })).toThrow(/unexpected fields/u);
    expect(() => parseTelemetryObservation({ ...observation, canonicalPayloadFingerprint: "0".repeat(64) })).toThrow(/fingerprint/u);
  });

  it("refuses unsafe token totals, bad cost semantics, and correction link mismatches", () => {
    expect(() => parseNormalizedTokenUsage({ ...usage(), uncachedInputTokens: Number.MAX_SAFE_INTEGER, visibleOutputTokens: 1 })).toThrow(/safe integer/u);
    const badCost = makeDraft("cost", { components: [{ componentId: "bad", semanticClass: "unknown", currency: "USD", amountMicros: 1, authority: "none", priceSourceFingerprint: null, priceEffectiveAt: null }] });
    expect(() => materialize(badCost)).toThrow(/unknown costs/u);
    const correction = makeDraft("correction", { action: "supersede", targetObservationId: "old", reasonCode: "provider-correction" }, { correctedObservationId: "different" });
    expect(() => materialize(correction)).toThrow(/linkage/u);
  });

  it("derives bounded deterministic partitions even for maximum-length ledger ids", () => {
    const one = deterministicPartition("l".repeat(128), NOW, 86_400_000);
    const two = deterministicPartition("l".repeat(128), NOW, 86_400_000);
    expect(one).toEqual(two);
    expect(one.partitionId.length).toBeLessThanOrEqual(128);
    expect(one.start < NOW && one.end > NOW).toBe(true);
  });

  it("parses the Stage 6 extension seam and fingerprints canonical config", () => {
    const parsed = parseTelemetryLedgerConfiguration(DEFAULT_TELEMETRY_LEDGER_CONFIGURATION);
    expect(parseTelemetryLedgerExtension({ namespace: "telemetry-ledger", schemaVersion: 1, value: parsed })).toEqual(parsed);
    expect(telemetryLedgerConfigurationFingerprint(parsed)).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => parseTelemetryLedgerConfiguration({ ...parsed, surprise: true })).toThrow(/unexpected/u);
    expect(() => parseTelemetryLedgerConfiguration({ ...parsed, maximumIdempotencyRecordsPerPartition: 1, maximumObservationsPerPartition: 2 })).toThrow(/safe integer/u);
  });

  it("fingerprints key order canonically and rejects unsupported observation versions", () => {
    expect(telemetrySnapshotFingerprint({ b: 2, a: 1 })).toBe(telemetrySnapshotFingerprint({ a: 1, b: 2 }));
    const draft = makeDraft("operation-estimate", { usage: usage(), reservationId: null });
    const partition = deterministicPartition(draft.ledgerId, draft.observedAt, 86_400_000);
    const observation = createTelemetryObservation(draft, { partitionId: partition.partitionId, ingestedAt: NOW });
    expect(() => parseTelemetryObservation({ ...observation, schemaVersion: 2 })).toThrow(/unsupported/u);
  });

  it("runtime-validates every finite observation variant and populated provenance field", () => {
    const populated = {
      traceId: "trace-populated", parentOperationId: "parent-operation", effectiveFrom: NOW,
      effectiveUntil: "2026-01-02T04:00:00.000Z", resetsAt: "2026-01-02T05:00:00.000Z",
      staleAt: "2026-01-02T06:00:00.000Z", terminalAt: "2026-01-02T04:00:00.000Z",
      previousObservationId: "previous", detailCodes: ["detail-one"],
      identity: { ...makeDraft("provider-health", { state: "healthy", latencyMs: null }).identity, catalogFingerprint: "1".repeat(64), providerFingerprint: "2".repeat(64), modelFingerprint: "3".repeat(64) },
      provenance: { sourceFingerprint: "4".repeat(64), pricingSource: "catalog-v1", pricingEffectiveAt: NOW, derivation: "derived-from-samples", sampleObservationIds: ["sample-1"] },
    };
    const values = [
      makeDraft("terminal-reconciliation", { usage: usage(3), sequence: 2, outcome: "failed", quality: "partial" }, { ...populated, observationId: "terminal" }),
      makeDraft("cost", { components: [
        { componentId: "zero", semanticClass: "verified-zero", currency: "USD", amountMicros: 0, authority: "evidence", priceSourceFingerprint: "5".repeat(64), priceEffectiveAt: NOW },
        { componentId: "subscription", semanticClass: "subscription-equivalent-estimate", currency: "GBP", amountMicros: 7, authority: "planning", priceSourceFingerprint: "6".repeat(64), priceEffectiveAt: NOW },
      ] }, { ...populated, observationId: "cost" }),
      makeDraft("provider-health", { state: "degraded", latencyMs: 9 }, { ...populated, observationId: "health", operationId: null }),
      makeDraft("quota-window", { state: "limited", dimension: "tokens", window: "rolling", providerWindowId: "window", remaining: 5, limit: 10, usedBasisPoints: 5_000, remainingBasisPoints: 5_000, durationMs: 60_000 }, { ...populated, observationId: "quota", operationId: null }),
      makeDraft("capacity", { state: "available", dimension: "memory-bytes", available: 5, limit: 10, queued: 1, reserved: 4, window: "fixed", providerWindowId: "memory" }, { ...populated, observationId: "capacity", operationId: null }),
      makeDraft("derived-state", { stateFingerprint: "7".repeat(64), throughEventId: "event-1", eventCount: 3 }, { ...populated, observationId: "derived", operationId: null }),
      makeDraft("forecast", { status: "available", dimension: "requests", window: "daily", providerWindowId: "daily", estimatedExhaustionAt: "2026-01-02T07:00:00.000Z", estimatedPostResetAvailableAt: "2026-01-03T00:00:00.000Z", burnUnitsPerMillionMs: 5, sampleCount: 3, sampleFrom: NOW, sampleTo: "2026-01-02T04:00:00.000Z", confidence: "medium", unavailableReason: null }, { ...populated, observationId: "forecast", operationId: null }),
      makeDraft("account-usage", { period: "daily", periodStart: "2026-01-02", tokens: 42, status: "reported" }, { ...populated, observationId: "account", operationId: null }),
    ];
    for (const value of values) expect(parseTelemetryObservation(materialize(value))).toEqual(materialize(value));
  });

  it("rejects contradictory quota, capacity, forecast, account, cost, and provenance variants", () => {
    expect(() => materialize(makeDraft("quota-window", { state: "limited", dimension: "tokens", window: "fixed", providerWindowId: null, remaining: 11, limit: 10, usedBasisPoints: null, remainingBasisPoints: null, durationMs: null }))).toThrow(/remaining/u);
    expect(() => materialize(makeDraft("capacity", { state: "available", dimension: "concurrency", available: 2, limit: 1, queued: null, reserved: null, window: null, providerWindowId: null }))).toThrow(/available/u);
    expect(() => materialize(makeDraft("forecast", { status: "available", dimension: "tokens", window: "daily", providerWindowId: null, estimatedExhaustionAt: null, estimatedPostResetAvailableAt: null, burnUnitsPerMillionMs: null, sampleCount: 0, sampleFrom: null, sampleTo: null, confidence: "none", unavailableReason: "missing" }))).toThrow(/contradictory/u);
    expect(() => materialize(makeDraft("account-usage", { period: "lifetime", periodStart: null, tokens: 1, status: "unsupported" }))).toThrow(/reported usage/u);
    expect(() => materialize(makeDraft("cost", { components: [] }))).toThrow(/non-empty/u);
    expect(() => materialize(makeDraft("cost", { components: [{ componentId: "zero", semanticClass: "verified-zero", currency: "USD", amountMicros: 1, authority: "evidence", priceSourceFingerprint: null, priceEffectiveAt: null }] }))).toThrow(/zero/u);
    expect(() => materialize(makeDraft("provider-health", { state: "healthy", latencyMs: null }, { detailCodes: ["same", "same"] }))).toThrow(/unique/u);
    expect(() => materialize(makeDraft("provider-health", { state: "healthy", latencyMs: null }, { provenance: { sourceFingerprint: "1".repeat(64), pricingSource: null, pricingEffectiveAt: null, derivation: null, sampleObservationIds: ["same", "same"] } }))).toThrow(/unique/u);
    expect(() => materialize(makeDraft("provider-health", { state: "healthy", latencyMs: null }, { effectiveFrom: "2026-01-03T00:00:00.000Z", effectiveUntil: NOW }))).toThrow(/effective interval/u);
    expect(() => materialize(makeDraft("provider-health", { state: "healthy", latencyMs: null }, { staleAt: "2026-01-01T00:00:00.000Z" }))).toThrow(/stale time/u);
  });

  it("rejects duplicate configuration values and wrong extension/schema identities", () => {
    expect(() => parseTelemetryLedgerConfiguration({ ...DEFAULT_TELEMETRY_LEDGER_CONFIGURATION, schemaVersion: 2 })).toThrow(/released/u);
    expect(() => parseTelemetryLedgerConfiguration({ ...DEFAULT_TELEMETRY_LEDGER_CONFIGURATION, acceptedCurrencies: ["USD", "USD"] })).toThrow(/duplicates/u);
    expect(() => parseTelemetryLedgerConfiguration({ ...DEFAULT_TELEMETRY_LEDGER_CONFIGURATION, acceptedCostSemantics: ["unknown", "unknown"] })).toThrow(/duplicates/u);
    expect(() => parseTelemetryLedgerConfiguration({ ...DEFAULT_TELEMETRY_LEDGER_CONFIGURATION, enabledBridges: ["generic", "generic"] })).toThrow(/duplicates/u);
    expect(() => parseTelemetryLedgerExtension({ namespace: "other", schemaVersion: 1, value: DEFAULT_TELEMETRY_LEDGER_CONFIGURATION })).toThrow(/extension/u);
  });
});
