export const EVALUATION_ERROR_CODES = Object.freeze([
  "INVALID_INPUT",
  "LIMIT_EXCEEDED",
  "CONFLICT",
  "NOT_FOUND",
  "INVALID_TRANSITION",
  "PERSISTENCE_MISMATCH",
  "PRODUCTION_DISABLED",
] as const);

export type EvaluationErrorCode = (typeof EVALUATION_ERROR_CODES)[number];
export type EvaluationErrorDetail = string | number | boolean | null;

export class EvaluationError extends Error {
  readonly code: EvaluationErrorCode;
  readonly details: Readonly<Record<string, EvaluationErrorDetail>>;

  constructor(
    code: EvaluationErrorCode,
    message: string,
    details: Readonly<Record<string, EvaluationErrorDetail>> = {},
  ) {
    super(message);
    this.name = "EvaluationError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  toJSON(): {
    readonly name: string;
    readonly code: EvaluationErrorCode;
    readonly message: string;
    readonly details: Readonly<Record<string, EvaluationErrorDetail>>;
  } {
    return Object.freeze({
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    });
  }
}

export function isEvaluationError(
  value: unknown,
  code?: EvaluationErrorCode,
): value is EvaluationError {
  return value instanceof EvaluationError && (code === undefined || value.code === code);
}
