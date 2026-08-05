/**
 * Exact request/grant/lease containment.
 *
 * This module answers one narrow question: can the request exercise more
 * authority than the immutable grant and live lease permit? It performs no
 * I/O and grants no authority by itself. The process broker evaluates it
 * immediately before admission and again after sandbox preparation.
 */

import type { CapabilityGrant } from "./grant.js";
import { grantAllowsOperation, grantAllowsTool, prefixCovers } from "./grant.js";
import type { ProcessRequest } from "./request.js";

export const GRANT_CONTAINMENT_REASONS = Object.freeze([
  "project-mismatch",
  "workspace-mismatch",
  "attempt-mismatch",
  "run-mismatch",
  "task-mismatch",
  "task-run-mismatch",
  "lease-id-mismatch",
  "lease-grant-mismatch",
  "lease-workspace-mismatch",
  "lease-attempt-mismatch",
  "lease-inactive",
  "lease-expiry-widened",
  "policy-grant-mismatch",
  "approval-evidence-widened",
  "command-operation-missing",
  "tool-not-granted",
  "working-directory-request-mismatch",
  "working-directory-outside-grant",
  "environment-not-granted",
  "environment-path-outside-grant",
  "credential-not-granted",
  "network-operation-missing",
  "network-widened",
  "endpoint-policy-mismatch",
  "quota-widened",
  "output-limit-widened",
  "deadline-widened",
] as const);

export type GrantContainmentReason = (typeof GRANT_CONTAINMENT_REASONS)[number];

export interface LeaseAuthoritySnapshot {
  readonly leaseId: string;
  readonly grantId: string;
  readonly grantFingerprint: string;
  readonly workspaceId: string;
  readonly attemptId: string;
  readonly state: "active" | "released" | "revoked" | "expired";
  readonly expiresAt: string;
  readonly version: number;
}

export interface GrantContainmentInput {
  readonly grant: CapabilityGrant;
  readonly grantFingerprint: string;
  readonly request: ProcessRequest;
  /** Canonical workspace-relative directory derived from the actual paths. */
  readonly actualWorkingSubdirectory: string;
  readonly lease: LeaseAuthoritySnapshot;
  readonly resolvedExecutableDigest: string | null;
  readonly resolvedImmutableReference: string | null;
  readonly controlPlaneEndpointPolicyFingerprint: string | null;
}

export interface GrantContainmentDecision {
  readonly contained: boolean;
  readonly reasons: readonly GrantContainmentReason[];
}

function optionalLimitContained(requested: number | null, granted: number | null): boolean {
  if (granted === null) {
    return true;
  }
  return requested !== null && requested <= granted;
}

function networkContained(
  requested: ProcessRequest["network"],
  granted: CapabilityGrant["network"],
): boolean {
  if (requested.mode === "denied") {
    return true;
  }
  if (requested.mode === "loopback-only") {
    return granted.mode === "loopback-only";
  }
  if (granted.mode !== "allowlist") {
    return false;
  }
  const grantedDomains = new Set(granted.egressDomains);
  return requested.egressDomains.every((domain) => grantedDomains.has(domain));
}

/** Returns every widening reason in stable lexical order. */
export function evaluateGrantContainment(
  input: GrantContainmentInput,
): GrantContainmentDecision {
  const { grant, request, lease } = input;
  const reasons: GrantContainmentReason[] = [];

  if (request.projectId !== grant.projectId) reasons.push("project-mismatch");
  if (request.workspaceId !== grant.workspaceId) reasons.push("workspace-mismatch");
  if (request.attemptId !== grant.attemptId) reasons.push("attempt-mismatch");
  if (request.trace.runId !== grant.runId) reasons.push("run-mismatch");
  if (request.trace.taskId !== grant.taskId) reasons.push("task-mismatch");
  if (
    request.trace.taskRunId !== null &&
    request.trace.taskRunId !== grant.attemptId
  ) {
    reasons.push("task-run-mismatch");
  }

  if (request.workspaceLeaseId !== lease.leaseId) reasons.push("lease-id-mismatch");
  if (
    request.grantId !== grant.grantId ||
    lease.grantId !== grant.grantId ||
    lease.grantFingerprint !== input.grantFingerprint
  ) {
    reasons.push("lease-grant-mismatch");
  }
  if (lease.workspaceId !== grant.workspaceId) reasons.push("lease-workspace-mismatch");
  if (lease.attemptId !== grant.attemptId) reasons.push("lease-attempt-mismatch");
  if (lease.state !== "active") reasons.push("lease-inactive");
  if (new Date(lease.expiresAt).valueOf() > new Date(grant.expiresAt).valueOf()) {
    reasons.push("lease-expiry-widened");
  }

  if (
    request.policyDecisionFingerprint !== grant.policyFingerprint
  ) {
    reasons.push("policy-grant-mismatch");
  }
  const grantedApprovals = new Set(grant.approvalEvidenceRefs);
  if (!request.approvalEvidenceRefs.every((entry) => grantedApprovals.has(entry))) {
    reasons.push("approval-evidence-widened");
  }
  if (!grantAllowsOperation(grant, "command-execution")) {
    reasons.push("command-operation-missing");
  }
  if (
    !grantAllowsTool(
      grant,
      request.tool.toolId,
      input.resolvedExecutableDigest,
      input.resolvedImmutableReference,
    )
  ) {
    reasons.push("tool-not-granted");
  }

  const workingDirectory = input.actualWorkingSubdirectory;
  if (
    request.workingSubdirectory !== null &&
    request.workingSubdirectory !== workingDirectory
  ) {
    reasons.push("working-directory-request-mismatch");
  }
  if (
    !prefixCovers(grant.readablePrefixes, workingDirectory) &&
    !prefixCovers(grant.writablePrefixes, workingDirectory)
  ) {
    reasons.push("working-directory-outside-grant");
  }

  const grantedEnvironmentNames = new Set(grant.environmentNames);
  if (!request.environment.every((binding) => grantedEnvironmentNames.has(binding.name))) {
    reasons.push("environment-not-granted");
  }
  if (
    !request.environment.every(
      (binding) =>
        binding.kind !== "workspace-path" ||
        prefixCovers(grant.readablePrefixes, binding.value) ||
        prefixCovers(grant.writablePrefixes, binding.value),
    )
  ) {
    reasons.push("environment-path-outside-grant");
  }
  const grantedCredentialRefs = new Set(grant.credentialRefFingerprints);
  if (
    !request.environment.every(
      (binding) =>
        binding.kind !== "secret" ||
        grantedCredentialRefs.has(binding.secretRefFingerprint),
    )
  ) {
    reasons.push("credential-not-granted");
  }

  if (
    request.network.mode !== "denied" &&
    !grantAllowsOperation(grant, "network-access")
  ) {
    reasons.push("network-operation-missing");
  }
  if (!networkContained(request.network, grant.network)) {
    reasons.push("network-widened");
  }
  if (
    grant.controlPlaneEndpointPolicyFingerprint !==
    input.controlPlaneEndpointPolicyFingerprint
  ) {
    reasons.push("endpoint-policy-mismatch");
  }

  const requested = request.quotas;
  const granted = grant.quotas;
  if (
    requested.wallClockMs > granted.wallClockMs ||
    requested.outputBytes > granted.outputBytes ||
    !optionalLimitContained(requested.cpuTimeMs, granted.cpuTimeMs) ||
    !optionalLimitContained(requested.memoryBytes, granted.memoryBytes) ||
    !optionalLimitContained(requested.processCount, granted.processCount) ||
    !optionalLimitContained(requested.diskBytes, granted.diskBytes) ||
    !optionalLimitContained(requested.fileCount, granted.fileCount)
  ) {
    reasons.push("quota-widened");
  }
  if (
    request.outputLimits.maxCombinedBytes > requested.outputBytes ||
    request.outputLimits.maxCombinedBytes > granted.outputBytes ||
    request.outputLimits.maxStreamBytes > granted.outputBytes
  ) {
    reasons.push("output-limit-widened");
  }

  if (request.deadline !== null) {
    const deadline = new Date(request.deadline).valueOf();
    if (
      deadline > new Date(grant.expiresAt).valueOf() ||
      deadline > new Date(lease.expiresAt).valueOf()
    ) {
      reasons.push("deadline-widened");
    }
  }

  const unique = Object.freeze([...new Set(reasons)].sort());
  return Object.freeze({ contained: unique.length === 0, reasons: unique });
}
