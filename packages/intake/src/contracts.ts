import type {
  ClarificationQuestion,
  Constraint,
  Decision,
  ProjectBrief,
} from "@ai-dev-os/project";

export const INTAKE_PRODUCTION_ENABLED = false as const;
export const INTAKE_RUNTIME_CAPABILITIES = Object.freeze([] as const);
export const INTAKE_AVAILABLE_COMMANDS = Object.freeze([] as const);
export const INTAKE_AUTHORITY = "none" as const;

export const INTAKE_LIMITS = Object.freeze({
  text: 16_384,
  collection: 1_024,
  clarificationRounds: 2,
  questionsPerRound: 8,
  blockingQuestionsPerRound: 3,
  clarificationDecisionMaterial: 16_384,
  inspectionFiles: 128,
  inspectionBytes: 1_048_576,
  inspectionDeadlineMs: 30_000,
  reconciliationEvents: 1_000,
  reconciliationPageSize: 100,
});

export const INTAKE_CLARIFICATION_POLICY = Object.freeze({
  defaultRounds: 1 as const,
  maximumRounds: 2 as const,
  maximumQuestionsPerRound: 8 as const,
  maximumBlockingQuestionsPerRound: 3 as const,
  secondRoundRequiresMaterialChangeReason: true as const,
  preAcceptancePersistence: false as const,
});

export const INTAKE_BLOCKING_BASES = Object.freeze([
  "required-outcome",
  "hard-constraint-machine-form",
  "data-permission-ceiling",
  "budget-ceiling",
  "repository-branch-ambiguity",
] as const);
export type IntakeBlockingBasis = (typeof INTAKE_BLOCKING_BASES)[number];

export const INTAKE_PROVENANCE_SOURCES = Object.freeze([
  "operator-supplied",
  "approved-observation",
  "model-proposed",
  "proposed-default",
  "derived-deterministically",
] as const);
export type IntakeProvenanceSource = (typeof INTAKE_PROVENANCE_SOURCES)[number];

export interface IntakeProvenance {
  readonly source: IntakeProvenanceSource;
  readonly acceptedByOperator: boolean;
}

export interface IntakeTextField {
  readonly value: string;
  readonly provenance: IntakeProvenance;
}

export interface IntakeConstraintField {
  readonly value: Constraint;
  readonly provenance: IntakeProvenance;
  readonly possible: boolean;
}

export interface IntakeAssumptionField {
  readonly text: string;
  readonly source: "operator" | "repository" | "model";
  readonly confirmed: boolean;
  readonly provenance: IntakeProvenance;
}

export const INTAKE_QUESTION_SOURCES = Object.freeze([
  "operator",
  "constraint",
  "confirmed-assumption",
  "prior-decision",
  "preference",
  "inspection-fact",
  "derived",
] as const);
export type IntakeQuestionSource = (typeof INTAKE_QUESTION_SOURCES)[number];

export interface ProposedIntakeQuestion {
  readonly question: ClarificationQuestion;
  readonly blockingBasis: IntakeBlockingBasis | null;
  readonly provenance: IntakeProvenance;
  readonly source: IntakeQuestionSource;
}

export interface KnownIntakeFact {
  readonly source: Exclude<IntakeQuestionSource, "operator" | "derived">;
  readonly text: string;
}

export interface CandidateDraftInput {
  readonly projectId: string;
  readonly objective: IntakeTextField;
  readonly outcomes: readonly IntakeTextField[];
  readonly nonGoals: readonly IntakeTextField[];
  readonly audiences: readonly IntakeTextField[];
  readonly constraints: readonly IntakeConstraintField[];
  readonly assumptions: readonly IntakeAssumptionField[];
  readonly openQuestions: readonly ProposedIntakeQuestion[];
  readonly sourceThreadId: string | null;
}

export interface CandidateBrief extends CandidateDraftInput {
  readonly candidateDigest: string;
  readonly ready: boolean;
}

export interface IntakeDigestPort {
  sha256(text: string): string;
}

export interface IntakeClock {
  now(): Date;
}

export interface IntakeMonotonicClock {
  nowMs(): number;
}

export type ClarificationResolutionKind = "answered" | "defaulted" | "default-confirmed";

export interface ClarificationResolution {
  readonly questionId: string;
  readonly kind: ClarificationResolutionKind;
  readonly value: string;
}

export interface DroppedClarificationQuestion {
  readonly questionId: string;
  readonly matchedSource: IntakeQuestionSource;
  readonly semanticKey: string;
}

export interface ClarificationRound {
  readonly ordinal: 1 | 2;
  readonly materialChangeReason: string | null;
  readonly questionSetDigest: string;
  readonly questions: readonly ProposedIntakeQuestion[];
  readonly resolutions: readonly ClarificationResolution[];
  readonly droppedDuplicates: readonly DroppedClarificationQuestion[];
}

export interface ClarificationSession {
  readonly rounds: readonly ClarificationRound[];
}

export interface AcceptanceBinding {
  readonly candidateDigest: string;
  readonly expectedHeadBriefId: string | null;
  readonly expectedAggregateVersion: number;
  readonly intakeDecisionDigest: string;
}

export interface OperatorAcceptanceEvidence {
  readonly schemaVersion: 1;
  readonly evidenceId: string;
  readonly kind: "explicit-operator-acceptance";
  readonly candidateDigest: string;
  readonly acceptedAt: string;
  readonly authority: "brief-only";
}

export interface CandidateFieldProvenance {
  readonly objective: IntakeProvenance;
  readonly outcomes: readonly IntakeProvenance[];
  readonly nonGoals: readonly IntakeProvenance[];
  readonly audiences: readonly IntakeProvenance[];
  readonly constraints: readonly IntakeProvenance[];
  readonly assumptions: readonly IntakeProvenance[];
  readonly openQuestions: readonly IntakeProvenance[];
}

export interface IntakeAcceptanceEventPayload {
  readonly schemaVersion: 1;
  readonly kind: "project-brief-accepted";
  readonly binding: AcceptanceBinding;
  readonly aggregateVersion: number;
  readonly brief: ProjectBrief;
  readonly provenance: CandidateFieldProvenance;
  readonly decisions: readonly Decision[];
  readonly operatorEvidence: OperatorAcceptanceEvidence;
}

export interface PreparedAcceptance {
  readonly candidate: CandidateBrief;
  readonly aggregateId: string;
  readonly eventId: string;
  readonly bindingDigest: string;
  readonly binding: AcceptanceBinding;
  readonly aggregateVersion: number;
  readonly brief: ProjectBrief;
  readonly event: IntakeAcceptanceEventPayload;
}

export type StoreWriteAttempt =
  | Readonly<{ kind: "committed"; event: IntakeAcceptanceEventPayload }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "unknown" }>
  | Readonly<{ kind: "refused" }>;

export type StoreReconciliation =
  | Readonly<{ kind: "committed"; event: IntakeAcceptanceEventPayload }>
  | Readonly<{ kind: "not-recorded" }>
  | Readonly<{ kind: "superseded" }>
  | Readonly<{ kind: "limit" }>
  | Readonly<{ kind: "unknown" }>;

export interface IntakeAcceptanceStore {
  attempt(prepared: PreparedAcceptance): Promise<StoreWriteAttempt>;
  reconcile(prepared: PreparedAcceptance): Promise<StoreReconciliation>;
}

export interface AcceptCandidateRequest {
  readonly candidate: CandidateBrief;
  readonly presentedDigest: string;
  readonly expectedHead: ProjectBrief | null;
  readonly expectedAggregateVersion: number;
  readonly clarification: ClarificationSession;
  readonly operatorConfirmed: true;
}

export type AcceptanceOutcome =
  | Readonly<{
      status: "committed" | "idempotent" | "recovered";
      brief: ProjectBrief;
      aggregateVersion: number;
      decisions: readonly Decision[];
    }>
  | Readonly<{ status: "not-recorded"; candidate: CandidateBrief }>
  | Readonly<{ status: "outcome-unknown"; candidate: CandidateBrief }>;

export const INTAKE_INSPECTION_STATES = Object.freeze([
  "complete",
  "partial",
  "unavailable",
] as const);
export type IntakeInspectionState = (typeof INTAKE_INSPECTION_STATES)[number];

export type IntakePathFlavor = "windows" | "posix";
export type IntakeFileKind = "file" | "directory" | "missing" | "unavailable";

export interface IntakeFileObservation {
  readonly relativePath: string;
  readonly canonicalPath: string | null;
  readonly kind: IntakeFileKind;
  readonly byteLength: number;
  readonly reparsePoint: boolean;
  readonly failureCode: "access-denied" | "not-found" | "deadline" | "io" | null;
}

export interface IntakeFilesystemPort {
  inspect(input: Readonly<{
    approvedRoot: string;
    relativePaths: readonly string[];
    deadlineAtMs: number;
    maximumBytes: number;
  }>): Promise<readonly IntakeFileObservation[]>;
}

export const INTAKE_GIT_QUERIES = Object.freeze([
  Object.freeze({ kind: "root" as const, args: Object.freeze(["rev-parse", "--show-toplevel"] as const) }),
  Object.freeze({ kind: "head" as const, args: Object.freeze(["rev-parse", "--verify", "HEAD"] as const) }),
  Object.freeze({ kind: "branch" as const, args: Object.freeze(["symbolic-ref", "--quiet", "--short", "HEAD"] as const) }),
  Object.freeze({ kind: "status" as const, args: Object.freeze(["status", "--porcelain=v1", "--untracked-files=no"] as const) }),
] as const);
export type IntakeGitQuery = (typeof INTAKE_GIT_QUERIES)[number];

export interface IntakeGitResult {
  readonly kind: IntakeGitQuery["kind"];
  readonly status: "ok" | "unavailable";
  readonly value: string | null;
  readonly failureCode: "not-repository" | "unborn-head" | "detached" | "deadline" | "io" | null;
}

export interface IntakeGitPort {
  run(input: Readonly<{
    root: string;
    args: IntakeGitQuery["args"];
    deadlineAtMs: number;
    policy: Readonly<{
      readOnly: true;
      hooks: false;
      network: false;
      credentialHelpers: false;
      shell: false;
    }>;
  }>): Promise<IntakeGitResult>;
}

export interface RepositoryInspectionRequest {
  readonly approvedRoot: string;
  readonly pathFlavor: IntakePathFlavor;
  readonly relativePaths: readonly string[];
  readonly maximumFiles: number;
  readonly maximumBytes: number;
  readonly deadlineMs: number;
  readonly includeGit: boolean;
}

export interface RepositoryInspectionReport {
  readonly state: IntakeInspectionState;
  readonly canonicalRoot: string;
  readonly rootLeaf: string;
  readonly files: readonly Readonly<{
    relativePath: string;
    kind: IntakeFileKind;
    byteLength: number;
  }>[];
  readonly facts: readonly Readonly<{
    kind: "ecosystem" | "package-manager" | "git-head" | "git-branch" | "git-status";
    value: string;
  }>[];
  readonly unavailable: readonly Readonly<{
    source: "filesystem" | "git";
    code: string;
  }>[];
  readonly totalBytes: number;
}

export const INTAKE_VIEW_STATES = Object.freeze([
  "empty",
  "loading",
  "partial",
  "unavailable",
  "blocked",
  "ready",
  "conflict",
] as const);
export type IntakeViewState = (typeof INTAKE_VIEW_STATES)[number];
export type IntakeAudience = "normal" | "developer";

export interface IntakeStateProjectionInput {
  readonly state: IntakeViewState;
  readonly questionCount: number;
  readonly blockingCount: number;
  readonly candidateDigest: string | null;
  readonly diagnosticRule: string | null;
  readonly canonicalRoot: string | null;
}
