import { describe, expect, it } from "vitest";
import {
  parseThinkerProposal,
  thinkerPlanFingerprint,
  validateThinkerPlan
} from "../src/index.js";
import {
  THINKER_OUTPUT_CANARY,
  jsonClone,
  thinkerProposalFixture
} from "../src/testing/fixtures.js";
import { promptCompilationRequestFixture } from "@ai-dev-os/prompt-compiler/testing/fixtures";

export const THINKER_PROPERTY_SEEDS = Object.freeze({
  parserAndFingerprint: 0x15c0ffee,
  dagAndAuthority: 0x15da600d,
  redaction: 0x15e22025
});

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function shuffle<T>(values: readonly T[], next: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = next() % (index + 1);
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function taskRecords(value: Record<string, unknown>): Array<Record<string, unknown>> {
  return value["tasks"] as Array<Record<string, unknown>>;
}

describe("seeded thinker properties", () => {
  it("preserves Unicode parser bounds and canonical fingerprints across key/list permutations", () => {
    const next = generator(THINKER_PROPERTY_SEEDS.parserAndFingerprint);
    const unicode = ["é", "中", "🙂", "\r\n", "\u200b", "\u202e", "\u0000"];
    for (let iteration = 0; iteration < 96; iteration += 1) {
      const proposal = jsonClone(thinkerProposalFixture()) as unknown as Record<string, unknown>;
      proposal["objective"] = Array.from(
        { length: 1 + (next() % 64) },
        () => unicode[next() % unicode.length]
      ).join("");
      const task = taskRecords(proposal)[0]!;
      task["capabilities"] = shuffle(
        task["capabilities"] as string[],
        next
      );
      const entries = shuffle(Object.entries(proposal), next);
      const permuted = Object.fromEntries(entries);
      expect(parseThinkerProposal(permuted).objective).toBe(proposal["objective"]);
      expect(thinkerPlanFingerprint(permuted)).toBe(thinkerPlanFingerprint(proposal));
    }
  });

  it("accepts generated DAGs, rejects a seeded back-edge, and rejects authority widening", () => {
    const next = generator(THINKER_PROPERTY_SEEDS.dagAndAuthority);
    const compilation = promptCompilationRequestFixture();
    for (let iteration = 0; iteration < 64; iteration += 1) {
      const proposal = jsonClone(thinkerProposalFixture()) as unknown as Record<string, unknown>;
      const base = taskRecords(proposal)[0]!;
      const count = 2 + (next() % 7);
      const generated: Record<string, unknown>[] = [];
      for (let index = 0; index < count; index += 1) {
        const task = jsonClone(base);
        task["proposalId"] = `generated-${index}`;
        task["dependencies"] = index === 0 ? [] : [`generated-${next() % index}`];
        generated.push(task);
      }
      proposal["tasks"] = shuffle(generated, next);
      expect(validateThinkerPlan(proposal, compilation).valid).toBe(true);

      const cyclic = jsonClone(proposal) as unknown as Record<string, unknown>;
      const cyclicTasks = taskRecords(cyclic);
      const first = cyclicTasks.find((task) => task["proposalId"] === "generated-0")!;
      first["dependencies"] = [`generated-${count - 1}`];
      const cycle = validateThinkerPlan(cyclic, compilation);
      expect(cycle.valid).toBe(false);
      if (!cycle.valid)
        expect(cycle.violations.map((item) => item.code)).toContain("CYCLIC_DEPENDENCY");

      const widening = jsonClone(proposal) as unknown as Record<string, unknown>;
      const chosen = taskRecords(widening)[next() % count]!;
      chosen["capabilities"] = ["reasoning", next() % 2 === 0 ? "shell" : "tool-use"];
      const rejected = validateThinkerPlan(widening, compilation);
      expect(rejected.valid).toBe(false);
      if (!rejected.valid)
        expect(rejected.violations.map((item) => item.code)).toContain(
          "CAPABILITY_OUTSIDE_AUTHORITY"
        );
    }
  });

  it("never reproduces hostile malformed values in validation results", () => {
    const next = generator(THINKER_PROPERTY_SEEDS.redaction);
    for (let iteration = 0; iteration < 64; iteration += 1) {
      const hostile = `${THINKER_OUTPUT_CANARY}-${next().toString(16)}`;
      const result = validateThinkerPlan(
        { [hostile]: { approval: "granted", secret: hostile } },
        promptCompilationRequestFixture()
      );
      expect(result.valid).toBe(false);
      expect(JSON.stringify(result)).not.toContain(hostile);
      expect(JSON.stringify(result)).not.toContain(THINKER_OUTPUT_CANARY);
    }
  });
});
