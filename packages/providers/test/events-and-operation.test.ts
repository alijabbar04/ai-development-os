import { describe, expect, it } from "vitest";
import { ValidationError } from "@ai-dev-os/domain";
import {
  FIRST_EVENT_SEQUENCE,
  MAX_BUFFERED_EVENTS,
  MAX_BUFFERED_EVENT_CANONICAL_BYTES,
  ProviderError,
  createEventSequenceValidator,
  createOperationController,
  guardProviderOperation,
  isProviderError,
  isTerminalEventKind,
  parseCodingAgentEvent,
  parseInferenceEvent,
  parseInferenceResult,
  parseProviderOperationId,
  parseExecutionTraceMetadata,
  type InferenceEvent,
  type InferenceResult,
  type ProviderOperation,
} from "../src/index.js";
import { TRACE_FIXTURE } from "./fixtures.js";

const OP_ID = parseProviderOperationId("op-1");
const TRACE = parseExecutionTraceMetadata(TRACE_FIXTURE);

function envelope(sequence: number, occurredAt = "2026-08-02T12:00:00.000Z") {
  return {
    schemaVersion: 1,
    operationId: "op-1",
    sequence,
    occurredAt,
    trace: TRACE_FIXTURE,
  };
}

const USAGE = {
  tokens: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0, reasoningTokens: 0 },
  toolCalls: 0,
};

describe("event parsing", () => {
  it("parses every inference event kind", () => {
    const samples: Array<Record<string, unknown>> = [
      { kind: "operation-started", payload: { modelId: "m-1" } },
      { kind: "message-started", payload: { messageIndex: 0 } },
      { kind: "text-delta", payload: { text: "hi" } },
      { kind: "reasoning-delta", payload: { text: "let me think" } },
      { kind: "structured-output-delta", payload: { textDelta: '{"a":' } },
      { kind: "structured-output-completed", payload: { value: { a: 1 } } },
      { kind: "tool-call-started", payload: { toolCallId: "c-1", toolName: "read-file" } },
      { kind: "tool-call-delta", payload: { toolCallId: "c-1", argumentsDelta: '{"p"' } },
      {
        kind: "tool-call-completed",
        payload: { invocation: { toolCallId: "c-1", toolName: "read-file", arguments: {} } },
      },
      { kind: "usage-update", payload: { usage: USAGE } },
      { kind: "warning", payload: { message: "clamped temperature" } },
      { kind: "message-completed", payload: { messageIndex: 0 } },
      { kind: "operation-completed", payload: {} },
      {
        kind: "operation-failed",
        payload: { code: "TIMEOUT", message: "took too long", retryStrategy: "same-after-delay" },
      },
      { kind: "operation-cancelled", payload: { reason: "caller-requested" } },
    ];
    samples.forEach((sample, index) => {
      const event = parseInferenceEvent({ ...envelope(index + 1), ...sample });
      expect(event.sequence).toBe(index + 1);
      expect(Object.isFrozen(event)).toBe(true);
    });
  });

  it("parses every coding-agent event kind", () => {
    const samples: Array<Record<string, unknown>> = [
      { kind: "operation-started", payload: { workspaceId: "ws-1" } },
      { kind: "status-update", payload: { message: "planning" } },
      { kind: "workspace-read", payload: { path: "src/index.ts" } },
      {
        kind: "tool-call-proposed",
        payload: { invocation: { toolCallId: "c-1", toolName: "run-tests", arguments: {} } },
      },
      { kind: "tool-call-started", payload: { toolCallId: "c-1", toolName: "run-tests" } },
      { kind: "output-chunk", payload: { channel: "stdout", text: "ok", artifactId: null } },
      {
        kind: "file-change-proposed",
        payload: { change: { path: "src/a.ts", changeKind: "modified" } },
      },
      {
        kind: "file-change-applied",
        payload: { change: { path: "src/a.ts", changeKind: "modified" } },
      },
      { kind: "patch-produced", payload: { artifactId: "art-1" } },
      { kind: "test-started", payload: { suite: "unit" } },
      { kind: "test-completed", payload: { suite: "unit", passed: 5, failed: 0, skipped: 1 } },
      {
        kind: "approval-requested",
        payload: { approvalId: "appr-1", summary: "run migration", risk: "destructive" },
      },
      { kind: "usage-update", payload: { usage: USAGE } },
      { kind: "warning", payload: { message: "network denied" } },
      { kind: "operation-completed", payload: {} },
      {
        kind: "operation-failed",
        payload: { code: "WORKSPACE_UNAVAILABLE", message: "gone", retryStrategy: "never" },
      },
      { kind: "operation-cancelled", payload: { reason: "provider-closed" } },
    ];
    samples.forEach((sample, index) => {
      const event = parseCodingAgentEvent({ ...envelope(index + 1), ...sample });
      expect(event.operationId).toBe("op-1");
    });
  });

  it("rejects malformed events", () => {
    expect(() => parseInferenceEvent(null)).toThrow(ValidationError);
    expect(() =>
      parseInferenceEvent({ ...envelope(1), kind: "mystery", payload: {} }),
    ).toThrow(ValidationError);
    expect(() =>
      parseInferenceEvent({ ...envelope(1), kind: "text-delta", payload: { text: 42 } }),
    ).toThrow(ValidationError);
    expect(() =>
      parseInferenceEvent({ ...envelope(1), kind: "reasoning-delta", payload: { text: 42 } }),
    ).toThrow(ValidationError);
    expect(() =>
      parseInferenceEvent({ ...envelope(1), kind: "reasoning-delta", payload: { text: "x", extra: 1 } }),
    ).toThrow(ValidationError);
    expect(() =>
      parseInferenceEvent({ ...envelope(0), kind: "operation-completed", payload: {} }),
    ).toThrow(ValidationError);
    expect(() =>
      parseInferenceEvent({
        ...envelope(1),
        kind: "operation-failed",
        payload: { code: "lowercase", message: "x", retryStrategy: "never" },
      }),
    ).toThrow(ValidationError);
    expect(() =>
      parseCodingAgentEvent({ ...envelope(1), kind: "output-chunk", payload: { channel: "stdin", text: "", artifactId: null } }),
    ).toThrow(ValidationError);
    expect(isTerminalEventKind("operation-cancelled")).toBe(true);
    expect(isTerminalEventKind("text-delta")).toBe(false);
  });
});

describe("event sequence validator", () => {
  const started = parseInferenceEvent({
    ...envelope(1),
    kind: "operation-started",
    payload: { modelId: "m-1" },
  });

  it("accepts a well-ordered stream and requires a terminal", () => {
    const validator = createEventSequenceValidator(OP_ID);
    validator.check(started);
    validator.check(
      parseInferenceEvent({ ...envelope(2), kind: "usage-update", payload: { usage: USAGE } }),
    );
    validator.check(
      parseInferenceEvent({ ...envelope(3), kind: "operation-completed", payload: {} }),
    );
    validator.finish();
    expect(validator.terminalKind()).toBe("operation-completed");
  });

  it("rejects gaps, duplicates, foreign operations, and post-terminal events", () => {
    const gap = createEventSequenceValidator(OP_ID);
    gap.check(started);
    expect(() =>
      gap.check(parseInferenceEvent({ ...envelope(3), kind: "operation-completed", payload: {} })),
    ).toThrow(ProviderError);

    const foreign = createEventSequenceValidator(parseProviderOperationId("op-other"));
    expect(() => foreign.check(started)).toThrow(ProviderError);

    const post = createEventSequenceValidator(OP_ID);
    post.check(started);
    post.check(parseInferenceEvent({ ...envelope(2), kind: "operation-completed", payload: {} }));
    expect(() =>
      post.check(parseInferenceEvent({ ...envelope(3), kind: "text-delta", payload: { text: "late" } })),
    ).toThrow(ProviderError);

    const unfinished = createEventSequenceValidator(OP_ID);
    unfinished.check(started);
    expect(() => unfinished.finish()).toThrow(ProviderError);
  });

  it("rejects decreasing timestamps and shrinking usage snapshots", () => {
    const clockOrder = createEventSequenceValidator(OP_ID);
    clockOrder.check(started);
    expect(() =>
      clockOrder.check(
        parseInferenceEvent({
          ...envelope(2, "2026-08-02T11:00:00.000Z"),
          kind: "operation-completed",
          payload: {},
        }),
      ),
    ).toThrow(ProviderError);

    const usageOrder = createEventSequenceValidator(OP_ID);
    usageOrder.check(started);
    usageOrder.check(
      parseInferenceEvent({ ...envelope(2), kind: "usage-update", payload: { usage: USAGE } }),
    );
    expect(() =>
      usageOrder.check(
        parseInferenceEvent({
          ...envelope(3),
          kind: "usage-update",
          payload: {
            usage: { tokens: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 }, toolCalls: 0 },
          },
        }),
      ),
    ).toThrow(ProviderError);
  });
});

describe("operation controller", () => {
  const clock = { now: () => new Date("2026-08-02T12:00:00.000Z") };

  function buildController() {
    return createOperationController<InferenceEvent, InferenceResult>({
      operationId: OP_ID,
      clock,
      trace: TRACE,
      buildCancelledEvent: (base, reason) =>
        ({ ...base, kind: "operation-cancelled", payload: { reason } }) as InferenceEvent,
    });
  }

  const RESULT = parseInferenceResult({
    schemaVersion: 1,
    operationId: "op-1",
    requestId: "req-1",
    modelId: "m-1",
    messages: [{ role: "assistant", parts: [{ type: "text", text: "hello" }] }],
    structuredOutput: null,
    finishReason: "stop",
    refusalMessage: null,
    usage: USAGE,
    cost: { providerReported: null, locallyComputed: null },
    latency: { firstEventMs: 0, totalMs: 0 },
    warnings: [],
  });

  it("assigns sequences and settles result with the terminal event", async () => {
    const controller = buildController();
    controller.emit((base) => ({ ...base, kind: "text-delta", payload: { text: "hel" } }) as InferenceEvent);
    controller.emit((base) => ({ ...base, kind: "text-delta", payload: { text: "lo" } }) as InferenceEvent);
    controller.complete(
      (base) => ({ ...base, kind: "operation-completed", payload: {} }) as InferenceEvent,
      RESULT,
    );
    const events: InferenceEvent[] = [];
    for await (const event of controller.operation.events()) {
      events.push(event);
    }
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events[2]!.kind).toBe("operation-completed");
    await expect(controller.operation.result).resolves.toBe(RESULT);
    expect(controller.isTerminal).toBe(true);
  });

  it("supports awaiting the result without draining the stream", async () => {
    const controller = buildController();
    controller.complete(
      (base) => ({ ...base, kind: "operation-completed", payload: {} }) as InferenceEvent,
      RESULT,
    );
    await expect(controller.operation.result).resolves.toBe(RESULT);
  });

  it("fails deterministically with a terminal event when the unread event-count bound is exceeded", async () => {
    const controller = buildController();
    for (let index = 0; index < MAX_BUFFERED_EVENTS - 1; index += 1) {
      controller.emit((base) =>
        ({ ...base, kind: "text-delta", payload: { text: "x" } }) as InferenceEvent,
      );
    }

    expect(() =>
      controller.emit((base) =>
        ({ ...base, kind: "text-delta", payload: { text: "overflow" } }) as InferenceEvent,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "PROTOCOL_VIOLATION",
        details: expect.objectContaining({ maximumEventCount: MAX_BUFFERED_EVENTS }),
      }),
    );
    await expect(controller.operation.result).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });

    let count = 0;
    let previousSequence = 0;
    let terminalKind = "";
    for await (const event of controller.operation.events()) {
      count += 1;
      expect(event.sequence).toBe(previousSequence + 1);
      previousSequence = event.sequence;
      terminalKind = event.kind;
    }
    expect(count).toBe(MAX_BUFFERED_EVENTS);
    expect(terminalKind).toBe("operation-failed");
  });

  it("bounds retained canonical UTF-8 bytes and keeps overflow errors secret-safe", async () => {
    const controller = buildController();
    const canary = "stage5-buffer-secret-canary";
    const largeText = `${canary}:${"😀".repeat(32_000)}`;
    let thrown: unknown;
    try {
      for (;;) {
        controller.emit((base) =>
          ({ ...base, kind: "text-delta", payload: { text: largeText } }) as InferenceEvent,
        );
      }
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "PROTOCOL_VIOLATION",
      details: expect.objectContaining({ maximumCanonicalBytes: MAX_BUFFERED_EVENT_CANONICAL_BYTES }),
    });
    expect(JSON.stringify(thrown)).not.toContain(canary);
    await expect(controller.operation.result).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });

    let terminal: InferenceEvent | undefined;
    for await (const event of controller.operation.events()) {
      terminal = event;
    }
    expect(terminal?.kind).toBe("operation-failed");
    expect(JSON.stringify(terminal)).not.toContain(canary);
  });

  it("rejects double terminals, post-terminal emits, and double consumption", async () => {
    const controller = buildController();
    controller.fail(
      (base) =>
        ({
          ...base,
          kind: "operation-failed",
          payload: { code: "TIMEOUT", message: "slow", retryStrategy: "same-after-delay" },
        }) as InferenceEvent,
      new ProviderError("TIMEOUT", "slow"),
    );
    await expect(controller.operation.result).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(() =>
      controller.emit((base) => ({ ...base, kind: "text-delta", payload: { text: "late" } }) as InferenceEvent),
    ).toThrow(ProviderError);
    expect(() =>
      controller.complete(
        (base) => ({ ...base, kind: "operation-completed", payload: {} }) as InferenceEvent,
        RESULT,
      ),
    ).toThrow(ProviderError);
    controller.operation.events();
    expect(() => controller.operation.events()).toThrow(ProviderError);
  });

  it("refuses terminal kinds through emit()", () => {
    const controller = buildController();
    expect(() =>
      controller.emit((base) => ({ ...base, kind: "operation-completed", payload: {} }) as InferenceEvent),
    ).toThrow(ProviderError);
  });

  it("cancel is idempotent, first terminal wins, and onCancel handlers fire", async () => {
    const controller = buildController();
    const reasons: string[] = [];
    controller.onCancel((reason) => reasons.push(reason));
    await controller.operation.cancel();
    await controller.operation.cancel("provider-closed");
    expect(reasons).toEqual(["caller-requested"]);
    controller.onCancel((reason) => reasons.push(`late-${reason}`));
    expect(reasons).toEqual(["caller-requested", "late-caller-requested"]);
    await expect(controller.operation.result).rejects.toMatchObject({ code: "CANCELLED" });

    // Cancel after completion is a no-op.
    const done = buildController();
    done.complete(
      (base) => ({ ...base, kind: "operation-completed", payload: {} }) as InferenceEvent,
      RESULT,
    );
    await done.operation.cancel();
    await expect(done.operation.result).resolves.toBe(RESULT);
  });
});

describe("guardProviderOperation", () => {
  const clock = { now: () => new Date("2026-08-02T12:00:00.000Z") };

  function rawOperation(
    events: readonly unknown[],
    result: Promise<InferenceResult>,
  ): ProviderOperation<InferenceEvent, InferenceResult> {
    result.catch(() => undefined);
    return {
      operationId: OP_ID,
      events: () =>
        (async function* stream() {
          for (const event of events) {
            yield event as InferenceEvent;
          }
        })(),
      result,
      cancel: async () => undefined,
    };
  }

  const GOOD_RESULT = parseInferenceResult({
    schemaVersion: 1,
    operationId: "op-1",
    requestId: "req-1",
    modelId: "m-1",
    messages: [{ role: "assistant", parts: [{ type: "text", text: "ok" }] }],
    structuredOutput: null,
    finishReason: "stop",
    refusalMessage: null,
    usage: USAGE,
    cost: { providerReported: null, locallyComputed: null },
    latency: { firstEventMs: 0, totalMs: 0 },
    warnings: [],
  });

  it("rejects sequence gaps in transport-successful streams", async () => {
    const guarded = guardProviderOperation(
      rawOperation(
        [
          { ...envelope(1), kind: "operation-started", payload: { modelId: "m-1" } },
          { ...envelope(3), kind: "operation-completed", payload: {} },
        ],
        Promise.resolve(GOOD_RESULT),
      ),
      { parseEvent: parseInferenceEvent, parseResult: parseInferenceResult },
    );
    await expect(async () => {
      for await (const event of guarded.events()) {
        void event;
      }
    }).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
  });

  it("rejects streams that end without a terminal event", async () => {
    const guarded = guardProviderOperation(
      rawOperation(
        [{ ...envelope(1), kind: "operation-started", payload: { modelId: "m-1" } }],
        Promise.resolve(GOOD_RESULT),
      ),
      { parseEvent: parseInferenceEvent, parseResult: parseInferenceResult },
    );
    await expect(async () => {
      for await (const event of guarded.events()) {
        void event;
      }
    }).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
  });

  it("rejects completed terminals whose result rejected (and vice versa)", async () => {
    const mismatch = guardProviderOperation(
      rawOperation(
        [
          { ...envelope(1), kind: "operation-started", payload: { modelId: "m-1" } },
          { ...envelope(2), kind: "operation-completed", payload: {} },
        ],
        Promise.reject(new ProviderError("INTERNAL_FAILURE", "lied")),
      ),
      { parseEvent: parseInferenceEvent, parseResult: parseInferenceResult },
    );
    await expect(async () => {
      for await (const event of mismatch.events()) {
        void event;
      }
    }).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });

    const inverse = guardProviderOperation(
      rawOperation(
        [
          { ...envelope(1), kind: "operation-started", payload: { modelId: "m-1" } },
          {
            ...envelope(2),
            kind: "operation-failed",
            payload: { code: "TIMEOUT", message: "x", retryStrategy: "never" },
          },
        ],
        Promise.resolve(GOOD_RESULT),
      ),
      { parseEvent: parseInferenceEvent, parseResult: parseInferenceResult },
    );
    await expect(async () => {
      for await (const event of inverse.events()) {
        void event;
      }
    }).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
  });

  it("re-validates the result value even when the stream is not drained", async () => {
    const guarded = guardProviderOperation(
      rawOperation([], Promise.resolve({ hostile: true } as never)),
      { parseEvent: parseInferenceEvent, parseResult: parseInferenceResult },
    );
    await expect(guarded.result).rejects.toThrow();
  });

  it("passes through a fully valid controller-built operation", async () => {
    const controller = createOperationController<InferenceEvent, InferenceResult>({
      operationId: OP_ID,
      clock,
      trace: TRACE,
      buildCancelledEvent: (base, reason) =>
        ({ ...base, kind: "operation-cancelled", payload: { reason } }) as InferenceEvent,
    });
    controller.emit((base) => ({ ...base, kind: "text-delta", payload: { text: "ok" } }) as InferenceEvent);
    controller.complete(
      (base) => ({ ...base, kind: "operation-completed", payload: {} }) as InferenceEvent,
      GOOD_RESULT,
    );
    const guarded = guardProviderOperation(controller.operation, {
      parseEvent: parseInferenceEvent,
      parseResult: parseInferenceResult,
    });
    const kinds: string[] = [];
    for await (const event of guarded.events()) {
      kinds.push(event.kind);
    }
    expect(kinds).toEqual(["text-delta", "operation-completed"]);
    await expect(guarded.result).resolves.toEqual(GOOD_RESULT);
    expect(FIRST_EVENT_SEQUENCE).toBe(1);
    expect(isProviderError(new ProviderError("CANCELLED", "x"), "CANCELLED")).toBe(true);
  });
});
