import type { JsonValue } from "@ai-dev-os/domain";
import { ProviderError } from "@ai-dev-os/providers";

type Schema = Record<string, unknown>;
type SchemaNode = Schema | boolean;

const MAX_DEPTH = 32;
const MAX_SCHEMA_NODES = 256;
const MAX_SCHEMA_COLLECTION = 64;
const MAX_ENUM_VALUES = 128;
const MAX_EVALUATION_STEPS = 131_072;
const JSON_TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
const SUPPORTED = new Set([
  "type", "enum", "const", "properties", "required", "additionalProperties",
  "items", "prefixItems", "minItems", "maxItems", "minLength", "maxLength",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "anyOf", "oneOf", "allOf", "not", "$ref", "$defs", "definitions",
  "$schema", "$id", "title", "description", "default", "examples",
]);

class SchemaEvaluationFailure extends Error {
  constructor(
    readonly violationPath: string,
    readonly violationCode: string,
  ) {
    super("Structured-schema evaluation stopped at a bounded structural location.");
    this.name = "SchemaEvaluationFailure";
  }
}

function stopEvaluation(path: string, code: string): never {
  throw new SchemaEvaluationFailure(path, code);
}

function object(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaNode(value: unknown): value is SchemaNode {
  return typeof value === "boolean" || object(value);
}

function invalidSchema(code: string): never {
  throw new ProviderError(
    "INVALID_REQUEST",
    "Anthropic structured-output schema is invalid.",
    { violationCode: code },
  );
}

function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => equal(item, right[index]));
  }
  if (object(left) && object(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index]) &&
      leftKeys.every((key) => equal(left[key], right[key]));
  }
  return false;
}

function jsonType(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function resolve(root: Schema, reference: unknown): SchemaNode | null {
  if (reference === "#") return root;
  if (typeof reference !== "string") return null;
  const match = /^#\/(\$defs|definitions)\/([A-Za-z0-9_.-]{1,128})$/.exec(reference);
  if (match === null) return null;
  const bucket = root[match[1]!];
  if (!object(bucket)) return null;
  const target = bucket[match[2]!];
  return schemaNode(target) ? target : null;
}

function assertNonnegativeInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalidSchema(code);
  return value as number;
}

function assertFiniteNumber(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalidSchema(code);
  return value;
}

function assertWellFormedNode(
  root: Schema,
  value: unknown,
  depth: number,
  state: { readonly visited: WeakSet<object>; nodes: number },
): void {
  if (depth > MAX_DEPTH) invalidSchema("schema-too-deep");
  if (typeof value === "boolean") return;
  if (!object(value)) invalidSchema("invalid-schema");
  if (state.visited.has(value)) return;
  state.visited.add(value);
  state.nodes += 1;
  if (state.nodes > MAX_SCHEMA_NODES) invalidSchema("schema-node-limit");

  if (Object.keys(value).some((key) => !SUPPORTED.has(key))) invalidSchema("unsupported-keyword");

  if ("type" in value) {
    const types = Array.isArray(value["type"]) ? value["type"] as unknown[] : [value["type"]];
    if (types.length === 0 || types.some((item) => typeof item !== "string" || !JSON_TYPES.has(item)) ||
        new Set(types).size !== types.length) {
      invalidSchema("invalid-type");
    }
  }
  if ("enum" in value) {
    if (!Array.isArray(value["enum"]) || value["enum"].length === 0) invalidSchema("invalid-enum");
    if (value["enum"].length > MAX_ENUM_VALUES) invalidSchema("schema-enum-limit");
  }
  if ("properties" in value) {
    const properties = value["properties"];
    if (!object(properties)) invalidSchema("invalid-properties");
    const nestedValues = Object.values(properties);
    if (nestedValues.length > MAX_SCHEMA_COLLECTION) invalidSchema("schema-collection-limit");
    for (const nested of nestedValues) assertWellFormedNode(root, nested, depth + 1, state);
  }
  if ("required" in value) {
    const required = value["required"];
    if (!Array.isArray(required) || required.some((item) => typeof item !== "string") ||
        required.length > MAX_SCHEMA_COLLECTION || new Set(required).size !== required.length) {
      invalidSchema("invalid-required");
    }
  }
  for (const keyword of ["additionalProperties", "items", "not"] as const) {
    if (keyword in value && !schemaNode(value[keyword])) invalidSchema(`invalid-${keyword}`);
    if (keyword in value) assertWellFormedNode(root, value[keyword], depth + 1, state);
  }
  if ("prefixItems" in value) {
    const prefix = value["prefixItems"];
    if (!Array.isArray(prefix)) invalidSchema("invalid-prefixItems");
    if (prefix.length > MAX_SCHEMA_COLLECTION) invalidSchema("schema-collection-limit");
    for (const nested of prefix) assertWellFormedNode(root, nested, depth + 1, state);
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    if (!(keyword in value)) continue;
    const branches = value[keyword];
    if (!Array.isArray(branches) || branches.length === 0) invalidSchema(`invalid-${keyword}`);
    if (branches.length > MAX_SCHEMA_COLLECTION) invalidSchema("schema-collection-limit");
    for (const nested of branches) assertWellFormedNode(root, nested, depth + 1, state);
  }
  for (const keyword of ["$defs", "definitions"] as const) {
    if (!(keyword in value)) continue;
    const definitions = value[keyword];
    if (!object(definitions)) invalidSchema(`invalid-${keyword}`);
    const nestedValues = Object.values(definitions);
    if (nestedValues.length > MAX_SCHEMA_COLLECTION) invalidSchema("schema-collection-limit");
    for (const nested of nestedValues) assertWellFormedNode(root, nested, depth + 1, state);
  }
  if ("$ref" in value) {
    if (typeof value["$ref"] !== "string") invalidSchema("invalid-ref");
    const target = resolve(root, value["$ref"]);
    if (target === null) invalidSchema("unresolvable-ref");
    assertWellFormedNode(root, target, depth + 1, state);
  }

  for (const keyword of ["minItems", "maxItems", "minLength", "maxLength"] as const) {
    if (keyword in value) assertNonnegativeInteger(value[keyword], `invalid-${keyword}`);
  }
  if (typeof value["minItems"] === "number" && typeof value["maxItems"] === "number" &&
      value["minItems"] > value["maxItems"]) invalidSchema("invalid-item-bounds");
  if (typeof value["minLength"] === "number" && typeof value["maxLength"] === "number" &&
      value["minLength"] > value["maxLength"]) invalidSchema("invalid-length-bounds");
  for (const keyword of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) {
    if (keyword in value) assertFiniteNumber(value[keyword], `invalid-${keyword}`);
  }
  for (const keyword of ["$schema", "$id", "title", "description"] as const) {
    if (keyword in value && typeof value[keyword] !== "string") invalidSchema(`invalid-${keyword}`);
  }
  if ("examples" in value && (!Array.isArray(value["examples"]) || value["examples"].length > MAX_SCHEMA_COLLECTION)) {
    invalidSchema("invalid-examples");
  }
}

export function assertStructuredSchemaWellFormed(schema: JsonValue): void {
  if (!object(schema)) invalidSchema("invalid-root");
  assertWellFormedNode(schema, schema, 0, { visited: new WeakSet<object>(), nodes: 0 });
}

function check(
  root: Schema,
  schema: SchemaNode,
  value: JsonValue,
  path: string,
  depth: number,
  budget: { remaining: number },
): string | null {
  budget.remaining -= 1;
  if (budget.remaining < 0) stopEvaluation(path, "schema-work-limit");
  if (depth > MAX_DEPTH) stopEvaluation(path, "schema-too-deep");
  if (schema === true) return null;
  if (schema === false) return `${path}:forbidden`;
  if ("$ref" in schema) {
    const target = resolve(root, schema["$ref"]);
    if (target === null) stopEvaluation(path, "unresolvable-ref");
    const referencedViolation = check(root, target, value, path, depth + 1, budget);
    if (referencedViolation !== null) return referencedViolation;
  }
  const actual = jsonType(value);
  if ("type" in schema) {
    const allowed = Array.isArray(schema["type"]) ? schema["type"] as unknown[] : [schema["type"]];
    if (!allowed.some((item) => item === actual || item === "number" && actual === "integer")) return `${path}:type`;
  }
  if ("const" in schema && !equal(schema["const"], value)) return `${path}:const`;
  if ("enum" in schema && !(schema["enum"] as unknown[]).some((item) => equal(item, value))) return `${path}:enum`;
  if ("not" in schema && check(root, schema["not"] as SchemaNode, value, path, depth + 1, budget) === null) return `${path}:not`;
  if ("anyOf" in schema) {
    let matched = false;
    for (const branch of schema["anyOf"] as SchemaNode[]) {
      if (check(root, branch, value, path, depth + 1, budget) === null) {
        matched = true;
        break;
      }
    }
    if (!matched) return `${path}:anyOf`;
  }
  if ("oneOf" in schema) {
    let matches = 0;
    for (const branch of schema["oneOf"] as SchemaNode[]) {
      if (check(root, branch, value, path, depth + 1, budget) === null) matches += 1;
    }
    if (matches !== 1) return `${path}:oneOf`;
  }
  if ("allOf" in schema) {
    for (const branch of schema["allOf"] as SchemaNode[]) {
      const violation = check(root, branch, value, path, depth + 1, budget);
      if (violation !== null) return violation;
    }
  }
  if (typeof value === "string") {
    const codePointLength = Array.from(value).length;
    if (typeof schema["minLength"] === "number" && codePointLength < schema["minLength"]) return `${path}:minLength`;
    if (typeof schema["maxLength"] === "number" && codePointLength > schema["maxLength"]) return `${path}:maxLength`;
  }
  if (typeof value === "number") {
    if (typeof schema["minimum"] === "number" && value < schema["minimum"]) return `${path}:minimum`;
    if (typeof schema["maximum"] === "number" && value > schema["maximum"]) return `${path}:maximum`;
    if (typeof schema["exclusiveMinimum"] === "number" && value <= schema["exclusiveMinimum"]) return `${path}:exclusiveMinimum`;
    if (typeof schema["exclusiveMaximum"] === "number" && value >= schema["exclusiveMaximum"]) return `${path}:exclusiveMaximum`;
  }
  if (Array.isArray(value)) {
    if (typeof schema["minItems"] === "number" && value.length < schema["minItems"]) return `${path}:minItems`;
    if (typeof schema["maxItems"] === "number" && value.length > schema["maxItems"]) return `${path}:maxItems`;
    const prefix = Array.isArray(schema["prefixItems"]) ? schema["prefixItems"] as SchemaNode[] : [];
    for (let index = 0; index < Math.min(prefix.length, value.length); index += 1) {
      const violation = check(root, prefix[index]!, value[index]!, `${path}[${index}]`, depth + 1, budget);
      if (violation !== null) return violation;
    }
    if ("items" in schema) {
      for (let index = prefix.length; index < value.length; index += 1) {
        const violation = check(root, schema["items"] as SchemaNode, value[index]!, `${path}[${index}]`, depth + 1, budget);
        if (violation !== null) return violation;
      }
    }
  }
  if (object(value)) {
    const properties = object(schema["properties"]) ? schema["properties"] as Schema : {};
    if (Array.isArray(schema["required"])) {
      for (const key of schema["required"] as string[]) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) return `${path}:required`;
      }
    }
    for (const [key, nested] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        const violation = check(root, properties[key] as SchemaNode, nested, `${path}.*`, depth + 1, budget);
        if (violation !== null) return violation;
      } else if (schema["additionalProperties"] === false) {
        return `${path}:additionalProperties`;
      } else if (schema["additionalProperties"] !== undefined && schema["additionalProperties"] !== true) {
        const violation = check(root, schema["additionalProperties"] as SchemaNode, nested, `${path}.*`, depth + 1, budget);
        if (violation !== null) return violation;
      }
    }
  }
  return null;
}

export function assertStructuredOutputMatchesSchema(schema: JsonValue, value: JsonValue): void {
  assertStructuredSchemaWellFormed(schema);
  const root = schema as Schema;
  let violation: string | null;
  try {
    violation = check(root, root, value, "$", 0, { remaining: MAX_EVALUATION_STEPS });
  } catch (error) {
    if (!(error instanceof SchemaEvaluationFailure)) throw error;
    throw new ProviderError("MALFORMED_RESPONSE", "Anthropic structured output exceeded a schema-evaluation bound.", {
      violationPath: error.violationPath,
      violationCode: error.violationCode,
    });
  }
  if (violation !== null) {
    const [path = "$", code = "schema"] = violation.split(":", 2);
    throw new ProviderError("MALFORMED_RESPONSE", "Anthropic structured output did not match the caller schema.", {
      violationPath: path,
      violationCode: code,
    });
  }
}
