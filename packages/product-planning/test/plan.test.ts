import { describe, expect, it } from "vitest";
import {
  PlanningError,
  ProductPlan,
  createProductionDisabledProductPlanningCoordinator,
  replayPlanningEvents,
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

function expectPlanningError(work: () => unknown, code: PlanningError["code"]): PlanningError {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(PlanningError);
    expect((error as PlanningError).code).toBe(code);
    return error as PlanningError;
  }
  throw new Error(`Expected ${code}`);
}

function permutations<T>(values: readonly T[]): readonly (readonly T[])[] {
  if (values.length < 2) return [values];
  return values.flatMap((value, index) => permutations(values.filter((_, candidateIndex) => candidateIndex !== index))
    .map((tail) => [value, ...tail]));
}

describe("ProductPlan lifecycle", () => {
  it("accepts normalized intent with a sealed bounded phase graph and reservation intent", () => {
    const { plan, config } = createPlan();
    const snapshot = plan.toSnapshot();
    expect(snapshot.intent.title).toBe("A complete local development product");
    expect(snapshot.intent.intentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.configurationFingerprint).toBe(config.configurationFingerprint);
    expect(snapshot.phases.map((phase) => phase.kind)).toEqual([
      "product-discovery",
      "specialist-gap-analysis",
      "engineering-feasibility",
      "plan-synthesis",
    ]);
    expect(snapshot.taskGraph.sealed).toBe(true);
    expect(snapshot.taskGraph.tasks.filter((task) => task.status === "ready").map((task) => task.id))
      .toEqual([snapshot.phases[0]!.taskId]);
    expect(snapshot.reservationIntent).toMatchObject({ planId: snapshot.planId, status: "intended", preview: snapshot.intent.budget });
    expect(snapshot.reconciliationIntent).toBeNull();
    expect(plan.peekChanges().planningEvents.map((event) => event.type)).toEqual(["plan.accepted"]);
    expect(plan.peekChanges().taskGraphEvents.length).toBeGreaterThan(snapshot.phases.length);
  });

  it("completes every phase, deduplicates without provenance loss, decides scope, and compiles exact task coverage", () => {
    const { plan, clock, config } = createPlan();
    completePhases(plan, clock);
    const beforeDecisions = plan.toSnapshot();
    const core = beforeDecisions.requirements.find((requirement) => requirement.normalizedKey === "core capability")!;
    expect(core.candidateIds).toHaveLength(2);
    expect(core.provenance).toHaveLength(2);
    expect(new Set(core.provenance.map((item) => item.phaseId)).size).toBe(2);
    expect(beforeDecisions.phases.at(-1)?.status).toBe("running");

    decideAll(plan, clock);
    const approvalInput = {
      expectedPlanVersion: plan.version,
      decisionSetDigest: plan.currentDecisionSetDigest(),
      actor: { actorId: "actor:owner", authority: "product-owner" as const },
      approvalReference: "approval:specification",
      approvedAt: clock.now().toISOString(),
    };
    const specification = plan.approveSpecification(approvalInput);
    const snapshot = plan.toSnapshot();
    expect(specification.requirements).toHaveLength(snapshot.requirements.length);
    expect(specification.dissentIds).toEqual([]);
    expect(snapshot.coverage).toHaveLength(snapshot.requirements.length);
    expect(snapshot.coverage.every((item) => item.executable && item.taskId !== null)).toBe(true);
    expect(new Set(snapshot.coverage.map((item) => item.taskId)).size).toBe(snapshot.coverage.length);
    expect(snapshot.phases.every((phase) => phase.status === "completed")).toBe(true);
    expect(snapshot.reconciliationIntent).toMatchObject({ status: "intended", costKnown: true });
    expect(snapshot.taskGraph.tasks).toHaveLength(snapshot.phases.length + snapshot.coverage.length);
    const reliable = snapshot.requirements.find((item) => item.normalizedKey === "reliable execution")!;
    const reliableTask = snapshot.taskGraph.tasks.find((task) => task.id === snapshot.coverage.find((item) => item.requirementId === reliable.requirementId)!.taskId)!;
    expect(reliableTask.dependencies).toContain(snapshot.coverage.find((item) => item.requirementId === core.requirementId)!.taskId);
    expect(plan.approveSpecification({ ...approvalInput, expectedPlanVersion: 1 })).toBe(specification);
    expectPlanningError(() => plan.approveSpecification({
      ...approvalInput,
      expectedPlanVersion: plan.version,
      actor: { actorId: "actor:owner", authority: "operator" },
    }), "CONFLICT");
    expectPlanningError(() => plan.approveSpecification({
      ...approvalInput,
      expectedPlanVersion: plan.version,
      approvedAt: "2026-08-09T12:00:00.001Z",
    }), "CONFLICT");
    expect(replayPlanningEvents(plan.peekChanges().planningEvents, config)).toEqual(snapshot);
  });

  it("preserves unresolved questions and dissent as explicit candidate scope", () => {
    const { plan, clock } = createPlan({ config: configuration({ specialists: 0 }) });
    applyPhase(plan, "product-discovery", draft([candidate("core", "Core capability")], {
      unresolvedQuestions: [{ question: "Which offline guarantee applies?", material: true }],
      dissent: [{ subject: "Telemetry default", position: "Keep telemetry off", rationale: "Privacy remains ambiguous.", severity: "high" }],
    }), clock);
    applyPhase(plan, "engineering-feasibility", draft(), clock);
    applyPhase(plan, "plan-synthesis", draft(), clock);
    const snapshot = plan.toSnapshot();
    expect(snapshot.requirements).toHaveLength(3);
    expect(snapshot.requirements.some((item) => item.category === "unresolved-question")).toBe(true);
    expect(snapshot.requirements.flatMap((item) => item.dissentIds)).toHaveLength(1);
    expectPlanningError(() => plan.approveSpecification({
      expectedPlanVersion: plan.version,
      decisionSetDigest: plan.currentDecisionSetDigest(),
      actor: { actorId: "actor:owner", authority: "product-owner" },
      approvalReference: "approval:premature",
      approvedAt: clock.now().toISOString(),
    }), "INVALID_TRANSITION");
    const question = snapshot.requirements.find((item) => item.category === "unresolved-question")!;
    expectPlanningError(() => plan.decideScope({
      requirementId: question.requirementId,
      requirementDigest: question.requirementDigest,
      expectedPlanVersion: plan.version,
      disposition: "deferred",
      actor: { actorId: "actor:owner", authority: "product-owner" },
      reason: "Resolve later.",
      approvalReference: null,
      decidedAt: clock.now().toISOString(),
    }), "POLICY_DENIED");
  });

  it("stages before terminal application and makes exact duplicate delivery idempotent", () => {
    const { plan, clock } = createPlan({ config: configuration({ specialists: 0 }) });
    const phase = plan.toSnapshot().phases[0]!;
    const proof = evidence(plan, phase.phaseId, clock);
    const first = plan.stageContribution(proof, draft([candidate("core", "Core capability")]));
    const version = plan.version;
    const duplicate = plan.stageContribution(proof, draft([candidate("core", "Core capability")]));
    expect(duplicate).toEqual(first);
    expect(plan.version).toBe(version);
    const applied = plan.applyStagedContribution(first.contributionId, version);
    const after = plan.version;
    expect(plan.applyStagedContribution(first.contributionId, version)).toEqual(applied);
    expect(plan.version).toBe(after);
  });

  it("rejects conflicting duplicate and reordered terminal results without partial mutation", () => {
    const { plan, clock } = createPlan();
    const engineering = plan.toSnapshot().phases.find((phase) => phase.kind === "engineering-feasibility")!;
    const staged = plan.stageContribution(evidence(plan, engineering.phaseId, clock), draft([candidate("early", "Early engineering")]));
    const before = plan.toSnapshot();
    expectPlanningError(() => plan.applyStagedContribution(staged.contributionId, plan.version), "INVALID_TRANSITION");
    expect(plan.toSnapshot()).toEqual(before);
    expectPlanningError(() => plan.stageContribution(
      { ...evidence(plan, engineering.phaseId, clock), resultId: staged.resultId },
      draft([candidate("different", "Different content")]),
    ), "CONFLICT");
  });

  it("binds scope decisions to exact digest, version, authority, and approval", () => {
    const { plan, clock } = createPlan({ config: configuration({ specialists: 0 }) });
    applyPhase(plan, "product-discovery", draft([candidate("core", "Core capability")]), clock);
    const requirement = plan.toSnapshot().requirements[0]!;
    const version = plan.version;
    expectPlanningError(() => plan.decideScope({
      requirementId: requirement.requirementId,
      requirementDigest: "f".repeat(64),
      expectedPlanVersion: version,
      disposition: "required",
      actor: { actorId: "actor:owner", authority: "product-owner" },
      reason: "Stale.", approvalReference: "approval:stale", decidedAt: clock.now().toISOString(),
    }), "CONFLICT");
    expectPlanningError(() => plan.decideScope({
      requirementId: requirement.requirementId,
      requirementDigest: requirement.requirementDigest,
      expectedPlanVersion: version,
      disposition: "required",
      actor: { actorId: "actor:rule", authority: "deterministic-rule" },
      reason: "Model-like rule cannot promote.", approvalReference: "approval:bad", decidedAt: clock.now().toISOString(),
    }), "POLICY_DENIED");
    expectPlanningError(() => plan.decideScope({
      requirementId: requirement.requirementId,
      requirementDigest: requirement.requirementDigest,
      expectedPlanVersion: version,
      disposition: "required",
      actor: { actorId: "actor:owner", authority: "product-owner" },
      reason: "Missing evidence.", approvalReference: null, decidedAt: clock.now().toISOString(),
    }), "POLICY_DENIED");
    plan.decideScope({
      requirementId: requirement.requirementId,
      requirementDigest: requirement.requirementDigest,
      expectedPlanVersion: version,
      disposition: "required",
      actor: { actorId: "actor:owner", authority: "product-owner" },
      reason: "Approved.", approvalReference: "approval:scope", decidedAt: clock.now().toISOString(),
    });
    expectPlanningError(() => plan.decideScope({
      requirementId: requirement.requirementId,
      requirementDigest: requirement.requirementDigest,
      expectedPlanVersion: version,
      disposition: "deferred",
      actor: { actorId: "actor:owner", authority: "product-owner" },
      reason: "Stale version.", approvalReference: null, decidedAt: clock.now().toISOString(),
    }), "CONCURRENCY_CONFLICT");
  });

  it("replays its digest chain and rejects reordered or tampered checkpoints", () => {
    const { plan, clock, config } = createPlan({ config: configuration({ specialists: 0 }) });
    applyPhase(plan, "product-discovery", draft([candidate("core", "Core capability")]), clock);
    const events = plan.peekChanges().planningEvents;
    expect(replayPlanningEvents(events, config)).toEqual(plan.toSnapshot());
    expectPlanningError(() => replayPlanningEvents([...events].reverse(), config), "PERSISTENCE_MISMATCH");
    const tampered = JSON.parse(JSON.stringify(plan.toSnapshot()));
    tampered.requirements[0].title = "Tampered";
    expectPlanningError(() => ProductPlan.hydrate(tampered, config, { clock }), "PERSISTENCE_MISMATCH");
  });

  it("keeps requirement projection and contribution identity stable across all 24 candidate permutations", () => {
    const values = [
      candidate("alpha", "Alpha capability"),
      candidate("beta", "Beta quality", { category: "quality" }),
      candidate("alpha-alias", "Alpha capability", { rationale: "Independent corroboration." }),
      candidate("gamma", "Gamma constraint", { category: "constraint", dependsOn: ["Alpha capability"] }),
    ];
    let baseline: unknown = null;
    for (const ordering of permutations(values)) {
      const { plan, clock } = createPlan({ config: configuration({ specialists: 0 }), intent: intent({ risk: "routine" }) });
      applyPhase(plan, "product-discovery", draft(ordering), clock);
      const snapshot = plan.toSnapshot();
      const projection = {
        contributionDigest: snapshot.contributions[0]!.contributionDigest,
        requirements: snapshot.requirements,
      };
      baseline ??= projection;
      expect(projection).toEqual(baseline);
    }
  });

  it("refuses colliding independence evidence and hard budget/time/configuration limits", () => {
    expectPlanningError(
      () => ProductPlan.create(intent({ risk: "material" }), configuration({ riskRoutesCollide: true }), { clock: new ManualPlanningClock() }),
      "INDEPENDENCE_REQUIRED",
    );
    expectPlanningError(
      () => ProductPlan.create(intent({ budget: { maximumProviderCalls: 17 } }), configuration({ limits: { maximumProviderCalls: 16 } }), { clock: new ManualPlanningClock() }),
      "LIMIT_EXCEEDED",
    );
    expectPlanningError(
      () => ProductPlan.create(intent({ deadline: "2026-08-12T10:00:00.000Z" }), configuration(), { clock: new ManualPlanningClock() }),
      "LIMIT_EXCEEDED",
    );
    expect(() => configuration({ specialists: 13 })).toThrow();
  });

  it("refuses production coordinator operations before any injected effect boundary", async () => {
    const coordinator = createProductionDisabledProductPlanningCoordinator({ configuration: configuration() });
    expect((await coordinator.health()).status).toBe("unavailable");
    await expect(coordinator.accept({ intent: intent() })).rejects.toMatchObject({
      code: "PRODUCTION_DISABLED",
      details: { ruleId: "product-planning.stage18b.production-disabled" },
    });
    await expect(coordinator.submitReadyPhases("plan:test")).rejects.toMatchObject({ code: "PRODUCTION_DISABLED" });
    await expect(coordinator.reconcilePhase("plan:test", "phase:test")).rejects.toMatchObject({ code: "PRODUCTION_DISABLED" });
    await coordinator.close();
    expect((await coordinator.health()).status).toBe("closed");
  });
});
