import { parseJsonText, toCanonicalJson, validation, type JsonValue } from "@ai-dev-os/domain";
import { ProviderError, parseProviderUsage, parseToolInvocation, type FinishReason, type ProviderUsage, type ToolInvocation } from "@ai-dev-os/providers";

const { ensureArray, ensureRecord, ensureSafeInteger, ensureString } = validation;

export interface WireToolCall { readonly index: number; readonly id: string | null; readonly name: string | null; readonly argumentsDelta: string }
export interface WireDelta { readonly text: string; readonly reasoning: string; readonly toolCalls: readonly WireToolCall[]; readonly finishReason: FinishReason | null; readonly usage: ProviderUsage | null; readonly model: string | null }
export interface WireCompletion { readonly text: string; readonly reasoning: string; readonly invocations: readonly ToolInvocation[]; readonly finishReason: FinishReason; readonly usage: ProviderUsage; readonly model: string }

function optionalString(value: unknown, path: string, maximum = 262_144): string {
  if (value === undefined || value === null) return "";
  return ensureString(value, path, { minLength: 0, maxLength: maximum });
}

function finish(value: unknown, terminalRequired: boolean): FinishReason | null {
  if (value === null || value === undefined) {
    if (terminalRequired) throw new ProviderError("MALFORMED_RESPONSE", "The completion omitted its terminal finish reason.", {});
    return null;
  }
  if (typeof value !== "string" || value.length > 64) throw new ProviderError("MALFORMED_RESPONSE", "The completion returned an invalid finish reason.", {});
  const mapped: Readonly<Record<string, FinishReason>> = { stop: "stop", length: "length", tool_calls: "tool-calls", function_call: "tool-calls", content_filter: "content-filter" };
  const result = mapped[value];
  if (result === undefined) throw new ProviderError("MALFORMED_RESPONSE", "The completion returned an unknown finish reason.", { finishReason: value });
  return result;
}

function usage(value: unknown): ProviderUsage | null {
  if (value === undefined || value === null) return null;
  const input = ensureRecord(value, "usage");
  const promptDetails = input["prompt_tokens_details"] === undefined || input["prompt_tokens_details"] === null ? {} : ensureRecord(input["prompt_tokens_details"], "usage.prompt_tokens_details");
  const completionDetails = input["completion_tokens_details"] === undefined || input["completion_tokens_details"] === null ? {} : ensureRecord(input["completion_tokens_details"], "usage.completion_tokens_details");
  const prompt = ensureSafeInteger(input["prompt_tokens"] ?? 0, "usage.prompt_tokens", 0, 1_000_000_000);
  const completion = ensureSafeInteger(input["completion_tokens"] ?? 0, "usage.completion_tokens", 0, 1_000_000_000);
  const cached = ensureSafeInteger(promptDetails["cached_tokens"] ?? 0, "usage.prompt_tokens_details.cached_tokens", 0, prompt);
  const reasoning = ensureSafeInteger(completionDetails["reasoning_tokens"] ?? 0, "usage.completion_tokens_details.reasoning_tokens", 0, completion);
  return parseProviderUsage({ tokens: {
    inputTokens: prompt - cached,
    outputTokens: completion - reasoning,
    cachedInputTokens: cached,
    reasoningTokens: reasoning,
  }, toolCalls: 0 });
}

function toolCalls(value: unknown, path: string, deltas: boolean): readonly WireToolCall[] {
  if (value === undefined || value === null) return [];
  return Object.freeze(ensureArray(value, path, 64).map((raw, position) => {
    const item = ensureRecord(raw, `${path}[${position}]`);
    const fn = ensureRecord(item["function"], `${path}[${position}].function`);
    const index = deltas ? ensureSafeInteger(item["index"] ?? position, `${path}[${position}].index`, 0, 63) : position;
    return Object.freeze({
      index,
      id: item["id"] === undefined || item["id"] === null ? null : ensureString(item["id"], `${path}[${position}].id`, { maxLength: 128 }),
      name: fn["name"] === undefined || fn["name"] === null ? null : ensureString(fn["name"], `${path}[${position}].function.name`, { maxLength: 64 }),
      argumentsDelta: optionalString(fn["arguments"], `${path}[${position}].function.arguments`, 1_048_576),
    });
  }));
}

export function parseChatCompletion(value: JsonValue, expectedModel: string): WireCompletion {
  try {
    const root = ensureRecord(value, "completion");
    const model = ensureString(root["model"], "completion.model", { maxLength: 128 });
    if (model !== expectedModel) throw new ProviderError("PROTOCOL_VIOLATION", "The provider returned a different model than explicitly requested.", { expectedModel, returnedModel: model });
    const choices = ensureArray(root["choices"], "completion.choices", 8);
    if (choices.length !== 1) throw new ProviderError("MALFORMED_RESPONSE", "Exactly one completion choice is required.", { choiceCount: choices.length });
    const choice = ensureRecord(choices[0], "completion.choices[0]");
    const message = ensureRecord(choice["message"], "completion.choices[0].message");
    const calls = toolCalls(message["tool_calls"], "completion.choices[0].message.tool_calls", false).map((call) => {
      if (call.id === null || call.name === null) throw new ProviderError("TOOL_PROTOCOL_FAILURE", "A completed tool call omitted its ID or name.", {});
      let args: JsonValue;
      try { args = parseJsonText(call.argumentsDelta, "tool.arguments"); } catch { throw new ProviderError("TOOL_PROTOCOL_FAILURE", "Tool arguments were not valid bounded JSON.", { toolName: call.name }); }
      return parseToolInvocation({ toolCallId: call.id, toolName: call.name, arguments: args });
    });
    const parsedUsage = usage(root["usage"]);
    if (parsedUsage === null) throw new ProviderError("MALFORMED_RESPONSE", "The completion omitted usage.", {});
    return Object.freeze({ text: optionalString(message["content"], "completion.message.content"), reasoning: optionalString(message["reasoning_content"] ?? message["reasoning"], "completion.message.reasoning"), invocations: Object.freeze(calls), finishReason: finish(choice["finish_reason"], true)!, usage: Object.freeze({ ...parsedUsage, toolCalls: calls.length }), model });
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("MALFORMED_RESPONSE", "The provider returned an invalid Chat Completions response.", { causeName: error instanceof Error ? error.name : typeof error });
  }
}

export function parseChatCompletionDelta(value: JsonValue): WireDelta {
  try {
    const root = ensureRecord(value, "chunk");
    const choices = ensureArray(root["choices"] ?? [], "chunk.choices", 8);
    if (choices.length > 1) throw new ProviderError("MALFORMED_RESPONSE", "A stream chunk contained multiple choices.", { choiceCount: choices.length });
    if (choices.length === 0) return Object.freeze({ text: "", reasoning: "", toolCalls: [], finishReason: null, usage: usage(root["usage"]), model: root["model"] === undefined ? null : ensureString(root["model"], "chunk.model", { maxLength: 128 }) });
    const choice = ensureRecord(choices[0], "chunk.choices[0]");
    const delta = ensureRecord(choice["delta"] ?? {}, "chunk.choices[0].delta");
    return Object.freeze({
      text: optionalString(delta["content"], "chunk.delta.content"),
      reasoning: optionalString(delta["reasoning_content"] ?? delta["reasoning"], "chunk.delta.reasoning"),
      toolCalls: toolCalls(delta["tool_calls"], "chunk.delta.tool_calls", true),
      finishReason: finish(choice["finish_reason"], false),
      usage: usage(root["usage"]),
      model: root["model"] === undefined ? null : ensureString(root["model"], "chunk.model", { maxLength: 128 }),
    });
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("MALFORMED_RESPONSE", "The provider returned an invalid Chat Completions stream chunk.", { canonicalBytes: toCanonicalJson(value).length });
  }
}

export function httpStatusError(status: number, headers: Readonly<Record<string, string>>): ProviderError {
  const retryAfterRaw = headers["retry-after"];
  let retryAfterMs: number | null = null;
  if (retryAfterRaw !== undefined && /^\d+$/u.test(retryAfterRaw)) retryAfterMs = Math.min(Number(retryAfterRaw) * 1_000, 86_400_000);
  const code = status === 401 ? "AUTHENTICATION_FAILED" : status === 403 ? "AUTHORIZATION_FAILED" : status === 404 ? "MODEL_UNAVAILABLE" : status === 408 ? "TIMEOUT" : status === 413 ? "CONTEXT_LIMIT_EXCEEDED" : status === 429 ? "RATE_LIMITED" : status >= 500 ? "PROVIDER_OVERLOADED" : "INVALID_REQUEST";
  return new ProviderError(code, "The provider rejected the request.", { status }, { retryAfterMs });
}
