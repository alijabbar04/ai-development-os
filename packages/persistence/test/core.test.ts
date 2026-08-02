import { describe, expect, it } from "vitest";
import { SerializationError, ValidationError } from "@ai-dev-os/domain";
import {
  AsyncMutex,
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  buildPage,
  canonicalizeWithChecksum,
  checksumEquals,
  computeChecksumOfText,
  decodeCursor,
  encodeCursor,
  isPersistenceError,
  normalizePageSize,
  parseChecksum,
  verifyChecksum,
} from "../src/index.js";

describe("PersistenceError", () => {
  it("carries a code, frozen details, and safe serialization", () => {
    const error = new PersistenceError("NOT_FOUND", "Missing.", { aggregateId: "a-1" });
    expect(error.code).toBe("NOT_FOUND");
    expect(Object.isFrozen(error.details)).toBe(true);
    expect(error.toJSON()).toEqual({
      name: "PersistenceError",
      code: "NOT_FOUND",
      message: "Missing.",
      details: { aggregateId: "a-1" },
    });
    expect(PERSISTENCE_ERROR_CODES).toContain("CORRUPTION_DETECTED");
    expect(isPersistenceError(error)).toBe(true);
    expect(isPersistenceError(error, "NOT_FOUND")).toBe(true);
    expect(isPersistenceError(error, "DUPLICATE_ID")).toBe(false);
    expect(isPersistenceError(new Error("plain"))).toBe(false);
  });
});

describe("checksums", () => {
  it("computes deterministic sha-256 checksums over canonical text", () => {
    const first = canonicalizeWithChecksum({ b: 1, a: 2 });
    const second = canonicalizeWithChecksum({ a: 2, b: 1 });
    expect(first.text).toBe('{"a":2,"b":1}');
    expect(first.checksum).toEqual(second.checksum);
    expect(first.checksum.algorithm).toBe("sha-256");
    expect(first.checksum.hex).toMatch(/^[0-9a-f]{64}$/);
    expect(checksumEquals(first.checksum, second.checksum)).toBe(true);
    expect(
      checksumEquals(first.checksum, computeChecksumOfText("other")),
    ).toBe(false);
  });

  it("verifies matching checksums and rejects substitution without leaking content", () => {
    const { text, checksum } = canonicalizeWithChecksum({ secret: "sk-hidden-123" });
    expect(() =>
      verifyChecksum(text, checksum, { recordKind: "aggregate", recordId: "a-1" }),
    ).not.toThrow();

    const substituted = computeChecksumOfText("something-else");
    try {
      verifyChecksum(text, substituted, { recordKind: "aggregate", recordId: "a-1" });
      expect.unreachable();
    } catch (error) {
      expect(isPersistenceError(error, "CORRUPTION_DETECTED")).toBe(true);
      const serialized = JSON.stringify((error as PersistenceError).toJSON());
      expect(serialized).not.toContain("sk-hidden-123");
      expect(serialized).toContain("a-1");
    }
  });

  it("rejects malformed checksum records and non-canonical payloads", () => {
    expect(() => parseChecksum({ algorithm: "md5", hex: "a".repeat(32) })).toThrow(
      ValidationError,
    );
    expect(() => parseChecksum({ algorithm: "sha-256", hex: "A".repeat(64) })).toThrow(
      ValidationError,
    );
    expect(() => parseChecksum(null)).toThrow(ValidationError);
    expect(() => canonicalizeWithChecksum({ bad: Number.POSITIVE_INFINITY })).toThrow(
      SerializationError,
    );
  });
});

describe("cursors and pagination", () => {
  it("round-trips both cursor kinds", () => {
    const stringCursor = decodeCursor(
      encodeCursor({ kind: "string-key", lastKey: "proj-b" }),
      "string-key",
    );
    expect(stringCursor).toEqual({ kind: "string-key", lastKey: "proj-b" });
    const sequenceCursor = decodeCursor(
      encodeCursor({ kind: "sequence", lastSequence: 41 }),
      "sequence",
    );
    expect(sequenceCursor).toEqual({ kind: "sequence", lastSequence: 41 });
  });

  it("rejects malformed, oversized, mismatched, and hostile cursors", () => {
    const hostile: unknown[] = [
      "",
      "not base64 json",
      Buffer.from("[1,2,3]").toString("base64url"),
      Buffer.from('{"kind":"sequence","lastSequence":-1}').toString("base64url"),
      Buffer.from('{"kind":"sequence","lastSequence":1.5}').toString("base64url"),
      Buffer.from('{"kind":"string-key","lastKey":"x","extra":1}').toString("base64url"),
      Buffer.from('{"kind":"unknown"}').toString("base64url"),
      Buffer.from('{"__proto__":{"kind":"sequence"}}').toString("base64url"),
      "x".repeat(2_000),
      42,
      null,
    ];
    for (const cursor of hostile) {
      expect(() => decodeCursor(cursor, "sequence")).toThrow(PersistenceError);
    }
    expect(() =>
      decodeCursor(encodeCursor({ kind: "sequence", lastSequence: 1 }), "string-key"),
    ).toThrow(PersistenceError);
  });

  it("normalizes page sizes with bounds", () => {
    expect(normalizePageSize(undefined)).toBe(100);
    expect(normalizePageSize(null)).toBe(100);
    expect(normalizePageSize(5)).toBe(5);
    expect(normalizePageSize(1_000)).toBe(1_000);
    expect(() => normalizePageSize(0)).toThrow(ValidationError);
    expect(() => normalizePageSize(1_001)).toThrow(ValidationError);
    expect(() => normalizePageSize(2.5)).toThrow(ValidationError);
  });

  it("builds pages with a next cursor only when more items exist", () => {
    const cursorOf = (item: string) => ({ kind: "string-key", lastKey: item }) as const;
    const exact = buildPage(["a", "b"], 2, cursorOf);
    expect(exact.items).toEqual(["a", "b"]);
    expect(exact.nextCursor).toBeNull();

    const more = buildPage(["a", "b", "c"], 2, cursorOf);
    expect(more.items).toEqual(["a", "b"]);
    expect(decodeCursor(more.nextCursor, "string-key").lastKey).toBe("b");

    const empty = buildPage([], 2, cursorOf);
    expect(empty.items).toEqual([]);
    expect(empty.nextCursor).toBeNull();
  });
});

describe("AsyncMutex", () => {
  it("serializes work in submission order and survives failures", async () => {
    const mutex = new AsyncMutex();
    const order: string[] = [];
    const slow = mutex.run(async () => {
      order.push("slow-start");
      await Promise.resolve();
      await Promise.resolve();
      order.push("slow-end");
      return 1;
    });
    const failing = mutex.run(() => {
      order.push("failing");
      throw new Error("nope");
    });
    const fast = mutex.run(() => {
      order.push("fast");
      return 3;
    });
    await expect(slow).resolves.toBe(1);
    await expect(failing).rejects.toThrow("nope");
    await expect(fast).resolves.toBe(3);
    expect(order).toEqual(["slow-start", "slow-end", "failing", "fast"]);
  });
});
