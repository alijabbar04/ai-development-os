import { afterAll } from "vitest";
import { createCodingAgentRequest } from "@ai-dev-os/providers";
import { runCodingAgentProviderContractSuite, type CodingAgentContractHarness, type CodingAgentScenarioName } from "@ai-dev-os/providers/testing";
import { TESTKIT_SECRET_CANARY } from "@ai-dev-os/provider-testkit";
import {
  HARNESS_EPOCH,
  INTERNAL_DISCLOSURE,
  TEST_TRACE,
  WORKSPACE_ID,
  cleanupCodexFixtures,
  createCodexHarness,
  type CodexHarness,
  type FakeCodexScenario,
} from "./helpers/harness.js";

afterAll(cleanupCodexFixtures);

function fakeScenario(name: CodingAgentScenarioName): FakeCodexScenario {
  switch (name) {
    case "patch-producing": return { fileClaim: true, claimedPath: "invented.txt", afterFiles: [{ path: "src/main.ts", action: "write", content: "export const value = 2;\n" }] };
    case "test-results": return { command: true, afterFiles: [{ path: "reports/tests.json", action: "write", content: JSON.stringify({ suite: "unit", passed: 5, failed: 0, skipped: 1 }) }] };
    case "approval-flow": return { command: true, approval: "command" };
    case "pausing": case "deadline-mid-stream": return { hang: true };
    case "failure-mid-stream": return { malformed: true };
    case "secret-probe": return { malformed: true, stderrOnStart: true, stderr: `authentication rejected for ${TESTKIT_SECRET_CANARY}\n` };
    default: return {};
  }
}

function request(name: CodingAgentScenarioName) {
  const base = { requestId: `req-codex-${name}`, workspaceId: WORKSPACE_ID, instructions: `fixture ${name}`, capabilities: ["read-files", "edit-files"] as const, disclosure: INTERNAL_DISCLOSURE, trace: TEST_TRACE };
  switch (name) {
    case "test-results": return createCodingAgentRequest({ ...base, capabilities: ["read-files", "edit-files", "run-commands", "run-tests"], commandPolicy: { mode: "sandboxed", allowedCommands: [] } });
    case "approval-flow": return createCodingAgentRequest({ ...base, capabilities: ["read-files", "edit-files", "run-commands"], commandPolicy: { mode: "sandboxed", allowedCommands: [] }, approvalMode: "always" });
    case "deadline-mid-stream": return createCodingAgentRequest({ ...base, deadline: new Date(new Date(HARNESS_EPOCH).valueOf() + 30 * 60_000).toISOString() });
    case "workspace-unavailable": return createCodingAgentRequest({ ...base, workspaceId: "ws-missing" });
    case "capability-rejection": return createCodingAgentRequest({ ...base, capabilities: ["read-files", "run-commands"], commandPolicy: { mode: "allow-listed", allowedCommands: ["npm"] } });
    case "secret-probe": return createCodingAgentRequest({ ...base, instructions: `use ${TESTKIT_SECRET_CANARY}` });
    default: return createCodingAgentRequest(base);
  }
}

async function contractHarness(): Promise<CodingAgentContractHarness> {
  const opened: CodexHarness[] = []; let active: CodexHarness | null = null;
  return {
    clock: { advance(milliseconds) { active?.scheduler.advance(milliseconds); } },
    secretCanary: TESTKIT_SECRET_CANARY,
    async scenario(name) {
      const harness = await createCodexHarness({ scenario: fakeScenario(name) }); opened.push(harness); active = harness;
      return { provider: harness.provider, request: request(name) };
    },
    async dispose() { for (const harness of opened.splice(0)) await harness.close(); active = null; },
  };
}

runCodingAgentProviderContractSuite("codex adapter over process-level App Server", contractHarness);
