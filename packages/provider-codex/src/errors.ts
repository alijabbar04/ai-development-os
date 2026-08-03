import { ProviderError, createRetryDisposition, type ProviderErrorCode } from "@ai-dev-os/providers";

export const CODEX_DETAIL_CODES = Object.freeze([
  "configuration-invalid", "executable-missing", "probe-failed", "probe-unparseable",
  "version-unsupported", "schema-incompatible", "not-initialized", "duplicate-initialize",
  "invalid-utf8", "malformed-json", "prototype-pollution", "unsafe-number", "record-oversized",
  "stream-oversized", "record-count-exceeded", "unknown-request-id", "duplicate-response",
  "unknown-state-changing-method", "pending-request-limit", "request-timeout", "connection-lost",
  "server-exited", "model-not-permitted", "model-substituted", "effort-not-permitted",
  "workspace-missing", "workspace-lineage-mismatch", "workspace-is-source-tree",
  "command-policy-untranslatable", "network-policy-unenforceable", "approval-unrepresentable",
  "approval-forged", "approval-declined", "authentication-unavailable", "rate-limited",
  "overloaded", "network-failure", "context-limit", "content-rejected", "process-deadline",
  "process-cancelled", "production-isolation-required", "reconciliation-path-violation",
  "reconciliation-file-limit", "reconciliation-byte-limit", "reconciliation-administrative-path",
  "reconciliation-link-escape", "artifact-write-denied", "provider-closed", "internal",
  "resume-token-invalid", "resume-token-expired", "resume-binding-mismatch", "session-persistence-denied",
  "usage-ceiling-exceeded",
] as const);
export type CodexDetailCode = (typeof CODEX_DETAIL_CODES)[number];
type Details = Readonly<Record<string, string | number | boolean | null | readonly string[]>>;

function error(code: ProviderErrorCode, message: string, detailCode: CodexDetailCode, details: Details = {}): ProviderError {
  return new ProviderError(code, message, { detailCode, ...details });
}
export const invalidCodexRequest = (detailCode: CodexDetailCode, details: Details = {}): ProviderError => error("INVALID_REQUEST", "The Codex coding-agent request was rejected.", detailCode, details);
export const unsupportedCodexCapability = (detailCode: CodexDetailCode, details: Details = {}): ProviderError => new ProviderError("UNSUPPORTED_CAPABILITY", "Codex cannot satisfy this request without weakening policy.", { detailCode, ...details }, { retry: createRetryDisposition({ strategy: "alternate-provider", requestReusable: true }) });
export const codexWorkspaceUnavailable = (detailCode: CodexDetailCode, details: Details = {}): ProviderError => error("WORKSPACE_UNAVAILABLE", "The managed workspace is unavailable.", detailCode, details);
export const codexProtocolViolation = (detailCode: CodexDetailCode, details: Details = {}): ProviderError => new ProviderError("PROTOCOL_VIOLATION", "The Codex App Server violated the bounded protocol.", { detailCode, ...details }, { retry: createRetryDisposition({ strategy: "alternate-provider", requestReusable: true }) });
export const codexMalformedResponse = (detailCode: CodexDetailCode, details: Details = {}): ProviderError => error("MALFORMED_RESPONSE", "Codex returned a response the adapter refuses to interpret.", detailCode, details);
export const codexDeadlineExceeded = (details: Details = {}): ProviderError => error("DEADLINE_EXCEEDED", "The Codex operation exceeded its deadline.", "process-deadline", details);
export const codexCancelled = (details: Details = {}): ProviderError => error("CANCELLED", "The Codex operation was cancelled.", "process-cancelled", details);
export const codexProviderClosed = (): ProviderError => new ProviderError("PROVIDER_CLOSED", "The Codex provider is closed.", { detailCode: "provider-closed" }, { retry: createRetryDisposition({ strategy: "alternate-provider", requestReusable: true }) });
export const codexInternalFailure = (detailCode: CodexDetailCode = "internal", details: Details = {}): ProviderError => error("INTERNAL_FAILURE", "The Codex adapter failed internally.", detailCode, details);
export const codexAuthenticationFailed = (details: Details = {}): ProviderError => new ProviderError("AUTHENTICATION_FAILED", "Codex has no usable authenticated account.", { detailCode: "authentication-unavailable", ...details }, { retry: createRetryDisposition({ strategy: "human-action" }) });

export function codexRateLimited(retryAfterMs: number | null = null): ProviderError {
  return new ProviderError("RATE_LIMITED", "Codex reported a rate limit.", { detailCode: "rate-limited" }, {
    retry: createRetryDisposition({ strategy: "same-after-delay", minimumDelayMs: retryAfterMs ?? 1_000, retryAfterMs, requestReusable: true }),
    rateLimit: { retryAfterMs, limit: null, remaining: null, resetsAt: null },
  });
}
export function codexOverloaded(retryAfterMs: number | null = null): ProviderError {
  return new ProviderError("PROVIDER_OVERLOADED", "Codex App Server is overloaded.", { detailCode: "overloaded" }, { retry: createRetryDisposition({ strategy: "same-after-delay", minimumDelayMs: retryAfterMs ?? 2_000, retryAfterMs, requestReusable: true }) });
}
export function codexNetworkFailure(details: Details = {}): ProviderError {
  return new ProviderError("NETWORK_FAILURE", "The Codex connection was lost.", { detailCode: "network-failure", ...details }, { retry: createRetryDisposition({ strategy: "same-after-delay", minimumDelayMs: 500, requestReusable: true, operationMayStillBeRunning: true, idempotencyRequired: true }) });
}
export const codexContextLimit = (): ProviderError => error("CONTEXT_LIMIT_EXCEEDED", "The Codex turn exceeded its context window.", "context-limit");
export const codexContentRejected = (): ProviderError => error("CONTENT_REJECTED", "Codex rejected the request content.", "content-rejected");
export const codexUsageCeilingExceeded = (details: Details = {}): ProviderError => error("QUOTA_EXCEEDED", "The Codex operation exceeded its configured token ceiling.", "usage-ceiling-exceeded", details);
