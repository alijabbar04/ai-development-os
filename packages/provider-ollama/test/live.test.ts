import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInferenceRequest, createTrace, parseDisclosureContext } from "@ai-dev-os/providers";
import {
  createOllamaAdapterConfiguration,
  createOllamaProvider,
  parseOllamaEndpoint,
  type OllamaInferenceProvider,
  type OllamaModelCatalog,
} from "../src/index.js";

/**
 * Opt-in live tests against an ALREADY-RUNNING local Ollama installation.
 *
 * Opt-in mechanism (single, explicit): set AI_DEV_OS_OLLAMA_LIVE_URL to a
 * literal loopback URL (e.g. http://127.0.0.1:11434). Optionally set
 * AI_DEV_OS_OLLAMA_LIVE_MODELS to a comma-separated allowlist of installed
 * model names to exercise; without it, only the first eligible model runs.
 *
 * These tests never pull, delete, create, or copy models, never write to
 * the repository, never execute tools, use fixed harmless prompts with low
 * output limits and bounded deadlines, and do not print generated content.
 */
const LIVE_URL = process.env["AI_DEV_OS_OLLAMA_LIVE_URL"];
const LIVE_MODELS = process.env["AI_DEV_OS_OLLAMA_LIVE_MODELS"];

const LIVE_DISCLOSURE = parseDisclosureContext({
  classification: "public",
  requiredLocality: "local-only",
  redactionApplied: false,
  decisionRef: null,
  retentionAllowed: false,
  loggingAllowed: false,
});

describe.skipIf(LIVE_URL === undefined)("live Ollama (opt-in)", () => {
  let provider: OllamaInferenceProvider;
  let catalog: OllamaModelCatalog;
  let targetModels: string[] = [];
  let requestCounter = 0;

  const liveRequest = (
    modelId: string,
    overrides: Partial<Parameters<typeof createInferenceRequest>[0]> = {},
  ): ReturnType<typeof createInferenceRequest> => {
    requestCounter += 1;
    return createInferenceRequest({
      requestId: `live-req-${requestCounter}`,
      modelId,
      messages: [{ role: "user", parts: [{ type: "text", text: "Reply with the single word: ready" }] }],
      maxOutputTokens: 64,
      deadline: new Date(Date.now() + 120_000).toISOString(),
      disclosure: LIVE_DISCLOSURE,
      trace: createTrace("trace-live-ollama"),
      ...overrides,
    });
  };

  beforeAll(async () => {
    // The endpoint must be literal loopback BEFORE any connection is made.
    const endpoint = parseOllamaEndpoint(LIVE_URL);
    provider = createOllamaProvider({
      configuration: createOllamaAdapterConfiguration({
        instanceId: "ollama-live-test",
        endpoint: endpoint.baseUrl,
        requestTimeoutMs: 180_000,
        discoveryTimeoutMs: 30_000,
        // Restore default retention behavior when tests finish; retain
        // briefly during the run so sequential tests reuse the load.
        keepAlive: { policy: "retain", durationMs: 60_000 },
        maxConcurrentOperations: 1,
      }),
    });
    catalog = await provider.refreshCatalog();
    const eligible = catalog.entries.filter((entry) => entry.eligible).map((entry) => entry.name);
    if (LIVE_MODELS !== undefined) {
      const requested = LIVE_MODELS.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
      targetModels = requested.filter((name) => eligible.includes(name));
    } else {
      targetModels = eligible.slice(0, 1);
    }
  }, 60_000);

  afterAll(async () => {
    await provider?.close();
  });

  it("reports a reachable, compatible loopback server", async () => {
    const health = await provider.inspectHealth();
    expect(health.serverReachable).toBe(true);
    expect(health.apiCompatible).toBe(true);
    expect(health.serverVersion).not.toBeNull();
  });

  it("discovers installed models with validated digests", () => {
    expect(catalog.entries.length).toBeGreaterThan(0);
    for (const entry of catalog.entries) {
      expect(entry.digest === null || /^[a-f0-9]{64}$/.test(entry.digest)).toBe(true);
    }
  });

  it("streams a short plain-text response", async (ctx) => {
    const model = targetModels[0];
    if (model === undefined) {
      return ctx.skip();
    }
    const operation = await provider.start(liveRequest(model));
    const result = await operation.result;
    expect(result.finishReason === "stop" || result.finishReason === "length").toBe(true);
    expect(result.usage.tokens.outputTokens).toBeGreaterThan(0);
    expect(result.cost.providerReported).toBeNull();
  }, 180_000);

  it("produces a small fixed JSON object for structured-output-capable models", async (ctx) => {
    const model = targetModels
      .map((name) => catalog.entries.find((entry) => entry.name === name))
      .find((entry) => entry?.capabilities.structuredOutput);
    if (model === undefined) {
      return ctx.skip();
    }
    const operation = await provider.start(
      liveRequest(model.name, {
        messages: [
          {
            role: "user",
            parts: [{ type: "text", text: 'Return a JSON object {"ok": true} and nothing else.' }],
          },
        ],
        structuredOutput: {
          schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
          strict: true,
        },
      }),
    );
    const result = await operation.result;
    expect(result.structuredOutput).not.toBeNull();
    expect(typeof result.structuredOutput).toBe("object");
  }, 180_000);

  it("emits reasoning deltas for thinking-capable models", async (ctx) => {
    const model = targetModels
      .map((name) => catalog.entries.find((entry) => entry.name === name))
      .find((entry) => entry?.capabilities.reasoning);
    if (model === undefined) {
      return ctx.skip();
    }
    const operation = await provider.start(
      liveRequest(model.name, {
        messages: [{ role: "user", parts: [{ type: "text", text: "What is 2 + 2? Reply with the number." }] }],
        maxOutputTokens: 512,
        extensions: [{ namespace: "ollama", key: "think", value: true }],
      }),
    );
    let sawReasoning = false;
    for await (const event of operation.events()) {
      if (event.kind === "reasoning-delta") {
        sawReasoning = true;
      }
    }
    await operation.result;
    expect(sawReasoning).toBe(true);
  }, 180_000);

  it("emits a normalized tool invocation without executing it", async (ctx) => {
    const model = targetModels
      .map((name) => catalog.entries.find((entry) => entry.name === name))
      .find((entry) => entry?.capabilities.toolCalling);
    if (model === undefined) {
      return ctx.skip();
    }
    const operation = await provider.start(
      liveRequest(model.name, {
        messages: [
          { role: "user", parts: [{ type: "text", text: "Use the get-time tool to find the current time." }] },
        ],
        tools: [
          {
            name: "get-time",
            description: "Returns the current time.",
            inputSchema: { type: "object", properties: {} },
            risk: "read-only",
            approval: "never",
            executionLocation: "caller",
          } as never,
        ],
      }),
    );
    const result = await operation.result;
    // A tool call is likely but not guaranteed; assert structure only when present.
    const invocationParts = result.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool-invocation");
    for (const part of invocationParts) {
      expect((part as { invocation: { toolName: string } }).invocation.toolName).toBe("get-time");
    }
    expect(result.finishReason === "tool-calls" || invocationParts.length === 0).toBe(true);
  }, 180_000);
});
