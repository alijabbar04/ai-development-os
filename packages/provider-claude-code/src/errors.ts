/**
 * Structured failures for the Claude Code adapter.
 *
 * Every failure leaves this package as a `ProviderError` from
 * `@ai-dev-os/providers` carrying one of the twenty-one stable codes. Details
 * hold only bounded primitives: stable detail codes, counts, byte totals,
 * durations, and the model or session identifiers the caller already supplied.
 *
 * Details never hold instructions, repository content, patches, Claude wire
 * payloads, stderr text, tool arguments, environment values, credentials,
 * absolute filesystem paths, or hidden reasoning. The one classification path
 * that reads provider text (`classifyRetryText`) is a finite versioned table
 * and never copies the text it inspected into the error.
 */

import {
  ProviderError,
  createRetryDisposition,
  type ProviderErrorCode,
  type RetryDisposition,
} from "@ai-dev-os/providers";

/**
 * Stable machine-readable causes. These appear in error details and in
 * observations, so they are part of the package's compatibility surface.
 */
export const CLAUDE_DETAIL_CODES = Object.freeze([
  "executable-missing",
  "executable-shell-shim",
  "executable-not-absolute",
  "executable-unreadable",
  "executable-unsafe",
  "probe-failed",
  "probe-unparseable",
  "version-unsupported",
  "capability-missing",
  "authentication-unavailable",
  "authentication-rejected",
  "model-not-permitted",
  "model-not-observed",
  "model-substituted",
  "effort-not-permitted",
  "effort-unsupported",
  "session-persistence-denied",
  "resume-token-invalid",
  "resume-token-expired",
  "resume-project-mismatch",
  "resume-workspace-mismatch",
  "resume-model-mismatch",
  "command-policy-untranslatable",
  "network-policy-unenforceable",
  "approval-unrepresentable",
  "approval-outstanding",
  "policy-denied",
  "workspace-missing",
  "workspace-lease-invalid",
  "workspace-lineage-mismatch",
  "workspace-is-source-tree",
  "reconciliation-path-violation",
  "reconciliation-file-limit",
  "reconciliation-byte-limit",
  "reconciliation-administrative-path",
  "reconciliation-link-escape",
  "reconciliation-revision-moved",
  "record-oversized",
  "stream-oversized",
  "record-count-exceeded",
  "invalid-utf8",
  "malformed-json",
  "non-object-record",
  "prototype-pollution",
  "unsafe-number",
  "negative-usage",
  "non-monotonic-usage",
  "duplicate-terminal",
  "record-after-terminal",
  "missing-terminal",
  "session-id-mismatch",
  "unknown-state-changing-record",
  "result-contradiction",
  "hostile-path",
  "process-spawn-failed",
  "process-nonzero-exit",
  "process-output-quota",
  "process-deadline",
  "process-cancelled",
  "process-termination-unconfirmed",
  "production-isolation-required",
  "budget-exhausted",
  "turn-limit-reached",
  "context-limit",
  "content-rejected",
  "rate-limited",
  "overloaded",
  "network-failure",
  "provider-closed",
  "configuration-invalid",
  "artifact-write-denied",
  "artifact-oversized",
  "internal",
] as const);

export type ClaudeDetailCode = (typeof CLAUDE_DETAIL_CODES)[number];

type Details = Readonly<Record<string, string | number | boolean | null | readonly string[]>>;

function providerError(
  code: ProviderErrorCode,
  message: string,
  detailCode: ClaudeDetailCode,
  details: Details = {},
  retry?: RetryDisposition,
): ProviderError {
  return new ProviderError(
    code,
    message,
    { detailCode, ...details },
    retry === undefined ? {} : { retry },
  );
}

export function invalidRequestError(detailCode: ClaudeDetailCode, details: Details = {}): ProviderError {
  return providerError("INVALID_REQUEST", "The coding-agent request was rejected.", detailCode, details);
}

export function invalidConfigurationError(
  detailCode: ClaudeDetailCode,
  details: Details = {},
): ProviderError {
  return providerError(
    "INVALID_REQUEST",
    "The Claude Code adapter configuration was rejected.",
    detailCode,
    details,
    createRetryDisposition({ strategy: "human-action" }),
  );
}

export function unsupportedCapabilityError(
  detailCode: ClaudeDetailCode,
  details: Details = {},
): ProviderError {
  return providerError(
    "UNSUPPORTED_CAPABILITY",
    "The installed Claude Code CLI cannot satisfy this request exactly.",
    detailCode,
    details,
    createRetryDisposition({ strategy: "alternate-provider", requestReusable: true }),
  );
}

export function authenticationError(detailCode: ClaudeDetailCode, details: Details = {}): ProviderError {
  return providerError(
    "AUTHENTICATION_FAILED",
    "Claude Code has no usable policy-approved credential for this invocation.",
    detailCode,
    details,
    createRetryDisposition({ strategy: "human-action" }),
  );
}

export function authorizationError(detailCode: ClaudeDetailCode, details: Details = {}): ProviderError {
  return providerError(
    "AUTHORIZATION_FAILED",
    "The requested Claude Code operation was not authorized.",
    detailCode,
    details,
    createRetryDisposition({ strategy: "human-action" }),
  );
}

export function policyDeniedError(detailCode: ClaudeDetailCode, details: Details = {}): ProviderError {
  return providerError(
    "POLICY_DENIED",
    "Policy denied this Claude Code operation.",
    detailCode,
    details,
    createRetryDisposition({ strategy: "never" }),
  );
}

export function modelUnavailableError(detailCode: ClaudeDetailCode, details: Details = {}): ProviderError {
  return providerError(
    "MODEL_UNAVAILABLE",
    "The exact requested Claude model is not available on this installation.",
    detailCode,
    details,
    createRetryDisposition({ strategy: "alternate-model", requestReusable: true }),
  );
}

export function rateLimitedError(retryAfterMs: number | null, details: Details = {}): ProviderError {
  return new ProviderError(
    "RATE_LIMITED",
    "Claude Code reported a rate limit.",
    { detailCode: "rate-limited" satisfies ClaudeDetailCode, ...details },
    {
      retry: createRetryDisposition({
        strategy: "same-after-delay",
        minimumDelayMs: retryAfterMs ?? 1_000,
        retryAfterMs,
        requestReusable: true,
      }),
      rateLimit: { retryAfterMs, limit: null, remaining: null, resetsAt: null },
    },
  );
}

export function quotaExceededError(details: Details = {}): ProviderError {
  return providerError(
    "QUOTA_EXCEEDED",
    "The Claude Code invocation exhausted its configured budget.",
    "budget-exhausted",
    details,
    createRetryDisposition({ strategy: "human-action" }),
  );
}

export function overloadedError(retryAfterMs: number | null, details: Details = {}): ProviderError {
  return new ProviderError(
    "PROVIDER_OVERLOADED",
    "Claude Code reported that the service is overloaded.",
    { detailCode: "overloaded" satisfies ClaudeDetailCode, ...details },
    {
      retry: createRetryDisposition({
        strategy: "same-after-delay",
        minimumDelayMs: retryAfterMs ?? 2_000,
        retryAfterMs,
        requestReusable: true,
      }),
    },
  );
}

export function networkFailureError(details: Details = {}): ProviderError {
  return providerError(
    "NETWORK_FAILURE",
    "Claude Code could not reach its service endpoint.",
    "network-failure",
    details,
    createRetryDisposition({
      strategy: "same-after-delay",
      minimumDelayMs: 500,
      requestReusable: true,
      operationMayStillBeRunning: true,
      idempotencyRequired: true,
    }),
  );
}

export function deadlineExceededError(details: Details = {}): ProviderError {
  return providerError(
    "DEADLINE_EXCEEDED",
    "The Claude Code operation exceeded its deadline.",
    "process-deadline",
    details,
    createRetryDisposition({ strategy: "never", operationMayStillBeRunning: false }),
  );
}

export function timeoutError(details: Details = {}): ProviderError {
  return providerError(
    "TIMEOUT",
    "The Claude Code process exceeded its wall-clock quota.",
    "process-deadline",
    details,
    createRetryDisposition({
      strategy: "same-after-delay",
      minimumDelayMs: 1_000,
      requestReusable: true,
      operationMayStillBeRunning: true,
      idempotencyRequired: true,
    }),
  );
}

export function cancelledError(details: Details = {}): ProviderError {
  return providerError("CANCELLED", "The Claude Code operation was cancelled.", "process-cancelled", details);
}

export function malformedResponseError(
  detailCode: ClaudeDetailCode,
  details: Details = {},
): ProviderError {
  return providerError(
    "MALFORMED_RESPONSE",
    "Claude Code produced output the adapter refuses to interpret.",
    detailCode,
    details,
    createRetryDisposition({ strategy: "alternate-provider", requestReusable: true }),
  );
}

export function protocolViolationError(
  detailCode: ClaudeDetailCode,
  details: Details = {},
): ProviderError {
  return providerError(
    "PROTOCOL_VIOLATION",
    "Claude Code violated the documented stream-json protocol.",
    detailCode,
    details,
    createRetryDisposition({ strategy: "alternate-provider", requestReusable: true }),
  );
}

export function toolProtocolFailureError(
  detailCode: ClaudeDetailCode,
  details: Details = {},
): ProviderError {
  return providerError(
    "TOOL_PROTOCOL_FAILURE",
    "Claude Code reported a tool interaction the adapter cannot represent safely.",
    detailCode,
    details,
    createRetryDisposition({ strategy: "never" }),
  );
}

export function contextLimitError(details: Details = {}): ProviderError {
  return providerError(
    "CONTEXT_LIMIT_EXCEEDED",
    "The Claude Code session exceeded the model context limit.",
    "context-limit",
    details,
    createRetryDisposition({ strategy: "alternate-model", requestReusable: false }),
  );
}

export function contentRejectedError(details: Details = {}): ProviderError {
  return providerError(
    "CONTENT_REJECTED",
    "Claude Code rejected the request content.",
    "content-rejected",
    details,
    createRetryDisposition({ strategy: "never" }),
  );
}

export function workspaceUnavailableError(
  detailCode: ClaudeDetailCode,
  details: Details = {},
): ProviderError {
  return providerError(
    "WORKSPACE_UNAVAILABLE",
    "The managed workspace required by this request is unavailable.",
    detailCode,
    details,
    createRetryDisposition({ strategy: "never" }),
  );
}

export function providerClosedError(): ProviderError {
  return providerError(
    "PROVIDER_CLOSED",
    "The Claude Code provider is closed.",
    "provider-closed",
    {},
    createRetryDisposition({ strategy: "alternate-provider", requestReusable: true }),
  );
}

export function internalFailureError(detailCode: ClaudeDetailCode, details: Details = {}): ProviderError {
  return providerError(
    "INTERNAL_FAILURE",
    "The Claude Code adapter failed internally.",
    detailCode,
    details,
    createRetryDisposition({ strategy: "alternate-provider", requestReusable: true }),
  );
}

/**
 * Finite, versioned text classification.
 *
 * Structured fields and process state are always preferred. This table exists
 * only for the documented `system/api_retry` `error` category strings and for
 * the small set of result payloads that carry a category rather than a code.
 * Anything unrecognized classifies conservatively as `null`, and the inspected
 * text is never copied into the returned error.
 */
export const RETRY_TEXT_TABLE_VERSION = 1 as const;

const RETRY_CATEGORIES: ReadonlyMap<string, ClaudeDetailCode> = Object.freeze(
  new Map<string, ClaudeDetailCode>([
    ["authentication_failed", "authentication-rejected"],
    ["oauth_org_not_allowed", "authentication-rejected"],
    ["billing_error", "budget-exhausted"],
    ["rate_limit", "rate-limited"],
    ["overloaded", "overloaded"],
    ["invalid_request", "content-rejected"],
    ["model_not_found", "model-not-observed"],
    ["server_error", "overloaded"],
    ["max_output_tokens", "context-limit"],
  ]),
);

/**
 * Maps a documented retry-event category to a stable detail code. Returns null
 * for `unknown` and for anything absent from the table, so an unrecognized
 * category never widens into a confident classification.
 */
export function classifyRetryCategory(category: string): ClaudeDetailCode | null {
  if (category.length > 64) {
    return null;
  }
  return RETRY_CATEGORIES.get(category) ?? null;
}

/** Builds the provider error a classified retry category implies. */
export function errorForDetailCode(
  detailCode: ClaudeDetailCode,
  retryAfterMs: number | null,
): ProviderError {
  switch (detailCode) {
    case "authentication-rejected":
      return authenticationError(detailCode);
    case "budget-exhausted":
      return quotaExceededError();
    case "rate-limited":
      return rateLimitedError(retryAfterMs);
    case "overloaded":
      return overloadedError(retryAfterMs);
    case "content-rejected":
      return contentRejectedError();
    case "model-not-observed":
      return modelUnavailableError(detailCode);
    case "context-limit":
      return contextLimitError();
    case "network-failure":
      return networkFailureError();
    default:
      return internalFailureError(detailCode);
  }
}
