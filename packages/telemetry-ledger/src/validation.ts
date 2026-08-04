import { validation } from "@ai-dev-os/domain";
import { canonicalTelemetryValue, observationPayloadFingerprint, telemetrySnapshotFingerprint } from "./fingerprint.js";
import {
  TELEMETRY_ALGORITHM_VERSION,
  TELEMETRY_OBSERVATION_KINDS,
  TELEMETRY_SCHEMA_VERSION,
  type CapacityData,
  type CostComponent,
  type ForecastData,
  type NormalizedTokenUsage,
  type ProviderIdentity,
  type QuotaWindowData,
  type TelemetryDimension,
  type TelemetryObservation,
  type TelemetryObservationDraft,
  type TelemetryProvenance,
  type TelemetryScope,
  type TelemetrySource,
  type TelemetryState,
  type TelemetryWindow,
} from "./types.js";

const { ensureArray, ensureEnum, ensureExactKeys, ensureNullable, ensureRecord, ensureSafeInteger, ensureString, ensureTimestamp } = validation;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)?$/u;
const CODE = /^[a-z][a-z0-9._-]{0,63}$/u;
const HEX = /^[a-f0-9]{64}$/u;
const MAX_COUNT = 1_000_000_000_000;
const STATES = ["available", "limited", "exhausted", "healthy", "degraded", "unavailable", "stale", "unsupported", "unknown"] as const;
const WINDOWS = ["rolling", "fixed", "daily", "five-hour", "seven-day", "primary", "secondary", "provider-defined"] as const;
const DIMENSIONS = ["tokens", "requests", "concurrency", "memory-bytes", "credits", "usage-percentage"] as const;

function id(value: unknown, path: string): string {
  return ensureString(value, path, { maxLength: 128, pattern: ID, patternName: "telemetry identifier" });
}

function nullableId(value: unknown, path: string): string | null {
  return ensureNullable(value, (item) => id(item, path));
}

function nullableTimestamp(value: unknown, path: string): string | null {
  return ensureNullable(value, (item) => ensureTimestamp(item, path));
}

function nullableCount(value: unknown, path: string): number | null {
  return ensureNullable(value, (item) => ensureSafeInteger(item, path, 0, MAX_COUNT));
}

function parseScope(value: unknown, path: string): TelemetryScope {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, ["organizationId", "userId", "projectId", "workspaceId", "taskId", "runId"], path);
  return canonicalTelemetryValue({
    organizationId: nullableId(input["organizationId"], `${path}.organizationId`),
    userId: nullableId(input["userId"], `${path}.userId`),
    projectId: nullableId(input["projectId"], `${path}.projectId`),
    workspaceId: nullableId(input["workspaceId"], `${path}.workspaceId`),
    taskId: nullableId(input["taskId"], `${path}.taskId`),
    runId: nullableId(input["runId"], `${path}.runId`),
  });
}

function modelId(value: unknown, path: string): string | null {
  return ensureNullable(value, (item) => ensureString(item, path, { maxLength: 128, pattern: MODEL, patternName: "model identifier" }));
}

function parseIdentity(value: unknown, path: string): ProviderIdentity {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, [
    "providerKind", "providerId", "configuredInstanceId", "contractModelId", "upstreamModelId",
    "adapterPackage", "adapterProfile", "adapterVersion", "catalogFingerprint", "providerFingerprint",
    "modelFingerprint", "authenticationClass", "billingClass",
  ], path);
  const fingerprint = (key: string): string | null => ensureNullable(input[key], (item) =>
    ensureString(item, `${path}.${key}`, { maxLength: 64, pattern: HEX, patternName: "SHA-256 fingerprint" }),
  );
  return canonicalTelemetryValue({
    providerKind: ensureEnum(input["providerKind"], `${path}.providerKind`, ["inference", "coding-agent", "local-capacity"] as const),
    providerId: id(input["providerId"], `${path}.providerId`),
    configuredInstanceId: id(input["configuredInstanceId"], `${path}.configuredInstanceId`),
    contractModelId: modelId(input["contractModelId"], `${path}.contractModelId`),
    upstreamModelId: modelId(input["upstreamModelId"], `${path}.upstreamModelId`),
    adapterPackage: ensureString(input["adapterPackage"], `${path}.adapterPackage`, { maxLength: 128, pattern: /^@[a-z0-9-]+\/[a-z0-9-]+$/u, patternName: "package name" }),
    adapterProfile: id(input["adapterProfile"], `${path}.adapterProfile`),
    adapterVersion: ensureString(input["adapterVersion"], `${path}.adapterVersion`, { maxLength: 32, pattern: /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u, patternName: "package version" }),
    catalogFingerprint: fingerprint("catalogFingerprint"),
    providerFingerprint: fingerprint("providerFingerprint"),
    modelFingerprint: fingerprint("modelFingerprint"),
    authenticationClass: ensureEnum(input["authenticationClass"], `${path}.authenticationClass`, ["api-key", "subscription", "cloud-credential", "local", "unknown"] as const),
    billingClass: ensureEnum(input["billingClass"], `${path}.billingClass`, ["metered", "subscription", "local-operator", "unknown"] as const),
  });
}

function parseSource(value: unknown, path: string): TelemetrySource {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, ["category", "sourceObservationId"], path);
  return canonicalTelemetryValue({
    category: ensureEnum(input["category"], `${path}.category`, ["provider-reported", "provider-api", "response-headers", "host-supplied", "operator", "adapter-derived", "ledger-derived", "unobserved"] as const),
    sourceObservationId: id(input["sourceObservationId"], `${path}.sourceObservationId`),
  });
}

function parseProvenance(value: unknown, path: string): TelemetryProvenance {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, ["sourceFingerprint", "pricingSource", "pricingEffectiveAt", "derivation", "sampleObservationIds"], path);
  const samples = ensureArray(input["sampleObservationIds"], `${path}.sampleObservationIds`, 1_000).map((item, index) =>
    id(item, `${path}.sampleObservationIds[${index}]`),
  );
  if (new Set(samples).size !== samples.length) validation.fail(`${path}.sampleObservationIds`, "duplicate_sample", "must contain unique identifiers.");
  return canonicalTelemetryValue({
    sourceFingerprint: ensureString(input["sourceFingerprint"], `${path}.sourceFingerprint`, { maxLength: 64, pattern: HEX, patternName: "SHA-256 fingerprint" }),
    pricingSource: ensureNullable(input["pricingSource"], (item) => ensureString(item, `${path}.pricingSource`, { maxLength: 128, pattern: ID, patternName: "pricing source identifier" })),
    pricingEffectiveAt: nullableTimestamp(input["pricingEffectiveAt"], `${path}.pricingEffectiveAt`),
    derivation: ensureNullable(input["derivation"], (item) => ensureString(item, `${path}.derivation`, { maxLength: 64, pattern: CODE, patternName: "derivation code" })),
    sampleObservationIds: samples,
  });
}

export function parseNormalizedTokenUsage(value: unknown, path = "usage"): NormalizedTokenUsage {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, ["uncachedInputTokens", "cacheWriteInputTokens", "cachedReadInputTokens", "visibleOutputTokens", "reasoningTokens", "unknownCombinedTokens", "toolCalls", "categoryCompleteness"], path);
  const result = {
    uncachedInputTokens: ensureSafeInteger(input["uncachedInputTokens"], `${path}.uncachedInputTokens`, 0, MAX_COUNT),
    cacheWriteInputTokens: ensureSafeInteger(input["cacheWriteInputTokens"], `${path}.cacheWriteInputTokens`, 0, MAX_COUNT),
    cachedReadInputTokens: ensureSafeInteger(input["cachedReadInputTokens"], `${path}.cachedReadInputTokens`, 0, MAX_COUNT),
    visibleOutputTokens: ensureSafeInteger(input["visibleOutputTokens"], `${path}.visibleOutputTokens`, 0, MAX_COUNT),
    reasoningTokens: ensureSafeInteger(input["reasoningTokens"], `${path}.reasoningTokens`, 0, MAX_COUNT),
    unknownCombinedTokens: ensureSafeInteger(input["unknownCombinedTokens"], `${path}.unknownCombinedTokens`, 0, MAX_COUNT),
    toolCalls: ensureSafeInteger(input["toolCalls"], `${path}.toolCalls`, 0, 1_000_000_000),
    categoryCompleteness: ensureEnum(input["categoryCompleteness"], `${path}.categoryCompleteness`, ["exact", "generic-four-category", "partial"] as const),
  };
  const total = Object.entries(result).filter((entry): entry is [string, number] => typeof entry[1] === "number").reduce((sum, entry) => sum + entry[1], 0);
  if (!Number.isSafeInteger(total)) validation.fail(path, "usage_overflow", "token category total exceeds safe integer range.");
  return canonicalTelemetryValue(result);
}

function parseCostComponent(value: unknown, path: string): CostComponent {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, ["componentId", "semanticClass", "currency", "amountMicros", "authority", "priceSourceFingerprint", "priceEffectiveAt"], path);
  const semanticClass = ensureEnum(input["semanticClass"], `${path}.semanticClass`, ["provider-billed", "locally-computed-estimate", "subscription-equivalent-estimate", "verified-zero", "unknown"] as const);
  const currency = ensureNullable(input["currency"], (item) => ensureString(item, `${path}.currency`, { maxLength: 3, pattern: /^[A-Z]{3}$/u, patternName: "currency code" }));
  const amountMicros = nullableCount(input["amountMicros"], `${path}.amountMicros`);
  if (semanticClass === "unknown" ? currency !== null || amountMicros !== null : currency === null || amountMicros === null) {
    validation.fail(path, "cost_semantic_mismatch", "known costs require money and unknown costs must not carry money.");
  }
  if (semanticClass === "verified-zero" && amountMicros !== 0) validation.fail(path, "nonzero_verified_zero", "verified-zero must have an amount of zero.");
  return canonicalTelemetryValue({
    componentId: id(input["componentId"], `${path}.componentId`), semanticClass, currency, amountMicros,
    authority: ensureEnum(input["authority"], `${path}.authority`, ["billing", "planning", "evidence", "none"] as const),
    priceSourceFingerprint: ensureNullable(input["priceSourceFingerprint"], (item) => ensureString(item, `${path}.priceSourceFingerprint`, { maxLength: 64, pattern: HEX, patternName: "SHA-256 fingerprint" })),
    priceEffectiveAt: nullableTimestamp(input["priceEffectiveAt"], `${path}.priceEffectiveAt`),
  });
}

function parseState(value: unknown, path: string): TelemetryState { return ensureEnum(value, path, STATES); }
function parseWindow(value: unknown, path: string): TelemetryWindow { return ensureEnum(value, path, WINDOWS); }
function parseDimension(value: unknown, path: string): TelemetryDimension { return ensureEnum(value, path, DIMENSIONS); }

function parseQuota(value: unknown, path: string): QuotaWindowData {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, ["state", "dimension", "window", "providerWindowId", "remaining", "limit", "usedBasisPoints", "remainingBasisPoints", "durationMs"], path);
  const remaining = nullableCount(input["remaining"], `${path}.remaining`);
  const limit = nullableCount(input["limit"], `${path}.limit`);
  if (remaining !== null && limit !== null && remaining > limit) validation.fail(path, "remaining_exceeds_limit", "remaining cannot exceed limit.");
  return canonicalTelemetryValue({
    state: parseState(input["state"], `${path}.state`), dimension: parseDimension(input["dimension"], `${path}.dimension`),
    window: parseWindow(input["window"], `${path}.window`), providerWindowId: nullableId(input["providerWindowId"], `${path}.providerWindowId`),
    remaining, limit,
    usedBasisPoints: ensureNullable(input["usedBasisPoints"], (item) => ensureSafeInteger(item, `${path}.usedBasisPoints`, 0, 10_000)),
    remainingBasisPoints: ensureNullable(input["remainingBasisPoints"], (item) => ensureSafeInteger(item, `${path}.remainingBasisPoints`, 0, 10_000)),
    durationMs: ensureNullable(input["durationMs"], (item) => ensureSafeInteger(item, `${path}.durationMs`, 1, 31_536_000_000)),
  });
}

function parseCapacity(value: unknown, path: string): CapacityData {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, ["state", "dimension", "available", "limit", "queued", "reserved", "window", "providerWindowId"], path);
  const available = nullableCount(input["available"], `${path}.available`);
  const limit = nullableCount(input["limit"], `${path}.limit`);
  if (available !== null && limit !== null && available > limit) validation.fail(path, "available_exceeds_limit", "available cannot exceed limit.");
  return canonicalTelemetryValue({
    state: parseState(input["state"], `${path}.state`), dimension: parseDimension(input["dimension"], `${path}.dimension`), available, limit,
    queued: nullableCount(input["queued"], `${path}.queued`), reserved: nullableCount(input["reserved"], `${path}.reserved`),
    window: ensureNullable(input["window"], (item) => parseWindow(item, `${path}.window`)), providerWindowId: nullableId(input["providerWindowId"], `${path}.providerWindowId`),
  });
}

function parseForecast(value: unknown, path: string): ForecastData {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, ["status", "dimension", "window", "providerWindowId", "estimatedExhaustionAt", "estimatedPostResetAvailableAt", "burnUnitsPerMillionMs", "sampleCount", "sampleFrom", "sampleTo", "confidence", "unavailableReason"], path);
  const status = ensureEnum(input["status"], `${path}.status`, ["available", "unavailable"] as const);
  const exhaustion = nullableTimestamp(input["estimatedExhaustionAt"], `${path}.estimatedExhaustionAt`);
  const burn = nullableCount(input["burnUnitsPerMillionMs"], `${path}.burnUnitsPerMillionMs`);
  const reason = ensureNullable(input["unavailableReason"], (item) => ensureString(item, `${path}.unavailableReason`, { maxLength: 64, pattern: CODE, patternName: "unavailable reason" }));
  if (status === "available" ? exhaustion === null || burn === null || reason !== null : reason === null) validation.fail(path, "forecast_status_mismatch", "forecast availability fields are contradictory.");
  return canonicalTelemetryValue({
    status, dimension: parseDimension(input["dimension"], `${path}.dimension`), window: parseWindow(input["window"], `${path}.window`),
    providerWindowId: nullableId(input["providerWindowId"], `${path}.providerWindowId`), estimatedExhaustionAt: exhaustion,
    estimatedPostResetAvailableAt: nullableTimestamp(input["estimatedPostResetAvailableAt"], `${path}.estimatedPostResetAvailableAt`), burnUnitsPerMillionMs: burn,
    sampleCount: ensureSafeInteger(input["sampleCount"], `${path}.sampleCount`, 0, 1_000), sampleFrom: nullableTimestamp(input["sampleFrom"], `${path}.sampleFrom`), sampleTo: nullableTimestamp(input["sampleTo"], `${path}.sampleTo`),
    confidence: ensureEnum(input["confidence"], `${path}.confidence`, ["high", "medium", "low", "none"] as const), unavailableReason: reason,
  });
}

const COMMON_KEYS = [
  "schemaVersion", "algorithmVersion", "ledgerId", "partitionId", "observationId", "idempotencyKey", "scope", "traceId", "operationId", "parentOperationId", "identity", "source", "observedAt", "ingestedAt", "effectiveFrom", "effectiveUntil", "resetsAt", "staleAt", "terminalAt", "confidence", "provenance", "canonicalPayloadFingerprint", "previousObservationId", "correctedObservationId", "detailCodes", "kind", "data",
] as const;

export function parseTelemetryObservation(value: unknown, path = "telemetryObservation"): TelemetryObservation {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, COMMON_KEYS, path);
  if (input["schemaVersion"] !== TELEMETRY_SCHEMA_VERSION || input["algorithmVersion"] !== TELEMETRY_ALGORITHM_VERSION) validation.fail(path, "unsupported_schema", "observation schema or algorithm is unsupported.");
  const kind = ensureEnum(input["kind"], `${path}.kind`, TELEMETRY_OBSERVATION_KINDS);
  let data: TelemetryObservation["data"];
  const dataPath = `${path}.data`;
  const record = ensureRecord(input["data"], dataPath);
  switch (kind) {
    case "operation-estimate":
      ensureExactKeys(record, ["usage", "reservationId"], dataPath);
      data = canonicalTelemetryValue({ usage: parseNormalizedTokenUsage(record["usage"], `${dataPath}.usage`), reservationId: nullableId(record["reservationId"], `${dataPath}.reservationId`) });
      break;
    case "cumulative-usage":
      ensureExactKeys(record, ["usage", "sequence", "quality"], dataPath);
      data = canonicalTelemetryValue({ usage: parseNormalizedTokenUsage(record["usage"], `${dataPath}.usage`), sequence: ensureSafeInteger(record["sequence"], `${dataPath}.sequence`, 1, Number.MAX_SAFE_INTEGER), quality: ensureEnum(record["quality"], `${dataPath}.quality`, ["partial", "complete"] as const) });
      break;
    case "terminal-reconciliation":
      ensureExactKeys(record, ["usage", "sequence", "outcome", "quality"], dataPath);
      data = canonicalTelemetryValue({ usage: ensureNullable(record["usage"], (item) => parseNormalizedTokenUsage(item, `${dataPath}.usage`)), sequence: ensureNullable(record["sequence"], (item) => ensureSafeInteger(item, `${dataPath}.sequence`, 1, Number.MAX_SAFE_INTEGER)), outcome: ensureEnum(record["outcome"], `${dataPath}.outcome`, ["succeeded", "failed", "cancelled"] as const), quality: ensureEnum(record["quality"], `${dataPath}.quality`, ["complete", "partial", "missing"] as const) });
      break;
    case "cost": {
      ensureExactKeys(record, ["components"], dataPath);
      const components = ensureArray(record["components"], `${dataPath}.components`, 64).map((item, index) => parseCostComponent(item, `${dataPath}.components[${index}]`));
      if (components.length === 0 || new Set(components.map((item) => item.componentId)).size !== components.length) validation.fail(dataPath, "invalid_cost_components", "cost components must be non-empty and uniquely identified.");
      data = canonicalTelemetryValue({ components });
      break;
    }
    case "provider-health":
      ensureExactKeys(record, ["state", "latencyMs"], dataPath);
      data = canonicalTelemetryValue({ state: ensureEnum(record["state"], `${dataPath}.state`, ["healthy", "degraded", "unavailable", "stale", "unknown"] as const), latencyMs: ensureNullable(record["latencyMs"], (item) => ensureSafeInteger(item, `${dataPath}.latencyMs`, 0, 31_536_000_000)) });
      break;
    case "quota-window": data = parseQuota(record, dataPath); break;
    case "capacity": data = parseCapacity(record, dataPath); break;
    case "correction":
      ensureExactKeys(record, ["action", "targetObservationId", "reasonCode"], dataPath);
      data = canonicalTelemetryValue({ action: ensureEnum(record["action"], `${dataPath}.action`, ["supersede", "tombstone"] as const), targetObservationId: id(record["targetObservationId"], `${dataPath}.targetObservationId`), reasonCode: ensureString(record["reasonCode"], `${dataPath}.reasonCode`, { maxLength: 64, pattern: CODE, patternName: "reason code" }) });
      break;
    case "derived-state":
      ensureExactKeys(record, ["stateFingerprint", "throughEventId", "eventCount"], dataPath);
      data = canonicalTelemetryValue({ stateFingerprint: ensureString(record["stateFingerprint"], `${dataPath}.stateFingerprint`, { maxLength: 64, pattern: HEX, patternName: "SHA-256 fingerprint" }), throughEventId: id(record["throughEventId"], `${dataPath}.throughEventId`), eventCount: ensureSafeInteger(record["eventCount"], `${dataPath}.eventCount`, 0, Number.MAX_SAFE_INTEGER) });
      break;
    case "forecast": data = parseForecast(record, dataPath); break;
    case "account-usage":
      ensureExactKeys(record, ["period", "periodStart", "tokens", "status"], dataPath);
      data = canonicalTelemetryValue({
        period: ensureEnum(record["period"], `${dataPath}.period`, ["lifetime", "daily"] as const),
        periodStart: ensureNullable(record["periodStart"], (item) => ensureString(item, `${dataPath}.periodStart`, { maxLength: 10, pattern: /^\d{4}-\d{2}-\d{2}$/u, patternName: "calendar date" })),
        tokens: nullableCount(record["tokens"], `${dataPath}.tokens`),
        status: ensureEnum(record["status"], `${dataPath}.status`, ["reported", "unsupported", "unknown"] as const),
      });
      if (data.status === "reported" && data.tokens === null || data.status !== "reported" && data.tokens !== null) validation.fail(dataPath, "account_usage_status_mismatch", "reported usage requires tokens and other states must remain unknown.");
      break;
  }
  const details = ensureArray(input["detailCodes"], `${path}.detailCodes`, 32).map((item, index) => ensureString(item, `${path}.detailCodes[${index}]`, { maxLength: 64, pattern: CODE, patternName: "detail code" }));
  if (new Set(details).size !== details.length) validation.fail(`${path}.detailCodes`, "duplicate_detail", "detail codes must be unique.");
  const parsed = canonicalTelemetryValue({
    schemaVersion: TELEMETRY_SCHEMA_VERSION, algorithmVersion: TELEMETRY_ALGORITHM_VERSION,
    ledgerId: id(input["ledgerId"], `${path}.ledgerId`), partitionId: id(input["partitionId"], `${path}.partitionId`), observationId: id(input["observationId"], `${path}.observationId`), idempotencyKey: ensureString(input["idempotencyKey"], `${path}.idempotencyKey`, { maxLength: 256, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u, patternName: "idempotency key" }),
    scope: parseScope(input["scope"], `${path}.scope`), traceId: nullableId(input["traceId"], `${path}.traceId`), operationId: nullableId(input["operationId"], `${path}.operationId`), parentOperationId: nullableId(input["parentOperationId"], `${path}.parentOperationId`),
    identity: parseIdentity(input["identity"], `${path}.identity`), source: parseSource(input["source"], `${path}.source`), observedAt: ensureTimestamp(input["observedAt"], `${path}.observedAt`), ingestedAt: ensureTimestamp(input["ingestedAt"], `${path}.ingestedAt`),
    effectiveFrom: nullableTimestamp(input["effectiveFrom"], `${path}.effectiveFrom`), effectiveUntil: nullableTimestamp(input["effectiveUntil"], `${path}.effectiveUntil`), resetsAt: nullableTimestamp(input["resetsAt"], `${path}.resetsAt`), staleAt: nullableTimestamp(input["staleAt"], `${path}.staleAt`), terminalAt: nullableTimestamp(input["terminalAt"], `${path}.terminalAt`),
    confidence: ensureEnum(input["confidence"], `${path}.confidence`, ["reported", "high", "medium", "low", "none"] as const), provenance: parseProvenance(input["provenance"], `${path}.provenance`),
    canonicalPayloadFingerprint: ensureString(input["canonicalPayloadFingerprint"], `${path}.canonicalPayloadFingerprint`, { maxLength: 64, pattern: HEX, patternName: "SHA-256 fingerprint" }), previousObservationId: nullableId(input["previousObservationId"], `${path}.previousObservationId`), correctedObservationId: nullableId(input["correctedObservationId"], `${path}.correctedObservationId`), detailCodes: details.sort(), kind, data,
  }) as TelemetryObservation;
  if (parsed.effectiveFrom !== null && parsed.effectiveUntil !== null && parsed.effectiveFrom > parsed.effectiveUntil) validation.fail(path, "invalid_effective_interval", "effective interval cannot end before it starts.");
  if (parsed.staleAt !== null && parsed.staleAt < parsed.observedAt) validation.fail(path, "invalid_stale_time", "stale time cannot precede observation time.");
  if (observationPayloadFingerprint(parsed) !== parsed.canonicalPayloadFingerprint) validation.fail(`${path}.canonicalPayloadFingerprint`, "fingerprint_mismatch", "observation fingerprint does not match its canonical payload.");
  if (parsed.kind === "correction" && parsed.correctedObservationId !== parsed.data.targetObservationId) validation.fail(path, "correction_link_mismatch", "correction linkage must name its target.");
  return parsed;
}

export function deterministicPartition(
  ledgerId: string,
  observedAt: string,
  durationMs: number,
): { readonly partitionId: string; readonly start: string; readonly end: string } {
  id(ledgerId, "ledgerId");
  const instant = Date.parse(ensureTimestamp(observedAt, "observedAt"));
  ensureSafeInteger(durationMs, "durationMs", 60_000, 31_536_000_000);
  const startMs = Math.floor(instant / durationMs) * durationMs;
  const start = new Date(startMs).toISOString();
  const end = new Date(startMs + durationMs).toISOString();
  const compact = start.replace(/[-:.]/gu, "");
  const identity = telemetrySnapshotFingerprint({ ledgerId, start }).slice(0, 24);
  return canonicalTelemetryValue({ partitionId: `${ledgerId.slice(0, 72)}-${compact}-${identity}`, start, end });
}

export function createTelemetryObservation(
  draft: TelemetryObservationDraft,
  input: { readonly partitionId: string; readonly ingestedAt: string },
): TelemetryObservation {
  const withoutFingerprint = {
    ...draft,
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    algorithmVersion: TELEMETRY_ALGORITHM_VERSION,
    partitionId: input.partitionId,
    ingestedAt: input.ingestedAt,
  } as Omit<TelemetryObservation, "canonicalPayloadFingerprint">;
  const observation = { ...withoutFingerprint, canonicalPayloadFingerprint: observationPayloadFingerprint(withoutFingerprint) };
  return parseTelemetryObservation(observation);
}
