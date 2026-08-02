import { ValidationError } from "../errors.js";

/**
 * Internal runtime validator.
 *
 * The repository's established validation approach (see @ai-dev-os/task-graph)
 * is a minimal internal validator with zero runtime dependencies. This module
 * follows the same convention. Guard error messages never echo raw input
 * values; they carry only the path, a stable issue code, and structural
 * summaries such as lengths, so hostile or secret-bearing input cannot leak
 * through error messages, logs, or serialized error details.
 */

const DANGEROUS_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function fail(path: string, code: string, message: string): never {
  throw new ValidationError(`${path}: ${message}`, [{ path, code, message }]);
}

export function ensureRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "not_object", "must be a plain object.");
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, "exotic_object", "must be a plain data object without a custom prototype.");
  }

  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    fail(path, "symbol_key", "cannot contain symbol-keyed fields.");
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    if (DANGEROUS_OBJECT_KEYS.has(key)) {
      fail(path, "forbidden_key", `contains the forbidden object key "${key}".`);
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      fail(path, "accessor_field", "fields must be enumerable data properties.");
    }
    result[key] = descriptor.value;
  }
  return result;
}

export function ensureExactKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    fail(path, "unexpected_fields", `contains unexpected fields: ${unexpected.sort().join(", ")}.`);
  }
}

export interface StringRule {
  readonly minLength?: number;
  readonly maxLength: number;
  readonly pattern?: RegExp;
  readonly patternName?: string;
}

export function ensureString(value: unknown, path: string, rule: StringRule): string {
  if (typeof value !== "string") {
    fail(path, "not_string", "must be a string.");
  }
  const minLength = rule.minLength ?? 1;
  if (value.length < minLength || value.length > rule.maxLength) {
    fail(
      path,
      "bad_length",
      `must contain between ${minLength} and ${rule.maxLength} characters (received length ${value.length}).`,
    );
  }
  if (rule.pattern !== undefined && !rule.pattern.test(value)) {
    fail(path, "bad_format", `must be a valid ${rule.patternName ?? "value"}.`);
  }
  return value;
}

export function ensureEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(path, "bad_enum", `must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

export function ensureSafeInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(path, "bad_integer", `must be a safe integer between ${minimum} and ${maximum}.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

export function ensureBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    fail(path, "not_boolean", "must be a boolean.");
  }
  return value;
}

export function ensureTimestamp(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length > 30) {
    fail(path, "not_timestamp", "must be a canonical ISO-8601 UTC timestamp string.");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    fail(path, "not_canonical_timestamp", "must be a canonical ISO-8601 UTC timestamp.");
  }
  return value;
}

export function ensureArray(value: unknown, path: string, maxItems: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(path, "not_array", "must be a plain array.");
  }
  if (value.length > maxItems) {
    fail(path, "too_many_items", `cannot contain more than ${maxItems} items.`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== "string")) {
    fail(path, "sparse_array", "must be dense and cannot contain custom fields.");
  }
  return [...(value as unknown[])];
}

/** Returns a sorted, de-duplicated, frozen array of enum members. */
export function ensureEnumArray<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
  maxItems: number,
): readonly T[] {
  const items = ensureArray(value, path, maxItems);
  const seen = new Set<T>();
  items.forEach((item, index) => {
    seen.add(ensureEnum(item, `${path}[${index}]`, allowed));
  });
  return Object.freeze([...seen].sort());
}

/** Missing and null are both normalized to null so serialized forms stay stable. */
export function ensureNullable<T>(
  value: unknown,
  parse: (value: unknown) => T,
): T | null {
  if (value === undefined || value === null) {
    return null;
  }
  return parse(value);
}

export function ensureSchemaVersion(value: unknown, path: string, expected: number): void {
  if (value !== expected) {
    fail(
      path,
      "unsupported_schema_version",
      `must be the supported schema version ${expected}.`,
    );
  }
}
