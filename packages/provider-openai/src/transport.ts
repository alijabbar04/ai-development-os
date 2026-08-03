import { parseJsonText, type JsonValue } from "@ai-dev-os/domain";
import { ProviderError, type AbortSignalLike, type RateLimitInformation } from "@ai-dev-os/providers";
import {
  connectionFailedError,
  malformedResponseError,
  providerClosedError,
  redirectRejectedError,
  requestTimeoutError,
  summarizeUpstreamError,
  type UpstreamErrorSummary,
} from "./errors.js";
import { buildOpenAiUrl, type OpenAiEndpoint, type OpenAiRouteName, type RouteQuery } from "./endpoint.js";
import { systemOpenAiScheduler, type OpenAiScheduler } from "./scheduler.js";
import type { FetchLike } from "./ports.js";

/**
 * Narrow HTTPS transport over the finite Responses routes this adapter
 * uses. Every URL is derived from a validated endpoint plus a fixed route,
 * so caller-supplied paths, hosts, and headers are unrepresentable.
 *
 * - redirects are never followed: `redirect: "manual"` plus an explicit 3xx
 *   rejection before any body is read or a second request is issued;
 * - no ambient proxy configuration is consulted; the built-in fetch stack
 *   ignores proxy environment variables unless a dispatcher is installed,
 *   and this package installs none;
 * - the API key is passed per call and used only to build the Authorization
 *   header for that request; it is never stored, logged, or echoed;
 * - every body is read under a hard byte bound;
 * - error bodies are read bounded and reduced to their machine `type`,
 *   `code`, and `param` fields; the raw payload never escapes.
 */

/** Safe structural metadata captured from response headers. */
export interface OpenAiResponseMetadata {
  readonly requestId: string | null;
  readonly rateLimit: RateLimitInformation | null;
  readonly retryAfterMs: number | null;
  /** Processing tier the API reports it actually used. */
  readonly serviceTier: string | null;
}

export interface OpenAiJsonResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly value: JsonValue | null;
  readonly upstreamError: UpstreamErrorSummary;
  readonly metadata: OpenAiResponseMetadata;
}

export interface OpenAiStreamResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly upstreamError: UpstreamErrorSummary;
  readonly metadata: OpenAiResponseMetadata;
  /** Single-use raw byte stream; valid only when ok. */
  chunks(): AsyncIterable<Uint8Array>;
  /** Aborts the underlying response; idempotent and safe at any time. */
  abort(): void;
}

export interface OpenAiRequestOptions {
  /** Resolved immediately before the call and never retained. */
  readonly apiKey: string;
  readonly timeoutMs: number;
  /** Bound on time-to-response-headers, enforced with the injected clock. */
  readonly connectTimeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxErrorBodyBytes: number;
  readonly signal?: AbortSignalLike;
  /** Sent as `Idempotency-Key` when a retry must not duplicate remote work. */
  readonly idempotencyKey?: string;
}

export interface OpenAiTransport {
  requestJson(
    route: OpenAiRouteName,
    body: JsonValue | null,
    options: OpenAiRequestOptions & { readonly responseId?: string; readonly query?: RouteQuery },
  ): Promise<OpenAiJsonResponse>;
  requestStream(
    route: OpenAiRouteName,
    body: JsonValue | null,
    options: OpenAiRequestOptions & { readonly responseId?: string; readonly query?: RouteQuery },
  ): Promise<OpenAiStreamResponse>;
  /** Aborts in-flight work and rejects later requests. Idempotent. */
  close(): void;
}

export interface FetchOpenAiTransportOptions {
  readonly endpoint: OpenAiEndpoint;
  readonly organizationId?: string | null;
  readonly projectId?: string | null;
  readonly scheduler?: OpenAiScheduler;
  /** Injectable fetch for tests; defaults to the Node built-in. */
  readonly fetchImpl?: FetchLike;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SERVICE_TIER_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const RESET_DURATION_PATTERN = /^(?:(\d{1,6})h)?(?:(\d{1,6})m)?(?:(\d{1,9})(?:\.(\d{1,6}))?s)?$/;

function parseRetryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (!/^\d{1,6}$/.test(trimmed)) {
    return null;
  }
  const seconds = Number.parseInt(trimmed, 10);
  return seconds >= 0 && seconds <= 86_400 ? seconds * 1_000 : null;
}

/**
 * Parses the documented reset duration format ("1s", "6m0s", "1h2m3s").
 * Anything else yields null rather than a guessed number.
 */
export function parseResetDurationMs(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 32) {
    return null;
  }
  // A bare integer is tolerated and read as milliseconds-free seconds only
  // when suffixed; an unsuffixed value is ambiguous and therefore rejected.
  const match = RESET_DURATION_PATTERN.exec(trimmed);
  if (match === null || (match[1] === undefined && match[2] === undefined && match[3] === undefined)) {
    return null;
  }
  const hours = match[1] === undefined ? 0 : Number.parseInt(match[1], 10);
  const minutes = match[2] === undefined ? 0 : Number.parseInt(match[2], 10);
  const seconds = match[3] === undefined ? 0 : Number.parseInt(match[3], 10);
  const fraction = match[4] === undefined ? 0 : Number.parseFloat(`0.${match[4]}`);
  const total = ((hours * 60 + minutes) * 60 + seconds) * 1_000 + Math.round(fraction * 1_000);
  return Number.isSafeInteger(total) && total >= 0 && total <= 86_400_000 ? total : null;
}

function boundedCount(raw: string | null): number | null {
  if (raw === null || !/^\d{1,15}$/.test(raw.trim())) {
    return null;
  }
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Captures the documented rate-limit headers as safe structural metadata.
 * Request-scoped limits take precedence for the retry hint; token limits
 * are retained when request limits are absent.
 */
function readRateLimit(headers: Headers, now: Date): RateLimitInformation | null {
  const limit = boundedCount(headers.get("x-ratelimit-limit-requests"));
  const remaining = boundedCount(headers.get("x-ratelimit-remaining-requests"));
  const resetRequestsMs = parseResetDurationMs(headers.get("x-ratelimit-reset-requests"));
  const tokenLimit = boundedCount(headers.get("x-ratelimit-limit-tokens"));
  const tokenRemaining = boundedCount(headers.get("x-ratelimit-remaining-tokens"));
  const resetTokensMs = parseResetDurationMs(headers.get("x-ratelimit-reset-tokens"));

  const effectiveLimit = limit ?? tokenLimit;
  const effectiveRemaining = remaining ?? tokenRemaining;
  const effectiveResetMs =
    resetRequestsMs !== null && resetTokensMs !== null
      ? Math.max(resetRequestsMs, resetTokensMs)
      : (resetRequestsMs ?? resetTokensMs);

  if (effectiveLimit === null && effectiveRemaining === null && effectiveResetMs === null) {
    return null;
  }
  return Object.freeze({
    retryAfterMs: effectiveResetMs,
    limit: effectiveLimit,
    remaining: effectiveRemaining,
    resetsAt: effectiveResetMs === null ? null : new Date(now.valueOf() + effectiveResetMs).toISOString(),
  });
}

function readMetadata(headers: Headers, now: Date): OpenAiResponseMetadata {
  const requestIdRaw = headers.get("x-request-id");
  const serviceTierRaw = headers.get("openai-processing-tier");
  return Object.freeze({
    requestId: requestIdRaw !== null && REQUEST_ID_PATTERN.test(requestIdRaw) ? requestIdRaw : null,
    rateLimit: readRateLimit(headers, now),
    retryAfterMs: parseRetryAfterMs(headers),
    serviceTier:
      serviceTierRaw !== null && SERVICE_TIER_PATTERN.test(serviceTierRaw) ? serviceTierRaw : null,
  });
}

function causeCategoryOf(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } }).cause;
  const code = cause?.code;
  if (typeof code === "string" && /^[A-Z_0-9]{2,32}$/.test(code)) {
    return code.toLowerCase().replace(/_/g, "-");
  }
  return "connection-failed";
}

function isJsonContentType(headers: Headers): boolean {
  const contentType = headers.get("content-type");
  return contentType !== null && contentType.toLowerCase().startsWith("application/json");
}

function isEventStreamContentType(headers: Headers): boolean {
  const contentType = headers.get("content-type");
  return contentType !== null && contentType.toLowerCase().startsWith("text/event-stream");
}

export function createFetchOpenAiTransport(options: FetchOpenAiTransportOptions): OpenAiTransport {
  const scheduler = options.scheduler ?? systemOpenAiScheduler;
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const endpoint = options.endpoint;
  const activeControllers = new Set<AbortController>();
  let closed = false;

  interface StartedRequest {
    readonly response: Response;
    readonly controller: AbortController;
    readonly finish: () => void;
    readonly timedOut: () => boolean;
    readonly connectTimedOut: () => boolean;
  }

  function buildHeaders(
    apiKey: string,
    hasBody: boolean,
    accept: string,
    idempotencyKey: string | undefined,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      // The key is placed here and nowhere else. It is never copied into
      // configuration, errors, observations, or fingerprints.
      authorization: `Bearer ${apiKey}`,
      accept,
    };
    if (hasBody) {
      headers["content-type"] = "application/json";
    }
    if (options.organizationId !== undefined && options.organizationId !== null) {
      headers["openai-organization"] = options.organizationId;
    }
    if (options.projectId !== undefined && options.projectId !== null) {
      headers["openai-project"] = options.projectId;
    }
    if (idempotencyKey !== undefined) {
      headers["idempotency-key"] = idempotencyKey;
    }
    return headers;
  }

  async function start(
    route: OpenAiRouteName,
    body: JsonValue | null,
    requestOptions: OpenAiRequestOptions & { readonly responseId?: string; readonly query?: RouteQuery },
    accept: string,
  ): Promise<StartedRequest> {
    if (closed) {
      throw providerClosedError();
    }
    const url = buildOpenAiUrl(endpoint, route, {
      ...(requestOptions.responseId === undefined ? {} : { responseId: requestOptions.responseId }),
      ...(requestOptions.query === undefined ? {} : { query: requestOptions.query }),
    });
    const method = route === "createResponse" || route === "cancelResponse" ? "POST" : "GET";
    const hasBody = method === "POST" && body !== null;

    const controller = new AbortController();
    activeControllers.add(controller);
    let timedOut = false;
    let connectTimedOut = false;

    const totalDelay = scheduler.delay(requestOptions.timeoutMs);
    void totalDelay.promise.then(() => {
      timedOut = true;
      controller.abort();
    });
    const connectDelay = scheduler.delay(requestOptions.connectTimeoutMs);
    void connectDelay.promise.then(() => {
      connectTimedOut = true;
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
      totalDelay.cancel();
      connectDelay.cancel();
      activeControllers.delete(controller);
    };

    const init: RequestInit = {
      method,
      redirect: "manual",
      signal: controller.signal,
      headers: buildHeaders(requestOptions.apiKey, hasBody, accept, requestOptions.idempotencyKey),
    };
    if (hasBody) {
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      finish();
      if (connectTimedOut && !timedOut) {
        throw requestTimeoutError(requestOptions.connectTimeoutMs, "connect-timeout");
      }
      if (timedOut) {
        throw requestTimeoutError(requestOptions.timeoutMs);
      }
      if (controller.signal.aborted) {
        throw new ProviderError("CANCELLED", "The request was aborted by its caller.", {});
      }
      throw connectionFailedError(causeCategoryOf(error));
    }

    // Headers arrived: the connect bound no longer applies.
    connectDelay.cancel();

    if (response.status >= 300 && response.status < 400) {
      const status = response.status;
      controller.abort();
      finish();
      throw redirectRejectedError(status);
    }

    return {
      response,
      controller,
      finish,
      timedOut: () => timedOut,
      connectTimedOut: () => connectTimedOut,
    };
  }

  async function readBounded(started: StartedRequest, maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
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

  async function readErrorBody(started: StartedRequest, maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
    try {
      return await readBounded(started, maxBytes, timeoutMs);
    } catch {
      started.controller.abort();
      return new Uint8Array(0);
    }
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
    async requestJson(route, body, requestOptions): Promise<OpenAiJsonResponse> {
      const started = await start(route, body, requestOptions, "application/json");
      try {
        const ok = started.response.ok;
        const maxBytes = ok ? requestOptions.maxResponseBytes : requestOptions.maxErrorBodyBytes;
        if (ok && !isJsonContentType(started.response.headers)) {
          started.controller.abort();
          throw malformedResponseError("unexpected-content-type");
        }
        const bytes = ok
          ? await readBounded(started, maxBytes, requestOptions.timeoutMs)
          : await readErrorBody(started, maxBytes, requestOptions.timeoutMs);
        const value = parseBoundedBody(bytes);
        if (ok && value === null) {
          throw malformedResponseError("unparsable-json-body");
        }
        return Object.freeze({
          status: started.response.status,
          ok,
          value,
          upstreamError: ok ? summarizeUpstreamError(null) : summarizeUpstreamError(value),
          metadata: readMetadata(started.response.headers, scheduler.now()),
        });
      } finally {
        started.finish();
      }
    },

    async requestStream(route, body, requestOptions): Promise<OpenAiStreamResponse> {
      const started = await start(route, body, requestOptions, "text/event-stream");
      const { response } = started;
      const metadata = readMetadata(response.headers, scheduler.now());

      if (!response.ok) {
        try {
          const bytes = await readErrorBody(started, requestOptions.maxErrorBodyBytes, requestOptions.timeoutMs);
          return Object.freeze({
            status: response.status,
            ok: false,
            upstreamError: summarizeUpstreamError(parseBoundedBody(bytes)),
            metadata,
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

      if (!isEventStreamContentType(response.headers)) {
        started.controller.abort();
        started.finish();
        throw malformedResponseError("unexpected-content-type");
      }

      let consumed = false;
      let aborted = false;
      return Object.freeze({
        status: response.status,
        ok: true,
        upstreamError: summarizeUpstreamError(null),
        metadata,
        chunks(): AsyncIterable<Uint8Array> {
          if (consumed) {
            throw malformedResponseError("stream-single-use");
          }
          consumed = true;
          return (async function* streamChunks(): AsyncIterable<Uint8Array> {
            const streamBody = response.body;
            let streamedBytes = 0;
            try {
              if (streamBody === null) {
                return;
              }
              for await (const chunk of streamBody as unknown as AsyncIterable<Uint8Array>) {
                streamedBytes += chunk.byteLength;
                if (streamedBytes > requestOptions.maxResponseBytes) {
                  started.controller.abort();
                  throw malformedResponseError("oversized-stream-body", {
                    maximum: requestOptions.maxResponseBytes,
                  });
                }
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
          if (aborted) {
            return;
          }
          aborted = true;
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
