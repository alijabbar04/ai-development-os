import { createHash } from "node:crypto";
import {
  COMPILED_DEFAULT_CONFIGURATION,
  parseApplicationConfiguration,
  type ApplicationConfiguration,
  type ProviderInstanceConfiguration
} from "@ai-dev-os/config";
import {
  createAggregateBudget,
  createBudgetAccount,
  createMoney,
  estimateModelCost,
  toCanonicalJson,
  type BudgetAccountState,
  type ModelCapabilities,
  type TaskCapability,
  type TaskRequirementsInput
} from "@ai-dev-os/domain";
import {
  createProviderCatalog,
  type FreeTierState,
  type ProviderCatalogSnapshot,
  type UnsignedCatalogProvider
} from "@ai-dev-os/provider-catalog";
import type { GatewayInstanceSnapshot } from "@ai-dev-os/provider-gateway";
import {
  parseModelDescriptor,
  parseProviderDescriptor,
  type ModelDescriptor,
  type ProviderDescriptor,
  type ProviderHealth
} from "@ai-dev-os/providers";
import {
  createConservativeTokenEstimator,
  createTokenEstimatorRegistry,
  parseTaskProfileRequest,
  profileTask,
  type TaskProfile,
  type TokenEstimate
} from "@ai-dev-os/profiler";
import {
  fullTaskProfileRequestFixture,
  repositoryIndexFixture,
  taskAuthorityCeilingsFixture,
  taskRequirementsFixture
} from "@ai-dev-os/profiler/testing/fixtures";
import type { TaskProfileRequest } from "@ai-dev-os/profiler";
import {
  DEFAULT_ROUTER_CONFIGURATION,
  createRouterConfiguration,
  type RouterConfiguration
} from "../config.js";
import {
  createCandidatePolicyEvidence,
  createCatalogCandidateEvidence,
  createGatewayCandidateEvidence,
  createRoutingCandidate,
  createRoutingCapacityEvidence,
  createRoutingQuotaEvidence,
  createSecureExecutionEvidence,
  type RoutingCandidateSnapshot
} from "../candidate.js";
import {
  circuitIdentityFingerprint,
  createCircuitBreakerState,
  transitionCircuitBreaker
} from "../circuit.js";
import { createRoutingCostEstimate } from "../budget.js";
import {
  createRoutingRequest,
  type RoutingRequest
} from "../model.js";

export const ROUTER_FIXTURE_EPOCH = "2026-08-05T10:00:00.000Z";
export const ROUTER_FIXTURE_STALE = "2026-08-05T10:30:00.000Z";
export const ROUTER_PROPERTY_SEEDS = Object.freeze([160_401, 160_402, 1_051_921]);
export const ROUTER_LEAK_CANARY = "STAGE16-ROUTER-CANARY-6E2A";

type CompiledThinkerPrompt = NonNullable<TaskProfileRequest["compiledPrompt"]>;

function taskCapabilities(...values: readonly TaskCapability[]): readonly TaskCapability[] {
  return Object.freeze(values);
}

export function fixtureDigest(value: unknown): string {
  return createHash("sha256").update(toCanonicalJson(value), "utf8").digest("hex");
}

export interface CandidateFixtureSpec {
  readonly candidateId: string;
  readonly alias: string;
  readonly locality?: "local" | "cloud";
  readonly providerKind?: "inference" | "coding-agent";
  readonly freeTierState?: FreeTierState;
  readonly healthStatus?: ProviderHealth["status"];
  readonly quotaState?: "unknown" | "available" | "limited" | "exhausted";
  readonly quotaCompleteness?: "complete" | "partial" | "unknown";
  readonly tokensRemaining?: number | null;
  readonly requestsRemaining?: number | null;
  readonly quotaStaleAt?: string;
  readonly capacityState?: "healthy" | "degraded" | "unavailable" | "stale" | "unsupported" | "unknown";
  readonly availableConcurrency?: number | null;
  readonly availableMemoryBytes?: number | null;
  readonly requiredMemoryBytes?: number | null;
  readonly capacityCompleteness?: "complete" | "partial" | "unknown";
  readonly capacityStaleAt?: string;
  readonly policyOutcome?: "allowed" | "denied" | "conditional";
  readonly classification?: "public" | "internal" | "proprietary-source" | "personal" | "secret";
  readonly contextTokens?: number | null;
  readonly maximumOutputTokens?: number | null;
  readonly reasoningCapability?: 1 | 2 | 3 | 4 | 5;
  readonly codingCapability?: 1 | 2 | 3 | 4 | 5;
  readonly costMicrosPerMillion?: number | null;
  readonly expectedLatencyMs?: number | null;
  readonly secureExecution?: "secure-enforcing" | "advisory" | "none";
  readonly userPreference?: "enabled" | "disabled";
  readonly catalogState?: "enabled" | "disabled" | "deprecated";
  readonly modelAvailability?: "available" | "unavailable" | "deprecated";
  readonly estimatorAccuracy?: "proven-upper-bound" | "heuristic";
  readonly gatewayEligibility?: "any" | "verified-free-only";
  readonly catalogRefreshAfter?: string;
  readonly healthCheckedAt?: string;
  readonly quotaObservedAt?: string;
  readonly quotaResetsAt?: string | null;
  readonly capacityObservedAt?: string;
  readonly retainsData?: boolean;
  readonly trainsOnInputs?: boolean;
  readonly networkAccess?: boolean;
  readonly inputLoggingAllowed?: boolean;
  readonly outputLoggingAllowed?: boolean;
  readonly retentionAllowed?: boolean;
  readonly secureVerifiedAt?: string;
}

function evidenceClaim() {
  return Object.freeze({
    state: "verified" as const,
    evidenceUrl: "https://fixture.invalid/evidence",
    note: "Reviewed fixture evidence."
  });
}

function catalogProvider(spec: CandidateFixtureSpec): UnsignedCatalogProvider {
  const providerId = `provider-${spec.candidateId}`;
  const modelId = `model-${spec.candidateId}`;
  const verification = Object.freeze({
    lastVerifiedAt: "2026-08-05T09:00:00.000Z",
    refreshAfter: spec.catalogRefreshAfter ?? "2026-08-06T10:00:00.000Z"
  });
  const freeState = spec.freeTierState ?? "not-free";
  const capabilityIds = [
    "text-input",
    "text-output",
    "streaming",
    "tools",
    "structured-output",
    "image-input",
    "audio-input",
    "video-input",
    "pdf-input",
    "reasoning"
  ] as const;
  return Object.freeze({
    schemaVersion: 1,
    providerId,
    displayName: "Fixture provider",
    aliases: Object.freeze([]),
    transportFamily: "openai-chat-completions",
    adapterProfileId: `profile-${spec.candidateId}`,
    documentation: Object.freeze({
      api: "https://fixture.invalid/api",
      terms: "https://fixture.invalid/terms",
      privacy: "https://fixture.invalid/privacy",
      pricing: "https://fixture.invalid/pricing",
      rateLimits: "https://fixture.invalid/limits"
    }),
    verification,
    authentication: Object.freeze({
      class: "api-key" as const,
      requiredSecretKind: "text" as const,
      delivery: "bearer" as const
    }),
    endpoint: Object.freeze({
      origin: "https://fixture.invalid",
      allowedPaths: Object.freeze(["/v1/chat"]),
      redirectPolicy: "reject" as const
    }),
    dataPractices: Object.freeze({
      regionality: evidenceClaim(),
      retention: evidenceClaim(),
      training: evidenceClaim(),
      storage: evidenceClaim(),
      zeroDataRetention: evidenceClaim()
    }),
    freeTier: Object.freeze({
      state: freeState,
      evidenceUrl: "https://fixture.invalid/free",
      restrictions: Object.freeze([])
    }),
    quota: Object.freeze({
      sourceUrl: "https://fixture.invalid/limits",
      scope: "provider-model" as const,
      semantics: "documented-limit" as const,
      note: "Fixture limit."
    }),
    restrictions: Object.freeze([]),
    state: spec.catalogState ?? "enabled",
    models: Object.freeze([
      Object.freeze({
        schemaVersion: 1,
        modelId,
        displayName: "Fixture model",
        aliases: Object.freeze([]),
        verification,
        freeTier: Object.freeze({
          state: freeState,
          evidenceUrl: "https://fixture.invalid/free",
          restrictions: Object.freeze([])
        }),
        capabilities: Object.freeze(
          capabilityIds.map((id) =>
            Object.freeze({
              id,
              status: id === "audio-input" || id === "video-input" || id === "pdf-input"
                ? "unsupported" as const
                : "supported" as const,
              evidenceUrl: "https://fixture.invalid/model",
              note: "Fixture capability."
            })
          )
        ),
        restrictions: Object.freeze([]),
        limits: Object.freeze({
          contextTokens: spec.contextTokens === undefined ? 131_072 : spec.contextTokens,
          maxOutputTokens:
            spec.maximumOutputTokens === undefined ? 16_384 : spec.maximumOutputTokens,
          evidenceUrl: "https://fixture.invalid/model"
        }),
        state: spec.catalogState ?? "enabled"
      })
    ])
  });
}

export function providerCatalogFixture(specs: readonly CandidateFixtureSpec[]): ProviderCatalogSnapshot {
  return createProviderCatalog({
    schemaVersion: 1,
    catalogId: "stage16-fixture-catalog",
    revision: 1,
    generatedAt: "2026-08-05T09:00:00.000Z",
    providers: Object.freeze(specs.map(catalogProvider))
  });
}

function providerDescriptor(spec: CandidateFixtureSpec): ProviderDescriptor {
  const locality = spec.locality ?? "cloud";
  return parseProviderDescriptor({
    schemaVersion: 1,
    providerId: `provider-${spec.candidateId}`,
    instanceId: `instance-${spec.candidateId}`,
    kind: spec.providerKind ?? "inference",
    displayName: "Fixture instance",
    locality,
    retainsData: spec.retainsData ?? false,
    trainsOnInputs: spec.trainsOnInputs ?? false,
    supportedClassifications: ["public", "internal", "proprietary-source", "personal", "secret"],
    capabilities: {
      streaming: true,
      structuredOutput: true,
      toolCalling: true,
      imageInput: true,
      repositoryEditing: true,
      commandExecution: true,
      networkAccess: spec.networkAccess ?? false,
      resumability: true,
      cancellation: "guaranteed",
      deadlineEnforcement: true,
      usageReporting: true,
      pricingAvailable: spec.costMicrosPerMillion !== null
    }
  });
}

function modelDescriptor(spec: CandidateFixtureSpec): ModelDescriptor {
  const locality = spec.locality ?? "cloud";
  const providerId = `provider-${spec.candidateId}`;
  const modelId = `model-${spec.candidateId}`;
  const rate = spec.costMicrosPerMillion === undefined ? 1_000_000 : spec.costMicrosPerMillion;
  const model: ModelCapabilities = Object.freeze({
    schemaVersion: 1,
    providerId: providerId as ModelCapabilities["providerId"],
    modelId: modelId as ModelCapabilities["modelId"],
    contextWindowTokens: spec.contextTokens ?? 131_072,
    maxOutputTokens: spec.maximumOutputTokens ?? 16_384,
    supportsToolUse: true,
    supportsStructuredOutput: true,
    supportsVision: true,
    locality,
    latencyClass: "standard",
    codingCapability: spec.codingCapability ?? 5,
    reasoningCapability: spec.reasoningCapability ?? 5,
    cost:
      rate === null
        ? null
        : Object.freeze({
            currency: "USD" as const,
            inputMicrosPerMillionTokens: rate,
            outputMicrosPerMillionTokens: rate,
            cachedInputMicrosPerMillionTokens: rate
          })
  });
  return parseModelDescriptor({
    model,
    availability: spec.modelAvailability ?? "available"
  });
}

function gatewaySnapshot(
  spec: CandidateFixtureSpec,
  catalog: ProviderCatalogSnapshot
): GatewayInstanceSnapshot {
  const providerId = `provider-${spec.candidateId}`;
  const modelId = `model-${spec.candidateId}`;
  const provider = catalog.providers.find((item) => item.providerId === providerId)!;
  const model = provider.models.find((item) => item.modelId === modelId)!;
  const base = Object.freeze({
    schemaVersion: 1 as const,
    instanceId: `instance-${spec.candidateId}`,
    contractModelId: modelId,
    catalog: Object.freeze({
      catalogId: catalog.catalogId,
      catalogFingerprint: catalog.fingerprint,
      providerId,
      providerFingerprint: provider.fingerprint,
      modelId,
      modelFingerprint: model.fingerprint,
      adapterProfileId: provider.adapterProfileId,
      lastVerifiedAt: provider.verification.lastVerifiedAt,
      refreshAfter: provider.verification.refreshAfter
    }),
    descriptor: providerDescriptor(spec),
    model: modelDescriptor(spec),
    secretRefFingerprint: fixtureDigest(`secret-reference-${spec.candidateId}`),
    eligibility: spec.gatewayEligibility ?? "any" as const,
    userPreference: spec.userPreference ?? "enabled",
    adapter: Object.freeze({
      packageName: "custom" as const,
      profileId: provider.adapterProfileId,
      version: "fixture-v1"
    })
  });
  return Object.freeze({ ...base, fingerprint: fixtureDigest(base) });
}

function tokenEstimateFixture(
  spec: CandidateFixtureSpec,
  catalog: ProviderCatalogSnapshot,
  compiledPrompt: CompiledThinkerPrompt
): TokenEstimate {
  const provider = catalog.providers.find(
    (item) => item.providerId === `provider-${spec.candidateId}`
  )!;
  const model = provider.models[0]!;
  const binding = Object.freeze({
    providerId: provider.providerId,
    transportProfileId: provider.adapterProfileId,
    contractModelId: model.modelId,
    catalogModelFingerprint: model.fingerprint
  });
  const descriptor = createConservativeTokenEstimator({
    estimatorId: `upper-bound-${spec.candidateId}`,
    applicability: binding,
    accuracy: spec.estimatorAccuracy ?? "proven-upper-bound",
    evidence: Object.freeze({
      kind: spec.estimatorAccuracy === "heuristic"
        ? "heuristic-ratio"
        : "declared-conservative-bound",
      referenceFingerprint: fixtureDigest(`estimator-evidence-${spec.candidateId}`),
      specificationVersion: "fixture-v1",
      framingComplete: spec.estimatorAccuracy !== "heuristic"
    }),
    bytesPerTokenNumerator: 1,
    bytesPerTokenDenominator: 1,
    fixedOverheadTokens: 16,
    safetyMarginBps: 0
  });
  return createTokenEstimatorRegistry([descriptor]).estimate(binding, {
    compiledPrompt,
    toolDefinitionBytes: 0,
    imageMetadataBytes: 0,
    artifactMetadataBytes: 0,
    cachedInputTokens: null,
    outputAllowanceTokens: 4_096,
    reasoningAllowanceTokens: 0
  });
}

export async function routingCandidateFixture(input: {
  readonly spec: CandidateFixtureSpec;
  readonly catalog: ProviderCatalogSnapshot;
  readonly compiledPrompt: CompiledThinkerPrompt;
}): Promise<RoutingCandidateSnapshot> {
  const { spec, catalog, compiledPrompt } = input;
  const gateway = createGatewayCandidateEvidence(gatewaySnapshot(spec, catalog));
  const catalogEvidence = createCatalogCandidateEvidence({
    catalog,
    providerId: gateway.catalog.providerId,
    modelId: gateway.catalog.modelId
  });
  const tokenEstimate = tokenEstimateFixture(spec, catalog, compiledPrompt);
  const model = gateway.model.model;
  const exactCost =
    model.cost === null
      ? null
      : estimateModelCost(model, {
          inputTokens: tokenEstimate.inputTokens,
          outputTokens: tokenEstimate.outputAllowanceTokens,
          cachedInputTokens: 0,
          reasoningTokens: tokenEstimate.reasoningAllowanceTokens
        });
  const costEstimate =
    exactCost === null
      ? createRoutingCostEstimate({
          status: "unknown",
          evidenceFingerprint: fixtureDigest(`unknown-cost-${spec.candidateId}`)
        })
      : createRoutingCostEstimate({
          status: "known",
          currency: exactCost.currency,
          amountMicros: exactCost.amountMicros,
          evidenceFingerprint: fixtureDigest(`exact-cost-${spec.candidateId}`)
        });
  const locality = spec.locality ?? "cloud";
  const quotaState = spec.quotaState ?? "available";
  const quota = createRoutingQuotaEvidence({
    providerInstanceId: gateway.instanceId,
    contractModelId: gateway.contractModelId,
    scopeFingerprint: fixtureDigest(`quota-scope-${spec.candidateId}`),
    state: quotaState,
    completeness:
      spec.quotaCompleteness ?? (quotaState === "unknown" ? "unknown" : "complete"),
    observedAt: spec.quotaObservedAt ?? "2026-08-05T09:59:45.000Z",
    staleAt: spec.quotaStaleAt ?? ROUTER_FIXTURE_STALE,
    resetsAt: spec.quotaResetsAt === undefined
      ? "2026-08-05T12:00:00.000Z"
      : spec.quotaResetsAt,
    dimensions: Object.freeze([
      Object.freeze({
        dimension: "requests" as const,
        remaining:
          spec.requestsRemaining === undefined
            ? quotaState === "unknown" ? null : quotaState === "exhausted" ? 0 : 100
            : spec.requestsRemaining,
        limit: quotaState === "unknown" ? null : 100
      }),
      Object.freeze({
        dimension: "tokens" as const,
        remaining:
          spec.tokensRemaining === undefined
            ? quotaState === "unknown" ? null : quotaState === "exhausted" ? 0 : 1_000_000
            : spec.tokensRemaining,
        limit: quotaState === "unknown" ? null : 1_000_000
      })
    ]),
    sourceFingerprint: fixtureDigest(`quota-source-${spec.candidateId}`),
    correctionFingerprint: null
  });
  const capacityState = spec.capacityState ?? (locality === "local" ? "healthy" : "unknown");
  const capacity = createRoutingCapacityEvidence({
    providerInstanceId: gateway.instanceId,
    contractModelId: gateway.contractModelId,
    scopeFingerprint: fixtureDigest(`capacity-scope-${spec.candidateId}`),
    state: capacityState,
    completeness:
      spec.capacityCompleteness ?? (locality === "local" ? "complete" : "unknown"),
    observedAt: spec.capacityObservedAt ?? "2026-08-05T09:59:45.000Z",
    staleAt: spec.capacityStaleAt ?? ROUTER_FIXTURE_STALE,
    availableConcurrency:
      spec.availableConcurrency === undefined
        ? locality === "local" ? 2 : null
        : spec.availableConcurrency,
    availableMemoryBytes:
      spec.availableMemoryBytes === undefined
        ? locality === "local" ? 8_000_000_000 : null
        : spec.availableMemoryBytes,
    requiredMemoryBytes:
      spec.requiredMemoryBytes === undefined
        ? locality === "local" ? 4_000_000_000 : null
        : spec.requiredMemoryBytes,
    sourceFingerprint: fixtureDigest(`capacity-source-${spec.candidateId}`)
  });
  const classification = spec.classification ?? "internal";
  const policy = createCandidatePolicyEvidence({
    outcome: spec.policyOutcome ?? "allowed",
    decisionFingerprint: fixtureDigest(`policy-decision-${spec.candidateId}`),
    classification,
    requiredLocality: locality === "local" ? "local" : "any",
    inputLoggingAllowed: spec.inputLoggingAllowed ?? false,
    outputLoggingAllowed: spec.outputLoggingAllowed ?? false,
    retentionAllowed: spec.retentionAllowed ?? false,
    authority: "none"
  });
  const health = Object.freeze({
    status: spec.healthStatus ?? "ready",
    checkedAt: spec.healthCheckedAt ?? "2026-08-05T09:59:30.000Z",
    detailCode: null,
    activeOperations: 0
  });
  return createRoutingCandidate({
    candidateId: spec.candidateId,
    gateway,
    catalog: catalogEvidence,
    policy,
    health,
    quota,
    capacity,
    tokenEstimate,
    costEstimate,
    circuit: createCircuitBreakerState({
      providerInstanceId: gateway.instanceId,
      contractModelId: gateway.contractModelId,
      operationClass: "planning"
    }),
    secureExecution: createSecureExecutionEvidence({
      level: spec.secureExecution ?? "none",
      sourceFingerprint: fixtureDigest(`secure-execution-${spec.candidateId}`),
      verifiedAt: spec.secureVerifiedAt ?? "2026-08-05T09:59:00.000Z"
    }),
    expectedLatencyMs: spec.expectedLatencyMs === undefined ? 500 : spec.expectedLatencyMs,
    evidenceObservedAt: "2026-08-05T09:59:00.000Z"
  });
}

export function budgetAccountFixture(options: {
  readonly maximumTokens?: number;
  readonly maximumCostMicros?: number | null;
  readonly currency?: string;
} = {}): BudgetAccountState {
  const base = COMPILED_DEFAULT_CONFIGURATION.budgets.task;
  return createBudgetAccount({
    scope: Object.freeze({ scopeType: "task", scopeId: "stage16-fixture-task" }),
    budget: createAggregateBudget({
      tokens: Object.freeze({
        maxTotalTokens: options.maximumTokens ?? 1_000_000,
        maxInputTokens: null,
        maxOutputTokens: null,
        softMaxTotalTokens: null
      }),
      money:
        options.maximumCostMicros === null
          ? null
          : Object.freeze({
              limit: createMoney(options.currency ?? "USD", options.maximumCostMicros ?? 1_000_000_000),
              softLimit: null
            }),
      time: base.time
    })
  });
}

function applicationConfigurationFixture(
  specs: readonly CandidateFixtureSpec[],
  preferences: {
    readonly preferredLocality?: "local" | "cloud" | "balanced";
    readonly costPriority?: number;
    readonly latencyPriority?: number;
  } = {}
): ApplicationConfiguration {
  const providers: ProviderInstanceConfiguration[] = specs.map((spec) => {
    const locality = spec.locality ?? "cloud";
    return Object.freeze({
      instanceId: `instance-${spec.candidateId}`,
      providerId: `provider-${spec.candidateId}`,
      kind: spec.providerKind ?? "inference",
      enabled: true,
      locality,
      credentialRef: null,
      endpointId: locality === "local" ? `endpoint-${spec.candidateId}` : null,
      extensions: Object.freeze([])
    });
  });
  return parseApplicationConfiguration({
    ...COMPILED_DEFAULT_CONFIGURATION,
    providers,
    localModelEndpoints: specs
      .filter((spec) => (spec.locality ?? "cloud") === "local")
      .map((spec) => ({
        endpointId: `endpoint-${spec.candidateId}`,
        baseUrl: "http://127.0.0.1:11434",
        timeoutMs: 30_000
      })),
    modelAliases: specs.map((spec) => ({
      alias: spec.alias,
      providerInstanceId: `instance-${spec.candidateId}`,
      modelId: `model-${spec.candidateId}`
    })),
    modelPreferences: [
      {
        role: "planning",
        aliases: specs.map((spec) => spec.alias)
      }
    ],
    routing: {
      defaultAlias: specs[0]?.alias ?? null,
      fallbackAliases: specs.slice(1).map((spec) => spec.alias),
      preferLocal: true
    },
    preferences: {
      ...COMPILED_DEFAULT_CONFIGURATION.preferences,
      preferredLocality: preferences.preferredLocality ?? "balanced",
      costPriority: preferences.costPriority ?? 50,
      latencyPriority: preferences.latencyPriority ?? 50
    }
  });
}

export async function routingRequestFixture(options: {
  readonly specs?: readonly CandidateFixtureSpec[];
  readonly routerConfiguration?: RouterConfiguration;
  readonly explicitAlias?: string | null;
  readonly allowFallbacks?: boolean;
  readonly verifiedFreeOnly?: boolean;
  readonly budgetAccount?: BudgetAccountState;
  readonly profile?: TaskProfile;
  readonly surface?: "thinker-inference" | "task-execution";
  readonly halfOpenProbeCandidateId?: string | null;
  readonly requestedAt?: string;
  readonly deadline?: string | null;
  readonly requiredMaximumLatencyMs?: number | null;
  readonly expectedDurationMs?: number;
  readonly role?: "planning" | "implementation" | "review" | "documentation" | "testing" | "explanation";
  readonly operationClass?: string;
  readonly profileShape?: Partial<TaskRequirementsInput>;
  readonly repositoryShape?: "tiny" | "large" | "limit-exhausted";
  readonly preferredLocality?: "local" | "cloud" | "balanced";
  readonly costPriority?: number;
  readonly latencyPriority?: number;
} = {}): Promise<RoutingRequest> {
  const specs = options.specs ?? Object.freeze([
    Object.freeze({
      candidateId: "primary",
      alias: "primary",
      expectedLatencyMs: 600,
      freeTierState: "not-free" as const
    }),
    Object.freeze({
      candidateId: "alternate",
      alias: "alternate",
      expectedLatencyMs: 300,
      freeTierState: "verified" as const
    }),
    Object.freeze({
      candidateId: "local",
      alias: "local",
      locality: "local" as const,
      expectedLatencyMs: 800,
      freeTierState: "not-free" as const
    })
  ]);
  const routerConfiguration = options.routerConfiguration ?? DEFAULT_ROUTER_CONFIGURATION;
  const profileRequest = await fullTaskProfileRequestFixture();
  const shapedRepository =
    options.repositoryShape === undefined || options.repositoryShape === "tiny"
      ? profileRequest.repositoryIndex
      : await repositoryIndexFixture({
          large: options.repositoryShape === "large",
          limitExhausted: options.repositoryShape === "limit-exhausted"
        });
  const shapedProfileRequest = options.profileShape === undefined && options.repositoryShape === undefined
    ? profileRequest
    : parseTaskProfileRequest({
        ...profileRequest,
        requirements: taskRequirementsFixture(options.profileShape),
        authorityCeilings: taskAuthorityCeilingsFixture({
          minimumRisk: "low",
          minimumClassification: "public",
          maximumEditScope: "cross-package",
          requiredCapabilities: Object.freeze(["reasoning"])
        }),
        repositoryIndex: shapedRepository,
        thinkerProposal: null,
        selectedProposalTaskId: null
      });
  const profile = options.profile ?? profileTask(shapedProfileRequest);
  const compiledPrompt = profileRequest.compiledPrompt!;
  const catalog = providerCatalogFixture(specs);
  const candidates = await Promise.all(
    specs.map((spec) => routingCandidateFixture({ spec, catalog, compiledPrompt }))
  );
  return createRoutingRequest({
    requestId: "stage16-route-request",
    requestedAt: options.requestedAt ?? ROUTER_FIXTURE_EPOCH,
    profile,
    configuration: applicationConfigurationFixture(specs, {
      ...(options.preferredLocality === undefined
        ? {}
        : { preferredLocality: options.preferredLocality }),
      ...(options.costPriority === undefined ? {} : { costPriority: options.costPriority }),
      ...(options.latencyPriority === undefined
        ? {}
        : { latencyPriority: options.latencyPriority })
    }),
    routerConfigurationFingerprint: routerConfiguration.fingerprint,
    budgetAccount: options.budgetAccount ?? budgetAccountFixture(),
    candidates: Object.freeze(candidates),
    role: options.role ?? "planning",
    surface: options.surface ?? "thinker-inference",
    operationClass: options.operationClass ?? "planning",
    explicitAlias: options.explicitAlias ?? null,
    allowFallbacks: options.allowFallbacks ?? true,
    verifiedFreeOnly: options.verifiedFreeOnly ?? false,
    deadline: options.deadline === undefined ? "2026-08-05T10:20:00.000Z" : options.deadline,
    requiredMaximumLatencyMs: options.requiredMaximumLatencyMs ?? null,
    expectedDurationMs: options.expectedDurationMs ?? 60_000,
    halfOpenProbeCandidateId: options.halfOpenProbeCandidateId ?? null
  });
}

export const GOLDEN_ROUTING_MATRIX = Object.freeze([
  "planning", "architecture", "implementation", "refactor", "debug", "review", "test",
  "documentation", "explanation", "vision", "low-reasoning", "medium-reasoning",
  "high-reasoning", "extreme-reasoning", "no-edit", "single-file", "multi-file",
  "cross-package", "low-risk", "medium-risk", "high-risk", "critical-risk",
  "tiny-repository", "medium-repository", "large-repository", "limit-exhausted-repository",
  "small-prompt", "large-prompt", "near-limit-prompt", "small-output", "near-limit-output",
  "public", "internal", "proprietary", "personal", "secret", "local-only", "cloud-allowed",
  "redaction-required", "logging-restricted", "retention-restricted", "capable-model",
  "incapable-model", "unknown-model", "healthy", "degraded", "unavailable", "closed",
  "verified-free", "unknown-free", "not-free", "ineligible", "expired-catalog",
  "fresh-quota", "stale-quota", "partial-quota", "unknown-quota", "limited-quota",
  "exhausted-quota", "known-reset", "unknown-reset", "protected-reserve", "known-budget",
  "unknown-cost", "exceeded-budget", "currency-mismatch", "local-capacity",
  "local-concurrency-exhausted", "local-memory-exhausted", "explicit-primary",
  "explicit-alternate", "prefer-local", "prefer-cloud", "prefer-cost", "prefer-latency",
  "prefer-free", "strict-no-fallback", "bounded-fallback", "open-circuit",
  "half-open-circuit", "closed-circuit", "exact-estimate", "upper-bound-estimate",
  "heuristic-estimate", "equal-score-tie", "permuted-input", "no-route"
]);

export interface RoutingGoldenScenario {
  readonly id: string;
  readonly tags: readonly string[];
  readonly specs: readonly CandidateFixtureSpec[];
  readonly profileShape?: Partial<TaskRequirementsInput>;
  readonly repositoryShape?: "tiny" | "large" | "limit-exhausted";
  readonly explicitAlias?: string;
  readonly allowFallbacks?: boolean;
  readonly verifiedFreeOnly?: boolean;
  readonly budgetMode?: "default" | "unmetered" | "exceeded" | "gbp";
  readonly configurationMode?: "default" | "relaxed-unknown" | "tie" | "no-fallback" | "circuit";
  readonly circuitMode?: "closed" | "open" | "half-open-admitted" | "half-open-blocked";
}

export const ROUTING_GOLDEN_SCENARIOS: readonly RoutingGoldenScenario[] = Object.freeze([
  Object.freeze({
    id: "plan-public-free",
    tags: Object.freeze([
      "planning", "low-reasoning", "no-edit", "low-risk", "tiny-repository", "small-prompt",
      "small-output", "public", "cloud-allowed", "healthy", "verified-free", "fresh-quota",
      "known-reset", "known-budget", "prefer-free", "bounded-fallback", "closed-circuit",
      "upper-bound-estimate", "capable-model"
    ]),
    profileShape: Object.freeze({
      kind: "plan", complexity: 1, risk: "low", reasoning: "low", editScope: "none",
      capabilities: taskCapabilities("reasoning", "structured-output"),
      dataClassification: "public", expectedOutputTokens: 512
    }),
    repositoryShape: "tiny",
    specs: Object.freeze([
      Object.freeze({ candidateId: "plan-free", alias: "plan-free", freeTierState: "verified", classification: "public" }),
      Object.freeze({ candidateId: "plan-paid", alias: "plan-paid", freeTierState: "not-free", classification: "public" })
    ])
  }),
  Object.freeze({
    id: "architecture-critical-large",
    tags: Object.freeze([
      "architecture", "extreme-reasoning", "cross-package", "critical-risk", "large-repository",
      "large-prompt", "near-limit-output", "internal", "capable-model", "prefer-latency"
    ]),
    profileShape: Object.freeze({
      kind: "architecture", complexity: 5, risk: "critical", reasoning: "extreme",
      editScope: "cross-package", capabilities: taskCapabilities("reasoning", "repository-read", "code-edit", "structured-output"),
      dataClassification: "internal", expectedOutputTokens: 8_000
    }),
    repositoryShape: "large",
    specs: Object.freeze([
      Object.freeze({ candidateId: "architecture", alias: "architecture", reasoningCapability: 5 })
    ])
  }),
  Object.freeze({
    id: "implementation-proprietary",
    tags: Object.freeze([
      "implementation", "high-reasoning", "multi-file", "high-risk", "medium-repository",
      "near-limit-prompt", "proprietary", "redaction-required", "logging-restricted",
      "retention-restricted", "prefer-cost"
    ]),
    profileShape: Object.freeze({
      kind: "implement", complexity: 4, risk: "high", reasoning: "high", editScope: "multi-file",
      capabilities: taskCapabilities("reasoning", "repository-read", "code-edit", "testing", "structured-output"),
      dataClassification: "proprietary-source", expectedOutputTokens: 4_096
    }),
    specs: Object.freeze([
      Object.freeze({ candidateId: "implementation", alias: "implementation", classification: "proprietary-source" })
    ])
  }),
  Object.freeze({
    id: "refactor-personal-local",
    tags: Object.freeze(["refactor", "medium-reasoning", "single-file", "medium-risk", "personal", "local-only", "prefer-local", "local-capacity"]),
    profileShape: Object.freeze({
      kind: "refactor", complexity: 2, risk: "medium", reasoning: "medium", editScope: "single-file",
      capabilities: taskCapabilities("reasoning", "repository-read", "code-edit", "structured-output"),
      dataClassification: "personal", expectedOutputTokens: 2_048
    }),
    specs: Object.freeze([
      Object.freeze({ candidateId: "refactor-local", alias: "refactor-local", locality: "local", classification: "personal" })
    ])
  }),
  Object.freeze({
    id: "debug-secret-local",
    tags: Object.freeze(["debug", "high-reasoning", "multi-file", "high-risk", "secret", "local-only", "local-memory-exhausted", "no-route"]),
    profileShape: Object.freeze({
      kind: "debug", complexity: 4, risk: "high", reasoning: "high", editScope: "multi-file",
      capabilities: taskCapabilities("reasoning", "repository-read", "code-edit", "testing", "structured-output"),
      dataClassification: "secret", expectedOutputTokens: 4_096
    }),
    specs: Object.freeze([
      Object.freeze({ candidateId: "debug-local", alias: "debug-local", locality: "local", classification: "secret", availableMemoryBytes: 4_100_000_000, requiredMemoryBytes: 4_000_000_000 })
    ])
  }),
  Object.freeze({
    id: "review-hard-filter",
    tags: Object.freeze(["review", "incapable-model", "capable-model", "prefer-cloud", "no-route"]),
    profileShape: Object.freeze({
      kind: "review", complexity: 3, risk: "medium", reasoning: "high", editScope: "none",
      capabilities: taskCapabilities("reasoning", "repository-read", "structured-output"),
      dataClassification: "internal", expectedOutputTokens: 2_048
    }),
    specs: Object.freeze([
      Object.freeze({ candidateId: "review-denied-fast", alias: "review-denied-fast", policyOutcome: "denied", expectedLatencyMs: 1 }),
      Object.freeze({ candidateId: "review-incapable", alias: "review-incapable", reasoningCapability: 1 })
    ])
  }),
  Object.freeze({
    id: "test-limit-exhausted-quota",
    tags: Object.freeze(["test", "limit-exhausted-repository", "exhausted-quota", "unknown-reset", "protected-reserve", "no-route"]),
    profileShape: Object.freeze({
      kind: "test", complexity: 3, risk: "medium", reasoning: "high", editScope: "multi-file",
      capabilities: taskCapabilities("reasoning", "repository-read", "code-edit", "testing", "structured-output"),
      dataClassification: "internal", expectedOutputTokens: 2_048
    }),
    repositoryShape: "limit-exhausted",
    specs: Object.freeze([
      Object.freeze({ candidateId: "test-quota", alias: "test-quota", quotaState: "exhausted", quotaResetsAt: null })
    ])
  }),
  Object.freeze({
    id: "documentation-unknown-cost",
    tags: Object.freeze(["documentation", "unknown-cost", "unknown-model", "not-free", "no-route"]),
    profileShape: Object.freeze({
      kind: "document", complexity: 2, risk: "low", reasoning: "medium", editScope: "single-file",
      capabilities: taskCapabilities("reasoning", "repository-read", "code-edit", "documentation", "structured-output"),
      dataClassification: "internal", expectedOutputTokens: 2_048
    }),
    specs: Object.freeze([
      Object.freeze({ candidateId: "docs-unknown-cost", alias: "docs-unknown-cost", costMicrosPerMillion: null })
    ])
  }),
  Object.freeze({
    id: "explanation-quota-evidence",
    tags: Object.freeze(["explanation", "stale-quota", "partial-quota", "unknown-quota", "limited-quota", "unknown-reset", "no-route"]),
    profileShape: Object.freeze({
      kind: "explain", complexity: 1, risk: "low", reasoning: "medium", editScope: "none",
      capabilities: taskCapabilities("reasoning", "structured-output"),
      dataClassification: "internal", expectedOutputTokens: 1_024
    }),
    specs: Object.freeze([
      Object.freeze({ candidateId: "quota-stale", alias: "quota-stale", quotaStaleAt: "2026-08-05T09:59:59.999Z" }),
      Object.freeze({ candidateId: "quota-partial", alias: "quota-partial", quotaState: "limited", quotaCompleteness: "partial", quotaResetsAt: null }),
      Object.freeze({ candidateId: "quota-unknown", alias: "quota-unknown", quotaState: "unknown", quotaResetsAt: null })
    ])
  }),
  Object.freeze({
    id: "vision-context-limits",
    tags: Object.freeze(["vision", "near-limit-prompt", "near-limit-output", "unknown-model", "no-route"]),
    profileShape: Object.freeze({
      kind: "transform", complexity: 3, risk: "medium", reasoning: "high", editScope: "none",
      capabilities: taskCapabilities("reasoning", "vision", "structured-output"),
      dataClassification: "internal", expectedOutputTokens: 4_096
    }),
    specs: Object.freeze([
      Object.freeze({ candidateId: "vision-context", alias: "vision-context", contextTokens: 9_000, maximumOutputTokens: 4_096 }),
      Object.freeze({ candidateId: "vision-output", alias: "vision-output", maximumOutputTokens: null })
    ])
  }),
  Object.freeze({
    id: "free-catalog-evidence",
    tags: Object.freeze(["unknown-free", "not-free", "ineligible", "expired-catalog", "verified-free", "prefer-free"]),
    verifiedFreeOnly: true,
    specs: Object.freeze([
      Object.freeze({ candidateId: "free-verified", alias: "free-verified", freeTierState: "verified" }),
      Object.freeze({ candidateId: "free-unknown", alias: "free-unknown", freeTierState: "unknown" }),
      Object.freeze({ candidateId: "free-paid", alias: "free-paid", freeTierState: "not-free" }),
      Object.freeze({ candidateId: "free-ineligible", alias: "free-ineligible", freeTierState: "ineligible" }),
      Object.freeze({ candidateId: "free-expired", alias: "free-expired", freeTierState: "verified", catalogRefreshAfter: "2026-08-05T09:59:59.999Z" })
    ])
  }),
  Object.freeze({
    id: "health-matrix",
    tags: Object.freeze(["healthy", "degraded", "unavailable", "closed"]),
    specs: Object.freeze([
      Object.freeze({ candidateId: "health-ready", alias: "health-ready", healthStatus: "ready" }),
      Object.freeze({ candidateId: "health-degraded", alias: "health-degraded", healthStatus: "degraded" }),
      Object.freeze({ candidateId: "health-unavailable", alias: "health-unavailable", healthStatus: "unavailable" }),
      Object.freeze({ candidateId: "health-closed", alias: "health-closed", healthStatus: "closed" })
    ])
  }),
  Object.freeze({
    id: "local-capacity-matrix",
    tags: Object.freeze(["local-capacity", "local-concurrency-exhausted", "local-memory-exhausted", "prefer-local"]),
    specs: Object.freeze([
      Object.freeze({ candidateId: "local-ready", alias: "local-ready", locality: "local" }),
      Object.freeze({ candidateId: "local-busy", alias: "local-busy", locality: "local", availableConcurrency: 1 }),
      Object.freeze({ candidateId: "local-memory", alias: "local-memory", locality: "local", availableMemoryBytes: 4_100_000_000, requiredMemoryBytes: 4_000_000_000 })
    ])
  }),
  Object.freeze({
    id: "explicit-primary",
    tags: Object.freeze(["explicit-primary", "bounded-fallback"]),
    explicitAlias: "primary",
    specs: Object.freeze([
      Object.freeze({ candidateId: "primary", alias: "primary" }),
      Object.freeze({ candidateId: "alternate", alias: "alternate", freeTierState: "verified" })
    ])
  }),
  Object.freeze({
    id: "explicit-alternate-strict",
    tags: Object.freeze(["explicit-alternate", "strict-no-fallback"]),
    explicitAlias: "alternate",
    allowFallbacks: false,
    specs: Object.freeze([
      Object.freeze({ candidateId: "primary", alias: "primary" }),
      Object.freeze({ candidateId: "alternate", alias: "alternate" })
    ])
  }),
  Object.freeze({
    id: "budget-currency-exceeded",
    tags: Object.freeze(["known-budget", "exceeded-budget", "currency-mismatch", "no-route"]),
    budgetMode: "gbp",
    specs: Object.freeze([
      Object.freeze({ candidateId: "currency", alias: "currency" })
    ])
  }),
  Object.freeze({
    id: "heuristic-estimator",
    tags: Object.freeze(["heuristic-estimate", "exact-estimate", "upper-bound-estimate", "no-route"]),
    specs: Object.freeze([
      Object.freeze({ candidateId: "heuristic", alias: "heuristic", estimatorAccuracy: "heuristic" })
    ])
  }),
  Object.freeze({
    id: "tie-and-permutation",
    tags: Object.freeze(["equal-score-tie", "permuted-input"]),
    configurationMode: "tie",
    specs: Object.freeze([
      Object.freeze({ candidateId: "tie-a", alias: "tie-a", expectedLatencyMs: 400 }),
      Object.freeze({ candidateId: "tie-b", alias: "tie-b", expectedLatencyMs: 400 })
    ])
  }),
  Object.freeze({
    id: "circuit-open",
    tags: Object.freeze(["open-circuit", "no-route"]),
    configurationMode: "circuit",
    circuitMode: "open",
    specs: Object.freeze([Object.freeze({ candidateId: "circuit-open", alias: "circuit-open" })])
  }),
  Object.freeze({
    id: "circuit-half-open",
    tags: Object.freeze(["half-open-circuit"]),
    configurationMode: "circuit",
    circuitMode: "half-open-admitted",
    specs: Object.freeze([Object.freeze({ candidateId: "circuit-half", alias: "circuit-half" })])
  })
]);

export function goldenRouterConfiguration(
  scenario: RoutingGoldenScenario
): RouterConfiguration {
  if (scenario.configurationMode === "relaxed-unknown") {
    return createRouterConfiguration({
      hardEvidence: Object.freeze({
        ...DEFAULT_ROUTER_CONFIGURATION.hardEvidence,
        requireKnownQuota: false
      }),
      confidence: Object.freeze({ minimum: 0 })
    });
  }
  if (scenario.configurationMode === "tie") {
    return createRouterConfiguration({
      scoreWeights: Object.freeze({
        ...DEFAULT_ROUTER_CONFIGURATION.scoreWeights,
        "alias-priority": 0
      })
    });
  }
  if (scenario.configurationMode === "no-fallback") {
    return createRouterConfiguration({ fallbacks: Object.freeze({ enabled: false, maximumCount: 0 }) });
  }
  if (scenario.configurationMode === "circuit") {
    return createRouterConfiguration({
      circuitBreaker: Object.freeze({ failureThreshold: 1, coolDownMs: 100, maximumRememberedEvents: 8 })
    });
  }
  return DEFAULT_ROUTER_CONFIGURATION;
}

export async function goldenRoutingRequestFixture(
  scenario: RoutingGoldenScenario
): Promise<RoutingRequest> {
  const routerConfiguration = goldenRouterConfiguration(scenario);
  const budgetAccount = scenario.budgetMode === "unmetered"
    ? budgetAccountFixture({ maximumCostMicros: null })
    : scenario.budgetMode === "exceeded"
      ? budgetAccountFixture({ maximumTokens: 1 })
      : scenario.budgetMode === "gbp"
        ? budgetAccountFixture({ currency: "GBP" })
        : budgetAccountFixture();
  let request = await routingRequestFixture({
    specs: scenario.specs,
    routerConfiguration,
    budgetAccount,
    ...(scenario.explicitAlias === undefined ? {} : { explicitAlias: scenario.explicitAlias }),
    ...(scenario.allowFallbacks === undefined ? {} : { allowFallbacks: scenario.allowFallbacks }),
    ...(scenario.verifiedFreeOnly === undefined
      ? {}
      : { verifiedFreeOnly: scenario.verifiedFreeOnly }),
    ...(scenario.profileShape === undefined ? {} : { profileShape: scenario.profileShape }),
    ...(scenario.repositoryShape === undefined
      ? {}
      : { repositoryShape: scenario.repositoryShape })
  });
  if (scenario.circuitMode !== undefined && scenario.circuitMode !== "closed") {
    const candidate = request.candidates[0]!;
    const identityFingerprint = circuitIdentityFingerprint(candidate.circuit.identity);
    const opened = transitionCircuitBreaker({
      state: candidate.circuit,
      event: Object.freeze({
        eventId: `golden-open-${scenario.id}`,
        occurredAt: "2026-08-05T09:59:58.000Z",
        kind: "retryable-failure" as const,
        identityFingerprint
      }),
      configuration: routerConfiguration
    }).state;
    const circuit = scenario.circuitMode === "open"
      ? opened
      : transitionCircuitBreaker({
          state: opened,
          event: Object.freeze({
            eventId: `golden-probe-${scenario.id}`,
            occurredAt: "2026-08-05T09:59:59.000Z",
            kind: "admit-probe" as const,
            identityFingerprint
          }),
          configuration: routerConfiguration
        }).state;
    const {
      schemaVersion: _candidateSchema,
      healthFingerprint: _healthFingerprint,
      fingerprint: _candidateFingerprint,
      ...candidateBase
    } = candidate;
    const replaced = createRoutingCandidate({ ...candidateBase, circuit });
    const { schemaVersion: _requestSchema, fingerprint: _requestFingerprint, ...requestBase } = request;
    request = createRoutingRequest({
      ...requestBase,
      candidates: Object.freeze([replaced]),
      halfOpenProbeCandidateId: scenario.circuitMode === "half-open-admitted"
        ? replaced.candidateId
        : null
    });
  }
  return request;
}
