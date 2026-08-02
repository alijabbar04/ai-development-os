import {
  canonicalizeJson,
  toCanonicalJson,
  validation,
  type JsonValue,
  type ModelId,
} from "@ai-dev-os/domain";
import { ProviderError } from "./errors.js";
import {
  parseDeadline,
  parseDisclosureContext,
  parseExecutionTraceMetadata,
  parseProviderExtensions,
  parseProviderOperationId,
  parseProviderRequestId,
  PROVIDER_CONTRACT_SCHEMA_VERSION,
  type DisclosureContext,
  type ExecutionTraceMetadata,
  type ProviderExtension,
  type ProviderOperationId,
  type ProviderRequestId,
} from "./common.js";
import { parseConversation, type ChatMessage } from "./content.js";
import { parseToolChoice, parseToolDefinition, type ToolChoice, type ToolDefinition } from "./tools.js";
import {
  parseEstimatedUsage,
  parseProviderCost,
  parseProviderLatency,
  parseProviderUsage,
  type EstimatedUsage,
  type ProviderCost,
  type ProviderLatency,
  type ProviderUsage,
} from "./usage.js";

const {
  ensureArray,
  ensureEnum,
  ensureExactKeys,
  ensureNullable,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
  ensureString,
} = validation;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_STRUCTURED_SCHEMA_TEXT = 16_384;
const MAX_STRUCTURED_VALUE_TEXT = 262_144;
export const MAX_TOOLS = 64;

/**
 * Portable sampling controls with defined cross-provider semantics. Every
 * other provider-specific knob belongs in a namespaced extension so that
 * providers which do not understand it can reject it explicitly.
 */
export interface SamplingParameters {
  /** 0..2; providers clamp to their supported range and warn. */
  readonly temperature: number | null;
  /** 0..1 nucleus sampling. */
  readonly topP: number | null;
  /** Deterministic seed where the provider supports it. */
  readonly seed: number | null;
}

export function parseSamplingParameters(value: unknown, path = "sampling"): SamplingParameters {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["temperature", "topP", "seed"], path);
  const finiteInRange = (raw: unknown, field: string, min: number, max: number): number => {
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min || raw > max) {
      throw new ProviderError("INVALID_REQUEST", `${field} must be a finite number in [${min}, ${max}].`, {
        path: `${path}.${field}`,
      });
    }
    return raw;
  };
  return Object.freeze({
    temperature: ensureNullable(record["temperature"], (raw) =>
      finiteInRange(raw, "temperature", 0, 2),
    ),
    topP: ensureNullable(record["topP"], (raw) => finiteInRange(raw, "topP", 0, 1)),
    seed: ensureNullable(record["seed"], (raw) =>
      ensureSafeInteger(raw, `${path}.seed`, 0, Number.MAX_SAFE_INTEGER),
    ),
  });
}

export interface StructuredOutputRequest {
  /** JSON-Schema-compatible object the final structured value must satisfy. */
  readonly schema: JsonValue;
  readonly strict: boolean;
}

export function parseStructuredOutputRequest(
  value: unknown,
  path = "structuredOutput",
): StructuredOutputRequest {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["schema", "strict"], path);
  const schema = canonicalizeJson(record["schema"], `${path}.schema`);
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new ProviderError("INVALID_REQUEST", "The structured-output schema must be a JSON object.", {
      path,
    });
  }
  if (toCanonicalJson(schema).length > MAX_STRUCTURED_SCHEMA_TEXT) {
    throw new ProviderError("INVALID_REQUEST", "The structured-output schema is oversized.", {
      path,
      maximum: MAX_STRUCTURED_SCHEMA_TEXT,
    });
  }
  const strict = record["strict"];
  if (typeof strict !== "boolean") {
    throw new ProviderError("INVALID_REQUEST", "structuredOutput.strict must be a boolean.", { path });
  }
  return Object.freeze({ schema, strict });
}

export interface InferenceRequest {
  readonly schemaVersion: typeof PROVIDER_CONTRACT_SCHEMA_VERSION;
  readonly requestId: ProviderRequestId;
  readonly modelId: ModelId;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly toolChoice: ToolChoice | null;
  readonly structuredOutput: StructuredOutputRequest | null;
  readonly sampling: SamplingParameters | null;
  readonly maxOutputTokens: number | null;
  readonly stopSequences: readonly string[];
  readonly disclosure: DisclosureContext;
  readonly estimatedUsage: EstimatedUsage | null;
  /** Absolute canonical instant after which the operation must stop. */
  readonly deadline: string | null;
  readonly trace: ExecutionTraceMetadata;
  readonly extensions: readonly ProviderExtension[];
}

export interface InferenceRequestInput
  extends Omit<
    Partial<InferenceRequest>,
    "schemaVersion" | "requestId" | "modelId" | "messages" | "disclosure" | "trace"
  > {
  readonly requestId: string;
  readonly modelId: string;
  readonly messages: unknown;
  readonly disclosure: DisclosureContext | unknown;
  readonly trace: ExecutionTraceMetadata | unknown;
}

export function parseInferenceRequest(value: unknown, path = "inferenceRequest"): InferenceRequest {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "schemaVersion",
      "requestId",
      "modelId",
      "messages",
      "tools",
      "toolChoice",
      "structuredOutput",
      "sampling",
      "maxOutputTokens",
      "stopSequences",
      "disclosure",
      "estimatedUsage",
      "deadline",
      "trace",
      "extensions",
    ],
    path,
  );
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, PROVIDER_CONTRACT_SCHEMA_VERSION);

  const tools =
    record["tools"] === undefined || record["tools"] === null
      ? Object.freeze([] as ToolDefinition[])
      : Object.freeze(
          ensureArray(record["tools"], `${path}.tools`, MAX_TOOLS).map((tool, index) =>
            parseToolDefinition(tool, `${path}.tools[${index}]`),
          ),
        );
  const toolNames = new Set<string>(tools.map((tool) => tool.name));
  if (toolNames.size !== tools.length) {
    throw new ProviderError("INVALID_REQUEST", "Tool names must be unique per request.", { path });
  }
  const toolChoice = ensureNullable(record["toolChoice"], (raw) =>
    parseToolChoice(raw, `${path}.toolChoice`),
  );
  if (toolChoice !== null && toolChoice.mode === "named" && !toolNames.has(toolChoice.toolName)) {
    throw new ProviderError("INVALID_REQUEST", "toolChoice names an undeclared tool.", { path });
  }
  if (toolChoice !== null && toolChoice.mode !== "none" && tools.length === 0 && toolChoice.mode !== "auto") {
    throw new ProviderError("INVALID_REQUEST", "toolChoice requires declared tools.", { path });
  }

  const stopSequences =
    record["stopSequences"] === undefined || record["stopSequences"] === null
      ? Object.freeze([] as string[])
      : Object.freeze(
          ensureArray(record["stopSequences"], `${path}.stopSequences`, 8).map((stop, index) =>
            ensureString(stop, `${path}.stopSequences[${index}]`, { maxLength: 128 }),
          ),
        );

  return Object.freeze({
    schemaVersion: PROVIDER_CONTRACT_SCHEMA_VERSION,
    requestId: parseProviderRequestId(record["requestId"], `${path}.requestId`),
    modelId: ensureString(record["modelId"], `${path}.modelId`, {
      maxLength: 128,
      pattern: ID_PATTERN,
      patternName: "ModelId",
    }) as ModelId,
    messages: parseConversation(record["messages"], `${path}.messages`),
    tools,
    toolChoice,
    structuredOutput: ensureNullable(record["structuredOutput"], (raw) =>
      parseStructuredOutputRequest(raw, `${path}.structuredOutput`),
    ),
    sampling: ensureNullable(record["sampling"], (raw) =>
      parseSamplingParameters(raw, `${path}.sampling`),
    ),
    maxOutputTokens: ensureNullable(record["maxOutputTokens"], (raw) =>
      ensureSafeInteger(raw, `${path}.maxOutputTokens`, 1, 1_000_000_000),
    ),
    stopSequences,
    disclosure: parseDisclosureContext(record["disclosure"], `${path}.disclosure`),
    estimatedUsage: ensureNullable(record["estimatedUsage"], (raw) =>
      parseEstimatedUsage(raw, `${path}.estimatedUsage`),
    ),
    deadline: ensureNullable(record["deadline"], (raw) => parseDeadline(raw, `${path}.deadline`)),
    trace: parseExecutionTraceMetadata(record["trace"], `${path}.trace`),
    extensions: parseProviderExtensions(record["extensions"], `${path}.extensions`),
  });
}

/** Typed convenience over parseInferenceRequest with optional fields defaulted. */
export function createInferenceRequest(input: InferenceRequestInput): InferenceRequest {
  return parseInferenceRequest({
    schemaVersion: PROVIDER_CONTRACT_SCHEMA_VERSION,
    requestId: input.requestId,
    modelId: input.modelId,
    messages: input.messages,
    tools: input.tools ?? [],
    toolChoice: input.toolChoice ?? null,
    structuredOutput: input.structuredOutput ?? null,
    sampling: input.sampling ?? null,
    maxOutputTokens: input.maxOutputTokens ?? null,
    stopSequences: input.stopSequences ?? [],
    disclosure: input.disclosure,
    estimatedUsage: input.estimatedUsage ?? null,
    deadline: input.deadline ?? null,
    trace: input.trace,
    extensions: input.extensions ?? [],
  });
}

export const FINISH_REASONS = Object.freeze([
  "stop",
  "length",
  "tool-calls",
  "content-filter",
  "refusal",
] as const);

export type FinishReason = (typeof FINISH_REASONS)[number];

export interface InferenceResult {
  readonly schemaVersion: typeof PROVIDER_CONTRACT_SCHEMA_VERSION;
  readonly operationId: ProviderOperationId;
  readonly requestId: ProviderRequestId;
  readonly modelId: ModelId;
  /** Assistant output messages, including tool-invocation parts. */
  readonly messages: readonly ChatMessage[];
  readonly structuredOutput: JsonValue | null;
  readonly finishReason: FinishReason;
  readonly refusalMessage: string | null;
  readonly usage: ProviderUsage;
  readonly cost: ProviderCost;
  readonly latency: ProviderLatency;
  readonly warnings: readonly string[];
}

export function parseInferenceResult(value: unknown, path = "inferenceResult"): InferenceResult {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "schemaVersion",
      "operationId",
      "requestId",
      "modelId",
      "messages",
      "structuredOutput",
      "finishReason",
      "refusalMessage",
      "usage",
      "cost",
      "latency",
      "warnings",
    ],
    path,
  );
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, PROVIDER_CONTRACT_SCHEMA_VERSION);

  const messages = Object.freeze(
    ensureArray(record["messages"], `${path}.messages`, 16).map((message, index) => {
      const parsed = parseConversation([message], `${path}.messages[${index}]`)[0]!;
      if (parsed.role !== "assistant") {
        throw new ProviderError("MALFORMED_RESPONSE", "Result messages must be assistant messages.", {
          path: `${path}.messages[${index}]`,
        });
      }
      return parsed;
    }),
  );

  const structuredOutput = ensureNullable(record["structuredOutput"], (raw) => {
    const canonical = canonicalizeJson(raw, `${path}.structuredOutput`);
    if (toCanonicalJson(canonical).length > MAX_STRUCTURED_VALUE_TEXT) {
      throw new ProviderError("MALFORMED_RESPONSE", "The structured output is oversized.", {
        maximum: MAX_STRUCTURED_VALUE_TEXT,
      });
    }
    return canonical;
  });

  return Object.freeze({
    schemaVersion: PROVIDER_CONTRACT_SCHEMA_VERSION,
    operationId: parseProviderOperationId(record["operationId"], `${path}.operationId`),
    requestId: parseProviderRequestId(record["requestId"], `${path}.requestId`),
    modelId: ensureString(record["modelId"], `${path}.modelId`, {
      maxLength: 128,
      pattern: ID_PATTERN,
      patternName: "ModelId",
    }) as ModelId,
    messages,
    structuredOutput,
    finishReason: ensureEnum(record["finishReason"], `${path}.finishReason`, FINISH_REASONS),
    refusalMessage: ensureNullable(record["refusalMessage"], (raw) =>
      ensureString(raw, `${path}.refusalMessage`, { maxLength: 4_000 }),
    ),
    usage: parseProviderUsage(record["usage"], `${path}.usage`),
    cost: parseProviderCost(record["cost"], `${path}.cost`),
    latency: parseProviderLatency(record["latency"], `${path}.latency`),
    warnings: Object.freeze(
      ensureArray(record["warnings"] ?? [], `${path}.warnings`, 32).map((warning, index) =>
        ensureString(warning, `${path}.warnings[${index}]`, { maxLength: 1_000 }),
      ),
    ),
  });
}
