import { describe, expect, it } from "vitest";
import { defineProjectionSchema, serializeProjection, type ProjectionRule } from "../src/index.js";

const NORMAL_SCHEMA = defineProjectionSchema("health", {
  active: { kind: "boolean" },
  attempts: { kind: "integer", minimum: -2, maximum: 4 },
  confidenceBps: { kind: "basis-points" },
  detail: { kind: "object", fields: { healthy: { kind: "boolean" } } },
  itemCount: { kind: "count", maximum: 100 },
  observedAt: { kind: "timestamp" },
  optionalReset: { kind: "nullable", value: { kind: "timestamp" } },
  policyRule: { kind: "rule-id" },
  profileId: { kind: "profile-id" },
  state: { kind: "enum", values: ["stale", "ready"] },
  tags: { kind: "array", maximumItems: 3, item: { kind: "identifier" } },
});

function normalInput(): Record<string, unknown> {
  return {
    tags: ["alpha", "beta"],
    state: "ready",
    profileId: "profile:owned-main",
    policyRule: "AL-5",
    optionalReset: null,
    observedAt: "2026-08-25T13:59:00.000Z",
    itemCount: 2,
    detail: { healthy: true },
    confidenceBps: 9_875,
    attempts: -0,
    active: true,
  };
}

describe("projection allowlist serializer", () => {
  it("serializes every structural rule into stable sorted JSON data", () => {
    const first = serializeProjection(NORMAL_SCHEMA, normalInput(), {
      audience: "normal", profileScope: "profile:owned-main",
    });
    const reordered = normalInput();
    const second = serializeProjection(NORMAL_SCHEMA, reordered, {
      profileScope: "profile:owned-main", audience: "normal",
    });
    expect(first).toEqual(second);
    expect(Object.keys(first)).toEqual([...Object.keys(first)].sort());
    expect(first["attempts"]).toBe(0);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("rejects unknown and missing fields instead of spreading them", () => {
    expect(() => serializeProjection(NORMAL_SCHEMA, { ...normalInput(), extra: true }, {
      audience: "normal", profileScope: "profile:owned-main",
    })).toThrow(/unexpected fields/u);
    const missing = normalInput();
    delete missing["active"];
    expect(() => serializeProjection(NORMAL_SCHEMA, missing, {
      audience: "normal", profileScope: "profile:owned-main",
    })).toThrow(/required/u);
  });

  it("enforces integer, count, basis-point, timestamp, enum, identifier, and array bounds", () => {
    const cases: Array<[string, unknown]> = [
      ["attempts", 5], ["itemCount", -1], ["confidenceBps", 10_001],
      ["observedAt", "2026-08-25"], ["state", "unknown"],
      ["policyRule", "lowercase"], ["tags", ["one", "two", "three", "four"]],
    ];
    for (const [key, value] of cases) {
      expect(() => serializeProjection(NORMAL_SCHEMA, { ...normalInput(), [key]: value }, {
        audience: "normal", profileScope: "profile:owned-main",
      })).toThrow();
    }
    expect(() => serializeProjection(NORMAL_SCHEMA, { ...normalInput(), tags: ["contains spaces"] }, {
      audience: "normal", profileScope: "profile:owned-main",
    })).toThrow(/bounded identifier/u);
  });

  it("refuses cross-profile data in Normal mode and permits scoped data", () => {
    expect(() => serializeProjection(NORMAL_SCHEMA, normalInput(), { audience: "normal" })).toThrow(/profile scope/u);
    expect(() => serializeProjection(NORMAL_SCHEMA, normalInput(), {
      audience: "normal", profileScope: "profile:other",
    })).toThrow(/profile scope/u);
    expect(serializeProjection(NORMAL_SCHEMA, normalInput(), {
      audience: "normal", profileScope: "profile:owned-main",
    })["profileId"]).toBe("profile:owned-main");
  });

  it("allows explicit path and fingerprint fields only for Developer projections", () => {
    const schema = defineProjectionSchema("diagnostic", {
      sourceFingerprint: { kind: "source-fingerprint" },
      workspacePath: { kind: "developer-path" },
    });
    const input = { sourceFingerprint: "a".repeat(64), workspacePath: "C:\\bounded\\workspace" };
    expect(serializeProjection(schema, input, { audience: "developer" })).toEqual(input);
    expect(() => serializeProjection(schema, input, { audience: "normal" })).toThrow(/Normal mode/u);
    expect(() => serializeProjection(schema, { ...input, workspacePath: "relative\\workspace" }, { audience: "developer" })).toThrow(/absolute path/u);
    expect(() => serializeProjection(schema, { ...input, sourceFingerprint: "short" }, { audience: "developer" })).toThrow(/between 64 and 64/u);
  });

  it("rejects absolute-path and credential canaries before scalar projection", () => {
    const stateOnly = defineProjectionSchema("state", { state: { kind: "enum", values: ["ready"] } });
    expect(() => serializeProjection(stateOnly, { state: "C:\\private\\file" }, { audience: "normal" })).toThrow(/absolute path/u);
    const credentialCanary = ["sk", "ant", "api03", "A".repeat(30)].join("-");
    expect(() => serializeProjection(stateOnly, { state: credentialCanary }, { audience: "normal" })).toThrow(/credential-shaped/u);
  });

  it("refuses owner identity, credential fields, implicit paths, and model-text schema kinds", () => {
    expect(() => defineProjectionSchema("bad", { borrowedOwnerIdentity: { kind: "identifier" } })).toThrow(/owner-identity/u);
    expect(() => defineProjectionSchema("bad", { apiKey: { kind: "identifier" } })).toThrow(/credential/u);
    expect(() => defineProjectionSchema("bad", { workspacePath: { kind: "identifier" } })).toThrow(/developer-path/u);
    expect(() => defineProjectionSchema("bad", { sourceFingerprint: { kind: "identifier" } })).toThrow(/source-fingerprint/u);
    expect(() => defineProjectionSchema("bad", { narrative: { kind: "string" } as unknown as ProjectionRule })).toThrow(/must be one of/u);
  });

  it("refuses functions, accessors, proxies, abnormal prototypes, symbols, cycles, and custom arrays", () => {
    expect(() => serializeProjection(NORMAL_SCHEMA, { ...normalInput(), active: () => true }, {
      audience: "normal", profileScope: "profile:owned-main",
    })).toThrow(/boolean/u);

    const accessor = normalInput();
    Object.defineProperty(accessor, "active", { enumerable: true, get: () => true });
    expect(() => serializeProjection(NORMAL_SCHEMA, accessor, {
      audience: "normal", profileScope: "profile:owned-main",
    })).toThrow(/data fields/u);

    expect(() => serializeProjection(NORMAL_SCHEMA, new Proxy(normalInput(), {}), {
      audience: "normal", profileScope: "profile:owned-main",
    })).toThrow(/proxy/u);

    const exotic = Object.assign(Object.create({ inherited: true }) as object, normalInput());
    expect(() => serializeProjection(NORMAL_SCHEMA, exotic, {
      audience: "normal", profileScope: "profile:owned-main",
    })).toThrow(/custom prototype/u);

    const symbol = normalInput();
    Object.defineProperty(symbol, Symbol("hidden"), { enumerable: true, value: true });
    expect(() => serializeProjection(NORMAL_SCHEMA, symbol, {
      audience: "normal", profileScope: "profile:owned-main",
    })).toThrow(/symbol-keyed/u);

    const cycle = normalInput();
    cycle["detail"] = cycle;
    expect(() => serializeProjection(NORMAL_SCHEMA, cycle, {
      audience: "normal", profileScope: "profile:owned-main",
    })).toThrow(/cyclic/u);

    const customArray = ["alpha"];
    Object.defineProperty(customArray, "extra", { enumerable: true, value: true });
    expect(() => serializeProjection(NORMAL_SCHEMA, { ...normalInput(), tags: customArray }, {
      audience: "normal", profileScope: "profile:owned-main",
    })).toThrow(/dense/u);

    expect(() => serializeProjection(NORMAL_SCHEMA, { ...normalInput(), tags: new Proxy(["alpha"], {}) }, {
      audience: "normal", profileScope: "profile:owned-main",
    })).toThrow(/proxy/u);
  });

  it("bounds hostile schemas, nesting, options, and field sets", () => {
    expect(() => defineProjectionSchema("bad schema", { active: { kind: "boolean" } })).toThrow(/bounded identifier/u);
    expect(() => defineProjectionSchema("empty", {})).toThrow(/between 1 and/u);
    expect(() => defineProjectionSchema("bad", { Upper: { kind: "boolean" } })).toThrow(/camel-case/u);
    expect(() => defineProjectionSchema("bad", { value: { kind: "integer", minimum: 2, maximum: 1 } })).toThrow(/minimum cannot exceed/u);
    expect(() => defineProjectionSchema("bad", { value: { kind: "enum", values: [] } })).toThrow(/at least one/u);
    expect(() => defineProjectionSchema("bad", { value: { kind: "enum", values: ["same", "same"] } })).toThrow(/duplicate/u);
    expect(() => defineProjectionSchema("bad", { values: { kind: "array", maximumItems: 101, item: { kind: "boolean" } } })).toThrow(/safe integer/u);
    expect(() => defineProjectionSchema("bad", new Proxy({ active: { kind: "boolean" } }, {}))).toThrow(/proxy/u);
    expect(() => serializeProjection(NORMAL_SCHEMA, normalInput(), { audience: "other" as "normal" })).toThrow(/must be one of/u);
    expect(() => serializeProjection(NORMAL_SCHEMA, normalInput(), { audience: "normal", profileScope: "profile:owned-main", extra: true } as never)).toThrow(/unexpected fields/u);

    let rule: ProjectionRule = { kind: "boolean" };
    for (let index = 0; index < 12; index += 1) rule = { kind: "nullable", value: rule };
    expect(() => defineProjectionSchema("deep", { value: rule })).toThrow(/depth limit/u);

    const fields: Record<string, ProjectionRule> = {};
    for (let index = 0; index < 65; index += 1) fields[`field${index}`] = { kind: "boolean" };
    expect(() => defineProjectionSchema("wide", fields)).toThrow(/between 1 and/u);
  });
});
