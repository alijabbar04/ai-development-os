import type { JsonValue } from "@ai-dev-os/domain";
import { ProviderError } from "@ai-dev-os/providers";
import { describe, expect, it } from "vitest";
import { assertStructuredOutputMatchesSchema } from "../src/structured-schema.js";

function accepts(schema: JsonValue, value: JsonValue): void {
  expect(() => assertStructuredOutputMatchesSchema(schema, value)).not.toThrow();
}

function rejects(schema: JsonValue, value: JsonValue, code: string): void {
  try {
    assertStructuredOutputMatchesSchema(schema, value);
    throw new Error("expected schema rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: "MALFORMED_RESPONSE", details: { violationCode: code } });
  }
}

function rejectsSchema(schema: JsonValue, code: string, value: JsonValue = null): void {
  try {
    assertStructuredOutputMatchesSchema(schema, value);
    throw new Error("expected malformed schema rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: "INVALID_REQUEST", details: { violationCode: code } });
  }
}

describe("Anthropic caller-schema enforcement", () => {
  it("rejects an invalid root and hostile unsupported schema keywords", () => {
    rejectsSchema(true as JsonValue, "invalid-root");
    rejectsSchema({ type: "object", unevaluatedProperties: false }, "unsupported-keyword");
    rejectsSchema({ type: "object", properties: { x: 7 as unknown as JsonValue } }, "invalid-schema");
  });

  it("enforces scalar types, type unions, const, and enum", () => {
    accepts({ type: "number" }, 1);
    accepts({ type: ["null", "string"] }, null);
    accepts({ type: "array" }, []);
    accepts({ type: "boolean" }, true);
    rejects({ type: "integer" }, 1.5, "type");
    rejects({ const: { a: [1, 2] } }, { a: [1, 3] }, "const");
    accepts({ enum: [{ a: 1 }, "x"] }, { a: 1 });
    rejects({ enum: ["x", "y"] }, "z", "enum");
  });

  it("enforces composition and negation", () => {
    accepts({ anyOf: [{ type: "string" }, { type: "integer" }] }, 2);
    rejects({ anyOf: [{ type: "string" }, { type: "boolean" }] }, 2, "anyOf");
    accepts({ oneOf: [{ type: "string" }, { type: "integer" }] }, "ok");
    rejects({ oneOf: [{ type: "number" }, { type: "integer" }] }, 2, "oneOf");
    rejectsSchema({ oneOf: [] }, "invalid-oneOf");
    accepts({ allOf: [{ type: "number" }, { minimum: 1 }] }, 2);
    rejectsSchema({ allOf: "bad" as unknown as JsonValue }, "invalid-allOf");
    rejects({ not: { type: "string" } }, "blocked", "not");
    accepts({ not: { type: "string" } }, 1);
  });

  it("enforces string bounds and rejects caller regular expressions before evaluation", () => {
    accepts({ type: "string", minLength: 2, maxLength: 4 }, "abc");
    accepts({ type: "string", minLength: 1, maxLength: 1 }, "😀");
    rejects({ type: "string", minLength: 2 }, "a", "minLength");
    rejects({ type: "string", maxLength: 2 }, "abc", "maxLength");
    rejectsSchema({ type: "string", pattern: "^(a|aa)+$" }, "unsupported-keyword");
  });

  it("enforces numeric bounds and rejects non-exact multiple semantics before evaluation", () => {
    accepts({ type: "number", minimum: 1, maximum: 3 }, 2.5);
    rejects({ minimum: 2 }, 1, "minimum");
    rejects({ maximum: 2 }, 3, "maximum");
    rejects({ exclusiveMinimum: 2 }, 2, "exclusiveMinimum");
    rejects({ exclusiveMaximum: 2 }, 2, "exclusiveMaximum");
    rejectsSchema({ type: "number", multipleOf: 1 }, "unsupported-keyword", 1.000_000_000_5);
  });

  it("enforces array size, prefix, and remaining item schemas", () => {
    accepts({ type: "array", minItems: 2, maxItems: 3, prefixItems: [{ const: "head" }], items: { type: "integer" } }, ["head", 2]);
    rejects({ type: "array", minItems: 2 }, [1], "minItems");
    rejects({ type: "array", maxItems: 1 }, [1, 2], "maxItems");
    rejects({ type: "array", prefixItems: [{ type: "string" }] }, [1], "type");
    rejects({ type: "array", items: { type: "string" } }, ["x", 1], "type");
  });

  it("enforces object required/properties/additionalProperties recursively", () => {
    const schema = {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } },
      additionalProperties: { type: "integer" },
    } as const;
    accepts(schema, { name: "ok", count: 2 });
    rejects(schema, { count: 2 }, "required");
    rejects(schema, { name: "ok", count: "bad" }, "type");
    rejects({ type: "object", additionalProperties: false }, { extra: true }, "additionalProperties");
  });

  it("resolves local root and definition references and refuses external or absent references", () => {
    accepts({ $defs: { item: { type: "string" } }, $ref: "#/$defs/item" }, "ok");
    accepts({ definitions: { item: { type: "integer" } }, properties: { x: { $ref: "#/definitions/item" } } }, { x: 1 });
    accepts({ anyOf: [{ type: "null" }, { $ref: "#" }] }, null);
    rejectsSchema({ $ref: "https://example.invalid/schema" }, "unresolvable-ref");
    rejectsSchema({ $ref: "#/$defs/missing", $defs: {} }, "unresolvable-ref");
    accepts({ $defs: { text: { type: "string" } }, $ref: "#/$defs/text", minLength: 2 }, "ok");
    rejects({ $defs: { text: { type: "string" } }, $ref: "#/$defs/text", minLength: 2 }, "x", "minLength");
  });

  it("bounds recursive schemas", () => {
    const recursive: Record<string, JsonValue> = { type: "object" };
    recursive["properties"] = { next: { $ref: "#" } };
    let value: JsonValue = {};
    for (let index = 0; index < 40; index += 1) value = { next: value };
    rejects(recursive, value, "schema-too-deep");
    rejects({ properties: { x: false } }, { x: 1 }, "forbidden");
    accepts({ properties: { x: true } }, { x: 1 });
  });

  it("rejects malformed supported keyword values and bounded collection exhaustion", () => {
    const malformed: Array<[JsonValue, string]> = [
      [{ type: "object", properties: "invalid" as unknown as JsonValue }, "invalid-properties"],
      [{ type: "object", required: "name" as unknown as JsonValue }, "invalid-required"],
      [{ type: "string", minLength: "1" as unknown as JsonValue }, "invalid-minLength"],
      [{ type: "array", items: 7 as unknown as JsonValue }, "invalid-items"],
      [{ type: "bogus" }, "invalid-type"],
      [{ enum: [] }, "invalid-enum"],
      [{ multipleOf: 1 }, "unsupported-keyword"],
    ];
    for (const [schema, code] of malformed) rejectsSchema(schema, code);
    rejectsSchema({ anyOf: Array.from({ length: 65 }, () => ({ type: "null" })) }, "schema-collection-limit");
    rejectsSchema({ enum: Array.from({ length: 129 }, (_, index) => index) }, "schema-enum-limit");
  });

  it("admits the first-party maximum candidate dependency evaluation within its finite work budget", () => {
    const schema = {
      type: "array",
      maxItems: 1_000,
      items: {
        type: "object",
        required: ["dependsOn"],
        properties: {
          dependsOn: { type: "array", maxItems: 64, items: { type: "string" } },
        },
        additionalProperties: false,
      },
    } as const;
    const value = Array.from({ length: 1_000 }, () => ({
      dependsOn: Array.from({ length: 64 }, (_, index) => `dependency-${index}`),
    }));
    accepts(schema, value);
  });

  it("propagates evaluation exhaustion through negation and alternative branches", () => {
    const value = Array.from({ length: 131_100 }, () => 0);
    rejects({ not: { type: "array", items: true } }, value, "schema-work-limit");
    rejects({ oneOf: [true, { type: "array", items: true }] }, value, "schema-work-limit");
  });

  it("does not serialize caller or output property names in mismatch paths", () => {
    const canary = "secret-canary-property:name";
    try {
      assertStructuredOutputMatchesSchema(
        { type: "object", properties: { [canary]: { type: "integer" } } },
        { [canary]: "wrong" },
      );
      throw new Error("expected schema rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect(JSON.stringify((error as ProviderError).toJSON())).not.toContain(canary);
      expect(error).toMatchObject({ details: { violationPath: "$.*", violationCode: "type" } });
    }
  });
});
