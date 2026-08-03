import { createHash } from "node:crypto";
import { toCanonicalJson, type JsonValue } from "@ai-dev-os/domain";
import {
  CAPABILITY_IDS,
  CAPABILITY_STATUSES,
  CATALOG_ENTRY_STATES,
  FREE_TIER_STATES,
  PROVIDER_CATALOG_SCHEMA_VERSION,
  TRANSPORT_FAMILIES,
  VERIFICATION_STATES,
  type CapabilityClaim,
  type CatalogModel,
  type CatalogProvider,
  type DataPracticeMetadata,
  type EvidenceClaim,
  type FreeTierClaim,
  type ProviderCatalogSnapshot,
  type ProviderDocumentation,
  type ProviderEndpointPolicy,
  type QuotaObservation,
  type UnsignedCatalogModel,
  type UnsignedCatalogProvider,
  type UnsignedProviderCatalogSnapshot,
  type VerificationWindow,
} from "./types.js";

const ID = /^[a-z0-9](?:[a-z0-9._:/-]{0,126}[a-z0-9])?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_TEXT = 2_048;
const MAX_ARRAY = 128;
const MAX_FREE_VERIFICATION_MS = 31 * 24 * 60 * 60 * 1_000;

export type CatalogValidationCode =
  | "INVALID_CATALOG"
  | "UNSUPPORTED_SCHEMA"
  | "FINGERPRINT_MISMATCH"
  | "DUPLICATE_IDENTITY"
  | "AMBIGUOUS_ALIAS"
  | "UNSAFE_ENDPOINT"
  | "UNSAFE_CAPABILITY_ESCALATION"
  | "INVALID_VERIFICATION_WINDOW";

export class CatalogValidationError extends Error {
  readonly code: CatalogValidationCode;
  readonly path: string;

  constructor(code: CatalogValidationCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "CatalogValidationError";
    this.code = code;
    this.path = path;
  }
}

function fail(code: CatalogValidationCode, path: string, message: string): never {
  throw new CatalogValidationError(code, path, message);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("INVALID_CATALOG", path, "must be an object");
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail("INVALID_CATALOG", `${path}.${key}`, "unknown field");
  for (const key of keys) if (!(key in value)) fail("INVALID_CATALOG", `${path}.${key}`, "required field is missing");
}

function string(value: unknown, path: string, max = MAX_TEXT): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) fail("INVALID_CATALOG", path, `must be a non-empty string of at most ${max} characters`);
  return value;
}

function id(value: unknown, path: string): string {
  const parsed = string(value, path, 128);
  if (!ID.test(parsed)) fail("INVALID_CATALOG", path, "must be a normalized stable identity");
  return parsed;
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) fail("INVALID_CATALOG", path, `must be one of ${allowed.join(", ")}`);
  return value as T[number];
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY) fail("INVALID_CATALOG", path, `must be an array with at most ${MAX_ARRAY} items`);
  return value;
}

function strings(value: unknown, path: string): readonly string[] {
  return Object.freeze(array(value, path).map((item, index) => string(item, `${path}[${index}]`)));
}

function identityAliases(value: unknown, path: string): readonly string[] {
  return uniqueNormalized(Object.freeze(array(value, path).map((item, index) => id(item, `${path}[${index}]`))), path);
}

function timestamp(value: unknown, path: string): string {
  const parsed = string(value, path, 64);
  const millis = Date.parse(parsed);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== parsed) fail("INVALID_VERIFICATION_WINDOW", path, "must be a canonical ISO-8601 instant");
  return parsed;
}

function httpsUrl(value: unknown, path: string, originOnly = false): string {
  const raw = string(value, path, 2_048);
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return fail("UNSAFE_ENDPOINT", path, "must be an absolute URL"); }
  if (parsed.protocol !== "https:") fail("UNSAFE_ENDPOINT", path, "must use HTTPS");
  if (parsed.username !== "" || parsed.password !== "") fail("UNSAFE_ENDPOINT", path, "must not contain user-info");
  if (parsed.hostname.includes("*") || parsed.hostname.length === 0) fail("UNSAFE_ENDPOINT", path, "must name an exact host");
  if (parsed.hash !== "") fail("UNSAFE_ENDPOINT", path, "must not contain a fragment");
  if (originOnly && (parsed.pathname !== "/" || parsed.search !== "")) fail("UNSAFE_ENDPOINT", path, "origin must not contain a path or query");
  return originOnly ? parsed.origin : parsed.toString();
}

function pathTemplate(value: unknown, path: string): string {
  const parsed = string(value, path, 256);
  if (!parsed.startsWith("/") || parsed.startsWith("//") || parsed.includes("..") || parsed.includes("?") || parsed.includes("#") || parsed.includes("\\") || parsed.includes("%") || /[\u0000-\u0020\u007f]/u.test(parsed)) {
    fail("UNSAFE_ENDPOINT", path, "must be a fixed absolute path template without traversal, query, fragment, or backslash");
  }
  return parsed;
}

function uniqueNormalized(values: readonly string[], path: string): readonly string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (seen.has(normalized)) fail("AMBIGUOUS_ALIAS", path, `duplicate normalized alias ${normalized}`);
    seen.add(normalized);
  }
  return values;
}

function verification(value: unknown, path: string, freeState?: string): VerificationWindow {
  const input = record(value, path);
  exact(input, ["lastVerifiedAt", "refreshAfter"], path);
  const lastVerifiedAt = timestamp(input["lastVerifiedAt"], `${path}.lastVerifiedAt`);
  const refreshAfter = timestamp(input["refreshAfter"], `${path}.refreshAfter`);
  const duration = Date.parse(refreshAfter) - Date.parse(lastVerifiedAt);
  if (duration <= 0 || (freeState === "verified" && duration > MAX_FREE_VERIFICATION_MS)) {
    fail("INVALID_VERIFICATION_WINDOW", path, "refresh boundary must follow verification and verified free claims may live at most 31 days");
  }
  return Object.freeze({ lastVerifiedAt, refreshAfter });
}

function evidence(value: unknown, path: string): EvidenceClaim {
  const input = record(value, path);
  exact(input, ["state", "evidenceUrl", "note"], path);
  const state = enumValue(input["state"], VERIFICATION_STATES, `${path}.state`);
  const rawUrl = input["evidenceUrl"];
  const evidenceUrl = rawUrl === null ? null : httpsUrl(rawUrl, `${path}.evidenceUrl`);
  if (state === "verified" && evidenceUrl === null) fail("INVALID_CATALOG", `${path}.evidenceUrl`, "verified claims require official evidence");
  return Object.freeze({ state, evidenceUrl, note: string(input["note"], `${path}.note`) });
}

function freeTier(value: unknown, path: string): FreeTierClaim {
  const input = record(value, path);
  exact(input, ["state", "evidenceUrl", "restrictions"], path);
  return Object.freeze({
    state: enumValue(input["state"], FREE_TIER_STATES, `${path}.state`),
    evidenceUrl: httpsUrl(input["evidenceUrl"], `${path}.evidenceUrl`),
    restrictions: strings(input["restrictions"], `${path}.restrictions`),
  });
}

function capability(value: unknown, path: string): CapabilityClaim {
  const input = record(value, path);
  exact(input, ["id", "status", "evidenceUrl", "note"], path);
  const status = enumValue(input["status"], CAPABILITY_STATUSES, `${path}.status`);
  const rawUrl = input["evidenceUrl"];
  const evidenceUrl = rawUrl === null ? null : httpsUrl(rawUrl, `${path}.evidenceUrl`);
  if (status === "supported" && evidenceUrl === null) fail("UNSAFE_CAPABILITY_ESCALATION", `${path}.evidenceUrl`, "supported capability requires official evidence");
  return Object.freeze({
    id: enumValue(input["id"], CAPABILITY_IDS, `${path}.id`),
    status,
    evidenceUrl,
    note: string(input["note"], `${path}.note`),
  });
}

function capabilities(value: unknown, path: string): readonly CapabilityClaim[] {
  const parsed = array(value, path).map((item, index) => capability(item, `${path}[${index}]`));
  const seen = new Set<string>();
  for (const item of parsed) {
    if (seen.has(item.id)) fail("DUPLICATE_IDENTITY", path, `duplicate capability ${item.id}`);
    seen.add(item.id);
  }
  return Object.freeze(parsed);
}

function parseModel(value: unknown, path: string, verifyFingerprint: boolean): CatalogModel {
  const input = record(value, path);
  exact(input, ["schemaVersion", "modelId", "displayName", "aliases", "verification", "freeTier", "capabilities", "restrictions", "limits", "state", "fingerprint"], path);
  if (input["schemaVersion"] !== PROVIDER_CATALOG_SCHEMA_VERSION) fail("UNSUPPORTED_SCHEMA", `${path}.schemaVersion`, "unsupported model schema");
  const free = freeTier(input["freeTier"], `${path}.freeTier`);
  const limitsInput = record(input["limits"], `${path}.limits`);
  exact(limitsInput, ["contextTokens", "maxOutputTokens", "evidenceUrl"], `${path}.limits`);
  const positiveNullable = (raw: unknown, target: string): number | null => {
    if (raw === null) return null;
    if (!Number.isSafeInteger(raw) || (raw as number) <= 0) fail("INVALID_CATALOG", target, "must be a positive safe integer or null");
    return raw as number;
  };
  const aliases = identityAliases(input["aliases"], `${path}.aliases`);
  const modelId = id(input["modelId"], `${path}.modelId`);
  if (aliases.some((alias) => alias.trim().toLowerCase() === modelId)) fail("AMBIGUOUS_ALIAS", `${path}.aliases`, "alias duplicates the model identity");
  const fingerprint = string(input["fingerprint"], `${path}.fingerprint`, 64);
  const parsed: CatalogModel = Object.freeze({
    schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
    modelId,
    displayName: string(input["displayName"], `${path}.displayName`, 256),
    aliases,
    verification: verification(input["verification"], `${path}.verification`, free.state),
    freeTier: free,
    capabilities: capabilities(input["capabilities"], `${path}.capabilities`),
    restrictions: strings(input["restrictions"], `${path}.restrictions`),
    limits: Object.freeze({
      contextTokens: positiveNullable(limitsInput["contextTokens"], `${path}.limits.contextTokens`),
      maxOutputTokens: positiveNullable(limitsInput["maxOutputTokens"], `${path}.limits.maxOutputTokens`),
      evidenceUrl: httpsUrl(limitsInput["evidenceUrl"], `${path}.limits.evidenceUrl`),
    }),
    state: enumValue(input["state"], CATALOG_ENTRY_STATES, `${path}.state`),
    fingerprint,
  });
  if (!SHA256.test(fingerprint)) fail("INVALID_CATALOG", `${path}.fingerprint`, "must be a lowercase SHA-256 digest");
  if (verifyFingerprint && fingerprintCatalogModel(parsed) !== fingerprint) fail("FINGERPRINT_MISMATCH", `${path}.fingerprint`, "model fingerprint does not match its canonical content");
  return parsed;
}

function documentation(value: unknown, path: string): ProviderDocumentation {
  const input = record(value, path);
  const keys = ["api", "terms", "privacy", "pricing", "rateLimits"] as const;
  exact(input, keys, path);
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, httpsUrl(input[key], `${path}.${key}`)])) as unknown as ProviderDocumentation);
}

function endpoint(value: unknown, path: string): ProviderEndpointPolicy {
  const input = record(value, path);
  exact(input, ["origin", "allowedPaths", "redirectPolicy"], path);
  const paths = Object.freeze(array(input["allowedPaths"], `${path}.allowedPaths`).map((item, index) => pathTemplate(item, `${path}.allowedPaths[${index}]`)));
  if (paths.length === 0 || new Set(paths).size !== paths.length) fail("UNSAFE_ENDPOINT", `${path}.allowedPaths`, "must contain distinct allowed paths");
  if (input["redirectPolicy"] !== "reject") fail("UNSAFE_ENDPOINT", `${path}.redirectPolicy`, "redirects must be rejected");
  return Object.freeze({ origin: httpsUrl(input["origin"], `${path}.origin`, true), allowedPaths: paths, redirectPolicy: "reject" });
}

function dataPractices(value: unknown, path: string): DataPracticeMetadata {
  const input = record(value, path);
  const keys = ["regionality", "retention", "training", "storage", "zeroDataRetention"] as const;
  exact(input, keys, path);
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, evidence(input[key], `${path}.${key}`)])) as unknown as DataPracticeMetadata);
}

function quota(value: unknown, path: string): QuotaObservation {
  const input = record(value, path);
  exact(input, ["sourceUrl", "scope", "semantics", "note"], path);
  return Object.freeze({
    sourceUrl: httpsUrl(input["sourceUrl"], `${path}.sourceUrl`),
    scope: enumValue(input["scope"], ["account", "organization", "project", "provider-model"] as const, `${path}.scope`),
    semantics: enumValue(input["semantics"], ["documented-limit", "response-header-observation", "unknown"] as const, `${path}.semantics`),
    note: string(input["note"], `${path}.note`),
  });
}

function parseProvider(value: unknown, path: string, verifyFingerprint: boolean): CatalogProvider {
  const input = record(value, path);
  exact(input, ["schemaVersion", "providerId", "displayName", "aliases", "transportFamily", "adapterProfileId", "documentation", "verification", "authentication", "endpoint", "dataPractices", "freeTier", "quota", "restrictions", "state", "models", "fingerprint"], path);
  if (input["schemaVersion"] !== PROVIDER_CATALOG_SCHEMA_VERSION) fail("UNSUPPORTED_SCHEMA", `${path}.schemaVersion`, "unsupported provider schema");
  const free = freeTier(input["freeTier"], `${path}.freeTier`);
  const auth = record(input["authentication"], `${path}.authentication`);
  exact(auth, ["class", "requiredSecretKind", "delivery"], `${path}.authentication`);
  if (auth["class"] !== "api-key" || auth["requiredSecretKind"] !== "text") fail("INVALID_CATALOG", `${path}.authentication`, "only callback-scoped text API keys are supported");
  const models = Object.freeze(array(input["models"], `${path}.models`).map((item, index) => parseModel(item, `${path}.models[${index}]`, verifyFingerprint)));
  const modelNames = new Map<string, string>();
  for (const model of models) {
    for (const name of [model.modelId, ...model.aliases].map((name) => name.trim().toLowerCase())) {
      const prior = modelNames.get(name);
      if (prior !== undefined) fail(prior === model.modelId ? "DUPLICATE_IDENTITY" : "AMBIGUOUS_ALIAS", `${path}.models`, `${name} identifies both ${prior} and ${model.modelId}`);
      modelNames.set(name, model.modelId);
    }
  }
  const aliases = identityAliases(input["aliases"], `${path}.aliases`);
  const providerId = id(input["providerId"], `${path}.providerId`);
  if (aliases.some((alias) => alias.trim().toLowerCase() === providerId)) fail("AMBIGUOUS_ALIAS", `${path}.aliases`, "alias duplicates provider identity");
  const fingerprint = string(input["fingerprint"], `${path}.fingerprint`, 64);
  const parsed: CatalogProvider = Object.freeze({
    schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
    providerId,
    displayName: string(input["displayName"], `${path}.displayName`, 256),
    aliases,
    transportFamily: enumValue(input["transportFamily"], TRANSPORT_FAMILIES, `${path}.transportFamily`),
    adapterProfileId: id(input["adapterProfileId"], `${path}.adapterProfileId`),
    documentation: documentation(input["documentation"], `${path}.documentation`),
    verification: verification(input["verification"], `${path}.verification`, free.state),
    authentication: Object.freeze({
      class: "api-key",
      requiredSecretKind: "text",
      delivery: enumValue(auth["delivery"], ["bearer", "x-goog-api-key"] as const, `${path}.authentication.delivery`),
    }),
    endpoint: endpoint(input["endpoint"], `${path}.endpoint`),
    dataPractices: dataPractices(input["dataPractices"], `${path}.dataPractices`),
    freeTier: free,
    quota: quota(input["quota"], `${path}.quota`),
    restrictions: strings(input["restrictions"], `${path}.restrictions`),
    state: enumValue(input["state"], CATALOG_ENTRY_STATES, `${path}.state`),
    models,
    fingerprint,
  });
  if (!SHA256.test(fingerprint)) fail("INVALID_CATALOG", `${path}.fingerprint`, "must be a lowercase SHA-256 digest");
  if (verifyFingerprint && fingerprintCatalogProvider(parsed) !== fingerprint) fail("FINGERPRINT_MISMATCH", `${path}.fingerprint`, "provider fingerprint does not match its canonical content");
  return parsed;
}

function withoutFingerprint<T extends { readonly fingerprint: string }>(value: T): Omit<T, "fingerprint"> {
  const { fingerprint: _fingerprint, ...rest } = value;
  return rest;
}

function digest(value: unknown): string {
  return createHash("sha256").update(toCanonicalJson(value as JsonValue)).digest("hex");
}

export function fingerprintCatalogModel(value: CatalogModel | UnsignedCatalogModel): string {
  return digest("fingerprint" in value ? withoutFingerprint(value) : value);
}

export function fingerprintCatalogProvider(value: CatalogProvider | UnsignedCatalogProvider): string {
  return digest("fingerprint" in value ? withoutFingerprint(value) : value);
}

export function fingerprintProviderCatalog(value: ProviderCatalogSnapshot | UnsignedProviderCatalogSnapshot): string {
  return digest("fingerprint" in value ? withoutFingerprint(value) : value);
}

export function createCatalogModel(value: UnsignedCatalogModel): CatalogModel {
  return parseModel({ ...value, fingerprint: fingerprintCatalogModel(value) }, "model", true);
}

export function createCatalogProvider(value: UnsignedCatalogProvider): CatalogProvider {
  const models = value.models.map(createCatalogModel);
  const unsigned = { ...value, models };
  return parseProvider({ ...unsigned, fingerprint: fingerprintCatalogProvider(unsigned) }, "provider", true);
}

export function createProviderCatalog(value: UnsignedProviderCatalogSnapshot): ProviderCatalogSnapshot {
  const providers = value.providers.map(createCatalogProvider);
  const unsigned = { ...value, providers };
  return parseProviderCatalog({ ...unsigned, fingerprint: fingerprintProviderCatalog(unsigned) });
}

export function parseProviderCatalog(value: unknown): ProviderCatalogSnapshot {
  const input = record(value, "catalog");
  exact(input, ["schemaVersion", "catalogId", "revision", "generatedAt", "providers", "fingerprint"], "catalog");
  if (input["schemaVersion"] !== PROVIDER_CATALOG_SCHEMA_VERSION) fail("UNSUPPORTED_SCHEMA", "catalog.schemaVersion", "unsupported catalog schema");
  if (!Number.isSafeInteger(input["revision"]) || (input["revision"] as number) <= 0) fail("INVALID_CATALOG", "catalog.revision", "must be a positive safe integer");
  const providers = Object.freeze(array(input["providers"], "catalog.providers").map((item, index) => parseProvider(item, `catalog.providers[${index}]`, true)));
  const names = new Map<string, string>();
  for (const provider of providers) {
    for (const name of [provider.providerId, ...provider.aliases].map((name) => name.trim().toLowerCase())) {
      const prior = names.get(name);
      if (prior !== undefined) fail(prior === provider.providerId ? "DUPLICATE_IDENTITY" : "AMBIGUOUS_ALIAS", "catalog.providers", `${name} identifies both ${prior} and ${provider.providerId}`);
      names.set(name, provider.providerId);
    }
  }
  const fingerprint = string(input["fingerprint"], "catalog.fingerprint", 64);
  if (!SHA256.test(fingerprint)) fail("INVALID_CATALOG", "catalog.fingerprint", "must be a lowercase SHA-256 digest");
  const parsed: ProviderCatalogSnapshot = Object.freeze({
    schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
    catalogId: id(input["catalogId"], "catalog.catalogId"),
    revision: input["revision"] as number,
    generatedAt: timestamp(input["generatedAt"], "catalog.generatedAt"),
    providers,
    fingerprint,
  });
  if (fingerprintProviderCatalog(parsed) !== fingerprint) fail("FINGERPRINT_MISMATCH", "catalog.fingerprint", "catalog fingerprint does not match canonical content");
  return parsed;
}
