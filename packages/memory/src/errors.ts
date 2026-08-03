/**
 * Failure vocabulary for the memory store.
 *
 * Every expected outcome — denied authorization, a scope mismatch, a stale
 * version, an expired or tombstoned record, a secret-shaped value, an
 * idempotency conflict — is a value, not an exception. Details carry only
 * primitive summaries; a memory body, a subject, or a raw value never appears
 * in an error, a log line, or a serialized failure.
 */

export const MEMORY_ERROR_CODES = Object.freeze([
  "INVALID_CONFIGURATION",
  "INVALID_RECORD",
  "INVALID_QUERY",
  "UNSUPPORTED_SCHEMA_VERSION",
  "AUTHORIZATION_DENIED",
  "AUTHORIZATION_UNAVAILABLE",
  "SCOPE_MISMATCH",
  "NOT_FOUND",
  "VERSION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "TOMBSTONED",
  "EXPIRED",
  "REVOKED",
  "PRECEDENCE_VIOLATION",
  "SECRET_MATERIAL_REJECTED",
  "LIMIT_EXCEEDED",
  "AUDIT_FAILURE",
  "STORE_CLOSED",
  "STORE_FAILURE",
  "CANCELLED",
] as const);

export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[number];

export type FailureDetailValue = string | number | boolean | null | readonly string[];

export type FailureDetails = Readonly<Record<string, FailureDetailValue>>;

export interface MemoryFailure {
  readonly code: MemoryErrorCode;
  readonly message: string;
  readonly details: FailureDetails;
}

export function memoryFailure(
  code: MemoryErrorCode,
  message: string,
  details: FailureDetails = {},
): MemoryFailure {
  return Object.freeze({ code, message, details: Object.freeze({ ...details }) });
}

export type MemoryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: MemoryFailure };

export function ok<T>(value: T): MemoryResult<T> {
  return Object.freeze({ ok: true as const, value });
}

export function failed<T>(failure: MemoryFailure): MemoryResult<T> {
  return Object.freeze({ ok: false as const, failure });
}

/**
 * Thrown only for defects that cannot be represented as a result: a store
 * adapter that violates its own contract, or a caller passing something the
 * type system already forbids.
 */
export class MemoryError extends Error {
  readonly code: MemoryErrorCode;
  readonly details: FailureDetails;

  constructor(code: MemoryErrorCode, message: string, details: FailureDetails = {}) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  toJSON(): object {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

/** Turns any thrown value into a bounded, leak-free category label. */
export function causeCategory(error: unknown): string {
  if (error instanceof MemoryError) {
    return error.code;
  }
  if (error instanceof Error) {
    return error.name.slice(0, 64);
  }
  return typeof error;
}
