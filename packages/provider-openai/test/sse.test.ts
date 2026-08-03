import { describe, expect, it } from "vitest";
import { isProviderError, type ProviderError } from "@ai-dev-os/providers";
import { createSseParser, type SseEvent, type SseParserOptions } from "../src/index.js";

const LIMITS: SseParserOptions = {
  maxLineBytes: 1_024,
  maxEventBytes: 4_096,
  maxStreamBytes: 65_536,
  maxEvents: 100,
};

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function parseAll(text: string, chunkSize: number, options: SseParserOptions = LIMITS): readonly SseEvent[] {
  const parser = createSseParser(options);
  const bytes = encode(text);
  const events: SseEvent[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    events.push(...parser.push(bytes.slice(offset, offset + chunkSize)));
  }
  events.push(...parser.finish());
  return events;
}

function detailCode(error: unknown): unknown {
  return (error as ProviderError).details["detailCode"];
}

describe("SSE parser framing", () => {
  it("parses a simple event regardless of chunk boundaries", () => {
    const text = "event: response.created\ndata: {\"a\":1}\n\n";
    for (const chunkSize of [1, 2, 3, 5, 13, 1_000]) {
      const events = parseAll(text, chunkSize);
      expect(events, `chunk ${chunkSize}`).toHaveLength(1);
      expect(events[0]!.event).toBe("response.created");
      expect(events[0]!.data).toBe('{"a":1}');
    }
  });

  it("joins multi-line data fields with newlines per the grammar", () => {
    const events = parseAll("data: line one\ndata: line two\n\n", 4);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe("line one\nline two");
  });

  it("accepts CRLF and does not treat a lone CR as a terminator", () => {
    const events = parseAll("data: a\r\ndata: b\r\n\r\n", 3);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe("a\nb");

    // A bare CR inside the value stays part of the value.
    const withCr = parseAll("data: a\rb\n\n", 2);
    expect(withCr).toHaveLength(1);
    expect(withCr[0]!.data).toBe("a\rb");
  });

  it("strips exactly one leading space after the colon", () => {
    const events = parseAll("data:  two spaces\n\n", 5);
    expect(events[0]!.data).toBe(" two spaces");
  });

  it("ignores comments, unknown fields, and retry hints", () => {
    const events = parseAll(
      ": keep-alive\nfoo: bar\nretry: 500\nid: 7\nevent: x\ndata: payload\n\n",
      6,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("x");
    expect(events[0]!.id).toBe("7");
    expect(events[0]!.data).toBe("payload");
  });

  it("treats a blank separator with nothing buffered as a heartbeat", () => {
    const events = parseAll("\n\n\ndata: real\n\n", 1);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe("real");
  });

  it("emits a trailing unterminated event at end of stream", () => {
    const events = parseAll("data: tail-without-blank-line\n", 4);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe("tail-without-blank-line");
  });

  it("reassembles UTF-8 sequences split across chunk boundaries", () => {
    // Four-byte emoji plus a two-byte character, split one byte at a time.
    const events = parseAll("data: 🌍é\n\n", 1);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe("🌍é");
  });

  it("rejects invalid UTF-8 rather than substituting replacement characters", () => {
    const parser = createSseParser(LIMITS);
    // 0xFF is never valid in UTF-8.
    expect(() => parser.push(new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0xff]))).toThrow();
    try {
      parser.push(new Uint8Array([0x61]));
    } catch (error) {
      expect(isProviderError(error, "MALFORMED_RESPONSE")).toBe(true);
    }
  });

  it("rejects a truncated multi-byte sequence at end of stream", () => {
    const parser = createSseParser(LIMITS);
    // Leading byte of a three-byte sequence with nothing following.
    parser.push(new Uint8Array([0xe2]));
    expect(() => parser.finish()).toThrow();
  });
});

describe("SSE parser bounds", () => {
  it("rejects an oversized line", () => {
    const parser = createSseParser({ ...LIMITS, maxLineBytes: 32 });
    expect(() => parser.push(encode(`data: ${"x".repeat(200)}\n\n`))).toThrow();
    try {
      createSseParser({ ...LIMITS, maxLineBytes: 32 }).push(encode(`data: ${"x".repeat(200)}\n\n`));
    } catch (error) {
      expect(detailCode(error)).toBe("oversized-sse-line");
    }
  });

  it("rejects an unterminated line that exceeds the line bound", () => {
    const parser = createSseParser({ ...LIMITS, maxLineBytes: 16 });
    try {
      parser.push(encode("data: ".concat("y".repeat(100))));
      expect.unreachable("expected the newline-free flood to be bounded");
    } catch (error) {
      expect(detailCode(error)).toBe("oversized-sse-line");
    }
  });

  it("rejects an oversized single event assembled from many lines", () => {
    const parser = createSseParser({ ...LIMITS, maxLineBytes: 64, maxEventBytes: 128 });
    try {
      for (let index = 0; index < 20; index += 1) {
        parser.push(encode(`data: ${"z".repeat(50)}\n`));
      }
      expect.unreachable("expected the aggregate event bound to trip");
    } catch (error) {
      expect(detailCode(error)).toBe("oversized-sse-event");
    }
  });

  it("charges comment floods against the event bound", () => {
    const parser = createSseParser({ ...LIMITS, maxLineBytes: 64, maxEventBytes: 128 });
    try {
      for (let index = 0; index < 20; index += 1) {
        parser.push(encode(`: ${"c".repeat(50)}\n`));
      }
      expect.unreachable("expected comments to be bounded too");
    } catch (error) {
      expect(detailCode(error)).toBe("oversized-sse-event");
    }
  });

  it("rejects an oversized aggregate stream", () => {
    const parser = createSseParser({ ...LIMITS, maxStreamBytes: 64 });
    try {
      parser.push(encode("data: ".concat("q".repeat(200), "\n\n")));
      expect.unreachable("expected the stream bound to trip");
    } catch (error) {
      expect(detailCode(error)).toBe("oversized-sse-stream");
    }
  });

  it("rejects too many events", () => {
    const parser = createSseParser({ ...LIMITS, maxEvents: 3 });
    try {
      for (let index = 0; index < 10; index += 1) {
        parser.push(encode(`data: ${index}\n\n`));
      }
      expect.unreachable("expected the event-count bound to trip");
    } catch (error) {
      expect(detailCode(error)).toBe("sse-event-limit");
    }
  });

  it("refuses further work after a failure", () => {
    const parser = createSseParser({ ...LIMITS, maxEvents: 1 });
    parser.push(encode("data: a\n\n"));
    expect(() => parser.push(encode("data: b\n\n"))).toThrow();
    try {
      parser.push(encode("data: c\n\n"));
    } catch (error) {
      expect(detailCode(error)).toBe("parser-already-failed");
    }
  });

  it("never includes the offending text in an error", () => {
    const canary = "SUPER-SECRET-CANARY";
    const parser = createSseParser({ ...LIMITS, maxLineBytes: 16 });
    try {
      parser.push(encode(`data: ${canary}${"x".repeat(100)}\n\n`));
      expect.unreachable("expected a bound violation");
    } catch (error) {
      expect(JSON.stringify((error as ProviderError).toJSON())).not.toContain(canary);
      expect((error as ProviderError).message).not.toContain(canary);
    }
  });

  it("tracks byte and event counters", () => {
    const parser = createSseParser(LIMITS);
    parser.push(encode("data: one\n\n"));
    parser.push(encode("data: two\n\n"));
    expect(parser.eventCount).toBe(2);
    expect(parser.totalBytes).toBe(22);
  });
});
