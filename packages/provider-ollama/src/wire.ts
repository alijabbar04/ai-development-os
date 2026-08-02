import { validation, type JsonValue } from "@ai-dev-os/domain";
import { malformedResponseError } from "./errors.js";

const { ensureRecord } = validation;

/**
 * Runtime validation of Ollama wire responses.
 *
 * Every response is untrusted input, even on loopback. Records arrive here
 * already parsed by prototype-pollution-safe JSON parsing (bounded depth,
 * node count, and string sizes); this module extracts ONLY the bounded
 * fields Stage 7 needs and never retains templates, licenses, modelfiles,
 * parameter dumps, token tables, or other large metadata. Unknown extra
 * fields are ignored (the server evolves), but every extracted field is
 * strictly validated and hostile values are rejected or safely nulled as
 * documented per field.
 */

const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DIGEST_PATTERN = /^(?:sha256:)?[a-fA-F0-9]{64}$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const DETAIL_TEXT_PATTERN = /^[A-Za-z0-9._ -]{1,64}$/;
const DONE_REASON_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,64}$/;
const MAX_WIRE_MODELS = 1_024;
const MAX_TOOL_CALLS_PER_RECORD = 64;
const MAX_CAPABILITIES = 32;
const MAX_FAMILIES = 16;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

function asRecord(value: unknown, path: string): Record<string, unknown> {
  try {
    return ensureRecord(value, path);
  } catch {
    throw malformedResponseError("invalid-response-shape");
  }
}

function optionalString(value: unknown, pattern: RegExp, maxLength: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return null;
  }
  return pattern.test(value) ? value : null;
}

function requiredModelName(value: unknown): string {
  if (typeof value !== "string" || !MODEL_NAME_PATTERN.test(value)) {
    throw malformedResponseError("invalid-model-name");
  }
  return value;
}

/** Normalizes a reported digest to bare lowercase hex; null when malformed. */
function normalizedDigestOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 71 || !DIGEST_PATTERN.test(value)) {
    return null;
  }
  const bare = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  return bare.toLowerCase();
}

/** Safe non-negative integer or null (rejecting negatives, floats, unsafe). */
function safeCountOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_COUNTER) {
    return null;
  }
  return value;
}

/**
 * Ollama timestamps are RFC3339 with offsets and nanosecond precision
 * (e.g. "2026-08-01T14:56:49.277302595-07:00"), which is wider than the
 * canonical domain timestamp. This normalizes to canonical ISO-8601 UTC,
 * returning null for anything invalid, hostile, or before the epoch.
 */
export function normalizeOllamaTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    return null;
  }
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+\-Z0-9]{8,}$/i.test(value)) {
    return null;
  }
  const parsed = new Date(value);
  const ms = parsed.valueOf();
  if (Number.isNaN(ms) || ms < 0) {
    return null;
  }
  return parsed.toISOString();
}

export interface OllamaWireModelDetails {
  readonly format: string | null;
  readonly family: string | null;
  readonly families: readonly string[];
  readonly parameterSize: string | null;
  readonly quantizationLevel: string | null;
}

function parseDetails(value: unknown): OllamaWireModelDetails {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Object.freeze({ format: null, family: null, families: Object.freeze([]), parameterSize: null, quantizationLevel: null });
  }
  const record = asRecord(value, "details");
  const familiesRaw = record["families"];
  const families: string[] = [];
  if (Array.isArray(familiesRaw)) {
    for (const item of familiesRaw.slice(0, MAX_FAMILIES)) {
      const family = optionalString(item, CAPABILITY_PATTERN, 64);
      if (family !== null && !families.includes(family)) {
        families.push(family);
      }
    }
  }
  return Object.freeze({
    format: optionalString(record["format"], DETAIL_TEXT_PATTERN, 64),
    family: optionalString(record["family"], CAPABILITY_PATTERN, 64),
    families: Object.freeze(families.sort()),
    parameterSize: optionalString(record["parameter_size"], DETAIL_TEXT_PATTERN, 64),
    quantizationLevel: optionalString(record["quantization_level"], DETAIL_TEXT_PATTERN, 64),
  });
}

export interface OllamaWireInstalledModel {
  readonly name: string;
  /** Bare lowercase hex digest; null when the server reported it malformed. */
  readonly digest: string | null;
  readonly sizeBytes: number | null;
  readonly modifiedAt: string | null;
  readonly details: OllamaWireModelDetails;
}

export interface OllamaWireTagsResponse {
  readonly models: readonly OllamaWireInstalledModel[];
  /** Entries dropped because their names failed validation. */
  readonly skippedInvalidEntries: number;
}

export function parseOllamaTagsResponse(value: JsonValue): OllamaWireTagsResponse {
  const record = asRecord(value, "tags");
  const rawModels = record["models"];
  if (!Array.isArray(rawModels)) {
    throw malformedResponseError("missing-models-array");
  }
  if (rawModels.length > MAX_WIRE_MODELS) {
    throw malformedResponseError("excessive-model-count", { maximum: MAX_WIRE_MODELS });
  }
  const models: OllamaWireInstalledModel[] = [];
  let skipped = 0;
  for (const item of rawModels) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      skipped += 1;
      continue;
    }
    const modelRecord = asRecord(item, "tags.model");
    const name = optionalString(modelRecord["name"] ?? modelRecord["model"], MODEL_NAME_PATTERN, 128);
    if (name === null) {
      skipped += 1;
      continue;
    }
    models.push(
      Object.freeze({
        name,
        digest: normalizedDigestOrNull(modelRecord["digest"]),
        sizeBytes: safeCountOrNull(modelRecord["size"]),
        modifiedAt: normalizeOllamaTimestamp(modelRecord["modified_at"]),
        details: parseDetails(modelRecord["details"]),
      }),
    );
  }
  // Deterministic order independent of server response ordering.
  models.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return Object.freeze({ models: Object.freeze(models), skippedInvalidEntries: skipped });
}

export interface OllamaWireShowResponse {
  /** Reported capability tokens (bounded, lowercase), sorted. */
  readonly capabilities: readonly string[];
  /** Context length from model_info "<architecture>.context_length". */
  readonly contextLength: number | null;
  readonly details: OllamaWireModelDetails;
}

export function parseOllamaShowResponse(value: JsonValue): OllamaWireShowResponse {
  const record = asRecord(value, "show");
  const capabilities: string[] = [];
  const rawCapabilities = record["capabilities"];
  if (Array.isArray(rawCapabilities)) {
    if (rawCapabilities.length > MAX_CAPABILITIES) {
      throw malformedResponseError("excessive-capability-count", { maximum: MAX_CAPABILITIES });
    }
    for (const item of rawCapabilities) {
      const capability = optionalString(item, CAPABILITY_PATTERN, 64);
      if (capability !== null && !capabilities.includes(capability)) {
        capabilities.push(capability);
      }
    }
  }
  let contextLength: number | null = null;
  const modelInfo = record["model_info"];
  if (typeof modelInfo === "object" && modelInfo !== null && !Array.isArray(modelInfo)) {
    const infoRecord = asRecord(modelInfo, "show.model_info");
    for (const key of Object.keys(infoRecord).sort()) {
      if (key.endsWith(".context_length")) {
        const candidate = safeCountOrNull(infoRecord[key]);
        if (candidate !== null && candidate >= 1 && candidate <= 100_000_000) {
          contextLength = candidate;
          break;
        }
      }
    }
  }
  return Object.freeze({
    capabilities: Object.freeze(capabilities.sort()),
    contextLength,
    details: parseDetails(record["details"]),
  });
}

export interface OllamaWireRunningModel {
  readonly name: string;
  readonly digest: string | null;
  readonly sizeBytes: number | null;
  readonly sizeVramBytes: number | null;
  readonly expiresAt: string | null;
  readonly contextLength: number | null;
}

export interface OllamaWirePsResponse {
  readonly models: readonly OllamaWireRunningModel[];
  readonly skippedInvalidEntries: number;
}

export function parseOllamaPsResponse(value: JsonValue): OllamaWirePsResponse {
  const record = asRecord(value, "ps");
  const rawModels = record["models"];
  if (!Array.isArray(rawModels)) {
    throw malformedResponseError("missing-models-array");
  }
  if (rawModels.length > MAX_WIRE_MODELS) {
    throw malformedResponseError("excessive-model-count", { maximum: MAX_WIRE_MODELS });
  }
  const models: OllamaWireRunningModel[] = [];
  let skipped = 0;
  for (const item of rawModels) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      skipped += 1;
      continue;
    }
    const modelRecord = asRecord(item, "ps.model");
    const name = optionalString(modelRecord["name"] ?? modelRecord["model"], MODEL_NAME_PATTERN, 128);
    if (name === null) {
      skipped += 1;
      continue;
    }
    models.push(
      Object.freeze({
        name,
        digest: normalizedDigestOrNull(modelRecord["digest"]),
        sizeBytes: safeCountOrNull(modelRecord["size"]),
        sizeVramBytes: safeCountOrNull(modelRecord["size_vram"]),
        expiresAt: normalizeOllamaTimestamp(modelRecord["expires_at"]),
        contextLength: safeCountOrNull(modelRecord["context_length"]),
      }),
    );
  }
  models.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return Object.freeze({ models: Object.freeze(models), skippedInvalidEntries: skipped });
}

export interface OllamaWireVersionResponse {
  readonly version: string;
}

export function parseOllamaVersionResponse(value: JsonValue): OllamaWireVersionResponse {
  const record = asRecord(value, "version");
  const version = optionalString(record["version"], VERSION_PATTERN, 64);
  if (version === null) {
    throw malformedResponseError("invalid-version");
  }
  return Object.freeze({ version });
}

/** True when a record is the documented error envelope { "error": ... }. */
export function isOllamaErrorRecord(value: JsonValue): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)["error"] === "string"
  );
}

export interface OllamaWireToolCall {
  readonly name: string;
  readonly arguments: JsonValue;
}

export interface OllamaWireChatCounters {
  readonly totalDurationNs: number | null;
  readonly loadDurationNs: number | null;
  readonly promptEvalCount: number | null;
  readonly promptEvalDurationNs: number | null;
  readonly evalCount: number | null;
  readonly evalDurationNs: number | null;
}

export interface OllamaWireChatRecord {
  readonly model: string;
  readonly content: string;
  readonly thinking: string;
  readonly toolCalls: readonly OllamaWireToolCall[];
  readonly done: boolean;
  readonly doneReason: string | null;
  readonly counters: OllamaWireChatCounters | null;
}

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

export function parseOllamaChatRecord(value: JsonValue): OllamaWireChatRecord {
  const record = asRecord(value, "chat");
  const model = requiredModelName(record["model"]);
  const done = record["done"];
  if (typeof done !== "boolean") {
    throw malformedResponseError("missing-done-flag");
  }

  let content = "";
  let thinking = "";
  const toolCalls: OllamaWireToolCall[] = [];
  const rawMessage = record["message"];
  if (rawMessage !== undefined && rawMessage !== null) {
    const message = asRecord(rawMessage, "chat.message");
    const role = message["role"];
    if (role !== undefined && role !== "assistant") {
      throw malformedResponseError("unexpected-message-role");
    }
    if (message["content"] !== undefined && message["content"] !== null) {
      if (typeof message["content"] !== "string") {
        throw malformedResponseError("invalid-content");
      }
      content = message["content"];
    }
    if (message["thinking"] !== undefined && message["thinking"] !== null) {
      if (typeof message["thinking"] !== "string") {
        throw malformedResponseError("invalid-thinking");
      }
      thinking = message["thinking"];
    }
    const rawToolCalls = message["tool_calls"];
    if (rawToolCalls !== undefined && rawToolCalls !== null) {
      if (!Array.isArray(rawToolCalls) || rawToolCalls.length > MAX_TOOL_CALLS_PER_RECORD) {
        throw malformedResponseError("invalid-tool-calls");
      }
      for (const rawCall of rawToolCalls) {
        const call = asRecord(rawCall, "chat.tool_call");
        const fn = asRecord(call["function"], "chat.tool_call.function");
        const name = fn["name"];
        if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
          throw malformedResponseError("invalid-tool-name");
        }
        const argumentsValue = fn["arguments"];
        if (
          typeof argumentsValue !== "object" ||
          argumentsValue === null ||
          Array.isArray(argumentsValue)
        ) {
          throw malformedResponseError("invalid-tool-arguments");
        }
        toolCalls.push(Object.freeze({ name, arguments: argumentsValue as JsonValue }));
      }
    }
  }

  let doneReason: string | null = null;
  let counters: OllamaWireChatCounters | null = null;
  if (done) {
    doneReason = optionalString(record["done_reason"], DONE_REASON_PATTERN, 64);
    counters = Object.freeze({
      totalDurationNs: safeCountOrNull(record["total_duration"]),
      loadDurationNs: safeCountOrNull(record["load_duration"]),
      promptEvalCount: safeCountOrNull(record["prompt_eval_count"]),
      promptEvalDurationNs: safeCountOrNull(record["prompt_eval_duration"]),
      evalCount: safeCountOrNull(record["eval_count"]),
      evalDurationNs: safeCountOrNull(record["eval_duration"]),
    });
  }

  return Object.freeze({
    model,
    content,
    thinking,
    toolCalls: Object.freeze(toolCalls),
    done,
    doneReason,
    counters,
  });
}
