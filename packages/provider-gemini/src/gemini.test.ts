import { describe, expect, it } from "vitest";
import { defaultDataHandlingPolicy } from "@ai-dev-os/domain";
import { ProviderError, createInferenceRequest, createTrace, type InferenceRequest } from "@ai-dev-os/providers";
import { parseSecretRef, secretRefFingerprint } from "@ai-dev-os/secrets";
import {
  buildGeminiBody, createFetchGeminiTransport, createGeminiProvider, createPolicyAwareGeminiAccess, defaultGeminiConfiguration, geminiHttpError, geminiPolicyCapabilities,
  parseGeminiConfiguration, parseGeminiJson, parseGeminiResponse, parseGeminiSse, preflightGeminiRequest, readGeminiBody,
  type GeminiArtifactResolver, type GeminiAuthorizationPort, type GeminiCredentialPort, type GeminiHttpRequest, type GeminiHttpResponse, type GeminiHttpTransport,
} from "./index.js";

const encoder = new TextEncoder();
async function* bytes(...items: Array<string | Uint8Array>): AsyncIterable<Uint8Array> { for (const item of items) yield typeof item === "string" ? encoder.encode(item) : item; }
function req(id: string, input: any = {}): InferenceRequest { return createInferenceRequest({ requestId: id, modelId: "gemini-3.5-flash", messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }], disclosure: { classification: "public", requiredLocality: "any", redactionApplied: false, decisionRef: null, retentionAllowed: false, loggingAllowed: false }, trace: createTrace(`trace-${id}`), ...input }); }

class Transport implements GeminiHttpTransport {
  readonly requests: GeminiHttpRequest[] = []; readonly queue: GeminiHttpResponse[] = [];
  async send(request: GeminiHttpRequest): Promise<GeminiHttpResponse> { this.requests.push(request); const next = this.queue.shift(); if (next === undefined) throw new ProviderError("NETWORK_FAILURE", "unscripted", {}); return next; }
}
function response(value: unknown, status = 200, headers: Readonly<Record<string, string>> = {}): GeminiHttpResponse { return { status, headers, body: bytes(typeof value === "string" ? value : JSON.stringify(value)) }; }
function ports(order: string[] = []): { authorization: GeminiAuthorizationPort; credentials: GeminiCredentialPort } {
  return { authorization: { async authorize() { order.push("authorize"); return { decisionFingerprint: "a".repeat(64) }; } }, credentials: { async withApiKey<T>(_request: any, use: (key: string) => Promise<T>) { order.push("credential"); return use("gemini-key"); } } };
}
function harness(streaming: "always" | "never", input: { artifacts?: GeminiArtifactResolver; order?: string[] } = {}) {
  const transport = new Transport(); const access = ports(input.order);
  const provider = createGeminiProvider({ configuration: defaultGeminiConfiguration({ instanceId: `gemini-${streaming}`, streaming }), ...access, transport, ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }), clock: { now: () => new Date("2026-08-03T12:00:00.000Z") } });
  return { provider, transport };
}

const basic = { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, cachedContentTokenCount: 2, thoughtsTokenCount: 1 } };

describe("native configuration and request mapping", () => {
  it("accepts only the curated fixed profile and rejects caller endpoint fields", () => {
    const config = defaultGeminiConfiguration({ instanceId: "gemini-1" });
    expect(config).toMatchObject({ catalogModelId: "gemini-3.5-flash", safetyMode: "provider-default" });
    expect(() => parseGeminiConfiguration({ ...config, origin: "https://evil.example" })).toThrow();
    expect(() => parseGeminiConfiguration({ ...config, catalogModelId: "unknown" })).toThrowError(expect.objectContaining({ code: "MODEL_UNAVAILABLE" }));
    expect(() => parseGeminiConfiguration({ ...config, limits: { ...config.limits, maxInlineImageBytes: config.limits.maxTotalInlineImageBytes + 1 } })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });

  it("preflights wrong models, extensions, output bounds, hosted tools, and image types", () => {
    const config = defaultGeminiConfiguration({ instanceId: "gemini-1" });
    expect(() => preflightGeminiRequest(req("wrong", { modelId: "other" }), config, false)).toThrowError(expect.objectContaining({ code: "MODEL_UNAVAILABLE" }));
    expect(() => preflightGeminiRequest(req("ext", { extensions: [{ namespace: "test", key: "value", value: true }] }), config, false)).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_CAPABILITY" }));
    expect(() => preflightGeminiRequest(req("large", { maxOutputTokens: 65_537 }), config, false)).toThrowError(expect.objectContaining({ code: "CONTEXT_LIMIT_EXCEEDED" }));
    expect(() => preflightGeminiRequest(req("tool", { tools: [{ name: "hosted", description: "Hosted", inputSchema: {}, risk: "read-only", approval: "policy", executionLocation: "provider" }] }), config, false)).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_CAPABILITY" }));
    expect(() => preflightGeminiRequest(req("image", { messages: [{ role: "user", parts: [{ type: "image-artifact", artifactId: "art-1", mediaType: "image/gif" }] }] }), config, true)).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_CAPABILITY" }));
  });

  it("maps native system, tools, schemas, safety, images, tool results, and thought signatures", async () => {
    const config = parseGeminiConfiguration({ ...defaultGeminiConfiguration({ instanceId: "gemini-1", safetyMode: "block-medium-and-above" }) });
    const artifact: GeminiArtifactResolver = { async resolve() { return { bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png" }; } };
    const messages: any[] = [
      { role: "system", parts: [{ type: "text", text: "system" }] },
      { role: "user", parts: [{ type: "image-artifact", artifactId: "art-1", mediaType: "image/png" }] },
      { role: "assistant", parts: [{ type: "tool-invocation", invocation: { toolCallId: "call-1", toolName: "read_file", arguments: { path: "a" } } }] },
      { role: "tool", parts: [{ type: "tool-result", result: { toolCallId: "call-1", toolName: "read_file", status: "succeeded", output: { ok: true }, failure: null } }] },
    ];
    const request = req("body", { messages, tools: [{ name: "read_file", description: "Read", inputSchema: { type: "object" }, risk: "read-only", approval: "never", executionLocation: "caller" }], toolChoice: { mode: "named", toolName: "read_file" }, structuredOutput: { schema: { type: "object" }, strict: true }, sampling: { temperature: 0.2, topP: 0.8, seed: null }, maxOutputTokens: 20, stopSequences: ["END"] });
    const body: any = await buildGeminiBody(request, config, artifact, new Map([["call-1", "signature"]]));
    expect(body).toMatchObject({ systemInstruction: { parts: [{ text: "system" }] }, generationConfig: { responseMimeType: "application/json", maxOutputTokens: 20 }, toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["read_file"] } } });
    expect(JSON.stringify(body)).toContain("inlineData"); expect(JSON.stringify(body)).toContain("thoughtSignature"); expect(body.safetySettings).toHaveLength(4);
    expect(geminiPolicyCapabilities(request, true)).toEqual(["network-access", "streaming", "structured-output", "tool-calling", "image-input"]);
  });

  it("rejects mismatched and oversized resolved image content", async () => {
    const config = defaultGeminiConfiguration({ instanceId: "gemini-1" });
    const imageRequest = req("image", { messages: [{ role: "user", parts: [{ type: "image-artifact", artifactId: "art-1", mediaType: "image/png" }] }] });
    await expect(buildGeminiBody(imageRequest, config, { resolve: async () => ({ bytes: new Uint8Array(1), mediaType: "image/jpeg" }) }, new Map())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const small = parseGeminiConfiguration({ ...config, limits: { ...config.limits, maxInlineImageBytes: 2, maxTotalInlineImageBytes: 2 } });
    await expect(buildGeminiBody(imageRequest, small, { resolve: async () => ({ bytes: new Uint8Array(3), mediaType: "image/png" }) }, new Map())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});

describe("native response and SSE parsing", () => {
  it("maps disjoint usage, thoughts, functions, signatures, safety, and finish states", () => {
    const value = { candidates: [{ content: { parts: [{ text: "why", thought: true }, { text: "answer" }, { functionCall: { id: "call-1", name: "read_file", args: { path: "a" } }, thoughtSignature: "sig" }] }, finishReason: "MAX_TOKENS", safetyRatings: [{ category: "x" }] }], usageMetadata: basic.usageMetadata };
    const parsed = parseGeminiResponse(parseGeminiJson(JSON.stringify(value)), () => "generated");
    expect(parsed).toMatchObject({ text: "answer", reasoning: "why", finishReason: "length", invocations: [{ toolCallId: "call-1" }], signatures: [{ value: "sig" }] });
    expect(parsed.usage?.tokens).toEqual({ inputTokens: 3, outputTokens: 3, cachedInputTokens: 2, reasoningTokens: 1 });
    expect(parsed.warning).toContain("safety-rating");
  });

  it("turns prompt safety blocks and future finish variants into typed failures", () => {
    expect(() => parseGeminiResponse(parseGeminiJson(JSON.stringify({ candidates: [], promptFeedback: { blockReason: "SAFETY" } })), () => "id")).toThrowError(expect.objectContaining({ code: "CONTENT_REJECTED" }));
    expect(() => parseGeminiResponse(parseGeminiJson(JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: "FUTURE" }] })), () => "id")).toThrowError(expect.objectContaining({ code: "MALFORMED_RESPONSE" }));
    expect(() => parseGeminiJson("not-json")).toThrowError(expect.objectContaining({ code: "MALFORMED_RESPONSE" }));
  });

  it("parses fragmented SSE and rejects fields, byte excess, and invalid UTF-8", async () => {
    const values: string[] = []; for await (const value of parseGeminiSse(bytes("data: {\"a\":", "1}\n\n"), { stream: 100, event: 50 })) values.push(value);
    expect(values).toEqual(["{\"a\":1}"]);
    const consume = async (body: AsyncIterable<Uint8Array>, stream = 100, event = 50) => { for await (const _ of parseGeminiSse(body, { stream, event })) void _; };
    await expect(consume(bytes("event: bad\n\n"))).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
    await expect(consume(bytes("x".repeat(101)))).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    await expect(consume(bytes(new Uint8Array([0xff])))).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it("classifies finite HTTP failures without exposing response bodies", () => {
    expect(geminiHttpError(400, {}).code).toBe("INVALID_REQUEST"); expect(geminiHttpError(401, {}).code).toBe("AUTHENTICATION_FAILED"); expect(geminiHttpError(403, {}).code).toBe("AUTHORIZATION_FAILED"); expect(geminiHttpError(404, {}).code).toBe("MODEL_UNAVAILABLE"); expect(geminiHttpError(429, { "retry-after": "2" })).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 2_000 }); expect(geminiHttpError(503, {}).code).toBe("PROVIDER_OVERLOADED");
  });
});

describe("Gemini provider", () => {
  it("runs JSON natively with fixed URL/header and reports health/model/result", async () => {
    const h = harness("never"); h.transport.queue.push(response(basic));
    const operation = await h.provider.start(req("json")); const result = await operation.result;
    expect(result.messages[0]?.parts[0]).toEqual({ type: "text", text: "ok" });
    expect(h.transport.requests[0]).toMatchObject({ url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent", headers: { "x-goog-api-key": "gemini-key" } });
    expect((await h.provider.health()).status).toBe("ready"); expect(await h.provider.listModels()).toHaveLength(1); await h.provider.close();
  });

  it("orders authorization before artifact resolution, credential access, and HTTP", async () => {
    const order: string[] = [];
    const artifact: GeminiArtifactResolver = { async resolve() { order.push("artifact"); return { bytes: new Uint8Array([1]), mediaType: "image/png" }; } };
    const h = harness("never", { artifacts: artifact, order });
    const original = h.transport.send.bind(h.transport); h.transport.send = async (request) => { order.push("http"); return original(request); };
    h.transport.queue.push(response(basic));
    const operation = await h.provider.start(req("order", { messages: [{ role: "user", parts: [{ type: "image-artifact", artifactId: "art-1", mediaType: "image/png" }] }] })); await operation.result;
    expect(order).toEqual(["authorize", "artifact", "credential", "http"]); await h.provider.close();
  });

  it("streams structured output, reasoning, functions, safety warnings, and usage", async () => {
    const h = harness("always");
    const first = { candidates: [{ content: { parts: [{ text: "{\"ok\":" }, { text: "thought", thought: true }] } }] };
    const second = { candidates: [{ content: { parts: [{ text: "true}" }, { functionCall: { name: "read_file", args: {} }, thoughtSignature: "sig" }] }, finishReason: "STOP", safetyRatings: [{}] }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
    const sse = `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(second)}\n\n`;
    h.transport.queue.push({ status: 200, headers: {}, body: bytes(sse.slice(0, 50), sse.slice(50)) });
    const operation = await h.provider.start(req("stream", { structuredOutput: { schema: { type: "object" }, strict: true }, tools: [{ name: "read_file", description: "Read", inputSchema: {}, risk: "read-only", approval: "never", executionLocation: "caller" }] }));
    const result = await operation.result; expect(result.structuredOutput).toEqual({ ok: true }); expect(result.warnings).toHaveLength(1); await h.provider.close();
  });

  it("preflight/policy/deadline/upstream/cancellation paths produce typed terminal behavior", async () => {
    const h = harness("never");
    await expect(h.provider.start(req("personal", { disclosure: { ...req("base").disclosure, classification: "personal" } }))).rejects.toMatchObject({ code: "POLICY_DENIED" });
    const expired = await h.provider.start(req("expired", { deadline: "2026-08-03T11:00:00.000Z" })); await expect(expired.result).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    h.transport.queue.push(response("sensitive", 429)); const failed = await h.provider.start(req("rate")); await expect(failed.result).rejects.toMatchObject({ code: "RATE_LIMITED" });
    h.transport.queue.push(response(basic)); const cancelled = await h.provider.start(req("cancel")); await cancelled.cancel(); await expect(cancelled.result).rejects.toMatchObject({ code: "CANCELLED" });
    await h.provider.close(); await expect(h.provider.start(req("closed"))).rejects.toMatchObject({ code: "PROVIDER_CLOSED" });
  });
});

describe("policy-aware Gemini access and fetch transport", () => {
  it("denies before resolver and binds an allowed secret request to the exact reference", async () => {
    const ref = parseSecretRef({ schemaVersion: 1, type: "named", namespace: "provider", version: null, expectedKind: "text", providerInstanceId: "gemini-never", name: "gemini-key" });
    let resolverCalls = 0;
    const denied = createPolicyAwareGeminiAccess({ policy: { evaluate: () => ({ outcome: "denied", code: "DEFAULT_DENY", fingerprint: "a".repeat(64) } as any) }, resolver: { async withSecret() { resolverCalls += 1; throw new Error("no"); } } as any, apiKeyRef: ref, context: { handlingPolicy: defaultDataHandlingPolicy, risk: "low", projectId: null } });
    const h = harness("never"); const descriptor = h.provider.describe(); const model = (await h.provider.listModels())[0]!.model; const request = req("access"); const accessRequest: any = { descriptor, model, request, operationId: "op-access", requestedCapabilities: ["network-access"] };
    await expect(denied.authorization.authorize(accessRequest)).rejects.toMatchObject({ code: "POLICY_DENIED" }); expect(resolverCalls).toBe(0); await h.provider.close();

    const observed: any[] = [];
    const allowed = createPolicyAwareGeminiAccess({ policy: { evaluate: (value: any) => ({ outcome: "allowed", code: "ALLOWED", fingerprint: "b".repeat(64), value } as any) }, resolver: { async withSecret(input: any, callback: any) { observed.push(input); return { value: await callback({ useText: (use: any) => use("key") }), decisionFingerprint: "c".repeat(64) }; } }, apiKeyRef: ref, context: { handlingPolicy: defaultDataHandlingPolicy, risk: "low", projectId: null } });
    const authorization = await allowed.authorization.authorize(accessRequest); await allowed.credentials.withApiKey({ ...accessRequest, authorization }, async () => "ok");
    expect(observed[0].policyRequest).toMatchObject({ action: "secret-access", subjectDigest: secretRefFingerprint(ref), model: { modelId: "gemini-3.5-flash" } });
  });

  it("uses manual redirects, bounds bodies, and classifies fetch failures", async () => {
    let init: RequestInit | undefined; const transport = createFetchGeminiTransport(async (_url, value) => { init = value; return new Response("ok", { status: 200 }); });
    const result = await transport.send({ url: "https://example.test", headers: {}, body: "{}", timeoutMs: 1_000, maxResponseBytes: 3 }); expect(await readGeminiBody(result.body, 3)).toBe("ok"); expect(init?.redirect).toBe("manual");
    await expect(createFetchGeminiTransport(async () => new Response(null, { status: 302 })).send({ url: "https://x", headers: {}, body: "{}", timeoutMs: 100, maxResponseBytes: 10 })).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
    await expect(createFetchGeminiTransport(async () => { throw new Error("secret socket"); }).send({ url: "https://x", headers: {}, body: "{}", timeoutMs: 100, maxResponseBytes: 10 })).rejects.toMatchObject({ code: "NETWORK_FAILURE" });
    await expect(readGeminiBody(bytes("four"), 3)).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });
});
