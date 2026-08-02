import {
  validation,
  type Branded,
  type WorkspaceId,
} from "@ai-dev-os/domain";

const { ensureEnum, ensureExactKeys, ensureRecord, ensureString, fail } = validation;

export const DIGEST_ALGORITHMS = Object.freeze(["sha-256", "sha-512"] as const);
export type DigestAlgorithm = (typeof DIGEST_ALGORITHMS)[number];

const DIGEST_HEX_LENGTH: Readonly<Record<DigestAlgorithm, number>> = Object.freeze({
  "sha-256": 64,
  "sha-512": 128,
});

const LOWER_HEX_PATTERN = /^[0-9a-f]+$/;

/** Content digest. The digest identifies content; it never makes content trusted. */
export interface ArtifactDigest {
  readonly algorithm: DigestAlgorithm;
  readonly hex: string;
}

export function parseArtifactDigest(value: unknown, path = "artifactDigest"): ArtifactDigest {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["algorithm", "hex"], path);
  const algorithm = ensureEnum(record["algorithm"], `${path}.algorithm`, DIGEST_ALGORITHMS);
  const expectedLength = DIGEST_HEX_LENGTH[algorithm];
  const hex = ensureString(record["hex"], `${path}.hex`, {
    minLength: expectedLength,
    maxLength: expectedLength,
    pattern: LOWER_HEX_PATTERN,
    patternName: "lowercase hexadecimal digest",
  });
  return Object.freeze({ algorithm, hex });
}

export function createArtifactDigest(algorithm: DigestAlgorithm, hex: string): ArtifactDigest {
  return parseArtifactDigest({ algorithm, hex });
}

export function digestEquals(a: ArtifactDigest, b: ArtifactDigest): boolean {
  return a.algorithm === b.algorithm && a.hex === b.hex;
}

/**
 * A validated, forward-slash, workspace-relative path. Rejects traversal,
 * absolute paths, drive letters, UNC prefixes, Windows device names,
 * control characters, and segments that Windows normalizes unsafely.
 * Consumers must still canonicalize and revalidate at use time against
 * symlinks, junctions, and case folding; this type only guarantees the
 * lexical shape.
 */
export type SafeRelativePath = string & Branded<"SafeRelativePath">;

export const MAX_RELATIVE_PATH_LENGTH = 1_024;
export const MAX_PATH_SEGMENT_LENGTH = 255;

const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

// Control characters plus the characters Windows forbids in file names.
// eslint-disable-next-line no-control-regex -- control characters are exactly what is rejected
const FORBIDDEN_SEGMENT_CHARS = /[\u0000-\u001f\u007f<>:"|?*]/;

export function parseSafeRelativePath(value: unknown, path = "relativePath"): SafeRelativePath {
  const text = ensureString(value, path, { maxLength: MAX_RELATIVE_PATH_LENGTH });

  if (text.includes("\\")) {
    fail(path, "backslash", "must use forward slashes as separators.");
  }
  if (text.startsWith("/")) {
    fail(path, "absolute_path", "must be relative, not absolute.");
  }
  if (/^[A-Za-z]:/.test(text)) {
    fail(path, "drive_letter", "cannot contain a drive letter.");
  }

  const segments = text.split("/");
  segments.forEach((segment, index) => {
    const segmentPath = `${path}[segment ${index}]`;
    if (segment.length === 0) {
      fail(segmentPath, "empty_segment", "cannot contain empty path segments.");
    }
    if (segment.length > MAX_PATH_SEGMENT_LENGTH) {
      fail(
        segmentPath,
        "segment_too_long",
        `segments cannot exceed ${MAX_PATH_SEGMENT_LENGTH} characters.`,
      );
    }
    if (segment === "." || segment === "..") {
      fail(segmentPath, "traversal", "cannot contain '.' or '..' segments.");
    }
    if (segment === "~") {
      fail(segmentPath, "home_reference", "cannot contain a '~' segment.");
    }
    if (FORBIDDEN_SEGMENT_CHARS.test(segment)) {
      fail(segmentPath, "forbidden_character", "contains a forbidden path character.");
    }
    if (segment.endsWith(".") || segment.endsWith(" ") || segment.startsWith(" ")) {
      fail(
        segmentPath,
        "unsafe_edges",
        "segments cannot start with a space or end with a space or dot.",
      );
    }
    const stem = segment.split(".", 1)[0] ?? segment;
    if (WINDOWS_RESERVED_NAMES.has(stem.toUpperCase())) {
      fail(segmentPath, "reserved_device_name", "matches a reserved Windows device name.");
    }
  });

  return text as SafeRelativePath;
}

export const ARTIFACT_STORE_KINDS = Object.freeze(["local", "remote"] as const);
export type ArtifactStoreKind = (typeof ARTIFACT_STORE_KINDS)[number];

/**
 * Where artifact bytes live. Content-addressed entries are located by the
 * descriptor digest; workspace files carry a validated relative path only.
 * Raw absolute filesystem paths are unrepresentable by design.
 */
export type ArtifactLocation =
  | {
      readonly type: "content-addressed";
      readonly store: ArtifactStoreKind;
    }
  | {
      readonly type: "workspace-file";
      readonly workspaceId: WorkspaceId;
      readonly path: SafeRelativePath;
    };

export const ARTIFACT_LOCATION_TYPES = Object.freeze(["content-addressed", "workspace-file"] as const);

export function parseArtifactLocation(value: unknown, path = "artifactLocation"): ArtifactLocation {
  const record = ensureRecord(value, path);
  const type = ensureEnum(record["type"], `${path}.type`, ARTIFACT_LOCATION_TYPES);

  if (type === "content-addressed") {
    ensureExactKeys(record, ["type", "store"], path);
    return Object.freeze({
      type,
      store: ensureEnum(record["store"], `${path}.store`, ARTIFACT_STORE_KINDS),
    });
  }

  ensureExactKeys(record, ["type", "workspaceId", "path"], path);
  return Object.freeze({
    type,
    workspaceId: ensureString(record["workspaceId"], `${path}.workspaceId`, {
      maxLength: 128,
      pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
      patternName: "WorkspaceId",
    }) as WorkspaceId,
    path: parseSafeRelativePath(record["path"], `${path}.path`),
  });
}
