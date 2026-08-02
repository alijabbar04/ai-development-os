import { describe, expect, it } from "vitest";
import {
  JSON_LIMITS,
  SerializationError,
  canonicalizeJson,
  jsonEquals,
  parseJsonText,
  toCanonicalJson,
} from "../src/index.js";

describe("canonical JSON", () => {
  it("sorts keys deterministically regardless of insertion order", () => {
    const a = { b: 1, a: { z: true, y: [1, 2] } };
    const b = { a: { y: [1, 2], z: true }, b: 1 };
    expect(toCanonicalJson(a)).toBe(toCanonicalJson(b));
    expect(toCanonicalJson(a)).toBe('{"a":{"y":[1,2],"z":true},"b":1}');
  });

  it("normalizes -0 to 0 and preserves primitives", () => {
    expect(toCanonicalJson({ n: -0 })).toBe('{"n":0}');
    expect(toCanonicalJson(null)).toBe("null");
    expect(toCanonicalJson("text")).toBe('"text"');
    expect(toCanonicalJson(true)).toBe("true");
  });

  it("freezes canonicalized structures with null prototypes", () => {
    const value = canonicalizeJson({ nested: { x: 1 }, list: [1, { y: 2 }] }) as Record<
      string,
      unknown
    >;
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value["nested"])).toBe(true);
    expect(Object.isFrozen(value["list"])).toBe(true);
    expect(Object.getPrototypeOf(value)).toBeNull();
  });

  it("rejects NaN, Infinity, functions, undefined, bigint, and symbols", () => {
    expect(() => toCanonicalJson({ x: Number.NaN })).toThrow(SerializationError);
    expect(() => toCanonicalJson({ x: Number.POSITIVE_INFINITY })).toThrow(SerializationError);
    expect(() => toCanonicalJson({ x: () => 1 })).toThrow(SerializationError);
    expect(() => toCanonicalJson({ x: undefined })).toThrow(SerializationError);
    expect(() => toCanonicalJson({ x: 10n })).toThrow(SerializationError);
    expect(() => toCanonicalJson({ x: Symbol("s") })).toThrow(SerializationError);
  });

  it("rejects cyclic references", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => toCanonicalJson(cyclic)).toThrow(SerializationError);
  });

  it("allows repeated (non-cyclic) references to the same object", () => {
    const shared = { v: 1 };
    expect(toCanonicalJson({ a: shared, b: shared })).toBe('{"a":{"v":1},"b":{"v":1}}');
  });

  it("rejects prototype pollution keys and exotic objects", () => {
    expect(() => canonicalizeJson(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow(
      SerializationError,
    );
    expect(() => canonicalizeJson(JSON.parse('{"constructor":1}'))).toThrow(SerializationError);
    expect(() => canonicalizeJson(new Date())).toThrow(SerializationError);
    expect(() => canonicalizeJson(new Map())).toThrow(SerializationError);
  });

  it("enforces depth, node, and string limits", () => {
    let deep: unknown = 1;
    for (let index = 0; index <= JSON_LIMITS.maxDepth + 1; index += 1) {
      deep = { next: deep };
    }
    expect(() => toCanonicalJson(deep)).toThrow(SerializationError);

    const wide = Array.from({ length: JSON_LIMITS.maxNodes + 1 }, (_, index) => index);
    expect(() => toCanonicalJson(wide)).toThrow(SerializationError);

    expect(() => toCanonicalJson("x".repeat(JSON_LIMITS.maxStringLength + 1))).toThrow(
      SerializationError,
    );
  });

  it("round-trips through parseJsonText", () => {
    const original = { z: [3, 2, 1], a: "text", flag: false, none: null };
    const text = toCanonicalJson(original);
    const parsed = parseJsonText(text);
    expect(toCanonicalJson(parsed)).toBe(text);
  });

  it("rejects malformed and oversized JSON text", () => {
    expect(() => parseJsonText("{not json")).toThrow(SerializationError);
    expect(() => parseJsonText('{"__proto__": 1}')).toThrow(SerializationError);
    expect(() => parseJsonText(123 as unknown as string)).toThrow(SerializationError);
  });

  it("jsonEquals compares by value, not identity or key order", () => {
    expect(jsonEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(jsonEquals({ a: 1 }, { a: 2 })).toBe(false);
  });
});
