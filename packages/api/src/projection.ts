import { canonicalizeJson, type JsonObject, type JsonValue, validation } from "@ai-dev-os/domain";
import { API_LIMITS } from "./constants.js";
import {
  apiFail,
  assertProjectionFieldName,
  assertSafeString,
  ensureExactAndPresent,
  ensureIdentifier,
  ensureRuleId,
  isAbsolutePath,
  isPathField,
  isSourceFingerprintField,
  readSafeArray,
  readSafeRecord,
} from "./structural.js";

export type ProjectionAudience = "normal" | "developer";

export type ProjectionRule =
  | Readonly<{ kind: "boolean" }>
  | Readonly<{ kind: "integer"; minimum: number; maximum: number }>
  | Readonly<{ kind: "count"; maximum: number }>
  | Readonly<{ kind: "basis-points" }>
  | Readonly<{ kind: "identifier" }>
  | Readonly<{ kind: "rule-id" }>
  | Readonly<{ kind: "profile-id" }>
  | Readonly<{ kind: "timestamp" }>
  | Readonly<{ kind: "enum"; values: readonly string[] }>
  | Readonly<{ kind: "nullable"; value: ProjectionRule }>
  | Readonly<{ kind: "array"; maximumItems: number; item: ProjectionRule }>
  | Readonly<{ kind: "object"; fields: Readonly<Record<string, ProjectionRule>> }>
  | Readonly<{ kind: "developer-path" }>
  | Readonly<{ kind: "source-fingerprint" }>;

export interface ProjectionSchema {
  readonly name: string;
  readonly fields: Readonly<Record<string, ProjectionRule>>;
}

export interface ProjectionSerializationOptions {
  readonly audience: ProjectionAudience;
  readonly profileScope?: string | null;
}

interface SerializationState {
  nodes: number;
  readonly active: WeakSet<object>;
  readonly audience: ProjectionAudience;
  readonly profileScope: string | null;
}

const RULE_KINDS = Object.freeze([
  "boolean", "integer", "count", "basis-points", "identifier", "rule-id",
  "profile-id", "timestamp", "enum", "nullable", "array", "object",
  "developer-path", "source-fingerprint",
] as const);

function safeFields(value: unknown, path: string, depth: number): Readonly<Record<string, ProjectionRule>> {
  if (depth > API_LIMITS.maxProjectionDepth) apiFail(path, "schema_too_deep", "exceeds the projection schema depth limit.");
  const record = readSafeRecord(value, path);
  const names = Object.keys(record).sort();
  if (names.length === 0 || names.length > API_LIMITS.maxProjectionFields) {
    apiFail(path, "bad_field_count", `must contain between 1 and ${API_LIMITS.maxProjectionFields} fields.`);
  }
  const output: Record<string, ProjectionRule> = Object.create(null) as Record<string, ProjectionRule>;
  for (const name of names) {
    assertProjectionFieldName(name, `${path}.${name}`);
    const rule = copyRule(record[name], `${path}.${name}`, depth + 1);
    if (isSourceFingerprintField(name) && rule.kind !== "source-fingerprint") {
      apiFail(`${path}.${name}`, "fingerprint_rule_required", "must use the source-fingerprint rule.");
    }
    if (isPathField(name) && rule.kind !== "developer-path") {
      apiFail(`${path}.${name}`, "path_rule_required", "must use the developer-path rule.");
    }
    output[name] = rule;
  }
  return Object.freeze(output);
}

function copyRule(value: unknown, path: string, depth: number): ProjectionRule {
  if (depth > API_LIMITS.maxProjectionDepth) {
    apiFail(path, "schema_too_deep", "exceeds the projection schema depth limit.");
  }
  const record = readSafeRecord(value, path);
  const kind = validation.ensureEnum(record["kind"], `${path}.kind`, RULE_KINDS);
  switch (kind) {
    case "boolean":
    case "basis-points":
    case "identifier":
    case "rule-id":
    case "profile-id":
    case "timestamp":
    case "developer-path":
    case "source-fingerprint":
      ensureExactAndPresent(record, ["kind"], path);
      return Object.freeze({ kind });
    case "integer": {
      ensureExactAndPresent(record, ["kind", "minimum", "maximum"], path);
      const minimum = validation.ensureSafeInteger(record["minimum"], `${path}.minimum`, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      const maximum = validation.ensureSafeInteger(record["maximum"], `${path}.maximum`, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      if (minimum > maximum) apiFail(path, "inverted_integer_range", "minimum cannot exceed maximum.");
      return Object.freeze({ kind, minimum, maximum });
    }
    case "count": {
      ensureExactAndPresent(record, ["kind", "maximum"], path);
      const maximum = validation.ensureSafeInteger(record["maximum"], `${path}.maximum`, 0, Number.MAX_SAFE_INTEGER);
      return Object.freeze({ kind, maximum });
    }
    case "enum": {
      ensureExactAndPresent(record, ["kind", "values"], path);
      const source = readSafeArray(record["values"], `${path}.values`, 64);
      if (source.length === 0) apiFail(`${path}.values`, "empty_enum", "must contain at least one value.");
      const values = source.map((item, index) => validation.ensureString(item, `${path}.values[${index}]`, {
        maxLength: 64,
        pattern: /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u,
        patternName: "finite product token",
      }));
      if (new Set(values).size !== values.length) apiFail(`${path}.values`, "duplicate_enum", "cannot contain duplicate values.");
      return Object.freeze({ kind, values: Object.freeze([...values].sort()) });
    }
    case "nullable":
      ensureExactAndPresent(record, ["kind", "value"], path);
      return Object.freeze({ kind, value: copyRule(record["value"], `${path}.value`, depth + 1) });
    case "array": {
      ensureExactAndPresent(record, ["kind", "maximumItems", "item"], path);
      const maximumItems = validation.ensureSafeInteger(record["maximumItems"], `${path}.maximumItems`, 0, API_LIMITS.maxProjectionArrayItems);
      return Object.freeze({ kind, maximumItems, item: copyRule(record["item"], `${path}.item`, depth + 1) });
    }
    case "object":
      ensureExactAndPresent(record, ["kind", "fields"], path);
      return Object.freeze({ kind, fields: safeFields(record["fields"], `${path}.fields`, depth + 1) });
  }
}

export function defineProjectionSchema(name: unknown, fields: unknown): ProjectionSchema {
  const parsedName = ensureIdentifier(name, "schema.name", 64);
  return Object.freeze({ name: parsedName, fields: safeFields(fields, "schema.fields", 0) });
}

function parseOptions(value: unknown): Readonly<{ audience: ProjectionAudience; profileScope: string | null }> {
  const record = readSafeRecord(value, "options");
  validation.ensureExactKeys(record, ["audience", "profileScope"], "options");
  if (!Object.hasOwn(record, "audience")) apiFail("options.audience", "missing_field", "is required.");
  const audience = validation.ensureEnum(record["audience"], "options.audience", ["normal", "developer"] as const);
  let profileScope: string | null = null;
  if (record["profileScope"] !== undefined && record["profileScope"] !== null) {
    profileScope = ensureIdentifier(record["profileScope"], "options.profileScope");
  }
  return Object.freeze({ audience, profileScope });
}

function enterComplex(value: object, path: string, state: SerializationState): void {
  if (state.active.has(value)) apiFail(path, "cyclic_projection", "cannot contain a cyclic reference.");
  state.active.add(value);
}

function countNode(path: string, state: SerializationState, depth: number): void {
  state.nodes += 1;
  if (state.nodes > API_LIMITS.maxProjectionNodes) apiFail(path, "projection_too_large", "exceeds the projection node limit.");
  if (depth > API_LIMITS.maxProjectionDepth) apiFail(path, "projection_too_deep", "exceeds the projection depth limit.");
}

function serializeRule(
  rule: ProjectionRule,
  value: unknown,
  fieldName: string,
  path: string,
  depth: number,
  state: SerializationState,
): JsonValue {
  countNode(path, state, depth);
  if (typeof value === "string") {
    assertSafeString(value, path);
    if (state.audience === "normal" && isAbsolutePath(value)) apiFail(path, "normal_path_leak", "cannot expose an absolute path in Normal mode.");
  }
  switch (rule.kind) {
    case "boolean":
      return validation.ensureBoolean(value, path);
    case "integer":
      return validation.ensureSafeInteger(value, path, rule.minimum, rule.maximum);
    case "count":
      return validation.ensureSafeInteger(value, path, 0, rule.maximum);
    case "basis-points":
      return validation.ensureSafeInteger(value, path, 0, 10_000);
    case "identifier":
      return ensureIdentifier(value, path);
    case "rule-id":
      return ensureRuleId(value, path);
    case "profile-id": {
      const profileId = ensureIdentifier(value, path);
      if (state.audience === "normal" && (state.profileScope === null || profileId !== state.profileScope)) {
        apiFail(path, "cross_profile", "cannot expose data outside the Normal-mode profile scope.");
      }
      return profileId;
    }
    case "timestamp":
      return validation.ensureTimestamp(value, path);
    case "enum":
      return validation.ensureEnum(value, path, rule.values);
    case "nullable":
      return value === null ? null : serializeRule(rule.value, value, fieldName, path, depth + 1, state);
    case "developer-path": {
      if (state.audience !== "developer") apiFail(path, "developer_only_field", "cannot expose a path in Normal mode.");
      const candidate = validation.ensureString(value, path, { maxLength: API_LIMITS.maxProjectionStringLength });
      assertSafeString(candidate, path);
      if (!isAbsolutePath(candidate)) apiFail(path, "not_absolute_path", "must be an absolute path.");
      return candidate;
    }
    case "source-fingerprint": {
      if (state.audience !== "developer" || !isSourceFingerprintField(fieldName)) {
        apiFail(path, "developer_only_field", "cannot expose a source fingerprint in this projection.");
      }
      return validation.ensureString(value, path, { maxLength: 64, minLength: 64, pattern: /^[a-f0-9]{64}$/u, patternName: "SHA-256 digest" });
    }
    case "array": {
      const array = readSafeArray(value, path, rule.maximumItems);
      enterComplex(array as object, path, state);
      try {
        const output: JsonValue[] = [];
        array.forEach((item, index) => output.push(serializeRule(rule.item, item, fieldName, `${path}[${index}]`, depth + 1, state)));
        return Object.freeze(output);
      } finally {
        state.active.delete(array as object);
      }
    }
    case "object": {
      const record = readSafeRecord(value, path);
      enterComplex(value as object, path, state);
      try {
        return serializeFields(rule.fields, record, path, depth + 1, state);
      } finally {
        state.active.delete(value as object);
      }
    }
  }
}

function serializeFields(
  fields: Readonly<Record<string, ProjectionRule>>,
  record: Record<string, unknown>,
  path: string,
  depth: number,
  state: SerializationState,
): JsonObject {
  const names = Object.keys(fields).sort();
  ensureExactAndPresent(record, names, path);
  const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const name of names) {
    const rule = fields[name];
    if (rule === undefined) apiFail(`${path}.${name}`, "schema_field_missing", "has no schema rule.");
    if (state.audience === "normal" && (rule.kind === "developer-path" || rule.kind === "source-fingerprint")) {
      apiFail(`${path}.${name}`, "developer_only_field", "cannot be exposed in Normal mode.");
    }
    output[name] = serializeRule(rule, record[name], name, `${path}.${name}`, depth, state);
  }
  return Object.freeze(output) as JsonObject;
}

export function serializeProjection(
  schema: ProjectionSchema,
  value: unknown,
  options: ProjectionSerializationOptions,
): JsonObject {
  const safeSchema = defineProjectionSchema(schema.name, schema.fields);
  const parsedOptions = parseOptions(options);
  const record = readSafeRecord(value, `projection.${safeSchema.name}`);
  const state: SerializationState = {
    nodes: 0,
    active: new WeakSet<object>(),
    audience: parsedOptions.audience,
    profileScope: parsedOptions.profileScope,
  };
  enterComplex(value as object, `projection.${safeSchema.name}`, state);
  try {
    const serialized = serializeFields(safeSchema.fields, record, `projection.${safeSchema.name}`, 0, state);
    return canonicalizeJson(serialized, `projection.${safeSchema.name}`) as JsonObject;
  } finally {
    state.active.delete(value as object);
  }
}
