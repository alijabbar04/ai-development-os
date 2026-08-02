/**
 * Failure mapping.
 *
 * Two pure translations live here: from an adapter detail code to a
 * provider-neutral error, and from a Stage 8 process-broker failure to the
 * same vocabulary. Both are total over their inputs and neither reads any
 * operation state, so both are exhaustively testable on their own.
 *
 * A production refusal maps to POLICY_DENIED with the refusal detail intact.
 * It is never converted into a transient failure a scheduler would retry,
 * because retrying it would just refuse again — the answer is to provide a
 * secure backend, not to try harder.
 */

import { ProviderError, toProviderError } from "@ai-dev-os/providers";
import {
  cancelledError,
  contextLimitError,
  deadlineExceededError,
  errorForDetailCode,
  internalFailureError,
  malformedResponseError,
  modelUnavailableError,
  policyDeniedError,
  protocolViolationError,
  quotaExceededError,
  rateLimitedError,
  timeoutError,
  unsupportedCapabilityError,
  workspaceUnavailableError,
  type ClaudeDetailCode,
} from "./errors.js";

export function failureForDetail(input: {
  readonly detailCode: ClaudeDetailCode;
  readonly retryAfterMs: number | null;
  readonly model: string | null;
  readonly maxTurns: number;
}): ProviderError {
  const { detailCode, retryAfterMs } = input;
  switch (detailCode) {
    case "turn-limit-reached":
      return quotaExceededError({ detail: "turn-limit", maxTurns: input.maxTurns });
    case "budget-exhausted":
      return quotaExceededError({ detail: "budget" });
    case "context-limit":
      return contextLimitError();
    case "rate-limited":
      return rateLimitedError(retryAfterMs);
    case "model-substituted":
      return modelUnavailableError(detailCode, input.model === null ? {} : { requestedModel: input.model });
    case "session-id-mismatch":
    case "record-after-terminal":
    case "duplicate-terminal":
    case "result-contradiction":
    case "unknown-state-changing-record":
    case "non-monotonic-usage":
    case "negative-usage":
      return protocolViolationError(detailCode);
    case "malformed-json":
    case "non-object-record":
    case "prototype-pollution":
    case "unsafe-number":
    case "invalid-utf8":
    case "record-oversized":
    case "stream-oversized":
    case "record-count-exceeded":
    case "hostile-path":
    case "missing-terminal":
      return malformedResponseError(detailCode);
    default:
      return errorForDetailCode(detailCode, retryAfterMs);
  }
}

/**
 * Broker error codes the adapter understands. Anything absent classifies as an
 * internal spawn failure rather than being guessed at.
 */
export function brokerFailure(error: unknown): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string") {
    return toProviderError(error);
  }
  switch (code) {
    case "PRODUCTION_ISOLATION_REQUIRED":
    case "BACKEND_INSECURE":
    case "BACKEND_UNAVAILABLE":
      // Refusal is the correct outcome, not a transient condition to retry.
      return policyDeniedError("production-isolation-required", { brokerCode: code });
    case "POLICY_DENIED":
      return policyDeniedError("policy-denied", { brokerCode: code });
    case "APPROVAL_REQUIRED":
      return new ProviderError(
        "AUTHORIZATION_FAILED",
        "The Claude Code invocation requires an approval that was not supplied.",
        { detailCode: "approval-outstanding" satisfies ClaudeDetailCode, brokerCode: code },
      );
    case "CANCELLED":
      return cancelledError();
    case "DEADLINE_EXCEEDED":
      return deadlineExceededError({ brokerCode: code });
    case "OUTPUT_QUOTA_EXCEEDED":
      return malformedResponseError("stream-oversized", { brokerCode: code });
    case "EXECUTABLE_UNAVAILABLE":
    case "EXECUTABLE_UNSAFE":
    case "EXECUTABLE_DIGEST_MISMATCH":
    case "SHELL_PROHIBITED":
      return unsupportedCapabilityError("executable-unsafe", { brokerCode: code });
    case "LEASE_EXPIRED":
    case "LEASE_INVALID":
    case "LEASE_REVOKED":
    case "GRANT_EXPIRED":
    case "INVALID_GRANT":
      return workspaceUnavailableError("workspace-lease-invalid", { brokerCode: code });
    case "PROCESS_TREE_TERMINATION_FAILED":
      // The tree could not be proven gone, so a retry must assume the previous
      // attempt may still be running.
      return timeoutError({ brokerCode: code });
    case "ENVIRONMENT_REJECTED":
      return policyDeniedError("policy-denied", { brokerCode: code });
    case "BROKER_CLOSED":
      return internalFailureError("provider-closed", { brokerCode: code });
    default:
      return internalFailureError("process-spawn-failed", { brokerCode: code });
  }
}
