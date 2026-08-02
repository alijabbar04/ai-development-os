import { createHash, type Hash } from "node:crypto";
import { ArtifactStoreError } from "./errors.js";
import type { ContentKey, DigestAlgorithm } from "./content-key.js";

/**
 * The byte-stream contract for the artifact store is AsyncIterable of
 * Uint8Array chunks. It is runtime-neutral (no Node stream types in the
 * port), pull-based (backpressure falls out of iteration), single-use by
 * construction, and both Node Readable streams and Web ReadableStreams
 * already satisfy it. Chunks are strictly validated: anything that is not
 * a Uint8Array fails with INVALID_STREAM.
 */
export type ByteStream = AsyncIterable<Uint8Array>;

const NODE_HASH_NAMES: Readonly<Record<DigestAlgorithm, string>> = Object.freeze({
  "sha-256": "sha256",
  "sha-512": "sha512",
});

export function ensureByteChunk(chunk: unknown): Uint8Array {
  if (!(chunk instanceof Uint8Array)) {
    throw new ArtifactStoreError(
      "INVALID_STREAM",
      "Byte streams must yield Uint8Array chunks only.",
      { receivedType: typeof chunk },
    );
  }
  return chunk;
}

const textEncoder = new TextEncoder();

export function toBytes(value: Uint8Array | string): Uint8Array {
  if (typeof value === "string") {
    return textEncoder.encode(value);
  }
  return ensureByteChunk(value);
}

/** Wraps in-memory bytes (or UTF-8 text) as a single-chunk byte stream. */
export async function* bytesToStream(value: Uint8Array | string): ByteStream {
  yield toBytes(value);
}

/**
 * Collects a byte stream into memory with a mandatory upper bound. This is
 * the only sanctioned way to buffer a whole object; unbounded collection is
 * deliberately not offered.
 */
export async function collectBytes(stream: ByteStream, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new ArtifactStoreError(
      "INVALID_CONFIGURATION",
      "collectBytes requires a non-negative safe-integer byte bound.",
    );
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const raw of stream) {
    const chunk = ensureByteChunk(raw);
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new ArtifactStoreError(
        "SIZE_LIMIT_EXCEEDED",
        "The stream exceeded the caller-provided byte bound.",
        { maxBytes },
      );
    }
    chunks.push(chunk);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export interface IncrementalDigest {
  update(chunk: Uint8Array): void;
  /** Finishes the hash and returns the content key. Single use. */
  finish(): ContentKey;
}

export function createIncrementalDigest(algorithm: DigestAlgorithm): IncrementalDigest {
  const hashName = NODE_HASH_NAMES[algorithm];
  const hash: Hash = createHash(hashName);
  let finished = false;
  return {
    update(chunk: Uint8Array): void {
      if (finished) {
        throw new ArtifactStoreError(
          "INVALID_STREAM",
          "The incremental digest was already finished.",
        );
      }
      hash.update(chunk);
    },
    finish(): ContentKey {
      if (finished) {
        throw new ArtifactStoreError(
          "INVALID_STREAM",
          "The incremental digest was already finished.",
        );
      }
      finished = true;
      return Object.freeze({ algorithm, hex: hash.digest("hex") });
    },
  };
}

/** Computes the content key of in-memory bytes (or UTF-8 text). */
export function contentKeyOfBytes(
  value: Uint8Array | string,
  algorithm: DigestAlgorithm = "sha-256",
): ContentKey {
  const digest = createIncrementalDigest(algorithm);
  digest.update(toBytes(value));
  return digest.finish();
}
