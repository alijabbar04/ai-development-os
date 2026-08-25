import { canonicalizeJson, toCanonicalJson, type JsonValue, validation } from "@ai-dev-os/domain";
import {
  API_LIMITS,
  API_PRODUCTION_ENABLED,
  API_SCHEMA_VERSION,
  PROJECTION_CONFIDENCE,
  PROJECTION_STALE_REASONS,
  type ProjectionConfidence,
  type ProjectionStaleReason,
} from "./constants.js";
import { parseApiRefusal, type ApiRefusal } from "./refusals.js";
import { apiFail, ensureExactAndPresent, readSafeRecord } from "./structural.js";

interface EnvelopeBase {
  readonly schemaVersion: typeof API_SCHEMA_VERSION;
  readonly sequence: number;
  readonly serverNow: string;
  readonly productionEnabled: typeof API_PRODUCTION_ENABLED;
}

export interface SuccessEnvelope<T extends JsonValue = JsonValue> extends EnvelopeBase {
  readonly ok: true;
  readonly kind: "success";
  readonly payload: T;
}

export interface ProjectionEnvelope<T extends JsonValue = JsonValue> extends EnvelopeBase {
  readonly ok: true;
  readonly kind: "projection";
  readonly computedAt: string;
  readonly confidence: ProjectionConfidence;
  readonly staleReason: ProjectionStaleReason | null;
  readonly payload: T;
}

export interface RefusalEnvelope extends EnvelopeBase {
  readonly ok: false;
  readonly kind: "refused";
  readonly refusal: ApiRefusal;
}

export type ApiEnvelope<T extends JsonValue = JsonValue> =
  | SuccessEnvelope<T>
  | ProjectionEnvelope<T>
  | RefusalEnvelope;

export type PayloadParser<T extends JsonValue> = (value: unknown, path: string) => T;

function parseBase(record: Record<string, unknown>, path: string): EnvelopeBase {
  validation.ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, API_SCHEMA_VERSION);
  if (record["productionEnabled"] !== API_PRODUCTION_ENABLED) {
    apiFail(`${path}.productionEnabled`, "production_must_be_disabled", "must be false in Stage 20A.");
  }
  return Object.freeze({
    schemaVersion: API_SCHEMA_VERSION,
    sequence: validation.ensureSafeInteger(record["sequence"], `${path}.sequence`, 0, API_LIMITS.maxSequence),
    serverNow: validation.ensureTimestamp(record["serverNow"], `${path}.serverNow`),
    productionEnabled: API_PRODUCTION_ENABLED,
  });
}

function parsePayload<T extends JsonValue>(value: unknown, path: string, parser: PayloadParser<T>): T {
  const parsed = parser(value, path);
  return canonicalizeJson(parsed, path) as T;
}

export function parseSuccessEnvelope<T extends JsonValue>(
  value: unknown,
  payloadParser: PayloadParser<T>,
  path = "envelope",
): SuccessEnvelope<T> {
  const record = readSafeRecord(value, path);
  ensureExactAndPresent(record, ["schemaVersion", "sequence", "serverNow", "productionEnabled", "ok", "kind", "payload"], path);
  if (record["ok"] !== true || record["kind"] !== "success") apiFail(path, "wrong_envelope_kind", "must be a success envelope.");
  const base = parseBase(record, path);
  return Object.freeze({
    schemaVersion: base.schemaVersion,
    sequence: base.sequence,
    serverNow: base.serverNow,
    productionEnabled: base.productionEnabled,
    ok: true,
    kind: "success",
    payload: parsePayload(record["payload"], `${path}.payload`, payloadParser),
  });
}

export function parseProjectionEnvelope<T extends JsonValue>(
  value: unknown,
  payloadParser: PayloadParser<T>,
  path = "envelope",
): ProjectionEnvelope<T> {
  const record = readSafeRecord(value, path);
  ensureExactAndPresent(record, ["schemaVersion", "sequence", "serverNow", "productionEnabled", "ok", "kind", "computedAt", "confidence", "staleReason", "payload"], path);
  if (record["ok"] !== true || record["kind"] !== "projection") apiFail(path, "wrong_envelope_kind", "must be a projection envelope.");
  const base = parseBase(record, path);
  const computedAt = validation.ensureTimestamp(record["computedAt"], `${path}.computedAt`);
  if (computedAt > base.serverNow) apiFail(`${path}.computedAt`, "future_projection", "cannot be later than serverNow.");
  const confidence = validation.ensureEnum(record["confidence"], `${path}.confidence`, PROJECTION_CONFIDENCE);
  let staleReason: ProjectionStaleReason | null;
  if (confidence === "current") {
    if (record["staleReason"] !== null) apiFail(`${path}.staleReason`, "current_has_stale_reason", "must be null when confidence is current.");
    staleReason = null;
  } else {
    staleReason = validation.ensureEnum(record["staleReason"], `${path}.staleReason`, PROJECTION_STALE_REASONS);
  }
  return Object.freeze({
    schemaVersion: base.schemaVersion,
    sequence: base.sequence,
    serverNow: base.serverNow,
    productionEnabled: base.productionEnabled,
    ok: true,
    kind: "projection",
    computedAt,
    confidence,
    staleReason,
    payload: parsePayload(record["payload"], `${path}.payload`, payloadParser),
  });
}

export function parseRefusalEnvelope(value: unknown, path = "envelope"): RefusalEnvelope {
  const record = readSafeRecord(value, path);
  ensureExactAndPresent(record, ["schemaVersion", "sequence", "serverNow", "productionEnabled", "ok", "kind", "refusal"], path);
  if (record["ok"] !== false || record["kind"] !== "refused") apiFail(path, "wrong_envelope_kind", "must be a refusal envelope.");
  const base = parseBase(record, path);
  return Object.freeze({
    schemaVersion: base.schemaVersion,
    sequence: base.sequence,
    serverNow: base.serverNow,
    productionEnabled: base.productionEnabled,
    ok: false,
    kind: "refused",
    refusal: parseApiRefusal(record["refusal"], `${path}.refusal`),
  });
}

export function assertMonotonicSequence(previous: number, next: number): number {
  const prior = validation.ensureSafeInteger(previous, "previousSequence", 0, API_LIMITS.maxSequence);
  const candidate = validation.ensureSafeInteger(next, "nextSequence", 0, API_LIMITS.maxSequence);
  if (candidate <= prior) apiFail("nextSequence", "sequence_not_monotonic", "must be greater than the previous sequence.");
  return candidate;
}

export function serializeApiEnvelope(envelope: ApiEnvelope): string {
  return toCanonicalJson(envelope, "envelope");
}
