import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentAdapterRequest, AgentAdapterSignal, OrchestrationTaskEnvelope, SelectedRoute } from "@ai-dev-os/scheduler";
import {
  CODEX_SDK_COMPATIBILITY_VERSION,
  CODEX_SDK_RUNTIME_DEPENDENCY_ENABLED,
  CodexSdkCompatibilityError,
  createCodexSdkCompatibilityAdapter,
  type CodexSdkClientPort,
  type CodexSdkThreadEvent,
  type CodexSdkThreadOptions,
  type CodexSdkThreadPort,
} from "../src/index.js";

const NOW = "2026-08-09T18:00:00.000Z";
const DEADLINE = "2026-08-10T18:00:00.000Z";

function task(): OrchestrationTaskEnvelope {
  return {
    schemaVersion: 1,
    taskId: "task:sdk",
    parentTaskId: null,
    correlationId: "correlation:sdk",
    idempotencyKey: "idempotency:sdk:0001",
    objective: "Run the deterministic SDK declaration seam.",
    workspace: {
      projectId: "project:sdk",
      workspaceId: "workspace:sdk",
      snapshotId: "snapshot:sdk",
      baseRevision: "0123456789abcdef0123456789abcdef01234567",
    },
    requestedRoute: { providerId: null, modelId: null, profileId: null, ownership: null },
    capabilities: ["repository-read", "repository-write", "structured-output", "resumability"],
    permissionMode: "contained-default",
    budget: { maximumInputTokens: 10_000, maximumOutputTokens: 2_000, maximumCostMicros: 1_000_000, maximumToolCalls: 20, maximumTurns: 4 },
    retry: { maximumAttempts: 2, initialBackoffMs: 100, maximumBackoffMs: 1_000, retryableFailures: ["provider", "disconnected"] },
    timeout: { dispatchMs: 1_000, attemptMs: 60_000 },
    expectedResultSchema: { type: "object", additionalProperties: false },
    priority: "normal",
    createdAt: NOW,
    deadline: DEADLINE,
  };
}

const route: SelectedRoute = Object.freeze({
  candidateId: "candidate:sdk",
  providerId: "codex",
  modelId: "gpt-5.6-codex",
  profileId: "profile:owned",
  ownership: "owned",
});

function request(): AgentAdapterRequest {
  return { dispatchId: "dispatch:sdk", task: task(), route, deadline: DEADLINE };
}

async function collect(events: AsyncIterable<AgentAdapterSignal>): Promise<AgentAdapterSignal[]> {
  const values: AgentAdapterSignal[] = [];
  for await (const event of events) values.push(event);
  return values;
}

class FakeThread implements CodexSdkThreadPort {
  readonly calls: Array<{ readonly input: string; readonly outputSchema: unknown; readonly signal: AbortSignal | undefined }> = [];
  private readonly turns: ReadonlyArray<readonly CodexSdkThreadEvent[]>;
  private turn = 0;
  readonly id: string | null;

  constructor(id: string | null, turns: ReadonlyArray<readonly CodexSdkThreadEvent[]>) {
    this.id = id;
    this.turns = turns;
  }

  async runStreamed(input: string, options?: { readonly outputSchema?: unknown; readonly signal?: AbortSignal }) {
    this.calls.push({ input, outputSchema: options?.outputSchema, signal: options?.signal });
    const events = this.turns[this.turn++] ?? [];
    return Object.freeze({
      events: Object.freeze({
        async *[Symbol.asyncIterator](): AsyncGenerator<CodexSdkThreadEvent> {
          for (const event of events) yield event;
        },
      }),
    });
  }
}

class FakeClient implements CodexSdkClientPort {
  readonly kind = "deterministic-fake" as const;
  readonly packageVersion = CODEX_SDK_COMPATIBILITY_VERSION;
  readonly startOptions: CodexSdkThreadOptions[] = [];
  readonly resumeCalls: Array<{ readonly id: string; readonly options: CodexSdkThreadOptions | undefined }> = [];
  readonly start: FakeThread;
  readonly resumed: FakeThread;

  constructor(startEvents: ReadonlyArray<readonly CodexSdkThreadEvent[]>, resumeEvents: ReadonlyArray<readonly CodexSdkThreadEvent[]> = []) {
    this.start = new FakeThread("thread:sdk", startEvents);
    this.resumed = new FakeThread("thread:sdk", resumeEvents);
  }

  startThread(options?: CodexSdkThreadOptions): CodexSdkThreadPort {
    this.startOptions.push(options ?? {});
    return this.start;
  }

  resumeThread(id: string, options?: CodexSdkThreadOptions): CodexSdkThreadPort {
    this.resumeCalls.push({ id, options });
    return this.resumed;
  }
}

function workspace(overrides: Record<string, unknown> = {}) {
  const managedRoot = resolve("test-managed-root");
  return {
    resolve: async () => ({
      identity: task().workspace,
      managedRoot,
      workingDirectory: resolve(managedRoot, "worktree"),
      isManagedPrivateWorkspace: true as const,
      ...overrides,
    }),
  };
}

const completedUsage = Object.freeze({
  input_tokens: 10,
  cached_input_tokens: 2,
  cache_write_input_tokens: 1,
  output_tokens: 5,
  reasoning_output_tokens: 3,
});

describe("Codex SDK declaration compatibility seam", () => {
  it("is dependency-free and production-disabled by default", async () => {
    expect(CODEX_SDK_RUNTIME_DEPENDENCY_ENABLED).toBe(false);
    const adapter = createCodexSdkCompatibilityAdapter();
    const session = await adapter.start(request());
    const signals = await collect(session.events);
    expect(signals).toEqual([{
      type: "policy-blocked",
      code: "stage-18a-production-disabled",
      reason: "The Stage 18A Codex SDK compatibility seam is production-disabled.",
      humanResumable: false,
    }]);
    expect(await adapter.status({ dispatchId: request().dispatchId, threadId: null })).toBe("not-found");
    expect((await collect((await adapter.continue({ dispatchId: request().dispatchId, threadId: "thread:sdk", providerRunId: "run:sdk", instruction: "continue", deadline: DEADLINE })).events))[0]?.type).toBe("policy-blocked");
    expect((await collect((await adapter.resume({ dispatchId: request().dispatchId, threadId: "thread:sdk", deadline: DEADLINE })).events))[0]?.type).toBe("policy-blocked");
    await adapter.close();
  });

  it("maps an exact fake SDK thread into safe lifecycle metadata and cumulative usage", async () => {
    const client = new FakeClient([[
      { type: "thread.started", thread_id: "thread:sdk" },
      { type: "turn.started" },
      { type: "item.started", item: { id: "item:command", type: "command_execution" } },
      { type: "item.updated", item: { id: "item:command", type: "command_execution" } },
      { type: "item.completed", item: { id: "item:command", type: "command_execution" } },
      { type: "item.completed", item: { id: "item:message", type: "agent_message" } },
      { type: "turn.completed", usage: completedUsage },
    ], [
      { type: "turn.started" },
      { type: "turn.completed", usage: completedUsage },
    ]]);
    const adapter = createCodexSdkCompatibilityAdapter({ executionMode: "deterministic-fake", client, workspace: workspace(), now: () => new Date(NOW) });
    const session = await adapter.start(request());
    const signals = await collect(session.events);
    expect(signals.map((signal) => signal.type)).toEqual(["progress", "checkpoint", "checkpoint", "usage", "completed"]);
    expect(signals.find((signal) => signal.type === "checkpoint" && signal.kind === "command-execution")).toBeDefined();
    expect(JSON.stringify(signals)).not.toContain("command line");
    expect(await adapter.status({ dispatchId: request().dispatchId, threadId: session.threadId })).toBe("completed");
    expect(await adapter.usage({ dispatchId: request().dispatchId, threadId: session.threadId })).toEqual({
      inputTokens: 10,
      cachedInputTokens: 2,
      cacheWriteInputTokens: 1,
      outputTokens: 5,
      reasoningTokens: 3,
      toolCalls: 1,
      costMicros: null,
    });
    expect((await adapter.result({ dispatchId: request().dispatchId, threadId: session.threadId }))?.provider?.threadId).toBe("thread:sdk");

    const options = client.startOptions[0];
    expect(options).toMatchObject({
      model: route.modelId,
      sandboxMode: "workspace-write",
      skipGitRepoCheck: false,
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      webSearchEnabled: false,
      approvalPolicy: "on-request",
      additionalDirectories: [],
    });
    expect(options?.sandboxMode).not.toBe("danger-full-access");

    const continued = await adapter.continue({ dispatchId: request().dispatchId, threadId: session.threadId, providerRunId: session.providerRunId, instruction: "continue", deadline: DEADLINE });
    const continuation = await collect(continued.events);
    expect(continuation.at(-1)?.type).toBe("completed");
    expect((await adapter.usage({ dispatchId: request().dispatchId, threadId: session.threadId }))?.inputTokens).toBe(20);
    await expect(adapter.continue({ dispatchId: request().dispatchId, threadId: session.threadId, providerRunId: "run:wrong", instruction: "continue", deadline: DEADLINE })).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    await adapter.close();
  });

  it("resumes only a retained exact thread with its remembered workspace", async () => {
    const client = new FakeClient([[
      { type: "thread.started", thread_id: "thread:sdk" },
      { type: "turn.started" },
    ]], [[
      { type: "turn.started" },
      { type: "turn.completed", usage: completedUsage },
    ]]);
    const adapter = createCodexSdkCompatibilityAdapter({ executionMode: "deterministic-fake", client, workspace: workspace(), now: () => new Date(NOW) });
    const started = await adapter.start(request());
    expect((await collect(started.events)).at(-1)?.type).toBe("failed");
    const resumed = await adapter.resume({ dispatchId: request().dispatchId, threadId: started.threadId, deadline: DEADLINE });
    expect((await collect(resumed.events)).at(-1)?.type).toBe("completed");
    expect(client.resumeCalls[0]?.id).toBe(started.threadId);
    expect(client.resumeCalls[0]?.options?.workingDirectory).toBe(client.startOptions[0]?.workingDirectory);
    await expect(adapter.resume({ dispatchId: "dispatch:other", threadId: started.threadId, deadline: DEADLINE })).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    await adapter.close();
  });

  it("maps SDK failures without retaining error content", async () => {
    const client = new FakeClient([[
      { type: "thread.started", thread_id: "thread:sdk" },
      { type: "turn.failed", error: { message: "sensitive provider detail" } },
    ]]);
    const adapter = createCodexSdkCompatibilityAdapter({ executionMode: "deterministic-fake", client, workspace: workspace(), now: () => new Date(NOW) });
    const session = await adapter.start(request());
    const signals = await collect(session.events);
    expect(signals.at(-1)).toMatchObject({ type: "failed", result: { failure: { code: "codex-sdk-turn-failed" } } });
    expect(JSON.stringify(signals)).not.toContain("sensitive provider detail");
    await adapter.close();

    const streamError = new FakeClient([[
      { type: "thread.started", thread_id: "thread:sdk" },
      { type: "error", message: "another sensitive detail" },
    ]]);
    const second = createCodexSdkCompatibilityAdapter({ executionMode: "deterministic-fake", client: streamError, workspace: workspace(), now: () => new Date(NOW) });
    const failed = await second.start(request());
    expect((await collect(failed.events)).at(-1)).toMatchObject({ type: "failed", result: { failure: { code: "codex-sdk-stream-error" } } });
    await second.close();
  });

  it.each([
    ["mismatched identity", workspace({ identity: { ...task().workspace, workspaceId: "workspace:other" } })],
    ["working directory equal to root", (() => { const root = resolve("test-managed-root"); return workspace({ managedRoot: root, workingDirectory: root }); })()],
    ["outside working directory", workspace({ workingDirectory: resolve("outside-managed-root") })],
    ["relative working directory", workspace({ workingDirectory: "relative/worktree" })],
  ])("rejects a %s workspace", async (_label, resolver) => {
    const client = new FakeClient([[{ type: "thread.started", thread_id: "thread:sdk" }]]);
    const adapter = createCodexSdkCompatibilityAdapter({ executionMode: "deterministic-fake", client, workspace: resolver, now: () => new Date(NOW) });
    await expect(adapter.start(request())).rejects.toMatchObject({ code: "WORKSPACE_REJECTED" });
    await adapter.close();
  });

  it("rejects incompatible clients and protocol identity violations", async () => {
    expect(() => createCodexSdkCompatibilityAdapter({ executionMode: "deterministic-fake", client: { kind: "deterministic-fake", packageVersion: "0.146.0" } as never, workspace: workspace() })).toThrow(CodexSdkCompatibilityError);
    expect(() => createCodexSdkCompatibilityAdapter({ executionMode: "deterministic-fake" })).toThrow(CodexSdkCompatibilityError);

    const noStart = new FakeClient([[{ type: "turn.started" }]]);
    const first = createCodexSdkCompatibilityAdapter({ executionMode: "deterministic-fake", client: noStart, workspace: workspace() });
    await expect(first.start(request())).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
    await first.close();

    const empty = new FakeClient([[]]);
    const emptyAdapter = createCodexSdkCompatibilityAdapter({ executionMode: "deterministic-fake", client: empty, workspace: workspace() });
    await expect(emptyAdapter.start(request())).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
    await emptyAdapter.close();

    const changed = new FakeClient([[
      { type: "thread.started", thread_id: "thread:sdk" },
      { type: "thread.started", thread_id: "thread:changed" },
    ]]);
    const second = createCodexSdkCompatibilityAdapter({ executionMode: "deterministic-fake", client: changed, workspace: workspace() });
    const session = await second.start(request());
    await expect(collect(session.events)).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
    await second.close();

    const getterMismatch = new FakeClient([[
      { type: "thread.started", thread_id: "thread:sdk" },
    ]]);
    Object.defineProperty(getterMismatch.start, "id", { value: "thread:getter-mismatch" });
    const third = createCodexSdkCompatibilityAdapter({ executionMode: "deterministic-fake", client: getterMismatch, workspace: workspace() });
    await expect(third.start(request())).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
    await third.close();

    const unsupported = new FakeClient([[
      { type: "thread.started", thread_id: "thread:sdk" },
      { type: "future.event" } as never,
    ]]);
    const fourth = createCodexSdkCompatibilityAdapter({ executionMode: "deterministic-fake", client: unsupported, workspace: workspace() });
    const unsupportedSession = await fourth.start(request());
    await expect(collect(unsupportedSession.events)).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
    await fourth.close();

    const badUsage = new FakeClient([[
      { type: "thread.started", thread_id: "thread:sdk" },
      { type: "turn.completed", usage: { ...completedUsage, input_tokens: -1 } },
    ]]);
    const fifth = createCodexSdkCompatibilityAdapter({ executionMode: "deterministic-fake", client: badUsage, workspace: workspace() });
    const badUsageSession = await fifth.start(request());
    await expect(collect(badUsageSession.events)).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
    await fifth.close();

    const afterTerminal = new FakeClient([[
      { type: "thread.started", thread_id: "thread:sdk" },
      { type: "turn.completed", usage: completedUsage },
      { type: "turn.started" },
    ]]);
    const sixth = createCodexSdkCompatibilityAdapter({ executionMode: "deterministic-fake", client: afterTerminal, workspace: workspace() });
    const terminalSession = await sixth.start(request());
    await expect(collect(terminalSession.events)).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
    await sixth.close();
  });

  it("supports exact cancellation, fails closed after close, and uses read-only for read tasks", async () => {
    const client = new FakeClient([[
      { type: "thread.started", thread_id: "thread:sdk" },
      { type: "turn.started" },
    ]]);
    const adapter = createCodexSdkCompatibilityAdapter({ executionMode: "deterministic-fake", client, workspace: workspace() });
    const external = new AbortController();
    external.abort();
    const readRequest = { ...request(), task: { ...task(), capabilities: ["repository-read"] as const }, signal: external.signal };
    const session = await adapter.start(readRequest);
    expect(client.start.calls[0]?.signal?.aborted).toBe(true);
    await adapter.cancel({ dispatchId: readRequest.dispatchId, threadId: session.threadId, reason: "test" });
    expect(await adapter.status({ dispatchId: readRequest.dispatchId, threadId: session.threadId })).toBe("cancelled");
    expect(client.startOptions[0]?.sandboxMode).toBe("read-only");
    expect(await adapter.usage({ dispatchId: "dispatch:missing", threadId: "thread:missing" })).toBeNull();
    expect(await adapter.result({ dispatchId: "dispatch:missing", threadId: "thread:missing" })).toBeNull();
    await adapter.close();
    await adapter.close();
    await expect(adapter.start(readRequest)).rejects.toMatchObject({ code: "PRODUCTION_DISABLED" });
  });

  it("aborts the SDK signal when the exact deadline has elapsed", async () => {
    const client = new FakeClient([[
      { type: "thread.started", thread_id: "thread:sdk" },
      { type: "turn.started" },
    ]]);
    const adapter = createCodexSdkCompatibilityAdapter({ executionMode: "deterministic-fake", client, workspace: workspace() });
    const session = await adapter.start({ ...request(), deadline: "2020-01-01T00:00:00.000Z" });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(client.start.calls[0]?.signal?.aborted).toBe(true);
    await adapter.cancel({ dispatchId: request().dispatchId, threadId: session.threadId, reason: "deadline test complete" });
    await adapter.close();
  });
});
