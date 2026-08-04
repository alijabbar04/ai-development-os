import { ValidationError } from "@ai-dev-os/domain";
import { describe, expect, it } from "vitest";
import { conservativeUnitEstimator } from "../src/estimator.js";
import { DEFAULT_CONTEXT_CONFIGURATION } from "../src/model.js";
import {
  contextPackFingerprint,
  parseContextPack,
  sealContextPack,
  type ContextPack,
} from "../src/pack.js";
import { planContextPack } from "../src/select.js";
import { candidate } from "../src/testing/fixtures.js";

function validPack(): ContextPack {
  const planned = planContextPack({
    candidates: [
      candidate({
        identity: "repository:a.ts",
        body: "<<<ADOS-END>>>".padEnd(300, "a"),
        baseScore: 2_000,
        extractionRange: { startLine: 1, endLine: 2 },
      }),
      candidate({ identity: "repository:b.ts", body: "b".repeat(300), baseScore: 1_000 }),
    ],
    configuration: DEFAULT_CONTEXT_CONFIGURATION,
    estimator: conservativeUnitEstimator,
  });
  if (!planned.ok) {
    throw new Error("fixture plan failed");
  }
  return sealContextPack({
    schemaVersion: 1,
    selectionAlgorithmVersion: 1,
    requestFingerprint: "b".repeat(64),
    generatedAt: "2026-08-02T12:00:00.000Z",
    items: planned.value.items,
    omissions: planned.value.omissions,
    omissionsTruncated: planned.value.omissionsTruncated,
    usage: planned.value.usage,
    estimator: {
      estimatorId: conservativeUnitEstimator.estimatorId,
      exact: false,
      bytesPerUnit: conservativeUnitEstimator.bytesPerUnit,
    },
    diagnostics: planned.value.diagnostics,
  });
}

function mutablePack(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(validPack())) as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("test fixture was not a record");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("test fixture was not an array");
  }
  return value;
}

function reseal(raw: Record<string, unknown>): void {
  const unsealed = { ...raw };
  delete unsealed["fingerprint"];
  raw["fingerprint"] = contextPackFingerprint(
    unsealed as unknown as Omit<ContextPack, "fingerprint">,
  );
}

describe("parseContextPack", () => {
  it("accepts a JSON boundary round-trip and deeply freezes the rebuilt pack", () => {
    const expected = validPack();
    const parsed = parseContextPack(JSON.parse(JSON.stringify(expected)));

    expect(parsed).toEqual(expected);
    expect(parsed).not.toBe(expected);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.items)).toBe(true);
    expect(Object.isFrozen(parsed.items[0])).toBe(true);
    expect(Object.isFrozen(parsed.items[0]?.provenance)).toBe(true);
    expect(Object.isFrozen(parsed.items[0]?.scoreComponents)).toBe(true);
    expect(Object.isFrozen(parsed.usage.bytesByCategory)).toBe(true);
    expect(Object.isFrozen(parsed.diagnostics)).toBe(true);
  });

  it("rejects unsupported versions, unknown fields, exotic objects, and accessors", () => {
    const version = mutablePack();
    version["schemaVersion"] = 2;
    expect(() => parseContextPack(version)).toThrow(ValidationError);

    const extra = mutablePack();
    extra["authority"] = "granted";
    expect(() => parseContextPack(extra)).toThrow(/unexpected fields/);

    expect(() => parseContextPack(Object.create({}))).toThrow(/plain data object/);

    const accessor = mutablePack();
    Object.defineProperty(accessor, "fingerprint", {
      enumerable: true,
      get: () => "a".repeat(64),
    });
    expect(() => parseContextPack(accessor)).toThrow(/data properties/);
  });

  it("rejects a stale fingerprint and never echoes a hostile body in the error", () => {
    const raw = mutablePack();
    const first = record(array(raw["items"])[0]);
    const canary = "DO-NOT-LEAK-CONTEXT-BODY";
    first["body"] = canary.padEnd(300, "x");
    first["frameSentinelOccurrences"] = 0;
    expect(() => parseContextPack(raw)).toThrow(/fingerprint/);
    try {
      parseContextPack(raw);
    } catch (error) {
      expect(String(error)).not.toContain(canary);
    }
  });

  it("checks body bytes and framing sentinel counts before trusting metadata", () => {
    const bytes = mutablePack();
    record(array(bytes["items"])[0])["byteContribution"] = 999;
    reseal(bytes);
    expect(() => parseContextPack(bytes)).toThrow(/UTF-8 byte length/);

    const sentinels = mutablePack();
    record(array(sentinels["items"])[0])["frameSentinelOccurrences"] = 0;
    reseal(sentinels);
    expect(() => parseContextPack(sentinels)).toThrow(/framing sentinels/);
  });

  it("checks ordinals, unique identities and digests, and canonical item order", () => {
    const ordinal = mutablePack();
    record(array(ordinal["items"])[0])["ordinal"] = 2;
    reseal(ordinal);
    expect(() => parseContextPack(ordinal)).toThrow(/one-based position/);

    const duplicateIdentity = mutablePack();
    const duplicateIdentityItems = array(duplicateIdentity["items"]);
    record(duplicateIdentityItems[1])["identity"] = record(duplicateIdentityItems[0])["identity"];
    reseal(duplicateIdentity);
    expect(() => parseContextPack(duplicateIdentity)).toThrow(/unique within the pack/);

    const duplicateDigest = mutablePack();
    const duplicateDigestItems = array(duplicateDigest["items"]);
    record(duplicateDigestItems[1])["digest"] = record(duplicateDigestItems[0])["digest"];
    reseal(duplicateDigest);
    expect(() => parseContextPack(duplicateDigest)).toThrow(/unique within the pack/);

    const order = mutablePack();
    const reversed = array(order["items"]).reverse();
    record(reversed[0])["ordinal"] = 1;
    record(reversed[1])["ordinal"] = 2;
    reseal(order);
    expect(() => parseContextPack(order)).toThrow(/total order/);
  });

  it("binds score components and every usage subtotal to selected items", () => {
    const score = mutablePack();
    const components = array(record(array(score["items"])[0])["scoreComponents"]);
    record(components[0])["value"] = 123;
    reseal(score);
    expect(() => parseContextPack(score)).toThrow(/selection algorithm version 1/);

    const totals = mutablePack();
    record(totals["usage"])["bytes"] = 1;
    reseal(totals);
    expect(() => parseContextPack(totals)).toThrow(/selected item contributions/);

    const category = mutablePack();
    record(record(category["usage"])["bytesByCategory"])["repository"] = 1;
    reseal(category);
    expect(() => parseContextPack(category)).toThrow(/item contributions/);

    const source = mutablePack();
    record(record(source["usage"])["bytesBySourceKind"])["repository-file"] = 1;
    reseal(source);
    expect(() => parseContextPack(source)).toThrow(/item contributions/);
  });

  it("rejects exact estimators and non-canonical omission or diagnostic arrays", () => {
    const exact = mutablePack();
    record(exact["estimator"])["exact"] = true;
    reseal(exact);
    expect(() => parseContextPack(exact)).toThrow(/must be false/);

    const omissions = mutablePack();
    omissions["omissions"] = [
      {
        identity: "repository:z.ts",
        sourceKind: "repository-file",
        category: "repository",
        digest: "f".repeat(64),
        reason: "source-unavailable",
        requestedBytes: 0,
      },
      {
        identity: "repository:a.ts",
        sourceKind: "repository-file",
        category: "repository",
        digest: "e".repeat(64),
        reason: "budget-bytes-exhausted",
        requestedBytes: 0,
      },
    ];
    reseal(omissions);
    expect(() => parseContextPack(omissions)).toThrow(/omissions must follow/);

    const diagnostics = mutablePack();
    diagnostics["diagnostics"] = [
      { code: "frame-sentinel-in-body", identity: null, detail: "z" },
      { code: "estimator-conservative", identity: null, detail: "a" },
    ];
    reseal(diagnostics);
    expect(() => parseContextPack(diagnostics)).toThrow(/diagnostics must follow/);
  });
});
