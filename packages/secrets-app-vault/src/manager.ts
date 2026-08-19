import { parseSecretAccessContext, type SecretAccessContext } from "@ai-dev-os/secrets";
import { types } from "node:util";
import {
  APP_VAULT_BROKER_SCHEMA_VERSION,
  type AppVaultManager,
  type AppVaultManagerOptions,
  type AppVaultRecordSummary,
  type AppVaultSecretBroker,
} from "./contracts.js";
import { AppVaultError } from "./errors.js";
import { APP_VAULT_SLOTS, appVaultReferenceForSlot, appVaultSlot, type AppVaultSlotId } from "./slots.js";
import {
  createAppVaultSecretBrokerInternal,
  describeVaultSnapshotInternal,
  forgetVaultRecordInternal,
  markManagedReplace,
  markManagedRevoke,
  parseManagerOptions,
  rebindVaultInternal,
  restoreVaultBackupInternal,
  startVaultOverInternal,
  takeManagedResult,
} from "./broker.js";

function exactInput(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== "object" || value === null || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("invalid-object");
    const actual = Reflect.ownKeys(value);
    if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) throw new Error("invalid-keys");
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) throw new Error("invalid-field");
      output[key] = descriptor.value;
    }
    return output;
  } catch { throw new AppVaultError("INVALID_CONFIGURATION", "The vault manager request is invalid."); }
}

function revision(value: unknown, nullable: boolean): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new AppVaultError("VAULT_REVISION_CONFLICT", "The expected vault revision is invalid.");
  return value;
}

export function createAppVaultManagerInternal(options: AppVaultManagerOptions & { readonly random: NonNullable<AppVaultManagerOptions["random"]> }): AppVaultManager {
  const brokers = new Map<AppVaultSlotId, AppVaultSecretBroker>();
  for (const slot of APP_VAULT_SLOTS) {
    brokers.set(slot.slotId, createAppVaultSecretBrokerInternal(Object.freeze({
      schemaVersion: APP_VAULT_BROKER_SCHEMA_VERSION,
      reference: appVaultReferenceForSlot(slot.slotId),
      appIdentity: options.appIdentity,
      clock: options.clock,
      crypto: options.crypto,
      storage: options.storage,
      random: options.random,
      ...(options.audit === undefined ? {} : { audit: options.audit }),
    })));
  }
  let sequence = 0;
  let closed = false;
  let active = 0;
  let closePromise: Promise<void> | null = null;
  let idleWaiters: Array<() => void> = [];

  function assertManagerOpen(): void {
    if (closed) throw new AppVaultError("BROKER_CLOSED", "The app-vault manager is closed.");
  }

  function leave(): void {
    active -= 1;
    if (active === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  async function run<T>(operation: () => Promise<T>): Promise<T> {
    assertManagerOpen();
    active += 1;
    try { return await operation(); }
    finally { leave(); }
  }

  async function awaitIdle(): Promise<void> {
    if (active > 0) await new Promise<void>((resolve) => { idleWaiters.push(resolve); });
  }

  function brokerFor(value: unknown): { slotId: AppVaultSlotId; broker: AppVaultSecretBroker } {
    assertManagerOpen();
    const slot = appVaultSlot(value);
    return { slotId: slot.slotId, broker: brokers.get(slot.slotId)! };
  }

  function context(slotId: AppVaultSlotId, operation: "create" | "rotate" | "remove"): SecretAccessContext {
    sequence += 1;
    const operationId = `credential-${operation}.${slotId}.${sequence}`;
    return parseSecretAccessContext({
      operationId,
      providerInstanceId: appVaultSlot(slotId).providerInstanceId,
      purpose: "provider-authentication",
      requestedLifetimeMs: 30_000,
      accessForm: "text",
      classification: "internal",
      projectId: null,
      taskId: null,
      approvalEvidenceRefs: [],
      disclosureDecisionFingerprint: null,
      locality: "local",
      trace: { traceId: `${operationId}.trace`, runId: null, taskId: null, taskRunId: null },
      deadline: null,
      signal: undefined,
    });
  }

  async function replace(value: unknown, mode: "create" | "rotate"): Promise<AppVaultRecordSummary> {
    const data = exactInput(value, ["slotId", "secret", "expectRevision"]);
    const { slotId, broker } = brokerFor(data["slotId"]);
    if (typeof data["secret"] !== "string") throw new AppVaultError("SECRET_INVALID_CHARACTERS", "The credential must be text.");
    const expectedRevision = revision(data["expectRevision"], mode === "create");
    if (mode === "rotate" && expectedRevision === null) throw new AppVaultError("VAULT_REVISION_CONFLICT", "Rotation requires an expected revision.");
    const material = Object.freeze({ kind: "text" as const, text: data["secret"] });
    markManagedReplace(material, Object.freeze({ mode, expectedRevision }));
    await broker.replace(appVaultReferenceForSlot(slotId), material, context(slotId, mode));
    return takeManagedResult(material);
  }

  return Object.freeze({
    describeSnapshot: () => run(() => describeVaultSnapshotInternal(options)),
    describeSlots: () => run(async () => (await describeVaultSnapshotInternal(options)).slots),
    create: (input: Parameters<AppVaultManager["create"]>[0]) => run(() => replace(input, "create")),
    rotate: (input: Parameters<AppVaultManager["rotate"]>[0]) => run(() => replace(input, "rotate")),
    remove: (input: Parameters<AppVaultManager["remove"]>[0]) => run(async () => {
      const data = exactInput(input, ["slotId", "expectRevision"]);
      const { slotId, broker } = brokerFor(data["slotId"]);
      const expectedRevision = revision(data["expectRevision"], false)!;
      const operationContext = context(slotId, "remove");
      markManagedRevoke(operationContext, expectedRevision);
      await broker.revoke(appVaultReferenceForSlot(slotId), operationContext);
      return takeManagedResult(operationContext);
    }),
    forget: (input: Parameters<AppVaultManager["forget"]>[0]) => run(async () => {
      const data = exactInput(input, ["slotId", "expectRevision"]);
      const { slotId } = brokerFor(data["slotId"]);
      return await forgetVaultRecordInternal(options, slotId, revision(data["expectRevision"], false)!);
    }),
    restoreBackup: (input: Parameters<AppVaultManager["restoreBackup"]>[0]) => run(async () => {
      const data = exactInput(input, ["expectPrimaryDigest", "expectBackupDigest"]);
      return await restoreVaultBackupInternal(options, data["expectPrimaryDigest"], data["expectBackupDigest"]);
    }),
    startOver: (input: Parameters<AppVaultManager["startOver"]>[0]) => run(async () => {
      const data = exactInput(input, ["expectPrimaryDigest", "expectBackupDigest"]);
      return await startVaultOverInternal(options, data["expectPrimaryDigest"], data["expectBackupDigest"]);
    }),
    rebind: (input: Parameters<AppVaultManager["rebind"]>[0]) => run(async () => {
      const data = exactInput(input, ["expectPrimaryDigest"]);
      return await rebindVaultInternal(options, data["expectPrimaryDigest"]);
    }),
    async close() {
      if (closePromise !== null) return closePromise;
      closed = true;
      closePromise = (async () => {
        await awaitIdle();
        await Promise.all([...brokers.values()].map((broker) => broker.close()));
      })();
      return closePromise;
    },
  });
}

export function createAppVaultManagerForTesting(options: unknown): AppVaultManager {
  return createAppVaultManagerInternal(parseManagerOptions(options));
}

export function createAppVaultManager(options: unknown): AppVaultManager {
  return createAppVaultManagerInternal(parseManagerOptions(options));
}
