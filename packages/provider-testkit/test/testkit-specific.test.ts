import { describe, expect, it } from "vitest";
import {
  createInferenceRequest,
  guardProviderOperation,
  parseInferenceEvent,
  parseInferenceResult,
  type InferenceEvent,
  type ProviderOperationRecord,
} from "@ai-dev-os/providers";
import {
  createFakeCodingAgentProvider,
  createFakeInferenceProvider,
  createImmediateScheduler,
  createManualScheduler,
  createSequentialIds,
  DEFAULT_FAKE_MODEL,
  INTERNAL_DISCLOSURE,
  SECRET_DISCLOSURE,
  TESTKIT_TRACE,
  type InferenceScript,
} from "../src/index.js";

const SCRIPT: InferenceScript = {
  steps: [
    { kind: "usage", inputTokens: 10, outputTokens: 0 },
    { kind: "text", text: "deterministic output", chunkSize: 5 },
    { kind: "usage", inputTokens: 10, outputTokens: 20 },
  ],
};

function request(id: string) {
  return createInferenceRequest({
    requestId: id,
    modelId: "fake-model",
    messages: [{ role: "user", parts: [{ type: "text", text: "go" }] }],
    disclosure: INTERNAL_DISCLOSURE,
    trace: TESTKIT_TRACE,
  });
}

async function runOnce(): Promise<readonly InferenceEvent[]> {
  const provider = createFakeInferenceProvider({
    script: SCRIPT,
    scheduler: createManualScheduler(),
  });
  const operation = guardProviderOperation(await provider.start(request("req-replay")), {
    parseEvent: parseInferenceEvent,
    parseResult: parseInferenceResult,
  });
  const events: InferenceEvent[] = [];
  for await (const event of operation.events()) {
    events.push(event);
  }
  await operation.result;
  await provider.close();
  return events;
}

describe("deterministic replay", () => {
  it("replays identical scripts into byte-identical event streams", async () => {
    const first = await runOnce();
    const second = await runOnce();
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.map((event) => event.sequence)).toEqual(
      first.map((_, index) => index + 1),
    );
  });

  it("scripts are immutable data reusable across providers without shared state", async () => {
    const scheduler = createManualScheduler();
    const providerA = createFakeInferenceProvider({ script: SCRIPT, scheduler });
    const providerB = createFakeInferenceProvider({ script: SCRIPT, scheduler });
    const [resultA, resultB] = await Promise.all([
      (await providerA.start(request("req-a"))).result,
      (await providerB.start(request("req-b"))).result,
    ]);
    expect(resultA.usage).toEqual(resultB.usage);
    expect(resultA.requestId).toBe("req-a");
    expect(resultB.requestId).toBe("req-b");
    await providerA.close();
    await providerB.close();
  });
});

describe("request capture and policy assertion", () => {
  it("captures validated requests with secret-safe summaries", async () => {
    const provider = createFakeInferenceProvider({ script: SCRIPT });
    const secretText = "the launch code is 0000";
    await (
      await provider.start(
        createInferenceRequest({
          requestId: "req-cap",
          modelId: "fake-model",
          messages: [{ role: "user", parts: [{ type: "text", text: secretText }] }],
          disclosure: INTERNAL_DISCLOSURE,
          trace: TESTKIT_TRACE,
        }),
      )
    ).result;
    expect(provider.capturedRequests).toHaveLength(1);
    const summaries = provider.capturedSummaries();
    expect(summaries[0]).toEqual({
      requestId: "req-cap",
      modelId: "fake-model",
      classification: "internal",
      messageCount: 1,
    });
    expect(JSON.stringify(summaries)).not.toContain("launch code");
    await provider.close();
  });

  it("proves disallowed classifications never reach a provider", async () => {
    const provider = createFakeInferenceProvider({ script: SCRIPT });
    await expect(
      provider.start(
        createInferenceRequest({
          requestId: "req-secret",
          modelId: "fake-model",
          messages: [{ role: "user", parts: [{ type: "text", text: "classified" }] }],
          disclosure: SECRET_DISCLOSURE,
          trace: TESTKIT_TRACE,
        }),
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(provider.capturedRequests).toHaveLength(0);
    await provider.close();
  });

  it("rejects unknown extension namespaces and unavailable models", async () => {
    const provider = createFakeInferenceProvider({ script: SCRIPT });
    await expect(
      provider.start(
        createInferenceRequest({
          requestId: "req-ext",
          modelId: "fake-model",
          messages: [{ role: "user", parts: [{ type: "text", text: "x" }] }],
          disclosure: INTERNAL_DISCLOSURE,
          trace: TESTKIT_TRACE,
          extensions: [{ namespace: "mystery", key: "knob", value: 1 }],
        }),
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    await expect(
      provider.start(request("req-model").modelId === "fake-model"
        ? { ...request("req-model"), modelId: "other-model" } as never
        : (undefined as never)),
    ).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
    await provider.close();
  });
});

describe("provider surfaces", () => {
  it("exposes descriptor, health, models, and observer records", async () => {
    const records: ProviderOperationRecord[] = [];
    const provider = createFakeInferenceProvider({
      script: SCRIPT,
      observer: (record) => {
        records.push(record);
      },
    });
    expect(provider.describe().kind).toBe("inference");
    expect((await provider.health()).status).toBe("ready");
    const models = await provider.listModels();
    expect(models[0]!.model.modelId).toBe(DEFAULT_FAKE_MODEL.modelId);

    const operation = await provider.start(request("req-obs"));
    await operation.result;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      providerKind: "inference",
      outcome: "succeeded",
      errorCode: null,
    });
    await provider.close();
    expect((await provider.health()).status).toBe("closed");
  });

  it("computes exact local cost from Stage 2 pricing metadata", async () => {
    const provider = createFakeInferenceProvider({ script: SCRIPT });
    const result = await (await provider.start(request("req-cost"))).result;
    // 10 input tokens at 1 USD/M (ceil) + 20 output tokens at 2 USD/M (ceil).
    expect(result.cost.locallyComputed).toEqual({ currency: "USD", amountMicros: 10 + 40 });
    expect(result.cost.providerReported).toBeNull();
    await provider.close();
  });

  it("honors abort signals as caller-aborted cancellation", async () => {
    const scheduler = createManualScheduler();
    const provider = createFakeInferenceProvider({
      script: { steps: [{ kind: "text", text: "x" }, { kind: "delay", ms: 60_000 }] },
      scheduler,
    });
    const abort = new AbortController();
    const operation = await provider.start(request("req-abort"), { signal: abort.signal });
    abort.abort();
    await expect(operation.result).rejects.toMatchObject({
      code: "CANCELLED",
      details: { reason: "caller-aborted" },
    });
    await provider.close();
  });

  it("coding-agent fake captures requests and reports health", async () => {
    const provider = createFakeCodingAgentProvider({
      script: { steps: [{ kind: "status", message: "ok" }] },
    });
    expect(provider.describe().kind).toBe("coding-agent");
    expect((await provider.health()).status).toBe("ready");
    expect(provider.capturedRequests).toHaveLength(0);
    await provider.close();
    await provider.close();
  });
});

describe("schedulers", () => {
  it("manual scheduler fires timers in order on advance", async () => {
    const scheduler = createManualScheduler();
    const fired: string[] = [];
    void scheduler.wait(100).then(() => fired.push("a"));
    void scheduler.wait(50).then(() => fired.push("b"));
    void scheduler.wait(100).then(() => fired.push("c"));
    expect(scheduler.pendingTimers).toBe(3);
    scheduler.advance(100);
    await Promise.resolve();
    await Promise.resolve();
    expect(fired).toEqual(["b", "a", "c"]);
    expect(scheduler.pendingTimers).toBe(0);
    await expect(scheduler.wait(0)).resolves.toBeUndefined();
    scheduler.set("2026-08-02T13:00:00.000Z");
    expect(scheduler.now().toISOString()).toBe("2026-08-02T13:00:00.000Z");
  });

  it("immediate scheduler resolves waits without real time", async () => {
    const scheduler = createImmediateScheduler();
    const before = scheduler.now().valueOf();
    await scheduler.wait(5_000);
    expect(scheduler.now().valueOf()).toBe(before + 5_000);
    expect(scheduler.pendingTimers).toBe(0);
  });

  it("sequential ids are deterministic", () => {
    const ids = createSequentialIds("x");
    expect(ids()).toBe("x-000001");
    expect(ids()).toBe("x-000002");
  });
});
