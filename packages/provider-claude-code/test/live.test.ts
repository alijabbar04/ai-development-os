/**
 * Opt-in live canaries against a real, already-installed Claude Code CLI.
 *
 * These never run by default and never consume Claude usage without an
 * explicit opt-in.
 *
 * Required for any live test:
 *   AI_DEV_OS_CLAUDE_LIVE_EXECUTABLE
 *     Absolute path to the native Claude Code executable. There is no PATH
 *     lookup and no `.cmd` shim; the path must be a real image.
 *   AI_DEV_OS_CLAUDE_LIVE_OPT_IN=i-understand
 *     Explicit acknowledgement that these tests start a real Claude process
 *     under the explicitly unsafe development backend, which provides process
 *     supervision and no security containment whatsoever.
 *
 * Required additionally for the task canaries (anything that consumes model
 * usage):
 *   AI_DEV_OS_CLAUDE_LIVE_API_KEY
 *     An Anthropic API key. It is delivered through the Stage 8 secret
 *     resolver, which resolves it after policy approval and immediately before
 *     process creation, and never places it in argv, configuration, artifacts,
 *     observations, or errors.
 *
 * Why an API key rather than the machine owner's Claude login: on Linux and
 * Windows, the process broker starts from an empty environment and supplies a
 * fresh broker-owned session home as HOME or USERPROFILE. It does not inherit
 * the machine owner's home, and callers cannot override the home/profile or XDG
 * redirectors. The CLI's default file-backed lookup therefore cannot discover
 * an installed OAuth login. macOS credentials live in the user's Keychain,
 * which HOME cannot redirect, so distributable operations refuse there before
 * their CLI probe or task process. This is credential-discovery redirection,
 * not filesystem isolation: the explicitly unsafe backend still has the
 * invoking user's file access. Installed-login operation remains a local
 * development canary outside distributable authentication, while supported
 * task canaries use an API key resolved after policy approval.
 *
 * Optionally, AI_DEV_OS_CLAUDE_LIVE_MODEL names one permitted model.
 *
 * Every canary runs in a disposable temporary repository the harness creates —
 * never the AI Development OS worktree and never the user's own repository.
 * Turns, budget, output, changed files, and deadlines are all capped; Chrome,
 * MCP, hooks, plugins, skills, agents, and memory are disabled by the
 * adapter's own invocation; no remote is created; and the user's global Claude
 * configuration is never read or modified.
 */

import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createCodingAgentRequest, createTrace, parseDisclosureContext } from "@ai-dev-os/providers";
import {
  WORKSPACE_ID,
  cleanupHarnessFixtures,
  createClaudeHarness,
  type ClaudeHarness,
} from "./helpers/harness.js";

const EXECUTABLE = process.env["AI_DEV_OS_CLAUDE_LIVE_EXECUTABLE"];
const OPT_IN = process.env["AI_DEV_OS_CLAUDE_LIVE_OPT_IN"];
const API_KEY = process.env["AI_DEV_OS_CLAUDE_LIVE_API_KEY"];
const LIVE_MODEL = process.env["AI_DEV_OS_CLAUDE_LIVE_MODEL"] ?? null;

const PROBE_ENABLED = EXECUTABLE !== undefined && OPT_IN === "i-understand";
const TASKS_ENABLED = PROBE_ENABLED && API_KEY !== undefined && API_KEY.length > 0;

const DISCLOSURE = parseDisclosureContext({
  classification: "public",
  requiredLocality: "any",
  redactionApplied: false,
  decisionRef: null,
  retentionAllowed: false,
  loggingAllowed: false,
});

afterAll(async () => {
  await cleanupHarnessFixtures();
});

async function liveHarness(): Promise<ClaudeHarness> {
  const secretName = "ANTHROPIC_API_KEY";
  const fingerprint = createHash("sha256").update("live-canary-api-key", "utf8").digest("hex");
  return await createClaudeHarness({
    // No fake scenario applies: the real executable is invoked directly.
    scenario: { versionOnly: true },
    executablePathOverride: EXECUTABLE as string,
    pinnedLeadingArgumentsOverride: null,
    configuration: {
      permittedModels: LIVE_MODEL === null ? [] : [LIVE_MODEL],
      authenticationMode: "api-key-secret-ref",
      maxTurns: 2,
      maxBudgetMicros: 250_000,
      processDeadlineMs: 180_000,
      operationDeadlineMs: 240_000,
      supportedClassifications: ["public", "internal"],
    },
    ...(TASKS_ENABLED
      ? {
          secretEnvironment: [
            { kind: "secret" as const, name: secretName, secretRefFingerprint: fingerprint },
          ],
          secretValues: new Map([[secretName, API_KEY as string]]),
        }
      : {}),
  });
}

function liveRequest(requestId: string, overrides: Record<string, unknown> = {}) {
  return createCodingAgentRequest({
    requestId,
    workspaceId: WORKSPACE_ID,
    ...(LIVE_MODEL === null ? {} : { modelId: LIVE_MODEL }),
    instructions: "Reply with only the word OK.",
    capabilities: ["read-files"],
    disclosure: DISCLOSURE,
    trace: createTrace(`trace-${requestId}`),
    deadline: new Date(Date.now() + 180_000).toISOString(),
    ...overrides,
  });
}

describe.skipIf(!PROBE_ENABLED)(
  "live Claude Code probe (opt-in; UNSAFE development backend, no containment)",
  () => {
    it("reads the installed CLI version and resolves a compatibility tier", async () => {
      const harness = await liveHarness();
      try {
        const probe = await harness.provider.probe();
        expect(probe.executableResolved).toBe(true);
        expect(probe.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(["compatible", "unsupported-version"]).toContain(probe.status);
        if (probe.status === "compatible") {
          expect(probe.profile.usableForProduction).toBe(true);
          expect(probe.profile.capabilities.streamJsonOutput).toBe(true);
        }
      } finally {
        await harness.close();
      }
    });

    it("never reads or exposes a credential during the probe", async () => {
      const harness = await liveHarness();
      try {
        const probe = await harness.provider.probe();
        const serialized = JSON.stringify(probe);
        expect(serialized).not.toContain("sk-");
        if (API_KEY !== undefined && API_KEY.length > 0) {
          expect(serialized).not.toContain(API_KEY);
        }
      } finally {
        await harness.close();
      }
    });
  },
);

describe.skipIf(!TASKS_ENABLED)(
  "live Claude Code tasks (opt-in; UNSAFE development backend, no containment)",
  () => {
    it("completes a bounded read-only task in a disposable managed repository", async () => {
      const harness = await liveHarness();
      try {
        const operation = await harness.provider.start(
          liveRequest("live-read-only", {
            instructions:
              "Read tracked.txt and reply with only the single word DONE. Do not modify any file.",
            maxChangedFiles: 0,
          }),
        );
        const result = await operation.result;
        expect(result.completion).toBe("completed-no-changes");
        expect(result.changedFiles).toHaveLength(0);
        // Usage is whatever the session reported; nothing is invented.
        expect(result.usage.tokens.inputTokens).toBeGreaterThan(0);
      } finally {
        await harness.close();
      }
    });

    it("applies a bounded edit and reconciles it from actual workspace state", async () => {
      const harness = await liveHarness();
      try {
        const operation = await harness.provider.start(
          liveRequest("live-edit", {
            instructions:
              "Replace the entire contents of tracked.txt with exactly the single line: canary. Change nothing else.",
            capabilities: ["read-files", "edit-files"],
            maxChangedFiles: 2,
          }),
        );
        const result = await operation.result;

        // Reconciliation, not the transcript, reports the change.
        expect(result.changedFiles.map((entry) => entry.path)).toContain("tracked.txt");
        const onDisk = await readFile(join(harness.worktreeDir, "tracked.txt"), "utf8");
        expect(onDisk.toLowerCase()).toContain("canary");
        expect(result.patchArtifactId).not.toBeNull();

        // The disposable source repository is untouched.
        expect(await readFile(join(harness.sourceRoot, "tracked.txt"), "utf8")).toBe("original\n");
      } finally {
        await harness.close();
      }
    });

    it("reports session usage and the model actually used", async () => {
      const harness = await liveHarness();
      try {
        const operation = await harness.provider.start(liveRequest("live-usage"));
        const result = await operation.result;
        expect(result.usage.tokens.outputTokens).toBeGreaterThan(0);

        const terminal = harness.observations.find(
          (observation) => observation.kind === "operation-terminal",
        );
        expect(terminal).toBeDefined();
        if (terminal?.kind === "operation-terminal") {
          expect(terminal.category).toBe("succeeded");
          if (LIVE_MODEL !== null) {
            // A substitution would have failed the operation before this point.
            expect(terminal.requestedModel).toBe(LIVE_MODEL);
          }
        }
      } finally {
        await harness.close();
      }
    });

    it("cancels a live session under a strict usage cap", async () => {
      const harness = await liveHarness();
      try {
        const operation = await harness.provider.start(
          liveRequest("live-cancel", {
            instructions: "Read tracked.txt and describe it in one sentence.",
          }),
        );
        await operation.cancel();
        await expect(operation.result).rejects.toMatchObject({ code: "CANCELLED" });
      } finally {
        await harness.close();
      }
    });

    it("keeps the API key out of argv, results, observations, and errors", async () => {
      const harness = await liveHarness();
      try {
        const operation = await harness.provider.start(liveRequest("live-secret"));
        const result = await operation.result;
        const key = API_KEY as string;
        expect(JSON.stringify(result)).not.toContain(key);
        expect(JSON.stringify(harness.observations)).not.toContain(key);
        expect(JSON.stringify(harness.configuration)).not.toContain(key);
        expect(JSON.stringify(harness.artifacts.writes)).not.toContain(key);
      } finally {
        await harness.close();
      }
    });
  },
);

describe("live canary opt-in status", () => {
  it.skipIf(PROBE_ENABLED)("skips the probe canary without an explicit opt-in", () => {
    // Recorded as skipped, never as passed. Enabling requires
    // AI_DEV_OS_CLAUDE_LIVE_EXECUTABLE and
    // AI_DEV_OS_CLAUDE_LIVE_OPT_IN=i-understand.
    expect(PROBE_ENABLED).toBe(false);
  });

  it.skipIf(TASKS_ENABLED)("skips the task canaries without an API key", () => {
    // Task canaries additionally require AI_DEV_OS_CLAUDE_LIVE_API_KEY,
    // because Linux/Windows isolated-home lookup cannot discover an installed
    // login and macOS distributable task starts refuse without Keychain
    // isolation. Adapter code never reads a Claude credential file itself.
    expect(TASKS_ENABLED).toBe(false);
  });
});
