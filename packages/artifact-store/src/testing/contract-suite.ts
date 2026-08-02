import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ArtifactStoreError, isArtifactStoreError } from "../errors.js";
import { contentKeyEquals, type ContentKey } from "../content-key.js";
import {
  bytesToStream,
  collectBytes,
  contentKeyOfBytes,
  toBytes,
  type ByteStream,
} from "../streams.js";
import { createLiteralRedactionTransform, transformArtifact } from "../transform.js";
import type { ArtifactByteStore, Clock } from "../ports.js";

export interface ManualClock extends Clock {
  advance(milliseconds: number): void;
  set(iso: string): void;
}

export const CONTRACT_EPOCH = "2026-08-02T12:00:00.000Z";

export function createManualClock(startIso: string = CONTRACT_EPOCH): ManualClock {
  let current = new Date(startIso).valueOf();
  return {
    now: () => new Date(current),
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
    set: (iso: string) => {
      current = new Date(iso).valueOf();
    },
  };
}

/** Deterministic id source for temp-file names (32 lowercase hex chars). */
export function createSequentialIdSource(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return counter.toString(16).padStart(32, "0");
  };
}

export interface ArtifactStoreContractHarness {
  readonly store: ArtifactByteStore;
  readonly clock: ManualClock;
  /** Opens a NEW store over the same underlying storage. */
  readonly reopen?: () => Promise<ArtifactByteStore>;
  /** Flips bytes of a committed object without touching its location. */
  readonly corruptObject?: (key: ContentKey) => Promise<void>;
  readonly tempFiles?: {
    /** Creates a file matching the store's own temp format, aged relative to the clock. */
    readonly createMatching: (ageMs: number) => Promise<void>;
    /** Creates a file NOT matching the temp format; must never be deleted. */
    readonly createForeign: (ageMs: number) => Promise<void>;
    /** Counts all files currently in the temp area. */
    readonly count: () => Promise<number>;
  };
  readonly dispose?: () => Promise<void>;
}

const SECRET = "sk-live-BYTESTORE-CANARY-9999";

async function* chunked(...parts: ReadonlyArray<string | Uint8Array>): ByteStream {
  for (const part of parts) {
    yield toBytes(part);
  }
}

async function* failingStream(prefix: string, error: Error): ByteStream {
  yield toBytes(prefix);
  throw error;
}

async function expectStoreError(
  work: Promise<unknown> | (() => Promise<unknown>),
  code: string,
): Promise<ArtifactStoreError> {
  try {
    await (typeof work === "function" ? work() : work);
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactStoreError);
    expect((error as ArtifactStoreError).code).toBe(code);
    return error as ArtifactStoreError;
  }
  expect.unreachable(`expected ArtifactStoreError ${code}`);
}

const decoder = new TextDecoder();

export function runArtifactStoreContractSuite(
  suiteName: string,
  createHarness: () => Promise<ArtifactStoreContractHarness>,
): void {
  describe(`artifact-store contract: ${suiteName}`, () => {
    let harness: ArtifactStoreContractHarness;
    let store: ArtifactByteStore;

    beforeEach(async () => {
      harness = await createHarness();
      store = harness.store;
    });

    afterEach(async () => {
      await store.close();
      await harness.dispose?.();
    });

    describe("writes and reads", () => {
      it("stores and reads the empty object", async () => {
        const result = await store.writeBytes("");
        expect(result.sizeBytes).toBe(0);
        expect(contentKeyEquals(result.key, contentKeyOfBytes(""))).toBe(true);
        expect(Object.isFrozen(result)).toBe(true);
        const bytes = await store.readBytes(result.key, { verify: true });
        expect(bytes.byteLength).toBe(0);
        expect(await store.exists(result.key)).toBe(true);
      });

      it("round-trips multi-chunk streaming content", async () => {
        const result = await store.write(chunked("alpha-", "beta-", "gamma"));
        expect(result.sizeBytes).toBe("alpha-beta-gamma".length);
        expect(contentKeyEquals(result.key, contentKeyOfBytes("alpha-beta-gamma"))).toBe(true);
        expect(result.deduplicated).toBe(false);
        const stream = await store.openRead(result.key, { verify: true });
        const bytes = await collectBytes(stream, 1_024);
        expect(decoder.decode(bytes)).toBe("alpha-beta-gamma");
      });

      it("supports sha-512 addressing without cross-algorithm collisions", async () => {
        const sha256 = await store.writeBytes("payload", { algorithm: "sha-256" });
        const sha512 = await store.writeBytes("payload", { algorithm: "sha-512" });
        expect(sha256.key.algorithm).toBe("sha-256");
        expect(sha512.key.algorithm).toBe("sha-512");
        expect(sha256.location.relativePath).not.toBe(sha512.location.relativePath);
        expect(decoder.decode(await store.readBytes(sha512.key))).toBe("payload");
      });

      it("echoes caller artifact-id correlation and validates it", async () => {
        const result = await store.writeBytes("correlated", { artifactId: "artifact-1" });
        expect(result.artifactId).toBe("artifact-1");
        const plain = await store.writeBytes("uncorrelated");
        expect(plain.artifactId).toBeNull();
        await expect(
          store.writeBytes("x", { artifactId: "not a valid id!" }),
        ).rejects.toThrow();
      });

      it("reports stat and deterministic locations", async () => {
        const result = await store.writeBytes("stat-me");
        const stat = await store.stat(result.key);
        expect(stat).toEqual({
          key: result.key,
          sizeBytes: "stat-me".length,
          location: result.location,
        });
        expect(store.location(result.key)).toEqual(result.location);
        expect(result.location.layoutVersion).toBe(1);
        expect(result.location.relativePath).toBe(
          `v1/sha-256/${result.key.hex.slice(0, 2)}/${result.key.hex}`,
        );
        expect(result.location.relativePath).not.toContain("\\");
      });

      it("reports missing objects consistently", async () => {
        const ghost = contentKeyOfBytes("never-stored");
        expect(await store.exists(ghost)).toBe(false);
        expect(await store.stat(ghost)).toBeNull();
        await expectStoreError(store.openRead(ghost), "OBJECT_NOT_FOUND");
        await expectStoreError(store.readBytes(ghost), "OBJECT_NOT_FOUND");
        await expectStoreError(store.verify(ghost), "OBJECT_NOT_FOUND");
      });

      it("bounds readBytes buffering", async () => {
        const result = await store.writeBytes("a".repeat(1_000));
        await expectStoreError(
          store.readBytes(result.key, { maxBytes: 999 }),
          "SIZE_LIMIT_EXCEEDED",
        );
        const bytes = await store.readBytes(result.key, { maxBytes: 1_000 });
        expect(bytes.byteLength).toBe(1_000);
      });
    });

    describe("expectations and limits", () => {
      it("accepts a matching expected key and size", async () => {
        const expectedKey = contentKeyOfBytes("expected-content");
        const result = await store.writeBytes("expected-content", {
          expectedKey,
          expectedSizeBytes: "expected-content".length,
        });
        expect(contentKeyEquals(result.key, expectedKey)).toBe(true);
      });

      it("rejects an expected-digest mismatch and stores nothing", async () => {
        const wrongKey = contentKeyOfBytes("different-content");
        const error = await expectStoreError(
          store.writeBytes(`actual ${SECRET}`, { expectedKey: wrongKey }),
          "DIGEST_MISMATCH",
        );
        expect(JSON.stringify(error.toJSON())).not.toContain(SECRET);
        expect(await store.exists(contentKeyOfBytes(`actual ${SECRET}`))).toBe(false);
        if (harness.tempFiles) {
          expect(await harness.tempFiles.count()).toBe(0);
        }
      });

      it("rejects an expected-size mismatch", async () => {
        const error = await expectStoreError(
          store.writeBytes("four", { expectedSizeBytes: 5 }),
          "SIZE_MISMATCH",
        );
        expect(error.details["expectedSizeBytes"]).toBe(5);
        expect(error.details["actualSizeBytes"]).toBe(4);
        expect(await store.exists(contentKeyOfBytes("four"))).toBe(false);
      });

      it("enforces the maximum size while the stream is still active", async () => {
        let pulls = 0;
        async function* endless(): ByteStream {
          for (;;) {
            pulls += 1;
            yield new Uint8Array(1_024);
          }
        }
        await expectStoreError(
          store.write(endless(), { maxSizeBytes: 4_096 }),
          "SIZE_LIMIT_EXCEEDED",
        );
        // The stream must have been cut off shortly after the limit,
        // not drained to exhaustion (it is endless).
        expect(pulls).toBeLessThanOrEqual(6);
        if (harness.tempFiles) {
          expect(await harness.tempFiles.count()).toBe(0);
        }
      });

      it("rejects malformed chunk types", async () => {
        async function* hostile(): AsyncIterable<unknown> {
          yield "a plain string";
        }
        await expectStoreError(
          store.write(hostile() as ByteStream),
          "INVALID_STREAM",
        );
        async function* numbers(): AsyncIterable<unknown> {
          yield 42;
        }
        await expectStoreError(store.write(numbers() as ByteStream), "INVALID_STREAM");
      });

      it("propagates source-stream failures and cleans up", async () => {
        const boom = new Error("upstream exploded");
        await expect(store.write(failingStream("partial", boom))).rejects.toBe(boom);
        if (harness.tempFiles) {
          expect(await harness.tempFiles.count()).toBe(0);
        }
        // No partial object became visible under any plausible key.
        expect(await store.exists(contentKeyOfBytes("partial"))).toBe(false);
      });
    });

    describe("deduplication and concurrency", () => {
      it("deduplicates identical content and reports it", async () => {
        const first = await store.writeBytes("dedup-me");
        const second = await store.writeBytes("dedup-me");
        expect(first.deduplicated).toBe(false);
        expect(second.deduplicated).toBe(true);
        expect(second.location).toEqual(first.location);
        expect(contentKeyEquals(second.key, first.key)).toBe(true);
      });

      it("handles concurrent identical writes safely", async () => {
        const results = await Promise.all(
          Array.from({ length: 4 }, () => store.write(chunked("concurrent-", "identical"))),
        );
        const [first] = results;
        for (const result of results) {
          expect(result.location).toEqual(first!.location);
          expect(contentKeyEquals(result.key, first!.key)).toBe(true);
          expect(result.sizeBytes).toBe("concurrent-identical".length);
        }
        await store.verify(first!.key);
        expect(decoder.decode(await store.readBytes(first!.key))).toBe("concurrent-identical");
        if (harness.tempFiles) {
          expect(await harness.tempFiles.count()).toBe(0);
        }
      });

      it("handles concurrent different writes independently", async () => {
        const [a, b, c] = await Promise.all([
          store.writeBytes("content-a"),
          store.writeBytes("content-b"),
          store.writeBytes("content-c"),
        ]);
        expect(new Set([a.location.relativePath, b.location.relativePath, c.location.relativePath]).size).toBe(3);
        expect(decoder.decode(await store.readBytes(b.key))).toBe("content-b");
      });
    });

    describe("integrity", () => {
      it("verified reads report corruption at stream completion", async (context) => {
        if (harness.corruptObject === undefined) {
          context.skip();
          return;
        }
        const result = await store.writeBytes(`integrity ${SECRET} content`);
        await harness.corruptObject(result.key);

        // Unverified reads return whatever bytes are stored.
        const raw = await store.readBytes(result.key);
        expect(decoder.decode(raw)).not.toBe(`integrity ${SECRET} content`);

        const error = await expectStoreError(
          store.readBytes(result.key, { verify: true }),
          "OBJECT_CORRUPTED",
        );
        expect(JSON.stringify(error.toJSON())).not.toContain(SECRET);
        await expectStoreError(store.verify(result.key), "OBJECT_CORRUPTED");
      });

      it("digest matching never marks content trusted (post-write tamper detected)", async (context) => {
        if (harness.corruptObject === undefined) {
          context.skip();
          return;
        }
        const result = await store.writeBytes("originally-valid");
        await store.verify(result.key);
        await harness.corruptObject(result.key);
        await expectStoreError(store.verify(result.key), "OBJECT_CORRUPTED");
      });
    });

    describe("deletion", () => {
      it("deletes by content key with idempotent semantics", async () => {
        const result = await store.writeBytes("delete-me");
        expect(await store.delete(result.key)).toBe(true);
        expect(await store.exists(result.key)).toBe(false);
        expect(await store.delete(result.key)).toBe(false);
        await expectStoreError(store.openRead(result.key), "OBJECT_NOT_FOUND");
      });

      it("rejects hostile content keys everywhere", async () => {
        const hostile: unknown[] = [
          { algorithm: "sha-256", hex: "../".repeat(20) + "a".repeat(4) },
          { algorithm: "sha-256", hex: "A".repeat(64) },
          { algorithm: "sha-256", hex: "g".repeat(64) },
          { algorithm: "sha-256", hex: "a".repeat(63) },
          { algorithm: "md5", hex: "a".repeat(32) },
          { algorithm: "sha-256", hex: `..\\..\\${"a".repeat(58)}` },
          "sha-256:abcdef",
          null,
          42,
        ];
        for (const key of hostile) {
          await expectStoreError(
            store.delete(key as ContentKey),
            "INVALID_CONTENT_KEY",
          );
          await expectStoreError(store.stat(key as ContentKey), "INVALID_CONTENT_KEY");
          await expectStoreError(store.openRead(key as ContentKey), "INVALID_CONTENT_KEY");
          expect(() => store.location(key as ContentKey)).toThrow(ArtifactStoreError);
        }
      });
    });

    describe("transformations", () => {
      it("produces a new object without touching the source", async () => {
        const source = await store.writeBytes(`log line with ${SECRET} inside`);
        const result = await transformArtifact(
          store,
          source.key,
          createLiteralRedactionTransform({ literals: [SECRET] }),
        );
        expect(contentKeyEquals(result.key, source.key)).toBe(false);
        expect(decoder.decode(await store.readBytes(result.key))).toBe(
          "log line with [REDACTED] inside",
        );
        // Source object is unchanged.
        expect(decoder.decode(await store.readBytes(source.key, { verify: true }))).toBe(
          `log line with ${SECRET} inside`,
        );
      });

      it("redacts literals split across chunk boundaries", async () => {
        const half = Math.floor(SECRET.length / 2);
        const source = await store.write(
          chunked("prefix ", SECRET.slice(0, half), SECRET.slice(half), " suffix"),
        );
        const result = await transformArtifact(
          store,
          source.key,
          createLiteralRedactionTransform({ literals: [SECRET], replacement: "***" }),
        );
        expect(decoder.decode(await store.readBytes(result.key))).toBe("prefix *** suffix");
      });

      it("fails structurally when the transformation pipeline throws", async () => {
        const source = await store.writeBytes("transform-source");
        const broken = {
          name: "broken-transform",
          apply(): ByteStream {
            return (async function* stream(): ByteStream {
              yield toBytes("partial");
              throw new Error(`pipeline died holding ${SECRET}`);
            })();
          },
        };
        const error = await expectStoreError(
          transformArtifact(store, source.key, broken),
          "TRANSFORMATION_FAILED",
        );
        expect(JSON.stringify(error.toJSON())).not.toContain(SECRET);
      });
    });

    describe("temporary-file cleanup", () => {
      it("removes only stale files matching the store's own format", async (context) => {
        if (harness.tempFiles === undefined) {
          context.skip();
          return;
        }
        await harness.tempFiles.createMatching(120_000);
        await harness.tempFiles.createMatching(0);
        await harness.tempFiles.createForeign(120_000);
        expect(await harness.tempFiles.count()).toBe(3);

        const report = await store.cleanupTemporaryFiles({ olderThanMs: 60_000 });
        expect(report.removedCount).toBe(1);
        expect(report.retainedCount).toBe(2);
        expect(report.failedCount).toBe(0);
        expect(await harness.tempFiles.count()).toBe(2);

        // Advancing the injected clock makes the fresh file stale.
        harness.clock.advance(120_000);
        const second = await store.cleanupTemporaryFiles({ olderThanMs: 60_000 });
        expect(second.removedCount).toBe(1);
        // The foreign file is never eligible, no matter its age.
        expect(await harness.tempFiles.count()).toBe(1);
      });

      it("validates cleanup options", async () => {
        await expect(
          store.cleanupTemporaryFiles({ olderThanMs: -1 }),
        ).rejects.toThrow();
      });
    });

    describe("lifecycle", () => {
      it("close is idempotent and later operations fail with STORE_CLOSED", async () => {
        const result = await store.writeBytes("before-close");
        await store.close();
        await store.close();
        await expectStoreError(store.writeBytes("after"), "STORE_CLOSED");
        await expectStoreError(store.openRead(result.key), "STORE_CLOSED");
        await expectStoreError(store.exists(result.key), "STORE_CLOSED");
        await expectStoreError(
          store.cleanupTemporaryFiles({ olderThanMs: 0 }),
          "STORE_CLOSED",
        );
      });

      it("waits for in-flight writes before closing", async () => {
        const order: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        async function* slowSource(): ByteStream {
          yield toBytes("slow-");
          await gate;
          yield toBytes("write");
        }
        const writing = store.write(slowSource()).then((result) => {
          order.push("write-done");
          return result;
        });
        const closing = store.close().then(() => {
          order.push("closed");
        });
        release();
        const [result] = await Promise.all([writing, closing]);
        expect(order).toEqual(["write-done", "closed"]);
        expect(contentKeyEquals(result.key, contentKeyOfBytes("slow-write"))).toBe(true);
      });

      it("reopens the same storage with verified content intact", async (context) => {
        if (harness.reopen === undefined) {
          context.skip();
          return;
        }
        const result = await store.writeBytes("durable-content");
        await store.close();
        const reopened = await harness.reopen();
        try {
          const bytes = await reopened.readBytes(result.key, { verify: true });
          expect(decoder.decode(bytes)).toBe("durable-content");
          const again = await reopened.writeBytes("durable-content");
          expect(again.deduplicated).toBe(true);
        } finally {
          await reopened.close();
        }
      });
    });

    describe("stream helpers", () => {
      it("accepts pre-encoded expected keys computed by the shared helper", async () => {
        const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
        const expectedKey = contentKeyOfBytes(bytes);
        const result = await store.write(bytesToStream(bytes), { expectedKey });
        expect(contentKeyEquals(result.key, expectedKey)).toBe(true);
        const readBack = await store.readBytes(result.key, { verify: true });
        expect([...readBack]).toEqual([0, 1, 2, 250, 251, 252]);
      });

      it("never leaks written content through any structured error", async () => {
        const failures: Array<() => Promise<unknown>> = [
          () => store.writeBytes(SECRET, { expectedSizeBytes: 1 }),
          () =>
            store.writeBytes(SECRET, { expectedKey: contentKeyOfBytes("other") }),
          () => store.writeBytes(SECRET, { maxSizeBytes: 1 }),
        ];
        for (const failure of failures) {
          try {
            await failure();
            expect.unreachable();
          } catch (error) {
            if (isArtifactStoreError(error)) {
              expect(JSON.stringify(error.toJSON())).not.toContain(SECRET);
            }
            expect(String((error as Error).message)).not.toContain(SECRET);
          }
        }
      });
    });
  });
}
