import { describe, expect, it } from "vitest";
import {
  guardProviderOperation,
  isProviderError,
  parseInferenceEvent,
  parseInferenceResult,
  type InferenceEvent,
  type InferenceOperation,
  type InferenceResult,
  type ProviderError,
} from "@ai-dev-os/providers";
import {
  functionCallItem,
  messageItem,
  refusalItem,
  resetSequence,
  responseObject,
  sse,
  textStreamScript,
  usageObject,
} from "./helpers/fake-openai.js";
import { READ_TOOL, TEST_MODEL, createTestProvider, testRequest } from "./helpers/fixtures.js";

interface Consumed {
  readonly events: readonly InferenceEvent[];
  readonly streamError: unknown;
  readonly result: InferenceResult | null;
  readonly error: unknown;
}

async function consume(operation: InferenceOperation): Promise<Consumed> {
  const events: InferenceEvent[] = [];
  let streamError: unknown = null;
  try {
    for await (const event of operation.events()) {
      events.push(event);
    }
  } catch (error) {
    streamError = error;
  }
  try {
    return { events, streamError, result: await operation.result, error: null };
  } catch (error) {
    return { events, streamError, result: null, error };
  }
}

function guarded(operation: InferenceOperation): InferenceOperation {
  return guardProviderOperation(operation, {
    parseEvent: parseInferenceEvent,
    parseResult: parseInferenceResult,
  });
}

function textOf(result: InferenceResult): string {
  return result.messages
    .flatMap((message) => message.parts)
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

describe("streaming text responses", () => {
  it("streams deltas whose concatenation equals the result text", async () => {
    const { provider, fake } = createTestProvider();
    fake.script("create", { stream: textStreamScript(["Hello", ", ", "world."]) });

    const operation = guarded(await provider.start(testRequest("basic")));
    const consumed = await consume(operation);

    expect(consumed.streamError).toBeNull();
    expect(consumed.result).not.toBeNull();
    const streamed = consumed.events
      .filter((event) => event.kind === "text-delta")
      .map((event) => (event as Extract<InferenceEvent, { kind: "text-delta" }>).payload.text)
      .join("");
    expect(streamed).toBe("Hello, world.");
    expect(textOf(consumed.result!)).toBe("Hello, world.");
    expect(consumed.result!.finishReason).toBe("stop");
    expect(consumed.events[0]!.kind).toBe("operation-started");
    expect(consumed.events[consumed.events.length - 1]!.kind).toBe("operation-completed");
    await provider.close();
  });

  it("reassembles events split at arbitrary byte boundaries, including inside UTF-8", async () => {
    // A four-byte emoji and a two-byte accented character are split across
    // one-byte chunks, so the decoder must buffer partial sequences.
    const frames = textStreamScript(["héllo ", "🌍", " done"]);
    for (const chunkSize of [1, 2, 3, 7, 64]) {
      const { provider, fake } = createTestProvider();
      fake.script("create", { stream: frames, byteChunkSize: chunkSize });
      const consumed = await consume(guarded(await provider.start(testRequest("split"))));
      expect(consumed.streamError, `chunk size ${chunkSize}`).toBeNull();
      expect(textOf(consumed.result!), `chunk size ${chunkSize}`).toBe("héllo 🌍 done");
      await provider.close();
    }
  });

  it("accepts CRLF framing and multi-line data fields", async () => {
    resetSequence();
    const created = JSON.stringify({
      type: "response.created",
      sequence_number: 1,
      response: responseObject({ status: "in_progress" }),
    });
    // A payload split across two `data:` lines must be joined with "\n".
    const deltaPayload = JSON.stringify({
      type: "response.output_text.delta",
      sequence_number: 2,
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: "chunk",
      logprobs: [],
    });
    const half = Math.floor(deltaPayload.length / 2);
    const completed = JSON.stringify({
      type: "response.completed",
      sequence_number: 3,
      response: responseObject({
        status: "completed",
        output: [messageItem("chunk")],
        usage: usageObject(),
      }),
    });

    const { provider, fake } = createTestProvider();
    fake.script("create", {
      stream: [
        `: heartbeat comment\r\n`,
        `event: response.created\r\ndata: ${created}\r\n\r\n`,
        `data: ${deltaPayload.slice(0, half)}`,
        `${deltaPayload.slice(half)}\r\n\r\n`,
        `data: ${completed}\r\n\r\n`,
      ],
    });

    const consumed = await consume(guarded(await provider.start(testRequest("crlf"))));
    expect(consumed.streamError).toBeNull();
    expect(textOf(consumed.result!)).toBe("chunk");
    await provider.close();
  });

  it("ignores the [DONE] sentinel and informational events", async () => {
    resetSequence();
    const { provider, fake } = createTestProvider();
    fake.script("create", {
      stream: [
        sse("response.created", { response: responseObject({ status: "in_progress" }) }),
        sse("response.content_part.added", {
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "" },
        }),
        sse("response.output_text.delta", {
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: "ok",
          logprobs: [],
        }),
        sse("response.content_part.done", {
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "ok" },
        }),
        sse("response.completed", {
          response: responseObject({ status: "completed", output: [messageItem("ok")], usage: usageObject() }),
        }),
        "data: [DONE]\n\n",
      ],
    });

    const consumed = await consume(guarded(await provider.start(testRequest("informational"))));
    expect(consumed.streamError).toBeNull();
    expect(textOf(consumed.result!)).toBe("ok");
    await provider.close();
  });
});

describe("structured output", () => {
  it("emits a completed event whose value matches the validated result", async () => {
    resetSequence();
    const { provider, fake } = createTestProvider();
    const json = '{"answer":42,"ok":true}';
    fake.script("create", {
      stream: [
        sse("response.created", { response: responseObject({ status: "in_progress" }) }),
        sse("response.output_text.delta", {
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: '{"answer":42,',
          logprobs: [],
        }),
        sse("response.output_text.delta", {
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: '"ok":true}',
          logprobs: [],
        }),
        sse("response.completed", {
          response: responseObject({ status: "completed", output: [messageItem(json)], usage: usageObject() }),
        }),
      ],
    });

    const request = testRequest("structured", {
      structuredOutput: {
        schema: {
          type: "object",
          properties: { answer: { type: "integer" }, ok: { type: "boolean" } },
          required: ["answer", "ok"],
          additionalProperties: false,
        },
        strict: true,
      },
    });
    const consumed = await consume(guarded(await provider.start(request)));
    expect(consumed.streamError).toBeNull();
    const completedEvent = consumed.events.find((event) => event.kind === "structured-output-completed");
    expect(completedEvent).toBeDefined();
    expect(consumed.result!.structuredOutput).toEqual({ answer: 42, ok: true });
    expect(
      (completedEvent as Extract<InferenceEvent, { kind: "structured-output-completed" }>).payload.value,
    ).toEqual(consumed.result!.structuredOutput);
    await provider.close();
  });

  it("fails when the structured value violates the caller's schema", async () => {
    resetSequence();
    const { provider, fake } = createTestProvider();
    const json = '{"answer":"not-an-integer"}';
    fake.script("create", {
      stream: [
        sse("response.created", { response: responseObject({ status: "in_progress" }) }),
        sse("response.output_text.delta", {
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: json,
          logprobs: [],
        }),
        sse("response.completed", {
          response: responseObject({ status: "completed", output: [messageItem(json)], usage: usageObject() }),
        }),
      ],
    });

    const request = testRequest("structured-bad", {
      structuredOutput: {
        schema: {
          type: "object",
          properties: { answer: { type: "integer" } },
          required: ["answer"],
          additionalProperties: false,
        },
        strict: true,
      },
    });
    const consumed = await consume(guarded(await provider.start(request)));
    expect(isProviderError(consumed.error, "MALFORMED_RESPONSE")).toBe(true);
    expect((consumed.error as ProviderError).details["detailCode"]).toBe(
      "structured-output-schema-mismatch",
    );
    await provider.close();
  });

  it("fails when structured output is truncated", async () => {
    resetSequence();
    const { provider, fake } = createTestProvider();
    fake.script("create", {
      stream: [
        sse("response.created", { response: responseObject({ status: "in_progress" }) }),
        sse("response.output_text.delta", {
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: '{"answer":',
          logprobs: [],
        }),
        sse("response.incomplete", {
          response: responseObject({
            status: "incomplete",
            incompleteReason: "max_output_tokens",
            output: [messageItem('{"answer":')],
            usage: usageObject(),
          }),
        }),
      ],
    });
    const request = testRequest("structured-truncated", {
      structuredOutput: { schema: { type: "object" }, strict: true },
    });
    const consumed = await consume(guarded(await provider.start(request)));
    expect(isProviderError(consumed.error, "MALFORMED_RESPONSE")).toBe(true);
    expect((consumed.error as ProviderError).details["detailCode"]).toBe("structured-output-truncated");
    await provider.close();
  });
});

describe("function tool calls", () => {
  it("runs the full tool-call lifecycle and returns the invocation", async () => {
    resetSequence();
    const { provider, fake } = createTestProvider();
    fake.script("create", {
      stream: [
        sse("response.created", { response: responseObject({ status: "in_progress" }) }),
        sse("response.output_item.added", {
          output_index: 0,
          item: {
            id: "fc_1",
            type: "function_call",
            call_id: "call_1",
            name: "read-file",
            arguments: "",
            status: "in_progress",
          },
        }),
        sse("response.function_call_arguments.delta", {
          item_id: "fc_1",
          output_index: 0,
          delta: '{"path":',
        }),
        sse("response.function_call_arguments.delta", {
          item_id: "fc_1",
          output_index: 0,
          delta: '"src/a.ts"}',
        }),
        sse("response.function_call_arguments.done", {
          item_id: "fc_1",
          output_index: 0,
          name: "read-file",
          arguments: '{"path":"src/a.ts"}',
        }),
        sse("response.completed", {
          response: responseObject({
            status: "completed",
            output: [functionCallItem("read-file", '{"path":"src/a.ts"}')],
            usage: usageObject(),
          }),
        }),
      ],
    });

    const consumed = await consume(
      guarded(await provider.start(testRequest("tool", { tools: [READ_TOOL] }))),
    );
    expect(consumed.streamError).toBeNull();
    expect(consumed.events.filter((event) => event.kind === "tool-call-started")).toHaveLength(1);
    expect(consumed.events.filter((event) => event.kind === "tool-call-delta")).toHaveLength(2);
    const completed = consumed.events.filter((event) => event.kind === "tool-call-completed");
    expect(completed).toHaveLength(1);
    expect(consumed.result!.finishReason).toBe("tool-calls");
    const invocation = (
      completed[0] as Extract<InferenceEvent, { kind: "tool-call-completed" }>
    ).payload.invocation;
    expect(invocation.toolCallId).toBe("call_1");
    expect(invocation.arguments).toEqual({ path: "src/a.ts" });
    expect(consumed.result!.usage.toolCalls).toBe(1);
    await provider.close();
  });

  it("rejects a tool the request never declared", async () => {
    resetSequence();
    const { provider, fake } = createTestProvider();
    fake.script("create", {
      stream: [
        sse("response.created", { response: responseObject({ status: "in_progress" }) }),
        sse("response.output_item.added", {
          output_index: 0,
          item: {
            id: "fc_1",
            type: "function_call",
            call_id: "call_1",
            name: "delete-everything",
            arguments: "",
            status: "in_progress",
          },
        }),
      ],
    });
    const consumed = await consume(
      guarded(await provider.start(testRequest("undeclared", { tools: [READ_TOOL] }))),
    );
    expect(isProviderError(consumed.error, "TOOL_PROTOCOL_FAILURE")).toBe(true);
    await provider.close();
  });

  it("rejects tool arguments that are not valid JSON", async () => {
    resetSequence();
    const { provider, fake } = createTestProvider();
    fake.script("create", {
      stream: [
        sse("response.created", { response: responseObject({ status: "in_progress" }) }),
        sse("response.output_item.added", {
          output_index: 0,
          item: {
            id: "fc_1",
            type: "function_call",
            call_id: "call_1",
            name: "read-file",
            arguments: "",
            status: "in_progress",
          },
        }),
        sse("response.function_call_arguments.done", {
          item_id: "fc_1",
          output_index: 0,
          name: "read-file",
          arguments: "{not json",
        }),
      ],
    });
    const consumed = await consume(
      guarded(await provider.start(testRequest("bad-args", { tools: [READ_TOOL] }))),
    );
    expect(isProviderError(consumed.error, "TOOL_PROTOCOL_FAILURE")).toBe(true);
    await provider.close();
  });
});

describe("refusal and incompleteness", () => {
  it("reports a refusal with the refusal finish reason", async () => {
    resetSequence();
    const { provider, fake } = createTestProvider();
    fake.script("create", {
      stream: [
        sse("response.created", { response: responseObject({ status: "in_progress" }) }),
        sse("response.refusal.delta", {
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: "I cannot ",
        }),
        sse("response.refusal.delta", {
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: "help with that.",
        }),
        sse("response.refusal.done", {
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          refusal: "I cannot help with that.",
        }),
        sse("response.completed", {
          response: responseObject({
            status: "completed",
            output: [refusalItem("I cannot help with that.")],
            usage: usageObject(),
          }),
        }),
      ],
    });
    const consumed = await consume(guarded(await provider.start(testRequest("refusal"))));
    expect(consumed.streamError).toBeNull();
    expect(consumed.result!.finishReason).toBe("refusal");
    expect(consumed.result!.refusalMessage).toBe("I cannot help with that.");
    await provider.close();
  });

  it("maps an output-token cutoff to the length finish reason", async () => {
    resetSequence();
    const { provider, fake } = createTestProvider();
    fake.script("create", {
      stream: [
        sse("response.created", { response: responseObject({ status: "in_progress" }) }),
        sse("response.output_text.delta", {
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: "partial",
          logprobs: [],
        }),
        sse("response.incomplete", {
          response: responseObject({
            status: "incomplete",
            incompleteReason: "max_output_tokens",
            output: [messageItem("partial")],
            usage: usageObject(),
          }),
        }),
      ],
    });
    const consumed = await consume(guarded(await provider.start(testRequest("length"))));
    expect(consumed.streamError).toBeNull();
    expect(consumed.result!.finishReason).toBe("length");
    await provider.close();
  });

  it("maps a content filter cutoff to the content-filter finish reason", async () => {
    resetSequence();
    const { provider, fake } = createTestProvider();
    fake.script("create", {
      stream: [
        sse("response.created", { response: responseObject({ status: "in_progress" }) }),
        sse("response.incomplete", {
          response: responseObject({
            status: "incomplete",
            incompleteReason: "content_filter",
            output: [],
            usage: usageObject(),
          }),
        }),
      ],
    });
    const consumed = await consume(guarded(await provider.start(testRequest("filtered"))));
    expect(consumed.result!.finishReason).toBe("content-filter");
    await provider.close();
  });

  it("fails on a terminal response.failed event", async () => {
    resetSequence();
    const { provider, fake } = createTestProvider();
    fake.script("create", {
      stream: [
        sse("response.created", { response: responseObject({ status: "in_progress" }) }),
        sse("response.failed", {
          response: responseObject({
            status: "failed",
            error: { code: "server_error", message: "boom" },
          }),
        }),
      ],
    });
    const consumed = await consume(guarded(await provider.start(testRequest("failed"))));
    expect(isProviderError(consumed.error, "INTERNAL_FAILURE")).toBe(true);
    await provider.close();
  });

  it("fails closed on an unknown stream event rather than ignoring it", async () => {
    resetSequence();
    const { provider, fake } = createTestProvider();
    fake.script("create", {
      stream: [
        sse("response.created", { response: responseObject({ status: "in_progress" }) }),
        sse("response.web_search_call.in_progress", { output_index: 0, item_id: "ws_1" }),
      ],
    });
    const consumed = await consume(guarded(await provider.start(testRequest("hosted-tool"))));
    expect(isProviderError(consumed.error, "PROTOCOL_VIOLATION")).toBe(true);
    expect((consumed.error as ProviderError).details["detailCode"]).toBe("unsupported-stream-event");
    await provider.close();
  });

  it("fails when the stream ends without a terminal response", async () => {
    resetSequence();
    const { provider, fake } = createTestProvider();
    fake.script("create", {
      stream: [
        sse("response.created", { response: responseObject({ status: "in_progress" }) }),
        { truncate: true },
      ],
    });
    const consumed = await consume(guarded(await provider.start(testRequest("truncated"))));
    expect(isProviderError(consumed.error, "NETWORK_FAILURE")).toBe(true);
    expect((consumed.error as ProviderError).retry.operationMayStillBeRunning).toBe(true);
    await provider.close();
  });

  it("detects disagreement between streamed deltas and the final text", async () => {
    resetSequence();
    const { provider, fake } = createTestProvider();
    fake.script("create", {
      stream: [
        sse("response.created", { response: responseObject({ status: "in_progress" }) }),
        sse("response.output_text.delta", {
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: "streamed",
          logprobs: [],
        }),
        sse("response.output_text.done", {
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          text: "something else entirely",
          logprobs: [],
        }),
      ],
    });
    const consumed = await consume(guarded(await provider.start(testRequest("disagree"))));
    expect(isProviderError(consumed.error, "MALFORMED_RESPONSE")).toBe(true);
    expect((consumed.error as ProviderError).details["detailCode"]).toBe(
      "text-delta-final-disagreement",
    );
    await provider.close();
  });
});

describe("usage reconciliation", () => {
  it("splits OpenAI's nested counts into the disjoint domain categories", async () => {
    const { provider, fake } = createTestProvider();
    fake.script("create", {
      stream: textStreamScript(["hi"], {
        usage: usageObject({
          inputTokens: 1_000,
          cachedTokens: 400,
          cacheWriteTokens: 100,
          outputTokens: 500,
          reasoningTokens: 200,
        }),
      }),
    });
    const consumed = await consume(guarded(await provider.start(testRequest("usage"))));
    expect(consumed.streamError).toBeNull();
    // cached is a detail of input and reasoning a detail of output, so the
    // disjoint projection subtracts rather than double counting.
    expect(consumed.result!.usage.tokens).toEqual({
      inputTokens: 600,
      cachedInputTokens: 400,
      outputTokens: 300,
      reasoningTokens: 200,
    });
    // 600 + 400 + 300 + 200 == the reported total of 1500.
    expect(consumed.result!.usage.tokens.inputTokens + consumed.result!.usage.tokens.cachedInputTokens).toBe(
      1_000,
    );
    await provider.close();
  });

  it("emits cumulative usage snapshots and never double counts a replayed value", async () => {
    const { provider, fake } = createTestProvider();
    fake.script("create", { stream: textStreamScript(["a"], { usage: usageObject() }) });
    const consumed = await consume(guarded(await provider.start(testRequest("cumulative"))));
    const updates = consumed.events.filter((event) => event.kind === "usage-update");
    expect(updates.length).toBeGreaterThanOrEqual(2);
    const last = (updates[updates.length - 1] as Extract<InferenceEvent, { kind: "usage-update" }>)
      .payload.usage;
    expect(consumed.result!.usage.tokens).toEqual(last.tokens);
    await provider.close();
  });

  it("computes cost from the effective pricing snapshot with exact integer arithmetic", async () => {
    const { provider, fake } = createTestProvider();
    fake.script("create", {
      stream: textStreamScript(["x"], {
        usage: usageObject({ inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 1_000_000 }),
      }),
    });
    const consumed = await consume(guarded(await provider.start(testRequest("cost"))));
    // 1e6 input at 1_250_000 micros/1e6 tokens + 1e6 output at 10_000_000.
    expect(consumed.result!.cost.locallyComputed).toEqual({
      currency: "USD",
      amountMicros: 11_250_000,
    });
    expect(consumed.result!.cost.providerReported).toBeNull();
    await provider.close();
  });

  it("reports unknown cost and warns when no pricing slice is effective", async () => {
    const { provider, fake } = createTestProvider({
      configuration: { catalog: undefined },
    });
    void provider;
    const handle = createTestProvider({
      configuration: {
        catalog: (await import("./helpers/fixtures.js")).testCatalog({ pricing: [] }),
      },
    });
    handle.fake.script("create", { stream: textStreamScript(["x"], { usage: usageObject() }) });
    const consumed = await consume(guarded(await handle.provider.start(testRequest("no-price"))));
    expect(consumed.result!.cost.locallyComputed).toBeNull();
    expect(consumed.result!.warnings.some((warning) => warning.includes("pricing snapshot"))).toBe(true);
    await handle.provider.close();
    await provider.close();
  });

  it("rejects contradictory usage rather than reporting impossible totals", async () => {
    resetSequence();
    const { provider, fake } = createTestProvider();
    fake.script("create", {
      stream: [
        sse("response.created", { response: responseObject({ status: "in_progress" }) }),
        sse("response.completed", {
          response: responseObject({
            status: "completed",
            output: [messageItem("hi")],
            usage: {
              input_tokens: 10,
              input_tokens_details: { cached_tokens: 50, cache_write_tokens: 0 },
              output_tokens: 5,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: 15,
            },
          }),
        }),
      ],
    });
    const consumed = await consume(guarded(await provider.start(testRequest("bad-usage"))));
    expect(isProviderError(consumed.error, "MALFORMED_RESPONSE")).toBe(true);
    expect((consumed.error as ProviderError).details["detailCode"]).toBe(
      "contradictory-usage-cached-exceeds-input",
    );
    await provider.close();
  });
});

describe("model selection", () => {
  it("refuses a model outside the permitted list", async () => {
    const { provider } = createTestProvider();
    await expect(provider.start(testRequest("other", { modelId: "some-other-model" }))).rejects.toMatchObject(
      { code: "POLICY_DENIED" },
    );
    await provider.close();
  });

  it("lists only permitted models effective at the current instant", async () => {
    const { provider } = createTestProvider();
    const models = await provider.listModels();
    expect(models.map((descriptor) => descriptor.model.modelId)).toEqual([TEST_MODEL]);
    await provider.close();
  });

  it("rejects a duplicate tool-call start instead of overwriting its state", async () => {
    resetSequence();
    const { provider, fake } = createTestProvider();
    const added = {
      output_index: 0,
      item: {
        id: "fc_duplicate",
        type: "function_call",
        call_id: "call_duplicate",
        name: "read-file",
        arguments: "",
        status: "in_progress",
      },
    };
    fake.script("create", {
      stream: [
        sse("response.created", { response: responseObject({ status: "in_progress" }) }),
        sse("response.output_item.added", added),
        sse("response.output_item.added", added),
      ],
    });
    const consumed = await consume(
      guarded(await provider.start(testRequest("duplicate-tool-start", { tools: [READ_TOOL] }))),
    );
    expect(isProviderError(consumed.error, "TOOL_PROTOCOL_FAILURE")).toBe(true);
    expect((consumed.error as ProviderError).details["detailCode"]).toBe("duplicate-tool-call-start");
    await provider.close();
  });

  it("reconciles text-done events independently for multiple output items", async () => {
    resetSequence();
    const { provider, fake } = createTestProvider();
    fake.script("create", {
      stream: [
        sse("response.created", { response: responseObject({ status: "in_progress" }) }),
        sse("response.output_text.delta", {
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: "first",
          logprobs: [],
        }),
        sse("response.output_text.done", {
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          text: "first",
          logprobs: [],
        }),
        sse("response.output_text.delta", {
          item_id: "msg_2",
          output_index: 1,
          content_index: 0,
          delta: "second",
          logprobs: [],
        }),
        sse("response.output_text.done", {
          item_id: "msg_2",
          output_index: 1,
          content_index: 0,
          text: "second",
          logprobs: [],
        }),
        sse("response.completed", {
          response: responseObject({
            status: "completed",
            output: [messageItem("first", "msg_1"), messageItem("second", "msg_2")],
            usage: usageObject(),
          }),
        }),
      ],
    });

    const consumed = await consume(guarded(await provider.start(testRequest("multiple-text-items"))));
    expect(consumed.streamError).toBeNull();
    expect(textOf(consumed.result!)).toBe("firstsecond");
    await provider.close();
  });

  it("fails closed when the terminal snapshot substitutes another model", async () => {
    const { provider, fake } = createTestProvider();
    fake.script("create", {
      stream: textStreamScript(["substituted"], { model: "different-model" }),
    });
    const consumed = await consume(guarded(await provider.start(testRequest("model-substitution"))));
    expect(isProviderError(consumed.error, "PROTOCOL_VIOLATION")).toBe(true);
    expect((consumed.error as ProviderError).details["detailCode"]).toBe("response-model-mismatch");
    await provider.close();
  });
});

describe("retry boundary", () => {
  it("does not retry the state-creating POST without a documented idempotency guarantee", async () => {
    const { provider, fake } = createTestProvider({
      configuration: { retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 } },
    });
    fake.script(
      "create",
      {
        status: 500,
        bodyText: JSON.stringify({ error: { type: "server_error", code: "server_error", param: null } }),
        contentType: "application/json",
      },
      { stream: textStreamScript(["must not be reached"]) },
    );

    await expect(provider.start(testRequest("create-not-retried"))).rejects.toMatchObject({
      code: "INTERNAL_FAILURE",
    });
    expect(fake.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    await provider.close();
  });
});
