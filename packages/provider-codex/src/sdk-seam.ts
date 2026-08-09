import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  AgentAdapter,
  AgentAdapterRequest,
  AgentAdapterSession,
  AgentAdapterSignal,
  AgentAdapterStatus,
  AgentContinuationRequest,
  AgentResumeRequest,
  NormalizedUsage,
  OrchestrationTaskEnvelope,
  OrchestrationTerminalResult,
  SelectedRoute,
  WorkspaceIdentity,
} from "@ai-dev-os/scheduler";

export const CODEX_SDK_COMPATIBILITY_VERSION = "0.147.0" as const;
export const CODEX_SDK_RUNTIME_DEPENDENCY_ENABLED = false as const;
export const CODEX_SDK_EXECUTION_MODES = Object.freeze(["disabled", "deterministic-fake"] as const);
export type CodexSdkExecutionMode = (typeof CODEX_SDK_EXECUTION_MODES)[number];

export const CODEX_SDK_COMPATIBILITY_ERROR_CODES = Object.freeze([
  "PRODUCTION_DISABLED",
  "INCOMPATIBLE_CLIENT",
  "WORKSPACE_REJECTED",
  "PROTOCOL_VIOLATION",
  "SESSION_NOT_FOUND",
] as const);
export type CodexSdkCompatibilityErrorCode = (typeof CODEX_SDK_COMPATIBILITY_ERROR_CODES)[number];

export class CodexSdkCompatibilityError extends Error {
  readonly code: CodexSdkCompatibilityErrorCode;

  constructor(code: CodexSdkCompatibilityErrorCode, message: string) {
    super(message);
    this.name = "CodexSdkCompatibilityError";
    this.code = code;
  }
}

export interface CodexSdkUsage {
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly cache_write_input_tokens: number;
  readonly output_tokens: number;
  readonly reasoning_output_tokens: number;
}

export type CodexSdkItemType =
  | "agent_message"
  | "reasoning"
  | "command_execution"
  | "file_change"
  | "mcp_tool_call"
  | "web_search"
  | "todo_list"
  | "error";

export interface CodexSdkThreadItem {
  readonly id: string;
  readonly type: CodexSdkItemType;
}

export type CodexSdkThreadEvent =
  | { readonly type: "thread.started"; readonly thread_id: string }
  | { readonly type: "turn.started" }
  | { readonly type: "turn.completed"; readonly usage: CodexSdkUsage }
  | { readonly type: "turn.failed"; readonly error: { readonly message: string } }
  | { readonly type: "item.started"; readonly item: CodexSdkThreadItem }
  | { readonly type: "item.updated"; readonly item: CodexSdkThreadItem }
  | { readonly type: "item.completed"; readonly item: CodexSdkThreadItem }
  | { readonly type: "error"; readonly message: string };

export interface CodexSdkThreadOptions {
  readonly model?: string;
  readonly sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  readonly workingDirectory?: string;
  readonly skipGitRepoCheck?: boolean;
  readonly networkAccessEnabled?: boolean;
  readonly webSearchMode?: "disabled" | "cached" | "live";
  readonly webSearchEnabled?: boolean;
  readonly approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  readonly additionalDirectories?: string[];
}

export interface CodexSdkThreadPort {
  readonly id: string | null;
  runStreamed(
    input: string,
    options?: { readonly outputSchema?: unknown; readonly signal?: AbortSignal },
  ): Promise<{ readonly events: AsyncIterable<CodexSdkThreadEvent> }>;
}

/**
 * Stage 18A accepts only an injected deterministic fake with the exact reviewed
 * SDK declaration version. It does not dynamically import or execute the SDK.
 */
export interface CodexSdkClientPort {
  readonly kind: "deterministic-fake";
  readonly packageVersion: typeof CODEX_SDK_COMPATIBILITY_VERSION;
  startThread(options?: CodexSdkThreadOptions): CodexSdkThreadPort;
  resumeThread(id: string, options?: CodexSdkThreadOptions): CodexSdkThreadPort;
}

export interface CodexSdkManagedWorkspace {
  readonly identity: WorkspaceIdentity;
  readonly workingDirectory: string;
  readonly managedRoot: string;
  readonly isManagedPrivateWorkspace: true;
}

export interface CodexSdkWorkspaceResolver {
  resolve(identity: WorkspaceIdentity): Promise<CodexSdkManagedWorkspace | null>;
}

export interface CodexSdkCompatibilityAdapterOptions {
  readonly executionMode?: CodexSdkExecutionMode;
  readonly client?: CodexSdkClientPort;
  readonly workspace?: CodexSdkWorkspaceResolver;
  readonly now?: () => Date;
}

export type ProductionDisabledCodexSdkAdapter = AgentAdapter & { readonly testingOnly: true };

interface SessionState {
  readonly dispatchId: string;
  readonly route: SelectedRoute;
  readonly task: OrchestrationTaskEnvelope;
  readonly thread: CodexSdkThreadPort;
  readonly threadId: string;
  readonly providerRunId: string;
  readonly workingDirectory: string;
  readonly startedAt: string;
  readonly controller: AbortController;
  readonly completedToolItems: Set<string>;
  usage: NormalizedUsage;
  status: AgentAdapterStatus;
  result: OrchestrationTerminalResult | null;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SDK_EVENT_TYPES = new Set([
  "thread.started", "turn.started", "turn.completed", "turn.failed",
  "item.started", "item.updated", "item.completed", "error",
]);
const SDK_ITEM_TYPES = new Set<CodexSdkItemType>([
  "agent_message", "reasoning", "command_execution", "file_change",
  "mcp_tool_call", "web_search", "todo_list", "error",
]);
const ZERO_USAGE: NormalizedUsage = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  toolCalls: 0,
  costMicros: null,
});

function cloneUsage(usage: NormalizedUsage): NormalizedUsage {
  return Object.freeze({ ...usage });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function providerRunId(dispatchId: string): string {
  return `run:${sha256(dispatchId).slice(0, 40)}`;
}

function ensureIdentifier(value: string, field: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new CodexSdkCompatibilityError("PROTOCOL_VIOLATION", `${field} is not a bounded provider identifier.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSdkEvent(value: unknown): asserts value is CodexSdkThreadEvent {
  if (!isRecord(value) || typeof value["type"] !== "string" || !SDK_EVENT_TYPES.has(value["type"])) {
    throw new CodexSdkCompatibilityError("PROTOCOL_VIOLATION", "The SDK emitted an unsupported event envelope.");
  }
  const type = value["type"];
  if (type === "thread.started" && typeof value["thread_id"] !== "string") {
    throw new CodexSdkCompatibilityError("PROTOCOL_VIOLATION", "thread.started is missing its thread identifier.");
  }
  if ((type === "item.started" || type === "item.updated" || type === "item.completed") &&
      (!isRecord(value["item"]) || typeof value["item"]["id"] !== "string" ||
       typeof value["item"]["type"] !== "string" || !SDK_ITEM_TYPES.has(value["item"]["type"] as CodexSdkItemType))) {
    throw new CodexSdkCompatibilityError("PROTOCOL_VIOLATION", "The SDK emitted an unsupported thread item envelope.");
  }
  if (type === "turn.completed") {
    const usage = value["usage"];
    if (!isRecord(usage) || ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"]
      .some((key) => typeof usage[key] !== "number")) {
      throw new CodexSdkCompatibilityError("PROTOCOL_VIOLATION", "turn.completed is missing exact numeric usage fields.");
    }
  }
  if (type === "turn.failed" && (!isRecord(value["error"]) || typeof value["error"]["message"] !== "string")) {
    throw new CodexSdkCompatibilityError("PROTOCOL_VIOLATION", "turn.failed is missing its bounded error envelope.");
  }
  if (type === "error" && typeof value["message"] !== "string") {
    throw new CodexSdkCompatibilityError("PROTOCOL_VIOLATION", "The SDK error event is malformed.");
  }
}

function checkedCount(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000) {
    throw new CodexSdkCompatibilityError("PROTOCOL_VIOLATION", `${field} is outside the normalized usage bound.`);
  }
  return value;
}

function checkedAdd(left: number, right: number, field: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value > 1_000_000_000_000) {
    throw new CodexSdkCompatibilityError("PROTOCOL_VIOLATION", `${field} overflowed the normalized usage bound.`);
  }
  return value;
}

function sameWorkspaceIdentity(left: WorkspaceIdentity, right: WorkspaceIdentity): boolean {
  return left.projectId === right.projectId &&
    left.workspaceId === right.workspaceId &&
    left.snapshotId === right.snapshotId &&
    left.baseRevision === right.baseRevision;
}

function validateManagedWorkspace(
  requested: WorkspaceIdentity,
  workspace: CodexSdkManagedWorkspace | null,
): CodexSdkManagedWorkspace {
  if (workspace === null || workspace.isManagedPrivateWorkspace !== true || !sameWorkspaceIdentity(requested, workspace.identity)) {
    throw new CodexSdkCompatibilityError("WORKSPACE_REJECTED", "The exact managed private workspace identity was not resolved.");
  }
  if (!isAbsolute(workspace.workingDirectory) || !isAbsolute(workspace.managedRoot) ||
      resolve(workspace.workingDirectory) !== workspace.workingDirectory || resolve(workspace.managedRoot) !== workspace.managedRoot) {
    throw new CodexSdkCompatibilityError("WORKSPACE_REJECTED", "Managed workspace paths must be canonical absolute paths.");
  }
  const fromRoot = relative(workspace.managedRoot, workspace.workingDirectory);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
    throw new CodexSdkCompatibilityError("WORKSPACE_REJECTED", "The working directory must be contained beneath the managed root.");
  }
  return workspace;
}

function threadOptions(route: SelectedRoute, task: OrchestrationTaskEnvelope, workingDirectory: string): CodexSdkThreadOptions {
  const repositoryWrite = task.capabilities.includes("repository-write");
  return Object.freeze({
    model: route.modelId,
    sandboxMode: repositoryWrite ? "workspace-write" as const : "read-only" as const,
    workingDirectory,
    skipGitRepoCheck: false,
    networkAccessEnabled: false,
    webSearchMode: "disabled" as const,
    webSearchEnabled: false,
    approvalPolicy: "on-request" as const,
    additionalDirectories: [],
  });
}

function failureResult(
  state: SessionState,
  code: string,
  finishedAt: string,
  retryable: boolean,
): OrchestrationTerminalResult {
  return Object.freeze({
    schemaVersion: 1,
    outcome: "failed",
    artifacts: Object.freeze([]),
    evidence: Object.freeze([]),
    usage: cloneUsage(state.usage),
    startedAt: state.startedAt,
    finishedAt,
    provider: Object.freeze({
      providerId: state.route.providerId,
      modelId: state.route.modelId,
      profileId: state.route.profileId,
      threadId: state.threadId,
      providerRunId: state.providerRunId,
    }),
    failure: Object.freeze({ classification: "provider" as const, code, retryable }),
    nonclaims: Object.freeze([
      "stage-18a-production-disabled",
      "sdk-stream-is-not-validation-evidence",
      "provider-content-is-not-persisted-by-this-seam",
    ]),
  });
}

function completedResult(state: SessionState, finishedAt: string): OrchestrationTerminalResult {
  return Object.freeze({
    schemaVersion: 1,
    outcome: "completed",
    artifacts: Object.freeze([]),
    evidence: Object.freeze([]),
    usage: cloneUsage(state.usage),
    startedAt: state.startedAt,
    finishedAt,
    provider: Object.freeze({
      providerId: state.route.providerId,
      modelId: state.route.modelId,
      profileId: state.route.profileId,
      threadId: state.threadId,
      providerRunId: state.providerRunId,
    }),
    failure: null,
    nonclaims: Object.freeze([
      "stage-18a-production-disabled",
      "sdk-stream-is-not-validation-evidence",
      "provider-content-is-not-persisted-by-this-seam",
    ]),
  });
}

function addSdkUsage(current: NormalizedUsage, sdk: CodexSdkUsage): NormalizedUsage {
  return Object.freeze({
    inputTokens: checkedAdd(current.inputTokens, checkedCount(sdk.input_tokens, "input_tokens"), "inputTokens"),
    cachedInputTokens: checkedAdd(current.cachedInputTokens, checkedCount(sdk.cached_input_tokens, "cached_input_tokens"), "cachedInputTokens"),
    cacheWriteInputTokens: checkedAdd(current.cacheWriteInputTokens, checkedCount(sdk.cache_write_input_tokens, "cache_write_input_tokens"), "cacheWriteInputTokens"),
    outputTokens: checkedAdd(current.outputTokens, checkedCount(sdk.output_tokens, "output_tokens"), "outputTokens"),
    reasoningTokens: checkedAdd(current.reasoningTokens, checkedCount(sdk.reasoning_output_tokens, "reasoning_output_tokens"), "reasoningTokens"),
    toolCalls: current.toolCalls,
    costMicros: null,
  });
}

function checkpointKind(type: CodexSdkItemType): string {
  switch (type) {
    case "agent_message": return "agent-message";
    case "reasoning": return "reasoning";
    case "command_execution": return "command-execution";
    case "file_change": return "file-change";
    case "mcp_tool_call": return "mcp-tool-call";
    case "web_search": return "web-search";
    case "todo_list": return "todo-list";
    case "error": return "provider-error";
  }
}

function isToolItem(type: CodexSdkItemType): boolean {
  return type === "command_execution" || type === "file_change" || type === "mcp_tool_call" || type === "web_search";
}

function disabledSession(dispatchId: string): AgentAdapterSession {
  const suffix = sha256(dispatchId).slice(0, 32);
  return Object.freeze({
    threadId: `disabled:${suffix}`,
    providerRunId: `run:${suffix}`,
    events: Object.freeze({
      async *[Symbol.asyncIterator](): AsyncGenerator<AgentAdapterSignal> {
        yield Object.freeze({
          type: "policy-blocked" as const,
          code: "stage-18a-production-disabled",
          reason: "The Stage 18A Codex SDK compatibility seam is production-disabled.",
          humanResumable: false,
        });
      },
    }),
  });
}

function deadlineController(deadline: string, external: AbortSignal | undefined): {
  readonly controller: AbortController;
  readonly cleanup: () => void;
} {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (external?.aborted === true) controller.abort();
  else external?.addEventListener("abort", abort, { once: true });
  const delay = Math.max(0, Date.parse(deadline) - Date.now());
  const timer = setTimeout(() => controller.abort(), delay);
  timer.unref?.();
  return Object.freeze({
    controller,
    cleanup: (): void => {
      clearTimeout(timer);
      external?.removeEventListener("abort", abort);
    },
  });
}

export function createCodexSdkCompatibilityAdapter(
  options: CodexSdkCompatibilityAdapterOptions = {},
): ProductionDisabledCodexSdkAdapter {
  const executionMode = options.executionMode ?? "disabled";
  const now = options.now ?? (() => new Date());
  if (executionMode === "deterministic-fake") {
    if (options.client?.kind !== "deterministic-fake" || options.client.packageVersion !== CODEX_SDK_COMPATIBILITY_VERSION || options.workspace === undefined) {
      throw new CodexSdkCompatibilityError("INCOMPATIBLE_CLIENT", "Deterministic execution requires an injected exact-version fake client and managed workspace resolver.");
    }
  }
  const sessions = new Map<string, SessionState>();
  let closed = false;

  async function signalsFor(
    state: SessionState,
    streamed: { readonly events: AsyncIterable<CodexSdkThreadEvent> },
    prefetched: CodexSdkThreadEvent | null,
    cleanup: () => void,
  ): Promise<AgentAdapterSession> {
    const events = Object.freeze({
      async *[Symbol.asyncIterator](): AsyncGenerator<AgentAdapterSignal> {
        let terminal = false;
        async function* allEvents(): AsyncGenerator<CodexSdkThreadEvent> {
          if (prefetched !== null) yield prefetched;
          for await (const event of streamed.events) yield event;
        }
        try {
          for await (const event of allEvents()) {
            assertSdkEvent(event);
            if (terminal) throw new CodexSdkCompatibilityError("PROTOCOL_VIOLATION", "The SDK emitted an event after a terminal turn event.");
            switch (event.type) {
              case "thread.started":
                if (event.thread_id !== state.threadId) throw new CodexSdkCompatibilityError("PROTOCOL_VIOLATION", "The SDK changed thread identity within a session.");
                break;
              case "turn.started":
                yield Object.freeze({ type: "progress" as const, message: "Codex SDK turn started.", percent: null });
                break;
              case "item.started":
              case "item.updated":
                break;
              case "item.completed": {
                ensureIdentifier(event.item.id, "item.id");
                if (isToolItem(event.item.type) && !state.completedToolItems.has(event.item.id)) {
                  state.completedToolItems.add(event.item.id);
                  state.usage = Object.freeze({ ...state.usage, toolCalls: checkedAdd(state.usage.toolCalls, 1, "toolCalls") });
                }
                yield Object.freeze({
                  type: "checkpoint" as const,
                  checkpointId: `checkpoint:${sha256(`${state.threadId}|${event.item.id}`).slice(0, 40)}`,
                  kind: checkpointKind(event.item.type),
                  artifactIds: Object.freeze([]),
                });
                break;
              }
              case "turn.completed": {
                state.usage = addSdkUsage(state.usage, event.usage);
                yield Object.freeze({ type: "usage" as const, usage: cloneUsage(state.usage) });
                const result = completedResult(state, now().toISOString());
                state.result = result;
                state.status = "completed";
                terminal = true;
                yield Object.freeze({ type: "completed" as const, result });
                break;
              }
              case "turn.failed":
              case "error": {
                const result = failureResult(state, event.type === "turn.failed" ? "codex-sdk-turn-failed" : "codex-sdk-stream-error", now().toISOString(), true);
                state.result = result;
                state.status = "failed";
                terminal = true;
                yield Object.freeze({ type: "failed" as const, result });
                break;
              }
            }
          }
          if (!terminal && state.status !== "cancelled") {
            const result = failureResult(state, "codex-sdk-stream-ended", now().toISOString(), true);
            state.result = result;
            state.status = "failed";
            yield Object.freeze({ type: "failed" as const, result });
          }
        } finally {
          cleanup();
        }
      },
    });
    return Object.freeze({ threadId: state.threadId, providerRunId: state.providerRunId, events });
  }

  function requireOpen(): void {
    if (closed) throw new CodexSdkCompatibilityError("PRODUCTION_DISABLED", "The compatibility adapter is closed.");
  }

  function requireFakePorts(): { readonly client: CodexSdkClientPort; readonly workspace: CodexSdkWorkspaceResolver } {
    if (executionMode !== "deterministic-fake" || options.client === undefined || options.workspace === undefined) {
      throw new CodexSdkCompatibilityError("PRODUCTION_DISABLED", "The Stage 18A compatibility adapter has no production execution path.");
    }
    return Object.freeze({ client: options.client, workspace: options.workspace });
  }

  async function runExisting(
    state: SessionState,
    thread: CodexSdkThreadPort,
    input: string,
    deadline: string,
    signal: AbortSignal | undefined,
  ): Promise<AgentAdapterSession> {
    state.status = "running";
    const bounded = deadlineController(deadline, signal);
    state.controller.abort();
    const replacement: SessionState = { ...state, thread, controller: bounded.controller };
    sessions.set(state.dispatchId, replacement);
    try {
      const streamed = await thread.runStreamed(input, { outputSchema: state.task.expectedResultSchema, signal: bounded.controller.signal });
      return signalsFor(replacement, streamed, null, bounded.cleanup);
    } catch (error) {
      bounded.cleanup();
      throw error;
    }
  }

  const adapter: ProductionDisabledCodexSdkAdapter = Object.freeze({
    testingOnly: true as const,
    adapterId: "adapter:codex-sdk-0.147-compatibility",
    providerId: "codex",

    async start(request: AgentAdapterRequest): Promise<AgentAdapterSession> {
      requireOpen();
      if (executionMode === "disabled") return disabledSession(request.dispatchId);
      const ports = requireFakePorts();
      const workspace = validateManagedWorkspace(request.task.workspace, await ports.workspace.resolve(request.task.workspace));
      const bounded = deadlineController(request.deadline, request.signal);
      const thread = ports.client.startThread(threadOptions(request.route, request.task, workspace.workingDirectory));
      try {
        const streamed = await thread.runStreamed(request.task.objective, {
          outputSchema: request.task.expectedResultSchema,
          signal: bounded.controller.signal,
        });
        const iterator = streamed.events[Symbol.asyncIterator]();
        const first = await iterator.next();
        if (first.done === true) {
          throw new CodexSdkCompatibilityError("PROTOCOL_VIOLATION", "A new SDK thread must begin with thread.started.");
        }
        assertSdkEvent(first.value);
        if (first.value.type !== "thread.started") {
          throw new CodexSdkCompatibilityError("PROTOCOL_VIOLATION", "A new SDK thread must begin with thread.started.");
        }
        const threadId = ensureIdentifier(first.value.thread_id, "thread_id");
        if (thread.id !== null && thread.id !== threadId) {
          throw new CodexSdkCompatibilityError("PROTOCOL_VIOLATION", "The SDK thread getter disagrees with thread.started.");
        }
        const remaining = Object.freeze({
          async *[Symbol.asyncIterator](): AsyncGenerator<CodexSdkThreadEvent> {
            while (true) {
              const next = await iterator.next();
              if (next.done === true) return;
              yield next.value;
            }
          },
        });
        const state: SessionState = {
          dispatchId: request.dispatchId,
          route: request.route,
          task: request.task,
          thread,
          threadId,
          providerRunId: providerRunId(request.dispatchId),
          workingDirectory: workspace.workingDirectory,
          startedAt: now().toISOString(),
          controller: bounded.controller,
          completedToolItems: new Set<string>(),
          usage: cloneUsage(ZERO_USAGE),
          status: "running",
          result: null,
        };
        sessions.set(request.dispatchId, state);
        return signalsFor(state, { events: remaining }, null, bounded.cleanup);
      } catch (error) {
        bounded.cleanup();
        throw error;
      }
    },

    async continue(request: AgentContinuationRequest): Promise<AgentAdapterSession> {
      requireOpen();
      if (executionMode === "disabled") return disabledSession(request.dispatchId);
      requireFakePorts();
      const state = sessions.get(request.dispatchId);
      if (state === undefined || state.threadId !== request.threadId || state.providerRunId !== request.providerRunId) {
        throw new CodexSdkCompatibilityError("SESSION_NOT_FOUND", "Continuation is not bound to an exact in-memory SDK session.");
      }
      return runExisting(state, state.thread, request.instruction, request.deadline, request.signal);
    },

    async resume(request: AgentResumeRequest): Promise<AgentAdapterSession> {
      requireOpen();
      if (executionMode === "disabled") return disabledSession(request.dispatchId);
      const ports = requireFakePorts();
      const state = sessions.get(request.dispatchId);
      if (state === undefined || state.threadId !== request.threadId) {
        throw new CodexSdkCompatibilityError("SESSION_NOT_FOUND", "Resume requires the exact retained workspace and route binding.");
      }
      const thread = ports.client.resumeThread(request.threadId, threadOptions(state.route, state.task, state.workingDirectory));
      return runExisting(state, thread, "Continue the bounded task from its durable checkpoint.", request.deadline, request.signal);
    },

    async cancel(request: { readonly dispatchId: string; readonly threadId: string | null; readonly reason: string }): Promise<void> {
      const state = sessions.get(request.dispatchId);
      if (state !== undefined && (request.threadId === null || request.threadId === state.threadId)) {
        state.controller.abort();
        state.status = "cancelled";
      }
    },

    async status(request: { readonly dispatchId: string; readonly threadId: string | null }): Promise<AgentAdapterStatus> {
      const state = sessions.get(request.dispatchId);
      if (state === undefined || (request.threadId !== null && request.threadId !== state.threadId)) return "not-found";
      return state.status;
    },

    async usage(request: { readonly dispatchId: string; readonly threadId: string }): Promise<NormalizedUsage | null> {
      const state = sessions.get(request.dispatchId);
      return state?.threadId === request.threadId ? cloneUsage(state.usage) : null;
    },

    async result(request: { readonly dispatchId: string; readonly threadId: string }): Promise<OrchestrationTerminalResult | null> {
      const state = sessions.get(request.dispatchId);
      return state?.threadId === request.threadId ? state.result : null;
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const state of sessions.values()) state.controller.abort();
      sessions.clear();
    },
  });
  return adapter;
}
