import {
  COMPILED_DEFAULT_CONFIGURATION,
  parseApplicationConfiguration,
  type ApplicationConfiguration
} from "@ai-dev-os/config";
import { createHash } from "node:crypto";
import { toCanonicalJson, type JsonValue } from "@ai-dev-os/domain";
import {
  allowingPromptAuthorizer,
  jsonClone,
  promptCompilationRequestFixture,
  promptTargetFixture
} from "@ai-dev-os/prompt-compiler/testing/fixtures";
import type {
  PromptAuthorizer,
  PromptCompilationRequest,
  PromptTargetSnapshot
} from "@ai-dev-os/prompt-compiler";
import type {
  GatewayInstanceSnapshot,
  GatewayPreflight
} from "@ai-dev-os/provider-gateway";
import {
  ProviderError,
  createOperationController,
  parseContentPart,
  parseInferenceRequest,
  type Clock,
  type ContentPart,
  type FinishReason,
  type InferenceEvent,
  type InferenceOperation,
  type InferenceRequest,
  type InferenceResult,
  type ProviderErrorCode,
  type ProviderOperationId,
  type StartOperationOptions
} from "@ai-dev-os/providers";
import { THINKER_SCHEMA_VERSION, type ThinkerConfiguration } from "../configuration.js";
import type { ThinkerProposal } from "../proposal.js";
import type { ThinkerRequest } from "../request.js";
import type { ThinkerInferencePort } from "../target.js";
import { createManualThinkerClock, createThinker, type Thinker } from "../thinker.js";

export const THINKER_FIXTURE_EPOCH = "2026-08-04T12:00:00.000Z";
export const THINKER_OUTPUT_CANARY = "STAGE15-THINKER-OUTPUT-CANARY-4D91";

function hash(value: unknown, label: string): string {
  return createHash("sha256").update(toCanonicalJson(value as JsonValue, label), "utf8").digest("hex");
}

export function thinkerApplicationConfigurationFixture(options: {
  readonly primaryEnabled?: boolean;
  readonly alternateEnabled?: boolean;
  readonly primaryKind?: "inference" | "coding-agent";
  readonly alternateKind?: "inference" | "coding-agent";
  readonly planningAliases?: readonly string[];
  readonly primaryAliasModelId?: string;
  readonly alternateAliasModelId?: string;
} = {}): ApplicationConfiguration {
  const primary = promptTargetFixture("primary");
  const alternate = promptTargetFixture("alternate");
  return parseApplicationConfiguration({
    ...COMPILED_DEFAULT_CONFIGURATION,
    providers: [
      {
        instanceId: primary.instanceId,
        providerId: primary.provider.providerId,
        kind: options.primaryKind ?? "inference",
        enabled: options.primaryEnabled ?? true,
        locality: primary.provider.locality,
        credentialRef: null,
        endpointId: null,
        extensions: []
      },
      {
        instanceId: alternate.instanceId,
        providerId: alternate.provider.providerId,
        kind: options.alternateKind ?? "inference",
        enabled: options.alternateEnabled ?? true,
        locality: alternate.provider.locality,
        credentialRef: null,
        endpointId: null,
        extensions: []
      }
    ],
    modelAliases: [
      {
        alias: "primary-thinker",
        providerInstanceId: primary.instanceId,
        modelId: options.primaryAliasModelId ?? primary.model.modelId
      },
      {
        alias: "alternate-thinker",
        providerInstanceId: alternate.instanceId,
        modelId: options.alternateAliasModelId ?? alternate.model.modelId
      }
    ],
    modelPreferences:
      options.planningAliases === undefined
        ? [{ role: "planning", aliases: ["primary-thinker", "alternate-thinker"] }]
        : options.planningAliases.length === 0
          ? []
          : [{ role: "planning", aliases: [...options.planningAliases] }]
  });
}

export function thinkerProposalFixture(
  compilation: PromptCompilationRequest = promptCompilationRequestFixture()
): ThinkerProposal {
  const reference = compilation.context.pack.items[0];
  return Object.freeze({
    schemaVersion: 1,
    status: "viable",
    objective: "Produce a bounded implementation proposal without executing any task.",
    assumptions: Object.freeze(["A later authorized stage will decide whether to execute tasks."]),
    risks: Object.freeze(["A later implementation may discover additional integration constraints."]),
    openQuestions: Object.freeze([]),
    completionCriteria: Object.freeze(["Every proposed task has testable acceptance criteria."]),
    tasks: Object.freeze([
      Object.freeze({
        proposalId: "proposal-1",
        kind: "plan",
        title: "Validate the bounded design",
        description: "Review the supplied evidence and produce a finite implementation design.",
        dependencies: Object.freeze([]),
        acceptanceCriteria: Object.freeze(["The design names its public contracts and failure modes."]),
        evidence:
          reference === undefined
            ? Object.freeze([])
            : Object.freeze([
                Object.freeze({ identity: reference.identity, digest: reference.digest })
              ]),
        unsupportedAssumptions: Object.freeze([]),
        complexity: 3,
        reasoning: "high",
        capabilities: Object.freeze(["reasoning", "structured-output"] as const),
        editScope: "none",
        risk: "medium",
        classification: "internal"
      })
    ])
  });
}

export function thinkerRequestFixture(options: {
  readonly selectedAlias?: "primary-thinker" | "alternate-thinker" | null;
  readonly target?: "primary" | "alternate";
  readonly configuration?: ApplicationConfiguration;
  readonly compilation?: PromptCompilationRequest;
} = {}): ThinkerRequest {
  const targetVariant = options.target ??
    (options.selectedAlias === "alternate-thinker" ? "alternate" : "primary");
  const compilation =
    options.compilation ??
    promptCompilationRequestFixture({ target: promptTargetFixture(targetVariant) });
  return Object.freeze({
    schemaVersion: THINKER_SCHEMA_VERSION,
    requestId: compilation.requestId,
    configuration: options.configuration ?? thinkerApplicationConfigurationFixture(),
    selectedAlias: options.selectedAlias ?? null,
    compilation
  });
}

function gatewaySnapshot(
  target: PromptTargetSnapshot,
  options: { readonly enabled?: boolean; readonly available?: boolean } = {}
): GatewayInstanceSnapshot {
  const base = Object.freeze({
    schemaVersion: 1 as const,
    instanceId: target.instanceId,
    contractModelId: target.model.modelId,
    catalog: Object.freeze({
      catalogId: `catalog-${target.instanceId}`,
      catalogFingerprint: hash({ id: target.instanceId }, "catalog"),
      providerId: target.provider.providerId,
      providerFingerprint: hash(target.provider, "provider"),
      modelId: target.model.modelId,
      modelFingerprint: hash(target.model, "model"),
      adapterProfileId: `profile-${target.instanceId}`,
      lastVerifiedAt: THINKER_FIXTURE_EPOCH,
      refreshAfter: "2027-08-04T12:00:00.000Z"
    }),
    descriptor: target.provider,
    model: Object.freeze({
      model: target.model,
      availability: (options.available ?? true) ? ("available" as const) : ("unavailable" as const)
    }),
    secretRefFingerprint: hash({ instanceId: target.instanceId }, "secretReference"),
    eligibility: "any" as const,
    userPreference: (options.enabled ?? true) ? ("enabled" as const) : ("disabled" as const),
    adapter: Object.freeze({
      packageName: "custom" as const,
      profileId: `profile-${target.instanceId}`,
      version: "fixture-v1"
    })
  });
  return Object.freeze({ ...base, fingerprint: hash(base, "gatewayInstance") });
}

export interface ThinkerBackendScript {
  readonly proposal?: JsonValue;
  readonly resultStructuredOutput?: JsonValue | null;
  readonly streamStructuredOutput?: JsonValue | null;
  readonly text?: string;
  readonly reasoning?: string;
  readonly eventWarnings?: readonly string[];
  readonly resultWarnings?: readonly string[];
  readonly finishReason?: FinishReason;
  readonly refusalMessage?: string | null;
  readonly assistantToolInvocation?: boolean;
  readonly emitToolEvent?: boolean;
  readonly startModelId?: string;
  readonly resultModelId?: string;
  readonly resultRequestId?: string;
  readonly resultOperationId?: string;
  readonly rejectStartCode?: ProviderErrorCode;
  readonly rejectResultCode?: ProviderErrorCode;
  readonly pendingUntilCancelled?: boolean;
  readonly omitOperationStarted?: boolean;
  readonly omitStructuredEvent?: boolean;
}

export interface FakeThinkerPort extends ThinkerInferencePort {
  readonly capturedRequests: readonly InferenceRequest[];
  primaryInvocationCount(): number;
  alternateInvocationCount(): number;
  preflightCount(): number;
  snapshot(instanceId: string): GatewayInstanceSnapshot | undefined;
}

export function createFakeThinkerPort(options: {
  readonly primaryScript?: ThinkerBackendScript;
  readonly alternateScript?: ThinkerBackendScript;
  readonly primaryGatewayEnabled?: boolean;
  readonly alternateGatewayEnabled?: boolean;
  readonly primaryAvailable?: boolean;
  readonly alternateAvailable?: boolean;
  readonly preflightSubstitutesRequest?: boolean;
  readonly preflightSubstitutesInstance?: boolean;
  readonly clock?: Clock;
} = {}): FakeThinkerPort {
  const primaryTarget = promptTargetFixture("primary");
  const alternateTarget = promptTargetFixture("alternate");
  const snapshots = new Map<string, GatewayInstanceSnapshot>([
    [
      primaryTarget.instanceId,
      gatewaySnapshot(primaryTarget, {
        ...(options.primaryGatewayEnabled === undefined
          ? {}
          : { enabled: options.primaryGatewayEnabled }),
        ...(options.primaryAvailable === undefined ? {} : { available: options.primaryAvailable })
      })
    ],
    [
      alternateTarget.instanceId,
      gatewaySnapshot(alternateTarget, {
        ...(options.alternateGatewayEnabled === undefined
          ? {}
          : { enabled: options.alternateGatewayEnabled }),
        ...(options.alternateAvailable === undefined
          ? {}
          : { available: options.alternateAvailable })
      })
    ]
  ]);
  const scripts = new Map<string, ThinkerBackendScript>([
    [primaryTarget.instanceId, options.primaryScript ?? {}],
    [alternateTarget.instanceId, options.alternateScript ?? {}]
  ]);
  const counts = new Map<string, number>();
  const captured: InferenceRequest[] = [];
  const clock = options.clock ?? createManualThinkerClock(THINKER_FIXTURE_EPOCH);
  let preflights = 0;

  const start = (
    instanceId: string,
    rawRequest: InferenceRequest,
    startOptions: StartOperationOptions = {}
  ): InferenceOperation => {
    const request = parseInferenceRequest(rawRequest);
    const script = scripts.get(instanceId) ?? {};
    if (script.rejectStartCode !== undefined)
      throw new ProviderError(script.rejectStartCode, "The fake rejected start.", {});
    const invocation = (counts.get(instanceId) ?? 0) + 1;
    counts.set(instanceId, invocation);
    captured.push(request);
    const operationId = `thinker-op-${instanceId}-${invocation}` as ProviderOperationId;
    const controller = createOperationController<InferenceEvent, InferenceResult>({
      operationId,
      clock,
      trace: request.trace,
      buildCancelledEvent: (base, reason) => ({
        ...base,
        kind: "operation-cancelled",
        payload: { reason }
      })
    });
    if (startOptions.signal !== undefined) {
      if (startOptions.signal.aborted) void controller.operation.cancel("caller-aborted");
      else
        startOptions.signal.addEventListener(
          "abort",
          () => void controller.operation.cancel("caller-aborted"),
          { once: true }
        );
    }
    if (!script.omitOperationStarted) {
      controller.emit((base) => ({
        ...base,
        kind: "operation-started",
        payload: { modelId: script.startModelId ?? request.modelId }
      }));
    }
    if (script.pendingUntilCancelled) return controller.operation;
    if (script.text !== undefined || script.reasoning !== undefined) {
      controller.emit((base) => ({
        ...base,
        kind: "message-started",
        payload: { messageIndex: 0 }
      }));
      if (script.text !== undefined)
        controller.emit((base) => ({ ...base, kind: "text-delta", payload: { text: script.text! } }));
      if (script.reasoning !== undefined)
        controller.emit((base) => ({
          ...base,
          kind: "reasoning-delta",
          payload: { text: script.reasoning! }
        }));
    }
    if (script.emitToolEvent) {
      controller.emit((base) => ({
        ...base,
        kind: "tool-call-started",
        payload: { toolCallId: "fixture-call-1", toolName: "fixture-tool" }
      }));
    }
    for (const warning of script.eventWarnings ?? [])
      controller.emit((base) => ({ ...base, kind: "warning", payload: { message: warning } }));
    const defaultProposal = thinkerProposalFixture(
      promptCompilationRequestFixture({
        target: instanceId === alternateTarget.instanceId ? alternateTarget : primaryTarget
      })
    ) as unknown as JsonValue;
    const resultStructured =
      script.resultStructuredOutput !== undefined
        ? script.resultStructuredOutput
        : script.proposal ?? defaultProposal;
    const streamStructured =
      script.streamStructuredOutput !== undefined
        ? script.streamStructuredOutput
        : resultStructured;
    if (!script.omitStructuredEvent && streamStructured !== null)
      controller.emit((base) => ({
        ...base,
        kind: "structured-output-completed",
        payload: { value: streamStructured }
      }));
    if (script.text !== undefined || script.reasoning !== undefined)
      controller.emit((base) => ({
        ...base,
        kind: "message-completed",
        payload: { messageIndex: 0 }
      }));
    if (script.rejectResultCode !== undefined) {
      const error = new ProviderError(script.rejectResultCode, "The fake result failed.", {});
      controller.fail(
        (base) => ({
          ...base,
          kind: "operation-failed",
          payload: {
            code: error.code,
            message: error.message,
            retryStrategy: error.retry.strategy
          }
        }),
        error
      );
      return controller.operation;
    }
    const parts: ContentPart[] = [];
    if (script.text !== undefined) parts.push({ type: "text", text: script.text });
    if (script.assistantToolInvocation)
      parts.push(parseContentPart({
        type: "tool-invocation",
        invocation: {
          toolCallId: "fixture-call-1",
          toolName: "fixture-tool",
          arguments: { canary: THINKER_OUTPUT_CANARY }
        }
      }));
    const result: InferenceResult = Object.freeze({
      schemaVersion: 1,
      operationId: (script.resultOperationId ?? operationId) as ProviderOperationId,
      requestId: (script.resultRequestId ?? request.requestId) as InferenceResult["requestId"],
      modelId: (script.resultModelId ?? request.modelId) as InferenceResult["modelId"],
      messages:
        parts.length === 0
          ? Object.freeze([])
          : Object.freeze([Object.freeze({ role: "assistant" as const, parts: Object.freeze(parts) })]),
      structuredOutput: resultStructured,
      finishReason: script.finishReason ?? "stop",
      refusalMessage: script.refusalMessage ?? null,
      usage: Object.freeze({
        tokens: Object.freeze({
          inputTokens: 120,
          outputTokens: 80,
          cachedInputTokens: 0,
          reasoningTokens: script.reasoning === undefined ? 0 : 20
        }),
        toolCalls: script.assistantToolInvocation || script.emitToolEvent ? 1 : 0
      }),
      cost: Object.freeze({ providerReported: null, locallyComputed: null }),
      latency: Object.freeze({ firstEventMs: 1, totalMs: 4 }),
      warnings: Object.freeze([...(script.resultWarnings ?? [])])
    });
    controller.complete(
      (base) => ({ ...base, kind: "operation-completed", payload: {} }),
      result
    );
    return controller.operation;
  };

  const port: FakeThinkerPort = {
    capturedRequests: captured,
    primaryInvocationCount: () => counts.get(primaryTarget.instanceId) ?? 0,
    alternateInvocationCount: () => counts.get(alternateTarget.instanceId) ?? 0,
    preflightCount: () => preflights,
    snapshot: (instanceId: string) => snapshots.get(instanceId),
    fingerprint: () => hash([...snapshots.values()].map((item) => item.fingerprint), "fakeGateway"),
    getInstance: (instanceId: string) => snapshots.get(instanceId),
    preflight(input: { readonly instanceId: string; readonly request: InferenceRequest }): GatewayPreflight {
      preflights += 1;
      const snapshot = snapshots.get(input.instanceId);
      if (snapshot === undefined)
        throw new ProviderError("MODEL_UNAVAILABLE", "The fake gateway has no such instance.", {});
      const request = parseInferenceRequest(input.request);
      const substituted = options.preflightSubstitutesRequest
        ? parseInferenceRequest({ ...request, requestId: "substituted-request" })
        : request;
      const instance = options.preflightSubstitutesInstance
        ? snapshots.get(alternateTarget.instanceId)!
        : snapshot;
      return Object.freeze({ instance, request: substituted, catalogFreeTierState: "unknown" });
    },
    async invoke(input: {
      readonly instanceId: string;
      readonly request: InferenceRequest;
      readonly options?: StartOperationOptions;
    }): Promise<InferenceOperation> {
      return start(input.instanceId, input.request, input.options);
    }
  };
  return port;
}

export interface ThinkerContractHarness {
  readonly thinker: Thinker;
  readonly request: ThinkerRequest;
  readonly port: FakeThinkerPort;
  readonly authorizer: PromptAuthorizer;
  close(): Promise<void>;
}

export function createThinkerContractHarness(options: {
  readonly target?: "primary" | "alternate";
  readonly script?: ThinkerBackendScript;
  readonly configuration?: ThinkerConfiguration;
} = {}): ThinkerContractHarness {
  const target = options.target ?? "primary";
  const port = createFakeThinkerPort(
    target === "primary"
      ? options.script === undefined
        ? {}
        : { primaryScript: options.script }
      : options.script === undefined
        ? {}
        : { alternateScript: options.script }
  );
  const request = thinkerRequestFixture({
    selectedAlias: target === "primary" ? null : "alternate-thinker",
    target
  });
  const authorizer = allowingPromptAuthorizer();
  const thinker = createThinker({
    port,
    authorizer,
    ...(options.configuration === undefined ? {} : { configuration: options.configuration }),
    clock: createManualThinkerClock(THINKER_FIXTURE_EPOCH)
  });
  return Object.freeze({
    thinker,
    request,
    port,
    authorizer,
    close: () => thinker.close()
  });
}

export { jsonClone };
