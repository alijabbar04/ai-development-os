import { describe, expect, it, vi } from "vitest";
import {
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
} from "../../scheduler/src/index.js";

const NOW = "2026-08-26T10:00:00.000Z";
const NONCE = "a".repeat(32);

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
  record["eligibility"] = { eligible: false, ruleIds: [...ruleIds].sort() };
}

describe("C5 deterministic read projections", () => {
  it("projects truthful health fields and a strictly smaller Normal surface", () => {
    const dataset = cloneDataset();
    const health = dataset["health"] as Record<string, unknown>;
    health["stoppedByRestart"] = 2;
    health["unresolvedRuns"] = 1;
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
        mode: "fresh",
        stoppedByRestart: 2,
        recoveredSessions: 0,
        unresolvedRuns: 1,
      },
    });
    expect(normal).not.toHaveProperty("pid");
    expect(normal).not.toHaveProperty("nonceReference");
    expect(normal).not.toHaveProperty("sweepTimings");
    expect(developer).toMatchObject({ pid: 1_234, nonceReference: `launch:${NONCE}` });
    expect(developer).toHaveProperty("sweepTimings");

    const falseRecovery = cloneDataset();
    (falseRecovery["health"] as Record<string, unknown>)["recoveredSessions"] = 1;
    expect(() => createControlProjectionRuntime(falseRecovery)).toThrow();
  });

  it("keeps adopted and fresh startup inputs distinct without a false fresh recovery claim", () => {
    const fresh = cloneDataset();
    const freshHealth = fresh["health"] as Record<string, unknown>;
    freshHealth["stoppedByRestart"] = 2;
    freshHealth["unresolvedRuns"] = 1;
    const adopted = cloneDataset();
    const adoptedHealth = adopted["health"] as Record<string, unknown>;
    adoptedHealth["startupMode"] = "adopted";
    adoptedHealth["recoveredSessions"] = 3;

    const freshStartup = payload(createControlProjectionRuntime(fresh).health(context()))["startup"];
    const adoptedStartup = payload(createControlProjectionRuntime(adopted).health(context()))["startup"];
    expect(freshStartup).toMatchObject({ mode: "fresh", stoppedByRestart: 2, recoveredSessions: 0, unresolvedRuns: 1 });
    expect(adoptedStartup).toMatchObject({ mode: "adopted", stoppedByRestart: 0, recoveredSessions: 3 });
    expect(freshStartup).not.toEqual(adoptedStartup);
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
      .toEqual([...USAGE_FRESHNESS_RULE_IDS]);
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

  it("makes every committed freshness rule reachable and serves exact product reasons", () => {
    const cases: ReadonlyArray<Readonly<{
      name: string;
      expected: readonly string[];
      mutate(record: Record<string, unknown>): void;
    }>> = [
      { name: "schema", expected: ["usage.schema-v3.required"], mutate: (record) => { snapshot(record)["schemaVersion"] = 2; } },
      { name: "authority", expected: ["usage.authority.required"], mutate: (record) => { snapshot(record)["authoritative"] = false; } },
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
          windows(record)["fiveHour"]!["resetAt"] = NOW;
          record["confidence"] = "stale";
          record["staleReason"] = "source-freshness-expired";
        },
      },
      {
        name: "expired window", expected: ["usage.window.expired", "usage.stale.refused"], mutate: (record) => {
          snapshot(record)["observedAt"] = "2026-08-26T09:00:00.000Z";
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
    setEligibility(unavailable, []);
    const unavailableText = createControlProjectionRuntime(unavailableDataset).usageProfile("profile-owned", context());
    if (unavailableText === null) throw new Error("fixture profile missing");
    expect(payload(unavailableText)).toMatchObject({ eligibility: { eligible: false, reasons: [] } });

    const expiredDataset = cloneDataset();
    const expired = usage(expiredDataset);
    snapshot(expired)["observedAt"] = "2026-08-26T09:00:00.000Z";
    windows(expired)["fiveHour"]!["resetAt"] = "2026-08-26T09:30:00.000Z";
    expired["confidence"] = "stale";
    expired["staleReason"] = "source-freshness-expired";
    setEligibility(expired, ["usage.window.expired", "usage.stale.refused"]);
    const expiredText = createControlProjectionRuntime(expiredDataset).usageProfile("profile-owned", context());
    if (expiredText === null) throw new Error("fixture profile missing");
    expect(JSON.stringify(payload(expiredText))).toContain("2026-08-26T09:30:00.000Z");
    expect(JSON.stringify(payload(expiredText))).not.toContain("(now)");
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
