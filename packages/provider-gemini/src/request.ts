import { toCanonicalJson, type JsonValue } from "@ai-dev-os/domain";
import { ProviderError, type InferenceRequest } from "@ai-dev-os/providers";
import type { GeminiArtifactResolver, GeminiConfiguration } from "./types.js";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"]);

export function preflightGeminiRequest(request: InferenceRequest, configuration: GeminiConfiguration, hasArtifacts: boolean): void {
  if (request.modelId !== configuration.modelId) throw new ProviderError("MODEL_UNAVAILABLE", "The request model does not match this explicit Gemini instance.", { requestedModelId: request.modelId, configuredModelId: configuration.modelId });
  if (request.extensions.length !== 0) throw new ProviderError("UNSUPPORTED_CAPABILITY", "Gemini provider extensions are not supported.", {});
  if (request.maxOutputTokens !== null && request.maxOutputTokens > 65_536) throw new ProviderError("CONTEXT_LIMIT_EXCEEDED", "maxOutputTokens exceeds the curated Gemini limit.", { maximum: 65_536 });
  for (const tool of request.tools) if (tool.executionLocation !== "caller") throw new ProviderError("UNSUPPORTED_CAPABILITY", "Only caller-executed Gemini functions are supported.", { toolName: tool.name });
  for (const message of request.messages) for (const part of message.parts) {
    if (part.type === "artifact") throw new ProviderError("UNSUPPORTED_CAPABILITY", "Only image-artifact binary content is supported.", {});
    if (part.type === "image-artifact" && (!hasArtifacts || !IMAGE_TYPES.has(part.mediaType))) throw new ProviderError("UNSUPPORTED_CAPABILITY", "This inline Gemini image cannot be resolved or has an unsupported MIME type.", { mediaType: part.mediaType });
  }
}

function toolMode(request: InferenceRequest): JsonValue | undefined {
  if (request.toolChoice === null) return undefined;
  if (request.toolChoice.mode === "named") return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [request.toolChoice.toolName] } };
  return { functionCallingConfig: { mode: request.toolChoice.mode === "none" ? "NONE" : request.toolChoice.mode === "required" ? "ANY" : "AUTO" } };
}

export async function buildGeminiBody(request: InferenceRequest, configuration: GeminiConfiguration, artifacts: GeminiArtifactResolver | undefined, signatures: ReadonlyMap<string, string>): Promise<JsonValue> {
  let imageBytes = 0;
  const systemParts: JsonValue[] = [];
  const contents: JsonValue[] = [];
  for (const message of request.messages) {
    const parts: JsonValue[] = [];
    for (const part of message.parts) {
      if (part.type === "text") parts.push({ text: part.text });
      else if (part.type === "json") parts.push({ text: toCanonicalJson(part.value) });
      else if (part.type === "image-artifact") {
        if (artifacts === undefined) throw new ProviderError("UNSUPPORTED_CAPABILITY", "No Gemini artifact resolver is configured.", {});
        const resolved = await artifacts.resolve({ artifactId: part.artifactId, mediaType: part.mediaType, classification: request.disclosure.classification, maxBytes: configuration.limits.maxInlineImageBytes });
        if (resolved.mediaType !== part.mediaType || !IMAGE_TYPES.has(resolved.mediaType) || resolved.bytes.byteLength > configuration.limits.maxInlineImageBytes) throw new ProviderError("INVALID_REQUEST", "Resolved Gemini image metadata or size did not match the authorized reference.", {});
        imageBytes += resolved.bytes.byteLength; if (imageBytes > configuration.limits.maxTotalInlineImageBytes) throw new ProviderError("INVALID_REQUEST", "Inline Gemini images exceeded the aggregate byte bound.", {});
        parts.push({ inlineData: { mimeType: resolved.mediaType, data: Buffer.from(resolved.bytes).toString("base64") } });
      } else if (part.type === "tool-invocation") {
        const signature = signatures.get(part.invocation.toolCallId);
        parts.push({ functionCall: { id: part.invocation.toolCallId, name: part.invocation.toolName, args: part.invocation.arguments }, ...(signature === undefined ? {} : { thoughtSignature: signature }) });
      } else if (part.type === "tool-result") {
        parts.push({ functionResponse: { id: part.result.toolCallId, name: part.result.toolName, response: part.result.status === "succeeded" ? { output: part.result.output } : { error: part.result.failure === null ? null : { code: part.result.failure.code, message: part.result.failure.message } } } });
      }
    }
    if (message.role === "system" || message.role === "developer") systemParts.push(...parts);
    else contents.push({ role: message.role === "assistant" ? "model" : "user", parts });
  }
  const toolConfig = toolMode(request);
  const generationConfig: Record<string, JsonValue> = {};
  if (request.sampling?.temperature !== null && request.sampling !== null) generationConfig["temperature"] = request.sampling.temperature;
  if (request.sampling?.topP !== null && request.sampling !== null) generationConfig["topP"] = request.sampling.topP;
  if (request.maxOutputTokens !== null) generationConfig["maxOutputTokens"] = request.maxOutputTokens;
  if (request.stopSequences.length > 0) generationConfig["stopSequences"] = request.stopSequences;
  if (request.structuredOutput !== null) { generationConfig["responseMimeType"] = "application/json"; generationConfig["responseJsonSchema"] = request.structuredOutput.schema; }
  const safetySettings = configuration.safetyMode === "provider-default" ? undefined : ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"].map((category) => ({ category, threshold: "BLOCK_MEDIUM_AND_ABOVE" }));
  return { contents, ...(systemParts.length === 0 ? {} : { systemInstruction: { parts: systemParts } }), ...(request.tools.length === 0 ? {} : { tools: [{ functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.inputSchema })) }] }), ...(toolConfig === undefined ? {} : { toolConfig }), ...(Object.keys(generationConfig).length === 0 ? {} : { generationConfig }), ...(safetySettings === undefined ? {} : { safetySettings }) };
}

export function geminiPolicyCapabilities(request: InferenceRequest, streaming: boolean): readonly ("network-access" | "streaming" | "structured-output" | "tool-calling" | "image-input")[] {
  const image = request.messages.some((message) => message.parts.some((part) => part.type === "image-artifact"));
  return Object.freeze(["network-access", ...(streaming ? ["streaming" as const] : []), ...(request.structuredOutput === null ? [] : ["structured-output" as const]), ...(request.tools.length === 0 ? [] : ["tool-calling" as const]), ...(image ? ["image-input" as const] : [])]);
}
