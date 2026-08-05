/**
 * Package-private production authority.
 *
 * This file is intentionally not a package export. First-party backend
 * factories may import it by relative path; configuration, JSON, and ordinary
 * package consumers cannot obtain a mint through the public export map.
 * WeakMap membership and backend object identity are the runtime authority.
 */

import type {
  BackendDescriptor,
  ProductionSessionReceipt,
  SandboxBackend,
} from "./backend.js";
import { backendDescriptorFingerprint } from "./backend.js";
import {
  ENFORCEMENT_BOUNDARIES,
  parseEnforcementAttestation,
  projectEnforcementAttestation,
  type EnforcementAttestation,
  type SecureExecutionProjection,
} from "./attestation.js";
import { fingerprintOf } from "./fingerprint.js";
import { invalidConfiguration } from "./errors.js";
import { QUOTA_DIMENSIONS } from "./quota.js";

declare const registrationBrand: unique symbol;

/** Opaque type accepted by ProcessBrokerOptions; not structurally mintable. */
export interface ProductionBackendRegistration {
  readonly [registrationBrand]: true;
  readonly attestation: EnforcementAttestation;
  readonly registrationFingerprint: string;
}

export type ProductionEvidenceRefusal =
  | "registration-missing"
  | "registration-forged"
  | "registration-test-only"
  | "registration-invalidated"
  | "registration-backend-mismatch"
  | "descriptor-drift"
  | "attestation-backend-mismatch"
  | "attestation-platform-mismatch"
  | "attestation-architecture-mismatch"
  | "attestation-stale"
  | "attestation-corpus-incomplete"
  | "attestation-boundary-incomplete"
  | "attestation-helper-unbound"
  | "attestation-quota-mismatch"
  | "endpoint-policy-mismatch";

interface RegistrationRecord {
  readonly backend: SandboxBackend;
  readonly descriptorFingerprint: string;
  readonly purpose: "production" | "test";
  invalidated: boolean;
}

const registrations = new WeakMap<object, RegistrationRecord>();

export interface IssueProductionRegistrationInput {
  readonly backend: SandboxBackend;
  readonly descriptor: BackendDescriptor;
  readonly attestation: EnforcementAttestation;
  readonly purpose: "production" | "test";
}

/** Package-private issuer for reviewed first-party composition and internal tests. */
export function issueProductionBackendRegistration(
  input: IssueProductionRegistrationInput,
): ProductionBackendRegistration {
  const attestation = parseEnforcementAttestation(input.attestation);
  const registration = Object.freeze({
    attestation,
    registrationFingerprint: fingerprintOf({
      version: 1,
      backendId: attestation.backendId,
      factoryId: attestation.backendFactoryId,
      attestationFingerprint: attestation.fingerprint,
      descriptorFingerprint: backendDescriptorFingerprint(input.descriptor),
    }),
  }) as ProductionBackendRegistration;
  registrations.set(registration, {
    backend: input.backend,
    descriptorFingerprint: backendDescriptorFingerprint(input.descriptor),
    purpose: input.purpose,
    invalidated: false,
  });
  return registration;
}

export interface VerifyProductionRegistrationInput {
  readonly registration: ProductionBackendRegistration | null;
  readonly backend: SandboxBackend;
  readonly descriptor: BackendDescriptor;
  readonly now: Date;
  readonly expectedEndpointPolicyFingerprint: string | null;
}

export interface ProductionRegistrationVerification {
  readonly verified: boolean;
  readonly reason: ProductionEvidenceRefusal | null;
  readonly attestation: EnforcementAttestation | null;
  readonly registrationFingerprint: string | null;
}

function architectureForCurrentProcess(): "x64" | "arm64" | null {
  if (process.arch === "x64" || process.arch === "arm64") {
    return process.arch;
  }
  return null;
}

function refused(reason: ProductionEvidenceRefusal): ProductionRegistrationVerification {
  return Object.freeze({
    verified: false,
    reason,
    attestation: null,
    registrationFingerprint: null,
  });
}

export function verifyProductionBackendRegistration(
  input: VerifyProductionRegistrationInput,
): ProductionRegistrationVerification {
  if (input.registration === null) return refused("registration-missing");
  const record = registrations.get(input.registration as object);
  if (record === undefined) return refused("registration-forged");
  if (record.purpose !== "production") return refused("registration-test-only");
  if (record.invalidated) return refused("registration-invalidated");
  if (record.backend !== input.backend) return refused("registration-backend-mismatch");
  if (
    record.descriptorFingerprint !== backendDescriptorFingerprint(input.descriptor)
  ) {
    return refused("descriptor-drift");
  }

  const attestation = input.registration.attestation;
  if (
    attestation.backendId !== input.descriptor.backendId ||
    attestation.descriptorFingerprint !== record.descriptorFingerprint
  ) {
    return refused("attestation-backend-mismatch");
  }
  if (
    attestation.platform.os !== process.platform ||
    input.descriptor.platform !== process.platform
  ) {
    return refused("attestation-platform-mismatch");
  }
  const architecture = architectureForCurrentProcess();
  if (architecture === null || attestation.platform.architecture !== architecture) {
    return refused("attestation-architecture-mismatch");
  }
  const now = input.now.valueOf();
  if (
    now < new Date(attestation.observedAt).valueOf() ||
    now >= new Date(attestation.expiresAt).valueOf()
  ) {
    return refused("attestation-stale");
  }
  if (
    attestation.escapeCorpus.result !== "passed" ||
    !attestation.escapeCorpus.positiveControlsPassed ||
    attestation.escapeCorpus.fingerprint === null ||
    attestation.escapeCorpus.testCount === 0
  ) {
    return refused("attestation-corpus-incomplete");
  }
  const requiredBoundaries = ENFORCEMENT_BOUNDARIES.filter(
    (boundary) =>
      boundary !== "controlled-egress" ||
      input.expectedEndpointPolicyFingerprint !== null,
  );
  if (
    !requiredBoundaries.every(
      (boundary) => attestation.boundaries[boundary] === "enforced",
    )
  ) {
    return refused("attestation-boundary-incomplete");
  }
  if (
    attestation.helper.sourceDigest === null ||
    attestation.helper.binaryDigest === null ||
    attestation.helper.buildDigest === null
  ) {
    return refused("attestation-helper-unbound");
  }
  if (
    QUOTA_DIMENSIONS.some(
      (dimension) =>
        attestation.quotas[dimension] !== input.descriptor.capabilities.quotas[dimension],
    )
  ) {
    return refused("attestation-quota-mismatch");
  }
  if (
    attestation.endpointPolicyFingerprint !==
    input.expectedEndpointPolicyFingerprint
  ) {
    return refused("endpoint-policy-mismatch");
  }
  return Object.freeze({
    verified: true,
    reason: null,
    attestation,
    registrationFingerprint: input.registration.registrationFingerprint,
  });
}

/**
 * Publicly callable, non-authorizing routing projection. The opaque token,
 * backend object identity, descriptor, current host, and freshness are all
 * reverified before a secure level can be emitted.
 */
export function projectVerifiedProductionRegistration(
  input: VerifyProductionRegistrationInput,
): SecureExecutionProjection | null {
  const verification = verifyProductionBackendRegistration(input);
  if (!verification.verified || verification.attestation === null) return null;
  const advisory = projectEnforcementAttestation(verification.attestation);
  return Object.freeze({
    ...advisory,
    level: "secure-enforcing" as const,
    verifiedAt: input.now.toISOString(),
  });
}

export function invalidateProductionBackendRegistration(
  registration: ProductionBackendRegistration | null,
): void {
  if (registration === null) return;
  const record = registrations.get(registration as object);
  if (record !== undefined) record.invalidated = true;
}

interface ReceiptRecord {
  readonly registration: ProductionBackendRegistration;
  readonly executionBindingFingerprint: string;
  readonly sandboxSessionFingerprint: string;
  used: boolean;
}

const receipts = new WeakMap<object, ReceiptRecord>();
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_SESSION_RECEIPT_VALIDITY_MS = 300_000;

export interface IssueProductionSessionReceiptInput {
  readonly registration: ProductionBackendRegistration;
  readonly executionBindingFingerprint: string;
  readonly sandboxSessionFingerprint: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
}

/** Package-private issuer used only after a trusted backend securely prepares. */
export function issueProductionSessionReceipt(
  input: IssueProductionSessionReceiptInput,
): ProductionSessionReceipt {
  const registration = registrations.get(input.registration as object);
  if (registration === undefined) {
    throw invalidConfiguration("A session receipt requires a registered backend.");
  }
  if (registration.purpose !== "production" || registration.invalidated) {
    throw invalidConfiguration("A session receipt requires active production evidence.");
  }
  if (!DIGEST_PATTERN.test(input.executionBindingFingerprint)) {
    throw invalidConfiguration("A session receipt requires a valid binding fingerprint.");
  }
  if (!DIGEST_PATTERN.test(input.sandboxSessionFingerprint)) {
    throw invalidConfiguration("A session receipt requires a valid sandbox fingerprint.");
  }
  if (!NONCE_PATTERN.test(input.nonce)) {
    throw invalidConfiguration("A session receipt requires a valid nonce.");
  }
  const issuedAt = Date.parse(input.issuedAt);
  const expiresAt = Date.parse(input.expiresAt);
  const attestationExpiresAt = Date.parse(input.registration.attestation.expiresAt);
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_SESSION_RECEIPT_VALIDITY_MS ||
    expiresAt > attestationExpiresAt
  ) {
    throw invalidConfiguration(
      "A session receipt requires a bounded lifetime within its attestation.",
    );
  }
  const receipt: ProductionSessionReceipt = Object.freeze({
    schemaVersion: 1 as const,
    registrationFingerprint: input.registration.registrationFingerprint,
    executionBindingFingerprint: input.executionBindingFingerprint,
    sandboxSessionFingerprint: input.sandboxSessionFingerprint,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    nonce: input.nonce,
  });
  receipts.set(receipt, {
    registration: input.registration,
    executionBindingFingerprint: input.executionBindingFingerprint,
    sandboxSessionFingerprint: input.sandboxSessionFingerprint,
    used: false,
  });
  return receipt;
}

export type SessionReceiptRefusal =
  | "session-receipt-missing"
  | "session-receipt-forged"
  | "session-receipt-replayed"
  | "session-receipt-registration-invalid"
  | "session-receipt-registration-mismatch"
  | "session-receipt-binding-mismatch"
  | "session-receipt-sandbox-mismatch"
  | "session-receipt-invalid"
  | "session-receipt-stale";

export function verifyAndConsumeProductionSessionReceipt(input: {
  readonly receipt: ProductionSessionReceipt | null;
  readonly registration: ProductionBackendRegistration;
  readonly executionBindingFingerprint: string;
  readonly sandboxSessionFingerprint: string;
  readonly now: Date;
}): { readonly verified: boolean; readonly reason: SessionReceiptRefusal | null } {
  if (input.receipt === null) {
    return Object.freeze({ verified: false, reason: "session-receipt-missing" });
  }
  const record = receipts.get(input.receipt as object);
  if (record === undefined) {
    return Object.freeze({ verified: false, reason: "session-receipt-forged" });
  }
  if (record.used) {
    return Object.freeze({ verified: false, reason: "session-receipt-replayed" });
  }
  record.used = true;
  const registration = registrations.get(input.registration as object);
  if (
    registration === undefined ||
    registration.purpose !== "production" ||
    registration.invalidated
  ) {
    return Object.freeze({
      verified: false,
      reason: "session-receipt-registration-invalid",
    });
  }
  if (
    record.registration !== input.registration ||
    input.receipt.registrationFingerprint !== input.registration.registrationFingerprint
  ) {
    return Object.freeze({
      verified: false,
      reason: "session-receipt-registration-mismatch",
    });
  }
  if (
    record.executionBindingFingerprint !== input.executionBindingFingerprint ||
    input.receipt.executionBindingFingerprint !== input.executionBindingFingerprint
  ) {
    return Object.freeze({ verified: false, reason: "session-receipt-binding-mismatch" });
  }
  if (
    record.sandboxSessionFingerprint !== input.sandboxSessionFingerprint ||
    input.receipt.sandboxSessionFingerprint !== input.sandboxSessionFingerprint
  ) {
    return Object.freeze({ verified: false, reason: "session-receipt-sandbox-mismatch" });
  }
  const now = input.now.valueOf();
  const issuedAt = Date.parse(input.receipt.issuedAt);
  const expiresAt = Date.parse(input.receipt.expiresAt);
  if (
    input.receipt.schemaVersion !== 1 ||
    !DIGEST_PATTERN.test(input.receipt.registrationFingerprint) ||
    !DIGEST_PATTERN.test(input.receipt.executionBindingFingerprint) ||
    !DIGEST_PATTERN.test(input.receipt.sandboxSessionFingerprint) ||
    !NONCE_PATTERN.test(input.receipt.nonce) ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_SESSION_RECEIPT_VALIDITY_MS
  ) {
    return Object.freeze({ verified: false, reason: "session-receipt-invalid" });
  }
  if (
    now < issuedAt ||
    now >= expiresAt
  ) {
    return Object.freeze({ verified: false, reason: "session-receipt-stale" });
  }
  return Object.freeze({ verified: true, reason: null });
}

/** Body-free identity of the exact prepared session returned to the broker. */
export function sandboxSessionFingerprint(input: {
  readonly sessionId: string;
  readonly backendId: string;
  readonly tempDir: string;
  readonly homeDir: string | null;
}): string {
  return fingerprintOf({
    version: 1,
    sessionId: input.sessionId,
    backendId: input.backendId,
    tempDirFingerprint: fingerprintOf(input.tempDir),
    homeDirFingerprint: input.homeDir === null ? null : fingerprintOf(input.homeDir),
  });
}
