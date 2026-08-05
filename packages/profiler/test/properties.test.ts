import { describe, expect, it } from "vitest";
import {
  createProfilerConfiguration,
  createTokenEstimatorRegistry,
  profileTask,
  taskProfileFingerprint
} from "../src/index.js";
import {
  PROFILER_PROPERTY_SEEDS,
  TOKEN_ESTIMATOR_BINDING_FIXTURE,
  compiledPromptFixture,
  conservativeTokenEstimatorFixture,
  taskProfileRequestFixture,
  taskRequirementsFixture
} from "../src/testing/fixtures.js";

function sequence(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

describe("seeded profiler properties", () => {
  it.each(PROFILER_PROPERTY_SEEDS)("preserves canonical fingerprints for seed %i", (seed) => {
    const next = sequence(seed);
    for (let index = 0; index < 50; index += 1) {
      const complexity = ((next() % 5) + 1) as 1 | 2 | 3 | 4 | 5;
      const expectedInputTokens = next() % 10_000;
      const request = taskProfileRequestFixture({
        requirements: taskRequirementsFixture({ complexity, expectedInputTokens })
      });
      const first = profileTask(request, createProfilerConfiguration());
      const second = profileTask(request, createProfilerConfiguration());
      expect(second.fingerprint).toBe(first.fingerprint);
      const { fingerprint: _fingerprint, ...unsigned } = first;
      expect(taskProfileFingerprint(unsigned)).toBe(first.fingerprint);
    }
  });

  it.each(PROFILER_PROPERTY_SEEDS)("never undercounts declared byte-bound fixtures for seed %i", async (seed) => {
    const next = sequence(seed);
    const compiled = await compiledPromptFixture();
    const registry = createTokenEstimatorRegistry([conservativeTokenEstimatorFixture()]);
    for (let index = 0; index < 40; index += 1) {
      const toolBytes = next() % 1_000;
      const imageBytes = next() % 1_000;
      const artifactBytes = next() % 1_000;
      const estimate = registry.estimate(TOKEN_ESTIMATOR_BINDING_FIXTURE, {
        compiledPrompt: compiled.prompt,
        toolDefinitionBytes: toolBytes,
        imageMetadataBytes: imageBytes,
        artifactMetadataBytes: artifactBytes,
        cachedInputTokens: null,
        outputAllowanceTokens: next() % 2_000,
        reasoningAllowanceTokens: next() % 2_000
      });
      expect(estimate.inputTokens).toBeGreaterThanOrEqual(
        compiled.prompt.accounting.promptBytes + toolBytes + imageBytes + artifactBytes
      );
    }
  });
});
