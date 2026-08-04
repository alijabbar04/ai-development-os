import { describe, expect, it } from "vitest";
import {
  DEFAULT_THINKER_CONFIGURATION,
  parseThinkerProposal,
  thinkerPlanFingerprint,
  validateThinkerPlan
} from "../src/index.js";
import {
  jsonClone,
  thinkerProposalFixture
} from "../src/testing/fixtures.js";
import {
  promptCompilationRequestFixture
} from "@ai-dev-os/prompt-compiler/testing/fixtures";
import type { PromptCompilationRequest } from "@ai-dev-os/prompt-compiler";

function cloneProposal(): Record<string, unknown> {
  return jsonClone(thinkerProposalFixture()) as unknown as Record<string, unknown>;
}

function tasks(value: Record<string, unknown>): Array<Record<string, unknown>> {
  return value["tasks"] as Array<Record<string, unknown>>;
}

function validate(value: unknown, compilation: PromptCompilationRequest = promptCompilationRequestFixture()) {
  return validateThinkerPlan(value, compilation);
}

describe("strict thinker proposal parser", () => {
  it("parses, normalizes, deeply freezes, and fingerprints a valid proposal", () => {
    const raw = cloneProposal();
    const task = tasks(raw)[0]!;
    task["dependencies"] = ["z-task", "a-task"];
    task["capabilities"] = ["structured-output", "reasoning"];
    const parsed = parseThinkerProposal(raw);
    expect(parsed.tasks[0]?.dependencies).toEqual(["a-task", "z-task"]);
    expect(parsed.tasks[0]?.capabilities).toEqual(["reasoning", "structured-output"]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.tasks[0]?.evidence)).toBe(true);
    expect(thinkerPlanFingerprint(parsed)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects unknown authority-bearing fields and prototype-pollution shapes", () => {
    const extra = cloneProposal();
    tasks(extra)[0]!["approval"] = { outcome: "allowed" };
    expect(() => parseThinkerProposal(extra)).toThrow();
    const polluted = JSON.parse(
      '{"schemaVersion":1,"status":"viable","objective":"x","assumptions":[],"risks":[],"openQuestions":[],"completionCriteria":[],"tasks":[],"__proto__":{"authority":"granted"}}'
    );
    expect(() => parseThinkerProposal(polluted)).toThrow();
    const exotic = Object.create({ authority: "granted" }) as Record<string, unknown>;
    Object.assign(exotic, cloneProposal());
    expect(() => parseThinkerProposal(exotic)).toThrow();
  });

  it("rejects malformed enums, ids, digests, counts, text, and versions", () => {
    const cases: Record<string, unknown>[] = [];
    const wrongVersion = cloneProposal();
    wrongVersion["schemaVersion"] = 2;
    cases.push(wrongVersion);
    const wrongStatus = cloneProposal();
    wrongStatus["status"] = "approved";
    cases.push(wrongStatus);
    const badId = cloneProposal();
    tasks(badId)[0]!["proposalId"] = "bad id";
    cases.push(badId);
    const badDigest = cloneProposal();
    (tasks(badDigest)[0]!["evidence"] as Array<Record<string, unknown>>)[0]!["digest"] = "bad";
    cases.push(badDigest);
    const tooLong = cloneProposal();
    tooLong["objective"] = "x".repeat(4_001);
    cases.push(tooLong);
    const tooMany = cloneProposal();
    tooMany["tasks"] = Array.from({ length: 33 }, (_, index) => ({
      ...tasks(cloneProposal())[0],
      proposalId: `task-${index}`
    }));
    cases.push(tooMany);
    for (const value of cases) expect(() => parseThinkerProposal(value)).toThrow();
  });

  it("makes object-key and graph-list permutations fingerprint-identical", () => {
    const first = cloneProposal();
    const firstTask = tasks(first)[0]!;
    const secondTask = jsonClone(firstTask);
    secondTask["proposalId"] = "proposal-2";
    secondTask["dependencies"] = ["proposal-1"];
    first["tasks"] = [secondTask, firstTask];
    const reordered = {
      tasks: [
        { ...firstTask },
        {
          classification: secondTask["classification"],
          risk: secondTask["risk"],
          editScope: secondTask["editScope"],
          capabilities: [...(secondTask["capabilities"] as string[])].reverse(),
          reasoning: secondTask["reasoning"],
          complexity: secondTask["complexity"],
          unsupportedAssumptions: secondTask["unsupportedAssumptions"],
          evidence: secondTask["evidence"],
          acceptanceCriteria: secondTask["acceptanceCriteria"],
          dependencies: secondTask["dependencies"],
          description: secondTask["description"],
          title: secondTask["title"],
          kind: secondTask["kind"],
          proposalId: secondTask["proposalId"]
        }
      ],
      completionCriteria: first["completionCriteria"],
      openQuestions: first["openQuestions"],
      risks: first["risks"],
      assumptions: first["assumptions"],
      objective: first["objective"],
      status: first["status"],
      schemaVersion: first["schemaVersion"]
    };
    expect(thinkerPlanFingerprint(first)).toBe(thinkerPlanFingerprint(reordered));
  });
});

describe("thinker plan validation", () => {
  it("accepts exact evidence and the trusted authority ceiling", () => {
    const result = validate(thinkerProposalFixture());
    expect(result.valid).toBe(true);
    if (result.valid) expect(Object.isFrozen(result.proposal.tasks[0])).toBe(true);
  });

  it("returns one body-free malformed-proposal violation", () => {
    const result = validate({ authority: "approved" });
    expect(result).toEqual({
      valid: false,
      proposal: null,
      violations: [
        { code: "MALFORMED_PROPOSAL", category: "structure", path: "thinkerProposal" }
      ]
    });
  });

  it.each([
    ["duplicate task id", "DUPLICATE_TASK_ID", (value: Record<string, unknown>) => {
      const duplicate = jsonClone(tasks(value)[0]!);
      value["tasks"] = [tasks(value)[0], duplicate];
    }],
    ["unknown dependency", "UNKNOWN_DEPENDENCY", (value: Record<string, unknown>) => {
      tasks(value)[0]!["dependencies"] = ["absent-task"];
    }],
    ["self dependency", "SELF_DEPENDENCY", (value: Record<string, unknown>) => {
      tasks(value)[0]!["dependencies"] = ["proposal-1"];
    }],
    ["duplicate edge", "DUPLICATE_DEPENDENCY", (value: Record<string, unknown>) => {
      const second = jsonClone(tasks(value)[0]!);
      second["proposalId"] = "proposal-2";
      second["dependencies"] = ["proposal-1", "proposal-1"];
      value["tasks"] = [tasks(value)[0], second];
    }],
    ["cycle", "CYCLIC_DEPENDENCY", (value: Record<string, unknown>) => {
      const second = jsonClone(tasks(value)[0]!);
      second["proposalId"] = "proposal-2";
      second["dependencies"] = ["proposal-1"];
      tasks(value)[0]!["dependencies"] = ["proposal-2"];
      value["tasks"] = [tasks(value)[0], second];
    }]
  ])("rejects %s", (_name, expectedCode, mutate) => {
    const value = cloneProposal();
    mutate(value);
    const result = validate(value);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.violations.map((item) => item.code)).toContain(expectedCode);
  });

  it("rejects fabricated and duplicate evidence references", () => {
    const value = cloneProposal();
    const reference = (tasks(value)[0]!["evidence"] as Array<Record<string, unknown>>)[0]!;
    reference["digest"] = "f".repeat(64);
    (tasks(value)[0]!["evidence"] as Array<Record<string, unknown>>).push(jsonClone(reference));
    const result = validate(value);
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(result.violations.map((item) => item.code)).toEqual(
        expect.arrayContaining(["FABRICATED_EVIDENCE", "DUPLICATE_EVIDENCE"])
      );
  });

  it.each([
    ["kind", "shell", "TASK_KIND_OUTSIDE_AUTHORITY"],
    ["capabilities", ["reasoning", "shell"], "CAPABILITY_OUTSIDE_AUTHORITY"],
    ["capabilities", ["reasoning", "reasoning"], "DUPLICATE_CAPABILITY"],
    ["editScope", "cross-package", "EDIT_SCOPE_OUTSIDE_AUTHORITY"],
    ["editScope", "single-file", "EDIT_SCOPE_CAPABILITY_MISMATCH"],
    ["risk", "low", "RISK_UNDERSTATED"],
    ["classification", "public", "CLASSIFICATION_LOWERED"],
    ["reasoning", "extreme", "REASONING_OUTSIDE_AUTHORITY"]
  ])("rejects authority violation in %s", (field, replacement, expectedCode) => {
    const value = cloneProposal();
    tasks(value)[0]![field] = replacement;
    if (field === "editScope" && replacement === "cross-package")
      tasks(value)[0]!["capabilities"] = ["reasoning", "code-edit"];
    const compilation = jsonClone(promptCompilationRequestFixture());
    (compilation.authority as unknown as Record<string, unknown>)["permittedTaskKinds"] = ["plan"];
    const result = validate(value, compilation as unknown as PromptCompilationRequest);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.violations.map((item) => item.code)).toContain(expectedCode);
  });

  it("intersects runtime and authority count/text bounds without clamping", () => {
    const value = cloneProposal();
    const configuration = {
      ...DEFAULT_THINKER_CONFIGURATION,
      maxTasks: 0,
      maxAssumptions: 0,
      maxRisks: 0,
      maxCompletionCriteria: 0,
      maxCriteriaPerTask: 0,
      maxEvidencePerTask: 0,
      maxTextLength: 40,
      maxTitleLength: 20,
      maxObjectiveLength: 20
    };
    const result = validateThinkerPlan(value, promptCompilationRequestFixture(), configuration);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const codes = result.violations.map((item) => item.code);
      expect(codes).toContain("TASK_LIMIT_EXCEEDED");
      expect(codes).toContain("LIST_LIMIT_EXCEEDED");
      expect(codes).toContain("TEXT_LIMIT_EXCEEDED");
    }
  });
});
