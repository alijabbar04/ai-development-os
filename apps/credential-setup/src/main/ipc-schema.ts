import { types } from "node:util";
import { parseAppVaultSlotId, type AppVaultSlotId } from "@ai-dev-os/secrets-app-vault";
import type { CredentialOwnership } from "@ai-dev-os/credential-ui";
import { CREDENTIAL_CHANNELS, type CredentialChannel } from "./constants.js";
import { CredentialHostError } from "./host-error.js";
import { assertCredentialMetadataSeparatedFromSecret } from "./metadata-safety.js";

const REQUEST_ID = /^[0-9a-f]{32}$/u;
const SESSION_TOKEN = /^[0-9a-f]{64}$/u;
const CREDENTIAL_ID = /^cred-[0-9a-f]{32}$/u;
const RECORD_TOKEN = /^[0-9a-f]{64}$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export interface Envelope {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly sessionToken: string;
}

export interface DescribePayload extends Envelope { readonly operation: "describe" }
export interface CancelPayload extends Envelope { readonly operation: "cancel" }
export interface SavePayload extends Envelope {
  readonly operation: "save";
  readonly slotId: AppVaultSlotId;
  readonly secret: string;
  readonly nickname: string;
  readonly ownership: CredentialOwnership;
  readonly authorizedBy: string;
  readonly clearClipboard: boolean;
}
export interface RotatePayload extends Envelope {
  readonly operation: "rotate";
  readonly slotId: AppVaultSlotId;
  readonly secret: string;
  readonly credentialId: string;
  readonly recordRevision: number;
  readonly recordToken: string;
  readonly clearClipboard: boolean;
}
export interface SetEnabledPayload extends Envelope {
  readonly operation: "set-enabled";
  readonly slotId: AppVaultSlotId;
  readonly credentialId: string;
  readonly recordRevision: number;
  readonly recordToken: string;
  readonly enabled: boolean;
}
export interface RemovePayload extends Envelope {
  readonly operation: "remove";
  readonly slotId: AppVaultSlotId;
  readonly credentialId: string;
  readonly recordRevision: number;
  readonly recordToken: string;
  readonly acknowledgedRemoval: true;
}
export interface ValidatePayload extends Envelope {
  readonly operation: "validate";
  readonly slotId: AppVaultSlotId;
  readonly credentialId: string;
  readonly recordRevision: number;
  readonly recordToken: string;
  readonly acknowledgedDisclosure: true;
}

export type CredentialPayload = DescribePayload | CancelPayload | SavePayload | RotatePayload | SetEnabledPayload | RemovePayload | ValidatePayload;

function projectExact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== "object" || value === null || types.isProxy(value)) throw new Error("object");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("prototype");
    const actual = Reflect.ownKeys(value);
    if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) throw new Error("keys");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) throw new Error("descriptor");
      output[key] = descriptor.value;
    }
    return Object.freeze(output);
  } catch {
    throw new CredentialHostError("SCHEMA_REJECTED");
  }
}

function peekAction(value: unknown): unknown {
  try {
    if (typeof value !== "object" || value === null || types.isProxy(value)) throw new Error("object");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("prototype");
    const descriptor = Object.getOwnPropertyDescriptor(value, "action");
    if (descriptor === undefined || !("value" in descriptor)) throw new Error("action");
    return descriptor.value;
  } catch { throw new CredentialHostError("SCHEMA_REJECTED"); }
}

function envelope(record: Readonly<Record<string, unknown>>): Envelope {
  if (record["schemaVersion"] !== 1 || typeof record["requestId"] !== "string" || !REQUEST_ID.test(record["requestId"]) || typeof record["sessionToken"] !== "string" || !SESSION_TOKEN.test(record["sessionToken"])) throw new CredentialHostError("SCHEMA_REJECTED");
  return Object.freeze({ schemaVersion: 1, requestId: record["requestId"], sessionToken: record["sessionToken"] });
}

function primitiveString(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || CONTROL.test(value) || !wellFormed(value)) throw new CredentialHostError("SCHEMA_REJECTED");
  return value;
}

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function trimmedSecretSpan(value: string): Readonly<{ start: number; end: number }> {
  const trimmedCodeUnit = (code: number): boolean => (
    (code >= 0x0009 && code <= 0x000d)
    || code === 0x0020 || code === 0x00a0 || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028 || code === 0x2029 || code === 0x202f
    || code === 0x205f || code === 0x3000 || code === 0xfeff
  );
  let start = 0;
  while (start < value.length && trimmedCodeUnit(value.charCodeAt(start))) start += 1;
  let end = value.length;
  while (end > start && trimmedCodeUnit(value.charCodeAt(end - 1))) end -= 1;
  return Object.freeze({ start, end });
}

function secret(value: unknown): string {
  if (typeof value !== "string") throw new CredentialHostError("SCHEMA_REJECTED");
  // The raw transport cap bounds hostile structured-clone input. This scan
  // computes the exact UTF-8 size of the logical trim span without allocating
  // a normalized string or byte buffer; the protected app-vault foundation
  // remains the sole owner of the canonical trim and zeroed UTF-8 bytes.
  if (value.length > 16_384) throw new CredentialHostError("SECRET_TOO_LARGE");
  const { start, end } = trimmedSecretSpan(value);
  if (start === end) throw new CredentialHostError("SECRET_EMPTY");
  let bytes = 0;
  for (let index = start; index < end; index += 1) {
    const code = value.charCodeAt(index);
    if ((code >= 0x0000 && code <= 0x001f) || (code >= 0x007f && code <= 0x009f) || code === 0x2028 || code === 0x2029) throw new CredentialHostError("SECRET_INVALID_CHARACTERS");
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= end || next < 0xdc00 || next > 0xdfff) throw new CredentialHostError("SECRET_INVALID_CHARACTERS");
      bytes += 4;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new CredentialHostError("SECRET_INVALID_CHARACTERS");
    else bytes += code <= 0x007f ? 1 : code <= 0x07ff ? 2 : 3;
    if (bytes > 8_192) throw new CredentialHostError("SECRET_TOO_LARGE");
  }
  return value;
}

function slot(value: unknown): AppVaultSlotId {
  try { return parseAppVaultSlotId(value); }
  catch { throw new CredentialHostError("SLOT_UNKNOWN"); }
}

function identity(record: Readonly<Record<string, unknown>>): Readonly<{ slotId: AppVaultSlotId; credentialId: string; recordRevision: number; recordToken: string }> {
  const credentialId = record["credentialId"];
  const recordRevision = record["recordRevision"];
  const recordToken = record["recordToken"];
  if (typeof credentialId !== "string" || !CREDENTIAL_ID.test(credentialId) || typeof recordRevision !== "number" || !Number.isSafeInteger(recordRevision) || recordRevision < 1 || typeof recordToken !== "string" || !RECORD_TOKEN.test(recordToken)) throw new CredentialHostError("SCHEMA_REJECTED");
  return Object.freeze({ slotId: slot(record["slotId"]), credentialId, recordRevision, recordToken });
}

const BASE = Object.freeze(["schemaVersion", "requestId", "sessionToken"] as const);
const PROJECTED_KEYS: Readonly<Record<CredentialChannel, readonly (readonly string[])[]>> = Object.freeze({
  [CREDENTIAL_CHANNELS.describe]: Object.freeze([BASE]),
  [CREDENTIAL_CHANNELS.save]: Object.freeze([Object.freeze([...BASE, "slotId", "secret", "nickname", "ownership", "authorizedBy", "clearClipboard"])]),
  [CREDENTIAL_CHANNELS.rotate]: Object.freeze([Object.freeze([...BASE, "slotId", "secret", "credentialId", "recordRevision", "recordToken", "clearClipboard"])]),
  [CREDENTIAL_CHANNELS.remove]: Object.freeze([
    Object.freeze([...BASE, "action", "slotId", "credentialId", "recordRevision", "recordToken", "enabled"]),
    Object.freeze([...BASE, "action", "slotId", "credentialId", "recordRevision", "recordToken", "acknowledgedRemoval"]),
  ]),
  [CREDENTIAL_CHANNELS.validate]: Object.freeze([Object.freeze([...BASE, "slotId", "credentialId", "recordRevision", "recordToken", "acknowledgedDisclosure"])]),
  [CREDENTIAL_CHANNELS.cancel]: Object.freeze([BASE]),
});

/** Exact own-data projection used before token comparison; field values remain unparsed. */
export function projectCredentialRecord(value: unknown, channel: CredentialChannel): Readonly<Record<string, unknown>> {
  for (const keys of PROJECTED_KEYS[channel]) {
    try { return projectExact(value, keys); }
    catch { /* the multiplexed remove channel has two exact key sets */ }
  }
  throw new CredentialHostError("SCHEMA_REJECTED");
}

export function parseDescribePayload(value: unknown): DescribePayload {
  const record = projectExact(value, BASE);
  return Object.freeze({ ...envelope(record), operation: "describe" });
}

export function parseCancelPayload(value: unknown): CancelPayload {
  const record = projectExact(value, BASE);
  return Object.freeze({ ...envelope(record), operation: "cancel" });
}

export function parseSavePayload(value: unknown): SavePayload {
  const record = projectExact(value, [...BASE, "slotId", "secret", "nickname", "ownership", "authorizedBy", "clearClipboard"]);
  const ownership = record["ownership"];
  if (ownership !== "owned" && ownership !== "authorized") throw new CredentialHostError("SCHEMA_REJECTED");
  const nickname = primitiveString(record["nickname"], 1, 40).trim();
  const authorizedBy = primitiveString(record["authorizedBy"], 0, 40).trim();
  if (nickname.length === 0 || (ownership === "authorized" && authorizedBy.length === 0) || (ownership === "owned" && authorizedBy.length !== 0) || typeof record["clearClipboard"] !== "boolean") throw new CredentialHostError("SCHEMA_REJECTED");
  const secretValue = secret(record["secret"]);
  assertCredentialMetadataSeparatedFromSecret(secretValue, nickname, authorizedBy);
  return Object.freeze({ ...envelope(record), operation: "save", slotId: slot(record["slotId"]), secret: secretValue, nickname, ownership, authorizedBy, clearClipboard: record["clearClipboard"] });
}

export function parseRotatePayload(value: unknown): RotatePayload {
  const record = projectExact(value, [...BASE, "slotId", "secret", "credentialId", "recordRevision", "recordToken", "clearClipboard"]);
  const bound = identity(record);
  if (typeof record["clearClipboard"] !== "boolean") throw new CredentialHostError("SCHEMA_REJECTED");
  return Object.freeze({ ...envelope(record), operation: "rotate", ...bound, secret: secret(record["secret"]), clearClipboard: record["clearClipboard"] });
}

export function parseRemoveChannelPayload(value: unknown): SetEnabledPayload | RemovePayload {
  const action = peekAction(value);
  if (action === "set-enabled") {
    const record = projectExact(value, [...BASE, "action", "slotId", "credentialId", "recordRevision", "recordToken", "enabled"]);
    const bound = identity(record);
    if (typeof record["enabled"] !== "boolean") throw new CredentialHostError("SCHEMA_REJECTED");
    return Object.freeze({ ...envelope(record), operation: "set-enabled", ...bound, enabled: record["enabled"] });
  }
  if (action === "remove") {
    const record = projectExact(value, [...BASE, "action", "slotId", "credentialId", "recordRevision", "recordToken", "acknowledgedRemoval"]);
    if (record["acknowledgedRemoval"] !== true) throw new CredentialHostError("SCHEMA_REJECTED");
    return Object.freeze({ ...envelope(record), operation: "remove", ...identity(record), acknowledgedRemoval: true });
  }
  throw new CredentialHostError("SCHEMA_REJECTED");
}

export function parseValidatePayload(value: unknown): ValidatePayload {
  const record = projectExact(value, [...BASE, "slotId", "credentialId", "recordRevision", "recordToken", "acknowledgedDisclosure"]);
  if (record["acknowledgedDisclosure"] !== true) throw new CredentialHostError("VALIDATION_DISCLOSURE_MISSING");
  return Object.freeze({ ...envelope(record), operation: "validate", ...identity(record), acknowledgedDisclosure: true });
}
