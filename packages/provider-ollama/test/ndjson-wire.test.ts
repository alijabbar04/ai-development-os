import { describe, expect, it } from "vitest";
import { isProviderError } from "@ai-dev-os/providers";
import {
  createNdjsonParser,
  isOllamaErrorRecord,
  normalizeOllamaTimestamp,
  parseOllamaChatRecord,
  parseOllamaPsResponse,
  parseOllamaShowResponse,
  parseOllamaTagsResponse,
  parseOllamaVersionResponse,
} from "../src/index.js";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("bounded NDJSON parser", () => {
  it("parses one record split across many chunks", () => {
    const parser = createNdjsonParser();
    expect(parser.push(utf8('{"a"'))).toHaveLength(0);
    expect(parser.push(utf8(":1}"))).toHaveLength(0);
    const records = parser.push(utf8("\n"));
    expect(records).toEqual([{ a: 1 }]);
    expect(parser.finish()).toHaveLength(0);
  });

  it("parses many records in one chunk, with LF and CRLF endings", () => {
    const parser = createNdjsonParser();
    const records = parser.push(utf8('{"a":1}\r\n{"b":2}\n{"c":3}\n'));
    expect(records).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("handles multi-byte UTF-8 characters split across chunk boundaries", () => {
    const bytes = utf8('{"text":"héllo — 日本語"}\n');
    const parser = createNdjsonParser();
    const collected: unknown[] = [];
    for (let index = 0; index < bytes.length; index += 1) {
      collected.push(...parser.push(bytes.slice(index, index + 1)));
    }
    expect(collected).toEqual([{ text: "héllo — 日本語" }]);
  });

  it("ignores blank lines and empty chunks", () => {
    const parser = createNdjsonParser();
    expect(parser.push(new Uint8Array(0))).toHaveLength(0);
    expect(parser.push(utf8('\n\n  \n{"a":1}\n\n'))).toEqual([{ a: 1 }]);
  });

  it("accepts a well-formed final record without a trailing newline", () => {
    const parser = createNdjsonParser();
    parser.push(utf8('{"a":1}\n{"b":'));
    parser.push(utf8("2}"));
    expect(parser.finish()).toEqual([{ b: 2 }]);
  });

  it("rejects a truncated trailing record", () => {
    const parser = createNdjsonParser();
    parser.push(utf8('{"a":1}\n{"b":'));
    expect(() => parser.finish()).toThrowError(
      expect.objectContaining({ code: "MALFORMED_RESPONSE" }),
    );
  });

  it("rejects malformed JSON records without echoing their content", () => {
    const parser = createNdjsonParser();
    try {
      parser.push(utf8("SECRET-GARBAGE-LINE\n"));
      expect.unreachable();
    } catch (error) {
      expect(isProviderError(error, "MALFORMED_RESPONSE")).toBe(true);
      expect(JSON.stringify((error as Error & { toJSON(): unknown }).toJSON())).not.toContain(
        "SECRET-GARBAGE-LINE",
      );
    }
  });

  it("rejects oversized records, oversized streams, and excessive record counts", () => {
    const oversized = createNdjsonParser({ maxRecordText: 32 });
    expect(() => oversized.push(utf8(`{"x":"${"y".repeat(64)}"}\n`))).toThrowError(
      expect.objectContaining({ code: "MALFORMED_RESPONSE" }),
    );

    const boundedBytes = createNdjsonParser({ maxStreamBytes: 16 });
    expect(() => boundedBytes.push(utf8('{"aaaaaaaaaaaaaaaa":1}\n'))).toThrowError(
      expect.objectContaining({ code: "MALFORMED_RESPONSE" }),
    );

    const boundedRecords = createNdjsonParser({ maxRecords: 2 });
    boundedRecords.push(utf8('{"a":1}\n{"b":2}\n'));
    expect(() => boundedRecords.push(utf8('{"c":3}\n'))).toThrowError(
      expect.objectContaining({ code: "MALFORMED_RESPONSE" }),
    );
  });

  it("rejects invalid UTF-8 and refuses further input after failure", () => {
    const parser = createNdjsonParser();
    expect(() => parser.push(new Uint8Array([0xff, 0xfe, 0x7b]))).toThrowError(
      expect.objectContaining({ code: "MALFORMED_RESPONSE" }),
    );
    expect(() => parser.push(utf8('{"a":1}\n'))).toThrow();
    expect(() => parser.finish()).toThrow();
  });

  it("rejects prototype-pollution records", () => {
    const parser = createNdjsonParser();
    expect(() => parser.push(utf8('{"__proto__":{"polluted":true}}\n'))).toThrowError(
      expect.objectContaining({ code: "MALFORMED_RESPONSE" }),
    );
  });
});

describe("wire validation", () => {
  it("normalizes Ollama RFC3339 timestamps and rejects hostile ones", () => {
    expect(normalizeOllamaTimestamp("2026-08-01T14:56:49.277302595-07:00")).toBe(
      "2026-08-01T21:56:49.277Z",
    );
    expect(normalizeOllamaTimestamp("2026-08-01T00:00:00Z")).toBe("2026-08-01T00:00:00.000Z");
    expect(normalizeOllamaTimestamp("not a date")).toBeNull();
    expect(normalizeOllamaTimestamp("1899-01-01T00:00:00Z")).toBeNull();
    expect(normalizeOllamaTimestamp(42)).toBeNull();
    expect(normalizeOllamaTimestamp("x".repeat(100))).toBeNull();
  });

  it("parses tags deterministically regardless of response order", () => {
    const modelA = {
      name: "a-model",
      digest: "a".repeat(64),
      size: 10,
      modified_at: "2026-08-01T00:00:00Z",
      details: { format: "gguf", family: "llama", families: ["llama"], parameter_size: "3B", quantization_level: "Q4" },
    };
    const modelB = { ...modelA, name: "b-model", digest: "b".repeat(64) };
    const first = parseOllamaTagsResponse({ models: [modelA, modelB] } as never);
    const second = parseOllamaTagsResponse({ models: [modelB, modelA] } as never);
    expect(first.models.map((model) => model.name)).toEqual(["a-model", "b-model"]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("nulls malformed digests, sizes, and timestamps instead of retaining them", () => {
    const parsed = parseOllamaTagsResponse({
      models: [
        {
          name: "m",
          digest: "zz-not-hex",
          size: -5,
          modified_at: "garbage",
          details: { families: ["ok-family", "BAD FAMILY", 42] },
        },
      ],
    } as never);
    expect(parsed.models[0]).toMatchObject({
      digest: null,
      sizeBytes: null,
      modifiedAt: null,
    });
    expect(parsed.models[0]!.details.families).toEqual(["ok-family"]);
  });

  it("skips entries with hostile names and counts them", () => {
    const parsed = parseOllamaTagsResponse({
      models: [
        { name: "ok-model", digest: "a".repeat(64), size: 1 },
        { name: "bad name with spaces", digest: "a".repeat(64) },
        { name: 42 },
        "not-an-object",
      ],
    } as never);
    expect(parsed.models).toHaveLength(1);
    expect(parsed.skippedInvalidEntries).toBe(3);
  });

  it("rejects missing model arrays and excessive model counts", () => {
    expect(() => parseOllamaTagsResponse({} as never)).toThrowError(
      expect.objectContaining({ code: "MALFORMED_RESPONSE" }),
    );
    const excessive = { models: Array.from({ length: 1_100 }, (_, index) => ({ name: `m${index}` })) };
    expect(() => parseOllamaTagsResponse(excessive as never)).toThrowError(
      expect.objectContaining({ code: "MALFORMED_RESPONSE" }),
    );
  });

  it("extracts show capabilities and architecture context length only", () => {
    const parsed = parseOllamaShowResponse({
      capabilities: ["completion", "tools", "completion", "BAD CAP"],
      model_info: {
        "llama.context_length": 131_072,
        "llama.embedding_length": 4_096,
      },
      template: "NEVER-RETAINED",
      license: "NEVER-RETAINED",
      details: { family: "llama" },
    } as never);
    expect(parsed.capabilities).toEqual(["completion", "tools"]);
    expect(parsed.contextLength).toBe(131_072);
    expect(JSON.stringify(parsed)).not.toContain("NEVER-RETAINED");
  });

  it("rejects excessive capability arrays and handles hostile model_info", () => {
    expect(() =>
      parseOllamaShowResponse({ capabilities: Array.from({ length: 64 }, () => "x") } as never),
    ).toThrow();
    expect(
      parseOllamaShowResponse({
        capabilities: [],
        model_info: { "llama.context_length": -1 },
      } as never).contextLength,
    ).toBeNull();
    expect(
      parseOllamaShowResponse({
        capabilities: [],
        model_info: { "llama.context_length": 1.5 },
      } as never).contextLength,
    ).toBeNull();
  });

  it("parses running models with bounded telemetry fields", () => {
    const parsed = parseOllamaPsResponse({
      models: [
        {
          name: "m",
          digest: `sha256:${"C".repeat(64)}`,
          size: 100,
          size_vram: 90,
          expires_at: "2026-08-02T13:00:00Z",
          context_length: 8_192,
        },
      ],
    } as never);
    expect(parsed.models[0]).toMatchObject({
      name: "m",
      digest: "c".repeat(64),
      sizeBytes: 100,
      sizeVramBytes: 90,
      contextLength: 8_192,
    });
  });

  it("validates versions and error envelopes", () => {
    expect(parseOllamaVersionResponse({ version: "0.12.3" } as never).version).toBe("0.12.3");
    expect(() => parseOllamaVersionResponse({ version: "  " } as never)).toThrow();
    expect(() => parseOllamaVersionResponse({} as never)).toThrow();
    expect(isOllamaErrorRecord({ error: "boom" } as never)).toBe(true);
    expect(isOllamaErrorRecord({ message: "boom" } as never)).toBe(false);
    expect(isOllamaErrorRecord("boom" as never)).toBe(false);
  });

  it("validates chat records strictly", () => {
    const record = parseOllamaChatRecord({
      model: "m",
      message: { role: "assistant", content: "hi", thinking: "hmm" },
      done: false,
    } as never);
    expect(record).toMatchObject({ model: "m", content: "hi", thinking: "hmm", done: false });

    const done = parseOllamaChatRecord({
      model: "m",
      message: { role: "assistant", content: "" },
      done: true,
      done_reason: "stop",
      total_duration: 5,
      prompt_eval_count: 3,
      eval_count: 4,
    } as never);
    expect(done.done).toBe(true);
    expect(done.counters).toMatchObject({ promptEvalCount: 3, evalCount: 4, loadDurationNs: null });

    expect(() => parseOllamaChatRecord({ model: "m" } as never)).toThrow();
    expect(() => parseOllamaChatRecord({ model: "bad name", done: false } as never)).toThrow();
    expect(() =>
      parseOllamaChatRecord({ model: "m", message: { role: "user", content: "x" }, done: false } as never),
    ).toThrow();
    expect(() =>
      parseOllamaChatRecord({ model: "m", message: { content: 42 }, done: false } as never),
    ).toThrow();
  });

  it("nulls negative and unsafe counters instead of trusting them", () => {
    const done = parseOllamaChatRecord({
      model: "m",
      done: true,
      total_duration: -100,
      prompt_eval_count: 1.5,
      eval_count: Number.MAX_SAFE_INTEGER + 2,
    } as never);
    expect(done.counters).toMatchObject({
      totalDurationNs: null,
      promptEvalCount: null,
      evalCount: null,
    });
  });

  it("validates hostile nested tool arguments and tool names", () => {
    expect(() =>
      parseOllamaChatRecord({
        model: "m",
        done: false,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "BAD NAME", arguments: {} } }],
        },
      } as never),
    ).toThrow();
    expect(() =>
      parseOllamaChatRecord({
        model: "m",
        done: false,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "ok-tool", arguments: "not-an-object" } }],
        },
      } as never),
    ).toThrow();
    expect(() =>
      parseOllamaChatRecord({
        model: "m",
        done: false,
        message: {
          role: "assistant",
          content: "",
          tool_calls: Array.from({ length: 100 }, () => ({ function: { name: "t", arguments: {} } })),
        },
      } as never),
    ).toThrow();
  });
});
