import { ValidationError, validation } from "@ai-dev-os/domain";
import { types as utilTypes } from "node:util";
import { API_LIMITS } from "./constants.js";

const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CREDENTIAL_KEY = /(?:^token(?:value)?$|credential|secret|password|passwd|passphrase|passcode|(?:access|authorization|auth|refresh|session|identity|id|bearer|oauth|csrf|xsrf|api)token|(?:api|private|public|signing|encryption|client|access|auth)key|cookie|sessionid|recoverycode|otp|totp|rawbody|responsebody)/iu;
const BORROWED_OWNER_KEY = /(?:borrowed.*owner|owner.*(?:id|identity|email|name|account))/iu;
const FINGERPRINT_KEY = /fingerprint/iu;
const LONG_HEX_SHAPE = /\b[0-9a-f]{40,}\b/iu;
const LONG_BASE64_SHAPE = /\b[A-Za-z0-9+/]{48,}={0,2}\b/u;
const SECRET_SHAPES = Object.freeze([
  /sk-ant-[A-Za-z0-9_-]{8,}/u,
  /\bsk-[A-Za-z0-9]{20,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}\b/u,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/u,
  /\bAIza[0-9A-Za-z_-]{30,}/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bBearer\s+[A-Za-z0-9._~+/\-]{16,}=*/u,
  LONG_HEX_SHAPE,
  LONG_BASE64_SHAPE,
  /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['"]?[^\s'"]{8,}/iu,
]);
const NORMAL_MECHANISM_SHAPE = /(?:\b(?:usage|route|admission|orchestration)\.[a-z0-9.-]+|sha256:|\b(?:att|lease|trc|ctx)-[a-z0-9._:-]+|\b(?:hnd|dec):[a-z0-9._:-]+|\bbasis[-\s]+points?\b|\b\d+(?:\.\d+)?\s*(?:bp|bps)\b|\b429\b)/iu;
const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/u;
const POSIX_ABSOLUTE_PATH = /^\/(?!\/)/u;

export function apiFail(path: string, code: string, message: string): never {
  throw new ValidationError(`${path}: ${message}`, [{ path, code, message }]);
}

export function readSafeRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    apiFail(path, "not_object", "must be a plain data object.");
  }
  if (utilTypes.isProxy(value)) {
    apiFail(path, "proxy_object", "cannot be a proxy.");
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    apiFail(path, "exotic_object", "must not have a custom prototype.");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    apiFail(path, "symbol_key", "cannot contain symbol-keyed fields.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      apiFail(path, "forbidden_key", "contains a prototype-pollution key.");
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      apiFail(path, "accessor_field", "must contain only enumerable data fields.");
    }
    result[key] = descriptor.value;
  }
  return result;
}

export function readSafeArray(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (typeof value === "object" && value !== null && utilTypes.isProxy(value)) {
    apiFail(path, "proxy_array", "cannot be a proxy.");
  }
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    apiFail(path, "not_array", "must be a plain array.");
  }
  if (value.length > maximum) {
    apiFail(path, "too_many_items", `cannot contain more than ${maximum} items.`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== "string")) {
    apiFail(path, "sparse_array", "must be dense and contain no custom fields.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      apiFail(`${path}[${index}]`, "accessor_item", "must be an enumerable data element.");
    }
  }
  return value;
}

export function ensureExactAndPresent(
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  ensureAllowedKeys(record, keys, path);
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) {
      apiFail(`${path}.${key}`, "missing_field", "is required.");
    }
  }
}

export function ensureAllowedKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    apiFail(path, "unexpected_fields", "contains unexpected fields.");
  }
}

export function ensureIdentifier(
  value: unknown,
  path: string,
  maximum: number = API_LIMITS.maxIdentifierLength,
): string {
  return validation.ensureString(value, path, {
    maxLength: maximum,
    pattern: /^[a-z][A-Za-z0-9]*(?:[._:-][A-Za-z0-9]+)*$/u,
    patternName: "bounded identifier",
  });
}

export function ensureRuleId(value: unknown, path: string): string {
  return validation.ensureString(value, path, {
    maxLength: 64,
    pattern: /^[A-Z][A-Z0-9]*(?:[-_.][A-Z0-9]+)*$/u,
    patternName: "rule identifier",
  });
}

export function assertSafeString(
  value: string,
  path: string,
  options: Readonly<{ allowDigest?: boolean }> = {},
): void {
  if (value.length > API_LIMITS.maxProjectionStringLength) {
    apiFail(path, "string_too_long", "exceeds the projection string limit.");
  }
  for (const pattern of SECRET_SHAPES) {
    if (options.allowDigest === true && (pattern === LONG_HEX_SHAPE || pattern === LONG_BASE64_SHAPE)) continue;
    if (pattern.test(value)) {
      apiFail(path, "credential_shape", "contains a prohibited credential-shaped value.");
    }
  }
}

export function assertNormalSafeString(value: string, path: string): void {
  if (NORMAL_MECHANISM_SHAPE.test(value)) {
    apiFail(path, "normal_mechanism_leak", "contains a prohibited implementation-mechanism value in Normal mode.");
  }
}

export function assertProjectionFieldName(name: string, path: string): void {
  if (!/^[a-z][A-Za-z0-9]{0,63}$/u.test(name)) {
    apiFail(path, "bad_field_name", "must be a bounded camel-case field name.");
  }
  if (CREDENTIAL_KEY.test(name)) {
    apiFail(path, "credential_field", "is a prohibited credential or raw-body field.");
  }
  if (BORROWED_OWNER_KEY.test(name)) {
    apiFail(path, "owner_identity_field", "is a prohibited owner-identity field.");
  }
  if (FINGERPRINT_KEY.test(name) && !isSourceFingerprintField(name)) {
    apiFail(path, "fingerprint_field", "is a prohibited generic fingerprint field.");
  }
}

export function isSourceFingerprintField(name: string): boolean {
  return name.toLowerCase() === "sourcefingerprint";
}

export function isProfileIdField(name: string): boolean {
  return name.toLowerCase().endsWith("profileid");
}

export function isPathField(name: string): boolean {
  return /(?:^path$|path$|root$|directory$)/iu.test(name);
}

export function isAbsolutePath(value: string): boolean {
  return WINDOWS_ABSOLUTE_PATH.test(value) || POSIX_ABSOLUTE_PATH.test(value);
}
