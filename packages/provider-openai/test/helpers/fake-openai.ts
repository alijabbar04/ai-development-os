import type { FetchLike } from "../../src/index.js";

/**
 * Deterministic in-process fake for the OpenAI HTTPS endpoint.
 *
 * The adapter only accepts the exact first-party HTTPS base URL, so tests
 * inject a fake `fetch` rather than standing up a server. That keeps every
 * scenario hermetic (no TLS, no ports, no sockets) while still exercising
 * the real transport: URL construction, headers, redirect handling, byte
 * bounds, content-type checks, chunk boundaries, and abort propagation.
 */

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyText: string | null;
  readonly body: unknown;
}

/** One piece of a scripted SSE stream. */
export type StreamPiece =
  | string
  | { readonly holdUntilRelease: true }
  /** Ends the body without a terminal event, simulating a disconnect. */
  | { readonly truncate: true }
  /** Fails the body mid-stream with a transport error. */
  | { readonly error: string };

export interface ScriptedResponse {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** JSON body; serialized and served as application/json. */
  readonly json?: unknown;
  /** Raw body text, served with `contentType`. */
  readonly bodyText?: string;
  readonly contentType?: string;
  /** SSE pieces, served as text/event-stream. */
  readonly stream?: readonly StreamPiece[];
  /** Re-split the whole stream into fixed-size BYTE chunks. */
  readonly byteChunkSize?: number;
  /** Throw a transport error instead of responding. */
  readonly networkError?: string;
}

export interface FakeOpenAi {
  readonly fetchImpl: FetchLike;
  readonly requests: readonly RecordedRequest[];
  /** Releases every stream waiting on `holdUntilRelease`. */
  release(): void;
  /** Queues responses for a route, consumed in order. */
  script(route: RouteKey, ...responses: readonly ScriptedResponse[]): void;
  /** Number of responses still queued for a route. */
  pending(route: RouteKey): number;
}

export type RouteKey = "create" | "get" | "cancel";

function routeOf(url: string, method: string): RouteKey {
  if (url.endsWith("/cancel")) {
    return "cancel";
  }
  if (method === "POST") {
    return "create";
  }
  return "get";
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Resolves once the signal aborts; never resolves when there is none. */
function abortSignalPromise(signal: AbortSignal | null | undefined): Promise<void> {
  if (signal === null || signal === undefined) {
    return new Promise<void>(() => undefined);
  }
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function concatBytes(pieces: readonly Uint8Array[]): Uint8Array {
  const total = pieces.reduce((sum, piece) => sum + piece.byteLength, 0);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const piece of pieces) {
    combined.set(piece, offset);
    offset += piece.byteLength;
  }
  return combined;
}

export function createFakeOpenAi(): FakeOpenAi {
  const queues = new Map<RouteKey, ScriptedResponse[]>();
  const requests: RecordedRequest[] = [];
  let releaseWaiters: Array<() => void> = [];
  let released = false;

  function waitForRelease(): Promise<void> {
    if (released) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      releaseWaiters.push(resolve);
    });
  }

  function buildStream(
    script: ScriptedResponse,
    signal: AbortSignal | null | undefined,
  ): ReadableStream<Uint8Array> {
    const pieces = script.stream ?? [];
    let index = 0;
    // Pre-split into byte chunks when the scenario asks for a specific
    // chunking, so UTF-8 sequences can be split across chunk boundaries.
    let byteQueue: Uint8Array[] | null = null;
    if (script.byteChunkSize !== undefined) {
      const text = pieces
        .filter((piece): piece is string => typeof piece === "string")
        .join("");
      const all = encode(text);
      byteQueue = [];
      for (let offset = 0; offset < all.byteLength; offset += script.byteChunkSize) {
        byteQueue.push(all.slice(offset, offset + script.byteChunkSize));
      }
    }

    return new ReadableStream<Uint8Array>({
      async pull(controller): Promise<void> {
        if (signal?.aborted === true) {
          controller.error(new Error("aborted"));
          return;
        }
        if (byteQueue !== null) {
          const next = byteQueue.shift();
          if (next === undefined) {
            controller.close();
            return;
          }
          controller.enqueue(next);
          return;
        }
        if (index >= pieces.length) {
          controller.close();
          return;
        }
        const piece = pieces[index]!;
        index += 1;
        if (typeof piece === "string") {
          controller.enqueue(encode(piece));
          return;
        }
        if ("holdUntilRelease" in piece) {
          // A held stream must still respond to abort, exactly as a real
          // HTTP body does, so cancellation and close never hang.
          await Promise.race([waitForRelease(), abortSignalPromise(signal)]);
          if (signal?.aborted === true) {
            controller.error(new Error("aborted"));
            return;
          }
          return;
        }
        if ("truncate" in piece) {
          controller.close();
          return;
        }
        const failure = new Error("stream failure");
        (failure as { cause?: unknown }).cause = { code: piece.error };
        controller.error(failure);
      },
    });
  }

  const fetchImpl: FetchLike = async (input, init) => {
    const method = init.method ?? "GET";
    const headerRecord: Record<string, string> = {};
    const rawHeaders = init.headers;
    if (rawHeaders !== undefined) {
      for (const [key, value] of Object.entries(rawHeaders as Record<string, string>)) {
        headerRecord[key.toLowerCase()] = value;
      }
    }
    const bodyText = typeof init.body === "string" ? init.body : null;
    requests.push(
      Object.freeze({
        url: input,
        method,
        headers: Object.freeze(headerRecord),
        bodyText,
        body: bodyText === null ? null : (JSON.parse(bodyText) as unknown),
      }),
    );

    const route = routeOf(input, method);
    const queue = queues.get(route) ?? [];
    const script = queue.shift() ?? { status: 500, json: { error: { type: "server_error" } } };

    if (script.networkError !== undefined) {
      const failure = new Error("network failure");
      (failure as { cause?: unknown }).cause = { code: script.networkError };
      throw failure;
    }

    const signal = init.signal as AbortSignal | undefined;
    if (signal?.aborted === true) {
      const aborted = new Error("aborted");
      aborted.name = "AbortError";
      throw aborted;
    }

    const status = script.status ?? 200;
    const headers = new Headers(script.headers as Record<string, string> | undefined);

    if (script.stream !== undefined) {
      if (!headers.has("content-type")) {
        headers.set("content-type", script.contentType ?? "text/event-stream");
      }
      // A 3xx or error status is delivered without a stream body.
      if (status >= 300) {
        return new Response(script.bodyText ?? "", { status, headers });
      }
      return new Response(buildStream(script, signal), { status, headers });
    }

    if (script.json !== undefined) {
      if (!headers.has("content-type")) {
        headers.set("content-type", script.contentType ?? "application/json");
      }
      return new Response(JSON.stringify(script.json), { status, headers });
    }

    if (script.bodyText !== undefined) {
      if (!headers.has("content-type")) {
        headers.set("content-type", script.contentType ?? "application/json");
      }
      return new Response(script.bodyText, { status, headers });
    }

    return new Response(null, { status, headers });
  };

  return {
    fetchImpl,
    get requests(): readonly RecordedRequest[] {
      return requests;
    },
    release(): void {
      released = true;
      const waiters = releaseWaiters;
      releaseWaiters = [];
      for (const wake of waiters) {
        wake();
      }
    },
    script(route: RouteKey, ...responses: readonly ScriptedResponse[]): void {
      const queue = queues.get(route) ?? [];
      queue.push(...responses);
      queues.set(route, queue);
    },
    pending(route: RouteKey): number {
      return (queues.get(route) ?? []).length;
    },
  };
}

// ---------------------------------------------------------------------------
// SSE scripting helpers
// ---------------------------------------------------------------------------

let sequenceCounter = 0;

export function resetSequence(): void {
  sequenceCounter = 0;
}

/** Frames one semantic event exactly as the API does. */
export function sse(type: string, payload: Record<string, unknown>, sequence?: number): string {
  sequenceCounter += 1;
  const body = { type, sequence_number: sequence ?? sequenceCounter, ...payload };
  return `event: ${type}\ndata: ${JSON.stringify(body)}\n\n`;
}

export interface ResponseObjectOptions {
  readonly id?: string;
  readonly status?: string;
  readonly model?: string;
  readonly output?: readonly unknown[];
  readonly usage?: unknown;
  readonly background?: boolean;
  readonly incompleteReason?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

export function responseObject(options: ResponseObjectOptions = {}): Record<string, unknown> {
  const value: Record<string, unknown> = {
    id: options.id ?? "resp_test123",
    object: "response",
    status: options.status ?? "completed",
    model: options.model ?? "test-model",
    output: options.output ?? [],
  };
  if (options.usage !== undefined) {
    value["usage"] = options.usage;
  }
  if (options.background !== undefined) {
    value["background"] = options.background;
  }
  if (options.incompleteReason !== undefined) {
    value["incomplete_details"] = { reason: options.incompleteReason };
  }
  if (options.error !== undefined) {
    value["error"] = options.error;
  }
  return value;
}

export function usageObject(input: {
  readonly inputTokens?: number;
  readonly cachedTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
} = {}): Record<string, unknown> {
  const inputTokens = input.inputTokens ?? 100;
  const outputTokens = input.outputTokens ?? 50;
  return {
    input_tokens: inputTokens,
    input_tokens_details: {
      cached_tokens: input.cachedTokens ?? 0,
      cache_write_tokens: input.cacheWriteTokens ?? 0,
    },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: input.reasoningTokens ?? 0 },
    total_tokens: input.totalTokens ?? inputTokens + outputTokens,
  };
}

export function messageItem(text: string, id = "msg_1"): Record<string, unknown> {
  return {
    id,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }],
  };
}

export function refusalItem(refusal: string, id = "msg_1"): Record<string, unknown> {
  return {
    id,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "refusal", refusal }],
  };
}

export function functionCallItem(
  name: string,
  argumentsText: string,
  callId = "call_1",
  id = "fc_1",
): Record<string, unknown> {
  return { id, type: "function_call", call_id: callId, name, arguments: argumentsText, status: "completed" };
}

/** A complete, well-formed streaming script producing plain text. */
export function textStreamScript(
  pieces: readonly string[],
  options: { readonly usage?: unknown; readonly model?: string } = {},
): readonly string[] {
  resetSequence();
  const text = pieces.join("");
  const frames: string[] = [
    sse("response.created", { response: responseObject({ status: "in_progress" }) }),
    sse("response.in_progress", { response: responseObject({ status: "in_progress" }) }),
    sse("response.output_item.added", {
      output_index: 0,
      item: { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] },
    }),
  ];
  for (const piece of pieces) {
    frames.push(
      sse("response.output_text.delta", {
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        delta: piece,
        logprobs: [],
      }),
    );
  }
  frames.push(
    sse("response.output_text.done", {
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      text,
      logprobs: [],
    }),
    sse("response.output_item.done", { output_index: 0, item: messageItem(text) }),
    sse("response.completed", {
      response: responseObject({
        status: "completed",
        output: [messageItem(text)],
        usage: options.usage ?? usageObject(),
        ...(options.model === undefined ? {} : { model: options.model }),
      }),
    }),
  );
  return frames;
}
