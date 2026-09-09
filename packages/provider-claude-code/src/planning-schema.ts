import { canonicalizeJson, toCanonicalJson, type JsonValue } from "@ai-dev-os/domain";
import { ProviderError } from "@ai-dev-os/providers";

const SCHEMA_KEYS = new Set([
  "$schema", "$id", "title", "description", "type", "const", "enum", "properties",
  "required", "additionalProperties", "items", "minItems", "maxItems", "uniqueItems",
  "minLength", "maxLength", "pattern", "minimum", "maximum",
]);
// These finite expressions cover the canonical thinker IDs and digests. Schema
// input never supplies an arbitrary executable regular expression.
const PATTERNS = new Map<string, RegExp>([
  ["^[0-9a-f]{64}$", /^[0-9a-f]{64}$/u],
  ["^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u],
  ["^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u],
]);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function fail(schema: boolean): never {
  throw new ProviderError(schema ? "UNSUPPORTED_CAPABILITY" : "MALFORMED_RESPONSE",
    schema ? "The planning output schema is outside the finite supported schema contract."
      : "The planning response does not satisfy its exact output schema.");
}

function record(value: unknown, schema: boolean): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(schema);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => FORBIDDEN_KEYS.has(key))) fail(schema);
  return result;
}

function integer(value: unknown, low: number, high: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < low || value > high) fail(true);
  return value;
}

function checkSchema(value: unknown, depth: number): void {
  if (depth > 12) fail(true);
  const schema = record(value, true);
  if (Object.keys(schema).some((key) => !SCHEMA_KEYS.has(key))) fail(true);
  for (const key of ["$schema", "$id", "title", "description"]) {
    if (schema[key] !== undefined && (typeof schema[key] !== "string" || schema[key].length > 4_000)) fail(true);
  }
  if (Object.hasOwn(schema, "const")) {
    if (Object.keys(schema).some((key) => !["const", "title", "description"].includes(key))) fail(true);
    if (schema["const"] !== null && !["string", "boolean", "number"].includes(typeof schema["const"])) fail(true);
    return;
  }
  const type = schema["type"];
  if (!["object", "array", "string", "integer", "boolean", "null"].includes(type as string)) fail(true);
  if (schema["enum"] !== undefined) {
    if (!Array.isArray(schema["enum"]) || schema["enum"].length === 0 || schema["enum"].length > 64) fail(true);
    for (const item of schema["enum"]) {
      if ((type === "integer" ? !Number.isSafeInteger(item) : typeof item !== type) && !(type === "null" && item === null)) fail(true);
    }
    if (new Set(schema["enum"].map((item: unknown) => toCanonicalJson(item))).size !== schema["enum"].length) fail(true);
  }
  const common = ["$schema", "$id", "title", "description", "type", "enum"];
  let specific: string[];
  switch (type) {
    case "object": {
      specific = ["properties", "required", "additionalProperties"];
      const properties = record(schema["properties"], true);
      const keys = Object.keys(properties);
      if (keys.length > 64 || schema["additionalProperties"] !== false || !Array.isArray(schema["required"])) fail(true);
      if (schema["required"].length !== keys.length || new Set(schema["required"]).size !== keys.length || keys.some((key) => !(schema["required"] as unknown[]).includes(key))) fail(true);
      for (const child of Object.values(properties)) checkSchema(child, depth + 1);
      break;
    }
    case "array":
      specific = ["items", "minItems", "maxItems", "uniqueItems"];
      integer(schema["maxItems"], 0, 64);
      if (schema["minItems"] !== undefined) integer(schema["minItems"], 0, schema["maxItems"] as number);
      if (schema["uniqueItems"] !== undefined && typeof schema["uniqueItems"] !== "boolean") fail(true);
      checkSchema(schema["items"], depth + 1);
      break;
    case "string":
      specific = ["minLength", "maxLength", "pattern"];
      if (schema["maxLength"] === undefined && schema["enum"] === undefined && schema["pattern"] === undefined) fail(true);
      if (schema["maxLength"] !== undefined) integer(schema["maxLength"], 0, 16_384);
      if (schema["minLength"] !== undefined) integer(schema["minLength"], 0, (schema["maxLength"] as number | undefined) ?? 16_384);
      if (schema["pattern"] !== undefined && !PATTERNS.has(schema["pattern"] as string)) fail(true);
      break;
    case "integer":
      specific = ["minimum", "maximum"];
      integer(schema["minimum"], -1_000_000_000, 1_000_000_000);
      integer(schema["maximum"], schema["minimum"] as number, 1_000_000_000);
      break;
    default:
      specific = [];
  }
  if (Object.keys(schema).some((key) => !common.includes(key) && !specific.includes(key))) fail(true);
}

/** A closed, bounded JSON-schema subset; unsupported keywords fail before admission. */
export function validatePlanningJsonSchema(value: unknown): JsonValue {
  const schema = canonicalizeJson(value);
  if (Buffer.byteLength(toCanonicalJson(schema), "utf8") > 16_384) fail(true);
  checkSchema(schema, 0);
  if (record(schema, true)["type"] !== "object") fail(true);
  return schema;
}

function checkValue(value: unknown, schema: Record<string, unknown>, depth: number): void {
  if (depth > 12) fail(false);
  if (Object.hasOwn(schema, "const")) {
    if (toCanonicalJson(value) !== toCanonicalJson(schema["const"])) fail(false);
    return;
  }
  if (schema["enum"] !== undefined && !(schema["enum"] as unknown[]).some((item) => toCanonicalJson(item) === toCanonicalJson(value))) fail(false);
  switch (schema["type"]) {
    case "object": {
      const output = record(value, false);
      const properties = schema["properties"] as Record<string, Record<string, unknown>>;
      if (Object.keys(output).length !== Object.keys(properties).length || Object.keys(properties).some((key) => !Object.hasOwn(output, key))) fail(false);
      for (const [key, child] of Object.entries(properties)) checkValue(output[key], child, depth + 1);
      return;
    }
    case "array":
      if (!Array.isArray(value) || value.length > (schema["maxItems"] as number) || value.length < ((schema["minItems"] as number | undefined) ?? 0)) fail(false);
      if (schema["uniqueItems"] === true && new Set(value.map((item) => toCanonicalJson(item))).size !== value.length) fail(false);
      for (const item of value) checkValue(item, schema["items"] as Record<string, unknown>, depth + 1);
      return;
    case "string":
      if (typeof value !== "string" || value.length > ((schema["maxLength"] as number | undefined) ?? 16_384) || value.length < ((schema["minLength"] as number | undefined) ?? 0)) fail(false);
      if (schema["pattern"] !== undefined && !PATTERNS.get(schema["pattern"] as string)!.test(value)) fail(false);
      return;
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (schema["minimum"] as number) || value > (schema["maximum"] as number)) fail(false);
      return;
    case "boolean":
      if (typeof value !== "boolean") fail(false);
      return;
    case "null":
      if (value !== null) fail(false);
      return;
    default:
      fail(false);
  }
}

export function validatePlanningStructuredOutput(value: unknown, schema: unknown): JsonValue {
  const checked = validatePlanningJsonSchema(schema);
  const output = canonicalizeJson(value);
  if (Buffer.byteLength(toCanonicalJson(output), "utf8") > 262_144) fail(false);
  checkValue(output, checked as Record<string, unknown>, 0);
  return output;
}
