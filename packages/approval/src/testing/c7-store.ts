import {
  computeChecksumOfText, isPersistenceError, parseChecksum, verifyChecksum,
  type AggregateEnvelope, type EventRecord, type PersistenceAdapter, type TransactionContext,
} from "@ai-dev-os/persistence";
import { ProjectContractError, parseProject, parseProjectStop, serializeCanonicalProjectJson } from "@ai-dev-os/project";
import type {
  ApprovalApplicationAdapter, ApprovalAuthorization, ApprovalBinding, ApprovalControls,
  ApprovalHashPort, ApprovalMutation, ApprovalOperation, ApprovalOutcome, OperatorDecisionEvidence, PreparedApproval,
} from "../contracts.js";
import { evaluateApprovalOperation } from "../evaluation.js";
import { assertApprovalRecord, assertSpendingRecord, parseApprovalBinding, parseApprovalOperation, parseOperatorDecisionEvidence, parsePreparedApproval } from "../request.js";
import { ApprovalError, integer, record, refuse, same, timestamp } from "../validation.js";

export const approvalSha256: ApprovalHashPort = Object.freeze({ sha256: (value: string) => computeChecksumOfText(value).hex });
const issued = new WeakMap<object, Readonly<{ operation: ApprovalOperation; actor: OperatorDecisionEvidence }>>();
const attempted = new WeakSet<object>();
const consumed = new WeakSet<object>();
const refusalReasons = new Set([
  "request.malformed", "request.unknown-field", "request.unsafe-text", "request.binding-mismatch", "request.too-large",
  "binding.scope-mismatch", "binding.stale", "binding.not-invalidated", "binding.project-absent",
  "approval.expired", "approval.future-activation", "approval.not-requested", "approval.not-expired", "approval.not-consumed",
  "money.class-mismatch", "money.recurrence-mismatch", "money.expectation-exceeds-limit", "money.required",
  "quote.invalid", "quote.absent", "quote.expired", "stop.evidence-incomplete", "stop.approval-not-named",
  "operator.class-insufficient", "evidence.time-mismatch", "project.not-active", "project.stopped",
  "spending.not-awaiting-approval", "spending.execution-not-reported", "replacement.not-new-binding",
  "scope.joint-seal-required", "scope.consumption-unproven", "store.corrupt", "store.conflict", "store.material-conflict",
]);

/** Synthetic fixture capability only. No production entry reaches this module. */
export function issueSyntheticApprovalAuthorization(operation: ApprovalOperation, actor: OperatorDecisionEvidence): ApprovalAuthorization {
  const token = Object.freeze(Object.create(null)) as ApprovalAuthorization;
  issued.set(token, Object.freeze({ operation: parseApprovalOperation(operation, approvalSha256), actor: parseOperatorDecisionEvidence(actor) }));
  return token;
}
export function syntheticAuthorizationState(token: ApprovalAuthorization): Readonly<{ attempted: boolean; consumed: boolean }> {
  return Object.freeze({ attempted: attempted.has(token), consumed: consumed.has(token) });
}

export interface C7ApprovalStoreOptions {
  readonly clock: { now(): Date };
  /** Synthetic integration seam. Must read current policy/account/plan/brief facts
   * within this same transaction. Expected proposal facts are lookup coordinates,
   * never a substitute for a trusted current snapshot. Production wiring is R2. */
  readonly readBinding: (tx: TransactionContext, expected: ApprovalBinding) => Promise<ApprovalBinding>;
  readonly monotonicNow?: () => number;
  readonly evidenceDeadlineMs?: number;
}
interface StoredHead { readonly envelope: AggregateEnvelope; readonly request: PreparedApproval; readonly record: ApprovalMutation["record"] }
interface AttemptContext {
  readonly operation: ApprovalOperation;
  writes: readonly ApprovalMutation[] | null;
  eventPayload: unknown;
  before: readonly (AggregateEnvelope | null)[];
}
class BoundExceeded extends Error {}
function budget(options: C7ApprovalStoreOptions) {
  const now = options.monotonicNow ?? Date.now;
  const duration = options.evidenceDeadlineMs ?? 30_000;
  let previous = now();
  const end = previous + duration;
  if (!Number.isSafeInteger(duration) || duration < 1 || !Number.isFinite(previous) || !Number.isSafeInteger(end)) throw new BoundExceeded();
  return { events: 0, check(): void {
    const current = now();
    if (!Number.isFinite(current) || current < previous || current >= end) throw new BoundExceeded();
    previous = current;
  } };
}
type EvidenceBudget = ReturnType<typeof budget>;

function decodeStored<T>(read: () => T): T {
  try { return read(); } catch { return refuse("store.corrupt"); }
}

function checkEnvelope(e: AggregateEnvelope): void {
  decodeStored(() => {
    integer(e.aggregateVersion, 1);
    if (e.schemaVersion !== 1) refuse("store.corrupt");
    timestamp(e.createdAt); timestamp(e.updatedAt);
    if (e.updatedAt < e.createdAt) refuse("store.corrupt");
    verifyChecksum(serializeCanonicalProjectJson(e.payload), parseChecksum(e.checksum), { recordKind: "approval", recordId: e.aggregateId });
  });
}
function readHead(envelope: AggregateEnvelope | null, type: ApprovalMutation["aggregateType"], id: string): StoredHead | null {
  if (envelope === null) return null;
  checkEnvelope(envelope);
  if (envelope.aggregateType !== type || envelope.aggregateId !== id) return refuse("store.corrupt");
  const payload = decodeStored(() => record(envelope.payload, ["request", "record"]));
  const request = decodeStored(() => parsePreparedApproval(payload["request"], approvalSha256));
  const parsed = decodeStored(() => type === "approval-request" ? assertApprovalRecord(request, payload["record"]) : assertSpendingRecord(request, payload["record"]));
  if (id !== ("approvalRequestId" in parsed ? parsed.approvalRequestId : parsed.spendingRequestId)) return refuse("store.corrupt");
  return Object.freeze({ envelope, request, record: parsed });
}
function result(kind: ApprovalOutcome["kind"], operationId: string, reason: string | null = null): ApprovalOutcome {
  return Object.freeze({ kind, operationId, reason });
}
function eventId(op: ApprovalOperation, write: ApprovalMutation): string {
  return `approval-event:${approvalSha256.sha256(serializeCanonicalProjectJson([op.operationId, write.aggregateType, write.aggregateId])).slice(0, 32)}`;
}
function payloadFor(op: ApprovalOperation, write: ApprovalMutation): unknown {
  const request = write.aggregateId === op.request.approval.approvalRequestId || write.aggregateId === op.request.spending?.spendingRequestId ? op.request : op.successor;
  if (request === null) return refuse("store.corrupt");
  return Object.freeze({ request, record: write.record });
}
async function controlsFor(tx: TransactionContext, op: ApprovalOperation, options: C7ApprovalStoreOptions, bounds: EvidenceBudget): Promise<ApprovalControls> {
  bounds.check();
  const supplied = parseApprovalBinding(await options.readBinding(tx, op.request.proposal.binding));
  bounds.check();
  const expectedProjectId = op.request.approval.scope.projectId;
  if (expectedProjectId === null) return refuse("binding.project-absent");
  const envelope = await tx.aggregates.get("project", expectedProjectId);
  bounds.check();
  if (envelope === null) return refuse("binding.project-absent");
  checkEnvelope(envelope);
  const parsed = decodeStored(() => parseProject(envelope.payload));
  if (envelope.aggregateType !== "project" || envelope.aggregateId !== expectedProjectId || parsed.projectId !== expectedProjectId) return refuse("store.corrupt");
  const project = Object.freeze({ projectId: parsed.projectId, version: envelope.aggregateVersion, contentDigest: approvalSha256.sha256(serializeCanonicalProjectJson(parsed)), budgetAccountId: parsed.budgetAccountId });
  const projectActive = parsed.status === "active";
  const stops = [];
  const seenIds = new Set<string>(), seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 11; pageNumber++) {
    bounds.check();
    const page = await tx.aggregates.list({ aggregateType: "project-stop", limit: 100, cursor });
    bounds.check();
    if (page.items.length > 100 || page.items.length === 0 && page.nextCursor !== null) throw new BoundExceeded();
    for (const envelope of page.items) {
      if (seenIds.has(envelope.aggregateId) || seenIds.size >= 1000) throw new BoundExceeded();
      seenIds.add(envelope.aggregateId); checkEnvelope(envelope);
      const stop = decodeStored(() => parseProjectStop(envelope.payload));
      if (envelope.aggregateType !== "project-stop" || envelope.aggregateId !== stop.projectStopId) return refuse("store.corrupt");
      stops.push(stop);
    }
    if (page.nextCursor === null) return Object.freeze({ binding: parseApprovalBinding({ ...supplied, project }), projectActive, stops: Object.freeze(stops), stopScanComplete: true, observedAt: timestamp(options.clock.now().toISOString()) });
    if (typeof page.nextCursor !== "string" || seenCursors.has(page.nextCursor)) throw new BoundExceeded();
    seenCursors.add(page.nextCursor); cursor = page.nextCursor;
  }
  throw new BoundExceeded();
}

async function findEvent(tx: TransactionContext, op: ApprovalOperation, write: ApprovalMutation, bounds: EvidenceBudget): Promise<EventRecord | null> {
  let cursor: string | null = null, match: EventRecord | null = null, previousSequence = 0;
  const cursors = new Set<string>();
  for (let pageNumber = 0; pageNumber < 11; pageNumber++) {
    bounds.check();
    const page = await tx.events.list({ aggregateType: write.aggregateType, aggregateId: write.aggregateId, limit: 100, cursor });
    bounds.check();
    if (page.items.length > 100 || page.items.length === 0 && page.nextCursor !== null) throw new BoundExceeded();
    for (const event of page.items) {
      if (++bounds.events > 1000) throw new BoundExceeded();
      if (!Number.isSafeInteger(event.globalSequence) || event.globalSequence <= previousSequence || event.aggregateType !== write.aggregateType || event.aggregateId !== write.aggregateId) return refuse("store.corrupt");
      previousSequence = event.globalSequence;
      verifyChecksum(serializeCanonicalProjectJson(event.payload), parseChecksum(event.checksum), { recordKind: "approval-event", recordId: event.eventId });
      if (event.eventId === eventId(op, write)) {
        if (match !== null) return refuse("store.corrupt");
        match = event;
      }
    }
    if (page.nextCursor === null) return match;
    if (typeof page.nextCursor !== "string" || cursors.has(page.nextCursor)) throw new BoundExceeded();
    cursors.add(page.nextCursor); cursor = page.nextCursor;
  }
  throw new BoundExceeded();
}

/** Isolated C7 composition for synthetic fixtures. The production root exposes
 * only the application contract, evaluator and projections, never this writer. */
export function createC7ApprovalStore(adapter: PersistenceAdapter, options: C7ApprovalStoreOptions): ApprovalApplicationAdapter {
  const contexts = new Map<string, AttemptContext>();
  async function observe(raw: ApprovalOperation): Promise<ApprovalOutcome> {
    let op: ApprovalOperation;
    try { op = parseApprovalOperation(raw, approvalSha256); } catch { return result("refused", "unparsed", "request.malformed"); }
    const context = contexts.get(op.operationId);
    if (context === undefined || !same(context.operation, op) || context.writes === null) return result("unknown", op.operationId, "observation.no-exact-attempt");
    const writes = context.writes;
    try {
      const bounds = budget(options);
      return await adapter.transact(async (tx) => {
        let matched = 0, unchanged = 0;
        for (let index = 0; index < writes.length; index++) {
          const write = writes[index]!;
          bounds.check();
          const envelope = await tx.aggregates.get(write.aggregateType, write.aggregateId);
          bounds.check();
          const head = readHead(envelope, write.aggregateType, write.aggregateId);
          const event = await findEvent(tx, op, write, bounds);
          if (event !== null) {
            if (event.aggregateVersion !== write.expectedVersion + 1 || event.eventSchemaVersion !== 1 || event.eventType !== `approval.${op.kind}`
              || event.occurredAt !== op.at || event.traceId !== op.request.approval.scope.traceId || event.causationId !== op.operationId
              || !same(event.payload, context.eventPayload) || head === null || head.envelope.aggregateVersion < event.aggregateVersion
              || head.envelope.aggregateVersion === event.aggregateVersion && !same(head.envelope.payload, payloadFor(op, write))) return result("corrupt", op.operationId, "observation.evidence-mismatch");
            matched++;
          }
          const before = context.before[index];
          if (before === null ? envelope === null : before !== undefined && envelope !== null && same(before, envelope)) unchanged++;
        }
        if (matched === writes.length) return result("committed", op.operationId);
        if (matched > 0) return result("corrupt", op.operationId, "observation.partial-transaction");
        if (unchanged === writes.length) return result("not-recorded", op.operationId);
        return result("unknown", op.operationId, "observation.no-exact-event");
      });
    } catch (error) {
      if (error instanceof ProjectContractError || error instanceof ApprovalError || isPersistenceError(error) && error.code === "CORRUPTION_DETECTED") return result("corrupt", op.operationId, "store.corrupt");
      return result("unknown", op.operationId, "observation.inconclusive");
    }
  }
  return Object.freeze({ observe, async attempt(raw: ApprovalOperation, authorization: ApprovalAuthorization): Promise<ApprovalOutcome> {
    let op: ApprovalOperation;
    try { op = parseApprovalOperation(raw, approvalSha256); } catch { return result("refused", "unparsed", "request.malformed"); }
    if (authorization === null || typeof authorization !== "object") return result("refused", op.operationId, "authorization.not-issued");
    const facts = issued.get(authorization);
    if (facts === undefined || attempted.has(authorization) || !same(facts.operation, op)) return result("refused", op.operationId, "authorization.not-issued");
    // Reserve the attempt before entering asynchronous work. This latch is NEVER
    // re-armed, including uncertainty. It is distinct from mutation consumption.
    attempted.add(authorization);
    if (contexts.has(op.operationId)) return result("refused", op.operationId, "operation.already-attempted");
    if (contexts.size >= 1000) return result("refused", op.operationId, "store.attempt-limit");
    const context: AttemptContext = { operation: op, writes: null, eventPayload: null, before: [] };
    contexts.set(op.operationId, context);
    let callbackFinished = false;
    try {
      const bounds = budget(options);
      const outcome = await adapter.transact(async (tx) => {
        const observedControls = await controlsFor(tx, op, options, bounds);
        const approvalEnvelope = await tx.aggregates.get("approval-request", op.request.approval.approvalRequestId);
        bounds.check();
        const approval = readHead(approvalEnvelope, "approval-request", op.request.approval.approvalRequestId);
        // Verify the persisted pair against its OWN original before comparing
        // caller material. An authority identity intentionally excludes prose
        // and createdAt and therefore cannot prove an exact request replay.
        const spendingId = (approval === null ? op.request : approval.request).spending?.spendingRequestId ?? null;
        const spendingEnvelope = spendingId === null ? null : await tx.aggregates.get("spending-request", spendingId);
        bounds.check();
        const spending = spendingId === null ? null : readHead(spendingEnvelope, "spending-request", spendingId);
        if (approval === null ? spending !== null : (approval.request.spending === null) !== (spending === null)
          || spending !== null && !same(approval.request, spending.request)) return refuse("store.corrupt");
        if (approval !== null && !same(approval.request, op.request)) return refuse("store.material-conflict");
        if (op.kind === "create" && approval !== null) {
          callbackFinished = true;
          return result("idempotent-replay", op.operationId);
        }
        if ((approvalEnvelope?.aggregateVersion ?? 0) !== op.expectedApprovalVersion || (spendingEnvelope?.aggregateVersion ?? 0) !== op.expectedSpendingVersion) return refuse("store.conflict");
        const beforeById = new Map<string, AggregateEnvelope | null>([
          [op.request.approval.approvalRequestId, approvalEnvelope],
          ...(op.request.spending === null ? [] : [[op.request.spending.spendingRequestId, spendingEnvelope] as const]),
        ]);
        if (op.successor !== null) {
          for (const [type, id] of [["approval-request", op.successor.approval.approvalRequestId], ...(op.successor.spending === null ? [] : [["spending-request", op.successor.spending.spendingRequestId]])] as const) {
            const current = await tx.aggregates.get(type as ApprovalMutation["aggregateType"], id!);
            bounds.check();
            if (current !== null) return refuse("store.conflict");
            beforeById.set(id!, current);
          }
        }
        // No asynchronous evidence read separates this trusted admission instant,
        // the complete pure evaluation and the first mutation attempt.
        const controls = Object.freeze({ ...observedControls, observedAt: timestamp(options.clock.now().toISOString()) });
        const writes = evaluateApprovalOperation(op, { approval: approval === null ? null : assertApprovalRecord(op.request, approval.record), spending: spending === null ? null : assertSpendingRecord(op.request, spending.record) }, controls, facts.actor, approvalSha256);
        const before = writes.map((write) => beforeById.get(write.aggregateId) ?? null);
        const eventPayload = Object.freeze({ schemaVersion: 1, operation: op, actor: facts.actor, controls, writes });
        if (serializeCanonicalProjectJson(eventPayload).length > 131_072) return refuse("request.too-large");
        context.writes = writes; context.before = Object.freeze(before); context.eventPayload = eventPayload;
        bounds.check();
        consumed.add(authorization); // Immediately before the first conditional mutation.
        for (const write of writes) {
          const input = { aggregateType: write.aggregateType, aggregateId: write.aggregateId, schemaVersion: 1, payload: payloadFor(op, write), traceId: op.request.approval.scope.traceId };
          const stored = write.expectedVersion === 0 ? await tx.aggregates.create(input) : await tx.aggregates.update({ ...input, expectedVersion: write.expectedVersion });
          checkEnvelope(stored);
          if (stored.aggregateVersion !== write.expectedVersion + 1 || stored.aggregateType !== write.aggregateType || stored.aggregateId !== write.aggregateId || !same(stored.payload, input.payload)) return refuse("store.corrupt");
          const event = await tx.events.append({ eventId: eventId(op, write), aggregateType: write.aggregateType, aggregateId: write.aggregateId, aggregateVersion: stored.aggregateVersion, eventType: `approval.${op.kind}`, eventSchemaVersion: 1, payload: eventPayload, occurredAt: op.at, traceId: input.traceId, causationId: op.operationId });
          if (event.eventId !== eventId(op, write) || event.aggregateVersion !== stored.aggregateVersion
            || event.aggregateType !== write.aggregateType || event.aggregateId !== write.aggregateId
            || event.eventSchemaVersion !== 1 || event.eventType !== `approval.${op.kind}`
            || event.occurredAt !== op.at || event.traceId !== input.traceId || event.causationId !== op.operationId
            || !same(event.payload, eventPayload)) return refuse("store.corrupt");
          verifyChecksum(serializeCanonicalProjectJson(event.payload), parseChecksum(event.checksum), { recordKind: "approval-event", recordId: event.eventId });
        }
        callbackFinished = true;
        return result("committed", op.operationId);
      });
      return outcome;
    } catch (error) {
      // A callback rejection is rolled back by the C7 contract. An error AFTER a
      // completed callback may be a lost commit acknowledgement, regardless of code.
      if (!callbackFinished) {
        if (error instanceof ApprovalError) return result(error.reason === "store.conflict" || error.reason === "store.material-conflict" ? "conflict" : error.reason === "store.corrupt" ? "corrupt" : "refused", op.operationId, refusalReasons.has(error.reason) ? error.reason : "request.refused");
        if (error instanceof ProjectContractError) return result("refused", op.operationId, "request.state-or-contract-refused");
        if (error instanceof BoundExceeded) return result("refused", op.operationId, "stop.evidence-incomplete");
        if (isPersistenceError(error)) {
          if (error.code === "CONCURRENCY_CONFLICT" || error.code === "NOT_FOUND" || error.code === "DUPLICATE_ID") return result("conflict", op.operationId, "store.conflict");
          if (error.code === "CORRUPTION_DETECTED") return result("corrupt", op.operationId, "store.corrupt");
          if (error.code !== "STORAGE_FAILURE") return result("refused", op.operationId, "store.unavailable");
        }
      }
      // Exactly one bounded observation; there is no write retry or timer.
      return observe(op);
    }
  } });
}
