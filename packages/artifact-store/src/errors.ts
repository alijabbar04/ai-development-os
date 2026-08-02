export const ARTIFACT_STORE_ERROR_CODES = Object.freeze([
  "INVALID_CONFIGURATION",
  "STORE_CLOSED",
  "INVALID_CONTENT_KEY",
  "OBJECT_NOT_FOUND",
  "SIZE_LIMIT_EXCEEDED",
  "SIZE_MISMATCH",
  "DIGEST_MISMATCH",
  "OBJECT_CORRUPTED",
  "UNSAFE_FILESYSTEM_STATE",
  "WRITE_INTERRUPTED",
  "INVALID_STREAM",
  "TRANSFORMATION_FAILED",
  "CLEANUP_FAILED",
] as const);

export type ArtifactStoreErrorCode = (typeof ARTIFACT_STORE_ERROR_CODES)[number];

/**
 * Detail values are restricted to primitive summaries: digests, algorithm
 * names, sizes, and counts. Raw filesystem paths, payload bytes, source
 * content, and secrets must never appear in messages or details.
 */
export type ArtifactStoreErrorDetailValue =
  | string
  | number
  | boolean
  | null
  | readonly ArtifactStoreErrorDetailValue[];

export type ArtifactStoreErrorDetails = Readonly<
  Record<string, ArtifactStoreErrorDetailValue>
>;

export class ArtifactStoreError extends Error {
  readonly code: ArtifactStoreErrorCode;
  readonly details: ArtifactStoreErrorDetails;

  constructor(
    code: ArtifactStoreErrorCode,
    message: string,
    details: ArtifactStoreErrorDetails = {},
  ) {
    super(message);
    this.name = "ArtifactStoreError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  toJSON(): {
    readonly name: string;
    readonly code: ArtifactStoreErrorCode;
    readonly message: string;
    readonly details: ArtifactStoreErrorDetails;
  } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export function isArtifactStoreError(
  value: unknown,
  code?: ArtifactStoreErrorCode,
): value is ArtifactStoreError {
  return (
    value instanceof ArtifactStoreError && (code === undefined || value.code === code)
  );
}
