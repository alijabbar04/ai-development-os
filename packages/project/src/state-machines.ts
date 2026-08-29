import type {
  AgentRunState, ApprovalState, BlockerState, HandoverState, NotificationDeliveryState,
  PlanState, ProjectStatus, ProjectTask, ProjectTaskState, SessionState, SpendingState,
} from "./contracts.js";
import {
  AGENT_RUN_STATES, APPROVAL_STATES, BLOCKER_STATES, HANDOVER_STATES,
  NOTIFICATION_DELIVERY_STATES, PLAN_STATES, PROJECT_STATUSES, SESSION_STATES,
  SPENDING_STATES, TASK_STATES,
} from "./contracts.js";
import { refuse } from "./errors.js";

export interface TotalStateMachine<S extends string, E extends string> {
  readonly states: readonly S[];
  readonly events: readonly E[];
  readonly initial: S;
  readonly terminal: readonly S[];
  readonly table: Readonly<Record<S, Readonly<Record<E, S | null>>>>;
}

function totalMachine<S extends string, E extends string>(
  states: readonly S[],
  events: readonly E[],
  initial: S,
  terminal: readonly S[],
  legal: readonly (readonly [S, E, S])[],
): TotalStateMachine<S, E> {
  const table = Object.create(null) as Record<S, Record<E, S | null>>;
  for (const state of states) {
    const row = Object.create(null) as Record<E, S | null>;
    for (const event of events) row[event] = null;
    table[state] = row;
  }
  for (const [from, event, to] of legal) {
    if (table[from][event] !== null) refuse("INVARIANT_VIOLATION", "stateMachine", "The machine declares a duplicate transition cell.");
    table[from][event] = to;
  }
  for (const state of states) Object.freeze(table[state]);
  return Object.freeze({ states, events, initial, terminal: Object.freeze([...terminal]), table: Object.freeze(table) });
}

export function transition<S extends string, E extends string>(
  machine: TotalStateMachine<S, E>, state: S, event: E,
): S {
  if (!(machine.states as readonly string[]).includes(state) || !(machine.events as readonly string[]).includes(event)) {
    refuse("ILLEGAL_TRANSITION", "transition", "The state or event is not a member of this machine.");
  }
  const next = machine.table[state][event];
  if (next === null) refuse("ILLEGAL_TRANSITION", "transition", "That transition is not legal.");
  return next;
}

export const PROJECT_EVENTS = Object.freeze(["pause", "resume", "archive"] as const);
export type ProjectEvent = (typeof PROJECT_EVENTS)[number];
export const PROJECT_STATE_MACHINE = totalMachine(PROJECT_STATUSES, PROJECT_EVENTS, "active", ["archived"], [
  ["active", "pause", "paused"], ["paused", "resume", "active"],
  ["active", "archive", "archived"], ["paused", "archive", "archived"],
] as const);

export const PLAN_EVENTS = Object.freeze([
  "blocking-questions-found", "clarifications-recorded", "validation-passed",
  "scope-approval-required", "scope-approval-consumed", "scope-rejected", "seal",
  "dispatch-first-task", "request-expansion", "seal-expansion", "refuse-expansion",
  "stage-gate-reached", "accept-stage-gate", "revise-at-gate", "complete", "halt",
  "resume", "abandon", "draft-new-revision", "seal-new-revision",
] as const);
export type PlanEvent = (typeof PLAN_EVENTS)[number];
export const PLAN_STATE_MACHINE = totalMachine(PLAN_STATES, PLAN_EVENTS, "drafting", ["rejected", "completed", "abandoned", "superseded"], [
  ["drafting", "blocking-questions-found", "clarifying"],
  ["clarifying", "clarifications-recorded", "drafting"],
  ["drafting", "validation-passed", "proposed"],
  ["proposed", "scope-approval-required", "awaiting_scope_approval"],
  ["awaiting_scope_approval", "scope-approval-consumed", "proposed"],
  ["awaiting_scope_approval", "scope-rejected", "rejected"],
  ["proposed", "seal", "sealed"], ["sealed", "dispatch-first-task", "executing"],
  ["executing", "request-expansion", "expanding"],
  ["expanding", "seal-expansion", "executing"], ["expanding", "refuse-expansion", "executing"],
  ["executing", "stage-gate-reached", "stage_gate"], ["stage_gate", "accept-stage-gate", "executing"],
  ["stage_gate", "revise-at-gate", "superseded"], ["executing", "complete", "completed"],
  ["executing", "halt", "halted"], ["halted", "resume", "executing"],
  ["halted", "abandon", "abandoned"], ["drafting", "abandon", "abandoned"],
  ["proposed", "draft-new-revision", "superseded"], ["sealed", "seal-new-revision", "superseded"],
] as const);

export const TASK_EVENTS = Object.freeze([
  "dependencies-succeeded", "dependency-ended-unsuccessfully", "lease-run",
  "acceptance-satisfied", "retry-exhausted", "wait", "blocker-cleared",
  "resolution-required", "resolution-accepted", "resolution-impossible", "cancel",
  "upstream-recovered",
] as const);
export type ProjectTaskEvent = (typeof TASK_EVENTS)[number];
export const TASK_STATE_MACHINE = totalMachine(TASK_STATES, TASK_EVENTS, "pending", ["succeeded", "failed", "cancelled"], [
  ["pending", "dependencies-succeeded", "ready"], ["pending", "dependency-ended-unsuccessfully", "blocked"],
  ["ready", "lease-run", "running"], ["running", "acceptance-satisfied", "succeeded"],
  ["running", "retry-exhausted", "failed"], ["running", "wait", "waiting"],
  ["waiting", "blocker-cleared", "running"], ["running", "resolution-required", "needs_resolution"],
  ["needs_resolution", "resolution-accepted", "running"], ["needs_resolution", "resolution-impossible", "failed"],
  ["blocked", "upstream-recovered", "pending"],
  ["pending", "cancel", "cancelled"], ["ready", "cancel", "cancelled"],
  ["running", "cancel", "cancelled"], ["waiting", "cancel", "cancelled"],
  ["needs_resolution", "cancel", "cancelled"], ["blocked", "cancel", "cancelled"],
] as const);

export const AGENT_RUN_EVENTS = Object.freeze([
  "dispatch-started", "cancel", "lease-expired", "terminal-success", "terminal-failure",
  "heartbeat-lost", "reconciliation-proved-success", "reconciliation-proved-failure",
] as const);
export type AgentRunEvent = (typeof AGENT_RUN_EVENTS)[number];
export const AGENT_RUN_STATE_MACHINE = totalMachine(AGENT_RUN_STATES, AGENT_RUN_EVENTS, "leased", ["succeeded", "failed", "cancelled"], [
  ["leased", "dispatch-started", "running"], ["leased", "cancel", "cancelled"],
  ["leased", "lease-expired", "abandoned"], ["running", "terminal-success", "succeeded"],
  ["running", "terminal-failure", "failed"], ["running", "cancel", "cancelled"],
  ["running", "heartbeat-lost", "abandoned"], ["abandoned", "reconciliation-proved-success", "succeeded"],
  ["abandoned", "reconciliation-proved-failure", "failed"],
] as const);

export const SESSION_EVENTS = Object.freeze([
  "prepare", "spawn", "preparation-refused", "handshake-complete", "handshake-failed",
  "input-requested", "input-supplied", "stop", "heartbeat-missed", "heartbeat-resumed",
  "lease-expired", "termination-confirmed", "termination-unconfirmed", "reconciliation-proved-gone",
  "force-stop-unconfirmed", "archive", "operator-acknowledged",
] as const);
export type SessionEvent = (typeof SESSION_EVENTS)[number];
export const SESSION_STATE_MACHINE = totalMachine(SESSION_STATES, SESSION_EVENTS, "requested", ["archived"], [
  ["requested", "prepare", "preparing"], ["preparing", "spawn", "starting"],
  ["preparing", "preparation-refused", "failed"], ["starting", "handshake-complete", "running"],
  ["starting", "handshake-failed", "failed"], ["running", "input-requested", "awaiting_input"],
  ["awaiting_input", "input-supplied", "running"], ["awaiting_input", "stop", "stopping"],
  ["running", "stop", "stopping"], ["running", "heartbeat-missed", "lost"],
  ["lost", "heartbeat-resumed", "running"], ["lost", "lease-expired", "orphaned"],
  ["stopping", "termination-confirmed", "stopped"], ["stopping", "termination-unconfirmed", "termination_unconfirmed"],
  ["orphaned", "reconciliation-proved-gone", "stopped"], ["orphaned", "force-stop-unconfirmed", "termination_unconfirmed"],
  ["stopped", "archive", "archived"], ["failed", "archive", "archived"],
  ["termination_unconfirmed", "operator-acknowledged", "archived"],
] as const);

export const HANDOVER_EVENTS = Object.freeze(["queue", "acknowledge", "expire", "void"] as const);
export type HandoverEvent = (typeof HANDOVER_EVENTS)[number];
export const HANDOVER_STATE_MACHINE = totalMachine(HANDOVER_STATES, HANDOVER_EVENTS, "assembled", ["acknowledged", "expired", "voided"], [
  ["assembled", "queue", "queued"], ["queued", "acknowledge", "acknowledged"],
  ["queued", "expire", "expired"], ["queued", "void", "voided"],
] as const);

export const APPROVAL_EVENTS = Object.freeze([
  "approve", "reject", "expire", "void", "consume-one", "consume-partial",
  "consume-ceiling", "revoke",
] as const);
export type ApprovalEvent = (typeof APPROVAL_EVENTS)[number];
export const APPROVAL_STATE_MACHINE = totalMachine(APPROVAL_STATES, APPROVAL_EVENTS, "requested", ["rejected", "expired", "voided", "consumed", "revoked"], [
  ["requested", "approve", "approved"], ["requested", "reject", "rejected"],
  ["requested", "expire", "expired"], ["requested", "void", "voided"],
  ["approved", "consume-one", "consumed"], ["approved", "consume-partial", "partially_consumed"],
  ["partially_consumed", "consume-partial", "partially_consumed"], ["partially_consumed", "consume-ceiling", "consumed"],
  ["approved", "revoke", "revoked"], ["partially_consumed", "revoke", "revoked"],
  ["approved", "expire", "expired"], ["partially_consumed", "expire", "expired"],
  ["approved", "void", "voided"], ["partially_consumed", "void", "voided"],
] as const);

export const SPENDING_EVENTS = Object.freeze([
  "quote", "request-approval", "authorize", "decline", "expire-quote", "requote",
  "operator-reports-executed", "withdraw", "record-receipt",
] as const);
export type SpendingEvent = (typeof SPENDING_EVENTS)[number];
export const SPENDING_STATE_MACHINE = totalMachine(SPENDING_STATES, SPENDING_EVENTS, "drafted", ["declined", "withdrawn", "reconciled"], [
  ["drafted", "quote", "quoted"], ["quoted", "request-approval", "awaiting_approval"],
  ["awaiting_approval", "authorize", "authorized"], ["awaiting_approval", "decline", "declined"],
  ["awaiting_approval", "expire-quote", "quote_expired"], ["quote_expired", "requote", "quoted"],
  ["authorized", "operator-reports-executed", "operator_executed"], ["authorized", "withdraw", "withdrawn"],
  ["operator_executed", "record-receipt", "reconciled"],
] as const);

export const BLOCKER_EVENTS = Object.freeze(["clear"] as const);
export type BlockerEvent = (typeof BLOCKER_EVENTS)[number];
export const BLOCKER_STATE_MACHINE = totalMachine(BLOCKER_STATES, BLOCKER_EVENTS, "open", ["cleared"], [["open", "clear", "cleared"]] as const);

export const NOTIFICATION_DELIVERY_EVENTS = Object.freeze(["send", "fail", "suppress", "expire", "retry"] as const);
export type NotificationDeliveryEvent = (typeof NOTIFICATION_DELIVERY_EVENTS)[number];
export const NOTIFICATION_DELIVERY_STATE_MACHINE = totalMachine(NOTIFICATION_DELIVERY_STATES, NOTIFICATION_DELIVERY_EVENTS, "pending", ["sent", "suppressed", "expired"], [
  ["pending", "send", "sent"], ["pending", "fail", "failed"], ["pending", "suppress", "suppressed"],
  ["pending", "expire", "expired"], ["failed", "retry", "pending"], ["failed", "expire", "expired"],
] as const);

export const PROJECT_STATE_MACHINES = Object.freeze({
  project: PROJECT_STATE_MACHINE, plan: PLAN_STATE_MACHINE, task: TASK_STATE_MACHINE,
  agentRun: AGENT_RUN_STATE_MACHINE, session: SESSION_STATE_MACHINE, handover: HANDOVER_STATE_MACHINE,
  approval: APPROVAL_STATE_MACHINE, spending: SPENDING_STATE_MACHINE, blocker: BLOCKER_STATE_MACHINE,
  notificationDelivery: NOTIFICATION_DELIVERY_STATE_MACHINE,
});

export function nextRevision(current: number): number {
  if (!Number.isSafeInteger(current) || current < 1) refuse("PROJECT_VALIDATION_REFUSED", "revision");
  if (current === Number.MAX_SAFE_INTEGER) refuse("REVISION_OVERFLOW", "revision", "The revision cannot advance safely.");
  return current + 1;
}

export const RECOVERY_DIRECTIVES = Object.freeze([
  "none", "mark-succeeded-and-reconcile-usage", "mark-failed", "force-stop-first",
  "operator-acknowledgement-required", "fresh-approval-and-resolution-required",
  "explicit-retry-eligible", "needs-resolution-no-retry",
] as const);
export type RecoveryDirective = (typeof RECOVERY_DIRECTIVES)[number];

export interface RecoveryFacts {
  readonly runState: AgentRunState;
  readonly sessionState: SessionState | null;
  readonly effectPhase: "pre-dispatch" | "possibly-dispatched" | "response-received" | "post-response";
  readonly idempotencyClass: ProjectTask["idempotencyClass"];
  readonly reconciliation: "not-run" | "proved-success" | "proved-failure" | "unresolved";
  readonly termination: "not-applicable" | "confirmed-gone" | "unconfirmed";
}

/** Pure decision only: callers perform every effect and supply every observation. */
export function deriveRecoveryDirective(facts: RecoveryFacts): RecoveryDirective {
  if (facts.sessionState === "termination_unconfirmed" || facts.termination === "unconfirmed") return "operator-acknowledgement-required";
  if (facts.sessionState === "orphaned" && facts.termination !== "confirmed-gone") return "force-stop-first";
  if (facts.runState !== "abandoned") return "none";
  switch (facts.reconciliation) {
    case "proved-success": return "mark-succeeded-and-reconcile-usage";
    case "proved-failure": return "mark-failed";
    case "not-run": return "needs-resolution-no-retry";
    case "unresolved":
      if (facts.idempotencyClass === "irreversible" || facts.idempotencyClass === "approval-bound") return "fresh-approval-and-resolution-required";
      if (facts.termination === "confirmed-gone" && facts.effectPhase === "pre-dispatch") return "explicit-retry-eligible";
      return "needs-resolution-no-retry";
    default: return assertNever(facts.reconciliation);
  }
}

function assertNever(value: never): never {
  return refuse("INVARIANT_VIOLATION", "exhaustiveness", "A closed project union was not handled.");
}

export type ProjectMachineState = ProjectStatus | PlanState | ProjectTaskState | AgentRunState | SessionState | HandoverState | ApprovalState | SpendingState | BlockerState | NotificationDeliveryState;
