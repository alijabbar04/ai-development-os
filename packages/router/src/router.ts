import {
  estimateModelCost,
  validation,
  type DataHandlingPolicy,
  type TaskCapability
} from "@ai-dev-os/domain";
import { combinedCapability } from "@ai-dev-os/providers";
import {
  DEFAULT_ROUTER_CONFIGURATION,
  parseRouterConfiguration,
  ROUTER_SCORE_TERM_IDS,
  type RouterConfiguration,
  type RouterScoreTermId
} from "./config.js";
import type { RouterClock } from "./clock.js";
import type {
  CatalogCapabilityEvidence,
  RoutingCandidateSnapshot
} from "./candidate.js";
import { planBudgetReservation, type BudgetReservationPlan } from "./budget.js";
import {
  ROUTE_REJECTION_CODES,
  ROUTER_SCHEMA_VERSION,
  ROUTING_ALGORITHM_VERSION,
  applicationConfigurationFingerprint,
  assertRouterConfigurationBinding,
  parseRouteDecision,
  parseRoutingRequest,
  routeDecisionFingerprint,
  summarizeRouteDecision,
  type RouteChoice,
  type RouteConfidence,
  type RouteDecision,
  type RouteRejection,
  type RouteRejectionCode,
  type RouteScoreComponent,
  type RoutingRequest
} from "./model.js";
import { RouterError, checkedNumber, compareText, digest } from "./shared.js";

const { ensureTimestamp } = validation;

interface CandidateEvaluation {
  readonly candidate: RoutingCandidateSnapshot;
  readonly aliases: readonly string[];
  readonly selectedAlias: string | null;
  readonly explicitlyPinned: boolean;
  readonly codes: readonly RouteRejectionCode[];
  readonly reservation: BudgetReservationPlan | null;
  readonly confidence: RouteConfidence;
  readonly validUntil: string;
}

interface ScoredCandidate extends Omit<CandidateEvaluation, "reservation"> {
  readonly reservation: BudgetReservationPlan;
  readonly components: readonly RouteScoreComponent[];
  readonly totalScore: number;
}

function addCode(codes: Set<RouteRejectionCode>, code: RouteRejectionCode): void {
  codes.add(code);
}

function milliseconds(iso: string): number {
  return new Date(ensureTimestamp(iso, "instant")).valueOf();
}

function isFresh(nowMs: number, observedAt: string, staleAt: string, maximumAgeMs: number): boolean {
  const observedMs = milliseconds(observedAt);
  return observedMs <= nowMs && nowMs <= milliseconds(staleAt) && nowMs - observedMs <= maximumAgeMs;
}

function healthStaleAt(checkedAt: string, maximumAgeMs: number): string {
  return new Date(milliseconds(checkedAt) + maximumAgeMs).toISOString();
}

function evidenceStaleAt(observedAt: string, declaredStaleAt: string, maximumAgeMs: number): string {
  return earliestInstant([
    declaredStaleAt,
    new Date(milliseconds(observedAt) + maximumAgeMs).toISOString()
  ]);
}

function earliestInstant(values: readonly (string | null)[]): string {
  const present = values.filter((value): value is string => value !== null);
  return present.reduce((earliest, value) =>
    milliseconds(value) < milliseconds(earliest) ? value : earliest
  );
}

function quotaDimension(
  candidate: RoutingCandidateSnapshot,
  dimension: "tokens" | "requests"
): { readonly remaining: number | null; readonly limit: number | null } | undefined {
  return candidate.quota.dimensions.find((item) => item.dimension === dimension);
}

function withSafetyMarginOrNull(value: number, basisPoints: number): number | null {
  const amount = BigInt(value);
  const result = amount + (amount * BigInt(basisPoints) + 9_999n) / 10_000n;
  return result > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(result);
}

function aliasesForCandidate(
  request: RoutingRequest,
  candidate: RoutingCandidateSnapshot
): readonly string[] {
  return Object.freeze(
    request.configuration.modelAliases
      .filter(
        (alias) =>
          alias.providerInstanceId === candidate.gateway.instanceId &&
          alias.modelId === candidate.gateway.contractModelId
      )
      .map((alias) => alias.alias)
      .sort(compareText)
  );
}

function orderedAliases(request: RoutingRequest): readonly string[] {
  const preference = request.configuration.modelPreferences.find((item) => item.role === request.role);
  const values = [
    ...(request.explicitAlias === null ? [] : [request.explicitAlias]),
    ...(preference?.aliases ?? []),
    ...(request.configuration.routing.defaultAlias === null
      ? []
      : [request.configuration.routing.defaultAlias]),
    ...request.configuration.routing.fallbackAliases
  ];
  return Object.freeze([...new Set(values)]);
}

function selectedAliasFor(
  request: RoutingRequest,
  candidateAliases: readonly string[]
): string | null {
  for (const alias of orderedAliases(request)) if (candidateAliases.includes(alias)) return alias;
  return candidateAliases[0] ?? null;
}

function requiredCatalogCapabilities(profileCapabilities: readonly TaskCapability[]): readonly string[] {
  const required = new Set<string>(["text-input", "text-output"]);
  if (profileCapabilities.includes("reasoning")) required.add("reasoning");
  if (profileCapabilities.includes("structured-output")) required.add("structured-output");
  if (profileCapabilities.includes("tool-use")) required.add("tools");
  if (profileCapabilities.includes("vision")) required.add("image-input");
  return Object.freeze([...required].sort(compareText));
}

function catalogClaim(
  capabilities: readonly CatalogCapabilityEvidence[],
  id: string
): CatalogCapabilityEvidence | undefined {
  return capabilities.find((item) => item.id === id);
}

const REASONING_RATINGS = Object.freeze({ low: 1, medium: 2, high: 4, extreme: 5 });

function providerCapabilityFailures(
  request: RoutingRequest,
  candidate: RoutingCandidateSnapshot,
  codes: Set<RouteRejectionCode>
): void {
  const required = request.profile.effective.capabilities;
  const provider = candidate.gateway.descriptor;
  const model = candidate.gateway.model.model;
  const combined = combinedCapability(provider, model);
  const requiresExecution = request.surface === "task-execution";
  const unsupported =
    (required.includes("structured-output") && !combined.structuredOutput) ||
    (required.includes("tool-use") && !combined.toolCalling) ||
    (required.includes("vision") && !combined.imageInput) ||
    (requiresExecution && required.includes("code-edit") && !provider.capabilities.repositoryEditing) ||
    (requiresExecution && required.includes("repository-read") && !provider.capabilities.repositoryEditing) ||
    (requiresExecution && required.includes("shell") && !provider.capabilities.commandExecution) ||
    (requiresExecution && required.includes("testing") && !provider.capabilities.commandExecution);
  if (unsupported) addCode(codes, "CAPABILITY_UNSUPPORTED");
  for (const id of requiredCatalogCapabilities(required)) {
    const claim = catalogClaim(candidate.catalog.capabilities, id);
    if (claim?.status === "unsupported") addCode(codes, "CAPABILITY_UNSUPPORTED");
    if (claim === undefined || claim.status === "unknown") addCode(codes, "CAPABILITY_UNKNOWN");
  }
  if (model.reasoningCapability < REASONING_RATINGS[request.profile.effective.reasoning]) {
    addCode(codes, "REASONING_RATING_INSUFFICIENT");
  }
  if (
    required.includes("code-edit") &&
    model.codingCapability < request.profile.effective.complexity
  ) {
    addCode(codes, "CODING_RATING_INSUFFICIENT");
  }
}

function policyFailures(
  request: RoutingRequest,
  candidate: RoutingCandidateSnapshot,
  handling: DataHandlingPolicy,
  codes: Set<RouteRejectionCode>
): void {
  const classification = request.profile.effective.dataClassification;
  if (candidate.policy.outcome === "denied") addCode(codes, "POLICY_DENIED");
  if (candidate.policy.outcome === "conditional") addCode(codes, "POLICY_CONDITIONAL");
  if (candidate.policy.classification !== classification) addCode(codes, "CLASSIFICATION_MISMATCH");
  if (!candidate.gateway.descriptor.supportedClassifications.includes(classification)) {
    addCode(codes, "CLASSIFICATION_UNSUPPORTED");
  }
  const localRequired =
    request.profile.authorityCeilings.requiredLocality === "local" ||
    candidate.policy.requiredLocality === "local" ||
    handling.localExecutionRequired;
  if (localRequired && candidate.gateway.descriptor.locality !== "local") {
    addCode(codes, "LOCALITY_REQUIRED");
  }
  if (!handling.cloudProvidersAllowed && candidate.gateway.descriptor.locality === "cloud") {
    addCode(codes, "CLOUD_FORBIDDEN");
  }
  if (
    handling.disallowedProviderCapabilities.includes("data-retention") &&
    candidate.gateway.descriptor.retainsData
  ) {
    addCode(codes, "RETENTION_INCOMPATIBLE");
  }
  if (
    handling.disallowedProviderCapabilities.includes("model-training") &&
    candidate.gateway.descriptor.trainsOnInputs
  ) {
    addCode(codes, "TRAINING_INCOMPATIBLE");
  }
  if (
    handling.disallowedProviderCapabilities.includes("external-network-tools") &&
    candidate.gateway.descriptor.capabilities.networkAccess
  ) {
    addCode(codes, "NETWORK_INCOMPATIBLE");
  }
  if (
    !handling.logRetentionAllowed &&
    (candidate.policy.inputLoggingAllowed || candidate.policy.outputLoggingAllowed)
  ) {
    addCode(codes, "LOGGING_INCOMPATIBLE");
  }
  if (!candidate.policy.retentionAllowed && candidate.gateway.descriptor.retainsData) {
    addCode(codes, "RETENTION_INCOMPATIBLE");
  }
}

function catalogFailures(
  request: RoutingRequest,
  candidate: RoutingCandidateSnapshot,
  nowMs: number,
  configuration: RouterConfiguration,
  codes: Set<RouteRejectionCode>
): void {
  if (candidate.catalog.providerState !== "enabled") addCode(codes, "CATALOG_PROVIDER_DISABLED");
  if (candidate.catalog.modelState !== "enabled") addCode(codes, "CATALOG_MODEL_DISABLED");
  if (
    nowMs > milliseconds(candidate.catalog.providerRefreshAfter) ||
    nowMs > milliseconds(candidate.catalog.modelRefreshAfter) ||
    nowMs - milliseconds(candidate.catalog.generatedAt) > configuration.freshness.catalogMs ||
    milliseconds(candidate.catalog.generatedAt) > nowMs
  ) {
    addCode(codes, "CATALOG_EXPIRED");
  }
  const verifiedFreeOnly =
    request.verifiedFreeOnly ||
    configuration.hardEvidence.verifiedFreeOnly ||
    candidate.gateway.eligibility === "verified-free-only";
  if (verifiedFreeOnly && candidate.catalog.freeTierState !== "verified") {
    addCode(codes, "FREE_TIER_NOT_VERIFIED");
  }
}

function contextFailures(
  request: RoutingRequest,
  candidate: RoutingCandidateSnapshot,
  configuration: RouterConfiguration,
  codes: Set<RouteRejectionCode>
): void {
  const estimate = candidate.tokenEstimate;
  if (
    estimate.providerId !== candidate.gateway.descriptor.providerId ||
    estimate.contractModelId !== candidate.gateway.contractModelId ||
    estimate.catalogModelFingerprint !== candidate.catalog.modelFingerprint ||
    estimate.transportProfileId !== candidate.gateway.adapter.profileId
  ) {
    addCode(codes, "ESTIMATOR_IDENTITY_MISMATCH");
  }
  if (
    !estimate.canProveContextFit ||
    estimate.accuracy === "heuristic" ||
    (configuration.hardEvidence.minimumEstimatorAccuracy === "exact" &&
      estimate.accuracy !== "exact")
  ) {
    addCode(codes, "ESTIMATOR_ACCURACY_INSUFFICIENT");
  }
  const descriptorContext = candidate.gateway.model.model.contextWindowTokens;
  const catalogContext = candidate.catalog.contextTokens;
  if (catalogContext === null) addCode(codes, "CONTEXT_LIMIT_UNKNOWN");
  else if (
    estimate.contextContributionTokens > descriptorContext ||
    estimate.contextContributionTokens > catalogContext
  ) {
    addCode(codes, "CONTEXT_LIMIT_EXCEEDED");
  }
  const descriptorOutput = candidate.gateway.model.model.maxOutputTokens;
  const catalogOutput = candidate.catalog.maximumOutputTokens;
  if (catalogOutput === null) addCode(codes, "OUTPUT_LIMIT_UNKNOWN");
  else if (
    estimate.outputAllowanceTokens > descriptorOutput ||
    estimate.outputAllowanceTokens > catalogOutput
  ) {
    addCode(codes, "OUTPUT_LIMIT_EXCEEDED");
  }
  if (
    request.profile.effective.expectedOutputTokens !== null &&
    estimate.outputAllowanceTokens < request.profile.effective.expectedOutputTokens
  ) {
    addCode(codes, "OUTPUT_LIMIT_EXCEEDED");
  }
}

function runtimeFailures(
  request: RoutingRequest,
  candidate: RoutingCandidateSnapshot,
  nowMs: number,
  configuration: RouterConfiguration,
  codes: Set<RouteRejectionCode>
): void {
  const health = candidate.health;
  if (
    milliseconds(health.checkedAt) > nowMs ||
    nowMs - milliseconds(health.checkedAt) > configuration.freshness.healthMs
  ) {
    addCode(codes, "HEALTH_STALE");
  }
  if (health.status === "unavailable") addCode(codes, "PROVIDER_UNAVAILABLE");
  if (health.status === "closed") addCode(codes, "PROVIDER_CLOSED");
  if (
    candidate.quota.providerInstanceId !== candidate.gateway.instanceId ||
    candidate.quota.contractModelId !== candidate.gateway.contractModelId
  ) {
    addCode(codes, "QUOTA_SCOPE_MISMATCH");
  }
  if (
    !isFresh(
      nowMs,
      candidate.quota.observedAt,
      candidate.quota.staleAt,
      configuration.freshness.quotaMs
    )
  ) {
    addCode(codes, "QUOTA_STALE");
  }
  if (candidate.quota.state === "unknown") {
    if (configuration.hardEvidence.requireKnownQuota) addCode(codes, "QUOTA_UNKNOWN");
  }
  if (
    candidate.quota.completeness !== "complete" &&
    configuration.hardEvidence.requireKnownQuota
  ) {
    addCode(codes, "QUOTA_PARTIAL");
  }
  if (candidate.quota.state === "exhausted") addCode(codes, "QUOTA_EXHAUSTED");
  const requestQuota = quotaDimension(candidate, "requests");
  const tokenQuota = quotaDimension(candidate, "tokens");
  const requiredQuotaTokens = withSafetyMarginOrNull(
    candidate.tokenEstimate.totalTokens,
    configuration.reservation.tokenSafetyMarginBps
  );
  if (requiredQuotaTokens === null) {
    addCode(codes, "ARITHMETIC_BOUND_EXCEEDED");
  }
  if (
    requestQuota?.remaining !== null &&
    requestQuota?.remaining !== undefined &&
    requestQuota.remaining < 1
  ) {
    addCode(codes, "QUOTA_INSUFFICIENT");
  }
  if (
    tokenQuota?.remaining !== null &&
    tokenQuota?.remaining !== undefined &&
    requiredQuotaTokens !== null &&
    tokenQuota.remaining < requiredQuotaTokens
  ) {
    addCode(codes, "QUOTA_INSUFFICIENT");
  }
  if (
    configuration.hardEvidence.requireKnownQuota &&
    (requestQuota?.remaining === null ||
      requestQuota?.remaining === undefined ||
      tokenQuota?.remaining === null ||
      tokenQuota?.remaining === undefined)
  ) {
    addCode(codes, "QUOTA_UNKNOWN");
  }
  const isLocal = candidate.gateway.descriptor.locality === "local";
  if (
    candidate.capacity.providerInstanceId !== candidate.gateway.instanceId ||
    candidate.capacity.contractModelId !== candidate.gateway.contractModelId
  ) {
    addCode(codes, "CAPACITY_SCOPE_MISMATCH");
  }
  if (isLocal) {
    if (
      !isFresh(
        nowMs,
        candidate.capacity.observedAt,
        candidate.capacity.staleAt,
        configuration.freshness.capacityMs
      )
    ) {
      addCode(codes, "CAPACITY_STALE");
    }
    if (
      (candidate.capacity.state === "unknown" ||
        candidate.capacity.state === "unsupported" ||
        candidate.capacity.completeness !== "complete") &&
      configuration.hardEvidence.requireKnownCapacityForLocal
    ) {
      addCode(codes, "CAPACITY_UNKNOWN");
    }
    const availableConcurrency = candidate.capacity.availableConcurrency;
    const availableMemory = candidate.capacity.availableMemoryBytes;
    const requiredMemory = candidate.capacity.requiredMemoryBytes;
    if (
      candidate.capacity.state === "unavailable" ||
      (availableConcurrency !== null &&
        availableConcurrency <= configuration.protectedReserve.concurrency) ||
      (availableMemory !== null &&
        requiredMemory !== null &&
        availableMemory - requiredMemory < configuration.protectedReserve.memoryBytes)
    ) {
      addCode(codes, "CAPACITY_INSUFFICIENT");
    }
  }
  if (candidate.circuit.phase === "open") addCode(codes, "CIRCUIT_OPEN");
  if (
    candidate.circuit.phase === "half-open" &&
    request.halfOpenProbeCandidateId !== candidate.candidateId
  ) {
    addCode(codes, "HALF_OPEN_PROBE_NOT_ADMITTED");
  }
  if (
    candidate.gateway.descriptor.kind === "coding-agent" &&
    !isFresh(
      nowMs,
      candidate.secureExecution.verifiedAt,
      new Date(
        milliseconds(candidate.secureExecution.verifiedAt) +
          configuration.freshness.secureExecutionMs
      ).toISOString(),
      configuration.freshness.secureExecutionMs
    )
  ) {
    addCode(codes, "SECURE_EXECUTION_STALE");
  }
}

function configurationFailures(
  request: RoutingRequest,
  candidate: RoutingCandidateSnapshot,
  aliases: readonly string[],
  codes: Set<RouteRejectionCode>
): void {
  const provider = request.configuration.providers.find(
    (item) => item.instanceId === candidate.gateway.instanceId
  );
  if (provider === undefined) addCode(codes, "PROVIDER_NOT_CONFIGURED");
  else {
    if (!provider.enabled) addCode(codes, "PROVIDER_DISABLED");
    if (
      provider.providerId !== candidate.gateway.descriptor.providerId ||
      provider.kind !== candidate.gateway.descriptor.kind ||
      provider.locality !== candidate.gateway.descriptor.locality
    ) {
      addCode(codes, "CONFIGURATION_IDENTITY_MISMATCH");
    }
  }
  if (candidate.gateway.userPreference === "disabled") addCode(codes, "USER_DISABLED");
  if (aliases.length === 0) addCode(codes, "ALIAS_NOT_CONFIGURED");
  if (
    request.explicitAlias !== null &&
    !aliases.includes(request.explicitAlias) &&
    !request.allowFallbacks
  ) {
    addCode(codes, "EXPLICIT_ALIAS_MISMATCH");
  }
  if (candidate.gateway.adapter.profileId !== candidate.catalog.adapterProfileId) {
    addCode(codes, "ADAPTER_PROFILE_MISMATCH");
  }
  if (request.surface === "thinker-inference" && candidate.gateway.descriptor.kind !== "inference") {
    addCode(codes, "WRONG_PROVIDER_KIND");
  }
  if (
    request.surface === "task-execution" &&
    candidate.gateway.descriptor.kind === "coding-agent" &&
    !["implement", "refactor", "debug", "review", "test"].includes(
      request.profile.effective.kind
    )
  ) {
    addCode(codes, "WRONG_PROVIDER_KIND");
  }
  if (
    candidate.gateway.descriptor.kind === "coding-agent" &&
    candidate.secureExecution.level !== "secure-enforcing"
  ) {
    addCode(codes, "SECURE_EXECUTION_REQUIRED");
  }
}

function evaluateCandidate(
  request: RoutingRequest,
  candidate: RoutingCandidateSnapshot,
  configuration: RouterConfiguration,
  nowIso: string
): CandidateEvaluation {
  const nowMs = milliseconds(nowIso);
  const codes = new Set<RouteRejectionCode>();
  const aliases = aliasesForCandidate(request, candidate);
  const selectedAlias = selectedAliasFor(request, aliases);
  const explicitlyPinned = request.explicitAlias !== null && aliases.includes(request.explicitAlias);
  configurationFailures(request, candidate, aliases, codes);
  const handling = request.configuration.data.handlingPolicies.find(
    (item) => item.classification === request.profile.effective.dataClassification
  );
  if (handling === undefined) addCode(codes, "POLICY_DENIED");
  else policyFailures(request, candidate, handling, codes);
  catalogFailures(request, candidate, nowMs, configuration, codes);
  if (candidate.gateway.model.availability === "unavailable") addCode(codes, "MODEL_UNAVAILABLE");
  providerCapabilityFailures(request, candidate, codes);
  contextFailures(request, candidate, configuration, codes);
  runtimeFailures(request, candidate, nowMs, configuration, codes);
  if (candidate.gateway.descriptor.kind === "coding-agent") {
    if (candidate.secureExecution.level !== "secure-enforcing") {
      addCode(codes, "SECURE_EXECUTION_REQUIRED");
    }
  }
  if (
    request.requiredMaximumLatencyMs !== null &&
    (candidate.expectedLatencyMs === null ||
      candidate.expectedLatencyMs > request.requiredMaximumLatencyMs)
  ) {
    addCode(codes, "LATENCY_INCOMPATIBLE");
  }
  if (
    request.deadline !== null &&
    (candidate.expectedLatencyMs === null ||
      nowMs + candidate.expectedLatencyMs > milliseconds(request.deadline))
  ) {
    addCode(codes, "DEADLINE_INCOMPATIBLE");
  }
  let reservation: BudgetReservationPlan | null = null;
  try {
    reservation = planBudgetReservation({
      account: request.budgetAccount,
      reservationId: `route-${digest({ request: request.requestId, candidate: candidate.candidateId }).slice(0, 48)}`,
      requestedAt: nowIso,
      tokenEstimate: candidate.tokenEstimate,
      costEstimate: candidate.costEstimate,
      expectedDurationMs: request.expectedDurationMs,
      configuration
    });
  } catch {
    addCode(codes, "ARITHMETIC_BOUND_EXCEEDED");
  }
  if (
    candidate.costEstimate.status === "known" &&
    (candidate.gateway.model.model.cost === null ||
      !candidate.gateway.descriptor.capabilities.pricingAvailable)
  ) {
    addCode(codes, "COST_EVIDENCE_MISMATCH");
  } else if (
    candidate.gateway.model.model.cost !== null &&
    candidate.costEstimate.status === "known"
  ) {
    try {
      const cached = candidate.tokenEstimate.cachedInputTokens ?? 0;
      const exactCost = estimateModelCost(candidate.gateway.model.model, {
        inputTokens: candidate.tokenEstimate.inputTokens - cached,
        outputTokens: candidate.tokenEstimate.outputAllowanceTokens,
        cachedInputTokens: cached,
        reasoningTokens: candidate.tokenEstimate.reasoningAllowanceTokens
      });
      if (
        exactCost.currency !== candidate.costEstimate.currency ||
        exactCost.amountMicros !== candidate.costEstimate.amountMicros
      ) {
        addCode(codes, "COST_EVIDENCE_MISMATCH");
      }
    } catch {
      addCode(codes, "ARITHMETIC_BOUND_EXCEEDED");
    }
  }
  if (reservation?.code === "COST_UNKNOWN") addCode(codes, "COST_UNKNOWN");
  if (reservation?.code === "CURRENCY_MISMATCH") addCode(codes, "CURRENCY_MISMATCH");
  if (reservation?.code === "BUDGET_EXCEEDED") addCode(codes, "BUDGET_INSUFFICIENT");
  let confidenceScore = request.profile.confidence.score;
  const confidenceReasons: string[] = [...request.profile.confidence.reasonCodes];
  if (candidate.health.status === "degraded") {
    confidenceScore -= 100;
    confidenceReasons.push("degraded-health");
  }
  if (candidate.quota.completeness !== "complete") {
    confidenceScore -= 200;
    confidenceReasons.push("partial-quota");
  }
  if (candidate.capacity.completeness !== "complete") {
    confidenceScore -= 100;
    confidenceReasons.push("partial-capacity");
  }
  if (candidate.costEstimate.status === "unknown") {
    confidenceScore -= 100;
    confidenceReasons.push("unknown-cost");
  }
  if (candidate.tokenEstimate.accuracy === "proven-upper-bound") {
    confidenceScore -= 50;
    confidenceReasons.push("conservative-token-bound");
  }
  confidenceScore = Math.max(0, confidenceScore);
  if (confidenceScore < configuration.confidence.minimum) {
    addCode(codes, "CONFIDENCE_BELOW_MINIMUM");
  }
  const confidence = Object.freeze({
    score: confidenceScore,
    completeness:
      confidenceScore === 0
        ? "unknown" as const
        : confidenceReasons.length === 0
          ? "complete" as const
          : "partial" as const,
    reasonCodes: Object.freeze([...new Set(confidenceReasons)].sort(compareText))
  });
  const validUntil = earliestInstant([
    candidate.catalog.providerRefreshAfter,
    candidate.catalog.modelRefreshAfter,
    new Date(
      milliseconds(candidate.catalog.generatedAt) + configuration.freshness.catalogMs
    ).toISOString(),
    healthStaleAt(candidate.health.checkedAt, configuration.freshness.healthMs),
    evidenceStaleAt(
      candidate.quota.observedAt,
      candidate.quota.staleAt,
      configuration.freshness.quotaMs
    ),
    candidate.gateway.descriptor.locality === "local"
      ? evidenceStaleAt(
          candidate.capacity.observedAt,
          candidate.capacity.staleAt,
          configuration.freshness.capacityMs
        )
      : null,
    candidate.gateway.descriptor.kind === "coding-agent"
      ? new Date(
          milliseconds(candidate.secureExecution.verifiedAt) +
            configuration.freshness.secureExecutionMs
        ).toISOString()
      : null,
    request.deadline
  ]);
  return Object.freeze({
    candidate,
    aliases,
    selectedAlias,
    explicitlyPinned,
    codes: Object.freeze([...codes].sort(compareText)),
    reservation,
    confidence,
    validUntil
  });
}

function ratioScore(numerator: number, denominator: number): number {
  if (denominator <= 0) return -1_000;
  const scaled = checkedNumber(
    (BigInt(numerator) * 2_000n) / BigInt(denominator) - 1_000n,
    "ratio score"
  );
  return Math.max(-1_000, Math.min(1_000, scaled));
}

function term(
  id: RouterScoreTermId,
  value: number,
  configuration: RouterConfiguration,
  evidenceCode: string
): RouteScoreComponent {
  const bounded = Math.max(-1_000, Math.min(1_000, value));
  const weight = configuration.scoreWeights[id];
  return Object.freeze({
    term: id,
    value: bounded,
    weight,
    weightedValue: checkedNumber(BigInt(bounded) * BigInt(weight), `${id} score`),
    evidenceCode
  });
}

function aliasPriorityValue(request: RoutingRequest, selectedAlias: string | null): number {
  if (selectedAlias === null) return -1_000;
  const order = orderedAliases(request);
  const index = order.indexOf(selectedAlias);
  return index < 0 ? 0 : Math.max(-1_000, 1_000 - index * 250);
}

function preferenceValue(value: number, priority: number, label: string): number {
  return checkedNumber((BigInt(value) * BigInt(priority)) / 50n, label);
}

function scoreCandidate(
  request: RoutingRequest,
  evaluation: CandidateEvaluation,
  configuration: RouterConfiguration,
  nowIso: string
): ScoredCandidate {
  if (evaluation.reservation === null) {
    throw new RouterError(
      "BUDGET_PLAN_FAILED",
      "A feasible candidate must have a validated reservation plan."
    );
  }
  const candidate = evaluation.candidate;
  const model = candidate.gateway.model.model;
  const reasoningMinimum = REASONING_RATINGS[request.profile.effective.reasoning];
  const codingMinimum = request.profile.effective.capabilities.includes("code-edit")
    ? request.profile.effective.complexity
    : 1;
  const capabilityMargin = Math.min(
    model.reasoningCapability - reasoningMinimum,
    model.codingCapability - codingMinimum
  );
  const costValue =
    candidate.costEstimate.status === "known"
      ? Math.max(-1_000, 1_000 - Math.floor(candidate.costEstimate.amountMicros! / 1_000))
      : -1_000;
  const latencyValue =
    candidate.expectedLatencyMs === null
      ? -1_000
      : Math.max(-1_000, 1_000 - Math.floor(candidate.expectedLatencyMs / 10));
  const preferredLocality = request.configuration.preferences.preferredLocality;
  const isLocal = candidate.gateway.descriptor.locality === "local";
  const localityValue =
    preferredLocality === "balanced"
      ? request.configuration.routing.preferLocal
        ? isLocal ? 1_000 : 0
        : 0
      : (preferredLocality === "local") === isLocal
        ? 1_000
        : -1_000;
  const tokenQuota = quotaDimension(candidate, "tokens");
  const quotaValue =
    tokenQuota?.remaining === null || tokenQuota?.remaining === undefined || tokenQuota.limit === null
      ? -1_000
      : ratioScore(tokenQuota.remaining, tokenQuota.limit);
  const requiredQuotaTokens = withSafetyMarginOrNull(
    candidate.tokenEstimate.totalTokens,
    configuration.reservation.tokenSafetyMarginBps
  );
  const remainingAfter =
    tokenQuota?.remaining === null ||
    tokenQuota?.remaining === undefined ||
    requiredQuotaTokens === null
      ? null
      : tokenQuota.remaining - requiredQuotaTokens;
  const requestQuota = quotaDimension(candidate, "requests");
  const requestsRemainingAfter =
    requestQuota?.remaining === null || requestQuota?.remaining === undefined
      ? null
      : requestQuota.remaining - 1;
  const reserveValue =
    remainingAfter === null || requestsRemainingAfter === null
      ? -1_000
      : remainingAfter >= configuration.protectedReserve.tokens &&
          requestsRemainingAfter >= configuration.protectedReserve.requests
        ? 1_000
        : -1_000;
  const capacityValue =
    !isLocal
      ? 0
      : candidate.capacity.availableMemoryBytes === null ||
          candidate.capacity.requiredMemoryBytes === null
        ? -1_000
        : ratioScore(
            Math.max(
              0,
              candidate.capacity.availableMemoryBytes - candidate.capacity.requiredMemoryBytes
            ),
            Math.max(1, candidate.capacity.availableMemoryBytes)
          );
  const healthValue = candidate.health.status === "ready" ? 1_000 : 0;
  const contextLimit = Math.min(
    candidate.gateway.model.model.contextWindowTokens,
    candidate.catalog.contextTokens ?? candidate.gateway.model.model.contextWindowTokens
  );
  const contextValue = ratioScore(
    Math.max(0, contextLimit - candidate.tokenEstimate.contextContributionTokens),
    contextLimit
  );
  const qualityValue = Math.min(
    1_000,
    (model.reasoningCapability + model.codingCapability - 2) * 125
  );
  const resetFresh =
    candidate.quota.resetsAt !== null &&
    isFresh(
      milliseconds(nowIso),
      candidate.quota.observedAt,
      candidate.quota.staleAt,
      configuration.freshness.quotaMs
    );
  const components = Object.freeze([
    term(
      "capability-margin",
      capabilityMargin * 250,
      configuration,
      "declared-capability-margin"
    ),
    term("quality-evidence", qualityValue, configuration, "descriptor-ratings"),
    term(
      "cost-efficiency",
      preferenceValue(
        costValue,
        request.configuration.preferences.costPriority,
        "cost preference score"
      ),
      configuration,
      candidate.costEstimate.status === "known" ? "exact-cost" : "unknown-cost"
    ),
    term(
      "latency-margin",
      preferenceValue(
        latencyValue,
        request.configuration.preferences.latencyPriority,
        "latency preference score"
      ),
      configuration,
      candidate.expectedLatencyMs === null ? "unknown-latency" : "declared-latency"
    ),
    term("locality-preference", localityValue, configuration, "configured-locality"),
    term(
      "alias-priority",
      aliasPriorityValue(request, evaluation.selectedAlias),
      configuration,
      "configured-alias-order"
    ),
    term(
      "verified-free",
      candidate.catalog.freeTierState === "verified" ? 1_000 : -500,
      configuration,
      "catalog-free-evidence"
    ),
    term(
      "quota-headroom",
      quotaValue,
      configuration,
      resetFresh ? "fresh-quota-with-reset" : "fresh-quota-without-reset"
    ),
    term("protected-reserve", reserveValue, configuration, "protected-request-token-reserve"),
    term("capacity-headroom", capacityValue, configuration, "capacity-snapshot"),
    term("health-reliability", healthValue, configuration, "health-snapshot"),
    term("context-headroom", contextValue, configuration, "proven-context-headroom"),
    term(
      "evidence-confidence",
      evaluation.confidence.score * 2 - 1_000,
      configuration,
      "evidence-completeness"
    )
  ] satisfies readonly RouteScoreComponent[]);
  const totalScore = checkedNumber(
    components.reduce((total, component) => total + BigInt(component.weightedValue), 0n),
    "total route score"
  );
  return Object.freeze({
    ...evaluation,
    reservation: evaluation.reservation,
    components,
    totalScore
  });
}

function choiceFrom(scored: ScoredCandidate, rank: number, lowerRankReason: string | null): RouteChoice {
  const candidate = scored.candidate;
  return Object.freeze({
    rank,
    candidateId: candidate.candidateId,
    candidateFingerprint: candidate.fingerprint,
    providerInstanceId: candidate.gateway.instanceId,
    providerKind: candidate.gateway.descriptor.kind,
    contractModelId: candidate.gateway.contractModelId,
    selectedAlias: scored.selectedAlias,
    catalogProviderFingerprint: candidate.catalog.providerFingerprint,
    catalogModelFingerprint: candidate.catalog.modelFingerprint,
    gatewayFingerprint: candidate.gateway.gatewaySnapshotFingerprint,
    tokenEstimate: candidate.tokenEstimate,
    costEstimate: candidate.costEstimate,
    reservation: Object.freeze({
      planFingerprint: scored.reservation.fingerprint,
      quoteFingerprint: scored.reservation.quote.fingerprint,
      estimate: scored.reservation.quote.estimate,
      durableMutationPerformed: false as const
    }),
    scoreComponents: scored.components,
    totalScore: scored.totalScore,
    confidence: scored.confidence.score,
    lowerRankReason
  });
}

function orderFeasible(
  request: RoutingRequest,
  values: readonly ScoredCandidate[]
): readonly ScoredCandidate[] {
  return Object.freeze(
    [...values].sort((left, right) => {
      if (request.explicitAlias !== null) {
        if (left.explicitlyPinned !== right.explicitlyPinned) return left.explicitlyPinned ? -1 : 1;
      }
      return right.totalScore - left.totalScore || compareText(left.candidate.fingerprint, right.candidate.fingerprint);
    })
  );
}

function evidenceFingerprints(request: RoutingRequest): readonly string[] {
  const values = request.candidates.flatMap((candidate) =>
    [
        candidate.fingerprint,
        candidate.gateway.gatewaySnapshotFingerprint,
        candidate.catalog.catalogFingerprint,
        candidate.catalog.providerFingerprint,
        candidate.catalog.modelFingerprint,
        candidate.policy.decisionFingerprint,
        candidate.policy.fingerprint,
        candidate.healthFingerprint,
        candidate.quota.sourceFingerprint,
        candidate.quota.correctionFingerprint,
        candidate.quota.fingerprint,
        candidate.capacity.sourceFingerprint,
        candidate.capacity.fingerprint,
        candidate.tokenEstimate.fingerprint,
        candidate.costEstimate.fingerprint,
        candidate.circuit.fingerprint,
        candidate.secureExecution.fingerprint
    ].filter((value): value is string => value !== null)
  );
  return Object.freeze([...new Set(values)].sort(compareText));
}

function decisionConfidence(
  primary: RouteChoice | null,
  rejections: readonly RouteRejection[]
): RouteConfidence {
  if (primary === null) {
    return Object.freeze({
      score: 0,
      completeness: "unknown" as const,
      reasonCodes: Object.freeze(["no-feasible-candidates"])
    });
  }
  const reasonCodes = rejections.length > 0 ? ["excluded-infeasible-candidates"] : [];
  return Object.freeze({
    score: primary.confidence,
    completeness: reasonCodes.length === 0 ? "complete" as const : "partial" as const,
    reasonCodes: Object.freeze(reasonCodes)
  });
}

export function routeTaskWithConfiguration(
  value: RoutingRequest | unknown,
  options: { readonly configuration: RouterConfiguration | unknown; readonly clock: RouterClock }
): RouteDecision {
  const request = parseRoutingRequest(value);
  const configuration = parseRouterConfiguration(options.configuration);
  assertRouterConfigurationBinding(request, configuration);
  if (request.candidates.length > configuration.bounds.maximumCandidates) {
    throw new RouterError("INVALID_REQUEST", "Routing candidate bound exceeded.", {
      maximum: configuration.bounds.maximumCandidates
    });
  }
  const decidedAt = options.clock.now().toISOString();
  const nowMs = milliseconds(decidedAt);
  if (milliseconds(request.requestedAt) > nowMs) {
    throw new RouterError("INVALID_REQUEST", "Routing request instant is in the future.");
  }
  const explicitAliasConfigured =
    request.explicitAlias === null ||
    request.configuration.modelAliases.some((item) => item.alias === request.explicitAlias);
  const evaluations = request.candidates.map((candidate) => {
    const evaluation = evaluateCandidate(request, candidate, configuration, decidedAt);
    if (!explicitAliasConfigured) {
      return Object.freeze({
        ...evaluation,
        codes: Object.freeze(
          [...new Set([...evaluation.codes, "EXPLICIT_ALIAS_MISMATCH" as const])].sort(compareText)
        )
      });
    }
    return evaluation;
  });
  const rejected = evaluations.filter((item) => item.codes.length > 0);
  const feasibleEvaluations = evaluations.filter((item) => item.codes.length === 0);
  const scored = feasibleEvaluations.map((item) => scoreCandidate(request, item, configuration, decidedAt));
  const ordered = orderFeasible(request, scored);
  const choices = Object.freeze(
    ordered.map((item, index) =>
      choiceFrom(
        item,
        index + 1,
        index === 0
          ? null
          : request.explicitAlias !== null && ordered[0]?.explicitlyPinned === true
            ? "explicit-pin-precedence"
            : "lower-deterministic-score"
      )
    )
  );
  const primary = choices[0] ?? null;
  const fallbacksEnabled =
    primary !== null &&
    request.allowFallbacks &&
    configuration.fallbacks.enabled &&
    configuration.fallbacks.maximumCount > 0;
  const fallbacks = Object.freeze(
    fallbacksEnabled
      ? choices.slice(1, configuration.fallbacks.maximumCount + 1)
      : []
  );
  const rejections = Object.freeze(
    rejected
      .map((item) =>
        Object.freeze({
          candidateId: item.candidate.candidateId,
          candidateFingerprint: item.candidate.fingerprint,
          codes: item.codes
        })
      )
      .sort((left, right) => compareText(left.candidateFingerprint, right.candidateFingerprint))
  );
  if (rejections.reduce((total, item) => total + item.codes.length, 0) > configuration.bounds.maximumRejections) {
    throw new RouterError("INVALID_REQUEST", "Routing rejection bound exceeded.");
  }
  const validUntil =
    primary === null
      ? decidedAt
      : ordered.find((item) => item.candidate.candidateId === primary.candidateId)!.validUntil;
  const handling = request.configuration.data.handlingPolicies.find(
    (item) => item.classification === request.profile.effective.dataClassification
  );
  const selectedPolicy = ordered[0]?.candidate.policy ?? null;
  const restrictions = Object.freeze({
    classification: request.profile.effective.dataClassification,
    requiredLocality:
      request.profile.authorityCeilings.requiredLocality === "local" ||
      handling?.localExecutionRequired === true
        ? "local" as const
        : "any" as const,
    approvalRequired:
      request.profile.authorityCeilings.approvalRequired ||
      handling?.humanApprovalRequired !== false,
    redactionsRequiredBeforeDisclosure: Object.freeze([
      ...(handling?.redactionsRequiredBeforeDisclosure ?? [])
    ]),
    logRetentionAllowed: handling?.logRetentionAllowed ?? false,
    artifactPersistenceAllowed: handling?.artifactPersistenceAllowed ?? false,
    inputLoggingAllowed: selectedPolicy?.inputLoggingAllowed ?? false,
    outputLoggingAllowed: selectedPolicy?.outputLoggingAllowed ?? false,
    retentionAllowed: selectedPolicy?.retentionAllowed ?? false
  });
  const unsigned = Object.freeze({
    schemaVersion: ROUTER_SCHEMA_VERSION,
    algorithmVersion: ROUTING_ALGORITHM_VERSION,
    decidedAt,
    outcome: primary === null ? "no-route" as const : "routed" as const,
    requestFingerprint: request.fingerprint,
    profileFingerprint: request.profile.fingerprint,
    applicationConfigurationFingerprint: applicationConfigurationFingerprint(request.configuration),
    routerConfigurationFingerprint: configuration.fingerprint,
    budgetAccountFingerprint: digest(request.budgetAccount),
    evidenceFingerprints: evidenceFingerprints(request),
    primary,
    fallbacks,
    feasible: choices,
    rejections,
    confidence: decisionConfidence(primary, rejections),
    validUntil,
    revalidationRequirements: Object.freeze([
      "budget-revalidation",
      "capacity-revalidation",
      "catalog-revalidation",
      "circuit-revalidation",
      "configuration-revalidation",
      "estimator-revalidation",
      "health-revalidation",
      "policy-revalidation",
      "quota-revalidation",
      "secure-execution-revalidation"
    ]),
    restrictions,
    authority: "none" as const,
    grantsAuthority: false as const,
    requiresExecutionTimeRevalidation: true as const,
    providerInvocationPerformed: false as const,
    durableMutationPerformed: false as const
  });
  return parseRouteDecision({ ...unsigned, fingerprint: routeDecisionFingerprint(unsigned) });
}

export interface RouterAuditEvent {
  readonly outcome: "routed" | "no-route" | "closed";
  readonly requestFingerprint: string;
  readonly decisionFingerprint: string | null;
  readonly primaryCandidateId: string | null;
  readonly feasibleCount: number;
  readonly rejectedCount: number;
  readonly authority: "none";
}

export type RouterObserver = (event: RouterAuditEvent) => void;

export interface Router {
  readonly configuration: RouterConfiguration;
  route(value: RoutingRequest | unknown): RouteDecision;
  close(): void;
}

export function createRouter(options: {
  readonly configuration?: RouterConfiguration | unknown;
  readonly clock: RouterClock;
  readonly observer?: RouterObserver;
}): Router {
  const configuration = parseRouterConfiguration(
    options.configuration ?? DEFAULT_ROUTER_CONFIGURATION
  );
  let closed = false;
  return Object.freeze({
    configuration,
    route: (value: RoutingRequest | unknown): RouteDecision => {
      if (closed) throw new RouterError("ROUTER_CLOSED", "Router is closed.");
      const decision = routeTaskWithConfiguration(value, {
        configuration,
        clock: options.clock
      });
      if (options.observer !== undefined) {
        try {
          const summary = summarizeRouteDecision(decision);
          options.observer(
            Object.freeze({
              outcome: summary.outcome,
              requestFingerprint: decision.requestFingerprint,
              decisionFingerprint: decision.fingerprint,
              primaryCandidateId: summary.primaryCandidateId,
              feasibleCount: summary.feasibleCount,
              rejectedCount: summary.rejectedCount,
              authority: "none"
            })
          );
        } catch {
          // Observer exceptions are contained and never inspected or serialized.
        }
      }
      return decision;
    },
    close: (): void => {
      closed = true;
    }
  });
}

export function routeTask(
  value: RoutingRequest | unknown,
  options: { readonly configuration: RouterConfiguration | unknown; readonly clock: RouterClock }
): RouteDecision {
  return routeTaskWithConfiguration(value, options);
}
