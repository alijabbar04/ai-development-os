import type { JsonValue } from "@ai-dev-os/domain";
import type { PersistenceAdapter } from "@ai-dev-os/persistence";

export const TELEMETRY_SCHEMA_VERSION = 1 as const;
export const TELEMETRY_ALGORITHM_VERSION = 1 as const;
export const TELEMETRY_CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const TELEMETRY_CONFIGURATION_SCHEMA_VERSION = 1 as const;

export const TELEMETRY_OBSERVATION_KINDS = Object.freeze([
  "operation-estimate",
  "cumulative-usage",
  "terminal-reconciliation",
  "cost",
  "provider-health",
  "quota-window",
  "capacity",
  "correction",
  "derived-state",
  "forecast",
  "account-usage",
] as const);
export type TelemetryObservationKind = (typeof TELEMETRY_OBSERVATION_KINDS)[number];

export interface TelemetryScope {
  readonly organizationId: string | null;
  readonly userId: string | null;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
  readonly taskId: string | null;
  readonly runId: string | null;
}

export interface ProviderIdentity {
  readonly providerKind: "inference" | "coding-agent" | "local-capacity";
  readonly providerId: string;
  readonly configuredInstanceId: string;
  readonly contractModelId: string | null;
  readonly upstreamModelId: string | null;
  readonly adapterPackage: string;
  readonly adapterProfile: string;
  readonly adapterVersion: string;
  readonly catalogFingerprint: string | null;
  readonly providerFingerprint: string | null;
  readonly modelFingerprint: string | null;
  readonly authenticationClass: "api-key" | "subscription" | "cloud-credential" | "local" | "unknown";
  readonly billingClass: "metered" | "subscription" | "local-operator" | "unknown";
}

export interface TelemetrySource {
  readonly category:
    | "provider-reported"
    | "provider-api"
    | "response-headers"
    | "host-supplied"
    | "operator"
    | "adapter-derived"
    | "ledger-derived"
    | "unobserved";
  readonly sourceObservationId: string;
}

export interface TelemetryProvenance {
  readonly sourceFingerprint: string;
  readonly pricingSource: string | null;
  readonly pricingEffectiveAt: string | null;
  readonly derivation: string | null;
  readonly sampleObservationIds: readonly string[];
}

export interface NormalizedTokenUsage {
  readonly uncachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly cachedReadInputTokens: number;
  readonly visibleOutputTokens: number;
  readonly reasoningTokens: number;
  readonly unknownCombinedTokens: number;
  readonly toolCalls: number;
  readonly categoryCompleteness: "exact" | "generic-four-category" | "partial";
}

export interface CostComponent {
  readonly componentId: string;
  readonly semanticClass:
    | "provider-billed"
    | "locally-computed-estimate"
    | "subscription-equivalent-estimate"
    | "verified-zero"
    | "unknown";
  readonly currency: string | null;
  readonly amountMicros: number | null;
  readonly authority: "billing" | "planning" | "evidence" | "none";
  readonly priceSourceFingerprint: string | null;
  readonly priceEffectiveAt: string | null;
}

export type TelemetryState =
  | "available"
  | "limited"
  | "exhausted"
  | "healthy"
  | "degraded"
  | "unavailable"
  | "stale"
  | "unsupported"
  | "unknown";

export type TelemetryWindow =
  | "rolling"
  | "fixed"
  | "daily"
  | "five-hour"
  | "seven-day"
  | "primary"
  | "secondary"
  | "provider-defined";

export type TelemetryDimension = "tokens" | "requests" | "concurrency" | "memory-bytes" | "credits" | "usage-percentage";

export interface ObservationEnvelope {
  readonly schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  readonly algorithmVersion: typeof TELEMETRY_ALGORITHM_VERSION;
  readonly ledgerId: string;
  readonly partitionId: string;
  readonly observationId: string;
  readonly idempotencyKey: string;
  readonly scope: TelemetryScope;
  readonly traceId: string | null;
  readonly operationId: string | null;
  readonly parentOperationId: string | null;
  readonly identity: ProviderIdentity;
  readonly source: TelemetrySource;
  readonly observedAt: string;
  readonly ingestedAt: string;
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
  readonly resetsAt: string | null;
  readonly staleAt: string | null;
  readonly terminalAt: string | null;
  readonly confidence: "reported" | "high" | "medium" | "low" | "none";
  readonly provenance: TelemetryProvenance;
  readonly canonicalPayloadFingerprint: string;
  readonly previousObservationId: string | null;
  readonly correctedObservationId: string | null;
  readonly detailCodes: readonly string[];
}

export type TelemetryObservation = ObservationEnvelope &
  (
    | { readonly kind: "operation-estimate"; readonly data: { readonly usage: NormalizedTokenUsage; readonly reservationId: string | null } }
    | { readonly kind: "cumulative-usage"; readonly data: { readonly usage: NormalizedTokenUsage; readonly sequence: number; readonly quality: "partial" | "complete" } }
    | { readonly kind: "terminal-reconciliation"; readonly data: { readonly usage: NormalizedTokenUsage | null; readonly sequence: number | null; readonly outcome: "succeeded" | "failed" | "cancelled"; readonly quality: "complete" | "partial" | "missing" } }
    | { readonly kind: "cost"; readonly data: { readonly components: readonly CostComponent[] } }
    | { readonly kind: "provider-health"; readonly data: { readonly state: TelemetryState; readonly latencyMs: number | null } }
    | { readonly kind: "quota-window"; readonly data: QuotaWindowData }
    | { readonly kind: "capacity"; readonly data: CapacityData }
    | { readonly kind: "correction"; readonly data: { readonly action: "supersede" | "tombstone"; readonly targetObservationId: string; readonly reasonCode: string } }
    | { readonly kind: "derived-state"; readonly data: { readonly stateFingerprint: string; readonly throughEventId: string; readonly eventCount: number } }
    | { readonly kind: "forecast"; readonly data: ForecastData }
    | { readonly kind: "account-usage"; readonly data: { readonly period: "lifetime" | "daily"; readonly periodStart: string | null; readonly tokens: number | null; readonly status: "reported" | "unsupported" | "unknown" } }
  );

export interface QuotaWindowData {
  readonly state: TelemetryState;
  readonly dimension: TelemetryDimension;
  readonly window: TelemetryWindow;
  readonly providerWindowId: string | null;
  readonly remaining: number | null;
  readonly limit: number | null;
  readonly usedBasisPoints: number | null;
  readonly remainingBasisPoints: number | null;
  readonly durationMs: number | null;
}

export interface CapacityData {
  readonly state: TelemetryState;
  readonly dimension: TelemetryDimension;
  readonly available: number | null;
  readonly limit: number | null;
  readonly queued: number | null;
  readonly reserved: number | null;
  readonly window: TelemetryWindow | null;
  readonly providerWindowId: string | null;
}

export interface ForecastData {
  readonly status: "available" | "unavailable";
  readonly dimension: TelemetryDimension;
  readonly window: TelemetryWindow;
  readonly providerWindowId: string | null;
  readonly estimatedExhaustionAt: string | null;
  readonly estimatedPostResetAvailableAt: string | null;
  readonly burnUnitsPerMillionMs: number | null;
  readonly sampleCount: number;
  readonly sampleFrom: string | null;
  readonly sampleTo: string | null;
  readonly confidence: "high" | "medium" | "low" | "none";
  readonly unavailableReason: string | null;
}

export type TelemetryObservationDraft = Omit<
  TelemetryObservation,
  "schemaVersion" | "algorithmVersion" | "partitionId" | "ingestedAt" | "canonicalPayloadFingerprint"
>;

export interface TelemetryLedgerConfiguration {
  readonly schemaVersion: typeof TELEMETRY_CONFIGURATION_SCHEMA_VERSION;
  readonly partitionDurationMs: number;
  readonly maximumPartitionCount: number;
  readonly maximumObservationsPerPartition: number;
  readonly maximumIdempotencyRecordsPerPartition: number;
  readonly eventPageSize: number;
  readonly queryPageSize: number;
  readonly retentionDays: number;
  readonly tombstoneRetentionDays: number;
  readonly compaction: "disabled" | "checkpoint-only";
  readonly stalenessMs: { readonly usage: number; readonly cost: number; readonly health: number; readonly quota: number; readonly capacity: number };
  readonly forecast: { readonly minimumSamples: number; readonly maximumSamples: number; readonly lookbackMs: number; readonly horizonMs: number };
  readonly concurrency: { readonly maximumRetries: number };
  readonly acceptedCurrencies: readonly string[];
  readonly acceptedCostSemantics: readonly CostComponent["semanticClass"][];
  readonly enabledBridges: readonly string[];
  readonly auditFailure: "deny";
}

export interface TelemetryCheckpoint {
  readonly schemaVersion: typeof TELEMETRY_CHECKPOINT_SCHEMA_VERSION;
  readonly algorithmVersion: typeof TELEMETRY_ALGORITHM_VERSION;
  readonly ledgerId: string;
  readonly partitionId: string;
  readonly partitionStart: string;
  readonly partitionEnd: string;
  readonly observations: readonly TelemetryObservation[];
  readonly idempotency: readonly { readonly observationId: string; readonly idempotencyKey: string; readonly sourceKey: string; readonly sourceFingerprint: string; readonly fingerprint: string }[];
  readonly supersededObservationIds: readonly string[];
  readonly eventCount: number;
  readonly lastEventId: string | null;
  readonly checkpointFingerprint: string;
}

export interface TelemetryAccessContext {
  readonly subjectId: string;
  readonly organizationId: string | null;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
  readonly purpose: "ingest" | "operations" | "usage" | "cost" | "capacity" | "history" | "export" | "verify";
  readonly classification: "internal" | "confidential" | "restricted";
}

export interface TelemetryAuthorizationRequest {
  readonly action: "write" | "read";
  readonly ledgerId: string;
  readonly access: TelemetryAccessContext;
  readonly scope: TelemetryScope;
  readonly providerInstanceId: string;
  readonly operationId: string | null;
}

export interface TelemetryAuthorizer {
  authorize(request: TelemetryAuthorizationRequest): boolean | Promise<boolean>;
}

export interface TelemetryAuditRecord {
  readonly schemaVersion: 1;
  readonly action: "write" | "read" | "verify";
  readonly outcome: "allowed" | "denied" | "failure";
  readonly purpose: TelemetryAccessContext["purpose"];
  readonly classification: TelemetryAccessContext["classification"];
  readonly organizationScoped: boolean;
  readonly projectScoped: boolean;
  readonly workspaceScoped: boolean;
  readonly providerInstanceScoped: boolean;
  readonly occurredAt: string;
  readonly detailCode: string;
}

export type TelemetryAuditSink = (record: TelemetryAuditRecord) => void | Promise<void>;

export interface IngestionResult {
  readonly outcome: "accepted" | "duplicate" | "conflict" | "rejected";
  readonly observation: TelemetryObservation | null;
  readonly eventId: string | null;
  readonly checkpointFingerprint: string | null;
  readonly code: string;
}

export interface ReconciledOperationTelemetry {
  readonly operationId: string;
  readonly estimate: NormalizedTokenUsage | null;
  readonly actual: NormalizedTokenUsage | null;
  readonly actualQuality: "complete" | "partial" | "missing";
  readonly outcome: "succeeded" | "failed" | "cancelled" | null;
  readonly sourceObservationIds: readonly string[];
  readonly fingerprint: string;
}

export interface UsageSummary {
  readonly interval: { readonly from: string; readonly to: string };
  readonly filters: Readonly<Record<string, string | null>>;
  readonly estimated: NormalizedTokenUsage;
  readonly actual: NormalizedTokenUsage;
  readonly operationCount: number;
  readonly completeOperationCount: number;
  readonly partialOperationCount: number;
  readonly missingOperationCount: number;
  readonly staleObservationCount: number;
  readonly unknownObservationCount: number;
  readonly sourceFingerprints: readonly string[];
  readonly completeness: "complete" | "partial" | "unknown";
  readonly fingerprint: string;
}

export interface CostSummary {
  readonly interval: { readonly from: string; readonly to: string };
  readonly filters: Readonly<Record<string, string | null>>;
  readonly subtotals: readonly { readonly currency: string; readonly semanticClass: CostComponent["semanticClass"]; readonly amountMicros: number; readonly componentCount: number }[];
  readonly unknownComponentCount: number;
  readonly partialObservationCount: number;
  readonly sourceFingerprints: readonly string[];
  readonly completeness: "complete" | "partial" | "unknown";
  readonly fingerprint: string;
}

export interface CapacitySnapshot {
  readonly asOf: string;
  readonly interval: { readonly from: string; readonly to: string };
  readonly filters: Readonly<Record<string, string | null>>;
  readonly observations: readonly TelemetryObservation[];
  readonly staleCount: number;
  readonly unknownCount: number;
  readonly unsupportedCount: number;
  readonly sourceFingerprints: readonly string[];
  readonly completeness: "complete" | "partial" | "unknown";
  readonly fingerprint: string;
}

export interface TelemetrySnapshot {
  readonly schemaVersion: 1;
  readonly ledgerId: string;
  readonly generatedAt: string;
  readonly interval: { readonly from: string; readonly to: string };
  readonly observations: readonly TelemetryObservation[];
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly fingerprint: string;
}

export interface TelemetryQuery {
  readonly access: TelemetryAccessContext;
  readonly from: string;
  readonly to: string;
  readonly providerInstanceId?: string | null;
  readonly contractModelId?: string | null;
  readonly upstreamModelId?: string | null;
  readonly operationId?: string | null;
  readonly observationId?: string | null;
  readonly dimension?: TelemetryDimension | null;
  readonly window?: TelemetryWindow | null;
  readonly providerWindowId?: string | null;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface TelemetryPage {
  readonly items: readonly TelemetryObservation[];
  readonly nextCursor: string | null;
  readonly truncated: boolean;
}

export interface TelemetryVerificationResult {
  readonly ok: boolean;
  readonly partitionCount: number;
  readonly eventCount: number;
  readonly replayedCheckpointFingerprints: readonly string[];
  readonly failureCodes: readonly string[];
  readonly fingerprint: string;
}

export interface TelemetryLedger {
  ingestTelemetryObservation(draft: TelemetryObservationDraft, access: TelemetryAccessContext): Promise<IngestionResult>;
  queryObservations(query: TelemetryQuery): Promise<TelemetryPage>;
  reconcileOperationTelemetry(query: TelemetryQuery & { readonly operationId: string }): Promise<ReconciledOperationTelemetry>;
  queryUsageSummary(query: TelemetryQuery): Promise<UsageSummary>;
  queryCostSummary(query: TelemetryQuery): Promise<CostSummary>;
  queryCapacitySnapshot(query: TelemetryQuery): Promise<CapacitySnapshot>;
  forecastCapacity(query: TelemetryQuery): Promise<ForecastData>;
  exportSnapshot(query: TelemetryQuery): Promise<TelemetrySnapshot>;
  verifyTelemetryLedger(access: TelemetryAccessContext): Promise<TelemetryVerificationResult>;
  close(): Promise<void>;
}

export interface CreateTelemetryLedgerOptions {
  readonly ledgerId: string;
  readonly adapter: PersistenceAdapter;
  readonly configuration: TelemetryLedgerConfiguration;
  readonly clock: { now(): Date };
  readonly authorizer: TelemetryAuthorizer;
  readonly audit: TelemetryAuditSink;
}

export type JsonRecord = Readonly<Record<string, JsonValue>>;
