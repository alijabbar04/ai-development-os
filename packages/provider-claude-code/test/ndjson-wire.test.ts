/**
 * Bounded NDJSON decoding and stream-json record validation.
 *
 * These are pure unit tests over the two modules that read untrusted bytes.
 * They cover the byte-level cases a real stream produces (arbitrary splits,
 * split UTF-8, CRLF, a final record without a newline) and the hostile cases a
 * compromised or buggy CLI could produce.
 */

import { describe, expect, it } from "vitest";
import { createNdjsonDecoder, parseWireLine, type NdjsonLimits } from "../src/index.js";

const LIMITS: NdjsonLimits = Object.freeze({
  maxRecordBytes: 1_024,
  maxStreamBytes: 65_536,
  maxRecordCount: 100,
});

function bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

function collect(decoder: ReturnType<typeof createNdjsonDecoder>, chunks: readonly Uint8Array[]): {
  readonly lines: string[];
  readonly failure: string | null;
} {
  const lines: string[] = [];
  for (const chunk of chunks) {
    const outcome = decoder.push(chunk);
    if (!outcome.ok) {
      return { lines, failure: outcome.detailCode };
    }
    lines.push(...outcome.lines);
  }
  const tail = decoder.finish();
  if (!tail.ok) {
    return { lines, failure: tail.detailCode };
  }
  lines.push(...tail.lines);
  return { lines, failure: null };
}

describe("bounded NDJSON decoding", () => {
  it("reassembles records split at every byte boundary", () => {
    const source = '{"a":1}\n{"b":2}\n{"c":3}\n';
    for (let split = 1; split < source.length; split += 1) {
      const decoder = createNdjsonDecoder(LIMITS);
      const outcome = collect(decoder, [
        bytes(source.slice(0, split)),
        bytes(source.slice(split)),
      ]);
      expect(outcome.failure).toBeNull();
      expect(outcome.lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    }
  });

  it("reassembles a multi-byte character split across chunks", () => {
    const raw = Buffer.from('{"t":"日本語 🚀"}\n', "utf8");
    for (let split = 1; split < raw.byteLength; split += 1) {
      const decoder = createNdjsonDecoder(LIMITS);
      const outcome = collect(decoder, [
        new Uint8Array(raw.subarray(0, split)),
        new Uint8Array(raw.subarray(split)),
      ]);
      expect(outcome.failure).toBeNull();
      expect(outcome.lines).toEqual(['{"t":"日本語 🚀"}']);
    }
  });

  it("accepts CRLF terminators and blank separator lines", () => {
    const decoder = createNdjsonDecoder(LIMITS);
    const outcome = collect(decoder, [bytes('{"a":1}\r\n\r\n{"b":2}\r\n')]);
    expect(outcome.failure).toBeNull();
    expect(outcome.lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("emits a final record that arrived without a trailing newline", () => {
    const decoder = createNdjsonDecoder(LIMITS);
    const outcome = collect(decoder, [bytes('{"a":1}\n{"b":2}')]);
    expect(outcome.failure).toBeNull();
    expect(outcome.lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("rejects invalid UTF-8 rather than substituting a replacement character", () => {
    const decoder = createNdjsonDecoder(LIMITS);
    const outcome = collect(decoder, [new Uint8Array([0x7b, 0xff, 0xfe, 0x7d, 0x0a])]);
    expect(outcome.failure).toBe("invalid-utf8");
  });

  it("preserves a replacement character the stream genuinely contained", () => {
    const decoder = createNdjsonDecoder(LIMITS);
    const outcome = collect(decoder, [bytes('{"t":"\uFFFD"}\n')]);
    expect(outcome.failure).toBeNull();
    expect(outcome.lines).toEqual(['{"t":"\uFFFD"}']);
  });

  it("stops at an oversized record instead of buffering it", () => {
    const decoder = createNdjsonDecoder(LIMITS);
    const outcome = collect(decoder, [bytes(`${"x".repeat(2_048)}\n`)]);
    expect(outcome.failure).toBe("record-oversized");
  });

  it("stops at an oversized pending record before a newline arrives", () => {
    const decoder = createNdjsonDecoder(LIMITS);
    const outcome = decoder.push(bytes("y".repeat(2_048)));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.detailCode).toBe("record-oversized");
  });

  it("stops at an oversized stream", () => {
    const decoder = createNdjsonDecoder({ ...LIMITS, maxStreamBytes: 64 });
    const outcome = collect(decoder, [bytes(`${'{"a":1}'}\n`.repeat(20))]);
    expect(outcome.failure).toBe("stream-oversized");
  });

  it("stops at an excessive record count", () => {
    const decoder = createNdjsonDecoder({ ...LIMITS, maxRecordCount: 3 });
    const outcome = collect(decoder, [bytes('{"a":1}\n'.repeat(10))]);
    expect(outcome.failure).toBe("record-count-exceeded");
  });

  it("stays broken after a failure rather than resuming mid-stream", () => {
    const decoder = createNdjsonDecoder({ ...LIMITS, maxStreamBytes: 32 });
    expect(decoder.push(bytes("z".repeat(64))).ok).toBe(false);
    expect(decoder.push(bytes('{"a":1}\n')).ok).toBe(false);
    expect(decoder.finish().ok).toBe(true);
  });

  it("counts records and bytes for observability", () => {
    const decoder = createNdjsonDecoder(LIMITS);
    collect(decoder, [bytes('{"a":1}\n{"b":2}\n')]);
    expect(decoder.recordCount).toBe(2);
    expect(decoder.byteCount).toBe(16);
  });
});

describe("stream-json record validation", () => {
  const ok = (line: string): readonly unknown[] => {
    const outcome = parseWireLine(line);
    if (!outcome.ok) {
      throw new Error(`expected success, got ${outcome.detailCode}`);
    }
    return outcome.records;
  };
  const detail = (line: string): string | null => {
    const outcome = parseWireLine(line);
    return outcome.ok ? null : outcome.detailCode;
  };

  it("parses a session-init record", () => {
    const records = ok(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "abc-123",
        model: "claude-fable-5",
        permissionMode: "dontAsk",
        tools: ["Read"],
        mcp_servers: [],
        plugins: [],
      }),
    );
    expect(records).toEqual([
      {
        type: "init",
        sessionId: "abc-123",
        model: "claude-fable-5",
        permissionMode: "dontAsk",
        tools: ["Read"],
        mcpServerNames: [],
        pluginNames: [],
        apiKeySource: null,
      },
    ]);
  });

  it("parses the documented api_retry event", () => {
    const records = ok(
      JSON.stringify({
        type: "system",
        subtype: "api_retry",
        attempt: 2,
        max_retries: 5,
        retry_delay_ms: 1_500,
        error_status: 429,
        error: "rate_limit",
      }),
    );
    expect(records[0]).toMatchObject({ type: "retry", attempt: 2, retryDelayMs: 1_500, errorCategory: "rate_limit" });
  });

  it("acknowledges thinking blocks without carrying their text", () => {
    const records = ok(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: "secret internal reasoning" }] },
      }),
    );
    expect(records).toEqual([{ type: "assistant-thinking" }]);
    expect(JSON.stringify(records)).not.toContain("secret internal reasoning");
  });

  it("extracts a workspace-relative tool path and only the argument key names", () => {
    const records = ok(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Edit",
              input: { file_path: "src/main.ts", old_string: "SENSITIVE", new_string: "ALSO SENSITIVE" },
            },
          ],
        },
      }),
    );
    expect(records[0]).toMatchObject({
      type: "tool-use",
      toolUseId: "toolu_1",
      toolName: "Edit",
      targetPath: "src/main.ts",
      argumentKeys: ["file_path", "new_string", "old_string"],
    });
    expect(JSON.stringify(records)).not.toContain("SENSITIVE");
  });

  it("refuses to locate an absolute or traversing tool path", () => {
    for (const candidate of ["/etc/passwd", "C:/Windows/system32", "../../escape.txt", "a/../../b"]) {
      const records = ok(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "toolu_2", name: "Write", input: { file_path: candidate } }],
          },
        }),
      );
      expect(records[0]).toMatchObject({ targetPath: null });
    }
  });

  it("parses a terminal result with usage, per-model usage, cost, and denials", () => {
    const records = ok(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 3,
        duration_ms: 2_000,
        total_cost_usd: 0.25,
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
        },
        modelUsage: {
          "claude-fable-5": {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadInputTokens: 40,
            cacheCreationInputTokens: 30,
            costUSD: 0.25,
            contextWindow: 200_000,
          },
        },
        permission_denials: [{ tool_name: "Bash", tool_use_id: "toolu_9", tool_input: { command: "rm -rf /" } }],
        session_id: "abc-123",
      }),
    );
    expect(records[0]).toMatchObject({
      type: "result",
      subtype: "success",
      isError: false,
      numTurns: 3,
      totalCostMicros: 250_000,
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationInputTokens: 30,
        cacheReadInputTokens: 40,
      },
    });
    expect(JSON.stringify(records)).not.toContain("rm -rf");
  });

  it.each([
    ["malformed JSON", "{not json", "malformed-json"],
    ["a primitive root", "42", "non-object-record"],
    ["an array root", "[1,2,3]", "non-object-record"],
    ["a missing type", '{"subtype":"init"}', "non-object-record"],
  ])("rejects %s", (_label, line, expected) => {
    expect(detail(line)).toBe(expected);
  });

  it("rejects prototype-pollution keys at any depth", () => {
    expect(detail('{"type":"result","subtype":"success","__proto__":{"polluted":true}}')).toBe(
      "prototype-pollution",
    );
    expect(
      detail('{"type":"result","subtype":"success","usage":{"nested":{"constructor":{"x":1}}}}'),
    ).toBe("prototype-pollution");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it.each([
    ["a negative token count", { input_tokens: -1 }],
    ["a fractional token count", { input_tokens: 1.5 }],
    ["an unsafe integer", { input_tokens: 9_007_199_254_740_993 }],
  ])("rejects %s in usage", (_label, usage) => {
    expect(
      detail(JSON.stringify({ type: "result", subtype: "success", usage })),
    ).toBe("unsafe-number");
  });

  it("rejects a negative reported cost", () => {
    expect(detail('{"type":"result","subtype":"success","total_cost_usd":-1}')).toBe("unsafe-number");
  });

  it("rejects a result that contradicts itself", () => {
    expect(detail('{"type":"result","subtype":"success","is_error":true}')).toBe("result-contradiction");
    expect(detail('{"type":"result","subtype":""}')).toBe("result-contradiction");
  });

  it("classifies a non-success subtype as an error even without is_error", () => {
    const records = ok('{"type":"result","subtype":"error_max_turns"}');
    expect(records[0]).toMatchObject({ subtype: "error_max_turns", isError: true });
  });

  it("fails closed on an unknown top-level record type", () => {
    expect(detail('{"type":"tool_permission_request","tool":"Bash"}')).toBe(
      "unknown-state-changing-record",
    );
  });

  it("fails closed on an unrecognized assistant content block", () => {
    expect(
      detail(JSON.stringify({ type: "assistant", message: { content: [{ type: "future_tool_form" }] } })),
    ).toBe("unknown-state-changing-record");
  });

  it("fails closed when an ambient hook or plugin event appears", () => {
    for (const subtype of ["hook_started", "hook_response", "plugin_install"]) {
      expect(detail(JSON.stringify({ type: "system", subtype }))).toBe("unknown-state-changing-record");
    }
  });

  it("treats an unknown informational system subtype as a bounded warning", () => {
    const records = ok('{"type":"system","subtype":"weather_report"}');
    expect(records[0]).toEqual({ type: "unknown-compatible", subtype: "weather_report" });
  });

  it("ignores partial-message and compaction envelopes", () => {
    expect(ok('{"type":"stream_event","event":{"delta":{"text":"x"}}}')).toEqual([{ type: "partial" }]);
    expect(ok('{"type":"compact_boundary"}')).toEqual([{ type: "compact-boundary" }]);
  });

  it("parses tool results from the user envelope", () => {
    const records = ok(
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true }] },
      }),
    );
    expect(records[0]).toEqual({ type: "tool-result", toolUseId: "toolu_1", isError: true });
  });

  it("rejects an init record whose session id is unusable", () => {
    expect(detail('{"type":"system","subtype":"init"}')).toBe("session-id-mismatch");
    expect(detail('{"type":"system","subtype":"init","session_id":""}')).toBe("session-id-mismatch");
  });
});
