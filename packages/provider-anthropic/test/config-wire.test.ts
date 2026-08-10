import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_ADAPTER_SCHEMA_VERSION,
  ANTHROPIC_API_VERSION,
  ANTHROPIC_MESSAGES_ENDPOINT,
  ANTHROPIC_PRODUCTION_ENABLED,
  anthropicConfigurationFingerprint,
  buildAnthropicRequestBody,
  parseAnthropicAdapterConfiguration,
  parseAnthropicWireEvent,
} from "../src/index.js";
import {
  READ_TOOL,
  configuration,
  messageStart,
  request,
  textDelta,
  textStart,
} from "./helpers.js";

describe("Anthropic configuration", () => {
  it("pins the endpoint, API version, schema, and production gate", () => {
    const value = configuration();
    expect(value.schemaVersion).toBe(ANTHROPIC_ADAPTER_SCHEMA_VERSION);
    expect(value.endpoint).toBe(ANTHROPIC_MESSAGES_ENDPOINT);
    expect(value.apiVersion).toBe(ANTHROPIC_API_VERSION);
    expect(ANTHROPIC_PRODUCTION_ENABLED).toBe(false);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.model)).toBe(true);
  });

  it("produces a stable canonical fingerprint and binds meaningful changes", () => {
    const first = configuration();
    const clone = JSON.parse(JSON.stringify(first));
    expect(anthropicConfigurationFingerprint(parseAnthropicAdapterConfiguration(clone)))
      .toBe(anthropicConfigurationFingerprint(first));
    expect(anthropicConfigurationFingerprint(configuration({ retentionMode: "standard-30-day" })))
      .not.toBe(anthropicConfigurationFingerprint(first));
    expect(anthropicConfigurationFingerprint(first)).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["endpoint", "https://example.invalid/v1/messages"],
    ["apiVersion", "2099-01-01"],
    ["schemaVersion", 2],
  ])("rejects an unreviewed %s", (field, value) => {
    expect(() => parseAnthropicAdapterConfiguration({
      ...configuration(),
      [field]: value,
    })).toThrow();
  });

  it("rejects unknown keys, mismatched catalog identity, secret scope, and retention features", () => {
    const base = configuration();
    expect(() => parseAnthropicAdapterConfiguration({ ...base, extra: true })).toThrow();
    expect(() => parseAnthropicAdapterConfiguration({
      ...base,
      model: { ...base.model, capabilities: { ...base.model.capabilities, providerId: "other" } },
    })).toThrow();
    expect(() => parseAnthropicAdapterConfiguration({
      ...base,
      apiKeyRef: { ...base.apiKeyRef, providerInstanceId: "anthropic:other" },
    })).toThrow();
    expect(() => parseAnthropicAdapterConfiguration({
      ...base,
      retention: { ...base.retention, promptCachingAllowed: true },
    })).toThrow();
    expect(() => parseAnthropicAdapterConfiguration({
      ...base,
      model: {
        ...base.model,
        capabilities: {
          ...base.model.capabilities,
          cost: {
            currency: "USD",
            inputMicrosPerMillionTokens: 1,
            outputMicrosPerMillionTokens: 1,
            cachedInputMicrosPerMillionTokens: null,
          },
        },
      },
    })).toThrow();
  });

  it("enforces finite hard configuration bounds", () => {
    const base = configuration();
    for (const [field, value] of [
      ["maximumStreamEvents", 10_001],
      ["maximumWireBytes", 1_023],
      ["maximumOutputBytes", 0],
      ["maximumToolArgumentBytes", 1],
      ["maximumWallTimeMs", 86_400_001],
    ] as const) {
      expect(() => parseAnthropicAdapterConfiguration({
        ...base,
        bounds: { ...base.bounds, [field]: value },
      })).toThrow();
    }
    expect(() => parseAnthropicAdapterConfiguration({
      ...base,
      supportedClassifications: [],
    })).toThrow();
  });
});

describe("Anthropic request and wire mapping", () => {
  it("maps preamble, JSON, tools, results, sampling, stops, and structured output", () => {
    const body = buildAnthropicRequestBody(request("mapping", {
      messages: [
        { role: "system", parts: [{ type: "text", text: "system" }] },
        { role: "developer", parts: [{ type: "json", value: { policy: true } }] },
        { role: "user", parts: [{ type: "text", text: "question" }] },
        { role: "assistant", parts: [{ type: "tool-invocation", invocation: { toolCallId: "call:one", toolName: "read-file", arguments: { path: "a.ts" } } }] },
        { role: "tool", parts: [{ type: "tool-result", result: { toolCallId: "call:one", toolName: "read-file", status: "succeeded", output: { contents: "ok" }, failure: null } }] },
      ],
      tools: [READ_TOOL],
      toolChoice: { mode: "named", toolName: "read-file" },
      structuredOutput: { schema: { type: "object" }, strict: true },
      sampling: { temperature: 0.4, topP: 0.8, seed: null },
      stopSequences: ["DONE"],
    }), configuration());

    expect(body).toMatchObject({
      model: configuration().model.responseModelId,
      max_tokens: 512,
      stream: true,
      stop_sequences: ["DONE"],
      temperature: 0.4,
      top_p: 0.8,
      tool_choice: { type: "tool", name: "read-file" },
      output_config: { format: { type: "json_schema", schema: { type: "object" } } },
    });
    expect(body["system"]).toEqual([
      { type: "text", text: "system" },
      { type: "text", text: "{\"policy\":true}" },
    ]);
    expect(body["tools"]).toEqual([{
      name: "read-file",
      description: READ_TOOL.description,
      input_schema: READ_TOOL.inputSchema,
      strict: true,
    }]);
    expect(body["messages"]).toEqual([
      { role: "user", content: [{ type: "text", text: "question" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call:one", name: "read-file", input: { path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call:one", content: "{\"contents\":\"ok\"}", is_error: false }] },
    ]);
  });

  it.each([
    request("seed", { sampling: { temperature: null, topP: null, seed: 7 } }),
    request("extension", { extensions: [{ namespace: "anthropic", key: "unknown", value: true }] }),
    request("artifact", { messages: [{ role: "user", parts: [{ type: "artifact", artifactId: "artifact:one", mediaType: "text/plain" }] }] }),
    request("server-tool", { tools: [{ ...READ_TOOL, executionLocation: "provider" }] }),
  ])("refuses unsupported request surface %#", (value) => {
    expect(() => buildAnthropicRequestBody(value, configuration())).toThrowError(expect.objectContaining({
      code: "UNSUPPORTED_CAPABILITY",
    }));
  });

  it("refuses Anthropic temperatures above its supported maximum", () => {
    expect(() => buildAnthropicRequestBody(request("temperature", {
      sampling: { temperature: 1.1, topP: null, seed: null },
    }), configuration())).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_CAPABILITY" }));
  });

  it("does not serialize rejected caller tool names", () => {
    const toolName = "secret-canary-tool";
    try {
      buildAnthropicRequestBody(request("server-tool-redaction", {
        tools: [{ ...READ_TOOL, name: toolName, executionLocation: "provider" }],
      }), configuration());
      throw new Error("expected unsupported tool rejection");
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(toolName);
      expect(error).toMatchObject({ code: "UNSUPPORTED_CAPABILITY", details: {} });
    }
  });

  it("parses the reviewed stream vocabulary into frozen internal events", () => {
    expect(parseAnthropicWireEvent(messageStart())).toMatchObject({
      type: "message_start",
      message: { usage: { inputTokens: 10, outputTokens: 0 } },
    });
    expect(parseAnthropicWireEvent(textStart())).toEqual({
      type: "content_block_start",
      index: 0,
      contentBlock: { type: "text", text: "" },
    });
    expect(parseAnthropicWireEvent(textDelta("x"))).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "x" },
    });
    expect(Object.isFrozen(parseAnthropicWireEvent({ type: "ping" }))).toBe(true);
  });

  it.each([
    null,
    { type: "unknown" },
    { type: "ping", extra: true },
    { type: "content_block_stop", index: 64 },
    { type: "content_block_delta", index: 0, delta: { type: "other" } },
    { type: "message_start", message: { ...messageStart().message, role: "user" } },
  ])("rejects malformed wire input %#", (value) => {
    expect(() => parseAnthropicWireEvent(value)).toThrow();
  });
});
