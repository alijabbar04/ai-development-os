/**
 * The repository-index schema.
 *
 * An index is a value, not a handle: deeply frozen, canonically serializable,
 * and identified by a SHA-256 fingerprint over everything except the
 * observation time. Observation time is deliberately excluded so that the same
 * repository state indexed twice — or indexed once fully and once
 * incrementally — produces the same fingerprint.
 *
 * Identity binds every input that could change the output: project,
 * workspace, snapshot, exact source revision (or an explicit no-revision
 * state), schema version, algorithm versions, and the configuration
 * fingerprint. Two indexes with equal identity and equal fingerprint describe
 * the same repository under the same rules.
 */

import { createHash } from "node:crypto";
import { toCanonicalJson, validation } from "@ai-dev-os/domain";
import type { ProjectId, WorkspaceId } from "@ai-dev-os/domain";
import type { ArtifactDigest } from "@ai-dev-os/artifacts";
import {
  REPOSITORY_INDEX_ALGORITHM_VERSIONS,
  type RepositoryIndexAlgorithmVersions,
} from "./config.js";
import {
  BINARY_EVIDENCE,
  CLASSIFICATION_EVIDENCE,
  CONTENT_ENCODINGS,
  GENERATED_EVIDENCE,
  LANGUAGE_IDS,
  type BinaryEvidence,
  type ContentEncoding,
  type GeneratedEvidence,
  type LanguageClassification,
} from "./content.js";
import {
  diagnostic,
  indexFailure,
  INDEX_DIAGNOSTIC_CODES,
  type IndexDiagnostic,
  type RepositoryIndexFailure,
} from "./errors.js";
import {
  LEXICAL_ALGORITHM_VERSION,
  LEXICAL_FIELDS,
  type EntryTermVector,
  type LexicalIndex,
} from "./lexical.js";
import {
  DEPENDENCY_KINDS,
  DEPENDENCY_SOURCES,
  MANIFEST_FORMAT_IDS,
  MANIFEST_STATUSES,
  type DependencyRecord,
  type ManifestFormatId,
  type ManifestRecord,
} from "./manifest-formats.js";
import { comparePaths, PATH_REJECTION_REASONS, type PathRejectionReason } from "./paths.js";
import { SNAPSHOT_ENTRY_KINDS, type SnapshotEntryKind, type SourceRevision } from "./read-port.js";

const {
  ensureArray,
  ensureBoolean,
  ensureEnum,
  ensureExactKeys,
  ensureNullable,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
  ensureString,
  ensureTimestamp,
  fail,
} = validation;

export const REPOSITORY_INDEX_SCHEMA_VERSION = 1 as const;
export const REPOSITORY_INDEX_CHANGE_SET_SCHEMA_VERSION = 1 as const;

const HEX_64 = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface EntryProvenance {
  /** Digest of the exact bytes every extracted fact came from. */
  readonly sourceDigestHex: string | null;
  readonly snapshotId: string;
  /** Commit id, or the literal `no-revision`. */
  readonly revisionId: string;
  readonly algorithmVersions: RepositoryIndexAlgorithmVersions;
}

export interface RepositoryIndexEntry {
  readonly canonicalPath: string;
  readonly collisionKey: string;
  readonly kind: SnapshotEntryKind;
  readonly sizeBytes: number;
  readonly executable: boolean;
  readonly contentDigest: ArtifactDigest | null;
  readonly encoding: ContentEncoding;
  readonly binaryEvidence: BinaryEvidence;
  readonly generated: boolean;
  readonly generatedEvidence: GeneratedEvidence;
  readonly lineCount: number;
  readonly language: LanguageClassification;
  /** Recorded as metadata for link entries; never resolved. */
  readonly linkTarget: string | null;
  readonly linkTargetVerifiedSafe: boolean;
  readonly textIndexed: boolean;
  readonly textTruncated: boolean;
  readonly manifestFormatId: ManifestFormatId | null;
  readonly termVector: EntryTermVector;
  readonly diagnostics: readonly IndexDiagnostic[];
  readonly provenance: EntryProvenance;
}

export const TOMBSTONE_REASONS = Object.freeze(["deleted", "renamed"] as const);
export type TombstoneReason = (typeof TOMBSTONE_REASONS)[number];

export interface RepositoryIndexTombstone {
  readonly canonicalPath: string;
  readonly previousContentDigestHex: string | null;
  readonly reason: TombstoneReason;
  readonly revisionId: string;
}

export const REJECTION_REASONS = Object.freeze([
  ...PATH_REJECTION_REASONS,
  "excluded-by-configuration",
] as const);

export type RejectionReason = PathRejectionReason | "excluded-by-configuration";

/**
 * A path the index refused. The raw path is stored only as a digest: echoing
 * a hostile path back into diagnostics, logs, or a context pack is exactly the
 * leak this record exists to avoid.
 */
export interface RepositoryIndexRejection {
  readonly pathDigestHex: string;
  readonly reason: RejectionReason;
}

export interface RepositoryIndexIdentity {
  readonly schemaVersion: typeof REPOSITORY_INDEX_SCHEMA_VERSION;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly snapshotId: string;
  readonly revision: SourceRevision;
  readonly configurationFingerprint: string;
  readonly algorithmVersions: RepositoryIndexAlgorithmVersions;
}

export interface RepositoryIndexTotals {
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly linkCount: number;
  readonly otherCount: number;
  readonly declaredBytes: number;
  readonly indexedTextBytes: number;
  readonly rejectedCount: number;
  /**
   * True when a global bound stopped the build early. The full-versus-
   * incremental fingerprint guarantee is explicitly void when this is set,
   * because the two paths reach the bound at different points.
   */
  readonly limitsExhausted: boolean;
  readonly diagnosticsTruncated: boolean;
}

export interface RepositoryIndex {
  readonly schemaVersion: typeof REPOSITORY_INDEX_SCHEMA_VERSION;
  readonly identity: RepositoryIndexIdentity;
  /** Injected clock reading. Excluded from the fingerprint by design. */
  readonly observedAt: string;
  readonly entries: readonly RepositoryIndexEntry[];
  readonly tombstones: readonly RepositoryIndexTombstone[];
  readonly rejections: readonly RepositoryIndexRejection[];
  readonly manifests: readonly ManifestRecord[];
  readonly dependencies: readonly DependencyRecord[];
  readonly lexical: LexicalIndex;
  readonly diagnostics: readonly IndexDiagnostic[];
  readonly totals: RepositoryIndexTotals;
  readonly fingerprint: string;
}

export function revisionId(revision: SourceRevision): string {
  return revision.type === "commit" ? revision.commitId : "no-revision";
}

export function digestOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function digestOfBytes(bytes: Uint8Array): ArtifactDigest {
  return Object.freeze({
    algorithm: "sha-256" as const,
    hex: createHash("sha256").update(bytes).digest("hex"),
  });
}

/**
 * Canonical content of an index: everything that determines what the index
 * says about the repository *now*.
 *
 * Two fields are deliberately excluded. `observedAt` records when the index
 * was taken, not what it says. `tombstones` record what used to be there — an
 * incremental sequence accumulates them while a full rebuild of the same final
 * state has none, so including them would make the full-versus-incremental
 * guarantee unstatable. Tombstones are covered separately by
 * `tombstoneFingerprint`.
 */
function fingerprintInput(index: Omit<RepositoryIndex, "fingerprint">): unknown {
  return {
    schemaVersion: index.schemaVersion,
    identity: index.identity,
    entries: index.entries,
    rejections: index.rejections,
    manifests: index.manifests,
    dependencies: index.dependencies,
    lexical: index.lexical,
    diagnostics: index.diagnostics,
    totals: index.totals,
  };
}

export function repositoryIndexFingerprint(index: Omit<RepositoryIndex, "fingerprint">): string {
  return createHash("sha256")
    .update(toCanonicalJson(fingerprintInput(index), "repositoryIndex"), "utf8")
    .digest("hex");
}

export function sealRepositoryIndex(index: Omit<RepositoryIndex, "fingerprint">): RepositoryIndex {
  return Object.freeze({ ...index, fingerprint: repositoryIndexFingerprint(index) });
}

export function compareEntries(a: RepositoryIndexEntry, b: RepositoryIndexEntry): number {
  return comparePaths(a.canonicalPath, b.canonicalPath);
}

export function compareDiagnostics(a: IndexDiagnostic, b: IndexDiagnostic): number {
  return (
    comparePaths(a.code, b.code) ||
    comparePaths(a.path ?? "", b.path ?? "") ||
    comparePaths(a.detail, b.detail)
  );
}

/* ------------------------------------------------------------------ *
 * Runtime validation
 * ------------------------------------------------------------------ */

function parseRevision(value: unknown, path: string): SourceRevision {
  const record = ensureRecord(value, path);
  const type = ensureEnum(record["type"], `${path}.type`, ["commit", "no-revision"] as const);
  if (type === "commit") {
    ensureExactKeys(record, ["type", "commitId", "treeId", "objectFormat"], path);
    return Object.freeze({
      type,
      commitId: ensureString(record["commitId"], `${path}.commitId`, {
        maxLength: 128,
        pattern: /^[0-9a-f]{7,128}$/,
        patternName: "object id",
      }),
      treeId: ensureString(record["treeId"], `${path}.treeId`, {
        maxLength: 128,
        pattern: /^[0-9a-f]{7,128}$/,
        patternName: "object id",
      }),
      objectFormat: ensureString(record["objectFormat"], `${path}.objectFormat`, {
        maxLength: 32,
        pattern: /^[a-z0-9-]{1,32}$/,
        patternName: "object format",
      }),
    });
  }
  ensureExactKeys(record, ["type", "reason"], path);
  return Object.freeze({
    type,
    reason: ensureString(record["reason"], `${path}.reason`, { maxLength: 200 }),
  });
}

function parseAlgorithmVersions(value: unknown, path: string): RepositoryIndexAlgorithmVersions {
  const record = ensureRecord(value, path);
  const keys = Object.keys(REPOSITORY_INDEX_ALGORITHM_VERSIONS) as (keyof RepositoryIndexAlgorithmVersions)[];
  ensureExactKeys(record, keys, path);
  const result: Record<string, number> = {};
  for (const key of keys) {
    result[key] = ensureSafeInteger(record[key], `${path}.${key}`, 1, 1_000_000);
  }
  return Object.freeze(result) as unknown as RepositoryIndexAlgorithmVersions;
}

function hex64(value: unknown, path: string): string {
  return ensureString(value, path, {
    minLength: 64,
    maxLength: 64,
    pattern: HEX_64,
    patternName: "lowercase sha-256 digest",
  });
}

function parseTermVector(value: unknown, path: string): EntryTermVector {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["terms", "totalTermCount", "truncated"], path);
  const terms = ensureArray(record["terms"], `${path}.terms`, 65_536).map((item, index) => {
    const entry = ensureRecord(item, `${path}.terms[${index}]`);
    ensureExactKeys(entry, ["field", "term", "count"], `${path}.terms[${index}]`);
    return Object.freeze({
      field: ensureEnum(entry["field"], `${path}.terms[${index}].field`, LEXICAL_FIELDS),
      term: ensureString(entry["term"], `${path}.terms[${index}].term`, { maxLength: 64 }),
      count: ensureSafeInteger(entry["count"], `${path}.terms[${index}].count`, 1, 100_000_000),
    });
  });
  return Object.freeze({
    terms: Object.freeze(terms),
    totalTermCount: ensureSafeInteger(record["totalTermCount"], `${path}.totalTermCount`, 0, 1_000_000_000),
    truncated: ensureBoolean(record["truncated"], `${path}.truncated`),
  });
}

function parseDiagnostics(value: unknown, path: string, maxItems: number): readonly IndexDiagnostic[] {
  return Object.freeze(
    ensureArray(value, path, maxItems).map((item, index) => {
      const record = ensureRecord(item, `${path}[${index}]`);
      ensureExactKeys(record, ["code", "path", "detail"], `${path}[${index}]`);
      return diagnostic(
        ensureEnum(record["code"], `${path}[${index}].code`, INDEX_DIAGNOSTIC_CODES),
        ensureNullable(record["path"], (raw) =>
          ensureString(raw, `${path}[${index}].path`, { maxLength: 1_024 }),
        ),
        ensureString(record["detail"], `${path}[${index}].detail`, { minLength: 0, maxLength: 200 }),
      );
    }),
  );
}

function parseEntry(value: unknown, path: string): RepositoryIndexEntry {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "canonicalPath",
      "collisionKey",
      "kind",
      "sizeBytes",
      "executable",
      "contentDigest",
      "encoding",
      "binaryEvidence",
      "generated",
      "generatedEvidence",
      "lineCount",
      "language",
      "linkTarget",
      "linkTargetVerifiedSafe",
      "textIndexed",
      "textTruncated",
      "manifestFormatId",
      "termVector",
      "diagnostics",
      "provenance",
    ],
    path,
  );
  const language = ensureRecord(record["language"], `${path}.language`);
  ensureExactKeys(language, ["languageId", "evidence"], `${path}.language`);
  const provenance = ensureRecord(record["provenance"], `${path}.provenance`);
  ensureExactKeys(
    provenance,
    ["sourceDigestHex", "snapshotId", "revisionId", "algorithmVersions"],
    `${path}.provenance`,
  );
  const contentDigest = ensureNullable(record["contentDigest"], (raw) => {
    const digest = ensureRecord(raw, `${path}.contentDigest`);
    ensureExactKeys(digest, ["algorithm", "hex"], `${path}.contentDigest`);
    return Object.freeze({
      algorithm: ensureEnum(digest["algorithm"], `${path}.contentDigest.algorithm`, [
        "sha-256",
      ] as const),
      hex: hex64(digest["hex"], `${path}.contentDigest.hex`),
    });
  });
  return Object.freeze({
    canonicalPath: ensureString(record["canonicalPath"], `${path}.canonicalPath`, { maxLength: 1_024 }),
    collisionKey: ensureString(record["collisionKey"], `${path}.collisionKey`, { maxLength: 1_024 }),
    kind: ensureEnum(record["kind"], `${path}.kind`, SNAPSHOT_ENTRY_KINDS),
    sizeBytes: ensureSafeInteger(record["sizeBytes"], `${path}.sizeBytes`, 0, Number.MAX_SAFE_INTEGER),
    executable: ensureBoolean(record["executable"], `${path}.executable`),
    contentDigest,
    encoding: ensureEnum(record["encoding"], `${path}.encoding`, CONTENT_ENCODINGS),
    binaryEvidence: ensureEnum(record["binaryEvidence"], `${path}.binaryEvidence`, BINARY_EVIDENCE),
    generated: ensureBoolean(record["generated"], `${path}.generated`),
    generatedEvidence: ensureEnum(
      record["generatedEvidence"],
      `${path}.generatedEvidence`,
      GENERATED_EVIDENCE,
    ),
    lineCount: ensureSafeInteger(record["lineCount"], `${path}.lineCount`, 0, 100_000_000),
    language: Object.freeze({
      languageId: ensureEnum(language["languageId"], `${path}.language.languageId`, LANGUAGE_IDS),
      evidence: ensureEnum(language["evidence"], `${path}.language.evidence`, CLASSIFICATION_EVIDENCE),
    }) as LanguageClassification,
    linkTarget: ensureNullable(record["linkTarget"], (raw) =>
      ensureString(raw, `${path}.linkTarget`, { maxLength: 4_096 }),
    ),
    linkTargetVerifiedSafe: ensureBoolean(
      record["linkTargetVerifiedSafe"],
      `${path}.linkTargetVerifiedSafe`,
    ),
    textIndexed: ensureBoolean(record["textIndexed"], `${path}.textIndexed`),
    textTruncated: ensureBoolean(record["textTruncated"], `${path}.textTruncated`),
    manifestFormatId: ensureNullable(record["manifestFormatId"], (raw) =>
      ensureEnum(raw, `${path}.manifestFormatId`, MANIFEST_FORMAT_IDS),
    ),
    termVector: parseTermVector(record["termVector"], `${path}.termVector`),
    diagnostics: parseDiagnostics(record["diagnostics"], `${path}.diagnostics`, 64),
    provenance: Object.freeze({
      sourceDigestHex: ensureNullable(provenance["sourceDigestHex"], (raw) =>
        hex64(raw, `${path}.provenance.sourceDigestHex`),
      ),
      snapshotId: ensureString(provenance["snapshotId"], `${path}.provenance.snapshotId`, {
        maxLength: 128,
        pattern: ID_PATTERN,
        patternName: "snapshot id",
      }),
      revisionId: ensureString(provenance["revisionId"], `${path}.provenance.revisionId`, {
        maxLength: 128,
      }),
      algorithmVersions: parseAlgorithmVersions(
        provenance["algorithmVersions"],
        `${path}.provenance.algorithmVersions`,
      ),
    }),
  });
}

function parseManifestRecord(value: unknown, path: string): ManifestRecord {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "path",
      "formatId",
      "parserVersion",
      "sourceDigestHex",
      "status",
      "declaredName",
      "declaredVersion",
      "isPrivate",
      "workspacePatterns",
      "topLevelKeys",
      "dependencyCount",
      "diagnostics",
    ],
    path,
  );
  return Object.freeze({
    path: ensureString(record["path"], `${path}.path`, { maxLength: 1_024 }),
    formatId: ensureEnum(record["formatId"], `${path}.formatId`, MANIFEST_FORMAT_IDS),
    parserVersion: ensureSafeInteger(record["parserVersion"], `${path}.parserVersion`, 1, 1_000_000),
    sourceDigestHex: hex64(record["sourceDigestHex"], `${path}.sourceDigestHex`),
    status: ensureEnum(record["status"], `${path}.status`, MANIFEST_STATUSES),
    declaredName: ensureNullable(record["declaredName"], (raw) =>
      ensureString(raw, `${path}.declaredName`, { maxLength: 214 }),
    ),
    declaredVersion: ensureNullable(record["declaredVersion"], (raw) =>
      ensureString(raw, `${path}.declaredVersion`, { maxLength: 64 }),
    ),
    isPrivate: ensureNullable(record["isPrivate"], (raw) =>
      ensureBoolean(raw, `${path}.isPrivate`),
    ),
    workspacePatterns: Object.freeze(
      ensureArray(record["workspacePatterns"], `${path}.workspacePatterns`, 256).map((item, index) =>
        ensureString(item, `${path}.workspacePatterns[${index}]`, { maxLength: 200 }),
      ),
    ),
    topLevelKeys: Object.freeze(
      ensureArray(record["topLevelKeys"], `${path}.topLevelKeys`, 128).map((item, index) =>
        ensureString(item, `${path}.topLevelKeys[${index}]`, { minLength: 0, maxLength: 200 }),
      ),
    ),
    dependencyCount: ensureSafeInteger(record["dependencyCount"], `${path}.dependencyCount`, 0, 1_000_000),
    diagnostics: parseDiagnostics(record["diagnostics"], `${path}.diagnostics`, 128),
  });
}

function parseDependencyRecord(value: unknown, path: string): DependencyRecord {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "manifestPath",
      "formatId",
      "parserVersion",
      "kind",
      "source",
      "name",
      "declaredRange",
      "resolvedVersion",
      "optional",
      "sourceDigestHex",
    ],
    path,
  );
  return Object.freeze({
    manifestPath: ensureString(record["manifestPath"], `${path}.manifestPath`, { maxLength: 1_024 }),
    formatId: ensureEnum(record["formatId"], `${path}.formatId`, MANIFEST_FORMAT_IDS),
    parserVersion: ensureSafeInteger(record["parserVersion"], `${path}.parserVersion`, 1, 1_000_000),
    kind: ensureEnum(record["kind"], `${path}.kind`, DEPENDENCY_KINDS),
    source: ensureEnum(record["source"], `${path}.source`, DEPENDENCY_SOURCES),
    name: ensureString(record["name"], `${path}.name`, { maxLength: 214 }),
    declaredRange: ensureNullable(record["declaredRange"], (raw) =>
      ensureString(raw, `${path}.declaredRange`, { maxLength: 128 }),
    ),
    resolvedVersion: ensureNullable(record["resolvedVersion"], (raw) =>
      ensureString(raw, `${path}.resolvedVersion`, { maxLength: 64 }),
    ),
    optional: ensureBoolean(record["optional"], `${path}.optional`),
    sourceDigestHex: hex64(record["sourceDigestHex"], `${path}.sourceDigestHex`),
  });
}

function parseLexicalIndex(value: unknown, path: string): LexicalIndex {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    ["algorithmVersion", "totalDocuments", "terms", "distinctTermCount", "truncated"],
    path,
  );
  ensureSchemaVersion(record["algorithmVersion"], `${path}.algorithmVersion`, LEXICAL_ALGORITHM_VERSION);
  const terms = ensureArray(record["terms"], `${path}.terms`, 5_000_000).map((item, index) => {
    const entry = ensureRecord(item, `${path}.terms[${index}]`);
    ensureExactKeys(entry, ["term", "field", "documentFrequency", "postings", "truncated"], `${path}.terms[${index}]`);
    const postings = ensureArray(entry["postings"], `${path}.terms[${index}].postings`, 200_000).map(
      (posting, postingIndex) => {
        const item2 = ensureRecord(posting, `${path}.terms[${index}].postings[${postingIndex}]`);
        ensureExactKeys(item2, ["entryOrdinal", "count"], `${path}.terms[${index}].postings[${postingIndex}]`);
        return Object.freeze({
          entryOrdinal: ensureSafeInteger(
            item2["entryOrdinal"],
            `${path}.terms[${index}].postings[${postingIndex}].entryOrdinal`,
            0,
            10_000_000,
          ),
          count: ensureSafeInteger(
            item2["count"],
            `${path}.terms[${index}].postings[${postingIndex}].count`,
            1,
            100_000_000,
          ),
        });
      },
    );
    return Object.freeze({
      term: ensureString(entry["term"], `${path}.terms[${index}].term`, { maxLength: 64 }),
      field: ensureEnum(entry["field"], `${path}.terms[${index}].field`, LEXICAL_FIELDS),
      documentFrequency: ensureSafeInteger(
        entry["documentFrequency"],
        `${path}.terms[${index}].documentFrequency`,
        0,
        10_000_000,
      ),
      postings: Object.freeze(postings),
      truncated: ensureBoolean(entry["truncated"], `${path}.terms[${index}].truncated`),
    });
  });
  return Object.freeze({
    algorithmVersion: LEXICAL_ALGORITHM_VERSION,
    totalDocuments: ensureSafeInteger(record["totalDocuments"], `${path}.totalDocuments`, 0, 10_000_000),
    terms: Object.freeze(terms),
    distinctTermCount: ensureSafeInteger(record["distinctTermCount"], `${path}.distinctTermCount`, 0, 10_000_000),
    truncated: ensureBoolean(record["truncated"], `${path}.truncated`),
  });
}

function parseTotals(value: unknown, path: string): RepositoryIndexTotals {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "fileCount",
      "directoryCount",
      "linkCount",
      "otherCount",
      "declaredBytes",
      "indexedTextBytes",
      "rejectedCount",
      "limitsExhausted",
      "diagnosticsTruncated",
    ],
    path,
  );
  const counter = (key: string): number =>
    ensureSafeInteger(record[key], `${path}.${key}`, 0, Number.MAX_SAFE_INTEGER);
  return Object.freeze({
    fileCount: counter("fileCount"),
    directoryCount: counter("directoryCount"),
    linkCount: counter("linkCount"),
    otherCount: counter("otherCount"),
    declaredBytes: counter("declaredBytes"),
    indexedTextBytes: counter("indexedTextBytes"),
    rejectedCount: counter("rejectedCount"),
    limitsExhausted: ensureBoolean(record["limitsExhausted"], `${path}.limitsExhausted`),
    diagnosticsTruncated: ensureBoolean(record["diagnosticsTruncated"], `${path}.diagnosticsTruncated`),
  });
}

/**
 * Full runtime validation of an index that arrived from outside this process.
 * Structural validity, ordering, and the fingerprint are all re-checked: a
 * stored index is untrusted data like any other.
 */
export function parseRepositoryIndex(
  value: unknown,
  path = "repositoryIndex",
): RepositoryIndex {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "schemaVersion",
      "identity",
      "observedAt",
      "entries",
      "tombstones",
      "rejections",
      "manifests",
      "dependencies",
      "lexical",
      "diagnostics",
      "totals",
      "fingerprint",
    ],
    path,
  );
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, REPOSITORY_INDEX_SCHEMA_VERSION);

  const identityRecord = ensureRecord(record["identity"], `${path}.identity`);
  ensureExactKeys(
    identityRecord,
    [
      "schemaVersion",
      "projectId",
      "workspaceId",
      "snapshotId",
      "revision",
      "configurationFingerprint",
      "algorithmVersions",
    ],
    `${path}.identity`,
  );
  ensureSchemaVersion(
    identityRecord["schemaVersion"],
    `${path}.identity.schemaVersion`,
    REPOSITORY_INDEX_SCHEMA_VERSION,
  );
  const identity: RepositoryIndexIdentity = Object.freeze({
    schemaVersion: REPOSITORY_INDEX_SCHEMA_VERSION,
    projectId: ensureString(identityRecord["projectId"], `${path}.identity.projectId`, {
      maxLength: 128,
      pattern: ID_PATTERN,
      patternName: "ProjectId",
    }) as ProjectId,
    workspaceId: ensureString(identityRecord["workspaceId"], `${path}.identity.workspaceId`, {
      maxLength: 128,
      pattern: ID_PATTERN,
      patternName: "WorkspaceId",
    }) as WorkspaceId,
    snapshotId: ensureString(identityRecord["snapshotId"], `${path}.identity.snapshotId`, {
      maxLength: 128,
      pattern: ID_PATTERN,
      patternName: "snapshot id",
    }),
    revision: parseRevision(identityRecord["revision"], `${path}.identity.revision`),
    configurationFingerprint: hex64(
      identityRecord["configurationFingerprint"],
      `${path}.identity.configurationFingerprint`,
    ),
    algorithmVersions: parseAlgorithmVersions(
      identityRecord["algorithmVersions"],
      `${path}.identity.algorithmVersions`,
    ),
  });

  const entries = Object.freeze(
    ensureArray(record["entries"], `${path}.entries`, 200_000).map((item, index) =>
      parseEntry(item, `${path}.entries[${index}]`),
    ),
  );
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (previous !== undefined && current !== undefined && compareEntries(previous, current) >= 0) {
      fail(`${path}.entries[${index}]`, "unsorted_entries", "must be sorted by canonical path and unique.");
    }
  }

  const tombstones = Object.freeze(
    ensureArray(record["tombstones"], `${path}.tombstones`, 200_000).map((item, index) => {
      const entry = ensureRecord(item, `${path}.tombstones[${index}]`);
      ensureExactKeys(
        entry,
        ["canonicalPath", "previousContentDigestHex", "reason", "revisionId"],
        `${path}.tombstones[${index}]`,
      );
      return Object.freeze({
        canonicalPath: ensureString(entry["canonicalPath"], `${path}.tombstones[${index}].canonicalPath`, {
          maxLength: 1_024,
        }),
        previousContentDigestHex: ensureNullable(entry["previousContentDigestHex"], (raw) =>
          hex64(raw, `${path}.tombstones[${index}].previousContentDigestHex`),
        ),
        reason: ensureEnum(entry["reason"], `${path}.tombstones[${index}].reason`, TOMBSTONE_REASONS),
        revisionId: ensureString(entry["revisionId"], `${path}.tombstones[${index}].revisionId`, {
          maxLength: 128,
        }),
      });
    }),
  );

  const rejections = Object.freeze(
    ensureArray(record["rejections"], `${path}.rejections`, 200_000).map((item, index) => {
      const entry = ensureRecord(item, `${path}.rejections[${index}]`);
      ensureExactKeys(entry, ["pathDigestHex", "reason"], `${path}.rejections[${index}]`);
      return Object.freeze({
        pathDigestHex: hex64(entry["pathDigestHex"], `${path}.rejections[${index}].pathDigestHex`),
        reason: ensureEnum(entry["reason"], `${path}.rejections[${index}].reason`, REJECTION_REASONS),
      });
    }),
  );

  const parsed: Omit<RepositoryIndex, "fingerprint"> = {
    schemaVersion: REPOSITORY_INDEX_SCHEMA_VERSION,
    identity,
    observedAt: ensureTimestamp(record["observedAt"], `${path}.observedAt`),
    entries,
    tombstones,
    rejections,
    manifests: Object.freeze(
      ensureArray(record["manifests"], `${path}.manifests`, 50_000).map((item, index) =>
        parseManifestRecord(item, `${path}.manifests[${index}]`),
      ),
    ),
    dependencies: Object.freeze(
      ensureArray(record["dependencies"], `${path}.dependencies`, 500_000).map((item, index) =>
        parseDependencyRecord(item, `${path}.dependencies[${index}]`),
      ),
    ),
    lexical: parseLexicalIndex(record["lexical"], `${path}.lexical`),
    diagnostics: parseDiagnostics(record["diagnostics"], `${path}.diagnostics`, 100_000),
    totals: parseTotals(record["totals"], `${path}.totals`),
  };

  const expected = repositoryIndexFingerprint(parsed);
  const declared = hex64(record["fingerprint"], `${path}.fingerprint`);
  if (declared !== expected) {
    fail(`${path}.fingerprint`, "fingerprint_mismatch", "does not match the index content.");
  }
  return Object.freeze({ ...parsed, fingerprint: expected });
}

/* ------------------------------------------------------------------ *
 * Change sets
 * ------------------------------------------------------------------ */

export type RepositoryChange =
  | { readonly type: "added"; readonly path: string }
  | { readonly type: "modified"; readonly path: string }
  | { readonly type: "deleted"; readonly path: string }
  | { readonly type: "renamed"; readonly fromPath: string; readonly path: string };

export const REPOSITORY_CHANGE_TYPES = Object.freeze([
  "added",
  "modified",
  "deleted",
  "renamed",
] as const);

/**
 * A change set names *raw snapshot paths*; the updater re-reads exactly those
 * entries from the new snapshot and reuses everything else. It is bound to the
 * index it applies to by fingerprint, so a change set can never be replayed
 * against the wrong base.
 */
export interface RepositoryIndexChangeSet {
  readonly schemaVersion: typeof REPOSITORY_INDEX_CHANGE_SET_SCHEMA_VERSION;
  readonly baseFingerprint: string;
  readonly changes: readonly RepositoryChange[];
}

export function parseRepositoryIndexChangeSet(
  value: unknown,
  path = "repositoryIndexChangeSet",
): RepositoryIndexChangeSet {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["schemaVersion", "baseFingerprint", "changes"], path);
  ensureSchemaVersion(
    record["schemaVersion"],
    `${path}.schemaVersion`,
    REPOSITORY_INDEX_CHANGE_SET_SCHEMA_VERSION,
  );
  const changes = ensureArray(record["changes"], `${path}.changes`, 200_000).map((item, index) => {
    const entry = ensureRecord(item, `${path}.changes[${index}]`);
    const type = ensureEnum(entry["type"], `${path}.changes[${index}].type`, REPOSITORY_CHANGE_TYPES);
    if (type === "renamed") {
      ensureExactKeys(entry, ["type", "fromPath", "path"], `${path}.changes[${index}]`);
      return Object.freeze({
        type,
        fromPath: ensureString(entry["fromPath"], `${path}.changes[${index}].fromPath`, {
          maxLength: 1_024,
        }),
        path: ensureString(entry["path"], `${path}.changes[${index}].path`, { maxLength: 1_024 }),
      });
    }
    ensureExactKeys(entry, ["type", "path"], `${path}.changes[${index}]`);
    return Object.freeze({
      type,
      path: ensureString(entry["path"], `${path}.changes[${index}].path`, { maxLength: 1_024 }),
    });
  });
  return Object.freeze({
    schemaVersion: REPOSITORY_INDEX_CHANGE_SET_SCHEMA_VERSION,
    baseFingerprint: hex64(record["baseFingerprint"], `${path}.baseFingerprint`),
    changes: Object.freeze(changes),
  });
}

export function changeSetFailure(error: unknown): RepositoryIndexFailure {
  const issueCount =
    error !== null && typeof error === "object" && "issues" in error && Array.isArray(error.issues)
      ? error.issues.length
      : 0;
  return indexFailure("INVALID_CHANGE_SET", "The change set is invalid.", { issueCount });
}
