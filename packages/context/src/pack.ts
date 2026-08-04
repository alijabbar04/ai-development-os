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
import { DATA_CLASSIFICATIONS, toCanonicalJson, validation } from "@ai-dev-os/domain";
import type { DataClassification } from "@ai-dev-os/domain";
import { DISCLOSURE_SCOPES, type DisclosureScope } from "@ai-dev-os/memory";
import {
  CONTEXT_DIAGNOSTIC_CODES,
  OMISSION_REASONS,
  type ContextDiagnostic,
  type OmissionReason,
} from "./errors.js";
import { utf8ByteLength } from "./estimator.js";
import { countFrameSentinels } from "./framing.js";
import type {
  CandidateProvenance,
  ContextCategory,
  ContextSourceKind,
  ExtractionRange,
} from "./model.js";
import {
  categoryPriority,
  CONTEXT_CATEGORIES,
  CONTEXT_SCHEMA_VERSION,
  CONTEXT_SELECTION_ALGORITHM_VERSION,
  CONTEXT_SOURCE_KINDS,
} from "./model.js";

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

const HEX_64 = /^[0-9a-f]{64}$/;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const SCORE_COMPONENT_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

function hex64(value: unknown, path: string): string {
  return ensureString(value, path, {
    minLength: 64,
    maxLength: 64,
    pattern: HEX_64,
    patternName: "sha-256 digest",
  });
}

function identity(value: unknown, path: string): string {
  return ensureString(value, path, {
    maxLength: 256,
    pattern: IDENTITY_PATTERN,
    patternName: "context identity",
  });
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

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

function parseProvenance(value: unknown, path: string): CandidateProvenance {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["locator", "sourceDigest", "originFingerprint"], path);
  return Object.freeze({
    locator: ensureString(record["locator"], `${path}.locator`, { maxLength: 1_024 }),
    sourceDigest: hex64(record["sourceDigest"], `${path}.sourceDigest`),
    originFingerprint: hex64(record["originFingerprint"], `${path}.originFingerprint`),
  });
}

function parseExtractionRange(value: unknown, path: string): ExtractionRange | null {
  return ensureNullable(value, (raw) => {
    const record = ensureRecord(raw, path);
    ensureExactKeys(record, ["startLine", "endLine"], path);
    const startLine = ensureSafeInteger(record["startLine"], `${path}.startLine`, 1, 100_000_000);
    const endLine = ensureSafeInteger(record["endLine"], `${path}.endLine`, 1, 100_000_000);
    if (endLine < startLine) {
      fail(`${path}.endLine`, "inverted_range", "cannot precede startLine.");
    }
    return Object.freeze({ startLine, endLine });
  });
}

function parseScoreComponents(
  value: unknown,
  path: string,
  score: number,
  category: ContextCategory,
): readonly ScoreComponent[] {
  const components = ensureArray(value, path, 16).map((raw, index) => {
    const componentPath = `${path}[${index}]`;
    const record = ensureRecord(raw, componentPath);
    ensureExactKeys(record, ["name", "value"], componentPath);
    return Object.freeze({
      name: ensureString(record["name"], `${componentPath}.name`, {
        maxLength: 64,
        pattern: SCORE_COMPONENT_PATTERN,
        patternName: "score component name",
      }),
      value: ensureSafeInteger(
        record["value"],
        `${componentPath}.value`,
        -1_000_000_000_000,
        1_000_000_000_000,
      ),
    });
  });
  if (
    components.length !== 2 ||
    components[0]?.name !== "base-relevance" ||
    components[0]?.value !== score ||
    components[1]?.name !== "category-priority" ||
    components[1]?.value !== categoryPriority(category)
  ) {
    fail(path, "score_components_mismatch", "must match selection algorithm version 1.");
  }
  return Object.freeze(components);
}

function parsePackItem(value: unknown, path: string): ContextPackItem {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "ordinal",
      "sourceKind",
      "category",
      "identity",
      "digest",
      "classification",
      "disclosure",
      "scopeLabel",
      "provenance",
      "observedAt",
      "score",
      "scoreComponents",
      "byteContribution",
      "unitContribution",
      "truncated",
      "extractionRange",
      "trust",
      "frameSentinelOccurrences",
      "body",
    ],
    path,
  );
  const category = ensureEnum(record["category"], `${path}.category`, CONTEXT_CATEGORIES);
  const score = ensureSafeInteger(record["score"], `${path}.score`, 0, 1_000_000_000_000);
  const body = ensureString(record["body"], `${path}.body`, {
    minLength: 1,
    maxLength: 4_000_000,
  });
  const byteContribution = ensureSafeInteger(
    record["byteContribution"],
    `${path}.byteContribution`,
    1,
    1_048_576,
  );
  if (byteContribution !== utf8ByteLength(body)) {
    fail(`${path}.byteContribution`, "byte_count_mismatch", "must equal the body's UTF-8 byte length.");
  }
  const frameSentinelOccurrences = ensureSafeInteger(
    record["frameSentinelOccurrences"],
    `${path}.frameSentinelOccurrences`,
    0,
    4_000_000,
  );
  if (frameSentinelOccurrences !== countFrameSentinels(body)) {
    fail(
      `${path}.frameSentinelOccurrences`,
      "sentinel_count_mismatch",
      "must equal the number of framing sentinels in the body.",
    );
  }
  return Object.freeze({
    ordinal: ensureSafeInteger(record["ordinal"], `${path}.ordinal`, 1, 100_000),
    sourceKind: ensureEnum(record["sourceKind"], `${path}.sourceKind`, CONTEXT_SOURCE_KINDS),
    category,
    identity: identity(record["identity"], `${path}.identity`),
    digest: hex64(record["digest"], `${path}.digest`),
    classification: ensureEnum(
      record["classification"],
      `${path}.classification`,
      DATA_CLASSIFICATIONS,
    ),
    disclosure: ensureEnum(record["disclosure"], `${path}.disclosure`, DISCLOSURE_SCOPES),
    scopeLabel: ensureString(record["scopeLabel"], `${path}.scopeLabel`, {
      minLength: 16,
      maxLength: 64,
      pattern: /^[0-9a-f]{16,64}$/,
      patternName: "scope label digest",
    }),
    provenance: parseProvenance(record["provenance"], `${path}.provenance`),
    observedAt: ensureTimestamp(record["observedAt"], `${path}.observedAt`),
    score,
    scoreComponents: parseScoreComponents(
      record["scoreComponents"],
      `${path}.scoreComponents`,
      score,
      category,
    ),
    byteContribution,
    unitContribution: ensureSafeInteger(
      record["unitContribution"],
      `${path}.unitContribution`,
      1,
      1_073_741_824,
    ),
    truncated: ensureBoolean(record["truncated"], `${path}.truncated`),
    extractionRange: parseExtractionRange(record["extractionRange"], `${path}.extractionRange`),
    trust: ensureEnum(record["trust"], `${path}.trust`, ["untrusted"] as const),
    frameSentinelOccurrences,
    body,
  });
}

function parseOmission(value: unknown, path: string): ContextOmission {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    ["identity", "sourceKind", "category", "digest", "reason", "requestedBytes"],
    path,
  );
  return Object.freeze({
    identity: identity(record["identity"], `${path}.identity`),
    sourceKind: ensureEnum(record["sourceKind"], `${path}.sourceKind`, CONTEXT_SOURCE_KINDS),
    category: ensureEnum(record["category"], `${path}.category`, CONTEXT_CATEGORIES),
    digest: hex64(record["digest"], `${path}.digest`),
    reason: ensureEnum(record["reason"], `${path}.reason`, OMISSION_REASONS),
    requestedBytes: ensureSafeInteger(
      record["requestedBytes"],
      `${path}.requestedBytes`,
      0,
      1_073_741_824,
    ),
  });
}

function parseUsage(value: unknown, path: string): ContextUsage {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    ["bytes", "units", "itemCount", "bytesByCategory", "bytesBySourceKind"],
    path,
  );
  const categories = ensureRecord(record["bytesByCategory"], `${path}.bytesByCategory`);
  ensureExactKeys(categories, CONTEXT_CATEGORIES, `${path}.bytesByCategory`);
  const sources = ensureRecord(record["bytesBySourceKind"], `${path}.bytesBySourceKind`);
  ensureExactKeys(sources, CONTEXT_SOURCE_KINDS, `${path}.bytesBySourceKind`);
  const bytesByCategory = {} as Record<ContextCategory, number>;
  const bytesBySourceKind = {} as Record<ContextSourceKind, number>;
  for (const category of CONTEXT_CATEGORIES) {
    bytesByCategory[category] = ensureSafeInteger(
      categories[category],
      `${path}.bytesByCategory.${category}`,
      0,
      1_073_741_824,
    );
  }
  for (const sourceKind of CONTEXT_SOURCE_KINDS) {
    bytesBySourceKind[sourceKind] = ensureSafeInteger(
      sources[sourceKind],
      `${path}.bytesBySourceKind.${sourceKind}`,
      0,
      1_073_741_824,
    );
  }
  return Object.freeze({
    bytes: ensureSafeInteger(record["bytes"], `${path}.bytes`, 0, 1_073_741_824),
    units: ensureSafeInteger(record["units"], `${path}.units`, 0, 1_073_741_824),
    itemCount: ensureSafeInteger(record["itemCount"], `${path}.itemCount`, 0, 100_000),
    bytesByCategory: Object.freeze(bytesByCategory),
    bytesBySourceKind: Object.freeze(bytesBySourceKind),
  });
}

function parseEstimator(value: unknown, path: string): ContextPack["estimator"] {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["estimatorId", "exact", "bytesPerUnit"], path);
  const exact = ensureBoolean(record["exact"], `${path}.exact`);
  if (exact !== false) {
    fail(`${path}.exact`, "exact_estimator_forbidden", "must be false for a context pack.");
  }
  return Object.freeze({
    estimatorId: ensureString(record["estimatorId"], `${path}.estimatorId`, {
      maxLength: 64,
      pattern: /^[a-z][a-z0-9-]{0,63}$/,
      patternName: "estimator identifier",
    }),
    exact: false,
    bytesPerUnit: ensureSafeInteger(
      record["bytesPerUnit"],
      `${path}.bytesPerUnit`,
      1,
      64,
    ),
  });
}

function parseDiagnostic(value: unknown, path: string): ContextDiagnostic {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["code", "identity", "detail"], path);
  return Object.freeze({
    code: ensureEnum(record["code"], `${path}.code`, CONTEXT_DIAGNOSTIC_CODES),
    identity: ensureNullable(record["identity"], (raw) => identity(raw, `${path}.identity`)),
    detail: ensureString(record["detail"], `${path}.detail`, { minLength: 0, maxLength: 200 }),
  });
}

function assertCanonicalItemOrder(items: readonly ContextPackItem[], path: string): void {
  const identities = new Set<string>();
  const digests = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) continue;
    if (item.ordinal !== index + 1) {
      fail(`${path}[${index}].ordinal`, "ordinal_mismatch", "must equal its one-based position.");
    }
    if (identities.has(item.identity)) {
      fail(`${path}[${index}].identity`, "duplicate_identity", "must be unique within the pack.");
    }
    if (digests.has(item.digest)) {
      fail(`${path}[${index}].digest`, "duplicate_digest", "must be unique within the pack.");
    }
    identities.add(item.identity);
    digests.add(item.digest);
    const previous = items[index - 1];
    if (
      previous !== undefined &&
      (categoryPriority(previous.category) - categoryPriority(item.category) ||
        item.score - previous.score ||
        compareText(previous.identity, item.identity) ||
        compareText(previous.digest, item.digest)) > 0
    ) {
      fail(path, "non_canonical_order", "items must follow the selection algorithm's total order.");
    }
  }
}

function assertCanonicalOmissionOrder(omissions: readonly ContextOmission[], path: string): void {
  for (let index = 1; index < omissions.length; index += 1) {
    const previous = omissions[index - 1];
    const current = omissions[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      (compareText(previous.reason, current.reason) ||
        compareText(previous.identity, current.identity) ||
        compareText(previous.digest, current.digest)) > 0
    ) {
      fail(path, "non_canonical_order", "omissions must follow the selection algorithm's total order.");
    }
  }
}

function assertCanonicalDiagnosticOrder(
  diagnostics: readonly ContextDiagnostic[],
  path: string,
): void {
  for (let index = 1; index < diagnostics.length; index += 1) {
    const previous = diagnostics[index - 1];
    const current = diagnostics[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      (compareText(previous.code, current.code) ||
        compareText(previous.identity ?? "", current.identity ?? "") ||
        compareText(previous.detail, current.detail)) > 0
    ) {
      fail(path, "non_canonical_order", "diagnostics must follow the selection algorithm's total order.");
    }
  }
}

function assertUsage(items: readonly ContextPackItem[], usage: ContextUsage, path: string): void {
  const bytesByCategory = Object.fromEntries(CONTEXT_CATEGORIES.map((key) => [key, 0])) as Record<
    ContextCategory,
    number
  >;
  const bytesBySourceKind = Object.fromEntries(
    CONTEXT_SOURCE_KINDS.map((key) => [key, 0]),
  ) as Record<ContextSourceKind, number>;
  let bytes = 0;
  let units = 0;
  for (const item of items) {
    bytes += item.byteContribution;
    units += item.unitContribution;
    bytesByCategory[item.category] += item.byteContribution;
    bytesBySourceKind[item.sourceKind] += item.byteContribution;
  }
  if (usage.bytes !== bytes || usage.units !== units || usage.itemCount !== items.length) {
    fail(path, "usage_mismatch", "totals must equal the selected item contributions.");
  }
  for (const category of CONTEXT_CATEGORIES) {
    if (usage.bytesByCategory[category] !== bytesByCategory[category]) {
      fail(`${path}.bytesByCategory.${category}`, "usage_mismatch", "must equal item contributions.");
    }
  }
  for (const sourceKind of CONTEXT_SOURCE_KINDS) {
    if (usage.bytesBySourceKind[sourceKind] !== bytesBySourceKind[sourceKind]) {
      fail(`${path}.bytesBySourceKind.${sourceKind}`, "usage_mismatch", "must equal item contributions.");
    }
  }
}

/**
 * Strictly validates a pack crossing a package or persistence boundary.
 *
 * In addition to field shapes, this verifies all derived counts, canonical
 * ordering, algorithm-version invariants, and the pack fingerprint. Returned
 * values are rebuilt and deeply frozen so callers never retain exotic input
 * objects or mutable nested data.
 */
export function parseContextPack(value: unknown, path = "contextPack"): ContextPack {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "schemaVersion",
      "selectionAlgorithmVersion",
      "requestFingerprint",
      "generatedAt",
      "items",
      "omissions",
      "omissionsTruncated",
      "usage",
      "estimator",
      "diagnostics",
      "fingerprint",
    ],
    path,
  );
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, CONTEXT_SCHEMA_VERSION);
  ensureSchemaVersion(
    record["selectionAlgorithmVersion"],
    `${path}.selectionAlgorithmVersion`,
    CONTEXT_SELECTION_ALGORITHM_VERSION,
  );
  const items = Object.freeze(
    ensureArray(record["items"], `${path}.items`, 100_000).map((item, index) =>
      parsePackItem(item, `${path}.items[${index}]`),
    ),
  );
  const omissions = Object.freeze(
    ensureArray(record["omissions"], `${path}.omissions`, 100_000).map((item, index) =>
      parseOmission(item, `${path}.omissions[${index}]`),
    ),
  );
  const diagnostics = Object.freeze(
    ensureArray(record["diagnostics"], `${path}.diagnostics`, 100_000).map((item, index) =>
      parseDiagnostic(item, `${path}.diagnostics[${index}]`),
    ),
  );
  assertCanonicalItemOrder(items, `${path}.items`);
  assertCanonicalOmissionOrder(omissions, `${path}.omissions`);
  assertCanonicalDiagnosticOrder(diagnostics, `${path}.diagnostics`);
  const usage = parseUsage(record["usage"], `${path}.usage`);
  assertUsage(items, usage, `${path}.usage`);
  const unsealed = Object.freeze({
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    selectionAlgorithmVersion: CONTEXT_SELECTION_ALGORITHM_VERSION,
    requestFingerprint: hex64(record["requestFingerprint"], `${path}.requestFingerprint`),
    generatedAt: ensureTimestamp(record["generatedAt"], `${path}.generatedAt`),
    items,
    omissions,
    omissionsTruncated: ensureBoolean(record["omissionsTruncated"], `${path}.omissionsTruncated`),
    usage,
    estimator: parseEstimator(record["estimator"], `${path}.estimator`),
    diagnostics,
  });
  const fingerprint = hex64(record["fingerprint"], `${path}.fingerprint`);
  if (fingerprint !== contextPackFingerprint(unsealed)) {
    fail(`${path}.fingerprint`, "fingerprint_mismatch", "does not match the pack contents.");
  }
  return Object.freeze({ ...unsealed, fingerprint });
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
