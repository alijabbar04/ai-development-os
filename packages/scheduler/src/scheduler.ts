import { createHash } from "node:crypto";
import type { PersistenceAdapter } from "@ai-dev-os/persistence";
import { SchedulerError } from "./errors.js";
import { evaluateDispatchPolicy, policyBlockFromDecision } from "./policy.js";
import type { AgentAdapter, AgentAdapterSession, AgentAdapterSignal, DeterministicFakeAgentAdapter } from "./provider.js";
import { routeTask, type RouteCandidate, type RoutingPreference, type WorkloadClass } from "./routing.js";
import { taskFingerprint, ZERO_NORMALIZED_USAGE } from "./schema.js";
import { createOrchestrationStore, type OrchestrationStore, type StoreFaultPoint } from "./store.js";
import {
  ORCHESTRATION_SCHEMA_VERSION,
  type FailureClassification,
  type OrchestrationEvent,
  type OrchestrationRunState,
  type OrchestrationTaskEnvelope,
  type OrchestrationTerminalResult,
  type SchedulerAuditRecord,
  type SchedulerClock,
  type SchedulerConfiguration,
  type SelectedRoute,
} from "./types.js";
import type { CanonicalUsageSnapshotInput } from "./usage.js";

export const DEFAULT_SCHEDULER_CONFIGURATION: SchedulerConfiguration = Object.freeze({
  maximumConcurrency: 4,
  leaseDurationMs: 30_000,
  usageFreshnessMs: 15 * 60_000,
});

export interface DispatchInput {
  readonly workloadClass: WorkloadClass;
  readonly preference: RoutingPreference;
  readonly candidates: readonly RouteCandidate[];
  readonly usageSnapshots: readonly CanonicalUsageSnapshotInput[];
}

export interface DurableScheduler {
  submit(task: unknown): Promise<{ readonly outcome: "created" | "duplicate"; readonly state: OrchestrationRunState }>;
  get(idempotencyKey: string): Promise<OrchestrationRunState | null>;
  history(idempotencyKey: string): Promise<readonly OrchestrationEvent[]>;
  dispatch(idempotencyKey: string, input: DispatchInput): Promise<OrchestrationRunState>;
  continue(idempotencyKey: string, instruction: string): Promise<OrchestrationRunState>;
  recover(idempotencyKey: string): Promise<OrchestrationRunState>;
  cancel(idempotencyKey: string, reason: string): Promise<OrchestrationRunState>;
  resumeApproval(idempotencyKey: string, approvalId: string, approvalReference: string): Promise<OrchestrationRunState>;
  resumeBlocked(idempotencyKey: string, approvalReference: string, operationFingerprint: string): Promise<OrchestrationRunState>;
  tick(): Promise<readonly OrchestrationRunState[]>;
  close(): Promise<void>;
}

interface InternalSchedulerOptions {
  readonly persistence: PersistenceAdapter;
  readonly clock?: SchedulerClock;
  readonly configuration?: SchedulerConfiguration;
  readonly audit?: (record: SchedulerAuditRecord) => void;
  readonly fakeAdapter?: DeterministicFakeAgentAdapter;
  readonly allowFakeExecution: boolean;
  readonly fault?: (point: StoreFaultPoint) => Promise<void> | void;
}

export interface ProductionDisabledSchedulerOptions {
  readonly persistence: PersistenceAdapter;
  readonly clock?: SchedulerClock;
  readonly configuration?: SchedulerConfiguration;
  readonly audit?: (record: SchedulerAuditRecord) => void;
}

const systemClock: SchedulerClock = Object.freeze({ now: () => new Date() });

function addMs(iso: string, milliseconds: number): string {
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}

function nonclaims(): readonly string[] {
  return Object.freeze([
    "stage-17-admission-not-satisfied",
    "production-availability-not-implied",
    "provider-output-is-not-validation-evidence",
  ]);
}

function providerIdentity(state: OrchestrationRunState): OrchestrationTerminalResult["provider"] {
  if (state.route === null || state.threadId === null || state.providerRunId === null) return null;
  return Object.freeze({
    providerId: state.route.providerId,
    modelId: state.route.modelId,
    profileId: state.route.profileId,
    threadId: state.threadId,
    providerRunId: state.providerRunId,
  });
}

function failureResult(
  state: OrchestrationRunState,
  classification: FailureClassification,
  code: string,
  retryable: boolean,
  finishedAt: string,
): OrchestrationTerminalResult {
  return Object.freeze({
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    outcome: "failed",
    artifacts: Object.freeze([]),
    evidence: Object.freeze([]),
    usage: state.usage,
    startedAt: state.status === "running" ? state.lastOccurredAt : null,
    finishedAt,
    provider: providerIdentity(state),
    failure: Object.freeze({ classification, code, retryable }),
    nonclaims: nonclaims(),
  });
}

function cancellationResult(state: OrchestrationRunState, finishedAt: string): OrchestrationTerminalResult {
  return Object.freeze({
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    outcome: "cancelled",
    artifacts: Object.freeze([]),
    evidence: Object.freeze([]),
    usage: state.usage,
    startedAt: state.status === "running" ? state.lastOccurredAt : null,
    finishedAt,
    provider: providerIdentity(state),
    failure: null,
    nonclaims: nonclaims(),
  });
}

function policyResult(state: OrchestrationRunState, code: string, finishedAt: string): OrchestrationTerminalResult {
  return Object.freeze({
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    outcome: "policy-blocked",
    artifacts: Object.freeze([]),
    evidence: Object.freeze([]),
    usage: state.usage,
    startedAt: null,
    finishedAt,
    provider: providerIdentity(state),
    failure: Object.freeze({ classification: "policy" as const, code, retryable: false }),
    nonclaims: nonclaims(),
  });
}

function deterministicDispatchId(state: OrchestrationRunState, route: SelectedRoute): string {
  return `dispatch:${createHash("sha256").update(JSON.stringify({ fingerprint: state.taskFingerprint, attempt: state.attempt + 1, route })).digest("hex").slice(0, 32)}`;
}

function terminal(state: OrchestrationRunState): boolean {
  return state.status === "completed" || state.status === "failed" || state.status === "cancelled" ||
    (state.status === "policy-blocked" && state.block?.humanResumable === false);
}

export function createProductionDisabledScheduler(options: ProductionDisabledSchedulerOptions): DurableScheduler {
  return createDurableScheduler({ ...options, allowFakeExecution: false });
}

export function createDurableSchedulerForTesting(options: Omit<InternalSchedulerOptions, "allowFakeExecution"> & { readonly fakeAdapter: DeterministicFakeAgentAdapter }): DurableScheduler {
  return createDurableScheduler({ ...options, allowFakeExecution: true });
}

function createDurableScheduler(options: InternalSchedulerOptions): DurableScheduler {
  const clock = options.clock ?? systemClock;
  const configuration = options.configuration ?? DEFAULT_SCHEDULER_CONFIGURATION;
  if (!Number.isSafeInteger(configuration.maximumConcurrency) || configuration.maximumConcurrency < 1 || configuration.maximumConcurrency > 64 ||
      !Number.isSafeInteger(configuration.leaseDurationMs) || configuration.leaseDurationMs < 100 || configuration.leaseDurationMs > 86_400_000 ||
      !Number.isSafeInteger(configuration.usageFreshnessMs) || configuration.usageFreshnessMs < 1 || configuration.usageFreshnessMs > 86_400_000) {
    throw new SchedulerError("INVALID_TASK", "Scheduler configuration is outside its compiled bounds.");
  }
  const store: OrchestrationStore = createOrchestrationStore({ adapter: options.persistence, ...(options.fault === undefined ? {} : { fault: options.fault }) });
  const adapter: AgentAdapter | null = options.fakeAdapter ?? null;

  async function append(
    idempotencyKey: string,
    type: Parameters<OrchestrationStore["append"]>[1],
    payload: unknown,
    ruleIds: readonly string[] = [],
    occurredAt?: string,
  ): Promise<OrchestrationRunState> {
    const at = occurredAt ?? clock.now().toISOString();
    const state = await store.append(idempotencyKey, type, payload, at);
    options.audit?.(Object.freeze({ taskId: state.task.taskId, sequence: state.sequence, eventType: type, status: state.status, occurredAt: at, ruleIds: Object.freeze([...ruleIds]) }));
    return state;
  }

  async function requireState(idempotencyKey: string): Promise<OrchestrationRunState> {
    const state = await store.get(idempotencyKey);
    if (state === null) throw new SchedulerError("NOT_FOUND", "The task-run does not exist.");
    return state;
  }

  async function terminalFailure(
    state: OrchestrationRunState,
    classification: FailureClassification,
    code: string,
    retryable: boolean,
  ): Promise<OrchestrationRunState> {
    const now = clock.now().toISOString();
    return append(state.task.idempotencyKey, "failed", { result: failureResult(state, classification, code, retryable, now) });
  }

  async function retryOrFail(
    state: OrchestrationRunState,
    classification: FailureClassification,
    code: string,
  ): Promise<OrchestrationRunState> {
    const retryable = state.task.retry.retryableFailures.includes(classification);
    if (!retryable || state.attempt >= state.task.retry.maximumAttempts) {
      return terminalFailure(state, classification, code, retryable);
    }
    const exponent = Math.max(0, state.attempt - 1);
    const delayMs = Math.min(state.task.retry.maximumBackoffMs, state.task.retry.initialBackoffMs * (2 ** exponent));
    const at = clock.now().toISOString();
    return append(state.task.idempotencyKey, "retry_scheduled", {
      attempt: state.attempt,
      runAt: addMs(at, delayMs),
      delayMs,
      failureClassification: classification,
    }, [], at);
  }

  async function blockFromSignal(state: OrchestrationRunState, signal: Extract<AgentAdapterSignal, { type: "policy-blocked" }>): Promise<OrchestrationRunState> {
    const operationFingerprint = createHash("sha256").update(`${state.taskFingerprint}|${state.dispatch?.dispatchId ?? "missing"}|${signal.code}`).digest("hex");
    const block = Object.freeze({
      blockId: `block:${operationFingerprint.slice(0, 32)}`,
      operationFingerprint,
      ruleIds: Object.freeze([`provider.${signal.code}`]),
      reason: signal.reason,
      humanResumable: signal.humanResumable,
    });
    const result = signal.humanResumable ? null : policyResult(state, signal.code, clock.now().toISOString());
    return append(state.task.idempotencyKey, "policy_blocked", { block, result }, block.ruleIds);
  }

  async function consumeSession(state: OrchestrationRunState, session: AgentAdapterSession): Promise<OrchestrationRunState> {
    let current = state;
    for await (const signal of session.events) {
      if (terminal(current) || current.status === "awaiting-approval" || current.status === "policy-blocked") break;
      switch (signal.type) {
        case "progress":
          current = await append(current.task.idempotencyKey, "progress", { message: signal.message, percent: signal.percent });
          break;
        case "checkpoint":
          current = await append(current.task.idempotencyKey, "checkpoint", { checkpointId: signal.checkpointId, kind: signal.kind, artifactIds: signal.artifactIds });
          break;
        case "usage":
          current = await append(current.task.idempotencyKey, "usage_snapshot", { usage: signal.usage });
          if (current.usage.inputTokens + current.usage.cachedInputTokens + current.usage.cacheWriteInputTokens > current.task.budget.maximumInputTokens ||
              current.usage.outputTokens + current.usage.reasoningTokens > current.task.budget.maximumOutputTokens ||
              current.usage.toolCalls > current.task.budget.maximumToolCalls ||
              (current.usage.costMicros !== null && current.usage.costMicros > current.task.budget.maximumCostMicros)) {
            current = await terminalFailure(current, "usage", "usage-budget-exceeded", false);
          }
          break;
        case "approval-required":
          current = await append(current.task.idempotencyKey, "approval_required", { approvalId: signal.approvalId, reason: signal.reason, humanResumable: true });
          break;
        case "policy-blocked":
          current = await blockFromSignal(current, signal);
          break;
        case "completed":
          current = await append(current.task.idempotencyKey, "completed", { result: signal.result });
          break;
        case "failed": {
          const failure = signal.result.failure;
          current = failure?.retryable === true
            ? await retryOrFail(current, failure.classification, failure.code)
            : await append(current.task.idempotencyKey, "failed", { result: signal.result });
          break;
        }
      }
    }
    return current;
  }

  async function startPersistedDispatch(state: OrchestrationRunState): Promise<OrchestrationRunState> {
    if (adapter === null || state.dispatch === null || state.route === null) throw new SchedulerError("PROVIDER_UNAVAILABLE", "No deterministic fake adapter is available.");
    if (adapter.providerId !== state.route.providerId) return terminalFailure(state, "provider", "provider-identity-mismatch", false);
    let current = state;
    try {
      const session = await adapter.start({
        dispatchId: state.dispatch.dispatchId,
        attempt: state.attempt,
        accumulatedUsage: state.usage,
        task: state.task,
        route: state.route,
        deadline: state.task.deadline,
      });
      current = await append(state.task.idempotencyKey, "started", { threadId: session.threadId, providerRunId: session.providerRunId, continued: false });
      return consumeSession(current, session);
    } catch {
      return retryOrFail(current, "disconnected", "provider-start-disconnected");
    }
  }

  const scheduler: DurableScheduler = Object.freeze({
    async submit(task: unknown) {
      const occurredAt = clock.now().toISOString();
      const result = await store.submit(task, occurredAt);
      if (result.outcome === "created") options.audit?.(Object.freeze({ taskId: result.state.task.taskId, sequence: 1, eventType: "queued", status: "queued", occurredAt, ruleIds: Object.freeze([]) }));
      return result;
    },

    get: (idempotencyKey: string) => store.get(idempotencyKey),
    history: (idempotencyKey: string) => store.history(idempotencyKey),

    async dispatch(idempotencyKey: string, input: DispatchInput): Promise<OrchestrationRunState> {
      let state = await requireState(idempotencyKey);
      if (terminal(state)) return state;
      if (state.status !== "queued") throw new SchedulerError("INVALID_TRANSITION", "Only a queued task may be dispatched.");
      const now = clock.now();
      if (now.toISOString() >= state.task.deadline) return scheduler.cancel(idempotencyKey, "deadline-expired-before-dispatch");
      const active = (await store.list()).filter((item) => item.status === "dispatched" || item.status === "running").length;
      if (active >= configuration.maximumConcurrency) throw new SchedulerError("CONCURRENCY_LIMIT", "The bounded concurrency ceiling is full.");
      const decision = routeTask({ task: state.task, workloadClass: input.workloadClass, preference: input.preference, candidates: input.candidates, usageSnapshots: input.usageSnapshots, now, maximumSnapshotAgeMs: configuration.usageFreshnessMs });
      const { schemaVersion: _schemaVersion, ...decisionPayload } = decision;
      state = await append(idempotencyKey, "routing_decision", decisionPayload, decision.ruleIds);
      if (decision.selected === null) {
        const operationFingerprint = createHash("sha256").update(`${state.taskFingerprint}|${decision.decisionId}`).digest("hex");
        const block = Object.freeze({ blockId: `block:${operationFingerprint.slice(0, 32)}`, operationFingerprint, ruleIds: Object.freeze(["route.no-eligible-candidate"]), reason: decision.reasons.join(" "), humanResumable: false });
        return append(idempotencyKey, "policy_blocked", { block, result: policyResult(state, "no-eligible-route", now.toISOString()) }, block.ruleIds);
      }
      if (!options.allowFakeExecution) {
        const policy = evaluateDispatchPolicy({
          permissionMode: state.task.permissionMode,
          stage17Admitted: false,
          productionEnabled: false,
          credentialsAvailable: false,
          operatorPolicyAllows: false,
          providerSafetyAllows: false,
          usageAllows: true,
          requestsElevation: false,
          operation: { taskId: state.task.taskId, candidateId: decision.selected.candidateId, objectiveDigest: createHash("sha256").update(state.task.objective).digest("hex") },
        });
        const block = policyBlockFromDecision(policy);
        return append(idempotencyKey, "policy_blocked", { block, result: policyResult(state, "production-disabled", now.toISOString()) }, policy.ruleIds);
      }
      const dispatchId = deterministicDispatchId(state, decision.selected);
      state = await append(idempotencyKey, "dispatched", {
        attempt: state.attempt + 1,
        dispatchId,
        route: decision.selected,
        leaseExpiresAt: addMs(clock.now().toISOString(), configuration.leaseDurationMs),
      });
      return startPersistedDispatch(state);
    },

    async continue(idempotencyKey: string, instruction: string): Promise<OrchestrationRunState> {
      let state = await requireState(idempotencyKey);
      if (state.status !== "running" || state.dispatch === null || state.threadId === null || state.providerRunId === null) throw new SchedulerError("INVALID_TRANSITION", "Continuation requires a running durable thread.");
      if (clock.now().toISOString() >= state.task.deadline) return scheduler.cancel(idempotencyKey, "deadline-expired-before-continuation");
      if (state.turns >= state.task.budget.maximumTurns) return terminalFailure(state, "policy", "turn-ceiling-exhausted", false);
      if (typeof instruction !== "string" || instruction.length < 1 || instruction.length > 100_000) throw new SchedulerError("INVALID_TASK", "Continuation instruction is outside its bound.");
      if (adapter === null) return terminalFailure(state, "provider", "adapter-unavailable", false);
      try {
        const session = await adapter.continue({ dispatchId: state.dispatch.dispatchId, threadId: state.threadId, providerRunId: state.providerRunId, instruction, deadline: state.task.deadline });
        state = await append(idempotencyKey, "started", { threadId: session.threadId, providerRunId: session.providerRunId, continued: true });
        return consumeSession(state, session);
      } catch {
        return retryOrFail(state, "disconnected", "provider-continue-disconnected");
      }
    },

    async recover(idempotencyKey: string): Promise<OrchestrationRunState> {
      let state = await requireState(idempotencyKey);
      if (state.status !== "dispatched" && state.status !== "running") return state;
      if (state.dispatch === null) return terminalFailure(state, "unknown", "dispatch-receipt-missing", false);
      const now = clock.now().toISOString();
      if (state.dispatch.leaseExpiresAt > now) return state;
      if (adapter === null) return terminalFailure(state, "provider", "adapter-unavailable", false);
      let status;
      try { status = await adapter.status({ dispatchId: state.dispatch.dispatchId, threadId: state.threadId }); }
      catch { return retryOrFail(state, "disconnected", "provider-status-unavailable"); }
      if (status === "completed" && state.threadId !== null) {
        const result = await adapter.result({ dispatchId: state.dispatch.dispatchId, threadId: state.threadId });
        return result === null ? terminalFailure(state, "invalid-result", "terminal-result-missing", false) : append(idempotencyKey, "completed", { result });
      }
      if (status === "failed" && state.threadId !== null) {
        const result = await adapter.result({ dispatchId: state.dispatch.dispatchId, threadId: state.threadId });
        return result === null ? terminalFailure(state, "invalid-result", "terminal-result-missing", false) : append(idempotencyKey, "failed", { result });
      }
      if (status === "running" || status === "queued") {
        return append(idempotencyKey, "recovered", { fromStatus: state.status, toStatus: state.status, action: "lease-reconciled", reason: "provider-state-confirmed", leaseExpiresAt: addMs(now, configuration.leaseDurationMs) });
      }
      if (status === "disconnected" && state.threadId !== null) {
        try {
          const session = await adapter.resume({ dispatchId: state.dispatch.dispatchId, threadId: state.threadId, deadline: state.task.deadline });
          state = await append(idempotencyKey, "recovered", { fromStatus: state.status, toStatus: state.status, action: "provider-resumed", reason: "provider-thread-resumed", leaseExpiresAt: addMs(now, configuration.leaseDurationMs) });
          state = await append(idempotencyKey, "started", { threadId: session.threadId, providerRunId: session.providerRunId, continued: true });
          return consumeSession(state, session);
        } catch { return retryOrFail(state, "disconnected", "provider-resume-disconnected"); }
      }
      if (status === "not-found" && state.status === "dispatched" && state.threadId === null) {
        state = await append(idempotencyKey, "recovered", { fromStatus: "dispatched", toStatus: "dispatched", action: "lease-reconciled", reason: "logical-dispatch-replayed-with-same-idempotency-key", leaseExpiresAt: addMs(now, configuration.leaseDurationMs) });
        return startPersistedDispatch(state);
      }
      return retryOrFail(state, "disconnected", `provider-${status}`);
    },

    async cancel(idempotencyKey: string, reason: string): Promise<OrchestrationRunState> {
      const state = await requireState(idempotencyKey);
      if (terminal(state)) return state;
      if (typeof reason !== "string" || reason.length < 1 || reason.length > 2_000) throw new SchedulerError("INVALID_TASK", "Cancellation reason is outside its bound.");
      const cancelled = await append(idempotencyKey, "cancelled", { result: cancellationResult(state, clock.now().toISOString()) });
      if (adapter !== null && state.dispatch !== null) {
        try { await adapter.cancel({ dispatchId: state.dispatch.dispatchId, threadId: state.threadId, reason }); }
        catch { /* Durable cancellation wins; adapter reconciliation remains observable on recovery. */ }
      }
      return cancelled;
    },

    async resumeApproval(idempotencyKey: string, approvalId: string, approvalReference: string): Promise<OrchestrationRunState> {
      const state = await requireState(idempotencyKey);
      if (state.status !== "awaiting-approval" || state.approvalId === null) throw new SchedulerError("INVALID_TRANSITION", "Only an exact durable approval wait may resume.");
      if (state.approvalId !== approvalId || typeof approvalReference !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(approvalReference)) {
        throw new SchedulerError("POLICY_BLOCKED", "Approval evidence is missing or bound to another request.");
      }
      return append(idempotencyKey, "recovered", { fromStatus: "awaiting-approval", toStatus: "queued", action: "human-resume", reason: `approval:${approvalReference}`, leaseExpiresAt: null });
    },

    async resumeBlocked(idempotencyKey: string, approvalReference: string, operationFingerprint: string): Promise<OrchestrationRunState> {
      const state = await requireState(idempotencyKey);
      if (state.status !== "policy-blocked" || state.block?.humanResumable !== true) throw new SchedulerError("INVALID_TRANSITION", "Only an explicitly human-resumable policy block may resume.");
      if (state.block.operationFingerprint !== operationFingerprint || typeof approvalReference !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(approvalReference)) throw new SchedulerError("POLICY_BLOCKED", "Approval evidence is missing or bound to another operation.");
      return append(idempotencyKey, "recovered", { fromStatus: "policy-blocked", toStatus: "queued", action: "human-resume", reason: `approval:${approvalReference}`, leaseExpiresAt: null });
    },

    async tick(): Promise<readonly OrchestrationRunState[]> {
      const changed: OrchestrationRunState[] = [];
      const now = clock.now().toISOString();
      for (const state of await store.list()) {
        if (terminal(state)) continue;
        if (state.task.deadline <= now) {
          changed.push(await scheduler.cancel(state.task.idempotencyKey, "deadline-expired"));
        } else if (state.status === "retry-wait" && state.nextAttemptAt !== null && state.nextAttemptAt <= now) {
          changed.push(await append(state.task.idempotencyKey, "recovered", { fromStatus: "retry-wait", toStatus: "queued", action: "retry-due", reason: "bounded-backoff-elapsed", leaseExpiresAt: null }));
        }
      }
      return Object.freeze(changed);
    },

    async close(): Promise<void> {
      try { await adapter?.close(); }
      finally { await store.close(); }
    },
  });
  return scheduler;
}
