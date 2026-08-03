import { createModelCapabilities, parseModelId, parseProviderId, toCanonicalJson, type JsonValue } from "@ai-dev-os/domain";
import { BUILTIN_PROVIDER_CATALOG, resolveCatalogModel, resolveCatalogProvider } from "@ai-dev-os/provider-catalog";
import {
  ProviderError, ZERO_PROVIDER_USAGE, createOperationController, isDeadlineExpired, parseChatMessage, parseInferenceRequest, parseInferenceResult, parseModelDescriptor, parseProviderDescriptor, parseProviderHealth, systemClock, toProviderError,
  type Clock, type InferenceEvent, type InferenceOperation, type InferenceProvider, type InferenceRequest, type InferenceResult, type ProviderOperationId, type ProviderUsage, type StartOperationOptions, type ToolInvocation,
} from "@ai-dev-os/providers";
import { GEMINI_ORIGIN, parseGeminiConfiguration } from "./config.js";
import { buildGeminiBody, geminiPolicyCapabilities, preflightGeminiRequest } from "./request.js";
import { createFetchGeminiTransport, parseGeminiSse, readGeminiBody } from "./transport.js";
import { geminiHttpError, parseGeminiJson, parseGeminiResponse, type GeminiParsed } from "./wire.js";
import type { CreateGeminiProviderOptions, GeminiHttpResponse } from "./types.js";

function abortFlag() { let aborted = false; const listeners: Array<() => void> = []; return { signal: { get aborted() { return aborted; }, addEventListener(_type: "abort", listener: () => void) { if (aborted) listener(); else listeners.push(listener); } }, abort() { if (aborted) return; aborted = true; for (const listener of listeners.splice(0)) listener(); } }; }
const GEMINI_MAX_SERIALIZED_REQUEST_BYTES = 20_000_000;

function mapDeadlineTimeout(response: GeminiHttpResponse, deadlineBound: boolean): GeminiHttpResponse {
  if (!deadlineBound) return response;
  const body = (async function* (): AsyncIterable<Uint8Array> {
    try {
      yield* response.body;
    } catch (error) {
      if (error instanceof ProviderError && error.code === "TIMEOUT") {
        throw new ProviderError("DEADLINE_EXCEEDED", "The Gemini operation exceeded the request deadline.", {});
      }
      throw error;
    }
  })();
  return Object.freeze({ ...response, body });
}

export function createGeminiProvider(options: CreateGeminiProviderOptions): InferenceProvider {
  const configuration = parseGeminiConfiguration(options.configuration); const transport = options.transport ?? createFetchGeminiTransport(); const clock: Clock = options.clock ?? systemClock;
  const catalogProvider = resolveCatalogProvider(BUILTIN_PROVIDER_CATALOG, "google-gemini")!; const catalogModel = resolveCatalogModel(catalogProvider, configuration.catalogModelId)!;
  let counter = 0; const ids = options.ids ?? ((kind: "operation" | "tool-call") => { counter += 1; return `${kind === "operation" ? "op" : "tc"}-gemini-${counter.toString().padStart(6, "0")}`; });
  let closed = false; const active = new Set<() => Promise<void>>(); const pumps = new Set<Promise<void>>(); const thoughtSignatures = new Map<string, string>();
  const supported = (id: string) => catalogModel.capabilities.some((capability) => capability.id === id && capability.status === "supported");
  const model = createModelCapabilities({ providerId: parseProviderId("google-gemini"), modelId: parseModelId(configuration.modelId), contextWindowTokens: catalogModel.limits.contextTokens!, maxOutputTokens: catalogModel.limits.maxOutputTokens!, supportsToolUse: supported("tools"), supportsStructuredOutput: supported("structured-output"), supportsVision: options.artifacts !== undefined, locality: "cloud", latencyClass: "standard", codingCapability: 1, reasoningCapability: 2, cost: null });
  const descriptor = parseProviderDescriptor({ schemaVersion: 1, providerId: "google-gemini", instanceId: configuration.instanceId, kind: "inference", displayName: "Google Gemini (native generateContent)", locality: "cloud", retainsData: true, trainsOnInputs: true, supportedClassifications: configuration.supportedClassifications, capabilities: { streaming: true, structuredOutput: true, toolCalling: true, imageInput: options.artifacts !== undefined, repositoryEditing: false, commandExecution: false, networkAccess: true, resumability: false, cancellation: "best-effort", deadlineEnforcement: true, usageReporting: true, pricingAvailable: false } });
  const modelDescriptor = parseModelDescriptor({ model, availability: "available" });

  function remember(parsed: GeminiParsed): void { for (const item of parsed.signatures) { thoughtSignatures.set(item.callId, item.value); while (thoughtSignatures.size > 1_024) thoughtSignatures.delete(thoughtSignatures.keys().next().value!); } }
  function result(request: InferenceRequest, operationId: ProviderOperationId, parsed: GeminiParsed, started: number): InferenceResult {
    let structured: JsonValue | null = null; if (request.structuredOutput !== null) structured = parseGeminiJson(parsed.text);
    const parts: Array<Record<string, unknown>> = []; if (parsed.text.length > 0 || parsed.invocations.length === 0) parts.push({ type: "text", text: parsed.text }); for (const invocation of parsed.invocations) parts.push({ type: "tool-invocation", invocation });
    return parseInferenceResult({ schemaVersion: 1, operationId, requestId: request.requestId, modelId: request.modelId, messages: [parseChatMessage({ role: "assistant", parts })], structuredOutput: structured, finishReason: parsed.finishReason ?? "stop", refusalMessage: parsed.finishReason === "content-filter" ? "Gemini filtered the response." : null, usage: parsed.usage ?? ZERO_PROVIDER_USAGE, cost: { providerReported: null, locallyComputed: null }, latency: { firstEventMs: 0, totalMs: Math.max(0, clock.now().valueOf() - started) }, warnings: parsed.warning === null ? [] : [parsed.warning] });
  }

  async function pump(request: InferenceRequest, controller: ReturnType<typeof createOperationController<InferenceEvent, InferenceResult>>, abort: ReturnType<typeof abortFlag>, started: number): Promise<void> {
    const emit = (build: Parameters<typeof controller.emit>[0]) => { if (!controller.isTerminal) controller.emit(build); };
    try {
      if (controller.isTerminal || abort.signal.aborted) return;
      emit((base) => ({ ...base, kind: "operation-started", payload: { modelId: request.modelId } })); emit((base) => ({ ...base, kind: "message-started", payload: { messageIndex: 0 } })); emit((base) => ({ ...base, kind: "usage-update", payload: { usage: ZERO_PROVIDER_USAGE } }));
      if (isDeadlineExpired(request.deadline, clock.now())) throw new ProviderError("DEADLINE_EXCEEDED", "The request deadline expired before Gemini access.", {});
      const accessRequest = { descriptor, model, request, operationId: controller.operation.operationId, requestedCapabilities: geminiPolicyCapabilities(request, configuration.streaming === "always") };
      const authorization = await options.authorization.authorize(accessRequest);
      const body = JSON.stringify(await buildGeminiBody(request, configuration, options.artifacts, thoughtSignatures));
      if (Buffer.byteLength(body, "utf8") > GEMINI_MAX_SERIALIZED_REQUEST_BYTES) throw new ProviderError("INVALID_REQUEST", "The Gemini request exceeded the documented serialized inline-request boundary.", { maximum: GEMINI_MAX_SERIALIZED_REQUEST_BYTES });
      const response = await options.credentials.withApiKey({ ...accessRequest, authorization, signal: abort.signal }, async (apiKey) => {
        if (apiKey.length === 0 || apiKey.length > 8_192 || /[\r\n]/u.test(apiKey)) throw new ProviderError("AUTHENTICATION_FAILED", "The Gemini API key is invalid.", {});
        const method = configuration.streaming === "always" ? "streamGenerateContent" : "generateContent"; const query = configuration.streaming === "always" ? "?alt=sse" : "";
        let timeoutMs = configuration.limits.requestTimeoutMs; let deadlineBound = false;
        if (request.deadline !== null) { const remaining = Date.parse(request.deadline) - clock.now().valueOf(); if (remaining <= 0) throw new ProviderError("DEADLINE_EXCEEDED", "The request deadline expired before Gemini transport.", {}); if (remaining <= timeoutMs) { timeoutMs = Math.max(1, remaining); deadlineBound = true; } }
        try {
          const response = await transport.send({ url: `${GEMINI_ORIGIN}/v1beta/models/${configuration.catalogModelId}:${method}${query}`, headers: Object.freeze({ "Content-Type": "application/json", Accept: configuration.streaming === "always" ? "text/event-stream" : "application/json", "x-goog-api-key": apiKey }), body, timeoutMs, maxResponseBytes: configuration.streaming === "always" ? configuration.limits.maxStreamBytes : configuration.limits.maxResponseBytes, signal: abort.signal });
          return mapDeadlineTimeout(response, deadlineBound);
        } catch (error) {
          if (deadlineBound && error instanceof ProviderError && error.code === "TIMEOUT") throw new ProviderError("DEADLINE_EXCEEDED", "The Gemini operation exceeded the request deadline.", {});
          throw error;
        }
      });
      if (response.status < 200 || response.status >= 300) { await readGeminiBody(response.body, Math.min(configuration.limits.maxResponseBytes, 64 * 1_024)).catch(() => undefined); throw geminiHttpError(response.status, response.headers); }
      let combined: GeminiParsed;
      if (configuration.streaming === "never") {
        combined = parseGeminiResponse(parseGeminiJson(await readGeminiBody(response.body, configuration.limits.maxResponseBytes)), () => ids("tool-call"));
        if (combined.finishReason === null || combined.usage === null) throw new ProviderError("PROTOCOL_VIOLATION", "Gemini JSON response omitted terminal finish or usage metadata.", {});
      }
      else {
        let text = ""; let reasoning = ""; let finishReason: GeminiParsed["finishReason"] = null; let finalUsage: ProviderUsage | null = null; let warning: string | null = null; const invocations: ToolInvocation[] = []; const signatures: Array<{ readonly callId: string; readonly value: string }> = [];
        for await (const eventText of parseGeminiSse(response.body, { stream: configuration.limits.maxStreamBytes, event: configuration.limits.maxSseEventBytes })) {
          const event = parseGeminiResponse(parseGeminiJson(eventText), () => ids("tool-call"));
          const terminalSeen = finishReason !== null;
          const hasPayload = event.text.length > 0 || event.reasoning.length > 0 || event.invocations.length > 0 || event.signatures.length > 0 || event.warning !== null;
          if (terminalSeen && (hasPayload || event.finishReason !== null || event.usage === null)) throw new ProviderError("PROTOCOL_VIOLATION", "Gemini continued after its terminal finish; only one trailing usage event is allowed.", {});
          if (event.usage !== null) {
            if (finalUsage !== null) throw new ProviderError("PROTOCOL_VIOLATION", "Gemini reported terminal usage more than once.", {});
            if (!terminalSeen && event.finishReason === null) throw new ProviderError("PROTOCOL_VIOLATION", "Gemini reported terminal usage before its finish reason.", {});
          }
          text += event.text; reasoning += event.reasoning; for (const invocation of event.invocations) { if (invocations.some((prior) => prior.toolCallId === invocation.toolCallId)) throw new ProviderError("TOOL_PROTOCOL_FAILURE", "Gemini stream repeated a tool-call ID.", {}); invocations.push(invocation); } signatures.push(...event.signatures); if (event.finishReason !== null) { if (finishReason !== null) throw new ProviderError("PROTOCOL_VIOLATION", "Gemini stream produced duplicate terminal finish reasons.", {}); finishReason = event.finishReason; } if (event.usage !== null) finalUsage = event.usage; if (event.warning !== null) warning = event.warning;
          if (event.text.length > 0) emit(request.structuredOutput === null ? (base) => ({ ...base, kind: "text-delta", payload: { text: event.text } }) : (base) => ({ ...base, kind: "structured-output-delta", payload: { textDelta: event.text } })); if (event.reasoning.length > 0) emit((base) => ({ ...base, kind: "reasoning-delta", payload: { text: event.reasoning } }));
          for (const invocation of event.invocations) { emit((base) => ({ ...base, kind: "tool-call-started", payload: { toolCallId: invocation.toolCallId, toolName: invocation.toolName } })); emit((base) => ({ ...base, kind: "tool-call-delta", payload: { toolCallId: invocation.toolCallId, argumentsDelta: toCanonicalJson(invocation.arguments) } })); emit((base) => ({ ...base, kind: "tool-call-completed", payload: { invocation } })); }
          if (event.usage !== null) emit((base) => ({ ...base, kind: "usage-update", payload: { usage: event.usage! } }));
        }
        if (finishReason === null || finalUsage === null) throw new ProviderError("PROTOCOL_VIOLATION", "Gemini stream omitted terminal finish or usage metadata.", {});
        combined = Object.freeze({ text, reasoning, invocations: Object.freeze(invocations), signatures: Object.freeze(signatures), finishReason, usage: Object.freeze({ ...finalUsage, toolCalls: invocations.length }), warning });
      }
      remember(combined);
      if (configuration.streaming === "never") { if (combined.text.length > 0) emit(request.structuredOutput === null ? (base) => ({ ...base, kind: "text-delta", payload: { text: combined.text } }) : (base) => ({ ...base, kind: "structured-output-delta", payload: { textDelta: combined.text } })); if (combined.reasoning.length > 0) emit((base) => ({ ...base, kind: "reasoning-delta", payload: { text: combined.reasoning } })); for (const invocation of combined.invocations) { emit((base) => ({ ...base, kind: "tool-call-started", payload: { toolCallId: invocation.toolCallId, toolName: invocation.toolName } })); emit((base) => ({ ...base, kind: "tool-call-completed", payload: { invocation } })); } }
      if (request.structuredOutput !== null) emit((base) => ({ ...base, kind: "structured-output-completed", payload: { value: parseGeminiJson(combined.text) } })); if (combined.warning !== null) emit((base) => ({ ...base, kind: "warning", payload: { message: combined.warning! } })); emit((base) => ({ ...base, kind: "usage-update", payload: { usage: combined.usage ?? ZERO_PROVIDER_USAGE } })); emit((base) => ({ ...base, kind: "message-completed", payload: { messageIndex: 0 } }));
      const output = result(request, controller.operation.operationId, combined, started); if (!controller.isTerminal) controller.complete((base) => ({ ...base, kind: "operation-completed", payload: {} }), output);
    } catch (error) { const failure = toProviderError(error); if (!controller.isTerminal) controller.fail((base) => ({ ...base, kind: "operation-failed", payload: { code: failure.code, message: failure.message, retryStrategy: failure.retry.strategy } }), failure); }
  }

  return Object.freeze({ kind: "inference" as const, describe: () => descriptor, async health() { return parseProviderHealth({ status: closed ? "closed" : "ready", checkedAt: clock.now().toISOString(), detailCode: closed ? "provider-closed" : null, activeOperations: active.size }); }, async listModels() { return Object.freeze([modelDescriptor]); }, async start(raw: InferenceRequest, startOptions: StartOperationOptions = {}): Promise<InferenceOperation> {
    if (closed) throw new ProviderError("PROVIDER_CLOSED", "The Gemini provider is closed.", {}); const request = parseInferenceRequest(raw); preflightGeminiRequest(request, configuration, options.artifacts !== undefined);
    if (!descriptor.supportedClassifications.includes(request.disclosure.classification) || request.disclosure.requiredLocality === "local-only") throw new ProviderError("POLICY_DENIED", "This Gemini instance cannot accept the disclosure context.", {});
    const operationId = ids("operation") as ProviderOperationId; const abort = abortFlag(); const controller = createOperationController<InferenceEvent, InferenceResult>({ operationId, clock, trace: request.trace, buildCancelledEvent: (base, reason) => ({ ...base, kind: "operation-cancelled", payload: { reason } }), onTerminal: () => abort.abort() }); controller.onCancel(() => abort.abort());
    const closeCancel = () => controller.operation.cancel("provider-closed"); active.add(closeCancel); startOptions.signal?.addEventListener("abort", () => { void controller.operation.cancel("caller-aborted"); }, { once: true }); if (startOptions.signal?.aborted === true) void controller.operation.cancel("caller-aborted");
    const task = pump(request, controller, abort, clock.now().valueOf()).finally(() => { active.delete(closeCancel); pumps.delete(task); }); pumps.add(task); return controller.operation;
  }, async close() { if (closed) return; closed = true; await Promise.all([...active].map((cancel) => cancel())); await Promise.all([...pumps]); } });
}
