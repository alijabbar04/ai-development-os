import { describe, expect, it } from "vitest";
import { ValidationError } from "@ai-dev-os/domain";
import { DEFAULT_REPOSITORY_INDEX_CONFIGURATION } from "../src/config.js";
import { buildRepositoryIndex } from "../src/indexer.js";
import {
  parseRepositoryIndex,
  parseRepositoryIndexChangeSet,
  repositoryIndexFingerprint,
  type RepositoryIndex,
} from "../src/index-model.js";
import { RepositoryIndexError } from "../src/errors.js";
import { createManualIndexClock, createMemorySnapshotPort } from "../src/testing/fixtures.js";

async function sample(): Promise<RepositoryIndex> {
  const result = await buildRepositoryIndex({
    readPort: createMemorySnapshotPort({
      files: {
        "package.json": JSON.stringify({ name: "sample", version: "1.0.0", dependencies: { a: "^1" } }),
        "src/main.ts": "export const main = 1;\n",
        "assets/logo.png": { content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]) },
        "link": { kind: "symlink", linkTarget: "src/main.ts" },
      },
    }),
    configuration: DEFAULT_REPOSITORY_INDEX_CONFIGURATION,
    clock: createManualIndexClock(),
  });
  if (!result.ok) {
    throw new Error("build failed");
  }
  return result.value;
}

function clone(index: RepositoryIndex): Record<string, unknown> {
  return JSON.parse(JSON.stringify(index)) as Record<string, unknown>;
}

describe("index validation", () => {
  it("round-trips a real index through JSON", async () => {
    const index = await sample();
    const parsed = parseRepositoryIndex(clone(index));
    expect(parsed.fingerprint).toBe(index.fingerprint);
    expect(parsed.entries).toHaveLength(index.entries.length);
    expect(parsed.dependencies.map((item) => item.name)).toEqual(
      index.dependencies.map((item) => item.name),
    );
  });

  it("rejects a tampered fingerprint", async () => {
    const raw = clone(await sample());
    raw["fingerprint"] = "a".repeat(64);
    expect(() => parseRepositoryIndex(raw)).toThrow(ValidationError);
  });

  it("rejects tampered content whose fingerprint was not recomputed", async () => {
    const index = await sample();
    const raw = clone(index);
    const entries = raw["entries"] as { sizeBytes: number }[];
    const first = entries[0];
    if (first !== undefined) {
      first.sizeBytes += 1;
    }
    expect(() => parseRepositoryIndex(raw)).toThrow(ValidationError);
  });

  it("rejects unsorted or duplicated entries", async () => {
    const index = await sample();
    const raw = clone(index);
    const entries = raw["entries"] as unknown[];
    raw["entries"] = [...entries].reverse();
    expect(() => parseRepositoryIndex(raw)).toThrow(ValidationError);
  });

  it("rejects an unsupported schema version", async () => {
    const raw = clone(await sample());
    raw["schemaVersion"] = 2;
    expect(() => parseRepositoryIndex(raw)).toThrow(ValidationError);
  });

  it("rejects unexpected fields", async () => {
    const raw = clone(await sample());
    raw["extra"] = true;
    expect(() => parseRepositoryIndex(raw)).toThrow(ValidationError);
  });

  it("rejects prototype-pollution keys anywhere in the document", async () => {
    const raw = clone(await sample());
    const text = JSON.stringify(raw).replace('"entries":', '"__proto__":{"x":1},"entries":');
    expect(() => parseRepositoryIndex(JSON.parse(text))).toThrow(ValidationError);
  });

  it("keeps observation time outside the fingerprint", async () => {
    const index = await sample();
    const withoutFingerprint = { ...index, observedAt: "2099-01-01T00:00:00.000Z" };
    expect(repositoryIndexFingerprint(withoutFingerprint)).toBe(index.fingerprint);
  });

  it("keeps tombstones outside the content fingerprint", async () => {
    const index = await sample();
    const withTombstone = {
      ...index,
      tombstones: [
        {
          canonicalPath: "gone.ts",
          previousContentDigestHex: "b".repeat(64),
          reason: "deleted" as const,
          revisionId: "0".repeat(40),
        },
      ],
    };
    expect(repositoryIndexFingerprint(withTombstone)).toBe(index.fingerprint);
  });

  it("deeply freezes the parsed value", async () => {
    const parsed = parseRepositoryIndex(clone(await sample()));
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.entries)).toBe(true);
    expect(Object.isFrozen(parsed.entries[0])).toBe(true);
    expect(Object.isFrozen(parsed.identity)).toBe(true);
  });
});

describe("change-set validation", () => {
  it("accepts every supported change shape", () => {
    const parsed = parseRepositoryIndexChangeSet({
      schemaVersion: 1,
      baseFingerprint: "c".repeat(64),
      changes: [
        { type: "added", path: "a.ts" },
        { type: "modified", path: "b.ts" },
        { type: "deleted", path: "c.ts" },
        { type: "renamed", fromPath: "d.ts", path: "e.ts" },
      ],
    });
    expect(parsed.changes).toHaveLength(4);
  });

  it("rejects a rename missing its source", () => {
    expect(() =>
      parseRepositoryIndexChangeSet({
        schemaVersion: 1,
        baseFingerprint: "c".repeat(64),
        changes: [{ type: "renamed", path: "e.ts" }],
      }),
    ).toThrow(ValidationError);
  });

  it("rejects an unsupported change type", () => {
    expect(() =>
      parseRepositoryIndexChangeSet({
        schemaVersion: 1,
        baseFingerprint: "c".repeat(64),
        changes: [{ type: "copied", path: "e.ts" }],
      }),
    ).toThrow(ValidationError);
  });

  it("rejects a malformed base fingerprint", () => {
    expect(() =>
      parseRepositoryIndexChangeSet({ schemaVersion: 1, baseFingerprint: "short", changes: [] }),
    ).toThrow(ValidationError);
  });
});

describe("error type", () => {
  it("exposes only primitive details and serializes safely", () => {
    const error = new RepositoryIndexError("UNSAFE_PATH", "refused", { reason: "traversal" });
    expect(error.name).toBe("RepositoryIndexError");
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: "RepositoryIndexError",
      code: "UNSAFE_PATH",
      message: "refused",
      details: { reason: "traversal" },
    });
    expect(Object.isFrozen(error.details)).toBe(true);
  });
});
