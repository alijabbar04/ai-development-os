import { parseJsonText, parseModelId, parseProviderId, toCanonicalJson, type JsonValue } from "@ai-dev-os/domain";
import {
  ProviderError,
  ZERO_PROVIDER_USAGE,
  createOperationController,
  isDeadlineExpired,
  parseChatMessage,
  parseInferenceRequest,
  parseInferenceResult,
  parseModelDescriptor,
  parseProviderDescriptor,
  parseProviderHealth,
  parseToolInvocation,
  systemClock,
  toProviderError,
  type Clock,
  type InferenceEvent,
  type InferenceOperation,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
  type ModelDescriptor,
  type ProviderDescriptor,
  type ProviderOperationId,
  type ProviderUsage,
  type StartOperationOptions,
  type ToolInvocation,
} from "@ai-dev-os/providers";
import { createModelCapabilities } from "@ai-dev-os/domain";
import { parseOpenAiCompatibleConfiguration, resolveCompatibleCatalog } from "./config.js";
import { getOpenAiCompatibleProfile } from "./profiles.js";
import { buildChatCompletionsBody, preflightCompatibleRequest, requestedPolicyCapabilities } from "./request.js";
import { parseChatCompletionSse } from "./sse.js";
import { createFetchHttpTransport, readBoundedBody } from "./transport.js";
import { httpStatusError, parseChatCompletion, parseChatCompletionDelta, type WireCompletion } from "./wire.js";
import type { HttpResponse, OpenAiCompatibleProviderOptions } from "./types.js";

interface AbortFlag { readonly signal: { readonly aborted: boolean; addEventListener(type: "abort", listener: () => void, options?: { readonly once?: boolean }): void }; abort(): void }
function createAbortFlag(): AbortFlag {
  let aborted = false;
  const listeners: Array<() => void> = [];
  return { signal: { get aborted() { return aborted; }, addEventListener(_type, listener) { if (aborted) listener(); else listeners.push(listener); } }, abort() { if (aborted) return; aborted = true; for (const listener of listeners.splice(0)) listener(); } };
}

function mapDeadlineTimeout(response: HttpResponse, deadlineBound: boolean): HttpResponse {
  if (!deadlineBound) return response;
  const body = (async function* (): AsyncIterable<Uint8Array> {
    try {
      yield* response.body;
    } catch (error) {
      if (error instanceof ProviderError && error.code === "TIMEOUT") {
        throw new ProviderError("DEADLINE_EXCEEDED", "The provider operation exceeded the request deadline.", {});
      }
      throw error;
    }
  })();
  return Object.freeze({ ...response, body });
}

interface PendingCall { id: string | null; name: string | null; arguments: string; emitted: number; started: boolean }
const MAX_CHAT_COMPLETIONS_REQUEST_BYTES = 8 * 1_024 * 1_024;

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleProviderOptions): InferenceProvider {
  const configuration = parseOpenAiCompatibleConfiguration(options.configuration);
  const profile = getOpenAiCompatibleProfile(configuration.profileId);
  const catalog = resolveCompatibleCatalog(configuration);
  const transport = options.transport ?? createFetchHttpTransport();
  const clock: Clock = options.clock ?? systemClock;
  let counter = 0;
  const ids = options.ids ?? ((kind: "operation" | "tool-call") => { counter += 1; return `${kind === "operation" ? "op" : "tc"}-${profile.providerId}-${counter.toString().padStart(6, "0")}`; });
  let closed = false;
  const activeCancels = new Set<() => Promise<void>>();
  const pumps = new Set<Promise<void>>();

  const cap = (id: string): boolean => catalog.model.capabilities.some((claim) => claim.id === id && claim.status === "supported");
  const model = createModelCapabilities({
    providerId: parseProviderId(profile.providerId), modelId: parseModelId(configuration.modelId), contextWindowTokens: catalog.model.limits.contextTokens!, maxOutputTokens: catalog.model.limits.maxOutputTokens!,
    supportsToolUse: cap("tools"), supportsStructuredOutput: cap("structured-output"), supportsVision: false, locality: "cloud", latencyClass: "standard", codingCapability: 1, reasoningCapability: cap("reasoning") ? 2 : 1, cost: null,
  });
  const modelDescriptor: ModelDescriptor = parseModelDescriptor({ model, availability: "available" });
  const conservativeRetention = profile.providerId !== "cerebras";
  const conservativeTraining = profile.providerId !== "groq";
  const descriptor: ProviderDescriptor = parseProviderDescriptor({
    schemaVersion: 1, providerId: profile.providerId, instanceId: configuration.instanceId, kind: "inference", displayName: profile.displayName,
    locality: "cloud", retainsData: conservativeRetention, trainsOnInputs: conservativeTraining, supportedClassifications: configuration.supportedClassifications,
    capabilities: { streaming: true, structuredOutput: model.supportsStructuredOutput, toolCalling: model.supportsToolUse, imageInput: false, repositoryEditing: false, commandExecution: false, networkAccess: true, resumability: false, cancellation: "best-effort", deadlineEnforcement: true, usageReporting: true, pricingAvailable: false },
  });

  function resultOf(request: InferenceRequest, operationId: ProviderOperationId, completion: WireCompletion, started: number): InferenceResult {
    let structuredOutput: JsonValue | null = null;
    if (request.structuredOutput !== null) {
      try { structuredOutput = parseJsonText(completion.text, "structuredOutput"); } catch { throw new ProviderError("MALFORMED_RESPONSE", "Structured output was not valid bounded JSON.", {}); }
    }
    const parts: Array<Record<string, unknown>> = [];
    if (completion.text.length > 0 || completion.invocations.length === 0) parts.push({ type: "text", text: completion.text });
    for (const invocation of completion.invocations) parts.push({ type: "tool-invocation", invocation });
    const message = parseChatMessage({ role: "assistant", parts });
    return parseInferenceResult({
      schemaVersion: 1, operationId, requestId: request.requestId, modelId: request.modelId, messages: [message], structuredOutput,
      finishReason: completion.finishReason, refusalMessage: completion.finishReason === "content-filter" ? "The provider filtered the response." : null,
      usage: completion.usage, cost: { providerReported: null, locallyComputed: null }, latency: { firstEventMs: 0, totalMs: Math.max(0, clock.now().valueOf() - started) }, warnings: [],
    });
  }

  async function obtainResponse(request: InferenceRequest, operationId: ProviderOperationId, signal: AbortFlag["signal"]): Promise<HttpResponse> {
    const streaming = configuration.streaming === "always";
    const capabilities = requestedPolicyCapabilities(request, streaming);
    const body = JSON.stringify(buildChatCompletionsBody(request, profile, streaming, configuration.catalogModelId));
    if (Buffer.byteLength(body, "utf8") > MAX_CHAT_COMPLETIONS_REQUEST_BYTES) throw new ProviderError("INVALID_REQUEST", "The Chat Completions request exceeded the adapter's serialized byte bound.", { maximum: MAX_CHAT_COMPLETIONS_REQUEST_BYTES });
    return options.access.withAuthorizedApiKey({ descriptor, model, request, operationId, requestedCapabilities: capabilities, signal }, async (apiKey) => {
      if (apiKey.length === 0 || apiKey.length > 8_192 || /[\r\n]/u.test(apiKey)) throw new ProviderError("AUTHENTICATION_FAILED", "The provider API key is invalid.", {});
      let timeoutMs = configuration.limits.requestTimeoutMs; let deadlineBound = false;
      if (request.deadline !== null) { const remaining = Date.parse(request.deadline) - clock.now().valueOf(); if (remaining <= 0) throw new ProviderError("DEADLINE_EXCEEDED", "The request deadline expired before provider transport.", {}); if (remaining <= timeoutMs) { timeoutMs = Math.max(1, remaining); deadlineBound = true; } }
      try {
        const response = await transport.send({
          url: `${profile.origin}${profile.path}`, method: "POST", headers: Object.freeze({ "Content-Type": "application/json", Accept: streaming ? "text/event-stream" : "application/json", Authorization: `Bearer ${apiKey}`, ...profile.fixedHeaders }),
          body, redirect: "reject", timeoutMs,
          maxResponseBytes: streaming ? configuration.limits.maxStreamBytes : configuration.limits.maxResponseBytes, signal,
        });
        return mapDeadlineTimeout(response, deadlineBound);
      } catch (error) {
        if (deadlineBound && error instanceof ProviderError && error.code === "TIMEOUT") throw new ProviderError("DEADLINE_EXCEEDED", "The provider operation exceeded the request deadline.", {});
        throw error;
      }
    });
  }

  async function pump(request: InferenceRequest, controller: ReturnType<typeof createOperationController<InferenceEvent, InferenceResult>>, abort: AbortFlag, started: number): Promise<void> {
    const emit = (build: Parameters<typeof controller.emit>[0]): void => { if (!controller.isTerminal) controller.emit(build); };
    try {
      if (controller.isTerminal || abort.signal.aborted) return;
      emit((base) => ({ ...base, kind: "operation-started", payload: { modelId: request.modelId } }));
      emit((base) => ({ ...base, kind: "message-started", payload: { messageIndex: 0 } }));
      emit((base) => ({ ...base, kind: "usage-update", payload: { usage: ZERO_PROVIDER_USAGE } }));
      if (isDeadlineExpired(request.deadline, clock.now())) throw new ProviderError("DEADLINE_EXCEEDED", "The request deadline expired before provider access.", {});
      const response = await obtainResponse(request, controller.operation.operationId, abort.signal);
      if (response.status < 200 || response.status >= 300) { await readBoundedBody(response.body, Math.min(configuration.limits.maxResponseBytes, 64 * 1_024)).catch(() => undefined); throw httpStatusError(response.status, response.headers); }
      let completion: WireCompletion;
      if (configuration.streaming === "never") {
        const text = await readBoundedBody(response.body, configuration.limits.maxResponseBytes);
        let json: JsonValue;
        try { json = parseJsonText(text, "completion"); } catch { throw new ProviderError("MALFORMED_RESPONSE", "The provider response was not valid bounded JSON.", {}); }
        completion = parseChatCompletion(json, configuration.catalogModelId, configuration.limits.maxToolArgumentsBytes);
        if (request.structuredOutput !== null) emit((base) => ({ ...base, kind: "structured-output-delta", payload: { textDelta: completion.text } }));
        else if (completion.text.length > 0) emit((base) => ({ ...base, kind: "text-delta", payload: { text: completion.text } }));
        if (completion.reasoning.length > 0) emit((base) => ({ ...base, kind: "reasoning-delta", payload: { text: completion.reasoning } }));
        for (const invocation of completion.invocations) {
          emit((base) => ({ ...base, kind: "tool-call-started", payload: { toolCallId: invocation.toolCallId, toolName: invocation.toolName } }));
          emit((base) => ({ ...base, kind: "tool-call-delta", payload: { toolCallId: invocation.toolCallId, argumentsDelta: toCanonicalJson(invocation.arguments) } }));
          emit((base) => ({ ...base, kind: "tool-call-completed", payload: { invocation } }));
        }
      } else {
        let text = "";
        let reasoning = "";
        let finishReason: WireCompletion["finishReason"] | null = null;
        let finalUsage: ProviderUsage | null = null;
        let sawExpectedModel = false;
        const calls = new Map<number, PendingCall>();
        for await (const raw of parseChatCompletionSse(response.body, { maxStreamBytes: configuration.limits.maxStreamBytes, maxEventBytes: configuration.limits.maxSseEventBytes })) {
          const delta = parseChatCompletionDelta(raw, configuration.limits.maxToolArgumentsBytes);
          if (delta.model !== null && delta.model !== configuration.catalogModelId) throw new ProviderError("PROTOCOL_VIOLATION", "A stream chunk reported a different model.", { expectedModel: configuration.catalogModelId, returnedModel: delta.model });
          if (delta.model === configuration.catalogModelId) sawExpectedModel = true;
          const terminalSeen = finishReason !== null;
          const hasPayload = delta.text.length > 0 || delta.reasoning.length > 0 || delta.toolCalls.length > 0;
          if (terminalSeen && (hasPayload || delta.finishReason !== null || delta.usage === null)) throw new ProviderError("PROTOCOL_VIOLATION", "The stream continued after its terminal finish; only one trailing usage chunk is allowed.", {});
          if (delta.usage !== null) {
            if (finalUsage !== null) throw new ProviderError("PROTOCOL_VIOLATION", "The stream reported terminal usage more than once.", {});
            if (!terminalSeen && delta.finishReason === null) throw new ProviderError("PROTOCOL_VIOLATION", "The stream reported terminal usage before its finish reason.", {});
          }
          if (delta.text.length > 0) { text += delta.text; if (text.length > 262_144) throw new ProviderError("MALFORMED_RESPONSE", "Streamed text exceeded the result bound.", {}); emit(request.structuredOutput === null ? (base) => ({ ...base, kind: "text-delta", payload: { text: delta.text } }) : (base) => ({ ...base, kind: "structured-output-delta", payload: { textDelta: delta.text } })); }
          if (delta.reasoning.length > 0) { reasoning += delta.reasoning; if (reasoning.length > 262_144) throw new ProviderError("MALFORMED_RESPONSE", "Streamed reasoning exceeded the result bound.", {}); emit((base) => ({ ...base, kind: "reasoning-delta", payload: { text: delta.reasoning } })); }
          for (const fragment of delta.toolCalls) {
            const pending = calls.get(fragment.index) ?? { id: null, name: null, arguments: "", emitted: 0, started: false };
            if (fragment.id !== null) { if (pending.id !== null && pending.id !== fragment.id) throw new ProviderError("TOOL_PROTOCOL_FAILURE", "A streamed tool call changed its ID.", {}); pending.id = fragment.id; }
            if (fragment.name !== null) { if (pending.name !== null && pending.name !== fragment.name) throw new ProviderError("TOOL_PROTOCOL_FAILURE", "A streamed tool call changed its name.", {}); pending.name = fragment.name; }
            pending.arguments += fragment.argumentsDelta;
            if (Buffer.byteLength(pending.arguments, "utf8") > configuration.limits.maxToolArgumentsBytes) throw new ProviderError("TOOL_PROTOCOL_FAILURE", "Streamed tool arguments exceeded the configured bound.", {});
            if (!pending.started && pending.id !== null && pending.name !== null) { pending.started = true; emit((base) => ({ ...base, kind: "tool-call-started", payload: { toolCallId: pending.id!, toolName: pending.name! } })); }
            if (pending.started && pending.arguments.length > pending.emitted) { const addition = pending.arguments.slice(pending.emitted); pending.emitted = pending.arguments.length; emit((base) => ({ ...base, kind: "tool-call-delta", payload: { toolCallId: pending.id!, argumentsDelta: addition } })); }
            calls.set(fragment.index, pending);
          }
          if (delta.finishReason !== null) { if (finishReason !== null) throw new ProviderError("PROTOCOL_VIOLATION", "The stream produced more than one terminal finish reason.", {}); finishReason = delta.finishReason; }
          if (delta.usage !== null) { finalUsage = delta.usage; emit((base) => ({ ...base, kind: "usage-update", payload: { usage: delta.usage! } })); }
        }
        if (!sawExpectedModel || finishReason === null || finalUsage === null) throw new ProviderError("PROTOCOL_VIOLATION", "The stream omitted exact model identity, terminal finish, or usage data.", {});
        const invocations: ToolInvocation[] = [];
        const invocationIds = new Set<string>();
        for (const pending of [...calls.entries()].sort(([a], [b]) => a - b).map(([, item]) => item)) {
          if (pending.id === null || pending.name === null || !pending.started) throw new ProviderError("TOOL_PROTOCOL_FAILURE", "A streamed tool call was incomplete.", {});
          let args: JsonValue;
          try { args = parseJsonText(pending.arguments, "tool.arguments"); } catch { throw new ProviderError("TOOL_PROTOCOL_FAILURE", "Streamed tool arguments were not valid bounded JSON.", { toolName: pending.name }); }
          if (invocationIds.has(pending.id)) throw new ProviderError("TOOL_PROTOCOL_FAILURE", "Streamed tool-call IDs must be unique.", {}); invocationIds.add(pending.id);
          const invocation = parseToolInvocation({ toolCallId: pending.id, toolName: pending.name, arguments: args });
          invocations.push(invocation); emit((base) => ({ ...base, kind: "tool-call-completed", payload: { invocation } }));
        }
        completion = Object.freeze({ text, reasoning, invocations: Object.freeze(invocations), finishReason, usage: Object.freeze({ ...finalUsage, toolCalls: invocations.length }), model: configuration.catalogModelId });
      }
      if (request.structuredOutput !== null) {
        let value: JsonValue;
        try { value = parseJsonText(completion.text, "structuredOutput"); } catch { throw new ProviderError("MALFORMED_RESPONSE", "Structured output was not valid bounded JSON.", {}); }
        emit((base) => ({ ...base, kind: "structured-output-completed", payload: { value } }));
      }
      emit((base) => ({ ...base, kind: "usage-update", payload: { usage: completion.usage } }));
      emit((base) => ({ ...base, kind: "message-completed", payload: { messageIndex: 0 } }));
      const result = resultOf(request, controller.operation.operationId, completion, started);
      if (!controller.isTerminal) controller.complete((base) => ({ ...base, kind: "operation-completed", payload: {} }), result);
    } catch (error) {
      const failure = toProviderError(error);
      if (!controller.isTerminal) controller.fail((base) => ({ ...base, kind: "operation-failed", payload: { code: failure.code, message: failure.message, retryStrategy: failure.retry.strategy } }), failure);
    }
  }

  const provider: InferenceProvider = Object.freeze({
    kind: "inference" as const,
    describe: () => descriptor,
    async health() { return parseProviderHealth({ status: closed ? "closed" : "ready", checkedAt: clock.now().toISOString(), detailCode: closed ? "provider-closed" : null, activeOperations: activeCancels.size }); },
    async listModels() { return Object.freeze([modelDescriptor]); },
    async start(raw: InferenceRequest, startOptions: StartOperationOptions = {}): Promise<InferenceOperation> {
      if (closed) throw new ProviderError("PROVIDER_CLOSED", "The provider is closed.", {});
      const request = parseInferenceRequest(raw);
      preflightCompatibleRequest(request, { modelId: configuration.modelId, maxOutputTokens: model.maxOutputTokens, profile });
      if (!descriptor.supportedClassifications.includes(request.disclosure.classification)) throw new ProviderError("POLICY_DENIED", "This provider instance does not permit the request classification.", { classification: request.disclosure.classification });
      if (request.disclosure.requiredLocality === "local-only") throw new ProviderError("POLICY_DENIED", "A cloud provider cannot satisfy a local-only disclosure requirement.", { requiredLocality: "local-only" });
      const operationId = ids("operation") as ProviderOperationId;
      const abort = createAbortFlag();
      const controller = createOperationController<InferenceEvent, InferenceResult>({
        operationId, clock, trace: request.trace,
        buildCancelledEvent: (base, reason) => ({ ...base, kind: "operation-cancelled", payload: { reason } }),
        onTerminal: () => abort.abort(),
      });
      controller.onCancel(() => abort.abort());
      const cancelClosed = (): Promise<void> => controller.operation.cancel("provider-closed");
      activeCancels.add(cancelClosed);
      startOptions.signal?.addEventListener("abort", () => { void controller.operation.cancel("caller-aborted"); }, { once: true });
      if (startOptions.signal?.aborted === true) void controller.operation.cancel("caller-aborted");
      const task = pump(request, controller, abort, clock.now().valueOf()).finally(() => { activeCancels.delete(cancelClosed); pumps.delete(task); });
      pumps.add(task);
      return controller.operation;
    },
    async close() { if (closed) return; closed = true; await Promise.all([...activeCancels].map((cancel) => cancel())); await Promise.all([...pumps]); },
  });
  return provider;
}
