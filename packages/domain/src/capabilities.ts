import { DomainError, InvariantViolationError } from "./errors.js";
import {
  ensureBoolean,
  ensureEnum,
  ensureExactKeys,
  ensureNullable,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
} from "./internal/guards.js";
import {
  createMoney,
  MAX_MONEY_MICROS,
  parseCurrencyCode,
  parseTokenUsage,
  type Money,
  type TokenUsage,
} from "./budget.js";
import { parseModelId, parseProviderId, type ModelId, type ProviderId } from "./ids.js";
import { MAX_TOKEN_COUNT } from "./task.js";

export const MODEL_CAPABILITIES_SCHEMA_VERSION = 1 as const;

export const MODEL_LOCALITIES = Object.freeze(["local", "cloud"] as const);
export type ModelLocality = (typeof MODEL_LOCALITIES)[number];

export const LATENCY_CLASSES = Object.freeze(["fast", "standard", "slow"] as const);
export type LatencyClass = (typeof LATENCY_CLASSES)[number];

/** Skill ratings are coarse 1 (weak) to 5 (frontier) ordinals. */
export type CapabilityRating = 1 | 2 | 3 | 4 | 5;

/**
 * Pricing is expressed as integer micro-units of the currency per one
 * million tokens, so cost arithmetic stays exact.
 */
export interface ModelCostMetadata {
  readonly currency: string;
  readonly inputMicrosPerMillionTokens: number;
  readonly outputMicrosPerMillionTokens: number;
  readonly cachedInputMicrosPerMillionTokens: number | null;
}

export interface ModelCapabilities {
  readonly schemaVersion: typeof MODEL_CAPABILITIES_SCHEMA_VERSION;
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly supportsToolUse: boolean;
  readonly supportsStructuredOutput: boolean;
  readonly supportsVision: boolean;
  readonly locality: ModelLocality;
  readonly latencyClass: LatencyClass;
  readonly codingCapability: CapabilityRating;
  readonly reasoningCapability: CapabilityRating;
  readonly cost: ModelCostMetadata | null;
}

function parseRating(value: unknown, path: string): CapabilityRating {
  return ensureSafeInteger(value, path, 1, 5) as CapabilityRating;
}

function parseModelCostMetadata(value: unknown, path: string): ModelCostMetadata {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "currency",
      "inputMicrosPerMillionTokens",
      "outputMicrosPerMillionTokens",
      "cachedInputMicrosPerMillionTokens",
    ],
    path,
  );
  return Object.freeze({
    currency: parseCurrencyCode(record["currency"], `${path}.currency`),
    inputMicrosPerMillionTokens: ensureSafeInteger(
      record["inputMicrosPerMillionTokens"],
      `${path}.inputMicrosPerMillionTokens`,
      0,
      MAX_MONEY_MICROS,
    ),
    outputMicrosPerMillionTokens: ensureSafeInteger(
      record["outputMicrosPerMillionTokens"],
      `${path}.outputMicrosPerMillionTokens`,
      0,
      MAX_MONEY_MICROS,
    ),
    cachedInputMicrosPerMillionTokens: ensureNullable(
      record["cachedInputMicrosPerMillionTokens"],
      (cached) =>
        ensureSafeInteger(
          cached,
          `${path}.cachedInputMicrosPerMillionTokens`,
          0,
          MAX_MONEY_MICROS,
        ),
    ),
  });
}

export function parseModelCapabilities(
  value: unknown,
  path = "modelCapabilities",
): ModelCapabilities {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "schemaVersion",
      "providerId",
      "modelId",
      "contextWindowTokens",
      "maxOutputTokens",
      "supportsToolUse",
      "supportsStructuredOutput",
      "supportsVision",
      "locality",
      "latencyClass",
      "codingCapability",
      "reasoningCapability",
      "cost",
    ],
    path,
  );
  ensureSchemaVersion(
    record["schemaVersion"],
    `${path}.schemaVersion`,
    MODEL_CAPABILITIES_SCHEMA_VERSION,
  );

  const contextWindowTokens = ensureSafeInteger(
    record["contextWindowTokens"],
    `${path}.contextWindowTokens`,
    1,
    MAX_TOKEN_COUNT,
  );

  return Object.freeze({
    schemaVersion: MODEL_CAPABILITIES_SCHEMA_VERSION,
    providerId: parseProviderId(record["providerId"], `${path}.providerId`),
    modelId: parseModelId(record["modelId"], `${path}.modelId`),
    contextWindowTokens,
    maxOutputTokens: ensureSafeInteger(
      record["maxOutputTokens"],
      `${path}.maxOutputTokens`,
      1,
      contextWindowTokens,
    ),
    supportsToolUse: ensureBoolean(record["supportsToolUse"], `${path}.supportsToolUse`),
    supportsStructuredOutput: ensureBoolean(
      record["supportsStructuredOutput"],
      `${path}.supportsStructuredOutput`,
    ),
    supportsVision: ensureBoolean(record["supportsVision"], `${path}.supportsVision`),
    locality: ensureEnum(record["locality"], `${path}.locality`, MODEL_LOCALITIES),
    latencyClass: ensureEnum(record["latencyClass"], `${path}.latencyClass`, LATENCY_CLASSES),
    codingCapability: parseRating(record["codingCapability"], `${path}.codingCapability`),
    reasoningCapability: parseRating(record["reasoningCapability"], `${path}.reasoningCapability`),
    cost: ensureNullable(record["cost"], (cost) => parseModelCostMetadata(cost, `${path}.cost`)),
  });
}

export function createModelCapabilities(
  input: Omit<ModelCapabilities, "schemaVersion">,
): ModelCapabilities {
  return parseModelCapabilities({
    schemaVersion: MODEL_CAPABILITIES_SCHEMA_VERSION,
    ...input,
  });
}

/** Provider-neutral requirements a route must satisfy. Absent fields do not constrain. */
export interface ModelRequirements {
  readonly minContextWindowTokens: number | null;
  readonly minOutputTokens: number | null;
  readonly requireToolUse: boolean;
  readonly requireStructuredOutput: boolean;
  readonly requireVision: boolean;
  readonly requireLocalExecution: boolean;
  readonly minCodingCapability: CapabilityRating | null;
  readonly minReasoningCapability: CapabilityRating | null;
}

export function parseModelRequirements(
  value: unknown,
  path = "modelRequirements",
): ModelRequirements {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "minContextWindowTokens",
      "minOutputTokens",
      "requireToolUse",
      "requireStructuredOutput",
      "requireVision",
      "requireLocalExecution",
      "minCodingCapability",
      "minReasoningCapability",
    ],
    path,
  );
  return Object.freeze({
    minContextWindowTokens: ensureNullable(record["minContextWindowTokens"], (tokens) =>
      ensureSafeInteger(tokens, `${path}.minContextWindowTokens`, 1, MAX_TOKEN_COUNT),
    ),
    minOutputTokens: ensureNullable(record["minOutputTokens"], (tokens) =>
      ensureSafeInteger(tokens, `${path}.minOutputTokens`, 1, MAX_TOKEN_COUNT),
    ),
    requireToolUse: ensureBoolean(record["requireToolUse"], `${path}.requireToolUse`),
    requireStructuredOutput: ensureBoolean(
      record["requireStructuredOutput"],
      `${path}.requireStructuredOutput`,
    ),
    requireVision: ensureBoolean(record["requireVision"], `${path}.requireVision`),
    requireLocalExecution: ensureBoolean(
      record["requireLocalExecution"],
      `${path}.requireLocalExecution`,
    ),
    minCodingCapability: ensureNullable(record["minCodingCapability"], (rating) =>
      parseRating(rating, `${path}.minCodingCapability`),
    ),
    minReasoningCapability: ensureNullable(record["minReasoningCapability"], (rating) =>
      parseRating(rating, `${path}.minReasoningCapability`),
    ),
  });
}

export function createModelRequirements(
  input: Partial<ModelRequirements> = {},
): ModelRequirements {
  return parseModelRequirements({
    minContextWindowTokens: input.minContextWindowTokens ?? null,
    minOutputTokens: input.minOutputTokens ?? null,
    requireToolUse: input.requireToolUse ?? false,
    requireStructuredOutput: input.requireStructuredOutput ?? false,
    requireVision: input.requireVision ?? false,
    requireLocalExecution: input.requireLocalExecution ?? false,
    minCodingCapability: input.minCodingCapability ?? null,
    minReasoningCapability: input.minReasoningCapability ?? null,
  });
}

export interface UnmetRequirement {
  readonly requirement: string;
  readonly message: string;
}

/** Returns every requirement the model fails to satisfy, in deterministic order. */
export function findUnmetRequirements(
  capabilities: ModelCapabilities,
  requirements: ModelRequirements,
): readonly UnmetRequirement[] {
  const model = parseModelCapabilities(capabilities);
  const needs = parseModelRequirements(requirements);
  const unmet: UnmetRequirement[] = [];

  if (
    needs.minContextWindowTokens !== null &&
    model.contextWindowTokens < needs.minContextWindowTokens
  ) {
    unmet.push({
      requirement: "context-window",
      message: `Requires a context window of at least ${needs.minContextWindowTokens} tokens.`,
    });
  }
  if (needs.minOutputTokens !== null && model.maxOutputTokens < needs.minOutputTokens) {
    unmet.push({
      requirement: "max-output",
      message: `Requires at least ${needs.minOutputTokens} output tokens.`,
    });
  }
  if (needs.requireToolUse && !model.supportsToolUse) {
    unmet.push({ requirement: "tool-use", message: "Requires tool-use support." });
  }
  if (needs.requireStructuredOutput && !model.supportsStructuredOutput) {
    unmet.push({
      requirement: "structured-output",
      message: "Requires structured-output support.",
    });
  }
  if (needs.requireVision && !model.supportsVision) {
    unmet.push({ requirement: "vision", message: "Requires vision support." });
  }
  if (needs.requireLocalExecution && model.locality !== "local") {
    unmet.push({ requirement: "local-execution", message: "Requires local execution." });
  }
  if (needs.minCodingCapability !== null && model.codingCapability < needs.minCodingCapability) {
    unmet.push({
      requirement: "coding-capability",
      message: `Requires coding capability of at least ${needs.minCodingCapability}.`,
    });
  }
  if (
    needs.minReasoningCapability !== null &&
    model.reasoningCapability < needs.minReasoningCapability
  ) {
    unmet.push({
      requirement: "reasoning-capability",
      message: `Requires reasoning capability of at least ${needs.minReasoningCapability}.`,
    });
  }

  return Object.freeze(unmet.map((entry) => Object.freeze(entry)));
}

export class UnsupportedCapabilityError extends DomainError {
  readonly unmetRequirements: readonly UnmetRequirement[];

  constructor(message: string, unmetRequirements: readonly UnmetRequirement[]) {
    super("UNSUPPORTED_CAPABILITY", message, {
      requirements: Object.freeze(unmetRequirements.map((entry) => entry.requirement)),
    });
    this.name = "UnsupportedCapabilityError";
    this.unmetRequirements = unmetRequirements;
  }
}

export function assertModelSupports(
  capabilities: ModelCapabilities,
  requirements: ModelRequirements,
): void {
  const unmet = findUnmetRequirements(capabilities, requirements);
  if (unmet.length > 0) {
    throw new UnsupportedCapabilityError(
      "The model does not satisfy the required capabilities.",
      unmet,
    );
  }
}

const MICROS_DIVISOR = 1_000_000n;

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Exact cost estimate: token counts times micro-unit prices per million
 * tokens, rounded up per category using BigInt so no precision is lost.
 * `inputTokens` bills at the input rate, `cachedInputTokens` at the cached
 * rate (falling back to the input rate), and both `outputTokens` and
 * `reasoningTokens` at the output rate.
 */
export function estimateModelCost(capabilities: ModelCapabilities, usage: TokenUsage): Money {
  const model = parseModelCapabilities(capabilities);
  const tokens = parseTokenUsage(usage);
  if (model.cost === null) {
    throw new InvariantViolationError("The model does not declare cost metadata.", {
      modelId: model.modelId,
    });
  }

  const cachedRate =
    model.cost.cachedInputMicrosPerMillionTokens ?? model.cost.inputMicrosPerMillionTokens;
  const micros =
    ceilDivide(BigInt(tokens.inputTokens) * BigInt(model.cost.inputMicrosPerMillionTokens), MICROS_DIVISOR) +
    ceilDivide(BigInt(tokens.cachedInputTokens) * BigInt(cachedRate), MICROS_DIVISOR) +
    ceilDivide(
      (BigInt(tokens.outputTokens) + BigInt(tokens.reasoningTokens)) *
        BigInt(model.cost.outputMicrosPerMillionTokens),
      MICROS_DIVISOR,
    );

  if (micros > BigInt(MAX_MONEY_MICROS)) {
    throw new InvariantViolationError("Estimated cost overflowed the safe monetary range.");
  }

  return createMoney(model.cost.currency, Number(micros));
}
