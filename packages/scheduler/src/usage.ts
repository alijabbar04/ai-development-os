import { createHash } from "node:crypto";
import { toCanonicalJson, validation } from "@ai-dev-os/domain";
import { SchedulerError } from "./errors.js";
import { PROFILE_OWNERSHIP_CLASSES, type ProfileOwnershipClass } from "./types.js";

const {
  ensureBoolean,
  ensureEnum,
  ensureExactKeys,
  ensureRecord,
  ensureSafeInteger,
  ensureString,
  ensureTimestamp,
  fail,
} = validation;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const USAGE_SNAPSHOT_SCHEMA_VERSION = 2 as const;
export const USAGE_TIMEZONE = "Europe/London" as const;
export const BASIS_POINTS_FULL = 10_000;
export const BORROWED_WORK_HOURS_FIVE_HOUR_CAP = 5_000;
export const BORROWED_WEEKLY_CAP = 7_000;

export const USAGE_SOURCE_CLASSES = Object.freeze([
  "provider-authoritative",
  "provider-cached",
  "locally-observed",
  "calculated",
  "estimated",
] as const);
export type UsageSourceClass = (typeof USAGE_SOURCE_CLASSES)[number];

export const USAGE_AUTHORIZATION_CLASSES = Object.freeze([
  "authorized",
  "unauthorized",
  "ambiguous",
] as const);
export type UsageAuthorizationClass = (typeof USAGE_AUTHORIZATION_CLASSES)[number];

export const USAGE_REVOCATION_CLASSES = Object.freeze([
  "not-revoked",
  "revoked",
  "unknown",
] as const);
export type UsageRevocationClass = (typeof USAGE_REVOCATION_CLASSES)[number];

export interface UsageWindowSnapshot {
  readonly usedBasisPoints: number;
  readonly remainingBasisPoints: number;
  readonly resetAt: string;
}

export interface NormalizedUsageWindowSnapshot extends UsageWindowSnapshot {
  readonly windowId: string;
}

/**
 * Stage 18C canonical snapshot. It contains only scoped, non-secret identity
 * and finite provenance. Provider bodies, sessions, credentials, and account
 * display fields are deliberately outside this contract.
 */
export interface NormalizedCanonicalUsageSnapshot {
  readonly schemaVersion: typeof USAGE_SNAPSHOT_SCHEMA_VERSION;
  readonly compatibility: "native-v2" | "migrated-v1";
  readonly snapshotId: string;
  readonly sourceAdapterId: string;
  readonly sourceAdapterVersion: string;
  readonly sourceFingerprint: string;
  readonly sourceClass: UsageSourceClass;
  readonly authoritative: boolean;
  readonly confidence: "high" | "medium" | "low";
  readonly profileId: string;
  readonly providerId: string;
  readonly ownership: ProfileOwnershipClass;
  readonly authorization: UsageAuthorizationClass;
  readonly revocation: UsageRevocationClass;
  readonly timezone: typeof USAGE_TIMEZONE;
  readonly observedAt: string;
  readonly freshUntil: string;
  readonly fiveHour: NormalizedUsageWindowSnapshot;
  readonly weekly: NormalizedUsageWindowSnapshot;
}

export interface LegacyCanonicalUsageSnapshotV1 {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly sourceAdapterId: string;
  readonly sourceAdapterVersion: string;
  readonly authoritative: boolean;
  readonly confidence: "high" | "medium" | "low";
  readonly profileId: string;
  readonly providerId: string;
  readonly ownership: ProfileOwnershipClass;
  readonly timezone: typeof USAGE_TIMEZONE;
  readonly observedAt: string;
  readonly fiveHour: UsageWindowSnapshot;
  readonly weekly: UsageWindowSnapshot;
}

/** Backward-compatible public input name; parsing always returns normalized v2. */
export type CanonicalUsageSnapshot =
  | NormalizedCanonicalUsageSnapshot
  | LegacyCanonicalUsageSnapshotV1;
export type CanonicalUsageSnapshotInput = CanonicalUsageSnapshot;

/** Narrow adapter boundary; it accepts snapshots, never credentials or UI state. */
export interface UsageSnapshotReadRequest {
  readonly signal: AbortSignal;
  readonly deadline: string;
}

export interface UsageSnapshotAdapter {
  readonly adapterId: string;
  readonly schemaVersion: 1 | typeof USAGE_SNAPSHOT_SCHEMA_VERSION;
  readAuthorizedSnapshot(
    profileId: string,
    request?: UsageSnapshotReadRequest,
  ): Promise<unknown | null>;
}

function id(value: unknown, path: string): string {
  return ensureString(value, path, {
    maxLength: 128,
    pattern: ID,
    patternName: "identifier",
  });
}

function parseWindowV1(
  value: unknown,
  path: string,
): UsageWindowSnapshot {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, ["usedBasisPoints", "remainingBasisPoints", "resetAt"], path);
  const usedBasisPoints = ensureSafeInteger(
    input["usedBasisPoints"],
    `${path}.usedBasisPoints`,
    0,
    BASIS_POINTS_FULL,
  );
  const remainingBasisPoints = ensureSafeInteger(
    input["remainingBasisPoints"],
    `${path}.remainingBasisPoints`,
    0,
    BASIS_POINTS_FULL,
  );
  if (usedBasisPoints + remainingBasisPoints !== BASIS_POINTS_FULL) {
    fail(path, "contradictory_usage", "used and remaining basis points must total 10000.");
  }
  return Object.freeze({
    usedBasisPoints,
    remainingBasisPoints,
    resetAt: ensureTimestamp(input["resetAt"], `${path}.resetAt`),
  });
}

function parseWindowV2(
  value: unknown,
  path: string,
): NormalizedUsageWindowSnapshot {
  const input = ensureRecord(value, path);
  ensureExactKeys(
    input,
    ["windowId", "usedBasisPoints", "remainingBasisPoints", "resetAt"],
    path,
  );
  return Object.freeze({
    windowId: id(input["windowId"], `${path}.windowId`),
    ...parseWindowV1(
      {
        usedBasisPoints: input["usedBasisPoints"],
        remainingBasisPoints: input["remainingBasisPoints"],
        resetAt: input["resetAt"],
      },
      path,
    ),
  });
}

function stableLegacyWindowId(
  snapshot: Pick<LegacyCanonicalUsageSnapshotV1, "providerId" | "profileId">,
  name: "five-hour" | "weekly",
  resetAt: string,
): string {
  const digest = createHash("sha256")
    .update(toCanonicalJson({
      providerId: snapshot.providerId,
      profileId: snapshot.profileId,
      name,
      resetAt,
    }))
    .digest("hex")
    .slice(0, 32);
  return `legacy:${digest}`;
}

function migrateV1(
  input: Record<string, unknown>,
  path: string,
): NormalizedCanonicalUsageSnapshot {
  ensureExactKeys(
    input,
    [
      "schemaVersion",
      "snapshotId",
      "sourceAdapterId",
      "sourceAdapterVersion",
      "authoritative",
      "confidence",
      "profileId",
      "providerId",
      "ownership",
      "timezone",
      "observedAt",
      "fiveHour",
      "weekly",
    ],
    path,
  );
  const legacy: LegacyCanonicalUsageSnapshotV1 = Object.freeze({
    schemaVersion: 1,
    snapshotId: id(input["snapshotId"], `${path}.snapshotId`),
    sourceAdapterId: id(input["sourceAdapterId"], `${path}.sourceAdapterId`),
    sourceAdapterVersion: id(
      input["sourceAdapterVersion"],
      `${path}.sourceAdapterVersion`,
    ),
    authoritative: ensureBoolean(input["authoritative"], `${path}.authoritative`),
    confidence: ensureEnum(
      input["confidence"],
      `${path}.confidence`,
      ["high", "medium", "low"] as const,
    ),
    profileId: id(input["profileId"], `${path}.profileId`),
    providerId: id(input["providerId"], `${path}.providerId`),
    ownership: ensureEnum(input["ownership"], `${path}.ownership`, PROFILE_OWNERSHIP_CLASSES),
    timezone: ensureEnum(input["timezone"], `${path}.timezone`, [USAGE_TIMEZONE] as const),
    observedAt: ensureTimestamp(input["observedAt"], `${path}.observedAt`),
    fiveHour: parseWindowV1(input["fiveHour"], `${path}.fiveHour`),
    weekly: parseWindowV1(input["weekly"], `${path}.weekly`),
  });
  const sourceFingerprint = createHash("sha256")
    .update(toCanonicalJson(legacy))
    .digest("hex");
  return Object.freeze({
    schemaVersion: USAGE_SNAPSHOT_SCHEMA_VERSION,
    compatibility: "migrated-v1",
    snapshotId: legacy.snapshotId,
    sourceAdapterId: legacy.sourceAdapterId,
    sourceAdapterVersion: legacy.sourceAdapterVersion,
    sourceFingerprint,
    sourceClass: legacy.authoritative ? "provider-authoritative" : "estimated",
    authoritative: legacy.authoritative,
    confidence: legacy.confidence,
    profileId: legacy.profileId,
    providerId: legacy.providerId,
    ownership: legacy.ownership,
    // Version 1 had no authorization/revocation evidence. Preserve the data for
    // audit, but make it ineligible for Stage 18C dispatch.
    authorization: "ambiguous",
    revocation: "unknown",
    timezone: legacy.timezone,
    observedAt: legacy.observedAt,
    freshUntil: legacy.observedAt,
    fiveHour: Object.freeze({
      windowId: stableLegacyWindowId(
        legacy,
        "five-hour",
        legacy.fiveHour.resetAt,
      ),
      ...legacy.fiveHour,
    }),
    weekly: Object.freeze({
      windowId: stableLegacyWindowId(legacy, "weekly", legacy.weekly.resetAt),
      ...legacy.weekly,
    }),
  });
}

function parseV2(
  input: Record<string, unknown>,
  path: string,
): NormalizedCanonicalUsageSnapshot {
  ensureExactKeys(
    input,
    [
      "schemaVersion",
      "compatibility",
      "snapshotId",
      "sourceAdapterId",
      "sourceAdapterVersion",
      "sourceFingerprint",
      "sourceClass",
      "authoritative",
      "confidence",
      "profileId",
      "providerId",
      "ownership",
      "authorization",
      "revocation",
      "timezone",
      "observedAt",
      "freshUntil",
      "fiveHour",
      "weekly",
    ],
    path,
  );
  const compatibility = ensureEnum(
    input["compatibility"],
    `${path}.compatibility`,
    ["native-v2", "migrated-v1"] as const,
  );
  const sourceClass = ensureEnum(
    input["sourceClass"],
    `${path}.sourceClass`,
    USAGE_SOURCE_CLASSES,
  );
  const authoritative = ensureBoolean(input["authoritative"], `${path}.authoritative`);
  if (authoritative !== (sourceClass === "provider-authoritative")) {
    fail(
      `${path}.authoritative`,
      "authority_mismatch",
      "must be true exactly for provider-authoritative observations.",
    );
  }
  const observedAt = ensureTimestamp(input["observedAt"], `${path}.observedAt`);
  const freshUntil = ensureTimestamp(input["freshUntil"], `${path}.freshUntil`);
  if (freshUntil < observedAt) {
    fail(`${path}.freshUntil`, "backwards_time", "cannot precede observedAt.");
  }
  const fiveHour = parseWindowV2(input["fiveHour"], `${path}.fiveHour`);
  const weekly = parseWindowV2(input["weekly"], `${path}.weekly`);
  if (fiveHour.windowId === weekly.windowId) {
    fail(path, "ambiguous_window", "five-hour and weekly window identities must differ.");
  }
  if (freshUntil > fiveHour.resetAt || freshUntil > weekly.resetAt) {
    fail(
      `${path}.freshUntil`,
      "freshness_beyond_reset",
      "cannot outlive either provider window.",
    );
  }
  return Object.freeze({
    schemaVersion: USAGE_SNAPSHOT_SCHEMA_VERSION,
    compatibility,
    snapshotId: id(input["snapshotId"], `${path}.snapshotId`),
    sourceAdapterId: id(input["sourceAdapterId"], `${path}.sourceAdapterId`),
    sourceAdapterVersion: id(
      input["sourceAdapterVersion"],
      `${path}.sourceAdapterVersion`,
    ),
    sourceFingerprint: ensureString(
      input["sourceFingerprint"],
      `${path}.sourceFingerprint`,
      { maxLength: 64, pattern: SHA256, patternName: "lowercase SHA-256" },
    ),
    sourceClass,
    authoritative,
    confidence: ensureEnum(
      input["confidence"],
      `${path}.confidence`,
      ["high", "medium", "low"] as const,
    ),
    profileId: id(input["profileId"], `${path}.profileId`),
    providerId: id(input["providerId"], `${path}.providerId`),
    ownership: ensureEnum(input["ownership"], `${path}.ownership`, PROFILE_OWNERSHIP_CLASSES),
    authorization: ensureEnum(
      input["authorization"],
      `${path}.authorization`,
      USAGE_AUTHORIZATION_CLASSES,
    ),
    revocation: ensureEnum(
      input["revocation"],
      `${path}.revocation`,
      USAGE_REVOCATION_CLASSES,
    ),
    timezone: ensureEnum(input["timezone"], `${path}.timezone`, [USAGE_TIMEZONE] as const),
    observedAt,
    freshUntil,
    fiveHour,
    weekly,
  });
}

export function parseCanonicalUsageSnapshot(
  value: unknown,
  path = "usageSnapshot",
): NormalizedCanonicalUsageSnapshot {
  try {
    const input = ensureRecord(value, path);
    if (input["schemaVersion"] === 1) return migrateV1(input, path);
    if (input["schemaVersion"] === USAGE_SNAPSHOT_SCHEMA_VERSION) {
      return parseV2(input, path);
    }
    fail(
      `${path}.schemaVersion`,
      "unsupported_schema",
      "must be schema version 1 or 2.",
    );
    throw new SchedulerError("INVALID_TASK", "The usage snapshot schema is unsupported.");
  } catch (error) {
    if (error instanceof SchedulerError) throw error;
    throw new SchedulerError("INVALID_TASK", "The usage snapshot is invalid.", {
      cause: error instanceof Error ? error.name : typeof error,
    });
  }
}

export interface UsageValidity {
  readonly eligible: boolean;
  readonly ruleIds: readonly string[];
  readonly reasons: readonly string[];
}

export function validateUsageFreshness(
  rawSnapshot: CanonicalUsageSnapshotInput,
  now: Date,
  maximumAgeMs: number,
): UsageValidity {
  const snapshot = parseCanonicalUsageSnapshot(rawSnapshot);
  const rules: string[] = [];
  const reasons: string[] = [];
  const nowMs = now.valueOf();
  const observedMs = Date.parse(snapshot.observedAt);
  if (snapshot.compatibility !== "native-v2") {
    rules.push("usage.schema-v2.required");
    reasons.push("Legacy snapshots lack authorization, revocation, and freshness evidence.");
  }
  if (
    !snapshot.authoritative ||
    snapshot.sourceClass !== "provider-authoritative" ||
    snapshot.confidence !== "high"
  ) {
    rules.push("usage.authority.required");
    reasons.push("Usage must be provider-authoritative and high confidence.");
  }
  if (snapshot.authorization !== "authorized") {
    rules.push("usage.authorization.required");
    reasons.push("The scoped profile must be explicitly authorized.");
  }
  if (snapshot.revocation !== "not-revoked") {
    rules.push("usage.revocation.refused");
    reasons.push("Revoked or unknown profile authority is refused.");
  }
  if (observedMs > nowMs) {
    rules.push("usage.future.refused");
    reasons.push("Future-dated usage is refused.");
  }
  if (nowMs - observedMs > maximumAgeMs) {
    rules.push("usage.stale.refused");
    reasons.push("Usage is older than the configured freshness window.");
  }
  if (Date.parse(snapshot.freshUntil) < nowMs) {
    rules.push("usage.source-freshness.expired");
    reasons.push("The source-declared freshness interval has expired.");
  }
  if (
    Date.parse(snapshot.fiveHour.resetAt) <= observedMs ||
    Date.parse(snapshot.weekly.resetAt) <= observedMs
  ) {
    rules.push("usage.reset.invalid");
    reasons.push("Usage reset times must follow the observation time.");
  }
  if (
    Date.parse(snapshot.fiveHour.resetAt) <= nowMs ||
    Date.parse(snapshot.weekly.resetAt) <= nowMs
  ) {
    rules.push("usage.window.expired");
    reasons.push("An expired usage window cannot authorize routing.");
  }
  return Object.freeze({
    eligible: rules.length === 0,
    ruleIds: Object.freeze(rules),
    reasons: Object.freeze(reasons),
  });
}

export function isLondonWorkHours(instant: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: USAGE_TIMEZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (
    weekday === undefined ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute)
  ) {
    throw new SchedulerError(
      "STATE_CORRUPTION",
      "Europe/London calendar projection failed.",
    );
  }
  const weekdayWorkday = weekday !== "Sat" && weekday !== "Sun";
  const minutes = hour * 60 + minute;
  return weekdayWorkday && minutes >= 9 * 60 && minutes < 17 * 60;
}
