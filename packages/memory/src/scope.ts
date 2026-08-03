/**
 * Scope, subject, and authorization.
 *
 * A memory record belongs to exactly one scope tuple. There is no wildcard, no
 * "nearest match", and no widening: a read for one scope can only ever see
 * records stored under an identical tuple, and the storage key is derived from
 * the whole tuple so a cross-scope read is not merely refused but
 * unrepresentable at the port.
 *
 * Authorization is an injected port with deny-by-default semantics. Anything
 * other than an explicit `allowed` decision — a denial, a conditional
 * decision, a thrown error, a malformed response — refuses the operation. The
 * port is deliberately narrow rather than a direct dependency on the Stage 6
 * policy broker: that broker's request type requires provider and trace
 * metadata this stage has no business knowing, and depending on it would drag
 * the provider contracts into a package that must not import them. A Stage 6
 * adapter satisfies this interface in a few lines.
 */

import { createHash } from "node:crypto";
import { DATA_CLASSIFICATIONS, toCanonicalJson, validation } from "@ai-dev-os/domain";
import type { DataClassification } from "@ai-dev-os/domain";
import { memoryFailure, type MemoryFailure } from "./errors.js";

const { ensureBoolean, ensureEnum, ensureExactKeys, ensureNullable, ensureRecord, ensureString, fail } =
  validation;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * The full scope tuple. Every component is explicit; `null` means "this record
 * is not scoped to one" and is matched exactly, never treated as a wildcard.
 */
export interface MemoryScope {
  readonly userId: string | null;
  readonly organizationId: string | null;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
}

const SCOPE_KEYS = ["userId", "organizationId", "projectId", "workspaceId"] as const;

export function parseMemoryScope(value: unknown, path = "scope"): MemoryScope {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, SCOPE_KEYS, path);
  const parsed = Object.freeze({
    userId: nullableId(record["userId"], `${path}.userId`),
    organizationId: nullableId(record["organizationId"], `${path}.organizationId`),
    projectId: nullableId(record["projectId"], `${path}.projectId`),
    workspaceId: nullableId(record["workspaceId"], `${path}.workspaceId`),
  });
  if (SCOPE_KEYS.every((key) => parsed[key] === null)) {
    fail(path, "empty_scope", "must bind at least one scope identifier.");
  }
  return parsed;
}

function nullableId(value: unknown, path: string): string | null {
  return ensureNullable(value, (raw) =>
    ensureString(raw, path, { maxLength: 128, pattern: ID_PATTERN, patternName: "identifier" }),
  );
}

/**
 * Canonical storage key. Components are length-prefixed so that no combination
 * of identifiers can be re-spelled to produce another scope's key.
 */
export function memoryScopeKey(scope: MemoryScope): string {
  return SCOPE_KEYS.map((key) => {
    const value = scope[key];
    return value === null ? `${key}:-` : `${key}:${value.length}:${value}`;
  }).join("|");
}

export function memoryScopeEquals(a: MemoryScope, b: MemoryScope): boolean {
  return SCOPE_KEYS.every((key) => a[key] === b[key]);
}

/**
 * The normalized thing a record is about. Normalization is deterministic and
 * lossy on purpose: case is folded, whitespace collapsed, and the result is
 * bounded, so the same topic recorded twice produces the same digest.
 */
export interface MemorySubject {
  readonly text: string;
  readonly digest: string;
}

export const MAX_SUBJECT_LENGTH = 256;

export function normalizeSubject(raw: string): string {
  let collapsed = "";
  let pendingSpace = false;
  for (const character of raw.normalize("NFC")) {
    const code = character.codePointAt(0) ?? 0;
    const isSpace = character === " " || character === "\t" || character === "\n" || character === "\r";
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      if (!isSpace) {
        continue;
      }
    }
    if (isSpace) {
      pendingSpace = collapsed.length > 0;
      continue;
    }
    if (pendingSpace) {
      collapsed += " ";
      pendingSpace = false;
    }
    collapsed += character;
  }
  return collapsed.toLowerCase().slice(0, MAX_SUBJECT_LENGTH);
}

export function createMemorySubject(raw: unknown, path = "subject"): MemorySubject {
  const text = normalizeSubject(
    ensureString(raw, path, { minLength: 1, maxLength: 4_096 }),
  );
  if (text.length === 0) {
    fail(path, "empty_subject", "must contain at least one printable character.");
  }
  return Object.freeze({
    text,
    digest: createHash("sha256").update(text, "utf8").digest("hex"),
  });
}

export function parseMemorySubject(value: unknown, path = "subject"): MemorySubject {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["text", "digest"], path);
  const text = ensureString(record["text"], `${path}.text`, {
    minLength: 1,
    maxLength: MAX_SUBJECT_LENGTH,
  });
  const digest = ensureString(record["digest"], `${path}.digest`, {
    minLength: 64,
    maxLength: 64,
    pattern: /^[0-9a-f]{64}$/,
    patternName: "sha-256 digest",
  });
  if (createHash("sha256").update(text, "utf8").digest("hex") !== digest) {
    fail(`${path}.digest`, "subject_digest_mismatch", "does not match the normalized subject.");
  }
  if (normalizeSubject(text) !== text) {
    fail(`${path}.text`, "subject_not_normalized", "must already be normalized.");
  }
  return Object.freeze({ text, digest });
}

/* ------------------------------------------------------------------ *
 * Authorization
 * ------------------------------------------------------------------ */

export const MEMORY_OPERATIONS = Object.freeze([
  "append",
  "read",
  "query",
  "confirm",
  "supersede",
  "tombstone",
  "snapshot",
] as const);

export type MemoryOperation = (typeof MEMORY_OPERATIONS)[number];

export const MEMORY_PURPOSES = Object.freeze([
  "context-assembly",
  "user-review",
  "maintenance",
  "export",
] as const);

export type MemoryPurpose = (typeof MEMORY_PURPOSES)[number];

export interface MemoryAuthorizationRequest {
  readonly operation: MemoryOperation;
  readonly scope: MemoryScope;
  readonly subjectDigest: string | null;
  readonly classification: DataClassification;
  readonly purpose: MemoryPurpose;
  /** True when the operation would reveal record bodies, not just metadata. */
  readonly disclosesBody: boolean;
}

export const AUTHORIZATION_OUTCOMES = Object.freeze(["allowed", "denied", "conditional"] as const);
export type AuthorizationOutcome = (typeof AUTHORIZATION_OUTCOMES)[number];

export interface MemoryAuthorizationDecision {
  readonly outcome: AuthorizationOutcome;
  readonly reasonCode: string;
  /** Even an allowed decision may withhold bodies while permitting metadata. */
  readonly bodyDisclosureAllowed: boolean;
  readonly decisionFingerprint: string | null;
}

export interface MemoryAuthorizer {
  authorize(
    request: MemoryAuthorizationRequest,
  ): MemoryAuthorizationDecision | Promise<MemoryAuthorizationDecision>;
}

export function parseAuthorizationDecision(
  value: unknown,
  path = "authorizationDecision",
): MemoryAuthorizationDecision {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    ["outcome", "reasonCode", "bodyDisclosureAllowed", "decisionFingerprint"],
    path,
  );
  return Object.freeze({
    outcome: ensureEnum(record["outcome"], `${path}.outcome`, AUTHORIZATION_OUTCOMES),
    reasonCode: ensureString(record["reasonCode"], `${path}.reasonCode`, {
      maxLength: 64,
      pattern: /^[A-Z][A-Z0-9_]{0,63}$/,
      patternName: "reason code",
    }),
    bodyDisclosureAllowed: ensureBoolean(
      record["bodyDisclosureAllowed"],
      `${path}.bodyDisclosureAllowed`,
    ),
    decisionFingerprint: ensureNullable(record["decisionFingerprint"], (raw) =>
      ensureString(raw, `${path}.decisionFingerprint`, {
        minLength: 64,
        maxLength: 64,
        pattern: /^[0-9a-f]{64}$/,
        patternName: "decision fingerprint",
      }),
    ),
  });
}

/**
 * Calls the authorizer and fails closed on anything that is not an explicit,
 * well-formed `allowed`. A thrown authorizer, a conditional decision, and a
 * malformed response are all refusals.
 */
export async function requireAuthorization(
  authorizer: MemoryAuthorizer,
  request: MemoryAuthorizationRequest,
): Promise<{ readonly ok: true; readonly decision: MemoryAuthorizationDecision } | { readonly ok: false; readonly failure: MemoryFailure }> {
  let raw: unknown;
  try {
    raw = await authorizer.authorize(request);
  } catch {
    return Object.freeze({
      ok: false as const,
      failure: memoryFailure(
        "AUTHORIZATION_UNAVAILABLE",
        "The authorizer failed; the operation is refused.",
        { operation: request.operation },
      ),
    });
  }
  let decision: MemoryAuthorizationDecision;
  try {
    decision = parseAuthorizationDecision(raw);
  } catch {
    return Object.freeze({
      ok: false as const,
      failure: memoryFailure(
        "AUTHORIZATION_UNAVAILABLE",
        "The authorizer returned a malformed decision; the operation is refused.",
        { operation: request.operation },
      ),
    });
  }
  if (decision.outcome !== "allowed") {
    return Object.freeze({
      ok: false as const,
      failure: memoryFailure("AUTHORIZATION_DENIED", "The operation was not authorized.", {
        operation: request.operation,
        outcome: decision.outcome,
        reasonCode: decision.reasonCode,
      }),
    });
  }
  return Object.freeze({ ok: true as const, decision });
}

/** The safe default: refuses everything. Useful as a base and in tests. */
export const denyAllAuthorizer: MemoryAuthorizer = Object.freeze({
  authorize: (): MemoryAuthorizationDecision =>
    Object.freeze({
      outcome: "denied" as const,
      reasonCode: "DEFAULT_DENY",
      bodyDisclosureAllowed: false,
      decisionFingerprint: null,
    }),
});

/**
 * Allows exactly one scope, and only for classifications the caller lists.
 * Intended for tests and for callers that genuinely have a single scope; real
 * deployments wire the Stage 6 broker instead.
 */
export function createScopedAuthorizer(options: {
  readonly scope: MemoryScope;
  readonly operations?: readonly MemoryOperation[];
  readonly classifications?: readonly DataClassification[];
  readonly allowBodyDisclosure?: boolean;
}): MemoryAuthorizer {
  const scope = parseMemoryScope(options.scope);
  const operations = new Set(options.operations ?? MEMORY_OPERATIONS);
  const classifications = new Set<DataClassification>(
    options.classifications ?? DATA_CLASSIFICATIONS,
  );
  const allowBody = options.allowBodyDisclosure ?? true;
  const key = memoryScopeKey(scope);
  return Object.freeze({
    authorize: (request: MemoryAuthorizationRequest): MemoryAuthorizationDecision => {
      const allowed =
        memoryScopeKey(request.scope) === key &&
        operations.has(request.operation) &&
        classifications.has(request.classification) &&
        (allowBody || !request.disclosesBody);
      return Object.freeze({
        outcome: allowed ? ("allowed" as const) : ("denied" as const),
        reasonCode: allowed ? "SCOPE_MATCH" : "SCOPE_MISMATCH",
        bodyDisclosureAllowed: allowed && allowBody,
        decisionFingerprint: createHash("sha256")
          .update(toCanonicalJson({ scope: request.scope, operation: request.operation }), "utf8")
          .digest("hex"),
      });
    },
  });
}
