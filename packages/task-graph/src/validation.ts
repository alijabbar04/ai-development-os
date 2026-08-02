import { TaskGraphError, type TaskGraphErrorCode } from "./errors.js";
import type { JsonObject, JsonValue, TaskFailure, TaskNode } from "./types.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KIND_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const FAILURE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;
const DANGEROUS_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;
const MAX_JSON_STRING_LENGTH = 100_000;
const MAX_DATA_OBJECT_FIELDS = 10_000;

export function copyPlainDataRecord(
  value: unknown,
  label: string,
  code: TaskGraphErrorCode,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TaskGraphError(code, `${label} must be a plain data object.`);
  }

  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TaskGraphError(code, `${label} must be a plain data object.`);
    }

    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_DATA_OBJECT_FIELDS) {
      throw new TaskGraphError(code, `${label} exceeds its field limit.`, {
        maximum: MAX_DATA_OBJECT_FIELDS,
      });
    }
    if (keys.some((key) => typeof key !== "string")) {
      throw new TaskGraphError(code, `${label} cannot contain symbol fields.`);
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new TaskGraphError(
          code,
          `${label} fields must be enumerable data properties.`,
          { key },
        );
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof TaskGraphError) {
      throw error;
    }
    throw new TaskGraphError(code, `${label} could not be inspected safely.`);
  }
}

export function copyDenseDataArray(
  value: unknown,
  label: string,
  maximumLength: number,
  code: TaskGraphErrorCode,
): unknown[] {
  if (!Array.isArray(value)) {
    throw new TaskGraphError(code, `${label} must be an array.`);
  }

  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TaskGraphError(code, `${label} must be a plain array.`);
    }

    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const lengthValue = lengthDescriptor?.value as unknown;
    if (
      typeof lengthValue !== "number" ||
      !Number.isSafeInteger(lengthValue) ||
      lengthValue < 0 ||
      lengthValue > maximumLength
    ) {
      throw new TaskGraphError(code, `${label} exceeds its item limit.`, {
        maximum: maximumLength,
        length: lengthValue,
      });
    }
    const length = lengthValue;

    const keys = Reflect.ownKeys(value);
    const expectedKeyCount = length + 1;
    if (keys.length !== expectedKeyCount || keys.some((key) => typeof key !== "string")) {
      throw new TaskGraphError(
        code,
        `${label} must be dense and cannot contain custom fields.`,
      );
    }

    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor | undefined
    >;
    const result: unknown[] = new Array<unknown>(length);
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new TaskGraphError(
          code,
          `${label} must contain only indexed data properties without holes.`,
          { index },
        );
      }
      result[index] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof TaskGraphError) {
      throw error;
    }
    throw new TaskGraphError(code, `${label} could not be inspected safely.`);
  }
}

export function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
  code: TaskGraphErrorCode,
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));

  if (unexpected.length > 0) {
    throw new TaskGraphError(code, `${label} contains unexpected fields.`, {
      fields: unexpected.sort(),
    });
  }
}

export function assertIdentifier(
  value: unknown,
  label: string,
  code: TaskGraphErrorCode = "INVALID_ARGUMENT",
): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new TaskGraphError(
      code,
      `${label} must match ${IDENTIFIER_PATTERN.source}.`,
      { label, value },
    );
  }

  return value;
}

export function assertKind(
  value: unknown,
  code: TaskGraphErrorCode = "INVALID_ARGUMENT",
): string {
  if (typeof value !== "string" || !KIND_PATTERN.test(value)) {
    throw new TaskGraphError(code, `Task kind must match ${KIND_PATTERN.source}.`, {
      value,
    });
  }

  return value;
}

export function normalizeRequiredText(
  value: unknown,
  label: string,
  maximumLength: number,
  code: TaskGraphErrorCode = "INVALID_ARGUMENT",
): string {
  if (typeof value !== "string") {
    throw new TaskGraphError(code, `${label} must be a string.`, { label });
  }

  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new TaskGraphError(
      code,
      `${label} must contain between 1 and ${maximumLength} characters.`,
      { label, length: normalized.length },
    );
  }

  return normalized;
}

export function normalizeOptionalText(
  value: unknown,
  label: string,
  maximumLength: number,
  code: TaskGraphErrorCode = "INVALID_ARGUMENT",
): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new TaskGraphError(code, `${label} must be a string when provided.`, {
      label,
    });
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return null;
  }

  if (normalized.length > maximumLength) {
    throw new TaskGraphError(
      code,
      `${label} cannot exceed ${maximumLength} characters.`,
      { label, length: normalized.length },
    );
  }

  return normalized;
}

export function assertInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  code: TaskGraphErrorCode = "INVALID_ARGUMENT",
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TaskGraphError(
      code,
      `${label} must be a safe integer between ${minimum} and ${maximum}.`,
      { label, value },
    );
  }

  return Object.is(value, -0) ? 0 : value;
}

export function assertBoolean(
  value: unknown,
  label: string,
  code: TaskGraphErrorCode,
): boolean {
  if (typeof value !== "boolean") {
    throw new TaskGraphError(code, `${label} must be a boolean.`, { label });
  }

  return value;
}

export function assertCanonicalTimestamp(
  value: unknown,
  label: string,
  code: TaskGraphErrorCode,
): string {
  if (typeof value !== "string") {
    throw new TaskGraphError(code, `${label} must be an ISO timestamp.`, { label });
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new TaskGraphError(
      code,
      `${label} must be a canonical ISO-8601 UTC timestamp.`,
      { label, value },
    );
  }

  return value;
}

export function readClock(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TaskGraphError("INVALID_ARGUMENT", "The graph clock returned an invalid Date.");
  }

  return value.toISOString();
}

export function cloneAndFreezeJsonObject(
  value: unknown,
  label: string,
  code: TaskGraphErrorCode = "INVALID_ARGUMENT",
): JsonObject {
  const state = { nodes: 0, active: new WeakSet<object>() };
  const cloned = cloneJsonValue(value, label, 0, state, code);

  if (typeof cloned !== "object" || cloned === null || Array.isArray(cloned)) {
    throw new TaskGraphError(code, `${label} must be a JSON object.`, { label });
  }

  return cloned as JsonObject;
}

function cloneJsonValue(
  value: unknown,
  path: string,
  depth: number,
  state: { nodes: number; active: WeakSet<object> },
  code: TaskGraphErrorCode,
): JsonValue {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES) {
    throw new TaskGraphError(code, `${path} exceeds the JSON node limit.`, {
      maximum: MAX_JSON_NODES,
    });
  }

  if (depth > MAX_JSON_DEPTH) {
    throw new TaskGraphError(code, `${path} exceeds the JSON depth limit.`, {
      maximum: MAX_JSON_DEPTH,
    });
  }

  if (value === null || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TaskGraphError(code, `${path} contains a non-finite number.`);
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (typeof value === "string") {
    if (value.length > MAX_JSON_STRING_LENGTH) {
      throw new TaskGraphError(code, `${path} contains an oversized string.`, {
        maximum: MAX_JSON_STRING_LENGTH,
      });
    }
    return value;
  }

  if (typeof value !== "object" || value === undefined) {
    throw new TaskGraphError(code, `${path} contains a non-JSON value.`);
  }

  if (state.active.has(value)) {
    throw new TaskGraphError(code, `${path} contains a cyclic object reference.`);
  }

  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      const source = copyDenseDataArray(
        value,
        path,
        MAX_JSON_NODES - state.nodes,
        code,
      );
      const result: JsonValue[] = [];
      for (let index = 0; index < source.length; index += 1) {
        result.push(
          cloneJsonValue(source[index], `${path}[${index}]`, depth + 1, state, code),
        );
      }
      return Object.freeze(result);
    }

    const source = copyPlainDataRecord(value, path, code);
    const result: Record<string, JsonValue> = Object.create(null) as Record<
      string,
      JsonValue
    >;

    for (const key of Object.keys(source).sort()) {
      if (DANGEROUS_OBJECT_KEYS.has(key)) {
        throw new TaskGraphError(code, `${path} contains a forbidden object key.`, {
          key,
        });
      }
      result[key] = cloneJsonValue(
        source[key],
        `${path}.${key}`,
        depth + 1,
        state,
        code,
      );
    }

    return Object.freeze(result) as JsonObject;
  } finally {
    state.active.delete(value);
  }
}

export function cloneAndFreezeFailure(failure: TaskFailure): TaskFailure {
  return Object.freeze({ ...failure });
}

export function cloneAndFreezeTask(task: TaskNode): TaskNode {
  return Object.freeze({
    ...task,
    dependencies: Object.freeze([...task.dependencies]),
    metadata: cloneAndFreezeJsonObject(task.metadata, "task.metadata"),
    blockedBy: Object.freeze([...task.blockedBy]),
    outputArtifactIds: Object.freeze([...task.outputArtifactIds]),
    failure: task.failure === null ? null : cloneAndFreezeFailure(task.failure),
  });
}

export function parseFailure(
  value: unknown,
  code: TaskGraphErrorCode,
): TaskFailure {
  const record = copyPlainDataRecord(value, "Task failure", code);

  assertExactKeys(record, ["code", "message", "retryable"], "Task failure", code);

  const failureCode = record["code"];
  if (typeof failureCode !== "string" || !FAILURE_CODE_PATTERN.test(failureCode)) {
    throw new TaskGraphError(
      code,
      `Failure code must match ${FAILURE_CODE_PATTERN.source}.`,
      { value: failureCode },
    );
  }

  const message = normalizeRequiredText(record["message"], "Failure message", 4_000, code);
  const retryable = assertBoolean(record["retryable"], "Failure retryable", code);

  return Object.freeze({ code: failureCode, message, retryable });
}
