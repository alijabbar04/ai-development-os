export const APPLICATION_ERROR_CODES = Object.freeze([
  "INVALID_COMMAND",
  "INVALID_USAGE_FIXTURE",
  "USAGE_SOURCE_MISMATCH",
  "USAGE_PROFILE_MISMATCH",
  "USAGE_DUPLICATE",
  "USAGE_MISSING",
  "USAGE_SOURCE_UNAVAILABLE",
  "PRODUCTION_DISABLED",
] as const);

export type ApplicationErrorCode = (typeof APPLICATION_ERROR_CODES)[number];

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;

  constructor(code: ApplicationErrorCode, message: string) {
    super(message);
    this.name = "ApplicationError";
    this.code = code;
  }
}

export function isApplicationError(value: unknown): value is ApplicationError {
  return value instanceof ApplicationError;
}
