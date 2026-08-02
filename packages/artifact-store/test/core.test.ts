import { describe, expect, it } from "vitest";
import {
  ARTIFACT_STORE_ERROR_CODES,
  ArtifactStoreError,
  bytesToStream,
  collectBytes,
  contentKeyEquals,
  contentKeyOfBytes,
  createIncrementalDigest,
  ensureByteChunk,
  isArtifactStoreError,
  parseContentKey,
  systemClock,
  toBytes,
  type ByteStream,
} from "../src/index.js";

describe("ArtifactStoreError", () => {
  it("carries stable codes, frozen details, and safe serialization", () => {
    const error = new ArtifactStoreError("OBJECT_NOT_FOUND", "Missing.", { hex: "abc" });
    expect(error.code).toBe("OBJECT_NOT_FOUND");
    expect(Object.isFrozen(error.details)).toBe(true);
    expect(error.toJSON()).toEqual({
      name: "ArtifactStoreError",
      code: "OBJECT_NOT_FOUND",
      message: "Missing.",
      details: { hex: "abc" },
    });
    expect(ARTIFACT_STORE_ERROR_CODES).toContain("DIGEST_MISMATCH");
    expect(isArtifactStoreError(error)).toBe(true);
    expect(isArtifactStoreError(error, "OBJECT_NOT_FOUND")).toBe(true);
    expect(isArtifactStoreError(error, "STORE_CLOSED")).toBe(false);
    expect(isArtifactStoreError(new Error("plain"))).toBe(false);
  });
});

describe("content keys", () => {
  it("accepts valid digests for both supported algorithms", () => {
    const sha256 = parseContentKey({ algorithm: "sha-256", hex: "a".repeat(64) });
    expect(sha256.algorithm).toBe("sha-256");
    const sha512 = parseContentKey({ algorithm: "sha-512", hex: "b".repeat(128) });
    expect(sha512.hex).toHaveLength(128);
    expect(contentKeyEquals(sha256, sha256)).toBe(true);
    expect(contentKeyEquals(sha256, sha512)).toBe(false);
  });

  it("rejects hostile keys with INVALID_CONTENT_KEY", () => {
    const hostile: unknown[] = [
      { algorithm: "sha-256", hex: "A".repeat(64) },
      { algorithm: "sha-256", hex: "a".repeat(63) },
      { algorithm: "sha-256", hex: "a".repeat(128) },
      { algorithm: "sha-512", hex: "a".repeat(64) },
      { algorithm: "md5", hex: "a".repeat(32) },
      { algorithm: "sha-256", hex: "../../../etc/passwd" },
      { algorithm: "sha-256" },
      "sha-256:aaaa",
      null,
      [],
    ];
    for (const key of hostile) {
      try {
        parseContentKey(key);
        expect.unreachable();
      } catch (error) {
        expect(isArtifactStoreError(error, "INVALID_CONTENT_KEY")).toBe(true);
      }
    }
  });
});

describe("stream helpers", () => {
  it("computes deterministic content keys matching node crypto", () => {
    // sha-256 of empty input is a well-known constant.
    expect(contentKeyOfBytes("").hex).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(contentKeyOfBytes("abc", "sha-512").hex).toHaveLength(128);
    expect(contentKeyEquals(contentKeyOfBytes("x"), contentKeyOfBytes(toBytes("x")))).toBe(true);
  });

  it("streams bytes and strings as single-chunk streams", async () => {
    const collected = await collectBytes(bytesToStream("hello"), 100);
    expect(new TextDecoder().decode(collected)).toBe("hello");
    const raw = await collectBytes(bytesToStream(new Uint8Array([1, 2, 3])), 3);
    expect([...raw]).toEqual([1, 2, 3]);
  });

  it("collectBytes enforces its mandatory bound and validates chunks", async () => {
    async function* threeChunks(): ByteStream {
      yield new Uint8Array(10);
      yield new Uint8Array(10);
      yield new Uint8Array(10);
    }
    await expect(collectBytes(threeChunks(), 29)).rejects.toMatchObject({
      code: "SIZE_LIMIT_EXCEEDED",
    });
    expect((await collectBytes(threeChunks(), 30)).byteLength).toBe(30);
    await expect(collectBytes(threeChunks(), -1)).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION",
    });

    async function* hostile(): AsyncIterable<unknown> {
      yield { not: "bytes" };
    }
    await expect(collectBytes(hostile() as ByteStream, 100)).rejects.toMatchObject({
      code: "INVALID_STREAM",
    });
    expect(() => ensureByteChunk("text")).toThrow(ArtifactStoreError);
    expect(() => toBytes(42 as never)).toThrow(ArtifactStoreError);
  });

  it("incremental digests are single-use", () => {
    const digest = createIncrementalDigest("sha-256");
    digest.update(toBytes("ab"));
    digest.update(toBytes("c"));
    const key = digest.finish();
    expect(contentKeyEquals(key, contentKeyOfBytes("abc"))).toBe(true);
    expect(() => digest.finish()).toThrow(ArtifactStoreError);
    expect(() => digest.update(toBytes("x"))).toThrow(ArtifactStoreError);
  });

  it("exposes a system clock for default wiring", () => {
    expect(systemClock.now()).toBeInstanceOf(Date);
  });
});
