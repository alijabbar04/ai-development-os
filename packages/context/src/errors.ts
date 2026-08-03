/**
 * Failure and omission vocabulary for context packing.
 *
 * A pack that leaves something out must always say so, and must say so without
 * leaking what it left out. Omissions therefore carry an identity, a digest,
 * and a reason code — never a body, never a fragment of one.
 */

export const CONTEXT_ERROR_CODES = Object.freeze([
  "INVALID_CONFIGURATION",
  "INVALID_REQUEST",
  "INVALID_CANDIDATE",
  "UNSUPPORTED_SCHEMA_VERSION",
  "AUTHORIZATION_DENIED",
  "AUTHORIZATION_UNAVAILABLE",
  "BUDGET_UNSATISFIABLE",
  "ESTIMATOR_REJECTED",
  "SOURCE_UNAVAILABLE",
  "DIGEST_MISMATCH",
  "CANCELLED",
  "PACKER_CLOSED",
] as const);

export type ContextErrorCode = (typeof CONTEXT_ERROR_CODES)[number];

export type FailureDetailValue = string | number | boolean | null | readonly string[];

export type FailureDetails = Readonly<Record<string, FailureDetailValue>>;

export interface ContextFailure {
  readonly code: ContextErrorCode;
  readonly message: string;
  readonly details: FailureDetails;
}

export function contextFailure(
  code: ContextErrorCode,
  message: string,
  details: FailureDetails = {},
): ContextFailure {
  return Object.freeze({ code, message, details: Object.freeze({ ...details }) });
}

export type ContextResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ContextFailure };

export function ok<T>(value: T): ContextResult<T> {
  return Object.freeze({ ok: true as const, value });
}

export function failed<T>(failure: ContextFailure): ContextResult<T> {
  return Object.freeze({ ok: false as const, failure });
}

export class ContextError extends Error {
  readonly code: ContextErrorCode;
  readonly details: FailureDetails;

  constructor(code: ContextErrorCode, message: string, details: FailureDetails = {}) {
    super(message);
    this.name = "ContextError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  toJSON(): object {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

export const OMISSION_REASONS = Object.freeze([
  "budget-bytes-exhausted",
  "budget-units-exhausted",
  "budget-items-exhausted",
  "category-allocation-full",
  "per-source-cap",
  "item-too-large",
  "duplicate-digest",
  "policy-denied",
  "classification-ceiling",
  "expired",
  "tombstoned",
  "scope-mismatch",
  "source-digest-mismatch",
  "artifact-unresolved",
  "source-unavailable",
  "empty-after-sanitization",
  "unconfirmed-candidate-excluded",
] as const);

export type OmissionReason = (typeof OMISSION_REASONS)[number];

export const CONTEXT_DIAGNOSTIC_CODES = Object.freeze([
  "candidate-truncated",
  "frame-sentinel-in-body",
  "control-characters-removed",
  "estimator-conservative",
  "omissions-truncated",
  "diagnostics-truncated",
  "artifact-read-failed",
  "index-read-failed",
] as const);

export type ContextDiagnosticCode = (typeof CONTEXT_DIAGNOSTIC_CODES)[number];

export interface ContextDiagnostic {
  readonly code: ContextDiagnosticCode;
  /** Candidate identity, or null for a whole-pack diagnostic. Never a body. */
  readonly identity: string | null;
  readonly detail: string;
}

export function diagnostic(
  code: ContextDiagnosticCode,
  identity: string | null,
  detail: string,
): ContextDiagnostic {
  return Object.freeze({ code, identity, detail: detail.slice(0, 200) });
}

export function causeCategory(error: unknown): string {
  if (error instanceof ContextError) {
    return error.code;
  }
  if (error instanceof Error) {
    return error.name.slice(0, 64);
  }
  return typeof error;
}
