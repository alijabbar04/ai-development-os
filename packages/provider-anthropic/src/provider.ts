import { createHash } from "node:crypto";
import {
  canonicalizeJson,
  createTokenUsage,
  toCanonicalJson,
  totalTokens,
  type JsonValue,
} from "@ai-dev-os/domain";
import {
  ProviderError,
  UNKNOWN_COST,
  createOperationController,
  createRetryDisposition,
  isDeadlineExpired,
  parseInferenceEvent,
  parseInferenceRequest,
  parseInferenceResult,
  parseModelDescriptor,
  parseProviderDescriptor,
  parseProviderHealth,
  parseProviderOperationId,
  parseProviderUsage,
  systemClock,
  type Clock,
  type InferenceEvent,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
  type ModelDescriptor,
  type OperationController,
  type ProviderDescriptor,
  type ProviderErrorCode,
  type ProviderEventBase,
  type ProviderOperation,
  type ProviderUsage,
  type StartOperationOptions,
} from "@ai-dev-os/providers";
import { parseAnthropicAdapterConfiguration } from "./config.js";
import {
  ANTHROPIC_TRANSPORT_FAILURE_KINDS,
  ANTHROPIC_ADAPTER_SCHEMA_VERSION,
  ANTHROPIC_PRODUCTION_ENABLED,
  ANTHROPIC_PROVIDER_ID,
  AnthropicTransportFailure,
  type AnthropicAdapterConfiguration,
  type AnthropicTestingPorts,
  type AnthropicTimerHandle,
  type AnthropicTransportFailureKind,
} from "./contracts.js";
import {
  buildAnthropicRequestBody,
  parseAnthropicWireEvent,
  type AnthropicWireEvent,
  type AnthropicWireUsage,
} from "./wire.js";
import {
  assertStructuredOutputMatchesSchema,
  assertStructuredSchemaWellFormed,
} from "./structured-schema.js";

interface ActiveOperation {
  readonly controller: OperationController<InferenceEvent, InferenceResult>;
  readonly abort: AbortController;
  readonly timer: AnthropicTimerHandle;
}

type PreflightStopCode = "CANCELLED" | "DEADLINE_EXCEEDED" | "TIMEOUT" | "PROVIDER_CLOSED";

interface PendingPreflight {
  readonly abortWith: (code: PreflightStopCode) => void;
  readonly timer: AnthropicTimerHandle;
  readonly settled: Promise<void>;
}

class PreflightAborted extends Error {
  constructor() {
    super("Anthropic preflight aborted.");
    this.name = "PreflightAborted";
  }
}

interface RawUsageState {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  thinkingTokens: number | null;
  toolCalls: number;
}

type OpenBlock =
  | { readonly type: "text"; text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly initialInput: JsonValue;
      partialJson: string;
    };

interface InternalProviderOptions {
  readonly configuration: AnthropicAdapterConfiguration;
  readonly executionMode: "disabled" | "deterministic-fake";
  readonly ports?: AnthropicTestingPorts;
  readonly clock?: Clock;
}

function event(
  base: Omit<ProviderEventBase, never>,
  kind: InferenceEvent["kind"],
  payload: unknown,
): InferenceEvent {
  return parseInferenceEvent({ ...base, kind, payload });
}

function safeElapsed(clock: Clock, startedMs: number): number {
  return Math.max(0, Math.round(clock.now().valueOf() - startedMs));
}

function signalAborted(signal: StartOperationOptions["signal"]): boolean {
  return signal?.aborted === true;
}

function raceWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new PreflightAborted());
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new PreflightAborted()), { once: true });
  });
  return Promise.race([work, aborted]);
}

function wireBytes(value: unknown): number {
  return Buffer.byteLength(toCanonicalJson(canonicalizeJson(value, "anthropicWireEvent")), "utf8");
}

function mapFailureKind(kind: AnthropicTransportFailureKind | string): ProviderErrorCode {
  switch (kind) {
    case "invalid_request_error": return "INVALID_REQUEST";
    case "authentication_error": return "AUTHENTICATION_FAILED";
    case "permission_error": return "AUTHORIZATION_FAILED";
    case "not_found_error": return "MODEL_UNAVAILABLE";
    case "request_too_large": return "INVALID_REQUEST";
    case "rate_limit_error": return "RATE_LIMITED";
    case "api_error": return "NETWORK_FAILURE";
    case "timeout_error": return "TIMEOUT";
    case "overloaded_error": return "PROVIDER_OVERLOADED";
    case "connection_error": return "NETWORK_FAILURE";
    default: return "PROTOCOL_VIOLATION";
  }
}

function mapTransportError(error: unknown, operationId?: string, traceId?: string): ProviderError {
  if (error instanceof ProviderError) {
    return new ProviderError(
      error.code,
      "The Anthropic boundary returned a redacted provider classification.",
      {},
      {
        retry: error.retry,
        retryAfterMs: error.retryAfterMs,
        operationId: operationId ?? null,
        traceId: traceId ?? null,
        causeCategory: "provider-port",
      },
    );
  }
  if (error instanceof AnthropicTransportFailure) {
    const transportKind = typeof error.kind === "string" &&
      ANTHROPIC_TRANSPORT_FAILURE_KINDS.includes(error.kind as AnthropicTransportFailureKind)
      ? error.kind as AnthropicTransportFailureKind
      : null;
    const code = transportKind === null ? "PROTOCOL_VIOLATION" : mapFailureKind(transportKind);
    const status = Number.isSafeInteger(error.status) && (error.status ?? 0) >= 100 && (error.status ?? 0) <= 599
      ? error.status
      : null;
    const retryAfterMs = Number.isSafeInteger(error.retryAfterMs) &&
      (error.retryAfterMs ?? -1) >= 0 && (error.retryAfterMs ?? Infinity) <= 86_400_000
      ? error.retryAfterMs
      : null;
    const retry = code === "RATE_LIMITED" || code === "PROVIDER_OVERLOADED"
      ? createRetryDisposition({
          strategy: "same-after-delay",
          minimumDelayMs: retryAfterMs ?? 1_000,
          retryAfterMs,
          requestReusable: true,
        })
      : undefined;
    return new ProviderError(
      code,
      "The Anthropic request failed with a redacted transport classification.",
      { transportKind: transportKind ?? "unknown", status },
      {
        ...(retry === undefined ? {} : { retry }),
        retryAfterMs,
        operationId: operationId ?? null,
        traceId: traceId ?? null,
        causeCategory: transportKind ?? "transport",
      },
    );
  }
  return new ProviderError(
    "NETWORK_FAILURE",
    "The injected Anthropic transport failed without a safe classification.",
    { transportKind: "unknown" },
    { operationId: operationId ?? null, traceId: traceId ?? null, causeCategory: "transport" },
  );
}

function validateAuthorizationDecision(value: unknown): {
  readonly allowed: boolean;
  readonly code: string;
  readonly decisionFingerprint: string | null;
  readonly retentionAllowed: boolean;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderError("POLICY_DENIED", "Anthropic policy returned an invalid decision.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join("|") !== "allowed|code|decisionFingerprint|retentionAllowed" ||
      typeof record["allowed"] !== "boolean" ||
      typeof record["retentionAllowed"] !== "boolean" ||
      typeof record["code"] !== "string" ||
      !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(record["code"]) ||
      !(record["decisionFingerprint"] === null ||
        typeof record["decisionFingerprint"] === "string" && /^[a-f0-9]{64}$/.test(record["decisionFingerprint"]))) {
    throw new ProviderError("POLICY_DENIED", "Anthropic policy returned an invalid decision.");
  }
  return Object.freeze({
    allowed: record["allowed"],
    code: record["code"],
    decisionFingerprint: record["decisionFingerprint"] as string | null,
    retentionAllowed: record["retentionAllowed"],
  });
}

function applyWireUsage(state: RawUsageState, update: AnthropicWireUsage): ProviderUsage {
  const monotonic = (current: number | null, next: number | null, field: string): number | null => {
    if (next === null) return current;
    if (current !== null && next < current) {
      throw new ProviderError("PROTOCOL_VIOLATION", "Anthropic usage moved backwards.", { field });
    }
    return next;
  };
  state.inputTokens = monotonic(state.inputTokens, update.inputTokens, "input_tokens");
  state.outputTokens = monotonic(state.outputTokens, update.outputTokens, "output_tokens");
  state.cacheCreationInputTokens = monotonic(
    state.cacheCreationInputTokens,
    update.cacheCreationInputTokens,
    "cache_creation_input_tokens",
  );
  state.cacheReadInputTokens = monotonic(
    state.cacheReadInputTokens,
    update.cacheReadInputTokens,
    "cache_read_input_tokens",
  );
  state.thinkingTokens = monotonic(state.thinkingTokens, update.thinkingTokens, "thinking_tokens");
  const output = state.outputTokens ?? 0;
  const thinking = state.thinkingTokens ?? 0;
  if (thinking > output) {
    throw new ProviderError("PROTOCOL_VIOLATION", "Anthropic thinking usage exceeds total output usage.");
  }
  return parseProviderUsage({
    tokens: createTokenUsage({
      inputTokens: (state.inputTokens ?? 0) + (state.cacheCreationInputTokens ?? 0),
      cachedInputTokens: state.cacheReadInputTokens ?? 0,
      outputTokens: output - thinking,
      reasoningTokens: thinking,
    }),
    toolCalls: state.toolCalls,
  });
}

function finishReason(value: string): InferenceResult["finishReason"] {
  switch (value) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "tool_use":
      return "tool-calls";
    case "refusal":
      return "refusal";
    default:
      throw new ProviderError("PROTOCOL_VIOLATION", "Anthropic returned an unsupported stop reason.", {
        stopReason: "unknown",
      });
  }
}

function assertRequestEligible(
  request: InferenceRequest,
  configuration: AnthropicAdapterConfiguration,
): void {
  if (request.modelId !== configuration.model.alias) {
    throw new ProviderError("MODEL_UNAVAILABLE", "The request did not select the configured Anthropic model alias.", {
      modelAlias: request.modelId,
    });
  }
  if (!configuration.supportedClassifications.includes(request.disclosure.classification)) {
    throw new ProviderError("POLICY_DENIED", "The Anthropic profile does not support this data classification.", {
      classification: request.disclosure.classification,
    });
  }
  if (request.disclosure.requiredLocality === "local-only") {
    throw new ProviderError("POLICY_DENIED", "A local-only disclosure cannot use the cloud Anthropic profile.");
  }
  if (!request.disclosure.retentionAllowed && configuration.retention.mode !== "contracted-zero") {
    throw new ProviderError("POLICY_DENIED", "The request forbids retention but this profile has standard retention.", {
      retentionMode: configuration.retention.mode,
    });
  }
  if (request.tools.length > 0 && !configuration.model.capabilities.supportsToolUse) {
    throw new ProviderError("UNSUPPORTED_CAPABILITY", "The configured model does not support tool use.");
  }
  if (request.structuredOutput !== null && !configuration.model.capabilities.supportsStructuredOutput) {
    throw new ProviderError("UNSUPPORTED_CAPABILITY", "The configured model does not support structured output.");
  }
  if (request.structuredOutput !== null) {
    assertStructuredSchemaWellFormed(request.structuredOutput.schema);
  }
  if ((request.maxOutputTokens ?? configuration.model.capabilities.maxOutputTokens) > configuration.model.capabilities.maxOutputTokens) {
    throw new ProviderError("UNSUPPORTED_CAPABILITY", "The request exceeds the configured model output-token limit.");
  }
}

function descriptor(configuration: AnthropicAdapterConfiguration): ProviderDescriptor {
  return parseProviderDescriptor({
    schemaVersion: 1,
    providerId: ANTHROPIC_PROVIDER_ID,
    instanceId: configuration.instanceId,
    kind: "inference",
    displayName: "Anthropic Messages (production-disabled)",
    locality: "cloud",
    retainsData: configuration.retention.mode !== "contracted-zero",
    trainsOnInputs: configuration.retention.trainsOnInputs,
    supportedClassifications: configuration.supportedClassifications,
    capabilities: {
      streaming: true,
      structuredOutput: configuration.model.capabilities.supportsStructuredOutput,
      toolCalling: configuration.model.capabilities.supportsToolUse,
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
}

function modelDescriptor(configuration: AnthropicAdapterConfiguration, enabled: boolean): ModelDescriptor {
  return parseModelDescriptor({
    model: configuration.model.capabilities,
    availability: enabled ? "available" : "unavailable",
  });
}

export function createAnthropicProviderInternal(options: InternalProviderOptions): InferenceProvider {
  const configuration = parseAnthropicAdapterConfiguration(options.configuration);
  const enabled = options.executionMode === "deterministic-fake";
  if (enabled && (options.ports?.transport.kind !== "deterministic-fake" || options.ports === undefined)) {
    throw new ProviderError("POLICY_DENIED", "Testing execution requires every deterministic fake port.");
  }
  const ports = options.ports;
  const clock = ports?.clock ?? options.clock ?? systemClock;
  const providerDescriptor = descriptor(configuration);
  const models = Object.freeze([modelDescriptor(configuration, enabled)]);
  const active = new Map<string, ActiveOperation>();
  const pending = new Map<string, PendingPreflight>();
  let closed = false;
  let operationCounter = 0;

  function nextOperationId(request: InferenceRequest): ReturnType<typeof parseProviderOperationId> {
    operationCounter += 1;
    const digest = createHash("sha256")
      .update(`${configuration.instanceId}|${request.requestId}|${operationCounter}`)
      .digest("hex")
      .slice(0, 32);
    return parseProviderOperationId(`anthropic-op:${digest}`);
  }

  function observe(
    request: InferenceRequest,
    startedMs: number,
    outcome: "succeeded" | "failed" | "cancelled",
    error: ProviderError | null,
    usage: ProviderUsage,
  ): void {
    try {
      ports?.observer?.(Object.freeze({
        providerKind: "inference",
        providerId: ANTHROPIC_PROVIDER_ID,
        instanceId: configuration.instanceId,
        modelId: request.modelId,
        outcome,
        errorCode: error?.code ?? null,
        retryStrategy: error?.retry.strategy ?? null,
        latencyMs: safeElapsed(clock, startedMs),
        totalTokens: totalTokens(usage.tokens),
        deadlineExpired: error?.code === "DEADLINE_EXCEEDED",
        cancelled: outcome === "cancelled",
      }));
    } catch {
      // Observability is non-authoritative and cannot change the provider result.
    }
  }

  const provider: InferenceProvider = Object.freeze({
    kind: "inference" as const,

    describe(): ProviderDescriptor {
      return providerDescriptor;
    },

    async health() {
      return parseProviderHealth({
        status: closed ? "closed" : enabled ? "healthy" : "unavailable",
        checkedAt: clock.now().toISOString(),
        detailCode: closed ? "provider-closed" : enabled ? "deterministic-fake" : "stage-18b-production-disabled",
        activeOperations: active.size + pending.size,
      });
    },

    async listModels(): Promise<readonly ModelDescriptor[]> {
      if (closed) throw new ProviderError("PROVIDER_CLOSED", "The Anthropic provider is closed.");
      return models;
    },

    async start(rawRequest: InferenceRequest, startOptions: StartOperationOptions = {}): Promise<ProviderOperation<InferenceEvent, InferenceResult>> {
      if (closed) throw new ProviderError("PROVIDER_CLOSED", "The Anthropic provider is closed.");
      let request: InferenceRequest;
      try {
        request = parseInferenceRequest(rawRequest);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("INVALID_REQUEST", "The Anthropic inference request is invalid.");
      }
      if (!enabled || ANTHROPIC_PRODUCTION_ENABLED === false && options.executionMode !== "deterministic-fake") {
        throw new ProviderError("POLICY_DENIED", "The Stage 18B direct Anthropic provider is production-disabled.", {
          ruleId: "anthropic.stage18b.production-disabled",
        });
      }
      if (ports === undefined) throw new ProviderError("INTERNAL_FAILURE", "Deterministic fake ports are unavailable.");
      if (signalAborted(startOptions.signal)) {
        throw new ProviderError("CANCELLED", "The request was cancelled before Anthropic preflight.");
      }
      if (isDeadlineExpired(request.deadline, clock.now())) {
        throw new ProviderError("DEADLINE_EXCEEDED", "The request deadline elapsed before Anthropic preflight.");
      }
      assertRequestEligible(request, configuration);
      const body = buildAnthropicRequestBody(request, configuration);
      const requestFingerprint = createHash("sha256").update(toCanonicalJson({
        body,
        disclosure: request.disclosure,
        endpoint: configuration.endpoint,
        apiVersion: configuration.apiVersion,
        retentionMode: configuration.retention.mode,
      })).digest("hex");
      const operationId = nextOperationId(request);
      const startedMs = clock.now().valueOf();
      const abort = new AbortController();
      let preflightStopCode: PreflightStopCode | null = null;
      let settlePreflight!: () => void;
      const preflightSettled = new Promise<void>((resolve) => { settlePreflight = resolve; });
      const nowMs = clock.now().valueOf();
      const deadlineDelay = request.deadline === null ? Number.POSITIVE_INFINITY : Date.parse(request.deadline) - nowMs;
      const timeoutMs = Math.max(0, Math.min(configuration.bounds.maximumWallTimeMs, deadlineDelay));
      const deadlineWins = deadlineDelay <= configuration.bounds.maximumWallTimeMs;
      const abortPreflight = (code: PreflightStopCode): void => {
        if (preflightStopCode !== null) return;
        preflightStopCode = code;
        abort.abort();
      };
      const preflightTimer = ports.timer.schedule(timeoutMs, () => {
        abortPreflight(deadlineWins ? "DEADLINE_EXCEEDED" : "TIMEOUT");
      });
      pending.set(operationId, { abortWith: abortPreflight, timer: preflightTimer, settled: preflightSettled });
      if (startOptions.signal !== undefined) {
        startOptions.signal.addEventListener("abort", () => abortPreflight("CANCELLED"), { once: true });
      }
      const cleanupPreflight = (): void => {
        preflightTimer.cancel();
        pending.delete(operationId);
        settlePreflight();
      };
      const stoppedPreflightError = (): ProviderError => {
        const code = preflightStopCode ?? (closed ? "PROVIDER_CLOSED" : "CANCELLED");
        const message = code === "DEADLINE_EXCEEDED"
          ? "The Anthropic request deadline elapsed during preflight."
          : code === "TIMEOUT"
            ? "The Anthropic operation exceeded its wall-time bound during preflight."
            : code === "PROVIDER_CLOSED"
              ? "The Anthropic provider closed during preflight."
              : "The Anthropic request was cancelled during preflight.";
        return new ProviderError(code, message, {}, { operationId, traceId: request.trace.traceId });
      };
      let authorization;
      try {
        authorization = validateAuthorizationDecision(await raceWithAbort(ports.policy.authorize(Object.freeze({
          instanceId: configuration.instanceId,
          operationId,
          modelAlias: configuration.model.alias,
          responseModelId: configuration.model.responseModelId,
          requestFingerprint,
          disclosure: request.disclosure,
          retentionMode: configuration.retention.mode,
          trace: request.trace,
          deadline: request.deadline,
          signal: abort.signal,
        })), abort.signal));
      } catch (error) {
        cleanupPreflight();
        if (error instanceof PreflightAborted || abort.signal.aborted || closed) throw stoppedPreflightError();
        if (error instanceof ProviderError && error.message === "Anthropic policy returned an invalid decision.") {
          throw error;
        }
        throw new ProviderError(
          "POLICY_DENIED",
          "The Anthropic policy boundary failed closed.",
          {},
          { operationId, traceId: request.trace.traceId, causeCategory: "policy-port" },
        );
      }
      if (!authorization.allowed || authorization.decisionFingerprint === null) {
        cleanupPreflight();
        throw new ProviderError("POLICY_DENIED", "Anthropic disclosure policy refused the operation.", {
          decision: "denied",
        }, { operationId, traceId: request.trace.traceId });
      }
      if (configuration.retention.mode === "standard-30-day" && !authorization.retentionAllowed) {
        cleanupPreflight();
        throw new ProviderError("POLICY_DENIED", "Policy did not authorize the configured Anthropic retention profile.", {
          decision: "retention-denied",
        }, { operationId, traceId: request.trace.traceId });
      }
      if (abort.signal.aborted || closed) {
        cleanupPreflight();
        throw stoppedPreflightError();
      }
      let transportResponse;
      try {
        transportResponse = await raceWithAbort(ports.credentials.withApiKey(
          Object.freeze({
            instanceId: configuration.instanceId,
            operationId,
            secretRef: configuration.apiKeyRef,
            classification: request.disclosure.classification,
            policyDecisionFingerprint: authorization.decisionFingerprint,
            deadline: request.deadline,
            trace: request.trace,
            signal: abort.signal,
          }),
          async (secretText) => {
            if (abort.signal.aborted || closed) throw stoppedPreflightError();
            if (typeof secretText !== "string" || secretText.length < 1 || secretText.length > 16_384) {
              throw new ProviderError("AUTHENTICATION_FAILED", "The scoped Anthropic secret material is invalid.");
            }
            return ports.transport.open(Object.freeze({
              endpoint: configuration.endpoint,
              apiVersion: configuration.apiVersion,
              requestFingerprint,
              body,
              signal: abort.signal,
            }), secretText);
          },
        ), abort.signal);
      } catch (error) {
        cleanupPreflight();
        if (error instanceof PreflightAborted || abort.signal.aborted || closed) throw stoppedPreflightError();
        throw mapTransportError(error, operationId, request.trace.traceId);
      }
      if (abort.signal.aborted || closed) {
        cleanupPreflight();
        throw stoppedPreflightError();
      }

      let finalUsage = parseProviderUsage({ tokens: createTokenUsage(), toolCalls: 0 });
      cleanupPreflight();
      let operationTimer: AnthropicTimerHandle | null = null;
      const controller = createOperationController<InferenceEvent, InferenceResult>({
        operationId,
        clock,
        trace: request.trace,
        buildCancelledEvent: (base, reason) => event(base, "operation-cancelled", { reason }),
        onTerminal: ({ kind, error }) => {
          const current = active.get(operationId);
          current?.timer.cancel();
          active.delete(operationId);
          const outcome = kind === "operation-completed" ? "succeeded" : kind === "operation-cancelled" ? "cancelled" : "failed";
          observe(request, startedMs, outcome, error, finalUsage);
        },
      });
      controller.onCancel(() => abort.abort());
      const remainingDeadlineDelay = request.deadline === null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Date.parse(request.deadline) - clock.now().valueOf());
      const remainingWallTime = Math.max(0, configuration.bounds.maximumWallTimeMs - safeElapsed(clock, startedMs));
      const remainingTimeout = Math.min(remainingDeadlineDelay, remainingWallTime);
      const remainingDeadlineWins = remainingDeadlineDelay <= remainingWallTime;
      const activeTimer: AnthropicTimerHandle = Object.freeze({
        cancel: (): void => operationTimer?.cancel(),
      });
      active.set(operationId, { controller, abort, timer: activeTimer });
      operationTimer = ports.timer.schedule(remainingTimeout, () => {
        abort.abort();
        if (controller.isTerminal) return;
        const timeout = new ProviderError(
          remainingDeadlineWins ? "DEADLINE_EXCEEDED" : "TIMEOUT",
          remainingDeadlineWins ? "The Anthropic request deadline elapsed." : "The Anthropic operation exceeded its wall-time bound.",
          {},
          { operationId, traceId: request.trace.traceId },
        );
        controller.fail((base) => event(base, "operation-failed", {
          code: timeout.code,
          message: timeout.message,
          retryStrategy: timeout.retry.strategy,
        }), timeout);
      });
      if (controller.isTerminal) operationTimer.cancel();
      if (startOptions.signal !== undefined) {
        startOptions.signal.addEventListener("abort", () => void controller.operation.cancel("caller-aborted"), { once: true });
      }
      controller.emit((base) => event(base, "operation-started", { modelId: request.modelId }));

      void (async (): Promise<void> => {
        const blocks = new Map<number, OpenBlock>();
        const completedBlocks = new Set<number>();
        const seenToolIds = new Set<string>();
        const textParts: string[] = [];
        const invocations: Array<{ readonly type: "tool-invocation"; readonly invocation: { readonly toolCallId: string; readonly toolName: string; readonly arguments: JsonValue } }> = [];
        const rawUsage: RawUsageState = {
          inputTokens: null,
          outputTokens: null,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
          thinkingTokens: null,
          toolCalls: 0,
        };
        let seenStart = false;
        let seenStop = false;
        let seenMessageDelta = false;
        let stopReason: string | null = null;
        let eventCount = 0;
        let totalWireBytes = 0;
        let outputBytes = 0;
        let firstEventMs: number | null = null;
        let pendingResult: InferenceResult | null = null;
        let pendingStructuredOutput: JsonValue | null = null;
        let nextBlockIndex = 0;

        const emitUsage = (): void => {
          finalUsage = applyWireUsage(rawUsage, {
            inputTokens: null,
            outputTokens: null,
            cacheCreationInputTokens: null,
            cacheReadInputTokens: null,
            thinkingTokens: null,
          });
          controller.emit((base) => event(base, "usage-update", { usage: finalUsage }));
        };

        const fail = (error: ProviderError): void => {
          if (controller.isTerminal) return;
          controller.fail((base) => event(base, "operation-failed", {
            code: error.code,
            message: error.message,
            retryStrategy: error.retry.strategy,
          }), error);
        };

        try {
          for await (const raw of transportResponse.events) {
            if (controller.isTerminal) break;
            eventCount += 1;
            const elapsed = safeElapsed(clock, startedMs);
            if (elapsed > configuration.bounds.maximumWallTimeMs) {
              throw new ProviderError("TIMEOUT", "The Anthropic operation exceeded its wall-time bound.");
            }
            if (isDeadlineExpired(request.deadline, clock.now())) {
              throw new ProviderError("DEADLINE_EXCEEDED", "The Anthropic request deadline elapsed mid-stream.");
            }
            let wire: AnthropicWireEvent;
            try {
              totalWireBytes += wireBytes(raw);
              wire = parseAnthropicWireEvent(raw);
            } catch (error) {
              if (error instanceof ProviderError) throw error;
              throw new ProviderError("PROTOCOL_VIOLATION", "Anthropic emitted a malformed wire event.");
            }
            if (seenStop) {
              throw new ProviderError("PROTOCOL_VIOLATION", "Anthropic emitted data after message_stop.");
            }
            if (eventCount > configuration.bounds.maximumStreamEvents || totalWireBytes > configuration.bounds.maximumWireBytes) {
              throw new ProviderError("PROTOCOL_VIOLATION", "The Anthropic stream exceeded its configured event or byte bound.", {
                eventCount,
                totalWireBytes,
              });
            }
            if (firstEventMs === null) firstEventMs = elapsed;
            switch (wire.type) {
              case "ping":
                break;
              case "error":
                throw new ProviderError(
                  mapFailureKind(wire.errorType),
                  "Anthropic emitted a redacted mid-stream error classification.",
                  { transportKind: wire.errorType },
                  { operationId, traceId: request.trace.traceId, causeCategory: wire.errorType },
                );
              case "message_start":
                if (seenStart || blocks.size !== 0 || completedBlocks.size !== 0) {
                  throw new ProviderError("PROTOCOL_VIOLATION", "Anthropic emitted a duplicate or reordered message_start.");
                }
                if (wire.message.model !== configuration.model.responseModelId) {
                  throw new ProviderError("PROTOCOL_VIOLATION", "Anthropic substituted an unexpected response model.", {
                    expectedModelId: configuration.model.responseModelId,
                    actualModel: "unexpected",
                  });
                }
                seenStart = true;
                controller.emit((base) => event(base, "message-started", { messageIndex: 0 }));
                finalUsage = applyWireUsage(rawUsage, wire.message.usage);
                controller.emit((base) => event(base, "usage-update", { usage: finalUsage }));
                break;
              case "content_block_start":
                if (!seenStart || seenStop || seenMessageDelta || blocks.size !== 0 || wire.index !== nextBlockIndex ||
                    blocks.has(wire.index) || completedBlocks.has(wire.index)) {
                  throw new ProviderError("PROTOCOL_VIOLATION", "Anthropic content-block start is reordered or duplicated.", { index: wire.index });
                }
                if (wire.contentBlock.type === "text") {
                  const contentBlock = wire.contentBlock;
                  blocks.set(wire.index, { type: "text", text: contentBlock.text });
                  if (contentBlock.text.length > 0) {
                    const bytes = Buffer.byteLength(contentBlock.text, "utf8");
                    outputBytes += bytes;
                    if (outputBytes > configuration.bounds.maximumOutputBytes) throw new ProviderError("PROTOCOL_VIOLATION", "Anthropic output exceeded its byte bound.");
                    controller.emit((base) => event(base, request.structuredOutput === null ? "text-delta" : "structured-output-delta", request.structuredOutput === null
                      ? { text: contentBlock.text }
                      : { textDelta: contentBlock.text }));
                  }
                } else {
                  const contentBlock = wire.contentBlock;
                  if (!request.tools.some((tool) => tool.name === contentBlock.name) || seenToolIds.has(contentBlock.id)) {
                    throw new ProviderError("TOOL_PROTOCOL_FAILURE", "Anthropic proposed an undeclared or duplicate tool call.", {
                      toolDeclaration: "unmatched-or-duplicate",
                    });
                  }
                  if (Buffer.byteLength(toCanonicalJson(contentBlock.input), "utf8") > configuration.bounds.maximumToolArgumentBytes) {
                    throw new ProviderError("TOOL_PROTOCOL_FAILURE", "Anthropic tool arguments exceeded their byte bound.");
                  }
                  seenToolIds.add(contentBlock.id);
                  blocks.set(wire.index, {
                    type: "tool_use",
                    id: contentBlock.id,
                    name: contentBlock.name,
                    initialInput: contentBlock.input,
                    partialJson: "",
                  });
                  controller.emit((base) => event(base, "tool-call-started", {
                    toolCallId: contentBlock.id,
                    toolName: contentBlock.name,
                  }));
                }
                break;
              case "content_block_delta": {
                const block = blocks.get(wire.index);
                if (block === undefined || seenStop || seenMessageDelta) {
                  throw new ProviderError("PROTOCOL_VIOLATION", "Anthropic emitted a delta for no open content block.", { index: wire.index });
                }
                if (wire.delta.type === "text_delta") {
                  const delta = wire.delta;
                  if (block.type !== "text") throw new ProviderError("PROTOCOL_VIOLATION", "Anthropic text delta changed content-block type.");
                  block.text += delta.text;
                  outputBytes += Buffer.byteLength(delta.text, "utf8");
                  if (outputBytes > configuration.bounds.maximumOutputBytes) throw new ProviderError("PROTOCOL_VIOLATION", "Anthropic output exceeded its byte bound.");
                  controller.emit((base) => event(base, request.structuredOutput === null ? "text-delta" : "structured-output-delta", request.structuredOutput === null
                    ? { text: delta.text }
                    : { textDelta: delta.text }));
                } else {
                  const delta = wire.delta;
                  if (block.type !== "tool_use") throw new ProviderError("PROTOCOL_VIOLATION", "Anthropic tool JSON delta changed content-block type.");
                  block.partialJson += delta.partialJson;
                  if (Buffer.byteLength(block.partialJson, "utf8") > configuration.bounds.maximumToolArgumentBytes) {
                    throw new ProviderError("TOOL_PROTOCOL_FAILURE", "Anthropic tool arguments exceeded their byte bound.");
                  }
                  controller.emit((base) => event(base, "tool-call-delta", {
                    toolCallId: block.id,
                    argumentsDelta: delta.partialJson,
                  }));
                }
                break;
              }
              case "content_block_stop": {
                const block = blocks.get(wire.index);
                if (block === undefined || seenStop || seenMessageDelta) throw new ProviderError("PROTOCOL_VIOLATION", "Anthropic stopped no open content block.", { index: wire.index });
                blocks.delete(wire.index);
                completedBlocks.add(wire.index);
                nextBlockIndex += 1;
                if (block.type === "text") {
                  textParts.push(block.text);
                } else {
                  let argumentsValue: JsonValue;
                  try {
                    argumentsValue = block.partialJson.length === 0
                      ? block.initialInput
                      : canonicalizeJson(JSON.parse(block.partialJson), "anthropicToolArguments");
                  } catch {
                    throw new ProviderError("TOOL_PROTOCOL_FAILURE", "Anthropic tool arguments are not valid bounded JSON.");
                  }
                  if (Buffer.byteLength(toCanonicalJson(argumentsValue), "utf8") > configuration.bounds.maximumToolArgumentBytes) {
                    throw new ProviderError("TOOL_PROTOCOL_FAILURE", "Anthropic tool arguments exceeded their byte bound.");
                  }
                  const invocation = Object.freeze({ toolCallId: block.id, toolName: block.name, arguments: argumentsValue });
                  invocations.push(Object.freeze({ type: "tool-invocation", invocation }));
                  rawUsage.toolCalls += 1;
                  controller.emit((base) => event(base, "tool-call-completed", { invocation }));
                  emitUsage();
                }
                break;
              }
              case "message_delta":
                if (!seenStart || seenStop || seenMessageDelta || blocks.size !== 0) {
                  throw new ProviderError("PROTOCOL_VIOLATION", "Anthropic message_delta arrived before content blocks completed.");
                }
                seenMessageDelta = true;
                if (wire.stopReason !== null) {
                  if (stopReason !== null && stopReason !== wire.stopReason) throw new ProviderError("PROTOCOL_VIOLATION", "Anthropic stop reason changed within one message.");
                  stopReason = wire.stopReason;
                }
                finalUsage = applyWireUsage(rawUsage, wire.usage);
                controller.emit((base) => event(base, "usage-update", { usage: finalUsage }));
                break;
              case "message_stop": {
                if (!seenStart || seenStop || !seenMessageDelta || blocks.size !== 0 || stopReason === null || rawUsage.inputTokens === null || rawUsage.outputTokens === null) {
                  throw new ProviderError("PROTOCOL_VIOLATION", "Anthropic message_stop is incomplete, duplicated, or reordered.");
                }
                seenStop = true;
                const combinedText = textParts.join("");
                let structuredOutput: JsonValue | null = null;
                if (request.structuredOutput !== null) {
                  try {
                    structuredOutput = canonicalizeJson(JSON.parse(combinedText), "anthropicStructuredOutput");
                  } catch {
                    throw new ProviderError("MALFORMED_RESPONSE", "Anthropic structured output was not valid JSON.");
                  }
                  assertStructuredOutputMatchesSchema(request.structuredOutput.schema, structuredOutput);
                }
                const parts: JsonValue[] = [];
                if (combinedText.length > 0 || invocations.length === 0) parts.push({ type: "text", text: combinedText });
                parts.push(...invocations);
                pendingStructuredOutput = structuredOutput;
                pendingResult = parseInferenceResult({
                  schemaVersion: ANTHROPIC_ADAPTER_SCHEMA_VERSION,
                  operationId,
                  requestId: request.requestId,
                  modelId: request.modelId,
                  messages: [{ role: "assistant", parts }],
                  structuredOutput,
                  finishReason: finishReason(stopReason),
                  refusalMessage: stopReason === "refusal" ? "The provider refused the request." : null,
                  usage: finalUsage,
                  cost: UNKNOWN_COST,
                  latency: { firstEventMs, totalMs: safeElapsed(clock, startedMs) },
                  warnings: [],
                });
                break;
              }
            }
          }
          if (!controller.isTerminal) {
            if (!seenStop || pendingResult === null) {
              throw new ProviderError("PROTOCOL_VIOLATION", "The Anthropic stream ended before one terminal message_stop.");
            }
            if (request.structuredOutput !== null) {
              controller.emit((base) => event(base, "structured-output-completed", { value: pendingStructuredOutput }));
            }
            controller.emit((base) => event(base, "message-completed", { messageIndex: 0 }));
            controller.complete((base) => event(base, "operation-completed", {}), pendingResult);
          }
        } catch (error) {
          abort.abort();
          fail(error instanceof ProviderError ? error : mapTransportError(error, operationId, request.trace.traceId));
        }
      })();

      return controller.operation;
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const preflights = [...pending.values()];
      for (const item of preflights) item.abortWith("PROVIDER_CLOSED");
      await Promise.all([...active.values()].map((item) => item.controller.operation.cancel("provider-closed")));
      await Promise.all(preflights.map((item) => item.settled));
      await ports?.transport.close();
    },
  });
  return provider;
}

export function createProductionDisabledAnthropicProvider(options: {
  readonly configuration: AnthropicAdapterConfiguration;
  readonly clock?: Clock;
}): InferenceProvider {
  const configuration = parseAnthropicAdapterConfiguration(options.configuration);
  return createAnthropicProviderInternal({
    configuration,
    executionMode: "disabled",
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
}
