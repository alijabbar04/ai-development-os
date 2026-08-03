import { createHash } from "node:crypto";
import {
  MAX_MONEY_MICROS,
  createMoney,
  parseModelCapabilities,
  toCanonicalJson,
  validation,
  type ModelCapabilities,
  type Money,
  type TokenUsage,
} from "@ai-dev-os/domain";
import { invalidConfigurationError, malformedResponseError } from "./errors.js";

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
  ensureTimestamp,
} = validation;

export const OPENAI_CATALOG_SCHEMA_VERSION = 1 as const;

/**
 * Reasoning-effort vocabulary exactly as declared by the OpenAI OpenAPI
 * `ReasoningEffort` schema. The adapter never invents a value and never
 * sends one a catalog entry does not declare as supported.
 */
export const OPENAI_REASONING_EFFORTS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const);

export type OpenAiReasoningEffort = (typeof OPENAI_REASONING_EFFORTS)[number];

/** `reasoning.summary` vocabulary from the OpenAPI document. */
export const OPENAI_REASONING_SUMMARIES = Object.freeze(["auto", "concise", "detailed"] as const);
export type OpenAiReasoningSummary = (typeof OPENAI_REASONING_SUMMARIES)[number];

export const OPENAI_LATENCY_CLASSES = Object.freeze(["fast", "standard", "slow"] as const);

/**
 * OpenAI model identifiers are opaque strings chosen by the operator's
 * catalog snapshot. Nothing in this adapter — and nothing in the domain or
 * router layers — may hard-code one or infer behavior from its shape.
 */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCE_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * Where a capability or limit fact came from, and when it was observed.
 * A catalog entry without provenance is rejected: limits must come from an
 * authoritative snapshot, never from a model-name pattern.
 */
export interface OpenAiCapabilityEvidence {
  /** Stable provenance label, e.g. "openai-model-guidance" or "operator". */
  readonly source: string;
  readonly observedAt: string;
  /** Optional immutable document revision the facts were taken from. */
  readonly documentRevision: string | null;
}

function parseEvidence(value: unknown, path: string): OpenAiCapabilityEvidence {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["source", "observedAt", "documentRevision"], path);
  return Object.freeze({
    source: ensureString(record["source"], `${path}.source`, {
      maxLength: 128,
      pattern: SOURCE_PATTERN,
      patternName: "provenance source",
    }),
    observedAt: ensureTimestamp(record["observedAt"], `${path}.observedAt`),
    documentRevision: ensureNullable(record["documentRevision"], (raw) =>
      ensureString(raw, `${path}.documentRevision`, {
        maxLength: 64,
        pattern: VERSION_PATTERN,
        patternName: "document revision",
      }),
    ),
  });
}

/**
 * One immutable price list slice. Prices are integer micro-units of the
 * currency per one million tokens, matching Stage 2 `ModelCostMetadata`, so
 * all cost arithmetic is exact.
 *
 * `cacheWriteMicrosPerMillionTokens` has no Stage 2 counterpart yet; it is
 * retained here (and reported in observations) so cost provenance stays
 * complete, and is proposed as a minimal upstream contract addition.
 */
export interface OpenAiPricingSlice {
  readonly currency: string;
  readonly inputMicrosPerMillionTokens: number;
  readonly cachedInputMicrosPerMillionTokens: number | null;
  readonly cacheWriteMicrosPerMillionTokens: number | null;
  readonly outputMicrosPerMillionTokens: number;
  readonly source: string;
  readonly effectiveFrom: string;
  /** Exclusive upper bound; null means "still in effect". */
  readonly effectiveTo: string | null;
}

function parsePricingSlice(value: unknown, path: string): OpenAiPricingSlice {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "currency",
      "inputMicrosPerMillionTokens",
      "cachedInputMicrosPerMillionTokens",
      "cacheWriteMicrosPerMillionTokens",
      "outputMicrosPerMillionTokens",
      "source",
      "effectiveFrom",
      "effectiveTo",
    ],
    path,
  );
  const micros = (key: string): number =>
    ensureSafeInteger(record[key], `${path}.${key}`, 0, MAX_MONEY_MICROS);
  const nullableMicros = (key: string): number | null =>
    ensureNullable(record[key], (raw) => ensureSafeInteger(raw, `${path}.${key}`, 0, MAX_MONEY_MICROS));

  const effectiveFrom = ensureTimestamp(record["effectiveFrom"], `${path}.effectiveFrom`);
  const effectiveTo = ensureNullable(record["effectiveTo"], (raw) =>
    ensureTimestamp(raw, `${path}.effectiveTo`),
  );
  if (effectiveTo !== null && effectiveTo <= effectiveFrom) {
    throw invalidConfigurationError("pricing-interval-inverted");
  }
  return Object.freeze({
    currency: ensureString(record["currency"], `${path}.currency`, {
      minLength: 3,
      maxLength: 3,
      pattern: /^[A-Z]{3}$/,
      patternName: "ISO-4217 currency code",
    }),
    inputMicrosPerMillionTokens: micros("inputMicrosPerMillionTokens"),
    cachedInputMicrosPerMillionTokens: nullableMicros("cachedInputMicrosPerMillionTokens"),
    cacheWriteMicrosPerMillionTokens: nullableMicros("cacheWriteMicrosPerMillionTokens"),
    outputMicrosPerMillionTokens: micros("outputMicrosPerMillionTokens"),
    source: ensureString(record["source"], `${path}.source`, {
      maxLength: 128,
      pattern: SOURCE_PATTERN,
      patternName: "pricing source",
    }),
    effectiveFrom,
    effectiveTo,
  });
}

export interface OpenAiCatalogEntry {
  readonly modelId: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly supportsStructuredOutput: boolean;
  readonly supportsToolCalling: boolean;
  readonly supportsVision: boolean;
  readonly supportsReasoning: boolean;
  /** Efforts this model accepts; empty when reasoning is unsupported. */
  readonly supportedReasoningEfforts: readonly OpenAiReasoningEffort[];
  /**
   * Whether `temperature` / `top_p` may be sent. Reasoning models reject
   * them, so the adapter omits them unless the snapshot says otherwise.
   */
  readonly supportsSampling: boolean;
  readonly latencyClass: "fast" | "standard" | "slow";
  readonly codingCapability: 1 | 2 | 3 | 4 | 5;
  readonly reasoningCapability: 1 | 2 | 3 | 4 | 5;
  readonly evidence: OpenAiCapabilityEvidence;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  /** Non-overlapping, chronologically ordered price slices. */
  readonly pricing: readonly OpenAiPricingSlice[];
}

const ENTRY_KEYS = [
  "modelId",
  "contextWindowTokens",
  "maxOutputTokens",
  "supportsStructuredOutput",
  "supportsToolCalling",
  "supportsVision",
  "supportsReasoning",
  "supportedReasoningEfforts",
  "supportsSampling",
  "latencyClass",
  "codingCapability",
  "reasoningCapability",
  "evidence",
  "effectiveFrom",
  "effectiveTo",
  "pricing",
] as const;

function parseCatalogEntry(value: unknown, path: string): OpenAiCatalogEntry {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ENTRY_KEYS, path);

  const contextWindowTokens = ensureSafeInteger(
    record["contextWindowTokens"],
    `${path}.contextWindowTokens`,
    1,
    100_000_000,
  );
  const maxOutputTokens = ensureSafeInteger(
    record["maxOutputTokens"],
    `${path}.maxOutputTokens`,
    1,
    contextWindowTokens,
  );
  const supportsReasoning = ensureBoolean(record["supportsReasoning"], `${path}.supportsReasoning`);
  const efforts = ensureEnumArray(
    record["supportedReasoningEfforts"],
    `${path}.supportedReasoningEfforts`,
    OPENAI_REASONING_EFFORTS,
    OPENAI_REASONING_EFFORTS.length,
  );
  if (!supportsReasoning && efforts.length > 0) {
    throw invalidConfigurationError("reasoning-efforts-without-reasoning-support");
  }
  if (supportsReasoning && efforts.length === 0) {
    throw invalidConfigurationError("reasoning-support-without-efforts");
  }

  const effectiveFrom = ensureTimestamp(record["effectiveFrom"], `${path}.effectiveFrom`);
  const effectiveTo = ensureNullable(record["effectiveTo"], (raw) =>
    ensureTimestamp(raw, `${path}.effectiveTo`),
  );
  if (effectiveTo !== null && effectiveTo <= effectiveFrom) {
    throw invalidConfigurationError("entry-interval-inverted");
  }

  const pricing = ensureArray(record["pricing"], `${path}.pricing`, 32).map((item, index) =>
    parsePricingSlice(item, `${path}.pricing[${index}]`),
  );
  const ordered = [...pricing].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (previous.effectiveTo === null || previous.effectiveTo > current.effectiveFrom) {
      throw invalidConfigurationError("pricing-intervals-overlap");
    }
  }
  const rating = (key: string): 1 | 2 | 3 | 4 | 5 =>
    ensureSafeInteger(record[key], `${path}.${key}`, 1, 5) as 1 | 2 | 3 | 4 | 5;

  return Object.freeze({
    modelId: ensureString(record["modelId"], `${path}.modelId`, {
      maxLength: 128,
      pattern: MODEL_ID_PATTERN,
      patternName: "OpenAI model id",
    }),
    contextWindowTokens,
    maxOutputTokens,
    supportsStructuredOutput: ensureBoolean(
      record["supportsStructuredOutput"],
      `${path}.supportsStructuredOutput`,
    ),
    supportsToolCalling: ensureBoolean(record["supportsToolCalling"], `${path}.supportsToolCalling`),
    supportsVision: ensureBoolean(record["supportsVision"], `${path}.supportsVision`),
    supportsReasoning,
    supportedReasoningEfforts: efforts,
    supportsSampling: ensureBoolean(record["supportsSampling"], `${path}.supportsSampling`),
    latencyClass: ensureEnum(record["latencyClass"], `${path}.latencyClass`, OPENAI_LATENCY_CLASSES),
    codingCapability: rating("codingCapability"),
    reasoningCapability: rating("reasoningCapability"),
    evidence: parseEvidence(record["evidence"], `${path}.evidence`),
    effectiveFrom,
    effectiveTo,
    pricing: Object.freeze(ordered),
  });
}

export interface OpenAiModelCatalog {
  readonly schemaVersion: typeof OPENAI_CATALOG_SCHEMA_VERSION;
  readonly catalogVersion: string;
  readonly source: string;
  readonly entries: readonly OpenAiCatalogEntry[];
  /** sha256 over the canonical catalog; stable across key orderings. */
  readonly fingerprint: string;
}

/**
 * Validates a model-catalog snapshot. The snapshot is data, not code: this
 * package ships no built-in model identifiers, context limits, or prices,
 * because those facts are not derivable from the API schema and must come
 * from an authoritative, dated snapshot the operator supplies.
 */
export function parseOpenAiModelCatalog(value: unknown, path = "openAiModelCatalog"): OpenAiModelCatalog {
  const record = ensureRecord(value, path);
  // `fingerprint` is derived, but accepting it makes re-parsing an already
  // parsed catalog idempotent; a supplied value must match what the
  // contents actually hash to.
  ensureExactKeys(record, ["schemaVersion", "catalogVersion", "source", "entries", "fingerprint"], path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, OPENAI_CATALOG_SCHEMA_VERSION);

  const entries = ensureArray(record["entries"], `${path}.entries`, 256).map((item, index) =>
    parseCatalogEntry(item, `${path}.entries[${index}]`),
  );
  // Entries are keyed by (modelId, effectiveFrom): a model may appear more
  // than once across disjoint intervals but never twice for one instant.
  const ordered = [...entries].sort(
    (a, b) => a.modelId.localeCompare(b.modelId) || a.effectiveFrom.localeCompare(b.effectiveFrom),
  );
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (previous.modelId !== current.modelId) {
      continue;
    }
    if (previous.effectiveTo === null || previous.effectiveTo > current.effectiveFrom) {
      throw invalidConfigurationError("catalog-intervals-overlap");
    }
  }

  const catalogVersion = ensureString(record["catalogVersion"], `${path}.catalogVersion`, {
    maxLength: 64,
    pattern: VERSION_PATTERN,
    patternName: "catalog version",
  });
  const source = ensureString(record["source"], `${path}.source`, {
    maxLength: 128,
    pattern: SOURCE_PATTERN,
    patternName: "catalog source",
  });

  const fingerprint = createHash("sha256")
    .update(
      toCanonicalJson({
        schemaVersion: OPENAI_CATALOG_SCHEMA_VERSION,
        catalogVersion,
        source,
        entries: ordered,
      }),
    )
    .digest("hex");

  const supplied = record["fingerprint"];
  if (supplied !== undefined && supplied !== null && supplied !== fingerprint) {
    throw invalidConfigurationError("catalog-fingerprint-mismatch");
  }

  return Object.freeze({
    schemaVersion: OPENAI_CATALOG_SCHEMA_VERSION,
    catalogVersion,
    source,
    entries: Object.freeze(ordered),
    fingerprint,
  });
}

/** An empty but well-formed catalog; the adapter then offers no models. */
export function emptyOpenAiModelCatalog(catalogVersion = "empty", source = "operator"): OpenAiModelCatalog {
  return parseOpenAiModelCatalog({
    schemaVersion: OPENAI_CATALOG_SCHEMA_VERSION,
    catalogVersion,
    source,
    entries: [],
  });
}

function withinInterval(from: string, to: string | null, at: string): boolean {
  return at >= from && (to === null || at < to);
}

/** Selects the entry effective at `at`, or null when none applies. */
export function selectCatalogEntry(
  catalog: OpenAiModelCatalog,
  modelId: string,
  at: string,
): OpenAiCatalogEntry | null {
  for (const entry of catalog.entries) {
    if (entry.modelId === modelId && withinInterval(entry.effectiveFrom, entry.effectiveTo, at)) {
      return entry;
    }
  }
  return null;
}

/** Selects the price slice effective at `at`, or null when pricing is unknown. */
export function selectPricingSlice(entry: OpenAiCatalogEntry, at: string): OpenAiPricingSlice | null {
  for (const slice of entry.pricing) {
    if (withinInterval(slice.effectiveFrom, slice.effectiveTo, at)) {
      return slice;
    }
  }
  return null;
}

/** Model ids offered at `at`, sorted, for deterministic listings. */
export function listCatalogModelIds(catalog: OpenAiModelCatalog, at: string): readonly string[] {
  const ids = catalog.entries
    .filter((entry) => withinInterval(entry.effectiveFrom, entry.effectiveTo, at))
    .map((entry) => entry.modelId);
  return Object.freeze([...new Set(ids)].sort());
}

/**
 * Restrictive-only capability override. Configuration may deny a
 * capability or lower a limit; it can never grant a capability the
 * authoritative snapshot does not record.
 */
export interface OpenAiCapabilityOverride {
  readonly modelId: string;
  readonly denyStructuredOutput: boolean;
  readonly denyToolCalling: boolean;
  readonly denyVision: boolean;
  readonly denyReasoning: boolean;
  readonly denySampling: boolean;
  readonly maxContextWindowTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly allowedReasoningEfforts: readonly OpenAiReasoningEffort[] | null;
}

export function parseOpenAiCapabilityOverride(value: unknown, path: string): OpenAiCapabilityOverride {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "modelId",
      "denyStructuredOutput",
      "denyToolCalling",
      "denyVision",
      "denyReasoning",
      "denySampling",
      "maxContextWindowTokens",
      "maxOutputTokens",
      "allowedReasoningEfforts",
    ],
    path,
  );
  const flag = (key: string): boolean => ensureBoolean(record[key], `${path}.${key}`);
  return Object.freeze({
    modelId: ensureString(record["modelId"], `${path}.modelId`, {
      maxLength: 128,
      pattern: MODEL_ID_PATTERN,
      patternName: "OpenAI model id",
    }),
    denyStructuredOutput: flag("denyStructuredOutput"),
    denyToolCalling: flag("denyToolCalling"),
    denyVision: flag("denyVision"),
    denyReasoning: flag("denyReasoning"),
    denySampling: flag("denySampling"),
    maxContextWindowTokens: ensureNullable(record["maxContextWindowTokens"], (raw) =>
      ensureSafeInteger(raw, `${path}.maxContextWindowTokens`, 1, 100_000_000),
    ),
    maxOutputTokens: ensureNullable(record["maxOutputTokens"], (raw) =>
      ensureSafeInteger(raw, `${path}.maxOutputTokens`, 1, 100_000_000),
    ),
    allowedReasoningEfforts: ensureNullable(record["allowedReasoningEfforts"], (raw) =>
      ensureEnumArray(
        raw,
        `${path}.allowedReasoningEfforts`,
        OPENAI_REASONING_EFFORTS,
        OPENAI_REASONING_EFFORTS.length,
      ),
    ),
  });
}

/** Applies a restrictive override; the result is never more capable. */
export function applyCapabilityOverride(
  entry: OpenAiCatalogEntry,
  override: OpenAiCapabilityOverride | null,
): OpenAiCatalogEntry {
  if (override === null) {
    return entry;
  }
  const contextWindowTokens = Math.min(
    entry.contextWindowTokens,
    override.maxContextWindowTokens ?? entry.contextWindowTokens,
  );
  const maxOutputTokens = Math.min(
    Math.min(entry.maxOutputTokens, override.maxOutputTokens ?? entry.maxOutputTokens),
    contextWindowTokens,
  );
  const supportsReasoning = entry.supportsReasoning && !override.denyReasoning;
  const allowed = override.allowedReasoningEfforts;
  const efforts = !supportsReasoning
    ? Object.freeze([] as OpenAiReasoningEffort[])
    : Object.freeze(
        entry.supportedReasoningEfforts.filter((effort) => allowed === null || allowed.includes(effort)),
      );
  return Object.freeze({
    ...entry,
    contextWindowTokens,
    maxOutputTokens,
    supportsStructuredOutput: entry.supportsStructuredOutput && !override.denyStructuredOutput,
    supportsToolCalling: entry.supportsToolCalling && !override.denyToolCalling,
    supportsVision: entry.supportsVision && !override.denyVision,
    supportsReasoning,
    supportedReasoningEfforts: efforts,
    supportsSampling: entry.supportsSampling && !override.denySampling,
  });
}

/** Projects a catalog entry onto the Stage 2 ModelCapabilities contract. */
export function toModelCapabilities(
  providerId: string,
  entry: OpenAiCatalogEntry,
  at: string,
): ModelCapabilities {
  const slice = selectPricingSlice(entry, at);
  return parseModelCapabilities({
    schemaVersion: 1,
    providerId,
    modelId: entry.modelId,
    contextWindowTokens: entry.contextWindowTokens,
    maxOutputTokens: entry.maxOutputTokens,
    supportsToolUse: entry.supportsToolCalling,
    supportsStructuredOutput: entry.supportsStructuredOutput,
    supportsVision: entry.supportsVision,
    locality: "cloud",
    latencyClass: entry.latencyClass,
    codingCapability: entry.codingCapability,
    reasoningCapability: entry.reasoningCapability,
    cost:
      slice === null
        ? null
        : {
            currency: slice.currency,
            inputMicrosPerMillionTokens: slice.inputMicrosPerMillionTokens,
            outputMicrosPerMillionTokens: slice.outputMicrosPerMillionTokens,
            cachedInputMicrosPerMillionTokens: slice.cachedInputMicrosPerMillionTokens,
          },
  });
}

const MICROS_DIVISOR = 1_000_000n;

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

export interface ComputedCost {
  readonly money: Money | null;
  /** Provenance of the price list used; null when cost is unknown. */
  readonly pricingSource: string | null;
  readonly pricingEffectiveFrom: string | null;
  /**
   * True when cache-write tokens were reported but the snapshot declares no
   * cache-write rate, so they contributed nothing beyond their inclusion in
   * the input count. The figure is then a lower bound, not a guess.
   */
  readonly cacheWriteUnpriced: boolean;
}

export const UNKNOWN_COMPUTED_COST: ComputedCost = Object.freeze({
  money: null,
  pricingSource: null,
  pricingEffectiveFrom: null,
  cacheWriteUnpriced: false,
});

/**
 * Exact cost from the price slice effective at `at`, using BigInt so no
 * precision is lost and no intermediate overflow silently wraps. Returns an
 * explicitly unknown cost when no slice covers the instant — cost is never
 * guessed from a model name.
 *
 * `cacheWriteTokens` add a charge ONLY when the snapshot declares a
 * dedicated cache-write rate. The API reports cache writes as a detail of
 * `input_tokens`, so billing them at the input rate as a fallback would
 * double count; instead the result records that they were left unpriced.
 */
export function computeCost(
  entry: OpenAiCatalogEntry,
  tokens: TokenUsage,
  cacheWriteTokens: number,
  at: string,
): ComputedCost {
  const slice = selectPricingSlice(entry, at);
  if (slice === null) {
    return UNKNOWN_COMPUTED_COST;
  }
  const cachedRate = slice.cachedInputMicrosPerMillionTokens ?? slice.inputMicrosPerMillionTokens;
  const cacheWriteRate = slice.cacheWriteMicrosPerMillionTokens;
  const micros =
    ceilDivide(BigInt(tokens.inputTokens) * BigInt(slice.inputMicrosPerMillionTokens), MICROS_DIVISOR) +
    ceilDivide(BigInt(tokens.cachedInputTokens) * BigInt(cachedRate), MICROS_DIVISOR) +
    (cacheWriteRate === null
      ? 0n
      : ceilDivide(BigInt(cacheWriteTokens) * BigInt(cacheWriteRate), MICROS_DIVISOR)) +
    ceilDivide(
      (BigInt(tokens.outputTokens) + BigInt(tokens.reasoningTokens)) *
        BigInt(slice.outputMicrosPerMillionTokens),
      MICROS_DIVISOR,
    );

  if (micros > BigInt(MAX_MONEY_MICROS)) {
    throw malformedResponseError("cost-overflow", { maximum: MAX_MONEY_MICROS });
  }

  return Object.freeze({
    money: createMoney(slice.currency, Number(micros)),
    pricingSource: slice.source,
    pricingEffectiveFrom: slice.effectiveFrom,
    cacheWriteUnpriced: cacheWriteTokens > 0 && cacheWriteRate === null,
  });
}
