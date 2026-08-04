import { createHash } from "node:crypto";
import { toCanonicalJson, validation, type JsonValue } from "@ai-dev-os/domain";
import {
  PROMPT_TEMPLATE_VERSION,
  THINKER_PROPOSAL_OUTPUT_SCHEMA_VERSION,
  createPromptCompiler,
  type CompiledThinkerPrompt,
  type PromptAuthorizer,
  type PromptCompilerConfiguration
} from "@ai-dev-os/prompt-compiler";
import {
  INFERENCE_EVENT_KINDS,
  ProviderError,
  guardProviderOperation,
  isDeadlineExpired,
  parseInferenceEvent,
  parseInferenceRequest,
  parseInferenceResult,
  parseProviderOperationId,
  systemClock,
  type AbortSignalLike,
  type Clock,
  type ContentPart,
  type InferenceEvent,
  type InferenceEventKind,
  type InferenceOperation,
  type InferenceResult,
  type ProviderCost,
  type ProviderLatency,
  type ProviderUsage,
  type TerminalEventKind
} from "@ai-dev-os/providers";
import {
  DEFAULT_THINKER_CONFIGURATION,
  THINKER_FINGERPRINT_ALGORITHM_VERSION,
  THINKER_PLAN_SCHEMA_VERSION,
  THINKER_SCHEMA_VERSION,
  parseThinkerConfiguration,
  type ThinkerConfiguration
} from "./configuration.js";
import {
  asThinkerError,
  safeCauseCode,
  thinkerFailed,
  thinkerFailure,
  thinkerOk,
  type ThinkerErrorCode,
  type ThinkerFailure,
  type ThinkerResult
} from "./errors.js";
import {
  thinkerPlanFingerprint,
  validateThinkerPlan,
  type ThinkerPlanViolationCategory,
  type ThinkerProposal
} from "./proposal.js";
import { parseThinkerRequest, type ThinkerRequest } from "./request.js";
import {
  resolveThinkerTarget,
  type ResolvedThinkerTarget,
  type ThinkerInferencePort
} from "./target.js";

const { ensureTimestamp } = validation;

export interface ThinkerWarningSummary {
  readonly count: number;
  readonly totalBytes: number;
  readonly fingerprint: string;
}

export interface ThinkerEventSummary {
  readonly eventCount: number;
  readonly counts: Readonly<Record<InferenceEventKind, number>>;
  readonly textDeltaBytes: number;
  readonly reasoningDeltaBytes: number;
  readonly structuredDeltaBytes: number;
  readonly structuredOutputFingerprint: string;
  readonly terminalKind: TerminalEventKind;
  readonly warnings: ThinkerWarningSummary;
}

export interface ThinkerAssistantSummary {
  readonly messageCount: number;
  readonly partCount: number;
  readonly textBytes: number;
  readonly jsonBytes: number;
  readonly artifactReferenceCount: number;
}

export interface ThinkerProviderReceipt {
  readonly schemaVersion: typeof THINKER_SCHEMA_VERSION;
  readonly operationId: string;
  readonly requestId: string;
  readonly modelId: string;
  readonly finishReason: "stop";
  readonly usage: ProviderUsage;
  readonly cost: ProviderCost;
  readonly latency: ProviderLatency;
  readonly warnings: ThinkerWarningSummary;
  readonly events: ThinkerEventSummary;
  readonly assistant: ThinkerAssistantSummary;
}

export interface ThinkerSuccess {
  readonly schemaVersion: typeof THINKER_SCHEMA_VERSION;
  readonly planSchemaVersion: typeof THINKER_PLAN_SCHEMA_VERSION;
  readonly promptTemplateVersion: typeof PROMPT_TEMPLATE_VERSION;
  readonly fingerprintAlgorithmVersion: typeof THINKER_FINGERPRINT_ALGORITHM_VERSION;
  readonly authority: "none";
  readonly selectedAlias: string;
  readonly target: {
    readonly instanceId: string;
    readonly modelId: string;
    readonly targetFingerprint: string;
    readonly gatewayInstanceFingerprint: string;
    readonly gatewayFingerprint: string;
  };
  readonly promptFingerprint: string;
  readonly contextPackFingerprint: string;
  readonly authorizationFingerprint: string;
  readonly authorityFingerprint: string;
  readonly proposal: ThinkerProposal;
  readonly proposalFingerprint: string;
  readonly receipt: ThinkerProviderReceipt;
}

export type ThinkerOutcome = ThinkerResult<ThinkerSuccess>;

export type ThinkerAuditRecord =
  | {
      readonly outcome: "succeeded";
      readonly code: "THINKER_PROPOSAL_SEALED";
      readonly requestId: string;
      readonly selectedAlias: string;
      readonly targetFingerprint: string;
      readonly promptFingerprint: string;
      readonly proposalFingerprint: string;
      readonly taskCount: number;
      readonly eventCount: number;
      readonly authority: "none";
    }
  | {
      readonly outcome: "failed";
      readonly code: ThinkerErrorCode;
      readonly requestId: string | null;
      readonly selectedAlias: string | null;
      readonly targetFingerprint: string | null;
    };

export type ThinkerObserver = (record: ThinkerAuditRecord) => void;

export interface Thinker {
  think(request: unknown, options?: { readonly signal?: AbortSignalLike }): Promise<ThinkerOutcome>;
  close(): Promise<void>;
  readonly closed: boolean;
  readonly activeOperationCount: number;
}

interface DrainedEvents {
  readonly summary: ThinkerEventSummary;
  readonly issue: ThinkerErrorCode | null;
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashJson(value: JsonValue, label: string): string {
  return hashText(toCanonicalJson(value, label));
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function createWarningAccumulator(): {
  add(value: string): void;
  summary(): ThinkerWarningSummary;
} {
  const hasher = createHash("sha256");
  let count = 0;
  let totalBytes = 0;
  return {
    add(value: string): void {
      const bytes = Buffer.from(value, "utf8");
      count += 1;
      totalBytes += bytes.byteLength;
      hasher.update(String(bytes.byteLength), "utf8");
      hasher.update(":", "utf8");
      hasher.update(bytes);
    },
    summary(): ThinkerWarningSummary {
      return Object.freeze({ count, totalBytes, fingerprint: hasher.digest("hex") });
    }
  };
}

function emptyEventCounts(): Record<InferenceEventKind, number> {
  return {
    "operation-started": 0,
    "message-started": 0,
    "text-delta": 0,
    "reasoning-delta": 0,
    "structured-output-delta": 0,
    "structured-output-completed": 0,
    "tool-call-started": 0,
    "tool-call-delta": 0,
    "tool-call-completed": 0,
    "usage-update": 0,
    warning: 0,
    "message-completed": 0,
    "operation-completed": 0,
    "operation-failed": 0,
    "operation-cancelled": 0
  };
}

function sameTrace(a: InferenceEvent["trace"], b: InferenceEvent["trace"]): boolean {
  return (
    a.traceId === b.traceId &&
    a.runId === b.runId &&
    a.taskId === b.taskId &&
    a.taskRunId === b.taskRunId
  );
}

async function drainEvents(
  operation: InferenceOperation,
  request: ThinkerRequest,
  target: ResolvedThinkerTarget,
  configuration: ThinkerConfiguration
): Promise<DrainedEvents> {
  const counts = emptyEventCounts();
  const warnings = createWarningAccumulator();
  let eventCount = 0;
  let textDeltaBytes = 0;
  let reasoningDeltaBytes = 0;
  let structuredDeltaBytes = 0;
  let structuredOutputFingerprint: string | null = null;
  let terminalKind: TerminalEventKind | null = null;
  let issue: ThinkerErrorCode | null = null;
  let cancelledForBounds = false;
  const mark = (code: ThinkerErrorCode): void => {
    issue ??= code;
  };
  const cancelForBounds = async (): Promise<void> => {
    if (!cancelledForBounds && terminalKind === null) {
      cancelledForBounds = true;
      await operation.cancel("budget-exhausted");
    }
  };

  for await (const event of operation.events()) {
    eventCount += 1;
    counts[event.kind] += 1;
    if (eventCount === 1 && event.kind !== "operation-started") mark("PROTOCOL_VIOLATION");
    if (!sameTrace(event.trace, request.compilation.trace)) mark("PROTOCOL_VIOLATION");
    if (event.kind === "operation-started" && event.payload.modelId !== target.modelId)
      mark("MODEL_SUBSTITUTION");
    switch (event.kind) {
      case "text-delta":
        textDeltaBytes += utf8Bytes(event.payload.text);
        break;
      case "reasoning-delta":
        reasoningDeltaBytes += utf8Bytes(event.payload.text);
        break;
      case "structured-output-delta":
        structuredDeltaBytes += utf8Bytes(event.payload.textDelta);
        break;
      case "structured-output-completed":
        if (structuredOutputFingerprint !== null) mark("PROTOCOL_VIOLATION");
        structuredOutputFingerprint = hashJson(event.payload.value, "streamStructuredOutput");
        break;
      case "tool-call-started":
      case "tool-call-delta":
      case "tool-call-completed":
        mark("FINISH_TOOL_CALL");
        break;
      case "warning":
        warnings.add(event.payload.message);
        if (counts.warning > configuration.maxWarnings) mark("EVENT_BOUNDS_EXCEEDED");
        break;
      case "operation-completed":
      case "operation-failed":
      case "operation-cancelled":
        terminalKind = event.kind;
        break;
      default:
        break;
    }
    const observedBytes = textDeltaBytes + reasoningDeltaBytes + structuredDeltaBytes;
    if (eventCount > configuration.maxEvents || observedBytes > configuration.maxObservedDeltaBytes) {
      mark("EVENT_BOUNDS_EXCEEDED");
      await cancelForBounds();
    }
  }
  if (counts["operation-started"] !== 1) mark("PROTOCOL_VIOLATION");
  if (counts["structured-output-completed"] !== 1) mark("STRUCTURED_OUTPUT_MISSING");
  if (terminalKind !== "operation-completed") mark("PROTOCOL_VIOLATION");
  return Object.freeze({
    summary: Object.freeze({
      eventCount,
      counts: Object.freeze(counts),
      textDeltaBytes,
      reasoningDeltaBytes,
      structuredDeltaBytes,
      structuredOutputFingerprint: structuredOutputFingerprint ?? hashText("missing"),
      terminalKind: terminalKind ?? "operation-failed",
      warnings: warnings.summary()
    }),
    issue
  });
}

function summarizeWarnings(values: readonly string[]): ThinkerWarningSummary {
  const accumulator = createWarningAccumulator();
  for (const value of values) accumulator.add(value);
  return accumulator.summary();
}

function summarizeAssistant(messages: InferenceResult["messages"]): {
  readonly summary: ThinkerAssistantSummary;
  readonly toolInvocation: boolean;
} {
  let partCount = 0;
  let textBytes = 0;
  let jsonBytes = 0;
  let artifactReferenceCount = 0;
  let toolInvocation = false;
  for (const message of messages) {
    for (const part of message.parts) {
      partCount += 1;
      switch (part.type) {
        case "text":
          textBytes += utf8Bytes(part.text);
          break;
        case "json":
          jsonBytes += utf8Bytes(toCanonicalJson(part.value, "assistantJson"));
          break;
        case "artifact":
        case "image-artifact":
          artifactReferenceCount += 1;
          break;
        case "tool-invocation":
          toolInvocation = true;
          break;
        case "tool-result":
          toolInvocation = true;
          break;
      }
    }
  }
  return Object.freeze({
    summary: Object.freeze({
      messageCount: messages.length,
      partCount,
      textBytes,
      jsonBytes,
      artifactReferenceCount
    }),
    toolInvocation
  });
}

function finishFailure(result: InferenceResult): ThinkerFailure | null {
  if (result.refusalMessage !== null || result.finishReason === "refusal")
    return thinkerFailure("REFUSED", "The inference target refused the proposal request.");
  switch (result.finishReason) {
    case "stop":
      return null;
    case "length":
      return thinkerFailure("FINISH_LENGTH", "The inference target reached its output limit.");
    case "tool-calls":
      return thinkerFailure("FINISH_TOOL_CALL", "The inference target attempted a tool call.");
    case "content-filter":
      return thinkerFailure("CONTENT_FILTERED", "The inference target filtered the output.");
  }
}

function providerFailure(error: unknown, closed: boolean): ThinkerFailure {
  const code = safeCauseCode(error);
  if (code === "CANCELLED")
    return thinkerFailure(
      closed ? "THINKER_CLOSED" : "CANCELLED",
      closed ? "The thinker closed during the operation." : "The thinker operation was cancelled."
    );
  if (code === "DEADLINE_EXCEEDED")
    return thinkerFailure("DEADLINE_EXCEEDED", "The thinker deadline was exceeded.");
  return thinkerFailure("PROVIDER_RESULT_FAILED", "The provider operation failed safely.", {
    causeCode: code
  });
}

function validationFailureCategory(
  categories: readonly ThinkerPlanViolationCategory[]
): ThinkerErrorCode {
  return categories.includes("authority") ? "AUTHORITY_VIOLATION" : "PROPOSAL_INVALID";
}

function emit(observer: ThinkerObserver | undefined, record: ThinkerAuditRecord): void {
  try {
    observer?.(record);
  } catch {
    // Observers are non-authoritative and their thrown values are intentionally ignored.
  }
}

function failedAudit(
  failure: ThinkerFailure,
  request: ThinkerRequest | null,
  target: ResolvedThinkerTarget | null
): ThinkerAuditRecord {
  return Object.freeze({
    outcome: "failed",
    code: failure.code,
    requestId: request?.requestId ?? null,
    selectedAlias: target?.selectedAlias ?? request?.selectedAlias ?? null,
    targetFingerprint: target?.targetFingerprint ?? null
  });
}

function validatePreflight(
  port: ThinkerInferencePort,
  compiled: CompiledThinkerPrompt,
  target: ResolvedThinkerTarget
): void {
  const preflight = port.preflight({
    instanceId: target.instanceId,
    request: compiled.inferenceRequest
  });
  const parsed = parseInferenceRequest(preflight.request, "thinkerPreflight.request");
  if (
    preflight.instance.fingerprint !== target.gatewayInstanceFingerprint ||
    preflight.instance.instanceId !== target.instanceId ||
    toCanonicalJson(parsed, "thinkerPreflight") !==
      toCanonicalJson(compiled.inferenceRequest, "compiledInferenceRequest")
  ) {
    throw new ProviderError(
      "PROTOCOL_VIOLATION",
      "The gateway preflight substituted the selected target or request.",
      {}
    );
  }
}

function assertCompiledBoundary(
  compiled: CompiledThinkerPrompt,
  target: ResolvedThinkerTarget,
  configuration: ThinkerConfiguration
): ThinkerFailure | null {
  const request = compiled.inferenceRequest;
  if (
    compiled.templateVersion !== configuration.promptTemplateVersion ||
    compiled.outputSchemaVersion !== configuration.planSchemaVersion ||
    compiled.target.fingerprint !== target.targetFingerprint ||
    compiled.target.instanceId !== target.instanceId ||
    compiled.target.modelId !== target.modelId
  ) {
    return thinkerFailure("TARGET_MISMATCH", "The compiled prompt target or version was substituted.");
  }
  if (
    request.tools.length !== 0 ||
    request.toolChoice?.mode !== "none" ||
    request.structuredOutput?.strict !== true
  ) {
    return thinkerFailure("PROTOCOL_VIOLATION", "The thinker prompt violated its no-tools contract.");
  }
  if (request.maxOutputTokens === null || request.maxOutputTokens > configuration.maxOutputTokens) {
    return thinkerFailure("INVALID_CONFIGURATION", "The compiled output bound exceeds the thinker limit.");
  }
  return null;
}

export function createThinker(options: {
  readonly port: ThinkerInferencePort;
  readonly authorizer?: PromptAuthorizer;
  readonly promptCompilerConfiguration?: PromptCompilerConfiguration;
  readonly configuration?: ThinkerConfiguration;
  readonly clock?: Clock;
  readonly observer?: ThinkerObserver;
}): Thinker {
  const configuration = parseThinkerConfiguration(
    options.configuration ?? DEFAULT_THINKER_CONFIGURATION
  );
  const compiler = createPromptCompiler({
    ...(options.authorizer === undefined ? {} : { authorizer: options.authorizer }),
    ...(options.promptCompilerConfiguration === undefined
      ? {}
      : { configuration: options.promptCompilerConfiguration })
  });
  const clock = options.clock ?? systemClock;
  const active = new Set<InferenceOperation>();
  let closed = false;

  const finishFailed = (
    failure: ThinkerFailure,
    request: ThinkerRequest | null,
    target: ResolvedThinkerTarget | null
  ): ThinkerOutcome => {
    emit(options.observer, failedAudit(failure, request, target));
    return thinkerFailed(failure);
  };

  return Object.freeze({
    get closed(): boolean {
      return closed;
    },
    get activeOperationCount(): number {
      return active.size;
    },
    async think(rawRequest: unknown, thinkOptions: { readonly signal?: AbortSignalLike } = {}): Promise<ThinkerOutcome> {
      if (closed)
        return finishFailed(thinkerFailure("THINKER_CLOSED", "The thinker is closed."), null, null);
      let request: ThinkerRequest;
      try {
        request = parseThinkerRequest(rawRequest);
      } catch (error) {
        return finishFailed(
          thinkerFailure("INVALID_REQUEST", "The thinker request is invalid.", {
            causeCode: safeCauseCode(error)
          }),
          null,
          null
        );
      }
      if (thinkOptions.signal?.aborted === true)
        return finishFailed(
          thinkerFailure("CANCELLED", "The thinker request was already cancelled."),
          request,
          null
        );
      if (isDeadlineExpired(request.compilation.deadline, clock.now()))
        return finishFailed(
          thinkerFailure("DEADLINE_EXCEEDED", "The thinker deadline passed before compilation."),
          request,
          null
        );
      const compiledResult = await compiler.compile(request.compilation);
      if (!compiledResult.ok)
        return finishFailed(
          thinkerFailure("COMPILATION_FAILED", "Prompt compilation did not authorize a request.", {
            compilationCode: compiledResult.failure.code
          }),
          request,
          null
        );
      if (closed)
        return finishFailed(
          thinkerFailure("THINKER_CLOSED", "The thinker closed before provider invocation."),
          request,
          null
        );
      let target: ResolvedThinkerTarget;
      try {
        target = resolveThinkerTarget({
          configuration: request.configuration,
          selectedAlias: request.selectedAlias,
          port: options.port,
          expectedTarget: request.compilation.target
        });
      } catch (error) {
        const wrapped = asThinkerError(error, "TARGET_MISMATCH", "Thinker target resolution failed.");
        return finishFailed(thinkerFailure(wrapped.code, wrapped.message, wrapped.details), request, null);
      }
      const compiledFailure = assertCompiledBoundary(compiledResult.value, target, configuration);
      if (compiledFailure !== null) return finishFailed(compiledFailure, request, target);
      if (isDeadlineExpired(request.compilation.deadline, clock.now()))
        return finishFailed(
          thinkerFailure("DEADLINE_EXCEEDED", "The thinker deadline passed before invocation."),
          request,
          target
        );
      try {
        validatePreflight(options.port, compiledResult.value, target);
      } catch (error) {
        return finishFailed(
          thinkerFailure("TARGET_INELIGIBLE", "The selected target failed gateway preflight.", {
            causeCode: safeCauseCode(error)
          }),
          request,
          target
        );
      }
      let rawOperation: InferenceOperation;
      try {
        rawOperation = await options.port.invoke({
          instanceId: target.instanceId,
          request: compiledResult.value.inferenceRequest,
          ...(thinkOptions.signal === undefined ? {} : { options: { signal: thinkOptions.signal } })
        });
        parseProviderOperationId(rawOperation.operationId, "thinkerOperation.operationId");
      } catch (error) {
        const code = safeCauseCode(error);
        const failure =
          code === "DEADLINE_EXCEEDED"
            ? thinkerFailure("DEADLINE_EXCEEDED", "The thinker deadline was exceeded.")
            : code === "CANCELLED"
              ? thinkerFailure("CANCELLED", "The thinker operation was cancelled.")
              : thinkerFailure("PROVIDER_START_FAILED", "The provider operation did not start.", {
                  causeCode: code
                });
        return finishFailed(failure, request, target);
      }
      const operation = guardProviderOperation(rawOperation, {
        parseEvent: (value) => parseInferenceEvent(value, "thinkerEvent"),
        parseResult: (value) => parseInferenceResult(value, "thinkerResult")
      });
      active.add(operation);
      if (closed) await operation.cancel("caller-requested");
      const settled = await Promise.allSettled([
        drainEvents(operation, request, target, configuration),
        operation.result
      ]);
      active.delete(operation);
      const stream = settled[0]!;
      const providerResult = settled[1]!;
      if (stream.status === "rejected")
        return finishFailed(
          thinkerFailure("PROVIDER_STREAM_FAILED", "The provider event stream failed validation.", {
            causeCode: safeCauseCode(stream.reason)
          }),
          request,
          target
        );
      if (providerResult.status === "rejected")
        return finishFailed(providerFailure(providerResult.reason, closed), request, target);
      if (stream.value.issue !== null)
        return finishFailed(
          thinkerFailure(stream.value.issue, "The provider event stream violated the thinker contract."),
          request,
          target
        );
      const result = providerResult.value;
      if (result.operationId !== operation.operationId)
        return finishFailed(
          thinkerFailure("PROTOCOL_VIOLATION", "The provider substituted the operation identity."),
          request,
          target
        );
      if (result.requestId !== compiledResult.value.inferenceRequest.requestId)
        return finishFailed(
          thinkerFailure("REQUEST_SUBSTITUTION", "The provider substituted the request identity."),
          request,
          target
        );
      if (result.modelId !== target.modelId)
        return finishFailed(
          thinkerFailure("MODEL_SUBSTITUTION", "The provider substituted the selected model."),
          request,
          target
        );
      const finish = finishFailure(result);
      if (finish !== null) return finishFailed(finish, request, target);
      const assistant = summarizeAssistant(result.messages);
      if (assistant.toolInvocation || result.usage.toolCalls !== 0)
        return finishFailed(
          thinkerFailure("FINISH_TOOL_CALL", "The inference target attempted a tool call."),
          request,
          target
        );
      if (assistant.summary.messageCount > configuration.maxAssistantMessages)
        return finishFailed(
          thinkerFailure("EVENT_BOUNDS_EXCEEDED", "The provider response metadata exceeded its bound."),
          request,
          target
        );
      if (result.structuredOutput === null)
        return finishFailed(
          thinkerFailure("STRUCTURED_OUTPUT_MISSING", "The provider returned no structured proposal."),
          request,
          target
        );
      if (
        hashJson(result.structuredOutput, "resultStructuredOutput") !==
        stream.value.summary.structuredOutputFingerprint
      )
        return finishFailed(
          thinkerFailure("PROTOCOL_VIOLATION", "The stream and result structured outputs disagree."),
          request,
          target
        );
      const warnings = summarizeWarnings(result.warnings);
      if (warnings.count > configuration.maxWarnings)
        return finishFailed(
          thinkerFailure("EVENT_BOUNDS_EXCEEDED", "The provider warning summary exceeded its bound."),
          request,
          target
        );
      const validation = validateThinkerPlan(
        result.structuredOutput,
        request.compilation,
        configuration
      );
      if (!validation.valid) {
        const categories = validation.violations.map((item) => item.category);
        return finishFailed(
          thinkerFailure(
            validationFailureCategory(categories),
            "The structured proposal failed authority or plan validation.",
            { violationCount: validation.violations.length }
          ),
          request,
          target
        );
      }
      const receipt: ThinkerProviderReceipt = Object.freeze({
        schemaVersion: THINKER_SCHEMA_VERSION,
        operationId: result.operationId,
        requestId: result.requestId,
        modelId: result.modelId,
        finishReason: "stop",
        usage: result.usage,
        cost: result.cost,
        latency: result.latency,
        warnings,
        events: stream.value.summary,
        assistant: assistant.summary
      });
      const proposalFingerprint = thinkerPlanFingerprint(validation.proposal);
      const value: ThinkerSuccess = Object.freeze({
        schemaVersion: THINKER_SCHEMA_VERSION,
        planSchemaVersion: THINKER_PLAN_SCHEMA_VERSION,
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
        fingerprintAlgorithmVersion: THINKER_FINGERPRINT_ALGORITHM_VERSION,
        authority: "none",
        selectedAlias: target.selectedAlias,
        target: Object.freeze({
          instanceId: target.instanceId,
          modelId: target.modelId,
          targetFingerprint: target.targetFingerprint,
          gatewayInstanceFingerprint: target.gatewayInstanceFingerprint,
          gatewayFingerprint: target.gatewayFingerprint
        }),
        promptFingerprint: compiledResult.value.fingerprint,
        contextPackFingerprint: compiledResult.value.contextPackFingerprint,
        authorizationFingerprint: compiledResult.value.authorizationFingerprint,
        authorityFingerprint: compiledResult.value.authorityFingerprint,
        proposal: validation.proposal,
        proposalFingerprint,
        receipt
      });
      emit(
        options.observer,
        Object.freeze({
          outcome: "succeeded",
          code: "THINKER_PROPOSAL_SEALED",
          requestId: request.requestId,
          selectedAlias: target.selectedAlias,
          targetFingerprint: target.targetFingerprint,
          promptFingerprint: value.promptFingerprint,
          proposalFingerprint,
          taskCount: value.proposal.tasks.length,
          eventCount: value.receipt.events.eventCount,
          authority: "none"
        })
      );
      return thinkerOk(value);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      compiler.close();
      await Promise.all([...active].map((operation) => operation.cancel("caller-requested")));
    }
  });
}

export interface ManualThinkerClock extends Clock {
  set(instant: string): void;
  advance(milliseconds: number): void;
}

export function createManualThinkerClock(
  initialInstant = "2026-01-01T00:00:00.000Z"
): ManualThinkerClock {
  let milliseconds = new Date(ensureTimestamp(initialInstant, "initialInstant")).valueOf();
  return {
    now: () => new Date(milliseconds),
    set(instant: string): void {
      milliseconds = new Date(ensureTimestamp(instant, "instant")).valueOf();
    },
    advance(amount: number): void {
      if (!Number.isSafeInteger(amount) || amount < 0) {
        throw new TypeError("Clock advancement must be a non-negative safe integer.");
      }
      milliseconds += amount;
    }
  };
}

export type ThinkerSummary =
  | {
      readonly outcome: "succeeded";
      readonly authority: "none";
      readonly selectedAlias: string;
      readonly targetFingerprint: string;
      readonly promptFingerprint: string;
      readonly contextPackFingerprint: string;
      readonly authorizationFingerprint: string;
      readonly proposalFingerprint: string;
      readonly taskCount: number;
      readonly eventCount: number;
      readonly totalTokens: number;
      readonly warningCount: number;
    }
  | { readonly outcome: "failed"; readonly code: ThinkerErrorCode };

export function summarizeThinkerResult(result: ThinkerOutcome): ThinkerSummary {
  if (!result.ok) return Object.freeze({ outcome: "failed", code: result.failure.code });
  const tokens = result.value.receipt.usage.tokens;
  return Object.freeze({
    outcome: "succeeded",
    authority: "none",
    selectedAlias: result.value.selectedAlias,
    targetFingerprint: result.value.target.targetFingerprint,
    promptFingerprint: result.value.promptFingerprint,
    contextPackFingerprint: result.value.contextPackFingerprint,
    authorizationFingerprint: result.value.authorizationFingerprint,
    proposalFingerprint: result.value.proposalFingerprint,
    taskCount: result.value.proposal.tasks.length,
    eventCount: result.value.receipt.events.eventCount,
    totalTokens:
      tokens.inputTokens +
      tokens.outputTokens +
      tokens.cachedInputTokens +
      tokens.reasoningTokens,
    warningCount:
      result.value.receipt.warnings.count + result.value.receipt.events.warnings.count
  });
}
