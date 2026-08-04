import { telemetrySnapshotFingerprint } from "./fingerprint.js";
import type { ForecastData, TelemetryLedgerConfiguration, TelemetryObservation } from "./types.js";

const AUTHORITY: Readonly<Record<TelemetryObservation["source"]["category"], number>> = Object.freeze({
  "provider-reported": 7, "provider-api": 6, "response-headers": 5, "host-supplied": 4,
  operator: 3, "adapter-derived": 2, "ledger-derived": 1, unobserved: 0,
});

export function telemetrySignalKey(item: TelemetryObservation): string {
  const window = item.kind === "quota-window" ? item.data.window : item.kind === "capacity" ? item.data.window : null;
  const dimension = item.kind === "quota-window" || item.kind === "capacity" ? item.data.dimension : null;
  const providerWindowId = item.kind === "quota-window" || item.kind === "capacity" ? item.data.providerWindowId : null;
  return telemetrySnapshotFingerprint({ identity: item.identity, kind: item.kind, window, dimension, providerWindowId });
}

export function currentEffectiveObservation(
  observations: readonly TelemetryObservation[],
  now: string,
): TelemetryObservation | null {
  const candidates = observations.filter((item) =>
    (item.kind === "quota-window" || item.kind === "capacity" || item.kind === "provider-health") &&
    (item.effectiveFrom === null || item.effectiveFrom <= now) && (item.effectiveUntil === null || item.effectiveUntil > now),
  );
  if (candidates.length === 0) return null;
  const key = telemetrySignalKey(candidates[0]!);
  const comparable = candidates.filter((item) => telemetrySignalKey(item) === key);
  return comparable.slice().sort((left, right) => {
    const leftStale = left.staleAt !== null && left.staleAt <= now ? 1 : 0;
    const rightStale = right.staleAt !== null && right.staleAt <= now ? 1 : 0;
    return leftStale - rightStale || AUTHORITY[right.source.category] - AUTHORITY[left.source.category] || right.observedAt.localeCompare(left.observedAt) || left.observationId.localeCompare(right.observationId);
  })[0] ?? null;
}

function unavailable(sample: Extract<TelemetryObservation, { readonly kind: "quota-window" }> | null, reason: string, count: number): ForecastData {
  return Object.freeze({
    status: "unavailable", dimension: sample?.data.dimension ?? "tokens", window: sample?.data.window ?? "provider-defined",
    providerWindowId: sample?.data.providerWindowId ?? null, estimatedExhaustionAt: null,
    estimatedPostResetAvailableAt: sample?.resetsAt ?? null, burnUnitsPerMillionMs: null,
    sampleCount: count, sampleFrom: null, sampleTo: null, confidence: "none", unavailableReason: reason,
  });
}

export function forecastCapacity(
  observations: readonly TelemetryObservation[],
  input: { readonly now: string; readonly configuration: TelemetryLedgerConfiguration },
): ForecastData {
  const nowMs = Date.parse(input.now);
  const floor = nowMs - input.configuration.forecast.lookbackMs;
  const remainingValue = (item: Extract<TelemetryObservation, { readonly kind: "quota-window" }>): number | null => item.data.remaining ?? item.data.remainingBasisPoints;
  const all = observations.filter((item): item is Extract<TelemetryObservation, { readonly kind: "quota-window" }> =>
    item.kind === "quota-window" && remainingValue(item) !== null && Date.parse(item.observedAt) >= floor && Date.parse(item.observedAt) <= nowMs && (item.staleAt === null || Date.parse(item.staleAt) > nowMs) && item.data.state !== "stale" && item.data.state !== "unknown" && item.data.state !== "unsupported",
  );
  if (all.length === 0) return unavailable(null, "no-comparable-samples", 0);
  const key = telemetrySignalKey(all[0]!);
  if (all.some((item) => telemetrySignalKey(item) !== key)) return unavailable(all[0]!, "incomparable-samples", all.length);
  const latestReset = all.slice().sort((left, right) => right.observedAt.localeCompare(left.observedAt))[0]!.resetsAt;
  const segment = all.filter((item) => item.resetsAt === latestReset).sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.observationId.localeCompare(right.observationId)).slice(-input.configuration.forecast.maximumSamples);
  if (segment.length < input.configuration.forecast.minimumSamples) return unavailable(segment.at(-1) ?? all[0]!, "insufficient-samples", segment.length);
  const first = segment[0]!;
  const last = segment.at(-1)!;
  for (let index = 1; index < segment.length; index += 1) {
    if (remainingValue(segment[index]!)! > remainingValue(segment[index - 1]!)!) return unavailable(last, "non-monotonic-samples", segment.length);
  }
  const elapsed = Date.parse(last.observedAt) - Date.parse(first.observedAt);
  const consumed = remainingValue(first)! - remainingValue(last)!;
  if (elapsed <= 0 || consumed <= 0) return unavailable(last, "nonpositive-burn", segment.length);
  const burn = Number((BigInt(consumed) * 1_000_000n) / BigInt(elapsed));
  if (!Number.isSafeInteger(burn) || burn <= 0) return unavailable(last, "burn-below-resolution", segment.length);
  const untilExhaustionMs = Number((BigInt(remainingValue(last)!) * BigInt(elapsed) + BigInt(consumed) - 1n) / BigInt(consumed));
  if (!Number.isSafeInteger(untilExhaustionMs) || untilExhaustionMs > input.configuration.forecast.horizonMs) return unavailable(last, "outside-forecast-horizon", segment.length);
  const estimatedExhaustionAt = new Date(Date.parse(last.observedAt) + untilExhaustionMs).toISOString();
  const confidence = segment.length >= 5 ? "high" : segment.length >= 3 ? "medium" : "low";
  return Object.freeze({
    status: "available", dimension: last.data.dimension, window: last.data.window, providerWindowId: last.data.providerWindowId,
    estimatedExhaustionAt, estimatedPostResetAvailableAt: last.resetsAt !== null && last.resetsAt > input.now ? last.resetsAt : null,
    burnUnitsPerMillionMs: burn, sampleCount: segment.length, sampleFrom: first.observedAt, sampleTo: last.observedAt,
    confidence, unavailableReason: null,
  });
}
