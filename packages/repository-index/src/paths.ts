/**
 * Canonical repository-relative paths.
 *
 * Every path that enters the index passes through `canonicalizeRepositoryPath`
 * exactly once. The rules are lexical and deliberately stricter than any
 * filesystem: what cannot be expressed cannot be smuggled. Case and Unicode
 * behaviour follow the snapshot's *declared* filesystem semantics rather than
 * the semantics of the machine running the indexer, so an index built on
 * Windows and an index built on Linux over the same snapshot agree.
 *
 * Character classes are expressed as numeric code-point tests rather than
 * regular-expression literals so that the source file itself stays free of
 * invisible characters.
 */

import type { FilesystemSemantics } from "./read-port.js";

export const MAX_REPOSITORY_PATH_LENGTH = 1_024;
export const MAX_REPOSITORY_SEGMENT_LENGTH = 255;
export const MAX_REPOSITORY_PATH_DEPTH = 64;

export const PATH_REJECTION_REASONS = Object.freeze([
  "not-a-string",
  "empty",
  "too-long",
  "too-deep",
  "absolute",
  "drive-letter",
  "unc-prefix",
  "backslash",
  "empty-segment",
  "segment-too-long",
  "traversal",
  "home-reference",
  "control-character",
  "alternate-data-stream",
  "reserved-device-name",
  "unsafe-segment-edges",
  "bidi-or-format-character",
  "unpaired-surrogate",
] as const);

export type PathRejectionReason = (typeof PATH_REJECTION_REASONS)[number];

export type PathCanonicalization =
  | { readonly ok: true; readonly canonicalPath: string; readonly collisionKey: string }
  | { readonly ok: false; readonly reason: PathRejectionReason };

const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

/** C0 controls, DEL, and the C1 range. */
function isControlCodeUnit(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/**
 * Invisible or text-reordering code units. A path containing them can display
 * as one thing and resolve as another, which is exactly the confusion an index
 * must not carry into a prompt.
 */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = Object.freeze([
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // arabic letter mark
  [0x115f, 0x1160], // hangul choseong/jungseong fillers
  [0x17b4, 0x17b5], // khmer inherent vowels
  [0x180b, 0x180e], // mongolian variation selectors and vowel separator
  [0x200b, 0x200f], // zero-width space through right-to-left mark
  [0x202a, 0x202e], // bidirectional embedding and override controls
  [0x2060, 0x2064], // word joiner through invisible plus
  [0x2066, 0x206f], // bidirectional isolates and deprecated format controls
  [0x3164, 0x3164], // hangul filler
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff], // zero-width no-break space
  [0xffa0, 0xffa0], // halfwidth hangul filler
  [0xfff9, 0xfffb], // interlinear annotation controls
]);

function isInvisibleCodeUnit(code: number): boolean {
  for (const [start, end] of INVISIBLE_RANGES) {
    if (code >= start && code <= end) {
      return true;
    }
  }
  return false;
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function rejected(reason: PathRejectionReason): PathCanonicalization {
  return Object.freeze({ ok: false as const, reason });
}

/**
 * Validates and canonicalizes one raw snapshot path.
 *
 * Returns the canonical path (what the index stores and what consumers see)
 * together with a collision key. Two entries whose collision keys are equal
 * cannot both exist on the declared filesystem, so the indexer treats that as
 * a collision rather than silently keeping one of them.
 */
export function canonicalizeRepositoryPath(
  raw: unknown,
  semantics: FilesystemSemantics,
): PathCanonicalization {
  if (typeof raw !== "string") {
    return rejected("not-a-string");
  }
  if (raw.length === 0) {
    return rejected("empty");
  }
  if (raw.length > MAX_REPOSITORY_PATH_LENGTH) {
    return rejected("too-long");
  }
  if (hasUnpairedSurrogate(raw)) {
    return rejected("unpaired-surrogate");
  }
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    if (isControlCodeUnit(code)) {
      return rejected("control-character");
    }
    if (isInvisibleCodeUnit(code)) {
      return rejected("bidi-or-format-character");
    }
  }
  if (raw.includes("\\")) {
    return rejected(raw.startsWith("\\\\") ? "unc-prefix" : "backslash");
  }
  if (raw.startsWith("/")) {
    return rejected("absolute");
  }
  if (/^[A-Za-z]:/.test(raw)) {
    return rejected("drive-letter");
  }

  // Normalization runs before segmentation so a decomposed separator-adjacent
  // sequence cannot shift the segment boundaries afterwards.
  const normalized = semantics.unicodeForm === "nfc" ? raw.normalize("NFC") : raw;
  if (normalized.length > MAX_REPOSITORY_PATH_LENGTH) {
    return rejected("too-long");
  }

  const segments = normalized.split("/");
  if (segments.length > MAX_REPOSITORY_PATH_DEPTH) {
    return rejected("too-deep");
  }

  for (const segment of segments) {
    if (segment.length === 0) {
      return rejected("empty-segment");
    }
    if (segment.length > MAX_REPOSITORY_SEGMENT_LENGTH) {
      return rejected("segment-too-long");
    }
    if (segment === "." || segment === "..") {
      return rejected("traversal");
    }
    if (segment === "~") {
      return rejected("home-reference");
    }
    // NTFS alternate data streams and Windows-forbidden characters. The path
    // `readme.md:$DATA` names different content from `readme.md`.
    if (/[:"<>|?*]/.test(segment)) {
      return rejected("alternate-data-stream");
    }
    if (segment.startsWith(" ") || segment.endsWith(" ") || segment.endsWith(".")) {
      return rejected("unsafe-segment-edges");
    }
    const stem = segment.split(".", 1)[0] ?? segment;
    if (WINDOWS_RESERVED_NAMES.has(stem.toUpperCase())) {
      return rejected("reserved-device-name");
    }
  }

  const foldingBase = normalized.normalize("NFC");
  const collisionKey =
    semantics.caseSensitivity === "case-insensitive" ? foldingBase.toLowerCase() : foldingBase;

  return Object.freeze({ ok: true as const, canonicalPath: normalized, collisionKey });
}

/** Code-unit order comparison; locale-independent by construction. */
export function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The final segment of a canonical path. */
export function pathBaseName(canonicalPath: string): string {
  const index = canonicalPath.lastIndexOf("/");
  return index === -1 ? canonicalPath : canonicalPath.slice(index + 1);
}

/** The parent directory of a canonical path, or "" for a top-level entry. */
export function pathDirName(canonicalPath: string): string {
  const index = canonicalPath.lastIndexOf("/");
  return index === -1 ? "" : canonicalPath.slice(0, index);
}

/** Lowercase extension including the dot, or "" when there is none. */
export function pathExtension(canonicalPath: string): string {
  const base = pathBaseName(canonicalPath);
  const index = base.lastIndexOf(".");
  if (index <= 0 || index === base.length - 1) {
    return "";
  }
  return base.slice(index).toLowerCase();
}

/** Every ancestor directory of a canonical path, shallowest first. */
export function ancestorDirectories(canonicalPath: string): readonly string[] {
  const segments = canonicalPath.split("/");
  const result: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    result.push(segments.slice(0, index).join("/"));
  }
  return Object.freeze(result);
}
