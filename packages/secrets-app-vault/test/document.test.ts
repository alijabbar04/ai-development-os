import { createHash } from "node:crypto";
import { toCanonicalJson } from "@ai-dev-os/domain";
import { SecretBrokerError } from "@ai-dev-os/secrets";
import { describe, expect, it } from "vitest";
import {
  APP_VAULT_CONTAINER_ID,
  APP_VAULT_MAX_DOCUMENT_BYTES,
  APP_VAULT_SLOTS,
  AppVaultError,
  appVaultContainerBinding,
  appVaultReferenceForSlot,
  exactAppVaultReference,
  parseAppVaultReference,
  parseAppVaultSlotId,
} from "../src/index.js";
import {
  createEmptyVaultDocument,
  parseVaultDocument,
  inspectVaultDocument,
  serializeVaultDocument,
  vaultCipherBytes,
  withVaultIntegrity,
  type AppVaultDocument,
  type AppVaultRecord,
} from "../src/document.js";

const IDENTITY = Object.freeze({ name: "AI Development OS", appDataPath: "C:\\Users\\Operator\\AppData\\Roaming" });
const BINDING = appVaultContainerBinding({ appIdentity: IDENTITY, backendKind: "deterministic-fake" });
const NOW = "2026-08-19T09:00:00.000Z";

function present(slotId: "anthropic" | "openai" = "anthropic"): AppVaultRecord {
  const cipher = new TextEncoder().encode("opaque-ciphertext");
  return Object.freeze({
    slotId,
    state: "present",
    generation: 1,
    createdAt: NOW,
    rotatedAt: null,
    revokedAt: null,
    cipherText: Buffer.from(cipher).toString("base64url"),
    cipherByteLength: cipher.byteLength,
    keyFingerprint: "a".repeat(64),
    keyFingerprintSalt: Buffer.alloc(32, 7).toString("base64url"),
    lastValidation: null,
  });
}

function document(records: readonly AppVaultRecord[] = []): AppVaultDocument {
  const empty = createEmptyVaultDocument(BINDING, NOW);
  return withVaultIntegrity({ ...empty, records: Object.freeze(records) });
}

function rawDocument(records: readonly unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    schemaVersion: 1,
    containerId: APP_VAULT_CONTAINER_ID,
    revision: 1,
    containerBinding: BINDING.digest,
    backend: { kind: "deterministic-fake" },
    createdAt: NOW,
    updatedAt: NOW,
    records,
    ...overrides,
  };
  const digest = createHash("sha256").update(toCanonicalJson(body)).digest("hex");
  return { ...body, integrity: { algorithm: "sha256", digest } };
}

function encoded(raw: unknown): Uint8Array {
  return new TextEncoder().encode(toCanonicalJson(raw as never));
}

describe("closed app-vault identity", () => {
  it("publishes exactly four immutable, provider-bound slots", () => {
    expect(APP_VAULT_SLOTS).toEqual([
      { slotId: "anthropic", displayName: "Anthropic", namespace: "provider", providerInstanceId: "anthropic-default" },
      { slotId: "openai", displayName: "OpenAI", namespace: "provider", providerInstanceId: "openai-default" },
      { slotId: "gemini", displayName: "Google Gemini", namespace: "provider", providerInstanceId: "gemini-default" },
      { slotId: "openrouter", displayName: "OpenRouter", namespace: "provider", providerInstanceId: "openrouter-default" },
    ]);
    expect(Object.isFrozen(APP_VAULT_SLOTS)).toBe(true);
    expect(APP_VAULT_SLOTS.every(Object.isFrozen)).toBe(true);
    expect(() => parseAppVaultSlotId("future-provider")).toThrowError(AppVaultError);
  });

  it("parses only the exact existing encrypted-file reference shape", () => {
    const reference = appVaultReferenceForSlot("anthropic");
    expect(parseAppVaultReference(reference)).toEqual(reference);
    expect(exactAppVaultReference(reference, { ...reference })).toBe(true);
    const invalid = [
      { ...reference, type: "keychain" },
      { ...reference, expectedKind: "bytes" },
      { ...reference, version: "1" },
      { ...reference, containerId: "other" },
      { ...reference, entryName: "unknown" },
      { ...reference, providerInstanceId: "anthropic-other" },
      { ...reference, namespace: "other" },
      { ...reference, extra: true },
      Object.defineProperty({ ...reference }, "entryName", { enumerable: true, get: () => "anthropic" }),
      new Proxy({ ...reference }, {}),
    ];
    for (const candidate of invalid) expect(() => parseAppVaultReference(candidate)).toThrow(SecretBrokerError);
    expect(() => exactAppVaultReference(reference, appVaultReferenceForSlot("openai"))).not.toThrow();
    expect(exactAppVaultReference(reference, appVaultReferenceForSlot("openai"))).toBe(false);
  });

  it("normalizes the Windows path for a stable binding and changes on every identity dimension", () => {
    const equivalent = appVaultContainerBinding({ appIdentity: { name: IDENTITY.name, appDataPath: "c:/users/operator/appdata/roaming/" }, backendKind: "deterministic-fake" });
    expect(equivalent.digest).toBe(BINDING.digest);
    expect(appVaultContainerBinding({ appIdentity: { ...IDENTITY, name: "Other" }, backendKind: "deterministic-fake" }).digest).not.toBe(BINDING.digest);
    expect(appVaultContainerBinding({ appIdentity: { ...IDENTITY, appDataPath: "C:\\Other" }, backendKind: "deterministic-fake" }).digest).not.toBe(BINDING.digest);
    expect(appVaultContainerBinding({ appIdentity: IDENTITY, backendKind: "electron-safe-storage-async" }).digest).not.toBe(BINDING.digest);
    expect(() => appVaultContainerBinding({ appIdentity: { name: "", appDataPath: "C:\\ok" }, backendKind: "deterministic-fake" })).toThrow(SecretBrokerError);
    expect(() => appVaultContainerBinding({ appIdentity: { name: "ok", appDataPath: "x" }, backendKind: "deterministic-fake" })).toThrow(SecretBrokerError);
  });
});

describe("strict canonical vault document", () => {
  it("round-trips an empty and populated document byte for byte", () => {
    for (const candidate of [document(), document([present()])]) {
      const bytes = serializeVaultDocument(candidate);
      const parsed = parseVaultDocument(bytes, BINDING);
      expect(parsed).toEqual(candidate);
      expect(inspectVaultDocument(bytes, BINDING)).toEqual({ revision: candidate.revision });
      expect(serializeVaultDocument(parsed)).toEqual(bytes);
    }
    expect(vaultCipherBytes(present())).toEqual(new TextEncoder().encode("opaque-ciphertext"));
  });

  it("rejects unknown, duplicate and prototype-pollution-shaped keys", () => {
    expect(() => parseVaultDocument(encoded(null), BINDING)).toThrowError(AppVaultError);
    expect(() => parseVaultDocument(encoded([]), BINDING)).toThrowError(AppVaultError);
    expect(() => parseVaultDocument(encoded({ ...rawDocument([]), unexpected: true }), BINDING)).toThrowError(AppVaultError);
    expect(() => parseVaultDocument(new TextEncoder().encode('{"schemaVersion":1,"schemaVersion":1}'), BINDING)).toThrowError(AppVaultError);
    const pollution = '{"__proto__":{"polluted":true},"backend":{"kind":"deterministic-fake"},"containerBinding":"' + BINDING.digest + '","containerId":"app-vault.v1","createdAt":"' + NOW + '","integrity":{"algorithm":"sha256","digest":"' + "0".repeat(64) + '"},"records":[],"revision":1,"schemaVersion":1,"updatedAt":"' + NOW + '"}';
    expect(() => parseVaultDocument(new TextEncoder().encode(pollution), BINDING)).toThrowError(AppVaultError);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects oversized, malformed UTF-8, noncanonical and integrity-changing input", () => {
    expect(() => parseVaultDocument(new Uint8Array(APP_VAULT_MAX_DOCUMENT_BYTES + 1), BINDING)).toThrowError(AppVaultError);
    expect(() => parseVaultDocument(Uint8Array.of(0xff, 0xfe), BINDING)).toThrowError(AppVaultError);
    const canonical = new TextDecoder().decode(serializeVaultDocument(document()));
    expect(() => parseVaultDocument(new TextEncoder().encode(` ${canonical}`), BINDING)).toThrowError(AppVaultError);
    const changed = JSON.parse(canonical) as Record<string, unknown>;
    changed["revision"] = 2;
    expect(() => parseVaultDocument(encoded(changed), BINDING)).toThrowError(AppVaultError);
  });

  it("distinguishes schema-ahead, backend and application identity failures", () => {
    expect(() => parseVaultDocument(encoded(rawDocument([], { schemaVersion: 2 })), BINDING)).toThrowError(expect.objectContaining({ code: "VAULT_SCHEMA_AHEAD" }));
    const otherBackend = appVaultContainerBinding({ appIdentity: IDENTITY, backendKind: "electron-safe-storage-async" });
    expect(() => parseVaultDocument(serializeVaultDocument(document()), otherBackend)).toThrowError(expect.objectContaining({ code: "VAULT_BACKEND_MISMATCH" }));
    const otherIdentity = appVaultContainerBinding({ appIdentity: { ...IDENTITY, name: "Other" }, backendKind: "deterministic-fake" });
    expect(() => parseVaultDocument(serializeVaultDocument(document()), otherIdentity)).toThrowError(expect.objectContaining({ code: "VAULT_IDENTITY_MISMATCH" }));
    const tamperedForeign = rawDocument([], { containerBinding: "b".repeat(64) });
    (tamperedForeign["integrity"] as { digest: string }).digest = "0".repeat(64);
    expect(() => parseVaultDocument(encoded(tamperedForeign), BINDING)).toThrowError(expect.objectContaining({ code: "VAULT_CORRUPT" }));
  });

  it("rejects canonical documents with invalid root security metadata", () => {
    const invalidIntegrityAlgorithm = rawDocument([]);
    (invalidIntegrityAlgorithm["integrity"] as { algorithm: string }).algorithm = "sha512";
    const invalidIntegrityDigest = rawDocument([]);
    (invalidIntegrityDigest["integrity"] as { digest: string }).digest = "not-a-digest";
    for (const candidate of [
      rawDocument([], { schemaVersion: 0 }),
      rawDocument([], { containerId: "other" }),
      rawDocument([], { containerBinding: "not-a-digest" }),
      rawDocument([], { backend: { kind: "unknown" } }),
      invalidIntegrityAlgorithm,
      invalidIntegrityDigest,
    ]) expect(() => parseVaultDocument(encoded(candidate), BINDING)).toThrowError(AppVaultError);
  });

  it("enforces record order, uniqueness, catalogue membership and bounds", () => {
    expect(() => parseVaultDocument(encoded(rawDocument([present("openai"), present("anthropic")])), BINDING)).toThrowError(AppVaultError);
    expect(() => parseVaultDocument(encoded(rawDocument([present(), present()])), BINDING)).toThrowError(AppVaultError);
    expect(() => parseVaultDocument(encoded(rawDocument([{ ...present(), slotId: "future" }])), BINDING)).toThrowError(expect.objectContaining({ code: "VAULT_UNKNOWN_SLOT" }));
    expect(() => parseVaultDocument(encoded(rawDocument(Array.from({ length: 33 }, () => present()))), BINDING)).toThrowError(AppVaultError);
  });

  it("enforces ciphertext, tombstone, fingerprint, timestamp and validation consistency", () => {
    const invalidRecords = [
      { ...present(), cipherByteLength: 999 },
      { ...present(), cipherText: "not+base64" },
      { ...present(), cipherText: "A", cipherByteLength: 1 },
      { ...present(), cipherText: null },
      { ...present(), keyFingerprint: null },
      { ...present(), keyFingerprint: "not-a-digest" },
      { ...present(), keyFingerprintSalt: "short" },
      { ...present(), revokedAt: NOW },
      { ...present(), state: "unknown" },
      { ...present(), generation: 0 },
      { ...present(), createdAt: "yesterday" },
      { ...present(), createdAt: "2026-13-19T09:00:00.000Z" },
      { ...present(), lastValidation: { outcome: "verified", checkedAt: NOW } },
      { ...present(), lastValidation: { outcome: "valid", checkedAt: "later" } },
      { ...present(), extra: true },
      { ...present(), state: "revoked", revokedAt: NOW },
      { ...present(), state: "unrecoverable", cipherText: null, cipherByteLength: null, keyFingerprint: null, keyFingerprintSalt: null, revokedAt: NOW },
    ];
    for (const record of invalidRecords) expect(() => parseVaultDocument(encoded(rawDocument([record])), BINDING)).toThrowError(AppVaultError);
    const revoked = { ...present(), state: "revoked", revokedAt: NOW, cipherText: null, cipherByteLength: null, keyFingerprint: null, keyFingerprintSalt: null };
    expect(parseVaultDocument(encoded(rawDocument([revoked])), BINDING).records[0]?.state).toBe("revoked");
    const unrecoverable = { ...revoked, state: "unrecoverable", revokedAt: null };
    expect(parseVaultDocument(encoded(rawDocument([unrecoverable])), BINDING).records[0]?.state).toBe("unrecoverable");
    const retainedUnrecoverable = { ...present(), state: "unrecoverable" };
    expect(parseVaultDocument(encoded(rawDocument([retainedUnrecoverable])), BINDING).records[0]).toMatchObject({ state: "unrecoverable", cipherText: present().cipherText });
    expect(() => vaultCipherBytes(revoked as AppVaultRecord)).toThrowError(expect.objectContaining({ code: "RECORD_ABSENT" }));
  });
});
