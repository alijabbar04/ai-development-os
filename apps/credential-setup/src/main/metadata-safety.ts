import { CredentialHostError } from "./host-error.js";

type MetadataSafetyCode = "SCHEMA_REJECTED" | "METADATA_UNAVAILABLE";

const CREDENTIAL_SHAPE = /(?:sk-(?:ant-api\d{2}-|ant-|proj-|or-v1-|or-)?[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{12,}|SYNTHETIC_(?:CREDENTIAL|SECRET|KEY)[A-Z0-9_-]{4,})/u;

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

export function assertCredentialMetadataLabelsSafe(nickname: string, authorizedBy: string, code: MetadataSafetyCode): void {
  const variants = [nickname, authorizedBy, `${nickname}${authorizedBy}`, `${authorizedBy}${nickname}`];
  for (const value of variants) assertCredentialMetadataTextSafe(value, code);
}

export function assertCredentialMetadataSeparatedFromSecret(secret: string, nickname: string, authorizedBy: string, code: MetadataSafetyCode = "SCHEMA_REJECTED"): void {
  const { start, end } = logicalBounds(secret);
  const candidates: readonly (readonly string[])[] = [[nickname], [authorizedBy], [nickname, authorizedBy], [authorizedBy, nickname]];
  for (const parts of candidates) {
    const candidateInsideSecret = logicalSecretContains(secret, start, end, parts);
    const secretInsideCandidate = partsContainLogicalSecret(secret, start, end, parts);
    if (candidateInsideSecret || secretInsideCandidate) throw new CredentialHostError(code);
  }
  assertCredentialMetadataLabelsSafe(nickname, authorizedBy, code);
}
