import { createHash } from "node:crypto";
import { toCanonicalJson } from "@ai-dev-os/domain";
import { parseSecretAccessContext, SecretBrokerError, type SecretAccessContext } from "@ai-dev-os/secrets";
import { describe, expect, it } from "vitest";
import {
  APP_VAULT_CONTAINER_ID,
  APP_VAULT_MAX_CIPHER_TEXT_CHARS,
  AppVaultError,
  appVaultContainerBinding,
  appVaultReferenceForSlot,
  createAppVaultManager,
  createAppVaultSecretBroker,
  parseAppVaultReference,
  type AppVaultCryptoPort,
  type AppVaultManagerOptions,
  type AppVaultStoragePort,
} from "../src/index.js";
import {
  createEmptyVaultDocument,
  serializeVaultDocument,
} from "../src/document.js";
import {
  createAppVaultSecretBrokerForTesting,
  createDeterministicAppVaultCryptoPort,
  createDeterministicAppVaultRandomPort,
  createMemoryAppVaultStoragePort,
} from "../src/testing/index.js";

const IDENTITY = Object.freeze({ name: "AI Development OS", appDataPath: "C:\\Users\\Operator\\AppData\\Roaming" });
const OTHER_IDENTITY = Object.freeze({ name: "Other AI Development OS", appDataPath: "C:\\Users\\Operator\\AppData\\Roaming" });
const NOW = "2026-08-19T09:00:00.000Z";
const SECRET = "SYNTHETIC-DEFENSIVE-CREDENTIAL-18E";

function context(overrides: Record<string, unknown> = {}): SecretAccessContext {
  return parseSecretAccessContext({
    operationId: "defensive-operation",
    providerInstanceId: "anthropic-default",
    purpose: "provider-authentication",
    requestedLifetimeMs: 30_000,
    accessForm: "text",
    classification: "internal",
    projectId: null,
    taskId: null,
    approvalEvidenceRefs: [],
    disclosureDecisionFingerprint: null,
    locality: "local",
    trace: { traceId: "defensive-trace", runId: null, taskId: null, taskRunId: null },
    deadline: null,
    signal: undefined,
    ...overrides,
  });
}

function portWith(
  memory: ReturnType<typeof createMemoryAppVaultStoragePort>,
  overrides: Partial<AppVaultStoragePort> = {},
): AppVaultStoragePort {
  return Object.freeze({
    read: overrides.read ?? (() => memory.port.read()),
    readBackup: overrides.readBackup ?? (() => memory.port.readBackup()),
    writeAtomic: overrides.writeAtomic ?? ((input) => memory.port.writeAtomic(input)),
    recoverAtomic: overrides.recoverAtomic ?? ((input) => memory.port.recoverAtomic(input)),
  });
}

function options(input: {
  storage?: AppVaultStoragePort;
  crypto?: AppVaultCryptoPort;
  identity?: typeof IDENTITY;
  includeRandom?: boolean;
  clock?: { now(): Date };
} = {}): AppVaultManagerOptions {
  return Object.freeze({
    schemaVersion: 1 as const,
    appIdentity: input.identity ?? IDENTITY,
    clock: input.clock ?? Object.freeze({ now: () => new Date(NOW) }),
    crypto: input.crypto ?? createDeterministicAppVaultCryptoPort(),
    storage: input.storage ?? createMemoryAppVaultStoragePort().port,
    ...(input.includeRandom === false ? {} : { random: createDeterministicAppVaultRandomPort() }),
  });
}

function brokerOptions(managerOptions: AppVaultManagerOptions): Record<string, unknown> {
  return { ...managerOptions, reference: appVaultReferenceForSlot("anthropic") };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function schemaAheadBytes(): Uint8Array {
  const body = {
    schemaVersion: 2,
    containerId: APP_VAULT_CONTAINER_ID,
    revision: 1,
    containerBinding: "a".repeat(64),
    backend: { kind: "deterministic-fake" },
    createdAt: NOW,
    updatedAt: NOW,
    records: [],
  };
  const integrity = { algorithm: "sha256", digest: createHash("sha256").update(toCanonicalJson(body)).digest("hex") };
  return new TextEncoder().encode(toCanonicalJson({ ...body, integrity }));
}

async function corruptPrimaryWithBackup() {
  const memory = createMemoryAppVaultStoragePort();
  const common = options({ storage: memory.port });
  const writer = createAppVaultManager(common);
  await writer.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
  await writer.create({ slotId: "openai", secret: `${SECRET}-OPENAI`, expectRevision: 1 });
  memory.replacePrimary(new TextEncoder().encode('{"corrupt":true}'));
  const snapshot = await writer.describeSnapshot();
  expect(snapshot.vaultState).toBe("corrupt");
  expect(snapshot.recovery?.backupDigest).toMatch(/^[a-f0-9]{64}$/u);
  return { memory, common, snapshot };
}

describe("defensive app-vault contract branches", () => {
  it("rejects hostile construction objects and malformed option fields without invoking accessors", () => {
    const common = options();
    const reference = appVaultReferenceForSlot("anthropic");
    let getterCalls = 0;
    const accessor = Object.defineProperty({ ...brokerOptions(common) }, "schemaVersion", {
      enumerable: true,
      get() { getterCalls += 1; return 1; },
    });
    const symbol = { ...brokerOptions(common), [Symbol("hidden")]: true };
    const inherited = Object.assign(Object.create({ inherited: true }) as object, brokerOptions(common));
    for (const candidate of [
      accessor,
      symbol,
      inherited,
      { ...brokerOptions(common), schemaVersion: 2 },
      { ...brokerOptions(common), appIdentity: { name: 7, appDataPath: IDENTITY.appDataPath } },
      { ...brokerOptions(common), storage: null },
      { ...brokerOptions(common), crypto: new Proxy(common.crypto, {}) },
      { ...brokerOptions(common), crypto: { ...common.crypto, describeBackend: () => null } },
    ]) expect(() => createAppVaultSecretBroker(candidate)).toThrow(SecretBrokerError);
    expect(getterCalls).toBe(0);
    expect(() => createAppVaultSecretBrokerForTesting({ ...brokerOptions(common), onZero: "invalid" })).toThrow(SecretBrokerError);
    expect(() => parseAppVaultReference(Object.assign(Object.create({}), reference))).toThrow(SecretBrokerError);
  });

  it("rejects hostile manager requests, invalid revisions and non-text values", async () => {
    const manager = createAppVaultManager(options());
    let getterCalls = 0;
    const accessor = Object.defineProperty({ slotId: "anthropic", secret: SECRET }, "expectRevision", {
      enumerable: true,
      get() { getterCalls += 1; return null; },
    });
    const requests = [
      null,
      { slotId: "anthropic", secret: SECRET, expectRevision: null, extra: true },
      { slotId: "anthropic", secret: SECRET, expectRevision: null, [Symbol("hidden")]: true },
      accessor,
      new Proxy({ slotId: "anthropic", secret: SECRET, expectRevision: null }, {}),
    ];
    for (const request of requests) await expect(manager.create(request as never)).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(getterCalls).toBe(0);
    await expect(manager.create({ slotId: "anthropic", secret: 7, expectRevision: null } as never)).rejects.toMatchObject({ code: "SECRET_INVALID_CHARACTERS" });
    await expect(manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: 0 })).rejects.toMatchObject({ code: "VAULT_REVISION_CONFLICT" });
    await expect(manager.rotate({ slotId: "anthropic", secret: SECRET, expectRevision: null } as never)).rejects.toMatchObject({ code: "VAULT_REVISION_CONFLICT" });
  });

  it("uses the production random default and enforces empty-secret and random-failure boundaries", async () => {
    const manager = createAppVaultManager(options({ includeRandom: false }));
    await expect(manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null })).resolves.toMatchObject({ revision: 1 });

    const empty = createAppVaultManager(options());
    await expect(empty.create({ slotId: "anthropic", secret: "   ", expectRevision: null })).rejects.toMatchObject({ details: { vaultCode: "SECRET_EMPTY" } });
    const randomFailure = createAppVaultManager({ ...options(), random: Object.freeze({ bytes() { throw new Error(`${SECRET}-random`); } }) });
    const error = await randomFailure.create({ slotId: "anthropic", secret: SECRET, expectRevision: null }).catch((value: unknown) => value);
    expect(error).toMatchObject({ details: { vaultCode: "ENCRYPT_FAILED" } });
    expect(JSON.stringify(error)).not.toContain(`${SECRET}-random`);
  });

  it("normalizes hostile storage reads and response shapes to finite local errors", async () => {
    const cases: readonly (() => AppVaultStoragePort)[] = [
      () => portWith(createMemoryAppVaultStoragePort(), { read: async () => { throw new AppVaultError("VAULT_CORRUPT", `${SECRET}-primary`); } }),
      () => portWith(createMemoryAppVaultStoragePort(), { read: async () => 7 as never }),
      () => portWith(createMemoryAppVaultStoragePort(), { read: async () => ({ bytes: new Uint8Array([1]), extra: true }) as never }),
      () => portWith(createMemoryAppVaultStoragePort(), { read: async () => ({ bytes: new Uint8Array(0) }) }),
    ];
    for (const makePort of cases) {
      const error = await createAppVaultManager(options({ storage: makePort() })).describeSnapshot().catch((value: unknown) => value);
      expect(error).toBeInstanceOf(AppVaultError);
      expect(JSON.stringify(error)).not.toContain(SECRET);
    }
    const backupPort = portWith(createMemoryAppVaultStoragePort(), {
      read: async () => null,
      readBackup: async () => { throw new AppVaultError("VAULT_CORRUPT", `${SECRET}-backup`); },
    });
    const backupError = await createAppVaultManager(options({ storage: backupPort })).describeSnapshot().catch((value: unknown) => value);
    expect(backupError).toMatchObject({ code: "VAULT_CORRUPT", message: "The vault backup is unreadable or corrupt." });
    const foreignBackupPort = portWith(createMemoryAppVaultStoragePort(), {
      read: async () => null,
      readBackup: async () => { throw new Error(`${SECRET}-foreign-backup`); },
    });
    const foreignBackupError = await createAppVaultManager(options({ storage: foreignBackupPort })).describeSnapshot().catch((value: unknown) => value);
    expect(foreignBackupError).toMatchObject({ code: "STORAGE_FAILURE", message: "The vault backup could not be read." });
    expect(JSON.stringify(foreignBackupError)).not.toContain(SECRET);
  });

  it("maps every classified write refusal and malformed write result", async () => {
    const codes = ["VAULT_REVISION_CONFLICT", "VAULT_BUSY", "VAULT_BACKUP_ONLY", "VAULT_CORRUPT"] as const;
    for (const code of codes) {
      const memory = createMemoryAppVaultStoragePort();
      const storage = portWith(memory, { writeAtomic: async () => { throw new AppVaultError(code, `${SECRET}-${code}`); } });
      const error = await createAppVaultManager(options({ storage })).create({ slotId: "anthropic", secret: SECRET, expectRevision: null }).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(SecretBrokerError);
      expect(JSON.stringify(error)).not.toContain(`${SECRET}-${code}`);
    }
    for (const revision of [0, 99]) {
      const memory = createMemoryAppVaultStoragePort();
      const storage = portWith(memory, { writeAtomic: async () => Object.freeze({ revision }) });
      await expect(createAppVaultManager(options({ storage })).create({ slotId: "anthropic", secret: SECRET, expectRevision: null })).rejects.toMatchObject({ details: { vaultCode: "STORAGE_FAILURE" } });
    }
  });

  it("rejects oversized ciphertext and malformed decryption fields", async () => {
    const oversizedCrypto: AppVaultCryptoPort = Object.freeze({
      ...createDeterministicAppVaultCryptoPort(),
      async encrypt() { return new Uint8Array(Math.ceil(APP_VAULT_MAX_CIPHER_TEXT_CHARS * 0.8)); },
    });
    await expect(createAppVaultManager(options({ crypto: oversizedCrypto })).create({ slotId: "anthropic", secret: SECRET, expectRevision: null })).rejects.toMatchObject({ details: { vaultCode: "ENCRYPT_FAILED" } });

    const memory = createMemoryAppVaultStoragePort();
    await createAppVaultManager(options({ storage: memory.port })).create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    for (const malformed of [{ result: 7, shouldReEncrypt: false }, { result: SECRET, shouldReEncrypt: "no" }]) {
      const crypto: AppVaultCryptoPort = Object.freeze({
        ...createDeterministicAppVaultCryptoPort(),
        async decrypt() { return malformed as never; },
      });
      const broker = createAppVaultSecretBroker(brokerOptions(options({ storage: memory.port, crypto })));
      await expect(broker.withSecret(appVaultReferenceForSlot("anthropic"), context(), () => undefined)).rejects.toMatchObject({ details: { vaultCode: "MALFORMED_CRYPTO_RESPONSE" } });
    }
  });

  it("gates availability and resolution on well-formed crypto availability", async () => {
    const memory = createMemoryAppVaultStoragePort();
    const writerOptions = options({ storage: memory.port });
    await createAppVaultManager(writerOptions).create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    for (const isAvailable of [async () => { throw new Error(`${SECRET}-availability`); }, async () => "yes" as never]) {
      const crypto: AppVaultCryptoPort = Object.freeze({ ...createDeterministicAppVaultCryptoPort(), isAvailable });
      const broker = createAppVaultSecretBroker(brokerOptions(options({ storage: memory.port, crypto })));
      await expect(broker.availability(appVaultReferenceForSlot("anthropic"), context())).resolves.toMatchObject({ available: false, reason: "unavailable" });
      await expect(broker.withSecret(appVaultReferenceForSlot("anthropic"), context(), () => undefined)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    }
  });

  it("rejects invalid callbacks and raw materials before any secret can cross the callback boundary", async () => {
    const common = options();
    const broker = createAppVaultSecretBroker(brokerOptions(common));
    await expect(broker.withSecret(appVaultReferenceForSlot("anthropic"), context(), undefined as never)).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
    await expect(broker.replace(appVaultReferenceForSlot("anthropic"), { kind: "bytes", bytes: new Uint8Array([1]) } as never, context())).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
  });

  it("describes corrupt backup-only, schema-ahead and backend-mismatched states finitely", async () => {
    const corruptBackup = createMemoryAppVaultStoragePort({ initialBackupBytes: new TextEncoder().encode("{}") });
    await expect(createAppVaultManager(options({ storage: corruptBackup.port })).describeSnapshot()).resolves.toMatchObject({
      vaultState: "corrupt",
      recovery: { primaryDigest: null, actions: ["start-over"] },
    });

    const ahead = createMemoryAppVaultStoragePort({ initialBytes: schemaAheadBytes() });
    await expect(createAppVaultManager(options({ storage: ahead.port })).describeSnapshot()).resolves.toMatchObject({ vaultState: "schema-ahead", issue: "VAULT_SCHEMA_AHEAD" });

    const electronBinding = appVaultContainerBinding({ appIdentity: IDENTITY, backendKind: "electron-safe-storage-async" });
    const backendBytes = serializeVaultDocument(createEmptyVaultDocument(electronBinding, NOW));
    const backend = createMemoryAppVaultStoragePort({ initialBytes: backendBytes });
    await expect(createAppVaultManager(options({ storage: backend.port })).describeSnapshot()).resolves.toMatchObject({
      vaultState: "backend-mismatch",
      issue: "VAULT_BACKEND_MISMATCH",
      recovery: { actions: [] },
    });
  });

  it("requires digest-bound recovery choices and refuses readable or absent start-over states", async () => {
    const empty = createAppVaultManager(options());
    await expect(empty.restoreBackup({ expectPrimaryDigest: null, expectBackupDigest: "bad" })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await expect(empty.startOver({ expectPrimaryDigest: null, expectBackupDigest: null })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await expect(empty.rebind({ expectPrimaryDigest: "a".repeat(64) })).rejects.toMatchObject({ code: "VAULT_REVISION_CONFLICT" });

    const memory = createMemoryAppVaultStoragePort();
    const manager = createAppVaultManager(options({ storage: memory.port }));
    await manager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    const primary = memory.snapshot().primary!;
    await expect(manager.startOver({ expectPrimaryDigest: digest(primary), expectBackupDigest: null })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await expect(manager.rebind({ expectPrimaryDigest: digest(primary) })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
  });

  it("refuses backup restoration from ready, schema-ahead, backend-mismatch and identity-mismatch states without changing bytes", async () => {
    const readyMemory = createMemoryAppVaultStoragePort();
    const readyManager = createAppVaultManager(options({ storage: readyMemory.port }));
    await readyManager.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    await readyManager.create({ slotId: "openai", secret: `${SECRET}-OPENAI`, expectRevision: 1 });
    const ready = readyMemory.snapshot();
    const validBackup = ready.backup!;

    const electronBinding = appVaultContainerBinding({ appIdentity: IDENTITY, backendKind: "electron-safe-storage-async" });
    const backendMismatch = serializeVaultDocument(createEmptyVaultDocument(electronBinding, NOW));
    const foreignMemory = createMemoryAppVaultStoragePort();
    await createAppVaultManager(options({ storage: foreignMemory.port, identity: OTHER_IDENTITY as typeof IDENTITY })).create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    const identityMismatch = foreignMemory.snapshot().primary!;

    for (const candidate of [
      { bytes: ready.primary!, code: "INVALID_CONFIGURATION" },
      { bytes: schemaAheadBytes(), code: "VAULT_SCHEMA_AHEAD" },
      { bytes: backendMismatch, code: "VAULT_BACKEND_MISMATCH" },
      { bytes: identityMismatch, code: "VAULT_IDENTITY_MISMATCH" },
    ] as const) {
      const memory = createMemoryAppVaultStoragePort({ initialBytes: candidate.bytes, initialBackupBytes: validBackup });
      const manager = createAppVaultManager(options({ storage: memory.port }));
      const before = memory.snapshot();
      await expect(manager.restoreBackup({
        expectPrimaryDigest: digest(candidate.bytes),
        expectBackupDigest: digest(validBackup),
      })).rejects.toMatchObject({ code: candidate.code });
      const after = memory.snapshot();
      expect(after.primary).toEqual(before.primary);
      expect(after.backup).toEqual(before.backup);
      expect(after.recoveries).toBe(0);
      expect(after.forensics).toEqual([]);
    }
  });

  it("maps recovery-port failures and rejects invalid recovery revisions", async () => {
    for (const failure of [
      new AppVaultError("VAULT_REVISION_CONFLICT", `${SECRET}-recovery-conflict`),
      new AppVaultError("VAULT_BUSY", `${SECRET}-recovery-busy`),
      new Error(`${SECRET}-recovery-foreign`),
    ]) {
      const { memory, common, snapshot } = await corruptPrimaryWithBackup();
      const storage = portWith(memory, { recoverAtomic: async () => { throw failure; } });
      const manager = createAppVaultManager({ ...common, storage });
      const error = await manager.restoreBackup({
        expectPrimaryDigest: snapshot.recovery!.primaryDigest,
        expectBackupDigest: snapshot.recovery!.backupDigest!,
      }).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(AppVaultError);
      expect(JSON.stringify(error)).not.toContain(SECRET);
    }
    for (const revision of [0, 99]) {
      const { memory, common, snapshot } = await corruptPrimaryWithBackup();
      const storage = portWith(memory, { recoverAtomic: async () => Object.freeze({ revision }) });
      await expect(createAppVaultManager({ ...common, storage }).restoreBackup({
        expectPrimaryDigest: snapshot.recovery!.primaryDigest,
        expectBackupDigest: snapshot.recovery!.backupDigest!,
      })).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
    }
  });

  it("validates start-over and rebind commit revisions and source state", async () => {
    const corrupt = new TextEncoder().encode('{"corrupt":true}');
    const corruptMemory = createMemoryAppVaultStoragePort({ initialBytes: corrupt });
    const startStorage = portWith(corruptMemory, { recoverAtomic: async () => Object.freeze({ revision: 99 }) });
    await expect(createAppVaultManager(options({ storage: startStorage })).startOver({
      expectPrimaryDigest: digest(corrupt),
      expectBackupDigest: null,
    })).rejects.toMatchObject({ code: "STORAGE_FAILURE" });

    const foreignMemory = createMemoryAppVaultStoragePort();
    await createAppVaultManager(options({ storage: foreignMemory.port, identity: OTHER_IDENTITY as typeof IDENTITY })).create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    const local = createAppVaultManager(options({ storage: foreignMemory.port }));
    const mismatch = await local.describeSnapshot();
    const rebindStorage = portWith(foreignMemory, { recoverAtomic: async () => Object.freeze({ revision: 99 }) });
    await expect(createAppVaultManager(options({ storage: rebindStorage })).rebind({ expectPrimaryDigest: mismatch.recovery!.primaryDigest! })).rejects.toMatchObject({ code: "STORAGE_FAILURE" });

    const electronBinding = appVaultContainerBinding({ appIdentity: IDENTITY, backendKind: "electron-safe-storage-async" });
    const electronBytes = serializeVaultDocument(createEmptyVaultDocument(electronBinding, NOW));
    const backendMemory = createMemoryAppVaultStoragePort({ initialBytes: electronBytes });
    await expect(createAppVaultManager(options({ storage: backendMemory.port })).rebind({ expectPrimaryDigest: digest(electronBytes) })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
  });

  it("covers absent, conflicting and repeated lifecycle mutations", async () => {
    const absent = createAppVaultManager(options());
    await expect(absent.remove({ slotId: "anthropic", expectRevision: 1 })).rejects.toMatchObject({ details: { vaultCode: "VAULT_ABSENT" } });
    await expect(absent.forget({ slotId: "anthropic", expectRevision: 1 })).rejects.toMatchObject({ code: "VAULT_ABSENT" });

    const memory = createMemoryAppVaultStoragePort();
    const manager = createAppVaultManager(options({ storage: memory.port }));
    await manager.create({ slotId: "openai", secret: `${SECRET}-OPENAI`, expectRevision: null });
    await expect(manager.rotate({ slotId: "anthropic", secret: SECRET, expectRevision: 1 })).rejects.toMatchObject({ details: { vaultCode: "SLOT_NOT_PRESENT" } });
    await expect(manager.remove({ slotId: "anthropic", expectRevision: 1 })).rejects.toMatchObject({ details: { vaultCode: "RECORD_ABSENT" } });
    await expect(manager.forget({ slotId: "anthropic", expectRevision: 2 })).rejects.toMatchObject({ code: "VAULT_REVISION_CONFLICT" });
    await expect(manager.forget({ slotId: "anthropic", expectRevision: 1 })).rejects.toMatchObject({ code: "RECORD_ABSENT" });
    await manager.remove({ slotId: "openai", expectRevision: 1 });
    await expect(manager.remove({ slotId: "openai", expectRevision: 2 })).rejects.toMatchObject({ details: { vaultCode: "RECORD_REVOKED" } });
  });

  it("rejects invalid lifecycle commit revisions", async () => {
    const removeMemory = createMemoryAppVaultStoragePort();
    await createAppVaultManager(options({ storage: removeMemory.port })).create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    const removeStorage = portWith(removeMemory, { writeAtomic: async () => Object.freeze({ revision: 99 }) });
    await expect(createAppVaultManager(options({ storage: removeStorage })).remove({ slotId: "anthropic", expectRevision: 1 })).rejects.toMatchObject({ details: { vaultCode: "STORAGE_FAILURE" } });

    const forgetMemory = createMemoryAppVaultStoragePort();
    const writer = createAppVaultManager(options({ storage: forgetMemory.port }));
    await writer.create({ slotId: "anthropic", secret: SECRET, expectRevision: null });
    await writer.remove({ slotId: "anthropic", expectRevision: 1 });
    const forgetStorage = portWith(forgetMemory, { writeAtomic: async () => Object.freeze({ revision: 99 }) });
    await expect(createAppVaultManager(options({ storage: forgetStorage })).forget({ slotId: "anthropic", expectRevision: 2 })).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
  });

  it("enforces deadlines and hostile cancellation state at operation boundaries", async () => {
    let tick = 0;
    const clock = Object.freeze({ now: () => new Date(Date.parse(NOW) + tick++ * 1_000) });
    const timed = createAppVaultSecretBroker(brokerOptions(options({ clock })));
    await expect(timed.availability(appVaultReferenceForSlot("anthropic"), context({ deadline: "2026-08-19T09:00:02.000Z" }))).rejects.toMatchObject({ code: "RESOLUTION_TIMEOUT" });

    let reads = 0;
    const signal = {
      get aborted() {
        reads += 1;
        if (reads === 1) return false;
        throw new Error(`${SECRET}-signal`);
      },
      addEventListener() {},
    };
    const cancelled = createAppVaultSecretBroker(brokerOptions(options()));
    const error = await cancelled.availability(appVaultReferenceForSlot("anthropic"), context({ signal })).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "RESOLUTION_TIMEOUT" });
    expect(JSON.stringify(error)).not.toContain(SECRET);

    let abortedReads = 0;
    const becomesAborted = {
      get aborted() { abortedReads += 1; return abortedReads > 1; },
      addEventListener() {},
    };
    await expect(cancelled.availability(appVaultReferenceForSlot("anthropic"), context({ signal: becomesAborted }))).rejects.toMatchObject({ code: "RESOLUTION_TIMEOUT" });

    const unavailableSignal = {
      get aborted(): boolean { throw new Error(`${SECRET}-unavailable-signal`); },
      addEventListener() {},
    };
    const signalError = await cancelled.availability(appVaultReferenceForSlot("anthropic"), context({ signal: unavailableSignal })).catch((value: unknown) => value);
    expect(signalError).toMatchObject({ code: "RESOLUTION_TIMEOUT" });
    expect(JSON.stringify(signalError)).not.toContain(SECRET);
  });
});
