import { describe, expect, it, vi } from "vitest";
import {
  createProfilerConfiguration,
  createTaskProfiler,
  parseTaskProfile,
  parseTaskProfileRequest,
  profileTask,
  summarizeTaskProfile,
  taskAuthorityCeilingsFingerprint,
  taskProfileFingerprint
} from "../src/index.js";
import {
  PROFILER_LEAK_CANARY,
  classifierHintFixture,
  fullTaskProfileRequestFixture,
  repositoryIndexFixture,
  taskAuthorityCeilingsFixture,
  taskProfileRequestFixture,
  taskRequirementsFixture
} from "../src/testing/fixtures.js";

describe("task profiling", () => {
  it("measures repository, context, prompt, and authority-free proposal structure", async () => {
    const request = await fullTaskProfileRequestFixture();
    const profile = profileTask(request);
    expect(profile.measured.repository?.fileCount).toBeGreaterThan(0);
    expect(profile.measured.repository?.manifestCount).toBe(1);
    expect(profile.measured.context?.exactBytes).toBeGreaterThan(0);
    expect(profile.measured.prompt?.messageCount).toBe(3);
    expect(profile.measured.proposal?.authority).toBe("none");
    expect(profile.measured.proposal?.acceptanceCriterionCount).toBe(2);
    expect(JSON.stringify(profile)).not.toContain(PROFILER_LEAK_CANARY);
    expect(parseTaskProfile(profile)).toEqual(profile);
    expect(summarizeTaskProfile(profile).authority).toBe("none");
  });

  it("conservatively raises trusted floors but ignores proposal and classifier widening", () => {
    const authority = taskAuthorityCeilingsFixture({
      minimumRisk: "critical",
      minimumClassification: "secret",
      requiredCapabilities: Object.freeze(["vision"])
    });
    const profile = profileTask(
      taskProfileRequestFixture({
        authorityCeilings: authority,
        classifierHint: classifierHintFixture({ complexity: 1, reasoning: "low" })
      })
    );
    expect(profile.effective.risk).toBe("critical");
    expect(profile.effective.dataClassification).toBe("secret");
    expect(profile.effective.capabilities).toContain("vision");
    expect(profile.effective.editScope).toBe("multi-file");
    expect(profile.effective.kind).toBe("implement");
  });

  it("reduces confidence and raises complexity for exhausted indexes", async () => {
    const repositoryIndex = await repositoryIndexFixture({ limitExhausted: true });
    const profile = profileTask(taskProfileRequestFixture({ repositoryIndex }));
    expect(profile.measured.repository?.limitsExhausted).toBe(true);
    expect(profile.inferred.complexityFloor).toBe(5);
    expect(profile.confidence.score).toBeLessThan(700);
    expect(profile.inferred.reasonCodes).toContain("repository-limits-exhausted");
  });

  it("enforces profile bounds and edit authority ceilings", async () => {
    const repositoryIndex = await repositoryIndexFixture();
    expect(() =>
      profileTask(
        taskProfileRequestFixture({ repositoryIndex }),
        createProfilerConfiguration({ maximumRepositoryFiles: 1 })
      )
    ).toThrow();
    expect(() =>
      parseTaskProfileRequest({
        ...taskProfileRequestFixture(),
        authorityCeilings: taskAuthorityCeilingsFixture({ maximumEditScope: "single-file" })
      })
    ).toThrow();
    expect(() =>
      parseTaskProfileRequest({
        ...taskProfileRequestFixture(),
        selectedProposalTaskId: "missing-task"
      })
    ).toThrow();
  });

  it("detects profile, authority, and source substitution", () => {
    const profile = profileTask(taskProfileRequestFixture());
    const { fingerprint: _fingerprint, ...unsigned } = profile;
    expect(taskProfileFingerprint(unsigned)).toBe(profile.fingerprint);
    expect(() => parseTaskProfile({ ...profile, authority: "grant" })).toThrow();
    expect(() => parseTaskProfile({ ...profile, sourceFingerprints: [] })).toThrow();
    const authority = taskAuthorityCeilingsFixture();
    const { fingerprint: _authorityFingerprint, ...authorityUnsigned } = authority;
    expect(taskAuthorityCeilingsFingerprint(authorityUnsigned)).toBe(authority.fingerprint);
  });

  it("uses an optional classifier only for unknown structural fields", async () => {
    const port = { classify: vi.fn().mockResolvedValue(classifierHintFixture()) };
    const profiler = createTaskProfiler({
      configuration: createProfilerConfiguration({ classifierEnabled: true }),
      classifierPort: port
    });
    const profile = await profiler.profile(
      taskProfileRequestFixture({ allowClassifierFallback: true })
    );
    expect(profile.classifierOutcome).toBe("hint");
    expect(profile.classifierHint?.confidence).toBe(900);
    expect(profile.effective.kind).toBe("implement");
    expect(port.classify).toHaveBeenCalledTimes(1);
  });

  it("preserves a structured conservative code when classifier fallback is unavailable", async () => {
    const profiler = createTaskProfiler({
      configuration: createProfilerConfiguration({ classifierEnabled: true }),
      classifierPort: {
        classify: async () => {
          throw new Error("untrusted classifier failure");
        }
      }
    });
    const profile = await profiler.profile(
      taskProfileRequestFixture({ allowClassifierFallback: true })
    );
    expect(profile.classifierOutcome).toBe("unknown");
    expect(profile.classifierCode).toBe("UNAVAILABLE");
    expect(profile.classifierHint).toBeNull();
    expect(profile.authority).toBe("none");
  });

  it("contains hostile observer failures without inspecting them", async () => {
    const observer = vi.fn(() => {
      throw new Error(PROFILER_LEAK_CANARY);
    });
    const profile = await createTaskProfiler({ observer }).profile(taskProfileRequestFixture());
    expect(profile.authority).toBe("none");
    expect(observer).toHaveBeenCalledOnce();
  });

  it("rejects invalid requirements before profiling", () => {
    expect(() =>
      taskRequirementsFixture({ editScope: "single-file", capabilities: Object.freeze(["reasoning"]) })
    ).toThrow();
  });
});
