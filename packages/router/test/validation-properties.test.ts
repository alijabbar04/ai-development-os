import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTER_CONFIGURATION,
  candidatePolicyEvidenceFingerprint,
  catalogCandidateEvidenceFingerprint,
  createCatalogCandidateEvidence,
  createManualRouterClock,
  createRoutingCandidate,
  createRoutingCapacityEvidence,
  createRoutingCostEstimate,
  createRoutingQuotaEvidence,
  createRoutingRequest,
  parseCandidatePolicyEvidence,
  parseCatalogCandidateEvidence,
  parseRouteDecision,
  parseRoutingCandidate,
  parseRoutingRequest,
  parseSecureExecutionEvidence,
  routeTask,
  secureExecutionEvidenceFingerprint,
  summarizeRouteDecision,
  explainRouteDecision,
  type RoutingCandidateSnapshot,
  type RoutingRequest
} from "../src/index.js";
import {
  ROUTER_PROPERTY_SEEDS,
  budgetAccountFixture,
  fixtureDigest,
  providerCatalogFixture,
  routingRequestFixture
} from "../src/testing/fixtures.js";

const EPOCH = "2026-08-05T10:00:00.000Z";

function route(request: RoutingRequest) {
  return routeTask(request, {
    configuration: DEFAULT_ROUTER_CONFIGURATION,
    clock: createManualRouterClock(EPOCH)
  });
}

function recreateCandidate(
  candidate: RoutingCandidateSnapshot,
  changes: Partial<Omit<RoutingCandidateSnapshot, "schemaVersion" | "healthFingerprint" | "fingerprint">>
): RoutingCandidateSnapshot {
  const { schemaVersion: _schema, healthFingerprint: _health, fingerprint: _fingerprint, ...base } = candidate;
  return createRoutingCandidate({ ...base, ...changes });
}

function recreateRequest(
  request: RoutingRequest,
  changes: Partial<Omit<RoutingRequest, "schemaVersion" | "fingerprint">>
): RoutingRequest {
  const { schemaVersion: _schema, fingerprint: _fingerprint, ...base } = request;
  return createRoutingRequest({ ...base, ...changes });
}

function shuffled<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const selected = state % (index + 1);
    [result[index], result[selected]] = [result[selected]!, result[index]!];
  }
  return result;
}

describe("evidence validation and substitution resistance", () => {
  it("normalizes gateway evidence without credential-reference material", async () => {
    const request = await routingRequestFixture({ specs: [{ candidateId: "safe", alias: "safe" }] });
    const serialized = JSON.stringify(request.candidates[0]!.gateway);
    expect(serialized).not.toContain("secretRefFingerprint");
    expect(serialized).not.toContain("secret-reference-safe");
    expect(request.candidates[0]!.gateway.gatewaySnapshotFingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects candidate, quota, policy, secure-evidence, and decision fingerprint tampering", async () => {
    const request = await routingRequestFixture({ specs: [{ candidateId: "tamper", alias: "tamper" }] });
    const candidate = request.candidates[0]!;
    expect(() => parseRoutingCandidate({ ...candidate, expectedLatencyMs: 1 }))
      .toThrow(/fingerprint/u);
    expect(() => parseRoutingRequest({ ...request, requestId: "changed" }))
      .toThrow(/fingerprint/u);
    expect(() => parseCandidatePolicyEvidence({
      ...candidate.policy,
      authority: "none",
      fingerprint: "0".repeat(64)
    })).toThrow(/fingerprint/u);
    expect(() => parseSecureExecutionEvidence({
      ...candidate.secureExecution,
      fingerprint: "0".repeat(64)
    })).toThrow(/fingerprint/u);
    const decision = route(request);
    expect(() => parseRouteDecision({ ...decision, validUntil: "2026-08-05T10:02:00.000Z" }))
      .toThrow(/fingerprint/u);
  });

  it("rejects provider/model/catalog/quota/capacity/circuit/estimator substitution", async () => {
    const request = await routingRequestFixture({
      specs: [
        { candidateId: "scope-a", alias: "scope-a" },
        { candidateId: "scope-b", alias: "scope-b" }
      ]
    });
    const first = request.candidates.find((item) => item.candidateId === "scope-a")!;
    const second = request.candidates.find((item) => item.candidateId === "scope-b")!;
    for (const changes of [
      { gateway: second.gateway },
      { catalog: second.catalog },
      { quota: second.quota },
      { capacity: second.capacity },
      { circuit: second.circuit },
      { tokenEstimate: second.tokenEstimate }
    ]) {
      expect(() => recreateCandidate(first, changes)).toThrow(/identity|candidate/u);
    }
  });

  it("rejects invented known cost when the bound model has no price evidence", async () => {
    const request = await routingRequestFixture({
      specs: [{ candidateId: "invented-cost", alias: "invented-cost", costMicrosPerMillion: null }],
      budgetAccount: budgetAccountFixture({
        maximumCostMicros: null
      })
    });
    const candidate = request.candidates[0]!;
    const invented = createRoutingCostEstimate({
      status: "known",
      currency: "USD",
      amountMicros: 1,
      evidenceFingerprint: fixtureDigest("invented-price")
    });
    const changed = recreateRequest(request, {
      candidates: [recreateCandidate(candidate, { costEstimate: invented })]
    });
    expect(route(changed).rejections[0]?.codes).toContain("COST_EVIDENCE_MISMATCH");
  });

  it("rejects health-fingerprint substitution and duplicate candidate identities", async () => {
    const request = await routingRequestFixture({ specs: [{ candidateId: "duplicate", alias: "duplicate" }] });
    const candidate = request.candidates[0]!;
    expect(() => parseRoutingCandidate({
      ...candidate,
      health: { ...candidate.health, activeOperations: 1 }
    })).toThrow(/health snapshot/u);
    expect(() => recreateRequest(request, { candidates: [candidate, candidate] }))
      .toThrow(/unique/u);
    expect(() => recreateRequest(request, { halfOpenProbeCandidateId: "absent" }))
      .toThrow(/reference a candidate/u);
  });

  it("binds catalog excerpts and rejects absent provider/model selections", () => {
    const catalog = providerCatalogFixture([{ candidateId: "catalog-a", alias: "catalog-a" }]);
    const evidence = createCatalogCandidateEvidence({
      catalog,
      providerId: "provider-catalog-a",
      modelId: "model-catalog-a"
    });
    expect(parseCatalogCandidateEvidence(evidence)).toEqual(evidence);
    const { fingerprint: _fingerprint, ...unsigned } = evidence;
    expect(catalogCandidateEvidenceFingerprint(unsigned)).toBe(evidence.fingerprint);
    expect(() => createCatalogCandidateEvidence({
      catalog,
      providerId: "provider-absent",
      modelId: "model-catalog-a"
    })).toThrow(/absent/u);
    expect(() => createCatalogCandidateEvidence({
      catalog,
      providerId: "provider-catalog-a",
      modelId: "model-absent"
    })).toThrow(/absent/u);
  });

  it("preserves correction/reset evidence in an exact quota scope", async () => {
    const request = await routingRequestFixture({ specs: [{ candidateId: "correction", alias: "correction" }] });
    const candidate = request.candidates[0]!;
    const quota = createRoutingQuotaEvidence({
      providerInstanceId: candidate.gateway.instanceId,
      contractModelId: candidate.gateway.contractModelId,
      scopeFingerprint: fixtureDigest("exact-scope"),
      state: "limited",
      completeness: "partial",
      observedAt: "2026-08-05T09:59:30.000Z",
      staleAt: "2026-08-05T10:00:30.000Z",
      resetsAt: null,
      dimensions: [{ dimension: "tokens", remaining: 100_000, limit: 1_000_000 }],
      sourceFingerprint: fixtureDigest("ledger-source"),
      correctionFingerprint: fixtureDigest("ledger-correction")
    });
    expect(quota.correctionFingerprint).toBe(fixtureDigest("ledger-correction"));
    expect(quota.resetsAt).toBeNull();
    const capacity = createRoutingCapacityEvidence({
      providerInstanceId: candidate.gateway.instanceId,
      contractModelId: candidate.gateway.contractModelId,
      scopeFingerprint: fixtureDigest("capacity-scope"),
      state: "unknown",
      completeness: "unknown",
      observedAt: "2026-08-05T09:59:30.000Z",
      staleAt: "2026-08-05T10:00:30.000Z",
      availableConcurrency: null,
      availableMemoryBytes: null,
      requiredMemoryBytes: null,
      sourceFingerprint: fixtureDigest("capacity-source")
    });
    expect(capacity.availableMemoryBytes).toBeNull();
  });

  it("seals policy and secure-execution evidence with canonical fingerprints", async () => {
    const request = await routingRequestFixture({ specs: [{ candidateId: "sealed", alias: "sealed" }] });
    const candidate = request.candidates[0]!;
    const { fingerprint: _policyFingerprint, ...policyUnsigned } = candidate.policy;
    const { fingerprint: _secureFingerprint, ...secureUnsigned } = candidate.secureExecution;
    expect(candidatePolicyEvidenceFingerprint(policyUnsigned)).toBe(candidate.policy.fingerprint);
    expect(secureExecutionEvidenceFingerprint(secureUnsigned))
      .toBe(candidate.secureExecution.fingerprint);
  });
});

describe("seeded routing properties", () => {
  it.each(ROUTER_PROPERTY_SEEDS)("is invariant to candidate order for seed %i", async (seed) => {
    const request = await routingRequestFixture({
      specs: Array.from({ length: 7 }, (_, index) => ({
        candidateId: `property-${index}`,
        alias: `property-${index}`,
        expectedLatencyMs: 100 + index * 37,
        tokensRemaining: 500_000 + index * 10_000,
        freeTierState: index % 2 === 0 ? "verified" as const : "not-free" as const
      }))
    });
    const expected = route(request);
    const permuted = recreateRequest(request, { candidates: shuffled(request.candidates, seed) });
    expect(permuted.fingerprint).toBe(request.fingerprint);
    expect(route(permuted)).toEqual(expected);
  });

  it("keeps every score component and total within finite integer bounds", async () => {
    const decision = route(await routingRequestFixture());
    for (const choice of decision.feasible) {
      expect(Number.isSafeInteger(choice.totalScore)).toBe(true);
      for (const component of choice.scoreComponents) {
        expect(Number.isSafeInteger(component.value)).toBe(true);
        expect(component.value).toBeGreaterThanOrEqual(-1_000);
        expect(component.value).toBeLessThanOrEqual(1_000);
        expect(component.weightedValue).toBe(component.value * component.weight);
      }
    }
  });

  it("treats the quota freshness boundary inclusively and one millisecond beyond as stale", async () => {
    const boundary = route(await routingRequestFixture({
      specs: [{
        candidateId: "fresh-boundary",
        alias: "fresh-boundary",
        quotaObservedAt: "2026-08-05T09:59:00.000Z"
      }]
    }));
    expect(boundary.outcome).toBe("routed");
    const stale = route(await routingRequestFixture({
      specs: [{
        candidateId: "stale-boundary",
        alias: "stale-boundary",
        quotaObservedAt: "2026-08-05T09:58:59.999Z"
      }]
    }));
    expect(stale.rejections[0]?.codes).toContain("QUOTA_STALE");
  });

  it("does not let suggestive opaque identifiers affect score evidence", async () => {
    const request = await routingRequestFixture({
      specs: [
        { candidateId: "ultra-free-exact", alias: "ultra-free-exact", expectedLatencyMs: 400 },
        { candidateId: "weak-paid-guess", alias: "weak-paid-guess", expectedLatencyMs: 400 }
      ]
    });
    const decision = route(request);
    const left = decision.feasible.find((item) => item.candidateId === "ultra-free-exact")!;
    const right = decision.feasible.find((item) => item.candidateId === "weak-paid-guess")!;
    const withoutAlias = (choice: typeof left) => choice.scoreComponents
      .filter((item) => item.term !== "alias-priority")
      .map(({ term, value, weight, weightedValue, evidenceCode }) => ({
        term, value, weight, weightedValue, evidenceCode
      }));
    expect(withoutAlias(left)).toEqual(withoutAlias(right));
  });

  it("keeps summary and explanation ordering canonical", async () => {
    const decision = route(await routingRequestFixture({
      specs: [
        { candidateId: "z-reject", alias: "z-reject", quotaState: "exhausted" },
        { candidateId: "a-reject", alias: "a-reject", policyOutcome: "denied" }
      ]
    }));
    expect(summarizeRouteDecision(decision).outcome).toBe("no-route");
    const explanation = explainRouteDecision(decision);
    expect(explanation.rejectionCodes).toEqual([...explanation.rejectionCodes].sort());
  });
});
