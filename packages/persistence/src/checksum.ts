import { createHash } from "node:crypto";
import { toCanonicalJson, validation } from "@ai-dev-os/domain";
import { PersistenceError } from "./errors.js";

const { ensureEnum, ensureExactKeys, ensureRecord, ensureString } = validation;

export const CHECKSUM_ALGORITHMS = Object.freeze(["sha-256"] as const);

export type ChecksumAlgorithm = (typeof CHECKSUM_ALGORITHMS)[number];

/** Digest of the UTF-8 bytes of a canonical JSON payload. */
export interface Checksum {
  readonly algorithm: ChecksumAlgorithm;
  readonly hex: string;
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function parseChecksum(value: unknown, path = "checksum"): Checksum {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["algorithm", "hex"], path);
  return Object.freeze({
    algorithm: ensureEnum(record["algorithm"], `${path}.algorithm`, CHECKSUM_ALGORITHMS),
    hex: ensureString(record["hex"], `${path}.hex`, {
      minLength: 64,
      maxLength: 64,
      pattern: SHA256_HEX_PATTERN,
      patternName: "lowercase sha-256 hex digest",
    }),
  });
}

/** Computes the sha-256 checksum of canonical JSON text. */
export function computeChecksumOfText(canonicalText: string): Checksum {
  return Object.freeze({
    algorithm: "sha-256" as const,
    hex: createHash("sha256").update(canonicalText, "utf8").digest("hex"),
  });
}

/** Canonicalizes a payload and returns both the text and its checksum. */
export function canonicalizeWithChecksum(
  payload: unknown,
  label = "payload",
): { readonly text: string; readonly checksum: Checksum } {
  const text = toCanonicalJson(payload, label);
  return { text, checksum: computeChecksumOfText(text) };
}

export function checksumEquals(a: Checksum, b: Checksum): boolean {
  return a.algorithm === b.algorithm && a.hex === b.hex;
}

/**
 * Verifies that stored canonical text matches its stored checksum. Throws
 * CORRUPTION_DETECTED identifying the record but never its contents.
 */
export function verifyChecksum(
  canonicalText: string,
  stored: Checksum,
  context: { readonly recordKind: string; readonly recordId: string },
): void {
  const actual = computeChecksumOfText(canonicalText);
  if (!checksumEquals(actual, stored)) {
    throw new PersistenceError(
      "CORRUPTION_DETECTED",
      `Stored ${context.recordKind} failed checksum verification.`,
      {
        recordKind: context.recordKind,
        recordId: context.recordId,
        algorithm: stored.algorithm,
      },
    );
  }
}
