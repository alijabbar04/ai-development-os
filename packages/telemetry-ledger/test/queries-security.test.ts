import { describe, expect, it } from "vitest";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import {
  DEFAULT_TELEMETRY_LEDGER_CONFIGURATION,
  createExactScopeTelemetryAuthorizer,
  createPersistenceTelemetryStore,
  denyAllTelemetryAuthorizer,
  deterministicPartition,
  type TelemetryAuditRecord,
  type TelemetryAuthorizer,
  type TelemetryLedgerConfiguration,
  type TelemetryObservationDraft,
} from "../src/index.js";
import { ACCESS, LATER, makeDraft, NOW, SCOPE, usage } from "./helpers.js";

function createStore(input: { configuration?: TelemetryLedgerConfiguration; audit?: (record: TelemetryAuditRecord) => void | Promise<void>; deny?: boolean; authorizer?: TelemetryAuthorizer } = {}) {
  return createPersistenceTelemetryStore({
    ledgerId: "ledger-1",
    adapter: createMemoryPersistenceAdapter({ clock: { now: () => new Date(NOW) } }),
    configuration: input.configuration ?? DEFAULT_TELEMETRY_LEDGER_CONFIGURATION,
    clock: { now: () => new Date(NOW) },
    authorizer: input.authorizer ?? (input.deny ? denyAllTelemetryAuthorizer : createExactScopeTelemetryAuthorizer()),
    audit: input.audit ?? (() => {}),
  });
}

describe("authorization, audit, queries, and export", () => {
  it("denies by default and fails closed when the audit sink fails", async () => {
    const records: TelemetryAuditRecord[] = [];
    const denied = createStore({ deny: true, audit: (record) => { records.push(record); } });
    expect(await denied.ingestTelemetryObservation(makeDraft("provider-health", { state: "healthy", latencyMs: null }, { operationId: null }), ACCESS)).toMatchObject({ outcome: "rejected", code: "access-denied" });
    await expect(denied.queryObservations({ access: { ...ACCESS, purpose: "history" }, from: "2026-01-01T00:00:00.000Z", to: "2026-01-03T00:00:00.000Z" })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(denied.verifyTelemetryLedger({ ...ACCESS, purpose: "verify" })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(records.map((record) => [record.action, record.outcome])).toEqual([["write", "denied"], ["read", "denied"], ["verify", "denied"]]);
    await denied.close();
    const auditFailure = createStore({ audit: () => { throw new Error("armed audit failure"); } });
    expect(await auditFailure.ingestTelemetryObservation(makeDraft("provider-health", { state: "healthy", latencyMs: null }, { operationId: null }), ACCESS)).toMatchObject({ outcome: "rejected", code: "audit-failure" });
    await auditFailure.close();
  });

  it("emits bounded content-free audit metadata", async () => {
    const records: TelemetryAuditRecord[] = [];
    const store = createStore({ audit: (record) => { records.push(record); } });
    await store.ingestTelemetryObservation(makeDraft("provider-health", { state: "healthy", latencyMs: 1 }, { operationId: null }), ACCESS);
    await store.queryObservations({ access: { ...ACCESS, purpose: "history" }, from: "2026-01-01T00:00:00.000Z", to: "2026-01-03T00:00:00.000Z" });
    expect(records).toHaveLength(2);
    expect(JSON.stringify(records)).not.toMatch(/operation-1|provider-1|workspace-1/u);
    expect(records[0]).toMatchObject({ action: "write", outcome: "allowed", providerInstanceScoped: true });
    await store.close();
  });

  it("hides cross-user and cross-organization observations before disclosure", async () => {
    const store = createStore();
    await store.ingestTelemetryObservation(makeDraft("provider-health", { state: "healthy", latencyMs: 1 }, { operationId: null }), ACCESS);
    const attacker = { ...ACCESS, subjectId: "user-2", organizationId: "org-2", projectId: "project-2", workspaceId: "workspace-2", purpose: "history" as const };
    const page = await store.queryObservations({ access: attacker, from: "2026-01-01T00:00:00.000Z", to: "2026-01-03T00:00:00.000Z" });
    expect(page.items).toEqual([]);
    await store.close();
  });

  it("filters a row denied by the per-observation authorizer and audits the denial", async () => {
    const records: TelemetryAuditRecord[] = [];
    const store = createStore({
      audit: (record) => { records.push(record); },
      authorizer: { authorize: (request) => request.action === "write" || request.providerInstanceId === "scope-query" },
    });
    await store.ingestTelemetryObservation(makeDraft("provider-health", { state: "healthy", latencyMs: 1 }, { operationId: null }), ACCESS);
    const page = await store.queryObservations({ access: { ...ACCESS, purpose: "history" }, from: "2026-01-01T00:00:00.000Z", to: "2026-01-03T00:00:00.000Z" });
    expect(page.items).toEqual([]);
    expect(page.truncated).toBe(true);
    expect(records).toContainEqual(expect.objectContaining({ action: "read", outcome: "denied", detailCode: "observation-read-denied" }));
    await store.close();
  });

  it("returns bounded summaries, current capacity, forecasts, operation evidence, and redacted snapshots", async () => {
    const store = createStore();
    await store.ingestTelemetryObservation(makeDraft("operation-estimate", { usage: usage(10), reservationId: "reservation-1" }, { observationId: "estimate" }), ACCESS);
    await store.ingestTelemetryObservation(makeDraft("cumulative-usage", { usage: usage(5), sequence: 1, quality: "complete" }, { observationId: "actual", observedAt: LATER }), ACCESS);
    await store.ingestTelemetryObservation(makeDraft("cost", { components: [{ componentId: "bill", semanticClass: "provider-billed", currency: "USD", amountMicros: 10, authority: "billing", priceSourceFingerprint: null, priceEffectiveAt: null }] }, { observationId: "cost", observedAt: LATER }), ACCESS);
    await store.ingestTelemetryObservation(makeDraft("quota-window", { state: "limited", dimension: "requests", window: "fixed", providerWindowId: "window", remaining: 10, limit: 100, usedBasisPoints: null, remainingBasisPoints: null, durationMs: 3_600_000 }, { observationId: "quota-1", operationId: null, observedAt: "2026-01-02T03:03:05.000Z", resetsAt: "2026-01-02T06:00:00.000Z", staleAt: "2026-01-03T00:00:00.000Z" }), ACCESS);
    await store.ingestTelemetryObservation(makeDraft("quota-window", { state: "limited", dimension: "requests", window: "fixed", providerWindowId: "window", remaining: 5, limit: 100, usedBasisPoints: null, remainingBasisPoints: null, durationMs: 3_600_000 }, { observationId: "quota-2", operationId: null, observedAt: NOW, resetsAt: "2026-01-02T06:00:00.000Z", staleAt: "2026-01-03T00:00:00.000Z" }), ACCESS);
    const query = { access: { ...ACCESS, purpose: "usage" as const }, from: "2026-01-01T00:00:00.000Z", to: "2026-01-03T00:00:00.000Z" };
    expect(await store.queryUsageSummary(query)).toMatchObject({ operationCount: 1, actual: { uncachedInputTokens: 5 } });
    expect(await store.queryCostSummary({ ...query, access: { ...query.access, purpose: "cost" } })).toMatchObject({ completeness: "complete", subtotals: [{ amountMicros: 10 }] });
    expect(await store.reconcileOperationTelemetry({ ...query, access: { ...query.access, purpose: "operations" }, operationId: "operation-1" })).toMatchObject({ actual: { uncachedInputTokens: 5 } });
    expect(await store.queryCapacitySnapshot({ ...query, access: { ...query.access, purpose: "capacity" } })).toMatchObject({ observations: [expect.objectContaining({ observationId: "quota-2" })] });
    expect((await store.forecastCapacity({ ...query, access: { ...query.access, purpose: "capacity" } })).status).toBe("available");
    const snapshot = await store.exportSnapshot({ ...query, access: { ...query.access, purpose: "export" } });
    expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(snapshot)).not.toMatch(/prompt|response|header|sk-live|session-cookie|toolArguments/iu);
    await store.close();
  });

  it("reads complete summaries across store pages and enforces partition bounds", async () => {
    const limited = { ...DEFAULT_TELEMETRY_LEDGER_CONFIGURATION, queryPageSize: 1, maximumPartitionCount: 1 };
    const store = createStore({ configuration: limited });
    await store.ingestTelemetryObservation(makeDraft("cumulative-usage", { usage: usage(1), sequence: 1, quality: "complete" }, { observationId: "one" }), ACCESS);
    await store.ingestTelemetryObservation(makeDraft("cost", { components: [{ componentId: "bill", semanticClass: "provider-billed", currency: "USD", amountMicros: 1, authority: "billing", priceSourceFingerprint: null, priceEffectiveAt: null }] }, { observationId: "two" }), ACCESS);
    const query = { access: { ...ACCESS, purpose: "usage" as const }, from: "2026-01-01T00:00:00.000Z", to: "2026-01-03T00:00:00.000Z" };
    expect((await store.queryUsageSummary({ ...query, limit: 1 })).completeness).toBe("complete");
    const tomorrow = makeDraft("provider-health", { state: "healthy", latencyMs: null }, { observationId: "tomorrow", operationId: null, observedAt: "2026-01-03T03:00:00.000Z" });
    expect(await store.ingestTelemetryObservation(tomorrow, ACCESS)).toMatchObject({ outcome: "rejected", code: "partition-count-limit" });
    await store.close();
  });

  it("scans past non-matching event pages and keeps distinct provider windows", async () => {
    const store = createStore({ configuration: { ...DEFAULT_TELEMETRY_LEDGER_CONFIGURATION, queryPageSize: 1 } });
    await store.ingestTelemetryObservation(makeDraft("provider-health", { state: "healthy", latencyMs: 1 }, { observationId: "outside", operationId: null, observedAt: NOW }), ACCESS);
    await store.ingestTelemetryObservation(makeDraft("cumulative-usage", { usage: usage(7), sequence: 1, quality: "complete" }, { observationId: "inside", observedAt: LATER }), ACCESS);
    for (const [id, providerWindowId] of [["window-a", "route-a"], ["window-b", "route-b"]] as const) {
      await store.ingestTelemetryObservation(makeDraft("quota-window", { state: "limited", dimension: "requests", window: "provider-defined", providerWindowId, remaining: 2, limit: 10, usedBasisPoints: null, remainingBasisPoints: null, durationMs: 60_000 }, { observationId: id, operationId: null, observedAt: LATER } ), ACCESS);
    }
    const interval = { from: LATER, to: "2026-01-03T00:00:00.000Z" };
    const page = await store.queryObservations({ access: { ...ACCESS, purpose: "history" }, ...interval, operationId: "operation-1", limit: 1 });
    expect(page.items.map((item) => item.observationId)).toEqual(["inside"]);
    expect(await store.queryUsageSummary({ access: { ...ACCESS, purpose: "usage" }, ...interval })).toMatchObject({ operationCount: 1, actual: { uncachedInputTokens: 7 } });
    const capacity = await store.queryCapacitySnapshot({ access: { ...ACCESS, purpose: "capacity" }, ...interval });
    expect(capacity.observations.map((item) => item.kind === "quota-window" ? item.data.providerWindowId : null).sort()).toEqual(["route-a", "route-b"]);
    await store.close();
  });

  it("reports operations with only non-usage facts as unknown instead of throwing", async () => {
    const store = createStore();
    await store.ingestTelemetryObservation(makeDraft("quota-window", { state: "exhausted", dimension: "requests", window: "fixed", providerWindowId: "request-limit", remaining: 0, limit: 10, usedBasisPoints: null, remainingBasisPoints: null, durationMs: 60_000 }, { observationId: "operation-rate-limit" }), ACCESS);
    expect(await store.queryUsageSummary({ access: { ...ACCESS, purpose: "usage" }, from: "2026-01-01T00:00:00.000Z", to: "2026-01-03T00:00:00.000Z" })).toMatchObject({ operationCount: 1, missingOperationCount: 1, completeness: "unknown" });
    await store.close();
  });

  it("accepts cross-partition corrections, ignores an out-of-window target, and rejects correction chains", async () => {
    const store = createStore();
    const original = makeDraft("cost", { components: [{ componentId: "bill", semanticClass: "provider-billed", currency: "USD", amountMicros: 4, authority: "billing", priceSourceFingerprint: null, priceEffectiveAt: null }] }, { observationId: "original-cost", operationId: null, observedAt: NOW });
    const correction = makeDraft("correction", { action: "tombstone", targetObservationId: "original-cost", reasonCode: "provider-correction" }, { observationId: "cost-correction", operationId: null, observedAt: "2026-01-03T03:04:05.000Z", correctedObservationId: "original-cost" });
    expect((await store.ingestTelemetryObservation(original, ACCESS)).outcome).toBe("accepted");
    expect((await store.ingestTelemetryObservation(correction, ACCESS)).outcome).toBe("accepted");
    const laterOnly = await store.queryCostSummary({ access: { ...ACCESS, purpose: "cost" }, from: "2026-01-03T00:00:00.000Z", to: "2026-01-04T00:00:00.000Z" });
    expect(laterOnly).toMatchObject({ completeness: "unknown", subtotals: [] });
    const targetInterval = await store.queryCostSummary({ access: { ...ACCESS, purpose: "cost" }, from: "2026-01-01T00:00:00.000Z", to: "2026-01-03T00:00:00.000Z" });
    expect(targetInterval).toMatchObject({ completeness: "unknown", subtotals: [] });
    const rawHistory = await store.queryObservations({ access: { ...ACCESS, purpose: "history" }, from: "2026-01-01T00:00:00.000Z", to: "2026-01-03T00:00:00.000Z" });
    expect(rawHistory.items.map((item) => item.observationId)).toEqual(["original-cost"]);
    const entire = await store.queryCostSummary({ access: { ...ACCESS, purpose: "cost" }, from: "2026-01-01T00:00:00.000Z", to: "2026-01-04T00:00:00.000Z" });
    expect(entire).toMatchObject({ completeness: "unknown", subtotals: [] });
    const chained = makeDraft("correction", { action: "tombstone", targetObservationId: "cost-correction", reasonCode: "invalid-chain" }, { observationId: "chained-correction", operationId: null, observedAt: "2026-01-03T04:04:05.000Z", correctedObservationId: "cost-correction" });
    expect(await store.ingestTelemetryObservation(chained, ACCESS)).toMatchObject({ outcome: "conflict", code: "correction-target-missing" });
    expect(await store.verifyTelemetryLedger({ ...ACCESS, purpose: "verify" })).toMatchObject({ ok: true, eventCount: 2 });
    await store.close();
  });

  it("selects one comparable percentage signal for public capacity forecasts", async () => {
    const store = createStore();
    for (const [windowId, first, second] of [["claude-five", 8_000, 7_000], ["claude-seven", 9_000, 8_500]] as const) {
      await store.ingestTelemetryObservation(makeDraft("quota-window", { state: "limited", dimension: "usage-percentage", window: windowId === "claude-five" ? "five-hour" : "seven-day", providerWindowId: windowId, remaining: null, limit: null, usedBasisPoints: 10_000 - first, remainingBasisPoints: first, durationMs: windowId === "claude-five" ? 18_000_000 : 604_800_000 }, { observationId: `${windowId}-one`, operationId: null, observedAt: "2026-01-02T03:02:05.000Z", resetsAt: "2026-01-03T00:00:00.000Z", staleAt: "2026-01-03T00:00:00.000Z" }), ACCESS);
      await store.ingestTelemetryObservation(makeDraft("quota-window", { state: "limited", dimension: "usage-percentage", window: windowId === "claude-five" ? "five-hour" : "seven-day", providerWindowId: windowId, remaining: null, limit: null, usedBasisPoints: 10_000 - second, remainingBasisPoints: second, durationMs: windowId === "claude-five" ? 18_000_000 : 604_800_000 }, { observationId: `${windowId}-two`, operationId: null, observedAt: "2026-01-02T03:03:05.000Z", resetsAt: "2026-01-03T00:00:00.000Z", staleAt: "2026-01-03T00:00:00.000Z" }), ACCESS);
    }
    const forecast = await store.forecastCapacity({ access: { ...ACCESS, purpose: "capacity" }, from: "2026-01-01T00:00:00.000Z", to: "2026-01-03T00:00:00.000Z", dimension: "usage-percentage", window: "five-hour", providerWindowId: "claude-five" });
    expect(forecast).toMatchObject({ status: "available", dimension: "usage-percentage", window: "five-hour", providerWindowId: "claude-five", sampleCount: 2 });
    await store.close();
  });

  it("binds reads, verification, exports, and authorization to one logical ledger", async () => {
    const adapter = createMemoryPersistenceAdapter({ clock: { now: () => new Date(NOW) } });
    const authorizedLedgerIds: string[] = [];
    const authorizer: TelemetryAuthorizer = { authorize: (request) => { authorizedLedgerIds.push(request.ledgerId); return true; } };
    const first = createPersistenceTelemetryStore({ ledgerId: "ledger-1", adapter, configuration: DEFAULT_TELEMETRY_LEDGER_CONFIGURATION, clock: { now: () => new Date(NOW) }, authorizer, audit: () => {} });
    const second = createPersistenceTelemetryStore({ ledgerId: "ledger-2", adapter, configuration: DEFAULT_TELEMETRY_LEDGER_CONFIGURATION, clock: { now: () => new Date(NOW) }, authorizer, audit: () => {} });
    const shared = makeDraft("provider-health", { state: "healthy", latencyMs: 1 }, { observationId: "shared-id", idempotencyKey: "shared-key", operationId: null });
    expect((await first.ingestTelemetryObservation(shared, ACCESS)).outcome).toBe("accepted");
    expect((await second.ingestTelemetryObservation({ ...shared, ledgerId: "ledger-2" }, ACCESS)).outcome).toBe("accepted");
    expect(await first.ingestTelemetryObservation({ ...shared, ledgerId: "ledger-2", observationId: "wrong-ledger", idempotencyKey: "wrong-ledger" }, ACCESS)).toMatchObject({ outcome: "conflict", code: "ledger-id-mismatch" });
    const query = { access: { ...ACCESS, purpose: "history" as const }, from: "2026-01-01T00:00:00.000Z", to: "2026-01-03T00:00:00.000Z" };
    expect((await first.queryObservations(query)).items.map((item) => item.ledgerId)).toEqual(["ledger-1"]);
    expect((await second.queryObservations(query)).items.map((item) => item.ledgerId)).toEqual(["ledger-2"]);
    expect(await first.verifyTelemetryLedger({ ...ACCESS, purpose: "verify" })).toMatchObject({ ok: true, partitionCount: 1, eventCount: 1 });
    expect((await second.exportSnapshot({ ...query, access: { ...query.access, purpose: "export" } })).ledgerId).toBe("ledger-2");
    expect(new Set(authorizedLedgerIds)).toEqual(new Set(["ledger-1", "ledger-2"]));
    await second.close();
    await first.close();
  });

  it("runtime-validates exact canonical query intervals and bounds", async () => {
    const store = createStore();
    const base = { access: { ...ACCESS, purpose: "history" as const }, from: "2026-01-01T00:00:00.000Z", to: "2026-01-03T00:00:00.000Z" };
    await expect(store.queryObservations({ ...base, from: "2026-01-01T00:00:00Z" })).rejects.toThrow();
    await expect(store.queryObservations({ ...base, from: base.to })).rejects.toMatchObject({ code: "INVALID_OBSERVATION" });
    await expect(store.queryObservations({ ...base, limit: 101 })).rejects.toThrow();
    await expect(store.queryObservations({ ...base, secret: "armed" } as typeof base)).rejects.toThrow(/unexpected fields/u);
    await store.close();
  });

  it("enforces configured bridge, currency, semantic, and per-partition bounds", async () => {
    const disabled = createStore({ configuration: { ...DEFAULT_TELEMETRY_LEDGER_CONFIGURATION, enabledBridges: [] } });
    expect(await disabled.ingestTelemetryObservation(makeDraft("provider-health", { state: "healthy", latencyMs: null }, { operationId: null }), ACCESS)).toMatchObject({ outcome: "rejected", code: "provider-bridge-disabled" });
    await disabled.close();
    const bounded = createStore({ configuration: { ...DEFAULT_TELEMETRY_LEDGER_CONFIGURATION, maximumObservationsPerPartition: 1, maximumIdempotencyRecordsPerPartition: 1, acceptedCurrencies: ["EUR"] } });
    const first = await bounded.ingestTelemetryObservation(makeDraft("provider-health", { state: "healthy", latencyMs: null }, { observationId: "first", operationId: null }), ACCESS);
    expect(first.observation?.staleAt).toBe("2026-01-02T03:05:05.000Z");
    expect(await bounded.ingestTelemetryObservation(makeDraft("provider-health", { state: "healthy", latencyMs: null }, { observationId: "second", operationId: null }), ACCESS)).toMatchObject({ outcome: "rejected", code: "partition-observation-limit" });
    await bounded.close();
    const currency = createStore({ configuration: { ...DEFAULT_TELEMETRY_LEDGER_CONFIGURATION, acceptedCurrencies: ["EUR"] } });
    const usd = makeDraft("cost", { components: [{ componentId: "usd", semanticClass: "provider-billed", currency: "USD", amountMicros: 1, authority: "billing", priceSourceFingerprint: null, priceEffectiveAt: null }] });
    expect(await currency.ingestTelemetryObservation(usd, ACCESS)).toMatchObject({ outcome: "rejected", code: "cost-class-not-configured" });
    await currency.close();
  });

  it("rejects unknown newer checkpoint schemas instead of downgrading", async () => {
    const adapter = createMemoryPersistenceAdapter({ clock: { now: () => new Date(NOW) } });
    const store = createPersistenceTelemetryStore({ ledgerId: "ledger-1", adapter, configuration: DEFAULT_TELEMETRY_LEDGER_CONFIGURATION, clock: { now: () => new Date(NOW) }, authorizer: createExactScopeTelemetryAuthorizer(), audit: () => {} });
    const first = makeDraft("provider-health", { state: "healthy", latencyMs: null }, { observationId: "one", operationId: null });
    await store.ingestTelemetryObservation(first, ACCESS);
    const partition = deterministicPartition(first.ledgerId, first.observedAt, DEFAULT_TELEMETRY_LEDGER_CONFIGURATION.partitionDurationMs);
    await adapter.transact(async (tx) => { const envelope = await tx.aggregates.get("telemetry-ledger", partition.partitionId); if (envelope === null) throw new Error("positive control"); await tx.aggregates.update({ aggregateType: "telemetry-ledger", aggregateId: partition.partitionId, expectedVersion: envelope.aggregateVersion, schemaVersion: 2, payload: { schemaVersion: 2, algorithmVersion: 1 }, traceId: null }); });
    expect(await store.ingestTelemetryObservation(makeDraft("provider-health", { state: "healthy", latencyMs: null }, { observationId: "two", operationId: null }), ACCESS)).toMatchObject({ outcome: "rejected", code: "checkpoint-schema-unsupported" });
    await store.close();
  });

  it("never reflects hostile payload canaries through result, error, audit, or fingerprint surfaces", async () => {
    const canaries = ["PROMPT_CANARY", "RESPONSE_CANARY", "TOOL_ARGUMENT_CANARY", "C:\\secret\\file", "sk-live-secret", "session-cookie=secret"];
    expect(canaries.join("|")).toContain("PROMPT_CANARY");
    const records: TelemetryAuditRecord[] = [];
    const store = createStore({ audit: (record) => { records.push(record); } });
    for (const canary of canaries) {
      const hostile = { ...makeDraft("provider-health", { state: "healthy", latencyMs: null }, { operationId: null }), prompt: canary } as unknown as TelemetryObservationDraft;
      const result = await store.ingestTelemetryObservation(hostile, ACCESS);
      expect(JSON.stringify({ result, records })).not.toContain(canary);
      expect(result.outcome).toBe("rejected");
    }
    await store.close();
  });
});
