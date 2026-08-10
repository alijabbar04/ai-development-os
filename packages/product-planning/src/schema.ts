import { createHash } from "node:crypto";
import {
  canonicalizeJson,
  toCanonicalJson,
  validation,
  type JsonValue,
} from "@ai-dev-os/domain";
import { PROFILE_OWNERSHIP_CLASSES, parseNormalizedUsage, type NormalizedUsage, type WorkspaceIdentity } from "@ai-dev-os/scheduler";
import { TaskGraph } from "@ai-dev-os/task-graph";
import { PlanningError } from "./errors.js";
import {
  EXECUTABLE_DISPOSITIONS,
  FINDING_KINDS,
  PLAN_RISKS,
  PLANNING_PHASE_KINDS,
  PLANNING_PHASE_STATUSES,
  PLANNING_EVENT_TYPES,
  PRODUCT_PLANNING_SCHEMA_VERSION,
  REQUIREMENT_CATEGORIES,
  SCOPE_AUTHORITIES,
  SCOPE_DISPOSITIONS,
  SEVERITIES,
  type ApproveSpecificationInput,
  type BudgetReconciliationIntent,
  type BudgetReservationIntent,
  type CandidateRequirement,
  type CandidateRequirementDraft,
  type DeduplicatedRequirement,
  type DissentDraft,
  type DissentItem,
  type FeasibilityFinding,
  type FeasibilityFindingDraft,
  type PlanningBudgetPreview,
  type PlanningContribution,
  type PlanningContributionDraft,
  type PlanningContributionEvidence,
  type PlanningEvent,
  type PlanningLimits,
  type PlanningPhase,
  type PlanningSpecialist,
  type ProductIntent,
  type ProductIntentInput,
  type ProductPlanSnapshot,
  type ProductPlanningConfiguration,
  type ProductPlanningConfigurationInput,
  type ProductSpecification,
  type ProductSpecificationRequirement,
  type RequirementProvenance,
  type RequirementTaskCoverage,
  type ScopeActor,
  type ScopeDecision,
  type ScopeDecisionInput,
  type TrustedPlanningRoute,
  type UnresolvedQuestion,
  type UnresolvedQuestionDraft,
} from "./contracts.js";

const {
  ensureArray,
  ensureBoolean,
  ensureEnum,
  ensureExactKeys,
  ensureNullable,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
  ensureString,
  ensureTimestamp,
} = validation;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const REVISION = /^[A-Fa-f0-9]{7,64}$/;

export const MAXIMUM_PLANNING_LIMITS: PlanningLimits = Object.freeze({
  maximumPhases: 16,
  maximumSpecialists: 12,
  maximumContributions: 64,
  maximumCandidateRequirements: 1_000,
  maximumProviderCalls: 64,
  maximumTotalTokens: 4_000_000,
  maximumMoneyMicros: 100_000_000_000,
  maximumContributionBytes: 4 * 1_024 * 1_024,
  maximumTotalOutputBytes: 32 * 1_024 * 1_024,
  maximumWallTimeMs: 24 * 60 * 60_000,
  maximumSynthesisRounds: 3,
  maximumRetriesPerPhase: 4,
  maximumGraphNodes: 2_000,
  maximumGraphDepth: 64,
  maximumDependencyFanOut: 64,
});

export const DEFAULT_PLANNING_LIMITS: PlanningLimits = Object.freeze({
  maximumPhases: 16,
  maximumSpecialists: 12,
  maximumContributions: 64,
  maximumCandidateRequirements: 1_000,
  maximumProviderCalls: 64,
  maximumTotalTokens: 4_000_000,
  maximumMoneyMicros: 100_000_000_000,
  maximumContributionBytes: 4 * 1_024 * 1_024,
  maximumTotalOutputBytes: 32 * 1_024 * 1_024,
  maximumWallTimeMs: 24 * 60 * 60_000,
  maximumSynthesisRounds: 3,
  maximumRetriesPerPhase: 4,
  maximumGraphNodes: 2_000,
  maximumGraphDepth: 64,
  maximumDependencyFanOut: 64,
});

function exactId(value: unknown, path: string): string {
  return ensureString(value, path, { maxLength: 128, pattern: ID, patternName: "identifier" });
}

function fingerprint(value: unknown, path: string): string {
  return ensureString(value, path, { minLength: 64, maxLength: 64, pattern: FINGERPRINT, patternName: "sha-256 fingerprint" });
}

function normalizedText(value: unknown, path: string, maximum = 4_000): string {
  const text = ensureString(value, path, { maxLength: maximum }).normalize("NFKC").trim().replace(/\s+/g, " ");
  if (text.length === 0) throw new PlanningError("INVALID_INPUT", "Planning text cannot be empty.", { path });
  return text;
}

function stringList(value: unknown, path: string, maximumItems: number, maximumText = 4_000): readonly string[] {
  const items = ensureArray(value, path, maximumItems).map((item, index) => normalizedText(item, `${path}[${index}]`, maximumText));
  const keys = new Set(items.map((item) => item.toLocaleLowerCase("en-US")));
  if (keys.size !== items.length) throw new PlanningError("INVALID_INPUT", "Planning text lists cannot contain duplicates.", { path });
  return Object.freeze(items);
}

export function planningDigest(value: unknown): string {
  return createHash("sha256").update(toCanonicalJson(canonicalizeJson(value, "planningDigest"))).digest("hex");
}

export function stablePlanningId(prefix: string, ...parts: readonly string[]): string {
  const digest = createHash("sha256")
    .update(toCanonicalJson(canonicalizeJson([...parts], "stablePlanningId.parts")))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}:${digest}`;
}

/** Locale-independent UTF-16 code-unit ordering for persisted projections. */
export function comparePlanningText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeRequirementKey(value: unknown, path = "requirementKey"): string {
  const text = normalizedText(value, path, 512).toLocaleLowerCase("en-US");
  const key = text.replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
  if (key.length === 0) throw new PlanningError("INVALID_INPUT", "Requirement key contains no semantic text.", { path });
  return key;
}

function parseLimits(value: unknown, path: string): PlanningLimits {
  const input = ensureRecord(value, path);
  const keys = Object.keys(MAXIMUM_PLANNING_LIMITS) as Array<keyof PlanningLimits>;
  ensureExactKeys(input, keys, path);
  const result: Record<string, number> = {};
  for (const key of keys) {
    result[key] = ensureSafeInteger(input[key], `${path}.${key}`, 1, MAXIMUM_PLANNING_LIMITS[key]);
  }
  if (result["maximumSpecialists"]! + 3 > result["maximumPhases"]!) {
    throw new PlanningError("INVALID_INPUT", "Specialist and fixed phase limits are contradictory.");
  }
  return Object.freeze(result) as unknown as PlanningLimits;
}

function independenceKey(route: Omit<TrustedPlanningRoute, "independenceKey">): string {
  return planningDigest({
    providerId: route.providerId,
    modelId: route.modelId,
    profileId: route.profileId,
    ownership: route.ownership,
    configurationFingerprint: route.configurationFingerprint,
  });
}

export function parseTrustedPlanningRoute(value: unknown, path = "route"): TrustedPlanningRoute {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, ["routeKey", "providerId", "modelId", "profileId", "ownership", "configurationFingerprint", "independenceKey"], path);
  const route = Object.freeze({
    routeKey: exactId(input["routeKey"], `${path}.routeKey`),
    providerId: exactId(input["providerId"], `${path}.providerId`),
    modelId: exactId(input["modelId"], `${path}.modelId`),
    profileId: exactId(input["profileId"], `${path}.profileId`),
    ownership: ensureEnum(input["ownership"], `${path}.ownership`, PROFILE_OWNERSHIP_CLASSES),
    configurationFingerprint: fingerprint(input["configurationFingerprint"], `${path}.configurationFingerprint`),
    independenceKey: fingerprint(input["independenceKey"], `${path}.independenceKey`),
  });
  if (route.independenceKey !== independenceKey(route)) {
    throw new PlanningError("INVALID_INPUT", "Trusted route independence evidence does not match its bound identity.", { routeKey: route.routeKey });
  }
  return route;
}

function configurationPayload(configuration: Omit<ProductPlanningConfiguration, "configurationFingerprint">): JsonValue {
  return canonicalizeJson(configuration, "planningConfigurationPayload");
}

export function parseProductPlanningConfiguration(value: unknown, path = "planningConfiguration"): ProductPlanningConfiguration {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, [
    "schemaVersion", "instanceId", "discoveryRouteKey", "engineeringRouteKey", "synthesisRouteKey",
    "routes", "specialists", "limits", "configurationFingerprint",
  ], path);
  ensureSchemaVersion(input["schemaVersion"], `${path}.schemaVersion`, PRODUCT_PLANNING_SCHEMA_VERSION);
  const routes = Object.freeze(ensureArray(input["routes"], `${path}.routes`, 32).map((item, index) =>
    parseTrustedPlanningRoute(item, `${path}.routes[${index}]`),
  ).sort((left, right) => comparePlanningText(left.routeKey, right.routeKey)));
  if (routes.length === 0 || new Set(routes.map((route) => route.routeKey)).size !== routes.length) {
    throw new PlanningError("INVALID_INPUT", "Planning routes must be non-empty and uniquely keyed.");
  }
  const specialists = Object.freeze(ensureArray(input["specialists"], `${path}.specialists`, 12).map((item, index) => {
    const specialist = ensureRecord(item, `${path}.specialists[${index}]`);
    ensureExactKeys(specialist, ["specialistId", "focus", "routeKey"], `${path}.specialists[${index}]`);
    return Object.freeze({
      specialistId: exactId(specialist["specialistId"], `${path}.specialists[${index}].specialistId`),
      focus: normalizedText(specialist["focus"], `${path}.specialists[${index}].focus`, 1_000),
      routeKey: exactId(specialist["routeKey"], `${path}.specialists[${index}].routeKey`),
    });
  }).sort((left, right) => comparePlanningText(left.specialistId, right.specialistId)));
  if (new Set(specialists.map((item) => item.specialistId)).size !== specialists.length) {
    throw new PlanningError("INVALID_INPUT", "Planning specialist identities must be unique.");
  }
  const routeKeys = new Set(routes.map((route) => route.routeKey));
  const discoveryRouteKey = exactId(input["discoveryRouteKey"], `${path}.discoveryRouteKey`);
  const engineeringRouteKey = exactId(input["engineeringRouteKey"], `${path}.engineeringRouteKey`);
  const synthesisRouteKey = exactId(input["synthesisRouteKey"], `${path}.synthesisRouteKey`);
  for (const key of [discoveryRouteKey, engineeringRouteKey, synthesisRouteKey, ...specialists.map((item) => item.routeKey)]) {
    if (!routeKeys.has(key)) throw new PlanningError("INVALID_INPUT", "A planning phase names an unknown trusted route.", { routeKey: key });
  }
  const limits = parseLimits(input["limits"], `${path}.limits`);
  if (specialists.length > limits.maximumSpecialists || specialists.length + 3 > limits.maximumPhases) {
    throw new PlanningError("LIMIT_EXCEEDED", "Configured planning phases exceed their hard limit.");
  }
  const withoutFingerprint = Object.freeze({
    schemaVersion: PRODUCT_PLANNING_SCHEMA_VERSION,
    instanceId: exactId(input["instanceId"], `${path}.instanceId`),
    discoveryRouteKey,
    engineeringRouteKey,
    synthesisRouteKey,
    routes,
    specialists,
    limits,
  });
  const configurationFingerprint = fingerprint(input["configurationFingerprint"], `${path}.configurationFingerprint`);
  if (planningDigest(configurationPayload(withoutFingerprint)) !== configurationFingerprint) {
    throw new PlanningError("INVALID_INPUT", "Planning configuration fingerprint mismatch.");
  }
  return Object.freeze({ ...withoutFingerprint, configurationFingerprint });
}

export function createProductPlanningConfiguration(input: ProductPlanningConfigurationInput): ProductPlanningConfiguration {
  const routes = input.routes
    .map((route, index) => parseTrustedPlanningRoute({ ...route, independenceKey: independenceKey(route) }, `planningConfiguration.routes[${index}]`))
    .sort((left, right) => comparePlanningText(left.routeKey, right.routeKey));
  const specialists = (input.specialists ?? []).map((specialist, index) => Object.freeze({
    specialistId: exactId(specialist.specialistId, `planningConfiguration.specialists[${index}].specialistId`),
    focus: normalizedText(specialist.focus, `planningConfiguration.specialists[${index}].focus`, 1_000),
    routeKey: exactId(specialist.routeKey, `planningConfiguration.specialists[${index}].routeKey`),
  })).sort((left, right) => comparePlanningText(left.specialistId, right.specialistId));
  const base = {
    schemaVersion: PRODUCT_PLANNING_SCHEMA_VERSION,
    instanceId: exactId(input.instanceId, "planningConfiguration.instanceId"),
    discoveryRouteKey: exactId(input.discoveryRouteKey, "planningConfiguration.discoveryRouteKey"),
    engineeringRouteKey: exactId(input.engineeringRouteKey, "planningConfiguration.engineeringRouteKey"),
    synthesisRouteKey: exactId(input.synthesisRouteKey, "planningConfiguration.synthesisRouteKey"),
    routes,
    specialists,
    limits: parseLimits({ ...DEFAULT_PLANNING_LIMITS, ...input.limits }, "planningConfiguration.limits"),
  };
  return parseProductPlanningConfiguration({
    ...base,
    configurationFingerprint: planningDigest(configurationPayload(base as Omit<ProductPlanningConfiguration, "configurationFingerprint">)),
  });
}

function parseWorkspace(value: unknown, path: string): WorkspaceIdentity {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, ["projectId", "workspaceId", "snapshotId", "baseRevision"], path);
  return Object.freeze({
    projectId: exactId(input["projectId"], `${path}.projectId`),
    workspaceId: exactId(input["workspaceId"], `${path}.workspaceId`),
    snapshotId: exactId(input["snapshotId"], `${path}.snapshotId`),
    baseRevision: ensureString(input["baseRevision"], `${path}.baseRevision`, { maxLength: 64, pattern: REVISION, patternName: "revision" }),
  });
}

function parseBudget(value: unknown, path: string): PlanningBudgetPreview {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, ["maximumInputTokens", "maximumOutputTokens", "maximumCostMicros", "maximumProviderCalls"], path);
  return Object.freeze({
    maximumInputTokens: ensureSafeInteger(input["maximumInputTokens"], `${path}.maximumInputTokens`, 1, MAXIMUM_PLANNING_LIMITS.maximumTotalTokens),
    maximumOutputTokens: ensureSafeInteger(input["maximumOutputTokens"], `${path}.maximumOutputTokens`, 1, MAXIMUM_PLANNING_LIMITS.maximumTotalTokens),
    maximumCostMicros: ensureSafeInteger(input["maximumCostMicros"], `${path}.maximumCostMicros`, 0, MAXIMUM_PLANNING_LIMITS.maximumMoneyMicros),
    maximumProviderCalls: ensureSafeInteger(input["maximumProviderCalls"], `${path}.maximumProviderCalls`, 1, MAXIMUM_PLANNING_LIMITS.maximumProviderCalls),
  });
}

function intentPayload(intent: Omit<ProductIntent, "intentDigest">): JsonValue {
  return canonicalizeJson(intent, "productIntentPayload");
}

export function createProductIntent(value: ProductIntentInput, path = "productIntent"): ProductIntent {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, [
    "planId", "projectId", "title", "problem", "desiredOutcomes", "constraints", "nonGoals",
    "risk", "workspace", "budget", "createdAt", "deadline",
  ], path);
  const createdAt = ensureTimestamp(input["createdAt"], `${path}.createdAt`);
  const deadline = ensureTimestamp(input["deadline"], `${path}.deadline`);
  if (deadline <= createdAt) throw new PlanningError("INVALID_INPUT", "Planning deadline must follow creation time.");
  const withoutDigest = Object.freeze({
    schemaVersion: PRODUCT_PLANNING_SCHEMA_VERSION,
    planId: exactId(input["planId"], `${path}.planId`),
    projectId: exactId(input["projectId"], `${path}.projectId`),
    title: normalizedText(input["title"], `${path}.title`, 500),
    problem: normalizedText(input["problem"], `${path}.problem`, 8_000),
    desiredOutcomes: stringList(input["desiredOutcomes"], `${path}.desiredOutcomes`, 128),
    constraints: stringList(input["constraints"], `${path}.constraints`, 128),
    nonGoals: stringList(input["nonGoals"], `${path}.nonGoals`, 128),
    risk: ensureEnum(input["risk"], `${path}.risk`, PLAN_RISKS),
    workspace: parseWorkspace(input["workspace"], `${path}.workspace`),
    budget: parseBudget(input["budget"], `${path}.budget`),
    createdAt,
    deadline,
  });
  if (withoutDigest.workspace.projectId !== withoutDigest.projectId) {
    throw new PlanningError("INVALID_INPUT", "Product intent and workspace project identities differ.");
  }
  return Object.freeze({ ...withoutDigest, intentDigest: planningDigest(intentPayload(withoutDigest)) });
}

export function parseProductIntent(value: unknown, path = "productIntent"): ProductIntent {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, [
    "schemaVersion", "planId", "projectId", "title", "problem", "desiredOutcomes", "constraints", "nonGoals",
    "risk", "workspace", "budget", "createdAt", "deadline", "intentDigest",
  ], path);
  ensureSchemaVersion(input["schemaVersion"], `${path}.schemaVersion`, PRODUCT_PLANNING_SCHEMA_VERSION);
  const parsed = createProductIntent({
    planId: input["planId"] as string,
    projectId: input["projectId"] as string,
    title: input["title"] as string,
    problem: input["problem"] as string,
    desiredOutcomes: input["desiredOutcomes"] as readonly string[],
    constraints: input["constraints"] as readonly string[],
    nonGoals: input["nonGoals"] as readonly string[],
    risk: input["risk"] as ProductIntentInput["risk"],
    workspace: input["workspace"] as WorkspaceIdentity,
    budget: input["budget"] as PlanningBudgetPreview,
    createdAt: input["createdAt"] as string,
    deadline: input["deadline"] as string,
  }, path);
  if (fingerprint(input["intentDigest"], `${path}.intentDigest`) !== parsed.intentDigest) {
    throw new PlanningError("INVALID_INPUT", "Product intent digest mismatch.");
  }
  return parsed;
}

function parseCandidateDraft(value: unknown, path: string): CandidateRequirementDraft {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, ["localKey", "title", "description", "rationale", "category", "proposedDisposition", "dependsOn"], path);
  return Object.freeze({
    localKey: exactId(input["localKey"], `${path}.localKey`),
    title: normalizedText(input["title"], `${path}.title`, 500),
    description: normalizedText(input["description"], `${path}.description`, 8_000),
    rationale: normalizedText(input["rationale"], `${path}.rationale`, 4_000),
    category: ensureEnum(input["category"], `${path}.category`, ["capability", "quality", "risk", "constraint"] as const),
    proposedDisposition: ensureEnum(input["proposedDisposition"], `${path}.proposedDisposition`, SCOPE_DISPOSITIONS),
    dependsOn: Object.freeze(ensureArray(input["dependsOn"], `${path}.dependsOn`, 64).map((item, index) =>
      normalizeRequirementKey(item, `${path}.dependsOn[${index}]`),
    )),
  });
}

export function parsePlanningContributionDraft(value: unknown, path = "contributionDraft"): PlanningContributionDraft {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, ["candidates", "findings", "unresolvedQuestions", "dissent"], path);
  const candidates = Object.freeze(ensureArray(input["candidates"], `${path}.candidates`, 1_000).map((item, index) =>
    parseCandidateDraft(item, `${path}.candidates[${index}]`),
  ));
  if (new Set(candidates.map((item) => item.localKey)).size !== candidates.length) {
    throw new PlanningError("INVALID_INPUT", "Contribution-local candidate keys must be unique.");
  }
  const findings: readonly FeasibilityFindingDraft[] = Object.freeze(ensureArray(input["findings"], `${path}.findings`, 256).map((item, index) => {
    const finding = ensureRecord(item, `${path}.findings[${index}]`);
    ensureExactKeys(finding, ["kind", "summary", "severity"], `${path}.findings[${index}]`);
    return Object.freeze({
      kind: ensureEnum(finding["kind"], `${path}.findings[${index}].kind`, FINDING_KINDS),
      summary: normalizedText(finding["summary"], `${path}.findings[${index}].summary`, 4_000),
      severity: ensureEnum(finding["severity"], `${path}.findings[${index}].severity`, SEVERITIES),
    });
  }));
  const unresolvedQuestions: readonly UnresolvedQuestionDraft[] = Object.freeze(ensureArray(input["unresolvedQuestions"], `${path}.unresolvedQuestions`, 256).map((item, index) => {
    const question = ensureRecord(item, `${path}.unresolvedQuestions[${index}]`);
    ensureExactKeys(question, ["question", "material"], `${path}.unresolvedQuestions[${index}]`);
    return Object.freeze({
      question: normalizedText(question["question"], `${path}.unresolvedQuestions[${index}].question`, 2_000),
      material: ensureBoolean(question["material"], `${path}.unresolvedQuestions[${index}].material`),
    });
  }));
  const dissent: readonly DissentDraft[] = Object.freeze(ensureArray(input["dissent"], `${path}.dissent`, 256).map((item, index) => {
    const entry = ensureRecord(item, `${path}.dissent[${index}]`);
    ensureExactKeys(entry, ["subject", "position", "rationale", "severity"], `${path}.dissent[${index}]`);
    return Object.freeze({
      subject: normalizedText(entry["subject"], `${path}.dissent[${index}].subject`, 500),
      position: normalizedText(entry["position"], `${path}.dissent[${index}].position`, 2_000),
      rationale: normalizedText(entry["rationale"], `${path}.dissent[${index}].rationale`, 4_000),
      severity: ensureEnum(entry["severity"], `${path}.dissent[${index}].severity`, SEVERITIES),
    });
  }));
  return Object.freeze({ candidates, findings, unresolvedQuestions, dissent });
}

export function parseScopeActor(value: unknown, path = "actor"): ScopeActor {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, ["actorId", "authority"], path);
  return Object.freeze({
    actorId: exactId(input["actorId"], `${path}.actorId`),
    authority: ensureEnum(input["authority"], `${path}.authority`, SCOPE_AUTHORITIES),
  });
}

export function parseScopeDecisionInput(value: unknown, path = "scopeDecision"): ScopeDecisionInput {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, [
    "requirementId", "requirementDigest", "expectedPlanVersion", "disposition", "actor", "reason", "approvalReference", "decidedAt",
  ], path);
  return Object.freeze({
    requirementId: exactId(input["requirementId"], `${path}.requirementId`),
    requirementDigest: fingerprint(input["requirementDigest"], `${path}.requirementDigest`),
    expectedPlanVersion: ensureSafeInteger(input["expectedPlanVersion"], `${path}.expectedPlanVersion`, 1, Number.MAX_SAFE_INTEGER),
    disposition: ensureEnum(input["disposition"], `${path}.disposition`, SCOPE_DISPOSITIONS),
    actor: parseScopeActor(input["actor"], `${path}.actor`),
    reason: normalizedText(input["reason"], `${path}.reason`, 4_000),
    approvalReference: ensureNullable(input["approvalReference"], (item) => exactId(item, `${path}.approvalReference`)),
    decidedAt: ensureTimestamp(input["decidedAt"], `${path}.decidedAt`),
  });
}

export function parseApproveSpecificationInput(value: unknown, path = "approveSpecification"): ApproveSpecificationInput {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, ["expectedPlanVersion", "decisionSetDigest", "actor", "approvalReference", "approvedAt"], path);
  return Object.freeze({
    expectedPlanVersion: ensureSafeInteger(input["expectedPlanVersion"], `${path}.expectedPlanVersion`, 1, Number.MAX_SAFE_INTEGER),
    decisionSetDigest: fingerprint(input["decisionSetDigest"], `${path}.decisionSetDigest`),
    actor: parseScopeActor(input["actor"], `${path}.actor`),
    approvalReference: exactId(input["approvalReference"], `${path}.approvalReference`),
    approvedAt: ensureTimestamp(input["approvedAt"], `${path}.approvedAt`),
  });
}

function parseRouteEvidence(value: unknown, expected: TrustedPlanningRoute, path: string): TrustedPlanningRoute {
  const parsed = parseTrustedPlanningRoute(value, path);
  if (toCanonicalJson(parsed) !== toCanonicalJson(expected)) {
    throw new PlanningError("POLICY_DENIED", "Contribution route evidence does not match trusted phase configuration.", { routeKey: expected.routeKey });
  }
  return parsed;
}

export function parsePlanningContributionEvidence(
  value: unknown,
  expectedRoute: TrustedPlanningRoute,
  path = "contributionEvidence",
): PlanningContributionEvidence {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, [
    "phaseId", "resultId", "attempt", "inputDigest", "schedulerTaskId", "schedulerIdempotencyKey",
    "route", "sourceFingerprint", "completedAt", "usage",
  ], path);
  return Object.freeze({
    phaseId: exactId(input["phaseId"], `${path}.phaseId`),
    resultId: exactId(input["resultId"], `${path}.resultId`),
    attempt: ensureSafeInteger(input["attempt"], `${path}.attempt`, 1, 1_000),
    inputDigest: fingerprint(input["inputDigest"], `${path}.inputDigest`),
    schedulerTaskId: exactId(input["schedulerTaskId"], `${path}.schedulerTaskId`),
    schedulerIdempotencyKey: exactId(input["schedulerIdempotencyKey"], `${path}.schedulerIdempotencyKey`),
    route: parseRouteEvidence(input["route"], expectedRoute, `${path}.route`),
    sourceFingerprint: fingerprint(input["sourceFingerprint"], `${path}.sourceFingerprint`),
    completedAt: ensureTimestamp(input["completedAt"], `${path}.completedAt`),
    usage: parseNormalizedUsage(input["usage"], `${path}.usage`),
  });
}

function canonicalSnapshot(value: unknown): ProductPlanSnapshot {
  return canonicalizeJson(value, "productPlanSnapshot") as unknown as ProductPlanSnapshot;
}

/**
 * Snapshot validation combines exact top-level shape, immutable intent and
 * configuration binding, task-graph defensive hydration, array cardinality,
 * generated identity/digest checks, and canonical deep copying. Projection
 * invariants are rechecked by ProductPlan.hydrate before mutation.
 */
export function parseProductPlanSnapshot(
  value: unknown,
  configuration: ProductPlanningConfiguration,
  path = "productPlanSnapshot",
): ProductPlanSnapshot {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, [
    "schemaVersion", "planId", "aggregateVersion", "eventSequence", "intent", "configurationFingerprint",
    "phases", "stagedContributions", "contributions", "requirements", "decisions", "specification", "coverage",
    "reservationIntent", "reconciliationIntent", "taskGraph", "createdAt", "updatedAt",
  ], path);
  ensureSchemaVersion(input["schemaVersion"], `${path}.schemaVersion`, PRODUCT_PLANNING_SCHEMA_VERSION);
  const planId = exactId(input["planId"], `${path}.planId`);
  const intent = parseProductIntent(input["intent"], `${path}.intent`);
  if (intent.planId !== planId) throw new PlanningError("INVALID_INPUT", "Snapshot plan identity mismatch.");
  if (fingerprint(input["configurationFingerprint"], `${path}.configurationFingerprint`) !== configuration.configurationFingerprint) {
    throw new PlanningError("PERSISTENCE_MISMATCH", "Snapshot configuration fingerprint differs from the active trusted configuration.");
  }
  ensureSafeInteger(input["aggregateVersion"], `${path}.aggregateVersion`, 1, Number.MAX_SAFE_INTEGER);
  ensureSafeInteger(input["eventSequence"], `${path}.eventSequence`, 1, Number.MAX_SAFE_INTEGER);
  ensureArray(input["phases"], `${path}.phases`, configuration.limits.maximumPhases);
  ensureArray(input["stagedContributions"], `${path}.stagedContributions`, configuration.limits.maximumContributions);
  ensureArray(input["contributions"], `${path}.contributions`, configuration.limits.maximumContributions);
  ensureArray(input["requirements"], `${path}.requirements`, configuration.limits.maximumCandidateRequirements);
  ensureArray(input["decisions"], `${path}.decisions`, configuration.limits.maximumCandidateRequirements * 4);
  ensureArray(input["coverage"], `${path}.coverage`, configuration.limits.maximumCandidateRequirements);
  const graph = TaskGraph.hydrate(input["taskGraph"]);
  if (graph.graphId !== stablePlanningId("planning-graph", planId) || graph.projectId !== intent.projectId) {
    throw new PlanningError("PERSISTENCE_MISMATCH", "Planning task graph identity mismatch.");
  }
  const createdAt = ensureTimestamp(input["createdAt"], `${path}.createdAt`);
  const updatedAt = ensureTimestamp(input["updatedAt"], `${path}.updatedAt`);
  if (createdAt !== intent.createdAt || updatedAt < createdAt) throw new PlanningError("INVALID_INPUT", "Snapshot timestamps are inconsistent.");
  return Object.freeze(canonicalSnapshot(input));
}

export function parsePlanningEvent(
  value: unknown,
  configuration: ProductPlanningConfiguration,
  path = "planningEvent",
): PlanningEvent {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, [
    "schemaVersion", "eventId", "planId", "sequence", "aggregateVersion", "type",
    "occurredAt", "beforeDigest", "afterDigest", "snapshot",
  ], path);
  ensureSchemaVersion(input["schemaVersion"], `${path}.schemaVersion`, PRODUCT_PLANNING_SCHEMA_VERSION);
  const planId = exactId(input["planId"], `${path}.planId`);
  const sequence = ensureSafeInteger(input["sequence"], `${path}.sequence`, 1, Number.MAX_SAFE_INTEGER);
  const aggregateVersion = ensureSafeInteger(input["aggregateVersion"], `${path}.aggregateVersion`, 1, Number.MAX_SAFE_INTEGER);
  const type = ensureEnum(input["type"], `${path}.type`, PLANNING_EVENT_TYPES);
  const occurredAt = ensureTimestamp(input["occurredAt"], `${path}.occurredAt`);
  const beforeDigest = ensureNullable(input["beforeDigest"], (item) => fingerprint(item, `${path}.beforeDigest`));
  const afterDigest = fingerprint(input["afterDigest"], `${path}.afterDigest`);
  const snapshot = parseProductPlanSnapshot(input["snapshot"], configuration, `${path}.snapshot`);
  const eventId = exactId(input["eventId"], `${path}.eventId`);
  if (snapshot.planId !== planId || snapshot.eventSequence !== sequence || snapshot.aggregateVersion !== aggregateVersion ||
      snapshot.updatedAt !== occurredAt || planningDigest(snapshot) !== afterDigest ||
      eventId !== stablePlanningId("planning-event", planId, String(sequence), afterDigest)) {
    throw new PlanningError("PERSISTENCE_MISMATCH", "Planning event envelope does not match its exact checkpoint.");
  }
  return Object.freeze({
    schemaVersion: PRODUCT_PLANNING_SCHEMA_VERSION,
    eventId,
    planId,
    sequence,
    aggregateVersion,
    type,
    occurredAt,
    beforeDigest,
    afterDigest,
    snapshot,
  });
}

export function productPlanSnapshotDigest(snapshot: ProductPlanSnapshot): string {
  return planningDigest(snapshot);
}

export function assertExecutableDisposition(value: string): value is (typeof EXECUTABLE_DISPOSITIONS)[number] {
  return (EXECUTABLE_DISPOSITIONS as readonly string[]).includes(value);
}

export function canonicalBytes(value: unknown): number {
  return Buffer.byteLength(toCanonicalJson(canonicalizeJson(value, "planningBytes")), "utf8");
}

export function sumUsage(values: readonly NormalizedUsage[]): NormalizedUsage {
  const sums = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    toolCalls: 0,
    costMicros: 0 as number | null,
  };
  for (const usage of values) {
    sums.inputTokens += usage.inputTokens;
    sums.cachedInputTokens += usage.cachedInputTokens;
    sums.cacheWriteInputTokens += usage.cacheWriteInputTokens;
    sums.outputTokens += usage.outputTokens;
    sums.reasoningTokens += usage.reasoningTokens;
    sums.toolCalls += usage.toolCalls;
    if (usage.costMicros === null || sums.costMicros === null) sums.costMicros = null;
    else sums.costMicros += usage.costMicros;
    for (const value of [sums.inputTokens, sums.cachedInputTokens, sums.cacheWriteInputTokens, sums.outputTokens, sums.reasoningTokens, sums.toolCalls, sums.costMicros ?? 0]) {
      if (!Number.isSafeInteger(value)) throw new PlanningError("LIMIT_EXCEEDED", "Planning usage accumulation exceeded safe integer bounds.");
    }
  }
  return parseNormalizedUsage(sums);
}

/** Deterministically partitions every plan-wide scheduler budget across phases. */
export function phaseBudgetAllocation(
  intent: ProductIntent,
  configuration: ProductPlanningConfiguration,
  phaseIndex: number,
  phaseCount: number,
  synthesis: boolean,
): {
  readonly maximumInputTokens: number;
  readonly maximumOutputTokens: number;
  readonly maximumCostMicros: number;
  readonly maximumAttempts: number;
} {
  if (!Number.isSafeInteger(phaseIndex) || phaseIndex < 0 || phaseIndex >= phaseCount || phaseCount < 1) {
    throw new PlanningError("INVALID_INPUT", "Planning phase budget allocation is invalid.");
  }
  const partition = (total: number): number => Math.floor(total / phaseCount) + (phaseIndex < total % phaseCount ? 1 : 0);
  const callLimit = Math.min(intent.budget.maximumProviderCalls, configuration.limits.maximumProviderCalls);
  const allocatedAttempts = partition(callLimit);
  return Object.freeze({
    maximumInputTokens: partition(intent.budget.maximumInputTokens),
    maximumOutputTokens: partition(intent.budget.maximumOutputTokens),
    maximumCostMicros: partition(intent.budget.maximumCostMicros),
    maximumAttempts: Math.min(
      allocatedAttempts,
      configuration.limits.maximumRetriesPerPhase + 1,
      synthesis ? configuration.limits.maximumSynthesisRounds : Number.MAX_SAFE_INTEGER,
    ),
  });
}

export function decisionSetDigest(decisions: readonly ScopeDecision[]): string {
  return planningDigest(decisions
    .filter((decision, index, all) => !all.some((candidate) => candidate.supersedesDecisionId === decision.decisionId))
    .map((decision) => decision.decisionDigest)
    .sort());
}

// Type-only references keep generated public declarations explicit while the
// implementation constructs these shapes in plan.ts.
export type PlanningProjectionTypes =
  | PlanningPhase
  | PlanningContribution
  | CandidateRequirement
  | FeasibilityFinding
  | UnresolvedQuestion
  | DissentItem
  | RequirementProvenance
  | DeduplicatedRequirement
  | ScopeDecision
  | RequirementTaskCoverage
  | ProductSpecificationRequirement
  | ProductSpecification
  | BudgetReservationIntent
  | BudgetReconciliationIntent
  | PlanningEvent;
