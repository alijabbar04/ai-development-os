import {
  parseConstraint,
  parseProjectBrief,
  serializeCanonicalProjectJson,
  type ClarificationQuestion,
  type Constraint,
  type ProjectBrief,
} from "@ai-dev-os/project";
import {
  INTAKE_BLOCKING_BASES,
  INTAKE_PROVENANCE_SOURCES,
  INTAKE_QUESTION_SOURCES,
  type CandidateBrief,
  type CandidateDraftInput,
  type CandidateFieldProvenance,
  type IntakeAssumptionField,
  type IntakeConstraintField,
  type IntakeDigestPort,
  type IntakeProvenance,
  type IntakeTextField,
  type ProposedIntakeQuestion,
} from "./contracts.js";
import { IntakeError, refuseIntake } from "./errors.js";
import {
  exactIntakeKeys,
  intakeArray,
  intakeRecord,
  mapProjectRefusal,
  validateDigest,
  validateIntakeText,
} from "./text.js";

const PREVIEW_TIMESTAMP = "2000-01-01T00:00:00.000Z";
const PREVIEW_BRIEF_ID = "brf:candidate-preview";

export function parseIntakeProvenance(value: unknown): IntakeProvenance {
  const input = intakeRecord(value, "candidate");
  exactIntakeKeys(input, ["source", "acceptedByOperator"], "candidate");
  const source = input["source"];
  if (typeof source !== "string" || !(INTAKE_PROVENANCE_SOURCES as readonly string[]).includes(source)) {
    refuseIntake("intake.input.invalid", "candidate");
  }
  if (typeof input["acceptedByOperator"] !== "boolean") {
    refuseIntake("intake.input.invalid", "candidate");
  }
  return Object.freeze({
    source: source as IntakeProvenance["source"],
    acceptedByOperator: input["acceptedByOperator"],
  });
}

function parseTextField(value: unknown, root: "objective" | "outcome" | "nonGoal" | "audience"): IntakeTextField {
  const input = intakeRecord(value, root);
  exactIntakeKeys(input, ["value", "provenance"], root);
  return Object.freeze({
    value: validateIntakeText(input["value"], root, {
      forbidAbsolutePath: true,
      forbidProtectedIdentifier: true,
    }),
    provenance: parseIntakeProvenance(input["provenance"]),
  });
}

function validateCanonicalStrings(value: unknown, depth = 0): void {
  if (depth > 64) refuseIntake("intake.collection.too-large", "constraint");
  if (typeof value === "string") {
    validateIntakeText(value, "constraint", {
      allowEmpty: true,
      forbidAbsolutePath: true,
      forbidProtectedIdentifier: true,
    });
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateCanonicalStrings(item, depth + 1);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      validateIntakeText(key, "constraint", {
        allowEmpty: true,
        maximum: 1_000,
        forbidAbsolutePath: true,
        forbidProtectedIdentifier: true,
      });
      validateCanonicalStrings(item, depth + 1);
    }
  }
}

function provenanceMatchesConstraint(provenance: IntakeProvenance, constraint: Constraint): boolean {
  switch (constraint.origin) {
    case "operator": return provenance.source === "operator-supplied";
    case "repository": return provenance.source === "approved-observation";
    case "model": return provenance.source === "model-proposed" || provenance.source === "derived-deterministically";
    default: return false;
  }
}

function parseConstraintField(value: unknown): IntakeConstraintField {
  const input = intakeRecord(value, "constraint");
  exactIntakeKeys(input, ["value", "provenance", "possible"], "constraint");
  if (typeof input["possible"] !== "boolean") refuseIntake("intake.input.invalid", "constraint");
  let constraint: Constraint;
  try {
    constraint = parseConstraint(input["value"]);
  } catch (error) {
    return mapProjectRefusal(error, "constraint");
  }
  const provenance = parseIntakeProvenance(input["provenance"]);
  if (!provenanceMatchesConstraint(provenance, constraint)) {
    refuseIntake("intake.input.invalid", "constraint");
  }
  validateIntakeText(constraint.statement, "constraint", {
    forbidAbsolutePath: true,
    forbidProtectedIdentifier: true,
  });
  validateCanonicalStrings(constraint.machineForm);
  if (constraint.enforcement === "hard" && input["possible"] !== true) {
    refuseIntake("intake.candidate.not-ready", "constraint");
  }
  return Object.freeze({ value: constraint, provenance, possible: input["possible"] });
}

function parseAssumptionField(value: unknown): IntakeAssumptionField {
  const input = intakeRecord(value, "assumption");
  exactIntakeKeys(input, ["text", "source", "confirmed", "provenance"], "assumption");
  const source = input["source"];
  if (source !== "operator" && source !== "repository" && source !== "model") {
    refuseIntake("intake.input.invalid", "assumption");
  }
  if (typeof input["confirmed"] !== "boolean") refuseIntake("intake.input.invalid", "assumption");
  const provenance = parseIntakeProvenance(input["provenance"]);
  const expected = source === "operator" ? "operator-supplied"
    : source === "repository" ? "approved-observation"
      : null;
  if (expected !== null && provenance.source !== expected) refuseIntake("intake.input.invalid", "assumption");
  if (source === "model" && !["model-proposed", "proposed-default", "derived-deterministically"].includes(provenance.source)) {
    refuseIntake("intake.input.invalid", "assumption");
  }
  return Object.freeze({
    text: validateIntakeText(input["text"], "assumption", {
      forbidAbsolutePath: true,
      forbidProtectedIdentifier: true,
    }),
    source,
    confirmed: input["confirmed"],
    provenance,
  });
}

function validateQuestionText(question: ClarificationQuestion): void {
  const options = { forbidAbsolutePath: true, forbidProtectedIdentifier: true } as const;
  validateIntakeText(question.question, "question", { ...options, maximum: 4_096 });
  validateIntakeText(question.whyItMatters, "question", { ...options, maximum: 4_096 });
  validateIntakeText(question.proposedDefault, "question", { ...options, maximum: 1_024 });
  validateIntakeText(question.consequenceIfDefaulted, "question", { ...options, maximum: 2_048 });
  if (question.options !== null) {
    for (const option of question.options) validateIntakeText(option, "question", { ...options, maximum: 1_024 });
  }
}

export function parseProposedIntakeQuestion(value: unknown): ProposedIntakeQuestion {
  const input = intakeRecord(value, "question");
  exactIntakeKeys(input, ["question", "blockingBasis", "provenance", "source"], "question");
  const basis = input["blockingBasis"];
  if (basis !== null && (typeof basis !== "string" || !(INTAKE_BLOCKING_BASES as readonly string[]).includes(basis))) {
    refuseIntake("intake.question.blocking-basis", "question");
  }
  const source = input["source"];
  if (typeof source !== "string" || !(INTAKE_QUESTION_SOURCES as readonly string[]).includes(source)) {
    refuseIntake("intake.input.invalid", "question");
  }
  let question: ClarificationQuestion;
  try {
    question = previewBrief({
      projectId: "prj:intake-question-validation",
      objective: "Validate one clarification question.",
      outcomes: Object.freeze(["Validate the question."]),
      nonGoals: Object.freeze([]),
      audiences: Object.freeze(["The intake engine."]),
      constraints: Object.freeze([]),
      assumptions: Object.freeze([]),
      openQuestions: Object.freeze([input["question"] as ClarificationQuestion]),
      sourceThreadId: null,
    }).openQuestions[0] as ClarificationQuestion;
  } catch (error) {
    return mapProjectRefusal(error, "question");
  }
  validateQuestionText(question);
  const blocking = question.blocking;
  if (typeof blocking !== "boolean" || blocking !== (basis !== null)) {
    refuseIntake("intake.question.blocking-basis", "question");
  }
  return Object.freeze({
    question,
    blockingBasis: basis as ProposedIntakeQuestion["blockingBasis"],
    provenance: parseIntakeProvenance(input["provenance"]),
    source: source as ProposedIntakeQuestion["source"],
  });
}

function previewBrief(input: Readonly<{
  projectId: string;
  objective: string;
  outcomes: readonly string[];
  nonGoals: readonly string[];
  audiences: readonly string[];
  constraints: readonly Constraint[];
  assumptions: readonly { readonly text: string; readonly source: "operator" | "repository" | "model"; readonly confirmed: boolean }[];
  openQuestions: readonly ClarificationQuestion[];
  sourceThreadId: string | null;
}>): ProjectBrief {
  try {
    return parseProjectBrief({
      schemaVersion: 1,
      briefId: PREVIEW_BRIEF_ID,
      projectId: input.projectId,
      revision: 1,
      supersedes: null,
      origin: "operator",
      objective: input.objective,
      outcomes: input.outcomes.length === 0 ? ["candidate-validation-placeholder"] : input.outcomes,
      nonGoals: input.nonGoals,
      audiences: input.audiences.length === 0 ? ["candidate-validation-placeholder"] : input.audiences,
      constraints: input.constraints,
      assumptions: input.assumptions,
      openQuestions: input.openQuestions,
      sourceThreadId: input.sourceThreadId,
      createdAt: PREVIEW_TIMESTAMP,
    });
  } catch (error) {
    return mapProjectRefusal(error, "candidate");
  }
}

function parseDraft(value: unknown): CandidateDraftInput {
  const input = intakeRecord(value, "candidate");
  exactIntakeKeys(input, [
    "projectId", "objective", "outcomes", "nonGoals", "audiences", "constraints",
    "assumptions", "openQuestions", "sourceThreadId",
  ], "candidate");
  const objective = parseTextField(input["objective"], "objective");
  if (objective.provenance.source !== "operator-supplied" || !objective.provenance.acceptedByOperator) {
    refuseIntake("intake.input.invalid", "objective");
  }
  const outcomes = intakeArray(input["outcomes"], "outcome", (item) => parseTextField(item, "outcome"));
  const nonGoals = intakeArray(input["nonGoals"], "nonGoal", (item) => parseTextField(item, "nonGoal"));
  const audiences = intakeArray(input["audiences"], "audience", (item) => parseTextField(item, "audience"));
  const constraints = intakeArray(input["constraints"], "constraint", parseConstraintField);
  const assumptions = intakeArray(input["assumptions"], "assumption", parseAssumptionField);
  const openQuestions = intakeArray(input["openQuestions"], "question", parseProposedIntakeQuestion);
  if (input["sourceThreadId"] !== null && typeof input["sourceThreadId"] !== "string") {
    refuseIntake("intake.input.invalid", "candidate");
  }
  const parsed = previewBrief({
    projectId: input["projectId"] as string,
    objective: objective.value,
    outcomes: outcomes.map((field) => field.value),
    nonGoals: nonGoals.map((field) => field.value),
    audiences: audiences.map((field) => field.value),
    constraints: constraints.map((field) => field.value),
    assumptions: assumptions.map(({ text, source, confirmed }) => ({ text, source, confirmed })),
    openQuestions: openQuestions.map((field) => field.question),
    sourceThreadId: input["sourceThreadId"] as string | null,
  });
  for (const question of parsed.openQuestions) validateQuestionText(question);
  return Object.freeze({
    projectId: parsed.projectId,
    objective,
    outcomes,
    nonGoals,
    audiences,
    constraints,
    assumptions,
    openQuestions: Object.freeze(openQuestions.map((field, index) => Object.freeze({
      ...field,
      question: parsed.openQuestions[index] as ClarificationQuestion,
    }))),
    sourceThreadId: parsed.sourceThreadId,
  });
}

export function candidateDigestMaterial(candidate: CandidateDraftInput): string {
  try {
    return serializeCanonicalProjectJson({
      projectId: candidate.projectId,
      objective: candidate.objective,
      outcomes: candidate.outcomes,
      nonGoals: candidate.nonGoals,
      audiences: candidate.audiences,
      constraints: candidate.constraints,
      assumptions: candidate.assumptions,
      openQuestions: candidate.openQuestions,
      sourceThreadId: candidate.sourceThreadId,
    });
  } catch (error) {
    return mapProjectRefusal(error, "candidate");
  }
}

export function assembleCandidate(value: CandidateDraftInput, digest: IntakeDigestPort): CandidateBrief {
  const parsed = parseDraft(value);
  const candidateDigest = validateDigest(digest.sha256(candidateDigestMaterial(parsed)), "candidate");
  const ready = parsed.outcomes.length > 0
    && parsed.audiences.length > 0
    && !parsed.openQuestions.some((item) => item.question.blocking);
  return Object.freeze({ ...parsed, candidateDigest, ready });
}

export function verifyCandidate(candidate: CandidateBrief, digest: IntakeDigestPort): CandidateBrief {
  try {
    const snapshot = intakeRecord(candidate, "candidate");
    exactIntakeKeys(snapshot, [
      "projectId", "objective", "outcomes", "nonGoals", "audiences", "constraints",
      "assumptions", "openQuestions", "sourceThreadId", "candidateDigest", "ready",
    ], "candidate");
    const rebuilt = assembleCandidate({
      projectId: snapshot["projectId"] as string,
      objective: snapshot["objective"] as CandidateBrief["objective"],
      outcomes: snapshot["outcomes"] as CandidateBrief["outcomes"],
      nonGoals: snapshot["nonGoals"] as CandidateBrief["nonGoals"],
      audiences: snapshot["audiences"] as CandidateBrief["audiences"],
      constraints: snapshot["constraints"] as CandidateBrief["constraints"],
      assumptions: snapshot["assumptions"] as CandidateBrief["assumptions"],
      openQuestions: snapshot["openQuestions"] as CandidateBrief["openQuestions"],
      sourceThreadId: snapshot["sourceThreadId"] as string | null,
    }, digest);
    if (rebuilt.candidateDigest !== snapshot["candidateDigest"] || rebuilt.ready !== snapshot["ready"]) {
      refuseIntake("intake.digest.mismatch", "candidate");
    }
    return rebuilt;
  } catch (error) {
    if (error instanceof IntakeError) throw error;
    return refuseIntake("intake.input.invalid", "candidate");
  }
}

export function materializeCandidateBrief(
  candidate: CandidateBrief,
  input: Readonly<{ briefId: string; supersedes: string | null; createdAt: string }>,
): ProjectBrief {
  if (!candidate.ready) refuseIntake("intake.candidate.not-ready", "candidate");
  try {
    return parseProjectBrief({
      schemaVersion: 1,
      briefId: input.briefId,
      projectId: candidate.projectId,
      revision: 1,
      supersedes: input.supersedes,
      origin: "operator",
      objective: candidate.objective.value,
      outcomes: candidate.outcomes.map((field) => field.value),
      nonGoals: candidate.nonGoals.map((field) => field.value),
      audiences: candidate.audiences.map((field) => field.value),
      constraints: candidate.constraints.map((field) => field.value),
      assumptions: candidate.assumptions.map(({ text, source, confirmed }) => ({ text, source, confirmed })),
      openQuestions: candidate.openQuestions.map((field) => field.question),
      sourceThreadId: candidate.sourceThreadId,
      createdAt: input.createdAt,
    });
  } catch (error) {
    return mapProjectRefusal(error, "brief");
  }
}

export function candidateFieldProvenance(candidate: CandidateBrief): CandidateFieldProvenance {
  return Object.freeze({
    objective: candidate.objective.provenance,
    outcomes: Object.freeze(candidate.outcomes.map((field) => field.provenance)),
    nonGoals: Object.freeze(candidate.nonGoals.map((field) => field.provenance)),
    audiences: Object.freeze(candidate.audiences.map((field) => field.provenance)),
    constraints: Object.freeze(candidate.constraints.map((field) => field.provenance)),
    assumptions: Object.freeze(candidate.assumptions.map((field) => field.provenance)),
    openQuestions: Object.freeze(candidate.openQuestions.map((field) => field.provenance)),
  });
}
