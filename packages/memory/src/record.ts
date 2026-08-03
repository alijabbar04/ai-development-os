/**
 * The memory record vocabulary.
 *
 * Records are immutable values. Everything that could change later — whether
 * a candidate was confirmed, whether a record was superseded or tombstoned —
 * lives in the entry state alongside the record, so no amount of history
 * rewriting can quietly alter what was originally asserted.
 *
 * Two rules shape the whole schema:
 *
 * 1. **A record cannot widen anything.** There is no permission field, no
 *    grant, no capability, no provider eligibility, and no disclosure
 *    upgrade. Content that says "you are authorized" is a string.
 * 2. **Nothing large or secret lives here.** A body is either bounded
 *    sanitized text, a reference to an existing artifact, a reference to an
 *    existing secret, or explicitly withheld. Credentials are refused at the
 *    door rather than stored and hidden.
 */

import { createHash } from "node:crypto";
import {
  DATA_CLASSIFICATIONS,
  toCanonicalJson,
  validation,
  type DataClassification,
} from "@ai-dev-os/domain";
import { parseArtifactDigest, type ArtifactDigest } from "@ai-dev-os/artifacts";
import { detectSecretLikeText, sanitizeBodyText } from "./redaction.js";
import {
  createMemorySubject,
  parseMemoryScope,
  parseMemorySubject,
  type MemoryScope,
  type MemorySubject,
} from "./scope.js";

const {
  ensureArray,
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

export const MEMORY_RECORD_SCHEMA_VERSION = 1 as const;

export const MEMORY_RECORD_VARIANTS = Object.freeze([
  "verified-fact",
  "decision",
  "summary",
  "explicit-preference",
  "inferred-preference-candidate",
  "constraint",
  "tombstone",
] as const);

export type MemoryRecordVariant = (typeof MEMORY_RECORD_VARIANTS)[number];

export const MEMORY_AUTHOR_CLASSES = Object.freeze([
  "user-explicit",
  "tool-observed",
  "model-suggested",
  "imported",
] as const);

export type MemoryAuthorClass = (typeof MEMORY_AUTHOR_CLASSES)[number];

export const MEMORY_CAPTURE_METHODS = Object.freeze([
  "user-entry",
  "tool-observation",
  "model-inference",
  "import",
  "derivation",
  "system",
] as const);

export type MemoryCaptureMethod = (typeof MEMORY_CAPTURE_METHODS)[number];

export const MEMORY_SOURCE_KINDS = Object.freeze([
  "repository-file",
  "artifact",
  "user-statement",
  "tool-output",
  "model-output",
  "imported",
] as const);

export type MemorySourceKind = (typeof MEMORY_SOURCE_KINDS)[number];

export const DISCLOSURE_SCOPES = Object.freeze([
  "scope-only",
  "project-internal",
  "organization-internal",
] as const);

/**
 * How far a record may travel. There is deliberately no "public" or
 * "shareable" member: memory can never be the thing that authorizes wider
 * disclosure than the data classification already permits.
 */
export type DisclosureScope = (typeof DISCLOSURE_SCOPES)[number];

export const WITHHELD_REASONS = Object.freeze([
  "unauthorized",
  "sensitivity",
  "tombstoned",
  "expired",
] as const);

export type WithheldReason = (typeof WITHHELD_REASONS)[number];

export const MAX_BODY_TEXT_LENGTH = 8_192;
export const MAX_SOURCES = 16;
export const MAX_LABELS = 16;
export const CONFIDENCE_SCALE = 1_000;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LABEL_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

/** A pointer to bytes that live in the artifact store; never a copy of them. */
export interface MemoryArtifactReference {
  readonly artifactId: string;
  readonly digest: ArtifactDigest;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly classification: DataClassification;
}

/**
 * A pointer to a secret held by the Stage 6 secret broker.
 *
 * Only a fingerprint and a display label are carried. Those are exactly the
 * values `secretRefFingerprint` and `secretRefDisplay` produce, so a caller
 * that has the real `SecretRef` can round-trip through this handle without
 * this package depending on the secrets contracts — which would in turn drag
 * in the provider and policy packages Stage 14 must not import.
 */
export interface SecretReferenceHandle {
  readonly refFingerprint: string;
  readonly display: string;
}

export type MemoryBody =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "artifact"; readonly reference: MemoryArtifactReference }
  | { readonly kind: "secret-reference"; readonly reference: SecretReferenceHandle }
  | { readonly kind: "withheld"; readonly reason: WithheldReason };

export const MEMORY_BODY_KINDS = Object.freeze([
  "text",
  "artifact",
  "secret-reference",
  "withheld",
] as const);

export interface MemoryProvenanceSource {
  readonly kind: MemorySourceKind;
  /** SHA-256 of the exact bytes this fact came from, when there are bytes. */
  readonly digest: string | null;
  /** Bounded, sanitized locator: a canonical path or an artifact id. */
  readonly locator: string | null;
}

export interface MemoryProvenance {
  readonly captureMethod: MemoryCaptureMethod;
  readonly sources: readonly MemoryProvenanceSource[];
  /** The component that recorded this, not a human identity. */
  readonly recordedBy: string;
}

export interface MemoryRecord {
  readonly schemaVersion: typeof MEMORY_RECORD_SCHEMA_VERSION;
  readonly recordId: string;
  readonly variant: MemoryRecordVariant;
  readonly scope: MemoryScope;
  readonly subject: MemorySubject;
  readonly authorClass: MemoryAuthorClass;
  readonly provenance: MemoryProvenance;
  readonly body: MemoryBody;
  /** Permille (0-1000). Only meaningful where the variant admits uncertainty. */
  readonly confidence: number | null;
  readonly classification: DataClassification;
  readonly disclosure: DisclosureScope;
  readonly createdAt: string;
  readonly observedAt: string;
  readonly expiresAt: string | null;
  readonly supersedes: string | null;
  readonly tombstoneOf: string | null;
  readonly labels: readonly string[];
  readonly contentDigest: string;
  readonly fingerprint: string;
}

const RECORD_KEYS = [
  "schemaVersion",
  "recordId",
  "variant",
  "scope",
  "subject",
  "authorClass",
  "provenance",
  "body",
  "confidence",
  "classification",
  "disclosure",
  "createdAt",
  "observedAt",
  "expiresAt",
  "supersedes",
  "tombstoneOf",
  "labels",
  "contentDigest",
  "fingerprint",
] as const;

/** Variants where a confidence value is meaningful; elsewhere it must be null. */
const CONFIDENCE_BEARING = new Set<MemoryRecordVariant>([
  "inferred-preference-candidate",
  "summary",
]);

/** Author classes that may produce each variant. Forged provenance is refused. */
const PERMITTED_AUTHORS: Readonly<Record<MemoryRecordVariant, readonly MemoryAuthorClass[]>> =
  Object.freeze({
    "verified-fact": Object.freeze(["user-explicit", "tool-observed", "imported"] as const),
    decision: Object.freeze(["user-explicit", "imported"] as const),
    summary: Object.freeze([
      "user-explicit",
      "tool-observed",
      "model-suggested",
      "imported",
    ] as const),
    "explicit-preference": Object.freeze(["user-explicit"] as const),
    "inferred-preference-candidate": Object.freeze(["tool-observed", "model-suggested"] as const),
    constraint: Object.freeze(["user-explicit", "tool-observed", "imported"] as const),
    tombstone: Object.freeze(["user-explicit", "tool-observed", "imported"] as const),
  });

/** Capture methods each author class may claim. */
const PERMITTED_CAPTURE: Readonly<Record<MemoryAuthorClass, readonly MemoryCaptureMethod[]>> =
  Object.freeze({
    "user-explicit": Object.freeze(["user-entry", "system"] as const),
    "tool-observed": Object.freeze(["tool-observation", "derivation", "system"] as const),
    "model-suggested": Object.freeze(["model-inference", "derivation"] as const),
    imported: Object.freeze(["import", "system"] as const),
  });

function parseArtifactReference(value: unknown, path: string): MemoryArtifactReference {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["artifactId", "digest", "mediaType", "sizeBytes", "classification"], path);
  return Object.freeze({
    artifactId: ensureString(record["artifactId"], `${path}.artifactId`, {
      maxLength: 128,
      pattern: ID_PATTERN,
      patternName: "ArtifactId",
    }),
    digest: parseArtifactDigest(record["digest"], `${path}.digest`),
    mediaType: ensureString(record["mediaType"], `${path}.mediaType`, {
      maxLength: 128,
      pattern: MEDIA_TYPE_PATTERN,
      patternName: "media type",
    }),
    sizeBytes: ensureSafeInteger(record["sizeBytes"], `${path}.sizeBytes`, 0, 1_000_000_000_000),
    classification: ensureEnum(record["classification"], `${path}.classification`, DATA_CLASSIFICATIONS),
  });
}

function parseSecretReference(value: unknown, path: string): SecretReferenceHandle {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["refFingerprint", "display"], path);
  const display = ensureString(record["display"], `${path}.display`, { maxLength: 256 });
  // A display label is metadata. If it looks like the credential itself, the
  // caller has passed the wrong thing and the record is refused.
  if (detectSecretLikeText(display).secretLike) {
    fail(`${path}.display`, "secret_in_display", "must not contain credential material.");
  }
  return Object.freeze({
    refFingerprint: ensureString(record["refFingerprint"], `${path}.refFingerprint`, {
      minLength: 64,
      maxLength: 64,
      pattern: HEX_64,
      patternName: "secret reference fingerprint",
    }),
    display,
  });
}

export function parseMemoryBody(value: unknown, path = "body"): MemoryBody {
  const record = ensureRecord(value, path);
  const kind = ensureEnum(record["kind"], `${path}.kind`, MEMORY_BODY_KINDS);
  switch (kind) {
    case "text": {
      ensureExactKeys(record, ["kind", "text"], path);
      const raw = ensureString(record["text"], `${path}.text`, {
        minLength: 1,
        maxLength: MAX_BODY_TEXT_LENGTH,
      });
      const text = sanitizeBodyText(raw, MAX_BODY_TEXT_LENGTH);
      if (text !== raw) {
        fail(`${path}.text`, "unsanitized_text", "must not contain control or invisible characters.");
      }
      const verdict = detectSecretLikeText(text);
      if (verdict.secretLike) {
        fail(
          `${path}.text`,
          "secret_material",
          `resembles authentication material (${verdict.signatures.join(", ")}); store a secret reference instead.`,
        );
      }
      return Object.freeze({ kind, text });
    }
    case "artifact":
      ensureExactKeys(record, ["kind", "reference"], path);
      return Object.freeze({ kind, reference: parseArtifactReference(record["reference"], `${path}.reference`) });
    case "secret-reference":
      ensureExactKeys(record, ["kind", "reference"], path);
      return Object.freeze({ kind, reference: parseSecretReference(record["reference"], `${path}.reference`) });
    case "withheld":
      ensureExactKeys(record, ["kind", "reason"], path);
      return Object.freeze({
        kind,
        reason: ensureEnum(record["reason"], `${path}.reason`, WITHHELD_REASONS),
      });
  }
}

function parseProvenance(value: unknown, path: string): MemoryProvenance {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["captureMethod", "sources", "recordedBy"], path);
  const sources = ensureArray(record["sources"], `${path}.sources`, MAX_SOURCES).map((item, index) => {
    const entry = ensureRecord(item, `${path}.sources[${index}]`);
    ensureExactKeys(entry, ["kind", "digest", "locator"], `${path}.sources[${index}]`);
    const locator = ensureNullable(entry["locator"], (raw) =>
      ensureString(raw, `${path}.sources[${index}].locator`, { maxLength: 1_024 }),
    );
    if (locator !== null && sanitizeBodyText(locator, 1_024) !== locator) {
      fail(
        `${path}.sources[${index}].locator`,
        "unsanitized_locator",
        "must not contain control or invisible characters.",
      );
    }
    return Object.freeze({
      kind: ensureEnum(entry["kind"], `${path}.sources[${index}].kind`, MEMORY_SOURCE_KINDS),
      digest: ensureNullable(entry["digest"], (raw) =>
        ensureString(raw, `${path}.sources[${index}].digest`, {
          minLength: 64,
          maxLength: 64,
          pattern: HEX_64,
          patternName: "sha-256 digest",
        }),
      ),
      locator,
    });
  });
  return Object.freeze({
    captureMethod: ensureEnum(record["captureMethod"], `${path}.captureMethod`, MEMORY_CAPTURE_METHODS),
    // Sorted so that source ordering cannot change a record's fingerprint.
    sources: Object.freeze(
      [...sources].sort(
        (a, b) =>
          compare(a.kind, b.kind) || compare(a.digest ?? "", b.digest ?? "") || compare(a.locator ?? "", b.locator ?? ""),
      ),
    ),
    recordedBy: ensureString(record["recordedBy"], `${path}.recordedBy`, {
      maxLength: 128,
      pattern: ID_PATTERN,
      patternName: "component identifier",
    }),
  });
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Content identity: the subject plus the body, independent of timing or ids. */
export function memoryContentDigest(subject: MemorySubject, body: MemoryBody): string {
  return createHash("sha256")
    .update(toCanonicalJson({ subject: subject.digest, body }, "memoryContent"), "utf8")
    .digest("hex");
}

export function memoryRecordFingerprint(record: Omit<MemoryRecord, "fingerprint">): string {
  return createHash("sha256")
    .update(toCanonicalJson(record, "memoryRecord"), "utf8")
    .digest("hex");
}

function checkInvariants(record: Omit<MemoryRecord, "fingerprint">, path: string): void {
  const permittedAuthors = PERMITTED_AUTHORS[record.variant];
  if (!permittedAuthors.includes(record.authorClass)) {
    fail(
      `${path}.authorClass`,
      "author_not_permitted",
      `a ${record.variant} cannot be authored by ${record.authorClass}.`,
    );
  }
  const permittedCapture = PERMITTED_CAPTURE[record.authorClass];
  if (!permittedCapture.includes(record.provenance.captureMethod)) {
    fail(
      `${path}.provenance.captureMethod`,
      "capture_method_not_permitted",
      `a ${record.authorClass} author cannot claim capture method ${record.provenance.captureMethod}.`,
    );
  }
  if (CONFIDENCE_BEARING.has(record.variant)) {
    if (record.confidence === null) {
      fail(`${path}.confidence`, "confidence_required", `is required for a ${record.variant}.`);
    }
  } else if (record.confidence !== null) {
    fail(`${path}.confidence`, "confidence_not_meaningful", `is not meaningful for a ${record.variant}.`);
  }
  if (record.variant === "verified-fact") {
    if (!record.provenance.sources.some((source) => source.digest !== null)) {
      fail(
        `${path}.provenance.sources`,
        "unverifiable_fact",
        "a verified fact requires at least one source with a content digest.",
      );
    }
  }
  if (record.variant === "tombstone") {
    if (record.tombstoneOf === null) {
      fail(`${path}.tombstoneOf`, "tombstone_target_required", "a tombstone must name its target.");
    }
    if (record.body.kind !== "withheld" || record.body.reason !== "tombstoned") {
      fail(`${path}.body`, "tombstone_body", "a tombstone carries no body.");
    }
    if (record.expiresAt !== null) {
      fail(`${path}.expiresAt`, "tombstone_expiry", "a tombstone never expires.");
    }
  } else if (record.tombstoneOf !== null) {
    fail(`${path}.tombstoneOf`, "tombstone_target_unexpected", "only a tombstone may name a target.");
  }
  if (record.supersedes === record.recordId) {
    fail(`${path}.supersedes`, "self_supersession", "a record cannot supersede itself.");
  }
  if (record.tombstoneOf === record.recordId) {
    fail(`${path}.tombstoneOf`, "self_tombstone", "a record cannot tombstone itself.");
  }
  if (record.expiresAt !== null && record.expiresAt <= record.observedAt) {
    fail(`${path}.expiresAt`, "expiry_not_future", "must be after the observation time.");
  }
  if (record.observedAt > record.createdAt) {
    fail(`${path}.observedAt`, "observation_after_creation", "cannot be later than createdAt.");
  }
  const expected = memoryContentDigest(record.subject, record.body);
  if (record.contentDigest !== expected) {
    fail(`${path}.contentDigest`, "content_digest_mismatch", "does not match the subject and body.");
  }
}

const CORE_KEYS = RECORD_KEYS.filter((key) => key !== "fingerprint");

/**
 * Validates and normalizes everything except the fingerprint.
 *
 * Normalization is part of validation here: labels are sorted and
 * de-duplicated and provenance sources are sorted, so two callers who supply
 * the same facts in different orders produce the same fingerprint. That is why
 * the fingerprint is always computed from the *parsed* value, never from the
 * caller's draft.
 */
function parseRecordCore(
  value: unknown,
  path: string,
  expectFingerprint: boolean,
): Omit<MemoryRecord, "fingerprint"> {
  const raw = ensureRecord(value, path);
  ensureExactKeys(raw, expectFingerprint ? RECORD_KEYS : CORE_KEYS, path);
  ensureSchemaVersion(raw["schemaVersion"], `${path}.schemaVersion`, MEMORY_RECORD_SCHEMA_VERSION);

  const labels = ensureArray(raw["labels"], `${path}.labels`, MAX_LABELS).map((item, index) =>
    ensureString(item, `${path}.labels[${index}]`, {
      maxLength: 64,
      pattern: LABEL_PATTERN,
      patternName: "label",
    }),
  );

  const unsealed: Omit<MemoryRecord, "fingerprint"> = {
    schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
    recordId: ensureString(raw["recordId"], `${path}.recordId`, {
      maxLength: 128,
      pattern: ID_PATTERN,
      patternName: "record id",
    }),
    variant: ensureEnum(raw["variant"], `${path}.variant`, MEMORY_RECORD_VARIANTS),
    scope: parseMemoryScope(raw["scope"], `${path}.scope`),
    subject: parseMemorySubject(raw["subject"], `${path}.subject`),
    authorClass: ensureEnum(raw["authorClass"], `${path}.authorClass`, MEMORY_AUTHOR_CLASSES),
    provenance: parseProvenance(raw["provenance"], `${path}.provenance`),
    body: parseMemoryBody(raw["body"], `${path}.body`),
    confidence: ensureNullable(raw["confidence"], (item) =>
      ensureSafeInteger(item, `${path}.confidence`, 0, CONFIDENCE_SCALE),
    ),
    classification: ensureEnum(raw["classification"], `${path}.classification`, DATA_CLASSIFICATIONS),
    disclosure: ensureEnum(raw["disclosure"], `${path}.disclosure`, DISCLOSURE_SCOPES),
    createdAt: ensureTimestamp(raw["createdAt"], `${path}.createdAt`),
    observedAt: ensureTimestamp(raw["observedAt"], `${path}.observedAt`),
    expiresAt: ensureNullable(raw["expiresAt"], (item) => ensureTimestamp(item, `${path}.expiresAt`)),
    supersedes: ensureNullable(raw["supersedes"], (item) =>
      ensureString(item, `${path}.supersedes`, {
        maxLength: 128,
        pattern: ID_PATTERN,
        patternName: "record id",
      }),
    ),
    tombstoneOf: ensureNullable(raw["tombstoneOf"], (item) =>
      ensureString(item, `${path}.tombstoneOf`, {
        maxLength: 128,
        pattern: ID_PATTERN,
        patternName: "record id",
      }),
    ),
    labels: Object.freeze([...new Set(labels)].sort()),
    contentDigest: ensureString(raw["contentDigest"], `${path}.contentDigest`, {
      minLength: 64,
      maxLength: 64,
      pattern: HEX_64,
      patternName: "sha-256 digest",
    }),
  };

  checkInvariants(unsealed, path);
  return Object.freeze(unsealed);
}

export function parseMemoryRecord(value: unknown, path = "memoryRecord"): MemoryRecord {
  const core = parseRecordCore(value, path, true);
  const fingerprint = memoryRecordFingerprint(core);
  const declared = ensureString(
    (value as Record<string, unknown>)["fingerprint"],
    `${path}.fingerprint`,
    { minLength: 64, maxLength: 64, pattern: HEX_64, patternName: "sha-256 digest" },
  );
  if (declared !== fingerprint) {
    fail(`${path}.fingerprint`, "fingerprint_mismatch", "does not match the record content.");
  }
  return Object.freeze({ ...core, fingerprint });
}

export interface CreateMemoryRecordInput {
  readonly recordId: string;
  readonly variant: MemoryRecordVariant;
  readonly scope: MemoryScope;
  readonly subject: string | MemorySubject;
  readonly authorClass: MemoryAuthorClass;
  readonly provenance: MemoryProvenance;
  readonly body: MemoryBody;
  readonly confidence?: number | null;
  readonly classification: DataClassification;
  readonly disclosure: DisclosureScope;
  readonly createdAt: string;
  readonly observedAt?: string;
  readonly expiresAt?: string | null;
  readonly supersedes?: string | null;
  readonly tombstoneOf?: string | null;
  readonly labels?: readonly string[];
}

/** Builds a record, computing the content digest and fingerprint. */
export function createMemoryRecord(input: CreateMemoryRecordInput): MemoryRecord {
  const normalizedSubject =
    typeof input.subject === "string"
      ? createMemorySubject(input.subject)
      : parseMemorySubject(input.subject);
  const body = parseMemoryBody(input.body);
  const core = parseRecordCore(
    {
      schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
      recordId: input.recordId,
      variant: input.variant,
      scope: input.scope,
      subject: normalizedSubject,
      authorClass: input.authorClass,
      provenance: input.provenance,
      body,
      confidence: input.confidence ?? null,
      classification: input.classification,
      disclosure: input.disclosure,
      createdAt: input.createdAt,
      observedAt: input.observedAt ?? input.createdAt,
      expiresAt: input.expiresAt ?? null,
      supersedes: input.supersedes ?? null,
      tombstoneOf: input.tombstoneOf ?? null,
      labels: input.labels ?? [],
      contentDigest: memoryContentDigest(normalizedSubject, body),
    },
    "memoryRecord",
    false,
  );
  return Object.freeze({ ...core, fingerprint: memoryRecordFingerprint(core) });
}

/** True when the record is a preference the user stated themselves. */
export function isExplicitPreference(record: MemoryRecord): boolean {
  return record.variant === "explicit-preference";
}

/** True when the record is an unconfirmed inference and must be shown as such. */
export function isInferredCandidate(record: MemoryRecord): boolean {
  return record.variant === "inferred-preference-candidate";
}

export function isExpiredAt(record: MemoryRecord, now: Date): boolean {
  return record.expiresAt !== null && record.expiresAt <= now.toISOString();
}
