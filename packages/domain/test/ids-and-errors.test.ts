import { describe, expect, it } from "vitest";
import {
  ConcurrencyConflictError,
  DomainError,
  ID_PATTERN,
  InvariantViolationError,
  PolicyViolationError,
  SerializationError,
  ValidationError,
  isAgentId,
  isApprovalId,
  isArtifactId,
  isEventId,
  isLeaseId,
  isModelId,
  isProjectId,
  isProviderId,
  isRunId,
  isTaskId,
  isTaskRunId,
  isTraceId,
  isWorkspaceId,
  parseAgentId,
  parseApprovalId,
  parseArtifactId,
  parseEventId,
  parseLeaseId,
  parseModelId,
  parseProjectId,
  parseProviderId,
  parseRunId,
  parseTaskId,
  parseTaskRunId,
  parseTraceId,
  parseWorkspaceId,
} from "../src/index.js";

const ID_PARSERS = [
  ["ProjectId", parseProjectId, isProjectId],
  ["RunId", parseRunId, isRunId],
  ["TaskId", parseTaskId, isTaskId],
  ["TaskRunId", parseTaskRunId, isTaskRunId],
  ["LeaseId", parseLeaseId, isLeaseId],
  ["ApprovalId", parseApprovalId, isApprovalId],
  ["EventId", parseEventId, isEventId],
  ["AgentId", parseAgentId, isAgentId],
  ["ProviderId", parseProviderId, isProviderId],
  ["ModelId", parseModelId, isModelId],
  ["ArtifactId", parseArtifactId, isArtifactId],
  ["WorkspaceId", parseWorkspaceId, isWorkspaceId],
  ["TraceId", parseTraceId, isTraceId],
] as const;

const HOSTILE_ID_VALUES: readonly unknown[] = [
  "",
  " ",
  ".starts-with-dot",
  "-starts-with-dash",
  "has space",
  "has/slash",
  "has\\backslash",
  "a".repeat(129),
  "nul\u0000char",
  "tab\tchar",
  123,
  null,
  undefined,
  {},
  ["valid-id"],
  true,
];

describe("branded identifiers", () => {
  it.each(ID_PARSERS)("%s accepts canonical identifiers", (_label, parse, guard) => {
    const value = "proj_01.example:node-1";
    expect(parse(value)).toBe(value);
    expect(guard(value)).toBe(true);
    expect(parse("a")).toBe("a");
    expect(parse("A".repeat(128))).toBe("A".repeat(128));
  });

  it.each(ID_PARSERS)("%s rejects hostile values", (_label, parse, guard) => {
    for (const hostile of HOSTILE_ID_VALUES) {
      expect(() => parse(hostile)).toThrow(ValidationError);
      expect(guard(hostile)).toBe(false);
    }
  });

  it("never echoes the rejected value in the error", () => {
    const secret = "sk-super-secret-value!";
    try {
      parseProjectId(secret);
      expect.unreachable();
    } catch (error) {
      const serialized = JSON.stringify((error as ValidationError).toJSON());
      expect(serialized).not.toContain(secret);
      expect((error as ValidationError).message).not.toContain(secret);
    }
  });

  it("exposes the shared identifier pattern", () => {
    expect(ID_PATTERN.test("ok-id")).toBe(true);
    expect(ID_PATTERN.test("!bad")).toBe(false);
  });
});

describe("domain errors", () => {
  it("carries codes, frozen details, and serializes deterministically", () => {
    const error = new InvariantViolationError("Broken.", { count: 2 });
    expect(error.code).toBe("INVARIANT_VIOLATION");
    expect(error.name).toBe("InvariantViolationError");
    expect(Object.isFrozen(error.details)).toBe(true);
    expect(error.toJSON()).toEqual({
      name: "InvariantViolationError",
      code: "INVARIANT_VIOLATION",
      message: "Broken.",
      details: { count: 2 },
    });
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toBeInstanceOf(Error);
  });

  it("ValidationError freezes its issues", () => {
    const error = new ValidationError("bad", [{ path: "a", code: "x", message: "m" }]);
    expect(Object.isFrozen(error.issues)).toBe(true);
    expect(Object.isFrozen(error.issues[0])).toBe(true);
    expect(error.details["issueCount"]).toBe(1);
  });

  it("distinguishes the remaining error classes", () => {
    expect(new SerializationError("s").code).toBe("SERIALIZATION_FAILED");
    expect(new ConcurrencyConflictError("c").code).toBe("CONCURRENCY_CONFLICT");
    const policy = new PolicyViolationError("p", ["RULE_A"]);
    expect(policy.code).toBe("POLICY_VIOLATION");
    expect(policy.reasonCodes).toEqual(["RULE_A"]);
  });
});
