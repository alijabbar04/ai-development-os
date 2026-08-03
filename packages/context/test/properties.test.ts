/**
 * Property tests for selection: order independence and budget invariants over a
 * bounded, seeded generator. The seed appears in every case name and every
 * assertion message, so a failure is replayable from the report alone.
 */

import { describe, expect, it } from "vitest";
import { conservativeUnitEstimator } from "../src/estimator.js";
import type { ContextResult } from "../src/errors.js";
import {
  CONTEXT_CATEGORIES,
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_CONTEXT_CONFIGURATION,
  withContextOverrides,
  type ContextCandidate,
  type ContextCategory,
} from "../src/model.js";
import { planContextPack } from "../src/select.js";
import { candidate } from "../src/testing/fixtures.js";

const SEEDS = Object.freeze([3, 11, 58, 719, 65_521]);

function createRandom(seed: number): () => number {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function unwrap<T>(result: ContextResult<T>, seed: number): T {
  if (!result.ok) {
    throw new Error(`seed ${seed}: expected success, got ${result.failure.code}`);
  }
  return result.value;
}

const SOURCE_FOR_CATEGORY: Readonly<Record<ContextCategory, ContextCandidate["sourceKind"]>> =
  Object.freeze({
    task: "task-description",
    constraint: "memory-record",
    repository: "repository-file",
    memory: "memory-record",
    artifact: "artifact-excerpt",
  });

function randomCandidates(random: () => number, count: number): readonly ContextCandidate[] {
  const result: ContextCandidate[] = [];
  for (let index = 0; index < count; index += 1) {
    const category = CONTEXT_CATEGORIES[Math.floor(random() * CONTEXT_CATEGORIES.length)] ?? "repository";
    const length = 8 + Math.floor(random() * 900);
    // Bodies are distinct so deduplication does not silently absorb items,
    // except for the deliberate duplicate injected below.
    const body = `${index}:${"abcdefghij"[index % 10] ?? "x"}`.repeat(Math.max(1, Math.floor(length / 4)));
    result.push(
      candidate({
        identity: `${category}:item-${String(index).padStart(3, "0")}`,
        sourceKind: SOURCE_FOR_CATEGORY[category],
        category,
        body,
        baseScore: Math.floor(random() * 10_000),
      }),
    );
  }
  // One duplicate body, to keep the dedup path exercised across seeds.
  const first = result[0];
  if (first !== undefined) {
    result.push(candidate({ ...first, identity: "repository:duplicate", body: first.body }));
  }
  return Object.freeze(result);
}

function permute<T>(items: readonly T[], random: () => number): readonly T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const left = copy[index];
    const right = copy[swap];
    if (left !== undefined && right !== undefined) {
      copy[index] = right;
      copy[swap] = left;
    }
  }
  return Object.freeze(copy);
}

describe.each(SEEDS)("selection properties (seed %i)", (seed) => {
  it("is invariant under input permutation and respects every budget", () => {
    const random = createRandom(seed);
    const candidates = randomCandidates(random, 20);
    const configuration = unwrap(
      withContextOverrides(DEFAULT_CONTEXT_CONFIGURATION, {
        budget: {
          ...DEFAULT_CONTEXT_BUDGET,
          maxTotalBytes: 2_000 + Math.floor(random() * 8_000),
          maxTotalUnits: 500 + Math.floor(random() * 4_000),
          maxItems: 4 + Math.floor(random() * 12),
          minItemBytes: 8,
          categories: {
            task: { reservedBytes: 128, maxBytes: 2_048, maxItems: 2 },
            constraint: { reservedBytes: 256, maxBytes: 4_096, maxItems: 6 },
            repository: { reservedBytes: 512, maxBytes: 8_192, maxItems: 12 },
            memory: { reservedBytes: 256, maxBytes: 4_096, maxItems: 8 },
            artifact: { reservedBytes: 0, maxBytes: 4_096, maxItems: 4 },
          },
        },
      }),
      seed,
    );
    const budget = configuration.budget;

    const reference = unwrap(
      planContextPack({ candidates, configuration, estimator: conservativeUnitEstimator }),
      seed,
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const shuffled = permute(candidates, random);
      const planned = unwrap(
        planContextPack({ candidates: shuffled, configuration, estimator: conservativeUnitEstimator }),
        seed,
      );
      expect(JSON.stringify(planned), `seed ${seed} attempt ${attempt}`).toBe(
        JSON.stringify(reference),
      );
    }

    // Budget invariants.
    expect(reference.usage.bytes, `seed ${seed}`).toBeLessThanOrEqual(budget.maxTotalBytes);
    expect(reference.usage.units, `seed ${seed}`).toBeLessThanOrEqual(budget.maxTotalUnits);
    expect(reference.items.length, `seed ${seed}`).toBeLessThanOrEqual(budget.maxItems);
    expect(
      reference.items.reduce((total, item) => total + item.byteContribution, 0),
      `seed ${seed}`,
    ).toBe(reference.usage.bytes);
    for (const category of CONTEXT_CATEGORIES) {
      expect(reference.usage.bytesByCategory[category], `seed ${seed} ${category}`).toBeLessThanOrEqual(
        budget.categories[category].maxBytes,
      );
      expect(
        reference.items.filter((item) => item.category === category).length,
        `seed ${seed} ${category}`,
      ).toBeLessThanOrEqual(budget.categories[category].maxItems);
    }
    for (const item of reference.items) {
      expect(item.byteContribution, `seed ${seed} ${item.identity}`).toBeLessThanOrEqual(
        budget.maxItemBytes,
      );
      expect(item.byteContribution, `seed ${seed} ${item.identity}`).toBe(
        Buffer.byteLength(item.body, "utf8"),
      );
      expect(item.trust, `seed ${seed}`).toBe("untrusted");
    }

    // Ordinals are 1..n in pack order, and every candidate is either packed or
    // explained — nothing disappears silently.
    expect(reference.items.map((item) => item.ordinal), `seed ${seed}`).toEqual(
      reference.items.map((_item, position) => position + 1),
    );
    const accounted = new Set([
      ...reference.items.map((item) => item.identity),
      ...reference.omissions.map((item) => item.identity),
    ]);
    if (!reference.omissionsTruncated) {
      for (const item of candidates) {
        expect(accounted.has(item.identity), `seed ${seed} ${item.identity}`).toBe(true);
      }
    }

    // Digests are unique in the pack: deduplication is total.
    const digests = reference.items.map((item) => item.digest);
    expect(new Set(digests).size, `seed ${seed}`).toBe(digests.length);
  });
});
