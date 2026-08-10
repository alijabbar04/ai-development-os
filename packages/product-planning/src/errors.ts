export const PLANNING_ERROR_CODES = Object.freeze([
  "INVALID_INPUT",
  "LIMIT_EXCEEDED",
  "CONCURRENCY_CONFLICT",
  "INVALID_TRANSITION",
  "POLICY_DENIED",
  "INDEPENDENCE_REQUIRED",
  "CONFLICT",
  "NOT_FOUND",
  "PERSISTENCE_MISMATCH",
  "PRODUCTION_DISABLED",
] as const);

export type PlanningErrorCode = (typeof PLANNING_ERROR_CODES)[number];
export type PlanningErrorDetail = string | number | boolean | null;

export class PlanningError extends Error {
  readonly code: PlanningErrorCode;
  readonly details: Readonly<Record<string, PlanningErrorDetail>>;

  constructor(
    code: PlanningErrorCode,
    message: string,
    details: Readonly<Record<string, PlanningErrorDetail>> = {},
  ) {
    super(message);
    this.name = "PlanningError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  toJSON(): {
    readonly name: string;
    readonly code: PlanningErrorCode;
    readonly message: string;
    readonly details: Readonly<Record<string, PlanningErrorDetail>>;
  } {
    return Object.freeze({ name: this.name, code: this.code, message: this.message, details: this.details });
  }
}

export function isPlanningError(value: unknown, code?: PlanningErrorCode): value is PlanningError {
  return value instanceof PlanningError && (code === undefined || value.code === code);
}
