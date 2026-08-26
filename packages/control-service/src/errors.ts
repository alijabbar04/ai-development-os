export const CONTROL_ERROR_CODES = Object.freeze([
  "INVALID_INPUT",
  "INVALID_IDENTITY",
  "SESSION_EXPIRED",
  "SESSION_REFUSED",
  "STORAGE_UNSAFE",
  "ARTIFACT_MISSING",
  "ARTIFACT_CONFLICT",
  "ARTIFACT_INVALID",
  "ARTIFACT_FOREIGN",
  "LIVENESS_AMBIGUOUS",
  "LIFECYCLE_REFUSED",
  "ADOPTION_REFUSED",
  "ADOPTION_TIMEOUT",
  "BIND_REFUSED",
  "AUTH_REFUSED",
  "ORIGIN_REFUSED",
  "LIMIT_REFUSED",
  "METHOD_REFUSED",
  "ROUTE_REFUSED",
  "RESPONSE_REFUSED",
  "INTERNAL_REFUSED"
] as const);

export type ControlErrorCode = (typeof CONTROL_ERROR_CODES)[number];

const SAFE_MESSAGES: Readonly<Record<ControlErrorCode, string>> = Object.freeze({
  INVALID_INPUT: "The supplied control-service input was refused.",
  INVALID_IDENTITY: "The service identity was refused.",
  SESSION_EXPIRED: "The control-service session has expired.",
  SESSION_REFUSED: "The control-service session was refused.",
  STORAGE_UNSAFE: "The control-service storage boundary is unavailable.",
  ARTIFACT_MISSING: "The required control-service artifact is missing.",
  ARTIFACT_CONFLICT: "A control-service artifact already exists.",
  ARTIFACT_INVALID: "The control-service artifact was refused.",
  ARTIFACT_FOREIGN: "The control-service artifact has a different owner.",
  LIVENESS_AMBIGUOUS: "The existing control-service owner cannot be proven safe to replace.",
  LIFECYCLE_REFUSED: "That control-service lifecycle transition is not permitted.",
  ADOPTION_REFUSED: "The existing control service could not be safely adopted.",
  ADOPTION_TIMEOUT: "The existing control-service identity probe timed out.",
  BIND_REFUSED: "The control service could not establish its loopback listener.",
  AUTH_REFUSED: "The control-service request was not authenticated.",
  ORIGIN_REFUSED: "Browser-origin access is not permitted.",
  LIMIT_REFUSED: "The control-service request exceeded a fixed limit.",
  METHOD_REFUSED: "That HTTP method is not available.",
  ROUTE_REFUSED: "That control-service route is not available.",
  RESPONSE_REFUSED: "The control-service response exceeded a fixed limit.",
  INTERNAL_REFUSED: "The control-service request could not be completed."
});

export class ControlServiceError extends Error {
  readonly code: ControlErrorCode;

  constructor(code: ControlErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "ControlServiceError";
    this.code = code;
  }
}

export function controlFail(code: ControlErrorCode): never {
  throw new ControlServiceError(code);
}

export function errorCode(error: unknown): string | null {
  try {
    if (typeof error !== "object" || error === null) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}
