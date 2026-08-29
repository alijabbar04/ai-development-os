export const PROJECT_REFUSAL_CODES = Object.freeze([
  "PROJECT_VALIDATION_REFUSED",
  "UNSUPPORTED_SCHEMA_VERSION",
  "UNKNOWN_RECORD_KIND",
  "ILLEGAL_TRANSITION",
  "REVISION_OVERFLOW",
  "REFERENCE_INCONSISTENT",
  "DIGEST_MISMATCH",
  "AUTHORITY_VIOLATION",
  "DUPLICATE_IDENTIFIER",
  "INVARIANT_VIOLATION",
] as const);

export type ProjectRefusalCode = (typeof PROJECT_REFUSAL_CODES)[number];

const PROJECT_DIAGNOSTIC_ROOTS = Object.freeze([
  "project", "projectBrief", "constraint", "projectPlan", "planStage", "task",
  "dependency", "agentRun", "session", "handover", "decision", "approvalRequest",
  "spendingRequest", "usageReservation", "evidenceRecord", "deliverable", "blocker",
  "notification", "communicationThread", "externalIntegration", "projectHealth",
  "projectStop", "projectSummary", "recordKind", "json", "value", "canonical",
  "projection", "transition", "stateMachine", "revision", "exhaustiveness",
  "invariant", "contentIdentity", "planEligibility", "supersession",
] as const);

/**
 * Collapse every diagnostic location to one finite package-owned root. Public
 * callers cannot inject paths, secret text, or arbitrary labels into errors.
 */
function finiteDiagnosticPath(value: unknown): string {
  if (typeof value !== "string") return "project";
  for (const root of PROJECT_DIAGNOSTIC_ROOTS) {
    if (value === root || value.startsWith(`${root}.`) || value.startsWith(`${root}[`)) return root;
  }
  return "project";
}

/** Finite, non-reflective refusal. Messages never contain rejected input. */
export class ProjectContractError extends Error {
  readonly code: ProjectRefusalCode;
  readonly path: string;

  constructor(code: ProjectRefusalCode, path: string, message: string) {
    super(message);
    this.name = "ProjectContractError";
    this.code = code;
    this.path = finiteDiagnosticPath(path);
  }

  toJSON(): Readonly<{ name: string; code: ProjectRefusalCode; path: string; message: string }> {
    return Object.freeze({ name: this.name, code: this.code, path: this.path, message: this.message });
  }
}

export function refuse(
  code: ProjectRefusalCode,
  path: string,
  message = "The project contract was refused.",
): never {
  throw new ProjectContractError(code, path, message);
}
