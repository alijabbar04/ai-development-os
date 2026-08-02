import {
  ValidationError,
  parseJsonText,
  toCanonicalJson,
  type JsonValue,
} from "@ai-dev-os/domain";
import {
  ProviderError,
  UNKNOWN_COST,
  createOperationController,
  createRetryDisposition,
  isDeadlineExpired,
  parseChatMessage,
  parseInferenceRequest,
  parseProviderDescriptor,
  parseProviderHealth,
  parseToolInvocation,
  toProviderError,
  type AbortSignalLike,
  type ChatMessage,
  type Clock,
  type ContentPart,
  type FinishReason,
  type InferenceEvent,
  type InferenceOperation,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
  type ModelDescriptor,
  type ProviderDescriptor,
  type ProviderHealth,
  type ProviderObserver,
  type ProviderOperationId,
  type ProviderUsage,
  type StartOperationOptions,
  type ToolInvocation,
} from "@ai-dev-os/providers";
import type { OllamaAdapterConfiguration } from "./config.js";
import { OLLAMA_EXTENSION_NAMESPACE } from "./config.js";
import {
  capacityManagerFromConfiguration,
  keepAliveWireValue,
  planOllamaResidency,
  type OllamaCapacityLease,
  type OllamaCapacityManager,
  type OllamaCapacitySnapshot,
  type OllamaResidencyPlan,
} from "./capacity.js";
import {
  discoverOllamaCatalog,
  findCatalogEntry,
  ollamaModelNamesEqual,
  type OllamaCatalogEntry,
  type OllamaModelCatalog,
} from "./catalog.js";
import { toStage2ModelCapabilities } from "./capabilities.js";
import {
  digestMismatchError,
  httpStatusError,
  malformedResponseError,
  modelMissingError,
  providerClosedError,
} from "./errors.js";
import { createNdjsonParser } from "./ndjson.js";
import { nanosToMillis, type OllamaObserver } from "./observability.js";
import { systemOllamaScheduler, type OllamaScheduler } from "./scheduler.js";
import { createFetchOllamaTransport, type OllamaStreamResponse, type OllamaTransport } from "./transport.js";
import {
  isOllamaErrorRecord,
  parseOllamaChatRecord,
  parseOllamaPsResponse,
  parseOllamaVersionResponse,
  type OllamaWireChatRecord,
  type OllamaWireRunningModel,
} from "./wire.js";
import { selectOllamaModel, type OllamaSelectionQuery, type OllamaSelectionResult } from "./selection.js";

export const OLLAMA_PROVIDER_ID = "ollama";

const MAX_EVENT_TEXT_CHUNK = 16_384;
const MAX_RESULT_TEXT_PART = 262_144;
const MAX_RESULT_TEXT_PARTS = 32;
const MAX_STRUCTURED_RESULT_TEXT = 262_144;

export type OllamaHealthCategory =
  | "healthy"
  | "degraded"
  | "overloaded"
  | "unavailable"
  | "incompatible"
  | "closed";

export interface OllamaHealthSnapshot {
  readonly category: OllamaHealthCategory;
  readonly checkedAt: string;
  readonly endpointFamily: "ipv4-loopback" | "ipv6-loopback";
  readonly serverReachable: boolean;
  readonly apiCompatible: boolean;
  readonly serverVersion: string | null;
  readonly installedModelCount: number | null;
  readonly eligibleModelCount: number | null;
  readonly runningModelCount: number | null;
  readonly digestMismatchCount: number | null;
  readonly capacityUtilization: "idle" | "active" | "saturated";
  readonly catalogObservedAt: string | null;
}

/** Public Ollama provider surface: the inference port plus local extras. */
export interface OllamaInferenceProvider extends InferenceProvider {
  refreshCatalog(): Promise<OllamaModelCatalog>;
  catalogSnapshot(): OllamaModelCatalog | null;
  runningModels(): Promise<readonly OllamaWireRunningModel[]>;
  inspectHealth(): Promise<OllamaHealthSnapshot>;
  selectModel(query: OllamaSelectionQuery): Promise<OllamaSelectionResult>;
  capacitySnapshot(): OllamaCapacitySnapshot;
  /** Models this instance loaded or preloaded (unload ownership scope). */
  ownedModels(): readonly string[];
  preloadModel(modelName: string): Promise<void>;
  planResidency(): Promise<OllamaResidencyPlan>;
  applyResidencyPlan(plan: OllamaResidencyPlan): Promise<void>;
}

export interface CreateOllamaProviderOptions {
  readonly configuration: OllamaAdapterConfiguration;
  readonly transport?: OllamaTransport;
  readonly scheduler?: OllamaScheduler;
  readonly observer?: ProviderObserver;
  readonly ollamaObserver?: OllamaObserver;
}

interface RequestAdapterOptions {
  readonly think: boolean | "low" | "medium" | "high" | "max" | null;
  readonly discloseReasoning: boolean;
}

interface AbortFlag {
  readonly signal: AbortSignalLike;
  abort(): void;
}

function createAbortFlag(): AbortFlag {
  let aborted = false;
  const listeners: Array<() => void> = [];
  return {
    signal: {
      get aborted(): boolean {
        return aborted;
      },
      addEventListener(_type: "abort", listener: () => void): void {
        if (aborted) {
          listener();
          return;
        }
        listeners.push(listener);
      },
    },
    abort(): void {
      if (aborted) {
        return;
      }
      aborted = true;
      for (const listener of listeners.splice(0, listeners.length)) {
        listener();
      }
    },
  };
}

function chunkText(text: string, chunkSize: number): readonly string[] {
  if (text.length <= chunkSize) {
    return [text];
  }
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize));
  }
  return chunks;
}

function parseAdapterExtensions(request: InferenceRequest): RequestAdapterOptions {
  let think: RequestAdapterOptions["think"] = null;
  let discloseReasoning = true;
  for (const extension of request.extensions) {
    if (extension.namespace !== OLLAMA_EXTENSION_NAMESPACE) {
      throw new ProviderError("UNSUPPORTED_CAPABILITY", "Unknown extension namespace.", {
        namespace: extension.namespace,
      });
    }
    if (extension.key === "think") {
      const value = extension.value;
      if (value === true || value === false) {
        think = value;
      } else if (value === "low" || value === "medium" || value === "high" || value === "max") {
        think = value;
      } else {
        throw new ProviderError("INVALID_REQUEST", "The think extension value is invalid.", {});
      }
    } else if (extension.key === "disclose-reasoning") {
      if (typeof extension.value !== "boolean") {
        throw new ProviderError("INVALID_REQUEST", "The disclose-reasoning extension value is invalid.", {});
      }
      discloseReasoning = extension.value;
    } else {
      throw new ProviderError("UNSUPPORTED_CAPABILITY", "Unknown ollama extension key.", {
        key: extension.key,
      });
    }
  }
  return Object.freeze({ think, discloseReasoning });
}

function renderParts(parts: readonly ContentPart[], role: string): string {
  const rendered: string[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      rendered.push(part.text);
    } else if (part.type === "json") {
      rendered.push(toCanonicalJson(part.value));
    } else if (part.type === "tool-invocation" || part.type === "tool-result") {
      // Handled by the caller; not part of plain content.
      continue;
    } else {
      throw new ProviderError(
        "UNSUPPORTED_CAPABILITY",
        "Artifact content parts require an artifact resolver, which Stage 7 does not provide.",
        { partType: part.type, role },
      );
    }
  }
  return rendered.join("\n\n");
}

function toWireMessages(request: InferenceRequest): JsonValue {
  const wire: Array<Record<string, unknown>> = [];
  for (const message of request.messages) {
    if (message.role === "system" || message.role === "developer") {
      // The developer role maps to the documented system role.
      wire.push({ role: "system", content: renderParts(message.parts, message.role) });
      continue;
    }
    if (message.role === "user") {
      wire.push({ role: "user", content: renderParts(message.parts, message.role) });
      continue;
    }
    if (message.role === "assistant") {
      const toolCalls = message.parts
        .filter((part): part is Extract<ContentPart, { type: "tool-invocation" }> => part.type === "tool-invocation")
        .map((part) => ({
          function: {
            name: part.invocation.toolName as string,
            arguments: part.invocation.arguments,
          },
        }));
      const entry: Record<string, unknown> = {
        role: "assistant",
        content: renderParts(message.parts, message.role),
      };
      if (toolCalls.length > 0) {
        entry["tool_calls"] = toolCalls;
      }
      wire.push(entry);
      continue;
    }
    // Tool messages: one wire message per tool result.
    for (const part of message.parts) {
      if (part.type !== "tool-result") {
        throw new ProviderError("INVALID_REQUEST", "Tool messages may only carry tool results.", {});
      }
      wire.push({
        role: "tool",
        tool_name: part.result.toolName as string,
        content:
          part.result.status === "succeeded"
            ? toCanonicalJson(part.result.output)
            : toCanonicalJson({ error: part.result.failure }),
      });
    }
  }
  return wire as unknown as JsonValue;
}

function toWireChatRequest(
  request: InferenceRequest,
  entryName: string,
  adapterOptions: RequestAdapterOptions,
  keepAlive: number | string,
): JsonValue {
  const body: Record<string, unknown> = {
    model: entryName,
    messages: toWireMessages(request),
    stream: true,
    keep_alive: keepAlive,
  };
  const options: Record<string, unknown> = {};
  if (request.sampling !== null) {
    if (request.sampling.temperature !== null) {
      options["temperature"] = request.sampling.temperature;
    }
    if (request.sampling.topP !== null) {
      options["top_p"] = request.sampling.topP;
    }
    if (request.sampling.seed !== null) {
      options["seed"] = request.sampling.seed;
    }
  }
  if (request.maxOutputTokens !== null) {
    options["num_predict"] = request.maxOutputTokens;
  }
  if (request.stopSequences.length > 0) {
    options["stop"] = [...request.stopSequences];
  }
  if (Object.keys(options).length > 0) {
    body["options"] = options;
  }
  if (request.structuredOutput !== null) {
    body["format"] = request.structuredOutput.schema;
  }
  const includeTools = request.tools.length > 0 && request.toolChoice?.mode !== "none";
  if (includeTools) {
    body["tools"] = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name as string,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }
  if (adapterOptions.think !== null) {
    body["think"] = adapterOptions.think;
  }
  return body as unknown as JsonValue;
}

export function createOllamaProvider(options: CreateOllamaProviderOptions): OllamaInferenceProvider {
  const configuration = options.configuration;
  const scheduler = options.scheduler ?? systemOllamaScheduler;
  const clock: Clock = Object.freeze({ now: (): Date => scheduler.now() });
  const transport =
    options.transport ??
    createFetchOllamaTransport({ endpoint: configuration.endpoint, scheduler });
  const capacity: OllamaCapacityManager = capacityManagerFromConfiguration(configuration, scheduler);
  const observer = options.observer;
  const ollamaObserver = options.ollamaObserver;

  let closed = false;
  let catalog: OllamaModelCatalog | null = null;
  let discovery: Promise<OllamaModelCatalog> | null = null;
  const ownership = new Set<string>();
  const activeCancels = new Set<(reason: "provider-closed") => Promise<void>>();
  const pumps = new Set<Promise<void>>();
  let operationCounter = 0;

  const descriptor: ProviderDescriptor = parseProviderDescriptor({
    schemaVersion: 1,
    providerId: OLLAMA_PROVIDER_ID,
    instanceId: configuration.instanceId,
    kind: "inference",
    displayName: "Ollama (native, loopback-only)",
    locality: "local",
    retainsData: false,
    trainsOnInputs: false,
    supportedClassifications: configuration.supportedClassifications,
    capabilities: {
      streaming: true,
      structuredOutput: true,
      toolCalling: true,
      imageInput: false,
      repositoryEditing: false,
      commandExecution: false,
      networkAccess: false,
      resumability: false,
      cancellation: "best-effort",
      deadlineEnforcement: true,
      usageReporting: true,
      pricingAvailable: false,
    },
  });

  async function ensureCatalog(): Promise<OllamaModelCatalog> {
    if (catalog !== null) {
      return catalog;
    }
    if (discovery === null) {
      discovery = discoverOllamaCatalog({
        transport,
        configuration,
        now: () => scheduler.now(),
      })
        .then((discovered) => {
          catalog = discovered;
          ollamaObserver?.({
            kind: "discovery",
            installedModelCount: discovered.entries.length,
            eligibleModelCount: discovered.entries.filter((entry) => entry.eligible).length,
            runningModelCount: discovered.entries.filter((entry) => entry.running).length,
            skippedInvalidEntries: discovered.skippedInvalidEntries,
            digestMismatchCount: discovered.entries.filter((entry) => entry.pin === "mismatched").length,
            catalogFingerprint: discovered.fingerprint,
          });
          return discovered;
        })
        .finally(() => {
          discovery = null;
        });
    }
    return discovery;
  }

  function requireEligibleEntry(requestedModelId: string): OllamaCatalogEntry {
    if (catalog === null) {
      throw new ProviderError("INTERNAL_FAILURE", "The model catalog is unavailable.", {});
    }
    const entry = findCatalogEntry(catalog, requestedModelId);
    if (entry === null) {
      throw modelMissingError(requestedModelId);
    }
    if (entry.ineligibilityReasons.includes("digest-mismatch")) {
      throw digestMismatchError(entry.name);
    }
    if (
      entry.ineligibilityReasons.includes("model-denied") ||
      entry.ineligibilityReasons.includes("not-allowlisted")
    ) {
      throw new ProviderError(
        "POLICY_DENIED",
        "The configuration does not allow this model.",
        { modelName: entry.name, detailCode: entry.ineligibilityReasons[0]! },
        { retry: createRetryDisposition({ strategy: "human-action" }) },
      );
    }
    if (!entry.eligible) {
      throw new ProviderError(
        "MODEL_UNAVAILABLE",
        "The installed model is not eligible for use.",
        { modelName: entry.name, detailCode: entry.ineligibilityReasons[0] ?? "ineligible" },
        { retry: createRetryDisposition({ strategy: "alternate-model", requestReusable: true }) },
      );
    }
    return entry;
  }

  function validateRequestAgainstEntry(
    request: InferenceRequest,
    entry: OllamaCatalogEntry,
    adapterOptions: RequestAdapterOptions,
  ): void {
    if (!descriptor.supportedClassifications.includes(request.disclosure.classification)) {
      throw new ProviderError(
        "POLICY_DENIED",
        "The provider does not accept this data classification.",
        { classification: request.disclosure.classification },
      );
    }
    const hasArtifactParts = request.messages.some((message) =>
      message.parts.some((part) => part.type === "artifact" || part.type === "image-artifact"),
    );
    if (hasArtifactParts) {
      throw new ProviderError(
        "UNSUPPORTED_CAPABILITY",
        "Artifact content parts require an artifact resolver, which Stage 7 does not provide.",
        {},
      );
    }
    if (request.tools.length > 0 && request.toolChoice?.mode !== "none" && !entry.capabilities.toolCalling) {
      throw new ProviderError("UNSUPPORTED_CAPABILITY", "The selected model does not support tool calling.", {
        modelName: entry.name,
      });
    }
    if (request.toolChoice !== null && (request.toolChoice.mode === "required" || request.toolChoice.mode === "named")) {
      throw new ProviderError(
        "UNSUPPORTED_CAPABILITY",
        "Ollama cannot enforce required or named tool choice.",
        { mode: request.toolChoice.mode },
      );
    }
    if (request.structuredOutput !== null && !entry.capabilities.structuredOutput) {
      throw new ProviderError(
        "UNSUPPORTED_CAPABILITY",
        "The selected model does not support structured output.",
        { modelName: entry.name },
      );
    }
    if (adapterOptions.think !== null && adapterOptions.think !== false && !entry.capabilities.reasoning) {
      throw new ProviderError("UNSUPPORTED_CAPABILITY", "The selected model does not support thinking.", {
        modelName: entry.name,
      });
    }
  }

  interface PumpContext {
    readonly request: InferenceRequest;
    readonly entry: OllamaCatalogEntry;
    readonly adapterOptions: RequestAdapterOptions;
    readonly controller: ReturnType<typeof createOperationController<InferenceEvent, InferenceResult>>;
    readonly stream: { chunks(): AsyncIterable<Uint8Array>; abort(): void };
    readonly abortFlag: AbortFlag;
  }

  async function pump(context: PumpContext): Promise<void> {
    const { request, entry, adapterOptions, controller, stream } = context;
    const startedAtMs = scheduler.now().valueOf();
    let firstEventMs: number | null = null;
    const structuredMode = request.structuredOutput !== null;
    const textPieces: string[] = [];
    let structuredText = "";
    const toolParts: ContentPart[] = [];
    let toolCallCounter = 0;
    let usage: ProviderUsage = {
      tokens: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
      toolCalls: 0,
    };
    const warnings: string[] = [];
    let doneRecord: OllamaWireChatRecord | null = null;

    const declaredToolNames = new Set(request.tools.map((tool) => tool.name as string));

    const emit = (build: Parameters<(typeof controller)["emit"]>[0]): void => {
      if (firstEventMs === null) {
        firstEventMs = scheduler.now().valueOf() - startedAtMs;
      }
      controller.emit(build);
    };

    const failOperation = (error: ProviderError): void => {
      if (controller.isTerminal) {
        return;
      }
      controller.fail(
        (base) => ({
          ...base,
          kind: "operation-failed",
          payload: { code: error.code, message: error.message, retryStrategy: error.retry.strategy },
        }),
        error,
      );
    };

    let cancelWake!: () => void;
    const cancelled = new Promise<"cancelled">((resolve) => {
      cancelWake = () => resolve("cancelled");
    });
    controller.onCancel(() => cancelWake());

    const deadlineHandles: Array<{ cancel(): void }> = [];
    let deadlinePromise: Promise<"deadline"> | null = null;
    if (request.deadline !== null) {
      const remainingMs = Math.max(0, new Date(request.deadline).valueOf() - scheduler.now().valueOf());
      const handle = scheduler.delay(remainingMs);
      deadlineHandles.push(handle);
      deadlinePromise = handle.promise.then(() => "deadline" as const);
    }

    const parser = createNdjsonParser();
    const iterator = stream.chunks()[Symbol.asyncIterator]();

    const processRecord = (raw: JsonValue): void => {
      if (doneRecord !== null) {
        throw malformedResponseError("record-after-terminal");
      }
      if (isOllamaErrorRecord(raw)) {
        // The server-supplied error text is untrusted and is dropped.
        throw new ProviderError(
          "INTERNAL_FAILURE",
          "The Ollama server reported a mid-stream failure.",
          { detailCode: "server-reported-error" },
          { causeCategory: "server-reported-error" },
        );
      }
      const record = parseOllamaChatRecord(raw);
      if (
        !ollamaModelNamesEqual(record.model, entry.name) &&
        !ollamaModelNamesEqual(record.model, request.modelId as string)
      ) {
        throw malformedResponseError("response-model-mismatch");
      }
      if (record.done) {
        doneRecord = record;
      }
      if (record.content.length > 0) {
        if (structuredMode) {
          if (structuredText.length + record.content.length > MAX_STRUCTURED_RESULT_TEXT) {
            throw malformedResponseError("oversized-structured-output", {
              maximum: MAX_STRUCTURED_RESULT_TEXT,
            });
          }
          structuredText += record.content;
          for (const piece of chunkText(record.content, MAX_EVENT_TEXT_CHUNK)) {
            emit((base) => ({ ...base, kind: "structured-output-delta", payload: { textDelta: piece } }));
          }
        } else {
          textPieces.push(record.content);
          for (const piece of chunkText(record.content, MAX_EVENT_TEXT_CHUNK)) {
            emit((base) => ({ ...base, kind: "text-delta", payload: { text: piece } }));
          }
        }
      }
      if (record.thinking.length > 0 && adapterOptions.discloseReasoning) {
        for (const piece of chunkText(record.thinking, MAX_EVENT_TEXT_CHUNK)) {
          emit((base) => ({ ...base, kind: "reasoning-delta", payload: { text: piece } }));
        }
      }
      for (const call of record.toolCalls) {
        if (!declaredToolNames.has(call.name)) {
          throw new ProviderError(
            "TOOL_PROTOCOL_FAILURE",
            "The model invoked a tool that was not declared.",
            { toolName: call.name },
          );
        }
        toolCallCounter += 1;
        const toolCallId = `${controller.operation.operationId as string}-tool-${toolCallCounter}`;
        emit((base) => ({
          ...base,
          kind: "tool-call-started",
          payload: { toolCallId, toolName: call.name },
        }));
        let invocation: ToolInvocation;
        try {
          invocation = parseToolInvocation({
            toolCallId,
            toolName: call.name,
            arguments: call.arguments,
          });
        } catch {
          throw new ProviderError(
            "TOOL_PROTOCOL_FAILURE",
            "The model produced tool arguments that failed validation.",
            { toolName: call.name },
          );
        }
        toolParts.push(Object.freeze({ type: "tool-invocation" as const, invocation }));
        usage = { ...usage, toolCalls: usage.toolCalls + 1 };
        emit((base) => ({ ...base, kind: "tool-call-completed", payload: { invocation } }));
      }
    };

    try {
      controller.emit((base) => ({
        ...base,
        kind: "operation-started",
        payload: { modelId: request.modelId as string },
      }));
      emit((base) => ({ ...base, kind: "message-started", payload: { messageIndex: 0 } }));
      emit((base) => ({ ...base, kind: "usage-update", payload: { usage } }));

      streamLoop: for (;;) {
        const races: Array<Promise<"cancelled" | "deadline" | IteratorResult<Uint8Array>>> = [
          iterator.next(),
          cancelled,
        ];
        if (deadlinePromise !== null) {
          races.push(deadlinePromise);
        }
        const winner = await Promise.race(races);
        if (winner === "cancelled" || controller.isTerminal) {
          stream.abort();
          return;
        }
        if (winner === "deadline") {
          stream.abort();
          failOperation(
            new ProviderError("DEADLINE_EXCEEDED", "The operation deadline passed mid-stream.", {}, {
              operationId: controller.operation.operationId as string,
              traceId: request.trace.traceId as string,
            }),
          );
          return;
        }
        if (winner.done === true) {
          for (const record of parser.finish()) {
            processRecord(record);
          }
          break streamLoop;
        }
        for (const record of parser.push(winner.value)) {
          processRecord(record);
        }
      }

      if (doneRecord === null) {
        throw malformedResponseError("truncated-stream");
      }
      const terminal: OllamaWireChatRecord = doneRecord;

      const counters = terminal.counters;
      const inputTokens = counters?.promptEvalCount ?? null;
      const outputTokens = counters?.evalCount ?? null;
      if (inputTokens === null || outputTokens === null) {
        warnings.push("The server omitted usage counters; missing token categories report zero.");
      }
      usage = {
        tokens: {
          inputTokens: inputTokens ?? 0,
          outputTokens: outputTokens ?? 0,
          cachedInputTokens: 0,
          reasoningTokens: 0,
        },
        toolCalls: usage.toolCalls,
      };
      emit((base) => ({ ...base, kind: "usage-update", payload: { usage } }));

      let structuredValue: JsonValue | null = null;
      if (structuredMode) {
        try {
          structuredValue = parseJsonText(structuredText, "structured-output");
        } catch {
          throw malformedResponseError("invalid-structured-output");
        }
        emit((base) => ({
          ...base,
          kind: "structured-output-completed",
          payload: { value: structuredValue },
        }));
      }

      emit((base) => ({ ...base, kind: "message-completed", payload: { messageIndex: 0 } }));

      let finishReason: FinishReason;
      if (toolParts.length > 0) {
        finishReason = "tool-calls";
      } else if (terminal.doneReason === "length") {
        finishReason = "length";
      } else if (terminal.doneReason === "stop" || terminal.doneReason === null) {
        finishReason = "stop";
      } else {
        warnings.push("The server reported an unrecognized completion reason; treating it as stop.");
        finishReason = "stop";
      }

      const parts: ContentPart[] = [];
      const text = textPieces.join("");
      if (text.length > 0) {
        const pieces = chunkText(text, MAX_RESULT_TEXT_PART);
        if (pieces.length > MAX_RESULT_TEXT_PARTS) {
          throw malformedResponseError("oversized-response-text");
        }
        for (const piece of pieces) {
          parts.push(Object.freeze({ type: "text" as const, text: piece }));
        }
      }
      parts.push(...toolParts);
      const messages: readonly ChatMessage[] =
        parts.length > 0
          ? Object.freeze([parseChatMessage({ role: "assistant", parts })])
          : Object.freeze([]);

      const totalMs = scheduler.now().valueOf() - startedAtMs;
      const result: InferenceResult = Object.freeze({
        schemaVersion: 1 as const,
        operationId: controller.operation.operationId,
        requestId: request.requestId,
        modelId: request.modelId,
        messages,
        structuredOutput: structuredValue,
        finishReason,
        refusalMessage: null,
        usage,
        cost: UNKNOWN_COST,
        latency: Object.freeze({
          firstEventMs,
          totalMs: Math.max(totalMs, firstEventMs ?? 0),
        }),
        warnings: Object.freeze([...warnings]),
      });

      ownership.add(entry.name);
      controller.complete((base) => ({ ...base, kind: "operation-completed", payload: {} }), result);

      ollamaObserver?.({
        kind: "operation",
        model: entry.name,
        outcome: "succeeded",
        errorCode: null,
        inputTokens: usage.tokens.inputTokens,
        outputTokens: usage.tokens.outputTokens,
        totalDurationMs: nanosToMillis(counters?.totalDurationNs ?? null),
        loadDurationMs: nanosToMillis(counters?.loadDurationNs ?? null),
        promptEvalDurationMs: nanosToMillis(counters?.promptEvalDurationNs ?? null),
        evalDurationMs: nanosToMillis(counters?.evalDurationNs ?? null),
      });
    } catch (error) {
      stream.abort();
      if (controller.isTerminal) {
        // A cancel or close won the race while this pump was failing.
        return;
      }
      const wrapped = toProviderError(error);
      failOperation(wrapped);
      ollamaObserver?.({
        kind: "operation",
        model: entry.name,
        outcome: "failed",
        errorCode: wrapped.code,
        inputTokens: usage.tokens.inputTokens,
        outputTokens: usage.tokens.outputTokens,
        totalDurationMs: null,
        loadDurationMs: null,
        promptEvalDurationMs: null,
        evalDurationMs: null,
      });
    } finally {
      for (const handle of deadlineHandles) {
        handle.cancel();
      }
    }
  }

  async function requestParsedJson(
    endpoint: "ps" | "version" | "generate",
    body: JsonValue | null,
    timeoutMs: number,
  ): Promise<JsonValue> {
    const response = await transport.requestJson(endpoint, body, { timeoutMs });
    if (response.status < 200 || response.status >= 300 || response.value === null) {
      throw httpStatusError({ status: response.status, endpoint, retryAfterMs: response.retryAfterMs });
    }
    return response.value;
  }

  const provider: OllamaInferenceProvider = {
    kind: "inference",

    describe(): ProviderDescriptor {
      return descriptor;
    },

    async health(): Promise<ProviderHealth> {
      const snapshot = await provider.inspectHealth();
      const status =
        snapshot.category === "healthy"
          ? "ready"
          : snapshot.category === "closed"
            ? "closed"
            : snapshot.category === "degraded" || snapshot.category === "overloaded"
              ? "degraded"
              : "unavailable";
      const detailCode =
        snapshot.category === "healthy"
          ? null
          : snapshot.category === "unavailable"
            ? "server-unreachable"
            : snapshot.category === "incompatible"
              ? "incompatible-api"
              : snapshot.category === "overloaded"
                ? "capacity-saturated"
                : snapshot.category === "degraded"
                  ? "digest-mismatch"
                  : null;
      return parseProviderHealth({
        status,
        checkedAt: snapshot.checkedAt,
        detailCode,
        activeOperations: capacity.snapshot().activeOperations,
      });
    },

    async inspectHealth(): Promise<OllamaHealthSnapshot> {
      const checkedAt = scheduler.now().toISOString();
      const capacitySnapshot = capacity.snapshot();
      const capacityUtilization: "idle" | "active" | "saturated" =
        capacitySnapshot.queuedOperations > 0 ||
        capacitySnapshot.activeOperations >= configuration.maxConcurrentOperations
          ? "saturated"
          : capacitySnapshot.activeOperations > 0
            ? "active"
            : "idle";

      if (closed) {
        return Object.freeze({
          category: "closed",
          checkedAt,
          endpointFamily: configuration.endpoint.family,
          serverReachable: false,
          apiCompatible: false,
          serverVersion: null,
          installedModelCount: null,
          eligibleModelCount: null,
          runningModelCount: null,
          digestMismatchCount: null,
          capacityUtilization,
          catalogObservedAt: catalog?.observedAt ?? null,
        });
      }

      let serverReachable = false;
      let apiCompatible = false;
      let serverVersion: string | null = null;
      try {
        const value = await requestParsedJson("version", null, configuration.discoveryTimeoutMs);
        serverReachable = true;
        serverVersion = parseOllamaVersionResponse(value).version;
        apiCompatible = true;
      } catch (error) {
        if (error instanceof ProviderError && error.code !== "NETWORK_FAILURE" && error.code !== "TIMEOUT") {
          serverReachable = true;
          apiCompatible = false;
        }
      }

      const digestMismatchCount =
        catalog === null ? null : catalog.entries.filter((entry) => entry.pin === "mismatched").length;
      const category: OllamaHealthCategory = !serverReachable
        ? "unavailable"
        : !apiCompatible
          ? "incompatible"
          : capacityUtilization === "saturated"
            ? "overloaded"
            : digestMismatchCount !== null && digestMismatchCount > 0
              ? "degraded"
              : "healthy";

      ollamaObserver?.({ kind: "health-check", category, serverReachable, apiCompatible });

      return Object.freeze({
        category,
        checkedAt,
        endpointFamily: configuration.endpoint.family,
        serverReachable,
        apiCompatible,
        serverVersion,
        installedModelCount: catalog?.entries.length ?? null,
        eligibleModelCount: catalog === null ? null : catalog.entries.filter((entry) => entry.eligible).length,
        runningModelCount: catalog === null ? null : catalog.entries.filter((entry) => entry.running).length,
        digestMismatchCount,
        capacityUtilization,
        catalogObservedAt: catalog?.observedAt ?? null,
      });
    },

    async listModels(): Promise<readonly ModelDescriptor[]> {
      if (closed) {
        throw providerClosedError();
      }
      const current = await provider.refreshCatalog();
      const descriptors: ModelDescriptor[] = [];
      for (const entry of current.entries) {
        if (!entry.eligible) {
          continue;
        }
        const model = toStage2ModelCapabilities({
          providerId: OLLAMA_PROVIDER_ID,
          modelName: entry.name,
          capabilities: entry.capabilities,
          family: entry.family,
          families: entry.families,
          parameterSize: entry.parameterSize,
        });
        if (model !== null) {
          descriptors.push(Object.freeze({ model, availability: "available" as const }));
        }
      }
      return Object.freeze(descriptors);
    },

    async refreshCatalog(): Promise<OllamaModelCatalog> {
      if (closed) {
        throw providerClosedError();
      }
      catalog = null;
      return ensureCatalog();
    },

    catalogSnapshot(): OllamaModelCatalog | null {
      return catalog;
    },

    async runningModels(): Promise<readonly OllamaWireRunningModel[]> {
      if (closed) {
        throw providerClosedError();
      }
      const value = await requestParsedJson("ps", null, configuration.discoveryTimeoutMs);
      return parseOllamaPsResponse(value).models;
    },

    async selectModel(query: OllamaSelectionQuery): Promise<OllamaSelectionResult> {
      if (closed) {
        throw providerClosedError();
      }
      const current = await ensureCatalog();
      return selectOllamaModel(current, configuration, query);
    },

    capacitySnapshot(): OllamaCapacitySnapshot {
      return capacity.snapshot();
    },

    ownedModels(): readonly string[] {
      return Object.freeze([...ownership].sort());
    },

    async preloadModel(modelName: string): Promise<void> {
      if (closed) {
        throw providerClosedError();
      }
      await ensureCatalog();
      const entry = requireEligibleEntry(modelName);
      await requestParsedJson(
        "generate",
        { model: entry.name, keep_alive: keepAliveWireValue(configuration.keepAlive), stream: false } as unknown as JsonValue,
        configuration.requestTimeoutMs,
      );
      ownership.add(entry.name);
      ollamaObserver?.({ kind: "residency", action: "load", model: entry.name, category: "applied" });
    },

    async planResidency(): Promise<OllamaResidencyPlan> {
      if (closed) {
        throw providerClosedError();
      }
      const running = await provider.runningModels();
      return planOllamaResidency({
        keepAlive: configuration.keepAlive,
        running,
        ownedModels: provider.ownedModels(),
        activeModels: capacity.activeModels(),
        queuedModels: capacity.queuedModels(),
        capacityBudgetBytes: configuration.capacityBudgetBytes,
        capacitySafetyMarginBytes: configuration.capacitySafetyMarginBytes,
      });
    },

    async applyResidencyPlan(plan: OllamaResidencyPlan): Promise<void> {
      if (closed) {
        throw providerClosedError();
      }
      for (const step of plan.steps) {
        // Re-check at execution time: a lease acquired after planning must
        // still prevent the unload.
        if (step.action === "unload" && capacity.activeModels().includes(step.model)) {
          continue;
        }
        try {
          if (step.action === "unload") {
            await requestParsedJson(
              "generate",
              { model: step.model, keep_alive: 0, stream: false } as unknown as JsonValue,
              configuration.requestTimeoutMs,
            );
            ownership.delete(step.model);
          } else {
            await requestParsedJson(
              "generate",
              { model: step.model, keep_alive: keepAliveWireValue(configuration.keepAlive), stream: false } as unknown as JsonValue,
              configuration.requestTimeoutMs,
            );
            ownership.add(step.model);
          }
          ollamaObserver?.({ kind: "residency", action: step.action, model: step.model, category: "applied" });
        } catch (error) {
          ollamaObserver?.({ kind: "residency", action: step.action, model: step.model, category: "failed" });
          throw error;
        }
      }
    },

    async start(
      rawRequest: InferenceRequest,
      startOptions: StartOperationOptions = {},
    ): Promise<InferenceOperation> {
      if (closed) {
        throw providerClosedError();
      }
      let request: InferenceRequest;
      try {
        request = parseInferenceRequest(rawRequest);
      } catch (error) {
        if (error instanceof ProviderError) {
          throw error;
        }
        throw new ProviderError("INVALID_REQUEST", "The request failed validation.", {
          reason: error instanceof ValidationError ? error.issues[0]?.code ?? "invalid" : "invalid",
        });
      }
      const adapterOptions = parseAdapterExtensions(request);
      if (isDeadlineExpired(request.deadline, scheduler.now())) {
        throw new ProviderError("DEADLINE_EXCEEDED", "The deadline passed before start.", {}, {
          traceId: request.trace.traceId as string,
        });
      }
      await ensureCatalog();
      const entry = requireEligibleEntry(request.modelId as string);
      validateRequestAgainstEntry(request, entry, adapterOptions);

      const abortFlag = createAbortFlag();
      if (startOptions.signal !== undefined) {
        if (startOptions.signal.aborted) {
          abortFlag.abort();
        } else {
          startOptions.signal.addEventListener("abort", () => abortFlag.abort(), { once: true });
        }
      }

      let lease: OllamaCapacityLease;
      try {
        lease = await capacity.acquire({
          model: entry.name,
          modelSizeBytes: entry.sizeBytes,
          deadline: request.deadline,
          signal: abortFlag.signal,
        });
        ollamaObserver?.({ kind: "admission", category: "admitted", model: entry.name, errorCode: null });
      } catch (error) {
        const wrapped = toProviderError(error);
        ollamaObserver?.({ kind: "admission", category: "rejected", model: entry.name, errorCode: wrapped.code });
        throw wrapped;
      }

      const body = toWireChatRequest(request, entry.name, adapterOptions, keepAliveWireValue(configuration.keepAlive));

      let streamResponse: OllamaStreamResponse;
      try {
        streamResponse = await transport.requestStream("chat", body, {
          timeoutMs: configuration.requestTimeoutMs,
          signal: abortFlag.signal,
        });
      } catch (error) {
        lease.release();
        throw toProviderError(error);
      }
      if (!streamResponse.ok) {
        lease.release();
        throw httpStatusError({
          status: streamResponse.status,
          endpoint: "chat",
          retryAfterMs: streamResponse.retryAfterMs,
        });
      }

      operationCounter += 1;
      const operationId = `op-ollama-${operationCounter.toString().padStart(6, "0")}` as ProviderOperationId;
      const controller = createOperationController<InferenceEvent, InferenceResult>({
        operationId,
        clock,
        trace: request.trace,
        buildCancelledEvent: (base, reason) => ({
          ...base,
          kind: "operation-cancelled",
          payload: { reason },
        }),
        onTerminal: (outcome) => {
          observer?.(
            Object.freeze({
              providerKind: "inference",
              providerId: OLLAMA_PROVIDER_ID,
              instanceId: configuration.instanceId,
              modelId: entry.name,
              outcome:
                outcome.kind === "operation-completed"
                  ? "succeeded"
                  : outcome.kind === "operation-cancelled"
                    ? "cancelled"
                    : "failed",
              errorCode: outcome.error?.code ?? null,
              retryStrategy: outcome.error?.retry.strategy ?? null,
              latencyMs: 0,
              totalTokens: 0,
              deadlineExpired: outcome.error?.code === "DEADLINE_EXCEEDED",
              cancelled: outcome.kind === "operation-cancelled",
            }),
          );
          if (outcome.kind === "operation-cancelled") {
            ollamaObserver?.({
              kind: "operation",
              model: entry.name,
              outcome: "cancelled",
              errorCode: null,
              inputTokens: 0,
              outputTokens: 0,
              totalDurationMs: null,
              loadDurationMs: null,
              promptEvalDurationMs: null,
              evalDurationMs: null,
            });
          }
        },
      });
      controller.onCancel(() => {
        abortFlag.abort();
        streamResponse.abort();
      });
      if (startOptions.signal !== undefined) {
        startOptions.signal.addEventListener(
          "abort",
          () => {
            void controller.operation.cancel("caller-aborted");
          },
          { once: true },
        );
      }

      const cancelForClose = (reason: "provider-closed"): Promise<void> =>
        controller.operation.cancel(reason);
      activeCancels.add(cancelForClose);

      const running = pump({
        request,
        entry,
        adapterOptions,
        controller,
        stream: streamResponse,
        abortFlag,
      })
        .catch(() => undefined)
        .finally(() => {
          lease.release();
          activeCancels.delete(cancelForClose);
          pumps.delete(running);
        });
      pumps.add(running);

      return controller.operation;
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      for (const cancel of [...activeCancels]) {
        await cancel("provider-closed");
      }
      activeCancels.clear();
      capacity.close();
      await Promise.allSettled([...pumps]);
      transport.close();
    },
  };

  return provider;
}
