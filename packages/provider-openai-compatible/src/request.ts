import { toCanonicalJson, type JsonValue } from "@ai-dev-os/domain";
import { ProviderError, type ChatMessage, type InferenceRequest, type ToolChoice, type ToolDefinition } from "@ai-dev-os/providers";
import type { OpenAiCompatibleProfile } from "./types.js";

function contentText(message: ChatMessage): string {
  const chunks: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") chunks.push(part.text);
    else if (part.type === "json") chunks.push(toCanonicalJson(part.value));
    else if (part.type !== "tool-invocation" && part.type !== "tool-result") throw new ProviderError("UNSUPPORTED_CAPABILITY", "This Chat Completions profile supports text content only.", { partType: part.type });
  }
  return chunks.join("\n");
}

function toolChoice(choice: ToolChoice | null): JsonValue | undefined {
  if (choice === null) return undefined;
  if (choice.mode !== "named") return choice.mode;
  return { type: "function", function: { name: choice.toolName } };
}

function tools(definitions: readonly ToolDefinition[]): JsonValue[] {
  return definitions.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: true } }));
}

function wireMessages(messages: readonly ChatMessage[]): JsonValue[] {
  const output: JsonValue[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      for (const part of message.parts) {
        if (part.type !== "tool-result") throw new ProviderError("INVALID_REQUEST", "Tool messages may contain only tool results for this adapter.", {});
        const result = part.result;
        output.push({ role: "tool", tool_call_id: result.toolCallId, content: result.status === "succeeded" ? toCanonicalJson(result.output) : toCanonicalJson({ error: result.failure }) });
      }
      continue;
    }
    if (message.role === "assistant") {
      const calls = message.parts.filter((part) => part.type === "tool-invocation").map((part) => {
        if (part.type !== "tool-invocation") throw new ProviderError("INTERNAL_FAILURE", "Tool invocation filtering failed.", {});
        return { id: part.invocation.toolCallId, type: "function", function: { name: part.invocation.toolName, arguments: toCanonicalJson(part.invocation.arguments) } };
      });
      const text = contentText(message);
      output.push({ role: "assistant", content: text.length === 0 ? null : text, ...(calls.length === 0 ? {} : { tool_calls: calls }) });
      continue;
    }
    output.push({ role: message.role, content: contentText(message) });
  }
  return output;
}

export function requestedPolicyCapabilities(request: InferenceRequest, streaming: boolean): readonly ("streaming" | "structured-output" | "tool-calling" | "network-access")[] {
  return Object.freeze([
    "network-access" as const,
    ...(streaming ? ["streaming" as const] : []),
    ...(request.structuredOutput === null ? [] : ["structured-output" as const]),
    ...(request.tools.length === 0 ? [] : ["tool-calling" as const]),
  ]);
}

export function preflightCompatibleRequest(request: InferenceRequest, input: { readonly modelId: string; readonly maxOutputTokens: number; readonly profile: OpenAiCompatibleProfile }): void {
  if (request.modelId !== input.modelId) throw new ProviderError("MODEL_UNAVAILABLE", "The request model does not match this explicit provider instance.", { requestedModelId: request.modelId, configuredModelId: input.modelId });
  if (request.extensions.length !== 0) throw new ProviderError("UNSUPPORTED_CAPABILITY", "Provider extensions are not supported by this finite profile.", {});
  if (request.maxOutputTokens !== null && request.maxOutputTokens > input.maxOutputTokens) throw new ProviderError("CONTEXT_LIMIT_EXCEEDED", "maxOutputTokens exceeds the curated model limit.", { maximum: input.maxOutputTokens });
  if (request.sampling?.seed !== null && request.sampling !== null && !input.profile.supportsSeed) throw new ProviderError("UNSUPPORTED_CAPABILITY", "The selected profile does not support deterministic seed.", {});
  if (request.structuredOutput?.strict === true && !input.profile.supportsStrictStructuredOutput) throw new ProviderError("UNSUPPORTED_CAPABILITY", "Strict structured output is unavailable for this profile.", {});
  for (const tool of request.tools) if (tool.executionLocation !== "caller") throw new ProviderError("UNSUPPORTED_CAPABILITY", "Only caller-executed function tools are supported.", { toolName: tool.name });
  for (const message of request.messages) for (const part of message.parts) if (part.type === "artifact" || part.type === "image-artifact") throw new ProviderError("UNSUPPORTED_CAPABILITY", "The selected model profile is text-only.", { partType: part.type });
}

export function buildChatCompletionsBody(request: InferenceRequest, profile: OpenAiCompatibleProfile, streaming: boolean, upstreamModelId: string = request.modelId): JsonValue {
  const choice = toolChoice(request.toolChoice);
  return {
    model: upstreamModelId,
    messages: wireMessages(request.messages),
    stream: streaming,
    ...(streaming ? { stream_options: { include_usage: true } } : {}),
    ...(request.tools.length === 0 ? {} : { tools: tools(request.tools) }),
    ...(choice === undefined ? {} : { tool_choice: choice }),
    ...(request.structuredOutput === null ? {} : { response_format: { type: "json_schema", json_schema: { name: "structured_output", strict: request.structuredOutput.strict, schema: request.structuredOutput.schema } } }),
    ...(request.sampling?.temperature === null || request.sampling === null ? {} : { temperature: request.sampling.temperature }),
    ...(request.sampling?.topP === null || request.sampling === null ? {} : { top_p: request.sampling.topP }),
    ...(request.sampling?.seed === null || request.sampling === null ? {} : { seed: request.sampling.seed }),
    ...(request.maxOutputTokens === null ? {} : { max_completion_tokens: request.maxOutputTokens }),
    ...(request.stopSequences.length === 0 ? {} : { stop: request.stopSequences }),
    ...(profile.requestPolicy === "openrouter-no-fallback" ? { provider: { allow_fallbacks: false, require_parameters: true, data_collection: "deny" } } : {}),
  };
}
