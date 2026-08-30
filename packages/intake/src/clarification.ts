import { serializeCanonicalProjectJson } from "@ai-dev-os/project";
import { assembleCandidate, parseProposedIntakeQuestion, verifyCandidate } from "./candidate.js";
import {
  INTAKE_LIMITS,
  INTAKE_QUESTION_SOURCES,
  type CandidateBrief,
  type ClarificationResolution,
  type ClarificationRound,
  type ClarificationSession,
  type DroppedClarificationQuestion,
  type IntakeAssumptionField,
  type IntakeDigestPort,
  type KnownIntakeFact,
  type ProposedIntakeQuestion,
} from "./contracts.js";
import { IntakeError, refuseIntake, type IntakeDiagnosticRoot } from "./errors.js";
import {
  exactIntakeKeys,
  intakeArray,
  intakeRecord,
  mapProjectRefusal,
  semanticIntakeKey,
  validateDigest,
  validateIntakeText,
} from "./text.js";

export function createClarificationSession(): ClarificationSession {
  return Object.freeze({ rounds: Object.freeze([]) });
}

function parseKnownFact(value: unknown): KnownIntakeFact {
  const input = intakeRecord(value, "clarification");
  exactIntakeKeys(input, ["source", "text"], "clarification");
  const source = input["source"];
  if (
    typeof source !== "string"
    || !(INTAKE_QUESTION_SOURCES as readonly string[]).includes(source)
    || source === "operator"
    || source === "derived"
  ) {
    refuseIntake("intake.input.invalid", "clarification");
  }
  return Object.freeze({
    source: source as KnownIntakeFact["source"],
    text: validateIntakeText(input["text"], "clarification", { forbidAbsolutePath: true }),
  });
}

function parseDroppedQuestion(value: unknown): DroppedClarificationQuestion {
  const input = intakeRecord(value, "clarification");
  exactIntakeKeys(input, ["questionId", "matchedSource", "semanticKey"], "clarification");
  const matchedSource = input["matchedSource"];
  if (typeof matchedSource !== "string" || !(INTAKE_QUESTION_SOURCES as readonly string[]).includes(matchedSource)) {
    refuseIntake("intake.input.invalid", "clarification");
  }
  const semanticKey = validateIntakeText(input["semanticKey"], "clarification", {
    maximum: 4_096,
    allowNewlines: false,
    allowEmpty: true,
    forbidAbsolutePath: true,
    forbidProtectedIdentifier: true,
  });
  if (semanticKey !== semanticIntakeKey(semanticKey)) refuseIntake("intake.input.invalid", "clarification");
  return Object.freeze({
    questionId: validateIntakeText(input["questionId"], "question", { maximum: 128, allowNewlines: false }),
    matchedSource: matchedSource as ProposedIntakeQuestion["source"],
    semanticKey,
  });
}

function parseSession(value: unknown): ClarificationSession {
  const input = intakeRecord(value, "clarification");
  exactIntakeKeys(input, ["rounds"], "clarification");
  const rounds = intakeArray(input["rounds"], "clarification", (roundValue) => {
    const round = intakeRecord(roundValue, "clarification");
    exactIntakeKeys(round, [
      "ordinal", "materialChangeReason", "questionSetDigest", "questions", "resolutions", "droppedDuplicates",
    ], "clarification");
    const ordinal = round["ordinal"];
    if (ordinal !== 1 && ordinal !== 2) refuseIntake("intake.input.invalid", "clarification");
    const materialChangeReason = round["materialChangeReason"] === null
      ? null
      : validateIntakeText(round["materialChangeReason"], "clarification", {
          maximum: 2_000,
          forbidAbsolutePath: true,
          forbidProtectedIdentifier: true,
        });
    return Object.freeze({
      ordinal,
      materialChangeReason,
      questionSetDigest: validateDigest(round["questionSetDigest"], "clarification"),
      questions: intakeArray(
        round["questions"],
        "question",
        parseProposedIntakeQuestion,
        INTAKE_LIMITS.collection,
      ),
      resolutions: intakeArray(
        round["resolutions"],
        "clarification",
        parseResolution,
        INTAKE_LIMITS.questionsPerRound,
      ),
      droppedDuplicates: intakeArray(round["droppedDuplicates"], "clarification", parseDroppedQuestion),
    });
  }, INTAKE_LIMITS.collection);
  return Object.freeze({ rounds });
}

function validateSession(value: unknown): ClarificationSession {
  const session = parseSession(value);
  if (session.rounds.length > INTAKE_LIMITS.clarificationRounds) {
    refuseIntake("intake.round.ceiling", "clarification");
  }
  const identifiers = new Set<string>();
  const semanticQuestions = new Set<string>();
  for (let index = 0; index < session.rounds.length; index += 1) {
    const round = session.rounds[index];
    if (round?.ordinal !== index + 1) refuseIntake("intake.input.invalid", "clarification");
    if ((round.ordinal === 1) !== (round.materialChangeReason === null)) {
      refuseIntake(round.ordinal === 2
        ? "intake.round.material-change-required"
        : "intake.input.invalid", "clarification");
    }
    if (round.questions.length > INTAKE_LIMITS.questionsPerRound) {
      refuseIntake("intake.round.too-many-questions", "clarification", {
        limit: INTAKE_LIMITS.questionsPerRound,
      });
    }
    if (round.questions.filter((question) => question.question.blocking).length > INTAKE_LIMITS.blockingQuestionsPerRound) {
      refuseIntake("intake.round.too-many-blocking", "clarification", {
        limit: INTAKE_LIMITS.blockingQuestionsPerRound,
      });
    }
    validateClarificationResolutions(round.questions, round.resolutions);
    for (const question of [...round.questions, ...round.droppedDuplicates]) {
      const questionId = "question" in question ? question.question.questionId : question.questionId;
      if (identifiers.has(questionId)) refuseIntake("intake.input.invalid", "question");
      identifiers.add(questionId);
    }
    for (const proposed of round.questions) {
      const semanticQuestion = semanticIntakeKey(proposed.question.question);
      if (semanticQuestions.has(semanticQuestion)) refuseIntake("intake.input.invalid", "question");
      semanticQuestions.add(semanticQuestion);
    }
  }
  return session;
}

function questionSetMaterial(
  ordinal: 1 | 2,
  materialChangeReason: string | null,
  questions: readonly ProposedIntakeQuestion[],
): string {
  try {
    return serializeCanonicalProjectJson({ ordinal, materialChangeReason, questions });
  } catch (error) {
    return mapProjectRefusal(error, "clarification");
  }
}

/** Internal digest primitive shared by round creation, verification, and durable decision parsing. */
export function clarificationQuestionSetDigest(
  ordinal: 1 | 2,
  materialChangeReason: string | null,
  questions: readonly ProposedIntakeQuestion[],
  digest: IntakeDigestPort,
): string {
  try {
    return validateDigest(digest.sha256(questionSetMaterial(ordinal, materialChangeReason, questions)), "clarification");
  } catch (error) {
    if (error instanceof IntakeError) throw error;
    return mapProjectRefusal(error, "clarification");
  }
}

export function openClarificationRound(
  input: Readonly<{
    session: ClarificationSession;
    questions: readonly ProposedIntakeQuestion[];
    knownFacts: readonly KnownIntakeFact[];
    materialChangeReason: string | null;
  }>,
  digest: IntakeDigestPort,
): ClarificationSession {
  const request = intakeRecord(input, "clarification");
  exactIntakeKeys(request, ["session", "questions", "knownFacts", "materialChangeReason"], "clarification");
  const session = verifyClarificationSession(request["session"] as ClarificationSession, digest);
  if (session.rounds.length >= INTAKE_LIMITS.clarificationRounds) {
    refuseIntake("intake.round.ceiling", "clarification", { limit: INTAKE_LIMITS.clarificationRounds });
  }
  const ordinal = (session.rounds.length + 1) as 1 | 2;
  const reason = request["materialChangeReason"] === null
    ? null
    : validateIntakeText(request["materialChangeReason"], "clarification", {
        maximum: 2_000,
        forbidAbsolutePath: true,
        forbidProtectedIdentifier: true,
      });
  if (ordinal === 2 && reason === null) {
    refuseIntake("intake.round.material-change-required", "clarification");
  }
  if (ordinal === 1 && reason !== null) refuseIntake("intake.input.invalid", "clarification");

  const questions = intakeArray(request["questions"], "question", parseProposedIntakeQuestion, INTAKE_LIMITS.collection);
  const facts = intakeArray(request["knownFacts"], "clarification", parseKnownFact, INTAKE_LIMITS.collection);
  const priorQuestions = session.rounds.flatMap((round) => round.questions);
  const known = new Map<string, ProposedIntakeQuestion["source"]>();
  for (const fact of facts) known.set(semanticIntakeKey(fact.text), fact.source);
  for (const question of priorQuestions) known.set(semanticIntakeKey(question.question.question), question.source);

  const accepted: ProposedIntakeQuestion[] = [];
  const dropped: DroppedClarificationQuestion[] = [];
  const ids = new Set(session.rounds.flatMap((round) => [
    ...round.questions.map((question) => question.question.questionId),
    ...round.droppedDuplicates.map((drop) => drop.questionId),
  ]));
  for (const question of questions) {
    if (ids.has(question.question.questionId)) refuseIntake("intake.input.invalid", "question");
    ids.add(question.question.questionId);
    const key = semanticIntakeKey(question.question.question);
    const matchedSource = known.get(key);
    if (matchedSource !== undefined) {
      dropped.push(Object.freeze({
        questionId: question.question.questionId,
        matchedSource,
        semanticKey: key,
      }));
      continue;
    }
    known.set(key, question.source);
    accepted.push(question);
  }
  if (accepted.length > INTAKE_LIMITS.questionsPerRound) {
    refuseIntake("intake.round.too-many-questions", "clarification", { limit: INTAKE_LIMITS.questionsPerRound });
  }
  if (accepted.filter((question) => question.question.blocking).length > INTAKE_LIMITS.blockingQuestionsPerRound) {
    refuseIntake("intake.round.too-many-blocking", "clarification", { limit: INTAKE_LIMITS.blockingQuestionsPerRound });
  }
  const questionSetDigest = clarificationQuestionSetDigest(ordinal, reason, accepted, digest);
  const round: ClarificationRound = Object.freeze({
    ordinal,
    materialChangeReason: reason,
    questionSetDigest,
    questions: Object.freeze(accepted),
    resolutions: Object.freeze([]),
    droppedDuplicates: Object.freeze(dropped),
  });
  clarificationRoundDecisionMaterial(round);
  return Object.freeze({ rounds: Object.freeze([...session.rounds, round]) });
}

function parseResolution(value: unknown): ClarificationResolution {
  const input = intakeRecord(value, "clarification");
  exactIntakeKeys(input, ["questionId", "kind", "value"], "clarification");
  const kind = input["kind"];
  if (kind !== "answered" && kind !== "defaulted" && kind !== "default-confirmed") {
    refuseIntake("intake.input.invalid", "clarification");
  }
  return Object.freeze({
    questionId: validateIntakeText(input["questionId"], "question", { maximum: 128, allowNewlines: false }),
    kind,
    value: validateIntakeText(input["value"], "clarification", {
      maximum: 1_024,
      forbidAbsolutePath: true,
      forbidProtectedIdentifier: true,
    }),
  });
}

/** Internal semantic validator shared by ephemeral rounds and durable decision parsing. */
export function validateClarificationResolutions(
  questions: readonly ProposedIntakeQuestion[],
  resolutions: readonly ClarificationResolution[],
  root: IntakeDiagnosticRoot = "clarification",
): void {
  const ids = new Set<string>();
  for (const resolution of resolutions) {
    if (ids.has(resolution.questionId)) refuseIntake("intake.input.invalid", root);
    ids.add(resolution.questionId);
    const proposed = questions.find((question) => question.question.questionId === resolution.questionId);
    if (proposed === undefined) refuseIntake("intake.input.invalid", root);
    if (proposed.question.blocking && resolution.kind === "defaulted") {
      refuseIntake("intake.blocking.unanswered", root);
    }
    if (!proposed.question.blocking && resolution.kind === "default-confirmed") {
      refuseIntake("intake.input.invalid", root);
    }
    if (
      (resolution.kind === "defaulted" || resolution.kind === "default-confirmed")
      && resolution.value !== proposed.question.proposedDefault
    ) {
      refuseIntake("intake.input.invalid", root);
    }
    if (
      resolution.kind === "answered"
      && proposed.question.options !== null
      && !proposed.question.options.includes(resolution.value)
    ) {
      refuseIntake("intake.input.invalid", root);
    }
  }
}

export function resolveClarificationRound(
  session: ClarificationSession,
  ordinal: 1 | 2,
  values: readonly ClarificationResolution[],
  digest: IntakeDigestPort,
): ClarificationSession {
  const parsedSession = verifyClarificationSession(session, digest);
  const target = parsedSession.rounds[ordinal - 1];
  if (target === undefined) refuseIntake("intake.input.invalid", "clarification");
  const resolutions = intakeArray(values, "clarification", parseResolution, INTAKE_LIMITS.questionsPerRound);
  validateClarificationResolutions(target.questions, resolutions);
  const replacement: ClarificationRound = Object.freeze({ ...target, resolutions: Object.freeze(resolutions) });
  clarificationRoundDecisionMaterial(replacement);
  return Object.freeze({
    rounds: Object.freeze(parsedSession.rounds.map((round) => round.ordinal === ordinal ? replacement : round)),
  });
}

function resolutionAssumption(
  question: ProposedIntakeQuestion,
  resolution: ClarificationResolution,
): IntakeAssumptionField {
  if (resolution.kind === "answered") {
    return Object.freeze({
      text: `${question.question.question} Answer: ${resolution.value}`,
      source: "operator",
      confirmed: true,
      provenance: Object.freeze({ source: "operator-supplied", acceptedByOperator: true }),
    });
  }
  const confirmed = resolution.kind === "default-confirmed";
  return Object.freeze({
    text: `${question.question.question} Default: ${resolution.value} Consequence: ${question.question.consequenceIfDefaulted}`,
    source: "model",
    confirmed,
    provenance: Object.freeze({ source: "proposed-default", acceptedByOperator: confirmed }),
  });
}

export function clarificationResolutionAssumptions(
  sessionValue: ClarificationSession,
): readonly IntakeAssumptionField[] {
  const session = validateSession(sessionValue);
  const assumptions: IntakeAssumptionField[] = [];
  for (const round of session.rounds) {
    for (const resolution of round.resolutions) {
      const question = round.questions.find((item) => item.question.questionId === resolution.questionId);
      if (question === undefined) refuseIntake("intake.input.invalid", "clarification");
      assumptions.push(resolutionAssumption(question, resolution));
    }
  }
  return Object.freeze(assumptions);
}

export function applyClarificationsToCandidate(
  candidate: CandidateBrief,
  session: ClarificationSession,
  digest: IntakeDigestPort,
): CandidateBrief {
  const parsedCandidate = verifyCandidate(candidate, digest);
  const parsedSession = verifyClarificationSession(session, digest);
  const resolutions = new Map<string, Readonly<{ resolution: ClarificationResolution; question: ProposedIntakeQuestion }>>();
  for (const round of parsedSession.rounds) {
    for (const resolution of round.resolutions) {
      const question = round.questions.find((item) => item.question.questionId === resolution.questionId);
      if (question === undefined || resolutions.has(resolution.questionId)) {
        refuseIntake("intake.input.invalid", "clarification");
      }
      resolutions.set(resolution.questionId, { resolution, question });
    }
  }
  const assumptions: IntakeAssumptionField[] = [
    ...parsedCandidate.assumptions,
    ...clarificationResolutionAssumptions(parsedSession),
  ];
  return assembleCandidate({
    projectId: parsedCandidate.projectId,
    objective: parsedCandidate.objective,
    outcomes: parsedCandidate.outcomes,
    nonGoals: parsedCandidate.nonGoals,
    audiences: parsedCandidate.audiences,
    constraints: parsedCandidate.constraints,
    assumptions: Object.freeze(assumptions),
    openQuestions: Object.freeze(parsedCandidate.openQuestions.filter(
      (question) => !resolutions.has(question.question.questionId),
    )),
    sourceThreadId: parsedCandidate.sourceThreadId,
  }, digest);
}

export function restartClarification(_session: ClarificationSession): ClarificationSession {
  return createClarificationSession();
}

export function verifyClarificationSession(
  session: ClarificationSession,
  digest: IntakeDigestPort,
): ClarificationSession {
  const parsed = validateSession(session);
  for (const round of parsed.rounds) {
    const actualDigest = clarificationQuestionSetDigest(
      round.ordinal,
      round.materialChangeReason,
      round.questions,
      digest,
    );
    if (actualDigest !== round.questionSetDigest) {
      refuseIntake("intake.digest.mismatch", "clarification");
    }
    clarificationRoundDecisionMaterial(round);
  }
  return parsed;
}

export function unresolvedBlockingQuestions(session: ClarificationSession): readonly string[] {
  const parsed = validateSession(session);
  const unresolved: string[] = [];
  for (const round of parsed.rounds) {
    const resolved = new Set(round.resolutions.map((item) => item.questionId));
    for (const question of round.questions) {
      if (question.question.blocking && !resolved.has(question.question.questionId)) {
        unresolved.push(question.question.questionId);
      }
    }
  }
  return Object.freeze(unresolved);
}

export function clarificationRoundDecisionMaterial(round: ClarificationRound): string {
  try {
    const material = serializeCanonicalProjectJson({
      ordinal: round.ordinal,
      questionSetDigest: round.questionSetDigest,
      materialChangeReason: round.materialChangeReason,
      questions: round.questions,
      resolutions: round.resolutions,
      unresolvedQuestionIds: round.questions
        .filter((question) => !round.resolutions.some((resolution) => resolution.questionId === question.question.questionId))
        .map((question) => question.question.questionId),
    });
    return validateIntakeText(material, "clarification", {
      maximum: INTAKE_LIMITS.clarificationDecisionMaterial,
      allowDigest: true,
    });
  } catch (error) {
    return mapProjectRefusal(error, "clarification");
  }
}
