/**
 * Bounded process output.
 *
 * stdout and stderr are captured as separate byte streams with independent
 * caps and a combined cap. Buffering is always bounded: a process that writes
 * without end is stopped, not absorbed. Overflow is a terminal failure, never
 * a truncated success.
 */

import { createHash } from "node:crypto";
import { invalidRequest } from "./errors.js";

export const OUTPUT_STREAMS = Object.freeze(["stdout", "stderr"] as const);
export type OutputStreamName = (typeof OUTPUT_STREAMS)[number];

export const OUTPUT_TRUNCATION_KINDS = Object.freeze([
  "complete",
  "stream-limit",
  "combined-limit",
  "line-limit",
] as const);
export type OutputTruncationKind = (typeof OUTPUT_TRUNCATION_KINDS)[number];

export interface OutputLimits {
  readonly maxStreamBytes: number;
  readonly maxCombinedBytes: number;
  /** Longest single line retained when the consumer parses lines. */
  readonly maxLineBytes: number;
}

export const DEFAULT_OUTPUT_LIMITS: OutputLimits = Object.freeze({
  maxStreamBytes: 1_048_576,
  maxCombinedBytes: 2_097_152,
  maxLineBytes: 65_536,
});

export interface CapturedStream {
  readonly stream: OutputStreamName;
  readonly byteLength: number;
  readonly truncation: OutputTruncationKind;
  readonly digest: string;
  /** Retained bytes, never longer than the configured cap. */
  readonly bytes: Uint8Array;
}

export interface OutputCapture {
  readonly stdout: CapturedStream;
  readonly stderr: CapturedStream;
  readonly combinedByteLength: number;
}

/**
 * Literal redaction over a byte stream.
 *
 * Only exact byte sequences supplied by the caller are replaced. There is no
 * pattern-based secret detection here: guessing would produce both false
 * confidence and false positives. Matching spans chunk boundaries because the
 * collector redacts the assembled buffer, not individual chunks.
 */
const REDACTION_MARKER = Buffer.from("[REDACTED SECRET]", "utf8");

function redactBuffer(buffer: Buffer, secrets: readonly string[]): Buffer {
  let current = buffer;
  for (const secret of secrets) {
    if (secret.length === 0) {
      continue;
    }
    const needle = Buffer.from(secret, "utf8");
    if (needle.byteLength === 0) {
      continue;
    }
    const pieces: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const index = current.indexOf(needle, offset);
      if (index === -1) {
        pieces.push(current.subarray(offset));
        break;
      }
      pieces.push(current.subarray(offset, index), REDACTION_MARKER);
      offset = index + needle.byteLength;
    }
    if (pieces.length > 1) {
      current = Buffer.concat(pieces);
    }
  }
  return current;
}

export class OutputLimitExceeded extends Error {
  readonly stream: OutputStreamName | "combined";
  readonly limitBytes: number;

  constructor(stream: OutputStreamName | "combined", limitBytes: number) {
    super("The process exceeded its output quota.");
    this.name = "OutputLimitExceeded";
    this.stream = stream;
    this.limitBytes = limitBytes;
  }
}

export function parseOutputLimits(value: unknown, path = "outputLimits"): OutputLimits {
  if (typeof value !== "object" || value === null) {
    throw invalidRequest("Output limits must be an object.", { field: path });
  }
  const record = value as Record<string, unknown>;
  const read = (name: keyof OutputLimits, minimum: number, maximum: number): number => {
    const entry = record[name];
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < minimum || entry > maximum) {
      throw invalidRequest("An output limit is out of range.", { field: `${path}.${String(name)}` });
    }
    return entry;
  };
  const maxStreamBytes = read("maxStreamBytes", 1, 1_073_741_824);
  const maxCombinedBytes = read("maxCombinedBytes", 1, 2_147_483_647);
  const maxLineBytes = read("maxLineBytes", 1, 16_777_216);
  if (maxCombinedBytes < maxStreamBytes) {
    throw invalidRequest("The combined output limit must be at least the per-stream limit.", {
      field: path,
    });
  }
  return Object.freeze({ maxStreamBytes, maxCombinedBytes, maxLineBytes });
}

/**
 * Accumulates one process's output within its caps.
 *
 * `push` returns `false` once a limit is reached. The caller stops draining
 * and terminates the process tree; the collector holds only the bytes it was
 * allowed to keep.
 */
export class BoundedOutputCollector {
  readonly #limits: OutputLimits;
  readonly #secrets: readonly string[];
  readonly #chunks: Record<OutputStreamName, Buffer[]> = { stdout: [], stderr: [] };
  readonly #lengths: Record<OutputStreamName, number> = { stdout: 0, stderr: 0 };
  readonly #truncation: Record<OutputStreamName, OutputTruncationKind> = {
    stdout: "complete",
    stderr: "complete",
  };
  #combined = 0;
  #overflow: OutputLimitExceeded | null = null;

  constructor(limits: OutputLimits, secretValues: readonly string[] = []) {
    this.#limits = limits;
    this.#secrets = Object.freeze([...secretValues]);
  }

  get overflow(): OutputLimitExceeded | null {
    return this.#overflow;
  }

  get combinedByteLength(): number {
    return this.#combined;
  }

  /** Returns false when this chunk crossed a limit and capture must stop. */
  push(stream: OutputStreamName, chunk: Uint8Array): boolean {
    if (this.#overflow !== null) {
      return false;
    }
    const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const streamRoom = this.#limits.maxStreamBytes - this.#lengths[stream];
    const combinedRoom = this.#limits.maxCombinedBytes - this.#combined;
    const room = Math.min(streamRoom, combinedRoom);

    if (buffer.byteLength <= room) {
      this.#chunks[stream].push(Buffer.from(buffer));
      this.#lengths[stream] += buffer.byteLength;
      this.#combined += buffer.byteLength;
      return true;
    }

    if (room > 0) {
      const kept = Buffer.from(buffer.subarray(0, room));
      this.#chunks[stream].push(kept);
      this.#lengths[stream] += kept.byteLength;
      this.#combined += kept.byteLength;
    }
    const hitStream = this.#lengths[stream] >= this.#limits.maxStreamBytes;
    this.#truncation[stream] = hitStream ? "stream-limit" : "combined-limit";
    this.#overflow = new OutputLimitExceeded(
      hitStream ? stream : "combined",
      hitStream ? this.#limits.maxStreamBytes : this.#limits.maxCombinedBytes,
    );
    return false;
  }

  /**
   * Finalizes capture. Redaction runs here so a secret split across two
   * chunk boundaries is still removed.
   */
  finish(): OutputCapture {
    const build = (stream: OutputStreamName): CapturedStream => {
      const joined = redactBuffer(Buffer.concat(this.#chunks[stream]), this.#secrets);
      const bytes = new Uint8Array(joined);
      return Object.freeze({
        stream,
        byteLength: bytes.byteLength,
        truncation: this.#truncation[stream],
        digest: createHash("sha256").update(joined).digest("hex"),
        bytes,
      });
    };
    return Object.freeze({
      stdout: build("stdout"),
      stderr: build("stderr"),
      combinedByteLength: this.#combined,
    });
  }
}

/**
 * Decodes captured bytes as UTF-8. Terminal control sequences are stripped so
 * captured output can never move a host cursor, rewrite a log line, or set a
 * terminal title when a consumer prints it.
 */
export function decodeSafeText(stream: CapturedStream, maxChars = 1_000_000): string {
  const text = Buffer.from(stream.bytes).toString("utf8").slice(0, maxChars);
  return (
    text
      // Operating-system command strings carry a payload (a window title, a
      // hyperlink) that must go with the introducer, not be left behind.
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
      // Control-sequence introducer: parameters, intermediates, final byte.
      .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, "")
      // Any remaining two-character escape sequence.
      .replace(/\u001b[@-Z\\-_]/g, "")
      // Remaining C0 controls (tab, newline, and carriage return are kept),
      // DEL, and the C1 range.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
  );
}