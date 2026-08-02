/**
 * Stable structured errors for workspace operations.
 *
 * Details carry identifiers, counts, byte totals, path *categories*, and
 * stable codes. They never carry repository content, file bytes, diffs,
 * absolute filesystem paths, environment values, or raw Git output — Git
 * writes hostile repository content into its own error messages, so that text
 * is never propagated.
 */

export const WORKSPACE_ERROR_CODES = Object.freeze([
  "NOT_A_REPOSITORY",
  "UNSUPPORTED_REPOSITORY",
  "UNSAFE_REPOSITORY",
  "DIRTY_SNAPSHOT_NOT_AUTHORIZED",
  "SNAPSHOT_TOO_LARGE",
  "UNTRACKED_FILE_NOT_SELECTED",
  "FILTER_REQUIRED",
  "UNSUPPORTED_SUBMODULE",
  "TARGET_MOVED",
  "CONFLICT",
  "UNSAFE_PATH",
  "LINK_ESCAPE",
  "REPARSE_POINT_ESCAPE",
  "LEASE_INVALID",
  "LEASE_EXPIRED",
  "WORKSPACE_CLOSED",
  "WORKSPACE_NOT_READY",
  "CLEANUP_OWNERSHIP_MISMATCH",
  "CLEANUP_REFUSED",
  "GIT_PROTOCOL_VIOLATION",
  "GIT_BACKEND_FAILURE",
  "GIT_UNAVAILABLE",
  "INVALID_CONFIGURATION",
  "INVALID_REQUEST",
  "POLICY_DENIED",
  "APPROVAL_REQUIRED",
  "QUOTA_EXCEEDED",
  "OUTPUT_TRUNCATED",
] as const);

export type WorkspaceErrorCode = (typeof WORKSPACE_ERROR_CODES)[number];

export type WorkspaceErrorDetailValue = string | number | boolean | null | readonly string[];
export type WorkspaceErrorDetails = Readonly<Record<string, WorkspaceErrorDetailValue>>;

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly details: WorkspaceErrorDetails;

  constructor(code: WorkspaceErrorCode, message: string, details: WorkspaceErrorDetails = {}) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.details = Object.freeze({ ...details });
    Object.freeze(this);
  }

  toJSON(): {
    name: string;
    code: WorkspaceErrorCode;
    message: string;
    details: WorkspaceErrorDetails;
  } {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

export function isWorkspaceError(value: unknown): value is WorkspaceError {
  return value instanceof WorkspaceError;
}

export function invalidRequest(
  message: string,
  details: WorkspaceErrorDetails = {},
): WorkspaceError {
  return new WorkspaceError("INVALID_REQUEST", message, details);
}

export function invalidConfiguration(
  message: string,
  details: WorkspaceErrorDetails = {},
): WorkspaceError {
  return new WorkspaceError("INVALID_CONFIGURATION", message, details);
}

/** Classifies a thrown value without copying its message or payload. */
export function causeCategory(error: unknown): string {
  if (isWorkspaceError(error)) {
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
