import { describe, expect, it } from "vitest";
import {
  TelemetryError,
  activeTelemetryObservations,
  addNormalizedUsage,
  costVariance,
  queryCostSummary,
  queryUsageSummary,
  reconcileOperationTelemetry,
  telemetrySnapshotFingerprint,
} from "../src/index.js";
import { LATER, makeDraft, materialize, NOW, usage } from "./helpers.js";

describe("operation reconciliation", () => {
  it("replaces cumulative snapshots and reconciles terminal usage without double counting", () => {
    const estimate = materialize(makeDraft("operation-estimate", { usage: usage(10, 2), reservationId: "reservation-1" }, { observationId: "estimate" }));
    const stream1 = materialize(makeDraft("cumulative-usage", { usage: usage(2, 1), sequence: 1, quality: "partial" }, { observationId: "stream-1" }));
    const stream2 = materialize(makeDraft("cumulative-usage", { usage: usage(5, 2), sequence: 2, quality: "partial" }, { observationId: "stream-2", observedAt: LATER }));
    const terminal = materialize(makeDraft("terminal-reconciliation", { usage: usage(5, 2), sequence: 3, outcome: "succeeded", quality: "complete" }, { observationId: "terminal", observedAt: "2026-01-02T03:06:05.000Z", terminalAt: "2026-01-02T03:06:05.000Z" }));
    const result = reconcileOperationTelemetry([estimate, stream1, stream2, terminal]);
    expect(result.estimate?.uncachedInputTokens).toBe(10);
    expect(result.actual?.uncachedInputTokens).toBe(5);
    expect(result.actualQuality).toBe("complete");
    expect(result.outcome).toBe("succeeded");
  });

  it("preserves the no-double-counting invariant across bounded generated cumulative streams", () => {
    for (let seed = 1; seed <= 64; seed += 1) {
      const sampleCount = 2 + seed % 6;
      let total = seed % 11;
      const observations: ReturnType<typeof materialize>[] = [];
      for (let sequence = 1; sequence <= sampleCount; sequence += 1) {
        total += (seed * sequence) % 13 + 1;
        observations.push(materialize(makeDraft("cumulative-usage", { usage: usage(total, sequence), sequence, quality: sequence === sampleCount ? "complete" : "partial" }, {
          observationId: `property-${seed}-${sequence}`,
          observedAt: new Date(Date.parse(NOW) + sequence * 1_000).toISOString(),
        })));
      }
      observations.push(materialize(makeDraft("terminal-reconciliation", { usage: usage(total, sampleCount), sequence: sampleCount + 1, outcome: "succeeded", quality: "complete" }, {
        observationId: `property-${seed}-terminal`,
        observedAt: new Date(Date.parse(NOW) + (sampleCount + 1) * 1_000).toISOString(),
        terminalAt: new Date(Date.parse(NOW) + (sampleCount + 1) * 1_000).toISOString(),
      })));
      const result = reconcileOperationTelemetry(observations);
      expect(result.actual?.uncachedInputTokens, `seed=${seed}`).toBe(total);
      expect(result.actual?.visibleOutputTokens, `seed=${seed}`).toBe(sampleCount);
    }
  });

  it("fails closed on category regression, repeated sequence, terminal contradiction, and identity change", () => {
    const first = materialize(makeDraft("cumulative-usage", { usage: usage(5), sequence: 1, quality: "partial" }, { observationId: "one" }));
    const regressed = materialize(makeDraft("cumulative-usage", { usage: usage(4), sequence: 2, quality: "partial" }, { observationId: "two", observedAt: LATER }));
    expect(() => reconcileOperationTelemetry([first, regressed])).toThrowError(TelemetryError);
    const sameSequence = materialize(makeDraft("cumulative-usage", { usage: usage(6), sequence: 1, quality: "partial" }, { observationId: "same", observedAt: LATER }));
    expect(() => reconcileOperationTelemetry([first, sameSequence])).toThrow(/failed/u);
    const terminal = materialize(makeDraft("terminal-reconciliation", { usage: usage(3), sequence: 2, outcome: "failed", quality: "partial" }, { observationId: "terminal", observedAt: LATER }));
    expect(() => reconcileOperationTelemetry([first, terminal])).toThrow(/failed/u);
    const changed = materialize(makeDraft("cumulative-usage", { usage: usage(6), sequence: 2, quality: "partial" }, { observationId: "changed", observedAt: LATER, identity: { ...first.identity, upstreamModelId: "other-model" } }));
    expect(() => reconcileOperationTelemetry([first, changed])).toThrow(/failed/u);
  });

  it("retains partial consumption when terminal usage is missing", () => {
    const stream = materialize(makeDraft("cumulative-usage", { usage: usage(4), sequence: 1, quality: "partial" }, { observationId: "stream" }));
    const terminal = materialize(makeDraft("terminal-reconciliation", { usage: null, sequence: null, outcome: "cancelled", quality: "missing" }, { observationId: "terminal", observedAt: LATER }));
    expect(reconcileOperationTelemetry([stream, terminal])).toMatchObject({ actual: { uncachedInputTokens: 4 }, actualQuality: "partial", outcome: "cancelled" });
  });

  it("deduplicates generic and exact views by explicit source identity and fingerprint", () => {
    const sourceFingerprint = telemetrySnapshotFingerprint({ upstream: "one" });
    const common = { source: { category: "provider-reported" as const, sourceObservationId: "same-source" }, provenance: { sourceFingerprint, pricingSource: null, pricingEffectiveAt: null, derivation: null, sampleObservationIds: [] } };
    const generic = materialize(makeDraft("cumulative-usage", { usage: usage(5, 2, "generic-four-category"), sequence: 1, quality: "partial" }, { observationId: "generic", ...common }));
    const exact = materialize(makeDraft("cumulative-usage", { usage: { ...usage(4, 2), cacheWriteInputTokens: 1 }, sequence: 1, quality: "partial" }, { observationId: "exact", ...common }));
    const result = reconcileOperationTelemetry([generic, exact]);
    expect(result.actual).toMatchObject({ uncachedInputTokens: 4, cacheWriteInputTokens: 1, categoryCompleteness: "exact" });
    const conflicting = materialize(makeDraft("cumulative-usage", { usage: usage(6), sequence: 1, quality: "partial" }, { observationId: "conflict", source: common.source }));
    expect(() => reconcileOperationTelemetry([generic, conflicting])).toThrow(/failed/u);
    const estimate = materialize(makeDraft("operation-estimate", { usage: usage(20), reservationId: null }, { observationId: "estimate-same-source", ...common }));
    expect(reconcileOperationTelemetry([estimate, exact])).toMatchObject({ estimate: { uncachedInputTokens: 20 }, actual: { uncachedInputTokens: 4 } });
  });

  it("applies linked corrections without rewriting historical evidence", () => {
    const old = materialize(makeDraft("cumulative-usage", { usage: usage(9), sequence: 1, quality: "partial" }, { observationId: "old" }));
    const correction = materialize(makeDraft("correction", { action: "supersede", targetObservationId: "old", reasonCode: "provider-correction" }, { observationId: "correction", operationId: "operation-1", correctedObservationId: "old" }));
    const replacement = materialize(makeDraft("cumulative-usage", { usage: usage(3), sequence: 1, quality: "complete" }, { observationId: "replacement", previousObservationId: "old", observedAt: LATER }));
    expect(activeTelemetryObservations([old, correction, replacement]).map((item) => item.observationId)).toEqual(["replacement"]);
    expect(reconcileOperationTelemetry([old, correction, replacement]).actual?.uncachedInputTokens).toBe(3);
  });

  it("refuses exact usage overflow", () => {
    expect(() => addNormalizedUsage({ ...usage(), uncachedInputTokens: Number.MAX_SAFE_INTEGER }, usage())).toThrow(/failed/u);
  });
});

describe("cost and usage summaries", () => {
  it("keeps billed and computed semantics separate and marks known plus unknown partial", () => {
    const cost = materialize(makeDraft("cost", { components: [
      { componentId: "bill", semanticClass: "provider-billed", currency: "USD", amountMicros: 10, authority: "billing", priceSourceFingerprint: null, priceEffectiveAt: null },
      { componentId: "estimate", semanticClass: "locally-computed-estimate", currency: "USD", amountMicros: 8, authority: "planning", priceSourceFingerprint: telemetrySnapshotFingerprint({ price: 1 }), priceEffectiveAt: NOW },
      { componentId: "unknown", semanticClass: "unknown", currency: null, amountMicros: null, authority: "none", priceSourceFingerprint: null, priceEffectiveAt: null },
    ] }, { observationId: "cost" }));
    const summary = queryCostSummary([cost], { from: "2026-01-01T00:00:00.000Z", to: "2026-01-03T00:00:00.000Z" });
    expect(summary.subtotals).toEqual([
      expect.objectContaining({ semanticClass: "locally-computed-estimate", amountMicros: 8 }),
      expect.objectContaining({ semanticClass: "provider-billed", amountMicros: 10 }),
    ]);
    expect(summary).toMatchObject({ unknownComponentCount: 1, partialObservationCount: 1, completeness: "partial" });
    expect(costVariance(cost.data.components)).toEqual({ currency: "USD", amountMicros: 2 });
  });

  it("never mixes currencies or double counts duplicate source views", () => {
    const common = { source: { category: "provider-reported" as const, sourceObservationId: "same" }, provenance: { sourceFingerprint: telemetrySnapshotFingerprint({ same: 1 }), pricingSource: null, pricingEffectiveAt: null, derivation: null, sampleObservationIds: [] } };
    const unknown = materialize(makeDraft("cost", { components: [{ componentId: "unknown", semanticClass: "unknown", currency: null, amountMicros: null, authority: "none", priceSourceFingerprint: null, priceEffectiveAt: null }] }, { observationId: "unknown", ...common }));
    const exact = materialize(makeDraft("cost", { components: [{ componentId: "bill", semanticClass: "provider-billed", currency: "EUR", amountMicros: 7, authority: "billing", priceSourceFingerprint: null, priceEffectiveAt: null }] }, { observationId: "exact", ...common }));
    const otherInstance = materialize(makeDraft("cost", { components: [{ componentId: "other-bill", semanticClass: "provider-billed", currency: "EUR", amountMicros: 3, authority: "billing", priceSourceFingerprint: null, priceEffectiveAt: null }] }, { observationId: "other-instance", identity: { ...exact.identity, configuredInstanceId: "instance-2" }, ...common }));
    const summary = queryCostSummary([unknown, exact, otherInstance], { from: "2026-01-01T00:00:00.000Z", to: "2026-01-03T00:00:00.000Z" });
    expect(summary.subtotals).toEqual([expect.objectContaining({ currency: "EUR", amountMicros: 10, componentCount: 2 })]);
    expect(summary.unknownComponentCount).toBe(0);
  });

  it("summarizes operations once rather than summing cumulative snapshots", () => {
    const one = materialize(makeDraft("cumulative-usage", { usage: usage(2), sequence: 1, quality: "partial" }, { observationId: "one" }));
    const two = materialize(makeDraft("cumulative-usage", { usage: usage(5), sequence: 2, quality: "complete" }, { observationId: "two", observedAt: LATER }));
    const summary = queryUsageSummary([one, two], { from: "2026-01-01T00:00:00.000Z", to: "2026-01-03T00:00:00.000Z" });
    expect(summary.actual.uncachedInputTokens).toBe(5);
    expect(summary.operationCount).toBe(1);
  });
});
