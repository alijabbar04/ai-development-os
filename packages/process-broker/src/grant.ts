/**
 * Capability grants and execution leases.
 *
 * A grant is the immutable statement of what one attempt may do: which paths
 * it may read and write, which tools it may run, what network it may reach,
 * and until when. A lease is the live, revocable right to act on that grant.
 *
 * Validity is checked immediately before every side effect, never once at the
 * start. An expired or revoked lease stops new work and cancels work already
 * running.
 *
 * Stage 8 deliberately does not persist leases or run a recovery loop. It
 * returns records and hooks; the durable scheduler owns their lifetime.
 */

import { validation } from "@ai-dev-os/domain";
import { ProcessBrokerError, invalidRequest } from "./errors.js";
import { fingerprintOf } from "./fingerprint.js";
import type { Clock } from "./time.js";
import { parseNetworkPolicy, parseProcessQuotas, type NetworkPolicy, type ProcessQuotas } from "./quota.js";

const { ensureArray, ensureExactKeys, ensureRecord, ensureString, ensureTimestamp } = validation;

export const GRANT_SCHEMA_VERSION = 1 as const;

export const GRANT_OPERATIONS = Object.freeze([
  "workspace-read",
  "workspace-write",
  "command-execution",
  "network-access",
  "git-read",
  "git-commit",
  "cleanup",
] as const);
export type GrantOperation = (typeof GRANT_OPERATIONS)[number];

export const MAX_PATH_PREFIXES = 64;
export const MAX_GRANT_TOOLS = 32;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NONCE_PATTERN = /^[a-f0-9]{32}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function ensureId(value: unknown, path: string): string {
  return ensureString(value, path, { maxLength: 128, pattern: ID_PATTERN, patternName: "identifier" });
}

function ensureNullableId(value: unknown, path: string): string | null {
  return value === undefined || value === null ? null : ensureId(value, path);
}

/**
 * A workspace-relative path prefix. Prefixes are normalized to forward slashes
 * with no leading or trailing separator, and `.`/`..` are rejected outright,
 * so a prefix can never widen the grant through traversal.
 */
function ensurePathPrefix(value: unknown, path: string): string {
  const text = ensureString(value, path, { minLength: 0, maxLength: 1_024 });
  if (text.length === 0) {
    return "";
  }
  if (text.includes("\\")) {
    throw invalidRequest("A path prefix must use forward slashes.", { field: path });
  }
  if (text.startsWith("/") || text.endsWith("/")) {
    throw invalidRequest("A path prefix must not start or end with a separator.", { field: path });
  }
  for (const segment of text.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw invalidRequest("A path prefix contains an empty or traversing segment.", {
        field: path,
      });
    }
  }
  return text;
}

function ensurePrefixList(value: unknown, path: string): readonly string[] {
  const entries = ensureArray(value, path, MAX_PATH_PREFIXES);
  const prefixes = entries.map((entry, index) => ensurePathPrefix(entry, `${path}[${index}]`));
  return Object.freeze([...new Set(prefixes)].sort());
}

export interface GrantedTool {
  readonly toolId: string;
  readonly digest: string | null;
}

export interface CapabilityGrant {
  readonly schemaVersion: typeof GRANT_SCHEMA_VERSION;
  readonly grantId: string;
  readonly projectId: string;
  readonly runId: string | null;
  readonly taskId: string | null;
  readonly attemptId: string;
  readonly snapshotId: string | null;
  readonly workspaceId: string;
  readonly operations: readonly GrantOperation[];
  readonly readablePrefixes: readonly string[];
  readonly writablePrefixes: readonly string[];
  readonly tools: readonly GrantedTool[];
  readonly network: NetworkPolicy;
  readonly quotas: ProcessQuotas;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly policyFingerprint: string;
  readonly approvalEvidenceRefs: readonly string[];
}

const GRANT_KEYS = [
  "schemaVersion",
  "grantId",
  "projectId",
  "runId",
  "taskId",
  "attemptId",
  "snapshotId",
  "workspaceId",
  "operations",
  "readablePrefixes",
  "writablePrefixes",
  "tools",
  "network",
  "quotas",
  "issuedAt",
  "expiresAt",
  "nonce",
  "policyFingerprint",
  "approvalEvidenceRefs",
] as const;

export function parseCapabilityGrant(value: unknown, path = "grant"): CapabilityGrant {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, GRANT_KEYS, path);
  validation.ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, GRANT_SCHEMA_VERSION);

  const operations = validation.ensureEnumArray(
    record["operations"],
    `${path}.operations`,
    GRANT_OPERATIONS,
    GRANT_OPERATIONS.length,
  );
  if (operations.length === 0) {
    throw invalidRequest("A grant must permit at least one operation.", { field: path });
  }

  const rawTools = ensureArray(record["tools"], `${path}.tools`, MAX_GRANT_TOOLS);
  const tools = rawTools.map((entry, index) => {
    const toolRecord = ensureRecord(entry, `${path}.tools[${index}]`);
    ensureExactKeys(toolRecord, ["toolId", "digest"], `${path}.tools[${index}]`);
    const digest = toolRecord["digest"];
    return Object.freeze({
      toolId: ensureString(toolRecord["toolId"], `${path}.tools[${index}].toolId`, {
        maxLength: 64,
        pattern: /^[a-z][a-z0-9._-]{0,63}$/,
        patternName: "tool identifier",
      }),
      digest:
        digest === undefined || digest === null
          ? null
          : ensureString(digest, `${path}.tools[${index}].digest`, {
              minLength: 64,
              maxLength: 64,
              pattern: DIGEST_PATTERN,
              patternName: "sha-256 digest",
            }),
    });
  });
  const toolIds = tools.map((tool) => tool.toolId);
  if (new Set(toolIds).size !== toolIds.length) {
    throw invalidRequest("A grant lists the same tool twice.", { field: `${path}.tools` });
  }

  const issuedAt = ensureTimestamp(record["issuedAt"], `${path}.issuedAt`);
  const expiresAt = ensureTimestamp(record["expiresAt"], `${path}.expiresAt`);
  if (new Date(expiresAt).valueOf() <= new Date(issuedAt).valueOf()) {
    throw invalidRequest("A grant must expire after it was issued.", { field: path });
  }

  const evidenceRefs = ensureArray(record["approvalEvidenceRefs"], `${path}.approvalEvidenceRefs`, 32);

  return Object.freeze({
    schemaVersion: GRANT_SCHEMA_VERSION,
    grantId: ensureId(record["grantId"], `${path}.grantId`),
    projectId: ensureId(record["projectId"], `${path}.projectId`),
    runId: ensureNullableId(record["runId"], `${path}.runId`),
    taskId: ensureNullableId(record["taskId"], `${path}.taskId`),
    attemptId: ensureId(record["attemptId"], `${path}.attemptId`),
    snapshotId: ensureNullableId(record["snapshotId"], `${path}.snapshotId`),
    workspaceId: ensureId(record["workspaceId"], `${path}.workspaceId`),
    operations,
    readablePrefixes: ensurePrefixList(record["readablePrefixes"], `${path}.readablePrefixes`),
    writablePrefixes: ensurePrefixList(record["writablePrefixes"], `${path}.writablePrefixes`),
    tools: Object.freeze([...tools].sort((a, b) => (a.toolId < b.toolId ? -1 : 1))),
    network: parseNetworkPolicy(record["network"], `${path}.network`),
    quotas: parseProcessQuotas(record["quotas"], `${path}.quotas`),
    issuedAt,
    expiresAt,
    nonce: ensureString(record["nonce"], `${path}.nonce`, {
      minLength: 32,
      maxLength: 32,
      pattern: NONCE_PATTERN,
      patternName: "128-bit hexadecimal nonce",
    }),
    policyFingerprint: ensureString(record["policyFingerprint"], `${path}.policyFingerprint`, {
      minLength: 64,
      maxLength: 64,
      pattern: DIGEST_PATTERN,
      patternName: "sha-256 digest",
    }),
    approvalEvidenceRefs: Object.freeze(
      [
        ...new Set(
          evidenceRefs.map((entry, index) =>
            ensureId(entry, `${path}.approvalEvidenceRefs[${index}]`),
          ),
        ),
      ].sort(),
    ),
  });
}

/** A stable digest over the grant's meaning. Used to bind grant to decision. */
export function grantFingerprint(grant: CapabilityGrant): string {
  return fingerprintOf(grant);
}

export function grantAllowsOperation(grant: CapabilityGrant, operation: GrantOperation): boolean {
  return grant.operations.includes(operation);
}

/** True when `relativePath` is inside one of the granted prefixes. */
export function prefixCovers(prefixes: readonly string[], relativePath: string): boolean {
  for (const prefix of prefixes) {
    if (prefix === "") {
      return true;
    }
    if (relativePath === prefix || relativePath.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

export function grantAllowsTool(grant: CapabilityGrant, toolId: string, digest: string | null): boolean {
  const entry = grant.tools.find((tool) => tool.toolId === toolId);
  if (entry === undefined) {
    return false;
  }
  if (entry.digest === null) {
    return true;
  }
  return entry.digest === digest;
}

// -- leases -----------------------------------------------------------------

export const LEASE_STATES = Object.freeze(["active", "released", "revoked", "expired"] as const);
export type LeaseState = (typeof LEASE_STATES)[number];

export interface LeaseRecord {
  readonly leaseId: string;
  readonly grantId: string;
  readonly workspaceId: string;
  readonly attemptId: string;
  readonly state: LeaseState;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly releasedAt: string | null;
  readonly version: number;
}

export interface ExecutionLease {
  readonly leaseId: string;
  readonly grant: CapabilityGrant;
  /** Current record. Immutable; a new object is produced on every change. */
  record(): LeaseRecord;
  /**
   * Throws when the lease can no longer authorize a side effect. Callers run
   * this immediately before acting, not once at the beginning.
   */
  assertValid(): void;
  isValid(): boolean;
  renew(expiresAt: string): void;
  revoke(): void;
  /** Idempotent. */
  release(): void;
  /** Invoked when the lease stops being valid, so live work can be cancelled. */
  onInvalidated(listener: () => void): () => void;
}

export interface LeaseOptions {
  readonly leaseId: string;
  readonly grant: CapabilityGrant;
  readonly clock: Clock;
  readonly expiresAt?: string;
  /** Renewal is refused unless the issuer explicitly allowed it. */
  readonly renewable?: boolean;
}

export function createExecutionLease(options: LeaseOptions): ExecutionLease {
  const leaseId = ensureId(options.leaseId, "leaseId");
  const grant = options.grant;
  const clock = options.clock;
  const renewable = options.renewable ?? false;
  let expiresAt = options.expiresAt === undefined ? grant.expiresAt : ensureTimestamp(options.expiresAt, "expiresAt");
  if (new Date(expiresAt).valueOf() > new Date(grant.expiresAt).valueOf()) {
    throw invalidRequest("A lease cannot outlive its grant.", { leaseId });
  }
  const acquiredAt = clock.now().toISOString();
  let state: LeaseState = "active";
  let releasedAt: string | null = null;
  let version = 1;
  const listeners = new Set<() => void>();

  function expiredNow(): boolean {
    return clock.now().valueOf() >= new Date(expiresAt).valueOf();
  }

  function notify(): void {
    for (const listener of [...listeners]) {
      listeners.delete(listener);
      try {
        listener();
      } catch {
        // A listener failure must never leave the lease in a partial state or
        // prevent other listeners from running.
      }
    }
  }

  function settle(next: LeaseState): void {
    if (state !== "active") {
      return;
    }
    state = next;
    releasedAt = clock.now().toISOString();
    version += 1;
    notify();
  }

  return Object.freeze({
    leaseId,
    grant,
    record(): LeaseRecord {
      const effective: LeaseState = state === "active" && expiredNow() ? "expired" : state;
      return Object.freeze({
        leaseId,
        grantId: grant.grantId,
        workspaceId: grant.workspaceId,
        attemptId: grant.attemptId,
        state: effective,
        acquiredAt,
        expiresAt,
        releasedAt,
        version,
      });
    },
    assertValid(): void {
      if (state === "revoked") {
        throw new ProcessBrokerError("LEASE_REVOKED", "The execution lease was revoked.", { leaseId });
      }
      if (state === "released") {
        throw new ProcessBrokerError("LEASE_INVALID", "The execution lease was already released.", {
          leaseId,
        });
      }
      if (state === "expired" || expiredNow()) {
        settle("expired");
        throw new ProcessBrokerError("LEASE_EXPIRED", "The execution lease expired.", { leaseId });
      }
    },
    isValid(): boolean {
      return state === "active" && !expiredNow();
    },
    renew(next: string): void {
      if (!renewable) {
        throw new ProcessBrokerError("LEASE_INVALID", "This lease is not renewable.", { leaseId });
      }
      if (state !== "active" || expiredNow()) {
        throw new ProcessBrokerError("LEASE_EXPIRED", "An inactive lease cannot be renewed.", {
          leaseId,
        });
      }
      const candidate = ensureTimestamp(next, "expiresAt");
      if (new Date(candidate).valueOf() > new Date(grant.expiresAt).valueOf()) {
        throw invalidRequest("A lease cannot be renewed beyond its grant.", { leaseId });
      }
      expiresAt = candidate;
      version += 1;
    },
    revoke(): void {
      settle("revoked");
    },
    release(): void {
      settle("released");
    },
    onInvalidated(listener: () => void): () => void {
      if (state !== "active" || expiredNow()) {
        // Already invalid: inform the caller immediately rather than
        // registering a listener that would never fire.
        try {
          listener();
        } catch {
          // See notify().
        }
        return () => undefined;
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
}
