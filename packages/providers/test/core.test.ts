import { describe, expect, it } from "vitest";
import { ValidationError } from "@ai-dev-os/domain";
import {
  PROVIDER_ERROR_CODES,
  ProviderError,
  combinedCapability,
  createRetryDisposition,
  createTrace,
  defaultRetryDisposition,
  isDeadlineExpired,
  isProviderError,
  parseDeadline,
  parseDisclosureContext,
  parseEstimatedUsage,
  parseExecutionTraceMetadata,
  parseModelDescriptor,
  parseProviderCapabilities,
  parseProviderCost,
  parseProviderDescriptor,
  parseProviderExtensions,
  parseProviderHealth,
  parseProviderInstanceId,
  parseProviderLatency,
  parseProviderOperationId,
  parseProviderRequestId,
  parseProviderUsage,
  parseToolCallId,
  parseToolName,
  parseCancellationReason,
  toProviderError,
  totalOfUsage,
  UNKNOWN_COST,
  ZERO_PROVIDER_USAGE,
} from "../src/index.js";
import {
  MODEL_FIXTURE,
  CAPABILITIES_FIXTURE,
  DESCRIPTOR_FIXTURE,
  TRACE_FIXTURE,
  DISCLOSURE_FIXTURE,
} from "./fixtures.js";

describe("ProviderError and retry taxonomy", () => {
  it("carries code, safe details, retry disposition, and serializes safely", () => {
    const error = new ProviderError(
      "RATE_LIMITED",
      "Slow down.",
      { modelId: "m-1" },
      {
        retryAfterMs: 2_000,
        rateLimit: { retryAfterMs: 2_000, limit: 10, remaining: 0, resetsAt: null },
        operationId: "op-1",
        traceId: "trace-1",
        causeCategory: "http-429",
      },
    );
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retry.strategy).toBe("same-after-delay");
    expect(error.retryAfterMs).toBe(2_000);
    expect(error.rateLimit?.remaining).toBe(0);
    expect(Object.isFrozen(error.details)).toBe(true);
    const json = error.toJSON();
    expect(json.code).toBe("RATE_LIMITED");
    expect(json.traceId).toBe("trace-1");
    expect(PROVIDER_ERROR_CODES).toContain("PROTOCOL_VIOLATION");
    expect(isProviderError(error, "RATE_LIMITED")).toBe(true);
    expect(isProviderError(new Error("plain"))).toBe(false);
  });

  it("classifies every error code with a conservative default disposition", () => {
    for (const code of PROVIDER_ERROR_CODES) {
      const disposition = defaultRetryDisposition(code);
      expect(disposition.strategy).toBeDefined();
      expect(Object.isFrozen(disposition)).toBe(true);
    }
    expect(defaultRetryDisposition("CANCELLED").strategy).toBe("never");
    expect(defaultRetryDisposition("NETWORK_FAILURE").idempotencyRequired).toBe(true);
    expect(defaultRetryDisposition("NETWORK_FAILURE").operationMayStillBeRunning).toBe(true);
    expect(defaultRetryDisposition("MODEL_UNAVAILABLE").strategy).toBe("alternate-model");
    expect(defaultRetryDisposition("AUTHENTICATION_FAILED").strategy).toBe("human-action");
    expect(defaultRetryDisposition("MALFORMED_RESPONSE").strategy).toBe("alternate-provider");
  });

  it("validates custom dispositions and wraps unknown failures", () => {
    const disposition = createRetryDisposition({
      strategy: "same-after-delay",
      minimumDelayMs: 100,
      retryAfterMs: 250,
      requestReusable: true,
    });
    expect(disposition.minimumDelayMs).toBe(100);
    expect(() => createRetryDisposition({ strategy: "warp" as never })).toThrow(ProviderError);
    expect(() =>
      createRetryDisposition({ strategy: "same", minimumDelayMs: -1 }),
    ).toThrow(ValidationError);

    const wrapped = toProviderError(new TypeError("boom secret-token"));
    expect(wrapped.code).toBe("INTERNAL_FAILURE");
    expect(JSON.stringify(wrapped.toJSON())).not.toContain("secret-token");
    expect(toProviderError(wrapped)).toBe(wrapped);
  });
});

describe("identifiers, trace, deadline, cancellation", () => {
  it("parses branded identifiers with the shared pattern", () => {
    expect(parseProviderInstanceId("inst-1")).toBe("inst-1");
    expect(parseProviderRequestId("req-1")).toBe("req-1");
    expect(parseProviderOperationId("op-1")).toBe("op-1");
    expect(parseToolCallId("call-1")).toBe("call-1");
    expect(parseToolName("read-file")).toBe("read-file");
    expect(() => parseProviderInstanceId("bad id")).toThrow(ValidationError);
    expect(() => parseToolName("Bad-Name")).toThrow(ValidationError);
  });

  it("validates trace metadata and defaults scope ids to null", () => {
    const trace = parseExecutionTraceMetadata(TRACE_FIXTURE);
    expect(trace.traceId).toBe("trace-1");
    expect(trace.runId).toBe("run-1");
    const minimal = createTrace("trace-9");
    expect(minimal.taskId).toBeNull();
    expect(() => parseExecutionTraceMetadata({ ...TRACE_FIXTURE, traceId: null })).toThrow(
      ValidationError,
    );
    // Missing scope ids are normalized to null; unexpected keys are rejected.
    expect(parseExecutionTraceMetadata({ traceId: "t" }).runId).toBeNull();
    expect(() => parseExecutionTraceMetadata({ ...TRACE_FIXTURE, extra: 1 })).toThrow(
      ValidationError,
    );
  });

  it("validates deadlines and evaluates expiry against a clock", () => {
    const deadline = parseDeadline("2026-08-02T12:00:00.000Z");
    expect(isDeadlineExpired(deadline, new Date("2026-08-02T11:59:59.999Z"))).toBe(false);
    expect(isDeadlineExpired(deadline, new Date("2026-08-02T12:00:00.000Z"))).toBe(true);
    expect(isDeadlineExpired(null, new Date())).toBe(false);
    expect(() => parseDeadline("tomorrow")).toThrow(ValidationError);
    expect(parseCancellationReason("provider-closed")).toBe("provider-closed");
    expect(() => parseCancellationReason("because")).toThrow(ValidationError);
  });
});

describe("extensions", () => {
  it("accepts bounded namespaced extensions and rejects abuse", () => {
    const extensions = parseProviderExtensions([
      { namespace: "openai", key: "reasoning-effort", value: "high" },
    ]);
    expect(extensions).toHaveLength(1);
    expect(Object.isFrozen(extensions)).toBe(true);
    expect(parseProviderExtensions(undefined)).toHaveLength(0);

    expect(() =>
      parseProviderExtensions([{ namespace: "OpenAI", key: "x", value: 1 }]),
    ).toThrow(ValidationError);
    expect(() =>
      parseProviderExtensions([
        { namespace: "a-ns", key: "k", value: 1 },
        { namespace: "a-ns", key: "k", value: 2 },
      ]),
    ).toThrow(ProviderError);
    expect(() =>
      parseProviderExtensions([{ namespace: "a-ns", key: "k", value: "x".repeat(5_000) }]),
    ).toThrow(ProviderError);
    expect(() =>
      parseProviderExtensions(
        Array.from({ length: 17 }, (_, index) => ({ namespace: "a-ns", key: `k${index}`, value: 1 })),
      ),
    ).toThrow(ValidationError);
  });
});

describe("disclosure context", () => {
  it("round-trips a valid disclosure block", () => {
    const disclosure = parseDisclosureContext(DISCLOSURE_FIXTURE);
    expect(disclosure.classification).toBe("internal");
    expect(disclosure.requiredLocality).toBe("any");
    expect(Object.isFrozen(disclosure)).toBe(true);
  });

  it("rejects unknown classifications and missing fields", () => {
    expect(() =>
      parseDisclosureContext({ ...DISCLOSURE_FIXTURE, classification: "top-secret" }),
    ).toThrow(ValidationError);
    expect(() => parseDisclosureContext({})).toThrow(ValidationError);
  });
});

describe("descriptor, capabilities, health, models", () => {
  it("parses provider descriptors and capabilities", () => {
    const descriptor = parseProviderDescriptor(DESCRIPTOR_FIXTURE);
    expect(descriptor.kind).toBe("inference");
    expect(descriptor.capabilities.toolCalling).toBe(true);
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(() =>
      parseProviderDescriptor({ ...DESCRIPTOR_FIXTURE, schemaVersion: 99 }),
    ).toThrow(ValidationError);
    expect(() =>
      parseProviderCapabilities({ ...CAPABILITIES_FIXTURE, cancellation: "sometimes" }),
    ).toThrow(ValidationError);
  });

  it("parses health and model descriptors", () => {
    const health = parseProviderHealth({
      status: "ready",
      checkedAt: "2026-08-02T12:00:00.000Z",
      detailCode: null,
      activeOperations: 2,
    });
    expect(health.status).toBe("ready");
    expect(() =>
      parseProviderHealth({ status: "ready", checkedAt: "now", detailCode: null, activeOperations: 0 }),
    ).toThrow(ValidationError);

    const model = parseModelDescriptor({ model: MODEL_FIXTURE, availability: "available" });
    expect(model.model.modelId).toBe("fake-model");
    expect(() =>
      parseModelDescriptor({ model: MODEL_FIXTURE, availability: "sometimes" }),
    ).toThrow(ValidationError);
  });

  it("combines instance and model capabilities with AND semantics", () => {
    const descriptor = parseProviderDescriptor(DESCRIPTOR_FIXTURE);
    const combined = combinedCapability(descriptor, parseModelDescriptor({ model: MODEL_FIXTURE, availability: "available" }).model);
    expect(combined.toolCalling).toBe(true);
    expect(combined.imageInput).toBe(false);
    expect(combined.localExecution).toBe(false);
  });
});

describe("usage, cost, latency", () => {
  it("parses exact usage and cost values", () => {
    const usage = parseProviderUsage({
      tokens: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, reasoningTokens: 1 },
      toolCalls: 3,
    });
    expect(totalOfUsage(usage)).toBe(21);
    expect(totalOfUsage(ZERO_PROVIDER_USAGE)).toBe(0);
    expect(() =>
      parseProviderUsage({ tokens: { inputTokens: 1.5, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 }, toolCalls: 0 }),
    ).toThrow(ValidationError);

    const cost = parseProviderCost({
      providerReported: { currency: "USD", amountMicros: 1_500 },
      locallyComputed: null,
    });
    expect(cost.providerReported?.amountMicros).toBe(1_500);
    expect(UNKNOWN_COST.providerReported).toBeNull();
    expect(() =>
      parseProviderCost({ providerReported: { currency: "USD", amountMicros: 1.5 }, locallyComputed: null }),
    ).toThrow(ValidationError);
  });

  it("parses latency with firstEvent bounded by total", () => {
    const latency = parseProviderLatency({ firstEventMs: 10, totalMs: 100 });
    expect(latency.firstEventMs).toBe(10);
    expect(() => parseProviderLatency({ firstEventMs: 200, totalMs: 100 })).toThrow(
      ValidationError,
    );
    expect(parseProviderLatency({ firstEventMs: null, totalMs: 0 }).firstEventMs).toBeNull();
  });

  it("keeps estimates separate from actuals", () => {
    const estimated = parseEstimatedUsage({ inputTokens: 100, outputTokens: 50 });
    expect(estimated.inputTokens).toBe(100);
    expect(() => parseEstimatedUsage({ inputTokens: -1, outputTokens: 0 })).toThrow(
      ValidationError,
    );
  });
});
