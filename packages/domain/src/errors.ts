export const DOMAIN_ERROR_CODES = Object.freeze([
  "VALIDATION_FAILED",
  "INVARIANT_VIOLATION",
  "SERIALIZATION_FAILED",
  "BUDGET_EXCEEDED",
  "POLICY_VIOLATION",
  "UNSUPPORTED_CAPABILITY",
  "CONCURRENCY_CONFLICT",
] as const);

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

/**
 * Error details are restricted to primitive summaries (labels, lengths,
 * counts, codes). Raw input values must never be placed into details or
 * messages so that secret-bearing input cannot leak through error channels.
 */
export type ErrorDetailValue =
  | string
  | number
  | boolean
  | null
  | readonly ErrorDetailValue[];

export type ErrorDetails = Readonly<Record<string, ErrorDetailValue>>;

export abstract class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: ErrorDetails;

  protected constructor(
    code: DomainErrorCode,
    message: string,
    details: ErrorDetails = {},
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  toJSON(): {
    readonly name: string;
    readonly code: DomainErrorCode;
    readonly message: string;
    readonly details: ErrorDetails;
  } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export interface ValidationIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export class ValidationError extends DomainError {
  readonly issues: readonly ValidationIssue[];

  constructor(message: string, issues: readonly ValidationIssue[]) {
    super("VALIDATION_FAILED", message, { issueCount: issues.length });
    this.name = "ValidationError";
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
  }
}

export class InvariantViolationError extends DomainError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("INVARIANT_VIOLATION", message, details);
    this.name = "InvariantViolationError";
  }
}

export class SerializationError extends DomainError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("SERIALIZATION_FAILED", message, details);
    this.name = "SerializationError";
  }
}

export class PolicyViolationError extends DomainError {
  readonly reasonCodes: readonly string[];

  constructor(message: string, reasonCodes: readonly string[]) {
    super("POLICY_VIOLATION", message, { reasonCodes: Object.freeze([...reasonCodes]) });
    this.name = "PolicyViolationError";
    this.reasonCodes = Object.freeze([...reasonCodes]);
  }
}

export class ConcurrencyConflictError extends DomainError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("CONCURRENCY_CONFLICT", message, details);
    this.name = "ConcurrencyConflictError";
  }
}
