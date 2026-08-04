import {
  createTelemetryObservation,
  deterministicPartition,
  telemetrySnapshotFingerprint,
  type NormalizedTokenUsage,
  type TelemetryAccessContext,
  type TelemetryObservation,
  type TelemetryObservationDraft,
} from "../src/index.js";
import type { TelemetryBridgeContext } from "../src/providers.js";

export const NOW = "2026-01-02T03:04:05.000Z";
export const LATER = "2026-01-02T03:05:05.000Z";
export const FINGERPRINT = telemetrySnapshotFingerprint({ fixture: "source" });
export const SCOPE = Object.freeze({ organizationId: "org-1", userId: "user-1", projectId: "project-1", workspaceId: "workspace-1", taskId: "task-1", runId: "run-1" });
export const ACCESS: TelemetryAccessContext = Object.freeze({ subjectId: "user-1", organizationId: "org-1", projectId: "project-1", workspaceId: "workspace-1", purpose: "ingest", classification: "internal" });
export const IDENTITY = Object.freeze({ providerKind: "inference" as const, providerId: "provider-1", configuredInstanceId: "instance-1", contractModelId: "model-1", upstreamModelId: "model-1", adapterPackage: "@ai-dev-os/providers", adapterProfile: "default", adapterVersion: "0.1.0", catalogFingerprint: null, providerFingerprint: null, modelFingerprint: null, authenticationClass: "api-key" as const, billingClass: "metered" as const });

export function usage(input = 1, output = 1, quality: NormalizedTokenUsage["categoryCompleteness"] = "exact"): NormalizedTokenUsage {
  return Object.freeze({ uncachedInputTokens: input, cacheWriteInputTokens: 0, cachedReadInputTokens: 0, visibleOutputTokens: output, reasoningTokens: 0, unknownCombinedTokens: 0, toolCalls: 0, categoryCompleteness: quality });
}

export function makeDraft(
  kind: TelemetryObservationDraft["kind"],
  data: TelemetryObservationDraft["data"],
  overrides: Partial<TelemetryObservationDraft> = {},
): TelemetryObservationDraft {
  const observationId = overrides.observationId ?? `${kind}-1`;
  return Object.freeze({
    ledgerId: "ledger-1", observationId, idempotencyKey: overrides.idempotencyKey ?? `idem-${observationId}`,
    scope: SCOPE, traceId: "trace-1", operationId: "operation-1", parentOperationId: null, identity: IDENTITY,
    source: { category: "provider-reported", sourceObservationId: `source-${observationId}` }, observedAt: NOW,
    effectiveFrom: null, effectiveUntil: null, resetsAt: null, staleAt: null, terminalAt: null, confidence: "reported",
    provenance: { sourceFingerprint: telemetrySnapshotFingerprint({ observationId }), pricingSource: null, pricingEffectiveAt: null, derivation: null, sampleObservationIds: [] },
    previousObservationId: null, correctedObservationId: null, detailCodes: [], kind, data,
    ...overrides,
  } as TelemetryObservationDraft);
}

export function materialize(draft: TelemetryObservationDraft): TelemetryObservation {
  const partition = deterministicPartition(draft.ledgerId, draft.observedAt, 86_400_000);
  return createTelemetryObservation(draft, { partitionId: partition.partitionId, ingestedAt: NOW });
}

export function bridgeContext(overrides: Partial<TelemetryBridgeContext> = {}): TelemetryBridgeContext {
  return Object.freeze({
    ledgerId: "ledger-1", observationId: "bridge-1", idempotencyKey: "idem-bridge-1", scope: SCOPE, traceId: "trace-1",
    operationId: "operation-1", parentOperationId: null, identity: IDENTITY, sourceCategory: "provider-reported",
    sourceObservationId: "upstream-1", sourceFingerprint: FINGERPRINT, observedAt: NOW, effectiveFrom: null, effectiveUntil: null,
    resetsAt: null, staleAt: LATER, terminalAt: NOW, confidence: "reported", pricingSource: null, pricingEffectiveAt: null,
    derivation: null, previousObservationId: null, correctedObservationId: null, detailCodes: [], ...overrides,
  });
}
