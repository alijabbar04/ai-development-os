import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import { createSqlitePersistenceAdapter } from "@ai-dev-os/persistence-sqlite";
import type { PersistenceAdapter, TransactionContext } from "@ai-dev-os/persistence";
import { describe, expect, it } from "vitest";
import {
  ProductPlan,
  createProductPlanningStore,
  type ProductPlanningStore,
} from "../src/index.js";
import {
  ManualPlanningClock,
  candidate,
  configuration,
  draft,
  evidence,
  intent,
} from "./fixtures.js";

async function stageFirst(
  store: ProductPlanningStore,
  snapshot: Awaited<ReturnType<ProductPlanningStore["accept"]>>,
  clock: ManualPlanningClock,
  config = configuration(),
) {
  const plan = ProductPlan.hydrate(snapshot, config, { clock });
  const phase = snapshot.phases[0]!;
  return store.stageContribution(
    snapshot.planId,
    evidence(plan, phase.phaseId, clock),
    draft([candidate("core", "Core capability")]),
  );
}

describe("Product-planning persistence", () => {
  it("atomically accepts aggregate, planning event, and exact task-graph events", async () => {
    const clock = new ManualPlanningClock();
    const adapter = createMemoryPersistenceAdapter({ clock });
    const config = configuration();
    const store = createProductPlanningStore({ persistence: adapter, configuration: config, clock });
    const accepted = await store.accept({ intent: intent() });
    expect(await store.get(accepted.planId)).toEqual(accepted);
    const history = await store.history(accepted.planId);
    expect(history).toHaveLength(1);
    expect(history[0]?.type).toBe("plan.accepted");
    const records = await adapter.transact(async (tx) => {
      const page = await tx.events.list({ aggregateType: "product-plan", aggregateId: accepted.planId, limit: 100 });
      return page.items;
    });
    expect(records.filter((record) => record.eventType === "planning.event")).toHaveLength(1);
    expect(records.filter((record) => record.eventType === "planning.graph-event")).toHaveLength(accepted.taskGraph.eventSequence);
    expect(new Set(records.map((record) => record.aggregateVersion))).toEqual(new Set([1]));
    expect(await store.accept({ intent: intent() })).toEqual(accepted);
    const afterDuplicate = await adapter.transact((tx) => tx.aggregates.get("product-plan", accepted.planId));
    expect(afterDuplicate?.aggregateVersion).toBe(1);
    await expect(store.accept({ intent: { ...intent(), title: "Conflicting immutable title" } })).rejects.toMatchObject({ code: "CONFLICT" });
    await adapter.close();
  });

  it("persists stage-before-apply checkpoints and makes duplicate delivery write-free", async () => {
    const clock = new ManualPlanningClock();
    const adapter = createMemoryPersistenceAdapter({ clock });
    const config = configuration();
    const audits: string[] = [];
    const store = createProductPlanningStore({
      persistence: adapter,
      configuration: config,
      clock,
      audit: (record) => audits.push(`${record.operation}:${record.outcome}`),
    });
    const accepted = await store.accept({ intent: intent() });
    const staged = await stageFirst(store, accepted, clock, config);
    expect(staged.stagedContributions).toHaveLength(1);
    expect(staged.contributions).toHaveLength(0);
    expect(staged.phases[0]?.status).toBe("running");
    const envelopeBeforeDuplicate = await adapter.transact((tx) => tx.aggregates.get("product-plan", accepted.planId));
    const duplicate = await stageFirst(store, accepted, clock, config);
    const envelopeAfterDuplicate = await adapter.transact((tx) => tx.aggregates.get("product-plan", accepted.planId));
    expect(duplicate).toEqual(staged);
    expect(envelopeAfterDuplicate?.aggregateVersion).toBe(envelopeBeforeDuplicate?.aggregateVersion);
    expect(audits).toContain("stage-contribution:duplicate");
    const applied = await store.applyStagedContribution(
      accepted.planId,
      staged.stagedContributions[0]!.contributionId,
      staged.aggregateVersion,
    );
    expect(applied.contributions).toHaveLength(1);
    expect(applied.requirements).toHaveLength(1);
    expect((await store.get(accepted.planId))).toEqual(applied);
    await adapter.close();
  });

  it("replays a failed phase followed by cancellation of remaining parallel work", async () => {
    const clock = new ManualPlanningClock();
    const adapter = createMemoryPersistenceAdapter({ clock });
    const config = configuration({ specialists: 2 });
    const store = createProductPlanningStore({ persistence: adapter, configuration: config, clock });
    const accepted = await store.accept({ intent: intent() });
    const staged = await stageFirst(store, accepted, clock, config);
    const discoveryApplied = await store.applyStagedContribution(
      accepted.planId,
      staged.stagedContributions[0]!.contributionId,
      staged.aggregateVersion,
    );
    const specialist = discoveryApplied.phases.find((phase) => phase.kind === "specialist-gap-analysis")!;
    const failed = await store.failPhase(accepted.planId, specialist.phaseId, "provider-failed", discoveryApplied.aggregateVersion);
    const cancelled = await store.cancel(accepted.planId, "cancel remaining bounded work", failed.aggregateVersion);
    expect(cancelled.phases.some((phase) => phase.status === "failed")).toBe(true);
    expect(cancelled.phases.some((phase) => phase.status === "cancelled")).toBe(true);
    expect(await store.get(accepted.planId)).toEqual(cancelled);
    expect((await store.history(accepted.planId)).at(-1)?.type).toBe("plan.cancelled");
    await adapter.close();
  });

  it("binds aggregate envelope identity, schema, version, and trace to journal replay", async () => {
    const clock = new ManualPlanningClock();
    const inner = createMemoryPersistenceAdapter({ clock });
    const config = configuration({ specialists: 0 });
    const original = createProductPlanningStore({ persistence: inner, configuration: config, clock });
    await original.accept({ intent: intent({ risk: "routine" }) });
    for (const patch of [
      { aggregateType: "other" },
      { aggregateId: "plan:other" },
      { schemaVersion: 2 },
      { aggregateVersion: 99 },
      { traceId: "trace:forged" },
    ]) {
      const wrapped: PersistenceAdapter = Object.freeze({
        migrationStatus: () => inner.migrationStatus(),
        close: async () => undefined,
        transact<T>(work: (tx: TransactionContext) => Promise<T> | T): Promise<T> {
          return inner.transact((tx) => work(Object.freeze({
            ...tx,
            aggregates: Object.freeze({
              ...tx.aggregates,
              get: async (...args: Parameters<typeof tx.aggregates.get>) => {
                const value = await tx.aggregates.get(...args);
                return value === null ? null : { ...value, ...patch } as typeof value;
              },
            }),
          })));
        },
      });
      const store = createProductPlanningStore({ persistence: wrapped, configuration: config, clock });
      await expect(store.get("plan:test")).rejects.toMatchObject({ code: "PERSISTENCE_MISMATCH" });
    }
    await inner.close();
  });

  it("rolls back aggregate and journal together when an event append fails", async () => {
    const clock = new ManualPlanningClock();
    const inner = createMemoryPersistenceAdapter({ clock });
    let appendCount = 0;
    const failing: PersistenceAdapter = Object.freeze({
      migrationStatus: () => inner.migrationStatus(),
      close: () => inner.close(),
      transact<T>(work: (tx: TransactionContext) => Promise<T> | T): Promise<T> {
        return inner.transact((tx) => work(Object.freeze({
          ...tx,
          events: Object.freeze({
            ...tx.events,
            append: async (input: Parameters<typeof tx.events.append>[0]) => {
              appendCount += 1;
              if (appendCount === 2) throw new Error("injected-event-failure");
              return tx.events.append(input);
            },
          }),
        })));
      },
    });
    const store = createProductPlanningStore({ persistence: failing, configuration: configuration(), clock });
    await expect(store.accept({ intent: intent() })).rejects.toThrow("injected-event-failure");
    const residue = await inner.transact(async (tx) => ({
      aggregate: await tx.aggregates.get("product-plan", "plan:test"),
      events: (await tx.events.list({ aggregateType: "product-plan", aggregateId: "plan:test" })).items,
    }));
    expect(residue).toEqual({ aggregate: null, events: [] });
    await inner.close();
  });

  it("reopens SQLite with the same checkpoint and exact journal replay", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ai-dev-os-planning-"));
    const file = join(directory, "planning.db");
    const clock = new ManualPlanningClock();
    const config = configuration();
    try {
      const firstAdapter = createSqlitePersistenceAdapter({ file, clock });
      const firstStore = createProductPlanningStore({ persistence: firstAdapter, configuration: config, clock });
      const accepted = await firstStore.accept({ intent: intent() });
      const staged = await stageFirst(firstStore, accepted, clock, config);
      await firstAdapter.close();

      const reopenedAdapter = createSqlitePersistenceAdapter({ file, clock });
      const reopenedStore = createProductPlanningStore({ persistence: reopenedAdapter, configuration: config, clock });
      expect(await reopenedStore.get(accepted.planId)).toEqual(staged);
      expect((await reopenedStore.history(accepted.planId)).map((event) => event.type)).toEqual([
        "plan.accepted",
        "contribution.staged",
      ]);
      await reopenedAdapter.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on corrupted aggregate or event material", async () => {
    const clock = new ManualPlanningClock();
    const aggregateAdapter = createMemoryPersistenceAdapter({ clock });
    const store = createProductPlanningStore({ persistence: aggregateAdapter, configuration: configuration(), clock });
    await store.accept({ intent: intent() });
    aggregateAdapter.corruptAggregatePayload("product-plan", "plan:test");
    await expect(store.get("plan:test")).rejects.toMatchObject({ code: "CORRUPTION_DETECTED" });
    await aggregateAdapter.close();

    const eventAdapter = createMemoryPersistenceAdapter({ clock });
    const eventStore = createProductPlanningStore({ persistence: eventAdapter, configuration: configuration(), clock });
    await eventStore.accept({ intent: intent() });
    const eventId = await eventAdapter.transact(async (tx) => (await tx.events.list({ aggregateType: "product-plan", aggregateId: "plan:test" })).items[0]!.eventId);
    eventAdapter.corruptEventPayload(eventId);
    await expect(eventStore.get("plan:test")).rejects.toMatchObject({ code: "CORRUPTION_DETECTED" });
    await eventAdapter.close();
  });
});
