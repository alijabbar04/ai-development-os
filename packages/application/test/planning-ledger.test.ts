import { expect, it } from "vitest";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import type { AggregateEnvelope, TransactionContext } from "@ai-dev-os/persistence";
import { computeChecksumOfText } from "@ai-dev-os/persistence";
import { canonicalPlanning, digestPlanning } from "../src/planning-validation.js";
import { listPlanningAggregates, listPlanningEvents, observePlanningReceipt, parsePlanningConfirmation, planningTransactionAdapter, recordPlanningIntent, recordPlanningReceipt, verifyPlanningEnvelope } from "../src/planning-ledger.js";
import { parsePlanningMetadata, readPlanningMetadata } from "../src/planning-metadata.js";

const at = "2026-09-07T19:00:00.000Z", commandId = "ledger:owned", inputDigest = digestPlanning({ kind: "stop-project", commandId, projectId: "prj:owned", expectedProjectVersion: 1 });
it.each([
  { schemaVersion: 2 }, { aggregateVersion: 0 }, { createdAt: "invalid-time" }, { updatedAt: "2020-01-01T00:00:00.000Z" }, { checksum: computeChecksumOfText("wrong") },
])("detects intrinsically corrupt aggregate envelopes %#", async (damage) => {
  const store = createMemoryPersistenceAdapter({ clock: { now: () => new Date(at) } });
  await store.transact(async (tx) => { const record = await tx.aggregates.create({ aggregateType: "project", aggregateId: "prj:owned", schemaVersion: 1, payload: { marker: "owned" } }); expect(() => verifyPlanningEnvelope({ ...record, ...damage })).toThrow(); });
  await store.close();
});
it("requires a complete ordered bounded store scan, refusing cursor cycles, duplicate rows and broken journal checksums", async () => {
  const store = createMemoryPersistenceAdapter();
  await store.transact(async (base) => {
    const row = await base.aggregates.create({ aggregateType: "project", aggregateId: "prj:owned", schemaVersion: 1, payload: null });
    const event = await base.events.append({ eventId: "event:owned", aggregateType: "project", aggregateId: "prj:owned", aggregateVersion: 1, eventType: "project.created", eventSchemaVersion: 1, payload: null, occurredAt: at });
    for (const page of [{ items: [], nextCursor: "cycle" }, { items: [row, row], nextCursor: null }, { items: Array(101).fill(row), nextCursor: null }]) {
      const tx = { ...base, aggregates: { ...base.aggregates, list: async () => page } } as TransactionContext;
      await expect(listPlanningAggregates(tx, "project")).rejects.toMatchObject({ kind: "corrupt" });
    }
    await expect(listPlanningAggregates(base, "project", 0)).rejects.toMatchObject({ reason: "store.evidence-bound" });
    for (const page of [{ items: [], nextCursor: "cycle" }, { items: [{ ...event, checksum: computeChecksumOfText("wrong") }], nextCursor: null }, { items: [event, event], nextCursor: null }]) {
      const tx = { ...base, events: { ...base.events, list: async () => page } } as TransactionContext;
      await expect(listPlanningEvents(tx, "project", "prj:owned")).rejects.toMatchObject({ kind: "corrupt" });
    }
    const facade = planningTransactionAdapter(base);
    await expect(facade.migrationStatus()).rejects.toThrow("TRANSACTION_FACADE_OPERATION_UNAVAILABLE");
    await expect(facade.close()).rejects.toThrow("TRANSACTION_FACADE_OPERATION_UNAVAILABLE");
  }); await store.close();
});
it("requires intent and result journals before replay and checks intrinsic evidence before mismatched caller material", async () => {
  const store = createMemoryPersistenceAdapter();
  await store.transact(async (tx) => {
    await recordPlanningIntent(tx, { commandId, commandKind: "stop-project", inputDigest, projectId: "prj:owned", at });
    expect(await observePlanningReceipt(tx, commandId, inputDigest, true)).toBeNull();
    await expect(observePlanningReceipt(tx, commandId, "a".repeat(64))).rejects.toMatchObject({ kind: "conflict" });
    const missing = { ...tx, events: { ...tx.events, list: async () => ({ items: [], nextCursor: null }) } };
    await expect(observePlanningReceipt(missing, commandId, "a".repeat(64))).rejects.toMatchObject({ kind: "corrupt" });
    await recordPlanningReceipt(tx, { schemaVersion: 1, commandId, commandKind: "stop-project", inputDigest, at, confirmation: null, material: null, effects: [], result: { commandId, kind: "cancelled", projectId: "prj:owned", reason: "operator.cancelled" } });
    expect((await observePlanningReceipt(tx, commandId))?.result.kind).toBe("cancelled");
    await expect(observePlanningReceipt(missing, commandId)).rejects.toMatchObject({ kind: "corrupt" });
    const changed = { ...tx, aggregates: { ...tx.aggregates, get: async (...args: Parameters<typeof tx.aggregates.get>) => { const row = await tx.aggregates.get(...args); return row === null ? null : { ...row, payload: { ...(row.payload as object), commandId: "different:identity" }, checksum: computeChecksumOfText(canonicalPlanning({ ...(row.payload as object), commandId: "different:identity" })) }; } } };
    await expect(observePlanningReceipt(changed, commandId, "a".repeat(64))).rejects.toMatchObject({ kind: "corrupt" });
  }); await store.close();
});
it("refuses malformed operator proof and persisted metadata without treating them as renderer mismatch", async () => {
  const confirmation = { reviewId: "review:owned", identityRef: "operator:local-desktop", approverClass: "project-owner", confirmedAt: at, subjectDigest: "a".repeat(64) };
  for (const bad of [{ ...confirmation, approverClass: "provider" }, { ...confirmation, subjectDigest: "bad" }, { ...confirmation, confirmedAt: "yesterday" }]) expect(() => parsePlanningConfirmation(bad)).toThrow();
  const metadata = { schemaVersion: 1, kind: "project-planning-metadata", projectId: "prj:owned", repository: null, plan: null };
  expect(parsePlanningMetadata(metadata)).toEqual(metadata);
  for (const damage of [{ schemaVersion: 2 }, { plan: { planId: "pln:owned", requiresScope: "yes", originCommandId: commandId, scopeApprovalId: null } }, { repository: { schemaVersion: 1, canonicalRoot: "C:/owned", grant: "renderer", observedAt: at, report: {} } }]) expect(() => parsePlanningMetadata({ ...metadata, ...damage })).toThrow();
  const store = createMemoryPersistenceAdapter();
  await store.transact(async (tx) => {
    await expect(readPlanningMetadata(tx, "prj:owned")).rejects.toMatchObject({ reason: "project.metadata-unavailable" });
    await tx.aggregates.create({ aggregateType: "planning-workspace", aggregateId: "project-metadata:prj:owned", schemaVersion: 1, payload: { ...metadata, projectId: "prj:other" } });
    await expect(readPlanningMetadata(tx, "prj:owned")).rejects.toMatchObject({ kind: "corrupt" });
  }); await store.close();
});
