import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTER_CONFIGURATION,
  circuitIdentityFingerprint,
  createManualRouterClock,
  createRouter,
  createRouterConfiguration,
  createRoutingCandidate,
  createRoutingRequest,
  explainRouteDecision,
  routeTask,
  summarizeRouteDecision,
  transitionCircuitBreaker,
  type RouteDecision,
  type RouteRejectionCode,
  type RouterConfiguration,
  type RoutingCandidateSnapshot,
  type RoutingRequest
} from "../src/index.js";
import {
  ROUTER_LEAK_CANARY,
  budgetAccountFixture,
  routingRequestFixture,
  type CandidateFixtureSpec
} from "../src/testing/fixtures.js";

const EPOCH = "2026-08-05T10:00:00.000Z";

function decide(request: RoutingRequest, configuration: RouterConfiguration = DEFAULT_ROUTER_CONFIGURATION): RouteDecision {
  return routeTask(request, {
    configuration,
    clock: createManualRouterClock(EPOCH)
  });
}

function rejectionCodes(decision: RouteDecision): readonly RouteRejectionCode[] {
  return decision.rejections.flatMap((item) => item.codes);
}

function replaceCandidate(
  candidate: RoutingCandidateSnapshot,
  changes: Partial<Omit<RoutingCandidateSnapshot, "schemaVersion" | "healthFingerprint" | "fingerprint">>
): RoutingCandidateSnapshot {
  const { schemaVersion: _schema, healthFingerprint: _health, fingerprint: _fingerprint, ...base } = candidate;
  return createRoutingCandidate({ ...base, ...changes });
}

function replaceRequest(
  request: RoutingRequest,
  changes: Partial<Omit<RoutingRequest, "schemaVersion" | "fingerprint">>
): RoutingRequest {
  const { schemaVersion: _schema, fingerprint: _fingerprint, ...base } = request;
  return createRoutingRequest({ ...base, ...changes });
}

async function one(spec: CandidateFixtureSpec, options: {
  readonly configuration?: RouterConfiguration;
  readonly verifiedFreeOnly?: boolean;
  readonly requiredMaximumLatencyMs?: number | null;
  readonly budgetAccount?: ReturnType<typeof budgetAccountFixture>;
  readonly surface?: "thinker-inference" | "task-execution";
} = {}): Promise<RouteDecision> {
  const configuration = options.configuration ?? DEFAULT_ROUTER_CONFIGURATION;
  const request = await routingRequestFixture({
    specs: [spec],
    routerConfiguration: configuration,
    verifiedFreeOnly: options.verifiedFreeOnly,
    requiredMaximumLatencyMs: options.requiredMaximumLatencyMs,
    budgetAccount: options.budgetAccount,
    surface: options.surface
  });
  return decide(request, configuration);
}

describe("deterministic route selection", () => {
  it("selects a primary and bounded fallbacks only from the feasible set", async () => {
    const request = await routingRequestFixture();
    const decision = decide(request);
    expect(decision.outcome).toBe("routed");
    expect(decision.primary?.candidateId).toBe("alternate");
    expect(decision.fallbacks.map((item) => item.candidateId)).toEqual(["local", "primary"]);
    expect(decision.feasible).toHaveLength(3);
    expect(decision.rejections).toEqual([]);
    expect(decision.primary?.scoreComponents).toHaveLength(13);
    expect(decision.authority).toBe("none");
    expect(decision.grantsAuthority).toBe(false);
    expect(decision.requiresExecutionTimeRevalidation).toBe(true);
    expect(decision.providerInvocationPerformed).toBe(false);
    expect(decision.durableMutationPerformed).toBe(false);
  });

  it("canonicalizes candidate permutations and uses a fingerprint tie-break", async () => {
    const configuration = createRouterConfiguration({
      scoreWeights: Object.freeze({
        ...DEFAULT_ROUTER_CONFIGURATION.scoreWeights,
        "alias-priority": 0
      })
    });
    const request = await routingRequestFixture({
      specs: [
        { candidateId: "same-a", alias: "same-a", expectedLatencyMs: 400 },
        { candidateId: "same-b", alias: "same-b", expectedLatencyMs: 400 }
      ],
      routerConfiguration: configuration
    });
    const permuted = replaceRequest(request, { candidates: [...request.candidates].reverse() });
    expect(permuted.fingerprint).toBe(request.fingerprint);
    const first = decide(request, configuration);
    const second = decide(permuted, configuration);
    expect(second).toEqual(first);
    expect(first.feasible.map((item) => item.candidateFingerprint))
      .toEqual([...first.feasible.map((item) => item.candidateFingerprint)].sort());
  });

  it("gives a feasible explicit alias precedence and can disable fallbacks", async () => {
    const pinned = decide(await routingRequestFixture({ explicitAlias: "primary" }));
    expect(pinned.primary?.selectedAlias).toBe("primary");
    expect(pinned.fallbacks[0]?.lowerRankReason).toBe("explicit-pin-precedence");
    const strict = decide(await routingRequestFixture({
      explicitAlias: "primary",
      allowFallbacks: false
    }));
    expect(strict.primary?.selectedAlias).toBe("primary");
    expect(strict.fallbacks).toEqual([]);
    expect(strict.feasible).toHaveLength(1);
  });

  it("does not substitute an infeasible strict pin but permits explicit fallback when allowed", async () => {
    const specs = [
      { candidateId: "pinned", alias: "pinned", quotaState: "exhausted" as const },
      { candidateId: "eligible", alias: "eligible" }
    ];
    const strict = decide(await routingRequestFixture({
      specs,
      explicitAlias: "pinned",
      allowFallbacks: false
    }));
    expect(strict.outcome).toBe("no-route");
    const permissive = decide(await routingRequestFixture({
      specs,
      explicitAlias: "pinned",
      allowFallbacks: true
    }));
    expect(permissive.primary?.candidateId).toBe("eligible");
  });

  it("rejects every candidate for an unconfigured explicit alias", async () => {
    const decision = decide(await routingRequestFixture({ explicitAlias: "missing" }));
    expect(decision.outcome).toBe("no-route");
    expect(rejectionCodes(decision)).toContain("EXPLICIT_ALIAS_MISMATCH");
  });

  it("contains observer failures, emits only body-free audit facts, and closes deterministically", async () => {
    const events: unknown[] = [];
    const router = createRouter({
      clock: createManualRouterClock(EPOCH),
      observer: (event) => {
        events.push(event);
        throw new Error(ROUTER_LEAK_CANARY);
      }
    });
    const decision = router.route(await routingRequestFixture());
    expect(decision.outcome).toBe("routed");
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(ROUTER_LEAK_CANARY);
    expect(JSON.stringify(decision)).not.toContain(ROUTER_LEAK_CANARY);
    router.close();
    expect(() => router.route({})).toThrow(/closed/u);
  });

  it("produces bounded body-free summaries and explanations", async () => {
    const decision = decide(await routingRequestFixture({
      specs: [
        { candidateId: "good", alias: "good" },
        { candidateId: "bad", alias: "bad", policyOutcome: "denied" }
      ]
    }));
    const summary = summarizeRouteDecision(decision);
    const explanation = explainRouteDecision(decision);
    expect(summary.primaryCandidateId).toBe("good");
    expect(explanation.rejectionCodes).toContain("POLICY_DENIED");
    expect(explanation.statement).toBe("ROUTE_GRANTS_NO_AUTHORITY");
    expect(JSON.stringify({ summary, explanation })).not.toContain("Untrusted fixture context");
  });
});

describe("hard feasibility filters", () => {
  it.each([
    [{ candidateId: "user-off", alias: "user-off", userPreference: "disabled" }, "USER_DISABLED"],
    [{ candidateId: "denied", alias: "denied", policyOutcome: "denied" }, "POLICY_DENIED"],
    [{ candidateId: "conditional", alias: "conditional", policyOutcome: "conditional" }, "POLICY_CONDITIONAL"],
    [{ candidateId: "class", alias: "class", classification: "secret" }, "CLASSIFICATION_MISMATCH"],
    [{ candidateId: "catalog", alias: "catalog", catalogState: "disabled" }, "CATALOG_PROVIDER_DISABLED"],
    [{ candidateId: "model-off", alias: "model-off", modelAvailability: "unavailable" }, "MODEL_UNAVAILABLE"],
    [{ candidateId: "reason", alias: "reason", reasoningCapability: 1 }, "REASONING_RATING_INSUFFICIENT"],
    [{ candidateId: "coding", alias: "coding", codingCapability: 1 }, "CODING_RATING_INSUFFICIENT"],
    [{ candidateId: "context-unknown", alias: "context-unknown", contextTokens: null }, "CONTEXT_LIMIT_UNKNOWN"],
    [{ candidateId: "context-small", alias: "context-small", contextTokens: 9_000, maximumOutputTokens: 4_096 }, "CONTEXT_LIMIT_EXCEEDED"],
    [{ candidateId: "output-unknown", alias: "output-unknown", maximumOutputTokens: null }, "OUTPUT_LIMIT_UNKNOWN"],
    [{ candidateId: "output-small", alias: "output-small", maximumOutputTokens: 100 }, "OUTPUT_LIMIT_EXCEEDED"],
    [{ candidateId: "unavailable", alias: "unavailable", healthStatus: "unavailable" }, "PROVIDER_UNAVAILABLE"],
    [{ candidateId: "closed", alias: "closed", healthStatus: "closed" }, "PROVIDER_CLOSED"],
    [{ candidateId: "quota-old", alias: "quota-old", quotaStaleAt: "2026-08-05T09:59:59.999Z" }, "QUOTA_STALE"],
    [{ candidateId: "quota-unknown", alias: "quota-unknown", quotaState: "unknown" }, "QUOTA_UNKNOWN"],
    [{ candidateId: "quota-partial", alias: "quota-partial", quotaCompleteness: "partial" }, "QUOTA_PARTIAL"],
    [{ candidateId: "quota-empty", alias: "quota-empty", quotaState: "exhausted" }, "QUOTA_EXHAUSTED"],
    [{ candidateId: "quota-low", alias: "quota-low", tokensRemaining: 1 }, "QUOTA_INSUFFICIENT"],
    [{ candidateId: "local-old", alias: "local-old", locality: "local", capacityStaleAt: "2026-08-05T09:59:59.999Z" }, "CAPACITY_STALE"],
    [{ candidateId: "local-unknown", alias: "local-unknown", locality: "local", capacityState: "unknown" }, "CAPACITY_UNKNOWN"],
    [{ candidateId: "local-busy", alias: "local-busy", locality: "local", availableConcurrency: 1 }, "CAPACITY_INSUFFICIENT"],
    [{ candidateId: "local-memory", alias: "local-memory", locality: "local", availableMemoryBytes: 4_100_000_000, requiredMemoryBytes: 4_000_000_000 }, "CAPACITY_INSUFFICIENT"],
    [{ candidateId: "heuristic", alias: "heuristic", estimatorAccuracy: "heuristic" }, "ESTIMATOR_ACCURACY_INSUFFICIENT"],
    [{ candidateId: "old-catalog", alias: "old-catalog", catalogRefreshAfter: "2026-08-05T09:59:59.999Z" }, "CATALOG_EXPIRED"]
  ] as const)("rejects %s with %s", async (spec, code) => {
    const decision = await one(spec);
    expect(decision.outcome).toBe("no-route");
    expect(rejectionCodes(decision)).toContain(code);
  });

  it("enforces verified-free-only against unknown/not-free/ineligible evidence", async () => {
    for (const freeTierState of ["unknown", "not-free", "ineligible"] as const) {
      const decision = await one(
        { candidateId: `free-${freeTierState}`, alias: `free-${freeTierState}`, freeTierState },
        { verifiedFreeOnly: true }
      );
      expect(rejectionCodes(decision)).toContain("FREE_TIER_NOT_VERIFIED");
    }
    expect((await one(
      { candidateId: "free-good", alias: "free-good", freeTierState: "verified" },
      { verifiedFreeOnly: true }
    )).outcome).toBe("routed");
    expect(rejectionCodes(await one({
      candidateId: "gateway-free",
      alias: "gateway-free",
      gatewayEligibility: "verified-free-only",
      freeTierState: "not-free"
    }))).toContain("FREE_TIER_NOT_VERIFIED");
  });

  it("enforces cost proof, currency, token budget, and latency ceilings", async () => {
    expect(rejectionCodes(await one({
      candidateId: "unknown-cost",
      alias: "unknown-cost",
      costMicrosPerMillion: null
    }))).toContain("COST_UNKNOWN");
    expect(rejectionCodes(await one(
      { candidateId: "currency", alias: "currency" },
      { budgetAccount: budgetAccountFixture({ currency: "GBP" }) }
    ))).toContain("CURRENCY_MISMATCH");
    expect(rejectionCodes(await one(
      { candidateId: "over-budget", alias: "over-budget" },
      { budgetAccount: budgetAccountFixture({ maximumTokens: 1 }) }
    ))).toContain("BUDGET_INSUFFICIENT");
    expect(rejectionCodes(await one(
      { candidateId: "slow", alias: "slow", expectedLatencyMs: 500 },
      { requiredMaximumLatencyMs: 100 }
    ))).toContain("LATENCY_INCOMPATIBLE");
    expect(rejectionCodes(await one(
      { candidateId: "latency-unknown", alias: "latency-unknown", expectedLatencyMs: null },
      { requiredMaximumLatencyMs: 100 }
    ))).toContain("LATENCY_INCOMPATIBLE");
  });

  it("enforces logging, network, retention, and training policy incompatibilities", async () => {
    const profileShape = {
      kind: "review" as const,
      complexity: 2 as const,
      risk: "high" as const,
      reasoning: "high" as const,
      editScope: "none" as const,
      capabilities: Object.freeze(["reasoning", "repository-read", "structured-output"] as const),
      dataClassification: "personal" as const,
      expectedOutputTokens: 1_024
    };
    const decision = decide(await routingRequestFixture({
      specs: [{
        candidateId: "private-policy",
        alias: "private-policy",
        locality: "local",
        classification: "personal",
        inputLoggingAllowed: true,
        networkAccess: true,
        retainsData: true,
        trainsOnInputs: true
      }],
      profileShape
    }));
    expect(rejectionCodes(decision)).toEqual(expect.arrayContaining([
      "LOGGING_INCOMPATIBLE",
      "NETWORK_INCOMPATIBLE",
      "RETENTION_INCOMPATIBLE",
      "TRAINING_INCOMPATIBLE"
    ]));
  });

  it("copies conservative policy and authority restrictions into the decision", async () => {
    const decision = decide(await routingRequestFixture({
      specs: [{
        candidateId: "personal-local",
        alias: "personal-local",
        locality: "local",
        classification: "personal"
      }],
      profileShape: {
        kind: "explain",
        complexity: 1,
        risk: "low",
        reasoning: "medium",
        editScope: "none",
        capabilities: Object.freeze(["reasoning", "structured-output"]),
        dataClassification: "personal",
        expectedOutputTokens: 512
      }
    }));
    expect(decision.outcome).toBe("routed");
    expect(decision.restrictions.requiredLocality).toBe("local");
    expect(decision.restrictions.approvalRequired).toBe(true);
    expect(decision.restrictions.logRetentionAllowed).toBe(false);
    expect(decision.restrictions.redactionsRequiredBeforeDisclosure)
      .toEqual(["personal-data", "secrets"]);
  });

  it("scales cost and latency terms only through bounded configured preferences", async () => {
    const specs = [{ candidateId: "preference", alias: "preference", expectedLatencyMs: 400 }];
    const disabled = decide(await routingRequestFixture({
      specs,
      costPriority: 0,
      latencyPriority: 0
    }));
    const emphasized = decide(await routingRequestFixture({
      specs,
      costPriority: 100,
      latencyPriority: 100
    }));
    const value = (decision: RouteDecision, term: string) =>
      decision.primary?.scoreComponents.find((component) => component.term === term)?.value;
    expect(value(disabled, "cost-efficiency")).toBe(0);
    expect(value(disabled, "latency-margin")).toBe(0);
    expect(value(emphasized, "cost-efficiency")).not.toBe(0);
    expect(value(emphasized, "latency-margin")).not.toBe(0);
  });

  it("computes validity from the earliest declared or maximum-age evidence boundary", async () => {
    const decision = await one({
      candidateId: "validity-local",
      alias: "validity-local",
      locality: "local"
    });
    expect(decision.validUntil).toBe("2026-08-05T10:00:15.000Z");
  });

  it("keeps unknown quota explicit when configuration allows routing", async () => {
    const configuration = createRouterConfiguration({
      hardEvidence: Object.freeze({
        ...DEFAULT_ROUTER_CONFIGURATION.hardEvidence,
        requireKnownQuota: false
      }),
      confidence: Object.freeze({ minimum: 0 })
    });
    const decision = await one(
      { candidateId: "unknown-allowed", alias: "unknown-allowed", quotaState: "unknown" },
      { configuration }
    );
    expect(decision.outcome).toBe("routed");
    expect(decision.primary?.scoreComponents.find((item) => item.term === "quota-headroom")?.value)
      .toBe(-1_000);
    expect(decision.primary?.confidence).toBeLessThan(1_000);
  });

  it("uses fresh reset evidence only within its exact quota scope", async () => {
    const withReset = await one({ candidateId: "reset", alias: "reset" });
    const withoutReset = await one({
      candidateId: "no-reset",
      alias: "no-reset",
      quotaResetsAt: null
    });
    expect(withReset.primary?.scoreComponents.find((item) => item.term === "quota-headroom")?.evidenceCode)
      .toBe("fresh-quota-with-reset");
    expect(withoutReset.primary?.scoreComponents.find((item) => item.term === "quota-headroom")?.evidenceCode)
      .toBe("fresh-quota-without-reset");
  });

  it("requires a secure-enforcing backend for coding-agent admission", async () => {
    const rejected = await one({
      candidateId: "agent-advisory",
      alias: "agent-advisory",
      providerKind: "coding-agent",
      secureExecution: "advisory"
    }, { surface: "task-execution" });
    expect(rejectionCodes(rejected)).toContain("SECURE_EXECUTION_REQUIRED");
    const admitted = await one({
      candidateId: "agent-secure",
      alias: "agent-secure",
      providerKind: "coding-agent",
      secureExecution: "secure-enforcing"
    }, { surface: "task-execution" });
    expect(admitted.outcome).toBe("routed");
    const wrongSurface = await one({
      candidateId: "agent-thinker",
      alias: "agent-thinker",
      providerKind: "coding-agent",
      secureExecution: "secure-enforcing"
    });
    expect(rejectionCodes(wrongSurface)).toContain("WRONG_PROVIDER_KIND");
  });

  it("rejects open and unadmitted half-open circuit states", async () => {
    const configuration = createRouterConfiguration({
      circuitBreaker: Object.freeze({
        failureThreshold: 1,
        coolDownMs: 100,
        maximumRememberedEvents: 8
      })
    });
    const request = await routingRequestFixture({
      specs: [{ candidateId: "circuit", alias: "circuit" }],
      routerConfiguration: configuration
    });
    const original = request.candidates[0]!;
    const identityFingerprint = circuitIdentityFingerprint(original.circuit.identity);
    const opened = transitionCircuitBreaker({
      state: original.circuit,
      event: {
        eventId: "open-route-circuit",
        occurredAt: "2026-08-05T09:59:58.000Z",
        kind: "retryable-failure",
        identityFingerprint
      },
      configuration
    }).state;
    const openRequest = replaceRequest(request, {
      candidates: [replaceCandidate(original, { circuit: opened })]
    });
    expect(rejectionCodes(decide(openRequest, configuration))).toContain("CIRCUIT_OPEN");
    const halfOpen = transitionCircuitBreaker({
      state: opened,
      event: {
        eventId: "admit-route-probe",
        occurredAt: "2026-08-05T09:59:59.000Z",
        kind: "admit-probe",
        identityFingerprint
      },
      configuration
    }).state;
    const halfRequest = replaceRequest(request, {
      candidates: [replaceCandidate(original, { circuit: halfOpen })]
    });
    expect(rejectionCodes(decide(halfRequest, configuration)))
      .toContain("HALF_OPEN_PROBE_NOT_ADMITTED");
    const admitted = replaceRequest(halfRequest, { halfOpenProbeCandidateId: "circuit" });
    expect(decide(admitted, configuration).outcome).toBe("routed");
  });
});
