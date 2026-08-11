export const INTEGRATION_ERROR_CODES = Object.freeze([
  "INVALID_INPUT",
  "LIMIT_EXCEEDED",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "CONFLICT",
  "INVALID_TRANSITION",
  "LEASE_CONFLICT",
  "STALE_FENCE",
  "TARGET_DRIFT",
  "VALIDATION_FAILED",
  "EFFECT_UNCERTAIN",
  "PERSISTENCE_MISMATCH",
  "GIT_BOUNDARY_FAILURE",
  "TIMEOUT",
  "PRODUCTION_DISABLED",
] as const);

export type IntegrationErrorCode = (typeof INTEGRATION_ERROR_CODES)[number];
export type IntegrationErrorDetail = string | number | boolean | null;

export class IntegrationError extends Error {
  readonly code: IntegrationErrorCode;
  readonly details: Readonly<Record<string, IntegrationErrorDetail>>;

  constructor(
    code: IntegrationErrorCode,
    message: string,
    details: Readonly<Record<string, IntegrationErrorDetail>> = {},
  ) {
    super(message);
    this.name = "IntegrationError";
    this.code = code;
    this.details = Object.freeze({ ...details });
    Object.freeze(this);
  }

  toJSON(): {
    readonly name: string;
    readonly code: IntegrationErrorCode;
    readonly message: string;
    readonly details: Readonly<Record<string, IntegrationErrorDetail>>;
  } {
    return Object.freeze({ name: this.name, code: this.code, message: this.message, details: this.details });
  }
}

export function isIntegrationError(value: unknown, code?: IntegrationErrorCode): value is IntegrationError {
  return value instanceof IntegrationError && (code === undefined || value.code === code);
}
