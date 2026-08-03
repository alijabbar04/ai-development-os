import { malformedResponseError } from "./errors.js";

/**
 * Bounded incremental Server-Sent Events parser.
 *
 * Handles the framing the Responses API actually uses, and every hostile
 * variation of it:
 *
 * - arbitrary byte splits, including UTF-8 sequences split across chunks
 *   (streaming decode with `fatal: true`, so invalid UTF-8 is an error and
 *   never a replacement character);
 * - LF and CRLF line endings, and a lone CR is NOT treated as a terminator
 *   so a `\r` inside data cannot forge an event boundary;
 * - multi-line `data:` fields joined with "\n" per the SSE grammar;
 * - `event:`, `id:`, and `retry:` fields, comments (`:` prefix), and
 *   unknown fields, which are ignored per the grammar;
 * - hard bounds on line length, event size, aggregate stream bytes, and
 *   event count.
 *
 * Offending raw text never appears in an error: failures carry a stable
 * detail code and numeric bounds only.
 */

export interface SseEvent {
  /** The `event:` field, or null when the stream omitted it. */
  readonly event: string | null;
  /** Concatenated `data:` lines joined by "\n". */
  readonly data: string;
  /** The `id:` field, or null. */
  readonly id: string | null;
}

export interface SseParserOptions {
  readonly maxLineBytes: number;
  readonly maxEventBytes: number;
  readonly maxStreamBytes: number;
  readonly maxEvents: number;
}

export interface SseParser {
  /** Consumes one transport chunk and returns every event it completed. */
  push(chunk: Uint8Array): readonly SseEvent[];
  /** Signals end of stream; returns a trailing unterminated event if present. */
  finish(): readonly SseEvent[];
  readonly eventCount: number;
  readonly totalBytes: number;
}

// A UTF-16 code unit is at most 3 UTF-8 bytes for non-surrogates, and a
// surrogate pair is 4 bytes for 2 units. Measuring exact UTF-8 length keeps
// the byte bounds honest for multi-byte content.
function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit <= 0x7f) {
      bytes += 1;
    } else if (unit <= 0x7ff) {
      bytes += 2;
    } else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      index + 1 < text.length &&
      text.charCodeAt(index + 1) >= 0xdc00 &&
      text.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function createSseParser(options: SseParserOptions): SseParser {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let pending = "";
  let eventCount = 0;
  let totalBytes = 0;
  let failed = false;

  // Accumulator for the event currently being assembled.
  let eventName: string | null = null;
  let eventId: string | null = null;
  let dataLines: string[] = [];
  let eventBytes = 0;
  let sawAnyField = false;

  function fail(detailCode: string, details: Record<string, number> = {}): never {
    failed = true;
    throw malformedResponseError(detailCode, details);
  }

  function resetEvent(): void {
    eventName = null;
    eventId = null;
    dataLines = [];
    eventBytes = 0;
    sawAnyField = false;
  }

  function completeEvent(): SseEvent | null {
    if (!sawAnyField) {
      // A blank line with nothing buffered is a heartbeat separator.
      resetEvent();
      return null;
    }
    eventCount += 1;
    if (eventCount > options.maxEvents) {
      fail("sse-event-limit", { maximum: options.maxEvents });
    }
    const event: SseEvent = Object.freeze({
      event: eventName,
      data: dataLines.join("\n"),
      id: eventId,
    });
    resetEvent();
    return event;
  }

  function chargeEventBytes(amount: number): void {
    eventBytes += amount;
    if (eventBytes > options.maxEventBytes) {
      fail("oversized-sse-event", { maximum: options.maxEventBytes });
    }
  }

  function handleLine(line: string): SseEvent | null {
    const lineBytes = utf8Length(line);
    if (lineBytes > options.maxLineBytes) {
      fail("oversized-sse-line", { maximum: options.maxLineBytes });
    }
    if (line.length === 0) {
      return completeEvent();
    }
    if (line.startsWith(":")) {
      // Comment line: ignored, but still charged against the event bound so
      // a comment flood cannot bypass the limits.
      chargeEventBytes(lineBytes);
      return null;
    }
    const colonIndex = line.indexOf(":");
    const field = colonIndex < 0 ? line : line.slice(0, colonIndex);
    let value = colonIndex < 0 ? "" : line.slice(colonIndex + 1);
    // Per the SSE grammar a single leading space after the colon is stripped.
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    chargeEventBytes(lineBytes);
    sawAnyField = true;
    switch (field) {
      case "event":
        eventName = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      case "id":
        eventId = value;
        break;
      case "retry":
        // Reconnection hint; this adapter drives its own backoff.
        break;
      default:
        // Unknown fields are ignored by the grammar.
        break;
    }
    return null;
  }

  function drain(): SseEvent[] {
    const events: SseEvent[] = [];
    for (;;) {
      const newlineIndex = pending.indexOf("\n");
      if (newlineIndex < 0) {
        // Guard the unterminated tail so a newline-free flood is bounded.
        if (utf8Length(pending) > options.maxLineBytes) {
          fail("oversized-sse-line", { maximum: options.maxLineBytes });
        }
        return events;
      }
      let line = pending.slice(0, newlineIndex);
      pending = pending.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      const event = handleLine(line);
      if (event !== null) {
        events.push(event);
      }
    }
  }

  return {
    push(chunk: Uint8Array): readonly SseEvent[] {
      if (failed) {
        fail("parser-already-failed");
      }
      totalBytes += chunk.byteLength;
      if (totalBytes > options.maxStreamBytes) {
        fail("oversized-sse-stream", { maximum: options.maxStreamBytes });
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

    finish(): readonly SseEvent[] {
      if (failed) {
        fail("parser-already-failed");
      }
      let text: string;
      try {
        // A truncated multi-byte sequence at end of stream is an error.
        text = decoder.decode();
      } catch {
        fail("invalid-utf8");
      }
      pending += text;
      const events = drain();
      const tail = pending;
      pending = "";
      if (tail.length > 0) {
        const event = handleLine(tail.endsWith("\r") ? tail.slice(0, -1) : tail);
        if (event !== null) {
          events.push(event);
        }
      }
      // A stream that ends mid-event yields that event rather than losing
      // it; the caller still requires a terminal semantic event, so an
      // incomplete tail cannot be mistaken for a successful completion.
      const trailing = completeEvent();
      if (trailing !== null) {
        events.push(trailing);
      }
      return Object.freeze(events);
    },

    get eventCount(): number {
      return eventCount;
    },
    get totalBytes(): number {
      return totalBytes;
    },
  };
}
