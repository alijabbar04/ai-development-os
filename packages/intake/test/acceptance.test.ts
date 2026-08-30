import type { PersistenceAdapter, TransactionContext } from "@ai-dev-os/persistence";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import { createSqlitePersistenceAdapter } from "@ai-dev-os/persistence-sqlite";
import {
  assertContentDerivedIdentity,
  parseProjectBrief,
  serializeCanonicalProjectJson,
} from "@ai-dev-os/project";
import { describe, expect, it, vi } from "vitest";
import {
  abandonCandidate,
  acceptCandidate,
  applyClarificationsToCandidate,
  createC7IntakeStore,
  createClarificationSession,
  decisionIdentityMaterial,
  intakeSha256,
  openClarificationRound,
  parseIntakeAcceptanceEvent,
  prepareCandidateAcceptance,
  resolveClarificationRound,
  type AcceptCandidateRequest,
  type CandidateBrief,
  type IntakeAcceptanceEventPayload,
  type IntakeAcceptanceStore,
  type PreparedAcceptance,
} from "../src/index.js";
import { candidate, countBriefRecords, field, fixedClock, FIXED_ISO, provenance, question } from "./fixtures.js";

function request(
  value: CandidateBrief,
  overrides: Partial<AcceptCandidateRequest> = {},
): AcceptCandidateRequest {
  return {
    candidate: value,
    presentedDigest: value.candidateDigest,
    expectedHead: null,
    expectedAggregateVersion: 0,
    clarification: createClarificationSession(),
    operatorConfirmed: true,
    ...overrides,
  };
}

function forgedBlockedPrepared(): PreparedAcceptance {
  const blocked = candidate({
    openQuestions: [question("q:blocked-bridge", {
      blocking: true,
      question: "Which required outcome applies?",
    })],
  });
  const binding = Object.freeze({
    candidateDigest: blocked.candidateDigest,
    expectedHeadBriefId: null,
    expectedAggregateVersion: 0,
    intakeDecisionDigest: intakeSha256.sha256(serializeCanonicalProjectJson([])),
  });
  const bindingDigest = intakeSha256.sha256(serializeCanonicalProjectJson(binding));
  const projectDigest = intakeSha256.sha256(serializeCanonicalProjectJson({
    aggregateType: "project-brief",
    projectId: blocked.projectId,
  }));
  const brief = parseProjectBrief({
    schemaVersion: 1,
    briefId: `brf:${bindingDigest.slice(0, 32)}`,
    projectId: blocked.projectId,
    revision: 1,
    supersedes: null,
    origin: "operator",
    objective: blocked.objective.value,
    outcomes: blocked.outcomes.map((item) => item.value),
    nonGoals: blocked.nonGoals.map((item) => item.value),
    audiences: blocked.audiences.map((item) => item.value),
    constraints: blocked.constraints.map((item) => item.value),
    assumptions: blocked.assumptions.map(({ text, source, confirmed }) => ({ text, source, confirmed })),
    openQuestions: blocked.openQuestions.map((item) => item.question),
    sourceThreadId: blocked.sourceThreadId,
    createdAt: FIXED_ISO,
  });
  const provenance = Object.freeze({
    objective: blocked.objective.provenance,
    outcomes: blocked.outcomes.map((item) => item.provenance),
    nonGoals: blocked.nonGoals.map((item) => item.provenance),
    audiences: blocked.audiences.map((item) => item.provenance),
    constraints: blocked.constraints.map((item) => item.provenance),
    assumptions: blocked.assumptions.map((item) => item.provenance),
    openQuestions: blocked.openQuestions.map((item) => item.provenance),
  });
  const event: IntakeAcceptanceEventPayload = Object.freeze({
    schemaVersion: 1,
    kind: "project-brief-accepted",
    binding,
    aggregateVersion: 1,
    brief,
    provenance,
    decisions: [],
    operatorEvidence: {
      schemaVersion: 1,
      evidenceId: `intake-evidence:${bindingDigest.slice(0, 32)}`,
      kind: "explicit-operator-acceptance",
      candidateDigest: blocked.candidateDigest,
      acceptedAt: FIXED_ISO,
      authority: "brief-only",
    },
  });
  return Object.freeze({
    candidate: blocked,
    aggregateId: `project-brief:${projectDigest.slice(0, 32)}`,
    eventId: `intake:${bindingDigest.slice(0, 32)}`,
    bindingDigest,
    binding,
    aggregateVersion: 1,
    brief,
    event,
  });
}

function rebindPrepared(
  prepared: PreparedAcceptance,
  reboundCandidate: CandidateBrief,
  decisions: IntakeAcceptanceEventPayload["decisions"] = prepared.event.decisions,
): PreparedAcceptance {
  const clarificationDecisions = decisions.filter((decision) => decision.kind === "clarification-answer");
  const intakeDecisionDigest = intakeSha256.sha256(serializeCanonicalProjectJson(
    clarificationDecisions.map((decision) => ({
      subjectDigest: decision.subjectDigest,
      rationale: decision.rationale,
    })),
  ));
  const binding = Object.freeze({
    ...prepared.binding,
    candidateDigest: reboundCandidate.candidateDigest,
    intakeDecisionDigest,
  });
  const bindingDigest = intakeSha256.sha256(serializeCanonicalProjectJson(binding));
  const brief = parseProjectBrief({
    ...prepared.brief,
    briefId: `brf:${bindingDigest.slice(0, 32)}`,
    projectId: reboundCandidate.projectId,
    objective: reboundCandidate.objective.value,
    outcomes: reboundCandidate.outcomes.map((item) => item.value),
    nonGoals: reboundCandidate.nonGoals.map((item) => item.value),
    audiences: reboundCandidate.audiences.map((item) => item.value),
    constraints: reboundCandidate.constraints.map((item) => item.value),
    assumptions: reboundCandidate.assumptions.map(({ text, source, confirmed }) => ({ text, source, confirmed })),
    openQuestions: reboundCandidate.openQuestions.map((item) => item.question),
    sourceThreadId: reboundCandidate.sourceThreadId,
  });
  const fieldProvenance = Object.freeze({
    objective: reboundCandidate.objective.provenance,
    outcomes: reboundCandidate.outcomes.map((item) => item.provenance),
    nonGoals: reboundCandidate.nonGoals.map((item) => item.provenance),
    audiences: reboundCandidate.audiences.map((item) => item.provenance),
    constraints: reboundCandidate.constraints.map((item) => item.provenance),
    assumptions: reboundCandidate.assumptions.map((item) => item.provenance),
    openQuestions: reboundCandidate.openQuestions.map((item) => item.provenance),
  });
  const event: IntakeAcceptanceEventPayload = Object.freeze({
    ...prepared.event,
    binding,
    brief,
    provenance: fieldProvenance,
    decisions,
    operatorEvidence: Object.freeze({
      ...prepared.event.operatorEvidence,
      evidenceId: `intake-evidence:${bindingDigest.slice(0, 32)}`,
      candidateDigest: reboundCandidate.candidateDigest,
    }),
  });
  const projectDigest = intakeSha256.sha256(serializeCanonicalProjectJson({
    aggregateType: "project-brief",
    projectId: reboundCandidate.projectId,
  }));
  return Object.freeze({
    candidate: reboundCandidate,
    aggregateId: `project-brief:${projectDigest.slice(0, 32)}`,
    eventId: `intake:${bindingDigest.slice(0, 32)}`,
    bindingDigest,
    binding,
    aggregateVersion: event.aggregateVersion,
    brief,
    event,
  });
}

async function withMemory(
  work: (adapter: ReturnType<typeof createMemoryPersistenceAdapter>) => Promise<void>,
): Promise<void> {
  const adapter = createMemoryPersistenceAdapter({ clock: fixedClock });
  try {
    await work(adapter);
  } finally {
    await adapter.close();
  }
}

describe("atomic acceptance, revision, and reconciliation", () => {
  it("atomically creates aggregate version 1 and one acceptance-bearing event", async () => withMemory(async (adapter) => {
    const value = candidate();
    const outcome = await acceptCandidate(request(value), {
      digest: intakeSha256,
      clock: fixedClock,
      store: createC7IntakeStore(adapter),
    });
    expect(outcome).toMatchObject({ status: "committed", aggregateVersion: 1 });
    if (outcome.status === "not-recorded" || outcome.status === "outcome-unknown") throw new Error("unexpected");
    expect(parseProjectBrief(outcome.brief)).toEqual(outcome.brief);
    expect(outcome.decisions).toEqual([]);
    const durable = await adapter.transact(async (tx) => {
      const aggregates = await tx.aggregates.list({ aggregateType: "project-brief" });
      const events = await tx.events.list({ aggregateType: "project-brief" });
      return { aggregate: aggregates.items[0], event: events.items[0] };
    });
    expect(durable.aggregate).toMatchObject({ aggregateVersion: 1, payload: outcome.brief });
    expect(durable.event).toMatchObject({ aggregateVersion: 1, eventType: "project-brief.accepted" });
    expect(durable.event?.payload).toMatchObject({
      binding: { expectedHeadBriefId: null, expectedAggregateVersion: 0 },
      decisions: [],
      operatorEvidence: { kind: "explicit-operator-acceptance", authority: "brief-only" },
    });
  }));

  it("refuses a stale presented digest and writes nothing", async () => withMemory(async (adapter) => {
    const value = candidate();
    await expect(acceptCandidate(request(value, { presentedDigest: "0".repeat(64) }), {
      digest: intakeSha256,
      clock: fixedClock,
      store: createC7IntakeStore(adapter),
    })).rejects.toMatchObject({ code: "intake.digest.mismatch" });
    expect(await countBriefRecords(adapter)).toEqual({ aggregates: 0, events: 0 });
  }));

  it("refuses a forged blocked PreparedAcceptance at the C7 boundary and writes nothing", async () => withMemory(async (adapter) => {
    const result = await createC7IntakeStore(adapter).attempt(forgedBlockedPrepared());
    expect(result).toEqual({ kind: "refused" });
    expect(await countBriefRecords(adapter)).toEqual({ aggregates: 0, events: 0 });
  }));

  it("refuses a blocking open question at the public durable-event parser and projection boundary", () => {
    const forged = forgedBlockedPrepared().event;
    expect(() => parseIntakeAcceptanceEvent(forged, intakeSha256)).toThrowError(
      expect.objectContaining({ code: "intake.candidate.not-ready", root: "brief" }),
    );
  });

  it("refuses an accessor-bearing acceptance request without invoking it", () => {
    let invoked = false;
    const value = request(candidate()) as unknown as Record<string, unknown>;
    Object.defineProperty(value, "presentedDigest", {
      enumerable: true,
      get: () => {
        invoked = true;
        return "0".repeat(64);
      },
    });
    expect(() => prepareCandidateAcceptance(value as never, { digest: intakeSha256, clock: fixedClock }))
      .toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(invoked).toBe(false);
  });

  it("resolves a duplicate binding as idempotent without a second write", async () => withMemory(async (adapter) => {
    const value = candidate();
    const store = createC7IntakeStore(adapter);
    const first = await acceptCandidate(request(value), { digest: intakeSha256, clock: fixedClock, store });
    const second = await acceptCandidate(request(value), {
      digest: intakeSha256,
      clock: { now: () => new Date("2026-08-30T13:00:00.000Z") },
      store,
    });
    expect(first.status).toBe("committed");
    expect(second.status).toBe("idempotent");
    expect(await countBriefRecords(adapter)).toEqual({ aggregates: 1, events: 1 });
    if (first.status === "not-recorded" || first.status === "outcome-unknown"
      || second.status === "not-recorded" || second.status === "outcome-unknown") throw new Error("unexpected");
    expect(second.brief).toEqual(first.brief);
  }));

  it("treats different clarification decisions over identical final candidate bytes as competing acceptances", async () => withMemory(async (adapter) => {
    const build = (whyItMatters: string) => {
      const proposed = question("q:decision-binding", {
        question: "Which outcome applies?",
        whyItMatters,
      });
      const initial = candidate({ openQuestions: [proposed] });
      const clarification = resolveClarificationRound(openClarificationRound({
        session: createClarificationSession(), questions: [proposed], knownFacts: [], materialChangeReason: null,
      }, intakeSha256), 1, [{ questionId: "q:decision-binding", kind: "answered", value: "Library" }], intakeSha256);
      return {
        clarification,
        value: applyClarificationsToCandidate(initial, clarification, intakeSha256),
      };
    };
    const firstInput = build("First audited meaning.");
    const secondInput = build("Different audited meaning.");
    expect(firstInput.value.candidateDigest).toBe(secondInput.value.candidateDigest);
    const store = createC7IntakeStore(adapter);
    const first = await acceptCandidate(request(firstInput.value, { clarification: firstInput.clarification }), {
      digest: intakeSha256, clock: fixedClock, store,
    });
    expect(first.status).toBe("committed");
    await expect(acceptCandidate(request(secondInput.value, { clarification: secondInput.clarification }), {
      digest: intakeSha256, clock: fixedClock, store,
    })).rejects.toMatchObject({ code: "intake.brief.superseded" });
    expect(await countBriefRecords(adapter)).toEqual({ aggregates: 1, events: 1 });
  }));

  it("creates a deliberate byte-identical revision at the later version", async () => withMemory(async (adapter) => {
    const value = candidate();
    const store = createC7IntakeStore(adapter);
    const first = await acceptCandidate(request(value), { digest: intakeSha256, clock: fixedClock, store });
    if (first.status === "not-recorded" || first.status === "outcome-unknown") throw new Error("unexpected");
    const second = await acceptCandidate(request(value, {
      expectedHead: first.brief,
      expectedAggregateVersion: 1,
    }), {
      digest: intakeSha256,
      clock: { now: () => new Date("2026-08-30T12:35:56.000Z") },
      store,
    });
    expect(second).toMatchObject({ status: "committed", aggregateVersion: 2 });
    if (second.status === "not-recorded" || second.status === "outcome-unknown") throw new Error("unexpected");
    expect(second.brief.objective).toBe(first.brief.objective);
    expect(second.brief.briefId).not.toBe(first.brief.briefId);
    expect(second.brief.supersedes).toBe(first.brief.briefId);
    expect(second.decisions.map((decision) => decision.kind)).toContain("brief-revision-accepted");
    expect(await countBriefRecords(adapter)).toEqual({ aggregates: 1, events: 2 });
  }));

  it("refuses stale, future-gap, and concurrent revisions as superseded", async () => withMemory(async (adapter) => {
    const store = createC7IntakeStore(adapter);
    const first = await acceptCandidate(request(candidate()), { digest: intakeSha256, clock: fixedClock, store });
    if (first.status === "not-recorded" || first.status === "outcome-unknown") throw new Error("unexpected");

    await expect(acceptCandidate(request(candidate({ outcomes: [field("Future candidate")] }), {
      expectedHead: first.brief,
      expectedAggregateVersion: 2,
    }), { digest: intakeSha256, clock: fixedClock, store })).rejects.toMatchObject({ code: "intake.brief.superseded" });

    const winnerCandidate = candidate({ outcomes: [field("Winner") ] });
    const loserCandidate = candidate({ outcomes: [field("Loser") ] });
    const winner = await acceptCandidate(request(winnerCandidate, {
      expectedHead: first.brief,
      expectedAggregateVersion: 1,
    }), { digest: intakeSha256, clock: fixedClock, store });
    expect(winner.status).toBe("committed");
    await expect(acceptCandidate(request(loserCandidate, {
      expectedHead: first.brief,
      expectedAggregateVersion: 1,
    }), { digest: intakeSha256, clock: fixedClock, store })).rejects.toMatchObject({ code: "intake.brief.superseded" });
    expect(await countBriefRecords(adapter)).toEqual({ aggregates: 1, events: 2 });
  }));

  it("rejects an invalid first/revision version pair before touching the store", async () => withMemory(async (adapter) => {
    await expect(acceptCandidate(request(candidate(), { expectedAggregateVersion: 1 }), {
      digest: intakeSha256,
      clock: fixedClock,
      store: createC7IntakeStore(adapter),
    })).rejects.toMatchObject({ code: "intake.version.invalid" });
    expect(await countBriefRecords(adapter)).toEqual({ aggregates: 0, events: 0 });
  }));

  it("recovers an acknowledged-unknown committed write by reread with exactly one attempt", async () => withMemory(async (adapter) => {
    const real = createC7IntakeStore(adapter);
    const attempt = vi.fn(async (prepared) => {
      const committed = await real.attempt(prepared);
      expect(committed.kind).toBe("committed");
      return { kind: "unknown" as const };
    });
    const store: IntakeAcceptanceStore = { attempt, reconcile: real.reconcile };
    const result = await acceptCandidate(request(candidate()), { digest: intakeSha256, clock: fixedClock, store });
    expect(result.status).toBe("recovered");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(await countBriefRecords(adapter)).toEqual({ aggregates: 1, events: 1 });
  }));

  it("returns not-recorded after an unknown attempt whose bounded reread proves absence", async () => {
    const attempt = vi.fn(async () => ({ kind: "unknown" as const }));
    const reconcile = vi.fn(async () => ({ kind: "not-recorded" as const }));
    const result = await acceptCandidate(request(candidate()), {
      digest: intakeSha256,
      clock: fixedClock,
      store: { attempt, reconcile },
    });
    expect(result.status).toBe("not-recorded");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("treats a thrown write result as ambiguous and adjudicates it without retry", async () => {
    const attempt = vi.fn(async () => { throw new Error("raw store path C:\\private"); });
    const reconcile = vi.fn(async () => ({ kind: "not-recorded" as const }));
    const result = await acceptCandidate(request(candidate()), {
      digest: intakeSha256,
      clock: fixedClock,
      store: { attempt, reconcile },
    });
    expect(result.status).toBe("not-recorded");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("returns outcome-unknown when bounded reconciliation cannot decide", async () => {
    const result = await acceptCandidate(request(candidate()), {
      digest: intakeSha256,
      clock: fixedClock,
      store: {
        attempt: async () => ({ kind: "unknown" }),
        reconcile: async () => ({ kind: "limit" }),
      },
    });
    expect(result.status).toBe("outcome-unknown");
  });

  it("rolls back the aggregate when event append fails inside the C7 transaction", async () => withMemory(async (adapter) => {
    const faultAdapter: PersistenceAdapter = {
      transact: <T>(work: (tx: TransactionContext) => Promise<T> | T): Promise<T> => adapter.transact((tx) => work(Object.freeze({
        ...tx,
        events: Object.freeze({
          ...tx.events,
          append: async () => { throw new Error("synthetic after-aggregate-before-event fault"); },
        }),
      }))),
      migrationStatus: () => adapter.migrationStatus(),
      close: () => Promise.resolve(),
    };
    const result = await acceptCandidate(request(candidate()), {
      digest: intakeSha256,
      clock: fixedClock,
      store: createC7IntakeStore(faultAdapter),
    });
    expect(result.status).toBe("not-recorded");
    expect(await countBriefRecords(adapter)).toEqual({ aggregates: 0, events: 0 });
  }));

  it("creates content-derived Decision identities that pass the C6 guard", () => {
    const prepared = prepareCandidateAcceptance(request(candidate()), { digest: intakeSha256, clock: fixedClock });
    for (const decision of prepared.event.decisions) {
      const { decisionId: _decisionId, ...material } = decision;
      const fullDigest = intakeSha256.sha256(decisionIdentityMaterial(material));
      expect(() => assertContentDerivedIdentity({ kind: "decision", record: decision }, fullDigest)).not.toThrow();
    }
  });

  it("refuses an event whose durable decision-set binding was forged", () => {
    const prepared = prepareCandidateAcceptance(request(candidate()), { digest: intakeSha256, clock: fixedClock });
    expect(() => parseIntakeAcceptanceEvent({
      ...prepared.event,
      binding: { ...prepared.event.binding, intakeDecisionDigest: "0".repeat(64) },
    }, intakeSha256)).toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
  });

  it("refuses self-consistent clarification decisions with invalid lineage semantics", () => {
    const proposed = question("q:decision-lineage");
    const clarification = resolveClarificationRound(openClarificationRound({
      session: createClarificationSession(),
      questions: [proposed],
      knownFacts: [],
      materialChangeReason: null,
    }, intakeSha256), 1, [{
      questionId: proposed.question.questionId,
      kind: "answered",
      value: "Library",
    }], intakeSha256);
    const value = applyClarificationsToCandidate(
      candidate({ openQuestions: [proposed] }),
      clarification,
      intakeSha256,
    );
    const prepared = prepareCandidateAcceptance(request(value, { clarification }), {
      digest: intakeSha256,
      clock: fixedClock,
    });
    const decision = prepared.event.decisions[0]!;
    const { decisionId: _decisionId, ...originalMaterial } = decision;
    const forgedMaterial = { ...originalMaterial, supersedes: "dec:prior" };
    const fullDigest = intakeSha256.sha256(decisionIdentityMaterial(forgedMaterial));
    const forgedDecision = { ...forgedMaterial, decisionId: `dec:${fullDigest.slice(0, 32)}` };
    expect(() => parseIntakeAcceptanceEvent({
      ...prepared.event,
      decisions: [forgedDecision],
    }, intakeSha256)).toThrowError(expect.objectContaining({ code: "intake.input.invalid", root: "decision" }));
  });

  it("refuses self-consistent outer identities when clarification audit text does not match its question-set digest", () => {
    const proposed = question("q:decision-question-set-binding");
    const clarification = resolveClarificationRound(openClarificationRound({
      session: createClarificationSession(),
      questions: [proposed],
      knownFacts: [],
      materialChangeReason: null,
    }, intakeSha256), 1, [{
      questionId: proposed.question.questionId,
      kind: "answered",
      value: "Library",
    }], intakeSha256);
    const value = applyClarificationsToCandidate(
      candidate({ openQuestions: [proposed] }),
      clarification,
      intakeSha256,
    );
    const prepared = prepareCandidateAcceptance(request(value, { clarification }), {
      digest: intakeSha256,
      clock: fixedClock,
    });
    const decision = prepared.event.decisions[0]!;
    const rationale = JSON.parse(decision.rationale!) as {
      questions: Array<{ question: { question: string } }>;
    };
    rationale.questions[0]!.question.question = "Forged durable audit question.";
    const forgedRationale = serializeCanonicalProjectJson(rationale);
    const { decisionId: _decisionId, ...originalDecisionMaterial } = decision;
    const forgedDecisionMaterial = { ...originalDecisionMaterial, rationale: forgedRationale };
    const decisionDigest = intakeSha256.sha256(decisionIdentityMaterial(forgedDecisionMaterial));
    const forgedDecision = Object.freeze({
      ...forgedDecisionMaterial,
      decisionId: `dec:${decisionDigest.slice(0, 32)}`,
    });
    const intakeDecisionDigest = intakeSha256.sha256(serializeCanonicalProjectJson([{
      subjectDigest: forgedDecision.subjectDigest,
      rationale: forgedDecision.rationale,
    }]));
    const binding = Object.freeze({ ...prepared.event.binding, intakeDecisionDigest });
    const bindingDigest = intakeSha256.sha256(serializeCanonicalProjectJson(binding));
    expect(() => parseIntakeAcceptanceEvent({
      ...prepared.event,
      binding,
      decisions: [forgedDecision],
      operatorEvidence: {
        ...prepared.event.operatorEvidence,
        evidenceId: `intake-evidence:${bindingDigest.slice(0, 32)}`,
      },
    }, intakeSha256)).toThrowError(expect.objectContaining({ code: "intake.input.invalid", root: "decision" }));
  });

  it("refuses a self-consistent durable answer outside the closed options and writes nothing", async () => withMemory(async (adapter) => {
    const proposed = question("q:durable-options");
    const clarification = resolveClarificationRound(openClarificationRound({
      session: createClarificationSession(),
      questions: [proposed],
      knownFacts: [],
      materialChangeReason: null,
    }, intakeSha256), 1, [{
      questionId: proposed.question.questionId,
      kind: "answered",
      value: "Library",
    }], intakeSha256);
    const prepared = prepareCandidateAcceptance(request(applyClarificationsToCandidate(
      candidate({ openQuestions: [proposed] }),
      clarification,
      intakeSha256,
    ), { clarification }), { digest: intakeSha256, clock: fixedClock });
    const decision = prepared.event.decisions[0]!;
    const rationale = JSON.parse(decision.rationale!) as { resolutions: Array<{ value: string }> };
    rationale.resolutions[0]!.value = "Service";
    const { decisionId: _decisionId, ...decisionMaterial } = decision;
    const forgedDecisionMaterial = Object.freeze({
      ...decisionMaterial,
      rationale: serializeCanonicalProjectJson(rationale),
    });
    const decisionDigest = intakeSha256.sha256(decisionIdentityMaterial(forgedDecisionMaterial));
    const forgedDecision = Object.freeze({
      ...forgedDecisionMaterial,
      decisionId: `dec:${decisionDigest.slice(0, 32)}`,
    });
    const answer = `${proposed.question.question} Answer: Service`;
    const reboundCandidate = candidate({
      assumptions: [Object.freeze({
        text: answer,
        source: "operator" as const,
        confirmed: true,
        provenance: provenance(),
      })],
    });
    const forged = rebindPrepared(prepared, reboundCandidate, [forgedDecision]);
    expect(() => parseIntakeAcceptanceEvent(forged.event, intakeSha256)).toThrowError(
      expect.objectContaining({ code: "intake.input.invalid", root: "decision" }),
    );
    expect(await createC7IntakeStore(adapter).attempt(forged)).toEqual({ kind: "refused" });
    expect(await countBriefRecords(adapter)).toEqual({ aggregates: 0, events: 0 });
  }));

  it("refuses a durable answered decision whose confirmed operator assumption was omitted and writes nothing", async () => withMemory(async (adapter) => {
    const proposed = question("q:durable-answer-binding");
    const clarification = resolveClarificationRound(openClarificationRound({
      session: createClarificationSession(),
      questions: [proposed],
      knownFacts: [],
      materialChangeReason: null,
    }, intakeSha256), 1, [{
      questionId: proposed.question.questionId,
      kind: "answered",
      value: "Library",
    }], intakeSha256);
    const prepared = prepareCandidateAcceptance(request(applyClarificationsToCandidate(
      candidate({ openQuestions: [proposed] }),
      clarification,
      intakeSha256,
    ), { clarification }), { digest: intakeSha256, clock: fixedClock });
    const forged = rebindPrepared(prepared, candidate());
    expect(() => parseIntakeAcceptanceEvent(forged.event, intakeSha256)).toThrowError(
      expect.objectContaining({ code: "intake.input.invalid", root: "clarification" }),
    );
    expect(await createC7IntakeStore(adapter).attempt(forged)).toEqual({ kind: "refused" });
    expect(await countBriefRecords(adapter)).toEqual({ aggregates: 0, events: 0 });
  }));

  it("refuses a durable unresolved decision whose matching open question was omitted and writes nothing", async () => withMemory(async (adapter) => {
    const proposed = question("q:durable-unresolved-binding");
    const clarification = openClarificationRound({
      session: createClarificationSession(),
      questions: [proposed],
      knownFacts: [],
      materialChangeReason: null,
    }, intakeSha256);
    const prepared = prepareCandidateAcceptance(request(applyClarificationsToCandidate(
      candidate({ openQuestions: [proposed] }),
      clarification,
      intakeSha256,
    ), { clarification }), { digest: intakeSha256, clock: fixedClock });
    const forged = rebindPrepared(prepared, candidate());
    expect(() => parseIntakeAcceptanceEvent(forged.event, intakeSha256)).toThrowError(
      expect.objectContaining({ code: "intake.input.invalid", root: "clarification" }),
    );
    expect(await createC7IntakeStore(adapter).attempt(forged)).toEqual({ kind: "refused" });
    expect(await countBriefRecords(adapter)).toEqual({ aggregates: 0, events: 0 });
  }));

  it("abandon is pure and does not receive or invoke a store", () => {
    const value = candidate();
    expect(abandonCandidate(value)).toEqual({ status: "abandoned", candidateDigest: value.candidateDigest, durableWrites: 0 });
  });

  it("abandon refuses an accessor digest without invoking it", () => {
    let invoked = false;
    const value = { ...candidate() } as Record<string, unknown>;
    Object.defineProperty(value, "candidateDigest", {
      enumerable: true,
      get: () => {
        invoked = true;
        return "0".repeat(64);
      },
    });
    expect(() => abandonCandidate(value as never)).toThrowError(expect.objectContaining({ code: "intake.input.invalid" }));
    expect(invoked).toBe(false);
  });

  it("uses one injected digest consistently in preparation and C7 reconciliation", async () => withMemory(async (adapter) => {
    const digest = Object.freeze({ sha256: () => "1".repeat(64) });
    const value = candidate({}, digest);
    const store = createC7IntakeStore(adapter, digest);
    const first = await acceptCandidate(request(value), { digest, clock: fixedClock, store });
    const second = await acceptCandidate(request(value), {
      digest,
      clock: { now: () => new Date("2026-08-30T13:00:00.000Z") },
      store,
    });
    expect(first.status).toBe("committed");
    expect(second.status).toBe("idempotent");
    expect(await countBriefRecords(adapter)).toEqual({ aggregates: 1, events: 1 });
  }));

  it("caps journal reconciliation instead of scanning without limit", async () => withMemory(async (adapter) => {
    const prepared = prepareCandidateAcceptance(request(candidate()), { digest: intakeSha256, clock: fixedClock });
    await adapter.transact(async (tx) => {
      for (let index = 0; index < 1_001; index += 1) {
        await tx.events.append({
          eventId: `dummy:${String(index)}`,
          aggregateType: "project-brief",
          aggregateId: prepared.aggregateId,
          aggregateVersion: 1,
          eventType: "dummy.observation",
          eventSchemaVersion: 1,
          payload: { index },
          occurredAt: FIXED_ISO,
        });
      }
    });
    expect(await createC7IntakeStore(adapter).reconcile(prepared)).toEqual({ kind: "limit" });
  }));

  it("finds an identical binding across multiple ascending journal pages", async () => withMemory(async (adapter) => {
    const value = candidate();
    const prepared = prepareCandidateAcceptance(request(value), { digest: intakeSha256, clock: fixedClock });
    await adapter.transact(async (tx) => {
      for (let index = 0; index < 150; index += 1) {
        await tx.events.append({
          eventId: `earlier:${String(index)}`,
          aggregateType: "project-brief",
          aggregateId: prepared.aggregateId,
          aggregateVersion: 1,
          eventType: "earlier.observation",
          eventSchemaVersion: 1,
          payload: { index },
          occurredAt: FIXED_ISO,
        });
      }
    });
    const store = createC7IntakeStore(adapter);
    expect((await store.attempt(prepared)).kind).toBe("committed");
    expect(await store.reconcile(prepared)).toMatchObject({ kind: "committed" });
  }));

  it("uses the same generic C7 bridge with the real SQLite adapter", async () => {
    const adapter = createSqlitePersistenceAdapter({ memory: true, clock: fixedClock });
    try {
      const result = await acceptCandidate(request(candidate()), {
        digest: intakeSha256,
        clock: fixedClock,
        store: createC7IntakeStore(adapter),
      });
      expect(result).toMatchObject({ status: "committed", aggregateVersion: 1 });
      expect(await countBriefRecords(adapter)).toEqual({ aggregates: 1, events: 1 });
    } finally {
      await adapter.close();
    }
  });
});
