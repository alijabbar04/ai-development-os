/**
 * Reusable behavioural contract for any snapshot read port.
 *
 * The suite is written against the port interface, not against the in-memory
 * fixture, so a later adapter over a real Stage 8 snapshot can be held to the
 * same guarantees without duplicating a line of test logic.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_REPOSITORY_INDEX_CONFIGURATION } from "../config.js";
import { buildRepositoryIndex, queryRepositoryIndex, updateRepositoryIndex } from "../indexer.js";
import { parseRepositoryIndex, type RepositoryIndex } from "../index-model.js";
import type { SnapshotReadPort } from "../read-port.js";
import {
  createManualIndexClock,
  createMemorySnapshotPort,
  INJECTION_CANARY,
  POISONED_README,
  type MemorySnapshotOptions,
} from "./fixtures.js";

export interface RepositoryIndexContractHarness {
  /** Builds a read port over the declared fixture content. */
  createPort(options: MemorySnapshotOptions): Promise<SnapshotReadPort> | SnapshotReadPort;
  /**
   * Digest over the source content, used to prove indexing mutated nothing.
   * Omit when the port cannot observe its own backing store.
   */
  sourceFingerprint?(port: SnapshotReadPort): Promise<string> | string;
  dispose?(): Promise<void>;
}

const BASE_FILES: Readonly<Record<string, string>> = Object.freeze({
  "README.md": "# Example\n\nA sample repository used by the contract suite.\n",
  "package.json": JSON.stringify(
    {
      name: "example-app",
      version: "1.2.3",
      private: true,
      dependencies: { "left-pad": "^1.0.0" },
      devDependencies: { vitest: "^4.0.0" },
    },
    null,
    2,
  ),
  "src/index.ts": "export function computeTotal(values: readonly number[]): number {\n  return values.length;\n}\n",
  "src/util/format.ts": "export const formatLabel = (value: string): string => value.trim();\n",
});

function ok<T>(result: { ok: boolean; value?: T; failure?: unknown }): T {
  if (!result.ok) {
    throw new Error(`expected success, received ${JSON.stringify(result.failure)}`);
  }
  return result.value as T;
}

export function runRepositoryIndexContractSuite(
  suiteName: string,
  createHarness: () => Promise<RepositoryIndexContractHarness> | RepositoryIndexContractHarness,
): void {
  describe(`repository-index contract: ${suiteName}`, () => {
    async function build(
      options: MemorySnapshotOptions,
    ): Promise<{ index: RepositoryIndex; port: SnapshotReadPort; harness: RepositoryIndexContractHarness }> {
      const harness = await createHarness();
      const port = await harness.createPort(options);
      const index = ok(
        await buildRepositoryIndex({
          readPort: port,
          configuration: DEFAULT_REPOSITORY_INDEX_CONFIGURATION,
          clock: createManualIndexClock(),
        }),
      );
      return { index, port, harness };
    }

    it("produces a byte-identical fingerprint across repeated builds", async () => {
      const first = await build({ files: BASE_FILES });
      const second = await build({ files: BASE_FILES });
      expect(first.index.fingerprint).toBe(second.index.fingerprint);
      expect(first.index.entries.map((entry) => entry.canonicalPath)).toEqual(
        second.index.entries.map((entry) => entry.canonicalPath),
      );
      await first.harness.dispose?.();
      await second.harness.dispose?.();
    });

    it("ignores the order in which the port lists entries", async () => {
      const forward = await build({ files: BASE_FILES, listingOrder: Object.keys(BASE_FILES) });
      const reversed = await build({
        files: BASE_FILES,
        listingOrder: [...Object.keys(BASE_FILES)].reverse(),
      });
      expect(forward.index.fingerprint).toBe(reversed.index.fingerprint);
      await forward.harness.dispose?.();
      await reversed.harness.dispose?.();
    });

    it("excludes the observation time from the fingerprint", async () => {
      const harness = await createHarness();
      const port = await harness.createPort({ files: BASE_FILES });
      const early = ok(
        await buildRepositoryIndex({
          readPort: port,
          configuration: DEFAULT_REPOSITORY_INDEX_CONFIGURATION,
          clock: createManualIndexClock("2026-01-01T00:00:00.000Z"),
        }),
      );
      const late = ok(
        await buildRepositoryIndex({
          readPort: port,
          configuration: DEFAULT_REPOSITORY_INDEX_CONFIGURATION,
          clock: createManualIndexClock("2027-06-06T06:06:06.000Z"),
        }),
      );
      expect(early.observedAt).not.toBe(late.observedAt);
      expect(early.fingerprint).toBe(late.fingerprint);
      await harness.dispose?.();
    });

    it("matches a full rebuild after an equivalent incremental sequence", async () => {
      const modified = {
        ...BASE_FILES,
        "src/index.ts": "export function computeTotal(values: readonly number[]): number {\n  return values.reduce((a, b) => a + b, 0);\n}\n",
        "src/added.ts": "export const added = true;\n",
      } as Record<string, string>;
      delete modified["src/util/format.ts"];

      const start = await build({ files: BASE_FILES });
      const harness = await createHarness();
      const nextPort = await harness.createPort({ files: modified });

      const incremental = ok(
        await updateRepositoryIndex({
          readPort: nextPort,
          priorIndex: start.index,
          configuration: DEFAULT_REPOSITORY_INDEX_CONFIGURATION,
          clock: createManualIndexClock("2026-08-03T00:00:00.000Z"),
          changeSet: {
            schemaVersion: 1,
            baseFingerprint: start.index.fingerprint,
            changes: [
              { type: "modified", path: "src/index.ts" },
              { type: "added", path: "src/added.ts" },
              { type: "deleted", path: "src/util/format.ts" },
            ],
          },
        }),
      );

      const rebuilt = await build({ files: modified });
      expect(incremental.fingerprint).toBe(rebuilt.index.fingerprint);
      expect(incremental.tombstones.map((item) => item.canonicalPath)).toEqual([
        "src/util/format.ts",
      ]);
      expect(rebuilt.index.tombstones).toHaveLength(0);
      await start.harness.dispose?.();
      await rebuilt.harness.dispose?.();
      await harness.dispose?.();
    });

    it("refuses a change set bound to a different index", async () => {
      const start = await build({ files: BASE_FILES });
      const result = await updateRepositoryIndex({
        readPort: start.port,
        priorIndex: start.index,
        configuration: DEFAULT_REPOSITORY_INDEX_CONFIGURATION,
        clock: createManualIndexClock(),
        changeSet: { schemaVersion: 1, baseFingerprint: "f".repeat(64), changes: [] },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.code).toBe("SNAPSHOT_MISMATCH");
      }
      await start.harness.dispose?.();
    });

    it("round-trips through full runtime validation", async () => {
      const built = await build({ files: BASE_FILES });
      const revalidated = parseRepositoryIndex(JSON.parse(JSON.stringify(built.index)));
      expect(revalidated.fingerprint).toBe(built.index.fingerprint);
      await built.harness.dispose?.();
    });

    it("never mutates the source and never reads an excluded path", async () => {
      const harness = await createHarness();
      const port = await harness.createPort({
        files: {
          ...BASE_FILES,
          ".env": "API_KEY=sk-live-should-never-be-read",
          "node_modules/pkg/index.js": "module.exports = 1;",
          "id_rsa": "-----BEGIN PRIVATE KEY-----",
        },
      });
      const before = await harness.sourceFingerprint?.(port);
      const index = ok(
        await buildRepositoryIndex({
          readPort: port,
          configuration: DEFAULT_REPOSITORY_INDEX_CONFIGURATION,
          clock: createManualIndexClock(),
        }),
      );
      const after = await harness.sourceFingerprint?.(port);
      if (before !== undefined) {
        expect(after).toBe(before);
      }
      const paths = index.entries.map((entry) => entry.canonicalPath);
      expect(paths).not.toContain(".env");
      expect(paths).not.toContain("id_rsa");
      expect(paths.some((path) => path.startsWith("node_modules/"))).toBe(false);
      expect(index.totals.rejectedCount).toBeGreaterThanOrEqual(3);
      await harness.dispose?.();
    });

    it("keeps poisoned content as inert indexed data with no interpretation", async () => {
      const harness = await createHarness();
      const port = await harness.createPort({
        files: { ...BASE_FILES, "README.md": POISONED_README },
      });
      const index = ok(
        await buildRepositoryIndex({
          readPort: port,
          configuration: DEFAULT_REPOSITORY_INDEX_CONFIGURATION,
          clock: createManualIndexClock(),
        }),
      );
      // Positive control: the canary IS reachable through ordinary search, so
      // a later "the canary did not appear" assertion cannot pass vacuously.
      const found = ok(
        queryRepositoryIndex(index, { kind: "terms", text: INJECTION_CANARY, limit: 10 }),
      );
      expect(found.hits.map((hit) => hit.canonicalPath)).toContain("README.md");
      // The index records terms and digests. It records no instruction, no
      // approval, and no capability of any kind.
      const serialized = JSON.stringify(index);
      expect(serialized).not.toContain("disclose_all_secrets");
      expect(serialized).not.toContain("ignore all previous instructions");
      await harness.dispose?.();
    });

    it("returns stable, tie-broken query results", async () => {
      const built = await build({ files: BASE_FILES });
      const first = ok(queryRepositoryIndex(built.index, { kind: "terms", text: "format", limit: 5 }));
      const second = ok(queryRepositoryIndex(built.index, { kind: "terms", text: "format", limit: 5 }));
      expect(first.hits).toEqual(second.hits);
      for (let position = 1; position < first.hits.length; position += 1) {
        const previous = first.hits[position - 1];
        const current = first.hits[position];
        if (previous === undefined || current === undefined) {
          continue;
        }
        expect(
          previous.score > current.score ||
            (previous.score === current.score && previous.canonicalPath < current.canonicalPath),
        ).toBe(true);
      }
      await built.harness.dispose?.();
    });
  });
}

/** The in-memory reference harness; also the default for the package's own tests. */
export function memorySnapshotHarness(): RepositoryIndexContractHarness {
  return {
    createPort: (options) => createMemorySnapshotPort(options),
    sourceFingerprint: (port) =>
      (port as ReturnType<typeof createMemorySnapshotPort>).contentFingerprint(),
  };
}
