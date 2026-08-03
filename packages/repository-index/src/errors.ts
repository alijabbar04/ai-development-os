/**
 * Failure vocabulary for repository indexing.
 *
 * Expected outcomes (invalid configuration, unsafe paths, exhausted bounds,
 * cancellation, snapshot mismatch) are returned as result variants rather
 * than thrown. `RepositoryIndexError` exists for the small set of
 * programming errors that cannot be represented as a value, and it carries
 * only primitive summaries so hostile repository content can never leak
 * through an error message.
 */

export const REPOSITORY_INDEX_ERROR_CODES = Object.freeze([
  "INVALID_CONFIGURATION",
  "INVALID_INDEX",
  "INVALID_CHANGE_SET",
  "INVALID_QUERY",
  "UNSUPPORTED_SCHEMA_VERSION",
  "SNAPSHOT_MISMATCH",
  "UNSAFE_PATH",
  "PATH_COLLISION",
  "LIMIT_EXCEEDED",
  "READ_PORT_FAILURE",
  "CANCELLED",
] as const);

export type RepositoryIndexErrorCode = (typeof REPOSITORY_INDEX_ERROR_CODES)[number];

export type FailureDetailValue = string | number | boolean | null | readonly string[];

export type FailureDetails = Readonly<Record<string, FailureDetailValue>>;

export interface RepositoryIndexFailure {
  readonly code: RepositoryIndexErrorCode;
  readonly message: string;
  readonly details: FailureDetails;
}

export function indexFailure(
  code: RepositoryIndexErrorCode,
  message: string,
  details: FailureDetails = {},
): RepositoryIndexFailure {
  return Object.freeze({ code, message, details: Object.freeze({ ...details }) });
}

export type RepositoryIndexResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: RepositoryIndexFailure };

export function ok<T>(value: T): RepositoryIndexResult<T> {
  return Object.freeze({ ok: true as const, value });
}

export function failed<T>(failure: RepositoryIndexFailure): RepositoryIndexResult<T> {
  return Object.freeze({ ok: false as const, failure });
}

export class RepositoryIndexError extends Error {
  readonly code: RepositoryIndexErrorCode;
  readonly details: FailureDetails;

  constructor(code: RepositoryIndexErrorCode, message: string, details: FailureDetails = {}) {
    super(message);
    this.name = "RepositoryIndexError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  toJSON(): object {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

/**
 * Diagnostics are bounded, structural, and never echo file content. A
 * diagnostic always names the affected canonical path (paths are already
 * validated and render-safe) plus a stable code.
 */
export const INDEX_DIAGNOSTIC_CODES = Object.freeze([
  "path-rejected",
  "path-collision",
  "excluded-by-configuration",
  "entry-too-large",
  "binary-content",
  "invalid-utf8",
  "generated-or-minified",
  "symlink-metadata-only",
  "submodule-metadata-only",
  "terms-truncated",
  "text-truncated",
  "manifest-unsupported",
  "manifest-malformed",
  "manifest-duplicate-key",
  "manifest-dynamic-construct",
  "manifest-partial",
  "file-budget-exhausted",
  "byte-budget-exhausted",
  "term-budget-exhausted",
  "time-budget-exhausted",
  "read-failed",
] as const);

export type IndexDiagnosticCode = (typeof INDEX_DIAGNOSTIC_CODES)[number];

export interface IndexDiagnostic {
  readonly code: IndexDiagnosticCode;
  /** Canonical repository-relative path, or null for whole-index diagnostics. */
  readonly path: string | null;
  /** Bounded, non-content structural detail (counts, limits, format names). */
  readonly detail: string;
}

export function diagnostic(
  code: IndexDiagnosticCode,
  path: string | null,
  detail: string,
): IndexDiagnostic {
  return Object.freeze({ code, path, detail: detail.slice(0, 200) });
}
