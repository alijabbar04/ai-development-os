import { parseProject, parseProjectStop, serializeCanonicalProjectJson } from "@ai-dev-os/project";
import type { PersistenceAdapter, TransactionContext } from "@ai-dev-os/persistence";
import {
  prepareApprovalRequest, type ApprovalBinding, type ApprovalClass, type ApprovalControls,
  type ApprovalOperation, type ApprovalOperationKind, type ApprovalProposal,
  type OperatorDecisionEvidence, type PreparedApproval,
} from "../src/index.js";
import { approvalSha256, createC7ApprovalStore, issueSyntheticApprovalAuthorization } from "../src/testing/index.js";

export const T0 = "2026-09-05T12:00:00.000Z";
export const T1 = "2026-09-05T12:01:00.000Z";
export const T2 = "2026-09-05T13:00:00.000Z";
export const A = "a".repeat(64), B = "b".repeat(64);
export const operator: OperatorDecisionEvidence = { kind: "operator", identityRef: "operator:fixture", approverClass: "organization-admin" };
export const project = parseProject({
  schemaVersion: 1, projectId: "prj:approval", revision: 1, displayName: "Synthetic approval fixture",
  repositoryRoots: ["C:\\Synthetic\\Approval"], defaultBranch: "main", dataClassification: "internal",
  permissionMode: "contained-default", budgetAccountId: "budget:fixture", effectiveConfigDigest: A,
  status: "active", createdAt: T0, updatedAt: T0,
});
export function binding(): ApprovalBinding {
  return {
    project: { projectId: project.projectId, version: 1, contentDigest: approvalSha256.sha256(serializeCanonicalProjectJson(project)), budgetAccountId: project.budgetAccountId },
    scope: { projectId: project.projectId, taskId: null, providerInstanceId: null, workspaceId: null, operationId: "operation:fixture", traceId: "trace:fixture" },
    accountRef: null, providerModelId: null, policy: { version: "policy:one", fingerprint: A }, plan: null,
  };
}
export function proposal(approvalClass: ApprovalClass = "purchase"): ApprovalProposal {
  const bound = binding();
  return {
    schemaVersion: 1, class: approvalClass, risk: "low",
    binding: approvalClass === "scope-expansion" ? { ...bound, plan: {
      planId: "pln:fixture", revision: 1, version: 1, planDigest: A,
      briefId: "brf:fixture", briefVersion: 1, briefContentDigest: B, acceptedCandidateDigest: A, acceptanceEventId: "acceptance:fixture",
      specificationDigest: A, coverageDigest: B, sealVerdictDigest: A,
      requirementIds: ["req:scope"], taskIds: ["tsk:scope"], stageIds: ["stg:scope"],
    } } : approvalClass === "paid-usage" ? { ...bound, scope: { ...bound.scope, providerInstanceId: "provider:fixture" }, providerModelId: "model:fixture", accountRef: "account:synthetic-owned" } : bound,
    spending: approvalClass === "scope-expansion" ? null : {
      vendor: { name: "Synthetic Vendor", instanceRef: "vendor:fixture" }, amount: { kind: "known", minorUnits: 1900 }, currency: "GBP",
      recurrence: approvalClass === "subscription" ? { period: "monthly", occurrences: 12 } : null,
      quote: { digest: A, quotedAt: T0, expiresAt: T2 },
    },
    explanation: { reason: approvalClass === "scope-expansion" ? "scope-review" : "paid-resource-required", alternatives: ["defer"], consequence: "waits-for-decision", expectedMinorUnits: null, renewal: approvalClass === "subscription" ? "automatic-at-vendor" : "not-recurring", taxAndFees: "unknown", foreignExchange: "none", entitlement: "unknown", note: { origin: "model", text: "A synthetic suggestion requiring an operator decision." } },
    createdAt: T0, expiresAt: T2,
  };
}
export function prepared(value = proposal()): PreparedApproval {
  const result = prepareApprovalRequest(value, T0, approvalSha256);
  if (result.kind !== "ready") throw new Error("Fixture must be ready");
  return result.request;
}
export function controls(request: PreparedApproval): ApprovalControls {
  return { binding: request.proposal.binding, projectActive: true, stops: [], stopScanComplete: true, observedAt: T0 };
}
export function operation(request: PreparedApproval, kind: ApprovalOperationKind, overrides: Partial<ApprovalOperation> = {}): ApprovalOperation {
  return { schemaVersion: 1, kind, operationId: `fixture:${kind}`, request, successor: null, expectedApprovalVersion: 0, expectedSpendingVersion: 0, at: T0, receiptRef: null, ...overrides };
}
export function stop(approvalId: string | null = null) {
  return parseProjectStop({ schemaVersion: 1, projectStopId: "pst:fixture", revision: 1, projectId: project.projectId, engagedAt: T0,
    effects: { cancelledTaskIds: [], stoppingSessionIds: [], unconfirmedSessionIds: [], voidedApprovalIds: approvalId === null ? [] : [approvalId], voidedHandoverIds: [], releasedReservationIds: [], retainedReservationIds: [] }, resumedAt: null });
}
export async function harness(adapter: PersistenceAdapter, request = prepared(), wrap: (base: PersistenceAdapter) => PersistenceAdapter = (a) => a) {
  let currentBinding = request.proposal.binding, time = T0, serial = 0;
  await adapter.transact((tx) => tx.aggregates.create({ aggregateType: "project", aggregateId: project.projectId, schemaVersion: 1, payload: project }));
  const clock = { now: () => new Date(time) };
  const store = createC7ApprovalStore(wrap(adapter), { clock, readBinding: async () => currentBinding });
  async function heads(source = request) {
    return adapter.transact(async (tx) => ({
      approval: await tx.aggregates.get("approval-request", source.approval.approvalRequestId),
      spending: source.spending === null ? null : await tx.aggregates.get("spending-request", source.spending.spendingRequestId),
    }));
  }
  async function command(kind: ApprovalOperationKind, overrides: Partial<ApprovalOperation> = {}) {
    const head = await heads();
    return operation(request, kind, { expectedApprovalVersion: head.approval?.aggregateVersion ?? 0,
      expectedSpendingVersion: head.spending?.aggregateVersion ?? 0, operationId: `fixture:${++serial}:${kind}`, at: time, ...overrides });
  }
  async function run(kind: ApprovalOperationKind, overrides: Partial<ApprovalOperation> = {}, actor = operator) {
    const op = await command(kind, overrides), token = issueSyntheticApprovalAuthorization(op, actor);
    return { outcome: await store.attempt(op, token), op, token };
  }
  async function open() { await run("create"); await run("request-approval"); }
  async function approve() { await open(); await run("approve"); }
  return { adapter, store, request, heads, command, run, open, approve,
    setBinding(value: ApprovalBinding) { currentBinding = value; }, setTime(value: string) { time = value; },
    async addStop(named = false) { const value = stop(named ? request.approval.approvalRequestId : null); await adapter.transact((tx) => tx.aggregates.create({ aggregateType: "project-stop", aggregateId: value.projectStopId, schemaVersion: 1, payload: value })); },
  };
}
export function wrapTransaction(adapter: PersistenceAdapter, wrap: (tx: TransactionContext) => TransactionContext): PersistenceAdapter {
  return { transact: (work) => adapter.transact((tx) => work(wrap(tx))), migrationStatus: () => adapter.migrationStatus(), close: () => adapter.close() };
}
