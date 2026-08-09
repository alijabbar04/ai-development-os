import { toCanonicalJson, validation } from "@ai-dev-os/domain";
import { createHash } from "node:crypto";
import { SchedulerError } from "./errors.js";
import { parseOrchestrationTaskEnvelope } from "./schema.js";
import {
  AGENT_CAPABILITIES,
  ORCHESTRATION_SCHEMA_VERSION,
  PERMISSION_MODES,
  PROFILE_OWNERSHIP_CLASSES,
  type AgentCapability,
  type OrchestrationTaskEnvelope,
  type PermissionMode,
  type ProfileOwnershipClass,
  type SelectedRoute,
} from "./types.js";
import {
  BORROWED_WEEKLY_CAP,
  BORROWED_WORK_HOURS_FIVE_HOUR_CAP,
  isLondonWorkHours,
  parseCanonicalUsageSnapshot,
  validateUsageFreshness,
  type CanonicalUsageSnapshot,
} from "./usage.js";

const { ensureArray, ensureBoolean, ensureEnum, ensureEnumArray, ensureExactKeys, ensureRecord, ensureSafeInteger, ensureString, ensureTimestamp, fail } = validation;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const ROUTING_PREFERENCES = Object.freeze(["balanced", "cost", "quality"] as const);
export type RoutingPreference = (typeof ROUTING_PREFERENCES)[number];
export const WORKLOAD_CLASSES = Object.freeze(["general", "fable"] as const);
export type WorkloadClass = (typeof WORKLOAD_CLASSES)[number];

export interface RouteCandidate {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly profileId: string;
  readonly ownership: ProfileOwnershipClass;
  readonly authorized: boolean;
  readonly availability: "available" | "unavailable";
  readonly health: "healthy" | "degraded" | "unavailable";
  readonly healthObservedAt: string;
  readonly capabilities: readonly AgentCapability[];
  readonly permissionModes: readonly PermissionMode[];
  readonly qualityScore: number;
  readonly costScore: number;
  readonly predictedFiveHourBasisPoints: number;
  readonly predictedWeeklyBasisPoints: number;
}

export interface ConsideredRoute {
  readonly candidate: SelectedRoute;
  readonly eligible: boolean;
  readonly score: number | null;
  readonly ruleIds: readonly string[];
  readonly reasons: readonly string[];
}

export interface RoutingDecision {
  readonly schemaVersion: 1;
  readonly decisionId: string;
  readonly outcome: "selected" | "denied";
  readonly selected: SelectedRoute | null;
  readonly considered: readonly ConsideredRoute[];
  readonly ruleIds: readonly string[];
  readonly reasons: readonly string[];
  readonly decidedAt: string;
}

export interface RoutingRequest {
  readonly task: OrchestrationTaskEnvelope;
  readonly workloadClass: WorkloadClass;
  readonly preference: RoutingPreference;
  readonly candidates: readonly RouteCandidate[];
  readonly usageSnapshots: readonly CanonicalUsageSnapshot[];
  readonly now: Date;
  readonly maximumSnapshotAgeMs: number;
}

function id(value: unknown, path: string): string {
  return ensureString(value, path, { maxLength: 128, pattern: ID, patternName: "identifier" });
}

export function parseRouteCandidate(value: unknown, path = "candidate"): RouteCandidate {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, [
    "schemaVersion", "candidateId", "providerId", "modelId", "profileId", "ownership",
    "authorized", "availability", "health", "healthObservedAt", "capabilities",
    "permissionModes", "qualityScore", "costScore", "predictedFiveHourBasisPoints",
    "predictedWeeklyBasisPoints",
  ], path);
  if (input["schemaVersion"] !== ORCHESTRATION_SCHEMA_VERSION) fail(`${path}.schemaVersion`, "unsupported_schema", "must be schema version 1.");
  return Object.freeze({
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    candidateId: id(input["candidateId"], `${path}.candidateId`),
    providerId: id(input["providerId"], `${path}.providerId`),
    modelId: id(input["modelId"], `${path}.modelId`),
    profileId: id(input["profileId"], `${path}.profileId`),
    ownership: ensureEnum(input["ownership"], `${path}.ownership`, PROFILE_OWNERSHIP_CLASSES),
    authorized: ensureBoolean(input["authorized"], `${path}.authorized`),
    availability: ensureEnum(input["availability"], `${path}.availability`, ["available", "unavailable"] as const),
    health: ensureEnum(input["health"], `${path}.health`, ["healthy", "degraded", "unavailable"] as const),
    healthObservedAt: ensureTimestamp(input["healthObservedAt"], `${path}.healthObservedAt`),
    capabilities: ensureEnumArray(input["capabilities"], `${path}.capabilities`, AGENT_CAPABILITIES, AGENT_CAPABILITIES.length),
    permissionModes: ensureEnumArray(input["permissionModes"], `${path}.permissionModes`, PERMISSION_MODES, PERMISSION_MODES.length),
    qualityScore: ensureSafeInteger(input["qualityScore"], `${path}.qualityScore`, 0, 1_000),
    costScore: ensureSafeInteger(input["costScore"], `${path}.costScore`, 0, 1_000),
    predictedFiveHourBasisPoints: ensureSafeInteger(input["predictedFiveHourBasisPoints"], `${path}.predictedFiveHourBasisPoints`, 0, 10_000),
    predictedWeeklyBasisPoints: ensureSafeInteger(input["predictedWeeklyBasisPoints"], `${path}.predictedWeeklyBasisPoints`, 0, 10_000),
  });
}

function routeOf(candidate: RouteCandidate): SelectedRoute {
  return Object.freeze({
    candidateId: candidate.candidateId,
    providerId: candidate.providerId,
    modelId: candidate.modelId,
    profileId: candidate.profileId,
    ownership: candidate.ownership,
  });
}

function score(candidate: RouteCandidate, request: RoutingRequest): number {
  const priorityBoost = request.task.priority === "critical" ? candidate.qualityScore : 0;
  if (request.preference === "quality") return (candidate.qualityScore * 3) + candidate.costScore + priorityBoost;
  if (request.preference === "cost") return candidate.qualityScore + (candidate.costScore * 3) + priorityBoost;
  return candidate.qualityScore + candidate.costScore + priorityBoost;
}

function evaluateCandidate(candidate: RouteCandidate, request: RoutingRequest): ConsideredRoute {
  const rules: string[] = [];
  const reasons: string[] = [];
  const requested = request.task.requestedRoute;
  if (!candidate.authorized) {
    rules.push("route.profile.authorization.required");
    reasons.push("The profile is not explicitly authorized.");
  }
  if (requested.providerId !== null && (
    requested.providerId !== candidate.providerId || requested.modelId !== candidate.modelId ||
    requested.profileId !== candidate.profileId || requested.ownership !== candidate.ownership
  )) {
    rules.push("route.explicit-identity.exact");
    reasons.push("The candidate does not match the exact requested provider/model/profile identity.");
  }
  const missing = request.task.capabilities.filter((capability) => !candidate.capabilities.includes(capability));
  if (missing.length > 0) {
    rules.push("route.capability.required");
    reasons.push(`Missing required capabilities: ${missing.join(", ")}.`);
  }
  if (!candidate.permissionModes.includes(request.task.permissionMode)) {
    rules.push("route.permission-mode.required");
    reasons.push("The candidate cannot represent the requested permission mode.");
  }
  const healthAge = request.now.valueOf() - Date.parse(candidate.healthObservedAt);
  if (candidate.availability !== "available" || candidate.health === "unavailable") {
    rules.push("route.provider.available");
    reasons.push("The provider/profile is unavailable.");
  }
  if (healthAge < 0 || healthAge > request.maximumSnapshotAgeMs) {
    rules.push("route.health.fresh");
    reasons.push("Provider health is stale or future-dated.");
  }
  if (candidate.ownership === "authorized-borrowed" && request.workloadClass === "fable") {
    rules.push("route.borrowed.fable-forbidden");
    reasons.push("Borrowed profiles are never eligible for Fable work.");
  }
  const matchingSnapshots = request.usageSnapshots.filter((snapshot) =>
    snapshot.profileId === candidate.profileId && snapshot.providerId === candidate.providerId && snapshot.ownership === candidate.ownership);
  if (matchingSnapshots.length !== 1) {
    rules.push("usage.snapshot.exactly-one");
    reasons.push("Exactly one matching usage snapshot is required.");
  } else {
    const snapshot = matchingSnapshots[0];
    if (snapshot === undefined) throw new SchedulerError("STATE_CORRUPTION", "Usage selection failed.");
    const validity = validateUsageFreshness(snapshot, request.now, request.maximumSnapshotAgeMs);
    rules.push(...validity.ruleIds);
    reasons.push(...validity.reasons);
    if (candidate.ownership === "authorized-borrowed") {
      // A projection may land exactly on a cap, but a profile already at that
      // cap cannot start another task even when the estimate rounds to zero.
      if (snapshot.weekly.usedBasisPoints >= BORROWED_WEEKLY_CAP ||
          snapshot.weekly.usedBasisPoints + candidate.predictedWeeklyBasisPoints > BORROWED_WEEKLY_CAP) {
        rules.push("usage.borrowed.weekly-70-cap");
        reasons.push("Predicted work would exceed the borrowed-profile weekly 70% cap.");
      }
      if (isLondonWorkHours(request.now) &&
          (snapshot.fiveHour.usedBasisPoints >= BORROWED_WORK_HOURS_FIVE_HOUR_CAP ||
           snapshot.fiveHour.usedBasisPoints + candidate.predictedFiveHourBasisPoints > BORROWED_WORK_HOURS_FIVE_HOUR_CAP)) {
        rules.push("usage.borrowed.work-hours-five-hour-50-cap");
        reasons.push("Predicted work would exceed the weekday 09:00–17:00 rolling five-hour 50% cap.");
      }
    }
  }
  const eligible = rules.length === 0;
  return Object.freeze({
    candidate: routeOf(candidate),
    eligible,
    score: eligible ? score(candidate, request) : null,
    ruleIds: Object.freeze(rules),
    reasons: Object.freeze(reasons),
  });
}

export function routeTask(rawRequest: RoutingRequest): RoutingDecision {
  const task = parseOrchestrationTaskEnvelope(rawRequest.task);
  const workloadClass = ensureEnum(rawRequest.workloadClass, "routing.workloadClass", WORKLOAD_CLASSES);
  const preference = ensureEnum(rawRequest.preference, "routing.preference", ROUTING_PREFERENCES);
  if (!(rawRequest.now instanceof Date) || Number.isNaN(rawRequest.now.valueOf())) throw new SchedulerError("INVALID_TASK", "Routing now must be a valid Date.");
  const maximumSnapshotAgeMs = ensureSafeInteger(rawRequest.maximumSnapshotAgeMs, "routing.maximumSnapshotAgeMs", 1, 86_400_000);
  const candidates = ensureArray(rawRequest.candidates, "routing.candidates", 256).map((item, index) => parseRouteCandidate(item, `routing.candidates[${index}]`));
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (ids.has(candidate.candidateId)) throw new SchedulerError("INVALID_TASK", "Routing candidate identifiers must be unique.");
    ids.add(candidate.candidateId);
  }
  const usageSnapshots = ensureArray(rawRequest.usageSnapshots, "routing.usageSnapshots", 256).map((item, index) => parseCanonicalUsageSnapshot(item, `routing.usageSnapshots[${index}]`));
  const request: RoutingRequest = Object.freeze({ task, workloadClass, preference, candidates, usageSnapshots, now: new Date(rawRequest.now.valueOf()), maximumSnapshotAgeMs });
  const considered = candidates.map((candidate) => evaluateCandidate(candidate, request))
    .sort((left, right) => left.candidate.candidateId.localeCompare(right.candidate.candidateId));
  const eligible = considered.filter((item) => item.eligible).sort((left, right) =>
    (right.score ?? 0) - (left.score ?? 0) || left.candidate.candidateId.localeCompare(right.candidate.candidateId));
  const selected = eligible[0]?.candidate ?? null;
  const selectedRules = selected === null ? ["route.no-eligible-candidate"] : ["route.deterministic-selection"];
  const reasons = selected === null
    ? ["No candidate passed every hard authorization, capability, health, permission, and usage rule."]
    : [`Selected exact candidate ${selected.candidateId} by deterministic score and identifier tie-break.`];
  const decidedAt = rawRequest.now.toISOString();
  const decisionMaterial = { taskId: task.taskId, considered, selected, decidedAt, preference, workloadClass };
  return Object.freeze({
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    decisionId: `route:${createHash("sha256").update(toCanonicalJson(decisionMaterial)).digest("hex").slice(0, 32)}`,
    outcome: selected === null ? "denied" : "selected",
    selected,
    considered: Object.freeze(considered),
    ruleIds: Object.freeze(selectedRules),
    reasons: Object.freeze(reasons),
    decidedAt,
  });
}
