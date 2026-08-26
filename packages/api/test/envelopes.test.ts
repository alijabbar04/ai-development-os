import { canonicalizeJson, type JsonValue } from "@ai-dev-os/domain";
import { describe, expect, it } from "vitest";
import {
  API_PRODUCTION_ENABLED,
  API_SCHEMA_VERSION,
  PROJECTION_STALE_REASONS,
  assertMonotonicSequence,
  parseProjectionEnvelope,
  parseRefusalEnvelope,
  parseSuccessEnvelope,
  serializeApiEnvelope,
} from "../src/index.js";

const SERVER_NOW = "2026-08-25T14:00:00.000Z";
const COMPUTED_AT = "2026-08-25T13:59:59.000Z";
const payloadParser = (value: unknown, path: string): JsonValue => canonicalizeJson(value, path);

function base(sequence = 17): Record<string, unknown> {
  return {
    schemaVersion: API_SCHEMA_VERSION,
    sequence,
    serverNow: SERVER_NOW,
    productionEnabled: API_PRODUCTION_ENABLED,
  };
}

describe("Stage 20A API envelopes", () => {
  it("strictly parses and canonically serializes a success envelope", () => {
    const envelope = parseSuccessEnvelope({
      payload: { state: "ready", count: 2 },
      kind: "success",
      ok: true,
      ...base(),
    }, payloadParser);

    expect(envelope).toEqual({
      ...base(),
      ok: true,
      kind: "success",
      payload: { count: 2, state: "ready" },
    });
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(serializeApiEnvelope(envelope)).toBe(
      '{"kind":"success","ok":true,"payload":{"count":2,"state":"ready"},"productionEnabled":false,"schemaVersion":1,"sequence":17,"serverNow":"2026-08-25T14:00:00.000Z"}',
    );
  });

  it.each(PROJECTION_STALE_REASONS)("accepts finite stale reason %s", (staleReason) => {
    const envelope = parseProjectionEnvelope({
      ...base(),
      ok: true,
      kind: "projection",
      computedAt: COMPUTED_AT,
      confidence: "stale",
      staleReason,
      payload: { ready: false },
    }, payloadParser);
    expect(envelope.staleReason).toBe(staleReason);
    expect(envelope.serverNow).toBe(SERVER_NOW);
  });

  it("requires current confidence to carry a null stale reason", () => {
    const current = parseProjectionEnvelope({
      ...base(), ok: true, kind: "projection", computedAt: SERVER_NOW,
      confidence: "current", staleReason: null, payload: null,
    }, payloadParser);
    expect(current.confidence).toBe("current");
    expect(current.staleReason).toBeNull();

    expect(() => parseProjectionEnvelope({
      ...base(), ok: true, kind: "projection", computedAt: COMPUTED_AT,
      confidence: "current", staleReason: "sequence-lag", payload: null,
    }, payloadParser)).toThrow(/must be null/u);
    expect(() => parseProjectionEnvelope({
      ...base(), ok: true, kind: "projection", computedAt: COMPUTED_AT,
      confidence: "stale", staleReason: null, payload: null,
    }, payloadParser)).toThrow(/must be one of/u);
  });

  it("strictly parses a typed refusal envelope", () => {
    const envelope = parseRefusalEnvelope({
      ...base(18),
      ok: false,
      kind: "refused",
      refusal: { code: "NOT_ELIGIBLE", details: { ruleIds: ["RULE-B", "RULE-A"] } },
    });
    expect(envelope.refusal).toEqual({
      code: "NOT_ELIGIBLE",
      details: { ruleIds: ["RULE-A", "RULE-B"] },
    });
    expect(envelope.productionEnabled).toBe(false);
  });

  it("rejects missing, extra, wrong-kind, and production-enabled fields", () => {
    const success = { ...base(), ok: true, kind: "success", payload: null };
    const { serverNow: _omitted, ...missing } = success;
    expect(() => parseSuccessEnvelope(missing, payloadParser)).toThrow(/required/u);
    expect(() => parseSuccessEnvelope({ ...success, extra: true }, payloadParser)).toThrow(/unexpected fields/u);
    expect(() => parseSuccessEnvelope({ ...success, kind: "projection" }, payloadParser)).toThrow(/success envelope/u);
    expect(() => parseSuccessEnvelope({ ...success, productionEnabled: true }, payloadParser)).toThrow(/must be false/u);
    expect(() => parseRefusalEnvelope({ ...base(), ok: true, kind: "refused", refusal: { code: "RATE_LIMITED", details: null } })).toThrow(/refusal envelope/u);
  });

  it("enforces schema, sequence, canonical timestamp, and projection-time bounds", () => {
    const success = { ...base(), ok: true, kind: "success", payload: null };
    expect(() => parseSuccessEnvelope({ ...success, schemaVersion: 2 }, payloadParser)).toThrow(/supported schema version/u);
    expect(() => parseSuccessEnvelope({ ...success, sequence: -1 }, payloadParser)).toThrow(/safe integer/u);
    expect(() => parseSuccessEnvelope({ ...success, sequence: Number.MAX_SAFE_INTEGER + 1 }, payloadParser)).toThrow(/safe integer/u);
    expect(() => parseSuccessEnvelope({ ...success, serverNow: "2026-08-25" }, payloadParser)).toThrow(/canonical/u);
    expect(() => parseProjectionEnvelope({
      ...base(), ok: true, kind: "projection", computedAt: "2026-08-25T14:00:00.001Z",
      confidence: "current", staleReason: null, payload: null,
    }, payloadParser)).toThrow(/later than serverNow/u);
    expect(() => parseProjectionEnvelope({
      ...base(), serverNow: "9999-12-31T23:59:59.999Z", ok: true, kind: "projection",
      computedAt: "+010000-01-01T00:00:00.000Z", confidence: "current",
      staleReason: null, payload: null,
    }, payloadParser)).toThrow(/later than serverNow/u);
  });

  it("validates monotonic sequences without consulting a clock", () => {
    expect(assertMonotonicSequence(41, 42)).toBe(42);
    expect(() => assertMonotonicSequence(42, 42)).toThrow(/greater than/u);
    expect(() => assertMonotonicSequence(42, 41)).toThrow(/greater than/u);
    expect(() => assertMonotonicSequence(-1, 0)).toThrow(/safe integer/u);
  });

  it("produces byte-identical canonical output across insertion orders", () => {
    const first = parseSuccessEnvelope({ ...base(21), ok: true, kind: "success", payload: { z: 1, a: [true, null] } }, payloadParser);
    const second = parseSuccessEnvelope({ payload: { a: [true, null], z: 1 }, kind: "success", ok: true, ...base(21) }, payloadParser);
    expect(serializeApiEnvelope(first)).toBe(serializeApiEnvelope(second));
  });
});
