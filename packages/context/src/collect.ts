/**
 * Turning authorized sources into candidates.
 *
 * Everything that can fail while gathering material fails here, as an
 * omission with a reason: an unresolvable artifact, an excerpt whose bytes no
 * longer match the digest the index recorded, an expired or deleted memory
 * record, an unconfirmed candidate the configuration excludes. None of those
 * produces a partial or silently substituted body.
 *
 * Source digests are verified rather than trusted. An index entry states what
 * the file hashed to when it was indexed; if the read port now returns
 * different bytes, the excerpt is discarded. Serving content under a digest
 * that does not describe it is precisely how a stale or swapped file reaches a
 * prompt while appearing verified.
 */

import { createHash } from "node:crypto";
import type { DataClassification } from "@ai-dev-os/domain";
import {
  isExpiredAt,
  memoryScopeKey,
  opaqueLabel,
  type DisclosureScope,
  type MemoryArtifactReference,
  type MemoryEntry,
} from "@ai-dev-os/memory";
import type {
  RepositoryIndex,
  RepositoryIndexSearchHit,
  SnapshotReadPort,
} from "@ai-dev-os/repository-index";
import {
  diagnostic,
  type ContextDiagnostic,
  type OmissionReason,
} from "./errors.js";
import { truncateToBytes } from "./estimator.js";
import {
  candidateDigest,
  type ContextCandidate,
  type ContextConfiguration,
  type ContextRequest,
  type ContextSourceKind,
} from "./model.js";
import type { ContextOmission } from "./pack.js";

/** Reads bounded text from an artifact the caller is already authorized for. */
export interface ContextArtifactPort {
  readExcerpt(
    reference: MemoryArtifactReference,
    maxBytes: number,
  ): Promise<{ readonly text: string; readonly digest: string }>;
}

export interface RepositorySource {
  readonly index: RepositoryIndex;
  readonly readPort: SnapshotReadPort;
  readonly hits: readonly RepositoryIndexSearchHit[];
  readonly classification: DataClassification;
  readonly disclosure: DisclosureScope;
}

export interface ContextSources {
  readonly repository?: RepositorySource;
  readonly memory?: readonly MemoryEntry[];
  readonly artifacts?: readonly MemoryArtifactReference[];
  readonly artifactPort?: ContextArtifactPort;
}

export interface CollectionResult {
  readonly candidates: readonly ContextCandidate[];
  readonly omissions: readonly ContextOmission[];
  readonly diagnostics: readonly ContextDiagnostic[];
}

interface Collector {
  readonly candidates: ContextCandidate[];
  readonly omissions: ContextOmission[];
  readonly diagnostics: ContextDiagnostic[];
}

function omit(
  collector: Collector,
  input: {
    readonly identity: string;
    readonly sourceKind: ContextSourceKind;
    readonly category: ContextCandidate["category"];
    readonly digest: string;
    readonly reason: OmissionReason;
    readonly requestedBytes: number;
  },
): void {
  collector.omissions.push(Object.freeze({ ...input }));
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function lineRange(text: string): { readonly startLine: number; readonly endLine: number } {
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0x0a) {
      lines += 1;
    }
  }
  return Object.freeze({ startLine: 1, endLine: lines });
}

async function collectRepository(
  collector: Collector,
  source: RepositorySource,
  configuration: ContextConfiguration,
): Promise<void> {
  const scopeLabel = opaqueLabel(
    `${source.index.identity.projectId}|${source.index.identity.workspaceId}`,
    "context-repository-scope",
  );
  const byPath = new Map(source.index.entries.map((entry) => [entry.canonicalPath, entry]));

  for (const hit of source.hits) {
    const entry = byPath.get(hit.canonicalPath);
    const identity = `repository:${hit.canonicalPath}`;
    if (entry === undefined || entry.contentDigest === null) {
      omit(collector, {
        identity,
        sourceKind: "repository-file",
        category: "repository",
        digest: "0".repeat(64),
        reason: "source-unavailable",
        requestedBytes: 0,
      });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await source.readPort.read(hit.canonicalPath, configuration.budget.maxItemBytes);
    } catch {
      collector.diagnostics.push(
        diagnostic("index-read-failed", identity, "the snapshot read port refused the entry"),
      );
      omit(collector, {
        identity,
        sourceKind: "repository-file",
        category: "repository",
        digest: entry.contentDigest.hex,
        reason: "source-unavailable",
        requestedBytes: entry.sizeBytes,
      });
      continue;
    }
    const readDigest = createHash("sha256").update(bytes).digest("hex");
    // A short read is expected when the file exceeds the per-item bound, and
    // the digest of a prefix legitimately differs. Only a *complete* read that
    // disagrees with the index indicates the file changed underneath us.
    const completeRead = bytes.length === entry.sizeBytes;
    if (configuration.verifySourceDigests && completeRead && readDigest !== entry.contentDigest.hex) {
      omit(collector, {
        identity,
        sourceKind: "repository-file",
        category: "repository",
        digest: entry.contentDigest.hex,
        reason: "source-digest-mismatch",
        requestedBytes: bytes.length,
      });
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      omit(collector, {
        identity,
        sourceKind: "repository-file",
        category: "repository",
        digest: entry.contentDigest.hex,
        reason: "source-unavailable",
        requestedBytes: bytes.length,
      });
      continue;
    }
    const bounded = truncateToBytes(text, configuration.budget.maxItemBytes);
    collector.candidates.push(
      Object.freeze({
        sourceKind: "repository-file" as const,
        category: "repository" as const,
        identity,
        digest: candidateDigest(bounded.text),
        classification: source.classification,
        disclosure: source.disclosure,
        scopeLabel,
        provenance: Object.freeze({
          locator: hit.canonicalPath,
          sourceDigest: entry.contentDigest.hex,
          originFingerprint: source.index.fingerprint,
        }),
        observedAt: source.index.observedAt,
        baseScore: hit.score,
        extractionRange: lineRange(bounded.text),
        body: bounded.text,
        trust: "untrusted" as const,
      }),
    );
  }
}

function collectMemory(
  collector: Collector,
  entries: readonly MemoryEntry[],
  configuration: ContextConfiguration,
  now: Date,
): void {
  for (const entry of entries) {
    const record = entry.record;
    const identity = `memory:${record.recordId}`;
    const scopeLabel = opaqueLabel(memoryScopeKey(record.scope), "context-memory-scope");
    const base = {
      identity,
      sourceKind: "memory-record" as const,
      category: record.variant === "constraint" ? ("constraint" as const) : ("memory" as const),
      digest: record.contentDigest,
    };
    if (entry.tombstonedAt !== null || record.variant === "tombstone") {
      omit(collector, { ...base, reason: "tombstoned", requestedBytes: 0 });
      continue;
    }
    if (entry.revokedAt !== null) {
      omit(collector, { ...base, reason: "policy-denied", requestedBytes: 0 });
      continue;
    }
    if (isExpiredAt(record, now)) {
      omit(collector, { ...base, reason: "expired", requestedBytes: 0 });
      continue;
    }
    if (
      record.variant === "inferred-preference-candidate" &&
      entry.confirmation !== "confirmed" &&
      !configuration.includeUnconfirmedCandidates
    ) {
      omit(collector, { ...base, reason: "unconfirmed-candidate-excluded", requestedBytes: 0 });
      continue;
    }
    if (record.body.kind !== "text") {
      // A withheld, artifact-backed, or secret-referencing body is never
      // inlined here. Artifact content enters through the artifact source,
      // which verifies its digest; secret material never enters at all.
      omit(collector, {
        ...base,
        reason: record.body.kind === "withheld" ? "policy-denied" : "source-unavailable",
        requestedBytes: 0,
      });
      continue;
    }
    const bounded = truncateToBytes(record.body.text, configuration.budget.maxItemBytes);
    collector.candidates.push(
      Object.freeze({
        sourceKind: "memory-record" as const,
        category: base.category,
        identity,
        digest: candidateDigest(bounded.text),
        classification: record.classification,
        disclosure: record.disclosure,
        scopeLabel,
        provenance: Object.freeze({
          locator: record.recordId,
          sourceDigest: record.contentDigest,
          originFingerprint: record.fingerprint,
        }),
        observedAt: record.observedAt,
        // Confidence is a permille integer where it exists; a record without
        // one is fully asserted and scores above any estimate.
        baseScore: record.confidence ?? 1_000,
        extractionRange: null,
        body: bounded.text,
        trust: "untrusted" as const,
      }),
    );
  }
}

async function collectArtifacts(
  collector: Collector,
  references: readonly MemoryArtifactReference[],
  port: ContextArtifactPort | undefined,
  configuration: ContextConfiguration,
  observedAt: string,
): Promise<void> {
  for (const reference of references) {
    const identity = `artifact:${reference.artifactId}`;
    const base = {
      identity,
      sourceKind: "artifact-excerpt" as const,
      category: "artifact" as const,
      digest: reference.digest.hex,
    };
    if (port === undefined) {
      omit(collector, { ...base, reason: "artifact-unresolved", requestedBytes: reference.sizeBytes });
      continue;
    }
    let excerpt: { readonly text: string; readonly digest: string };
    try {
      excerpt = await port.readExcerpt(reference, configuration.budget.maxItemBytes);
    } catch {
      collector.diagnostics.push(
        diagnostic("artifact-read-failed", identity, "the artifact port refused the reference"),
      );
      omit(collector, { ...base, reason: "artifact-unresolved", requestedBytes: reference.sizeBytes });
      continue;
    }
    const complete = reference.sizeBytes <= configuration.budget.maxItemBytes;
    if (configuration.verifySourceDigests && complete && excerpt.digest !== reference.digest.hex) {
      omit(collector, {
        ...base,
        reason: "source-digest-mismatch",
        requestedBytes: reference.sizeBytes,
      });
      continue;
    }
    const bounded = truncateToBytes(excerpt.text, configuration.budget.maxItemBytes);
    collector.candidates.push(
      Object.freeze({
        sourceKind: "artifact-excerpt" as const,
        category: "artifact" as const,
        identity,
        digest: candidateDigest(bounded.text),
        classification: reference.classification,
        disclosure: "project-internal" as const,
        scopeLabel: opaqueLabel(reference.artifactId, "context-artifact-scope"),
        provenance: Object.freeze({
          locator: reference.artifactId,
          sourceDigest: reference.digest.hex,
          originFingerprint: sha256(`${reference.artifactId}|${reference.digest.hex}`),
        }),
        observedAt,
        baseScore: 500,
        extractionRange: lineRange(bounded.text),
        body: bounded.text,
        trust: "untrusted" as const,
      }),
    );
  }
}

/**
 * Builds the candidate set. The caller's task description becomes a candidate
 * like any other: it is untrusted content that shapes retrieval, and it
 * authorizes nothing. It is classified at the configured ceiling, which
 * overstates rather than understates its sensitivity.
 */
export async function collectContextCandidates(input: {
  readonly request: ContextRequest;
  readonly sources: ContextSources;
  readonly configuration: ContextConfiguration;
  readonly now: Date;
}): Promise<CollectionResult> {
  const collector: Collector = { candidates: [], omissions: [], diagnostics: [] };
  const { request, sources, configuration } = input;

  if (request.taskDescription.length > 0) {
    const bounded = truncateToBytes(request.taskDescription, configuration.budget.maxItemBytes);
    collector.candidates.push(
      Object.freeze({
        sourceKind: "task-description" as const,
        category: "task" as const,
        identity: `task:${request.requestId}`,
        digest: candidateDigest(bounded.text),
        classification: configuration.maxClassification,
        disclosure: "scope-only" as const,
        scopeLabel: opaqueLabel(`${request.projectId}|${request.workspaceId ?? "-"}`, "context-task-scope"),
        provenance: Object.freeze({
          locator: request.requestId,
          sourceDigest: sha256(request.taskDescription),
          originFingerprint: request.subjectDigest,
        }),
        observedAt: request.requestedAt,
        baseScore: 1_000_000,
        extractionRange: null,
        body: bounded.text,
        trust: "untrusted" as const,
      }),
    );
  }

  if (sources.repository !== undefined) {
    await collectRepository(collector, sources.repository, configuration);
  }
  if (sources.memory !== undefined) {
    collectMemory(collector, sources.memory, configuration, input.now);
  }
  if (sources.artifacts !== undefined) {
    await collectArtifacts(
      collector,
      sources.artifacts,
      sources.artifactPort,
      configuration,
      request.requestedAt,
    );
  }

  return Object.freeze({
    candidates: Object.freeze(collector.candidates),
    omissions: Object.freeze(collector.omissions),
    diagnostics: Object.freeze(collector.diagnostics),
  });
}
