import { describe, expect, it } from "vitest";
import { isProviderError, type InferenceEvent, type InferenceOperation, type ProviderError } from "@ai-dev-os/providers";
import {
  advanceCursor,
  assertHandleUsable,
  assertResumeContinuity,
  computeBackgroundBinding,
  computeBackoffMs,
  createBackgroundHandle,
  createSequenceGuard,
  fixedJitterSource,
  isActiveStatus,
} from "../src/index.js";
import {
  functionCallItem,
  messageItem,
  resetSequence,
  responseObject,
  sse,
  usageObject,
} from "./helpers/fake-openai.js";
import { READ_TOOL, createTestProvider, testRequest } from "./helpers/fixtures.js";

function detailCode(error: unknown): unknown {
  return (error as ProviderError).details["detailCode"];
}

/**
 * Flushes pending microtasks AND the event loop turn, so stream reads and
 * transport continuations run before virtual time advances again.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Drives a promise to settlement on virtual time only: no real sleeping,
 * and every backoff is satisfied by advancing the manual clock.
 */
async function settle<T>(
  work: Promise<T>,
  manual: { advance(ms: number): void },
  stepMs = 2_000,
  maxSteps = 200,
): Promise<T> {
  let done = false;
  const tracked = work.then(
    (value) => {
      done = true;
      return value;
    },
    (error) => {
      done = true;
      throw error;
    },
  );
  tracked.catch(() => undefined);
  for (let step = 0; step < maxSteps && !done; step += 1) {
    await flush();
    if (done) {
      break;
    }
    manual.advance(stepMs);
  }
  await flush();
  return tracked;
}

async function drain(operation: InferenceOperation): Promise<{
  events: InferenceEvent[];
  error: unknown;
  result: unknown;
}> {
  const events: InferenceEvent[] = [];
  const collecting = (async (): Promise<void> => {
    try {
      for await (const event of operation.events()) {
        events.push(event);
      }
    } catch {
      // Terminal disagreement is asserted through the result.
    }
  })();
  let result: unknown = null;
  let error: unknown = null;
  try {
    result = await operation.result;
  } catch (caught) {
    error = caught;
  }
  await collecting;
  return { events, error, result };
}

const BACKGROUND_CONFIG = {
  background: { mode: "allowed" as const, resumeStreamEnabled: false, pollBaseDelayMs: 100, pollMaxDelayMs: 1_000 },
};

const BACKGROUND_EXTENSION = [{ namespace: "openai", key: "background", value: true }];

describe("background handles and cursors", () => {
  const binding = computeBackgroundBinding({
    providerInstanceId: "openai-test-1",
    requestId: "req-1",
    modelId: "test-model",
    classification: "internal",
    policyDecisionFingerprint: "a".repeat(64),
  });

  it("binds a response id to its exact originating context", () => {
    const other = computeBackgroundBinding({
      providerInstanceId: "openai-test-1",
      requestId: "req-2",
      modelId: "test-model",
      classification: "internal",
      policyDecisionFingerprint: "a".repeat(64),
    });
    expect(binding).not.toBe(other);
    expect(binding).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses a handle whose binding does not match", () => {
    const handle = createBackgroundHandle({
      responseId: "resp_abc",
      binding,
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(() => assertHandleUsable(handle, binding, new Date("2026-01-01T00:00:00.000Z"))).not.toThrow();
    try {
      assertHandleUsable(handle, "b".repeat(64), new Date("2026-01-01T00:00:00.000Z"));
      expect.unreachable("expected a binding mismatch");
    } catch (error) {
      expect(detailCode(error)).toBe("resume-token-binding-mismatch");
    }
  });

  it("refuses an expired handle", () => {
    const handle = createBackgroundHandle({
      responseId: "resp_abc",
      binding,
      expiresAt: "2026-01-01T00:00:00.000Z",
    });
    try {
      assertHandleUsable(handle, binding, new Date("2026-06-01T00:00:00.000Z"));
      expect.unreachable("expected expiry");
    } catch (error) {
      expect(detailCode(error)).toBe("resume-token-expired");
    }
  });

  it("refuses a forged response id outright", () => {
    for (const forged of ["resp_../../admin", "hax", "resp_a?b=c"]) {
      expect(() =>
        createBackgroundHandle({ responseId: forged, binding, expiresAt: "2030-01-01T00:00:00.000Z" }),
      ).toThrow();
    }
  });

  it("advances the cursor monotonically", () => {
    const handle = createBackgroundHandle({
      responseId: "resp_abc",
      binding,
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(handle.cursor).toBeNull();
    const advanced = advanceCursor(handle, 5);
    expect(advanced.cursor).toBe(5);
    // A lower sequence never rewinds the cursor.
    expect(advanceCursor(advanced, 3).cursor).toBe(5);
    expect(() => advanceCursor(advanced, -1)).toThrow();
  });

  it("deduplicates replayed sequences and rejects invalid ones", () => {
    const guard = createSequenceGuard(null);
    expect(guard.accept(1)).toBe(true);
    expect(guard.accept(2)).toBe(true);
    expect(guard.accept(2)).toBe(false);
    expect(guard.accept(1)).toBe(false);
    expect(guard.duplicatesDropped).toBe(2);
    expect(guard.highest).toBe(2);
    expect(() => guard.accept(1.5)).toThrow();

    const resumed = createSequenceGuard(10);
    expect(resumed.accept(10)).toBe(false);
    expect(resumed.accept(11)).toBe(true);
  });

  it("detects a gap after a resume but tolerates overlap", () => {
    expect(() => assertResumeContinuity(10, 11)).not.toThrow();
    expect(() => assertResumeContinuity(10, 8)).not.toThrow();
    expect(() => assertResumeContinuity(null, 99)).not.toThrow();
    try {
      assertResumeContinuity(10, 15);
      expect.unreachable("expected a gap");
    } catch (error) {
      expect(detailCode(error)).toBe("resume-cursor-gap");
    }
  });

  it("classifies active statuses", () => {
    expect(isActiveStatus("queued")).toBe(true);
    expect(isActiveStatus("in_progress")).toBe(true);
    expect(isActiveStatus("completed")).toBe(false);
    expect(isActiveStatus("cancelled")).toBe(false);
  });
});

describe("bounded backoff", () => {
  it("grows exponentially and stays within the cap", () => {
    const plan = { baseDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0 };
    const jitter = fixedJitterSource([0.5]);
    expect(computeBackoffMs(plan, 0, jitter)).toBe(100);
    expect(computeBackoffMs(plan, 1, jitter)).toBe(200);
    expect(computeBackoffMs(plan, 2, jitter)).toBe(400);
    expect(computeBackoffMs(plan, 10, jitter)).toBe(1_000);
    expect(computeBackoffMs(plan, 10_000, jitter)).toBe(1_000);
  });

  it("applies symmetric jitter that can never go negative or exceed the cap", () => {
    const plan = { baseDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 1 };
    expect(computeBackoffMs(plan, 0, fixedJitterSource([0]))).toBe(50);
    // fixedJitterSource clamps to just below 1 so jitter stays in [0, 1).
    expect(computeBackoffMs(plan, 0, fixedJitterSource([1]))).toBe(149);
    // A hostile jitter source cannot break the bounds.
    expect(computeBackoffMs(plan, 0, () => -100)).toBe(0);
    expect(computeBackoffMs(plan, 0, () => 1e9)).toBe(1_000);
  });
});

describe("background polling", () => {
  it("polls through queued and in_progress to a completed response", async () => {
    const handle = createTestProvider({ configuration: BACKGROUND_CONFIG });
    handle.fake.script("create", {
      json: responseObject({ id: "resp_bg1", status: "queued", background: true }),
    });
    handle.fake.script(
      "get",
      { json: responseObject({ id: "resp_bg1", status: "queued", background: true }) },
      { json: responseObject({ id: "resp_bg1", status: "in_progress", background: true }) },
      {
        json: responseObject({
          id: "resp_bg1",
          status: "completed",
          background: true,
          output: [messageItem("background answer")],
          usage: usageObject(),
        }),
      },
    );

    const operation = await handle.provider.start(
      testRequest("bg", { extensions: BACKGROUND_EXTENSION }),
    );
    // Virtual time drives every backoff; no real sleeping occurs.
    const outcome = await settle(drain(operation), handle.manual);

    expect(outcome.error).toBeNull();
    const textEvents = outcome.events.filter((event) => event.kind === "text-delta");
    expect(textEvents).toHaveLength(1);
    expect(handle.fake.requests.filter((request) => request.method === "GET")).toHaveLength(3);
    expect(handle.fake.requests[0]!.body).toMatchObject({ background: true, stream: false });
    await handle.provider.close();
  });

  it("retries a transient polling failure only on the idempotent GET route", async () => {
    const handle = createTestProvider({
      configuration: {
        ...BACKGROUND_CONFIG,
        retry: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 2_000, jitterRatio: 0 },
      },
    });
    handle.fake.script("create", {
      json: responseObject({ id: "resp_retry", status: "queued", background: true }),
    });
    handle.fake.script(
      "get",
      {
        status: 429,
        headers: { "retry-after": "1" },
        json: { error: { type: "rate_limit_error", code: "rate_limit_exceeded", param: null } },
      },
      {
        json: responseObject({
          id: "resp_retry",
          status: "completed",
          background: true,
          output: [messageItem("after retry")],
          usage: usageObject(),
        }),
      },
    );

    const operation = await handle.provider.start(
      testRequest("bg-safe-retry", { extensions: BACKGROUND_EXTENSION }),
    );
    const outcome = await settle(drain(operation), handle.manual);

    expect(outcome.error).toBeNull();
    expect(handle.fake.requests.filter((request) => request.method === "GET")).toHaveLength(2);
    const attempts = handle.observations
      .filter(
        (observation): observation is { kind: "http"; route: string; attempt: number } =>
          typeof observation === "object" &&
          observation !== null &&
          (observation as { kind?: unknown }).kind === "http" &&
          (observation as { route?: unknown }).route === "getResponse",
      )
      .map((observation) => observation.attempt);
    expect(attempts).toEqual([1, 2]);
    await handle.provider.close();
  });

  it("fails closed if polling switches to a different response id", async () => {
    const handle = createTestProvider({ configuration: BACKGROUND_CONFIG });
    handle.fake.script("create", {
      json: responseObject({ id: "resp_original", status: "queued", background: true }),
    });
    handle.fake.script("get", {
      json: responseObject({
        id: "resp_substituted",
        status: "completed",
        background: true,
        output: [messageItem("wrong response")],
        usage: usageObject(),
      }),
    });

    const operation = await handle.provider.start(
      testRequest("bg-id-switch", { extensions: BACKGROUND_EXTENSION }),
    );
    const outcome = await settle(drain(operation), handle.manual);
    expect(isProviderError(outcome.error, "PROTOCOL_VIOLATION")).toBe(true);
    expect(detailCode(outcome.error)).toBe("response-id-changed");
    await handle.provider.close();
  });

  it("fails when a background response reports failure", async () => {
    const handle = createTestProvider({ configuration: BACKGROUND_CONFIG });
    handle.fake.script("create", {
      json: responseObject({ id: "resp_bg2", status: "queued", background: true }),
    });
    handle.fake.script("get", {
      json: responseObject({
        id: "resp_bg2",
        status: "failed",
        background: true,
        error: { code: "server_error", message: "boom" },
      }),
    });

    const operation = await handle.provider.start(
      testRequest("bg-fail", { extensions: BACKGROUND_EXTENSION }),
    );
    const outcome = await settle(drain(operation), handle.manual);
    expect(isProviderError(outcome.error, "INTERNAL_FAILURE")).toBe(true);
    await handle.provider.close();
  });

  it("reports a remotely cancelled background response as cancelled", async () => {
    const handle = createTestProvider({ configuration: BACKGROUND_CONFIG });
    handle.fake.script("create", {
      json: responseObject({ id: "resp_bg3", status: "queued", background: true }),
    });
    handle.fake.script("get", {
      json: responseObject({ id: "resp_bg3", status: "cancelled", background: true }),
    });

    const operation = await handle.provider.start(
      testRequest("bg-cancel", { extensions: BACKGROUND_EXTENSION }),
    );
    const outcome = await settle(drain(operation), handle.manual);
    expect(isProviderError(outcome.error, "CANCELLED")).toBe(true);
    await handle.provider.close();
  });

  it("stops polling at the attempt ceiling and says the remote may still run", async () => {
    const handle = createTestProvider({
      configuration: {
        background: { ...BACKGROUND_CONFIG.background, maxPollAttempts: 2 },
      },
    });
    handle.fake.script("create", {
      json: responseObject({ id: "resp_bg4", status: "queued", background: true }),
    });
    for (let index = 0; index < 5; index += 1) {
      handle.fake.script("get", {
        json: responseObject({ id: "resp_bg4", status: "in_progress", background: true }),
      });
    }

    const operation = await handle.provider.start(
      testRequest("bg-exhaust", { extensions: BACKGROUND_EXTENSION }),
    );
    const outcome = await settle(drain(operation), handle.manual);
    expect(isProviderError(outcome.error, "TIMEOUT")).toBe(true);
    expect((outcome.error as ProviderError).retry.operationMayStillBeRunning).toBe(true);
    expect(detailCode(outcome.error)).toBe("background-poll-attempts-exhausted");
    await handle.provider.close();
  });

  it("honors the caller deadline while polling", async () => {
    const handle = createTestProvider({ configuration: BACKGROUND_CONFIG });
    handle.fake.script("create", {
      json: responseObject({ id: "resp_bg5", status: "queued", background: true }),
    });
    for (let index = 0; index < 20; index += 1) {
      handle.fake.script("get", {
        json: responseObject({ id: "resp_bg5", status: "in_progress", background: true }),
      });
    }

    const deadline = new Date(handle.manual.now().valueOf() + 5_000).toISOString();
    const operation = await handle.provider.start(
      testRequest("bg-deadline", { extensions: BACKGROUND_EXTENSION, deadline }),
    );
    const outcome = await settle(drain(operation), handle.manual);
    expect(isProviderError(outcome.error, "DEADLINE_EXCEEDED")).toBe(true);
    await handle.provider.close();
  });

  it("replays a background function call as a provider-neutral tool call", async () => {
    const handle = createTestProvider({ configuration: BACKGROUND_CONFIG });
    handle.fake.script("create", {
      json: responseObject({ id: "resp_bg6", status: "queued", background: true }),
    });
    handle.fake.script("get", {
      json: responseObject({
        id: "resp_bg6",
        status: "completed",
        background: true,
        output: [functionCallItem("read-file", '{"path":"x.ts"}')],
        usage: usageObject(),
      }),
    });

    const operation = await handle.provider.start(
      testRequest("bg-tool", { tools: [READ_TOOL], extensions: BACKGROUND_EXTENSION }),
    );
    const outcome = await settle(drain(operation), handle.manual);
    expect(outcome.error).toBeNull();
    expect(outcome.events.filter((event) => event.kind === "tool-call-started")).toHaveLength(1);
    expect(outcome.events.filter((event) => event.kind === "tool-call-completed")).toHaveLength(1);
    await handle.provider.close();
  });
});

describe("background streaming and resume", () => {
  const RESUME_CONFIG = {
    background: {
      mode: "allowed" as const,
      resumeStreamEnabled: true,
      maxResumeAttempts: 3,
      pollBaseDelayMs: 100,
      pollMaxDelayMs: 1_000,
    },
  };

  it("resumes from the last observed sequence and drops replayed events", async () => {
    resetSequence();
    const handle = createTestProvider({ configuration: RESUME_CONFIG });

    // First attempt: created + two deltas, then the connection drops.
    handle.fake.script("create", {
      stream: [
        sse("response.created", { response: responseObject({ id: "resp_r1", status: "in_progress", background: true }) }, 1),
        sse(
          "response.output_text.delta",
          { item_id: "msg_1", output_index: 0, content_index: 0, delta: "part-one ", logprobs: [] },
          2,
        ),
        sse(
          "response.output_text.delta",
          { item_id: "msg_1", output_index: 0, content_index: 0, delta: "part-two ", logprobs: [] },
          3,
        ),
        { truncate: true },
      ],
    });
    // Resume: the server replays sequence 3 before continuing.
    handle.fake.script("get", {
      stream: [
        sse(
          "response.output_text.delta",
          { item_id: "msg_1", output_index: 0, content_index: 0, delta: "part-two ", logprobs: [] },
          3,
        ),
        sse(
          "response.output_text.delta",
          { item_id: "msg_1", output_index: 0, content_index: 0, delta: "part-three", logprobs: [] },
          4,
        ),
        sse(
          "response.completed",
          {
            response: responseObject({
              id: "resp_r1",
              status: "completed",
              background: true,
              output: [messageItem("part-one part-two part-three")],
              usage: usageObject(),
            }),
          },
          5,
        ),
      ],
    });

    const operation = await handle.provider.start(
      testRequest("resume", { extensions: BACKGROUND_EXTENSION }),
    );
    const outcome = await settle(drain(operation), handle.manual);

    expect(outcome.error).toBeNull();
    const text = outcome.events
      .filter((event) => event.kind === "text-delta")
      .map((event) => (event as Extract<InferenceEvent, { kind: "text-delta" }>).payload.text)
      .join("");
    // The replayed delta appears exactly once.
    expect(text).toBe("part-one part-two part-three");

    const resumeRequest = handle.fake.requests.find((request) => request.method === "GET");
    expect(resumeRequest!.url).toBe(
      "https://api.openai.com/v1/responses/resp_r1?stream=true&starting_after=3",
    );
    await handle.provider.close();
  });

  it("fails closed when the resumed stream skips past the cursor", async () => {
    resetSequence();
    const handle = createTestProvider({ configuration: RESUME_CONFIG });
    handle.fake.script("create", {
      stream: [
        sse("response.created", { response: responseObject({ id: "resp_r2", status: "in_progress", background: true }) }, 1),
        sse(
          "response.output_text.delta",
          { item_id: "msg_1", output_index: 0, content_index: 0, delta: "a", logprobs: [] },
          2,
        ),
        { truncate: true },
      ],
    });
    handle.fake.script("get", {
      stream: [
        // Jumps from 2 to 9: seven events were lost.
        sse(
          "response.output_text.delta",
          { item_id: "msg_1", output_index: 0, content_index: 0, delta: "z", logprobs: [] },
          9,
        ),
      ],
    });

    const operation = await handle.provider.start(
      testRequest("resume-gap", { extensions: BACKGROUND_EXTENSION }),
    );
    const outcome = await settle(drain(operation), handle.manual);
    expect(isProviderError(outcome.error, "PROTOCOL_VIOLATION")).toBe(true);
    expect(detailCode(outcome.error)).toBe("resume-cursor-gap");
    await handle.provider.close();
  });

  it("gives up after the resume ceiling and reports the remote may still run", async () => {
    resetSequence();
    const handle = createTestProvider({
      configuration: {
        background: { ...RESUME_CONFIG.background, maxResumeAttempts: 1 },
      },
    });
    const truncated = {
      stream: [
        sse("response.created", { response: responseObject({ id: "resp_r3", status: "in_progress", background: true }) }, 1),
        { truncate: true } as const,
      ],
    };
    handle.fake.script("create", truncated);
    handle.fake.script("get", { stream: [{ truncate: true }] }, { stream: [{ truncate: true }] });

    const operation = await handle.provider.start(
      testRequest("resume-exhaust", { extensions: BACKGROUND_EXTENSION }),
    );
    const outcome = await settle(drain(operation), handle.manual);
    expect(isProviderError(outcome.error, "NETWORK_FAILURE")).toBe(true);
    expect((outcome.error as ProviderError).retry.operationMayStillBeRunning).toBe(true);
    expect(detailCode(outcome.error)).toBe("stream-resume-exhausted");
    await handle.provider.close();
  });

  it("does not attempt to resume a synchronous stream", async () => {
    resetSequence();
    const handle = createTestProvider();
    handle.fake.script("create", {
      stream: [
        sse("response.created", { response: responseObject({ status: "in_progress" }) }, 1),
        { truncate: true },
      ],
    });
    const operation = await handle.provider.start(testRequest("sync-truncate"));
    const outcome = await drain(operation);
    expect(detailCode(outcome.error)).toBe("stream-truncated");
    // No GET was issued: there is no server-side state to reconnect to.
    expect(handle.fake.requests.filter((request) => request.method === "GET")).toHaveLength(0);
    await handle.provider.close();
  });
});

describe("cancellation", () => {
  it("cancels a synchronous stream and aborts the connection", async () => {
    resetSequence();
    const handle = createTestProvider();
    handle.fake.script("create", {
      stream: [
        sse("response.created", { response: responseObject({ status: "in_progress" }) }, 1),
        sse(
          "response.output_text.delta",
          { item_id: "msg_1", output_index: 0, content_index: 0, delta: "before-", logprobs: [] },
          2,
        ),
        { holdUntilRelease: true },
      ],
    });
    const operation = await handle.provider.start(testRequest("cancel"));
    await operation.cancel();
    await operation.cancel();
    const outcome = await drain(operation);
    expect(isProviderError(outcome.error, "CANCELLED")).toBe(true);
    const terminal = outcome.events[outcome.events.length - 1]!;
    expect(terminal.kind).toBe("operation-cancelled");
    handle.fake.release();
    await handle.provider.close();
  });

  it("calls the official cancel endpoint for a background response", async () => {
    const handle = createTestProvider({ configuration: BACKGROUND_CONFIG });
    handle.fake.script("create", {
      json: responseObject({ id: "resp_c1", status: "queued", background: true }),
    });
    for (let index = 0; index < 10; index += 1) {
      handle.fake.script("get", {
        json: responseObject({ id: "resp_c1", status: "in_progress", background: true }),
      });
    }
    handle.fake.script(
      "cancel",
      { json: responseObject({ id: "resp_c1", status: "cancelled", background: true }) },
      { json: responseObject({ id: "resp_c1", status: "cancelled", background: true }) },
    );

    const operation = await handle.provider.start(
      testRequest("bg-cancel-remote", { extensions: BACKGROUND_EXTENSION }),
    );
    handle.manual.advance(500);
    await Promise.resolve();
    await operation.cancel();
    // Cancelling twice is idempotent and must not double-call remotely.
    await operation.cancel();
    const outcome = await settle(drain(operation), handle.manual);

    expect(isProviderError(outcome.error, "CANCELLED")).toBe(true);
    const cancelCalls = handle.fake.requests.filter((request) => request.url.endsWith("/cancel"));
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0]!.url).toBe("https://api.openai.com/v1/responses/resp_c1/cancel");
    await handle.provider.close();
  });

  it("publishes a streaming response handle early enough for remote cancellation", async () => {
    resetSequence();
    const handle = createTestProvider({
      configuration: {
        background: {
          mode: "allowed",
          resumeStreamEnabled: true,
          pollBaseDelayMs: 100,
          pollMaxDelayMs: 1_000,
        },
      },
    });
    handle.fake.script("create", {
      stream: [
        sse(
          "response.created",
          { response: responseObject({ id: "resp_stream_cancel", status: "in_progress", background: true }) },
          1,
        ),
        { holdUntilRelease: true },
      ],
    });
    handle.fake.script("cancel", {
      json: responseObject({ id: "resp_stream_cancel", status: "cancelled", background: true }),
    });

    const operation = await handle.provider.start(
      testRequest("bg-stream-cancel", { extensions: BACKGROUND_EXTENSION }),
    );
    const draining = drain(operation);
    await flush();
    await flush();
    await operation.cancel();
    handle.fake.release();
    const outcome = await settle(draining, handle.manual);
    expect(isProviderError(outcome.error, "CANCELLED")).toBe(true);
    await handle.provider.close();
    expect(handle.fake.requests.filter((request) => request.url.endsWith("/cancel"))).toHaveLength(1);
  });

  it("does not make provider close wait for an uncancelled polling backoff", async () => {
    const handle = createTestProvider({
      configuration: {
        background: {
          mode: "allowed",
          resumeStreamEnabled: false,
          pollBaseDelayMs: 15_000,
          pollMaxDelayMs: 15_000,
        },
      },
    });
    handle.fake.script("create", {
      json: responseObject({ id: "resp_close_backoff", status: "queued", background: true }),
    });
    handle.fake.script("cancel", {
      json: responseObject({ id: "resp_close_backoff", status: "cancelled", background: true }),
    });

    const operation = await handle.provider.start(
      testRequest("bg-close-backoff", { extensions: BACKGROUND_EXTENSION }),
    );
    await flush();
    await handle.provider.close();
    const outcome = await drain(operation);
    expect(isProviderError(outcome.error, "CANCELLED")).toBe(true);
  });

  it("settles active operations when the provider closes", async () => {
    resetSequence();
    const handle = createTestProvider();
    handle.fake.script("create", {
      stream: [
        sse("response.created", { response: responseObject({ status: "in_progress" }) }, 1),
        { holdUntilRelease: true },
      ],
    });
    const operation = await handle.provider.start(testRequest("close"));
    const closing = handle.provider.close();
    handle.fake.release();
    await closing;
    const outcome = await drain(operation);
    const terminal = outcome.events[outcome.events.length - 1]!;
    expect(terminal.kind).toBe("operation-cancelled");
    expect(
      (terminal as Extract<InferenceEvent, { kind: "operation-cancelled" }>).payload.reason,
    ).toBe("provider-closed");
    await expect(handle.provider.start(testRequest("after-close"))).rejects.toMatchObject({
      code: "PROVIDER_CLOSED",
    });
  });
});
