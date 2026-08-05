/**
 * The sandbox backend contract.
 *
 * A backend is the thing that actually creates processes. Its validated
 * descriptor is advisory maximum capability, not enforcement proof. A
 * production broker additionally requires opaque first-party registration and
 * exact session evidence; a backend ID, descriptor, probe, or allowlist can
 * never mint that evidence.
 */

import { validation } from "@ai-dev-os/domain";
import { invalidConfiguration } from "./errors.js";
import { fingerprintOf } from "./fingerprint.js";
import type { BuiltEnvironment } from "./environment.js";
import type { CapabilityGrant } from "./grant.js";
import type { OutputStreamName } from "./output.js";
import type { ProcessRequest } from "./request.js";
import type { QuotaDimension, QuotaSupportMatrix } from "./quota.js";
import { QUOTA_DIMENSIONS, QUOTA_SUPPORT_LEVELS } from "./quota.js";
import type { ResolvedTool } from "./tool.js";

const { ensureBoolean, ensureEnum, ensureExactKeys, ensureRecord, ensureString } = validation;

export const BACKEND_DESCRIPTOR_SCHEMA_VERSION = 2 as const;

/**
 * How much isolation a backend actually provides.
 *
 * - `secure-enforcing`: the platform enforces the filesystem, process, and
 *   network boundary. Eligible for production.
 * - `constrained-incomplete`: real but partial containment. Never eligible
 *   for production, because "partial" is not a boundary against a hostile
 *   repository.
 * - `unsafe-development`: no security boundary at all.
 * - `unavailable`: the backend cannot run here.
 */
export const BACKEND_SECURITY_CLASSES = Object.freeze([
  "secure-enforcing",
  "constrained-incomplete",
  "unsafe-development",
  "unavailable",
] as const);
export type BackendSecurityClass = (typeof BACKEND_SECURITY_CLASSES)[number];

export const BACKEND_KINDS = Object.freeze([
  "same-user-subprocess",
  "windows-job-object",
  "linux-namespace",
  "macos-sandbox",
  "container",
  "virtual-machine",
] as const);
export type BackendKind = (typeof BACKEND_KINDS)[number];

export interface BackendCapabilities {
  /** The backend confines filesystem access to the granted paths. */
  readonly filesystemIsolation: boolean;
  /** The backend can terminate the entire process tree with certainty. */
  readonly processTreeControl: boolean;
  /** Exact network boundary the backend may be able to enforce. */
  readonly networkBoundary:
    | "unsupported"
    | "deny-all"
    | "controlled-service-egress";
  /** The backend runs the workload under a separate, lower-privileged identity. */
  readonly identityIsolation: boolean;
  /** The backend prevents the workload reading the invoking user's profile. */
  readonly profileIsolation: boolean;
  readonly quotas: QuotaSupportMatrix;
}

export interface BackendDescriptor {
  readonly schemaVersion: typeof BACKEND_DESCRIPTOR_SCHEMA_VERSION;
  readonly backendId: string;
  readonly kind: BackendKind;
  readonly platform: NodeJS.Platform;
  readonly securityClass: BackendSecurityClass;
  readonly capabilities: BackendCapabilities;
  readonly versionEvidence: string | null;
}

const CAPABILITY_KEYS = [
  "filesystemIsolation",
  "processTreeControl",
  "networkBoundary",
  "identityIsolation",
  "profileIsolation",
  "quotas",
] as const;

const DESCRIPTOR_KEYS = [
  "schemaVersion",
  "backendId",
  "kind",
  "platform",
  "securityClass",
  "capabilities",
  "versionEvidence",
] as const;

function parseQuotaMatrix(value: unknown, path: string): QuotaSupportMatrix {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, QUOTA_DIMENSIONS, path);
  const entries: Partial<Record<QuotaDimension, (typeof QUOTA_SUPPORT_LEVELS)[number]>> = {};
  for (const dimension of QUOTA_DIMENSIONS) {
    entries[dimension] = ensureEnum(
      record[dimension],
      `${path}.${dimension}`,
      QUOTA_SUPPORT_LEVELS,
    );
  }
  return Object.freeze(entries as Record<QuotaDimension, (typeof QUOTA_SUPPORT_LEVELS)[number]>);
}

export function parseBackendDescriptor(value: unknown, path = "backend"): BackendDescriptor {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, DESCRIPTOR_KEYS, path);
  validation.ensureSchemaVersion(
    record["schemaVersion"],
    `${path}.schemaVersion`,
    BACKEND_DESCRIPTOR_SCHEMA_VERSION,
  );
  const capabilityRecord = ensureRecord(record["capabilities"], `${path}.capabilities`);
  ensureExactKeys(capabilityRecord, CAPABILITY_KEYS, `${path}.capabilities`);
  const versionEvidence = record["versionEvidence"];
  const securityClass = ensureEnum(
    record["securityClass"],
    `${path}.securityClass`,
    BACKEND_SECURITY_CLASSES,
  );
  const capabilities: BackendCapabilities = Object.freeze({
    filesystemIsolation: ensureBoolean(
      capabilityRecord["filesystemIsolation"],
      `${path}.capabilities.filesystemIsolation`,
    ),
    processTreeControl: ensureBoolean(
      capabilityRecord["processTreeControl"],
      `${path}.capabilities.processTreeControl`,
    ),
    networkBoundary: ensureEnum(
      capabilityRecord["networkBoundary"],
      `${path}.capabilities.networkBoundary`,
      ["unsupported", "deny-all", "controlled-service-egress"] as const,
    ),
    identityIsolation: ensureBoolean(
      capabilityRecord["identityIsolation"],
      `${path}.capabilities.identityIsolation`,
    ),
    profileIsolation: ensureBoolean(
      capabilityRecord["profileIsolation"],
      `${path}.capabilities.profileIsolation`,
    ),
    quotas: parseQuotaMatrix(capabilityRecord["quotas"], `${path}.capabilities.quotas`),
  });

  // A descriptor cannot claim to be enforcing while admitting it does not
  // contain the filesystem or the process tree. This is checked here so the
  // contradiction is caught at the boundary rather than at admission.
  if (
    securityClass === "secure-enforcing" &&
    (!capabilities.filesystemIsolation || !capabilities.processTreeControl)
  ) {
    throw invalidConfiguration(
      "A backend cannot be classified secure-enforcing without filesystem isolation and process-tree control.",
      { backendId: String(record["backendId"] ?? "unknown") },
    );
  }

  return Object.freeze({
    schemaVersion: BACKEND_DESCRIPTOR_SCHEMA_VERSION,
    backendId: ensureString(record["backendId"], `${path}.backendId`, {
      maxLength: 64,
      pattern: /^[a-z][a-z0-9-]{0,63}$/,
      patternName: "backend identifier",
    }),
    kind: ensureEnum(record["kind"], `${path}.kind`, BACKEND_KINDS),
    platform: ensureString(record["platform"], `${path}.platform`, {
      maxLength: 32,
      pattern: /^[a-z0-9]+$/,
      patternName: "platform",
    }) as NodeJS.Platform,
    securityClass,
    capabilities,
    versionEvidence:
      versionEvidence === undefined || versionEvidence === null
        ? null
        : ensureString(versionEvidence, `${path}.versionEvidence`, { maxLength: 128 }),
  });
}

export function backendDescriptorFingerprint(descriptor: BackendDescriptor): string {
  return fingerprintOf(descriptor);
}

export interface BackendAvailability {
  readonly available: boolean;
  /** Stable reason code. Never a raw platform error string. */
  readonly reason:
    | "available"
    | "unsupported-platform"
    | "missing-privilege"
    | "missing-tooling"
    | "version-unsupported"
    | "not-implemented";
  readonly detail: string | null;
}

export function parseBackendAvailability(
  value: unknown,
  path = "availability",
): BackendAvailability {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["available", "reason", "detail"], path);
  const available = ensureBoolean(record["available"], `${path}.available`);
  const reason = ensureEnum(record["reason"], `${path}.reason`, [
    "available",
    "unsupported-platform",
    "missing-privilege",
    "missing-tooling",
    "version-unsupported",
    "not-implemented",
  ] as const);
  const detailValue = record["detail"];
  const detail =
    detailValue === undefined || detailValue === null
      ? null
      : ensureString(detailValue, `${path}.detail`, {
          maxLength: 128,
          pattern: /^[a-z][a-z0-9-]{0,127}$/,
          patternName: "stable backend detail code",
        });
  if (available !== (reason === "available")) {
    throw invalidConfiguration(
      "Backend availability and reason contradict each other.",
      { reason },
    );
  }
  return Object.freeze({ available, reason, detail });
}

/** Everything a backend needs to prepare an isolated execution context. */
export interface SandboxBinding {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly snapshotId: string | null;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly grant: CapabilityGrant;
  readonly grantFingerprint: string;
  readonly policyDecisionFingerprint: string;
  /** Body-free digest of the exact policy command subject. */
  readonly subjectFingerprint: string;
  /** Exact grant/request/lease/workspace/tool/attestation preparation binding. */
  readonly executionBindingFingerprint: string;
  readonly attestationFingerprint: string | null;
  /** Absolute path the workload may treat as its root. */
  readonly workspaceRoot: string;
  readonly expiresAt: string;
  readonly nonce: string;
}

/**
 * Serializable face of an opaque preparation receipt. These fields are safe
 * to audit but are not sufficient to forge a receipt: production verification
 * also requires module-private object identity.
 */
export interface ProductionSessionReceipt {
  readonly schemaVersion: 1;
  readonly registrationFingerprint: string;
  readonly executionBindingFingerprint: string;
  /** Body-free binding to the concrete prepared session returned by the backend. */
  readonly sandboxSessionFingerprint: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
}

export interface SandboxSession {
  readonly sessionId: string;
  readonly backendId: string;
  /** Workspace-scoped directories the environment builder should advertise. */
  readonly tempDir: string;
  readonly homeDir: string | null;
  readonly productionReceipt: ProductionSessionReceipt | null;
}

export interface BackendSpawnInput {
  readonly session: SandboxSession;
  readonly request: ProcessRequest;
  readonly tool: ResolvedTool;
  readonly argv: readonly string[];
  readonly environment: BuiltEnvironment;
  /** Absolute working directory, already validated and contained. */
  readonly workingDirectory: string;
}

export interface BackendOutputEvent {
  readonly stream: OutputStreamName;
  readonly chunk: Uint8Array;
}

export const TERMINATION_OUTCOMES = Object.freeze([
  "exited",
  "terminated",
  "termination-unconfirmed",
] as const);
export type TerminationOutcome = (typeof TERMINATION_OUTCOMES)[number];

export interface BackendTermination {
  readonly outcome: TerminationOutcome;
  /** Processes the backend confirmed it stopped, when it can count them. */
  readonly stoppedCount: number | null;
}

export interface BackendExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

/**
 * A running process owned by a backend.
 *
 * Ownership is single-writer: exactly one broker drives one handle. Output is
 * delivered through `onOutput`; the handle never buffers on its own, because
 * bounding is the broker's responsibility and duplicating it would allow
 * unbounded growth in whichever copy the caller forgot about.
 */
export interface BackendProcess {
  readonly pid: number | null;
  onOutput(listener: (event: BackendOutputEvent) => void): void;
  /** Resolves when the process itself exits, for any reason. */
  wait(): Promise<BackendExit>;
  /**
   * Stops the entire process tree. `graceMs` is the period allowed for a
   * polite stop before force. Idempotent.
   */
  terminateTree(graceMs: number): Promise<BackendTermination>;
  writeStdin(bytes: Uint8Array): Promise<void>;
  closeStdin(): Promise<void>;
}

export interface SandboxBackend {
  describe(): BackendDescriptor;
  probe(): Promise<BackendAvailability>;
  /** Rejects a grant this backend cannot honour, before anything is created. */
  validateGrant(grant: CapabilityGrant): BackendAvailability;
  prepare(binding: SandboxBinding): Promise<SandboxSession>;
  spawn(input: BackendSpawnInput): Promise<BackendProcess>;
  dispose(session: SandboxSession): Promise<void>;
  close(): Promise<void>;
}

/** A quota matrix in which the backend enforces nothing. */
export function noQuotaSupport(
  overrides: Partial<QuotaSupportMatrix> = {},
): QuotaSupportMatrix {
  const base: Partial<Record<QuotaDimension, (typeof QUOTA_SUPPORT_LEVELS)[number]>> = {};
  for (const dimension of QUOTA_DIMENSIONS) {
    base[dimension] = "unsupported";
  }
  return Object.freeze({
    ...(base as QuotaSupportMatrix),
    ...overrides,
  });
}
