import { parseTokenUsage, validation, type JsonValue, type TokenUsage } from "@ai-dev-os/domain";
import { malformedResponseError, protocolViolationError, summarizeUpstreamError, type UpstreamErrorSummary } from "./errors.js";

const { ensureRecord } = validation;

/**
 * Validation of the OpenAI Responses wire format.
 *
 * Every shape here mirrors the published OpenAPI document exactly. Nothing
 * is inferred: unknown output-item types, unknown content-part types, and
 * unknown stream events fail closed rather than being skipped, because a
 * silently ignored item could hide a tool call, a refusal, a usage figure,
 * or a storage side effect.
 */

// ---------------------------------------------------------------------------
// Small readers over untrusted JSON
// ---------------------------------------------------------------------------

function record(value: unknown, detailCode: string): Record<string, unknown> {
  try {
    return ensureRecord(value, "wire");
  } catch {
    throw malformedResponseError(detailCode);
  }
}

function optionalString(value: unknown, detailCode: string, maxLength: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.length > maxLength) {
    throw malformedResponseError(detailCode, { maximum: maxLength });
  }
  return value;
}

function requiredString(value: unknown, detailCode: string, maxLength: number): string {
  const text = optionalString(value, detailCode, maxLength);
  if (text === null) {
    throw malformedResponseError(detailCode);
  }
  return text;
}

function nonNegativeInteger(value: unknown, detailCode: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw malformedResponseError(detailCode);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * Usage exactly as the API reports it, before projection onto the Stage 2
 * token vocabulary. `cachedTokens` is a detail of `inputTokens` and
 * `reasoningTokens` is a detail of `outputTokens`; the Stage 2 categories
 * are disjoint, so the projection subtracts.
 */
export interface OpenAiWireUsage {
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
}

export function parseWireUsage(value: unknown): OpenAiWireUsage {
  const usage = record(value, "malformed-usage");
  const inputDetails = record(usage["input_tokens_details"], "malformed-usage-input-details");
  const outputDetails = record(usage["output_tokens_details"], "malformed-usage-output-details");

  const inputTokens = nonNegativeInteger(usage["input_tokens"], "malformed-usage-input-tokens");
  const outputTokens = nonNegativeInteger(usage["output_tokens"], "malformed-usage-output-tokens");
  const totalTokens = nonNegativeInteger(usage["total_tokens"], "malformed-usage-total-tokens");
  const cachedTokens = nonNegativeInteger(inputDetails["cached_tokens"], "malformed-usage-cached-tokens");
  // `cache_write_tokens` is required by the current schema, but a null or
  // absent value is tolerated as zero so an older deployment stays usable.
  const cacheWriteTokens =
    inputDetails["cache_write_tokens"] === undefined || inputDetails["cache_write_tokens"] === null
      ? 0
      : nonNegativeInteger(inputDetails["cache_write_tokens"], "malformed-usage-cache-write-tokens");
  const reasoningTokens = nonNegativeInteger(
    outputDetails["reasoning_tokens"],
    "malformed-usage-reasoning-tokens",
  );

  if (cachedTokens > inputTokens) {
    throw malformedResponseError("contradictory-usage-cached-exceeds-input");
  }
  if (cacheWriteTokens > inputTokens) {
    throw malformedResponseError("contradictory-usage-cache-write-exceeds-input");
  }
  if (reasoningTokens > outputTokens) {
    throw malformedResponseError("contradictory-usage-reasoning-exceeds-output");
  }
  if (totalTokens !== inputTokens + outputTokens) {
    throw malformedResponseError("contradictory-usage-total-mismatch");
  }

  return Object.freeze({
    inputTokens,
    cachedTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
  });
}

/** Projects wire usage onto the disjoint Stage 2 token categories. */
export function toTokenUsage(usage: OpenAiWireUsage): TokenUsage {
  return parseTokenUsage({
    inputTokens: usage.inputTokens - usage.cachedTokens,
    outputTokens: usage.outputTokens - usage.reasoningTokens,
    cachedInputTokens: usage.cachedTokens,
    reasoningTokens: usage.reasoningTokens,
  });
}

export const ZERO_WIRE_USAGE: OpenAiWireUsage = Object.freeze({
  inputTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
});

// ---------------------------------------------------------------------------
// Response object
// ---------------------------------------------------------------------------

/** `status` vocabulary from the OpenAPI `Response` schema. */
export const OPENAI_RESPONSE_STATUSES = Object.freeze([
  "queued",
  "in_progress",
  "completed",
  "incomplete",
  "failed",
  "cancelled",
] as const);

export type OpenAiResponseStatus = (typeof OPENAI_RESPONSE_STATUSES)[number];

export const OPENAI_TERMINAL_STATUSES: readonly OpenAiResponseStatus[] = Object.freeze([
  "completed",
  "incomplete",
  "failed",
  "cancelled",
]);

export function isTerminalStatus(status: OpenAiResponseStatus): boolean {
  return OPENAI_TERMINAL_STATUSES.includes(status);
}

export interface OpenAiOutputTextPart {
  readonly type: "output_text";
  readonly text: string;
}

export interface OpenAiRefusalPart {
  readonly type: "refusal";
  readonly refusal: string;
}

export type OpenAiContentPart = OpenAiOutputTextPart | OpenAiRefusalPart;

export interface OpenAiMessageItem {
  readonly type: "message";
  readonly id: string | null;
  readonly role: string;
  readonly content: readonly OpenAiContentPart[];
}

export interface OpenAiFunctionCallItem {
  readonly type: "function_call";
  readonly id: string | null;
  readonly callId: string;
  readonly name: string;
  readonly argumentsText: string;
}

export interface OpenAiReasoningItem {
  readonly type: "reasoning";
  readonly id: string;
  readonly summaryText: string;
}

export type OpenAiOutputItem = OpenAiMessageItem | OpenAiFunctionCallItem | OpenAiReasoningItem;

/**
 * Output-item types this adapter understands. Every other documented type
 * belongs to a hosted tool that Stage 11 does not support; encountering one
 * fails closed rather than dropping model output on the floor.
 */
const SUPPORTED_ITEM_TYPES = new Set(["message", "function_call", "reasoning"]);

export interface WireLimits {
  readonly maxOutputItems: number;
  readonly maxToolCallArgumentsBytes: number;
  readonly maxTextBytes: number;
}

export function parseOutputItem(value: unknown, limits: WireLimits): OpenAiOutputItem {
  const item = record(value, "malformed-output-item");
  const type = requiredString(item["type"], "malformed-output-item-type", 64);
  if (!SUPPORTED_ITEM_TYPES.has(type)) {
    throw protocolViolationError("unsupported-output-item", { itemType: type });
  }

  if (type === "function_call") {
    return Object.freeze({
      type: "function_call" as const,
      id: optionalString(item["id"], "malformed-function-call-id", 128),
      callId: requiredString(item["call_id"], "malformed-function-call-callid", 128),
      name: requiredString(item["name"], "malformed-function-call-name", 128),
      argumentsText: requiredString(
        item["arguments"],
        "malformed-function-call-arguments",
        limits.maxToolCallArgumentsBytes,
      ),
    });
  }

  if (type === "reasoning") {
    const summary = Array.isArray(item["summary"]) ? item["summary"] : [];
    const pieces: string[] = [];
    for (const entry of summary) {
      const part = record(entry, "malformed-reasoning-summary");
      const text = optionalString(part["text"], "malformed-reasoning-summary-text", limits.maxTextBytes);
      if (text !== null) {
        pieces.push(text);
      }
    }
    return Object.freeze({
      type: "reasoning" as const,
      id: requiredString(item["id"], "malformed-reasoning-id", 128),
      summaryText: pieces.join("\n"),
    });
  }

  const rawContent = item["content"];
  if (!Array.isArray(rawContent)) {
    throw malformedResponseError("malformed-message-content");
  }
  const content: OpenAiContentPart[] = [];
  for (const entry of rawContent) {
    const part = record(entry, "malformed-content-part");
    const partType = requiredString(part["type"], "malformed-content-part-type", 64);
    if (partType === "output_text") {
      content.push(
        Object.freeze({
          type: "output_text" as const,
          text: requiredString(part["text"], "malformed-output-text", limits.maxTextBytes),
        }),
      );
    } else if (partType === "refusal") {
      content.push(
        Object.freeze({
          type: "refusal" as const,
          refusal: requiredString(part["refusal"], "malformed-refusal", limits.maxTextBytes),
        }),
      );
    } else {
      // Audio and other modalities are out of baseline scope.
      throw protocolViolationError("unsupported-content-part", { partType });
    }
  }
  return Object.freeze({
    type: "message" as const,
    id: optionalString(item["id"], "malformed-message-id", 128),
    role: requiredString(item["role"], "malformed-message-role", 32),
    content: Object.freeze(content),
  });
}

export interface OpenAiResponseSnapshot {
  readonly id: string;
  readonly status: OpenAiResponseStatus;
  readonly model: string | null;
  readonly background: boolean;
  readonly store: boolean | null;
  readonly previousResponseId: string | null;
  readonly incompleteReason: string | null;
  readonly error: UpstreamErrorSummary | null;
  readonly usage: OpenAiWireUsage | null;
  readonly output: readonly OpenAiOutputItem[];
}

const INCOMPLETE_REASON_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

export function parseResponseSnapshot(value: unknown, limits: WireLimits): OpenAiResponseSnapshot {
  const response = record(value, "malformed-response");
  if (response["object"] !== undefined && response["object"] !== "response") {
    throw malformedResponseError("unexpected-object-type");
  }
  const status = requiredString(response["status"], "malformed-response-status", 32);
  if (!(OPENAI_RESPONSE_STATUSES as readonly string[]).includes(status)) {
    // An unknown lifecycle state is state-changing by definition.
    throw protocolViolationError("unknown-response-status", { status });
  }

  const rawOutput = response["output"];
  if (rawOutput !== undefined && rawOutput !== null && !Array.isArray(rawOutput)) {
    throw malformedResponseError("malformed-response-output");
  }
  const outputArray = Array.isArray(rawOutput) ? rawOutput : [];
  if (outputArray.length > limits.maxOutputItems) {
    throw malformedResponseError("too-many-output-items", { maximum: limits.maxOutputItems });
  }

  const incompleteDetails = response["incomplete_details"];
  let incompleteReason: string | null = null;
  if (incompleteDetails !== undefined && incompleteDetails !== null) {
    const details = record(incompleteDetails, "malformed-incomplete-details");
    const reason = optionalString(details["reason"], "malformed-incomplete-reason", 64);
    incompleteReason = reason !== null && INCOMPLETE_REASON_PATTERN.test(reason) ? reason : null;
  }

  const rawError = response["error"];
  const error =
    rawError === undefined || rawError === null ? null : summarizeUpstreamError({ error: rawError });

  const rawUsage = response["usage"];
  const usage = rawUsage === undefined || rawUsage === null ? null : parseWireUsage(rawUsage);

  const background = response["background"];
  const store = response["store"];

  return Object.freeze({
    id: requiredString(response["id"], "malformed-response-id", 128),
    status: status as OpenAiResponseStatus,
    model: optionalString(response["model"], "malformed-response-model", 128),
    background: background === true,
    store: typeof store === "boolean" ? store : null,
    previousResponseId: optionalString(
      response["previous_response_id"],
      "malformed-previous-response-id",
      128,
    ),
    incompleteReason,
    error,
    usage,
    output: Object.freeze(outputArray.map((item) => parseOutputItem(item, limits))),
  });
}

// ---------------------------------------------------------------------------
// Stream event classification
// ---------------------------------------------------------------------------

/**
 * Semantic classes this adapter maps onto Stage 5 inference events. The
 * `type` strings are exactly those declared by the OpenAPI
 * `ResponseStreamEvent` union.
 */
export type OpenAiStreamEvent =
  | { readonly kind: "lifecycle"; readonly sequence: number; readonly snapshot: OpenAiResponseSnapshot }
  | { readonly kind: "terminal"; readonly sequence: number; readonly snapshot: OpenAiResponseSnapshot }
  | { readonly kind: "output-item-added"; readonly sequence: number; readonly outputIndex: number; readonly item: OpenAiOutputItem }
  | { readonly kind: "output-item-done"; readonly sequence: number; readonly outputIndex: number; readonly item: OpenAiOutputItem }
  | { readonly kind: "text-delta"; readonly sequence: number; readonly itemId: string; readonly delta: string }
  | { readonly kind: "text-done"; readonly sequence: number; readonly itemId: string; readonly text: string }
  | { readonly kind: "refusal-delta"; readonly sequence: number; readonly itemId: string; readonly delta: string }
  | { readonly kind: "refusal-done"; readonly sequence: number; readonly itemId: string; readonly refusal: string }
  | { readonly kind: "function-arguments-delta"; readonly sequence: number; readonly itemId: string; readonly delta: string }
  | { readonly kind: "function-arguments-done"; readonly sequence: number; readonly itemId: string; readonly name: string; readonly argumentsText: string }
  | { readonly kind: "reasoning-delta"; readonly sequence: number; readonly delta: string }
  | { readonly kind: "informational"; readonly sequence: number; readonly type: string }
  | { readonly kind: "error"; readonly sequence: number; readonly error: UpstreamErrorSummary };

const LIFECYCLE_TYPES = new Set(["response.created", "response.in_progress", "response.queued"]);
const TERMINAL_TYPES = new Set(["response.completed", "response.failed", "response.incomplete"]);

/**
 * Documented events that carry no semantics this adapter needs: they
 * annotate content already captured through the delta/done pairs, or they
 * bracket reasoning summary parts whose text arrives via
 * `response.reasoning_summary_text.*`. They cannot change output, usage,
 * refusal, tool, or storage state, so they warn rather than fail.
 */
const INFORMATIONAL_TYPES = new Set([
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.annotation.added",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
  "response.reasoning_text.done",
  "response.reasoning_summary_text.done",
]);

function sequenceOf(event: Record<string, unknown>): number {
  const value = event["sequence_number"];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw malformedResponseError("malformed-sequence-number");
  }
  return value;
}

/**
 * Classifies one decoded SSE payload.
 *
 * Anything not explicitly recognized fails closed. An unknown event may be
 * a hosted-tool call, a new usage carrier, a refusal variant, or a storage
 * state change, and none of those may be silently discarded — so this
 * adapter refuses rather than guessing that an addition is harmless.
 */
export function classifyStreamEvent(value: JsonValue, limits: WireLimits): OpenAiStreamEvent {
  const event = record(value, "malformed-stream-event");
  const type = requiredString(event["type"], "malformed-stream-event-type", 128);
  const sequence = sequenceOf(event);

  if (type === "error") {
    return Object.freeze({
      kind: "error" as const,
      sequence,
      error: summarizeUpstreamError(event),
    });
  }

  if (LIFECYCLE_TYPES.has(type) || TERMINAL_TYPES.has(type)) {
    const snapshot = parseResponseSnapshot(event["response"], limits);
    return Object.freeze({
      kind: TERMINAL_TYPES.has(type) ? ("terminal" as const) : ("lifecycle" as const),
      sequence,
      snapshot,
    });
  }

  if (type === "response.output_item.added" || type === "response.output_item.done") {
    return Object.freeze({
      kind: type.endsWith(".added") ? ("output-item-added" as const) : ("output-item-done" as const),
      sequence,
      outputIndex: nonNegativeInteger(event["output_index"], "malformed-output-index"),
      item: parseOutputItem(event["item"], limits),
    });
  }

  if (type === "response.output_text.delta") {
    return Object.freeze({
      kind: "text-delta" as const,
      sequence,
      itemId: requiredString(event["item_id"], "malformed-item-id", 128),
      delta: requiredString(event["delta"], "malformed-text-delta", limits.maxTextBytes),
    });
  }

  if (type === "response.output_text.done") {
    return Object.freeze({
      kind: "text-done" as const,
      sequence,
      itemId: requiredString(event["item_id"], "malformed-item-id", 128),
      text: requiredString(event["text"], "malformed-text-done", limits.maxTextBytes),
    });
  }

  if (type === "response.refusal.delta") {
    return Object.freeze({
      kind: "refusal-delta" as const,
      sequence,
      itemId: requiredString(event["item_id"], "malformed-item-id", 128),
      delta: requiredString(event["delta"], "malformed-refusal-delta", limits.maxTextBytes),
    });
  }

  if (type === "response.refusal.done") {
    return Object.freeze({
      kind: "refusal-done" as const,
      sequence,
      itemId: requiredString(event["item_id"], "malformed-item-id", 128),
      refusal: requiredString(event["refusal"], "malformed-refusal-done", limits.maxTextBytes),
    });
  }

  if (type === "response.function_call_arguments.delta") {
    return Object.freeze({
      kind: "function-arguments-delta" as const,
      sequence,
      itemId: requiredString(event["item_id"], "malformed-item-id", 128),
      delta: requiredString(
        event["delta"],
        "malformed-function-arguments-delta",
        limits.maxToolCallArgumentsBytes,
      ),
    });
  }

  if (type === "response.function_call_arguments.done") {
    return Object.freeze({
      kind: "function-arguments-done" as const,
      sequence,
      itemId: requiredString(event["item_id"], "malformed-item-id", 128),
      name: requiredString(event["name"], "malformed-function-name", 128),
      argumentsText: requiredString(
        event["arguments"],
        "malformed-function-arguments",
        limits.maxToolCallArgumentsBytes,
      ),
    });
  }

  if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
    return Object.freeze({
      kind: "reasoning-delta" as const,
      sequence,
      delta: requiredString(event["delta"], "malformed-reasoning-delta", limits.maxTextBytes),
    });
  }

  if (INFORMATIONAL_TYPES.has(type)) {
    return Object.freeze({ kind: "informational" as const, sequence, type });
  }

  throw protocolViolationError("unsupported-stream-event", { eventType: type });
}
