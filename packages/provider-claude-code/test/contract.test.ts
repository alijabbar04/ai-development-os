/**
 * Runs the reusable Stage 5 coding-agent provider contract suite against the
 * Claude Code adapter, driven end to end through the real process broker over
 * the explicitly unsafe development backend and the process-level fake CLI.
 */

import { afterAll } from "vitest";
import { runCodingAgentProviderContractSuite } from "@ai-dev-os/providers/testing";
import type { CodingAgentContractHarness, CodingAgentScenarioName } from "@ai-dev-os/providers/testing";
import { INTERNAL_DISCLOSURE, TESTKIT_SECRET_CANARY, TESTKIT_TRACE } from "@ai-dev-os/provider-testkit";
import { createCodingAgentRequest } from "@ai-dev-os/providers";
import {
  HARNESS_EPOCH,
  WORKSPACE_ID,
  assistantText,
  cleanupHarnessFixtures,
  createClaudeHarness,
  initRecord,
  line,
  resultRecord,
  toolUse,
  type ClaudeHarness,
  type FakeScenario,
} from "./helpers/harness.js";

afterAll(async () => {
  await cleanupHarnessFixtures();
});

function scenarioFor(name: CodingAgentScenarioName): FakeScenario {
  switch (name) {
    case "no-change":
      return {
        fragments: [
          line(initRecord()),
          line(assistantText("Nothing needs to change.")),
          line(resultRecord()),
        ],
      };
    case "patch-producing":
      return {
        fragments: [
          line(initRecord()),
          line(toolUse("toolu_edit1", "Edit", { file_path: "src/main.ts" })),
          line(resultRecord({ num_turns: 2 })),
        ],
        afterFiles: [{ path: "src/main.ts", action: "write", content: "export const value = 2;\n" }],
      };
    case "test-results":
      return {
        fragments: [
          line(initRecord({ tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"] })),
          line(toolUse("toolu_bash1", "Bash", { command: "npm test" })),
          line(resultRecord({ num_turns: 2 })),
        ],
        afterFiles: [
          {
            path: "reports/tests.json",
            action: "write",
            content: JSON.stringify({ suite: "unit", passed: 5, failed: 0, skipped: 1 }),
          },
        ],
      };
    case "approval-flow":
      return {
        fragments: [
          line(initRecord()),
          line(toolUse("toolu_bash2", "Bash", { command: "npm run deploy" })),
          line(
            resultRecord({
              permission_denials: [
                { tool_name: "Bash", tool_use_id: "toolu_bash2", tool_input: { command: "npm run deploy" } },
              ],
            }),
          ),
        ],
      };
    case "pausing":
      return {
        fragments: [line(initRecord())],
        hangMs: 570_000,
      };
    case "deadline-mid-stream":
      return {
        fragments: [line(initRecord())],
        hangMs: 570_000,
      };
    case "workspace-unavailable":
    case "capability-rejection":
      return { fragments: [line(initRecord()), line(resultRecord())] };
    case "failure-mid-stream":
      return {
        fragments: [line(initRecord()), { text: "this is not json\n" }],
        exitCode: 1,
      };
    case "secret-probe":
      return {
        fragments: [line(initRecord())],
        stderr: `authentication rejected for ${TESTKIT_SECRET_CANARY}\n`,
        exitCode: 1,
      };
  }
}

function requestFor(name: CodingAgentScenarioName): Parameters<typeof createCodingAgentRequest>[0] {
  const base = {
    requestId: `req-agent-${name}`,
    workspaceId: WORKSPACE_ID,
    instructions: `scenario ${name}: perform the scripted work`,
    capabilities: ["read-files", "edit-files"] as const,
    disclosure: INTERNAL_DISCLOSURE,
    trace: TESTKIT_TRACE,
  };
  switch (name) {
    case "test-results":
      return {
        ...base,
        capabilities: ["read-files", "edit-files", "run-commands", "run-tests"],
        commandPolicy: { mode: "sandboxed", allowedCommands: [] },
      };
    case "approval-flow":
      return { ...base, approvalMode: "always" };
    case "deadline-mid-stream":
      return {
        ...base,
        deadline: new Date(new Date(HARNESS_EPOCH).valueOf() + 30 * 60_000).toISOString(),
      };
    case "workspace-unavailable":
      return { ...base, workspaceId: "ws-missing" };
    case "capability-rejection":
      return {
        ...base,
        capabilities: ["read-files", "run-commands"],
        commandPolicy: { mode: "allow-listed", allowedCommands: ["npm"] },
      };
    case "secret-probe":
      return { ...base, instructions: `deploy with credential ${TESTKIT_SECRET_CANARY} immediately` };
    default:
      return base;
  }
}

async function createContractHarness(): Promise<CodingAgentContractHarness> {
  const created: ClaudeHarness[] = [];
  let active: ClaudeHarness | null = null;

  return {
    clock: {
      advance(milliseconds: number): void {
        active?.scheduler.advance(milliseconds);
      },
    },
    secretCanary: TESTKIT_SECRET_CANARY,
    async scenario(name: CodingAgentScenarioName) {
      const harness = await createClaudeHarness({ scenario: scenarioFor(name) });
      created.push(harness);
      active = harness;
      return {
        provider: harness.provider,
        request: createCodingAgentRequest(requestFor(name)),
      };
    },
    async dispose(): Promise<void> {
      for (const harness of created.splice(0)) {
        await harness.close();
      }
      active = null;
    },
  };
}

runCodingAgentProviderContractSuite(
  "claude-code adapter over the process-level fake CLI",
  async () => createContractHarness(),
);
