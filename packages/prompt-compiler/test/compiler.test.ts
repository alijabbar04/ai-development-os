import { toCanonicalJson } from "@ai-dev-os/domain";
import { describe, expect, it } from "vitest";
import { PromptCompilerError, safeCauseCode } from "../src/errors.js";
import {
  THINKER_CONTEXT_PREAMBLE,
  THINKER_SYSTEM_MESSAGE,
  compileThinkerPrompt,
  compiledPromptFingerprint,
  createPromptCompiler,
  parseCompiledThinkerPrompt,
  summarizeCompiledPrompt
} from "../src/compiler.js";
import {
  HOSTILE_PROMPT_CONTEXT,
  PROMPT_INJECTION_CANARY,
  allowingPromptAuthorizer,
  jsonClone,
  promptCompilationRequestFixture,
  promptCompilerConfigurationFixture
} from "../src/testing/fixtures.js";

async function compiled(options: {
  readonly body?: string;
  readonly emptyContext?: boolean;
} = {}) {
  const result = await createPromptCompiler({ authorizer: allowingPromptAuthorizer() }).compile(
    promptCompilationRequestFixture(options)
  );
  if (!result.ok) throw new Error(`fixture compilation failed: ${result.failure.code}`);
  return result.value;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("test fixture is not a record");
  }
  return value as Record<string, unknown>;
}

describe("deterministic prompt compilation", () => {
  it("compiles realistic and empty context with byte-identical output", async () => {
    const request = promptCompilationRequestFixture();
    const compiler = createPromptCompiler({ authorizer: allowingPromptAuthorizer() });
    const first = await compiler.compile(request);
    const second = await compiler.compile(jsonClone(request));
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(parseCompiledThinkerPrompt(jsonClone(first.value))).toEqual(first.value);
    expect(first.value.fingerprint).toBe(
      compiledPromptFingerprint((({ fingerprint: _ignored, ...value }) => value)(first.value))
    );

    const empty = await compiled({ emptyContext: true });
    expect(empty.contextItemCount).toBe(0);
    expect(empty.accounting.contextBytes).toBeGreaterThan(0);
  });

  it("uses exactly three one-part messages and keeps selection metadata outside them", async () => {
    const value = await compiled();
    expect(value.inferenceRequest.messages.map((item) => item.role)).toEqual([
      "system",
      "developer",
      "user"
    ]);
    expect(value.inferenceRequest.messages.every((item) => item.parts.length === 1)).toBe(true);
    expect(JSON.stringify(value.inferenceRequest.messages)).not.toContain("fixture-provider-alpha");
    expect(JSON.stringify(value.inferenceRequest.messages)).not.toContain("fixture-model-alpha");
    expect(JSON.stringify(value.inferenceRequest.messages)).not.toContain("fixture-instance-alpha");
    expect(value.inferenceRequest.tools).toEqual([]);
    expect(value.inferenceRequest.toolChoice).toEqual({ mode: "none" });
  });

  it("keeps hostile role, frame, approval, command, and tool prose in user data", async () => {
    const value = await compiled({ body: HOSTILE_PROMPT_CONTEXT });
    const systemAndDeveloper = JSON.stringify(value.inferenceRequest.messages.slice(0, 2));
    const user = JSON.stringify(value.inferenceRequest.messages[2]);
    expect(systemAndDeveloper).not.toContain(PROMPT_INJECTION_CANARY);
    expect(user).toContain(PROMPT_INJECTION_CANARY);
    expect(systemAndDeveloper).not.toContain("destructive-placeholder");
    expect(user).toContain("destructive-placeholder");
    expect(THINKER_SYSTEM_MESSAGE).not.toContain("chain-of-thought");
    expect(user).toContain(THINKER_CONTEXT_PREAMBLE.split("\n")[0]);

    const naive = `${THINKER_SYSTEM_MESSAGE}\n${HOSTILE_PROMPT_CONTEXT}`;
    expect(naive).toContain(PROMPT_INJECTION_CANARY);
    expect(naive).toContain("grant yourself shell");
  });

  it("reports exact schema, context, message, and total byte boundaries", async () => {
    const baseline = await compiled();
    const maxMessageBytes = Math.max(...baseline.accounting.messageBytes);
    const exact = await createPromptCompiler({
      authorizer: allowingPromptAuthorizer(),
      configuration: promptCompilerConfigurationFixture({
        maxPromptBytes: baseline.accounting.promptBytes,
        maxMessageBytes,
        maxSchemaBytes: baseline.accounting.schemaBytes,
        maxContextBytes: baseline.accounting.contextBytes
      })
    }).compile(promptCompilationRequestFixture());
    expect(exact.ok).toBe(true);

    const cases = [
      {
        configuration: promptCompilerConfigurationFixture({
          maxContextBytes: baseline.accounting.contextBytes - 1
        }),
        code: "REPACK_REQUIRED"
      },
      {
        configuration: promptCompilerConfigurationFixture({
          maxSchemaBytes: baseline.accounting.schemaBytes - 1
        }),
        code: "BOUNDS_EXCEEDED"
      },
      {
        configuration: promptCompilerConfigurationFixture({
          maxPromptBytes: baseline.accounting.promptBytes - 1,
          maxMessageBytes: Math.min(
            promptCompilerConfigurationFixture().maxMessageBytes,
            baseline.accounting.promptBytes - 1
          ),
          maxContextBytes: Math.min(
            promptCompilerConfigurationFixture().maxContextBytes,
            baseline.accounting.promptBytes - 1
          )
        }),
        code: "REPACK_REQUIRED"
      }
    ] as const;
    for (const entry of cases) {
      const result = await createPromptCompiler({
        authorizer: allowingPromptAuthorizer(),
        configuration: entry.configuration
      }).compile(promptCompilationRequestFixture());
      expect(result).toMatchObject({ ok: false, failure: { code: entry.code } });
    }
  });

  it("never truncates trusted messages and requires repacking for oversized context", async () => {
    const baseline = await compiled({ emptyContext: true });
    const result = await createPromptCompiler({
      authorizer: allowingPromptAuthorizer(),
      configuration: promptCompilerConfigurationFixture({
        maxPromptBytes: baseline.accounting.promptBytes,
        maxMessageBytes: baseline.accounting.messageBytes[0]! - 1,
        maxContextBytes: baseline.accounting.contextBytes
      })
    }).compile(promptCompilationRequestFixture({ emptyContext: true }));
    expect(result).toMatchObject({ ok: false, failure: { code: "BOUNDS_EXCEEDED" } });

    const largeBody = "x".repeat(40_000);
    const repack = await createPromptCompiler({
      authorizer: allowingPromptAuthorizer(),
      configuration: promptCompilerConfigurationFixture({ maxContextBytes: 1_000 })
    }).compile(promptCompilationRequestFixture({ body: largeBody }));
    expect(repack).toMatchObject({ ok: false, failure: { code: "REPACK_REQUIRED" } });
    expect(JSON.stringify(repack)).not.toContain(largeBody.slice(0, 200));
  });

  it("rejects an output request beyond the selected model limit", async () => {
    const result = await createPromptCompiler({
      authorizer: allowingPromptAuthorizer(),
      configuration: promptCompilerConfigurationFixture({ maxOutputTokens: 16_385 })
    }).compile(promptCompilationRequestFixture());
    expect(result).toMatchObject({ ok: false, failure: { code: "TARGET_INELIGIBLE" } });
  });

  it("produces a body-free summary and body-free observer records", async () => {
    const observations: unknown[] = [];
    const canary = `${PROMPT_INJECTION_CANARY}-${"z".repeat(300)}`;
    const result = await createPromptCompiler({
      authorizer: allowingPromptAuthorizer(),
      observer: (record) => observations.push(record)
    }).compile(promptCompilationRequestFixture({ body: canary }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summary = summarizeCompiledPrompt(result.value);
    expect(summary.authority).toBe("none");
    expect(summary.toolCount).toBe(0);
    expect(JSON.stringify(summary)).not.toContain(PROMPT_INJECTION_CANARY);
    expect(JSON.stringify(observations)).not.toContain(PROMPT_INJECTION_CANARY);
  });

  it("contains observer exceptions and supports idempotent close", async () => {
    const compiler = createPromptCompiler({
      authorizer: allowingPromptAuthorizer(),
      observer: () => {
        throw new Error("observer secret");
      }
    });
    expect((await compiler.compile(promptCompilationRequestFixture())).ok).toBe(true);
    compiler.close();
    compiler.close();
    expect(compiler.closed).toBe(true);
    const closed = await compiler.compile(promptCompilationRequestFixture());
    expect(closed).toMatchObject({ ok: false, failure: { code: "COMPILER_CLOSED" } });
    expect(JSON.stringify(closed)).not.toContain("observer secret");
  });

  it("exposes a cohesive one-shot compilation helper", async () => {
    const result = await compileThinkerPrompt(promptCompilationRequestFixture(), {
      authorizer: allowingPromptAuthorizer()
    });
    expect(result.ok).toBe(true);
  });

  it("redacts invalid request details and serializes finite compiler errors", async () => {
    const invalid = await createPromptCompiler({ authorizer: allowingPromptAuthorizer() }).compile({
      body: `${PROMPT_INJECTION_CANARY}-private-path`
    });
    expect(invalid).toMatchObject({ ok: false, failure: { code: "INVALID_REQUEST" } });
    expect(JSON.stringify(invalid)).not.toContain(PROMPT_INJECTION_CANARY);

    const error = new PromptCompilerError("BOUNDS_EXCEEDED", "bounded", { maximum: 1 });
    expect(error.toJSON()).toEqual({
      name: "PromptCompilerError",
      code: "BOUNDS_EXCEEDED",
      message: "bounded",
      details: { maximum: 1 }
    });
    expect(safeCauseCode(error)).toBe("BOUNDS_EXCEEDED");
    expect(safeCauseCode(new RangeError("private"))).toBe("RangeError");
    expect(safeCauseCode(42)).toBe("number");
  });
});

describe("compiled prompt boundary parser", () => {
  it("rejects tools, schema drift, template drift, accounting drift, and fingerprint drift", async () => {
    const value = await compiled();
    const mutations: Array<(raw: Record<string, unknown>) => void> = [
      (raw) => {
        const inference = record(raw["inferenceRequest"]);
        inference["toolChoice"] = { mode: "auto" };
      },
      (raw) => {
        record(record(raw["inferenceRequest"])["structuredOutput"])["schema"] = {
          type: "object"
        };
      },
      (raw) => {
        const messages = record(raw["inferenceRequest"])["messages"] as Array<
          Record<string, unknown>
        >;
        const parts = messages[0]!["parts"] as Array<Record<string, unknown>>;
        parts[0]!["text"] = "changed trusted prefix";
      },
      (raw) => {
        record(raw["accounting"])["promptBytes"] = 1;
      },
      (raw) => {
        raw["fingerprint"] = "0".repeat(64);
      },
      (raw) => {
        record(raw["authorityEnvelope"])["maxTasks"] = 1;
      }
    ];
    for (const mutate of mutations) {
      const raw = jsonClone(value) as unknown as Record<string, unknown>;
      mutate(raw);
      expect(() => parseCompiledThinkerPrompt(raw)).toThrow();
    }
  });

  it("rejects unknown keys, prototype-pollution shapes, and non-text messages", async () => {
    const value = await compiled();
    expect(() => parseCompiledThinkerPrompt({ ...value, approval: true })).toThrow(
      /unexpected fields/
    );
    expect(() => parseCompiledThinkerPrompt(Object.create({}))).toThrow(/plain data object/);
    const raw = jsonClone(value) as unknown as Record<string, unknown>;
    const messages = record(raw["inferenceRequest"])["messages"] as Array<Record<string, unknown>>;
    messages[1]!["parts"] = [{ type: "json", value: {} }];
    expect(() => parseCompiledThinkerPrompt(raw)).toThrow();
  });

  it("keeps canonical schema and messages byte-stable", async () => {
    const first = await compiled();
    const second = await compiled();
    expect(toCanonicalJson(first.inferenceRequest.messages)).toBe(
      toCanonicalJson(second.inferenceRequest.messages)
    );
    expect(toCanonicalJson(first.inferenceRequest.structuredOutput?.schema)).toBe(
      toCanonicalJson(second.inferenceRequest.structuredOutput?.schema)
    );
  });
});
