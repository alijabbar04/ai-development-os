/**
 * Windows production artifact identity (ADR 0017 section 6).
 *
 * This module is pure value logic: it parses an artifact manifest strictly,
 * recomputes its canonical fingerprint, and validates artifact file names. It
 * never reads the filesystem, never resolves a path, and never decides that an
 * artifact is trustworthy.
 *
 * A manifest sitting inside the bundle it describes is an index, not evidence:
 * anything that can rewrite the files can rewrite the manifest. Trust comes
 * only from the pinned fingerprint table in `windows-artifact-discovery.ts`,
 * which is empty in this checkpoint.
 */

import { validation } from "@ai-dev-os/domain";
import { fingerprintOf } from "./fingerprint.js";
import {
  SECURE_BACKEND_ESCAPE_CORPUS_FINGERPRINT,
  SECURE_BACKEND_ESCAPE_CORPUS_VERSION,
  secureBackendEscapeVectorCount,
} from "./escape-corpus.js";

const { ensureArray, ensureBoolean, ensureEnum, ensureExactKeys, ensureRecord, ensureSafeInteger, ensureString } =
  validation;

export const WINDOWS_ARTIFACT_MANIFEST_SCHEMA_VERSION = 1 as const;
export const WINDOWS_PRODUCTION_PROTOCOL_VERSION = 1 as const;
export const WINDOWS_ARTIFACT_BUILD_RECIPE_VERSION = 1 as const;
export const WINDOWS_ARTIFACT_MANIFEST_KIND =
  "ai-dev-os-windows-production-artifact-manifest" as const;
export const WINDOWS_ARTIFACT_MANIFEST_FILE_NAME = "artifact-manifest.json" as const;
export const WINDOWS_ARTIFACT_RID = "win-x64" as const;
export const WINDOWS_ARTIFACT_PLATFORM = "win32" as const;
export const WINDOWS_ARTIFACT_ARCHITECTURE = "x64" as const;

/** The two production components. The evidence tooling is not one of them. */
export const WINDOWS_ARTIFACT_COMPONENTS = Object.freeze([
  "windows-helper",
  "windows-supervisor",
] as const);
export type WindowsArtifactComponent = (typeof WINDOWS_ARTIFACT_COMPONENTS)[number];

/**
 * The only signer state this checkpoint can produce. There is no release
 * signing, so there is no other honest value, and `unsigned-candidate` is
 * never production eligible.
 */
export const WINDOWS_ARTIFACT_SIGNER_STATES = Object.freeze(["unsigned-candidate"] as const);
export type WindowsArtifactSignerState = (typeof WINDOWS_ARTIFACT_SIGNER_STATES)[number];

/**
 * Stable limitation codes. They are recorded in the manifest so a bundle
 * cannot be presented later as if it had been proved.
 */
export const WINDOWS_ARTIFACT_LIMITATION_CODES = Object.freeze([
  "artifact-never-executed-beyond-read-only-self-test",
  "installed-source-trust-blocked-on-release-signing",
  "no-pinned-bundle-fingerprint",
  "path-redirection-needs-protected-install-root",
  "production-supervisor-recovery-unproved",
  "unsigned-candidate",
  "windows-corpus-not-run",
] as const);
export type WindowsArtifactLimitationCode =
  (typeof WINDOWS_ARTIFACT_LIMITATION_CODES)[number];

/**
 * The closed refusal enumeration for artifact discovery, verification,
 * installation, and removal. Every failure is one of these codes; none of them
 * carries a path, a digest, a host name, or any other body.
 */
export const WINDOWS_ARTIFACT_REFUSALS = Object.freeze([
  "artifact-bundle-not-pinned",
  "artifact-caller-selected-path-refused",
  "artifact-corpus-mismatch",
  "artifact-destination-exists",
  "artifact-discovery-unsupported-platform",
  "artifact-file-digest-mismatch",
  "artifact-file-duplicate",
  "artifact-file-missing",
  "artifact-file-name-invalid",
  "artifact-file-reparse-point",
  "artifact-file-size-mismatch",
  "artifact-file-unexpected",
  "artifact-identity-architecture-mismatch",
  "artifact-identity-component-mismatch",
  "artifact-identity-platform-mismatch",
  "artifact-identity-protocol-mismatch",
  "artifact-identity-rid-mismatch",
  "artifact-identity-source-build-mismatch",
  "artifact-install-interrupted",
  "artifact-manifest-fingerprint-unpinned",
  "artifact-manifest-missing",
  "artifact-manifest-schema-invalid",
  "artifact-manifest-stale",
  "artifact-manifest-unreadable",
  "artifact-manifest-unsupported-schema",
  "artifact-path-escape",
  "artifact-path-normalization-ambiguous",
  "artifact-path-reparse-point",
  "artifact-production-eligibility-claimed",
  "artifact-quarantined",
  "artifact-removal-active-version",
  "artifact-removal-interrupted",
  "artifact-removal-recoverable-version",
  "artifact-root-unresolvable",
  "artifact-signer-state-untrusted",
  "artifact-staging-incomplete",
] as const);
export type WindowsArtifactRefusal = (typeof WINDOWS_ARTIFACT_REFUSALS)[number];

/**
 * Windows production protocol version 1 bounds (ADR 0017 section 4.1).
 *
 * These are the control plane's copy of the limits the native components
 * enforce. They exist here so a change on either side is a visible, reviewed
 * change on both.
 */
export const WINDOWS_PROTOCOL_LIMITS = Object.freeze({
  protocolVersion: WINDOWS_PRODUCTION_PROTOCOL_VERSION,
  schemaVersion: 1,
  frameLengthPrefixBytes: 4,
  maxFramePayloadBytes: 8_192,
  maxConnectionBytes: 262_144,
  maxFramesPerConnection: 32,
  operationTokenHexLength: 32,
  fingerprintHexLength: 64,
} as const);

/**
 * The pinned expectations for the native components' read-only `self-test`.
 *
 * The two components duplicate the protocol core so that each is a separate,
 * independently reviewable trust closure. Duplication is only safe if drift is
 * impossible to miss, so both components report a digest over the identical
 * in-memory vector set and the packaging pipeline fails the build unless both
 * digests equal the pinned constant below.
 *
 * `manifestFixtureFingerprint` is the cross-language check: the C# and
 * TypeScript implementations of canonical manifest identity must produce the
 * same fingerprint for the reviewed fixture in
 * `scripts/manifest-conformance-fixture.json`.
 */
export const WINDOWS_COMPONENT_CONFORMANCE = Object.freeze({
  suiteVersion: 1,
  coreSuite: "windows-production-core-v1",
  coreVectorCount: 165,
  /**
   * The digest a SEALED build must report.
   *
   * It changed at this checkpoint because ADR 0018 section 4 replaced the core
   * suite's `gate/mutating-operations-structurally-disabled` vector — which
   * pinned the sealed answer into a suite both recipes run, so no
   * reviewed-proof build could ever pass its own self-test — with the
   * recipe-aware gate block in `ClosureConformance.AddGateVectors`.
   *
   * A reviewed-proof build reports a DIFFERENT core digest by construction: the
   * gate vectors' expected values are selected by the same preprocessor symbol
   * that selects the recipe. The packaging pipeline requires a sealed build to
   * match this constant and requires a proof build not to, which is what makes
   * the two flavours verifiably distinct rather than merely differently
   * labelled.
   */
  coreConformanceDigest:
    "3b5ad6e8931cbe129dd5bda1fe8998853260466ea0525680d34276ad0bc77757",
  manifestFixtureFingerprint:
    "c39961a4a6946201758403a86fe25795c89e70f607a1c6e3642c292419663054",
  roles: Object.freeze({
    "windows-supervisor": Object.freeze({
      suite: "windows-supervisor-role-v1",
      vectorCount: 28,
      digest: "f32f48474e5cd5b51af555ca545aca5487d7fb6836db4145fdf23bfebcdb13e2",
    }),
    "windows-helper": Object.freeze({
      suite: "windows-helper-role-v1",
      vectorCount: 54,
      digest: "0a7e32f9c453faf6a3ed34f1102a554ec65fa6c13816cd481889c41889ae8af0",
    }),
  }),
} as const);

export interface WindowsArtifactFileEntry {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

export interface WindowsArtifactManifest {
  readonly schemaVersion: typeof WINDOWS_ARTIFACT_MANIFEST_SCHEMA_VERSION;
  readonly manifestKind: typeof WINDOWS_ARTIFACT_MANIFEST_KIND;
  readonly component: WindowsArtifactComponent;
  readonly protocolVersion: number;
  readonly sourceVersion: string;
  readonly buildRecipeVersion: number;
  readonly platform: string;
  readonly rid: string;
  readonly architecture: string;
  readonly packageVersion: string;
  readonly bundleVersion: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly files: readonly WindowsArtifactFileEntry[];
  readonly sourceEnvelopeFingerprint: string;
  readonly buildManifestFingerprint: string;
  readonly corpusVersion: number;
  readonly corpusFingerprint: string;
  readonly windowsApplicableVectorCount: number;
  readonly signerState: WindowsArtifactSignerState;
  readonly productionEligible: boolean;
  readonly limitations: readonly WindowsArtifactLimitationCode[];
}

const MANIFEST_KEYS = [
  "schemaVersion",
  "manifestKind",
  "component",
  "protocolVersion",
  "sourceVersion",
  "buildRecipeVersion",
  "platform",
  "rid",
  "architecture",
  "packageVersion",
  "bundleVersion",
  "fileCount",
  "totalBytes",
  "files",
  "sourceEnvelopeFingerprint",
  "buildManifestFingerprint",
  "corpusVersion",
  "corpusFingerprint",
  "windowsApplicableVectorCount",
  "signerState",
  "productionEligible",
  "limitations",
] as const;

const FILE_KEYS = ["name", "size", "sha256"] as const;

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SEMVER_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9]{1,16}(?:\.[a-z0-9]{1,16})*)?$/;
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const RESERVED_DEVICE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

export const MAX_WINDOWS_ARTIFACT_FILE_COUNT = 1_024;
export const MAX_WINDOWS_ARTIFACT_FILE_BYTES = 268_435_456;
export const MAX_WINDOWS_ARTIFACT_MANIFEST_BYTES = 1_048_576;

/**
 * Artifact file names are ASCII-only by construction. Restricting the
 * character class removes Unicode normalization ambiguity outright, and
 * rejecting separators, drive letters, dot segments, alternate data streams,
 * trailing dots or spaces, and reserved DOS device names removes path escape
 * and device redirection at the name level rather than at the path level.
 */
export function windowsArtifactFileNameIssue(name: string): WindowsArtifactRefusal | null {
  if (typeof name !== "string" || !FILE_NAME_PATTERN.test(name)) {
    return "artifact-file-name-invalid";
  }
  if (name.endsWith(".") || name.endsWith(" ") || name.includes("..")) {
    return "artifact-file-name-invalid";
  }
  if (name.normalize("NFC") !== name || name.normalize("NFD") !== name) {
    // Unreachable for the ASCII class above, kept as an explicit statement of
    // the property the class is chosen to guarantee.
    return "artifact-path-normalization-ambiguous";
  }
  const dot = name.indexOf(".");
  const stem = dot < 0 ? name : name.slice(0, dot);
  if (RESERVED_DEVICE_NAMES.has(stem.toLowerCase())) {
    return "artifact-file-name-invalid";
  }
  return null;
}

export function isSafeWindowsArtifactFileName(name: string): boolean {
  return windowsArtifactFileNameIssue(name) === null;
}

function parseFileEntry(value: unknown, path: string): WindowsArtifactFileEntry {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, FILE_KEYS, path);
  const name = ensureString(record["name"], `${path}.name`, { maxLength: 128 });
  if (!isSafeWindowsArtifactFileName(name)) {
    validation.fail(`${path}.name`, "bad_artifact_file_name", "must be a safe artifact file name.");
  }
  return Object.freeze({
    name,
    size: ensureSafeInteger(record["size"], `${path}.size`, 0, MAX_WINDOWS_ARTIFACT_FILE_BYTES),
    sha256: ensureString(record["sha256"], `${path}.sha256`, {
      minLength: 64,
      maxLength: 64,
      pattern: DIGEST_PATTERN,
      patternName: "lowercase SHA-256 digest",
    }),
  });
}

/**
 * Strict manifest parsing: exact key set, no unknown or duplicate fields, no
 * prototype-polluting keys (rejected by `ensureRecord`), bounded integers,
 * closed character classes, ordinal-sorted file and limitation lists, and
 * internal consistency between `fileCount`/`totalBytes` and the file list.
 */
export function parseWindowsArtifactManifest(
  value: unknown,
  path = "windowsArtifactManifest",
): WindowsArtifactManifest {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, MANIFEST_KEYS, path);
  validation.ensureSchemaVersion(
    record["schemaVersion"],
    `${path}.schemaVersion`,
    WINDOWS_ARTIFACT_MANIFEST_SCHEMA_VERSION,
  );
  if (record["manifestKind"] !== WINDOWS_ARTIFACT_MANIFEST_KIND) {
    validation.fail(`${path}.manifestKind`, "bad_manifest_kind", "must be the artifact manifest kind.");
  }

  const rawFiles = ensureArray(record["files"], `${path}.files`, MAX_WINDOWS_ARTIFACT_FILE_COUNT);
  if (rawFiles.length === 0) {
    validation.fail(`${path}.files`, "empty_closure", "must describe at least one file.");
  }
  const files: WindowsArtifactFileEntry[] = [];
  const exact = new Set<string>();
  const caseInsensitive = new Set<string>();
  let previous: string | null = null;
  let measured = 0;
  rawFiles.forEach((entry, index) => {
    const parsed = parseFileEntry(entry, `${path}.files[${index}]`);
    if (exact.has(parsed.name) || caseInsensitive.has(parsed.name.toLowerCase())) {
      validation.fail(`${path}.files[${index}]`, "duplicate_file", "must be a unique file name.");
    }
    if (previous !== null && previous >= parsed.name) {
      validation.fail(`${path}.files[${index}]`, "unsorted_files", "must be sorted by ordinal name.");
    }
    exact.add(parsed.name);
    caseInsensitive.add(parsed.name.toLowerCase());
    previous = parsed.name;
    measured += parsed.size;
    files.push(parsed);
  });

  const fileCount = ensureSafeInteger(
    record["fileCount"],
    `${path}.fileCount`,
    1,
    MAX_WINDOWS_ARTIFACT_FILE_COUNT,
  );
  const totalBytes = ensureSafeInteger(
    record["totalBytes"],
    `${path}.totalBytes`,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (fileCount !== files.length || totalBytes !== measured) {
    validation.fail(path, "closure_summary_mismatch", "must summarize its own file list exactly.");
  }

  const rawLimitations = ensureArray(
    record["limitations"],
    `${path}.limitations`,
    WINDOWS_ARTIFACT_LIMITATION_CODES.length,
  );
  const limitations: WindowsArtifactLimitationCode[] = [];
  let previousLimitation: string | null = null;
  rawLimitations.forEach((entry, index) => {
    const code = ensureEnum(
      entry,
      `${path}.limitations[${index}]`,
      WINDOWS_ARTIFACT_LIMITATION_CODES,
    );
    if (previousLimitation !== null && previousLimitation >= code) {
      validation.fail(
        `${path}.limitations[${index}]`,
        "unsorted_limitations",
        "must be sorted and unique.",
      );
    }
    previousLimitation = code;
    limitations.push(code);
  });

  return Object.freeze({
    schemaVersion: WINDOWS_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    manifestKind: WINDOWS_ARTIFACT_MANIFEST_KIND,
    component: ensureEnum(record["component"], `${path}.component`, WINDOWS_ARTIFACT_COMPONENTS),
    protocolVersion: ensureSafeInteger(record["protocolVersion"], `${path}.protocolVersion`, 1, 64),
    sourceVersion: ensureString(record["sourceVersion"], `${path}.sourceVersion`, {
      maxLength: 40,
      pattern: SEMVER_PATTERN,
      patternName: "bundle version",
    }),
    buildRecipeVersion: ensureSafeInteger(
      record["buildRecipeVersion"],
      `${path}.buildRecipeVersion`,
      1,
      64,
    ),
    platform: ensureString(record["platform"], `${path}.platform`, {
      maxLength: 16,
      pattern: /^[a-z0-9]+$/,
      patternName: "platform",
    }),
    rid: ensureString(record["rid"], `${path}.rid`, {
      maxLength: 32,
      pattern: /^[a-z0-9-]+$/,
      patternName: "runtime identifier",
    }),
    architecture: ensureString(record["architecture"], `${path}.architecture`, {
      maxLength: 16,
      pattern: /^[a-z0-9]+$/,
      patternName: "architecture",
    }),
    packageVersion: ensureString(record["packageVersion"], `${path}.packageVersion`, {
      maxLength: 40,
      pattern: SEMVER_PATTERN,
      patternName: "package version",
    }),
    bundleVersion: ensureString(record["bundleVersion"], `${path}.bundleVersion`, {
      maxLength: 40,
      pattern: SEMVER_PATTERN,
      patternName: "bundle version",
    }),
    fileCount,
    totalBytes,
    files: Object.freeze(files),
    sourceEnvelopeFingerprint: ensureString(
      record["sourceEnvelopeFingerprint"],
      `${path}.sourceEnvelopeFingerprint`,
      { minLength: 64, maxLength: 64, pattern: DIGEST_PATTERN, patternName: "digest" },
    ),
    buildManifestFingerprint: ensureString(
      record["buildManifestFingerprint"],
      `${path}.buildManifestFingerprint`,
      { minLength: 64, maxLength: 64, pattern: DIGEST_PATTERN, patternName: "digest" },
    ),
    corpusVersion: ensureSafeInteger(record["corpusVersion"], `${path}.corpusVersion`, 1, 64),
    corpusFingerprint: ensureString(record["corpusFingerprint"], `${path}.corpusFingerprint`, {
      minLength: 64,
      maxLength: 64,
      pattern: DIGEST_PATTERN,
      patternName: "digest",
    }),
    windowsApplicableVectorCount: ensureSafeInteger(
      record["windowsApplicableVectorCount"],
      `${path}.windowsApplicableVectorCount`,
      0,
      1_024,
    ),
    signerState: ensureEnum(
      record["signerState"],
      `${path}.signerState`,
      WINDOWS_ARTIFACT_SIGNER_STATES,
    ),
    productionEligible: ensureBoolean(record["productionEligible"], `${path}.productionEligible`),
    limitations: Object.freeze(limitations),
  });
}

/**
 * The recomputed manifest fingerprint. The manifest never carries its own
 * fingerprint, because a digest stored beside the thing it describes is not a
 * trust root. This value is what a pinned constant is compared against.
 *
 * The Windows components compute the identical value from the identical
 * canonical form; the packaging pipeline compares the two so the TypeScript
 * and C# implementations of artifact identity cannot drift apart.
 */
export function windowsArtifactManifestFingerprint(manifest: WindowsArtifactManifest): string {
  return fingerprintOf({
    architecture: manifest.architecture,
    buildManifestFingerprint: manifest.buildManifestFingerprint,
    buildRecipeVersion: manifest.buildRecipeVersion,
    bundleVersion: manifest.bundleVersion,
    component: manifest.component,
    corpusFingerprint: manifest.corpusFingerprint,
    corpusVersion: manifest.corpusVersion,
    fileCount: manifest.files.length,
    files: manifest.files.map((entry) => ({
      name: entry.name,
      sha256: entry.sha256,
      size: entry.size,
    })),
    limitations: [...manifest.limitations],
    manifestKind: WINDOWS_ARTIFACT_MANIFEST_KIND,
    packageVersion: manifest.packageVersion,
    platform: manifest.platform,
    productionEligible: manifest.productionEligible,
    protocolVersion: manifest.protocolVersion,
    rid: manifest.rid,
    schemaVersion: WINDOWS_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    signerState: manifest.signerState,
    sourceEnvelopeFingerprint: manifest.sourceEnvelopeFingerprint,
    sourceVersion: manifest.sourceVersion,
    totalBytes: manifest.totalBytes,
    windowsApplicableVectorCount: manifest.windowsApplicableVectorCount,
  });
}

export interface WindowsArtifactIdentityExpectation {
  readonly component: WindowsArtifactComponent;
  readonly bundleVersion: string;
  readonly protocolVersion?: number;
  readonly sourceVersion?: string;
  readonly buildRecipeVersion?: number;
}

/**
 * Identity checking, in the order of ADR 0017 section 6.5: what the bundle
 * claims to be must match what the control plane expects it to be, before any
 * byte of the closure is trusted.
 *
 * A manifest that claims production eligibility or any signer state other than
 * `unsigned-candidate` is refused: no release signing exists, so no honest
 * manifest can say otherwise.
 */
export function verifyWindowsArtifactIdentity(
  manifest: WindowsArtifactManifest,
  expected: WindowsArtifactIdentityExpectation,
): WindowsArtifactRefusal | null {
  if (manifest.component !== expected.component) return "artifact-identity-component-mismatch";
  if (manifest.bundleVersion !== expected.bundleVersion) return "artifact-manifest-stale";
  if (manifest.protocolVersion !== (expected.protocolVersion ?? WINDOWS_PRODUCTION_PROTOCOL_VERSION)) {
    return "artifact-identity-protocol-mismatch";
  }
  if (manifest.platform !== WINDOWS_ARTIFACT_PLATFORM) return "artifact-identity-platform-mismatch";
  if (manifest.rid !== WINDOWS_ARTIFACT_RID) return "artifact-identity-rid-mismatch";
  if (manifest.architecture !== WINDOWS_ARTIFACT_ARCHITECTURE) {
    return "artifact-identity-architecture-mismatch";
  }
  if (
    (expected.sourceVersion !== undefined && manifest.sourceVersion !== expected.sourceVersion) ||
    (expected.buildRecipeVersion !== undefined &&
      manifest.buildRecipeVersion !== expected.buildRecipeVersion)
  ) {
    return "artifact-identity-source-build-mismatch";
  }
  if (
    manifest.corpusVersion !== SECURE_BACKEND_ESCAPE_CORPUS_VERSION ||
    manifest.corpusFingerprint !== SECURE_BACKEND_ESCAPE_CORPUS_FINGERPRINT ||
    manifest.windowsApplicableVectorCount !== secureBackendEscapeVectorCount("win32")
  ) {
    return "artifact-corpus-mismatch";
  }
  if (manifest.signerState !== "unsigned-candidate") return "artifact-signer-state-untrusted";
  if (manifest.productionEligible) return "artifact-production-eligibility-claimed";
  return null;
}

/**
 * The honest classification of anything this checkpoint can build. Packaging
 * success, deterministic rebuilds, and a fully verified closure all leave the
 * classification here.
 */
export function classifyWindowsArtifactBundle(
  manifest: WindowsArtifactManifest,
): {
  readonly signerState: WindowsArtifactSignerState;
  readonly productionEligible: false;
  readonly limitations: readonly WindowsArtifactLimitationCode[];
} {
  return Object.freeze({
    signerState: manifest.signerState,
    productionEligible: false as const,
    limitations: manifest.limitations,
  });
}
