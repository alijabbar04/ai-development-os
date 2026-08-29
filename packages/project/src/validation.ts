import type { CanonicalJsonValue } from "./canonical.js";
import { canonicalizeProjectJson } from "./canonical.js";
import { PROJECT_SCHEMA_VERSION, PROJECT_TIMESTAMP_RANGE } from "./contracts.js";
import { refuse } from "./errors.js";

export const PROJECT_LIMITS = Object.freeze({
  text: 16_384,
  shortText: 512,
  identifier: 128,
  items: 1_024,
  commandArguments: 256,
  commandArgumentLength: 32_768,
  moneyMinorUnits: Number.MAX_SAFE_INTEGER,
  durationMs: 10_000_000_000_000,
  tokenCount: 1_000_000_000_000,
});

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RULE_ID_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/;
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ZERO_WIDTH_PATTERN = /[\u200B-\u200D\u2060\uFEFF]/u;
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

export type StrictRecord = Readonly<Record<string, unknown>>;

export function record(value: unknown, path: string): StrictRecord {
  let isArray: boolean;
  let prototype: object | null;
  let symbols: symbol[];
  let descriptors: PropertyDescriptorMap;
  try {
    isArray = Array.isArray(value);
    if (value === null || typeof value !== "object" || isArray) {
      refuse("PROJECT_VALIDATION_REFUSED", path);
    }
    prototype = Object.getPrototypeOf(value);
    symbols = Object.getOwnPropertySymbols(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    refuse("PROJECT_VALIDATION_REFUSED", path);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    refuse("PROJECT_VALIDATION_REFUSED", path);
  }
  if (symbols.length > 0) {
    refuse("PROJECT_VALIDATION_REFUSED", path);
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      refuse("PROJECT_VALIDATION_REFUSED", path);
    }
    output[key] = descriptor.value;
  }
  return Object.freeze(output);
}

export function exact(value: StrictRecord, keys: readonly string[], path: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    refuse("PROJECT_VALIDATION_REFUSED", path, "The object shape does not match the contract.");
  }
}

export function literal<T extends string | number | boolean>(value: unknown, expected: T, path: string): T {
  if (value !== expected) refuse("PROJECT_VALIDATION_REFUSED", path);
  return expected;
}

export function schema(value: unknown, path: string): 1 {
  if (value !== PROJECT_SCHEMA_VERSION) {
    refuse(
      typeof value === "number" && value > PROJECT_SCHEMA_VERSION
        ? "UNSUPPORTED_SCHEMA_VERSION"
        : "PROJECT_VALIDATION_REFUSED",
      path,
      "The schema version is not supported.",
    );
  }
  return PROJECT_SCHEMA_VERSION;
}

export function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") refuse("PROJECT_VALIDATION_REFUSED", path);
  return value;
}

export function integer(value: unknown, path: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    refuse("PROJECT_VALIDATION_REFUSED", path);
  }
  return value as number;
}

export function textValue(
  value: unknown,
  path: string,
  options: Readonly<{ minimum?: number; maximum?: number; allowNewlines?: boolean }> = {},
): string {
  const minimum = options.minimum ?? 1;
  const maximum = options.maximum ?? PROJECT_LIMITS.text;
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    refuse("PROJECT_VALIDATION_REFUSED", path);
  }
  if (value !== value.normalize("NFC") || ZERO_WIDTH_PATTERN.test(value) || CONTROL_PATTERN.test(value)) {
    refuse("PROJECT_VALIDATION_REFUSED", path, "The text is not in the accepted normalized form.");
  }
  if (options.allowNewlines === false && /[\r\n]/u.test(value)) {
    refuse("PROJECT_VALIDATION_REFUSED", path);
  }
  return value;
}

export function optionalText(value: unknown, path: string, maximum: number = PROJECT_LIMITS.shortText): string | null {
  return value === null ? null : textValue(value, path, { maximum });
}

export function enumValue<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    refuse("PROJECT_VALIDATION_REFUSED", path);
  }
  return value as T;
}

export function arrayValue<T>(
  value: unknown,
  path: string,
  parse: (entry: unknown, entryPath: string) => T,
  options: Readonly<{ minimum?: number; maximum?: number }> = {},
): readonly T[] {
  const minimum = options.minimum ?? 0;
  const maximum = options.maximum ?? PROJECT_LIMITS.items;
  let isArray: boolean;
  let prototype: object | null;
  let symbols: symbol[];
  let descriptors: PropertyDescriptorMap;
  try {
    isArray = Array.isArray(value);
    if (!isArray) refuse("PROJECT_VALIDATION_REFUSED", path);
    prototype = Object.getPrototypeOf(value);
    symbols = Object.getOwnPropertySymbols(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    refuse("PROJECT_VALIDATION_REFUSED", path);
  }
  if (prototype !== Array.prototype || symbols.length > 0) {
    refuse("PROJECT_VALIDATION_REFUSED", path);
  }
  const lengthDescriptor = descriptors["length"];
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) {
    refuse("PROJECT_VALIDATION_REFUSED", path);
  }
  const length = lengthDescriptor.value as number;
  if (length < minimum || length > maximum) refuse("PROJECT_VALIDATION_REFUSED", path);
  const keys = Object.keys(descriptors);
  if (keys.length !== length + 1 || !Object.hasOwn(descriptors, "length")) {
    refuse("PROJECT_VALIDATION_REFUSED", path, "Sparse arrays and extra array properties are not accepted.");
  }
  const output: T[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      refuse("PROJECT_VALIDATION_REFUSED", path, "Sparse arrays and array accessors are not accepted.");
    }
    output.push(parse(descriptor.value, `${path}[${index}]`));
  }
  return Object.freeze(output);
}

export function unique<T extends string>(values: readonly T[], path: string): readonly T[] {
  if (new Set(values).size !== values.length) {
    refuse("DUPLICATE_IDENTIFIER", path, "Duplicate identifiers are not accepted.");
  }
  return values;
}

export function stringArray(
  value: unknown,
  path: string,
  options: Readonly<{ minimum?: number; maximum?: number; unique?: boolean; itemMaximum?: number }> = {},
): readonly string[] {
  const values: readonly string[] = arrayValue(
    value,
    path,
    (entry, entryPath) => textValue(entry, entryPath, { maximum: options.itemMaximum ?? PROJECT_LIMITS.text }),
    { minimum: options.minimum ?? 0, maximum: options.maximum ?? PROJECT_LIMITS.items },
  );
  return options.unique === false ? values : unique(values, path);
}

export function identifier(value: unknown, path: string, prefix?: string): string {
  const parsed = textValue(value, path, { maximum: PROJECT_LIMITS.identifier, allowNewlines: false });
  if (!ID_PATTERN.test(parsed) || (prefix !== undefined && !parsed.startsWith(prefix))) {
    refuse("PROJECT_VALIDATION_REFUSED", path, "The identifier does not match the required namespace.");
  }
  return parsed;
}

export function nullableIdentifier(value: unknown, path: string, prefix?: string): string | null {
  return value === null ? null : identifier(value, path, prefix);
}

export function digest(value: unknown, path: string): string {
  const parsed = textValue(value, path, { minimum: 64, maximum: 64, allowNewlines: false });
  if (!SHA256_PATTERN.test(parsed)) refuse("PROJECT_VALIDATION_REFUSED", path);
  return parsed;
}

export function contentId(value: unknown, path: string, prefix: string): string {
  const parsed = identifier(value, path, prefix);
  if (!new RegExp(`^${prefix.replace(":", "\\:")}[a-f0-9]{32}$`).test(parsed)) {
    refuse("PROJECT_VALIDATION_REFUSED", path, "The content identifier is not canonical.");
  }
  return parsed;
}

export function currency(value: unknown, path: string): string {
  const parsed = textValue(value, path, { minimum: 3, maximum: 3, allowNewlines: false });
  if (!CURRENCY_PATTERN.test(parsed)) refuse("PROJECT_VALIDATION_REFUSED", path);
  return parsed;
}

export function ruleId(value: unknown, path: string): string {
  const parsed = textValue(value, path, { maximum: 128, allowNewlines: false });
  if (!RULE_ID_PATTERN.test(parsed)) refuse("PROJECT_VALIDATION_REFUSED", path);
  return parsed;
}

export function timestamp(value: unknown, path: string): string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    refuse("PROJECT_VALIDATION_REFUSED", path, "The timestamp is not canonical UTC millisecond RFC 3339.");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    refuse("PROJECT_VALIDATION_REFUSED", path, "The timestamp is not a finite calendar instant.");
  }
  if (value < PROJECT_TIMESTAMP_RANGE.minimum || value > PROJECT_TIMESTAMP_RANGE.maximum) {
    refuse("PROJECT_VALIDATION_REFUSED", path, "The timestamp is outside the supported finite range.");
  }
  return value;
}

export function nullableTimestamp(value: unknown, path: string): string | null {
  return value === null ? null : timestamp(value, path);
}

export function mediaType(value: unknown, path: string): string {
  const parsed = textValue(value, path, { maximum: 255, allowNewlines: false });
  if (!MEDIA_TYPE_PATTERN.test(parsed)) refuse("PROJECT_VALIDATION_REFUSED", path);
  return parsed;
}

export function absoluteCanonicalPath(value: unknown, path: string): string {
  const parsed = textValue(value, path, { maximum: 32_767, allowNewlines: false });
  if (/^[A-Z]:\\/u.test(parsed)) {
    const tail = parsed.slice(3);
    const segments = tail === "" ? [] : tail.split("\\");
    const reservedDevice = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;
    if (
      parsed.includes("/") || segments.some((segment) =>
        segment === "" || segment === "." || segment === ".." ||
        /[<>:"/\\|?*\u0000-\u001F]/u.test(segment) || /[ .]$/u.test(segment) || reservedDevice.test(segment)
      )
    ) refuse("PROJECT_VALIDATION_REFUSED", path, "The path is not absolute canonical data.");
    return parsed;
  }
  if (parsed.startsWith("/")) {
    const segments = parsed === "/" ? [] : parsed.slice(1).split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      refuse("PROJECT_VALIDATION_REFUSED", path, "The path is not absolute canonical data.");
    }
    return parsed;
  }
  refuse("PROJECT_VALIDATION_REFUSED", path, "The path is not absolute canonical data.");
}

export function jsonObject(value: unknown, path: string): Readonly<Record<string, CanonicalJsonValue>> {
  const parsed = canonicalizeProjectJson(value, path);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    refuse("PROJECT_VALIDATION_REFUSED", path);
  }
  return parsed as { readonly [key: string]: CanonicalJsonValue };
}

function inspectJsonString(text: string, start: number): { value: string; next: number } {
  let index = start + 1;
  let escaped = false;
  while (index < text.length) {
    const character = text[index];
    if (!escaped && character === '"') {
      const source = text.slice(start, index + 1);
      return { value: JSON.parse(source) as string, next: index + 1 };
    }
    if (!escaped && character === "\\") escaped = true;
    else escaped = false;
    index += 1;
  }
  refuse("PROJECT_VALIDATION_REFUSED", "json", "The JSON text is malformed.");
}

function rejectDuplicateKeys(text: string): void {
  const maximumDepth = 64;
  const maximumNodes = 100_000;
  let cursor = 0;
  let nodes = 0;
  const whitespace = (): void => { while (/\s/u.test(text[cursor] ?? "")) cursor += 1; };
  const value = (depth: number): void => {
    nodes += 1;
    if (depth > maximumDepth || nodes > maximumNodes) {
      refuse("PROJECT_VALIDATION_REFUSED", "json", "The JSON text exceeds the structural bound.");
    }
    whitespace();
    const current = text[cursor];
    if (current === "{") { object(depth); return; }
    if (current === "[") { array(depth); return; }
    if (current === '"') { cursor = inspectJsonString(text, cursor).next; return; }
    while (cursor < text.length && !/[\s,\]}]/u.test(text[cursor] ?? "")) cursor += 1;
  };
  const object = (depth: number): void => {
    cursor += 1;
    whitespace();
    const keys = new Set<string>();
    if (text[cursor] === "}") { cursor += 1; return; }
    while (cursor < text.length) {
      whitespace();
      if (text[cursor] !== '"') return;
      const parsed = inspectJsonString(text, cursor);
      if (keys.has(parsed.value)) refuse("DUPLICATE_IDENTIFIER", "json", "Duplicate JSON object keys are refused.");
      keys.add(parsed.value);
      cursor = parsed.next;
      whitespace();
      if (text[cursor] !== ":") return;
      cursor += 1;
      value(depth + 1);
      whitespace();
      if (text[cursor] === "}") { cursor += 1; return; }
      if (text[cursor] !== ",") return;
      cursor += 1;
    }
  };
  const array = (depth: number): void => {
    cursor += 1;
    whitespace();
    if (text[cursor] === "]") { cursor += 1; return; }
    while (cursor < text.length) {
      value(depth + 1);
      whitespace();
      if (text[cursor] === "]") { cursor += 1; return; }
      if (text[cursor] !== ",") return;
      cursor += 1;
    }
  };
  value(0);
}

export function parseJsonText(text: unknown): unknown {
  if (typeof text !== "string" || text.length === 0 || text.length > 10_000_000) {
    refuse("PROJECT_VALIDATION_REFUSED", "json");
  }
  try {
    JSON.parse(text);
  } catch {
    refuse("PROJECT_VALIDATION_REFUSED", "json", "The JSON text is malformed.");
  }
  rejectDuplicateKeys(text);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return refuse("PROJECT_VALIDATION_REFUSED", "json", "The JSON text is malformed.");
  }
}
