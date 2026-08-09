import { describe, expect, it } from "vitest";
import {
  SchedulerError,
  applyOrchestrationEvent,
  createOrchestrationEvent,
  isSchedulerError,
  parseNormalizedUsage,
  parseOrchestrationEvent,
  parseOrchestrationTaskEnvelope,
  parseTerminalResult,
  replayOrchestrationEvents,
  routeTask,
  stateEquals,
  taskFingerprint,
  type OrchestrationEvent,
  type OrchestrationEventType,
  type OrchestrationRunState,
} from "../src/index.js";
import { BASE_TIME, candidate, normalizedUsage, task, terminalResult, usageSnapshot } from "./fixtures.js";

function at(sequence: number): string {
  return new Date(Date.parse(BASE_TIME) + sequence * 1_000).toISOString();
}

function queuedState(): OrchestrationRunState {
  const value = task();
  return replayOrchestrationEvents([
    createOrchestrationEvent({
      taskId: value.taskId,
      sequence: 1,
      occurredAt: at(1),
      type: "queued",
      payload: { task: value, taskFingerprint: taskFingerprint(value) },
    }),
  ]);
}

function next(
  state: OrchestrationRunState,
  type: OrchestrationEventType,
  payload: unknown,
  occurredAt = at(state.sequence + 1),
): OrchestrationRunState {
  return applyOrchestrationEvent(state, createOrchestrationEvent({
    taskId: state.task.taskId,
    sequence: state.sequence + 1,
    occurredAt,
    type,
    payload,
  }));
}

function selectedDecisionPayload() {
  const decision = routeTask({
    task: task(),
    workloadClass: "general",
    preference: "balanced",
    candidates: [candidate()],
    usageSnapshots: [usageSnapshot()],
    now: new Date(BASE_TIME),
    maximumSnapshotAgeMs: 60_000,
  });
  const { schemaVersion: _schemaVersion, ...payload } = decision;
  return payload;
}

function dispatchedState(): OrchestrationRunState {
  let state = next(queuedState(), "routing_decision", selectedDecisionPayload());
  state = next(state, "dispatched", {
    attempt: 1,
    dispatchId: "dispatch:one",
    route: {
      candidateId: "candidate:fake",
      providerId: "provider:fake",
      modelId: "model:fake",
      profileId: "profile:owned",
      ownership: "owned",
    },
    leaseExpiresAt: at(60),
  });
  return state;
}

function runningState(): OrchestrationRunState {
  return next(dispatchedState(), "started", {
    threadId: "thread:fake",
    providerRunId: "run:fake",
    continued: false,
  });
}

describe("orchestration contracts", () => {
  it("parses, freezes, and fingerprints the exact versioned task deterministically", () => {
    const parsed = parseOrchestrationTaskEnvelope(task());
    expect(parsed).toEqual(task());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(taskFingerprint(parsed)).toMatch(/^[a-f0-9]{64}$/);
    expect(taskFingerprint(parsed)).toBe(taskFingerprint(parseOrchestrationTaskEnvelope(structuredClone(task()))));
  });

  it.each([
    ["unknown root authority", () => ({ ...task(), executable: "agent.exe" })],
    ["workspace path", () => ({ ...task(), workspace: { ...task().workspace, path: "C:/source" } })],
    ["credential", () => ({ ...task(), requestedRoute: { ...task().requestedRoute, credential: "secret" } })],
    ["partial route", () => ({ ...task(), requestedRoute: { ...task().requestedRoute, providerId: "provider:fake" } })],
    ["self parent", () => ({ ...task(), parentTaskId: task().taskId })],
    ["backwards deadline", () => ({ ...task(), deadline: BASE_TIME })],
    ["unbounded attempts", () => ({ ...task(), retry: { ...task().retry, maximumAttempts: 9 } })],
    ["zero turns", () => ({ ...task(), budget: { ...task().budget, maximumTurns: 0 } })],
    ["unknown capability", () => ({ ...task(), capabilities: ["repository-read", "credential-read"] })],
    ["unsupported schema", () => ({ ...task(), schemaVersion: 2 })],
  ])("rejects %s in a task envelope", (_label, mutate) => {
    expect(() => parseOrchestrationTaskEnvelope(mutate())).toThrow();
  });

  it("requires all explicit route identity parts together", () => {
    const routed = task({
      requestedRoute: {
        providerId: "provider:fake",
        modelId: "model:fake",
        profileId: "profile:owned",
        ownership: "owned",
      },
    });
    expect(parseOrchestrationTaskEnvelope(routed).requestedRoute).toEqual(routed.requestedRoute);
  });

  it("validates normalized usage and terminal result invariants", () => {
    expect(parseNormalizedUsage(normalizedUsage())).toEqual(normalizedUsage());
    expect(() => parseNormalizedUsage({ ...normalizedUsage(), inputTokens: -1 })).toThrow();
    expect(() => parseNormalizedUsage({ ...normalizedUsage(), credential: "x" })).toThrow();
    expect(parseTerminalResult(terminalResult("completed")).outcome).toBe("completed");
    expect(parseTerminalResult(terminalResult("failed")).failure?.classification).toBe("provider");
    expect(() => parseTerminalResult({ ...terminalResult("completed"), failure: { classification: "provider", code: "bad", retryable: false } })).toThrow();
    expect(() => parseTerminalResult({ ...terminalResult("failed"), failure: null })).toThrow();
    expect(() => parseTerminalResult({ ...terminalResult("completed"), startedAt: "2026-08-11T00:00:00.000Z" })).toThrow();
    expect(() => parseTerminalResult({ ...terminalResult("completed"), authority: true })).toThrow();
  });

  it("creates deterministic exact-key events and refuses malformed events", () => {
    const event = createOrchestrationEvent({ taskId: "task:one", sequence: 1, occurredAt: BASE_TIME, type: "queued", payload: {} });
    expect(event.eventId).toMatch(/^event:[a-f0-9]{40}$/);
    expect(event).toEqual(createOrchestrationEvent({ taskId: "task:one", sequence: 1, occurredAt: BASE_TIME, type: "queued", payload: {} }));
    expect(parseOrchestrationEvent(event)).toEqual(event);
    expect(() => parseOrchestrationEvent({ ...event, authority: "hidden" })).toThrow();
    expect(() => parseOrchestrationEvent({ ...event, sequence: 0 })).toThrow();
    expect(() => createOrchestrationEvent({ taskId: "task:one", sequence: 1, occurredAt: BASE_TIME, type: "queued", payload: { bad: undefined } })).toThrow();
  });
});

describe("orchestration replay state machine", () => {
  it("replays every ordinary running and terminal event deterministically", () => {
    let state = runningState();
    state = next(state, "progress", { message: "bounded progress", percent: 25 });
    state = next(state, "checkpoint", { checkpointId: "checkpoint:one", kind: "source", artifactIds: ["artifact:one"] });
    state = next(state, "usage_snapshot", { usage: normalizedUsage() });
    const completed = next(state, "completed", { result: terminalResult("completed") });
    expect(completed.status).toBe("completed");
    expect(completed.sequence).toBe(8);

    const events: OrchestrationEvent[] = [];
    let replay = queuedState();
    events.push(createOrchestrationEvent({
      taskId: replay.task.taskId,
      sequence: 1,
      occurredAt: at(1),
      type: "queued",
      payload: { task: replay.task, taskFingerprint: replay.taskFingerprint },
    }));
    // Equality is canonical and independent of object identity.
    expect(stateEquals(completed, structuredClone(completed))).toBe(true);
    expect(stateEquals(completed, { ...completed, sequence: 999 })).toBe(false);
  });

  it("represents approval, human-resumable policy blocks, retries, and active recovery", () => {
    const awaiting = next(runningState(), "approval_required", {
      approvalId: "approval:one",
      reason: "Exact approval required.",
      humanResumable: true,
    });
    expect(awaiting.status).toBe("awaiting-approval");
    expect(awaiting.approvalId).toBe("approval:one");
    const approvalResumed = next(awaiting, "recovered", {
      fromStatus: "awaiting-approval",
      toStatus: "queued",
      action: "human-resume",
      reason: "approval:exact",
      leaseExpiresAt: null,
    });
    expect(approvalResumed.route).toBeNull();
    expect(approvalResumed.dispatch).toBeNull();

    const fingerprint = "a".repeat(64);
    const blocked = next(runningState(), "policy_blocked", {
      block: {
        blockId: "block:one",
        operationFingerprint: fingerprint,
        ruleIds: ["policy.test"],
        reason: "Review required.",
        humanResumable: true,
      },
      result: null,
    });
    expect(blocked.status).toBe("policy-blocked");
    const resumed = next(blocked, "recovered", {
      fromStatus: "policy-blocked",
      toStatus: "queued",
      action: "human-resume",
      reason: "approval:exact",
      leaseExpiresAt: null,
    });
    expect(resumed.status).toBe("queued");

    const retry = next(runningState(), "retry_scheduled", {
      attempt: 1,
      runAt: at(30),
      delayMs: 100,
      failureClassification: "disconnected",
    });
    expect(retry.status).toBe("retry-wait");
    const due = next(retry, "recovered", {
      fromStatus: "retry-wait",
      toStatus: "queued",
      action: "retry-due",
      reason: "backoff elapsed",
      leaseExpiresAt: null,
    }, at(31));
    expect(due.status).toBe("queued");
    expect(due.routingDecisionId).toBeNull();

    const active = next(runningState(), "recovered", {
      fromStatus: "running",
      toStatus: "running",
      action: "lease-reconciled",
      reason: "provider confirmed",
      leaseExpiresAt: at(90),
    });
    expect(active.dispatch?.leaseExpiresAt).toBe(at(90));
  });

  it("represents terminal failure, cancellation, and non-resumable policy refusal", () => {
    expect(next(runningState(), "failed", { result: terminalResult("failed") }).status).toBe("failed");
    expect(next(queuedState(), "cancelled", { result: terminalResult("cancelled", { provider: null, startedAt: null }) }).status).toBe("cancelled");
    const deniedDecision = {
      decisionId: "route:denied",
      outcome: "denied",
      selected: null,
      considered: [],
      ruleIds: ["route.no-eligible-candidate"],
      reasons: ["No eligible candidate."],
      decidedAt: at(2),
    };
    const routed = next(queuedState(), "routing_decision", deniedDecision);
    const blocked = next(routed, "policy_blocked", {
      block: {
        blockId: "block:terminal",
        operationFingerprint: "b".repeat(64),
        ruleIds: ["policy.terminal"],
        reason: "Terminal refusal.",
        humanResumable: false,
      },
      result: terminalResult("policy-blocked", { provider: null, startedAt: null }),
    });
    expect(blocked.result?.outcome).toBe("policy-blocked");
  });

  it.each([
    ["sequence gap", (state: OrchestrationRunState) => createOrchestrationEvent({ taskId: state.task.taskId, sequence: 99, occurredAt: at(9), type: "progress", payload: { message: "x", percent: null } })],
    ["task substitution", (state: OrchestrationRunState) => createOrchestrationEvent({ taskId: "task:other", sequence: state.sequence + 1, occurredAt: at(9), type: "progress", payload: { message: "x", percent: null } })],
    ["backwards time", (state: OrchestrationRunState) => createOrchestrationEvent({ taskId: state.task.taskId, sequence: state.sequence + 1, occurredAt: BASE_TIME, type: "progress", payload: { message: "x", percent: null } })],
    ["duplicate queued", (state: OrchestrationRunState) => createOrchestrationEvent({ taskId: state.task.taskId, sequence: state.sequence + 1, occurredAt: at(9), type: "queued", payload: {} })],
    ["unknown progress authority", (state: OrchestrationRunState) => createOrchestrationEvent({ taskId: state.task.taskId, sequence: state.sequence + 1, occurredAt: at(9), type: "progress", payload: { message: "x", percent: null, approval: true } })],
  ])("refuses %s", (_label, makeEvent) => {
    const state = runningState();
    expect(() => applyOrchestrationEvent(state, makeEvent(state))).toThrow();
  });

  it("refuses duplicate terminals, decreasing usage, illegal starts, and corrupt first events", () => {
    const used = next(runningState(), "usage_snapshot", { usage: normalizedUsage({ inputTokens: 100 }) });
    expect(() => next(used, "usage_snapshot", { usage: normalizedUsage({ inputTokens: 99 }) })).toThrow();
    expect(() => next(dispatchedState(), "started", { threadId: "thread:fake", providerRunId: "run:fake", continued: true })).toThrow();
    expect(() => next(runningState(), "started", { threadId: "thread:other", providerRunId: "run:other", continued: false })).toThrow();
    expect(() => next(runningState(), "started", { threadId: "thread:other", providerRunId: "run:other", continued: true })).toThrow();
    const done = next(runningState(), "completed", { result: terminalResult("completed") });
    expect(() => next(done, "cancelled", { result: terminalResult("cancelled") })).toThrowError(/terminal/i);
    expect(() => replayOrchestrationEvents([])).toThrow();
    const badFirst = createOrchestrationEvent({ taskId: "task:one", sequence: 1, occurredAt: BASE_TIME, type: "progress", payload: { message: "x", percent: null } });
    expect(() => replayOrchestrationEvents([badFirst])).toThrow();
  });

  it("binds dispatch to one selected routing decision and refuses pre-routing policy authority", () => {
    const queued = queuedState();
    expect(() => next(queued, "dispatched", {
      attempt: 1,
      dispatchId: "dispatch:forged",
      route: { candidateId: "candidate:fake", providerId: "provider:fake", modelId: "model:fake", profileId: "profile:owned", ownership: "owned" },
      leaseExpiresAt: at(60),
    })).toThrow();
    expect(() => next(queued, "policy_blocked", {
      block: { blockId: "block:forged", operationFingerprint: "a".repeat(64), ruleIds: ["policy.forged"], reason: "forged", humanResumable: false },
      result: terminalResult("policy-blocked", { provider: null, startedAt: null }),
    })).toThrow();

    const routed = next(queued, "routing_decision", selectedDecisionPayload());
    expect(() => next(routed, "routing_decision", selectedDecisionPayload())).toThrow();
    expect(() => next(routed, "dispatched", {
      attempt: 1,
      dispatchId: "dispatch:substituted",
      route: { candidateId: "candidate:other", providerId: "provider:fake", modelId: "model:fake", profileId: "profile:owned", ownership: "owned" },
      leaseExpiresAt: at(60),
    })).toThrow();
    expect(() => next(queued, "routing_decision", { ...selectedDecisionPayload(), considered: [] })).toThrow();
    expect(() => next(queued, "routing_decision", { ...selectedDecisionPayload(), outcome: "denied" })).toThrow();
  });

  it("binds terminal usage, time, and provider identity to durable state", () => {
    const running = runningState();
    expect(() => next(running, "completed", { result: terminalResult("completed", { provider: { ...terminalResult().provider!, threadId: "thread:other" } }) })).toThrow();
    expect(() => next(running, "completed", { result: terminalResult("completed", { finishedAt: "2026-08-11T00:00:00.000Z" }) })).toThrow();
    const used = next(running, "usage_snapshot", { usage: normalizedUsage({ inputTokens: 100 }) });
    expect(() => next(used, "completed", { result: terminalResult("completed", { usage: normalizedUsage({ inputTokens: 99 }) }) })).toThrow();
    expect(() => next(dispatchedState(), "failed", { result: terminalResult("failed") })).toThrow();
  });

  it("refuses duplicate event ids and forged queued fingerprints", () => {
    const value = task();
    const first = createOrchestrationEvent({ taskId: value.taskId, sequence: 1, occurredAt: at(1), type: "queued", payload: { task: value, taskFingerprint: taskFingerprint(value) } });
    const duplicate = { ...first, sequence: 2, type: "routing_decision" as const, payload: selectedDecisionPayload() };
    expect(() => replayOrchestrationEvents([first, duplicate])).toThrow(/Duplicate event/i);
    const forged = createOrchestrationEvent({ taskId: value.taskId, sequence: 1, occurredAt: at(1), type: "queued", payload: { task: value, taskFingerprint: "f".repeat(64) } });
    expect(() => replayOrchestrationEvents([forged])).toThrow();
    const futureTask = task({ createdAt: "2026-08-10T10:00:02.000Z", deadline: "2026-08-10T12:00:00.000Z" });
    const premature = createOrchestrationEvent({ taskId: futureTask.taskId, sequence: 1, occurredAt: at(1), type: "queued", payload: { task: futureTask, taskFingerprint: taskFingerprint(futureTask) } });
    expect(() => replayOrchestrationEvents([premature])).toThrow(/before its creation/i);
  });

  it("exposes typed scheduler errors without treating ordinary errors as scheduler errors", () => {
    const error = new SchedulerError("INVALID_TASK", "bad", { field: "task" });
    expect(isSchedulerError(error)).toBe(true);
    expect(isSchedulerError(new Error("bad"))).toBe(false);
    expect(error.details).toEqual({ field: "task" });
  });
});
