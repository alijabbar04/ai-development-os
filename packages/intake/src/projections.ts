import {
  assertAcyclicSupersession,
  assertNewBrief,
  serializeCanonicalProjectJson,
  type Decision,
  type ProjectBrief,
} from "@ai-dev-os/project";
import { parseIntakeAcceptanceEvent } from "./acceptance.js";
import {
  INTAKE_AVAILABLE_COMMANDS,
  INTAKE_AUTHORITY,
  INTAKE_QUESTION_SOURCES,
  INTAKE_VIEW_STATES,
  type ClarificationSession,
  type IntakeAcceptanceEventPayload,
  type IntakeAudience,
  type IntakeStateProjectionInput,
} from "./contracts.js";
import { verifyClarificationSession } from "./clarification.js";
import { intakeSha256 } from "./digest.js";
import { refuseIntake } from "./errors.js";
import {
  containsAbsoluteLocalPath,
  containsIntakeDisallowedFormatting,
  containsIntakeSecretShape,
  containsProtectedIdentifierShape,
  exactIntakeKeys,
  intakeArray,
  intakeRecord,
  mapProjectRefusal,
  validateDigest,
  validateIntakeText,
  validateSafeInteger,
} from "./text.js";

function scanStrings(
  value: unknown,
  findings: string[],
  seen: WeakSet<object>,
  depth: number,
  budget: { count: number },
): void {
  budget.count += 1;
  if (depth > 64 || budget.count > 100_000) {
    findings.push("invalid-structure");
    return;
  }
  if (typeof value === "string") {
    if (containsIntakeSecretShape(value)) findings.push("secret-shaped");
    if (containsAbsoluteLocalPath(value)) findings.push("absolute-local-path");
    if (containsProtectedIdentifierShape(value)) findings.push("protected-identifier-shaped");
    if (containsIntakeDisallowedFormatting(value)) findings.push("disallowed-formatting");
    return;
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) {
      findings.push("invalid-structure");
      return;
    }
    seen.add(value);
    try {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) {
        findings.push("invalid-structure");
      }
      if (Object.getOwnPropertySymbols(value).length !== 0) findings.push("invalid-structure");
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key === "length" && Array.isArray(value)) continue;
        scanStrings(key, findings, seen, depth + 1, budget);
        if (!("value" in descriptor) || descriptor.enumerable !== true) {
          findings.push("invalid-structure");
          continue;
        }
        scanStrings(descriptor.value, findings, seen, depth + 1, budget);
      }
    } catch {
      findings.push("invalid-structure");
    }
  }
}

export function normalProjectionLeakage(value: unknown): readonly string[] {
  const findings: string[] = [];
  scanStrings(value, findings, new WeakSet<object>(), 0, { count: 0 });
  return Object.freeze([...new Set(findings)]);
}

function assertNormalSafe(value: unknown): void {
  if (normalProjectionLeakage(value).length !== 0) refuseIntake("intake.input.invalid", "projection");
}

function normalQuestion(question: ProjectBrief["openQuestions"][number]) {
  return Object.freeze({
    theme: question.theme,
    question: question.question,
    whyItMatters: question.whyItMatters,
    options: question.options,
    proposedDefault: question.proposedDefault,
    consequenceIfDefaulted: question.consequenceIfDefaulted,
    blocking: question.blocking,
  });
}

function normalBrief(event: IntakeAcceptanceEventPayload) {
  const value = Object.freeze({
    presentation: "project-brief" as const,
    state: "accepted" as const,
    version: event.aggregateVersion,
    acceptedAt: event.brief.createdAt,
    objective: event.brief.objective,
    outcomes: event.brief.outcomes,
    nonGoals: event.brief.nonGoals,
    audiences: event.brief.audiences,
    constraints: Object.freeze(event.brief.constraints.map((constraint) => Object.freeze({
      kind: constraint.kind,
      statement: constraint.statement,
      enforcement: constraint.enforcement,
      source: constraint.origin === "operator" ? "From you"
        : constraint.origin === "repository" ? "Read from the repository"
          : "Suggested",
    }))),
    assumptions: Object.freeze(event.brief.assumptions.map((assumption) => Object.freeze({
      text: assumption.text,
      source: assumption.source === "operator" ? "From you"
        : assumption.source === "repository" ? "Read from the repository"
          : "Suggested",
      confirmed: assumption.confirmed,
    }))),
    openQuestions: Object.freeze(event.brief.openQuestions.map(normalQuestion)),
    actions: Object.freeze(["view-brief", "revise-brief"] as const),
    authority: INTAKE_AUTHORITY,
    commands: INTAKE_AVAILABLE_COMMANDS,
    productionEnabled: false as const,
  });
  assertNormalSafe(value);
  return value;
}

function developerDecision(decision: Decision) {
  return Object.freeze({
    decisionId: decision.decisionId,
    kind: decision.kind,
    statement: decision.statement,
    rationale: decision.rationale,
    subjectDigest: decision.subjectDigest,
    decidedAt: decision.decidedAt,
  });
}

export function projectBriefView(
  eventValue: IntakeAcceptanceEventPayload,
  audience: IntakeAudience,
) {
  if (audience !== "normal" && audience !== "developer") refuseIntake("intake.input.invalid", "projection");
  const event = parseIntakeAcceptanceEvent(eventValue, intakeSha256);
  const normal = normalBrief(event);
  if (audience === "normal") return normal;
  return Object.freeze({
    ...normal,
    developer: Object.freeze({
      aggregateVersion: event.aggregateVersion,
      briefId: event.brief.briefId,
      projectId: event.brief.projectId,
      supersedes: event.brief.supersedes,
      sourceThreadId: event.brief.sourceThreadId,
      candidateDigest: event.binding.candidateDigest,
      expectedHeadBriefId: event.binding.expectedHeadBriefId,
      expectedAggregateVersion: event.binding.expectedAggregateVersion,
      provenance: event.provenance,
      constraints: Object.freeze(event.brief.constraints.map((constraint) => Object.freeze({
        constraintId: constraint.constraintId,
        machineForm: constraint.machineForm,
        origin: constraint.origin,
        authority: constraint.authority,
      }))),
      questions: Object.freeze(event.brief.openQuestions.map((question) => Object.freeze({
        questionId: question.questionId,
      }))),
      decisions: Object.freeze(event.decisions.map(developerDecision)),
      operatorEvidenceId: event.operatorEvidence.evidenceId,
    }),
  });
}

const STATE_COPY = Object.freeze({
  empty: Object.freeze({
    title: "New project",
    explanation: "Describe what you want built, in your own words.",
    actions: Object.freeze(["describe-project"] as const),
    disabled: Object.freeze([Object.freeze({ action: "accept-brief", reason: "Nothing to accept yet." })]),
  }),
  loading: Object.freeze({
    title: "Reading the repository",
    explanation: "Reading the folder you chose. Nothing is changed or sent anywhere.",
    actions: Object.freeze(["cancel-inspection"] as const),
    disabled: Object.freeze([Object.freeze({ action: "accept-brief", reason: "Inspection is in progress." })]),
  }),
  partial: Object.freeze({
    title: "Repository partly read",
    explanation: "Some repository facts are unavailable and remain marked unknown.",
    actions: Object.freeze(["continue", "retry-inspection"] as const),
    disabled: Object.freeze([]),
  }),
  unavailable: Object.freeze({
    title: "Repository not readable",
    explanation: "The selected repository cannot be read. The brief can continue without it.",
    actions: Object.freeze(["continue-without-repository", "choose-repository"] as const),
    disabled: Object.freeze([]),
  }),
  blocked: Object.freeze({
    title: "Needs your decisions",
    explanation: "A blocking question needs an answer before this brief can be accepted.",
    actions: Object.freeze(["answer-questions"] as const),
    disabled: Object.freeze([Object.freeze({ action: "accept-brief", reason: "A required answer is missing." })]),
  }),
  ready: Object.freeze({
    title: "Ready to review",
    explanation: "This is what was understood. Nothing is accepted yet.",
    actions: Object.freeze(["accept-brief", "revise-candidate", "abandon"] as const),
    disabled: Object.freeze([]),
  }),
  conflict: Object.freeze({
    title: "Changed since review",
    explanation: "The brief moved on while it was being revised. Review the current version.",
    actions: Object.freeze(["review-current-brief"] as const),
    disabled: Object.freeze([Object.freeze({ action: "accept-brief", reason: "Review the current version first." })]),
  }),
});

export function intakeStateView(input: IntakeStateProjectionInput, audience: IntakeAudience) {
  if (audience !== "normal" && audience !== "developer") refuseIntake("intake.input.invalid", "projection");
  const parsed = intakeRecord(input, "projection");
  exactIntakeKeys(parsed, [
    "state", "questionCount", "blockingCount", "candidateDigest", "diagnosticRule", "canonicalRoot",
  ], "projection");
  const state = parsed["state"];
  if (typeof state !== "string" || !(INTAKE_VIEW_STATES as readonly string[]).includes(state)) {
    refuseIntake("intake.input.invalid", "projection");
  }
  const questionCount = validateSafeInteger(parsed["questionCount"], "projection", 0, 1_024);
  const blockingCount = validateSafeInteger(parsed["blockingCount"], "projection", 0, questionCount);
  if ((state === "blocked") !== (blockingCount > 0)) {
    refuseIntake("intake.input.invalid", "projection");
  }
  const copy = STATE_COPY[state as keyof typeof STATE_COPY];
  const normal = Object.freeze({
    presentation: "project-intake" as const,
    state: state as keyof typeof STATE_COPY,
    title: copy.title,
    explanation: copy.explanation,
    questionCount,
    blockingCount,
    actions: copy.actions,
    disabledActions: copy.disabled,
    authority: INTAKE_AUTHORITY,
    commands: INTAKE_AVAILABLE_COMMANDS,
    productionEnabled: false as const,
  });
  assertNormalSafe(normal);
  if (audience === "normal") return normal;
  const candidateDigest = parsed["candidateDigest"] === null ? null : validateDigest(parsed["candidateDigest"], "projection");
  const diagnosticRule = parsed["diagnosticRule"] === null ? null : validateIntakeText(parsed["diagnosticRule"], "projection", {
    maximum: 128,
    allowNewlines: false,
  });
  if (diagnosticRule !== null && !/^[a-z][a-z0-9._-]{0,127}$/u.test(diagnosticRule)) {
    refuseIntake("intake.input.invalid", "projection");
  }
  const canonicalRoot = parsed["canonicalRoot"] === null ? null : validateIntakeText(parsed["canonicalRoot"], "projection", {
    maximum: 32_767,
    allowNewlines: false,
  });
  return Object.freeze({
    ...normal,
    developer: Object.freeze({ candidateDigest, diagnosticRule, canonicalRoot }),
  });
}

export function clarificationView(sessionValue: ClarificationSession, audience: IntakeAudience) {
  if (audience !== "normal" && audience !== "developer") refuseIntake("intake.input.invalid", "projection");
  const session = verifyClarificationSession(sessionValue, intakeSha256);
  const normal = Object.freeze({
    presentation: "project-clarification" as const,
    rounds: Object.freeze(session.rounds.map((round) => Object.freeze({
      ordinal: round.ordinal,
      questionCount: round.questions.length,
      blockingCount: round.questions.filter((question) => question.question.blocking).length,
      resolvedCount: round.resolutions.length,
      questions: Object.freeze(round.questions.map((question) => normalQuestion(question.question))),
    }))),
    actions: Object.freeze(["answer-question", "use-defaults"] as const),
    authority: INTAKE_AUTHORITY,
    commands: INTAKE_AVAILABLE_COMMANDS,
    productionEnabled: false as const,
  });
  assertNormalSafe(normal);
  if (audience === "normal") return normal;
  const developerRounds = session.rounds.map((round) => Object.freeze({
    ordinal: round.ordinal,
    questionSetDigest: validateDigest(round.questionSetDigest, "projection"),
    materialChangeReason: round.materialChangeReason,
    questions: Object.freeze(round.questions.map((question) => Object.freeze({
      questionId: question.question.questionId,
      blockingBasis: question.blockingBasis,
      source: question.source,
      provenance: question.provenance,
    }))),
    resolutions: round.resolutions,
    droppedDuplicates: Object.freeze(round.droppedDuplicates.map((drop) => {
      if (!(INTAKE_QUESTION_SOURCES as readonly string[]).includes(drop.matchedSource)) {
        refuseIntake("intake.input.invalid", "projection");
      }
      return Object.freeze({
        questionId: validateIntakeText(drop.questionId, "projection", { maximum: 128, allowNewlines: false }),
        matchedSource: drop.matchedSource,
        semanticKey: validateIntakeText(drop.semanticKey, "projection", { maximum: 4_096, allowNewlines: false }),
      });
    })),
  }));
  return Object.freeze({ ...normal, developer: Object.freeze({ rounds: Object.freeze(developerRounds) }) });
}

export function projectBriefHistoryView(
  eventValues: readonly IntakeAcceptanceEventPayload[],
  audience: IntakeAudience,
) {
  if (audience !== "normal" && audience !== "developer") refuseIntake("intake.input.invalid", "projection");
  const events = Object.freeze([...intakeArray(
    eventValues,
    "projection",
    (event) => parseIntakeAcceptanceEvent(event, intakeSha256),
  )]
    .sort((left, right) => left.aggregateVersion - right.aggregateVersion));
  if (events.some((event, index) => event.aggregateVersion !== index + 1)) {
    refuseIntake("intake.version.invalid", "projection");
  }
  const briefs = events.map((event) => event.brief);
  try {
    assertAcyclicSupersession({ kind: "brief", records: briefs });
    for (let index = 1; index < briefs.length; index += 1) {
      assertNewBrief(briefs[index - 1] as ProjectBrief, briefs[index] as ProjectBrief);
    }
  } catch (error) {
    return mapProjectRefusal(error, "projection");
  }
  const normal = Object.freeze({
    presentation: "project-brief-history" as const,
    versions: Object.freeze(events.map((event, index) => Object.freeze({
      version: event.aggregateVersion,
      acceptedAt: event.brief.createdAt,
      status: index === events.length - 1 ? "current" as const : "superseded" as const,
    }))),
    actions: Object.freeze(["view-brief-version"] as const),
    authority: INTAKE_AUTHORITY,
    commands: INTAKE_AVAILABLE_COMMANDS,
    productionEnabled: false as const,
  });
  assertNormalSafe(normal);
  if (audience === "normal") return normal;
  return Object.freeze({
    ...normal,
    developer: Object.freeze({
      versions: Object.freeze(events.map((event) => Object.freeze({
        aggregateVersion: event.aggregateVersion,
        briefId: event.brief.briefId,
        supersedes: event.brief.supersedes,
        candidateDigest: event.binding.candidateDigest,
        decisionIds: Object.freeze(event.decisions.map((decision) => decision.decisionId)),
      }))),
    }),
  });
}

export function serializeIntakeProjection(value: unknown): string {
  try {
    return serializeCanonicalProjectJson(value);
  } catch (error) {
    return mapProjectRefusal(error, "projection");
  }
}
