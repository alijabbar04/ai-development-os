import { runSecretBrokerContractSuite } from "@ai-dev-os/secrets/testing";
import { createMemorySecretBroker } from "../src/index.js";
import type { SecretAccessContext, SecretAuditRecord, SecretRef } from "@ai-dev-os/secrets";

const named = (name: string, kind: "text" | "bytes" = "text", version: string | null = "v1"): SecretRef => ({ schemaVersion: 1, type: "named", namespace: "test", name, version, expectedKind: kind, providerInstanceId: "provider-test" });

runSecretBrokerContractSuite(() => {
  const sourceBytes = new Uint8Array([1, 2, 3, 4]);
  const audits: SecretAuditRecord[] = [];
  const zeroRecords: Array<{ reason: string; byteLength: number; allZero: boolean }> = [];
  const broker = createMemorySecretBroker({ clock: { now: () => new Date("2026-08-02T00:00:00.000Z") }, audit: (record) => audits.push(record), onZero: (record) => zeroRecords.push(record), entries: [
    { ref: named("text"), material: { kind: "text", text: "test-secret-value" } },
    { ref: named("empty"), material: { kind: "text", text: "" } },
    { ref: named("bytes", "bytes"), material: { kind: "bytes", bytes: sourceBytes } },
    { ref: named("denied"), material: { kind: "text", text: "denied-value" }, access: "denied" },
  ] });
  const context: SecretAccessContext = { operationId: "operation-test", providerInstanceId: "provider-test", purpose: "provider-authentication", requestedLifetimeMs: 1_000, accessForm: "text", classification: "internal", projectId: "project-test", taskId: "task-test", approvalEvidenceRefs: [], disclosureDecisionFingerprint: null, locality: "local", trace: { traceId: "trace-test", runId: "run-test", taskId: "task-test", taskRunId: "attempt-test" }, deadline: null };
  return { broker, textRef: named("text"), emptyTextRef: named("empty"), bytesRef: named("bytes", "bytes"), deniedRef: named("denied"), missingRef: named("missing"), context, audits, zeroRecords, sourceBytes };
});
