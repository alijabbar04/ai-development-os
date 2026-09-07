import { parseDecision, type Decision } from "@ai-dev-os/project";
import type { PersistenceAdapter } from "@ai-dev-os/persistence";
import { createPlanPersistenceBoundary, planSha256, c8AcceptedBriefAggregateId, type PlanPersistenceOptions } from "../persistence-boundary.js";
import { operationKindsOf, type AuthenticatedOperatorClaimEvidence, type IssuedPlanCommitFacts, type PlanCommitAuthorization, type PlanCommitRequest, type PlanDigestPort, type PlanStore } from "../index.js";
import { parseAuthenticatedOperatorEvidence } from "../validation.js";
export { planSha256, c8AcceptedBriefAggregateId };
export type { IntakeAcceptanceEventPayload } from "@ai-dev-os/intake";
export type C8C7PlanStoreOptions = PlanPersistenceOptions;
const issued = new WeakMap<object, IssuedPlanCommitFacts>();
const consumed = new WeakSet<object>();
/** Synthetic fixture issuer. Production composition never imports this module. */
export function issueSyntheticPlanCommitAuthorization(request: PlanCommitRequest, authenticatedOperatorEvidence: readonly AuthenticatedOperatorClaimEvidence[] = [], decisions: readonly Decision[] = []): PlanCommitAuthorization {
  const token = Object.freeze(Object.create(null)) as PlanCommitAuthorization;
  issued.set(token, Object.freeze({ projectId: request.projectId, contentDigest: request.binding.contentDigest,
    operationKinds: operationKindsOf(request), eventIds: Object.freeze(request.steps.map(step => step.eventId)),
    authenticatedOperatorEvidence: parseAuthenticatedOperatorEvidence(authenticatedOperatorEvidence), decisions: Object.freeze(decisions.map(decision => parseDecision(decision))) }));
  return token;
}
export function createC8C7PlanStore(adapter: PersistenceAdapter, digest: PlanDigestPort = planSha256, options: C8C7PlanStoreOptions = Object.freeze({})): PlanStore {
  return createPlanPersistenceBoundary(adapter, { take(authorization) {
    if (authorization === null || typeof authorization !== "object" || consumed.has(authorization)) return null;
    const facts = issued.get(authorization) ?? null;
    if (facts !== null) { consumed.add(authorization); issued.delete(authorization); }
    return facts;
  } }, digest, options);
}
