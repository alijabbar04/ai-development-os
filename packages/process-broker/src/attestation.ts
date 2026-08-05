/**
 * Serializable, body-free enforcement evidence.
 *
 * An attestation summary is safe to persist, audit, and project into routing.
 * It is deliberately not authority: production admission additionally
 * requires an opaque registration held in this process.
 */

import { validation } from "@ai-dev-os/domain";
import { invalidConfiguration } from "./errors.js";
import { fingerprintOf } from "./fingerprint.js";
import {
  QUOTA_DIMENSIONS,
  QUOTA_SUPPORT_LEVELS,
  type QuotaDimension,
  type QuotaSupportMatrix,
} from "./quota.js";

const {
  ensureArray,
  ensureBoolean,
  ensureEnum,
  ensureExactKeys,
  ensureRecord,
  ensureSafeInteger,
  ensureString,
  ensureTimestamp,
} = validation;

export const ENFORCEMENT_ATTESTATION_SCHEMA_VERSION = 1 as const;
export const ENFORCEMENT_ATTESTATION_ALGORITHM_VERSION = 1 as const;
export const MAX_ENFORCEMENT_ATTESTATION_VALIDITY_MS = 86_400_000;

export const ENFORCEMENT_BOUNDARIES = Object.freeze([
  "filesystem",
  "process-tree",
  "identity",
  "profile",
  "network-denial",
  "controlled-egress",
  "credentials",
  "ipc",
  "cleanup",
] as const);
export type EnforcementBoundary = (typeof ENFORCEMENT_BOUNDARIES)[number];

export const ENFORCEMENT_BOUNDARY_STATES = Object.freeze([
  "enforced",
  "unavailable",
  "unsupported",
  "unverified",
] as const);
export type EnforcementBoundaryState =
  (typeof ENFORCEMENT_BOUNDARY_STATES)[number];

export type EnforcementBoundaryMatrix = Readonly<
  Record<EnforcementBoundary, EnforcementBoundaryState>
>;

export const ESCAPE_CORPUS_RESULTS = Object.freeze([
  "passed",
  "failed",
  "not-run",
] as const);
export type EscapeCorpusResult = (typeof ESCAPE_CORPUS_RESULTS)[number];

export interface AttestedPlatformIdentity {
  readonly os: "win32" | "linux" | "darwin";
  readonly version: string;
  readonly kernel: string;
  readonly architecture: "x64" | "arm64";
  readonly distribution: string | null;
}

export interface AttestedHelperIdentity {
  readonly protocolVersion: number;
  readonly sourceDigest: string | null;
  readonly binaryDigest: string | null;
  readonly buildDigest: string | null;
}

export interface EscapeCorpusEvidence {
  readonly version: number;
  readonly fingerprint: string | null;
  readonly result: EscapeCorpusResult;
  readonly positiveControlsPassed: boolean;
  readonly testCount: number;
}

export interface EnforcementAttestationUnsigned {
  readonly schemaVersion: typeof ENFORCEMENT_ATTESTATION_SCHEMA_VERSION;
  readonly algorithmVersion: typeof ENFORCEMENT_ATTESTATION_ALGORITHM_VERSION;
  readonly backendId: string;
  readonly backendFactoryId: string;
  readonly enforcementProfile: string;
  readonly descriptorFingerprint: string;
  readonly platform: AttestedPlatformIdentity;
  readonly helper: AttestedHelperIdentity;
  readonly boundaries: EnforcementBoundaryMatrix;
  readonly quotas: QuotaSupportMatrix;
  readonly endpointPolicyFingerprint: string | null;
  readonly escapeCorpus: EscapeCorpusEvidence;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly limitations: readonly string[];
}

export interface EnforcementAttestation extends EnforcementAttestationUnsigned {
  readonly fingerprint: string;
}

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._+-]{0,127}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const LIMITATION_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

function digest(value: unknown, path: string): string {
  return ensureString(value, path, {
    minLength: 64,
    maxLength: 64,
    pattern: DIGEST_PATTERN,
    patternName: "sha-256 digest",
  });
}

function nullableDigest(value: unknown, path: string): string | null {
  return value === undefined || value === null ? null : digest(value, path);
}

function parsePlatform(value: unknown, path: string): AttestedPlatformIdentity {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["os", "version", "kernel", "architecture", "distribution"], path);
  const distribution = record["distribution"];
  return Object.freeze({
    os: ensureEnum(record["os"], `${path}.os`, ["win32", "linux", "darwin"] as const),
    version: ensureString(record["version"], `${path}.version`, {
      maxLength: 128,
      pattern: VERSION_PATTERN,
      patternName: "platform version",
    }),
    kernel: ensureString(record["kernel"], `${path}.kernel`, {
      maxLength: 128,
      pattern: VERSION_PATTERN,
      patternName: "kernel version",
    }),
    architecture: ensureEnum(
      record["architecture"],
      `${path}.architecture`,
      ["x64", "arm64"] as const,
    ),
    distribution:
      distribution === undefined || distribution === null
        ? null
        : ensureString(distribution, `${path}.distribution`, {
            maxLength: 128,
            pattern: TOKEN_PATTERN,
            patternName: "distribution identifier",
          }),
  });
}

function parseHelper(value: unknown, path: string): AttestedHelperIdentity {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    ["protocolVersion", "sourceDigest", "binaryDigest", "buildDigest"],
    path,
  );
  return Object.freeze({
    protocolVersion: ensureSafeInteger(
      record["protocolVersion"],
      `${path}.protocolVersion`,
      1,
      1_000,
    ),
    sourceDigest: nullableDigest(record["sourceDigest"], `${path}.sourceDigest`),
    binaryDigest: nullableDigest(record["binaryDigest"], `${path}.binaryDigest`),
    buildDigest: nullableDigest(record["buildDigest"], `${path}.buildDigest`),
  });
}

function parseBoundaries(value: unknown, path: string): EnforcementBoundaryMatrix {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ENFORCEMENT_BOUNDARIES, path);
  const parsed: Partial<Record<EnforcementBoundary, EnforcementBoundaryState>> = {};
  for (const boundary of ENFORCEMENT_BOUNDARIES) {
    parsed[boundary] = ensureEnum(
      record[boundary],
      `${path}.${boundary}`,
      ENFORCEMENT_BOUNDARY_STATES,
    );
  }
  return Object.freeze(parsed as Record<EnforcementBoundary, EnforcementBoundaryState>);
}

function parseQuotas(value: unknown, path: string): QuotaSupportMatrix {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, QUOTA_DIMENSIONS, path);
  const parsed: Partial<Record<QuotaDimension, (typeof QUOTA_SUPPORT_LEVELS)[number]>> = {};
  for (const dimension of QUOTA_DIMENSIONS) {
    parsed[dimension] = ensureEnum(
      record[dimension],
      `${path}.${dimension}`,
      QUOTA_SUPPORT_LEVELS,
    );
  }
  return Object.freeze(parsed as Record<QuotaDimension, (typeof QUOTA_SUPPORT_LEVELS)[number]>);
}

function parseCorpus(value: unknown, path: string): EscapeCorpusEvidence {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    ["version", "fingerprint", "result", "positiveControlsPassed", "testCount"],
    path,
  );
  const result = ensureEnum(record["result"], `${path}.result`, ESCAPE_CORPUS_RESULTS);
  const fingerprint = nullableDigest(record["fingerprint"], `${path}.fingerprint`);
  const positiveControlsPassed = ensureBoolean(
    record["positiveControlsPassed"],
    `${path}.positiveControlsPassed`,
  );
  const testCount = ensureSafeInteger(record["testCount"], `${path}.testCount`, 0, 1_000_000);
  if (
    result === "passed" &&
    (fingerprint === null || !positiveControlsPassed || testCount === 0)
  ) {
    throw invalidConfiguration(
      "A passing escape corpus requires a fingerprint, positive controls, and tests.",
    );
  }
  if (result === "not-run" && (positiveControlsPassed || testCount !== 0)) {
    throw invalidConfiguration("An unrun escape corpus cannot report executed controls or tests.");
  }
  return Object.freeze({
    version: ensureSafeInteger(record["version"], `${path}.version`, 1, 1_000),
    fingerprint,
    result,
    positiveControlsPassed,
    testCount,
  });
}

export function enforcementAttestationFingerprint(
  value: EnforcementAttestationUnsigned,
): string {
  return fingerprintOf(value);
}

export function parseEnforcementAttestation(
  value: unknown,
  path = "attestation",
): EnforcementAttestation {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "schemaVersion",
      "algorithmVersion",
      "backendId",
      "backendFactoryId",
      "enforcementProfile",
      "descriptorFingerprint",
      "platform",
      "helper",
      "boundaries",
      "quotas",
      "endpointPolicyFingerprint",
      "escapeCorpus",
      "observedAt",
      "expiresAt",
      "limitations",
      "fingerprint",
    ],
    path,
  );
  validation.ensureSchemaVersion(
    record["schemaVersion"],
    `${path}.schemaVersion`,
    ENFORCEMENT_ATTESTATION_SCHEMA_VERSION,
  );
  validation.ensureSchemaVersion(
    record["algorithmVersion"],
    `${path}.algorithmVersion`,
    ENFORCEMENT_ATTESTATION_ALGORITHM_VERSION,
  );
  const observedAt = ensureTimestamp(record["observedAt"], `${path}.observedAt`);
  const expiresAt = ensureTimestamp(record["expiresAt"], `${path}.expiresAt`);
  const validityMs = new Date(expiresAt).valueOf() - new Date(observedAt).valueOf();
  if (validityMs <= 0) {
    throw invalidConfiguration("Enforcement evidence must expire after it was observed.");
  }
  if (validityMs > MAX_ENFORCEMENT_ATTESTATION_VALIDITY_MS) {
    throw invalidConfiguration("Enforcement evidence exceeds the maximum validity window.");
  }
  const limitations = ensureArray(record["limitations"], `${path}.limitations`, 64).map(
    (entry, index) =>
      ensureString(entry, `${path}.limitations[${index}]`, {
        maxLength: 64,
        pattern: LIMITATION_PATTERN,
        patternName: "stable limitation code",
      }),
  );
  const unsigned: EnforcementAttestationUnsigned = Object.freeze({
    schemaVersion: ENFORCEMENT_ATTESTATION_SCHEMA_VERSION,
    algorithmVersion: ENFORCEMENT_ATTESTATION_ALGORITHM_VERSION,
    backendId: ensureString(record["backendId"], `${path}.backendId`, {
      maxLength: 64,
      pattern: /^[a-z][a-z0-9-]{0,63}$/,
      patternName: "backend identifier",
    }),
    backendFactoryId: ensureString(record["backendFactoryId"], `${path}.backendFactoryId`, {
      maxLength: 128,
      pattern: TOKEN_PATTERN,
      patternName: "backend factory identifier",
    }),
    enforcementProfile: ensureString(
      record["enforcementProfile"],
      `${path}.enforcementProfile`,
      { maxLength: 128, pattern: TOKEN_PATTERN, patternName: "enforcement profile" },
    ),
    descriptorFingerprint: digest(
      record["descriptorFingerprint"],
      `${path}.descriptorFingerprint`,
    ),
    platform: parsePlatform(record["platform"], `${path}.platform`),
    helper: parseHelper(record["helper"], `${path}.helper`),
    boundaries: parseBoundaries(record["boundaries"], `${path}.boundaries`),
    quotas: parseQuotas(record["quotas"], `${path}.quotas`),
    endpointPolicyFingerprint: nullableDigest(
      record["endpointPolicyFingerprint"],
      `${path}.endpointPolicyFingerprint`,
    ),
    escapeCorpus: parseCorpus(record["escapeCorpus"], `${path}.escapeCorpus`),
    observedAt,
    expiresAt,
    limitations: Object.freeze([...new Set(limitations)].sort()),
  });
  const fingerprint = digest(record["fingerprint"], `${path}.fingerprint`);
  if (enforcementAttestationFingerprint(unsigned) !== fingerprint) {
    throw invalidConfiguration("The enforcement attestation fingerprint does not match.");
  }
  return Object.freeze({ ...unsigned, fingerprint });
}

export function createEnforcementAttestation(
  input: EnforcementAttestationUnsigned,
): EnforcementAttestation {
  return parseEnforcementAttestation({
    ...input,
    fingerprint: enforcementAttestationFingerprint(input),
  });
}

/** Conservative non-authorizing summary for routing/audit consumers. */
export interface SecureExecutionProjection {
  readonly schemaVersion: 1;
  readonly level: "secure-enforcing" | "advisory";
  readonly backendId: string;
  readonly platform: AttestedPlatformIdentity["os"];
  readonly attestationFingerprint: string;
  readonly boundaryFingerprint: string;
  readonly verifiedAt: string;
  readonly expiresAt: string;
  readonly grantsAuthority: false;
}

export function projectEnforcementAttestation(
  attestation: EnforcementAttestation,
): SecureExecutionProjection {
  return Object.freeze({
    schemaVersion: 1 as const,
    // A serializable attestation can be copied or self-asserted. Only the
    // opaque-registration projection in trusted-evidence may emit secure.
    level: "advisory" as const,
    backendId: attestation.backendId,
    platform: attestation.platform.os,
    attestationFingerprint: attestation.fingerprint,
    boundaryFingerprint: fingerprintOf({
      boundaries: attestation.boundaries,
      quotas: attestation.quotas,
      endpointPolicyFingerprint: attestation.endpointPolicyFingerprint,
    }),
    verifiedAt: attestation.observedAt,
    expiresAt: attestation.expiresAt,
    grantsAuthority: false as const,
  });
}
