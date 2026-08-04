import { telemetrySnapshotFingerprint } from "./fingerprint.js";
import { TelemetryError } from "./errors.js";
import type { NormalizedTokenUsage, ReconciledOperationTelemetry, TelemetryObservation } from "./types.js";

export const ZERO_NORMALIZED_USAGE: NormalizedTokenUsage = Object.freeze({
  uncachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  cachedReadInputTokens: 0,
  visibleOutputTokens: 0,
  reasoningTokens: 0,
  unknownCombinedTokens: 0,
  toolCalls: 0,
  categoryCompleteness: "exact",
});

const NUMERIC_USAGE_KEYS = [
  "uncachedInputTokens", "cacheWriteInputTokens", "cachedReadInputTokens", "visibleOutputTokens",
  "reasoningTokens", "unknownCombinedTokens", "toolCalls",
] as const;

function exactAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new TelemetryError("OVERFLOW", "usage-addition-overflow");
  return total;
}

export function addNormalizedUsage(left: NormalizedTokenUsage, right: NormalizedTokenUsage): NormalizedTokenUsage {
  const quality = left.categoryCompleteness === "partial" || right.categoryCompleteness === "partial"
    ? "partial"
    : left.categoryCompleteness === "generic-four-category" || right.categoryCompleteness === "generic-four-category"
      ? "generic-four-category"
      : "exact";
  return Object.freeze({
    uncachedInputTokens: exactAdd(left.uncachedInputTokens, right.uncachedInputTokens),
    cacheWriteInputTokens: exactAdd(left.cacheWriteInputTokens, right.cacheWriteInputTokens),
    cachedReadInputTokens: exactAdd(left.cachedReadInputTokens, right.cachedReadInputTokens),
    visibleOutputTokens: exactAdd(left.visibleOutputTokens, right.visibleOutputTokens),
    reasoningTokens: exactAdd(left.reasoningTokens, right.reasoningTokens),
    unknownCombinedTokens: exactAdd(left.unknownCombinedTokens, right.unknownCombinedTokens),
    toolCalls: exactAdd(left.toolCalls, right.toolCalls),
    categoryCompleteness: quality,
  });
}

function usageRegressed(previous: NormalizedTokenUsage, next: NormalizedTokenUsage): boolean {
  return NUMERIC_USAGE_KEYS.some((key) => next[key] < previous[key]);
}

function qualityRank(usage: NormalizedTokenUsage): number {
  return usage.categoryCompleteness === "exact" ? 3 : usage.categoryCompleteness === "generic-four-category" ? 2 : 1;
}

export function activeTelemetryObservations(observations: readonly TelemetryObservation[]): readonly TelemetryObservation[] {
  const ids = new Map(observations.map((item) => [item.observationId, item]));
  const superseded = new Set<string>();
  for (const observation of observations) {
    if (observation.kind !== "correction") continue;
    const target = ids.get(observation.data.targetObservationId);
    // Query windows and authorized result sets may legitimately contain the
    // correction without its historical target. Target integrity is enforced
    // when the correction is accepted and during full-ledger verification.
    if (target?.kind === "correction") throw new TelemetryError("IDENTITY_CONFLICT", "correction-target-missing");
    if (target !== undefined) superseded.add(target.observationId);
  }
  return Object.freeze(observations.filter((item) => !superseded.has(item.observationId) && item.kind !== "correction"));
}

export function validateCorrectionTargets(observations: readonly TelemetryObservation[]): void {
  const ids = new Map(observations.map((item) => [item.observationId, item]));
  for (const observation of observations) {
    if (observation.kind !== "correction") continue;
    const target = ids.get(observation.data.targetObservationId);
    if (target === undefined || target.kind === "correction") {
      throw new TelemetryError("IDENTITY_CONFLICT", "correction-target-missing");
    }
    if (target.operationId !== observation.operationId || operationIdentityFingerprint(target) !== operationIdentityFingerprint(observation)) {
      throw new TelemetryError("IDENTITY_CONFLICT", "correction-target-identity-mismatch");
    }
  }
}

function deduplicateSources(observations: readonly TelemetryObservation[]): readonly TelemetryObservation[] {
  const sources = new Map<string, TelemetryObservation>();
  for (const observation of observations) {
    const family = observation.kind === "operation-estimate" ? "estimate" : "actual";
    const key = `${observation.source.category}:${observation.source.sourceObservationId}:${family}`;
    const previous = sources.get(key);
    if (previous === undefined) {
      sources.set(key, observation);
      continue;
    }
    if (previous.provenance.sourceFingerprint !== observation.provenance.sourceFingerprint) {
      throw new TelemetryError("IDEMPOTENCY_CONFLICT", "source-identity-reused");
    }
    const previousUsage = previous.kind === "operation-estimate" || previous.kind === "cumulative-usage" ? previous.data.usage : previous.kind === "terminal-reconciliation" ? previous.data.usage : null;
    const nextUsage = observation.kind === "operation-estimate" || observation.kind === "cumulative-usage" ? observation.data.usage : observation.kind === "terminal-reconciliation" ? observation.data.usage : null;
    const rank = (item: TelemetryObservation, usage: NormalizedTokenUsage): number =>
      qualityRank(usage) + (item.kind === "terminal-reconciliation" ? 20 : item.kind === "cumulative-usage" ? 10 : 0) +
      (item.kind === "terminal-reconciliation" && item.data.quality === "complete" || item.kind === "cumulative-usage" && item.data.quality === "complete" ? 5 : 0);
    if (previousUsage !== null && nextUsage !== null && rank(observation, nextUsage) > rank(previous, previousUsage)) sources.set(key, observation);
  }
  return Object.freeze([...sources.values()]);
}

function operationIdentityFingerprint(observation: TelemetryObservation): string {
  return telemetrySnapshotFingerprint({ identity: observation.identity, scope: observation.scope, ledgerId: observation.ledgerId });
}

export function reconcileOperationTelemetry(
  observations: readonly TelemetryObservation[],
  operationId?: string,
): ReconciledOperationTelemetry {
  const candidates = activeTelemetryObservations(observations).filter((item) =>
    item.operationId !== null && (operationId === undefined || item.operationId === operationId) &&
    (item.kind === "operation-estimate" || item.kind === "cumulative-usage" || item.kind === "terminal-reconciliation"),
  );
  if (candidates.length === 0 || candidates[0]?.operationId === null) throw new TelemetryError("INVALID_OBSERVATION", "operation-not-found");
  const resolvedOperationId = candidates[0]!.operationId;
  if (candidates.some((item) => item.operationId !== resolvedOperationId)) throw new TelemetryError("IDENTITY_CONFLICT", "multiple-operations");
  const identity = operationIdentityFingerprint(candidates[0]!);
  if (candidates.some((item) => operationIdentityFingerprint(item) !== identity)) throw new TelemetryError("IDENTITY_CONFLICT", "operation-identity-changed");
  const ordered = deduplicateSources(candidates).slice().sort((left, right) =>
    left.observedAt.localeCompare(right.observedAt) || left.observationId.localeCompare(right.observationId),
  );
  let estimate: NormalizedTokenUsage | null = null;
  let actual: NormalizedTokenUsage | null = null;
  let actualQuality: ReconciledOperationTelemetry["actualQuality"] = "missing";
  let outcome: ReconciledOperationTelemetry["outcome"] = null;
  let lastSequence = 0;
  let terminalFingerprint: string | null = null;
  for (const observation of ordered) {
    if (observation.kind === "operation-estimate") {
      estimate = observation.data.usage;
      continue;
    }
    if (observation.kind === "cumulative-usage") {
      if ((actual !== null && observation.data.sequence <= lastSequence) || (actual !== null && usageRegressed(actual, observation.data.usage))) {
        throw new TelemetryError("NON_MONOTONIC_USAGE", "cumulative-usage-regressed");
      }
      lastSequence = observation.data.sequence;
      actual = observation.data.usage;
      actualQuality = observation.data.quality;
      continue;
    }
    if (observation.kind !== "terminal-reconciliation") continue;
    const nextTerminalFingerprint = telemetrySnapshotFingerprint(observation.data);
    if (terminalFingerprint !== null && terminalFingerprint !== nextTerminalFingerprint) throw new TelemetryError("TERMINAL_CONTRADICTION", "multiple-terminal-values");
    terminalFingerprint = nextTerminalFingerprint;
    if (observation.data.sequence !== null && observation.data.sequence < lastSequence) throw new TelemetryError("TERMINAL_CONTRADICTION", "terminal-sequence-regressed");
    if (observation.data.usage !== null) {
      if (actual !== null && usageRegressed(actual, observation.data.usage)) throw new TelemetryError("TERMINAL_CONTRADICTION", "terminal-usage-regressed");
      actual = observation.data.usage;
    }
    actualQuality = observation.data.quality === "missing" && actual !== null ? "partial" : observation.data.quality;
    outcome = observation.data.outcome;
  }
  const sourceObservationIds = Object.freeze(ordered.map((item) => item.observationId));
  const result = {
    operationId: resolvedOperationId,
    estimate,
    actual,
    actualQuality,
    outcome,
    sourceObservationIds,
  };
  return Object.freeze({ ...result, fingerprint: telemetrySnapshotFingerprint(result) });
}
