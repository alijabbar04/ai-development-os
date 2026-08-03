/**
 * The small pieces the packing tests use but do not pin down directly: result
 * helpers, error serialization, the request fingerprint's inputs, and the
 * deterministic fixtures themselves.
 */

import { describe, expect, it } from "vitest";
import {
  causeCategory,
  contextFailure,
  ContextError,
  diagnostic,
  failed,
  ok,
} from "../src/errors.js";
import {
  candidateDigest,
  categoryPriority,
  contextRequestFingerprint,
  DEFAULT_CONTEXT_CONFIGURATION,
  withContextOverrides,
  CONTEXT_CATEGORIES,
} from "../src/model.js";
import { summarizeContextPack } from "../src/pack.js";
import { planContextPack } from "../src/select.js";
import { conservativeUnitEstimator } from "../src/estimator.js";
import { parseContextAuthorizationDecision } from "../src/authorization.js";
import { ValidationError } from "@ai-dev-os/domain";
import {
  candidate,
  contextRequest,
  createManualContextClock,
  FIXTURE_SCOPE,
  scopeLabelFor,
} from "../src/testing/fixtures.js";
import { sealContextPack } from "../src/pack.js";

describe("result helpers and errors", () => {
  it("wraps success and failure as frozen values", () => {
    const success = ok(42);
    expect(success).toEqual({ ok: true, value: 42 });
    expect(Object.isFrozen(success)).toBe(true);
    const failure = failed<number>(contextFailure("CANCELLED", "stopped", { stage: "collect" }));
    expect(failure.ok).toBe(false);
    expect(Object.isFrozen(failure)).toBe(true);
    if (!failure.ok) {
      expect(failure.failure.details["stage"]).toBe("collect");
      expect(Object.isFrozen(failure.failure.details)).toBe(true);
    }
  });

  it("serializes an error without leaking and categorizes causes", () => {
    const error = new ContextError("SOURCE_UNAVAILABLE", "gone", { locator: "redacted" });
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: "ContextError",
      code: "SOURCE_UNAVAILABLE",
      message: "gone",
      details: { locator: "redacted" },
    });
    expect(causeCategory(error)).toBe("SOURCE_UNAVAILABLE");
    expect(causeCategory(new RangeError("x"))).toBe("RangeError");
    expect(causeCategory(7)).toBe("number");
  });

  it("bounds diagnostic detail text", () => {
    const long = diagnostic("candidate-truncated", "repository:a.ts", "d".repeat(500));
    expect(long.detail).toHaveLength(200);
    expect(diagnostic("omissions-truncated", null, "x").identity).toBeNull();
  });
});

describe("model helpers", () => {
  it("orders categories by declared priority", () => {
    expect(CONTEXT_CATEGORIES.map(categoryPriority)).toEqual([0, 1, 2, 3, 4]);
  });

  it("digests candidate bodies stably", () => {
    expect(candidateDigest("abc")).toBe(candidateDigest("abc"));
    expect(candidateDigest("abc")).not.toBe(candidateDigest("abd"));
    expect(candidateDigest("")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("binds every input into the request fingerprint", () => {
    const base = {
      request: contextRequest(),
      configuration: DEFAULT_CONTEXT_CONFIGURATION,
      estimatorId: "conservative-utf8-bytes-per-3",
      policyDecisionFingerprint: null,
    };
    const reference = contextRequestFingerprint(base);
    expect(contextRequestFingerprint(base)).toBe(reference);
    expect(
      contextRequestFingerprint({ ...base, estimatorId: "something-else" }),
    ).not.toBe(reference);
    expect(
      contextRequestFingerprint({ ...base, policyDecisionFingerprint: "a".repeat(64) }),
    ).not.toBe(reference);
    expect(
      contextRequestFingerprint({
        ...base,
        request: contextRequest({ taskDescription: "different" }),
      }),
    ).not.toBe(reference);
    const configuration = (() => {
      const result = withContextOverrides(DEFAULT_CONTEXT_CONFIGURATION, {
        includeUnconfirmedCandidates: true,
      });
      if (!result.ok) {
        throw new Error("unexpected");
      }
      return result.value;
    })();
    expect(contextRequestFingerprint({ ...base, configuration })).not.toBe(reference);
  });
});

describe("authorization decision validation", () => {
  it("accepts a well-formed decision and rejects malformed ones", () => {
    expect(
      parseContextAuthorizationDecision({
        outcome: "allowed",
        reasonCode: "PROJECT_MATCH",
        decisionFingerprint: "a".repeat(64),
      }).outcome,
    ).toBe("allowed");
    expect(() =>
      parseContextAuthorizationDecision({
        outcome: "maybe",
        reasonCode: "X",
        decisionFingerprint: null,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      parseContextAuthorizationDecision({
        outcome: "allowed",
        reasonCode: "lower case",
        decisionFingerprint: null,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      parseContextAuthorizationDecision({
        outcome: "allowed",
        reasonCode: "OK",
        decisionFingerprint: "short",
      }),
    ).toThrow(ValidationError);
  });
});

describe("pack summary", () => {
  it("counts omissions by reason without naming their bodies", () => {
    const planned = planContextPack({
      candidates: [
        candidate({ identity: "repository:a.ts", body: "a".repeat(100) }),
        candidate({ identity: "repository:copy.ts", body: "a".repeat(100) }),
      ],
      configuration: DEFAULT_CONTEXT_CONFIGURATION,
      estimator: conservativeUnitEstimator,
    });
    if (!planned.ok) {
      throw new Error("expected success");
    }
    const sealed = sealContextPack({
      schemaVersion: 1,
      selectionAlgorithmVersion: 1,
      requestFingerprint: "b".repeat(64),
      generatedAt: "2026-08-02T12:00:00.000Z",
      items: planned.value.items,
      omissions: planned.value.omissions,
      omissionsTruncated: planned.value.omissionsTruncated,
      usage: planned.value.usage,
      estimator: { estimatorId: "conservative-utf8-bytes-per-3", exact: false, bytesPerUnit: 3 },
      diagnostics: planned.value.diagnostics,
    });
    const audit = summarizeContextPack(sealed);
    expect(audit.omissionsByReason["duplicate-digest"]).toBe(1);
    expect(audit.itemCount).toBe(1);
    expect(audit.frameSentinelOccurrences).toBe(0);
    expect(JSON.stringify(audit)).not.toContain("aaa");
  });
});

describe("fixtures", () => {
  it("advances and sets the manual clock", () => {
    const clock = createManualContextClock("2026-01-01T00:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
    clock.advance(1_000);
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:01.000Z");
    clock.set("2030-06-06T06:06:06.000Z");
    expect(clock.now().toISOString()).toBe("2030-06-06T06:06:06.000Z");
  });

  it("derives a bounded, opaque scope label", () => {
    const label = scopeLabelFor(FIXTURE_SCOPE);
    expect(label).toMatch(/^[0-9a-f]{16}$/);
    expect(label).toBe(scopeLabelFor(FIXTURE_SCOPE));
    expect(label).not.toContain("alice");
  });
});
