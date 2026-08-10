import {
  canonicalizeJson,
  toCanonicalJson,
  validation,
  type JsonObject,
  type JsonValue,
} from "@ai-dev-os/domain";
import {
  ProviderError,
  type InferenceRequest,
  type ToolChoice,
} from "@ai-dev-os/providers";
import type { AnthropicAdapterConfiguration } from "./contracts.js";
import {
  ANTHROPIC_TRANSPORT_FAILURE_KINDS,
  type AnthropicTransportFailureKind,
} from "./contracts.js";

const {
  ensureArray,
  ensureEnum,
  ensureExactKeys,
  ensureRecord,
  ensureSafeInteger,
  ensureString,
} = validation;

const WIRE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface AnthropicWireUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly thinkingTokens: number | null;
}

export type AnthropicWireContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: JsonValue;
    };

export type AnthropicWireEvent =
  | {
      readonly type: "message_start";
      readonly message: {
        readonly id: string;
        readonly model: string;
        readonly usage: AnthropicWireUsage;
      };
    }
  | {
      readonly type: "content_block_start";
      readonly index: number;
      readonly contentBlock: AnthropicWireContentBlock;
    }
  | {
      readonly type: "content_block_delta";
      readonly index: number;
      readonly delta:
        | { readonly type: "text_delta"; readonly text: string }
        | { readonly type: "input_json_delta"; readonly partialJson: string };
    }
  | { readonly type: "content_block_stop"; readonly index: number }
  | {
      readonly type: "message_delta";
      readonly stopReason: string | null;
      readonly usage: AnthropicWireUsage;
    }
  | { readonly type: "message_stop" }
  | { readonly type: "ping" }
  | { readonly type: "error"; readonly errorType: AnthropicTransportFailureKind | "unknown" };

function unsupported(message: string, details: Record<string, string | number | boolean | null> = {}): never {
  throw new ProviderError("UNSUPPORTED_CAPABILITY", message, details);
}

function textOfPart(part: InferenceRequest["messages"][number]["parts"][number]): string {
  if (part.type === "text") return part.text;
  if (part.type === "json") return toCanonicalJson(part.value);
  unsupported("The direct Anthropic profile supports only text/JSON, tool invocation, and tool result message parts.", { partType: part.type });
}

function toolChoice(choice: ToolChoice | null): JsonObject | undefined {
  if (choice === null || choice.mode === "auto") return undefined;
  if (choice.mode === "none") return { type: "none" };
  if (choice.mode === "required") return { type: "any" };
  return { type: "tool", name: choice.toolName };
}

export function buildAnthropicRequestBody(
  request: InferenceRequest,
  configuration: AnthropicAdapterConfiguration,
): JsonObject {
  if (request.extensions.length !== 0) {
    unsupported("The fixed Anthropic profile accepts no provider extensions.");
  }
  if (request.sampling?.seed !== null && request.sampling?.seed !== undefined) {
    unsupported("The fixed Anthropic profile does not support deterministic seeds.");
  }
  if ((request.sampling?.temperature ?? 0) > 1) {
    unsupported("Anthropic temperature cannot exceed 1.");
  }
  const system: Array<{ readonly type: "text"; readonly text: string }> = [];
  const messages: JsonValue[] = [];
  for (const message of request.messages) {
    if (message.role === "system" || message.role === "developer") {
      for (const part of message.parts) system.push(Object.freeze({ type: "text", text: textOfPart(part) }));
      continue;
    }
    const content: JsonValue[] = [];
    for (const part of message.parts) {
      if (part.type === "text" || part.type === "json") {
        content.push({ type: "text", text: textOfPart(part) });
      } else if (part.type === "tool-invocation") {
        content.push({
          type: "tool_use",
          id: part.invocation.toolCallId,
          name: part.invocation.toolName,
          input: part.invocation.arguments,
        });
      } else if (part.type === "tool-result") {
        content.push({
          type: "tool_result",
          tool_use_id: part.result.toolCallId,
          content: part.result.status === "succeeded"
            ? toCanonicalJson(part.result.output)
            : toCanonicalJson(part.result.failure),
          is_error: part.result.status === "failed",
        });
      } else {
        unsupported("Artifact content requires a separately reviewed resolver and is not in the Stage 18B profile.", { partType: part.type });
      }
    }
    messages.push({ role: message.role === "tool" ? "user" : message.role, content });
  }
  const body: Record<string, JsonValue> = {
    model: configuration.model.responseModelId,
    max_tokens: request.maxOutputTokens ?? configuration.model.capabilities.maxOutputTokens,
    messages,
    stream: true,
  };
  if (system.length > 0) body["system"] = system;
  if (request.stopSequences.length > 0) body["stop_sequences"] = request.stopSequences;
  if (request.sampling?.temperature !== null && request.sampling?.temperature !== undefined) {
    body["temperature"] = request.sampling.temperature;
  }
  if (request.sampling?.topP !== null && request.sampling?.topP !== undefined) {
    body["top_p"] = request.sampling.topP;
  }
  if (request.tools.length > 0) {
    body["tools"] = request.tools.map((tool) => {
      if (tool.executionLocation !== "caller") {
        unsupported("The Stage 18B Anthropic profile permits only caller-executed client tools.");
      }
      return {
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
        strict: true,
      };
    });
  }
  const choice = toolChoice(request.toolChoice);
  if (choice !== undefined) body["tool_choice"] = choice;
  if (request.structuredOutput !== null) {
    body["output_config"] = {
      format: {
        type: "json_schema",
        schema: request.structuredOutput.schema,
      },
    };
  }
  return canonicalizeJson(body, "anthropicRequestBody") as JsonObject;
}

function optionalCount(value: unknown, path: string): number | null {
  return value === undefined || value === null
    ? null
    : ensureSafeInteger(value, path, 0, 1_000_000_000_000);
}

function parseUsage(value: unknown, path: string): AnthropicWireUsage {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, [
    "input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens_details",
  ], path);
  const details = input["output_tokens_details"] === undefined || input["output_tokens_details"] === null
    ? null
    : ensureRecord(input["output_tokens_details"], `${path}.output_tokens_details`);
  if (details !== null) ensureExactKeys(details, ["thinking_tokens"], `${path}.output_tokens_details`);
  return Object.freeze({
    inputTokens: optionalCount(input["input_tokens"], `${path}.input_tokens`),
    outputTokens: optionalCount(input["output_tokens"], `${path}.output_tokens`),
    cacheCreationInputTokens: optionalCount(input["cache_creation_input_tokens"], `${path}.cache_creation_input_tokens`),
    cacheReadInputTokens: optionalCount(input["cache_read_input_tokens"], `${path}.cache_read_input_tokens`),
    thinkingTokens: details === null ? null : optionalCount(details["thinking_tokens"], `${path}.output_tokens_details.thinking_tokens`),
  });
}

function parseContentBlock(value: unknown, path: string): AnthropicWireContentBlock {
  const input = ensureRecord(value, path);
  const type = ensureEnum(input["type"], `${path}.type`, ["text", "tool_use"] as const);
  if (type === "text") {
    ensureExactKeys(input, ["type", "text"], path);
    return Object.freeze({
      type,
      text: ensureString(input["text"], `${path}.text`, { minLength: 0, maxLength: 262_144 }),
    });
  }
  ensureExactKeys(input, ["type", "id", "name", "input"], path);
  return Object.freeze({
    type,
    id: ensureString(input["id"], `${path}.id`, { maxLength: 256, pattern: WIRE_ID, patternName: "tool use id" }),
    name: ensureString(input["name"], `${path}.name`, { maxLength: 128 }),
    input: canonicalizeJson(input["input"], `${path}.input`),
  });
}

export function parseAnthropicWireEvent(value: unknown, path = "anthropicEvent"): AnthropicWireEvent {
  const input = ensureRecord(value, path);
  const type = ensureEnum(input["type"], `${path}.type`, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
    "ping",
    "error",
  ] as const);
  switch (type) {
    case "message_start": {
      ensureExactKeys(input, ["type", "message"], path);
      const message = ensureRecord(input["message"], `${path}.message`);
      ensureExactKeys(message, ["id", "type", "role", "content", "model", "stop_reason", "stop_sequence", "usage"], `${path}.message`);
      if (message["type"] !== "message" || message["role"] !== "assistant") {
        throw new ProviderError("PROTOCOL_VIOLATION", "Anthropic message_start has an invalid message role or type.");
      }
      const content = ensureArray(message["content"], `${path}.message.content`, 64);
      if (content.length !== 0 || message["stop_reason"] !== null || message["stop_sequence"] !== null) {
        throw new ProviderError("PROTOCOL_VIOLATION", "Anthropic message_start must be non-terminal with empty content.");
      }
      return Object.freeze({
        type,
        message: Object.freeze({
          id: ensureString(message["id"], `${path}.message.id`, { maxLength: 256, pattern: WIRE_ID, patternName: "message id" }),
          model: ensureString(message["model"], `${path}.message.model`, { maxLength: 128, pattern: WIRE_ID, patternName: "model id" }),
          usage: parseUsage(message["usage"], `${path}.message.usage`),
        }),
      });
    }
    case "content_block_start":
      ensureExactKeys(input, ["type", "index", "content_block"], path);
      return Object.freeze({
        type,
        index: ensureSafeInteger(input["index"], `${path}.index`, 0, 63),
        contentBlock: parseContentBlock(input["content_block"], `${path}.content_block`),
      });
    case "content_block_delta": {
      ensureExactKeys(input, ["type", "index", "delta"], path);
      const delta = ensureRecord(input["delta"], `${path}.delta`);
      const deltaType = ensureEnum(delta["type"], `${path}.delta.type`, ["text_delta", "input_json_delta"] as const);
      ensureExactKeys(delta, deltaType === "text_delta" ? ["type", "text"] : ["type", "partial_json"], `${path}.delta`);
      return Object.freeze({
        type,
        index: ensureSafeInteger(input["index"], `${path}.index`, 0, 63),
        delta: deltaType === "text_delta"
          ? Object.freeze({ type: deltaType, text: ensureString(delta["text"], `${path}.delta.text`, { minLength: 0, maxLength: 262_144 }) })
          : Object.freeze({ type: deltaType, partialJson: ensureString(delta["partial_json"], `${path}.delta.partial_json`, { minLength: 0, maxLength: 262_144 }) }),
      });
    }
    case "content_block_stop":
      ensureExactKeys(input, ["type", "index"], path);
      return Object.freeze({ type, index: ensureSafeInteger(input["index"], `${path}.index`, 0, 63) });
    case "message_delta": {
      ensureExactKeys(input, ["type", "delta", "usage"], path);
      const delta = ensureRecord(input["delta"], `${path}.delta`);
      ensureExactKeys(delta, ["stop_reason", "stop_sequence"], `${path}.delta`);
      if (delta["stop_sequence"] !== null) {
        ensureString(delta["stop_sequence"], `${path}.delta.stop_sequence`, { maxLength: 1_024 });
      }
      const stopReason = delta["stop_reason"] === null
        ? null
        : ensureString(delta["stop_reason"], `${path}.delta.stop_reason`, { maxLength: 64 });
      return Object.freeze({ type, stopReason, usage: parseUsage(input["usage"], `${path}.usage`) });
    }
    case "message_stop":
      ensureExactKeys(input, ["type"], path);
      return Object.freeze({ type });
    case "ping":
      ensureExactKeys(input, ["type"], path);
      return Object.freeze({ type });
    case "error": {
      ensureExactKeys(input, ["type", "error"], path);
      const error = ensureRecord(input["error"], `${path}.error`);
      ensureExactKeys(error, ["type", "message"], `${path}.error`);
      ensureString(error["message"], `${path}.error.message`, { maxLength: 8_192 });
      const rawErrorType = ensureString(error["type"], `${path}.error.type`, { maxLength: 64 });
      return Object.freeze({
        type,
        errorType: ANTHROPIC_TRANSPORT_FAILURE_KINDS.includes(rawErrorType as AnthropicTransportFailureKind)
          ? rawErrorType as AnthropicTransportFailureKind
          : "unknown" as const,
      });
    }
  }
}
