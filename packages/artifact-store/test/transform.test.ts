import { describe, expect, it } from "vitest";
import {
  ArtifactStoreError,
  bytesToStream,
  collectBytes,
  contentKeyOfBytes,
  createLiteralRedactionTransform,
  isArtifactStoreError,
  toBytes,
  transformArtifact,
  type ArtifactByteStore,
  type ByteStream,
  type ContentKey,
  type WriteResult,
} from "../src/index.js";

const decoder = new TextDecoder();

async function applyToChunks(
  transformation: { apply(source: ByteStream): ByteStream },
  ...parts: ReadonlyArray<string | Uint8Array>
): Promise<string> {
  async function* source(): ByteStream {
    for (const part of parts) {
      yield toBytes(part);
    }
  }
  return decoder.decode(await collectBytes(transformation.apply(source()), 1_000_000));
}

describe("createLiteralRedactionTransform", () => {
  it("replaces every occurrence of each supplied literal", async () => {
    const transform = createLiteralRedactionTransform({
      literals: ["secret-a", "secret-b"],
      replacement: "#",
    });
    expect(await applyToChunks(transform, "x secret-a y secret-b z secret-a")).toBe(
      "x # y # z #",
    );
  });

  it("matches literals split across chunk boundaries", async () => {
    const transform = createLiteralRedactionTransform({ literals: ["SECRETVALUE"] });
    expect(await applyToChunks(transform, "aa SEC", "RETVA", "LUE bb")).toBe(
      "aa [REDACTED] bb",
    );
    expect(await applyToChunks(transform, "S", "E", "C", "R", "E", "T", "V", "A", "L", "U", "E")).toBe(
      "[REDACTED]",
    );
  });

  it("handles adjacent, trailing, and empty-replacement matches", async () => {
    const transform = createLiteralRedactionTransform({
      literals: ["ab"],
      replacement: "",
    });
    expect(await applyToChunks(transform, "abab")).toBe("");
    expect(await applyToChunks(transform, "xab")).toBe("x");
    expect(await applyToChunks(transform, "abx")).toBe("x");
    expect(await applyToChunks(transform, "a")).toBe("a");
    expect(await applyToChunks(transform, "")).toBe("");
  });

  it("passes binary content through except exact byte matches", async () => {
    const transform = createLiteralRedactionTransform({ literals: ["ab"], replacement: "-" });
    const binary = new Uint8Array([0, 1, 2, 0x61, 0x62, 3, 255]);
    async function* source(): ByteStream {
      yield binary;
    }
    const output = await collectBytes(transform.apply(source()), 100);
    expect([...output]).toEqual([0, 1, 2, 0x2d, 3, 255]);
  });

  it("rejects invalid rule sets", () => {
    expect(() => createLiteralRedactionTransform({ literals: [] })).toThrow(
      ArtifactStoreError,
    );
    expect(() =>
      createLiteralRedactionTransform({ literals: Array.from({ length: 65 }, (_, i) => `s${i}`) }),
    ).toThrow(ArtifactStoreError);
    expect(() => createLiteralRedactionTransform({ literals: [""] })).toThrow();
    expect(() =>
      createLiteralRedactionTransform({ literals: ["x".repeat(1_025)] }),
    ).toThrow();
    expect(() =>
      createLiteralRedactionTransform({ literals: [42 as never] }),
    ).toThrow();
  });

  it("validates malformed chunks flowing through the pipeline", async () => {
    const transform = createLiteralRedactionTransform({ literals: ["x"] });
    async function* hostile(): AsyncIterable<unknown> {
      yield "not bytes";
    }
    await expect(
      collectBytes(transform.apply(hostile() as ByteStream), 100),
    ).rejects.toMatchObject({ code: "INVALID_STREAM" });
  });
});

describe("transformArtifact", () => {
  function fakeStore(objects: Map<string, Uint8Array>): ArtifactByteStore {
    const write = async (source: ByteStream): Promise<WriteResult> => {
      const bytes = await collectBytes(source, 1_000_000);
      const key = contentKeyOfBytes(bytes);
      const existed = objects.has(key.hex);
      objects.set(key.hex, bytes);
      return Object.freeze({
        key,
        sizeBytes: bytes.byteLength,
        location: Object.freeze({
          layoutVersion: 1 as const,
          relativePath: `v1/sha-256/${key.hex.slice(0, 2)}/${key.hex}`,
        }),
        deduplicated: existed,
        artifactId: null,
      });
    };
    return {
      write,
      writeBytes: (value, options) => write(bytesToStream(value)),
      openRead: async (key) => {
        const bytes = objects.get(key.hex);
        if (bytes === undefined) {
          throw new ArtifactStoreError("OBJECT_NOT_FOUND", "missing");
        }
        return bytesToStream(bytes);
      },
      readBytes: async (key) => {
        const bytes = objects.get(key.hex);
        if (bytes === undefined) {
          throw new ArtifactStoreError("OBJECT_NOT_FOUND", "missing");
        }
        return bytes;
      },
      exists: async (key) => objects.has(key.hex),
      stat: async () => null,
      verify: async () => undefined,
      delete: async () => false,
      location: (key) => ({
        layoutVersion: 1 as const,
        relativePath: `v1/sha-256/${key.hex.slice(0, 2)}/${key.hex}`,
      }),
      cleanupTemporaryFiles: async () => ({ removedCount: 0, retainedCount: 0, failedCount: 0 }),
      close: async () => undefined,
    };
  }

  it("writes transformed output as a new object", async () => {
    const objects = new Map<string, Uint8Array>();
    const store = fakeStore(objects);
    const source = await store.writeBytes("keep secret-x here");
    const result = await transformArtifact(
      store,
      source.key,
      createLiteralRedactionTransform({ literals: ["secret-x"], replacement: "?" }),
    );
    expect(decoder.decode(objects.get(result.key.hex)!)).toBe("keep ? here");
    expect(decoder.decode(objects.get(source.key.hex)!)).toBe("keep secret-x here");
  });

  it("validates the source key and transformation name", async () => {
    const store = fakeStore(new Map());
    const good = createLiteralRedactionTransform({ literals: ["x"] });
    await expect(
      transformArtifact(store, { algorithm: "sha-256", hex: "zz" } as never, good),
    ).rejects.toMatchObject({ code: "INVALID_CONTENT_KEY" });
    const source = await store.writeBytes("content");
    await expect(
      transformArtifact(store, source.key, { name: "Bad Name!", apply: good.apply }),
    ).rejects.toThrow();
  });

  it("wraps apply-time and pipeline failures as TRANSFORMATION_FAILED", async () => {
    const store = fakeStore(new Map());
    const source = await store.writeBytes("content");
    const throwsOnApply = {
      name: "explodes-on-apply",
      apply(): ByteStream {
        throw new Error("cannot start");
      },
    };
    await expect(transformArtifact(store, source.key, throwsOnApply)).rejects.toMatchObject({
      code: "TRANSFORMATION_FAILED",
    });

    const failsMidStream = {
      name: "explodes-mid-stream",
      apply(): ByteStream {
        return (async function* stream(): ByteStream {
          yield toBytes("partial");
          throw new Error("mid-stream failure");
        })();
      },
    };
    const error = await transformArtifact(store, source.key, failsMidStream).catch((e: unknown) => e);
    expect(isArtifactStoreError(error, "TRANSFORMATION_FAILED")).toBe(true);
    expect((error as ArtifactStoreError).details["transformation"]).toBe("explodes-mid-stream");
  });

  it("passes through store errors from the write unchanged", async () => {
    const store = fakeStore(new Map());
    const source = await store.writeBytes("content");
    const brokenStore: ArtifactByteStore = {
      ...store,
      write: async () => {
        throw new ArtifactStoreError("STORE_CLOSED", "closed");
      },
    };
    await expect(
      transformArtifact(brokenStore, source.key, createLiteralRedactionTransform({ literals: ["x"] })),
    ).rejects.toMatchObject({ code: "STORE_CLOSED" });
  });
});
