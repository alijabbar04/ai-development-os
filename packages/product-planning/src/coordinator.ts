import { toCanonicalJson } from "@ai-dev-os/domain";
import type { OrchestrationRunState, OrchestrationTaskEnvelope } from "@ai-dev-os/scheduler";
import { PlanningError } from "./errors.js";
import {
  FINDING_KINDS,
  PRODUCT_PLANNING_PRODUCTION_ENABLED,
  SCOPE_DISPOSITIONS,
  SEVERITIES,
  type PlanningCoordinatorTestingOptions,
  type ProductPlanAcceptanceInput,
  type ProductPlanSnapshot,
  type ProductPlanningConfiguration,
  type ProductPlanningCoordinator,
} from "./contracts.js";
import { phaseBudgetAllocation } from "./schema.js";

function contributionResultSchema(configuration: ProductPlanningConfiguration) {
  const text = (maximum: number) => ({ type: "string", minLength: 1, maxLength: maximum });
  return Object.freeze({
    type: "object",
    required: ["candidates", "findings", "unresolvedQuestions", "dissent"],
    properties: {
      candidates: {
        type: "array",
        maxItems: configuration.limits.maximumCandidateRequirements,
        items: {
          type: "object",
          required: ["localKey", "title", "description", "rationale", "category", "proposedDisposition", "dependsOn"],
          properties: {
            localKey: { type: "string", minLength: 1, maxLength: 128 },
            title: text(500),
            description: text(8_000),
            rationale: text(4_000),
            category: { type: "string", enum: ["capability", "quality", "risk", "constraint"] },
            proposedDisposition: { type: "string", enum: [...SCOPE_DISPOSITIONS] },
            dependsOn: { type: "array", maxItems: 64, items: text(512) },
          },
          additionalProperties: false,
        },
      },
      findings: {
        type: "array", maxItems: 256, items: {
          type: "object", required: ["kind", "summary", "severity"],
          properties: { kind: { type: "string", enum: [...FINDING_KINDS] }, summary: text(4_000), severity: { type: "string", enum: [...SEVERITIES] } },
          additionalProperties: false,
        },
      },
      unresolvedQuestions: {
        type: "array", maxItems: 256, items: {
          type: "object", required: ["question", "material"],
          properties: { question: text(2_000), material: { type: "boolean" } },
          additionalProperties: false,
        },
      },
      dissent: {
        type: "array", maxItems: 256, items: {
          type: "object", required: ["subject", "position", "rationale", "severity"],
          properties: { subject: text(500), position: text(2_000), rationale: text(4_000), severity: { type: "string", enum: [...SEVERITIES] } },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  });
}

function unavailable(): never {
  throw new PlanningError(
    "PRODUCTION_DISABLED",
    "The Stage 18B product-planning coordinator is production-disabled.",
    { ruleId: "product-planning.stage18b.production-disabled" },
  );
}

export function createProductionDisabledProductPlanningCoordinator(_options: {
  readonly configuration: ProductPlanningConfiguration;
}): ProductPlanningCoordinator {
  let closed = false;
  return Object.freeze({
    productionEnabled: PRODUCT_PLANNING_PRODUCTION_ENABLED,
    async health() {
      return Object.freeze({
        status: closed ? "closed" as const : "unavailable" as const,
        detailCode: closed ? "coordinator-closed" : "stage-18b-production-disabled",
      });
    },
    async accept(): Promise<ProductPlanSnapshot> { return unavailable(); },
    async submitReadyPhases(): Promise<readonly OrchestrationRunState[]> { return unavailable(); },
    async reconcilePhase(): Promise<ProductPlanSnapshot> { return unavailable(); },
    async close(): Promise<void> { closed = true; },
  });
}

function phaseEnvelope(
  snapshot: ProductPlanSnapshot,
  phaseId: string,
  configuration: ProductPlanningConfiguration,
): OrchestrationTaskEnvelope {
  const phase = snapshot.phases.find((item) => item.phaseId === phaseId);
  if (phase === undefined) throw new PlanningError("NOT_FOUND", "Planning phase does not exist.");
  const phaseCount = snapshot.phases.length;
  const phaseIndex = snapshot.phases.findIndex((item) => item.phaseId === phaseId);
  const allocation = phaseBudgetAllocation(snapshot.intent, configuration, phaseIndex, phaseCount, phase.kind === "plan-synthesis");
  const durationMs = Math.max(1, Date.parse(snapshot.intent.deadline) - Date.parse(snapshot.intent.createdAt));
  return Object.freeze({
    schemaVersion: 1,
    taskId: phase.taskId,
    parentTaskId: null,
    correlationId: snapshot.planId,
    idempotencyKey: phase.idempotencyKey,
    objective: `Produce the bounded ${phase.kind} contribution for product intent ${snapshot.intent.intentDigest}.`,
    workspace: snapshot.intent.workspace,
    requestedRoute: {
      providerId: phase.route.providerId,
      modelId: phase.route.modelId,
      profileId: phase.route.profileId,
      ownership: phase.route.ownership,
    },
    capabilities: Object.freeze(["structured-output"] as const),
    permissionMode: "contained-default",
    budget: {
      maximumInputTokens: allocation.maximumInputTokens,
      maximumOutputTokens: allocation.maximumOutputTokens,
      maximumCostMicros: allocation.maximumCostMicros,
      maximumToolCalls: 0,
      maximumTurns: allocation.maximumAttempts,
    },
    retry: {
      maximumAttempts: allocation.maximumAttempts,
      initialBackoffMs: 100,
      maximumBackoffMs: 1_000,
      retryableFailures: Object.freeze(["capacity", "disconnected", "provider"] as const),
    },
    timeout: {
      dispatchMs: Math.min(60_000, durationMs),
      attemptMs: durationMs,
    },
    expectedResultSchema: contributionResultSchema(configuration),
    priority: snapshot.intent.risk === "high" ? "high" : "normal",
    createdAt: snapshot.intent.createdAt,
    deadline: snapshot.intent.deadline,
  });
}

export function createProductPlanningCoordinatorForTesting(
  options: PlanningCoordinatorTestingOptions,
): ProductPlanningCoordinator {
  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw new PlanningError("INVALID_TRANSITION", "Product-planning coordinator is closed.");
  };
  return Object.freeze({
    productionEnabled: PRODUCT_PLANNING_PRODUCTION_ENABLED,
    async health() {
      return Object.freeze({
        status: closed ? "closed" as const : "healthy" as const,
        detailCode: closed ? "coordinator-closed" : "deterministic-fake",
      });
    },
    async accept(input: ProductPlanAcceptanceInput): Promise<ProductPlanSnapshot> {
      assertOpen();
      return options.store.accept(input);
    },
    async submitReadyPhases(planId: string): Promise<readonly OrchestrationRunState[]> {
      assertOpen();
      const snapshot = await options.store.get(planId);
      if (snapshot === null) throw new PlanningError("NOT_FOUND", "Product plan does not exist.", { planId });
      const readyTaskIds = new Set(snapshot.taskGraph.tasks.filter((task) => task.status === "ready").map((task) => task.id));
      const results: OrchestrationRunState[] = [];
      for (const phase of snapshot.phases) {
        if (!readyTaskIds.has(phase.taskId) || (phase.status !== "queued" && phase.status !== "running")) continue;
        const submitted = await options.scheduler.submit(phaseEnvelope(snapshot, phase.phaseId, options.configuration));
        results.push(submitted.state);
      }
      return Object.freeze(results);
    },
    async reconcilePhase(planId: string, phaseId: string): Promise<ProductPlanSnapshot> {
      assertOpen();
      const snapshot = await options.store.get(planId);
      if (snapshot === null) throw new PlanningError("NOT_FOUND", "Product plan does not exist.", { planId });
      const phase = snapshot.phases.find((item) => item.phaseId === phaseId);
      if (phase === undefined) throw new PlanningError("NOT_FOUND", "Planning phase does not exist.", { phaseId });
      const run = await options.scheduler.get(phase.idempotencyKey);
      if (run === null || !["completed", "failed", "cancelled", "policy-blocked"].includes(run.status)) return snapshot;
      if (run.status !== "completed" || run.result?.outcome !== "completed") {
        if (run.status === "cancelled") {
          return options.store.cancel(planId, "scheduler-cancelled", snapshot.aggregateVersion);
        }
        const failureCode = run.result?.failure?.code ?? `scheduler-${run.status}`;
        return options.store.failPhase(planId, phaseId, failureCode, snapshot.aggregateVersion);
      }
      if (phase.contributionId !== null && snapshot.contributions.some((item) => item.contributionId === phase.contributionId)) {
        return snapshot;
      }
      const stagedForPhase = snapshot.stagedContributions.filter((item) => item.phaseId === phaseId && !item.applied);
      const staged = stagedForPhase[0];
      if (staged === undefined || stagedForPhase.length !== 1 || phase.resultId !== staged.resultId) {
        throw new PlanningError("PERSISTENCE_MISMATCH", "Scheduler completed without one exact current durable staged contribution.");
      }
      const provider = run.result.provider;
      const evidence = run.result.evidence.length === 1 ? run.result.evidence[0] : undefined;
      const mismatches = [
        provider === null || provider.providerId !== phase.route.providerId || provider.modelId !== phase.route.modelId || provider.profileId !== phase.route.profileId ? "provider" : null,
        evidence?.evidenceId !== staged.resultId || evidence?.kind !== "planning-contribution" || evidence.sha256 !== staged.contributionDigest ? "evidence" : null,
        toCanonicalJson(run.task) !== toCanonicalJson(phaseEnvelope(snapshot, phaseId, options.configuration)) ? "task" : null,
        run.route?.providerId !== phase.route.providerId || run.route?.modelId !== phase.route.modelId || run.route?.profileId !== phase.route.profileId || run.route?.ownership !== phase.route.ownership ? "route" : null,
        run.attempt !== staged.attempt ? "attempt" : null,
        run.result.finishedAt !== staged.completedAt || run.result.startedAt === null ||
          run.result.startedAt < snapshot.intent.createdAt || run.result.startedAt > run.result.finishedAt ? "time" : null,
        toCanonicalJson(run.result.usage) !== toCanonicalJson(staged.usage) ? "usage" : null,
        run.result.artifacts.length !== 0 ? "artifacts" : null,
      ].filter((item): item is string => item !== null);
      if (mismatches.length > 0) {
        throw new PlanningError("PERSISTENCE_MISMATCH", "Scheduler terminal evidence does not match the staged contribution and trusted route.", {
          mismatch: mismatches.join(","),
        });
      }
      return options.store.applyStagedContribution(planId, staged.contributionId, snapshot.aggregateVersion);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await options.scheduler.close();
    },
  });
}
