import { ProviderError, createRetryDisposition } from "@ai-dev-os/providers";
import type { ProviderErrorDetails } from "@ai-dev-os/providers";

/**
 * Stable error construction for the Ollama adapter.
 *
 * Every failure surfaces as an existing @ai-dev-os/providers ProviderError
 * code with a conservative retry disposition. Messages and details are
 * fixed, structural summaries: prompts, generated text, reasoning, tool
 * arguments, raw response bodies, headers, and URLs never appear here.
 */

/** Endpoint or configuration is unsafe/invalid; never retryable. */
export function unsafeEndpointError(detailCode: string): ProviderError {
  return new ProviderError(
    "INVALID_REQUEST",
    "The Ollama endpoint is not an accepted literal loopback URL.",
    { detailCode },
    { retry: createRetryDisposition({ strategy: "never" }), causeCategory: "unsafe-endpoint" },
  );
}

export function invalidConfigurationError(detailCode: string): ProviderError {
  return new ProviderError(
    "INVALID_REQUEST",
    "The Ollama adapter configuration is invalid.",
    { detailCode },
    { retry: createRetryDisposition({ strategy: "never" }), causeCategory: "invalid-configuration" },
  );
}

/** Redirects are rejected before a second request can be made. */
export function redirectRejectedError(status: number): ProviderError {
  return new ProviderError(
    "PROTOCOL_VIOLATION",
    "The Ollama endpoint attempted an HTTP redirect, which is rejected.",
    { httpStatus: status },
    { retry: createRetryDisposition({ strategy: "never" }), causeCategory: "redirect-rejected" },
  );
}

export function connectionFailedError(causeCategory: string): ProviderError {
  return new ProviderError(
    "NETWORK_FAILURE",
    "The Ollama server could not be reached.",
    {},
    { causeCategory },
  );
}

export function requestTimeoutError(timeoutMs: number): ProviderError {
  return new ProviderError(
    "TIMEOUT",
    "The Ollama request exceeded its configured timeout.",
    { timeoutMs },
    { causeCategory: "request-timeout" },
  );
}

export function malformedResponseError(detailCode: string, details: ProviderErrorDetails = {}): ProviderError {
  return new ProviderError(
    "MALFORMED_RESPONSE",
    "The Ollama server returned a response that failed validation.",
    { detailCode, ...details },
    { causeCategory: detailCode },
  );
}

export function digestMismatchError(modelName: string): ProviderError {
  return new ProviderError(
    "MODEL_UNAVAILABLE",
    "The installed model digest does not match its configured pin.",
    { modelName, detailCode: "digest-mismatch" },
    { retry: createRetryDisposition({ strategy: "human-action" }), causeCategory: "digest-mismatch" },
  );
}

export function modelMissingError(modelName: string): ProviderError {
  return new ProviderError(
    "MODEL_UNAVAILABLE",
    "The requested model is not installed on the Ollama server.",
    { modelName, detailCode: "model-missing" },
    { retry: createRetryDisposition({ strategy: "alternate-model", requestReusable: true }) },
  );
}

export function overloadedError(detailCode: string, minimumDelayMs = 1_000): ProviderError {
  return new ProviderError(
    "PROVIDER_OVERLOADED",
    "The local Ollama capacity limit rejected the operation.",
    { detailCode },
    {
      retry: createRetryDisposition({
        strategy: "same-after-delay",
        minimumDelayMs,
        requestReusable: true,
      }),
      causeCategory: detailCode,
    },
  );
}

export function providerClosedError(): ProviderError {
  return new ProviderError("PROVIDER_CLOSED", "The Ollama provider is closed.", {});
}

/**
 * Maps a non-success HTTP status to a stable ProviderError. The response
 * body never contributes to the error: Ollama error envelopes are treated
 * as untrusted and are dropped after bounded classification.
 */
export function httpStatusError(options: {
  readonly status: number;
  readonly endpoint: string;
  readonly retryAfterMs: number | null;
}): ProviderError {
  const { status, endpoint, retryAfterMs } = options;
  const details: ProviderErrorDetails = { httpStatus: status, endpoint };
  if (status >= 300 && status < 400) {
    return redirectRejectedError(status);
  }
  if (status === 400) {
    return new ProviderError("INVALID_REQUEST", "The Ollama server rejected the request.", details);
  }
  if (status === 401) {
    return new ProviderError("AUTHENTICATION_FAILED", "The Ollama server required authentication.", details);
  }
  if (status === 403) {
    return new ProviderError("AUTHORIZATION_FAILED", "The Ollama server denied the request.", details);
  }
  if (status === 404) {
    // /api/chat, /api/show and /api/generate report unknown models as 404;
    // 404 on a discovery route means the API surface is incompatible.
    if (endpoint === "chat" || endpoint === "show" || endpoint === "generate") {
      return new ProviderError(
        "MODEL_UNAVAILABLE",
        "The Ollama server reported the requested model as unavailable.",
        details,
        { retry: createRetryDisposition({ strategy: "alternate-model", requestReusable: true }) },
      );
    }
    return new ProviderError(
      "PROTOCOL_VIOLATION",
      "The Ollama server does not expose the expected API surface.",
      { ...details, detailCode: "incompatible-api" },
      { retry: createRetryDisposition({ strategy: "never" }), causeCategory: "incompatible-api" },
    );
  }
  if (status === 429) {
    return new ProviderError(
      "RATE_LIMITED",
      "The Ollama server throttled the request.",
      details,
      {
        retry: createRetryDisposition({
          strategy: "same-after-delay",
          minimumDelayMs: retryAfterMs ?? 1_000,
          retryAfterMs,
          requestReusable: true,
        }),
        retryAfterMs,
      },
    );
  }
  if (status === 502 || status === 503 || status === 529) {
    return new ProviderError(
      "PROVIDER_OVERLOADED",
      "The Ollama server reported overload.",
      details,
      {
        retry: createRetryDisposition({
          strategy: "same-after-delay",
          minimumDelayMs: retryAfterMs ?? 1_000,
          retryAfterMs,
          requestReusable: true,
        }),
        retryAfterMs,
      },
    );
  }
  return new ProviderError(
    "INTERNAL_FAILURE",
    "The Ollama server failed to process the request.",
    details,
    { causeCategory: "server-failure" },
  );
}
