import { describe, expect, it } from "vitest";
import {
  ProfilerArithmeticError,
  createConservativeTokenEstimator,
  createTokenEstimatorDescriptor,
  createTokenEstimatorRegistry,
  estimateCompiledPromptTokens,
  parseTokenEstimate,
  tokenEstimateFingerprint,
  validateTokenEstimator
} from "../src/index.js";
import {
  TOKEN_ESTIMATOR_BINDING_FIXTURE,
  compiledPromptFixture,
  conservativeTokenEstimatorFixture,
  exactTokenEstimatorFixture,
  sha256Fixture
} from "../src/testing/fixtures.js";

describe("token estimator registry", () => {
  it("resolves only exact opaque bindings and has a stable metadata fingerprint", () => {
    const descriptor = exactTokenEstimatorFixture();
    const registry = createTokenEstimatorRegistry([descriptor]);
    expect(registry.contractVersion).toBe(1);
    expect(registry.resolve(TOKEN_ESTIMATOR_BINDING_FIXTURE)?.fingerprint).toBe(
      descriptor.fingerprint
    );
    expect(
      registry.resolve({ ...TOKEN_ESTIMATOR_BINDING_FIXTURE, contractModelId: "fixture-model-alt" })
    ).toBeUndefined();
    expect(registry.descriptors()[0]).not.toHaveProperty("port");
    expect(registry.fingerprint()).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("includes messages, schema, tools, images, artifacts, framing, and allowances", async () => {
    const compiled = await compiledPromptFixture();
    const registry = createTokenEstimatorRegistry([exactTokenEstimatorFixture()]);
    const estimate = estimateCompiledPromptTokens(registry, TOKEN_ESTIMATOR_BINDING_FIXTURE, {
      compiledPrompt: compiled.prompt,
      toolDefinitionBytes: 11,
      imageMetadataBytes: 13,
      artifactMetadataBytes: 17,
      cachedInputTokens: 5,
      outputAllowanceTokens: 101,
      reasoningAllowanceTokens: 19
    });
    expect(estimate.breakdown.tools).toBe(11);
    expect(estimate.breakdown.images).toBe(13);
    expect(estimate.breakdown.artifacts).toBe(17);
    expect(estimate.breakdown.fixedFraming).toBe(7);
    expect(estimate.breakdown.schema).toBe(compiled.prompt.accounting.schemaBytes);
    expect(estimate.totalTokens).toBe(estimate.inputTokens + 120);
    expect(parseTokenEstimate(estimate)).toEqual(estimate);
    const { fingerprint: _fingerprint, ...unsigned } = estimate;
    expect(tokenEstimateFingerprint(unsigned)).toBe(estimate.fingerprint);
  });

  it("labels proven bounds and heuristics honestly", async () => {
    const compiled = await compiledPromptFixture();
    for (const accuracy of ["proven-upper-bound", "heuristic"] as const) {
      const descriptor = conservativeTokenEstimatorFixture(accuracy);
      const estimate = createTokenEstimatorRegistry([descriptor]).estimate(
        TOKEN_ESTIMATOR_BINDING_FIXTURE,
        {
          compiledPrompt: compiled.prompt,
          toolDefinitionBytes: 1,
          imageMetadataBytes: 2,
          artifactMetadataBytes: 3,
          cachedInputTokens: null,
          outputAllowanceTokens: 50,
          reasoningAllowanceTokens: 0
        }
      );
      expect(estimate.accuracy).toBe(accuracy);
      expect(estimate.canProveContextFit).toBe(accuracy !== "heuristic");
      expect(estimate.inputTokens).toBeGreaterThanOrEqual(
        compiled.prompt.accounting.promptBytes + 1 + 2 + 3
      );
      if (accuracy === "heuristic") expect(estimate.breakdown.safetyMargin).toBeGreaterThan(0);
    }
  });

  it("rejects dishonest exactness and upper-bound claims", () => {
    const base = exactTokenEstimatorFixture();
    expect(() =>
      validateTokenEstimator({
        ...base,
        evidence: { ...base.evidence, framingComplete: false }
      })
    ).toThrow(/exact/u);
    const bound = conservativeTokenEstimatorFixture();
    expect(() =>
      validateTokenEstimator({
        ...bound,
        evidence: { ...bound.evidence, kind: "heuristic-ratio" }
      })
    ).toThrow(/bound/u);
    expect(() => validateTokenEstimator({ ...base, port: {} })).toThrow();
  });

  it("rejects duplicate, missing, oversized, hostile, and inconsistent estimates", async () => {
    const compiled = await compiledPromptFixture();
    const exact = exactTokenEstimatorFixture();
    expect(() => createTokenEstimatorRegistry([exact, exact])).toThrow(/unique/u);
    expect(() =>
      createTokenEstimatorRegistry([exact]).estimate(
        { ...TOKEN_ESTIMATOR_BINDING_FIXTURE, providerId: "other-provider" },
        {
          compiledPrompt: compiled.prompt,
          toolDefinitionBytes: 0,
          imageMetadataBytes: 0,
          artifactMetadataBytes: 0,
          cachedInputTokens: null,
          outputAllowanceTokens: 0,
          reasoningAllowanceTokens: 0
        }
      )
    ).toThrow(/no exact/u);
    const tiny = createTokenEstimatorDescriptor({
      estimatorId: "tiny-bound",
      algorithmVersion: 1,
      applicability: TOKEN_ESTIMATOR_BINDING_FIXTURE,
      accuracy: "heuristic",
      evidence: {
        kind: "heuristic-ratio",
        referenceFingerprint: sha256Fixture("tiny"),
        specificationVersion: "v1",
        framingComplete: false
      },
      maximumInputBytes: 1,
      safetyMarginBps: 0,
      port: { count: () => ({}) }
    });
    expect(() =>
      createTokenEstimatorRegistry([tiny]).estimate(TOKEN_ESTIMATOR_BINDING_FIXTURE, {
        compiledPrompt: compiled.prompt,
        toolDefinitionBytes: 0,
        imageMetadataBytes: 0,
        artifactMetadataBytes: 0,
        cachedInputTokens: null,
        outputAllowanceTokens: 0,
        reasoningAllowanceTokens: 0
      })
    ).toThrow(/byte bound/u);
    const hostile = createTokenEstimatorDescriptor({
      estimatorId: "hostile-port",
      algorithmVersion: 1,
      applicability: TOKEN_ESTIMATOR_BINDING_FIXTURE,
      accuracy: "heuristic",
      evidence: {
        kind: "heuristic-ratio",
        referenceFingerprint: sha256Fixture("hostile"),
        specificationVersion: "v1",
        framingComplete: false
      },
      maximumInputBytes: 1_000_000,
      safetyMarginBps: 0,
      port: { count: () => ({ secret: "armed" }) }
    });
    expect(() =>
      createTokenEstimatorRegistry([hostile]).estimate(TOKEN_ESTIMATOR_BINDING_FIXTURE, {
        compiledPrompt: compiled.prompt,
        toolDefinitionBytes: 0,
        imageMetadataBytes: 0,
        artifactMetadataBytes: 0,
        cachedInputTokens: null,
        outputAllowanceTokens: 0,
        reasoningAllowanceTokens: 0
      })
    ).toThrow();
    expect(() =>
      parseTokenEstimate({
        ...createTokenEstimatorRegistry([exact]).estimate(TOKEN_ESTIMATOR_BINDING_FIXTURE, {
          compiledPrompt: compiled.prompt,
          toolDefinitionBytes: 0,
          imageMetadataBytes: 0,
          artifactMetadataBytes: 0,
          cachedInputTokens: null,
          outputAllowanceTokens: 1,
          reasoningAllowanceTokens: 1
        }),
        totalTokens: 1
      })
    ).toThrow(/must equal/u);
  });

  it("contains estimator exceptions and validates cached input", async () => {
    const compiled = await compiledPromptFixture();
    const throwing = createTokenEstimatorDescriptor({
      estimatorId: "throwing-port",
      algorithmVersion: 1,
      applicability: TOKEN_ESTIMATOR_BINDING_FIXTURE,
      accuracy: "heuristic",
      evidence: {
        kind: "heuristic-ratio",
        referenceFingerprint: sha256Fixture("throwing"),
        specificationVersion: "v1",
        framingComplete: false
      },
      maximumInputBytes: 1_000_000,
      safetyMarginBps: 0,
      port: {
        count: () => {
          throw new Error("private provider body");
        }
      }
    });
    expect(() =>
      createTokenEstimatorRegistry([throwing]).estimate(TOKEN_ESTIMATOR_BINDING_FIXTURE, {
        compiledPrompt: compiled.prompt,
        toolDefinitionBytes: 0,
        imageMetadataBytes: 0,
        artifactMetadataBytes: 0,
        cachedInputTokens: null,
        outputAllowanceTokens: 0,
        reasoningAllowanceTokens: 0
      })
    ).toThrow(/port failed/u);
    expect(() =>
      createTokenEstimatorRegistry([exactTokenEstimatorFixture()]).estimate(
        TOKEN_ESTIMATOR_BINDING_FIXTURE,
        {
          compiledPrompt: compiled.prompt,
          toolDefinitionBytes: 0,
          imageMetadataBytes: 0,
          artifactMetadataBytes: 0,
          cachedInputTokens: Number.MAX_SAFE_INTEGER,
          outputAllowanceTokens: 0,
          reasoningAllowanceTokens: 0
        }
      )
    ).toThrow(/cached/u);
  });

  it("detects safe-integer overflow", () => {
    expect(() =>
      createConservativeTokenEstimator({
        estimatorId: "overflow-fixture",
        applicability: TOKEN_ESTIMATOR_BINDING_FIXTURE,
        accuracy: "heuristic",
        evidence: {
          kind: "heuristic-ratio",
          referenceFingerprint: sha256Fixture("overflow"),
          specificationVersion: "v1",
          framingComplete: false
        },
        bytesPerTokenNumerator: 1_000_000,
        bytesPerTokenDenominator: 1,
        fixedOverheadTokens: Number.MAX_SAFE_INTEGER,
        safetyMarginBps: 100_000
      })
    ).not.toThrow();
    const error = new ProfilerArithmeticError("overflow fixture");
    expect(error.toJSON()).toEqual({
      name: "ProfilerArithmeticError",
      code: "ARITHMETIC_OVERFLOW",
      message: "overflow fixture"
    });
  });
});
