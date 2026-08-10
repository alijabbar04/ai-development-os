import { createModelCapabilities, type JsonObject } from "@ai-dev-os/domain";
import {
  createInferenceRequest,
  parseDisclosureContext,
  type InferenceRequest,
  type ProviderObserver,
} from "@ai-dev-os/providers";
import { INTERNAL_DISCLOSURE, TESTKIT_EPOCH, TESTKIT_TRACE } from "@ai-dev-os/provider-testkit";
import {
  AnthropicTransportFailure,
  createAnthropicAdapterConfiguration,
  type AnthropicAdapterConfiguration,
  type AnthropicAuthorizationRequest,
  type AnthropicCredentialRequest,
  type AnthropicTimer,
  type AnthropicTimerHandle,
  type AnthropicTransport,
  type AnthropicTransportRequest,
} from "../src/index.js";
import type { AnthropicTestingPorts } from "../src/testing/index.js";

export const MODEL_ALIAS = "anthropic:primary";
export const RESPONSE_MODEL_ID = "claude-test-pinned-20260809";
export const PLACEHOLDER_SECRET = "deterministic-test-placeholder";

interface PendingTimer {
  readonly dueAt: number;
  readonly order: number;
  readonly callback: () => void;
  cancelled: boolean;
}

export class ManualTime implements AnthropicTimer {
  private value: number;
  private order = 0;
  private readonly timers: PendingTimer[] = [];

  constructor(start = TESTKIT_EPOCH) {
    this.value = Date.parse(start);
  }

  now(): Date {
    return new Date(this.value);
  }

  advance(milliseconds: number): void {
    this.value += milliseconds;
    for (;;) {
      const due = this.timers
        .filter((timer) => !timer.cancelled && timer.dueAt <= this.value)
        .sort((left, right) => left.dueAt - right.dueAt || left.order - right.order)[0];
      if (due === undefined) return;
      due.cancelled = true;
      due.callback();
    }
  }

  schedule(milliseconds: number, callback: () => void): AnthropicTimerHandle {
    const timer: PendingTimer = {
      dueAt: this.value + Math.max(0, milliseconds),
      order: ++this.order,
      callback,
      cancelled: false,
    };
    this.timers.push(timer);
    return Object.freeze({ cancel: (): void => { timer.cancelled = true; } });
  }
}

export interface FakeTransportScript {
  readonly events?: readonly unknown[];
  readonly failureBefore?: AnthropicTransportFailure;
  readonly failureAt?: number;
  readonly holdAt?: number;
  readonly inspect?: (request: AnthropicTransportRequest) => void;
}

export interface SafeObservation {
  readonly operation: "policy" | "credential" | "transport" | "transport-close";
  readonly requestFingerprint: string | null;
}

export interface FakePorts {
  readonly ports: AnthropicTestingPorts;
  readonly time: ManualTime;
  readonly observations: readonly SafeObservation[];
  release(): void;
}

export function fakePorts(options: {
  readonly script: FakeTransportScript;
  readonly authorize?: (request: AnthropicAuthorizationRequest) => boolean;
  readonly observer?: ProviderObserver;
}): FakePorts {
  const time = new ManualTime();
  const observations: SafeObservation[] = [];
  let releaseHold: (() => void) | null = null;
  let closed = false;
  const release = (): void => {
    const current = releaseHold;
    releaseHold = null;
    current?.();
  };
  const transport: AnthropicTransport = Object.freeze({
    kind: "deterministic-fake" as const,
    async open(request: AnthropicTransportRequest, secretText: string) {
      observations.push(Object.freeze({ operation: "transport", requestFingerprint: request.requestFingerprint }));
      if (secretText !== PLACEHOLDER_SECRET) throw new Error("unexpected test secret placeholder");
      options.script.inspect?.(request);
      if (options.script.failureBefore !== undefined) throw options.script.failureBefore;
      const events = options.script.events ?? [];
      return Object.freeze({
        events: Object.freeze({
          async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
            for (let index = 0; index < events.length; index += 1) {
              if (request.signal.aborted || closed) return;
              if (options.script.holdAt === index) {
                await new Promise<void>((resolve) => {
                  releaseHold = resolve;
                  request.signal.addEventListener("abort", resolve, { once: true });
                });
                if (request.signal.aborted || closed) return;
              }
              if (options.script.failureAt === index) {
                throw new AnthropicTransportFailure("connection_error");
              }
              yield events[index];
            }
          },
        }),
      });
    },
    async close(): Promise<void> {
      closed = true;
      release();
      observations.push(Object.freeze({ operation: "transport-close", requestFingerprint: null }));
    },
  });
  const ports: AnthropicTestingPorts = Object.freeze({
    clock: time,
    timer: time,
    policy: Object.freeze({
      async authorize(request: AnthropicAuthorizationRequest) {
        observations.push(Object.freeze({ operation: "policy", requestFingerprint: request.requestFingerprint }));
        const allowed = options.authorize?.(request) ?? true;
        return Object.freeze({
          allowed,
          code: allowed ? "test-policy-allowed" : "test-policy-denied",
          decisionFingerprint: allowed ? "a".repeat(64) : null,
          retentionAllowed: allowed,
        });
      },
    }),
    credentials: Object.freeze({
      async withApiKey<T>(request: AnthropicCredentialRequest, use: (secretText: string) => Promise<T>): Promise<T> {
        observations.push(Object.freeze({ operation: "credential", requestFingerprint: request.policyDecisionFingerprint }));
        return use(PLACEHOLDER_SECRET);
      },
    }),
    transport,
    ...(options.observer === undefined ? {} : { observer: options.observer }),
  });
  return Object.freeze({
    ports,
    time,
    get observations(): readonly SafeObservation[] { return Object.freeze([...observations]); },
    release,
  });
}

export function configuration(options: {
  readonly toolUse?: boolean;
  readonly structuredOutput?: boolean;
  readonly retentionMode?: "standard-30-day" | "contracted-zero";
  readonly bounds?: Partial<AnthropicAdapterConfiguration["bounds"]>;
} = {}): AnthropicAdapterConfiguration {
  return createAnthropicAdapterConfiguration({
    instanceId: "anthropic:test",
    model: {
      alias: MODEL_ALIAS,
      responseModelId: RESPONSE_MODEL_ID,
      capabilities: createModelCapabilities({
        providerId: "anthropic",
        modelId: MODEL_ALIAS,
        contextWindowTokens: 200_000,
        maxOutputTokens: 8_192,
        supportsToolUse: options.toolUse ?? true,
        supportsStructuredOutput: options.structuredOutput ?? true,
        supportsVision: false,
        locality: "cloud",
        latencyClass: "standard",
        codingCapability: 4,
        reasoningCapability: 5,
        cost: null,
      }),
    },
    apiKeyRef: {
      schemaVersion: 1,
      type: "named",
      namespace: "provider",
      version: "version:1",
      expectedKind: "text",
      providerInstanceId: "anthropic:test",
      name: "anthropic-test-placeholder",
    },
    retention: {
      mode: options.retentionMode ?? "contracted-zero",
      promptCachingAllowed: false,
      filesAllowed: false,
      serverToolsAllowed: false,
      trainsOnInputs: false,
    },
    ...(options.bounds === undefined ? {} : { bounds: options.bounds }),
    supportedClassifications: ["public", "internal", "proprietary-source", "personal"],
  });
}

export function request(
  name: string,
  overrides: Partial<Parameters<typeof createInferenceRequest>[0]> = {},
): InferenceRequest {
  return createInferenceRequest({
    requestId: `request:${name}`,
    modelId: MODEL_ALIAS,
    messages: [{ role: "user", parts: [{ type: "text", text: `scenario ${name}` }] }],
    disclosure: INTERNAL_DISCLOSURE,
    trace: TESTKIT_TRACE,
    maxOutputTokens: 512,
    deadline: "2026-08-03T12:00:00.000Z",
    ...overrides,
  });
}

export function noRetentionDisclosure() {
  return parseDisclosureContext({
    classification: "internal",
    requiredLocality: "any",
    redactionApplied: true,
    decisionRef: null,
    retentionAllowed: false,
    loggingAllowed: false,
  });
}

export function messageStart(options: {
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
} = {}) {
  return {
    type: "message_start",
    message: {
      id: "message:test",
      type: "message",
      role: "assistant",
      content: [],
      model: options.model ?? RESPONSE_MODEL_ID,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: options.inputTokens ?? 10,
        output_tokens: options.outputTokens ?? 0,
        cache_creation_input_tokens: options.cacheCreationInputTokens ?? 0,
        cache_read_input_tokens: options.cacheReadInputTokens ?? 0,
      },
    },
  };
}

export function textStart(index = 0, text = "") {
  return { type: "content_block_start", index, content_block: { type: "text", text } };
}

export function textDelta(text: string, index = 0) {
  return { type: "content_block_delta", index, delta: { type: "text_delta", text } };
}

export function toolStart(id: string, name: string, index = 0) {
  return { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } };
}

export function toolDelta(partialJson: string, index = 0) {
  return { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: partialJson } };
}

export function blockStop(index = 0) {
  return { type: "content_block_stop", index };
}

export function messageDelta(stopReason: string, outputTokens = 5, thinkingTokens?: number) {
  return {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: {
      output_tokens: outputTokens,
      ...(thinkingTokens === undefined ? {} : { output_tokens_details: { thinking_tokens: thinkingTokens } }),
    },
  };
}

export const messageStop = Object.freeze({ type: "message_stop" });

export function textScript(chunks: readonly string[], options: {
  readonly stopReason?: string;
  readonly model?: string;
  readonly usageUpdates?: readonly number[];
} = {}): readonly unknown[] {
  const events: unknown[] = [messageStart({ model: options.model }), textStart()];
  events.push(...chunks.map((chunk) => textDelta(chunk)));
  events.push(blockStop());
  for (const usage of options.usageUpdates ?? []) events.push(messageDelta(options.stopReason ?? "end_turn", usage));
  if ((options.usageUpdates?.length ?? 0) === 0) events.push(messageDelta(options.stopReason ?? "end_turn", 5));
  events.push(messageStop);
  return Object.freeze(events);
}

export const READ_TOOL = Object.freeze({
  name: "read-file",
  description: "Read one file by logical path.",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } as JsonObject,
  risk: "read-only" as const,
  approval: "never" as const,
  executionLocation: "caller" as const,
});
