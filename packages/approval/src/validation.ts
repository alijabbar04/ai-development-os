import { canonicalizeProjectJson, serializeCanonicalProjectJson } from "@ai-dev-os/project";

export class ApprovalError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = "ApprovalError"; }
}
export function refuse(reason: string): never { throw new ApprovalError(reason); }
export function record(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  // Inspect own data descriptors before reading fields; rejects getters/symbols,
  // sparse arrays, hidden fields, class instances and prototype-sensitive keys.
  const parsed = canonicalizeProjectJson(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return refuse("request.malformed");
  const result = parsed as Readonly<Record<string, unknown>>;
  if (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key))) return refuse("request.unknown-field");
  return result;
}
export function oneOf<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== "string" || !values.includes(value)) return refuse("request.malformed");
  return value as T[number];
}
export function integer(value: unknown, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) return refuse("request.malformed");
  return value as number;
}
export function identifier(value: unknown, prefix = ""): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) || !value.startsWith(prefix)) return refuse("request.malformed");
  return value;
}
export function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) return refuse("request.malformed");
  return value;
}
export function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value
    || value < "2000-01-01T00:00:00.000Z" || value > "9999-12-31T23:59:59.999Z") return refuse("request.malformed");
  return value;
}
export function text(value: unknown, max = 2048): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value !== value.normalize("NFC")
    || /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value)
    || /(?:[A-Za-z]:[\\/]|\\\\|:\/\/|Bearer\s|sk-[A-Za-z0-9]|-----BEGIN)/u.test(value)) return refuse("request.unsafe-text");
  return value;
}
export function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null { return value === null ? null : parse(value); }
export function array<T>(value: unknown, parse: (value: unknown) => T, max = 100): readonly T[] {
  if (!Array.isArray(value) || value.length > max) return refuse("request.malformed");
  return Object.freeze(value.map(parse));
}
export function ids(value: unknown, prefix = ""): readonly string[] {
  const values = array(value, (entry) => identifier(entry, prefix));
  if (new Set(values).size !== values.length) return refuse("request.malformed");
  return Object.freeze([...values].sort());
}
export function same(a: unknown, b: unknown): boolean { return serializeCanonicalProjectJson(a) === serializeCanonicalProjectJson(b); }
