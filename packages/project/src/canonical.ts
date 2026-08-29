import { refuse } from "./errors.js";

export type CanonicalJsonPrimitive = boolean | number | string | null;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

const FORBIDDEN_KEYS = Object.freeze(["__proto__", "constructor", "prototype"] as const);
const MAX_DEPTH = 64;
const MAX_NODES = 100_000;
const MAX_STRING = 1_000_000;
const ZERO_WIDTH_PATTERN = /[\u200B-\u200D\u2060\uFEFF]/u;
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

function canonicalize(
  value: unknown,
  path: string,
  depth: number,
  active: WeakSet<object>,
  counter: { count: number },
): CanonicalJsonValue {
  counter.count += 1;
  if (counter.count > MAX_NODES || depth > MAX_DEPTH) {
    refuse("PROJECT_VALIDATION_REFUSED", path, "The JSON value exceeds the canonicalization bounds.");
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && value.length > MAX_STRING) {
      refuse("PROJECT_VALIDATION_REFUSED", path, "The JSON string exceeds the contract bound.");
    }
    if (typeof value === "string" && (value !== value.normalize("NFC") || ZERO_WIDTH_PATTERN.test(value) || CONTROL_PATTERN.test(value))) {
      refuse("PROJECT_VALIDATION_REFUSED", path, "Canonical JSON text is not in the accepted normalized form.");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      refuse("PROJECT_VALIDATION_REFUSED", path, "Canonical JSON numbers must be finite.");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    refuse("PROJECT_VALIDATION_REFUSED", path, "The value is not canonical JSON.");
  }
  if (active.has(value)) {
    refuse("PROJECT_VALIDATION_REFUSED", path, "Canonical JSON cannot contain cycles.");
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) {
        refuse("PROJECT_VALIDATION_REFUSED", path, "Only plain JSON arrays are accepted.");
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const lengthDescriptor = descriptors["length"] as PropertyDescriptor | undefined;
      if (lengthDescriptor === undefined || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) {
        refuse("PROJECT_VALIDATION_REFUSED", path, "The JSON array length is not canonical.");
      }
      const length = lengthDescriptor.value as number;
      if (length > 10_000) {
        refuse("PROJECT_VALIDATION_REFUSED", path, "The JSON array exceeds the contract bound.");
      }
      const keys = Object.keys(descriptors);
      if (keys.length !== length + 1 || !Object.hasOwn(descriptors, "length")) {
        refuse("PROJECT_VALIDATION_REFUSED", path, "Sparse arrays and extra array properties are not accepted.");
      }
      const output: CanonicalJsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
          refuse("PROJECT_VALIDATION_REFUSED", path, "Sparse arrays and array accessors are not accepted.");
        }
        output.push(canonicalize(descriptor.value, `${path}[${index}]`, depth + 1, active, counter));
      }
      return Object.freeze(output);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      refuse("PROJECT_VALIDATION_REFUSED", path, "Only plain JSON objects are accepted.");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length > 0) {
      refuse("PROJECT_VALIDATION_REFUSED", path, "Symbol properties are not accepted.");
    }
    const output = Object.create(null) as Record<string, CanonicalJsonValue>;
    const keys = Object.keys(descriptors).sort();
    for (const key of keys) {
      if ((FORBIDDEN_KEYS as readonly string[]).includes(key)) {
        refuse("PROJECT_VALIDATION_REFUSED", path, "Prototype-sensitive keys are not accepted.");
      }
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        refuse("PROJECT_VALIDATION_REFUSED", path, "Accessors and hidden properties are not accepted.");
      }
      output[key] = canonicalize(descriptor.value, `${path}.${key}`, depth + 1, active, counter);
    }
    return Object.freeze(output);
  } finally {
    active.delete(value);
  }
}

export function canonicalizeProjectJson(value: unknown, _callerPath?: string): CanonicalJsonValue {
  try {
    return canonicalize(value, "canonical", 0, new WeakSet<object>(), { count: 0 });
  } catch {
    return refuse("PROJECT_VALIDATION_REFUSED", "canonical", "The value is not canonical project JSON.");
  }
}

export function serializeCanonicalProjectJson(value: unknown): string {
  return JSON.stringify(canonicalizeProjectJson(value));
}
