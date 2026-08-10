import type { NormalizedUsage } from "@ai-dev-os/scheduler";
import {
  ProductPlan,
  createProductPlanningConfiguration,
  planningDigest,
  type CandidateRequirementDraft,
  type PlanningContributionDraft,
  type PlanningContributionEvidence,
  type ProductIntentInput,
  type ProductPlanningConfiguration,
} from "../src/index.js";

export const BASE_TIME = "2026-08-10T10:00:00.000Z";
export const DEADLINE = "2026-08-10T20:00:00.000Z";

export class ManualPlanningClock {
  private value: Date;

  constructor(value = BASE_TIME) {
    this.value = new Date(value);
  }

  now(): Date {
    return new Date(this.value.valueOf());
  }

  advance(milliseconds = 1_000): void {
    this.value = new Date(this.value.valueOf() + milliseconds);
  }

  set(value: string): void {
    this.value = new Date(value);
  }
}

export function configuration(options: {
  readonly riskRoutesCollide?: boolean;
  readonly specialists?: number;
  readonly limits?: Parameters<typeof createProductPlanningConfiguration>[0]["limits"];
} = {}): ProductPlanningConfiguration {
  const routes = [
    { routeKey: "route:discovery", providerId: "fake-inference", modelId: "fake:model", profileId: "profile:discovery", ownership: "owned" as const, configurationFingerprint: "1".repeat(64) },
    { routeKey: "route:specialist", providerId: "fake-inference", modelId: "fake:specialist", profileId: "profile:specialist", ownership: "owned" as const, configurationFingerprint: "2".repeat(64) },
    { routeKey: "route:engineering", providerId: "fake-inference", modelId: "fake:engineering", profileId: "profile:engineering", ownership: "owned" as const, configurationFingerprint: "3".repeat(64) },
    options.riskRoutesCollide
      ? { routeKey: "route:synthesis", providerId: "fake-inference", modelId: "fake:model", profileId: "profile:discovery", ownership: "owned" as const, configurationFingerprint: "1".repeat(64) }
      : { routeKey: "route:synthesis", providerId: "fake-inference", modelId: "fake:synthesis", profileId: "profile:synthesis", ownership: "owned" as const, configurationFingerprint: "4".repeat(64) },
  ];
  const specialistCount = options.specialists ?? 1;
  return createProductPlanningConfiguration({
    instanceId: "planning:test",
    discoveryRouteKey: "route:discovery",
    engineeringRouteKey: "route:engineering",
    synthesisRouteKey: "route:synthesis",
    routes,
    specialists: Array.from({ length: specialistCount }, (_, index) => ({
      specialistId: `specialist:${index + 1}`,
      focus: `Specialist focus ${index + 1}`,
      routeKey: "route:specialist",
    })),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
}

export function intent(options: {
  readonly planId?: string;
  readonly risk?: ProductIntentInput["risk"];
  readonly budget?: Partial<ProductIntentInput["budget"]>;
  readonly deadline?: string;
} = {}): ProductIntentInput {
  return {
    planId: options.planId ?? "plan:test",
    projectId: "project:test",
    title: "A complete local development product",
    problem: "Users need a bounded and reviewable product plan.",
    desiredOutcomes: ["Explicit scope", "Traceable coverage"],
    constraints: ["Production disabled"],
    nonGoals: ["No live provider execution"],
    risk: options.risk ?? "material",
    workspace: {
      projectId: "project:test",
      workspaceId: "workspace:test",
      snapshotId: "snapshot:test",
      baseRevision: "0123456789abcdef0123456789abcdef01234567",
    },
    budget: {
      maximumInputTokens: 100_000,
      maximumOutputTokens: 50_000,
      maximumCostMicros: 10_000_000,
      maximumProviderCalls: 16,
      ...options.budget,
    },
    createdAt: BASE_TIME,
    deadline: options.deadline ?? DEADLINE,
  };
}

export const USAGE: NormalizedUsage = Object.freeze({
  inputTokens: 100,
  cachedInputTokens: 10,
  cacheWriteInputTokens: 0,
  outputTokens: 50,
  reasoningTokens: 5,
  toolCalls: 0,
  costMicros: 1_000,
});

export function candidate(
  localKey: string,
  title: string,
  options: Partial<CandidateRequirementDraft> = {},
): CandidateRequirementDraft {
  return {
    localKey,
    title,
    description: `${title} is part of the bounded product scope.`,
    rationale: `${title} supports an explicit desired outcome.`,
    category: "capability",
    proposedDisposition: "required",
    dependsOn: [],
    ...options,
  };
}

export function draft(
  candidates: readonly CandidateRequirementDraft[] = [],
  overrides: Partial<PlanningContributionDraft> = {},
): PlanningContributionDraft {
  return {
    candidates,
    findings: [],
    unresolvedQuestions: [],
    dissent: [],
    ...overrides,
  };
}

export function evidence(
  plan: ProductPlan,
  phaseId: string,
  clock: ManualPlanningClock,
  suffix = "1",
  overrides: Partial<PlanningContributionEvidence> = {},
): PlanningContributionEvidence {
  const phase = plan.toSnapshot().phases.find((item) => item.phaseId === phaseId)!;
  return {
    phaseId,
    resultId: `result:${phase.kind}:${suffix}`,
    attempt: 1,
    inputDigest: phase.inputDigest,
    schedulerTaskId: phase.taskId,
    schedulerIdempotencyKey: phase.idempotencyKey,
    route: phase.route,
    sourceFingerprint: planningDigest({ phaseId, suffix }),
    completedAt: clock.now().toISOString(),
    usage: USAGE,
    ...overrides,
  };
}

export function applyPhase(
  plan: ProductPlan,
  phaseKind: "product-discovery" | "specialist-gap-analysis" | "engineering-feasibility" | "plan-synthesis",
  value: PlanningContributionDraft,
  clock: ManualPlanningClock,
  specialistIndex = 0,
): void {
  const phase = plan.toSnapshot().phases.filter((item) => item.kind === phaseKind)[specialistIndex]!;
  const staged = plan.stageContribution(evidence(plan, phase.phaseId, clock), value);
  plan.applyStagedContribution(staged.contributionId, plan.version);
  clock.advance();
}

export function completePhases(plan: ProductPlan, clock: ManualPlanningClock): void {
  applyPhase(plan, "product-discovery", draft([
    candidate("core", "Core capability"),
  ]), clock);
  for (let index = 0; index < plan.toSnapshot().phases.filter((phase) => phase.kind === "specialist-gap-analysis").length; index += 1) {
    applyPhase(plan, "specialist-gap-analysis", draft([
      candidate(`core-${index}`, "Core capability", { rationale: `Independent provenance ${index}` }),
      candidate(`quality-${index}`, "Accessible interface", { category: "quality", proposedDisposition: "expected-quality" }),
    ]), clock, index);
  }
  applyPhase(plan, "engineering-feasibility", draft([
    candidate("reliable", "Reliable execution", { category: "quality", dependsOn: ["Core capability"] }),
  ], {
    findings: [{ kind: "feasibility", summary: "The design fits existing bounded contracts.", severity: "low" }],
  }), clock);
  applyPhase(plan, "plan-synthesis", draft([
    candidate("delight", "Polished onboarding", { proposedDisposition: "delight-candidate", dependsOn: ["Accessible interface"] }),
  ]), clock);
}

export function decideAll(plan: ProductPlan, clock: ManualPlanningClock): void {
  for (const requirement of plan.toSnapshot().requirements) {
    plan.decideScope({
      requirementId: requirement.requirementId,
      requirementDigest: requirement.requirementDigest,
      expectedPlanVersion: plan.version,
      disposition: requirement.proposedDispositions.includes("delight-candidate") ? "delight-candidate" : "required",
      actor: { actorId: "actor:owner", authority: "product-owner" },
      reason: "Reviewed against product intent and retained provenance.",
      approvalReference: `approval:${requirement.requirementId.slice(-16)}`,
      decidedAt: clock.now().toISOString(),
    });
    clock.advance();
  }
}

export function createPlan(options: {
  readonly config?: ProductPlanningConfiguration;
  readonly clock?: ManualPlanningClock;
  readonly intent?: ProductIntentInput;
} = {}): { readonly plan: ProductPlan; readonly clock: ManualPlanningClock; readonly config: ProductPlanningConfiguration } {
  const clock = options.clock ?? new ManualPlanningClock();
  const config = options.config ?? configuration();
  return {
    plan: ProductPlan.create(options.intent ?? intent(), config, { clock }),
    clock,
    config,
  };
}
