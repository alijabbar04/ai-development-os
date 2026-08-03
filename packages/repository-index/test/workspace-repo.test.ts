/**
 * Whole-repository behaviour on a shape the real project actually has: a
 * workspace root with a lockfile, several member manifests, exclusions, and a
 * sequence of updates that accumulates tombstones. These are the paths a
 * single-file fixture never reaches — multi-manifest ordering, lockfile
 * resolution recorded alongside declarations, and a serialized index carrying
 * history.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_REPOSITORY_INDEX_CONFIGURATION } from "../src/config.js";
import { buildRepositoryIndex, tombstoneFingerprint, updateRepositoryIndex } from "../src/indexer.js";
import { parseRepositoryIndex, type RepositoryIndex } from "../src/index-model.js";
import type { RepositoryIndexResult } from "../src/errors.js";
import { createManualIndexClock, createMemorySnapshotPort } from "../src/testing/fixtures.js";

const CONFIG = DEFAULT_REPOSITORY_INDEX_CONFIGURATION;

function unwrap<T>(result: RepositoryIndexResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected success: ${result.failure.code}`);
  }
  return result.value;
}

const WORKSPACE_FILES: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "root",
    version: "0.0.0",
    private: true,
    workspaces: ["packages/*"],
    devDependencies: { vitest: "^4.0.0" },
  }),
  "package-lock.json": JSON.stringify({
    name: "root",
    lockfileVersion: 3,
    packages: {
      "": { name: "root", version: "0.0.0" },
      "node_modules/vitest": { version: "4.1.10" },
      "packages/alpha": { name: "@scope/alpha", version: "0.1.0" },
    },
  }),
  "packages/alpha/package.json": JSON.stringify({
    name: "@scope/alpha",
    version: "0.1.0",
    dependencies: { "left-pad": "^1.3.0" },
  }),
  "packages/beta/package.json": JSON.stringify({
    name: "@scope/beta",
    version: "0.2.0",
    // Two independent problems in one manifest: an unusable identity and a
    // non-scalar specifier. Both must be reported, and the report must sort.
    dependencies: { "Not A Name": "^1.0.0", gamma: { git: "ssh://example" } },
  }),
  "packages/alpha/src/index.ts": "export const alpha = 1;\n",
  "packages/beta/src/index.ts": "export const beta = 2;\n",
  ".env": "TOKEN=should-never-be-indexed",
  "dist/bundle.js": "console.log(1);",
};

async function build(files: Record<string, string>): Promise<RepositoryIndex> {
  return unwrap(
    await buildRepositoryIndex({
      readPort: createMemorySnapshotPort({ files }),
      configuration: CONFIG,
      clock: createManualIndexClock(),
    }),
  );
}

describe("workspace repository", () => {
  it("keeps manifest, lockfile, and workspace facts distinguishable", async () => {
    const index = await build(WORKSPACE_FILES);

    expect(index.manifests.map((item) => item.path)).toEqual([
      "package-lock.json",
      "package.json",
      "packages/alpha/package.json",
      "packages/beta/package.json",
    ]);
    expect(index.manifests.find((item) => item.path === "package.json")?.workspacePatterns).toEqual([
      "packages/*",
    ]);

    const vitestFacts = index.dependencies.filter((item) => item.name === "vitest");
    expect(vitestFacts.map((item) => [item.manifestPath, item.kind, item.declaredRange, item.resolvedVersion])).toEqual([
      ["package-lock.json", "recorded", null, "4.1.10"],
      ["package.json", "development", "^4.0.0", null],
    ]);

    const member = index.dependencies.find((item) => item.kind === "workspace");
    expect(member?.name).toBe("@scope/alpha");
    expect(member?.source).toBe("workspace-member");

    // Every extracted fact names the digest it came from.
    const manifestDigest = index.entries.find((entry) => entry.canonicalPath === "package.json")
      ?.contentDigest?.hex;
    expect(
      index.dependencies
        .filter((item) => item.manifestPath === "package.json")
        .every((item) => item.sourceDigestHex === manifestDigest),
    ).toBe(true);
  });

  it("reports several problems in one manifest in a stable order", async () => {
    const index = await build(WORKSPACE_FILES);
    const beta = index.manifests.find((item) => item.path === "packages/beta/package.json");
    expect(beta?.status).toBe("partial");
    const codes = beta?.diagnostics.map((item) => item.code) ?? [];
    expect(codes).toEqual([...codes].sort());
    expect(codes).toContain("manifest-dynamic-construct");
    expect(codes).toContain("manifest-partial");
  });

  it("excludes credential-shaped and build-output paths without reading them", async () => {
    const port = createMemorySnapshotPort({ files: WORKSPACE_FILES });
    unwrap(
      await buildRepositoryIndex({ readPort: port, configuration: CONFIG, clock: createManualIndexClock() }),
    );
    expect(port.reads).not.toContain(".env");
    expect(port.reads.some((path) => path.startsWith("dist/"))).toBe(false);
  });

  it("accumulates tombstones across a sequence and round-trips them", async () => {
    const clock = createManualIndexClock();
    let index = await build(WORKSPACE_FILES);

    const afterFirst = { ...WORKSPACE_FILES };
    delete afterFirst["packages/beta/src/index.ts"];
    clock.set("2026-08-03T00:00:00.000Z");
    index = unwrap(
      await updateRepositoryIndex({
        readPort: createMemorySnapshotPort({ files: afterFirst }),
        priorIndex: index,
        configuration: CONFIG,
        clock,
        changeSet: {
          schemaVersion: 1,
          baseFingerprint: index.fingerprint,
          changes: [{ type: "deleted", path: "packages/beta/src/index.ts" }],
        },
      }),
    );

    const afterSecond = { ...afterFirst };
    delete afterSecond["packages/beta/package.json"];
    clock.advance(3_600_000);
    index = unwrap(
      await updateRepositoryIndex({
        readPort: createMemorySnapshotPort({ files: afterSecond }),
        priorIndex: index,
        configuration: CONFIG,
        clock,
        changeSet: {
          schemaVersion: 1,
          baseFingerprint: index.fingerprint,
          changes: [{ type: "deleted", path: "packages/beta/package.json" }],
        },
      }),
    );

    expect(index.tombstones.map((item) => item.canonicalPath)).toEqual([
      "packages/beta/package.json",
      "packages/beta/src/index.ts",
    ]);
    expect(index.tombstones.every((item) => item.previousContentDigestHex !== null)).toBe(true);
    expect(index.manifests.map((item) => item.path)).not.toContain("packages/beta/package.json");
    expect(index.dependencies.some((item) => item.manifestPath.startsWith("packages/beta"))).toBe(
      false,
    );

    const revalidated = parseRepositoryIndex(JSON.parse(JSON.stringify(index)));
    expect(revalidated.tombstones).toEqual(index.tombstones);
    expect(revalidated.rejections).toEqual(index.rejections);
    expect(tombstoneFingerprint(revalidated)).toBe(tombstoneFingerprint(index));

    const rebuilt = await build(afterSecond);
    expect(index.fingerprint).toBe(rebuilt.fingerprint);
  });

  it("keeps a manual clock's set and advance independent of the fingerprint", async () => {
    const clock = createManualIndexClock();
    const port = createMemorySnapshotPort({ files: WORKSPACE_FILES });
    const first = unwrap(
      await buildRepositoryIndex({ readPort: port, configuration: CONFIG, clock }),
    );
    clock.set("2031-12-31T23:59:59.000Z");
    clock.advance(1_000);
    const second = unwrap(
      await buildRepositoryIndex({ readPort: port, configuration: CONFIG, clock }),
    );
    expect(second.observedAt).toBe("2032-01-01T00:00:00.000Z");
    expect(second.fingerprint).toBe(first.fingerprint);
  });
});
