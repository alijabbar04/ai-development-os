import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  contentKeyOfBytes,
  isArtifactStoreError,
  type ArtifactByteStore,
} from "@ai-dev-os/artifact-store";
import { createManualClock } from "@ai-dev-os/artifact-store/testing";
import { TEMP_FILE_PATTERN, createLocalArtifactStore } from "../src/index.js";

const cleanups: Array<() => void> = [];
const stores: ArtifactByteStore[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aidevos-cas-spec-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  return root;
}

afterEach(async () => {
  while (stores.length > 0) {
    await stores.pop()?.close();
  }
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

async function openStore(root: string, extra: Record<string, unknown> = {}): Promise<ArtifactByteStore> {
  const store = await createLocalArtifactStore({ root, clock: createManualClock(), ...extra });
  stores.push(store);
  return store;
}

describe("configuration validation", () => {
  it("rejects hostile roots and options", async () => {
    const cases: Array<Record<string, unknown>> = [
      { root: "relative/path" },
      { root: "" },
      { root: "file:C:/store" },
      { root: `${tmpdir()}${"\u0000"}` },
      { root: "x".repeat(2_000) },
      { root: 42 },
      { root: tempRoot(), durability: "eventually" },
      { root: tempRoot(), defaultMaxWriteBytes: 0 },
      { root: tempRoot(), defaultMaxWriteBytes: 1.5 },
    ];
    for (const options of cases) {
      try {
        await createLocalArtifactStore(options as never);
        expect.unreachable();
      } catch (error) {
        expect(isArtifactStoreError(error, "INVALID_CONFIGURATION")).toBe(true);
      }
    }
  });

  it("rejects a root whose location is occupied by a file", async () => {
    const parent = tempRoot();
    const fileAsRoot = join(parent, "occupied");
    await writeFile(fileAsRoot, "not a directory");
    await expect(createLocalArtifactStore({ root: fileAsRoot })).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION",
    });
  });

  it("creates a missing root, accepts paths with spaces, and pins them", async () => {
    const root = join(tempRoot(), "deep", "store root with spaces");
    const store = await openStore(root);
    const result = await store.writeBytes("spaced");
    const physical = join(root, "v1", "sha-256", result.key.hex.slice(0, 2), result.key.hex);
    expect((await stat(physical)).isFile()).toBe(true);
  });

  it("rejects a misbehaving idSource at use time", async () => {
    const store = await openStore(tempRoot(), { idSource: () => "NOT-HEX" });
    await expect(store.writeBytes("x")).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION",
    });
  });

  it("rejects conflicting expectedKey and algorithm options", async () => {
    const store = await openStore(tempRoot());
    await expect(
      store.writeBytes("x", {
        algorithm: "sha-512",
        expectedKey: contentKeyOfBytes("x", "sha-256"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await expect(
      store.writeBytes("x", { algorithm: "md5" as never }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
  });
});

describe("physical layout", () => {
  it("stores objects exactly at v1/<algorithm>/<prefix>/<digest>", async () => {
    const root = tempRoot();
    const store = await openStore(root);
    const result = await store.writeBytes("layout-check");
    const expected = join(root, "v1", "sha-256", result.key.hex.slice(0, 2), result.key.hex);
    const info = await stat(expected);
    expect(info.isFile()).toBe(true);
    expect(info.size).toBe("layout-check".length);
    expect(result.location.relativePath.split("/")).toEqual([
      "v1",
      "sha-256",
      result.key.hex.slice(0, 2),
      result.key.hex,
    ]);
  });

  it("keeps the temp-file format strict and matchable", () => {
    expect(TEMP_FILE_PATTERN.test(`w-${"a".repeat(32)}.tmp`)).toBe(true);
    expect(TEMP_FILE_PATTERN.test(`w-${"A".repeat(32)}.tmp`)).toBe(false);
    expect(TEMP_FILE_PATTERN.test(`w-${"a".repeat(31)}.tmp`)).toBe(false);
    expect(TEMP_FILE_PATTERN.test("anything.tmp")).toBe(false);
    expect(TEMP_FILE_PATTERN.test(`w-${"a".repeat(32)}.tmp.bak`)).toBe(false);
  });
});

describe("filesystem escape defenses", () => {
  it("refuses to write through a junction that resolves outside the root", async () => {
    const root = tempRoot();
    const outside = tempRoot();
    const store = await openStore(root);

    // Learn the prefix directory for this content, then replace it with a
    // junction pointing outside the store root.
    const key = contentKeyOfBytes("junction-target");
    const prefixDir = join(root, "v1", "sha-256", key.hex.slice(0, 2));
    await mkdir(prefixDir, { recursive: true });
    await rm(prefixDir, { recursive: true });
    try {
      await symlink(outside, prefixDir, "junction");
    } catch {
      // Environment cannot create junctions; nothing to test here.
      return;
    }

    await expect(store.writeBytes("junction-target")).rejects.toMatchObject({
      code: "UNSAFE_FILESYSTEM_STATE",
    });
    // Nothing escaped into the outside directory's object position.
    await expect(stat(join(outside, key.hex))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports non-file entries at object locations as unsafe", async () => {
    const root = tempRoot();
    const store = await openStore(root);
    const key = contentKeyOfBytes("dir-in-the-way");
    const objectPath = join(root, "v1", "sha-256", key.hex.slice(0, 2), key.hex);
    await mkdir(objectPath, { recursive: true });
    await expect(store.stat(key)).rejects.toMatchObject({ code: "UNSAFE_FILESYSTEM_STATE" });
    await expect(store.writeBytes("dir-in-the-way")).rejects.toMatchObject({
      code: "UNSAFE_FILESYSTEM_STATE",
    });
  });

  it("fails cleanup structurally when the temp directory is unlistable", async () => {
    const root = tempRoot();
    const store = await openStore(root);
    await rm(join(root, "tmp"), { recursive: true });
    await expect(store.cleanupTemporaryFiles({ olderThanMs: 0 })).rejects.toMatchObject({
      code: "CLEANUP_FAILED",
    });
  });
});

describe("write-path edge cases", () => {
  it("gives up after repeated exclusive temp-file collisions", async () => {
    const root = tempRoot();
    const constantId = "c".repeat(32);
    const store = await openStore(root, { idSource: () => constantId });
    // Occupy the only temp name this idSource can ever produce.
    await writeFile(join(root, "tmp", `w-${constantId}.tmp`), "squatter");
    await expect(store.writeBytes("collides")).rejects.toMatchObject({
      code: "UNSAFE_FILESYSTEM_STATE",
    });
  });

  it("treats an existing same-digest object with a different size as unsafe", async () => {
    const root = tempRoot();
    const store = await openStore(root);
    const original = await store.writeBytes("expected-bytes");
    const physical = join(
      root,
      "v1",
      "sha-256",
      original.key.hex.slice(0, 2),
      original.key.hex,
    );
    await writeFile(physical, "different-length-content!");
    await expect(store.writeBytes("expected-bytes")).rejects.toMatchObject({
      code: "UNSAFE_FILESYSTEM_STATE",
    });
  });

  it("aborts open read streams when the store closes mid-stream", async () => {
    const root = tempRoot();
    const store = await createLocalArtifactStore({ root, clock: createManualClock() });
    const big = "x".repeat(200_000);
    const result = await store.writeBytes(big);
    const stream = await store.openRead(result.key);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    await store.close();
    await expect(iterator.next()).rejects.toMatchObject({ code: "STORE_CLOSED" });
  });
});

describe("durability modes", () => {
  it("supports flush and fast modes with identical results", async () => {
    const flushStore = await openStore(tempRoot(), { durability: "flush" });
    const fastStore = await openStore(tempRoot(), { durability: "fast" });
    const a = await flushStore.writeBytes("same-content");
    const b = await fastStore.writeBytes("same-content");
    expect(a.key).toEqual(b.key);
    expect(a.location).toEqual(b.location);
    await flushStore.verify(a.key);
    await fastStore.verify(b.key);
  });
});

describe("dedup reporting under sequential reuse", () => {
  it("reports newly stored then deduplicated across store instances", async () => {
    const root = tempRoot();
    const first = await openStore(root);
    const initial = await first.writeBytes("shared-bytes");
    expect(initial.deduplicated).toBe(false);
    await first.close();

    const second = await openStore(root);
    const again = await second.writeBytes("shared-bytes");
    expect(again.deduplicated).toBe(true);
    expect(again.location).toEqual(initial.location);
  });
});
