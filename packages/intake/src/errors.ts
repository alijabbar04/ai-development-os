import type { ProjectRefusalCode } from "@ai-dev-os/project";

export const INTAKE_REFUSAL_CODES = Object.freeze([
  "intake.input.invalid",
  "intake.text.bidi",
  "intake.text.control",
  "intake.text.zero-width",
  "intake.text.normalization",
  "intake.text.malformed-unicode",
  "intake.text.secret",
  "intake.text.absolute-path",
  "intake.text.too-long",
  "intake.collection.too-large",
  "intake.question.blocking-basis",
  "intake.round.too-many-questions",
  "intake.round.too-many-blocking",
  "intake.round.ceiling",
  "intake.round.material-change-required",
  "intake.blocking.unanswered",
  "intake.candidate.not-ready",
  "intake.digest.mismatch",
  "intake.brief.superseded",
  "intake.version.invalid",
  "intake.persistence.refused",
  "intake.persistence.unknown",
  "intake.reconciliation.limit",
  "intake.root.invalid",
  "intake.root.not-contained",
  "intake.root.reparse",
  "intake.inspection.limit",
  "intake.inspection.deadline",
  "intake.git.refused",
  "intake.project.refused",
] as const);

export type IntakeRefusalCode = (typeof INTAKE_REFUSAL_CODES)[number];

export const INTAKE_DIAGNOSTIC_ROOTS = Object.freeze([
  "input",
  "text",
  "candidate",
  "objective",
  "outcome",
  "nonGoal",
  "audience",
  "constraint",
  "assumption",
  "question",
  "clarification",
  "acceptance",
  "binding",
  "brief",
  "decision",
  "store",
  "journal",
  "projection",
  "root",
  "file",
  "git",
  "inspection",
] as const);

export type IntakeDiagnosticRoot = (typeof INTAKE_DIAGNOSTIC_ROOTS)[number];

export interface IntakeErrorDetails {
  readonly projectCode: ProjectRefusalCode | null;
  readonly projectPath: string | null;
  readonly limit: number | null;
}

const COPY: Readonly<Record<IntakeRefusalCode, string>> = Object.freeze({
  "intake.input.invalid": "The intake input is not in the accepted form.",
  "intake.text.bidi": "The text contains a bidirectional display control.",
  "intake.text.control": "The text contains a disallowed control character.",
  "intake.text.zero-width": "The text contains a disallowed invisible character.",
  "intake.text.normalization": "The text is not in the accepted normalized form.",
  "intake.text.malformed-unicode": "The text contains malformed Unicode.",
  "intake.text.secret": "The text resembles credential material and was not accepted.",
  "intake.text.absolute-path": "The text contains a local absolute path that cannot appear in this view.",
  "intake.text.too-long": "The text exceeds the intake bound.",
  "intake.collection.too-large": "The collection exceeds the intake bound.",
  "intake.question.blocking-basis": "A blocking question does not use an accepted blocking basis.",
  "intake.round.too-many-questions": "A clarification round contains too many questions.",
  "intake.round.too-many-blocking": "A clarification round contains too many blocking questions.",
  "intake.round.ceiling": "No more clarification rounds can be opened in this intake session.",
  "intake.round.material-change-required": "A second clarification round requires a material-change reason.",
  "intake.blocking.unanswered": "A blocking question still needs an answer before this brief can be accepted.",
  "intake.candidate.not-ready": "The project brief is not ready for acceptance.",
  "intake.digest.mismatch": "The brief changed since it was reviewed; nothing was recorded.",
  "intake.brief.superseded": "The brief moved on while it was being revised.",
  "intake.version.invalid": "The expected brief version is not valid for this acceptance.",
  "intake.persistence.refused": "The brief could not be recorded.",
  "intake.persistence.unknown": "Saving could not be confirmed.",
  "intake.reconciliation.limit": "Saving could not be reconciled inside the bounded journal window.",
  "intake.root.invalid": "The approved repository root is not canonical.",
  "intake.root.not-contained": "A repository observation escaped the approved root.",
  "intake.root.reparse": "A repository observation crossed a link or reparse boundary.",
  "intake.inspection.limit": "Repository inspection exceeded its file or byte bound.",
  "intake.inspection.deadline": "Repository inspection reached its deadline.",
  "intake.git.refused": "The read-only Git observation was refused.",
  "intake.project.refused": "The canonical project contract refused the brief.",
});

export class IntakeError extends Error {
  readonly code: IntakeRefusalCode;
  readonly root: IntakeDiagnosticRoot;
  readonly details: IntakeErrorDetails;

  constructor(
    code: IntakeRefusalCode,
    root: IntakeDiagnosticRoot,
    details: Partial<IntakeErrorDetails> = {},
  ) {
    super(COPY[code]);
    this.name = "IntakeError";
    this.code = code;
    this.root = root;
    this.details = Object.freeze({
      projectCode: details.projectCode ?? null,
      projectPath: details.projectPath ?? null,
      limit: details.limit ?? null,
    });
  }

  toJSON(): Readonly<{
    name: "IntakeError";
    code: IntakeRefusalCode;
    root: IntakeDiagnosticRoot;
    message: string;
    details: IntakeErrorDetails;
  }> {
    return Object.freeze({
      name: "IntakeError",
      code: this.code,
      root: this.root,
      message: this.message,
      details: this.details,
    });
  }
}

export function intakeRefusalCopy(code: IntakeRefusalCode): string {
  return COPY[code];
}

export function refuseIntake(
  code: IntakeRefusalCode,
  root: IntakeDiagnosticRoot,
  details?: Partial<IntakeErrorDetails>,
): never {
  throw new IntakeError(code, root, details);
}
