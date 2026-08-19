import { resolve, sep } from "node:path";
import { types } from "node:util";
import {
  APP_VAULT_BROKER_SCHEMA_VERSION,
  AppVaultError,
  appVaultContainerBinding,
  createAppVaultManager as createPureManager,
  createAppVaultSecretBroker as createPureBroker,
  type AppVaultManager,
  type AppVaultManagerOptions,
  type AppVaultBrokerOptions,
  type AppVaultSecretBroker,
} from "@ai-dev-os/secrets-app-vault";
import { assertAppVaultElectronVersion, APP_VAULT_ELECTRON_FLOOR } from "./electron-version.js";
import { createNodeFileAppVaultStoragePort } from "./file-store-port.js";
import { createElectronSafeStorageCryptoPortInternal } from "./safe-storage-port.js";

export interface ElectronAppVaultBrokerOptions {
  readonly schemaVersion: typeof APP_VAULT_BROKER_SCHEMA_VERSION;
  readonly reference: AppVaultBrokerOptions["reference"];
  readonly clock: AppVaultBrokerOptions["clock"];
  readonly audit?: AppVaultBrokerOptions["audit"];
}

export interface ElectronAppVaultManagerOptions {
  readonly schemaVersion: typeof APP_VAULT_BROKER_SCHEMA_VERSION;
  readonly clock: AppVaultManagerOptions["clock"];
  readonly audit?: AppVaultManagerOptions["audit"];
}

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

function applicationDirectoryName(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 128
    || value.trim() !== value
    || value === "."
    || value === ".."
    || /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
    || /[. ]$/u.test(value)
    || WINDOWS_DEVICE_NAME.test(value)
  ) throw new AppVaultError("INVALID_CONFIGURATION", "The Electron application name is not a safe vault-directory name.");
  return value;
}

function productionOptions(value: unknown, broker: boolean): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new AppVaultError("INVALID_CONFIGURATION", "The Electron app-vault options are invalid.");
  const expected = broker ? ["schemaVersion", "reference", "clock", "audit"] : ["schemaVersion", "clock", "audit"];
  const required = broker ? ["schemaVersion", "reference", "clock"] : ["schemaVersion", "clock"];
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !expected.includes(key)) || required.some((key) => !keys.includes(key))) throw new AppVaultError("INVALID_CONFIGURATION", "The Electron app-vault options are invalid.");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) throw new AppVaultError("INVALID_CONFIGURATION", "The Electron app-vault options are invalid.");
    output[key] = descriptor.value;
  }
  if (output["schemaVersion"] !== APP_VAULT_BROKER_SCHEMA_VERSION || (output["audit"] !== undefined && typeof output["audit"] !== "function")) throw new AppVaultError("INVALID_CONFIGURATION", "The Electron app-vault options are invalid.");
  return output;
}

async function productionPorts(): Promise<Readonly<{
  appIdentity: Readonly<{ name: string; appDataPath: string }>;
  crypto: ReturnType<typeof createElectronSafeStorageCryptoPortInternal>;
  storage: Awaited<ReturnType<typeof createNodeFileAppVaultStoragePort>>;
}>> {
  if (process.platform !== "win32") throw new AppVaultError("PLATFORM_UNSUPPORTED", "The application vault is supported on Windows only.");
  const electron = await import("electron");
  const version = process.versions["electron"];
  if (version === undefined) throw new AppVaultError("INVALID_CONFIGURATION", "The app vault must be constructed inside Electron.");
  assertAppVaultElectronVersion(version);
  if (!electron.app.isReady()) throw new AppVaultError("APP_NOT_READY", "Electron must be ready before constructing the app vault.");
  const name = applicationDirectoryName(electron.app.getName());
  const appDataPath = electron.app.getPath("appData");
  if (typeof appDataPath !== "string" || appDataPath.length < 3 || appDataPath.includes("\u0000")) throw new AppVaultError("INVALID_CONFIGURATION", "Electron returned an invalid app-data path.");
  const appDataRoot = resolve(appDataPath);
  const vaultRoot = resolve(appDataRoot, name, "secrets");
  if (!vaultRoot.startsWith(appDataRoot + sep)) throw new AppVaultError("INVALID_CONFIGURATION", "The application vault path escaped the Electron app-data directory.");
  const appIdentity = Object.freeze({ name, appDataPath });
  const crypto = createElectronSafeStorageCryptoPortInternal(Object.freeze({
    platform: process.platform,
    load: async () => Object.freeze({
      isReady: () => electron.app.isReady(),
      isAsyncEncryptionAvailable: () => electron.safeStorage.isAsyncEncryptionAvailable(),
      encryptStringAsync: (plainText: string) => electron.safeStorage.encryptStringAsync(plainText),
      decryptStringAsync: (cipherText: Buffer) => electron.safeStorage.decryptStringAsync(cipherText),
    }),
  }));
  const binding = appVaultContainerBinding({ appIdentity, backendKind: "electron-safe-storage-async" });
  const storage = await createNodeFileAppVaultStoragePort({ root: vaultRoot, binding, platform: process.platform });
  return Object.freeze({ appIdentity, crypto, storage });
}

export async function createAppVaultSecretBroker(options: unknown): Promise<AppVaultSecretBroker> {
  const parsed = productionOptions(options, true);
  const ports = await productionPorts();
  return createPureBroker({
    schemaVersion: APP_VAULT_BROKER_SCHEMA_VERSION,
    reference: parsed["reference"],
    clock: parsed["clock"],
    appIdentity: ports.appIdentity,
    crypto: ports.crypto,
    storage: ports.storage,
    ...(parsed["audit"] === undefined ? {} : { audit: parsed["audit"] }),
  });
}

export async function createAppVaultManager(options: unknown): Promise<AppVaultManager> {
  const parsed = productionOptions(options, false);
  const ports = await productionPorts();
  return createPureManager({
    schemaVersion: APP_VAULT_BROKER_SCHEMA_VERSION,
    clock: parsed["clock"],
    appIdentity: ports.appIdentity,
    crypto: ports.crypto,
    storage: ports.storage,
    ...(parsed["audit"] === undefined ? {} : { audit: parsed["audit"] }),
  });
}

export { APP_VAULT_ELECTRON_FLOOR, assertAppVaultElectronVersion } from "./electron-version.js";
