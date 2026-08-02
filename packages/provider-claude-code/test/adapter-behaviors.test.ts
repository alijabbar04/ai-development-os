/**
 * Adapter behaviour: configuration, discovery, model and effort handling,
 * usage and cost mapping, capacity observation, session persistence, error
 * classification, and lifecycle.
 */

import { afterAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createCodingAgentRequest, createTrace, parseDisclosureContext } from "@ai-dev-os/providers";
import {
  CLAUDE_EXTENSION_NAMESPACE,
  UNKNOWN_CAPACITY,
  ageCapacitySnapshot,
  claudeConfigurationFingerprint,
  compareCliVersions,
  costSemanticsFor,
  createClaudeAdapterConfiguration,
  dollarsToMicros,
  ingestStatusSnapshot,
  inspectExecutable,
  isValidSessionId,
  mapCost,
  microsToBudgetArgument,
  mintResumeToken,
  parseTestReport,
  parseVersionBanner,
  reconcileUsage,
  resolveClaudeConfiguration,
  resolveCompatibilityProfile,
  sumModelUsage,
  toProviderUsage,
} from "../src/index.js";
import {
  HARNESS_EPOCH,
  PROJECT_ID,
  WORKSPACE_ID,
  assistantText,
  cleanupHarnessFixtures,
  createClaudeHarness,
  initRecord,
  line,
  resultRecord,
} from "./helpers/harness.js";

const DISCLOSURE = parseDisclosureContext({
  classification: "internal",
  requiredLocality: "any",
  redactionApplied: true,
  decisionRef: null,
  retentionAllowed: true,
  loggingAllowed: true,
});

afterAll(async () => {
  await cleanupHarnessFixtures();
});

function readRequest(requestId: string, overrides: Record<string, unknown> = {}) {
  return createCodingAgentRequest({
    requestId,
    workspaceId: WORKSPACE_ID,
    instructions: "read the project",
    capabilities: ["read-files"],
    disclosure: DISCLOSURE,
    trace: createTrace("trace-behaviors"),
    ...overrides,
  });
}

describe("configuration", () => {
  it("round-trips defaults and produces a stable fingerprint", () => {
    const build = (): ReturnType<typeof createClaudeAdapterConfiguration> =>
      createClaudeAdapterConfiguration({
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
        permittedModels: ["opus", "fable"],
      });
    const first = build();
    const second = build();
    expect(claudeConfigurationFingerprint(first)).toBe(claudeConfigurationFingerprint(second));
    expect(first.sessionPersistence).toBe("never");
    expect(first.permittedModels).toEqual(["opus", "fable"]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.executable)).toBe(true);
  });

  it("changes the fingerprint when a limit changes", () => {
    const base = {
      instanceId: "claude-code-1",
      executable: {
        toolId: "claude-code",
        executablePath: "/usr/local/bin/claude",
        platform: "linux" as const,
        architecture: "x64" as const,
        expectedDigestHex: null,
        immutableReference: null,
        containmentRoot: null,
        pinnedLeadingArguments: null,
      },
    };
    const a = createClaudeAdapterConfiguration({ ...base, maxTurns: 4 });
    const b = createClaudeAdapterConfiguration({ ...base, maxTurns: 5 });
    expect(claudeConfigurationFingerprint(a)).not.toBe(claudeConfigurationFingerprint(b));
  });

  it("requires the default model and effort to be permitted", () => {
    const base = {
      instanceId: "claude-code-1",
      executable: {
        toolId: "claude-code",
        executablePath: "/usr/local/bin/claude",
        platform: "linux" as const,
        architecture: "x64" as const,
        expectedDigestHex: null,
        immutableReference: null,
        containmentRoot: null,
        pinnedLeadingArguments: null,
      },
    };
    expect(() =>
      createClaudeAdapterConfiguration({ ...base, permittedModels: ["fable"], defaultModel: "opus" }),
    ).toThrow();
    expect(() =>
      createClaudeAdapterConfiguration({ ...base, permittedEffortLevels: ["low"], defaultEffort: "max" }),
    ).toThrow();
  });

  it("resolves a Stage 6 extension namespace structurally and skips foreign ones", () => {
    const executable = {
      toolId: "claude-code",
      executablePath: "/usr/local/bin/claude",
      platform: "linux" as const,
      architecture: "x64" as const,
      expectedDigestHex: null,
      immutableReference: null,
      containmentRoot: null,
      pinnedLeadingArguments: null,
    };
    const configuration = resolveClaudeConfiguration({
      instanceId: "claude-code-1",
      executable,
      extensions: [
        { namespace: "ollama", schemaVersion: 1, value: { maxTurns: 999 } },
        { namespace: CLAUDE_EXTENSION_NAMESPACE, schemaVersion: 1, value: { maxTurns: 3 } },
      ],
    });
    expect(configuration.maxTurns).toBe(3);
  });

  it("refuses an extension that restates a trusted composition field", () => {
    const executable = {
      toolId: "claude-code",
      executablePath: "/usr/local/bin/claude",
      platform: "linux" as const,
      architecture: "x64" as const,
      expectedDigestHex: null,
      immutableReference: null,
      containmentRoot: null,
      pinnedLeadingArguments: null,
    };
    expect(() =>
      resolveClaudeConfiguration({
        instanceId: "claude-code-1",
        executable,
        extensions: [
          {
            namespace: CLAUDE_EXTENSION_NAMESPACE,
            schemaVersion: 1,
            value: { executable: { executablePath: "/tmp/evil" } },
          },
        ],
      }),
    ).toThrow();
  });

  it("converts money without floating-point arithmetic escaping", () => {
    expect(dollarsToMicros(0.0123)).toBe(12_300);
    expect(dollarsToMicros(0)).toBe(0);
    expect(dollarsToMicros(-1)).toBeNull();
    expect(dollarsToMicros(Number.NaN)).toBeNull();
    expect(dollarsToMicros(Number.POSITIVE_INFINITY)).toBeNull();
    expect(dollarsToMicros(1e300)).toBeNull();
    expect(microsToBudgetArgument(250_000)).toBe("0.250000");
    expect(microsToBudgetArgument(1_500_000)).toBe("1.500000");
    expect(microsToBudgetArgument(0)).toBe("0.000000");
  });
});

describe("version parsing and the compatibility matrix", () => {
  it("parses the documented version banner", () => {
    expect(parseVersionBanner("2.1.201 (Claude Code)")).toBe("2.1.201");
    expect(parseVersionBanner("  2.1.201 (Claude Code)\n")).toBe("2.1.201");
    expect(parseVersionBanner("not a version")).toBeNull();
    expect(parseVersionBanner("2.1")).toBeNull();
    expect(parseVersionBanner("")).toBeNull();
  });

  it("orders versions correctly", () => {
    expect(compareCliVersions("2.1.201", "2.1.100")).toBe(1);
    expect(compareCliVersions("2.1.100", "2.1.201")).toBe(-1);
    expect(compareCliVersions("2.1.201", "2.1.201")).toBe(0);
    expect(compareCliVersions("2.1.201", "nonsense")).toBeNull();
  });

  it("refuses a version below the configured floor and keeps no capabilities", () => {
    const profile = resolveCompatibilityProfile({
      version: "1.9.0",
      minimumCliVersion: "2.1.100",
      validatedCliVersion: "2.1.201",
    });
    expect(profile.tier).toBe("unsupported-too-old");
    expect(profile.usableForProduction).toBe(false);
    expect(profile.capabilities.streamJsonOutput).toBe(false);
    expect(profile.missingRequiredCapabilities.length).toBeGreaterThan(0);
  });

  it("keeps the last validated capability set for a newer CLI rather than assuming more", () => {
    const profile = resolveCompatibilityProfile({
      version: "2.9.0",
      minimumCliVersion: "2.1.100",
      validatedCliVersion: "2.1.201",
    });
    expect(profile.tier).toBe("newer-than-validated");
    expect(profile.usableForProduction).toBe(true);
    // The 2.1 CLI exposes no --max-turns, so the matrix must not claim it.
    expect(profile.capabilities.maxTurns).toBe(false);
  });

  it("reports a missing executable with installation guidance and no path", async () => {
    const configuration = createClaudeAdapterConfiguration({
      instanceId: "claude-code-1",
      executable: {
        toolId: "claude-code",
        executablePath: process.platform === "win32" ? "C:/nope/claude.exe" : "/nope/claude",
        platform: process.platform === "win32" ? "win32" : "linux",
        architecture: "x64",
        expectedDigestHex: null,
        immutableReference: null,
        containmentRoot: null,
        pinnedLeadingArguments: null,
      },
    });
    const inspection = await inspectExecutable(configuration, {
      platform: process.platform === "win32" ? "win32" : "linux",
    });
    expect(inspection.ok).toBe(false);
    expect(inspection.detailCode).toBe("executable-missing");
    expect(inspection.guidance).toContain("Install Claude Code");
    expect(inspection.guidance).not.toContain("nope");
  });

  it("refuses a Windows command-script shim at discovery time", async () => {
    const configuration = createClaudeAdapterConfiguration({
      instanceId: "claude-code-1",
      executable: {
        toolId: "claude-code",
        executablePath: "C:/tools/claude-launcher.exe",
        platform: "win32",
        architecture: "x64",
        expectedDigestHex: null,
        immutableReference: null,
        containmentRoot: null,
        pinnedLeadingArguments: ["C:/tools/claude.cmd"],
      },
    });
    const inspection = await inspectExecutable(configuration, { platform: "win32" });
    expect(inspection.ok).toBe(false);
    expect(inspection.detailCode).toMatch(/executable-(shell-shim|missing)/);
  });

  it("probes the fake CLI and reports the compatible tier", async () => {
    const harness = await createClaudeHarness({
      scenario: { versionOnly: true, version: "2.1.201" },
    });
    try {
      const probe = await harness.provider.probe();
      expect(probe.status).toBe("compatible");
      expect(probe.version).toBe("2.1.201");
      expect(probe.profile.tier).toBe("supported-2-1");
      expect(harness.provider.compatibility()?.usableForProduction).toBe(true);
      const observation = harness.observations.find((entry) => entry.kind === "probe");
      expect(observation).toMatchObject({ status: "compatible", version: "2.1.201" });
    } finally {
      await harness.close();
    }
  });

  it("rejects a request when the installed CLI is too old", async () => {
    const harness = await createClaudeHarness({
      scenario: { versionOnly: true, version: "1.0.0" },
    });
    try {
      await expect(harness.provider.start(readRequest("req-old-cli"))).rejects.toMatchObject({
        code: "UNSUPPORTED_CAPABILITY",
      });
      const probe = await harness.provider.probe();
      expect(probe.status).toBe("unsupported-version");
      expect(probe.guidance).toContain("claude update");
    } finally {
      await harness.close();
    }
  });
});

describe("model and effort handling", () => {
  it("passes the requested model explicitly and never substitutes silently", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        reportedModel: "claude-fable-5",
        fragments: [line(initRecord()), line(assistantText("ok")), line(resultRecord())],
      },
    });
    try {
      const operation = await harness.provider.start(readRequest("req-model-ok", { modelId: "fable" }));
      const result = await operation.result;
      expect(result.completion).toBe("completed-no-changes");
      const terminal = harness.observations.find((entry) => entry.kind === "operation-terminal");
      expect(terminal).toMatchObject({ requestedModel: "fable", observedModel: "claude-fable-5" });
    } finally {
      await harness.close();
    }
  });

  it("accepts hyphenated model identifiers and paths", async () => {
    // Regression: the control-character guards were briefly written as the
    // range space-to-hyphen, which silently rejected every ordinary hyphenated
    // model id and file path.
    const harness = await createClaudeHarness({
      scenario: {
        reportedModel: "claude-fable-5",
        fragments: [line(initRecord()), line(resultRecord())],
        afterFiles: [
          { path: "src/my-hyphenated-file.ts", action: "write", content: "export const a = 1;\n" },
        ],
      },
      configuration: { permittedModels: ["claude-fable-5"] },
    });
    try {
      const operation = await harness.provider.start(
        readRequest("req-hyphen", {
          modelId: "claude-fable-5",
          capabilities: ["read-files", "edit-files"],
        }),
      );
      const result = await operation.result;
      expect(result.completion).toBe("completed");
      expect(result.changedFiles.map((entry) => entry.path)).toEqual(["src/my-hyphenated-file.ts"]);
    } finally {
      await harness.close();
    }
  });

  it("refuses a model the configuration does not permit", async () => {
    const harness = await createClaudeHarness({
      scenario: { fragments: [line(initRecord()), line(resultRecord())] },
    });
    try {
      await expect(
        harness.provider.start(readRequest("req-model-denied", { modelId: "sonnet" })),
      ).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
    } finally {
      await harness.close();
    }
  });

  it("refuses an effort level the configuration does not permit", async () => {
    const harness = await createClaudeHarness({
      scenario: { fragments: [line(initRecord()), line(resultRecord())] },
    });
    try {
      await expect(
        harness.provider.start(
          readRequest("req-effort-denied", {
            extensions: [{ namespace: "claude-code", key: "effort", value: "max" }],
          }),
        ),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    } finally {
      await harness.close();
    }
  });

  it("rejects an extension namespace it does not own", async () => {
    const harness = await createClaudeHarness({
      scenario: { fragments: [line(initRecord()), line(resultRecord())] },
    });
    try {
      await expect(
        harness.provider.start(
          readRequest("req-foreign-extension", {
            extensions: [{ namespace: "ollama", key: "think", value: true }],
          }),
        ),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    } finally {
      await harness.close();
    }
  });
});

describe("usage and cost", () => {
  it("maps Claude's token categories onto the disjoint domain categories", () => {
    const usage = toProviderUsage(
      {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 20,
        cacheReadInputTokens: 30,
      },
      4,
    );
    // Cache-creation tokens are billed as input; cache reads are their own
    // category; reasoning is not reported by this surface and stays zero.
    expect(usage.tokens.inputTokens).toBe(120);
    expect(usage.tokens.outputTokens).toBe(50);
    expect(usage.tokens.cachedInputTokens).toBe(30);
    expect(usage.tokens.reasoningTokens).toBe(0);
    expect(usage.toolCalls).toBe(4);
  });

  it("rejects a usage snapshot that goes backwards", () => {
    const previous = {
      inputTokens: 10,
      outputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    expect(reconcileUsage(previous, { ...previous, outputTokens: 20 }).ok).toBe(true);
    const regressed = reconcileUsage(previous, { ...previous, outputTokens: 5 });
    expect(regressed.ok).toBe(false);
    expect(regressed.ok ? null : regressed.reason).toBe("non-monotonic");
    const negative = reconcileUsage(previous, { ...previous, outputTokens: -1 });
    expect(negative.ok).toBe(false);
    expect(negative.ok ? null : negative.reason).toBe("negative");
  });

  it("sums per-model usage deterministically", () => {
    expect(
      sumModelUsage([
        {
          model: "a",
          inputTokens: 1,
          outputTokens: 2,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 4,
          costMicros: null,
        },
        {
          model: "b",
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 30,
          cacheCreationInputTokens: 40,
          costMicros: null,
        },
      ]),
    ).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadInputTokens: 33,
      cacheCreationInputTokens: 44,
    });
  });

  it("reports API-key cost as billed and subscription cost as unknown", () => {
    expect(costSemanticsFor("api-key-secret-ref")).toBe("billed-api-cost");
    expect(costSemanticsFor("enterprise-gateway")).toBe("billed-api-cost");
    expect(costSemanticsFor("personal-local-cli-login")).toBe("subscription-equivalent-estimate");

    const billed = mapCost({ reportedMicros: 12_300, authenticationMode: "api-key-secret-ref" });
    expect(billed.semantics).toBe("billed-api-cost");
    expect(billed.cost.providerReported).toEqual({ currency: "USD", amountMicros: 12_300 });

    // A subscription figure is an API-equivalent estimate for work billed
    // another way, so it is never presented as a charge.
    const subscription = mapCost({
      reportedMicros: 12_300,
      authenticationMode: "personal-local-cli-login",
    });
    expect(subscription.semantics).toBe("subscription-equivalent-estimate");
    expect(subscription.cost.providerReported).toBeNull();
    expect(subscription.cost.locallyComputed).toBeNull();
    expect(subscription.reportedMicros).toBe(12_300);

    const absent = mapCost({ reportedMicros: null, authenticationMode: "api-key-secret-ref" });
    expect(absent.semantics).toBe("unknown");
    expect(absent.cost.providerReported).toBeNull();
  });

  it("reports the cost Claude actually returned on a real session", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [line(initRecord()), line(resultRecord({ total_cost_usd: 0.5 }))],
      },
    });
    try {
      const operation = await harness.provider.start(readRequest("req-cost"));
      const result = await operation.result;
      expect(result.cost.providerReported).toEqual({ currency: "USD", amountMicros: 500_000 });
      expect(result.cost.locallyComputed).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("reports unknown cost when Claude reported none", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [line(initRecord()), line(resultRecord({ total_cost_usd: null }))],
      },
    });
    try {
      const operation = await harness.provider.start(readRequest("req-no-cost"));
      const result = await operation.result;
      expect(result.cost.providerReported).toBeNull();
      expect(result.cost.locallyComputed).toBeNull();
    } finally {
      await harness.close();
    }
  });
});

describe("capacity observations", () => {
  it("ingests a host-supplied status snapshot without scraping anything", () => {
    const snapshot = ingestStatusSnapshot({
      document: JSON.stringify({
        model: { id: "claude-opus-5", display_name: "Opus" },
        effort: { level: "high" },
        rate_limits: {
          five_hour: { used_percentage: 23.5, resets_at: 1_738_425_600 },
          seven_day: { used_percentage: 41.2, resets_at: 1_738_857_600 },
        },
      }),
      observedAt: HARNESS_EPOCH,
      stalenessMs: 300_000,
    });
    expect(snapshot.status).toBe("known");
    expect(snapshot.source).toBe("host-supplied-status-snapshot");
    expect(snapshot.fiveHour.usedPercentage).toBe(23.5);
    expect(snapshot.fiveHour.resetsAt).toBe(new Date(1_738_425_600_000).toISOString());
    expect(snapshot.sevenDay.usedPercentage).toBe(41.2);
    expect(snapshot.model).toBe("claude-opus-5");
    expect(snapshot.effort).toBe("high");
  });

  it("treats missing quota data as unknown rather than zero", () => {
    for (const document of [
      "{}",
      '{"rate_limits":{}}',
      '{"rate_limits":{"five_hour":{}}}',
      "not json",
      "[]",
    ]) {
      const snapshot = ingestStatusSnapshot({
        document,
        observedAt: HARNESS_EPOCH,
        stalenessMs: 300_000,
      });
      expect(snapshot.status).toBe("unknown");
      expect(snapshot.fiveHour.usedPercentage).toBeNull();
      expect(snapshot.fiveHour.usedPercentage).not.toBe(0);
    }
  });

  it("does not claim a reset time that was not observed", () => {
    const snapshot = ingestStatusSnapshot({
      document: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 10 } } }),
      observedAt: HARNESS_EPOCH,
      stalenessMs: 300_000,
    });
    expect(snapshot.fiveHour.usedPercentage).toBe(10);
    expect(snapshot.fiveHour.resetsAt).toBeNull();
  });

  it("ages a known observation into stale rather than keeping it current", () => {
    const snapshot = ingestStatusSnapshot({
      document: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 10 } } }),
      observedAt: HARNESS_EPOCH,
      stalenessMs: 60_000,
    });
    const fresh = ageCapacitySnapshot(snapshot, new Date(new Date(HARNESS_EPOCH).valueOf() + 30_000));
    expect(fresh.status).toBe("known");
    const stale = ageCapacitySnapshot(snapshot, new Date(new Date(HARNESS_EPOCH).valueOf() + 120_000));
    expect(stale.status).toBe("stale");
    expect(stale.fiveHour.usedPercentage).toBe(10);
    expect(ageCapacitySnapshot(UNKNOWN_CAPACITY, new Date()).status).toBe("unknown");
  });

  it("exposes capacity through the provider without consuming model usage", async () => {
    const harness = await createClaudeHarness({
      scenario: { versionOnly: true },
    });
    try {
      expect(harness.provider.capacity().status).toBe("unknown");
      const snapshot = harness.provider.observeStatusSnapshot(
        JSON.stringify({ rate_limits: { seven_day: { used_percentage: 88 } } }),
      );
      expect(snapshot.status).toBe("known");
      expect(harness.provider.capacity().sevenDay.usedPercentage).toBe(88);
      // Nothing was executed: no operation observation exists.
      expect(harness.observations.filter((entry) => entry.kind === "operation-started")).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

describe("session identity and persistence", () => {
  it("validates session identifiers strictly", () => {
    expect(isValidSessionId("00000000-0000-4000-8000-000000000001")).toBe(true);
    expect(isValidSessionId("-0000000-0000-4000-8000-000000000001")).toBe(false);
    expect(isValidSessionId("not-a-uuid")).toBe(false);
    expect(isValidSessionId("")).toBe(false);
  });

  it("defaults to an ephemeral session and issues no resume token", async () => {
    const harness = await createClaudeHarness({
      scenario: { fragments: [line(initRecord()), line(resultRecord())] },
    });
    try {
      const operation = await harness.provider.start(readRequest("req-ephemeral"));
      const result = await operation.result;
      expect(result.resumeToken).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("refuses a resume token when session persistence is not configured", async () => {
    const harness = await createClaudeHarness({
      scenario: { fragments: [line(initRecord()), line(resultRecord())] },
    });
    try {
      // The policy answer does not depend on the token, so the caller learns
      // nothing about whether the token it supplied was well formed.
      await expect(
        harness.provider.start(readRequest("req-resume-denied", { resumeToken: "not-a-real-token" })),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    } finally {
      await harness.close();
    }
  });

  it("issues and re-accepts a resume token when persistence is permitted", async () => {
    const harness = await createClaudeHarness({
      scenario: { fragments: [line(initRecord()), line(resultRecord())] },
      configuration: { sessionPersistence: "explicit-continuation-only" },
      sessionPersistenceAllowed: true,
    });
    try {
      // A continuation must be requested explicitly, so the first run needs a
      // token to carry the intent; an invalid one is rejected outright.
      await expect(
        harness.provider.start(readRequest("req-resume-bad", { resumeToken: "AAAA" })),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

      // A token minted for this exact instance, project, workspace, snapshot,
      // model, and configuration is accepted and drives --resume.
      const token = mintResumeToken({
        sessionId: "00000000-0000-4000-8000-000000000099",
        instanceId: harness.configuration.instanceId,
        projectId: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        snapshotId: harness.snapshot.snapshotId,
        requestId: "req-earlier",
        model: null,
        effort: null,
        configurationFingerprint: harness.provider.configurationFingerprint,
        issuedAt: HARNESS_EPOCH,
        expiresAt: new Date(new Date(HARNESS_EPOCH).valueOf() + 3_600_000).toISOString(),
      });
      const argvOut = join(harness.base, "resume-argv.json");
      await harness.writeScenario({
        argvOut,
        fragments: [
          line(initRecord({ session_id: "00000000-0000-4000-8000-000000000099" })),
          line(resultRecord({ session_id: "00000000-0000-4000-8000-000000000099" })),
        ],
      });
      const operation = await harness.provider.start(
        readRequest("req-resume-ok", { resumeToken: token }),
      );
      const result = await operation.result;
      expect(result.completion).toBe("completed-no-changes");
      expect(result.resumeToken).not.toBeNull();

      const argv = JSON.parse(await readFile(argvOut, "utf8")) as string[];
      expect(argv[argv.indexOf("--resume") + 1]).toBe("00000000-0000-4000-8000-000000000099");
      // An explicitly continued session is not asked to discard itself.
      expect(argv).not.toContain("--no-session-persistence");
      // "Continue the most recent session" is never used.
      expect(argv).not.toContain("--continue");
      expect(argv).not.toContain("-c");
    } finally {
      await harness.close();
    }
  });
});

describe("error classification", () => {
  it.each([
    ["error_max_turns", "QUOTA_EXCEEDED"],
    ["error_max_budget", "QUOTA_EXCEEDED"],
    ["error_max_tokens", "CONTEXT_LIMIT_EXCEEDED"],
  ])("maps result subtype %s to %s", async (subtype, code) => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [
          line(initRecord()),
          line({ type: "result", subtype, is_error: true, session_id: "{{sessionId}}" }),
        ],
        exitCode: 1,
      },
    });
    try {
      const operation = await harness.provider.start(readRequest(`req-${subtype}`));
      await expect(operation.result).rejects.toMatchObject({ code });
    } finally {
      await harness.close();
    }
  });

  it("maps a reported rate limit to a delayed retry carrying the provider's retry-after", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [
          line(initRecord()),
          line({
            type: "system",
            subtype: "api_retry",
            attempt: 1,
            max_retries: 3,
            retry_delay_ms: 4_000,
            error_status: 429,
            error: "rate_limit",
          }),
          line({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "{{sessionId}}" }),
        ],
        exitCode: 1,
      },
    });
    try {
      const operation = await harness.provider.start(readRequest("req-rate-limit"));
      const error = await operation.result.then(
        () => null,
        (reason: { code?: string; retry?: { strategy?: string; retryAfterMs?: number | null } }) => reason,
      );
      expect(error?.code).toBe("RATE_LIMITED");
      expect(error?.retry?.strategy).toBe("same-after-delay");
      expect(error?.retry?.retryAfterMs).toBe(4_000);
    } finally {
      await harness.close();
    }
  });

  it("enforces the turn ceiling the CLI cannot enforce itself", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [
          line(initRecord()),
          ...Array.from({ length: 6 }, (_unused, index) => line(assistantText(`turn ${index}`))),
          line(resultRecord({ num_turns: 6 })),
        ],
      },
      configuration: { maxTurns: 3 },
    });
    try {
      const operation = await harness.provider.start(readRequest("req-turns"));
      await expect(operation.result).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    } finally {
      await harness.close();
    }
  });
});

describe("lifecycle", () => {
  it("describes itself honestly about containment and cancellation", async () => {
    const harness = await createClaudeHarness({ scenario: { versionOnly: true } });
    try {
      const descriptor = harness.provider.describe();
      expect(descriptor.kind).toBe("coding-agent");
      expect(descriptor.providerId).toBe("claude-code");
      expect(descriptor.locality).toBe("cloud");
      expect(descriptor.capabilities.streaming).toBe(true);
      expect(descriptor.capabilities.repositoryEditing).toBe(true);
      // Claude's own control-plane connection is not agent network access.
      expect(descriptor.capabilities.networkAccess).toBe(false);
      // No shipped backend can prove a process tree is gone.
      expect(descriptor.capabilities.cancellation).toBe("best-effort");
    } finally {
      await harness.close();
    }
  });

  it("reports degraded health on a backend that is not secure-enforcing", async () => {
    const harness = await createClaudeHarness({ scenario: { versionOnly: true } });
    try {
      const health = await harness.provider.health();
      expect(health.status).toBe("degraded");
      expect(health.detailCode).toBe("backend-not-secure");
    } finally {
      await harness.close();
    }
  });

  it("closes idempotently, reports closed health, and refuses new starts", async () => {
    const harness = await createClaudeHarness({ scenario: { versionOnly: true } });
    try {
      await harness.provider.close();
      await harness.provider.close();
      const health = await harness.provider.health();
      expect(health.status).toBe("closed");
      await expect(harness.provider.start(readRequest("req-after-close"))).rejects.toMatchObject({
        code: "PROVIDER_CLOSED",
      });
    } finally {
      await harness.close();
    }
  });

  it("refuses a request for a classification the instance does not support", async () => {
    const harness = await createClaudeHarness({
      scenario: { versionOnly: true },
      configuration: { supportedClassifications: ["public"] },
    });
    try {
      await expect(harness.provider.start(readRequest("req-classification"))).rejects.toMatchObject({
        code: "POLICY_DENIED",
      });
    } finally {
      await harness.close();
    }
  });

  it("refuses a deadline that has already passed without starting anything", async () => {
    const harness = await createClaudeHarness({ scenario: { versionOnly: true } });
    try {
      await expect(
        harness.provider.start(
          readRequest("req-past-deadline", {
            deadline: new Date(new Date(HARNESS_EPOCH).valueOf() - 1_000).toISOString(),
          }),
        ),
      ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    } finally {
      await harness.close();
    }
  });

  it("refuses a personal subscription login unless the canary opt-in is explicit", async () => {
    const denied = await createClaudeHarness({
      scenario: { versionOnly: true },
      configuration: { authenticationMode: "personal-local-cli-login" },
    });
    try {
      await expect(denied.provider.start(readRequest("req-personal"))).rejects.toMatchObject({
        code: "AUTHENTICATION_FAILED",
      });
    } finally {
      await denied.close();
    }
  });

  it("still returns a valid result when artifact persistence is denied", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [line(initRecord()), line(resultRecord())],
        afterFiles: [{ path: "tracked.txt", action: "write", content: "changed\n" }],
      },
      artifactPersistenceAllowed: false,
    });
    try {
      const operation = await harness.provider.start(
        readRequest("req-no-artifacts", { capabilities: ["read-files", "edit-files"] }),
      );
      const result = await operation.result;
      expect(result.completion).toBe("completed");
      expect(result.changedFiles).toHaveLength(1);
      expect(result.patchArtifactId).toBeNull();
      expect(result.producedArtifacts).toHaveLength(0);
      expect(harness.artifacts.writes).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("contains an observer that throws", async () => {
    const harness = await createClaudeHarness({
      scenario: { fragments: [line(initRecord()), line(resultRecord())] },
    });
    try {
      const operation = await harness.provider.start(readRequest("req-observer"));
      const result = await operation.result;
      expect(result.completion).toBe("completed-no-changes");
    } finally {
      await harness.close();
    }
  });
});

describe("test-report parsing", () => {
  it("accepts a strict report and rejects everything else", () => {
    expect(parseTestReport('{"suite":"unit","passed":1,"failed":2,"skipped":3}')).toEqual({
      suite: "unit",
      passed: 1,
      failed: 2,
      skipped: 3,
    });
    expect(parseTestReport('{"passed":1,"failed":0,"skipped":0}')?.suite).toBe("workspace-test-report");
    expect(parseTestReport("not json")).toBeNull();
    expect(parseTestReport("[]")).toBeNull();
    expect(parseTestReport('{"passed":-1,"failed":0,"skipped":0}')).toBeNull();
    expect(parseTestReport('{"passed":1.5,"failed":0,"skipped":0}')).toBeNull();
    expect(parseTestReport('{"passed":1,"failed":0}')).toBeNull();
    expect(parseTestReport('{"__proto__":{"x":1},"passed":1,"failed":0,"skipped":0}')).toBeNull();
  });
});
