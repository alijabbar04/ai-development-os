/**
 * Content shape analysis: binary detection, decoding decisions, generated or
 * minified detection, and language classification.
 *
 * The order matters. Bytes are classified as binary *before* anything tries to
 * decode them, so a hostile file cannot steer the indexer into decoding
 * megabytes of arbitrary data as text. Only content that survives binary
 * detection is offered to a strict UTF-8 decoder, and a decode failure is a
 * recorded, deterministic outcome rather than a lossy substitution.
 *
 * Classification is evidence-based and finite. `unknown` is preserved as a
 * real answer; nothing is guessed so that a file "looks indexed".
 */

import { pathBaseName, pathExtension } from "./paths.js";

export const CONTENT_ENCODINGS = Object.freeze([
  "utf-8",
  "invalid-utf-8",
  "binary",
  "empty",
] as const);

export type ContentEncoding = (typeof CONTENT_ENCODINGS)[number];

export const BINARY_EVIDENCE = Object.freeze([
  "none",
  "nul-byte",
  "magic-prefix",
  "control-byte-ratio",
] as const);

export type BinaryEvidence = (typeof BINARY_EVIDENCE)[number];

/** How many leading bytes are examined. Bounded so cost never scales with file size. */
export const BINARY_SNIFF_BYTES = 8_192;

const MAGIC_PREFIXES: readonly (readonly number[])[] = Object.freeze([
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0x47, 0x49, 0x46, 0x38], // GIF8
  [0xff, 0xd8, 0xff], // JPEG
  [0x50, 0x4b, 0x03, 0x04], // ZIP / jar / docx
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0x4d, 0x5a], // PE / DOS MZ
  [0x25, 0x50, 0x44, 0x46], // %PDF
  [0x1f, 0x8b], // gzip
  [0x42, 0x5a, 0x68], // bzip2
  [0xfd, 0x37, 0x7a, 0x58, 0x5a], // xz
  [0x00, 0x61, 0x73, 0x6d], // wasm
]);

function matchesMagic(bytes: Uint8Array): boolean {
  for (const prefix of MAGIC_PREFIXES) {
    if (bytes.length < prefix.length) {
      continue;
    }
    let matched = true;
    for (let index = 0; index < prefix.length; index += 1) {
      if (bytes[index] !== prefix[index]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return true;
    }
  }
  return false;
}

export interface BinaryVerdict {
  readonly binary: boolean;
  readonly evidence: BinaryEvidence;
}

export function detectBinary(bytes: Uint8Array): BinaryVerdict {
  if (bytes.length === 0) {
    return Object.freeze({ binary: false, evidence: "none" as const });
  }
  if (matchesMagic(bytes)) {
    return Object.freeze({ binary: true, evidence: "magic-prefix" as const });
  }
  const limit = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  let controlBytes = 0;
  for (let index = 0; index < limit; index += 1) {
    const byte = bytes[index] ?? 0;
    if (byte === 0x00) {
      return Object.freeze({ binary: true, evidence: "nul-byte" as const });
    }
    // Tab, newline, carriage return, and form feed are ordinary in text.
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) {
      controlBytes += 1;
    }
  }
  // Integer comparison: more than one control byte in ten.
  if (controlBytes * 10 > limit) {
    return Object.freeze({ binary: true, evidence: "control-byte-ratio" as const });
  }
  return Object.freeze({ binary: false, evidence: "none" as const });
}

export interface DecodedContent {
  readonly encoding: ContentEncoding;
  readonly binaryEvidence: BinaryEvidence;
  /** Decoded text, or null whenever the encoding is not `utf-8`. */
  readonly text: string | null;
  /** True when only a prefix of the file was decoded. */
  readonly truncated: boolean;
  readonly byteLength: number;
}

/**
 * Decides how a file's bytes may be treated. Only genuinely textual, strictly
 * valid UTF-8 content yields text; everything else is reported honestly and
 * carries no text at all.
 */
export function decodeContent(bytes: Uint8Array, maxTextBytes: number): DecodedContent {
  if (bytes.length === 0) {
    return Object.freeze({
      encoding: "empty" as const,
      binaryEvidence: "none" as const,
      text: null,
      truncated: false,
      byteLength: 0,
    });
  }
  const verdict = detectBinary(bytes);
  if (verdict.binary) {
    return Object.freeze({
      encoding: "binary" as const,
      binaryEvidence: verdict.evidence,
      text: null,
      truncated: false,
      byteLength: bytes.length,
    });
  }

  // Truncation happens on a UTF-8 sequence boundary so a split multi-byte
  // character can never turn into a replacement character or a decode error.
  const truncated = bytes.length > maxTextBytes;
  const cut = truncated ? safeUtf8Cut(bytes, maxTextBytes) : bytes.length;
  const slice = truncated ? bytes.subarray(0, cut) : bytes;

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(slice);
  } catch {
    return Object.freeze({
      encoding: "invalid-utf-8" as const,
      binaryEvidence: verdict.evidence,
      text: null,
      truncated,
      byteLength: bytes.length,
    });
  }
  return Object.freeze({
    encoding: "utf-8" as const,
    binaryEvidence: verdict.evidence,
    text,
    truncated,
    byteLength: bytes.length,
  });
}

/**
 * Largest offset at or below `limit` that does not fall inside a UTF-8
 * multi-byte sequence. Continuation bytes have the high bits `10`.
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

export const GENERATED_EVIDENCE = Object.freeze([
  "none",
  "marker-comment",
  "long-line",
  "high-average-line-length",
] as const);

export type GeneratedEvidence = (typeof GENERATED_EVIDENCE)[number];

const GENERATED_MARKERS: readonly string[] = Object.freeze([
  "@generated",
  "DO NOT EDIT",
  "do not edit",
  "This file is automatically generated",
  "Code generated by",
]);

export const MAX_ORDINARY_LINE_LENGTH = 1_000;
export const MAX_ORDINARY_AVERAGE_LINE_LENGTH = 400;

export interface GeneratedVerdict {
  readonly generated: boolean;
  readonly evidence: GeneratedEvidence;
  readonly lineCount: number;
  readonly longestLineLength: number;
}

/** Bounded, evidence-based detection of machine-generated or minified text. */
export function detectGenerated(text: string): GeneratedVerdict {
  let lineCount = 1;
  let longest = 0;
  let current = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0x0a) {
      lineCount += 1;
      longest = Math.max(longest, current);
      current = 0;
      continue;
    }
    current += 1;
  }
  longest = Math.max(longest, current);

  const head = text.slice(0, 2_000);
  for (const marker of GENERATED_MARKERS) {
    if (head.includes(marker)) {
      return Object.freeze({
        generated: true,
        evidence: "marker-comment" as const,
        lineCount,
        longestLineLength: longest,
      });
    }
  }
  if (longest > MAX_ORDINARY_LINE_LENGTH) {
    return Object.freeze({
      generated: true,
      evidence: "long-line" as const,
      lineCount,
      longestLineLength: longest,
    });
  }
  if (text.length > 4_000 && Math.floor(text.length / lineCount) > MAX_ORDINARY_AVERAGE_LINE_LENGTH) {
    return Object.freeze({
      generated: true,
      evidence: "high-average-line-length" as const,
      lineCount,
      longestLineLength: longest,
    });
  }
  return Object.freeze({
    generated: false,
    evidence: "none" as const,
    lineCount,
    longestLineLength: longest,
  });
}

export const LANGUAGE_IDS = Object.freeze([
  "unknown",
  "c",
  "cpp",
  "csharp",
  "css",
  "dockerfile",
  "go",
  "html",
  "ini",
  "java",
  "javascript",
  "json",
  "makefile",
  "markdown",
  "plaintext",
  "powershell",
  "python",
  "ruby",
  "rust",
  "shell",
  "sql",
  "toml",
  "typescript",
  "xml",
  "yaml",
] as const);

export type LanguageId = (typeof LANGUAGE_IDS)[number];

export const CLASSIFICATION_EVIDENCE = Object.freeze([
  "extension",
  "file-name",
  "shebang",
  "none",
] as const);

export type ClassificationEvidence = (typeof CLASSIFICATION_EVIDENCE)[number];

const EXTENSION_LANGUAGES: Readonly<Record<string, LanguageId>> = Object.freeze({
  ".c": "c",
  ".cc": "cpp",
  ".cfg": "ini",
  ".cjs": "javascript",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".cxx": "cpp",
  ".go": "go",
  ".h": "c",
  ".hpp": "cpp",
  ".htm": "html",
  ".html": "html",
  ".ini": "ini",
  ".java": "java",
  ".js": "javascript",
  ".json": "json",
  ".jsx": "javascript",
  ".md": "markdown",
  ".markdown": "markdown",
  ".mjs": "javascript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".ps1": "powershell",
  ".psm1": "powershell",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".sh": "shell",
  ".sql": "sql",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".txt": "plaintext",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
});

const FILE_NAME_LANGUAGES: Readonly<Record<string, LanguageId>> = Object.freeze({
  Dockerfile: "dockerfile",
  GNUmakefile: "makefile",
  Makefile: "makefile",
  makefile: "makefile",
});

const SHEBANG_LANGUAGES: readonly (readonly [string, LanguageId])[] = Object.freeze([
  ["python", "python"],
  ["node", "javascript"],
  ["bash", "shell"],
  ["sh", "shell"],
  ["zsh", "shell"],
  ["ruby", "ruby"],
  ["pwsh", "powershell"],
]);

export interface LanguageClassification {
  readonly languageId: LanguageId;
  readonly evidence: ClassificationEvidence;
}

/**
 * Classifies a file. Extension evidence wins over a shebang because the
 * extension is part of the path the caller already validated, while a shebang
 * is content a hostile repository controls freely.
 */
export function classifyLanguage(
  canonicalPath: string,
  firstLine: string | null,
): LanguageClassification {
  const extension = pathExtension(canonicalPath);
  const byExtension = EXTENSION_LANGUAGES[extension];
  if (byExtension !== undefined) {
    return Object.freeze({ languageId: byExtension, evidence: "extension" as const });
  }
  const byName = FILE_NAME_LANGUAGES[pathBaseName(canonicalPath)];
  if (byName !== undefined) {
    return Object.freeze({ languageId: byName, evidence: "file-name" as const });
  }
  if (firstLine !== null && firstLine.startsWith("#!") && firstLine.length <= 200) {
    // Interpreter names are matched on the final path segment of each token
    // with any version suffix removed, so `#!/usr/bin/env python3.11` and
    // `#!/bin/python` are both recognized without substring guessing.
    const tokens = firstLine
      .slice(2)
      .split(/[\s]+/)
      .map((token) => token.slice(token.lastIndexOf("/") + 1).replace(/[0-9.]+$/, ""))
      .filter((token) => token.length > 0);
    for (const [needle, languageId] of SHEBANG_LANGUAGES) {
      if (tokens.includes(needle)) {
        return Object.freeze({ languageId, evidence: "shebang" as const });
      }
    }
  }
  return Object.freeze({ languageId: "unknown" as const, evidence: "none" as const });
}
