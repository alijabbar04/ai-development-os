export const THINKER_ERROR_CODES = Object.freeze([
  "INVALID_CONFIGURATION",
  "INVALID_REQUEST",
  "COMPILATION_FAILED",
  "TARGET_MISSING",
  "TARGET_DISABLED",
  "TARGET_WRONG_KIND",
  "TARGET_MISMATCH",
  "TARGET_INELIGIBLE",
  "PROVIDER_START_FAILED",
  "PROVIDER_STREAM_FAILED",
  "PROVIDER_RESULT_FAILED",
  "CANCELLED",
  "DEADLINE_EXCEEDED",
  "THINKER_CLOSED",
  "FINISH_LENGTH",
  "FINISH_TOOL_CALL",
  "REFUSED",
  "CONTENT_FILTERED",
  "STRUCTURED_OUTPUT_MISSING",
  "STRUCTURED_OUTPUT_MALFORMED",
  "PROPOSAL_INVALID",
  "AUTHORITY_VIOLATION",
  "MODEL_SUBSTITUTION",
  "REQUEST_SUBSTITUTION",
  "PROTOCOL_VIOLATION",
  "EVENT_BOUNDS_EXCEEDED",
  "INTERNAL_FAILURE"
] as const);

export type ThinkerErrorCode = (typeof THINKER_ERROR_CODES)[number];
export type ThinkerFailureDetail = string | number | boolean | null;
export type ThinkerFailureDetails = Readonly<Record<string, ThinkerFailureDetail>>;

export class ThinkerError extends Error {
  readonly code: ThinkerErrorCode;
  readonly details: ThinkerFailureDetails;

  constructor(code: ThinkerErrorCode, message: string, details: ThinkerFailureDetails = {}) {
    super(message);
    this.name = "ThinkerError";
    this.code = code;
    this.details = Object.freeze({ ...details });
    this.stack = `${this.name}: ${this.message}`;
  }

  toJSON(): object {
    return Object.freeze({ name: this.name, code: this.code, message: this.message, details: this.details });
  }
}

export interface ThinkerFailure {
  readonly schemaVersion: 1;
  readonly code: ThinkerErrorCode;
  readonly message: string;
  readonly details: ThinkerFailureDetails;
}

export type ThinkerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ThinkerFailure };

export function thinkerFailure(
  code: ThinkerErrorCode,
  message: string,
  details: ThinkerFailureDetails = {}
): ThinkerFailure {
  return Object.freeze({ schemaVersion: 1, code, message, details: Object.freeze({ ...details }) });
}

export function thinkerOk<T>(value: T): ThinkerResult<T> {
  return Object.freeze({ ok: true, value });
}

export function thinkerFailed<T = never>(failure: ThinkerFailure): ThinkerResult<T> {
  return Object.freeze({ ok: false, failure });
}

export function safeCauseCode(error: unknown): string {
  if (error instanceof ThinkerError) return error.code;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string"
  ) {
    const code = (error as { readonly code: string }).code;
    return /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : "UNKNOWN_FAILURE";
  }
  return error instanceof Error ? "ERROR" : "UNKNOWN_FAILURE";
}

export function asThinkerError(
  error: unknown,
  fallbackCode: ThinkerErrorCode,
  fallbackMessage: string
): ThinkerError {
  return error instanceof ThinkerError
    ? error
    : new ThinkerError(fallbackCode, fallbackMessage, { causeCode: safeCauseCode(error) });
}
