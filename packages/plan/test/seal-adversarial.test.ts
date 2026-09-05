import { describe, expect, it } from "vitest";
import { parseDecision, parseProjectBrief, type Decision } from "@ai-dev-os/project";
import {
  INTAKE_BLOCKING_BASES,
  applyClarificationsToCandidate,
  assembleCandidate,
  createClarificationSession,
  intakeSha256,
  openClarificationRound,
  parseIntakeAcceptanceEvent,
  prepareCandidateAcceptance,
  resolveClarificationRound,
  type CandidateDraftInput,
  type IntakeBlockingBasis,
  type ProposedIntakeQuestion,
} from "@ai-dev-os/intake";
import {
  PlanContractError,
  assertAuthenticatedOperatorEvidence,
  assertSealConditions,
  blockingOpenQuestionIds,
  decisionsMatchAuthorization,
  evaluateSealConditions,
  parsePlanReviewEvidence,
  projectStopSnapshotDigestMaterial,
  resolveProjectCeiling,
  scopeApprovalSatisfiesCondition6,
  type AuthenticatedOperatorClaimEvidence,
  type SealEvaluationInput,
} from "../src/index.js";
import { planSha256 } from "../src/testing/index.js";
import { SHA_A, SHA_B, T0, acceptedHead, assembled, brief, budgetAccount, project } from "./fixtures.js";

function base(): SealEvaluationInput {
  const result = assembled(undefined, project(), acceptedHead(), { state: "proposed" });
  const accepted = acceptedHead();
  return {
    plan: result.plan,
    review: result.review,
    acceptedBrief: accepted,
    project: project(),
    controls: { projectAggregateVersion: 1, projectContentDigest: SHA_A, projectStatus: "active", projectStopSnapshotDigest: SHA_B, activeProjectStopIds: [] },
    resolvedProjectCeiling: resolveProjectCeiling("budget:plan-test", budgetAccount(), { aggregateVersion: 1, contentDigest: SHA_A }, accepted),
    authenticatedDecisions: [],
    scopeApproval: null,
  };
}

function scopedDecision(input: SealEvaluationInput, kind: Decision["kind"], taskId: string | null = null): Decision {
  return parseDecision({
    schemaVersion: 1, decisionId: `dec:${"d".repeat(32)}`, revision: 1, projectId: input.plan.projectId,
    scope: { planId: input.plan.planId, planRevision: input.plan.revision, stageId: null, taskId },
    kind, decidedBy: "operator", statement: "Authenticate the exact bounded decision.", rationale: null,
    supersedes: null, subjectDigest: input.plan.planDigest, decidedAt: T0,
  });
}

describe("G-0..G-14 seal adversarial controls", () => {
  it("resolves absent account dimensions to zero and explicit/multiple brief constraints by minima", () => {
    const accepted = acceptedHead();
    const noMoney = structuredClone(budgetAccount()) as unknown as Record<string, unknown>;
    ((noMoney["budget"] as Record<string, unknown>)["money"]) = null;
    expect(resolveProjectCeiling("budget:plan-test", noMoney as never, { aggregateVersion: 1, contentDigest: SHA_A }, accepted).ceiling.maximumCostMicros).toBe(0);

    const noTokens = structuredClone(budgetAccount()) as unknown as Record<string, unknown>;
    ((noTokens["budget"] as Record<string, unknown>)["tokens"]) = null;
    const tokenless = resolveProjectCeiling("budget:plan-test", noTokens as never, { aggregateVersion: 1, contentDigest: SHA_A }, accepted);
    expect(tokenless.accountMaximumTotalTokens).toBeNull();
    expect(tokenless.ceiling).toMatchObject({ maximumInputTokens: 100, maximumOutputTokens: 100 });

    const constrained = parseProjectBrief({
      ...brief(),
      constraints: [
        ...brief().constraints,
        { constraintId: "constraint:tighter", kind: "budget-tokens", statement: "Use tighter directional limits.", enforcement: "hard", machineForm: { maximumInputTokens: 80, maximumOutputTokens: 70, maximumToolCalls: 1, maximumTurns: 1 }, origin: "operator", authority: "operator" },
      ],
    });
    const tight = resolveProjectCeiling("budget:plan-test", budgetAccount(), { aggregateVersion: 1, contentDigest: SHA_A }, acceptedHead(constrained));
    expect(tight.ceiling).toMatchObject({ maximumInputTokens: 80, maximumOutputTokens: 70, maximumToolCalls: 1, maximumTurns: 1 });
  });

  it("refuses cancelled/wrong-scope accounts, currency conflicts, overlaps above account, and unknown hard forms", () => {
    const accepted = acceptedHead();
    for (const mutate of [
      (account: Record<string, unknown>) => { account["status"] = "cancelled"; },
      (account: Record<string, unknown>) => { (account["scope"] as Record<string, unknown>)["scopeId"] = "prj:other"; },
    ]) {
      const account = structuredClone(budgetAccount()) as unknown as Record<string, unknown>;
      mutate(account);
      expect(() => resolveProjectCeiling("budget:plan-test", account as never, { aggregateVersion: 1, contentDigest: SHA_A }, accepted)).toThrow();
    }
    const currencyBrief = parseProjectBrief({
      ...brief(), constraints: brief().constraints.map((constraint) => constraint.kind === "budget-money" ? { ...constraint, machineForm: { currency: "USD", maximumCostMicros: 1_000 } } : constraint),
    });
    expect(() => resolveProjectCeiling("budget:plan-test", budgetAccount(), { aggregateVersion: 1, contentDigest: SHA_A }, acceptedHead(currencyBrief))).toThrow();

    const above = parseProjectBrief({
      ...brief(), constraints: brief().constraints.map((constraint) => constraint.kind === "budget-tokens" ? { ...constraint, machineForm: { maximumInputTokens: 101, maximumOutputTokens: 100, maximumToolCalls: 2, maximumTurns: 2 } } : constraint),
    });
    expect(() => resolveProjectCeiling("budget:plan-test", budgetAccount(), { aggregateVersion: 1, contentDigest: SHA_A }, acceptedHead(above))).toThrow();

    const unknown = parseProjectBrief({
      ...brief(), constraints: [...brief().constraints, { constraintId: "constraint:quality", kind: "quality-bar", statement: "Unknown to C9.", enforcement: "hard", machineForm: { gate: "tests" }, origin: "operator", authority: "operator" }],
    });
    expect(() => resolveProjectCeiling("budget:plan-test", budgetAccount(), { aggregateVersion: 1, contentDigest: SHA_A }, acceptedHead(unknown))).toThrow();
  });

  it("derives blocking ids as a sorted pure boolean and refuses them after condition checks", () => {
    const blocked = parseProjectBrief({
      ...brief(),
      openQuestions: [
        { questionId: "question:z", theme: "scope", question: "Z?", whyItMatters: "It changes scope.", options: ["Yes", "No"], proposedDefault: "No", consequenceIfDefaulted: "No change.", blocking: true },
        { questionId: "question:a", theme: "scope", question: "A?", whyItMatters: "It changes scope.", options: ["Yes", "No"], proposedDefault: "No", consequenceIfDefaulted: "No change.", blocking: true },
        { questionId: "question:nonblocking", theme: "quality-bar", question: "N?", whyItMatters: "It changes quality.", options: ["Yes", "No"], proposedDefault: "No", consequenceIfDefaulted: "No change.", blocking: false },
      ],
    });
    expect(blockingOpenQuestionIds(blocked)).toEqual(["question:a", "question:z"]);
    const input = { ...base(), acceptedBrief: acceptedHead(blocked) };
    try { assertSealConditions(input); } catch (error) { expect(error).toMatchObject({ ruleId: "plan.brief.blocking-unanswered" }); }
  });

  it("tracks all five upstream blocking bases through resolution, the public acceptance parser, and the frozen predicate", () => {
    expect(INTAKE_BLOCKING_BASES).toEqual([
      "required-outcome",
      "hard-constraint-machine-form",
      "data-permission-ceiling",
      "budget-ceiling",
      "repository-branch-ambiguity",
    ]);
    const operator = Object.freeze({ source: "operator-supplied" as const, acceptedByOperator: true });
    const field = (value: string) => Object.freeze({ value, provenance: operator });
    const source = brief();
    const candidateInput = (question: ProposedIntakeQuestion): CandidateDraftInput => Object.freeze({
      projectId: source.projectId,
      objective: field(source.objective),
      outcomes: source.outcomes.map(field),
      nonGoals: source.nonGoals.map(field),
      audiences: source.audiences.map(field),
      constraints: source.constraints.map((constraint) => Object.freeze({ value: constraint, provenance: operator, possible: true })),
      assumptions: Object.freeze([]),
      openQuestions: Object.freeze([question]),
      sourceThreadId: null,
    });
    const blockingQuestion = (basis: IntakeBlockingBasis): ProposedIntakeQuestion => Object.freeze({
      question: Object.freeze({
        questionId: `q:${basis}`,
        theme: "scope" as const,
        question: `Resolve ${basis}?`,
        whyItMatters: "C8 must remove every resolved blocking question before acceptance.",
        options: Object.freeze(["Library", "Application"]),
        proposedDefault: "Library",
        consequenceIfDefaulted: "The accepted brief records the explicit resolution.",
        blocking: true,
      }),
      blockingBasis: basis,
      provenance: Object.freeze({ source: "model-proposed" as const, acceptedByOperator: false }),
      source: "derived" as const,
    });

    for (const basis of INTAKE_BLOCKING_BASES) {
      const proposed = blockingQuestion(basis);
      const initial = assembleCandidate(candidateInput(proposed), intakeSha256);
      const clarification = resolveClarificationRound(openClarificationRound({
        session: createClarificationSession(),
        questions: [proposed],
        knownFacts: [],
        materialChangeReason: null,
      }, intakeSha256), 1, [{ questionId: proposed.question.questionId, kind: "answered", value: "Library" }], intakeSha256);
      const resolved = applyClarificationsToCandidate(initial, clarification, intakeSha256);
      const prepared = prepareCandidateAcceptance({
        candidate: resolved,
        presentedDigest: resolved.candidateDigest,
        expectedHead: null,
        expectedAggregateVersion: 0,
        clarification,
        operatorConfirmed: true,
      }, { digest: intakeSha256, clock: Object.freeze({ now: () => new Date(T0) }) });
      const parsed = parseIntakeAcceptanceEvent(prepared.event, intakeSha256);
      expect(parsed.brief.openQuestions, basis).toEqual([]);
      expect(blockingOpenQuestionIds(parsed.brief), basis).toEqual([]);
    }
  });

  it("covers required, waived, non-executable, executable-mismatch, and reverse-coverage failures", () => {
    const input = base();
    const requirement = input.review.specification!.requirements[0]!;
    const verdict = (replacement: Record<string, unknown>, decisions: readonly Decision[] = []) => evaluateSealConditions({
      ...input,
      review: { ...input.review, specification: { ...input.review.specification!, requirements: [replacement] } },
      authenticatedDecisions: decisions,
    })[2];
    expect(verdict({ ...requirement, executable: false }).ruleIds).toContain("plan.coverage.executable-mismatch");
    expect(verdict({ ...requirement, disposition: "deferred", executable: false }).ruleIds).toContain("plan.coverage.non-executable-covered");
    expect(verdict({ ...requirement, taskId: null }).ruleIds).toContain("plan.seal.condition-3");
    expect(verdict({ ...requirement, disposition: "waived", executable: false, taskId: null, waiverDecisionId: null }).ruleIds).toContain("plan.coverage.waiver-unbound");

    const waiver = scopedDecision(input, "waiver-granted");
    expect(verdict({ ...requirement, disposition: "waived", executable: false, taskId: null, waiverDecisionId: waiver.decisionId }, [waiver]).ruleIds).not.toContain("plan.coverage.waiver-unbound");
    expect(verdict({ ...requirement, disposition: "delight-candidate", executable: true, taskId: null }).ruleIds).toContain("plan.coverage.unmapped-task");
  });

  it("requires exact authenticated operator rows and treats missing rows as inferred scope", () => {
    const input = base();
    const proposal = structuredClone(input.review.assemblyRequest.proposal);
    const rows: AuthenticatedOperatorClaimEvidence[] = [];
    for (const [nodeKind, node] of [["stage", proposal.stages[0]!], ["task", proposal.tasks[0]!]] as const) {
      for (const path of Object.keys(node.provenance)) {
        const value = path === "title" ? node.title
          : nodeKind === "stage" && path === "intent" ? node.intent
            : nodeKind === "task" && path === "objective" ? node.objective
              : nodeKind === "stage" ? node.exitCriteria[0]! : node.acceptance[0]!.criterion;
        (node.provenance as Record<string, unknown>)[path] = { origin: "operator", derivedFrom: null, verbatim: false };
        rows.push({ nodeKind, nodeId: nodeKind === "stage" ? node.stageId : node.taskId, fieldPath: path, value });
      }
    }
    const review = { ...input.review, assemblyRequest: { ...input.review.assemblyRequest, proposal }, authenticatedOperatorEvidence: rows };
    expect(() => assertAuthenticatedOperatorEvidence(review, rows)).not.toThrow();
    expect(() => assertAuthenticatedOperatorEvidence(review, rows.slice(1))).toThrow();
    expect(() => assertAuthenticatedOperatorEvidence(review, [...rows, rows[0]!])).toThrow();
    expect(evaluateSealConditions({ ...input, review: { ...review, authenticatedOperatorEvidence: [] } })[5].passed).toBe(false);

    const ordinaryStage = input.review.assemblyRequest.proposal.stages[0]!;
    const impossibleRows = [
      { nodeKind: "stage", nodeId: ordinaryStage.stageId, fieldPath: "title", value: ordinaryStage.title },
      { nodeKind: "stage", nodeId: "stg:missing", fieldPath: "title", value: ordinaryStage.title },
      { nodeKind: "stage", nodeId: ordinaryStage.stageId, fieldPath: "title", value: "Different bytes." },
    ] as const;
    for (const row of impossibleRows) {
      expect(() => parsePlanReviewEvidence({
        ...input.review,
        authenticatedOperatorEvidence: [row],
      }, planSha256)).toThrow();
    }
  });

  it("authenticates plan-bound decisions byte-for-byte and rejects stale or altered copies", () => {
    const input = base();
    const waiver = scopedDecision(input, "waiver-granted");
    expect(decisionsMatchAuthorization([waiver], [waiver])).toBe(true);
    expect(decisionsMatchAuthorization([waiver], [])).toBe(false);
    expect(decisionsMatchAuthorization([waiver], [{ ...waiver, statement: "Changed" }])).toBe(false);
    const requirement = { ...input.review.specification!.requirements[0]!, disposition: "waived" as const, executable: false, taskId: null, waiverDecisionId: waiver.decisionId };
    const stale = { ...waiver, scope: { ...waiver.scope, planRevision: waiver.scope.planRevision! + 1 } } as Decision;
    const result = evaluateSealConditions({ ...input, review: { ...input.review, specification: { ...input.review.specification!, requirements: [requirement] } }, authenticatedDecisions: [stale] });
    expect(result[2].passed).toBe(false);
  });

  it("G-8 reports simultaneous condition 1, 3, and 5 failures without short-circuiting", () => {
    const input = base();
    const taskId = input.plan.tasks[0]!.taskId;
    const cyclic = {
      ...input.plan,
      dependencies: [{ fromTaskId: taskId, toTaskId: taskId, kind: "finish-to-start" as const, artifactKind: null }],
    };
    const uncovered = {
      ...input.review,
      specification: {
        ...input.review.specification!,
        requirements: input.review.specification!.requirements.map((requirement, index) => index === 0
          ? { ...requirement, taskId: null, waiverDecisionId: null }
          : requirement),
      },
    };
    const verdicts = evaluateSealConditions({
      ...input,
      plan: cyclic,
      review: uncovered,
      resolvedProjectCeiling: {
        ...input.resolvedProjectCeiling,
        ceiling: { ...input.resolvedProjectCeiling.ceiling, maximumTurns: 0 },
      },
    });
    expect(verdicts.map((verdict) => verdict.passed)).toEqual([false, true, false, true, false, true]);
    expect(verdicts.filter((verdict) => !verdict.passed).map((verdict) => verdict.condition)).toEqual([1, 3, 5]);
    expect(verdicts.every((verdict) => verdict.ruleIds.length === new Set(verdict.ruleIds).size)).toBe(true);
  });

  it("G-13 does not let an authenticated budget-extension decision relax condition 5", () => {
    const input = base();
    const constrained = {
      ...input.resolvedProjectCeiling,
      ceiling: { ...input.resolvedProjectCeiling.ceiling, maximumInputTokens: input.plan.budgetCeiling.maximumInputTokens - 1 },
    };
    const decision = scopedDecision(input, "budget-extension-accepted", input.plan.tasks[0]!.taskId);
    const withoutDecision = evaluateSealConditions({ ...input, resolvedProjectCeiling: constrained })[4];
    const withDecision = evaluateSealConditions({ ...input, resolvedProjectCeiling: constrained, authenticatedDecisions: [decision] })[4];
    expect(withDecision).toEqual(withoutDecision);
    expect(withDecision).toEqual({ condition: 5, passed: false, ruleIds: ["plan.seal.condition-5"] });
    expect(evaluateSealConditions({ ...input, authenticatedDecisions: [decision] })[4].passed, "planted raised-ceiling control").toBe(true);
  });

  it("returns condition-specific failures for malformed graphs, bounds, budgets, constraints, and approvals", () => {
    const input = base();
    const malformed = evaluateSealConditions({ ...input, plan: { ...input.plan, stages: [] } as never });
    expect(malformed[0].passed).toBe(false);
    const bounded = evaluateSealConditions({ ...input, plan: { ...input.plan, stages: Array.from({ length: 65 }, (_, ordinal) => ({ stageId: `stg:${ordinal}`, ordinal: ordinal + 1, taskIds: [] })) } as never });
    expect(bounded[1]).toMatchObject({ passed: false, condition: 2 });
    const overBudget = evaluateSealConditions({ ...input, resolvedProjectCeiling: { ...input.resolvedProjectCeiling, ceiling: { ...input.resolvedProjectCeiling.ceiling, maximumTurns: 1 } } });
    expect(overBudget[4].passed).toBe(false);
    const noDisposition = evaluateSealConditions({ ...input, review: { ...input.review, constraintDispositions: [] } });
    expect(noDisposition[3].ruleIds).toContain("plan.constraint.no-disposition");
    expect(scopeApprovalSatisfiesCondition6(null, input.plan)).toBe(false);
    expect(scopeApprovalSatisfiesCondition6({ broken: true } as never, input.plan)).toBe(false);
    expect(() => assertSealConditions({ ...input, resolvedProjectCeiling: { ...input.resolvedProjectCeiling, ceiling: { ...input.resolvedProjectCeiling.ceiling, maximumTurns: 0 } } })).toThrow(PlanContractError);
  });

  it("hashes a stable sorted stop snapshot including the conclusive empty set", () => {
    const a = { aggregateId: "pst:a", aggregateVersion: 2, payload: { projectId: "prj:plan-test" } };
    const b = { aggregateId: "pst:b", aggregateVersion: 1, payload: { projectId: "prj:plan-test" } };
    expect(projectStopSnapshotDigestMaterial("prj:plan-test", [b, a], planSha256)).toBe(projectStopSnapshotDigestMaterial("prj:plan-test", [a, b], planSha256));
    expect(projectStopSnapshotDigestMaterial("prj:plan-test", [], planSha256)).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => projectStopSnapshotDigestMaterial("wrong-project", [], planSha256)).toThrow();

    const complete: Record<string, unknown> = {
      aggregateType: "project-stop",
      aggregateId: "pst:complete",
      schemaVersion: 1,
      aggregateVersion: 1,
      payload: { schemaVersion: 1, projectStopId: "pst:complete", projectId: "prj:plan-test", revision: 1, engagedAt: T0, effects: {}, resumedAt: T0 },
      checksum: { algorithm: "sha256", hex: "a".repeat(64) },
      createdAt: T0,
      updatedAt: T0,
      traceId: null,
    };
    const baseline = projectStopSnapshotDigestMaterial("prj:plan-test", [complete], planSha256);
    const replacements: Readonly<Record<string, unknown>> = {
      aggregateType: "unexpected-stop",
      aggregateId: "pst:changed",
      schemaVersion: 2,
      aggregateVersion: 2,
      payload: { changed: true },
      checksum: { algorithm: "sha256", hex: "b".repeat(64) },
      createdAt: "2026-09-04T10:01:00.000Z",
      updatedAt: "2026-09-04T10:01:00.000Z",
      traceId: "trace:changed",
    };
    for (const key of Object.keys(complete)) {
      const omitted = structuredClone(complete);
      delete omitted[key];
      expect(projectStopSnapshotDigestMaterial("prj:plan-test", [omitted], planSha256), `omitted ${key}`).not.toBe(baseline);
      expect(projectStopSnapshotDigestMaterial("prj:plan-test", [{ ...complete, [key]: replacements[key] }], planSha256), `changed ${key}`).not.toBe(baseline);
    }
  });

  it("converts throwing and malformed stop-snapshot digest ports into typed refusals", () => {
    for (const sha256 of [
      () => { throw new Error("digest port fault"); },
      () => "not-a-digest",
    ]) {
      expect(() => projectStopSnapshotDigestMaterial("prj:plan-test", [], { sha256 })).toThrowError(expect.objectContaining({
        code: "PLAN_VALIDATION_REFUSED",
        ruleId: "plan.proposal.digest-mismatch",
        path: "planStore",
      }));
    }
  });
});
