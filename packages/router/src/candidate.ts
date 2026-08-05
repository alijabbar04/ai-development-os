import {
  DATA_CLASSIFICATIONS,
  validation,
  type DataClassification
} from "@ai-dev-os/domain";
import {
  CATALOG_ENTRY_STATES,
  CAPABILITY_IDS,
  CAPABILITY_STATUSES,
  FREE_TIER_STATES,
  parseProviderCatalog,
  type CapabilityStatus,
  type CatalogCapabilityId,
  type CatalogEntryState,
  type FreeTierState,
  type ProviderCatalogSnapshot
} from "@ai-dev-os/provider-catalog";
import {
  PROVIDER_GATEWAY_SCHEMA_VERSION,
  type GatewayInstanceSnapshot
} from "@ai-dev-os/provider-gateway";
import {
  parseModelDescriptor,
  parseProviderDescriptor,
  parseProviderHealth,
  type ModelDescriptor,
  type ProviderDescriptor,
  type ProviderHealth
} from "@ai-dev-os/providers";
import type { TelemetryState } from "@ai-dev-os/telemetry-ledger";
import { parseTokenEstimate, type TokenEstimate } from "@ai-dev-os/profiler";
import {
  parseRoutingCostEstimate,
  type RoutingCostEstimate
} from "./budget.js";
import {
  parseCircuitBreakerState,
  type CircuitBreakerState
} from "./circuit.js";
import { HEX_64, SAFE_ID, SAFE_KIND, compareText, digest } from "./shared.js";

const {
  ensureArray,
  ensureBoolean,
  ensureEnum,
  ensureExactKeys,
  ensureNullable,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
  ensureString,
  ensureTimestamp,
  fail
} = validation;

export const ROUTING_CANDIDATE_SCHEMA_VERSION = 1 as const;
export const ROUTING_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const EVIDENCE_COMPLETENESS = Object.freeze(["complete", "partial", "unknown"] as const);
export type EvidenceCompleteness = (typeof EVIDENCE_COMPLETENESS)[number];

function fingerprint(value: unknown, path: string): string {
  return ensureString(value, path, {
    minLength: 64,
    maxLength: 64,
    pattern: HEX_64,
    patternName: "fingerprint"
  });
}

export interface GatewayCandidateEvidence {
  readonly schemaVersion: typeof ROUTING_EVIDENCE_SCHEMA_VERSION;
  readonly gatewaySnapshotFingerprint: string;
  readonly instanceId: string;
  readonly contractModelId: string;
  readonly catalog: {
    readonly catalogId: string;
    readonly catalogFingerprint: string;
    readonly providerId: string;
    readonly providerFingerprint: string;
    readonly modelId: string;
    readonly modelFingerprint: string;
    readonly adapterProfileId: string;
    readonly lastVerifiedAt: string;
    readonly refreshAfter: string;
  };
  readonly descriptor: ProviderDescriptor;
  readonly model: ModelDescriptor;
  readonly eligibility: "any" | "verified-free-only";
  readonly userPreference: "enabled" | "disabled";
  readonly adapter: {
    readonly packageName:
      | "@ai-dev-os/provider-openai"
      | "@ai-dev-os/provider-openai-compatible"
      | "@ai-dev-os/provider-gemini"
      | "@ai-dev-os/provider-ollama"
      | "custom";
    readonly profileId: string;
    readonly version: string;
  };
  readonly fingerprint: string;
}

const GATEWAY_ADAPTER_PACKAGES = Object.freeze([
  "@ai-dev-os/provider-openai",
  "@ai-dev-os/provider-openai-compatible",
  "@ai-dev-os/provider-gemini",
  "@ai-dev-os/provider-ollama",
  "custom"
] as const);

function parseGatewayCatalogReference(
  value: unknown,
  path: string
): GatewayCandidateEvidence["catalog"] {
  const record = ensureRecord(value, path);
  const keys = [
    "catalogId", "catalogFingerprint", "providerId", "providerFingerprint", "modelId",
    "modelFingerprint", "adapterProfileId", "lastVerifiedAt", "refreshAfter"
  ] as const;
  ensureExactKeys(record, keys, path);
  const identifier = (key: "catalogId" | "providerId" | "modelId" | "adapterProfileId"): string =>
    ensureString(record[key], `${path}.${key}`, {
      maxLength: 128,
      pattern: SAFE_ID,
      patternName: "identifier"
    });
  return Object.freeze({
    catalogId: identifier("catalogId"),
    catalogFingerprint: fingerprint(record["catalogFingerprint"], `${path}.catalogFingerprint`),
    providerId: identifier("providerId"),
    providerFingerprint: fingerprint(record["providerFingerprint"], `${path}.providerFingerprint`),
    modelId: identifier("modelId"),
    modelFingerprint: fingerprint(record["modelFingerprint"], `${path}.modelFingerprint`),
    adapterProfileId: identifier("adapterProfileId"),
    lastVerifiedAt: ensureTimestamp(record["lastVerifiedAt"], `${path}.lastVerifiedAt`),
    refreshAfter: ensureTimestamp(record["refreshAfter"], `${path}.refreshAfter`)
  });
}

function parseAdapter(value: unknown, path: string): GatewayCandidateEvidence["adapter"] {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["packageName", "profileId", "version"], path);
  return Object.freeze({
    packageName: ensureEnum(record["packageName"], `${path}.packageName`, GATEWAY_ADAPTER_PACKAGES),
    profileId: ensureString(record["profileId"], `${path}.profileId`, {
      maxLength: 128,
      pattern: SAFE_ID,
      patternName: "profile identifier"
    }),
    version: ensureString(record["version"], `${path}.version`, {
      minLength: 1,
      maxLength: 64,
      pattern: SAFE_ID,
      patternName: "adapter version"
    })
  });
}

export function gatewayCandidateEvidenceFingerprint(
  value: Omit<GatewayCandidateEvidence, "fingerprint">
): string {
  return digest(value);
}

export function parseGatewayCandidateEvidence(
  value: unknown,
  path = "gatewayEvidence"
): GatewayCandidateEvidence {
  const record = ensureRecord(value, path);
  const keys = [
    "schemaVersion", "gatewaySnapshotFingerprint", "instanceId", "contractModelId", "catalog",
    "descriptor", "model", "eligibility", "userPreference", "adapter", "fingerprint"
  ] as const;
  ensureExactKeys(record, keys, path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, ROUTING_EVIDENCE_SCHEMA_VERSION);
  const unsigned = Object.freeze({
    schemaVersion: ROUTING_EVIDENCE_SCHEMA_VERSION,
    gatewaySnapshotFingerprint: fingerprint(
      record["gatewaySnapshotFingerprint"],
      `${path}.gatewaySnapshotFingerprint`
    ),
    instanceId: ensureString(record["instanceId"], `${path}.instanceId`, {
      maxLength: 128,
      pattern: SAFE_ID,
      patternName: "provider instance identifier"
    }),
    contractModelId: ensureString(record["contractModelId"], `${path}.contractModelId`, {
      maxLength: 128,
      pattern: SAFE_ID,
      patternName: "contract model identifier"
    }),
    catalog: parseGatewayCatalogReference(record["catalog"], `${path}.catalog`),
    descriptor: parseProviderDescriptor(record["descriptor"], `${path}.descriptor`),
    model: parseModelDescriptor(record["model"], `${path}.model`),
    eligibility: ensureEnum(
      record["eligibility"],
      `${path}.eligibility`,
      ["any", "verified-free-only"] as const
    ),
    userPreference: ensureEnum(
      record["userPreference"],
      `${path}.userPreference`,
      ["enabled", "disabled"] as const
    ),
    adapter: parseAdapter(record["adapter"], `${path}.adapter`)
  });
  if (
    unsigned.instanceId !== unsigned.descriptor.instanceId ||
    unsigned.catalog.providerId !== unsigned.descriptor.providerId ||
    unsigned.contractModelId !== unsigned.model.model.modelId ||
    unsigned.model.model.providerId !== unsigned.descriptor.providerId ||
    unsigned.adapter.profileId !== unsigned.catalog.adapterProfileId
  ) {
    fail(path, "gateway_identity_mismatch", "gateway identities and descriptors must agree.");
  }
  const resultFingerprint = fingerprint(record["fingerprint"], `${path}.fingerprint`);
  if (gatewayCandidateEvidenceFingerprint(unsigned) !== resultFingerprint) {
    fail(`${path}.fingerprint`, "fingerprint_mismatch", "does not match gateway evidence.");
  }
  return Object.freeze({ ...unsigned, fingerprint: resultFingerprint });
}

export function createGatewayCandidateEvidence(
  value: GatewayInstanceSnapshot | unknown
): GatewayCandidateEvidence {
  const record = ensureRecord(value, "gatewaySnapshot");
  const keys = [
    "schemaVersion", "instanceId", "contractModelId", "catalog", "descriptor", "model",
    "secretRefFingerprint", "eligibility", "userPreference", "adapter", "fingerprint"
  ] as const;
  ensureExactKeys(record, keys, "gatewaySnapshot");
  ensureSchemaVersion(
    record["schemaVersion"],
    "gatewaySnapshot.schemaVersion",
    PROVIDER_GATEWAY_SCHEMA_VERSION
  );
  const secretRefFingerprint = fingerprint(
    record["secretRefFingerprint"],
    "gatewaySnapshot.secretRefFingerprint"
  );
  const gatewayBase = Object.freeze({
    schemaVersion: PROVIDER_GATEWAY_SCHEMA_VERSION,
    instanceId: ensureString(record["instanceId"], "gatewaySnapshot.instanceId", {
      maxLength: 128,
      pattern: SAFE_ID,
      patternName: "provider instance identifier"
    }),
    contractModelId: ensureString(record["contractModelId"], "gatewaySnapshot.contractModelId", {
      maxLength: 128,
      pattern: SAFE_ID,
      patternName: "contract model identifier"
    }),
    catalog: parseGatewayCatalogReference(record["catalog"], "gatewaySnapshot.catalog"),
    descriptor: parseProviderDescriptor(record["descriptor"], "gatewaySnapshot.descriptor"),
    model: parseModelDescriptor(record["model"], "gatewaySnapshot.model"),
    secretRefFingerprint,
    eligibility: ensureEnum(
      record["eligibility"],
      "gatewaySnapshot.eligibility",
      ["any", "verified-free-only"] as const
    ),
    userPreference: ensureEnum(
      record["userPreference"],
      "gatewaySnapshot.userPreference",
      ["enabled", "disabled"] as const
    ),
    adapter: parseAdapter(record["adapter"], "gatewaySnapshot.adapter")
  });
  const sourceFingerprint = fingerprint(record["fingerprint"], "gatewaySnapshot.fingerprint");
  if (digest(gatewayBase) !== sourceFingerprint) {
    fail("gatewaySnapshot.fingerprint", "fingerprint_mismatch", "does not match gateway snapshot.");
  }
  const unsigned = Object.freeze({
    schemaVersion: ROUTING_EVIDENCE_SCHEMA_VERSION,
    gatewaySnapshotFingerprint: sourceFingerprint,
    instanceId: gatewayBase.instanceId,
    contractModelId: gatewayBase.contractModelId,
    catalog: gatewayBase.catalog,
    descriptor: gatewayBase.descriptor,
    model: gatewayBase.model,
    eligibility: gatewayBase.eligibility,
    userPreference: gatewayBase.userPreference,
    adapter: gatewayBase.adapter
  });
  return parseGatewayCandidateEvidence({
    ...unsigned,
    fingerprint: gatewayCandidateEvidenceFingerprint(unsigned)
  });
}

export interface CatalogCapabilityEvidence {
  readonly id: CatalogCapabilityId;
  readonly status: CapabilityStatus;
}

export interface CatalogCandidateEvidence {
  readonly schemaVersion: typeof ROUTING_EVIDENCE_SCHEMA_VERSION;
  readonly catalogId: string;
  readonly catalogRevision: number;
  readonly catalogFingerprint: string;
  readonly generatedAt: string;
  readonly providerId: string;
  readonly providerFingerprint: string;
  readonly providerState: CatalogEntryState;
  readonly providerRefreshAfter: string;
  readonly modelId: string;
  readonly modelFingerprint: string;
  readonly modelState: CatalogEntryState;
  readonly modelRefreshAfter: string;
  readonly adapterProfileId: string;
  readonly freeTierState: FreeTierState;
  readonly contextTokens: number | null;
  readonly maximumOutputTokens: number | null;
  readonly capabilities: readonly CatalogCapabilityEvidence[];
  readonly fingerprint: string;
}

export function catalogCandidateEvidenceFingerprint(
  value: Omit<CatalogCandidateEvidence, "fingerprint">
): string {
  return digest(value);
}

function parseCatalogCapabilities(
  value: unknown,
  path: string
): readonly CatalogCapabilityEvidence[] {
  const items = ensureArray(value, path, CAPABILITY_IDS.length).map((raw, index) => {
    const itemPath = `${path}[${index}]`;
    const record = ensureRecord(raw, itemPath);
    ensureExactKeys(record, ["id", "status"], itemPath);
    return Object.freeze({
      id: ensureEnum(record["id"], `${itemPath}.id`, CAPABILITY_IDS),
      status: ensureEnum(record["status"], `${itemPath}.status`, CAPABILITY_STATUSES)
    });
  });
  items.sort((left, right) => compareText(left.id, right.id));
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    fail(path, "duplicate_capability", "catalog capabilities must be unique.");
  }
  return Object.freeze(items);
}

export function parseCatalogCandidateEvidence(
  value: unknown,
  path = "catalogEvidence"
): CatalogCandidateEvidence {
  const record = ensureRecord(value, path);
  const keys = [
    "schemaVersion", "catalogId", "catalogRevision", "catalogFingerprint", "generatedAt",
    "providerId", "providerFingerprint", "providerState", "providerRefreshAfter", "modelId",
    "modelFingerprint", "modelState", "modelRefreshAfter", "adapterProfileId", "freeTierState",
    "contextTokens", "maximumOutputTokens", "capabilities", "fingerprint"
  ] as const;
  ensureExactKeys(record, keys, path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, ROUTING_EVIDENCE_SCHEMA_VERSION);
  const identifier = (key: "catalogId" | "providerId" | "modelId" | "adapterProfileId"): string =>
    ensureString(record[key], `${path}.${key}`, {
      maxLength: 128,
      pattern: SAFE_ID,
      patternName: "identifier"
    });
  const unsigned = Object.freeze({
    schemaVersion: ROUTING_EVIDENCE_SCHEMA_VERSION,
    catalogId: identifier("catalogId"),
    catalogRevision: ensureSafeInteger(
      record["catalogRevision"],
      `${path}.catalogRevision`,
      1,
      Number.MAX_SAFE_INTEGER
    ),
    catalogFingerprint: fingerprint(record["catalogFingerprint"], `${path}.catalogFingerprint`),
    generatedAt: ensureTimestamp(record["generatedAt"], `${path}.generatedAt`),
    providerId: identifier("providerId"),
    providerFingerprint: fingerprint(record["providerFingerprint"], `${path}.providerFingerprint`),
    providerState: ensureEnum(record["providerState"], `${path}.providerState`, CATALOG_ENTRY_STATES),
    providerRefreshAfter: ensureTimestamp(
      record["providerRefreshAfter"],
      `${path}.providerRefreshAfter`
    ),
    modelId: identifier("modelId"),
    modelFingerprint: fingerprint(record["modelFingerprint"], `${path}.modelFingerprint`),
    modelState: ensureEnum(record["modelState"], `${path}.modelState`, CATALOG_ENTRY_STATES),
    modelRefreshAfter: ensureTimestamp(record["modelRefreshAfter"], `${path}.modelRefreshAfter`),
    adapterProfileId: identifier("adapterProfileId"),
    freeTierState: ensureEnum(record["freeTierState"], `${path}.freeTierState`, FREE_TIER_STATES),
    contextTokens: ensureNullable(record["contextTokens"], (raw) =>
      ensureSafeInteger(raw, `${path}.contextTokens`, 1, 1_000_000_000_000)
    ),
    maximumOutputTokens: ensureNullable(record["maximumOutputTokens"], (raw) =>
      ensureSafeInteger(raw, `${path}.maximumOutputTokens`, 1, 1_000_000_000_000)
    ),
    capabilities: parseCatalogCapabilities(record["capabilities"], `${path}.capabilities`)
  });
  const resultFingerprint = fingerprint(record["fingerprint"], `${path}.fingerprint`);
  if (catalogCandidateEvidenceFingerprint(unsigned) !== resultFingerprint) {
    fail(`${path}.fingerprint`, "fingerprint_mismatch", "does not match catalog evidence.");
  }
  return Object.freeze({ ...unsigned, fingerprint: resultFingerprint });
}

export function createCatalogCandidateEvidence(input: {
  readonly catalog: ProviderCatalogSnapshot | unknown;
  readonly providerId: string;
  readonly modelId: string;
}): CatalogCandidateEvidence {
  const catalog = parseProviderCatalog(input.catalog);
  const provider = catalog.providers.find((item) => item.providerId === input.providerId);
  const model = provider?.models.find((item) => item.modelId === input.modelId);
  if (provider === undefined || model === undefined) {
    fail("catalog", "catalog_entry_missing", "provider/model selection is absent from catalog.");
    throw new TypeError("Unreachable catalog selection state.");
  }
  const capabilities = Object.freeze(
    model.capabilities
      .map((item) => Object.freeze({ id: item.id, status: item.status }))
      .sort((left, right) => compareText(left.id, right.id))
  );
  const freeTierState: FreeTierState =
    provider.freeTier.state === "verified" && model.freeTier.state === "verified"
      ? "verified"
      : provider.freeTier.state === "ineligible" || model.freeTier.state === "ineligible"
        ? "ineligible"
        : provider.freeTier.state === "not-free" || model.freeTier.state === "not-free"
          ? "not-free"
          : "unknown";
  const unsigned = Object.freeze({
    schemaVersion: ROUTING_EVIDENCE_SCHEMA_VERSION,
    catalogId: catalog.catalogId,
    catalogRevision: catalog.revision,
    catalogFingerprint: catalog.fingerprint,
    generatedAt: catalog.generatedAt,
    providerId: provider.providerId,
    providerFingerprint: provider.fingerprint,
    providerState: provider.state,
    providerRefreshAfter: provider.verification.refreshAfter,
    modelId: model.modelId,
    modelFingerprint: model.fingerprint,
    modelState: model.state,
    modelRefreshAfter: model.verification.refreshAfter,
    adapterProfileId: provider.adapterProfileId,
    freeTierState,
    contextTokens: model.limits.contextTokens,
    maximumOutputTokens: model.limits.maxOutputTokens,
    capabilities
  });
  return parseCatalogCandidateEvidence({
    ...unsigned,
    fingerprint: catalogCandidateEvidenceFingerprint(unsigned)
  });
}

export const QUOTA_STATES = Object.freeze(["unknown", "available", "limited", "exhausted"] as const);
export type QuotaState = (typeof QUOTA_STATES)[number];
export const QUOTA_DIMENSIONS = Object.freeze([
  "tokens",
  "requests",
  "credits",
  "usage-percentage"
] as const);
export type QuotaDimension = (typeof QUOTA_DIMENSIONS)[number];

export interface QuotaDimensionEvidence {
  readonly dimension: QuotaDimension;
  readonly remaining: number | null;
  readonly limit: number | null;
}

export interface RoutingQuotaEvidence {
  readonly schemaVersion: typeof ROUTING_EVIDENCE_SCHEMA_VERSION;
  readonly providerInstanceId: string;
  readonly contractModelId: string;
  readonly scopeFingerprint: string;
  readonly state: QuotaState;
  readonly completeness: EvidenceCompleteness;
  readonly observedAt: string;
  readonly staleAt: string;
  readonly resetsAt: string | null;
  readonly dimensions: readonly QuotaDimensionEvidence[];
  readonly sourceFingerprint: string;
  readonly correctionFingerprint: string | null;
  readonly fingerprint: string;
}

function parseQuotaDimensions(value: unknown, path: string): readonly QuotaDimensionEvidence[] {
  const items = ensureArray(value, path, QUOTA_DIMENSIONS.length).map((raw, index) => {
    const itemPath = `${path}[${index}]`;
    const record = ensureRecord(raw, itemPath);
    ensureExactKeys(record, ["dimension", "remaining", "limit"], itemPath);
    const remaining = ensureNullable(record["remaining"], (item) =>
      ensureSafeInteger(item, `${itemPath}.remaining`, 0, Number.MAX_SAFE_INTEGER)
    );
    const limit = ensureNullable(record["limit"], (item) =>
      ensureSafeInteger(item, `${itemPath}.limit`, 0, Number.MAX_SAFE_INTEGER)
    );
    if (remaining !== null && limit !== null && remaining > limit) {
      fail(itemPath, "quota_range", "remaining quota cannot exceed its limit.");
    }
    return Object.freeze({
      dimension: ensureEnum(record["dimension"], `${itemPath}.dimension`, QUOTA_DIMENSIONS),
      remaining,
      limit
    });
  });
  items.sort((left, right) => compareText(left.dimension, right.dimension));
  if (new Set(items.map((item) => item.dimension)).size !== items.length) {
    fail(path, "duplicate_dimension", "quota dimensions must be unique.");
  }
  return Object.freeze(items);
}

export function routingQuotaEvidenceFingerprint(
  value: Omit<RoutingQuotaEvidence, "fingerprint">
): string {
  return digest(value);
}

export function parseRoutingQuotaEvidence(
  value: unknown,
  path = "quotaEvidence"
): RoutingQuotaEvidence {
  const record = ensureRecord(value, path);
  const keys = [
    "schemaVersion", "providerInstanceId", "contractModelId", "scopeFingerprint", "state",
    "completeness", "observedAt", "staleAt", "resetsAt", "dimensions", "sourceFingerprint",
    "correctionFingerprint", "fingerprint"
  ] as const;
  ensureExactKeys(record, keys, path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, ROUTING_EVIDENCE_SCHEMA_VERSION);
  const observedAt = ensureTimestamp(record["observedAt"], `${path}.observedAt`);
  const staleAt = ensureTimestamp(record["staleAt"], `${path}.staleAt`);
  if (staleAt < observedAt) fail(`${path}.staleAt`, "bad_freshness", "cannot precede observedAt.");
  const unsigned = Object.freeze({
    schemaVersion: ROUTING_EVIDENCE_SCHEMA_VERSION,
    providerInstanceId: ensureString(
      record["providerInstanceId"],
      `${path}.providerInstanceId`,
      { maxLength: 128, pattern: SAFE_ID, patternName: "provider instance identifier" }
    ),
    contractModelId: ensureString(record["contractModelId"], `${path}.contractModelId`, {
      maxLength: 128,
      pattern: SAFE_ID,
      patternName: "contract model identifier"
    }),
    scopeFingerprint: fingerprint(record["scopeFingerprint"], `${path}.scopeFingerprint`),
    state: ensureEnum(record["state"], `${path}.state`, QUOTA_STATES),
    completeness: ensureEnum(record["completeness"], `${path}.completeness`, EVIDENCE_COMPLETENESS),
    observedAt,
    staleAt,
    resetsAt: ensureNullable(record["resetsAt"], (raw) =>
      ensureTimestamp(raw, `${path}.resetsAt`)
    ),
    dimensions: parseQuotaDimensions(record["dimensions"], `${path}.dimensions`),
    sourceFingerprint: fingerprint(record["sourceFingerprint"], `${path}.sourceFingerprint`),
    correctionFingerprint: ensureNullable(record["correctionFingerprint"], (raw) =>
      fingerprint(raw, `${path}.correctionFingerprint`)
    )
  });
  if (unsigned.state === "unknown" && unsigned.completeness === "complete") {
    fail(path, "unknown_complete", "unknown quota cannot be complete.");
  }
  const resultFingerprint = fingerprint(record["fingerprint"], `${path}.fingerprint`);
  if (routingQuotaEvidenceFingerprint(unsigned) !== resultFingerprint) {
    fail(`${path}.fingerprint`, "fingerprint_mismatch", "does not match quota evidence.");
  }
  return Object.freeze({ ...unsigned, fingerprint: resultFingerprint });
}

export function createRoutingQuotaEvidence(
  value: Omit<RoutingQuotaEvidence, "schemaVersion" | "fingerprint">
): RoutingQuotaEvidence {
  const unsigned = Object.freeze({ schemaVersion: ROUTING_EVIDENCE_SCHEMA_VERSION, ...value });
  return parseRoutingQuotaEvidence({
    ...unsigned,
    fingerprint: routingQuotaEvidenceFingerprint(unsigned)
  });
}

export const CAPACITY_STATES = Object.freeze([
  "healthy",
  "degraded",
  "unavailable",
  "stale",
  "unsupported",
  "unknown"
] as const satisfies readonly TelemetryState[]);
export type RoutingCapacityState = (typeof CAPACITY_STATES)[number];

export interface RoutingCapacityEvidence {
  readonly schemaVersion: typeof ROUTING_EVIDENCE_SCHEMA_VERSION;
  readonly providerInstanceId: string;
  readonly contractModelId: string;
  readonly scopeFingerprint: string;
  readonly state: RoutingCapacityState;
  readonly completeness: EvidenceCompleteness;
  readonly observedAt: string;
  readonly staleAt: string;
  readonly availableConcurrency: number | null;
  readonly availableMemoryBytes: number | null;
  readonly requiredMemoryBytes: number | null;
  readonly sourceFingerprint: string;
  readonly fingerprint: string;
}

export function routingCapacityEvidenceFingerprint(
  value: Omit<RoutingCapacityEvidence, "fingerprint">
): string {
  return digest(value);
}

export function parseRoutingCapacityEvidence(
  value: unknown,
  path = "capacityEvidence"
): RoutingCapacityEvidence {
  const record = ensureRecord(value, path);
  const keys = [
    "schemaVersion", "providerInstanceId", "contractModelId", "scopeFingerprint", "state",
    "completeness", "observedAt", "staleAt", "availableConcurrency", "availableMemoryBytes",
    "requiredMemoryBytes", "sourceFingerprint", "fingerprint"
  ] as const;
  ensureExactKeys(record, keys, path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, ROUTING_EVIDENCE_SCHEMA_VERSION);
  const observedAt = ensureTimestamp(record["observedAt"], `${path}.observedAt`);
  const staleAt = ensureTimestamp(record["staleAt"], `${path}.staleAt`);
  if (staleAt < observedAt) fail(`${path}.staleAt`, "bad_freshness", "cannot precede observedAt.");
  const count = (key: "availableConcurrency" | "availableMemoryBytes" | "requiredMemoryBytes") =>
    ensureNullable(record[key], (raw) =>
      ensureSafeInteger(raw, `${path}.${key}`, 0, Number.MAX_SAFE_INTEGER)
    );
  const unsigned = Object.freeze({
    schemaVersion: ROUTING_EVIDENCE_SCHEMA_VERSION,
    providerInstanceId: ensureString(
      record["providerInstanceId"],
      `${path}.providerInstanceId`,
      { maxLength: 128, pattern: SAFE_ID, patternName: "provider instance identifier" }
    ),
    contractModelId: ensureString(record["contractModelId"], `${path}.contractModelId`, {
      maxLength: 128,
      pattern: SAFE_ID,
      patternName: "contract model identifier"
    }),
    scopeFingerprint: fingerprint(record["scopeFingerprint"], `${path}.scopeFingerprint`),
    state: ensureEnum(record["state"], `${path}.state`, CAPACITY_STATES),
    completeness: ensureEnum(record["completeness"], `${path}.completeness`, EVIDENCE_COMPLETENESS),
    observedAt,
    staleAt,
    availableConcurrency: count("availableConcurrency"),
    availableMemoryBytes: count("availableMemoryBytes"),
    requiredMemoryBytes: count("requiredMemoryBytes"),
    sourceFingerprint: fingerprint(record["sourceFingerprint"], `${path}.sourceFingerprint`)
  });
  const resultFingerprint = fingerprint(record["fingerprint"], `${path}.fingerprint`);
  if (routingCapacityEvidenceFingerprint(unsigned) !== resultFingerprint) {
    fail(`${path}.fingerprint`, "fingerprint_mismatch", "does not match capacity evidence.");
  }
  return Object.freeze({ ...unsigned, fingerprint: resultFingerprint });
}

export function createRoutingCapacityEvidence(
  value: Omit<RoutingCapacityEvidence, "schemaVersion" | "fingerprint">
): RoutingCapacityEvidence {
  const unsigned = Object.freeze({ schemaVersion: ROUTING_EVIDENCE_SCHEMA_VERSION, ...value });
  return parseRoutingCapacityEvidence({
    ...unsigned,
    fingerprint: routingCapacityEvidenceFingerprint(unsigned)
  });
}

export interface CandidatePolicyEvidence {
  readonly outcome: "allowed" | "denied" | "conditional";
  readonly decisionFingerprint: string;
  readonly classification: DataClassification;
  readonly requiredLocality: "local" | "any";
  readonly inputLoggingAllowed: boolean;
  readonly outputLoggingAllowed: boolean;
  readonly retentionAllowed: boolean;
  readonly authority: "none";
  readonly fingerprint: string;
}

export function candidatePolicyEvidenceFingerprint(
  value: Omit<CandidatePolicyEvidence, "fingerprint">
): string {
  return digest(value);
}

export function parseCandidatePolicyEvidence(
  value: unknown,
  path = "policyEvidence"
): CandidatePolicyEvidence {
  const record = ensureRecord(value, path);
  const keys = [
    "outcome", "decisionFingerprint", "classification", "requiredLocality", "inputLoggingAllowed",
    "outputLoggingAllowed", "retentionAllowed", "authority", "fingerprint"
  ] as const;
  ensureExactKeys(record, keys, path);
  const unsigned = Object.freeze({
    outcome: ensureEnum(record["outcome"], `${path}.outcome`, ["allowed", "denied", "conditional"] as const),
    decisionFingerprint: fingerprint(record["decisionFingerprint"], `${path}.decisionFingerprint`),
    classification: ensureEnum(record["classification"], `${path}.classification`, DATA_CLASSIFICATIONS),
    requiredLocality: ensureEnum(
      record["requiredLocality"],
      `${path}.requiredLocality`,
      ["local", "any"] as const
    ),
    inputLoggingAllowed: ensureBoolean(
      record["inputLoggingAllowed"],
      `${path}.inputLoggingAllowed`
    ),
    outputLoggingAllowed: ensureBoolean(
      record["outputLoggingAllowed"],
      `${path}.outputLoggingAllowed`
    ),
    retentionAllowed: ensureBoolean(record["retentionAllowed"], `${path}.retentionAllowed`),
    authority: ensureEnum(record["authority"], `${path}.authority`, ["none"] as const)
  });
  const resultFingerprint = fingerprint(record["fingerprint"], `${path}.fingerprint`);
  if (candidatePolicyEvidenceFingerprint(unsigned) !== resultFingerprint) {
    fail(`${path}.fingerprint`, "fingerprint_mismatch", "does not match policy evidence.");
  }
  return Object.freeze({ ...unsigned, fingerprint: resultFingerprint });
}

export function createCandidatePolicyEvidence(
  value: Omit<CandidatePolicyEvidence, "fingerprint">
): CandidatePolicyEvidence {
  return parseCandidatePolicyEvidence({
    ...value,
    fingerprint: candidatePolicyEvidenceFingerprint(value)
  });
}

export const SECURE_EXECUTION_LEVELS = Object.freeze([
  "secure-enforcing",
  "advisory",
  "none"
] as const);
export type SecureExecutionLevel = (typeof SECURE_EXECUTION_LEVELS)[number];

export interface SecureExecutionEvidence {
  readonly level: SecureExecutionLevel;
  readonly sourceFingerprint: string;
  readonly verifiedAt: string;
  readonly fingerprint: string;
}

export function secureExecutionEvidenceFingerprint(
  value: Omit<SecureExecutionEvidence, "fingerprint">
): string {
  return digest(value);
}

export function parseSecureExecutionEvidence(
  value: unknown,
  path = "secureExecutionEvidence"
): SecureExecutionEvidence {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["level", "sourceFingerprint", "verifiedAt", "fingerprint"], path);
  const unsigned = Object.freeze({
    level: ensureEnum(record["level"], `${path}.level`, SECURE_EXECUTION_LEVELS),
    sourceFingerprint: fingerprint(record["sourceFingerprint"], `${path}.sourceFingerprint`),
    verifiedAt: ensureTimestamp(record["verifiedAt"], `${path}.verifiedAt`)
  });
  const resultFingerprint = fingerprint(record["fingerprint"], `${path}.fingerprint`);
  if (secureExecutionEvidenceFingerprint(unsigned) !== resultFingerprint) {
    fail(`${path}.fingerprint`, "fingerprint_mismatch", "does not match secure execution evidence.");
  }
  return Object.freeze({ ...unsigned, fingerprint: resultFingerprint });
}

export function createSecureExecutionEvidence(
  value: Omit<SecureExecutionEvidence, "fingerprint">
): SecureExecutionEvidence {
  return parseSecureExecutionEvidence({
    ...value,
    fingerprint: secureExecutionEvidenceFingerprint(value)
  });
}

export interface RoutingCandidateSnapshot {
  readonly schemaVersion: typeof ROUTING_CANDIDATE_SCHEMA_VERSION;
  readonly candidateId: string;
  readonly gateway: GatewayCandidateEvidence;
  readonly catalog: CatalogCandidateEvidence;
  readonly policy: CandidatePolicyEvidence;
  readonly health: ProviderHealth;
  readonly healthFingerprint: string;
  readonly quota: RoutingQuotaEvidence;
  readonly capacity: RoutingCapacityEvidence;
  readonly tokenEstimate: TokenEstimate;
  readonly costEstimate: RoutingCostEstimate;
  readonly circuit: CircuitBreakerState;
  readonly secureExecution: SecureExecutionEvidence;
  readonly expectedLatencyMs: number | null;
  readonly evidenceObservedAt: string;
  readonly fingerprint: string;
}

export function routingCandidateFingerprint(
  value: Omit<RoutingCandidateSnapshot, "fingerprint">
): string {
  return digest(value);
}

export function parseRoutingCandidate(
  value: unknown,
  path = "routingCandidate"
): RoutingCandidateSnapshot {
  const record = ensureRecord(value, path);
  const keys = [
    "schemaVersion", "candidateId", "gateway", "catalog", "policy", "health",
    "healthFingerprint", "quota", "capacity", "tokenEstimate", "costEstimate", "circuit",
    "secureExecution", "expectedLatencyMs", "evidenceObservedAt", "fingerprint"
  ] as const;
  ensureExactKeys(record, keys, path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, ROUTING_CANDIDATE_SCHEMA_VERSION);
  const gateway = parseGatewayCandidateEvidence(record["gateway"], `${path}.gateway`);
  const catalog = parseCatalogCandidateEvidence(record["catalog"], `${path}.catalog`);
  const health = parseProviderHealth(record["health"], `${path}.health`);
  const quota = parseRoutingQuotaEvidence(record["quota"], `${path}.quota`);
  const capacity = parseRoutingCapacityEvidence(record["capacity"], `${path}.capacity`);
  const circuit = parseCircuitBreakerState(record["circuit"], `${path}.circuit`);
  const unsigned = Object.freeze({
    schemaVersion: ROUTING_CANDIDATE_SCHEMA_VERSION,
    candidateId: ensureString(record["candidateId"], `${path}.candidateId`, {
      maxLength: 128,
      pattern: SAFE_ID,
      patternName: "candidate identifier"
    }),
    gateway,
    catalog,
    policy: parseCandidatePolicyEvidence(record["policy"], `${path}.policy`),
    health,
    healthFingerprint: fingerprint(record["healthFingerprint"], `${path}.healthFingerprint`),
    quota,
    capacity,
    tokenEstimate: parseTokenEstimate(record["tokenEstimate"], `${path}.tokenEstimate`),
    costEstimate: parseRoutingCostEstimate(record["costEstimate"], `${path}.costEstimate`),
    circuit,
    secureExecution: parseSecureExecutionEvidence(
      record["secureExecution"],
      `${path}.secureExecution`
    ),
    expectedLatencyMs: ensureNullable(record["expectedLatencyMs"], (raw) =>
      ensureSafeInteger(raw, `${path}.expectedLatencyMs`, 0, 10_000_000_000_000)
    ),
    evidenceObservedAt: ensureTimestamp(record["evidenceObservedAt"], `${path}.evidenceObservedAt`)
  });
  if (digest(health) !== unsigned.healthFingerprint) {
    fail(`${path}.healthFingerprint`, "fingerprint_mismatch", "does not match health snapshot.");
  }
  if (
    gateway.catalog.catalogFingerprint !== catalog.catalogFingerprint ||
    gateway.catalog.providerFingerprint !== catalog.providerFingerprint ||
    gateway.catalog.modelFingerprint !== catalog.modelFingerprint ||
    gateway.catalog.providerId !== catalog.providerId ||
    gateway.catalog.modelId !== catalog.modelId ||
    gateway.catalog.adapterProfileId !== catalog.adapterProfileId ||
    gateway.instanceId !== quota.providerInstanceId ||
    gateway.contractModelId !== quota.contractModelId ||
    gateway.instanceId !== capacity.providerInstanceId ||
    gateway.contractModelId !== capacity.contractModelId ||
    gateway.instanceId !== circuit.identity.providerInstanceId ||
    gateway.contractModelId !== circuit.identity.contractModelId ||
    gateway.contractModelId !== unsigned.tokenEstimate.contractModelId ||
    gateway.catalog.modelFingerprint !== unsigned.tokenEstimate.catalogModelFingerprint
  ) {
    fail(path, "candidate_identity_mismatch", "candidate evidence belongs to different identities.");
  }
  const resultFingerprint = fingerprint(record["fingerprint"], `${path}.fingerprint`);
  if (routingCandidateFingerprint(unsigned) !== resultFingerprint) {
    fail(`${path}.fingerprint`, "fingerprint_mismatch", "does not match candidate evidence.");
  }
  return Object.freeze({ ...unsigned, fingerprint: resultFingerprint });
}

export function createRoutingCandidate(
  value: Omit<RoutingCandidateSnapshot, "schemaVersion" | "healthFingerprint" | "fingerprint">
): RoutingCandidateSnapshot {
  const unsigned = Object.freeze({
    schemaVersion: ROUTING_CANDIDATE_SCHEMA_VERSION,
    ...value,
    healthFingerprint: digest(value.health)
  });
  return parseRoutingCandidate({
    ...unsigned,
    fingerprint: routingCandidateFingerprint(unsigned)
  });
}
