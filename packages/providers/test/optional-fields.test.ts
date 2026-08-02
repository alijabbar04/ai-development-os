import { describe, expect, it } from "vitest";
import {
  ensureProviderError,
  createOperationController,
  guardProviderOperation,
  parseCodingAgentEvent,
  parseCodingAgentRequest,
  parseCodingAgentResult,
  parseInferenceEvent,
  parseInferenceRequest,
  parseInferenceResult,
  parseProviderHealth,
  parseProviderOperationId,
  parseExecutionTraceMetadata,
  ProviderError,
  systemClock,
  type InferenceEvent,
  type InferenceResult,
} from "../src/index.js";
import {
  CODING_REQUEST_FIXTURE,
  INFERENCE_REQUEST_FIXTURE,
  TRACE_FIXTURE,
} from "./fixtures.js";

const TOOL = {
  name: "read-file",
  description: "Reads a file.",
  inputSchema: { type: "object" },
  risk: "read-only",
  approval: "never",
  executionLocation: "caller",
} as const;

describe("optional fields exercised with concrete values", () => {
  it("parses a fully-populated inference request", () => {
    const request = parseInferenceRequest({
      ...INFERENCE_REQUEST_FIXTURE,
      tools: [TOOL],
      toolChoice: { mode: "named", toolName: "read-file" },
      structuredOutput: { schema: { type: "object" }, strict: false },
      sampling: { temperature: 0.5, topP: 0.9, seed: 7 },
      maxOutputTokens: 100,
      stopSequences: ["END"],
      deadline: "2026-08-02T13:00:00.000Z",
      extensions: [{ namespace: "fake", key: "knob", value: 1 }],
    });
    expect(request.toolChoice).toEqual({ mode: "named", toolName: "read-file" });
    expect(request.sampling?.topP).toBe(0.9);
    expect(request.structuredOutput?.strict).toBe(false);
    expect(request.deadline).toBe("2026-08-02T13:00:00.000Z");
    expect(request.extensions).toHaveLength(1);
  });

  it("parses a fully-populated inference result", () => {
    const result = parseInferenceResult({
      schemaVersion: 1,
      operationId: "op-1",
      requestId: "req-1",
      modelId: "m-1",
      messages: [{ role: "assistant", parts: [{ type: "text", text: "no" }] }],
      structuredOutput: { verdict: "refused" },
      finishReason: "refusal",
      refusalMessage: "I cannot help with that.",
      usage: { tokens: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0 }, toolCalls: 0 },
      cost: {
        providerReported: { currency: "USD", amountMicros: 10 },
        locallyComputed: { currency: "USD", amountMicros: 12 },
      },
      latency: { firstEventMs: 1, totalMs: 2 },
      warnings: ["capability clamped"],
    });
    expect(result.refusalMessage).toContain("cannot");
    expect(result.structuredOutput).toEqual({ verdict: "refused" });
  });

  it("parses a fully-populated coding-agent request and result", () => {
    const request = parseCodingAgentRequest({
      ...CODING_REQUEST_FIXTURE,
      modelId: "agent-model",
      capabilities: ["read-files", "edit-files", "run-commands", "run-tests"],
      commandPolicy: { mode: "allow-listed", allowedCommands: ["npm", "node"] },
      budget: {
        tokens: { maxTotalTokens: 10_000, maxInputTokens: null, maxOutputTokens: null, softMaxTotalTokens: null },
        money: null,
        time: null,
      },
      estimatedUsage: { inputTokens: 10, outputTokens: 20 },
      deadline: "2026-08-02T13:00:00.000Z",
      inputArtifacts: ["art-in-1"],
      resumeToken: "resume-abc",
      extensions: [{ namespace: "fake", key: "flag", value: true }],
    });
    expect(request.commandPolicy.allowedCommands).toEqual(["npm", "node"]);
    expect(request.budget?.tokens?.maxTotalTokens).toBe(10_000);
    expect(request.resumeToken).toBe("resume-abc");

    const result = parseCodingAgentResult({
      schemaVersion: 1,
      operationId: "op-1",
      requestId: "req-c-1",
      completion: "partial",
      patchArtifactId: "art-p",
      changedFiles: [{ path: "src/x.ts", changeKind: "added" }],
      testResults: { artifactId: "art-t", passed: 1, failed: 1, skipped: 0 },
      commandLogArtifactId: "art-log",
      diagnosticsArtifactId: "art-diag",
      producedArtifacts: ["art-p"],
      baseRevision: "abc",
      resultRevision: "def",
      approvalDecisions: [],
      usage: { tokens: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0 }, toolCalls: 1 },
      cost: { providerReported: null, locallyComputed: null },
      latency: { firstEventMs: null, totalMs: 9 },
      warnings: [],
      resumeToken: "resume-next",
    });
    expect(result.commandLogArtifactId).toBe("art-log");
    expect(result.diagnosticsArtifactId).toBe("art-diag");
    expect(result.testResults?.artifactId).toBe("art-t");
    expect(result.resumeToken).toBe("resume-next");
  });

  it("covers remaining nullable event and health fields", () => {
    const health = parseProviderHealth({
      status: "degraded",
      checkedAt: "2026-08-02T12:00:00.000Z",
      detailCode: "circuit-half-open",
      activeOperations: 1,
    });
    expect(health.detailCode).toBe("circuit-half-open");

    const chunk = parseCodingAgentEvent({
      schemaVersion: 1,
      operationId: "op-1",
      sequence: 1,
      occurredAt: "2026-08-02T12:00:00.000Z",
      trace: TRACE_FIXTURE,
      kind: "output-chunk",
      payload: { channel: "stderr", text: "warning text", artifactId: "art-out" },
    });
    expect((chunk as Extract<typeof chunk, { kind: "output-chunk" }>).payload.artifactId).toBe("art-out");
  });

  it("covers live stream waiting, cancel passthrough, and helpers", async () => {
    expect(systemClock.now()).toBeInstanceOf(Date);
    expect(ensureProviderError(new Error("x")).code).toBe("INTERNAL_FAILURE");

    const controller = createOperationController<InferenceEvent, InferenceResult>({
      operationId: parseProviderOperationId("op-1"),
      clock: { now: () => new Date("2026-08-02T12:00:00.000Z") },
      trace: parseExecutionTraceMetadata(TRACE_FIXTURE),
      buildCancelledEvent: (base, reason) =>
        ({ ...base, kind: "operation-cancelled", payload: { reason } }) as InferenceEvent,
    });
    expect(controller.cancellationReason).toBeNull();

    const guarded = guardProviderOperation(controller.operation, {
      parseEvent: parseInferenceEvent,
      parseResult: parseInferenceResult,
    });
    // Start consuming BEFORE any event exists so the waiter path runs.
    const consuming = (async () => {
      const kinds: string[] = [];
      for await (const event of guarded.events()) {
        kinds.push(event.kind);
      }
      return kinds;
    })();
    await Promise.resolve();
    controller.emit(
      (base) => ({ ...base, kind: "text-delta", payload: { text: "live" } }) as InferenceEvent,
    );
    await guarded.cancel("superseded");
    const kinds = await consuming;
    expect(kinds).toEqual(["text-delta", "operation-cancelled"]);
    expect(controller.cancellationReason).toBe("superseded");
    await expect(guarded.result).rejects.toMatchObject({ code: "CANCELLED" });
    expect(new ProviderError("CANCELLED", "x").retry.strategy).toBe("never");
  });
});
