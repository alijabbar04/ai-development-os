import {
  createCodingAgentRequest,
  createInferenceRequest,
  parseDisclosureContext,
  type CodingAgentRequest,
  type InferenceRequest,
  type ToolDefinition,
} from "@ai-dev-os/providers";
import type {
  CodingAgentContractHarness,
  CodingAgentScenarioName,
  InferenceContractHarness,
  InferenceScenarioName,
} from "@ai-dev-os/providers/testing";
import { createFakeCodingAgentProvider, type CodingAgentScript } from "./fake-coding-agent.js";
import { createFakeInferenceProvider, type InferenceScript } from "./fake-inference.js";
import { INTERNAL_DISCLOSURE, TESTKIT_TRACE } from "./fixtures.js";
import { createManualScheduler, TESTKIT_EPOCH, type ManualScheduler } from "./scheduler.js";

export const TESTKIT_SECRET_CANARY = "sk-live-TESTKIT-CANARY-7777";

const READ_TOOL = {
  name: "read-file",
  description: "Reads a workspace file.",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  risk: "read-only",
  approval: "never",
  executionLocation: "caller",
} as unknown as ToolDefinition;

function minutesAfterEpoch(minutes: number): string {
  return new Date(new Date(TESTKIT_EPOCH).valueOf() + minutes * 60_000).toISOString();
}

function inferenceRequest(
  name: string,
  overrides: Partial<Parameters<typeof createInferenceRequest>[0]> = {},
): InferenceRequest {
  return createInferenceRequest({
    requestId: `req-${name}`,
    modelId: "fake-model",
    messages: [{ role: "user", parts: [{ type: "text", text: `scenario ${name}` }] }],
    disclosure: INTERNAL_DISCLOSURE,
    trace: TESTKIT_TRACE,
    ...overrides,
  });
}

/** Standard scenario harness driving the reusable inference contract suite
 * with the deterministic fake. Concrete adapters implement the same harness
 * shape against their own transports. */
export function createStandardInferenceHarness(): InferenceContractHarness {
  const scheduler: ManualScheduler = createManualScheduler();

  const scripts: Record<InferenceScenarioName, () => { script: InferenceScript; request: InferenceRequest; providerOverrides?: Parameters<typeof createFakeInferenceProvider>[0]["descriptor"] }> = {
    "basic-text": () => ({
      script: { steps: [{ kind: "text", text: "Hello from the fake provider." }] },
      request: inferenceRequest("basic-text"),
    }),
    "streaming-chunks": () => ({
      script: { steps: [{ kind: "text", text: "streamed in many pieces", chunkSize: 4 }] },
      request: inferenceRequest("streaming-chunks"),
    }),
    "structured-output": () => ({
      script: { steps: [{ kind: "structured", value: { answer: 42, ok: true } }] },
      request: inferenceRequest("structured-output", {
        structuredOutput: { schema: { type: "object" }, strict: true },
      }),
    }),
    "single-tool-call": () => ({
      script: {
        steps: [
          {
            kind: "tool-call",
            toolName: "read-file",
            arguments: { path: "src/index.ts" },
            argumentDeltas: 2,
          },
        ],
      },
      request: inferenceRequest("single-tool-call", { tools: [READ_TOOL] }),
    }),
    "multi-tool-call": () => ({
      script: {
        steps: [
          { kind: "tool-call", toolName: "read-file", arguments: { path: "a.ts" } },
          { kind: "tool-call", toolName: "read-file", arguments: { path: "b.ts" } },
        ],
      },
      request: inferenceRequest("multi-tool-call", { tools: [READ_TOOL] }),
    }),
    "usage-updates": () => ({
      script: {
        steps: [
          { kind: "usage", inputTokens: 10, outputTokens: 0 },
          { kind: "text", text: "working" },
          { kind: "usage", inputTokens: 10, outputTokens: 25 },
        ],
      },
      request: inferenceRequest("usage-updates"),
    }),
    pausing: () => ({
      script: {
        steps: [
          { kind: "text", text: "before-" },
          { kind: "delay", ms: 600_000 },
          { kind: "text", text: "after" },
        ],
      },
      request: inferenceRequest("pausing"),
    }),
    "deadline-before-start": () => ({
      script: { steps: [{ kind: "text", text: "never emitted" }] },
      request: inferenceRequest("deadline-before-start", { deadline: TESTKIT_EPOCH }),
    }),
    "deadline-mid-stream": () => ({
      script: {
        steps: [
          { kind: "text", text: "before-" },
          { kind: "delay", ms: 600_000 },
          { kind: "text", text: "after" },
        ],
      },
      request: inferenceRequest("deadline-mid-stream", { deadline: minutesAfterEpoch(30) }),
    }),
    "unsupported-capability": () => ({
      script: { steps: [] },
      request: inferenceRequest("unsupported-capability", { tools: [READ_TOOL] }),
      providerOverrides: { capabilities: { toolCalling: false } },
    }),
    "classification-rejected": () => ({
      script: { steps: [] },
      request: inferenceRequest("classification-rejected", {
        disclosure: parseDisclosureContext({
          classification: "proprietary-source",
          requiredLocality: "any",
          redactionApplied: true,
          decisionRef: null,
          retentionAllowed: false,
          loggingAllowed: false,
        }),
      }),
    }),
    "failure-before-stream": () => ({
      script: { steps: [], rejectStart: { code: "RATE_LIMITED", retryAfterMs: 1_500 } },
      request: inferenceRequest("failure-before-stream"),
    }),
    "failure-mid-stream": () => ({
      script: {
        steps: [
          { kind: "text", text: "partial " },
          { kind: "fail", code: "PROVIDER_OVERLOADED", message: "scripted overload" },
        ],
      },
      request: inferenceRequest("failure-mid-stream"),
    }),
    "malformed-stream": () => ({
      script: {
        steps: [],
        rawStream: {
          events: [
            rawEvent(1, "operation-started", { modelId: "fake-model" }),
            rawEvent(3, "operation-completed", {}),
          ],
          rawResult: "reject",
        },
      },
      request: inferenceRequest("malformed-stream"),
    }),
    "terminal-mismatch": () => ({
      script: {
        steps: [],
        rawStream: {
          events: [
            rawEvent(1, "operation-started", { modelId: "fake-model" }),
            rawEvent(2, "operation-completed", {}),
          ],
          rawResult: "reject",
        },
      },
      request: inferenceRequest("terminal-mismatch"),
    }),
    "secret-probe": () => ({
      script: {
        steps: [
          { kind: "text", text: "thinking " },
          { kind: "fail", code: "INTERNAL_FAILURE", message: "the model backend crashed" },
        ],
      },
      request: inferenceRequest("secret-probe", {
        messages: [
          {
            role: "user",
            parts: [{ type: "text", text: `use this token: ${TESTKIT_SECRET_CANARY}` }],
          },
        ],
      }),
    }),
  };

  function rawEvent(sequence: number, kind: string, payload: unknown): unknown {
    return {
      schemaVersion: 1,
      operationId: "op-000001",
      sequence,
      occurredAt: TESTKIT_EPOCH,
      trace: { traceId: "trace-testkit", runId: null, taskId: null, taskRunId: null },
      kind,
      payload,
    };
  }

  return {
    clock: scheduler,
    secretCanary: TESTKIT_SECRET_CANARY,
    async scenario(name: InferenceScenarioName) {
      const { script, request, providerOverrides } = scripts[name]();
      const provider = createFakeInferenceProvider({
        script,
        scheduler,
        ...(providerOverrides === undefined ? {} : { descriptor: providerOverrides }),
      });
      return { provider, request };
    },
  };
}

function codingRequest(
  name: string,
  overrides: Partial<Parameters<typeof createCodingAgentRequest>[0]> = {},
): CodingAgentRequest {
  return createCodingAgentRequest({
    requestId: `req-agent-${name}`,
    workspaceId: "ws-testkit",
    instructions: `scenario ${name}: perform the scripted work`,
    capabilities: ["read-files", "edit-files", "run-tests"],
    disclosure: INTERNAL_DISCLOSURE,
    trace: TESTKIT_TRACE,
    ...overrides,
  });
}

/** Standard scenario harness for the coding-agent contract suite. */
export function createStandardCodingAgentHarness(): CodingAgentContractHarness {
  const scheduler: ManualScheduler = createManualScheduler();

  const scripts: Record<
    CodingAgentScenarioName,
    () => {
      script: CodingAgentScript;
      request: CodingAgentRequest;
      providerOptions?: Partial<Parameters<typeof createFakeCodingAgentProvider>[0]>;
    }
  > = {
    "no-change": () => ({
      script: {
        steps: [
          { kind: "status", message: "inspecting the workspace" },
          { kind: "workspace-read", path: "src/index.ts" },
        ],
      },
      request: codingRequest("no-change"),
    }),
    "patch-producing": () => ({
      script: {
        steps: [
          { kind: "status", message: "editing" },
          { kind: "file-change", path: "src/a.ts", changeKind: "modified" },
          { kind: "file-change", path: "src/b.ts", changeKind: "added" },
          { kind: "patch", artifactId: "art-patch-1" },
          { kind: "usage", inputTokens: 100, outputTokens: 200 },
        ],
      },
      request: codingRequest("patch-producing"),
    }),
    "test-results": () => ({
      script: {
        steps: [
          { kind: "file-change", path: "src/a.ts", changeKind: "modified" },
          { kind: "test-run", suite: "unit", passed: 12, failed: 0, skipped: 1, artifactId: "art-tests-1" },
          { kind: "patch", artifactId: "art-patch-2" },
        ],
      },
      request: codingRequest("test-results"),
    }),
    "approval-flow": () => ({
      script: {
        steps: [
          { kind: "tool-proposal", toolName: "run-migration", arguments: { dryRun: false } },
          {
            kind: "approval",
            summary: "Run the database migration",
            risk: "destructive",
            decision: "approved",
          },
          { kind: "file-change", path: "migrations/001.sql", changeKind: "added" },
        ],
      },
      request: codingRequest("approval-flow", { approvalMode: "always" }),
    }),
    pausing: () => ({
      script: {
        steps: [
          { kind: "status", message: "long-running work" },
          { kind: "delay", ms: 600_000 },
          { kind: "status", message: "resumed" },
        ],
      },
      request: codingRequest("pausing"),
    }),
    "deadline-mid-stream": () => ({
      script: {
        steps: [
          { kind: "status", message: "long-running work" },
          { kind: "delay", ms: 600_000 },
          { kind: "status", message: "resumed" },
        ],
      },
      request: codingRequest("deadline-mid-stream", { deadline: minutesAfterEpoch(30) }),
    }),
    "workspace-unavailable": () => ({
      script: { steps: [] },
      request: codingRequest("workspace-unavailable", { workspaceId: "ws-missing" }),
      providerOptions: { unavailableWorkspaces: ["ws-missing"] },
    }),
    "capability-rejection": () => ({
      script: { steps: [] },
      request: codingRequest("capability-rejection", {
        capabilities: ["read-files", "edit-files", "git-commit"],
      }),
      providerOptions: { grantedCapabilities: ["read-files", "edit-files"] },
    }),
    "failure-mid-stream": () => ({
      script: {
        steps: [
          { kind: "status", message: "starting" },
          { kind: "fail", code: "INTERNAL_FAILURE", message: "agent crashed as scripted" },
        ],
      },
      request: codingRequest("failure-mid-stream"),
    }),
    "secret-probe": () => ({
      script: {
        steps: [
          { kind: "status", message: "reading instructions" },
          { kind: "fail", code: "CONTENT_REJECTED", message: "instructions were rejected" },
        ],
      },
      request: codingRequest("secret-probe", {
        instructions: `deploy with credential ${TESTKIT_SECRET_CANARY} immediately`,
      }),
    }),
  };

  return {
    clock: scheduler,
    secretCanary: TESTKIT_SECRET_CANARY,
    async scenario(name: CodingAgentScenarioName) {
      const { script, request, providerOptions } = scripts[name]();
      const provider = createFakeCodingAgentProvider({
        script,
        scheduler,
        ...(providerOptions ?? {}),
      });
      return { provider, request };
    },
  };
}
