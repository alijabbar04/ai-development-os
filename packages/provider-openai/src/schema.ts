import type { JsonValue } from "@ai-dev-os/domain";

/**
 * Bounded structural validator for the JSON Schema subset that OpenAI
 * Structured Outputs supports.
 *
 * This exists so a structured result is checked against the CALLER's
 * schema rather than trusted because the API claimed strict mode. It is
 * deliberately not a general-purpose JSON Schema engine: it enforces the
 * documented subset and reports, rather than silently ignores, any keyword
 * it did not enforce, so a caller can see exactly how much was checked.
 *
 * Enforced keywords:
 *   type, enum, const, properties, required, additionalProperties,
 *   items, prefixItems, minItems, maxItems, minLength, maxLength, pattern,
 *   minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf,
 *   anyOf, oneOf, allOf, not, $ref (to "#" and "#/$defs/<name>" only).
 */

export interface SchemaViolation {
  /** JSON pointer-ish path into the validated value. */
  readonly path: string;
  /** Stable machine code; never echoes the offending value. */
  readonly code: string;
}

export interface SchemaValidationResult {
  readonly valid: boolean;
  readonly violations: readonly SchemaViolation[];
  /** Keywords present in the schema that this validator did not enforce. */
  readonly unenforcedKeywords: readonly string[];
}

const ENFORCED_KEYWORDS = new Set([
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "$ref",
  // Structural/annotation keywords that carry no constraint.
  "$defs",
  "definitions",
  "$schema",
  "$id",
  "title",
  "description",
  "default",
  "examples",
]);

const MAX_DEPTH = 32;
const MAX_VIOLATIONS = 32;

type SchemaObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is SchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeOfJson(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    case "string":
      return "string";
    case "object":
      return "object";
    default:
      return "unknown";
  }
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => jsonEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key, index) => key === bKeys[index]) &&
      aKeys.every((key) => jsonEqual(a[key], b[key]))
    );
  }
  return false;
}

interface Context {
  readonly root: SchemaObject;
  readonly violations: SchemaViolation[];
  readonly unenforced: Set<string>;
}

function resolveRef(context: Context, ref: unknown): SchemaObject | null {
  if (typeof ref !== "string") {
    return null;
  }
  if (ref === "#") {
    return context.root;
  }
  const defsMatch = /^#\/(\$defs|definitions)\/([A-Za-z0-9_.-]{1,128})$/.exec(ref);
  if (defsMatch === null) {
    return null;
  }
  const bucket = context.root[defsMatch[1]!];
  if (!isPlainObject(bucket)) {
    return null;
  }
  const target = bucket[defsMatch[2]!];
  return isPlainObject(target) ? target : null;
}

function record(context: Context, path: string, code: string): void {
  if (context.violations.length < MAX_VIOLATIONS) {
    context.violations.push(Object.freeze({ path, code }));
  }
}

function validateNode(
  context: Context,
  schema: unknown,
  value: JsonValue,
  path: string,
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    record(context, path, "schema_too_deep");
    return;
  }
  // A boolean schema accepts (true) or rejects (false) everything.
  if (schema === true) {
    return;
  }
  if (schema === false) {
    record(context, path, "schema_forbids_value");
    return;
  }
  if (!isPlainObject(schema)) {
    record(context, path, "invalid_schema_node");
    return;
  }

  for (const keyword of Object.keys(schema)) {
    if (!ENFORCED_KEYWORDS.has(keyword)) {
      context.unenforced.add(keyword);
    }
  }

  if ("$ref" in schema) {
    const target = resolveRef(context, schema["$ref"]);
    if (target === null) {
      record(context, path, "unresolvable_ref");
      return;
    }
    validateNode(context, target, value, path, depth + 1);
    return;
  }

  const actualType = typeOfJson(value);

  if ("type" in schema) {
    const expected = schema["type"];
    const allowed = Array.isArray(expected) ? expected : [expected];
    const matches = allowed.some((candidate) => {
      if (candidate === "number") {
        return actualType === "number" || actualType === "integer";
      }
      return candidate === actualType;
    });
    if (!matches) {
      record(context, path, "type_mismatch");
      return;
    }
  }

  if ("const" in schema && !jsonEqual(schema["const"], value)) {
    record(context, path, "const_mismatch");
  }

  if ("enum" in schema) {
    const options = schema["enum"];
    if (!Array.isArray(options) || !options.some((option) => jsonEqual(option, value))) {
      record(context, path, "enum_mismatch");
    }
  }

  if ("not" in schema) {
    const nested: Context = { root: context.root, violations: [], unenforced: context.unenforced };
    validateNode(nested, schema["not"], value, path, depth + 1);
    if (nested.violations.length === 0) {
      record(context, path, "not_satisfied");
    }
  }

  for (const key of ["anyOf", "oneOf"] as const) {
    if (!(key in schema)) {
      continue;
    }
    const branches = schema[key];
    if (!Array.isArray(branches) || branches.length === 0) {
      record(context, path, `invalid_${key}`);
      continue;
    }
    let matched = 0;
    for (const branch of branches) {
      const nested: Context = { root: context.root, violations: [], unenforced: context.unenforced };
      validateNode(nested, branch, value, path, depth + 1);
      if (nested.violations.length === 0) {
        matched += 1;
      }
    }
    if (matched === 0) {
      record(context, path, `${key}_unmatched`);
    } else if (key === "oneOf" && matched > 1) {
      record(context, path, "oneOf_ambiguous");
    }
  }

  if ("allOf" in schema) {
    const branches = schema["allOf"];
    if (!Array.isArray(branches)) {
      record(context, path, "invalid_allOf");
    } else {
      for (const branch of branches) {
        validateNode(context, branch, value, path, depth + 1);
      }
    }
  }

  if (typeof value === "string") {
    const minLength = schema["minLength"];
    const maxLength = schema["maxLength"];
    if (typeof minLength === "number" && value.length < minLength) {
      record(context, path, "min_length");
    }
    if (typeof maxLength === "number" && value.length > maxLength) {
      record(context, path, "max_length");
    }
    const pattern = schema["pattern"];
    if (typeof pattern === "string") {
      let expression: RegExp | null = null;
      try {
        expression = new RegExp(pattern);
      } catch {
        record(context, path, "invalid_pattern");
      }
      if (expression !== null && !expression.test(value)) {
        record(context, path, "pattern_mismatch");
      }
    }
  }

  if (typeof value === "number") {
    const minimum = schema["minimum"];
    const maximum = schema["maximum"];
    const exclusiveMinimum = schema["exclusiveMinimum"];
    const exclusiveMaximum = schema["exclusiveMaximum"];
    const multipleOf = schema["multipleOf"];
    if (typeof minimum === "number" && value < minimum) {
      record(context, path, "minimum");
    }
    if (typeof maximum === "number" && value > maximum) {
      record(context, path, "maximum");
    }
    if (typeof exclusiveMinimum === "number" && value <= exclusiveMinimum) {
      record(context, path, "exclusive_minimum");
    }
    if (typeof exclusiveMaximum === "number" && value >= exclusiveMaximum) {
      record(context, path, "exclusive_maximum");
    }
    if (typeof multipleOf === "number" && multipleOf > 0) {
      const quotient = value / multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
        record(context, path, "multiple_of");
      }
    }
  }

  if (Array.isArray(value)) {
    const minItems = schema["minItems"];
    const maxItems = schema["maxItems"];
    if (typeof minItems === "number" && value.length < minItems) {
      record(context, path, "min_items");
    }
    if (typeof maxItems === "number" && value.length > maxItems) {
      record(context, path, "max_items");
    }
    const prefixItems = schema["prefixItems"];
    const prefixCount = Array.isArray(prefixItems) ? prefixItems.length : 0;
    if (Array.isArray(prefixItems)) {
      prefixItems.forEach((entry, index) => {
        if (index < value.length) {
          validateNode(context, entry, value[index]!, `${path}[${index}]`, depth + 1);
        }
      });
    }
    if ("items" in schema) {
      value.slice(prefixCount).forEach((item, offset) => {
        const index = prefixCount + offset;
        validateNode(context, schema["items"], item, `${path}[${index}]`, depth + 1);
      });
    }
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(schema["properties"]) ? schema["properties"] : {};
    const required = schema["required"];
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === "string" && !Object.prototype.hasOwnProperty.call(value, key)) {
          record(context, `${path}.${key}`, "required_missing");
        }
      }
    }
    for (const [key, nested] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        validateNode(context, properties[key], nested, `${path}.${key}`, depth + 1);
        continue;
      }
      const additional = schema["additionalProperties"];
      if (additional === false) {
        record(context, `${path}.${key}`, "additional_property");
      } else if (additional !== undefined && additional !== true) {
        validateNode(context, additional, nested, `${path}.${key}`, depth + 1);
      }
    }
  }
}

/**
 * Validates `value` against `schema`. Never throws on a hostile schema: an
 * unusable schema node is reported as a violation so the operation fails
 * closed rather than passing unchecked output to the caller.
 */
export function validateAgainstSchema(schema: JsonValue, value: JsonValue): SchemaValidationResult {
  if (!isPlainObject(schema)) {
    return Object.freeze({
      valid: false,
      violations: Object.freeze([Object.freeze({ path: "$", code: "invalid_root_schema" })]),
      unenforcedKeywords: Object.freeze([]),
    });
  }
  const context: Context = { root: schema, violations: [], unenforced: new Set<string>() };
  validateNode(context, schema, value, "$", 0);
  return Object.freeze({
    valid: context.violations.length === 0,
    violations: Object.freeze([...context.violations]),
    unenforcedKeywords: Object.freeze([...context.unenforced].sort()),
  });
}
