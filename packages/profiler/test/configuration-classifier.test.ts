import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROFILER_CONFIGURATION,
  PROFILER_CONFIG_EXTENSION_NAMESPACE,
  classifierHintFingerprint,
  createClassifierHint,
  createDeterministicClassifierFallback,
  createProfilerConfiguration,
  inspectProfilerConfiguration,
  parseClassifierHint,
  parseProfilerConfiguration,
  parseProfilerConfigurationExtension,
  profilerConfigurationFingerprint
} from "../src/index.js";
import { classifierHintFixture, sha256Fixture } from "../src/testing/fixtures.js";

const UNKNOWN_INPUT = Object.freeze({
  requestFingerprint: sha256Fixture("request"),
  unknownFields: Object.freeze(["repository-scale"] as const),
  repositoryFileCount: null,
  contextItemCount: null,
  proposalTaskCount: null
});

describe("profiler configuration", () => {
  it("has conservative immutable defaults and fingerprinted overrides", () => {
    expect(DEFAULT_PROFILER_CONFIGURATION.classifierEnabled).toBe(false);
    expect(Object.isFrozen(DEFAULT_PROFILER_CONFIGURATION)).toBe(true);
    const configured = createProfilerConfiguration({
      classifierEnabled: true,
      minimumClassifierConfidence: 700
    });
    expect(parseProfilerConfiguration(configured)).toBeDefined();
    expect(configured.fingerprint).not.toBe(DEFAULT_PROFILER_CONFIGURATION.fingerprint);
    expect(inspectProfilerConfiguration(configured)).not.toContain("maximumEstimatorInputBytes");
  });

  it("rejects tampering and unsupported accuracy", () => {
    expect(() =>
      parseProfilerConfiguration({
        ...DEFAULT_PROFILER_CONFIGURATION,
        classifierEnabled: true
      })
    ).toThrow();
    const { fingerprint: _fingerprint, ...unsigned } = DEFAULT_PROFILER_CONFIGURATION;
    expect(profilerConfigurationFingerprint(unsigned)).toBe(DEFAULT_PROFILER_CONFIGURATION.fingerprint);
    expect(() =>
      parseProfilerConfiguration({
        ...DEFAULT_PROFILER_CONFIGURATION,
        minimumHardFitAccuracy: "heuristic"
      })
    ).toThrow();
  });

  it("accepts profiling semantics only from a locked system extension", () => {
    const extension = {
      namespace: PROFILER_CONFIG_EXTENSION_NAMESPACE,
      schemaVersion: 1,
      value: JSON.parse(JSON.stringify(DEFAULT_PROFILER_CONFIGURATION))
    };
    expect(parseProfilerConfigurationExtension(extension, {
      layer: "system",
      providersLocked: true
    })).toEqual(DEFAULT_PROFILER_CONFIGURATION);
    expect(() => parseProfilerConfigurationExtension(extension, {
      layer: "user",
      providersLocked: true
    })).toThrow(/system layer/u);
    expect(() => parseProfilerConfigurationExtension(
      { ...extension, namespace: "other" },
      { layer: "system", providersLocked: true }
    )).toThrow(/unsupported/u);
  });
});

describe("classifier boundary", () => {
  it("validates strict canonical hints", () => {
    const hint = createClassifierHint({
      taskKind: "review",
      complexity: 2,
      reasoning: "medium",
      codingRequirement: "read",
      confidence: 850,
      reasonCodes: Object.freeze(["structure-only"])
    });
    expect(parseClassifierHint(hint)).toEqual(hint);
    const { fingerprint: _fingerprint, ...unsigned } = hint;
    expect(classifierHintFingerprint(unsigned)).toBe(hint.fingerprint);
    expect(() => parseClassifierHint({ ...hint, risk: "low" })).toThrow();
    expect(() => parseClassifierHint({ ...hint, confidence: 1 })).toThrow();
    expect(() =>
      parseClassifierHint({
        ...hint,
        reasonCodes: ["structure-only", "structure-only"],
        fingerprint: hint.fingerprint
      })
    ).toThrow();
  });

  it("fails closed for every unavailable or malformed port outcome", async () => {
    const disabled = createDeterministicClassifierFallback({
      port: null,
      enabled: false,
      minimumConfidence: 800
    });
    await expect(disabled.classify(UNKNOWN_INPUT)).resolves.toEqual({
      outcome: "unknown",
      code: "DISABLED"
    });
    const unavailable = createDeterministicClassifierFallback({
      port: null,
      enabled: true,
      minimumConfidence: 800
    });
    await expect(unavailable.classify(UNKNOWN_INPUT)).resolves.toEqual({
      outcome: "unknown",
      code: "UNAVAILABLE"
    });
    const malformed = createDeterministicClassifierFallback({
      port: { classify: vi.fn().mockResolvedValue({ secret: "armed" }) },
      enabled: true,
      minimumConfidence: 800
    });
    await expect(malformed.classify(UNKNOWN_INPUT)).resolves.toEqual({
      outcome: "unknown",
      code: "MALFORMED"
    });
    const throwing = createDeterministicClassifierFallback({
      port: { classify: vi.fn().mockRejectedValue(new Error("secret body")) },
      enabled: true,
      minimumConfidence: 800
    });
    await expect(throwing.classify(UNKNOWN_INPUT)).resolves.toEqual({
      outcome: "unknown",
      code: "UNAVAILABLE"
    });
  });

  it("returns only sufficiently confident hints and skips calls when nothing is unknown", async () => {
    const low = createDeterministicClassifierFallback({
      port: { classify: vi.fn().mockResolvedValue(classifierHintFixture({ confidence: 799 })) },
      enabled: true,
      minimumConfidence: 800
    });
    await expect(low.classify(UNKNOWN_INPUT)).resolves.toEqual({
      outcome: "unknown",
      code: "LOW_CONFIDENCE"
    });
    const port = { classify: vi.fn().mockResolvedValue(classifierHintFixture()) };
    const accepted = createDeterministicClassifierFallback({
      port,
      enabled: true,
      minimumConfidence: 800
    });
    await expect(accepted.classify(UNKNOWN_INPUT)).resolves.toMatchObject({ outcome: "hint" });
    await expect(
      accepted.classify({ ...UNKNOWN_INPUT, unknownFields: Object.freeze([]) })
    ).resolves.toEqual({ outcome: "unknown", code: "NOT_NEEDED" });
    await expect(
      accepted.classify({
        ...UNKNOWN_INPUT,
        unknownFields: Object.freeze(["unsupported-field"])
      } as never)
    ).resolves.toEqual({ outcome: "unknown", code: "MALFORMED" });
    expect(port.classify).toHaveBeenCalledTimes(1);
  });
});
