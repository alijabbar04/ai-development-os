import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import { createSqlitePersistenceAdapter } from "@ai-dev-os/persistence-sqlite";
import type { EventRecord, TransactionContext } from "@ai-dev-os/persistence";
import {
  EvaluationError,
  cancelEvaluationRun,
  completeEvaluationRun,
  createEvaluationRun,
  createProductionDisabledEvaluationService,
  failEvaluationAttempt,
  parseEvaluationEvent,
  parseEvaluationRunSnapshot,
  replayEvaluationEvents,
} from "../src/index.js";
import { evaluationStoreTesting } from "../src/store.js";
import { DEADLINE, T0, T1, authorityConfiguration, requestInput } from "./fixtures.js";

describe("evaluation aggregate and durable service", () => {
  it("replays exact accepted/completed events and refuses tampering", () => {
    const accepted = createEvaluationRun(requestInput(), authorityConfiguration);
    const completed = completeEvaluationRun(accepted.snapshot, 1, T1);
    expect(completed.snapshot.status).toBe("completed");
    expect(completed.snapshot.attemptsUsed).toBe(1);
    expect(replayEvaluationEvents([accepted.event, completed.event])).toEqual(completed.snapshot);
    expect(parseEvaluationEvent(completed.event)).toEqual(completed.event);
    expect(parseEvaluationRunSnapshot(completed.snapshot)).toEqual(completed.snapshot);
    expect(() => parseEvaluationRunSnapshot({ ...accepted.snapshot, attemptsUsed: 2 })).toThrow(EvaluationError);
    expect(() => parseEvaluationRunSnapshot({ ...accepted.snapshot, attemptsUsed: 1 })).toThrow(EvaluationError);
    expect(() => parseEvaluationRunSnapshot({
      ...accepted.snapshot,
      aggregateVersion: 100,
      eventSequence: 100,
    })).toThrow(EvaluationError);
    expect(() => parseEvaluationRunSnapshot({ ...completed.snapshot, attemptsUsed: 0 })).toThrow(EvaluationError);
    expect(() => parseEvaluationRunSnapshot({
      ...completed.snapshot,
      updatedAt: "2026-08-11T03:41:01.000Z",
    })).toThrow(EvaluationError);
    expect(() => replayEvaluationEvents([{ ...accepted.event, eventId: "event:tampered" }])).toThrow(EvaluationError);
    expect(() => replayEvaluationEvents([completed.event, accepted.event])).toThrow(EvaluationError);
    expect(() => replayEvaluationEvents(new Array(1))).toThrow(EvaluationError);
    const customJournal: unknown[] = [accepted.event];
    Object.defineProperty(customJournal, "extra", { value: true, enumerable: true });
    expect(() => replayEvaluationEvents(customJournal)).toThrow(EvaluationError);
  });

  it("bounds retries, terminalizes nonretryable failures, cancellation, and deadlines", () => {
    const accepted = createEvaluationRun(requestInput(), authorityConfiguration);
    const retry = failEvaluationAttempt(accepted.snapshot, 1, "evaluator-crash", true, T1);
    expect(retry.snapshot.status).toBe("pending");
    expect(retry.snapshot.attemptsUsed).toBe(1);
    const exhausted = failEvaluationAttempt(retry.snapshot, 2, "evaluator-crash", true, "2026-08-11T03:42:00.000Z");
    expect(exhausted.snapshot.status).toBe("failed");
    const nonretryable = failEvaluationAttempt(accepted.snapshot, 1, "invalid-evidence", false, T1);
    expect(nonretryable.snapshot.status).toBe("failed");
    const cancelled = cancelEvaluationRun(accepted.snapshot, 1, "operator-cancelled", T1);
    expect(cancelled.snapshot.status).toBe("cancelled");
    expect(() => parseEvaluationRunSnapshot({
      ...cancelled.snapshot,
      aggregateVersion: 4,
      eventSequence: 4,
      attemptsUsed: 2,
    })).toThrow(EvaluationError);
    const expired = completeEvaluationRun(accepted.snapshot, 1, "2026-08-11T05:20:00.001Z");
    expect(expired.snapshot.status).toBe("expired");
    expect(expired.snapshot.lastFailureCode).toBe("deadline-expired");
    expect(() => completeEvaluationRun(completedSnapshot(accepted), 2, T1)).toThrow(EvaluationError);
    expect(() => cancelEvaluationRun(accepted.snapshot, 2, "cancelled", T1)).toThrow(EvaluationError);
    expect(() => failEvaluationAttempt(accepted.snapshot, 1, "Bad Code", true, T1)).toThrow();
  });

  it("persists exact history, idempotent commands, conflicts, and finite audit records", async () => {
    const persistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
    const audit: unknown[] = [];
    const service = createProductionDisabledEvaluationService({
      persistence,
      authorityConfiguration,
      audit: (record) => audit.push(record),
    });
    expect(service.productionEnabled).toBe(false);
    const first = await service.accept(requestInput());
    expect(await service.accept(requestInput())).toEqual(first);
    await expect(service.accept(requestInput({ criteria: [
      { ...(requestInput()["criteria"] as readonly Record<string, unknown>[])[0]!, description: "Different immutable input." },
    ], evidence: [] }))).rejects.toMatchObject({ code: "CONFLICT" });
    const completed = await service.evaluate(first.runId, 1, T1);
    expect(completed.status).toBe("completed");
    expect(await service.evaluate(first.runId, 1, T1)).toEqual(completed);
    expect(await service.get(first.runId)).toEqual(completed);
    expect(await service.history(first.runId)).toHaveLength(2);
    expect(service.completenessAudit(completed.result).resultDigest).toBe(completed.result?.resultDigest);
    const mismatchedAuthorityService = createProductionDisabledEvaluationService({ persistence });
    await expect(mismatchedAuthorityService.get(first.runId)).rejects.toMatchObject({
      code: "PERSISTENCE_MISMATCH",
    });
    const rotatedAuthorityService = createProductionDisabledEvaluationService({
      persistence,
      trustedAuthorityConfigurationFingerprints: [
        authorityConfiguration.configurationFingerprint,
      ],
    });
    await expect(rotatedAuthorityService.get(first.runId)).resolves.toEqual(completed);
    await expect(service.get("missing:run")).resolves.toBeNull();
    await expect(service.history("missing:run")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.cancel(first.runId, 2, "cancelled", DEADLINE)).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "accept", outcome: "succeeded" }),
      expect.objectContaining({ operation: "accept", outcome: "duplicate" }),
      expect.objectContaining({ operation: "evaluate", outcome: "succeeded" }),
      expect.objectContaining({ operation: "evaluate", outcome: "duplicate" }),
    ]));
    await persistence.close();
  });

  it("persists retry/cancel state and detects checkpoint corruption", async () => {
    const persistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } });
    const service = createProductionDisabledEvaluationService({ persistence, authorityConfiguration });
    const accepted = await service.accept(requestInput({ runId: "evaluation:retry" }));
    const retried = await service.failAttempt(accepted.runId, 1, "temporary-failure", true, T1);
    expect(retried.status).toBe("pending");
    expect(await service.failAttempt(accepted.runId, 1, "temporary-failure", true, T1)).toEqual(retried);
    const cancelled = await service.cancel(accepted.runId, 2, "operator-cancelled", "2026-08-11T03:42:00.000Z");
    expect(cancelled.status).toBe("cancelled");
    expect(await service.history(accepted.runId)).toHaveLength(3);
    persistence.corruptAggregatePayload("evaluation-run", accepted.runId);
    await expect(service.get(accepted.runId)).rejects.toThrow();
    await persistence.close();
  });

  it("physically closes and reopens exact SQLite checkpoint and journal state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-dev-os-evaluation-"));
    const file = join(directory, "evaluation.sqlite");
    try {
      const firstPersistence = createSqlitePersistenceAdapter({ file, journalMode: "delete" });
      const first = createProductionDisabledEvaluationService({
        persistence: firstPersistence,
        authorityConfiguration,
      });
      const accepted = await first.accept(requestInput({ runId: "evaluation:sqlite" }));
      const retried = await first.failAttempt(accepted.runId, 1, "temporary-failure", true, T1);
      const before = await first.history(accepted.runId);
      await firstPersistence.close();

      const secondPersistence = createSqlitePersistenceAdapter({ file, journalMode: "delete" });
      const second = createProductionDisabledEvaluationService({
        persistence: secondPersistence,
        authorityConfiguration,
      });
      expect(await second.get(accepted.runId)).toEqual(retried);
      expect(await second.history(accepted.runId)).toEqual(before);
      const completed = await second.evaluate(accepted.runId, 2, "2026-08-11T03:42:00.000Z");
      expect(completed.status).toBe("completed");
      expect(await second.evaluate(accepted.runId, 2, "2026-08-11T03:42:00.000Z")).toEqual(completed);
      await secondPersistence.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("stops malformed or oversized durable pagination before unbounded replay", async () => {
    const emptyContinuation = {
      events: {
        list: async () => ({ items: [], nextCursor: "cursor:stuck" }),
      },
    } as unknown as TransactionContext;
    await expect(evaluationStoreTesting.listEvents(emptyContinuation, "evaluation:bounded"))
      .rejects.toMatchObject({ code: "PERSISTENCE_MISMATCH" });

    let page = 0;
    const oversized = {
      events: {
        list: async ({ limit }: { readonly limit: number }) => {
          page += 1;
          return {
            items: Array.from({ length: limit }, () => ({} as EventRecord)),
            nextCursor: `cursor:${page}`,
          };
        },
      },
    } as unknown as TransactionContext;
    await expect(evaluationStoreTesting.listEvents(oversized, "evaluation:bounded"))
      .rejects.toMatchObject({ code: "PERSISTENCE_MISMATCH" });
    expect(page).toBe(1);
  });
});

function completedSnapshot(accepted: ReturnType<typeof createEvaluationRun>) {
  return completeEvaluationRun(accepted.snapshot, 1, T1).snapshot;
}
