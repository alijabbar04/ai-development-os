import { describe, expect, it } from "vitest";
import { createTokenUsage } from "@ai-dev-os/domain";
import { isProviderError, type ProviderError } from "@ai-dev-os/providers";
import {
  applyCapabilityOverride,
  computeCost,
  emptyOpenAiModelCatalog,
  listCatalogModelIds,
  parseOpenAiCapabilityOverride,
  parseOpenAiModelCatalog,
  selectCatalogEntry,
  selectPricingSlice,
  toModelCapabilities,
  type OpenAiModelCatalog,
} from "../src/index.js";

function detailCode(error: unknown): unknown {
  return (error as ProviderError).details["detailCode"];
}

const EVIDENCE = {
  source: "openai-model-guidance",
  observedAt: "2026-01-01T00:00:00.000Z",
  documentRevision: "rev-1",
};

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    modelId: "model-a",
    contextWindowTokens: 200_000,
    maxOutputTokens: 64_000,
    supportsStructuredOutput: true,
    supportsToolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
    supportedReasoningEfforts: ["low", "medium", "high"],
    supportsSampling: false,
    latencyClass: "standard",
    codingCapability: 5,
    reasoningCapability: 5,
    evidence: EVIDENCE,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveTo: null,
    pricing: [],
    ...overrides,
  };
}

function catalog(entries: readonly Record<string, unknown>[]): OpenAiModelCatalog {
  return parseOpenAiModelCatalog({
    schemaVersion: 1,
    catalogVersion: "v1",
    source: "operator",
    entries,
  });
}

const PRICE_A = {
  currency: "USD",
  inputMicrosPerMillionTokens: 1_000_000,
  cachedInputMicrosPerMillionTokens: 100_000,
  cacheWriteMicrosPerMillionTokens: null,
  outputMicrosPerMillionTokens: 8_000_000,
  source: "openai-pricing",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: "2026-06-01T00:00:00.000Z",
};

const PRICE_B = {
  ...PRICE_A,
  inputMicrosPerMillionTokens: 2_000_000,
  outputMicrosPerMillionTokens: 16_000_000,
  effectiveFrom: "2026-06-01T00:00:00.000Z",
  effectiveTo: null,
};

describe("catalog structure", () => {
  it("requires provenance for capability and limit facts", () => {
    expect(() => catalog([entry({ evidence: undefined })])).toThrow();
    const parsed = catalog([entry()]);
    expect(parsed.entries[0]!.evidence.source).toBe("openai-model-guidance");
  });

  it("ships no built-in models: an empty catalog offers nothing", () => {
    const empty = emptyOpenAiModelCatalog();
    expect(empty.entries).toHaveLength(0);
    expect(listCatalogModelIds(empty, "2026-08-01T00:00:00.000Z")).toHaveLength(0);
  });

  it("produces a deterministic fingerprint independent of key or entry order", () => {
    const a = catalog([entry({ modelId: "model-b" }), entry({ modelId: "model-a" })]);
    const b = catalog([entry({ modelId: "model-a" }), entry({ modelId: "model-b" })]);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toMatch(/^[a-f0-9]{64}$/);

    const different = catalog([entry({ modelId: "model-a", maxOutputTokens: 32_000 })]);
    expect(different.fingerprint).not.toBe(catalog([entry({ modelId: "model-a" })]).fingerprint);
  });

  it("accepts a matching supplied fingerprint and rejects a forged one", () => {
    const parsed = catalog([entry()]);
    expect(parseOpenAiModelCatalog(parsed).fingerprint).toBe(parsed.fingerprint);
    try {
      parseOpenAiModelCatalog({ ...parsed, fingerprint: "0".repeat(64) });
      expect.unreachable("expected a fingerprint mismatch");
    } catch (error) {
      expect(detailCode(error)).toBe("catalog-fingerprint-mismatch");
    }
  });

  it("rejects overlapping entry intervals for one model", () => {
    try {
      catalog([
        entry({ effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2026-07-01T00:00:00.000Z" }),
        entry({ effectiveFrom: "2026-06-01T00:00:00.000Z", effectiveTo: null }),
      ]);
      expect.unreachable("expected overlap rejection");
    } catch (error) {
      expect(detailCode(error)).toBe("catalog-intervals-overlap");
    }
  });

  it("rejects inverted and overlapping pricing intervals", () => {
    try {
      catalog([entry({ pricing: [{ ...PRICE_A, effectiveTo: "2025-01-01T00:00:00.000Z" }] })]);
      expect.unreachable("expected inverted interval rejection");
    } catch (error) {
      expect(detailCode(error)).toBe("pricing-interval-inverted");
    }
    try {
      catalog([
        entry({
          pricing: [PRICE_A, { ...PRICE_B, effectiveFrom: "2026-03-01T00:00:00.000Z" }],
        }),
      ]);
      expect.unreachable("expected pricing overlap rejection");
    } catch (error) {
      expect(detailCode(error)).toBe("pricing-intervals-overlap");
    }
  });

  it("keeps reasoning support and effort lists consistent", () => {
    expect(() => catalog([entry({ supportsReasoning: false })])).toThrow();
    expect(() =>
      catalog([entry({ supportsReasoning: true, supportedReasoningEfforts: [] })]),
    ).toThrow();
    expect(() =>
      catalog([entry({ supportsReasoning: false, supportedReasoningEfforts: [] })]),
    ).not.toThrow();
  });

  it("requires max output to fit inside the context window", () => {
    expect(() => catalog([entry({ contextWindowTokens: 1_000, maxOutputTokens: 2_000 })])).toThrow();
  });
});

describe("effective-time selection", () => {
  const timed = catalog([
    entry({
      modelId: "model-a",
      maxOutputTokens: 16_000,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveTo: "2026-06-01T00:00:00.000Z",
    }),
    entry({
      modelId: "model-a",
      maxOutputTokens: 64_000,
      effectiveFrom: "2026-06-01T00:00:00.000Z",
      effectiveTo: null,
      pricing: [PRICE_A, PRICE_B],
    }),
  ]);

  it("selects the entry whose interval contains the instant", () => {
    expect(selectCatalogEntry(timed, "model-a", "2026-03-01T00:00:00.000Z")!.maxOutputTokens).toBe(16_000);
    expect(selectCatalogEntry(timed, "model-a", "2026-08-01T00:00:00.000Z")!.maxOutputTokens).toBe(64_000);
    expect(selectCatalogEntry(timed, "model-a", "2025-01-01T00:00:00.000Z")).toBeNull();
    expect(selectCatalogEntry(timed, "missing", "2026-08-01T00:00:00.000Z")).toBeNull();
  });

  it("treats the upper bound as exclusive", () => {
    expect(selectCatalogEntry(timed, "model-a", "2026-06-01T00:00:00.000Z")!.maxOutputTokens).toBe(64_000);
  });

  it("selects the price slice effective at the instant", () => {
    const current = selectCatalogEntry(timed, "model-a", "2026-08-01T00:00:00.000Z")!;
    expect(selectPricingSlice(current, "2026-03-01T00:00:00.000Z")!.inputMicrosPerMillionTokens).toBe(
      1_000_000,
    );
    expect(selectPricingSlice(current, "2026-08-01T00:00:00.000Z")!.inputMicrosPerMillionTokens).toBe(
      2_000_000,
    );
    expect(selectPricingSlice(current, "2020-01-01T00:00:00.000Z")).toBeNull();
  });
});

describe("cost arithmetic", () => {
  const priced = catalog([entry({ pricing: [PRICE_A, PRICE_B] })]);
  const current = selectCatalogEntry(priced, "model-a", "2026-03-01T00:00:00.000Z")!;

  it("bills each disjoint category at its own rate", () => {
    const cost = computeCost(
      current,
      createTokenUsage({
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 500_000,
        reasoningTokens: 500_000,
      }),
      0,
      "2026-03-01T00:00:00.000Z",
    );
    // 1e6 input @1_000_000 + 1e6 cached @100_000 + 1e6 (output+reasoning) @8_000_000
    expect(cost.money).toEqual({ currency: "USD", amountMicros: 9_100_000 });
    expect(cost.pricingSource).toBe("openai-pricing");
    expect(cost.pricingEffectiveFrom).toBe("2026-01-01T00:00:00.000Z");
  });

  it("rounds each category up rather than losing sub-micro amounts", () => {
    const cost = computeCost(current, createTokenUsage({ inputTokens: 1 }), 0, "2026-03-01T00:00:00.000Z");
    // 1 token at 1_000_000 micros per million tokens is exactly 1 micro.
    expect(cost.money!.amountMicros).toBe(1);
    const tiny = computeCost(
      current,
      createTokenUsage({ cachedInputTokens: 1 }),
      0,
      "2026-03-01T00:00:00.000Z",
    );
    // 1 * 100_000 / 1_000_000 = 0.1, rounded up to 1 micro.
    expect(tiny.money!.amountMicros).toBe(1);
  });

  it("falls back to the input rate for cached tokens when no cached rate exists", () => {
    const noCached = catalog([
      entry({ pricing: [{ ...PRICE_A, cachedInputMicrosPerMillionTokens: null, effectiveTo: null }] }),
    ]);
    const model = selectCatalogEntry(noCached, "model-a", "2026-03-01T00:00:00.000Z")!;
    const cost = computeCost(
      model,
      createTokenUsage({ cachedInputTokens: 1_000_000 }),
      0,
      "2026-03-01T00:00:00.000Z",
    );
    expect(cost.money!.amountMicros).toBe(1_000_000);
  });

  it("leaves cache writes unpriced rather than double counting them as input", () => {
    const cost = computeCost(
      current,
      createTokenUsage({ inputTokens: 1_000_000 }),
      250_000,
      "2026-03-01T00:00:00.000Z",
    );
    // Cache writes are a detail of input_tokens; with no dedicated rate they
    // add nothing and the result says so.
    expect(cost.money!.amountMicros).toBe(1_000_000);
    expect(cost.cacheWriteUnpriced).toBe(true);
  });

  it("bills cache writes when the snapshot declares a rate", () => {
    const withWrite = catalog([
      entry({
        pricing: [{ ...PRICE_A, cacheWriteMicrosPerMillionTokens: 4_000_000, effectiveTo: null }],
      }),
    ]);
    const model = selectCatalogEntry(withWrite, "model-a", "2026-03-01T00:00:00.000Z")!;
    const cost = computeCost(model, createTokenUsage({}), 1_000_000, "2026-03-01T00:00:00.000Z");
    expect(cost.money!.amountMicros).toBe(4_000_000);
    expect(cost.cacheWriteUnpriced).toBe(false);
  });

  it("reports unknown cost when no slice covers the instant", () => {
    const cost = computeCost(current, createTokenUsage({ inputTokens: 10 }), 0, "2020-01-01T00:00:00.000Z");
    expect(cost.money).toBeNull();
    expect(cost.pricingSource).toBeNull();
  });

  it("refuses to report a cost that overflows the safe monetary range", () => {
    const huge = catalog([
      entry({
        pricing: [
          {
            ...PRICE_A,
            inputMicrosPerMillionTokens: Number.MAX_SAFE_INTEGER,
            effectiveTo: null,
          },
        ],
      }),
    ]);
    const model = selectCatalogEntry(huge, "model-a", "2026-03-01T00:00:00.000Z")!;
    try {
      computeCost(model, createTokenUsage({ inputTokens: 1_000_000_000 }), 0, "2026-03-01T00:00:00.000Z");
      expect.unreachable("expected overflow rejection");
    } catch (error) {
      expect(isProviderError(error, "MALFORMED_RESPONSE")).toBe(true);
      expect(detailCode(error)).toBe("cost-overflow");
    }
  });
});

describe("restrictive capability overrides", () => {
  const base = selectCatalogEntry(catalog([entry({ pricing: [PRICE_B] })]), "model-a", "2026-08-01T00:00:00.000Z")!;

  function override(values: Record<string, unknown>): ReturnType<typeof parseOpenAiCapabilityOverride> {
    return parseOpenAiCapabilityOverride(
      {
        modelId: "model-a",
        denyStructuredOutput: false,
        denyToolCalling: false,
        denyVision: false,
        denyReasoning: false,
        denySampling: false,
        maxContextWindowTokens: null,
        maxOutputTokens: null,
        allowedReasoningEfforts: null,
        ...values,
      },
      "override",
    );
  }

  it("can only remove capabilities, never add them", () => {
    const tightened = applyCapabilityOverride(
      base,
      override({ denyToolCalling: true, denyVision: true, denyStructuredOutput: true }),
    );
    expect(tightened.supportsToolCalling).toBe(false);
    expect(tightened.supportsVision).toBe(false);
    expect(tightened.supportsStructuredOutput).toBe(false);

    // Sampling is off in the snapshot; an override cannot switch it on.
    const attempted = applyCapabilityOverride(base, override({ denySampling: false }));
    expect(attempted.supportsSampling).toBe(base.supportsSampling);
  });

  it("can only lower limits, never raise them", () => {
    const lowered = applyCapabilityOverride(
      base,
      override({ maxContextWindowTokens: 50_000, maxOutputTokens: 8_000 }),
    );
    expect(lowered.contextWindowTokens).toBe(50_000);
    expect(lowered.maxOutputTokens).toBe(8_000);

    const raised = applyCapabilityOverride(
      base,
      override({ maxContextWindowTokens: 99_000_000, maxOutputTokens: 99_000_000 }),
    );
    expect(raised.contextWindowTokens).toBe(base.contextWindowTokens);
    expect(raised.maxOutputTokens).toBe(base.maxOutputTokens);
  });

  it("narrows the reasoning-effort set to the intersection", () => {
    const narrowed = applyCapabilityOverride(base, override({ allowedReasoningEfforts: ["low", "max"] }));
    expect(narrowed.supportedReasoningEfforts).toEqual(["low"]);

    const disabled = applyCapabilityOverride(base, override({ denyReasoning: true }));
    expect(disabled.supportsReasoning).toBe(false);
    expect(disabled.supportedReasoningEfforts).toEqual([]);
  });

  it("keeps max output within the lowered context window", () => {
    const clamped = applyCapabilityOverride(base, override({ maxContextWindowTokens: 1_000 }));
    expect(clamped.maxOutputTokens).toBeLessThanOrEqual(1_000);
  });

  it("returns the entry unchanged when there is no override", () => {
    expect(applyCapabilityOverride(base, null)).toBe(base);
  });
});

describe("Stage 2 projection", () => {
  it("carries pricing metadata effective at the instant", () => {
    const priced = catalog([entry({ pricing: [PRICE_A, PRICE_B] })]);
    const model = selectCatalogEntry(priced, "model-a", "2026-08-01T00:00:00.000Z")!;
    const capabilities = toModelCapabilities("openai", model, "2026-08-01T00:00:00.000Z");
    expect(capabilities.providerId).toBe("openai");
    expect(capabilities.modelId).toBe("model-a");
    expect(capabilities.locality).toBe("cloud");
    expect(capabilities.cost).toEqual({
      currency: "USD",
      inputMicrosPerMillionTokens: 2_000_000,
      outputMicrosPerMillionTokens: 16_000_000,
      cachedInputMicrosPerMillionTokens: 100_000,
    });
  });

  it("reports null cost when pricing is unknown", () => {
    const unpriced = catalog([entry()]);
    const model = selectCatalogEntry(unpriced, "model-a", "2026-08-01T00:00:00.000Z")!;
    expect(toModelCapabilities("openai", model, "2026-08-01T00:00:00.000Z").cost).toBeNull();
  });
});
