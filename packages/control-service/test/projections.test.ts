import { describe, expect, it, vi } from "vitest";
import {
  CONTROL_SERVICE_STARTUP_SCOPE,
  USAGE_BORROWED_CAP_RULE_IDS,
  USAGE_ELIGIBILITY_RULE_IDS,
  USAGE_FRESHNESS_RULE_IDS,
  USAGE_POLICY_BORROWED_FIVE_HOUR_CAP_BP,
  USAGE_POLICY_BORROWED_WEEKLY_CAP_BP,
  USAGE_POLICY_CALENDAR_LOCALE,
  USAGE_POLICY_SCHEMA_VERSION,
  USAGE_POLICY_TIMEZONE,
  createControlProjectionRuntime,
  isLondonWorkHours,
  type ControlProjectionContext,
} from "../src/index.js";
import { projectionDataset } from "./testing.js";
import {
  BORROWED_WEEKLY_CAP,
  BORROWED_WORK_HOURS_FIVE_HOUR_CAP,
  USAGE_SNAPSHOT_SCHEMA_VERSION,
  USAGE_TIMEZONE,
  isLondonWorkHours as schedulerLondonWorkHours,
  parseCanonicalUsageSnapshot,
  routeTask,
} from "../../scheduler/src/index.js";
import {
  candidate as schedulerCandidate,
  task as schedulerTask,
  usageSnapshot as schedulerUsageSnapshot,
} from "../../scheduler/test/fixtures.js";

const NOW = "2026-08-26T10:00:00.000Z";
const NONCE = "a".repeat(32);
const CAP_SENTENCES = Object.freeze({
  "usage.borrowed.weekly-70-cap": "Current usage and outstanding reservations leave no weekly capacity for more work.",
  "usage.borrowed.work-hours-five-hour-50-cap": "Current usage and outstanding reservations leave no weekday work-hours capacity for more work.",
} as const);

const ROUTING_DENIAL_RULE_IDS = Object.freeze([
  "route.borrowed.explicit-task-model-authorization",
  "route.borrowed.fable-forbidden",
  "route.capability.required",
  "route.explicit-identity.exact",
  "route.health.fresh",
  "route.no-eligible-candidate",
  "route.permission-mode.required",
  "route.profile.authorization.required",
  "route.provider.available",
  ...USAGE_ELIGIBILITY_RULE_IDS,
] as const);

function cloneDataset(now = NOW): Record<string, unknown> {
  return structuredClone(projectionDataset(now));
}

function usage(dataset: Record<string, unknown>): Record<string, unknown> {
  return (dataset["usageProfiles"] as Record<string, unknown>[])[0] as Record<string, unknown>;
}

function windows(record: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return record["windows"] as Record<string, Record<string, unknown>>;
}

function snapshot(record: Record<string, unknown>): Record<string, unknown> {
  return record["snapshot"] as Record<string, unknown>;
}

function context(
  audience: "normal" | "developer" = "normal",
  serverNow = NOW,
  sequence = 1,
): ControlProjectionContext {
  return Object.freeze({ audience, serverNow, sequence, processId: 1_234, startNonce: NONCE });
}

function envelope(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

function payload(text: string): Record<string, unknown> {
  return envelope(text)["payload"] as Record<string, unknown>;
}

function setEligibility(record: Record<string, unknown>, ruleIds: readonly string[]): void {
  record["eligibility"] = { eligible: ruleIds.length === 0, ruleIds: [...ruleIds].sort() };
}

describe("C5 deterministic read projections", () => {
  it("projects truthful health fields and a strictly smaller Normal surface", () => {
    const dataset = cloneDataset();
    const runtime = createControlProjectionRuntime(dataset);
    const normalEnvelope = envelope(runtime.health(context("normal", NOW, 7)));
    const normal = normalEnvelope["payload"] as Record<string, unknown>;
    const developer = payload(runtime.health(context("developer", NOW, 8)));

    expect(normalEnvelope).toMatchObject({
      kind: "projection", sequence: 7, serverNow: NOW, computedAt: NOW,
      confidence: "current", staleReason: null, productionEnabled: false,
    });
    expect(normal).toMatchObject({
      serviceVersion: "0.1.0",
      ready: true,
      sequence: 7,
      dispatchPaused: false,
      estopAvailability: "not-implemented",
      startup: {
        scope: CONTROL_SERVICE_STARTUP_SCOPE,
        mode: "fresh",
        stoppedByRestart: 0,
        recoveredSessions: 0,
        unresolvedRuns: 0,
        unconfirmedSessions: 0,
        sweepCompletedAt: null,
      },
    });
    expect(normal).not.toHaveProperty("pid");
    expect(normal).not.toHaveProperty("nonceReference");
    expect(normal).not.toHaveProperty("sweepTimings");
    expect(developer).toMatchObject({
      pid: 1_234,
      nonceReference: `launch:${NONCE}`,
      sweepTimings: [],
    });
    expect(runtime.runningSessionCount()).toBe(0);
  });

  it("refuses unbound startup/recovery claims and credential-shaped probe versions", () => {
    for (const [field, value] of [
      ["startupMode", "adopted"],
      ["stoppedByRestart", 2],
      ["recoveredSessions", 3],
      ["unresolvedRuns", 1],
      ["sweepCompletedAt", NOW],
      ["sweepTimings", [{ step: "projections", elapsedMs: 4 }]],
    ] as const) {
      const dataset = cloneDataset();
      (dataset["health"] as Record<string, unknown>)[field] = value;
      expect(() => createControlProjectionRuntime(dataset), field).toThrow();
    }
    for (const version of ["v1.0.0-credential", `v1.0.0-${"a".repeat(40)}`]) {
      const dataset = cloneDataset();
      const health = dataset["health"] as Record<string, unknown>;
      const probes = health["probes"] as Record<string, unknown>[];
      const probe = probes[0];
      if (probe === undefined) throw new Error("fixture probe missing");
      probe["version"] = version;
      expect(() => createControlProjectionRuntime(dataset), version).toThrow();
    }
    for (const recordFor of [
      (dataset: Record<string, unknown>) => dataset["health"] as Record<string, unknown>,
      (dataset: Record<string, unknown>) =>
        (dataset["usageProfiles"] as Record<string, unknown>[])[0] as Record<string, unknown>,
      (dataset: Record<string, unknown>) =>
        (dataset["routingDecisions"] as Record<string, unknown>[])[0] as Record<string, unknown>,
    ]) {
      const unsupportedRecovery = cloneDataset();
      const record = recordFor(unsupportedRecovery);
      record["confidence"] = "stale";
      record["staleReason"] = "recovery-in-progress";
      expect(() => createControlProjectionRuntime(unsupportedRecovery)).toThrow();
    }

    const unboundedSessions = cloneDataset();
    (unboundedSessions["health"] as Record<string, unknown>)["runningSessions"] = 10_001;
    expect(() => createControlProjectionRuntime(unboundedSessions)).toThrow();
  });

  it("serves exact policy constants with product sentences in Normal and rule ids only in Developer", () => {
    const runtime = createControlProjectionRuntime(cloneDataset());
    const normalText = runtime.usagePolicyConstants(context("normal"));
    const normal = payload(normalText);
    const developerText = runtime.usagePolicyConstants(context("developer"));
    const developer = payload(developerText);
    expect(normal).toMatchObject({
      timezone: USAGE_POLICY_TIMEZONE,
      borrowedFiveHourCapBp: USAGE_POLICY_BORROWED_FIVE_HOUR_CAP_BP,
      borrowedWeeklyCapBp: USAGE_POLICY_BORROWED_WEEKLY_CAP_BP,
      schemaVersion: USAGE_POLICY_SCHEMA_VERSION,
      workHours: { start: "09:00", end: "17:00", halfOpen: true },
    });
    expect(normalText).not.toMatch(/(?:usage|route|admission|orchestration)\.[a-z0-9.-]+/u);
    expect(developerText).toContain("usage.schema-v3.required");
    expect((normal["ruleCatalogue"] as Record<string, unknown>[]).every((entry) =>
      Object.keys(entry).join(",") === "sentence")).toBe(true);
    expect((developer["ruleCatalogue"] as Record<string, unknown>[]).map((entry) => entry["ruleId"]))
      .toEqual([...USAGE_ELIGIBILITY_RULE_IDS]);
  });

  it("serves scoped usage, server-owned caps, and permitted Developer diagnostics", () => {
    const dataset = cloneDataset();
    const record = usage(dataset);
    record["ownership"] = "authorized-borrowed";
    const runtime = createControlProjectionRuntime(dataset);
    const normalText = runtime.usageProfile("profile-owned", context("normal"));
    const developerText = runtime.usageProfile("profile-owned", context("developer"));
    if (normalText === null || developerText === null) throw new Error("fixture profile missing");
    const normal = payload(normalText);
    const developer = payload(developerText);
    expect(normal).toMatchObject({
      alias: "aster",
      ownership: "authorized-borrowed",
      authorisedFor: "Development work",
      eligibility: { eligible: true, reasons: [] },
      capsInEffect: { fiveHour50: true, weekly70: true },
    });
    expect(normal).not.toHaveProperty("profileId");
    expect(JSON.stringify(normal)).not.toMatch(/windowId|reservationId|taskId|sourceClass|schemaVersion|failureCode/u);
    expect(developer).toMatchObject({
      profileId: "profile-owned",
      snapshot: { sourceClass: "provider-authoritative", schemaVersion: 3, failureCode: null },
    });
    expect(runtime.usageProfile("profile-other", context())).toBeNull();
  });

  it("relaxes only the borrowed five-hour cap outside London work hours", () => {
    const weekend = "2026-08-29T10:05:00.000Z";
    const dataset = cloneDataset(weekend);
    const record = usage(dataset);
    record["ownership"] = "authorized-borrowed";
    const source = snapshot(record);
    source["freshUntil"] = "2026-08-29T10:10:00.000Z";
    windows(record)["fiveHour"] = {
      status: "active", usedBp: 2_000, remainingBp: 8_000,
      resetAt: "2026-08-29T12:00:00.000Z", windowId: "window-five",
    };
    windows(record)["weekly"] = {
      status: "active", usedBp: 3_000, remainingBp: 7_000,
      resetAt: "2026-09-04T08:00:00.000Z", windowId: "window-weekly",
    };
    const output = createControlProjectionRuntime(dataset).usageProfile(
      "profile-owned", context("normal", weekend),
    );
    if (output === null) throw new Error("fixture profile missing");
    expect(payload(output)["capsInEffect"]).toEqual({ fiveHour50: false, weekly70: true });
    expect(isLondonWorkHours(NOW)).toBe(true);
    expect(isLondonWorkHours(weekend)).toBe(false);
    expect(USAGE_POLICY_CALENDAR_LOCALE).toBe("en-GB");
  });

  it("keeps the read projection constants and London boundary in scheduler parity", () => {
    expect(USAGE_POLICY_TIMEZONE).toBe(USAGE_TIMEZONE);
    expect(USAGE_POLICY_SCHEMA_VERSION).toBe(USAGE_SNAPSHOT_SCHEMA_VERSION);
    expect(USAGE_POLICY_BORROWED_FIVE_HOUR_CAP_BP).toBe(BORROWED_WORK_HOURS_FIVE_HOUR_CAP);
    expect(USAGE_POLICY_BORROWED_WEEKLY_CAP_BP).toBe(BORROWED_WEEKLY_CAP);
    for (const instant of [
      "2026-08-26T07:59:00.000Z",
      "2026-08-26T08:00:00.000Z",
      "2026-08-26T15:59:00.000Z",
      "2026-08-26T16:00:00.000Z",
      "2026-08-29T10:00:00.000Z",
      "2026-12-02T08:59:00.000Z",
      "2026-12-02T09:00:00.000Z",
      "2026-12-02T16:59:00.000Z",
      "2026-12-02T17:00:00.000Z",
    ]) {
      expect(isLondonWorkHours(instant), instant).toBe(schedulerLondonWorkHours(new Date(instant)));
    }
  });

  it("matches borrowed-cap current and projected boundaries inside and outside work hours", () => {
    const evaluate = (
      serverNow: string,
      fiveHourUsed: number,
      weeklyUsed: number,
      predictedFiveHour: number,
      predictedWeekly: number,
      expectedRules: readonly (typeof USAGE_BORROWED_CAP_RULE_IDS)[number][],
    ): void => {
      const dataset = cloneDataset(serverNow);
      const record = usage(dataset);
      record["ownership"] = "authorized-borrowed";
      const profileWindows = windows(record);
      profileWindows["fiveHour"] = {
        status: "active", usedBp: fiveHourUsed, remainingBp: 10_000 - fiveHourUsed,
        resetAt: serverNow === NOW ? "2026-08-26T12:00:00.000Z" : "2026-08-29T12:00:00.000Z",
        windowId: "window-five",
      };
      profileWindows["weekly"] = {
        status: "active", usedBp: weeklyUsed, remainingBp: 10_000 - weeklyUsed,
        resetAt: serverNow === NOW ? "2026-08-28T08:00:00.000Z" : "2026-09-04T08:00:00.000Z",
        windowId: "window-weekly",
      };
      const profileSnapshot = snapshot(record);
      profileSnapshot["freshUntil"] = serverNow === NOW
        ? "2026-08-26T10:05:00.000Z"
        : "2026-08-29T10:05:00.000Z";
      const reservations = record["reservations"] as Record<string, unknown>[];
      const firstReservation = reservations[0];
      if (firstReservation === undefined) throw new Error("fixture reservation missing");
      firstReservation["predictedFiveHourBp"] = predictedFiveHour;
      firstReservation["predictedWeeklyBp"] = predictedWeekly;
      setEligibility(record, expectedRules);
      const runtime = createControlProjectionRuntime(dataset);
      const output = runtime.usageProfile(
        "profile-owned", context("developer", serverNow),
      );
      const normalOutput = runtime.usageProfile("profile-owned", context("normal", serverNow));
      if (output === null || normalOutput === null) throw new Error("fixture profile missing");
      const actualRules = (payload(output)["eligibility"] as Record<string, unknown>)["ruleIds"];
      expect(actualRules).toEqual([...expectedRules].sort());
      expect((payload(normalOutput)["eligibility"] as Record<string, unknown>)["reasons"]).toEqual(
        [...expectedRules].sort().map((ruleId) => CAP_SENTENCES[ruleId]),
      );
      expect(normalOutput).not.toMatch(/usage\.borrowed|basis[-\s]+points?/iu);

      const deadline = new Date(Date.parse(serverNow) + 2 * 60 * 60_000).toISOString();
      const schedulerDecision = routeTask({
        task: schedulerTask({ createdAt: serverNow, deadline }),
        workloadClass: "general",
        preference: "balanced",
        candidates: [schedulerCandidate({
          profileId: "profile:borrowed",
          ownership: "authorized-borrowed",
          healthObservedAt: serverNow,
          predictedFiveHourBasisPoints: predictedFiveHour,
          predictedWeeklyBasisPoints: predictedWeekly,
        })],
        usageSnapshots: [schedulerUsageSnapshot({
          snapshotId: "usage:borrowed:parity",
          profileId: "profile:borrowed",
          ownership: "authorized-borrowed",
          observedAt: serverNow,
          freshUntil: profileSnapshot["freshUntil"] as string,
          fiveHour: {
            windowId: "window:five-hour:parity",
            status: "active",
            usedBasisPoints: fiveHourUsed,
            remainingBasisPoints: 10_000 - fiveHourUsed,
            resetAt: profileWindows["fiveHour"]!["resetAt"] as string,
          },
          weekly: {
            windowId: "window:weekly:parity",
            status: "active",
            usedBasisPoints: weeklyUsed,
            remainingBasisPoints: 10_000 - weeklyUsed,
            resetAt: profileWindows["weekly"]!["resetAt"] as string,
          },
        })],
        now: new Date(serverNow),
        maximumSnapshotAgeMs: 60_000,
      });
      const schedulerCapRules = (schedulerDecision.considered[0]?.ruleIds ?? [])
        .filter((ruleId) => (USAGE_BORROWED_CAP_RULE_IDS as readonly string[]).includes(ruleId))
        .sort();
      expect(schedulerCapRules).toEqual([...expectedRules].sort());
    };

    evaluate(NOW, 4_999, 6_999, 1, 1, []);
    evaluate(NOW, 5_000, 7_000, 0, 0, USAGE_BORROWED_CAP_RULE_IDS);
    evaluate(NOW, 4_990, 6_990, 11, 11, USAGE_BORROWED_CAP_RULE_IDS);
    evaluate("2026-08-29T10:00:00.000Z", 5_000, 6_999, 500, 1, []);
  });

  it("makes every committed freshness rule reachable and serves exact product reasons", () => {
    const cases: ReadonlyArray<Readonly<{
      name: string;
      expected: readonly string[];
      mutate(record: Record<string, unknown>): void;
    }>> = [
      { name: "schema", expected: ["usage.schema-v3.required"], mutate: (record) => { snapshot(record)["schemaVersion"] = 2; } },
      {
        name: "authority", expected: ["usage.authority.required"], mutate: (record) => {
          snapshot(record)["sourceClass"] = "provider-cached";
          snapshot(record)["authoritative"] = false;
        },
      },
      { name: "authorization", expected: ["usage.authorization.required"], mutate: (record) => { record["authorization"] = "ambiguous"; } },
      { name: "revocation", expected: ["usage.revocation.refused"], mutate: (record) => { record["revocation"] = "unknown"; } },
      { name: "future", expected: ["usage.future.refused"], mutate: (record) => { snapshot(record)["observedAt"] = "2026-08-26T10:01:00.000Z"; } },
      {
        name: "stale", expected: ["usage.stale.refused"], mutate: (record) => {
          record["confidence"] = "stale";
          record["staleReason"] = "sequence-lag";
        },
      },
      {
        name: "source freshness", expected: ["usage.source-freshness.expired", "usage.stale.refused"],
        mutate: (record) => {
          snapshot(record)["observedAt"] = "2026-08-26T09:55:00.000Z";
          snapshot(record)["freshUntil"] = "2026-08-26T09:59:59.999Z";
          record["confidence"] = "stale";
          record["staleReason"] = "source-freshness-expired";
        },
      },
      {
        name: "inactive", expected: ["usage.window.inactive"], mutate: (record) => {
          windows(record)["fiveHour"] = {
            status: "inactive", usedBp: null, remainingBp: null, resetAt: null, windowId: "window-five",
          };
        },
      },
      {
        name: "invalid reset", expected: ["usage.reset.invalid", "usage.window.expired", "usage.stale.refused"],
        mutate: (record) => {
          snapshot(record)["freshUntil"] = NOW;
          windows(record)["fiveHour"]!["resetAt"] = NOW;
          record["confidence"] = "stale";
          record["staleReason"] = "source-freshness-expired";
        },
      },
      {
        name: "expired window", expected: [
          "usage.source-freshness.expired", "usage.window.expired", "usage.stale.refused",
        ], mutate: (record) => {
          snapshot(record)["observedAt"] = "2026-08-26T09:00:00.000Z";
          snapshot(record)["freshUntil"] = "2026-08-26T09:20:00.000Z";
          windows(record)["fiveHour"]!["resetAt"] = "2026-08-26T09:30:00.000Z";
          record["confidence"] = "stale";
          record["staleReason"] = "source-freshness-expired";
        },
      },
    ];

    const reached = new Set<string>();
    for (const fixture of cases) {
      const dataset = cloneDataset();
      const record = usage(dataset);
      fixture.mutate(record);
      setEligibility(record, fixture.expected);
      const runtime = createControlProjectionRuntime(dataset);
      const developerText = runtime.usageProfile("profile-owned", context("developer"));
      const normalText = runtime.usageProfile("profile-owned", context("normal"));
      if (developerText === null || normalText === null) throw new Error("fixture profile missing");
      const developerEligibility = payload(developerText)["eligibility"] as Record<string, unknown>;
      const normalEligibility = payload(normalText)["eligibility"] as Record<string, unknown>;
      expect(developerEligibility["eligible"], fixture.name).toBe(false);
      expect(developerEligibility["ruleIds"], fixture.name).toEqual([...fixture.expected].sort());
      expect(normalEligibility["eligible"], fixture.name).toBe(false);
      expect(normalEligibility["reasons"], fixture.name).toHaveLength(fixture.expected.length);
      expect(normalText, fixture.name).not.toMatch(/(?:usage|route|admission|orchestration)\.[a-z0-9.-]+/u);
      fixture.expected.forEach((ruleId) => reached.add(ruleId));
    }
    expect([...reached].sort()).toEqual([...USAGE_FRESHNESS_RULE_IDS].sort());
  });

  it("preserves inactive nulls, stale last values, unavailable nulls, and past reset evidence", () => {
    const inactiveDataset = cloneDataset();
    const inactive = usage(inactiveDataset);
    windows(inactive)["fiveHour"] = {
      status: "inactive", usedBp: null, remainingBp: null, resetAt: null, windowId: "window-five",
    };
    setEligibility(inactive, ["usage.window.inactive"]);
    const inactiveText = createControlProjectionRuntime(inactiveDataset).usageProfile("profile-owned", context());
    if (inactiveText === null) throw new Error("fixture profile missing");
    expect(((payload(inactiveText)["windows"] as Record<string, unknown>)["fiveHour"])).toEqual({
      remainingBp: null, resetAt: null, status: "inactive", usedBp: null,
    });

    const staleDataset = cloneDataset();
    const stale = usage(staleDataset);
    stale["confidence"] = "stale";
    stale["staleReason"] = "source-freshness-expired";
    setEligibility(stale, ["usage.stale.refused"]);
    const staleText = createControlProjectionRuntime(staleDataset).usageProfile("profile-owned", context());
    if (staleText === null) throw new Error("fixture profile missing");
    expect(envelope(staleText)).toMatchObject({ confidence: "stale", staleReason: "source-freshness-expired" });
    expect(JSON.stringify(payload(staleText))).toContain("2000");

    const unavailableDataset = cloneDataset();
    const unavailable = usage(unavailableDataset);
    for (const name of ["fiveHour", "weekly"]) {
      windows(unavailable)[name] = {
        status: "unavailable", usedBp: null, remainingBp: null, resetAt: null, windowId: `window-${name}`,
      };
    }
    snapshot(unavailable)["failureCode"] = "source-unavailable";
    snapshot(unavailable)["sourceConfidence"] = "low";
    unavailable["confidence"] = "stale";
    unavailable["staleReason"] = "source-unavailable";
    setEligibility(unavailable, ["usage.authority.required", "usage.stale.refused"]);
    const unavailableText = createControlProjectionRuntime(unavailableDataset).usageProfile("profile-owned", context());
    if (unavailableText === null) throw new Error("fixture profile missing");
    expect(payload(unavailableText)).toMatchObject({
      eligibility: { eligible: false, reasons: [
        "Usage is unavailable; nothing is assumed about remaining capacity.",
        "Usage evidence must be current.",
      ] },
    });

    const lowConfidenceDataset = cloneDataset();
    const lowConfidence = usage(lowConfidenceDataset);
    snapshot(lowConfidence)["sourceConfidence"] = "medium";
    lowConfidence["confidence"] = "stale";
    lowConfidence["staleReason"] = "sequence-lag";
    setEligibility(lowConfidence, ["usage.authority.required", "usage.stale.refused"]);
    const lowConfidenceText = createControlProjectionRuntime(lowConfidenceDataset)
      .usageProfile("profile-owned", context());
    if (lowConfidenceText === null) throw new Error("fixture profile missing");
    expect(payload(lowConfidenceText)).toMatchObject({
      eligibility: { eligible: false, reasons: [
        "Usage must be provider-authoritative and high-confidence.",
        "Usage evidence must be current.",
      ] },
    });

    const expiredDataset = cloneDataset();
    const expired = usage(expiredDataset);
    snapshot(expired)["observedAt"] = "2026-08-26T09:00:00.000Z";
    snapshot(expired)["freshUntil"] = "2026-08-26T09:20:00.000Z";
    windows(expired)["fiveHour"]!["resetAt"] = "2026-08-26T09:30:00.000Z";
    expired["confidence"] = "stale";
    expired["staleReason"] = "source-freshness-expired";
    setEligibility(expired, [
      "usage.source-freshness.expired", "usage.window.expired", "usage.stale.refused",
    ]);
    const expiredText = createControlProjectionRuntime(expiredDataset).usageProfile("profile-owned", context());
    if (expiredText === null) throw new Error("fixture profile missing");
    expect(JSON.stringify(payload(expiredText))).toContain("2026-08-26T09:30:00.000Z");
    expect(JSON.stringify(payload(expiredText))).not.toContain("(now)");
  });

  it("refuses canonical usage contradictions at the projection boundary", () => {
    const mutations: ReadonlyArray<Readonly<{
      name: string;
      mutate(record: Record<string, unknown>): void;
    }>> = [
      {
        name: "provider authority false",
        mutate: (record) => { snapshot(record)["authoritative"] = false; },
      },
      {
        name: "non-provider authority true",
        mutate: (record) => { snapshot(record)["sourceClass"] = "provider-cached"; },
      },
      {
        name: "duplicate window identity",
        mutate: (record) => { windows(record)["weekly"]!["windowId"] = "window-five"; },
      },
      {
        name: "freshness beyond active reset",
        mutate: (record) => { snapshot(record)["freshUntil"] = "2026-08-26T12:00:00.001Z"; },
      },
      {
        name: "unavailable without failure",
        mutate: (record) => {
          windows(record)["fiveHour"] = {
            status: "unavailable", usedBp: null, remainingBp: null,
            resetAt: null, windowId: "window-five",
          };
        },
      },
      {
        name: "failure without unavailable window",
        mutate: (record) => { snapshot(record)["failureCode"] = "source-unavailable"; },
      },
      {
        name: "unavailable presented as current high-confidence evidence",
        mutate: (record) => {
          windows(record)["fiveHour"] = {
            status: "unavailable", usedBp: null, remainingBp: null,
            resetAt: null, windowId: "window-five",
          };
          snapshot(record)["failureCode"] = "source-unavailable";
        },
      },
      {
        name: "low source confidence presented as current",
        mutate: (record) => { snapshot(record)["sourceConfidence"] = "low"; },
      },
    ];
    for (const fixture of mutations) {
      const dataset = cloneDataset();
      fixture.mutate(usage(dataset));
      expect(() => createControlProjectionRuntime(dataset), fixture.name).toThrow();
    }

    const schedulerMutations: ReadonlyArray<Readonly<{
      name: string;
      mutate(record: Record<string, unknown>): void;
    }>> = [
      {
        name: "scheduler authority parity",
        mutate: (record) => { record["authoritative"] = false; },
      },
      {
        name: "scheduler window identity parity",
        mutate: (record) => {
          const fiveHour = record["fiveHour"] as Record<string, unknown>;
          const weekly = record["weekly"] as Record<string, unknown>;
          weekly["windowId"] = fiveHour["windowId"];
        },
      },
      {
        name: "scheduler reset freshness parity",
        mutate: (record) => {
          const fiveHour = record["fiveHour"] as Record<string, unknown>;
          record["freshUntil"] = new Date(Date.parse(fiveHour["resetAt"] as string) + 1).toISOString();
        },
      },
    ];
    for (const fixture of schedulerMutations) {
      const canonical = structuredClone(schedulerUsageSnapshot()) as unknown as Record<string, unknown>;
      fixture.mutate(canonical);
      expect(() => parseCanonicalUsageSnapshot(canonical as never), fixture.name).toThrow();
    }
  });

  it("uses only serverNow even when the local clock is skewed by an hour", () => {
    const runtime = createControlProjectionRuntime(cloneDataset());
    const clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(new Date("2026-08-26T09:00:00.000Z").valueOf());
    const behind = runtime.usageProfile("profile-owned", context("normal", NOW, 9));
    clock.mockReturnValue(new Date("2026-08-26T11:00:00.000Z").valueOf());
    const ahead = runtime.usageProfile("profile-owned", context("normal", NOW, 9));
    clock.mockRestore();
    expect(behind).toBe(ahead);
  });

  it("exposes only a stored routing selection and never C16 outcomes, forecasts, or model fields", () => {
    const runtime = createControlProjectionRuntime(cloneDataset());
    const normalText = runtime.storedRoutingDecision("task-one", context("normal"));
    const developerText = runtime.storedRoutingDecision("task-one", context("developer"));
    if (normalText === null || developerText === null) throw new Error("fixture route missing");
    const normal = payload(normalText);
    const developer = payload(developerText);
    expect(normal).toMatchObject({
      chosen: { routeAlias: "aster", agent: "claude-code" },
      evidenceAgeSeconds: 0,
    });
    expect(normal).not.toHaveProperty("taskId");
    expect(normal).not.toHaveProperty("decisionId");
    expect(normal).not.toHaveProperty("ruleIds");
    expect(developer).toMatchObject({
      taskId: "task-one", decisionId: "decision-one",
      ruleIds: ["route.deterministic-selection"],
    });
    expect(normalText).not.toMatch(/model|forecast|outcome|wait|reroute|ask|refuse/iu);
    expect(runtime.storedRoutingDecision("task-other", context())).toBeNull();
  });

  it("accepts only a coherent selected scheduler decision and rejects every denial family", () => {
    const schedulerDecision = routeTask({
      task: schedulerTask(),
      workloadClass: "general",
      preference: "balanced",
      candidates: [schedulerCandidate()],
      usageSnapshots: [schedulerUsageSnapshot()],
      now: new Date("2026-08-10T10:00:00.000Z"),
      maximumSnapshotAgeMs: 60_000,
    });
    expect(schedulerDecision.outcome).toBe("selected");
    expect(schedulerDecision.ruleIds).toEqual(["route.deterministic-selection"]);
    const parityDataset = cloneDataset();
    const parityRoute = (parityDataset["routingDecisions"] as Record<string, unknown>[])[0];
    if (parityRoute === undefined || schedulerDecision.selected === null) throw new Error("selected fixture missing");
    parityRoute["ruleIds"] = [...schedulerDecision.ruleIds];
    parityRoute["ownership"] = schedulerDecision.selected.ownership;
    expect(() => createControlProjectionRuntime(parityDataset)).not.toThrow();

    for (const denialRule of ROUTING_DENIAL_RULE_IDS) {
      const dataset = cloneDataset();
      const route = (dataset["routingDecisions"] as Record<string, unknown>[])[0];
      if (route === undefined) throw new Error("route fixture missing");
      route["ruleIds"] = ["route.deterministic-selection", denialRule];
      expect(() => createControlProjectionRuntime(dataset), denialRule).toThrow();
    }

    for (const mutate of [
      (route: Record<string, unknown>) => { route["reasonCodes"] = ["deterministic-selection", "owned-profile"]; },
      (route: Record<string, unknown>) => {
        route["reasonCodes"] = ["borrowed-policy", "deterministic-selection", "owned-profile", "usage-eligible"];
      },
      (route: Record<string, unknown>) => {
        route["ownership"] = "authorized-borrowed";
        route["reasonCodes"] = ["deterministic-selection", "owned-profile", "usage-eligible"];
      },
    ]) {
      const dataset = cloneDataset();
      const route = (dataset["routingDecisions"] as Record<string, unknown>[])[0];
      if (route === undefined) throw new Error("route fixture missing");
      mutate(route);
      expect(() => createControlProjectionRuntime(dataset)).toThrow();
    }

    const borrowedDataset = cloneDataset();
    const borrowedRoute = (borrowedDataset["routingDecisions"] as Record<string, unknown>[])[0];
    if (borrowedRoute === undefined) throw new Error("route fixture missing");
    borrowedRoute["ownership"] = "authorized-borrowed";
    borrowedRoute["reasonCodes"] = ["borrowed-policy", "deterministic-selection", "usage-eligible"];
    expect(() => createControlProjectionRuntime(borrowedDataset)).not.toThrow();
  });

  it("refuses unknown, cross-profile, owner, path, fingerprint, model, and credential-shaped fields", () => {
    const mutations: Array<(dataset: Record<string, unknown>) => void> = [
      (dataset) => { usage(dataset)["sourceFingerprint"] = "f".repeat(64); },
      (dataset) => { usage(dataset)["ownerIdentity"] = "borrower@example.test"; },
      (dataset) => { usage(dataset)["differentProfile"] = { profileId: "profile-other" }; },
      (dataset) => {
        ((usage(dataset)["reservations"] as Record<string, unknown>[])[0] as Record<string, unknown>)["profileId"] = "profile-other";
      },
      (dataset) => { usage(dataset)["alias"] = "C:\\Users\\private\\profile"; },
      (dataset) => {
        ((dataset["routingDecisions"] as Record<string, unknown>[])[0] as Record<string, unknown>)["model"] = "model-authored";
      },
      (dataset) => { usage(dataset)["alias"] = ["sk", "ant", "api03", "A".repeat(30)].join("-"); },
      (dataset) => { usage(dataset)["alias"] = "sourceFingerprint"; },
      (dataset) => { usage(dataset)["alias"] = "borrowedOwnerEmail"; },
    ];
    for (const mutate of mutations) {
      const dataset = cloneDataset();
      mutate(dataset);
      expect(() => createControlProjectionRuntime(dataset)).toThrow();
    }
    const positiveControl = [
      "<img onerror>", "\u202Ehidden", "x".repeat(600),
      ["sk", "ant", "api03", "A".repeat(30)].join("-"),
      `AKIA${"A".repeat(16)}`, "sha256:abc", "usage.borrowed.owner", "C:\\private\\file",
    ].join(" ");
    expect(positiveControl).toMatch(/<img|\u202E|sk-ant|AKIA|sha256:|usage\.|C:\\/u);
  });

  it("serializes deterministically inside the response bound", () => {
    const runtime = createControlProjectionRuntime(cloneDataset());
    const first = runtime.usageProfile("profile-owned", context("developer", NOW, 42));
    const second = runtime.usageProfile("profile-owned", context("developer", NOW, 42));
    expect(first).toBe(second);
    expect(Buffer.byteLength(first ?? "", "utf8")).toBeLessThan(64 * 1_024);
  });
});
