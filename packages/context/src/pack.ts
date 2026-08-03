/**
 * The context pack.
 *
 * A pack is a returned value. It is never written anywhere by this package:
 * persisting assembled context is a disclosure decision that belongs to the
 * caller and to an explicitly authorized artifact sink.
 *
 * The fingerprint covers the request binding, every selected item, every
 * omission, and the usage totals — everything that determines what the pack
 * says. It excludes `generatedAt`, which records only when it was said.
 */

import { createHash } from "node:crypto";
import { toCanonicalJson } from "@ai-dev-os/domain";
import type { DataClassification } from "@ai-dev-os/domain";
import type { DisclosureScope } from "@ai-dev-os/memory";
import type { ContextDiagnostic, OmissionReason } from "./errors.js";
import type {
  CandidateProvenance,
  ContextCategory,
  ContextSourceKind,
  ExtractionRange,
} from "./model.js";
import { CONTEXT_SCHEMA_VERSION, CONTEXT_SELECTION_ALGORITHM_VERSION } from "./model.js";

export interface ScoreComponent {
  readonly name: string;
  readonly value: number;
}

export interface ContextPackItem {
  /** Position in the pack, starting at 1. Part of the rendered frame. */
  readonly ordinal: number;
  readonly sourceKind: ContextSourceKind;
  readonly category: ContextCategory;
  readonly identity: string;
  /**
   * SHA-256 of the candidate body **as offered**, which is also the
   * deduplication key. When `truncated` is true, `body` is a prefix of the
   * content this digest describes — exactly as `provenance.sourceDigest`
   * describes the full source rather than the excerpt. A consumer that needs a
   * digest of the packed bytes must hash `body` itself.
   */
  readonly digest: string;
  readonly classification: DataClassification;
  readonly disclosure: DisclosureScope;
  readonly scopeLabel: string;
  readonly provenance: CandidateProvenance;
  readonly observedAt: string;
  readonly score: number;
  readonly scoreComponents: readonly ScoreComponent[];
  /** Exact UTF-8 bytes this item contributes to the budget. */
  readonly byteContribution: number;
  /** Estimator units this item contributes. Conservative, never exact. */
  readonly unitContribution: number;
  readonly truncated: boolean;
  readonly extractionRange: ExtractionRange | null;
  readonly trust: "untrusted";
  /** How many frame markers the body contains. Evidence of a forging attempt. */
  readonly frameSentinelOccurrences: number;
  readonly body: string;
}

/** What was left out and why — with no part of the body it names. */
export interface ContextOmission {
  readonly identity: string;
  readonly sourceKind: ContextSourceKind;
  readonly category: ContextCategory;
  readonly digest: string;
  readonly reason: OmissionReason;
  /** Bytes the candidate would have contributed, for budget diagnosis. */
  readonly requestedBytes: number;
}

export interface ContextUsage {
  readonly bytes: number;
  readonly units: number;
  readonly itemCount: number;
  readonly bytesByCategory: Readonly<Record<ContextCategory, number>>;
  readonly bytesBySourceKind: Readonly<Record<ContextSourceKind, number>>;
}

export interface ContextPack {
  readonly schemaVersion: typeof CONTEXT_SCHEMA_VERSION;
  readonly selectionAlgorithmVersion: typeof CONTEXT_SELECTION_ALGORITHM_VERSION;
  readonly requestFingerprint: string;
  readonly generatedAt: string;
  readonly items: readonly ContextPackItem[];
  readonly omissions: readonly ContextOmission[];
  readonly omissionsTruncated: boolean;
  readonly usage: ContextUsage;
  readonly estimator: { readonly estimatorId: string; readonly exact: false; readonly bytesPerUnit: number };
  readonly diagnostics: readonly ContextDiagnostic[];
  readonly fingerprint: string;
}

function fingerprintInput(pack: Omit<ContextPack, "fingerprint">): unknown {
  return {
    schemaVersion: pack.schemaVersion,
    selectionAlgorithmVersion: pack.selectionAlgorithmVersion,
    requestFingerprint: pack.requestFingerprint,
    items: pack.items,
    omissions: pack.omissions,
    omissionsTruncated: pack.omissionsTruncated,
    usage: pack.usage,
    estimator: pack.estimator,
    diagnostics: pack.diagnostics,
  };
}

export function contextPackFingerprint(pack: Omit<ContextPack, "fingerprint">): string {
  return createHash("sha256")
    .update(toCanonicalJson(fingerprintInput(pack), "contextPack"), "utf8")
    .digest("hex");
}

export function sealContextPack(pack: Omit<ContextPack, "fingerprint">): ContextPack {
  return Object.freeze({ ...pack, fingerprint: contextPackFingerprint(pack) });
}

/**
 * A bounded, body-free summary suitable for an audit record. Counts, digests,
 * and reasons only: no paths, no subjects, no text.
 */
export interface ContextPackAudit {
  readonly requestFingerprint: string;
  readonly packFingerprint: string;
  readonly itemCount: number;
  readonly omissionCount: number;
  readonly bytes: number;
  readonly units: number;
  readonly itemDigests: readonly string[];
  readonly omissionsByReason: Readonly<Record<string, number>>;
  readonly frameSentinelOccurrences: number;
}

export function summarizeContextPack(pack: ContextPack): ContextPackAudit {
  const omissionsByReason: Record<string, number> = {};
  for (const omission of pack.omissions) {
    omissionsByReason[omission.reason] = (omissionsByReason[omission.reason] ?? 0) + 1;
  }
  return Object.freeze({
    requestFingerprint: pack.requestFingerprint,
    packFingerprint: pack.fingerprint,
    itemCount: pack.items.length,
    omissionCount: pack.omissions.length,
    bytes: pack.usage.bytes,
    units: pack.usage.units,
    itemDigests: Object.freeze(pack.items.map((item) => item.digest)),
    omissionsByReason: Object.freeze(omissionsByReason),
    frameSentinelOccurrences: pack.items.reduce(
      (total, item) => total + item.frameSentinelOccurrences,
      0,
    ),
  });
}
