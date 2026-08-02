import { SerializationError } from "./errors.js";
import { ensureArray, ensureRecord } from "./internal/guards.js";
import { ValidationError } from "./errors.js";

export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export const JSON_LIMITS = Object.freeze({
  maxDepth: 64,
  maxNodes: 100_000,
  maxStringLength: 1_000_000,
  maxTextLength: 10_000_000,
});

interface CloneState {
  nodes: number;
  readonly active: WeakSet<object>;
}

/**
 * Produces a frozen, canonical copy of a JSON-compatible value:
 * object keys sorted, null prototypes, `-0` normalized to `0`, and
 * NaN/Infinity, cycles, exotic objects, prototype-pollution keys, and
 * oversized payloads rejected.
 */
export function canonicalizeJson(value: unknown, label = "value"): JsonValue {
  const state: CloneState = { nodes: 0, active: new WeakSet<object>() };
  return cloneJsonValue(value, label, 0, state);
}

function cloneJsonValue(
  value: unknown,
  path: string,
  depth: number,
  state: CloneState,
): JsonValue {
  state.nodes += 1;
  if (state.nodes > JSON_LIMITS.maxNodes) {
    throw new SerializationError(`${path} exceeds the JSON node limit.`, {
      maximum: JSON_LIMITS.maxNodes,
    });
  }
  if (depth > JSON_LIMITS.maxDepth) {
    throw new SerializationError(`${path} exceeds the JSON depth limit.`, {
      maximum: JSON_LIMITS.maxDepth,
    });
  }

  if (value === null || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SerializationError(`${path} contains a non-finite number.`);
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (typeof value === "string") {
    if (value.length > JSON_LIMITS.maxStringLength) {
      throw new SerializationError(`${path} contains an oversized string.`, {
        maximum: JSON_LIMITS.maxStringLength,
      });
    }
    return value;
  }

  if (typeof value !== "object") {
    throw new SerializationError(`${path} contains a non-JSON value of type ${typeof value}.`);
  }

  if (state.active.has(value)) {
    throw new SerializationError(`${path} contains a cyclic object reference.`);
  }

  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      const source = toSerializationInput(() =>
        ensureArray(value, path, JSON_LIMITS.maxNodes),
      );
      const result: JsonValue[] = [];
      source.forEach((item, index) => {
        result.push(cloneJsonValue(item, `${path}[${index}]`, depth + 1, state));
      });
      return Object.freeze(result);
    }

    const source = toSerializationInput(() => ensureRecord(value, path));
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(source).sort()) {
      result[key] = cloneJsonValue(source[key], `${path}.${key}`, depth + 1, state);
    }
    return Object.freeze(result) as JsonObject;
  } finally {
    state.active.delete(value);
  }
}

function toSerializationInput<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new SerializationError(error.message, { issueCount: error.issues.length });
    }
    throw error;
  }
}

/**
 * Deterministic JSON serialization: identical values always produce an
 * identical string regardless of original key insertion order.
 */
export function toCanonicalJson(value: unknown, label = "value"): string {
  return JSON.stringify(canonicalizeJson(value, label));
}

/**
 * Parses untrusted JSON text into a frozen canonical value. Prototype
 * pollution keys, oversized payloads, and malformed text are rejected with
 * a SerializationError.
 */
export function parseJsonText(text: string, label = "text"): JsonValue {
  if (typeof text !== "string" || text.length > JSON_LIMITS.maxTextLength) {
    throw new SerializationError(`${label} must be a JSON string within the size limit.`, {
      maximum: JSON_LIMITS.maxTextLength,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new SerializationError(`${label} is not valid JSON.`);
  }

  return canonicalizeJson(parsed, label);
}

/** Deterministic deep equality over JSON-compatible values. */
export function jsonEquals(a: unknown, b: unknown): boolean {
  return toCanonicalJson(a) === toCanonicalJson(b);
}
