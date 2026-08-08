/**
 * Security properties of the Claude Code adapter.
 *
 * Each test here asserts something that must remain true for the adapter to be
 * safe at all: no shell, no shim, no flag injection, no ambient customization,
 * no permission bypass, no secret leakage, and production refusal before the
 * Claude executable starts.
 *
 * Where a test asserts that a hostile thing did NOT happen, a positive control
 * proves the fixture that would produce it genuinely fires under the
 * corresponding unsafe condition, so "no marker appeared" is never vacuous.
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createCodingAgentRequest,
  createTrace,
  isProviderError,
  parseDisclosureContext,
} from "@ai-dev-os/providers";
import { TESTKIT_SECRET_CANARY } from "@ai-dev-os/provider-testkit";
import {
  ALWAYS_DENIED_TOOLS,
  MCP_DENY_RULE,
  buildInvocation,
  createClaudeAdapterConfiguration,
  mintResumeToken,
  parseClaudeAdapterConfiguration,
  planTools,
  resolveCompatibilityProfile,
  verifyResumeToken,
} from "../src/index.js";
import {
  HARNESS_EPOCH,
  WORKSPACE_ID,
  assistantText,
  SCRATCH,
  cleanupHarnessFixtures,
  createClaudeHarness,
  initRecord,
  line,
  resultRecord,
  toolUse,
} from "./helpers/harness.js";

const DISCLOSURE = parseDisclosureContext({
  classification: "internal",
  requiredLocality: "any",
  redactionApplied: true,
  decisionRef: null,
  retentionAllowed: true,
  loggingAllowed: true,
});

const CAPABILITIES = resolveCompatibilityProfile({
  version: "2.1.201",
  minimumCliVersion: "2.1.100",
  validatedCliVersion: "2.1.201",
}).capabilities;

function baseConfiguration(): ReturnType<typeof createClaudeAdapterConfiguration> {
  return createClaudeAdapterConfiguration({
    instanceId: "claude-code-1",
    executable: {
      toolId: "claude-code",
      executablePath: process.platform === "win32" ? "C:/tools/claude.exe" : "/usr/local/bin/claude",
      platform: process.platform === "win32" ? "win32" : "linux",
      architecture: "x64",
      expectedDigestHex: null,
      immutableReference: null,
      containmentRoot: null,
      pinnedLeadingArguments: null,
    },
    permittedModels: ["fable", "opus"],
    permittedEffortLevels: ["high"],
  });
}

const READ_ONLY_GRANT_PLAN = {
  capabilities: ["read-files"] as const,
  commandPolicy: { mode: "none" as const, allowedCommands: [] as readonly string[] },
  networkPolicy: "denied" as const,
  commandExecutionAllowed: false,
};

afterAll(async () => {
  await cleanupHarnessFixtures();
});

describe("argument construction cannot be subverted", () => {
  it("builds an argument vector, never a shell string", async () => {
    const argvOut = join(SCRATCH, "adox-argv.json");
    await rm(argvOut, { force: true });
    const harness = await createClaudeHarness({
      scenario: {
        argvOut,
        fragments: [line(initRecord()), line(assistantText("done")), line(resultRecord())],
      },
    });
    try {
      const operation = await harness.provider.start(
        createCodingAgentRequest({
          requestId: "req-argv",
          workspaceId: WORKSPACE_ID,
          instructions: "look around",
          capabilities: ["read-files"],
          disclosure: DISCLOSURE,
          trace: createTrace("trace-argv"),
        }),
      );
      await operation.result;

      const argv = JSON.parse(await readFile(argvOut, "utf8")) as string[];

      // The vector is discrete arguments; nothing was concatenated into a line.
      expect(Array.isArray(argv)).toBe(true);
      expect(argv).toContain("--print");
      expect(argv).toContain("--output-format");
      expect(argv).toContain("stream-json");
      expect(argv).toContain("--safe-mode");
      expect(argv).toContain("--no-chrome");
      expect(argv).toContain("--strict-mcp-config");
      expect(argv).toContain("--no-session-persistence");

      // dontAsk plus a finite --tools surface, not allowedTools alone.
      expect(argv).toContain("--permission-mode");
      expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("dontAsk");
      expect(argv).toContain("--tools");
      expect(argv[argv.indexOf("--tools") + 1]).toBe("Glob,Grep,Read");
      expect(argv).not.toContain("--allowedTools");
      expect(argv).not.toContain("--allowed-tools");

      // Ambient settings sources are switched off explicitly.
      expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("");

      // Nothing that bypasses permissions, resumes interactively, or reaches
      // an advisor, Chrome, background mode, or an MCP server appears.
      for (const forbidden of [
        "--dangerously-skip-permissions",
        "--allow-dangerously-skip-permissions",
        "--advisor",
        "--fallback-model",
        "--continue",
        "-c",
        "--chrome",
        "--background",
        "--bg",
        "--mcp-config",
        "--plugin-dir",
        "--plugin-url",
        "--agents",
        "--settings",
        "--add-dir",
        "--worktree",
        "--ide",
      ]) {
        expect(argv).not.toContain(forbidden);
      }
      for (const argument of argv) {
        expect(argument).not.toContain("&&");
        expect(argument).not.toContain("|");
        expect(argument).not.toContain(";");
      }
      const denied = argv[argv.indexOf("--disallowed-tools") + 1] ?? "";
      for (const tool of [...ALWAYS_DENIED_TOOLS, MCP_DENY_RULE]) {
        expect(denied.split(",")).toContain(tool);
      }
    } finally {
      await rm(argvOut, { force: true });
      await harness.close();
    }
  });

  it("sends instructions on stdin rather than in the process argument list", async () => {
    const argvOut = join(SCRATCH, "adox-argv-2.json");
    const stdinOut = join(SCRATCH, "adox-stdin.bin");
    const marker = "UNIQUE-INSTRUCTION-MARKER-42";
    const harness = await createClaudeHarness({
      scenario: {
        argvOut,
        stdinOut,
        fragments: [line(initRecord()), line(resultRecord())],
      },
    });
    try {
      const operation = await harness.provider.start(
        createCodingAgentRequest({
          requestId: "req-stdin",
          workspaceId: WORKSPACE_ID,
          instructions: `${marker} please summarize`,
          capabilities: ["read-files"],
          disclosure: DISCLOSURE,
          trace: createTrace("trace-stdin"),
        }),
      );
      await operation.result;

      const argv = JSON.parse(await readFile(argvOut, "utf8")) as string[];
      expect(argv.join("\u0000")).not.toContain(marker);
      expect(await readFile(stdinOut, "utf8")).toContain(marker);
    } finally {
      await rm(argvOut, { force: true });
      await rm(stdinOut, { force: true });
      await harness.close();
    }
  });

  it("refuses a model identifier that would be read as a flag", () => {
    for (const hostile of ["--dangerously-skip-permissions", "-p", "fable --chrome", "fable,opus"]) {
      expect(() =>
        parseClaudeAdapterConfiguration({
          ...JSON.parse(JSON.stringify(baseConfiguration())),
          permittedModels: [hostile],
        }),
      ).toThrow();
    }
  });

  it("refuses a resume token that would inject a flag", () => {
    const configuration = baseConfiguration();
    const outcome = verifyResumeToken({
      token: Buffer.from("1.--dangerously-skip-permissions.deadbeef", "utf8").toString("base64url"),
      instanceId: configuration.instanceId,
      projectId: "proj",
      workspaceId: WORKSPACE_ID,
      snapshotId: "snap",
      model: null,
      effort: null,
      configurationFingerprint: "f".repeat(64),
      now: new Date(HARNESS_EPOCH),
      sessionPersistenceAllowed: true,
    });
    expect(outcome.ok).toBe(false);
  });

  it("refuses to resume a session bound to another project or workspace", () => {
    const fingerprintValue = "f".repeat(64);
    const token = mintResumeToken({
      sessionId: "00000000-0000-4000-8000-000000000001",
      instanceId: "claude-code-1",
      projectId: "proj-a",
      workspaceId: "ws-a",
      snapshotId: "snap-a",
      requestId: "req-a",
      model: "fable",
      effort: "high",
      configurationFingerprint: fingerprintValue,
      issuedAt: HARNESS_EPOCH,
      expiresAt: new Date(new Date(HARNESS_EPOCH).valueOf() + 3_600_000).toISOString(),
    });
    const verify = (overrides: Record<string, unknown>): string | null => {
      const outcome = verifyResumeToken({
        token,
        instanceId: "claude-code-1",
        projectId: "proj-a",
        workspaceId: "ws-a",
        snapshotId: "snap-a",
        model: "fable",
        effort: "high",
        configurationFingerprint: fingerprintValue,
        now: new Date(HARNESS_EPOCH),
        sessionPersistenceAllowed: true,
        ...overrides,
      });
      return outcome.ok ? null : outcome.detailCode;
    };
    expect(verify({})).toBeNull();
    expect(verify({ projectId: "proj-b" })).toBe("resume-project-mismatch");
    expect(verify({ workspaceId: "ws-b" })).toBe("resume-workspace-mismatch");
    expect(verify({ snapshotId: "snap-b" })).toBe("resume-workspace-mismatch");
    expect(verify({ model: "opus" })).toBe("resume-model-mismatch");
    expect(verify({ sessionPersistenceAllowed: false })).toBe("session-persistence-denied");
    // A different configuration re-keys every binding digest, so a token from
    // one configuration never verifies under another. Which probe reports it
    // first is incidental; that it is rejected is the property that matters.
    expect(verify({ configurationFingerprint: "0".repeat(64) })).not.toBeNull();
    expect(verify({ instanceId: "claude-code-2" })).toBe("resume-token-invalid");
    expect(verify({ effort: "low" })).toBe("resume-token-invalid");
    expect(
      verify({ now: new Date(new Date(HARNESS_EPOCH).valueOf() + 7_200_000) }),
    ).toBe("resume-token-expired");
  });
});

describe("configuration cannot represent an unsafe capability", () => {
  it("rejects a Windows command-script shim", () => {
    expect(() =>
      createClaudeAdapterConfiguration({
        instanceId: "claude-code-1",
        executable: {
          toolId: "claude-code",
          executablePath: "C:/Users/dev/AppData/Roaming/npm/claude.cmd",
          platform: "win32",
          architecture: "x64",
          expectedDigestHex: null,
          immutableReference: null,
          containmentRoot: null,
          pinnedLeadingArguments: null,
        },
      }),
    ).toThrow(/rejected/i);
  });

  it("rejects a relative or PATH-style executable name", () => {
    for (const candidate of ["claude", "./claude", "bin/claude"]) {
      expect(() =>
        createClaudeAdapterConfiguration({
          instanceId: "claude-code-1",
          executable: {
            toolId: "claude-code",
            executablePath: candidate,
            platform: "linux",
            architecture: "x64",
            expectedDigestHex: null,
            immutableReference: null,
            containmentRoot: null,
            pinnedLeadingArguments: null,
          },
        }),
      ).toThrow();
    }
  });

  it.each([
    ["an inline credential", { apiKey: "sk-live-1234" }],
    ["a credential helper", { apiKeyHelper: "/bin/get-key" }],
    ["an OAuth token", { oauthToken: "oauth-abc" }],
    ["arbitrary CLI arguments", { additionalArguments: ["--dangerously-skip-permissions"] }],
    ["a raw argv array", { argv: ["--chrome"] }],
    ["a shell command", { command: "claude -p" }],
    ["a permission bypass switch", { bypassPermissions: true } as Record<string, unknown>],
    ["a permission mode override", { permissionMode: "auto" }],
    ["Chrome", { chrome: true }],
    ["ambient MCP servers", { mcpServers: { a: {} } }],
    ["ambient hooks", { hooks: { PreToolUse: [] } }],
    ["ambient plugins", { plugins: ["evil"] }],
    ["a settings file", { settings: "/etc/claude.json" }],
    ["an advisor", { advisor: "opus" }],
    ["a fallback model", { fallbackModel: "sonnet" }],
    ["continuation of the most recent session", { continue: true }],
  ])("rejects %s in configuration", (_label, extra) => {
    expect(() =>
      parseClaudeAdapterConfiguration({
        ...JSON.parse(JSON.stringify(baseConfiguration())),
        ...extra,
      }),
    ).toThrow();
  });

  it("rejects the same fields when they arrive through a Stage 6 extension", async () => {
    const { resolveClaudeConfiguration } = await import("../src/index.js");
    expect(() =>
      resolveClaudeConfiguration({
        instanceId: "claude-code-1",
        executable: JSON.parse(JSON.stringify(baseConfiguration().executable)) as Record<string, unknown>,
        extensions: [
          {
            namespace: "claude-code",
            schemaVersion: 1,
            value: { apiKey: "sk-live-should-not-be-here" },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects unsafe numbers, negative budgets, and malformed versions", () => {
    const base = JSON.parse(JSON.stringify(baseConfiguration())) as Record<string, unknown>;
    for (const override of [
      { maxBudgetMicros: -1 },
      { maxBudgetMicros: Number.NaN },
      { maxBudgetMicros: Number.POSITIVE_INFINITY },
      { maxBudgetMicros: 1.5 },
      { maxBudgetMicros: Number.MAX_SAFE_INTEGER },
      { maxTurns: 0 },
      { minimumCliVersion: "2.1" },
      { minimumCliVersion: "latest" },
    ]) {
      expect(() => parseClaudeAdapterConfiguration({ ...base, ...override })).toThrow();
    }
  });

  it("rejects prototype pollution in a configuration document", () => {
    const hostile = `{"__proto__":{"polluted":true},"schemaVersion":1}`;
    expect(() => parseClaudeAdapterConfiguration(JSON.parse(hostile))).toThrow();
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("tool and permission translation stays conservative", () => {
  const grant = (operations: readonly string[]): Parameters<typeof planTools>[0]["grant"] =>
    ({
      operations,
      writablePrefixes: [""],
      readablePrefixes: [""],
    }) as unknown as Parameters<typeof planTools>[0]["grant"];

  it("removes Bash entirely under command policy none", () => {
    const outcome = planTools({
      ...READ_ONLY_GRANT_PLAN,
      grant: grant(["workspace-read"]),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.plan.tools).not.toContain("Bash");
      expect(outcome.plan.bashPermitted).toBe(false);
    }
  });

  it("refuses allow-listed command policy rather than approximating it with a glob", () => {
    const outcome = planTools({
      capabilities: ["read-files", "run-commands"],
      commandPolicy: { mode: "allow-listed", allowedCommands: ["npm", "git"] },
      networkPolicy: "denied",
      grant: grant(["workspace-read", "command-execution"]),
      commandExecutionAllowed: true,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.detailCode).toBe("command-policy-untranslatable");
    }
  });

  it("refuses proxied agent network access no backend can enforce", () => {
    const outcome = planTools({
      capabilities: ["read-files"],
      commandPolicy: { mode: "none", allowedCommands: [] },
      networkPolicy: "proxied",
      grant: grant(["workspace-read", "network-access"]),
      commandExecutionAllowed: true,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.detailCode).toBe("network-policy-unenforceable");
    }
  });

  it("refuses editing when the capability grant does not permit writing", () => {
    const outcome = planTools({
      capabilities: ["read-files", "edit-files"],
      commandPolicy: { mode: "none", allowedCommands: [] },
      networkPolicy: "denied",
      grant: grant(["workspace-read"]),
      commandExecutionAllowed: false,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.detailCode).toBe("policy-denied");
    }
  });

  it("always denies web, browser, background, and MCP tools", () => {
    const outcome = planTools({
      ...READ_ONLY_GRANT_PLAN,
      grant: grant(["workspace-read"]),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      for (const tool of ["WebSearch", "WebFetch", "Task", "BashOutput", MCP_DENY_RULE]) {
        expect(outcome.plan.disallowedTools).toContain(tool);
      }
    }
  });

  it("cannot express a permission bypass or auto mode in the invocation", () => {
    const invocation = buildInvocation({
      configuration: baseConfiguration(),
      capabilities: CAPABILITIES,
      plan: {
        tools: ["Read"],
        disallowedTools: [...ALWAYS_DENIED_TOOLS, MCP_DENY_RULE],
        bashPermitted: false,
        writePermitted: false,
      },
      model: "fable",
      effort: "high",
      sessionId: "00000000-0000-4000-8000-000000000001",
      resumeSessionId: null,
      persistSession: false,
      budgetMicros: 250_000,
      maxTurns: 8,
    });
    const permissionValue = invocation.args[invocation.args.indexOf("--permission-mode") + 1];
    expect(permissionValue).toBe("dontAsk");
    expect(["bypassPermissions", "auto", "acceptEdits"]).not.toContain(permissionValue);
    expect(invocation.args[invocation.args.indexOf("--max-budget-usd") + 1]).toBe("0.250000");
  });
});

describe("production execution refuses before the Claude process starts", () => {
  it("does not start the executable in production mode, and the marker fires in development", async () => {
    const marker = join(SCRATCH, "adox-start-marker.txt");
    await rm(marker, { force: true });

    // Positive control: the same armed scenario in development mode DOES start
    // the process and DOES write the marker, so the negative assertion below
    // is testing refusal rather than a fixture that never fires.
    const development = await createClaudeHarness({
      scenario: {
        startMarker: marker,
        fragments: [line(initRecord()), line(resultRecord())],
      },
      mode: "development",
    });
    try {
      const operation = await development.provider.start(
        createCodingAgentRequest({
          requestId: "req-control",
          workspaceId: WORKSPACE_ID,
          instructions: "read something",
          capabilities: ["read-files"],
          disclosure: DISCLOSURE,
          trace: createTrace("trace-control"),
        }),
      );
      await operation.result;
      expect(existsSync(marker)).toBe(true);
    } finally {
      await development.close();
    }

    // Clear the marker so its absence below means "never written this time".
    await rm(marker, { force: true });
    expect(existsSync(marker)).toBe(false);

    const production = await createClaudeHarness({
      scenario: {
        startMarker: marker,
        fragments: [line(initRecord()), line(resultRecord())],
      },
      mode: "production",
    });
    try {
      await expect(
        production.provider.start(
          createCodingAgentRequest({
            requestId: "req-production",
            workspaceId: WORKSPACE_ID,
            instructions: "read something",
            capabilities: ["read-files"],
            disclosure: DISCLOSURE,
            trace: createTrace("trace-production"),
          }),
        ),
      ).rejects.toThrow();

      // No Claude process was created: the Stage 8 admission gate refused
      // first, and the refusal was not caught, retried, or downgraded.
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(marker, { force: true });
      await production.close();
    }
  });
});

describe("secrets and sensitive content never leak", () => {
  it("keeps a canary out of argv, the environment, errors, artifacts, and observations", async () => {
    const argvOut = join(SCRATCH, "adox-secret-argv.json");
    const environmentOut = join(SCRATCH, "adox-secret-env.json");
    const credentialNames = [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
      "CLAUDE_CONFIG_DIR",
      "GITHUB_TOKEN",
    ] as const;
    const harness = await createClaudeHarness({
      scenario: {
        argvOut,
        environmentOut,
        environmentCanaryNames: credentialNames,
        stderr: `fatal: credential ${TESTKIT_SECRET_CANARY} rejected\n`,
        fragments: [
          line(initRecord()),
          line({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "{{sessionId}}" }),
        ],
        exitCode: 1,
      },
    });
    try {
      const operation = await harness.provider.start(
        createCodingAgentRequest({
          requestId: "req-secret",
          workspaceId: WORKSPACE_ID,
          instructions: `use credential ${TESTKIT_SECRET_CANARY} to deploy`,
          capabilities: ["read-files"],
          disclosure: DISCLOSURE,
          trace: createTrace("trace-secret"),
        }),
      );

      const events: unknown[] = [];
      for await (const event of operation.events()) {
        events.push(event);
      }
      const error = await operation.result.then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(isProviderError(error)).toBe(true);

      const serializedError = JSON.stringify(
        isProviderError(error) ? error.toJSON() : { message: String(error) },
      );
      expect(serializedError).not.toContain(TESTKIT_SECRET_CANARY);
      expect(JSON.stringify(events)).not.toContain(TESTKIT_SECRET_CANARY);
      expect(JSON.stringify(harness.observations)).not.toContain(TESTKIT_SECRET_CANARY);
      expect(JSON.stringify(harness.configuration)).not.toContain(TESTKIT_SECRET_CANARY);
      expect(harness.provider.configurationFingerprint).not.toContain(TESTKIT_SECRET_CANARY);

      // The instructions carrying the canary never reached the argument list.
      const argv = JSON.parse(await readFile(argvOut, "utf8")) as string[];
      expect(argv.join("\u0000")).not.toContain(TESTKIT_SECRET_CANARY);

      // The child received no credential-bearing environment variable.
      const environment = JSON.parse(await readFile(environmentOut, "utf8")) as {
        names: string[];
        selectedNames: string[];
        present: boolean[];
        values: (string | null)[];
      };
      expect(environment.selectedNames).toEqual(credentialNames);
      expect(environment.present.every((present) => !present)).toBe(true);
      expect(environment.values.every((value) => value === null)).toBe(true);
      for (const forbidden of [
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
        "CLAUDE_CODE_OAUTH_SCOPES",
        "CLAUDE_CONFIG_DIR",
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "AWS_SECRET_ACCESS_KEY",
        "SSH_AUTH_SOCK",
        "GIT_ASKPASS",
      ]) {
        expect(environment.names).not.toContain(forbidden);
      }

      // Diagnostics that were captured are bounded and contain no canary in
      // any artifact the adapter offered for persistence.
      const serializedArtifacts = JSON.stringify(
        harness.artifacts.writes.map((write) => ({
          category: write.category,
          kind: write.kind,
          classification: write.classification,
          mediaType: write.mediaType,
          text: Buffer.from(write.bytes).toString("utf8"),
        })),
      );
      expect(serializedArtifacts.includes(TESTKIT_SECRET_CANARY)).toBe(false);
    } finally {
      await rm(argvOut, { force: true });
      await rm(environmentOut, { force: true });
      await harness.close();
    }
  });

  it("uses only the platform home name for a fresh broker-owned session home", async () => {
    const environmentOut = join(SCRATCH, "adox-broker-home-env.json");
    const expectedHomeName = process.platform === "win32" ? "USERPROFILE" : "HOME";
    const oppositeHomeName = process.platform === "win32" ? "HOME" : "USERPROFILE";
    const capturedNames = [
      "HOME",
      "USERPROFILE",
      "HOMEDRIVE",
      "HOMEPATH",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
      "CLAUDE_CODE_OAUTH_SCOPES",
    ] as const;
    const harness = await createClaudeHarness({
      scenario: {
        environmentOut,
        environmentCanaryNames: capturedNames,
        fragments: [line(initRecord()), line(resultRecord())],
      },
    });
    const ambientCanaryHome = join(harness.base, "ambient-home-canary");
    const originalAmbientHome = process.env[expectedHomeName];
    await mkdir(ambientCanaryHome, { recursive: true });
    const canonicalOriginalAmbientHome =
      typeof originalAmbientHome === "string" && originalAmbientHome.length > 0
        ? await realpath(originalAmbientHome).catch(() => resolve(originalAmbientHome))
        : null;
    process.env[expectedHomeName] = ambientCanaryHome;
    try {
      const canonicalSessionRoot = await realpath(harness.sessionRoot);
      const canonicalAmbientCanaryHome = await realpath(ambientCanaryHome);
      const canonicalSourceRoot = await realpath(harness.sourceRoot);
      const canonicalManagedRoot = await realpath(harness.record.managedRoot);
      const canonicalWorktree = await realpath(harness.worktreeDir);
      const operation = await harness.provider.start(
        createCodingAgentRequest({
          requestId: "req-broker-home",
          workspaceId: WORKSPACE_ID,
          instructions: "read",
          capabilities: ["read-files"],
          disclosure: DISCLOSURE,
          trace: createTrace("trace-broker-home"),
        }),
      );
      await operation.result;

      const environment = JSON.parse(await readFile(environmentOut, "utf8")) as {
        names: string[];
        selectedNames: string[];
        present: boolean[];
        values: (string | null)[];
        brokerHome: {
          name: string;
          existsAsDirectory: boolean;
          empty: boolean;
          canonicalValue: string | null;
        } | null;
        cwd: string;
      };
      expect(environment.selectedNames).toEqual(capturedNames);
      const selected = Object.fromEntries(
        environment.selectedNames.map((name, index) => [name, environment.values[index] ?? null]),
      ) as Record<string, string | null>;
      const present = Object.fromEntries(
        environment.selectedNames.map((name, index) => [name, environment.present[index] ?? false]),
      ) as Record<string, boolean>;
      const selectedHome = selected[expectedHomeName];
      if (typeof selectedHome !== "string") {
        throw new Error("The fake CLI did not observe the broker-owned platform home.");
      }

      expect(
        environment.names
          .filter((name) => name.toUpperCase() === "HOME" || name.toUpperCase() === "USERPROFILE")
          .map((name) => name.toUpperCase()),
      ).toEqual([expectedHomeName]);
      expect(present[expectedHomeName]).toBe(true);
      expect(present[oppositeHomeName]).toBe(false);
      expect(selected[oppositeHomeName] === null).toBe(true);
      for (const forbidden of [
        "HOMEDRIVE",
        "HOMEPATH",
        "APPDATA",
        "LOCALAPPDATA",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
        "CLAUDE_CODE_OAUTH_SCOPES",
      ]) {
        expect(environment.names.some((name) => name.toUpperCase() === forbidden)).toBe(false);
        expect(present[forbidden]).toBe(false);
        expect(selected[forbidden] === null).toBe(true);
      }

      if (environment.brokerHome === null || environment.brokerHome.canonicalValue === null) {
        throw new Error("The fake CLI did not resolve the broker-owned platform home.");
      }
      expect(environment.brokerHome.name).toBe(expectedHomeName);
      expect(environment.brokerHome.existsAsDirectory).toBe(true);
      expect(environment.brokerHome.empty).toBe(true);
      const canonicalSelectedHome = environment.brokerHome.canonicalValue;
      expect(isStrictDescendant(canonicalSessionRoot, canonicalSelectedHome)).toBe(true);
      expect(isStrictDescendant(canonicalSessionRoot, canonicalSessionRoot)).toBe(false);
      expect(
        isStrictDescendant(canonicalSessionRoot, join(`${canonicalSessionRoot}-sibling`, "home")),
      ).toBe(false);
      if (process.platform === "win32") {
        expect(
          isStrictDescendant(canonicalSessionRoot.toUpperCase(), canonicalSelectedHome.toLowerCase()),
        ).toBe(true);
        expect(
          isStrictDescendant(canonicalSessionRoot.toUpperCase(), canonicalSessionRoot.toLowerCase()),
        ).toBe(false);
      }
      expect(isWithinOrEqual(canonicalSourceRoot, canonicalSelectedHome)).toBe(false);
      expect(isWithinOrEqual(canonicalManagedRoot, canonicalSelectedHome)).toBe(false);
      expect(isWithinOrEqual(canonicalWorktree, canonicalSelectedHome)).toBe(false);
      expect(isWithinOrEqual(canonicalWorktree, await realpath(environment.cwd))).toBe(true);
      expect(isSamePath(canonicalSelectedHome, canonicalAmbientCanaryHome)).toBe(false);
      if (canonicalOriginalAmbientHome !== null) {
        expect(isSamePath(canonicalSelectedHome, canonicalOriginalAmbientHome)).toBe(false);
      }
      // Broker disposal happens before the adapter operation settles.
      expect(existsSync(selectedHome)).toBe(false);
    } finally {
      if (originalAmbientHome === undefined) {
        delete process.env[expectedHomeName];
      } else {
        process.env[expectedHomeName] = originalAmbientHome;
      }
      await rm(environmentOut, { force: true });
      await rm(ambientCanaryHome, { recursive: true, force: true });
      await harness.close();
    }
  });

  it("does not resolve secrets when the session is denied before launch", async () => {
    const marker = join(SCRATCH, "adox-denied-marker.txt");
    await rm(marker, { force: true });
    const harness = await createClaudeHarness({
      scenario: { startMarker: marker, fragments: [line(initRecord()), line(resultRecord())] },
      policyOutcome: "denied",
    });
    try {
      await expect(
        harness.provider.start(
          createCodingAgentRequest({
            requestId: "req-denied",
            workspaceId: WORKSPACE_ID,
            instructions: "do the thing",
            capabilities: ["read-files"],
            disclosure: DISCLOSURE,
            trace: createTrace("trace-denied"),
          }),
        ),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(marker, { force: true });
      await harness.close();
    }
  });

  it("never surfaces hidden reasoning as answer, status, or diagnostic text", async () => {
    const reasoning = "INTERNAL-REASONING-CANARY-9271";
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [
          line(initRecord()),
          line({
            type: "assistant",
            message: { content: [{ type: "thinking", thinking: reasoning }] },
          }),
          line(assistantText("Here is the answer.")),
          line(resultRecord()),
        ],
      },
    });
    try {
      const operation = await harness.provider.start(
        createCodingAgentRequest({
          requestId: "req-reasoning",
          workspaceId: WORKSPACE_ID,
          instructions: "think then answer",
          capabilities: ["read-files"],
          disclosure: DISCLOSURE,
          trace: createTrace("trace-reasoning"),
        }),
      );
      const events: unknown[] = [];
      for await (const event of operation.events()) {
        events.push(event);
      }
      const result = await operation.result;
      expect(JSON.stringify(events)).not.toContain(reasoning);
      expect(JSON.stringify(result)).not.toContain(reasoning);
      expect(JSON.stringify(harness.artifacts.writes)).not.toContain(reasoning);
    } finally {
      await harness.close();
    }
  });
});

describe("ambient customization and hostile stream records fail closed", () => {
  it("fails when the session reports a loaded MCP server or plugin", async () => {
    for (const overrides of [{ mcp_servers: [{ name: "evil", status: "connected" }] }, { plugins: [{ name: "evil", path: "p" }] }]) {
      const harness = await createClaudeHarness({
        scenario: {
          fragments: [line(initRecord(overrides)), line(resultRecord())],
        },
      });
      try {
        const operation = await harness.provider.start(
          createCodingAgentRequest({
            requestId: "req-ambient",
            workspaceId: WORKSPACE_ID,
            instructions: "read",
            capabilities: ["read-files"],
            disclosure: DISCLOSURE,
            trace: createTrace("trace-ambient"),
          }),
        );
        await expect(operation.result).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
      } finally {
        await harness.close();
      }
    }
  });

  it("fails when a hook lifecycle event proves an ambient hook ran", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [
          line(initRecord()),
          line({ type: "system", subtype: "hook_started", hook: "PreToolUse" }),
          line(resultRecord()),
        ],
      },
    });
    try {
      const operation = await harness.provider.start(
        createCodingAgentRequest({
          requestId: "req-hook",
          workspaceId: WORKSPACE_ID,
          instructions: "read",
          capabilities: ["read-files"],
          disclosure: DISCLOSURE,
          trace: createTrace("trace-hook"),
        }),
      );
      await expect(operation.result).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
    } finally {
      await harness.close();
    }
  });

  it("detects a substituted model instead of accepting the downgrade", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        reportedModel: "claude-opus-5",
        fragments: [line(initRecord()), line(resultRecord())],
      },
    });
    try {
      const operation = await harness.provider.start(
        createCodingAgentRequest({
          requestId: "req-model",
          workspaceId: WORKSPACE_ID,
          modelId: "fable",
          instructions: "read",
          capabilities: ["read-files"],
          disclosure: DISCLOSURE,
          trace: createTrace("trace-model"),
        }),
      );
      await expect(operation.result).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
    } finally {
      await harness.close();
    }
  });

  it("rejects a record that arrives after the terminal result", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [
          line(initRecord()),
          line(resultRecord()),
          line(assistantText("one more thing")),
        ],
      },
    });
    try {
      const operation = await harness.provider.start(
        createCodingAgentRequest({
          requestId: "req-after-terminal",
          workspaceId: WORKSPACE_ID,
          instructions: "read",
          capabilities: ["read-files"],
          disclosure: DISCLOSURE,
          trace: createTrace("trace-after-terminal"),
        }),
      );
      await expect(operation.result).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
    } finally {
      await harness.close();
    }
  });

  it("rejects a duplicate terminal result", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [line(initRecord()), line(resultRecord()), line(resultRecord())],
      },
    });
    try {
      const operation = await harness.provider.start(
        createCodingAgentRequest({
          requestId: "req-duplicate-terminal",
          workspaceId: WORKSPACE_ID,
          instructions: "read",
          capabilities: ["read-files"],
          disclosure: DISCLOSURE,
          trace: createTrace("trace-duplicate"),
        }),
      );
      await expect(operation.result).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
    } finally {
      await harness.close();
    }
  });

  it("treats a zero exit with no terminal record as a malformed response", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [line(initRecord()), line(assistantText("I did the work."))],
        exitCode: 0,
      },
    });
    try {
      const operation = await harness.provider.start(
        createCodingAgentRequest({
          requestId: "req-missing-terminal",
          workspaceId: WORKSPACE_ID,
          instructions: "read",
          capabilities: ["read-files"],
          disclosure: DISCLOSURE,
          trace: createTrace("trace-missing-terminal"),
        }),
      );
      await expect(operation.result).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    } finally {
      await harness.close();
    }
  });

  it("rejects a session id that does not match the one the adapter minted", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [
          line(initRecord({ session_id: "11111111-1111-4111-8111-111111111111" })),
          line(resultRecord()),
        ],
      },
    });
    try {
      const operation = await harness.provider.start(
        createCodingAgentRequest({
          requestId: "req-session-mismatch",
          workspaceId: WORKSPACE_ID,
          instructions: "read",
          capabilities: ["read-files"],
          disclosure: DISCLOSURE,
          trace: createTrace("trace-session-mismatch"),
        }),
      );
      await expect(operation.result).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
    } finally {
      await harness.close();
    }
  });
});

describe("the user's source repository is never touched", () => {
  it("leaves the source worktree byte-for-byte unchanged and creates no remote", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [line(initRecord()), line(toolUse("t1", "Write", { file_path: "added.txt" })), line(resultRecord())],
        afterFiles: [{ path: "added.txt", action: "write", content: "created by the agent\n" }],
      },
    });
    try {
      const before = await fingerprintDirectory(harness.sourceRoot);
      const operation = await harness.provider.start(
        createCodingAgentRequest({
          requestId: "req-source-untouched",
          workspaceId: WORKSPACE_ID,
          instructions: "add a file",
          capabilities: ["read-files", "edit-files"],
          disclosure: DISCLOSURE,
          trace: createTrace("trace-source"),
        }),
      );
      const result = await operation.result;
      expect(result.changedFiles.map((entry) => entry.path)).toContain("added.txt");

      const after = await fingerprintDirectory(harness.sourceRoot);
      expect(after).toEqual(before);

      // No provider or session data was written into the source repository,
      // and no remote was configured.
      expect(existsSync(join(harness.sourceRoot, "added.txt"))).toBe(false);
      expect(existsSync(join(harness.sourceRoot, ".git", "worktrees"))).toBe(false);
      const config = await readFile(join(harness.sourceRoot, ".git", "config"), "utf8");
      expect(config).not.toContain('[remote "');
    } finally {
      await harness.close();
    }
  });
});

/** A content fingerprint over every tracked path in a directory tree. */
async function fingerprintDirectory(root: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const { readdir, stat } = await import("node:fs/promises");
  const hash = createHash("sha256");
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    );
    for (const entry of entries) {
      const full = join(directory, entry.name);
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        // Git's own object store churns on read; content under .git is
        // compared by tracked path rather than by internal representation.
        if (relative === ".git") {
          continue;
        }
        await walk(full, relative);
        continue;
      }
      const info = await stat(full);
      hash.update(`${relative}:${info.size}:`);
      hash.update(await readFile(full));
    }
  };
  await walk(root, "");
  return hash.digest("hex");
}

function isWithinOrEqual(root: string, candidate: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function isStrictDescendant(root: string, candidate: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function isSamePath(left: string, right: string): boolean {
  return relative(resolve(left), resolve(right)) === "";
}

/** Keeps the unused-import checker honest about writeFile in this module. */
void writeFile;
