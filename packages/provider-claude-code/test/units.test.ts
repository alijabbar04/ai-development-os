/**
 * Focused unit coverage for the pure modules: error construction and retry
 * classification, the injected scheduler ports, execution-failure
 * classification, session helpers, change-kind mapping, and the invocation
 * guards that only fire on a capability-poor CLI.
 */

import { describe, expect, it, vi } from "vitest";
import {
  ALWAYS_DENIED_TOOLS,
  CLAUDE_DETAIL_CODES,
  MCP_DENY_RULE,
  brokerFailure,
  buildInvocation,
  classifyBrokerFailure,
  failureForDetail,
  classifyRetryCategory,
  compareClaimedChanges,
  createClaudeAdapterConfiguration,
  claudeSchedulerFromManual,
  denyingArtifactSink,
  encodeInstructions,
  errorForDetailCode,
  modelMatches,
  notifyClaudeObserver,
  parseSessionMetadata,
  permissiveDevelopmentPolicy,
  resolveCompatibilityProfile,
  resumeFailureError,
  sessionPersistenceAllowed,
  systemClaudeClock,
  systemClaudeScheduler,
  toNeutralChangeKind,
  usageTotal,
  type ClaudeCliCapabilities,
  type ClaudeToolPlan,
} from "../src/index.js";
import { createCodingAgentRequest, createTrace, parseDisclosureContext } from "@ai-dev-os/providers";
import { ProcessBrokerError } from "@ai-dev-os/process-broker";

const DISCLOSURE = parseDisclosureContext({
  classification: "public",
  requiredLocality: "any",
  redactionApplied: false,
  decisionRef: null,
  retentionAllowed: true,
  loggingAllowed: true,
});

const FULL_CAPABILITIES = resolveCompatibilityProfile({
  version: "2.1.201",
  minimumCliVersion: "2.1.100",
  validatedCliVersion: "2.1.201",
}).capabilities;

const PLAN: ClaudeToolPlan = Object.freeze({
  tools: ["Read"],
  disallowedTools: [...ALWAYS_DENIED_TOOLS, MCP_DENY_RULE],
  bashPermitted: false,
  writePermitted: false,
});

function configuration(): ReturnType<typeof createClaudeAdapterConfiguration> {
  return createClaudeAdapterConfiguration({
    instanceId: "claude-code-1",
    executable: {
      toolId: "claude-code",
      executablePath: "/usr/local/bin/claude",
      platform: "linux",
      architecture: "x64",
      expectedDigestHex: null,
      immutableReference: null,
      containmentRoot: null,
      pinnedLeadingArguments: null,
    },
    permittedModels: ["fable"],
    permittedEffortLevels: ["high"],
  });
}

describe("error classification", () => {
  it("maps every documented retry category to a stable detail code", () => {
    const categories = [
      "authentication_failed",
      "oauth_org_not_allowed",
      "billing_error",
      "rate_limit",
      "overloaded",
      "invalid_request",
      "model_not_found",
      "server_error",
      "max_output_tokens",
    ];
    for (const category of categories) {
      const detail = classifyRetryCategory(category);
      expect(detail).not.toBeNull();
      expect(CLAUDE_DETAIL_CODES).toContain(detail);
    }
  });

  it("classifies an unrecognized or oversized category conservatively as unknown", () => {
    expect(classifyRetryCategory("unknown")).toBeNull();
    expect(classifyRetryCategory("something_new_in_a_later_release")).toBeNull();
    expect(classifyRetryCategory("x".repeat(200))).toBeNull();
    expect(classifyRetryCategory("")).toBeNull();
  });

  it("builds the provider error each detail code implies", () => {
    const cases: readonly [Parameters<typeof errorForDetailCode>[0], string][] = [
      ["authentication-rejected", "AUTHENTICATION_FAILED"],
      ["budget-exhausted", "QUOTA_EXCEEDED"],
      ["rate-limited", "RATE_LIMITED"],
      ["overloaded", "PROVIDER_OVERLOADED"],
      ["content-rejected", "CONTENT_REJECTED"],
      ["model-not-observed", "MODEL_UNAVAILABLE"],
      ["context-limit", "CONTEXT_LIMIT_EXCEEDED"],
      ["network-failure", "NETWORK_FAILURE"],
      ["internal", "INTERNAL_FAILURE"],
    ];
    for (const [detail, code] of cases) {
      const error = errorForDetailCode(detail, 1_500);
      expect(error.code).toBe(code);
      expect(error.details["detailCode"]).toBeDefined();
      expect(error.message).not.toContain("undefined");
    }
  });

  it("carries the provider retry-after on rate limits and overload", () => {
    expect(errorForDetailCode("rate-limited", 7_000).retry.retryAfterMs).toBe(7_000);
    expect(errorForDetailCode("overloaded", 9_000).retry.retryAfterMs).toBe(9_000);
    expect(errorForDetailCode("rate-limited", null).retry.minimumDelayMs).toBe(1_000);
    expect(errorForDetailCode("overloaded", null).retry.minimumDelayMs).toBe(2_000);
  });

  it("assigns retry dispositions that distinguish the actionable cases", () => {
    expect(errorForDetailCode("authentication-rejected", null).retry.strategy).toBe("human-action");
    expect(errorForDetailCode("model-not-observed", null).retry.strategy).toBe("alternate-model");
    expect(errorForDetailCode("rate-limited", null).retry.strategy).toBe("same-after-delay");
    expect(errorForDetailCode("content-rejected", null).retry.strategy).toBe("never");
    const network = errorForDetailCode("network-failure", null);
    expect(network.retry.operationMayStillBeRunning).toBe(true);
    expect(network.retry.idempotencyRequired).toBe(true);
  });

  it("serializes without leaking anything beyond bounded primitives", () => {
    const error = errorForDetailCode("rate-limited", 1_000);
    const json = error.toJSON();
    for (const value of Object.values(json.details)) {
      expect(["string", "number", "boolean", "object"]).toContain(typeof value);
    }
    expect(JSON.stringify(json)).not.toContain("stack");
  });
});

describe("process-broker failure classification", () => {
  it("recognizes a production refusal as itself", () => {
    for (const code of ["PRODUCTION_ISOLATION_REQUIRED", "BACKEND_INSECURE"] as const) {
      const outcome = classifyBrokerFailure(new ProcessBrokerError(code, "refused"));
      expect(outcome.productionRefusal).toBe(true);
      expect(outcome.code).toBe(code);
    }
  });

  it("does not mistake an ordinary failure for a refusal", () => {
    const outcome = classifyBrokerFailure(new ProcessBrokerError("SPAWN_FAILED", "no"));
    expect(outcome.productionRefusal).toBe(false);
    expect(outcome.code).toBe("SPAWN_FAILED");
  });

  it("classifies an unknown thrown value without inspecting it", () => {
    expect(classifyBrokerFailure(new Error("boom"))).toEqual({
      productionRefusal: false,
      code: "UNKNOWN",
    });
    expect(classifyBrokerFailure("a string")).toEqual({ productionRefusal: false, code: "UNKNOWN" });
    expect(classifyBrokerFailure(null)).toEqual({ productionRefusal: false, code: "UNKNOWN" });
  });
});

describe("detail-code to provider-error mapping", () => {
  const map = (detailCode: Parameters<typeof failureForDetail>[0]["detailCode"]): string =>
    failureForDetail({ detailCode, retryAfterMs: null, model: "fable", maxTurns: 8 }).code;

  it("maps budget and turn exhaustion to a quota failure a human must resolve", () => {
    expect(map("turn-limit-reached")).toBe("QUOTA_EXCEEDED");
    expect(map("budget-exhausted")).toBe("QUOTA_EXCEEDED");
    const turnLimit = failureForDetail({
      detailCode: "turn-limit-reached",
      retryAfterMs: null,
      model: null,
      maxTurns: 12,
    });
    expect(turnLimit.details["maxTurns"]).toBe(12);
  });

  it("maps protocol breaches to PROTOCOL_VIOLATION", () => {
    for (const detail of [
      "session-id-mismatch",
      "record-after-terminal",
      "duplicate-terminal",
      "result-contradiction",
      "unknown-state-changing-record",
      "non-monotonic-usage",
      "negative-usage",
    ] as const) {
      expect(map(detail)).toBe("PROTOCOL_VIOLATION");
    }
  });

  it("maps unreadable output to MALFORMED_RESPONSE", () => {
    for (const detail of [
      "malformed-json",
      "non-object-record",
      "prototype-pollution",
      "unsafe-number",
      "invalid-utf8",
      "record-oversized",
      "stream-oversized",
      "record-count-exceeded",
      "hostile-path",
      "missing-terminal",
    ] as const) {
      expect(map(detail)).toBe("MALFORMED_RESPONSE");
    }
  });

  it("maps model substitution to MODEL_UNAVAILABLE and names the request", () => {
    const error = failureForDetail({
      detailCode: "model-substituted",
      retryAfterMs: null,
      model: "fable",
      maxTurns: 8,
    });
    expect(error.code).toBe("MODEL_UNAVAILABLE");
    expect(error.details["requestedModel"]).toBe("fable");
    const anonymous = failureForDetail({
      detailCode: "model-substituted",
      retryAfterMs: null,
      model: null,
      maxTurns: 8,
    });
    expect(anonymous.details["requestedModel"]).toBeUndefined();
  });

  it("maps context and rate-limit details to their own codes", () => {
    expect(map("context-limit")).toBe("CONTEXT_LIMIT_EXCEEDED");
    expect(
      failureForDetail({ detailCode: "rate-limited", retryAfterMs: 3_000, model: null, maxTurns: 8 }).retry
        .retryAfterMs,
    ).toBe(3_000);
  });

  it("falls through to the shared detail-code table for anything else", () => {
    expect(map("authentication-rejected")).toBe("AUTHENTICATION_FAILED");
    expect(map("network-failure")).toBe("NETWORK_FAILURE");
    expect(map("internal")).toBe("INTERNAL_FAILURE");
  });
});

describe("process-broker error to provider-error mapping", () => {
  const map = (code: string): ReturnType<typeof brokerFailure> =>
    brokerFailure(new ProcessBrokerError(code as never, "message"));

  it("keeps a production refusal as a denial rather than a retryable failure", () => {
    for (const code of [
      "PRODUCTION_ISOLATION_REQUIRED",
      "BACKEND_INSECURE",
      "BACKEND_UNAVAILABLE",
    ]) {
      const error = map(code);
      expect(error.code).toBe("POLICY_DENIED");
      expect(error.details["detailCode"]).toBe("production-isolation-required");
      expect(error.retry.strategy).toBe("never");
    }
  });

  it("maps authorization, cancellation, deadline, and quota outcomes", () => {
    expect(map("POLICY_DENIED").code).toBe("POLICY_DENIED");
    expect(map("APPROVAL_REQUIRED").code).toBe("AUTHORIZATION_FAILED");
    expect(map("CANCELLED").code).toBe("CANCELLED");
    expect(map("DEADLINE_EXCEEDED").code).toBe("DEADLINE_EXCEEDED");
    expect(map("OUTPUT_QUOTA_EXCEEDED").code).toBe("MALFORMED_RESPONSE");
    expect(map("ENVIRONMENT_REJECTED").code).toBe("POLICY_DENIED");
    expect(map("BROKER_CLOSED").code).toBe("INTERNAL_FAILURE");
  });

  it("maps executable and workspace problems to the right neutral codes", () => {
    for (const code of [
      "EXECUTABLE_UNAVAILABLE",
      "EXECUTABLE_UNSAFE",
      "EXECUTABLE_DIGEST_MISMATCH",
      "SHELL_PROHIBITED",
    ]) {
      expect(map(code).code).toBe("UNSUPPORTED_CAPABILITY");
    }
    for (const code of ["LEASE_EXPIRED", "LEASE_INVALID", "LEASE_REVOKED", "GRANT_EXPIRED", "INVALID_GRANT"]) {
      expect(map(code).code).toBe("WORKSPACE_UNAVAILABLE");
    }
  });

  it("treats an unconfirmed process-tree termination as possibly still running", () => {
    const error = map("PROCESS_TREE_TERMINATION_FAILED");
    expect(error.code).toBe("TIMEOUT");
    expect(error.retry.operationMayStillBeRunning).toBe(true);
    expect(error.retry.idempotencyRequired).toBe(true);
  });

  it("passes an existing provider error through unchanged", () => {
    const original = errorForDetailCode("rate-limited", 500);
    expect(brokerFailure(original)).toBe(original);
  });

  it("classifies an unknown broker code and an unknown thrown value safely", () => {
    expect(map("SPAWN_FAILED").code).toBe("INTERNAL_FAILURE");
    expect(brokerFailure(new Error("boom")).code).toBe("INTERNAL_FAILURE");
    expect(brokerFailure(null).code).toBe("INTERNAL_FAILURE");
    expect(brokerFailure({ code: 42 }).code).toBe("INTERNAL_FAILURE");
    expect(JSON.stringify(brokerFailure(new Error("SENSITIVE")))).not.toContain("SENSITIVE");
  });
});

describe("injected time ports", () => {
  it("provides a real clock and a cancellable delay", async () => {
    expect(systemClaudeClock.now()).toBeInstanceOf(Date);
    expect(systemClaudeScheduler.now()).toBeInstanceOf(Date);

    const handle = systemClaudeScheduler.delay(1);
    await expect(handle.promise).resolves.toBeUndefined();

    const cancelled = systemClaudeScheduler.delay(60_000);
    cancelled.cancel();
    cancelled.cancel();
    const raced = await Promise.race([
      cancelled.promise.then(() => "resolved"),
      new Promise((done) => setTimeout(() => done("still-pending"), 20)),
    ]);
    expect(raced).toBe("still-pending");
  });

  it("adapts a manual clock without importing the test package into runtime code", async () => {
    let current = new Date("2026-08-02T00:00:00.000Z");
    const waits: number[] = [];
    const scheduler = claudeSchedulerFromManual({
      now: () => current,
      wait: async (milliseconds: number) => {
        waits.push(milliseconds);
        current = new Date(current.valueOf() + milliseconds);
      },
    });
    expect(scheduler.now().toISOString()).toBe("2026-08-02T00:00:00.000Z");
    await scheduler.delay(5_000).promise;
    expect(waits).toEqual([5_000]);
    expect(scheduler.now().toISOString()).toBe("2026-08-02T00:00:05.000Z");

    const cancelled = scheduler.delay(1_000);
    cancelled.cancel();
    const raced = await Promise.race([
      cancelled.promise.then(() => "resolved"),
      Promise.resolve("still-pending"),
    ]);
    expect(raced).toBe("still-pending");

    // A negative delay is clamped rather than rejected.
    await scheduler.delay(-10).promise;
    expect(waits.at(-1)).toBe(0);
  });
});

describe("default composition ports", () => {
  it("persists nothing through the denying artifact sink", async () => {
    await expect(
      denyingArtifactSink.write({
        category: "patch",
        kind: "patch",
        bytes: new Uint8Array([1, 2, 3]),
        classification: "public",
        mediaType: "text/x-diff",
      }),
    ).resolves.toBeNull();
  });

  it("allows a non-persisting development session through the permissive policy", async () => {
    const decision = await permissiveDevelopmentPolicy.evaluateSession({
      instanceId: "claude-code-1",
      projectId: "p",
      workspaceId: "w",
      requestId: "r",
      classification: "public",
      capabilities: ["read-files"],
      commandPolicyMode: "none",
      networkPolicy: "denied",
      approvalMode: "never",
      continuationRequested: false,
      configurationFingerprint: "f",
    });
    expect(decision.outcome).toBe("allowed");
    // Persistence is off by default even in the permissive development port.
    expect(decision.sessionPersistenceAllowed).toBe(false);
    expect(decision.approvedToolNames).toEqual([]);
  });
});

describe("observability", () => {
  it("delivers an observation to the observer", () => {
    const observer = vi.fn();
    notifyClaudeObserver(observer, {
      kind: "compatibility-warning",
      recordCategory: "weather_report",
      occurrences: 2,
    });
    expect(observer).toHaveBeenCalledOnce();
  });

  it("contains an observer that throws and does not inspect the thrown value", () => {
    const hostile = (): never => {
      throw new Error("SECRET-IN-OBSERVER-EXCEPTION");
    };
    expect(() =>
      notifyClaudeObserver(hostile, {
        kind: "compatibility-warning",
        recordCategory: "x",
        occurrences: 1,
      }),
    ).not.toThrow();
  });

  it("is a no-op when no observer is registered", () => {
    expect(() =>
      notifyClaudeObserver(undefined, {
        kind: "compatibility-warning",
        recordCategory: "x",
        occurrences: 1,
      }),
    ).not.toThrow();
  });
});

describe("session helpers", () => {
  it("requires every persistence precondition to hold", () => {
    const base = {
      continuationRequested: true,
      configuredPolicy: "explicit-continuation-only" as const,
      policyAllows: true,
      authenticationSupportsPersistence: true,
      retentionAllowed: true,
    };
    expect(sessionPersistenceAllowed(base)).toBe(true);
    expect(sessionPersistenceAllowed({ ...base, continuationRequested: false })).toBe(false);
    expect(sessionPersistenceAllowed({ ...base, configuredPolicy: "never" })).toBe(false);
    expect(sessionPersistenceAllowed({ ...base, policyAllows: false })).toBe(false);
    expect(sessionPersistenceAllowed({ ...base, authenticationSupportsPersistence: false })).toBe(false);
    expect(sessionPersistenceAllowed({ ...base, retentionAllowed: false })).toBe(false);
  });

  it("maps a resume failure to the right provider error", () => {
    expect(resumeFailureError("session-persistence-denied")).toMatchObject({ code: "POLICY_DENIED" });
    expect(resumeFailureError("resume-token-invalid")).toMatchObject({ code: "INVALID_REQUEST" });
    expect(resumeFailureError("resume-project-mismatch")).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("parses bounded session metadata and rejects anything else", () => {
    const metadata = parseSessionMetadata({
      schemaVersion: 1,
      sessionId: "00000000-0000-4000-8000-000000000001",
      instanceId: "claude-code-1",
      projectId: "proj",
      workspaceId: "ws",
      requestedModel: "fable",
      observedModel: "claude-fable-5",
      requestedEffort: "high",
      turns: 3,
      persisted: true,
      startedAt: "2026-08-02T00:00:00.000Z",
      endedAt: "2026-08-02T00:01:00.000Z",
    });
    expect(metadata.turns).toBe(3);
    expect(metadata.persisted).toBe(true);
    expect(Object.isFrozen(metadata)).toBe(true);

    const withNulls = parseSessionMetadata({
      schemaVersion: 1,
      sessionId: "00000000-0000-4000-8000-000000000001",
      instanceId: "claude-code-1",
      projectId: "proj",
      workspaceId: "ws",
      requestedModel: null,
      observedModel: null,
      requestedEffort: null,
      turns: null,
      persisted: false,
      startedAt: "2026-08-02T00:00:00.000Z",
      endedAt: "2026-08-02T00:01:00.000Z",
    });
    expect(withNulls.requestedModel).toBeNull();
    expect(withNulls.turns).toBeNull();

    expect(() => parseSessionMetadata({ schemaVersion: 1 })).toThrow();
    expect(() => parseSessionMetadata("nope")).toThrow();
  });
});

describe("model matching", () => {
  it("accepts an alias resolving to its full identifier", () => {
    expect(modelMatches("fable", "claude-fable-5")).toBe(true);
    expect(modelMatches("claude-fable-5", "claude-fable-5")).toBe(true);
    expect(modelMatches("Fable", "claude-fable-5")).toBe(true);
  });

  it("never lets Opus satisfy a request for Fable, or the reverse", () => {
    expect(modelMatches("fable", "claude-opus-5")).toBe(false);
    expect(modelMatches("opus", "claude-fable-5")).toBe(false);
    expect(modelMatches("claude-fable-5", "claude-opus-5")).toBe(false);
  });
});

describe("change-kind mapping", () => {
  it("maps every Git change kind onto the provider-neutral vocabulary", () => {
    expect(toNeutralChangeKind("added")).toBe("added");
    expect(toNeutralChangeKind("copied")).toBe("added");
    expect(toNeutralChangeKind("deleted")).toBe("deleted");
    expect(toNeutralChangeKind("renamed")).toBe("renamed");
    for (const kind of [
      "modified",
      "type-changed",
      "mode-changed",
      "submodule-changed",
      "unmerged",
    ] as const) {
      expect(toNeutralChangeKind(kind)).toBe("modified");
    }
  });

  it("compares claimed paths against actual ones in both directions", () => {
    const actual = [
      { path: "a.txt", changeKind: "modified" as const },
      { path: "b.txt", changeKind: "added" as const },
    ];
    expect(compareClaimedChanges(["a.txt", "b.txt"], actual)).toEqual({ claimedOnly: 0, actualOnly: 0 });
    expect(compareClaimedChanges(["a.txt", "z.txt"], actual)).toEqual({ claimedOnly: 1, actualOnly: 1 });
    expect(compareClaimedChanges([], actual)).toEqual({ claimedOnly: 0, actualOnly: 2 });
    expect(compareClaimedChanges(["x.txt"], [])).toEqual({ claimedOnly: 1, actualOnly: 0 });
  });
});

describe("usage arithmetic", () => {
  it("totals every reported category", () => {
    expect(
      usageTotal({
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationInputTokens: 3,
        cacheReadInputTokens: 4,
      }),
    ).toBe(10);
  });
});

describe("invocation guards on a capability-poor CLI", () => {
  const poor = (overrides: Partial<ClaudeCliCapabilities>): ClaudeCliCapabilities =>
    Object.freeze({ ...FULL_CAPABILITIES, ...overrides });

  const build = (capabilities: ClaudeCliCapabilities, extra: Record<string, unknown> = {}): unknown =>
    buildInvocation({
      configuration: configuration(),
      capabilities,
      plan: PLAN,
      model: null,
      effort: null,
      sessionId: "00000000-0000-4000-8000-000000000001",
      resumeSessionId: null,
      persistSession: false,
      budgetMicros: null,
      maxTurns: 4,
      ...extra,
    } as Parameters<typeof buildInvocation>[0]);

  it("refuses to send a flag the probed CLI does not support", () => {
    expect(() => build(poor({ modelSelection: false }), { model: "fable" })).toThrow();
    expect(() => build(poor({ effortSelection: false }), { effort: "high" })).toThrow();
    expect(() => build(poor({ budgetCap: false }), { budgetMicros: 100_000 })).toThrow();
    expect(() => build(poor({ sessionId: false }))).toThrow();
    expect(() =>
      build(poor({ resume: false }), { resumeSessionId: "00000000-0000-4000-8000-000000000002" }),
    ).toThrow();
    expect(() => build(poor({ sessionPersistenceControl: false }))).toThrow();
  });

  it("omits optional flags the CLI lacks rather than failing", () => {
    const invocation = build(poor({ partialMessages: false, settingSources: false })) as {
      args: string[];
    };
    expect(invocation.args).not.toContain("--include-partial-messages");
    expect(invocation.args).not.toContain("--setting-sources");
    // The required surface is still complete.
    expect(invocation.args).toContain("--safe-mode");
    expect(invocation.args).toContain("--strict-mcp-config");
  });

  it("sends --max-turns only when the probed CLI actually has it", () => {
    const without = build(FULL_CAPABILITIES) as { args: string[] };
    expect(without.args).not.toContain("--max-turns");
    const with_ = build(poor({ maxTurns: true })) as { args: string[] };
    expect(with_.args[with_.args.indexOf("--max-turns") + 1]).toBe("4");
  });

  it("disables all tools with an empty --tools value when none are granted", () => {
    const invocation = buildInvocation({
      configuration: configuration(),
      capabilities: FULL_CAPABILITIES,
      plan: { tools: [], disallowedTools: [MCP_DENY_RULE], bashPermitted: false, writePermitted: false },
      model: null,
      effort: null,
      sessionId: "00000000-0000-4000-8000-000000000001",
      resumeSessionId: null,
      persistSession: false,
      budgetMicros: null,
      maxTurns: 4,
    });
    expect(invocation.args[invocation.args.indexOf("--tools") + 1]).toBe("");
  });

  it("refuses a malformed session identifier at vector-assembly time", () => {
    expect(() => build(FULL_CAPABILITIES, { sessionId: "not-a-uuid" })).toThrow();
    expect(() =>
      build(FULL_CAPABILITIES, { resumeSessionId: "--injected", sessionId: "not-used" }),
    ).toThrow();
  });
});

describe("instruction encoding", () => {
  it("encodes instructions as bounded UTF-8 bytes", () => {
    const request = createCodingAgentRequest({
      requestId: "req-encode",
      workspaceId: "ws",
      instructions: "hello 🚀",
      disclosure: DISCLOSURE,
      trace: createTrace("trace-encode"),
    });
    const bytes = encodeInstructions(request, 1_000);
    expect(Buffer.from(bytes).toString("utf8")).toBe("hello 🚀");
  });

  it("refuses instructions larger than the byte ceiling", () => {
    const request = createCodingAgentRequest({
      requestId: "req-encode-big",
      workspaceId: "ws",
      instructions: "x".repeat(5_000),
      disclosure: DISCLOSURE,
      trace: createTrace("trace-encode-big"),
    });
    expect(() => encodeInstructions(request, 1_000)).toThrow();
  });
});
