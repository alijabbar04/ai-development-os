import { createHash } from "node:crypto";
import { types } from "node:util";
import { toCanonicalJson } from "@ai-dev-os/domain";
import {
  SecretBrokerError,
  parseSecretRef,
  secretRefFingerprint,
  serializeSecretRef,
  type SecretRef,
} from "@ai-dev-os/secrets";
import {
  WINDOWS_CREDENTIAL_BROKER_SCHEMA_VERSION,
  WINDOWS_CREDENTIAL_TARGET_PREFIX,
  type WindowsCredentialTargetBinding,
} from "./contracts.js";

const EXACT_REF_KEYS = Object.freeze([
  "schemaVersion",
  "type",
  "namespace",
  "version",
  "expectedKind",
  "providerInstanceId",
  "service",
  "account",
] as const);

function exactDataRecord(value: unknown, path: string): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== "object" || value === null || types.isProxy(value)) {
      throw new SecretBrokerError("INVALID_REFERENCE", `${path} must be a plain data object.`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new SecretBrokerError("INVALID_REFERENCE", `${path} must be a plain data object.`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string") || keys.length !== EXACT_REF_KEYS.length) {
      throw new SecretBrokerError("INVALID_REFERENCE", `${path} has an invalid key set.`);
    }
    const sorted = (keys as string[]).sort();
    if (toCanonicalJson(sorted) !== toCanonicalJson([...EXACT_REF_KEYS].sort())) {
      throw new SecretBrokerError("INVALID_REFERENCE", `${path} has an invalid key set.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of EXACT_REF_KEYS) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new SecretBrokerError("INVALID_REFERENCE", `${path} must contain data properties only.`);
      }
      output[key] = descriptor.value;
    }
    return Object.freeze(output);
  } catch (error) {
    if (error instanceof SecretBrokerError) throw error;
    throw new SecretBrokerError("INVALID_REFERENCE", `${path} could not be inspected safely.`);
  }
}

export function parseWindowsCredentialReference(value: unknown, path = "reference"): SecretRef & {
  readonly type: "keychain";
  readonly expectedKind: "text";
  readonly version: null;
} {
  let parsed: SecretRef;
  try {
    parsed = parseSecretRef(exactDataRecord(value, path), path);
  } catch (error) {
    if (error instanceof SecretBrokerError) throw error;
    throw new SecretBrokerError("INVALID_REFERENCE", "The Windows credential reference is invalid.");
  }
  if (parsed.type !== "keychain") {
    throw new SecretBrokerError("INVALID_REFERENCE", "The Windows broker supports keychain references only.");
  }
  if (parsed.expectedKind !== "text") {
    throw new SecretBrokerError("KIND_MISMATCH", "The Windows broker supports text secrets only.");
  }
  if (parsed.version !== null) {
    throw new SecretBrokerError("VERSION_UNAVAILABLE", "The Windows broker does not expose credential versions.");
  }
  return parsed as SecretRef & { readonly type: "keychain"; readonly expectedKind: "text"; readonly version: null };
}

export function windowsCredentialTargetBinding(rawReference: SecretRef): WindowsCredentialTargetBinding {
  const reference = parseWindowsCredentialReference(rawReference);
  const projection = Object.freeze({
    schemaVersion: WINDOWS_CREDENTIAL_BROKER_SCHEMA_VERSION,
    namespace: reference.namespace,
    service: reference.service,
    account: reference.account,
    expectedKind: reference.expectedKind,
    providerInstanceId: reference.providerInstanceId,
  });
  const targetFingerprint = createHash("sha256").update(toCanonicalJson(projection)).digest("hex");
  const targetName = `${WINDOWS_CREDENTIAL_TARGET_PREFIX}:${reference.namespace}:${targetFingerprint}`;
  return Object.freeze({
    schemaVersion: WINDOWS_CREDENTIAL_BROKER_SCHEMA_VERSION,
    targetName,
    targetFingerprint,
    referenceFingerprint: secretRefFingerprint(reference),
  });
}

export function exactWindowsCredentialReference(left: SecretRef, right: SecretRef): boolean {
  return serializeSecretRef(parseWindowsCredentialReference(left)) ===
    serializeSecretRef(parseWindowsCredentialReference(right));
}
