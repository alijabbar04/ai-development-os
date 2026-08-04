import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryPersistenceAdapter, type MemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import { createSqlitePersistenceAdapter } from "@ai-dev-os/persistence-sqlite";
import {
  DEFAULT_TELEMETRY_LEDGER_CONFIGURATION,
  createExactScopeTelemetryAuthorizer,
  createPersistenceTelemetryStore,
  deterministicPartition,
  type TelemetryLedger,
} from "../src/index.js";
import { runTelemetryPersistenceContract } from "../src/testing/contract-suite.js";
import { ACCESS, LATER, makeDraft, NOW, usage } from "./helpers.js";

runTelemetryPersistenceContract("memory", { createAdapter: () => createMemoryPersistenceAdapter({ clock: { now: () => new Date(NOW) } }) });
runTelemetryPersistenceContract("sqlite", { createAdapter: () => createSqlitePersistenceAdapter({ memory: true, clock: { now: () => new Date(NOW) } }) });

const temporaryDirectories: string[] = [];
afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined && directory.startsWith(tmpdir())) await rm(directory, { recursive: true, force: true });
  }
});

function ledger(adapter: ReturnType<typeof createMemoryPersistenceAdapter>): TelemetryLedger {
  return createPersistenceTelemetryStore({ ledgerId: "ledger-1", adapter, configuration: DEFAULT_TELEMETRY_LEDGER_CONFIGURATION, clock: { now: () => new Date(NOW) }, authorizer: createExactScopeTelemetryAuthorizer(), audit: () => {} });
}

describe("telemetry persistence recovery and concurrency", () => {
  it("recovers a malformed checkpoint from the append-only event journal", async () => {
    const adapter = createMemoryPersistenceAdapter({ clock: { now: () => new Date(NOW) } });
    const store = ledger(adapter);
    const first = makeDraft("cumulative-usage", { usage: usage(2), sequence: 1, quality: "partial" }, { observationId: "one" });
    expect((await store.ingestTelemetryObservation(first, ACCESS)).outcome).toBe("accepted");
    const partition = deterministicPartition(first.ledgerId, first.observedAt, DEFAULT_TELEMETRY_LEDGER_CONFIGURATION.partitionDurationMs);
    await adapter.transact(async (tx) => {
      const envelope = await tx.aggregates.get("telemetry-ledger", partition.partitionId);
      if (envelope === null) throw new Error("positive control: checkpoint must exist");
      await tx.aggregates.update({ aggregateType: "telemetry-ledger", aggregateId: partition.partitionId, schemaVersion: 1, expectedVersion: envelope.aggregateVersion, payload: { schemaVersion: 1, algorithmVersion: 1, malformed: true }, traceId: null });
    });
    const second = makeDraft("cumulative-usage", { usage: usage(3), sequence: 2, quality: "complete" }, { observationId: "two", observedAt: LATER });
    expect((await store.ingestTelemetryObservation(second, ACCESS)).outcome).toBe("accepted");
    expect(await store.verifyTelemetryLedger({ ...ACCESS, purpose: "verify" })).toMatchObject({ ok: true, eventCount: 2 });
    await store.close();
  });

  it("refuses a checksum-corrupt checkpoint rather than silently trusting it", async () => {
    const adapter: MemoryPersistenceAdapter = createMemoryPersistenceAdapter({ clock: { now: () => new Date(NOW) } });
    const store = ledger(adapter);
    const first = makeDraft("provider-health", { state: "healthy", latencyMs: 1 }, { observationId: "health", operationId: null });
    await store.ingestTelemetryObservation(first, ACCESS);
    const partition = deterministicPartition(first.ledgerId, first.observedAt, DEFAULT_TELEMETRY_LEDGER_CONFIGURATION.partitionDurationMs);
    adapter.corruptAggregatePayload("telemetry-ledger", partition.partitionId);
    const result = await store.ingestTelemetryObservation(makeDraft("provider-health", { state: "degraded", latencyMs: 2 }, { observationId: "health-2", operationId: null }), ACCESS);
    expect(result).toMatchObject({ outcome: "rejected", code: "persistence-failure" });
    await store.close();
  });

  it("rejects reuse of a ledger idempotency key across partitions", async () => {
    const adapter = createMemoryPersistenceAdapter({ clock: { now: () => new Date(NOW) } });
    const store = ledger(adapter);
    const first = makeDraft("provider-health", { state: "healthy", latencyMs: 1 }, { observationId: "day-one", idempotencyKey: "stable-key", operationId: null, observedAt: NOW });
    const second = makeDraft("provider-health", { state: "healthy", latencyMs: 1 }, { observationId: "day-two", idempotencyKey: "stable-key", operationId: null, observedAt: "2026-01-03T03:04:05.000Z" });
    expect((await store.ingestTelemetryObservation(first, ACCESS)).outcome).toBe("accepted");
    expect(await store.ingestTelemetryObservation(second, ACCESS)).toMatchObject({ outcome: "conflict", code: "idempotency-conflict" });
    await store.close();
  });

  it("serializes concurrent writes without losing events", async () => {
    const adapter = createMemoryPersistenceAdapter({ clock: { now: () => new Date(NOW) } });
    const store = ledger(adapter);
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => store.ingestTelemetryObservation(makeDraft("provider-health", { state: "healthy", latencyMs: index }, { observationId: `health-${index}`, idempotencyKey: `idem-health-${index}`, operationId: null, source: { category: "provider-reported", sourceObservationId: `health-source-${index}` } }), ACCESS)));
    expect(results.every((item) => item.outcome === "accepted")).toBe(true);
    expect(await store.verifyTelemetryLedger({ ...ACCESS, purpose: "verify" })).toMatchObject({ ok: true, eventCount: 12 });
    await store.close();
  });

  it("fails an authorized-but-not-yet-persisted write conservatively when close wins the race", async () => {
    const adapter = createMemoryPersistenceAdapter({ clock: { now: () => new Date(NOW) } });
    let releaseAuthorization!: () => void;
    let authorizationStarted!: () => void;
    const release = new Promise<void>((resolve) => { releaseAuthorization = resolve; });
    const started = new Promise<void>((resolve) => { authorizationStarted = resolve; });
    const store = createPersistenceTelemetryStore({
      ledgerId: "ledger-1", adapter, configuration: DEFAULT_TELEMETRY_LEDGER_CONFIGURATION,
      clock: { now: () => new Date(NOW) }, audit: () => {},
      authorizer: { authorize: async (request) => { if (request.action === "write") { authorizationStarted(); await release; } return true; } },
    });
    const ingestion = store.ingestTelemetryObservation(makeDraft("provider-health", { state: "healthy", latencyMs: 1 }, { observationId: "in-flight", operationId: null }), ACCESS);
    await started;
    await store.close();
    releaseAuthorization();
    expect(await ingestion).toMatchObject({ outcome: "rejected", code: "persistence-failure" });
    await expect(store.queryObservations({ access: { ...ACCESS, purpose: "history" }, from: "2026-01-01T00:00:00.000Z", to: "2026-01-03T00:00:00.000Z" })).rejects.toMatchObject({ code: "STORE_CLOSED" });
  });

  it("reopens a disposable SQLite database and reproduces the same event state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-dev-os-telemetry-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "ledger.sqlite");
    const firstAdapter = createSqlitePersistenceAdapter({ file, journalMode: "delete", clock: { now: () => new Date(NOW) } });
    const firstLedger = createPersistenceTelemetryStore({ ledgerId: "ledger-1", adapter: firstAdapter, configuration: DEFAULT_TELEMETRY_LEDGER_CONFIGURATION, clock: { now: () => new Date(NOW) }, authorizer: createExactScopeTelemetryAuthorizer(), audit: () => {} });
    await firstLedger.ingestTelemetryObservation(makeDraft("provider-health", { state: "healthy", latencyMs: 1 }, { observationId: "persisted", operationId: null }), ACCESS);
    await firstLedger.close();
    const reopened = createPersistenceTelemetryStore({ ledgerId: "ledger-1", adapter: createSqlitePersistenceAdapter({ file, journalMode: "delete", clock: { now: () => new Date(LATER) } }), configuration: DEFAULT_TELEMETRY_LEDGER_CONFIGURATION, clock: { now: () => new Date(LATER) }, authorizer: createExactScopeTelemetryAuthorizer(), audit: () => {} });
    const page = await reopened.queryObservations({ access: { ...ACCESS, purpose: "history" }, from: "2026-01-01T00:00:00.000Z", to: "2026-01-03T00:00:00.000Z" });
    expect(page.items.map((item) => item.observationId)).toEqual(["persisted"]);
    expect(await reopened.verifyTelemetryLedger({ ...ACCESS, purpose: "verify" })).toMatchObject({ ok: true, eventCount: 1 });
    await reopened.close();
  });
});
