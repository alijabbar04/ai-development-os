import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { toCanonicalJson } from "@ai-dev-os/domain";
import type {
  PersistenceAdapter,
  TransactionContext,
} from "@ai-dev-os/persistence";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import { createSqlitePersistenceAdapter } from "@ai-dev-os/persistence-sqlite";
import {
  createProductionDisabledWorkerRuntime,
  createWorkerRuntimeEvent,
  parseProviderCircuitEvidence,
  parseWorkerRuntimeCommand,
  parseWorkerRuntimeEvent,
  parseWorkerWorkDefinition,
  replayWorkerRuntimeEvents,
  type NormalizedCanonicalUsageSnapshot,
  type DurableWorkerRuntime,
  type ProviderCircuitEvidence,
  type UsageSnapshotAdapter,
  type WorkerRuntimeConfiguration,
  type WorkerRuntimeState,
  type WorkerWorkDefinition,
} from "../src/index.js";
import {
  BASE_TIME,
  ManualClock,
  candidate,
  normalizedUsage,
  task,
  usageSnapshot,
} from "./fixtures.js";

const CONFIGURATION: WorkerRuntimeConfiguration = Object.freeze({
  maximumQueueDepth: 8,
  maximumRetainedWorkItems: 64,
  leaseDurationMs: 1_000,
  maximumLeaseRenewalsPerAttempt: 8,
  usageReadTimeoutMs: 100,
  usageFreshnessMs: 60_000,
  circuitFreshnessMs: 60_000,
  starvationAgingMs: 10_000,
  capacityPools: Object.freeze([
    Object.freeze({ poolId: "default", maximumActive: 1 }),
    Object.freeze({ poolId: "parallel", maximumActive: 4 }),
  ]),
});

function definition(
  name: string,
  overrides: {
    readonly priority?: "low" | "normal" | "high" | "critical";
    readonly createdAt?: string;
    readonly readyAt?: string;
    readonly maximumAttempts?: number;
    readonly capacityPool?: string;
    readonly fairnessKey?: string;
    readonly estimatedCostMicros?: number | null;
    readonly estimatedInputTokens?: number;
    readonly maximumInputTokens?: number;
    readonly dispatchMs?: number;
    readonly attemptMs?: number;
    readonly profileId?: string;
    readonly ownership?: "owned" | "authorized-borrowed";
    readonly predictedFiveHourBasisPoints?: number;
    readonly predictedWeeklyBasisPoints?: number;
  } = {},
): WorkerWorkDefinition {
  const createdAt = overrides.createdAt ?? BASE_TIME;
  const route = candidate({
    candidateId: `candidate:${name}`,
    profileId: overrides.profileId ?? `profile:${name}`,
    ownership: overrides.ownership ?? "owned",
    predictedFiveHourBasisPoints: overrides.predictedFiveHourBasisPoints ?? 100,
    predictedWeeklyBasisPoints: overrides.predictedWeeklyBasisPoints ?? 100,
    healthObservedAt: createdAt,
  });
  return {
    schemaVersion: 1,
    workId: `work:${name}`,
    task: task({
      taskId: `task:${name}`,
      correlationId: `correlation:${name}`,
      idempotencyKey: `idempotency:${name}:0001`,
      createdAt,
      deadline: "2026-08-10T12:00:00.000Z",
      priority: overrides.priority ?? "normal",
      requestedRoute: {
        providerId: route.providerId,
        modelId: route.modelId,
        profileId: route.profileId,
        ownership: route.ownership,
      },
      budget: {
        ...task().budget,
        maximumInputTokens:
          overrides.maximumInputTokens ?? task().budget.maximumInputTokens,
      },
      retry: {
        ...task().retry,
        maximumAttempts:
          overrides.maximumAttempts ?? task().retry.maximumAttempts,
      },
      timeout: {
        dispatchMs: overrides.dispatchMs ?? task().timeout.dispatchMs,
        attemptMs: overrides.attemptMs ?? task().timeout.attemptMs,
      },
    }),
    candidate: route,
    workloadClass: "general",
    capacityPool: overrides.capacityPool ?? "default",
    fairnessKey: overrides.fairnessKey ?? `tenant:${name}`,
    readyAt: overrides.readyAt ?? createdAt,
    estimatedUsage: normalizedUsage({
      inputTokens: overrides.estimatedInputTokens ?? 10,
      costMicros: overrides.estimatedCostMicros ?? 100,
    }),
  };
}

function snapshotFor(
  state: WorkerRuntimeState,
  overrides: Partial<NormalizedCanonicalUsageSnapshot> = {},
): NormalizedCanonicalUsageSnapshot {
  return usageSnapshot({
    snapshotId: `usage:${state.definition.workId}:${state.attempt}`,
    profileId: state.definition.candidate.profileId,
    providerId: state.definition.candidate.providerId,
    ownership: state.definition.candidate.ownership,
    ...overrides,
  });
}

function circuitFor(
  state: WorkerRuntimeState,
  overrides: Partial<ProviderCircuitEvidence> = {},
): ProviderCircuitEvidence {
  return {
    schemaVersion: 1,
    evidenceId: `circuit:${state.definition.workId}:${state.attempt}`,
    providerId: state.definition.candidate.providerId,
    profileId: state.definition.candidate.profileId,
    state: "closed",
    observedAt: BASE_TIME,
    sourceFingerprint: "b".repeat(64),
    ...overrides,
  };
}

function mutableUsageAdapter(): {
  readonly adapter: UsageSnapshotAdapter;
  set(value: unknown | null): void;
  setReader(reader: (profileId: string) => Promise<unknown | null>): void;
  reads(): number;
} {
  let current: unknown | null = null;
  let reader = async (): Promise<unknown | null> => current;
  let readCount = 0;
  return {
    adapter: Object.freeze({
      adapterId: "adapter:usage:test",
      schemaVersion: 2 as const,
      async readAuthorizedSnapshot(profileId: string): Promise<unknown | null> {
        readCount += 1;
        return reader(profileId);
      },
    }),
    set(value): void {
      current = value;
      reader = async () => current;
    },
    setReader(next): void {
      reader = next;
    },
    reads: () => readCount,
  };
}

function createHarness(
  options: {
    readonly clock?: ManualClock;
    readonly configuration?: WorkerRuntimeConfiguration;
    readonly fault?: () => Promise<void> | void;
  } = {},
): {
  readonly clock: ManualClock;
  readonly usage: ReturnType<typeof mutableUsageAdapter>;
  readonly runtime: DurableWorkerRuntime;
} {
  const clock = options.clock ?? new ManualClock();
  const usage = mutableUsageAdapter();
  const persistence = createMemoryPersistenceAdapter({ clock });
  const runtime = createProductionDisabledWorkerRuntime({
    persistence,
    usageAdapter: usage.adapter,
    clock,
    configuration: options.configuration ?? CONFIGURATION,
    ...(options.fault === undefined ? {} : { fault: options.fault }),
  });
  return { clock, usage, runtime };
}

function pausableMemoryPersistence(clock: ManualClock): {
  readonly adapter: PersistenceAdapter;
  pauseNext(): { readonly entered: Promise<void>; release(): void };
} {
  const inner = createMemoryPersistenceAdapter({ clock });
  let barrier: {
    readonly entered: () => void;
    readonly wait: Promise<void>;
  } | null = null;
  return {
    adapter: {
      async transact<T>(
        work: (tx: TransactionContext) => Promise<T> | T,
      ): Promise<T> {
        const pending = barrier;
        if (pending !== null) {
          barrier = null;
          pending.entered();
          await pending.wait;
        }
        return inner.transact(work);
      },
      migrationStatus: () => inner.migrationStatus(),
      close: () => inner.close(),
    },
    pauseNext() {
      let markEntered!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      barrier = { entered: markEntered, wait };
      return { entered, release };
    },
  };
}

async function enqueueAndClaim(
  runtime: DurableWorkerRuntime,
  work: WorkerWorkDefinition,
  workerId = "worker:one",
): Promise<WorkerRuntimeState> {
  await runtime.enqueue({
    type: "enqueue-work",
    commandId: `command:enqueue:${work.workId}`,
    definition: work,
  });
  const claimed = await runtime.claim({
    type: "claim-work",
    commandId: `command:claim:${work.workId}:${workerId}`,
    workerId,
    allowedCapacityPools: [work.capacityPool],
  });
  if (claimed === null)
    throw new Error("fixture claim unexpectedly returned null");
  return claimed;
}

function fenced(state: WorkerRuntimeState) {
  if (state.lease === null) throw new Error("fixture state has no lease");
  return {
    idempotencyKey: state.definition.task.idempotencyKey,
    leaseId: state.lease.leaseId,
    workerId: state.lease.workerId,
    fencingToken: state.lease.fencingToken,
  };
}

async function startDispatch(
  runtime: DurableWorkerRuntime,
  usage: ReturnType<typeof mutableUsageAdapter>,
  claimed: WorkerRuntimeState,
): Promise<WorkerRuntimeState> {
  usage.set(snapshotFor(claimed));
  const reserved = await runtime.reserveUsage({
    type: "reserve-usage",
    commandId: `command:reserve:${claimed.definition.workId}:${claimed.attempt}`,
    ...fenced(claimed),
    circuit: circuitFor(claimed),
  });
  const prepared = await runtime.prepareDispatch({
    type: "prepare-dispatch",
    commandId: `command:prepare:${claimed.definition.workId}:${claimed.attempt}`,
    ...fenced(reserved),
    circuit: circuitFor(reserved),
  });
  if (prepared.dispatch === null)
    throw new Error("fixture dispatch was not prepared");
  return runtime.markDispatchStarted({
    type: "mark-dispatch-started",
    commandId: `command:start:${claimed.definition.workId}:${claimed.attempt}`,
    ...fenced(prepared),
    dispatchId: prepared.dispatch.dispatchId,
  });
}

describe("Stage 18C durable worker runtime", () => {
  it("enqueues idempotently, rejects conflicting reuse, and enforces durable backpressure", async () => {
    const configuration = { ...CONFIGURATION, maximumQueueDepth: 1 };
    const { runtime } = createHarness({ configuration });
    const first = definition("first");
    await expect(
      runtime.enqueue({
        type: "enqueue-work",
        commandId: "command:enqueue:first",
        definition: first,
      }),
    ).resolves.toMatchObject({
      outcome: "created",
      state: { status: "ready" },
    });
    await expect(
      runtime.enqueue({
        type: "enqueue-work",
        commandId: "command:enqueue:first:duplicate",
        definition: first,
      }),
    ).resolves.toMatchObject({ outcome: "duplicate" });
    await expect(
      runtime.enqueue({
        type: "enqueue-work",
        commandId: "command:enqueue:first:conflict",
        definition: { ...first, workId: "work:mutated" },
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      runtime.enqueue({
        type: "enqueue-work",
        commandId: "command:enqueue:first:identity-conflict",
        definition: {
          ...first,
          task: {
            ...first.task,
            idempotencyKey: "idempotency:first:alternate:0001",
          },
        },
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      runtime.enqueue({
        type: "enqueue-work",
        commandId: "command:enqueue:second",
        definition: definition("second"),
      }),
    ).rejects.toMatchObject({ code: "BACKPRESSURE" });
    await runtime.close();
  });

  it("bounds retained history, isolates worker aggregates, and preserves enqueue idempotency at the cap", async () => {
    const clock = new ManualClock();
    const persistence = createMemoryPersistenceAdapter({ clock });
    await persistence.transact(async (tx) => {
      for (let index = 0; index < 125; index += 1) {
        await tx.aggregates.create({
          aggregateType: "task-run",
          aggregateId: `orchestration:${index.toString().padStart(3, "0")}`,
          schemaVersion: 1,
          payload: { source: "stage-18a-isolation-fixture" },
        });
      }
    });
    const usage = mutableUsageAdapter();
    const runtime = createProductionDisabledWorkerRuntime({
      persistence,
      usageAdapter: usage.adapter,
      clock,
      configuration: { ...CONFIGURATION, maximumRetainedWorkItems: 1 },
    });
    const first = definition("retained-first");
    const enqueue = {
      type: "enqueue-work" as const,
      commandId: "command:enqueue:retained-first",
      definition: first,
    };
    await expect(runtime.enqueue(enqueue)).resolves.toMatchObject({
      outcome: "created",
    });
    const cancelled = await runtime.cancel({
      type: "cancel-work",
      commandId: "command:cancel:retained-first",
      idempotencyKey: first.task.idempotencyKey,
      code: "operator-cancelled",
    });
    expect(cancelled.status).toBe("cancelled");
    await expect(runtime.enqueue(enqueue)).resolves.toMatchObject({
      outcome: "duplicate",
    });
    await expect(
      runtime.enqueue({ ...enqueue, commandId: "command:semantic-duplicate" }),
    ).resolves.toMatchObject({ outcome: "duplicate" });
    await expect(
      runtime.enqueue({
        ...enqueue,
        commandId: "command:cancel:retained-first",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      runtime.enqueue({
        type: "enqueue-work",
        commandId: "command:enqueue:retained-second",
        definition: definition("retained-second"),
      }),
    ).rejects.toMatchObject({ code: "BACKPRESSURE" });
    await expect(runtime.list()).resolves.toHaveLength(1);
    await runtime.close();
  });

  it("serializes concurrent logical claims and enforces capacity pools", async () => {
    const { runtime } = createHarness();
    const first = definition("concurrent-one");
    const second = definition("concurrent-two");
    await runtime.enqueue({
      type: "enqueue-work",
      commandId: "command:enqueue:concurrent-one",
      definition: first,
    });
    await runtime.enqueue({
      type: "enqueue-work",
      commandId: "command:enqueue:concurrent-two",
      definition: second,
    });
    const claims = await Promise.all([
      runtime.claim({
        type: "claim-work",
        commandId: "command:claim:a",
        workerId: "worker:a",
        allowedCapacityPools: ["default"],
      }),
      runtime.claim({
        type: "claim-work",
        commandId: "command:claim:b",
        workerId: "worker:b",
        allowedCapacityPools: ["default"],
      }),
    ]);
    expect(claims.filter((value) => value !== null)).toHaveLength(1);
    expect(
      await runtime.claim({
        type: "claim-work",
        commandId: "command:claim:c",
        workerId: "worker:c",
        allowedCapacityPools: ["default"],
      }),
    ).toBeNull();
    await runtime.close();
  });

  it("ages ready work deterministically without crossing explicit priority bounds", async () => {
    const clock = new ManualClock();
    const { runtime } = createHarness({ clock });
    const old = definition("old-low", {
      priority: "low",
      createdAt: "2026-08-10T09:59:20.000Z",
      readyAt: "2026-08-10T09:59:20.000Z",
      capacityPool: "parallel",
    });
    const recent = definition("recent-high", {
      priority: "high",
      capacityPool: "parallel",
    });
    await runtime.enqueue({
      type: "enqueue-work",
      commandId: "command:enqueue:old",
      definition: old,
    });
    await runtime.enqueue({
      type: "enqueue-work",
      commandId: "command:enqueue:recent",
      definition: recent,
    });
    const first = await runtime.claim({
      type: "claim-work",
      commandId: "command:claim:aged",
      workerId: "worker:aged",
      allowedCapacityPools: ["parallel"],
    });
    expect(first?.definition.workId).toBe("work:old-low");
    await runtime.close();
  });

  it("renews active leases, retries exact expiry, and monotonically fences stale workers", async () => {
    const { clock, runtime } = createHarness();
    const claimed = await enqueueAndClaim(
      runtime,
      definition("lease", { dispatchMs: 60_000 }),
    );
    await expect(
      runtime.renew({
        type: "renew-lease",
        commandId: "command:renew:wrong-token",
        ...fenced(claimed),
        fencingToken: claimed.lease!.fencingToken + 1,
      }),
    ).rejects.toMatchObject({ code: "FENCING_REJECTED" });
    clock.advance(100);
    const renewed = await runtime.renew({
      type: "renew-lease",
      commandId: "command:renew:lease",
      ...fenced(claimed),
    });
    expect(renewed.lease?.expiresAt > claimed.lease!.expiresAt).toBe(true);
    clock.set(renewed.lease!.expiresAt);
    const changed = await runtime.tick();
    expect(changed[0]).toMatchObject({
      status: "retry-wait",
      attempt: 1,
      lease: null,
    });
    await expect(
      runtime.renew({
        type: "renew-lease",
        commandId: "command:renew:stale",
        ...fenced(claimed),
      }),
    ).rejects.toMatchObject({ code: "FENCING_REJECTED" });
    clock.advance(100);
    await runtime.tick();
    const reclaimed = await runtime.claim({
      type: "claim-work",
      commandId: "command:claim:lease:two",
      workerId: "worker:two",
      allowedCapacityPools: ["default"],
    });
    expect(reclaimed).toMatchObject({ attempt: 2, lastFencingToken: 2 });
    await runtime.close();
  });

  it("caps lease renewal count and lease lifetime at dispatch and attempt timeouts", async () => {
    const clock = new ManualClock();
    const configuration = {
      ...CONFIGURATION,
      leaseDurationMs: 10_000,
      maximumLeaseRenewalsPerAttempt: 1,
    };
    const { runtime } = createHarness({ clock, configuration });
    const claimed = await enqueueAndClaim(
      runtime,
      definition("bounded-renewal", {
        dispatchMs: 20_000,
        attemptMs: 500,
      }),
    );
    expect(claimed.lease?.expiresAt).toBe(
      new Date(Date.parse(BASE_TIME) + 500).toISOString(),
    );
    clock.advance(100);
    await expect(
      runtime.renew({
        type: "renew-lease",
        commandId: "command:renew:bounded:first",
        ...fenced(claimed),
      }),
    ).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
    clock.set(claimed.lease!.expiresAt);
    await expect(runtime.tick()).resolves.toEqual([
      expect.objectContaining({ status: "retry-wait" }),
    ]);
    await runtime.close();

    const renewalHarness = createHarness({
      configuration: {
        ...CONFIGURATION,
        maximumLeaseRenewalsPerAttempt: 1,
      },
    });
    const renewable = await enqueueAndClaim(
      renewalHarness.runtime,
      definition("renewal-count", { dispatchMs: 60_000 }),
    );
    renewalHarness.clock.advance(100);
    const renewed = await renewalHarness.runtime.renew({
      type: "renew-lease",
      commandId: "command:renew:count:first",
      ...fenced(renewable),
    });
    renewalHarness.clock.advance(100);
    await expect(
      renewalHarness.runtime.renew({
        type: "renew-lease",
        commandId: "command:renew:count:second",
        ...fenced(renewed),
      }),
    ).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
    await renewalHarness.runtime.close();
  });

  it("terminal-fails an expired started dispatch for explicit reconciliation and rejects split brain", async () => {
    const { clock, usage, runtime } = createHarness();
    const claimed = await enqueueAndClaim(runtime, definition("split-brain"));
    const running = await startDispatch(runtime, usage, claimed);
    clock.set(running.lease!.expiresAt);
    const [failed] = await runtime.tick();
    expect(failed).toMatchObject({
      status: "failed",
      terminal: {
        code: "lease-expired-reconciliation-required",
        classification: "disconnected",
      },
      reservation: { status: "reconciliation-required", actualUsage: null },
      dispatch: { status: "terminal" },
    });
    await expect(
      runtime.complete({
        type: "complete-work",
        commandId: "command:complete:stale",
        ...fenced(running),
        dispatchId: running.dispatch!.dispatchId,
        actualUsage: normalizedUsage({ costMicros: 100 }),
      }),
    ).rejects.toMatchObject({ code: "FENCING_REJECTED" });
    const reconciled = await runtime.reconcileUsage({
      type: "reconcile-usage",
      commandId: "command:reconcile:split-brain",
      idempotencyKey: running.definition.task.idempotencyKey,
      reservationId: failed!.reservation!.reservationId,
      dispatchId: failed!.dispatch!.dispatchId,
      actualUsage: normalizedUsage({ inputTokens: 20, costMicros: 200 }),
    });
    expect(reconciled).toMatchObject({
      status: "failed",
      reservation: { status: "reconciled", actualUsage: { inputTokens: 20 } },
      terminal: { actualUsage: { inputTokens: 20 } },
    });
    const duplicate = await runtime.reconcileUsage({
      type: "reconcile-usage",
      commandId: "command:reconcile:split-brain",
      idempotencyKey: running.definition.task.idempotencyKey,
      reservationId: failed!.reservation!.reservationId,
      dispatchId: failed!.dispatch!.dispatchId,
      actualUsage: normalizedUsage({ inputTokens: 20, costMicros: 200 }),
    });
    expect(duplicate.sequence).toBe(reconciled.sequence);
    await runtime.close();
  });

  it("releases unused reservations on retry and requires exact dispatch identity after start", async () => {
    const { usage, runtime } = createHarness();
    const beforeDispatch = await enqueueAndClaim(
      runtime,
      definition("retry-release"),
    );
    usage.set(snapshotFor(beforeDispatch));
    const reserved = await runtime.reserveUsage({
      type: "reserve-usage",
      commandId: "command:reserve:retry-release",
      ...fenced(beforeDispatch),
      circuit: circuitFor(beforeDispatch),
    });
    const retry = await runtime.fail({
      type: "fail-work",
      commandId: "command:fail:retry-release",
      ...fenced(reserved),
      dispatchId: null,
      classification: "provider",
      code: "provider-before-dispatch",
      retryable: true,
      actualUsage: normalizedUsage({
        inputTokens: 0,
        outputTokens: 0,
        costMicros: 0,
      }),
    });
    expect(retry).toMatchObject({
      status: "retry-wait",
      reservation: { status: "released" },
    });

    const runningClaim = await enqueueAndClaim(
      runtime,
      definition("running-dispatch", { capacityPool: "parallel" }),
      "worker:running",
    );
    const running = await startDispatch(runtime, usage, runningClaim);
    await expect(
      runtime.fail({
        type: "fail-work",
        commandId: "command:fail:missing-dispatch",
        ...fenced(running),
        dispatchId: null,
        classification: "provider",
        code: "provider-after-dispatch",
        retryable: false,
        actualUsage: normalizedUsage({ costMicros: 100 }),
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await runtime.close();
  });

  it("preserves prior dispatch terminal evidence when retry-wait work is cancelled", async () => {
    const { clock, usage, runtime } = createHarness();
    const claimed = await enqueueAndClaim(
      runtime,
      definition("cancel-retry-dispatch"),
    );
    usage.set(snapshotFor(claimed));
    const reserved = await runtime.reserveUsage({
      type: "reserve-usage",
      commandId: "command:reserve:cancel-retry-dispatch",
      ...fenced(claimed),
      circuit: circuitFor(claimed),
    });
    const prepared = await runtime.prepareDispatch({
      type: "prepare-dispatch",
      commandId: "command:prepare:cancel-retry-dispatch",
      ...fenced(reserved),
      circuit: circuitFor(reserved),
    });
    const waiting = await runtime.fail({
      type: "fail-work",
      commandId: "command:fail:cancel-retry-dispatch",
      ...fenced(prepared),
      dispatchId: prepared.dispatch!.dispatchId,
      classification: "provider",
      code: "provider-before-start",
      retryable: true,
      actualUsage: normalizedUsage({
        inputTokens: 0,
        outputTokens: 0,
        costMicros: 0,
      }),
    });
    expect(waiting).toMatchObject({
      status: "retry-wait",
      dispatch: { status: "terminal" },
    });
    const firstTerminalAt = waiting.dispatch!.terminalAt;
    clock.advance(1);
    const cancelled = await runtime.cancel({
      type: "cancel-work",
      commandId: "command:cancel:cancel-retry-dispatch",
      idempotencyKey: waiting.definition.task.idempotencyKey,
      code: "operator-cancelled",
    });
    expect(cancelled).toMatchObject({
      status: "cancelled",
      dispatch: { status: "terminal", terminalAt: firstTerminalAt },
    });
    expect(cancelled.terminal?.finishedAt).not.toBe(firstTerminalAt);
    expect(
      replayWorkerRuntimeEvents(
        await runtime.history(waiting.definition.task.idempotencyKey),
      ),
    ).toEqual(cancelled);
    await runtime.close();
  });

  it("cancels a started dispatch without falsely claiming usage reconciliation", async () => {
    const { usage, runtime } = createHarness();
    const claimed = await enqueueAndClaim(
      runtime,
      definition("cancel-running"),
    );
    const running = await startDispatch(runtime, usage, claimed);
    const cancelled = await runtime.cancel({
      type: "cancel-work",
      commandId: "command:cancel:running",
      idempotencyKey: running.definition.task.idempotencyKey,
      code: "operator-cancelled",
    });
    expect(cancelled).toMatchObject({
      status: "cancelled",
      terminal: { code: "cancellation-reconciliation-required" },
      reservation: { status: "reconciliation-required", actualUsage: null },
      dispatch: { status: "terminal" },
    });
    const reconciled = await runtime.reconcileUsage({
      type: "reconcile-usage",
      commandId: "command:reconcile:cancelled",
      idempotencyKey: running.definition.task.idempotencyKey,
      reservationId: cancelled.reservation!.reservationId,
      dispatchId: cancelled.dispatch!.dispatchId,
      actualUsage: normalizedUsage({ costMicros: 100 }),
    });
    expect(reconciled).toMatchObject({
      status: "cancelled",
      reservation: { status: "reconciled" },
    });
    await runtime.close();
  });

  it("fails an exhausted pre-dispatch lease and never creates another attempt", async () => {
    const { clock, runtime } = createHarness();
    const claimed = await enqueueAndClaim(
      runtime,
      definition("exhausted", { maximumAttempts: 1 }),
    );
    clock.set(claimed.lease!.expiresAt);
    const [failed] = await runtime.tick();
    expect(failed).toMatchObject({
      status: "failed",
      terminal: { code: "retry-exhausted" },
    });
    expect(
      await runtime.claim({
        type: "claim-work",
        commandId: "command:claim:exhausted:two",
        workerId: "worker:two",
        allowedCapacityPools: ["default"],
      }),
    ).toBeNull();
    await runtime.close();
  });

  it("binds reservation and dispatch to two fresh monotonic usage reads", async () => {
    const { clock, usage, runtime } = createHarness();
    const claimed = await enqueueAndClaim(runtime, definition("usage-refresh"));
    usage.set(snapshotFor(claimed));
    const reserved = await runtime.reserveUsage({
      type: "reserve-usage",
      commandId: "command:reserve:usage",
      ...fenced(claimed),
      circuit: circuitFor(claimed),
    });
    clock.advance(100);
    usage.set(
      snapshotFor(reserved, {
        snapshotId: "usage:refresh:two",
        observedAt: clock.now().toISOString(),
        fiveHour: {
          ...snapshotFor(reserved).fiveHour,
          usedBasisPoints: 1_001,
          remainingBasisPoints: 8_999,
        },
        weekly: {
          ...snapshotFor(reserved).weekly,
          usedBasisPoints: 2_001,
          remainingBasisPoints: 7_999,
        },
      }),
    );
    const prepared = await runtime.prepareDispatch({
      type: "prepare-dispatch",
      commandId: "command:prepare:usage",
      ...fenced(reserved),
      circuit: circuitFor(reserved),
    });
    expect(prepared.dispatch).toMatchObject({
      usageSnapshotId: "usage:refresh:two",
      status: "prepared",
    });
    expect(usage.reads()).toBe(2);
    await runtime.close();
  });

  it.each([
    [
      "moving backwards",
      (state: WorkerRuntimeState) =>
        snapshotFor(state, {
          snapshotId: "usage:bad:backwards",
          fiveHour: {
            ...snapshotFor(state).fiveHour,
            usedBasisPoints: 999,
            remainingBasisPoints: 9_001,
          },
        }),
    ],
    [
      "changing windows",
      (state: WorkerRuntimeState) =>
        snapshotFor(state, {
          snapshotId: "usage:bad:window",
          fiveHour: {
            ...snapshotFor(state).fiveHour,
            windowId: "window:changed",
          },
        }),
    ],
    [
      "crossing profiles",
      (state: WorkerRuntimeState) =>
        snapshotFor(state, {
          snapshotId: "usage:bad:profile",
          profileId: "profile:other",
        }),
    ],
  ])("refuses refreshed usage that is %s", async (_label, invalid) => {
    const label = _label.replaceAll(" ", "-");
    const { usage, runtime } = createHarness();
    const claimed = await enqueueAndClaim(
      runtime,
      definition(`refresh-${label}`),
    );
    usage.set(snapshotFor(claimed));
    const reserved = await runtime.reserveUsage({
      type: "reserve-usage",
      commandId: `command:reserve:${label}`,
      ...fenced(claimed),
      circuit: circuitFor(claimed),
    });
    usage.set(invalid(reserved));
    await expect(
      runtime.prepareDispatch({
        type: "prepare-dispatch",
        commandId: `command:prepare:${label}`,
        ...fenced(reserved),
        circuit: circuitFor(reserved),
      }),
    ).rejects.toMatchObject({ code: "USAGE_REFUSED" });
    await runtime.close();
  });

  it("revalidates freshness and circuit evidence at the committing clock instant", async () => {
    const configuration = {
      ...CONFIGURATION,
      leaseDurationMs: 10_000,
      circuitFreshnessMs: 500,
    };
    const { clock, usage, runtime } = createHarness({ configuration });
    const claimed = await enqueueAndClaim(runtime, definition("elapsed-read"));
    usage.setReader(async () => {
      clock.advance(600);
      return snapshotFor(claimed, { freshUntil: "2026-08-10T10:15:00.000Z" });
    });
    await expect(
      runtime.reserveUsage({
        type: "reserve-usage",
        commandId: "command:reserve:elapsed",
        ...fenced(claimed),
        circuit: circuitFor(claimed),
      }),
    ).rejects.toMatchObject({ code: "CIRCUIT_OPEN" });
    expect(
      (await runtime.get(claimed.definition.task.idempotencyKey))?.reservation,
    ).toBeNull();
    await runtime.close();
  });

  it.each([
    ["open", { state: "open" as const }],
    ["half-open", { state: "half-open" as const }],
    ["future", { observedAt: "2026-08-10T10:00:01.000Z" }],
    ["stale", { observedAt: "2026-08-10T09:58:00.000Z" }],
    ["wrong profile", { profileId: "profile:other" }],
  ])(
    "refuses %s circuit evidence before reading usage",
    async (label, overrides) => {
      const { usage, runtime } = createHarness();
      const claimed = await enqueueAndClaim(
        runtime,
        definition(`circuit-${label.replaceAll(" ", "-")}`),
      );
      usage.set(snapshotFor(claimed));
      await expect(
        runtime.reserveUsage({
          type: "reserve-usage",
          commandId: `command:reserve:circuit-${label.replaceAll(" ", "-")}`,
          ...fenced(claimed),
          circuit: circuitFor(claimed, overrides),
        }),
      ).rejects.toMatchObject({ code: "CIRCUIT_OPEN" });
      expect(usage.reads()).toBe(0);
      await runtime.close();
    },
  );

  it("refuses a source freshness interval that expires during the adapter read", async () => {
    const configuration = { ...CONFIGURATION, leaseDurationMs: 10_000 };
    const { clock, usage, runtime } = createHarness({ configuration });
    const claimed = await enqueueAndClaim(
      runtime,
      definition("elapsed-source-freshness"),
    );
    usage.setReader(async () => {
      clock.advance(600);
      return snapshotFor(claimed, {
        freshUntil: "2026-08-10T10:00:00.500Z",
      });
    });
    await expect(
      runtime.reserveUsage({
        type: "reserve-usage",
        commandId: "command:reserve:elapsed-source",
        ...fenced(claimed),
        circuit: circuitFor(claimed),
      }),
    ).rejects.toMatchObject({ code: "USAGE_REFUSED" });
    expect(
      (await runtime.get(claimed.definition.task.idempotencyKey))?.reservation,
    ).toBeNull();
    await runtime.close();
  });

  it("reconciles successful usage once and converts a known budget overrun into failure", async () => {
    const { usage, runtime } = createHarness();
    const claimed = await enqueueAndClaim(
      runtime,
      definition("over-budget", { maximumInputTokens: 20 }),
    );
    const running = await startDispatch(runtime, usage, claimed);
    const completed = await runtime.complete({
      type: "complete-work",
      commandId: "command:complete:over-budget",
      ...fenced(running),
      dispatchId: running.dispatch!.dispatchId,
      actualUsage: normalizedUsage({ inputTokens: 21, costMicros: 100 }),
    });
    expect(completed).toMatchObject({
      status: "failed",
      terminal: { code: "usage-budget-exceeded", classification: "usage" },
      reservation: { status: "reconciled", actualUsage: { inputTokens: 21 } },
      dispatch: { status: "terminal" },
    });
    const duplicate = await runtime.complete({
      type: "complete-work",
      commandId: "command:complete:over-budget",
      ...fenced(running),
      dispatchId: running.dispatch!.dispatchId,
      actualUsage: normalizedUsage({ inputTokens: 21, costMicros: 100 }),
    });
    expect(duplicate.sequence).toBe(completed.sequence);

    const unknownClaimed = await enqueueAndClaim(
      runtime,
      definition("unknown-actual-cost"),
    );
    const unknownRunning = await startDispatch(runtime, usage, unknownClaimed);
    const unknownCost = await runtime.complete({
      type: "complete-work",
      commandId: "command:complete:unknown-actual-cost",
      ...fenced(unknownRunning),
      dispatchId: unknownRunning.dispatch!.dispatchId,
      actualUsage: normalizedUsage({ costMicros: null }),
    });
    expect(unknownCost).toMatchObject({
      status: "failed",
      terminal: { code: "usage-cost-unknown", classification: "usage" },
      reservation: { status: "reconciled" },
    });
    await runtime.close();
  });

  it("handles cancellation and deadline races idempotently", async () => {
    const { clock, runtime } = createHarness();
    const work = definition("deadline");
    const claimed = await enqueueAndClaim(runtime, work);
    clock.set(work.task.deadline);
    await expect(
      runtime.renew({
        type: "renew-lease",
        commandId: "command:renew:after-deadline",
        ...fenced(claimed),
      }),
    ).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
    const [cancelled] = await runtime.tick();
    expect(cancelled).toMatchObject({
      status: "cancelled",
      terminal: { code: "deadline-expired" },
    });
    const duplicate = await runtime.cancel({
      type: "cancel-work",
      commandId: "command:cancel:after-deadline",
      idempotencyKey: work.task.idempotencyKey,
      code: "operator-cancelled",
    });
    expect(duplicate.sequence).toBe(cancelled?.sequence);
    await runtime.close();
  });

  it("rolls back atomically when failure is injected between aggregate and journal writes", async () => {
    let fail = true;
    const { runtime } = createHarness({
      fault: () => {
        if (fail) throw new Error("injected-boundary-failure");
      },
    });
    const work = definition("rollback");
    await expect(
      runtime.enqueue({
        type: "enqueue-work",
        commandId: "command:enqueue:rollback",
        definition: work,
      }),
    ).rejects.toThrow("injected-boundary-failure");
    expect(await runtime.get(work.task.idempotencyKey)).toBeNull();
    fail = false;
    await runtime.enqueue({
      type: "enqueue-work",
      commandId: "command:enqueue:rollback",
      definition: work,
    });
    fail = true;
    await expect(
      runtime.claim({
        type: "claim-work",
        commandId: "command:claim:rollback",
        workerId: "worker:rollback",
        allowedCapacityPools: ["default"],
      }),
    ).rejects.toThrow("injected-boundary-failure");
    expect(await runtime.get(work.task.idempotencyKey)).toMatchObject({
      status: "ready",
      sequence: 1,
    });
    await runtime.close();
  });

  it("rolls back every reservation, dispatch, and terminal persistence boundary", async () => {
    let fail = false;
    const { usage, runtime } = createHarness({
      fault: () => {
        if (fail) throw new Error("injected-runtime-boundary");
      },
    });
    const claimed = await enqueueAndClaim(
      runtime,
      definition("boundary-matrix"),
    );
    usage.set(snapshotFor(claimed));

    fail = true;
    await expect(
      runtime.reserveUsage({
        type: "reserve-usage",
        commandId: "command:reserve:boundary:failed",
        ...fenced(claimed),
        circuit: circuitFor(claimed),
      }),
    ).rejects.toThrow("injected-runtime-boundary");
    expect(
      await runtime.get(claimed.definition.task.idempotencyKey),
    ).toMatchObject({ sequence: 2, reservation: null });

    fail = false;
    const reserved = await runtime.reserveUsage({
      type: "reserve-usage",
      commandId: "command:reserve:boundary:success",
      ...fenced(claimed),
      circuit: circuitFor(claimed),
    });
    fail = true;
    await expect(
      runtime.prepareDispatch({
        type: "prepare-dispatch",
        commandId: "command:prepare:boundary:failed",
        ...fenced(reserved),
        circuit: circuitFor(reserved),
      }),
    ).rejects.toThrow("injected-runtime-boundary");
    expect(
      await runtime.get(claimed.definition.task.idempotencyKey),
    ).toMatchObject({ sequence: 3, dispatch: null });

    fail = false;
    const prepared = await runtime.prepareDispatch({
      type: "prepare-dispatch",
      commandId: "command:prepare:boundary:success",
      ...fenced(reserved),
      circuit: circuitFor(reserved),
    });
    fail = true;
    await expect(
      runtime.markDispatchStarted({
        type: "mark-dispatch-started",
        commandId: "command:start:boundary:failed",
        ...fenced(prepared),
        dispatchId: prepared.dispatch!.dispatchId,
      }),
    ).rejects.toThrow("injected-runtime-boundary");
    expect(
      await runtime.get(claimed.definition.task.idempotencyKey),
    ).toMatchObject({
      sequence: 4,
      status: "leased",
      dispatch: { status: "prepared" },
    });

    fail = false;
    const running = await runtime.markDispatchStarted({
      type: "mark-dispatch-started",
      commandId: "command:start:boundary:success",
      ...fenced(prepared),
      dispatchId: prepared.dispatch!.dispatchId,
    });
    fail = true;
    await expect(
      runtime.complete({
        type: "complete-work",
        commandId: "command:complete:boundary:failed",
        ...fenced(running),
        dispatchId: running.dispatch!.dispatchId,
        actualUsage: normalizedUsage({ costMicros: 100 }),
      }),
    ).rejects.toThrow("injected-runtime-boundary");
    expect(
      await runtime.get(claimed.definition.task.idempotencyKey),
    ).toMatchObject({
      sequence: 5,
      status: "running",
      reservation: { status: "reserved" },
    });

    fail = false;
    const completed = await runtime.complete({
      type: "complete-work",
      commandId: "command:complete:boundary:success",
      ...fenced(running),
      dispatchId: running.dispatch!.dispatchId,
      actualUsage: normalizedUsage({ costMicros: 100 }),
    });
    expect(completed).toMatchObject({ sequence: 6, status: "completed" });
    await runtime.close();
  });

  it("rolls back lease-expiry marking and deferred reconciliation boundaries", async () => {
    let fail = false;
    const { clock, usage, runtime } = createHarness({
      fault: () => {
        if (fail) throw new Error("injected-reconciliation-boundary");
      },
    });
    const claimed = await enqueueAndClaim(
      runtime,
      definition("reconciliation-boundary"),
    );
    const running = await startDispatch(runtime, usage, claimed);
    clock.set(running.lease!.expiresAt);
    fail = true;
    await expect(runtime.tick()).rejects.toThrow(
      "injected-reconciliation-boundary",
    );
    expect(
      await runtime.get(running.definition.task.idempotencyKey),
    ).toMatchObject({ status: "running", reservation: { status: "reserved" } });

    fail = false;
    const [pending] = await runtime.tick();
    expect(pending).toMatchObject({
      status: "failed",
      reservation: { status: "reconciliation-required" },
    });
    const command = {
      type: "reconcile-usage" as const,
      commandId: "command:reconcile:boundary",
      idempotencyKey: running.definition.task.idempotencyKey,
      reservationId: pending!.reservation!.reservationId,
      dispatchId: pending!.dispatch!.dispatchId,
      actualUsage: normalizedUsage({ costMicros: 100 }),
    };
    fail = true;
    await expect(runtime.reconcileUsage(command)).rejects.toThrow(
      "injected-reconciliation-boundary",
    );
    expect(
      await runtime.get(running.definition.task.idempotencyKey),
    ).toMatchObject({
      reservation: { status: "reconciliation-required", actualUsage: null },
    });
    fail = false;
    expect(await runtime.reconcileUsage(command)).toMatchObject({
      reservation: { status: "reconciled" },
    });
    await runtime.close();
  });

  it("repeats concurrent capacity claims across fixed seeds without duplicate ownership", async () => {
    const seeds = [3, 17, 29, 41, 53, 67, 79, 97, 109, 127];
    for (const seed of seeds) {
      const { runtime } = createHarness();
      for (let index = 0; index < 6; index += 1) {
        const name = `seed-${seed}-work-${index}`;
        await runtime.enqueue({
          type: "enqueue-work",
          commandId: `command:enqueue:${name}`,
          definition: definition(name, { capacityPool: "parallel" }),
        });
      }
      const workers = Array.from({ length: 8 }, (_, index) => index).sort(
        (left, right) => ((left * seed) % 11) - ((right * seed) % 11),
      );
      const claims = await Promise.all(
        workers.map((worker) =>
          runtime.claim({
            type: "claim-work",
            commandId: `command:claim:seed-${seed}:worker-${worker}`,
            workerId: `worker:seed-${seed}:${worker}`,
            allowedCapacityPools: ["parallel"],
          }),
        ),
      );
      const accepted = claims.filter(
        (state): state is WorkerRuntimeState => state !== null,
      );
      expect(accepted).toHaveLength(4);
      expect(
        new Set(accepted.map((state) => state.definition.workId)).size,
      ).toBe(4);
      expect(
        new Set(accepted.map((state) => state.lease?.fencingToken)).size,
      ).toBe(1);
      expect(accepted.every((state) => state.lease?.fencingToken === 1)).toBe(
        true,
      );
      await runtime.close();
    }
  });

  it("rejects tampered event identity, duplicates, and reordered delivery", async () => {
    const { runtime } = createHarness();
    const claimed = await enqueueAndClaim(runtime, definition("replay"));
    const history = await runtime.history(
      claimed.definition.task.idempotencyKey,
    );
    expect(history).toHaveLength(2);
    expect(() =>
      parseWorkerRuntimeEvent({
        ...history[0],
        eventId: `runtime-event:${"0".repeat(40)}`,
      }),
    ).toThrow(/identity/i);
    expect(() =>
      replayWorkerRuntimeEvents([
        { ...history[0]!, eventId: `runtime-event:${"0".repeat(40)}` },
      ]),
    ).toThrow(/identity/i);
    expect(() => replayWorkerRuntimeEvents([history[0]!, history[0]!])).toThrow(
      /duplicate/i,
    );
    expect(() =>
      replayWorkerRuntimeEvents([history[1]!, history[0]!]),
    ).toThrow();
    const forgedPublicTickIdentity = createWorkerRuntimeEvent({
      workId: history[0]!.workId,
      sequence: history[0]!.sequence,
      occurredAt: history[0]!.occurredAt,
      type: history[0]!.type,
      command: {
        ...history[0]!.command,
        commandId: `tick:${"a".repeat(32)}`,
      },
      payload: history[0]!.payload,
    });
    expect(() => replayWorkerRuntimeEvents([forgedPublicTickIdentity])).toThrow(
      /command type or identity/i,
    );
    const synthetic = createWorkerRuntimeEvent({
      workId: claimed.definition.workId,
      sequence: 3,
      occurredAt: BASE_TIME,
      type: "work.ready",
      command: {
        type: "retry-ready",
        commandId: "command:synthetic",
        idempotencyKey: claimed.definition.task.idempotencyKey,
      },
      payload: {},
    });
    expect(() => replayWorkerRuntimeEvents([...history, synthetic])).toThrow();
    await runtime.close();
  });

  it("rejects replay-only retry and terminal projections that commands cannot create", async () => {
    const retryHarness = createHarness();
    const retryClaimed = await enqueueAndClaim(
      retryHarness.runtime,
      definition("replay-retry"),
    );
    await retryHarness.runtime.fail({
      type: "fail-work",
      commandId: "command:fail:replay-retry",
      ...fenced(retryClaimed),
      dispatchId: null,
      classification: "provider",
      code: "provider-unavailable",
      retryable: true,
      actualUsage: normalizedUsage({
        inputTokens: 0,
        outputTokens: 0,
        costMicros: 0,
      }),
    });
    const retryHistory = await retryHarness.runtime.history(
      retryClaimed.definition.task.idempotencyKey,
    );
    const retryEvent = retryHistory.at(-1)!;
    const retryPayload = retryEvent.payload as Record<string, unknown>;
    const failure = retryPayload["failure"] as Record<string, unknown>;
    const forgedRetry = createWorkerRuntimeEvent({
      workId: retryEvent.workId,
      sequence: retryEvent.sequence,
      occurredAt: retryEvent.occurredAt,
      type: retryEvent.type,
      command: { ...retryEvent.command, classification: "policy" },
      payload: {
        ...retryPayload,
        failure: { ...failure, classification: "policy" },
      },
    });
    expect(() =>
      replayWorkerRuntimeEvents([...retryHistory.slice(0, -1), forgedRetry]),
    ).toThrow(/retry evidence/i);
    await retryHarness.runtime.close();

    const completionHarness = createHarness();
    const completionClaimed = await enqueueAndClaim(
      completionHarness.runtime,
      definition("replay-budget", { maximumInputTokens: 20 }),
    );
    const running = await startDispatch(
      completionHarness.runtime,
      completionHarness.usage,
      completionClaimed,
    );
    await completionHarness.runtime.complete({
      type: "complete-work",
      commandId: "command:complete:replay-budget",
      ...fenced(running),
      dispatchId: running.dispatch!.dispatchId,
      actualUsage: normalizedUsage({ inputTokens: 20, costMicros: 100 }),
    });
    const completionHistory = await completionHarness.runtime.history(
      running.definition.task.idempotencyKey,
    );
    const completionEvent = completionHistory.at(-1)!;
    const completionPayload = completionEvent.payload as Record<
      string,
      unknown
    >;
    const terminal = completionPayload["terminal"] as Record<string, unknown>;
    const reservation = completionPayload["reservation"] as Record<
      string,
      unknown
    >;
    const overBudgetUsage = normalizedUsage({
      inputTokens: 21,
      costMicros: 100,
    });
    const forgedCompletion = createWorkerRuntimeEvent({
      workId: completionEvent.workId,
      sequence: completionEvent.sequence,
      occurredAt: completionEvent.occurredAt,
      type: completionEvent.type,
      command: {
        ...completionEvent.command,
        actualUsage: overBudgetUsage,
      },
      payload: {
        ...completionPayload,
        terminal: { ...terminal, actualUsage: overBudgetUsage },
        reservation: { ...reservation, actualUsage: overBudgetUsage },
      },
    });
    expect(() =>
      replayWorkerRuntimeEvents([
        ...completionHistory.slice(0, -1),
        forgedCompletion,
      ]),
    ).toThrow(/command-equivalent/i);
    await completionHarness.runtime.close();
  });

  it("preserves exact dispatch start evidence during terminal replay", async () => {
    const startedHarness = createHarness();
    const startedClaim = await enqueueAndClaim(
      startedHarness.runtime,
      definition("replay-started-at"),
    );
    const running = await startDispatch(
      startedHarness.runtime,
      startedHarness.usage,
      startedClaim,
    );
    await startedHarness.runtime.complete({
      type: "complete-work",
      commandId: "command:complete:replay-started-at",
      ...fenced(running),
      dispatchId: running.dispatch!.dispatchId,
      actualUsage: normalizedUsage({ costMicros: 100 }),
    });
    const startedHistory = await startedHarness.runtime.history(
      running.definition.task.idempotencyKey,
    );
    const startedTerminal = startedHistory.at(-1)!;
    const startedPayload = startedTerminal.payload as Record<string, unknown>;
    const startedDispatch = startedPayload["dispatch"] as Record<
      string,
      unknown
    >;
    const removedStart = createWorkerRuntimeEvent({
      workId: startedTerminal.workId,
      sequence: startedTerminal.sequence,
      occurredAt: startedTerminal.occurredAt,
      type: startedTerminal.type,
      command: startedTerminal.command,
      payload: {
        ...startedPayload,
        dispatch: { ...startedDispatch, startedAt: null },
      },
    });
    expect(() =>
      replayWorkerRuntimeEvents([...startedHistory.slice(0, -1), removedStart]),
    ).toThrow(/dispatch/i);
    await startedHarness.runtime.close();

    const preparedHarness = createHarness();
    const preparedClaim = await enqueueAndClaim(
      preparedHarness.runtime,
      definition("replay-invented-start"),
    );
    preparedHarness.usage.set(snapshotFor(preparedClaim));
    const reserved = await preparedHarness.runtime.reserveUsage({
      type: "reserve-usage",
      commandId: "command:reserve:replay-invented-start",
      ...fenced(preparedClaim),
      circuit: circuitFor(preparedClaim),
    });
    const prepared = await preparedHarness.runtime.prepareDispatch({
      type: "prepare-dispatch",
      commandId: "command:prepare:replay-invented-start",
      ...fenced(reserved),
      circuit: circuitFor(reserved),
    });
    await preparedHarness.runtime.fail({
      type: "fail-work",
      commandId: "command:fail:replay-invented-start",
      ...fenced(prepared),
      dispatchId: prepared.dispatch!.dispatchId,
      classification: "provider",
      code: "provider-pre-dispatch",
      retryable: false,
      actualUsage: normalizedUsage({
        inputTokens: 0,
        outputTokens: 0,
        costMicros: 0,
      }),
    });
    const preparedHistory = await preparedHarness.runtime.history(
      prepared.definition.task.idempotencyKey,
    );
    const preparedTerminal = preparedHistory.at(-1)!;
    const preparedPayload = preparedTerminal.payload as Record<string, unknown>;
    const preparedDispatch = preparedPayload["dispatch"] as Record<
      string,
      unknown
    >;
    const inventedStart = createWorkerRuntimeEvent({
      workId: preparedTerminal.workId,
      sequence: preparedTerminal.sequence,
      occurredAt: preparedTerminal.occurredAt,
      type: preparedTerminal.type,
      command: preparedTerminal.command,
      payload: {
        ...preparedPayload,
        dispatch: { ...preparedDispatch, startedAt: BASE_TIME },
      },
    });
    expect(() =>
      replayWorkerRuntimeEvents([
        ...preparedHistory.slice(0, -1),
        inventedStart,
      ]),
    ).toThrow(/dispatch/i);
    await preparedHarness.runtime.close();
  });

  it("accumulates retry usage durably and terminal-fails a cumulative overrun", async () => {
    const { clock, usage, runtime } = createHarness();
    const firstClaim = await enqueueAndClaim(
      runtime,
      definition("cumulative-retry", {
        maximumAttempts: 2,
        maximumInputTokens: 100,
      }),
    );
    const firstRunning = await startDispatch(runtime, usage, firstClaim);
    const retry = await runtime.fail({
      type: "fail-work",
      commandId: "command:fail:cumulative-retry:first",
      ...fenced(firstRunning),
      dispatchId: firstRunning.dispatch!.dispatchId,
      classification: "provider",
      code: "provider-first-attempt",
      retryable: true,
      actualUsage: normalizedUsage({
        inputTokens: 60,
        outputTokens: 0,
        costMicros: 50,
      }),
    });
    expect(retry).toMatchObject({
      status: "retry-wait",
      cumulativeUsage: { inputTokens: 60, costMicros: 50 },
    });
    clock.set(retry.nextReadyAt!);
    await runtime.tick();
    const secondClaim = await runtime.claim({
      type: "claim-work",
      commandId: "command:claim:cumulative-retry:second",
      workerId: "worker:second",
      allowedCapacityPools: ["default"],
    });
    if (secondClaim === null) throw new Error("expected second attempt");
    const secondRunning = await startDispatch(runtime, usage, secondClaim);
    const completeCommand = {
      type: "complete-work" as const,
      commandId: "command:complete:cumulative-retry:second",
      ...fenced(secondRunning),
      dispatchId: secondRunning.dispatch!.dispatchId,
      actualUsage: normalizedUsage({
        inputTokens: 60,
        outputTokens: 0,
        costMicros: 50,
      }),
    };
    const failed = await runtime.complete(completeCommand);
    expect(failed).toMatchObject({
      status: "failed",
      cumulativeUsage: { inputTokens: 120, costMicros: 100 },
      terminal: {
        code: "usage-budget-exceeded",
        actualUsage: { inputTokens: 120, costMicros: 100 },
      },
      reservation: {
        actualUsage: { inputTokens: 60, costMicros: 50 },
      },
    });
    expect(await runtime.complete(completeCommand)).toEqual(failed);
    const history = await runtime.history(
      failed.definition.task.idempotencyKey,
    );
    expect(replayWorkerRuntimeEvents(history)).toEqual(failed);
    await runtime.close();
  });

  it("suppresses retry for single-attempt overruns, unknown cost, and pre-dispatch usage", async () => {
    const overrunHarness = createHarness();
    const overrunClaim = await enqueueAndClaim(
      overrunHarness.runtime,
      definition("single-overrun", { maximumInputTokens: 100 }),
    );
    const overrunRunning = await startDispatch(
      overrunHarness.runtime,
      overrunHarness.usage,
      overrunClaim,
    );
    expect(
      await overrunHarness.runtime.fail({
        type: "fail-work",
        commandId: "command:fail:single-overrun",
        ...fenced(overrunRunning),
        dispatchId: overrunRunning.dispatch!.dispatchId,
        classification: "provider",
        code: "provider-overrun",
        retryable: true,
        actualUsage: normalizedUsage({
          inputTokens: 101,
          outputTokens: 0,
          costMicros: 10,
        }),
      }),
    ).toMatchObject({
      status: "failed",
      cumulativeUsage: { inputTokens: 101 },
    });
    await overrunHarness.runtime.close();

    const unknownHarness = createHarness();
    const unknownClaim = await enqueueAndClaim(
      unknownHarness.runtime,
      definition("unknown-retry-cost"),
    );
    const unknownRunning = await startDispatch(
      unknownHarness.runtime,
      unknownHarness.usage,
      unknownClaim,
    );
    expect(
      await unknownHarness.runtime.fail({
        type: "fail-work",
        commandId: "command:fail:unknown-retry-cost",
        ...fenced(unknownRunning),
        dispatchId: unknownRunning.dispatch!.dispatchId,
        classification: "provider",
        code: "provider-unknown-cost",
        retryable: true,
        actualUsage: normalizedUsage({ costMicros: null }),
      }),
    ).toMatchObject({
      status: "failed",
      cumulativeUsage: { costMicros: null },
    });
    await unknownHarness.runtime.close();

    const preDispatchHarness = createHarness();
    const preDispatch = await enqueueAndClaim(
      preDispatchHarness.runtime,
      definition("predispatch-usage"),
    );
    await expect(
      preDispatchHarness.runtime.fail({
        type: "fail-work",
        commandId: "command:fail:predispatch-usage",
        ...fenced(preDispatch),
        dispatchId: null,
        classification: "provider",
        code: "provider-before-start",
        retryable: true,
        actualUsage: normalizedUsage({ inputTokens: 1, costMicros: 1 }),
      }),
    ).rejects.toMatchObject({ code: "INVALID_TASK" });
    expect(
      await preDispatchHarness.runtime.get(
        preDispatch.definition.task.idempotencyKey,
      ),
    ).toMatchObject({ status: "leased", sequence: 2 });
    await preDispatchHarness.runtime.close();
  });

  it("returns reserve and prepare duplicates before lease checks or adapter reads", async () => {
    const { clock, usage, runtime } = createHarness();
    const claimed = await enqueueAndClaim(runtime, definition("read-dedup"));
    usage.set(snapshotFor(claimed));
    const reserveCommand = {
      type: "reserve-usage" as const,
      commandId: "command:reserve:read-dedup",
      ...fenced(claimed),
      circuit: circuitFor(claimed),
    };
    const reserved = await runtime.reserveUsage(reserveCommand);
    const prepareCommand = {
      type: "prepare-dispatch" as const,
      commandId: "command:prepare:read-dedup",
      ...fenced(reserved),
      circuit: circuitFor(reserved),
    };
    const prepared = await runtime.prepareDispatch(prepareCommand);
    expect(usage.reads()).toBe(2);
    usage.setReader(async () => {
      throw new Error("duplicate-must-not-read");
    });
    clock.set(prepared.lease!.expiresAt);
    expect(await runtime.reserveUsage(reserveCommand)).toEqual(prepared);
    expect(await runtime.prepareDispatch(prepareCommand)).toEqual(prepared);
    expect(usage.reads()).toBe(2);
    await runtime.close();
  });

  it("bounds a hung usage reader and never writes a late result", async () => {
    const { usage, runtime } = createHarness();
    const claimed = await enqueueAndClaim(runtime, definition("usage-timeout"));
    usage.setReader(
      async () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(snapshotFor(claimed)), 250);
        }),
    );
    await expect(
      runtime.reserveUsage({
        type: "reserve-usage",
        commandId: "command:reserve:usage-timeout",
        ...fenced(claimed),
        circuit: circuitFor(claimed),
      }),
    ).rejects.toMatchObject({ code: "USAGE_REFUSED" });
    await new Promise((resolve) => setTimeout(resolve, 275));
    expect(
      await runtime.history(claimed.definition.task.idempotencyKey),
    ).toHaveLength(2);
    expect(
      await runtime.get(claimed.definition.task.idempotencyKey),
    ).toMatchObject({ reservation: null, sequence: 2 });
    await runtime.close();
  });

  it("rejects runtime schema substitution and scheduler-owned public codes", async () => {
    const clock = new ManualClock();
    const persistence = createMemoryPersistenceAdapter({ clock });
    let schemaOneReads = 0;
    const runtime = createProductionDisabledWorkerRuntime({
      persistence,
      clock,
      configuration: CONFIGURATION,
      usageAdapter: {
        adapterId: "adapter:usage:test",
        schemaVersion: 1,
        readAuthorizedSnapshot: async () => {
          schemaOneReads += 1;
          return usageSnapshot();
        },
      },
    });
    const claimed = await enqueueAndClaim(
      runtime,
      definition("schema-binding"),
    );
    await expect(
      runtime.reserveUsage({
        type: "reserve-usage",
        commandId: "command:reserve:schema-binding",
        ...fenced(claimed),
        circuit: circuitFor(claimed),
      }),
    ).rejects.toMatchObject({ code: "USAGE_REFUSED" });
    expect(schemaOneReads).toBe(0);
    expect(
      await runtime.history(claimed.definition.task.idempotencyKey),
    ).toHaveLength(2);
    await runtime.close();

    for (const drift of ["adapter-id", "schema"] as const) {
      const driftClock = new ManualClock();
      const driftPersistence = createMemoryPersistenceAdapter({
        clock: driftClock,
      });
      let liveAdapterId = "adapter:usage:test";
      let liveSchemaVersion: 1 | 2 = 2;
      let driftReads = 0;
      const driftAdapter: UsageSnapshotAdapter = {
        get adapterId() {
          return liveAdapterId;
        },
        get schemaVersion() {
          return liveSchemaVersion;
        },
        async readAuthorizedSnapshot() {
          driftReads += 1;
          return usageSnapshot();
        },
      };
      const driftRuntime = createProductionDisabledWorkerRuntime({
        persistence: driftPersistence,
        clock: driftClock,
        configuration: CONFIGURATION,
        usageAdapter: driftAdapter,
      });
      const driftClaimed = await enqueueAndClaim(
        driftRuntime,
        definition(`adapter-binding-drift:${drift}`),
      );
      if (drift === "adapter-id") {
        liveAdapterId = "adapter:usage:drifted";
      } else {
        liveSchemaVersion = 1;
      }
      await expect(
        driftRuntime.reserveUsage({
          type: "reserve-usage",
          commandId: `command:reserve:adapter-binding-drift:${drift}`,
          ...fenced(driftClaimed),
          circuit: circuitFor(driftClaimed),
        }),
      ).rejects.toMatchObject({ code: "USAGE_REFUSED" });
      expect(driftReads).toBe(0);
      expect(
        await driftRuntime.history(
          driftClaimed.definition.task.idempotencyKey,
        ),
      ).toHaveLength(2);
      await driftRuntime.close();
    }

    for (const reservedCode of [
      "lease-expired-before-dispatch",
      "lease-expired-reconciliation-required",
      "retry-exhausted",
      "usage-budget-exceeded",
      "usage-cost-unknown",
    ]) {
      expect(() =>
        parseWorkerRuntimeCommand({
          type: "fail-work",
          commandId: `command:reserved:${reservedCode}`,
          idempotencyKey: claimed.definition.task.idempotencyKey,
          leaseId: claimed.lease!.leaseId,
          workerId: claimed.lease!.workerId,
          fencingToken: claimed.lease!.fencingToken,
          dispatchId: null,
          classification: "provider",
          code: reservedCode,
          retryable: false,
          actualUsage: normalizedUsage({ costMicros: 0 }),
        }),
      ).toThrow(/reserved/i);
    }
    expect(() =>
      parseWorkerRuntimeCommand({
        type: "cancel-work",
        commandId: "command:reserved:cancellation",
        idempotencyKey: claimed.definition.task.idempotencyKey,
        code: "cancellation-reconciliation-required",
      }),
    ).toThrow(/reserved/i);
  });

  it("ages only the current ready interval after retry and replays that timestamp", async () => {
    const { clock, runtime } = createHarness();
    const low = await enqueueAndClaim(
      runtime,
      definition("aaa-retried-low", {
        priority: "critical",
        capacityPool: "default",
        fairnessKey: "tenant:shared-aging",
      }),
    );
    await runtime.enqueue({
      type: "enqueue-work",
      commandId: "command:enqueue:zzz-waiting-high",
      definition: definition("zzz-waiting-high", {
        priority: "critical",
        capacityPool: "default",
        fairnessKey: "tenant:shared-aging",
      }),
    });
    const retry = await runtime.fail({
      type: "fail-work",
      commandId: "command:fail:aaa-retried-low",
      ...fenced(low),
      dispatchId: null,
      classification: "provider",
      code: "provider-before-start",
      retryable: true,
      actualUsage: normalizedUsage({
        inputTokens: 0,
        outputTokens: 0,
        costMicros: 0,
      }),
    });
    clock.advance(3_600_000);
    const [ready] = await runtime.tick();
    expect(ready).toMatchObject({
      definition: { workId: "work:aaa-retried-low" },
      status: "ready",
      readySince: clock.now().toISOString(),
    });
    expect(ready!.readySince).not.toBe(retry.definition.readyAt);
    const claimed = await runtime.claim({
      type: "claim-work",
      commandId: "command:claim:aging-after-retry",
      workerId: "worker:aging-after-retry",
      allowedCapacityPools: ["default"],
    });
    expect(claimed).toMatchObject({
      definition: { workId: "work:zzz-waiting-high" },
    });
    const retryHistory = await runtime.history(
      retry.definition.task.idempotencyKey,
    );
    expect(replayWorkerRuntimeEvents(retryHistory)).toEqual(ready);
    await runtime.close();
  });

  it("serializes borrowed-profile liabilities across tasks and releases only unused reservations", async () => {
    const { usage, runtime } = createHarness();
    const shared = {
      capacityPool: "parallel" as const,
      profileId: "profile:shared-borrowed",
      ownership: "authorized-borrowed" as const,
      predictedFiveHourBasisPoints: 5,
      predictedWeeklyBasisPoints: 6,
    };
    await runtime.enqueue({
      type: "enqueue-work",
      commandId: "command:enqueue:borrowed-a",
      definition: definition("borrowed-a", shared),
    });
    await runtime.enqueue({
      type: "enqueue-work",
      commandId: "command:enqueue:borrowed-b",
      definition: definition("borrowed-b", shared),
    });
    const first = await runtime.claim({
      type: "claim-work",
      commandId: "command:claim:borrowed-a",
      workerId: "worker:borrowed-a",
      allowedCapacityPools: ["parallel"],
    });
    const second = await runtime.claim({
      type: "claim-work",
      commandId: "command:claim:borrowed-b",
      workerId: "worker:borrowed-b",
      allowedCapacityPools: ["parallel"],
    });
    if (first === null || second === null) throw new Error("expected claims");
    const snapshot = (state: WorkerRuntimeState, fingerprint: string) =>
      snapshotFor(state, {
        sourceFingerprint: fingerprint,
        fiveHour: {
          ...snapshotFor(state).fiveHour,
          usedBasisPoints: 1_000,
          remainingBasisPoints: 9_000,
        },
        weekly: {
          ...snapshotFor(state).weekly,
          usedBasisPoints: 6_990,
          remainingBasisPoints: 3_010,
        },
      });
    usage.set(snapshot(first, "a".repeat(64)));
    const firstReserved = await runtime.reserveUsage({
      type: "reserve-usage",
      commandId: "command:reserve:borrowed-a",
      ...fenced(first),
      circuit: circuitFor(first),
    });
    usage.set(snapshot(second, "c".repeat(64)));
    const secondCommand = {
      type: "reserve-usage" as const,
      commandId: "command:reserve:borrowed-b",
      ...fenced(second),
      circuit: circuitFor(second),
    };
    await expect(runtime.reserveUsage(secondCommand)).rejects.toMatchObject({
      code: "USAGE_REFUSED",
    });
    await runtime.cancel({
      type: "cancel-work",
      commandId: "command:cancel:borrowed-a",
      idempotencyKey: firstReserved.definition.task.idempotencyKey,
      code: "operator-cancelled",
    });
    expect(await runtime.reserveUsage(secondCommand)).toMatchObject({
      reservation: { status: "reserved" },
    });
    await runtime.close();

    const concurrent = createHarness();
    for (const name of ["concurrent-a", "concurrent-b"]) {
      await concurrent.runtime.enqueue({
        type: "enqueue-work",
        commandId: `command:enqueue:${name}`,
        definition: definition(name, shared),
      });
    }
    const concurrentClaims = await Promise.all([
      concurrent.runtime.claim({
        type: "claim-work",
        commandId: "command:claim:concurrent-a",
        workerId: "worker:concurrent-a",
        allowedCapacityPools: ["parallel"],
      }),
      concurrent.runtime.claim({
        type: "claim-work",
        commandId: "command:claim:concurrent-b",
        workerId: "worker:concurrent-b",
        allowedCapacityPools: ["parallel"],
      }),
    ]);
    if (concurrentClaims.some((state) => state === null)) {
      throw new Error("expected concurrent claims");
    }
    concurrent.usage.set(snapshot(concurrentClaims[0]!, "d".repeat(64)));
    const reservations = await Promise.allSettled(
      concurrentClaims.map((state, index) =>
        concurrent.runtime.reserveUsage({
          type: "reserve-usage",
          commandId: `command:reserve:concurrent-${index}`,
          ...fenced(state!),
          circuit: circuitFor(state!),
        }),
      ),
    );
    expect(
      reservations.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      reservations.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    await concurrent.runtime.close();
  });

  it("rechecks all borrowed liabilities when preparation crosses into London work hours", async () => {
    const clock = new ManualClock("2026-08-10T07:59:59.000Z");
    const { usage, runtime } = createHarness({
      clock,
      configuration: {
        ...CONFIGURATION,
        leaseDurationMs: 10_000,
        usageFreshnessMs: 15 * 60_000,
      },
    });
    const shared = {
      createdAt: "2026-08-10T07:50:00.000Z",
      readyAt: "2026-08-10T07:50:00.000Z",
      capacityPool: "parallel" as const,
      profileId: "profile:work-hours-boundary",
      ownership: "authorized-borrowed" as const,
      predictedFiveHourBasisPoints: 150,
      predictedWeeklyBasisPoints: 1,
      dispatchMs: 10_000,
    };
    for (const name of ["boundary-a", "boundary-b"]) {
      await runtime.enqueue({
        type: "enqueue-work",
        commandId: `command:enqueue:${name}`,
        definition: definition(name, shared),
      });
    }
    const claims = [
      await runtime.claim({
        type: "claim-work",
        commandId: "command:claim:boundary-a",
        workerId: "worker:boundary-a",
        allowedCapacityPools: ["parallel"],
      }),
      await runtime.claim({
        type: "claim-work",
        commandId: "command:claim:boundary-b",
        workerId: "worker:boundary-b",
        allowedCapacityPools: ["parallel"],
      }),
    ];
    if (claims.some((state) => state === null))
      throw new Error("expected claims");
    const boundarySnapshot = (state: WorkerRuntimeState, observedAt: string) =>
      snapshotFor(state, {
        observedAt,
        fiveHour: {
          ...snapshotFor(state).fiveHour,
          usedBasisPoints: 4_800,
          remainingBasisPoints: 5_200,
        },
        weekly: {
          ...snapshotFor(state).weekly,
          usedBasisPoints: 1_000,
          remainingBasisPoints: 9_000,
        },
      });
    const reservations: WorkerRuntimeState[] = [];
    for (const [index, claim] of claims.entries()) {
      usage.set(boundarySnapshot(claim!, "2026-08-10T07:59:58.500Z"));
      reservations.push(
        await runtime.reserveUsage({
          type: "reserve-usage",
          commandId: `command:reserve:boundary-${index}`,
          ...fenced(claim!),
          circuit: circuitFor(claim!, {
            observedAt: "2026-08-10T07:59:58.500Z",
          }),
        }),
      );
    }
    clock.set("2026-08-10T08:00:00.500Z");
    for (const [index, reserved] of reservations.entries()) {
      usage.set(boundarySnapshot(reserved, "2026-08-10T08:00:00.000Z"));
      await expect(
        runtime.prepareDispatch({
          type: "prepare-dispatch",
          commandId: `command:prepare:boundary-${index}`,
          ...fenced(reserved),
          circuit: circuitFor(reserved, {
            observedAt: "2026-08-10T08:00:00.000Z",
          }),
        }),
      ).rejects.toMatchObject({ code: "USAGE_REFUSED" });
    }
    expect(
      (await runtime.list()).filter((state) => state.dispatch !== null),
    ).toHaveLength(0);
    await runtime.close();
  });

  it("rejects impossible reserve and prepare transitions before invoking the usage port", async () => {
    const { usage, runtime } = createHarness();
    const claimed = await enqueueAndClaim(
      runtime,
      definition("pre-read-state"),
    );
    usage.set(snapshotFor(claimed));
    const circuit = circuitFor(claimed);
    const readsBefore = usage.reads();
    await expect(
      runtime.prepareDispatch({
        type: "prepare-dispatch",
        commandId: "command:prepare:without-reservation",
        ...fenced(claimed),
        circuit,
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect(usage.reads()).toBe(readsBefore);

    const reserved = await runtime.reserveUsage({
      type: "reserve-usage",
      commandId: "command:reserve:pre-read-state",
      ...fenced(claimed),
      circuit,
    });
    const readsAfterReserve = usage.reads();
    await expect(
      runtime.reserveUsage({
        type: "reserve-usage",
        commandId: "command:reserve:already-reserved",
        ...fenced(reserved),
        circuit: circuitFor(reserved),
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect(usage.reads()).toBe(readsAfterReserve);

    const prepared = await runtime.prepareDispatch({
      type: "prepare-dispatch",
      commandId: "command:prepare:pre-read-state",
      ...fenced(reserved),
      circuit: circuitFor(reserved),
    });
    const readsAfterPrepare = usage.reads();
    await expect(
      runtime.prepareDispatch({
        type: "prepare-dispatch",
        commandId: "command:prepare:already-prepared",
        ...fenced(prepared),
        circuit: circuitFor(prepared),
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect(usage.reads()).toBe(readsAfterPrepare);
    await runtime.close();
  });

  it("keeps usage and circuit freshness policies independent in live and replay paths", async () => {
    const old = new Date(Date.parse(BASE_TIME) - 30_000).toISOString();
    for (const [
      name,
      usageFreshnessMs,
      circuitFreshnessMs,
      usageAt,
      circuitAt,
    ] of [
      ["old-circuit", 1_000, 60_000, BASE_TIME, old],
      ["old-usage", 60_000, 1_000, old, BASE_TIME],
    ] as const) {
      const { usage, runtime } = createHarness({
        configuration: {
          ...CONFIGURATION,
          leaseDurationMs: 60_000,
          usageFreshnessMs,
          circuitFreshnessMs,
        },
      });
      const claimed = await enqueueAndClaim(
        runtime,
        definition(`freshness-${name}`, { dispatchMs: 60_000 }),
      );
      usage.set(snapshotFor(claimed, { observedAt: usageAt }));
      await expect(
        runtime.reserveUsage({
          type: "reserve-usage",
          commandId: `command:reserve:freshness-${name}`,
          ...fenced(claimed),
          circuit: circuitFor(claimed, { observedAt: circuitAt }),
        }),
      ).resolves.toMatchObject({ reservation: { status: "reserved" } });
      expect(
        replayWorkerRuntimeEvents(
          await runtime.history(claimed.definition.task.idempotencyKey),
        ),
      ).toMatchObject({ reservation: { status: "reserved" } });
      await runtime.close();
    }
  });

  it("binds reserve and prepare to one exact usage-adapter version", async () => {
    const { usage, runtime } = createHarness();
    const claimed = await enqueueAndClaim(
      runtime,
      definition("adapter-version-binding"),
    );
    const original = snapshotFor(claimed);
    usage.set(original);
    const reserved = await runtime.reserveUsage({
      type: "reserve-usage",
      commandId: "command:reserve:adapter-version-binding",
      ...fenced(claimed),
      circuit: circuitFor(claimed),
    });
    usage.set({ ...original, sourceAdapterVersion: "version:substituted" });
    await expect(
      runtime.prepareDispatch({
        type: "prepare-dispatch",
        commandId: "command:prepare:adapter-version-drift",
        ...fenced(reserved),
        circuit: circuitFor(reserved),
      }),
    ).rejects.toMatchObject({ code: "USAGE_REFUSED" });

    usage.set(original);
    await runtime.prepareDispatch({
      type: "prepare-dispatch",
      commandId: "command:prepare:adapter-version-binding",
      ...fenced(reserved),
      circuit: circuitFor(reserved),
    });
    const history = await runtime.history(
      claimed.definition.task.idempotencyKey,
    );
    const last = history.at(-1)!;
    const payload = last.payload as Record<string, unknown>;
    const snapshot = payload["usageSnapshot"] as Record<string, unknown>;
    const forged = createWorkerRuntimeEvent({
      workId: last.workId,
      sequence: last.sequence,
      occurredAt: last.occurredAt,
      type: last.type,
      command: last.command,
      payload: {
        ...payload,
        usageSnapshot: {
          ...snapshot,
          sourceAdapterVersion: "version:substituted",
        },
      },
    });
    expect(() =>
      replayWorkerRuntimeEvents([...history.slice(0, -1), forged]),
    ).toThrow(/reservation|dispatch/i);
    await runtime.close();
  });

  it("refuses statically ineligible exact routes before reading usage and during replay", async () => {
    const staleHealth = new Date(Date.parse(BASE_TIME) - 60_001).toISOString();
    const futureHealth = new Date(Date.parse(BASE_TIME) + 1).toISOString();
    const borrowed = definition("route-borrowed-policy", {
      ownership: "authorized-borrowed",
    });
    const cases: readonly (readonly [string, WorkerWorkDefinition])[] = [
      [
        "unavailable",
        (() => {
          const base = definition("route-unavailable");
          return {
            ...base,
            candidate: { ...base.candidate, availability: "unavailable" },
          };
        })(),
      ],
      [
        "unauthorized",
        (() => {
          const base = definition("route-unauthorized");
          return {
            ...base,
            candidate: { ...base.candidate, authorized: false },
          };
        })(),
      ],
      [
        "missing-capability",
        (() => {
          const base = definition("route-missing-capability");
          return {
            ...base,
            candidate: {
              ...base.candidate,
              capabilities: ["repository-read"],
            },
          };
        })(),
      ],
      [
        "stale-health",
        (() => {
          const base = definition("route-stale-health");
          return {
            ...base,
            candidate: { ...base.candidate, healthObservedAt: staleHealth },
          };
        })(),
      ],
      [
        "future-health",
        (() => {
          const base = definition("route-future-health");
          return {
            ...base,
            candidate: { ...base.candidate, healthObservedAt: futureHealth },
          };
        })(),
      ],
      [
        "borrowed-policy",
        {
          ...borrowed,
          candidate: {
            ...borrowed.candidate,
            borrowedPolicy: {
              taskClass: "claude-code",
              taskAuthorized: false,
              modelAllowed: true,
            },
          },
        },
      ],
    ];

    for (const [name, work] of cases) {
      const { usage, runtime } = createHarness();
      const claimed = await enqueueAndClaim(runtime, work);
      usage.set(snapshotFor(claimed));
      await expect(
        runtime.reserveUsage({
          type: "reserve-usage",
          commandId: `command:reserve:${name}:refused`,
          ...fenced(claimed),
          circuit: circuitFor(claimed),
        }),
      ).rejects.toMatchObject({ code: "USAGE_REFUSED" });
      expect(usage.reads()).toBe(0);
      await runtime.close();
    }

    const replayHarness = createHarness();
    const unavailable = definition("route-replay-unavailable");
    const unavailableWork: WorkerWorkDefinition = {
      ...unavailable,
      candidate: { ...unavailable.candidate, availability: "unavailable" },
    };
    const claimed = await enqueueAndClaim(
      replayHarness.runtime,
      unavailableWork,
    );
    const snapshot = snapshotFor(claimed);
    const circuit = circuitFor(claimed);
    const reservationId = `reservation:${createHash("sha256")
      .update(
        toCanonicalJson({
          definitionFingerprint: claimed.definitionFingerprint,
          attempt: claimed.attempt,
          snapshotId: snapshot.snapshotId,
        }),
      )
      .digest("hex")
      .slice(0, 32)}`;
    const forgedReservation = createWorkerRuntimeEvent({
      workId: claimed.definition.workId,
      sequence: claimed.sequence + 1,
      occurredAt: BASE_TIME,
      type: "usage.reserved",
      command: {
        type: "reserve-usage",
        commandId: "command:reserve:route-replay-unavailable",
        ...fenced(claimed),
        circuit,
      },
      payload: {
        reservation: {
          reservationId,
          snapshotId: snapshot.snapshotId,
          sourceAdapterVersion: snapshot.sourceAdapterVersion,
          sourceFingerprint: snapshot.sourceFingerprint,
          observedAt: snapshot.observedAt,
          fiveHourWindowId: snapshot.fiveHour.windowId,
          fiveHourResetAt: snapshot.fiveHour.resetAt,
          weeklyWindowId: snapshot.weekly.windowId,
          weeklyResetAt: snapshot.weekly.resetAt,
          usedFiveHourBasisPoints: snapshot.fiveHour.usedBasisPoints,
          usedWeeklyBasisPoints: snapshot.weekly.usedBasisPoints,
          predictedFiveHourBasisPoints:
            claimed.definition.candidate.predictedFiveHourBasisPoints,
          predictedWeeklyBasisPoints:
            claimed.definition.candidate.predictedWeeklyBasisPoints,
          estimatedUsage: claimed.definition.estimatedUsage,
          circuit,
          reservedAt: BASE_TIME,
          status: "reserved",
          actualUsage: null,
          reconciledAt: null,
        },
        usageSnapshot: snapshot,
      },
    });
    const replayHistory = await replayHarness.runtime.history(
      claimed.definition.task.idempotencyKey,
    );
    expect(() =>
      replayWorkerRuntimeEvents([...replayHistory, forgedReservation]),
    ).toThrow(/authorize the exact event route/i);
    await replayHarness.runtime.close();
  });

  it("binds circuit source identity and observation order across reservation and preparation", async () => {
    const { usage, runtime } = createHarness();
    const claimed = await enqueueAndClaim(
      runtime,
      definition("circuit-refresh-binding"),
    );
    const snapshot = snapshotFor(claimed);
    usage.set(snapshot);
    const reserved = await runtime.reserveUsage({
      type: "reserve-usage",
      commandId: "command:reserve:circuit-refresh-binding",
      ...fenced(claimed),
      circuit: circuitFor(claimed),
    });
    const reads = usage.reads();
    for (const [suffix, circuit] of [
      ["source", circuitFor(reserved, { sourceFingerprint: "c".repeat(64) })],
      [
        "backwards",
        circuitFor(reserved, {
          observedAt: new Date(Date.parse(BASE_TIME) - 1).toISOString(),
        }),
      ],
    ] as const) {
      await expect(
        runtime.prepareDispatch({
          type: "prepare-dispatch",
          commandId: `command:prepare:circuit-${suffix}`,
          ...fenced(reserved),
          circuit,
        }),
      ).rejects.toMatchObject({ code: "CIRCUIT_OPEN" });
      expect(usage.reads()).toBe(reads);
    }

    const prepared = await runtime.prepareDispatch({
      type: "prepare-dispatch",
      commandId: "command:prepare:circuit-refresh-binding",
      ...fenced(reserved),
      circuit: circuitFor(reserved),
    });
    const history = await runtime.history(
      claimed.definition.task.idempotencyKey,
    );
    const last = history.at(-1)!;
    const payload = last.payload as Record<string, unknown>;
    const dispatch = payload["dispatch"] as Record<string, unknown>;
    const substitutedCircuit = circuitFor(prepared, {
      sourceFingerprint: "c".repeat(64),
    });
    const usageSnapshot = payload[
      "usageSnapshot"
    ] as NormalizedCanonicalUsageSnapshot;
    const substitutedDispatch = {
      ...dispatch,
      circuit: substitutedCircuit,
      requestFingerprint: createHash("sha256")
        .update(
          toCanonicalJson({
            definitionFingerprint: prepared.definitionFingerprint,
            attempt: prepared.attempt,
            route: prepared.dispatch!.route,
            reservationId: prepared.reservation!.reservationId,
            dispatchId: prepared.dispatch!.dispatchId,
            usageSnapshot,
            circuit: substitutedCircuit,
          }),
        )
        .digest("hex"),
    };
    const forged = createWorkerRuntimeEvent({
      workId: last.workId,
      sequence: last.sequence,
      occurredAt: last.occurredAt,
      type: last.type,
      command: { ...last.command, circuit: substitutedCircuit },
      payload: { ...payload, dispatch: substitutedDispatch },
    });
    expect(() =>
      replayWorkerRuntimeEvents([...history.slice(0, -1), forged]),
    ).toThrow(/dispatch intent/i);
    await runtime.close();
  });

  it("fingerprints complete dispatch evidence and rejects a replayed start downgrade", async () => {
    const left = createHarness();
    const right = createHarness();
    const work = definition("dispatch-evidence-fingerprint");
    const leftClaim = await enqueueAndClaim(left.runtime, work);
    const rightClaim = await enqueueAndClaim(right.runtime, work);
    const initial = snapshotFor(leftClaim);
    left.usage.set(initial);
    right.usage.set(initial);
    const leftReserved = await left.runtime.reserveUsage({
      type: "reserve-usage",
      commandId: "command:reserve:dispatch-evidence",
      ...fenced(leftClaim),
      circuit: circuitFor(leftClaim),
    });
    const rightReserved = await right.runtime.reserveUsage({
      type: "reserve-usage",
      commandId: "command:reserve:dispatch-evidence",
      ...fenced(rightClaim),
      circuit: circuitFor(rightClaim, { sourceFingerprint: "c".repeat(64) }),
    });
    const refreshed = (
      state: WorkerRuntimeState,
      fiveHourUsed: number,
      weeklyUsed: number,
    ) =>
      snapshotFor(state, {
        snapshotId: initial.snapshotId,
        fiveHour: {
          ...initial.fiveHour,
          usedBasisPoints: fiveHourUsed,
          remainingBasisPoints: 10_000 - fiveHourUsed,
        },
        weekly: {
          ...initial.weekly,
          usedBasisPoints: weeklyUsed,
          remainingBasisPoints: 10_000 - weeklyUsed,
        },
      });
    left.usage.set(refreshed(leftReserved, 1_100, 2_100));
    right.usage.set(refreshed(rightReserved, 1_200, 2_200));
    const leftPrepared = await left.runtime.prepareDispatch({
      type: "prepare-dispatch",
      commandId: "command:prepare:dispatch-evidence",
      ...fenced(leftReserved),
      circuit: circuitFor(leftReserved, { sourceFingerprint: "b".repeat(64) }),
    });
    const rightPrepared = await right.runtime.prepareDispatch({
      type: "prepare-dispatch",
      commandId: "command:prepare:dispatch-evidence",
      ...fenced(rightReserved),
      circuit: circuitFor(rightReserved, { sourceFingerprint: "c".repeat(64) }),
    });
    expect(leftPrepared.dispatch).toMatchObject({
      dispatchId: rightPrepared.dispatch?.dispatchId,
      usageSnapshotId: rightPrepared.dispatch?.usageSnapshotId,
      circuit: { evidenceId: rightPrepared.dispatch?.circuit.evidenceId },
    });
    expect(leftPrepared.dispatch?.requestFingerprint).not.toBe(
      rightPrepared.dispatch?.requestFingerprint,
    );

    left.usage.set(refreshed(leftPrepared, 1_300, 2_300));
    const running = await left.runtime.markDispatchStarted({
      type: "mark-dispatch-started",
      commandId: "command:start:dispatch-evidence",
      ...fenced(leftPrepared),
      dispatchId: leftPrepared.dispatch!.dispatchId,
    });
    const history = await left.runtime.history(work.task.idempotencyKey);
    const started = history.at(-1)!;
    const payload = started.payload as Record<string, unknown>;
    const snapshot = payload[
      "usageSnapshot"
    ] as NormalizedCanonicalUsageSnapshot;
    const forged = createWorkerRuntimeEvent({
      workId: started.workId,
      sequence: started.sequence,
      occurredAt: started.occurredAt,
      type: started.type,
      command: started.command,
      payload: {
        ...payload,
        usageSnapshot: {
          ...snapshot,
          fiveHour: {
            ...snapshot.fiveHour,
            usedBasisPoints: 1_050,
            remainingBasisPoints: 8_950,
          },
          weekly: {
            ...snapshot.weekly,
            usedBasisPoints: 2_050,
            remainingBasisPoints: 7_950,
          },
        },
      },
    });
    expect(() =>
      replayWorkerRuntimeEvents([...history.slice(0, -1), forged]),
    ).toThrow(/moved backwards/i);
    expect(running.latestUsageSnapshot?.weekly.usedBasisPoints).toBe(2_300);
    await left.runtime.close();
    await right.runtime.close();
  });

  it("retains every globally ordered same-clock observation in the cross-work cap ledger", async () => {
    const clock = new ManualClock();
    const { usage, runtime } = createHarness({
      clock,
      configuration: { ...CONFIGURATION, leaseDurationMs: 60_000 },
    });
    const shared = {
      capacityPool: "parallel" as const,
      profileId: "profile:prepared-ledger",
      ownership: "authorized-borrowed" as const,
      predictedFiveHourBasisPoints: 1,
      predictedWeeklyBasisPoints: 100,
      dispatchMs: 60_000,
    };
    const claims: WorkerRuntimeState[] = [];
    for (const name of ["ledger-a", "ledger-b", "ledger-c"]) {
      claims.push(
        await enqueueAndClaim(
          runtime,
          definition(name, shared),
          `worker:${name}`,
        ),
      );
    }
    const snapshot = (state: WorkerRuntimeState, used: number, at: string) =>
      snapshotFor(state, {
        observedAt: at,
        fiveHour: {
          ...snapshotFor(state).fiveHour,
          usedBasisPoints: 1_000,
          remainingBasisPoints: 9_000,
        },
        weekly: {
          ...snapshotFor(state).weekly,
          usedBasisPoints: used,
          remainingBasisPoints: 10_000 - used,
        },
      });

    usage.set(snapshot(claims[0]!, 6_000, BASE_TIME));
    const first = await runtime.reserveUsage({
      type: "reserve-usage",
      commandId: "command:reserve:ledger-a",
      ...fenced(claims[0]!),
      circuit: circuitFor(claims[0]!),
    });
    const secondAt = clock.now().toISOString();
    usage.set(snapshot(claims[1]!, 6_100, secondAt));
    await runtime.reserveUsage({
      type: "reserve-usage",
      commandId: "command:reserve:ledger-b",
      ...fenced(claims[1]!),
      circuit: circuitFor(claims[1]!, { observedAt: secondAt }),
    });
    const preparedAt = clock.now().toISOString();
    usage.set(snapshot(first, 6_800, preparedAt));
    await runtime.prepareDispatch({
      type: "prepare-dispatch",
      commandId: "command:prepare:ledger-a",
      ...fenced(first),
      circuit: circuitFor(first, { observedAt: preparedAt }),
    });
    await expect(runtime.list()).resolves.toHaveLength(3);

    usage.set(snapshot(claims[2]!, 6_801, preparedAt));
    await expect(
      runtime.reserveUsage({
        type: "reserve-usage",
        commandId: "command:reserve:ledger-c-over-cap",
        ...fenced(claims[2]!),
        circuit: circuitFor(claims[2]!, { observedAt: preparedAt }),
      }),
    ).rejects.toMatchObject({ code: "USAGE_REFUSED" });
    usage.set(snapshot(claims[2]!, 6_100, preparedAt));
    await expect(
      runtime.reserveUsage({
        type: "reserve-usage",
        commandId: "command:reserve:ledger-c-stale",
        ...fenced(claims[2]!),
        circuit: circuitFor(claims[2]!, { observedAt: preparedAt }),
      }),
    ).rejects.toMatchObject({ code: "USAGE_REFUSED" });
    await runtime.close();
  });

  it("preserves the first reservation release boundary across later retry-wait events", async () => {
    const { usage, runtime } = createHarness();
    const shared = {
      capacityPool: "parallel" as const,
      profileId: "profile:first-release-boundary",
      ownership: "authorized-borrowed" as const,
      predictedFiveHourBasisPoints: 1,
      predictedWeeklyBasisPoints: 600,
    };
    const first = await enqueueAndClaim(
      runtime,
      definition("release-boundary-a", shared),
      "worker:release-boundary-a",
    );
    const second = await enqueueAndClaim(
      runtime,
      definition("release-boundary-b", shared),
      "worker:release-boundary-b",
    );
    const nearCap = (state: WorkerRuntimeState) =>
      snapshotFor(state, {
        weekly: {
          ...snapshotFor(state).weekly,
          usedBasisPoints: 6_400,
          remainingBasisPoints: 3_600,
        },
      });
    usage.set(nearCap(first));
    const reservedFirst = await runtime.reserveUsage({
      type: "reserve-usage",
      commandId: "command:reserve:release-boundary-a",
      ...fenced(first),
      circuit: circuitFor(first),
    });
    const waiting = await runtime.fail({
      type: "fail-work",
      commandId: "command:fail:release-boundary-a",
      ...fenced(reservedFirst),
      dispatchId: null,
      classification: "provider",
      code: "provider-unavailable",
      retryable: true,
      actualUsage: normalizedUsage({
        inputTokens: 0,
        outputTokens: 0,
        costMicros: 0,
      }),
    });
    expect(waiting).toMatchObject({
      status: "retry-wait",
      reservation: { status: "released" },
    });

    usage.set(nearCap(second));
    await expect(
      runtime.reserveUsage({
        type: "reserve-usage",
        commandId: "command:reserve:release-boundary-b",
        ...fenced(second),
        circuit: circuitFor(second),
      }),
    ).resolves.toMatchObject({ reservation: { status: "reserved" } });
    await runtime.cancel({
      type: "cancel-work",
      commandId: "command:cancel:release-boundary-a",
      idempotencyKey: waiting.definition.task.idempotencyKey,
      code: "operator-cancelled",
    });
    await expect(runtime.list()).resolves.toHaveLength(2);
    await runtime.close();
  });

  it("keeps profile ownership invariant while leaving owned usage uncapped", async () => {
    const conflict = createHarness();
    const shared = {
      capacityPool: "parallel" as const,
      profileId: "profile:ownership-invariant",
      predictedWeeklyBasisPoints: 1,
      predictedFiveHourBasisPoints: 1,
    };
    const borrowed = await enqueueAndClaim(
      conflict.runtime,
      definition("ownership-borrowed", {
        ...shared,
        ownership: "authorized-borrowed",
      }),
      "worker:ownership-borrowed",
    );
    const owned = await enqueueAndClaim(
      conflict.runtime,
      definition("ownership-owned", { ...shared, ownership: "owned" }),
      "worker:ownership-owned",
    );
    conflict.usage.set(snapshotFor(borrowed));
    await conflict.runtime.reserveUsage({
      type: "reserve-usage",
      commandId: "command:reserve:ownership-borrowed",
      ...fenced(borrowed),
      circuit: circuitFor(borrowed),
    });
    conflict.usage.set(snapshotFor(owned));
    await expect(
      conflict.runtime.reserveUsage({
        type: "reserve-usage",
        commandId: "command:reserve:ownership-owned",
        ...fenced(owned),
        circuit: circuitFor(owned),
      }),
    ).rejects.toMatchObject({ code: "USAGE_REFUSED" });
    await conflict.runtime.close();

    const positive = createHarness();
    const ownedClaim = await enqueueAndClaim(
      positive.runtime,
      definition("owned-high-usage", { ownership: "owned" }),
    );
    positive.usage.set(
      snapshotFor(ownedClaim, {
        fiveHour: {
          ...snapshotFor(ownedClaim).fiveHour,
          usedBasisPoints: 6_000,
          remainingBasisPoints: 4_000,
        },
        weekly: {
          ...snapshotFor(ownedClaim).weekly,
          usedBasisPoints: 8_000,
          remainingBasisPoints: 2_000,
        },
      }),
    );
    await expect(
      positive.runtime.reserveUsage({
        type: "reserve-usage",
        commandId: "command:reserve:owned-high-usage",
        ...fenced(ownedClaim),
        circuit: circuitFor(ownedClaim),
      }),
    ).resolves.toMatchObject({ reservation: { status: "reserved" } });
    await expect(positive.runtime.list()).resolves.toHaveLength(1);
    await positive.runtime.close();
  });

  it("rejects premature or stale window rollover and accepts a post-reset successor", async () => {
    const clock = new ManualClock();
    const { usage, runtime } = createHarness({
      clock,
      configuration: { ...CONFIGURATION, leaseDurationMs: 60_000 },
    });
    const shared = {
      capacityPool: "parallel" as const,
      profileId: "profile:window-progression",
      ownership: "authorized-borrowed" as const,
      predictedFiveHourBasisPoints: 1,
      predictedWeeklyBasisPoints: 1,
      dispatchMs: 60_000,
    };
    const first = await enqueueAndClaim(
      runtime,
      definition("window-first", shared),
    );
    const firstReset = new Date(Date.parse(BASE_TIME) + 1_000).toISOString();
    const firstSnapshot = snapshotFor(first, {
      freshUntil: firstReset,
      fiveHour: {
        ...snapshotFor(first).fiveHour,
        windowId: "window:five:first",
        resetAt: firstReset,
      },
      weekly: {
        ...snapshotFor(first).weekly,
        windowId: "window:weekly:first",
        resetAt: firstReset,
      },
    });
    usage.set(firstSnapshot);
    const firstReserved = await runtime.reserveUsage({
      type: "reserve-usage",
      commandId: "command:reserve:window-first",
      ...fenced(first),
      circuit: circuitFor(first),
    });

    const premature = await enqueueAndClaim(
      runtime,
      definition("window-premature", shared),
      "worker:window-premature",
    );
    const secondReset = new Date(Date.parse(BASE_TIME) + 2_000).toISOString();
    usage.set(
      snapshotFor(premature, {
        freshUntil: secondReset,
        fiveHour: {
          ...snapshotFor(premature).fiveHour,
          windowId: "window:five:premature",
          resetAt: secondReset,
        },
        weekly: {
          ...snapshotFor(premature).weekly,
          windowId: "window:weekly:premature",
          resetAt: secondReset,
        },
      }),
    );
    await expect(
      runtime.reserveUsage({
        type: "reserve-usage",
        commandId: "command:reserve:window-premature",
        ...fenced(premature),
        circuit: circuitFor(premature),
      }),
    ).rejects.toMatchObject({ code: "USAGE_REFUSED" });

    await runtime.cancel({
      type: "cancel-work",
      commandId: "command:cancel:window-first",
      idempotencyKey: firstReserved.definition.task.idempotencyKey,
      code: "operator-cancelled",
    });
    clock.advance(1_500);
    const successor = await enqueueAndClaim(
      runtime,
      definition("window-successor", shared),
      "worker:window-successor",
    );
    const successorAt = clock.now().toISOString();
    const successorReset = new Date(
      clock.now().valueOf() + 2_000,
    ).toISOString();
    usage.set(
      snapshotFor(successor, {
        observedAt: successorAt,
        freshUntil: successorReset,
        fiveHour: {
          ...snapshotFor(successor).fiveHour,
          windowId: "window:five:successor",
          resetAt: successorReset,
        },
        weekly: {
          ...snapshotFor(successor).weekly,
          windowId: "window:weekly:successor",
          resetAt: successorReset,
        },
      }),
    );
    await expect(
      runtime.reserveUsage({
        type: "reserve-usage",
        commandId: "command:reserve:window-successor",
        ...fenced(successor),
        circuit: circuitFor(successor, { observedAt: successorAt }),
      }),
    ).resolves.toMatchObject({ reservation: { status: "reserved" } });
    await expect(runtime.list()).resolves.toHaveLength(3);
    await runtime.close();
  });

  it("carries active prior-window liability across weekly and five-hour resets", async () => {
    for (const dimension of ["weekly", "five-hour"] as const) {
      const clock = new ManualClock();
      const { usage, runtime } = createHarness({
        clock,
        configuration: { ...CONFIGURATION, leaseDurationMs: 60_000 },
      });
      const weekly = dimension === "weekly";
      const shared = {
        capacityPool: "parallel" as const,
        profileId: `profile:active-rollover:${dimension}`,
        ownership: "authorized-borrowed" as const,
        predictedFiveHourBasisPoints: weekly ? 1 : 3_000,
        predictedWeeklyBasisPoints: weekly ? 4_000 : 1,
        dispatchMs: 60_000,
      };
      const first = await enqueueAndClaim(
        runtime,
        definition(`active-rollover:${dimension}:first`, shared),
        `worker:active-rollover:${dimension}:first`,
      );
      const firstReset = new Date(Date.parse(BASE_TIME) + 1_000).toISOString();
      const boundedSnapshot = (
        state: WorkerRuntimeState,
        suffix: string,
        observedAt: string,
        resetAt: string,
      ) =>
        snapshotFor(state, {
          snapshotId: `usage:active-rollover:${dimension}:${suffix}`,
          observedAt,
          freshUntil: resetAt,
          fiveHour: {
            ...snapshotFor(state).fiveHour,
            windowId: `window:five:${dimension}:${suffix}`,
            usedBasisPoints: 1_000,
            remainingBasisPoints: 9_000,
            resetAt,
          },
          weekly: {
            ...snapshotFor(state).weekly,
            windowId: `window:weekly:${dimension}:${suffix}`,
            usedBasisPoints: weekly ? 2_000 : 1_000,
            remainingBasisPoints: weekly ? 8_000 : 9_000,
            resetAt,
          },
        });
      usage.set(boundedSnapshot(first, "first", BASE_TIME, firstReset));
      const reserved = await runtime.reserveUsage({
        type: "reserve-usage",
        commandId: `command:reserve:active-rollover:${dimension}:first`,
        ...fenced(first),
        circuit: circuitFor(first),
      });
      const prepared = await runtime.prepareDispatch({
        type: "prepare-dispatch",
        commandId: `command:prepare:active-rollover:${dimension}:first`,
        ...fenced(reserved),
        circuit: circuitFor(reserved),
      });
      if (weekly) {
        await runtime.markDispatchStarted({
          type: "mark-dispatch-started",
          commandId: "command:start:active-rollover:weekly:first",
          ...fenced(prepared),
          dispatchId: prepared.dispatch!.dispatchId,
        });
      }

      clock.advance(1_500);
      const second = await enqueueAndClaim(
        runtime,
        definition(`active-rollover:${dimension}:second`, shared),
        `worker:active-rollover:${dimension}:second`,
      );
      const observedAt = clock.now().toISOString();
      const successorReset = new Date(
        clock.now().valueOf() + 2_000,
      ).toISOString();
      usage.set(
        boundedSnapshot(second, "successor", observedAt, successorReset),
      );
      await expect(
        runtime.reserveUsage({
          type: "reserve-usage",
          commandId: `command:reserve:active-rollover:${dimension}:second`,
          ...fenced(second),
          circuit: circuitFor(second, { observedAt }),
        }),
      ).rejects.toMatchObject({ code: "USAGE_REFUSED" });
      await expect(runtime.list()).resolves.toHaveLength(2);
      await runtime.close();
    }
  });

  it("retains reconciled prediction until its authoritative usage window resets", async () => {
    const clock = new ManualClock();
    const { usage, runtime } = createHarness({
      clock,
      configuration: { ...CONFIGURATION, leaseDurationMs: 60_000 },
    });
    const shared = {
      capacityPool: "parallel" as const,
      profileId: "profile:reconciled-liability",
      ownership: "authorized-borrowed" as const,
      predictedFiveHourBasisPoints: 1,
      predictedWeeklyBasisPoints: 4_000,
      dispatchMs: 60_000,
    };
    const first = await enqueueAndClaim(
      runtime,
      definition("reconciled-liability:first", shared),
      "worker:reconciled-liability:first",
    );
    const initialSnapshot = snapshotFor(first, {
      snapshotId: "usage:reconciled-liability:first",
    });
    usage.set(initialSnapshot);
    const reserved = await runtime.reserveUsage({
      type: "reserve-usage",
      commandId: "command:reserve:reconciled-liability:first",
      ...fenced(first),
      circuit: circuitFor(first),
    });
    const prepared = await runtime.prepareDispatch({
      type: "prepare-dispatch",
      commandId: "command:prepare:reconciled-liability:first",
      ...fenced(reserved),
      circuit: circuitFor(reserved),
    });
    const running = await runtime.markDispatchStarted({
      type: "mark-dispatch-started",
      commandId: "command:start:reconciled-liability:first",
      ...fenced(prepared),
      dispatchId: prepared.dispatch!.dispatchId,
    });
    const completed = await runtime.complete({
      type: "complete-work",
      commandId: "command:complete:reconciled-liability:first",
      ...fenced(running),
      dispatchId: running.dispatch!.dispatchId,
      actualUsage: normalizedUsage({ costMicros: 100 }),
    });
    expect(completed).toMatchObject({
      status: "completed",
      reservation: { status: "reconciled" },
    });

    clock.advance(1);
    const second = await enqueueAndClaim(
      runtime,
      definition("reconciled-liability:second", shared),
      "worker:reconciled-liability:second",
    );
    const observedAt = clock.now().toISOString();
    usage.set(
      snapshotFor(second, {
        ...initialSnapshot,
        snapshotId: "usage:reconciled-liability:lagging",
        observedAt,
      }),
    );
    await expect(
      runtime.reserveUsage({
        type: "reserve-usage",
        commandId: "command:reserve:reconciled-liability:second",
        ...fenced(second),
        circuit: circuitFor(second, { observedAt }),
      }),
    ).rejects.toMatchObject({ code: "USAGE_REFUSED" });
    await expect(runtime.list()).resolves.toHaveLength(2);
    await runtime.close();
  });

  it("carries post-reset reconciliation into the next authoritative window", async () => {
    const clock = new ManualClock();
    const { usage, runtime } = createHarness({
      clock,
      configuration: { ...CONFIGURATION, leaseDurationMs: 60_000 },
    });
    const shared = {
      capacityPool: "parallel" as const,
      profileId: "profile:cross-reset-reconciliation",
      ownership: "authorized-borrowed" as const,
      predictedFiveHourBasisPoints: 1,
      predictedWeeklyBasisPoints: 4_000,
      dispatchMs: 60_000,
    };
    const first = await enqueueAndClaim(
      runtime,
      definition("cross-reset-reconciliation:first", shared),
      "worker:cross-reset-reconciliation:first",
    );
    const originReset = new Date(clock.now().valueOf() + 1_000).toISOString();
    usage.set(
      snapshotFor(first, {
        snapshotId: "usage:cross-reset-reconciliation:origin",
        freshUntil: originReset,
        fiveHour: {
          ...snapshotFor(first).fiveHour,
          windowId: "window:five:cross-reset:origin",
          resetAt: originReset,
        },
        weekly: {
          ...snapshotFor(first).weekly,
          windowId: "window:weekly:cross-reset:origin",
          resetAt: originReset,
        },
      }),
    );
    const reserved = await runtime.reserveUsage({
      type: "reserve-usage",
      commandId: "command:reserve:cross-reset-reconciliation:first",
      ...fenced(first),
      circuit: circuitFor(first),
    });
    const prepared = await runtime.prepareDispatch({
      type: "prepare-dispatch",
      commandId: "command:prepare:cross-reset-reconciliation:first",
      ...fenced(reserved),
      circuit: circuitFor(reserved),
    });
    const running = await runtime.markDispatchStarted({
      type: "mark-dispatch-started",
      commandId: "command:start:cross-reset-reconciliation:first",
      ...fenced(prepared),
      dispatchId: prepared.dispatch!.dispatchId,
    });

    clock.advance(1_500);
    const completed = await runtime.complete({
      type: "complete-work",
      commandId: "command:complete:cross-reset-reconciliation:first",
      ...fenced(running),
      dispatchId: running.dispatch!.dispatchId,
      actualUsage: normalizedUsage({ costMicros: 100 }),
    });
    expect(completed).toMatchObject({
      status: "completed",
      reservation: { status: "reconciled" },
    });

    const second = await enqueueAndClaim(
      runtime,
      definition("cross-reset-reconciliation:second", shared),
      "worker:cross-reset-reconciliation:second",
    );
    const observedAt = clock.now().toISOString();
    const freshUntil = new Date(clock.now().valueOf() + 60_000).toISOString();
    usage.set(
      snapshotFor(second, {
        snapshotId: "usage:cross-reset-reconciliation:successor",
        observedAt,
        freshUntil,
        fiveHour: {
          ...snapshotFor(second).fiveHour,
          windowId: "window:five:cross-reset:successor",
          resetAt: new Date(clock.now().valueOf() + 3_600_000).toISOString(),
        },
        weekly: {
          ...snapshotFor(second).weekly,
          windowId: "window:weekly:cross-reset:successor",
          resetAt: new Date(
            clock.now().valueOf() + 7 * 24 * 3_600_000,
          ).toISOString(),
        },
      }),
    );
    await expect(
      runtime.reserveUsage({
        type: "reserve-usage",
        commandId: "command:reserve:cross-reset-reconciliation:second",
        ...fenced(second),
        circuit: circuitFor(second, { observedAt }),
      }),
    ).rejects.toMatchObject({ code: "USAGE_REFUSED" });
    await expect(runtime.list()).resolves.toHaveLength(2);
    await runtime.close();
  });

  it("revalidates usage, circuit, and shared caps at the durable dispatch start boundary", async () => {
    const clock = new ManualClock("2026-08-10T07:59:59.000Z");
    const { usage, runtime } = createHarness({
      clock,
      configuration: {
        ...CONFIGURATION,
        leaseDurationMs: 10_000,
        usageFreshnessMs: 15 * 60_000,
      },
    });
    const shared = {
      createdAt: "2026-08-10T07:50:00.000Z",
      readyAt: "2026-08-10T07:50:00.000Z",
      capacityPool: "parallel" as const,
      profileId: "profile:start-boundary",
      ownership: "authorized-borrowed" as const,
      predictedFiveHourBasisPoints: 150,
      predictedWeeklyBasisPoints: 1,
      dispatchMs: 10_000,
    };
    const prepared: WorkerRuntimeState[] = [];
    for (const name of ["start-boundary-a", "start-boundary-b"]) {
      const claim = await enqueueAndClaim(
        runtime,
        definition(name, shared),
        `worker:${name}`,
      );
      const observedAt = "2026-08-10T07:59:58.500Z";
      usage.set(
        snapshotFor(claim, {
          observedAt,
          fiveHour: {
            ...snapshotFor(claim).fiveHour,
            usedBasisPoints: 4_800,
            remainingBasisPoints: 5_200,
          },
        }),
      );
      const reserved = await runtime.reserveUsage({
        type: "reserve-usage",
        commandId: `command:reserve:${name}`,
        ...fenced(claim),
        circuit: circuitFor(claim, { observedAt }),
      });
      prepared.push(
        await runtime.prepareDispatch({
          type: "prepare-dispatch",
          commandId: `command:prepare:${name}`,
          ...fenced(reserved),
          circuit: circuitFor(reserved, { observedAt }),
        }),
      );
    }
    clock.set("2026-08-10T08:00:00.500Z");
    const refreshedAt = "2026-08-10T08:00:00.000Z";
    for (const state of prepared) {
      usage.set(
        snapshotFor(state, {
          observedAt: refreshedAt,
          fiveHour: {
            ...snapshotFor(state).fiveHour,
            usedBasisPoints: 4_800,
            remainingBasisPoints: 5_200,
          },
        }),
      );
      await expect(
        runtime.markDispatchStarted({
          type: "mark-dispatch-started",
          commandId: `command:start:${state.definition.workId}`,
          ...fenced(state),
          dispatchId: state.dispatch!.dispatchId,
        }),
      ).rejects.toMatchObject({ code: "USAGE_REFUSED" });
    }
    expect(
      (await runtime.list()).filter((state) => state.status === "running"),
    ).toHaveLength(0);
    await runtime.close();
  });

  it("serializes concurrent borrowed reservations through SQLite", async () => {
    const clock = new ManualClock();
    const usage = mutableUsageAdapter();
    const runtime = createProductionDisabledWorkerRuntime({
      persistence: createSqlitePersistenceAdapter({ memory: true, clock }),
      usageAdapter: usage.adapter,
      clock,
      configuration: CONFIGURATION,
    });
    const shared = {
      capacityPool: "parallel" as const,
      profileId: "profile:sqlite-cap",
      ownership: "authorized-borrowed" as const,
      predictedFiveHourBasisPoints: 1,
      predictedWeeklyBasisPoints: 6,
    };
    const claims = await Promise.all(
      ["sqlite-cap-a", "sqlite-cap-b"].map((name) =>
        enqueueAndClaim(runtime, definition(name, shared), `worker:${name}`),
      ),
    );
    const bounded = (state: WorkerRuntimeState) =>
      snapshotFor(state, {
        weekly: {
          ...snapshotFor(state).weekly,
          usedBasisPoints: 6_990,
          remainingBasisPoints: 3_010,
        },
      });
    usage.set(bounded(claims[0]!));
    const results = await Promise.allSettled(
      claims.map((state, index) =>
        runtime.reserveUsage({
          type: "reserve-usage",
          commandId: `command:reserve:sqlite-cap-${index}`,
          ...fenced(state),
          circuit: circuitFor(state),
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    await runtime.close();
  });

  it("does not start a usage read after close wins a preflight race", async () => {
    for (const stage of ["reserve", "prepare"] as const) {
      const clock = new ManualClock();
      const persistence = pausableMemoryPersistence(clock);
      const usage = mutableUsageAdapter();
      const runtime = createProductionDisabledWorkerRuntime({
        persistence: persistence.adapter,
        usageAdapter: usage.adapter,
        clock,
        configuration: CONFIGURATION,
      });
      const claimed = await enqueueAndClaim(
        runtime,
        definition(`close-race-${stage}`),
      );
      usage.set(snapshotFor(claimed));
      const state =
        stage === "prepare"
          ? await runtime.reserveUsage({
              type: "reserve-usage",
              commandId: "command:reserve:close-race-prepare",
              ...fenced(claimed),
              circuit: circuitFor(claimed),
            })
          : claimed;
      const readsBefore = usage.reads();
      const barrier = persistence.pauseNext();
      const pending =
        stage === "reserve"
          ? runtime.reserveUsage({
              type: "reserve-usage",
              commandId: "command:reserve:close-race-reserve",
              ...fenced(state),
              circuit: circuitFor(state),
            })
          : runtime.prepareDispatch({
              type: "prepare-dispatch",
              commandId: "command:prepare:close-race-prepare",
              ...fenced(state),
              circuit: circuitFor(state),
            });
      await barrier.entered;
      await runtime.close();
      barrier.release();
      await expect(pending).rejects.toBeDefined();
      expect(usage.reads()).toBe(readsBefore);
    }
  });

  it("binds every scheduler-owned tick transition to its deterministic identity", async () => {
    const assertForgedTickRejected = (
      history: readonly ReturnType<typeof createWorkerRuntimeEvent>[],
    ) => {
      const last = history.at(-1)!;
      const forged = createWorkerRuntimeEvent({
        workId: last.workId,
        sequence: last.sequence,
        occurredAt: last.occurredAt,
        type: last.type,
        command: {
          ...(last.command as Record<string, unknown>),
          commandId: "command:forged-tick",
        },
        payload: last.payload,
      });
      expect(() =>
        replayWorkerRuntimeEvents([...history.slice(0, -1), forged]),
      ).toThrow(/command type or identity|deterministic/i);
    };

    const retryHarness = createHarness();
    const retryClaim = await enqueueAndClaim(
      retryHarness.runtime,
      definition("tick-retry"),
    );
    retryHarness.clock.advance(CONFIGURATION.leaseDurationMs + 1);
    await retryHarness.runtime.tick();
    assertForgedTickRejected(
      await retryHarness.runtime.history(
        retryClaim.definition.task.idempotencyKey,
      ),
    );
    const waiting = await retryHarness.runtime.get(
      retryClaim.definition.task.idempotencyKey,
    );
    if (waiting?.nextReadyAt === null || waiting === null) {
      throw new Error("expected retry wait");
    }
    retryHarness.clock.set(waiting.nextReadyAt);
    const competingReady = await Promise.all([
      retryHarness.runtime.tick(),
      retryHarness.runtime.tick(),
    ]);
    expect(competingReady.flat()).toHaveLength(1);
    assertForgedTickRejected(
      await retryHarness.runtime.history(
        retryClaim.definition.task.idempotencyKey,
      ),
    );
    await retryHarness.runtime.close();

    const exhaustedHarness = createHarness();
    const exhausted = await enqueueAndClaim(
      exhaustedHarness.runtime,
      definition("tick-exhausted", { maximumAttempts: 1 }),
    );
    exhaustedHarness.clock.advance(CONFIGURATION.leaseDurationMs + 1);
    await exhaustedHarness.runtime.tick();
    assertForgedTickRejected(
      await exhaustedHarness.runtime.history(
        exhausted.definition.task.idempotencyKey,
      ),
    );
    await exhaustedHarness.runtime.close();

    const runningHarness = createHarness();
    const runningClaim = await enqueueAndClaim(
      runningHarness.runtime,
      definition("tick-running"),
    );
    await startDispatch(
      runningHarness.runtime,
      runningHarness.usage,
      runningClaim,
    );
    runningHarness.clock.advance(CONFIGURATION.leaseDurationMs + 1);
    await runningHarness.runtime.tick();
    assertForgedTickRejected(
      await runningHarness.runtime.history(
        runningClaim.definition.task.idempotencyKey,
      ),
    );
    await runningHarness.runtime.close();

    const deadlineHarness = createHarness();
    const deadlineClaim = await enqueueAndClaim(
      deadlineHarness.runtime,
      definition("tick-deadline"),
    );
    await expect(
      deadlineHarness.runtime.cancel({
        type: "cancel-work",
        commandId: "command:spoof-deadline",
        idempotencyKey: deadlineClaim.definition.task.idempotencyKey,
        code: "deadline-expired",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TASK" });
    deadlineHarness.clock.set(deadlineClaim.definition.task.deadline);
    await deadlineHarness.runtime.tick();
    assertForgedTickRejected(
      await deadlineHarness.runtime.history(
        deadlineClaim.definition.task.idempotencyKey,
      ),
    );
    await deadlineHarness.runtime.close();
  });

  it("refuses every live effect class and remains production-disabled", async () => {
    const { runtime } = createHarness();
    for (const effect of [
      "provider",
      "workspace",
      "git",
      "network",
      "native",
      "credential",
    ]) {
      expect(() => runtime.assertLiveEffectDisabled(effect)).toThrowError(
        expect.objectContaining({ code: "PRODUCTION_DISABLED" }),
      );
    }
    await runtime.close();
  });

  it("fails closed across public definition, circuit, event, configuration, and clock parsers", async () => {
    const base = definition("public-validation");
    expect(() =>
      parseWorkerWorkDefinition({ ...base, schemaVersion: 2 }),
    ).toThrow();
    expect(() =>
      parseWorkerWorkDefinition({
        ...base,
        candidate: { ...base.candidate, modelId: "model:substituted" },
      }),
    ).toThrow();
    expect(() =>
      parseWorkerWorkDefinition({
        ...base,
        estimatedUsage: normalizedUsage({ costMicros: null }),
      }),
    ).toThrow(/invalid/i);
    expect(() =>
      parseWorkerWorkDefinition({ ...base, readyAt: base.task.deadline }),
    ).toThrow();
    expect(() =>
      parseWorkerWorkDefinition({
        ...base,
        estimatedUsage: normalizedUsage({
          inputTokens: base.task.budget.maximumInputTokens + 1,
          costMicros: 100,
        }),
      }),
    ).toThrow();
    expect(() => parseWorkerWorkDefinition(null)).toThrow();
    expect(() =>
      parseProviderCircuitEvidence({
        ...circuitFor({ definition: base, attempt: 1 } as WorkerRuntimeState),
        schemaVersion: 2,
      }),
    ).toThrow();
    expect(() => replayWorkerRuntimeEvents([])).toThrow(/empty/i);
    expect(() => replayWorkerRuntimeEvents([undefined] as never)).toThrow(
      /first/i,
    );
    expect(() =>
      parseWorkerRuntimeEvent({
        schemaVersion: 2,
        eventId: "runtime-event:invalid",
        workId: base.workId,
        sequence: 1,
        occurredAt: BASE_TIME,
        type: "work.enqueued",
        command: {
          type: "enqueue-work",
          commandId: "command:invalid",
          definition: base,
        },
        commandId: "command:invalid",
        commandFingerprint: "a".repeat(64),
        payload: {},
      }),
    ).toThrow();
    expect(() =>
      createWorkerRuntimeEvent({
        workId: base.workId,
        sequence: 1,
        occurredAt: BASE_TIME,
        type: "work.enqueued",
        command: {
          type: "enqueue-work",
          commandId: "command:invalid-payload",
          definition: base,
        },
        payload: "not-an-object",
      }),
    ).toThrow(/payload/i);
    expect(() =>
      parseWorkerRuntimeCommand({
        type: "cancel-work",
        commandId: "command:invalid-extra",
        idempotencyKey: base.task.idempotencyKey,
        code: "operator-cancelled",
        ignored: "must-not-be-accepted",
      }),
    ).toThrow();
    expect(() =>
      parseWorkerRuntimeCommand({
        type: "enqueue-work",
        commandId: `tick:${"a".repeat(64)}`,
        definition: base,
      }),
    ).toThrow(/reserved|command/i);

    const longKey = `idempotency:${"a".repeat(180)}`;
    const longKeyRuntime = createHarness().runtime;
    await longKeyRuntime.enqueue({
      type: "enqueue-work",
      commandId: "command:long-idempotency-key",
      definition: {
        ...base,
        workId: "work:long-idempotency-key",
        task: {
          ...base.task,
          taskId: "task:long-idempotency-key",
          idempotencyKey: longKey,
        },
      },
    });
    await expect(longKeyRuntime.get(longKey)).resolves.toMatchObject({
      definition: { task: { idempotencyKey: longKey } },
    });
    await longKeyRuntime.close();

    const duplicatePools = {
      ...CONFIGURATION,
      capacityPools: [
        { poolId: "default", maximumActive: 1 },
        { poolId: "default", maximumActive: 2 },
      ],
    };
    expect(() => createHarness({ configuration: duplicatePools })).toThrow(
      /unique/i,
    );
    expect(() =>
      createHarness({
        configuration: { ...CONFIGURATION, unknown: true } as never,
      }),
    ).toThrow();
    expect(() =>
      createHarness({
        configuration: { ...CONFIGURATION, maximumRetainedWorkItems: 0 },
      }),
    ).toThrow();
    expect(() =>
      createHarness({
        configuration: {
          ...CONFIGURATION,
          maximumRetainedWorkItems: 10_001,
        },
      }),
    ).toThrow();

    const invalidClock = { now: () => new Date("invalid") } as ManualClock;
    const usage = mutableUsageAdapter();
    const persistence = createMemoryPersistenceAdapter();
    const runtime = createProductionDisabledWorkerRuntime({
      persistence,
      usageAdapter: usage.adapter,
      clock: invalidClock,
      configuration: CONFIGURATION,
    });
    await expect(
      runtime.enqueue({
        type: "enqueue-work",
        commandId: "command:invalid-clock",
        definition: base,
      }),
    ).rejects.toMatchObject({ code: "STATE_CORRUPTION" });
    await runtime.close();
  });

  it("returns finite errors for invalid command variants and unavailable usage", async () => {
    const { usage, runtime } = createHarness();
    await expect(
      runtime.enqueue({ type: "wrong" } as never),
    ).rejects.toMatchObject({ code: "INVALID_TASK" });
    await expect(
      runtime.claim({ type: "wrong" } as never),
    ).rejects.toMatchObject({ code: "INVALID_TASK" });
    await expect(
      runtime.renew({ type: "wrong" } as never),
    ).rejects.toMatchObject({ code: "INVALID_TASK" });
    await expect(
      runtime.reserveUsage({ type: "wrong" } as never),
    ).rejects.toMatchObject({ code: "INVALID_TASK" });
    await expect(
      runtime.prepareDispatch({ type: "wrong" } as never),
    ).rejects.toMatchObject({ code: "INVALID_TASK" });
    await expect(
      runtime.markDispatchStarted({ type: "wrong" } as never),
    ).rejects.toMatchObject({ code: "INVALID_TASK" });
    await expect(
      runtime.complete({ type: "wrong" } as never),
    ).rejects.toMatchObject({ code: "INVALID_TASK" });
    await expect(
      runtime.fail({ type: "wrong" } as never),
    ).rejects.toMatchObject({ code: "INVALID_TASK" });
    await expect(
      runtime.cancel({ type: "wrong" } as never),
    ).rejects.toMatchObject({ code: "INVALID_TASK" });
    await expect(
      runtime.reconcileUsage({ type: "wrong" } as never),
    ).rejects.toMatchObject({ code: "INVALID_TASK" });

    const claimed = await enqueueAndClaim(
      runtime,
      definition("usage-unavailable"),
    );
    usage.set(null);
    await expect(
      runtime.reserveUsage({
        type: "reserve-usage",
        commandId: "command:reserve:missing-usage",
        ...fenced(claimed),
        circuit: circuitFor(claimed),
      }),
    ).rejects.toMatchObject({ code: "USAGE_REFUSED" });
    usage.setReader(async () => {
      throw new Error("secret-source-error");
    });
    await expect(
      runtime.reserveUsage({
        type: "reserve-usage",
        commandId: "command:reserve:throwing-usage",
        ...fenced(claimed),
        circuit: circuitFor(claimed),
      }),
    ).rejects.toMatchObject({ code: "USAGE_REFUSED" });
    usage.set({ schemaVersion: 99 });
    await expect(
      runtime.reserveUsage({
        type: "reserve-usage",
        commandId: "command:reserve:invalid-usage",
        ...fenced(claimed),
        circuit: circuitFor(claimed),
      }),
    ).rejects.toMatchObject({ code: "USAGE_REFUSED" });
    await runtime.close();
  });
});
