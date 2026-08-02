import {
  DIGEST_ALGORITHMS,
  digestEquals,
  parseArtifactDigest,
  type ArtifactDigest,
  type DigestAlgorithm,
} from "@ai-dev-os/artifacts";
import { ArtifactStoreError } from "./errors.js";

/**
 * A content key IS the artifact digest contract from @ai-dev-os/artifacts:
 * an explicit algorithm plus exact-length lowercase hexadecimal text. The
 * byte store addresses objects only by validated content keys — never by
 * artifact ids, display names, or caller-provided paths.
 */
export type ContentKey = ArtifactDigest;

export const CONTENT_KEY_ALGORITHMS: readonly DigestAlgorithm[] = DIGEST_ALGORITHMS;

export function parseContentKey(value: unknown): ContentKey {
  try {
    return parseArtifactDigest(value, "contentKey");
  } catch {
    throw new ArtifactStoreError(
      "INVALID_CONTENT_KEY",
      "The content key must be a supported algorithm with exact-length lowercase hex text.",
    );
  }
}

export const contentKeyEquals = digestEquals;

export type { DigestAlgorithm };
