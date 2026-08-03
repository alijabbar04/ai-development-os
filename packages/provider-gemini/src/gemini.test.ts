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
    expect(() => parseGeminiConfiguration({ ...config, catalogModelId: "GEMINI-3.5-FLASH" })).toThrowError(expect.objectContaining({ code: "MODEL_UNAVAILABLE" }));
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

  it("maps every finite function-calling mode and fails closed without an artifact resolver", async () => {
    const config = defaultGeminiConfiguration({ instanceId: "gemini-1" });
    const expected = { none: "NONE", auto: "AUTO", required: "ANY" } as const;
    const tools = [{ name: "read_file", description: "Read", inputSchema: {}, risk: "read-only", approval: "never", executionLocation: "caller" }];
    for (const mode of ["none", "auto", "required"] as const) {
      const body: any = await buildGeminiBody(req(`mode-${mode}`, { tools, toolChoice: { mode } }), config, undefined, new Map());
      expect(body.toolConfig.functionCallingConfig.mode).toBe(expected[mode]);
    }
    const imageRequest = req("unresolved-image", { messages: [{ role: "user", parts: [{ type: "image-artifact", artifactId: "art-1", mediaType: "image/png" }] }] });
    await expect(buildGeminiBody(imageRequest, config, undefined, new Map())).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
  });

  it("rejects mismatched and oversized resolved image content", async () => {
    const config = defaultGeminiConfiguration({ instanceId: "gemini-1" });
    const imageRequest = req("image", { messages: [{ role: "user", parts: [{ type: "image-artifact", artifactId: "art-1", mediaType: "image/png" }] }] });
    await expect(buildGeminiBody(imageRequest, config, { resolve: async () => ({ bytes: new Uint8Array(1), mediaType: "image/jpeg" }) }, new Map())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const small = parseGeminiConfiguration({ ...config, limits: { ...config.limits, maxInlineImageBytes: 2, maxTotalInlineImageBytes: 2 } });
    await expect(buildGeminiBody(imageRequest, small, { resolve: async () => ({ bytes: new Uint8Array(3), mediaType: "image/png" }) }, new Map())).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const order: string[] = []; const access = ports(order);
    const large = parseGeminiConfiguration({ ...config, instanceId: "gemini-large", limits: { ...config.limits, maxInlineImageBytes: 16 * 1_024 * 1_024, maxTotalInlineImageBytes: 16 * 1_024 * 1_024 } });
    const provider = createGeminiProvider({ configuration: large, ...access, artifacts: { async resolve() { order.push("artifact"); return { bytes: new Uint8Array(15 * 1_024 * 1_024), mediaType: "image/png" }; } }, transport: new Transport(), clock: { now: () => new Date("2026-08-03T12:00:00.000Z") } });
    const operation = await provider.start(imageRequest); await expect(operation.result).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(order).toEqual(["authorize", "artifact"]); await provider.close();
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

  it("handles an empty unblocked response and normalizes schema-validation failures", () => {
    expect(parseGeminiResponse({ candidates: [], usageMetadata: { promptTokenCount: 1 } }, () => "id")).toMatchObject({ text: "", finishReason: null, usage: { tokens: { inputTokens: 1 } } });
    expect(() => parseGeminiResponse([] as any, () => "id")).toThrowError(expect.objectContaining({ code: "MALFORMED_RESPONSE" }));
  });

  it("rejects role substitution, ambiguous/unsupported parts, and duplicate function IDs", () => {
    const candidate = (parts: any[], role: string = "model") => ({ candidates: [{ content: { role, parts }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    expect(() => parseGeminiResponse(candidate([{ text: "x" }], "user") as any, () => "id")).toThrowError(expect.objectContaining({ code: "PROTOCOL_VIOLATION" }));
    expect(() => parseGeminiResponse(candidate([{ text: "x", functionCall: { id: "call-1", name: "read_file", args: {} } }]) as any, () => "id")).toThrowError(expect.objectContaining({ code: "MALFORMED_RESPONSE" }));
    expect(() => parseGeminiResponse(candidate([{ text: "x", executableCode: { code: "hidden" } }]) as any, () => "id")).toThrowError(expect.objectContaining({ code: "MALFORMED_RESPONSE" }));
    expect(() => parseGeminiResponse(candidate([{ executableCode: { code: "x" } }]) as any, () => "id")).toThrowError(expect.objectContaining({ code: "MALFORMED_RESPONSE" }));
    expect(() => parseGeminiResponse(candidate([{ functionCall: { id: "call-1", name: "read_file", args: {}, extra: true } }]) as any, () => "id")).toThrowError(expect.objectContaining({ code: "MALFORMED_RESPONSE" }));
    expect(() => parseGeminiResponse(candidate([{ functionCall: { id: "call-1", name: "read_file", args: {} } }, { functionCall: { id: "call-1", name: "read_file", args: {} } }]) as any, () => "id")).toThrowError(expect.objectContaining({ code: "TOOL_PROTOCOL_FAILURE" }));
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

  it("bounds transport by the earlier request deadline", async () => {
    const h = harness("never"); h.transport.queue.push(response(basic));
    const operation = await h.provider.start(req("deadline-bound", { deadline: "2026-08-03T12:00:30.000Z" }));
    await operation.result;
    expect(h.transport.requests[0]?.timeoutMs).toBe(30_000);
    await h.provider.close();

    const bodyTimeout = harness("never");
    bodyTimeout.transport.queue.push({ status: 200, headers: {}, body: (async function* () { throw new ProviderError("TIMEOUT", "bounded body timeout", {}); })() });
    const timedOut = await bodyTimeout.provider.start(req("deadline-body", { deadline: "2026-08-03T12:00:30.000Z" }));
    await expect(timedOut.result).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    await bodyTimeout.provider.close();
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

  it("sends an authorized multi-megabyte image below the serialized request cap", async () => {
    const image = new Uint8Array(5 * 1_024 * 1_024);
    const h = harness("never", { artifacts: { async resolve() { return { bytes: image, mediaType: "image/png" }; } } });
    h.transport.queue.push(response(basic));
    const operation = await h.provider.start(req("large-valid-image", { messages: [{ role: "user", parts: [{ type: "image-artifact", artifactId: "art-1", mediaType: "image/png" }] }] }));
    await expect(operation.result).resolves.toMatchObject({ finishReason: "stop" });
    expect(h.transport.requests).toHaveLength(1);
    const wireBytes = Buffer.byteLength(h.transport.requests[0]!.body, "utf8");
    expect(wireBytes).toBeGreaterThan(6_000_000);
    expect(wireBytes).toBeLessThanOrEqual(20_000_000);
    expect(JSON.parse(h.transport.requests[0]!.body).contents[0].parts[0].inlineData.data).toHaveLength(6_990_508);
    await h.provider.close();
  });

  it("streams structured output and rejects post-terminal content or repeated usage", async () => {
    const h = harness("always");
    const first = { candidates: [{ content: { parts: [{ text: "{\"ok\":" }, { text: "thought", thought: true }] } }] };
    const second = { candidates: [{ content: { parts: [{ text: "true}" }, { functionCall: { name: "read_file", args: {} }, thoughtSignature: "sig" }] }, finishReason: "STOP", safetyRatings: [{}] }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
    const sse = `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(second)}\n\n`;
    h.transport.queue.push({ status: 200, headers: {}, body: bytes(sse.slice(0, 50), sse.slice(50)) });
    const operation = await h.provider.start(req("stream", { structuredOutput: { schema: { type: "object" }, strict: true }, tools: [{ name: "read_file", description: "Read", inputSchema: {}, risk: "read-only", approval: "never", executionLocation: "caller" }] }));
    const result = await operation.result; expect(result.structuredOutput).toEqual({ ok: true }); expect(result.warnings).toHaveLength(1); await h.provider.close();

    const finished = { candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
    const late = { candidates: [{ content: { role: "model", parts: [{ text: "late" }] } }] };
    const continued = harness("always"); continued.transport.queue.push({ status: 200, headers: {}, body: bytes(`data: ${JSON.stringify(finished)}\n\ndata: ${JSON.stringify(late)}\n\n`) });
    const continuedOperation = await continued.provider.start(req("continued")); await expect(continuedOperation.result).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" }); await continued.provider.close();

    const usageOnly = { candidates: [], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
    const repeated = harness("always"); repeated.transport.queue.push({ status: 200, headers: {}, body: bytes(`data: ${JSON.stringify(finished)}\n\ndata: ${JSON.stringify(usageOnly)}\n\n`) });
    const repeatedOperation = await repeated.provider.start(req("repeated-usage")); await expect(repeatedOperation.result).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" }); await repeated.provider.close();
  });

  it("preflight/policy/deadline/upstream/cancellation paths produce typed terminal behavior", async () => {
    const h = harness("never");
    await expect(h.provider.start(req("personal", { disclosure: { ...req("base").disclosure, classification: "personal" } }))).rejects.toMatchObject({ code: "POLICY_DENIED" });
    const expired = await h.provider.start(req("expired", { deadline: "2026-08-03T11:00:00.000Z" })); await expect(expired.result).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    h.transport.queue.push(response("sensitive", 429)); const failed = await h.provider.start(req("rate")); await expect(failed.result).rejects.toMatchObject({ code: "RATE_LIMITED" });
    h.transport.queue.push(response(basic)); const cancelled = await h.provider.start(req("cancel")); await cancelled.cancel(); await expect(cancelled.result).rejects.toMatchObject({ code: "CANCELLED" });
    await h.provider.close(); await expect(h.provider.start(req("closed"))).rejects.toMatchObject({ code: "PROVIDER_CLOSED" });

    const order: string[] = [];
    const preAborted = harness("never", { order }); preAborted.transport.queue.push(response(basic));
    const alreadyCancelled = await preAborted.provider.start(req("pre-aborted"), { signal: AbortSignal.abort() });
    await expect(alreadyCancelled.result).rejects.toMatchObject({ code: "CANCELLED" });
    expect(order).toEqual([]); expect(preAborted.transport.requests).toHaveLength(0);
    await preAborted.provider.close();
  });

  it("preserves status classification when an error body exceeds the drain bound", async () => {
    for (const [status, code, headers] of [[429, "RATE_LIMITED", { "retry-after": "2" }], [503, "PROVIDER_OVERLOADED", {}]] as const) {
      const h = harness("never");
      const canary = `oversized-${status}-error-canary`;
      h.transport.queue.push(response(`${canary}${"x".repeat((64 * 1_024) + 1)}`, status, headers));
      const operation = await h.provider.start(req(`oversized-error-${status}`));
      await expect(operation.result).rejects.toMatchObject({ code, ...(status === 429 ? { retryAfterMs: 2_000 } : {}) });
      await h.provider.close();
    }
  });

  it("requires terminal finish and usage metadata from non-streaming responses", async () => {
    const h = harness("never");
    h.transport.queue.push(response({ candidates: [{ content: { role: "model", parts: [{ text: "incomplete" }] } }] }));
    const operation = await h.provider.start(req("incomplete-json"));
    await expect(operation.result).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
    await h.provider.close();
  });

  it("propagates cancellation through the scoped credential signal and closes idempotently", async () => {
    let entered!: () => void;
    const credentialEntered = new Promise<void>((resolve) => { entered = resolve; });
    let observedSignal: any;
    const access = ports();
    const provider = createGeminiProvider({
      configuration: defaultGeminiConfiguration({ instanceId: "gemini-cancel", streaming: "never" }),
      authorization: access.authorization,
      credentials: {
        async withApiKey(request: any): Promise<never> {
          observedSignal = request.signal;
          entered();
          await new Promise<void>((resolve) => request.signal.addEventListener("abort", resolve));
          throw new ProviderError("CANCELLED", "cancelled", {});
        },
      },
      transport: new Transport(),
    });
    const operation = await provider.start(req("signal"));
    await credentialEntered;
    expect(observedSignal.aborted).toBe(false);
    await operation.cancel("caller-requested");
    expect(observedSignal.aborted).toBe(true);
    await expect(operation.result).rejects.toMatchObject({ code: "CANCELLED" });
    await provider.close();
    await provider.close();
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

  it("normalizes expected secret-access denials without swallowing unexpected resolver failures", async () => {
    const ref = parseSecretRef({ schemaVersion: 1, type: "named", namespace: "provider", version: null, expectedKind: "text", providerInstanceId: "gemini-never", name: "gemini-key" });
    const h = harness("never");
    const accessRequest: any = { descriptor: h.provider.describe(), model: (await h.provider.listModels())[0]!.model, request: req("secret-errors"), operationId: "op-secret-errors", requestedCapabilities: ["network-access"] };
    const makeAccess = (error: Error) => createPolicyAwareGeminiAccess({
      policy: { evaluate: () => ({ outcome: "allowed", code: "ALLOWED", fingerprint: "a".repeat(64) } as any) },
      resolver: { async withSecret() { throw error; } } as any,
      apiKeyRef: ref,
      context: { handlingPolicy: defaultDataHandlingPolicy, risk: "low", projectId: null },
    });
    for (const code of ["ACCESS_DENIED", "NOT_FOUND", "KIND_MISMATCH"]) {
      const failure = Object.assign(new Error("resolver detail"), { code });
      const access = makeAccess(failure);
      const authorization = await access.authorization.authorize(accessRequest);
      await expect(access.credentials.withApiKey({ ...accessRequest, authorization }, async () => "unused")).rejects.toMatchObject({ code: "POLICY_DENIED" });
    }
    const unexpected = new Error("unexpected resolver failure");
    const access = makeAccess(unexpected);
    const authorization = await access.authorization.authorize(accessRequest);
    await expect(access.credentials.withApiKey({ ...accessRequest, authorization }, async () => "unused")).rejects.toBe(unexpected);
    await h.provider.close();
  });

  it("uses manual redirects, bounds bodies, and classifies fetch failures", async () => {
    let init: RequestInit | undefined; const transport = createFetchGeminiTransport(async (_url, value) => { init = value; return new Response("ok", { status: 200 }); });
    const result = await transport.send({ url: "https://example.test", headers: {}, body: "{}", timeoutMs: 1_000, maxResponseBytes: 3 }); expect(await readGeminiBody(result.body, 3)).toBe("ok"); expect(init?.redirect).toBe("manual");
    await expect(createFetchGeminiTransport(async () => new Response(null, { status: 302 })).send({ url: "https://x", headers: {}, body: "{}", timeoutMs: 100, maxResponseBytes: 10 })).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
    await expect(createFetchGeminiTransport(async () => { throw new Error("secret socket"); }).send({ url: "https://x", headers: {}, body: "{}", timeoutMs: 100, maxResponseBytes: 10 })).rejects.toMatchObject({ code: "NETWORK_FAILURE" });
    await expect(readGeminiBody(bytes("four"), 3)).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it("aborts a pending fetch on both the configured timer and the caller signal", async () => {
    const waitingFetch: typeof fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted === true) { reject(new DOMException("already aborted", "AbortError")); return; }
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    const base = { url: "https://example.test", headers: {}, body: "{}", maxResponseBytes: 10 };
    await expect(createFetchGeminiTransport(waitingFetch).send({ ...base, timeoutMs: 1 })).rejects.toMatchObject({ code: "TIMEOUT" });

    let callerAbort!: () => void;
    const signal = { aborted: false, addEventListener(_type: "abort", listener: () => void) { callerAbort = listener; } };
    const pending = createFetchGeminiTransport(waitingFetch).send({ ...base, timeoutMs: 10_000, signal });
    await Promise.resolve();
    callerAbort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(createFetchGeminiTransport(waitingFetch).send({ ...base, timeoutMs: 10_000, signal: { aborted: true, addEventListener() {} } })).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("keeps the configured timeout active until the response body completes", async () => {
    const transport = createFetchGeminiTransport(async (_url, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted body", "AbortError")), { once: true });
      },
    })));
    const result = await transport.send({ url: "https://example.test", headers: {}, body: "{}", timeoutMs: 1, maxResponseBytes: 10 });
    await expect(readGeminiBody(result.body, 10)).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});
