import type { Clock, PersistenceAdapter } from "@ai-dev-os/persistence";
import type { ClarificationQuestion, Constraint } from "@ai-dev-os/project";
import {
  assembleCandidate,
  intakeSha256,
  type CandidateBrief,
  type CandidateDraftInput,
  type IntakeDigestPort,
  type IntakeProvenance,
  type IntakeProvenanceSource,
  type IntakeTextField,
  type ProposedIntakeQuestion,
} from "../src/index.js";

export const FIXED_ISO = "2026-08-30T12:34:56.000Z";

export const fixedClock: Clock = Object.freeze({
  now: (): Date => new Date(FIXED_ISO),
});

export function provenance(
  source: IntakeProvenanceSource = "operator-supplied",
  acceptedByOperator = source === "operator-supplied",
): IntakeProvenance {
  return Object.freeze({ source, acceptedByOperator });
}

export function field(
  value: string,
  source: IntakeProvenanceSource = "operator-supplied",
  acceptedByOperator = source === "operator-supplied",
): IntakeTextField {
  return Object.freeze({ value, provenance: provenance(source, acceptedByOperator) });
}

export function constraint(overrides: Partial<Constraint> = {}): Constraint {
  return Object.freeze({
    constraintId: "constraint:node",
    kind: "technology-required",
    statement: "Use Node.js 22 or later.",
    enforcement: "hard",
    machineForm: Object.freeze({ runtime: "node", minimumMajor: 22 }),
    origin: "operator",
    authority: "operator",
    ...overrides,
  });
}

export function question(
  id: string,
  overrides: Partial<ClarificationQuestion> = {},
): ProposedIntakeQuestion {
  const value: ClarificationQuestion = Object.freeze({
    questionId: id,
    theme: "scope",
    question: `Which outcome applies to ${id}?`,
    whyItMatters: "The expected outcome must be explicit.",
    options: Object.freeze(["Library", "Application"]),
    proposedDefault: "Library",
    consequenceIfDefaulted: "The brief will describe a reusable library.",
    blocking: false,
    ...overrides,
  });
  return Object.freeze({
    question: value,
    blockingBasis: value.blocking ? "required-outcome" : null,
    provenance: provenance("model-proposed", false),
    source: "derived",
  });
}

export function draft(overrides: Partial<CandidateDraftInput> = {}): CandidateDraftInput {
  return {
    projectId: "prj:intake-test",
    objective: field("Build a deterministic project intake library."),
    outcomes: Object.freeze([field("Produce a validated candidate brief.")]),
    nonGoals: Object.freeze([field("Do not execute project tasks.")]),
    audiences: Object.freeze([field("Local development operators.")]),
    constraints: Object.freeze([Object.freeze({
      value: constraint(),
      provenance: provenance(),
      possible: true,
    })]),
    assumptions: Object.freeze([]),
    openQuestions: Object.freeze([]),
    sourceThreadId: "thr:intake-test",
    ...overrides,
  };
}

export function candidate(
  overrides: Partial<CandidateDraftInput> = {},
  digest: IntakeDigestPort = intakeSha256,
): CandidateBrief {
  return assembleCandidate(draft(overrides), digest);
}

export async function countBriefRecords(adapter: PersistenceAdapter): Promise<Readonly<{ aggregates: number; events: number }>> {
  return adapter.transact(async (tx) => {
    const aggregates = await tx.aggregates.list({ aggregateType: "project-brief", limit: 100 });
    const events = await tx.events.list({ aggregateType: "project-brief", limit: 1000 });
    return Object.freeze({ aggregates: aggregates.items.length, events: events.items.length });
  });
}
