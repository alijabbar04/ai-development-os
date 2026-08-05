/**
 * Fail-closed two-phase production admission.
 *
 * Static descriptors and operator allowlists are advisory filters. Actual
 * production authority requires module-private registration plus a single-use
 * preparation receipt bound to the exact execution.
 */

import { ProcessBrokerError } from "./errors.js";
import type {
  BackendAvailability,
  BackendDescriptor,
  ProductionSessionReceipt,
  SandboxBackend,
} from "./backend.js";
import type { ControlPlaneEndpointPolicy } from "./endpoint-policy.js";
import type { CapabilityGrant } from "./grant.js";
import {
  evaluateGrantContainment,
  type GrantContainmentDecision,
  type LeaseAuthoritySnapshot,
} from "./grant-containment.js";
import type { ProcessRequest } from "./request.js";
import { requiredQuotaDimensions } from "./quota.js";
import type { Clock } from "./time.js";
import {
  verifyAndConsumeProductionSessionReceipt,
  verifyProductionBackendRegistration,
  type ProductionBackendRegistration,
  type ProductionEvidenceRefusal,
  type SessionReceiptRefusal,
} from "./trusted-evidence.js";

export const EXECUTION_MODES = Object.freeze(["production", "development"] as const);
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const REFUSAL_REASONS = Object.freeze([
  "backend-unavailable",
  "backend-grant-invalid",
  "backend-not-approved",
  "backend-not-secure",
  "production-evidence-invalid",
  "platform-mismatch",
  "filesystem-isolation-missing",
  "process-tree-control-missing",
  "identity-isolation-missing",
  "profile-isolation-missing",
  "network-denial-unavailable",
  "controlled-egress-unavailable",
  "workload-network-unavailable",
  "endpoint-policy-invalid",
  "quota-not-enforced",
  "grant-expired",
  "grant-mismatch",
  "request-exceeds-grant",
  "policy-decision-missing",
  "policy-decision-denied",
  "policy-approval-outstanding",
  "policy-fingerprint-mismatch",
  "policy-approval-mismatch",
  "executable-digest-mismatch",
  "executable-identity-unbound",
  "workspace-lease-invalid",
  "workspace-path-untrusted",
] as const);
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export interface AdmissionInput {
  readonly mode: ExecutionMode;
  readonly backend: SandboxBackend;
  readonly descriptor: BackendDescriptor;
  readonly availability: BackendAvailability;
  readonly grantValidation: BackendAvailability;
  /** Additional operator filter. Never enforcement proof. */
  readonly approvedBackendIds: readonly string[];
  readonly productionRegistration: ProductionBackendRegistration | null;
  readonly controlPlaneEndpointPolicy: ControlPlaneEndpointPolicy | null;
  readonly grant: CapabilityGrant;
  readonly grantFingerprint: string;
  readonly request: ProcessRequest;
  readonly actualWorkingSubdirectory: string;
  readonly lease: LeaseAuthoritySnapshot;
  readonly clock: Clock;
  /** The policy outcome for this exact command. `null` means none was made. */
  readonly policyOutcome: "allowed" | "denied" | "conditional" | null;
  readonly policyFingerprint: string | null;
  readonly policyApprovalEvidenceRefs: readonly string[];
  /** Digest/reference of the image that will actually run. */
  readonly resolvedExecutableDigest: string | null;
  readonly resolvedImmutableReference: string | null;
  readonly workspacePathTrusted: boolean;
}

export interface AdmissionDecision {
  readonly admitted: boolean;
  readonly reasons: readonly RefusalReason[];
  readonly containment: GrantContainmentDecision;
  readonly productionEvidenceReason: ProductionEvidenceRefusal | null;
  readonly mode: ExecutionMode;
  readonly backendId: string;
  readonly securityClass: BackendDescriptor["securityClass"];
  readonly attestationFingerprint: string | null;
  readonly registrationFingerprint: string | null;
}

function endpointPolicyValid(input: AdmissionInput): boolean {
  const policy = input.controlPlaneEndpointPolicy;
  if (policy === null) {
    return input.grant.controlPlaneEndpointPolicyFingerprint === null;
  }
  const now = input.clock.now().valueOf();
  return (
    policy.fingerprint === input.grant.controlPlaneEndpointPolicyFingerprint &&
    policy.toolId === input.request.tool.toolId &&
    now >= new Date(policy.observedAt).valueOf() &&
    now < new Date(policy.expiresAt).valueOf()
  );
}

/** Evaluates pre-admission before any sandbox object or child exists. */
export function evaluateAdmission(input: AdmissionInput): AdmissionDecision {
  const reasons: RefusalReason[] = [];
  const { descriptor, grant, request, mode } = input;
  const containment = evaluateGrantContainment({
    grant,
    grantFingerprint: input.grantFingerprint,
    request,
    actualWorkingSubdirectory: input.actualWorkingSubdirectory,
    lease: input.lease,
    resolvedExecutableDigest: input.resolvedExecutableDigest,
    resolvedImmutableReference: input.resolvedImmutableReference,
    controlPlaneEndpointPolicyFingerprint:
      input.controlPlaneEndpointPolicy?.fingerprint ?? null,
  });

  if (!input.availability.available) reasons.push("backend-unavailable");
  if (descriptor.platform !== process.platform) reasons.push("platform-mismatch");
  if (!containment.contained) reasons.push("request-exceeds-grant");

  if (input.policyOutcome === null) {
    reasons.push("policy-decision-missing");
  } else if (input.policyOutcome === "denied") {
    reasons.push("policy-decision-denied");
  } else if (input.policyOutcome === "conditional") {
    reasons.push("policy-approval-outstanding");
  }
  if (
    input.policyFingerprint === null ||
    input.policyFingerprint !== request.policyDecisionFingerprint ||
    input.policyFingerprint !== grant.policyFingerprint
  ) {
    reasons.push("policy-fingerprint-mismatch");
  }
  const requestApprovals = new Set(request.approvalEvidenceRefs);
  const grantApprovals = new Set(grant.approvalEvidenceRefs);
  if (
    input.policyApprovalEvidenceRefs.length !== request.approvalEvidenceRefs.length ||
    !input.policyApprovalEvidenceRefs.every(
      (entry) => requestApprovals.has(entry) && grantApprovals.has(entry),
    ) ||
    !request.approvalEvidenceRefs.every((entry) =>
      input.policyApprovalEvidenceRefs.includes(entry),
    )
  ) {
    reasons.push("policy-approval-mismatch");
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
    (granted.digest !== null && granted.digest !== input.resolvedExecutableDigest) ||
    (granted.immutableReference !== null &&
      granted.immutableReference !== input.resolvedImmutableReference)
  ) {
    reasons.push("executable-digest-mismatch");
  }
  if (input.lease.state !== "active") reasons.push("workspace-lease-invalid");
  if (!input.workspacePathTrusted) reasons.push("workspace-path-untrusted");
  if (!endpointPolicyValid(input)) reasons.push("endpoint-policy-invalid");

  let productionEvidenceReason: ProductionEvidenceRefusal | null = null;
  let attestationFingerprint: string | null = null;
  let registrationFingerprint: string | null = null;

  if (mode === "production") {
    if (!input.grantValidation.available) reasons.push("backend-grant-invalid");
    if (
      input.resolvedExecutableDigest === null &&
      input.resolvedImmutableReference === null
    ) {
      reasons.push("executable-identity-unbound");
    }
    if (!input.approvedBackendIds.includes(descriptor.backendId)) {
      reasons.push("backend-not-approved");
    }
    if (descriptor.securityClass !== "secure-enforcing") reasons.push("backend-not-secure");
    if (!descriptor.capabilities.filesystemIsolation) {
      reasons.push("filesystem-isolation-missing");
    }
    if (!descriptor.capabilities.processTreeControl) {
      reasons.push("process-tree-control-missing");
    }
    if (!descriptor.capabilities.identityIsolation) {
      reasons.push("identity-isolation-missing");
    }
    if (!descriptor.capabilities.profileIsolation) {
      reasons.push("profile-isolation-missing");
    }
    if (request.network.mode !== "denied") {
      reasons.push("workload-network-unavailable");
    }
    if (
      descriptor.capabilities.networkBoundary !== "deny-all" &&
      descriptor.capabilities.networkBoundary !== "controlled-service-egress"
    ) {
      reasons.push("network-denial-unavailable");
    }
    if (
      input.controlPlaneEndpointPolicy !== null &&
      descriptor.capabilities.networkBoundary !== "controlled-service-egress"
    ) {
      reasons.push("controlled-egress-unavailable");
    }
    for (const dimension of requiredQuotaDimensions(request.quotas, request.network)) {
      if (descriptor.capabilities.quotas[dimension] !== "enforced") {
        reasons.push("quota-not-enforced");
        break;
      }
    }
    const evidence = verifyProductionBackendRegistration({
      registration: input.productionRegistration,
      backend: input.backend,
      descriptor,
      now: input.clock.now(),
      expectedEndpointPolicyFingerprint:
        input.controlPlaneEndpointPolicy?.fingerprint ?? null,
    });
    if (!evidence.verified) {
      reasons.push("production-evidence-invalid");
      productionEvidenceReason = evidence.reason;
    } else {
      attestationFingerprint = evidence.attestation?.fingerprint ?? null;
      registrationFingerprint = evidence.registrationFingerprint;
    }
  }

  const unique = Object.freeze([...new Set(reasons)].sort());
  return Object.freeze({
    admitted: unique.length === 0,
    reasons: unique,
    containment,
    productionEvidenceReason,
    mode,
    backendId: descriptor.backendId,
    securityClass: descriptor.securityClass,
    attestationFingerprint,
    registrationFingerprint,
  });
}

/** Throws a stable, secret-safe error when pre-admission fails. */
export function assertAdmitted(decision: AdmissionDecision): void {
  if (decision.admitted) return;
  const code = selectErrorCode(decision);
  throw new ProcessBrokerError(code, refusalMessage(decision), {
    backendId: decision.backendId,
    securityClass: decision.securityClass,
    mode: decision.mode,
    reasons: decision.reasons,
    containmentReasons: decision.containment.reasons,
    productionEvidenceReason: decision.productionEvidenceReason,
  });
}

export const FINAL_REFUSAL_REASONS = Object.freeze([
  "lease-invalidated",
  "grant-expired",
  "endpoint-policy-stale",
  "executable-drift",
  "session-receipt-invalid",
] as const);
export type FinalRefusalReason = (typeof FINAL_REFUSAL_REASONS)[number];

export interface FinalAdmissionDecision {
  readonly admitted: boolean;
  readonly reasons: readonly FinalRefusalReason[];
  readonly receiptReason: SessionReceiptRefusal | null;
}

/** Final check after secure preparation and immediately before spawn. */
export function evaluateFinalAdmission(input: {
  readonly mode: ExecutionMode;
  readonly registration: ProductionBackendRegistration | null;
  readonly receipt: ProductionSessionReceipt | null;
  readonly executionBindingFingerprint: string;
  readonly sandboxSessionFingerprint: string;
  readonly leaseValid: boolean;
  readonly grantExpiresAt: string;
  readonly endpointPolicyExpiresAt: string | null;
  readonly executableUnchanged: boolean;
  readonly clock: Clock;
}): FinalAdmissionDecision {
  const reasons: FinalRefusalReason[] = [];
  const now = input.clock.now().valueOf();
  if (!input.leaseValid) reasons.push("lease-invalidated");
  if (now >= new Date(input.grantExpiresAt).valueOf()) reasons.push("grant-expired");
  if (
    input.endpointPolicyExpiresAt !== null &&
    now >= new Date(input.endpointPolicyExpiresAt).valueOf()
  ) {
    reasons.push("endpoint-policy-stale");
  }
  if (!input.executableUnchanged) reasons.push("executable-drift");

  let receiptReason: SessionReceiptRefusal | null = null;
  if (input.mode === "production") {
    if (input.registration === null) {
      reasons.push("session-receipt-invalid");
      receiptReason = "session-receipt-registration-mismatch";
    } else {
      const receipt = verifyAndConsumeProductionSessionReceipt({
        receipt: input.receipt,
        registration: input.registration,
        executionBindingFingerprint: input.executionBindingFingerprint,
        sandboxSessionFingerprint: input.sandboxSessionFingerprint,
        now: input.clock.now(),
      });
      if (!receipt.verified) {
        reasons.push("session-receipt-invalid");
        receiptReason = receipt.reason;
      }
    }
  }
  const unique = Object.freeze([...new Set(reasons)].sort());
  return Object.freeze({ admitted: unique.length === 0, reasons: unique, receiptReason });
}

export function assertFinalAdmitted(decision: FinalAdmissionDecision): void {
  if (decision.admitted) return;
  throw new ProcessBrokerError(
    "PRODUCTION_ISOLATION_REQUIRED",
    "Final production admission evidence is absent, stale, or mismatched.",
    { reasons: decision.reasons, receiptReason: decision.receiptReason },
  );
}

function selectErrorCode(decision: AdmissionDecision):
  | "PRODUCTION_ISOLATION_REQUIRED"
  | "BACKEND_UNAVAILABLE"
  | "BACKEND_INSECURE"
  | "POLICY_DENIED"
  | "APPROVAL_REQUIRED"
  | "GRANT_EXPIRED"
  | "INVALID_GRANT"
  | "EXECUTABLE_DIGEST_MISMATCH"
  | "LEASE_INVALID" {
  const reasons = new Set(decision.reasons);
  if (reasons.has("policy-decision-denied")) return "POLICY_DENIED";
  if (reasons.has("policy-approval-outstanding")) return "APPROVAL_REQUIRED";
  if (reasons.has("grant-expired")) return "GRANT_EXPIRED";
  if (reasons.has("executable-digest-mismatch")) {
    return "EXECUTABLE_DIGEST_MISMATCH";
  }
  if (reasons.has("workspace-lease-invalid")) return "LEASE_INVALID";
  if (
    reasons.has("policy-decision-missing") ||
    reasons.has("policy-fingerprint-mismatch") ||
    reasons.has("policy-approval-mismatch") ||
    reasons.has("grant-mismatch") ||
    reasons.has("request-exceeds-grant") ||
    reasons.has("workspace-path-untrusted") ||
    reasons.has("endpoint-policy-invalid")
  ) {
    return "INVALID_GRANT";
  }
  if (reasons.has("backend-unavailable")) return "BACKEND_UNAVAILABLE";
  if (decision.mode === "production") return "PRODUCTION_ISOLATION_REQUIRED";
  return "BACKEND_INSECURE";
}

function refusalMessage(decision: AdmissionDecision): string {
  if (decision.mode === "production") {
    return "Production execution requires fresh trusted enforcement evidence and exact bounded authority.";
  }
  return "The execution request was not admitted.";
}
