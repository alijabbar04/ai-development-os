import { describe, expect, it } from "vitest";
import {
  PLAN_ASSEMBLY_LOCKED_STATES,
  PLAN_ASSEMBLY_MACHINE,
  PLAN_ASSEMBLY_STATES,
  PLAN_ASSEMBLY_SYMBOLS,
  PLAN_AVAILABLE_COMMANDS,
  PLAN_EVENT_TYPES,
  PLAN_LIMITS,
  PLAN_PRODUCTION_ENABLED,
  PLAN_REFUSAL_CODES,
  PLAN_RULE_IDS,
  PLAN_RUNTIME_CAPABILITIES,
  transitionPlanAssembly,
} from "../src/index.js";

const EXPECTED_CODES = [
  "PLAN_VALIDATION_REFUSED", "PLAN_PRECONDITION_REFUSED", "PLAN_BOUND_EXCEEDED",
  "PLAN_SEAL_CONDITION_FAILED", "PLAN_PROVENANCE_REFUSED", "PLAN_AUTHORITY_VIOLATION",
  "PLAN_STORE_CONFLICT", "PLAN_STORE_UNAVAILABLE", "PLAN_STORE_CORRUPT", "PLAN_OUT_OF_SCOPE",
] as const;

const EXPECTED_RULES = [
  "plan.brief.absent", "plan.brief.acceptance-proof-invalid", "plan.brief.blocking-unanswered",
  "plan.brief.content-digest-mismatch", "plan.brief.insufficient", "plan.brief.revision-not-one",
  "plan.brief.superseded", "plan.budget.ceiling-conflict", "plan.budget.sum-exceeds-ceiling",
  "plan.budget.task-exceeds-ceiling", "plan.constraint.machine-form-unrecognised",
  "plan.constraint.no-disposition", "plan.constraint.waiver-unbound",
  "plan.coverage.evidence-insufficient", "plan.coverage.executable-mismatch",
  "plan.coverage.non-executable-covered", "plan.coverage.provenance-inconsistent",
  "plan.coverage.unmapped-task", "plan.coverage.waiver-unbound",
  "plan.decision.budget-extension-shape", "plan.decision.kind-out-of-scope",
  "plan.decision.stale-binding", "plan.event.duplicate-id", "plan.event.too-large",
  "plan.graph.fan-in", "plan.graph.fan-out", "plan.graph.parallel-edge",
  "plan.graph.stage-order-inconsistent", "plan.graph.stage-too-large", "plan.graph.too-deep",
  "plan.graph.too-many-dependencies", "plan.graph.too-many-stages", "plan.graph.too-many-tasks",
  "plan.head.absent", "plan.lineage.cycle", "plan.lineage.not-rebase",
  "plan.lineage.not-successor", "plan.project.mismatch", "plan.project.not-active",
  "plan.project.stopped", "plan.proposal.digest-mismatch", "plan.proposal.malformed",
  "plan.proposal.stale", "plan.proposal.unknown-field", "plan.provenance.ambiguous",
  "plan.provenance.fabricated-observation", "plan.provenance.missing",
  "plan.provenance.model-claims-derivation", "plan.provenance.not-verbatim",
  "plan.provenance.operator-claim-unbacked", "plan.provenance.unknown-path",
  "plan.provenance.unresolved", "plan.revision.stale", "plan.seal.approval-binding",
  "plan.seal.condition-1", "plan.seal.condition-2", "plan.seal.condition-3",
  "plan.seal.condition-4", "plan.seal.condition-5", "plan.seal.condition-6",
  "plan.seal.metadata", "plan.sealed.immutable", "plan.session.illegal-input",
  "plan.size.too-large", "plan.specification.absent", "plan.specification.digest-mismatch",
  "plan.specification.incoherent", "plan.stage.ordinal-not-dense", "plan.state.illegal",
  "plan.state.out-of-scope", "plan.store.conflict", "plan.store.corrupt",
  "plan.store.cursor-invalid", "plan.store.unavailable", "plan.store.unresolved",
  "plan.task.handover-source-unknown", "plan.task.irreversible-unbound",
  "plan.task.not-pending", "plan.task.provider-fact", "plan.text.bidi",
  "plan.text.suspicious-literal",
] as const;

const EXPECTED_LEGAL: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  absent: { "submit-proposal": "validation-required", read: "absent", "load-head": "validation-required" },
  "validation-required": { validate: "validating", cancel: "absent", read: "validation-required" },
  validating: { "validation-passed": "review-required", "validation-failed": "invalid", "brief-moved": "source-brief-stale", "brief-corrupt": "source-brief-corrupt", "brief-evidence-unresolved": "validation-required" },
  invalid: { "submit-proposal": "validation-required", cancel: "absent", read: "invalid" },
  "review-required": { "commit-draft": "writing-from-review", seal: "sealing-from-review", revise: "revision-proposed", abandon: "abandoning-from-review", read: "review-required", promote: "advancing-from-review", "record-decision": "advancing-from-review" },
  "sealing-from-review": { "write-committed": "committed", "write-conflicted": "persistence-conflict", "write-unknown": "write-outcome-unknown-to-review", "write-refused": "review-required", "brief-moved": "source-brief-stale", "brief-corrupt": "source-brief-corrupt", "brief-evidence-unresolved": "review-required" },
  "sealing-from-committed": { "write-committed": "committed", "write-conflicted": "persistence-conflict", "write-unknown": "write-outcome-unknown-to-committed", "write-refused": "committed", "brief-moved": "source-brief-stale", "brief-corrupt": "source-brief-corrupt", "brief-evidence-unresolved": "committed" },
  "writing-from-review": { "write-committed": "committed", "write-conflicted": "persistence-conflict", "write-unknown": "write-outcome-unknown-to-review", "write-refused": "review-required", "brief-moved": "source-brief-stale", "brief-corrupt": "source-brief-corrupt", "brief-evidence-unresolved": "review-required" },
  "abandoning-from-review": { "write-committed": "committed", "write-conflicted": "persistence-conflict", "write-unknown": "write-outcome-unknown-to-review", "write-refused": "review-required" },
  "abandoning-from-committed": { "write-committed": "committed", "write-conflicted": "persistence-conflict", "write-unknown": "write-outcome-unknown-to-committed", "write-refused": "committed" },
  "superseding-from-stale": { "write-committed": "committed", "write-conflicted": "persistence-conflict", "write-unknown": "write-outcome-unknown-to-stale", "write-refused": "source-brief-stale" },
  "advancing-from-review": { "write-committed": "committed", "write-conflicted": "persistence-conflict", "write-unknown": "write-outcome-unknown-to-review", "write-refused": "review-required", "brief-moved": "source-brief-stale", "brief-corrupt": "source-brief-corrupt", "brief-evidence-unresolved": "review-required" },
  "advancing-from-committed": { "write-committed": "committed", "write-conflicted": "persistence-conflict", "write-unknown": "write-outcome-unknown-to-committed", "write-refused": "committed", "brief-moved": "source-brief-stale", "brief-corrupt": "source-brief-corrupt", "brief-evidence-unresolved": "committed" },
  committed: { read: "committed", revise: "revision-proposed", seal: "sealing-from-committed", abandon: "abandoning-from-committed", "record-decision": "advancing-from-committed", promote: "advancing-from-committed" },
  "revision-proposed": { "submit-proposal": "validation-required", "discard-revision": "committed", read: "revision-proposed" },
  "persistence-conflict": { reread: "validation-required", cancel: "absent", read: "persistence-conflict" },
  "write-outcome-unknown-to-review": { reread: "write-outcome-unknown-to-review", read: "write-outcome-unknown-to-review", "write-committed": "committed", "write-not-written": "review-required", "write-conflicted": "persistence-conflict", "write-unknown": "write-outcome-unknown-to-review", cancel: "absent" },
  "write-outcome-unknown-to-committed": { reread: "write-outcome-unknown-to-committed", read: "write-outcome-unknown-to-committed", "write-committed": "committed", "write-not-written": "committed", "write-conflicted": "persistence-conflict", "write-unknown": "write-outcome-unknown-to-committed", cancel: "absent" },
  "write-outcome-unknown-to-stale": { reread: "write-outcome-unknown-to-stale", read: "write-outcome-unknown-to-stale", "write-committed": "committed", "write-not-written": "source-brief-stale", "write-conflicted": "persistence-conflict", "write-unknown": "write-outcome-unknown-to-stale", cancel: "absent" },
  "source-brief-stale": { rebase: "validation-required", discard: "superseding-from-stale", cancel: "absent", read: "source-brief-stale" },
  "source-brief-corrupt": { cancel: "absent", read: "source-brief-corrupt" },
};

describe("B-1..B-19 closed inventories", () => {
  it("pins all ten package codes, all 81 C9 rules, all nine event kinds, and all limits", () => {
    expect(PLAN_REFUSAL_CODES).toEqual(EXPECTED_CODES);
    expect(PLAN_RULE_IDS).toEqual(EXPECTED_RULES);
    expect(new Set(PLAN_RULE_IDS).size).toBe(81);
    expect(PLAN_EVENT_TYPES).toEqual([
      "plan.drafted", "plan.proposed", "plan.scope-approval-required", "plan.scope-rejected",
      "plan.sealed", "plan.revised", "plan.superseded", "plan.abandoned", "plan.budget-extended",
    ]);
    expect(PLAN_LIMITS).toEqual({ maxStages: 64, maxTasks: 512, maxTasksPerStage: 64, maxDependencies: 1024, maxDepth: 32, maxFanIn: 32, maxFanOut: 32, maxEventBytes: 10_000_000, maxJournalEvents: 4096, journalPageSize: 128 });
  });

  it("is production disabled with no commands or runtime capabilities", () => {
    expect(PLAN_PRODUCTION_ENABLED).toBe(false);
    expect(PLAN_AVAILABLE_COMMANDS).toEqual([]);
    expect(PLAN_RUNTIME_CAPABILITIES).toEqual([]);
  });
});

describe("M-1..M-23 exact L2 lifecycle", () => {
  it("is a total 21 by 25 table with exactly 107 legal cells and nine locked states", () => {
    expect(PLAN_ASSEMBLY_STATES).toHaveLength(21);
    expect(PLAN_ASSEMBLY_SYMBOLS).toHaveLength(25);
    expect(PLAN_ASSEMBLY_LOCKED_STATES).toHaveLength(9);
    expect(Object.values(PLAN_ASSEMBLY_MACHINE).flatMap(Object.values)).toHaveLength(525);
    expect(Object.values(PLAN_ASSEMBLY_MACHINE).flatMap(Object.values).filter((cell) => cell !== null)).toHaveLength(107);
    for (const state of PLAN_ASSEMBLY_STATES) {
      for (const symbol of PLAN_ASSEMBLY_SYMBOLS) {
        expect(PLAN_ASSEMBLY_MACHINE[state][symbol]).toBe(EXPECTED_LEGAL[state]?.[symbol] ?? null);
      }
    }
  });

  it("refuses every null cell", () => {
    for (const state of PLAN_ASSEMBLY_STATES) {
      for (const symbol of PLAN_ASSEMBLY_SYMBOLS) {
        if (PLAN_ASSEMBLY_MACHINE[state][symbol] === null) expect(() => transitionPlanAssembly(state, symbol)).toThrow();
      }
    }
  });
});
