import { describe, expect, it } from "vitest";
import {
  PlanningError,
  ProductPlan,
  createProductPlanningConfiguration,
  isPlanningError,
  normalizeRequirementKey,
  parsePlanningContributionDraft,
  parseProductIntent,
  parseProductPlanningConfiguration,
  parseTrustedPlanningRoute,
  planningDigest,
  productPlanSnapshotDigest,
  replayPlanningEvents,
  stablePlanningId,
} from "../src/index.js";
import {
  ManualPlanningClock,
  applyPhase,
  candidate,
  completePhases,
  configuration,
  createPlan,
  decideAll,
  draft,
  evidence,
  intent,
} from "./fixtures.js";

function errorOf(work: () => unknown, code: PlanningError["code"]): PlanningError {
  try { work(); } catch (error) {
    expect(isPlanningError(error, code)).toBe(true);
    expect(JSON.stringify((error as PlanningError).toJSON())).not.toContain("secret-canary-value");
    return error as PlanningError;
  }
  throw new Error(`Expected ${code}`);
}

function decide(
  plan: ProductPlan,
  clock: ManualPlanningClock,
  requirementIndex: number,
  disposition: Parameters<ProductPlan["decideScope"]>[0]["disposition"],
  options: {
    readonly authority?: Parameters<ProductPlan["decideScope"]>[0]["actor"]["authority"];
    readonly approval?: string | null;
    readonly expectedVersion?: number;
    readonly digest?: string;
  } = {},
) {
  const requirement = plan.toSnapshot().requirements[requirementIndex]!;
  return plan.decideScope({
    requirementId: requirement.requirementId,
    requirementDigest: options.digest ?? requirement.requirementDigest,
    expectedPlanVersion: options.expectedVersion ?? plan.version,
    disposition,
    actor: { actorId: "actor:test", authority: options.authority ?? "product-owner" },
    reason: "Explicit bounded test decision.",
    approvalReference: options.approval === undefined
      ? (["required", "expected-quality", "delight-candidate", "waived"].includes(disposition) ? "approval:test" : null)
      : options.approval,
    decidedAt: clock.now().toISOString(),
  });
}

function approval(plan: ProductPlan, clock: ManualPlanningClock, overrides: Partial<Parameters<ProductPlan["approveSpecification"]>[0]> = {}) {
  return plan.approveSpecification({
    expectedPlanVersion: plan.version,
    decisionSetDigest: plan.currentDecisionSetDigest(),
    actor: { actorId: "actor:owner", authority: "product-owner" },
    approvalReference: "approval:spec",
    approvedAt: clock.now().toISOString(),
    ...overrides,
  });
}

describe("planning schema and configuration adversaries", () => {
  it("structurally encodes stable ID parts so delimiter injection cannot collide", () => {
    expect(stablePlanningId("test", `a\u001fb`, "c"))
      .not.toBe(stablePlanningId("test", "a", `b\u001fc`));
  });

  it("normalizes semantic keys deterministically and refuses punctuation-only identities", () => {
    expect(normalizeRequirementKey("  Café—Mode!!! ")).toBe("café mode");
    errorOf(() => normalizeRequirementKey("!!!"), "INVALID_INPUT");
  });

  it("rejects empty, duplicate, unknown, mismatched, and unbounded trusted configuration", () => {
    const valid = configuration();
    expect(() => createProductPlanningConfiguration({
      instanceId: "planning:none", discoveryRouteKey: "route:none", engineeringRouteKey: "route:none", synthesisRouteKey: "route:none", routes: [],
    })).toThrow();
    expect(() => createProductPlanningConfiguration({
      instanceId: "planning:dupe",
      discoveryRouteKey: "route:discovery", engineeringRouteKey: "route:engineering", synthesisRouteKey: "route:synthesis",
      routes: [
        ...valid.routes.map(({ independenceKey: _key, ...route }) => route),
        (({ independenceKey: _key, ...route }) => route)(valid.routes[0]!),
      ],
    })).toThrow();
    expect(() => createProductPlanningConfiguration({
      instanceId: "planning:unknown", discoveryRouteKey: "route:ghost", engineeringRouteKey: "route:engineering", synthesisRouteKey: "route:synthesis",
      routes: valid.routes.map(({ independenceKey: _key, ...route }) => route),
    })).toThrow();
    expect(() => parseProductPlanningConfiguration({ ...valid, instanceId: "planning:changed" })).toThrow();
    expect(() => parseTrustedPlanningRoute({ ...valid.routes[0], independenceKey: "f".repeat(64) })).toThrow();
    expect(() => createProductPlanningConfiguration({
      instanceId: "planning:limits", discoveryRouteKey: "route:discovery", engineeringRouteKey: "route:engineering", synthesisRouteKey: "route:synthesis",
      routes: valid.routes.map(({ independenceKey: _key, ...route }) => route),
      limits: { maximumPhases: 3, maximumSpecialists: 2 },
    })).toThrow();
  });

  it("rejects malformed intent and model-claimed authority or identity fields", () => {
    const value = intent();
    expect(() => ProductPlan.create({ ...value, workspace: { ...value.workspace, projectId: "project:other" } }, configuration())).toThrow();
    expect(() => ProductPlan.create({ ...value, desiredOutcomes: ["Same", "same"] }, configuration())).toThrow();
    expect(() => ProductPlan.create({ ...value, deadline: value.createdAt }, configuration())).toThrow();
    const parsed = ProductPlan.create(value, configuration()).toSnapshot().intent;
    expect(() => parseProductIntent({ ...parsed, intentDigest: "0".repeat(64) })).toThrow();
    expect(() => parsePlanningContributionDraft({ ...draft(), authority: "operator" })).toThrow();
    expect(() => parsePlanningContributionDraft({ ...draft(), contributionId: "fabricated" })).toThrow();
    expect(() => parsePlanningContributionDraft({ ...draft([candidate("same", "One"), candidate("same", "Two")]) })).toThrow();
  });
});

describe("planning contribution and bound adversaries", () => {
  it("rejects cross-phase evidence, excessive retries, oversized output, and unknown phase", () => {
    const clock = new ManualPlanningClock();
    const config = configuration({ specialists: 0, limits: { maximumContributionBytes: 1_000 } });
    const plan = ProductPlan.create(intent({ risk: "routine" }), config, { clock });
    const phase = plan.toSnapshot().phases[0]!;
    errorOf(() => plan.stageContribution({ ...evidence(plan, phase.phaseId, clock), inputDigest: "f".repeat(64) }, draft()), "CONFLICT");
    errorOf(() => plan.stageContribution({ ...evidence(plan, phase.phaseId, clock), attempt: 6 }, draft()), "LIMIT_EXCEEDED");
    errorOf(() => plan.stageContribution(evidence(plan, phase.phaseId, clock), draft([
      candidate("large", "Large candidate", { description: "x".repeat(2_000) }),
    ])), "LIMIT_EXCEEDED");
    errorOf(() => plan.stageContribution({ ...evidence(plan, phase.phaseId, clock), phaseId: "phase:ghost" }, draft()), "NOT_FOUND");
  });

  it("permits exactly one staged result identity per phase", () => {
    const { plan, clock } = createPlan({ config: configuration({ specialists: 0 }), intent: intent({ risk: "routine" }) });
    const phase = plan.toSnapshot().phases[0]!;
    const first = plan.stageContribution(evidence(plan, phase.phaseId, clock, "first"), draft([candidate("one", "One")]));
    const version = plan.version;
    errorOf(() => plan.stageContribution(evidence(plan, phase.phaseId, clock, "second"), draft([candidate("two", "Two")])), "CONFLICT");
    expect(plan.version).toBe(version);
    expect(plan.toSnapshot().stagedContributions).toEqual([first]);
    expect(plan.toSnapshot().phases[0]?.resultId).toBe(first.resultId);
  });

  it("enforces candidate, call, token, cost, and completion-window budgets", () => {
    const scenarios = [
      {
        config: configuration({ specialists: 0, limits: { maximumCandidateRequirements: 1 } }),
        draft: draft([candidate("one", "One")], { unresolvedQuestions: [{ question: "Two?", material: false }] }),
        evidence: {},
      },
      {
        config: configuration({ specialists: 0, limits: { maximumTotalTokens: 100 } }),
        intent: intent({ risk: "routine", budget: { maximumInputTokens: 50, maximumOutputTokens: 50 } }),
        draft: draft([candidate("one", "One")]),
        evidence: {},
      },
      {
        config: configuration({ specialists: 0, limits: { maximumMoneyMicros: 500 } }),
        intent: intent({ risk: "routine", budget: { maximumCostMicros: 500 } }),
        draft: draft([candidate("one", "One")]),
        evidence: {},
      },
    ];
    for (const scenario of scenarios) {
      const clock = new ManualPlanningClock();
      const plan = ProductPlan.create(scenario.intent ?? intent({ risk: "routine", budget: { maximumInputTokens: 1_000, maximumOutputTokens: 1_000, maximumCostMicros: 1_000 } }), scenario.config, { clock });
      const phase = plan.toSnapshot().phases[0]!;
      errorOf(() => plan.stageContribution(evidence(plan, phase.phaseId, clock), scenario.draft), "LIMIT_EXCEEDED");
    }
    const callConfig = configuration({ specialists: 0, limits: { maximumProviderCalls: 1, maximumContributions: 1 } });
    errorOf(() => ProductPlan.create(intent({
      risk: "routine",
      budget: { maximumProviderCalls: 1 },
    }), callConfig, { clock: new ManualPlanningClock() }), "LIMIT_EXCEEDED");

    const synthesisClock = new ManualPlanningClock();
    const synthesisConfig = configuration({ specialists: 0, limits: { maximumSynthesisRounds: 2, maximumRetriesPerPhase: 4 } });
    const synthesisPlan = ProductPlan.create(intent({ risk: "routine" }), synthesisConfig, { clock: synthesisClock });
    applyPhase(synthesisPlan, "product-discovery", draft(), synthesisClock);
    applyPhase(synthesisPlan, "engineering-feasibility", draft(), synthesisClock);
    const synthesisPhase = synthesisPlan.toSnapshot().phases.find((phase) => phase.kind === "plan-synthesis")!;
    errorOf(() => synthesisPlan.stageContribution(evidence(synthesisPlan, synthesisPhase.phaseId, synthesisClock, "round-3", { attempt: 3 }), draft()), "LIMIT_EXCEEDED");

    const { plan, clock } = createPlan({ config: configuration({ specialists: 0 }), intent: intent({ risk: "routine" }) });
    const phase = plan.toSnapshot().phases[0]!;
    errorOf(() => plan.stageContribution({ ...evidence(plan, phase.phaseId, clock), completedAt: "2026-08-11T00:00:00.000Z" }, draft()), "CONFLICT");
  });

  it("refuses later contributions after phase completion or specification approval", () => {
    const { plan, clock } = createPlan({ config: configuration({ specialists: 0 }), intent: intent({ risk: "routine" }) });
    applyPhase(plan, "product-discovery", draft([candidate("core", "Core")]), clock);
    const completed = plan.toSnapshot().phases[0]!;
    errorOf(() => plan.stageContribution(evidence(plan, completed.phaseId, clock, "late"), draft()), "INVALID_TRANSITION");
    applyPhase(plan, "engineering-feasibility", draft(), clock);
    applyPhase(plan, "plan-synthesis", draft(), clock);
    decide(plan, clock, 0, "required");
    approval(plan, clock);
    const synthesis = plan.toSnapshot().phases.at(-1)!;
    errorOf(() => plan.stageContribution(evidence(plan, synthesis.phaseId, clock, "post-spec"), draft()), "INVALID_TRANSITION");
    errorOf(() => decide(plan, clock, 0, "deferred"), "INVALID_TRANSITION");
  });
});

describe("scope, synthesis, graph, and hydration guards", () => {
  it("uses locale-independent Unicode ordering for canonical requirements and replay", () => {
    const config = configuration({ specialists: 0 });
    const { plan, clock } = createPlan({ config, intent: intent({ risk: "routine" }) });
    applyPhase(plan, "product-discovery", draft([candidate("lower", "ångström mode")]), clock);
    applyPhase(plan, "engineering-feasibility", draft([candidate("upper", "Ångström mode")]), clock);
    applyPhase(plan, "plan-synthesis", draft(), clock);
    expect(plan.toSnapshot().requirements).toHaveLength(1);
    expect(plan.toSnapshot().requirements[0]?.title).toBe("Ångström mode");
    expect(replayPlanningEvents(plan.peekChanges().planningEvents, config)).toEqual(plan.toSnapshot());
  });

  it("handles superseding and idempotent decisions while enforcing waiver authority", () => {
    const { plan, clock } = createPlan({ config: configuration({ specialists: 0 }), intent: intent({ risk: "routine" }) });
    applyPhase(plan, "product-discovery", draft([candidate("core", "Core")]), clock);
    const first = decide(plan, clock, 0, "required");
    const version = plan.version;
    const duplicate = plan.decideScope({
      requirementId: first.requirementId, requirementDigest: first.requirementDigest, expectedPlanVersion: version - 1,
      disposition: first.disposition, actor: first.actor, reason: first.reason, approvalReference: first.approvalReference, decidedAt: first.decidedAt,
    });
    expect(duplicate).toEqual(first);
    expect(plan.version).toBe(version);
    const second = decide(plan, clock, 0, "deferred");
    expect(second.supersedesDecisionId).toBe(first.decisionId);
    errorOf(() => decide(plan, clock, 0, "waived", { authority: "product-owner", approval: "approval:waive" }), "POLICY_DENIED");
    expect(decide(plan, clock, 0, "waived", { authority: "security-reviewer", approval: "approval:waive" }).disposition).toBe("waived");
    errorOf(() => decide(plan, clock, 0, "rejected", { authority: "deterministic-rule" }), "POLICY_DENIED");
    expect(decide(plan, clock, 0, "duplicate", { authority: "deterministic-rule" }).disposition).toBe("duplicate");
  });

  it("rejects stale, unauthorized, empty, blocked, and incomplete specification approval", () => {
    const empty = createPlan({ config: configuration({ specialists: 0 }), intent: intent({ risk: "routine" }) });
    applyPhase(empty.plan, "product-discovery", draft(), empty.clock);
    applyPhase(empty.plan, "engineering-feasibility", draft(), empty.clock);
    applyPhase(empty.plan, "plan-synthesis", draft(), empty.clock);
    errorOf(() => approval(empty.plan, empty.clock), "INVALID_TRANSITION");

    const blocked = createPlan({ config: configuration({ specialists: 0 }), intent: intent({ risk: "routine" }) });
    applyPhase(blocked.plan, "product-discovery", draft([candidate("core", "Core")]), blocked.clock);
    applyPhase(blocked.plan, "engineering-feasibility", draft(), blocked.clock);
    applyPhase(blocked.plan, "plan-synthesis", draft(), blocked.clock);
    decide(blocked.plan, blocked.clock, 0, "blocked");
    errorOf(() => approval(blocked.plan, blocked.clock), "INVALID_TRANSITION");
    errorOf(() => approval(blocked.plan, blocked.clock, { decisionSetDigest: "f".repeat(64) }), "CONFLICT");
    errorOf(() => approval(blocked.plan, blocked.clock, { actor: { actorId: "actor:security", authority: "security-reviewer" } }), "POLICY_DENIED");
    errorOf(() => approval(blocked.plan, blocked.clock, { approvedAt: "2026-08-11T00:00:00.000Z" }), "INVALID_INPUT");

    const incomplete = createPlan({ config: configuration({ specialists: 0 }), intent: intent({ risk: "routine" }) });
    applyPhase(incomplete.plan, "product-discovery", draft([candidate("core", "Core")]), incomplete.clock);
    decide(incomplete.plan, incomplete.clock, 0, "required");
    errorOf(() => approval(incomplete.plan, incomplete.clock), "INVALID_TRANSITION");
  });

  it("approves fully explicit non-executable scope without adding duplicate work", () => {
    const { plan, clock } = createPlan({ config: configuration({ specialists: 0 }), intent: intent({ risk: "routine" }) });
    completePhases(plan, clock);
    for (let index = 0; index < plan.toSnapshot().requirements.length; index += 1) decide(plan, clock, index, "deferred");
    approval(plan, clock);
    const snapshot = plan.toSnapshot();
    expect(snapshot.coverage.every((item) => !item.executable && item.taskId === null)).toBe(true);
    expect(snapshot.taskGraph.tasks).toHaveLength(snapshot.phases.length);
    expect(approval(plan, clock)).toEqual(snapshot.specification);
    errorOf(() => approval(plan, clock, { approvalReference: "approval:different" }), "CONFLICT");
    plan.cancel("ignored-after-approval", plan.version);
    expect(plan.toSnapshot()).toEqual(snapshot);
  });

  it("fails closed on missing dependencies, fan-out, depth, and graph-node bounds", () => {
    const cases = [
      {
        config: configuration({ specialists: 0 }),
        candidates: [candidate("a", "A", { dependsOn: ["Ghost"] })],
      },
      {
        config: configuration({ specialists: 0, limits: { maximumDependencyFanOut: 1 } }),
        candidates: [candidate("a", "A"), candidate("b", "B"), candidate("c", "C", { dependsOn: ["A", "B"] })],
      },
      {
        config: configuration({ specialists: 0, limits: { maximumGraphDepth: 4 } }),
        candidates: [candidate("a", "A"), candidate("b", "B", { dependsOn: ["A"] })],
      },
      {
        config: configuration({ specialists: 0, limits: { maximumGraphNodes: 4 } }),
        candidates: [candidate("a", "A"), candidate("b", "B")],
      },
    ];
    for (const item of cases) {
      const clock = new ManualPlanningClock();
      const plan = ProductPlan.create(intent({ risk: "routine" }), item.config, { clock });
      applyPhase(plan, "product-discovery", draft(item.candidates), clock);
      applyPhase(plan, "engineering-feasibility", draft(), clock);
      applyPhase(plan, "plan-synthesis", draft(), clock);
      decideAll(plan, clock);
      expect(() => approval(plan, clock)).toThrow(PlanningError);
    }
    errorOf(() => ProductPlan.create(intent({ risk: "routine" }), configuration({ specialists: 0, limits: { maximumGraphNodes: 2 } })), "LIMIT_EXCEEDED");
    errorOf(() => ProductPlan.create(intent({ risk: "routine" }), configuration({ specialists: 0, limits: { maximumGraphDepth: 2 } })), "LIMIT_EXCEEDED");
    errorOf(() => ProductPlan.create(intent({ risk: "routine" }), configuration({ specialists: 2, limits: { maximumDependencyFanOut: 1 } })), "LIMIT_EXCEEDED");
  });

  it("rejects malformed staged, applied, phase, decision, specification, and graph snapshots", () => {
    const { plan, clock, config } = createPlan({ config: configuration({ specialists: 0 }), intent: intent({ risk: "routine" }) });
    applyPhase(plan, "product-discovery", draft([candidate("core", "Core")]), clock);
    let tampered = JSON.parse(JSON.stringify(plan.toSnapshot()));
    tampered.phases[0].taskId = "planning-task:wrong";
    errorOf(() => ProductPlan.hydrate(tampered, config), "PERSISTENCE_MISMATCH");
    tampered = JSON.parse(JSON.stringify(plan.toSnapshot()));
    tampered.stagedContributions[0].authority = "operator";
    errorOf(() => ProductPlan.hydrate(tampered, config), "PERSISTENCE_MISMATCH");
    tampered = JSON.parse(JSON.stringify(plan.toSnapshot()));
    tampered.contributions[0].applied = false;
    errorOf(() => ProductPlan.hydrate(tampered, config), "PERSISTENCE_MISMATCH");
    decide(plan, clock, 0, "required");
    tampered = JSON.parse(JSON.stringify(plan.toSnapshot()));
    tampered.decisions[0].decisionDigest = "f".repeat(64);
    errorOf(() => ProductPlan.hydrate(tampered, config), "PERSISTENCE_MISMATCH");
    applyPhase(plan, "engineering-feasibility", draft(), clock);
    applyPhase(plan, "plan-synthesis", draft(), clock);
    approval(plan, clock);
    tampered = JSON.parse(JSON.stringify(plan.toSnapshot()));
    tampered.specification.approvalDigest = "f".repeat(64);
    errorOf(() => ProductPlan.hydrate(tampered, config), "PERSISTENCE_MISMATCH");
    tampered = JSON.parse(JSON.stringify(plan.toSnapshot()));
    tampered.taskGraph.graphId = "planning-graph:wrong";
    errorOf(() => ProductPlan.hydrate(tampered, config), "PERSISTENCE_MISMATCH");
    tampered = JSON.parse(JSON.stringify(plan.toSnapshot()));
    tampered.coverage[0].taskId = "requirement-task:wrong";
    errorOf(() => ProductPlan.hydrate(tampered, config), "PERSISTENCE_MISMATCH");
    tampered = JSON.parse(JSON.stringify(plan.toSnapshot()));
    tampered.reservationIntent.extra = true;
    errorOf(() => ProductPlan.hydrate(tampered, config), "PERSISTENCE_MISMATCH");
    tampered = JSON.parse(JSON.stringify(plan.toSnapshot()));
    const candidateContribution = tampered.stagedContributions.find((item: { candidates: unknown[] }) => item.candidates.length > 0);
    candidateContribution.candidates[0].extra = true;
    candidateContribution.contributionDigest = "f".repeat(64);
    errorOf(() => ProductPlan.hydrate(tampered, config), "PERSISTENCE_MISMATCH");
    expect(productPlanSnapshotDigest(plan.toSnapshot())).toMatch(/^[a-f0-9]{64}$/);
  });

  it("revalidates admission, cumulative usage, phase linkage, and exact graph completeness on hydration", () => {
    const config = configuration({ specialists: 0 });
    const { plan, clock } = createPlan({ config, intent: intent({ risk: "routine" }) });
    const initial = JSON.parse(JSON.stringify(plan.toSnapshot()));

    const underfunded = configuration({ specialists: 0, limits: { maximumProviderCalls: 2 } });
    initial.configurationFingerprint = underfunded.configurationFingerprint;
    errorOf(() => ProductPlan.hydrate(initial, underfunded), "PERSISTENCE_MISMATCH");

    let tampered = JSON.parse(JSON.stringify(plan.toSnapshot()));
    tampered.phases[0].status = "running";
    errorOf(() => ProductPlan.hydrate(tampered, config), "PERSISTENCE_MISMATCH");

    tampered = JSON.parse(JSON.stringify(plan.toSnapshot()));
    const firstTask = tampered.taskGraph.tasks[0];
    tampered.taskGraph.tasks.push({
      ...firstTask,
      id: "planning-task:extra",
      title: "Extraneous persisted work",
      dependencies: [],
      metadata: {},
      status: "ready",
      blockedBy: [],
      outputArtifactIds: [],
      failure: null,
      order: tampered.taskGraph.tasks.length,
    });
    errorOf(() => ProductPlan.hydrate(tampered, config), "PERSISTENCE_MISMATCH");

    applyPhase(plan, "product-discovery", draft([candidate("core", "Core capability")]), clock);
    tampered = JSON.parse(JSON.stringify(plan.toSnapshot()));
    tampered.phases.find((phase: { kind: string }) => phase.kind === "product-discovery").attempt += 1;
    errorOf(() => ProductPlan.hydrate(tampered, config), "PERSISTENCE_MISMATCH");

    const outputBound = configuration({ specialists: 0, limits: { maximumTotalOutputBytes: 1 } });
    tampered = JSON.parse(JSON.stringify(plan.toSnapshot()));
    tampered.configurationFingerprint = outputBound.configurationFingerprint;
    errorOf(() => ProductPlan.hydrate(tampered, outputBound), "PERSISTENCE_MISMATCH");

    tampered = JSON.parse(JSON.stringify(plan.toSnapshot()));
    const discovery = tampered.phases.find((phase: { kind: string }) => phase.kind === "product-discovery");
    discovery.status = "cancelled";
    const discoveryTask = tampered.taskGraph.tasks.find((task: { id: string }) => task.id === discovery.taskId);
    discoveryTask.status = "cancelled";
    discoveryTask.failure = null;
    discoveryTask.outputArtifactIds = [];
    errorOf(() => ProductPlan.hydrate(tampered, config), "PERSISTENCE_MISMATCH");

    applyPhase(plan, "engineering-feasibility", draft(), clock);
    applyPhase(plan, "plan-synthesis", draft(), clock);
    tampered = JSON.parse(JSON.stringify(plan.toSnapshot()));
    const synthesis = tampered.phases.find((phase: { kind: string }) => phase.kind === "plan-synthesis");
    synthesis.status = "completed";
    const synthesisTask = tampered.taskGraph.tasks.find((task: { id: string }) => task.id === synthesis.taskId);
    synthesisTask.status = "succeeded";
    errorOf(() => ProductPlan.hydrate(tampered, config), "PERSISTENCE_MISMATCH");
  });

  it("rejects an internally hydratable journal checkpoint that rewrites an unrelated projection", () => {
    const config = configuration({ specialists: 0 });
    const { plan, clock } = createPlan({ config, intent: intent({ risk: "routine" }) });
    applyPhase(plan, "product-discovery", draft([candidate("core", "Core capability")]), clock);
    const events = JSON.parse(JSON.stringify(plan.peekChanges().planningEvents));
    const stagedIndex = events.findIndex((event: { type: string }) => event.type === "contribution.staged");
    const staged = events[stagedIndex];
    const unrelated = staged.snapshot.phases.find((phase: { kind: string }) => phase.kind === "engineering-feasibility");
    unrelated.status = "cancelled";
    const unrelatedTask = staged.snapshot.taskGraph.tasks.find((task: { id: string }) => task.id === unrelated.taskId);
    unrelatedTask.status = "cancelled";
    staged.afterDigest = planningDigest(staged.snapshot);
    staged.eventId = stablePlanningId("planning-event", staged.planId, String(staged.sequence), staged.afterDigest);
    errorOf(() => replayPlanningEvents(events.slice(0, stagedIndex + 1), config), "PERSISTENCE_MISMATCH");
  });

  it("cancels safely and rejects malformed reason, stale version, invalid clocks, and empty replay", () => {
    const config = configuration({ specialists: 0 });
    const { plan, clock } = createPlan({ config, intent: intent({ risk: "routine" }) });
    errorOf(() => plan.cancel("", plan.version), "INVALID_INPUT");
    errorOf(() => plan.cancel("valid", plan.version - 1), "CONCURRENCY_CONFLICT");
    plan.cancel(" operator cancelled ", plan.version);
    expect(plan.toSnapshot().phases.every((phase) => phase.status === "cancelled")).toBe(true);
    expect(replayPlanningEvents(plan.peekChanges().planningEvents, config)).toEqual(plan.toSnapshot());
    const cancelledVersion = plan.version;
    plan.cancel("duplicate cancellation", cancelledVersion - 1);
    expect(plan.version).toBe(cancelledVersion);
    expect(() => ProductPlan.create(intent({ risk: "routine" }), configuration({ specialists: 0 }), {
      clock: { now: () => new Date("invalid") },
    })).toThrow();
    clock.set("2026-08-09T10:00:00.000Z");
    const active = createPlan({ config: configuration({ specialists: 0 }), intent: intent({ risk: "routine" }) });
    active.clock.set("2026-08-09T10:00:00.000Z");
    errorOf(() => active.plan.cancel("clock moved", active.plan.version), "INVALID_INPUT");
    errorOf(() => replayPlanningEvents([], configuration({ specialists: 0 })), "PERSISTENCE_MISMATCH");
  });

  it("treats cancellation of an already failed plan as write-free", () => {
    const config = configuration({ specialists: 0 });
    const { plan, clock } = createPlan({ config, intent: intent({ risk: "routine" }) });
    const phase = plan.toSnapshot().phases[0]!;
    plan.failPhase(phase.phaseId, "provider-failed", plan.version);
    const failed = plan.toSnapshot();
    const failedVersion = plan.version;
    plan.cancel("late cancellation", failedVersion - 1);
    expect(plan.version).toBe(failedVersion);
    expect(plan.toSnapshot()).toEqual(failed);
    expect(ProductPlan.hydrate(failed, config, { clock }).toSnapshot()).toEqual(failed);
    expect(replayPlanningEvents(plan.peekChanges().planningEvents, config)).toEqual(failed);
  });
});
