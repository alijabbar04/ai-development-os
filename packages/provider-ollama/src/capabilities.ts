import {
  parseModelCapabilities,
  type ModelCapabilities,
} from "@ai-dev-os/domain";
import type { OllamaCapabilityOverride } from "./config.js";

/**
 * Capability normalization.
 *
 * Sources, in conservative order:
 *
 * 1. explicit capability tokens reported by POST /api/show ("completion",
 *    "tools", "thinking", "vision", "embedding", ...);
 * 2. validated model metadata (context length from model_info);
 * 3. versioned family knowledge (below) — used ONLY for the coarse Stage 2
 *    rating/latency fields that Ollama does not report, never to enable a
 *    wire capability;
 * 4. restrictive configuration overrides (they can only remove or bound a
 *    capability, never add one);
 * 5. capability probes are NOT implemented in Stage 7.
 *
 * Unknown capabilities stay unsupported. Provenance is recorded per field
 * so later routing can explain eligibility decisions.
 */

export const OLLAMA_FAMILY_KNOWLEDGE_VERSION = 1 as const;

export type OllamaCapabilityProvenance =
  | "reported"
  | "derived"
  | "family-knowledge"
  | "configuration-restricted"
  | "unknown";

export interface OllamaNormalizedCapabilities {
  /** The model accepts /api/chat completion requests. */
  readonly chat: boolean;
  /** Chat-capable models stream NDJSON; derived from `chat`. */
  readonly streaming: boolean;
  /**
   * Server-enforced `format` (JSON / JSON Schema) works for every
   * completion-capable model; derived from `chat`.
   */
  readonly structuredOutput: boolean;
  readonly toolCalling: boolean;
  readonly reasoning: boolean;
  readonly vision: boolean;
  readonly embedding: boolean;
  readonly contextLength: number | null;
  readonly provenance: Readonly<Record<string, OllamaCapabilityProvenance>>;
}

export function normalizeOllamaCapabilities(options: {
  readonly reportedCapabilities: readonly string[];
  readonly contextLength: number | null;
  readonly override: OllamaCapabilityOverride | null;
}): OllamaNormalizedCapabilities {
  const reported = new Set(options.reportedCapabilities);
  const override = options.override;
  const provenance: Record<string, OllamaCapabilityProvenance> = {};

  const chat = reported.has("completion");
  provenance["chat"] = reported.size === 0 ? "unknown" : "reported";

  const restricted = (
    value: boolean,
    denied: boolean,
    key: string,
  ): boolean => {
    if (!value) {
      provenance[key] = reported.size === 0 ? "unknown" : "reported";
      return false;
    }
    if (denied) {
      provenance[key] = "configuration-restricted";
      return false;
    }
    provenance[key] = "reported";
    return true;
  };

  const toolCalling = restricted(reported.has("tools"), override?.denyToolCalling ?? false, "toolCalling");
  const reasoning = restricted(reported.has("thinking"), override?.denyReasoning ?? false, "reasoning");
  const vision = restricted(reported.has("vision"), override?.denyVision ?? false, "vision");
  const embedding = reported.has("embedding");
  provenance["embedding"] = reported.size === 0 ? "unknown" : "reported";

  let structuredOutput = chat;
  provenance["structuredOutput"] = chat ? "derived" : provenance["chat"]!;
  if (structuredOutput && (override?.denyStructuredOutput ?? false)) {
    structuredOutput = false;
    provenance["structuredOutput"] = "configuration-restricted";
  }
  provenance["streaming"] = provenance["chat"]!;
  if (chat) {
    provenance["streaming"] = "derived";
  }

  let contextLength = options.contextLength;
  provenance["contextLength"] = contextLength === null ? "unknown" : "reported";
  const maxContextLength = override?.maxContextLength ?? null;
  if (maxContextLength !== null && (contextLength === null || contextLength > maxContextLength)) {
    contextLength = contextLength === null ? maxContextLength : Math.min(contextLength, maxContextLength);
    provenance["contextLength"] = "configuration-restricted";
  }

  return Object.freeze({
    chat,
    streaming: chat,
    structuredOutput,
    toolCalling,
    reasoning,
    vision,
    embedding,
    contextLength,
    provenance: Object.freeze(provenance),
  });
}

interface FamilyRating {
  readonly coding: 1 | 2 | 3 | 4 | 5;
  readonly reasoning: 1 | 2 | 3 | 4 | 5;
}

/**
 * Versioned, deliberately coarse family knowledge for the Stage 2 rating
 * fields (which have no Ollama wire source). Conservative by construction:
 * unknown families rate 2/2. See OLLAMA_FAMILY_KNOWLEDGE_VERSION.
 */
const FAMILY_RATINGS: ReadonlyMap<string, FamilyRating> = new Map<string, FamilyRating>([
  ["deepseek", { coding: 3, reasoning: 4 }],
  ["deepseek2", { coding: 3, reasoning: 4 }],
  ["qwen2", { coding: 3, reasoning: 3 }],
  ["qwen3", { coding: 3, reasoning: 3 }],
  ["llama", { coding: 2, reasoning: 2 }],
  ["gemma", { coding: 2, reasoning: 2 }],
  ["gemma2", { coding: 2, reasoning: 2 }],
  ["gemma3", { coding: 2, reasoning: 2 }],
  ["mistral", { coding: 3, reasoning: 2 }],
]);

const DEFAULT_RATING: FamilyRating = { coding: 2, reasoning: 2 };

function familyRating(families: readonly (string | null)[]): FamilyRating {
  for (const family of families) {
    if (family !== null) {
      const rating = FAMILY_RATINGS.get(family);
      if (rating !== undefined) {
        return rating;
      }
    }
  }
  return DEFAULT_RATING;
}

/** Latency class from the reported parameter-size label; conservative default. */
function latencyClassOf(parameterSize: string | null): "fast" | "standard" | "slow" {
  if (parameterSize === null) {
    return "standard";
  }
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([MB])/i.exec(parameterSize);
  if (match === null) {
    return "standard";
  }
  const scale = match[2]!.toUpperCase() === "M" ? 0.001 : 1;
  const billions = Number.parseFloat(match[1]!) * scale;
  if (!Number.isFinite(billions)) {
    return "standard";
  }
  if (billions < 8) {
    return "fast";
  }
  return billions <= 20 ? "standard" : "slow";
}

const DOMAIN_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Conservative context window when the server does not report one. */
export const DEFAULT_UNKNOWN_CONTEXT_LENGTH = 4_096;

/**
 * Converts a normalized local model into the Stage 2 ModelCapabilities
 * shape. Returns null when the model cannot be represented (no chat
 * capability, or a native name outside the domain ModelId grammar — for
 * example registry names containing "/").
 */
export function toStage2ModelCapabilities(options: {
  readonly providerId: string;
  readonly modelName: string;
  readonly capabilities: OllamaNormalizedCapabilities;
  readonly family: string | null;
  readonly families: readonly string[];
  readonly parameterSize: string | null;
}): ModelCapabilities | null {
  if (!options.capabilities.chat || !DOMAIN_MODEL_ID_PATTERN.test(options.modelName)) {
    return null;
  }
  const rating = familyRating([options.family, ...options.families]);
  const contextWindowTokens = options.capabilities.contextLength ?? DEFAULT_UNKNOWN_CONTEXT_LENGTH;
  return parseModelCapabilities({
    schemaVersion: 1,
    providerId: options.providerId,
    modelId: options.modelName,
    contextWindowTokens,
    maxOutputTokens: contextWindowTokens,
    supportsToolUse: options.capabilities.toolCalling,
    supportsStructuredOutput: options.capabilities.structuredOutput,
    supportsVision: options.capabilities.vision,
    locality: "local",
    latencyClass: latencyClassOf(options.parameterSize),
    codingCapability: rating.coding,
    reasoningCapability: rating.reasoning,
    cost: null,
  });
}
