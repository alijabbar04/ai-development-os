/**
 * Budget units.
 *
 * Stage 14 does not know what a token is for any particular model, and it does
 * not pretend to. It counts **units**: a deliberately conservative,
 * provider-neutral upper bound that a later provider-specific estimator
 * (Stage 16) replaces with a real one.
 *
 * The default estimator charges one unit per three UTF-8 bytes. Real
 * tokenizers average roughly four bytes per token on source code and prose, so
 * this over-counts — which is the safe direction: a pack built inside a unit
 * budget will fit inside the equivalent token budget, never the reverse.
 *
 * An estimator that claims `exact: true` is rejected outright. Exactness is a
 * property only a model-specific tokenizer can have, and a pack that claimed
 * it here would be lying to whatever compiles the final prompt.
 */

import { contextFailure, type ContextFailure } from "./errors.js";

export interface ContextUnitEstimator {
  /** Stable identifier recorded in the pack so a reader knows what counted. */
  readonly estimatorId: string;
  /** Must be false in this stage. Only a real tokenizer may claim exactness. */
  readonly exact: false;
  /** Bytes per unit, recorded for transparency. */
  readonly bytesPerUnit: number;
  estimate(text: string): number;
}

export const CONSERVATIVE_BYTES_PER_UNIT = 3;

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export const conservativeUnitEstimator: ContextUnitEstimator = Object.freeze({
  estimatorId: "conservative-utf8-bytes-per-3",
  exact: false as const,
  bytesPerUnit: CONSERVATIVE_BYTES_PER_UNIT,
  estimate: (text: string): number =>
    Math.ceil(utf8ByteLength(text) / CONSERVATIVE_BYTES_PER_UNIT),
});

/**
 * Validates an injected estimator. A caller may supply a different
 * provider-neutral unit, but not a claim of exactness and not a
 * non-deterministic or unbounded implementation.
 */
export function validateEstimator(
  estimator: ContextUnitEstimator,
): ContextFailure | null {
  if (
    typeof estimator !== "object" ||
    estimator === null ||
    typeof estimator.estimate !== "function"
  ) {
    return contextFailure("ESTIMATOR_REJECTED", "The estimator does not implement the port.");
  }
  if (estimator.exact !== false) {
    return contextFailure(
      "ESTIMATOR_REJECTED",
      "An estimator cannot claim exactness in this stage; provider-specific token counting is deferred.",
      { estimatorId: String(estimator.estimatorId).slice(0, 64) },
    );
  }
  if (
    typeof estimator.estimatorId !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(estimator.estimatorId)
  ) {
    return contextFailure("ESTIMATOR_REJECTED", "The estimator identifier is malformed.");
  }
  if (
    !Number.isSafeInteger(estimator.bytesPerUnit) ||
    estimator.bytesPerUnit < 1 ||
    estimator.bytesPerUnit > 64
  ) {
    return contextFailure("ESTIMATOR_REJECTED", "The estimator's bytes-per-unit is out of range.");
  }
  // Determinism and monotonicity are cheap to spot-check and expensive to be
  // wrong about, because every budget decision depends on them.
  const probe = "abcdefghij";
  const first = estimator.estimate(probe);
  const second = estimator.estimate(probe);
  if (first !== second || !Number.isSafeInteger(first) || first < 0) {
    return contextFailure(
      "ESTIMATOR_REJECTED",
      "The estimator is not deterministic or returns an invalid count.",
    );
  }
  if (estimator.estimate("") !== 0) {
    return contextFailure("ESTIMATOR_REJECTED", "The estimator must charge nothing for empty text.");
  }
  if (estimator.estimate(`${probe}${probe}`) < first) {
    return contextFailure("ESTIMATOR_REJECTED", "The estimator is not monotonic in input length.");
  }
  return null;
}

/**
 * Largest byte offset at or below `limit` that does not split a UTF-8
 * sequence. Truncating anywhere else would produce a replacement character and
 * change the bytes a digest was taken over.
 */
export function safeUtf8Cut(bytes: Uint8Array, limit: number): number {
  let cut = Math.min(limit, bytes.length);
  let scanned = 0;
  while (cut > 0 && scanned < 4) {
    const byte = bytes[cut] ?? 0;
    if (cut < bytes.length && (byte & 0xc0) === 0x80) {
      cut -= 1;
      scanned += 1;
      continue;
    }
    break;
  }
  return cut;
}

/** Truncates text to at most `maxBytes` UTF-8 bytes on a character boundary. */
export function truncateToBytes(
  text: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean; readonly byteLength: number } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) {
    return Object.freeze({ text, truncated: false, byteLength: bytes.length });
  }
  const cut = safeUtf8Cut(bytes, maxBytes);
  const slice = bytes.subarray(0, cut);
  return Object.freeze({
    text: new TextDecoder("utf-8", { fatal: false }).decode(slice),
    truncated: true,
    byteLength: cut,
  });
}
