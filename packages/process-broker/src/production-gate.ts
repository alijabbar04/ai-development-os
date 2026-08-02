/**
 * The production execution gate.
 *
 * Autonomous execution against a repository is refused unless the selected
 * backend genuinely enforces the boundary the grant describes. The gate runs
 * before a sandbox is prepared and before any child process is created, so a
 * refusal leaves nothing behind to clean up.
 *
 * There is no downgrade path. If the approved secure backend is unavailable,
 * the answer is refusal, not a quiet fall back to the unsafe backend.
 */

import { ProcessBrokerError } from "./errors.js";
import type { BackendAvailability, BackendDescriptor } from "./backend.js";
import type { CapabilityGrant } from "./grant.js";
import type { ProcessRequest } from "./request.js";
import { requiredQuotaDimensions } from "./quota.js";
import type { Clock } from "./time.js";

export const EXECUTION_MODES = Object.freeze(["production", "development"] as const);
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const REFUSAL_REASONS = Object.freeze([
  "backend-unavailable",
  "backend-not-approved",
  "backend-not-secure",
  "platform-mismatch",
  "filesystem-isolation-missing",
  "process-tree-control-missing",
  "network-denial-unavailable",
  "quota-not-enforced",
  "grant-expired",
  "grant-mismatch",
  "policy-decision-missing",
  "policy-decision-denied",
  "policy-approval-outstanding",
  "policy-fingerprint-mismatch",
  "executable-digest-mismatch",
  "workspace-lease-invalid",
  "workspace-path-untrusted",
] as const);
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export interface AdmissionInput {
  readonly mode: ExecutionMode;
  readonly descriptor: BackendDescriptor;
  readonly availability: BackendAvailability;
  /** Backend identifiers the trusted composition layer approves in production. */
  readonly approvedBackendIds: readonly string[];
  readonly grant: CapabilityGrant;
  readonly request: ProcessRequest;
  readonly clock: Clock;
  /** The policy outcome for this exact command. `null` means none was made. */
  readonly policyOutcome: "allowed" | "denied" | "conditional" | null;
  readonly policyFingerprint: string | null;
  /** Digest of the image that will actually run, when one was verified. */
  readonly resolvedExecutableDigest: string | null;
  readonly workspaceLeaseValid: boolean;
  readonly workspacePathTrusted: boolean;
}

export interface AdmissionDecision {
  readonly admitted: boolean;
  readonly reasons: readonly RefusalReason[];
  readonly mode: ExecutionMode;
  readonly backendId: string;
  readonly securityClass: BackendDescriptor["securityClass"];
}

/**
 * Evaluates admission without throwing, so callers can record the decision
 * before acting on it.
 */
export function evaluateAdmission(input: AdmissionInput): AdmissionDecision {
  const reasons: RefusalReason[] = [];
  const { descriptor, grant, request, mode } = input;

  if (!input.availability.available) {
    reasons.push("backend-unavailable");
  }
  if (descriptor.platform !== process.platform) {
    reasons.push("platform-mismatch");
  }

  // Bindings that must hold in every mode: without them the command that runs
  // is not the command that was authorized.
  if (input.policyOutcome === null) {
    reasons.push("policy-decision-missing");
  } else if (input.policyOutcome === "denied") {
    reasons.push("policy-decision-denied");
  } else if (input.policyOutcome === "conditional") {
    reasons.push("policy-approval-outstanding");
  }
  if (
    input.policyFingerprint === null ||
    input.policyFingerprint !== request.policyDecisionFingerprint
  ) {
    reasons.push("policy-fingerprint-mismatch");
  }
  if (grant.grantId !== request.grantId || grant.workspaceId !== request.workspaceId) {
    reasons.push("grant-mismatch");
  }
  if (input.clock.now().valueOf() >= new Date(grant.expiresAt).valueOf()) {
    reasons.push("grant-expired");
  }
  const granted = grant.tools.find((tool) => tool.toolId === request.tool.toolId);
  if (
    granted === undefined ||
    (granted.digest !== null && granted.digest !== input.resolvedExecutableDigest)
  ) {
    reasons.push("executable-digest-mismatch");
  }
  if (!input.workspaceLeaseValid) {
    reasons.push("workspace-lease-invalid");
  }
  if (!input.workspacePathTrusted) {
    reasons.push("workspace-path-untrusted");
  }

  if (mode === "production") {
    if (!input.approvedBackendIds.includes(descriptor.backendId)) {
      reasons.push("backend-not-approved");
    }
    if (descriptor.securityClass !== "secure-enforcing") {
      reasons.push("backend-not-secure");
    }
    if (!descriptor.capabilities.filesystemIsolation) {
      reasons.push("filesystem-isolation-missing");
    }
    if (!descriptor.capabilities.processTreeControl) {
      reasons.push("process-tree-control-missing");
    }
    if (request.network.mode === "denied" && !descriptor.capabilities.networkDenial) {
      reasons.push("network-denial-unavailable");
    }
    // Only dimensions the request actually constrains are demanded, and only
    // genuine enforcement counts. Observed and estimated are not enforcement.
    for (const dimension of requiredQuotaDimensions(request.quotas, request.network)) {
      if (descriptor.capabilities.quotas[dimension] !== "enforced") {
        reasons.push("quota-not-enforced");
        break;
      }
    }
  }

  const unique = Object.freeze([...new Set(reasons)].sort());
  return Object.freeze({
    admitted: unique.length === 0,
    reasons: unique,
    mode,
    backendId: descriptor.backendId,
    securityClass: descriptor.securityClass,
  });
}

/** Throws a stable, secret-safe error when admission fails. */
export function assertAdmitted(decision: AdmissionDecision): void {
  if (decision.admitted) {
    return;
  }
  const code = selectErrorCode(decision);
  throw new ProcessBrokerError(code, refusalMessage(decision), {
    backendId: decision.backendId,
    securityClass: decision.securityClass,
    mode: decision.mode,
    reasons: decision.reasons,
  });
}

function selectErrorCode(decision: AdmissionDecision): "PRODUCTION_ISOLATION_REQUIRED" | "BACKEND_UNAVAILABLE" | "BACKEND_INSECURE" | "POLICY_DENIED" | "APPROVAL_REQUIRED" | "GRANT_EXPIRED" | "INVALID_GRANT" | "EXECUTABLE_DIGEST_MISMATCH" | "LEASE_INVALID" {
  const reasons = new Set(decision.reasons);
  if (reasons.has("policy-decision-denied")) {
    return "POLICY_DENIED";
  }
  if (reasons.has("policy-approval-outstanding")) {
    return "APPROVAL_REQUIRED";
  }
  if (reasons.has("grant-expired")) {
    return "GRANT_EXPIRED";
  }
  if (reasons.has("executable-digest-mismatch")) {
    return "EXECUTABLE_DIGEST_MISMATCH";
  }
  if (reasons.has("workspace-lease-invalid")) {
    return "LEASE_INVALID";
  }
  if (reasons.has("policy-decision-missing") || reasons.has("policy-fingerprint-mismatch") || reasons.has("grant-mismatch") || reasons.has("workspace-path-untrusted")) {
    return "INVALID_GRANT";
  }
  if (reasons.has("backend-unavailable")) {
    return "BACKEND_UNAVAILABLE";
  }
  if (decision.mode === "production") {
    return "PRODUCTION_ISOLATION_REQUIRED";
  }
  return "BACKEND_INSECURE";
}

function refusalMessage(decision: AdmissionDecision): string {
  if (decision.mode === "production") {
    return "Production execution requires an approved secure isolation backend and a valid, matching authorization.";
  }
  return "The execution request was not admitted.";
}
