import { codexProtocolViolation } from "./errors.js";

export interface CodexJsonlDecoderOptions {
  readonly maxRecordBytes: number;
  readonly maxRecords: number;
  readonly maxStreamBytes: number;
}
export class CodexJsonlDecoder {
  readonly #options: CodexJsonlDecoderOptions;
  #buffer = Buffer.alloc(0);
  #records = 0;
  #bytes = 0;

  constructor(options: CodexJsonlDecoderOptions) { this.#options = options; }
  get recordCount(): number { return this.#records; }
  get byteCount(): number { return this.#bytes; }

  push(chunk: Uint8Array): readonly string[] {
    this.#bytes += chunk.byteLength;
    if (this.#bytes > this.#options.maxStreamBytes) throw codexProtocolViolation("stream-oversized", { maxBytes: this.#options.maxStreamBytes });
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const lines: string[] = [];
    for (;;) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline === -1) break;
      let record = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (record.at(-1) === 0x0d) record = record.subarray(0, -1);
      lines.push(this.#decodeRecord(record));
    }
    if (this.#buffer.byteLength > this.#options.maxRecordBytes) throw codexProtocolViolation("record-oversized", { maxBytes: this.#options.maxRecordBytes });
    return Object.freeze(lines);
  }

  finish(): readonly string[] {
    if (this.#buffer.byteLength === 0) return Object.freeze([]);
    const record = this.#buffer;
    this.#buffer = Buffer.alloc(0);
    return Object.freeze([this.#decodeRecord(record)]);
  }

  #decodeRecord(record: Buffer): string {
    if (record.byteLength === 0) throw codexProtocolViolation("malformed-json");
    if (record.byteLength > this.#options.maxRecordBytes) throw codexProtocolViolation("record-oversized", { maxBytes: this.#options.maxRecordBytes });
    this.#records += 1;
    if (this.#records > this.#options.maxRecords) throw codexProtocolViolation("record-count-exceeded", { maxRecords: this.#options.maxRecords });
    try { return new TextDecoder("utf-8", { fatal: true }).decode(record); }
    catch { throw codexProtocolViolation("invalid-utf8"); }
  }
}
