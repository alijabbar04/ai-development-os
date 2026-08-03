import { describe, expect, it } from "vitest";
import { defaultDataHandlingPolicy, parseJsonText } from "@ai-dev-os/domain";
import { ProviderError, createInferenceRequest, createTrace, type InferenceRequest } from "@ai-dev-os/providers";
import { parseSecretRef, secretRefFingerprint } from "@ai-dev-os/secrets";
import {
  buildChatCompletionsBody,
  createOpenAiCompatibleProvider,
  createPolicyAwareProviderAccess,
  defaultOpenAiCompatibleConfiguration,
  getOpenAiCompatibleProfile,
  httpStatusError,
  parseChatCompletion,
  parseChatCompletionDelta,
  parseChatCompletionSse,
  parseOpenAiCompatibleConfiguration,
  preflightCompatibleRequest,
  readBoundedBody,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  type ProviderAccessPort,
} from "./index.js";

const encoder = new TextEncoder();
async function* chunks(...values: string[]): AsyncIterable<Uint8Array> { for (const value of values) yield encoder.encode(value); }
function response(body: string | readonly string[], status = 200, headers: Readonly<Record<string, string>> = {}): HttpResponse {
  return { status, headers, body: chunks(...(typeof body === "string" ? [body] : body)) };
}

class FakeTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  readonly responses: HttpResponse[] = [];
  async send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const next = this.responses.shift();
    if (next === undefined) throw new Error("unscripted transport");
    return next;
  }
}

function fakeAccess(input: { deny?: boolean; key?: string } = {}): ProviderAccessPort & { readonly calls: number } {
  let calls = 0;
  return {
    get calls() { return calls; },
    async withAuthorizedApiKey<T>(_request: any, use: (apiKey: string) => Promise<T>): Promise<T> {
      calls += 1;
      if (input.deny === true) throw new ProviderError("POLICY_DENIED", "denied without a secret", {});
      return use(input.key ?? "fixture-api-key");
    },
  };
}

function request(id: string, input: any = {}): InferenceRequest {
  return createInferenceRequest({
    requestId: id,
    modelId: "gpt-oss-120b",
    messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
    disclosure: { classification: "public", requiredLocality: "any", redactionApplied: false, decisionRef: null, retentionAllowed: false, loggingAllowed: false },
    trace: createTrace(`trace-${id}`),
    ...input,
  });
}

function completion(input: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: "chatcmpl-1", model: "openai/gpt-oss-120b", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } }, ...input });
}

function providerHarness(streaming: "always" | "never" = "never", access: ProviderAccessPort & Partial<{ readonly calls: number }> = fakeAccess()) {
  const transport = new FakeTransport();
  const provider = createOpenAiCompatibleProvider({
    configuration: defaultOpenAiCompatibleConfiguration({ instanceId: "groq-test", profileId: "groq-chat-completions-v1", modelId: "gpt-oss-120b", catalogModelId: "openai/gpt-oss-120b", streaming }),
    access,
    transport,
    clock: { now: () => new Date("2026-08-03T12:00:00.000Z") },
  });
  return { provider, transport, access };
}

async function collect(operation: Awaited<ReturnType<ReturnType<typeof providerHarness>["provider"]["start"]>>): Promise<any[]> {
  const events: any[] = [];
  for await (const event of operation.events()) events.push(event);
  return events;
}

describe("finite profile configuration and request mapping", () => {
  it("fixes each official endpoint and profile header policy", () => {
    expect(getOpenAiCompatibleProfile("groq-chat-completions-v1")).toMatchObject({ origin: "https://api.groq.com", path: "/openai/v1/chat/completions" });
    expect(getOpenAiCompatibleProfile("cerebras-chat-completions-v2").fixedHeaders).toEqual({ "X-Cerebras-Version-Patch": "2" });
    expect(getOpenAiCompatibleProfile("openrouter-chat-completions-v1")).toMatchObject({ origin: "https://openrouter.ai", path: "/api/v1/chat/completions" });
    expect(() => parseOpenAiCompatibleConfiguration({ ...defaultOpenAiCompatibleConfiguration({ instanceId: "x", profileId: "groq-chat-completions-v1", modelId: "gpt-oss-120b", catalogModelId: "openai/gpt-oss-120b" }), endpoint: "https://evil.example" })).toThrow();
  });

  it("maps tools, sampling, structured output, and OpenRouter's no-fallback policy", () => {
    const rich = request("mapping", {
      tools: [{ name: "read_file", description: "Read", inputSchema: { type: "object" }, risk: "read-only", approval: "policy", executionLocation: "caller" }],
      toolChoice: { mode: "named", toolName: "read_file" }, structuredOutput: { schema: { type: "object" }, strict: true },
      sampling: { temperature: 0.2, topP: 0.8, seed: 4 }, maxOutputTokens: 50, stopSequences: ["END"],
    });
    const body: any = buildChatCompletionsBody(rich, getOpenAiCompatibleProfile("openrouter-chat-completions-v1"), true, "openai/gpt-oss-120b");
    expect(body).toMatchObject({ model: "openai/gpt-oss-120b", stream: true, provider: { allow_fallbacks: false, require_parameters: true, data_collection: "deny" }, tool_choice: { function: { name: "read_file" } }, response_format: { type: "json_schema" }, max_completion_tokens: 50 });
    expect(JSON.stringify(body)).not.toContain("Authorization");
  });

  it("rejects unsupported content, extensions, wrong models, output bounds, and provider-executed tools before access", () => {
    const profile = getOpenAiCompatibleProfile("groq-chat-completions-v1");
    const check = (candidate: InferenceRequest) => preflightCompatibleRequest(candidate, { modelId: "gpt-oss-120b", maxOutputTokens: 65_536, profile });
    expect(() => check(request("wrong", { modelId: "other" as any }))).toThrowError(expect.objectContaining({ code: "MODEL_UNAVAILABLE" }));
    expect(() => check(request("ext", { extensions: [{ namespace: "test", key: "value", value: true }] }))).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_CAPABILITY" }));
    expect(() => check(request("large", { maxOutputTokens: 65_537 }))).toThrowError(expect.objectContaining({ code: "CONTEXT_LIMIT_EXCEEDED" }));
    expect(() => check(request("image", { messages: [{ role: "user", parts: [{ type: "image-artifact", artifactId: "art-1", mediaType: "image/png" }] }] }))).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_CAPABILITY" }));
    expect(() => check(request("hosted", { tools: [{ name: "hosted", description: "x", inputSchema: {}, risk: "read-only", approval: "policy", executionLocation: "provider" }] }))).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_CAPABILITY" }));
  });
});

describe("strict wire and SSE parsing", () => {
  it("maps disjoint usage and rejects model substitution and unknown finish states", () => {
    const parsed = parseChatCompletion(parseJsonText(completion()), "openai/gpt-oss-120b");
    expect(parsed.usage.tokens).toEqual({ inputTokens: 3, outputTokens: 2, cachedInputTokens: 2, reasoningTokens: 1 });
    expect(() => parseChatCompletion(parseJsonText(completion({ model: "other" })), "openai/gpt-oss-120b")).toThrowError(expect.objectContaining({ code: "PROTOCOL_VIOLATION" }));
    expect(() => parseChatCompletion(parseJsonText(completion({ choices: [{ finish_reason: "future", message: { content: "x" } }] })), "openai/gpt-oss-120b")).toThrowError(expect.objectContaining({ code: "MALFORMED_RESPONSE" }));
  });

  it("parses fragmented SSE and requires one [DONE] terminator", async () => {
    const stream = chunks("data: {\"choices\":[{\"delta\":{\"content\":\"o", "k\"},\"finish_reason\":null}],\"model\":\"openai/gpt-oss-120b\"}\n\n", "data: [DONE]\n\n");
    const values: any[] = [];
    for await (const value of parseChatCompletionSse(stream, { maxStreamBytes: 4_096, maxEventBytes: 2_048 })) values.push(value);
    expect(parseChatCompletionDelta(values[0]).text).toBe("ok");
    await expect(async () => { for await (const _ of parseChatCompletionSse(chunks("data: {}\n\n"), { maxStreamBytes: 100, maxEventBytes: 100 })) void _; }).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
    await expect(async () => { for await (const _ of parseChatCompletionSse(chunks("event: bad\n\n"), { maxStreamBytes: 100, maxEventBytes: 100 })) void _; }).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
  });

  it("bounds body reads and classifies HTTP status without reflecting bodies", async () => {
    await expect(readBoundedBody(chunks("abcd"), 3)).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    expect(httpStatusError(401, {}).code).toBe("AUTHENTICATION_FAILED");
    expect(httpStatusError(429, { "retry-after": "2" })).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 2_000 });
    expect(httpStatusError(503, {}).code).toBe("PROVIDER_OVERLOADED");
  });
});

describe("provider operations", () => {
  it("executes strict JSON through policy/key callback and exposes no caller header controls", async () => {
    const h = providerHarness("never");
    h.transport.responses.push(response(completion()));
    const operation = await h.provider.start(request("json"));
    const result = await operation.result;
    const events = await collect(operation);
    expect(result.messages[0]?.parts[0]).toEqual({ type: "text", text: "ok" });
    expect(result.usage.tokens).toMatchObject({ cachedInputTokens: 2, reasoningTokens: 1 });
    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining(["operation-started", "text-delta", "usage-update", "operation-completed"]));
    expect(h.access.calls).toBe(1);
    expect(h.transport.requests[0]).toMatchObject({ url: "https://api.groq.com/openai/v1/chat/completions", redirect: "reject" });
    expect(h.transport.requests[0]?.headers["Authorization"]).toBe("Bearer fixture-api-key");
    await h.provider.close();
  });

  it("streams fragmented text, reasoning, tools, structured output, and terminal usage", async () => {
    const h = providerHarness("always");
    const events = [
      { model: "openai/gpt-oss-120b", choices: [{ delta: { content: "{\"answer\":" }, finish_reason: null }] },
      { model: "openai/gpt-oss-120b", choices: [{ delta: { content: "1}", reasoning_content: "r", tool_calls: [{ index: 0, id: "call-1", function: { name: "read_file", arguments: "{\"p\":" } }] }, finish_reason: null }] },
      { model: "openai/gpt-oss-120b", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"x\"}" } }] }, finish_reason: "tool_calls" }] },
      { model: "openai/gpt-oss-120b", choices: [], usage: { prompt_tokens: 2, completion_tokens: 2 } },
    ];
    const sse = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
    h.transport.responses.push(response([sse.slice(0, 37), sse.slice(37, 91), sse.slice(91)]));
    const rich = request("stream", { structuredOutput: { schema: { type: "object" }, strict: true }, tools: [{ name: "read_file", description: "Read", inputSchema: { type: "object" }, risk: "read-only", approval: "policy", executionLocation: "caller" }] });
    const operation = await h.provider.start(rich);
    const result = await operation.result;
    const observed = await collect(operation);
    expect(result.structuredOutput).toEqual({ answer: 1 });
    expect(result.messages[0]?.parts.some((part) => part.type === "tool-invocation")).toBe(true);
    expect(observed.map((event) => event.kind)).toEqual(expect.arrayContaining(["reasoning-delta", "structured-output-completed", "tool-call-started", "tool-call-completed"]));
    await h.provider.close();
  });

  it("denies or preflights before network and never places a key in failure events", async () => {
    const denied = providerHarness("never", fakeAccess({ deny: true, key: "do-not-leak" }));
    const operation = await denied.provider.start(request("denied"));
    await expect(operation.result).rejects.toMatchObject({ code: "POLICY_DENIED" });
    const events = await collect(operation);
    expect(denied.transport.requests).toHaveLength(0);
    expect(JSON.stringify(events)).not.toContain("do-not-leak");
    await expect(denied.provider.start(request("classification", { disclosure: { ...request("base").disclosure, classification: "personal" } }))).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(denied.access.calls).toBe(1);
    await denied.provider.close();
  });

  it("turns upstream errors, truncation, and cancellation into one typed terminal outcome", async () => {
    const upstream = providerHarness("never");
    upstream.transport.responses.push(response("sensitive upstream body", 429, { "retry-after": "1" }));
    const first = await upstream.provider.start(request("rate"));
    await expect(first.result).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(JSON.stringify(await collect(first))).not.toContain("sensitive upstream body");
    await upstream.provider.close();

    const truncated = providerHarness("always");
    truncated.transport.responses.push(response("data: {\"choices\":[]}\n\n"));
    const second = await truncated.provider.start(request("truncated"));
    await expect(second.result).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
    await truncated.provider.close();

    const cancelling = providerHarness("never");
    cancelling.transport.responses.push(response(completion()));
    const third = await cancelling.provider.start(request("cancel"));
    await third.cancel();
    await expect(third.result).rejects.toMatchObject({ code: "CANCELLED" });
    await cancelling.provider.close();
  });
});

describe("policy-aware access composition", () => {
  it("binds cloud and secret decisions to the exact instance/model/ref and resolves only after allow", async () => {
    const decisions: any[] = [];
    const ref = parseSecretRef({ schemaVersion: 1, type: "named", namespace: "provider", version: null, expectedKind: "text", providerInstanceId: "groq-test", name: "groq-key" });
    const resolverCalls: any[] = [];
    const access = createPolicyAwareProviderAccess({
      policy: { evaluate(value: any) { decisions.push(value); return { outcome: "allowed", code: "ALLOWED", fingerprint: "a".repeat(64) } as any; } },
      resolver: { async withSecret(input: any, callback: any) { resolverCalls.push(input); const value = await callback({ useText: (use: any) => use("scoped-key") }); return { value, decisionFingerprint: "b".repeat(64) }; } },
      apiKeyRef: ref, context: { handlingPolicy: defaultDataHandlingPolicy, risk: "low", projectId: "project-1" },
    });
    const h = providerHarness("never", access);
    h.transport.responses.push(response(completion()));
    const operation = await h.provider.start(request("access"));
    await operation.result;
    expect(decisions[0]).toMatchObject({ action: "cloud-execution", scope: { providerInstanceId: "groq-test", operationId: operation.operationId }, model: { modelId: "gpt-oss-120b" } });
    expect(resolverCalls[0].policyRequest).toMatchObject({ action: "secret-access", subjectDigest: secretRefFingerprint(ref), requestedCapabilities: ["network-access"] });
    expect(h.transport.requests[0]?.headers["Authorization"]).toBe("Bearer scoped-key");
    await h.provider.close();
  });

  it("does not touch the secret resolver when cloud policy denies", async () => {
    let resolverCalls = 0;
    const ref = parseSecretRef({ schemaVersion: 1, type: "named", namespace: "provider", version: null, expectedKind: "text", providerInstanceId: "groq-test", name: "groq-key" });
    const access = createPolicyAwareProviderAccess({
      policy: { evaluate: () => ({ outcome: "denied", code: "DEFAULT_DENY", fingerprint: "c".repeat(64) } as any) },
      resolver: { async withSecret() { resolverCalls += 1; throw new Error("must not run"); } } as any,
      apiKeyRef: ref, context: { handlingPolicy: defaultDataHandlingPolicy, risk: "low", projectId: null },
    });
    const h = providerHarness("never", access);
    const operation = await h.provider.start(request("policy-denied"));
    await expect(operation.result).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(resolverCalls).toBe(0);
    expect(h.transport.requests).toHaveLength(0);
    await h.provider.close();
  });
});
