/**
 * Bounded incremental NDJSON decoding for Claude Code `stream-json` output.
 *
 * The parser is fed raw chunks as they arrive and never assumes a chunk is a
 * line, a line is a record, or a chunk boundary falls on a character boundary.
 * It handles arbitrary byte splits, split UTF-8 sequences, LF and CRLF, blank
 * lines, and a final record with no trailing newline.
 *
 * Every bound is enforced while decoding rather than after buffering: a single
 * oversized record, an oversized stream, or an excessive record count stops the
 * parser at the limit instead of absorbing the output first. Invalid UTF-8 is a
 * failure, not a replacement character, because a silently substituted byte
 * changes what the record says.
 */

import { StringDecoder } from "node:string_decoder";
import type { ClaudeDetailCode } from "./errors.js";

export interface NdjsonLimits {
  readonly maxRecordBytes: number;
  readonly maxStreamBytes: number;
  readonly maxRecordCount: number;
}

export type NdjsonOutcome =
  | { readonly ok: true; readonly lines: readonly string[] }
  | { readonly ok: false; readonly detailCode: ClaudeDetailCode };

export interface NdjsonDecoder {
  /** Decodes a chunk into zero or more complete lines. */
  push(chunk: Uint8Array): NdjsonOutcome;
  /** Flushes a final record that arrived without a trailing newline. */
  finish(): NdjsonOutcome;
  readonly recordCount: number;
  readonly byteCount: number;
}

const EMPTY: NdjsonOutcome = Object.freeze({ ok: true, lines: Object.freeze([]) });

function failure(detailCode: ClaudeDetailCode): NdjsonOutcome {
  return Object.freeze({ ok: false, detailCode });
}

/**
 * Detects whether a decoded string contains a Unicode replacement character
 * that the input did not literally contain. `StringDecoder` substitutes U+FFFD
 * for malformed sequences, so the presence of one that the raw bytes do not
 * account for means the stream was not valid UTF-8.
 */
function containsSubstitutedReplacement(decoded: string, source: Uint8Array): boolean {
  if (!decoded.includes("�")) {
    return false;
  }
  // U+FFFD encodes as EF BF BD. If every replacement character in the decoded
  // text is backed by that byte sequence, the input really did contain them.
  let literal = 0;
  for (let index = 0; index + 2 < source.length; index += 1) {
    if (source[index] === 0xef && source[index + 1] === 0xbf && source[index + 2] === 0xbd) {
      literal += 1;
    }
  }
  let decodedCount = 0;
  for (const character of decoded) {
    if (character === "�") {
      decodedCount += 1;
    }
  }
  return decodedCount > literal;
}

export function createNdjsonDecoder(limits: NdjsonLimits): NdjsonDecoder {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let records = 0;
  let bytes = 0;
  let broken = false;

  function takeLines(text: string, includeTail: boolean): NdjsonOutcome {
    pending += text;
    const lines: string[] = [];
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline === -1) {
        break;
      }
      const raw = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line.length === 0) {
        // Blank separator lines are documented and carry no record.
        continue;
      }
      if (Buffer.byteLength(line, "utf8") > limits.maxRecordBytes) {
        broken = true;
        return failure("record-oversized");
      }
      records += 1;
      if (records > limits.maxRecordCount) {
        broken = true;
        return failure("record-count-exceeded");
      }
      lines.push(line);
    }
    if (Buffer.byteLength(pending, "utf8") > limits.maxRecordBytes) {
      broken = true;
      return failure("record-oversized");
    }
    if (includeTail && pending.length > 0) {
      const tail = pending.endsWith("\r") ? pending.slice(0, -1) : pending;
      pending = "";
      if (tail.length > 0) {
        records += 1;
        if (records > limits.maxRecordCount) {
          broken = true;
          return failure("record-count-exceeded");
        }
        lines.push(tail);
      }
    }
    return lines.length === 0 ? EMPTY : Object.freeze({ ok: true, lines: Object.freeze(lines) });
  }

  return {
    push(chunk: Uint8Array): NdjsonOutcome {
      if (broken) {
        return failure("stream-oversized");
      }
      bytes += chunk.byteLength;
      if (bytes > limits.maxStreamBytes) {
        broken = true;
        return failure("stream-oversized");
      }
      const text = decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      if (containsSubstitutedReplacement(text, chunk)) {
        broken = true;
        return failure("invalid-utf8");
      }
      return takeLines(text, false);
    },
    finish(): NdjsonOutcome {
      if (broken) {
        return EMPTY;
      }
      const tail = decoder.end();
      if (tail.includes("�")) {
        broken = true;
        return failure("invalid-utf8");
      }
      return takeLines(tail, true);
    },
    get recordCount(): number {
      return records;
    },
    get byteCount(): number {
      return bytes;
    },
  };
}
