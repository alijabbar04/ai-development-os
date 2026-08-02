export const PERSISTENCE_ERROR_CODES = Object.freeze([
  "CONCURRENCY_CONFLICT",
  "NOT_FOUND",
  "DUPLICATE_ID",
  "DUPLICATE_IDEMPOTENCY_KEY",
  "CORRUPTION_DETECTED",
  "INVALID_CURSOR",
  "MIGRATION_FAILED",
  "MIGRATION_CHECKSUM_MISMATCH",
  "SCHEMA_TOO_NEW",
  "TRANSACTION_COMPLETED",
  "NESTED_TRANSACTION",
  "ADAPTER_CLOSED",
  "OUTBOX_STATE_CONFLICT",
  "STORAGE_FAILURE",
] as const);

export type PersistenceErrorCode = (typeof PERSISTENCE_ERROR_CODES)[number];

/**
 * Detail values are restricted to primitive summaries: identifiers, codes,
 * versions, and counts. Payload contents, SQL text, raw database rows, and
 * driver messages must never be placed into details or messages.
 */
export type PersistenceErrorDetailValue =
  | string
  | number
  | boolean
  | null
  | readonly PersistenceErrorDetailValue[];

export type PersistenceErrorDetails = Readonly<
  Record<string, PersistenceErrorDetailValue>
>;

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;
  readonly details: PersistenceErrorDetails;

  constructor(
    code: PersistenceErrorCode,
    message: string,
    details: PersistenceErrorDetails = {},
  ) {
    super(message);
    this.name = "PersistenceError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  toJSON(): {
    readonly name: string;
    readonly code: PersistenceErrorCode;
    readonly message: string;
    readonly details: PersistenceErrorDetails;
  } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export function isPersistenceError(
  value: unknown,
  code?: PersistenceErrorCode,
): value is PersistenceError {
  return (
    value instanceof PersistenceError && (code === undefined || value.code === code)
  );
}
