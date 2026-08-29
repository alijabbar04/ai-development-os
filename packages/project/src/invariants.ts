import type {
  ApprovalRequest, Decision, EvidenceRecord, Handover, ProjectBrief, ProjectPlan,
  ProjectStop, SpendingRequest,
} from "./contracts.js";
import { serializeCanonicalProjectJson } from "./canonical.js";
import { refuse } from "./errors.js";
import { nextRevision } from "./state-machines.js";
import { digest } from "./validation.js";

/** There is no executable capability, authority token, command, or callback in C6. */
export const PROJECT_RUNTIME_CAPABILITIES = Object.freeze([] as const);
export const PROJECT_AVAILABLE_COMMANDS = Object.freeze([] as const);

export function planDigestMaterial(plan: ProjectPlan): string {
  return serializeCanonicalProjectJson({
    stages: plan.stages,
    tasks: plan.tasks,
    dependencies: plan.dependencies,
    budgetCeiling: plan.budgetCeiling,
  });
}

export function assertPlanDigest(plan: ProjectPlan, independentlyComputedDigest: string): void {
  if (plan.planDigest !== independentlyComputedDigest) {
    refuse("DIGEST_MISMATCH", "projectPlan.planDigest", "The sealed plan content does not match its independent digest.");
  }
}

export type ContentIdentitySubject =
  | Readonly<{ kind: "handover"; record: Handover }>
  | Readonly<{ kind: "decision"; record: Decision }>
  | Readonly<{ kind: "evidence"; record: EvidenceRecord }>;

/** The digest is computed by the caller over its independently serialized canonical material. */
export function assertContentDerivedIdentity(subject: ContentIdentitySubject, independentlyComputedDigest: string): void {
  const checkedDigest = digest(independentlyComputedDigest, "contentIdentity.digest");
  let identity: string;
  let prefix: "hnd:" | "dec:" | "evd:";
  switch (subject.kind) {
    case "handover": identity = subject.record.handoverId; prefix = "hnd:"; break;
    case "decision": identity = subject.record.decisionId; prefix = "dec:"; break;
    case "evidence": identity = subject.record.evidenceId; prefix = "evd:"; break;
    default: return assertNever(subject);
  }
  if (identity !== `${prefix}${checkedDigest.slice(0, 32)}`) refuse("DIGEST_MISMATCH", "contentIdentity", "The content-derived identity does not match the independent digest.");
}

export function assertNewPlanRevision(previous: ProjectPlan, next: ProjectPlan): void {
  if (
    next.revision !== nextRevision(previous.revision) ||
    next.supersedes !== previous.planId ||
    next.planId === previous.planId ||
    next.projectId !== previous.projectId ||
    next.briefId !== previous.briefId ||
    next.briefRevision !== previous.briefRevision ||
    next.createdAt < previous.createdAt
  ) {
    refuse("INVARIANT_VIOLATION", "projectPlan.revision", "The plan revision does not form an immutable supersession step.");
  }
}

export function assertNewBrief(previous: ProjectBrief, next: ProjectBrief): void {
  if (next.briefId === previous.briefId || next.supersedes !== previous.briefId || next.projectId !== previous.projectId || next.revision !== 1 || next.createdAt < previous.createdAt) {
    refuse("INVARIANT_VIOLATION", "projectBrief.supersedes", "The brief does not form an immutable supersession step.");
  }
}

export function assertNewHandover(previous: Handover, next: Handover): void {
  if (
    next.handoverId === previous.handoverId
    || next.supersedes !== previous.handoverId
    || next.projectId !== previous.projectId
    || next.planId !== previous.planId
    || next.planRevision !== previous.planRevision
    || next.toTaskId !== previous.toTaskId
    || next.sequence !== nextRevision(previous.sequence)
    || next.createdAt < previous.createdAt
  ) {
    refuse("INVARIANT_VIOLATION", "handover.supersedes", "The handover does not form an immutable supersession step.");
  }
}

export function assertNewDecision(previous: Decision, next: Decision): void {
  if (
    next.decisionId === previous.decisionId
    || next.supersedes !== previous.decisionId
    || next.projectId !== previous.projectId
    || next.kind !== previous.kind
    || serializeCanonicalProjectJson(next.scope) !== serializeCanonicalProjectJson(previous.scope)
    || next.decidedAt < previous.decidedAt
  ) {
    refuse("INVARIANT_VIOLATION", "decision.supersedes", "The decision does not form an immutable supersession step.");
  }
}

export function assertNewEvidence(previous: EvidenceRecord, next: EvidenceRecord): void {
  if (
    next.evidenceId === previous.evidenceId
    || next.supersedes !== previous.evidenceId
    || next.projectId !== previous.projectId
    || next.runId !== previous.runId
    || next.kind !== previous.kind
    || next.createdAt < previous.createdAt
  ) {
    refuse("INVARIANT_VIOLATION", "evidenceRecord.supersedes", "The evidence does not form an immutable supersession step.");
  }
}

export type SupersessionHistory =
  | Readonly<{ kind: "brief"; records: readonly ProjectBrief[] }>
  | Readonly<{ kind: "handover"; records: readonly Handover[] }>
  | Readonly<{ kind: "decision"; records: readonly Decision[] }>
  | Readonly<{ kind: "evidence"; records: readonly EvidenceRecord[] }>;

/** Refuses duplicate identities, self-links, and cycles in a supplied immutable history. */
export function assertAcyclicSupersession(history: SupersessionHistory): void {
  const identities = new Map<string, string | null>();
  const records = history.records as readonly (
    ProjectBrief | Handover | Decision | EvidenceRecord
  )[];
  for (const item of records) {
    const identity = "briefId" in item ? item.briefId
      : "handoverId" in item ? item.handoverId
        : "decisionId" in item ? item.decisionId
          : item.evidenceId;
    if (identities.has(identity) || item.supersedes === identity) {
      refuse("INVARIANT_VIOLATION", "supersession", "The immutable history contains a duplicate or self-reference.");
    }
    identities.set(identity, item.supersedes);
  }
  for (const identity of identities.keys()) {
    const seen = new Set<string>();
    let cursor: string | null | undefined = identity;
    while (cursor !== null && cursor !== undefined && identities.has(cursor)) {
      if (seen.has(cursor)) refuse("INVARIANT_VIOLATION", "supersession", "The immutable history contains a cycle.");
      seen.add(cursor);
      cursor = identities.get(cursor);
    }
  }
}

export function canEvidenceCloseRequirement(evidence: EvidenceRecord): boolean {
  switch (evidence.producedBy) {
    case "deterministic-validation": case "workspace-reconciliation": return true;
    case "provider": case "operator": return false;
    default: return assertNever(evidence.producedBy);
  }
}

export function spendingSubjectMaterial(spending: SpendingRequest): string {
  return serializeCanonicalProjectJson({
    kind: spending.kind,
    vendor: spending.vendor,
    amountMinorUnits: spending.amountMinorUnits,
    currency: spending.currency,
    recurrence: spending.recurrence,
    quoteDigest: spending.quoteDigest,
  });
}

/** Contract-layer proof only. This function cannot and does not execute a purchase. */
export function assertSpendingAuthorization(
  spending: SpendingRequest,
  approval: ApprovalRequest,
  independentlyComputedSubjectDigest: string,
): void {
  const expectedClass = spending.kind === "recurring-limit-change" ? "spending-limit" : spending.kind;
  if (
    spending.linkedApprovalRequestId !== approval.approvalRequestId ||
    approval.state !== "consumed" ||
    approval.class !== expectedClass ||
    approval.subjectDigest !== independentlyComputedSubjectDigest
  ) {
    refuse("AUTHORITY_VIOLATION", "spendingRequest.linkedApprovalRequestId", "The spending request lacks an exact consumed approval binding.");
  }
}

export function isProjectStopActive(stop: ProjectStop): boolean {
  return stop.resumedAt === null;
}

/**
 * Durable project decisions intentionally omit sourceThreadId and every chat or
 * transcript payload. Deleting those audit links therefore cannot change these
 * bytes or any function that consumes them.
 */
export function projectDecisionMaterial(input: Readonly<{
  projectId: string;
  objective: string;
  planState: ProjectPlan["state"] | null;
  taskStates: readonly ProjectPlan["tasks"][number]["state"][];
  openBlockerIds: readonly string[];
}>): string {
  return serializeCanonicalProjectJson(input);
}

function assertNever(value: never): never {
  return refuse("INVARIANT_VIOLATION", "invariant", "A closed project union was not handled.");
}
