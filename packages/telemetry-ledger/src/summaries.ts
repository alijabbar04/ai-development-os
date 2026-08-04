import { telemetrySnapshotFingerprint } from "./fingerprint.js";
import { TelemetryError } from "./errors.js";
import { activeTelemetryObservations, addNormalizedUsage, reconcileOperationTelemetry, ZERO_NORMALIZED_USAGE } from "./reconciliation.js";
import type { CostComponent, CostSummary, TelemetryObservation, UsageSummary } from "./types.js";

function inInterval(item: TelemetryObservation, from: string, to: string): boolean {
  return item.observedAt >= from && item.observedAt < to;
}

interface SummaryFilters {
  readonly providerInstanceId?: string | null;
  readonly contractModelId?: string | null;
  readonly upstreamModelId?: string | null;
  readonly operationId?: string | null;
  readonly observationId?: string | null;
  readonly dimension?: string | null;
  readonly window?: string | null;
  readonly providerWindowId?: string | null;
}

function matchesSummaryFilters(item: TelemetryObservation, input: SummaryFilters): boolean {
  const signal = item.kind === "quota-window" || item.kind === "capacity" ? item.data : null;
  return (input.providerInstanceId === undefined || input.providerInstanceId === null || item.identity.configuredInstanceId === input.providerInstanceId) &&
    (input.contractModelId === undefined || input.contractModelId === null || item.identity.contractModelId === input.contractModelId) &&
    (input.upstreamModelId === undefined || input.upstreamModelId === null || item.identity.upstreamModelId === input.upstreamModelId) &&
    (input.operationId === undefined || input.operationId === null || item.operationId === input.operationId) &&
    (input.observationId === undefined || input.observationId === null || item.observationId === input.observationId) &&
    (input.dimension === undefined || input.dimension === null || signal?.dimension === input.dimension) &&
    (input.window === undefined || input.window === null || signal?.window === input.window) &&
    (input.providerWindowId === undefined || input.providerWindowId === null || signal?.providerWindowId === input.providerWindowId);
}

function summaryFilters(input: SummaryFilters): Readonly<Record<string, string | null>> {
  return Object.freeze({
    providerInstanceId: input.providerInstanceId ?? null,
    contractModelId: input.contractModelId ?? null,
    upstreamModelId: input.upstreamModelId ?? null,
    operationId: input.operationId ?? null,
    observationId: input.observationId ?? null,
    dimension: input.dimension ?? null,
    window: input.window ?? null,
    providerWindowId: input.providerWindowId ?? null,
  });
}

export function queryUsageSummary(
  observations: readonly TelemetryObservation[],
  input: { readonly from: string; readonly to: string } & SummaryFilters,
): UsageSummary {
  const filtered = activeTelemetryObservations(observations).filter((item) =>
    inInterval(item, input.from, input.to) && matchesSummaryFilters(item, input),
  );
  const operations = [...new Set(filtered.flatMap((item) => item.operationId === null ? [] : [item.operationId]))].sort();
  let estimated = ZERO_NORMALIZED_USAGE;
  let actual = ZERO_NORMALIZED_USAGE;
  let complete = 0;
  let partial = 0;
  let missing = 0;
  let operationWithUsageEvidenceCount = 0;
  const used: string[] = [];
  for (const operationId of operations) {
    const operationEvidence = filtered.filter((item) => item.operationId === operationId && (item.kind === "operation-estimate" || item.kind === "cumulative-usage" || item.kind === "terminal-reconciliation"));
    if (operationEvidence.length === 0) { missing += 1; continue; }
    operationWithUsageEvidenceCount += 1;
    const operation = reconcileOperationTelemetry(operationEvidence, operationId);
    if (operation.estimate !== null) estimated = addNormalizedUsage(estimated, operation.estimate);
    if (operation.actual !== null) actual = addNormalizedUsage(actual, operation.actual);
    if (operation.actualQuality === "complete") complete += 1;
    else if (operation.actualQuality === "partial") partial += 1;
    else missing += 1;
    used.push(...operation.sourceObservationIds);
  }
  const now = Date.parse(input.to);
  const staleObservationCount = filtered.filter((item) => item.staleAt !== null && Date.parse(item.staleAt) <= now).length;
  const unknownObservationCount = filtered.filter((item) =>
    (item.kind === "capacity" || item.kind === "quota-window" || item.kind === "provider-health") && item.data.state === "unknown",
  ).length;
  const sourceFingerprints = Object.freeze([...new Set(filtered.map((item) => item.provenance.sourceFingerprint))].sort());
  const base = {
    interval: { from: input.from, to: input.to },
    filters: summaryFilters(input), estimated, actual,
    operationCount: operations.length, completeOperationCount: complete, partialOperationCount: partial,
    missingOperationCount: missing, staleObservationCount, unknownObservationCount, sourceFingerprints,
    completeness: operations.length === 0 || operationWithUsageEvidenceCount === 0 ? "unknown" as const : partial > 0 || missing > 0 || staleObservationCount > 0 || unknownObservationCount > 0 ? "partial" as const : "complete" as const,
  };
  return Object.freeze({ ...base, fingerprint: telemetrySnapshotFingerprint(base) });
}

export function queryCostSummary(
  observations: readonly TelemetryObservation[],
  input: { readonly from: string; readonly to: string } & SummaryFilters,
): CostSummary {
  const rawCostObservations = activeTelemetryObservations(observations).filter((item): item is Extract<TelemetryObservation, { readonly kind: "cost" }> =>
    item.kind === "cost" && inInterval(item, input.from, input.to) && matchesSummaryFilters(item, input),
  );
  const bySource = new Map<string, (typeof rawCostObservations)[number]>();
  for (const item of rawCostObservations) {
    const key = telemetrySnapshotFingerprint({ ledgerId: item.ledgerId, providerId: item.identity.providerId, providerInstanceId: item.identity.configuredInstanceId, category: item.source.category, sourceObservationId: item.source.sourceObservationId });
    const previous = bySource.get(key);
    if (previous === undefined) { bySource.set(key, item); continue; }
    if (previous.provenance.sourceFingerprint !== item.provenance.sourceFingerprint) throw new TelemetryError("IDEMPOTENCY_CONFLICT", "cost-source-identity-reused");
    const known = (candidate: typeof item): number => candidate.data.components.filter((component) => component.semanticClass !== "unknown").length;
    if (known(item) > known(previous)) bySource.set(key, item);
  }
  const costObservations = [...bySource.values()];
  const totals = new Map<string, { currency: string; semanticClass: CostComponent["semanticClass"]; amountMicros: number; componentCount: number }>();
  let unknownComponentCount = 0;
  let partialObservationCount = 0;
  for (const observation of costObservations) {
    let known = 0;
    let unknown = 0;
    for (const component of observation.data.components) {
      if (component.semanticClass === "unknown" || component.currency === null || component.amountMicros === null) {
        unknown += 1;
        unknownComponentCount += 1;
        continue;
      }
      known += 1;
      const key = `${component.currency}:${component.semanticClass}`;
      const previous = totals.get(key);
      const amountMicros = (previous?.amountMicros ?? 0) + component.amountMicros;
      if (!Number.isSafeInteger(amountMicros)) throw new TelemetryError("OVERFLOW", "cost-addition-overflow");
      totals.set(key, { currency: component.currency, semanticClass: component.semanticClass, amountMicros, componentCount: (previous?.componentCount ?? 0) + 1 });
    }
    if (known > 0 && unknown > 0) partialObservationCount += 1;
  }
  const subtotals = Object.freeze([...totals.values()].sort((left, right) => left.currency.localeCompare(right.currency) || left.semanticClass.localeCompare(right.semanticClass)).map((item) => Object.freeze(item)));
  const sourceFingerprints = Object.freeze([...new Set(costObservations.map((item) => item.provenance.sourceFingerprint))].sort());
  const base = {
    interval: { from: input.from, to: input.to }, filters: summaryFilters(input), subtotals,
    unknownComponentCount, partialObservationCount, sourceFingerprints,
    completeness: costObservations.length === 0 || (subtotals.length === 0 && unknownComponentCount > 0) ? "unknown" as const : unknownComponentCount > 0 ? "partial" as const : "complete" as const,
  };
  return Object.freeze({ ...base, fingerprint: telemetrySnapshotFingerprint(base) });
}

export function costVariance(components: readonly CostComponent[]): { readonly currency: string; readonly amountMicros: number } | null {
  const billed = components.find((item) => item.semanticClass === "provider-billed");
  const computed = components.find((item) => item.semanticClass === "locally-computed-estimate");
  if (billed?.currency === null || billed?.currency === undefined || computed?.currency !== billed.currency || billed.amountMicros === null || computed.amountMicros === null) return null;
  const difference = billed.amountMicros - computed.amountMicros;
  if (!Number.isSafeInteger(difference)) throw new TelemetryError("OVERFLOW", "cost-variance-overflow");
  return Object.freeze({ currency: billed.currency, amountMicros: difference });
}
