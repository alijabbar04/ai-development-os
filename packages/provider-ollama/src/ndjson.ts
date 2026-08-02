import { parseJsonText, type JsonValue } from "@ai-dev-os/domain";
import { malformedResponseError } from "./errors.js";

/** Default per-record bound (approximate UTF-16 code units ~ bytes). */
export const DEFAULT_MAX_RECORD_TEXT = 262_144;
/** Default aggregate raw-byte bound for one streamed response. */
export const DEFAULT_MAX_STREAM_BYTES = 128 * 1_024 * 1_024;
/** Default bound on the number of records in one streamed response. */
export const DEFAULT_MAX_STREAM_RECORDS = 100_000;

export interface NdjsonParserOptions {
  readonly maxRecordText?: number;
  readonly maxStreamBytes?: number;
  readonly maxRecords?: number;
}

export interface NdjsonParser {
  /**
   * Consumes one transport chunk and returns every complete record it
   * finished. Records are parsed with prototype-pollution-safe JSON
   * parsing and returned as frozen canonical values.
   */
  push(chunk: Uint8Array): readonly JsonValue[];
  /**
   * Signals end of stream. A non-empty trailing partial line is a protocol
   * error (the documented protocol terminates every record with a newline;
   * a missing final newline after a COMPLETE record is tolerated because
   * push() only returns records it could fully parse — finish() parses a
   * well-formed unterminated tail as the final record).
   */
  finish(): readonly JsonValue[];
  readonly recordCount: number;
  readonly totalBytes: number;
}

/**
 * Bounded incremental NDJSON parser for Ollama streaming responses.
 *
 * - one record split across many chunks and many records in one chunk;
 * - LF and CRLF line endings;
 * - UTF-8 characters split across chunk boundaries (streaming decode);
 * - blank lines between records are ignored;
 * - oversized records, oversized aggregate streams, excessive record
 *   counts, invalid UTF-8, and malformed JSON become structured errors
 *   that never include the offending text.
 */
export function createNdjsonParser(options: NdjsonParserOptions = {}): NdjsonParser {
  const maxRecordText = options.maxRecordText ?? DEFAULT_MAX_RECORD_TEXT;
  const maxStreamBytes = options.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES;
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_STREAM_RECORDS;

  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let pending = "";
  let recordCount = 0;
  let totalBytes = 0;
  let failed = false;

  function fail(detailCode: string, details: Record<string, number> = {}): never {
    failed = true;
    throw malformedResponseError(detailCode, details);
  }

  function parseLine(line: string): JsonValue {
    recordCount += 1;
    if (recordCount > maxRecords) {
      fail("stream-record-limit", { maximum: maxRecords });
    }
    try {
      return parseJsonText(line, "ndjson-record");
    } catch {
      fail("malformed-ndjson-record", { recordIndex: recordCount });
    }
  }

  function drain(): JsonValue[] {
    const records: JsonValue[] = [];
    for (;;) {
      const newlineIndex = pending.indexOf("\n");
      if (newlineIndex < 0) {
        if (pending.length > maxRecordText) {
          fail("oversized-ndjson-record", { maximum: maxRecordText });
        }
        return records;
      }
      let line = pending.slice(0, newlineIndex);
      pending = pending.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (line.length > maxRecordText) {
        fail("oversized-ndjson-record", { maximum: maxRecordText });
      }
      if (line.trim().length === 0) {
        continue;
      }
      records.push(parseLine(line));
    }
  }

  return {
    push(chunk: Uint8Array): readonly JsonValue[] {
      if (failed) {
        fail("parser-already-failed");
      }
      totalBytes += chunk.byteLength;
      if (totalBytes > maxStreamBytes) {
        fail("oversized-stream", { maximum: maxStreamBytes });
      }
      let text: string;
      try {
        text = decoder.decode(chunk, { stream: true });
      } catch {
        fail("invalid-utf8");
      }
      pending += text;
      return Object.freeze(drain());
    },
    finish(): readonly JsonValue[] {
      if (failed) {
        fail("parser-already-failed");
      }
      let text: string;
      try {
        text = decoder.decode();
      } catch {
        fail("invalid-utf8");
      }
      pending += text;
      const records = drain();
      const tail = pending;
      pending = "";
      if (tail.trim().length > 0) {
        if (tail.length > maxRecordText) {
          fail("oversized-ndjson-record", { maximum: maxRecordText });
        }
        records.push(parseLine(tail.trim()));
      }
      return Object.freeze(records);
    },
    get recordCount(): number {
      return recordCount;
    },
    get totalBytes(): number {
      return totalBytes;
    },
  };
}
