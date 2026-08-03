/**
 * Property tests over a bounded, seeded generator.
 *
 * The seed is part of the case name, so a failure names the exact input that
 * produced it and can be replayed without a recorded corpus. Randomness comes
 * from a deterministic PRNG, never from `Math.random`, so a green run today
 * means the same thing tomorrow.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_REPOSITORY_INDEX_CONFIGURATION } from "../src/config.js";
import { buildRepositoryIndex, updateRepositoryIndex } from "../src/indexer.js";
import { canonicalizeRepositoryPath, comparePaths } from "../src/paths.js";
import { parseRepositoryIndex, type RepositoryIndex } from "../src/index-model.js";
import type { RepositoryIndexResult } from "../src/errors.js";
import type { FilesystemSemantics } from "../src/read-port.js";
import { createManualIndexClock, createMemorySnapshotPort } from "../src/testing/fixtures.js";

const SEEDS = Object.freeze([1, 7, 42, 1_337, 90_210]);

/** A 32-bit xorshift generator: tiny, deterministic, and adequate here. */
function createRandom(seed: number): () => number {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function unwrap<T>(result: RepositoryIndexResult<T>, seed: number): T {
  if (!result.ok) {
    throw new Error(`seed ${seed}: expected success, got ${result.failure.code}`);
  }
  return result.value;
}

const SEGMENTS = Object.freeze([
  "src",
  "test",
  "lib",
  "a",
  "b",
  "index",
  "util",
  "README",
  "café",
  "Deep",
]);
const EXTENSIONS = Object.freeze([".ts", ".md", ".json", ".txt", ""]);

function randomPath(random: () => number): string {
  const depth = 1 + Math.floor(random() * 3);
  const parts: string[] = [];
  for (let index = 0; index < depth; index += 1) {
    parts.push(SEGMENTS[Math.floor(random() * SEGMENTS.length)] ?? "a");
  }
  return `${parts.join("/")}${EXTENSIONS[Math.floor(random() * EXTENSIONS.length)] ?? ""}`;
}

const SEMANTICS: readonly FilesystemSemantics[] = Object.freeze([
  Object.freeze({ caseSensitivity: "case-sensitive" as const, unicodeForm: "nfc" as const }),
  Object.freeze({ caseSensitivity: "case-insensitive" as const, unicodeForm: "nfc" as const }),
  Object.freeze({ caseSensitivity: "case-sensitive" as const, unicodeForm: "preserve" as const }),
]);

describe.each(SEEDS)("path canonicalization properties (seed %i)", (seed) => {
  it("is idempotent and order-preserving, and never produces an unsafe path", () => {
    const random = createRandom(seed);
    const accepted: string[] = [];
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const semantics = SEMANTICS[Math.floor(random() * SEMANTICS.length)] ?? SEMANTICS[0];
      if (semantics === undefined) {
        continue;
      }
      const raw = randomPath(random);
      const first = canonicalizeRepositoryPath(raw, semantics);
      if (!first.ok) {
        continue;
      }
      // Idempotence: canonicalizing a canonical path changes nothing.
      const second = canonicalizeRepositoryPath(first.canonicalPath, semantics);
      expect(second.ok, `seed ${seed}`).toBe(true);
      if (second.ok) {
        expect(second.canonicalPath, `seed ${seed}`).toBe(first.canonicalPath);
        expect(second.collisionKey, `seed ${seed}`).toBe(first.collisionKey);
      }
      // A canonical path can never contain a traversal, a separator run, or a
      // backslash, whatever the input was.
      expect(first.canonicalPath.includes("//"), `seed ${seed}`).toBe(false);
      expect(first.canonicalPath.includes("\\"), `seed ${seed}`).toBe(false);
      expect(first.canonicalPath.split("/").includes(".."), `seed ${seed}`).toBe(false);
      accepted.push(first.canonicalPath);
    }
    // Sorting is a total order: comparePaths never reports two distinct paths
    // as equal, and is antisymmetric.
    const unique = [...new Set(accepted)];
    for (const left of unique.slice(0, 20)) {
      for (const right of unique.slice(0, 20)) {
        const forward = comparePaths(left, right);
        const backward = comparePaths(right, left);
        // Summed rather than negated so the equal case compares 0 with 0
        // instead of +0 with -0.
        expect(Math.sign(forward) + Math.sign(backward), `seed ${seed}`).toBe(0);
        if (left !== right) {
          expect(forward, `seed ${seed}`).not.toBe(0);
        }
      }
    }
  });
});

describe.each(SEEDS)("incremental reconciliation properties (seed %i)", (seed) => {
  it("converges on the same fingerprint as a full rebuild", async () => {
    const random = createRandom(seed);
    const initial: Record<string, string> = {};
    for (let index = 0; index < 8; index += 1) {
      initial[`src/f${index}.ts`] = `export const v${index} = ${Math.floor(random() * 100)};\n`;
    }

    let index: RepositoryIndex = unwrap(
      await buildRepositoryIndex({
        readPort: createMemorySnapshotPort({ files: initial }),
        configuration: DEFAULT_REPOSITORY_INDEX_CONFIGURATION,
        clock: createManualIndexClock(),
      }),
      seed,
    );

    let files: Record<string, string> = { ...initial };
    for (let round = 0; round < 4; round += 1) {
      const next: Record<string, string> = { ...files };
      const changes: { type: string; path: string; fromPath?: string }[] = [];
      const paths = Object.keys(files).sort();
      const choice = Math.floor(random() * 3);
      const victim = paths[Math.floor(random() * paths.length)];
      if (choice === 0) {
        const added = `src/added-${round}.ts`;
        next[added] = `export const added${round} = ${Math.floor(random() * 100)};\n`;
        changes.push({ type: "added", path: added });
      } else if (choice === 1 && victim !== undefined) {
        next[victim] = `export const changed = ${Math.floor(random() * 1_000)};\n`;
        changes.push({ type: "modified", path: victim });
      } else if (victim !== undefined && paths.length > 1) {
        delete next[victim];
        changes.push({ type: "deleted", path: victim });
      }
      if (changes.length === 0) {
        continue;
      }
      files = next;
      index = unwrap(
        await updateRepositoryIndex({
          readPort: createMemorySnapshotPort({ files }),
          priorIndex: index,
          changeSet: { schemaVersion: 1, baseFingerprint: index.fingerprint, changes },
          configuration: DEFAULT_REPOSITORY_INDEX_CONFIGURATION,
          clock: createManualIndexClock(),
        }),
        seed,
      );
    }

    const rebuilt = unwrap(
      await buildRepositoryIndex({
        readPort: createMemorySnapshotPort({ files }),
        configuration: DEFAULT_REPOSITORY_INDEX_CONFIGURATION,
        clock: createManualIndexClock(),
      }),
      seed,
    );
    expect(index.totals.limitsExhausted, `seed ${seed}`).toBe(false);
    expect(index.fingerprint, `seed ${seed}`).toBe(rebuilt.fingerprint);
    // And the accumulated index still validates from scratch.
    expect(
      parseRepositoryIndex(JSON.parse(JSON.stringify(index))).fingerprint,
      `seed ${seed}`,
    ).toBe(index.fingerprint);
  });
});
