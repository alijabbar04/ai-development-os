import {
  assertContentDerivedIdentity,
  assertNewBrief,
  parseDecision,
  parseProjectBrief,
  serializeCanonicalProjectJson,
  type Decision,
  type ProjectBrief,
} from "@ai-dev-os/project";
import {
  candidateFieldProvenance,
  materializeCandidateBrief,
  parseIntakeProvenance,
  parseProposedIntakeQuestion,
  verifyCandidate,
} from "./candidate.js";
import {
  clarificationQuestionSetDigest,
  clarificationResolutionAssumptions,
  clarificationRoundDecisionMaterial,
  unresolvedBlockingQuestions,
  validateClarificationResolutions,
  verifyClarificationSession,
} from "./clarification.js";
import {
  INTAKE_LIMITS,
  type AcceptCandidateRequest,
  type AcceptanceBinding,
  type AcceptanceOutcome,
  type CandidateBrief,
  type CandidateFieldProvenance,
  type ClarificationRound,
  type ClarificationSession,
  type IntakeAcceptanceEventPayload,
  type IntakeAcceptanceStore,
  type IntakeClock,
  type IntakeDigestPort,
  type IntakeProvenance,
  type OperatorAcceptanceEvidence,
  type PreparedAcceptance,
  type StoreReconciliation,
  type StoreWriteAttempt,
} from "./contracts.js";
import { IntakeError, refuseIntake } from "./errors.js";
import {
  exactIntakeKeys,
  intakeArray,
  intakeRecord,
  mapProjectRefusal,
  parseIntakeJsonText,
  validateDigest,
  validateIntakeText,
  validateSafeInteger,
} from "./text.js";

function canonical(value: unknown, root: "binding" | "decision" | "acceptance"): string {
  try {
    return serializeCanonicalProjectJson(value);
  } catch (error) {
    return mapProjectRefusal(error, root);
  }
}

function sha256(digest: IntakeDigestPort, material: string, root: "binding" | "decision" | "acceptance"): string {
  try {
    return validateDigest(digest.sha256(material), root);
  } catch (error) {
    if (error instanceof IntakeError) throw error;
    return refuseIntake("intake.input.invalid", root);
  }
}

export function decisionIdentityMaterial(decision: Omit<Decision, "decisionId">): string {
  return canonical(decision, "decision");
}

/** Semantic replay material deliberately omits store-stamped acceptance time and content ids. */
export function acceptanceReplayMaterial(event: IntakeAcceptanceEventPayload): string {
  const { briefId: _briefId, createdAt: _createdAt, ...brief } = event.brief;
  return canonical({
    schemaVersion: event.schemaVersion,
    kind: event.kind,
    binding: event.binding,
    aggregateVersion: event.aggregateVersion,
    brief,
    provenance: event.provenance,
    decisions: event.decisions.map(({ decisionId: _decisionId, decidedAt: _decidedAt, ...decision }) => decision),
    operatorEvidence: {
      schemaVersion: event.operatorEvidence.schemaVersion,
      evidenceId: event.operatorEvidence.evidenceId,
      kind: event.operatorEvidence.kind,
      candidateDigest: event.operatorEvidence.candidateDigest,
      authority: event.operatorEvidence.authority,
    },
  }, "acceptance");
}

function buildDecision(
  input: Omit<Decision, "decisionId">,
  digest: IntakeDigestPort,
): Decision {
  const fullDigest = sha256(digest, decisionIdentityMaterial(input), "decision");
  let decision: Decision;
  try {
    decision = parseDecision({ ...input, decisionId: `dec:${fullDigest.slice(0, 32)}` });
    assertContentDerivedIdentity({ kind: "decision", record: decision }, fullDigest);
  } catch (error) {
    return mapProjectRefusal(error, "decision");
  }
  return decision;
}

function clarificationDecision(
  projectId: string,
  round: ClarificationRound,
  acceptedAt: string,
  digest: IntakeDigestPort,
): Decision {
  return buildDecision({
    schemaVersion: 1,
    revision: 1,
    projectId,
    scope: Object.freeze({ planId: null, planRevision: null, stageId: null, taskId: null }),
    kind: "clarification-answer",
    decidedBy: "operator",
    statement: `Accepted clarification round ${String(round.ordinal)}.`,
    rationale: clarificationRoundDecisionMaterial(round),
    supersedes: null,
    subjectDigest: round.questionSetDigest,
    decidedAt: acceptedAt,
  }, digest);
}

function revisionDecision(
  projectId: string,
  previousBriefId: string,
  bindingDigest: string,
  acceptedAt: string,
  digest: IntakeDigestPort,
): Decision {
  return buildDecision({
    schemaVersion: 1,
    revision: 1,
    projectId,
    scope: Object.freeze({ planId: null, planRevision: null, stageId: null, taskId: null }),
    kind: "brief-revision-accepted",
    decidedBy: "operator",
    statement: "Accepted a revision of the project brief.",
    rationale: canonical({ previousBriefId, bindingDigest }, "decision"),
    supersedes: null,
    subjectDigest: bindingDigest,
    decidedAt: acceptedAt,
  }, digest);
}

function canonicalTimestamp(clock: IntakeClock): string {
  try {
    const value = clock.now();
    if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
      return refuseIntake("intake.input.invalid", "acceptance");
    }
    const timestamp = value.toISOString();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(timestamp)) {
      return refuseIntake("intake.input.invalid", "acceptance");
    }
    return timestamp;
  } catch (error) {
    if (error instanceof IntakeError) throw error;
    return refuseIntake("intake.input.invalid", "acceptance");
  }
}

function acceptanceBinding(request: AcceptCandidateRequest, intakeDecisionDigest: string): AcceptanceBinding {
  if (request.expectedHead === null) {
    if (request.expectedAggregateVersion !== 0) refuseIntake("intake.version.invalid", "binding");
    return Object.freeze({
      candidateDigest: request.candidate.candidateDigest,
      expectedHeadBriefId: null,
      expectedAggregateVersion: 0,
      intakeDecisionDigest,
    });
  }
  let head: ProjectBrief;
  try {
    head = parseProjectBrief(request.expectedHead);
  } catch (error) {
    return mapProjectRefusal(error, "brief");
  }
  if (head.projectId !== request.candidate.projectId || request.expectedAggregateVersion < 1) {
    refuseIntake("intake.version.invalid", "binding");
  }
  return Object.freeze({
    candidateDigest: request.candidate.candidateDigest,
    expectedHeadBriefId: head.briefId,
    expectedAggregateVersion: validateSafeInteger(
      request.expectedAggregateVersion,
      "binding",
      1,
      Number.MAX_SAFE_INTEGER - 1,
    ),
    intakeDecisionDigest,
  });
}

function intakeDecisionBindingMaterial(
  values: readonly Readonly<{ readonly subjectDigest: string; readonly rationale: string | null }>[],
): string {
  return canonical(values.map((value) => Object.freeze({
    subjectDigest: value.subjectDigest,
    rationale: value.rationale,
  })), "binding");
}

function assertClarificationApplied(candidate: CandidateBrief, clarification: ClarificationSession): void {
  const expectedAssumptions = clarificationResolutionAssumptions(clarification);
  const actualCounts = new Map<string, number>();
  for (const assumption of candidate.assumptions) {
    const key = canonical(assumption, "acceptance");
    actualCounts.set(key, (actualCounts.get(key) ?? 0) + 1);
  }
  for (const assumption of expectedAssumptions) {
    const key = canonical(assumption, "acceptance");
    const count = actualCounts.get(key) ?? 0;
    if (count < 1) refuseIntake("intake.input.invalid", "clarification");
    actualCounts.set(key, count - 1);
  }
  const openById = new Map(candidate.openQuestions.map((question) => [question.question.questionId, question]));
  for (const round of clarification.rounds) {
    const resolved = new Set(round.resolutions.map((resolution) => resolution.questionId));
    for (const question of round.questions) {
      const open = openById.get(question.question.questionId);
      if (resolved.has(question.question.questionId)) {
        if (open !== undefined) refuseIntake("intake.input.invalid", "clarification");
      } else if (open === undefined || canonical(open, "acceptance") !== canonical(question, "acceptance")) {
        refuseIntake("intake.input.invalid", "clarification");
      }
    }
  }
}

function parseAcceptanceRequest(
  value: unknown,
  digest: IntakeDigestPort,
): AcceptCandidateRequest {
  const input = intakeRecord(value, "acceptance");
  exactIntakeKeys(input, [
    "candidate", "presentedDigest", "expectedHead", "expectedAggregateVersion", "clarification", "operatorConfirmed",
  ], "acceptance");
  if (input["operatorConfirmed"] !== true) refuseIntake("intake.input.invalid", "acceptance");
  const candidate = verifyCandidate(input["candidate"] as CandidateBrief, digest);
  let expectedHead: ProjectBrief | null = null;
  if (input["expectedHead"] !== null) {
    try {
      expectedHead = parseProjectBrief(input["expectedHead"]);
    } catch (error) {
      return mapProjectRefusal(error, "brief");
    }
  }
  return Object.freeze({
    candidate,
    presentedDigest: validateDigest(input["presentedDigest"], "acceptance"),
    expectedHead,
    expectedAggregateVersion: validateSafeInteger(
      input["expectedAggregateVersion"],
      "binding",
      0,
      Number.MAX_SAFE_INTEGER - 1,
    ),
    clarification: verifyClarificationSession(input["clarification"] as ClarificationSession, digest),
    operatorConfirmed: true,
  });
}

export function prepareCandidateAcceptance(
  request: AcceptCandidateRequest,
  ports: Readonly<{ digest: IntakeDigestPort; clock: IntakeClock }>,
): PreparedAcceptance {
  const parsedRequest = parseAcceptanceRequest(request, ports.digest);
  const candidate = parsedRequest.candidate;
  const presentedDigest = parsedRequest.presentedDigest;
  if (presentedDigest !== candidate.candidateDigest) refuseIntake("intake.digest.mismatch", "acceptance");
  const clarification = parsedRequest.clarification;
  if (unresolvedBlockingQuestions(clarification).length > 0 || candidate.openQuestions.some((item) => item.question.blocking)) {
    refuseIntake("intake.blocking.unanswered", "clarification");
  }
  if (!candidate.ready) refuseIntake("intake.candidate.not-ready", "candidate");
  assertClarificationApplied(candidate, clarification);
  const acceptedAt = canonicalTimestamp(ports.clock);
  const clarificationDecisions = clarification.rounds.map((round) => clarificationDecision(
    candidate.projectId,
    round,
    acceptedAt,
    ports.digest,
  ));
  const intakeDecisionDigest = sha256(
    ports.digest,
    intakeDecisionBindingMaterial(clarificationDecisions),
    "binding",
  );
  const binding = acceptanceBinding({ ...parsedRequest, candidate }, intakeDecisionDigest);
  const bindingDigest = sha256(ports.digest, canonical(binding, "binding"), "binding");
  const projectDigest = sha256(
    ports.digest,
    canonical({ aggregateType: "project-brief", projectId: candidate.projectId }, "binding"),
    "binding",
  );
  const brief = materializeCandidateBrief(candidate, {
    briefId: `brf:${bindingDigest.slice(0, 32)}`,
    supersedes: binding.expectedHeadBriefId,
    createdAt: acceptedAt,
  });
  if (parsedRequest.expectedHead !== null) {
    try {
      assertNewBrief(parsedRequest.expectedHead, brief);
    } catch (error) {
      return mapProjectRefusal(error, "brief");
    }
  }
  const decisions: Decision[] = [...clarificationDecisions];
  if (parsedRequest.expectedHead !== null) {
    decisions.push(revisionDecision(candidate.projectId, parsedRequest.expectedHead.briefId, bindingDigest, acceptedAt, ports.digest));
  }
  const operatorEvidence: OperatorAcceptanceEvidence = Object.freeze({
    schemaVersion: 1,
    evidenceId: `intake-evidence:${bindingDigest.slice(0, 32)}`,
    kind: "explicit-operator-acceptance",
    candidateDigest: candidate.candidateDigest,
    acceptedAt,
    authority: "brief-only",
  });
  const aggregateVersion = binding.expectedAggregateVersion + 1;
  const event = parseIntakeAcceptanceEvent({
    schemaVersion: 1,
    kind: "project-brief-accepted",
    binding,
    aggregateVersion,
    brief,
    provenance: candidateFieldProvenance(candidate),
    decisions,
    operatorEvidence,
  }, ports.digest);
  return Object.freeze({
    candidate,
    aggregateId: `project-brief:${projectDigest.slice(0, 32)}`,
    eventId: `intake:${bindingDigest.slice(0, 32)}`,
    bindingDigest,
    binding,
    aggregateVersion,
    brief,
    event,
  });
}

/** Runtime guard for the C7 composition boundary; TypeScript types are not authority. */
export function parsePreparedAcceptance(
  value: unknown,
  digest: IntakeDigestPort,
): PreparedAcceptance {
  const input = intakeRecord(value, "acceptance");
  exactIntakeKeys(input, [
    "candidate", "aggregateId", "eventId", "bindingDigest", "binding", "aggregateVersion", "brief", "event",
  ], "acceptance");
  const candidate = verifyCandidate(input["candidate"] as CandidateBrief, digest);
  if (!candidate.ready || candidate.openQuestions.some((item) => item.question.blocking)) {
    refuseIntake("intake.candidate.not-ready", "candidate");
  }
  const event = parseIntakeAcceptanceEvent(input["event"], digest);
  let brief: ProjectBrief;
  try {
    brief = parseProjectBrief(input["brief"]);
  } catch (error) {
    return mapProjectRefusal(error, "brief");
  }
  const bindingDigest = validateDigest(input["bindingDigest"], "binding");
  const expectedBindingDigest = sha256(digest, canonical(event.binding, "binding"), "binding");
  const projectDigest = sha256(
    digest,
    canonical({ aggregateType: "project-brief", projectId: candidate.projectId }, "binding"),
    "binding",
  );
  const aggregateId = validateIntakeText(input["aggregateId"], "binding", {
    maximum: 128,
    allowNewlines: false,
  });
  const eventId = validateIntakeText(input["eventId"], "binding", {
    maximum: 128,
    allowNewlines: false,
  });
  const aggregateVersion = validateSafeInteger(input["aggregateVersion"], "acceptance", 1, Number.MAX_SAFE_INTEGER);
  const expectedBriefMaterial = canonical({
    schemaVersion: 1,
    projectId: candidate.projectId,
    revision: 1,
    origin: "operator",
    objective: candidate.objective.value,
    outcomes: candidate.outcomes.map((field) => field.value),
    nonGoals: candidate.nonGoals.map((field) => field.value),
    audiences: candidate.audiences.map((field) => field.value),
    constraints: candidate.constraints.map((field) => field.value),
    assumptions: candidate.assumptions.map(({ text, source, confirmed }) => ({ text, source, confirmed })),
    openQuestions: candidate.openQuestions.map((field) => field.question),
    sourceThreadId: candidate.sourceThreadId,
  }, "acceptance");
  const { briefId: _briefId, supersedes: _supersedes, createdAt: _createdAt, ...actualBriefMaterial } = brief;
  if (
    bindingDigest !== expectedBindingDigest
    || aggregateId !== `project-brief:${projectDigest.slice(0, 32)}`
    || eventId !== `intake:${bindingDigest.slice(0, 32)}`
    || aggregateVersion !== event.aggregateVersion
    || event.binding.candidateDigest !== candidate.candidateDigest
    || canonical(input["binding"], "binding") !== canonical(event.binding, "binding")
    || canonical(brief, "acceptance") !== canonical(event.brief, "acceptance")
    || canonical(actualBriefMaterial, "acceptance") !== expectedBriefMaterial
    || canonical(event.provenance, "acceptance") !== canonical(candidateFieldProvenance(candidate), "acceptance")
  ) {
    refuseIntake("intake.input.invalid", "acceptance");
  }
  return Object.freeze({
    candidate,
    aggregateId,
    eventId,
    bindingDigest,
    binding: event.binding,
    aggregateVersion,
    brief,
    event,
  });
}

function parseBinding(value: unknown): AcceptanceBinding {
  const input = intakeRecord(value, "binding");
  exactIntakeKeys(input, [
    "candidateDigest", "expectedHeadBriefId", "expectedAggregateVersion", "intakeDecisionDigest",
  ], "binding");
  const expectedHead = input["expectedHeadBriefId"];
  if (expectedHead !== null && (typeof expectedHead !== "string" || !/^brf:[A-Za-z0-9._:-]{1,124}$/u.test(expectedHead))) {
    refuseIntake("intake.input.invalid", "binding");
  }
  const expectedVersion = validateSafeInteger(input["expectedAggregateVersion"], "binding", 0, Number.MAX_SAFE_INTEGER - 1);
  if ((expectedHead === null) !== (expectedVersion === 0)) refuseIntake("intake.version.invalid", "binding");
  return Object.freeze({
    candidateDigest: validateDigest(input["candidateDigest"], "binding"),
    expectedHeadBriefId: expectedHead as string | null,
    expectedAggregateVersion: expectedVersion,
    intakeDecisionDigest: validateDigest(input["intakeDecisionDigest"], "binding"),
  });
}

function parseProvenanceArray(value: unknown): readonly IntakeProvenance[] {
  return intakeArray(value, "acceptance", parseIntakeProvenance);
}

function parseFieldProvenance(value: unknown, brief: ProjectBrief): CandidateFieldProvenance {
  const input = intakeRecord(value, "acceptance");
  exactIntakeKeys(input, ["objective", "outcomes", "nonGoals", "audiences", "constraints", "assumptions", "openQuestions"], "acceptance");
  const parsed = Object.freeze({
    objective: parseIntakeProvenance(input["objective"]),
    outcomes: parseProvenanceArray(input["outcomes"]),
    nonGoals: parseProvenanceArray(input["nonGoals"]),
    audiences: parseProvenanceArray(input["audiences"]),
    constraints: parseProvenanceArray(input["constraints"]),
    assumptions: parseProvenanceArray(input["assumptions"]),
    openQuestions: parseProvenanceArray(input["openQuestions"]),
  });
  if (
    parsed.outcomes.length !== brief.outcomes.length
    || parsed.nonGoals.length !== brief.nonGoals.length
    || parsed.audiences.length !== brief.audiences.length
    || parsed.constraints.length !== brief.constraints.length
    || parsed.assumptions.length !== brief.assumptions.length
    || parsed.openQuestions.length !== brief.openQuestions.length
  ) {
    refuseIntake("intake.input.invalid", "acceptance");
  }
  if (parsed.objective.source !== "operator-supplied" || !parsed.objective.acceptedByOperator) {
    refuseIntake("intake.input.invalid", "acceptance");
  }
  for (let index = 0; index < brief.constraints.length; index += 1) {
    const constraint = brief.constraints[index];
    const source = parsed.constraints[index]?.source;
    const allowed = constraint?.origin === "operator" ? source === "operator-supplied"
      : constraint?.origin === "repository" ? source === "approved-observation"
        : source === "model-proposed" || source === "derived-deterministically";
    if (!allowed) refuseIntake("intake.input.invalid", "acceptance");
  }
  for (let index = 0; index < brief.assumptions.length; index += 1) {
    const assumption = brief.assumptions[index];
    const source = parsed.assumptions[index]?.source;
    const allowed = assumption?.source === "operator" ? source === "operator-supplied"
      : assumption?.source === "repository" ? source === "approved-observation"
        : source === "model-proposed" || source === "proposed-default" || source === "derived-deterministically";
    if (!allowed) refuseIntake("intake.input.invalid", "acceptance");
  }
  return parsed;
}

function parseOperatorEvidence(value: unknown): OperatorAcceptanceEvidence {
  const input = intakeRecord(value, "acceptance");
  exactIntakeKeys(input, ["schemaVersion", "evidenceId", "kind", "candidateDigest", "acceptedAt", "authority"], "acceptance");
  if (input["schemaVersion"] !== 1 || input["kind"] !== "explicit-operator-acceptance" || input["authority"] !== "brief-only") {
    refuseIntake("intake.input.invalid", "acceptance");
  }
  const evidenceId = validateIntakeText(input["evidenceId"], "acceptance", { maximum: 128, allowNewlines: false });
  if (!/^intake-evidence:[a-f0-9]{32}$/u.test(evidenceId)) refuseIntake("intake.input.invalid", "acceptance");
  return Object.freeze({
    schemaVersion: 1,
    evidenceId,
    kind: "explicit-operator-acceptance",
    candidateDigest: validateDigest(input["candidateDigest"], "acceptance"),
    acceptedAt: validateIntakeText(input["acceptedAt"], "acceptance", { maximum: 24, allowNewlines: false }),
    authority: "brief-only",
  });
}

function validateClarificationDecisionMaterial(
  decision: Decision,
  index: number,
  digest: IntakeDigestPort,
): ClarificationRound {
  if (decision.rationale === null || decision.supersedes !== null || decision.revision !== 1) {
    refuseIntake("intake.input.invalid", "decision");
  }
  let parsedJson: unknown;
  try {
    parsedJson = parseIntakeJsonText(decision.rationale);
  } catch {
    return refuseIntake("intake.input.invalid", "decision");
  }
  const material = intakeRecord(parsedJson, "decision");
  exactIntakeKeys(material, [
    "ordinal", "questionSetDigest", "materialChangeReason", "questions", "resolutions", "unresolvedQuestionIds",
  ], "decision");
  const parsedOrdinal = validateSafeInteger(material["ordinal"], "decision", 1, INTAKE_LIMITS.clarificationRounds);
  if (parsedOrdinal !== 1 && parsedOrdinal !== 2) refuseIntake("intake.input.invalid", "decision");
  const ordinal = parsedOrdinal;
  const questionSetDigest = validateDigest(material["questionSetDigest"], "decision");
  const materialChangeReason = material["materialChangeReason"] === null
    ? null
    : validateIntakeText(material["materialChangeReason"], "decision", {
        maximum: 2_000,
        forbidAbsolutePath: true,
        forbidProtectedIdentifier: true,
      });
  if (ordinal !== index + 1 || (ordinal === 1) !== (materialChangeReason === null)) {
    refuseIntake("intake.input.invalid", "decision");
  }
  const questions = intakeArray(
    material["questions"],
    "decision",
    parseProposedIntakeQuestion,
    INTAKE_LIMITS.questionsPerRound,
  );
  if (
    new Set(questions.map((question) => question.question.questionId)).size !== questions.length
    || questions.filter((question) => question.question.blocking).length > INTAKE_LIMITS.blockingQuestionsPerRound
  ) {
    refuseIntake("intake.input.invalid", "decision");
  }
  const resolutions = intakeArray(material["resolutions"], "decision", (value) => {
    const resolution = intakeRecord(value, "decision");
    exactIntakeKeys(resolution, ["questionId", "kind", "value"], "decision");
    const questionId = validateIntakeText(resolution["questionId"], "decision", {
      maximum: 128,
      allowNewlines: false,
    });
    const kind = resolution["kind"];
    if (kind !== "answered" && kind !== "defaulted" && kind !== "default-confirmed") {
      refuseIntake("intake.input.invalid", "decision");
    }
    return Object.freeze({
      questionId,
      kind,
      value: validateIntakeText(resolution["value"], "decision", {
        maximum: 1_024,
        forbidAbsolutePath: true,
        forbidProtectedIdentifier: true,
      }),
    });
  }, INTAKE_LIMITS.questionsPerRound);
  validateClarificationResolutions(questions, resolutions, "decision");
  const unresolvedQuestionIds = intakeArray(material["unresolvedQuestionIds"], "decision", (value) =>
    validateIntakeText(value, "decision", { maximum: 128, allowNewlines: false }),
    INTAKE_LIMITS.questionsPerRound);
  const resolvedIds = new Set(resolutions.map((resolution) => resolution.questionId));
  const expectedUnresolved = questions
    .filter((question) => !resolvedIds.has(question.question.questionId))
    .map((question) => question.question.questionId);
  const actualQuestionSetDigest = clarificationQuestionSetDigest(
    ordinal,
    materialChangeReason,
    questions,
    digest,
  );
  if (
    unresolvedQuestionIds.length !== expectedUnresolved.length
    || unresolvedQuestionIds.some((questionId, unresolvedIndex) => questionId !== expectedUnresolved[unresolvedIndex])
    || questions.some((question) => question.question.blocking && !resolvedIds.has(question.question.questionId))
    || actualQuestionSetDigest !== questionSetDigest
    || decision.subjectDigest !== questionSetDigest
    || canonical(material, "decision") !== decision.rationale
  ) {
    refuseIntake("intake.input.invalid", "decision");
  }
  return Object.freeze({
    ordinal,
    materialChangeReason,
    questionSetDigest,
    questions,
    resolutions,
    droppedDuplicates: Object.freeze([]),
  });
}

function assertDurableClarificationApplied(
  brief: ProjectBrief,
  provenance: CandidateFieldProvenance,
  clarification: ClarificationSession,
): void {
  const actualAssumptionCounts = new Map<string, number>();
  for (let index = 0; index < brief.assumptions.length; index += 1) {
    const assumption = brief.assumptions[index];
    const assumptionProvenance = provenance.assumptions[index];
    if (assumption === undefined || assumptionProvenance === undefined) {
      refuseIntake("intake.input.invalid", "acceptance");
    }
    const key = canonical({ ...assumption, provenance: assumptionProvenance }, "acceptance");
    actualAssumptionCounts.set(key, (actualAssumptionCounts.get(key) ?? 0) + 1);
  }
  for (const assumption of clarificationResolutionAssumptions(clarification)) {
    const key = canonical(assumption, "acceptance");
    const count = actualAssumptionCounts.get(key) ?? 0;
    if (count < 1) refuseIntake("intake.input.invalid", "clarification");
    actualAssumptionCounts.set(key, count - 1);
  }

  for (const round of clarification.rounds) {
    const resolved = new Set(round.resolutions.map((resolution) => resolution.questionId));
    for (const proposed of round.questions) {
      const matches = brief.openQuestions.flatMap((question, questionIndex) =>
        question.questionId === proposed.question.questionId
          ? [{ question, provenance: provenance.openQuestions[questionIndex] }]
          : []);
      if (resolved.has(proposed.question.questionId)) {
        if (matches.length !== 0) refuseIntake("intake.input.invalid", "clarification");
        continue;
      }
      const match = matches[0];
      if (
        matches.length !== 1
        || match === undefined
        || match.provenance === undefined
        || canonical(match.question, "acceptance") !== canonical(proposed.question, "acceptance")
        || canonical(match.provenance, "acceptance") !== canonical(proposed.provenance, "acceptance")
      ) {
        refuseIntake("intake.input.invalid", "clarification");
      }
    }
  }
}

export function parseIntakeAcceptanceEvent(
  value: unknown,
  digest: IntakeDigestPort,
): IntakeAcceptanceEventPayload {
  const input = intakeRecord(value, "acceptance");
  exactIntakeKeys(input, ["schemaVersion", "kind", "binding", "aggregateVersion", "brief", "provenance", "decisions", "operatorEvidence"], "acceptance");
  if (input["schemaVersion"] !== 1 || input["kind"] !== "project-brief-accepted") {
    refuseIntake("intake.input.invalid", "acceptance");
  }
  const binding = parseBinding(input["binding"]);
  const aggregateVersion = validateSafeInteger(input["aggregateVersion"], "acceptance", 1, Number.MAX_SAFE_INTEGER);
  let brief: ProjectBrief;
  try {
    brief = parseProjectBrief(input["brief"]);
  } catch (error) {
    return mapProjectRefusal(error, "brief");
  }
  if (brief.openQuestions.some((question) => question.blocking)) {
    refuseIntake("intake.candidate.not-ready", "brief");
  }
  const provenance = parseFieldProvenance(input["provenance"], brief);
  const decisions = intakeArray(input["decisions"], "decision", (item) => {
    let decision: Decision;
    try {
      decision = parseDecision(item);
    } catch (error) {
      return mapProjectRefusal(error, "decision");
    }
    if (
      !["clarification-answer", "brief-revision-accepted"].includes(decision.kind)
      || decision.decidedBy !== "operator"
      || Object.values(decision.scope).some((scope) => scope !== null)
      || decision.projectId !== brief.projectId
    ) {
      refuseIntake("intake.input.invalid", "decision");
    }
    validateIntakeText(decision.statement, "decision", { forbidAbsolutePath: true });
    if (decision.rationale !== null) {
      validateIntakeText(decision.rationale, "decision", {
        forbidAbsolutePath: true,
        // Both accepted decision kinds carry a separately verified bound digest in canonical JSON.
        allowDigest: true,
      });
    }
    const { decisionId: _decisionId, ...material } = decision;
    const fullDigest = sha256(digest, decisionIdentityMaterial(material), "decision");
    try {
      assertContentDerivedIdentity({ kind: "decision", record: decision }, fullDigest);
    } catch (error) {
      return mapProjectRefusal(error, "decision");
    }
    return decision;
  });
  const operatorEvidence = parseOperatorEvidence(input["operatorEvidence"]);
  const bindingDigest = sha256(digest, canonical(binding, "binding"), "binding");
  const revisionDecisions = decisions.filter((decision) => decision.kind === "brief-revision-accepted");
  const clarificationDecisions = decisions.filter((decision) => decision.kind === "clarification-answer");
  const durableClarification = verifyClarificationSession(Object.freeze({
    rounds: Object.freeze(clarificationDecisions.map(
      (decision, index) => validateClarificationDecisionMaterial(decision, index, digest),
    )),
  }), digest);
  assertDurableClarificationApplied(brief, provenance, durableClarification);
  const intakeDecisionDigest = sha256(
    digest,
    intakeDecisionBindingMaterial(clarificationDecisions),
    "binding",
  );
  if (
    aggregateVersion !== binding.expectedAggregateVersion + 1
    || brief.supersedes !== binding.expectedHeadBriefId
    || brief.briefId !== `brf:${bindingDigest.slice(0, 32)}`
    || operatorEvidence.candidateDigest !== binding.candidateDigest
    || operatorEvidence.evidenceId !== `intake-evidence:${bindingDigest.slice(0, 32)}`
    || operatorEvidence.acceptedAt !== brief.createdAt
    || decisions.some((decision) => decision.decidedAt !== brief.createdAt)
    || decisions.some((decision) => decision.supersedes !== null || decision.revision !== 1)
    || clarificationDecisions.length > 2
    || binding.intakeDecisionDigest !== intakeDecisionDigest
    || clarificationDecisions.some((decision, index) => decision.statement !== `Accepted clarification round ${String(index + 1)}.`)
    || decisions.some((decision, index) => index < clarificationDecisions.length
      ? decision.kind !== "clarification-answer"
      : decision.kind !== "brief-revision-accepted")
    || binding.expectedHeadBriefId === null && revisionDecisions.length !== 0
    || binding.expectedHeadBriefId !== null && revisionDecisions.length !== 1
    || revisionDecisions.some((decision) => decision.subjectDigest !== bindingDigest
      || decision.statement !== "Accepted a revision of the project brief."
      || decision.rationale !== canonical({
        previousBriefId: binding.expectedHeadBriefId,
        bindingDigest,
      }, "decision"))
  ) {
    refuseIntake("intake.input.invalid", "acceptance");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "project-brief-accepted",
    binding,
    aggregateVersion,
    brief,
    provenance,
    decisions,
    operatorEvidence,
  });
}

function committedOutcome(
  status: "committed" | "idempotent" | "recovered",
  event: IntakeAcceptanceEventPayload,
): AcceptanceOutcome {
  return Object.freeze({
    status,
    brief: event.brief,
    aggregateVersion: event.aggregateVersion,
    decisions: event.decisions,
  });
}

function parseStoreWriteAttempt(value: unknown, digest: IntakeDigestPort): StoreWriteAttempt {
  const input = intakeRecord(value, "store");
  const kind = input["kind"];
  if (kind === "committed") {
    exactIntakeKeys(input, ["kind", "event"], "store");
    return Object.freeze({ kind, event: parseIntakeAcceptanceEvent(input["event"], digest) });
  }
  if (kind === "conflict" || kind === "unknown" || kind === "refused") {
    exactIntakeKeys(input, ["kind"], "store");
    return Object.freeze({ kind });
  }
  return refuseIntake("intake.persistence.unknown", "store");
}

function parseStoreReconciliation(value: unknown, digest: IntakeDigestPort): StoreReconciliation {
  const input = intakeRecord(value, "store");
  const kind = input["kind"];
  if (kind === "committed") {
    exactIntakeKeys(input, ["kind", "event"], "store");
    return Object.freeze({ kind, event: parseIntakeAcceptanceEvent(input["event"], digest) });
  }
  if (kind === "not-recorded" || kind === "superseded" || kind === "limit" || kind === "unknown") {
    exactIntakeKeys(input, ["kind"], "store");
    return Object.freeze({ kind });
  }
  return refuseIntake("intake.persistence.unknown", "store");
}

function validatedCommittedEvent(
  event: IntakeAcceptanceEventPayload,
  prepared: PreparedAcceptance,
  allowStoreTimestamp: boolean,
): IntakeAcceptanceEventPayload {
  const same = allowStoreTimestamp
    ? acceptanceReplayMaterial(event) === acceptanceReplayMaterial(prepared.event)
    : canonical(event, "acceptance") === canonical(prepared.event, "acceptance");
  if (!same) refuseIntake("intake.persistence.unknown", "store");
  return event;
}

async function reconcile(
  store: IntakeAcceptanceStore,
  prepared: PreparedAcceptance,
  candidate: AcceptCandidateRequest["candidate"],
  successStatus: "idempotent" | "recovered",
  digest: IntakeDigestPort,
): Promise<AcceptanceOutcome> {
  let result: StoreReconciliation;
  try {
    result = parseStoreReconciliation(await store.reconcile(prepared), digest);
  } catch {
    return Object.freeze({ status: "outcome-unknown", candidate });
  }
  switch (result.kind) {
    case "committed": return committedOutcome(
      successStatus,
      validatedCommittedEvent(result.event, prepared, true),
    );
    case "not-recorded": return Object.freeze({ status: "not-recorded", candidate });
    case "limit": return Object.freeze({ status: "outcome-unknown", candidate });
    case "unknown": return Object.freeze({ status: "outcome-unknown", candidate });
    case "superseded": return refuseIntake("intake.brief.superseded", "binding");
    default: return refuseIntake("intake.persistence.unknown", "store");
  }
}

export async function acceptCandidate(
  request: AcceptCandidateRequest,
  ports: Readonly<{
    digest: IntakeDigestPort;
    clock: IntakeClock;
    store: IntakeAcceptanceStore;
  }>,
): Promise<AcceptanceOutcome> {
  const prepared = prepareCandidateAcceptance(request, ports);
  let result: StoreWriteAttempt;
  try {
    result = parseStoreWriteAttempt(await ports.store.attempt(prepared), ports.digest);
  } catch {
    result = Object.freeze({ kind: "unknown" });
  }
  switch (result.kind) {
    case "committed": return committedOutcome(
      "committed",
      validatedCommittedEvent(result.event, prepared, false),
    );
    case "conflict": return reconcile(ports.store, prepared, prepared.candidate, "idempotent", ports.digest);
    case "unknown": return reconcile(ports.store, prepared, prepared.candidate, "recovered", ports.digest);
    case "refused": return refuseIntake("intake.persistence.refused", "store");
    default: return refuseIntake("intake.persistence.unknown", "store");
  }
}

export function abandonCandidate(candidate: CandidateBrief): Readonly<{
  status: "abandoned";
  candidateDigest: string;
  durableWrites: 0;
}> {
  const input = intakeRecord(candidate, "candidate");
  return Object.freeze({
    status: "abandoned",
    candidateDigest: validateDigest(input["candidateDigest"], "candidate"),
    durableWrites: 0,
  });
}
