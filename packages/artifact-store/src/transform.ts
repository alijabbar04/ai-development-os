import { validation } from "@ai-dev-os/domain";
import { ArtifactStoreError, isArtifactStoreError } from "./errors.js";
import { parseContentKey, type ContentKey } from "./content-key.js";
import { ensureByteChunk, toBytes, type ByteStream } from "./streams.js";
import type { ArtifactByteStore, WriteOptions, WriteResult } from "./ports.js";

const { ensureString } = validation;

/**
 * The transformation boundary: a named, deterministic stream pipeline that
 * produces NEW content. Transformations never modify the source object —
 * content addressing makes in-place mutation unrepresentable. This is the
 * seam where later redaction and encryption stages plug in.
 */
export interface ArtifactTransformation {
  /** Stable machine name recorded by callers in provenance. */
  readonly name: string;
  apply(source: ByteStream): ByteStream;
}

const TRANSFORMATION_NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

/**
 * Reads a stored object (verified), pipes it through `transformation`, and
 * writes the result as a new object with its own digest and size. The
 * caller owns recording the derived artifact's descriptor, classification,
 * and provenance in the metadata layer.
 */
export async function transformArtifact(
  store: ArtifactByteStore,
  sourceKey: ContentKey,
  transformation: ArtifactTransformation,
  options: WriteOptions = {},
): Promise<WriteResult> {
  const key = parseContentKey(sourceKey);
  ensureString(transformation?.name, "transformation.name", {
    maxLength: 64,
    pattern: TRANSFORMATION_NAME_PATTERN,
    patternName: "transformation name",
  });

  const source = await store.openRead(key, { verify: true });
  let transformed: ByteStream;
  try {
    transformed = transformation.apply(source);
  } catch {
    throw new ArtifactStoreError(
      "TRANSFORMATION_FAILED",
      "The transformation failed to start.",
      { transformation: transformation.name },
    );
  }

  try {
    return await store.write(transformed, options);
  } catch (error) {
    if (isArtifactStoreError(error)) {
      throw error;
    }
    throw new ArtifactStoreError(
      "TRANSFORMATION_FAILED",
      "The transformation pipeline failed while producing output.",
      { transformation: transformation.name },
    );
  }
}

export interface LiteralRedactionOptions {
  /**
   * Exact strings to redact, matched as their UTF-8 byte sequences.
   * This is deliberately NOT generic secret or PII detection: only the
   * literals supplied here are replaced.
   */
  readonly literals: readonly string[];
  /** Replacement text. Default "[REDACTED]". */
  readonly replacement?: string;
}

export const MAX_REDACTION_LITERALS = 64;
export const MAX_REDACTION_LITERAL_LENGTH = 1_024;

function indexOfEarliestMatch(
  buffer: Uint8Array,
  literals: readonly Uint8Array[],
): { readonly index: number; readonly literal: Uint8Array } | null {
  const haystack = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let best: { index: number; literal: Uint8Array } | null = null;
  for (const literal of literals) {
    const index = haystack.indexOf(
      Buffer.from(literal.buffer, literal.byteOffset, literal.byteLength),
    );
    if (index !== -1 && (best === null || index < best.index)) {
      best = { index, literal };
    }
  }
  return best;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.byteLength + b.byteLength);
  result.set(a, 0);
  result.set(b, a.byteLength);
  return result;
}

/**
 * Rule-based streaming redaction of explicitly supplied literal strings.
 *
 * Matching operates on exact UTF-8 byte sequences with a sliding carry
 * window, so literals split across chunk boundaries are still found.
 * Binary content passes through unchanged unless it happens to contain a
 * literal's exact byte sequence. Text in other encodings (UTF-16, etc.)
 * is NOT matched. Overlapping matches are resolved earliest-first, then
 * rescanned after replacement.
 */
export function createLiteralRedactionTransform(
  options: LiteralRedactionOptions,
): ArtifactTransformation {
  if (
    !Array.isArray(options?.literals) ||
    options.literals.length === 0 ||
    options.literals.length > MAX_REDACTION_LITERALS
  ) {
    throw new ArtifactStoreError(
      "INVALID_CONFIGURATION",
      `Redaction requires between 1 and ${MAX_REDACTION_LITERALS} literal rules.`,
    );
  }
  const literals = options.literals.map((literal, index) =>
    toBytes(
      ensureString(literal, `literals[${index}]`, {
        maxLength: MAX_REDACTION_LITERAL_LENGTH,
      }),
    ),
  );
  const replacement = toBytes(
    ensureString(options.replacement ?? "[REDACTED]", "replacement", {
      minLength: 0,
      maxLength: 256,
    }),
  );
  const holdback = Math.max(...literals.map((literal) => literal.byteLength)) - 1;

  return Object.freeze({
    name: "redact-literals",
    apply(source: ByteStream): ByteStream {
      return (async function* redacted(): ByteStream {
        let carry = new Uint8Array(0);

        const drain = (buffer: Uint8Array, final: boolean): Uint8Array[] => {
          const output: Uint8Array[] = [];
          let remaining = buffer;
          for (;;) {
            const match = indexOfEarliestMatch(remaining, literals);
            if (match === null) {
              break;
            }
            if (match.index > 0) {
              output.push(remaining.slice(0, match.index));
            }
            output.push(replacement);
            remaining = remaining.slice(match.index + match.literal.byteLength);
          }
          const safeLength = final
            ? remaining.byteLength
            : Math.max(0, remaining.byteLength - holdback);
          if (safeLength > 0) {
            output.push(remaining.slice(0, safeLength));
          }
          carry = remaining.slice(safeLength);
          return output;
        };

        for await (const raw of source) {
          const chunk = ensureByteChunk(raw);
          for (const piece of drain(concatBytes(carry, chunk), false)) {
            yield piece;
          }
        }
        for (const piece of drain(carry, true)) {
          yield piece;
        }
      })();
    },
  });
}
