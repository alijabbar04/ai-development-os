import {
  defineProjectionSchema,
  parseProjectionEnvelope,
  parseRefusalEnvelope,
  serializeApiEnvelope,
  serializeProjection,
  type ProjectionAudience,
  type ProjectionConfidence,
  type ProjectionSchema,
  type ProjectionStaleReason,
} from "@ai-dev-os/api";
import type { JsonObject } from "@ai-dev-os/domain";
import { controlFail } from "./errors.js";
import {
  BEARER_TOKEN_PATTERN,
  CONTROL_SERVICE_VERSION,
  START_NONCE_PATTERN,
} from "./identity.js";
import {
  exactInteger,
  exactString,
  exactTimestamp,
  readExactArray,
  readExactRecord,
} from "./structural.js";

export const USAGE_POLICY_TIMEZONE = "Europe/London" as const;
export const USAGE_POLICY_CALENDAR_LOCALE = "en-GB" as const;
export const USAGE_POLICY_WORK_DAYS = Object.freeze([
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
] as const);
export const USAGE_POLICY_WORK_START = "09:00" as const;
export const USAGE_POLICY_WORK_END = "17:00" as const;
export const USAGE_POLICY_BORROWED_FIVE_HOUR_CAP_BP = 5_000 as const;
export const USAGE_POLICY_BORROWED_WEEKLY_CAP_BP = 7_000 as const;
export const USAGE_POLICY_SCHEMA_VERSION = 3 as const;

export const USAGE_FRESHNESS_RULE_IDS = Object.freeze([
  "usage.schema-v3.required",
  "usage.authority.required",
  "usage.authorization.required",
  "usage.revocation.refused",
  "usage.future.refused",
  "usage.stale.refused",
  "usage.source-freshness.expired",
  "usage.window.inactive",
  "usage.reset.invalid",
  "usage.window.expired",
] as const);

export const USAGE_BORROWED_CAP_RULE_IDS = Object.freeze([
  "usage.borrowed.weekly-70-cap",
  "usage.borrowed.work-hours-five-hour-50-cap",
] as const);

export const USAGE_ELIGIBILITY_RULE_IDS = Object.freeze([
  ...USAGE_FRESHNESS_RULE_IDS,
  ...USAGE_BORROWED_CAP_RULE_IDS,
] as const);

export const CONTROL_SERVICE_STARTUP_SCOPE = "service-process" as const;

const ROUTING_RULE_IDS = Object.freeze([
  "route.borrowed.explicit-task-model-authorization",
  "route.borrowed.fable-forbidden",
  "route.capability.required",
  "route.deterministic-selection",
  "route.explicit-identity.exact",
  "route.health.fresh",
  "route.no-eligible-candidate",
  "route.permission-mode.required",
  "route.profile.authorization.required",
  "route.provider.available",
  ...USAGE_ELIGIBILITY_RULE_IDS,
] as const);

const SELECTED_ROUTING_RULE_IDS = Object.freeze([
  "route.deterministic-selection",
] as const);

const POLICY_RULE_SENTENCES = Object.freeze({
  "usage.schema-v3.required": "A current usage record is required.",
  "usage.authority.required": "Usage must be provider-authoritative and high-confidence.",
  "usage.authorization.required": "This profile must be explicitly authorised.",
  "usage.revocation.refused": "Revoked or unconfirmed access is refused.",
  "usage.future.refused": "Future-dated usage evidence is refused.",
  "usage.stale.refused": "Usage evidence must be current.",
  "usage.source-freshness.expired": "The source freshness period must still be active.",
  "usage.window.inactive": "Both usage windows must be active.",
  "usage.reset.invalid": "Reset times must follow the observation time.",
  "usage.window.expired": "Expired usage windows cannot authorise routing.",
  "usage.borrowed.weekly-70-cap": "Current usage and outstanding reservations leave no weekly capacity for more work.",
  "usage.borrowed.work-hours-five-hour-50-cap": "Current usage and outstanding reservations leave no weekday work-hours capacity for more work.",
} as const satisfies Record<(typeof USAGE_ELIGIBILITY_RULE_IDS)[number], string>);

const USAGE_UNAVAILABLE_SENTENCE =
  "Usage is unavailable; nothing is assumed about remaining capacity." as const;

const AUTHORISED_FOR = Object.freeze({
  personal: "Personal work",
  project: "Project work",
  development: "Development work",
} as const);

const ROUTING_REASON_SENTENCES = Object.freeze({
  "explicit-identity": "The requested profile identity matched exactly.",
  "capability-match": "The route supports the required capabilities.",
  "permission-match": "The route supports the required permission mode.",
  "provider-healthy": "Recent provider health evidence was available.",
  "usage-eligible": "Current usage evidence was eligible.",
  "deterministic-selection": "The stored deterministic order selected this route.",
  "owned-profile": "The selected route uses an owned profile.",
  "borrowed-policy": "The selected borrowed profile met the explicit policy.",
} as const);

const IDENTIFIER = /^[a-z][A-Za-z0-9]*(?:[._:-][A-Za-z0-9]+)*$/u;
const IDENTIFIER_LEAK_SHAPES = Object.freeze([
  /sk-ant-[A-Za-z0-9_-]{8,}/u,
  /\bsk-[A-Za-z0-9]{20,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/\-]{16,}=*/u,
  /\b[0-9a-f]{40,}\b/iu,
  /sha256:/iu,
  /(?:fingerprint|credential|password|passphrase|bearer|authorizationheader|authheader|secret|token)/iu,
  /(?:borrowed.*owner|owner.*(?:id|identity|email|name|account))/iu,
]);
const PROBE_VERSION = /^v\d+\.\d+\.\d+(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/u;
const CONFIDENCE = Object.freeze(["current", "stale"] as const);
const STALE_REASONS = Object.freeze([
  "sequence-lag",
  "source-freshness-expired",
  "source-unavailable",
  "service-read-only",
] as const);
const WINDOW_STATUSES = Object.freeze(["active", "inactive", "stale", "unavailable"] as const);
const AUTHORIZATION = Object.freeze(["authorized", "unauthorized", "ambiguous"] as const);
const REVOCATION = Object.freeze(["not-revoked", "revoked", "unknown"] as const);
const OWNERSHIP = Object.freeze(["owned", "authorized-borrowed"] as const);
const SOURCE_CLASSES = Object.freeze([
  "provider-authoritative", "provider-cached", "locally-observed", "calculated", "estimated",
] as const);
const SOURCE_CONFIDENCE = Object.freeze(["high", "medium", "low"] as const);
const FAILURE_CODES = Object.freeze([
  "source-unavailable", "invalid-evidence", "read-refused", "not-observed",
] as const);
const RESERVATION_STATUSES = Object.freeze([
  "reserved", "reconciliation-required", "reconciled", "released",
] as const);
const AGENTS = Object.freeze(["claude-code", "codex", "fable"] as const);
const WORKLOAD_CLASSES = Object.freeze(["general", "fable"] as const);
const STARTUP_MODES = Object.freeze(["adopted", "fresh"] as const);
const PROVIDER_AVAILABILITY = Object.freeze(["available", "unavailable", "unknown"] as const);
const PROVIDER_HEALTH = Object.freeze(["healthy", "degraded", "unavailable", "unknown"] as const);
const SWEEP_STEPS = Object.freeze([
  "read-estop", "leases", "sessions", "intents", "reservations", "approvals",
  "handovers", "worktrees", "outbox", "projections",
] as const);

type UsageRuleId = (typeof USAGE_ELIGIBILITY_RULE_IDS)[number];
type WindowStatus = (typeof WINDOW_STATUSES)[number];
type Authorization = (typeof AUTHORIZATION)[number];
type Revocation = (typeof REVOCATION)[number];
type Ownership = (typeof OWNERSHIP)[number];
type SourceClass = (typeof SOURCE_CLASSES)[number];
type SourceConfidence = (typeof SOURCE_CONFIDENCE)[number];
type FailureCode = (typeof FAILURE_CODES)[number];
type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
type Agent = (typeof AGENTS)[number];
type WorkloadClass = (typeof WORKLOAD_CLASSES)[number];
type StartupMode = (typeof STARTUP_MODES)[number];
type ProviderAvailability = (typeof PROVIDER_AVAILABILITY)[number];
type ProviderHealth = (typeof PROVIDER_HEALTH)[number];
type SweepStep = (typeof SWEEP_STEPS)[number];
type RoutingReasonCode = keyof typeof ROUTING_REASON_SENTENCES;

interface ProjectionMetadata {
  readonly computedAt: string;
  readonly confidence: ProjectionConfidence;
  readonly staleReason: ProjectionStaleReason | null;
}

interface UsageWindowRecord {
  readonly status: WindowStatus;
  readonly usedBp: number | null;
  readonly remainingBp: number | null;
  readonly resetAt: string | null;
  readonly windowId: string;
}

interface UsageSnapshotRecord {
  readonly sourceClass: SourceClass;
  readonly authoritative: boolean;
  readonly sourceConfidence: SourceConfidence;
  readonly observedAt: string;
  readonly freshUntil: string;
  readonly schemaVersion: 1 | 2 | 3;
  readonly failureCode: FailureCode | null;
}

interface UsageReservationRecord {
  readonly profileId: string;
  readonly reservationId: string;
  readonly status: ReservationStatus;
  readonly predictedFiveHourBp: number;
  readonly predictedWeeklyBp: number;
  readonly taskId: string;
}

interface UsageProfileRecord extends ProjectionMetadata {
  readonly profileId: string;
  readonly alias: string;
  readonly ownership: Ownership;
  readonly provider: string;
  readonly product: string;
  readonly authorisedFor: keyof typeof AUTHORISED_FOR;
  readonly authorization: Authorization;
  readonly revocation: Revocation;
  readonly windows: Readonly<{ fiveHour: UsageWindowRecord; weekly: UsageWindowRecord }>;
  readonly snapshot: UsageSnapshotRecord;
  readonly eligibility: Readonly<{ eligible: boolean; ruleIds: readonly UsageRuleId[] }>;
  readonly reservations: readonly UsageReservationRecord[];
}

interface HealthRecord extends ProjectionMetadata {
  readonly runningSessions: number;
  readonly providerHealth: readonly Readonly<{
    providerId: string;
    availability: ProviderAvailability;
    health: ProviderHealth;
    observedAt: string;
  }>[];
  readonly probes: readonly Readonly<{
    agent: Agent;
    version: string;
    probedAt: string;
  }>[];
}

const SERVICE_STARTUP = Object.freeze({
  scope: CONTROL_SERVICE_STARTUP_SCOPE,
  mode: "fresh" as const satisfies StartupMode,
  stoppedByRestart: 0,
  recoveredSessions: 0,
  unresolvedRuns: 0,
  unconfirmedSessions: 0,
  sweepCompletedAt: null,
  sweepTimings: Object.freeze([] as readonly Readonly<{ step: SweepStep; elapsedMs: number }>[]),
});

interface RoutingDecisionRecord extends ProjectionMetadata {
  readonly taskId: string;
  readonly decisionId: string;
  readonly routeAlias: string;
  readonly agent: Agent;
  readonly workloadClass: WorkloadClass;
  readonly ownership: Ownership;
  readonly reasonCodes: readonly RoutingReasonCode[];
  readonly ruleIds: readonly (typeof ROUTING_RULE_IDS)[number][];
  readonly decidedAt: string;
  readonly evidenceAt: string;
}

export interface ControlProjectionContext {
  readonly audience: ProjectionAudience;
  readonly sequence: number;
  readonly serverNow: string;
  readonly processId: number;
  readonly startNonce: string;
}

export interface ControlProjectionRuntime {
  runningSessionCount(): number;
  health(context: ControlProjectionContext): string;
  usagePolicyConstants(context: ControlProjectionContext): string;
  usageProfile(profileId: string, context: ControlProjectionContext): string | null;
  storedRoutingDecision(taskId: string, context: ControlProjectionContext): string | null;
}

function exactBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") controlFail("INVALID_INPUT");
  return value;
}

function exactEnum<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) controlFail("INVALID_INPUT");
  return value as T[number];
}

function exactIdentifier(value: unknown, maximum = 128): string {
  const identifier = exactString(value, IDENTIFIER, maximum);
  if (
    BEARER_TOKEN_PATTERN.test(identifier) ||
    IDENTIFIER_LEAK_SHAPES.some((pattern) => pattern.test(identifier))
  ) controlFail("INVALID_INPUT");
  return identifier;
}

function timestampMs(value: string): number {
  const milliseconds = new Date(exactTimestamp(value)).valueOf();
  if (!Number.isFinite(milliseconds)) controlFail("INVALID_INPUT");
  return milliseconds;
}

function parseMetadata(record: Record<string, unknown>): ProjectionMetadata {
  const confidence = exactEnum(record["confidence"], CONFIDENCE);
  const staleReason = record["staleReason"] === null
    ? null
    : exactEnum(record["staleReason"], STALE_REASONS);
  if ((confidence === "current") !== (staleReason === null)) controlFail("INVALID_INPUT");
  return Object.freeze({
    computedAt: exactTimestamp(record["computedAt"]),
    confidence,
    staleReason,
  });
}

function uniqueSorted<const T extends string>(values: readonly T[]): readonly T[] {
  if (new Set(values).size !== values.length) controlFail("INVALID_INPUT");
  return Object.freeze([...values].sort());
}

function parseWindow(value: unknown): UsageWindowRecord {
  const record = readExactRecord(value, ["status", "usedBp", "remainingBp", "resetAt", "windowId"]);
  const status = exactEnum(record["status"], WINDOW_STATUSES);
  const windowId = exactIdentifier(record["windowId"]);
  if (status === "inactive" || status === "unavailable") {
    if (record["usedBp"] !== null || record["remainingBp"] !== null || record["resetAt"] !== null) {
      controlFail("INVALID_INPUT");
    }
    return Object.freeze({ status, usedBp: null, remainingBp: null, resetAt: null, windowId });
  }
  if (record["usedBp"] === null || record["remainingBp"] === null || record["resetAt"] === null) {
    controlFail("INVALID_INPUT");
  }
  const usedBp = exactInteger(record["usedBp"], 0, 10_000);
  const remainingBp = exactInteger(record["remainingBp"], 0, 10_000);
  if (usedBp + remainingBp !== 10_000) controlFail("INVALID_INPUT");
  return Object.freeze({
    status,
    usedBp,
    remainingBp,
    resetAt: exactTimestamp(record["resetAt"]),
    windowId,
  });
}

function parseSnapshot(value: unknown): UsageSnapshotRecord {
  const record = readExactRecord(value, [
    "sourceClass", "authoritative", "sourceConfidence", "observedAt", "freshUntil",
    "schemaVersion", "failureCode",
  ]);
  const failureCode = record["failureCode"] === null
    ? null
    : exactEnum(record["failureCode"], FAILURE_CODES);
  const sourceClass = exactEnum(record["sourceClass"], SOURCE_CLASSES);
  const authoritative = exactBoolean(record["authoritative"]);
  const observedAt = exactTimestamp(record["observedAt"]);
  const freshUntil = exactTimestamp(record["freshUntil"]);
  if (
    authoritative !== (sourceClass === "provider-authoritative") ||
    timestampMs(freshUntil) < timestampMs(observedAt)
  ) controlFail("INVALID_INPUT");
  return Object.freeze({
    sourceClass,
    authoritative,
    sourceConfidence: exactEnum(record["sourceConfidence"], SOURCE_CONFIDENCE),
    observedAt,
    freshUntil,
    schemaVersion: exactInteger(record["schemaVersion"], 1, 3) as 1 | 2 | 3,
    failureCode,
  });
}

function parseReservation(value: unknown): UsageReservationRecord {
  const record = readExactRecord(value, [
    "profileId", "reservationId", "status", "predictedFiveHourBp", "predictedWeeklyBp", "taskId",
  ]);
  return Object.freeze({
    profileId: exactIdentifier(record["profileId"]),
    reservationId: exactIdentifier(record["reservationId"]),
    status: exactEnum(record["status"], RESERVATION_STATUSES),
    predictedFiveHourBp: exactInteger(record["predictedFiveHourBp"], 0, 10_000),
    predictedWeeklyBp: exactInteger(record["predictedWeeklyBp"], 0, 10_000),
    taskId: exactIdentifier(record["taskId"]),
  });
}

function parseUsageRules(value: unknown): readonly UsageRuleId[] {
  const items = readExactArray(value, USAGE_ELIGIBILITY_RULE_IDS.length);
  return uniqueSorted(items.map((item) => exactEnum(item, USAGE_ELIGIBILITY_RULE_IDS)));
}

function parseUsageProfile(value: unknown): UsageProfileRecord {
  const record = readExactRecord(value, [
    "profileId", "alias", "ownership", "provider", "product", "authorisedFor",
    "authorization", "revocation", "windows", "snapshot", "eligibility",
    "reservations", "computedAt", "confidence", "staleReason",
  ]);
  const windowsRecord = readExactRecord(record["windows"], ["fiveHour", "weekly"]);
  const eligibilityRecord = readExactRecord(record["eligibility"], ["eligible", "ruleIds"]);
  const reservations = readExactArray(record["reservations"], 32).map(parseReservation);
  const profileId = exactIdentifier(record["profileId"]);
  const reservationIds = reservations.map((item) => item.reservationId);
  if (
    new Set(reservationIds).size !== reservationIds.length ||
    reservations.some((item) => item.profileId !== profileId)
  ) controlFail("INVALID_INPUT");
  const parsedWindows = Object.freeze({
    fiveHour: parseWindow(windowsRecord["fiveHour"]),
    weekly: parseWindow(windowsRecord["weekly"]),
  });
  const parsedSnapshot = parseSnapshot(record["snapshot"]);
  const metadata = parseMetadata(record);
  if (parsedWindows.fiveHour.windowId === parsedWindows.weekly.windowId) {
    controlFail("INVALID_INPUT");
  }
  const activeResets = [parsedWindows.fiveHour, parsedWindows.weekly]
    .filter((window) => window.status === "active")
    .map((window) => window.resetAt);
  if (activeResets.some((resetAt) => resetAt === null || timestampMs(parsedSnapshot.freshUntil) > timestampMs(resetAt))) {
    controlFail("INVALID_INPUT");
  }
  const hasUnavailableWindow = parsedWindows.fiveHour.status === "unavailable" ||
    parsedWindows.weekly.status === "unavailable";
  if ((parsedSnapshot.failureCode !== null) !== hasUnavailableWindow) controlFail("INVALID_INPUT");
  if (
    (parsedSnapshot.sourceConfidence !== "high" && metadata.confidence !== "stale") ||
    (hasUnavailableWindow && (
      parsedSnapshot.sourceConfidence !== "low" || metadata.confidence !== "stale" ||
      metadata.staleReason !== "source-unavailable"
    ))
  ) controlFail("INVALID_INPUT");
  return Object.freeze({
    profileId,
    alias: exactIdentifier(record["alias"], 64),
    ownership: exactEnum(record["ownership"], OWNERSHIP),
    provider: exactIdentifier(record["provider"], 64),
    product: exactIdentifier(record["product"], 64),
    authorisedFor: exactEnum(record["authorisedFor"], Object.freeze(Object.keys(AUTHORISED_FOR)) as readonly (keyof typeof AUTHORISED_FOR)[]),
    authorization: exactEnum(record["authorization"], AUTHORIZATION),
    revocation: exactEnum(record["revocation"], REVOCATION),
    windows: parsedWindows,
    snapshot: parsedSnapshot,
    eligibility: Object.freeze({
      eligible: exactBoolean(eligibilityRecord["eligible"]),
      ruleIds: parseUsageRules(eligibilityRecord["ruleIds"]),
    }),
    reservations: Object.freeze(reservations),
    ...metadata,
  });
}

function parseHealth(value: unknown): HealthRecord {
  const record = readExactRecord(value, [
    "runningSessions", "providerHealth", "probes", "computedAt", "confidence", "staleReason",
  ]);
  const providerHealth = readExactArray(record["providerHealth"], 16).map((item) => {
    const entry = readExactRecord(item, ["providerId", "availability", "health", "observedAt"]);
    return Object.freeze({
      providerId: exactIdentifier(entry["providerId"], 64),
      availability: exactEnum(entry["availability"], PROVIDER_AVAILABILITY),
      health: exactEnum(entry["health"], PROVIDER_HEALTH),
      observedAt: exactTimestamp(entry["observedAt"]),
    });
  });
  const probes = readExactArray(record["probes"], 16).map((item) => {
    const entry = readExactRecord(item, ["agent", "version", "probedAt"]);
    const version = exactIdentifier(entry["version"], 64);
    if (!PROBE_VERSION.test(version)) controlFail("INVALID_INPUT");
    return Object.freeze({
      agent: exactEnum(entry["agent"], AGENTS),
      version,
      probedAt: exactTimestamp(entry["probedAt"]),
    });
  });
  if (
    new Set(providerHealth.map((item) => item.providerId)).size !== providerHealth.length ||
    new Set(probes.map((item) => item.agent)).size !== probes.length
  ) controlFail("INVALID_INPUT");
  const output: HealthRecord = Object.freeze({
    runningSessions: exactInteger(record["runningSessions"], 0, 10_000),
    providerHealth: Object.freeze(providerHealth),
    probes: Object.freeze(probes),
    ...parseMetadata(record),
  });
  const computedMs = timestampMs(output.computedAt);
  if (
    output.providerHealth.some((item) => timestampMs(item.observedAt) > computedMs) ||
    output.probes.some((item) => timestampMs(item.probedAt) > computedMs)
  ) controlFail("INVALID_INPUT");
  return output;
}

function parseRoutingDecision(value: unknown): RoutingDecisionRecord {
  const record = readExactRecord(value, [
    "taskId", "decisionId", "routeAlias", "agent", "workloadClass", "ownership", "reasonCodes", "ruleIds",
    "decidedAt", "evidenceAt", "computedAt", "confidence", "staleReason",
  ]);
  const reasonCodes = uniqueSorted(readExactArray(record["reasonCodes"], 16).map((item) =>
    exactEnum(item, Object.freeze(Object.keys(ROUTING_REASON_SENTENCES)) as readonly RoutingReasonCode[])));
  const ruleIds = uniqueSorted(readExactArray(record["ruleIds"], 32).map((item) => exactEnum(item, ROUTING_RULE_IDS)));
  const agent = exactEnum(record["agent"], AGENTS);
  const workloadClass = exactEnum(record["workloadClass"], WORKLOAD_CLASSES);
  const ownership = exactEnum(record["ownership"], OWNERSHIP);
  const expectedOwnershipReason = ownership === "owned" ? "owned-profile" : "borrowed-policy";
  const refusedOwnershipReason = ownership === "owned" ? "borrowed-policy" : "owned-profile";
  if (
    JSON.stringify(ruleIds) !== JSON.stringify(SELECTED_ROUTING_RULE_IDS) ||
    !reasonCodes.includes("deterministic-selection") ||
    !reasonCodes.includes("usage-eligible") ||
    !reasonCodes.includes(expectedOwnershipReason) ||
    reasonCodes.includes(refusedOwnershipReason) ||
    (ownership === "authorized-borrowed" && (agent === "fable" || workloadClass === "fable"))
  ) {
    controlFail("INVALID_INPUT");
  }
  const output: RoutingDecisionRecord = Object.freeze({
    taskId: exactIdentifier(record["taskId"]),
    decisionId: exactIdentifier(record["decisionId"]),
    routeAlias: exactIdentifier(record["routeAlias"], 64),
    agent,
    workloadClass,
    ownership,
    reasonCodes,
    ruleIds,
    decidedAt: exactTimestamp(record["decidedAt"]),
    evidenceAt: exactTimestamp(record["evidenceAt"]),
    ...parseMetadata(record),
  });
  if (
    timestampMs(output.evidenceAt) > timestampMs(output.decidedAt) ||
    timestampMs(output.decidedAt) > timestampMs(output.computedAt)
  ) controlFail("INVALID_INPUT");
  return output;
}

function rule<const T extends string>(values: readonly T[]) {
  return Object.freeze({ kind: "policy-rule-id" as const, values });
}

function copy<const T extends string>(values: readonly T[]) {
  return Object.freeze({ kind: "product-copy" as const, values });
}

const WINDOW_NORMAL_RULE = Object.freeze({
  kind: "object" as const,
  fields: Object.freeze({
    status: { kind: "enum" as const, values: WINDOW_STATUSES },
    usedBp: { kind: "nullable" as const, value: { kind: "basis-points" as const } },
    remainingBp: { kind: "nullable" as const, value: { kind: "basis-points" as const } },
    resetAt: { kind: "nullable" as const, value: { kind: "timestamp" as const } },
  }),
});

const WINDOW_DEVELOPER_RULE = Object.freeze({
  kind: "object" as const,
  fields: Object.freeze({
    ...WINDOW_NORMAL_RULE.fields,
    windowId: { kind: "identifier" as const },
  }),
});

const RESERVATION_NORMAL_RULE = Object.freeze({
  kind: "object" as const,
  fields: Object.freeze({
    status: { kind: "enum" as const, values: RESERVATION_STATUSES },
    predictedFiveHourBp: { kind: "basis-points" as const },
    predictedWeeklyBp: { kind: "basis-points" as const },
  }),
});

const RESERVATION_DEVELOPER_RULE = Object.freeze({
  kind: "object" as const,
  fields: Object.freeze({
    reservationId: { kind: "identifier" as const },
    status: { kind: "enum" as const, values: RESERVATION_STATUSES },
    predictedFiveHourBp: { kind: "basis-points" as const },
    predictedWeeklyBp: { kind: "basis-points" as const },
    taskId: { kind: "identifier" as const },
  }),
});

const HEALTH_NORMAL_SCHEMA = defineProjectionSchema("controlHealthNormal", {
  serviceVersion: copy([CONTROL_SERVICE_VERSION]),
  ready: { kind: "boolean" },
  sequence: { kind: "count", maximum: Number.MAX_SAFE_INTEGER },
  dispatchPaused: { kind: "boolean" },
  estopAvailability: { kind: "enum", values: ["not-implemented"] },
  startup: {
    kind: "object",
    fields: {
      mode: { kind: "enum", values: STARTUP_MODES },
      scope: copy([CONTROL_SERVICE_STARTUP_SCOPE]),
      stoppedByRestart: { kind: "count", maximum: 10_000 },
      recoveredSessions: { kind: "count", maximum: 10_000 },
      unresolvedRuns: { kind: "count", maximum: 10_000 },
      unconfirmedSessions: { kind: "count", maximum: 10_000 },
      sweepCompletedAt: { kind: "nullable", value: { kind: "timestamp" } },
    },
  },
  providerHealth: {
    kind: "array", maximumItems: 16,
    item: {
      kind: "object",
      fields: {
        providerId: { kind: "identifier" },
        availability: { kind: "enum", values: PROVIDER_AVAILABILITY },
        health: { kind: "enum", values: PROVIDER_HEALTH },
        observedAt: { kind: "timestamp" },
      },
    },
  },
  probes: {
    kind: "array", maximumItems: 16,
    item: {
      kind: "object",
      fields: {
        agent: { kind: "enum", values: AGENTS },
        version: { kind: "identifier" },
        probedAt: { kind: "timestamp" },
      },
    },
  },
});

const HEALTH_DEVELOPER_SCHEMA = defineProjectionSchema("controlHealthDeveloper", {
  ...HEALTH_NORMAL_SCHEMA.fields,
  pid: { kind: "integer", minimum: 1, maximum: 2_147_483_647 },
  nonceReference: { kind: "identifier" },
  sweepTimings: {
    kind: "array", maximumItems: SWEEP_STEPS.length,
    item: {
      kind: "object",
      fields: {
        step: { kind: "enum", values: SWEEP_STEPS },
        elapsedMs: { kind: "count", maximum: 20_000 },
      },
    },
  },
});

const USAGE_NORMAL_SCHEMA = defineProjectionSchema("usageProfileNormal", {
  alias: { kind: "identifier" },
  ownership: { kind: "enum", values: OWNERSHIP },
  provider: { kind: "identifier" },
  product: { kind: "identifier" },
  authorisedFor: copy(Object.values(AUTHORISED_FOR)),
  authorization: { kind: "enum", values: AUTHORIZATION },
  revocation: { kind: "enum", values: REVOCATION },
  windows: {
    kind: "object",
    fields: { fiveHour: WINDOW_NORMAL_RULE, weekly: WINDOW_NORMAL_RULE },
  },
  snapshot: {
    kind: "object",
    fields: {
      observedAt: { kind: "timestamp" },
      freshUntil: { kind: "timestamp" },
    },
  },
  eligibility: {
    kind: "object",
    fields: {
      eligible: { kind: "boolean" },
      reasons: {
        kind: "array",
        maximumItems: USAGE_ELIGIBILITY_RULE_IDS.length,
        item: copy([...Object.values(POLICY_RULE_SENTENCES), USAGE_UNAVAILABLE_SENTENCE]),
      },
    },
  },
  capsInEffect: {
    kind: "object",
    fields: { fiveHour50: { kind: "boolean" }, weekly70: { kind: "boolean" } },
  },
  reservations: { kind: "array", maximumItems: 32, item: RESERVATION_NORMAL_RULE },
});

const USAGE_DEVELOPER_SCHEMA = defineProjectionSchema("usageProfileDeveloper", {
  ...USAGE_NORMAL_SCHEMA.fields,
  profileId: { kind: "profile-id" },
  windows: {
    kind: "object",
    fields: { fiveHour: WINDOW_DEVELOPER_RULE, weekly: WINDOW_DEVELOPER_RULE },
  },
  snapshot: {
    kind: "object",
    fields: {
      sourceClass: { kind: "enum", values: SOURCE_CLASSES },
      authoritative: { kind: "boolean" },
      sourceConfidence: { kind: "enum", values: SOURCE_CONFIDENCE },
      observedAt: { kind: "timestamp" },
      freshUntil: { kind: "timestamp" },
      schemaVersion: { kind: "integer", minimum: 1, maximum: 3 },
      failureCode: { kind: "nullable", value: { kind: "enum", values: FAILURE_CODES } },
    },
  },
  eligibility: {
    kind: "object",
    fields: {
      eligible: { kind: "boolean" },
      reasons: {
        kind: "array",
        maximumItems: USAGE_ELIGIBILITY_RULE_IDS.length,
        item: copy([...Object.values(POLICY_RULE_SENTENCES), USAGE_UNAVAILABLE_SENTENCE]),
      },
      ruleIds: {
        kind: "array",
        maximumItems: USAGE_ELIGIBILITY_RULE_IDS.length,
        item: rule(USAGE_ELIGIBILITY_RULE_IDS),
      },
    },
  },
  reservations: { kind: "array", maximumItems: 32, item: RESERVATION_DEVELOPER_RULE },
});

const POLICY_NORMAL_SCHEMA = defineProjectionSchema("usagePolicyConstantsNormal", {
  timezone: copy([USAGE_POLICY_TIMEZONE]),
  workHours: {
    kind: "object",
    fields: {
      days: { kind: "array", maximumItems: 5, item: copy(USAGE_POLICY_WORK_DAYS) },
      start: copy([USAGE_POLICY_WORK_START]),
      end: copy([USAGE_POLICY_WORK_END]),
      halfOpen: { kind: "boolean" },
    },
  },
  borrowedFiveHourCapBp: { kind: "basis-points" },
  borrowedWeeklyCapBp: { kind: "basis-points" },
  schemaVersion: { kind: "integer", minimum: 3, maximum: 3 },
  ruleCatalogue: {
    kind: "array", maximumItems: USAGE_ELIGIBILITY_RULE_IDS.length,
    item: { kind: "object", fields: { sentence: copy(Object.values(POLICY_RULE_SENTENCES)) } },
  },
});

const POLICY_DEVELOPER_SCHEMA = defineProjectionSchema("usagePolicyConstantsDeveloper", {
  ...POLICY_NORMAL_SCHEMA.fields,
  ruleCatalogue: {
    kind: "array", maximumItems: USAGE_ELIGIBILITY_RULE_IDS.length,
    item: {
      kind: "object",
      fields: {
        ruleId: rule(USAGE_ELIGIBILITY_RULE_IDS),
        sentence: copy(Object.values(POLICY_RULE_SENTENCES)),
      },
    },
  },
});

const ROUTING_NORMAL_SCHEMA = defineProjectionSchema("storedRoutingNormal", {
  chosen: {
    kind: "object",
    fields: { routeAlias: { kind: "identifier" }, agent: { kind: "enum", values: AGENTS } },
  },
  reasons: {
    kind: "array", maximumItems: 16,
    item: copy(Object.values(ROUTING_REASON_SENTENCES)),
  },
  decidedAt: { kind: "timestamp" },
  evidenceAt: { kind: "timestamp" },
  evidenceAgeSeconds: { kind: "count", maximum: 315_576_000 },
});

const ROUTING_DEVELOPER_SCHEMA = defineProjectionSchema("storedRoutingDeveloper", {
  ...ROUTING_NORMAL_SCHEMA.fields,
  taskId: { kind: "identifier" },
  decisionId: { kind: "identifier" },
  ruleIds: { kind: "array", maximumItems: 1, item: rule(SELECTED_ROUTING_RULE_IDS) },
});

function parseContext(value: ControlProjectionContext): Readonly<ControlProjectionContext> {
  const record = readExactRecord(value, ["audience", "sequence", "serverNow", "processId", "startNonce"]);
  return Object.freeze({
    audience: exactEnum(record["audience"], Object.freeze(["normal", "developer"] as const)),
    sequence: exactInteger(record["sequence"], 1, Number.MAX_SAFE_INTEGER),
    serverNow: exactTimestamp(record["serverNow"]),
    processId: exactInteger(record["processId"], 1, 2_147_483_647),
    startNonce: exactString(record["startNonce"], START_NONCE_PATTERN, 32),
  });
}

function serializeEnvelope(
  schema: ProjectionSchema,
  payload: unknown,
  metadata: ProjectionMetadata,
  contextValue: ControlProjectionContext,
  profileScope: string | null = null,
): string {
  const context = parseContext(contextValue);
  const serialized = serializeProjection(schema, payload, {
    audience: context.audience,
    ...(profileScope === null ? {} : { profileScope }),
  });
  const envelope = parseProjectionEnvelope({
    schemaVersion: 1,
    sequence: context.sequence,
    serverNow: context.serverNow,
    productionEnabled: false,
    ok: true,
    kind: "projection",
    computedAt: metadata.computedAt,
    confidence: metadata.confidence,
    staleReason: metadata.staleReason,
    payload: serialized,
  }, (value) => value as JsonObject);
  return serializeApiEnvelope(envelope);
}

export function serializeProjectionUnavailable(sequence: number, serverNow: string): string {
  return serializeApiEnvelope(parseRefusalEnvelope({
    schemaVersion: 1,
    sequence,
    serverNow,
    productionEnabled: false,
    ok: false,
    kind: "refused",
    refusal: { code: "SERVICE_NOT_READY", details: null },
  }));
}

export function isLondonWorkHours(serverNow: string): boolean {
  const instant = new Date(exactTimestamp(serverNow));
  const parts = new Intl.DateTimeFormat(USAGE_POLICY_CALENDAR_LOCALE, {
    timeZone: USAGE_POLICY_TIMEZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (weekday === undefined || !Number.isInteger(hour) || !Number.isInteger(minute)) {
    controlFail("INVALID_INPUT");
  }
  const minutes = hour * 60 + minute;
  return weekday !== "Sat" && weekday !== "Sun" && minutes >= 9 * 60 && minutes < 17 * 60;
}

function expectedUsageRules(profile: UsageProfileRecord, serverNow: string): readonly UsageRuleId[] {
  const rules: UsageRuleId[] = [];
  const nowMs = timestampMs(serverNow);
  const observedMs = timestampMs(profile.snapshot.observedAt);
  if (profile.snapshot.schemaVersion !== USAGE_POLICY_SCHEMA_VERSION) rules.push("usage.schema-v3.required");
  if (
    !profile.snapshot.authoritative || profile.snapshot.sourceClass !== "provider-authoritative" ||
    profile.snapshot.sourceConfidence !== "high"
  ) rules.push("usage.authority.required");
  if (profile.authorization !== "authorized") rules.push("usage.authorization.required");
  if (profile.revocation !== "not-revoked") rules.push("usage.revocation.refused");
  if (observedMs > nowMs) rules.push("usage.future.refused");
  if (
    profile.confidence === "stale" ||
    profile.windows.fiveHour.status === "stale" || profile.windows.weekly.status === "stale"
  ) rules.push("usage.stale.refused");
  if (timestampMs(profile.snapshot.freshUntil) < nowMs) rules.push("usage.source-freshness.expired");
  if (
    profile.windows.fiveHour.status === "inactive" || profile.windows.weekly.status === "inactive"
  ) rules.push("usage.window.inactive");
  const resets = [profile.windows.fiveHour.resetAt, profile.windows.weekly.resetAt]
    .filter((value): value is string => value !== null);
  if (resets.some((value) => timestampMs(value) <= observedMs)) rules.push("usage.reset.invalid");
  if (resets.some((value) => timestampMs(value) <= nowMs)) rules.push("usage.window.expired");
  if (
    profile.ownership === "authorized-borrowed" &&
    profile.windows.fiveHour.status === "active" && profile.windows.weekly.status === "active"
  ) {
    const predicted = profile.reservations.reduce((totals, reservation) => {
      if (reservation.status !== "reserved" && reservation.status !== "reconciliation-required") return totals;
      return {
        fiveHourBp: totals.fiveHourBp + reservation.predictedFiveHourBp,
        weeklyBp: totals.weeklyBp + reservation.predictedWeeklyBp,
      };
    }, { fiveHourBp: 0, weeklyBp: 0 });
    const weeklyUsed = profile.windows.weekly.usedBp;
    const fiveHourUsed = profile.windows.fiveHour.usedBp;
    if (weeklyUsed === null || fiveHourUsed === null) controlFail("INVALID_INPUT");
    if (
      weeklyUsed >= USAGE_POLICY_BORROWED_WEEKLY_CAP_BP ||
      weeklyUsed + predicted.weeklyBp > USAGE_POLICY_BORROWED_WEEKLY_CAP_BP
    ) rules.push("usage.borrowed.weekly-70-cap");
    if (
      isLondonWorkHours(serverNow) && (
        fiveHourUsed >= USAGE_POLICY_BORROWED_FIVE_HOUR_CAP_BP ||
        fiveHourUsed + predicted.fiveHourBp > USAGE_POLICY_BORROWED_FIVE_HOUR_CAP_BP
      )
    ) rules.push("usage.borrowed.work-hours-five-hour-50-cap");
  }
  return uniqueSorted(rules);
}

function assertUsageTruth(profile: UsageProfileRecord, serverNow: string): void {
  const expectedRules = expectedUsageRules(profile, serverNow);
  const staleEvidence = expectedRules.includes("usage.source-freshness.expired") ||
    expectedRules.includes("usage.window.expired") ||
    profile.windows.fiveHour.status === "stale" || profile.windows.weekly.status === "stale";
  if (staleEvidence && profile.confidence !== "stale") controlFail("INVALID_INPUT");
  if (JSON.stringify(expectedRules) !== JSON.stringify(profile.eligibility.ruleIds)) controlFail("INVALID_INPUT");
  const windowsActive = profile.windows.fiveHour.status === "active" && profile.windows.weekly.status === "active";
  const expectedEligible = expectedRules.length === 0 && windowsActive &&
    profile.snapshot.failureCode === null && profile.confidence === "current";
  if (profile.eligibility.eligible !== expectedEligible) controlFail("INVALID_INPUT");
}

function healthPayload(record: HealthRecord, context: Readonly<ControlProjectionContext>): unknown {
  const normal = {
    serviceVersion: CONTROL_SERVICE_VERSION,
    ready: true,
    sequence: context.sequence,
    dispatchPaused: false,
    estopAvailability: "not-implemented",
    startup: {
      scope: SERVICE_STARTUP.scope,
      mode: SERVICE_STARTUP.mode,
      stoppedByRestart: SERVICE_STARTUP.stoppedByRestart,
      recoveredSessions: SERVICE_STARTUP.recoveredSessions,
      unresolvedRuns: SERVICE_STARTUP.unresolvedRuns,
      unconfirmedSessions: SERVICE_STARTUP.unconfirmedSessions,
      sweepCompletedAt: SERVICE_STARTUP.sweepCompletedAt,
    },
    providerHealth: record.providerHealth,
    probes: record.probes,
  };
  return context.audience === "normal" ? normal : {
    ...normal,
    pid: context.processId,
    nonceReference: `launch:${context.startNonce}`,
    sweepTimings: SERVICE_STARTUP.sweepTimings,
  };
}

function usagePayload(record: UsageProfileRecord, context: Readonly<ControlProjectionContext>): unknown {
  assertUsageTruth(record, context.serverNow);
  const normalWindows = {
    fiveHour: {
      status: record.windows.fiveHour.status,
      usedBp: record.windows.fiveHour.usedBp,
      remainingBp: record.windows.fiveHour.remainingBp,
      resetAt: record.windows.fiveHour.resetAt,
    },
    weekly: {
      status: record.windows.weekly.status,
      usedBp: record.windows.weekly.usedBp,
      remainingBp: record.windows.weekly.remainingBp,
      resetAt: record.windows.weekly.resetAt,
    },
  };
  const normalReservations = record.reservations.map((item) => ({
    status: item.status,
    predictedFiveHourBp: item.predictedFiveHourBp,
    predictedWeeklyBp: item.predictedWeeklyBp,
  }));
  const borrowed = record.ownership === "authorized-borrowed";
  const normal = {
    alias: record.alias,
    ownership: record.ownership,
    provider: record.provider,
    product: record.product,
    authorisedFor: AUTHORISED_FOR[record.authorisedFor],
    authorization: record.authorization,
    revocation: record.revocation,
    windows: normalWindows,
    snapshot: { observedAt: record.snapshot.observedAt, freshUntil: record.snapshot.freshUntil },
    eligibility: {
      eligible: record.eligibility.eligible,
      reasons: record.eligibility.ruleIds.map((ruleId) => usageRuleSentence(record, ruleId)),
    },
    capsInEffect: {
      fiveHour50: borrowed && isLondonWorkHours(context.serverNow),
      weekly70: borrowed,
    },
    reservations: normalReservations,
  };
  if (context.audience === "normal") return normal;
  return {
    ...normal,
    profileId: record.profileId,
    windows: {
      fiveHour: { ...normalWindows.fiveHour, windowId: record.windows.fiveHour.windowId },
      weekly: { ...normalWindows.weekly, windowId: record.windows.weekly.windowId },
    },
    snapshot: record.snapshot,
    eligibility: {
      ...normal.eligibility,
      ruleIds: record.eligibility.ruleIds,
    },
    reservations: record.reservations.map((item) => ({
      reservationId: item.reservationId,
      status: item.status,
      predictedFiveHourBp: item.predictedFiveHourBp,
      predictedWeeklyBp: item.predictedWeeklyBp,
      taskId: item.taskId,
    })),
  };
}

function usageRuleSentence(record: UsageProfileRecord, ruleId: UsageRuleId): string {
  if (
    ruleId === "usage.authority.required" &&
    record.snapshot.failureCode === "source-unavailable"
  ) return USAGE_UNAVAILABLE_SENTENCE;
  return POLICY_RULE_SENTENCES[ruleId];
}

function policyPayload(audience: ProjectionAudience): unknown {
  const catalogue = USAGE_ELIGIBILITY_RULE_IDS.map((ruleId) => audience === "normal"
    ? { sentence: POLICY_RULE_SENTENCES[ruleId] }
    : { ruleId, sentence: POLICY_RULE_SENTENCES[ruleId] });
  return {
    timezone: USAGE_POLICY_TIMEZONE,
    workHours: {
      days: USAGE_POLICY_WORK_DAYS,
      start: USAGE_POLICY_WORK_START,
      end: USAGE_POLICY_WORK_END,
      halfOpen: true,
    },
    borrowedFiveHourCapBp: USAGE_POLICY_BORROWED_FIVE_HOUR_CAP_BP,
    borrowedWeeklyCapBp: USAGE_POLICY_BORROWED_WEEKLY_CAP_BP,
    schemaVersion: USAGE_POLICY_SCHEMA_VERSION,
    ruleCatalogue: catalogue,
  };
}

function routingPayload(record: RoutingDecisionRecord, context: Readonly<ControlProjectionContext>): unknown {
  const ageMs = timestampMs(context.serverNow) - timestampMs(record.evidenceAt);
  if (ageMs < 0) controlFail("INVALID_INPUT");
  const evidenceAgeSeconds = Math.floor(ageMs / 1_000);
  if (evidenceAgeSeconds > 315_576_000) controlFail("INVALID_INPUT");
  const normal = {
    chosen: { routeAlias: record.routeAlias, agent: record.agent },
    reasons: record.reasonCodes.map((reason) => ROUTING_REASON_SENTENCES[reason]),
    decidedAt: record.decidedAt,
    evidenceAt: record.evidenceAt,
    evidenceAgeSeconds,
  };
  return context.audience === "normal" ? normal : {
    ...normal,
    taskId: record.taskId,
    decisionId: record.decisionId,
    ruleIds: record.ruleIds,
  };
}

export function createControlProjectionRuntime(value: unknown): ControlProjectionRuntime {
  const dataset = readExactRecord(value, ["health", "usageProfiles", "routingDecisions"]);
  const health = parseHealth(dataset["health"]);
  const usageProfiles = readExactArray(dataset["usageProfiles"], 32).map(parseUsageProfile);
  const routingDecisions = readExactArray(dataset["routingDecisions"], 128).map(parseRoutingDecision);
  const usageByProfile = new Map(usageProfiles.map((record) => [record.profileId, record] as const));
  const routingByTask = new Map(routingDecisions.map((record) => [record.taskId, record] as const));
  if (usageByProfile.size !== usageProfiles.length || routingByTask.size !== routingDecisions.length) {
    controlFail("INVALID_INPUT");
  }
  return Object.freeze({
    runningSessionCount(): number { return health.runningSessions; },
    health(contextValue: ControlProjectionContext): string {
      const context = parseContext(contextValue);
      return serializeEnvelope(
        context.audience === "normal" ? HEALTH_NORMAL_SCHEMA : HEALTH_DEVELOPER_SCHEMA,
        healthPayload(health, context),
        health,
        context,
      );
    },
    usagePolicyConstants(contextValue: ControlProjectionContext): string {
      const context = parseContext(contextValue);
      const metadata: ProjectionMetadata = Object.freeze({
        computedAt: context.serverNow,
        confidence: "current",
        staleReason: null,
      });
      return serializeEnvelope(
        context.audience === "normal" ? POLICY_NORMAL_SCHEMA : POLICY_DEVELOPER_SCHEMA,
        policyPayload(context.audience),
        metadata,
        context,
      );
    },
    usageProfile(profileIdValue: string, contextValue: ControlProjectionContext): string | null {
      const profileId = exactIdentifier(profileIdValue);
      const context = parseContext(contextValue);
      const record = usageByProfile.get(profileId);
      if (record === undefined) return null;
      return serializeEnvelope(
        context.audience === "normal" ? USAGE_NORMAL_SCHEMA : USAGE_DEVELOPER_SCHEMA,
        usagePayload(record, context),
        record,
        context,
        profileId,
      );
    },
    storedRoutingDecision(taskIdValue: string, contextValue: ControlProjectionContext): string | null {
      const taskId = exactIdentifier(taskIdValue);
      const context = parseContext(contextValue);
      const record = routingByTask.get(taskId);
      if (record === undefined) return null;
      return serializeEnvelope(
        context.audience === "normal" ? ROUTING_NORMAL_SCHEMA : ROUTING_DEVELOPER_SCHEMA,
        routingPayload(record, context),
        record,
        context,
      );
    },
  });
}
