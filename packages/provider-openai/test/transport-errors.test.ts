import { describe, expect, it } from "vitest";
import { createManualScheduler } from "@ai-dev-os/provider-testkit";
import { isProviderError, type ProviderError } from "@ai-dev-os/providers";
import {
  createFetchOpenAiTransport,
  openAiSchedulerFromManual,
  parseOpenAiEndpoint,
  parseResetDurationMs,
  type OpenAiTransport,
} from "../src/index.js";
import { createFakeOpenAi, responseObject, textStreamScript, type FakeOpenAi } from "./helpers/fake-openai.js";
import { TEST_API_KEY, createTestProvider, testRequest } from "./helpers/fixtures.js";

function detailCode(error: unknown): unknown {
  return (error as ProviderError).details["detailCode"];
}

function makeTransport(fake: FakeOpenAi): { transport: OpenAiTransport; manual: ReturnType<typeof createManualScheduler> } {
  const manual = createManualScheduler();
  const transport = createFetchOpenAiTransport({
    endpoint: parseOpenAiEndpoint("openai-api"),
    organizationId: "org-ABC",
    projectId: "proj_ABC",
    scheduler: openAiSchedulerFromManual(manual),
    fetchImpl: fake.fetchImpl,
  });
  return { transport, manual };
}

const CALL = {
  apiKey: TEST_API_KEY,
  timeoutMs: 30_000,
  connectTimeoutMs: 5_000,
  maxResponseBytes: 1_024 * 1_024,
  maxErrorBodyBytes: 4_096,
};

describe("transport requests", () => {
  it("targets the exact route and sends the documented headers", async () => {
    const fake = createFakeOpenAi();
    fake.script("create", { json: responseObject() });
    const { transport } = makeTransport(fake);

    await transport.requestJson("createResponse", { model: "m" } as never, CALL);

    const request = fake.requests[0]!;
    expect(request.url).toBe("https://api.openai.com/v1/responses");
    expect(request.method).toBe("POST");
    expect(request.headers["authorization"]).toBe(`Bearer ${TEST_API_KEY}`);
    expect(request.headers["openai-organization"]).toBe("org-ABC");
    expect(request.headers["openai-project"]).toBe("proj_ABC");
    expect(request.headers["content-type"]).toBe("application/json");
    transport.close();
  });

  it("sends an idempotency key when one is supplied", async () => {
    const fake = createFakeOpenAi();
    fake.script("create", { json: responseObject() });
    const { transport } = makeTransport(fake);
    await transport.requestJson("createResponse", { model: "m" } as never, {
      ...CALL,
      idempotencyKey: "idem-1",
    });
    expect(fake.requests[0]!.headers["idempotency-key"]).toBe("idem-1");
    transport.close();
  });

  it("rejects a redirect before issuing a second request", async () => {
    const fake = createFakeOpenAi();
    fake.script("create", { status: 302, headers: { location: "https://evil.test/steal" }, bodyText: "" });
    const { transport } = makeTransport(fake);

    await expect(
      transport.requestJson("createResponse", { model: "m" } as never, CALL),
    ).rejects.toMatchObject({ code: "PROTOCOL_VIOLATION" });
    // Exactly one request was made: the redirect target was never followed.
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.url).toBe("https://api.openai.com/v1/responses");
    transport.close();
  });

  it("rejects an unexpected content type", async () => {
    const fake = createFakeOpenAi();
    fake.script("create", { bodyText: "<html>nope</html>", contentType: "text/html" });
    const { transport } = makeTransport(fake);
    try {
      await transport.requestJson("createResponse", null, CALL);
      expect.unreachable("expected refusal");
    } catch (error) {
      expect(detailCode(error)).toBe("unexpected-content-type");
    }
    transport.close();
  });

  it("bounds an oversized success body", async () => {
    const fake = createFakeOpenAi();
    fake.script("create", { bodyText: JSON.stringify({ pad: "x".repeat(5_000) }) });
    const { transport } = makeTransport(fake);
    try {
      await transport.requestJson("createResponse", null, { ...CALL, maxResponseBytes: 1_024 });
      expect.unreachable("expected refusal");
    } catch (error) {
      expect(detailCode(error)).toBe("oversized-response-body");
    }
    transport.close();
  });

  it("bounds an oversized error body and never returns its content", async () => {
    const canary = "LEAKED-ERROR-BODY-CANARY";
    const fake = createFakeOpenAi();
    fake.script("create", {
      status: 500,
      bodyText: JSON.stringify({ error: { type: "server_error", message: `${canary} ${"x".repeat(50_000)}` } }),
    });
    const { transport } = makeTransport(fake);
    const response = await transport.requestJson("createResponse", null, {
      ...CALL,
      maxErrorBodyBytes: 512,
    });
    expect(response).toMatchObject({ status: 500, ok: false, value: null, upstreamError: { type: null, code: null, param: null } });
    expect(JSON.stringify(response.upstreamError)).not.toContain(canary);
    transport.close();
  });

  it("preserves streaming error status when its body exceeds the drain bound", async () => {
    const canary = "LEAKED-STREAM-ERROR-CANARY";
    const fake = createFakeOpenAi();
    fake.script("create", { status: 429, headers: { "retry-after": "2" }, bodyText: `${canary}${"x".repeat(50_000)}` });
    const { transport } = makeTransport(fake);
    const response = await transport.requestStream("createResponse", null, { ...CALL, maxErrorBodyBytes: 512 });
    expect(response).toMatchObject({ status: 429, ok: false, metadata: { retryAfterMs: 2_000 }, upstreamError: { type: null, code: null, param: null } });
    expect(JSON.stringify(response.upstreamError)).not.toContain(canary);
    expect(() => response.chunks()).toThrowError(expect.objectContaining({ code: "MALFORMED_RESPONSE" }));
    transport.close();
  });

  it("classifies a malformed error body without failing the request", async () => {
    const fake = createFakeOpenAi();
    fake.script("create", { status: 400, bodyText: "not json at all" });
    const { transport } = makeTransport(fake);
    const response = await transport.requestJson("createResponse", null, CALL);
    expect(response.ok).toBe(false);
    expect(response.upstreamError).toEqual({ type: null, code: null, param: null });
    transport.close();
  });

  it("surfaces a connection failure as a network error with a safe cause category", async () => {
    const fake = createFakeOpenAi();
    fake.script("create", { networkError: "ECONNRESET" });
    const { transport } = makeTransport(fake);
    try {
      await transport.requestJson("createResponse", null, CALL);
      expect.unreachable("expected refusal");
    } catch (error) {
      expect(isProviderError(error, "NETWORK_FAILURE")).toBe(true);
      expect((error as ProviderError).causeCategory).toBe("econnreset");
    }
    transport.close();
  });

  it("rejects new work after close and is idempotent", async () => {
    const fake = createFakeOpenAi();
    const { transport } = makeTransport(fake);
    transport.close();
    transport.close();
    await expect(transport.requestJson("createResponse", null, CALL)).rejects.toMatchObject({
      code: "PROVIDER_CLOSED",
    });
  });

  it("makes the stream single-use", async () => {
    const fake = createFakeOpenAi();
    fake.script("create", { stream: textStreamScript(["a"]) });
    const { transport } = makeTransport(fake);
    const stream = await transport.requestStream("createResponse", null, CALL);
    stream.chunks();
    expect(() => stream.chunks()).toThrow();
    stream.abort();
    stream.abort();
    transport.close();
  });
});

describe("rate-limit and metadata headers", () => {
  it("parses the documented reset duration format", () => {
    expect(parseResetDurationMs("1s")).toBe(1_000);
    expect(parseResetDurationMs("6m0s")).toBe(360_000);
    expect(parseResetDurationMs("1h2m3s")).toBe(3_723_000);
    expect(parseResetDurationMs("1.5s")).toBe(1_500);
    // Ambiguous or hostile values are rejected rather than guessed.
    expect(parseResetDurationMs("60")).toBeNull();
    expect(parseResetDurationMs("soon")).toBeNull();
    expect(parseResetDurationMs(null)).toBeNull();
    expect(parseResetDurationMs("9999h")).toBeNull();
  });

  it("captures rate-limit headers, request id, and processing tier", async () => {
    const fake = createFakeOpenAi();
    fake.script("create", {
      json: responseObject(),
      headers: {
        "x-ratelimit-limit-requests": "500",
        "x-ratelimit-remaining-requests": "499",
        "x-ratelimit-reset-requests": "6m0s",
        "x-request-id": "req_abc123",
        "openai-processing-tier": "priority",
      },
    });
    const { transport } = makeTransport(fake);
    const response = await transport.requestJson("createResponse", null, CALL);
    expect(response.metadata.requestId).toBe("req_abc123");
    expect(response.metadata.serviceTier).toBe("priority");
    expect(response.metadata.rateLimit).toMatchObject({ limit: 500, remaining: 499, retryAfterMs: 360_000 });
    transport.close();
  });

  it("ignores malformed header values instead of trusting them", async () => {
    const fake = createFakeOpenAi();
    fake.script("create", {
      json: responseObject(),
      headers: {
        "x-ratelimit-limit-requests": "not-a-number",
        "x-request-id": "req with spaces and <html>",
        "openai-processing-tier": "TIER; drop table",
        "retry-after": "-5",
      },
    });
    const { transport } = makeTransport(fake);
    const response = await transport.requestJson("createResponse", null, CALL);
    expect(response.metadata.requestId).toBeNull();
    expect(response.metadata.serviceTier).toBeNull();
    expect(response.metadata.retryAfterMs).toBeNull();
    transport.close();
  });
});

describe("HTTP status mapping through the provider", () => {
  it.each([
    [401, undefined, "AUTHENTICATION_FAILED", "human-action"],
    [403, undefined, "AUTHORIZATION_FAILED", "human-action"],
    [404, undefined, "MODEL_UNAVAILABLE", "alternate-model"],
    [409, undefined, "INVALID_REQUEST", "never"],
    [500, undefined, "INTERNAL_FAILURE", "same-after-delay"],
    [503, undefined, "PROVIDER_OVERLOADED", "same-after-delay"],
  ])("maps %i to %s", async (status, code, expectedCode, expectedStrategy) => {
    void code;
    const { provider, fake } = createTestProvider();
    fake.script("create", { status, json: { error: { type: "api_error" } } });
    try {
      await provider.start(testRequest(`status-${status}`));
      expect.unreachable(`expected ${expectedCode}`);
    } catch (error) {
      expect((error as ProviderError).code).toBe(expectedCode);
      expect((error as ProviderError).retry.strategy).toBe(expectedStrategy);
    }
    await provider.close();
  });

  it("maps 408 to a timeout that may still be running", async () => {
    const { provider, fake } = createTestProvider();
    fake.script("create", { status: 408, json: { error: { type: "timeout" } } });
    try {
      await provider.start(testRequest("timeout"));
      expect.unreachable("expected TIMEOUT");
    } catch (error) {
      expect((error as ProviderError).code).toBe("TIMEOUT");
      expect((error as ProviderError).retry.idempotencyRequired).toBe(true);
    }
    await provider.close();
  });

  it("maps 429 to RATE_LIMITED with Retry-After honored", async () => {
    const { provider, fake } = createTestProvider();
    fake.script("create", {
      status: 429,
      headers: { "retry-after": "7", "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "7s" },
      json: { error: { type: "rate_limit_error", code: "rate_limit_exceeded" } },
    });
    try {
      await provider.start(testRequest("throttled"));
      expect.unreachable("expected RATE_LIMITED");
    } catch (error) {
      const providerError = error as ProviderError;
      expect(providerError.code).toBe("RATE_LIMITED");
      expect(providerError.retryAfterMs).toBe(7_000);
      expect(providerError.retry.strategy).toBe("same-after-delay");
      expect(providerError.rateLimit?.remaining).toBe(0);
    }
    await provider.close();
  });

  it.each([[429, "RATE_LIMITED"], [503, "PROVIDER_OVERLOADED"]] as const)("preserves %i status when the error body exceeds its bound", async (status, expectedCode) => {
    const canary = `OVERSIZED-${status}-ERROR-CANARY`;
    const { provider, fake } = createTestProvider();
    fake.script("create", { status, headers: status === 429 ? { "retry-after": "2" } : {}, bodyText: `${canary}${"x".repeat(50_000)}` });
    try {
      await provider.start(testRequest(`oversized-${status}`));
      expect.unreachable(`expected ${expectedCode}`);
    } catch (error) {
      const providerError = error as ProviderError;
      expect(providerError.code).toBe(expectedCode);
      if (status === 429) expect(providerError.retryAfterMs).toBe(2_000);
      expect(JSON.stringify(providerError.toJSON())).not.toContain(canary);
    }
    await provider.close();
  });

  it("distinguishes exhausted quota from throttling", async () => {
    const { provider, fake } = createTestProvider();
    fake.script("create", {
      status: 429,
      json: { error: { type: "insufficient_quota", code: "insufficient_quota" } },
    });
    try {
      await provider.start(testRequest("quota"));
      expect.unreachable("expected QUOTA_EXCEEDED");
    } catch (error) {
      expect((error as ProviderError).code).toBe("QUOTA_EXCEEDED");
      expect((error as ProviderError).retry.strategy).toBe("human-action");
    }
    await provider.close();
  });

  it("maps a context-length overflow to CONTEXT_LIMIT_EXCEEDED", async () => {
    const { provider, fake } = createTestProvider();
    fake.script("create", {
      status: 400,
      json: { error: { type: "invalid_request_error", code: "context_length_exceeded" } },
    });
    try {
      await provider.start(testRequest("context"));
      expect.unreachable("expected CONTEXT_LIMIT_EXCEEDED");
    } catch (error) {
      expect((error as ProviderError).code).toBe("CONTEXT_LIMIT_EXCEEDED");
      expect((error as ProviderError).retry.requestReusable).toBe(false);
    }
    await provider.close();
  });

  it("never lets an upstream message reach the error", async () => {
    const canary = "UPSTREAM-MESSAGE-CANARY";
    const { provider, fake } = createTestProvider();
    fake.script("create", {
      status: 400,
      json: { error: { type: "invalid_request_error", message: canary, code: "bad_thing" } },
    });
    try {
      await provider.start(testRequest("leak"));
      expect.unreachable("expected refusal");
    } catch (error) {
      const serialized = JSON.stringify((error as ProviderError).toJSON());
      expect(serialized).not.toContain(canary);
      // The stable machine code IS retained.
      expect(serialized).toContain("bad_thing");
    }
    await provider.close();
  });
});
