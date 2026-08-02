/**
 * The Claude Code coding-agent adapter.
 *
 * The adapter validates a provider-neutral request, resolves the managed
 * workspace, probes the installed CLI, translates the request into the
 * narrowest safe invocation, streams and validates the CLI's machine-readable
 * output, reconciles the workspace against what actually changed, and settles
 * exactly one terminal outcome.
 *
 * Two rules shape everything below. The workspace is authoritative, so nothing
 * Claude says about files, commits, or tests is believed without evidence. And
 * the operation settles once, so every path — success, refusal, failure,
 * cancellation, deadline, malformed output — runs reconciliation and produces
 * a terminal event that agrees with the result promise.
 */

import {
  ProviderError,
  UNKNOWN_COST,
  ZERO_PROVIDER_USAGE,
  createOperationController,
  isDeadlineExpired,
  parseCodingAgentRequest,
  parseProviderDescriptor,
  parseProviderHealth,
  parseToolInvocation,
  toProviderError,
  type CodingAgentEvent,
  type CodingAgentOperation,
  type CodingAgentProvider,
  type CodingAgentRequest,
  type CodingAgentResult,
  type ChangedFileSummary,
  type Clock,
  type ProviderDescriptor,
  type ProviderHealth,
  type ProviderObserver,
  type ProviderOperationId,
  type ProviderUsage,
  type StartOperationOptions,
} from "@ai-dev-os/providers";
import type { ArtifactId } from "@ai-dev-os/domain";
import type { EnvironmentBinding, ProcessResult } from "@ai-dev-os/process-broker";
import {
  CLAUDE_PROVIDER_ID,
  claudeConfigurationFingerprint,
  isDistributableAuthentication,
  type ClaudeAdapterConfiguration,
  type ClaudeEffortLevel,
} from "./config.js";
import { CLAUDE_EFFORT_LEVELS } from "./config.js";
import type { ClaudeCompatibilityProfile } from "./compatibility.js";
import { probeClaudeCli, type ClaudeProbeResult } from "./discovery.js";
import {
  authenticationError,
  cancelledError,
  contextLimitError,
  deadlineExceededError,
  internalFailureError,
  invalidRequestError,
  malformedResponseError,
  modelUnavailableError,
  policyDeniedError,
  protocolViolationError,
  providerClosedError,
  quotaExceededError,
  rateLimitedError,
  timeoutError,
  unsupportedCapabilityError,
  workspaceUnavailableError,
  classifyRetryCategory,
  errorForDetailCode,
  type ClaudeDetailCode,
} from "./errors.js";
import { buildInvocation, encodeInstructions, planTools, type ClaudeToolPlan } from "./invocation.js";
import { createNdjsonDecoder } from "./ndjson.js";
import {
  notifyClaudeObserver,
  type ClaudeObservation,
  type ClaudeObserver,
  type ClaudeReconciliationOutcome,
} from "./observability.js";
import {
  denyingArtifactSink,
  permissiveDevelopmentPolicy,
  systemClaudeScheduler,
  type ClaudeArtifactCategory,
  type ClaudeArtifactSink,
  type ClaudeExecutionPort,
  type ClaudeScheduler,
  type ClaudeSessionPolicyDecision,
  type ClaudeSessionPolicyPort,
  type ClaudeTestReport,
  type ClaudeUuidGenerator,
  type ClaudeWorkspaceHandle,
  type ClaudeWorkspacePort,
} from "./ports.js";
import { reconcileWorkspace, compareClaimedChanges, type ReconciliationResult } from "./reconciliation.js";
import {
  mintResumeToken,
  resumeFailureError,
  sessionPersistenceAllowed,
  verifyResumeToken,
  type ClaudeSessionMetadata,
} from "./session.js";
import {
  UNKNOWN_CAPACITY,
  ageCapacitySnapshot,
  ingestStatusSnapshot,
  type ClaudeCapacitySnapshot,
} from "./capacity.js";
import {
  ZERO_CLAUDE_USAGE,
  mapCost,
  reconcileUsage,
  sumModelUsage,
  toProviderUsage,
  type ClaudeCostMapping,
} from "./usage.js";
import { RESULT_SUBTYPES, parseWireLine, type ClaudeWireRecord } from "./wire.js";
import { brokerFailure, failureForDetail as mapDetailFailure } from "./failure-mapping.js";

const MAX_OUTPUT_CHUNK_CHARS = 8_192;
const MAX_COMMAND_LOG_ENTRIES = 512;
const MAX_TRACKED_CLAIMED_PATHS = 512;

export interface ClaudeBackendIdentity {
  readonly backendId: string;
  readonly securityClass: string;
  /**
   * Whether the composition layer accepts that agent commands run under this
   * backend's actual containment. No shipped backend contains anything, so
   * setting this true is an explicit development decision, and every result
   * from such a session carries the uncontained-execution warning.
   */
  readonly commandExecutionAllowed: boolean;
}

export interface CreateClaudeCodeProviderOptions {
  readonly configuration: ClaudeAdapterConfiguration;
  readonly execution: ClaudeExecutionPort;
  readonly workspaces: ClaudeWorkspacePort;
  readonly artifacts?: ClaudeArtifactSink;
  readonly policy?: ClaudeSessionPolicyPort;
  readonly scheduler?: ClaudeScheduler;
  readonly uuid?: ClaudeUuidGenerator;
  readonly observer?: ProviderObserver;
  readonly claudeObserver?: ClaudeObserver;
  readonly backend?: ClaudeBackendIdentity;
  /**
   * Secret-backed environment bindings. They carry only reference
   * fingerprints; values are resolved by the broker's secret resolver after
   * policy approval, immediately before process creation.
   */
  readonly secretEnvironment?: readonly EnvironmentBinding[];
  /**
   * Explicit opt-in for the personal, local development canary. Without it a
   * personal installed-CLI login is refused, because routing a subscription
   * credential on a user's behalf is outside Anthropic's published boundary.
   */
  readonly personalDevelopmentCanaryOptIn?: boolean;
  readonly projectId?: string;
}

export interface ClaudeCodeProvider extends CodingAgentProvider {
  /** Runs (or returns the cached result of) the CLI version probe. */
  probe(): Promise<ClaudeProbeResult>;
  compatibility(): ClaudeCompatibilityProfile | null;
  capacity(): ClaudeCapacitySnapshot;
  /** Ingests a host-collected Claude status document. Consumes no model usage. */
  observeStatusSnapshot(document: string): ClaudeCapacitySnapshot;
  readonly configurationFingerprint: string;
}

const UNKNOWN_BACKEND: ClaudeBackendIdentity = Object.freeze({
  backendId: "unknown",
  securityClass: "unavailable",
  commandExecutionAllowed: false,
});

export function createClaudeCodeProvider(
  options: CreateClaudeCodeProviderOptions,
): ClaudeCodeProvider {
  const configuration = options.configuration;
  const scheduler = options.scheduler ?? systemClaudeScheduler;
  const clock: Clock = Object.freeze({ now: (): Date => scheduler.now() });
  const artifacts = options.artifacts ?? denyingArtifactSink;
  const policy = options.policy ?? permissiveDevelopmentPolicy;
  const backend = options.backend ?? UNKNOWN_BACKEND;
  const uuid = options.uuid ?? defaultUuid;
  const projectId = options.projectId ?? "unknown-project";
  const fingerprint = claudeConfigurationFingerprint(configuration);

  let closed = false;
  let probeResult: ClaudeProbeResult | null = null;
  let probeInFlight: Promise<ClaudeProbeResult> | null = null;
  let capacitySnapshot: ClaudeCapacitySnapshot = UNKNOWN_CAPACITY;
  let operationCounter = 0;
  const activeCancels = new Set<(reason: "provider-closed") => Promise<void>>();
  const pumps = new Set<Promise<void>>();

  const descriptor: ProviderDescriptor = parseProviderDescriptor({
    schemaVersion: 1,
    providerId: CLAUDE_PROVIDER_ID,
    instanceId: configuration.instanceId,
    kind: "coding-agent",
    displayName: "Claude Code",
    locality: "cloud",
    // Retention depends on the deployment's Anthropic agreement; the honest
    // default is that a cloud provider may retain, and the policy layer
    // decides whether that is acceptable for a classification.
    retainsData: true,
    trainsOnInputs: false,
    supportedClassifications: configuration.supportedClassifications,
    capabilities: {
      streaming: true,
      structuredOutput: false,
      toolCalling: true,
      imageInput: false,
      repositoryEditing: true,
      commandExecution: backend.commandExecutionAllowed,
      // Claude's own control-plane connection is not agent network access.
      networkAccess: false,
      resumability: configuration.sessionPersistence !== "never",
      // The shipped backends cannot prove a process tree is gone, so
      // guaranteed cancellation would be a claim this stage cannot support.
      cancellation: "best-effort",
      deadlineEnforcement: true,
      usageReporting: true,
      pricingAvailable: isDistributableAuthentication(configuration.authenticationMode),
    },
  });

  async function ensureProbe(): Promise<ClaudeProbeResult> {
    if (probeResult !== null) {
      return probeResult;
    }
    if (probeInFlight !== null) {
      return await probeInFlight;
    }
    probeInFlight = (async (): Promise<ClaudeProbeResult> => {
      const result = await probeClaudeCli({
        configuration,
        execution: options.execution,
        trace: { traceId: `probe-${configuration.instanceId}`, runId: null, taskId: null, taskRunId: null },
        workspaceId: "probe",
        probedAt: clock.now().toISOString(),
      });
      probeResult = result;
      notifyClaudeObserver(options.claudeObserver, {
        kind: "probe",
        status: result.status,
        tier: result.profile.tier,
        version: result.version,
        platform: result.platform,
        architecture: result.architecture,
        executableResolved: result.executableResolved,
        digestPinned: result.expectedDigestHex !== null,
        detailCode: result.detailCode,
      });
      return result;
    })();
    try {
      return await probeInFlight;
    } finally {
      probeInFlight = null;
    }
  }

  async function start(
    rawRequest: CodingAgentRequest,
    startOptions: StartOperationOptions = {},
  ): Promise<CodingAgentOperation> {
    if (closed) {
      throw providerClosedError();
    }

    const request = parseRequest(rawRequest);
    assertExtensionsUnderstood(request);

    if (!configuration.supportedClassifications.includes(request.disclosure.classification)) {
      throw policyDeniedError("policy-denied", {
        classification: request.disclosure.classification,
      });
    }
    if (isDeadlineExpired(request.deadline, clock.now())) {
      throw deadlineExceededError({ phase: "pre-start" });
    }
    if (
      configuration.authenticationMode === "personal-local-cli-login" &&
      options.personalDevelopmentCanaryOptIn !== true
    ) {
      throw authenticationError("authentication-unavailable", { mode: configuration.authenticationMode });
    }

    const workspace = await options.workspaces.resolve(request.workspaceId);
    if (workspace === null) {
      throw workspaceUnavailableError("workspace-missing", { workspaceId: request.workspaceId });
    }
    if (!workspace.lease.isValid()) {
      throw workspaceUnavailableError("workspace-lease-invalid", { workspaceId: request.workspaceId });
    }
    if (!workspace.isManagedPrivateWorktree) {
      throw workspaceUnavailableError("workspace-is-source-tree", { workspaceId: request.workspaceId });
    }
    if (request.baseRevision !== null && request.baseRevision !== workspace.baseRevision) {
      throw workspaceUnavailableError("workspace-lineage-mismatch", { workspaceId: request.workspaceId });
    }

    // Policy is evaluated before any process runs, including the version
    // probe. A denied session must not cause the adapter to start the Claude
    // executable at all, and must not reach the point where the broker would
    // resolve a secret binding.
    const decision = await Promise.resolve(
      policy.evaluateSession({
        instanceId: configuration.instanceId,
        projectId: workspace.projectId,
        workspaceId: request.workspaceId,
        requestId: request.requestId,
        classification: request.disclosure.classification,
        capabilities: request.capabilities,
        commandPolicyMode: request.commandPolicy.mode,
        networkPolicy: request.networkPolicy,
        approvalMode: request.approvalMode,
        continuationRequested: request.resumeToken !== null,
        configurationFingerprint: fingerprint,
      }),
    );
    if (decision.outcome === "denied") {
      throw policyDeniedError("policy-denied", { reason: decision.reasonCode ?? "denied" });
    }
    if (decision.outcome === "conditional") {
      // Non-interactive execution can never resolve an outstanding approval by
      // prompting, so an unmet condition terminates instead of waiting.
      throw new ProviderError(
        "AUTHORIZATION_FAILED",
        "This Claude Code operation has an outstanding approval requirement.",
        { detailCode: "approval-outstanding" satisfies ClaudeDetailCode, reason: decision.reasonCode ?? "conditional" },
      );
    }

    const probe = await ensureProbe();
    if (probe.status !== "compatible") {
      throw probeFailureError(probe);
    }

    const model = resolveModel(request);
    const effort = resolveEffort(request);

    const toolOutcome = planTools({
      capabilities: request.capabilities,
      commandPolicy: request.commandPolicy,
      networkPolicy: request.networkPolicy,
      grant: workspace.grant,
      commandExecutionAllowed: backend.commandExecutionAllowed,
    });
    if (!toolOutcome.ok) {
      throw toolOutcome.detailCode === "policy-denied"
        ? policyDeniedError(toolOutcome.detailCode)
        : unsupportedCapabilityError(toolOutcome.detailCode);
    }
    const plan = toolOutcome.plan;

    const persistSession = sessionPersistenceAllowed({
      continuationRequested: request.resumeToken !== null,
      configuredPolicy: configuration.sessionPersistence,
      policyAllows: decision.sessionPersistenceAllowed,
      authenticationSupportsPersistence: isDistributableAuthentication(configuration.authenticationMode),
      retentionAllowed: request.disclosure.retentionAllowed,
    });

    let resumeSessionId: string | null = null;
    if (request.resumeToken !== null) {
      const verification = verifyResumeToken({
        token: request.resumeToken,
        instanceId: configuration.instanceId,
        projectId: workspace.projectId,
        workspaceId: request.workspaceId,
        snapshotId: workspace.snapshotId,
        model,
        effort,
        configurationFingerprint: fingerprint,
        now: clock.now(),
        sessionPersistenceAllowed: persistSession,
      });
      if (!verification.ok) {
        throw resumeFailureError(verification.detailCode);
      }
      resumeSessionId = verification.binding.sessionId;
    }

    const sessionId = resumeSessionId ?? uuid();
    const invocation = buildInvocation({
      configuration,
      capabilities: probe.profile.capabilities,
      plan,
      model,
      effort,
      sessionId,
      resumeSessionId,
      persistSession,
      budgetMicros: resolveBudgetMicros(request),
      maxTurns: configuration.maxTurns,
    });
    const stdin = encodeInstructions(request, 1_000_000);

    operationCounter += 1;
    const operationId = `op-claude-${operationCounter.toString().padStart(6, "0")}` as ProviderOperationId;

    const controller = createOperationController<CodingAgentEvent, CodingAgentResult>({
      operationId,
      clock,
      trace: request.trace,
      buildCancelledEvent: (base, reason) => ({ ...base, kind: "operation-cancelled", payload: { reason } }),
    });

    const abort = new AbortController();
    controller.onCancel(() => {
      abort.abort();
    });
    if (startOptions.signal !== undefined) {
      const signal = startOptions.signal;
      if (signal.aborted) {
        void controller.operation.cancel("caller-aborted");
      } else {
        signal.addEventListener("abort", () => {
          void controller.operation.cancel("caller-aborted");
        }, { once: true });
      }
    }

    const cancelForClose = (reason: "provider-closed"): Promise<void> =>
      controller.operation.cancel(reason);
    activeCancels.add(cancelForClose);

    controller.emit((base) => ({
      ...base,
      kind: "operation-started",
      payload: { workspaceId: request.workspaceId },
    }));

    notifyClaudeObserver(options.claudeObserver, {
      kind: "operation-started",
      requestedModel: model,
      requestedEffort: effort,
      permissionProfile: plan.bashPermitted
        ? "edit-and-command"
        : plan.writePermitted
          ? "edit"
          : "read-only",
      builtInToolCount: plan.tools.length,
      deniedToolCount: plan.disallowedTools.length,
      backendId: backend.backendId,
      securityClass: backend.securityClass,
      sessionPersisted: persistSession,
      resumed: resumeSessionId !== null,
    });

    const running = runOperation({
      request,
      workspace,
      controller,
      abort,
      invocation,
      stdin,
      model,
      effort,
      plan,
      decision,
      persistSession,
      sessionId,
      resumed: resumeSessionId !== null,
      startedAt: clock.now(),
    })
      .catch(() => undefined)
      .finally(() => {
        activeCancels.delete(cancelForClose);
        pumps.delete(running);
      });
    pumps.add(running);

    return controller.operation;
  }

  // -- the operation body ---------------------------------------------------

  interface OperationContext {
    readonly request: CodingAgentRequest;
    readonly workspace: ClaudeWorkspaceHandle;
    readonly controller: ReturnType<
      typeof createOperationController<CodingAgentEvent, CodingAgentResult>
    >;
    readonly abort: AbortController;
    readonly invocation: ReturnType<typeof buildInvocation>;
    readonly stdin: Uint8Array;
    readonly model: string | null;
    readonly effort: ClaudeEffortLevel | null;
    readonly plan: ClaudeToolPlan;
    readonly decision: ClaudeSessionPolicyDecision;
    readonly persistSession: boolean;
    readonly sessionId: string;
    readonly resumed: boolean;
    readonly startedAt: Date;
  }

  async function runOperation(context: OperationContext): Promise<void> {
    const { controller, request, workspace } = context;
    const state = createStreamState();
    let failure: ProviderError | null = null;
    let deadlineFired = false;

    const emit = (build: (base: EventBase) => CodingAgentEvent): void => {
      if (!controller.isTerminal) {
        controller.emit(build);
      }
    };

    // The adapter enforces the deadline on the injected scheduler in addition
    // to the broker's own wall-clock quota, so a deadline is observable in
    // virtual time and does not depend on the backend noticing first.
    const deadlineMs = resolveDeadlineMs(request, clock.now(), configuration.operationDeadlineMs);
    const deadlineHandle = scheduler.delay(deadlineMs);
    void deadlineHandle.promise.then(() => {
      if (!controller.isTerminal) {
        deadlineFired = true;
        failure = deadlineExceededError({ deadlineMs });
        context.abort.abort();
      }
    });

    let processResult: ProcessResult | null = null;
    let executionError: unknown = null;

    try {
      processResult = await options.execution.execute({
        kind: "session",
        args: context.invocation.args,
        stdin: context.stdin,
        deadline: request.deadline,
        wallClockMs: Math.min(configuration.processDeadlineMs, Math.max(1_000, deadlineMs)),
        outputBytes: configuration.maxOutputBytes,
        environment: options.secretEnvironment ?? [],
        workspaceId: request.workspaceId,
        trace: {
          traceId: request.trace.traceId,
          runId: request.trace.runId,
          taskId: request.trace.taskId,
          taskRunId: request.trace.taskRunId,
        },
        signal: context.abort.signal,
        onOutput: (event) => {
          if (event.stream === "stderr") {
            state.appendDiagnostics(event.chunk, configuration.maxDiagnosticBytes);
            return;
          }
          if (state.failed !== null) {
            return;
          }
          const outcome = state.decoder.push(event.chunk);
          if (!outcome.ok) {
            state.failed = outcome.detailCode;
            context.abort.abort();
            return;
          }
          for (const line of outcome.lines) {
            if (!consumeLine(context, state, line, emit)) {
              context.abort.abort();
              return;
            }
          }
        },
      });
    } catch (error) {
      executionError = error;
    } finally {
      deadlineHandle.cancel();
    }

    if (state.failed === null && processResult !== null) {
      const tail = state.decoder.finish();
      if (!tail.ok) {
        state.failed = tail.detailCode;
      } else {
        for (const line of tail.lines) {
          if (!consumeLine(context, state, line, emit)) {
            break;
          }
        }
      }
    }

    // The terminal outcome is decided before reconciliation so reconciliation
    // can still run on a failing path and report partial edits.
    if (failure === null) {
      failure = classifyOutcome({
        controller,
        state,
        processResult,
        executionError,
        deadlineFired,
        model: context.model,
      });
    }

    const cancelled = controller.cancellationReason !== null || context.abort.signal.aborted && failure === null;
    const reconciliation = await reconcileWorkspace({
      workspace,
      grant: workspace.grant,
      allowedPathPrefixes: request.fileAccess.allowedPathPrefixes,
      maxChangedFiles: request.maxChangedFiles,
      maxProducedBytes: request.maxProducedBytes,
      editingGranted: request.capabilities.includes("edit-files"),
    });

    if (failure === null && !reconciliation.clean) {
      failure = reconciliationFailure(reconciliation);
    }

    await settle({
      context,
      state,
      processResult,
      reconciliation,
      failure,
      cancelled,
      deadlineFired,
    });
  }

  // -- streaming translation ------------------------------------------------

  type EventBase = Parameters<Parameters<OperationContext["controller"]["emit"]>[0]>[0];

  interface StreamState {
    readonly decoder: ReturnType<typeof createNdjsonDecoder>;
    failed: ClaudeDetailCode | null;
    terminal: Extract<ClaudeWireRecord, { type: "result" }> | null;
    observedSessionId: string | null;
    observedModel: string | null;
    usage: typeof ZERO_CLAUDE_USAGE;
    toolCalls: number;
    turns: number;
    retryAfterMs: number | null;
    retryDetail: ClaudeDetailCode | null;
    readonly claimedPaths: Set<string>;
    readonly commandLog: string[];
    readonly warningCounts: Map<string, number>;
    diagnostics: Buffer;
    appendDiagnostics(chunk: Uint8Array, maxBytes: number): void;
  }

  function createStreamState(): StreamState {
    return {
      decoder: createNdjsonDecoder({
        maxRecordBytes: configuration.maxRecordBytes,
        maxStreamBytes: configuration.maxStreamBytes,
        maxRecordCount: configuration.maxRecordCount,
      }),
      failed: null,
      terminal: null,
      observedSessionId: null,
      observedModel: null,
      usage: ZERO_CLAUDE_USAGE,
      toolCalls: 0,
      turns: 0,
      retryAfterMs: null,
      retryDetail: null,
      claimedPaths: new Set<string>(),
      commandLog: [],
      warningCounts: new Map<string, number>(),
      diagnostics: Buffer.alloc(0),
      appendDiagnostics(chunk: Uint8Array, maxBytes: number): void {
        if (this.diagnostics.byteLength >= maxBytes) {
          return;
        }
        const room = maxBytes - this.diagnostics.byteLength;
        const slice = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
        this.diagnostics = Buffer.concat([this.diagnostics, Buffer.from(slice)]);
      },
    };
  }

  /** Returns false when the stream must stop. */
  function consumeLine(
    context: OperationContext,
    state: StreamState,
    line: string,
    emit: (build: (base: EventBase) => CodingAgentEvent) => void,
  ): boolean {
    const outcome = parseWireLine(line);
    if (!outcome.ok) {
      state.failed = outcome.detailCode;
      return false;
    }
    for (const record of outcome.records) {
      if (state.terminal !== null && record.type !== "ignorable" && record.type !== "partial") {
        state.failed = "record-after-terminal";
        return false;
      }
      if (!applyRecord(context, state, record, emit)) {
        return false;
      }
    }
    return true;
  }

  function applyRecord(
    context: OperationContext,
    state: StreamState,
    record: ClaudeWireRecord,
    emit: (build: (base: EventBase) => CodingAgentEvent) => void,
  ): boolean {
    switch (record.type) {
      case "init": {
        if (state.observedSessionId !== null && state.observedSessionId !== record.sessionId) {
          state.failed = "session-id-mismatch";
          return false;
        }
        if (record.sessionId !== context.invocation.sessionId) {
          state.failed = "session-id-mismatch";
          return false;
        }
        state.observedSessionId = record.sessionId;
        state.observedModel = record.model;
        if (record.mcpServerNames.length > 0 || record.pluginNames.length > 0) {
          // Safe mode plus strict MCP configuration should have left both
          // empty. A non-empty list means an ambient source loaded anyway.
          state.failed = "unknown-state-changing-record";
          return false;
        }
        if (context.model !== null && record.model !== null && record.model !== context.model) {
          if (!modelMatches(context.model, record.model)) {
            state.failed = "model-substituted";
            return false;
          }
        }
        emit((base) => ({
          ...base,
          kind: "status-update",
          payload: { message: `session started with model ${record.model ?? "unreported"}` },
        }));
        return true;
      }
      case "retry": {
        state.retryAfterMs = record.retryDelayMs;
        state.retryDetail = classifyRetryCategory(record.errorCategory);
        emit((base) => ({
          ...base,
          kind: "warning",
          payload: {
            message: `provider retry ${record.attempt} of ${record.maxRetries} (${record.errorCategory})`,
          },
        }));
        return true;
      }
      case "assistant-text": {
        state.turns += 1;
        if (state.turns > configuration.maxTurns) {
          state.failed = "turn-limit-reached";
          return false;
        }
        const text = record.text.slice(0, MAX_OUTPUT_CHUNK_CHARS);
        emit((base) => ({
          ...base,
          kind: "output-chunk",
          payload: { channel: "stdout", text, artifactId: null },
        }));
        return true;
      }
      case "assistant-thinking":
        // Hidden reasoning is never surfaced and never mixed into answer,
        // status, command, or diagnostic text.
        return true;
      case "tool-use": {
        state.toolCalls += 1;
        if (state.commandLog.length < MAX_COMMAND_LOG_ENTRIES) {
          state.commandLog.push(
            `${record.toolName}\t${record.targetPath ?? "-"}\t${record.argumentKeys.join(",")}`,
          );
        }
        emit((base) => ({
          ...base,
          kind: "tool-call-started",
          payload: { toolCallId: record.toolUseId, toolName: normalizeToolName(record.toolName) },
        }));
        if (record.targetPath !== null) {
          if (state.claimedPaths.size < MAX_TRACKED_CLAIMED_PATHS) {
            state.claimedPaths.add(record.targetPath);
          }
          if (isReadTool(record.toolName)) {
            emit((base) => ({
              ...base,
              kind: "workspace-read",
              payload: { path: record.targetPath as string },
            }));
          } else if (isWriteTool(record.toolName)) {
            emit((base) => ({
              ...base,
              kind: "file-change-proposed",
              payload: { change: { path: record.targetPath as string, changeKind: "modified" } },
            }));
          }
        }
        return true;
      }
      case "tool-result":
        return true;
      case "result": {
        if (state.terminal !== null) {
          state.failed = "duplicate-terminal";
          return false;
        }
        if (
          record.sessionId !== null &&
          record.sessionId !== context.invocation.sessionId
        ) {
          state.failed = "session-id-mismatch";
          return false;
        }
        const reported = record.usage ?? sumModelUsage(record.modelUsage);
        const reconciled = reconcileUsage(state.usage, reported);
        if (!reconciled.ok) {
          state.failed = reconciled.reason === "negative" ? "negative-usage" : "non-monotonic-usage";
          return false;
        }
        state.usage = reconciled.counts;
        if (record.numTurns !== null && record.numTurns > configuration.maxTurns) {
          state.failed = "turn-limit-reached";
          state.terminal = record;
          return false;
        }
        for (const entry of record.modelUsage) {
          if (context.model !== null && !modelMatches(context.model, entry.model)) {
            state.failed = "model-substituted";
            return false;
          }
          state.observedModel = state.observedModel ?? entry.model;
        }
        state.terminal = record;
        return true;
      }
      case "partial":
      case "compact-boundary":
        return true;
      case "ignorable":
        return true;
      case "unknown-compatible": {
        const count = (state.warningCounts.get(record.subtype) ?? 0) + 1;
        state.warningCounts.set(record.subtype, count);
        if (count === 1) {
          emit((base) => ({
            ...base,
            kind: "warning",
            payload: { message: `ignored unrecognized informational record: ${record.subtype}` },
          }));
        }
        return true;
      }
    }
  }

  // -- terminal classification ----------------------------------------------

  function classifyOutcome(input: {
    readonly controller: OperationContext["controller"];
    readonly state: StreamState;
    readonly processResult: ProcessResult | null;
    readonly executionError: unknown;
    readonly deadlineFired: boolean;
    readonly model: string | null;
  }): ProviderError | null {
    const { state, processResult } = input;

    if (state.failed !== null) {
      return failureForDetail(state.failed, state.retryAfterMs, input.model);
    }
    if (input.executionError !== null) {
      return brokerFailure(input.executionError);
    }
    if (processResult === null) {
      return internalFailureError("internal");
    }

    switch (processResult.state) {
      case "cancelled":
        return null; // The controller's cancellation is the terminal outcome.
      case "deadline-exceeded":
        return deadlineExceededError({ state: processResult.state });
      case "quota-exceeded":
        return malformedResponseError("stream-oversized", { state: processResult.state });
      case "lease-expired":
        return workspaceUnavailableError("workspace-lease-invalid");
      case "backend-lost":
        return internalFailureError("process-spawn-failed");
      default:
        break;
    }

    const terminal = state.terminal;
    if (terminal === null) {
      // A zero exit is transport success only. Without the documented terminal
      // result record there is no evidence the task completed at all.
      return malformedResponseError("missing-terminal", {
        exitCode: processResult.exitCode,
        succeeded: processResult.succeeded,
      });
    }

    if (!terminal.isError) {
      if (!processResult.succeeded) {
        return protocolViolationError("result-contradiction", { exitCode: processResult.exitCode });
      }
      return null;
    }

    const mapped = RESULT_SUBTYPES.get(terminal.subtype);
    // A retry event that named the failure category is more specific than the
    // generic execution-error subtype, so it is preferred where the subtype
    // says only "something went wrong during the run".
    const generic = mapped === undefined || mapped === "process-nonzero-exit";
    if (generic && state.retryDetail !== null) {
      return errorForDetailCode(state.retryDetail, state.retryAfterMs);
    }
    if (mapped !== undefined && mapped !== null) {
      return failureForDetail(mapped, state.retryAfterMs, input.model);
    }
    return malformedResponseError("process-nonzero-exit", {
      subtype: terminal.subtype,
      exitCode: processResult.exitCode,
    });
  }

  function failureForDetail(
    detailCode: ClaudeDetailCode,
    retryAfterMs: number | null,
    model: string | null,
  ): ProviderError {
    return mapDetailFailure({ detailCode, retryAfterMs, model, maxTurns: configuration.maxTurns });
  }

  function reconciliationFailure(result: ReconciliationResult): ProviderError {
    if (result.unavailable) {
      return workspaceUnavailableError("workspace-missing");
    }
    const first = result.violations[0];
    const detail = first?.detailCode ?? "reconciliation-path-violation";
    return new ProviderError(
      "POLICY_DENIED",
      "The managed workspace contains changes this operation was not authorized to make.",
      {
        detailCode: detail,
        violationCount: result.violations.length,
        violatedPathCount: result.violations.reduce((total, entry) => total + entry.count, 0),
      },
    );
  }

  // -- settlement -----------------------------------------------------------

  async function settle(input: {
    readonly context: OperationContext;
    readonly state: StreamState;
    readonly processResult: ProcessResult | null;
    readonly reconciliation: ReconciliationResult;
    readonly failure: ProviderError | null;
    readonly cancelled: boolean;
    readonly deadlineFired: boolean;
  }): Promise<void> {
    const { context, state, reconciliation } = input;
    const { controller, request, workspace } = context;

    if (controller.isTerminal) {
      // Cancellation already settled the operation. Reconciliation still ran,
      // so a partial edit left behind is not lost, but no further event may be
      // emitted after a terminal event.
      emitTerminalObservation(input, "cancelled", reconciliation, null);
      return;
    }

    const emit = (build: (base: EventBase) => CodingAgentEvent): void => {
      if (!controller.isTerminal) {
        controller.emit(build);
      }
    };

    const artifactsWritten = new Map<ClaudeArtifactCategory, ArtifactId>();
    // Local artifact writes are governed by the Stage 6 policy decision.
    // `disclosure.retentionAllowed` is the provider-side retention verdict and
    // gates session persistence instead (see sessionPersistenceAllowed).
    const persistenceAllowed = context.decision.artifactPersistenceAllowed;
    const diagnosticsAllowed =
      context.decision.diagnosticRetentionAllowed && request.disclosure.loggingAllowed;

    // Approvals: a non-interactive denial is the resolution of an approval
    // request, not a prompt. Each denial is reported once and answered once.
    const approvalDecisions: { readonly approvalId: string; readonly decision: "approved" | "denied" }[] = [];
    const denials = state.terminal?.permissionDenials ?? [];
    for (const [index, denial] of denials.slice(0, 64).entries()) {
      const approvalId = `approval-${index + 1}`;
      const approved = context.decision.approvedToolNames.includes(denial.toolName);
      emit((base) => ({
        ...base,
        kind: "tool-call-proposed",
        payload: {
          invocation: parseToolInvocation({
            toolCallId: denial.toolUseId ?? `denied-${index + 1}`,
            toolName: normalizeToolName(denial.toolName),
            // Argument key names only. Values are never surfaced.
            arguments: { redacted: true, argumentKeys: [...denial.argumentKeys] },
          }),
        },
      }));
      emit((base) => ({
        ...base,
        kind: "approval-requested",
        payload: {
          approvalId,
          summary: `tool ${denial.toolName} requires an approval this session does not carry`,
          risk: isWriteTool(denial.toolName) || denial.toolName === "Bash" ? "mutating" : "read-only",
        },
      }));
      approvalDecisions.push(Object.freeze({ approvalId, decision: approved ? "approved" : "denied" }));
    }

    // Claim comparison never overrides reconciliation; a mismatch is a warning.
    const comparison = compareClaimedChanges([...state.claimedPaths], reconciliation.changedFiles);
    const warnings: string[] = [];
    if (comparison.claimedOnly > 0) {
      warnings.push(
        `${comparison.claimedOnly} path(s) the session named were not changed in the managed workspace`,
      );
    }
    if (comparison.actualOnly > 0) {
      warnings.push(
        `${comparison.actualOnly} changed path(s) were not named by the session`,
      );
    }
    for (const violation of reconciliation.violations) {
      warnings.push(`reconciliation violation ${violation.detailCode} on ${violation.count} path(s)`);
    }
    if (input.processResult?.failure?.code === "PROCESS_TREE_TERMINATION_FAILED") {
      warnings.push("the process tree could not be confirmed terminated");
    }
    if (backend.securityClass !== "secure-enforcing") {
      warnings.push(
        `executed on backend ${backend.backendId} with security class ${backend.securityClass}: no containment`,
      );
    }

    for (const warning of warnings.slice(0, 24)) {
      emit((base) => ({ ...base, kind: "warning", payload: { message: warning } }));
    }

    for (const change of reconciliation.changedFiles) {
      emit((base) => ({ ...base, kind: "file-change-applied", payload: { change } }));
    }

    // Artifacts.
    let patchArtifactId: ArtifactId | null = null;
    if (persistenceAllowed && reconciliation.changedFileCount > 0) {
      const bytes = await safely(() => workspace.capturePatch(configuration.maxPatchBytes));
      if (bytes !== null && bytes.byteLength > 0) {
        patchArtifactId = await writeArtifact({
          category: "patch",
          kind: "patch",
          bytes,
          classification: request.disclosure.classification,
          mediaType: "text/x-diff",
        });
        if (patchArtifactId !== null) {
          artifactsWritten.set("patch", patchArtifactId);
          emit((base) => ({
            ...base,
            kind: "patch-produced",
            payload: { artifactId: patchArtifactId as string },
          }));
        }
      }
    }

    let commandLogArtifactId: ArtifactId | null = null;
    if (persistenceAllowed && state.commandLog.length > 0) {
      commandLogArtifactId = await writeArtifact({
        category: "command-log",
        kind: "log",
        bytes: Buffer.from(
          ["tool\tpath\targument-keys", ...state.commandLog].join("\n"),
          "utf8",
        ),
        classification: request.disclosure.classification,
        mediaType: "text/plain",
      });
      if (commandLogArtifactId !== null) {
        artifactsWritten.set("command-log", commandLogArtifactId);
      }
    }

    let diagnosticsArtifactId: ArtifactId | null = null;
    if (persistenceAllowed && diagnosticsAllowed && state.diagnostics.byteLength > 0) {
      diagnosticsArtifactId = await writeArtifact({
        category: "diagnostics",
        kind: "log",
        bytes: new Uint8Array(state.diagnostics),
        classification: request.disclosure.classification,
        mediaType: "text/plain",
      });
      if (diagnosticsArtifactId !== null) {
        artifactsWritten.set("diagnostics", diagnosticsArtifactId);
      }
    }

    // Test evidence comes from a machine-readable report in the managed
    // workspace, never from Claude's narrative that tests passed.
    let testResults: CodingAgentResult["testResults"] = null;
    if (configuration.testReportPath !== null && request.capabilities.includes("run-tests")) {
      const report = await safely<ClaudeTestReport | null>(() =>
        workspace.readTestReport(configuration.testReportPath as string, configuration.maxDiagnosticBytes),
      );
      if (report !== null && report !== undefined) {
        emit((base) => ({ ...base, kind: "test-started", payload: { suite: report.suite } }));
        emit((base) => ({
          ...base,
          kind: "test-completed",
          payload: {
            suite: report.suite,
            passed: report.passed,
            failed: report.failed,
            skipped: report.skipped,
          },
        }));
        let testArtifactId: ArtifactId | null = null;
        if (persistenceAllowed) {
          testArtifactId = await writeArtifact({
            category: "test-report",
            kind: "test-result",
            bytes: Buffer.from(JSON.stringify(report), "utf8"),
            classification: request.disclosure.classification,
            mediaType: "application/json",
          });
          if (testArtifactId !== null) {
            artifactsWritten.set("test-report", testArtifactId);
          }
        }
        testResults = Object.freeze({
          artifactId: testArtifactId,
          passed: report.passed,
          failed: report.failed,
          skipped: report.skipped,
        });
      }
    }

    // Usage and cost.
    const usage: ProviderUsage = toProviderUsage(state.usage, state.toolCalls);
    if (usage.tokens.inputTokens + usage.tokens.outputTokens + usage.toolCalls > 0) {
      emit((base) => ({ ...base, kind: "usage-update", payload: { usage } }));
    }
    const cost: ClaudeCostMapping = mapCost({
      reportedMicros: state.terminal?.totalCostMicros ?? null,
      authenticationMode: configuration.authenticationMode,
    });

    const endedAt = clock.now();
    const latencyMs = Math.max(0, endedAt.valueOf() - context.startedAt.valueOf());

    // A commit is created only from verified workspace state, only when the
    // capability was granted, only when reconciliation is clean, and only in
    // the private managed repository.
    let resultRevision: string | null = null;
    if (
      input.failure === null &&
      request.capabilities.includes("git-commit") &&
      reconciliation.clean &&
      reconciliation.changedFileCount > 0
    ) {
      const manifest = await safely(() =>
        workspace.commit({
          message: `ai-dev-os attempt ${request.requestId}`,
          committedAt: endedAt.toISOString(),
          policyFingerprint: workspace.grant.policyFingerprint,
        }),
      );
      if (manifest === null) {
        input = { ...input, failure: internalFailureError("internal", { phase: "commit" }) };
      } else {
        resultRevision = manifest.commitId;
      }
    }
    if (resultRevision === null && reconciliation.changedFileCount === 0) {
      resultRevision = workspace.baseRevision;
    }

    // Session metadata is retained only when policy permits it, and holds
    // identity and accounting rather than a transcript.
    let sessionMetadataId: ArtifactId | null = null;
    if (persistenceAllowed && context.persistSession) {
      const metadata: ClaudeSessionMetadata = Object.freeze({
        schemaVersion: 1 as const,
        sessionId: context.sessionId,
        instanceId: configuration.instanceId,
        projectId: workspace.projectId,
        workspaceId: request.workspaceId,
        requestedModel: context.model,
        observedModel: state.observedModel,
        requestedEffort: context.effort,
        turns: state.terminal?.numTurns ?? null,
        persisted: context.persistSession,
        startedAt: context.startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
      });
      sessionMetadataId = await writeArtifact({
        category: "session-metadata",
        kind: "structured-data",
        bytes: Buffer.from(JSON.stringify(metadata), "utf8"),
        classification: request.disclosure.classification,
        mediaType: "application/json",
      });
      if (sessionMetadataId !== null) {
        artifactsWritten.set("session-metadata", sessionMetadataId);
      }
    }

    const failure = input.failure;
    if (failure !== null) {
      const outcome: ClaudeReconciliationOutcome = reconciliation.unavailable
        ? "unavailable"
        : reconciliation.clean
          ? reconciliation.changedFileCount > 0
            ? "changes-accepted"
            : "no-changes"
          : "violation";
      if (!controller.isTerminal) {
        controller.fail(
          (base) => ({
            ...base,
            kind: "operation-failed",
            payload: {
              code: failure.code,
              message: failure.message,
              retryStrategy: failure.retry.strategy,
            },
          }),
          failure,
        );
      }
      emitTerminalObservation(
        { ...input, failure },
        "failed",
        reconciliation,
        { usage, cost, latencyMs, observedModel: state.observedModel, artifactsWritten },
      );
      return;
    }

    const completion: CodingAgentResult["completion"] =
      reconciliation.changedFileCount === 0 ? "completed-no-changes" : "completed";

    const resumeToken =
      context.persistSession && state.observedSessionId !== null
        ? mintResumeToken({
            sessionId: state.observedSessionId,
            instanceId: configuration.instanceId,
            projectId: workspace.projectId,
            workspaceId: request.workspaceId,
            snapshotId: workspace.snapshotId,
            requestId: request.requestId,
            model: context.model,
            effort: context.effort,
            configurationFingerprint: fingerprint,
            issuedAt: endedAt.toISOString(),
            expiresAt: new Date(endedAt.valueOf() + 86_400_000).toISOString(),
          })
        : null;

    const result: CodingAgentResult = Object.freeze({
      schemaVersion: 1 as const,
      operationId: controller.operation.operationId,
      requestId: request.requestId,
      completion,
      patchArtifactId,
      changedFiles: reconciliation.changedFiles as readonly ChangedFileSummary[],
      testResults,
      commandLogArtifactId,
      diagnosticsArtifactId,
      producedArtifacts: Object.freeze([...artifactsWritten.values()].sort()),
      baseRevision: workspace.baseRevision,
      resultRevision,
      approvalDecisions: Object.freeze(approvalDecisions),
      usage,
      cost: cost.cost,
      latency: Object.freeze({ firstEventMs: null, totalMs: latencyMs }),
      warnings: Object.freeze(warnings.slice(0, 24)),
      resumeToken,
    });

    controller.complete((base) => ({ ...base, kind: "operation-completed", payload: {} }), result);
    emitTerminalObservation(input, "succeeded", reconciliation, {
      usage,
      cost,
      latencyMs,
      observedModel: state.observedModel,
      artifactsWritten,
    });
  }

  async function writeArtifact(input: {
    readonly category: ClaudeArtifactCategory;
    readonly kind: "patch" | "log" | "test-result" | "structured-data";
    readonly bytes: Uint8Array;
    readonly classification: CodingAgentRequest["disclosure"]["classification"];
    readonly mediaType: string;
  }): Promise<ArtifactId | null> {
    const written = await safely(() =>
      artifacts.write({
        category: input.category,
        kind: input.kind,
        bytes: input.bytes,
        classification: input.classification,
        mediaType: input.mediaType,
      }),
    );
    return written === null || written === undefined ? null : (written as ArtifactId);
  }

  function emitTerminalObservation(
    input: {
      readonly context: OperationContext;
      readonly state: StreamState;
      readonly processResult: ProcessResult | null;
      readonly failure: ProviderError | null;
      readonly deadlineFired: boolean;
    },
    category: "succeeded" | "failed" | "cancelled",
    reconciliation: ReconciliationResult,
    extra: {
      readonly usage: ProviderUsage;
      readonly cost: ClaudeCostMapping;
      readonly latencyMs: number;
      readonly observedModel: string | null;
      readonly artifactsWritten: ReadonlyMap<ClaudeArtifactCategory, ArtifactId>;
    } | null,
  ): void {
    const usage = extra?.usage ?? ZERO_PROVIDER_USAGE;
    const failure = input.failure;
    const detailCode =
      failure === null ? null : ((failure.details["detailCode"] as ClaudeDetailCode | undefined) ?? null);

    const observation: ClaudeObservation = {
      kind: "operation-terminal",
      category,
      errorCode: failure?.code ?? null,
      detailCode,
      retryStrategy: failure?.retry.strategy ?? null,
      requestedModel: input.context.model,
      observedModel: extra?.observedModel ?? null,
      requestedEffort: input.context.effort,
      observedEffort: null,
      changedFileCount: reconciliation.changedFileCount,
      patchArtifactWritten: extra?.artifactsWritten.has("patch") ?? false,
      commandLogArtifactWritten: extra?.artifactsWritten.has("command-log") ?? false,
      diagnosticsArtifactWritten: extra?.artifactsWritten.has("diagnostics") ?? false,
      testArtifactWritten: extra?.artifactsWritten.has("test-report") ?? false,
      sessionMetadataArtifactWritten: extra?.artifactsWritten.has("session-metadata") ?? false,
      inputTokens: usage.tokens.inputTokens,
      outputTokens: usage.tokens.outputTokens,
      cachedInputTokens: usage.tokens.cachedInputTokens,
      toolCalls: usage.toolCalls,
      costSemantics: extra?.cost.semantics ?? "unknown",
      reportedCostMicros: extra?.cost.reportedMicros ?? null,
      capacityStatus: ageCapacitySnapshot(capacitySnapshot, clock.now()).status,
      latencyMs: extra?.latencyMs ?? 0,
      deadlineExpired: input.deadlineFired,
      cancelled: category === "cancelled",
      reconciliation: reconciliation.unavailable
        ? "unavailable"
        : !reconciliation.clean
          ? "violation"
          : reconciliation.changedFileCount > 0
            ? "changes-accepted"
            : "no-changes",
      backendId: input.processResult?.backendId ?? backend.backendId,
      securityClass: input.processResult?.securityClass ?? backend.securityClass,
      terminationConfirmed: input.processResult?.failure?.code !== "PROCESS_TREE_TERMINATION_FAILED",
    };
    notifyClaudeObserver(options.claudeObserver, observation);

    for (const [subtype, occurrences] of input.state.warningCounts) {
      notifyClaudeObserver(options.claudeObserver, {
        kind: "compatibility-warning",
        recordCategory: subtype,
        occurrences,
      });
    }

    if (options.observer !== undefined) {
      try {
        options.observer({
          providerKind: "coding-agent",
          providerId: CLAUDE_PROVIDER_ID,
          instanceId: configuration.instanceId,
          modelId: input.context.model,
          outcome: category,
          errorCode: failure?.code ?? null,
          retryStrategy: failure?.retry.strategy ?? null,
          latencyMs: extra?.latencyMs ?? 0,
          totalTokens:
            usage.tokens.inputTokens +
            usage.tokens.outputTokens +
            usage.tokens.cachedInputTokens +
            usage.tokens.reasoningTokens,
          deadlineExpired: input.deadlineFired,
          cancelled: category === "cancelled",
        });
      } catch {
        // An observer failure never changes the operation's outcome.
      }
    }
  }

  // -- request validation helpers -------------------------------------------

  function parseRequest(raw: CodingAgentRequest): CodingAgentRequest {
    try {
      return parseCodingAgentRequest(raw);
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      throw invalidRequestError("configuration-invalid", { field: "request" });
    }
  }

  function assertExtensionsUnderstood(request: CodingAgentRequest): void {
    for (const extension of request.extensions) {
      if (extension.namespace !== "claude-code") {
        throw unsupportedCapabilityError("configuration-invalid", { namespace: extension.namespace });
      }
      if (extension.key !== "max-turns" && extension.key !== "max-budget-micros") {
        throw unsupportedCapabilityError("configuration-invalid", { key: extension.key });
      }
      if (typeof extension.value !== "number" || !Number.isSafeInteger(extension.value) || extension.value < 0) {
        throw invalidRequestError("configuration-invalid", { key: extension.key });
      }
    }
  }

  function resolveModel(request: CodingAgentRequest): string | null {
    const requested = request.modelId ?? configuration.defaultModel;
    if (requested === null || requested === undefined) {
      return null;
    }
    if (!configuration.permittedModels.includes(requested)) {
      throw modelUnavailableError("model-not-permitted", { requestedModel: requested });
    }
    return requested;
  }

  function resolveEffort(request: CodingAgentRequest): ClaudeEffortLevel | null {
    const extension = request.extensions.find(
      (entry) => entry.namespace === "claude-code" && entry.key === "effort",
    );
    const requested = typeof extension?.value === "string" ? extension.value : configuration.defaultEffort;
    if (requested === null || requested === undefined) {
      return null;
    }
    if (!isEffortLevel(requested) || !configuration.permittedEffortLevels.includes(requested)) {
      throw unsupportedCapabilityError("effort-not-permitted", { requestedEffort: String(requested) });
    }
    return requested;
  }

  /**
   * Runtime extensions may only tighten a configured limit, never widen one.
   */
  function resolveBudgetMicros(request: CodingAgentRequest): number | null {
    let micros = configuration.maxBudgetMicros;
    const extension = request.extensions.find(
      (entry) => entry.namespace === "claude-code" && entry.key === "max-budget-micros",
    );
    if (typeof extension?.value === "number") {
      micros = micros === 0 ? extension.value : Math.min(micros, extension.value);
    }
    const budgetMoney = request.budget?.money?.limit ?? null;
    if (budgetMoney !== null) {
      micros = micros === 0 ? budgetMoney.amountMicros : Math.min(micros, budgetMoney.amountMicros);
    }
    return micros > 0 ? micros : null;
  }

  function probeFailureError(probe: ClaudeProbeResult): ProviderError {
    switch (probe.status) {
      case "unsupported-version":
        return unsupportedCapabilityError(probe.detailCode ?? "version-unsupported", {
          version: probe.version ?? "unknown",
          minimumVersion: configuration.minimumCliVersion,
        });
      case "executable-unsafe":
        return unsupportedCapabilityError(probe.detailCode ?? "executable-unsafe");
      case "authentication-unavailable":
        return authenticationError("authentication-unavailable");
      case "executable-unavailable":
      case "probe-failed":
      default:
        return unsupportedCapabilityError(probe.detailCode ?? "probe-failed");
    }
  }

  // -- lifecycle ------------------------------------------------------------

  return Object.freeze({
    kind: "coding-agent" as const,
    configurationFingerprint: fingerprint,

    describe: (): ProviderDescriptor => descriptor,

    async health(): Promise<ProviderHealth> {
      const checkedAt = clock.now().toISOString();
      if (closed) {
        return parseProviderHealth({
          status: "closed",
          checkedAt,
          detailCode: null,
          activeOperations: pumps.size,
        });
      }
      const probe = await ensureProbe().catch(() => null);
      if (probe === null) {
        return parseProviderHealth({
          status: "unavailable",
          checkedAt,
          detailCode: "probe-failed",
          activeOperations: pumps.size,
        });
      }
      const status =
        probe.status === "compatible"
          ? backend.securityClass === "secure-enforcing"
            ? "ready"
            : "degraded"
          : probe.status === "unsupported-version"
            ? "degraded"
            : "unavailable";
      return parseProviderHealth({
        status,
        checkedAt,
        detailCode: probe.detailCode === null ? (status === "degraded" ? "backend-not-secure" : null) : probe.detailCode,
        activeOperations: pumps.size,
      });
    },

    probe: (): Promise<ClaudeProbeResult> => ensureProbe(),

    compatibility: (): ClaudeCompatibilityProfile | null => probeResult?.profile ?? null,

    capacity: (): ClaudeCapacitySnapshot => ageCapacitySnapshot(capacitySnapshot, clock.now()),

    observeStatusSnapshot(document: string): ClaudeCapacitySnapshot {
      capacitySnapshot = ingestStatusSnapshot({
        document,
        observedAt: clock.now().toISOString(),
        stalenessMs: configuration.capacityStalenessMs,
      });
      return capacitySnapshot;
    },

    start,

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      for (const cancel of [...activeCancels]) {
        await cancel("provider-closed");
      }
      activeCancels.clear();
      await Promise.allSettled([...pumps]);
    },
  });
}

// -- small helpers ----------------------------------------------------------

function defaultUuid(): string {
  return globalThis.crypto.randomUUID();
}

function isEffortLevel(value: unknown): value is ClaudeEffortLevel {
  return typeof value === "string" && (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * Compares a requested model against the one the session reported.
 *
 * An alias such as `fable` legitimately resolves to a full identifier such as
 * `claude-fable-5`, so an exact string match is too strict. A prefix or
 * containment relationship is accepted; anything else is a substitution, and
 * substitution is reported rather than absorbed. Opus and Fable never satisfy
 * each other under this rule.
 */
export function modelMatches(requested: string, observed: string): boolean {
  const left = requested.toLowerCase();
  const right = observed.toLowerCase();
  if (left === right) {
    return true;
  }
  return right.includes(left) || left.includes(right);
}

const READ_TOOLS: ReadonlySet<string> = Object.freeze(new Set(["Read", "Glob", "Grep", "NotebookRead"]));
const WRITE_TOOLS: ReadonlySet<string> = Object.freeze(new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]));

function isReadTool(name: string): boolean {
  return READ_TOOLS.has(name);
}

function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}

/** The provider-neutral tool-name shape is lowercase and dot/dash separated. */
function normalizeToolName(name: string): string {
  const normalized = name
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .slice(0, 64);
  return /^[a-z]/.test(normalized) ? normalized : `tool-${normalized}`.slice(0, 64);
}

function resolveDeadlineMs(
  request: CodingAgentRequest,
  now: Date,
  configuredMs: number,
): number {
  if (request.deadline === null) {
    return configuredMs;
  }
  const remaining = Date.parse(request.deadline) - now.valueOf();
  return Math.max(0, Math.min(configuredMs, remaining));
}

async function safely<T>(action: () => Promise<T> | T): Promise<T | null> {
  try {
    return await action();
  } catch {
    return null;
  }
}
