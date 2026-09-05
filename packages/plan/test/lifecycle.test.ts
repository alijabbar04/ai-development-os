import { describe, expect, it } from "vitest";
import {
  PLAN_ASSEMBLY_MACHINE,
  PLAN_ASSEMBLY_STATES,
  PLAN_ASSEMBLY_SYMBOLS,
  applyPlanCommitOutcome,
  applyPlanObservationOutcome,
  assertAcyclicPlanChain,
  assertRebasedPlanLineage,
  beginPlanWrite,
  promoteDraft,
  sealProposedPlan,
  transitionPlanAssembly,
  type PlanAssemblySession,
  type PlanCommitRequest,
  type PlanWriteOperation,
} from "../src/index.js";
import { assembled } from "./fixtures.js";

const request = Object.freeze({}) as PlanCommitRequest;

describe("M-1b/M-2..M-23 lifecycle hosts and recovery", () => {
  it("executes all 107 legal cells as well as refusing all 418 null cells", () => {
    let legal = 0;
    let illegal = 0;
    for (const state of PLAN_ASSEMBLY_STATES) {
      for (const symbol of PLAN_ASSEMBLY_SYMBOLS) {
        const expected = PLAN_ASSEMBLY_MACHINE[state][symbol];
        if (expected === null) {
          illegal += 1;
          expect(() => transitionPlanAssembly(state, symbol)).toThrow();
        } else {
          legal += 1;
          expect(transitionPlanAssembly(state, symbol)).toBe(expected);
        }
      }
    }
    expect({ legal, illegal }).toEqual({ legal: 107, illegal: 418 });
  });

  it("binds every write operation to its exact origin, host, and observation surface", () => {
    const cases = [
      ["review-required", "commit-draft", "first-draft", "writing-from-review", "head"],
      ["review-required", "commit-draft", "redraft", "writing-from-review", "head"],
      ["review-required", "seal", "seal", "sealing-from-review", "head"],
      ["committed", "seal", "seal", "sealing-from-committed", "head"],
      ["review-required", "abandon", "abandon", "abandoning-from-review", "head"],
      ["committed", "abandon", "abandoning-from-committed"],
      ["source-brief-stale", "discard", "discard-stale", "superseding-from-stale", "head"],
      ["review-required", "record-decision", "budget-extension", "advancing-from-review", "journal"],
      ["committed", "record-decision", "budget-extension", "advancing-from-committed", "journal"],
      ["review-required", "promote", "promote", "advancing-from-review", "head"],
      ["committed", "promote", "promote", "advancing-from-committed", "head"],
      ["review-required", "record-decision", "scope-rejected", "advancing-from-review", "head"],
      ["committed", "record-decision", "revision-r1", "advancing-from-committed", "head"],
      ["committed", "record-decision", "revision-r2", "advancing-from-committed", "head"],
    ] as const;
    for (const row of cases) {
      const [state, symbol, operation] = row;
      const expectedHost = row.length === 3 ? row[2] : row[3];
      const expectedObservation = row.length === 3 ? "head" : row[4];
      const actualOperation = row.length === 3 ? "abandon" : operation;
      const result = beginPlanWrite({ state, pending: null }, symbol as never, actualOperation as PlanWriteOperation, request);
      expect(result.state).toBe(expectedHost);
      expect(result.pending).toMatchObject({ operation: actualOperation, observationKind: expectedObservation });
    }
    expect(() => beginPlanWrite({ state: "review-required", pending: null }, "seal", "promote", request)).toThrow();
  });

  it("maps all direct outcomes and preserves immutable pending context only for ambiguity", () => {
    const start = beginPlanWrite({ state: "review-required", pending: null }, "commit-draft", "first-draft", request);
    expect(applyPlanCommitOutcome(start, { kind: "committed", aggregateVersion: 1, evidence: "receipt" })).toEqual({ state: "committed", pending: null });
    expect(applyPlanCommitOutcome(start, { kind: "conflict", actualVersion: 1 })).toEqual({ state: "persistence-conflict", pending: null });
    const unknown = applyPlanCommitOutcome(start, { kind: "unknown" });
    expect(unknown.state).toBe("write-outcome-unknown-to-review");
    expect(unknown.pending).toBe(start.pending);
    expect(applyPlanCommitOutcome(start, { kind: "refused", code: "PLAN_VALIDATION_REFUSED", ruleId: "plan.proposal.malformed" })).toEqual({ state: "review-required", pending: null });
    expect(applyPlanCommitOutcome(start, { kind: "refused", code: "PLAN_PRECONDITION_REFUSED", ruleId: "plan.brief.superseded" })).toEqual({ state: "source-brief-stale", pending: null });
    expect(applyPlanCommitOutcome(start, { kind: "refused", code: "PLAN_STORE_CORRUPT", ruleId: "plan.brief.content-digest-mismatch" })).toEqual({ state: "source-brief-corrupt", pending: null });
    expect(applyPlanCommitOutcome(start, { kind: "refused", code: "PLAN_STORE_CORRUPT", ruleId: "plan.brief.acceptance-proof-invalid" })).toEqual({ state: "source-brief-corrupt", pending: null });
    expect(applyPlanCommitOutcome(start, { kind: "not-attempted", reason: "brief-evidence-unresolved", ruleId: "plan.store.unresolved" })).toEqual({ state: "review-required", pending: null });
    expect(() => applyPlanCommitOutcome({ state: "review-required", pending: null }, { kind: "unknown" })).toThrow();
  });

  it("maps read-only observation outcomes back to each retained origin without writes", () => {
    for (const [origin, state, returned] of [
      ["review-required", "write-outcome-unknown-to-review", "review-required"],
      ["committed", "write-outcome-unknown-to-committed", "committed"],
      ["source-brief-stale", "write-outcome-unknown-to-stale", "source-brief-stale"],
    ] as const) {
      const session: PlanAssemblySession = {
        state,
        pending: { operation: origin === "source-brief-stale" ? "discard-stale" : "promote", origin, observationKind: "head", request },
      };
      expect(applyPlanObservationOutcome(session, { kind: "not-recorded", aggregateVersion: 1 })).toEqual({ state: returned, pending: null });
      expect(applyPlanObservationOutcome(session, { kind: "committed", aggregateVersion: 2, evidence: "head-observation" })).toEqual({ state: "committed", pending: null });
      expect(applyPlanObservationOutcome(session, { kind: "conflict", actualVersion: 2 })).toEqual({ state: "persistence-conflict", pending: null });
      const unknown = applyPlanObservationOutcome(session, { kind: "unknown" });
      expect(unknown.state).toBe(state);
      expect(unknown.pending).toBe(session.pending);
    }
    expect(() => applyPlanObservationOutcome({ state: "committed", pending: null }, { kind: "unknown" })).toThrow();
    expect(() => applyPlanObservationOutcome({
      state: "write-outcome-unknown-to-review",
      pending: { operation: "promote", origin: "committed", observationKind: "head", request },
    }, { kind: "unknown" })).toThrow();
  });

  it("accepts acyclic revision chains and refuses duplicates, self-links, and longer cycles", () => {
    const base = assembled().plan;
    const second = { ...base, planId: "pln:second", revision: 2, supersedes: base.planId };
    const third = { ...base, planId: "pln:third", revision: 3, supersedes: second.planId };
    expect(() => assertAcyclicPlanChain([base, second, third])).not.toThrow();
    expect(() => assertAcyclicPlanChain([base, base])).toThrow();
    expect(() => assertAcyclicPlanChain([{ ...base, supersedes: base.planId }])).toThrow();
    expect(() => assertAcyclicPlanChain([
      { ...base, planId: "pln:a", supersedes: "pln:c" },
      { ...base, planId: "pln:b", supersedes: "pln:a" },
      { ...base, planId: "pln:c", supersedes: "pln:b" },
    ])).toThrow();
    expect(() => assertAcyclicPlanChain([
      { plan: { ...base, planId: "pln:a", supersedes: null }, rebase: null, predecessor: { planId: "pln:b", revision: 1, supersedes: null, state: "drafting", planDigest: base.planDigest, sealedAt: null, sealedByApprovalId: null } },
      { plan: { ...base, planId: "pln:b", supersedes: null }, rebase: { kind: "plan.rebased", replaces: "pln:a", replacesRevision: 1, previousDisposition: { kind: "draft-replaced", from: "drafting" }, projectId: base.projectId, briefId: base.briefId, briefAggregateVersion: 2, briefContentDigest: "a".repeat(64), acceptedCandidateDigest: "b".repeat(64), acceptanceEventId: "intake:two" }, predecessor: null },
    ])).toThrow();
  });

  it("normalizes invalid lifecycle timestamps to finite typed state refusals", () => {
    const draft = assembled().plan;
    expect(() => promoteDraft(draft, "not-a-timestamp", false)).toThrowError(expect.objectContaining({
      code: "PLAN_PRECONDITION_REFUSED",
      ruleId: "plan.state.illegal",
      path: "plan",
    }));
    const proposed = promoteDraft(draft, draft.updatedAt, false)[0]!;
    expect(() => sealProposedPlan(proposed, "not-a-timestamp")).toThrowError(expect.objectContaining({
      code: "PLAN_PRECONDITION_REFUSED",
      ruleId: "plan.state.illegal",
      path: "planSeal",
    }));
  });

  it("proves R2 as a later-brief revision-1 replacement with exact link and monotonic time", () => {
    const previous = assembled().plan;
    const previousAccepted = {
      projectId: previous.projectId,
      briefId: previous.briefId,
      briefAggregateVersion: 1,
      briefContentDigest: "a".repeat(64),
      acceptedCandidateDigest: "b".repeat(64),
      acceptanceEventId: "intake:one",
    } as const;
    const nextAccepted = {
      ...previousAccepted,
      briefId: "brf:later",
      briefAggregateVersion: 2,
      briefContentDigest: "c".repeat(64),
      acceptedCandidateDigest: "d".repeat(64),
      acceptanceEventId: "intake:two",
    } as const;
    const next = {
      ...previous,
      planId: "pln:later",
      briefId: nextAccepted.briefId,
      revision: 1,
      supersedes: null,
      createdAt: "2026-09-04T10:01:00.000Z",
      updatedAt: "2026-09-04T10:01:00.000Z",
    };
    const link = {
      kind: "plan.rebased",
      replaces: previous.planId,
      replacesRevision: previous.revision,
      previousDisposition: { kind: "draft-replaced", from: "drafting" },
      ...nextAccepted,
    } as const;
    expect(() => assertRebasedPlanLineage(previous, next, previousAccepted, nextAccepted, link)).not.toThrow();
    expect(() => assertRebasedPlanLineage(previous, { ...next, createdAt: "2026-09-04T09:59:00.000Z" }, previousAccepted, nextAccepted, link)).toThrow();
    expect(() => assertRebasedPlanLineage(previous, next, previousAccepted, { ...nextAccepted, briefAggregateVersion: 1 }, link)).toThrow();
    expect(() => assertRebasedPlanLineage(previous, next, previousAccepted, nextAccepted, { ...link, replacesRevision: 2 })).toThrow();
  });
});
