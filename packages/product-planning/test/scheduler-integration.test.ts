import { createModelCapabilities, type JsonValue } from "@ai-dev-os/domain";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import { createInferenceRequest } from "@ai-dev-os/providers";
import { createFakeInferenceProvider, INTERNAL_DISCLOSURE, TESTKIT_TRACE } from "@ai-dev-os/provider-testkit";
import { assertAnthropicStructuredSchemaForTesting } from "@ai-dev-os/provider-anthropic/testing";
import { createTestingScheduler } from "@ai-dev-os/scheduler/testing";
import type { NormalizedCanonicalUsageSnapshot, RouteCandidate } from "@ai-dev-os/scheduler";
import { describe, expect, it } from "vitest";
import {
  createProductPlanningStore,
  planningDigest,
  type PlanningContributionDraft,
  type ProductPlanSnapshot,
  type ProductPlanningConfiguration,
} from "../src/index.js";
import {
  createInferencePlanningAgentAdapter,
  createProductPlanningCoordinatorForTesting,
} from "../src/testing/index.js";
import {
  BASE_TIME,
  ManualPlanningClock,
  candidate,
  configuration,
  draft,
  intent,
} from "./fixtures.js";

function model(modelId: string) {
  return createModelCapabilities({
    providerId: "fake-inference",
    modelId,
    contextWindowTokens: 100_000,
    maxOutputTokens: 8_000,
    supportsToolUse: false,
    supportsStructuredOutput: true,
    supportsVision: false,
    locality: "cloud",
    latencyClass: "standard",
    codingCapability: 3,
    reasoningCapability: 4,
    cost: null,
  });
}

function contributionFor(modelId: string): PlanningContributionDraft {
  if (modelId === "fake:model") return draft([candidate("core", "Core capability")]);
  if (modelId === "fake:specialist") return draft([candidate("quality", "Accessible interface", { category: "quality" })]);
  if (modelId === "fake:engineering") return draft([candidate("reliable", "Reliable execution", { dependsOn: ["Core capability"] })]);
  return draft([candidate("delight", "Polished onboarding", { proposedDisposition: "delight-candidate", dependsOn: ["Accessible interface"] })]);
}

function routeInputs(snapshot: ProductPlanSnapshot, phaseId: string, clock: ManualPlanningClock): {
  readonly candidate: RouteCandidate;
  readonly usage: NormalizedCanonicalUsageSnapshot;
} {
  const phase = snapshot.phases.find((item) => item.phaseId === phaseId)!;
  return {
    candidate: {
      schemaVersion: 1,
      candidateId: `candidate:${phase.phaseId.slice(-16)}`,
      providerId: phase.route.providerId,
      modelId: phase.route.modelId,
      profileId: phase.route.profileId,
      ownership: phase.route.ownership,
      borrowedPolicy: phase.route.ownership === "authorized-borrowed"
        ? { taskClass: "claude-code", taskAuthorized: true, modelAllowed: true }
        : null,
      authorized: true,
      availability: "available",
      health: "healthy",
      healthObservedAt: clock.now().toISOString(),
      capabilities: ["structured-output"],
      permissionModes: ["contained-default"],
      qualityScore: 900,
      costScore: 500,
      predictedFiveHourBasisPoints: 100,
      predictedWeeklyBasisPoints: 100,
    },
    usage: {
      schemaVersion: 2,
      compatibility: "native-v2",
      snapshotId: `usage:${phase.phaseId.slice(-16)}`,
      sourceAdapterId: "usage-adapter:test",
      sourceAdapterVersion: "version:2",
      sourceFingerprint: "a".repeat(64),
      sourceClass: "provider-authoritative",
      authoritative: true,
      confidence: "high",
      profileId: phase.route.profileId,
      providerId: phase.route.providerId,
      ownership: phase.route.ownership,
      authorization: "authorized",
      revocation: "not-revoked",
      timezone: "Europe/London",
      observedAt: clock.now().toISOString(),
      freshUntil: "2026-08-10T10:15:00.000Z",
      fiveHour: { windowId: "window:five-hour:planning", usedBasisPoints: 100, remainingBasisPoints: 9_900, resetAt: "2026-08-10T13:00:00.000Z" },
      weekly: { windowId: "window:weekly:planning", usedBasisPoints: 200, remainingBasisPoints: 9_800, resetAt: "2026-08-17T00:00:00.000Z" },
    },
  };
}

function buildHarness(config: ProductPlanningConfiguration, clock: ManualPlanningClock, failure: false | "always" | "once" | "nonretryable" = false) {
  const persistence = createMemoryPersistenceAdapter({ clock });
  const store = createProductPlanningStore({ persistence, configuration: config, clock });
  let providerCalls = 0;
  const provider = createFakeInferenceProvider({
    descriptor: { providerId: "fake-inference", instanceId: "fake-planning", supportedClassifications: ["internal"] },
    models: ["fake:model", "fake:specialist", "fake:engineering", "fake:synthesis"].map(model),
    script: (request) => {
      providerCalls += 1;
      const shouldFail = failure === "always" || failure === "once" && providerCalls === 1 || failure === "nonretryable";
      return shouldFail
        ? { steps: [
            { kind: "usage" as const, inputTokens: 100, outputTokens: 50 },
            { kind: "fail" as const, code: failure === "nonretryable" ? "INVALID_REQUEST" as const : "PROVIDER_OVERLOADED" as const },
          ] }
        : { steps: [
          { kind: "structured", value: contributionFor(request.modelId) as unknown as JsonValue },
          { kind: "usage", inputTokens: 100, outputTokens: 50 },
          { kind: "finish" },
        ] };
    },
  });
  const agent = createInferencePlanningAgentAdapter({
    provider,
    clock,
    async resolve(request) {
      const snapshot = await store.get(request.task.correlationId);
      if (snapshot === null) throw new Error("plan missing");
      const phase = snapshot.phases.find((item) => item.taskId === request.task.taskId)!;
      const inferenceRequest = createInferenceRequest({
        requestId: `inference:${phase.phaseId.slice(-16)}`,
        modelId: phase.route.modelId,
        messages: [{ role: "user", parts: [{ type: "text", text: `Return a bounded contribution for ${phase.inputDigest}.` }] }],
        disclosure: INTERNAL_DISCLOSURE,
        trace: TESTKIT_TRACE,
        structuredOutput: { schema: request.task.expectedResultSchema, strict: true },
        maxOutputTokens: request.task.budget.maximumOutputTokens,
        deadline: request.deadline,
      });
      const baseEvidence = {
        phaseId: phase.phaseId,
        attempt: request.attempt,
        inputDigest: phase.inputDigest,
        schedulerTaskId: phase.taskId,
        schedulerIdempotencyKey: phase.idempotencyKey,
        route: phase.route,
        sourceFingerprint: planningDigest(inferenceRequest),
      };
      return {
        inferenceRequest,
        evidence: baseEvidence,
        async stage(resultId: string, completedAt: string, usage: Parameters<NonNullable<typeof store.stageContribution>>[1]["usage"], value: JsonValue) {
          const staged = await store.stageContribution(snapshot.planId, {
            ...baseEvidence,
            resultId,
            completedAt,
            usage,
          }, value);
          const contribution = staged.stagedContributions.find((item) => item.resultId === resultId)!;
          return { contributionId: contribution.contributionId, contributionDigest: contribution.contributionDigest };
        },
      };
    },
  });
  const scheduler = createTestingScheduler({ persistence, adapter: agent, clock });
  const coordinator = createProductPlanningCoordinatorForTesting({ store, scheduler, clock, configuration: config });
  return { persistence, store, provider, scheduler, coordinator };
}

describe("planning scheduler integration", () => {
  it("emits an actual contribution schema accepted by the bounded Anthropic preflight validator", async () => {
    const clock = new ManualPlanningClock();
    const config = configuration({ specialists: 0 });
    const harness = buildHarness(config, clock);
    const snapshot = await harness.coordinator.accept({ intent: intent({ risk: "routine" }) });
    const submitted = await harness.coordinator.submitReadyPhases(snapshot.planId);
    expect(submitted).toHaveLength(1);
    expect(() => assertAnthropicStructuredSchemaForTesting(submitted[0]!.task.expectedResultSchema)).not.toThrow();
    await harness.coordinator.close();
  });

  it("durably stages inference before scheduler terminal, reconciles after coordinator restart, and applies once", async () => {
    const clock = new ManualPlanningClock();
    const config = configuration();
    const harness = buildHarness(config, clock);
    let snapshot = await harness.coordinator.accept({ intent: intent() });

    for (const phase of snapshot.phases) {
      const submitted = await harness.coordinator.submitReadyPhases(snapshot.planId);
      expect(submitted).toHaveLength(1);
      expect(submitted[0]?.task.taskId).toBe(phase.taskId);
      const inputs = routeInputs(snapshot, phase.phaseId, clock);
      const terminal = await harness.scheduler.dispatch(phase.idempotencyKey, {
        workloadClass: "general",
        preference: "balanced",
        candidates: [inputs.candidate],
        usageSnapshots: [inputs.usage],
      });
      expect(terminal.status).toBe("completed");

      const staged = await harness.store.get(snapshot.planId);
      expect(staged?.stagedContributions.some((item) => item.phaseId === phase.phaseId && !item.applied)).toBe(true);
      expect(staged?.contributions.some((item) => item.phaseId === phase.phaseId)).toBe(false);

      // A fresh coordinator instance proves restart reconciliation against the
      // already-durable scheduler terminal and staged contribution.
      const restarted = createProductPlanningCoordinatorForTesting({
        store: harness.store,
        scheduler: harness.scheduler,
        clock,
        configuration: config,
      });
      snapshot = await restarted.reconcilePhase(snapshot.planId, phase.phaseId);
      const version = snapshot.aggregateVersion;
      expect((await restarted.reconcilePhase(snapshot.planId, phase.phaseId)).aggregateVersion).toBe(version);
      expect(snapshot.contributions.filter((item) => item.phaseId === phase.phaseId)).toHaveLength(1);
    }

    expect(snapshot.requirements.map((item) => item.normalizedKey).sort()).toEqual([
      "accessible interface",
      "core capability",
      "polished onboarding",
      "reliable execution",
    ]);
    expect(snapshot.phases.at(-1)?.status).toBe("running");
    expect(harness.provider.capturedRequests).toHaveLength(snapshot.phases.length);
    expect(harness.provider.capturedRequests.every((request) => request.structuredOutput !== null)).toBe(true);
    await harness.coordinator.close();
  });

  it("exhausts bounded retryable provider failures with cumulative usage and persists one failed phase", async () => {
    const clock = new ManualPlanningClock();
    const config = configuration({ specialists: 0 });
    const harness = buildHarness(config, clock, "always");
    const snapshot = await harness.coordinator.accept({ intent: intent({ risk: "routine" }) });
    await harness.coordinator.submitReadyPhases(snapshot.planId);
    const phase = snapshot.phases[0]!;
    const inputs = routeInputs(snapshot, phase.phaseId, clock);
    const dispatchInput = {
      workloadClass: "general",
      preference: "balanced",
      candidates: [inputs.candidate],
      usageSnapshots: [inputs.usage],
    } as const;
    let terminal = await harness.scheduler.dispatch(phase.idempotencyKey, dispatchInput);
    while (terminal.status === "retry-wait") {
      clock.set(terminal.nextAttemptAt!);
      expect((await harness.scheduler.tick())[0]?.status).toBe("queued");
      terminal = await harness.scheduler.dispatch(phase.idempotencyKey, dispatchInput);
    }
    expect(terminal.status).toBe("failed");
    expect(terminal.attempt).toBe(terminal.task.retry.maximumAttempts);
    expect(terminal.result?.usage.inputTokens).toBe(100 * terminal.attempt);
    const failed = await harness.coordinator.reconcilePhase(snapshot.planId, phase.phaseId);
    expect(failed.phases.find((item) => item.phaseId === phase.phaseId)).toMatchObject({ status: "failed", failureCode: "provider-overloaded" });
    expect(failed.phases.filter((item) => item.phaseId !== phase.phaseId).every((item) => item.status === "cancelled")).toBe(true);
    expect(failed.taskGraph.tasks.find((task) => task.id === phase.taskId)?.status).toBe("failed");
    expect(failed.taskGraph.tasks.filter((task) => task.id !== phase.taskId).every((task) => task.status === "blocked")).toBe(true);
    const version = failed.aggregateVersion;
    expect((await harness.coordinator.reconcilePhase(snapshot.planId, phase.phaseId)).aggregateVersion).toBe(version);
    await harness.coordinator.close();
  });

  it("retries once with durable cumulative usage, then stages the exact successful terminal", async () => {
    const clock = new ManualPlanningClock();
    const config = configuration({ specialists: 0 });
    const harness = buildHarness(config, clock, "once");
    const snapshot = await harness.coordinator.accept({ intent: intent({ risk: "routine" }) });
    const phase = snapshot.phases[0]!;
    await harness.coordinator.submitReadyPhases(snapshot.planId);
    const inputs = routeInputs(snapshot, phase.phaseId, clock);
    const dispatchInput = { workloadClass: "general", preference: "balanced", candidates: [inputs.candidate], usageSnapshots: [inputs.usage] } as const;
    const waiting = await harness.scheduler.dispatch(phase.idempotencyKey, dispatchInput);
    expect(waiting.status).toBe("retry-wait");
    clock.set(waiting.nextAttemptAt!);
    await harness.scheduler.tick();
    const terminal = await harness.scheduler.dispatch(phase.idempotencyKey, dispatchInput);
    expect(terminal).toMatchObject({ status: "completed", attempt: 2, usage: { inputTokens: 200, outputTokens: 100 } });
    const applied = await harness.coordinator.reconcilePhase(snapshot.planId, phase.phaseId);
    expect(applied.contributions[0]?.usage).toMatchObject({ inputTokens: 200, outputTokens: 100 });
    expect(harness.provider.capturedRequests).toHaveLength(2);
    await harness.coordinator.close();
  });

  it("does not stage a successful provider result that exceeds the scheduler phase budget", async () => {
    const clock = new ManualPlanningClock();
    const config = configuration({ specialists: 0 });
    const harness = buildHarness(config, clock);
    const snapshot = await harness.coordinator.accept({
      intent: intent({ risk: "routine", budget: { maximumOutputTokens: 30 } }),
    });
    const phase = snapshot.phases[0]!;
    await harness.coordinator.submitReadyPhases(snapshot.planId);
    const inputs = routeInputs(snapshot, phase.phaseId, clock);
    const terminal = await harness.scheduler.dispatch(phase.idempotencyKey, {
      workloadClass: "general", preference: "balanced", candidates: [inputs.candidate], usageSnapshots: [inputs.usage],
    });
    expect(terminal).toMatchObject({
      status: "failed",
      result: { failure: { code: "usage-budget-exceeded", retryable: false } },
    });
    const beforeReconcile = await harness.store.get(snapshot.planId);
    expect(beforeReconcile?.stagedContributions).toEqual([]);
    expect(beforeReconcile?.phases[0]?.resultId).toBeNull();
    const failed = await harness.coordinator.reconcilePhase(snapshot.planId, phase.phaseId);
    expect(failed.phases[0]).toMatchObject({ status: "failed", failureCode: "usage-budget-exceeded", resultId: null });
    expect((await harness.store.get(snapshot.planId))?.aggregateVersion).toBe(failed.aggregateVersion);
    await harness.coordinator.close();
  });

  it("does not retry a nonretryable provider failure", async () => {
    const clock = new ManualPlanningClock();
    const config = configuration({ specialists: 0 });
    const harness = buildHarness(config, clock, "nonretryable");
    const snapshot = await harness.coordinator.accept({ intent: intent({ risk: "routine" }) });
    const phase = snapshot.phases[0]!;
    await harness.coordinator.submitReadyPhases(snapshot.planId);
    const inputs = routeInputs(snapshot, phase.phaseId, clock);
    const terminal = await harness.scheduler.dispatch(phase.idempotencyKey, {
      workloadClass: "general", preference: "balanced", candidates: [inputs.candidate], usageSnapshots: [inputs.usage],
    });
    expect(terminal).toMatchObject({ status: "failed", attempt: 1, result: { failure: { code: "invalid-request", retryable: false } } });
    const failed = await harness.coordinator.reconcilePhase(snapshot.planId, phase.phaseId);
    expect(failed.phases[0]).toMatchObject({ status: "failed", failureCode: "invalid-request" });
    expect(harness.provider.capturedRequests).toHaveLength(1);
    await harness.coordinator.close();
  });
});
