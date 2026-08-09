import { validation } from "@ai-dev-os/domain";
import { SchedulerError } from "./errors.js";
import { ORCHESTRATION_SCHEMA_VERSION, PROFILE_OWNERSHIP_CLASSES, type ProfileOwnershipClass } from "./types.js";

const { ensureBoolean, ensureEnum, ensureExactKeys, ensureRecord, ensureSafeInteger, ensureString, ensureTimestamp, fail } = validation;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const USAGE_TIMEZONE = "Europe/London" as const;
export const BASIS_POINTS_FULL = 10_000;
export const BORROWED_WORK_HOURS_FIVE_HOUR_CAP = 5_000;
export const BORROWED_WEEKLY_CAP = 7_000;

export interface UsageWindowSnapshot {
  readonly usedBasisPoints: number;
  readonly remainingBasisPoints: number;
  readonly resetAt: string;
}

export interface CanonicalUsageSnapshot {
  readonly schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION;
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

/** Narrow future adapter boundary; it accepts snapshots, never credentials or UI state. */
export interface UsageSnapshotAdapter {
  readonly adapterId: string;
  readonly schemaVersion: 1;
  readAuthorizedSnapshot(profileId: string): Promise<unknown | null>;
}

function id(value: unknown, path: string): string {
  return ensureString(value, path, { maxLength: 128, pattern: ID, patternName: "identifier" });
}

function parseWindow(value: unknown, path: string): UsageWindowSnapshot {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, ["usedBasisPoints", "remainingBasisPoints", "resetAt"], path);
  const usedBasisPoints = ensureSafeInteger(input["usedBasisPoints"], `${path}.usedBasisPoints`, 0, BASIS_POINTS_FULL);
  const remainingBasisPoints = ensureSafeInteger(input["remainingBasisPoints"], `${path}.remainingBasisPoints`, 0, BASIS_POINTS_FULL);
  if (usedBasisPoints + remainingBasisPoints !== BASIS_POINTS_FULL) {
    fail(path, "contradictory_usage", "used and remaining basis points must total 10000.");
  }
  return Object.freeze({
    usedBasisPoints,
    remainingBasisPoints,
    resetAt: ensureTimestamp(input["resetAt"], `${path}.resetAt`),
  });
}

export function parseCanonicalUsageSnapshot(value: unknown, path = "usageSnapshot"): CanonicalUsageSnapshot {
  try {
    const input = ensureRecord(value, path);
    ensureExactKeys(input, [
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
    ], path);
    if (input["schemaVersion"] !== ORCHESTRATION_SCHEMA_VERSION) {
      fail(`${path}.schemaVersion`, "unsupported_schema", "must be schema version 1.");
    }
    const timezone = ensureEnum(input["timezone"], `${path}.timezone`, [USAGE_TIMEZONE] as const);
    return Object.freeze({
      schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
      snapshotId: id(input["snapshotId"], `${path}.snapshotId`),
      sourceAdapterId: id(input["sourceAdapterId"], `${path}.sourceAdapterId`),
      sourceAdapterVersion: id(input["sourceAdapterVersion"], `${path}.sourceAdapterVersion`),
      authoritative: ensureBoolean(input["authoritative"], `${path}.authoritative`),
      confidence: ensureEnum(input["confidence"], `${path}.confidence`, ["high", "medium", "low"] as const),
      profileId: id(input["profileId"], `${path}.profileId`),
      providerId: id(input["providerId"], `${path}.providerId`),
      ownership: ensureEnum(input["ownership"], `${path}.ownership`, PROFILE_OWNERSHIP_CLASSES),
      timezone,
      observedAt: ensureTimestamp(input["observedAt"], `${path}.observedAt`),
      fiveHour: parseWindow(input["fiveHour"], `${path}.fiveHour`),
      weekly: parseWindow(input["weekly"], `${path}.weekly`),
    });
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
  snapshot: CanonicalUsageSnapshot,
  now: Date,
  maximumAgeMs: number,
): UsageValidity {
  const rules: string[] = [];
  const reasons: string[] = [];
  const nowMs = now.valueOf();
  const observedMs = Date.parse(snapshot.observedAt);
  if (!snapshot.authoritative || snapshot.confidence !== "high") {
    rules.push("usage.authority.required");
    reasons.push("Usage must be authoritative and high confidence.");
  }
  if (observedMs > nowMs) {
    rules.push("usage.future.refused");
    reasons.push("Future-dated usage is refused.");
  }
  if (nowMs - observedMs > maximumAgeMs) {
    rules.push("usage.stale.refused");
    reasons.push("Usage is older than the configured freshness window.");
  }
  if (Date.parse(snapshot.fiveHour.resetAt) <= observedMs || Date.parse(snapshot.weekly.resetAt) <= observedMs) {
    rules.push("usage.reset.invalid");
    reasons.push("Usage reset times must follow the observation time.");
  }
  if (Date.parse(snapshot.fiveHour.resetAt) <= nowMs || Date.parse(snapshot.weekly.resetAt) <= nowMs) {
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
  if (weekday === undefined || !Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new SchedulerError("STATE_CORRUPTION", "Europe/London calendar projection failed.");
  }
  const weekdayWorkday = weekday !== "Sat" && weekday !== "Sun";
  const minutes = (hour * 60) + minute;
  return weekdayWorkday && minutes >= 9 * 60 && minutes < 17 * 60;
}
