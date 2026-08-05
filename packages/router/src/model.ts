import {
  parseBudgetAccountState,
  parseUsageAmounts,
  validation,
  type BudgetAccountState,
  type UsageAmounts
} from "@ai-dev-os/domain";
import {
  parseApplicationConfiguration,
  type ApplicationConfiguration,
  type ModelPreference
} from "@ai-dev-os/config";
import {
  parseTaskProfile,
  parseTokenEstimate,
  type TaskProfile,
  type TokenEstimate
} from "@ai-dev-os/profiler";
import {
  parseRouterConfiguration,
  ROUTER_SCORE_TERM_IDS,
  type RouterConfiguration,
  type RouterScoreTermId
} from "./config.js";
import {
  parseRoutingCandidate,
  type RoutingCandidateSnapshot
} from "./candidate.js";
import {
  parseRoutingCostEstimate,
  type RoutingCostEstimate
} from "./budget.js";
import { HEX_64, SAFE_ID, SAFE_KIND, compareText, digest } from "./shared.js";

const {
  ensureArray,
  ensureBoolean,
  ensureEnum,
  ensureEnumArray,
  ensureExactKeys,
  ensureNullable,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
  ensureString,
  ensureTimestamp,
  fail
} = validation;

export const ROUTER_SCHEMA_VERSION = 1 as const;
export const ROUTING_ALGORITHM_VERSION = 1 as const;
export const ROUTING_SURFACES = Object.freeze(["thinker-inference", "task-execution"] as const);
export type RoutingSurface = (typeof ROUTING_SURFACES)[number];
export type RoutingRole = ModelPreference["role"];

function fingerprint(value: unknown, path: string): string {
  return ensureString(value, path, {
    minLength: 64,
    maxLength: 64,
    pattern: HEX_64,
    patternName: "fingerprint"
  });
}

function literalBoolean<T extends boolean>(value: unknown, path: string, expected: T): T {
  const parsed = ensureBoolean(value, path);
  if (parsed !== expected) fail(path, "unexpected_boolean", `must be ${String(expected)}.`);
  return expected;
}

export interface RoutingRequest {
  readonly schemaVersion: typeof ROUTER_SCHEMA_VERSION;
  readonly requestId: string;
  readonly requestedAt: string;
  readonly profile: TaskProfile;
  readonly configuration: ApplicationConfiguration;
  readonly routerConfigurationFingerprint: string;
  readonly budgetAccount: BudgetAccountState;
  readonly candidates: readonly RoutingCandidateSnapshot[];
  readonly role: RoutingRole;
  readonly surface: RoutingSurface;
  readonly operationClass: string;
  readonly explicitAlias: string | null;
  readonly allowFallbacks: boolean;
  readonly verifiedFreeOnly: boolean;
  readonly deadline: string | null;
  readonly requiredMaximumLatencyMs: number | null;
  readonly expectedDurationMs: number;
  readonly halfOpenProbeCandidateId: string | null;
  readonly fingerprint: string;
}

export function routingRequestFingerprint(value: Omit<RoutingRequest, "fingerprint">): string {
  return digest(value);
}

export function parseRoutingRequest(value: unknown, path = "routingRequest"): RoutingRequest {
  const record = ensureRecord(value, path);
  const keys = [
    "schemaVersion", "requestId", "requestedAt", "profile", "configuration",
    "routerConfigurationFingerprint", "budgetAccount", "candidates", "role", "surface",
    "operationClass", "explicitAlias", "allowFallbacks", "verifiedFreeOnly", "deadline",
    "requiredMaximumLatencyMs", "expectedDurationMs", "halfOpenProbeCandidateId", "fingerprint"
  ] as const;
  ensureExactKeys(record, keys, path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, ROUTER_SCHEMA_VERSION);
  const candidates = ensureArray(record["candidates"], `${path}.candidates`, 10_000)
    .map((raw, index) => parseRoutingCandidate(raw, `${path}.candidates[${index}]`))
    .sort((left, right) => compareText(left.fingerprint, right.fingerprint));
  if (new Set(candidates.map((item) => item.candidateId)).size !== candidates.length) {
    fail(`${path}.candidates`, "duplicate_candidate", "candidate identifiers must be unique.");
  }
  const requestedAt = ensureTimestamp(record["requestedAt"], `${path}.requestedAt`);
  const deadline = ensureNullable(record["deadline"], (raw) =>
    ensureTimestamp(raw, `${path}.deadline`)
  );
  if (deadline !== null && deadline <= requestedAt) {
    fail(`${path}.deadline`, "bad_deadline", "must follow requestedAt.");
  }
  const unsigned = Object.freeze({
    schemaVersion: ROUTER_SCHEMA_VERSION,
    requestId: ensureString(record["requestId"], `${path}.requestId`, {
      maxLength: 128,
      pattern: SAFE_ID,
      patternName: "routing request identifier"
    }),
    requestedAt,
    profile: parseTaskProfile(record["profile"], `${path}.profile`),
    configuration: parseApplicationConfiguration(
      record["configuration"],
      `${path}.configuration`
    ),
    routerConfigurationFingerprint: fingerprint(
      record["routerConfigurationFingerprint"],
      `${path}.routerConfigurationFingerprint`
    ),
    budgetAccount: parseBudgetAccountState(record["budgetAccount"], `${path}.budgetAccount`),
    candidates: Object.freeze(candidates),
    role: ensureEnum(
      record["role"],
      `${path}.role`,
      ["planning", "implementation", "review", "documentation", "testing", "explanation"] as const
    ),
    surface: ensureEnum(record["surface"], `${path}.surface`, ROUTING_SURFACES),
    operationClass: ensureString(record["operationClass"], `${path}.operationClass`, {
      maxLength: 64,
      pattern: SAFE_KIND,
      patternName: "operation class"
    }),
    explicitAlias: ensureNullable(record["explicitAlias"], (raw) =>
      ensureString(raw, `${path}.explicitAlias`, {
        maxLength: 64,
        pattern: SAFE_KIND,
        patternName: "model alias"
      })
    ),
    allowFallbacks: ensureBoolean(record["allowFallbacks"], `${path}.allowFallbacks`),
    verifiedFreeOnly: ensureBoolean(record["verifiedFreeOnly"], `${path}.verifiedFreeOnly`),
    deadline,
    requiredMaximumLatencyMs: ensureNullable(record["requiredMaximumLatencyMs"], (raw) =>
      ensureSafeInteger(raw, `${path}.requiredMaximumLatencyMs`, 0, 10_000_000_000_000)
    ),
    expectedDurationMs: ensureSafeInteger(
      record["expectedDurationMs"],
      `${path}.expectedDurationMs`,
      0,
      10_000_000_000_000
    ),
    halfOpenProbeCandidateId: ensureNullable(record["halfOpenProbeCandidateId"], (raw) =>
      ensureString(raw, `${path}.halfOpenProbeCandidateId`, {
        maxLength: 128,
        pattern: SAFE_ID,
        patternName: "candidate identifier"
      })
    )
  });
  if (
    unsigned.halfOpenProbeCandidateId !== null &&
    !candidates.some((item) => item.candidateId === unsigned.halfOpenProbeCandidateId)
  ) {
    fail(`${path}.halfOpenProbeCandidateId`, "unknown_candidate", "must reference a candidate.");
  }
  const resultFingerprint = fingerprint(record["fingerprint"], `${path}.fingerprint`);
  if (routingRequestFingerprint(unsigned) !== resultFingerprint) {
    fail(`${path}.fingerprint`, "fingerprint_mismatch", "does not match routing request.");
  }
  return Object.freeze({ ...unsigned, fingerprint: resultFingerprint });
}

export function createRoutingRequest(
  value: Omit<RoutingRequest, "schemaVersion" | "fingerprint">
): RoutingRequest {
  const unsigned = Object.freeze({
    schemaVersion: ROUTER_SCHEMA_VERSION,
    ...value,
    candidates: Object.freeze([...value.candidates].sort((left, right) =>
      compareText(left.fingerprint, right.fingerprint)
    ))
  });
  return parseRoutingRequest({ ...unsigned, fingerprint: routingRequestFingerprint(unsigned) });
}

export const ROUTE_REJECTION_CODES = Object.freeze([
  "CONFIGURATION_FINGERPRINT_MISMATCH",
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_DISABLED",
  "USER_DISABLED",
  "CONFIGURATION_IDENTITY_MISMATCH",
  "EXPLICIT_ALIAS_MISMATCH",
  "ALIAS_NOT_CONFIGURED",
  "WRONG_PROVIDER_KIND",
  "ADAPTER_PROFILE_MISMATCH",
  "POLICY_DENIED",
  "POLICY_CONDITIONAL",
  "CLASSIFICATION_MISMATCH",
  "CLASSIFICATION_UNSUPPORTED",
  "LOCALITY_REQUIRED",
  "CLOUD_FORBIDDEN",
  "RETENTION_INCOMPATIBLE",
  "TRAINING_INCOMPATIBLE",
  "LOGGING_INCOMPATIBLE",
  "NETWORK_INCOMPATIBLE",
  "CATALOG_PROVIDER_DISABLED",
  "CATALOG_MODEL_DISABLED",
  "CATALOG_EXPIRED",
  "FREE_TIER_NOT_VERIFIED",
  "MODEL_UNAVAILABLE",
  "CAPABILITY_UNSUPPORTED",
  "CAPABILITY_UNKNOWN",
  "CODING_RATING_INSUFFICIENT",
  "REASONING_RATING_INSUFFICIENT",
  "ESTIMATOR_IDENTITY_MISMATCH",
  "ESTIMATOR_ACCURACY_INSUFFICIENT",
  "CONTEXT_LIMIT_UNKNOWN",
  "CONTEXT_LIMIT_EXCEEDED",
  "OUTPUT_LIMIT_UNKNOWN",
  "OUTPUT_LIMIT_EXCEEDED",
  "HEALTH_STALE",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_CLOSED",
  "QUOTA_SCOPE_MISMATCH",
  "QUOTA_STALE",
  "QUOTA_UNKNOWN",
  "QUOTA_PARTIAL",
  "QUOTA_EXHAUSTED",
  "QUOTA_INSUFFICIENT",
  "CAPACITY_SCOPE_MISMATCH",
  "CAPACITY_STALE",
  "CAPACITY_UNKNOWN",
  "CAPACITY_INSUFFICIENT",
  "CIRCUIT_OPEN",
  "HALF_OPEN_PROBE_NOT_ADMITTED",
  "SECURE_EXECUTION_REQUIRED",
  "COST_UNKNOWN",
  "COST_EVIDENCE_MISMATCH",
  "CURRENCY_MISMATCH",
  "BUDGET_INSUFFICIENT",
  "LATENCY_INCOMPATIBLE",
  "DEADLINE_INCOMPATIBLE",
  "CONFIDENCE_BELOW_MINIMUM"
] as const);
export type RouteRejectionCode = (typeof ROUTE_REJECTION_CODES)[number];

export interface RouteRejection {
  readonly candidateId: string;
  readonly candidateFingerprint: string;
  readonly codes: readonly RouteRejectionCode[];
}

export interface RouteScoreComponent {
  readonly term: RouterScoreTermId;
  readonly value: number;
  readonly weight: number;
  readonly weightedValue: number;
  readonly evidenceCode: string;
}

export interface RouteReservationQuote {
  readonly planFingerprint: string;
  readonly quoteFingerprint: string;
  readonly estimate: UsageAmounts;
  readonly durableMutationPerformed: false;
}

export interface RouteChoice {
  readonly rank: number;
  readonly candidateId: string;
  readonly candidateFingerprint: string;
  readonly providerInstanceId: string;
  readonly providerKind: "inference" | "coding-agent";
  readonly contractModelId: string;
  readonly selectedAlias: string | null;
  readonly catalogProviderFingerprint: string;
  readonly catalogModelFingerprint: string;
  readonly gatewayFingerprint: string;
  readonly tokenEstimate: TokenEstimate;
  readonly costEstimate: RoutingCostEstimate;
  readonly reservation: RouteReservationQuote;
  readonly scoreComponents: readonly RouteScoreComponent[];
  readonly totalScore: number;
  readonly confidence: number;
  readonly lowerRankReason: string | null;
}

export interface RouteConfidence {
  readonly score: number;
  readonly completeness: "complete" | "partial" | "unknown";
  readonly reasonCodes: readonly string[];
}

export interface RouteDecision {
  readonly schemaVersion: typeof ROUTER_SCHEMA_VERSION;
  readonly algorithmVersion: typeof ROUTING_ALGORITHM_VERSION;
  readonly decidedAt: string;
  readonly outcome: "routed" | "no-route";
  readonly requestFingerprint: string;
  readonly profileFingerprint: string;
  readonly applicationConfigurationFingerprint: string;
  readonly routerConfigurationFingerprint: string;
  readonly budgetAccountFingerprint: string;
  readonly evidenceFingerprints: readonly string[];
  readonly primary: RouteChoice | null;
  readonly fallbacks: readonly RouteChoice[];
  readonly feasible: readonly RouteChoice[];
  readonly rejections: readonly RouteRejection[];
  readonly confidence: RouteConfidence;
  readonly validUntil: string;
  readonly revalidationRequirements: readonly string[];
  readonly restrictions: {
    readonly classification: TaskProfile["effective"]["dataClassification"];
    readonly requiredLocality: "local" | "any";
    readonly approvalRequired: boolean;
    readonly redactionsRequiredBeforeDisclosure: readonly (
      "personal-data" | "proprietary-identifiers" | "secrets"
    )[];
    readonly logRetentionAllowed: boolean;
    readonly artifactPersistenceAllowed: boolean;
    readonly inputLoggingAllowed: boolean;
    readonly outputLoggingAllowed: boolean;
    readonly retentionAllowed: boolean;
  };
  readonly authority: "none";
  readonly grantsAuthority: false;
  readonly requiresExecutionTimeRevalidation: true;
  readonly providerInvocationPerformed: false;
  readonly durableMutationPerformed: false;
  readonly fingerprint: string;
}

function parseScoreComponent(value: unknown, path: string): RouteScoreComponent {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["term", "value", "weight", "weightedValue", "evidenceCode"], path);
  const term = ensureEnum(record["term"], `${path}.term`, ROUTER_SCORE_TERM_IDS);
  const scoreValue = ensureSafeInteger(record["value"], `${path}.value`, -1_000, 1_000);
  const weight = ensureSafeInteger(record["weight"], `${path}.weight`, 0, 1_000);
  const weightedValue = ensureSafeInteger(
    record["weightedValue"],
    `${path}.weightedValue`,
    -1_000_000,
    1_000_000
  );
  if (scoreValue * weight !== weightedValue) {
    fail(`${path}.weightedValue`, "score_mismatch", "must equal value times weight.");
  }
  return Object.freeze({
    term,
    value: scoreValue,
    weight,
    weightedValue,
    evidenceCode: ensureString(record["evidenceCode"], `${path}.evidenceCode`, {
      maxLength: 64,
      pattern: SAFE_KIND,
      patternName: "score evidence code"
    })
  });
}

function parseReservationQuote(value: unknown, path: string): RouteReservationQuote {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    ["planFingerprint", "quoteFingerprint", "estimate", "durableMutationPerformed"],
    path
  );
  return Object.freeze({
    planFingerprint: fingerprint(record["planFingerprint"], `${path}.planFingerprint`),
    quoteFingerprint: fingerprint(record["quoteFingerprint"], `${path}.quoteFingerprint`),
    estimate: parseUsageAmounts(record["estimate"], `${path}.estimate`),
    durableMutationPerformed: literalBoolean(
      record["durableMutationPerformed"],
      `${path}.durableMutationPerformed`,
      false
    )
  });
}

function parseChoice(value: unknown, path: string): RouteChoice {
  const record = ensureRecord(value, path);
  const keys = [
    "rank", "candidateId", "candidateFingerprint", "providerInstanceId", "providerKind",
    "contractModelId", "selectedAlias", "catalogProviderFingerprint", "catalogModelFingerprint",
    "gatewayFingerprint", "tokenEstimate", "costEstimate", "reservation", "scoreComponents",
    "totalScore", "confidence", "lowerRankReason"
  ] as const;
  ensureExactKeys(record, keys, path);
  const components = ensureArray(
    record["scoreComponents"],
    `${path}.scoreComponents`,
    ROUTER_SCORE_TERM_IDS.length
  ).map((raw, index) => parseScoreComponent(raw, `${path}.scoreComponents[${index}]`));
  if (
    components.length !== ROUTER_SCORE_TERM_IDS.length ||
    components.some((component, index) => component.term !== ROUTER_SCORE_TERM_IDS[index])
  ) {
    fail(`${path}.scoreComponents`, "score_terms_mismatch", "must contain every score term in order.");
  }
  const totalScore = ensureSafeInteger(
    record["totalScore"],
    `${path}.totalScore`,
    -Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER
  );
  if (components.reduce((total, component) => total + component.weightedValue, 0) !== totalScore) {
    fail(`${path}.totalScore`, "score_mismatch", "must equal component total.");
  }
  return Object.freeze({
    rank: ensureSafeInteger(record["rank"], `${path}.rank`, 1, 10_000),
    candidateId: ensureString(record["candidateId"], `${path}.candidateId`, {
      maxLength: 128,
      pattern: SAFE_ID,
      patternName: "candidate identifier"
    }),
    candidateFingerprint: fingerprint(record["candidateFingerprint"], `${path}.candidateFingerprint`),
    providerInstanceId: ensureString(record["providerInstanceId"], `${path}.providerInstanceId`, {
      maxLength: 128,
      pattern: SAFE_ID,
      patternName: "provider instance identifier"
    }),
    providerKind: ensureEnum(
      record["providerKind"],
      `${path}.providerKind`,
      ["inference", "coding-agent"] as const
    ),
    contractModelId: ensureString(record["contractModelId"], `${path}.contractModelId`, {
      maxLength: 128,
      pattern: SAFE_ID,
      patternName: "contract model identifier"
    }),
    selectedAlias: ensureNullable(record["selectedAlias"], (raw) =>
      ensureString(raw, `${path}.selectedAlias`, {
        maxLength: 64,
        pattern: SAFE_KIND,
        patternName: "model alias"
      })
    ),
    catalogProviderFingerprint: fingerprint(
      record["catalogProviderFingerprint"],
      `${path}.catalogProviderFingerprint`
    ),
    catalogModelFingerprint: fingerprint(
      record["catalogModelFingerprint"],
      `${path}.catalogModelFingerprint`
    ),
    gatewayFingerprint: fingerprint(record["gatewayFingerprint"], `${path}.gatewayFingerprint`),
    tokenEstimate: parseTokenEstimate(record["tokenEstimate"], `${path}.tokenEstimate`),
    costEstimate: parseRoutingCostEstimate(record["costEstimate"], `${path}.costEstimate`),
    reservation: parseReservationQuote(record["reservation"], `${path}.reservation`),
    scoreComponents: Object.freeze(components),
    totalScore,
    confidence: ensureSafeInteger(record["confidence"], `${path}.confidence`, 0, 1_000),
    lowerRankReason: ensureNullable(record["lowerRankReason"], (raw) =>
      ensureString(raw, `${path}.lowerRankReason`, {
        maxLength: 64,
        pattern: SAFE_KIND,
        patternName: "rank reason"
      })
    )
  });
}

function parseRejection(value: unknown, path: string): RouteRejection {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["candidateId", "candidateFingerprint", "codes"], path);
  return Object.freeze({
    candidateId: ensureString(record["candidateId"], `${path}.candidateId`, {
      maxLength: 128,
      pattern: SAFE_ID,
      patternName: "candidate identifier"
    }),
    candidateFingerprint: fingerprint(record["candidateFingerprint"], `${path}.candidateFingerprint`),
    codes: Object.freeze(
      [...ensureEnumArray(
        record["codes"],
        `${path}.codes`,
        ROUTE_REJECTION_CODES,
        ROUTE_REJECTION_CODES.length
      )].sort(compareText)
    )
  });
}

function parseConfidence(value: unknown, path: string): RouteConfidence {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["score", "completeness", "reasonCodes"], path);
  const reasonCodes = ensureArray(record["reasonCodes"], `${path}.reasonCodes`, 128)
    .map((raw, index) =>
      ensureString(raw, `${path}.reasonCodes[${index}]`, {
        maxLength: 64,
        pattern: SAFE_KIND,
        patternName: "confidence reason"
      })
    )
    .sort(compareText);
  if (new Set(reasonCodes).size !== reasonCodes.length) {
    fail(`${path}.reasonCodes`, "duplicate_reason", "confidence reasons must be unique.");
  }
  return Object.freeze({
    score: ensureSafeInteger(record["score"], `${path}.score`, 0, 1_000),
    completeness: ensureEnum(
      record["completeness"],
      `${path}.completeness`,
      ["complete", "partial", "unknown"] as const
    ),
    reasonCodes: Object.freeze(reasonCodes)
  });
}

export function routeDecisionFingerprint(value: Omit<RouteDecision, "fingerprint">): string {
  return digest(value);
}

export function parseRouteDecision(value: unknown, path = "routeDecision"): RouteDecision {
  const record = ensureRecord(value, path);
  const keys = [
    "schemaVersion", "algorithmVersion", "decidedAt", "outcome", "requestFingerprint",
    "profileFingerprint", "applicationConfigurationFingerprint", "routerConfigurationFingerprint",
    "budgetAccountFingerprint", "evidenceFingerprints", "primary", "fallbacks", "feasible",
    "rejections", "confidence", "validUntil", "revalidationRequirements", "restrictions",
    "authority", "grantsAuthority", "requiresExecutionTimeRevalidation", "providerInvocationPerformed",
    "durableMutationPerformed", "fingerprint"
  ] as const;
  ensureExactKeys(record, keys, path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, ROUTER_SCHEMA_VERSION);
  ensureSchemaVersion(record["algorithmVersion"], `${path}.algorithmVersion`, ROUTING_ALGORITHM_VERSION);
  const evidenceFingerprints = ensureArray(
    record["evidenceFingerprints"],
    `${path}.evidenceFingerprints`,
    10_000
  )
    .map((raw, index) => fingerprint(raw, `${path}.evidenceFingerprints[${index}]`))
    .sort(compareText);
  if (new Set(evidenceFingerprints).size !== evidenceFingerprints.length) {
    fail(`${path}.evidenceFingerprints`, "duplicate_fingerprint", "evidence fingerprints must be unique.");
  }
  const fallbacks = ensureArray(record["fallbacks"], `${path}.fallbacks`, 16).map((raw, index) =>
    parseChoice(raw, `${path}.fallbacks[${index}]`)
  );
  const feasible = ensureArray(record["feasible"], `${path}.feasible`, 10_000).map((raw, index) =>
    parseChoice(raw, `${path}.feasible[${index}]`)
  );
  const rejections = ensureArray(record["rejections"], `${path}.rejections`, 100_000)
    .map((raw, index) => parseRejection(raw, `${path}.rejections[${index}]`))
    .sort((left, right) => compareText(left.candidateFingerprint, right.candidateFingerprint));
  const restrictions = ensureRecord(record["restrictions"], `${path}.restrictions`);
  ensureExactKeys(
    restrictions,
    [
      "classification", "requiredLocality", "approvalRequired",
      "redactionsRequiredBeforeDisclosure", "logRetentionAllowed",
      "artifactPersistenceAllowed", "inputLoggingAllowed", "outputLoggingAllowed",
      "retentionAllowed"
    ],
    `${path}.restrictions`
  );
  const revalidationRequirements = ensureArray(
    record["revalidationRequirements"],
    `${path}.revalidationRequirements`,
    64
  )
    .map((raw, index) =>
      ensureString(raw, `${path}.revalidationRequirements[${index}]`, {
        maxLength: 64,
        pattern: SAFE_KIND,
        patternName: "revalidation requirement"
      })
    )
    .sort(compareText);
  const unsigned = Object.freeze({
    schemaVersion: ROUTER_SCHEMA_VERSION,
    algorithmVersion: ROUTING_ALGORITHM_VERSION,
    decidedAt: ensureTimestamp(record["decidedAt"], `${path}.decidedAt`),
    outcome: ensureEnum(record["outcome"], `${path}.outcome`, ["routed", "no-route"] as const),
    requestFingerprint: fingerprint(record["requestFingerprint"], `${path}.requestFingerprint`),
    profileFingerprint: fingerprint(record["profileFingerprint"], `${path}.profileFingerprint`),
    applicationConfigurationFingerprint: fingerprint(
      record["applicationConfigurationFingerprint"],
      `${path}.applicationConfigurationFingerprint`
    ),
    routerConfigurationFingerprint: fingerprint(
      record["routerConfigurationFingerprint"],
      `${path}.routerConfigurationFingerprint`
    ),
    budgetAccountFingerprint: fingerprint(
      record["budgetAccountFingerprint"],
      `${path}.budgetAccountFingerprint`
    ),
    evidenceFingerprints: Object.freeze(evidenceFingerprints),
    primary: ensureNullable(record["primary"], (raw) => parseChoice(raw, `${path}.primary`)),
    fallbacks: Object.freeze(fallbacks),
    feasible: Object.freeze(feasible),
    rejections: Object.freeze(rejections),
    confidence: parseConfidence(record["confidence"], `${path}.confidence`),
    validUntil: ensureTimestamp(record["validUntil"], `${path}.validUntil`),
    revalidationRequirements: Object.freeze(revalidationRequirements),
    restrictions: Object.freeze({
      classification: ensureEnum(
        restrictions["classification"],
        `${path}.restrictions.classification`,
        ["public", "internal", "proprietary-source", "personal", "secret"] as const
      ),
      requiredLocality: ensureEnum(
        restrictions["requiredLocality"],
        `${path}.restrictions.requiredLocality`,
        ["local", "any"] as const
      ),
      approvalRequired: ensureBoolean(
        restrictions["approvalRequired"],
        `${path}.restrictions.approvalRequired`
      ),
      redactionsRequiredBeforeDisclosure: Object.freeze(
        ensureEnumArray(
          restrictions["redactionsRequiredBeforeDisclosure"],
          `${path}.restrictions.redactionsRequiredBeforeDisclosure`,
          ["personal-data", "proprietary-identifiers", "secrets"] as const,
          3
        )
      ),
      logRetentionAllowed: ensureBoolean(
        restrictions["logRetentionAllowed"],
        `${path}.restrictions.logRetentionAllowed`
      ),
      artifactPersistenceAllowed: ensureBoolean(
        restrictions["artifactPersistenceAllowed"],
        `${path}.restrictions.artifactPersistenceAllowed`
      ),
      inputLoggingAllowed: ensureBoolean(
        restrictions["inputLoggingAllowed"],
        `${path}.restrictions.inputLoggingAllowed`
      ),
      outputLoggingAllowed: ensureBoolean(
        restrictions["outputLoggingAllowed"],
        `${path}.restrictions.outputLoggingAllowed`
      ),
      retentionAllowed: ensureBoolean(
        restrictions["retentionAllowed"],
        `${path}.restrictions.retentionAllowed`
      )
    }),
    authority: ensureEnum(record["authority"], `${path}.authority`, ["none"] as const),
    grantsAuthority: literalBoolean(record["grantsAuthority"], `${path}.grantsAuthority`, false),
    requiresExecutionTimeRevalidation: literalBoolean(
      record["requiresExecutionTimeRevalidation"],
      `${path}.requiresExecutionTimeRevalidation`,
      true
    ),
    providerInvocationPerformed: literalBoolean(
      record["providerInvocationPerformed"],
      `${path}.providerInvocationPerformed`,
      false
    ),
    durableMutationPerformed: literalBoolean(
      record["durableMutationPerformed"],
      `${path}.durableMutationPerformed`,
      false
    )
  });
  if ((unsigned.outcome === "routed") !== (unsigned.primary !== null)) {
    fail(path, "outcome_mismatch", "routed outcomes require a primary and no-route forbids one.");
  }
  const resultFingerprint = fingerprint(record["fingerprint"], `${path}.fingerprint`);
  if (routeDecisionFingerprint(unsigned) !== resultFingerprint) {
    fail(`${path}.fingerprint`, "fingerprint_mismatch", "does not match route decision.");
  }
  return Object.freeze({ ...unsigned, fingerprint: resultFingerprint });
}

export interface RouteDecisionSummary {
  readonly outcome: RouteDecision["outcome"];
  readonly decisionFingerprint: string;
  readonly profileFingerprint: string;
  readonly primaryCandidateId: string | null;
  readonly primaryAlias: string | null;
  readonly fallbackCount: number;
  readonly feasibleCount: number;
  readonly rejectedCount: number;
  readonly confidence: number;
  readonly validUntil: string;
  readonly authority: "none";
  readonly requiresExecutionTimeRevalidation: true;
}

export function summarizeRouteDecision(value: RouteDecision | unknown): RouteDecisionSummary {
  const decision = parseRouteDecision(value);
  return Object.freeze({
    outcome: decision.outcome,
    decisionFingerprint: decision.fingerprint,
    profileFingerprint: decision.profileFingerprint,
    primaryCandidateId: decision.primary?.candidateId ?? null,
    primaryAlias: decision.primary?.selectedAlias ?? null,
    fallbackCount: decision.fallbacks.length,
    feasibleCount: decision.feasible.length,
    rejectedCount: decision.rejections.length,
    confidence: decision.confidence.score,
    validUntil: decision.validUntil,
    authority: "none",
    requiresExecutionTimeRevalidation: true
  });
}

export interface RouteDecisionExplanation {
  readonly outcome: RouteDecision["outcome"];
  readonly decisionFingerprint: string;
  readonly primary: string | null;
  readonly fallbackIds: readonly string[];
  readonly rejectionCodes: readonly RouteRejectionCode[];
  readonly confidenceReasons: readonly string[];
  readonly statement: "ROUTE_GRANTS_NO_AUTHORITY";
}

export function explainRouteDecision(value: RouteDecision | unknown): RouteDecisionExplanation {
  const decision = parseRouteDecision(value);
  const rejectionCodes = Object.freeze(
    [...new Set(decision.rejections.flatMap((item) => item.codes))].sort(compareText)
  );
  return Object.freeze({
    outcome: decision.outcome,
    decisionFingerprint: decision.fingerprint,
    primary: decision.primary?.candidateId ?? null,
    fallbackIds: Object.freeze(decision.fallbacks.map((item) => item.candidateId)),
    rejectionCodes,
    confidenceReasons: decision.confidence.reasonCodes,
    statement: "ROUTE_GRANTS_NO_AUTHORITY"
  });
}

export function applicationConfigurationFingerprint(configuration: ApplicationConfiguration): string {
  return digest(parseApplicationConfiguration(configuration));
}

export function assertRouterConfigurationBinding(
  request: RoutingRequest,
  configuration: RouterConfiguration
): void {
  const parsed = parseRouterConfiguration(configuration);
  if (request.routerConfigurationFingerprint !== parsed.fingerprint) {
    fail(
      "routingRequest.routerConfigurationFingerprint",
      "configuration_binding_mismatch",
      "does not match the active router configuration."
    );
  }
}
