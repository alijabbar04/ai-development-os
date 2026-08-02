import {
  DATA_CLASSIFICATIONS,
  ValidationError,
  validation,
  type DataClassification,
} from "@ai-dev-os/domain";
import { ProviderError } from "@ai-dev-os/providers";
import { invalidConfigurationError } from "./errors.js";
import { parseOllamaEndpoint, type OllamaEndpoint } from "./endpoint.js";

const {
  ensureArray,
  ensureBoolean,
  ensureEnum,
  ensureEnumArray,
  ensureExactKeys,
  ensureNullable,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
  ensureString,
} = validation;

export const OLLAMA_ADAPTER_SCHEMA_VERSION = 1 as const;

/** Extension namespace this adapter owns in configuration and requests. */
export const OLLAMA_EXTENSION_NAMESPACE = "ollama";

/** Role vocabulary shared with @ai-dev-os/config model preferences. */
export const OLLAMA_MODEL_ROLES = Object.freeze([
  "planning",
  "implementation",
  "review",
  "documentation",
  "testing",
  "explanation",
] as const);

export type OllamaModelRole = (typeof OLLAMA_MODEL_ROLES)[number];

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Native Ollama model names may also contain "/" (e.g. hf.co registries). */
const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const FAMILY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const QUANTIZATION_PATTERN = /^[A-Za-z0-9_.-]{1,32}$/;
const DIGEST_PATTERN = /^(?:sha256:)?[a-fA-F0-9]{64}$/;

export type OllamaKeepAlivePolicy =
  | { readonly policy: "unload-immediately" }
  | { readonly policy: "retain"; readonly durationMs: number }
  | { readonly policy: "keep-loaded" };

export interface OllamaModelConcurrencyLimit {
  readonly model: string;
  readonly limit: number;
}

export interface OllamaDigestPin {
  readonly model: string;
  /** Normalized lowercase 64-char hex digest (no "sha256:" prefix). */
  readonly digest: string;
}

export interface OllamaRolePreference {
  readonly role: OllamaModelRole;
  /** Preferred model families, most-preferred first. */
  readonly families: readonly string[];
  /** Preferred exact model names, most-preferred first (rank above families). */
  readonly models: readonly string[];
  readonly minContextLength: number | null;
  readonly requireReasoning: boolean;
  readonly requireStructuredOutput: boolean;
  readonly requireToolCalling: boolean;
  readonly requireVision: boolean;
  readonly maxModelSizeBytes: number | null;
  readonly allowedQuantizations: readonly string[] | null;
  readonly requireDigestPin: boolean;
}

/** Restrictive-only capability overrides; configuration can never add a capability. */
export interface OllamaCapabilityOverride {
  readonly model: string;
  readonly denyToolCalling: boolean;
  readonly denyStructuredOutput: boolean;
  readonly denyReasoning: boolean;
  readonly denyVision: boolean;
  readonly maxContextLength: number | null;
}

export interface OllamaAdapterConfiguration {
  readonly schemaVersion: typeof OLLAMA_ADAPTER_SCHEMA_VERSION;
  readonly instanceId: string;
  readonly endpoint: OllamaEndpoint;
  readonly requestTimeoutMs: number;
  readonly discoveryTimeoutMs: number;
  readonly keepAlive: OllamaKeepAlivePolicy;
  readonly maxConcurrentOperations: number;
  readonly perModelConcurrency: readonly OllamaModelConcurrencyLimit[];
  readonly capacityBudgetBytes: number | null;
  readonly capacitySafetyMarginBytes: number;
  readonly queueLimit: number;
  readonly admissionTimeoutMs: number | null;
  readonly digestPins: readonly OllamaDigestPin[];
  readonly modelAllowlist: readonly string[] | null;
  readonly modelDenylist: readonly string[];
  readonly rolePreferences: readonly OllamaRolePreference[];
  readonly capabilityOverrides: readonly OllamaCapabilityOverride[];
  readonly supportedClassifications: readonly DataClassification[];
}

export interface OllamaAdapterConfigurationInput {
  readonly instanceId: string;
  /** Literal loopback base URL, e.g. "http://127.0.0.1:11434". */
  readonly endpoint: string;
  readonly requestTimeoutMs?: number;
  readonly discoveryTimeoutMs?: number;
  readonly keepAlive?: OllamaKeepAlivePolicy;
  readonly maxConcurrentOperations?: number;
  readonly perModelConcurrency?: readonly OllamaModelConcurrencyLimit[];
  readonly capacityBudgetBytes?: number | null;
  readonly capacitySafetyMarginBytes?: number;
  readonly queueLimit?: number;
  readonly admissionTimeoutMs?: number | null;
  readonly digestPins?: readonly { readonly model: string; readonly digest: string }[];
  readonly modelAllowlist?: readonly string[] | null;
  readonly modelDenylist?: readonly string[];
  readonly rolePreferences?: readonly Partial<OllamaRolePreference>[];
  readonly capabilityOverrides?: readonly Partial<OllamaCapabilityOverride>[];
  readonly supportedClassifications?: readonly DataClassification[];
}

function modelName(value: unknown, path: string): string {
  return ensureString(value, path, {
    maxLength: 128,
    pattern: MODEL_NAME_PATTERN,
    patternName: "Ollama model name",
  });
}

export function normalizeOllamaDigest(value: unknown, path = "digest"): string {
  const text = ensureString(value, path, {
    maxLength: 71,
    pattern: DIGEST_PATTERN,
    patternName: "sha256 digest",
  });
  return (text.startsWith("sha256:") ? text.slice("sha256:".length) : text).toLowerCase();
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string, path: string): readonly T[] {
  const seen = new Set<string>();
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) {
      throw invalidConfigurationError(`duplicate-entry:${path}`);
    }
    seen.add(value);
  }
  return Object.freeze([...items]);
}

function parseKeepAlive(value: unknown, path: string): OllamaKeepAlivePolicy {
  const record = ensureRecord(value, path);
  const policy = ensureEnum(record["policy"], `${path}.policy`, [
    "unload-immediately",
    "retain",
    "keep-loaded",
  ] as const);
  if (policy === "retain") {
    ensureExactKeys(record, ["policy", "durationMs"], path);
    return Object.freeze({
      policy,
      durationMs: ensureSafeInteger(record["durationMs"], `${path}.durationMs`, 1_000, 86_400_000),
    });
  }
  ensureExactKeys(record, ["policy"], path);
  return Object.freeze({ policy });
}

function parseRolePreference(value: unknown, path: string): OllamaRolePreference {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "role",
      "families",
      "models",
      "minContextLength",
      "requireReasoning",
      "requireStructuredOutput",
      "requireToolCalling",
      "requireVision",
      "maxModelSizeBytes",
      "allowedQuantizations",
      "requireDigestPin",
    ],
    path,
  );
  const families = ensureArray(record["families"], `${path}.families`, 16).map((item, index) =>
    ensureString(item, `${path}.families[${index}]`, {
      maxLength: 64,
      pattern: FAMILY_PATTERN,
      patternName: "model family",
    }),
  );
  const models = ensureArray(record["models"], `${path}.models`, 16).map((item, index) =>
    modelName(item, `${path}.models[${index}]`),
  );
  if (new Set(families).size !== families.length || new Set(models).size !== models.length) {
    throw invalidConfigurationError("duplicate-preference-entry");
  }
  return Object.freeze({
    role: ensureEnum(record["role"], `${path}.role`, OLLAMA_MODEL_ROLES),
    families: Object.freeze(families),
    models: Object.freeze(models),
    minContextLength: ensureNullable(record["minContextLength"], (raw) =>
      ensureSafeInteger(raw, `${path}.minContextLength`, 1, 100_000_000),
    ),
    requireReasoning: ensureBoolean(record["requireReasoning"], `${path}.requireReasoning`),
    requireStructuredOutput: ensureBoolean(
      record["requireStructuredOutput"],
      `${path}.requireStructuredOutput`,
    ),
    requireToolCalling: ensureBoolean(record["requireToolCalling"], `${path}.requireToolCalling`),
    requireVision: ensureBoolean(record["requireVision"], `${path}.requireVision`),
    maxModelSizeBytes: ensureNullable(record["maxModelSizeBytes"], (raw) =>
      ensureSafeInteger(raw, `${path}.maxModelSizeBytes`, 1, Number.MAX_SAFE_INTEGER),
    ),
    allowedQuantizations: ensureNullable(record["allowedQuantizations"], (raw) =>
      Object.freeze(
        ensureArray(raw, `${path}.allowedQuantizations`, 16).map((item, index) =>
          ensureString(item, `${path}.allowedQuantizations[${index}]`, {
            maxLength: 32,
            pattern: QUANTIZATION_PATTERN,
            patternName: "quantization level",
          }),
        ),
      ),
    ),
    requireDigestPin: ensureBoolean(record["requireDigestPin"], `${path}.requireDigestPin`),
  });
}

function parseCapabilityOverride(value: unknown, path: string): OllamaCapabilityOverride {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    ["model", "denyToolCalling", "denyStructuredOutput", "denyReasoning", "denyVision", "maxContextLength"],
    path,
  );
  return Object.freeze({
    model: modelName(record["model"], `${path}.model`),
    denyToolCalling: ensureBoolean(record["denyToolCalling"], `${path}.denyToolCalling`),
    denyStructuredOutput: ensureBoolean(record["denyStructuredOutput"], `${path}.denyStructuredOutput`),
    denyReasoning: ensureBoolean(record["denyReasoning"], `${path}.denyReasoning`),
    denyVision: ensureBoolean(record["denyVision"], `${path}.denyVision`),
    maxContextLength: ensureNullable(record["maxContextLength"], (raw) =>
      ensureSafeInteger(raw, `${path}.maxContextLength`, 1, 100_000_000),
    ),
  });
}

/**
 * Strict full-record validation. Unknown fields, prototype-pollution input,
 * inline credentials in the endpoint, invalid durations, unsafe integers,
 * duplicate model rules, and malformed digest pins are all rejected. The
 * returned configuration is deeply immutable.
 */
export function parseOllamaAdapterConfiguration(value: unknown): OllamaAdapterConfiguration {
  try {
    const record = ensureRecord(value, "ollamaConfiguration");
    ensureExactKeys(
      record,
      [
        "schemaVersion",
        "instanceId",
        "endpoint",
        "requestTimeoutMs",
        "discoveryTimeoutMs",
        "keepAlive",
        "maxConcurrentOperations",
        "perModelConcurrency",
        "capacityBudgetBytes",
        "capacitySafetyMarginBytes",
        "queueLimit",
        "admissionTimeoutMs",
        "digestPins",
        "modelAllowlist",
        "modelDenylist",
        "rolePreferences",
        "capabilityOverrides",
        "supportedClassifications",
      ],
      "ollamaConfiguration",
    );
    ensureSchemaVersion(record["schemaVersion"], "ollamaConfiguration.schemaVersion", OLLAMA_ADAPTER_SCHEMA_VERSION);

    const endpoint = parseOllamaEndpoint(
      ensureString(record["endpoint"], "ollamaConfiguration.endpoint", { maxLength: 256 }),
    );

    const perModelConcurrency = uniqueBy(
      ensureArray(record["perModelConcurrency"], "ollamaConfiguration.perModelConcurrency", 64).map(
        (item, index) => {
          const limitRecord = ensureRecord(item, `perModelConcurrency[${index}]`);
          ensureExactKeys(limitRecord, ["model", "limit"], `perModelConcurrency[${index}]`);
          return Object.freeze({
            model: modelName(limitRecord["model"], `perModelConcurrency[${index}].model`),
            limit: ensureSafeInteger(limitRecord["limit"], `perModelConcurrency[${index}].limit`, 1, 64),
          });
        },
      ),
      (item) => item.model,
      "perModelConcurrency",
    );

    const digestPins = uniqueBy(
      ensureArray(record["digestPins"], "ollamaConfiguration.digestPins", 128).map((item, index) => {
        const pinRecord = ensureRecord(item, `digestPins[${index}]`);
        ensureExactKeys(pinRecord, ["model", "digest"], `digestPins[${index}]`);
        return Object.freeze({
          model: modelName(pinRecord["model"], `digestPins[${index}].model`),
          digest: normalizeOllamaDigest(pinRecord["digest"], `digestPins[${index}].digest`),
        });
      }),
      (item) => item.model,
      "digestPins",
    );

    const modelAllowlist = ensureNullable(record["modelAllowlist"], (raw) =>
      uniqueBy(
        ensureArray(raw, "ollamaConfiguration.modelAllowlist", 128).map((item, index) =>
          modelName(item, `modelAllowlist[${index}]`),
        ),
        (item) => item,
        "modelAllowlist",
      ),
    );

    const modelDenylist = uniqueBy(
      ensureArray(record["modelDenylist"], "ollamaConfiguration.modelDenylist", 128).map(
        (item, index) => modelName(item, `modelDenylist[${index}]`),
      ),
      (item) => item,
      "modelDenylist",
    );

    const rolePreferences = uniqueBy(
      ensureArray(record["rolePreferences"], "ollamaConfiguration.rolePreferences", OLLAMA_MODEL_ROLES.length).map(
        (item, index) => parseRolePreference(item, `rolePreferences[${index}]`),
      ),
      (item) => item.role,
      "rolePreferences",
    );

    const capabilityOverrides = uniqueBy(
      ensureArray(record["capabilityOverrides"], "ollamaConfiguration.capabilityOverrides", 128).map(
        (item, index) => parseCapabilityOverride(item, `capabilityOverrides[${index}]`),
      ),
      (item) => item.model,
      "capabilityOverrides",
    );

    const capacityBudgetBytes = ensureNullable(record["capacityBudgetBytes"], (raw) =>
      ensureSafeInteger(raw, "ollamaConfiguration.capacityBudgetBytes", 1, Number.MAX_SAFE_INTEGER),
    );
    const capacitySafetyMarginBytes = ensureSafeInteger(
      record["capacitySafetyMarginBytes"],
      "ollamaConfiguration.capacitySafetyMarginBytes",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (capacityBudgetBytes !== null && capacitySafetyMarginBytes >= capacityBudgetBytes) {
      throw invalidConfigurationError("safety-margin-exceeds-budget");
    }

    return Object.freeze({
      schemaVersion: OLLAMA_ADAPTER_SCHEMA_VERSION,
      instanceId: ensureString(record["instanceId"], "ollamaConfiguration.instanceId", {
        maxLength: 128,
        pattern: ID_PATTERN,
        patternName: "provider instance id",
      }),
      endpoint,
      requestTimeoutMs: ensureSafeInteger(record["requestTimeoutMs"], "ollamaConfiguration.requestTimeoutMs", 100, 3_600_000),
      discoveryTimeoutMs: ensureSafeInteger(record["discoveryTimeoutMs"], "ollamaConfiguration.discoveryTimeoutMs", 100, 600_000),
      keepAlive: parseKeepAlive(record["keepAlive"], "ollamaConfiguration.keepAlive"),
      maxConcurrentOperations: ensureSafeInteger(
        record["maxConcurrentOperations"],
        "ollamaConfiguration.maxConcurrentOperations",
        1,
        64,
      ),
      perModelConcurrency,
      capacityBudgetBytes,
      capacitySafetyMarginBytes,
      queueLimit: ensureSafeInteger(record["queueLimit"], "ollamaConfiguration.queueLimit", 0, 1_000),
      admissionTimeoutMs: ensureNullable(record["admissionTimeoutMs"], (raw) =>
        ensureSafeInteger(raw, "ollamaConfiguration.admissionTimeoutMs", 100, 3_600_000),
      ),
      digestPins,
      modelAllowlist,
      modelDenylist,
      rolePreferences,
      capabilityOverrides,
      supportedClassifications: ensureEnumArray(
        record["supportedClassifications"],
        "ollamaConfiguration.supportedClassifications",
        DATA_CLASSIFICATIONS,
        DATA_CLASSIFICATIONS.length,
      ),
    });
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }
    if (error instanceof ValidationError) {
      const issue = error.issues[0];
      throw invalidConfigurationError(`${issue?.code ?? "invalid"}:${issue?.path ?? "configuration"}`);
    }
    throw error;
  }
}

/** Convenience constructor applying documented defaults, then full validation. */
export function createOllamaAdapterConfiguration(
  input: OllamaAdapterConfigurationInput,
): OllamaAdapterConfiguration {
  const rolePreferences = (input.rolePreferences ?? []).map((preference) => ({
    role: preference.role,
    families: preference.families ?? [],
    models: preference.models ?? [],
    minContextLength: preference.minContextLength ?? null,
    requireReasoning: preference.requireReasoning ?? false,
    requireStructuredOutput: preference.requireStructuredOutput ?? false,
    requireToolCalling: preference.requireToolCalling ?? false,
    requireVision: preference.requireVision ?? false,
    maxModelSizeBytes: preference.maxModelSizeBytes ?? null,
    allowedQuantizations: preference.allowedQuantizations ?? null,
    requireDigestPin: preference.requireDigestPin ?? false,
  }));
  const capabilityOverrides = (input.capabilityOverrides ?? []).map((override) => ({
    model: override.model,
    denyToolCalling: override.denyToolCalling ?? false,
    denyStructuredOutput: override.denyStructuredOutput ?? false,
    denyReasoning: override.denyReasoning ?? false,
    denyVision: override.denyVision ?? false,
    maxContextLength: override.maxContextLength ?? null,
  }));
  return parseOllamaAdapterConfiguration({
    schemaVersion: OLLAMA_ADAPTER_SCHEMA_VERSION,
    instanceId: input.instanceId,
    endpoint: input.endpoint,
    requestTimeoutMs: input.requestTimeoutMs ?? 300_000,
    discoveryTimeoutMs: input.discoveryTimeoutMs ?? 10_000,
    keepAlive: input.keepAlive ?? { policy: "retain", durationMs: 300_000 },
    maxConcurrentOperations: input.maxConcurrentOperations ?? 2,
    perModelConcurrency: input.perModelConcurrency ?? [],
    capacityBudgetBytes: input.capacityBudgetBytes ?? null,
    capacitySafetyMarginBytes: input.capacitySafetyMarginBytes ?? 0,
    queueLimit: input.queueLimit ?? 16,
    admissionTimeoutMs: input.admissionTimeoutMs === undefined ? 60_000 : input.admissionTimeoutMs,
    digestPins: input.digestPins ?? [],
    modelAllowlist: input.modelAllowlist ?? null,
    modelDenylist: input.modelDenylist ?? [],
    rolePreferences,
    capabilityOverrides,
    supportedClassifications: input.supportedClassifications ?? DATA_CLASSIFICATIONS,
  });
}

/**
 * Resolves the adapter configuration from a Stage 6 provider-instance
 * shape: the `ollama` namespace extension supplies adapter settings while
 * the endpoint comes from the referenced local-model endpoint. The
 * extension value must not repeat identity or endpoint fields. This
 * function accepts the structural shape (namespace/schemaVersion/value) so
 * the package needs no dependency on @ai-dev-os/config.
 */
export function resolveOllamaConfiguration(options: {
  readonly instanceId: string;
  readonly endpointBaseUrl: string;
  readonly extensions?: unknown;
}): OllamaAdapterConfiguration {
  let settings: Record<string, unknown> = {};
  if (options.extensions !== undefined && options.extensions !== null) {
    const entries = ensureArray(options.extensions, "extensions", 16);
    for (const [index, entry] of entries.entries()) {
      const record = ensureRecord(entry, `extensions[${index}]`);
      ensureExactKeys(record, ["namespace", "schemaVersion", "value"], `extensions[${index}]`);
      if (record["namespace"] !== OLLAMA_EXTENSION_NAMESPACE) {
        continue;
      }
      ensureSchemaVersion(
        record["schemaVersion"],
        `extensions[${index}].schemaVersion`,
        OLLAMA_ADAPTER_SCHEMA_VERSION,
      );
      settings = ensureRecord(record["value"], `extensions[${index}].value`);
      break;
    }
  }
  const forbidden = ["schemaVersion", "instanceId", "endpoint"];
  for (const key of forbidden) {
    if (key in settings) {
      throw invalidConfigurationError(`extension-overrides-${key}`);
    }
  }
  try {
    return createOllamaAdapterConfiguration({
      instanceId: options.instanceId,
      endpoint: options.endpointBaseUrl,
      ...(settings as Omit<OllamaAdapterConfigurationInput, "instanceId" | "endpoint">),
    });
  } catch (error) {
    if (error instanceof ProviderError || error instanceof ValidationError) {
      throw error;
    }
    // Structurally hostile extension values (e.g. non-array collections)
    // become a stable configuration error instead of a raw TypeError.
    throw invalidConfigurationError("malformed-extension-value");
  }
}
