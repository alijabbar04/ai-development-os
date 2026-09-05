import { parseBudgetAccountState, type BudgetAccountState } from "@ai-dev-os/domain";
import { parseIntakeAcceptanceEvent, type IntakeAcceptanceEventPayload } from "@ai-dev-os/intake";
import {
  canonicalizeWithChecksum,
  checksumEquals,
  computeChecksumOfText,
  isPersistenceError,
  parseChecksum,
  validateAppendEventInput,
  validateCreateAggregateInput,
  type AggregateEnvelope,
  type EventRecord,
  type PersistenceAdapter,
  type TransactionContext,
} from "@ai-dev-os/persistence";
import {
  PLAN_STATE_MACHINE,
  assertNewPlanRevision,
  isProjectStopActive,
  parseDecision,
  parseProject,
  parseProjectPlan,
  parseProjectStop,
  serializeCanonicalProjectJson,
  transition,
  type Decision,
  type PlanEvent,
  type Project,
  type ProjectPlan,
} from "@ai-dev-os/project";
import {
  assertPlanRecordInvariants,
  assertAcyclicPlanChain,
  assemblePlan,
  assertAuthenticatedOperatorEvidence,
  assertCompleteMutationShape,
  assertSealConditions,
  assertRebasedPlanLineage,
  blockingOpenQuestionIds,
  decisionsMatchAuthorization,
  isHeadEvent,
  isPlanContractError,
  operationKindsOf,
  parsePlanCommitRequest,
  parsePlanJournalEvent,
  planLineageId,
  projectStopSnapshotDigestMaterial,
  resolveProjectCeiling,
  type AcceptedBriefBinding,
  type AcceptedBriefHead,
  type AcceptedBriefRead,
  type AuthenticatedOperatorClaimEvidence,
  type IssuedPlanCommitFacts,
  type PlanCommitAuthorization,
  type PlanCommitOutcome,
  type PlanCommitRequest,
  type PlanDigestPort,
  type PlanHeadEventPayload,
  type PlanHeadJournalEntry,
  type PlanHeadRead,
  type PlanJournalEntry,
  type PlanJournalRead,
  type PlanJournalWindow,
  type PlanLineageHead,
  type PlanMutationControlEvidence,
  type PlanRecordCoordinates,
  type PlanRefusalCode,
  type PlanPredecessorEvidence,
  type PlanRebaseLink,
  type PlanStore,
} from "../index.js";
import {
  exactKeys,
  parseAuthenticatedOperatorEvidence,
  planDigest,
  planIdentifier,
  safeInteger,
  strictArray,
  strictRecord,
} from "../validation.js";

export const planSha256: PlanDigestPort = Object.freeze({
  sha256: (text: string): string => computeChecksumOfText(text).hex,
});

const issued = new WeakMap<object, IssuedPlanCommitFacts>();
const consumed = new WeakSet<object>();

export interface C8C7PlanStoreOptions {
  /** Finite wall-clock evidence budget. In-flight adapter calls are never detached. */
  readonly evidenceDeadlineMs?: number;
  /** Injectable monotonic millisecond source used by deterministic conformance tests. */
  readonly now?: () => number;
}

interface EvidenceDeadline {
  check(): void;
}

const DEFAULT_EVIDENCE_DEADLINE_MS = 30_000;

class CursorFault extends Error {}
class EvidenceBound extends Error {}

function startEvidenceDeadline(options: C8C7PlanStoreOptions): EvidenceDeadline {
  const duration = options.evidenceDeadlineMs ?? DEFAULT_EVIDENCE_DEADLINE_MS;
  if (!Number.isSafeInteger(duration) || duration < 1) throw new EvidenceBound();
  const now = options.now ?? Date.now;
  let previous: number;
  try { previous = now(); } catch { throw new EvidenceBound(); }
  if (!Number.isFinite(previous)) throw new EvidenceBound();
  const deadline = previous + duration;
  if (!Number.isSafeInteger(deadline)) throw new EvidenceBound();
  return Object.freeze({
    check: (): void => {
      let current: number;
      try { current = now(); } catch { throw new EvidenceBound(); }
      if (!Number.isFinite(current) || current < previous || current >= deadline) throw new EvidenceBound();
      previous = current;
    },
  });
}

function freezeFacts(value: IssuedPlanCommitFacts): IssuedPlanCommitFacts {
  const authenticatedOperatorEvidence = parseAuthenticatedOperatorEvidence(value.authenticatedOperatorEvidence);
  const decisions = value.decisions.map((decision) => parseDecision(decision));
  return Object.freeze({
    projectId: value.projectId,
    contentDigest: value.contentDigest,
    operationKinds: Object.freeze([...value.operationKinds]),
    eventIds: Object.freeze([...value.eventIds]),
    authenticatedOperatorEvidence,
    decisions: Object.freeze(decisions),
  });
}

/** Synthetic only. No equivalent issuer is reachable from the production root. */
export function issueSyntheticPlanCommitAuthorization(
  request: PlanCommitRequest,
  authenticatedOperatorEvidence: readonly AuthenticatedOperatorClaimEvidence[] = [],
  decisions: readonly Decision[] = [],
): PlanCommitAuthorization {
  const token = Object.freeze(Object.create(null)) as PlanCommitAuthorization;
  issued.set(token as object, freezeFacts({
    projectId: request.projectId,
    contentDigest: request.binding.contentDigest,
    operationKinds: operationKindsOf(request),
    eventIds: request.steps.map((step) => step.eventId),
    authenticatedOperatorEvidence,
    decisions,
  }));
  return token;
}

function factsFor(
  authorization: PlanCommitAuthorization,
  request: PlanCommitRequest,
): IssuedPlanCommitFacts | null {
  if (authorization === null || typeof authorization !== "object" || consumed.has(authorization as object)) return null;
  const facts = issued.get(authorization as object);
  if (facts === undefined
    || facts.projectId !== request.projectId
    || facts.contentDigest !== request.binding.contentDigest
    || serializeCanonicalProjectJson(facts.operationKinds) !== serializeCanonicalProjectJson(operationKindsOf(request))
    || serializeCanonicalProjectJson(facts.eventIds) !== serializeCanonicalProjectJson(request.steps.map((step) => step.eventId))) {
    return null;
  }
  const eventDecisions = request.steps.flatMap((step) => [...step.event.decisions]);
  if (!decisionsMatchAuthorization(eventDecisions, facts.decisions)) return null;
  for (const step of request.steps) assertAuthenticatedOperatorEvidence(step.event.review, facts.authenticatedOperatorEvidence);
  return facts;
}

class StoredCorruption extends Error {}
class ExpectedConflict extends Error {
  constructor(readonly actualVersion: number) { super("conflict"); }
}
class StoreRefusal extends Error {
  constructor(readonly outcome: Extract<PlanCommitOutcome, { kind: "refused" }>) { super("refused"); }
}

function storedTimestamp(value: unknown): string {
  return validateAppendEventInput({
    eventId: "plan-validation:timestamp",
    aggregateType: "project-plan",
    aggregateId: "plan-validation:timestamp",
    aggregateVersion: 1,
    eventType: "plan.validation.timestamp",
    eventSchemaVersion: 1,
    payload: null,
    occurredAt: value as string,
    traceId: null,
    causationId: null,
  }, "storedTimestamp").occurredAt;
}

function verifiedEnvelope(value: unknown): AggregateEnvelope {
  try {
    const input = strictRecord(value, "planStore");
    exactKeys(input, [
      "aggregateType", "aggregateId", "schemaVersion", "aggregateVersion", "payload",
      "checksum", "createdAt", "updatedAt", "traceId",
    ], "planStore");
    const prepared = validateCreateAggregateInput({
      aggregateType: input["aggregateType"] as AggregateEnvelope["aggregateType"],
      aggregateId: input["aggregateId"] as string,
      schemaVersion: input["schemaVersion"] as number,
      payload: input["payload"],
      traceId: input["traceId"] as string | null,
    }, "storedAggregate");
    const checksum = parseChecksum(input["checksum"], "storedAggregate.checksum");
    const aggregateVersion = safeInteger(input["aggregateVersion"], "planStore");
    if (aggregateVersion < 1 || !checksumEquals(prepared.checksum, checksum)) throw new StoredCorruption();
    const createdAt = storedTimestamp(input["createdAt"]);
    const updatedAt = storedTimestamp(input["updatedAt"]);
    if (updatedAt < createdAt) throw new StoredCorruption();
    const payload = JSON.parse(prepared.payloadText) as AggregateEnvelope["payload"];
    return Object.freeze({
      aggregateType: prepared.aggregateType,
      aggregateId: prepared.aggregateId,
      schemaVersion: prepared.schemaVersion,
      aggregateVersion,
      payload,
      checksum,
      createdAt,
      updatedAt,
      traceId: prepared.traceId,
    }) as AggregateEnvelope;
  } catch (error) {
    if (error instanceof StoredCorruption) throw error;
    throw new StoredCorruption();
  }
}

function verifiedEvent(value: unknown): EventRecord {
  try {
    const input = strictRecord(value, "planStore");
    exactKeys(input, [
      "eventId", "aggregateType", "aggregateId", "aggregateVersion", "eventType",
      "eventSchemaVersion", "payload", "checksum", "occurredAt", "recordedAt",
      "globalSequence", "traceId", "causationId",
    ], "planStore");
    const prepared = validateAppendEventInput({
      eventId: input["eventId"] as string,
      aggregateType: input["aggregateType"] as EventRecord["aggregateType"],
      aggregateId: input["aggregateId"] as string,
      aggregateVersion: input["aggregateVersion"] as number,
      eventType: input["eventType"] as string,
      eventSchemaVersion: input["eventSchemaVersion"] as number,
      payload: input["payload"],
      occurredAt: input["occurredAt"] as string,
      traceId: input["traceId"] as string | null,
      causationId: input["causationId"] as string | null,
    }, "storedEvent");
    const checksum = parseChecksum(input["checksum"], "storedEvent.checksum");
    const globalSequence = safeInteger(input["globalSequence"], "planStore");
    if (globalSequence < 1 || !checksumEquals(prepared.checksum, checksum)) throw new StoredCorruption();
    const payload = JSON.parse(prepared.payloadText) as EventRecord["payload"];
    return Object.freeze({
      eventId: prepared.eventId,
      aggregateType: prepared.aggregateType,
      aggregateId: prepared.aggregateId,
      aggregateVersion: prepared.aggregateVersion,
      eventType: prepared.eventType,
      eventSchemaVersion: prepared.eventSchemaVersion,
      payload,
      checksum,
      occurredAt: prepared.occurredAt,
      recordedAt: storedTimestamp(input["recordedAt"]),
      globalSequence,
      traceId: prepared.traceId,
      causationId: prepared.causationId,
    }) as EventRecord;
  } catch (error) {
    if (error instanceof StoredCorruption) throw error;
    throw new StoredCorruption();
  }
}

function pageCursor(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new CursorFault();
  }
  return value;
}

function verifiedPage<T>(
  value: unknown,
  maximumItems: number,
  parse: (entry: unknown) => T,
): Readonly<{ items: readonly T[]; nextCursor: string | null }> {
  try {
    const input = strictRecord(value, "planStore");
    exactKeys(input, ["items", "nextCursor"], "planStore");
    const items = strictArray(input["items"], parse, "planStore", 0, maximumItems);
    return Object.freeze({ items, nextCursor: pageCursor(input["nextCursor"]) });
  } catch (error) {
    if (error instanceof CursorFault || error instanceof StoredCorruption) throw error;
    throw new StoredCorruption();
  }
}

async function scanEventRecords(
  tx: TransactionContext,
  aggregateType: "project-plan" | "project-brief",
  aggregateId: string,
  deadline: EvidenceDeadline,
  maximum = 4_096,
): Promise<readonly EventRecord[]> {
  const output: EventRecord[] = [];
  let cursor: string | null = null;
  let previousSequence = 0;
  const seen = new Set<string>();
  do {
    deadline.check();
    if (cursor !== null) {
      if (cursor.length === 0 || seen.has(cursor)) throw new CursorFault();
      seen.add(cursor);
    }
    const remaining = maximum - output.length;
    if (remaining <= 0) throw new EvidenceBound();
    const limit = Math.min(128, remaining);
    const page: Readonly<{ items: readonly EventRecord[]; nextCursor: string | null }> = verifiedPage(await tx.events.list({
      aggregateType,
      aggregateId,
      cursor,
      limit,
    }), limit, verifiedEvent);
    deadline.check();
    if (page.items.length === 0 && page.nextCursor !== null) throw new CursorFault();
    for (const record of page.items) {
      if (record.aggregateType !== aggregateType
        || record.aggregateId !== aggregateId
        || record.globalSequence <= previousSequence) throw new CursorFault();
      previousSequence = record.globalSequence;
    }
    output.push(...page.items);
    if (page.nextCursor !== null && page.nextCursor === cursor) throw new CursorFault();
    cursor = page.nextCursor;
  } while (cursor !== null);
  return Object.freeze(output);
}

function asPlanJournalEntry(record: EventRecord, digest: PlanDigestPort): PlanJournalEntry {
  const stored = verifiedEvent(record);
  if (stored.aggregateType !== "project-plan" || stored.eventSchemaVersion !== 1 || stored.eventType !== (stored.payload as { kind?: unknown }).kind) {
    throw new StoredCorruption();
  }
  let payload: PlanJournalEntry["payload"];
  try { payload = parsePlanJournalEvent(stored.payload, digest); }
  catch { throw new StoredCorruption(); }
  if (payload.kind !== stored.eventType
    || stored.aggregateId !== payload.binding.projectId
    || stored.aggregateVersion !== payload.binding.resultAggregateVersion) throw new StoredCorruption();
  try { assertPlanRecordInvariants(payload.plan, digest); }
  catch { throw new StoredCorruption(); }
  return Object.freeze({
    eventId: stored.eventId,
    aggregateType: "project-plan",
    aggregateId: stored.aggregateId,
    aggregateVersion: stored.aggregateVersion,
    eventType: payload.kind,
    eventSchemaVersion: 1,
    payload,
    payloadChecksum: stored.checksum.hex,
    occurredAt: stored.occurredAt,
    recordedAt: stored.recordedAt,
    globalSequence: stored.globalSequence,
    traceId: stored.traceId,
    causationId: stored.causationId,
  });
}

async function readPlanHeadInTransaction(
  tx: TransactionContext,
  projectId: string,
  digest: PlanDigestPort,
  deadline: EvidenceDeadline,
): Promise<PlanHeadRead> {
  const aggregateId = planLineageId(projectId);
  let envelope: AggregateEnvelope | null;
  try {
    deadline.check();
    envelope = await tx.aggregates.get("project-plan", aggregateId);
    deadline.check();
  }
  catch (error) {
    if (error instanceof EvidenceBound) return Object.freeze({ kind: "unavailable", ruleId: "plan.store.unavailable", reason: "evidence-bound-exhausted" });
    return isPersistenceError(error) && error.code === "CORRUPTION_DETECTED"
      ? Object.freeze({ kind: "corrupt", ruleId: "plan.store.corrupt" })
      : Object.freeze({ kind: "unavailable", ruleId: "plan.store.unavailable", reason: "adapter-unavailable" });
  }
  if (envelope === null) {
    try {
      const events = await scanEventRecords(tx, "project-plan", aggregateId, deadline);
      return events.length === 0
        ? Object.freeze({ kind: "absent" })
        : Object.freeze({ kind: "corrupt", ruleId: "plan.store.corrupt" });
    } catch (error) {
      if (error instanceof EvidenceBound) return Object.freeze({ kind: "unavailable", ruleId: "plan.store.unavailable", reason: "evidence-bound-exhausted" });
      if (error instanceof CursorFault) return Object.freeze({ kind: "unavailable", ruleId: "plan.store.unavailable", reason: "cursor-protocol-invalid" });
      if (isPersistenceError(error) && error.code !== "CORRUPTION_DETECTED") {
        return Object.freeze({ kind: "unavailable", ruleId: "plan.store.unavailable", reason: "adapter-unavailable" });
      }
      return Object.freeze({ kind: "corrupt", ruleId: "plan.store.corrupt" });
    }
  }
  try {
    const storedEnvelope = verifiedEnvelope(envelope);
    if (storedEnvelope.aggregateId !== aggregateId || storedEnvelope.aggregateType !== "project-plan" || storedEnvelope.schemaVersion !== 1) throw new StoredCorruption();
    const plan = assertPlanRecordInvariants(storedEnvelope.payload, digest);
    if (plan.projectId !== projectId) throw new StoredCorruption();
    const events = await scanEventRecords(tx, "project-plan", aggregateId, deadline);
    const parsedEvents = events.map((record) => asPlanJournalEntry(record, digest));
    assertAcyclicPlanChain(parsedEvents
      .filter((entry) => entry.payload.kind === "plan.drafted" || entry.payload.kind === "plan.revised")
      .map((entry) => Object.freeze({
        plan: entry.payload.plan,
        rebase: entry.payload.rebase,
        predecessor: entry.payload.predecessor,
      })));
    const candidates = parsedEvents
      .filter((record) => record.aggregateVersion === storedEnvelope.aggregateVersion)
      .filter((entry) => isHeadEvent(entry.payload)
        && entry.payload.binding.headAdvanced
        && entry.payload.binding.resultAggregateVersion === storedEnvelope.aggregateVersion
        && entry.payload.plan.planId === plan.planId
        && serializeCanonicalProjectJson(entry.payload.plan) === serializeCanonicalProjectJson(plan));
    if (candidates.length !== 1) throw new StoredCorruption();
    const headEvent = candidates[0] as PlanHeadJournalEntry;
    const acceptedBrief = acceptedBindingOf(headEvent.payload.binding);
    const head: PlanLineageHead = Object.freeze({
      aggregateId,
      aggregateVersion: storedEnvelope.aggregateVersion,
      plan,
      payloadChecksum: storedEnvelope.checksum.hex,
      acceptedBrief,
      headEvent,
    });
    return Object.freeze({ kind: "head", head });
  } catch (error) {
    if (error instanceof EvidenceBound) return Object.freeze({ kind: "unavailable", ruleId: "plan.store.unavailable", reason: "evidence-bound-exhausted" });
    if (error instanceof CursorFault) return Object.freeze({ kind: "unavailable", ruleId: "plan.store.unavailable", reason: "cursor-protocol-invalid" });
    if (isPersistenceError(error)) return error.code === "CORRUPTION_DETECTED"
      ? Object.freeze({ kind: "corrupt", ruleId: "plan.store.corrupt" })
      : Object.freeze({ kind: "unavailable", ruleId: "plan.store.unavailable", reason: "adapter-unavailable" });
    return Object.freeze({ kind: "corrupt", ruleId: "plan.store.corrupt" });
  }
}

function acceptedBindingOf(binding: PlanHeadEventPayload["binding"]): AcceptedBriefBinding {
  return Object.freeze({
    projectId: binding.projectId,
    briefId: binding.briefId,
    briefAggregateVersion: binding.briefAggregateVersion,
    briefContentDigest: binding.briefContentDigest,
    acceptedCandidateDigest: binding.acceptedCandidateDigest,
    acceptanceEventId: binding.acceptanceEventId,
  });
}

function intakeAggregateId(projectId: string, digest: PlanDigestPort): string {
  const parsedProjectId = planIdentifier(projectId, "prj:", "planBrief");
  const hash = planDigest(digest.sha256(serializeCanonicalProjectJson({ aggregateType: "project-brief", projectId: parsedProjectId })), "planBrief");
  return `project-brief:${hash.slice(0, 32)}`;
}

function parsedAcceptanceRecord(
  record: EventRecord,
  aggregateId: string,
  projectId: string,
  digest: PlanDigestPort,
): IntakeAcceptanceEventPayload {
  const parsed = parseIntakeAcceptanceEvent(record.payload, digest);
  const bindingDigest = planDigest(digest.sha256(serializeCanonicalProjectJson(parsed.binding)), "planBrief");
  if (record.aggregateType !== "project-brief"
    || record.aggregateId !== aggregateId
    || record.aggregateVersion !== parsed.aggregateVersion
    || record.eventSchemaVersion !== 1
    || record.eventType !== "project-brief.accepted"
    || record.eventId !== `intake:${bindingDigest.slice(0, 32)}`
    || record.traceId !== null
    || record.causationId !== null
    || parsed.brief.projectId !== projectId
    || record.occurredAt !== parsed.brief.createdAt
    || blockingOpenQuestionIds(parsed.brief).length !== 0) throw new StoredCorruption();
  return parsed;
}

async function readAcceptedInTransaction(
  tx: TransactionContext,
  projectId: string,
  digest: PlanDigestPort,
  deadline: EvidenceDeadline,
): Promise<AcceptedBriefRead> {
  const aggregateId = intakeAggregateId(projectId, digest);
  let envelope: AggregateEnvelope | null;
  try {
    deadline.check();
    envelope = await tx.aggregates.get("project-brief", aggregateId);
    deadline.check();
  }
  catch (error) {
    if (error instanceof EvidenceBound) return Object.freeze({ kind: "unresolved", ruleId: "plan.store.unresolved", reason: "evidence-bound-exhausted" });
    return isPersistenceError(error) && error.code === "CORRUPTION_DETECTED"
      ? Object.freeze({ kind: "invalid-proof", ruleId: "plan.brief.acceptance-proof-invalid" })
      : Object.freeze({ kind: "unresolved", ruleId: "plan.store.unresolved", reason: "adapter-unavailable" });
  }
  if (envelope === null) {
    try {
      const briefEvents = await scanEventRecords(tx, "project-brief", aggregateId, deadline);
      const plan = await tx.aggregates.get("project-plan", planLineageId(projectId));
      deadline.check();
      return plan === null && briefEvents.length === 0
        ? Object.freeze({ kind: "absent" })
        : Object.freeze({ kind: "invalid-proof", ruleId: "plan.brief.acceptance-proof-invalid" });
    } catch (error) {
      if (error instanceof EvidenceBound) return Object.freeze({ kind: "unresolved", ruleId: "plan.store.unresolved", reason: "evidence-bound-exhausted" });
      if (isPersistenceError(error) && error.code === "CORRUPTION_DETECTED") {
        return Object.freeze({ kind: "invalid-proof", ruleId: "plan.brief.acceptance-proof-invalid" });
      }
      return Object.freeze({ kind: "unresolved", ruleId: "plan.store.unresolved", reason: "adapter-unavailable" });
    }
  }
  try {
    const storedEnvelope = verifiedEnvelope(envelope);
    if (storedEnvelope.aggregateType !== "project-brief" || storedEnvelope.aggregateId !== aggregateId || storedEnvelope.schemaVersion !== 1) throw new StoredCorruption();
    const records: EventRecord[] = [];
    let cursor: string | null = null;
    let previousSequence = 0;
    const seen = new Set<string>();
    do {
      deadline.check();
      if (cursor !== null) {
        if (cursor.length === 0 || seen.has(cursor)) throw new CursorFault();
        seen.add(cursor);
      }
      if (records.length >= 4_096) throw new EvidenceBound();
      const limit = Math.min(128, 4_096 - records.length);
      const page: Readonly<{ items: readonly EventRecord[]; nextCursor: string | null }> = verifiedPage(
        await tx.events.list({ aggregateType: "project-brief", aggregateId, cursor, limit }),
        limit,
        verifiedEvent,
      );
      deadline.check();
      if (page.items.length === 0 && page.nextCursor !== null || page.nextCursor !== null && page.nextCursor === cursor) throw new CursorFault();
      for (const record of page.items) {
        if (record.aggregateType !== "project-brief"
          || record.aggregateId !== aggregateId
          || record.globalSequence <= previousSequence) throw new CursorFault();
        previousSequence = record.globalSequence;
      }
      records.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    const acceptanceRecords = records.filter((record) => record.eventType === "project-brief.accepted");
    if (acceptanceRecords.length !== storedEnvelope.aggregateVersion || acceptanceRecords.length !== records.length) {
      throw new StoredCorruption();
    }
    let previousBriefId: string | null = null;
    let parsed: IntakeAcceptanceEventPayload | null = null;
    let record: EventRecord | null = null;
    for (let version = 1; version <= storedEnvelope.aggregateVersion; version += 1) {
      const matches = acceptanceRecords.filter((candidate) => candidate.aggregateVersion === version);
      if (matches.length !== 1) throw new StoredCorruption();
      const candidate = matches[0]!;
      const candidatePayload = parsedAcceptanceRecord(candidate, aggregateId, projectId, digest);
      if (candidatePayload.binding.expectedAggregateVersion !== version - 1
        || candidatePayload.binding.expectedHeadBriefId !== previousBriefId
        || candidatePayload.brief.supersedes !== previousBriefId) throw new StoredCorruption();
      previousBriefId = candidatePayload.brief.briefId;
      parsed = candidatePayload;
      record = candidate;
    }
    if (parsed === null || record === null
      || parsed.aggregateVersion !== storedEnvelope.aggregateVersion
      || parsed.brief.briefId !== (storedEnvelope.payload as { briefId?: unknown }).briefId
      || serializeCanonicalProjectJson(parsed.brief) !== serializeCanonicalProjectJson(storedEnvelope.payload)
      || parsed.binding.expectedAggregateVersion !== storedEnvelope.aggregateVersion - 1) {
      throw new StoredCorruption();
    }
    const briefContentDigest = planDigest(digest.sha256(serializeCanonicalProjectJson(parsed.brief)), "planBrief");
    deadline.check();
    const head: AcceptedBriefHead = Object.freeze({
      projectId,
      aggregateId,
      aggregateVersion: storedEnvelope.aggregateVersion,
      brief: parsed.brief,
      briefContentDigest,
      acceptedCandidateDigest: parsed.binding.candidateDigest,
      acceptanceEventId: record.eventId,
    });
    return Object.freeze({ kind: "accepted", head });
  } catch (error) {
    if (error instanceof EvidenceBound) return Object.freeze({ kind: "unresolved", ruleId: "plan.store.unresolved", reason: "evidence-bound-exhausted" });
    if (error instanceof CursorFault) return Object.freeze({ kind: "unresolved", ruleId: "plan.store.unresolved", reason: "cursor-protocol-invalid" });
    if (isPersistenceError(error)) return error.code === "CORRUPTION_DETECTED"
      ? Object.freeze({ kind: "invalid-proof", ruleId: "plan.brief.acceptance-proof-invalid" })
      : Object.freeze({ kind: "unresolved", ruleId: "plan.store.unresolved", reason: "adapter-unavailable" });
    return Object.freeze({ kind: "invalid-proof", ruleId: "plan.brief.acceptance-proof-invalid" });
  }
}

function sameAccepted(left: AcceptedBriefBinding, right: AcceptedBriefBinding): boolean {
  return serializeCanonicalProjectJson(left) === serializeCanonicalProjectJson(right);
}

async function currentProjectAndControls(
  tx: TransactionContext,
  projectId: string,
  digest: PlanDigestPort,
  deadline: EvidenceDeadline,
): Promise<Readonly<{ project: Project; controls: PlanMutationControlEvidence }>> {
  let envelope: AggregateEnvelope | null;
  try {
    deadline.check();
    envelope = await tx.aggregates.get("project", projectId);
    deadline.check();
  }
  catch (error) {
    throw isPersistenceError(error) && error.code === "CORRUPTION_DETECTED"
      ? refusal("PLAN_STORE_CORRUPT", "plan.store.corrupt")
      : refusal("PLAN_STORE_UNAVAILABLE", "plan.store.unavailable");
  }
  if (envelope === null) throw refusal("PLAN_PRECONDITION_REFUSED", "plan.project.not-active");
  try { envelope = verifiedEnvelope(envelope); } catch { throw refusal("PLAN_STORE_CORRUPT", "plan.store.corrupt"); }
  if (envelope.aggregateType !== "project" || envelope.aggregateId !== projectId || envelope.schemaVersion !== 1) {
    throw refusal("PLAN_STORE_CORRUPT", "plan.store.corrupt");
  }
  let project: Project;
  try { project = parseProject(envelope.payload); }
  catch { throw refusal("PLAN_STORE_CORRUPT", "plan.store.corrupt"); }
  if (project.projectId !== projectId) throw refusal("PLAN_VALIDATION_REFUSED", "plan.project.mismatch");
  if (project.status !== "active") throw refusal("PLAN_PRECONDITION_REFUSED", "plan.project.not-active");
  const matchingStops: Readonly<Record<string, unknown>>[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  let examined = 0;
  let previousAggregateId: string | null = null;
  do {
    try { deadline.check(); } catch { throw refusal("PLAN_STORE_UNAVAILABLE", "plan.store.unavailable"); }
    if (cursor !== null) {
      if (cursor.length === 0 || seen.has(cursor)) throw refusal("PLAN_VALIDATION_REFUSED", "plan.store.cursor-invalid");
      seen.add(cursor);
    }
    if (examined >= 4_096) throw refusal("PLAN_STORE_UNAVAILABLE", "plan.store.unavailable");
    let page;
    const limit = Math.min(128, 4_096 - examined);
    try {
      page = verifiedPage(
        await tx.aggregates.list({ aggregateType: "project-stop", cursor, limit }),
        limit,
        verifiedEnvelope,
      );
      deadline.check();
    }
    catch (error) {
      if (error instanceof CursorFault) throw refusal("PLAN_VALIDATION_REFUSED", "plan.store.cursor-invalid");
      if (error instanceof StoredCorruption) throw refusal("PLAN_STORE_CORRUPT", "plan.store.corrupt");
      if (isPersistenceError(error) && error.code === "INVALID_CURSOR") throw refusal("PLAN_VALIDATION_REFUSED", "plan.store.cursor-invalid");
      if (isPersistenceError(error) && error.code === "CORRUPTION_DETECTED") throw refusal("PLAN_STORE_CORRUPT", "plan.store.corrupt");
      throw refusal("PLAN_STORE_UNAVAILABLE", "plan.store.unavailable");
    }
    if (page.items.length === 0 && page.nextCursor !== null || page.nextCursor !== null && page.nextCursor === cursor) {
      throw refusal("PLAN_VALIDATION_REFUSED", "plan.store.cursor-invalid");
    }
    examined += page.items.length;
    for (const stopEnvelopeValue of page.items) {
      try {
        const stopEnvelope = verifiedEnvelope(stopEnvelopeValue);
        if (previousAggregateId !== null && stopEnvelope.aggregateId <= previousAggregateId) throw new CursorFault();
        previousAggregateId = stopEnvelope.aggregateId;
        const stop = parseProjectStop(stopEnvelope.payload);
        if (stopEnvelope.aggregateType !== "project-stop"
          || stopEnvelope.schemaVersion !== 1
          || stopEnvelope.aggregateId !== stop.projectStopId) throw new StoredCorruption();
        if (stop.projectId !== projectId) continue;
        if (isProjectStopActive(stop)) throw refusal("PLAN_PRECONDITION_REFUSED", "plan.project.stopped");
        matchingStops.push(Object.freeze({
          aggregateType: stopEnvelope.aggregateType,
          aggregateId: stopEnvelope.aggregateId,
          schemaVersion: stopEnvelope.schemaVersion,
          aggregateVersion: stopEnvelope.aggregateVersion,
          payload: stopEnvelope.payload,
          checksum: stopEnvelope.checksum,
          createdAt: stopEnvelope.createdAt,
          updatedAt: stopEnvelope.updatedAt,
          traceId: stopEnvelope.traceId,
        }));
      } catch (error) {
        if (error instanceof StoreRefusal) throw error;
        if (error instanceof CursorFault) throw refusal("PLAN_VALIDATION_REFUSED", "plan.store.cursor-invalid");
        throw refusal("PLAN_STORE_CORRUPT", "plan.store.corrupt");
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  try { deadline.check(); } catch { throw refusal("PLAN_STORE_UNAVAILABLE", "plan.store.unavailable"); }
  return Object.freeze({
    project,
    controls: Object.freeze({
      projectAggregateVersion: envelope.aggregateVersion,
      projectContentDigest: envelope.checksum.hex,
      projectStatus: "active",
      projectStopSnapshotDigest: projectStopSnapshotDigestMaterial(projectId, matchingStops, digest),
      activeProjectStopIds: Object.freeze([] as const),
    }),
  });
}

function refusal(code: PlanRefusalCode, ruleId: string): StoreRefusal {
  return new StoreRefusal({ kind: "refused", code, ruleId });
}

function eventPlanAfterC6Transition(
  plan: ProjectPlan,
  event: PlanEvent,
  updatedAt: string,
  sealedAt: string | null = plan.sealedAt,
): ProjectPlan {
  try {
    const state = transition(PLAN_STATE_MACHINE, plan.state, event);
    return parseProjectPlan({ ...plan, state, updatedAt, sealedAt, sealedByApprovalId: null });
  }
  catch { throw refusal("PLAN_PRECONDITION_REFUSED", "plan.state.illegal"); }
}

function expectedFromCurrent(current: ProjectPlan, event: PlanHeadEventPayload, occurredAt: string): ProjectPlan {
  switch (event.kind) {
    case "plan.proposed":
      return eventPlanAfterC6Transition(current, "validation-passed", occurredAt, null);
    case "plan.scope-approval-required":
      return eventPlanAfterC6Transition(current, "scope-approval-required", occurredAt, null);
    case "plan.scope-rejected":
      return eventPlanAfterC6Transition(current, "scope-rejected", occurredAt, null);
    case "plan.sealed":
      return eventPlanAfterC6Transition(current, "seal", occurredAt, occurredAt);
    case "plan.superseded":
      return eventPlanAfterC6Transition(
        current,
        current.state === "proposed" ? "draft-new-revision" : "seal-new-revision",
        occurredAt,
        current.sealedAt,
      );
    case "plan.abandoned":
      return eventPlanAfterC6Transition(current, "abandon", occurredAt, null);
    default: throw refusal("PLAN_VALIDATION_REFUSED", "plan.proposal.malformed");
  }
}

function samePlan(left: ProjectPlan, right: ProjectPlan): boolean {
  return serializeCanonicalProjectJson(left) === serializeCanonicalProjectJson(right);
}

function predecessorStamp(plan: ProjectPlan): PlanPredecessorEvidence {
  if (plan.state !== "drafting" && plan.state !== "superseded") {
    throw refusal("PLAN_VALIDATION_REFUSED", "plan.lineage.not-successor");
  }
  return Object.freeze({
    planId: plan.planId,
    revision: plan.revision,
    supersedes: plan.supersedes,
    state: plan.state,
    planDigest: plan.planDigest,
    sealedAt: plan.sealedAt,
    sealedByApprovalId: null,
  }) as PlanPredecessorEvidence;
}

function rebaseLink(
  previous: ProjectPlan,
  accepted: AcceptedBriefHead,
  disposition: "draft-replaced" | "superseded",
): PlanRebaseLink {
  const binding = acceptedBindingFromHead(accepted);
  return disposition === "draft-replaced"
    ? Object.freeze({
        kind: "plan.rebased" as const,
        replaces: previous.planId,
        replacesRevision: previous.revision,
        previousDisposition: Object.freeze({ kind: "draft-replaced" as const, from: "drafting" as const }),
        ...binding,
      })
    : Object.freeze({
        kind: "plan.rebased" as const,
        replaces: previous.planId,
        replacesRevision: previous.revision,
        previousDisposition: Object.freeze({
          kind: "superseded" as const,
          from: previous.state as "proposed" | "sealed",
          to: "superseded" as const,
        }),
        ...binding,
      });
}

function assertSameEventValue(actual: unknown, expected: unknown, ruleId = "plan.revision.stale"): void {
  if (serializeCanonicalProjectJson(actual) !== serializeCanonicalProjectJson(expected)) {
    throw refusal("PLAN_VALIDATION_REFUSED", ruleId);
  }
}

function deriveExpected(
  step: PlanCommitRequest["steps"][number],
  current: PlanLineageHead | null,
  project: Project,
  accepted: AcceptedBriefHead | null,
  digest: PlanDigestPort,
): ProjectPlan | null {
  const event = step.event;
  if (event.kind === "plan.budget-extended") {
    if (current === null) throw refusal("PLAN_PRECONDITION_REFUSED", "plan.head.absent");
    if (!["drafting", "proposed", "awaiting_scope_approval"].includes(current.plan.state)) {
      throw refusal("PLAN_PRECONDITION_REFUSED", "plan.state.illegal");
    }
    if (!samePlan(event.plan, current.plan)) throw refusal("PLAN_VALIDATION_REFUSED", "plan.revision.stale");
    if (!sameCanonicalReview(current.headEvent.payload.review, event.review)) {
      throw refusal("PLAN_AUTHORITY_VIOLATION", "plan.coverage.provenance-inconsistent");
    }
    const task = current.plan.tasks.find((candidate) => candidate.taskId === event.budgetExtension.taskId);
    const decision = event.decisions[0];
    if (task === undefined
      || !samePlanBudget(task.budget, event.budgetExtension.previousBudget)
      || decision.scope.taskId !== task.taskId
      || event.budgetExtension.decisionId !== decision.decisionId) {
      throw refusal("PLAN_VALIDATION_REFUSED", "plan.decision.budget-extension-shape");
    }
    return null;
  }
  if (event.kind === "plan.drafted" || event.kind === "plan.revised") {
    if (accepted === null) throw refusal("PLAN_PRECONDITION_REFUSED", "plan.brief.absent");
    let coordinates: PlanRecordCoordinates;
    if (event.kind === "plan.drafted" && event.operation.mode === "create") {
      if (current !== null) throw new ExpectedConflict(current.aggregateVersion);
      coordinates = Object.freeze({ planId: event.plan.planId, revision: 1, supersedes: null, state: "drafting", createdAt: step.envelope.occurredAt, updatedAt: step.envelope.occurredAt, sealedAt: null });
      assertSameEventValue(event.predecessor, null);
      assertSameEventValue(event.rebase, null);
    } else if (event.kind === "plan.drafted") {
      if (current === null || current.plan.state !== "drafting") throw refusal("PLAN_PRECONDITION_REFUSED", "plan.state.illegal");
      if (event.plan.planId === current.plan.planId) throw refusal("PLAN_VALIDATION_REFUSED", "plan.lineage.not-successor");
      const sameBrief = current.plan.briefId === accepted.brief.briefId;
      coordinates = Object.freeze({
        planId: event.plan.planId,
        revision: sameBrief ? current.plan.revision : 1,
        supersedes: sameBrief ? current.plan.supersedes : null,
        state: "drafting",
        createdAt: step.envelope.occurredAt,
        updatedAt: step.envelope.occurredAt,
        sealedAt: null,
      });
      assertSameEventValue(event.predecessor, predecessorStamp(current.plan));
      assertSameEventValue(
        event.rebase,
        sameBrief ? current.headEvent.payload.rebase : rebaseLink(current.plan, accepted, "draft-replaced"),
        "plan.lineage.not-rebase",
      );
    } else {
      if (current === null || !["proposed", "sealed"].includes(current.plan.state)) throw refusal("PLAN_PRECONDITION_REFUSED", "plan.state.illegal");
      if (event.plan.planId === current.plan.planId) throw refusal("PLAN_VALIDATION_REFUSED", "plan.lineage.not-successor");
      const sameBrief = current.plan.briefId === accepted.brief.briefId;
      if ((event.operation.mode === "R1") !== sameBrief) throw refusal("PLAN_VALIDATION_REFUSED", "plan.lineage.not-rebase");
      const superseded = eventPlanAfterC6Transition(
        current.plan,
        current.plan.state === "proposed" ? "draft-new-revision" : "seal-new-revision",
        step.envelope.occurredAt,
        current.plan.sealedAt,
      );
      coordinates = Object.freeze({
        planId: event.plan.planId,
        revision: sameBrief ? current.plan.revision + 1 : 1,
        supersedes: sameBrief ? current.plan.planId : null,
        state: "drafting",
        createdAt: step.envelope.occurredAt,
        updatedAt: step.envelope.occurredAt,
        sealedAt: null,
      });
      assertSameEventValue(event.predecessor, predecessorStamp(superseded));
      assertSameEventValue(event.rebase, sameBrief ? null : rebaseLink(current.plan, accepted, "superseded"), "plan.lineage.not-rebase");
    }
    const assembled = assemblePlan(event.review.assemblyRequest, project, accepted, coordinates, digest);
    if (!sameReviewExceptAuthentication(assembled.review, event.review)) throw refusal("PLAN_AUTHORITY_VIOLATION", "plan.coverage.provenance-inconsistent");
    if (event.kind === "plan.revised" && event.operation.mode === "R1") {
      try { assertNewPlanRevision(current!.plan, assembled.plan); }
      catch { throw refusal("PLAN_VALIDATION_REFUSED", "plan.lineage.not-successor"); }
    }
    if (event.kind === "plan.revised" && event.operation.mode === "R2"
      && (assembled.plan.revision !== 1
        || assembled.plan.supersedes !== null
        || assembled.plan.briefId === current!.plan.briefId
        || assembled.plan.projectId !== current!.plan.projectId)) {
      throw refusal("PLAN_VALIDATION_REFUSED", "plan.lineage.not-rebase");
    }
    if ((event.kind === "plan.drafted" && event.operation.mode === "redraft" && assembled.plan.briefId !== current!.plan.briefId)
      || event.kind === "plan.revised" && event.operation.mode === "R2") {
      try {
        assertRebasedPlanLineage(
          current!.plan,
          assembled.plan,
          current!.acceptedBrief,
          acceptedBindingFromHead(accepted),
          event.rebase!,
        );
      } catch {
        throw refusal("PLAN_VALIDATION_REFUSED", "plan.lineage.not-rebase");
      }
    }
    return assembled.plan;
  }
  if (current === null) throw refusal("PLAN_PRECONDITION_REFUSED", "plan.head.absent");
  if (!sameCanonicalReview(current.headEvent.payload.review, event.review)) {
    throw refusal("PLAN_AUTHORITY_VIOLATION", "plan.coverage.provenance-inconsistent");
  }
  return expectedFromCurrent(current.plan, event, step.envelope.occurredAt);
}

function samePlanBudget(left: ProjectPlan["budgetCeiling"], right: ProjectPlan["budgetCeiling"]): boolean {
  return serializeCanonicalProjectJson(left) === serializeCanonicalProjectJson(right);
}

function sameCanonicalReview(left: PlanHeadEventPayload["review"], right: PlanHeadEventPayload["review"]): boolean {
  return serializeCanonicalProjectJson(left) === serializeCanonicalProjectJson(right);
}

function sameReviewExceptAuthentication(left: PlanHeadEventPayload["review"], right: PlanHeadEventPayload["review"]): boolean {
  return serializeCanonicalProjectJson({ ...left, authenticatedOperatorEvidence: [] })
    === serializeCanonicalProjectJson({ ...right, authenticatedOperatorEvidence: [] });
}

async function commit(
  adapter: PersistenceAdapter,
  requestValue: PlanCommitRequest,
  authorization: PlanCommitAuthorization,
  digest: PlanDigestPort,
  options: C8C7PlanStoreOptions,
): Promise<PlanCommitOutcome> {
  let request: PlanCommitRequest;
  let facts: IssuedPlanCommitFacts | null;
  try {
    request = parsePlanCommitRequest(requestValue, digest);
    assertCompleteMutationShape(request);
    facts = factsFor(authorization, request);
  } catch (error) {
    if (error instanceof Error && "code" in error && "ruleId" in error) {
      return Object.freeze({ kind: "refused", code: error.code as never, ruleId: String(error.ruleId) });
    }
    return Object.freeze({ kind: "refused", code: "PLAN_AUTHORITY_VIOLATION", ruleId: "plan.provenance.operator-claim-unbacked" });
  }
  if (facts === null) return Object.freeze({ kind: "refused", code: "PLAN_AUTHORITY_VIOLATION", ruleId: "plan.provenance.operator-claim-unbacked" });
  let deadline: EvidenceDeadline;
  try {
    deadline = startEvidenceDeadline(options);
    deadline.check();
  } catch {
    return Object.freeze({ kind: "refused", code: "PLAN_STORE_UNAVAILABLE", ruleId: "plan.store.unavailable" });
  }
  consumed.add(authorization as object);
  issued.delete(authorization as object);
  let mutationStarted = false;
  try {
    const finalVersion = await adapter.transact(async (tx) => {
      deadline.check();
      const { project, controls } = await currentProjectAndControls(tx, request.projectId, digest, deadline);
      if (serializeCanonicalProjectJson(controls) !== serializeCanonicalProjectJson(request.expectedControls)) {
        throw refusal("PLAN_PRECONDITION_REFUSED", "plan.proposal.stale");
      }
      const operations = operationKindsOf(request);
      const briefExempt = operations.every((operation) => operation === "abandon" || operation === "discard-stale");
      let accepted: AcceptedBriefHead | null = null;
      if (!briefExempt) {
        const acceptedRead = await readAcceptedInTransaction(tx, request.projectId, digest, deadline);
        if (acceptedRead.kind === "unresolved") throw new BriefUnresolved();
        if (acceptedRead.kind === "absent") throw refusal("PLAN_PRECONDITION_REFUSED", "plan.brief.absent");
        if (acceptedRead.kind === "invalid-proof") throw refusal("PLAN_STORE_CORRUPT", "plan.brief.acceptance-proof-invalid");
        accepted = acceptedRead.head;
        if (!sameAccepted(request.acceptedBrief, acceptedBindingFromHead(accepted))) {
          throw refusal("PLAN_PRECONDITION_REFUSED", "plan.brief.superseded");
        }
      }
      const headRead = await readPlanHeadInTransaction(tx, request.projectId, digest, deadline);
      if (headRead.kind === "corrupt") throw refusal("PLAN_STORE_CORRUPT", "plan.store.corrupt");
      if (headRead.kind === "unavailable") throw refusal("PLAN_STORE_UNAVAILABLE", "plan.store.unavailable");
      let head = headRead.kind === "head" ? headRead.head : null;
      if ((head?.aggregateVersion ?? 0) !== request.binding.expectedAggregateVersion
        || (head?.plan.planId ?? null) !== request.binding.expectedHeadPlanId) {
        throw new ExpectedConflict(head?.aggregateVersion ?? 0);
      }
      if (briefExempt && head !== null && !sameAccepted(request.acceptedBrief, head.acceptedBrief)) {
        throw refusal("PLAN_VALIDATION_REFUSED", "plan.revision.stale");
      }

      let aggregateVersion = head?.aggregateVersion ?? 0;
      for (const step of request.steps) {
        const event = step.event;
        if (step.expectedState !== (head?.plan.state ?? null)) throw new ExpectedConflict(aggregateVersion);
        if (head !== null && ["promote", "require-scope-approval", "seal"].includes(event.operation.kind)
          && (head.headEvent.payload.controls.projectAggregateVersion !== controls.projectAggregateVersion
            || head.headEvent.payload.controls.projectContentDigest !== controls.projectContentDigest)) {
          throw refusal("PLAN_PRECONDITION_REFUSED", "plan.proposal.stale");
        }
        const expected = deriveExpected(step, head, project, accepted, digest);
        if (expected !== null && (step.plan === null || !samePlan(expected, step.plan) || !samePlan(expected, event.plan))) {
          throw refusal("PLAN_VALIDATION_REFUSED", "plan.revision.stale");
        }
        if (event.kind === "plan.sealed") {
          if (accepted === null) throw refusal("PLAN_PRECONDITION_REFUSED", "plan.brief.absent");
          let accountEnvelope: AggregateEnvelope | null;
          try {
            deadline.check();
            accountEnvelope = await tx.aggregates.get("budget-account", project.budgetAccountId);
            deadline.check();
          }
          catch (error) {
            throw isPersistenceError(error) && error.code === "CORRUPTION_DETECTED"
              ? refusal("PLAN_STORE_CORRUPT", "plan.store.corrupt")
              : refusal("PLAN_STORE_UNAVAILABLE", "plan.store.unavailable");
          }
          if (accountEnvelope === null) throw refusal("PLAN_PRECONDITION_REFUSED", "plan.budget.ceiling-conflict");
          let account: BudgetAccountState;
          try {
            accountEnvelope = verifiedEnvelope(accountEnvelope);
            if (accountEnvelope.aggregateType !== "budget-account"
              || accountEnvelope.aggregateId !== project.budgetAccountId
              || accountEnvelope.schemaVersion !== 1) throw new StoredCorruption();
            account = parseBudgetAccountState(accountEnvelope.payload);
          }
          catch { throw refusal("PLAN_STORE_CORRUPT", "plan.store.corrupt"); }
          const ceiling = resolveProjectCeiling(project.budgetAccountId, account, {
            aggregateVersion: accountEnvelope.aggregateVersion,
            contentDigest: accountEnvelope.checksum.hex,
          }, accepted);
          const verdicts = assertSealConditions({
            plan: expected!,
            review: event.review,
            acceptedBrief: accepted,
            project,
            controls,
            resolvedProjectCeiling: ceiling,
            authenticatedDecisions: facts.decisions,
            scopeApproval: null,
          });
          if (event.seal === null
            || serializeCanonicalProjectJson(event.seal.verdicts) !== serializeCanonicalProjectJson(verdicts)
            || serializeCanonicalProjectJson(event.seal.blockingQuestionIds) !== serializeCanonicalProjectJson(blockingOpenQuestionIds(accepted.brief))
            || serializeCanonicalProjectJson(event.seal.resolvedProjectCeiling) !== serializeCanonicalProjectJson(ceiling)
            || event.seal.sealedByApprovalId !== null
            || event.seal.sealedAt !== step.envelope.occurredAt) {
            throw refusal("PLAN_AUTHORITY_VIOLATION", "plan.seal.metadata");
          }
        }

        if (event.kind === "plan.budget-extended") {
          deadline.check();
          mutationStarted = true;
          const record = await tx.events.append({
            eventId: step.eventId,
            aggregateType: "project-plan",
            aggregateId: planLineageId(request.projectId),
            aggregateVersion,
            eventType: event.kind,
            eventSchemaVersion: 1,
            payload: event,
            occurredAt: step.envelope.occurredAt,
            traceId: step.envelope.traceId,
            causationId: step.envelope.causationId,
          });
          const journal = asPlanJournalEntry(record, digest);
          if (record.eventId !== step.eventId
            || !sameEnvelope(journal, step.envelope)
            || serializeCanonicalProjectJson(journal.payload) !== serializeCanonicalProjectJson(event)) throw new StoredCorruption();
          continue;
        }
        const plan = expected!;
        deadline.check();
        mutationStarted = true;
        const envelope = verifiedEnvelope(aggregateVersion === 0
          ? await tx.aggregates.create({ aggregateType: "project-plan", aggregateId: planLineageId(request.projectId), schemaVersion: 1, payload: plan, traceId: step.envelope.traceId })
          : await tx.aggregates.update({ aggregateType: "project-plan", aggregateId: planLineageId(request.projectId), schemaVersion: 1, payload: plan, expectedVersion: aggregateVersion, traceId: step.envelope.traceId }));
        aggregateVersion = envelope.aggregateVersion;
        if (envelope.aggregateType !== "project-plan"
          || envelope.aggregateId !== planLineageId(request.projectId)
          || envelope.schemaVersion !== 1
          || envelope.traceId !== step.envelope.traceId
          || !samePlan(envelope.payload as unknown as ProjectPlan, plan)) throw new StoredCorruption();
        if (aggregateVersion !== event.binding.resultAggregateVersion) throw new ExpectedConflict(aggregateVersion);
        const record = await tx.events.append({
          eventId: step.eventId,
          aggregateType: "project-plan",
          aggregateId: planLineageId(request.projectId),
          aggregateVersion,
          eventType: event.kind,
          eventSchemaVersion: 1,
          payload: event,
          occurredAt: step.envelope.occurredAt,
          traceId: step.envelope.traceId,
          causationId: step.envelope.causationId,
        });
        const journal = asPlanJournalEntry(record, digest) as PlanHeadJournalEntry;
        if (journal.eventId !== step.eventId
          || !sameEnvelope(journal, step.envelope)
          || serializeCanonicalProjectJson(journal.payload) !== serializeCanonicalProjectJson(event)) throw new StoredCorruption();
        head = Object.freeze({
          aggregateId: planLineageId(request.projectId),
          aggregateVersion,
          plan,
          payloadChecksum: envelope.checksum.hex,
          acceptedBrief: acceptedBindingOf(event.binding),
          headEvent: journal,
        });
      }
      return aggregateVersion;
    });
    return Object.freeze({ kind: "committed", aggregateVersion: finalVersion, evidence: "receipt" });
  } catch (error) {
    if (error instanceof BriefUnresolved) return Object.freeze({ kind: "not-attempted", reason: "brief-evidence-unresolved", ruleId: "plan.store.unresolved" });
    if (error instanceof ExpectedConflict) return Object.freeze({ kind: "conflict", actualVersion: error.actualVersion });
    if (error instanceof StoreRefusal) return error.outcome;
    if (isPlanContractError(error)) return Object.freeze({ kind: "refused", code: error.code, ruleId: error.ruleId });
    if (isPersistenceError(error)) {
      if (["CONCURRENCY_CONFLICT", "NOT_FOUND", "DUPLICATE_ID"].includes(error.code)) return Object.freeze({ kind: "conflict", actualVersion: request.binding.expectedAggregateVersion });
      if (error.code === "STORAGE_FAILURE") return mutationStarted
        ? Object.freeze({ kind: "unknown" })
        : Object.freeze({ kind: "refused", code: "PLAN_STORE_UNAVAILABLE", ruleId: "plan.store.unavailable" });
      return Object.freeze({ kind: "refused", code: "PLAN_STORE_UNAVAILABLE", ruleId: "plan.store.unavailable" });
    }
    return mutationStarted
      ? Object.freeze({ kind: "unknown" })
      : Object.freeze({ kind: "refused", code: "PLAN_STORE_UNAVAILABLE", ruleId: "plan.store.unavailable" });
  }
}

function sameEnvelope(entry: PlanJournalEntry, envelope: PlanCommitRequest["steps"][number]["envelope"]): boolean {
  return entry.occurredAt === envelope.occurredAt
    && entry.traceId === envelope.traceId
    && entry.causationId === envelope.causationId;
}

class BriefUnresolved extends Error {}

function acceptedBindingFromHead(head: AcceptedBriefHead): AcceptedBriefBinding {
  return Object.freeze({
    projectId: head.projectId,
    briefId: head.brief.briefId,
    briefAggregateVersion: head.aggregateVersion,
    briefContentDigest: head.briefContentDigest,
    acceptedCandidateDigest: head.acceptedCandidateDigest,
    acceptanceEventId: head.acceptanceEventId,
  });
}

async function readJournal(
  adapter: PersistenceAdapter,
  projectId: string,
  window: PlanJournalWindow,
  digest: PlanDigestPort,
  options: C8C7PlanStoreOptions,
): Promise<PlanJournalRead> {
  let parsedProjectId: string;
  let parsedWindow: PlanJournalWindow;
  try {
    parsedProjectId = planLineageId(projectId);
    const input = strictRecord(window, "planStore");
    exactKeys(input, ["limit", "cursor"], "planStore");
    const limit = safeInteger(input["limit"], "planStore", 128);
    if (limit < 1) throw new CursorFault();
    parsedWindow = Object.freeze({ limit, cursor: pageCursor(input["cursor"]) });
  } catch {
    return Object.freeze({ kind: "cursor-invalid", ruleId: "plan.store.cursor-invalid" });
  }
  try {
    const deadline = startEvidenceDeadline(options);
    deadline.check();
    return await adapter.transact(async (tx) => {
      deadline.check();
      const page = verifiedPage(
        await tx.events.list({ aggregateType: "project-plan", aggregateId: parsedProjectId, limit: parsedWindow.limit, cursor: parsedWindow.cursor }),
        parsedWindow.limit,
        verifiedEvent,
      );
      deadline.check();
      if (page.items.length === 0 && page.nextCursor !== null || page.nextCursor !== null && page.nextCursor === parsedWindow.cursor) {
        return Object.freeze({ kind: "cursor-invalid" as const, ruleId: "plan.store.cursor-invalid" as const });
      }
      let previousSequence = 0;
      for (const record of page.items) {
        if (record.aggregateType !== "project-plan"
          || record.aggregateId !== parsedProjectId
          || record.globalSequence <= previousSequence) throw new CursorFault();
        previousSequence = record.globalSequence;
      }
      const events = page.items.map((record) => asPlanJournalEntry(record, digest));
      deadline.check();
      return Object.freeze({ kind: "page" as const, page: Object.freeze({ events: Object.freeze(events), nextCursor: page.nextCursor }) });
    });
  } catch (error) {
    if (error instanceof EvidenceBound) return Object.freeze({ kind: "unavailable", ruleId: "plan.store.unavailable", reason: "evidence-bound-exhausted" });
    if (error instanceof CursorFault) return Object.freeze({ kind: "cursor-invalid", ruleId: "plan.store.cursor-invalid" });
    if (isPersistenceError(error) && error.code === "INVALID_CURSOR") return Object.freeze({ kind: "cursor-invalid", ruleId: "plan.store.cursor-invalid" });
    if (isPersistenceError(error) && error.code === "CORRUPTION_DETECTED") return Object.freeze({ kind: "corrupt", ruleId: "plan.store.corrupt" });
    if (error instanceof StoredCorruption) return Object.freeze({ kind: "corrupt", ruleId: "plan.store.corrupt" });
    return Object.freeze({ kind: "unavailable", ruleId: "plan.store.unavailable", reason: "adapter-unavailable" });
  }
}

export function createC8C7PlanStore(
  adapter: PersistenceAdapter,
  digest: PlanDigestPort = planSha256,
  options: C8C7PlanStoreOptions = Object.freeze({}),
): PlanStore {
  return Object.freeze({
    readHead: async (projectId: string): Promise<PlanHeadRead> => {
      try {
        const deadline = startEvidenceDeadline(options);
        deadline.check();
        return await adapter.transact((tx) => readPlanHeadInTransaction(tx, projectId, digest, deadline));
      }
      catch (error) {
        return error instanceof EvidenceBound
          ? Object.freeze({ kind: "unavailable", ruleId: "plan.store.unavailable", reason: "evidence-bound-exhausted" })
          : Object.freeze({ kind: "unavailable", ruleId: "plan.store.unavailable", reason: "adapter-unavailable" });
      }
    },
    readAcceptedBriefHead: async (projectId: string): Promise<AcceptedBriefRead> => {
      try {
        const deadline = startEvidenceDeadline(options);
        deadline.check();
        return await adapter.transact((tx) => readAcceptedInTransaction(tx, projectId, digest, deadline));
      }
      catch (error) {
        return error instanceof EvidenceBound
          ? Object.freeze({ kind: "unresolved", ruleId: "plan.store.unresolved", reason: "evidence-bound-exhausted" })
          : Object.freeze({ kind: "unresolved", ruleId: "plan.store.unresolved", reason: "adapter-unavailable" });
      }
    },
    commit: (request: PlanCommitRequest, authorization: PlanCommitAuthorization): Promise<PlanCommitOutcome> => commit(adapter, request, authorization, digest, options),
    readJournal: (projectId: string, window: PlanJournalWindow): Promise<PlanJournalRead> => readJournal(adapter, projectId, window, digest, options),
  });
}

export function c8AcceptedBriefAggregateId(projectId: string, digest: PlanDigestPort = planSha256): string {
  return intakeAggregateId(projectId, digest);
}

export type { IntakeAcceptanceEventPayload };
