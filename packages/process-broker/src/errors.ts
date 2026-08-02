/**
 * Stable structured errors for the process broker.
 *
 * Every error is identified by its `code`. Details carry only bounded
 * primitives: identifiers, counts, byte totals, category labels, and stable
 * codes. Details never carry command output, environment values, secret
 * material, repository content, absolute filesystem paths, or raw backend
 * payloads.
 */

export const PROCESS_ERROR_CODES = Object.freeze([
  "INVALID_REQUEST",
  "INVALID_CONFIGURATION",
  "POLICY_DENIED",
  "APPROVAL_REQUIRED",
  "INVALID_GRANT",
  "GRANT_EXPIRED",
  "LEASE_INVALID",
  "LEASE_EXPIRED",
  "LEASE_REVOKED",
  "EXECUTABLE_UNAVAILABLE",
  "EXECUTABLE_DIGEST_MISMATCH",
  "EXECUTABLE_UNSAFE",
  "SHELL_PROHIBITED",
  "ENVIRONMENT_REJECTED",
  "BACKEND_UNAVAILABLE",
  "BACKEND_INSECURE",
  "BACKEND_LOST",
  "PRODUCTION_ISOLATION_REQUIRED",
  "SPAWN_FAILED",
  "DEADLINE_EXCEEDED",
  "CANCELLED",
  "OUTPUT_QUOTA_EXCEEDED",
  "CPU_QUOTA_EXCEEDED",
  "MEMORY_QUOTA_EXCEEDED",
  "DISK_QUOTA_EXCEEDED",
  "PROCESS_COUNT_QUOTA_EXCEEDED",
  "NETWORK_POLICY_UNAVAILABLE",
  "PROCESS_TREE_TERMINATION_FAILED",
  "SESSION_CLOSED",
  "SESSION_STDIN_CLOSED",
  "INPUT_QUOTA_EXCEEDED",
  "WRITE_QUEUE_FULL",
  "EVENT_QUEUE_QUOTA_EXCEEDED",
  "BROKER_CLOSED",
  "OBSERVER_FAILURE",
] as const);

export type ProcessErrorCode = (typeof PROCESS_ERROR_CODES)[number];

export type ProcessErrorDetailValue = string | number | boolean | null | readonly string[];
export type ProcessErrorDetails = Readonly<Record<string, ProcessErrorDetailValue>>;

/**
 * The single error type raised by this package. It is safe to serialize,
 * safe to log, and stable by `code`.
 */
export class ProcessBrokerError extends Error {
  readonly code: ProcessErrorCode;
  readonly details: ProcessErrorDetails;

  constructor(code: ProcessErrorCode, message: string, details: ProcessErrorDetails = {}) {
    super(message);
    this.name = "ProcessBrokerError";
    this.code = code;
    this.details = Object.freeze({ ...details });
    Object.freeze(this);
  }

  toJSON(): { name: string; code: ProcessErrorCode; message: string; details: ProcessErrorDetails } {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

export function isProcessBrokerError(value: unknown): value is ProcessBrokerError {
  return value instanceof ProcessBrokerError;
}

/**
 * Classifies an unknown thrown value without copying its message, stack, or
 * payload. Backend and Node failures reach audit records as a category only.
 */
export function errorCategory(error: unknown): string {
  if (isProcessBrokerError(error)) {
    return error.code;
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code)) {
      return code;
    }
  }
  if (error instanceof Error) {
    return error.name.length > 0 && error.name.length <= 64 ? error.name : "Error";
  }
  return "unknown";
}

export function invalidRequest(message: string, details: ProcessErrorDetails = {}): ProcessBrokerError {
  return new ProcessBrokerError("INVALID_REQUEST", message, details);
}

export function invalidConfiguration(
  message: string,
  details: ProcessErrorDetails = {},
): ProcessBrokerError {
  return new ProcessBrokerError("INVALID_CONFIGURATION", message, details);
}
