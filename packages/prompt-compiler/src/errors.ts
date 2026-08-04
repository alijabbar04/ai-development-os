export const PROMPT_COMPILER_ERROR_CODES = Object.freeze([
  "INVALID_CONFIGURATION",
  "INVALID_REQUEST",
  "INVALID_CONTEXT_PACK",
  "CONTEXT_BINDING_MISMATCH",
  "TARGET_INELIGIBLE",
  "AUTHORIZATION_DENIED",
  "AUTHORIZATION_CONDITIONAL",
  "AUTHORIZATION_UNAVAILABLE",
  "AUTHORIZATION_MISMATCH",
  "AUTHORIZATION_STALE",
  "BOUNDS_EXCEEDED",
  "REPACK_REQUIRED",
  "COMPILER_CLOSED",
  "INTERNAL_FAILURE"
] as const);

export type PromptCompilerErrorCode = (typeof PROMPT_COMPILER_ERROR_CODES)[number];
export type PromptFailureDetail = string | number | boolean | null | readonly string[];
export type PromptFailureDetails = Readonly<Record<string, PromptFailureDetail>>;

export interface PromptCompilationFailure {
  readonly code: PromptCompilerErrorCode;
  readonly message: string;
  readonly details: PromptFailureDetails;
}

export type PromptCompilationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: PromptCompilationFailure };

export function promptFailure(
  code: PromptCompilerErrorCode,
  message: string,
  details: PromptFailureDetails = {}
): PromptCompilationFailure {
  return Object.freeze({ code, message, details: Object.freeze({ ...details }) });
}

export function promptOk<T>(value: T): PromptCompilationResult<T> {
  return Object.freeze({ ok: true as const, value });
}

export function promptFailed<T>(
  failure: PromptCompilationFailure
): PromptCompilationResult<T> {
  return Object.freeze({ ok: false as const, failure });
}

export class PromptCompilerError extends Error {
  readonly code: PromptCompilerErrorCode;
  readonly details: PromptFailureDetails;

  constructor(
    code: PromptCompilerErrorCode,
    message: string,
    details: PromptFailureDetails = {}
  ) {
    super(message);
    this.name = "PromptCompilerError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  toJSON(): object {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details
    };
  }
}

export function safeCauseCode(error: unknown): string {
  if (error instanceof PromptCompilerError) return error.code;
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code.slice(0, 64);
  }
  if (error instanceof Error) return error.name.slice(0, 64);
  return typeof error;
}
