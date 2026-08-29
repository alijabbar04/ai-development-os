import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_STATES, APPROVAL_DISPLAY_STATES, APPROVAL_STATES, BLOCKER_KINDS,
  PLAN_STATES, RUN_STATUS_VALUES, SESSION_DISPLAY_STATES, SESSION_STATES,
  USAGE_DISPLAY_STATES, USAGE_FRESHNESS_RULE_IDS, approvalStateDisplayWord,
  deriveProjectHealthProjection, deriveProjectSummaryProjection, deriveSessionDisplayState,
  deriveUsageDisplayState, planStateDisplayWord, presentProjectProjection,
  projectTaskRunStatus,
  type AllocationOutcome,
} from "../src/index.js";
import { cloneFixture, recordFixtures } from "./fixtures.js";

type SessionFacts = Parameters<typeof deriveSessionDisplayState>[0];
type SessionWord = (typeof SESSION_DISPLAY_STATES)[number];

function sessionProductOracle(facts: SessionFacts): SessionWord {
  if (facts.sessionState === null) {
    if (facts.runState === "succeeded") return "complete";
    if (facts.runState === "failed") return "failed";
    if (facts.runState === "cancelled" || facts.runState === "abandoned") return "stopped";
    return "queued";
  }
  const fixed: Partial<Record<NonNullable<SessionFacts["sessionState"]>, SessionWord>> = {
    requested: "starting", preparing: "starting", starting: "starting", failed: "could-not-start",
    awaiting_input: "waiting-for-you", stopping: "stopping", termination_unconfirmed: "did-not-confirm-stop",
    lost: "lost", archived: "archived",
  };
  const fixedWord = fixed[facts.sessionState];
  if (fixedWord !== undefined) return fixedWord;
  if (facts.sessionState === "orphaned") return facts.recoveryOutcome === "recovered" ? "recovered-by-restart" : "lost";
  if (facts.sessionState === "stopped") {
    if (facts.runState === "succeeded") return "complete";
    if (facts.runState === "failed") return "failed";
    return facts.resumable && facts.blockerKind === "operator-paused" ? "paused-by-you" : "stopped";
  }
  const blockerWords: Partial<Record<NonNullable<SessionFacts["blockerKind"]>, SessionWord>> = {
    "awaiting-approval": "waiting-for-you", "awaiting-clarification": "waiting-for-you", "awaiting-spending-decision": "waiting-for-you",
    "policy-denied": "blocked", "dependency-failed": "blocked", "workspace-conflict": "blocked", "production-refused": "blocked",
    "budget-exhausted": "blocked", "emergency-stop": "blocked", "usage-stale": "waiting-for-fresh-usage",
    "provider-unavailable": "rate-limited", "operator-paused": "paused-by-you",
  };
  if (facts.blockerKind === "usage-capped") return facts.allocationOutcome?.kind === "wait" && facts.allocationOutcome.reason === "usage-refresh-pending" ? "waiting-for-fresh-usage" : "paused-by-policy";
  if (facts.blockerKind !== null && blockerWords[facts.blockerKind] !== undefined) return blockerWords[facts.blockerKind]!;
  if (facts.allocationOutcome === null || facts.allocationOutcome.kind === "reserved" || facts.allocationOutcome.kind === "reroute") return "working";
  if (facts.allocationOutcome.kind === "ask") return "waiting-for-you";
  if (facts.allocationOutcome.kind === "refuse") return "blocked";
  if (facts.allocationOutcome.reason === "provider-circuit-open" || facts.allocationOutcome.reason === "capacity-pool-full") return "rate-limited";
  if (facts.allocationOutcome.reason === "usage-refresh-pending") return "waiting-for-fresh-usage";
  return "paused-by-policy";
}

describe("task to existing RUN_STATUSES projection", () => {
  it("is exhaustive over every taskState × (blockerKind ∪ null) pair", () => {
    const states = ["pending", "ready", "running", "waiting", "needs_resolution", "succeeded", "failed", "blocked", "cancelled"] as const;
    const blockers = [null, ...BLOCKER_KINDS] as const;
    const expectedByTask = {
      pending: "new", ready: "queued", running: "running", needs_resolution: "running",
      succeeded: "completed", failed: "failed", blocked: "policy-blocked", cancelled: "cancelled",
    } as const;
    for (const taskState of states) {
      for (const blockerKind of blockers) {
        const actual = projectTaskRunStatus({ taskState, blockerKind });
        expect(RUN_STATUS_VALUES).toContain(actual);
        if (taskState !== "waiting") expect(actual, `${taskState}:${blockerKind ?? "null"}`).toBe(expectedByTask[taskState]);
      }
    }
    expect(projectTaskRunStatus({ taskState: "running", blockerKind: null, liveRunState: "leased", dispatchState: "prepared" })).toBe("dispatched");
  });

  it("uses the independent waiting-blocker grouping", () => {
    const awaiting = new Set(["awaiting-approval", "awaiting-clarification", "awaiting-spending-decision"]);
    const retry = new Set(["usage-capped", "usage-stale", "provider-unavailable", "operator-paused"]);
    for (const blockerKind of [null, ...BLOCKER_KINDS] as const) {
      const expected = blockerKind !== null && awaiting.has(blockerKind)
        ? "awaiting-approval"
        : blockerKind === null || retry.has(blockerKind) ? "retry-wait" : "policy-blocked";
      expect(projectTaskRunStatus({ taskState: "waiting", blockerKind })).toBe(expected);
    }
  });
});

describe("session display projection", () => {
  const allocations: readonly (AllocationOutcome | null)[] = [
    null, { kind: "reserved" }, { kind: "reroute" }, { kind: "ask" }, { kind: "refuse" },
    { kind: "wait", reason: "provider-circuit-open" }, { kind: "wait", reason: "usage-refresh-pending" },
    { kind: "wait", reason: "five-hour-window-reset" }, { kind: "wait", reason: "weekly-window-reset" },
    { kind: "wait", reason: "work-hours-window-close" }, { kind: "wait", reason: "capacity-pool-full" },
  ];

  it("is total over the complete documented input product", () => {
    for (const runState of [null, ...AGENT_RUN_STATES] as const) {
      for (const sessionState of [null, ...SESSION_STATES] as const) {
        for (const blockerKind of [null, ...BLOCKER_KINDS] as const) {
          for (const allocationOutcome of allocations) {
            for (const resumable of [false, true]) {
              const facts = { runState, sessionState, blockerKind, allocationOutcome, resumable, recoveryOutcome: sessionState === "orphaned" ? "unresolved" as const : null };
              const actual = deriveSessionDisplayState(facts);
              expect(SESSION_DISPLAY_STATES).toContain(actual);
              expect(actual, JSON.stringify(facts)).toBe(sessionProductOracle(facts));
            }
          }
        }
      }
    }
  });

  it("has an independently selected fixture for every display state", () => {
    const base = { runState: "running", sessionState: "running", blockerKind: null, allocationOutcome: null, resumable: false, recoveryOutcome: null } as const;
    const fixtures: Readonly<Record<(typeof SESSION_DISPLAY_STATES)[number], Parameters<typeof deriveSessionDisplayState>[0]>> = {
      starting: { ...base, sessionState: "starting" }, working: base,
      "waiting-for-you": { ...base, sessionState: "awaiting_input" }, blocked: { ...base, blockerKind: "policy-denied" },
      "rate-limited": { ...base, allocationOutcome: { kind: "wait", reason: "provider-circuit-open" } },
      "paused-by-policy": { ...base, blockerKind: "usage-capped", allocationOutcome: { kind: "wait", reason: "weekly-window-reset" } },
      "waiting-for-fresh-usage": { ...base, blockerKind: "usage-stale" },
      "paused-by-you": { ...base, sessionState: "stopped", blockerKind: "operator-paused", resumable: true },
      queued: { ...base, runState: null, sessionState: null }, stopping: { ...base, sessionState: "stopping" },
      "did-not-confirm-stop": { ...base, sessionState: "termination_unconfirmed" }, stopped: { ...base, runState: "cancelled", sessionState: "stopped" },
      lost: { ...base, sessionState: "lost" }, "recovered-by-restart": { ...base, sessionState: "orphaned", recoveryOutcome: "recovered" },
      "could-not-start": { ...base, sessionState: "failed" }, complete: { ...base, runState: "succeeded", sessionState: "stopped" },
      failed: { ...base, runState: "failed", sessionState: "stopped" }, archived: { ...base, sessionState: "archived" },
    };
    expect(Object.keys(fixtures).sort()).toEqual([...SESSION_DISPLAY_STATES].sort());
    for (const state of SESSION_DISPLAY_STATES) expect(deriveSessionDisplayState(fixtures[state]), state).toBe(state);
  });

  it("gives live session safety state precedence over contradictory run terminal words", () => {
    const base = { blockerKind: null, allocationOutcome: null, resumable: false, recoveryOutcome: null } as const;
    expect(deriveSessionDisplayState({ ...base, runState: "succeeded", sessionState: "termination_unconfirmed" })).toBe("did-not-confirm-stop");
    expect(deriveSessionDisplayState({ ...base, runState: "failed", sessionState: "stopping" })).toBe("stopping");
    expect(deriveSessionDisplayState({ ...base, runState: "succeeded", sessionState: "lost" })).toBe("lost");
    expect(deriveSessionDisplayState({ ...base, runState: "failed", sessionState: "orphaned", recoveryOutcome: "recovered" })).toBe("recovered-by-restart");
    expect(deriveSessionDisplayState({ ...base, runState: "succeeded", sessionState: "stopped" })).toBe("complete");
    expect(deriveSessionDisplayState({ ...base, runState: "failed", sessionState: "stopped" })).toBe("failed");
  });
});

describe("closed display words", () => {
  it("covers every plan state including rejected", () => {
    const expected = [
      "Describing", "Needs your decisions", "Ready to review", "Needs your approval to start",
      "Not admitted — revise the brief or the scope", "Ready to start", "Running", "Reviewing a change",
      "At a checkpoint — your review", "Stopped", "Completed", "Abandoned", "Superseded",
    ];
    expect(PLAN_STATES.map(planStateDisplayWord)).toEqual(expected);
  });

  it("covers every approval record state and all reconciled refusal overlays", () => {
    const outputs = new Set(APPROVAL_STATES.map((state) => approvalStateDisplayWord(state, state === "approved" ? "standing-revocable" : "one-shot")));
    outputs.add(approvalStateDisplayWord("approved", "one-shot"));
    outputs.add(approvalStateDisplayWord("consumed", "one-shot", "digest-mismatch"));
    outputs.add(approvalStateDisplayWord("consumed", "one-shot", "failed-closed"));
    outputs.add(approvalStateDisplayWord("consumed", "one-shot", "effect-outcome-unknown"));
    expect([...outputs].sort()).toEqual([...APPROVAL_DISPLAY_STATES].sort());
  });

  it("keeps all usage display states distinct and reaches every freshness rule", () => {
    const active = { fiveHourStatus: "active", weeklyStatus: "active", authorization: "authorized", revocation: "not-revoked", ruleIds: [], failureCode: null } as const;
    const cases = [
      active,
      { ...active, fiveHourStatus: "inactive" as const },
      { ...active, weeklyStatus: "stale" as const },
      { ...active, fiveHourStatus: "unavailable" as const },
      { ...active, authorization: "ambiguous" as const },
      { ...active, ruleIds: ["usage.window.expired"] },
    ];
    expect(cases.map(deriveUsageDisplayState)).toEqual([...USAGE_DISPLAY_STATES]);
    const expectedRuleState: Readonly<Record<string, (typeof USAGE_DISPLAY_STATES)[number]>> = {
      "usage.schema-v3.required": "unavailable", "usage.authority.required": "ambiguous",
      "usage.authorization.required": "ambiguous", "usage.revocation.refused": "ambiguous",
      "usage.future.refused": "unavailable", "usage.stale.refused": "stale",
      "usage.source-freshness.expired": "stale", "usage.window.inactive": "inactive",
      "usage.reset.invalid": "unavailable", "usage.window.expired": "reset-passed",
      "usage.snapshot.exactly-one": "ambiguous",
    };
    for (const ruleId of USAGE_FRESHNESS_RULE_IDS) expect(deriveUsageDisplayState({ ...active, ruleIds: [ruleId] }), ruleId).toBe(expectedRuleState[ruleId]);
    expect(deriveUsageDisplayState({ ...active, failureCode: "source-failed" })).toBe("unavailable");
    expect(deriveUsageDisplayState({ ...active, revocation: "revoked" })).toBe("unavailable");
    expect(deriveUsageDisplayState({ ...active, ruleIds: ["usage.window.expired"], failureCode: "source-failed" })).toBe("unavailable");
    expect(deriveUsageDisplayState({ ...active, ruleIds: ["usage.window.expired", "usage.reset.invalid"] })).toBe("unavailable");
    expect(deriveUsageDisplayState({ ...active, ruleIds: ["usage.window.expired", "usage.snapshot.exactly-one"] })).toBe("ambiguous");
    expect(deriveUsageDisplayState({ ...active, weeklyStatus: "stale", ruleIds: ["usage.window.expired"] })).toBe("stale");
  });
});

describe("project projections and presentation parity", () => {
  it("derives health and summary without transcript inputs", () => {
    const project = cloneFixture(recordFixtures.project) as never;
    const plan = cloneFixture(recordFixtures["project-plan"]) as never;
    const health = deriveProjectHealthProjection({
      projectId: "prj:one", plan, blockers: [], coverage: { required: { covered: 0, total: 1 }, expectedQuality: { covered: 0, total: 1 } },
      budget: { reservedMicros: 0, actualMicros: 0, ceilingMicros: 100_000 }, capacity: [], computedAt: "2026-08-29T10:00:00.000Z", sourceSequence: 7, confidence: "current", staleReason: null,
    });
    const summary = deriveProjectSummaryProjection({ project, plan, projectStop: null, health, nextMilestone: null, needsYou: [], usage: { reservedBp: 0, actualBp: 0, currency: "GBP", estimateMicros: 0, actualMicros: 0, pricingAt: "2026-08-29T10:00:00.000Z" }, capacity: [] });
    expect(health.sourceSequence).toBe(7);
    expect(summary.displayName).toBe("Project One");
    expect(summary.planState).toBe("Describing");
    expect(summary.counts.total).toBe(1);
    const stopped = deriveProjectSummaryProjection({ project, plan, projectStop: cloneFixture(recordFixtures["project-stop"]) as never, health, nextMilestone: null, needsYou: [], usage: { reservedBp: 0, actualBp: 0, currency: "GBP", estimateMicros: 0, actualMicros: 0, pricingAt: "2026-08-29T10:00:00.000Z" }, capacity: [] });
    expect(stopped.status).toBe("stopped");
  });

  it("makes Normal a recursive authority-equivalent subset of Developer", () => {
    const value = cloneFixture(recordFixtures["project-health"]) as Record<string, unknown>;
    Object.assign(value, {
      confidence: "stale",
      staleReason: "C:\\private\\developer-diagnostic",
      openBlockers: [{ blockerId: "blk:developer-only", kind: "usage-stale", operatorActionable: false }],
    });
    const normal = presentProjectProjection({ kind: "health", value: value as never }, "normal");
    const developer = presentProjectProjection({ kind: "health", value: value as never }, "developer");
    expect(normal.authority).toBe("none"); expect(developer.authority).toBe("none");
    expect(normal.commands).toEqual([]); expect(developer.commands).toEqual([]);
    expect(normal.kind).toBe("health"); expect(developer.kind).toBe("health");
    expect("schemaVersion" in normal.value).toBe(false); expect("schemaVersion" in developer.value).toBe(true);
    expect("sourceSequence" in normal.value).toBe(false); expect("sourceSequence" in developer.value).toBe(true);
    expect(normal.value.computedAt).toBe(value["computedAt"]);
    expect("stageId" in normal.value.stageProgress[0]!).toBe(false);
    expect("blockerId" in normal.value.openBlockers[0]!).toBe(false);
    expect("profileId" in normal.value.capacity[0]!).toBe(false);
    expect(JSON.stringify(normal)).not.toContain("profile:one");
    expect(JSON.stringify(normal)).not.toContain("developer-diagnostic");
    expect(JSON.stringify(normal)).not.toContain("blk:developer-only");
    expect(JSON.stringify(developer)).toContain("profile:one");
    expect(JSON.stringify(developer)).toContain("developer-diagnostic");
    expect(Object.isFrozen(normal.value.capacity[0])).toBe(true);
    for (const key of Object.keys(normal)) expect(Object.hasOwn(developer, key), key).toBe(true);
    expect(() => presentProjectProjection({ kind: "health", value, diagnostics: { worktreePath: "C:\\hostile" } } as never, "normal")).toThrow();
  });

  it("uses an explicit recursive Normal summary schema without developer rule fields", () => {
    const project = cloneFixture(recordFixtures.project) as never;
    const plan = cloneFixture(recordFixtures["project-plan"]) as never;
    const health = deriveProjectHealthProjection({
      projectId: "prj:one", plan, blockers: [], coverage: null,
      budget: { reservedMicros: 0, actualMicros: 0, ceilingMicros: 100_000 }, capacity: [],
      computedAt: "2026-08-29T10:00:00.000Z", sourceSequence: 9, confidence: "current", staleReason: null,
    });
    const summary = deriveProjectSummaryProjection({
      project, plan, projectStop: null, health, nextMilestone: null,
      needsYou: [{ kind: "stage-gate", title: "Review the stage checkpoint", expiresAt: null, deepLink: { route: "plan", params: { projectId: "prj:one" } } }],
      usage: { reservedBp: 0, actualBp: 0, currency: "GBP", estimateMicros: 0, actualMicros: 0, pricingAt: "2026-08-29T10:00:00.000Z" },
      capacity: [{ alias: "Owned", ownership: "owned", windowStatus: "stale", eligible: false, blockingRuleId: "usage.stale.refused", resetAt: null }],
    });
    const normal = presentProjectProjection({ kind: "summary", value: summary }, "normal");
    const developer = presentProjectProjection({ kind: "summary", value: summary }, "developer");
    expect("schemaVersion" in normal.value).toBe(false);
    expect(normal.value.sourceSequence).toBe(9);
    expect(normal.value.computedAt).toBe("2026-08-29T10:00:00.000Z");
    expect(normal.value.confidence).toBe("current");
    expect("blockingRuleId" in normal.value.capacity[0]!).toBe(false);
    expect("blockingRuleId" in developer.value.capacity[0]!).toBe(true);
    expect(normal.value.needsYou[0]?.deepLink).toEqual({ route: "plan", params: { projectId: "prj:one" } });
    expect(Object.isFrozen(normal.value.needsYou[0]?.deepLink.params)).toBe(true);
  });
});
