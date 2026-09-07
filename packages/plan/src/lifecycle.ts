import {
  PLAN_STATE_MACHINE,
  parseProjectPlan,
  serializeCanonicalProjectJson,
  transition,
  type PlanEvent,
  type ProjectPlan,
} from "@ai-dev-os/project";
import type {
  AcceptedBriefBinding,
  PendingWriteContext,
  PlanCommitOutcome,
  PlanCommitRequest,
  PlanObservationOutcome,
  PlanPredecessorEvidence,
  PlanRebaseLink,
  PlanWriteOperation,
  PlanWriteOrigin,
} from "./contracts.js";
import { refusePlan } from "./errors.js";

export const PLAN_ASSEMBLY_STATES = Object.freeze([
  "absent", "validation-required", "validating", "invalid", "review-required",
  "sealing-from-review", "sealing-from-committed", "writing-from-review",
  "abandoning-from-review", "abandoning-from-committed", "superseding-from-stale",
  "advancing-from-review", "advancing-from-committed", "committed",
  "revision-proposed", "persistence-conflict", "write-outcome-unknown-to-review",
  "write-outcome-unknown-to-committed", "write-outcome-unknown-to-stale",
  "source-brief-stale", "source-brief-corrupt",
] as const);

export type PlanAssemblyState = (typeof PLAN_ASSEMBLY_STATES)[number];

export const PLAN_ASSEMBLY_SYMBOLS = Object.freeze([
  "submit-proposal", "load-head", "validate", "commit-draft", "promote",
  "record-decision", "seal", "revise", "discard-revision", "abandon", "rebase",
  "discard", "reread", "cancel", "read", "validation-passed", "validation-failed",
  "brief-moved", "brief-corrupt", "brief-evidence-unresolved", "write-committed",
  "write-conflicted", "write-unknown", "write-not-written", "write-refused",
] as const);

export type PlanAssemblySymbol = (typeof PLAN_ASSEMBLY_SYMBOLS)[number];

export const PLAN_ASSEMBLY_LOCKED_STATES = Object.freeze([
  "validating", "sealing-from-review", "sealing-from-committed", "writing-from-review",
  "abandoning-from-review", "abandoning-from-committed", "superseding-from-stale",
  "advancing-from-review", "advancing-from-committed",
] as const satisfies readonly PlanAssemblyState[]);

const LEGAL: Readonly<Record<PlanAssemblyState, Readonly<Partial<Record<PlanAssemblySymbol, PlanAssemblyState>>>>> = Object.freeze({
  "absent": { "submit-proposal": "validation-required", "read": "absent", "load-head": "validation-required" },
  "validation-required": { "validate": "validating", "cancel": "absent", "read": "validation-required" },
  "validating": { "validation-passed": "review-required", "validation-failed": "invalid", "brief-moved": "source-brief-stale", "brief-corrupt": "source-brief-corrupt", "brief-evidence-unresolved": "validation-required" },
  "invalid": { "submit-proposal": "validation-required", "cancel": "absent", "read": "invalid" },
  "review-required": { "commit-draft": "writing-from-review", "seal": "sealing-from-review", "revise": "revision-proposed", "abandon": "abandoning-from-review", "read": "review-required", "promote": "advancing-from-review", "record-decision": "advancing-from-review" },
  "sealing-from-review": { "write-committed": "committed", "write-conflicted": "persistence-conflict", "write-unknown": "write-outcome-unknown-to-review", "write-refused": "review-required", "brief-moved": "source-brief-stale", "brief-corrupt": "source-brief-corrupt", "brief-evidence-unresolved": "review-required" },
  "sealing-from-committed": { "write-committed": "committed", "write-conflicted": "persistence-conflict", "write-unknown": "write-outcome-unknown-to-committed", "write-refused": "committed", "brief-moved": "source-brief-stale", "brief-corrupt": "source-brief-corrupt", "brief-evidence-unresolved": "committed" },
  "writing-from-review": { "write-committed": "committed", "write-conflicted": "persistence-conflict", "write-unknown": "write-outcome-unknown-to-review", "write-refused": "review-required", "brief-moved": "source-brief-stale", "brief-corrupt": "source-brief-corrupt", "brief-evidence-unresolved": "review-required" },
  "abandoning-from-review": { "write-committed": "committed", "write-conflicted": "persistence-conflict", "write-unknown": "write-outcome-unknown-to-review", "write-refused": "review-required" },
  "abandoning-from-committed": { "write-committed": "committed", "write-conflicted": "persistence-conflict", "write-unknown": "write-outcome-unknown-to-committed", "write-refused": "committed" },
  "superseding-from-stale": { "write-committed": "committed", "write-conflicted": "persistence-conflict", "write-unknown": "write-outcome-unknown-to-stale", "write-refused": "source-brief-stale" },
  "advancing-from-review": { "write-committed": "committed", "write-conflicted": "persistence-conflict", "write-unknown": "write-outcome-unknown-to-review", "write-refused": "review-required", "brief-moved": "source-brief-stale", "brief-corrupt": "source-brief-corrupt", "brief-evidence-unresolved": "review-required" },
  "advancing-from-committed": { "write-committed": "committed", "write-conflicted": "persistence-conflict", "write-unknown": "write-outcome-unknown-to-committed", "write-refused": "committed", "brief-moved": "source-brief-stale", "brief-corrupt": "source-brief-corrupt", "brief-evidence-unresolved": "committed" },
  "committed": { "read": "committed", "revise": "revision-proposed", "seal": "sealing-from-committed", "abandon": "abandoning-from-committed", "record-decision": "advancing-from-committed", "promote": "advancing-from-committed" },
  "revision-proposed": { "submit-proposal": "validation-required", "discard-revision": "committed", "read": "revision-proposed" },
  "persistence-conflict": { "reread": "validation-required", "cancel": "absent", "read": "persistence-conflict" },
  "write-outcome-unknown-to-review": { "reread": "write-outcome-unknown-to-review", "read": "write-outcome-unknown-to-review", "write-committed": "committed", "write-not-written": "review-required", "write-conflicted": "persistence-conflict", "write-unknown": "write-outcome-unknown-to-review", "cancel": "absent" },
  "write-outcome-unknown-to-committed": { "reread": "write-outcome-unknown-to-committed", "read": "write-outcome-unknown-to-committed", "write-committed": "committed", "write-not-written": "committed", "write-conflicted": "persistence-conflict", "write-unknown": "write-outcome-unknown-to-committed", "cancel": "absent" },
  "write-outcome-unknown-to-stale": { "reread": "write-outcome-unknown-to-stale", "read": "write-outcome-unknown-to-stale", "write-committed": "committed", "write-not-written": "source-brief-stale", "write-conflicted": "persistence-conflict", "write-unknown": "write-outcome-unknown-to-stale", "cancel": "absent" },
  "source-brief-stale": { "rebase": "validation-required", "discard": "superseding-from-stale", "cancel": "absent", "read": "source-brief-stale" },
  "source-brief-corrupt": { "cancel": "absent", "read": "source-brief-corrupt" },
});

export const PLAN_ASSEMBLY_MACHINE: Readonly<Record<PlanAssemblyState, Readonly<Record<PlanAssemblySymbol, PlanAssemblyState | null>>>> = Object.freeze(
  Object.fromEntries(PLAN_ASSEMBLY_STATES.map((state) => [state, Object.freeze(
    Object.fromEntries(PLAN_ASSEMBLY_SYMBOLS.map((symbol) => [symbol, LEGAL[state][symbol] ?? null])),
  )])) as Record<PlanAssemblyState, Readonly<Record<PlanAssemblySymbol, PlanAssemblyState | null>>>,
);

export function transitionPlanAssembly(state: PlanAssemblyState, symbol: PlanAssemblySymbol): PlanAssemblyState {
  const next = PLAN_ASSEMBLY_MACHINE[state]?.[symbol] ?? null;
  if (next === null) refusePlan("PLAN_PRECONDITION_REFUSED", "plan.session.illegal-input", "planSession");
  return next;
}

export interface PlanAssemblySession {
  readonly state: PlanAssemblyState;
  readonly pending: PendingWriteContext | null;
}

export const INITIAL_PLAN_ASSEMBLY_SESSION: PlanAssemblySession = Object.freeze({ state: "absent", pending: null });

function legalPendingHost(context: PendingWriteContext, host: PlanAssemblyState): boolean {
  const head = context.observationKind === "head";
  switch (context.operation) {
    case "first-draft": case "redraft": return context.origin === "review-required" && host === "writing-from-review" && head;
    case "seal": return head && (context.origin === "review-required" && host === "sealing-from-review" || context.origin === "committed" && host === "sealing-from-committed");
    case "abandon": return head && (context.origin === "review-required" && host === "abandoning-from-review" || context.origin === "committed" && host === "abandoning-from-committed");
    case "discard-stale": return head && context.origin === "source-brief-stale" && host === "superseding-from-stale";
    case "budget-extension": return !head && (context.origin === "review-required" && host === "advancing-from-review" || context.origin === "committed" && host === "advancing-from-committed");
    case "promote": case "scope-rejected": case "revision-r1": case "revision-r2":
      return head && (context.origin === "review-required" && host === "advancing-from-review" || context.origin === "committed" && host === "advancing-from-committed");
  }
}

export function beginPlanWrite(
  session: PlanAssemblySession,
  symbol: "commit-draft" | "promote" | "record-decision" | "seal" | "abandon" | "discard",
  operation: PlanWriteOperation,
  request: PlanCommitRequest,
): PlanAssemblySession {
  const host = transitionPlanAssembly(session.state, symbol);
  const origin: PlanWriteOrigin = session.state === "committed" ? "committed"
    : session.state === "source-brief-stale" ? "source-brief-stale"
      : "review-required";
  const context = Object.freeze({
    operation,
    origin,
    observationKind: operation === "budget-extension" ? "journal" as const : "head" as const,
    request,
  });
  if (!legalPendingHost(context, host)) refusePlan("PLAN_PRECONDITION_REFUSED", "plan.session.illegal-input", "planSession");
  return Object.freeze({ state: host, pending: context });
}

export function applyPlanCommitOutcome(session: PlanAssemblySession, outcome: PlanCommitOutcome): PlanAssemblySession {
  if (session.pending === null || !(PLAN_ASSEMBLY_LOCKED_STATES as readonly string[]).includes(session.state)) {
    refusePlan("PLAN_PRECONDITION_REFUSED", "plan.session.illegal-input", "planSession");
  }
  let symbol: PlanAssemblySymbol;
  switch (outcome.kind) {
    case "committed": symbol = "write-committed"; break;
    case "conflict": symbol = "write-conflicted"; break;
    case "unknown": symbol = "write-unknown"; break;
    case "not-attempted": symbol = "brief-evidence-unresolved"; break;
    case "refused":
      symbol = outcome.ruleId === "plan.brief.superseded" ? "brief-moved"
        : ["plan.brief.content-digest-mismatch", "plan.brief.acceptance-proof-invalid"].includes(outcome.ruleId) ? "brief-corrupt"
          : "write-refused";
      break;
  }
  const next = transitionPlanAssembly(session.state, symbol);
  const retain = next.startsWith("write-outcome-unknown-to-");
  return Object.freeze({ state: next, pending: retain ? session.pending : null });
}

export function applyPlanObservationOutcome(session: PlanAssemblySession, outcome: PlanObservationOutcome): PlanAssemblySession {
  if (session.pending === null || !session.state.startsWith("write-outcome-unknown-to-")) {
    refusePlan("PLAN_PRECONDITION_REFUSED", "plan.session.illegal-input", "planSession");
  }
  const expectedSuffix = session.pending.origin === "review-required" ? "review"
    : session.pending.origin === "source-brief-stale" ? "stale" : "committed";
  if (session.state !== `write-outcome-unknown-to-${expectedSuffix}`) {
    refusePlan("PLAN_PRECONDITION_REFUSED", "plan.session.illegal-input", "planSession");
  }
  const symbol: PlanAssemblySymbol = outcome.kind === "committed" ? "write-committed"
    : outcome.kind === "not-recorded" ? "write-not-written"
      : outcome.kind === "conflict" ? "write-conflicted" : "write-unknown";
  const next = transitionPlanAssembly(session.state, symbol);
  return Object.freeze({ state: next, pending: next === session.state ? session.pending : null });
}

function fold(plan: ProjectPlan, event: PlanEvent, updatedAt: string): ProjectPlan {
  const state = transition(PLAN_STATE_MACHINE, plan.state, event);
  try {
    return parseProjectPlan({ ...plan, state, updatedAt });
  } catch {
    return refusePlan("PLAN_PRECONDITION_REFUSED", "plan.state.illegal", "plan");
  }
}

export function promoteDraft(plan: ProjectPlan, updatedAt: string, materialInferredScope: boolean): readonly ProjectPlan[] {
  const proposed = fold(plan, "validation-passed", updatedAt);
  if (!materialInferredScope) return Object.freeze([proposed]);
  return Object.freeze([proposed, fold(proposed, "scope-approval-required", updatedAt)]);
}

export function rejectPlanScope(plan: ProjectPlan, updatedAt: string): ProjectPlan {
  return fold(plan, "scope-rejected", updatedAt);
}

export function consumePlanScopeApproval(plan: ProjectPlan, updatedAt: string): ProjectPlan {
  return fold(plan, "scope-approval-consumed", updatedAt);
}

export function sealProposedPlan(plan: ProjectPlan, sealedAt: string, sealedByApprovalId: string | null = null): ProjectPlan {
  const state = transition(PLAN_STATE_MACHINE, plan.state, "seal");
  try {
    return parseProjectPlan({ ...plan, state, sealedAt, sealedByApprovalId, updatedAt: sealedAt });
  } catch {
    return refusePlan("PLAN_PRECONDITION_REFUSED", "plan.state.illegal", "planSeal");
  }
}

export function supersedeForRevision(plan: ProjectPlan, updatedAt: string): ProjectPlan {
  const event = plan.state === "proposed" ? "draft-new-revision" : "seal-new-revision";
  return fold(plan, event, updatedAt);
}

export function abandonDraft(plan: ProjectPlan, updatedAt: string): ProjectPlan {
  return fold(plan, "abandon", updatedAt);
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return serializeCanonicalProjectJson(left) === serializeCanonicalProjectJson(right);
}

/**
 * Proves the C9 R2 lineage step without pretending it is a C6 R1 revision.
 * The old plan retains its historical brief; the new plan starts revision 1
 * against a strictly later acceptance-proven brief and carries the exact
 * journal replacement link for the old durable state.
 */
export function assertRebasedPlanLineage(
  previous: ProjectPlan,
  next: ProjectPlan,
  previousAccepted: AcceptedBriefBinding,
  nextAccepted: AcceptedBriefBinding,
  link: PlanRebaseLink,
): void {
  const expectedDisposition = previous.state === "drafting"
    ? Object.freeze({ kind: "draft-replaced" as const, from: "drafting" as const })
    : previous.state === "proposed" || previous.state === "sealed"
      ? Object.freeze({ kind: "superseded" as const, from: previous.state, to: "superseded" as const })
      : null;
  const exactAccepted = Object.freeze({
    projectId: link.projectId,
    briefId: link.briefId,
    briefAggregateVersion: link.briefAggregateVersion,
    briefContentDigest: link.briefContentDigest,
    acceptedCandidateDigest: link.acceptedCandidateDigest,
    acceptanceEventId: link.acceptanceEventId,
  });
  if (expectedDisposition === null
    || previous.projectId !== next.projectId
    || previous.planId === next.planId
    || next.revision !== 1
    || next.supersedes !== null
    || next.briefRevision !== 1
    || next.briefId === previous.briefId
    || next.createdAt < previous.createdAt
    || previousAccepted.projectId !== previous.projectId
    || previousAccepted.briefId !== previous.briefId
    || nextAccepted.projectId !== next.projectId
    || nextAccepted.briefId !== next.briefId
    || nextAccepted.briefAggregateVersion <= previousAccepted.briefAggregateVersion
    || nextAccepted.acceptanceEventId === previousAccepted.acceptanceEventId
    || link.kind !== "plan.rebased"
    || link.replaces !== previous.planId
    || link.replacesRevision !== previous.revision
    || !sameCanonicalValue(link.previousDisposition, expectedDisposition)
    || !sameCanonicalValue(exactAccepted, nextAccepted)) {
    refusePlan("PLAN_VALIDATION_REFUSED", "plan.lineage.not-rebase", "planLineage");
  }
}

export interface PlanChainNode {
  readonly plan: ProjectPlan;
  readonly rebase: PlanRebaseLink | null;
  readonly predecessor: PlanPredecessorEvidence | null;
}

/** Checks both record `supersedes` links and journal-borne replacement links. */
export function assertAcyclicPlanChain(values: readonly (ProjectPlan | PlanChainNode)[]): void {
  const byId = new Map<string, string | null>();
  const outgoing = new Map<string, Set<string>>();
  for (const value of values) {
    const node = "plan" in value ? value : Object.freeze({ plan: value, rebase: null, predecessor: null });
    const plan = node.plan;
    if (byId.has(plan.planId)) {
      refusePlan("PLAN_VALIDATION_REFUSED", "plan.lineage.cycle", "planLineage");
    }
    byId.set(plan.planId, plan.supersedes);
    const targets = new Set<string>();
    if (plan.supersedes !== null) targets.add(plan.supersedes);
    if (node.rebase !== null) targets.add(node.rebase.replaces);
    if (node.predecessor !== null) targets.add(node.predecessor.planId);
    if (targets.has(plan.planId)) {
      refusePlan("PLAN_VALIDATION_REFUSED", "plan.lineage.cycle", "planLineage");
    }
    outgoing.set(plan.planId, targets);
  }
  for (const id of byId.keys()) {
    const seen = new Set<string>();
    const active = new Set<string>();
    const visit = (cursor: string): void => {
      if (!byId.has(cursor)) return;
      if (active.has(cursor)) refusePlan("PLAN_VALIDATION_REFUSED", "plan.lineage.cycle", "planLineage");
      if (seen.has(cursor)) return;
      active.add(cursor);
      for (const target of outgoing.get(cursor) ?? []) visit(target);
      active.delete(cursor);
      seen.add(cursor);
    };
    visit(id);
  }
}
