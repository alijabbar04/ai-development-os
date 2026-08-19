import { createHash } from "node:crypto";
import { toCanonicalJson } from "@ai-dev-os/domain";
import {
  APP_VAULT_BACKEND_KINDS,
  APP_VAULT_CONTAINER_ID,
  APP_VAULT_DOCUMENT_SCHEMA_VERSION,
  APP_VAULT_MAX_CIPHER_TEXT_CHARS,
  APP_VAULT_MAX_DOCUMENT_BYTES,
  APP_VAULT_MAX_RECORDS,
  type AppVaultBackendKind,
  type AppVaultContainerBinding,
  type AppVaultRecordState,
  type AppVaultValidationOutcome,
} from "./contracts.js";
import { AppVaultError } from "./errors.js";
import { parseAppVaultSlotId, type AppVaultSlotId } from "./slots.js";

const HEX_64 = /^[a-f0-9]{64}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const VALIDATION_OUTCOMES = Object.freeze(["valid", "invalid", "unauthorized", "ambiguous", "unreachable"] as const);

export interface AppVaultRecord {
  readonly slotId: AppVaultSlotId;
  readonly state: AppVaultRecordState;
  readonly generation: number;
  readonly createdAt: string;
  readonly rotatedAt: string | null;
  readonly revokedAt: string | null;
  readonly cipherText: string | null;
  readonly cipherByteLength: number | null;
  readonly keyFingerprint: string | null;
  readonly keyFingerprintSalt: string | null;
  readonly lastValidation: Readonly<{ outcome: AppVaultValidationOutcome; checkedAt: string }> | null;
}

export interface AppVaultDocument {
  readonly schemaVersion: typeof APP_VAULT_DOCUMENT_SCHEMA_VERSION;
  readonly containerId: typeof APP_VAULT_CONTAINER_ID;
  readonly revision: number;
  readonly containerBinding: string;
  readonly backend: Readonly<{ kind: AppVaultBackendKind }>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly records: readonly AppVaultRecord[];
  readonly integrity: Readonly<{ algorithm: "sha256"; digest: string }>;
}

function corrupt(message = "The app-vault document is unreadable or corrupt."): AppVaultError {
  return new AppVaultError("VAULT_CORRUPT", message);
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw corrupt();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw corrupt();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) throw corrupt();
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) throw corrupt();
    output[key] = descriptor.value;
  }
  return output;
}

function safeInteger(value: unknown, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw corrupt();
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || value.length !== 24) throw corrupt();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) throw corrupt();
  return value;
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

function nullableHex(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !HEX_64.test(value)) throw corrupt();
  return value;
}

function decodeCipher(value: string): Uint8Array {
  if (value.length < 1 || value.length > APP_VAULT_MAX_CIPHER_TEXT_CHARS || !BASE64URL.test(value)) throw corrupt();
  const bytes = new Uint8Array(Buffer.from(value, "base64url"));
  if (Buffer.from(bytes).toString("base64url") !== value) throw corrupt();
  return bytes;
}

function parseValidation(value: unknown): AppVaultRecord["lastValidation"] {
  if (value === null) return null;
  const record = exactRecord(value, ["outcome", "checkedAt"]);
  if (typeof record["outcome"] !== "string" || !VALIDATION_OUTCOMES.includes(record["outcome"] as never)) throw corrupt();
  return Object.freeze({
    outcome: record["outcome"] as AppVaultValidationOutcome,
    checkedAt: timestamp(record["checkedAt"]),
  });
}

function parseRecord(value: unknown): AppVaultRecord {
  const record = exactRecord(value, [
    "slotId", "state", "generation", "createdAt", "rotatedAt", "revokedAt",
    "cipherText", "cipherByteLength", "keyFingerprint", "keyFingerprintSalt", "lastValidation",
  ]);
  let slotId: AppVaultSlotId;
  try { slotId = parseAppVaultSlotId(record["slotId"]); }
  catch { throw new AppVaultError("VAULT_UNKNOWN_SLOT", "The vault contains an unknown credential slot."); }
  const state = record["state"];
  if (state !== "present" && state !== "revoked" && state !== "unrecoverable") throw corrupt();
  const cipherText = record["cipherText"];
  const cipherByteLength = record["cipherByteLength"];
  const fingerprint = nullableHex(record["keyFingerprint"]);
  const salt = record["keyFingerprintSalt"];
  if (salt !== null && (typeof salt !== "string" || salt.length !== 43 || !BASE64URL.test(salt) || Buffer.from(salt, "base64url").byteLength !== 32)) throw corrupt();
  if ((fingerprint === null) !== (salt === null)) throw corrupt();
  if (state === "present" || (state === "unrecoverable" && cipherText !== null)) {
    if (typeof cipherText !== "string") throw corrupt();
    const bytes = decodeCipher(cipherText);
    if (typeof cipherByteLength !== "number" || safeInteger(cipherByteLength, 1) !== bytes.byteLength) throw corrupt();
    if (record["revokedAt"] !== null || fingerprint === null || salt === null) throw corrupt();
  } else if (cipherText !== null || cipherByteLength !== null || fingerprint !== null || salt !== null) {
    throw corrupt();
  }
  const revokedAt = nullableTimestamp(record["revokedAt"]);
  if ((state === "revoked") !== (revokedAt !== null)) throw corrupt();
  return Object.freeze({
    slotId,
    state,
    generation: safeInteger(record["generation"], 1),
    createdAt: timestamp(record["createdAt"]),
    rotatedAt: nullableTimestamp(record["rotatedAt"]),
    revokedAt,
    cipherText: cipherText as string | null,
    cipherByteLength: cipherByteLength as number | null,
    keyFingerprint: fingerprint,
    keyFingerprintSalt: salt as string | null,
    lastValidation: parseValidation(record["lastValidation"]),
  });
}

function documentBody(document: Omit<AppVaultDocument, "integrity"> | AppVaultDocument): Omit<AppVaultDocument, "integrity"> {
  return Object.freeze({
    schemaVersion: document.schemaVersion,
    containerId: document.containerId,
    revision: document.revision,
    containerBinding: document.containerBinding,
    backend: document.backend,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    records: document.records,
  });
}

export function vaultIntegrityDigest(document: Omit<AppVaultDocument, "integrity"> | AppVaultDocument): string {
  return createHash("sha256").update(toCanonicalJson(documentBody(document))).digest("hex");
}

export function withVaultIntegrity(document: Omit<AppVaultDocument, "integrity">): AppVaultDocument {
  return Object.freeze({
    ...document,
    integrity: Object.freeze({ algorithm: "sha256" as const, digest: vaultIntegrityDigest(document) }),
  });
}

export function createEmptyVaultDocument(binding: AppVaultContainerBinding, now: string): AppVaultDocument {
  const checked = timestamp(now);
  return withVaultIntegrity(Object.freeze({
    schemaVersion: APP_VAULT_DOCUMENT_SCHEMA_VERSION,
    containerId: APP_VAULT_CONTAINER_ID,
    revision: 1,
    containerBinding: binding.digest,
    backend: Object.freeze({ kind: binding.backendKind }),
    createdAt: checked,
    updatedAt: checked,
    records: Object.freeze([]),
  }));
}

export function serializeVaultDocument(document: AppVaultDocument): Uint8Array {
  const normalized = withVaultIntegrity(documentBody(document));
  return new TextEncoder().encode(toCanonicalJson(normalized));
}

export function parseVaultDocumentUnbound(bytes: Uint8Array): AppVaultDocument {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > APP_VAULT_MAX_DOCUMENT_BYTES) throw corrupt();
  let text: string;
  let raw: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    raw = JSON.parse(text) as unknown;
  } catch { throw corrupt(); }
  const root = exactRecord(raw, ["schemaVersion", "containerId", "revision", "containerBinding", "backend", "createdAt", "updatedAt", "records", "integrity"]);
  if (typeof root["schemaVersion"] === "number" && root["schemaVersion"] > APP_VAULT_DOCUMENT_SCHEMA_VERSION) {
    throw new AppVaultError("VAULT_SCHEMA_AHEAD", "The vault was written by a newer application version.");
  }
  if (root["schemaVersion"] !== APP_VAULT_DOCUMENT_SCHEMA_VERSION || root["containerId"] !== APP_VAULT_CONTAINER_ID) throw corrupt();
  const integrity = exactRecord(root["integrity"], ["algorithm", "digest"]);
  if (integrity["algorithm"] !== "sha256" || typeof integrity["digest"] !== "string" || !HEX_64.test(integrity["digest"])) throw corrupt();
  const rawBody = Object.freeze({
    schemaVersion: root["schemaVersion"],
    containerId: root["containerId"],
    revision: root["revision"],
    containerBinding: root["containerBinding"],
    backend: root["backend"],
    createdAt: root["createdAt"],
    updatedAt: root["updatedAt"],
    records: root["records"],
  });
  let rawDigest: string;
  let canonical: string;
  try {
    rawDigest = createHash("sha256").update(toCanonicalJson(rawBody)).digest("hex");
    canonical = toCanonicalJson(Object.freeze({ ...rawBody, integrity: Object.freeze({ algorithm: "sha256", digest: integrity["digest"] }) }));
  } catch { throw corrupt(); }
  if (rawDigest !== integrity["digest"] || canonical !== text) throw corrupt();
  if (typeof root["containerBinding"] !== "string" || !HEX_64.test(root["containerBinding"])) throw corrupt();
  const backend = exactRecord(root["backend"], ["kind"]);
  if (typeof backend["kind"] !== "string" || !APP_VAULT_BACKEND_KINDS.includes(backend["kind"] as never)) throw corrupt();
  if (!Array.isArray(root["records"]) || root["records"].length > APP_VAULT_MAX_RECORDS) throw corrupt();
  const records = root["records"].map(parseRecord);
  const slots = records.map((record) => record.slotId);
  if (new Set(slots).size !== slots.length || slots.some((slot, index) => index > 0 && slots[index - 1]! >= slot)) throw corrupt();
  const document: AppVaultDocument = Object.freeze({
    schemaVersion: APP_VAULT_DOCUMENT_SCHEMA_VERSION,
    containerId: APP_VAULT_CONTAINER_ID,
    revision: safeInteger(root["revision"], 1),
    containerBinding: root["containerBinding"],
    backend: Object.freeze({ kind: backend["kind"] as AppVaultBackendKind }),
    createdAt: timestamp(root["createdAt"]),
    updatedAt: timestamp(root["updatedAt"]),
    records: Object.freeze(records),
    integrity: Object.freeze({ algorithm: "sha256", digest: integrity["digest"] }),
  });
  if (vaultIntegrityDigest(document) !== document.integrity.digest) throw corrupt();
  return document;
}

export function parseVaultDocument(bytes: Uint8Array, binding: AppVaultContainerBinding): AppVaultDocument {
  const document = parseVaultDocumentUnbound(bytes);
  if (document.backend.kind !== binding.backendKind) throw new AppVaultError("VAULT_BACKEND_MISMATCH", "The vault encryption backend does not match this application.");
  if (document.containerBinding !== binding.digest) throw new AppVaultError("VAULT_IDENTITY_MISMATCH", "The vault belongs to a different application identity.");
  return document;
}

/**
 * Validates storage bytes without exposing records, ciphertext, fingerprints, or
 * other document internals across the package boundary.
 */
export function inspectVaultDocument(bytes: Uint8Array, binding: AppVaultContainerBinding): Readonly<{ revision: number }> {
  return Object.freeze({ revision: parseVaultDocument(bytes, binding).revision });
}

export function vaultCipherBytes(record: AppVaultRecord): Uint8Array {
  if (record.state !== "present" || record.cipherText === null) throw new AppVaultError("RECORD_ABSENT", "The credential record has no ciphertext.");
  return decodeCipher(record.cipherText);
}
