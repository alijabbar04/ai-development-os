import { ProviderError, type InferenceEvent, type InferenceRequest } from "@ai-dev-os/providers";
import { TESTKIT_SECRET_CANARY } from "@ai-dev-os/provider-testkit";
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_MESSAGES_ENDPOINT,
  AnthropicTransportFailure,
  createProductionDisabledAnthropicProvider,
} from "../src/index.js";
import { createAnthropicProviderForTesting, type AnthropicTestingPorts } from "../src/testing/index.js";
import {
  READ_TOOL,
  blockStop,
  configuration,
  fakePorts,
  messageDelta,
  messageStart,
  messageStop,
  noRetentionDisclosure,
  request,
  textDelta,
  textScript,
  textStart,
  toolDelta,
  toolStart,
  type FakeTransportScript,
} from "./helpers.js";

async function failedOperation(options: {
  readonly script: FakeTransportScript;
  readonly value?: InferenceRequest;
  readonly config?: ReturnType<typeof configuration>;
}): Promise<{ readonly error: ProviderError; readonly events: readonly InferenceEvent[] }> {
  const fake = fakePorts({ script: options.script });
  const provider = createAnthropicProviderForTesting({
    configuration: options.config ?? configuration(),
    ports: fake.ports,
  });
  try {
    const operation = await provider.start(options.value ?? request("failure"));
    const settled = operation.result.catch((error: unknown) => error);
    const events: InferenceEvent[] = [];
    for await (const event of operation.events()) events.push(event);
    const error = await settled;
    expect(error).toBeInstanceOf(ProviderError);
    return { error: error as ProviderError, events };
  } finally {
    fake.release();
    await provider.close();
  }
}

describe("Anthropic preflight and redaction", () => {
  it("refuses production before policy, credential, or transport authority exists", async () => {
    const provider = createProductionDisabledAnthropicProvider({ configuration: configuration() });
    expect(provider.describe().displayName).toContain("production-disabled");
    expect(provider.describe().capabilities.pricingAvailable).toBe(false);
    expect((await provider.health()).status).toBe("unavailable");
    expect((await provider.listModels())[0]?.availability).toBe("unavailable");
    await expect(provider.start(request("production-disabled"))).rejects.toMatchObject({
      code: "POLICY_DENIED",
      details: { ruleId: "anthropic.stage18b.production-disabled" },
    });
    await provider.close();
    await expect(provider.listModels()).rejects.toMatchObject({ code: "PROVIDER_CLOSED" });
  });

  it("orders policy before credential before transport and passes only fixed metadata", async () => {
    let inspected = false;
    const fake = fakePorts({ script: {
      events: textScript(["ok"]),
      inspect(value) {
        inspected = true;
        expect(value.endpoint).toBe(ANTHROPIC_MESSAGES_ENDPOINT);
        expect(value.apiVersion).toBe(ANTHROPIC_API_VERSION);
        expect(value.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(value)).not.toContain(TESTKIT_SECRET_CANARY);
      },
    } });
    const provider = createAnthropicProviderForTesting({ configuration: configuration(), ports: fake.ports });
    await (await provider.start(request("ordering"))).result;
    expect(fake.observations.map((item) => item.operation).slice(0, 3)).toEqual([
      "policy", "credential", "transport",
    ]);
    expect(inspected).toBe(true);
    await provider.close();
  });

  it("fails policy denial before credential and transport", async () => {
    const fake = fakePorts({ script: { events: [] }, authorize: () => false });
    const provider = createAnthropicProviderForTesting({ configuration: configuration(), ports: fake.ports });
    await expect(provider.start(request("denied"))).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(fake.observations).toEqual([{ operation: "policy", requestFingerprint: expect.any(String) }]);
    await provider.close();
  });

  it("fails a retention mismatch before policy and all effect ports", async () => {
    const fake = fakePorts({ script: { events: [] } });
    const provider = createAnthropicProviderForTesting({
      configuration: configuration({ retentionMode: "standard-30-day" }),
      ports: fake.ports,
    });
    await expect(provider.start(request("retention", { disclosure: noRetentionDisclosure() })))
      .rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(fake.observations).toEqual([]);
    await provider.close();
  });

  it("rejects malformed or throwing policy decisions without retaining their text", async () => {
    for (const policy of [
      { authorize: async () => ({ allowed: true, code: TESTKIT_SECRET_CANARY }) as never },
      { authorize: async () => ({
        allowed: false,
        code: TESTKIT_SECRET_CANARY,
        decisionFingerprint: null,
        retentionAllowed: false,
      }) },
      { authorize: async () => { throw new Error(TESTKIT_SECRET_CANARY); } },
    ]) {
      const fake = fakePorts({ script: { events: [] } });
      const ports = Object.freeze({ ...fake.ports, policy }) as AnthropicTestingPorts;
      const provider = createAnthropicProviderForTesting({ configuration: configuration(), ports });
      const error = await provider.start(request("bad-policy")).catch((value: unknown) => value) as ProviderError;
      expect(error.code).toBe("POLICY_DENIED");
      expect(JSON.stringify(error.toJSON())).not.toContain(TESTKIT_SECRET_CANARY);
      expect(fake.observations).toEqual([]);
      await provider.close();
    }
  });

  it("redacts errors thrown by credential ports", async () => {
    const fake = fakePorts({ script: { events: [] } });
    const ports = Object.freeze({
      ...fake.ports,
      credentials: Object.freeze({
        async withApiKey(): Promise<never> {
          throw new ProviderError("AUTHENTICATION_FAILED", TESTKIT_SECRET_CANARY, { leaked: TESTKIT_SECRET_CANARY });
        },
      }),
    }) as AnthropicTestingPorts;
    const provider = createAnthropicProviderForTesting({ configuration: configuration(), ports });
    const error = await provider.start(request("credential-redaction")).catch((value: unknown) => value) as ProviderError;
    expect(error.code).toBe("AUTHENTICATION_FAILED");
    expect(JSON.stringify(error.toJSON())).not.toContain(TESTKIT_SECRET_CANARY);
    expect(fake.observations.map((item) => item.operation)).toEqual(["policy"]);
    await provider.close();
  });

  it("redacts arbitrary error names thrown while parsing caller input", async () => {
    const fake = fakePorts({ script: { events: [] } });
    const named = new Error("redacted");
    named.name = TESTKIT_SECRET_CANARY;
    const hostile = JSON.parse(JSON.stringify(request("hostile-parser"))) as Record<string, unknown>;
    Object.defineProperty(hostile, "requestId", { enumerable: true, get: () => { throw named; } });
    const provider = createAnthropicProviderForTesting({ configuration: configuration(), ports: fake.ports });
    const error = await provider.start(hostile as unknown as InferenceRequest).catch((value: unknown) => value) as ProviderError;
    expect(error.code).toBe("INVALID_REQUEST");
    expect(JSON.stringify(error.toJSON())).not.toContain(TESTKIT_SECRET_CANARY);
    expect(fake.observations).toEqual([]);
    await provider.close();
  });

  it("cancels, times out, and closes policy preflight even when the policy promise never settles", async () => {
    for (const mode of ["cancel", "deadline", "close"] as const) {
      const fake = fakePorts({ script: { events: [] } });
      let inspected = false;
      const ports = Object.freeze({
        ...fake.ports,
        policy: Object.freeze({
          async authorize(value: Parameters<AnthropicTestingPorts["policy"]["authorize"]>[0]): Promise<never> {
            inspected = value.signal.aborted === false && value.deadline !== null;
            return new Promise<never>(() => undefined);
          },
        }),
      }) as AnthropicTestingPorts;
      const provider = createAnthropicProviderForTesting({
        configuration: configuration({ bounds: { maximumWallTimeMs: 1_000 } }),
        ports,
      });
      const controller = new AbortController();
      const start = provider.start(request(`hung-policy-${mode}`, {
        deadline: new Date(fake.time.now().valueOf() + 100).toISOString(),
      }), { signal: controller.signal });
      await Promise.resolve();
      let closing: Promise<void> | null = null;
      if (mode === "cancel") controller.abort();
      if (mode === "deadline") fake.time.advance(100);
      if (mode === "close") closing = provider.close();
      await expect(start).rejects.toMatchObject({
        code: mode === "cancel" ? "CANCELLED" : mode === "deadline" ? "DEADLINE_EXCEEDED" : "PROVIDER_CLOSED",
      });
      expect(inspected).toBe(true);
      await closing;
      await provider.close();
    }
  });

  it("closes and settles credential preflight when the credential port ignores abort", async () => {
    const fake = fakePorts({ script: { events: [] } });
    let invokeLate: (() => Promise<unknown>) | null = null;
    const ports = Object.freeze({
      ...fake.ports,
      credentials: Object.freeze({
        async withApiKey<T>(_request: unknown, use: (secretText: string) => Promise<T>): Promise<T> {
          return new Promise<T>((resolve, reject) => {
            invokeLate = async () => use("late-secret").then(resolve, reject);
          });
        },
      }),
    }) as AnthropicTestingPorts;
    const provider = createAnthropicProviderForTesting({ configuration: configuration(), ports });
    const start = provider.start(request("hung-credential"));
    await Promise.resolve();
    await Promise.resolve();
    const closing = provider.close();
    await expect(start).rejects.toMatchObject({ code: "PROVIDER_CLOSED" });
    await closing;
    await invokeLate?.().catch(() => undefined);
    expect(fake.observations.some((item) => item.operation === "transport")).toBe(false);
  });

  it("rejects alias, locality, classification, capability, and output limits before policy", async () => {
    const cases: Array<{ readonly value: InferenceRequest; readonly config?: ReturnType<typeof configuration>; readonly code: string }> = [
      { value: request("alias", { modelId: "anthropic:other" }), code: "MODEL_UNAVAILABLE" },
      { value: request("local", { disclosure: { ...noRetentionDisclosure(), requiredLocality: "local-only" } }), code: "POLICY_DENIED" },
      { value: request("class", { disclosure: { ...noRetentionDisclosure(), classification: "secret" } }), code: "POLICY_DENIED" },
      { value: request("tools", { tools: [READ_TOOL] }), config: configuration({ toolUse: false }), code: "UNSUPPORTED_CAPABILITY" },
      { value: request("structured", { structuredOutput: { schema: { type: "object" }, strict: true } }), config: configuration({ structuredOutput: false }), code: "UNSUPPORTED_CAPABILITY" },
      { value: request("malformed-schema", { structuredOutput: { schema: { type: "object", properties: "invalid" }, strict: true } }), code: "INVALID_REQUEST" },
      { value: request("output", { maxOutputTokens: 9_000 }), code: "UNSUPPORTED_CAPABILITY" },
    ];
    for (const item of cases) {
      const fake = fakePorts({ script: { events: [] } });
      const provider = createAnthropicProviderForTesting({ configuration: item.config ?? configuration(), ports: fake.ports });
      await expect(provider.start(item.value)).rejects.toMatchObject({ code: item.code });
      expect(fake.observations).toEqual([]);
      await provider.close();
    }
  });
});

describe("Anthropic stream state machine", () => {
  it.each([
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["max_tokens", "length"],
    ["model_context_window_exceeded", "length"],
    ["refusal", "refusal"],
  ] as const)("maps %s completion and accepts initial text content", async (stopReason, finishReason) => {
    const fake = fakePorts({ script: { events: [
      messageStart(), textStart(0, "initial"), blockStop(), messageDelta(stopReason), messageStop,
    ] } });
    const provider = createAnthropicProviderForTesting({ configuration: configuration(), ports: fake.ports });
    const result = await (await provider.start(request(`finish-${stopReason}`))).result;
    expect(result.finishReason).toBe(finishReason);
    expect(result.refusalMessage === null).toBe(stopReason !== "refusal");
    await provider.close();
  });

  it("rejects model substitution", async () => {
    const result = await failedOperation({ script: { events: textScript(["x"], { model: TESTKIT_SECRET_CANARY }) } });
    expect(result.error.code).toBe("PROTOCOL_VIOLATION");
    expect(JSON.stringify(result.error.toJSON())).not.toContain(TESTKIT_SECRET_CANARY);
  });

  it("redacts unsupported stop reasons and undeclared tool names", async () => {
    const stop = await failedOperation({ script: { events: [
      messageStart(), textStart(), blockStop(), messageDelta(TESTKIT_SECRET_CANARY), messageStop,
    ] } });
    expect(stop.error.code).toBe("PROTOCOL_VIOLATION");
    expect(JSON.stringify(stop.error.toJSON())).not.toContain(TESTKIT_SECRET_CANARY);
    const tool = await failedOperation({ script: { events: [
      messageStart(), toolStart("tool:one", TESTKIT_SECRET_CANARY),
    ] } });
    expect(tool.error.code).toBe("TOOL_PROTOCOL_FAILURE");
    expect(JSON.stringify(tool.error.toJSON())).not.toContain(TESTKIT_SECRET_CANARY);
  });

  it("does not serialize a declared tool name when its streamed arguments are malformed", async () => {
    const toolName = "secret-canary-tool";
    const result = await failedOperation({
      value: request("tool-argument-redaction", { tools: [{ ...READ_TOOL, name: toolName }] }),
      script: { events: [
        messageStart(), toolStart("tool:one", toolName), toolDelta("{"), blockStop(),
      ] },
    });
    expect(result.error.code).toBe("TOOL_PROTOCOL_FAILURE");
    expect(JSON.stringify(result.error.toJSON())).not.toContain(toolName);
  });

  it.each([
    ["partial", [messageStart(), textStart(), textDelta("partial")]],
    ["reordered", [textStart(), messageStart()]],
    ["duplicate-start", [messageStart(), messageStart()]],
    ["duplicate-block", [messageStart(), textStart(), textStart()]],
    ["duplicate-terminal", [...textScript(["ok"]), messageStop]],
    ["post-terminal-ping", [...textScript(["ok"]), { type: "ping" }]],
    ["malformed", [messageStart(), { type: "content_block_start", index: 0, content_block: { type: "text" } }]],
    ["out-of-index", [messageStart(), textStart(1)]],
    ["concurrent-block", [messageStart(), textStart(0), textStart(1)]],
    ["duplicate-message-delta", [messageStart(), textStart(), blockStop(), messageDelta("end_turn"), messageDelta("end_turn"), messageStop]],
    ["content-after-message-delta", [messageStart(), textStart(), blockStop(), messageDelta("end_turn"), textStart(1), blockStop(1), messageStop]],
  ] as const)("fails closed for %s streams", async (_name, events) => {
    const result = await failedOperation({ script: { events } });
    expect(result.error.code).toBe("PROTOCOL_VIOLATION");
    expect(result.events.at(-1)?.kind).toBe("operation-failed");
  });

  it("classifies a non-JSON wire value as protocol failure", async () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const result = await failedOperation({ script: { events: [cyclic] } });
    expect(result.error.code).toBe("PROTOCOL_VIOLATION");
  });

  it.each([
    ["events", configuration({ bounds: { maximumStreamEvents: 1 } }), textScript(["x"])],
    ["wire", configuration({ bounds: { maximumWireBytes: 1_024 } }), [messageStart(), textStart(), textDelta("x".repeat(2_000))]],
    ["output", configuration({ bounds: { maximumOutputBytes: 1 } }), textScript(["xx"])],
    ["tool-arguments", configuration({ bounds: { maximumToolArgumentBytes: 2 } }), [messageStart(), toolStart("tool:one", "read-file"), toolDelta("{\"x\":1}"), blockStop(), messageDelta("tool_use"), messageStop]],
  ] as const)("enforces the %s bound", async (_name, config, events) => {
    const result = await failedOperation({
      config,
      script: { events },
      value: _name === "tool-arguments" ? request("tool-bound", { tools: [READ_TOOL] }) : undefined,
    });
    expect(["PROTOCOL_VIOLATION", "TOOL_PROTOCOL_FAILURE"]).toContain(result.error.code);
  });

  it("rejects malformed structured output", async () => {
    const result = await failedOperation({
      script: { events: textScript(["not-json"]) },
      value: request("structured-malformed", { structuredOutput: { schema: { type: "object" }, strict: true } }),
    });
    expect(result.error.code).toBe("MALFORMED_RESPONSE");
  });

  it("rejects JSON structured output that does not satisfy the caller schema", async () => {
    const result = await failedOperation({
      script: { events: textScript(["{}"]), },
      value: request("structured-schema-mismatch", {
        structuredOutput: {
          schema: { type: "object", required: ["answer"], properties: { answer: { type: "integer" } }, additionalProperties: false },
          strict: true,
        },
      }),
    });
    expect(result.error.code).toBe("MALFORMED_RESPONSE");
  });

  it("reserves tool IDs at open and bounds initial tool input", async () => {
    const duplicate = await failedOperation({
      value: request("duplicate-open-tool", { tools: [READ_TOOL] }),
      script: { events: [
        messageStart(), toolStart("tool:same", "read-file", 0), blockStop(0),
        toolStart("tool:same", "read-file", 1),
      ] },
    });
    expect(duplicate.error.code).toBe("TOOL_PROTOCOL_FAILURE");
    const oversized = await failedOperation({
      config: configuration({ bounds: { maximumToolArgumentBytes: 2 } }),
      value: request("initial-tool-bound", { tools: [READ_TOOL] }),
      script: { events: [
        messageStart(),
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool:one", name: "read-file", input: { path: "long" } } },
      ] },
    });
    expect(oversized.error.code).toBe("TOOL_PROTOCOL_FAILURE");
  });

  it.each([
    ["missing-input", [{ ...messageStart(), message: { ...messageStart().message, usage: { output_tokens: 0 } } }, textStart(), textDelta("x"), blockStop(), messageDelta("end_turn"), messageStop]],
    ["missing-output", [{ ...messageStart(), message: { ...messageStart().message, usage: { input_tokens: 10 } } }, textStart(), textDelta("x"), blockStop(), { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }, messageStop]],
    ["decreasing", [
      { ...messageStart(), message: { ...messageStart().message, usage: { output_tokens: 5 } } },
      textStart(), textDelta("x"), blockStop(), messageDelta("end_turn", 4), messageStop,
    ]],
    ["thinking-over-output", [messageStart(), textStart(), textDelta("x"), blockStop(), messageDelta("end_turn", 2, 3), messageStop]],
  ] as const)("rejects %s usage", async (_name, events) => {
    const result = await failedOperation({ script: { events } });
    expect(result.error.code).toBe("PROTOCOL_VIOLATION");
  });

  it("maps cache creation, cache reads, and thinking into disjoint usage", async () => {
    const fake = fakePorts({ script: { events: [
      messageStart({ inputTokens: 10, cacheCreationInputTokens: 3, cacheReadInputTokens: 4 }),
      textStart(), textDelta("ok"), blockStop(), messageDelta("end_turn", 7, 2), messageStop,
    ] } });
    const provider = createAnthropicProviderForTesting({ configuration: configuration(), ports: fake.ports });
    const result = await (await provider.start(request("usage-map"))).result;
    expect(result.usage.tokens).toEqual({
      inputTokens: 13,
      cachedInputTokens: 4,
      outputTokens: 5,
      reasoningTokens: 2,
    });
    await provider.close();
  });

  it.each([
    ["invalid_request_error", "INVALID_REQUEST"],
    ["authentication_error", "AUTHENTICATION_FAILED"],
    ["permission_error", "AUTHORIZATION_FAILED"],
    ["not_found_error", "MODEL_UNAVAILABLE"],
    ["request_too_large", "INVALID_REQUEST"],
    ["rate_limit_error", "RATE_LIMITED"],
    ["api_error", "NETWORK_FAILURE"],
    ["timeout_error", "TIMEOUT"],
    ["overloaded_error", "PROVIDER_OVERLOADED"],
    ["connection_error", "NETWORK_FAILURE"],
  ] as const)("maps %s transport failures", async (kind, code) => {
    const fake = fakePorts({ script: { failureBefore: new AnthropicTransportFailure(kind, { status: kind === "rate_limit_error" ? 429 : 500, retryAfterMs: 1_500 }) } });
    const provider = createAnthropicProviderForTesting({ configuration: configuration(), ports: fake.ports });
    const error = await provider.start(request(`transport-${kind}`)).catch((value: unknown) => value) as ProviderError;
    expect(error.code).toBe(code);
    if (kind === "rate_limit_error") {
      expect(error.retryAfterMs).toBe(1_500);
      expect(error.retry.strategy).toBe("same-after-delay");
    }
    await provider.close();
  });

  it("maps disconnects and redacts provider error messages mid-stream", async () => {
    const disconnected = await failedOperation({ script: { events: [messageStart(), textStart()], failureAt: 1 } });
    expect(disconnected.error.code).toBe("NETWORK_FAILURE");
    const remote = await failedOperation({ script: { events: [messageStart(), { type: "error", error: { type: "overloaded_error", message: TESTKIT_SECRET_CANARY } }] } });
    expect(remote.error.code).toBe("PROVIDER_OVERLOADED");
    expect(JSON.stringify(remote.error.toJSON())).not.toContain(TESTKIT_SECRET_CANARY);
    const unknown = await failedOperation({ script: { events: [messageStart(), { type: "error", error: { type: "invented_remote_class", message: TESTKIT_SECRET_CANARY } }] } });
    expect(unknown.error.code).toBe("PROTOCOL_VIOLATION");
    expect(unknown.error.details).toMatchObject({ transportKind: "unknown" });
    expect(JSON.stringify(unknown.error.toJSON())).not.toContain(TESTKIT_SECRET_CANARY);
  });

  it("redacts arbitrary names on unclassified transport failures", async () => {
    const fake = fakePorts({ script: { events: [] } });
    const named = new Error("redacted");
    named.name = TESTKIT_SECRET_CANARY;
    const ports = Object.freeze({
      ...fake.ports,
      transport: Object.freeze({
        ...fake.ports.transport,
        kind: "deterministic-fake" as const,
        async open(): Promise<never> { throw named; },
      }),
    }) as AnthropicTestingPorts;
    const provider = createAnthropicProviderForTesting({ configuration: configuration(), ports });
    const error = await provider.start(request("named-transport")).catch((value: unknown) => value) as ProviderError;
    expect(error.code).toBe("NETWORK_FAILURE");
    expect(JSON.stringify(error.toJSON())).not.toContain(TESTKIT_SECRET_CANARY);
    await provider.close();
  });

  it("makes cancellation win a held-stream race exactly once", async () => {
    const fake = fakePorts({ script: { events: textScript(["before", "after"]), holdAt: 3 } });
    const provider = createAnthropicProviderForTesting({ configuration: configuration(), ports: fake.ports });
    const operation = await provider.start(request("cancel"));
    await Promise.resolve();
    await operation.cancel("caller-requested");
    fake.time.advance(60 * 60_000);
    fake.release();
    await expect(operation.result).rejects.toMatchObject({ code: "CANCELLED" });
    const events: InferenceEvent[] = [];
    for await (const event of operation.events()) events.push(event);
    expect(events.filter((event) => event.kind.startsWith("operation-")).at(-1)?.kind).toBe("operation-cancelled");
    expect(events.filter((event) => ["operation-completed", "operation-failed", "operation-cancelled"].includes(event.kind))).toHaveLength(1);
    await provider.close();
  });

  it("enforces wall timeout and caller deadline on held streams", async () => {
    for (const deadlineWins of [false, true]) {
      const fake = fakePorts({ script: { events: textScript(["before", "after"]), holdAt: 3 } });
      const provider = createAnthropicProviderForTesting({
        configuration: configuration({ bounds: { maximumWallTimeMs: deadlineWins ? 10_000 : 100 } }),
        ports: fake.ports,
      });
      const value = request(`timeout-${deadlineWins}`, {
        deadline: new Date(fake.time.now().valueOf() + (deadlineWins ? 100 : 10_000)).toISOString(),
      });
      const operation = await provider.start(value);
      await Promise.resolve();
      fake.time.advance(100);
      await expect(operation.result).rejects.toMatchObject({ code: deadlineWins ? "DEADLINE_EXCEEDED" : "TIMEOUT" });
      fake.release();
      await provider.close();
    }
  });
});
