import { describe, expect, it } from "vitest";
import { createMemorySecretBroker } from "../src/index.js";

const ref = { schemaVersion: 1 as const, type: "named" as const, namespace: "test", name: "secret", version: null, expectedKind: "text" as const, providerInstanceId: null };
const context = { operationId: "operation", providerInstanceId: null, purpose: "tool-authentication" as const, requestedLifetimeMs: 1_000, accessForm: "text" as const, classification: "internal" as const, projectId: null, taskId: null, approvalEvidenceRefs: [], disclosureDecisionFingerprint: null, locality: "local" as const, trace: { traceId: "trace", runId: null, taskId: null, taskRunId: null }, deadline: null };

describe("memory broker specifics", () => {
  it("rejects duplicate seeds, kind mismatches, malformed replacements, and audit failures safely", async () => {
    expect(() => createMemorySecretBroker({ clock: { now: () => new Date(0) }, entries: [{ ref, material: { kind: "text", text: "a" } }, { ref, material: { kind: "text", text: "b" } }] })).toThrowError(expect.objectContaining({ code: "MALFORMED_BACKEND_RESPONSE" }));
    expect(() => createMemorySecretBroker({ clock: { now: () => new Date(0) }, entries: [{ ref: { ...ref, expectedKind: "bytes" }, material: { kind: "text", text: "a" } }] })).toThrowError(expect.objectContaining({ code: "KIND_MISMATCH" }));
    const broker = createMemorySecretBroker({ clock: { now: () => new Date("2026-08-02T00:00:00.000Z") }, entries: [{ ref, material: { kind: "text", text: "a" } }] });
    await expect(broker.replace(ref, { kind: "text", bytes: new Uint8Array([1]) }, context)).rejects.toMatchObject({ code: "MALFORMED_BACKEND_RESPONSE" });
    await broker.close();
    const audited = createMemorySecretBroker({ clock: { now: () => new Date("2026-08-02T00:00:00.000Z") }, audit: () => { throw new Error("audit-secret"); }, entries: [{ ref, material: { kind: "text", text: "a" } }] });
    await expect(audited.availability(ref, context)).rejects.toMatchObject({ code: "AUDIT_FAILURE", causeCategory: "Error" });
  });
  it("waits for an active callback before close completes", async () => {
    const broker = createMemorySecretBroker({ clock: { now: () => new Date("2026-08-02T00:00:00.000Z") }, entries: [{ ref, material: { kind: "text", text: "a" } }] });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let closeDone = false;
    const active = broker.withSecret(ref, context, async () => { await gate; return "done"; }); await Promise.resolve(); const closing = broker.close().then(() => { closeDone = true; }); await Promise.resolve(); expect(closeDone).toBe(false); release(); expect(await active).toBe("done"); await closing; expect(closeDone).toBe(true); expect(broker.operationCounts.close).toBe(1);
  });
  it("audits a failed revocation outcome without exposing backend state", async () => {
    const records: unknown[] = [];
    const broker = createMemorySecretBroker({ clock: { now: () => new Date("2026-08-02T00:00:00.000Z") }, audit: (record) => records.push(record) });
    await expect(broker.revoke(ref, context)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ operation: "revoke", phase: "attempt", outcome: null }), expect.objectContaining({ operation: "revoke", phase: "outcome", outcome: "not-found" })]));
    await broker.close();
  });
});
