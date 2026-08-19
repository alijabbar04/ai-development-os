import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { types } from "node:util";
import {
  SecretBrokerError,
  createSecretMaterial,
  parseSecretAccessContext,
  secretRefFingerprint,
  type SecretAccessContext,
  type SecretAuditOperation,
  type SecretAuditOutcome,
  type SecretAuditRecord,
  type SecretBrokerCapabilities,
  type SecretMaterial,
  type SecretRef,
} from "@ai-dev-os/secrets";
import {
  APP_VAULT_BROKER_SCHEMA_VERSION,
  APP_VAULT_MAX_CIPHER_TEXT_CHARS,
  APP_VAULT_MAX_DOCUMENT_BYTES,
  APP_VAULT_MAX_SECRET_BYTES,
  type AppVaultBrokerOptions,
  type AppVaultClockPort,
  type AppVaultCryptoPort,
  type AppVaultManagerOptions,
  type AppVaultRandomPort,
  type AppVaultRecordSummary,
  type AppVaultRecoveryAction,
  type AppVaultSnapshot,
  type AppVaultSecretBroker,
  type AppVaultStoragePort,
  type AppVaultTestingOptions,
} from "./contracts.js";
import {
  createEmptyVaultDocument,
  parseVaultDocument,
  parseVaultDocumentUnbound,
  serializeVaultDocument,
  vaultCipherBytes,
  withVaultIntegrity,
  type AppVaultDocument,
  type AppVaultRecord,
} from "./document.js";
import { APP_VAULT_ERROR_CODES, AppVaultError, isAppVaultError, type AppVaultErrorCode } from "./errors.js";
import { APP_VAULT_SLOTS, appVaultSlot, type AppVaultSlotId } from "./slots.js";
import {
  appVaultContainerBinding,
  exactAppVaultReference,
  parseAppVaultReference,
} from "./target.js";

const CAPABILITIES: SecretBrokerCapabilities = Object.freeze({
  resolve: true,
  availability: true,
  replace: true,
  revoke: true,
  versions: false,
  kinds: Object.freeze(["text"] as const),
});

type MutationMode = "create" | "rotate" | "upsert";
type ManagedIntent = Readonly<{ mode: MutationMode; expectedRevision: number | null }>;
const managedReplaceIntent = new WeakMap<object, ManagedIntent>();
const managedRevokeIntent = new WeakMap<object, Readonly<{ expectedRevision: number }>>();
const managedResults = new WeakMap<object, AppVaultRecordSummary>();

export function markManagedReplace(material: object, intent: ManagedIntent): void {
  managedReplaceIntent.set(material, intent);
}

export function markManagedRevoke(context: object, expectedRevision: number): void {
  managedRevokeIntent.set(context, Object.freeze({ expectedRevision }));
}

export function takeManagedResult(key: object): AppVaultRecordSummary {
  const result = managedResults.get(key);
  managedResults.delete(key);
  if (result === undefined) throw new AppVaultError("STORAGE_FAILURE", "The managed vault operation did not produce a result.");
  return result;
}

const mutationTails = new WeakMap<AppVaultStoragePort, Promise<void>>();

async function serializeForContainer<T>(storage: AppVaultStoragePort, work: () => Promise<T>): Promise<T> {
  const prior = mutationTails.get(storage) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  mutationTails.set(storage, current);
  await prior;
  try { return await work(); }
  finally {
    release();
    if (mutationTails.get(storage) === current) mutationTails.delete(storage);
  }
}

function plainObject(value: unknown, path: string): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== "object" || value === null || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("invalid");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new Error("invalid");
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) throw new Error("invalid");
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    throw new SecretBrokerError("INVALID_REFERENCE", `${path} must be a plain data object.`);
  }
}

function exactKeys(record: Readonly<Record<string, unknown>>, allowed: readonly string[], required: readonly string[], path: string): void {
  const keys = Object.keys(record);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) {
    throw new SecretBrokerError("INVALID_REFERENCE", `${path} has an invalid key set.`);
  }
}

function exactPortData(value: unknown, keys: readonly string[], code: AppVaultErrorCode, message: string): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== "object" || value === null || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("invalid-object");
    const actual = Reflect.ownKeys(value);
    if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) throw new Error("invalid-keys");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) throw new Error("invalid-field");
      output[key] = descriptor.value;
    }
    return output;
  } catch { throw new AppVaultError(code, message); }
}

function isByteView(value: unknown): value is Uint8Array {
  try { return typeof value === "object" && value !== null && !types.isProxy(value) && value instanceof Uint8Array; }
  catch { return false; }
}

function zeroPossible(value: unknown): void {
  if (!isByteView(value)) return;
  try { Reflect.apply(Uint8Array.prototype.fill, value, [0]); }
  catch { /* best effort for detached or hostile foreign storage */ }
}

function copyByteView(value: unknown, code: AppVaultErrorCode, message: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): Uint8Array {
  try {
    if (!isByteView(value) || Object.getOwnPropertyDescriptor(value, "length") !== undefined || Object.getOwnPropertyDescriptor(value, "byteLength") !== undefined) throw new Error("invalid-view");
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
    const byteLength = Reflect.get(typedArrayPrototype, "byteLength", value) as number;
    if (!Number.isSafeInteger(byteLength) || byteLength < minimum || byteLength > maximum) throw new Error("invalid-length");
    const owned = new Uint8Array(byteLength);
    Reflect.apply(Uint8Array.prototype.set, owned, [value]);
    return owned;
  } catch { throw new AppVaultError(code, message); }
}

function foreignVaultCode(value: unknown): AppVaultErrorCode | null {
  try {
    if (!(value instanceof AppVaultError) || types.isProxy(value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, "code");
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      && (APP_VAULT_ERROR_CODES as readonly string[]).includes(descriptor.value)
      ? descriptor.value as AppVaultErrorCode
      : null;
  } catch { return null; }
}

function method<T extends (...args: never[]) => unknown>(value: unknown, name: string): T {
  if (typeof value !== "object" || value === null || types.isProxy(value)) throw new SecretBrokerError("INVALID_REFERENCE", `${name} port is invalid.`);
  const own = Object.getOwnPropertyDescriptor(value, name);
  const prototype = Object.getPrototypeOf(value) as object | null;
  const descriptor = own ?? (prototype === null ? undefined : Object.getOwnPropertyDescriptor(prototype, name));
  if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "function") throw new SecretBrokerError("INVALID_REFERENCE", `${name} port method is invalid.`);
  const callable = descriptor.value as (...args: unknown[]) => unknown;
  return ((...args: unknown[]) => Reflect.apply(callable, value, args)) as unknown as T;
}

function parseClock(value: unknown): AppVaultClockPort {
  const now = method<AppVaultClockPort["now"]>(value, "now");
  return Object.freeze({ now: () => now() });
}

function parseCrypto(value: unknown): AppVaultCryptoPort {
  const isAvailable = method<AppVaultCryptoPort["isAvailable"]>(value, "isAvailable");
  const encrypt = method<AppVaultCryptoPort["encrypt"]>(value, "encrypt");
  const decrypt = method<AppVaultCryptoPort["decrypt"]>(value, "decrypt");
  const describeBackend = method<AppVaultCryptoPort["describeBackend"]>(value, "describeBackend");
  let backendValue: unknown;
  try { backendValue = describeBackend(); }
  catch { throw new SecretBrokerError("INVALID_REFERENCE", "The crypto backend description failed."); }
  let backend: Readonly<Record<string, unknown>>;
  try {
    backend = plainObject(backendValue, "crypto backend");
    exactKeys(backend, ["kind"], ["kind"], "crypto backend");
  } catch { throw new SecretBrokerError("INVALID_REFERENCE", "The crypto backend description is invalid."); }
  if (backend["kind"] !== "electron-safe-storage-async" && backend["kind"] !== "deterministic-fake") throw new SecretBrokerError("INVALID_REFERENCE", "The crypto backend kind is invalid.");
  const kind = backend["kind"];
  return Object.freeze({ isAvailable, encrypt, decrypt, describeBackend: () => Object.freeze({ kind }) });
}

const storageProjections = new WeakMap<object, AppVaultStoragePort>();

function parseStorage(value: unknown): AppVaultStoragePort {
  if (typeof value !== "object" || value === null) throw new SecretBrokerError("INVALID_REFERENCE", "The storage port is invalid.");
  const existing = storageProjections.get(value);
  if (existing !== undefined) return existing;
  const projection = Object.freeze({
    read: method<AppVaultStoragePort["read"]>(value, "read"),
    readBackup: method<AppVaultStoragePort["readBackup"]>(value, "readBackup"),
    writeAtomic: method<AppVaultStoragePort["writeAtomic"]>(value, "writeAtomic"),
    recoverAtomic: method<AppVaultStoragePort["recoverAtomic"]>(value, "recoverAtomic"),
  });
  storageProjections.set(value, projection);
  return projection;
}

function parseRandom(value: unknown): AppVaultRandomPort {
  if (value === undefined) return Object.freeze({ bytes: (length: number) => new Uint8Array(randomBytes(length)) });
  return Object.freeze({ bytes: method<AppVaultRandomPort["bytes"]>(value, "bytes") });
}

export interface ParsedAppVaultOptions extends AppVaultBrokerOptions {
  readonly random: AppVaultRandomPort;
  readonly onZero?: AppVaultTestingOptions["onZero"];
}

export type ParsedAppVaultRuntimeOptions = Omit<ParsedAppVaultOptions, "reference">;

export function parseBrokerOptions(value: unknown, testing = false): ParsedAppVaultOptions {
  const record = plainObject(value, "options");
  const allowed = ["schemaVersion", "reference", "appIdentity", "clock", "crypto", "storage", "random", "audit", ...(testing ? ["onZero"] : [])];
  exactKeys(record, allowed, ["schemaVersion", "reference", "appIdentity", "clock", "crypto", "storage"], "options");
  if (record["schemaVersion"] !== APP_VAULT_BROKER_SCHEMA_VERSION) throw new SecretBrokerError("INVALID_REFERENCE", "The app-vault options schema is unsupported.");
  const reference = parseAppVaultReference(record["reference"], "options.reference");
  const identity = plainObject(record["appIdentity"], "options.appIdentity");
  exactKeys(identity, ["name", "appDataPath"], ["name", "appDataPath"], "options.appIdentity");
  if (typeof identity["name"] !== "string" || typeof identity["appDataPath"] !== "string") throw new SecretBrokerError("INVALID_REFERENCE", "The app identity is invalid.");
  const audit = record["audit"];
  if (audit !== undefined && typeof audit !== "function") throw new SecretBrokerError("INVALID_REFERENCE", "The audit hook is invalid.");
  const onZero = record["onZero"];
  if (onZero !== undefined && typeof onZero !== "function") throw new SecretBrokerError("INVALID_REFERENCE", "The zero hook is invalid.");
  return Object.freeze({
    schemaVersion: APP_VAULT_BROKER_SCHEMA_VERSION,
    reference,
    appIdentity: Object.freeze({ name: identity["name"], appDataPath: identity["appDataPath"] }),
    clock: parseClock(record["clock"]),
    crypto: parseCrypto(record["crypto"]),
    storage: parseStorage(record["storage"]),
    random: parseRandom(record["random"]),
    ...(audit === undefined ? {} : { audit: audit as NonNullable<AppVaultBrokerOptions["audit"]> }),
    ...(onZero === undefined ? {} : { onZero: onZero as NonNullable<AppVaultTestingOptions["onZero"]> }),
  });
}

export function parseManagerOptions(value: unknown): AppVaultManagerOptions & { readonly random: AppVaultRandomPort } {
  const record = plainObject(value, "options");
  exactKeys(record, ["schemaVersion", "appIdentity", "clock", "crypto", "storage", "random", "audit"], ["schemaVersion", "appIdentity", "clock", "crypto", "storage"], "options");
  const synthetic = {
    ...record,
    reference: Object.freeze({ schemaVersion: 1, type: "encrypted-file", namespace: "provider", version: null, expectedKind: "text", providerInstanceId: "anthropic-default", containerId: "app-vault.v1", entryName: "anthropic" }),
  };
  const parsed = parseBrokerOptions(synthetic);
  return Object.freeze({
    schemaVersion: APP_VAULT_BROKER_SCHEMA_VERSION,
    appIdentity: parsed.appIdentity,
    clock: parsed.clock,
    crypto: parsed.crypto,
    storage: parsed.storage,
    random: parsed.random,
    ...(parsed.audit === undefined ? {} : { audit: parsed.audit }),
  });
}

function now(clock: AppVaultClockPort): string {
  try {
    const value = clock.now();
    if (
      !(value instanceof Date)
      || Object.prototype.hasOwnProperty.call(value, "valueOf")
      || Object.prototype.hasOwnProperty.call(value, "toISOString")
    ) throw new Error("invalid");
    const milliseconds = Date.prototype.valueOf.call(value);
    if (!Number.isFinite(milliseconds)) throw new Error("invalid");
    return Date.prototype.toISOString.call(value);
  } catch { throw new SecretBrokerError("AUDIT_FAILURE", "The app-vault clock failed."); }
}

function parseContext(value: SecretAccessContext, clock: AppVaultClockPort): SecretAccessContext {
  let context: SecretAccessContext;
  try { context = parseSecretAccessContext(value); }
  catch { throw new SecretBrokerError("INVALID_REFERENCE", "The secret access context is invalid."); }
  const current = now(clock);
  if (context.deadline !== null && current >= context.deadline) throw new SecretBrokerError("RESOLUTION_TIMEOUT", "The app-vault operation timed out.");
  try { if (context.signal?.aborted === true) throw new SecretBrokerError("RESOLUTION_TIMEOUT", "The app-vault operation was cancelled."); }
  catch (error) { if (error instanceof SecretBrokerError) throw error; throw new SecretBrokerError("RESOLUTION_TIMEOUT", "The app-vault cancellation state is unavailable."); }
  return context;
}

function normalizedSecret(value: unknown): string {
  if (typeof value !== "string") throw new AppVaultError("SECRET_INVALID_CHARACTERS", "The credential must be text.");
  const normalized = value.trim();
  if (normalized.length === 0) throw new AppVaultError("SECRET_EMPTY", "The credential cannot be empty.");
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(normalized) || /[\uD800-\uDFFF]/u.test(normalized)) throw new AppVaultError("SECRET_INVALID_CHARACTERS", "The credential contains unsupported characters.");
  const sizeBytes = new TextEncoder().encode(normalized);
  try {
    if (sizeBytes.byteLength > APP_VAULT_MAX_SECRET_BYTES) throw new AppVaultError("SECRET_TOO_LARGE", "The credential exceeds the maximum size.");
  } finally { zeroPossible(sizeBytes); }
  return normalized;
}

function summary(slotId: AppVaultSlotId, record: AppVaultRecord | undefined, revision: number | null): AppVaultRecordSummary {
  if (record === undefined) return Object.freeze({ slotId, state: "absent", revision, generation: null, createdAt: null, rotatedAt: null, revokedAt: null, lastValidation: null });
  return Object.freeze({
    slotId,
    state: record.state,
    revision,
    generation: record.generation,
    createdAt: record.createdAt,
    rotatedAt: record.rotatedAt,
    revokedAt: record.revokedAt,
    lastValidation: record.lastValidation,
  });
}

function vaultError(error: unknown, fallback: AppVaultErrorCode): AppVaultError {
  return isAppVaultError(error) ? error : new AppVaultError(fallback, "The app-vault backend operation failed.");
}

function publicError(error: unknown): SecretBrokerError {
  const finite = vaultError(error, "STORAGE_FAILURE");
  const map: Record<AppVaultErrorCode, ConstructorParameters<typeof SecretBrokerError>[0]> = {
    VAULT_ABSENT: "NOT_FOUND", RECORD_ABSENT: "NOT_FOUND", SLOT_NOT_PRESENT: "NOT_FOUND",
    RECORD_REVOKED: "REVOKED", RECORD_UNRECOVERABLE: "UNAVAILABLE", VAULT_CORRUPT: "MALFORMED_BACKEND_RESPONSE",
    VAULT_IDENTITY_MISMATCH: "ACCESS_DENIED", VAULT_BACKEND_MISMATCH: "ACCESS_DENIED", VAULT_SCHEMA_AHEAD: "UNSUPPORTED_OPERATION",
    VAULT_UNKNOWN_SLOT: "MALFORMED_BACKEND_RESPONSE", VAULT_BACKUP_ONLY: "UNAVAILABLE",
    VAULT_REVISION_CONFLICT: "BACKEND_FAILURE", VAULT_BUSY: "BACKEND_FAILURE", ENCRYPTION_UNAVAILABLE: "UNAVAILABLE",
    APP_NOT_READY: "UNAVAILABLE", PLATFORM_UNSUPPORTED: "UNAVAILABLE", ENCRYPT_FAILED: "BACKEND_FAILURE", DECRYPT_FAILED: "UNAVAILABLE",
    MALFORMED_CRYPTO_RESPONSE: "MALFORMED_BACKEND_RESPONSE",
    SECRET_TOO_LARGE: "INVALID_REFERENCE", SECRET_EMPTY: "INVALID_REFERENCE", SECRET_INVALID_CHARACTERS: "INVALID_REFERENCE",
    SLOT_OCCUPIED: "INVALID_REFERENCE", SLOT_UNKNOWN: "INVALID_REFERENCE", INVALID_CONFIGURATION: "INVALID_REFERENCE",
    STORAGE_FAILURE: "BACKEND_FAILURE", MIGRATION_GAP: "UNSUPPORTED_OPERATION", BROKER_CLOSED: "BROKER_CLOSED",
  };
  return new SecretBrokerError(map[finite.code], finite.message, { vaultCode: finite.code });
}

function zero(bytes: Uint8Array, stage: Parameters<NonNullable<AppVaultTestingOptions["onZero"]>>[0]["stage"], hook?: AppVaultTestingOptions["onZero"]): void {
  try { bytes.fill(0); } catch { /* best effort */ }
  if (hook !== undefined) {
    try { hook(Object.freeze({ stage, byteLength: bytes.byteLength, allZero: bytes.every((byte) => byte === 0) })); }
    catch { /* a testing observer cannot change production cleanup semantics */ }
  }
}

async function readStorageBytes(storage: AppVaultStoragePort, backup: boolean): Promise<Uint8Array | null> {
  let value: unknown;
  try { value = await (backup ? storage.readBackup() : storage.read()); }
  catch (error) {
    if (foreignVaultCode(error) === "VAULT_CORRUPT") throw new AppVaultError("VAULT_CORRUPT", backup ? "The vault backup is unreadable or corrupt." : "The app-vault document is unreadable or corrupt.");
    throw new AppVaultError("STORAGE_FAILURE", backup ? "The vault backup could not be read." : "The vault document could not be read.");
  }
  if (value === null) return null;
  const result = exactPortData(value, ["bytes"], "STORAGE_FAILURE", backup ? "The vault backup returned an invalid response." : "The vault storage returned an invalid response.");
  return copyByteView(result["bytes"], "VAULT_CORRUPT", backup ? "The vault backup is unreadable or corrupt." : "The app-vault document is unreadable or corrupt.", 1, APP_VAULT_MAX_DOCUMENT_BYTES);
}

async function writeStorage(storage: AppVaultStoragePort, bytes: Uint8Array, expectedRevision: number | null): Promise<number> {
  let value: unknown;
  try { value = await storage.writeAtomic(Object.freeze({ bytes, expectedRevision })); }
  catch (error) {
    const code = foreignVaultCode(error);
    if (code === "VAULT_REVISION_CONFLICT") throw new AppVaultError("VAULT_REVISION_CONFLICT", "The vault changed before the atomic commit.");
    if (code === "VAULT_BUSY") throw new AppVaultError("VAULT_BUSY", "Another vault writer is active.");
    if (code === "VAULT_BACKUP_ONLY") throw new AppVaultError("VAULT_BACKUP_ONLY", "A backup exists without its primary vault and requires an explicit recovery choice.");
    if (code === "VAULT_CORRUPT" || code === "VAULT_IDENTITY_MISMATCH" || code === "VAULT_BACKEND_MISMATCH" || code === "VAULT_SCHEMA_AHEAD" || code === "VAULT_UNKNOWN_SLOT") throw new AppVaultError(code, "The existing vault cannot be safely overwritten.");
    throw new AppVaultError("STORAGE_FAILURE", "The atomic vault write failed.");
  }
  const result = exactPortData(value, ["revision"], "STORAGE_FAILURE", "The vault storage returned an invalid write response.");
  const revision = result["revision"];
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) throw new AppVaultError("STORAGE_FAILURE", "The vault storage returned an invalid write response.");
  return revision;
}

async function recoverStorage(
  storage: AppVaultStoragePort,
  input: Readonly<{
    mode: AppVaultRecoveryAction;
    bytes: Uint8Array;
    expectedPrimaryDigest: string | null;
    expectedBackupDigest: string | null;
  }>,
): Promise<number> {
  let value: unknown;
  try { value = await storage.recoverAtomic(input); }
  catch (error) {
    const code = foreignVaultCode(error);
    if (code === "VAULT_REVISION_CONFLICT") throw new AppVaultError("VAULT_REVISION_CONFLICT", "The vault changed before the explicit recovery commit.");
    if (code === "VAULT_BUSY") throw new AppVaultError("VAULT_BUSY", "Another vault writer is active.");
    throw new AppVaultError("STORAGE_FAILURE", "The explicit vault recovery commit failed.");
  }
  const result = exactPortData(value, ["revision"], "STORAGE_FAILURE", "The vault storage returned an invalid recovery response.");
  const revision = result["revision"];
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) throw new AppVaultError("STORAGE_FAILURE", "The vault storage returned an invalid recovery response.");
  return revision;
}

async function encryptWithPort(crypto: AppVaultCryptoPort, plainText: string): Promise<Uint8Array> {
  let value: unknown;
  try { value = await crypto.encrypt(plainText); }
  catch { throw new AppVaultError("ENCRYPT_FAILED", "The credential could not be encrypted."); }
  try { return copyByteView(value, "ENCRYPT_FAILED", "The encryption backend returned malformed ciphertext."); }
  finally { zeroPossible(value); }
}

async function decryptWithPort(crypto: AppVaultCryptoPort, cipher: Uint8Array): Promise<Readonly<{ result: string; shouldReEncrypt: boolean }>> {
  let value: unknown;
  try { value = await crypto.decrypt(cipher); }
  catch { throw new AppVaultError("DECRYPT_FAILED", "The credential could not be decrypted."); }
  const result = exactPortData(value, ["result", "shouldReEncrypt"], "MALFORMED_CRYPTO_RESPONSE", "The encryption backend returned a malformed decryption result.");
  if (typeof result["result"] !== "string" || typeof result["shouldReEncrypt"] !== "boolean") throw new AppVaultError("MALFORMED_CRYPTO_RESPONSE", "The encryption backend returned a malformed decryption result.");
  return Object.freeze({ result: result["result"], shouldReEncrypt: result["shouldReEncrypt"] });
}

function randomWithPort(random: AppVaultRandomPort, length: number): Uint8Array {
  let value: unknown;
  try { value = random.bytes(length); }
  catch { throw new AppVaultError("ENCRYPT_FAILED", "The credential fingerprint salt source failed."); }
  try { return copyByteView(value, "ENCRYPT_FAILED", "The credential fingerprint salt source failed.", length, length); }
  finally { zeroPossible(value); }
}

function bytesDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readDocument(options: ParsedAppVaultRuntimeOptions, binding: ReturnType<typeof appVaultContainerBinding>): Promise<AppVaultDocument | null> {
  const bytes = await readStorageBytes(options.storage, false);
  if (bytes === null) return null;
  return parseVaultDocument(bytes, binding);
}

async function encryptionAvailable(crypto: AppVaultCryptoPort): Promise<boolean> {
  let available: unknown;
  try {
    available = await crypto.isAvailable();
  } catch { throw new AppVaultError("ENCRYPTION_UNAVAILABLE", "Secure storage is temporarily unavailable."); }
  if (typeof available !== "boolean") throw new AppVaultError("ENCRYPTION_UNAVAILABLE", "Secure storage is temporarily unavailable.");
  return available;
}

function mutationDocument(
  current: AppVaultDocument | null,
  binding: ReturnType<typeof appVaultContainerBinding>,
  record: AppVaultRecord,
  occurredAt: string,
): AppVaultDocument {
  const base = current ?? createEmptyVaultDocument(binding, occurredAt);
  const records = [...base.records.filter((candidate) => candidate.slotId !== record.slotId), record]
    .sort((left, right) => left.slotId.localeCompare(right.slotId));
  return withVaultIntegrity(Object.freeze({
    schemaVersion: base.schemaVersion,
    containerId: base.containerId,
    revision: current === null ? 1 : current.revision + 1,
    containerBinding: base.containerBinding,
    backend: base.backend,
    createdAt: base.createdAt,
    updatedAt: occurredAt,
    records: Object.freeze(records),
  }));
}

function summaries(document: AppVaultDocument | null): readonly AppVaultRecordSummary[] {
  return Object.freeze(APP_VAULT_SLOTS.map((slot) => summary(
    slot.slotId,
    document?.records.find((record) => record.slotId === slot.slotId),
    document?.revision ?? null,
  )));
}

function recoveryDescriptor(
  primaryDigest: string | null,
  backupBytes: Uint8Array | null,
  backupDocument: AppVaultDocument | null,
  actions: readonly AppVaultRecoveryAction[],
): NonNullable<AppVaultSnapshot["recovery"]> {
  return Object.freeze({
    primaryDigest,
    backupDigest: backupBytes === null ? null : bytesDigest(backupBytes),
    backup: backupBytes === null || backupDocument === null ? null : Object.freeze({
      digest: bytesDigest(backupBytes),
      revision: backupDocument.revision,
      updatedAt: backupDocument.updatedAt,
    }),
    actions: Object.freeze([...actions]),
  });
}

function snapshotForDocument(document: AppVaultDocument): AppVaultSnapshot {
  return Object.freeze({
    vaultState: "ready" as const,
    issue: null,
    revision: document.revision,
    updatedAt: document.updatedAt,
    slots: summaries(document),
    recovery: null,
  });
}

async function backupCandidate(options: ParsedAppVaultRuntimeOptions, binding: ReturnType<typeof appVaultContainerBinding>): Promise<Readonly<{ bytes: Uint8Array | null; document: AppVaultDocument | null }>> {
  const bytes = await readStorageBytes(options.storage, true);
  if (bytes === null) return Object.freeze({ bytes: null, document: null });
  try { return Object.freeze({ bytes, document: parseVaultDocument(bytes, binding) }); }
  catch { return Object.freeze({ bytes, document: null }); }
}

export async function describeVaultSnapshotInternal(options: ParsedAppVaultRuntimeOptions): Promise<AppVaultSnapshot> {
  const binding = appVaultContainerBinding({ appIdentity: options.appIdentity, backendKind: options.crypto.describeBackend().kind });
  const primaryBytes = await readStorageBytes(options.storage, false);
  if (primaryBytes === null) {
    const backup = await backupCandidate(options, binding);
    if (backup.bytes === null) {
      return Object.freeze({ vaultState: "absent" as const, issue: null, revision: null, updatedAt: null, slots: summaries(null), recovery: null });
    }
    if (backup.document !== null) {
      return Object.freeze({
        vaultState: "backup-only" as const,
        issue: "VAULT_BACKUP_ONLY" as const,
        revision: null,
        updatedAt: null,
        slots: Object.freeze(summaries(backup.document).map((record) => Object.freeze({ ...record, revision: null }))),
        recovery: recoveryDescriptor(null, backup.bytes, backup.document, ["restore-backup", "start-over"]),
      });
    }
    return Object.freeze({
      vaultState: "corrupt" as const,
      issue: "VAULT_CORRUPT" as const,
      revision: null,
      updatedAt: null,
      slots: Object.freeze([]),
      recovery: recoveryDescriptor(null, backup.bytes, null, ["start-over"]),
    });
  }
  try { return snapshotForDocument(parseVaultDocument(primaryBytes, binding)); }
  catch (error) {
    const finite = vaultError(error, "VAULT_CORRUPT");
    const primaryDigest = bytesDigest(primaryBytes);
    if (finite.code === "VAULT_IDENTITY_MISMATCH" || finite.code === "VAULT_BACKEND_MISMATCH") {
      const unbound = parseVaultDocumentUnbound(primaryBytes);
      return Object.freeze({
        vaultState: finite.code === "VAULT_IDENTITY_MISMATCH" ? "identity-mismatch" as const : "backend-mismatch" as const,
        issue: finite.code,
        revision: unbound.revision,
        updatedAt: unbound.updatedAt,
        slots: summaries(unbound),
        recovery: recoveryDescriptor(primaryDigest, null, null, finite.code === "VAULT_IDENTITY_MISMATCH" ? ["rebind"] : []),
      });
    }
    if (finite.code === "VAULT_SCHEMA_AHEAD") {
      return Object.freeze({
        vaultState: "schema-ahead" as const,
        issue: finite.code,
        revision: null,
        updatedAt: null,
        slots: Object.freeze([]),
        recovery: recoveryDescriptor(primaryDigest, null, null, []),
      });
    }
    const backup = await backupCandidate(options, binding);
    return Object.freeze({
      vaultState: "corrupt" as const,
      issue: finite.code === "VAULT_UNKNOWN_SLOT" ? finite.code : "VAULT_CORRUPT" as const,
      revision: null,
      updatedAt: null,
      slots: Object.freeze([]),
      recovery: recoveryDescriptor(primaryDigest, backup.bytes, backup.document, backup.document === null ? ["start-over"] : ["restore-backup", "start-over"]),
    });
  }
}

function requireDigest(value: unknown, nullable: boolean): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new AppVaultError("INVALID_CONFIGURATION", "The vault recovery observation token is invalid.");
  return value;
}

async function observedRecoveryBytes(
  options: ParsedAppVaultRuntimeOptions,
  expectedPrimaryDigest: string | null,
  expectedBackupDigest: string | null,
): Promise<Readonly<{ primary: Uint8Array | null; backup: Uint8Array | null }>> {
  const primary = await readStorageBytes(options.storage, false);
  const backup = await readStorageBytes(options.storage, true);
  const actualPrimary = primary === null ? null : bytesDigest(primary);
  const actualBackup = backup === null ? null : bytesDigest(backup);
  if (actualPrimary !== expectedPrimaryDigest || actualBackup !== expectedBackupDigest) throw new AppVaultError("VAULT_REVISION_CONFLICT", "The vault changed after its recovery state was described.");
  return Object.freeze({ primary, backup });
}

function requireRestorablePrimary(primary: Uint8Array | null, binding: ReturnType<typeof appVaultContainerBinding>): void {
  if (primary === null) return;
  try { parseVaultDocument(primary, binding); }
  catch (error) {
    if (isAppVaultError(error) && (error.code === "VAULT_CORRUPT" || error.code === "VAULT_UNKNOWN_SLOT")) return;
    throw error;
  }
  throw new AppVaultError("INVALID_CONFIGURATION", "Backup restoration is available only for an eligible recovery state.");
}

export async function restoreVaultBackupInternal(options: ParsedAppVaultRuntimeOptions, primaryToken: unknown, backupToken: unknown): Promise<AppVaultSnapshot> {
  const expectedPrimaryDigest = requireDigest(primaryToken, true);
  const expectedBackupDigest = requireDigest(backupToken, false)!;
  const binding = appVaultContainerBinding({ appIdentity: options.appIdentity, backendKind: options.crypto.describeBackend().kind });
  await serializeForContainer(options.storage, async () => {
    const observed = await observedRecoveryBytes(options, expectedPrimaryDigest, expectedBackupDigest);
    requireRestorablePrimary(observed.primary, binding);
    const restored = parseVaultDocument(observed.backup!, binding);
    const revision = await recoverStorage(options.storage, Object.freeze({ mode: "restore-backup", bytes: serializeVaultDocument(restored), expectedPrimaryDigest, expectedBackupDigest }));
    if (revision !== restored.revision) throw new AppVaultError("STORAGE_FAILURE", "The vault recovery returned an invalid revision.");
  });
  return await describeVaultSnapshotInternal(options);
}

export async function startVaultOverInternal(options: ParsedAppVaultRuntimeOptions, primaryToken: unknown, backupToken: unknown): Promise<AppVaultSnapshot> {
  const expectedPrimaryDigest = requireDigest(primaryToken, true);
  const expectedBackupDigest = requireDigest(backupToken, true);
  const binding = appVaultContainerBinding({ appIdentity: options.appIdentity, backendKind: options.crypto.describeBackend().kind });
  await serializeForContainer(options.storage, async () => {
    const observed = await observedRecoveryBytes(options, expectedPrimaryDigest, expectedBackupDigest);
    if (observed.primary === null && observed.backup === null) throw new AppVaultError("INVALID_CONFIGURATION", "There is no recovery state to replace.");
    if (observed.primary !== null) {
      try { parseVaultDocument(observed.primary, binding); throw new AppVaultError("INVALID_CONFIGURATION", "A readable vault cannot be replaced by recovery."); }
      catch (error) {
        if (!isAppVaultError(error) || (error.code !== "VAULT_CORRUPT" && error.code !== "VAULT_UNKNOWN_SLOT")) throw error;
      }
    }
    const document = createEmptyVaultDocument(binding, now(options.clock));
    const revision = await recoverStorage(options.storage, Object.freeze({ mode: "start-over", bytes: serializeVaultDocument(document), expectedPrimaryDigest, expectedBackupDigest }));
    if (revision !== document.revision) throw new AppVaultError("STORAGE_FAILURE", "The vault recovery returned an invalid revision.");
  });
  return await describeVaultSnapshotInternal(options);
}

export async function rebindVaultInternal(options: ParsedAppVaultRuntimeOptions, primaryToken: unknown): Promise<AppVaultSnapshot> {
  const expectedPrimaryDigest = requireDigest(primaryToken, false)!;
  const binding = appVaultContainerBinding({ appIdentity: options.appIdentity, backendKind: options.crypto.describeBackend().kind });
  await serializeForContainer(options.storage, async () => {
    const primary = await readStorageBytes(options.storage, false);
    if (primary === null || bytesDigest(primary) !== expectedPrimaryDigest) throw new AppVaultError("VAULT_REVISION_CONFLICT", "The vault changed after its identity mismatch was described.");
    const foreign = parseVaultDocumentUnbound(primary);
    if (foreign.backend.kind !== binding.backendKind || foreign.containerBinding === binding.digest) throw new AppVaultError("INVALID_CONFIGURATION", "Only an identity-mismatched vault can be rebound.");
    const occurredAt = now(options.clock);
    const records = Object.freeze(foreign.records.map((record) => Object.freeze({
      ...record,
      state: "unrecoverable" as const,
      revokedAt: null,
      cipherText: null,
      cipherByteLength: null,
      keyFingerprint: null,
      keyFingerprintSalt: null,
      lastValidation: null,
    })));
    const rebound = withVaultIntegrity(Object.freeze({
      schemaVersion: foreign.schemaVersion,
      containerId: foreign.containerId,
      revision: foreign.revision + 1,
      containerBinding: binding.digest,
      backend: Object.freeze({ kind: binding.backendKind }),
      createdAt: foreign.createdAt,
      updatedAt: occurredAt,
      records,
    }));
    const revision = await recoverStorage(options.storage, Object.freeze({ mode: "rebind", bytes: serializeVaultDocument(rebound), expectedPrimaryDigest, expectedBackupDigest: null }));
    if (revision !== rebound.revision) throw new AppVaultError("STORAGE_FAILURE", "The vault recovery returned an invalid revision.");
  });
  return await describeVaultSnapshotInternal(options);
}

export async function forgetVaultRecordInternal(options: ParsedAppVaultRuntimeOptions, slotId: AppVaultSlotId, expectedRevision: number): Promise<AppVaultRecordSummary> {
  const binding = appVaultContainerBinding({ appIdentity: options.appIdentity, backendKind: options.crypto.describeBackend().kind });
  return await serializeForContainer(options.storage, async () => {
    const current = await readDocument(options, binding);
    if (current === null) throw new AppVaultError("VAULT_ABSENT", "The credential is not stored.");
    if (current.revision !== expectedRevision) throw new AppVaultError("VAULT_REVISION_CONFLICT", "The vault changed before the tombstone could be forgotten.");
    const previous = current.records.find((record) => record.slotId === slotId);
    if (previous === undefined) throw new AppVaultError("RECORD_ABSENT", "The credential is not stored.");
    if (previous.state !== "revoked") throw new AppVaultError("INVALID_CONFIGURATION", "Only a revoked credential tombstone can be forgotten.");
    const occurredAt = now(options.clock);
    const document = withVaultIntegrity(Object.freeze({
      schemaVersion: current.schemaVersion,
      containerId: current.containerId,
      revision: current.revision + 1,
      containerBinding: current.containerBinding,
      backend: current.backend,
      createdAt: current.createdAt,
      updatedAt: occurredAt,
      records: Object.freeze(current.records.filter((record) => record.slotId !== slotId)),
    }));
    const committed = await writeStorage(options.storage, serializeVaultDocument(document), current.revision);
    if (committed !== document.revision) throw new AppVaultError("STORAGE_FAILURE", "The vault storage returned an invalid revision.");
    return summary(slotId, undefined, document.revision);
  });
}

export function createAppVaultSecretBrokerInternal(options: ParsedAppVaultOptions): AppVaultSecretBroker {
  const reference = parseAppVaultReference(options.reference);
  const slotId = reference.entryName as AppVaultSlotId;
  const binding = appVaultContainerBinding({ appIdentity: options.appIdentity, backendKind: options.crypto.describeBackend().kind });
  const referenceAudit = `sha256:${secretRefFingerprint(reference)}`;
  const callbackScope = new AsyncLocalStorage<{ active: boolean }>();
  let closed = false;
  let active = 0;
  let closePromise: Promise<void> | null = null;
  let idleWaiters: Array<() => void> = [];
  let reencryptState: { cipherText: string; generation: number; failures: number; inFlight: boolean } | null = null;
  let decryptFailureState: { cipherText: string; generation: number; failures: number } | null = null;
  const maintenanceJobs = new Set<Promise<void>>();

  function audit(operation: SecretAuditOperation, phase: "attempt" | "outcome", outcome: SecretAuditOutcome | null, context: SecretAccessContext | null): SecretAuditRecord {
    const record = Object.freeze({
      schemaVersion: 1 as const,
      operation,
      phase,
      outcome,
      occurredAt: now(options.clock),
      reference: operation === "close" ? null : referenceAudit,
      operationId: context?.operationId ?? null,
      providerInstanceId: context?.providerInstanceId ?? null,
      purpose: context?.purpose ?? null,
      traceId: context?.trace.traceId ?? null,
    });
    try { options.audit?.(record); }
    catch { throw new SecretBrokerError("AUDIT_FAILURE", "The app-vault audit hook failed."); }
    return record;
  }

  function assertOpen(): void {
    if (closed) throw new SecretBrokerError("BROKER_CLOSED", "The app-vault broker is closed.");
  }
  function enter(): void { active += 1; }
  function leave(): void {
    active -= 1;
    if (active === 0) { const waiters = idleWaiters; idleWaiters = []; for (const resolve of waiters) resolve(); }
  }
  async function awaitIdle(): Promise<void> {
    if (active > 0) await new Promise<void>((resolve) => { idleWaiters.push(resolve); });
  }
  function boundary(context: SecretAccessContext): void {
    assertOpen();
    const current = now(options.clock);
    if (context.deadline !== null && current >= context.deadline) throw new SecretBrokerError("RESOLUTION_TIMEOUT", "The app-vault operation timed out.");
    try { if (context.signal?.aborted === true) throw new SecretBrokerError("RESOLUTION_TIMEOUT", "The app-vault operation was cancelled."); }
    catch (error) { if (error instanceof SecretBrokerError) throw error; throw new SecretBrokerError("RESOLUTION_TIMEOUT", "The app-vault cancellation state is unavailable."); }
  }
  function bind(rawReference: SecretRef, rawContext: SecretAccessContext): SecretAccessContext {
    let candidate;
    try { candidate = parseAppVaultReference(rawReference); }
    catch (error) { if (error instanceof SecretBrokerError) throw error; throw publicError(error); }
    if (!exactAppVaultReference(reference, candidate)) throw new SecretBrokerError("ACCESS_DENIED", "The secret reference is not allowlisted.");
    const context = parseContext(rawContext, options.clock);
    if (context.accessForm !== "text" || context.providerInstanceId !== reference.providerInstanceId) throw new SecretBrokerError("ACCESS_DENIED", "The secret access context does not match the app-vault reference.");
    return context;
  }
  function outcomeFor(error: SecretBrokerError): SecretAuditOutcome {
    if (error.code === "NOT_FOUND") return "not-found";
    if (error.code === "ACCESS_DENIED" || error.code === "INVALID_REFERENCE" || error.code === "KIND_MISMATCH") return "denied";
    if (error.code === "REVOKED") return "revoked";
    if (error.code === "UNSUPPORTED_OPERATION") return "unsupported";
    if (error.code === "BROKER_CLOSED") return "closed";
    return "failure";
  }
  function fail(operation: "availability" | "resolve" | "replace" | "revoke", context: SecretAccessContext, error: unknown): never {
    const finite = error instanceof SecretBrokerError ? error : publicError(error);
    audit(operation, "outcome", outcomeFor(finite), context);
    throw finite;
  }

  async function reencryptAfterResolution(record: AppVaultRecord, plainText: string): Promise<"committed" | "obsolete" | "failed"> {
    try {
      return await serializeForContainer(options.storage, async () => {
        if (!(await encryptionAvailable(options.crypto))) return "failed";
        const current = await readDocument(options, binding);
        const latest = current?.records.find((candidate) => candidate.slotId === slotId);
        if (current === null || latest?.state !== "present" || latest.generation !== record.generation || latest.cipherText !== record.cipherText) return "obsolete";
        const cipher = await encryptWithPort(options.crypto, plainText);
        try {
          if (!(cipher instanceof Uint8Array) || cipher.byteLength < 1 || Buffer.from(cipher).toString("base64url").length > APP_VAULT_MAX_CIPHER_TEXT_CHARS) return "failed";
          const updated: AppVaultRecord = Object.freeze({ ...latest, cipherText: Buffer.from(cipher).toString("base64url"), cipherByteLength: cipher.byteLength });
          const document = mutationDocument(current, binding, updated, current.updatedAt);
          const revision = await writeStorage(options.storage, serializeVaultDocument(document), current.revision);
          return revision === document.revision ? "committed" : "failed";
        } finally { zero(cipher, "cipher-bytes", options.onZero); }
      });
    } catch { return "failed"; }
  }

  function scheduleReencrypt(record: AppVaultRecord, plainText: string): void {
    if (record.cipherText === null) return;
    if (reencryptState === null || reencryptState.cipherText !== record.cipherText || reencryptState.generation !== record.generation) {
      reencryptState = { cipherText: record.cipherText, generation: record.generation, failures: 0, inFlight: false };
    }
    const state = reencryptState;
    if (state.inFlight || state.failures >= 2) return;
    state.inFlight = true;
    const job = reencryptAfterResolution(record, plainText).then((outcome) => {
      if (reencryptState !== state) return;
      if (outcome === "failed") {
        state.failures += 1;
        state.inFlight = false;
      } else {
        reencryptState = null;
      }
    });
    maintenanceJobs.add(job);
    void job.then(() => { maintenanceJobs.delete(job); });
  }

  async function markUnrecoverableAfterRepeatedDecryptFailure(record: AppVaultRecord): Promise<void> {
    await serializeForContainer(options.storage, async () => {
      const current = await readDocument(options, binding);
      const latest = current?.records.find((candidate) => candidate.slotId === slotId);
      if (current === null || latest?.state !== "present" || latest.generation !== record.generation || latest.cipherText !== record.cipherText) {
        decryptFailureState = null;
        return;
      }
      const occurredAt = now(options.clock);
      const unrecoverable: AppVaultRecord = Object.freeze({ ...latest, state: "unrecoverable" });
      const document = mutationDocument(current, binding, unrecoverable, occurredAt);
      const revision = await writeStorage(options.storage, serializeVaultDocument(document), current.revision);
      if (revision !== document.revision) throw new AppVaultError("STORAGE_FAILURE", "The vault storage returned an invalid revision.");
      decryptFailureState = null;
    });
  }

  async function recordDecryptFailure(record: AppVaultRecord): Promise<void> {
    if (record.cipherText === null) return;
    if (decryptFailureState === null || decryptFailureState.cipherText !== record.cipherText || decryptFailureState.generation !== record.generation) {
      decryptFailureState = { cipherText: record.cipherText, generation: record.generation, failures: 1 };
      return;
    }
    decryptFailureState.failures += 1;
    if (decryptFailureState.failures >= 2) {
      try { await markUnrecoverableAfterRepeatedDecryptFailure(record); }
      catch { decryptFailureState.failures = 1; }
    }
  }

  const broker: AppVaultSecretBroker = {
    describeCapabilities: () => CAPABILITIES,
    describeContainerBinding: () => binding,
    async describeRecord() {
      assertOpen(); enter();
      try {
        const document = await readDocument(options, binding);
        return summary(slotId, document?.records.find((record) => record.slotId === slotId), document?.revision ?? null);
      } finally { leave(); }
    },
    async availability(rawReference, rawContext) {
      assertOpen(); enter();
      try {
        const context = bind(rawReference, rawContext);
        audit("availability", "attempt", null, context);
        try {
          boundary(context);
          let available = false;
          try { available = await encryptionAvailable(options.crypto); }
          catch {
            const recordAudit = audit("availability", "outcome", "failure", context);
            return Object.freeze({ available: false, reason: "unavailable" as const, audit: recordAudit });
          }
          if (!available) {
            const recordAudit = audit("availability", "outcome", "failure", context);
            return Object.freeze({ available: false, reason: "unavailable" as const, audit: recordAudit });
          }
          boundary(context);
          let document: AppVaultDocument | null;
          try { document = await readDocument(options, binding); }
          catch {
            const recordAudit = audit("availability", "outcome", "failure", context);
            return Object.freeze({ available: false, reason: "unavailable" as const, audit: recordAudit });
          }
          const record = document?.records.find((candidate) => candidate.slotId === slotId);
          if (record === undefined) {
            const recordAudit = audit("availability", "outcome", "not-found", context);
            return Object.freeze({ available: false, reason: "not-found" as const, audit: recordAudit });
          }
          if (record.state === "revoked") {
            const recordAudit = audit("availability", "outcome", "revoked", context);
            return Object.freeze({ available: false, reason: "revoked" as const, audit: recordAudit });
          }
          if (record.state === "unrecoverable") {
            const recordAudit = audit("availability", "outcome", "failure", context);
            return Object.freeze({ available: false, reason: "unavailable" as const, audit: recordAudit });
          }
          boundary(context);
          const recordAudit = audit("availability", "outcome", "success", context);
          return Object.freeze({ available: true, reason: "available" as const, audit: recordAudit });
        } catch (error) { return fail("availability", context, error); }
      } finally { leave(); }
    },
    async withSecret<T>(rawReference: SecretRef, rawContext: SecretAccessContext, callback: (secret: SecretMaterial) => T | Promise<T>) {
      assertOpen();
      if (typeof callback !== "function") throw new SecretBrokerError("INVALID_REFERENCE", "The secret consumer callback is invalid.");
      enter();
      let material: ReturnType<typeof createSecretMaterial> | null = null;
      try {
        const context = bind(rawReference, rawContext);
        audit("resolve", "attempt", null, context);
        let decryptedBytes: Uint8Array | null = null;
        let cipherBytes: Uint8Array | null = null;
        try {
          boundary(context);
          const document = await readDocument(options, binding);
          const record = document?.records.find((candidate) => candidate.slotId === slotId);
          if (record === undefined) throw new AppVaultError(document === null ? "VAULT_ABSENT" : "RECORD_ABSENT", "The credential is not stored.");
          if (record.state === "revoked") throw new AppVaultError("RECORD_REVOKED", "The credential was revoked.");
          if (record.state === "unrecoverable") throw new AppVaultError("RECORD_UNRECOVERABLE", "The credential must be entered again.");
          boundary(context);
          if (!(await encryptionAvailable(options.crypto))) throw new AppVaultError("ENCRYPTION_UNAVAILABLE", "Secure storage is temporarily unavailable.");
          boundary(context);
          cipherBytes = vaultCipherBytes(record);
          let decrypted: Readonly<{ result: string; shouldReEncrypt: boolean }>;
          try { decrypted = await decryptWithPort(options.crypto, cipherBytes); }
          catch (error) {
            if (isAppVaultError(error) && error.code === "DECRYPT_FAILED") await recordDecryptFailure(record);
            throw error;
          }
          if (decryptFailureState?.cipherText === record.cipherText && decryptFailureState.generation === record.generation) decryptFailureState = null;
          boundary(context);
          const checked = normalizedSecret(decrypted.result);
          decryptedBytes = new TextEncoder().encode(checked);
          material = createSecretMaterial("text", decryptedBytes);
          const ownedPlainBytes = decryptedBytes; decryptedBytes = null;
          zero(ownedPlainBytes, "decrypted-bytes", options.onZero);
          const ownedCipherBytes = cipherBytes; cipherBytes = null;
          zero(ownedCipherBytes, "cipher-bytes", options.onZero);
          const scope = { active: true };
          let value: T;
          try { value = await callbackScope.run(scope, async () => callback(material!)); }
          catch {
            material.dispose(); material = null;
            audit("resolve", "outcome", "failure", context);
            throw new SecretBrokerError("CONSUMER_FAILURE", "The secret consumer callback failed.");
          } finally { scope.active = false; }
          material.dispose(); material = null;
          audit("resolve", "outcome", "success", context);
          if (decrypted.shouldReEncrypt) scheduleReencrypt(record, checked);
          return value;
        } catch (error) {
          if (error instanceof SecretBrokerError && error.code === "CONSUMER_FAILURE") throw error;
          return fail("resolve", context, error);
        } finally {
          if (decryptedBytes !== null) zero(decryptedBytes, "decrypted-bytes", options.onZero);
          if (cipherBytes !== null) zero(cipherBytes, "cipher-bytes", options.onZero);
        }
      } finally { material?.dispose(); leave(); }
    },
    async replace(rawReference, rawMaterial, rawContext) {
      assertOpen(); enter();
      try {
        const context = bind(rawReference, rawContext);
        audit("replace", "attempt", null, context);
        try {
          const data = plainObject(rawMaterial, "material");
          exactKeys(data, ["kind", "text", "bytes"], ["kind"], "material");
          if (data["kind"] !== "text" || typeof data["text"] !== "string" || data["bytes"] !== undefined) throw new AppVaultError("SECRET_INVALID_CHARACTERS", "The app vault accepts text credentials only.");
          const secret = normalizedSecret(data["text"]);
          const intent = managedReplaceIntent.get(rawMaterial as object) ?? Object.freeze({ mode: "upsert" as const, expectedRevision: null });
          const result = await serializeForContainer(options.storage, async () => {
            boundary(context);
            if (!(await encryptionAvailable(options.crypto))) throw new AppVaultError("ENCRYPTION_UNAVAILABLE", "Secure storage is temporarily unavailable.");
            const current = await readDocument(options, binding);
            if (current === null && await readStorageBytes(options.storage, true) !== null) throw new AppVaultError("VAULT_BACKUP_ONLY", "A backup exists without its primary vault and requires an explicit recovery choice.");
            const currentRevision = current?.revision ?? null;
            if (managedReplaceIntent.has(rawMaterial as object) && currentRevision !== intent.expectedRevision) throw new AppVaultError("VAULT_REVISION_CONFLICT", "The vault changed before the credential could be saved.");
            const previous = current?.records.find((candidate) => candidate.slotId === slotId);
            if (intent.mode === "create" && previous !== undefined) throw new AppVaultError("SLOT_OCCUPIED", "The credential slot is already occupied.");
            if (intent.mode === "rotate" && previous === undefined) throw new AppVaultError("SLOT_NOT_PRESENT", "The credential slot cannot be rotated because it is not present.");
            boundary(context);
            const cipher = await encryptWithPort(options.crypto, secret);
            let salt: Uint8Array | null = null;
            let plainBytes: Uint8Array | null = null;
            try {
              if (!(cipher instanceof Uint8Array) || cipher.byteLength < 1) throw new AppVaultError("ENCRYPT_FAILED", "The encryption backend returned malformed ciphertext.");
              const cipherText = Buffer.from(cipher).toString("base64url");
              if (cipherText.length > APP_VAULT_MAX_CIPHER_TEXT_CHARS) throw new AppVaultError("ENCRYPT_FAILED", "The encrypted credential exceeds the storage bound.");
              salt = randomWithPort(options.random, 32);
              plainBytes = new TextEncoder().encode(secret);
              const fingerprint = createHash("sha256").update(salt).update(plainBytes).digest("hex");
              const occurredAt = now(options.clock);
              const record: AppVaultRecord = Object.freeze({
                slotId,
                state: "present",
                generation: previous === undefined ? 1 : previous.generation + 1,
                createdAt: previous?.createdAt ?? occurredAt,
                rotatedAt: previous === undefined ? null : occurredAt,
                revokedAt: null,
                cipherText,
                cipherByteLength: cipher.byteLength,
                keyFingerprint: fingerprint,
                keyFingerprintSalt: Buffer.from(salt).toString("base64url"),
                lastValidation: null,
              });
              const document = mutationDocument(current, binding, record, occurredAt);
              boundary(context);
              const committedRevision = await writeStorage(options.storage, serializeVaultDocument(document), currentRevision);
              if (committedRevision !== document.revision) throw new AppVaultError("STORAGE_FAILURE", "The vault storage returned an invalid revision.");
              return summary(slotId, record, document.revision);
            } finally {
              if (plainBytes !== null) zero(plainBytes, "plain-text-bytes", options.onZero);
              if (salt !== null) zero(salt, "salt-bytes", options.onZero);
              zero(cipher, "cipher-bytes", options.onZero);
            }
          });
          if (managedReplaceIntent.has(rawMaterial as object)) managedResults.set(rawMaterial as object, result);
          return audit("replace", "outcome", "success", context);
        } catch (error) { return fail("replace", context, error); }
        finally { if (typeof rawMaterial === "object" && rawMaterial !== null) managedReplaceIntent.delete(rawMaterial); }
      } finally { leave(); }
    },
    async revoke(rawReference, rawContext) {
      assertOpen(); enter();
      try {
        const context = bind(rawReference, rawContext);
        audit("revoke", "attempt", null, context);
        try {
          const expected = managedRevokeIntent.get(rawContext as object)?.expectedRevision;
          const result = await serializeForContainer(options.storage, async () => {
            boundary(context);
            const current = await readDocument(options, binding);
            if (current === null) throw new AppVaultError("VAULT_ABSENT", "The credential is not stored.");
            if (expected !== undefined && current.revision !== expected) throw new AppVaultError("VAULT_REVISION_CONFLICT", "The vault changed before the credential could be removed.");
            const previous = current.records.find((candidate) => candidate.slotId === slotId);
            if (previous === undefined) throw new AppVaultError("RECORD_ABSENT", "The credential is not stored.");
            if (previous.state === "revoked") throw new AppVaultError("RECORD_REVOKED", "The credential was already revoked.");
            const occurredAt = now(options.clock);
            const record: AppVaultRecord = Object.freeze({
              ...previous,
              state: "revoked",
              revokedAt: occurredAt,
              cipherText: null,
              cipherByteLength: null,
              keyFingerprint: null,
              keyFingerprintSalt: null,
              lastValidation: null,
            });
            const document = mutationDocument(current, binding, record, occurredAt);
            boundary(context);
            const committedRevision = await writeStorage(options.storage, serializeVaultDocument(document), current.revision);
            if (committedRevision !== document.revision) throw new AppVaultError("STORAGE_FAILURE", "The vault storage returned an invalid revision.");
            return summary(slotId, record, document.revision);
          });
          if (managedRevokeIntent.has(rawContext as object)) managedResults.set(rawContext as object, result);
          return audit("revoke", "outcome", "success", context);
        } catch (error) { return fail("revoke", context, error); }
        finally { managedRevokeIntent.delete(rawContext as object); }
      } finally { leave(); }
    },
    async close() {
      if (callbackScope.getStore()?.active === true) throw new SecretBrokerError("UNSUPPORTED_OPERATION", "The app-vault broker cannot close inside a secret callback.");
      if (closePromise !== null) return closePromise;
      closed = true;
      let resolveClose!: () => void;
      let rejectClose!: (error: unknown) => void;
      closePromise = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
      void (async () => {
        let closeError: unknown = null;
        try { audit("close", "attempt", null, null); }
        catch (error) { closeError = error; }
        try { await awaitIdle(); }
        catch (error) { closeError ??= error; }
        try { await Promise.all([...maintenanceJobs]); }
        catch (error) { closeError ??= error; }
        if (closeError === null) {
          try { audit("close", "outcome", "closed", null); }
          catch (error) { closeError = error; }
        }
        if (closeError === null) resolveClose();
        else rejectClose(closeError);
      })();
      return closePromise;
    },
    toString: () => "[AppVaultSecretBroker]",
    toJSON: () => Object.freeze({ broker: "app-vault", reference: referenceAudit, capabilities: CAPABILITIES }),
    [Symbol.for("nodejs.util.inspect.custom")]: () => "[AppVaultSecretBroker]",
  } as AppVaultSecretBroker;
  return Object.freeze(broker);
}

export function createAppVaultSecretBrokerForTesting(options: unknown): AppVaultSecretBroker {
  return createAppVaultSecretBrokerInternal(parseBrokerOptions(options, true));
}

export function createAppVaultSecretBroker(options: unknown): AppVaultSecretBroker {
  return createAppVaultSecretBrokerInternal(parseBrokerOptions(options, false));
}
