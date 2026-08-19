import { types } from "node:util";
import {
  AppVaultError,
  type AppVaultCryptoPort,
} from "@ai-dev-os/secrets-app-vault";

export interface ElectronSafeStorageBindings {
  readonly isReady: () => boolean;
  readonly isAsyncEncryptionAvailable: () => Promise<boolean>;
  readonly encryptStringAsync: (plainText: string) => Promise<Uint8Array>;
  readonly decryptStringAsync: (cipherText: Buffer) => Promise<unknown>;
}

export interface ElectronSafeStoragePortOptions {
  readonly platform: string;
  readonly load: () => Promise<unknown>;
}

const BINDING_KEYS = Object.freeze([
  "isReady",
  "isAsyncEncryptionAvailable",
  "encryptStringAsync",
  "decryptStringAsync",
] as const);

function malformed(message: string): AppVaultError {
  return new AppVaultError("MALFORMED_CRYPTO_RESPONSE", message);
}

function unavailable(code: "PLATFORM_UNSUPPORTED" | "APP_NOT_READY" | "ENCRYPTION_UNAVAILABLE", message: string): AppVaultError {
  return new AppVaultError(code, message);
}

function snapshotBindings(value: unknown): ElectronSafeStorageBindings {
  try {
    if (typeof value !== "object" || value === null || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("invalid-bindings");
    const keys = Reflect.ownKeys(value);
    if (keys.length !== BINDING_KEYS.length || keys.some((key) => typeof key !== "string" || !BINDING_KEYS.includes(key as never))) throw new Error("invalid-keys");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const methods: Record<string, (...args: unknown[]) => unknown> = Object.create(null) as Record<string, (...args: unknown[]) => unknown>;
    for (const key of BINDING_KEYS) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "function") throw new Error("invalid-method");
      methods[key] = descriptor.value as (...args: unknown[]) => unknown;
    }
    return Object.freeze({
      isReady: () => Reflect.apply(methods["isReady"]!, value, []) as boolean,
      isAsyncEncryptionAvailable: () => Reflect.apply(methods["isAsyncEncryptionAvailable"]!, value, []) as Promise<boolean>,
      encryptStringAsync: (plainText: string) => Reflect.apply(methods["encryptStringAsync"]!, value, [plainText]) as Promise<Uint8Array>,
      decryptStringAsync: (cipherText: Buffer) => Reflect.apply(methods["decryptStringAsync"]!, value, [cipherText]) as Promise<unknown>,
    });
  } catch {
    throw unavailable("ENCRYPTION_UNAVAILABLE", "The Electron secure-storage boundary is unavailable.");
  }
}

function isZeroableByteView(value: unknown): value is Uint8Array {
  try { return typeof value === "object" && value !== null && !types.isProxy(value) && value instanceof Uint8Array; }
  catch { return false; }
}

function zeroPossible(value: unknown): void {
  if (!isZeroableByteView(value)) return;
  try { Reflect.apply(Uint8Array.prototype.fill, value, [0]); }
  catch { /* best effort for a detached or hostile view */ }
}

function copyCipher(value: unknown): Uint8Array {
  try {
    if (!isZeroableByteView(value) || Object.getOwnPropertyDescriptor(value, "length") !== undefined || Object.getOwnPropertyDescriptor(value, "byteLength") !== undefined) throw new Error("invalid-view");
    const byteLength = Reflect.get(Object.getPrototypeOf(Uint8Array.prototype), "byteLength", value) as number;
    if (!Number.isSafeInteger(byteLength) || byteLength < 1) throw new Error("invalid-length");
    const owned = new Uint8Array(byteLength);
    Reflect.apply(Uint8Array.prototype.set, owned, [value]);
    return owned;
  } catch {
    throw malformed("Electron returned malformed encrypted bytes.");
  } finally {
    zeroPossible(value);
  }
}

function decryptResult(value: unknown): Readonly<{ result: string; shouldReEncrypt: boolean }> {
  try {
    if (typeof value !== "object" || value === null || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("invalid-result");
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || keys.some((key) => key !== "result" && key !== "shouldReEncrypt")) throw new Error("invalid-keys");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = descriptors["result"];
    const shouldReEncrypt = descriptors["shouldReEncrypt"];
    if (result === undefined || !("value" in result) || typeof result.value !== "string" || shouldReEncrypt === undefined || !("value" in shouldReEncrypt) || typeof shouldReEncrypt.value !== "boolean") throw new Error("invalid-fields");
    return Object.freeze({ result: result.value, shouldReEncrypt: shouldReEncrypt.value });
  } catch {
    throw malformed("Electron returned a malformed decryption result.");
  }
}

export function createElectronSafeStorageCryptoPortInternal(options: ElectronSafeStoragePortOptions): AppVaultCryptoPort {
  let platform: string;
  let load: () => Promise<unknown>;
  try {
    if (typeof options !== "object" || options === null || types.isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype) throw new Error("invalid-options");
    const keys = Reflect.ownKeys(options);
    if (keys.length !== 2 || keys.some((key) => key !== "platform" && key !== "load")) throw new Error("invalid-keys");
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const platformDescriptor = descriptors["platform"];
    const loadDescriptor = descriptors["load"];
    if (platformDescriptor === undefined || !("value" in platformDescriptor) || typeof platformDescriptor.value !== "string" || loadDescriptor === undefined || !("value" in loadDescriptor) || typeof loadDescriptor.value !== "function") throw new Error("invalid-fields");
    platform = platformDescriptor.value;
    load = loadDescriptor.value as () => Promise<unknown>;
  } catch { throw new AppVaultError("INVALID_CONFIGURATION", "The Electron secure-storage options are invalid."); }
  let loaded: Promise<ElectronSafeStorageBindings> | null = null;

  async function bindings(): Promise<ElectronSafeStorageBindings> {
    if (platform !== "win32") throw unavailable("PLATFORM_UNSUPPORTED", "The application vault is supported on Windows only.");
    loaded ??= Promise.resolve().then(load).then(snapshotBindings).catch(() => {
      throw unavailable("ENCRYPTION_UNAVAILABLE", "Electron secure storage could not be loaded.");
    });
    const value = await loaded;
    let ready: unknown;
    try { ready = value.isReady(); }
    catch { throw unavailable("APP_NOT_READY", "Electron is not ready for secure storage."); }
    if (ready !== true) throw unavailable("APP_NOT_READY", "Electron is not ready for secure storage.");
    return value;
  }

  async function availableBindings(): Promise<ElectronSafeStorageBindings> {
    const value = await bindings();
    let available: unknown;
    try { available = await value.isAsyncEncryptionAvailable(); }
    catch { throw unavailable("ENCRYPTION_UNAVAILABLE", "Electron secure storage is temporarily unavailable."); }
    if (available !== true) throw unavailable("ENCRYPTION_UNAVAILABLE", "Electron secure storage is temporarily unavailable.");
    return value;
  }

  return Object.freeze({
    async isAvailable() {
      await availableBindings();
      return true;
    },
    async encrypt(plainText: string) {
      if (typeof plainText !== "string") throw new AppVaultError("INVALID_CONFIGURATION", "The secure-storage plaintext must be text.");
      const value = await availableBindings();
      let encrypted: unknown;
      try { encrypted = await value.encryptStringAsync(plainText); }
      catch { throw new AppVaultError("ENCRYPT_FAILED", "Electron could not encrypt the credential."); }
      return copyCipher(encrypted);
    },
    async decrypt(cipher: Uint8Array) {
      if (!isZeroableByteView(cipher)) throw malformed("The encrypted credential buffer is invalid.");
      const value = await availableBindings();
      const temporary = Buffer.from(cipher);
      try {
        let decrypted: unknown;
        try { decrypted = await value.decryptStringAsync(temporary); }
        catch { throw new AppVaultError("DECRYPT_FAILED", "Electron could not decrypt the credential."); }
        return decryptResult(decrypted);
      } finally { temporary.fill(0); }
    },
    describeBackend: () => Object.freeze({ kind: "electron-safe-storage-async" as const }),
  });
}
