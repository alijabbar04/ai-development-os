import { defaultDataHandlingPolicy, toCanonicalJson } from "@ai-dev-os/domain";
import { inspect } from "node:util";
import {
  SecretBrokerError,
  createPolicyAwareSecretResolver,
  parseSecretAccessContext,
  secretRefFingerprint,
  type SecretAccessContext,
  type SecretAuditRecord,
} from "@ai-dev-os/secrets";
import { describe, expect, it } from "vitest";
import {
  AppVaultError,
  appVaultReferenceForSlot,
  createAppVaultManager,
  createAppVaultSecretBroker,
} from "../src/index.js";
import { appVaultContainerBinding } from "../src/target.js";
import { parseVaultDocument } from "../src/document.js";
import {
  createDeterministicAppVaultCryptoPort,
  createDeterministicAppVaultRandomPort,
  createAppVaultManagerForTesting,
  createAppVaultSecretBrokerForTesting,
  createMemoryAppVaultStoragePort,
  type AppVaultMemoryFaultStage,
} from "../src/testing/index.js";

const IDENTITY = Object.freeze({ name: "AI Development OS", appDataPath: "C:\\Users\\Operator\\AppData\\Roaming" });
const SECRET = "SYNTHETIC-APP-VAULT-CREDENTIAL-7F4A1E";

class Clock {
  value = Date.parse("2026-08-19T09:00:00.000Z");
  now(): Date { return new Date(this.value); }
  tick(milliseconds = 1_000): void { this.value += milliseconds; }
}

function accessContext(slotId: "anthropic" | "openai" | "gemini" | "openrouter" = "anthropic", overrides: Record<string, unknown> = {}): SecretAccessContext {
  const providerInstanceId = `${slotId}-default`;
  return parseSecretAccessContext({
    operationId: `operation-${slotId}`,
    providerInstanceId,
    purpose: "provider-authentication",
    requestedLifetimeMs: 30_000,
    accessForm: "text",
    classification: "internal",
    projectId: null,
    taskId: null,
    approvalEvidenceRefs: [],
    disclosureDecisionFingerprint: null,
    locality: "local",
    trace: { traceId: `trace-${slotId}`, runId: null, taskId: null, taskRunId: null },
    deadline: null,
    signal: undefined,
    ...overrides,
  });
}

function fixture(options: {
  available?: boolean | (() => boolean);
  shouldReEncrypt?: boolean | (() => boolean);
  failEncrypt?: boolean;
  failDecrypt?: boolean | (() => boolean);
  audit?: (record: SecretAuditRecord) => void;
  storage?: ReturnType<typeof createMemoryAppVaultStoragePort>;
  clock?: Clock;
} = {}) {
  const clock = options.clock ?? new Clock();
  const storage = options.storage ?? createMemoryAppVaultStoragePort();
  const crypto = createDeterministicAppVaultCryptoPort({
    ...(options.available === undefined ? {} : { available: options.available }),
    ...(options.shouldReEncrypt === undefined ? {} : { shouldReEncrypt: options.shouldReEncrypt }),
    ...(options.failEncrypt === undefined ? {} : { failEncrypt: options.failEncrypt }),
    ...(options.failDecrypt === undefined ? {} : { failDecrypt: options.failDecrypt }),
  });
  const common = {
    schemaVersion: 1 as const,
    appIdentity: IDENTITY,
    clock,
    crypto,
    storage: storage.port,
    random: createDeterministicAppVaultRandomPort(),
    ...(options.audit === undefined ? {} : { audit: options.audit }),
  };
  return {
    clock,
    storage,
    crypto,
    common,
    manager: createAppVaultManager(common),
    broker: createAppVaultSecretBroker({ ...common, reference: appVaultReferenceForSlot("anthropic") }),
  };
}

function policyRequest(context: SecretAccessContext) {
  const ref = appVaultReferenceForSlot("anthropic");
  return {
    schemaVersion: 1,
    action: "secret-access",
    classification: "internal",
    handlingPolicy: defaultDataHandlingPolicy("internal"),
    risk: "low",
    locality: "local",
    provider: null,
    model: null,
    scope: {
      projectId: null,
      taskId: null,
      providerInstanceId: "anthropic-default",
      workspaceId: null,
      operationId: context.operationId,
      traceId: context.trace.traceId,
    },
    subjectDigest: secretRefFingerprint(ref),
    requestedCapabilities: [],
    transformationsApplied: [],
    approvalEvidence: [],
    retentionDays: null,
    trace: context.trace,
    requesterKind: "user",
  };
}

describe("app-vault manager and broker contract", () => {
  it("projects its finite capability and binding metadata and available state", async () => {
    let available = true;
    const f = fixture({ available: () => available });
    expect(f.broker.describeCapabilities()).toEqual({ resolve: true, availability: true, replace: true, revoke: true, versions: false, kinds: ["text"] });
    expect(f.broker.describeContainerBinding()).toMatchObject({ schemaVersion: 1, containerId: "app-vault.v1", backendKind: "deterministic-fake", digest: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(inspect(f.broker)).toBe("[AppVaultSecretBroker]");
    await f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    expect(await f.broker.availability(appVaultReferenceForSlot("anthropic"), accessContext())).toMatchObject({ available: true, reason: "available" });
    available = false;
    expect(await f.broker.availability(appVaultReferenceForSlot("anthropic"), accessContext())).toMatchObject({ available: false, reason: "unavailable" });
  });

  it("creates, rotates, revokes and re-enters through the broker-only mutation path", async () => {
    const f = fixture();
    expect(await f.manager.describeSlots()).toEqual([
      expect.objectContaining({ slotId: "anthropic", state: "absent" }),
      expect.objectContaining({ slotId: "openai", state: "absent" }),
      expect.objectContaining({ slotId: "gemini", state: "absent" }),
      expect.objectContaining({ slotId: "openrouter", state: "absent" }),
    ]);
    const created = await f.manager.create({ slotId: "anthropic", secret: `  ${SECRET}  `, expectRevision: null });
    expect(created).toMatchObject({ slotId: "anthropic", state: "present", generation: 1, rotatedAt: null });
    f.clock.tick();
    await expect(f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: 1 })).rejects.toMatchObject({ code: "INVALID_REFERENCE", details: { vaultCode: "SLOT_OCCUPIED" } });
    const rotated = await f.manager.rotate({ slotId: "anthropic", secret: `${SECRET}-ROTATED`, expectRevision: 1 });
    expect(rotated).toMatchObject({ state: "present", generation: 2, createdAt: created.createdAt, rotatedAt: "2026-08-19T09:00:01.000Z" });
    f.clock.tick();
    const removed = await f.manager.remove({ slotId: "anthropic", expectRevision: 2 });
    expect(removed).toMatchObject({ state: "revoked", generation: 2, revokedAt: "2026-08-19T09:00:02.000Z" });
    f.clock.tick();
    const reentered = await f.manager.rotate({ slotId: "anthropic", secret: SECRET, expectRevision: 3 });
    expect(reentered).toMatchObject({ state: "present", generation: 3 });
    expect(f.storage.snapshot().writes).toBe(4);
  });

  it("resolves only callback-scoped material through the policy-aware resolver", async () => {
    const f = fixture();
    await f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    const context = accessContext();
    let captured: unknown;
    const resolver = createPolicyAwareSecretResolver({
      policy: { evaluate() { return Object.freeze({ outcome: "allowed" as const, code: "POLICY_ALLOWED" as const, fingerprint: "f".repeat(64), requiredApprovals: Object.freeze([]) }); } },
      broker: f.broker,
    });
    const result = await resolver.withSecret({ ref: appVaultReferenceForSlot("anthropic"), context, policyRequest: policyRequest(context) as never }, async (material, fingerprint) => {
      captured = material;
      expect(fingerprint).toBe("f".repeat(64));
      expect(material.toString()).toBe("[REDACTED SECRET]");
      return await material.useText((value) => value === SECRET);
    });
    expect(result).toEqual({ value: true, decisionFingerprint: "f".repeat(64) });
    await expect((captured as { useText(callback: (text: string) => string): Promise<string> }).useText((text) => text)).rejects.toMatchObject({ code: "MATERIAL_DISPOSED" });
  });

  it("reports absent, revoked, unavailable, decrypt-failed and consumer-failed states finitely", async () => {
    const f = fixture();
    const ref = appVaultReferenceForSlot("anthropic");
    const context = accessContext();
    expect(await f.broker.availability(ref, context)).toMatchObject({ available: false, reason: "not-found" });
    await expect(f.broker.withSecret(ref, context, () => undefined)).rejects.toMatchObject({ code: "NOT_FOUND", details: { vaultCode: "VAULT_ABSENT" } });
    await f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    await expect(f.broker.withSecret(ref, context, () => { throw new Error(SECRET); })).rejects.toMatchObject({ code: "CONSUMER_FAILURE", message: "The secret consumer callback failed." });
    await f.manager.remove({ slotId: "anthropic", expectRevision: 1 });
    expect(await f.broker.availability(ref, context)).toMatchObject({ available: false, reason: "revoked" });
    await expect(f.broker.withSecret(ref, context, () => undefined)).rejects.toMatchObject({ code: "REVOKED" });

    const unavailable = fixture({ available: false });
    await unavailable.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null }).catch(() => undefined);
    await expect(unavailable.manager.create({ slotId: "openai", secret: SECRET, expectRevision: null })).rejects.toMatchObject({ code: "UNAVAILABLE" });

    const shared = createMemoryAppVaultStoragePort();
    const writer = fixture({ storage: shared });
    await writer.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    const broken = fixture({ storage: shared, failDecrypt: true });
    await expect(broken.broker.withSecret(ref, context, () => undefined)).rejects.toMatchObject({ code: "UNAVAILABLE", details: { vaultCode: "DECRYPT_FAILED" } });
  });

  it("rejects slot, exact-reference, provider-instance, deadline and cancellation mismatches", async () => {
    const f = fixture();
    await f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    await expect(f.broker.withSecret(appVaultReferenceForSlot("openai"), accessContext(), () => undefined)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(f.broker.withSecret(appVaultReferenceForSlot("anthropic"), accessContext("anthropic", { providerInstanceId: "other" }), () => undefined)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(f.broker.withSecret(appVaultReferenceForSlot("anthropic"), accessContext("anthropic", { accessForm: "bytes" }), () => undefined)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(f.broker.withSecret(appVaultReferenceForSlot("anthropic"), accessContext("anthropic", { deadline: "2026-08-19T08:59:59.000Z" }), () => undefined)).rejects.toMatchObject({ code: "RESOLUTION_TIMEOUT" });
    const controller = new AbortController(); controller.abort();
    await expect(f.broker.withSecret(appVaultReferenceForSlot("anthropic"), accessContext("anthropic", { signal: controller.signal }), () => undefined)).rejects.toMatchObject({ code: "RESOLUTION_TIMEOUT" });
    await expect(f.manager.create({ slotId: "future", secret: SECRET, expectRevision: null })).rejects.toMatchObject({ code: "SLOT_UNKNOWN" });
  });

  it("preserves an unreadable primary byte-for-byte and distinguishes it from absence", async () => {
    const storage = createMemoryAppVaultStoragePort({ initialBytes: new TextEncoder().encode('{"corrupt":true}') });
    const before = storage.snapshot().primary;
    const f = fixture({ storage });
    await expect(f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null })).rejects.toMatchObject({ code: "MALFORMED_BACKEND_RESPONSE", details: { vaultCode: "VAULT_CORRUPT" } });
    expect(storage.snapshot()).toMatchObject({ writes: 0 });
    expect(storage.snapshot().primary).toEqual(before);
    await expect(f.broker.describeRecord()).rejects.toMatchObject({ code: "VAULT_CORRUPT" });
  });

  it("supports a conflict then a valid retry without reconstructing the manager", async () => {
    const f = fixture();
    await f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    await expect(f.manager.rotate({ slotId: "anthropic", secret: `${SECRET}-TWO`, expectRevision: 2 })).rejects.toMatchObject({ code: "BACKEND_FAILURE", details: { vaultCode: "VAULT_REVISION_CONFLICT" } });
    const retried = await f.manager.rotate({ slotId: "anthropic", secret: `${SECRET}-TWO`, expectRevision: 1 });
    expect(retried).toMatchObject({ generation: 2, state: "present" });
  });

  it("serializes concurrent create, rotate and remove and leaves one canonical winner", async () => {
    const f = fixture();
    await f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    await f.manager.create({ slotId: "openai", secret: `${SECRET}-OPENAI`, expectRevision: 1 });
    await f.manager.create({ slotId: "gemini", secret: `${SECRET}-GEMINI`, expectRevision: 2 });
    const outcomes = await Promise.allSettled([
      f.manager.rotate({ slotId: "anthropic", secret: `${SECRET}-ROTATE`, expectRevision: 3 }),
      f.manager.remove({ slotId: "openai", expectRevision: 3 }),
      f.manager.create({ slotId: "openrouter", secret: `${SECRET}-ROUTER`, expectRevision: 3 }),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(2);
    const bytes = f.storage.snapshot().primary!;
    const binding = appVaultContainerBinding({ appIdentity: IDENTITY, backendKind: "deterministic-fake" });
    expect(parseVaultDocument(bytes, binding).revision).toBe(4);
  });

  it("shares one queue across independently constructed brokers over the same port", async () => {
    let armed = false;
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const storage = createMemoryAppVaultStoragePort({
      fault: async (stage) => {
        if (armed && stage === "after-revision-check") {
          arrivals += 1;
          if (arrivals === 1) await gate;
        }
      },
    });
    const f = fixture({ storage });
    await f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    armed = true;
    const rotating = f.manager.rotate({ slotId: "anthropic", secret: `${SECRET}-ROTATED`, expectRevision: 1 });
    while (arrivals === 0) await Promise.resolve();
    const revoking = f.broker.revoke(appVaultReferenceForSlot("anthropic"), accessContext());
    await Promise.resolve();
    expect(arrivals).toBe(1);
    release();
    await rotating;
    await revoking;
    expect(arrivals).toBe(2);
    expect(await f.broker.describeRecord()).toMatchObject({ state: "revoked", generation: 2 });
  });

  it("audits attempts and finite outcomes without projecting material", async () => {
    const records: SecretAuditRecord[] = [];
    const f = fixture({ audit: (record) => records.push(record) });
    await f.broker.availability(appVaultReferenceForSlot("anthropic"), accessContext());
    await expect(f.broker.replace(appVaultReferenceForSlot("anthropic"), { kind: "text", text: "\u0001" }, accessContext())).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
    await f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    await f.manager.remove({ slotId: "anthropic", expectRevision: 1 });
    await expect(f.broker.withSecret(appVaultReferenceForSlot("anthropic"), accessContext(), () => undefined)).rejects.toMatchObject({ code: "REVOKED" });
    const beforeLifecycleAction = records.length;
    await f.manager.forget({ slotId: "anthropic", expectRevision: 2 });
    expect(records).toHaveLength(beforeLifecycleAction);
    await f.broker.close();
    const aheadBytes = new TextEncoder().encode(toCanonicalJson({
      backend: { kind: "deterministic-fake" },
      containerBinding: "0".repeat(64),
      containerId: "app-vault.v1",
      createdAt: "2026-08-19T09:00:00.000Z",
      integrity: { algorithm: "sha256", digest: "0".repeat(64) },
      records: [],
      revision: 1,
      schemaVersion: 2,
      updatedAt: "2026-08-19T09:00:00.000Z",
    }));
    const ahead = fixture({ audit: (record) => records.push(record), storage: createMemoryAppVaultStoragePort({ initialBytes: aheadBytes }) });
    await expect(ahead.broker.availability(appVaultReferenceForSlot("anthropic"), accessContext())).resolves.toMatchObject({ available: false, reason: "unavailable" });
    await expect(ahead.broker.withSecret(appVaultReferenceForSlot("anthropic"), accessContext(), () => undefined)).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    const corrupt = fixture({ audit: (record) => records.push(record), storage: createMemoryAppVaultStoragePort({ initialBytes: new TextEncoder().encode("{}") }) });
    await expect(corrupt.broker.availability(appVaultReferenceForSlot("anthropic"), accessContext())).resolves.toMatchObject({ available: false, reason: "unavailable" });
    expect(new Set(records.map((record) => record.phase))).toEqual(new Set(["attempt", "outcome"]));
    expect(new Set(records.filter((record) => record.phase === "outcome").map((record) => record.outcome))).toEqual(new Set(["success", "not-found", "denied", "revoked", "unsupported", "failure", "closed"]));
    expect(JSON.stringify(records)).not.toContain(SECRET);
    expect(records.every((record) => record.reference === null || /^sha256:[a-f0-9]{64}$/u.test(record.reference))).toBe(true);
  });

  it("never leaks material through results, errors, inspection or stored JSON", async () => {
    const f = fixture({ failEncrypt: true });
    const error = await f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null }).catch((value: unknown) => value);
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(String(error)).not.toContain(SECRET);
    const good = fixture();
    const result = await good.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(new TextDecoder().decode(good.storage.snapshot().primary!)).not.toContain(SECRET);
    expect(String(good.broker)).toBe("[AppVaultSecretBroker]");
    expect(JSON.stringify(good.broker)).not.toContain(SECRET);
  });

  it("honors shouldReEncrypt after successful use without changing credential generation", async () => {
    let should = true;
    const f = fixture({ shouldReEncrypt: () => should });
    await f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    const value = await f.broker.withSecret(appVaultReferenceForSlot("anthropic"), accessContext(), (material) => material.useText((text) => text));
    should = false;
    expect(value).toBe(SECRET);
    for (let turn = 0; turn < 20 && f.storage.snapshot().writes < 2; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.storage.snapshot().writes).toBe(2);
    expect((await f.broker.describeRecord()).generation).toBe(1);
  });

  it("bounds failed shouldReEncrypt maintenance to one next-resolution retry", async () => {
    let failMaintenance = false;
    let maintenanceAttempts = 0;
    const storage = createMemoryAppVaultStoragePort({
      fault(stage) {
        if (failMaintenance && stage === "before-commit") {
          maintenanceAttempts += 1;
          throw new Error("synthetic-maintenance-failure");
        }
      },
    });
    const f = fixture({ shouldReEncrypt: true, storage });
    await f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    failMaintenance = true;
    const resolve = () => f.broker.withSecret(appVaultReferenceForSlot("anthropic"), accessContext(), () => undefined);
    for (const expected of [1, 2]) {
      await resolve();
      for (let turn = 0; turn < 20 && maintenanceAttempts < expected; turn += 1) await new Promise<void>((done) => setImmediate(done));
      expect(maintenanceAttempts).toBe(expected);
    }
    await resolve();
    for (let turn = 0; turn < 5; turn += 1) await new Promise<void>((done) => setImmediate(done));
    expect(maintenanceAttempts).toBe(2);
    await f.broker.close();
  });

  it("does not schedule duplicate shouldReEncrypt work while maintenance is in flight", async () => {
    let holdMaintenance = false;
    let enteredMaintenance = false;
    let releaseMaintenance!: () => void;
    const maintenanceGate = new Promise<void>((resolve) => { releaseMaintenance = resolve; });
    const storage = createMemoryAppVaultStoragePort({
      async fault(stage) {
        if (holdMaintenance && stage === "before-commit") {
          enteredMaintenance = true;
          await maintenanceGate;
        }
      },
    });
    const f = fixture({ shouldReEncrypt: true, storage });
    await f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    holdMaintenance = true;
    const resolve = () => f.broker.withSecret(appVaultReferenceForSlot("anthropic"), accessContext(), () => undefined);
    await resolve();
    for (let turn = 0; turn < 20 && !enteredMaintenance; turn += 1) await new Promise<void>((done) => setImmediate(done));
    expect(enteredMaintenance).toBe(true);
    await resolve();
    releaseMaintenance();
    await f.broker.close();
    expect(storage.snapshot().writes).toBe(2);
  });

  it("leaves resolution successful when encryption becomes unavailable before maintenance", async () => {
    let available = true;
    const f = fixture({ available: () => available, shouldReEncrypt: true });
    await f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    await f.broker.withSecret(appVaultReferenceForSlot("anthropic"), accessContext(), () => {
      available = false;
      return undefined;
    });
    await f.broker.close();
    expect(f.storage.snapshot().writes).toBe(1);
  });

  it("closes idempotently, refuses close inside callbacks, and disposes after use", async () => {
    const f = fixture();
    await f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    await f.broker.withSecret(appVaultReferenceForSlot("anthropic"), accessContext(), async () => {
      await expect(f.broker.close()).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    });
    await f.broker.close();
    await f.broker.close();
    await expect(f.broker.availability(appVaultReferenceForSlot("anthropic"), accessContext())).rejects.toMatchObject({ code: "BROKER_CLOSED" });
    await f.manager.close();
    await f.manager.close();
    await expect(f.manager.describeSlots()).rejects.toMatchObject({ code: "BROKER_CLOSED" });
  });

  it("waits for an active callback before completing close", async () => {
    const f = fixture();
    await f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const resolution = f.broker.withSecret(appVaultReferenceForSlot("anthropic"), accessContext(), async () => { entered(); await gate; });
    await started;
    let closed = false;
    const closing = f.broker.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await resolution;
    await closing;
    expect(closed).toBe(true);
  });

  it("waits for direct forget work before manager close resolves", async () => {
    const memory = createMemoryAppVaultStoragePort();
    const base = fixture({ storage: memory });
    let armed = false;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const storage = Object.freeze({
      async read() {
        const captured = await memory.port.read();
        if (armed) { entered(); await gate; }
        return captured;
      },
      readBackup: () => memory.port.readBackup(),
      writeAtomic: (input: Parameters<typeof memory.port.writeAtomic>[0]) => memory.port.writeAtomic(input),
      recoverAtomic: (input: Parameters<typeof memory.port.recoverAtomic>[0]) => memory.port.recoverAtomic(input),
    });
    const manager = createAppVaultManager({ ...base.common, storage });
    await manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    await manager.remove({ slotId: "anthropic", expectRevision: 1 });
    armed = true;
    const forgetting = manager.forget({ slotId: "anthropic", expectRevision: 2 });
    await started;
    let firstClosed = false;
    let secondClosed = false;
    const firstClose = manager.close().then(() => { firstClosed = true; });
    const secondClose = manager.close().then(() => { secondClosed = true; });
    await Promise.resolve();
    expect({ firstClosed, secondClosed }).toEqual({ firstClosed: false, secondClosed: false });
    release();
    await expect(forgetting).resolves.toMatchObject({ state: "absent", revision: 3 });
    await Promise.all([firstClose, secondClose]);
    expect({ firstClosed, secondClosed }).toEqual({ firstClosed: true, secondClosed: true });
    expect(parseVaultDocument(memory.snapshot().primary!, appVaultContainerBinding({ appIdentity: IDENTITY, backendKind: "deterministic-fake" })).revision).toBe(3);
  });

  it("waits for direct recovery work before manager close resolves", async () => {
    const memory = createMemoryAppVaultStoragePort();
    const base = fixture({ storage: memory });
    await base.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    await base.manager.rotate({ slotId: "anthropic", secret: `${SECRET}-TWO`, expectRevision: 1 });
    memory.replacePrimary(new TextEncoder().encode('{"corrupt":true}'));
    const observation = await base.manager.describeSnapshot();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let held = false;
    const storage = Object.freeze({
      async read() {
        const captured = await memory.port.read();
        if (!held) { held = true; entered(); await gate; }
        return captured;
      },
      readBackup: () => memory.port.readBackup(),
      writeAtomic: (input: Parameters<typeof memory.port.writeAtomic>[0]) => memory.port.writeAtomic(input),
      recoverAtomic: (input: Parameters<typeof memory.port.recoverAtomic>[0]) => memory.port.recoverAtomic(input),
    });
    const manager = createAppVaultManager({ ...base.common, storage });
    const restoring = manager.restoreBackup({
      expectPrimaryDigest: observation.recovery!.primaryDigest,
      expectBackupDigest: observation.recovery!.backupDigest!,
    });
    await started;
    let closed = false;
    const closing = manager.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await expect(restoring).resolves.toMatchObject({ vaultState: "ready", revision: 1 });
    await closing;
    expect(closed).toBe(true);
    expect(memory.snapshot().recoveries).toBe(1);
  });

  it("waits for broker metadata reads before close resolves", async () => {
    const memory = createMemoryAppVaultStoragePort();
    const base = fixture({ storage: memory });
    await base.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const storage = Object.freeze({
      async read() { const captured = await memory.port.read(); entered(); await gate; return captured; },
      readBackup: () => memory.port.readBackup(),
      writeAtomic: (input: Parameters<typeof memory.port.writeAtomic>[0]) => memory.port.writeAtomic(input),
      recoverAtomic: (input: Parameters<typeof memory.port.recoverAtomic>[0]) => memory.port.recoverAtomic(input),
    });
    const broker = createAppVaultSecretBroker({ ...base.common, storage, reference: appVaultReferenceForSlot("anthropic") });
    const describing = broker.describeRecord();
    await started;
    let closed = false;
    const closing = broker.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await expect(describing).resolves.toMatchObject({ state: "present", revision: 1 });
    await closing;
    expect(closed).toBe(true);
  });

  it("drains broker work before rejecting a close-attempt audit failure", async () => {
    const memory = createMemoryAppVaultStoragePort();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const base = fixture({ storage: memory });
    const storage = Object.freeze({
      async read() { const captured = await memory.port.read(); entered(); await gate; return captured; },
      readBackup: () => memory.port.readBackup(),
      writeAtomic: (input: Parameters<typeof memory.port.writeAtomic>[0]) => memory.port.writeAtomic(input),
      recoverAtomic: (input: Parameters<typeof memory.port.recoverAtomic>[0]) => memory.port.recoverAtomic(input),
    });
    let closeAttempts = 0;
    let broker!: ReturnType<typeof createAppVaultSecretBroker>;
    broker = createAppVaultSecretBroker({
      ...base.common,
      storage,
      reference: appVaultReferenceForSlot("anthropic"),
      audit(record) {
        if (record.operation === "close" && record.phase === "attempt") {
          closeAttempts += 1;
          void broker.close().catch(() => undefined);
          throw new Error(`${SECRET}-close-audit`);
        }
      },
    });
    const describing = broker.describeRecord();
    await started;
    let settled = false;
    const closing = broker.close().finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(describing).resolves.toMatchObject({ state: "absent", revision: null });
    const closeError = await closing.catch((error: unknown) => error);
    expect(closeError).toMatchObject({ code: "AUDIT_FAILURE" });
    expect(JSON.stringify(closeError)).not.toContain(SECRET);
    await expect(broker.close()).rejects.toMatchObject({ code: "AUDIT_FAILURE" });
    expect(closeAttempts).toBe(1);
  });

  it("returns one revision-bearing metadata snapshot from one primary read, including after restart", async () => {
    const f = fixture();
    await f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    const before = f.storage.snapshot();
    const snapshot = await f.manager.describeSnapshot();
    const after = f.storage.snapshot();
    expect(snapshot).toMatchObject({ vaultState: "ready", issue: null, revision: 1, recovery: null });
    expect(snapshot.slots).toHaveLength(4);
    expect(snapshot.slots.every((slot) => slot.revision === 1)).toBe(true);
    expect(after.reads - before.reads).toBe(1);
    expect(after.backupReads - before.backupReads).toBe(0);

    const restarted = createAppVaultManager(f.common);
    expect(await restarted.describeSnapshot()).toMatchObject({ revision: 1, slots: expect.arrayContaining([expect.objectContaining({ slotId: "anthropic", state: "present", revision: 1 })]) });
    await restarted.close();
  });

  it("keeps a metadata read on one captured revision while a concurrent rotation commits", async () => {
    const f = fixture();
    await f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    let firstRead = true;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const snapshotPort = Object.freeze({
      async read() {
        if (!firstRead) return await f.storage.port.read();
        firstRead = false;
        const captured = await f.storage.port.read();
        entered();
        await gate;
        return captured;
      },
      readBackup: () => f.storage.port.readBackup(),
      writeAtomic: (input: Parameters<typeof f.storage.port.writeAtomic>[0]) => f.storage.port.writeAtomic(input),
      recoverAtomic: (input: Parameters<typeof f.storage.port.recoverAtomic>[0]) => f.storage.port.recoverAtomic(input),
    });
    const reader = createAppVaultManager({ ...f.common, storage: snapshotPort });
    const pending = reader.describeSnapshot();
    await started;
    await f.manager.rotate({ slotId: "anthropic", secret: `${SECRET}-ROTATED`, expectRevision: 1 });
    release();
    const captured = await pending;
    expect(captured).toMatchObject({ revision: 1, slots: expect.arrayContaining([expect.objectContaining({ slotId: "anthropic", generation: 1, revision: 1 })]) });
    expect(await f.manager.describeSnapshot()).toMatchObject({ revision: 2, slots: expect.arrayContaining([expect.objectContaining({ generation: 2, revision: 2 })]) });
    await reader.close();
  });

  it("retries one decrypt failure, persists retained-ciphertext unrecoverable state, and allows rotate re-entry", async () => {
    const shared = createMemoryAppVaultStoragePort();
    const writer = fixture({ storage: shared });
    await writer.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    let failDecrypt = true;
    const recovering = fixture({ storage: shared, failDecrypt: () => failDecrypt });
    const resolve = () => recovering.broker.withSecret(appVaultReferenceForSlot("anthropic"), accessContext(), () => undefined);
    await expect(resolve()).rejects.toMatchObject({ code: "UNAVAILABLE", details: { vaultCode: "DECRYPT_FAILED" } });
    expect(await recovering.manager.describeSnapshot()).toMatchObject({ revision: 1, slots: expect.arrayContaining([expect.objectContaining({ state: "present" })]) });
    await expect(resolve()).rejects.toMatchObject({ code: "UNAVAILABLE", details: { vaultCode: "DECRYPT_FAILED" } });
    const unrecoverable = await recovering.manager.describeSnapshot();
    expect(unrecoverable).toMatchObject({ revision: 2, slots: expect.arrayContaining([expect.objectContaining({ state: "unrecoverable", generation: 1 })]) });
    const parsed = parseVaultDocument(shared.snapshot().primary!, appVaultContainerBinding({ appIdentity: IDENTITY, backendKind: "deterministic-fake" }));
    expect(parsed.records[0]).toMatchObject({ state: "unrecoverable", cipherText: expect.any(String), cipherByteLength: expect.any(Number) });
    expect(await recovering.broker.availability(appVaultReferenceForSlot("anthropic"), accessContext())).toMatchObject({ available: false, reason: "unavailable" });
    failDecrypt = false;
    const reentered = await recovering.manager.rotate({ slotId: "anthropic", secret: `${SECRET}-REENTERED`, expectRevision: 2 });
    expect(reentered).toMatchObject({ revision: 3, state: "present", generation: 2 });
    await expect(recovering.broker.withSecret(appVaultReferenceForSlot("anthropic"), accessContext(), (material) => material.useText((text) => text))).resolves.toBe(`${SECRET}-REENTERED`);
  });

  it("clears a transient decrypt-failure retry after a successful resolution", async () => {
    const shared = createMemoryAppVaultStoragePort();
    const writer = fixture({ storage: shared });
    await writer.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    let fail = true;
    const reader = fixture({ storage: shared, failDecrypt: () => fail });
    const resolve = () => reader.broker.withSecret(appVaultReferenceForSlot("anthropic"), accessContext(), () => undefined);
    await expect(resolve()).rejects.toMatchObject({ details: { vaultCode: "DECRYPT_FAILED" } });
    fail = false;
    await expect(resolve()).resolves.toBeUndefined();
    fail = true;
    await expect(resolve()).rejects.toMatchObject({ details: { vaultCode: "DECRYPT_FAILED" } });
    expect(await reader.manager.describeSnapshot()).toMatchObject({ revision: 1, slots: expect.arrayContaining([expect.objectContaining({ state: "present" })]) });
  });

  it("forgets only an explicitly revoked tombstone and preserves revision semantics", async () => {
    const f = fixture();
    await f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    await expect(f.manager.forget({ slotId: "anthropic", expectRevision: 1 })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await f.manager.remove({ slotId: "anthropic", expectRevision: 1 });
    const forgotten = await f.manager.forget({ slotId: "anthropic", expectRevision: 2 });
    expect(forgotten).toMatchObject({ slotId: "anthropic", state: "absent", revision: 3, generation: null });
    await expect(f.manager.forget({ slotId: "anthropic", expectRevision: 3 })).rejects.toMatchObject({ code: "RECORD_ABSENT" });
  });

  it("gates availability on crypto before any storage read", async () => {
    const shared = createMemoryAppVaultStoragePort();
    const writer = fixture({ storage: shared });
    await writer.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    const unavailable = fixture({ storage: shared, available: false });
    const before = shared.snapshot().reads;
    await expect(unavailable.broker.availability(appVaultReferenceForSlot("anthropic"), accessContext())).resolves.toMatchObject({ available: false, reason: "unavailable" });
    expect(shared.snapshot().reads).toBe(before);
    await expect(unavailable.broker.availability(appVaultReferenceForSlot("openai"), accessContext(), )).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(shared.snapshot().reads).toBe(before);
  });

  it("enforces the exact UTF-8 bound and rejects C1 and Unicode line separators", async () => {
    for (const secret of ["ok\u0080bad", "ok\u009fbad", "ok\u2028bad", "ok\u2029bad", "a".repeat(8_193)]) {
      const f = fixture();
      await expect(f.manager.create({ slotId: "anthropic", secret, expectRevision: null })).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
      expect(f.storage.snapshot().writes).toBe(0);
    }
    const exact = "a".repeat(8_192);
    const f = fixture();
    await expect(f.manager.create({ slotId: "anthropic", secret: exact, expectRevision: null })).resolves.toMatchObject({ revision: 1 });
    await expect(f.broker.withSecret(appVaultReferenceForSlot("anthropic"), accessContext(), (material) => material.useText((text) => text.length))).resolves.toBe(8_192);

    const multibyte = fixture();
    await expect(multibyte.manager.create({ slotId: "anthropic", secret: "é".repeat(4_096), expectRevision: null })).resolves.toMatchObject({ revision: 1 });
    const oversizedMultibyte = fixture();
    await expect(oversizedMultibyte.manager.create({ slotId: "anthropic", secret: `${"é".repeat(4_096)}a`, expectRevision: null })).rejects.toMatchObject({ details: { vaultCode: "SECRET_TOO_LARGE" } });
    expect(oversizedMultibyte.storage.snapshot().writes).toBe(0);
  });

  it("describes and explicitly restores a valid backup while preserving the corrupt primary", async () => {
    const f = fixture();
    await f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    await f.manager.rotate({ slotId: "anthropic", secret: `${SECRET}-TWO`, expectRevision: 1 });
    const corrupt = new TextEncoder().encode('{"corrupt":true}');
    f.storage.replacePrimary(corrupt);
    const described = await f.manager.describeSnapshot();
    expect(described).toMatchObject({
      vaultState: "corrupt",
      issue: "VAULT_CORRUPT",
      revision: null,
      recovery: { primaryDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), backupDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), backup: { revision: 1 }, actions: ["restore-backup", "start-over"] },
    });
    const restored = await f.manager.restoreBackup({
      expectPrimaryDigest: described.recovery!.primaryDigest,
      expectBackupDigest: described.recovery!.backupDigest!,
    });
    expect(restored).toMatchObject({ vaultState: "ready", revision: 1, slots: expect.arrayContaining([expect.objectContaining({ state: "present", generation: 1, revision: 1 })]) });
    expect(f.storage.snapshot()).toMatchObject({ recoveries: 1, forensics: [corrupt] });
  });

  it("refuses stale recovery observations and supports explicit start-over without deleting evidence", async () => {
    const storage = createMemoryAppVaultStoragePort({
      initialBytes: new TextEncoder().encode('{"broken":1}'),
      initialBackupBytes: new TextEncoder().encode('{"broken-backup":1}'),
    });
    const f = fixture({ storage });
    const described = await f.manager.describeSnapshot();
    expect(described).toMatchObject({ vaultState: "corrupt", recovery: { actions: ["start-over"] } });
    storage.replacePrimary(new TextEncoder().encode('{"broken":2}'));
    await expect(f.manager.startOver({ expectPrimaryDigest: described.recovery!.primaryDigest, expectBackupDigest: described.recovery!.backupDigest })).rejects.toMatchObject({ code: "VAULT_REVISION_CONFLICT" });
    expect(storage.snapshot().recoveries).toBe(0);
    const refreshed = await f.manager.describeSnapshot();
    const reset = await f.manager.startOver({ expectPrimaryDigest: refreshed.recovery!.primaryDigest, expectBackupDigest: refreshed.recovery!.backupDigest });
    expect(reset).toMatchObject({ vaultState: "ready", revision: 1, slots: expect.arrayContaining([expect.objectContaining({ state: "absent", revision: 1 })]) });
    expect(storage.snapshot()).toMatchObject({ recoveries: 1, forensics: [new TextEncoder().encode('{"broken":2}')] });
  });

  it("requires an explicit choice for a backup-only vault and never creates over it", async () => {
    const f = fixture();
    await f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    await f.manager.rotate({ slotId: "anthropic", secret: `${SECRET}-TWO`, expectRevision: 1 });
    f.storage.replacePrimary(null);
    const before = f.storage.snapshot();
    await expect(f.manager.create({ slotId: "openai", secret: `${SECRET}-OPENAI`, expectRevision: null })).rejects.toMatchObject({ code: "UNAVAILABLE", details: { vaultCode: "VAULT_BACKUP_ONLY" } });
    expect(f.storage.snapshot().writes).toBe(before.writes);
    const described = await f.manager.describeSnapshot();
    expect(described).toMatchObject({ vaultState: "backup-only", issue: "VAULT_BACKUP_ONLY", revision: null, recovery: { backup: { revision: 1 }, actions: ["restore-backup", "start-over"] } });
    const restored = await f.manager.restoreBackup({ expectPrimaryDigest: null, expectBackupDigest: described.recovery!.backupDigest! });
    expect(restored).toMatchObject({ vaultState: "ready", revision: 1 });
  });

  it("rebinds only an identity-mismatched document and discards its ciphertext explicitly", async () => {
    const shared = createMemoryAppVaultStoragePort();
    const foreign = fixture({ storage: shared });
    await foreign.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    const localIdentity = Object.freeze({ name: "AI Development OS Rebound", appDataPath: IDENTITY.appDataPath });
    const local = createAppVaultManager({ ...foreign.common, appIdentity: localIdentity });
    const described = await local.describeSnapshot();
    expect(described).toMatchObject({ vaultState: "identity-mismatch", issue: "VAULT_IDENTITY_MISMATCH", revision: 1, recovery: { actions: ["rebind"] } });
    const rebound = await local.rebind({ expectPrimaryDigest: described.recovery!.primaryDigest! });
    expect(rebound).toMatchObject({ vaultState: "ready", revision: 2, slots: expect.arrayContaining([expect.objectContaining({ state: "unrecoverable", generation: 1, revision: 2 })]) });
    const parsed = parseVaultDocument(shared.snapshot().primary!, appVaultContainerBinding({ appIdentity: localIdentity, backendKind: "deterministic-fake" }));
    expect(parsed.records[0]).toMatchObject({ state: "unrecoverable", cipherText: null, cipherByteLength: null, keyFingerprint: null, keyFingerprintSalt: null });
    await expect(local.rotate({ slotId: "anthropic", secret: `${SECRET}-REBOUND`, expectRevision: 2 })).resolves.toMatchObject({ state: "present", generation: 2, revision: 3 });
    expect(shared.snapshot()).toMatchObject({ recoveries: 1, forensics: [expect.any(Uint8Array)] });
    await local.close();
  });

  it("redacts typed foreign port failures and rejects proxy or accessor responses without invoking them", async () => {
    const base = fixture();
    const methods = {
      readBackup: () => base.storage.port.readBackup(),
      writeAtomic: (input: Parameters<typeof base.storage.port.writeAtomic>[0]) => base.storage.port.writeAtomic(input),
      recoverAtomic: (input: Parameters<typeof base.storage.port.recoverAtomic>[0]) => base.storage.port.recoverAtomic(input),
    };
    const throwingStorage = Object.freeze({
      ...methods,
      async read() { throw new AppVaultError("STORAGE_FAILURE", `${SECRET}-storage-canary`); },
    });
    const throwingManager = createAppVaultManager({ ...base.common, storage: throwingStorage });
    const storageError = await throwingManager.describeSnapshot().catch((error: unknown) => error);
    expect(storageError).toMatchObject({ code: "STORAGE_FAILURE", message: "The vault document could not be read." });
    expect(JSON.stringify(storageError)).not.toContain(SECRET);

    let getterCalls = 0;
    const accessorStorage = Object.freeze({
      ...methods,
      async read() {
        return Object.defineProperty({}, "bytes", { enumerable: true, get() { getterCalls += 1; throw new Error(SECRET); } });
      },
    });
    const accessorManager = createAppVaultManager({ ...base.common, storage: accessorStorage });
    const accessorError = await accessorManager.describeSnapshot().catch((error: unknown) => error);
    expect(accessorError).toMatchObject({ code: "STORAGE_FAILURE" });
    expect(getterCalls).toBe(0);
    expect(JSON.stringify(accessorError)).not.toContain(SECRET);

    const proxyStorage = Object.freeze({
      ...methods,
      async read() { return new Proxy({ bytes: new Uint8Array([1, 2]) }, { get() { throw new Error(SECRET); } }); },
    });
    const proxyError = await createAppVaultManager({ ...base.common, storage: proxyStorage }).describeSnapshot().catch((error: unknown) => error);
    expect(proxyError).toMatchObject({ code: "STORAGE_FAILURE" });
    expect(JSON.stringify(proxyError)).not.toContain(SECRET);
  });

  it("redacts hostile crypto, write-result and random responses", async () => {
    const shared = createMemoryAppVaultStoragePort();
    const writer = fixture({ storage: shared });
    await writer.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    const hostileCrypto = Object.freeze({
      isAvailable: async () => true,
      encrypt: (text: string) => writer.crypto.encrypt(text),
      async decrypt() { throw new AppVaultError("DECRYPT_FAILED", `${SECRET}-decrypt-canary`); },
      describeBackend: () => Object.freeze({ kind: "deterministic-fake" as const }),
    });
    const hostileBroker = createAppVaultSecretBroker({ ...writer.common, crypto: hostileCrypto, reference: appVaultReferenceForSlot("anthropic") });
    const decryptError = await hostileBroker.withSecret(appVaultReferenceForSlot("anthropic"), accessContext(), () => undefined).catch((error: unknown) => error);
    expect(decryptError).toMatchObject({ code: "UNAVAILABLE", details: { vaultCode: "DECRYPT_FAILED" }, message: "The credential could not be decrypted." });
    expect(JSON.stringify(decryptError)).not.toContain(SECRET);

    let resultGetterCalls = 0;
    const accessorCrypto = Object.freeze({
      ...hostileCrypto,
      async decrypt() {
        const value = { shouldReEncrypt: false };
        return Object.defineProperty(value, "result", { enumerable: true, get() { resultGetterCalls += 1; throw new Error(SECRET); } });
      },
    });
    const accessorBroker = createAppVaultSecretBroker({ ...writer.common, crypto: accessorCrypto, reference: appVaultReferenceForSlot("anthropic") });
    const responseError = await accessorBroker.withSecret(appVaultReferenceForSlot("anthropic"), accessContext(), () => undefined).catch((error: unknown) => error);
    expect(responseError).toMatchObject({ code: "MALFORMED_BACKEND_RESPONSE", details: { vaultCode: "MALFORMED_CRYPTO_RESPONSE" } });
    expect(resultGetterCalls).toBe(0);
    expect(JSON.stringify(responseError)).not.toContain(SECRET);

    const writeBase = createMemoryAppVaultStoragePort();
    const hostileWriteStorage = Object.freeze({
      read: () => writeBase.port.read(),
      readBackup: () => writeBase.port.readBackup(),
      recoverAtomic: (input: Parameters<typeof writeBase.port.recoverAtomic>[0]) => writeBase.port.recoverAtomic(input),
      async writeAtomic(input: Parameters<typeof writeBase.port.writeAtomic>[0]) {
        await writeBase.port.writeAtomic(input);
        return Object.defineProperty({}, "revision", { enumerable: true, get() { throw new Error(`${SECRET}-write-canary`); } }) as never;
      },
    });
    const writeFailure = fixture({ storage: { ...writeBase, port: hostileWriteStorage } as never });
    const writeError = await writeFailure.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null }).catch((error: unknown) => error);
    expect(writeError).toMatchObject({ code: "BACKEND_FAILURE", details: { vaultCode: "STORAGE_FAILURE" } });
    expect(JSON.stringify(writeError)).not.toContain(SECRET);

    const hostileRandom = Object.freeze({ bytes: () => new Proxy(new Uint8Array(32), {}) });
    const randomFailure = createAppVaultManager({ ...writer.common, storage: createMemoryAppVaultStoragePort().port, random: hostileRandom });
    const randomError = await randomFailure.create({ slotId: "anthropic", secret: SECRET, expectRevision: null }).catch((error: unknown) => error);
    expect(randomError).toMatchObject({ code: "BACKEND_FAILURE", details: { vaultCode: "ENCRYPT_FAILED" } });
    expect(JSON.stringify(randomError)).not.toContain(SECRET);
  });

  it("refuses every manager mutation against a newly corrupt primary without changing its bytes", async () => {
    const cases = [
      { prepare: async (f: ReturnType<typeof fixture>) => { await f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null }); }, run: (f: ReturnType<typeof fixture>) => f.manager.create({ slotId: "openai", secret: SECRET, expectRevision: 1 }) },
      { prepare: async (f: ReturnType<typeof fixture>) => { await f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null }); }, run: (f: ReturnType<typeof fixture>) => f.manager.rotate({ slotId: "anthropic", secret: `${SECRET}-TWO`, expectRevision: 1 }) },
      { prepare: async (f: ReturnType<typeof fixture>) => { await f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null }); }, run: (f: ReturnType<typeof fixture>) => f.manager.remove({ slotId: "anthropic", expectRevision: 1 }) },
      { prepare: async (f: ReturnType<typeof fixture>) => { await f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null }); await f.manager.remove({ slotId: "anthropic", expectRevision: 1 }); }, run: (f: ReturnType<typeof fixture>) => f.manager.forget({ slotId: "anthropic", expectRevision: 2 }) },
    ];
    for (const candidate of cases) {
      const f = fixture();
      await candidate.prepare(f);
      const corrupt = new TextEncoder().encode('{"corrupt":"mutation-guard"}');
      f.storage.replacePrimary(corrupt);
      const before = f.storage.snapshot();
      await expect(candidate.run(f)).rejects.toBeInstanceOf(Error);
      const after = f.storage.snapshot();
      expect(after.primary).toEqual(corrupt);
      expect(after.writes).toBe(before.writes);
      expect(after.recoveries).toBe(0);
    }
  });

  it("validates construction ports, contexts, clocks and audit failures", async () => {
    const f = fixture();
    const reference = appVaultReferenceForSlot("anthropic");
    for (const options of [
      null,
      { ...f.common, reference, extra: true },
      { ...f.common, reference, storage: {} },
      { ...f.common, reference, crypto: { ...f.crypto, describeBackend: () => ({ kind: "unknown" }) } },
      { ...f.common, reference, crypto: { ...f.crypto, describeBackend: () => { throw new Error(SECRET); } } },
      { ...f.common, reference, audit: "invalid" },
    ]) expect(() => createAppVaultSecretBroker(options)).toThrow(SecretBrokerError);
    await expect(f.broker.availability(reference, {} as never)).rejects.toMatchObject({ code: "INVALID_REFERENCE" });

    const badClock = fixture({ clock: Object.assign(new Clock(), { now: () => new Date(Number.NaN) }) });
    await expect(badClock.broker.availability(reference, accessContext())).rejects.toMatchObject({ code: "AUDIT_FAILURE" });
    for (const shadow of ["valueOf", "toISOString"] as const) {
      const date = new Date("2026-08-19T09:00:00.000Z");
      Object.defineProperty(date, shadow, { value: () => shadow === "valueOf" ? Date.parse("2026-08-19T09:00:00.000Z") : `${SECRET}-clock` });
      const hostileClock = fixture({ clock: Object.assign(new Clock(), { now: () => date }) });
      const clockError = await hostileClock.broker.availability(reference, accessContext()).catch((value: unknown) => value);
      expect(clockError).toMatchObject({ code: "AUDIT_FAILURE" });
      expect(JSON.stringify(clockError)).not.toContain(SECRET);
    }
    const badAudit = fixture({ audit: () => { throw new Error(SECRET); } });
    const error = await badAudit.broker.availability(reference, accessContext()).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "AUDIT_FAILURE" });
    expect(JSON.stringify(error)).not.toContain(SECRET);
  });

  it("exercises testing factories and observes best-effort zeroing without material", async () => {
    const storage = createMemoryAppVaultStoragePort();
    const clock = new Clock();
    const zeroes: Array<{ stage: string; allZero: boolean }> = [];
    const common = {
      schemaVersion: 1 as const,
      appIdentity: IDENTITY,
      clock,
      crypto: createDeterministicAppVaultCryptoPort(),
      storage: storage.port,
      random: createDeterministicAppVaultRandomPort(),
    };
    const testingManager = createAppVaultManagerForTesting(common);
    await testingManager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    const testingBroker = createAppVaultSecretBrokerForTesting({
      ...common,
      reference: appVaultReferenceForSlot("anthropic"),
      onZero: (record: { stage: string; allZero: boolean }) => zeroes.push(record),
    });
    await testingBroker.withSecret(appVaultReferenceForSlot("anthropic"), accessContext(), (material) => material.useText((text) => expect(text).toBe(SECRET)));
    expect(zeroes.length).toBeGreaterThanOrEqual(2);
    expect(zeroes.every((record) => record.allZero)).toBe(true);
    const failingZeroBroker = createAppVaultSecretBrokerForTesting({
      ...common,
      reference: appVaultReferenceForSlot("anthropic"),
      onZero: () => { throw new Error(SECRET); },
    });
    await expect(failingZeroBroker.withSecret(appVaultReferenceForSlot("anthropic"), accessContext(), () => "completed")).resolves.toBe("completed");
  });
});

describe("write-boundary fault injection", () => {
  const stages: readonly AppVaultMemoryFaultStage[] = [
    "before-revision-check", "after-revision-check", "before-backup", "after-backup", "before-commit", "after-commit",
  ];

  for (const stage of stages) {
    it(`surfaces a finite failure at ${stage} and leaves absent or canonical state`, async () => {
      const storage = createMemoryAppVaultStoragePort({ fault: (candidate) => { if (candidate === stage) throw new AppVaultError("STORAGE_FAILURE", "Injected storage failure."); } });
      const f = fixture({ storage });
      const error = await f.manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null }).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: "BACKEND_FAILURE", details: { vaultCode: "STORAGE_FAILURE" } });
      const snapshot = storage.snapshot();
      if (stage === "after-commit") {
        expect(snapshot.writes).toBe(1);
        expect(parseVaultDocument(snapshot.primary!, appVaultContainerBinding({ appIdentity: IDENTITY, backendKind: "deterministic-fake" })).revision).toBe(1);
      } else {
        expect(snapshot).toMatchObject({ primary: null, writes: 0 });
      }
    });
  }

  it("maps read and backup faults without exposing foreign error messages", async () => {
    for (const faultStage of ["read", "read-backup"] as const) {
      const storage = createMemoryAppVaultStoragePort({ fault: (candidate) => { if (candidate === faultStage) throw new Error(`${SECRET}-${faultStage}`); } });
      const f = fixture({ storage });
      if (faultStage === "read") {
        const error = await f.manager.describeSlots().catch((value: unknown) => value);
        expect(error).toMatchObject({ code: "STORAGE_FAILURE" });
        expect(JSON.stringify(error)).not.toContain(SECRET);
      } else {
        await expect(storage.port.readBackup()).rejects.toThrow(SECRET);
      }
    }
  });
});
