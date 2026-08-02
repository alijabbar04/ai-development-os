import { describe, expect, it } from "vitest";
import {
  ValidationError,
  computeRetryDelayMs,
  createExecutionConstraints,
  createRetryPolicy,
  createTaskRequirements,
  parseExecutionConstraints,
  parseRetryPolicy,
  parseTaskComplexity,
  parseTaskKind,
  parseTaskPriority,
  parseTaskRequirements,
  parseTaskRisk,
  parseTimeoutPolicy,
  type RetryPolicy,
  type TaskRequirementsInput,
} from "../src/index.js";

const REQUIREMENTS: TaskRequirementsInput = {
  kind: "implement",
  complexity: 3,
  risk: "medium",
  reasoning: "high",
  editScope: "multi-file",
  capabilities: ["code-edit", "repository-read", "testing"],
  dataClassification: "proprietary-source",
  expectedInputTokens: 12_000,
  expectedOutputTokens: 4_000,
};

const RETRY: RetryPolicy = Object.freeze({
  maxAttempts: 5,
  backoff: "exponential",
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  backoffMultiplierPercent: 200,
});

describe("task enums", () => {
  it("parses valid members and rejects arbitrary strings", () => {
    expect(parseTaskKind("debug")).toBe("debug");
    expect(parseTaskRisk("critical")).toBe("critical");
    expect(parseTaskComplexity(5)).toBe(5);
    expect(parseTaskPriority(-1_000)).toBe(-1_000);

    expect(() => parseTaskKind("hack-the-planet")).toThrow(ValidationError);
    expect(() => parseTaskRisk("none")).toThrow(ValidationError);
    expect(() => parseTaskComplexity(0)).toThrow(ValidationError);
    expect(() => parseTaskComplexity(2.5)).toThrow(ValidationError);
    expect(() => parseTaskPriority(1_001)).toThrow(ValidationError);
  });
});

describe("TaskRequirements", () => {
  it("creates a frozen value with sorted, de-duplicated capabilities", () => {
    const requirements = createTaskRequirements({
      ...REQUIREMENTS,
      capabilities: ["testing", "code-edit", "repository-read", "code-edit"],
    });
    expect(requirements.capabilities).toEqual(["code-edit", "repository-read", "testing"]);
    expect(Object.isFrozen(requirements)).toBe(true);
    expect(Object.isFrozen(requirements.capabilities)).toBe(true);
  });

  it("normalizes missing token estimates to null", () => {
    const requirements = parseTaskRequirements({
      ...REQUIREMENTS,
      expectedInputTokens: undefined,
      expectedOutputTokens: null,
    });
    expect(requirements.expectedInputTokens).toBeNull();
    expect(requirements.expectedOutputTokens).toBeNull();
  });

  it("requires code-edit capability when an edit scope is declared", () => {
    expect(() =>
      parseTaskRequirements({ ...REQUIREMENTS, capabilities: ["repository-read"] }),
    ).toThrow(ValidationError);
    expect(
      parseTaskRequirements({
        ...REQUIREMENTS,
        editScope: "none",
        capabilities: ["repository-read"],
      }).editScope,
    ).toBe("none");
  });

  it("rejects unexpected fields, bad classifications, and non-objects", () => {
    expect(() => parseTaskRequirements({ ...REQUIREMENTS, extra: 1 })).toThrow(ValidationError);
    expect(() =>
      parseTaskRequirements({ ...REQUIREMENTS, dataClassification: "top-secret" }),
    ).toThrow(ValidationError);
    expect(() => parseTaskRequirements(null)).toThrow(ValidationError);
    expect(() => parseTaskRequirements([])).toThrow(ValidationError);
  });

  it("round-trips through JSON", () => {
    const requirements = createTaskRequirements(REQUIREMENTS);
    const revived = parseTaskRequirements(JSON.parse(JSON.stringify(requirements)));
    expect(revived).toEqual(requirements);
  });
});

describe("RetryPolicy", () => {
  it("parses and freezes a valid policy", () => {
    const policy = createRetryPolicy(RETRY);
    expect(policy).toEqual(RETRY);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it("rejects inconsistent policies", () => {
    expect(() =>
      parseRetryPolicy({ ...RETRY, initialDelayMs: 90_000 }),
    ).toThrow(ValidationError);
    expect(() =>
      parseRetryPolicy({ ...RETRY, backoffMultiplierPercent: 100 }),
    ).toThrow(ValidationError);
    expect(() => parseRetryPolicy({ ...RETRY, maxAttempts: 0 })).toThrow(ValidationError);
    expect(() => parseRetryPolicy({ ...RETRY, maxAttempts: 101 })).toThrow(ValidationError);
    expect(() => parseRetryPolicy({ ...RETRY, initialDelayMs: 10.5 })).toThrow(ValidationError);
    expect(() => parseRetryPolicy({ ...RETRY, initialDelayMs: Number.NaN })).toThrow(
      ValidationError,
    );
  });

  it("computes deterministic backoff delays", () => {
    expect(computeRetryDelayMs(RETRY, 1)).toBe(0);
    expect(computeRetryDelayMs(RETRY, 2)).toBe(1_000);
    expect(computeRetryDelayMs(RETRY, 3)).toBe(2_000);
    expect(computeRetryDelayMs(RETRY, 4)).toBe(4_000);
    expect(computeRetryDelayMs(RETRY, 100)).toBe(60_000);

    const fixed = createRetryPolicy({ ...RETRY, backoff: "fixed" });
    expect(computeRetryDelayMs(fixed, 7)).toBe(1_000);

    const none = createRetryPolicy({ ...RETRY, backoff: "none" });
    expect(computeRetryDelayMs(none, 3)).toBe(0);

    expect(() => computeRetryDelayMs(RETRY, 0)).toThrow(ValidationError);
  });

  it("caps huge exponential growth at maxDelayMs without overflow", () => {
    const aggressive = createRetryPolicy({
      maxAttempts: 100,
      backoff: "exponential",
      initialDelayMs: 5_000,
      maxDelayMs: 10_000_000_000_000,
      backoffMultiplierPercent: 10_000,
    });
    expect(computeRetryDelayMs(aggressive, 100)).toBe(10_000_000_000_000);
  });
});

describe("TimeoutPolicy and ExecutionConstraints", () => {
  const TIMEOUT = { executionTimeoutMs: 60_000, totalTimeoutMs: 300_000, heartbeatTimeoutMs: 5_000 };

  it("parses a valid timeout policy and normalizes missing heartbeat", () => {
    expect(parseTimeoutPolicy(TIMEOUT)).toEqual(TIMEOUT);
    expect(
      parseTimeoutPolicy({ ...TIMEOUT, heartbeatTimeoutMs: undefined }).heartbeatTimeoutMs,
    ).toBeNull();
  });

  it("rejects ordering violations", () => {
    expect(() => parseTimeoutPolicy({ ...TIMEOUT, executionTimeoutMs: 400_000 })).toThrow(
      ValidationError,
    );
    expect(() => parseTimeoutPolicy({ ...TIMEOUT, heartbeatTimeoutMs: 70_000 })).toThrow(
      ValidationError,
    );
  });

  it("parses execution constraints and rejects hostile shapes", () => {
    const constraints = createExecutionConstraints({
      timeout: parseTimeoutPolicy(TIMEOUT),
      retry: RETRY,
      maxToolCalls: 50,
      maxOutputBytes: 10_000_000,
      maxSubtaskDepth: 4,
    });
    expect(constraints.maxToolCalls).toBe(50);
    expect(Object.isFrozen(constraints)).toBe(true);

    expect(() => parseExecutionConstraints({})).toThrow(ValidationError);
    expect(() =>
      parseExecutionConstraints({ ...constraints, maxSubtaskDepth: 129 }),
    ).toThrow(ValidationError);
    expect(() =>
      parseExecutionConstraints({ ...constraints, maxOutputBytes: 0 }),
    ).toThrow(ValidationError);
  });
});
