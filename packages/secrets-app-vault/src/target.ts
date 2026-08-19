import { createHash } from "node:crypto";
import { types } from "node:util";
import { toCanonicalJson } from "@ai-dev-os/domain";
import {
  SecretBrokerError,
  parseSecretRef,
  serializeSecretRef,
  type SecretRef,
} from "@ai-dev-os/secrets";
import {
  APP_VAULT_CONTAINER_ID,
  APP_VAULT_DOCUMENT_SCHEMA_VERSION,
  type AppVaultAppIdentity,
  type AppVaultBackendKind,
  type AppVaultContainerBinding,
} from "./contracts.js";
import { appVaultSlot } from "./slots.js";

const EXACT_REFERENCE_KEYS = Object.freeze([
  "schemaVersion", "type", "namespace", "version", "expectedKind",
  "providerInstanceId", "containerId", "entryName",
] as const);

function exactDataRecord(value: unknown, path: string): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== "object" || value === null || types.isProxy(value)) throw new Error("not-data");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("not-plain");
    const keys = Reflect.ownKeys(value);
    if (keys.length !== EXACT_REFERENCE_KEYS.length || keys.some((key) => typeof key !== "string" || !EXACT_REFERENCE_KEYS.includes(key as never))) throw new Error("keys");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of EXACT_REFERENCE_KEYS) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) throw new Error("accessor");
      output[key] = descriptor.value;
    }
    return Object.freeze(output);
  } catch {
    throw new SecretBrokerError("INVALID_REFERENCE", `${path} must be an exact plain data object.`);
  }
}

export function parseAppVaultReference(value: unknown, path = "reference"): SecretRef & {
  readonly type: "encrypted-file";
  readonly expectedKind: "text";
  readonly version: null;
} {
  let parsed: SecretRef;
  try { parsed = parseSecretRef(exactDataRecord(value, path), path); }
  catch (error) {
    if (error instanceof SecretBrokerError) throw error;
    throw new SecretBrokerError("INVALID_REFERENCE", "The app-vault reference is invalid.");
  }
  if (parsed.type !== "encrypted-file") throw new SecretBrokerError("INVALID_REFERENCE", "The app vault supports encrypted-file references only.");
  if (parsed.expectedKind !== "text") throw new SecretBrokerError("KIND_MISMATCH", "The app vault supports text secrets only.");
  if (parsed.version !== null) throw new SecretBrokerError("VERSION_UNAVAILABLE", "The app vault does not expose generations as versions.");
  if (parsed.containerId !== APP_VAULT_CONTAINER_ID) throw new SecretBrokerError("ACCESS_DENIED", "The app-vault container does not match.");
  let slot;
  try { slot = appVaultSlot(parsed.entryName); }
  catch { throw new SecretBrokerError("INVALID_REFERENCE", "The app-vault slot is not supported."); }
  if (parsed.namespace !== slot.namespace || parsed.providerInstanceId !== slot.providerInstanceId) {
    throw new SecretBrokerError("INVALID_REFERENCE", "The app-vault slot binding is invalid.");
  }
  return parsed as SecretRef & { readonly type: "encrypted-file"; readonly expectedKind: "text"; readonly version: null };
}

export function exactAppVaultReference(left: SecretRef, right: SecretRef): boolean {
  return serializeSecretRef(parseAppVaultReference(left)) === serializeSecretRef(parseAppVaultReference(right));
}

function normalizeIdentity(raw: AppVaultAppIdentity): AppVaultAppIdentity {
  if (typeof raw?.name !== "string" || raw.name.length < 1 || raw.name.length > 128 || /[\u0000-\u001f\u007f]/u.test(raw.name)) {
    throw new SecretBrokerError("INVALID_REFERENCE", "The application identity name is invalid.");
  }
  if (typeof raw.appDataPath !== "string" || raw.appDataPath.length < 3 || raw.appDataPath.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(raw.appDataPath)) {
    throw new SecretBrokerError("INVALID_REFERENCE", "The application data identity is invalid.");
  }
  const normalized = raw.appDataPath.replaceAll("\\", "/").replace(/\/+$/u, "").toLocaleLowerCase("en-US");
  return Object.freeze({ name: raw.name, appDataPath: normalized });
}

export function appVaultContainerBinding(input: Readonly<{
  appIdentity: AppVaultAppIdentity;
  backendKind: AppVaultBackendKind;
}>): AppVaultContainerBinding {
  const appIdentity = normalizeIdentity(input.appIdentity);
  const projection = Object.freeze({
    schemaVersion: APP_VAULT_DOCUMENT_SCHEMA_VERSION,
    containerId: APP_VAULT_CONTAINER_ID,
    backendKind: input.backendKind,
    appIdentity,
  });
  return Object.freeze({
    schemaVersion: projection.schemaVersion,
    containerId: projection.containerId,
    backendKind: projection.backendKind,
    digest: createHash("sha256").update(toCanonicalJson(projection)).digest("hex"),
  });
}
