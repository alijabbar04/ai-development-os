import { parseJsonText, toCanonicalJson, validation, type JsonValue } from "@ai-dev-os/domain";
import { ProviderError, parseProviderUsage, parseToolInvocation, type FinishReason, type ProviderUsage, type ToolInvocation } from "@ai-dev-os/providers";

const { ensureArray, ensureRecord, ensureSafeInteger, ensureString } = validation;
export interface GeminiParsed { readonly text: string; readonly reasoning: string; readonly invocations: readonly ToolInvocation[]; readonly signatures: readonly { readonly callId: string; readonly value: string }[]; readonly finishReason: FinishReason | null; readonly usage: ProviderUsage | null; readonly warning: string | null }

function usage(value: unknown): ProviderUsage | null {
  if (value === undefined || value === null) return null;
  const item = ensureRecord(value, "usageMetadata");
  const prompt = ensureSafeInteger(item["promptTokenCount"] ?? 0, "usageMetadata.promptTokenCount", 0, 1_000_000_000);
  const candidate = ensureSafeInteger(item["candidatesTokenCount"] ?? 0, "usageMetadata.candidatesTokenCount", 0, 1_000_000_000);
  const cached = ensureSafeInteger(item["cachedContentTokenCount"] ?? 0, "usageMetadata.cachedContentTokenCount", 0, prompt);
  const thoughts = ensureSafeInteger(item["thoughtsTokenCount"] ?? 0, "usageMetadata.thoughtsTokenCount", 0, candidate);
  return parseProviderUsage({ tokens: { inputTokens: prompt - cached, outputTokens: candidate - thoughts, cachedInputTokens: cached, reasoningTokens: thoughts }, toolCalls: 0 });
}

function finish(value: unknown): FinishReason | null {
  if (value === undefined || value === null || value === "FINISH_REASON_UNSPECIFIED") return null;
  if (typeof value !== "string" || value.length > 64) throw new ProviderError("MALFORMED_RESPONSE", "Gemini returned an invalid finish reason.", {});
  const map: Readonly<Record<string, FinishReason>> = { STOP: "stop", MAX_TOKENS: "length", SAFETY: "content-filter", RECITATION: "content-filter", BLOCKLIST: "content-filter", PROHIBITED_CONTENT: "content-filter", SPII: "content-filter", MALFORMED_FUNCTION_CALL: "tool-calls" };
  const mapped = map[value];
  if (mapped === undefined) throw new ProviderError("MALFORMED_RESPONSE", "Gemini returned an unknown finish reason.", { finishReason: value });
  return mapped;
}

export function parseGeminiResponse(value: JsonValue, idSource: () => string): GeminiParsed {
  try {
    const root = ensureRecord(value, "geminiResponse");
    const candidates = ensureArray(root["candidates"] ?? [], "geminiResponse.candidates", 2);
    if (candidates.length === 0) {
      const feedback = root["promptFeedback"] === undefined ? {} : ensureRecord(root["promptFeedback"], "promptFeedback");
      const reason = feedback["blockReason"];
      if (typeof reason === "string") throw new ProviderError("CONTENT_REJECTED", "Gemini blocked the prompt.", { blockReason: reason.slice(0, 64) });
      return Object.freeze({ text: "", reasoning: "", invocations: [], signatures: [], finishReason: null, usage: usage(root["usageMetadata"]), warning: null });
    }
    if (candidates.length !== 1) throw new ProviderError("MALFORMED_RESPONSE", "Exactly one Gemini candidate is supported.", { candidateCount: candidates.length });
    const candidate = ensureRecord(candidates[0], "candidates[0]");
    const content = ensureRecord(candidate["content"], "candidates[0].content");
    const parts = ensureArray(content["parts"], "candidates[0].content.parts", 128);
    let text = ""; let reasoning = ""; const invocations: ToolInvocation[] = []; const signatures: Array<{ readonly callId: string; readonly value: string }> = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = ensureRecord(parts[index], `parts[${index}]`);
      if (part["text"] !== undefined) {
        const chunk = ensureString(part["text"], `parts[${index}].text`, { minLength: 0, maxLength: 262_144 });
        if (part["thought"] === true) reasoning += chunk; else text += chunk;
      }
      if (part["functionCall"] !== undefined) {
        const call = ensureRecord(part["functionCall"], `parts[${index}].functionCall`);
        const callId = call["id"] === undefined ? idSource() : ensureString(call["id"], `parts[${index}].functionCall.id`, { maxLength: 128 });
        const invocation = parseToolInvocation({ toolCallId: callId, toolName: ensureString(call["name"], `parts[${index}].functionCall.name`, { maxLength: 64 }), arguments: call["args"] ?? {} });
        invocations.push(invocation);
        if (part["thoughtSignature"] !== undefined) signatures.push(Object.freeze({ callId, value: ensureString(part["thoughtSignature"], `parts[${index}].thoughtSignature`, { maxLength: 16_384 }) }));
      }
    }
    if (text.length > 262_144 || reasoning.length > 262_144) throw new ProviderError("MALFORMED_RESPONSE", "Gemini output exceeded the result bound.", {});
    const safety = candidate["safetyRatings"] === undefined ? [] : ensureArray(candidate["safetyRatings"], "candidate.safetyRatings", 32);
    const parsedUsage = usage(root["usageMetadata"]);
    return Object.freeze({ text, reasoning, invocations: Object.freeze(invocations), signatures: Object.freeze(signatures), finishReason: finish(candidate["finishReason"]), usage: parsedUsage === null ? null : Object.freeze({ ...parsedUsage, toolCalls: invocations.length }), warning: safety.length === 0 ? null : "Gemini returned safety-rating metadata; raw ratings are intentionally not logged." });
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("MALFORMED_RESPONSE", "Gemini returned an invalid generateContent response.", { canonicalBytes: toCanonicalJson(value).length });
  }
}

export function parseGeminiJson(text: string): JsonValue {
  try { return parseJsonText(text, "geminiResponse"); } catch { throw new ProviderError("MALFORMED_RESPONSE", "Gemini returned invalid bounded JSON.", {}); }
}

export function geminiHttpError(status: number, headers: Readonly<Record<string, string>>): ProviderError {
  const retry = headers["retry-after"]; const retryAfterMs = retry !== undefined && /^\d+$/u.test(retry) ? Math.min(Number(retry) * 1_000, 86_400_000) : null;
  const code = status === 400 ? "INVALID_REQUEST" : status === 401 ? "AUTHENTICATION_FAILED" : status === 403 ? "AUTHORIZATION_FAILED" : status === 404 ? "MODEL_UNAVAILABLE" : status === 429 ? "RATE_LIMITED" : status >= 500 ? "PROVIDER_OVERLOADED" : "NETWORK_FAILURE";
  return new ProviderError(code, "Gemini rejected the request.", { status }, { retryAfterMs });
}
