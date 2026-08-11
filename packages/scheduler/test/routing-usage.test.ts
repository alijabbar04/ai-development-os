import { describe, expect, it } from "vitest";
import {
  BORROWED_WEEKLY_CAP,
  BORROWED_WORK_HOURS_FIVE_HOUR_CAP,
  evaluateDispatchPolicy,
  isLondonWorkHours,
  parseCanonicalUsageSnapshot,
  parseRouteCandidate,
  policyBlockFromDecision,
  routeTask,
  validateUsageFreshness,
  type CanonicalUsageSnapshot,
  type NormalizedCanonicalUsageSnapshot,
  type RouteCandidate,
  type UsageSnapshotAdapter,
  type UsageWindowSnapshot,
} from "../src/index.js";
import { BASE_TIME, candidate, task, usageSnapshot } from "./fixtures.js";

function snapshotAt(
  instant: string,
  overrides: Partial<NormalizedCanonicalUsageSnapshot> = {},
): NormalizedCanonicalUsageSnapshot {
  const observed = new Date(Date.parse(instant) - 1_000).toISOString();
  return usageSnapshot({
    observedAt: observed,
    freshUntil: new Date(Date.parse(instant) + 15 * 60_000).toISOString(),
    fiveHour: { windowId: "window:five-hour:test", usedBasisPoints: 1_000, remainingBasisPoints: 9_000, resetAt: new Date(Date.parse(instant) + 60 * 60_000).toISOString() },
    weekly: { windowId: "window:weekly:test", usedBasisPoints: 2_000, remainingBasisPoints: 8_000, resetAt: new Date(Date.parse(instant) + 7 * 24 * 60 * 60_000).toISOString() },
    ...overrides,
  });
}

function decision(options: {
  readonly now?: string;
  readonly candidate?: RouteCandidate;
  readonly snapshots?: readonly NormalizedCanonicalUsageSnapshot[];
  readonly workloadClass?: "general" | "fable";
  readonly preference?: "balanced" | "cost" | "quality";
  readonly candidates?: readonly RouteCandidate[];
} = {}) {
  const now = options.now ?? BASE_TIME;
  const selected = options.candidate ?? candidate({ healthObservedAt: new Date(Date.parse(now) - 1_000).toISOString() });
  return routeTask({
    task: task(),
    workloadClass: options.workloadClass ?? "general",
    preference: options.preference ?? "balanced",
    candidates: options.candidates ?? [selected],
    usageSnapshots: options.snapshots ?? [snapshotAt(now)],
    now: new Date(now),
    maximumSnapshotAgeMs: 60_000,
  });
}

function borrowedAt(now: string, usedFiveHour: number, usedWeekly: number, predictedFiveHour = 0, predictedWeekly = 0) {
  const route = candidate({
    profileId: "profile:borrowed",
    ownership: "authorized-borrowed",
    healthObservedAt: new Date(Date.parse(now) - 1_000).toISOString(),
    predictedFiveHourBasisPoints: predictedFiveHour,
    predictedWeeklyBasisPoints: predictedWeekly,
  });
  const snapshot = snapshotAt(now, {
    snapshotId: "usage:borrowed:1",
    profileId: "profile:borrowed",
    ownership: "authorized-borrowed",
    fiveHour: {
      windowId: "window:five-hour:borrowed",
      usedBasisPoints: usedFiveHour,
      remainingBasisPoints: 10_000 - usedFiveHour,
      resetAt: new Date(Date.parse(now) + 60 * 60_000).toISOString(),
    },
    weekly: {
      windowId: "window:weekly:borrowed",
      usedBasisPoints: usedWeekly,
      remainingBasisPoints: 10_000 - usedWeekly,
      resetAt: new Date(Date.parse(now) + 7 * 24 * 60 * 60_000).toISOString(),
    },
  });
  return decision({ now, candidate: route, snapshots: [snapshot] });
}

describe("canonical usage snapshots", () => {
  it("parses exact source-attributed windows without credentials", () => {
    const parsed = parseCanonicalUsageSnapshot(usageSnapshot());
    expect(parsed.timezone).toBe("Europe/London");
    expect(parsed.fiveHour.usedBasisPoints + parsed.fiveHour.remainingBasisPoints).toBe(10_000);
    expect(Object.keys(parsed)).not.toContain("credential");
  });

  it.each([
    ["unknown authority", { ...usageSnapshot(), credential: "secret" }],
    ["contradictory total", { ...usageSnapshot(), weekly: { ...usageSnapshot().weekly, remainingBasisPoints: 7_999 } }],
    ["wrong timezone", { ...usageSnapshot(), timezone: "UTC" }],
    ["negative usage", { ...usageSnapshot(), fiveHour: { ...usageSnapshot().fiveHour, usedBasisPoints: -1 } }],
    ["unsupported schema", { ...usageSnapshot(), schemaVersion: 3 }],
  ])("rejects %s", (_label, value) => {
    expect(() => parseCanonicalUsageSnapshot(value)).toThrow();
  });

  it("fails freshness closed for weak, future, stale, and expired evidence", () => {
    const now = new Date(BASE_TIME);
    expect(validateUsageFreshness(usageSnapshot(), now, 60_000).eligible).toBe(true);
    expect(validateUsageFreshness(usageSnapshot({ authoritative: false, sourceClass: "estimated", confidence: "low" }), now, 60_000).ruleIds).toContain("usage.authority.required");
    expect(validateUsageFreshness(usageSnapshot({ observedAt: "2026-08-10T10:00:01.000Z" }), now, 60_000).ruleIds).toContain("usage.future.refused");
    expect(validateUsageFreshness(usageSnapshot({ observedAt: "2026-08-10T09:58:00.000Z" }), now, 60_000).ruleIds).toContain("usage.stale.refused");
    expect(validateUsageFreshness(usageSnapshot({ freshUntil: BASE_TIME, fiveHour: { ...usageSnapshot().fiveHour, resetAt: BASE_TIME } }), now, 60_000).ruleIds).toContain("usage.window.expired");
    expect(() => parseCanonicalUsageSnapshot(usageSnapshot({ fiveHour: { ...usageSnapshot().fiveHour, resetAt: "2026-08-10T09:59:00.000Z" } }))).toThrow();
  });

  it("migrates legacy snapshots for audit but never treats missing authority fields as dispatch evidence", () => {
    const current = usageSnapshot();
    const fiveHour: UsageWindowSnapshot = {
      usedBasisPoints: 1_000,
      remainingBasisPoints: 9_000,
      resetAt: current.fiveHour.resetAt,
    };
    const weekly: UsageWindowSnapshot = {
      usedBasisPoints: 2_000,
      remainingBasisPoints: 8_000,
      resetAt: current.weekly.resetAt,
    };
    const legacy: CanonicalUsageSnapshot = {
      schemaVersion: 1,
      snapshotId: current.snapshotId,
      sourceAdapterId: current.sourceAdapterId,
      sourceAdapterVersion: "version:1",
      authoritative: true,
      confidence: "high",
      profileId: current.profileId,
      providerId: current.providerId,
      ownership: current.ownership,
      timezone: current.timezone,
      observedAt: current.observedAt,
      fiveHour,
      weekly,
    };
    const legacyAdapter: UsageSnapshotAdapter = {
      adapterId: "adapter:legacy",
      schemaVersion: 1,
      async readAuthorizedSnapshot(_profileId: string) {
        return legacy;
      },
    };
    const migrated = parseCanonicalUsageSnapshot(legacy);
    expect(migrated.compatibility).toBe("migrated-v1");
    expect(validateUsageFreshness(migrated, new Date(BASE_TIME), 60_000).ruleIds).toContain("usage.schema-v2.required");
    expect(legacyAdapter.schemaVersion).toBe(1);
    expect(
      routeTask({
        task: task(),
        workloadClass: "general",
        preference: "balanced",
        candidates: [candidate()],
        usageSnapshots: [legacy],
        now: new Date(BASE_TIME),
        maximumSnapshotAgeMs: 60_000,
      }).selected,
    ).toBeNull();
  });
});

describe("Europe/London policy calendar", () => {
  it.each([
    ["summer opening", "2026-08-10T08:00:00.000Z", true],
    ["summer just before opening", "2026-08-10T07:59:00.000Z", false],
    ["summer final minute", "2026-08-10T15:59:00.000Z", true],
    ["summer 17:00", "2026-08-10T16:00:00.000Z", false],
    ["winter opening", "2026-01-12T09:00:00.000Z", true],
    ["winter 17:00", "2026-01-12T17:00:00.000Z", false],
    ["spring DST Sunday", "2026-03-29T10:00:00.000Z", false],
    ["autumn DST Sunday", "2026-10-25T10:00:00.000Z", false],
    ["Saturday", "2026-08-08T10:00:00.000Z", false],
  ])("classifies %s", (_label, instant, expected) => {
    expect(isLondonWorkHours(new Date(instant))).toBe(expected);
  });
});

describe("usage-aware authorized-profile routing", () => {
  it("selects deterministically and honors quality/cost preferences and identifier tie-breaks", () => {
    const highQuality = candidate({ candidateId: "candidate:z", profileId: "profile:z", qualityScore: 900, costScore: 100 });
    const lowCost = candidate({ candidateId: "candidate:a", profileId: "profile:a", qualityScore: 100, costScore: 900 });
    const snapshots = [usageSnapshot({ snapshotId: "usage:z", profileId: "profile:z" }), usageSnapshot({ snapshotId: "usage:a", profileId: "profile:a" })];
    expect(decision({ candidates: [lowCost, highQuality], snapshots, preference: "quality" }).selected?.candidateId).toBe("candidate:z");
    expect(decision({ candidates: [highQuality, lowCost], snapshots, preference: "cost" }).selected?.candidateId).toBe("candidate:a");
    expect(decision({ candidates: [highQuality, lowCost], snapshots, preference: "balanced" }).selected?.candidateId).toBe("candidate:a");
    expect(decision({ candidates: [highQuality, lowCost], snapshots, preference: "balanced" }).decisionId).toBe(decision({ candidates: [lowCost, highQuality], snapshots: [...snapshots].reverse(), preference: "balanced" }).decisionId);
  });

  it("enforces the borrowed weekly cap at equality and predicted overrun at all times", () => {
    expect(BORROWED_WEEKLY_CAP).toBe(7_000);
    expect(borrowedAt("2026-08-08T22:00:00.000Z", 1_000, 7_000).selected).toBeNull();
    expect(borrowedAt("2026-08-08T22:00:00.000Z", 1_000, 6_999, 0, 2).selected).toBeNull();
    // Landing on the cap is allowed; the next dispatch at the cap is refused.
    expect(borrowedAt("2026-08-08T22:00:00.000Z", 9_000, 6_999, 0, 1).selected?.profileId).toBe("profile:borrowed");
  });

  it("enforces the borrowed five-hour cap only in the half-open weekday work window", () => {
    expect(BORROWED_WORK_HOURS_FIVE_HOUR_CAP).toBe(5_000);
    expect(borrowedAt("2026-08-10T08:00:00.000Z", 5_000, 1_000).selected).toBeNull();
    expect(borrowedAt("2026-08-10T15:59:00.000Z", 4_999, 1_000, 2).selected).toBeNull();
    expect(borrowedAt("2026-08-10T15:59:00.000Z", 4_999, 1_000, 1).selected?.profileId).toBe("profile:borrowed");
    expect(borrowedAt("2026-08-10T16:00:00.000Z", 9_000, 1_000).selected?.profileId).toBe("profile:borrowed");
    expect(borrowedAt("2026-08-08T10:00:00.000Z", 9_000, 1_000).selected?.profileId).toBe("profile:borrowed");
  });

  it("never permits borrowed Fable work", () => {
    const now = BASE_TIME;
    const route = candidate({ profileId: "profile:borrowed", ownership: "authorized-borrowed" });
    const snapshot = usageSnapshot({ snapshotId: "usage:borrowed", profileId: "profile:borrowed", ownership: "authorized-borrowed" });
    const result = decision({ now, candidate: route, snapshots: [snapshot], workloadClass: "fable" });
    expect(result.selected).toBeNull();
    expect(result.considered[0]?.ruleIds).toContain("route.borrowed.fable-forbidden");
  });

  it.each([
    ["not authorized", candidate({ authorized: false }), [usageSnapshot()], "route.profile.authorization.required"],
    ["unavailable", candidate({ availability: "unavailable" }), [usageSnapshot()], "route.provider.available"],
    ["unhealthy", candidate({ health: "unavailable" }), [usageSnapshot()], "route.provider.available"],
    ["stale health", candidate({ healthObservedAt: "2026-08-10T09:00:00.000Z" }), [usageSnapshot()], "route.health.fresh"],
    ["missing capability", candidate({ capabilities: ["repository-read"] }), [usageSnapshot()], "route.capability.required"],
    ["missing permission", candidate({ permissionModes: ["scoped-autonomous"] }), [usageSnapshot()], "route.permission-mode.required"],
    ["missing usage", candidate(), [], "usage.snapshot.exactly-one"],
    ["duplicate usage", candidate(), [usageSnapshot(), usageSnapshot({ snapshotId: "usage:two" })], "usage.snapshot.exactly-one"],
    ["non-authoritative", candidate(), [usageSnapshot({ authoritative: false, sourceClass: "provider-cached" })], "usage.authority.required"],
    ["revoked", candidate(), [usageSnapshot({ revocation: "revoked" })], "usage.revocation.refused"],
    ["ambiguous authorization", candidate(), [usageSnapshot({ authorization: "ambiguous" })], "usage.authorization.required"],
    ["borrowed task unauthorized", candidate({ profileId: "profile:borrowed", ownership: "authorized-borrowed", borrowedPolicy: { taskClass: "claude-code", taskAuthorized: false, modelAllowed: true } }), [usageSnapshot({ profileId: "profile:borrowed", ownership: "authorized-borrowed" })], "route.borrowed.explicit-task-model-authorization"],
    ["borrowed model unauthorized", candidate({ profileId: "profile:borrowed", ownership: "authorized-borrowed", borrowedPolicy: { taskClass: "claude-code", taskAuthorized: true, modelAllowed: false } }), [usageSnapshot({ profileId: "profile:borrowed", ownership: "authorized-borrowed" })], "route.borrowed.explicit-task-model-authorization"],
  ] as const)("fails closed when a candidate is %s", (_label, route, snapshots, rule) => {
    const result = decision({ candidate: route, snapshots });
    expect(result.selected).toBeNull();
    expect(result.considered[0]?.ruleIds).toContain(rule);
    expect(result.considered[0]?.score).toBeNull();
  });

  it("enforces an exact requested route without treating profile identity as authority", () => {
    const exactTask = task({ requestedRoute: { providerId: "provider:fake", modelId: "model:fake", profileId: "profile:owned", ownership: "owned" } });
    const wrong = candidate({ modelId: "model:other" });
    const result = routeTask({ task: exactTask, workloadClass: "general", preference: "balanced", candidates: [wrong], usageSnapshots: [usageSnapshot()], now: new Date(BASE_TIME), maximumSnapshotAgeMs: 60_000 });
    expect(result.selected).toBeNull();
    expect(result.considered[0]?.ruleIds).toContain("route.explicit-identity.exact");
  });

  it("validates candidate envelopes and routing request bounds", () => {
    expect(parseRouteCandidate(candidate())).toEqual(candidate());
    const { borrowedPolicy: _borrowedPolicy, ...legacyOwned } = candidate();
    expect(parseRouteCandidate(legacyOwned)).toEqual(candidate());
    expect(() => parseRouteCandidate({ ...candidate(), secret: "x" })).toThrow();
    expect(() => parseRouteCandidate({ ...candidate(), predictedWeeklyBasisPoints: 10_001 })).toThrow();
    expect(() => parseRouteCandidate({ ...candidate(), borrowedPolicy: { taskClass: "claude-code", taskAuthorized: true, modelAllowed: true } })).toThrow();
    const borrowed = candidate({ ownership: "authorized-borrowed", profileId: "profile:borrowed" });
    const { borrowedPolicy: _missingPolicy, ...legacyBorrowed } = borrowed;
    expect(() => parseRouteCandidate(legacyBorrowed)).toThrow();
    expect(() => decision({ candidates: [candidate(), candidate()], snapshots: [usageSnapshot()] })).toThrow(/unique/i);
    expect(() => routeTask({ task: task(), workloadClass: "general", preference: "balanced", candidates: [], usageSnapshots: [], now: new Date("invalid"), maximumSnapshotAgeMs: 60_000 })).toThrow();
    expect(() => routeTask({ task: task(), workloadClass: "general", preference: "balanced", candidates: [], usageSnapshots: [], now: new Date(BASE_TIME), maximumSnapshotAgeMs: 0 })).toThrow();
  });
});

describe("compiled production policy", () => {
  function context(overrides: Record<string, unknown> = {}) {
    return {
      permissionMode: "contained-default" as const,
      stage17Admitted: true,
      productionEnabled: true,
      credentialsAvailable: true,
      operatorPolicyAllows: true,
      providerSafetyAllows: true,
      usageAllows: true,
      requestsElevation: false,
      operation: { taskId: "task:one", candidateId: "candidate:one", objectiveDigest: "a".repeat(64) },
      ...overrides,
    };
  }

  it("remains blocked even when every runtime input claims readiness", () => {
    const result = evaluateDispatchPolicy(context());
    expect(result.outcome).toBe("blocked");
    expect(result.ruleIds).toEqual([
      "orchestration.stage18a.production-disabled",
      "orchestration.stage17-admission.required",
    ]);
    expect(result.operationFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.humanResumable).toBe(false);
    expect(policyBlockFromDecision(result).blockId).toMatch(/^block:/);
  });

  it("reports every independent denial and never treats elevation as a permission mode", () => {
    const result = evaluateDispatchPolicy(context({
      stage17Admitted: false,
      productionEnabled: false,
      credentialsAvailable: false,
      operatorPolicyAllows: false,
      providerSafetyAllows: false,
      usageAllows: false,
      requestsElevation: true,
    }));
    expect(result.ruleIds).toContain("orchestration.stage17-admission.required");
    expect(result.ruleIds).toContain("orchestration.elevation.forbidden");
    expect(result.ruleIds).toHaveLength(7);
  });

  it("treats legacy readiness booleans as non-authorizing diagnostics", () => {
    const claimed = evaluateDispatchPolicy(context({
      stage17Admitted: true,
      productionEnabled: true,
    }));
    const refused = evaluateDispatchPolicy(context({
      stage17Admitted: false,
      productionEnabled: false,
    }));
    expect(claimed.ruleIds).toContain("orchestration.stage17-admission.required");
    expect(refused.ruleIds).toContain("orchestration.stage17-admission.required");
    expect(claimed.outcome).toBe("blocked");
    expect(refused.outcome).toBe("blocked");
  });

  it("rejects unknown policy fields and cannot make a block from an allowed decision", () => {
    expect(() => evaluateDispatchPolicy({ ...context(), credential: "hidden" } as never)).toThrow();
    expect(() => policyBlockFromDecision({ ...evaluateDispatchPolicy(context()), outcome: "allowed" })).toThrow();
  });
});
