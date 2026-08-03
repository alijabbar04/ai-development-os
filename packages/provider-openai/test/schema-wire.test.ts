import { describe, expect, it } from "vitest";
import { isProviderError, type ProviderError } from "@ai-dev-os/providers";
import {
  classifyStreamEvent,
  parseOutputItem,
  parseResponseSnapshot,
  parseWireUsage,
  toTokenUsage,
  validateAgainstSchema,
  type WireLimits,
} from "../src/index.js";
import { usageObject } from "./helpers/fake-openai.js";

const LIMITS: WireLimits = Object.freeze({
  maxOutputItems: 32,
  maxToolCallArgumentsBytes: 4_096,
  maxTextBytes: 65_536,
});

function detailCode(error: unknown): unknown {
  return (error as ProviderError).details["detailCode"];
}

describe("structured-output schema validation", () => {
  it("accepts a conforming object", () => {
    const result = validateAgainstSchema(
      {
        type: "object",
        properties: { name: { type: "string" }, age: { type: "integer" } },
        required: ["name"],
        additionalProperties: false,
      },
      { name: "ada", age: 36 },
    );
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("reports a type mismatch with a path and no value echo", () => {
    const result = validateAgainstSchema(
      { type: "object", properties: { age: { type: "integer" } } },
      { age: "thirty-six" },
    );
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toEqual({ path: "$.age", code: "type_mismatch" });
    expect(JSON.stringify(result)).not.toContain("thirty-six");
  });

  it("enforces required properties and additionalProperties:false", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    };
    expect(validateAgainstSchema(schema, {}).violations[0]!.code).toBe("required_missing");
    expect(validateAgainstSchema(schema, { a: "x", b: 1 }).violations[0]!.code).toBe(
      "additional_property",
    );
  });

  it("treats integers as valid numbers but not the reverse", () => {
    expect(validateAgainstSchema({ type: "number" }, 1).valid).toBe(true);
    expect(validateAgainstSchema({ type: "number" }, 1.5).valid).toBe(true);
    expect(validateAgainstSchema({ type: "integer" }, 1.5).valid).toBe(false);
  });

  it("enforces enum, const, and string constraints", () => {
    expect(validateAgainstSchema({ enum: ["a", "b"] }, "c").violations[0]!.code).toBe("enum_mismatch");
    expect(validateAgainstSchema({ const: 5 }, 6).violations[0]!.code).toBe("const_mismatch");
    expect(validateAgainstSchema({ type: "string", minLength: 3 }, "ab").violations[0]!.code).toBe(
      "min_length",
    );
    expect(validateAgainstSchema({ type: "string", pattern: "^a+$" }, "b").violations[0]!.code).toBe(
      "pattern_mismatch",
    );
  });

  it("enforces numeric bounds", () => {
    expect(validateAgainstSchema({ minimum: 5 }, 4).violations[0]!.code).toBe("minimum");
    expect(validateAgainstSchema({ maximum: 5 }, 6).violations[0]!.code).toBe("maximum");
    expect(validateAgainstSchema({ exclusiveMinimum: 5 }, 5).violations[0]!.code).toBe(
      "exclusive_minimum",
    );
    expect(validateAgainstSchema({ multipleOf: 3 }, 7).violations[0]!.code).toBe("multiple_of");
  });

  it("validates arrays, prefixItems, and item bounds", () => {
    expect(validateAgainstSchema({ type: "array", items: { type: "integer" } }, [1, 2]).valid).toBe(true);
    expect(
      validateAgainstSchema({ type: "array", items: { type: "integer" } }, [1, "x"]).violations[0],
    ).toEqual({ path: "$[1]", code: "type_mismatch" });
    expect(validateAgainstSchema({ type: "array", minItems: 2 }, [1]).violations[0]!.code).toBe(
      "min_items",
    );
    expect(
      validateAgainstSchema(
        { type: "array", prefixItems: [{ type: "string" }], items: { type: "integer" } },
        ["a", 1, 2],
      ).valid,
    ).toBe(true);
  });

  it("handles anyOf, oneOf, allOf, and not", () => {
    const anyOf = { anyOf: [{ type: "string" }, { type: "integer" }] };
    expect(validateAgainstSchema(anyOf, 5).valid).toBe(true);
    expect(validateAgainstSchema(anyOf, true).violations[0]!.code).toBe("anyOf_unmatched");
    expect(
      validateAgainstSchema({ oneOf: [{ type: "integer" }, { type: "number" }] }, 5).violations[0]!.code,
    ).toBe("oneOf_ambiguous");
    expect(validateAgainstSchema({ allOf: [{ type: "integer" }, { minimum: 10 }] }, 5).valid).toBe(false);
    expect(validateAgainstSchema({ not: { type: "string" } }, "x").violations[0]!.code).toBe(
      "not_satisfied",
    );
  });

  it("resolves $ref into $defs and rejects unresolvable references", () => {
    const schema = {
      type: "object",
      properties: { child: { $ref: "#/$defs/node" } },
      $defs: { node: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    };
    expect(validateAgainstSchema(schema, { child: { id: "x" } }).valid).toBe(true);
    expect(validateAgainstSchema(schema, { child: {} }).violations[0]!.code).toBe("required_missing");
    expect(
      validateAgainstSchema({ $ref: "https://evil.test/schema" }, {}).violations[0]!.code,
    ).toBe("unresolvable_ref");
  });

  it("reports keywords it did not enforce instead of silently ignoring them", () => {
    const result = validateAgainstSchema(
      { type: "object", propertyNames: { pattern: "^x" }, dependentRequired: { a: ["b"] } },
      {},
    );
    expect(result.valid).toBe(true);
    expect(result.unenforcedKeywords).toEqual(["dependentRequired", "propertyNames"]);
  });

  it("fails closed on a hostile or unusable schema rather than throwing", () => {
    expect(validateAgainstSchema("not-a-schema" as never, {}).valid).toBe(false);
    expect(validateAgainstSchema(false as never, {}).valid).toBe(false);
    expect(validateAgainstSchema({ type: "string", pattern: "([" }, "x").violations[0]!.code).toBe(
      "invalid_pattern",
    );
  });

  it("bounds recursion depth", () => {
    let deep: Record<string, unknown> = { type: "object" };
    let value: Record<string, unknown> = {};
    for (let index = 0; index < 60; index += 1) {
      deep = { type: "object", properties: { next: deep } };
      value = { next: value };
    }
    const result = validateAgainstSchema(deep, value);
    expect(result.violations.some((violation) => violation.code === "schema_too_deep")).toBe(true);
  });
});

describe("wire usage validation", () => {
  it("accepts a well-formed usage object", () => {
    const usage = parseWireUsage(
      usageObject({ inputTokens: 100, cachedTokens: 20, cacheWriteTokens: 5, outputTokens: 40, reasoningTokens: 10 }),
    );
    expect(usage.inputTokens).toBe(100);
    expect(usage.cachedTokens).toBe(20);
    expect(usage.cacheWriteTokens).toBe(5);
    expect(toTokenUsage(usage)).toEqual({
      inputTokens: 80,
      cachedInputTokens: 20,
      outputTokens: 30,
      reasoningTokens: 10,
    });
  });

  it("tolerates a missing cache_write_tokens as zero", () => {
    const usage = parseWireUsage({
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 15,
    });
    expect(usage.cacheWriteTokens).toBe(0);
  });

  it.each([
    [{ cachedTokens: 500 }, "contradictory-usage-cached-exceeds-input"],
    [{ cacheWriteTokens: 500 }, "contradictory-usage-cache-write-exceeds-input"],
    [{ reasoningTokens: 500 }, "contradictory-usage-reasoning-exceeds-output"],
    [{ totalTokens: 999 }, "contradictory-usage-total-mismatch"],
  ])("rejects contradictory usage %#", (overrides, expected) => {
    try {
      parseWireUsage(usageObject({ inputTokens: 100, outputTokens: 50, ...overrides }));
      expect.unreachable(`expected ${expected}`);
    } catch (error) {
      expect(detailCode(error)).toBe(expected);
    }
  });

  it("rejects negative and non-integer counts", () => {
    for (const bad of [-1, 1.5, Number.NaN, "10", null]) {
      expect(() =>
        parseWireUsage({
          input_tokens: bad,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens: 0,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 0,
        }),
      ).toThrow();
    }
  });
});

describe("output item validation", () => {
  it("parses messages, function calls, and reasoning items", () => {
    expect(
      parseOutputItem(
        { id: "m", type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
        LIMITS,
      ),
    ).toMatchObject({ type: "message", role: "assistant" });
    expect(
      parseOutputItem(
        { type: "function_call", call_id: "call_1", name: "f", arguments: "{}" },
        LIMITS,
      ),
    ).toMatchObject({ type: "function_call", callId: "call_1" });
    expect(
      parseOutputItem({ id: "r", type: "reasoning", summary: [{ text: "because" }] }, LIMITS),
    ).toMatchObject({ type: "reasoning", summaryText: "because" });
  });

  it("fails closed on hosted-tool item types", () => {
    for (const type of [
      "web_search_call",
      "file_search_call",
      "code_interpreter_call",
      "mcp_call",
      "image_generation_call",
      "custom_tool_call",
      "local_shell_call",
    ]) {
      try {
        parseOutputItem({ id: "x", type }, LIMITS);
        expect.unreachable(`expected ${type} to be refused`);
      } catch (error) {
        expect(isProviderError(error, "PROTOCOL_VIOLATION")).toBe(true);
        expect(detailCode(error)).toBe("unsupported-output-item");
      }
    }
  });

  it("fails closed on unsupported content-part types", () => {
    try {
      parseOutputItem(
        { id: "m", type: "message", role: "assistant", content: [{ type: "output_audio", data: "x" }] },
        LIMITS,
      );
      expect.unreachable("expected refusal");
    } catch (error) {
      expect(detailCode(error)).toBe("unsupported-content-part");
    }
  });

  it("bounds oversized tool arguments", () => {
    expect(() =>
      parseOutputItem(
        {
          type: "function_call",
          call_id: "call_1",
          name: "f",
          arguments: "x".repeat(LIMITS.maxToolCallArgumentsBytes + 1),
        },
        LIMITS,
      ),
    ).toThrow();
  });
});

describe("response snapshot validation", () => {
  it("parses a completed response", () => {
    const snapshot = parseResponseSnapshot(
      {
        id: "resp_1",
        object: "response",
        status: "completed",
        model: "m",
        output: [],
        usage: usageObject(),
      },
      LIMITS,
    );
    expect(snapshot.status).toBe("completed");
    expect(snapshot.usage!.inputTokens).toBe(100);
  });

  it("fails closed on an unknown lifecycle status", () => {
    try {
      parseResponseSnapshot({ id: "resp_1", status: "quantum_superposition", output: [] }, LIMITS);
      expect.unreachable("expected refusal");
    } catch (error) {
      expect(isProviderError(error, "PROTOCOL_VIOLATION")).toBe(true);
      expect(detailCode(error)).toBe("unknown-response-status");
    }
  });

  it("bounds the output-item count", () => {
    const many = Array.from({ length: LIMITS.maxOutputItems + 1 }, () => ({
      id: "m",
      type: "message",
      role: "assistant",
      content: [],
    }));
    try {
      parseResponseSnapshot({ id: "resp_1", status: "completed", output: many }, LIMITS);
      expect.unreachable("expected refusal");
    } catch (error) {
      expect(detailCode(error)).toBe("too-many-output-items");
    }
  });

  it("reduces an error envelope to safe machine fields only", () => {
    const snapshot = parseResponseSnapshot(
      {
        id: "resp_1",
        status: "failed",
        output: [],
        error: { code: "server_error", message: "raw text with SECRET-CANARY inside" },
      },
      LIMITS,
    );
    expect(snapshot.error).toEqual({ type: null, code: "server_error", param: null });
    expect(JSON.stringify(snapshot)).not.toContain("SECRET-CANARY");
  });

  it("rejects an object that is not a response", () => {
    expect(() => parseResponseSnapshot({ id: "x", object: "chat.completion", status: "completed" }, LIMITS)).toThrow();
  });
});

describe("stream event classification", () => {
  function event(type: string, extra: Record<string, unknown> = {}): unknown {
    return { type, sequence_number: 1, ...extra };
  }

  it("classifies the documented semantic events", () => {
    expect(
      classifyStreamEvent(
        event("response.created", { response: { id: "resp_1", status: "in_progress", output: [] } }) as never,
        LIMITS,
      ).kind,
    ).toBe("lifecycle");
    expect(
      classifyStreamEvent(
        event("response.completed", { response: { id: "resp_1", status: "completed", output: [] } }) as never,
        LIMITS,
      ).kind,
    ).toBe("terminal");
    expect(
      classifyStreamEvent(
        event("response.output_text.delta", {
          item_id: "m",
          output_index: 0,
          content_index: 0,
          delta: "x",
          logprobs: [],
        }) as never,
        LIMITS,
      ).kind,
    ).toBe("text-delta");
    expect(classifyStreamEvent(event("error", { code: "server_error", message: "x", param: null }) as never, LIMITS).kind).toBe(
      "error",
    );
    expect(
      classifyStreamEvent(
        event("response.content_part.added", {
          item_id: "m",
          output_index: 0,
          content_index: 0,
          part: {},
        }) as never,
        LIMITS,
      ).kind,
    ).toBe("informational");
  });

  it("requires a sequence number on every event", () => {
    expect(() => classifyStreamEvent({ type: "response.created" } as never, LIMITS)).toThrow();
    expect(() =>
      classifyStreamEvent({ type: "response.created", sequence_number: -1 } as never, LIMITS),
    ).toThrow();
  });

  it.each([
    "response.web_search_call.in_progress",
    "response.file_search_call.completed",
    "response.code_interpreter_call.interpreting",
    "response.mcp_call.completed",
    "response.mcp_list_tools.completed",
    "response.image_generation_call.completed",
    "response.custom_tool_call_input.done",
    "response.audio.delta",
    "response.output_audio.delta",
    "response.something.brand.new",
  ])("fails closed on out-of-scope or unknown event %s", (type) => {
    try {
      classifyStreamEvent(event(type) as never, LIMITS);
      expect.unreachable(`expected ${type} to fail closed`);
    } catch (error) {
      expect(isProviderError(error, "PROTOCOL_VIOLATION")).toBe(true);
      expect(detailCode(error)).toBe("unsupported-stream-event");
    }
  });
});
