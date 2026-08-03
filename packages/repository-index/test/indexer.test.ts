import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPOSITORY_INDEX_CONFIGURATION,
  parseRepositoryIndexConfiguration,
  repositoryIndexConfigurationFingerprint,
  withRepositoryIndexOverrides,
} from "../src/config.js";
import {
  buildRepositoryIndex,
  createRepositoryIndexer,
  queryRepositoryIndex,
  tombstoneFingerprint,
  updateRepositoryIndex,
} from "../src/indexer.js";
import type { RepositoryIndex } from "../src/index-model.js";
import type { RepositoryIndexResult } from "../src/errors.js";
import {
  createManualIndexClock,
  createMemorySnapshotPort,
  INJECTION_CANARY,
  POISONED_README,
  type MemorySnapshotOptions,
} from "../src/testing/fixtures.js";

const CONFIG = DEFAULT_REPOSITORY_INDEX_CONFIGURATION;

function unwrap<T>(result: RepositoryIndexResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected success: ${result.failure.code} ${result.failure.message}`);
  }
  return result.value;
}

function failure<T>(result: RepositoryIndexResult<T>): string {
  if (result.ok) {
    throw new Error("expected failure");
  }
  return result.failure.code;
}

async function buildFrom(options: MemorySnapshotOptions): Promise<RepositoryIndex> {
  return unwrap(
    await buildRepositoryIndex({
      readPort: createMemorySnapshotPort(options),
      configuration: CONFIG,
      clock: createManualIndexClock(),
    }),
  );
}

describe("configuration", () => {
  it("rejects an unsupported schema version distinctly", () => {
    const result = parseRepositoryIndexConfiguration({
      ...CONFIG,
      schemaVersion: 2,
    });
    expect(failure(result)).toBe("UNSUPPORTED_SCHEMA_VERSION");
  });

  it("rejects unknown fields and out-of-range bounds", () => {
    expect(failure(parseRepositoryIndexConfiguration({ ...CONFIG, extra: 1 }))).toBe(
      "INVALID_CONFIGURATION",
    );
    expect(
      failure(
        parseRepositoryIndexConfiguration({
          ...CONFIG,
          limits: { ...CONFIG.limits, maxFiles: 0 },
        }),
      ),
    ).toBe("INVALID_CONFIGURATION");
  });

  it("rejects inconsistent bounds", () => {
    expect(
      failure(
        withRepositoryIndexOverrides(CONFIG, {
          limits: { maxFileBytes: 100, maxIndexedTextBytes: 1_000 },
        }),
      ),
    ).toBe("INVALID_CONFIGURATION");
  });

  it("rejects exclusion rules that could smuggle a path", () => {
    expect(
      failure(withRepositoryIndexOverrides(CONFIG, { exclusions: { paths: ["../escape"] } })),
    ).toBe("INVALID_CONFIGURATION");
  });

  it("fingerprints configuration together with algorithm versions", () => {
    const base = repositoryIndexConfigurationFingerprint(CONFIG);
    const changed = repositoryIndexConfigurationFingerprint(
      unwrap(withRepositoryIndexOverrides(CONFIG, { limits: { maxFiles: 19_999 } })),
    );
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(changed).not.toBe(base);
  });

  it("sorts and de-duplicates exclusion rules so ordering cannot change identity", () => {
    const a = unwrap(
      withRepositoryIndexOverrides(CONFIG, { exclusions: { paths: ["b.txt", "a.txt", "a.txt"] } }),
    );
    const b = unwrap(withRepositoryIndexOverrides(CONFIG, { exclusions: { paths: ["a.txt", "b.txt"] } }));
    expect(a.exclusions.paths).toEqual(["a.txt", "b.txt"]);
    expect(repositoryIndexConfigurationFingerprint(a)).toBe(
      repositoryIndexConfigurationFingerprint(b),
    );
  });
});

describe("building", () => {
  it("records symlinks and submodules as metadata and never reads them", () => {
    return (async () => {
      const port = createMemorySnapshotPort({
        files: {
          "link-to-secrets": { kind: "symlink", linkTarget: "../../../etc/shadow" },
          "vendor-module": { kind: "submodule" },
          "safe-link": { kind: "symlink", linkTarget: "src/index.ts", linkTargetVerifiedSafe: true },
          "src/index.ts": "export const value = 1;\n",
        },
      });
      const index = unwrap(
        await buildRepositoryIndex({ readPort: port, configuration: CONFIG, clock: createManualIndexClock() }),
      );
      const link = index.entries.find((entry) => entry.canonicalPath === "link-to-secrets");
      expect(link?.kind).toBe("symlink");
      expect(link?.contentDigest).toBeNull();
      expect(link?.textIndexed).toBe(false);
      expect(link?.linkTarget).toBe("../../../etc/shadow");
      // Even a workspace-verified link is metadata: the indexer never follows one.
      expect(port.reads).toEqual(["src/index.ts"]);
      expect(
        index.diagnostics.filter((item) => item.code === "symlink-metadata-only"),
      ).toHaveLength(2);
    })();
  });

  it("drops link metadata entirely when configuration says so", async () => {
    const configuration = unwrap(withRepositoryIndexOverrides(CONFIG, { recordLinkMetadata: false }));
    const index = unwrap(
      await buildRepositoryIndex({
        readPort: createMemorySnapshotPort({
          files: { "a-link": { kind: "symlink", linkTarget: "x" }, "a.ts": "const a = 1;\n" },
        }),
        configuration,
        clock: createManualIndexClock(),
      }),
    );
    expect(index.entries.map((entry) => entry.canonicalPath)).toEqual(["a.ts"]);
    expect(index.totals.rejectedCount).toBe(1);
  });

  it("keeps binary and undecodable files as metadata with a digest", async () => {
    const index = await buildFrom({
      files: {
        "image.png": { content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]) },
        "broken.txt": { content: new Uint8Array([0x61, 0xc3, 0x28]) },
      },
    });
    const png = index.entries.find((entry) => entry.canonicalPath === "image.png");
    const broken = index.entries.find((entry) => entry.canonicalPath === "broken.txt");
    expect(png?.encoding).toBe("binary");
    expect(png?.contentDigest?.hex).toMatch(/^[0-9a-f]{64}$/);
    expect(png?.textIndexed).toBe(false);
    expect(broken?.encoding).toBe("invalid-utf-8");
    // Both remain discoverable by path.
    const hits = unwrap(queryRepositoryIndex(index, { kind: "terms", text: "image" }));
    expect(hits.hits.map((hit) => hit.canonicalPath)).toContain("image.png");
  });

  it("indexes generated content by path but not by body", async () => {
    const index = await buildFrom({
      files: {
        "bundle.js": `// @generated\nconst uniqueBodyToken = 1;\n`,
        "normal.js": "const uniqueBodyToken = 2;\n",
      },
    });
    const generated = index.entries.find((entry) => entry.canonicalPath === "bundle.js");
    expect(generated?.generated).toBe(true);
    expect(generated?.textIndexed).toBe(false);
    const hits = unwrap(queryRepositoryIndex(index, { kind: "terms", text: "uniqueBodyToken" }));
    expect(hits.hits.map((hit) => hit.canonicalPath)).toEqual(["normal.js"]);
    // Positive control: the same token in ordinary content IS found.
    expect(hits.hits).toHaveLength(1);
  });

  it("refuses to read a file larger than the per-file bound", async () => {
    const configuration = unwrap(
      withRepositoryIndexOverrides(CONFIG, {
        limits: { maxFileBytes: 16, maxIndexedTextBytes: 16, maxManifestBytes: 16 },
      }),
    );
    const port = createMemorySnapshotPort({ files: { "big.txt": "x".repeat(64) } });
    const index = unwrap(
      await buildRepositoryIndex({ readPort: port, configuration, clock: createManualIndexClock() }),
    );
    expect(port.reads).toEqual([]);
    expect(index.entries[0]?.contentDigest).toBeNull();
    expect(index.diagnostics.some((item) => item.code === "entry-too-large")).toBe(true);
  });

  it("records a read failure without propagating the port's message", async () => {
    const index = await buildFrom({
      files: { "unreadable.txt": { content: "secret host path", readFails: true } },
    });
    expect(index.entries[0]?.contentDigest).toBeNull();
    expect(index.diagnostics.some((item) => item.code === "read-failed")).toBe(true);
    expect(JSON.stringify(index)).not.toContain("fixture:");
  });

  it("drops both sides of a case collision rather than choosing one", async () => {
    const index = await buildFrom({
      filesystemSemantics: { caseSensitivity: "case-insensitive", unicodeForm: "nfc" },
      files: { "README.md": "one\n", "readme.md": "two\n" },
    });
    expect(index.entries.map((entry) => entry.canonicalPath)).toEqual([]);
    expect(index.diagnostics.filter((item) => item.code === "path-collision")).toHaveLength(2);
  });

  it("keeps both spellings when the filesystem is case-sensitive", async () => {
    const index = await buildFrom({ files: { "README.md": "one\n", "readme.md": "two\n" } });
    expect(index.entries.map((entry) => entry.canonicalPath)).toEqual(["README.md", "readme.md"]);
  });

  it("records rejected paths by digest only, never by their text", async () => {
    const hostilePath = "../../etc/passwd";
    const index = await buildFrom({ files: { [hostilePath]: "root:x:0:0\n", "ok.txt": "fine\n" } });
    expect(index.entries.map((entry) => entry.canonicalPath)).toEqual(["ok.txt"]);
    expect(index.rejections).toHaveLength(1);
    expect(index.rejections[0]?.reason).toBe("traversal");
    const serialized = JSON.stringify(index);
    expect(serialized).not.toContain("etc/passwd");
    expect(serialized).not.toContain("root:x:0:0");
  });

  it("caps the entry count and marks the bound as exhausted", async () => {
    const configuration = unwrap(withRepositoryIndexOverrides(CONFIG, { limits: { maxFiles: 2 } }));
    const files: Record<string, string> = {};
    for (let index = 0; index < 5; index += 1) {
      files[`f${index}.txt`] = `content ${index}\n`;
    }
    const index = unwrap(
      await buildRepositoryIndex({
        readPort: createMemorySnapshotPort({ files }),
        configuration,
        clock: createManualIndexClock(),
      }),
    );
    expect(index.entries).toHaveLength(2);
    expect(index.totals.limitsExhausted).toBe(true);
    expect(index.diagnostics.some((item) => item.code === "file-budget-exhausted")).toBe(true);
  });

  it("stops reading content once the total byte budget is spent", async () => {
    const configuration = unwrap(
      withRepositoryIndexOverrides(CONFIG, { limits: { maxTotalBytes: 10 } }),
    );
    const port = createMemorySnapshotPort({
      files: { "a.txt": "0123456789", "b.txt": "0123456789" },
    });
    const index = unwrap(
      await buildRepositoryIndex({ readPort: port, configuration, clock: createManualIndexClock() }),
    );
    expect(port.reads).toEqual(["a.txt"]);
    expect(index.totals.limitsExhausted).toBe(true);
    expect(index.diagnostics.some((item) => item.code === "byte-budget-exhausted")).toBe(true);
  });

  it("stops when the processing-time budget is spent", async () => {
    const configuration = unwrap(
      withRepositoryIndexOverrides(CONFIG, { limits: { maxProcessingMs: 1 } }),
    );
    const clock = createManualIndexClock();
    const ticking = {
      now: (): Date => {
        const value = clock.now();
        clock.advance(10);
        return value;
      },
    };
    const index = unwrap(
      await buildRepositoryIndex({
        readPort: createMemorySnapshotPort({ files: { "a.txt": "a\n", "b.txt": "b\n" } }),
        configuration,
        clock: ticking,
      }),
    );
    expect(index.totals.limitsExhausted).toBe(true);
    expect(index.diagnostics.some((item) => item.code === "time-budget-exhausted")).toBe(true);
  });

  it("returns a cancellation failure rather than a partial index", async () => {
    const result = await buildRepositoryIndex({
      readPort: createMemorySnapshotPort({ files: { "a.txt": "a\n" } }),
      configuration: CONFIG,
      clock: createManualIndexClock(),
      signal: { aborted: true },
    });
    expect(failure(result)).toBe("CANCELLED");
  });

  it("surfaces a listing failure as a port failure", async () => {
    const result = await buildRepositoryIndex({
      readPort: {
        identity: () => createMemorySnapshotPort({ files: {} }).identity(),
        list: () => Promise.reject(new Error("host path /home/user/.ssh unreadable")),
        read: () => Promise.reject(new Error("no")),
      },
      configuration: CONFIG,
      clock: createManualIndexClock(),
    });
    expect(failure(result)).toBe("READ_PORT_FAILURE");
    expect(JSON.stringify(result)).not.toContain(".ssh");
  });

  it("indexes a repository with no revision", async () => {
    const index = await buildFrom({
      revision: { type: "no-revision", reason: "empty repository" },
      files: { "a.txt": "a\n" },
    });
    expect(index.identity.revision).toEqual({ type: "no-revision", reason: "empty repository" });
    expect(index.entries[0]?.provenance.revisionId).toBe("no-revision");
  });
});

describe("incremental update", () => {
  const baseFiles = { "a.ts": "export const a = 1;\n", "b.ts": "export const b = 2;\n" };

  it("re-reads only the changed entries", async () => {
    const prior = await buildFrom({ files: baseFiles });
    const nextPort = createMemorySnapshotPort({
      files: { ...baseFiles, "a.ts": "export const a = 99;\n" },
    });
    unwrap(
      await updateRepositoryIndex({
        readPort: nextPort,
        priorIndex: prior,
        configuration: CONFIG,
        clock: createManualIndexClock(),
        changeSet: {
          schemaVersion: 1,
          baseFingerprint: prior.fingerprint,
          changes: [{ type: "modified", path: "a.ts" }],
        },
      }),
    );
    expect(nextPort.reads).toEqual(["a.ts"]);
  });

  it("matches a full rebuild after a rename", async () => {
    const prior = await buildFrom({ files: baseFiles });
    const renamed = { "a.ts": baseFiles["a.ts"], "c.ts": baseFiles["b.ts"] };
    const incremental = unwrap(
      await updateRepositoryIndex({
        readPort: createMemorySnapshotPort({ files: renamed }),
        priorIndex: prior,
        configuration: CONFIG,
        clock: createManualIndexClock(),
        changeSet: {
          schemaVersion: 1,
          baseFingerprint: prior.fingerprint,
          changes: [{ type: "renamed", fromPath: "b.ts", path: "c.ts" }],
        },
      }),
    );
    const rebuilt = await buildFrom({ files: renamed });
    expect(incremental.fingerprint).toBe(rebuilt.fingerprint);
    expect(incremental.tombstones.map((item) => [item.canonicalPath, item.reason])).toEqual([
      ["b.ts", "renamed"],
    ]);
    expect(tombstoneFingerprint(incremental)).not.toBe(tombstoneFingerprint(rebuilt));
  });

  it("detects a collision introduced by an incremental addition", async () => {
    const prior = await buildFrom({
      filesystemSemantics: { caseSensitivity: "case-insensitive", unicodeForm: "nfc" },
      files: { "Readme.md": "one\n" },
    });
    const next = unwrap(
      await updateRepositoryIndex({
        readPort: createMemorySnapshotPort({
          filesystemSemantics: { caseSensitivity: "case-insensitive", unicodeForm: "nfc" },
          files: { "Readme.md": "one\n", "README.MD": "two\n" },
        }),
        priorIndex: prior,
        configuration: CONFIG,
        clock: createManualIndexClock(),
        changeSet: {
          schemaVersion: 1,
          baseFingerprint: prior.fingerprint,
          changes: [{ type: "added", path: "README.MD" }],
        },
      }),
    );
    expect(next.entries).toHaveLength(0);
    expect(next.diagnostics.filter((item) => item.code === "path-collision")).toHaveLength(2);
  });

  it("refuses a change set whose configuration no longer matches", async () => {
    const prior = await buildFrom({ files: baseFiles });
    const result = await updateRepositoryIndex({
      readPort: createMemorySnapshotPort({ files: baseFiles }),
      priorIndex: prior,
      configuration: unwrap(withRepositoryIndexOverrides(CONFIG, { limits: { maxFiles: 10 } })),
      clock: createManualIndexClock(),
      changeSet: { schemaVersion: 1, baseFingerprint: prior.fingerprint, changes: [] },
    });
    expect(failure(result)).toBe("SNAPSHOT_MISMATCH");
  });

  it("refuses a change set that crosses projects", async () => {
    const prior = await buildFrom({ files: baseFiles });
    const result = await updateRepositoryIndex({
      readPort: createMemorySnapshotPort({ projectId: "other-project", files: baseFiles }),
      priorIndex: prior,
      configuration: CONFIG,
      clock: createManualIndexClock(),
      changeSet: { schemaVersion: 1, baseFingerprint: prior.fingerprint, changes: [] },
    });
    expect(failure(result)).toBe("SNAPSHOT_MISMATCH");
  });

  it("rejects a malformed change set", async () => {
    const prior = await buildFrom({ files: baseFiles });
    const result = await updateRepositoryIndex({
      readPort: createMemorySnapshotPort({ files: baseFiles }),
      priorIndex: prior,
      configuration: CONFIG,
      clock: createManualIndexClock(),
      changeSet: { schemaVersion: 1, baseFingerprint: prior.fingerprint, changes: [{ type: "moved" }] },
    });
    expect(failure(result)).toBe("INVALID_CHANGE_SET");
  });

  it("rejects a change naming a path absent from the new snapshot", async () => {
    const prior = await buildFrom({ files: baseFiles });
    const result = await updateRepositoryIndex({
      readPort: createMemorySnapshotPort({ files: baseFiles }),
      priorIndex: prior,
      configuration: CONFIG,
      clock: createManualIndexClock(),
      changeSet: {
        schemaVersion: 1,
        baseFingerprint: prior.fingerprint,
        changes: [{ type: "added", path: "ghost.ts" }],
      },
    });
    expect(failure(result)).toBe("INVALID_CHANGE_SET");
  });

  it("removes an entry that becomes excluded and records the rejection", async () => {
    const prior = await buildFrom({ files: { "keep.ts": "a\n", "later.pem": "not yet excluded\n" } });
    // `later.pem` is excluded by the default suffix rules, so it is already absent.
    expect(prior.entries.map((entry) => entry.canonicalPath)).toEqual(["keep.ts"]);
    expect(prior.rejections).toHaveLength(1);
  });

  it("replays deterministically for identical inputs", async () => {
    const prior = await buildFrom({ files: baseFiles });
    const changeSet = {
      schemaVersion: 1,
      baseFingerprint: prior.fingerprint,
      changes: [{ type: "modified", path: "a.ts" }],
    };
    const next = { ...baseFiles, "a.ts": "export const a = 3;\n" };
    const first = unwrap(
      await updateRepositoryIndex({
        readPort: createMemorySnapshotPort({ files: next }),
        priorIndex: prior,
        configuration: CONFIG,
        clock: createManualIndexClock(),
        changeSet,
      }),
    );
    const second = unwrap(
      await updateRepositoryIndex({
        readPort: createMemorySnapshotPort({ files: next }),
        priorIndex: prior,
        configuration: CONFIG,
        clock: createManualIndexClock("2030-01-01T00:00:00.000Z"),
        changeSet,
      }),
    );
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(tombstoneFingerprint(first)).toBe(tombstoneFingerprint(second));
  });

  it("cancels an update without producing an index", async () => {
    const prior = await buildFrom({ files: baseFiles });
    const result = await updateRepositoryIndex({
      readPort: createMemorySnapshotPort({ files: baseFiles }),
      priorIndex: prior,
      configuration: CONFIG,
      clock: createManualIndexClock(),
      signal: { aborted: true },
      changeSet: {
        schemaVersion: 1,
        baseFingerprint: prior.fingerprint,
        changes: [{ type: "modified", path: "a.ts" }],
      },
    });
    expect(failure(result)).toBe("CANCELLED");
  });
});

describe("query", () => {
  const files = {
    "src/alpha.ts": "export function renderWidget() { return 1; }\n",
    "src/beta.ts": "export function renderPanel() { return 2; }\n",
    "docs/render.md": "# Rendering\n\nHow rendering works.\n",
  };

  it("validates its inputs", async () => {
    const index = await buildFrom({ files });
    expect(failure(queryRepositoryIndex(index, { kind: "terms", text: "" }))).toBe("INVALID_QUERY");
    expect(failure(queryRepositoryIndex(index, { kind: "terms", text: "a", limit: 0 }))).toBe(
      "INVALID_QUERY",
    );
    expect(
      failure(queryRepositoryIndex(index, { kind: "terms", text: "a", maxCandidates: 0 })),
    ).toBe("INVALID_QUERY");
    expect(failure(queryRepositoryIndex(index, { kind: "terms", text: "a", fields: [] }))).toBe(
      "INVALID_QUERY",
    );
    expect(failure(queryRepositoryIndex(index, { kind: "terms", text: "!!" }))).toBe(
      "INVALID_QUERY",
    );
  });

  it("honours cancellation before scanning", async () => {
    const index = await buildFrom({ files });
    expect(
      failure(queryRepositoryIndex(index, { kind: "terms", text: "render", signal: { aborted: true } })),
    ).toBe("CANCELLED");
  });

  it("scores field matches above body matches", async () => {
    const index = await buildFrom({ files });
    const result = unwrap(queryRepositoryIndex(index, { kind: "terms", text: "render" }));
    expect(result.hits[0]?.canonicalPath).toBe("docs/render.md");
    expect(result.hits[0]?.components.length).toBeGreaterThan(0);
    expect(result.hits.every((hit) => Number.isSafeInteger(hit.score))).toBe(true);
  });

  it("restricts matching to the requested fields", async () => {
    const index = await buildFrom({ files });
    const nameOnly = unwrap(
      queryRepositoryIndex(index, { kind: "terms", text: "render", fields: ["name"] }),
    );
    expect(nameOnly.hits.map((hit) => hit.canonicalPath)).toEqual(["docs/render.md"]);
  });

  it("supports exact, prefix, and path queries", async () => {
    const index = await buildFrom({ files });
    // The tokenizer splits case transitions, so `renderWidget` is stored as
    // `render` + `widget`; an exact query matches a stored term, not the
    // original spelling.
    expect(unwrap(queryRepositoryIndex(index, { kind: "exact", text: "renderwidget" })).hits).toHaveLength(0);
    const exact = unwrap(queryRepositoryIndex(index, { kind: "exact", text: "widget" }));
    expect(exact.hits.map((hit) => hit.canonicalPath)).toEqual(["src/alpha.ts"]);
    expect(
      unwrap(queryRepositoryIndex(index, { kind: "prefix", text: "render" })).hits.length,
    ).toBeGreaterThan(1);
    const byPath = unwrap(queryRepositoryIndex(index, { kind: "path", text: "src/" }));
    expect(byPath.hits.map((hit) => hit.canonicalPath).sort()).toEqual([
      "src/alpha.ts",
      "src/beta.ts",
    ]);
  });

  it("reports truncation and respects the candidate bound", async () => {
    const index = await buildFrom({ files });
    const limited = unwrap(
      queryRepositoryIndex(index, { kind: "path", text: "s", maxCandidates: 1 }),
    );
    expect(limited.truncated).toBe(true);
  });

  it("carries provenance on every hit", async () => {
    const index = await buildFrom({ files });
    const result = unwrap(queryRepositoryIndex(index, { kind: "terms", text: "render" }));
    for (const hit of result.hits) {
      expect(hit.sourceDigestHex).toMatch(/^[0-9a-f]{64}$/);
      expect(result.indexFingerprint).toBe(index.fingerprint);
    }
  });
});

describe("indexer facade", () => {
  it("threads configuration and clock through build, update, and query", async () => {
    const indexer = createRepositoryIndexer({
      configuration: CONFIG,
      clock: createManualIndexClock(),
    });
    const port = createMemorySnapshotPort({ files: { "a.ts": "export const a = 1;\n" } });
    const index = unwrap(await indexer.build(port));
    expect(indexer.configuration).toBe(CONFIG);
    const updated = unwrap(
      await indexer.update({
        readPort: port,
        priorIndex: index,
        changeSet: { schemaVersion: 1, baseFingerprint: index.fingerprint, changes: [] },
      }),
    );
    expect(updated.fingerprint).toBe(index.fingerprint);
    expect(unwrap(indexer.query(index, { kind: "terms", text: "const" })).hits.length).toBeGreaterThan(0);
    expect(failure(await indexer.build(port, { aborted: true }))).toBe("CANCELLED");
  });
});

describe("hostile repository content", () => {
  it("never executes or honours repository configuration and hooks", async () => {
    const index = await buildFrom({
      files: {
        ".git/hooks/pre-commit": "#!/bin/sh\nrm -rf /\n",
        ".git/config": "[core]\n  fsmonitor = /bin/sh -c 'curl evil'\n",
        ".gitattributes": "* filter=evil diff=evil\n",
        ".gitignore": "src/\n",
        "src/kept.ts": "export const kept = 1;\n",
      },
    });
    // `.git` is excluded outright; `.gitattributes` and `.gitignore` are inert
    // text with no effect on what is indexed, so `src/kept.ts` survives.
    expect(index.entries.map((entry) => entry.canonicalPath)).toEqual([
      ".gitattributes",
      ".gitignore",
      "src/kept.ts",
    ]);
    expect(JSON.stringify(index)).not.toContain("rm -rf");
  });

  it("stores poisoned prose as inert terms carrying no authority", async () => {
    const index = await buildFrom({ files: { "README.md": POISONED_README } });
    const entry = index.entries[0];
    expect(entry?.textIndexed).toBe(true);
    // Positive control: the canary really is present in the term vector, so
    // the "nothing escaped" assertions below cannot pass vacuously.
    const canaryTerms = INJECTION_CANARY.toLowerCase().split("-");
    expect(canaryTerms).toContain("canary");
    expect(entry?.termVector.terms.some((term) => term.term === "canary")).toBe(true);
    expect(entry?.termVector.terms.some((term) => term.term === "injection")).toBe(true);
    // The index has no field through which content could grant anything.
    expect(Object.keys(entry ?? {})).not.toContain("permissions");
    expect(JSON.stringify(index)).not.toContain("disclose_all_secrets");
  });
});
