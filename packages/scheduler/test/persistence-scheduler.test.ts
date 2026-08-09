import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import { createSqlitePersistenceAdapter } from "@ai-dev-os/persistence-sqlite";
import { describe, expect, it } from "vitest";
import {
  SchedulerError,
  createOrchestrationStore,
  createProductionDisabledScheduler,
  type AgentAdapterSignal,
  type OrchestrationTerminalResult,
} from "../src/index.js";
import { createFakeAgentHarness, createTestingScheduler } from "../src/testing/index.js";
import {
  BASE_TIME,
  ManualClock,
  candidate,
  dispatchInput,
  normalizedUsage,
  task,
  terminalResult,
  usageSnapshot,
} from "./fixtures.js";

function memory(clock = new ManualClock()) {
  return createMemoryPersistenceAdapter({ clock });
}

describe("durable orchestration store", () => {
  it("atomically submits, replays, lists, and deduplicates exact tasks", async () => {
    const store = createOrchestrationStore({ adapter: memory() });
    const value = task();
    const created = await store.submit(value, BASE_TIME);
    expect(created.outcome).toBe("created");
    expect((await store.submit(structuredClone(value), BASE_TIME)).outcome).toBe("duplicate");
    expect((await store.get(value.idempotencyKey))?.task).toEqual(value);
    expect(await store.get("idempotency:missing")).toBeNull();
    expect(await store.list()).toHaveLength(1);
    expect(await store.history(value.idempotencyKey)).toHaveLength(1);
    await expect(store.submit({ ...value, objective: "different" }, BASE_TIME)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await store.close();
    await store.close();
    await expect(store.get(value.idempotencyKey)).rejects.toMatchObject({ code: "STATE_CORRUPTION" });
  });

  it("rolls back a submit and append when a fault occurs between aggregate and event writes", async () => {
    const adapter = memory();
    let fail = true;
    const store = createOrchestrationStore({
      adapter,
      fault: () => { if (fail) throw new Error("injected atomicity fault"); },
    });
    await expect(store.submit(task(), BASE_TIME)).rejects.toThrow(/atomicity fault/);
    expect(await store.get(task().idempotencyKey)).toBeNull();
    fail = false;
    await store.submit(task(), BASE_TIME);
    fail = true;
    await expect(store.append(task().idempotencyKey, "cancelled", {
      result: terminalResult("cancelled", { provider: null, startedAt: null }),
    }, "2026-08-10T10:00:01.000Z")).rejects.toThrow(/atomicity fault/);
    expect((await store.get(task().idempotencyKey))?.sequence).toBe(1);
    expect(await store.history(task().idempotencyKey)).toHaveLength(1);
    fail = false;
    await store.close();
  });

  it("detects aggregate/journal disagreement instead of selecting one", async () => {
    const adapter = memory();
    const store = createOrchestrationStore({ adapter });
    await store.submit(task(), BASE_TIME);
    const aggregateId = `orchestration:${createHash("sha256").update(task().idempotencyKey).digest("hex").slice(0, 40)}`;
    await adapter.transact(async (tx) => {
      const envelope = await tx.aggregates.get("task-run", aggregateId);
      if (envelope === null) throw new Error("missing test aggregate");
      await tx.aggregates.update({
        aggregateType: "task-run",
        aggregateId,
        schemaVersion: 1,
        payload: { ...(envelope.payload as Record<string, unknown>), status: "completed" } as never,
        expectedVersion: envelope.aggregateVersion,
        traceId: null,
      });
    });
    await expect(store.get(task().idempotencyKey)).rejects.toMatchObject({ code: "STATE_CORRUPTION" });
    await store.close();
  });

  it("paginates a long journal without changing replay", async () => {
    const store = createOrchestrationStore({ adapter: memory() });
    const value = task({ budget: { ...task().budget, maximumTurns: 4 } });
    let state = (await store.submit(value, BASE_TIME)).state;
    const route = candidate();
    const decision = {
      decisionId: "route:one",
      outcome: "selected",
      selected: { candidateId: route.candidateId, providerId: route.providerId, modelId: route.modelId, profileId: route.profileId, ownership: route.ownership },
      considered: [{
        candidate: { candidateId: route.candidateId, providerId: route.providerId, modelId: route.modelId, profileId: route.profileId, ownership: route.ownership },
        eligible: true,
        score: 1_400,
        ruleIds: [],
        reasons: [],
      }],
      ruleIds: ["route.deterministic-selection"],
      reasons: ["selected"],
      decidedAt: "2026-08-10T10:00:01.000Z",
    };
    state = await store.append(value.idempotencyKey, "routing_decision", decision, "2026-08-10T10:00:01.000Z");
    state = await store.append(value.idempotencyKey, "dispatched", {
      attempt: 1,
      dispatchId: "dispatch:long",
      route: decision.selected,
      leaseExpiresAt: "2026-08-10T11:00:00.000Z",
    }, "2026-08-10T10:00:02.000Z");
    state = await store.append(value.idempotencyKey, "started", { threadId: "thread:long", providerRunId: "run:long", continued: false }, "2026-08-10T10:00:03.000Z");
    for (let index = 0; index < 105; index++) {
      state = await store.append(value.idempotencyKey, "progress", { message: `step ${index}`, percent: null }, new Date(Date.parse(BASE_TIME) + 4_000 + index).toISOString());
    }
    expect(state.sequence).toBe(109);
    expect(await store.history(value.idempotencyKey)).toHaveLength(109);
    expect((await store.get(value.idempotencyKey))?.sequence).toBe(109);
    await store.close();
  });

  it("survives a file-backed SQLite close and reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-dev-os-scheduler-"));
    const file = join(directory, "scheduler.db");
    try {
      const first = createOrchestrationStore({ adapter: createSqlitePersistenceAdapter({ file, journalMode: "delete" }) });
      await first.submit(task(), BASE_TIME);
      await first.append(task().idempotencyKey, "cancelled", {
        result: terminalResult("cancelled", { provider: null, startedAt: null }),
      }, "2026-08-10T10:00:01.000Z");
      await first.close();

      const reopened = createOrchestrationStore({ adapter: createSqlitePersistenceAdapter({ file, journalMode: "delete" }) });
      expect((await reopened.get(task().idempotencyKey))?.status).toBe("cancelled");
      expect(await reopened.history(task().idempotencyKey)).toHaveLength(2);
      await reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rolls back a SQLite append fault between aggregate and journal writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-dev-os-scheduler-rollback-"));
    const file = join(directory, "scheduler.db");
    try {
      let fail = false;
      const store = createOrchestrationStore({
        adapter: createSqlitePersistenceAdapter({ file, journalMode: "delete" }),
        fault: () => { if (fail) throw new Error("sqlite atomicity fault"); },
      });
      await store.submit(task(), BASE_TIME);
      fail = true;
      await expect(store.append(task().idempotencyKey, "cancelled", {
        result: terminalResult("cancelled", { provider: null, startedAt: null }),
      }, "2026-08-10T10:00:01.000Z")).rejects.toThrow(/sqlite atomicity fault/);
      expect((await store.get(task().idempotencyKey))?.sequence).toBe(1);
      expect(await store.history(task().idempotencyKey)).toHaveLength(1);
      fail = false;
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("production-disabled scheduler", () => {
  it("durably blocks after routing without invoking any provider", async () => {
    const clock = new ManualClock();
    const audit: string[] = [];
    const scheduler = createProductionDisabledScheduler({ persistence: memory(clock), clock, audit: (record) => audit.push(`${record.sequence}:${record.eventType}`) });
    await scheduler.submit(task());
    const result = await scheduler.dispatch(task().idempotencyKey, dispatchInput());
    expect(result.status).toBe("policy-blocked");
    expect(result.result?.outcome).toBe("policy-blocked");
    expect(result.block?.ruleIds).toContain("orchestration.stage18a.production-disabled");
    expect((await scheduler.history(task().idempotencyKey)).map((event) => event.type)).toEqual(["queued", "routing_decision", "policy_blocked"]);
    expect(audit).toEqual(["1:queued", "2:routing_decision", "3:policy_blocked"]);
    await scheduler.close();
  });

  it("records a terminal no-route policy result and is idempotent after terminal", async () => {
    const clock = new ManualClock();
    const scheduler = createProductionDisabledScheduler({ persistence: memory(clock), clock });
    await scheduler.submit(task());
    const blocked = await scheduler.dispatch(task().idempotencyKey, dispatchInput({ candidates: [], usageSnapshots: [] }));
    expect(blocked.block?.ruleIds).toEqual(["route.no-eligible-candidate"]);
    expect(await scheduler.dispatch(task().idempotencyKey, dispatchInput())).toEqual(blocked);
    await scheduler.close();
  });

  it("validates configuration and unknown task lookup", async () => {
    expect(() => createProductionDisabledScheduler({ persistence: memory(), configuration: { maximumConcurrency: 0, leaseDurationMs: 30_000, usageFreshnessMs: 1_000 } })).toThrow(SchedulerError);
    const scheduler = createProductionDisabledScheduler({ persistence: memory() });
    await expect(scheduler.dispatch("idempotency:missing", dispatchInput())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await scheduler.close();
  });
});

describe("deterministic fake lifecycle scheduler", () => {
  it("streams progress, checkpoint, cumulative usage, continuation, and completion", async () => {
    const clock = new ManualClock();
    const continuationSignals: AgentAdapterSignal[] = [];
    const fake = createFakeAgentHarness({
      script: {
        start: [{ signals: [
          { type: "progress", message: "working", percent: 10 },
          { type: "checkpoint", checkpointId: "checkpoint:start", kind: "source", artifactIds: [] },
          { type: "usage", usage: normalizedUsage({ inputTokens: 10, outputTokens: 1 }) },
        ] }],
        continue: [{ signals: continuationSignals }],
      },
    });
    const scheduler = createTestingScheduler({ persistence: memory(clock), clock, adapter: fake.adapter });
    await scheduler.submit(task());
    const running = await scheduler.dispatch(task().idempotencyKey, dispatchInput());
    expect(running.status).toBe("running");
    expect(running.turns).toBe(1);
    continuationSignals.push(
      { type: "usage", usage: normalizedUsage({ inputTokens: 20, outputTokens: 5, toolCalls: 1 }) },
      { type: "completed", result: terminalResult("completed", {
        usage: normalizedUsage({ inputTokens: 20, outputTokens: 5, toolCalls: 1 }),
        provider: {
          providerId: "provider:fake",
          modelId: "model:fake",
          profileId: "profile:owned",
          threadId: running.threadId ?? "missing",
          providerRunId: running.providerRunId ?? "missing",
        },
      }) },
    );
    clock.advance(1_000);
    const completed = await scheduler.continue(task().idempotencyKey, "Finish the bounded fake turn.");
    expect(completed.status).toBe("completed");
    expect(completed.turns).toBe(2);
    expect(completed.usage.toolCalls).toBe(1);
    expect(fake.observations.map((item) => item.operation)).toEqual(["start", "continue"]);
    await scheduler.close();
    expect(fake.observations.at(-1)?.operation).toBe("close");
  });

  it("cancels durably and asks the exact adapter session to stop", async () => {
    const clock = new ManualClock();
    const fake = createFakeAgentHarness({ script: { start: [{ signals: [] }] } });
    const scheduler = createTestingScheduler({ persistence: memory(clock), clock, adapter: fake.adapter });
    await scheduler.submit(task());
    const running = await scheduler.dispatch(task().idempotencyKey, dispatchInput());
    const cancelled = await scheduler.cancel(task().idempotencyKey, "operator requested");
    expect(cancelled.status).toBe("cancelled");
    expect(fake.observations.at(-1)).toMatchObject({ operation: "cancel", threadId: running.threadId });
    expect(await scheduler.cancel(task().idempotencyKey, "duplicate")).toEqual(cancelled);
    await scheduler.close();
  });

  it("backs off a disconnect, becomes queued when due, and retries with a new bounded attempt", async () => {
    const clock = new ManualClock();
    const fake = createFakeAgentHarness({ script: { start: [{ throws: true }, { signals: [] }] } });
    const scheduler = createTestingScheduler({ persistence: memory(clock), clock, adapter: fake.adapter });
    await scheduler.submit(task());
    const waiting = await scheduler.dispatch(task().idempotencyKey, dispatchInput());
    expect(waiting.status).toBe("retry-wait");
    expect(waiting.nextAttemptAt).toBe("2026-08-10T10:00:00.100Z");
    expect(await scheduler.tick()).toEqual([]);
    clock.advance(100);
    expect((await scheduler.tick())[0]?.status).toBe("queued");
    const retried = await scheduler.dispatch(task().idempotencyKey, dispatchInput());
    expect(retried.status).toBe("running");
    expect(retried.attempt).toBe(2);
    await scheduler.close();
  });

  it("persists a zero-delay retry at one exact timestamp without backwards time", async () => {
    const clock = new ManualClock();
    const immediate = task({
      taskId: "task:zero-backoff",
      idempotencyKey: "idempotency:zero-backoff",
      retry: { ...task().retry, initialBackoffMs: 0, maximumBackoffMs: 0 },
    });
    const fake = createFakeAgentHarness({ script: { start: [{ throws: true }] } });
    const scheduler = createTestingScheduler({ persistence: memory(clock), clock, adapter: fake.adapter });
    await scheduler.submit(immediate);
    const waiting = await scheduler.dispatch(immediate.idempotencyKey, dispatchInput());
    expect(waiting.nextAttemptAt).toBe(BASE_TIME);
    expect((await scheduler.tick())[0]?.status).toBe("queued");
    await scheduler.close();
  });

  it("fails when attempts are exhausted or the adapter provider identity differs", async () => {
    const clock = new ManualClock();
    const oneAttempt = task({ retry: { ...task().retry, maximumAttempts: 1 } });
    const disconnect = createFakeAgentHarness({ script: { start: [{ throws: true }] } });
    const first = createTestingScheduler({ persistence: memory(clock), clock, adapter: disconnect.adapter });
    await first.submit(oneAttempt);
    expect((await first.dispatch(oneAttempt.idempotencyKey, dispatchInput())).status).toBe("failed");
    await first.close();

    const mismatchTask = task({ taskId: "task:mismatch", idempotencyKey: "idempotency:mismatch" });
    const mismatch = createFakeAgentHarness({ providerId: "provider:other", script: { start: [] } });
    const second = createTestingScheduler({ persistence: memory(clock), clock, adapter: mismatch.adapter });
    await second.submit(mismatchTask);
    expect((await second.dispatch(mismatchTask.idempotencyKey, dispatchInput())).result?.failure?.code).toBe("provider-identity-mismatch");
    await second.close();
  });

  it("enforces concurrency, turn, instruction, and deadline bounds", async () => {
    const clock = new ManualClock();
    const fake = createFakeAgentHarness({ script: { start: [{ signals: [] }, { signals: [] }], continue: [{ signals: [] }] } });
    const scheduler = createTestingScheduler({
      persistence: memory(clock),
      clock,
      adapter: fake.adapter,
      configuration: { maximumConcurrency: 1, leaseDurationMs: 1_000, usageFreshnessMs: 60_000 },
    });
    const firstTask = task({ taskId: "task:first", idempotencyKey: "idempotency:first", budget: { ...task().budget, maximumTurns: 1 } });
    const secondTask = task({ taskId: "task:second", idempotencyKey: "idempotency:second" });
    await scheduler.submit(firstTask);
    await scheduler.submit(secondTask);
    await scheduler.dispatch(firstTask.idempotencyKey, dispatchInput());
    await expect(scheduler.dispatch(secondTask.idempotencyKey, dispatchInput())).rejects.toMatchObject({ code: "CONCURRENCY_LIMIT" });
    expect((await scheduler.continue(firstTask.idempotencyKey, "one more")).result?.failure?.code).toBe("turn-ceiling-exhausted");
    await expect(scheduler.continue(firstTask.idempotencyKey, "")).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    clock.set(task().deadline);
    const changes = await scheduler.tick();
    expect(changes.some((state) => state.task.taskId === secondTask.taskId && state.status === "cancelled")).toBe(true);
    await scheduler.close();
  });

  it("keeps provider policy blocks on the same task and requires exact human-resume evidence", async () => {
    const clock = new ManualClock();
    const fake = createFakeAgentHarness({ script: { start: [{ signals: [{ type: "policy-blocked", code: "approval-required", reason: "Review exact operation.", humanResumable: true }] }, { signals: [] }] } });
    const scheduler = createTestingScheduler({ persistence: memory(clock), clock, adapter: fake.adapter });
    await scheduler.submit(task());
    const blocked = await scheduler.dispatch(task().idempotencyKey, dispatchInput());
    expect(blocked.status).toBe("policy-blocked");
    expect(blocked.result).toBeNull();
    await expect(scheduler.resumeBlocked(task().idempotencyKey, "approval:one", "f".repeat(64))).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    const queued = await scheduler.resumeBlocked(task().idempotencyKey, "approval:one", blocked.block?.operationFingerprint ?? "missing");
    expect(queued.status).toBe("queued");
    expect((await scheduler.dispatch(task().idempotencyKey, dispatchInput())).attempt).toBe(2);
    await scheduler.close();
  });

  it("binds approval waits to the exact approval id and evidence reference", async () => {
    const clock = new ManualClock();
    const fake = createFakeAgentHarness({ script: { start: [{ signals: [{ type: "approval-required", approvalId: "approval:one", reason: "Review exact request." }] }, { signals: [] }] } });
    const scheduler = createTestingScheduler({ persistence: memory(clock), clock, adapter: fake.adapter });
    await scheduler.submit(task());
    const awaiting = await scheduler.dispatch(task().idempotencyKey, dispatchInput());
    expect(awaiting.status).toBe("awaiting-approval");
    await expect(scheduler.resumeApproval(task().idempotencyKey, "approval:other", "evidence:one")).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    const queued = await scheduler.resumeApproval(task().idempotencyKey, "approval:one", "evidence:one");
    expect(queued.status).toBe("queued");
    expect(queued.approvalId).toBeNull();
    await scheduler.close();
  });

  it("terminates deterministically when normalized usage crosses a task budget", async () => {
    const clock = new ManualClock();
    const limited = task({ budget: { ...task().budget, maximumInputTokens: 10 } });
    const fake = createFakeAgentHarness({ script: { start: [{ signals: [{ type: "usage", usage: normalizedUsage({ inputTokens: 11 }) }] }] } });
    const scheduler = createTestingScheduler({ persistence: memory(clock), clock, adapter: fake.adapter });
    await scheduler.submit(limited);
    const failed = await scheduler.dispatch(limited.idempotencyKey, dispatchInput());
    expect(failed.status).toBe("failed");
    expect(failed.result?.failure).toMatchObject({ classification: "usage", code: "usage-budget-exceeded", retryable: false });
    await scheduler.close();
  });

  it("reconciles expired leases by provider status and resumes only the exact retained thread", async () => {
    const clock = new ManualClock();
    const resumeSignals: AgentAdapterSignal[] = [];
    const fake = createFakeAgentHarness({ script: { start: [{ signals: [] }], resume: [{ signals: resumeSignals }] } });
    const scheduler = createTestingScheduler({
      persistence: memory(clock),
      clock,
      adapter: fake.adapter,
      configuration: { maximumConcurrency: 4, leaseDurationMs: 100, usageFreshnessMs: 60_000 },
    });
    await scheduler.submit(task());
    let running = await scheduler.dispatch(task().idempotencyKey, dispatchInput());
    const dispatchId = running.dispatch?.dispatchId ?? "missing";
    clock.advance(100);
    fake.setStatus(dispatchId, "running");
    running = await scheduler.recover(task().idempotencyKey);
    expect(running.status).toBe("running");
    expect((await scheduler.history(task().idempotencyKey)).at(-1)?.type).toBe("recovered");

    clock.advance(100);
    fake.setStatus(dispatchId, "disconnected");
    resumeSignals.push({ type: "completed", result: terminalResult("completed", {
      provider: {
        providerId: "provider:fake",
        modelId: "model:fake",
        profileId: "profile:owned",
        threadId: running.threadId ?? "missing",
        providerRunId: running.providerRunId ?? "missing",
      },
    }) });
    const completed = await scheduler.recover(task().idempotencyKey);
    expect(completed.status).toBe("completed");
    expect(fake.observations.some((item) => item.operation === "resume" && item.threadId === running.threadId)).toBe(true);
    await scheduler.close();
  });

  it("reconciles provider terminal status and refuses a missing terminal result", async () => {
    async function scenario(status: "completed" | "failed", result: OrchestrationTerminalResult | null) {
      const clock = new ManualClock();
      const fake = createFakeAgentHarness({ script: { start: [{ signals: [] }] } });
      const scheduler = createTestingScheduler({ persistence: memory(clock), clock, adapter: fake.adapter, configuration: { maximumConcurrency: 4, leaseDurationMs: 100, usageFreshnessMs: 60_000 } });
      const value = task({ taskId: `task:${status}:${result === null ? "missing" : "present"}`, idempotencyKey: `idempotency:${status}:${result === null ? "missing" : "present"}` });
      await scheduler.submit(value);
      const running = await scheduler.dispatch(value.idempotencyKey, dispatchInput());
      const id = running.dispatch?.dispatchId ?? "missing";
      fake.setStatus(id, status);
      fake.setResult(id, result === null ? null : {
        ...result,
        provider: {
          providerId: running.route?.providerId ?? "missing",
          modelId: running.route?.modelId ?? "missing",
          profileId: running.route?.profileId ?? "missing",
          threadId: running.threadId ?? "missing",
          providerRunId: running.providerRunId ?? "missing",
        },
      });
      clock.advance(100);
      const recovered = await scheduler.recover(value.idempotencyKey);
      await scheduler.close();
      return recovered;
    }
    expect((await scenario("completed", terminalResult("completed"))).status).toBe("completed");
    expect((await scenario("failed", terminalResult("failed"))).status).toBe("failed");
    expect((await scenario("completed", null)).result?.failure?.code).toBe("terminal-result-missing");
  });
});
