import { parseJsonText, type JsonValue } from "@ai-dev-os/domain";
import { ProviderError } from "@ai-dev-os/providers";
import type { AbortSignalLike } from "@ai-dev-os/providers";
import {
  connectionFailedError,
  malformedResponseError,
  providerClosedError,
  redirectRejectedError,
  requestTimeoutError,
} from "./errors.js";
import type { OllamaEndpoint } from "./endpoint.js";
import { systemOllamaScheduler, type OllamaScheduler } from "./scheduler.js";

/**
 * Narrow, injectable transport boundary over the finite set of native
 * Ollama endpoints Stage 7 uses. Every request URL derives from the
 * validated loopback base URL and this table — caller-supplied paths are
 * unrepresentable. Model-management endpoints (pull, delete, copy, create,
 * push) are deliberately absent.
 */
export const OLLAMA_ENDPOINTS = Object.freeze({
  tags: Object.freeze({ method: "GET", path: "/api/tags" }),
  show: Object.freeze({ method: "POST", path: "/api/show" }),
  ps: Object.freeze({ method: "GET", path: "/api/ps" }),
  chat: Object.freeze({ method: "POST", path: "/api/chat" }),
  generate: Object.freeze({ method: "POST", path: "/api/generate" }),
  version: Object.freeze({ method: "GET", path: "/api/version" }),
} as const);

export type OllamaEndpointName = keyof typeof OLLAMA_ENDPOINTS;

/** Maximum bytes read from a non-streaming JSON response body. */
export const MAX_JSON_RESPONSE_BYTES = 8 * 1_024 * 1_024;
/** Maximum bytes read from a non-success response body (classification only). */
export const MAX_ERROR_BODY_BYTES = 16 * 1_024;

export interface OllamaTransportRequestOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignalLike;
}

export interface OllamaJsonResponse {
  readonly status: number;
  /** Parsed bounded JSON body; null when absent or unparsable. */
  readonly value: JsonValue | null;
  readonly retryAfterMs: number | null;
}

export interface OllamaStreamResponse {
  readonly status: number;
  readonly ok: boolean;
  /** Bounded parsed error body for non-success statuses; null otherwise. */
  readonly errorValue: JsonValue | null;
  readonly retryAfterMs: number | null;
  /** Single-use raw byte stream; valid only when ok. */
  chunks(): AsyncIterable<Uint8Array>;
  /** Aborts the underlying response; safe to call at any time. */
  abort(): void;
}

export interface OllamaTransport {
  requestJson(
    endpoint: OllamaEndpointName,
    body: JsonValue | null,
    options: OllamaTransportRequestOptions,
  ): Promise<OllamaJsonResponse>;
  requestStream(
    endpoint: OllamaEndpointName,
    body: JsonValue | null,
    options: OllamaTransportRequestOptions,
  ): Promise<OllamaStreamResponse>;
  /** Aborts in-flight work and rejects all later requests. Idempotent. */
  close(): void;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface FetchOllamaTransportOptions {
  readonly endpoint: OllamaEndpoint;
  readonly scheduler?: OllamaScheduler;
  /** Injectable fetch for tests; defaults to the Node 22+ built-in. */
  readonly fetchImpl?: FetchLike;
}

function parseRetryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (raw === null || !/^[0-9]{1,6}$/.test(raw.trim())) {
    return null;
  }
  const seconds = Number.parseInt(raw.trim(), 10);
  return seconds >= 0 && seconds <= 86_400 ? seconds * 1_000 : null;
}

function isAcceptedContentType(headers: Headers): boolean {
  const contentType = headers.get("content-type");
  if (contentType === null) {
    return false;
  }
  const lowered = contentType.toLowerCase();
  return lowered.startsWith("application/json") || lowered.startsWith("application/x-ndjson");
}

function causeCategoryOf(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } }).cause;
  const code = cause?.code;
  if (typeof code === "string" && /^[A-Z_0-9]{2,32}$/.test(code)) {
    return code.toLowerCase().replace(/_/g, "-");
  }
  return "connection-failed";
}

/**
 * Production transport over the built-in fetch stack.
 *
 * - redirects are never followed: `redirect: "manual"` plus an explicit
 *   3xx rejection before any body is consumed or a second request is made;
 * - no ambient proxy configuration is consulted (the built-in undici fetch
 *   ignores proxy environment variables unless a dispatcher is installed);
 * - every request carries an absolute timeout driven by the injected
 *   scheduler and an AbortController, and honors an optional caller signal;
 * - non-streaming bodies are read with hard byte bounds;
 * - error bodies are read bounded and parsed defensively for
 *   classification only — they are never included in errors verbatim.
 */
export function createFetchOllamaTransport(options: FetchOllamaTransportOptions): OllamaTransport {
  const scheduler = options.scheduler ?? systemOllamaScheduler;
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const baseUrl = options.endpoint.baseUrl;
  const activeControllers = new Set<AbortController>();
  let closed = false;

  interface StartedRequest {
    readonly response: Response;
    readonly controller: AbortController;
    readonly finish: () => void;
    readonly timedOut: () => boolean;
  }

  async function start(
    endpoint: OllamaEndpointName,
    body: JsonValue | null,
    requestOptions: OllamaTransportRequestOptions,
  ): Promise<StartedRequest> {
    if (closed) {
      throw providerClosedError();
    }
    const route = OLLAMA_ENDPOINTS[endpoint];
    const controller = new AbortController();
    activeControllers.add(controller);
    let timedOut = false;
    const delay = scheduler.delay(requestOptions.timeoutMs);
    void delay.promise.then(() => {
      timedOut = true;
      controller.abort();
    });
    if (requestOptions.signal !== undefined) {
      if (requestOptions.signal.aborted) {
        controller.abort();
      } else {
        requestOptions.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
    }
    const finish = (): void => {
      delay.cancel();
      activeControllers.delete(controller);
    };

    const init: RequestInit = {
      method: route.method,
      redirect: "manual",
      signal: controller.signal,
      headers:
        route.method === "POST"
          ? { "content-type": "application/json", accept: "application/json, application/x-ndjson" }
          : { accept: "application/json, application/x-ndjson" },
    };
    if (route.method === "POST") {
      init.body = JSON.stringify(body ?? {});
    }

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${route.path}`, init);
    } catch (error) {
      finish();
      if (timedOut) {
        throw requestTimeoutError(requestOptions.timeoutMs);
      }
      if (controller.signal.aborted) {
        throw new ProviderError("CANCELLED", "The request was aborted by its caller.", {});
      }
      throw connectionFailedError(causeCategoryOf(error));
    }

    if (response.status >= 300 && response.status < 400) {
      const status = response.status;
      controller.abort();
      finish();
      throw redirectRejectedError(status);
    }

    return { response, controller, finish, timedOut: () => timedOut };
  }

  async function readBounded(
    started: StartedRequest,
    maxBytes: number,
    timeoutMs: number,
  ): Promise<Uint8Array> {
    const body = started.response.body;
    if (body === null) {
      return new Uint8Array(0);
    }
    const pieces: Uint8Array[] = [];
    let total = 0;
    try {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          started.controller.abort();
          throw malformedResponseError("oversized-response-body", { maximum: maxBytes });
        }
        pieces.push(chunk);
      }
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      if (started.timedOut()) {
        throw requestTimeoutError(timeoutMs);
      }
      if (started.controller.signal.aborted) {
        throw new ProviderError("CANCELLED", "The request was aborted by its caller.", {});
      }
      throw connectionFailedError("response-read-failed");
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const piece of pieces) {
      combined.set(piece, offset);
      offset += piece.byteLength;
    }
    return combined;
  }

  function parseBoundedBody(bytes: Uint8Array): JsonValue | null {
    if (bytes.byteLength === 0) {
      return null;
    }
    try {
      return parseJsonText(new TextDecoder("utf-8", { fatal: true }).decode(bytes), "response");
    } catch {
      return null;
    }
  }

  return {
    async requestJson(endpoint, body, requestOptions): Promise<OllamaJsonResponse> {
      const started = await start(endpoint, body, requestOptions);
      try {
        const maxBytes = started.response.ok ? MAX_JSON_RESPONSE_BYTES : MAX_ERROR_BODY_BYTES;
        if (started.response.ok && !isAcceptedContentType(started.response.headers)) {
          started.controller.abort();
          throw malformedResponseError("unexpected-content-type");
        }
        const bytes = await readBounded(started, maxBytes, requestOptions.timeoutMs);
        const value = parseBoundedBody(bytes);
        if (started.response.ok && value === null) {
          throw malformedResponseError("unparsable-json-body");
        }
        return Object.freeze({
          status: started.response.status,
          value,
          retryAfterMs: parseRetryAfterMs(started.response.headers),
        });
      } finally {
        started.finish();
      }
    },

    async requestStream(endpoint, body, requestOptions): Promise<OllamaStreamResponse> {
      const started = await start(endpoint, body, requestOptions);
      const { response } = started;

      if (!response.ok) {
        try {
          const bytes = await readBounded(started, MAX_ERROR_BODY_BYTES, requestOptions.timeoutMs);
          const errorValue = parseBoundedBody(bytes);
          return Object.freeze({
            status: response.status,
            ok: false,
            errorValue,
            retryAfterMs: parseRetryAfterMs(response.headers),
            chunks(): AsyncIterable<Uint8Array> {
              throw malformedResponseError("stream-unavailable");
            },
            abort(): void {
              started.controller.abort();
            },
          });
        } finally {
          started.finish();
        }
      }

      if (!isAcceptedContentType(response.headers)) {
        started.controller.abort();
        started.finish();
        throw malformedResponseError("unexpected-content-type");
      }

      let consumed = false;
      return Object.freeze({
        status: response.status,
        ok: true,
        errorValue: null,
        retryAfterMs: parseRetryAfterMs(response.headers),
        chunks(): AsyncIterable<Uint8Array> {
          if (consumed) {
            throw malformedResponseError("stream-single-use");
          }
          consumed = true;
          return (async function* streamChunks(): AsyncIterable<Uint8Array> {
            const streamBody = response.body;
            try {
              if (streamBody === null) {
                return;
              }
              for await (const chunk of streamBody as unknown as AsyncIterable<Uint8Array>) {
                yield chunk;
              }
            } catch (error) {
              if (error instanceof ProviderError) {
                throw error;
              }
              if (started.timedOut()) {
                throw requestTimeoutError(requestOptions.timeoutMs);
              }
              if (started.controller.signal.aborted) {
                throw new ProviderError("CANCELLED", "The stream was aborted by its caller.", {});
              }
              throw connectionFailedError("stream-disconnected");
            } finally {
              started.finish();
            }
          })();
        },
        abort(): void {
          started.controller.abort();
          started.finish();
        },
      });
    },

    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      for (const controller of [...activeControllers]) {
        controller.abort();
      }
      activeControllers.clear();
    },
  };
}
