import { describe, expect, it } from "vitest";
import { parseModelCapabilities } from "@ai-dev-os/domain";
import {
  createCodingAgentRequest,
  createInferenceRequest,
  parseDisclosureContext,
  type ProviderOperationRecord,
} from "@ai-dev-os/providers";
import {
  createFakeCodingAgentProvider,
  createFakeInferenceProvider,
  createManualScheduler,
  INTERNAL_DISCLOSURE,
  TESTKIT_TRACE,
} from "../src/index.js";

function inferenceRequest(id: string, overrides: Record<string, unknown> = {}) {
  return createInferenceRequest({
    requestId: id,
    modelId: "fake-model",
    messages: [{ role: "user", parts: [{ type: "text", text: "go" }] }],
    disclosure: INTERNAL_DISCLOSURE,
    trace: TESTKIT_TRACE,
    ...overrides,
  });
}

function codingRequest(id: string, overrides: Record<string, unknown> = {}) {
  return createCodingAgentRequest({
    requestId: id,
    workspaceId: "ws-1",
    instructions: "do the scripted thing",
    capabilities: ["read-files", "edit-files"],
    disclosure: INTERNAL_DISCLOSURE,
    trace: TESTKIT_TRACE,
    ...overrides,
  });
}

describe("fake inference edge behavior", () => {
  it("supports warnings, explicit finish reasons, empty text, and explicit tool ids", async () => {
    const provider = createFakeInferenceProvider({
      script: {
        steps: [
          { kind: "warning", message: "sampling clamped" },
          { kind: "text", text: "" },
          { kind: "tool-call", toolName: "read-file", toolCallId: "call-custom", arguments: { p: 1 } },
          { kind: "finish", finishReason: "length" },
        ],
      },
    });
    const operation = await provider.start(inferenceRequest("req-edge-1"));
    const kinds: string[] = [];
    for await (const event of operation.events()) {
      kinds.push(event.kind);
    }
    expect(kinds).toContain("warning");
    const result = await operation.result;
    expect(result.finishReason).toBe("length");
    const invocations = result.messages.flatMap((message) =>
      message.parts.filter((part) => part.type === "tool-invocation"),
    );
    expect(
      (invocations[0] as Extract<(typeof invocations)[number], { type: "tool-invocation" }>)
        .invocation.toolCallId,
    ).toBe("call-custom");
    await provider.close();
  });

  it("returns empty result messages and unknown cost for content-free scripts", async () => {
    const freeModel = parseModelCapabilities({
      schemaVersion: 1,
      providerId: "fake-inference",
      modelId: "free-model",
      contextWindowTokens: 1_000,
      maxOutputTokens: 100,
      supportsToolUse: false,
      supportsStructuredOutput: false,
      supportsVision: false,
      locality: "local",
      latencyClass: "fast",
      codingCapability: 1,
      reasoningCapability: 1,
      cost: null,
    });
    const provider = createFakeInferenceProvider({
      script: { steps: [{ kind: "usage", inputTokens: 3, outputTokens: 4 }] },
      models: [freeModel],
      descriptor: { locality: "local" },
    });
    const result = await (
      await provider.start(inferenceRequest("req-edge-2", { modelId: "free-model" }))
    ).result;
    expect(result.messages).toHaveLength(0);
    expect(result.cost.locallyComputed).toBeNull();
    expect(result.usage.tokens.inputTokens).toBe(3);
    await provider.close();
  });

  it("accepts local-only disclosure on local providers and script-as-function", async () => {
    const scripts: string[] = [];
    const provider = createFakeInferenceProvider({
      script: (request) => {
        scripts.push(request.requestId as string);
        return { steps: [{ kind: "text", text: `echo:${request.requestId}` }] };
      },
      descriptor: {
        locality: "local",
        supportedClassifications: ["public", "internal", "secret"],
      },
    });
    const result = await (
      await provider.start(
        inferenceRequest("req-edge-3", {
          disclosure: parseDisclosureContext({
            classification: "secret",
            requiredLocality: "local-only",
            redactionApplied: false,
            decisionRef: null,
            retentionAllowed: false,
            loggingAllowed: false,
          }),
        }),
      )
    ).result;
    expect(scripts).toEqual(["req-edge-3"]);
    expect(result.messages[0]!.parts[0]).toEqual({ type: "text", text: "echo:req-edge-3" });
    await provider.close();
  });

  it("cancels immediately when the abort signal is already aborted", async () => {
    const provider = createFakeInferenceProvider({
      script: { steps: [{ kind: "text", text: "never" }] },
    });
    const abort = new AbortController();
    abort.abort();
    const operation = await provider.start(inferenceRequest("req-edge-4"), {
      signal: abort.signal,
    });
    await expect(operation.result).rejects.toMatchObject({
      code: "CANCELLED",
      details: { reason: "caller-aborted" },
    });
    await provider.close();
  });

  it("rejects hostile requests and guards raw streams against double consumption", async () => {
    const provider = createFakeInferenceProvider({
      script: {
        steps: [],
        rawStream: { events: [], rawResult: "resolve-empty" },
      },
    });
    await expect(provider.start(null as never)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    const operation = await provider.start(inferenceRequest("req-edge-5"));
    operation.events();
    expect(() => operation.events()).toThrow();
    await operation.cancel();
    await provider.close();
  });

  it("expires deadlines during manual-scheduler delays", async () => {
    const scheduler = createManualScheduler();
    const provider = createFakeInferenceProvider({
      script: {
        steps: [
          { kind: "text", text: "before" },
          { kind: "delay", ms: 120_000 },
          { kind: "text", text: "after" },
        ],
      },
      scheduler,
    });
    const operation = await provider.start(
      inferenceRequest("req-edge-6", { deadline: "2026-08-02T12:01:00.000Z" }),
    );
    scheduler.advance(180_000);
    await expect(operation.result).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    await provider.close();
  });
});

describe("fake coding-agent edge behavior", () => {
  it("supports output chunks, warnings, proposed-only changes, finish metadata", async () => {
    const records: ProviderOperationRecord[] = [];
    const provider = createFakeCodingAgentProvider({
      script: {
        steps: [
          { kind: "output", channel: "stdout", text: "compiling" },
          { kind: "output", channel: "stderr", text: "warnings found" },
          { kind: "warning", message: "network denied" },
          { kind: "file-change", path: "src/skip.ts", changeKind: "modified", applied: false },
          { kind: "finish", completion: "partial", resumeToken: "resume-1" },
        ],
      },
      observer: (record) => {
        records.push(record);
      },
    });
    const operation = await provider.start(codingRequest("req-agent-edge-1"));
    const kinds: string[] = [];
    for await (const event of operation.events()) {
      kinds.push(event.kind);
    }
    expect(kinds).toContain("output-chunk");
    expect(kinds).toContain("warning");
    expect(kinds).toContain("file-change-proposed");
    expect(kinds).not.toContain("file-change-applied");
    const result = await operation.result;
    expect(result.completion).toBe("partial");
    expect(result.resumeToken).toBe("resume-1");
    expect(result.changedFiles).toHaveLength(0);
    expect(records[0]).toMatchObject({ providerKind: "coding-agent", outcome: "succeeded" });
    await provider.close();
  });

  it("rejects hostile requests, scripted start rejections, and pre-start deadlines", async () => {
    const provider = createFakeCodingAgentProvider({
      script: { steps: [], rejectStart: { code: "PROVIDER_OVERLOADED" } },
    });
    await expect(provider.start(42 as never)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(provider.start(codingRequest("req-agent-edge-2"))).rejects.toMatchObject({
      code: "PROVIDER_OVERLOADED",
    });
    await provider.close();

    const scheduler = createManualScheduler();
    const deadlineProvider = createFakeCodingAgentProvider({
      script: { steps: [] },
      scheduler,
    });
    await expect(
      deadlineProvider.start(
        codingRequest("req-agent-edge-3", { deadline: "2026-08-02T12:00:00.000Z" }),
      ),
    ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    await deadlineProvider.close();
  });

  it("honors abort signals and script-as-function", async () => {
    const provider = createFakeCodingAgentProvider({
      script: (request) => ({
        steps: [
          { kind: "status", message: `working on ${request.workspaceId as string}` },
          { kind: "delay", ms: 60_000 },
        ],
      }),
      scheduler: createManualScheduler(),
    });
    const abort = new AbortController();
    const operation = await provider.start(codingRequest("req-agent-edge-4"), {
      signal: abort.signal,
    });
    abort.abort();
    await expect(operation.result).rejects.toMatchObject({
      code: "CANCELLED",
      details: { reason: "caller-aborted" },
    });
    await provider.close();
  });

  it("rejects disallowed classifications before capture", async () => {
    const provider = createFakeCodingAgentProvider({
      script: { steps: [] },
      descriptor: { supportedClassifications: ["public"] },
    });
    await expect(provider.start(codingRequest("req-agent-edge-5"))).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
    expect(provider.capturedRequests).toHaveLength(0);
    await provider.close();
  });
});
