import { describe, expect, it } from "vitest";
import {
  InvariantViolationError,
  UnsupportedCapabilityError,
  ValidationError,
  assertModelSupports,
  createModelCapabilities,
  createModelRequirements,
  createTokenUsage,
  estimateModelCost,
  findUnmetRequirements,
  parseModelCapabilities,
  parseModelRequirements,
  type ModelCapabilities,
} from "../src/index.js";

const MODEL: ModelCapabilities = createModelCapabilities({
  providerId: "provider-a" as ModelCapabilities["providerId"],
  modelId: "model-x" as ModelCapabilities["modelId"],
  contextWindowTokens: 200_000,
  maxOutputTokens: 32_000,
  supportsToolUse: true,
  supportsStructuredOutput: true,
  supportsVision: false,
  locality: "cloud",
  latencyClass: "standard",
  codingCapability: 4,
  reasoningCapability: 5,
  cost: {
    currency: "USD",
    inputMicrosPerMillionTokens: 3_000_000,
    outputMicrosPerMillionTokens: 15_000_000,
    cachedInputMicrosPerMillionTokens: 300_000,
  },
});

describe("ModelCapabilities", () => {
  it("creates a frozen provider-neutral capability record", () => {
    expect(MODEL.schemaVersion).toBe(1);
    expect(Object.isFrozen(MODEL)).toBe(true);
    expect(Object.isFrozen(MODEL.cost)).toBe(true);
  });

  it("round-trips through JSON", () => {
    expect(parseModelCapabilities(JSON.parse(JSON.stringify(MODEL)))).toEqual(MODEL);
  });

  it("rejects hostile capability records", () => {
    expect(() => parseModelCapabilities({ ...MODEL, schemaVersion: 3 })).toThrow(ValidationError);
    expect(() => parseModelCapabilities({ ...MODEL, maxOutputTokens: 300_000 })).toThrow(
      ValidationError,
    );
    expect(() => parseModelCapabilities({ ...MODEL, codingCapability: 6 })).toThrow(
      ValidationError,
    );
    expect(() => parseModelCapabilities({ ...MODEL, locality: "edge" })).toThrow(ValidationError);
    expect(() =>
      parseModelCapabilities({
        ...MODEL,
        cost: { ...MODEL.cost, inputMicrosPerMillionTokens: -1 },
      }),
    ).toThrow(ValidationError);
    expect(() => parseModelCapabilities({ ...MODEL, extra: true })).toThrow(ValidationError);
  });

  it("accepts a model without cost metadata", () => {
    const free = parseModelCapabilities({ ...MODEL, cost: null });
    expect(free.cost).toBeNull();
  });
});

describe("requirements matching", () => {
  it("defaults to unconstrained requirements", () => {
    const requirements = createModelRequirements();
    expect(requirements.requireToolUse).toBe(false);
    expect(findUnmetRequirements(MODEL, requirements)).toEqual([]);
    expect(() => assertModelSupports(MODEL, requirements)).not.toThrow();
  });

  it("lists every unmet requirement deterministically", () => {
    const requirements = createModelRequirements({
      minContextWindowTokens: 1_000_000,
      minOutputTokens: 64_000,
      requireVision: true,
      requireLocalExecution: true,
      minCodingCapability: 5,
    });
    const unmet = findUnmetRequirements(MODEL, requirements);
    expect(unmet.map((entry) => entry.requirement)).toEqual([
      "context-window",
      "max-output",
      "vision",
      "local-execution",
      "coding-capability",
    ]);
  });

  it("checks tool use, structured output, and reasoning floors", () => {
    const noTools = parseModelCapabilities({
      ...MODEL,
      supportsToolUse: false,
      supportsStructuredOutput: false,
      reasoningCapability: 2,
    });
    const unmet = findUnmetRequirements(
      noTools,
      createModelRequirements({
        requireToolUse: true,
        requireStructuredOutput: true,
        minReasoningCapability: 4,
      }),
    );
    expect(unmet.map((entry) => entry.requirement)).toEqual([
      "tool-use",
      "structured-output",
      "reasoning-capability",
    ]);
  });

  it("throws UnsupportedCapabilityError carrying requirement codes only", () => {
    try {
      assertModelSupports(MODEL, createModelRequirements({ requireVision: true }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedCapabilityError);
      const typed = error as UnsupportedCapabilityError;
      expect(typed.code).toBe("UNSUPPORTED_CAPABILITY");
      expect(typed.unmetRequirements.map((entry) => entry.requirement)).toEqual(["vision"]);
      expect(typed.details["requirements"]).toEqual(["vision"]);
    }
  });

  it("rejects malformed requirements", () => {
    expect(() => parseModelRequirements({ requireToolUse: true })).toThrow(ValidationError);
    expect(() =>
      parseModelRequirements({ ...createModelRequirements(), minCodingCapability: 0 }),
    ).toThrow(ValidationError);
  });
});

describe("cost estimation", () => {
  it("computes exact integer-micro costs with per-category ceiling rounding", () => {
    const cost = estimateModelCost(
      MODEL,
      createTokenUsage({
        inputTokens: 1_000_000,
        cachedInputTokens: 2_000_000,
        outputTokens: 100_000,
        reasoningTokens: 50_000,
      }),
    );
    // input: 1M * 3.0 USD/M = 3_000_000 micros
    // cached: 2M * 0.3 USD/M = 600_000 micros
    // output: 150k * 15 USD/M = 2_250_000 micros
    expect(cost).toEqual({ currency: "USD", amountMicros: 5_850_000 });
  });

  it("rounds fractional micro amounts up, never silently down", () => {
    const cost = estimateModelCost(MODEL, createTokenUsage({ inputTokens: 1 }));
    expect(cost.amountMicros).toBe(3);
    const tiny = estimateModelCost(MODEL, createTokenUsage({ outputTokens: 1 }));
    expect(tiny.amountMicros).toBe(15);
  });

  it("bills cached tokens at the input rate when no cached rate exists", () => {
    const model = parseModelCapabilities({
      ...MODEL,
      cost: { ...MODEL.cost, cachedInputMicrosPerMillionTokens: null },
    });
    const cost = estimateModelCost(model, createTokenUsage({ cachedInputTokens: 1_000_000 }));
    expect(cost.amountMicros).toBe(3_000_000);
  });

  it("returns zero cost for zero usage", () => {
    expect(estimateModelCost(MODEL, createTokenUsage()).amountMicros).toBe(0);
  });

  it("refuses estimation without cost metadata and on overflow", () => {
    const free = parseModelCapabilities({ ...MODEL, cost: null });
    expect(() => estimateModelCost(free, createTokenUsage())).toThrow(InvariantViolationError);

    const expensive = parseModelCapabilities({
      ...MODEL,
      cost: {
        currency: "USD",
        inputMicrosPerMillionTokens: Number.MAX_SAFE_INTEGER,
        outputMicrosPerMillionTokens: 0,
        cachedInputMicrosPerMillionTokens: null,
      },
    });
    expect(() =>
      estimateModelCost(expensive, createTokenUsage({ inputTokens: 1_000_000_000_000 })),
    ).toThrow(InvariantViolationError);
  });
});
