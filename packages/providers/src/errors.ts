import { validation } from "@ai-dev-os/domain";

const { ensureNullable, ensureSafeInteger } = validation;

export const PROVIDER_ERROR_CODES = Object.freeze([
  "INVALID_REQUEST",
  "UNSUPPORTED_CAPABILITY",
  "AUTHENTICATION_FAILED",
  "AUTHORIZATION_FAILED",
  "MODEL_UNAVAILABLE",
  "RATE_LIMITED",
  "QUOTA_EXCEEDED",
  "PROVIDER_OVERLOADED",
  "NETWORK_FAILURE",
  "TIMEOUT",
  "DEADLINE_EXCEEDED",
  "CANCELLED",
  "MALFORMED_RESPONSE",
  "PROTOCOL_VIOLATION",
  "TOOL_PROTOCOL_FAILURE",
  "CONTEXT_LIMIT_EXCEEDED",
  "CONTENT_REJECTED",
  "POLICY_DENIED",
  "WORKSPACE_UNAVAILABLE",
  "PROVIDER_CLOSED",
  "INTERNAL_FAILURE",
] as const);

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export const RETRY_STRATEGIES = Object.freeze([
  "never",
  "same",
  "same-after-delay",
  "alternate-model",
  "alternate-provider",
  "human-action",
] as const);

export type RetryStrategy = (typeof RETRY_STRATEGIES)[number];

/**
 * Retry classification, independent of any retry executor. The scheduler
 * (a later stage) interprets this; nothing in Stage 5 retries anything.
 */
export interface RetryDisposition {
  readonly strategy: RetryStrategy;
  /** Minimum delay before a retry makes sense; null when not applicable. */
  readonly minimumDelayMs: number | null;
  /** Provider-supplied retry-after when present (e.g. rate limits). */
  readonly retryAfterMs: number | null;
  /** True when the identical request can be safely resubmitted. */
  readonly requestReusable: boolean;
  /** True when the remote operation may still be running despite the error. */
  readonly operationMayStillBeRunning: boolean;
  /** True when a retry must carry idempotency protection. */
  readonly idempotencyRequired: boolean;
}

const MAX_DELAY_MS = 86_400_000;

export function createRetryDisposition(
  input: Partial<RetryDisposition> & { readonly strategy: RetryStrategy },
): RetryDisposition {
  if (!RETRY_STRATEGIES.includes(input.strategy)) {
    throw new ProviderError("INVALID_REQUEST", "Unknown retry strategy.", {});
  }
  return Object.freeze({
    strategy: input.strategy,
    minimumDelayMs: ensureNullable(input.minimumDelayMs, (value) =>
      ensureSafeInteger(value, "retry.minimumDelayMs", 0, MAX_DELAY_MS),
    ),
    retryAfterMs: ensureNullable(input.retryAfterMs, (value) =>
      ensureSafeInteger(value, "retry.retryAfterMs", 0, MAX_DELAY_MS),
    ),
    requestReusable: input.requestReusable ?? false,
    operationMayStillBeRunning: input.operationMayStillBeRunning ?? false,
    idempotencyRequired: input.idempotencyRequired ?? false,
  });
}

/** Conservative default retry classification for each error code. */
export function defaultRetryDisposition(code: ProviderErrorCode): RetryDisposition {
  switch (code) {
    case "RATE_LIMITED":
    case "PROVIDER_OVERLOADED":
      return createRetryDisposition({
        strategy: "same-after-delay",
        minimumDelayMs: 1_000,
        requestReusable: true,
      });
    case "NETWORK_FAILURE":
    case "TIMEOUT":
      return createRetryDisposition({
        strategy: "same-after-delay",
        minimumDelayMs: 500,
        requestReusable: true,
        operationMayStillBeRunning: true,
        idempotencyRequired: true,
      });
    case "MODEL_UNAVAILABLE":
      return createRetryDisposition({ strategy: "alternate-model", requestReusable: true });
    case "PROVIDER_CLOSED":
    case "INTERNAL_FAILURE":
    case "MALFORMED_RESPONSE":
    case "PROTOCOL_VIOLATION":
      return createRetryDisposition({ strategy: "alternate-provider", requestReusable: true });
    case "CONTEXT_LIMIT_EXCEEDED":
      return createRetryDisposition({ strategy: "alternate-model", requestReusable: false });
    case "AUTHENTICATION_FAILED":
    case "AUTHORIZATION_FAILED":
    case "QUOTA_EXCEEDED":
      return createRetryDisposition({ strategy: "human-action" });
    default:
      return createRetryDisposition({ strategy: "never" });
  }
}

/** Rate-limit context carried by RATE_LIMITED errors. */
export interface RateLimitInformation {
  readonly retryAfterMs: number | null;
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly resetsAt: string | null;
}

export type ProviderErrorDetailValue =
  | string
  | number
  | boolean
  | null
  | readonly ProviderErrorDetailValue[];

/**
 * Detail values are restricted to primitive summaries: codes, counts, model
 * ids, and durations. API keys, headers, request/response bodies, command
 * output, filesystem paths, and environment values must never appear here.
 */
export type ProviderErrorDetails = Readonly<Record<string, ProviderErrorDetailValue>>;

export interface ProviderErrorOptions {
  readonly retry?: RetryDisposition;
  readonly retryAfterMs?: number | null;
  readonly rateLimit?: RateLimitInformation | null;
  readonly operationId?: string | null;
  readonly traceId?: string | null;
  /** Non-secret classification of the underlying cause (e.g. "econnreset"). */
  readonly causeCategory?: string | null;
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly details: ProviderErrorDetails;
  readonly retry: RetryDisposition;
  readonly retryAfterMs: number | null;
  readonly rateLimit: RateLimitInformation | null;
  readonly operationId: string | null;
  readonly traceId: string | null;
  readonly causeCategory: string | null;

  constructor(
    code: ProviderErrorCode,
    message: string,
    details: ProviderErrorDetails = {},
    options: ProviderErrorOptions = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.details = Object.freeze({ ...details });
    this.retry = options.retry ?? defaultRetryDisposition(code);
    this.retryAfterMs = options.retryAfterMs ?? this.retry.retryAfterMs;
    this.rateLimit = options.rateLimit ?? null;
    this.operationId = options.operationId ?? null;
    this.traceId = options.traceId ?? null;
    this.causeCategory = options.causeCategory ?? null;
  }

  toJSON(): {
    readonly name: string;
    readonly code: ProviderErrorCode;
    readonly message: string;
    readonly details: ProviderErrorDetails;
    readonly retry: RetryDisposition;
    readonly retryAfterMs: number | null;
    readonly operationId: string | null;
    readonly traceId: string | null;
    readonly causeCategory: string | null;
  } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      retry: this.retry,
      retryAfterMs: this.retryAfterMs,
      operationId: this.operationId,
      traceId: this.traceId,
      causeCategory: this.causeCategory,
    };
  }
}

export function isProviderError(
  value: unknown,
  code?: ProviderErrorCode,
): value is ProviderError {
  return value instanceof ProviderError && (code === undefined || value.code === code);
}

/** Wraps any unknown failure as a structured provider error, never leaking it. */
export function toProviderError(
  value: unknown,
  fallbackCode: ProviderErrorCode = "INTERNAL_FAILURE",
): ProviderError {
  if (value instanceof ProviderError) {
    return value;
  }
  return new ProviderError(fallbackCode, "The provider failed internally.", {
    causeName: value instanceof Error ? value.name : typeof value,
  });
}
