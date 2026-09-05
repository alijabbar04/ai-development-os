export const PLAN_SCHEMA_VERSION = 1 as const;
export const PLAN_PRODUCTION_ENABLED = false as const;
export const PLAN_RUNTIME_CAPABILITIES = Object.freeze([] as const);
export const PLAN_AVAILABLE_COMMANDS = Object.freeze([] as const);

export const PLAN_LIMITS = Object.freeze({
  maxStages: 64,
  maxTasks: 512,
  maxTasksPerStage: 64,
  maxDependencies: 1_024,
  maxDepth: 32,
  maxFanIn: 32,
  maxFanOut: 32,
  maxEventBytes: 10_000_000,
  maxJournalEvents: 4_096,
  journalPageSize: 128,
});

// Keep the compile-time half of SP-9 independent of a runtime task-graph
// dependency. The static-policy test correlates these ceilings with the real
// C6 and task-graph sources, while these assertions make any local increase a
// type error before that test can run.
type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type Characters<Value extends string, Result extends readonly Digit[] = readonly []> =
  Value extends `${infer Head extends Digit}${infer Tail}`
    ? Characters<Tail, readonly [...Result, Head]>
    : Result;
type Shorter<Left extends readonly unknown[], Right extends readonly unknown[]> =
  Left extends readonly []
    ? Right extends readonly [] ? false : true
    : Right extends readonly []
      ? false
      : Left extends readonly [unknown, ...infer LeftTail]
        ? Right extends readonly [unknown, ...infer RightTail]
          ? Shorter<LeftTail, RightTail>
          : false
        : false;
type SameLength<Left extends readonly unknown[], Right extends readonly unknown[]> =
  Left extends readonly []
    ? Right extends readonly [] ? true : false
    : Right extends readonly []
      ? false
      : Left extends readonly [unknown, ...infer LeftTail]
        ? Right extends readonly [unknown, ...infer RightTail]
          ? SameLength<LeftTail, RightTail>
          : false
        : false;
type DigitRank<Value extends Digit> = Value extends "0" ? readonly []
  : Value extends "1" ? readonly [0]
    : Value extends "2" ? readonly [0, 0]
      : Value extends "3" ? readonly [0, 0, 0]
        : Value extends "4" ? readonly [0, 0, 0, 0]
          : Value extends "5" ? readonly [0, 0, 0, 0, 0]
            : Value extends "6" ? readonly [0, 0, 0, 0, 0, 0]
              : Value extends "7" ? readonly [0, 0, 0, 0, 0, 0, 0]
                : Value extends "8" ? readonly [0, 0, 0, 0, 0, 0, 0, 0]
                  : readonly [0, 0, 0, 0, 0, 0, 0, 0, 0];
type EqualLengthDecimalLessOrEqual<
  Left extends readonly Digit[],
  Right extends readonly Digit[],
> = Left extends readonly [infer LeftHead extends Digit, ...infer LeftTail extends readonly Digit[]]
  ? Right extends readonly [infer RightHead extends Digit, ...infer RightTail extends readonly Digit[]]
    ? LeftHead extends RightHead
      ? EqualLengthDecimalLessOrEqual<LeftTail, RightTail>
      : Shorter<DigitRank<LeftHead>, DigitRank<RightHead>>
    : false
  : true;
type DecimalLessOrEqual<Left extends number, Right extends number> =
  Characters<`${Left}`> extends infer LeftDigits extends readonly Digit[]
    ? Characters<`${Right}`> extends infer RightDigits extends readonly Digit[]
      ? SameLength<LeftDigits, RightDigits> extends true
        ? EqualLengthDecimalLessOrEqual<LeftDigits, RightDigits>
        : Shorter<LeftDigits, RightDigits>
      : false
    : false;
type AssertTrue<Value extends true> = Value;
type _PlanLimitCompileTimeChecks = readonly [
  AssertTrue<DecimalLessOrEqual<typeof PLAN_LIMITS.maxStages, 1_024>>,
  AssertTrue<DecimalLessOrEqual<typeof PLAN_LIMITS.maxTasks, 1_024>>,
  AssertTrue<DecimalLessOrEqual<typeof PLAN_LIMITS.maxTasksPerStage, 1_024>>,
  AssertTrue<DecimalLessOrEqual<typeof PLAN_LIMITS.maxDependencies, 1_024>>,
  AssertTrue<DecimalLessOrEqual<typeof PLAN_LIMITS.maxDepth, 1_024>>,
  AssertTrue<DecimalLessOrEqual<typeof PLAN_LIMITS.maxFanIn, 1_024>>,
  AssertTrue<DecimalLessOrEqual<typeof PLAN_LIMITS.maxFanOut, 1_024>>,
  AssertTrue<DecimalLessOrEqual<typeof PLAN_LIMITS.maxTasks, 10_000>>,
  AssertTrue<DecimalLessOrEqual<typeof PLAN_LIMITS.maxDepth, 128>>,
  AssertTrue<DecimalLessOrEqual<typeof PLAN_LIMITS.maxDependencies, 100_000>>,
  AssertTrue<DecimalLessOrEqual<typeof PLAN_LIMITS.maxFanIn, 256>>,
  AssertTrue<DecimalLessOrEqual<typeof PLAN_LIMITS.maxFanOut, 256>>,
];

export const PLAN_FIXED_RETRY = Object.freeze({
  maximumAttempts: 1,
  initialBackoffMs: 0,
  maximumBackoffMs: 0,
  retryableFailures: Object.freeze([] as const),
});

export const PLAN_FIXED_TIMEOUT = Object.freeze({ dispatchMs: 1, attemptMs: 1 });
export const PLAN_FIXED_HANDOVER = Object.freeze({
  requires: "none" as const,
  acceptFrom: Object.freeze([] as const),
  maximumAgeMs: null,
});

export const EXECUTABLE_DISPOSITIONS = Object.freeze([
  "required", "expected-quality", "delight-candidate",
] as const);

export const SCOPE_DISPOSITIONS = Object.freeze([
  "required", "expected-quality", "delight-candidate", "deferred", "rejected",
  "duplicate", "superseded", "blocked", "waived",
] as const);

export const SCOPE_AUTHORITIES = Object.freeze([
  "operator", "product-owner", "security-reviewer", "deterministic-rule",
] as const);

export const CONSTRAINT_DISPOSITIONS = Object.freeze([
  "satisfied-by-design", "enforced-by-task", "waived-by-decision", "not-applicable",
] as const);

export const PLAN_EVENT_TYPES = Object.freeze([
  "plan.drafted", "plan.proposed", "plan.scope-approval-required",
  "plan.scope-rejected", "plan.sealed", "plan.revised", "plan.superseded",
  "plan.abandoned", "plan.budget-extended",
] as const);

export const C9_DRIVEN_PLAN_CELLS = Object.freeze([
  Object.freeze({ from: "drafting", event: "validation-passed", to: "proposed" }),
  Object.freeze({ from: "proposed", event: "scope-approval-required", to: "awaiting_scope_approval" }),
  Object.freeze({ from: "awaiting_scope_approval", event: "scope-rejected", to: "rejected" }),
  Object.freeze({ from: "proposed", event: "seal", to: "sealed" }),
  Object.freeze({ from: "proposed", event: "draft-new-revision", to: "superseded" }),
  Object.freeze({ from: "sealed", event: "seal-new-revision", to: "superseded" }),
  Object.freeze({ from: "drafting", event: "abandon", to: "abandoned" }),
] as const);

export const PLAN_RULE_IDS = Object.freeze([
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
] as const);

export type PlanRuleId = (typeof PLAN_RULE_IDS)[number];
export type ScopeDisposition = (typeof SCOPE_DISPOSITIONS)[number];
export type ScopeAuthority = (typeof SCOPE_AUTHORITIES)[number];
export type ConstraintDispositionKind = (typeof CONSTRAINT_DISPOSITIONS)[number];
export type PlanEventType = (typeof PLAN_EVENT_TYPES)[number];
