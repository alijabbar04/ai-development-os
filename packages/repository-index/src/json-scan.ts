/**
 * A structural JSON scanner used *in addition to* `parseJsonText`.
 *
 * `JSON.parse` silently keeps the last of a set of duplicate object keys, so a
 * manifest can declare `"dependencies"` twice and present a different view to
 * a reader than to a parser. The scanner walks the raw text once and reports
 * duplicates before the value is trusted. It also enforces its own depth and
 * node bounds so a pathological document is rejected on cost rather than on
 * content.
 *
 * The scanner recognizes strict RFC 8259 JSON only. Comments, trailing
 * commas, single quotes, unquoted keys, and `NaN`/`Infinity` are structural
 * errors, not tolerated dialects — a manifest that needs them is reported as
 * malformed rather than guessed at.
 */

export const MAX_JSON_SCAN_DEPTH = 32;
export const MAX_JSON_SCAN_NODES = 200_000;

export type JsonScanResult =
  | { readonly ok: true; readonly duplicateKeyPaths: readonly string[] }
  | { readonly ok: false; readonly reason: JsonScanFailureReason; readonly offset: number };

export const JSON_SCAN_FAILURE_REASONS = Object.freeze([
  "malformed",
  "too-deep",
  "too-many-nodes",
  "trailing-content",
  "unsupported-token",
] as const);

export type JsonScanFailureReason = (typeof JSON_SCAN_FAILURE_REASONS)[number];

interface ScanState {
  readonly text: string;
  offset: number;
  nodes: number;
  readonly duplicates: string[];
}

function isWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}

function skipWhitespace(state: ScanState): void {
  while (state.offset < state.text.length) {
    const character = state.text.charAt(state.offset);
    if (!isWhitespace(character)) {
      return;
    }
    state.offset += 1;
  }
}

class ScanFailure extends Error {
  readonly reason: JsonScanFailureReason;
  readonly offset: number;

  constructor(reason: JsonScanFailureReason, offset: number) {
    super(reason);
    this.name = "ScanFailure";
    this.reason = reason;
    this.offset = offset;
  }
}

function expect(state: ScanState, character: string): void {
  if (state.text.charAt(state.offset) !== character) {
    throw new ScanFailure("malformed", state.offset);
  }
  state.offset += 1;
}

function scanString(state: ScanState): string {
  expect(state, '"');
  let result = "";
  for (;;) {
    if (state.offset >= state.text.length) {
      throw new ScanFailure("malformed", state.offset);
    }
    const character = state.text.charAt(state.offset);
    const code = state.text.charCodeAt(state.offset);
    if (character === '"') {
      state.offset += 1;
      return result;
    }
    if (code < 0x20) {
      throw new ScanFailure("malformed", state.offset);
    }
    if (character !== "\\") {
      result += character;
      state.offset += 1;
      continue;
    }
    state.offset += 1;
    const escape = state.text.charAt(state.offset);
    state.offset += 1;
    switch (escape) {
      case '"':
        result += '"';
        break;
      case "\\":
        result += "\\";
        break;
      case "/":
        result += "/";
        break;
      case "b":
        result += "\b";
        break;
      case "f":
        result += "\f";
        break;
      case "n":
        result += "\n";
        break;
      case "r":
        result += "\r";
        break;
      case "t":
        result += "\t";
        break;
      case "u": {
        const hex = state.text.slice(state.offset, state.offset + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new ScanFailure("malformed", state.offset);
        }
        result += String.fromCharCode(Number.parseInt(hex, 16));
        state.offset += 4;
        break;
      }
      default:
        throw new ScanFailure("malformed", state.offset - 1);
    }
  }
}

function scanNumber(state: ScanState): void {
  const pattern = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;
  const match = pattern.exec(state.text.slice(state.offset));
  if (match === null || match[0].length === 0) {
    throw new ScanFailure("malformed", state.offset);
  }
  state.offset += match[0].length;
}

function scanLiteral(state: ScanState, literal: string): void {
  if (!state.text.startsWith(literal, state.offset)) {
    throw new ScanFailure("unsupported-token", state.offset);
  }
  state.offset += literal.length;
}

function scanValue(state: ScanState, path: string, depth: number): void {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_SCAN_NODES) {
    throw new ScanFailure("too-many-nodes", state.offset);
  }
  if (depth > MAX_JSON_SCAN_DEPTH) {
    throw new ScanFailure("too-deep", state.offset);
  }
  skipWhitespace(state);
  const character = state.text.charAt(state.offset);
  switch (character) {
    case "{":
      scanObject(state, path, depth);
      return;
    case "[":
      scanArray(state, path, depth);
      return;
    case '"':
      scanString(state);
      return;
    case "t":
      scanLiteral(state, "true");
      return;
    case "f":
      scanLiteral(state, "false");
      return;
    case "n":
      scanLiteral(state, "null");
      return;
    case "N":
    case "I":
      // `NaN` and `Infinity` are JavaScript, not JSON.
      throw new ScanFailure("unsupported-token", state.offset);
    default:
      scanNumber(state);
  }
}

function scanObject(state: ScanState, path: string, depth: number): void {
  expect(state, "{");
  const seen = new Set<string>();
  skipWhitespace(state);
  if (state.text.charAt(state.offset) === "}") {
    state.offset += 1;
    return;
  }
  for (;;) {
    skipWhitespace(state);
    const key = scanString(state);
    if (seen.has(key) && state.duplicates.length < 64) {
      state.duplicates.push(`${path}/${key}`);
    }
    seen.add(key);
    skipWhitespace(state);
    expect(state, ":");
    scanValue(state, `${path}/${key}`, depth + 1);
    skipWhitespace(state);
    const next = state.text.charAt(state.offset);
    if (next === ",") {
      state.offset += 1;
      continue;
    }
    if (next === "}") {
      state.offset += 1;
      return;
    }
    throw new ScanFailure("malformed", state.offset);
  }
}

function scanArray(state: ScanState, path: string, depth: number): void {
  expect(state, "[");
  skipWhitespace(state);
  if (state.text.charAt(state.offset) === "]") {
    state.offset += 1;
    return;
  }
  let index = 0;
  for (;;) {
    scanValue(state, `${path}/${index}`, depth + 1);
    index += 1;
    skipWhitespace(state);
    const next = state.text.charAt(state.offset);
    if (next === ",") {
      state.offset += 1;
      continue;
    }
    if (next === "]") {
      state.offset += 1;
      return;
    }
    throw new ScanFailure("malformed", state.offset);
  }
}

/**
 * Scans strict JSON text, reporting every duplicate object key by its
 * document path. Never evaluates, never resolves references, and allocates
 * only bounded intermediate strings.
 */
export function scanJsonStructure(text: string): JsonScanResult {
  const state: ScanState = { text, offset: 0, nodes: 0, duplicates: [] };
  try {
    scanValue(state, "", 0);
    skipWhitespace(state);
    if (state.offset !== text.length) {
      return Object.freeze({
        ok: false as const,
        reason: "trailing-content" as const,
        offset: state.offset,
      });
    }
  } catch (error) {
    if (error instanceof ScanFailure) {
      return Object.freeze({ ok: false as const, reason: error.reason, offset: error.offset });
    }
    return Object.freeze({ ok: false as const, reason: "malformed" as const, offset: 0 });
  }
  return Object.freeze({
    ok: true as const,
    duplicateKeyPaths: Object.freeze([...new Set(state.duplicates)].sort()),
  });
}
