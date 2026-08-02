import type { ModelCapabilities } from "@ai-dev-os/domain";

export const MODEL_FIXTURE = {
  schemaVersion: 1,
  providerId: "fake-provider",
  modelId: "fake-model",
  contextWindowTokens: 100_000,
  maxOutputTokens: 8_000,
  supportsToolUse: true,
  supportsStructuredOutput: true,
  supportsVision: false,
  locality: "cloud",
  latencyClass: "fast",
  codingCapability: 3,
  reasoningCapability: 4,
  cost: {
    currency: "USD",
    inputMicrosPerMillionTokens: 1_000_000,
    outputMicrosPerMillionTokens: 2_000_000,
    cachedInputMicrosPerMillionTokens: null,
  },
} as unknown as ModelCapabilities;

export const CAPABILITIES_FIXTURE = {
  streaming: true,
  structuredOutput: true,
  toolCalling: true,
  imageInput: false,
  repositoryEditing: false,
  commandExecution: false,
  networkAccess: false,
  resumability: false,
  cancellation: "guaranteed",
  deadlineEnforcement: true,
  usageReporting: true,
  pricingAvailable: true,
} as const;

export const DESCRIPTOR_FIXTURE = {
  schemaVersion: 1,
  providerId: "fake-provider",
  instanceId: "fake-instance-1",
  kind: "inference",
  displayName: "Fake Inference Provider",
  locality: "cloud",
  retainsData: false,
  trainsOnInputs: false,
  supportedClassifications: ["public", "internal"],
  capabilities: CAPABILITIES_FIXTURE,
} as const;

export const TRACE_FIXTURE = {
  traceId: "trace-1",
  runId: "run-1",
  taskId: "task-1",
  taskRunId: "attempt-1",
} as const;

export const DISCLOSURE_FIXTURE = {
  classification: "internal",
  requiredLocality: "any",
  redactionApplied: true,
  decisionRef: "decision-1",
  retentionAllowed: false,
  loggingAllowed: false,
} as const;

export const INFERENCE_REQUEST_FIXTURE = {
  schemaVersion: 1,
  requestId: "req-1",
  modelId: "fake-model",
  messages: [
    { role: "system", parts: [{ type: "text", text: "You are helpful." }] },
    { role: "user", parts: [{ type: "text", text: "Say hello." }] },
  ],
  tools: [],
  toolChoice: null,
  structuredOutput: null,
  sampling: null,
  maxOutputTokens: 512,
  stopSequences: [],
  disclosure: DISCLOSURE_FIXTURE,
  estimatedUsage: { inputTokens: 20, outputTokens: 30 },
  deadline: null,
  trace: TRACE_FIXTURE,
  extensions: [],
} as const;

export const CODING_REQUEST_FIXTURE = {
  schemaVersion: 1,
  requestId: "req-c-1",
  modelId: null,
  workspaceId: "ws-1",
  baseRevision: "abc1234",
  instructions: "Rename the helper and update call sites.",
  capabilities: ["read-files", "edit-files", "run-tests"],
  fileAccess: { allowedPathPrefixes: ["src"] },
  commandPolicy: { mode: "none", allowedCommands: [] },
  networkPolicy: "denied",
  approvalMode: "on-risk",
  maxChangedFiles: 32,
  maxProducedBytes: 10_000_000,
  budget: null,
  estimatedUsage: null,
  deadline: null,
  disclosure: DISCLOSURE_FIXTURE,
  inputArtifacts: [],
  expectedOutputKinds: ["patch", "test-result"],
  resumeToken: null,
  trace: TRACE_FIXTURE,
  extensions: [],
} as const;
