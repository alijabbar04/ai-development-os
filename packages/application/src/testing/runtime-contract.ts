import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PersistenceAdapter } from "@ai-dev-os/persistence";
import {
  DEFAULT_WORKER_RUNTIME_CONFIGURATION,
  type NormalizedCanonicalUsageSnapshot,
  type NormalizedUsage,
  type ProviderCircuitEvidence,
  type SchedulerClock,
  type UsageSnapshotAdapter,
  type WorkerRuntimeState,
  type WorkerWorkDefinition,
} from "@ai-dev-os/scheduler";
import {
  createProductionDisabledApplication,
  type ProductionDisabledApplication,
} from "../application-runtime.js";

export const APPLICATION_CONTRACT_EPOCH = "2026-08-10T10:00:00.000Z";

export interface ApplicationContractClock extends SchedulerClock {
  set(value: string): void;
  advance(milliseconds: number): void;
}

export interface ApplicationPersistenceHarness {
  readonly persistence: PersistenceAdapter;
  readonly reopen?: () => Promise<PersistenceAdapter>;
  readonly dispose?: () => Promise<void>;
}

export function createApplicationContractClock(
  initial = APPLICATION_CONTRACT_EPOCH,
): ApplicationContractClock {
  let current = Date.parse(initial);
  return {
    now: () => new Date(current),
    set(value): void {
      current = Date.parse(value);
    },
    advance(milliseconds): void {
      current += milliseconds;
    },
  };
}

const USAGE: NormalizedUsage = Object.freeze({
  inputTokens: 10,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 5,
  reasoningTokens: 0,
  toolCalls: 0,
  costMicros: 100,
});

export function createApplicationContractDefinition(): WorkerWorkDefinition {
  return {
    schemaVersion: 1,
    workId: "work:application-contract",
    task: {
      schemaVersion: 1,
      taskId: "task:application-contract",
      parentTaskId: null,
      correlationId: "correlation:application-contract",
      idempotencyKey: "idempotency:application-contract:0001",
      objective:
        "Prove the production-disabled application persistence contract.",
      workspace: {
        projectId: "project:application-contract",
        workspaceId: "workspace:application-contract",
        snapshotId: "snapshot:application-contract",
        baseRevision: "0123456789abcdef0123456789abcdef01234567",
      },
      requestedRoute: {
        providerId: "provider:fixture",
        modelId: "model:fixture",
        profileId: "profile:fixture",
        ownership: "owned",
      },
      capabilities: ["repository-read"],
      permissionMode: "contained-default",
      budget: {
        maximumInputTokens: 1_000,
        maximumOutputTokens: 1_000,
        maximumCostMicros: 10_000,
        maximumToolCalls: 10,
        maximumTurns: 2,
      },
      retry: {
        maximumAttempts: 2,
        initialBackoffMs: 100,
        maximumBackoffMs: 1_000,
        retryableFailures: ["disconnected", "provider"],
      },
      timeout: { dispatchMs: 1_000, attemptMs: 60_000 },
      expectedResultSchema: { type: "object" },
      priority: "normal",
      createdAt: APPLICATION_CONTRACT_EPOCH,
      deadline: "2026-08-10T12:00:00.000Z",
    },
    candidate: {
      schemaVersion: 1,
      candidateId: "candidate:fixture",
      providerId: "provider:fixture",
      modelId: "model:fixture",
      profileId: "profile:fixture",
      ownership: "owned",
      borrowedPolicy: null,
      authorized: true,
      availability: "available",
      health: "healthy",
      healthObservedAt: APPLICATION_CONTRACT_EPOCH,
      capabilities: ["repository-read"],
      permissionModes: ["contained-default"],
      qualityScore: 500,
      costScore: 500,
      predictedFiveHourBasisPoints: 10,
      predictedWeeklyBasisPoints: 10,
    },
    workloadClass: "general",
    capacityPool: "default",
    fairnessKey: "tenant:application-contract",
    readyAt: APPLICATION_CONTRACT_EPOCH,
    estimatedUsage: USAGE,
  };
}

const definition = createApplicationContractDefinition;

function usageSnapshot(): NormalizedCanonicalUsageSnapshot {
  return {
    schemaVersion: 3,
    compatibility: "native-v3",
    snapshotId: "usage:application-contract",
    sourceAdapterId: "adapter:application-contract",
    sourceAdapterVersion: "version:1",
    sourceFingerprint: "a".repeat(64),
    sourceClass: "provider-authoritative",
    authoritative: true,
    confidence: "high",
    profileId: "profile:fixture",
    providerId: "provider:fixture",
    ownership: "owned",
    authorization: "authorized",
    revocation: "not-revoked",
    timezone: "Europe/London",
    observedAt: APPLICATION_CONTRACT_EPOCH,
    freshUntil: "2026-08-10T10:15:00.000Z",
    fiveHour: {
      windowId: "window:five-hour:application-contract",
      status: "active",
      usedBasisPoints: 1_000,
      remainingBasisPoints: 9_000,
      resetAt: "2026-08-10T13:00:00.000Z",
    },
    weekly: {
      windowId: "window:weekly:application-contract",
      status: "active",
      usedBasisPoints: 2_000,
      remainingBasisPoints: 8_000,
      resetAt: "2026-08-17T00:00:00.000Z",
    },
  };
}

function usageAdapter(
  adapterId = "adapter:application-contract",
): UsageSnapshotAdapter {
  return Object.freeze({
    adapterId,
    schemaVersion: 3,
    readAuthorizedSnapshot: async () => usageSnapshot(),
  });
}

function circuit(state: WorkerRuntimeState): ProviderCircuitEvidence {
  return {
    schemaVersion: 1,
    evidenceId: `circuit:${state.attempt}`,
    providerId: "provider:fixture",
    profileId: "profile:fixture",
    state: "closed",
    observedAt: APPLICATION_CONTRACT_EPOCH,
    sourceFingerprint: "b".repeat(64),
  };
}

function fence(state: WorkerRuntimeState) {
  if (state.lease === null)
    throw new Error("contract fixture expected a lease");
  return {
    idempotencyKey: state.definition.task.idempotencyKey,
    leaseId: state.lease.leaseId,
    workerId: state.lease.workerId,
    fencingToken: state.lease.fencingToken,
  };
}

async function createWork(
  application: ProductionDisabledApplication,
): Promise<WorkerRuntimeState> {
  const enqueueCommand = {
    type: "enqueue-work",
    commandId: "command:application:enqueue",
    definition: definition(),
  } as const;
  const enqueued = await application.execute(enqueueCommand);
  const duplicate = await application.execute(enqueueCommand);
  expect(enqueued).toMatchObject({ outcome: "created" });
  expect(duplicate).toMatchObject({ outcome: "duplicate" });
  if (
    enqueued === null ||
    duplicate === null ||
    !("outcome" in enqueued) ||
    !("outcome" in duplicate)
  ) {
    throw new Error("contract fixture expected enqueue results");
  }
  expect(duplicate.state).toEqual(enqueued.state);
  const claimed = await application.execute({
    type: "claim-work",
    commandId: "command:application:claim",
    workerId: "worker:application",
    allowedCapacityPools: ["default"],
  });
  if (claimed === null || "outcome" in claimed || claimed.lease === null) {
    throw new Error("contract fixture expected claimed state");
  }
  return claimed;
}

/**
 * Reusable behavioral contract for the Stage 18C application over any
 * transactionally equivalent persistence adapter. PostgreSQL parity must run
 * this same suite when that adapter exists; this checkpoint supplies no fake.
 */
export function runApplicationPersistenceContractSuite(
  suiteName: string,
  createHarness: (
    clock: ApplicationContractClock,
  ) => Promise<ApplicationPersistenceHarness> | ApplicationPersistenceHarness,
  options: { readonly supportsReopen?: boolean } = {},
): void {
  describe(`application persistence contract: ${suiteName}`, () => {
    let clock: ApplicationContractClock;
    let harness: ApplicationPersistenceHarness;
    let application: ProductionDisabledApplication;

    beforeEach(async () => {
      clock = createApplicationContractClock();
      harness = await createHarness(clock);
      application = createProductionDisabledApplication({
        persistence: harness.persistence,
        usageAdapter: usageAdapter(),
        clock,
      });
    });

    afterEach(async () => {
      await application.close();
      await harness.dispose?.();
    });

    it("executes the typed reservation/dispatch/reconciliation lifecycle exactly once", async () => {
      const claimed = await createWork(application);
      const reserved = await application.execute({
        type: "reserve-usage",
        commandId: "command:application:reserve",
        ...fence(claimed),
        circuit: circuit(claimed),
      });
      if (reserved === null || "outcome" in reserved)
        throw new Error("expected reserved state");
      const prepared = await application.execute({
        type: "prepare-dispatch",
        commandId: "command:application:prepare",
        ...fence(reserved),
        circuit: circuit(reserved),
      });
      if (
        prepared === null ||
        "outcome" in prepared ||
        prepared.dispatch === null
      ) {
        throw new Error("expected prepared state");
      }
      const running = await application.execute({
        type: "mark-dispatch-started",
        commandId: "command:application:start",
        ...fence(prepared),
        dispatchId: prepared.dispatch.dispatchId,
      });
      if (
        running === null ||
        "outcome" in running ||
        running.dispatch === null
      ) {
        throw new Error("expected running state");
      }
      const completed = await application.execute({
        type: "complete-work",
        commandId: "command:application:complete",
        ...fence(running),
        dispatchId: running.dispatch.dispatchId,
        actualUsage: USAGE,
      });
      expect(completed).toMatchObject({
        status: "completed",
        reservation: { status: "reconciled" },
        dispatch: { status: "terminal" },
      });
      const history = await application.runtime.history(
        definition().task.idempotencyKey,
      );
      expect(history.map((event) => event.type)).toEqual([
        "work.enqueued",
        "lease.acquired",
        "usage.reserved",
        "dispatch.prepared",
        "dispatch.started",
        "work.completed",
      ]);
      expect(await application.tick()).toEqual([]);
    });

    if (options.supportsReopen === true) {
      it("reopens exact reservation, dispatch, pending, and reconciled boundaries without redispatch", async () => {
        if (harness.reopen === undefined) {
          throw new Error(
            "A reopen-capable application contract harness must provide reopen().",
          );
        }
        const claimed = await createWork(application);
        const reserveCommand = {
          type: "reserve-usage" as const,
          commandId: "command:application:reopen:reserve",
          ...fence(claimed),
          circuit: circuit(claimed),
        };
        const reserved = await application.execute(reserveCommand);
        if (reserved === null || "outcome" in reserved)
          throw new Error("expected reserved state");
        const reservedHistory = await application.runtime.history(
          definition().task.idempotencyKey,
        );
        await application.close();
        let duplicateReads = 0;
        application = createProductionDisabledApplication({
          persistence: await harness.reopen(),
          usageAdapter: {
            ...usageAdapter(),
            readAuthorizedSnapshot: async () => {
              duplicateReads += 1;
              throw new Error("duplicate-must-not-read");
            },
          },
          clock,
        });
        expect(
          await application.runtime.get(definition().task.idempotencyKey),
        ).toEqual(reserved);
        expect(
          await application.runtime.history(definition().task.idempotencyKey),
        ).toEqual(reservedHistory);
        expect(await application.execute(reserveCommand)).toEqual(reserved);
        expect(duplicateReads).toBe(0);

        await application.close();
        application = createProductionDisabledApplication({
          persistence: await harness.reopen(),
          usageAdapter: usageAdapter(),
          clock,
        });
        const prepareCommand = {
          type: "prepare-dispatch" as const,
          commandId: "command:application:reopen:prepare",
          ...fence(reserved),
          circuit: circuit(reserved),
        };
        const prepared = await application.execute(prepareCommand);
        if (
          prepared === null ||
          "outcome" in prepared ||
          prepared.dispatch === null
        ) {
          throw new Error("expected prepared state");
        }
        const preparedHistory = await application.runtime.history(
          definition().task.idempotencyKey,
        );

        await application.close();
        duplicateReads = 0;
        application = createProductionDisabledApplication({
          persistence: await harness.reopen(),
          usageAdapter: {
            ...usageAdapter(),
            readAuthorizedSnapshot: async () => {
              duplicateReads += 1;
              throw new Error("duplicate-must-not-read");
            },
          },
          clock,
        });
        expect(
          await application.runtime.get(definition().task.idempotencyKey),
        ).toEqual(prepared);
        expect(
          await application.runtime.history(definition().task.idempotencyKey),
        ).toEqual(preparedHistory);
        expect(await application.execute(prepareCommand)).toEqual(prepared);
        expect(duplicateReads).toBe(0);

        await application.close();
        application = createProductionDisabledApplication({
          persistence: await harness.reopen(),
          usageAdapter: usageAdapter(),
          clock,
        });

        const running = await application.execute({
          type: "mark-dispatch-started",
          commandId: "command:application:reopen:start",
          ...fence(prepared),
          dispatchId: prepared.dispatch.dispatchId,
        });
        if (
          running === null ||
          "outcome" in running ||
          running.lease === null ||
          running.dispatch === null
        ) {
          throw new Error("expected running state");
        }
        await application.close();
        application = createProductionDisabledApplication({
          persistence: await harness.reopen(),
          usageAdapter: usageAdapter(),
          clock,
        });
        expect(
          await application.runtime.get(definition().task.idempotencyKey),
        ).toEqual(running);

        clock.set(running.lease.expiresAt);
        const [pending] = await application.tick();
        expect(pending).toMatchObject({
          status: "failed",
          reservation: { status: "reconciliation-required" },
          dispatch: { status: "terminal" },
        });
        if (
          pending === undefined ||
          pending.reservation === null ||
          pending.dispatch === null
        ) {
          throw new Error("expected pending reconciliation evidence");
        }
        const pendingHistory = await application.runtime.history(
          definition().task.idempotencyKey,
        );
        await application.close();
        application = createProductionDisabledApplication({
          persistence: await harness.reopen(),
          usageAdapter: usageAdapter(),
          clock,
        });
        expect(
          await application.runtime.get(definition().task.idempotencyKey),
        ).toEqual(pending);
        expect(
          await application.runtime.history(definition().task.idempotencyKey),
        ).toEqual(pendingHistory);

        const reconcileCommand = {
          type: "reconcile-usage" as const,
          commandId: "command:application:reopen:reconcile",
          idempotencyKey: definition().task.idempotencyKey,
          reservationId: pending.reservation.reservationId,
          dispatchId: pending.dispatch.dispatchId,
          actualUsage: USAGE,
        };
        const reconciled = await application.execute(reconcileCommand);
        expect(reconciled).toMatchObject({
          status: "failed",
          reservation: { status: "reconciled", actualUsage: USAGE },
          cumulativeUsage: USAGE,
          terminal: { actualUsage: USAGE },
        });
        const reconciledHistory = await application.runtime.history(
          definition().task.idempotencyKey,
        );
        await application.close();
        application = createProductionDisabledApplication({
          persistence: await harness.reopen(),
          usageAdapter: usageAdapter(),
          clock,
        });
        expect(
          await application.runtime.get(definition().task.idempotencyKey),
        ).toEqual(reconciled);
        expect(
          await application.runtime.history(definition().task.idempotencyKey),
        ).toEqual(reconciledHistory);
        expect(await application.execute(reconcileCommand)).toEqual(reconciled);
        await expect(
          application.execute({
            ...reconcileCommand,
            actualUsage: { ...USAGE, inputTokens: USAGE.inputTokens + 1 },
          }),
        ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
        expect(
          await application.runtime.history(definition().task.idempotencyKey),
        ).toEqual(reconciledHistory);
        expect(await application.tick()).toEqual([]);
      }, 15_000);

      it("reopens retry-wait cancellation without rewriting prior dispatch terminal evidence", async () => {
        if (harness.reopen === undefined) {
          throw new Error(
            "A reopen-capable application contract harness must provide reopen().",
          );
        }
        const claimed = await createWork(application);
        const reserved = await application.execute({
          type: "reserve-usage",
          commandId: "command:application:retry-cancel:reserve",
          ...fence(claimed),
          circuit: circuit(claimed),
        });
        if (reserved === null || "outcome" in reserved) {
          throw new Error("expected reserved state");
        }
        const prepared = await application.execute({
          type: "prepare-dispatch",
          commandId: "command:application:retry-cancel:prepare",
          ...fence(reserved),
          circuit: circuit(reserved),
        });
        if (
          prepared === null ||
          "outcome" in prepared ||
          prepared.dispatch === null
        ) {
          throw new Error("expected prepared state");
        }
        const waiting = await application.execute({
          type: "fail-work",
          commandId: "command:application:retry-cancel:fail",
          ...fence(prepared),
          dispatchId: prepared.dispatch.dispatchId,
          classification: "provider",
          code: "provider-before-start",
          retryable: true,
          actualUsage: {
            inputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            toolCalls: 0,
            costMicros: 0,
          },
        });
        if (
          waiting === null ||
          "outcome" in waiting ||
          waiting.dispatch === null
        ) {
          throw new Error("expected retry-wait state");
        }
        const firstTerminalAt = waiting.dispatch.terminalAt;
        clock.advance(1);
        const cancelCommand = {
          type: "cancel-work" as const,
          commandId: "command:application:retry-cancel:cancel",
          idempotencyKey: waiting.definition.task.idempotencyKey,
          code: "operator-cancelled",
        };
        const cancelled = await application.execute(cancelCommand);
        if (
          cancelled === null ||
          "outcome" in cancelled ||
          cancelled.dispatch === null
        ) {
          throw new Error("expected cancelled state");
        }
        expect(cancelled).toMatchObject({
          status: "cancelled",
          dispatch: { status: "terminal", terminalAt: firstTerminalAt },
        });
        const history = await application.runtime.history(
          definition().task.idempotencyKey,
        );
        await application.close();
        application = createProductionDisabledApplication({
          persistence: await harness.reopen(),
          usageAdapter: usageAdapter(),
          clock,
        });
        expect(
          await application.runtime.get(definition().task.idempotencyKey),
        ).toEqual(cancelled);
        expect(
          await application.runtime.history(definition().task.idempotencyKey),
        ).toEqual(history);
        expect(await application.execute(cancelCommand)).toEqual(cancelled);
        expect(await application.tick()).toEqual([]);
      });

      it("fails closed when a reopen changes the normalized runtime policy", async () => {
        await createWork(application);
        await application.close();
        if (harness.reopen === undefined) {
          throw new Error(
            "A reopen-capable application contract harness must provide reopen().",
          );
        }
        application = createProductionDisabledApplication({
          persistence: await harness.reopen(),
          usageAdapter: usageAdapter(),
          clock,
          configuration: {
            ...DEFAULT_WORKER_RUNTIME_CONFIGURATION,
            maximumQueueDepth:
              DEFAULT_WORKER_RUNTIME_CONFIGURATION.maximumQueueDepth + 1,
          },
        });
        await expect(
          application.runtime.get(definition().task.idempotencyKey),
        ).rejects.toMatchObject({ code: "STATE_CORRUPTION" });
      });

      it("fails closed when a reopen substitutes the usage adapter identity", async () => {
        await createWork(application);
        await application.close();
        if (harness.reopen === undefined) {
          throw new Error(
            "A reopen-capable application contract harness must provide reopen().",
          );
        }
        application = createProductionDisabledApplication({
          persistence: await harness.reopen(),
          usageAdapter: usageAdapter("adapter:substituted"),
          clock,
        });
        await expect(
          application.runtime.get(definition().task.idempotencyKey),
        ).rejects.toMatchObject({ code: "STATE_CORRUPTION" });
      });
    }
  });
}
