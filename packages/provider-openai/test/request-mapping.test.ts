import { describe, expect, it } from "vitest";
import { type ProviderError } from "@ai-dev-os/providers";
import { textStreamScript } from "./helpers/fake-openai.js";
import {
  READ_TOOL,
  TEST_MODEL,
  TEST_SAFETY_IDENTIFIER,
  createTestProvider,
  testCatalog,
  testRequest,
} from "./helpers/fixtures.js";

interface SentBody {
  readonly model: string;
  readonly input: readonly Record<string, unknown>[];
  readonly stream: boolean;
  readonly store: boolean;
  readonly tools?: readonly Record<string, unknown>[];
  readonly tool_choice?: unknown;
  readonly text?: Record<string, unknown>;
  readonly reasoning?: Record<string, unknown>;
  readonly max_output_tokens?: number;
  readonly safety_identifier?: string;
  readonly parallel_tool_calls?: boolean;
  readonly background?: boolean;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly service_tier?: string;
}

async function capture(
  request: Parameters<ReturnType<typeof createTestProvider>["provider"]["start"]>[0],
  options: Parameters<typeof createTestProvider>[0] = {},
): Promise<SentBody> {
  const handle = createTestProvider(options);
  handle.fake.script("create", { stream: textStreamScript(["ok"]) });
  const operation = await handle.provider.start(request);
  await operation.result.catch(() => undefined);
  await handle.provider.close();
  return handle.fake.requests[0]!.body as SentBody;
}

function detailCode(error: unknown): unknown {
  return (error as ProviderError).details["detailCode"];
}

describe("message and role mapping", () => {
  it("preserves system, developer, user, and assistant roles distinctly", async () => {
    const body = await capture(
      testRequest("roles", {
        messages: [
          { role: "system", parts: [{ type: "text", text: "system rules" }] },
          { role: "developer", parts: [{ type: "text", text: "developer rules" }] },
          { role: "user", parts: [{ type: "text", text: "hello" }] },
          { role: "assistant", parts: [{ type: "text", text: "prior reply" }] },
          { role: "user", parts: [{ type: "text", text: "follow up" }] },
        ],
      }),
    );
    expect(body.input.map((item) => item["role"])).toEqual([
      "system",
      "developer",
      "user",
      "assistant",
      "user",
    ]);
    // Instruction roles are not collapsed into one another.
    expect(body.input[0]!["role"]).not.toBe(body.input[1]!["role"]);
  });

  it("sends instruction and user content as typed input_text parts", async () => {
    const body = await capture(
      testRequest("parts", {
        messages: [
          { role: "system", parts: [{ type: "text", text: "rules" }] },
          { role: "user", parts: [{ type: "text", text: "hi" }] },
        ],
      }),
    );
    expect(body.input[0]!["content"]).toEqual([{ type: "input_text", text: "rules" }]);
    expect(body.input[1]!["content"]).toEqual([{ type: "input_text", text: "hi" }]);
  });

  it("preserves canonical JSON for structured content parts", async () => {
    const body = await capture(
      testRequest("json-part", {
        messages: [
          {
            role: "user",
            parts: [{ type: "json", value: { b: 2, a: 1, nested: { z: 1, y: 2 } } }],
          },
        ],
      }),
    );
    const content = body.input[0]!["content"] as readonly { text: string }[];
    // Canonical form sorts keys deterministically.
    expect(content[0]!.text).toBe('{"a":1,"b":2,"nested":{"y":2,"z":1}}');
  });

  it("maps assistant tool invocations and tool results to the continuation shape", async () => {
    const body = await capture(
      testRequest("continuation", {
        tools: [READ_TOOL],
        messages: [
          { role: "user", parts: [{ type: "text", text: "read a file" }] },
          {
            role: "assistant",
            parts: [
              {
                type: "tool-invocation",
                invocation: {
                  toolCallId: "call_1",
                  toolName: "read-file",
                  arguments: { path: "src/a.ts" },
                },
              },
            ],
          },
          {
            role: "tool",
            parts: [
              {
                type: "tool-result",
                result: {
                  toolCallId: "call_1",
                  toolName: "read-file",
                  status: "succeeded",
                  output: { contents: "hello" },
                  failure: null,
                },
              },
            ],
          },
        ],
      }),
    );
    expect(body.input[1]).toEqual({
      type: "function_call",
      call_id: "call_1",
      name: "read-file",
      arguments: '{"path":"src/a.ts"}',
    });
    expect(body.input[2]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: '{"contents":"hello"}',
    });
  });

  it("encodes a failed tool result without losing the failure", async () => {
    const body = await capture(
      testRequest("tool-failure", {
        tools: [READ_TOOL],
        messages: [
          { role: "user", parts: [{ type: "text", text: "read" }] },
          {
            role: "assistant",
            parts: [
              {
                type: "tool-invocation",
                invocation: { toolCallId: "call_1", toolName: "read-file", arguments: {} },
              },
            ],
          },
          {
            role: "tool",
            parts: [
              {
                type: "tool-result",
                result: {
                  toolCallId: "call_1",
                  toolName: "read-file",
                  status: "failed",
                  output: null,
                  failure: { code: "not-found", message: "missing" },
                },
              },
            ],
          },
        ],
      }),
    );
    expect(body.input[2]!["output"]).toBe('{"error":{"code":"not-found","message":"missing"}}');
  });
});

describe("artifact content", () => {
  it("rejects generic artifact parts before any network access", async () => {
    const { provider, fake } = createTestProvider({ withArtifacts: true });
    try {
      await provider.start(
        testRequest("artifact", {
          messages: [
            {
              role: "user",
              parts: [{ type: "artifact", artifactId: "art-1", mediaType: "application/pdf" }],
            },
          ],
        }),
      );
      expect.unreachable("expected refusal");
    } catch (error) {
      expect(detailCode(error)).toBe("artifact-content-unsupported");
    }
    expect(fake.requests).toHaveLength(0);
    await provider.close();
  });

  it("inlines an image only through the authorized resolver", async () => {
    const handle = createTestProvider({ withArtifacts: true });
    handle.fake.script("create", { stream: textStreamScript(["ok"]) });
    const operation = await handle.provider.start(
      testRequest("image", {
        messages: [
          {
            role: "user",
            parts: [
              { type: "text", text: "describe" },
              { type: "image-artifact", artifactId: "art-1", mediaType: "image/png" },
            ],
          },
        ],
      }),
    );
    await operation.result.catch(() => undefined);
    expect(handle.artifacts.reads).toEqual(["art-1"]);
    const body = handle.fake.requests[0]!.body as SentBody;
    const content = body.input[0]!["content"] as readonly Record<string, unknown>[];
    expect(content[1]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,AQIDBA==",
      detail: "auto",
    });
    await handle.provider.close();
  });

  it("refuses images when no resolver is injected", async () => {
    const { provider, fake } = createTestProvider();
    try {
      await provider.start(
        testRequest("no-resolver", {
          messages: [
            {
              role: "user",
              parts: [{ type: "image-artifact", artifactId: "art-1", mediaType: "image/png" }],
            },
          ],
        }),
      );
      expect.unreachable("expected refusal");
    } catch (error) {
      expect(detailCode(error)).toBe("artifact-resolver-unavailable");
    }
    expect(fake.requests).toHaveLength(0);
    await provider.close();
  });

  it("refuses images when the model lacks vision", async () => {
    const { provider, fake } = createTestProvider({
      withArtifacts: true,
      configuration: { catalog: testCatalog({ supportsVision: false }) },
    });
    try {
      await provider.start(
        testRequest("no-vision", {
          messages: [
            {
              role: "user",
              parts: [{ type: "image-artifact", artifactId: "art-1", mediaType: "image/png" }],
            },
          ],
        }),
      );
      expect.unreachable("expected refusal");
    } catch (error) {
      expect(detailCode(error)).toBe("model-lacks-vision");
    }
    expect(fake.requests).toHaveLength(0);
    await provider.close();
  });
});

describe("tools and structured output", () => {
  it("maps custom functions with exact names and schemas", async () => {
    const body = await capture(testRequest("tools", { tools: [READ_TOOL] }));
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "read-file",
        description: "Reads a workspace file.",
        parameters: { properties: { path: { type: "string" } }, type: "object" },
        strict: false,
      },
    ]);
  });

  it("never enables parallel tool calls implicitly", async () => {
    const off = await capture(testRequest("parallel-off", { tools: [READ_TOOL] }));
    expect(off.parallel_tool_calls).toBe(false);
    const on = await capture(testRequest("parallel-on", { tools: [READ_TOOL] }), {
      configuration: { parallelToolCallsEnabled: true },
    });
    expect(on.parallel_tool_calls).toBe(true);
  });

  it("maps every tool-choice mode", async () => {
    expect((await capture(testRequest("tc-auto", { tools: [READ_TOOL], toolChoice: { mode: "auto" } }))).tool_choice).toBe("auto");
    expect((await capture(testRequest("tc-req", { tools: [READ_TOOL], toolChoice: { mode: "required" } }))).tool_choice).toBe("required");
    expect(
      (
        await capture(
          testRequest("tc-named", {
            tools: [READ_TOOL],
            toolChoice: { mode: "named", toolName: "read-file" },
          }),
        )
      ).tool_choice,
    ).toEqual({ type: "function", name: "read-file" });
  });

  it("refuses a provider-executed tool", async () => {
    const hosted = { ...READ_TOOL, executionLocation: "provider" } as typeof READ_TOOL;
    const { provider, fake } = createTestProvider();
    try {
      await provider.start(testRequest("hosted", { tools: [hosted] }));
      expect.unreachable("expected refusal");
    } catch (error) {
      expect(detailCode(error)).toBe("hosted-tools-unsupported");
    }
    expect(fake.requests).toHaveLength(0);
    await provider.close();
  });

  it("maps structured output to the json_schema text format", async () => {
    const body = await capture(
      testRequest("structured", {
        structuredOutput: { schema: { type: "object", properties: { a: { type: "string" } } }, strict: true },
      }),
    );
    expect(body.text!["format"]).toEqual({
      type: "json_schema",
      name: "structured_output",
      schema: { properties: { a: { type: "string" } }, type: "object" },
      strict: true,
    });
  });

  it("refuses structured output when the model does not support it", async () => {
    const { provider } = createTestProvider({
      configuration: { catalog: testCatalog({ supportsStructuredOutput: false }) },
    });
    await expect(
      provider.start(
        testRequest("no-structured", { structuredOutput: { schema: { type: "object" }, strict: true } }),
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    await provider.close();
  });
});

describe("sampling, bounds, and unsupported knobs", () => {
  it("omits sampling fields for a model that rejects them", async () => {
    const { provider, fake } = createTestProvider();
    try {
      await provider.start(
        testRequest("sampling", { sampling: { temperature: 0.5, topP: null, seed: null } }),
      );
      expect.unreachable("expected refusal");
    } catch (error) {
      expect(detailCode(error)).toBe("model-rejects-sampling-parameters");
    }
    expect(fake.requests).toHaveLength(0);
    await provider.close();
  });

  it("sends sampling fields when the snapshot says the model accepts them", async () => {
    const body = await capture(
      testRequest("sampling-ok", { sampling: { temperature: 0.5, topP: 0.9, seed: null } }),
      { configuration: { catalog: testCatalog({ supportsSampling: true }) } },
    );
    expect(body.temperature).toBe(0.5);
    expect(body.top_p).toBe(0.9);
  });

  it("refuses a seed rather than silently dropping a determinism request", async () => {
    const { provider } = createTestProvider({
      configuration: { catalog: testCatalog({ supportsSampling: true }) },
    });
    try {
      await provider.start(testRequest("seed", { sampling: { temperature: null, topP: null, seed: 7 } }));
      expect.unreachable("expected refusal");
    } catch (error) {
      expect(detailCode(error)).toBe("seed-unsupported");
    }
    await provider.close();
  });

  it("refuses stop sequences, which the Responses API does not expose", async () => {
    const { provider } = createTestProvider();
    try {
      await provider.start(testRequest("stops", { stopSequences: ["END"] }));
      expect.unreachable("expected refusal");
    } catch (error) {
      expect(detailCode(error)).toBe("stop-sequences-unsupported");
    }
    await provider.close();
  });

  it("clamps and validates the output bound against the model limit", async () => {
    const body = await capture(testRequest("bounded", { maxOutputTokens: 1_000 }));
    expect(body.max_output_tokens).toBe(1_000);

    const { provider } = createTestProvider({
      configuration: { catalog: testCatalog({ maxOutputTokens: 500 }) },
    });
    try {
      await provider.start(testRequest("too-big", { maxOutputTokens: 1_000 }));
      expect.unreachable("expected refusal");
    } catch (error) {
      expect(detailCode(error)).toBe("max-output-tokens-exceeds-model");
    }
    await provider.close();
  });
});

describe("storage, safety identifier, and service tier", () => {
  it("sends store:false by default and never sets background", async () => {
    const body = await capture(testRequest("default-store"));
    expect(body.store).toBe(false);
    expect(body.background).toBeUndefined();
    expect(body.stream).toBe(true);
  });

  it("sends the derived safety identifier", async () => {
    const body = await capture(testRequest("safety"));
    expect(body.safety_identifier).toBe(TEST_SAFETY_IDENTIFIER);
  });

  it("refuses to start when a safety identifier is required but no source is injected", async () => {
    const { provider, fake } = createTestProvider({ withSafetyIdentifier: false });
    try {
      await provider.start(testRequest("no-safety"));
      expect.unreachable("expected refusal");
    } catch (error) {
      expect(detailCode(error)).toBe("safety-identifier-required");
    }
    expect(fake.requests).toHaveLength(0);
    await provider.close();
  });

  it("omits the safety identifier when it is configured as optional", async () => {
    const body = await capture(testRequest("optional-safety"), {
      withSafetyIdentifier: false,
      configuration: { safetyIdentifierRequired: false },
    });
    expect(body.safety_identifier).toBeUndefined();
  });

  it("sends the configured service tier and verbosity", async () => {
    const body = await capture(testRequest("tier"), {
      configuration: { serviceTier: "flex", verbosity: "low" },
    });
    expect(body.service_tier).toBe("flex");
    expect(body.text!["verbosity"]).toBe("low");
  });
});

describe("reasoning controls", () => {
  it("sends the configured effort but no summary when disclosure is off", async () => {
    const body = await capture(testRequest("reasoning"), {
      configuration: { reasoning: { effort: "high", discloseReasoning: false } },
    });
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  it("requests a summary only when disclosure is permitted", async () => {
    const body = await capture(testRequest("reasoning-disclosed"), {
      configuration: { reasoning: { effort: "low", summary: "concise", discloseReasoning: true } },
    });
    expect(body.reasoning).toEqual({ effort: "low", summary: "concise" });
  });

  it("omits reasoning entirely for a model that does not support it", async () => {
    const body = await capture(testRequest("no-reasoning"), {
      configuration: {
        reasoning: { effort: "high", discloseReasoning: false },
        catalog: testCatalog({ supportsReasoning: false }),
      },
    });
    expect(body.reasoning).toBeUndefined();
  });
});

describe("request extensions may only tighten", () => {
  async function startWithExtension(
    key: string,
    value: unknown,
    options: Parameters<typeof createTestProvider>[0] = {},
  ): Promise<{ body: SentBody | null; error: unknown }> {
    const handle = createTestProvider(options);
    handle.fake.script("create", { stream: textStreamScript(["ok"]) });
    try {
      const operation = await handle.provider.start(
        testRequest(`ext-${key}`, {
          extensions: [{ namespace: "openai", key, value: value as never }],
        }),
      );
      await operation.result.catch(() => undefined);
      await handle.provider.close();
      return { body: handle.fake.requests[0]!.body as SentBody, error: null };
    } catch (error) {
      await handle.provider.close();
      return { body: null, error };
    }
  }

  it("rejects an unknown namespace or key", async () => {
    const handle = createTestProvider();
    await expect(
      handle.provider.start(
        testRequest("bad-ns", { extensions: [{ namespace: "anthropic", key: "think", value: true }] }),
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    const unknownKey = await startWithExtension("mystery-knob", true);
    expect(detailCode(unknownKey.error)).toBe("unknown-extension-key");
    await handle.provider.close();
  });

  it("selects a reasoning effort only from the permitted set", async () => {
    const allowed = await startWithExtension("reasoning-effort", "low");
    expect(allowed.body!.reasoning).toEqual({ effort: "low" });
    const denied = await startWithExtension("reasoning-effort", "max");
    expect(detailCode(denied.error)).toBe("reasoning-effort-not-permitted");
  });

  it("can turn reasoning disclosure off but never on", async () => {
    const widened = await startWithExtension("disclose-reasoning", true);
    expect(detailCode(widened.error)).toBe("cannot-widen-reasoning-disclosure");
    const tightened = await startWithExtension("disclose-reasoning", false, {
      configuration: { reasoning: { effort: "low", summary: "concise", discloseReasoning: true } },
    });
    expect(tightened.body!.reasoning).toEqual({ effort: "low" });
  });

  it("can never enable persistence", async () => {
    const widened = await startWithExtension("store", true, {
      configuration: { storage: { store: "when-authorized" } },
    });
    expect(detailCode(widened.error)).toBe("cannot-widen-storage");
    const tightened = await startWithExtension("store", false, {
      configuration: { storage: { store: "when-authorized" } },
    });
    expect(tightened.body!.store).toBe(false);
  });

  it("can never raise the output bound", async () => {
    const widened = await startWithExtension("max-output-tokens", 9_000);
    void widened;
    const handle = createTestProvider();
    handle.fake.script("create", { stream: textStreamScript(["ok"]) });
    await expect(
      handle.provider.start(
        testRequest("widen-tokens", {
          maxOutputTokens: 100,
          extensions: [{ namespace: "openai", key: "max-output-tokens", value: 9_000 }],
        }),
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    await handle.provider.close();

    const lowered = await startWithExtension("max-output-tokens", 50);
    expect(lowered.body!.max_output_tokens).toBe(50);
  });

  it("cannot enable background mode the policy forbids", async () => {
    const denied = await startWithExtension("background", true);
    expect(detailCode(denied.error)).toBe("background-not-permitted");
  });

  it("rejects malformed extension values", async () => {
    expect(detailCode((await startWithExtension("reasoning-effort", 5)).error)).toBe(
      "invalid-reasoning-effort",
    );
    expect(detailCode((await startWithExtension("store", "no")).error)).toBe("invalid-store");
    expect(detailCode((await startWithExtension("max-output-tokens", -1)).error)).toBe(
      "invalid-max-output-tokens",
    );
    expect(detailCode((await startWithExtension("background", "yes")).error)).toBe("invalid-background");
  });
});

describe("model identifiers stay in the catalog", () => {
  it("uses the catalog model id verbatim without inferring behavior from it", async () => {
    const body = await capture(testRequest("model-id"));
    expect(body.model).toBe(TEST_MODEL);
  });
});
