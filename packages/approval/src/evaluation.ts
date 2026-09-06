import {
  PROJECT_STATE_MACHINES, assertSpendingAuthorization, isProjectStopActive,
  parseApprovalRequest, parseProjectPlan, parseProjectStop, parseSpendingRequest, planDigestMaterial, transition,
  type ApprovalEvent, type ApprovalRequest, type ProjectPlan, type SpendingEvent, type SpendingRequest,
} from "@ai-dev-os/project";
import type {
  ApprovalControls, ApprovalHashPort, ApprovalHead, ApprovalMutation, ApprovalOperation,
  OperatorDecisionEvidence, PreparedApproval,
} from "./contracts.js";
import { assertApprovalRecord, assertSpendingRecord, parseApprovalBinding, parseApprovalOperation, parseOperatorDecisionEvidence, parsePreparedApproval } from "./request.js";
import { array, identifier, integer, record, refuse, same, timestamp } from "./validation.js";

export function parseApprovalControls(value: unknown): ApprovalControls {
  const c = record(value, ["binding", "projectActive", "stops", "stopScanComplete", "observedAt"]);
  if (c["stopScanComplete"] !== true) return refuse("stop.evidence-incomplete");
  if (typeof c["projectActive"] !== "boolean") return refuse("request.malformed");
  const stops = array(c["stops"], (v) => parseProjectStop(v), 1000);
  if (new Set(stops.map((s) => s.projectStopId)).size !== stops.length) return refuse("store.corrupt");
  return Object.freeze({ binding: parseApprovalBinding(c["binding"]), projectActive: c["projectActive"], stops, stopScanComplete: true, observedAt: timestamp(c["observedAt"]) });
}

export function minimumApproverClass(request: PreparedApproval): OperatorDecisionEvidence["approverClass"] {
  const a = request.approval;
  return a.class === "subscription" || a.class === "spending-limit"
    || a.class !== "paid-usage" && (a.risk === "high" || a.risk === "critical") ? "project-owner" : "user";
}
function requireActor(request: PreparedApproval, actor: OperatorDecisionEvidence): void {
  const ranks = { user: 0, "project-owner": 1, "organization-admin": 2 } as const;
  if (ranks[actor.approverClass] < ranks[minimumApproverClass(request)]) refuse("operator.class-insufficient");
}
function live(request: PreparedApproval, at: string): void {
  if (request.approval.createdAt > at || request.approval.expiresAt <= at) refuse("approval.expired");
  const s = request.spending;
  if (s !== null && (s.quotedAt > at || s.quoteExpiresAt <= at)) refuse("quote.expired");
}

/** Pure evaluation is NOT authorization. Only an authenticated transaction owner
 * may act on these candidate mutations, after checking its private capability. */
export function evaluateApprovalOperation(
  value: ApprovalOperation, head: ApprovalHead, controlValue: ApprovalControls,
  actorValue: OperatorDecisionEvidence, hash: ApprovalHashPort,
): readonly ApprovalMutation[] {
  const op = parseApprovalOperation(value, hash), controls = parseApprovalControls(controlValue), actor = parseOperatorDecisionEvidence(actorValue);
  const request = op.request;
  if (op.at > controls.observedAt) return refuse("evidence.time-mismatch");
  if (!controls.projectActive) return refuse("project.not-active");
  const active = controls.stops.filter((s) => s.projectId === request.approval.scope.projectId && isProjectStopActive(s));
  if (active.some((s) => s.engagedAt > op.at)) return refuse("stop.evidence-incomplete");
  const drift = !same(request.proposal.binding, controls.binding);
  if (op.kind !== "invalidate" && drift) return refuse("binding.stale");
  if (active.length > 0 && op.kind !== "invalidate") return refuse("project.stopped");
  if (op.kind === "invalidate" && !drift && active.length === 0) return refuse("binding.not-invalidated");
  requireActor(request, actor);
  const mutations: ApprovalMutation[] = [];
  function putApproval(recordValue: ApprovalRequest, source = request, expectedVersion = op.expectedApprovalVersion): void {
    const approval = assertApprovalRecord(source, recordValue);
    mutations.push(Object.freeze({ aggregateType: "approval-request", aggregateId: approval.approvalRequestId, expectedVersion, proposal: source.proposal, record: approval }));
  }
  function putSpending(recordValue: SpendingRequest, source = request, expectedVersion = op.expectedSpendingVersion): void {
    const spending = assertSpendingRecord(source, recordValue);
    mutations.push(Object.freeze({ aggregateType: "spending-request", aggregateId: spending.spendingRequestId, expectedVersion, proposal: source.proposal, record: spending }));
  }
  if (op.kind === "create") {
    live(request, controls.observedAt);
    if (op.expectedApprovalVersion !== 0 || op.expectedSpendingVersion !== 0 || head.approval !== null || head.spending !== null) return refuse("store.conflict");
    putApproval(request.approval);
    if (request.spending !== null) putSpending(request.spending);
    return Object.freeze(mutations);
  }
  if (head.approval === null || op.expectedApprovalVersion < 1) return refuse("store.conflict");
  const approval = assertApprovalRecord(request, head.approval);
  const spending = head.spending === null ? null : assertSpendingRecord(request, head.spending);
  if ((spending === null) !== (request.spending === null) || (spending === null ? op.expectedSpendingVersion !== 0 : op.expectedSpendingVersion < 1)) return refuse("store.conflict");
  if (approval.decidedAt !== null && approval.decidedAt > op.at || approval.consumedAt !== null && approval.consumedAt > op.at) return refuse("approval.future-activation");
  const approvalStep = (event: ApprovalEvent, changes: Partial<ApprovalRequest> = {}) => parseApprovalRequest({ ...approval, ...changes, state: transition(PROJECT_STATE_MACHINES.approval, approval.state, event) });
  const spendingStep = (event: SpendingEvent, changes: Partial<SpendingRequest> = {}) => {
    if (spending === null) return refuse("money.required");
    // Close an initial quote through the existing request-approval -> terminal
    // path within this same atomic operation. This adds no C6 lifecycle edge
    // and never approves or authorizes the intervening state.
    const from = spending.state === "quoted" && (event === "decline" || event === "expire-quote")
      ? transition(PROJECT_STATE_MACHINES.spending, spending.state, "request-approval") : spending.state;
    return parseSpendingRequest({ ...spending, ...changes, state: transition(PROJECT_STATE_MACHINES.spending, from, event) });
  };
  const closePendingSpending = () => {
    if (spending !== null) putSpending(spendingStep("decline"));
  };
  switch (op.kind) {
    case "request-approval":
      live(request, controls.observedAt);
      if (approval.state !== "requested") return refuse("approval.not-requested");
      putSpending(spendingStep("request-approval"));
      break;
    case "approve":
      live(request, controls.observedAt);
      if (spending !== null && spending.state !== "awaiting_approval") return refuse("spending.not-awaiting-approval");
      putApproval(approvalStep("approve", { decidedAt: op.at, approverClass: actor.approverClass }));
      break;
    case "decline":
      live(request, controls.observedAt);
      putApproval(approvalStep("reject", { decidedAt: op.at, approverClass: actor.approverClass }));
      closePendingSpending();
      break;
    case "authorize": {
      // C10 must never consume scope approval separately from R2's joint seal.
      if (spending === null) return refuse("scope.joint-seal-required");
      live(request, controls.observedAt);
      const consumed = approvalStep("consume-one", { consumedAt: controls.observedAt, consumptionCount: 1 });
      const authorized = spendingStep("authorize");
      assertSpendingAuthorization(authorized, consumed, hash, controls.binding.scope);
      putApproval(consumed); putSpending(authorized);
      break;
    }
    case "revoke":
      putApproval(approvalStep("revoke", { revokedAt: op.at })); closePendingSpending();
      break;
    case "expire":
      if (approval.expiresAt > op.at) return refuse("approval.not-expired");
      putApproval(approvalStep("expire"));
      if (spending !== null) putSpending(spendingStep(spending.quoteExpiresAt <= op.at ? "expire-quote" : "decline"));
      break;
    case "invalidate": {
      const namedStop = active.find((s) => s.effects.voidedApprovalIds.includes(approval.approvalRequestId));
      if (active.length > 0 && namedStop === undefined) return refuse("stop.approval-not-named");
      putApproval(approvalStep("void", { voidedBy: namedStop?.projectStopId ?? `binding:${request.identityDigest.slice(0, 32)}` }));
      closePendingSpending();
      break;
    }
    case "replace": {
      const successor = op.successor!;
      if (spending === null || successor.spending === null) return refuse("money.required");
      live(successor, controls.observedAt); requireActor(successor, actor);
      if (!same(successor.proposal.binding, controls.binding) || successor.approval.approvalRequestId === approval.approvalRequestId) return refuse("replacement.not-new-binding");
      if (approval.state === "requested") putApproval(approvalStep("reject", { decidedAt: op.at, approverClass: actor.approverClass }));
      else putApproval(approvalStep("revoke", { revokedAt: op.at }));
      closePendingSpending();
      putApproval(successor.approval, successor, 0); putSpending(successor.spending, successor, 0);
      break;
    }
    case "report-executed":
      if (approval.state !== "consumed") return refuse("approval.not-consumed");
      putSpending(spendingStep("operator-reports-executed", { executedAt: op.at }));
      break;
    case "record-receipt":
      if (spending?.executedAt === null || spending?.executedAt === undefined || spending.executedAt > op.at) return refuse("spending.execution-not-reported");
      putSpending(spendingStep("record-receipt", { externalReceiptRef: op.receiptRef }));
      break;
    case "withdraw":
      putSpending(spendingStep("withdraw"));
      break;
  }
  return Object.freeze(mutations);
}

export interface ConsumedScopeApprovalEvidence {
  readonly request: PreparedApproval;
  readonly approval: ApprovalRequest;
  readonly aggregateVersion: number;
  readonly consumptionEventId: string;
}
/** Future R2 conformance value only. C10 has no durable scope-consumption writer.
 * The joint plan-store transaction must derive observed binding from its reads. */
export function assertConsumedScopeApproval(
  evidence: ConsumedScopeApprovalEvidence, observedBinding: ApprovalControls,
  planValue: ProjectPlan, hash: ApprovalHashPort,
): void {
  const input = record(evidence, ["request", "approval", "aggregateVersion", "consumptionEventId"]);
  integer(input["aggregateVersion"], 2); identifier(input["consumptionEventId"]);
  const request = parsePreparedApproval(input["request"], hash), approval = assertApprovalRecord(request, input["approval"]);
  const controls = parseApprovalControls(observedBinding), plan = parseProjectPlan(planValue);
  if (approval.class !== "scope-expansion" || approval.state !== "consumed" || approval.usage !== "one-shot" || approval.consumptionCount !== 1) return refuse("scope.consumption-unproven");
  const binding = controls.binding.plan;
  if (binding === null || !same(controls.binding, request.proposal.binding)
    || plan.planId !== binding.planId || plan.revision !== binding.revision || plan.planDigest !== binding.planDigest
    || plan.projectId !== approval.scope.projectId || plan.briefId !== binding.briefId
    || approval.subjectDigest !== plan.planDigest || plan.planDigest !== hash.sha256(planDigestMaterial(plan))
    || plan.specificationRef !== (binding.specificationDigest === null ? null : `spec:${binding.specificationDigest.slice(0, 32)}`)
    || plan.coverageRef !== (binding.coverageDigest === null ? null : `coverage:${binding.coverageDigest.slice(0, 32)}`)
    || binding.requirementIds.some((id) => !plan.tasks.some((task) => task.requirementIds.includes(id)))
    || binding.taskIds.some((id) => !plan.tasks.some((task) => task.taskId === id))
    || binding.stageIds.some((id) => !plan.stages.some((stage) => stage.stageId === id))) return refuse("binding.stale");
  if (!controls.projectActive || controls.stops.some((s) => s.projectId === plan.projectId && isProjectStopActive(s))) return refuse("project.stopped");
  if (approval.consumedAt === null || approval.consumedAt > controls.observedAt) return refuse("scope.consumption-unproven");
}
