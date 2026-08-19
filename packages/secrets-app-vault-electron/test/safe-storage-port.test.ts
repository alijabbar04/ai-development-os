import { describe, expect, it } from "vitest";
import { AppVaultError } from "@ai-dev-os/secrets-app-vault";
import { createElectronSafeStorageCryptoPortInternal, type ElectronSafeStorageBindings } from "../src/testing/index.js";

function bindings(options: {
  ready?: boolean;
  available?: boolean;
  encrypted?: unknown;
  decrypted?: unknown;
  throwAvailability?: boolean;
  throwEncrypt?: boolean;
  throwDecrypt?: boolean;
} = {}) {
  const calls = { ready: 0, availability: 0, encrypt: 0, decrypt: 0 };
  let encrypted = Object.hasOwn(options, "encrypted") ? options.encrypted : Uint8Array.of(4, 5, 6);
  const value: ElectronSafeStorageBindings = {
    isReady() { calls.ready += 1; return options.ready ?? true; },
    async isAsyncEncryptionAvailable() { calls.availability += 1; if (options.throwAvailability === true) throw new Error("foreign-availability"); return options.available ?? true; },
    async encryptStringAsync() { calls.encrypt += 1; if (options.throwEncrypt === true) throw new Error("foreign-encrypt"); return encrypted as Uint8Array; },
    async decryptStringAsync() { calls.decrypt += 1; if (options.throwDecrypt === true) throw new Error("foreign-decrypt"); return Object.hasOwn(options, "decrypted") ? options.decrypted : { result: "synthetic-value", shouldReEncrypt: false }; },
  };
  return { value, calls, setEncrypted: (next: unknown) => { encrypted = next; } };
}

function port(value: unknown, platform = "win32", onLoad?: () => void) {
  return createElectronSafeStorageCryptoPortInternal({ platform, async load() { onLoad?.(); return value; } });
}

describe("async Electron safeStorage adapter", () => {
  it("guards platform before loading Electron", async () => {
    let loads = 0;
    const crypto = port(bindings().value, "linux", () => { loads += 1; });
    await expect(crypto.isAvailable()).rejects.toMatchObject({ code: "PLATFORM_UNSUPPORTED" });
    await expect(crypto.encrypt("value")).rejects.toMatchObject({ code: "PLATFORM_UNSUPPORTED" });
    expect(loads).toBe(0);
  });

  it("checks app readiness before asynchronous secure-storage availability", async () => {
    const fixture = bindings({ ready: false });
    await expect(port(fixture.value).isAvailable()).rejects.toMatchObject({ code: "APP_NOT_READY" });
    expect(fixture.calls).toEqual({ ready: 1, availability: 0, encrypt: 0, decrypt: 0 });
    const throwing = bindings();
    Object.defineProperty(throwing.value, "isReady", { enumerable: true, value: () => { throw new Error("foreign-ready"); } });
    await expect(port(throwing.value).isAvailable()).rejects.toMatchObject({ code: "APP_NOT_READY" });
  });

  it("maps a rejected lazy loader to finite unavailability", async () => {
    const crypto = createElectronSafeStorageCryptoPortInternal({ platform: "win32", async load() { throw new Error("foreign-loader"); } });
    const error = await crypto.isAvailable().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "ENCRYPTION_UNAVAILABLE" });
    expect(JSON.stringify(error)).not.toContain("foreign-loader");
  });

  it("treats false, malformed and throwing availability as temporary unavailability", async () => {
    const falseResult = bindings({ available: false });
    await expect(port(falseResult.value).encrypt("value")).rejects.toMatchObject({ code: "ENCRYPTION_UNAVAILABLE" });
    expect(falseResult.calls.encrypt).toBe(0);
    const throwing = bindings({ throwAvailability: true });
    await expect(port(throwing.value).isAvailable()).rejects.toMatchObject({ code: "ENCRYPTION_UNAVAILABLE" });
    const malformed = bindings();
    Object.defineProperty(malformed.value, "isAsyncEncryptionAvailable", { value: async () => "yes", enumerable: true });
    await expect(port(malformed.value).isAvailable()).rejects.toMatchObject({ code: "ENCRYPTION_UNAVAILABLE" });
  });

  it("rejects missing, accessor and proxied binding shapes", async () => {
    const valid = bindings().value;
    const malformed = [
      { ...valid, encryptStringAsync: undefined },
      { ...valid, extra: () => undefined },
      Object.defineProperty({ ...valid }, "decryptStringAsync", { enumerable: true, get: () => valid.decryptStringAsync }),
      new Proxy({ ...valid }, {}),
      null,
    ];
    for (const value of malformed) await expect(port(value).isAvailable()).rejects.toMatchObject({ code: "ENCRYPTION_UNAVAILABLE" });
  });

  it("returns an owned cipher copy and zeros Electron's returned buffer", async () => {
    const electronBytes = Uint8Array.of(11, 22, 33);
    const fixture = bindings({ encrypted: electronBytes });
    const crypto = port(fixture.value);
    expect(await crypto.isAvailable()).toBe(true);
    const result = await crypto.encrypt("synthetic-value");
    expect(result).toEqual(Uint8Array.of(11, 22, 33));
    expect(result).not.toBe(electronBytes);
    expect(electronBytes).toEqual(Uint8Array.of(0, 0, 0));
    expect(fixture.calls.encrypt).toBe(1);
  });

  it("rejects malformed encrypted views and zeros any zeroable response", async () => {
    const lengthShadow = Uint8Array.of(1, 2);
    Object.defineProperty(lengthShadow, "length", { value: 2 });
    const byteLengthShadow = Uint8Array.of(1, 2);
    Object.defineProperty(byteLengthShadow, "byteLength", { value: 2 });
    for (const value of ["cipher", new Uint8Array(), new Proxy(Uint8Array.of(1), {}), lengthShadow, byteLengthShadow]) {
      const fixture = bindings({ encrypted: value });
      await expect(port(fixture.value).encrypt("synthetic-value")).rejects.toMatchObject({ code: "MALFORMED_CRYPTO_RESPONSE" });
      if (value === lengthShadow || value === byteLengthShadow) expect([...value]).toEqual([0, 0]);
    }
  });

  it("accepts only the exact asynchronous decrypt result and preserves its flag", async () => {
    const crypto = port(bindings({ decrypted: { result: "synthetic-value", shouldReEncrypt: true } }).value);
    await expect(crypto.decrypt(Uint8Array.of(1, 2, 3))).resolves.toEqual({ result: "synthetic-value", shouldReEncrypt: true });
    const malformed = [
      null,
      { result: "value" },
      { result: "value", shouldReEncrypt: "yes" },
      { result: 7, shouldReEncrypt: false },
      { result: "value", shouldReEncrypt: false, extra: true },
      Object.defineProperty({ shouldReEncrypt: false }, "result", { enumerable: true, get: () => "value" }),
      new Proxy({ result: "value", shouldReEncrypt: false }, {}),
    ];
    for (const value of malformed) await expect(port(bindings({ decrypted: value }).value).decrypt(Uint8Array.of(1))).rejects.toMatchObject({ code: "MALFORMED_CRYPTO_RESPONSE" });
  });

  it("zeros the temporary Buffer supplied to Electron without mutating caller ciphertext", async () => {
    let captured: Buffer | null = null;
    const value: ElectronSafeStorageBindings = {
      isReady: () => true,
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async () => Uint8Array.of(1),
      decryptStringAsync: async (cipherText) => { captured = cipherText; return { result: "synthetic-value", shouldReEncrypt: false }; },
    };
    const caller = Uint8Array.of(8, 9, 10);
    await expect(port(value).decrypt(caller)).resolves.toEqual({ result: "synthetic-value", shouldReEncrypt: false });
    expect(caller).toEqual(Uint8Array.of(8, 9, 10));
    expect(captured).not.toBeNull();
    expect([...(captured as Buffer)]).toEqual([0, 0, 0]);
  });

  it("maps foreign encryption/decryption failures without their messages", async () => {
    const encrypting = port(bindings({ throwEncrypt: true }).value);
    const encryptError = await encrypting.encrypt("private-canary").catch((value: unknown) => value);
    expect(encryptError).toMatchObject({ code: "ENCRYPT_FAILED" });
    expect(JSON.stringify(encryptError)).not.toContain("foreign-encrypt");
    const decrypting = port(bindings({ throwDecrypt: true }).value);
    const decryptError = await decrypting.decrypt(Uint8Array.of(1)).catch((value: unknown) => value);
    expect(decryptError).toMatchObject({ code: "DECRYPT_FAILED" });
    expect(JSON.stringify(decryptError)).not.toContain("foreign-decrypt");
    await expect(decrypting.decrypt("not-bytes" as never)).rejects.toMatchObject({ code: "MALFORMED_CRYPTO_RESPONSE" });
    await expect(encrypting.encrypt(7 as never)).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
  });

  it("describes the one exact backend without loading Electron", () => {
    let loads = 0;
    const crypto = port(bindings().value, "win32", () => { loads += 1; });
    expect(crypto.describeBackend()).toEqual({ kind: "electron-safe-storage-async" });
    expect(loads).toBe(0);
    let getterCalls = 0;
    const accessor = Object.defineProperty({ platform: "win32" }, "load", { enumerable: true, get() { getterCalls += 1; return async () => bindings().value; } });
    for (const options of [
      null,
      { platform: "win32", load: async () => bindings().value, extra: true },
      { platform: 7, load: async () => bindings().value },
      accessor,
    ]) expect(() => createElectronSafeStorageCryptoPortInternal(options as never)).toThrowError(AppVaultError);
    expect(getterCalls).toBe(0);
  });
});
