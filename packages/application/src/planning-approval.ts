import { assertConsumedScopeApproval, assertApprovalRecord, assertSpendingRecord, evaluateApprovalOperation, evaluateHistoricalMoneyCompletion, parseApprovalBinding, parseApprovalControls, parseApprovalOperation, parseOperatorDecisionEvidence, parsePreparedApproval, prepareApprovalRequest,
  type ApprovalApplicationAdapter, type ApprovalAuthorization, type ApprovalBinding, type ApprovalControls, type ApprovalMutation, type ApprovalOperation, type ApprovalOutcome, type PreparedApproval } from "@ai-dev-os/approval";
import { evaluateSealConditions, parsePlanCommitRequest, type PlanCommitRequest } from "@ai-dev-os/plan";
import { PROJECT_STATE_MACHINES, parseApprovalRequest, transition, type ApprovalRequest, type SpendingRequest } from "@ai-dev-os/project";
import type { AggregateEnvelope, PersistenceAdapter, TransactionContext } from "@ai-dev-os/persistence";
import { listPlanningEvents, observePlanningReceipt, recordPlanningReceipt, capturePlanningEffects, verifyPlanningEnvelope, parsePlanningConfirmation, type PlanningConfirmation } from "./planning-ledger.js";
import { planningCeiling, readPlanningFoundations, type PlanningFoundations } from "./planning-plan.js";
import { canonicalPlanning, digestPlanning, planningHash, planningObject, refusePlanning, PlanningRefusal } from "./planning-validation.js";

export interface PlanningApprovalPair {
  readonly request: PreparedApproval;
  readonly approval: ApprovalRequest;
  readonly approvalEnvelope: AggregateEnvelope;
  readonly spending: SpendingRequest | null;
  readonly spendingEnvelope: AggregateEnvelope | null;
}
export async function readPlanningApprovalPair(tx: TransactionContext, approvalId: string): Promise<PlanningApprovalPair | null> {
  const approvalEnvelope = await tx.aggregates.get("approval-request", approvalId);
  if (approvalEnvelope === null) return null;
  try {
    verifyPlanningEnvelope(approvalEnvelope, "approval-request", approvalId);
    const a = planningObject(approvalEnvelope.payload, ["request", "record"]), request = parsePreparedApproval(a["request"], planningHash), approval = assertApprovalRecord(request, a["record"]);
    if (approval.approvalRequestId !== approvalId) throw new Error();
    const spendingEnvelope = request.spending === null ? null : await tx.aggregates.get("spending-request", request.spending.spendingRequestId);
    if ((request.spending === null) !== (spendingEnvelope === null)) throw new Error();
    let spending: SpendingRequest | null = null;
    if (spendingEnvelope !== null) {
      verifyPlanningEnvelope(spendingEnvelope, "spending-request", request.spending!.spendingRequestId);
      const s = planningObject(spendingEnvelope.payload, ["request", "record"]), original = parsePreparedApproval(s["request"], planningHash);
      if (canonicalPlanning(original) !== canonicalPlanning(request)) throw new Error();
      spending = assertSpendingRecord(request, s["record"]);
    }
    return Object.freeze({ request, approval, approvalEnvelope, spending, spendingEnvelope });
  } catch { return refusePlanning("approval.pair-corrupt", "corrupt"); }
}
export async function readPlanningApprovalControls(tx: TransactionContext, expected: ApprovalBinding, at: string): Promise<ApprovalControls> {
  if (expected.project === null) return refusePlanning("approval.project-required");
  const f = await readPlanningFoundations(tx, expected.project.projectId);
  const policyEnvelope = await tx.aggregates.get("planning-workspace", "local-planning-policy");
  if (policyEnvelope === null) return refusePlanning("policy.unavailable");
  verifyPlanningEnvelope(policyEnvelope, "planning-workspace", "local-planning-policy");
  const policy = planningObject(policyEnvelope.payload, ["schemaVersion", "kind", "version", "mode"]);
  if (policy["schemaVersion"] !== 1 || policy["kind"] !== "local-planning-policy" || policy["mode"] !== "manual-planning-only" || !Number.isSafeInteger(policy["version"])) return refusePlanning("policy.corrupt", "corrupt");
  const head = f.head, accepted = f.accepted;
  const plan = head === null || accepted === null ? null : {
    planId: head.plan.planId, revision: head.plan.revision, version: head.aggregateVersion, planDigest: head.plan.planDigest,
    briefId: accepted.brief.briefId, briefVersion: accepted.aggregateVersion, briefContentDigest: accepted.briefContentDigest, acceptedCandidateDigest: accepted.acceptedCandidateDigest, acceptanceEventId: accepted.acceptanceEventId,
    specificationDigest: head.headEvent.payload.review.specificationDigest, coverageDigest: head.headEvent.payload.review.coverageDigest,
    sealVerdictDigest: digestPlanning(evaluateSealConditions({ plan: head.plan, review: head.headEvent.payload.review, acceptedBrief: accepted, project: f.project, controls: f.controls, resolvedProjectCeiling: planningCeiling(f), authenticatedDecisions: [], scopeApproval: null })),
    requirementIds: [...new Set(head.plan.tasks.flatMap((t) => [...t.requirementIds]))].sort(), taskIds: head.plan.tasks.map((t) => t.taskId).sort(), stageIds: head.plan.stages.map((s) => s.stageId).sort(),
  };
  // Account and policy identity come from this transaction's persisted facts.
  // A renderer cannot supply either, or redirect this reader to an account.
  const binding = parseApprovalBinding({ project: { projectId: f.project.projectId, version: f.projectEnvelope.aggregateVersion, contentDigest: f.projectEnvelope.checksum.hex, budgetAccountId: f.project.budgetAccountId },
    scope: { projectId: f.project.projectId, taskId: null, providerInstanceId: null, workspaceId: null, operationId: expected.scope.operationId, traceId: null },
    accountRef: `budget-binding:${digestPlanning([f.project.budgetAccountId, f.budgetEnvelope.aggregateVersion, f.budgetEnvelope.checksum.hex]).slice(0, 32)}`, providerModelId: null,
    policy: { version: `local-planning-policy:${policy["version"]}`, fingerprint: policyEnvelope.checksum.hex }, plan });
  return parseApprovalControls({ binding, projectActive: f.project.status === "active", stops: f.stops, stopScanComplete: true, observedAt: at });
}
export async function preparePlanningScopeApproval(tx: TransactionContext, f: PlanningFoundations, at: string): Promise<PreparedApproval> {
  if (f.head === null) return refusePlanning("plan.absent");
  const scope = { projectId: f.project.projectId, taskId: null, providerInstanceId: null, workspaceId: null, operationId: `scope:${digestPlanning(f.head.plan.planId).slice(0, 32)}`, traceId: null };
  const controls = await readPlanningApprovalControls(tx, { project: { projectId: f.project.projectId, version: f.projectEnvelope.aggregateVersion, contentDigest: f.projectEnvelope.checksum.hex, budgetAccountId: f.project.budgetAccountId }, scope,
    accountRef: null, providerModelId: null, policy: { version: "lookup", fingerprint: f.project.effectiveConfigDigest }, plan: null }, at);
  const prepared = prepareApprovalRequest({ schemaVersion: 1, class: "scope-expansion", risk: "medium", binding: controls.binding, spending: null,
    explanation: { reason: "scope-review", alternatives: ["defer"], consequence: "waits-for-decision", expectedMinorUnits: null, renewal: "not-recurring", taxAndFees: "unknown", foreignExchange: "none", entitlement: "unknown",
      note: { origin: "operator", text: "Review and seal this exact manually authored project scope. No task or provider is started." } }, createdAt: at, expiresAt: new Date(Date.parse(at) + 24 * 60 * 60 * 1000).toISOString() }, at, planningHash);
  if (prepared.kind !== "ready") return refusePlanning("approval.not-ready");
  return prepared.request;
}
function operationEventId(op: ApprovalOperation, write: ApprovalMutation): string {
  return `approval-event:${digestPlanning([op.operationId, write.aggregateType, write.aggregateId]).slice(0, 32)}`;
}
async function writeApprovalMutations(tx: TransactionContext, op: ApprovalOperation, controls: ApprovalControls, confirmation: PlanningConfirmation, writes: readonly ApprovalMutation[], historical: boolean): Promise<void> {
  const actor = { kind: "operator" as const, identityRef: confirmation.identityRef, approverClass: confirmation.approverClass };
  const eventPayload = { schemaVersion: 1, operation: op, actor, controls, writes, historical, confirmation };
  if (canonicalPlanning(eventPayload).length > 131_072) return refusePlanning("approval.material-bound");
  for (const write of writes) {
    const request = write.aggregateId === op.request.approval.approvalRequestId || write.aggregateId === op.request.spending?.spendingRequestId ? op.request : op.successor;
    if (request === null) return refusePlanning("approval.source-absent", "corrupt");
    const input = { aggregateType: write.aggregateType, aggregateId: write.aggregateId, schemaVersion: 1, payload: { request, record: write.record } };
    const stored = write.expectedVersion === 0 ? await tx.aggregates.create(input) : await tx.aggregates.update({ ...input, expectedVersion: write.expectedVersion });
    verifyPlanningEnvelope(stored, write.aggregateType, write.aggregateId);
    await tx.events.append({ eventId: operationEventId(op, write), aggregateType: write.aggregateType, aggregateId: write.aggregateId, aggregateVersion: stored.aggregateVersion, eventType: `approval.${op.kind}`,
      eventSchemaVersion: 1, payload: eventPayload, occurredAt: op.at, traceId: op.request.approval.scope.traceId, causationId: op.operationId });
  }
}
/** Verifies both original streams and every receipt transition before N6 can
 * record a historical completion under changed project/plan/policy/budget facts. */
export async function verifyPlanningApprovalHistory(tx: TransactionContext, pair: PlanningApprovalPair): Promise<void> {
  const approvalEvents = await listPlanningEvents(tx, "approval-request", pair.approval.approvalRequestId);
  const spendingEvents = pair.spending === null ? [] : await listPlanningEvents(tx, "spending-request", pair.spending.spendingRequestId);
  const events = [...approvalEvents, ...spendingEvents].sort((a, b) => a.globalSequence - b.globalSequence);
  let approval: ApprovalRequest | null = null, spending: SpendingRequest | null = null, av = 0, sv = 0;
  const done = new Set<string>();
  let legacyWithoutReceipt = false;
  try {
    for (const event of events) {
      if (event.eventType === "approval.scope-consumed") {
        const payload = planningObject(event.payload, ["schemaVersion", "request", "approval", "controls", "confirmation", "jointPlanDigest", "planEventIds"]);
        const consumed = assertApprovalRecord(pair.request, payload["approval"]), confirmation = parsePlanningConfirmation(payload["confirmation"]), controls = parseApprovalControls(payload["controls"]);
        if (pair.spending !== null || approval?.state !== "approved" || event.causationId === null || payload["schemaVersion"] !== 1 || canonicalPlanning(payload["request"]) !== canonicalPlanning(pair.request)) throw new Error();
        const receipt = await observePlanningReceipt(tx, event.causationId);
        if (receipt === null || receipt.commandKind !== "approve-scope" || receipt.result.kind !== "committed" || canonicalPlanning(receipt.confirmation) !== canonicalPlanning(confirmation)) throw new Error();
        const material = planningObject(receipt.material, ["command", "request"]), request = parsePlanCommitRequest(material["request"], planningHash), sealed = request.steps[1]?.event.plan;
        if (request.steps.length !== 2 || request.steps[0].event.kind !== "plan.proposed" || request.steps[1]?.event.kind !== "plan.sealed" || sealed?.sealedByApprovalId !== consumed.approvalRequestId
          || event.eventId !== `scope-consumption:${request.binding.contentDigest.slice(0, 32)}` || event.aggregateVersion !== av + 1 || event.occurredAt !== confirmation.confirmedAt
          || payload["jointPlanDigest"] !== request.binding.contentDigest || canonicalPlanning(payload["planEventIds"]) !== canonicalPlanning(request.steps.map((step) => step.eventId))) throw new Error();
        assertConsumedScopeApproval({ request: pair.request, approval: consumed, aggregateVersion: event.aggregateVersion, consumptionEventId: event.eventId }, controls, request.steps[0].event.plan, planningHash);
        if (canonicalPlanning(prospectiveScopeConsumption({ ...pair, approval }, confirmation.confirmedAt)) !== canonicalPlanning(consumed)) throw new Error();
        approval = consumed; av++; continue;
      }
      const oldShape = Object.keys(planningObject(event.payload)).length === 5;
      const payload = planningObject(event.payload, oldShape ? ["schemaVersion", "operation", "actor", "controls", "writes"] : ["schemaVersion", "operation", "actor", "controls", "writes", "historical", "confirmation"]);
      if (payload["schemaVersion"] !== 1 || !oldShape && typeof payload["historical"] !== "boolean") throw new Error();
      const op = parseApprovalOperation(payload["operation"], planningHash), actor = parseOperatorDecisionEvidence(payload["actor"]), controls = parseApprovalControls(payload["controls"]);
      if (canonicalPlanning(op.request) !== canonicalPlanning(pair.request) || op.successor !== null) throw new Error();
      if (done.has(op.operationId)) continue;
      done.add(op.operationId);
      if (oldShape) legacyWithoutReceipt = true;
      else {
        const confirmation = parsePlanningConfirmation(payload["confirmation"]), receipt = await observePlanningReceipt(tx, op.operationId, digestPlanning(op));
        if (receipt === null || receipt.result.kind !== "committed" || canonicalPlanning(receipt.confirmation) !== canonicalPlanning(confirmation) || canonicalPlanning(receipt.material) !== canonicalPlanning(op)
          || confirmation.identityRef !== actor.identityRef || confirmation.approverClass !== actor.approverClass || confirmation.confirmedAt !== op.at) throw new Error();
      }
      if (op.expectedApprovalVersion !== av || op.expectedSpendingVersion !== sv) throw new Error();
      const writes = payload["historical"] === true ? evaluateHistoricalMoneyCompletion(op, { approval, spending }, controls, actor, planningHash) : evaluateApprovalOperation(op, { approval, spending }, controls, actor, planningHash);
      if (canonicalPlanning(writes) !== canonicalPlanning(payload["writes"])) throw new Error();
      for (const write of writes) {
        const matches = events.filter((e) => e.eventId === operationEventId(op, write));
        if (matches.length !== 1 || matches[0]!.aggregateType !== write.aggregateType || matches[0]!.aggregateId !== write.aggregateId || matches[0]!.aggregateVersion !== write.expectedVersion + 1
          || matches[0]!.eventType !== `approval.${op.kind}` || matches[0]!.occurredAt !== op.at || matches[0]!.causationId !== op.operationId || matches[0]!.traceId !== op.request.approval.scope.traceId
          || canonicalPlanning(matches[0]!.payload) !== canonicalPlanning(payload)) throw new Error();
        if (write.aggregateType === "approval-request") { approval = assertApprovalRecord(op.request, write.record); av++; }
        else { spending = assertSpendingRecord(op.request, write.record); sv++; }
      }
    }
    if (approval === null || av !== pair.approvalEnvelope.aggregateVersion || sv !== (pair.spendingEnvelope?.aggregateVersion ?? 0)
      || canonicalPlanning(approval) !== canonicalPlanning(pair.approval) || canonicalPlanning(spending) !== canonicalPlanning(pair.spending)
      || approvalEvents.length !== av || spendingEvents.length !== sv) throw new Error();
  } catch { return refusePlanning("approval.history-corrupt", "corrupt"); }
  if (legacyWithoutReceipt) return refusePlanning("approval.historical-receipt-unavailable");
}
export async function verifyPlanningMoneyHistory(tx: TransactionContext, pair: PlanningApprovalPair): Promise<void> {
  if (pair.spending === null || pair.approval.state !== "consumed") return refusePlanning("money.history-unavailable");
  await verifyPlanningApprovalHistory(tx, pair);
}
export interface PlanningApprovalOwner {
  readonly adapter: ApprovalApplicationAdapter;
  attemptConfirmed(operation: ApprovalOperation, confirmation: PlanningConfirmation, historical?: boolean): Promise<ApprovalOutcome>;
}
/** Application-internal owner; the package public planning entry exports no issuer. */
export function createPlanningApprovalOwner(adapter: PersistenceAdapter, clock: { now(): Date }): PlanningApprovalOwner {
  const issued = new WeakMap<object, Readonly<{ digest: string; confirmation: PlanningConfirmation; historical: boolean }>>();
  const outcome = (kind: ApprovalOutcome["kind"], operationId: string, reason: string | null = null): ApprovalOutcome => Object.freeze({ kind, operationId, reason });
  const implementation: ApprovalApplicationAdapter = {
    async observe(operation) {
      try {
        const op = parseApprovalOperation(operation, planningHash), receipt = await adapter.transact((tx) => observePlanningReceipt(tx, op.operationId, digestPlanning(op)));
        return receipt === null ? outcome("not-recorded", op.operationId) : outcome(receipt.result.kind === "committed" ? "committed" : "refused", op.operationId, receipt.result.reason);
      } catch (error) { return outcome(error instanceof PlanningRefusal ? error.kind : "unknown", operation.operationId, error instanceof PlanningRefusal ? error.reason : "approval.observation-unavailable"); }
    },
    async attempt(value, authorization) {
      let op: ApprovalOperation;
      try { op = parseApprovalOperation(value, planningHash); } catch { return outcome("refused", "unparsed", "approval.malformed"); }
      if (authorization === null || typeof authorization !== "object") return outcome("refused", op.operationId, "authorization.not-issued");
      const facts = issued.get(authorization); issued.delete(authorization);
      if (facts === undefined || facts.digest !== digestPlanning(op)) return outcome("refused", op.operationId, "authorization.not-issued");
      try {
        return await adapter.transact(async (base) => {
          const existing = await observePlanningReceipt(base, op.operationId, digestPlanning(op));
          if (existing !== null) return outcome("idempotent-replay", op.operationId, existing.result.reason);
          const capture = capturePlanningEffects(base), tx = capture.tx;
          const pair = await readPlanningApprovalPair(tx, op.request.approval.approvalRequestId);
          if (pair !== null && !facts.historical) await verifyPlanningApprovalHistory(tx, pair);
          if (pair !== null && canonicalPlanning(pair.request) !== canonicalPlanning(op.request)) return refusePlanning("approval.material-conflict", "conflict");
          if ((pair?.approvalEnvelope.aggregateVersion ?? 0) !== op.expectedApprovalVersion || (pair?.spendingEnvelope?.aggregateVersion ?? 0) !== op.expectedSpendingVersion) return refusePlanning("approval.version-conflict", "conflict");
          const controls = await readPlanningApprovalControls(tx, op.request.proposal.binding, clock.now().toISOString());
          if (facts.historical) { if (pair === null) return refusePlanning("money.history-unavailable"); await verifyPlanningMoneyHistory(tx, pair); }
          const actor = { kind: "operator" as const, identityRef: facts.confirmation.identityRef, approverClass: facts.confirmation.approverClass };
          const evaluator = facts.historical ? evaluateHistoricalMoneyCompletion : evaluateApprovalOperation;
          const writes = evaluator(op, { approval: pair?.approval ?? null, spending: pair?.spending ?? null }, controls, actor, planningHash);
          await writeApprovalMutations(tx, op, controls, facts.confirmation, writes, facts.historical);
          await recordPlanningReceipt(base, { schemaVersion: 1, commandId: op.operationId, commandKind: `approval.${op.kind}`, inputDigest: digestPlanning(op), at: op.at, confirmation: facts.confirmation,
            material: op, effects: capture.effects, result: { kind: "committed", commandId: op.operationId, reason: null, projectId: op.request.approval.scope.projectId } });
          return outcome("committed", op.operationId);
        });
      } catch (error) {
        if (error instanceof PlanningRefusal) return outcome(error.kind, op.operationId, error.reason);
        if (typeof error === "object" && error !== null && "reason" in error && typeof error.reason === "string") return outcome("refused", op.operationId, error.reason);
        return outcome("unknown", op.operationId, "approval.commit-unconfirmed");
      }
    },
  };
  return Object.freeze({ adapter: Object.freeze(implementation), async attemptConfirmed(operation: ApprovalOperation, confirmation: PlanningConfirmation, historical = false) {
    const token = Object.freeze(Object.create(null)) as ApprovalAuthorization;
    issued.set(token, Object.freeze({ digest: digestPlanning(operation), confirmation, historical }));
    return await implementation.attempt(operation, token);
  } });
}
export function prospectiveScopeConsumption(pair: PlanningApprovalPair, at: string): ApprovalRequest {
  if (pair.spending !== null || pair.approval.class !== "scope-expansion" || pair.approval.state !== "approved" || pair.approval.expiresAt <= at || pair.approval.createdAt > at) return refusePlanning("scope.consumption-unavailable");
  return assertApprovalRecord(pair.request, parseApprovalRequest({ ...pair.approval, state: transition(PROJECT_STATE_MACHINES.approval, pair.approval.state, "consume-one"), consumedAt: at, consumptionCount: 1 }));
}
export async function writeJointScopeConsumption(tx: TransactionContext, pair: PlanningApprovalPair, consumed: ApprovalRequest, controls: ApprovalControls, request: PlanCommitRequest, confirmation: PlanningConfirmation): Promise<void> {
  const eventId = `scope-consumption:${request.binding.contentDigest.slice(0, 32)}`;
  assertConsumedScopeApproval({ request: pair.request, approval: consumed, aggregateVersion: pair.approvalEnvelope.aggregateVersion + 1, consumptionEventId: eventId }, controls, request.steps[0].event.plan, planningHash);
  const row = await tx.aggregates.update({ aggregateType: "approval-request", aggregateId: consumed.approvalRequestId, schemaVersion: 1, expectedVersion: pair.approvalEnvelope.aggregateVersion, payload: { request: pair.request, record: consumed } });
  await tx.events.append({ eventId, aggregateType: "approval-request", aggregateId: consumed.approvalRequestId, aggregateVersion: row.aggregateVersion, eventType: "approval.scope-consumed", eventSchemaVersion: 1,
    payload: { schemaVersion: 1, request: pair.request, approval: consumed, controls, confirmation, jointPlanDigest: request.binding.contentDigest, planEventIds: request.steps.map((s) => s.eventId) }, occurredAt: confirmation.confirmedAt, causationId: request.steps[0].envelope.causationId });
}
export async function readJointScopeConsumption(tx: TransactionContext, request: PlanCommitRequest): Promise<ApprovalRequest | null> {
  const sealed = request.steps.find((s) => s.event.kind === "plan.sealed")?.event.plan;
  if (sealed?.sealedByApprovalId === null || sealed?.sealedByApprovalId === undefined) return null;
  const pair = await readPlanningApprovalPair(tx, sealed.sealedByApprovalId);
  if (pair === null) return refusePlanning("scope.consumption-absent", "corrupt");
  const eventId = `scope-consumption:${request.binding.contentDigest.slice(0, 32)}`;
  const matches = (await listPlanningEvents(tx, "approval-request", sealed.sealedByApprovalId)).filter((e) => e.eventId === eventId);
  if (matches.length !== 1 || matches[0]!.aggregateVersion !== pair.approvalEnvelope.aggregateVersion || matches[0]!.eventType !== "approval.scope-consumed") return refusePlanning("scope.consumption-journal-corrupt", "corrupt");
  const payload = planningObject(matches[0]!.payload, ["schemaVersion", "request", "approval", "controls", "confirmation", "jointPlanDigest", "planEventIds"]);
  if (payload["jointPlanDigest"] !== request.binding.contentDigest || canonicalPlanning(payload["request"]) !== canonicalPlanning(pair.request) || canonicalPlanning(payload["approval"]) !== canonicalPlanning(pair.approval)
    || canonicalPlanning(payload["planEventIds"]) !== canonicalPlanning(request.steps.map((s) => s.eventId))) return refusePlanning("scope.consumption-binding-corrupt", "corrupt");
  const recordedControls = parseApprovalControls(payload["controls"]);
  const controls = await readPlanningApprovalControls(tx, pair.request.proposal.binding, recordedControls.observedAt);
  if (canonicalPlanning(controls) !== canonicalPlanning(recordedControls)) return refusePlanning("scope.controls-changed", "conflict");
  assertConsumedScopeApproval({ request: pair.request, approval: pair.approval, aggregateVersion: pair.approvalEnvelope.aggregateVersion, consumptionEventId: eventId }, controls, request.steps[0].event.plan, planningHash);
  return pair.approval;
}
