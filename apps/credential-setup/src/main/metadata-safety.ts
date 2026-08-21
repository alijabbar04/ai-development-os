import { CredentialHostError } from "./host-error.js";

type MetadataSafetyCode = "SCHEMA_REJECTED" | "METADATA_UNAVAILABLE";

const CREDENTIAL_SHAPE = /(?:sk-(?:ant-api\d{2}-|ant-|proj-|or-v1-|or-)?[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{12,}|SYNTHETIC_(?:CREDENTIAL|SECRET|KEY)[A-Z0-9_-]{4,})/u;
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const MAX_DERIVED_LABEL_CODE_UNITS = 320;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const HEX = /^[0-9a-f]+$/iu;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function assertCredentialMetadataTextSafe(value: string, code: MetadataSafetyCode): void {
  if (CREDENTIAL_SHAPE.test(value)) throw new CredentialHostError(code);
}

function trimmedCodeUnit(code: number): boolean {
  return (code >= 0x0009 && code <= 0x000d)
    || code === 0x0020 || code === 0x00a0 || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028 || code === 0x2029 || code === 0x202f
    || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

function logicalBounds(secret: string): Readonly<{ start: number; end: number }> {
  let start = 0;
  while (start < secret.length && trimmedCodeUnit(secret.charCodeAt(start))) start += 1;
  let end = secret.length;
  while (end > start && trimmedCodeUnit(secret.charCodeAt(end - 1))) end -= 1;
  return Object.freeze({ start, end });
}

function partLength(parts: readonly string[]): number {
  return parts.reduce((total, part) => total + part.length, 0);
}

function partCodeUnit(parts: readonly string[], index: number): number {
  let offset = index;
  for (const part of parts) {
    if (offset < part.length) return part.charCodeAt(offset);
    offset -= part.length;
  }
  return -1;
}

function logicalSecretContains(secret: string, start: number, end: number, parts: readonly string[]): boolean {
  const length = partLength(parts);
  if (length === 0 || length > end - start) return false;
  for (let candidateStart = start; candidateStart + length <= end; candidateStart += 1) {
    let matches = true;
    for (let offset = 0; offset < length; offset += 1) {
      if (secret.charCodeAt(candidateStart + offset) !== partCodeUnit(parts, offset)) { matches = false; break; }
    }
    if (matches) return true;
  }
  return false;
}

function partsContainLogicalSecret(secret: string, start: number, end: number, parts: readonly string[]): boolean {
  const secretLength = end - start;
  const length = partLength(parts);
  if (secretLength === 0 || secretLength > length) return false;
  for (let candidateStart = 0; candidateStart + secretLength <= length; candidateStart += 1) {
    let matches = true;
    for (let offset = 0; offset < secretLength; offset += 1) {
      if (partCodeUnit(parts, candidateStart + offset) !== secret.charCodeAt(start + offset)) { matches = false; break; }
    }
    if (matches) return true;
  }
  return false;
}

function boundedDerived(value: string): string | null {
  return value.length > 0 && value.length <= MAX_DERIVED_LABEL_CODE_UNITS ? value : null;
}

function decodedUtf8(bytes: Uint8Array): string | null {
  try { return boundedDerived(UTF8.decode(bytes)); }
  catch { return null; }
}

function strictBase64(value: string): string | null {
  if (value.length === 0 || value.length % 4 !== 0 || !BASE64.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) return null;
  return decodedUtf8(bytes);
}

function strictBase64Url(value: string): string | null {
  if (value.length === 0 || value.length % 4 === 1 || !BASE64URL.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) return null;
  return decodedUtf8(bytes);
}

function strictHex(value: string): string | null {
  if (value.length === 0 || value.length % 2 !== 0 || !HEX.test(value)) return null;
  const bytes = Buffer.from(value, "hex");
  if (bytes.toString("hex") !== value.toLowerCase()) return null;
  return decodedUtf8(bytes);
}

function shiftedAscii(value: string, delta: -1 | 1): string | null {
  let shifted = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const transformed = code + delta;
    if (code < 0x21 || code > 0x7e || transformed < 0x21 || transformed > 0x7e) return null;
    shifted += String.fromCharCode(transformed);
  }
  return boundedDerived(shifted);
}

function derivedLabelForms(value: string): readonly string[] {
  const canonical = new Set<string>();
  const add = (candidate: string | null): void => { if (candidate !== null && boundedDerived(candidate) !== null) canonical.add(candidate); };
  add(value);
  add(value.normalize("NFKC"));
  add(value.replace(DEFAULT_IGNORABLE, ""));
  add(value.normalize("NFKC").replace(DEFAULT_IGNORABLE, ""));
  const bases = [...canonical];
  for (const base of bases) {
    add([...base].reverse().join(""));
    add(strictBase64(base));
    add(strictBase64Url(base));
    add(strictHex(base));
    add(shiftedAscii(base, -1));
    add(shiftedAscii(base, 1));
  }
  return Object.freeze([...canonical]);
}

export function assertCredentialMetadataLabelsSafe(nickname: string, authorizedBy: string, code: MetadataSafetyCode): void {
  const variants = [nickname, authorizedBy, `${nickname}${authorizedBy}`, `${authorizedBy}${nickname}`];
  for (const value of variants) {
    for (const derived of derivedLabelForms(value)) assertCredentialMetadataTextSafe(derived, code);
  }
}

export function assertCredentialMetadataSeparatedFromSecret(secret: string, nickname: string, authorizedBy: string, code: MetadataSafetyCode = "SCHEMA_REJECTED"): void {
  const { start, end } = logicalBounds(secret);
  const candidates: readonly (readonly string[])[] = [[nickname], [authorizedBy], [nickname, authorizedBy], [authorizedBy, nickname]];
  for (const parts of candidates) {
    const candidateInsideSecret = logicalSecretContains(secret, start, end, parts);
    const secretInsideCandidate = partsContainLogicalSecret(secret, start, end, parts);
    if (candidateInsideSecret || secretInsideCandidate) throw new CredentialHostError(code);
  }
  const materialized = [nickname, authorizedBy, `${nickname}${authorizedBy}`, `${authorizedBy}${nickname}`];
  for (const candidate of materialized) {
    for (const derived of derivedLabelForms(candidate)) {
      if (derived === candidate) continue;
      if (logicalSecretContains(secret, start, end, [derived]) || partsContainLogicalSecret(secret, start, end, [derived])) throw new CredentialHostError(code);
    }
  }
  assertCredentialMetadataLabelsSafe(nickname, authorizedBy, code);
}
