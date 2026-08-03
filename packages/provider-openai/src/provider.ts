import {
  ValidationError,
  parseJsonText,
  type JsonValue,
} from "@ai-dev-os/domain";
import {
  ProviderError,
  createOperationController,
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
import {
  findCapabilityOverride,
  type OpenAiAdapterConfiguration,
} from "./config.js";
import {
  applyCapabilityOverride,
  computeCost,
  listCatalogModelIds,
  selectCatalogEntry,
  toModelCapabilities,
  UNKNOWN_COMPUTED_COST,
  type ComputedCost,
  type OpenAiCatalogEntry,
  type OpenAiModelCatalog,
} from "./catalog.js";
import {
  httpStatusError,
  malformedResponseError,
  operationMayStillRunError,
  policyDeniedError,
  protocolViolationError,
  providerClosedError,
  responseFailureError,
  toolProtocolError,
  unsupportedCapabilityError,
} from "./errors.js";
import {
  advanceCursor,
  assertHandleUsable,
  assertResumeContinuity,
  computeBackgroundBinding,
  createBackgroundHandle,
  createSequenceGuard,
  isActiveStatus,
  type BackgroundHandle,
} from "./background.js";
import { createSseParser } from "./sse.js";
import { validateAgainstSchema } from "./schema.js";
import {
  buildResponsesRequest,
  collectImageArtifacts,
  parseRequestExtensions,
  type OpenAiRequestOptions,
  type ResolvedImage,
} from "./request.js";
import {
  computeBackoffMs,
  fixedJitterSource,
  systemOpenAiScheduler,
  type JitterSource,
  type OpenAiScheduler,
} from "./scheduler.js";
import {
  createFetchOpenAiTransport,
  type OpenAiJsonResponse,
  type OpenAiStreamResponse,
  type OpenAiTransport,
} from "./transport.js";
import {
  classifyStreamEvent,
  isTerminalStatus,
  parseResponseSnapshot,
  toTokenUsage,
  ZERO_WIRE_USAGE,
  type OpenAiResponseSnapshot,
  type OpenAiWireUsage,
  type WireLimits,
} from "./wire.js";
import {
  safelyObserve,
  type OpenAiExecutionMode,
  type OpenAiObservation,
  type OpenAiObserver,
  type OpenAiRetentionObservation,
} from "./observability.js";
import type {
  ArtifactResolverPort,
  CredentialPort,
  DisclosurePort,
  IdSource,
  SafetyIdentifierPort,
} from "./ports.js";

export const OPENAI_PROVIDER_ID = "openai";

const MAX_EVENT_TEXT_CHUNK = 16_384;
const MAX_RESULT_TEXT_PART = 262_144;
const MAX_RESULT_TEXT_PARTS = 32;

/**
 * Honest description of what the upstream retains for this instance.
 *
 * The adapter never claims Zero Data Retention merely because it sent
 * `store: false`. Background mode in particular places content in
 * temporary server-side storage regardless of `store`, and that fact is
 * reported here and in every operation's observation record.
 */
export interface OpenAiRetentionDisclosure {
  /** Value the adapter sends as `store` when policy authorizes nothing. */
  readonly defaultStore: boolean;
  readonly persistenceConfigurable: boolean;
  readonly backgroundModeEnabled: boolean;
  /** Temporary server-side storage window background mode implies. */
  readonly backgroundTemporaryStorageMs: number;
  readonly zeroDataRetentionEnrolled: boolean;
  readonly abuseMonitoringRetentionDays: number | null;
  readonly declarationSource: string;
  readonly declaredAt: string;
  /** Continuation via `previous_response_id` requires stored state. */
  readonly previousResponseContinuationEnabled: boolean;
}

export interface OpenAiInferenceProvider extends InferenceProvider {
  catalogSnapshot(): OpenAiModelCatalog;
  describeRetention(): OpenAiRetentionDisclosure;
}

export interface CreateOpenAiProviderOptions {
  readonly configuration: OpenAiAdapterConfiguration;
  readonly credentials: CredentialPort;
  readonly disclosure: DisclosurePort;
  readonly safetyIdentifier?: SafetyIdentifierPort;
  readonly artifacts?: ArtifactResolverPort;
  readonly transport?: OpenAiTransport;
  readonly scheduler?: OpenAiScheduler;
  readonly jitter?: JitterSource;
  readonly ids?: IdSource;
  readonly observer?: ProviderObserver;
  readonly openAiObserver?: OpenAiObserver;
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

function toBase64DataUrl(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

interface PendingToolCall {
  readonly callId: string;
  readonly name: string;
  argumentsText: string;
  completed: boolean;
}

/**
 * Mutable holder shared between `start` and the operation driver. In
 * background streaming mode the response id only appears on the first
 * lifecycle event, yet cancellation — which is registered during `start` —
 * must still be able to reach the remote response.
 */
interface BackgroundHandleBox {
  current: BackgroundHandle | null;
}

export function createOpenAiProvider(
  options: CreateOpenAiProviderOptions,
): OpenAiInferenceProvider {
  const configuration = options.configuration;
  const scheduler = options.scheduler ?? systemOpenAiScheduler;
  const clock: Clock = Object.freeze({ now: (): Date => scheduler.now() });
  const jitter = options.jitter ?? fixedJitterSource();
  const transport =
    options.transport ??
    createFetchOpenAiTransport({
      endpoint: configuration.endpoint,
      organizationId: configuration.organizationId,
      projectId: configuration.projectId,
      scheduler,
    });
  const observer = options.observer;
  const openAiObserver = options.openAiObserver;

  let operationCounter = 0;
  const defaultIds: IdSource = (kind) => {
    operationCounter += 1;
    return `${kind === "operation" ? "op" : "tc"}-openai-${operationCounter.toString().padStart(6, "0")}`;
  };
  const ids = options.ids ?? defaultIds;

  let closed = false;
  const activeCancels = new Set<(reason: "provider-closed") => Promise<void>>();
  const pumps = new Set<Promise<void>>();

  const wireLimits: WireLimits = Object.freeze({
    maxOutputItems: configuration.limits.maxOutputItems,
    maxToolCallArgumentsBytes: configuration.limits.maxToolCallArgumentsBytes,
    maxTextBytes: configuration.limits.maxStructuredOutputBytes,
  });

  const retentionDisclosure: OpenAiRetentionDisclosure = Object.freeze({
    defaultStore: false,
    persistenceConfigurable: configuration.storage.store === "when-authorized",
    backgroundModeEnabled: configuration.background.mode !== "disabled",
    backgroundTemporaryStorageMs: configuration.retention.backgroundTemporaryStorageMs,
    zeroDataRetentionEnrolled: configuration.retention.zeroDataRetentionEnrolled,
    abuseMonitoringRetentionDays: configuration.retention.abuseMonitoringRetentionDays,
    declarationSource: configuration.retention.source,
    declaredAt: configuration.retention.declaredAt,
    previousResponseContinuationEnabled: configuration.storage.allowPreviousResponseContinuation,
  });

  /**
   * `retainsData` reflects what this instance can actually cause the
   * upstream to retain: durable persistence when policy may authorize
   * `store`, or the documented temporary background storage. It is not a
   * claim about the account's contractual retention terms.
   */
  const descriptor: ProviderDescriptor = parseProviderDescriptor({
    schemaVersion: 1,
    providerId: OPENAI_PROVIDER_ID,
    instanceId: configuration.instanceId,
    kind: "inference",
    displayName: "OpenAI (Responses API)",
    locality: "cloud",
    retainsData:
      configuration.storage.store === "when-authorized" || configuration.background.mode !== "disabled",
    trainsOnInputs: false,
    supportedClassifications: configuration.supportedClassifications,
    capabilities: {
      streaming: true,
      structuredOutput: true,
      toolCalling: true,
      imageInput: options.artifacts !== undefined,
      repositoryEditing: false,
      commandExecution: false,
      networkAccess: true,
      resumability:
        configuration.background.mode !== "disabled" && configuration.background.resumeStreamEnabled,
      cancellation: "best-effort",
      deadlineEnforcement: true,
      usageReporting: true,
      pricingAvailable: configuration.catalog.entries.some((entry) => entry.pricing.length > 0),
    },
  });

  function effectiveEntry(modelId: string, at: string): OpenAiCatalogEntry {
    if (!configuration.permittedModels.includes(modelId)) {
      throw policyDeniedError("model-not-permitted", { modelId });
    }
    const entry = selectCatalogEntry(configuration.catalog, modelId, at);
    if (entry === null) {
      throw new ProviderError(
        "MODEL_UNAVAILABLE",
        "No catalog entry is effective for this model at this time.",
        { modelId, detailCode: "no-effective-catalog-entry" },
      );
    }
    return applyCapabilityOverride(entry, findCapabilityOverride(configuration, modelId));
  }

  function requestTimeouts(streaming: boolean): {
    readonly timeoutMs: number;
    readonly connectTimeoutMs: number;
    readonly maxResponseBytes: number;
    readonly maxErrorBodyBytes: number;
  } {
    return {
      timeoutMs: streaming
        ? configuration.deadlines.totalOperationTimeoutMs
        : configuration.deadlines.requestTimeoutMs,
      connectTimeoutMs: configuration.deadlines.connectTimeoutMs,
      maxResponseBytes: streaming
        ? configuration.limits.maxStreamBytes
        : configuration.limits.maxResponseBytes,
      maxErrorBodyBytes: configuration.limits.maxErrorBodyBytes,
    };
  }

  // -------------------------------------------------------------------------
  // Pump context
  // -------------------------------------------------------------------------

  interface OperationContext {
    readonly request: InferenceRequest;
    readonly entry: OpenAiCatalogEntry;
    readonly requestOptions: OpenAiRequestOptions;
    readonly controller: ReturnType<typeof createOperationController<InferenceEvent, InferenceResult>>;
    readonly abortFlag: AbortFlag;
    readonly executionMode: OpenAiExecutionMode;
    readonly retention: OpenAiRetentionObservation;
    readonly binding: string;
    readonly body: JsonValue;
    readonly startedAtMs: number;
  }

  /** Mutable accumulation shared by the streaming and polling paths. */
  interface Accumulator {
    text: string;
    structuredText: string;
    refusalText: string;
    readonly toolCalls: Map<string, PendingToolCall>;
    readonly invocations: ToolInvocation[];
    readonly warnings: string[];
    usage: OpenAiWireUsage;
    terminalSnapshot: OpenAiResponseSnapshot | null;
    informationalIgnored: number;
    /**
     * Response id observed on a lifecycle event. In background STREAMING
     * mode this is the only place the id appears, and it is required to
     * build a resume handle.
     */
    observedResponseId: string | null;
  }

  function createAccumulator(): Accumulator {
    return {
      text: "",
      structuredText: "",
      refusalText: "",
      toolCalls: new Map<string, PendingToolCall>(),
      invocations: [],
      warnings: [],
      usage: ZERO_WIRE_USAGE,
      terminalSnapshot: null,
      informationalIgnored: 0,
      observedResponseId: null,
    };
  }

  function providerUsageOf(usage: OpenAiWireUsage, toolCalls: number): ProviderUsage {
    return Object.freeze({ tokens: toTokenUsage(usage), toolCalls });
  }

  function finishReasonOf(
    context: OperationContext,
    accumulator: Accumulator,
    snapshot: OpenAiResponseSnapshot,
  ): FinishReason {
    if (accumulator.refusalText.length > 0) {
      return "refusal";
    }
    if (accumulator.invocations.length > 0) {
      return "tool-calls";
    }
    if (snapshot.status === "incomplete") {
      if (snapshot.incompleteReason === "max_output_tokens") {
        return "length";
      }
      if (snapshot.incompleteReason === "content_filter") {
        return "content-filter";
      }
      accumulator.warnings.push(
        "The response was reported incomplete without a recognized reason; treating it as a length stop.",
      );
      return "length";
    }
    void context;
    return "stop";
  }

  function buildResult(
    context: OperationContext,
    accumulator: Accumulator,
    snapshot: OpenAiResponseSnapshot,
  ): { readonly result: InferenceResult; readonly cost: ComputedCost } {
    const { request, entry, controller } = context;
    const nowIso = scheduler.now().toISOString();

    let structuredOutput: JsonValue | null = null;
    if (request.structuredOutput !== null) {
      if (accumulator.refusalText.length === 0) {
        if (snapshot.status === "incomplete") {
          throw malformedResponseError("structured-output-truncated", {
            reason: snapshot.incompleteReason,
          });
        }
        if (accumulator.structuredText.length > configuration.limits.maxStructuredOutputBytes) {
          throw malformedResponseError("oversized-structured-output", {
            maximum: configuration.limits.maxStructuredOutputBytes,
          });
        }
        let parsed: JsonValue;
        try {
          parsed = parseJsonText(accumulator.structuredText, "structured-output");
        } catch {
          throw malformedResponseError("invalid-structured-output-json");
        }
        // The caller's schema is authoritative: strict mode being requested
        // is not evidence that the value conforms.
        const validated = validateAgainstSchema(request.structuredOutput.schema, parsed);
        if (!validated.valid) {
          throw malformedResponseError("structured-output-schema-mismatch", {
            violationCount: validated.violations.length,
            firstViolationCode: validated.violations[0]?.code ?? null,
            firstViolationPath: validated.violations[0]?.path ?? null,
          });
        }
        if (validated.unenforcedKeywords.length > 0) {
          accumulator.warnings.push(
            `Structured output was validated against a supported JSON Schema subset; ${validated.unenforcedKeywords.length} keyword(s) were not enforced.`,
          );
        }
        structuredOutput = parsed;
      }
    }

    const parts: ContentPart[] = [];
    if (request.structuredOutput === null && accumulator.text.length > 0) {
      const pieces = chunkText(accumulator.text, MAX_RESULT_TEXT_PART);
      if (pieces.length > MAX_RESULT_TEXT_PARTS) {
        throw malformedResponseError("oversized-response-text");
      }
      for (const piece of pieces) {
        parts.push(Object.freeze({ type: "text" as const, text: piece }));
      }
    }
    for (const invocation of accumulator.invocations) {
      parts.push(Object.freeze({ type: "tool-invocation" as const, invocation }));
    }
    const messages: readonly ChatMessage[] =
      parts.length > 0 ? Object.freeze([parseChatMessage({ role: "assistant", parts })]) : Object.freeze([]);

    const usage = providerUsageOf(accumulator.usage, accumulator.invocations.length);
    const cost = computeCost(entry, usage.tokens, accumulator.usage.cacheWriteTokens, nowIso);
    if (cost.cacheWriteUnpriced) {
      accumulator.warnings.push(
        "Cache-write tokens were reported but the pricing snapshot declares no cache-write rate; the computed cost is a lower bound.",
      );
    }
    if (cost.money === null) {
      accumulator.warnings.push(
        "No pricing snapshot is effective for this model at this time; the cost is reported as unknown.",
      );
    }

    const totalMs = Math.max(0, scheduler.now().valueOf() - context.startedAtMs);
    const firstEventMs = Math.min(firstEventOffset ?? totalMs, totalMs);

    const result: InferenceResult = Object.freeze({
      schemaVersion: 1 as const,
      operationId: controller.operation.operationId,
      requestId: request.requestId,
      modelId: request.modelId,
      messages,
      structuredOutput,
      finishReason: finishReasonOf(context, accumulator, snapshot),
      refusalMessage: accumulator.refusalText.length > 0 ? accumulator.refusalText.slice(0, 4_000) : null,
      usage,
      cost: Object.freeze({ providerReported: null, locallyComputed: cost.money }),
      latency: Object.freeze({ firstEventMs, totalMs }),
      warnings: Object.freeze([...accumulator.warnings].slice(0, 32)),
    });
    return { result, cost };
  }

  // `firstEventOffset` is scoped per pump invocation; declared here so
  // buildResult can read it without threading it through every call.
  let firstEventOffset: number | null = null;

  // -------------------------------------------------------------------------
  // Streaming pump
  // -------------------------------------------------------------------------

  interface StreamOutcome {
    readonly kind: "terminal" | "disconnected";
    readonly cursor: number | null;
  }

  async function pumpStream(
    context: OperationContext,
    stream: OpenAiStreamResponse,
    accumulator: Accumulator,
    guard: ReturnType<typeof createSequenceGuard>,
    emitEvent: (build: Parameters<OperationContext["controller"]["emit"]>[0]) => void,
    requestedAfter: number | null,
  ): Promise<StreamOutcome> {
    const { request, controller, requestOptions } = context;
    const structuredMode = request.structuredOutput !== null;
    const declaredTools = new Set(request.tools.map((tool) => tool.name as string));
    const parser = createSseParser({
      maxLineBytes: configuration.limits.maxSseLineBytes,
      maxEventBytes: configuration.limits.maxSseEventBytes,
      maxStreamBytes: configuration.limits.maxStreamBytes,
      maxEvents: configuration.limits.maxStreamEvents,
    });

    let cancelWake!: () => void;
    const cancelled = new Promise<"cancelled">((resolve) => {
      cancelWake = () => resolve("cancelled");
    });
    controller.onCancel(() => cancelWake());

    const timers: Array<{ cancel(): void }> = [];
    let deadlinePromise: Promise<"deadline"> | null = null;
    if (request.deadline !== null) {
      const remainingMs = Math.max(0, new Date(request.deadline).valueOf() - scheduler.now().valueOf());
      const handle = scheduler.delay(remainingMs);
      timers.push(handle);
      deadlinePromise = handle.promise.then(() => "deadline" as const);
    }

    let firstNewSequenceChecked = requestedAfter === null;
    const iterator = stream.chunks()[Symbol.asyncIterator]();

    const processEvent = (payload: JsonValue): void => {
      const event = classifyStreamEvent(payload, wireLimits);

      if (!firstNewSequenceChecked) {
        assertResumeContinuity(requestedAfter, event.sequence);
        firstNewSequenceChecked = true;
      }
      if (!guard.accept(event.sequence)) {
        // Replayed after a resume; already surfaced exactly once.
        return;
      }
      if (accumulator.terminalSnapshot !== null) {
        throw protocolViolationError("event-after-terminal", { sequence: event.sequence });
      }

      switch (event.kind) {
        case "lifecycle":
          accumulator.observedResponseId = event.snapshot.id;
          break;
        case "informational":
          accumulator.informationalIgnored += 1;
          break;
        case "error":
          throw responseFailureError(event.error);
        case "output-item-added": {
          if (event.item.type === "function_call") {
            const name = event.item.name;
            if (!declaredTools.has(name)) {
              throw toolProtocolError("undeclared-tool", { toolName: name });
            }
            accumulator.toolCalls.set(event.item.id ?? event.item.callId, {
              callId: event.item.callId,
              name,
              argumentsText: "",
              completed: false,
            });
            emitEvent((base) => ({
              ...base,
              kind: "tool-call-started",
              payload: { toolCallId: event.item.type === "function_call" ? event.item.callId : "", toolName: name },
            }));
          }
          break;
        }
        case "output-item-done":
          break;
        case "text-delta": {
          if (event.delta.length === 0) {
            break;
          }
          if (structuredMode) {
            accumulator.structuredText += event.delta;
            for (const piece of chunkText(event.delta, MAX_EVENT_TEXT_CHUNK)) {
              emitEvent((base) => ({
                ...base,
                kind: "structured-output-delta",
                payload: { textDelta: piece },
              }));
            }
          } else {
            accumulator.text += event.delta;
            for (const piece of chunkText(event.delta, MAX_EVENT_TEXT_CHUNK)) {
              emitEvent((base) => ({ ...base, kind: "text-delta", payload: { text: piece } }));
            }
          }
          break;
        }
        case "text-done": {
          const streamed = structuredMode ? accumulator.structuredText : accumulator.text;
          if (streamed !== event.text) {
            throw malformedResponseError("text-delta-final-disagreement");
          }
          break;
        }
        case "refusal-delta":
          accumulator.refusalText += event.delta;
          break;
        case "refusal-done":
          if (accumulator.refusalText !== event.refusal) {
            throw malformedResponseError("refusal-delta-final-disagreement");
          }
          break;
        case "function-arguments-delta": {
          const pending = accumulator.toolCalls.get(event.itemId);
          if (pending === undefined) {
            throw toolProtocolError("arguments-for-unknown-tool-call");
          }
          pending.argumentsText += event.delta;
          if (pending.argumentsText.length > configuration.limits.maxToolCallArgumentsBytes) {
            throw toolProtocolError("oversized-tool-arguments", {
              maximum: configuration.limits.maxToolCallArgumentsBytes,
            });
          }
          emitEvent((base) => ({
            ...base,
            kind: "tool-call-delta",
            payload: { toolCallId: pending.callId, argumentsDelta: event.delta },
          }));
          break;
        }
        case "function-arguments-done": {
          const pending = accumulator.toolCalls.get(event.itemId);
          if (pending === undefined) {
            throw toolProtocolError("completion-for-unknown-tool-call");
          }
          if (pending.completed) {
            throw toolProtocolError("duplicate-tool-call-completion");
          }
          if (pending.name !== event.name) {
            throw toolProtocolError("tool-name-changed-mid-call");
          }
          if (pending.argumentsText.length > 0 && pending.argumentsText !== event.argumentsText) {
            throw toolProtocolError("tool-arguments-delta-final-disagreement");
          }
          pending.completed = true;
          const invocation = buildInvocation(pending.callId, pending.name, event.argumentsText);
          accumulator.invocations.push(invocation);
          emitEvent((base) => ({ ...base, kind: "tool-call-completed", payload: { invocation } }));
          break;
        }
        case "reasoning-delta": {
          if (!requestOptions.discloseReasoning) {
            // Reasoning stays internal unless policy explicitly allows it.
            break;
          }
          for (const piece of chunkText(event.delta, MAX_EVENT_TEXT_CHUNK)) {
            emitEvent((base) => ({ ...base, kind: "reasoning-delta", payload: { text: piece } }));
          }
          break;
        }
        case "terminal":
          accumulator.observedResponseId = event.snapshot.id;
          accumulator.terminalSnapshot = event.snapshot;
          break;
      }
    };

    try {
      for (;;) {
        const idle = scheduler.delay(configuration.deadlines.idleStreamTimeoutMs);
        const races: Array<Promise<"cancelled" | "deadline" | "idle" | IteratorResult<Uint8Array>>> = [
          iterator.next(),
          cancelled,
          idle.promise.then(() => "idle" as const),
        ];
        if (deadlinePromise !== null) {
          races.push(deadlinePromise);
        }
        let winner: "cancelled" | "deadline" | "idle" | IteratorResult<Uint8Array>;
        try {
          winner = await Promise.race(races);
        } finally {
          idle.cancel();
        }

        if (winner === "cancelled" || controller.isTerminal) {
          stream.abort();
          return { kind: "terminal", cursor: guard.highest };
        }
        if (winner === "deadline") {
          stream.abort();
          throw new ProviderError(
            "DEADLINE_EXCEEDED",
            "The operation deadline passed mid-stream.",
            {},
            {
              operationId: controller.operation.operationId as string,
              traceId: request.trace.traceId as string,
            },
          );
        }
        if (winner === "idle") {
          stream.abort();
          // An expired deadline outranks an idle stall: both timers can come
          // due in the same tick, and the caller's deadline is the more
          // specific and more actionable failure.
          if (isDeadlineExpired(request.deadline, scheduler.now())) {
            throw new ProviderError(
              "DEADLINE_EXCEEDED",
              "The operation deadline passed mid-stream.",
              {},
              {
                operationId: controller.operation.operationId as string,
                traceId: request.trace.traceId as string,
              },
            );
          }
          throw new ProviderError(
            "TIMEOUT",
            "The OpenAI stream produced no data within the idle bound.",
            { idleStreamTimeoutMs: configuration.deadlines.idleStreamTimeoutMs },
            { causeCategory: "idle-stream-timeout" },
          );
        }
        if (winner.done === true) {
          for (const sseEvent of parser.finish()) {
            if (sseEvent.data.length > 0 && sseEvent.data !== "[DONE]") {
              processEvent(parseSseData(sseEvent.data));
            }
          }
          break;
        }
        for (const sseEvent of parser.push(winner.value)) {
          if (sseEvent.data.length === 0 || sseEvent.data === "[DONE]") {
            continue;
          }
          processEvent(parseSseData(sseEvent.data));
        }
      }
    } finally {
      for (const timer of timers) {
        timer.cancel();
      }
    }

    if (accumulator.terminalSnapshot === null) {
      return { kind: "disconnected", cursor: guard.highest };
    }
    return { kind: "terminal", cursor: guard.highest };
  }

  function parseSseData(data: string): JsonValue {
    try {
      return parseJsonText(data, "sse-data");
    } catch {
      throw malformedResponseError("malformed-sse-json");
    }
  }

  function buildInvocation(callId: string, name: string, argumentsText: string): ToolInvocation {
    let parsedArguments: JsonValue;
    try {
      parsedArguments = argumentsText.trim().length === 0 ? {} : parseJsonText(argumentsText, "tool-arguments");
    } catch {
      throw toolProtocolError("invalid-tool-arguments-json", { toolName: name });
    }
    try {
      return parseToolInvocation({ toolCallId: callId, toolName: name, arguments: parsedArguments });
    } catch {
      throw toolProtocolError("tool-invocation-validation-failed", { toolName: name });
    }
  }

  /**
   * Reconciles the terminal response object exactly once: usage is taken
   * from the terminal snapshot, never accumulated from deltas, so a
   * replayed stream cannot double count.
   */
  function reconcileTerminal(accumulator: Accumulator, snapshot: OpenAiResponseSnapshot): void {
    if (snapshot.status === "failed") {
      throw responseFailureError(snapshot.error ?? { type: null, code: null, param: null });
    }
    if (snapshot.status === "cancelled") {
      throw new ProviderError("CANCELLED", "The OpenAI response was cancelled remotely.", {});
    }
    if (snapshot.usage !== null) {
      accumulator.usage = snapshot.usage;
    } else {
      accumulator.warnings.push(
        "The API omitted usage for this response; token categories are reported as zero.",
      );
    }
  }

  /** Synthesizes the provider-neutral stream for a non-streamed response. */
  function replaySnapshot(
    context: OperationContext,
    accumulator: Accumulator,
    snapshot: OpenAiResponseSnapshot,
    emitEvent: (build: Parameters<OperationContext["controller"]["emit"]>[0]) => void,
  ): void {
    const structuredMode = context.request.structuredOutput !== null;
    const declaredTools = new Set(context.request.tools.map((tool) => tool.name as string));
    for (const item of snapshot.output) {
      if (item.type === "reasoning") {
        if (context.requestOptions.discloseReasoning && item.summaryText.length > 0) {
          for (const piece of chunkText(item.summaryText, MAX_EVENT_TEXT_CHUNK)) {
            emitEvent((base) => ({ ...base, kind: "reasoning-delta", payload: { text: piece } }));
          }
        }
        continue;
      }
      if (item.type === "function_call") {
        if (!declaredTools.has(item.name)) {
          throw toolProtocolError("undeclared-tool", { toolName: item.name });
        }
        emitEvent((base) => ({
          ...base,
          kind: "tool-call-started",
          payload: { toolCallId: item.callId, toolName: item.name },
        }));
        const invocation = buildInvocation(item.callId, item.name, item.argumentsText);
        accumulator.invocations.push(invocation);
        emitEvent((base) => ({ ...base, kind: "tool-call-completed", payload: { invocation } }));
        continue;
      }
      for (const part of item.content) {
        if (part.type === "refusal") {
          accumulator.refusalText += part.refusal;
          continue;
        }
        if (structuredMode) {
          accumulator.structuredText += part.text;
          for (const piece of chunkText(part.text, MAX_EVENT_TEXT_CHUNK)) {
            emitEvent((base) => ({
              ...base,
              kind: "structured-output-delta",
              payload: { textDelta: piece },
            }));
          }
        } else {
          accumulator.text += part.text;
          for (const piece of chunkText(part.text, MAX_EVENT_TEXT_CHUNK)) {
            emitEvent((base) => ({ ...base, kind: "text-delta", payload: { text: piece } }));
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Provider surface
  // -------------------------------------------------------------------------

  const provider: OpenAiInferenceProvider = {
    kind: "inference",

    describe(): ProviderDescriptor {
      return descriptor;
    },

    catalogSnapshot(): OpenAiModelCatalog {
      return configuration.catalog;
    },

    describeRetention(): OpenAiRetentionDisclosure {
      return retentionDisclosure;
    },

    /**
     * Local readiness only. A network probe would require resolving a
     * credential and would bill the account, so health() never issues an
     * API call; transport failures surface through operations instead.
     */
    async health(): Promise<ProviderHealth> {
      const at = scheduler.now();
      const offered = listCatalogModelIds(configuration.catalog, at.toISOString()).filter((modelId) =>
        configuration.permittedModels.includes(modelId),
      );
      return parseProviderHealth({
        status: closed ? "closed" : offered.length === 0 ? "degraded" : "ready",
        checkedAt: at.toISOString(),
        detailCode: closed ? null : offered.length === 0 ? "no-effective-models" : null,
        activeOperations: activeCancels.size,
      });
    },

    async listModels(): Promise<readonly ModelDescriptor[]> {
      if (closed) {
        throw providerClosedError();
      }
      const at = scheduler.now().toISOString();
      const descriptors: ModelDescriptor[] = [];
      for (const modelId of listCatalogModelIds(configuration.catalog, at)) {
        if (!configuration.permittedModels.includes(modelId)) {
          continue;
        }
        const entry = effectiveEntry(modelId, at);
        descriptors.push(
          Object.freeze({
            model: toModelCapabilities(OPENAI_PROVIDER_ID, entry, at),
            availability: "available" as const,
          }),
        );
      }
      safelyObserve(openAiObserver, {
        kind: "catalog",
        catalogVersion: configuration.catalog.catalogVersion,
        catalogFingerprint: configuration.catalog.fingerprint,
        offeredModelCount: descriptors.length,
      });
      return Object.freeze(descriptors);
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
          reason: error instanceof ValidationError ? (error.issues[0]?.code ?? "invalid") : "invalid",
        });
      }

      if (isDeadlineExpired(request.deadline, scheduler.now())) {
        throw new ProviderError(
          "DEADLINE_EXCEEDED",
          "The deadline passed before start.",
          {},
          { traceId: request.trace.traceId as string },
        );
      }

      if (!configuration.supportedClassifications.includes(request.disclosure.classification)) {
        throw policyDeniedError("classification-unsupported", {
          classification: request.disclosure.classification,
        });
      }
      if (request.disclosure.requiredLocality === "local-only") {
        throw policyDeniedError("local-only-classification-cannot-use-cloud-provider");
      }

      const at = scheduler.now().toISOString();
      const entry = effectiveEntry(request.modelId as string, at);
      const requestOptions = parseRequestExtensions(
        request.extensions,
        configuration,
        entry,
        request.maxOutputTokens,
      );

      // Content is validated BEFORE any artifact read, credential resolve,
      // or network access, so an unsupported request discloses nothing.
      const neededImages = collectImageArtifacts(request, entry);
      if (neededImages.length > 0 && options.artifacts === undefined) {
        throw unsupportedCapabilityError("artifact-resolver-unavailable");
      }

      if (requestOptions.background && configuration.background.mode === "disabled") {
        throw unsupportedCapabilityError("background-not-permitted");
      }

      const operationId = ids("operation") as ProviderOperationId;

      // Disclosure authorization precedes artifact resolution, credential
      // resolution, and every byte of network traffic.
      const authorization = await options.disclosure.authorize({
        providerInstanceId: configuration.instanceId,
        operationId: operationId as string,
        modelId: entry.modelId,
        disclosure: request.disclosure,
        trace: request.trace,
        requestsPersistence: requestOptions.store,
        requestsBackground: requestOptions.background,
        requestsArtifactDisclosure: neededImages.length > 0,
      });
      if (!authorization.allowed) {
        throw policyDeniedError(authorization.denialCode ?? "disclosure-denied");
      }
      if (requestOptions.store && !authorization.persistenceAllowed) {
        throw policyDeniedError("persistence-not-authorized");
      }
      if (requestOptions.background && !authorization.temporaryServerStateAllowed) {
        // Background mode always implies temporary server-side state, even
        // with store=false, so it needs its own authorization.
        throw policyDeniedError("temporary-server-state-not-authorized");
      }

      const resolvedImages = new Map<string, ResolvedImage>();
      for (const needed of neededImages) {
        const resolver = options.artifacts;
        if (resolver === undefined) {
          throw unsupportedCapabilityError("artifact-resolver-unavailable");
        }
        const resolved = await resolver.resolve({
          artifactId: needed.artifactId as never,
          mediaType: needed.mediaType,
          classification: request.disclosure.classification,
          trace: request.trace,
          maxBytes: configuration.limits.maxImageArtifactBytes,
        });
        if (resolved.bytes.byteLength > configuration.limits.maxImageArtifactBytes) {
          throw unsupportedCapabilityError("image-artifact-too-large", {
            maximum: configuration.limits.maxImageArtifactBytes,
          });
        }
        resolvedImages.set(needed.artifactId, {
          artifactId: needed.artifactId,
          dataUrl: toBase64DataUrl(resolved.mediaType, resolved.bytes),
        });
      }

      let safetyIdentifier: string | null = null;
      if (options.safetyIdentifier !== undefined) {
        safetyIdentifier = options.safetyIdentifier.identify({
          providerInstanceId: configuration.instanceId,
          trace: request.trace,
          classification: request.disclosure.classification,
        });
      } else if (configuration.safetyIdentifierRequired) {
        throw policyDeniedError("safety-identifier-required");
      }

      const streaming = !requestOptions.background || configuration.background.resumeStreamEnabled;
      const executionMode: OpenAiExecutionMode = !requestOptions.background
        ? "synchronous"
        : streaming
          ? "background-streaming"
          : "background";

      const body = buildResponsesRequest({
        request,
        configuration,
        entry,
        options: requestOptions,
        resolvedImages,
        safetyIdentifier,
        stream: streaming,
        previousResponseId: null,
      });

      const retention: OpenAiRetentionObservation = Object.freeze({
        storeRequested: requestOptions.store,
        temporaryServerStateUsed: requestOptions.background,
        temporaryStorageMs: requestOptions.background
          ? configuration.retention.backgroundTemporaryStorageMs
          : 0,
        zeroDataRetentionEnrolled: configuration.retention.zeroDataRetentionEnrolled,
      });

      safelyObserve(openAiObserver, {
        kind: "request",
        modelId: entry.modelId,
        executionMode,
        streaming,
        toolCount: request.tools.length,
        structuredOutput: request.structuredOutput !== null,
        reasoningRequested: requestOptions.reasoningEffort !== null,
        retention,
        safetyIdentifierPresent: safetyIdentifier !== null,
      });

      const abortFlag = createAbortFlag();
      if (startOptions.signal !== undefined) {
        if (startOptions.signal.aborted) {
          abortFlag.abort();
        } else {
          startOptions.signal.addEventListener("abort", () => abortFlag.abort(), { once: true });
        }
      }

      const credentialRequest = {
        providerInstanceId: configuration.instanceId,
        operationId: operationId as string,
        classification: request.disclosure.classification,
        trace: request.trace,
        deadline: request.deadline,
        disclosureDecisionFingerprint: authorization.decisionFingerprint,
        ...(abortFlag.signal === undefined ? {} : { signal: abortFlag.signal }),
      };

      const timeouts = requestTimeouts(streaming);

      // The credential is resolved immediately before the request and is
      // in scope only for the call that establishes the connection.
      let initial: OpenAiStreamResponse | OpenAiJsonResponse;
      try {
        initial = await options.credentials.withApiKey(credentialRequest, async (apiKey) =>
          streaming
            ? transport.requestStream("createResponse", body, {
                apiKey,
                ...timeouts,
                signal: abortFlag.signal,
              })
            : transport.requestJson("createResponse", body, {
                apiKey,
                ...timeouts,
                signal: abortFlag.signal,
              }),
        );
      } catch (error) {
        throw toProviderError(error);
      }

      safelyObserve(openAiObserver, {
        kind: "http",
        route: "createResponse",
        status: initial.status,
        requestId: initial.metadata.requestId,
        rateLimitRemaining: initial.metadata.rateLimit?.remaining ?? null,
        rateLimitResetMs: initial.metadata.rateLimit?.retryAfterMs ?? null,
        retryAfterMs: initial.metadata.retryAfterMs,
        serviceTier: initial.metadata.serviceTier,
        attempt: 1,
      });

      if (!initial.ok) {
        throw httpStatusError({
          status: initial.status,
          route: "createResponse",
          retryAfterMs: initial.metadata.retryAfterMs,
          rateLimit: initial.metadata.rateLimit,
          upstream: initial.upstreamError,
          // A create that failed after the server accepted it may have
          // produced a background response that is still running.
          operationMayStillBeRunning: requestOptions.background,
        });
      }

      const binding = computeBackgroundBinding({
        providerInstanceId: configuration.instanceId,
        requestId: request.requestId as string,
        modelId: entry.modelId,
        classification: request.disclosure.classification,
        policyDecisionFingerprint: authorization.decisionFingerprint,
      });

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
              providerId: OPENAI_PROVIDER_ID,
              instanceId: configuration.instanceId,
              modelId: entry.modelId,
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
        },
      });

      const context: OperationContext = {
        request,
        entry,
        requestOptions,
        controller,
        abortFlag,
        executionMode,
        retention,
        binding,
        body,
        startedAtMs: scheduler.now().valueOf(),
      };

      // The handle is shared by reference: in background STREAMING mode the
      // response id only becomes known once the first lifecycle event
      // arrives, and cancellation must still be able to reach it.
      const handleBox: BackgroundHandleBox = { current: null };
      if (requestOptions.background) {
        const snapshotSource =
          "value" in initial && initial.value !== null
            ? parseResponseSnapshot(initial.value, wireLimits)
            : null;
        if (snapshotSource !== null) {
          handleBox.current = createBackgroundHandle({
            responseId: snapshotSource.id,
            binding,
            expiresAt: new Date(
              scheduler.now().valueOf() + configuration.storage.continuationTtlMs,
            ).toISOString(),
          });
        }
      }

      let cancelIssued = false;

      controller.onCancel(() => {
        abortFlag.abort();
        if ("abort" in initial) {
          initial.abort();
        }
        const remote = handleBox.current;
        if (remote !== null && configuration.background.cancelRemoteOnAbort && !cancelIssued) {
          cancelIssued = true;
          void cancelRemote(remote, credentialRequest, binding).catch(() => undefined);
        }
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

      const running = runOperation(context, initial, handleBox, credentialRequest)
        .catch(() => undefined)
        .finally(() => {
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
      await Promise.allSettled([...pumps]);
      transport.close();
    },
  };

  // -------------------------------------------------------------------------
  // Operation driver
  // -------------------------------------------------------------------------

  async function cancelRemote(
    handle: BackgroundHandle,
    credentialRequest: Parameters<CredentialPort["withApiKey"]>[0],
    binding: string,
  ): Promise<OpenAiResponseSnapshot | null> {
    assertHandleUsable(handle, binding, scheduler.now());
    const response = await options.credentials.withApiKey(credentialRequest, async (apiKey) =>
      transport.requestJson("cancelResponse", null, {
        apiKey,
        timeoutMs: configuration.deadlines.cancellationTimeoutMs,
        connectTimeoutMs: configuration.deadlines.connectTimeoutMs,
        maxResponseBytes: configuration.limits.maxResponseBytes,
        maxErrorBodyBytes: configuration.limits.maxErrorBodyBytes,
        responseId: handle.responseId,
      }),
    );
    safelyObserve(openAiObserver, {
      kind: "background",
      phase: "cancelled",
      status: null,
      pollAttempt: 0,
      resumeAttempt: 0,
      cursor: handle.cursor,
      remoteMayStillRun: !response.ok,
    });
    if (!response.ok || response.value === null) {
      return null;
    }
    // Cancelling twice is documented as idempotent: a repeat call simply
    // returns the final response object.
    return parseResponseSnapshot(response.value, wireLimits);
  }

  async function runOperation(
    context: OperationContext,
    initial: OpenAiStreamResponse | OpenAiJsonResponse,
    handleBox: BackgroundHandleBox,
    credentialRequest: Parameters<CredentialPort["withApiKey"]>[0],
  ): Promise<void> {
    const { controller, request } = context;
    const accumulator = createAccumulator();
    firstEventOffset = null;

    const emitEvent = (build: Parameters<typeof controller.emit>[0]): void => {
      if (firstEventOffset === null) {
        firstEventOffset = Math.max(0, scheduler.now().valueOf() - context.startedAtMs);
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

    // Kept in the shared box so cancellation observes the same handle.
    let handle = handleBox.current;

    try {
      controller.emit((base) => ({
        ...base,
        kind: "operation-started",
        payload: { modelId: request.modelId as string },
      }));
      emitEvent((base) => ({ ...base, kind: "message-started", payload: { messageIndex: 0 } }));
      emitEvent((base) => ({
        ...base,
        kind: "usage-update",
        payload: { usage: providerUsageOf(ZERO_WIRE_USAGE, 0) },
      }));

      if ("chunks" in initial) {
        const guard = createSequenceGuard(null);
        let stream: OpenAiStreamResponse = initial;
        let requestedAfter: number | null = null;
        let resumeAttempt = 0;

        for (;;) {
          const outcome = await pumpStream(
            context,
            stream,
            accumulator,
            guard,
            emitEvent,
            requestedAfter,
          );
          if (controller.isTerminal) {
            return;
          }
          if (outcome.kind === "terminal") {
            break;
          }

          // The stream ended without a terminal response object. Only a
          // background response can be resumed: a synchronous stream has no
          // server-side state to reconnect to, so its truncation is final.
          //
          // In background streaming mode the response id arrives on the
          // lifecycle event rather than in a body, so the resume handle is
          // built here, bound to this operation's exact context.
          if (
            handle === null &&
            context.requestOptions.background &&
            accumulator.observedResponseId !== null
          ) {
            handle = createBackgroundHandle({
              responseId: accumulator.observedResponseId,
              binding: context.binding,
              expiresAt: new Date(
                scheduler.now().valueOf() + configuration.storage.continuationTtlMs,
              ).toISOString(),
            });
            handleBox.current = handle;
          }
          const current = handle;
          if (current === null) {
            throw operationMayStillRunError("NETWORK_FAILURE", "stream-truncated");
          }
          if (
            !configuration.background.resumeStreamEnabled ||
            resumeAttempt >= configuration.background.maxResumeAttempts
          ) {
            throw operationMayStillRunError("NETWORK_FAILURE", "stream-resume-exhausted", {
              resumeAttempts: resumeAttempt,
            });
          }
          resumeAttempt += 1;
          requestedAfter = outcome.cursor;
          handle = outcome.cursor === null ? current : advanceCursor(current, outcome.cursor);
          handleBox.current = handle;
          assertHandleUsable(handle, context.binding, scheduler.now());

          const delay = scheduler.delay(
            computeBackoffMs(
              {
                baseDelayMs: configuration.background.pollBaseDelayMs,
                maxDelayMs: configuration.background.pollMaxDelayMs,
                jitterRatio: configuration.background.pollJitterRatio,
              },
              resumeAttempt - 1,
              jitter,
            ),
          );
          await delay.promise;
          if (controller.isTerminal) {
            return;
          }

          safelyObserve(openAiObserver, {
            kind: "background",
            phase: "resumed",
            status: null,
            pollAttempt: 0,
            resumeAttempt,
            cursor: requestedAfter,
            remoteMayStillRun: true,
          });

          const resumeHandle = handle ?? current;
          stream = await options.credentials.withApiKey(credentialRequest, async (apiKey) =>
            transport.requestStream("streamResponse", null, {
              apiKey,
              ...requestTimeouts(true),
              signal: context.abortFlag.signal,
              responseId: resumeHandle.responseId,
              query: {
                stream: true,
                ...(requestedAfter === null ? {} : { startingAfter: requestedAfter }),
              },
            }),
          );
          if (!stream.ok) {
            throw httpStatusError({
              status: stream.status,
              route: "streamResponse",
              retryAfterMs: stream.metadata.retryAfterMs,
              rateLimit: stream.metadata.rateLimit,
              upstream: stream.upstreamError,
              operationMayStillBeRunning: true,
            });
          }
        }

        safelyObserve(openAiObserver, {
          kind: "stream",
          eventCount: guard.highest ?? 0,
          duplicateEventsDropped: guard.duplicatesDropped,
          informationalEventsIgnored: accumulator.informationalIgnored,
          highestSequence: guard.highest,
        });
      } else {
        // Background without streaming: poll to a terminal state.
        if (initial.value === null) {
          throw malformedResponseError("empty-create-response");
        }
        let snapshot = parseResponseSnapshot(initial.value, wireLimits);
        if (handle === null) {
          handle = createBackgroundHandle({
            responseId: snapshot.id,
            binding: context.binding,
            expiresAt: new Date(
              scheduler.now().valueOf() + configuration.storage.continuationTtlMs,
            ).toISOString(),
          });
          handleBox.current = handle;
        }
        safelyObserve(openAiObserver, {
          kind: "background",
          phase: "created",
          status: snapshot.status,
          pollAttempt: 0,
          resumeAttempt: 0,
          cursor: null,
          remoteMayStillRun: true,
        });

        let pollAttempt = 0;
        while (isActiveStatus(snapshot.status)) {
          if (controller.isTerminal) {
            return;
          }
          if (pollAttempt >= configuration.background.maxPollAttempts) {
            throw operationMayStillRunError("TIMEOUT", "background-poll-attempts-exhausted", {
              attempts: pollAttempt,
            });
          }
          if (isDeadlineExpired(request.deadline, scheduler.now())) {
            throw new ProviderError(
              "DEADLINE_EXCEEDED",
              "The operation deadline passed while polling a background response.",
              {},
              { operationId: controller.operation.operationId as string },
            );
          }
          const delay = scheduler.delay(
            computeBackoffMs(
              {
                baseDelayMs: configuration.background.pollBaseDelayMs,
                maxDelayMs: configuration.background.pollMaxDelayMs,
                jitterRatio: configuration.background.pollJitterRatio,
              },
              pollAttempt,
              jitter,
            ),
          );
          await delay.promise;
          if (controller.isTerminal) {
            return;
          }
          pollAttempt += 1;

          assertHandleUsable(handle, context.binding, scheduler.now());
          const pollHandle = handle;
          const polled = await options.credentials.withApiKey(credentialRequest, async (apiKey) =>
            transport.requestJson("getResponse", null, {
              apiKey,
              timeoutMs: configuration.deadlines.pollTimeoutMs,
              connectTimeoutMs: configuration.deadlines.connectTimeoutMs,
              maxResponseBytes: configuration.limits.maxResponseBytes,
              maxErrorBodyBytes: configuration.limits.maxErrorBodyBytes,
              signal: context.abortFlag.signal,
              responseId: pollHandle.responseId,
            }),
          );
          if (!polled.ok || polled.value === null) {
            throw httpStatusError({
              status: polled.status,
              route: "getResponse",
              retryAfterMs: polled.metadata.retryAfterMs,
              rateLimit: polled.metadata.rateLimit,
              upstream: polled.upstreamError,
              operationMayStillBeRunning: true,
            });
          }
          snapshot = parseResponseSnapshot(polled.value, wireLimits);
          safelyObserve(openAiObserver, {
            kind: "background",
            phase: "polled",
            status: snapshot.status,
            pollAttempt,
            resumeAttempt: 0,
            cursor: null,
            remoteMayStillRun: isActiveStatus(snapshot.status),
          });
        }

        if (!isTerminalStatus(snapshot.status)) {
          throw protocolViolationError("non-terminal-background-status", { status: snapshot.status });
        }
        accumulator.terminalSnapshot = snapshot;
        replaySnapshot(context, accumulator, snapshot, emitEvent);
      }

      const terminal = accumulator.terminalSnapshot;
      if (terminal === null) {
        throw malformedResponseError("missing-terminal-response");
      }
      reconcileTerminal(accumulator, terminal);

      emitEvent((base) => ({
        ...base,
        kind: "usage-update",
        payload: { usage: providerUsageOf(accumulator.usage, accumulator.invocations.length) },
      }));

      const { result, cost } = buildResult(context, accumulator, terminal);

      if (request.structuredOutput !== null && result.structuredOutput !== null) {
        const value = result.structuredOutput;
        emitEvent((base) => ({
          ...base,
          kind: "structured-output-completed",
          payload: { value },
        }));
      }
      emitEvent((base) => ({ ...base, kind: "message-completed", payload: { messageIndex: 0 } }));

      controller.complete((base) => ({ ...base, kind: "operation-completed", payload: {} }), result);

      safelyObserve(openAiObserver, {
        kind: "operation",
        modelId: context.entry.modelId,
        outcome: "succeeded",
        errorCode: null,
        executionMode: context.executionMode,
        inputTokens: accumulator.usage.inputTokens,
        cachedInputTokens: accumulator.usage.cachedTokens,
        cacheWriteTokens: accumulator.usage.cacheWriteTokens,
        outputTokens: accumulator.usage.outputTokens,
        reasoningTokens: accumulator.usage.reasoningTokens,
        toolCalls: accumulator.invocations.length,
        costMicros: cost.money?.amountMicros ?? null,
        costCurrency: cost.money?.currency ?? null,
        pricingSource: cost.pricingSource,
        totalMs: result.latency.totalMs,
      });
    } catch (error) {
      if ("abort" in initial) {
        initial.abort();
      }
      if (controller.isTerminal) {
        return;
      }
      const wrapped = toProviderError(error);
      failOperation(wrapped);
      safelyObserve(openAiObserver, {
        kind: "operation",
        modelId: context.entry.modelId,
        outcome: "failed",
        errorCode: wrapped.code,
        executionMode: context.executionMode,
        inputTokens: accumulator.usage.inputTokens,
        cachedInputTokens: accumulator.usage.cachedTokens,
        cacheWriteTokens: accumulator.usage.cacheWriteTokens,
        outputTokens: accumulator.usage.outputTokens,
        reasoningTokens: accumulator.usage.reasoningTokens,
        toolCalls: accumulator.invocations.length,
        costMicros: null,
        costCurrency: null,
        pricingSource: null,
        totalMs: Math.max(0, scheduler.now().valueOf() - context.startedAtMs),
      });
    }
  }

  return provider;
}

export type { OpenAiObservation };
export { UNKNOWN_COMPUTED_COST };
