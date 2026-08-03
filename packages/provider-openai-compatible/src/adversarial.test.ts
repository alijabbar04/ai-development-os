import { describe, expect, it } from "vitest";
import { parseJsonText } from "@ai-dev-os/domain";
import { ProviderError, createInferenceRequest, createTrace, type InferenceRequest } from "@ai-dev-os/providers";
import {
  buildChatCompletionsBody,
  createFetchHttpTransport,
  createOpenAiCompatibleProvider,
  defaultOpenAiCompatibleConfiguration,
  getOpenAiCompatibleProfile,
  httpStatusError,
  parseChatCompletion,
  parseChatCompletionDelta,
  parseChatCompletionSse,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  type ProviderAccessPort,
} from "./index.js";

const encode = new TextEncoder();
async function* bytes(...items: Array<string | Uint8Array>): AsyncIterable<Uint8Array> { for (const item of items) yield typeof item === "string" ? encode.encode(item) : item; }

function inference(id: string, input: any = {}): InferenceRequest {
  return createInferenceRequest({ requestId: id, modelId: "gpt-oss-120b", messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }], disclosure: { classification: "public", requiredLocality: "any", redactionApplied: false, decisionRef: null, retentionAllowed: false, loggingAllowed: false }, trace: createTrace(`trace-${id}`), ...input });
}

function access(key = "key"): ProviderAccessPort { return { withAuthorizedApiKey: async <T>(_request: any, use: (value: string) => Promise<T>) => use(key) }; }

class QueueTransport implements HttpTransport {
  readonly queue: HttpResponse[] = [];
  readonly requests: HttpRequest[] = [];
  async send(request: HttpRequest): Promise<HttpResponse> { this.requests.push(request); const item = this.queue.shift(); if (item === undefined) throw new ProviderError("NETWORK_FAILURE", "unscripted", {}); return item; }
}

function makeProvider(streaming: "always" | "never", transport: QueueTransport, key = "key") {
  return createOpenAiCompatibleProvider({ configuration: defaultOpenAiCompatibleConfiguration({ instanceId: `groq-${streaming}`, profileId: "groq-chat-completions-v1", modelId: "gpt-oss-120b", catalogModelId: "openai/gpt-oss-120b", streaming }), access: access(key), transport, clock: { now: () => new Date("2026-08-03T12:00:00.000Z") } });
}

function jsonResponse(value: unknown, status = 200): HttpResponse { return { status, headers: {}, body: bytes(JSON.stringify(value)) }; }
const baseUsage = { prompt_tokens: 1, completion_tokens: 1 };

describe("request shape edge cases", () => {
  it("maps assistant invocations, tool results, JSON parts, and all portable tool choices", () => {
    const messages: any[] = [
      { role: "user", parts: [{ type: "json", value: { request: true } }] },
      { role: "assistant", parts: [{ type: "text", text: "" }, { type: "tool-invocation", invocation: { toolCallId: "call-1", toolName: "read_file", arguments: { path: "a" } } }] },
      { role: "tool", parts: [{ type: "tool-result", result: { toolCallId: "call-1", toolName: "read_file", status: "succeeded", output: { ok: true }, failure: null } }] },
    ];
    const req = inference("roles", { messages, tools: [{ name: "read_file", description: "Read", inputSchema: {}, risk: "read-only", approval: "never", executionLocation: "caller" }], toolChoice: { mode: "required" } });
    const body: any = buildChatCompletionsBody(req, getOpenAiCompatibleProfile("groq-chat-completions-v1"), false, "upstream/model");
    expect(body.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", tool_calls: [expect.objectContaining({ id: "call-1" })] }), expect.objectContaining({ role: "tool", tool_call_id: "call-1" })]));
    expect(body.tool_choice).toBe("required");
    expect((buildChatCompletionsBody(inference("minimal"), getOpenAiCompatibleProfile("groq-chat-completions-v1"), false) as any).tools).toBeUndefined();
  });

  it("rejects incompatible tool-role and binary parts even when mapping is called directly", () => {
    const badTool = inference("bad-tool");
    expect(() => buildChatCompletionsBody({ ...badTool, messages: [{ role: "tool", parts: [{ type: "text", text: "bad" }] }] } as any, getOpenAiCompatibleProfile("groq-chat-completions-v1"), false)).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    const binary = inference("binary");
    expect(() => buildChatCompletionsBody({ ...binary, messages: [{ role: "user", parts: [{ type: "artifact", artifactId: "art-1", mediaType: "text/plain" }] }] } as any, getOpenAiCompatibleProfile("groq-chat-completions-v1"), false)).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_CAPABILITY" }));
  });
});

describe("wire adversaries", () => {
  it("parses completed tools and refuses malformed choices, usage, and arguments", () => {
    const valid: any = { model: "openai/gpt-oss-120b", choices: [{ finish_reason: "tool_calls", message: { content: null, reasoning: "why", tool_calls: [{ id: "call-1", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }] } }], usage: baseUsage };
    expect(parseChatCompletion(parseJsonText(JSON.stringify(valid)), valid.model)).toMatchObject({ finishReason: "tool-calls", invocations: [{ toolName: "read_file" }] });
    expect(() => parseChatCompletion(parseJsonText(JSON.stringify({ ...valid, choices: [] })), valid.model)).toThrowError(expect.objectContaining({ code: "MALFORMED_RESPONSE" }));
    expect(() => parseChatCompletion(parseJsonText(JSON.stringify({ ...valid, usage: null })), valid.model)).toThrowError(expect.objectContaining({ code: "MALFORMED_RESPONSE" }));
    valid.choices[0].message.tool_calls[0].function.arguments = "{";
    expect(() => parseChatCompletion(parseJsonText(JSON.stringify(valid)), valid.model)).toThrowError(expect.objectContaining({ code: "TOOL_PROTOCOL_FAILURE" }));
  });

  it("handles usage-only deltas and rejects multiple choices", () => {
    expect(parseChatCompletionDelta(parseJsonText(JSON.stringify({ model: "m", choices: [], usage: baseUsage })))).toMatchObject({ model: "m", usage: { toolCalls: 0 } });
    expect(() => parseChatCompletionDelta(parseJsonText(JSON.stringify({ choices: [{ delta: {} }, { delta: {} }] })))).toThrowError(expect.objectContaining({ code: "MALFORMED_RESPONSE" }));
    expect(httpStatusError(403, {}).code).toBe("AUTHORIZATION_FAILED");
    expect(httpStatusError(404, {}).code).toBe("MODEL_UNAVAILABLE");
    expect(httpStatusError(408, {}).code).toBe("TIMEOUT");
    expect(httpStatusError(413, {}).code).toBe("CONTEXT_LIMIT_EXCEEDED");
    expect(httpStatusError(400, {}).code).toBe("INVALID_REQUEST");
  });

  it("rejects invalid JSON, continuation after DONE, invalid UTF-8, and byte overflows", async () => {
    const consume = async (body: AsyncIterable<Uint8Array>, maxStreamBytes = 100, maxEventBytes = 50) => { for await (const _ of parseChatCompletionSse(body, { maxStreamBytes, maxEventBytes })) void _; };
    await expect(consume(bytes("data: nope\n\ndata: [DONE]\n\n"))).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    await expect(consume(bytes("data: [DONE]\n\ndata: {}\n\n"))).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
    await expect(consume(bytes(new Uint8Array([0xff, 0xff])))).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    await expect(consume(bytes("x".repeat(101)), 100, 100)).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    await expect(consume(bytes(`data: ${"x".repeat(51)}\n\n`), 1_000, 50)).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });
});

describe("fetch transport", () => {
  const request: HttpRequest = { url: "https://example.test/v1", method: "POST", headers: { Authorization: "Bearer secret" }, body: "{}", redirect: "reject", timeoutMs: 1_000, maxResponseBytes: 3 };
  it("uses manual redirects and streams a bounded successful response", async () => {
    let init: RequestInit | undefined;
    const transport = createFetchHttpTransport(async (_url, input) => { init = input; return new Response("ok", { status: 200, headers: { "X-Test": "yes" } }); });
    const result = await transport.send(request);
    let output = "";
    for await (const chunk of result.body) output += new TextDecoder().decode(chunk);
    expect(output).toBe("ok");
    expect(init?.redirect).toBe("manual");
    expect(result.headers["x-test"]).toBe("yes");
  });

  it("rejects redirects, network failures, and oversized response streams", async () => {
    await expect(createFetchHttpTransport(async () => new Response(null, { status: 302 })).send(request)).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
    await expect(createFetchHttpTransport(async () => { throw new Error("socket secret"); }).send(request)).rejects.toMatchObject({ code: "NETWORK_FAILURE" });
    const result = await createFetchHttpTransport(async () => new Response("four", { status: 200 })).send(request);
    await expect(async () => { for await (const _ of result.body) void _; }).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it("classifies its own abort deadline as a timeout", async () => {
    const transport = createFetchHttpTransport(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    await expect(transport.send({ ...request, timeoutMs: 1 })).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

describe("provider failure boundaries", () => {
  it("handles structured JSON/tool output and lifecycle surfaces", async () => {
    const transport = new QueueTransport();
    const provider = makeProvider("never", transport);
    transport.queue.push(jsonResponse({ model: "openai/gpt-oss-120b", choices: [{ finish_reason: "tool_calls", message: { content: "{\"ok\":true}", tool_calls: [{ id: "call-1", function: { name: "read_file", arguments: "{}" } }] } }], usage: baseUsage }));
    const req = inference("structured", { structuredOutput: { schema: { type: "object" }, strict: true }, tools: [{ name: "read_file", description: "Read", inputSchema: {}, risk: "read-only", approval: "never", executionLocation: "caller" }] });
    const operation = await provider.start(req);
    expect((await operation.result).structuredOutput).toEqual({ ok: true });
    expect((await provider.health()).status).toBe("ready");
    expect(await provider.listModels()).toHaveLength(1);
    await provider.close();
    expect((await provider.health()).status).toBe("closed");
    await expect(provider.start(req)).rejects.toMatchObject({ code: "PROVIDER_CLOSED" });
  });

  it("fails before transport for expired deadlines and malformed keys", async () => {
    const transport = new QueueTransport();
    const provider = makeProvider("never", transport);
    const expired = await provider.start(inference("expired", { deadline: "2026-08-03T11:00:00.000Z" }));
    await expect(expired.result).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    expect(transport.requests).toHaveLength(0);
    await provider.close();

    const secondTransport = new QueueTransport();
    const badKey = makeProvider("never", secondTransport, "bad\nkey");
    const operation = await badKey.start(inference("bad-key"));
    await expect(operation.result).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(secondTransport.requests).toHaveLength(0);
    await badKey.close();
  });

  it("rejects malformed JSON, missing usage, stream model substitution, and duplicate finish", async () => {
    const malformedTransport = new QueueTransport();
    const malformed = makeProvider("never", malformedTransport);
    malformedTransport.queue.push({ status: 200, headers: {}, body: bytes("not-json") });
    const one = await malformed.start(inference("malformed"));
    await expect(one.result).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    await malformed.close();

    const streamTransport = new QueueTransport();
    const stream = makeProvider("always", streamTransport);
    streamTransport.queue.push({ status: 200, headers: {}, body: bytes(`data: ${JSON.stringify({ model: "substitute", choices: [{ delta: { content: "x" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`) });
    const two = await stream.start(inference("substitution"));
    await expect(two.result).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
    await stream.close();

    const duplicateTransport = new QueueTransport();
    const duplicate = makeProvider("always", duplicateTransport);
    const terminal = JSON.stringify({ model: "openai/gpt-oss-120b", choices: [{ delta: {}, finish_reason: "stop" }] });
    duplicateTransport.queue.push({ status: 200, headers: {}, body: bytes(`data: ${terminal}\n\ndata: ${terminal}\n\ndata: [DONE]\n\n`) });
    const three = await duplicate.start(inference("duplicate"));
    await expect(three.result).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
    await duplicate.close();
  });
});
