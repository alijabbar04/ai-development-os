import { assertContentDerivedIdentity } from "@ai-dev-os/project";
import { describe, expect, it } from "vitest";
import {
  INTAKE_BLOCKING_BASES,
  INTAKE_CLARIFICATION_POLICY,
  applyClarificationsToCandidate,
  createClarificationSession,
  intakeSha256,
  openClarificationRound,
  prepareCandidateAcceptance,
  resolveClarificationRound,
  restartClarification,
  unresolvedBlockingQuestions,
  verifyClarificationSession,
} from "../src/index.js";
import {
  clarificationQuestionSetDigest,
  clarificationRoundDecisionMaterial,
} from "../src/clarification.js";
import { candidate, field, fixedClock, provenance, question } from "./fixtures.js";

describe("bounded clarification", () => {
  it("publishes the exact accepted one/two/eight/three policy and closed blocking bases", () => {
    expect(INTAKE_CLARIFICATION_POLICY).toEqual({
      defaultRounds: 1,
      maximumRounds: 2,
      maximumQuestionsPerRound: 8,
      maximumBlockingQuestionsPerRound: 3,
      secondRoundRequiresMaterialChangeReason: true,
      preAcceptancePersistence: false,
    });
    expect(INTAKE_BLOCKING_BASES).toEqual([
      "required-outcome",
      "hard-constraint-machine-form",
      "data-permission-ceiling",
      "budget-ceiling",
      "repository-branch-ambiguity",
    ]);
  });

  it("enforces the eight-question and three-blocking ceilings", () => {
    expect(() => openClarificationRound({
      session: createClarificationSession(),
      questions: Object.freeze(Array.from({ length: 9 }, (_, index) => question(`q:${String(index)}`))),
      knownFacts: Object.freeze([]),
      materialChangeReason: null,
    }, intakeSha256)).toThrowError(expect.objectContaining({ code: "intake.round.too-many-questions" }));

    const blocking = Array.from({ length: 4 }, (_, index) => question(`q:b${String(index)}`, {
      blocking: true,
      question: `Required outcome ${String(index)}?`,
    }));
    expect(() => openClarificationRound({
      session: createClarificationSession(),
      questions: Object.freeze(blocking),
      knownFacts: Object.freeze([]),
      materialChangeReason: null,
    }, intakeSha256)).toThrowError(expect.objectContaining({ code: "intake.round.too-many-blocking" }));
  });

  it("allows two rounds, requires a material-change reason for round two, and refuses round three", () => {
    const first = openClarificationRound({
      session: createClarificationSession(),
      questions: Object.freeze([question("q:one")]),
      knownFacts: Object.freeze([]),
      materialChangeReason: null,
    }, intakeSha256);
    expect(() => openClarificationRound({
      session: first,
      questions: Object.freeze([question("q:two")]),
      knownFacts: Object.freeze([]),
      materialChangeReason: null,
    }, intakeSha256)).toThrowError(expect.objectContaining({ code: "intake.round.material-change-required" }));
    const second = openClarificationRound({
      session: first,
      questions: Object.freeze([question("q:two")]),
      knownFacts: Object.freeze([]),
      materialChangeReason: "The first answer introduced a second delivery target.",
    }, intakeSha256);
    expect(second.rounds.map((round) => round.ordinal)).toEqual([1, 2]);
    expect(() => openClarificationRound({
      session: second,
      questions: Object.freeze([question("q:three")]),
      knownFacts: Object.freeze([]),
      materialChangeReason: "Another change.",
    }, intakeSha256)).toThrowError(expect.objectContaining({ code: "intake.round.ceiling" }));
  });

  it.each([
    "constraint",
    "confirmed-assumption",
    "prior-decision",
    "preference",
    "inspection-fact",
  ] as const)("deduplicates semantic questions against %s facts and logs the drop", (source) => {
    const proposed = question(`q:${source}`, { question: "Which runtime should be used?" });
    const session = openClarificationRound({
      session: createClarificationSession(),
      questions: Object.freeze([proposed]),
      knownFacts: Object.freeze([{ source, text: "which runtime should be used" }]),
      materialChangeReason: null,
    }, intakeSha256);
    expect(session.rounds[0]?.questions).toEqual([]);
    expect(session.rounds[0]?.droppedDuplicates).toEqual([
      expect.objectContaining({ questionId: `q:${source}`, matchedSource: source }),
    ]);
  });

  it("deduplicates within and across rounds deterministically", () => {
    const first = openClarificationRound({
      session: createClarificationSession(),
      questions: Object.freeze([
        question("q:first", { question: "Which audience applies?" }),
        question("q:duplicate", { question: "which audience applies" }),
      ]),
      knownFacts: Object.freeze([]),
      materialChangeReason: null,
    }, intakeSha256);
    expect(first.rounds[0]?.questions.map((item) => item.question.questionId)).toEqual(["q:first"]);
    expect(first.rounds[0]?.droppedDuplicates).toHaveLength(1);
    const second = openClarificationRound({
      session: first,
      questions: Object.freeze([
        question("q:again", { question: "WHICH AUDIENCE APPLIES?" }),
        question("q:new", { question: "Which quality bar applies?" }),
      ]),
      knownFacts: Object.freeze([]),
      materialChangeReason: "The delivery context changed.",
    }, intakeSha256);
    expect(second.rounds[1]?.questions.map((item) => item.question.questionId)).toEqual(["q:new"]);
  });

  it("refuses a self-consistent forged session with a semantic duplicate across rounds", () => {
    const first = openClarificationRound({
      session: createClarificationSession(),
      questions: [question("q:original", { question: "Which audience applies?" })],
      knownFacts: [],
      materialChangeReason: null,
    }, intakeSha256);
    const duplicate = question("q:forged-duplicate", { question: " which audience applies " });
    const materialChangeReason = "The delivery context changed.";
    const forged = Object.freeze({
      rounds: Object.freeze([
        first.rounds[0]!,
        Object.freeze({
          ordinal: 2 as const,
          materialChangeReason,
          questionSetDigest: clarificationQuestionSetDigest(
            2,
            materialChangeReason,
            [duplicate],
            intakeSha256,
          ),
          questions: Object.freeze([duplicate]),
          resolutions: Object.freeze([]),
          droppedDuplicates: Object.freeze([]),
        }),
      ]),
    });
    expect(() => verifyClarificationSession(forged, intakeSha256)).toThrowError(
      expect.objectContaining({ code: "intake.input.invalid", root: "question" }),
    );
  });

  it("requires blocking defaults to be explicitly confirmed", () => {
    const blocking = question("q:blocking", { blocking: true, question: "Which required outcome applies?" });
    const session = openClarificationRound({
      session: createClarificationSession(),
      questions: Object.freeze([blocking]),
      knownFacts: Object.freeze([]),
      materialChangeReason: null,
    }, intakeSha256);
    expect(() => resolveClarificationRound(session, 1, [{
      questionId: "q:blocking",
      kind: "defaulted",
      value: "Library",
    }], intakeSha256)).toThrowError(expect.objectContaining({ code: "intake.blocking.unanswered" }));
    const resolved = resolveClarificationRound(session, 1, [{
      questionId: "q:blocking",
      kind: "default-confirmed",
      value: "Library",
    }], intakeSha256);
    expect(unresolvedBlockingQuestions(resolved)).toEqual([]);
  });

  it("turns skipped non-blocking defaults into unconfirmed assumptions", () => {
    const optional = question("q:optional", { question: "Which delivery format applies?" });
    const initial = candidate({ openQuestions: Object.freeze([optional]) });
    const session = openClarificationRound({
      session: createClarificationSession(),
      questions: Object.freeze([optional]),
      knownFacts: Object.freeze([]),
      materialChangeReason: null,
    }, intakeSha256);
    const resolved = resolveClarificationRound(session, 1, [{
      questionId: "q:optional",
      kind: "defaulted",
      value: "Library",
    }], intakeSha256);
    const updated = applyClarificationsToCandidate(initial, resolved, intakeSha256);
    expect(updated.openQuestions).toEqual([]);
    expect(updated.assumptions).toEqual([
      expect.objectContaining({ confirmed: false, source: "model", provenance: { source: "proposed-default", acceptedByOperator: false } }),
    ]);
    expect(updated.assumptions[0]?.text).toContain(optional.question.consequenceIfDefaulted);
  });

  it("validates option answers and default values exactly", () => {
    const session = openClarificationRound({
      session: createClarificationSession(),
      questions: Object.freeze([question("q:option")]),
      knownFacts: Object.freeze([]),
      materialChangeReason: null,
    }, intakeSha256);
    expect(() => resolveClarificationRound(session, 1, [{ questionId: "q:option", kind: "answered", value: "Other" }], intakeSha256))
      .toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(() => resolveClarificationRound(session, 1, [{ questionId: "q:option", kind: "defaulted", value: "Application" }], intakeSha256))
      .toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
  });

  it("resets only ephemeral pre-acceptance round accounting", () => {
    const session = openClarificationRound({
      session: createClarificationSession(),
      questions: Object.freeze([question("q:one")]),
      knownFacts: Object.freeze([]),
      materialChangeReason: null,
    }, intakeSha256);
    expect(restartClarification(session)).toEqual({ rounds: [] });
  });

  it("recomputes and verifies question-set digests", () => {
    const session = openClarificationRound({
      session: createClarificationSession(),
      questions: Object.freeze([question("q:one")]),
      knownFacts: Object.freeze([]),
      materialChangeReason: null,
    }, intakeSha256);
    expect(verifyClarificationSession(session, intakeSha256)).toEqual(session);
    const forged = { rounds: [{ ...session.rounds[0], questionSetDigest: "0".repeat(64) }] } as never;
    expect(() => verifyClarificationSession(forged, intakeSha256)).toThrowError(
      expect.objectContaining({ code: "intake.digest.mismatch" }),
    );
    expect(() => openClarificationRound({
      session: forged,
      questions: [question("q:second")],
      knownFacts: [],
      materialChangeReason: "A material delivery constraint changed.",
    }, intakeSha256)).toThrowError(expect.objectContaining({ code: "intake.digest.mismatch" }));
    expect(() => resolveClarificationRound(forged, 1, [], intakeSha256)).toThrowError(
      expect.objectContaining({ code: "intake.digest.mismatch" }),
    );
  });

  it("leaves one content-derived clarification Decision for every accepted round", () => {
    const proposed = question("q:answer", { question: "Which outcome applies?" });
    const initial = candidate({ openQuestions: Object.freeze([proposed]) });
    const session = resolveClarificationRound(openClarificationRound({
      session: createClarificationSession(),
      questions: Object.freeze([proposed]),
      knownFacts: Object.freeze([]),
      materialChangeReason: null,
    }, intakeSha256), 1, [{ questionId: "q:answer", kind: "answered", value: "Library" }], intakeSha256);
    const updated = applyClarificationsToCandidate(initial, session, intakeSha256);
    const prepared = prepareCandidateAcceptance({
      candidate: updated,
      presentedDigest: updated.candidateDigest,
      expectedHead: null,
      expectedAggregateVersion: 0,
      clarification: session,
      operatorConfirmed: true,
    }, { digest: intakeSha256, clock: fixedClock });
    const decision = prepared.event.decisions.find((item) => item.kind === "clarification-answer");
    expect(decision).toBeDefined();
    expect(decision?.subjectDigest).toBe(session.rounds[0]?.questionSetDigest);
    expect(decision?.rationale).toBe(clarificationRoundDecisionMaterial(session.rounds[0]!));
    const fullDigest = intakeSha256.sha256(JSON.stringify({}));
    expect(() => assertContentDerivedIdentity({ kind: "decision", record: decision! }, fullDigest)).toThrow();
    expect(decision?.decisionId).toMatch(/^dec:[a-f0-9]{32}$/u);
    expect(prepared.brief.assumptions).toContainEqual(expect.objectContaining({
      text: "Which outcome applies? Answer: Library",
      source: "operator",
      confirmed: true,
    }));
  });

  it("binds distinct clarification sets even when they produce identical final candidate bytes", () => {
    const prepare = (whyItMatters: string) => {
      const proposed = question("q:binding", {
        question: "Which outcome applies?",
        whyItMatters,
      });
      const initial = candidate({ openQuestions: [proposed] });
      const session = resolveClarificationRound(openClarificationRound({
        session: createClarificationSession(),
        questions: [proposed],
        knownFacts: [],
        materialChangeReason: null,
      }, intakeSha256), 1, [{ questionId: "q:binding", kind: "answered", value: "Library" }], intakeSha256);
      const updated = applyClarificationsToCandidate(initial, session, intakeSha256);
      return {
        updated,
        prepared: prepareCandidateAcceptance({
          candidate: updated,
          presentedDigest: updated.candidateDigest,
          expectedHead: null,
          expectedAggregateVersion: 0,
          clarification: session,
          operatorConfirmed: true,
        }, { digest: intakeSha256, clock: fixedClock }),
      };
    };
    const first = prepare("It identifies the requested deliverable.");
    const second = prepare("It changes the audit meaning without changing the resulting assumption.");
    expect(first.updated.candidateDigest).toBe(second.updated.candidateDigest);
    expect(first.prepared.binding.intakeDecisionDigest).not.toBe(second.prepared.binding.intakeDecisionDigest);
    expect(first.prepared.eventId).not.toBe(second.prepared.eventId);
    expect(first.prepared.brief.briefId).not.toBe(second.prepared.brief.briefId);
  });

  it("refuses acceptance when resolved clarification material was not applied to the candidate", () => {
    const proposed = question("q:unapplied");
    const session = resolveClarificationRound(openClarificationRound({
      session: createClarificationSession(), questions: [proposed], knownFacts: [], materialChangeReason: null,
    }, intakeSha256), 1, [{ questionId: "q:unapplied", kind: "answered", value: "Library" }], intakeSha256);
    const value = candidate();
    expect(() => prepareCandidateAcceptance({
      candidate: value,
      presentedDigest: value.candidateDigest,
      expectedHead: null,
      expectedAggregateVersion: 0,
      clarification: session,
      operatorConfirmed: true,
    }, { digest: intakeSha256, clock: fixedClock })).toThrowError(
      expect.objectContaining({ code: "intake.input.invalid", root: "clarification" }),
    );
  });

  it("keeps unresolved non-blocking questions open without silently taking defaults", () => {
    const optional = question("q:open");
    const initial = candidate({
      openQuestions: Object.freeze([optional]),
      outcomes: Object.freeze([field("Outcome")]),
    });
    const session = openClarificationRound({
      session: createClarificationSession(),
      questions: Object.freeze([optional]),
      knownFacts: Object.freeze([]),
      materialChangeReason: null,
    }, intakeSha256);
    const updated = applyClarificationsToCandidate(initial, session, intakeSha256);
    expect(updated.openQuestions).toHaveLength(1);
    expect(updated.assumptions).toEqual([]);
    expect(updated.ready).toBe(true);
  });

  it("refuses a blocking question whose basis is outside the fixed list", () => {
    const invalid = {
      ...question("q:block", { blocking: true }),
      blockingBasis: "model-uncertainty",
      provenance: provenance("model-proposed", false),
    } as never;
    expect(() => openClarificationRound({
      session: createClarificationSession(),
      questions: Object.freeze([invalid]),
      knownFacts: Object.freeze([]),
      materialChangeReason: null,
    }, intakeSha256)).toThrowError(expect.objectContaining({ code: "intake.question.blocking-basis" }));
  });
});
