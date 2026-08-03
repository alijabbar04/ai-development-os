import { ProviderError, createRetryDisposition } from "@ai-dev-os/providers";
import type { ProviderErrorDetails, RateLimitInformation } from "@ai-dev-os/providers";

/**
 * Stable error construction for the OpenAI Responses adapter.
 *
 * Every failure surfaces as an existing @ai-dev-os/providers ProviderError
 * code with a conservative retry disposition. Messages and details are
 * fixed structural summaries: API keys, prompts, generated text, reasoning,
 * tool arguments, raw response bodies, request headers, and URLs never
 * appear here. Upstream error envelopes are read bounded, classified by
 * their `type`/`code` fields only, and then discarded.
 */

export function invalidConfigurationError(detailCode: string): ProviderError {
  return new ProviderError(
    "INVALID_REQUEST",
    "The OpenAI adapter configuration is invalid.",
    { detailCode },
    { retry: createRetryDisposition({ strategy: "never" }), causeCategory: "invalid-configuration" },
  );
}

export function unsafeEndpointError(detailCode: string): ProviderError {
  return new ProviderError(
    "INVALID_REQUEST",
    "The OpenAI endpoint is not an accepted first-party HTTPS URL.",
    { detailCode },
    { retry: createRetryDisposition({ strategy: "never" }), causeCategory: "unsafe-endpoint" },
  );
}

/** Redirects are rejected before any second request can be issued. */
export function redirectRejectedError(status: number): ProviderError {
  return new ProviderError(
    "PROTOCOL_VIOLATION",
    "The OpenAI endpoint attempted an HTTP redirect, which is rejected.",
    { httpStatus: status },
    { retry: createRetryDisposition({ strategy: "never" }), causeCategory: "redirect-rejected" },
  );
}

export function connectionFailedError(causeCategory: string): ProviderError {
  return new ProviderError("NETWORK_FAILURE", "The OpenAI API could not be reached.", {}, { causeCategory });
}

export function requestTimeoutError(timeoutMs: number, detailCode = "request-timeout"): ProviderError {
  return new ProviderError(
    "TIMEOUT",
    "The OpenAI request exceeded its configured timeout.",
    { timeoutMs, detailCode },
    { causeCategory: detailCode },
  );
}

export function malformedResponseError(
  detailCode: string,
  details: ProviderErrorDetails = {},
): ProviderError {
  return new ProviderError(
    "MALFORMED_RESPONSE",
    "The OpenAI API returned a response that failed validation.",
    { detailCode, ...details },
    { causeCategory: detailCode },
  );
}

export function protocolViolationError(
  detailCode: string,
  details: ProviderErrorDetails = {},
): ProviderError {
  return new ProviderError(
    "PROTOCOL_VIOLATION",
    "The OpenAI stream violated the expected protocol.",
    { detailCode, ...details },
    { retry: createRetryDisposition({ strategy: "never" }), causeCategory: detailCode },
  );
}

export function providerClosedError(): ProviderError {
  return new ProviderError("PROVIDER_CLOSED", "The OpenAI provider is closed.", {});
}

export function policyDeniedError(detailCode: string, details: ProviderErrorDetails = {}): ProviderError {
  return new ProviderError(
    "POLICY_DENIED",
    "Provider policy does not permit this request.",
    { detailCode, ...details },
    { retry: createRetryDisposition({ strategy: "human-action" }), causeCategory: detailCode },
  );
}

export function unsupportedCapabilityError(
  detailCode: string,
  details: ProviderErrorDetails = {},
): ProviderError {
  return new ProviderError(
    "UNSUPPORTED_CAPABILITY",
    "The request needs a capability this provider does not support.",
    { detailCode, ...details },
    { retry: createRetryDisposition({ strategy: "alternate-provider" }) },
  );
}

export function toolProtocolError(detailCode: string, details: ProviderErrorDetails = {}): ProviderError {
  return new ProviderError(
    "TOOL_PROTOCOL_FAILURE",
    "The model produced a tool call that failed validation.",
    { detailCode, ...details },
    { retry: createRetryDisposition({ strategy: "never" }), causeCategory: detailCode },
  );
}

/**
 * Reported when a remote operation may still be running after a local
 * failure (background create whose acknowledgement was lost, cancellation
 * that could not be confirmed, or a disconnect during a stored response).
 */
export function operationMayStillRunError(
  code: "TIMEOUT" | "NETWORK_FAILURE" | "CANCELLED",
  detailCode: string,
  details: ProviderErrorDetails = {},
): ProviderError {
  return new ProviderError(
    code,
    "The OpenAI operation failed locally and may still be running remotely.",
    { detailCode, ...details },
    {
      retry: createRetryDisposition({
        strategy: code === "CANCELLED" ? "never" : "same-after-delay",
        minimumDelayMs: code === "CANCELLED" ? null : 1_000,
        requestReusable: code !== "CANCELLED",
        operationMayStillBeRunning: true,
        idempotencyRequired: code !== "CANCELLED",
      }),
      causeCategory: detailCode,
    },
  );
}

/**
 * Documented API error `type` values that indicate the request itself is
 * malformed. Classification uses only these stable machine codes; the
 * upstream `message` string is never propagated.
 */
const INVALID_REQUEST_TYPES = new Set([
  "invalid_request_error",
  "invalid_value",
  "invalid_type",
]);

export interface UpstreamErrorSummary {
  /** Stable machine `type` from the error envelope, when present. */
  readonly type: string | null;
  /** Stable machine `code` from the error envelope, when present. */
  readonly code: string | null;
  /** Offending parameter name, when present. Never a value. */
  readonly param: string | null;
}

export const EMPTY_UPSTREAM_ERROR: UpstreamErrorSummary = Object.freeze({
  type: null,
  code: null,
  param: null,
});

const SAFE_CODE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const SAFE_PARAM_PATTERN = /^[A-Za-z][A-Za-z0-9_.[\]-]{0,63}$/;

/**
 * Extracts only the stable machine fields from an untrusted error envelope.
 * Anything unrecognized, oversized, or non-conforming becomes null so an
 * attacker-controlled body can never reach an error, log, or observation.
 */
export function summarizeUpstreamError(value: unknown): UpstreamErrorSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return EMPTY_UPSTREAM_ERROR;
  }
  const envelope = (value as { error?: unknown }).error;
  const source = (typeof envelope === "object" && envelope !== null && !Array.isArray(envelope)
    ? envelope
    : value) as Record<string, unknown>;
  const safe = (raw: unknown, pattern: RegExp): string | null =>
    typeof raw === "string" && pattern.test(raw) ? raw : null;
  return Object.freeze({
    type: safe(source["type"], SAFE_CODE_PATTERN),
    code: safe(source["code"], SAFE_CODE_PATTERN),
    param: safe(source["param"], SAFE_PARAM_PATTERN),
  });
}

function withUpstream(
  details: ProviderErrorDetails,
  upstream: UpstreamErrorSummary,
): ProviderErrorDetails {
  return {
    ...details,
    upstreamType: upstream.type,
    upstreamCode: upstream.code,
    upstreamParam: upstream.param,
  };
}

export interface HttpErrorInput {
  readonly status: number;
  /** Fixed route label, never a full URL. */
  readonly route: string;
  readonly retryAfterMs: number | null;
  readonly rateLimit: RateLimitInformation | null;
  readonly upstream: UpstreamErrorSummary;
  /** True when the request created remote state that may still be running. */
  readonly operationMayStillBeRunning?: boolean;
}

/**
 * Maps a non-success HTTP status to a stable ProviderError with accurate
 * retry metadata. The response body contributes only its machine `type`,
 * `code`, and `param` fields; the body itself is never included.
 */
export function httpStatusError(input: HttpErrorInput): ProviderError {
  const { status, route, retryAfterMs, rateLimit, upstream } = input;
  const mayStillRun = input.operationMayStillBeRunning ?? false;
  const details = withUpstream({ httpStatus: status, route }, upstream);

  if (status >= 300 && status < 400) {
    return redirectRejectedError(status);
  }

  if (status === 400 || status === 422) {
    // A context-length overflow is reported as a 400 with a stable code.
    if (upstream.code === "context_length_exceeded" || upstream.code === "string_above_max_length") {
      return new ProviderError(
        "CONTEXT_LIMIT_EXCEEDED",
        "The request exceeded the model's context limit.",
        details,
        { retry: createRetryDisposition({ strategy: "alternate-model", requestReusable: false }) },
      );
    }
    if (upstream.code === "unsupported_value" || upstream.code === "unsupported_parameter") {
      return new ProviderError("UNSUPPORTED_CAPABILITY", "The API rejected an unsupported option.", details, {
        retry: createRetryDisposition({ strategy: "alternate-model" }),
      });
    }
    return new ProviderError("INVALID_REQUEST", "The OpenAI API rejected the request.", details, {
      retry: createRetryDisposition({ strategy: "never" }),
    });
  }

  if (status === 401) {
    return new ProviderError("AUTHENTICATION_FAILED", "The OpenAI API rejected the credentials.", details);
  }

  if (status === 403) {
    // Region/data-residency denials are authorization failures, not policy
    // decisions this adapter made.
    return new ProviderError("AUTHORIZATION_FAILED", "The OpenAI API denied access to this resource.", details);
  }

  if (status === 404) {
    return new ProviderError(
      "MODEL_UNAVAILABLE",
      "The OpenAI API reported the model or response as unavailable.",
      details,
      { retry: createRetryDisposition({ strategy: "alternate-model", requestReusable: true }) },
    );
  }

  if (status === 408) {
    return new ProviderError("TIMEOUT", "The OpenAI API reported a request timeout.", details, {
      retry: createRetryDisposition({
        strategy: "same-after-delay",
        minimumDelayMs: 500,
        requestReusable: true,
        operationMayStillBeRunning: mayStillRun,
        idempotencyRequired: true,
      }),
    });
  }

  if (status === 409) {
    // Conflict: the addressed response is in a state that forbids the
    // transition (for example cancelling an already-terminal response).
    return new ProviderError("INVALID_REQUEST", "The OpenAI response is not in a state that allows this operation.", details, {
      retry: createRetryDisposition({ strategy: "never" }),
    });
  }

  if (status === 429) {
    const quota = upstream.code === "insufficient_quota" || upstream.type === "insufficient_quota";
    if (quota) {
      return new ProviderError("QUOTA_EXCEEDED", "The OpenAI account has exhausted its quota.", details, {
        retry: createRetryDisposition({ strategy: "human-action" }),
        ...(rateLimit === null ? {} : { rateLimit }),
      });
    }
    return new ProviderError("RATE_LIMITED", "The OpenAI API throttled the request.", details, {
      retry: createRetryDisposition({
        strategy: "same-after-delay",
        minimumDelayMs: retryAfterMs ?? 1_000,
        retryAfterMs,
        requestReusable: true,
      }),
      retryAfterMs,
      ...(rateLimit === null ? {} : { rateLimit }),
    });
  }

  if (status === 500 || status === 502 || status === 503 || status === 504 || status === 529) {
    const overloaded = status !== 500;
    return new ProviderError(
      overloaded ? "PROVIDER_OVERLOADED" : "INTERNAL_FAILURE",
      overloaded ? "The OpenAI API reported overload." : "The OpenAI API failed to process the request.",
      details,
      {
        retry: createRetryDisposition({
          strategy: "same-after-delay",
          minimumDelayMs: retryAfterMs ?? 1_000,
          retryAfterMs,
          requestReusable: true,
          operationMayStillBeRunning: mayStillRun,
          idempotencyRequired: mayStillRun,
        }),
        retryAfterMs,
      },
    );
  }

  if (INVALID_REQUEST_TYPES.has(upstream.type ?? "")) {
    return new ProviderError("INVALID_REQUEST", "The OpenAI API rejected the request.", details, {
      retry: createRetryDisposition({ strategy: "never" }),
    });
  }

  return new ProviderError("INTERNAL_FAILURE", "The OpenAI API returned an unexpected status.", details, {
    causeCategory: "unexpected-status",
  });
}

/**
 * Maps a terminal `response.failed` / stored-response error object to a
 * provider error. Only the documented machine `code` is consulted.
 */
export function responseFailureError(upstream: UpstreamErrorSummary): ProviderError {
  const details = withUpstream({}, upstream);
  switch (upstream.code) {
    case "rate_limit_exceeded":
      return new ProviderError("RATE_LIMITED", "The OpenAI response failed due to rate limiting.", details, {
        retry: createRetryDisposition({
          strategy: "same-after-delay",
          minimumDelayMs: 1_000,
          requestReusable: true,
        }),
      });
    case "invalid_prompt":
    case "bio_policy":
      return new ProviderError("CONTENT_REJECTED", "The OpenAI API rejected the prompt content.", details, {
        retry: createRetryDisposition({ strategy: "never" }),
      });
    case "data_residency_mismatch":
      return new ProviderError("AUTHORIZATION_FAILED", "The request violated a data-residency constraint.", details, {
        retry: createRetryDisposition({ strategy: "human-action" }),
      });
    case "server_error":
      return new ProviderError("INTERNAL_FAILURE", "The OpenAI API reported a server error.", details, {
        retry: createRetryDisposition({
          strategy: "same-after-delay",
          minimumDelayMs: 1_000,
          requestReusable: true,
        }),
      });
    default:
      return new ProviderError("INTERNAL_FAILURE", "The OpenAI response failed.", details, {
        causeCategory: "response-failed",
      });
  }
}
