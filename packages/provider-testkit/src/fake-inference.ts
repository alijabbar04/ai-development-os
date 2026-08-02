import {
  estimateModelCost,
  toCanonicalJson,
  ValidationError,
  type JsonValue,
  type ModelCapabilities,
} from "@ai-dev-os/domain";
import {
  ProviderError,
  UNKNOWN_COST,
  createOperationController,
  isDeadlineExpired,
  parseInferenceRequest,
  parseProviderDescriptor,
  parseProviderHealth,
  toProviderError,
  totalOfUsage,
  type CancellationReason,
  type FinishReason,
  type InferenceEvent,
  type InferenceOperation,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
  type ModelDescriptor,
  type ProviderDescriptor,
  type ProviderErrorCode,
  type ProviderObserver,
  type ProviderOperationId,
  type ProviderUsage,
  type StartOperationOptions,
  type ContentPart,
  type ToolInvocation,
} from "@ai-dev-os/providers";
import { createImmediateScheduler, createSequentialIds, type ManualScheduler } from "./scheduler.js";
import { DEFAULT_FAKE_MODEL } from "./fixtures.js";

export type InferenceScriptStep =
  | { readonly kind: "text"; readonly text: string; readonly chunkSize?: number }
  | { readonly kind: "structured"; readonly value: JsonValue }
  | {
      readonly kind: "tool-call";
      readonly toolName: string;
      readonly toolCallId?: string;
      readonly arguments: JsonValue;
      readonly argumentDeltas?: number;
    }
  | { readonly kind: "usage"; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly kind: "warning"; readonly message: string }
  | { readonly kind: "delay"; readonly ms: number }
  | {
      readonly kind: "fail";
      readonly code: ProviderErrorCode;
      readonly message?: string;
      readonly retryAfterMs?: number;
    }
  | { readonly kind: "finish"; readonly finishReason?: FinishReason };

/**
 * Immutable script describing exactly what the fake emits. Scripts are
 * plain data: reusing one across providers or runs shares no mutable state,
 * and identical scripts with identically seeded schedulers replay
 * identically (deterministic ids, sequences, and timestamps).
 */
export interface InferenceScript {
  readonly steps: readonly InferenceScriptStep[];
  /** Reject start() with this error before any operation exists. */
  readonly rejectStart?: {
    readonly code: ProviderErrorCode;
    readonly retryAfterMs?: number;
  };
  /**
   * Contract-negative mode: emit these RAW events verbatim (bypassing all
   * invariant machinery) and settle the result per `rawResult`. Used to
   * prove that guardProviderOperation catches misbehaving transports.
   */
  readonly rawStream?: {
    readonly events: readonly unknown[];
    readonly rawResult: "resolve-empty" | "reject";
  };
}

export interface FakeInferenceProviderOptions {
  readonly script: InferenceScript | ((request: InferenceRequest) => InferenceScript);
  readonly scheduler?: ManualScheduler;
  readonly models?: readonly ModelCapabilities[];
  readonly descriptor?: Partial<
    Pick<
      ProviderDescriptor,
      "providerId" | "instanceId" | "locality" | "retainsData" | "trainsOnInputs" | "supportedClassifications"
    >
  > & { readonly capabilities?: Partial<ProviderDescriptor["capabilities"]> };
  readonly observer?: ProviderObserver;
  /** Extension namespaces this fake understands; others are rejected. */
  readonly acceptedExtensionNamespaces?: readonly string[];
}

export interface FakeInferenceProvider extends InferenceProvider {
  /** Frozen validated copies of every request that reached the provider. */
  readonly capturedRequests: readonly InferenceRequest[];
  /** Secret-safe request summaries (no message or tool content). */
  capturedSummaries(): readonly {
    readonly requestId: string;
    readonly modelId: string;
    readonly classification: string;
    readonly messageCount: number;
  }[];
}

export function createFakeInferenceProvider(
  options: FakeInferenceProviderOptions,
): FakeInferenceProvider {
  const scheduler = options.scheduler ?? createImmediateScheduler();
  const models = options.models ?? [DEFAULT_FAKE_MODEL];
  const nextOperationId = createSequentialIds("op");
  const acceptedNamespaces = new Set(options.acceptedExtensionNamespaces ?? ["fake"]);
  const captured: InferenceRequest[] = [];
  const activeCancels: Array<(reason: CancellationReason) => Promise<void>> = [];
  const pumps = new Set<Promise<void>>();
  let closed = false;

  const descriptor = parseProviderDescriptor({
    schemaVersion: 1,
    providerId: options.descriptor?.providerId ?? "fake-inference",
    instanceId: options.descriptor?.instanceId ?? "fake-inference-1",
    kind: "inference",
    displayName: "Deterministic fake inference provider",
    locality: options.descriptor?.locality ?? "cloud",
    retainsData: options.descriptor?.retainsData ?? false,
    trainsOnInputs: options.descriptor?.trainsOnInputs ?? false,
    supportedClassifications: options.descriptor?.supportedClassifications ?? ["public", "internal"],
    capabilities: {
      streaming: true,
      structuredOutput: true,
      toolCalling: true,
      imageInput: false,
      repositoryEditing: false,
      commandExecution: false,
      networkAccess: false,
      resumability: false,
      cancellation: "guaranteed",
      deadlineEnforcement: true,
      usageReporting: true,
      pricingAvailable: true,
      ...options.descriptor?.capabilities,
    },
  });

  function validateAgainstProvider(request: InferenceRequest): void {
    if (!descriptor.supportedClassifications.includes(request.disclosure.classification)) {
      throw new ProviderError(
        "POLICY_DENIED",
        "The provider does not accept this data classification.",
        { classification: request.disclosure.classification },
      );
    }
    if (request.disclosure.requiredLocality === "local-only" && descriptor.locality !== "local") {
      throw new ProviderError("POLICY_DENIED", "The request requires local execution.", {});
    }
    if (request.tools.length > 0 && !descriptor.capabilities.toolCalling) {
      throw new ProviderError("UNSUPPORTED_CAPABILITY", "Tool calling is not supported.", {});
    }
    if (request.structuredOutput !== null && !descriptor.capabilities.structuredOutput) {
      throw new ProviderError("UNSUPPORTED_CAPABILITY", "Structured output is not supported.", {});
    }
    const hasImages = request.messages.some((message) =>
      message.parts.some((part) => part.type === "image-artifact"),
    );
    if (hasImages && !descriptor.capabilities.imageInput) {
      throw new ProviderError("UNSUPPORTED_CAPABILITY", "Image input is not supported.", {});
    }
    for (const extension of request.extensions) {
      if (!acceptedNamespaces.has(extension.namespace)) {
        throw new ProviderError("UNSUPPORTED_CAPABILITY", "Unknown extension namespace.", {
          namespace: extension.namespace,
        });
      }
    }
    if (models.length > 0 && !models.some((model) => model.modelId === request.modelId)) {
      throw new ProviderError("MODEL_UNAVAILABLE", "The requested model is not offered.", {
        modelId: request.modelId,
      });
    }
  }

  function chunked(text: string, chunkSize: number): readonly string[] {
    if (text.length === 0) {
      return [""];
    }
    const chunks: string[] = [];
    for (let index = 0; index < text.length; index += chunkSize) {
      chunks.push(text.slice(index, index + chunkSize));
    }
    return chunks;
  }

  function rawOperation(
    operationId: ProviderOperationId,
    script: NonNullable<InferenceScript["rawStream"]>,
  ): InferenceOperation {
    let consumed = false;
    const result: Promise<InferenceResult> =
      script.rawResult === "reject"
        ? Promise.reject(new ProviderError("INTERNAL_FAILURE", "The provider misbehaved.", {}))
        : Promise.resolve({} as InferenceResult);
    result.catch(() => undefined);
    return {
      operationId,
      events(): AsyncIterable<InferenceEvent> {
        if (consumed) {
          throw new ProviderError("PROTOCOL_VIOLATION", "The event stream is single-use.", {});
        }
        consumed = true;
        return (async function* stream(): AsyncIterable<InferenceEvent> {
          for (const event of script.events) {
            yield event as InferenceEvent;
          }
        })();
      },
      result,
      cancel: async () => undefined,
    };
  }

  async function pump(
    request: InferenceRequest,
    script: InferenceScript,
    controller: ReturnType<
      typeof createOperationController<InferenceEvent, InferenceResult>
    >,
  ): Promise<void> {
    const startedAtMs = scheduler.now().valueOf();
    let firstEventMs: number | null = 0;
    const textPieces: string[] = [];
    const toolParts: ContentPart[] = [];
    let structuredValue: JsonValue | null = null;
    let usage: ProviderUsage = {
      tokens: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
      toolCalls: 0,
    };
    let toolCallCounter = 0;
    let messageStarted = false;
    let finishReason: FinishReason | null = null;

    const emit = (build: Parameters<(typeof controller)["emit"]>[0]): void => {
      if (firstEventMs === null) {
        firstEventMs = scheduler.now().valueOf() - startedAtMs;
      }
      controller.emit(build);
    };
    const startMessage = (): void => {
      if (!messageStarted) {
        messageStarted = true;
        emit((base) => ({ ...base, kind: "message-started", payload: { messageIndex: 0 } }));
      }
    };
    const deadlineExpired = (): boolean =>
      isDeadlineExpired(request.deadline, scheduler.now());
    let cancelWake!: () => void;
    const cancelledSignal = new Promise<void>((resolve) => {
      cancelWake = resolve;
    });
    controller.onCancel(() => cancelWake());

    try {
      controller.emit((base) => ({
        ...base,
        kind: "operation-started",
        payload: { modelId: request.modelId },
      }));

      for (const step of script.steps) {
        if (controller.isTerminal) {
          return;
        }
        if (deadlineExpired()) {
          break;
        }
        switch (step.kind) {
          case "delay":
            // Cancellation must wake a paused pump: manual-scheduler waits
            // only fire when tests advance virtual time.
            await Promise.race([scheduler.wait(step.ms), cancelledSignal]);
            break;
          case "text": {
            startMessage();
            for (const piece of chunked(step.text, step.chunkSize ?? Math.max(1, step.text.length))) {
              if (controller.isTerminal) {
                return;
              }
              textPieces.push(piece);
              emit((base) => ({ ...base, kind: "text-delta", payload: { text: piece } }));
            }
            break;
          }
          case "structured": {
            startMessage();
            structuredValue = step.value;
            const text = toCanonicalJson(step.value);
            const half = Math.max(1, Math.ceil(text.length / 2));
            emit((base) => ({
              ...base,
              kind: "structured-output-delta",
              payload: { textDelta: text.slice(0, half) },
            }));
            emit((base) => ({
              ...base,
              kind: "structured-output-delta",
              payload: { textDelta: text.slice(half) },
            }));
            emit((base) => ({
              ...base,
              kind: "structured-output-completed",
              payload: { value: step.value },
            }));
            break;
          }
          case "tool-call": {
            startMessage();
            toolCallCounter += 1;
            const toolCallId = step.toolCallId ?? `call-${toolCallCounter}`;
            emit((base) => ({
              ...base,
              kind: "tool-call-started",
              payload: { toolCallId, toolName: step.toolName },
            }));
            const argumentText = toCanonicalJson(step.arguments);
            for (const piece of chunked(
              argumentText,
              Math.max(1, Math.ceil(argumentText.length / (step.argumentDeltas ?? 1))),
            )) {
              emit((base) => ({
                ...base,
                kind: "tool-call-delta",
                payload: { toolCallId, argumentsDelta: piece },
              }));
            }
            const invocation = {
              toolCallId,
              toolName: step.toolName,
              arguments: step.arguments,
            } as ToolInvocation;
            toolParts.push({ type: "tool-invocation", invocation } as ContentPart);
            usage = { ...usage, toolCalls: usage.toolCalls + 1 };
            emit((base) => ({
              ...base,
              kind: "tool-call-completed",
              payload: { invocation },
            }));
            break;
          }
          case "usage": {
            usage = {
              tokens: {
                inputTokens: step.inputTokens,
                outputTokens: step.outputTokens,
                cachedInputTokens: 0,
                reasoningTokens: 0,
              },
              toolCalls: usage.toolCalls,
            };
            emit((base) => ({ ...base, kind: "usage-update", payload: { usage } }));
            break;
          }
          case "warning":
            emit((base) => ({ ...base, kind: "warning", payload: { message: step.message } }));
            break;
          case "fail":
            controller.fail(
              (base) => ({
                ...base,
                kind: "operation-failed",
                payload: {
                  code: step.code,
                  message: step.message ?? "The provider failed as scripted.",
                  retryStrategy: new ProviderError(step.code, "x").retry.strategy,
                },
              }),
              new ProviderError(
                step.code,
                step.message ?? "The provider failed as scripted.",
                {},
                {
                  retryAfterMs: step.retryAfterMs ?? null,
                  operationId: controller.operation.operationId,
                  traceId: request.trace.traceId,
                },
              ),
            );
            return;
          case "finish":
            finishReason = step.finishReason ?? null;
            break;
        }
      }

      if (controller.isTerminal) {
        return;
      }
      if (deadlineExpired()) {
        const error = new ProviderError("DEADLINE_EXCEEDED", "The operation deadline passed.", {}, {
          operationId: controller.operation.operationId,
          traceId: request.trace.traceId,
        });
        controller.fail(
          (base) => ({
            ...base,
            kind: "operation-failed",
            payload: {
              code: error.code,
              message: error.message,
              retryStrategy: error.retry.strategy,
            },
          }),
          error,
        );
        return;
      }

      if (messageStarted) {
        emit((base) => ({ ...base, kind: "message-completed", payload: { messageIndex: 0 } }));
      }
      if (totalOfUsage(usage) === 0) {
        usage = {
          tokens: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0 },
          toolCalls: usage.toolCalls,
        };
      }

      const model = models.find((candidate) => candidate.modelId === request.modelId);
      const cost =
        model !== undefined && model.cost !== null
          ? { providerReported: null, locallyComputed: estimateModelCost(model, usage.tokens) }
          : UNKNOWN_COST;
      const parts: ContentPart[] = [];
      const text = textPieces.join("");
      if (text.length > 0) {
        parts.push({ type: "text", text });
      }
      parts.push(...toolParts);

      const result: InferenceResult = Object.freeze({
        schemaVersion: 1,
        operationId: controller.operation.operationId,
        requestId: request.requestId,
        modelId: request.modelId,
        messages:
          parts.length > 0
            ? Object.freeze([Object.freeze({ role: "assistant" as const, parts: Object.freeze(parts) })])
            : Object.freeze([]),
        structuredOutput: structuredValue,
        finishReason: finishReason ?? (toolParts.length > 0 ? "tool-calls" : "stop"),
        refusalMessage: null,
        usage,
        cost,
        latency: Object.freeze({
          firstEventMs,
          totalMs: Math.max(firstEventMs ?? 0, scheduler.now().valueOf() - startedAtMs),
        }),
        warnings: Object.freeze([]),
      });
      controller.complete(
        (base) => ({ ...base, kind: "operation-completed", payload: {} }),
        result,
      );
    } catch (error) {
      if (!controller.isTerminal) {
        const wrapped = toProviderError(error);
        controller.fail(
          (base) => ({
            ...base,
            kind: "operation-failed",
            payload: {
              code: wrapped.code,
              message: wrapped.message,
              retryStrategy: wrapped.retry.strategy,
            },
          }),
          wrapped,
        );
      }
    }
  }

  return {
    kind: "inference",
    capturedRequests: captured,
    capturedSummaries() {
      return Object.freeze(
        captured.map((request) =>
          Object.freeze({
            requestId: request.requestId as string,
            modelId: request.modelId as string,
            classification: request.disclosure.classification,
            messageCount: request.messages.length,
          }),
        ),
      );
    },
    describe: () => descriptor,
    async health() {
      return parseProviderHealth({
        status: closed ? "closed" : "ready",
        checkedAt: scheduler.now().toISOString(),
        detailCode: null,
        activeOperations: pumps.size,
      });
    },
    async listModels(): Promise<readonly ModelDescriptor[]> {
      return Object.freeze(
        models.map((model) => Object.freeze({ model, availability: "available" as const })),
      );
    },
    async start(
      rawRequest: InferenceRequest,
      startOptions: StartOperationOptions = {},
    ): Promise<InferenceOperation> {
      if (closed) {
        throw new ProviderError("PROVIDER_CLOSED", "The provider is closed.", {});
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
      validateAgainstProvider(request);
      const script =
        typeof options.script === "function" ? options.script(request) : options.script;
      if (script.rejectStart !== undefined) {
        throw new ProviderError(
          script.rejectStart.code,
          "The provider rejected the request as scripted.",
          {},
          { retryAfterMs: script.rejectStart.retryAfterMs ?? null, traceId: request.trace.traceId },
        );
      }
      if (isDeadlineExpired(request.deadline, scheduler.now())) {
        throw new ProviderError("DEADLINE_EXCEEDED", "The deadline passed before start.", {}, {
          traceId: request.trace.traceId,
        });
      }
      captured.push(request);

      const operationId = nextOperationId() as ProviderOperationId;
      if (script.rawStream !== undefined) {
        return rawOperation(operationId, script.rawStream);
      }

      const controller = createOperationController<InferenceEvent, InferenceResult>({
        operationId,
        clock: scheduler,
        trace: request.trace,
        buildCancelledEvent: (base, reason) => ({
          ...base,
          kind: "operation-cancelled",
          payload: { reason },
        }),
        onTerminal: (outcome) => {
          options.observer?.(
            Object.freeze({
              providerKind: "inference",
              providerId: descriptor.providerId as string,
              instanceId: descriptor.instanceId as string,
              modelId: request.modelId as string,
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

      if (startOptions.signal !== undefined) {
        if (startOptions.signal.aborted) {
          await controller.operation.cancel("caller-aborted");
        } else {
          startOptions.signal.addEventListener(
            "abort",
            () => {
              void controller.operation.cancel("caller-aborted");
            },
            { once: true },
          );
        }
      }

      activeCancels.push((reason) => controller.operation.cancel(reason));
      const running = pump(request, script, controller).finally(() => {
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
      for (const cancel of activeCancels.splice(0, activeCancels.length)) {
        await cancel("provider-closed");
      }
      await Promise.allSettled([...pumps]);
    },
  };
}
