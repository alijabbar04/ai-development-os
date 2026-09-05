import { serializeCanonicalProjectJson } from "@ai-dev-os/project";
import { PLAN_LIMITS } from "./constants.js";
import type {
  PlanCommitRequest,
  PlanDigestPort,
  PlanHeadJournalEntry,
  PlanJournalEntry,
  PlanObservationOutcome,
  PlanStore,
} from "./contracts.js";
import { isHeadEvent, parsePlanCommitRequest } from "./persistence.js";
import { planDigest, sameCanonicalValue } from "./validation.js";

function checksum(value: unknown, digest: PlanDigestPort): string | null {
  try {
    return planDigest(digest.sha256(serializeCanonicalProjectJson(value)), "planStore");
  } catch {
    return null;
  }
}

function exactEvent(
  observed: PlanJournalEntry,
  request: PlanCommitRequest,
  finalIndex: number,
  digest: PlanDigestPort,
): boolean {
  const step = request.steps[finalIndex]!;
  return observed.eventId === step.eventId
    && observed.aggregateType === "project-plan"
    && observed.aggregateId === request.projectId
    && observed.aggregateVersion === step.event.binding.resultAggregateVersion
    && observed.eventType === step.event.kind
    && observed.eventSchemaVersion === 1
    && observed.payloadChecksum === checksum(step.event, digest)
    && observed.occurredAt === step.envelope.occurredAt
    && observed.traceId === step.envelope.traceId
    && observed.causationId === step.envelope.causationId
    && sameCanonicalValue(observed.payload, step.event);
}

async function observeHead(
  store: PlanStore,
  request: PlanCommitRequest,
  digest: PlanDigestPort,
): Promise<PlanObservationOutcome> {
  const finalIndex = request.steps.length - 1;
  const step = request.steps[finalIndex]!;
  if (!isHeadEvent(step.event) || step.plan === null) return Object.freeze({ kind: "unknown" });
  const read = await store.readHead(request.projectId);
  if (read.kind === "absent") {
    return request.binding.expectedAggregateVersion === 0 && request.binding.expectedHeadPlanId === null
      ? Object.freeze({ kind: "not-recorded", aggregateVersion: 0 })
      : Object.freeze({ kind: "unknown" });
  }
  if (read.kind !== "head") return Object.freeze({ kind: "unknown" });
  const targetVersion = step.event.binding.resultAggregateVersion;
  const target = read.head.aggregateId === request.projectId
    && read.head.aggregateVersion === targetVersion
    && read.head.plan.planId === step.plan.planId
    && read.head.payloadChecksum === checksum(step.plan, digest)
    && sameCanonicalValue(read.head.plan, step.plan)
    && exactEvent(read.head.headEvent as PlanHeadJournalEntry, request, finalIndex, digest);
  if (target) return Object.freeze({ kind: "committed", aggregateVersion: targetVersion, evidence: "head-observation" });
  if (read.head.aggregateVersion === request.binding.expectedAggregateVersion
    && read.head.plan.planId === request.binding.expectedHeadPlanId) {
    return Object.freeze({ kind: "not-recorded", aggregateVersion: read.head.aggregateVersion });
  }
  return Object.freeze({ kind: "conflict", actualVersion: read.head.aggregateVersion });
}

async function observeJournal(
  store: PlanStore,
  request: PlanCommitRequest,
  digest: PlanDigestPort,
): Promise<PlanObservationOutcome> {
  const step = request.steps[0]!;
  if (step.event.kind !== "plan.budget-extended") return Object.freeze({ kind: "unknown" });
  let cursor: string | null = null;
  let previousSequence = 0;
  let observedCount = 0;
  let exactCount = 0;
  const seenCursors = new Set<string>();
  while (observedCount <= PLAN_LIMITS.maxJournalEvents) {
    const read = await store.readJournal(request.projectId, { limit: PLAN_LIMITS.journalPageSize, cursor });
    if (read.kind !== "page") return Object.freeze({ kind: "unknown" });
    if (read.page.events.length === 0 && read.page.nextCursor !== null) return Object.freeze({ kind: "unknown" });
    for (const entry of read.page.events) {
      observedCount += 1;
      if (observedCount > PLAN_LIMITS.maxJournalEvents
        || entry.globalSequence <= previousSequence
        || entry.aggregateId !== request.projectId) return Object.freeze({ kind: "unknown" });
      previousSequence = entry.globalSequence;
      if (entry.eventId === step.eventId) {
        if (!exactEvent(entry, request, 0, digest)) return Object.freeze({ kind: "unknown" });
        exactCount += 1;
      }
    }
    if (read.page.nextCursor === null) {
      return exactCount === 1
        ? Object.freeze({ kind: "committed", aggregateVersion: request.binding.expectedAggregateVersion, evidence: "journal-observation" })
        : exactCount === 0
          ? Object.freeze({ kind: "not-recorded", aggregateVersion: request.binding.expectedAggregateVersion })
          : Object.freeze({ kind: "unknown" });
    }
    if (read.page.nextCursor === cursor || seenCursors.has(read.page.nextCursor)) return Object.freeze({ kind: "unknown" });
    seenCursors.add(read.page.nextCursor);
    cursor = read.page.nextCursor;
  }
  return Object.freeze({ kind: "unknown" });
}

/** Performs read-only, bounded reconciliation of one already-attempted immutable request. */
export async function observePlanCommit(
  store: PlanStore,
  requestValue: PlanCommitRequest,
  digest: PlanDigestPort,
): Promise<PlanObservationOutcome> {
  let request: PlanCommitRequest;
  try { request = parsePlanCommitRequest(requestValue, digest); }
  catch { return Object.freeze({ kind: "unknown" }); }
  return request.steps[0]?.event.kind === "plan.budget-extended"
    ? observeJournal(store, request, digest)
    : observeHead(store, request, digest);
}
