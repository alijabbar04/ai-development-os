import { describe, expect, it } from "vitest";
import { ValidationError } from "@ai-dev-os/domain";
import {
  ProviderError,
  createCodingAgentRequest,
  createInferenceRequest,
  parseChatMessage,
  parseCodingAgentRequest,
  parseCodingAgentResult,
  parseCommandPolicy,
  parseContentPart,
  parseConversation,
  parseFileAccessPolicy,
  parseInferenceRequest,
  parseInferenceResult,
  parseSamplingParameters,
  parseStructuredOutputRequest,
  parseToolChoice,
  parseToolDefinition,
  parseToolInvocation,
  parseToolResult,
  systemMessage,
  textPart,
  userMessage,
} from "../src/index.js";
import {
  CODING_REQUEST_FIXTURE,
  DISCLOSURE_FIXTURE,
  INFERENCE_REQUEST_FIXTURE,
  TRACE_FIXTURE,
} from "./fixtures.js";

const TOOL = {
  name: "read-file",
  description: "Reads a workspace file.",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  risk: "read-only",
  approval: "never",
  executionLocation: "caller",
} as const;

describe("tools", () => {
  it("parses definitions, choices, invocations, and results", () => {
    const tool = parseToolDefinition(TOOL);
    expect(tool.name).toBe("read-file");
    expect(parseToolChoice({ mode: "auto" }).mode).toBe("auto");
    expect(parseToolChoice({ mode: "named", toolName: "read-file" })).toEqual({
      mode: "named",
      toolName: "read-file",
    });

    const invocation = parseToolInvocation({
      toolCallId: "call-1",
      toolName: "read-file",
      arguments: { path: "src/index.ts" },
    });
    expect(invocation.toolCallId).toBe("call-1");

    const success = parseToolResult({
      toolCallId: "call-1",
      toolName: "read-file",
      status: "succeeded",
      output: { content: "..." },
      failure: null,
    });
    expect(success.status).toBe("succeeded");
    const failure = parseToolResult({
      toolCallId: "call-1",
      toolName: "read-file",
      status: "failed",
      output: null,
      failure: { code: "not-found", message: "missing" },
    });
    expect(failure.failure?.code).toBe("not-found");
  });

  it("rejects invalid tool shapes", () => {
    expect(() => parseToolDefinition({ ...TOOL, inputSchema: [1, 2] })).toThrow(ProviderError);
    expect(() => parseToolDefinition({ ...TOOL, risk: "spicy" })).toThrow(ValidationError);
    expect(() => parseToolChoice({ mode: "named" })).toThrow(ValidationError);
    expect(() =>
      parseToolResult({
        toolCallId: "call-1",
        toolName: "read-file",
        status: "failed",
        output: null,
        failure: null,
      }),
    ).toThrow(ProviderError);
    expect(() =>
      parseToolResult({
        toolCallId: "call-1",
        toolName: "read-file",
        status: "succeeded",
        output: null,
        failure: { code: "x", message: "y" },
      }),
    ).toThrow(ProviderError);
    expect(() =>
      parseToolInvocation({ toolCallId: "call-1", toolName: "read-file", arguments: { big: "x".repeat(70_000) } }),
    ).toThrow(ProviderError);
  });
});

describe("content model", () => {
  it("parses every part type and enforces role coherence", () => {
    expect(textPart("hi").type).toBe("text");
    expect(userMessage("hi").role).toBe("user");
    expect(systemMessage("rules").role).toBe("system");
    const artifact = parseContentPart({ type: "artifact", artifactId: "art-1", mediaType: "application/pdf" });
    expect(artifact.type).toBe("artifact");
    const image = parseContentPart({ type: "image-artifact", artifactId: "art-2", mediaType: "image/png" });
    expect(image.type).toBe("image-artifact");
    const json = parseContentPart({ type: "json", value: { a: 1 } });
    expect(json.type).toBe("json");

    expect(() =>
      parseContentPart({ type: "image-artifact", artifactId: "art-2", mediaType: "text/plain" }),
    ).toThrow(ProviderError);
    expect(() =>
      parseChatMessage({
        role: "user",
        parts: [{ type: "tool-invocation", invocation: { toolCallId: "c", toolName: "t", arguments: {} } }],
      }),
    ).toThrow(ProviderError);
    expect(() =>
      parseChatMessage({
        role: "assistant",
        parts: [
          {
            type: "tool-result",
            result: { toolCallId: "c", toolName: "t", status: "succeeded", output: null, failure: null },
          },
        ],
      }),
    ).toThrow(ProviderError);
    expect(() => parseChatMessage({ role: "user", parts: [] })).toThrow(ProviderError);
  });

  it("enforces portable conversation ordering", () => {
    const conversation = parseConversation([
      { role: "system", parts: [{ type: "text", text: "s" }] },
      { role: "user", parts: [{ type: "text", text: "u" }] },
      {
        role: "assistant",
        parts: [
          { type: "tool-invocation", invocation: { toolCallId: "call-1", toolName: "read-file", arguments: {} } },
        ],
      },
      {
        role: "tool",
        parts: [
          {
            type: "tool-result",
            result: { toolCallId: "call-1", toolName: "read-file", status: "succeeded", output: null, failure: null },
          },
        ],
      },
    ]);
    expect(conversation).toHaveLength(4);

    expect(() =>
      parseConversation([
        { role: "user", parts: [{ type: "text", text: "u" }] },
        { role: "system", parts: [{ type: "text", text: "late" }] },
      ]),
    ).toThrow(ProviderError);
    expect(() =>
      parseConversation([
        { role: "user", parts: [{ type: "text", text: "u" }] },
        {
          role: "tool",
          parts: [
            {
              type: "tool-result",
              result: { toolCallId: "ghost", toolName: "t", status: "succeeded", output: null, failure: null },
            },
          ],
        },
      ]),
    ).toThrow(ProviderError);
    expect(() => parseConversation([])).toThrow(ProviderError);
    expect(() => parseConversation(JSON.parse('[{"__proto__": {"role": "user"}}]'))).toThrow();
  });
});

describe("inference request/result", () => {
  it("parses and freezes a full request; convenience creator defaults optionals", () => {
    const request = parseInferenceRequest(INFERENCE_REQUEST_FIXTURE);
    expect(request.modelId).toBe("fake-model");
    expect(Object.isFrozen(request)).toBe(true);
    const convenient = createInferenceRequest({
      requestId: "req-2",
      modelId: "fake-model",
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
      disclosure: DISCLOSURE_FIXTURE,
      trace: TRACE_FIXTURE,
    });
    expect(convenient.tools).toHaveLength(0);
    expect(convenient.deadline).toBeNull();
  });

  it("validates sampling, structured output, and cross-field tool rules", () => {
    expect(parseSamplingParameters({ temperature: 0.7, topP: null, seed: 42 }).seed).toBe(42);
    expect(() => parseSamplingParameters({ temperature: 3, topP: null, seed: null })).toThrow(
      ProviderError,
    );
    expect(() => parseSamplingParameters({ temperature: Number.NaN, topP: null, seed: null })).toThrow(
      ProviderError,
    );
    expect(parseStructuredOutputRequest({ schema: { type: "object" }, strict: true }).strict).toBe(true);
    expect(() => parseStructuredOutputRequest({ schema: "not-an-object", strict: true })).toThrow(
      ProviderError,
    );

    expect(() =>
      parseInferenceRequest({
        ...INFERENCE_REQUEST_FIXTURE,
        toolChoice: { mode: "named", toolName: "ghost-tool" },
      }),
    ).toThrow(ProviderError);
    expect(() =>
      parseInferenceRequest({ ...INFERENCE_REQUEST_FIXTURE, tools: [TOOL, TOOL] }),
    ).toThrow(ProviderError);
    expect(() =>
      parseInferenceRequest({ ...INFERENCE_REQUEST_FIXTURE, schemaVersion: 2 }),
    ).toThrow(ValidationError);
    expect(() =>
      parseInferenceRequest({ ...INFERENCE_REQUEST_FIXTURE, extra: true }),
    ).toThrow(ValidationError);
  });

  it("parses results and rejects non-assistant output messages", () => {
    const result = parseInferenceResult({
      schemaVersion: 1,
      operationId: "op-1",
      requestId: "req-1",
      modelId: "fake-model",
      messages: [{ role: "assistant", parts: [{ type: "text", text: "hello" }] }],
      structuredOutput: null,
      finishReason: "stop",
      refusalMessage: null,
      usage: { tokens: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0, reasoningTokens: 0 }, toolCalls: 0 },
      cost: { providerReported: null, locallyComputed: null },
      latency: { firstEventMs: 1, totalMs: 10 },
      warnings: [],
    });
    expect(result.finishReason).toBe("stop");
    expect(() =>
      parseInferenceResult({
        ...result,
        messages: [{ role: "user", parts: [{ type: "text", text: "not output" }] }],
      }),
    ).toThrow(ProviderError);
  });
});

describe("coding-agent request/result", () => {
  it("parses and freezes a full request with policy coherence", () => {
    const request = parseCodingAgentRequest(CODING_REQUEST_FIXTURE);
    expect(request.workspaceId).toBe("ws-1");
    expect(request.capabilities).toContain("edit-files");
    expect(Object.isFrozen(request)).toBe(true);

    const convenient = createCodingAgentRequest({
      requestId: "req-c-2",
      workspaceId: "ws-2",
      instructions: "Look around only.",
      disclosure: DISCLOSURE_FIXTURE,
      trace: TRACE_FIXTURE,
    });
    expect(convenient.capabilities).toEqual(["read-files"]);
    expect(convenient.networkPolicy).toBe("denied");
  });

  it("rejects incoherent policies and unsafe paths", () => {
    expect(() =>
      parseCodingAgentRequest({
        ...CODING_REQUEST_FIXTURE,
        commandPolicy: { mode: "allow-listed", allowedCommands: ["npm"] },
      }),
    ).toThrow(ProviderError);
    expect(() =>
      parseCommandPolicy({ mode: "none", allowedCommands: ["npm"] }),
    ).toThrow(ProviderError);
    expect(() =>
      parseCommandPolicy({ mode: "allow-listed", allowedCommands: ["rm -rf /"] }),
    ).toThrow(ValidationError);
    expect(() =>
      parseFileAccessPolicy({ allowedPathPrefixes: ["../escape"] }),
    ).toThrow(ValidationError);
    expect(() =>
      parseCodingAgentRequest({ ...CODING_REQUEST_FIXTURE, instructions: "" }),
    ).toThrow(ValidationError);
  });

  it("parses results with artifact references and consistency rules", () => {
    const base = {
      schemaVersion: 1,
      operationId: "op-1",
      requestId: "req-c-1",
      completion: "completed",
      patchArtifactId: "art-patch-1",
      changedFiles: [{ path: "src/index.ts", changeKind: "modified" }],
      testResults: { artifactId: "art-tests-1", passed: 10, failed: 0, skipped: 1 },
      commandLogArtifactId: null,
      diagnosticsArtifactId: null,
      producedArtifacts: ["art-patch-1", "art-tests-1"],
      baseRevision: "abc1234",
      resultRevision: "def5678",
      approvalDecisions: [{ approvalId: "appr-1", decision: "approved" }],
      usage: { tokens: { inputTokens: 5, outputTokens: 6, cachedInputTokens: 0, reasoningTokens: 0 }, toolCalls: 2 },
      cost: { providerReported: null, locallyComputed: { currency: "USD", amountMicros: 12 } },
      latency: { firstEventMs: 5, totalMs: 50 },
      warnings: ["tests were flaky"],
      resumeToken: null,
    };
    const result = parseCodingAgentResult(base);
    expect(result.changedFiles[0]!.path).toBe("src/index.ts");
    expect(() =>
      parseCodingAgentResult({ ...base, completion: "completed-no-changes" }),
    ).toThrow(ProviderError);
    expect(() =>
      parseCodingAgentResult({
        ...base,
        changedFiles: [{ path: "..\\evil", changeKind: "added" }],
      }),
    ).toThrow(ValidationError);
  });
});
