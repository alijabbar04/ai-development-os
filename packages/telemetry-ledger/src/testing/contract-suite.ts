import { describe, expect, it } from "vitest";
import type { PersistenceAdapter } from "@ai-dev-os/persistence";
import { DEFAULT_TELEMETRY_LEDGER_CONFIGURATION } from "../config.js";
import { createExactScopeTelemetryAuthorizer } from "../authorization.js";
import { createPersistenceTelemetryStore } from "../ledger.js";
import { telemetrySnapshotFingerprint } from "../fingerprint.js";
import type { TelemetryAccessContext, TelemetryObservationDraft } from "../types.js";

export interface TelemetryPersistenceContractHarness {
  readonly createAdapter: () => PersistenceAdapter | Promise<PersistenceAdapter>;
}

const NOW = "2026-01-02T03:04:05.000Z";
const LATER = "2026-01-02T03:04:06.000Z";
const scope = Object.freeze({ organizationId: "org-1", userId: "user-1", projectId: "project-1", workspaceId: "workspace-1", taskId: "task-1", runId: "run-1" });
const access: TelemetryAccessContext = Object.freeze({ subjectId: "user-1", organizationId: "org-1", projectId: "project-1", workspaceId: "workspace-1", purpose: "ingest", classification: "internal" });
const identity = Object.freeze({ providerKind: "inference" as const, providerId: "provider-1", configuredInstanceId: "instance-1", contractModelId: "model-1", upstreamModelId: "model-1", adapterPackage: "@ai-dev-os/providers", adapterProfile: "default", adapterVersion: "0.1.0", catalogFingerprint: null, providerFingerprint: null, modelFingerprint: null, authenticationClass: "api-key" as const, billingClass: "metered" as const });

function usage(inputTokens: number) {
  return Object.freeze({ uncachedInputTokens: inputTokens, cacheWriteInputTokens: 0, cachedReadInputTokens: 0, visibleOutputTokens: 1, reasoningTokens: 0, unknownCombinedTokens: 0, toolCalls: 0, categoryCompleteness: "exact" as const });
}

function draft(id: string, sequence: number, inputTokens: number, observedAt = NOW): TelemetryObservationDraft {
  const sourceFingerprint = telemetrySnapshotFingerprint({ id, sequence, inputTokens });
  return Object.freeze({
    ledgerId: "ledger-1", observationId: id, idempotencyKey: `idem-${id}`, scope, traceId: "trace-1", operationId: "operation-1", parentOperationId: null, identity,
    source: { category: "provider-reported", sourceObservationId: `source-${id}` }, observedAt, effectiveFrom: null, effectiveUntil: null, resetsAt: null,
    staleAt: null, terminalAt: null, confidence: "reported", provenance: { sourceFingerprint, pricingSource: null, pricingEffectiveAt: null, derivation: null, sampleObservationIds: [] },
    previousObservationId: null, correctedObservationId: null, detailCodes: [], kind: "cumulative-usage", data: { usage: usage(inputTokens), sequence, quality: "partial" },
  } as TelemetryObservationDraft);
}

export function runTelemetryPersistenceContract(name: string, harness: TelemetryPersistenceContractHarness): void {
  describe(`${name} telemetry persistence contract`, () => {
    it("atomically persists an event and checkpoint and replays deterministically", async () => {
      const adapter = await harness.createAdapter();
      const ledger = createPersistenceTelemetryStore({ ledgerId: "ledger-1", adapter, configuration: DEFAULT_TELEMETRY_LEDGER_CONFIGURATION, clock: { now: () => new Date(NOW) }, authorizer: createExactScopeTelemetryAuthorizer(), audit: () => {} });
      expect((await ledger.ingestTelemetryObservation(draft("obs-1", 1, 2), access)).outcome).toBe("accepted");
      expect((await ledger.ingestTelemetryObservation(draft("obs-2", 2, 3, LATER), access)).outcome).toBe("accepted");
      const verification = await ledger.verifyTelemetryLedger({ ...access, purpose: "verify" });
      expect(verification).toMatchObject({ ok: true, partitionCount: 1, eventCount: 2 });
      await ledger.close();
    });

    it("makes identical replay idempotent and rejects same id with different content", async () => {
      const adapter = await harness.createAdapter();
      let receiptTime = Date.parse(NOW);
      const ledger = createPersistenceTelemetryStore({ ledgerId: "ledger-1", adapter, configuration: DEFAULT_TELEMETRY_LEDGER_CONFIGURATION, clock: { now: () => new Date(receiptTime += 1_000) }, authorizer: createExactScopeTelemetryAuthorizer(), audit: () => {} });
      const first = draft("obs-1", 1, 2);
      const accepted = await ledger.ingestTelemetryObservation(first, access);
      expect(accepted.outcome).toBe("accepted");
      const duplicate = await ledger.ingestTelemetryObservation(first, access);
      expect(duplicate.outcome).toBe("duplicate");
      expect(duplicate.observation?.ingestedAt).toBe(accepted.observation?.ingestedAt);
      const conflict = { ...first, data: { usage: usage(9), sequence: 1, quality: "partial" as const } } as TelemetryObservationDraft;
      expect((await ledger.ingestTelemetryObservation(conflict, access)).outcome).toBe("conflict");
      await ledger.close();
    });

    it("paginates stable event order and refuses use after close", async () => {
      const adapter = await harness.createAdapter();
      const ledger = createPersistenceTelemetryStore({ ledgerId: "ledger-1", adapter, configuration: { ...DEFAULT_TELEMETRY_LEDGER_CONFIGURATION, queryPageSize: 1 }, clock: { now: () => new Date(NOW) }, authorizer: createExactScopeTelemetryAuthorizer(), audit: () => {} });
      await ledger.ingestTelemetryObservation(draft("obs-1", 1, 2), access);
      await ledger.ingestTelemetryObservation(draft("obs-2", 2, 3, LATER), access);
      const first = await ledger.queryObservations({ access: { ...access, purpose: "history" }, from: NOW, to: "2026-01-03T00:00:00.000Z" });
      expect(first.items.map((item) => item.observationId)).toEqual(["obs-1"]);
      expect(first.nextCursor).not.toBeNull();
      const second = await ledger.queryObservations({ access: { ...access, purpose: "history" }, from: NOW, to: "2026-01-03T00:00:00.000Z", cursor: first.nextCursor });
      expect(second.items.map((item) => item.observationId)).toEqual(["obs-2"]);
      await ledger.close();
      await expect(ledger.queryObservations({ access: { ...access, purpose: "history" }, from: NOW, to: LATER })).rejects.toMatchObject({ code: "STORE_CLOSED" });
    });
  });
}
