import { describe, expect, it } from "vitest";
import {
  createTaskProfiler,
  estimateCompiledPromptTokens,
  profileTask,
  summarizeTaskProfile,
  type TaskProfiler
} from "../index.js";
import {
  TOKEN_ESTIMATOR_BINDING_FIXTURE,
  classifierHintFixture,
  compiledPromptFixture,
  exactTokenEstimatorFixture,
  fullTaskProfileRequestFixture,
  taskProfileRequestFixture
} from "./fixtures.js";
import { createTokenEstimatorRegistry as createRegistry } from "../estimator.js";

export interface ProfilerContractHarness {
  readonly profiler: TaskProfiler;
}

export function describeProfilerContract(
  name: string,
  create: () => ProfilerContractHarness
): void {
  describe(`profiler contract: ${name}`, () => {
    it("produces immutable byte-identical profiles from fixed snapshots", async () => {
      const harness = create();
      const request = await fullTaskProfileRequestFixture();
      const first = await harness.profiler.profile(request);
      const second = await harness.profiler.profile(request);
      expect(first).toEqual(second);
      expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.measured.repository)).toBe(true);
      expect(first.authority).toBe("none");
    });

    it("keeps classifier hints separate and unable to change trusted requirements", () => {
      const request = taskProfileRequestFixture({
        classifierHint: classifierHintFixture({
          taskKind: "explain",
          complexity: 1,
          reasoning: "low"
        })
      });
      const profile = profileTask(request);
      expect(profile.classifierHint?.taskKind).toBe("explain");
      expect(profile.effective.kind).toBe("implement");
      expect(profile.effective.risk).toBe("medium");
      expect(profile.authority).toBe("none");
    });

    it("returns body-free summaries", async () => {
      const profile = await createTaskProfiler().profile(await fullTaskProfileRequestFixture());
      const summary = summarizeTaskProfile(profile);
      expect(JSON.stringify(summary)).not.toContain("STAGE16-PROFILER-CANARY-19C4");
      expect(summary.profileFingerprint).toBe(profile.fingerprint);
      expect(summary.authority).toBe("none");
    });

    it("binds token estimates to an exact provider/profile/model fingerprint", async () => {
      const compiled = await compiledPromptFixture();
      const registry = createRegistry([exactTokenEstimatorFixture()]);
      const estimate = estimateCompiledPromptTokens(
        registry,
        TOKEN_ESTIMATOR_BINDING_FIXTURE,
        {
          compiledPrompt: compiled.prompt,
          toolDefinitionBytes: 3,
          imageMetadataBytes: 5,
          artifactMetadataBytes: 7,
          cachedInputTokens: null,
          outputAllowanceTokens: 100,
          reasoningAllowanceTokens: 10
        }
      );
      expect(estimate.accuracy).toBe("exact");
      expect(estimate.canProveContextFit).toBe(true);
      expect(estimate.breakdown.tools).toBe(3);
      expect(estimate.totalTokens).toBe(
        estimate.inputTokens + estimate.outputAllowanceTokens + estimate.reasoningAllowanceTokens
      );
    });
  });
}
