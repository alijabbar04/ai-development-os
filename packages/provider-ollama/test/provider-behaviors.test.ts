import { describe, expect, it } from "vitest";
import { isProviderError, type InferenceEvent, type InferenceOperation, type ProviderError } from "@ai-dev-os/providers";
import { TESTKIT_SECRET_CANARY } from "@ai-dev-os/provider-testkit";
import type { OllamaObservation } from "../src/index.js";
import {
  DEFAULT_FAKE_MODEL_SPEC,
  contentRecord,
  chatLine,
  doneRecord,
  fakeDigest,
  startFakeOllamaServer,
  thinkingRecord,
  toolCallRecord,
  type FakeOllamaServer,
} from "./helpers/fake-ollama-server.js";
import { READ_TOOL, createTestProvider, testRequest } from "./helpers/fixtures.js";

async function consume(operation: InferenceOperation): Promise<{
  events: InferenceEvent[];
  streamError: unknown;
  outcome: { status: "resolved"; value: unknown } | { status: "rejected"; error: ProviderError };
}> {
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
    return { events, streamError, outcome: { status: "resolved", value: await operation.result } };
  } catch (error) {
    return { events, streamError, outcome: { status: "rejected", error: error as ProviderError } };
  }
}

async function withServer(
  options: Parameters<typeof startFakeOllamaServer>[0],
  run: (server: FakeOllamaServer) => Promise<void>,
): Promise<void> {
  const server = await startFakeOllamaServer(options);
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

describe("reasoning support", () => {
  it("emits reasoning deltas distinct from answer text when thinking is enabled", async () => {
    await withServer(
      { chat: { chunks: [thinkingRecord("step one. "), thinkingRecord("step two."), contentRecord("answer"), doneRecord()] } },
      async (server) => {
        const { provider } = createTestProvider({ serverUrl: server.url });
        const operation = await provider.start(
          testRequest("thinking", { extensions: [{ namespace: "ollama", key: "think", value: true }] }),
        );
        const consumed = await consume(operation);
        expect(consumed.outcome.status).toBe("resolved");
        const reasoning = consumed.events.filter((event) => event.kind === "reasoning-delta");
        expect(reasoning.map((event) => (event as { payload: { text: string } }).payload.text)).toEqual([
          "step one. ",
          "step two.",
        ]);
        const result = (consumed.outcome as { value: { messages: unknown } }).value;
        // Reasoning never merges into the final answer or the result.
        expect(JSON.stringify(result)).not.toContain("step one");
        expect(server.requests.find((request) => request.path === "/api/chat")?.think).toBe(true);
        await provider.close();
      },
    );
  });

  it("suppresses reasoning events entirely when disclosure is prohibited", async () => {
    await withServer(
      { chat: { chunks: [thinkingRecord("SECRET-REASONING"), contentRecord("answer"), doneRecord()] } },
      async (server) => {
        const { provider } = createTestProvider({ serverUrl: server.url });
        const operation = await provider.start(
          testRequest("no-disclosure", {
            extensions: [
              { namespace: "ollama", key: "think", value: "high" },
              { namespace: "ollama", key: "disclose-reasoning", value: false },
            ],
          }),
        );
        const consumed = await consume(operation);
        expect(consumed.outcome.status).toBe("resolved");
        expect(consumed.events.some((event) => event.kind === "reasoning-delta")).toBe(false);
        expect(JSON.stringify(consumed.events)).not.toContain("SECRET-REASONING");
        expect(JSON.stringify((consumed.outcome as { value: unknown }).value)).not.toContain("SECRET-REASONING");
        expect(server.requests.find((request) => request.path === "/api/chat")?.think).toBe("high");
        await provider.close();
      },
    );
  });

  it("rejects thinking requests against models without the capability", async () => {
    await withServer(
      { models: [{ ...DEFAULT_FAKE_MODEL_SPEC, capabilities: ["completion"] }] },
      async (server) => {
        const { provider } = createTestProvider({ serverUrl: server.url });
        await expect(
          provider.start(
            testRequest("think-unsupported", {
              extensions: [{ namespace: "ollama", key: "think", value: true }],
            }),
          ),
        ).rejects.toSatisfy((error: unknown) => isProviderError(error, "UNSUPPORTED_CAPABILITY"));
        await provider.close();
      },
    );
  });

  it("rejects unknown extension namespaces, keys, and invalid values", async () => {
    await withServer({}, async (server) => {
      const { provider } = createTestProvider({ serverUrl: server.url });
      await expect(
        provider.start(testRequest("ns", { extensions: [{ namespace: "openai", key: "effort", value: "high" }] })),
      ).rejects.toSatisfy((error: unknown) => isProviderError(error, "UNSUPPORTED_CAPABILITY"));
      await expect(
        provider.start(testRequest("key", { extensions: [{ namespace: "ollama", key: "mystery", value: 1 }] })),
      ).rejects.toSatisfy((error: unknown) => isProviderError(error, "UNSUPPORTED_CAPABILITY"));
      await expect(
        provider.start(testRequest("value", { extensions: [{ namespace: "ollama", key: "think", value: "extreme" }] })),
      ).rejects.toSatisfy((error: unknown) => isProviderError(error, "INVALID_REQUEST"));
      await provider.close();
    });
  });
});

describe("request mapping", () => {
  it("maps roles, tool history, sampling, format, and keep-alive onto the wire", async () => {
    let structure: {
      roles: unknown[];
      toolNames: unknown[];
      hasAssistantToolCalls: boolean;
      options: Record<string, unknown> | null;
      formatKind: string;
      keepAlive: unknown;
      stream: unknown;
    } | null = null;
    await withServer(
      {
        chat: (body) => {
          const messages = body["messages"] as Array<Record<string, unknown>>;
          structure = {
            roles: messages.map((message) => message["role"]),
            toolNames: messages.filter((message) => message["role"] === "tool").map((message) => message["tool_name"]),
            hasAssistantToolCalls: messages.some((message) => Array.isArray(message["tool_calls"])),
            options: (body["options"] as Record<string, unknown>) ?? null,
            formatKind: typeof body["format"],
            keepAlive: body["keep_alive"],
            stream: body["stream"],
          };
          return { chunks: [contentRecord('{"ok":true}'), doneRecord()] };
        },
      },
      async (server) => {
        const { provider } = createTestProvider({
          serverUrl: server.url,
          configuration: { keepAlive: { policy: "retain", durationMs: 120_000 } },
        });
        const request = testRequest("mapping", {
          messages: [
            { role: "system", parts: [{ type: "text", text: "be brief" }] },
            { role: "developer", parts: [{ type: "text", text: "format notes" }] },
            { role: "user", parts: [{ type: "text", text: "question" }, { type: "json", value: { key: "value" } }] },
            {
              role: "assistant",
              parts: [
                { type: "text", text: "calling tool" },
                {
                  type: "tool-invocation",
                  invocation: { toolCallId: "call-1", toolName: "read-file", arguments: { path: "a.ts" } },
                },
              ],
            },
            {
              role: "tool",
              parts: [
                {
                  type: "tool-result",
                  result: { toolCallId: "call-1", toolName: "read-file", status: "succeeded", output: { ok: true }, failure: null },
                },
              ],
            },
          ],
          tools: [READ_TOOL],
          sampling: { temperature: 0.2, topP: 0.9, seed: 7 },
          maxOutputTokens: 128,
          stopSequences: ["END"],
          structuredOutput: { schema: { type: "object" }, strict: true },
        });
        const operation = await provider.start(request);
        const consumed = await consume(operation);
        expect(consumed.outcome.status).toBe("resolved");
        expect(structure).toMatchObject({
          roles: ["system", "system", "user", "assistant", "tool"],
          toolNames: ["read-file"],
          hasAssistantToolCalls: true,
          formatKind: "object",
          keepAlive: "120s",
          stream: true,
        });
        expect(structure!.options).toMatchObject({
          temperature: 0.2,
          top_p: 0.9,
          seed: 7,
          num_predict: 128,
          stop: ["END"],
        });
        await provider.close();
      },
    );
  });

  it("omits tools for tool-choice none and rejects required/named tool choice", async () => {
    await withServer(
      { chat: { chunks: [contentRecord("ok"), doneRecord()] } },
      async (server) => {
        const { provider } = createTestProvider({ serverUrl: server.url });
        const operation = await provider.start(
          testRequest("choice-none", { tools: [READ_TOOL], toolChoice: { mode: "none" } }),
        );
        await consume(operation);
        expect(server.requests.find((request) => request.path === "/api/chat")?.hasTools).toBe(false);
        await expect(
          provider.start(testRequest("choice-required", { tools: [READ_TOOL], toolChoice: { mode: "required" } })),
        ).rejects.toSatisfy((error: unknown) => isProviderError(error, "UNSUPPORTED_CAPABILITY"));
        await provider.close();
      },
    );
  });

  it("rejects artifact and image-artifact parts without an artifact resolver", async () => {
    await withServer({}, async (server) => {
      const { provider } = createTestProvider({ serverUrl: server.url });
      await expect(
        provider.start(
          testRequest("artifact", {
            messages: [
              { role: "user", parts: [{ type: "artifact", artifactId: "art-1", mediaType: "text/plain" }] },
            ],
          }),
        ),
      ).rejects.toSatisfy((error: unknown) => isProviderError(error, "UNSUPPORTED_CAPABILITY"));
      await provider.close();
    });
  });

  it("rejects missing models and digest-pin mismatches at start", async () => {
    await withServer({}, async (server) => {
      const { provider } = createTestProvider({ serverUrl: server.url });
      await expect(provider.start(testRequest("missing", { modelId: "missing-model" }))).rejects.toSatisfy(
        (error: unknown) => isProviderError(error, "MODEL_UNAVAILABLE"),
      );
      await provider.close();
    });
    await withServer({}, async (server) => {
      const { provider } = createTestProvider({
        serverUrl: server.url,
        configuration: { digestPins: [{ model: "fake-model", digest: fakeDigest(9) }] },
      });
      await expect(provider.start(testRequest("pin"))).rejects.toSatisfy(
        (error: unknown) =>
          isProviderError(error, "MODEL_UNAVAILABLE") &&
          (error as ProviderError).causeCategory === "digest-mismatch" &&
          (error as ProviderError).retry.strategy === "human-action",
      );
      await provider.close();
    });
  });
});

describe("hostile and failing streams", () => {
  async function expectStreamFailure(
    chunks: readonly (string | { destroySocket: true })[],
    expectedCode: string,
    requestOverrides: Parameters<typeof testRequest>[1] = {},
  ): Promise<void> {
    await withServer({ chat: { chunks: chunks as never } }, async (server) => {
      const { provider } = createTestProvider({ serverUrl: server.url });
      const operation = await provider.start(testRequest("hostile", requestOverrides));
      const consumed = await consume(operation);
      expect(consumed.outcome.status).toBe("rejected");
      expect((consumed.outcome as { error: ProviderError }).error.code).toBe(expectedCode);
      const terminal = consumed.events[consumed.events.length - 1]!;
      expect(terminal.kind).toBe("operation-failed");
      // Every terminal path releases its capacity lease.
      expect(provider.capacitySnapshot()).toMatchObject({ activeOperations: 0, reservedBytes: 0 });
      await provider.close();
    });
  }

  it("fails on malformed JSON records", async () => {
    await expectStreamFailure([contentRecord("ok"), "NOT-JSON\n"], "MALFORMED_RESPONSE");
  });

  it("fails on truncated trailing records", async () => {
    await expectStreamFailure([contentRecord("ok"), '{"model":"fake-model","done":'], "MALFORMED_RESPONSE");
  });

  it("fails when the stream ends without a terminal record", async () => {
    await expectStreamFailure([contentRecord("ok")], "MALFORMED_RESPONSE");
  });

  it("fails on disconnect before the terminal record", async () => {
    await withServer(
      // The hold guarantees the response headers and first record are out
      // before the socket drops, so the disconnect is observed mid-stream.
      { chat: { chunks: [contentRecord("ok"), { holdUntilRelease: true }, { destroySocket: true }] } },
      async (server) => {
        const { provider } = createTestProvider({ serverUrl: server.url });
        const operation = await provider.start(testRequest("disconnect"));
        server.release();
        const consumed = await consume(operation);
        expect(consumed.outcome.status).toBe("rejected");
        expect((consumed.outcome as { error: ProviderError }).error.code).toBe("NETWORK_FAILURE");
        expect(consumed.events[consumed.events.length - 1]!.kind).toBe("operation-failed");
        expect(provider.capacitySnapshot()).toMatchObject({ activeOperations: 0, reservedBytes: 0 });
        await provider.close();
      },
    );
  });

  it("fails on duplicate terminal records", async () => {
    await expectStreamFailure([contentRecord("ok"), doneRecord(), doneRecord()], "MALFORMED_RESPONSE");
  });

  it("fails on records after the terminal record", async () => {
    await expectStreamFailure([doneRecord(), contentRecord("late")], "MALFORMED_RESPONSE");
  });

  it("fails on oversized NDJSON lines", async () => {
    await expectStreamFailure([contentRecord("x".repeat(300_000))], "MALFORMED_RESPONSE");
  });

  it("fails when the response reports a different model identity", async () => {
    await expectStreamFailure(
      [contentRecord("ok", "other-model"), doneRecord({}, "other-model")],
      "MALFORMED_RESPONSE",
    );
  });

  it("fails on undeclared tool invocations", async () => {
    await expectStreamFailure(
      [toolCallRecord([{ name: "undeclared-tool", arguments: {} }]), doneRecord()],
      "TOOL_PROTOCOL_FAILURE",
      { tools: [READ_TOOL] },
    );
  });

  it("fails structured requests whose final output is not valid JSON", async () => {
    await withServer(
      { chat: { chunks: [contentRecord("this is not json"), doneRecord()] } },
      async (server) => {
        const { provider } = createTestProvider({ serverUrl: server.url });
        const operation = await provider.start(
          testRequest("bad-structured", { structuredOutput: { schema: { type: "object" }, strict: true } }),
        );
        const consumed = await consume(operation);
        expect(consumed.outcome.status).toBe("rejected");
        expect((consumed.outcome as { error: ProviderError }).error.code).toBe("MALFORMED_RESPONSE");
        expect(consumed.events.some((event) => event.kind === "structured-output-completed")).toBe(false);
        await provider.close();
      },
    );
  });

  it("never leaks backend error bodies, prompts, or tool arguments", async () => {
    await withServer(
      {
        chat: {
          status: 500,
          contentType: "application/json",
          body: `{"error":"crash while processing ${TESTKIT_SECRET_CANARY}"}`,
        },
      },
      async (server) => {
        const { provider } = createTestProvider({ serverUrl: server.url });
        try {
          await provider.start(
            testRequest("leak", {
              messages: [{ role: "user", parts: [{ type: "text", text: `token ${TESTKIT_SECRET_CANARY}` }] }],
              tools: [READ_TOOL],
            }),
          );
          expect.unreachable();
        } catch (error) {
          expect(isProviderError(error)).toBe(true);
          expect(JSON.stringify((error as ProviderError).toJSON())).not.toContain(TESTKIT_SECRET_CANARY);
        }
        // The fake server records structural summaries only — no content.
        expect(JSON.stringify(server.requests)).not.toContain(TESTKIT_SECRET_CANARY);
        expect(provider.capacitySnapshot()).toMatchObject({ activeOperations: 0 });
        await provider.close();
      },
    );
  });

  it("adds warnings for missing usage counters and unknown completion reasons", async () => {
    await withServer(
      {
        chat: {
          chunks: [
            contentRecord("ok"),
            chatLine({ model: "fake-model", message: { role: "assistant", content: "" }, done: true, done_reason: "mystery" }),
          ],
        },
      },
      async (server) => {
        const { provider } = createTestProvider({ serverUrl: server.url });
        const operation = await provider.start(testRequest("warnings"));
        const consumed = await consume(operation);
        expect(consumed.outcome.status).toBe("resolved");
        const result = (consumed.outcome as { value: { warnings: readonly string[]; finishReason: string; usage: { tokens: { inputTokens: number } } } }).value;
        expect(result.warnings).toHaveLength(2);
        expect(result.finishReason).toBe("stop");
        expect(result.usage.tokens.inputTokens).toBe(0);
        await provider.close();
      },
    );
  });

  it("maps the length completion reason", async () => {
    await withServer(
      { chat: { chunks: [contentRecord("truncated answer"), doneRecord({ done_reason: "length" })] } },
      async (server) => {
        const { provider } = createTestProvider({ serverUrl: server.url });
        const consumed = await consume(await provider.start(testRequest("length")));
        expect((consumed.outcome as { value: { finishReason: string } }).value.finishReason).toBe("length");
        await provider.close();
      },
    );
  });
});

describe("capacity integration", () => {
  it("cancels while queued for capacity via the start signal", async () => {
    await withServer(
      { chat: { chunks: [contentRecord("busy"), { holdUntilRelease: true }] } },
      async (server) => {
        const { provider } = createTestProvider({
          serverUrl: server.url,
          configuration: { maxConcurrentOperations: 1 },
        });
        const first = await provider.start(testRequest("holder"));
        const listeners: Array<() => void> = [];
        const signal = {
          aborted: false,
          addEventListener: (_type: "abort", listener: () => void) => listeners.push(listener),
        };
        const pendingStart = provider.start(testRequest("queued"), { signal });
        await Promise.resolve();
        expect(provider.capacitySnapshot().queuedOperations).toBe(1);
        (signal as { aborted: boolean }).aborted = true;
        for (const listener of listeners) {
          listener();
        }
        await expect(pendingStart).rejects.toSatisfy((error: unknown) => isProviderError(error, "CANCELLED"));
        expect(provider.capacitySnapshot().queuedOperations).toBe(0);
        await first.cancel();
        server.release();
        await provider.close();
      },
    );
  });

  it("rejects with overload when the admission queue is full", async () => {
    await withServer(
      { chat: { chunks: [contentRecord("busy"), { holdUntilRelease: true }] } },
      async (server) => {
        const { provider } = createTestProvider({
          serverUrl: server.url,
          configuration: { maxConcurrentOperations: 1, queueLimit: 0 },
        });
        const first = await provider.start(testRequest("holder"));
        await expect(provider.start(testRequest("rejected"))).rejects.toSatisfy(
          (error: unknown) => isProviderError(error, "PROVIDER_OVERLOADED"),
        );
        await first.cancel();
        server.release();
        await provider.close();
      },
    );
  });

  it("releases capacity after cancellation mid-stream", async () => {
    await withServer(
      { chat: { chunks: [contentRecord("busy"), { holdUntilRelease: true }] } },
      async (server) => {
        const { provider } = createTestProvider({ serverUrl: server.url });
        const operation = await provider.start(testRequest("cancelled"));
        expect(provider.capacitySnapshot().activeOperations).toBe(1);
        await operation.cancel();
        await operation.cancel();
        const consumed = await consume(operation);
        expect(consumed.events[consumed.events.length - 1]!.kind).toBe("operation-cancelled");
        // Wait for the pump to settle its lease release.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(provider.capacitySnapshot()).toMatchObject({ activeOperations: 0, reservedBytes: 0 });
        await provider.close();
      },
    );
  });

  it("aborted start signals reject before any admission", async () => {
    await withServer({}, async (server) => {
      const { provider } = createTestProvider({ serverUrl: server.url });
      await expect(
        provider.start(testRequest("pre-aborted"), {
          signal: { aborted: true, addEventListener: () => undefined },
        }),
      ).rejects.toSatisfy((error: unknown) => isProviderError(error, "CANCELLED"));
      expect(provider.capacitySnapshot()).toMatchObject({ activeOperations: 0, queuedOperations: 0 });
      await provider.close();
    });
  });
});

describe("health, catalog surface, and residency", () => {
  it("reports healthy with server version after discovery", async () => {
    await withServer({ version: "0.12.5" }, async (server) => {
      const { provider } = createTestProvider({ serverUrl: server.url });
      await provider.refreshCatalog();
      const snapshot = await provider.inspectHealth();
      expect(snapshot).toMatchObject({
        category: "healthy",
        serverReachable: true,
        apiCompatible: true,
        serverVersion: "0.12.5",
        installedModelCount: 1,
        eligibleModelCount: 1,
        endpointFamily: "ipv4-loopback",
        capacityUtilization: "idle",
      });
      const health = await provider.health();
      expect(health.status).toBe("ready");
      await provider.close();
      const closedHealth = await provider.health();
      expect(closedHealth.status).toBe("closed");
    });
  });

  it("reports unavailable, incompatible, degraded, and overloaded categories", async () => {
    // Unavailable: server gone.
    const gone = await startFakeOllamaServer({});
    const goneUrl = gone.url;
    await gone.close();
    const unreachable = createTestProvider({ serverUrl: goneUrl });
    expect((await unreachable.provider.inspectHealth()).category).toBe("unavailable");
    expect((await unreachable.provider.health()).detailCode).toBe("server-unreachable");
    await unreachable.provider.close();

    // Incompatible: version endpoint missing.
    await withServer(
      { overrides: { version: { status: 404, body: '{"error":"no such route"}' } } },
      async (server) => {
        const { provider } = createTestProvider({ serverUrl: server.url });
        expect((await provider.inspectHealth()).category).toBe("incompatible");
        await provider.close();
      },
    );

    // Degraded: digest mismatch in the catalog.
    await withServer({}, async (server) => {
      const { provider } = createTestProvider({
        serverUrl: server.url,
        configuration: { digestPins: [{ model: "fake-model", digest: fakeDigest(9) }] },
      });
      await provider.refreshCatalog();
      const snapshot = await provider.inspectHealth();
      expect(snapshot.category).toBe("degraded");
      expect(snapshot.digestMismatchCount).toBe(1);
      await provider.close();
    });

    // Overloaded: capacity saturated by a held operation.
    await withServer(
      { chat: { chunks: [contentRecord("busy"), { holdUntilRelease: true }] } },
      async (server) => {
        const { provider } = createTestProvider({
          serverUrl: server.url,
          configuration: { maxConcurrentOperations: 1 },
        });
        const operation = await provider.start(testRequest("holder"));
        const snapshot = await provider.inspectHealth();
        expect(snapshot.category).toBe("overloaded");
        expect(snapshot.capacityUtilization).toBe("saturated");
        await operation.cancel();
        server.release();
        await provider.close();
      },
    );
  });

  it("lists eligible chat models as Stage 2 descriptors", async () => {
    await withServer(
      {
        models: [
          DEFAULT_FAKE_MODEL_SPEC,
          { name: "embed-only", digest: fakeDigest(3), capabilities: ["embedding"] },
        ],
      },
      async (server) => {
        const { provider } = createTestProvider({ serverUrl: server.url });
        const models = await provider.listModels();
        expect(models).toHaveLength(1);
        expect(models[0]!.model).toMatchObject({
          modelId: "fake-model",
          locality: "local",
          supportsToolUse: true,
          contextWindowTokens: 8_192,
          cost: null,
        });
        expect(models[0]!.availability).toBe("available");
        await provider.close();
      },
    );
  });

  it("preloads, plans, and applies residency with ownership guarding", async () => {
    const observations: OllamaObservation[] = [];
    await withServer(
      {
        running: [
          { name: "fake-model", size: 1_000_000 },
          { name: "external-model", size: 500 },
        ],
      },
      async (server) => {
        const { provider } = createTestProvider({
          serverUrl: server.url,
          configuration: { keepAlive: { policy: "unload-immediately" } },
          ollamaObserver: (observation) => observations.push(observation),
        });
        await provider.preloadModel("fake-model");
        expect(provider.ownedModels()).toEqual(["fake-model"]);
        const generateCalls = server.requests.filter((request) => request.path === "/api/generate");
        expect(generateCalls).toHaveLength(1);
        expect(generateCalls[0]!.keepAlive).toBe(0); // unload-immediately preload keep-alive

        const plan = await provider.planResidency();
        expect(plan.steps).toEqual([
          { action: "unload", model: "fake-model", reasonCode: "keep-alive-policy" },
        ]);
        expect(plan.skipped).toContainEqual({ model: "external-model", reasonCode: "not-owned" });

        await provider.applyResidencyPlan(plan);
        expect(provider.ownedModels()).toEqual([]);
        const unloadCall = server.requests.filter((request) => request.path === "/api/generate").at(-1)!;
        expect(unloadCall.keepAlive).toBe(0);
        expect(observations.filter((observation) => observation.kind === "residency")).toHaveLength(2);
        await provider.close();
      },
    );
  });

  it("emits structured discovery, admission, and operation observations", async () => {
    const observations: OllamaObservation[] = [];
    await withServer(
      { chat: { chunks: [contentRecord("ok"), doneRecord()] } },
      async (server) => {
        const { provider } = createTestProvider({
          serverUrl: server.url,
          ollamaObserver: (observation) => observations.push(observation),
        });
        const consumed = await consume(await provider.start(testRequest("observed")));
        expect(consumed.outcome.status).toBe("resolved");
        const kinds = observations.map((observation) => observation.kind);
        expect(kinds).toContain("discovery");
        expect(kinds).toContain("admission");
        expect(kinds).toContain("operation");
        const operation = observations.find((observation) => observation.kind === "operation")!;
        expect(operation).toMatchObject({
          outcome: "succeeded",
          inputTokens: 10,
          outputTokens: 5,
          totalDurationMs: 1_000,
        });
        expect(JSON.stringify(observations)).not.toContain("scenario observed");
        await provider.close();
      },
    );
  });
});
