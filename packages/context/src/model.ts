/**
 * Candidates, budgets, requests, and configuration.
 *
 * The central type is `ContextCandidate`: one piece of material that *could*
 * go into a pack, carrying everything the packer needs to decide and
 * everything a consumer needs to know afterwards. Its `trust` field has
 * exactly one member — `"untrusted"` — because there is no retrieved material
 * that is trusted. Repository files, README prose, prior model summaries, and
 * memory bodies are all data.
 */

import { createHash } from "node:crypto";
import { DATA_CLASSIFICATIONS, toCanonicalJson, validation } from "@ai-dev-os/domain";
import type { DataClassification } from "@ai-dev-os/domain";
import { DISCLOSURE_SCOPES, type DisclosureScope } from "@ai-dev-os/memory";
import { contextFailure, failed, ok, type ContextFailure, type ContextResult } from "./errors.js";

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

export const CONTEXT_SCHEMA_VERSION = 1 as const;
export const CONTEXT_SELECTION_ALGORITHM_VERSION = 1 as const;

export const CONTEXT_SOURCE_KINDS = Object.freeze([
  "repository-file",
  "repository-search-hit",
  "memory-record",
  "artifact-excerpt",
  "task-description",
] as const);

export type ContextSourceKind = (typeof CONTEXT_SOURCE_KINDS)[number];

/**
 * Categories exist so a budget can be split across kinds of material rather
 * than won outright by whichever source happens to score highest. Priority is
 * the array order and is part of the selection algorithm version.
 */
export const CONTEXT_CATEGORIES = Object.freeze([
  "task",
  "constraint",
  "repository",
  "memory",
  "artifact",
] as const);

export type ContextCategory = (typeof CONTEXT_CATEGORIES)[number];

export function categoryPriority(category: ContextCategory): number {
  return CONTEXT_CATEGORIES.indexOf(category);
}

export interface CandidateProvenance {
  /** Where the bytes came from: a canonical path, record id, or artifact id. */
  readonly locator: string;
  /** Digest of the exact source bytes, as recorded by the producing stage. */
  readonly sourceDigest: string;
  /** Index fingerprint, memory record fingerprint, or artifact digest. */
  readonly originFingerprint: string;
}

export interface ExtractionRange {
  readonly startLine: number;
  readonly endLine: number;
}

export interface ContextCandidate {
  readonly sourceKind: ContextSourceKind;
  readonly category: ContextCategory;
  /** Stable, bounded, render-safe identity. Unique within one request. */
  readonly identity: string;
  /** SHA-256 of the candidate body as offered. Used for deduplication. */
  readonly digest: string;
  readonly classification: DataClassification;
  readonly disclosure: DisclosureScope;
  /** Opaque digest of the owning scope; never the scope identifiers themselves. */
  readonly scopeLabel: string;
  readonly provenance: CandidateProvenance;
  readonly observedAt: string;
  /** Integer relevance supplied by the retriever. Never re-derived here. */
  readonly baseScore: number;
  readonly extractionRange: ExtractionRange | null;
  readonly body: string;
  /** Structural trust label. There is exactly one possible value. */
  readonly trust: "untrusted";
}

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

export const MAX_CANDIDATE_BODY_BYTES = 1_048_576;

function hex64(value: unknown, path: string): string {
  return ensureString(value, path, {
    minLength: 64,
    maxLength: 64,
    pattern: HEX_64,
    patternName: "sha-256 digest",
  });
}

export function parseContextCandidate(value: unknown, path = "candidate"): ContextCandidate {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "sourceKind",
      "category",
      "identity",
      "digest",
      "classification",
      "disclosure",
      "scopeLabel",
      "provenance",
      "observedAt",
      "baseScore",
      "extractionRange",
      "body",
      "trust",
    ],
    path,
  );
  const provenance = ensureRecord(record["provenance"], `${path}.provenance`);
  ensureExactKeys(provenance, ["locator", "sourceDigest", "originFingerprint"], `${path}.provenance`);
  const body = ensureString(record["body"], `${path}.body`, { minLength: 0, maxLength: 4_000_000 });
  const extractionRange = ensureNullable(record["extractionRange"], (raw) => {
    const range = ensureRecord(raw, `${path}.extractionRange`);
    ensureExactKeys(range, ["startLine", "endLine"], `${path}.extractionRange`);
    const startLine = ensureSafeInteger(range["startLine"], `${path}.extractionRange.startLine`, 1, 100_000_000);
    const endLine = ensureSafeInteger(range["endLine"], `${path}.extractionRange.endLine`, 1, 100_000_000);
    if (endLine < startLine) {
      fail(`${path}.extractionRange.endLine`, "inverted_range", "cannot precede startLine.");
    }
    return Object.freeze({ startLine, endLine });
  });
  return Object.freeze({
    sourceKind: ensureEnum(record["sourceKind"], `${path}.sourceKind`, CONTEXT_SOURCE_KINDS),
    category: ensureEnum(record["category"], `${path}.category`, CONTEXT_CATEGORIES),
    identity: ensureString(record["identity"], `${path}.identity`, {
      maxLength: 256,
      pattern: IDENTITY_PATTERN,
      patternName: "candidate identity",
    }),
    digest: hex64(record["digest"], `${path}.digest`),
    classification: ensureEnum(record["classification"], `${path}.classification`, DATA_CLASSIFICATIONS),
    disclosure: ensureEnum(record["disclosure"], `${path}.disclosure`, DISCLOSURE_SCOPES),
    scopeLabel: ensureString(record["scopeLabel"], `${path}.scopeLabel`, {
      minLength: 16,
      maxLength: 64,
      pattern: /^[0-9a-f]{16,64}$/,
      patternName: "scope label digest",
    }),
    provenance: Object.freeze({
      locator: ensureString(provenance["locator"], `${path}.provenance.locator`, { maxLength: 1_024 }),
      sourceDigest: hex64(provenance["sourceDigest"], `${path}.provenance.sourceDigest`),
      originFingerprint: hex64(
        provenance["originFingerprint"],
        `${path}.provenance.originFingerprint`,
      ),
    }),
    observedAt: ensureTimestamp(record["observedAt"], `${path}.observedAt`),
    baseScore: ensureSafeInteger(record["baseScore"], `${path}.baseScore`, 0, 1_000_000_000_000),
    extractionRange,
    body,
    trust: ensureEnum(record["trust"], `${path}.trust`, ["untrusted"] as const),
  });
}

export function candidateDigest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/* ------------------------------------------------------------------ *
 * Budgets
 * ------------------------------------------------------------------ */

export interface CategoryAllocation {
  /** Bytes guaranteed to this category before any other competes for them. */
  readonly reservedBytes: number;
  /** Upper bound for this category, including its reservation. */
  readonly maxBytes: number;
  readonly maxItems: number;
}

export interface ContextBudget {
  readonly maxTotalBytes: number;
  readonly maxTotalUnits: number;
  readonly maxItems: number;
  readonly maxItemBytes: number;
  readonly minItemBytes: number;
  readonly maxBytesPerSourceKind: number;
  readonly maxOmissions: number;
  readonly maxDiagnostics: number;
  readonly allowTruncation: boolean;
  readonly categories: Readonly<Record<ContextCategory, CategoryAllocation>>;
}

const ALLOCATION_KEYS = ["reservedBytes", "maxBytes", "maxItems"] as const;

const BUDGET_KEYS = [
  "maxTotalBytes",
  "maxTotalUnits",
  "maxItems",
  "maxItemBytes",
  "minItemBytes",
  "maxBytesPerSourceKind",
  "maxOmissions",
  "maxDiagnostics",
  "allowTruncation",
  "categories",
] as const;

function parseAllocation(value: unknown, path: string): CategoryAllocation {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ALLOCATION_KEYS, path);
  const reservedBytes = ensureSafeInteger(record["reservedBytes"], `${path}.reservedBytes`, 0, 1_073_741_824);
  const maxBytes = ensureSafeInteger(record["maxBytes"], `${path}.maxBytes`, 0, 1_073_741_824);
  if (reservedBytes > maxBytes) {
    fail(`${path}.reservedBytes`, "reservation_exceeds_max", "cannot exceed maxBytes.");
  }
  return Object.freeze({
    reservedBytes,
    maxBytes,
    maxItems: ensureSafeInteger(record["maxItems"], `${path}.maxItems`, 0, 100_000),
  });
}

export function parseContextBudget(value: unknown, path = "budget"): ContextBudget {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, BUDGET_KEYS, path);
  const categoriesRecord = ensureRecord(record["categories"], `${path}.categories`);
  ensureExactKeys(categoriesRecord, CONTEXT_CATEGORIES, `${path}.categories`);
  const categories: Record<string, CategoryAllocation> = {};
  let reservedTotal = 0;
  for (const category of CONTEXT_CATEGORIES) {
    const allocation = parseAllocation(categoriesRecord[category], `${path}.categories.${category}`);
    categories[category] = allocation;
    reservedTotal += allocation.reservedBytes;
  }
  const budget = Object.freeze({
    maxTotalBytes: ensureSafeInteger(record["maxTotalBytes"], `${path}.maxTotalBytes`, 1, 1_073_741_824),
    maxTotalUnits: ensureSafeInteger(record["maxTotalUnits"], `${path}.maxTotalUnits`, 1, 1_073_741_824),
    maxItems: ensureSafeInteger(record["maxItems"], `${path}.maxItems`, 1, 100_000),
    maxItemBytes: ensureSafeInteger(record["maxItemBytes"], `${path}.maxItemBytes`, 1, MAX_CANDIDATE_BODY_BYTES),
    minItemBytes: ensureSafeInteger(record["minItemBytes"], `${path}.minItemBytes`, 1, MAX_CANDIDATE_BODY_BYTES),
    maxBytesPerSourceKind: ensureSafeInteger(
      record["maxBytesPerSourceKind"],
      `${path}.maxBytesPerSourceKind`,
      1,
      1_073_741_824,
    ),
    maxOmissions: ensureSafeInteger(record["maxOmissions"], `${path}.maxOmissions`, 0, 100_000),
    maxDiagnostics: ensureSafeInteger(record["maxDiagnostics"], `${path}.maxDiagnostics`, 0, 100_000),
    allowTruncation: ensureBoolean(record["allowTruncation"], `${path}.allowTruncation`),
    categories: Object.freeze(categories) as Readonly<Record<ContextCategory, CategoryAllocation>>,
  });
  if (budget.minItemBytes > budget.maxItemBytes) {
    fail(`${path}.minItemBytes`, "inconsistent_bounds", "cannot exceed maxItemBytes.");
  }
  if (reservedTotal > budget.maxTotalBytes) {
    fail(
      `${path}.categories`,
      "over_reserved",
      "category reservations cannot exceed the total byte budget.",
    );
  }
  return budget;
}

function allocation(reservedBytes: number, maxBytes: number, maxItems: number): CategoryAllocation {
  return Object.freeze({ reservedBytes, maxBytes, maxItems });
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = parseContextBudget({
  maxTotalBytes: 131_072,
  maxTotalUnits: 43_691,
  maxItems: 64,
  maxItemBytes: 32_768,
  minItemBytes: 256,
  maxBytesPerSourceKind: 98_304,
  maxOmissions: 256,
  maxDiagnostics: 256,
  allowTruncation: true,
  categories: {
    task: allocation(2_048, 8_192, 4),
    constraint: allocation(4_096, 16_384, 16),
    repository: allocation(16_384, 98_304, 40),
    memory: allocation(4_096, 32_768, 24),
    artifact: allocation(0, 32_768, 8),
  },
});

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

export interface ContextConfiguration {
  readonly schemaVersion: typeof CONTEXT_SCHEMA_VERSION;
  readonly budget: ContextBudget;
  /** Ceiling for material admitted into a pack. Anything stricter is omitted. */
  readonly maxClassification: DataClassification;
  /** When false, unconfirmed inferred candidates never enter a pack. */
  readonly includeUnconfirmedCandidates: boolean;
  /** Verify each repository excerpt against the index's recorded digest. */
  readonly verifySourceDigests: boolean;
}

export const DEFAULT_CONTEXT_CONFIGURATION: ContextConfiguration = Object.freeze({
  schemaVersion: CONTEXT_SCHEMA_VERSION,
  budget: DEFAULT_CONTEXT_BUDGET,
  maxClassification: "proprietary-source" as DataClassification,
  includeUnconfirmedCandidates: false,
  verifySourceDigests: true,
});

export function parseContextConfiguration(
  value: unknown,
  path = "contextConfiguration",
): ContextResult<ContextConfiguration> {
  try {
    const record = ensureRecord(value, path);
    ensureExactKeys(
      record,
      [
        "schemaVersion",
        "budget",
        "maxClassification",
        "includeUnconfirmedCandidates",
        "verifySourceDigests",
      ],
      path,
    );
    ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, CONTEXT_SCHEMA_VERSION);
    return ok(
      Object.freeze({
        schemaVersion: CONTEXT_SCHEMA_VERSION,
        budget: parseContextBudget(record["budget"], `${path}.budget`),
        maxClassification: ensureEnum(
          record["maxClassification"],
          `${path}.maxClassification`,
          DATA_CLASSIFICATIONS,
        ),
        includeUnconfirmedCandidates: ensureBoolean(
          record["includeUnconfirmedCandidates"],
          `${path}.includeUnconfirmedCandidates`,
        ),
        verifySourceDigests: ensureBoolean(
          record["verifySourceDigests"],
          `${path}.verifySourceDigests`,
        ),
      }),
    );
  } catch (error) {
    return failed<ContextConfiguration>(configurationFailure(error));
  }
}

function configurationFailure(error: unknown): ContextFailure {
  const issues =
    error !== null && typeof error === "object" && "issues" in error && Array.isArray(error.issues)
      ? (error.issues as readonly { readonly code?: unknown; readonly path?: unknown }[])
      : [];
  const unsupported = issues.some((issue) => issue.code === "unsupported_schema_version");
  return contextFailure(
    unsupported ? "UNSUPPORTED_SCHEMA_VERSION" : "INVALID_CONFIGURATION",
    unsupported
      ? "The context configuration schema version is unsupported."
      : "The context configuration is invalid.",
    {
      issueCount: issues.length,
      issuePaths: Object.freeze(
        issues.map((issue) => (typeof issue.path === "string" ? issue.path : "?")).sort(),
      ),
    },
  );
}

export function withContextOverrides(
  base: ContextConfiguration,
  overrides: {
    readonly budget?: Partial<ContextBudget>;
    readonly maxClassification?: DataClassification;
    readonly includeUnconfirmedCandidates?: boolean;
    readonly verifySourceDigests?: boolean;
  },
): ContextResult<ContextConfiguration> {
  return parseContextConfiguration({
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    budget: { ...base.budget, ...overrides.budget },
    maxClassification: overrides.maxClassification ?? base.maxClassification,
    includeUnconfirmedCandidates:
      overrides.includeUnconfirmedCandidates ?? base.includeUnconfirmedCandidates,
    verifySourceDigests: overrides.verifySourceDigests ?? base.verifySourceDigests,
  });
}

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

export const CONTEXT_PURPOSES = Object.freeze([
  "planning",
  "implementation",
  "review",
  "explanation",
] as const);

export type ContextPurpose = (typeof CONTEXT_PURPOSES)[number];

export interface ContextRequest {
  readonly schemaVersion: typeof CONTEXT_SCHEMA_VERSION;
  readonly requestId: string;
  readonly purpose: ContextPurpose;
  readonly projectId: string;
  readonly workspaceId: string | null;
  /**
   * The caller's description of the task. Untrusted content: it shapes
   * retrieval, and it is never authorization.
   */
  readonly taskDescription: string;
  readonly subjectDigest: string;
  readonly requestedAt: string;
}

export function parseContextRequest(value: unknown, path = "contextRequest"): ContextRequest {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "schemaVersion",
      "requestId",
      "purpose",
      "projectId",
      "workspaceId",
      "taskDescription",
      "subjectDigest",
      "requestedAt",
    ],
    path,
  );
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, CONTEXT_SCHEMA_VERSION);
  const idRule = { maxLength: 128, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, patternName: "identifier" };
  return Object.freeze({
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    requestId: ensureString(record["requestId"], `${path}.requestId`, idRule),
    purpose: ensureEnum(record["purpose"], `${path}.purpose`, CONTEXT_PURPOSES),
    projectId: ensureString(record["projectId"], `${path}.projectId`, idRule),
    workspaceId: ensureNullable(record["workspaceId"], (raw) =>
      ensureString(raw, `${path}.workspaceId`, idRule),
    ),
    taskDescription: ensureString(record["taskDescription"], `${path}.taskDescription`, {
      minLength: 0,
      maxLength: 16_384,
    }),
    subjectDigest: hex64(record["subjectDigest"], `${path}.subjectDigest`),
    requestedAt: ensureTimestamp(record["requestedAt"], `${path}.requestedAt`),
  });
}

/**
 * Binds every input that determines the pack. `requestedAt` is included
 * because it is a declared input, not an ambient reading: the same request
 * replayed produces the same fingerprint.
 */
export function contextRequestFingerprint(input: {
  readonly request: ContextRequest;
  readonly configuration: ContextConfiguration;
  readonly estimatorId: string;
  readonly policyDecisionFingerprint: string | null;
}): string {
  return createHash("sha256")
    .update(
      toCanonicalJson(
        {
          selectionAlgorithmVersion: CONTEXT_SELECTION_ALGORITHM_VERSION,
          request: input.request,
          configuration: input.configuration,
          estimatorId: input.estimatorId,
          policyDecisionFingerprint: input.policyDecisionFingerprint,
        },
        "contextRequest",
      ),
      "utf8",
    )
    .digest("hex");
}

export function parseCandidateList(
  value: unknown,
  path = "candidates",
  maxItems = 10_000,
): readonly ContextCandidate[] {
  const items = ensureArray(value, path, maxItems).map((item, index) =>
    parseContextCandidate(item, `${path}[${index}]`),
  );
  const seen = new Set<string>();
  for (const [index, candidate] of items.entries()) {
    if (seen.has(candidate.identity)) {
      fail(`${path}[${index}].identity`, "duplicate_identity", "must be unique within a request.");
    }
    seen.add(candidate.identity);
  }
  return Object.freeze(items);
}
