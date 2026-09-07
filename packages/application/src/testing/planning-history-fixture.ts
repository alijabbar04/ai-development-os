import type { PersistenceAdapter } from "@ai-dev-os/persistence";
import { parseApprovalOperation, prepareApprovalRequest, type ApprovalBinding } from "@ai-dev-os/approval";
import { parseProject } from "@ai-dev-os/project";
import { createPlanningApprovalOwner, readPlanningApprovalControls, readPlanningApprovalPair, verifyPlanningMoneyHistory } from "../planning-approval.js";
import { readPlanningFoundations } from "../planning-plan.js";
import { digestPlanning, planningHash } from "../planning-validation.js";
import { writePlanningAggregate } from "../planning-ledger.js";

/** TEST ONLY. The caller must own the disposable adapter. This seeds a past
 * synthetic consumed pair; it never contacts a vendor or obtains a quote. No
 * production entry imports this module or exposes this fixture through IPC. */
export async function seedOwnedPlanningHistoryForTesting(persistence: PersistenceAdapter, projectId: string, fixtureId: string, drift = true) {
  if (!/^synthetic-history:[A-Za-z0-9-]{1,40}$/u.test(fixtureId)) throw new Error("SYNTHETIC_HISTORY_ID_REQUIRED");
  const at = new Date().toISOString(), future = new Date(Date.parse(at) + 3600000).toISOString();
  const binding = await persistence.transact(async (tx) => {
    const f = await readPlanningFoundations(tx, projectId);
    const lookup: ApprovalBinding = { project: { projectId, version: f.projectEnvelope.aggregateVersion, contentDigest: f.projectEnvelope.checksum.hex, budgetAccountId: f.project.budgetAccountId },
      scope: { projectId, taskId: null, providerInstanceId: null, workspaceId: null, operationId: `${fixtureId}:past`, traceId: null }, accountRef: null, providerModelId: null,
      policy: { version: "lookup", fingerprint: "a".repeat(64) }, plan: null };
    return (await readPlanningApprovalControls(tx, lookup, at)).binding;
  });
  const prepared = prepareApprovalRequest({ schemaVersion: 1, class: "purchase", risk: "low", binding,
    spending: { vendor: { name: "Owned synthetic historical vendor", instanceRef: "vendor:synthetic-only" }, amount: { kind: "known", minorUnits: 500 }, currency: "GBP", recurrence: null,
      quote: { digest: digestPlanning([fixtureId, "synthetic-quote-metadata"]), quotedAt: at, expiresAt: future } },
    explanation: { reason: "paid-resource-required", alternatives: ["defer"], consequence: "waits-for-decision", expectedMinorUnits: null, renewal: "not-recurring", taxAndFees: "unknown", foreignExchange: "none", entitlement: "unknown",
      note: { origin: "operator", text: "Owned synthetic historical record. No quote retrieval, purchase, payment or external execution occurred." } }, createdAt: at, expiresAt: future }, at, planningHash);
  if (prepared.kind !== "ready") throw new Error("SYNTHETIC_HISTORY_NOT_READY");
  const owner = createPlanningApprovalOwner(persistence, { now: () => new Date(at) });
  const confirmation = { reviewId: `${fixtureId}:review`, identityRef: "operator:local-desktop" as const, approverClass: "project-owner" as const, confirmedAt: at, subjectDigest: digestPlanning(prepared.request) };
  for (const kind of ["create", "request-approval", "approve", "authorize"] as const) {
    const pair = await persistence.transact((tx) => readPlanningApprovalPair(tx, prepared.request.approval.approvalRequestId));
    const op = parseApprovalOperation({ schemaVersion: 1, kind, operationId: `${fixtureId}:${kind}`, request: prepared.request, successor: null,
      expectedApprovalVersion: pair?.approvalEnvelope.aggregateVersion ?? 0, expectedSpendingVersion: pair?.spendingEnvelope?.aggregateVersion ?? 0, at, receiptRef: null }, planningHash);
    if ((await owner.attemptConfirmed(op, confirmation)).kind !== "committed") throw new Error("SYNTHETIC_HISTORY_WRITE_REFUSED");
  }
  const original = (await persistence.transact((tx) => readPlanningApprovalPair(tx, prepared.request.approval.approvalRequestId)))!;
  if (drift) await persistence.transact(async (tx) => {
    const f = await readPlanningFoundations(tx, projectId);
    await writePlanningAggregate(tx, "project", projectId, parseProject({ ...f.project, revision: f.project.revision + 1, displayName: `${f.project.displayName} revised`, updatedAt: at }), f.projectEnvelope.aggregateVersion,
      `${fixtureId}:drift`, "project.synthetic-history-context-changed", at);
  });
  return Object.freeze({ approvalId: original.approval.approvalRequestId, approvalDigest: digestPlanning(original.approval), consumptionCount: original.approval.consumptionCount, amountMinorUnits: original.spending!.amountMinorUnits,
    currency: original.spending!.currency, fixtureProvenance: "synthetic historical consumed pair and optional Project binding drift; no external activity" });
}

/** Read-only verification of the owned demonstration's original consumed pair. */
export async function verifyOwnedPlanningHistoryForTesting(persistence: PersistenceAdapter, original: Awaited<ReturnType<typeof seedOwnedPlanningHistoryForTesting>>) {
  return await persistence.transact(async (tx) => {
    const pair = await readPlanningApprovalPair(tx, original.approvalId);
    if (pair === null) throw new Error("HISTORY_ORIGINAL_PAIR_MISSING");
    await verifyPlanningMoneyHistory(tx, pair);
    if (digestPlanning(pair.approval) !== original.approvalDigest || pair.approval.state !== "consumed" || pair.approval.consumptionCount !== 1 || original.consumptionCount !== 1 ||
        pair.spending?.amountMinorUnits !== original.amountMinorUnits || pair.spending?.currency !== original.currency || pair.spending?.state !== "reconciled") throw new Error("HISTORY_ORIGINAL_AUTHORITY_CHANGED");
    return { approvalUnchanged: true, consumptionCount: pair.approval.consumptionCount, amountMinorUnits: pair.spending.amountMinorUnits, currency: pair.spending.currency, spendingState: pair.spending.state };
  });
}
