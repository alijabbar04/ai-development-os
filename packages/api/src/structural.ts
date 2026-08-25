import { ValidationError, validation } from "@ai-dev-os/domain";
import { types as utilTypes } from "node:util";
import { API_LIMITS } from "./constants.js";

const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CREDENTIAL_KEY = /(?:credential|secret|api[_-]?key|password|raw[_-]?body|response[_-]?body)/iu;
const BORROWED_OWNER_KEY = /(?:borrowed.*owner|owner.*(?:identity|email|name|account))/iu;
const CREDENTIAL_SHAPE = /(?:sk-ant-api\d{2}-|sk-proj-|sk-[A-Za-z0-9_-]{24,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/u;
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
  return value;
}

export function ensureExactAndPresent(
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  validation.ensureExactKeys(record, keys, path);
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) {
      apiFail(`${path}.${key}`, "missing_field", "is required.");
    }
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

export function assertSafeString(value: string, path: string): void {
  if (value.length > API_LIMITS.maxProjectionStringLength) {
    apiFail(path, "string_too_long", "exceeds the projection string limit.");
  }
  if (CREDENTIAL_SHAPE.test(value)) {
    apiFail(path, "credential_shape", "contains a prohibited credential-shaped value.");
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
}

export function isSourceFingerprintField(name: string): boolean {
  return name.toLowerCase() === "sourcefingerprint";
}

export function isPathField(name: string): boolean {
  return /(?:^path$|path$|root$|directory$)/iu.test(name);
}

export function isAbsolutePath(value: string): boolean {
  return WINDOWS_ABSOLUTE_PATH.test(value) || POSIX_ABSOLUTE_PATH.test(value);
}
