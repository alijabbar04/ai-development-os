import { createHash } from "node:crypto";
import type { ArtifactId } from "@ai-dev-os/domain";
import { grantAllowsOperation } from "@ai-dev-os/process-broker";
import {
  ProviderError,
  UNKNOWN_COST,
  createOperationController,
  parseCodingAgentResult,
  parseProviderDescriptor,
  parseProviderHealth,
  parseToolInvocation,
  type CodingAgentEvent,
  type CodingAgentProvider,
  type CodingAgentRequest,
  type CodingAgentResult,
  type CodingAgentOperation,
  type ProviderDescriptor,
  type ProviderHealth,
  type ProviderOperationId,
  type StartOperationOptions,
} from "@ai-dev-os/providers";
import type { CodexAdapterConfiguration, CodexEffort } from "./config.js";
import { CODEX_PROVIDER_ID, codexConfigurationFingerprint } from "./config.js";
import { connectCodexAppServer, CodexRpcError, type CodexConnection } from "./connection.js";
import {
  codexAuthenticationFailed,
  codexCancelled,
  codexContextLimit,
  codexContentRejected,
  codexDeadlineExceeded,
  codexInternalFailure,
  codexNetworkFailure,
  codexOverloaded,
  codexProtocolViolation,
  codexProviderClosed,
  codexRateLimited,
  codexWorkspaceUnavailable,
  codexUsageCeilingExceeded,
  invalidCodexRequest,
  unsupportedCodexCapability,
} from "./errors.js";
import type { CodexProbeResult } from "./probe.js";
import {
  decliningCodexApprovalPort,
  denyingCodexArtifactSink,
  permissiveCodexDevelopmentPolicy,
  systemCodexClock,
  systemCodexScheduler,
  type CodexApprovalEvidence,
  type CodexApprovalPort,
  type CodexArtifactSink,
  type CodexClock,
  type CodexProcessPort,
  type CodexScheduler,
  type CodexSessionPolicyPort,
  type CodexWorkspaceHandle,
  type CodexWorkspacePort,
} from "./ports.js";
import { reconcileCodexWorkspace, type CodexReconciliationResult } from "./reconciliation.js";
import { mapCodexBrokerFailure } from "./process.js";
import { mintCodexResumeToken, verifyCodexResumeToken, type CodexSessionBinding } from "./session.js";
import {
  mapCodexAccountState,
  mapCodexAccountUsage,
  mapCodexRateLimits,
  type CodexAccountState,
  type CodexAccountUsageSnapshot,
  type CodexRateLimitSnapshot,
} from "./telemetry.js";
import { parseCodexTokenUsage, reconcileCodexUsage, toProviderCodexUsage, ZERO_CODEX_USAGE, type CodexTokenUsage } from "./usage.js";
import type { CodexWireNotification, CodexWireRequest } from "./wire.js";

export interface CodexProvider extends CodingAgentProvider {
  probe(): Promise<CodexProbeResult>;
  accountState(): Promise<CodexAccountState>;
  rateLimits(): Promise<CodexRateLimitSnapshot>;
  accountUsage(): Promise<CodexAccountUsageSnapshot>;
}

export interface CreateCodexProviderOptions {
  readonly configuration: CodexAdapterConfiguration;
  readonly process: CodexProcessPort;
  readonly workspace: CodexWorkspacePort;
  readonly runProbe: () => Promise<CodexProbeResult>;
  readonly artifacts?: CodexArtifactSink;
  readonly policy?: CodexSessionPolicyPort;
  readonly approvals?: CodexApprovalPort;
  readonly clock?: CodexClock;
  readonly scheduler?: CodexScheduler;
}

type EventController = ReturnType<typeof createOperationController<CodingAgentEvent, CodingAgentResult>>;
type EventBase = Parameters<Parameters<EventController["emit"]>[0]>[0];
interface TurnState {
  threadId: string | null;
  turnId: string | null;
  sessionId: string | null;
  usage: CodexTokenUsage;
  toolCalls: number;
  approvalDecisions: Array<{ approvalId: string; decision: "approved" | "denied" }>;
  error: ProviderError | null;
  terminalStatus: "completed" | "interrupted" | "failed" | null;
  warnings: string[];
}
interface UsageCeilings { readonly input: number; readonly output: number; readonly total: number }

const rawRecord = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const boundedText = (value: unknown, max = 65_536): string | null => typeof value === "string" && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ? value : null;
const boundedId = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : null;

export function createCodexProvider(options: CreateCodexProviderOptions): CodexProvider {
  const configuration = options.configuration;
  const clock = options.clock ?? systemCodexClock;
  const scheduler = options.scheduler ?? systemCodexScheduler;
  const artifacts = options.artifacts ?? denyingCodexArtifactSink;
  const policy = options.policy ?? permissiveCodexDevelopmentPolicy;
  const approvals = options.approvals ?? decliningCodexApprovalPort;
  const fingerprint = codexConfigurationFingerprint(configuration);
  let closed = false;
  let probe: CodexProbeResult | null = null;
  let probePromise: Promise<CodexProbeResult> | null = null;
  let operationSequence = 0;
  let active = 0;
  const cancelActive = new Set<() => Promise<void>>();

  const descriptor: ProviderDescriptor = parseProviderDescriptor({
    schemaVersion: 1, providerId: CODEX_PROVIDER_ID, instanceId: configuration.instanceId,
    kind: "coding-agent", displayName: "Codex", locality: "cloud", retainsData: true,
    trainsOnInputs: false, supportedClassifications: configuration.dataClassifications,
    capabilities: {
      streaming: true, structuredOutput: false, toolCalling: true, imageInput: false,
      repositoryEditing: true, commandExecution: true, networkAccess: false,
      resumability: configuration.sessions.persistence !== "ephemeral-only", cancellation: "best-effort",
      deadlineEnforcement: true, usageReporting: true, pricingAvailable: false,
    },
  });

  const ensureProbe = async (): Promise<CodexProbeResult> => {
    if (probe !== null) return probe;
    probePromise ??= options.runProbe().then((value) => { probe = value; return value; });
    return await probePromise;
  };

  const trace = (name: string) => ({ traceId: `${name}-${configuration.instanceId}`, runId: null, taskId: null, taskRunId: null });

  async function telemetryConnection(): Promise<CodexConnection> {
    const current = await ensureProbe();
    if (current.compatibility?.usableForReadOnly !== true) throw unsupportedCodexCapability(current.detailCode === "version-unsupported" ? "version-unsupported" : "schema-incompatible");
    return await connectCodexAppServer({
      configuration, process: options.process, scheduler,
      request: { kind: "app-server", args: [], deadline: null, wallClockMs: configuration.deadlines.operationMs, outputBytes: configuration.ceilings.maxProcessOutputBytes, environment: [], workspaceId: "account", trace: trace("account") },
      handleServerRequest: async () => ({ decision: "decline" }),
    });
  }

  async function readAccount(): Promise<CodexAccountState> {
    const connection = await telemetryConnection();
    try { return mapCodexAccountState(await connection.request("account/read", { refreshToken: false }), clock); }
    finally { await connection.close(); }
  }

  async function start(request: CodingAgentRequest, startOptions: StartOperationOptions = {}): Promise<CodingAgentOperation> {
    if (closed) throw codexProviderClosed();
    const workspace = await options.workspace.resolve(request.workspaceId);
    if (workspace === null) throw codexWorkspaceUnavailable("workspace-missing");
    try { workspace.lease.assertValid(); } catch { throw codexWorkspaceUnavailable("workspace-lineage-mismatch"); }
    if (!workspace.isManagedPrivateWorktree) throw codexWorkspaceUnavailable("workspace-is-source-tree");
    if (request.baseRevision !== null && request.baseRevision !== workspace.baseRevision) throw codexWorkspaceUnavailable("workspace-lineage-mismatch");
    if (request.deadline !== null && new Date(request.deadline).valueOf() <= clock.now().valueOf()) throw codexDeadlineExceeded({ phase: "pre-start" });
    validateRequest(request, workspace);
    const model = request.modelId as string | null ?? configuration.defaultModel;
    if (model === null || !configuration.models.some((entry) => entry.modelId === model)) throw invalidCodexRequest("model-not-permitted");
    const effort = effortFor(request, model);
    const usageCeilings = usageCeilingsFor(request);
    const currentProbe = await ensureProbe();
    const editing = request.capabilities.includes("edit-files");
    if (currentProbe.compatibility === null || (editing ? !currentProbe.compatibility.usableForStateChanging : !currentProbe.compatibility.usableForReadOnly)) throw unsupportedCodexCapability(currentProbe.detailCode === "version-unsupported" ? "version-unsupported" : "schema-incompatible");
    const decision = await policy.evaluateSession({
      instanceId: configuration.instanceId, projectId: workspace.projectId, workspaceId: workspace.workspaceId,
      requestId: request.requestId, classification: request.disclosure.classification,
      capabilities: request.capabilities, continuationRequested: request.resumeToken !== null,
      configurationFingerprint: fingerprint,
    });
    if (decision.outcome !== "allowed") throw unsupportedCodexCapability("approval-unrepresentable", { policyOutcome: decision.outcome });
    const persistenceAllowed = configuration.sessions.persistence === "policy-controlled"
      && configuration.sessions.retentionMs > 0
      && decision.sessionPersistenceAllowed
      && request.disclosure.retentionAllowed;
    let resume: CodexSessionBinding | null = null;
    if (request.resumeToken !== null) {
      const verification = verifyCodexResumeToken({
        token: request.resumeToken, instanceId: configuration.instanceId, projectId: workspace.projectId,
        workspaceId: workspace.workspaceId, snapshotId: workspace.snapshotId, model, effort,
        configurationFingerprint: fingerprint, now: clock.now(), sessionPersistenceAllowed: persistenceAllowed,
      });
      if (!verification.ok) {
        if (verification.detailCode === "session-persistence-denied") throw unsupportedCodexCapability(verification.detailCode);
        throw invalidCodexRequest(verification.detailCode);
      }
      resume = verification.binding;
    }
    const before = await workspace.captureChanges().catch(() => null);
    if (before === null || before.entries.length > 0) throw codexWorkspaceUnavailable("workspace-lineage-mismatch");

    const operationId = `op-codex-${(++operationSequence).toString().padStart(6, "0")}` as ProviderOperationId;
    const controller = createOperationController<CodingAgentEvent, CodingAgentResult>({
      operationId, clock, trace: request.trace,
      buildCancelledEvent: (base, reason) => ({ ...base, kind: "operation-cancelled", payload: { reason } }),
    });
    const abort = new AbortController();
    let connection: CodexConnection | null = null;
    const state: TurnState = { threadId: null, turnId: null, sessionId: null, usage: ZERO_CODEX_USAGE, toolCalls: 0, approvalDecisions: [], error: null, terminalStatus: null, warnings: [] };
    controller.onCancel(() => {
      void (async () => {
        if (connection !== null && state.threadId !== null && state.turnId !== null && !connection.closed) {
          await connection.request("turn/interrupt", { threadId: state.threadId, turnId: state.turnId }, { timeoutMs: configuration.deadlines.requestMs }).catch(() => undefined);
        }
        abort.abort();
      })();
    });
    controller.emit((base) => ({ ...base, kind: "operation-started", payload: { workspaceId: request.workspaceId } }));
    if (startOptions.signal?.aborted === true) {
      await controller.operation.cancel("caller-aborted");
      return controller.operation;
    }
    startOptions.signal?.addEventListener("abort", () => { void controller.operation.cancel("caller-aborted"); }, { once: true });
    const closeCancel = async () => await controller.operation.cancel("provider-closed");
    cancelActive.add(closeCancel); active += 1;
    void runOperation({ request, workspace, controller, state, model, effort, usageCeilings, decision, persistenceAllowed, resume, abort, setConnection: (value) => { connection = value; } })
      .catch(() => undefined)
      .finally(() => { active -= 1; cancelActive.delete(closeCancel); });
    return controller.operation;
  }

  async function runOperation(context: {
    readonly request: CodingAgentRequest; readonly workspace: CodexWorkspaceHandle; readonly controller: EventController;
    readonly state: TurnState; readonly model: string; readonly effort: CodexEffort;
    readonly usageCeilings: UsageCeilings;
    readonly decision: Awaited<ReturnType<CodexSessionPolicyPort["evaluateSession"]>>;
    readonly persistenceAllowed: boolean; readonly resume: CodexSessionBinding | null;
    readonly abort: AbortController; readonly setConnection: (value: CodexConnection) => void;
  }): Promise<void> {
    const { request, workspace, controller, state, model, effort } = context;
    const startedAt = clock.now();
    let terminalResolve!: () => void;
    const terminal = new Promise<void>((resolve) => { terminalResolve = resolve; });
    let connection: CodexConnection | null = null;
    const emit = (build: (base: EventBase) => CodingAgentEvent): void => { if (!controller.isTerminal) controller.emit(build); };
    try {
      connection = await connectCodexAppServer({
        configuration, process: options.process, scheduler,
        request: { kind: "app-server", args: [], deadline: request.deadline, wallClockMs: Math.min(configuration.deadlines.operationMs, request.budget?.time?.maxDurationMs ?? configuration.deadlines.operationMs), outputBytes: configuration.ceilings.maxProcessOutputBytes, environment: [], workspaceId: request.workspaceId, trace: request.trace, signal: context.abort.signal },
        handleServerRequest: async (serverRequest) => await handleApproval(serverRequest, request, state, emit, approvals, clock),
      });
      context.setConnection(connection);
      const unsubscribe = connection.onNotification((notification) => {
        try { applyNotification(notification, state, context.usageCeilings, emit, terminalResolve); }
        catch (error) { state.error = error instanceof ProviderError ? error : codexProtocolViolation("malformed-json"); terminalResolve(); }
      });
      const approvalPolicy = request.approvalMode === "never" ? "never" : "on-request";
      const sandbox = request.capabilities.includes("edit-files") ? "workspace-write" : "read-only";
      const threadMethod = context.resume === null ? "thread/start" : "thread/resume";
      const threadRaw = await connection.request(threadMethod, {
        ...(context.resume === null ? {} : { threadId: context.resume.threadId }),
        model, cwd: workspace.worktreeDir, approvalPolicy, sandbox,
        config: {
          model_reasoning_effort: effort,
          mcp_servers: {},
          skills: { config: [] },
          web_search: "disabled",
          features: { apps: false, remote_plugin: false, multi_agent: false, hooks: false, memories: false, goals: false, web_search: false, web_search_cached: false, web_search_request: false },
        },
        ...(context.resume === null ? { ephemeral: !context.persistenceAllowed } : {}),
        baseInstructions: null, developerInstructions: null,
      }, { signal: context.abort.signal });
      const threadResponse = rawRecord(threadRaw); const thread = rawRecord(threadResponse?.["thread"]);
      state.threadId = boundedId(thread?.["id"]); state.sessionId = boundedId(thread?.["sessionId"]);
      if (state.threadId === null || state.sessionId === null || threadResponse?.["model"] !== model || threadResponse?.["reasoningEffort"] !== effort) throw codexProtocolViolation(threadResponse?.["model"] !== model ? "model-substituted" : "malformed-json");
      if (context.resume !== null && (state.threadId !== context.resume.threadId || state.sessionId !== context.resume.sessionId)) throw codexProtocolViolation("malformed-json");
      const turnRaw = await connection.request("turn/start", {
        threadId: state.threadId, clientUserMessageId: request.requestId,
        input: [{ type: "text", text: request.instructions, text_elements: [] }], cwd: workspace.worktreeDir,
        approvalPolicy, model, effort,
        sandboxPolicy: sandbox === "read-only" ? { type: "readOnly", networkAccess: false } : { type: "workspaceWrite", writableRoots: [workspace.worktreeDir], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
      }, { signal: context.abort.signal });
      state.turnId = boundedId(rawRecord(rawRecord(turnRaw)?.["turn"])?.["id"]);
      if (state.turnId === null) throw codexProtocolViolation("malformed-json");
      await Promise.race([terminal, connection.done.then(() => { if (state.terminalStatus === null) state.error = connection?.failure ?? codexNetworkFailure(); })]);
      unsubscribe();
      if (state.terminalStatus === null && state.error === null) state.error = connection.failure ?? codexNetworkFailure();
    } catch (error) {
      if (context.abort.signal.aborted) state.error = codexCancelled();
      else if (request.deadline !== null && clock.now().valueOf() >= new Date(request.deadline).valueOf()) state.error = codexDeadlineExceeded({ phase: "operation" });
      else if (error instanceof ProviderError) state.error = error;
      else if (error instanceof CodexRpcError) state.error = mapRpcError(error);
      else state.error = mapCodexBrokerFailure(error);
    } finally {
      await connection?.close().catch(() => undefined);
    }

    const reconciliation = await reconcileCodexWorkspace({ workspace, grant: workspace.grant, allowedPathPrefixes: request.fileAccess.allowedPathPrefixes, maxChangedFiles: request.maxChangedFiles, maxProducedBytes: request.maxProducedBytes, editingGranted: request.capabilities.includes("edit-files") });
    await settleOperation({ request, workspace, controller, state, reconciliation, decision: context.decision, persistenceAllowed: context.persistenceAllowed, startedAt });
  }

  async function settleOperation(input: {
    readonly request: CodingAgentRequest; readonly workspace: CodexWorkspaceHandle; readonly controller: EventController;
    readonly state: TurnState; readonly reconciliation: CodexReconciliationResult;
    readonly decision: Awaited<ReturnType<CodexSessionPolicyPort["evaluateSession"]>>; readonly persistenceAllowed: boolean; readonly startedAt: Date;
  }): Promise<void> {
    const { request, workspace, controller, state, reconciliation } = input;
    if (controller.isTerminal) return;
    let failure = state.error;
    if (!reconciliation.clean && failure === null) failure = codexWorkspaceUnavailable(reconciliation.violations[0]?.detailCode ?? "reconciliation-path-violation");
    if (state.terminalStatus === "interrupted" && failure === null) failure = codexCancelled();
    if (state.terminalStatus === "failed" && failure === null) failure = codexInternalFailure();
    const emit = (build: (base: EventBase) => CodingAgentEvent) => { if (!controller.isTerminal) controller.emit(build); };
    for (const warning of state.warnings.slice(0, 32)) emit((base) => ({ ...base, kind: "warning", payload: { message: warning } }));
    for (const change of reconciliation.changedFiles) emit((base) => ({ ...base, kind: "file-change-applied", payload: { change } }));
    let patchArtifactId: ArtifactId | null = null;
    const producedArtifacts: ArtifactId[] = [];
    if (failure === null && reconciliation.changedFiles.length > 0 && input.decision.artifactPersistenceAllowed && request.disclosure.retentionAllowed) {
      const bytes = await workspace.capturePatch(request.maxProducedBytes).catch(() => null);
      if (bytes !== null) patchArtifactId = await artifacts.write({ category: "patch", kind: "patch", bytes, classification: request.disclosure.classification, mediaType: "text/x-diff" }) as ArtifactId | null;
      if (patchArtifactId !== null) { producedArtifacts.push(patchArtifactId); emit((base) => ({ ...base, kind: "patch-produced", payload: { artifactId: patchArtifactId! } })); }
    }
    let testResults: CodingAgentResult["testResults"] = null;
    if (request.capabilities.includes("run-tests")) {
      const report = await workspace.readTestReport("reports/tests.json", 1_048_576);
      if (report !== null) {
        emit((base) => ({ ...base, kind: "test-started", payload: { suite: report.suite } }));
        emit((base) => ({ ...base, kind: "test-completed", payload: report }));
        const bytes = new TextEncoder().encode(JSON.stringify(report));
        const artifactId = input.decision.artifactPersistenceAllowed ? await artifacts.write({ category: "test-report", kind: "test-result", bytes, classification: request.disclosure.classification, mediaType: "application/json" }) as ArtifactId | null : null;
        if (artifactId !== null) producedArtifacts.push(artifactId);
        testResults = Object.freeze({ artifactId, passed: report.passed, failed: report.failed, skipped: report.skipped });
      }
    }
    const usage = toProviderCodexUsage(state.usage, state.toolCalls);
    if (usage.tokens.inputTokens + usage.tokens.outputTokens + usage.tokens.cachedInputTokens + usage.tokens.reasoningTokens + usage.toolCalls > 0) emit((base) => ({ ...base, kind: "usage-update", payload: { usage } }));
    let resultRevision: string | null = reconciliation.changedFiles.length === 0 ? workspace.baseRevision : null;
    if (failure === null && request.capabilities.includes("git-commit") && reconciliation.changedFiles.length > 0) {
      const commit = await workspace.commit({ message: `ai-dev-os codex attempt ${request.requestId}`, committedAt: clock.now().toISOString(), policyFingerprint: workspace.grant.policyFingerprint }).catch(() => null);
      if (commit === null) failure = codexInternalFailure("internal", { phase: "commit" }); else resultRevision = commit.commitId;
    }
    if (failure !== null) {
      controller.fail((base) => ({ ...base, kind: "operation-failed", payload: { code: failure!.code, message: failure!.message, retryStrategy: failure!.retry.strategy } }), failure);
      return;
    }
    const resumeToken = input.persistenceAllowed && state.threadId !== null && state.sessionId !== null
      ? mintCodexResumeToken({
          threadId: state.threadId, sessionId: state.sessionId, instanceId: configuration.instanceId,
          projectId: workspace.projectId, workspaceId: workspace.workspaceId, snapshotId: workspace.snapshotId,
          model: request.modelId ?? configuration.defaultModel!, effort: effortFor(request, request.modelId ?? configuration.defaultModel!),
          configurationFingerprint: fingerprint,
          expiresAt: new Date(clock.now().valueOf() + configuration.sessions.retentionMs).toISOString(),
        })
      : null;
    const result = parseCodingAgentResult({
      schemaVersion: 1, operationId: controller.operation.operationId, requestId: request.requestId,
      completion: reconciliation.changedFiles.length === 0 ? "completed-no-changes" : "completed",
      patchArtifactId, changedFiles: reconciliation.changedFiles, testResults,
      commandLogArtifactId: null, diagnosticsArtifactId: null, producedArtifacts,
      baseRevision: workspace.baseRevision, resultRevision,
      approvalDecisions: state.approvalDecisions, usage, cost: UNKNOWN_COST,
      latency: { firstEventMs: 0, totalMs: Math.max(0, clock.now().valueOf() - input.startedAt.valueOf()) },
      warnings: state.warnings.slice(0, 32), resumeToken,
    });
    controller.complete((base) => ({ ...base, kind: "operation-completed", payload: {} }), result);
  }

  function validateRequest(request: CodingAgentRequest, workspace: CodexWorkspaceHandle): void {
    if (!configuration.dataClassifications.includes(request.disclosure.classification)) throw unsupportedCodexCapability("approval-unrepresentable", { classification: request.disclosure.classification });
    if (request.disclosure.requiredLocality === "local-only") throw unsupportedCodexCapability("network-policy-unenforceable");
    if (request.networkPolicy !== "denied") throw unsupportedCodexCapability("network-policy-unenforceable");
    if (request.commandPolicy.mode === "allow-listed") throw unsupportedCodexCapability("command-policy-untranslatable");
    if (request.commandPolicy.mode !== "none" && !request.capabilities.includes("run-commands")) throw invalidCodexRequest("command-policy-untranslatable");
    const operationMap = { "read-files": "workspace-read", "edit-files": "workspace-write", "run-commands": "command-execution", "run-tests": "command-execution", "git-commit": "git-commit" } as const;
    for (const capability of request.capabilities) if (!grantAllowsOperation(workspace.grant, operationMap[capability])) throw unsupportedCodexCapability("approval-unrepresentable", { capability });
    if (request.capabilities.includes("edit-files") && !configuration.sandboxMappings.includes("workspace-write")) throw unsupportedCodexCapability("approval-unrepresentable");
    if (request.approvalMode !== "never" && !configuration.approvalMappings.includes("on-request")) throw unsupportedCodexCapability("approval-unrepresentable");
  }

  function effortFor(request: CodingAgentRequest, model: string): CodexEffort {
    let effort = configuration.defaultEffort;
    for (const extension of request.extensions) {
      if (extension.namespace !== "codex" || extension.key !== "effort" || typeof extension.value !== "string") throw invalidCodexRequest("effort-not-permitted");
      effort = extension.value as CodexEffort;
    }
    const policy = configuration.models.find((entry) => entry.modelId === model);
    if (effort === null || policy === undefined || !policy.efforts.includes(effort)) throw invalidCodexRequest("effort-not-permitted");
    return effort;
  }

  function usageCeilingsFor(request: CodingAgentRequest): UsageCeilings {
    const tokens = request.budget?.tokens;
    const input = Math.min(configuration.ceilings.maxInputTokens, tokens?.maxInputTokens ?? tokens?.maxTotalTokens ?? configuration.ceilings.maxInputTokens);
    const output = Math.min(configuration.ceilings.maxOutputTokens, tokens?.maxOutputTokens ?? tokens?.maxTotalTokens ?? configuration.ceilings.maxOutputTokens);
    const configuredTotal = configuration.ceilings.maxInputTokens + configuration.ceilings.maxOutputTokens;
    return Object.freeze({ input, output, total: Math.min(configuredTotal, tokens?.maxTotalTokens ?? configuredTotal) });
  }

  return Object.freeze({
    kind: "coding-agent" as const,
    describe: () => descriptor,
    probe: ensureProbe,
    async health(): Promise<ProviderHealth> {
      if (closed) return parseProviderHealth({ status: "closed", checkedAt: clock.now().toISOString(), detailCode: null, activeOperations: active });
      const current = await ensureProbe();
      return parseProviderHealth({ status: current.status === "ready" ? "ready" : current.status === "incompatible" ? "degraded" : "unavailable", checkedAt: clock.now().toISOString(), detailCode: current.detailCode, activeOperations: active });
    },
    start,
    accountState: readAccount,
    async rateLimits(): Promise<CodexRateLimitSnapshot> {
      const connection = await telemetryConnection();
      try { return mapCodexRateLimits(await connection.request("account/rateLimits/read"), { clock, stalenessMs: configuration.capacityStalenessMs, source: "account/rateLimits/read" }); }
      catch (error) { if (error instanceof CodexRpcError && error.rpcCode === -32601) return Object.freeze({ status: "unsupported", windows: Object.freeze([]), resetCreditsAvailable: null, observedAt: clock.now().toISOString() }); throw error; }
      finally { await connection.close(); }
    },
    async accountUsage(): Promise<CodexAccountUsageSnapshot> {
      const account = await readAccount();
      if (account.kind === "api-key" || account.kind === "amazon-bedrock") return mapCodexAccountUsage(null, clock, account.kind);
      const connection = await telemetryConnection();
      try { return mapCodexAccountUsage(await connection.request("account/usage/read"), clock, account.kind); }
      catch (error) { if (error instanceof CodexRpcError && error.rpcCode === -32601) return mapCodexAccountUsage(null, clock, "api-key"); throw error; }
      finally { await connection.close(); }
    },
    async close(): Promise<void> { if (closed) return; closed = true; await Promise.allSettled([...cancelActive].map((cancel) => cancel())); },
  });
}

async function handleApproval(serverRequest: CodexWireRequest, request: CodingAgentRequest, state: TurnState, emit: (build: (base: EventBase) => CodingAgentEvent) => void, approvals: CodexApprovalPort, clock: CodexClock): Promise<unknown> {
  const params = rawRecord(serverRequest.params);
  if (params === null) return { decision: "decline" };
  const threadId = boundedId(params["threadId"]), turnId = boundedId(params["turnId"]), itemId = boundedId(params["itemId"]);
  const action = serverRequest.method === "item/commandExecution/requestApproval" ? "command-execution" : serverRequest.method === "item/fileChange/requestApproval" ? "file-change" : null;
  if (action === null || threadId === null || turnId === null || itemId === null || threadId !== state.threadId || turnId !== state.turnId) return { decision: "decline" };
  const risk = "mutating" as const;
  const subjectDigest = createHash("sha256").update(JSON.stringify({ threadId, turnId, itemId, action, command: boundedText(params["command"], 16_384), cwd: boundedText(params["cwd"], 1_024), grantRoot: boundedText(params["grantRoot"], 1_024) })).digest("hex");
  const approvalId = `approval-${String(serverRequest.id).replace(/[^A-Za-z0-9._:-]/g, "_")}`.slice(0, 128);
  emit((base) => ({ ...base, kind: "approval-requested", payload: { approvalId, summary: action === "command-execution" ? "Codex requested command execution approval." : "Codex requested file-change approval.", risk } }));
  let evidence: CodexApprovalEvidence | null = null;
  if (request.approvalMode !== "never") evidence = await approvals.evidence({ threadId, turnId, action, risk, subjectDigest });
  const exact = evidence !== null && evidence.approvalId === approvalId && evidence.threadId === threadId && evidence.turnId === turnId && evidence.action === action && evidence.risk === risk && evidence.subjectDigest === subjectDigest && new Date(evidence.expiresAt).valueOf() > clock.now().valueOf();
  const approved = exact && evidence!.decision === "approved";
  state.approvalDecisions.push(Object.freeze({ approvalId, decision: approved ? "approved" : "denied" }));
  return { decision: approved ? (evidence!.repeatedAction ? "acceptForSession" : "accept") : exact && evidence!.decision === "cancelled" ? "cancel" : "decline" };
}

function applyNotification(notification: CodexWireNotification, state: TurnState, ceilings: UsageCeilings, emit: (build: (base: EventBase) => CodingAgentEvent) => void, terminal: () => void): void {
  const params = rawRecord(notification.params); if (params === null) throw codexProtocolViolation("malformed-json");
  const scoped = ["turn/started", "turn/completed", "item/started", "item/completed", "item/agentMessage/delta", "turn/plan/updated", "thread/tokenUsage/updated", "error"];
  if (scoped.includes(notification.method)) {
    const threadId = boundedId(params["threadId"]); if (state.threadId !== null && threadId !== state.threadId) throw codexProtocolViolation("unknown-state-changing-method");
    const explicitTurn = boundedId(params["turnId"]); const turn = rawRecord(params["turn"]); const turnId = explicitTurn ?? boundedId(turn?.["id"]);
    if (state.turnId !== null && turnId !== null && turnId !== state.turnId) throw codexProtocolViolation("unknown-state-changing-method");
  }
  switch (notification.method) {
    case "turn/started": emit((base) => ({ ...base, kind: "status-update", payload: { message: "Codex turn started." } })); break;
    case "item/agentMessage/delta": {
      const delta = boundedText(params["delta"]); if (delta === null) throw codexProtocolViolation("malformed-json");
      for (let offset = 0; offset < delta.length; offset += 32_000) { const text = delta.slice(offset, offset + 32_000); emit((base) => ({ ...base, kind: "output-chunk", payload: { channel: "stdout", text, artifactId: null } })); }
      break;
    }
    case "turn/plan/updated": emit((base) => ({ ...base, kind: "status-update", payload: { message: "Codex updated its plan." } })); break;
    case "item/started": {
      const item = rawRecord(params["item"]); const type = boundedText(item?.["type"], 64); const itemId = boundedId(item?.["id"]);
      if (type === "commandExecution" && itemId !== null) {
        const command = boundedText(item?.["command"], 16_384); if (command === null) throw codexProtocolViolation("malformed-json");
        const invocation = parseToolInvocation({ toolCallId: itemId, toolName: "codex-command", arguments: { command } });
        state.toolCalls += 1; emit((base) => ({ ...base, kind: "tool-call-proposed", payload: { invocation } })); emit((base) => ({ ...base, kind: "tool-call-started", payload: { toolCallId: itemId, toolName: "codex-command" } }));
      } else if (type === "fileChange") {
        for (const raw of Array.isArray(item?.["changes"]) ? item!["changes"].slice(0, 4_096) : []) {
          const change = rawRecord(raw); const path = boundedText(change?.["path"], 1_024); const kind = rawRecord(change?.["kind"]); const kindType = boundedText(kind?.["type"], 16);
          if (path !== null && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..")) emit((base) => ({ ...base, kind: "file-change-proposed", payload: { change: { path, changeKind: kindType === "add" ? "added" : kindType === "delete" ? "deleted" : rawRecord(kind)?.["move_path"] === null ? "modified" : "renamed" } } }));
        }
      }
      break;
    }
    case "thread/tokenUsage/updated": {
      const total = rawRecord(rawRecord(params["tokenUsage"])?.["total"]); const next = parseCodexTokenUsage(total);
      if (next === null || reconcileCodexUsage(state.usage, next) === null) throw codexProtocolViolation("unsafe-number");
      state.usage = next; const usage = toProviderCodexUsage(next, state.toolCalls); emit((base) => ({ ...base, kind: "usage-update", payload: { usage } }));
      const input = next.inputTokens + next.cacheWriteInputTokens;
      if (input > ceilings.input || next.outputTokens > ceilings.output || input + next.outputTokens > ceilings.total) {
        state.error = codexUsageCeilingExceeded({ inputTokens: input, outputTokens: next.outputTokens }); terminal();
      }
      break;
    }
    case "warning": case "guardianWarning": case "configWarning": state.warnings.push("Codex reported a bounded warning."); break;
    case "error": { const failure = rawRecord(params["error"]); state.error = mapCodexTurnError(failure?.["codexErrorInfo"]); break; }
    case "model/rerouted": state.error = codexProtocolViolation("model-substituted"); terminal(); break;
    case "turn/completed": {
      const turn = rawRecord(params["turn"]); const status = turn?.["status"];
      if (status !== "completed" && status !== "interrupted" && status !== "failed") throw codexProtocolViolation("malformed-json");
      state.terminalStatus = status; if (status === "failed" && state.error === null) state.error = mapCodexTurnError(rawRecord(turn?.["error"])?.["codexErrorInfo"]); terminal(); break;
    }
  }
}

function mapCodexTurnError(info: unknown): ProviderError {
  if (info === "contextWindowExceeded") return codexContextLimit();
  if (info === "usageLimitExceeded" || info === "sessionBudgetExceeded") return codexRateLimited();
  if (info === "serverOverloaded") return codexOverloaded();
  if (info === "unauthorized") return codexAuthenticationFailed();
  if (info === "badRequest" || info === "cyberPolicy") return codexContentRejected();
  const record = rawRecord(info);
  if (record !== null && ["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"].some((key) => key in record)) return codexNetworkFailure();
  return codexInternalFailure();
}

function mapRpcError(error: CodexRpcError): ProviderError {
  if (error.rpcCode === -32001) return codexOverloaded(error.retryAfterMs);
  if (error.httpStatus === 401 || error.httpStatus === 403) return codexAuthenticationFailed({ httpStatus: error.httpStatus });
  if (error.httpStatus === 429) return codexRateLimited(error.retryAfterMs);
  if (error.httpStatus !== null && error.httpStatus >= 500) return codexNetworkFailure({ httpStatus: error.httpStatus });
  return codexProtocolViolation("malformed-json", { rpcCode: error.rpcCode });
}
