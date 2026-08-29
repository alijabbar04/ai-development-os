import type {
  AgentRunState, ApprovalState, Blocker, BlockerKind, PlanState, Project,
  PlanStateDisplayWord, ProjectHealthProjection, ProjectPlan, ProjectSummaryProjection, ProjectTaskState,
  ProjectStop, SessionState,
} from "./contracts.js";
import type { RunStatus } from "@ai-dev-os/scheduler";
import { parseProjectHealthProjection, parseProjectSummaryProjection } from "./parsers.js";
import { refuse } from "./errors.js";
import { enumValue, exact, record } from "./validation.js";

function assertNever(value: never): never {
  return refuse("INVARIANT_VIOLATION", "projection", "A closed project union was not handled.");
}

export interface TaskRunProjectionFacts {
  readonly taskState: ProjectTaskState;
  readonly blockerKind: BlockerKind | null;
  readonly liveRunState?: AgentRunState | null;
  readonly dispatchState?: "prepared" | "started" | "terminal" | null;
}

export function projectTaskRunStatus(facts: TaskRunProjectionFacts): RunStatus {
  switch (facts.taskState) {
    case "pending": return "new";
    case "ready": return "queued";
    case "running":
      return facts.liveRunState === "leased" && facts.dispatchState === "prepared" ? "dispatched" : "running";
    case "needs_resolution": return "running";
    case "succeeded": return "completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "blocked": return "policy-blocked";
    case "waiting":
      return waitingRunStatus(facts.blockerKind);
    default: return assertNever(facts.taskState);
  }
}

function waitingRunStatus(blocker: BlockerKind | null): RunStatus {
  if (blocker === null) return "retry-wait";
  switch (blocker) {
    case "awaiting-approval": case "awaiting-clarification": case "awaiting-spending-decision":
      return "awaiting-approval";
    case "usage-capped": case "usage-stale": case "provider-unavailable": case "operator-paused":
      return "retry-wait";
    case "dependency-failed": case "policy-denied": case "production-refused":
    case "workspace-conflict": case "budget-exhausted": case "emergency-stop":
      return "policy-blocked";
    default: return assertNever(blocker);
  }
}

export const SESSION_DISPLAY_STATES = Object.freeze([
  "starting", "working", "waiting-for-you", "blocked", "rate-limited",
  "paused-by-policy", "waiting-for-fresh-usage", "paused-by-you", "queued",
  "stopping", "did-not-confirm-stop", "stopped", "lost", "recovered-by-restart",
  "could-not-start", "complete", "failed", "archived",
] as const);
export type SessionDisplayState = (typeof SESSION_DISPLAY_STATES)[number];

export type AllocationOutcome =
  | { readonly kind: "reserved" }
  | { readonly kind: "wait"; readonly reason: "five-hour-window-reset" | "weekly-window-reset" | "work-hours-window-close" | "provider-circuit-open" | "capacity-pool-full" | "usage-refresh-pending" }
  | { readonly kind: "reroute" }
  | { readonly kind: "ask" }
  | { readonly kind: "refuse" };

export interface SessionDisplayFacts {
  readonly runState: AgentRunState | null;
  readonly sessionState: SessionState | null;
  readonly blockerKind: BlockerKind | null;
  readonly allocationOutcome: AllocationOutcome | null;
  readonly resumable: boolean;
  readonly recoveryOutcome: "recovered" | "unresolved" | null;
}

export function deriveSessionDisplayState(facts: SessionDisplayFacts): SessionDisplayState {
  if (facts.sessionState === null) {
    switch (facts.runState) {
      case "succeeded": return "complete";
      case "failed": return "failed";
      case "cancelled": case "abandoned": return "stopped";
      case "leased": case "running": case null: return "queued";
      default: return assertNever(facts.runState);
    }
  }
  switch (facts.sessionState) {
    case "requested": case "preparing": case "starting": return "starting";
    case "failed": return "could-not-start";
    case "awaiting_input": return "waiting-for-you";
    case "stopping": return "stopping";
    case "termination_unconfirmed": return "did-not-confirm-stop";
    case "lost": return "lost";
    case "orphaned": return facts.recoveryOutcome === "recovered" ? "recovered-by-restart" : "lost";
    case "archived": return "archived";
    case "stopped":
      if (facts.runState === "succeeded") return "complete";
      if (facts.runState === "failed") return "failed";
      return facts.resumable && facts.blockerKind === "operator-paused" ? "paused-by-you" : "stopped";
    case "running": return runningSessionDisplay(facts);
    default: return assertNever(facts.sessionState);
  }
}

function runningSessionDisplay(facts: SessionDisplayFacts): SessionDisplayState {
  switch (facts.blockerKind) {
    case "awaiting-clarification": case "awaiting-approval": case "awaiting-spending-decision": return "waiting-for-you";
    case "policy-denied": case "dependency-failed": case "workspace-conflict": case "production-refused":
    case "budget-exhausted": case "emergency-stop": return "blocked";
    case "usage-stale": return "waiting-for-fresh-usage";
    case "usage-capped":
      if (facts.allocationOutcome?.kind === "wait" && facts.allocationOutcome.reason === "usage-refresh-pending") return "waiting-for-fresh-usage";
      return "paused-by-policy";
    case "provider-unavailable": return "rate-limited";
    case "operator-paused": return "paused-by-you";
    case null: break;
    default: return assertNever(facts.blockerKind);
  }
  const outcome = facts.allocationOutcome;
  if (outcome === null || outcome.kind === "reserved" || outcome.kind === "reroute") return "working";
  switch (outcome.kind) {
    case "ask": return "waiting-for-you";
    case "refuse": return "blocked";
    case "wait":
      switch (outcome.reason) {
        case "provider-circuit-open": case "capacity-pool-full": return "rate-limited";
        case "usage-refresh-pending": return "waiting-for-fresh-usage";
        case "five-hour-window-reset": case "weekly-window-reset": case "work-hours-window-close": return "paused-by-policy";
        default: return assertNever(outcome.reason);
      }
    default: return assertNever(outcome);
  }
}

export const APPROVAL_DISPLAY_STATES = Object.freeze([
  "needs-you", "approved-waiting", "used-once", "used-n-of-N", "standing",
  "revoked", "rejected", "expired-nothing-happened", "voided-by-stop-nothing-happened",
  "mismatched-nothing-happened", "failed-closed-nothing-happened", "outcome-unknown",
] as const);
export type ApprovalDisplayState = (typeof APPROVAL_DISPLAY_STATES)[number];
export type ApprovalConsumptionOutcome = "none" | "digest-mismatch" | "failed-closed" | "effect-outcome-unknown";

export function approvalStateDisplayWord(
  state: ApprovalState,
  usage: "one-shot" | "bounded-recurring" | "standing-revocable",
  outcome: ApprovalConsumptionOutcome = "none",
): ApprovalDisplayState {
  if (outcome === "digest-mismatch") return "mismatched-nothing-happened";
  if (outcome === "failed-closed") return "failed-closed-nothing-happened";
  if (outcome === "effect-outcome-unknown") return "outcome-unknown";
  switch (state) {
    case "requested": return "needs-you";
    case "approved": return usage === "standing-revocable" ? "standing" : "approved-waiting";
    case "consumed": return "used-once";
    case "partially_consumed": return "used-n-of-N";
    case "revoked": return "revoked";
    case "rejected": return "rejected";
    case "expired": return "expired-nothing-happened";
    case "voided": return "voided-by-stop-nothing-happened";
    default: return assertNever(state);
  }
}

export const PLAN_STATE_WORDS = Object.freeze({
  drafting: "Describing", clarifying: "Needs your decisions", proposed: "Ready to review",
  awaiting_scope_approval: "Needs your approval to start",
  rejected: "Not admitted — revise the brief or the scope", sealed: "Ready to start",
  executing: "Running", expanding: "Reviewing a change",
  stage_gate: "At a checkpoint — your review", halted: "Stopped",
  completed: "Completed", abandoned: "Abandoned", superseded: "Superseded",
} satisfies Readonly<Record<PlanState, PlanStateDisplayWord>>);

export function planStateDisplayWord(state: PlanState): string {
  switch (state) {
    case "drafting": case "clarifying": case "proposed": case "awaiting_scope_approval":
    case "rejected": case "sealed": case "executing": case "expanding": case "stage_gate":
    case "halted": case "completed": case "abandoned": case "superseded": return PLAN_STATE_WORDS[state];
    default: return assertNever(state);
  }
}

export const USAGE_DISPLAY_STATES = Object.freeze(["active", "inactive", "stale", "unavailable", "ambiguous", "reset-passed"] as const);
export type UsageDisplayState = (typeof USAGE_DISPLAY_STATES)[number];
export const USAGE_FRESHNESS_RULE_IDS = Object.freeze([
  "usage.schema-v3.required", "usage.authority.required", "usage.authorization.required",
  "usage.revocation.refused", "usage.future.refused", "usage.stale.refused",
  "usage.source-freshness.expired", "usage.window.inactive", "usage.reset.invalid",
  "usage.window.expired", "usage.snapshot.exactly-one",
] as const);

export interface UsageDisplayFacts {
  readonly fiveHourStatus: "active" | "inactive" | "stale" | "unavailable";
  readonly weeklyStatus: "active" | "inactive" | "stale" | "unavailable";
  readonly authorization: "authorized" | "unauthorized" | "ambiguous";
  readonly revocation: "not-revoked" | "revoked" | "unknown";
  readonly ruleIds: readonly string[];
  readonly failureCode: string | null;
}

export function deriveUsageDisplayState(facts: UsageDisplayFacts): UsageDisplayState {
  const rules = new Set(facts.ruleIds);
  if (facts.failureCode !== null || facts.fiveHourStatus === "unavailable" || facts.weeklyStatus === "unavailable" || facts.authorization === "unauthorized" || facts.revocation === "revoked" || rules.has("usage.future.refused") || rules.has("usage.reset.invalid") || rules.has("usage.schema-v3.required")) return "unavailable";
  if (facts.authorization === "ambiguous" || facts.revocation === "unknown" || rules.has("usage.authorization.required") || rules.has("usage.revocation.refused") || rules.has("usage.snapshot.exactly-one") || rules.has("usage.authority.required")) return "ambiguous";
  if (facts.fiveHourStatus === "stale" || facts.weeklyStatus === "stale" || rules.has("usage.stale.refused") || rules.has("usage.source-freshness.expired")) return "stale";
  if (rules.has("usage.window.expired")) return "reset-passed";
  if (facts.fiveHourStatus === "inactive" || facts.weeklyStatus === "inactive" || rules.has("usage.window.inactive")) return "inactive";
  return "active";
}

export interface ProjectHealthInput {
  readonly plan: ProjectPlan | null;
  readonly blockers: readonly Blocker[];
  readonly coverage: ProjectHealthProjection["coverage"];
  readonly budget: ProjectHealthProjection["budget"];
  readonly capacity: ProjectHealthProjection["capacity"];
  readonly computedAt: string;
  readonly sourceSequence: number;
  readonly confidence: "current" | "stale";
  readonly staleReason: string | null;
  readonly projectId: string;
}

export function deriveProjectHealthProjection(input: ProjectHealthInput): ProjectHealthProjection {
  const tasks = input.plan?.tasks ?? [];
  const openBlockers = input.blockers.filter((blocker) => blocker.state === "open");
  return parseProjectHealthProjection({
    schemaVersion: 1,
    projectId: input.projectId,
    computedAt: input.computedAt,
    sourceSequence: input.sourceSequence,
    planState: input.plan?.state ?? null,
    stageProgress: (input.plan?.stages ?? []).map((stage) => {
      const stageTasks = tasks.filter((task) => task.stageId === stage.stageId);
      return { stageId: stage.stageId, done: stageTasks.filter((task) => task.state === "succeeded").length, total: stageTasks.length, gate: stage.gate };
    }),
    counts: {
      running: tasks.filter((task) => task.state === "running" || task.state === "needs_resolution").length,
      queued: tasks.filter((task) => task.state === "ready").length,
      blocked: tasks.filter((task) => task.state === "blocked").length,
      awaitingApproval: openBlockers.filter((blocker) => blocker.kind === "awaiting-approval" || blocker.kind === "awaiting-spending-decision").length,
      failed: tasks.filter((task) => task.state === "failed").length,
      completed: tasks.filter((task) => task.state === "succeeded").length,
    },
    openBlockers: openBlockers.map((blocker) => ({ blockerId: blocker.blockerId, kind: blocker.kind, operatorActionable: blocker.operatorActionable })),
    coverage: input.coverage,
    budget: input.budget,
    capacity: input.capacity,
    confidence: input.confidence,
    staleReason: input.staleReason,
  });
}

export interface ProjectSummaryInput {
  readonly project: Project;
  readonly plan: ProjectPlan | null;
  readonly projectStop: ProjectStop | null;
  readonly health: ProjectHealthProjection;
  readonly nextMilestone: ProjectSummaryProjection["nextMilestone"];
  readonly needsYou: ProjectSummaryProjection["needsYou"];
  readonly usage: ProjectSummaryProjection["usage"];
  readonly capacity: ProjectSummaryProjection["capacity"];
}

export function deriveProjectSummaryProjection(input: ProjectSummaryInput): ProjectSummaryProjection {
  if (input.project.projectId !== input.health.projectId || input.plan !== null && input.plan.projectId !== input.project.projectId || input.projectStop !== null && input.projectStop.projectId !== input.project.projectId) {
    return refuse("REFERENCE_INCONSISTENT", "projectSummary", "Projection sources belong to different projects.");
  }
  const tasks = input.plan?.tasks ?? [];
  const currentStage = input.plan?.stages.find((stage) => stage.taskIds.some((taskId) => tasks.find((task) => task.taskId === taskId)?.state !== "succeeded")) ?? null;
  return parseProjectSummaryProjection({
    schemaVersion: 1,
    projectId: input.project.projectId,
    displayName: input.project.displayName,
    status: input.projectStop !== null && input.projectStop.resumedAt === null ? "stopped" : input.project.status,
    planState: input.plan === null ? null : planStateDisplayWord(input.plan.state),
    currentStage: currentStage === null ? null : { ordinal: currentStage.ordinal, title: currentStage.title, gate: currentStage.gate },
    nextMilestone: input.nextMilestone,
    counts: {
      running: input.health.counts.running,
      waiting: tasks.filter((task) => task.state === "waiting").length,
      blocked: input.health.counts.blocked,
      awaitingApproval: input.health.counts.awaitingApproval,
      queued: input.health.counts.queued,
      done: input.health.counts.completed,
      total: tasks.length,
    },
    needsYou: input.needsYou,
    usage: input.usage,
    capacity: input.capacity,
    confidence: input.health.confidence,
    sourceSequence: input.health.sourceSequence,
    computedAt: input.health.computedAt,
  });
}

export type PresentationMode = "normal" | "developer";

export type ProjectProjectionSubject =
  | Readonly<{ kind: "health"; value: ProjectHealthProjection }>
  | Readonly<{ kind: "summary"; value: ProjectSummaryProjection }>;

export interface NormalProjectHealthProjection {
  readonly projectId: string;
  readonly planState: PlanState | null;
  readonly stageProgress: readonly Readonly<{ done: number; total: number; gate: "automatic" | "operator-review" }>[];
  readonly counts: ProjectHealthProjection["counts"];
  readonly openBlockers: readonly Readonly<{ kind: BlockerKind; operatorActionable: boolean }>[];
  readonly coverage: ProjectHealthProjection["coverage"];
  readonly budget: ProjectHealthProjection["budget"];
  readonly capacity: readonly Readonly<{
    windowStatus: "active" | "inactive" | "stale" | "unavailable";
    headroomBasisPoints: number | null;
  }>[];
  readonly confidence: "current" | "stale";
  readonly computedAt: string;
}

export interface NormalProjectSummaryProjection {
  readonly projectId: string;
  readonly displayName: string;
  readonly status: ProjectSummaryProjection["status"];
  readonly planState: PlanStateDisplayWord | null;
  readonly currentStage: ProjectSummaryProjection["currentStage"];
  readonly nextMilestone: ProjectSummaryProjection["nextMilestone"];
  readonly counts: ProjectSummaryProjection["counts"];
  readonly needsYou: ProjectSummaryProjection["needsYou"];
  readonly usage: ProjectSummaryProjection["usage"];
  readonly capacity: readonly Readonly<{
    alias: string;
    ownership: "owned" | "authorized-borrowed";
    windowStatus: "active" | "inactive" | "stale" | "unavailable";
    eligible: boolean;
    resetAt: string | null;
  }>[];
  readonly confidence: "current" | "stale";
  readonly sourceSequence: number;
  readonly computedAt: string;
}

export type ProjectPresentation =
  | Readonly<{ mode: "normal"; kind: "health"; authority: "none"; commands: readonly []; value: NormalProjectHealthProjection }>
  | Readonly<{ mode: "normal"; kind: "summary"; authority: "none"; commands: readonly []; value: NormalProjectSummaryProjection }>
  | Readonly<{ mode: "developer"; kind: "health"; authority: "none"; commands: readonly []; value: ProjectHealthProjection }>
  | Readonly<{ mode: "developer"; kind: "summary"; authority: "none"; commands: readonly []; value: ProjectSummaryProjection }>;

const EMPTY_COMMANDS = Object.freeze([]) as readonly [];

function freezeHealthNormal(value: ProjectHealthProjection): NormalProjectHealthProjection {
  return Object.freeze({
    projectId: value.projectId,
    planState: value.planState,
    stageProgress: Object.freeze(value.stageProgress.map((entry) => Object.freeze({ done: entry.done, total: entry.total, gate: entry.gate }))),
    counts: Object.freeze({ ...value.counts }),
    openBlockers: Object.freeze(value.openBlockers.map((entry) => Object.freeze({ kind: entry.kind, operatorActionable: entry.operatorActionable }))),
    coverage: value.coverage === null ? null : Object.freeze({
      required: Object.freeze({ ...value.coverage.required }),
      expectedQuality: Object.freeze({ ...value.coverage.expectedQuality }),
    }),
    budget: Object.freeze({ ...value.budget }),
    capacity: Object.freeze(value.capacity.map((entry) => Object.freeze({ windowStatus: entry.windowStatus, headroomBasisPoints: entry.headroomBasisPoints }))),
    confidence: value.confidence,
    computedAt: value.computedAt,
  });
}

function freezeSummaryNormal(value: ProjectSummaryProjection): NormalProjectSummaryProjection {
  return Object.freeze({
    projectId: value.projectId,
    displayName: value.displayName,
    status: value.status,
    planState: value.planState,
    currentStage: value.currentStage === null ? null : Object.freeze({ ...value.currentStage }),
    nextMilestone: value.nextMilestone === null ? null : Object.freeze({ ...value.nextMilestone }),
    counts: Object.freeze({ ...value.counts }),
    needsYou: Object.freeze(value.needsYou.map((entry) => Object.freeze({
      kind: entry.kind,
      title: entry.title,
      expiresAt: entry.expiresAt,
      deepLink: Object.freeze({ route: entry.deepLink.route, params: Object.freeze({ ...entry.deepLink.params }) }) as typeof entry.deepLink,
    }))),
    usage: Object.freeze({ ...value.usage }),
    capacity: Object.freeze(value.capacity.map((entry) => Object.freeze({
      alias: entry.alias,
      ownership: entry.ownership,
      windowStatus: entry.windowStatus,
      eligible: entry.eligible,
      resetAt: entry.resetAt,
    }))),
    confidence: value.confidence,
    sourceSequence: value.sourceSequence,
    computedAt: value.computedAt,
  });
}

/**
 * Exact, recursive presentation boundary. Normal mode is a deliberate product
 * subset; Developer mode returns only a re-parsed canonical projection. Both
 * modes expose the same empty command and authority surfaces.
 */
export function presentProjectProjection(subject: ProjectProjectionSubject, requestedMode: PresentationMode): ProjectPresentation {
  const input = record(subject, "projection");
  exact(input, ["kind", "value"], "projection");
  const kind = enumValue(input["kind"], ["health", "summary"] as const, "projection.kind");
  const mode = enumValue(requestedMode, ["normal", "developer"] as const, "projection.mode");
  if (kind === "health") {
    const value = parseProjectHealthProjection(input["value"]);
    return mode === "normal"
      ? Object.freeze({ mode, kind, authority: "none", commands: EMPTY_COMMANDS, value: freezeHealthNormal(value) })
      : Object.freeze({ mode, kind, authority: "none", commands: EMPTY_COMMANDS, value });
  }
  const value = parseProjectSummaryProjection(input["value"]);
  return mode === "normal"
    ? Object.freeze({ mode, kind, authority: "none", commands: EMPTY_COMMANDS, value: freezeSummaryNormal(value) })
    : Object.freeze({ mode, kind, authority: "none", commands: EMPTY_COMMANDS, value });
}
