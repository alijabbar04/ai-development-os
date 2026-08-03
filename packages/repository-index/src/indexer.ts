/**
 * Building, updating, and querying a repository index.
 *
 * Both the full build and the incremental update funnel through one assembly
 * function. That is what makes the central guarantee testable rather than
 * aspirational: a full build and an equivalent incremental sequence over the
 * same final snapshot produce the same fingerprint, because after the per-entry
 * work they run identical code over identical inputs.
 *
 * The guarantee has one explicit exception, recorded in the index itself:
 * when a *global* bound is exhausted (`totals.limitsExhausted`) the two paths
 * reach the bound at different points and are no longer comparable. Tombstones
 * and the observation time are likewise excluded from the content fingerprint —
 * they describe history and timing, not the current repository state — and are
 * covered by a separate `tombstoneFingerprint`.
 */

import { createHash } from "node:crypto";
import { toCanonicalJson } from "@ai-dev-os/domain";
import type { ArtifactDigest } from "@ai-dev-os/artifacts";
import {
  isExcludedPath,
  REPOSITORY_INDEX_ALGORITHM_VERSIONS,
  repositoryIndexConfigurationFingerprint,
  type RepositoryIndexConfiguration,
} from "./config.js";
import { classifyLanguage, decodeContent, detectGenerated } from "./content.js";
import {
  diagnostic,
  failed,
  indexFailure,
  ok,
  type IndexDiagnostic,
  type RepositoryIndexResult,
} from "./errors.js";
import {
  buildLexicalIndex,
  buildTermVector,
  EMPTY_TERM_VECTOR,
  extractSymbols,
  findExactTerm,
  findPrefixTerms,
  FIELD_WEIGHTS,
  inverseDocumentFrequency,
  LENGTH_NORMALIZER,
  LEXICAL_FIELDS,
  matchesPathQuery,
  TF_CAP,
  tokenize,
  type EntryTermVector,
  type LexicalField,
  type ScoreComponent,
} from "./lexical.js";
import {
  changeSetFailure,
  compareDiagnostics,
  digestOf,
  digestOfBytes,
  parseRepositoryIndexChangeSet,
  revisionId,
  sealRepositoryIndex,
  type RepositoryIndex,
  type RepositoryIndexChangeSet,
  type RepositoryIndexEntry,
  type RepositoryIndexIdentity,
  type RepositoryIndexRejection,
  type RepositoryIndexTombstone,
  REPOSITORY_INDEX_SCHEMA_VERSION,
} from "./index-model.js";
import {
  detectManifestFormat,
  extractManifest,
  type DependencyRecord,
  type ManifestRecord,
} from "./manifest-formats.js";
import { canonicalizeRepositoryPath, comparePaths, pathBaseName } from "./paths.js";
import type {
  CancellationSignal,
  IndexClock,
  SnapshotEntry,
  SnapshotReadPort,
} from "./read-port.js";

/** Everything derived from one snapshot entry, kept together for assembly. */
interface EntryState {
  readonly entry: RepositoryIndexEntry;
  readonly manifest: ManifestRecord | null;
  readonly dependencies: readonly DependencyRecord[];
}

export interface BuildRepositoryIndexOptions {
  readonly readPort: SnapshotReadPort;
  readonly configuration: RepositoryIndexConfiguration;
  readonly clock: IndexClock;
  readonly signal?: CancellationSignal;
}

export interface UpdateRepositoryIndexOptions extends BuildRepositoryIndexOptions {
  readonly priorIndex: RepositoryIndex;
  readonly changeSet: unknown;
}

/* ------------------------------------------------------------------ *
 * Per-entry indexing
 * ------------------------------------------------------------------ */

interface EntryContext {
  readonly configuration: RepositoryIndexConfiguration;
  readonly snapshotId: string;
  readonly revisionIdValue: string;
  readonly readPort: SnapshotReadPort;
  readonly mayReadContent: boolean;
}

function baseEntry(input: {
  readonly canonicalPath: string;
  readonly collisionKey: string;
  readonly source: SnapshotEntry;
  readonly context: EntryContext;
  readonly diagnostics: readonly IndexDiagnostic[];
}): RepositoryIndexEntry {
  return Object.freeze({
    canonicalPath: input.canonicalPath,
    collisionKey: input.collisionKey,
    kind: input.source.kind,
    sizeBytes: input.source.sizeBytes,
    executable: input.source.executable,
    contentDigest: null,
    encoding: "binary" as const,
    binaryEvidence: "none" as const,
    generated: false,
    generatedEvidence: "none" as const,
    lineCount: 0,
    language: classifyLanguage(input.canonicalPath, null),
    linkTarget: input.source.linkTarget,
    linkTargetVerifiedSafe: input.source.linkTargetVerifiedSafe,
    textIndexed: false,
    textTruncated: false,
    manifestFormatId: null,
    termVector: pathTermVector(input.canonicalPath, input.context.configuration.limits.maxTermsPerEntry),
    diagnostics: Object.freeze([...input.diagnostics].sort(compareDiagnostics)),
    provenance: Object.freeze({
      sourceDigestHex: null,
      snapshotId: input.context.snapshotId,
      revisionId: input.context.revisionIdValue,
      algorithmVersions: REPOSITORY_INDEX_ALGORITHM_VERSIONS,
    }),
  });
}

/**
 * Path and name terms are always available, even for content that was never
 * read. An unreadable or unsupported file stays discoverable by path without
 * pretending it was semantically indexed.
 */
function pathTermVector(canonicalPath: string, maxTerms: number): EntryTermVector {
  return buildTermVector(
    [
      ["name", tokenize(pathBaseName(canonicalPath), maxTerms)],
      ["path", tokenize(canonicalPath, maxTerms)],
    ],
    maxTerms,
  );
}

async function indexEntry(
  source: SnapshotEntry,
  canonicalPath: string,
  collisionKey: string,
  context: EntryContext,
): Promise<EntryState> {
  const { configuration } = context;
  const limits = configuration.limits;
  const diagnostics: IndexDiagnostic[] = [];

  if (source.kind === "symlink" || source.kind === "submodule") {
    diagnostics.push(
      diagnostic(
        source.kind === "symlink" ? "symlink-metadata-only" : "submodule-metadata-only",
        canonicalPath,
        source.linkTargetVerifiedSafe ? "verified target, still not followed" : "unverified target",
      ),
    );
    return Object.freeze({
      entry: baseEntry({ canonicalPath, collisionKey, source, context, diagnostics }),
      manifest: null,
      dependencies: Object.freeze([]),
    });
  }

  if (source.kind !== "file") {
    return Object.freeze({
      entry: baseEntry({ canonicalPath, collisionKey, source, context, diagnostics }),
      manifest: null,
      dependencies: Object.freeze([]),
    });
  }

  if (source.sizeBytes > limits.maxFileBytes) {
    diagnostics.push(
      diagnostic("entry-too-large", canonicalPath, `${source.sizeBytes} bytes exceeds the per-file bound`),
    );
    return Object.freeze({
      entry: baseEntry({ canonicalPath, collisionKey, source, context, diagnostics }),
      manifest: null,
      dependencies: Object.freeze([]),
    });
  }

  if (!context.mayReadContent) {
    diagnostics.push(diagnostic("byte-budget-exhausted", canonicalPath, "content not read"));
    return Object.freeze({
      entry: baseEntry({ canonicalPath, collisionKey, source, context, diagnostics }),
      manifest: null,
      dependencies: Object.freeze([]),
    });
  }

  let bytes: Uint8Array;
  try {
    bytes = await context.readPort.read(canonicalPath, limits.maxFileBytes);
  } catch {
    // The port's own failure category is not propagated: it may embed host
    // paths. The index records that the read failed and moves on.
    diagnostics.push(diagnostic("read-failed", canonicalPath, "snapshot read port refused the entry"));
    return Object.freeze({
      entry: baseEntry({ canonicalPath, collisionKey, source, context, diagnostics }),
      manifest: null,
      dependencies: Object.freeze([]),
    });
  }

  const digest: ArtifactDigest = digestOfBytes(bytes);
  const decoded = decodeContent(bytes, limits.maxIndexedTextBytes);

  if (decoded.encoding !== "utf-8") {
    diagnostics.push(
      decoded.encoding === "binary"
        ? diagnostic("binary-content", canonicalPath, `evidence ${decoded.binaryEvidence}`)
        : decoded.encoding === "invalid-utf-8"
          ? diagnostic("invalid-utf8", canonicalPath, "content is not valid UTF-8")
          : diagnostic("binary-content", canonicalPath, "empty file"),
    );
    const metadataOnly = Object.freeze({
      ...baseEntry({ canonicalPath, collisionKey, source, context, diagnostics }),
      contentDigest: digest,
      encoding: decoded.encoding,
      binaryEvidence: decoded.binaryEvidence,
      provenance: Object.freeze({
        sourceDigestHex: digest.hex,
        snapshotId: context.snapshotId,
        revisionId: context.revisionIdValue,
        algorithmVersions: REPOSITORY_INDEX_ALGORITHM_VERSIONS,
      }),
    });
    return Object.freeze({ entry: metadataOnly, manifest: null, dependencies: Object.freeze([]) });
  }

  const text = decoded.text ?? "";
  if (decoded.truncated) {
    diagnostics.push(diagnostic("text-truncated", canonicalPath, `decoded prefix only`));
  }
  const generated = detectGenerated(text);
  if (generated.generated) {
    diagnostics.push(
      diagnostic("generated-or-minified", canonicalPath, `evidence ${generated.evidence}`),
    );
  }

  const firstNewline = text.indexOf("\n");
  const firstLine = firstNewline === -1 ? text.slice(0, 200) : text.slice(0, Math.min(firstNewline, 200));
  const language = classifyLanguage(canonicalPath, firstLine);

  const detected = detectManifestFormat(canonicalPath);
  const formatId =
    detected !== null && configuration.manifestFormats.includes(detected) ? detected : null;
  if (detected !== null && formatId === null) {
    diagnostics.push(
      diagnostic("manifest-unsupported", canonicalPath, `format ${detected} is not enabled`),
    );
  }

  let manifest: ManifestRecord | null = null;
  let dependencies: readonly DependencyRecord[] = Object.freeze([]);
  let manifestKeys: readonly string[] = Object.freeze([]);
  if (formatId !== null) {
    const extraction = extractManifest({
      canonicalPath,
      formatId,
      text,
      digest,
      maxBytes: limits.maxManifestBytes,
      maxDependencies: limits.maxDependenciesPerManifest,
      byteLength: bytes.length,
    });
    manifest = extraction.record;
    dependencies = extraction.dependencies;
    manifestKeys = extraction.record.topLevelKeys;
  }

  // Generated or minified content contributes path and manifest evidence but
  // no body terms: a bundle would otherwise dominate every query.
  const bodyTokens = generated.generated ? Object.freeze([]) : tokenize(text, limits.maxTermsPerEntry);
  const symbols = generated.generated
    ? Object.freeze([])
    : extractSymbols(text, Math.min(512, limits.maxTermsPerEntry));

  const termVector = buildTermVector(
    [
      ["name", tokenize(pathBaseName(canonicalPath), limits.maxTermsPerEntry)],
      ["path", tokenize(canonicalPath, limits.maxTermsPerEntry)],
      ["symbol", symbols.flatMap((symbol) => [...tokenize(symbol, 32)])],
      ["manifestKey", manifestKeys.flatMap((key) => [...tokenize(key, 32)])],
      ["text", bodyTokens],
    ],
    limits.maxTermsPerEntry,
  );
  if (termVector.truncated) {
    diagnostics.push(
      diagnostic("terms-truncated", canonicalPath, `term vector capped at ${limits.maxTermsPerEntry}`),
    );
  }

  const entry: RepositoryIndexEntry = Object.freeze({
    canonicalPath,
    collisionKey,
    kind: source.kind,
    sizeBytes: source.sizeBytes,
    executable: source.executable,
    contentDigest: digest,
    encoding: decoded.encoding,
    binaryEvidence: decoded.binaryEvidence,
    generated: generated.generated,
    generatedEvidence: generated.evidence,
    lineCount: generated.lineCount,
    language,
    linkTarget: source.linkTarget,
    linkTargetVerifiedSafe: source.linkTargetVerifiedSafe,
    textIndexed: !generated.generated,
    textTruncated: decoded.truncated,
    manifestFormatId: formatId,
    termVector,
    diagnostics: Object.freeze([...diagnostics].sort(compareDiagnostics)),
    provenance: Object.freeze({
      sourceDigestHex: digest.hex,
      snapshotId: context.snapshotId,
      revisionId: context.revisionIdValue,
      algorithmVersions: REPOSITORY_INDEX_ALGORITHM_VERSIONS,
    }),
  });

  return Object.freeze({ entry, manifest, dependencies });
}

/* ------------------------------------------------------------------ *
 * Shared assembly
 * ------------------------------------------------------------------ */

interface AssemblyInput {
  readonly identity: RepositoryIndexIdentity;
  readonly observedAt: string;
  readonly states: readonly EntryState[];
  readonly rejections: readonly RepositoryIndexRejection[];
  readonly tombstones: readonly RepositoryIndexTombstone[];
  readonly configuration: RepositoryIndexConfiguration;
  readonly limitsExhausted: boolean;
  readonly extraDiagnostics: readonly IndexDiagnostic[];
}

/**
 * Turns a set of per-entry results into a sealed index. Called by the full
 * build and by the incremental update with the same semantics, which is the
 * whole point.
 */
function assembleIndex(input: AssemblyInput): RepositoryIndex {
  const limits = input.configuration.limits;

  // Collision resolution runs over the merged set, so an incremental addition
  // that newly collides with an untouched entry is caught exactly as a full
  // build would catch it.
  const byCollisionKey = new Map<string, string[]>();
  for (const state of input.states) {
    const bucket = byCollisionKey.get(state.entry.collisionKey);
    if (bucket === undefined) {
      byCollisionKey.set(state.entry.collisionKey, [state.entry.canonicalPath]);
    } else {
      bucket.push(state.entry.canonicalPath);
    }
  }
  const collidingPaths = new Set<string>();
  const collisionDiagnostics: IndexDiagnostic[] = [];
  for (const [, paths] of byCollisionKey) {
    if (paths.length < 2) {
      continue;
    }
    for (const path of paths.sort(comparePaths)) {
      collidingPaths.add(path);
      collisionDiagnostics.push(
        diagnostic("path-collision", path, `${paths.length} paths share one filesystem identity`),
      );
    }
  }

  const kept = input.states
    .filter((state) => !collidingPaths.has(state.entry.canonicalPath))
    .sort((a, b) => comparePaths(a.entry.canonicalPath, b.entry.canonicalPath));

  let limitsExhausted = input.limitsExhausted;
  const globalDiagnostics: IndexDiagnostic[] = [...input.extraDiagnostics, ...collisionDiagnostics];

  let bounded = kept;
  if (kept.length > limits.maxFiles) {
    bounded = kept.slice(0, limits.maxFiles);
    limitsExhausted = true;
    globalDiagnostics.push(
      diagnostic("file-budget-exhausted", null, `entry list capped at ${limits.maxFiles}`),
    );
  }

  const entries = Object.freeze(bounded.map((state) => state.entry));
  const lexical = buildLexicalIndex(
    entries.map((entry) => ({ canonicalPath: entry.canonicalPath, vector: entry.termVector })),
    {
      maxDistinctTerms: limits.maxDistinctTerms,
      maxPostingsPerTerm: limits.maxPostingsPerTerm,
    },
  );
  if (lexical.truncated) {
    limitsExhausted = true;
    globalDiagnostics.push(
      diagnostic("term-budget-exhausted", null, `distinct terms capped at ${limits.maxDistinctTerms}`),
    );
  }

  const manifests = Object.freeze(
    bounded
      .map((state) => state.manifest)
      .filter((item): item is ManifestRecord => item !== null)
      .sort((a, b) => comparePaths(a.path, b.path)),
  );
  const dependencies = Object.freeze(
    bounded
      .flatMap((state) => [...state.dependencies])
      .sort(
        (a, b) =>
          comparePaths(a.manifestPath, b.manifestPath) ||
          comparePaths(a.name, b.name) ||
          comparePaths(a.kind, b.kind) ||
          comparePaths(a.source, b.source),
      ),
  );

  // Rejections are keyed by path digest; a listing that repeats a path must
  // not make the two build paths disagree on their count.
  const dedupedRejections = new Map<string, RepositoryIndexRejection>();
  for (const rejection of input.rejections) {
    if (!dedupedRejections.has(rejection.pathDigestHex)) {
      dedupedRejections.set(rejection.pathDigestHex, rejection);
    }
  }

  const rejectionDiagnostics = [...dedupedRejections.values()].map((rejection) =>
    diagnostic(
      rejection.reason === "excluded-by-configuration"
        ? "excluded-by-configuration"
        : "path-rejected",
      null,
      `${rejection.reason} (${rejection.pathDigestHex.slice(0, 16)})`,
    ),
  );

  const allDiagnostics = [
    ...globalDiagnostics,
    ...rejectionDiagnostics,
    ...entries.flatMap((entry) => [...entry.diagnostics]),
    ...manifests.flatMap((record) => [...record.diagnostics]),
  ].sort(compareDiagnostics);

  const diagnosticsTruncated = allDiagnostics.length > limits.maxDiagnostics;
  const diagnostics = Object.freeze(
    diagnosticsTruncated ? allDiagnostics.slice(0, limits.maxDiagnostics) : allDiagnostics,
  );

  let fileCount = 0;
  let directoryCount = 0;
  let linkCount = 0;
  let otherCount = 0;
  let declaredBytes = 0;
  let indexedTextBytes = 0;
  for (const entry of entries) {
    switch (entry.kind) {
      case "file":
        fileCount += 1;
        break;
      case "directory":
        directoryCount += 1;
        break;
      case "symlink":
      case "submodule":
        linkCount += 1;
        break;
      default:
        otherCount += 1;
    }
    declaredBytes += entry.sizeBytes;
    if (entry.textIndexed) {
      indexedTextBytes += Math.min(entry.sizeBytes, limits.maxIndexedTextBytes);
    }
  }
  if (declaredBytes > limits.maxTotalBytes) {
    limitsExhausted = true;
  }

  const tombstones = Object.freeze(
    [...input.tombstones]
      .sort((a, b) => comparePaths(a.canonicalPath, b.canonicalPath) || comparePaths(a.revisionId, b.revisionId))
      .slice(0, limits.maxFiles),
  );
  const rejections = Object.freeze(
    [...dedupedRejections.values()].sort((a, b) => comparePaths(a.pathDigestHex, b.pathDigestHex)),
  );

  return sealRepositoryIndex({
    schemaVersion: REPOSITORY_INDEX_SCHEMA_VERSION,
    identity: input.identity,
    observedAt: input.observedAt,
    entries,
    tombstones,
    rejections,
    manifests,
    dependencies,
    lexical,
    diagnostics,
    totals: Object.freeze({
      fileCount,
      directoryCount,
      linkCount,
      otherCount,
      declaredBytes,
      indexedTextBytes,
      rejectedCount: rejections.length,
      limitsExhausted,
      diagnosticsTruncated,
    }),
  });
}

/**
 * Covers the update history the content fingerprint deliberately omits.
 * A caller that needs "same state *and* same history" compares both.
 */
export function tombstoneFingerprint(index: RepositoryIndex): string {
  return createHash("sha256")
    .update(toCanonicalJson(index.tombstones, "tombstones"), "utf8")
    .digest("hex");
}

/* ------------------------------------------------------------------ *
 * Full build
 * ------------------------------------------------------------------ */

interface PreparedListing {
  readonly accepted: readonly {
    readonly source: SnapshotEntry;
    readonly canonicalPath: string;
    readonly collisionKey: string;
  }[];
  readonly rejections: readonly RepositoryIndexRejection[];
}

function prepareListing(
  listing: readonly SnapshotEntry[],
  configuration: RepositoryIndexConfiguration,
  semantics: { readonly caseSensitivity: "case-sensitive" | "case-insensitive"; readonly unicodeForm: "nfc" | "preserve" },
): PreparedListing {
  const accepted: { source: SnapshotEntry; canonicalPath: string; collisionKey: string }[] = [];
  const rejections: RepositoryIndexRejection[] = [];
  const seen = new Set<string>();

  for (const source of listing) {
    const canonical = canonicalizeRepositoryPath(source.path, semantics);
    if (!canonical.ok) {
      rejections.push(
        Object.freeze({
          pathDigestHex: digestOf(typeof source.path === "string" ? source.path : ""),
          reason: canonical.reason,
        }),
      );
      continue;
    }
    if (isExcludedPath(canonical.canonicalPath, configuration.exclusions)) {
      rejections.push(
        Object.freeze({
          pathDigestHex: digestOf(canonical.canonicalPath),
          reason: "excluded-by-configuration" as const,
        }),
      );
      continue;
    }
    if (
      !configuration.recordLinkMetadata &&
      (source.kind === "symlink" || source.kind === "submodule")
    ) {
      rejections.push(
        Object.freeze({
          pathDigestHex: digestOf(canonical.canonicalPath),
          reason: "excluded-by-configuration" as const,
        }),
      );
      continue;
    }
    if (seen.has(canonical.canonicalPath)) {
      // A duplicate raw path is a listing defect, not a collision: keep one.
      continue;
    }
    seen.add(canonical.canonicalPath);
    accepted.push({ source, canonicalPath: canonical.canonicalPath, collisionKey: canonical.collisionKey });
  }

  accepted.sort((a, b) => comparePaths(a.canonicalPath, b.canonicalPath));
  return Object.freeze({
    accepted: Object.freeze(accepted),
    rejections: Object.freeze(rejections),
  });
}

function identityFor(
  readPort: SnapshotReadPort,
  configuration: RepositoryIndexConfiguration,
): RepositoryIndexIdentity {
  const snapshot = readPort.identity();
  return Object.freeze({
    schemaVersion: REPOSITORY_INDEX_SCHEMA_VERSION,
    projectId: snapshot.projectId,
    workspaceId: snapshot.workspaceId,
    snapshotId: snapshot.snapshotId,
    revision: snapshot.revision,
    configurationFingerprint: repositoryIndexConfigurationFingerprint(configuration),
    algorithmVersions: REPOSITORY_INDEX_ALGORITHM_VERSIONS,
  });
}

export async function buildRepositoryIndex(
  options: BuildRepositoryIndexOptions,
): Promise<RepositoryIndexResult<RepositoryIndex>> {
  const { configuration, clock, readPort } = options;
  const startedAt = clock.now().valueOf();
  const snapshot = readPort.identity();
  const identity = identityFor(readPort, configuration);

  let listing: readonly SnapshotEntry[];
  try {
    listing = await readPort.list();
  } catch {
    return failed(indexFailure("READ_PORT_FAILURE", "The snapshot read port could not be listed."));
  }

  const prepared = prepareListing(listing, configuration, snapshot.filesystemSemantics);
  const context = {
    configuration,
    snapshotId: snapshot.snapshotId,
    revisionIdValue: revisionId(snapshot.revision),
    readPort,
  };

  const states: EntryState[] = [];
  const extraDiagnostics: IndexDiagnostic[] = [];
  let limitsExhausted = false;
  let consumedBytes = 0;

  for (const candidate of prepared.accepted) {
    if (options.signal?.aborted === true) {
      return failed(indexFailure("CANCELLED", "Index construction was cancelled."));
    }
    if (clock.now().valueOf() - startedAt > configuration.limits.maxProcessingMs) {
      limitsExhausted = true;
      extraDiagnostics.push(
        diagnostic("time-budget-exhausted", null, `stopped after ${configuration.limits.maxProcessingMs} ms`),
      );
      break;
    }
    const mayReadContent = consumedBytes + candidate.source.sizeBytes <= configuration.limits.maxTotalBytes;
    if (!mayReadContent) {
      limitsExhausted = true;
    }
    const state = await indexEntry(candidate.source, candidate.canonicalPath, candidate.collisionKey, {
      ...context,
      mayReadContent,
    });
    if (mayReadContent && candidate.source.kind === "file") {
      consumedBytes += candidate.source.sizeBytes;
    }
    states.push(state);
  }

  return ok(
    assembleIndex({
      identity,
      observedAt: clock.now().toISOString(),
      states,
      rejections: prepared.rejections,
      tombstones: Object.freeze([]),
      configuration,
      limitsExhausted,
      extraDiagnostics,
    }),
  );
}

/* ------------------------------------------------------------------ *
 * Incremental update
 * ------------------------------------------------------------------ */

export async function updateRepositoryIndex(
  options: UpdateRepositoryIndexOptions,
): Promise<RepositoryIndexResult<RepositoryIndex>> {
  const { configuration, clock, readPort, priorIndex } = options;

  let changeSet: RepositoryIndexChangeSet;
  try {
    changeSet = parseRepositoryIndexChangeSet(options.changeSet);
  } catch (error) {
    return failed(changeSetFailure(error));
  }

  if (changeSet.baseFingerprint !== priorIndex.fingerprint) {
    return failed(
      indexFailure("SNAPSHOT_MISMATCH", "The change set does not apply to this index.", {
        expected: priorIndex.fingerprint.slice(0, 16),
        received: changeSet.baseFingerprint.slice(0, 16),
      }),
    );
  }

  const identity = identityFor(readPort, configuration);
  if (
    identity.projectId !== priorIndex.identity.projectId ||
    identity.workspaceId !== priorIndex.identity.workspaceId
  ) {
    return failed(
      indexFailure("SNAPSHOT_MISMATCH", "An index cannot be updated across projects or workspaces."),
    );
  }
  if (identity.configurationFingerprint !== priorIndex.identity.configurationFingerprint) {
    return failed(
      indexFailure(
        "SNAPSHOT_MISMATCH",
        "The configuration changed; a full rebuild is required rather than an update.",
      ),
    );
  }

  const snapshot = readPort.identity();
  const semantics = snapshot.filesystemSemantics;

  let listing: readonly SnapshotEntry[];
  try {
    listing = await readPort.list();
  } catch {
    return failed(indexFailure("READ_PORT_FAILURE", "The snapshot read port could not be listed."));
  }
  const listingByPath = new Map<string, SnapshotEntry>();
  for (const source of listing) {
    const canonical = canonicalizeRepositoryPath(source.path, semantics);
    if (canonical.ok && !listingByPath.has(canonical.canonicalPath)) {
      listingByPath.set(canonical.canonicalPath, source);
    }
  }

  const statesByPath = new Map<string, EntryState>();
  const manifestsByPath = new Map<string, ManifestRecord>();
  for (const manifest of priorIndex.manifests) {
    manifestsByPath.set(manifest.path, manifest);
  }
  const dependenciesByPath = new Map<string, DependencyRecord[]>();
  for (const dependency of priorIndex.dependencies) {
    const bucket = dependenciesByPath.get(dependency.manifestPath);
    if (bucket === undefined) {
      dependenciesByPath.set(dependency.manifestPath, [dependency]);
    } else {
      bucket.push(dependency);
    }
  }
  for (const entry of priorIndex.entries) {
    statesByPath.set(
      entry.canonicalPath,
      Object.freeze({
        entry,
        manifest: manifestsByPath.get(entry.canonicalPath) ?? null,
        dependencies: Object.freeze(dependenciesByPath.get(entry.canonicalPath) ?? []),
      }),
    );
  }

  const rejectionsByDigest = new Map<string, RepositoryIndexRejection>();
  for (const rejection of priorIndex.rejections) {
    rejectionsByDigest.set(rejection.pathDigestHex, rejection);
  }
  const tombstones: RepositoryIndexTombstone[] = [...priorIndex.tombstones];
  const currentRevisionId = revisionId(snapshot.revision);

  const context = {
    configuration,
    snapshotId: snapshot.snapshotId,
    revisionIdValue: currentRevisionId,
    readPort,
    mayReadContent: true,
  };

  const removePath = (rawPath: string, reason: "deleted" | "renamed"): void => {
    const canonical = canonicalizeRepositoryPath(rawPath, semantics);
    const key = canonical.ok ? canonical.canonicalPath : rawPath;
    const existing = statesByPath.get(key);
    if (existing !== undefined) {
      tombstones.push(
        Object.freeze({
          canonicalPath: key,
          previousContentDigestHex: existing.entry.contentDigest?.hex ?? null,
          reason,
          revisionId: currentRevisionId,
        }),
      );
      statesByPath.delete(key);
    }
    rejectionsByDigest.delete(digestOf(key));
    rejectionsByDigest.delete(digestOf(rawPath));
  };

  for (const change of changeSet.changes) {
    if (options.signal?.aborted === true) {
      return failed(indexFailure("CANCELLED", "Index update was cancelled."));
    }
    if (change.type === "deleted") {
      removePath(change.path, "deleted");
      continue;
    }
    if (change.type === "renamed") {
      removePath(change.fromPath, "renamed");
    }

    const canonical = canonicalizeRepositoryPath(change.path, semantics);
    if (!canonical.ok) {
      rejectionsByDigest.set(
        digestOf(change.path),
        Object.freeze({ pathDigestHex: digestOf(change.path), reason: canonical.reason }),
      );
      continue;
    }
    if (isExcludedPath(canonical.canonicalPath, configuration.exclusions)) {
      statesByPath.delete(canonical.canonicalPath);
      rejectionsByDigest.set(
        digestOf(canonical.canonicalPath),
        Object.freeze({
          pathDigestHex: digestOf(canonical.canonicalPath),
          reason: "excluded-by-configuration" as const,
        }),
      );
      continue;
    }
    const source = listingByPath.get(canonical.canonicalPath);
    if (source === undefined) {
      return failed(
        indexFailure("INVALID_CHANGE_SET", "A changed path is absent from the current snapshot listing."),
      );
    }
    if (
      !configuration.recordLinkMetadata &&
      (source.kind === "symlink" || source.kind === "submodule")
    ) {
      statesByPath.delete(canonical.canonicalPath);
      rejectionsByDigest.set(
        digestOf(canonical.canonicalPath),
        Object.freeze({
          pathDigestHex: digestOf(canonical.canonicalPath),
          reason: "excluded-by-configuration" as const,
        }),
      );
      continue;
    }
    rejectionsByDigest.delete(digestOf(canonical.canonicalPath));
    statesByPath.set(
      canonical.canonicalPath,
      await indexEntry(source, canonical.canonicalPath, canonical.collisionKey, context),
    );
  }

  return ok(
    assembleIndex({
      identity,
      observedAt: clock.now().toISOString(),
      states: [...statesByPath.values()],
      rejections: [...rejectionsByDigest.values()],
      tombstones,
      configuration,
      limitsExhausted: priorIndex.totals.limitsExhausted,
      extraDiagnostics: Object.freeze([]),
    }),
  );
}

/* ------------------------------------------------------------------ *
 * Query
 * ------------------------------------------------------------------ */

export const QUERY_KINDS = Object.freeze(["terms", "exact", "prefix", "path"] as const);
export type QueryKind = (typeof QUERY_KINDS)[number];

export const DEFAULT_QUERY_LIMIT = 20;
export const MAX_QUERY_LIMIT = 500;
export const MAX_QUERY_TERMS = 32;
export const DEFAULT_MAX_CANDIDATES = 10_000;

export interface RepositoryIndexQuery {
  readonly kind: QueryKind;
  readonly text: string;
  readonly fields?: readonly LexicalField[];
  readonly limit?: number;
  readonly maxCandidates?: number;
  readonly signal?: CancellationSignal;
}

export interface RepositoryIndexSearchHit {
  readonly canonicalPath: string;
  readonly entryOrdinal: number;
  readonly score: number;
  readonly components: readonly ScoreComponent[];
  readonly sourceDigestHex: string | null;
  readonly languageId: string;
  readonly generated: boolean;
  readonly textTruncated: boolean;
}

export interface RepositoryIndexSearchResult {
  readonly indexFingerprint: string;
  readonly hits: readonly RepositoryIndexSearchHit[];
  readonly candidateCount: number;
  readonly truncated: boolean;
  readonly queryTerms: readonly string[];
}

export function queryRepositoryIndex(
  index: RepositoryIndex,
  query: RepositoryIndexQuery,
): RepositoryIndexResult<RepositoryIndexSearchResult> {
  if (typeof query.text !== "string" || query.text.length === 0 || query.text.length > 1_024) {
    return failed(indexFailure("INVALID_QUERY", "Query text must be a bounded non-empty string."));
  }
  const limit = query.limit ?? DEFAULT_QUERY_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) {
    return failed(indexFailure("INVALID_QUERY", "Query limit is out of range."));
  }
  const maxCandidates = query.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1) {
    return failed(indexFailure("INVALID_QUERY", "Query candidate bound is out of range."));
  }
  const fields = query.fields ?? LEXICAL_FIELDS;
  if (fields.length === 0 || fields.some((field) => !LEXICAL_FIELDS.includes(field))) {
    return failed(indexFailure("INVALID_QUERY", "Query fields must be a non-empty subset of the known fields."));
  }
  if (query.signal?.aborted === true) {
    return failed(indexFailure("CANCELLED", "The query was cancelled before it ran."));
  }

  const allowedFields = new Set<LexicalField>(fields);
  const accumulator = new Map<number, { score: number; components: ScoreComponent[] }>();
  let truncated = false;
  let queryTerms: readonly string[] = Object.freeze([]);

  if (query.kind === "path") {
    let scanned = 0;
    index.entries.forEach((entry, ordinal) => {
      if (scanned >= maxCandidates) {
        truncated = true;
        return;
      }
      scanned += 1;
      if (!matchesPathQuery(entry.canonicalPath, query.text)) {
        return;
      }
      const lowerPath = entry.canonicalPath.toLowerCase();
      const lowerNeedle = query.text.toLowerCase();
      // Exactness is scored on the same integer scale as term matching so a
      // path hit and a term hit remain comparable.
      const strength = lowerPath === lowerNeedle ? 3 : lowerPath.startsWith(lowerNeedle) ? 2 : 1;
      accumulator.set(ordinal, {
        score: strength * FIELD_WEIGHTS.path * TF_CAP,
        components: [
          Object.freeze({
            term: lowerNeedle.slice(0, 64),
            field: "path" as const,
            termFrequency: strength,
            inverseDocumentFrequency: 0,
            fieldWeight: FIELD_WEIGHTS.path,
            contribution: strength * FIELD_WEIGHTS.path * TF_CAP,
          }),
        ],
      });
    });
    queryTerms = Object.freeze([query.text.toLowerCase().slice(0, 64)]);
  } else {
    const rawTerms =
      query.kind === "terms"
        ? tokenize(query.text, MAX_QUERY_TERMS)
        : Object.freeze([query.text.toLowerCase().slice(0, 64)]);
    queryTerms = Object.freeze([...new Set(rawTerms)].sort());
    if (queryTerms.length === 0) {
      return failed(indexFailure("INVALID_QUERY", "Query text produced no usable terms."));
    }

    let candidates = 0;
    for (const term of queryTerms) {
      const matches =
        query.kind === "prefix"
          ? (() => {
              const found = findPrefixTerms(index.lexical, term, 256);
              truncated = truncated || found.truncated;
              return found.matches;
            })()
          : findExactTerm(index.lexical, term);
      for (const match of matches) {
        if (!allowedFields.has(match.field)) {
          continue;
        }
        const idf = inverseDocumentFrequency(index.lexical.totalDocuments, match.documentFrequency);
        const weight = FIELD_WEIGHTS[match.field];
        for (const posting of match.postings) {
          if (candidates >= maxCandidates) {
            truncated = true;
            break;
          }
          candidates += 1;
          const termFrequency = Math.min(posting.count, TF_CAP);
          const contribution = idf * termFrequency * weight;
          const existing = accumulator.get(posting.entryOrdinal);
          const component: ScoreComponent = Object.freeze({
            term: match.term,
            field: match.field,
            termFrequency,
            inverseDocumentFrequency: idf,
            fieldWeight: weight,
            contribution,
          });
          if (existing === undefined) {
            accumulator.set(posting.entryOrdinal, { score: contribution, components: [component] });
          } else {
            existing.score += contribution;
            if (existing.components.length < MAX_QUERY_TERMS) {
              existing.components.push(component);
            }
          }
        }
      }
    }
  }

  const hits: RepositoryIndexSearchHit[] = [];
  for (const [ordinal, value] of accumulator) {
    const entry = index.entries[ordinal];
    if (entry === undefined) {
      continue;
    }
    const penalty = 1 + Math.floor(entry.termVector.totalTermCount / LENGTH_NORMALIZER);
    hits.push(
      Object.freeze({
        canonicalPath: entry.canonicalPath,
        entryOrdinal: ordinal,
        score: Math.floor(value.score / penalty),
        components: Object.freeze(
          [...value.components].sort(
            (a, b) =>
              b.contribution - a.contribution ||
              comparePaths(a.term, b.term) ||
              comparePaths(a.field, b.field),
          ),
        ),
        sourceDigestHex: entry.provenance.sourceDigestHex,
        languageId: entry.language.languageId,
        generated: entry.generated,
        textTruncated: entry.textTruncated,
      }),
    );
  }

  // Ties are broken by canonical path, never by iteration order.
  hits.sort((a, b) => b.score - a.score || comparePaths(a.canonicalPath, b.canonicalPath));
  const limited = hits.slice(0, limit);

  return ok(
    Object.freeze({
      indexFingerprint: index.fingerprint,
      hits: Object.freeze(limited),
      candidateCount: hits.length,
      truncated: truncated || hits.length > limited.length,
      queryTerms,
    }),
  );
}

/* ------------------------------------------------------------------ *
 * Capability facade
 * ------------------------------------------------------------------ */

export interface RepositoryIndexer {
  readonly configuration: RepositoryIndexConfiguration;
  build(
    readPort: SnapshotReadPort,
    signal?: CancellationSignal,
  ): Promise<RepositoryIndexResult<RepositoryIndex>>;
  update(input: {
    readonly readPort: SnapshotReadPort;
    readonly priorIndex: RepositoryIndex;
    readonly changeSet: unknown;
    readonly signal?: CancellationSignal;
  }): Promise<RepositoryIndexResult<RepositoryIndex>>;
  query(
    index: RepositoryIndex,
    query: RepositoryIndexQuery,
  ): RepositoryIndexResult<RepositoryIndexSearchResult>;
}

export function createRepositoryIndexer(options: {
  readonly configuration: RepositoryIndexConfiguration;
  readonly clock: IndexClock;
}): RepositoryIndexer {
  const { configuration, clock } = options;
  const indexer: RepositoryIndexer = {
    configuration,
    build: (readPort: SnapshotReadPort, signal?: CancellationSignal) =>
      buildRepositoryIndex({
        readPort,
        configuration,
        clock,
        ...(signal === undefined ? {} : { signal }),
      }),
    update: (input: {
      readonly readPort: SnapshotReadPort;
      readonly priorIndex: RepositoryIndex;
      readonly changeSet: unknown;
      readonly signal?: CancellationSignal;
    }) =>
      updateRepositoryIndex({
        readPort: input.readPort,
        priorIndex: input.priorIndex,
        changeSet: input.changeSet,
        configuration,
        clock,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    query: (index: RepositoryIndex, query: RepositoryIndexQuery) =>
      queryRepositoryIndex(index, query),
  };
  return Object.freeze(indexer);
}
