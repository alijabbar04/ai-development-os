import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  SecretBrokerError,
  createSecretMaterial,
  type SecretAccessContext,
  type SecretBroker,
  type SecretRef,
} from "@ai-dev-os/secrets";
import {
  ANTHROPIC_LIVE_CANARY_MAX_RESPONSE_BYTES,
  ANTHROPIC_LIVE_CANARY_MODEL,
  ANTHROPIC_LIVE_CANARY_OPT_IN,
  ANTHROPIC_LIVE_CANARY_TIMEOUT_MS,
  AnthropicLiveCanaryError,
  createAnthropicLiveCanary,
  type AnthropicLiveCanaryPreflightRequest,
  type AnthropicLiveCanaryTransport,
  type AnthropicLiveCanaryTransportRequest,
} from "../src/testing/index.js";
import { createDirectAnthropicLiveCanaryTransportForTesting } from
  "../src/testing/live-canary.js";

const REF: SecretRef = Object.freeze({
  schemaVersion: 1,
  type: "named",
  namespace: "provider",
  name: "anthropic-live-canary",
  version: "version:owned",
  expectedKind: "text",
  providerInstanceId: "anthropic:live-canary",
});
const CATALOG = "a".repeat(64);
const DECISION = "b".repeat(64);
const AUTHORIZATION = "authorization:owned-live-canary";

function broker(observations: string[]): SecretBroker {
  return Object.freeze({
    describeCapabilities: () => ({
      resolve: true,
      availability: true,
      replace: false,
      revoke: false,
      versions: true,
      kinds: ["text"] as const,
    }),
    async availability(_ref: SecretRef, context: SecretAccessContext) {
      observations.push("availability");
      expect(context.providerInstanceId).toBe("anthropic:live-canary");
      expect(context.classification).toBe("public");
      expect(context.approvalEvidenceRefs).toEqual([AUTHORIZATION]);
      return {
        available: true,
        reason: "available" as const,
        audit: {
          schemaVersion: 1 as const,
          operation: "availability" as const,
          phase: "outcome" as const,
          outcome: "success" as const,
          occurredAt: "2026-08-12T00:00:00.000Z",
          reference: null,
          operationId: context.operationId,
          providerInstanceId: context.providerInstanceId,
          purpose: context.purpose,
          traceId: context.trace.traceId,
        },
      };
    },
    async withSecret<T>(
      _ref: SecretRef,
      _context: SecretAccessContext,
      callback: Parameters<SecretBroker["withSecret"]>[2],
    ): Promise<T> {
      observations.push("secret");
      const material = createSecretMaterial(
        "text",
        new TextEncoder().encode("owned-test-key"),
      );
      try {
        return await callback(material) as T;
      } finally {
        material.dispose();
      }
    },
    async replace() {
      throw new SecretBrokerError("UNSUPPORTED_OPERATION", "Unsupported.");
    },
    async revoke() {
      throw new SecretBrokerError("UNSUPPORTED_OPERATION", "Unsupported.");
    },
    async close() {},
  });
}

function responseBody(overrides: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: ANTHROPIC_LIVE_CANARY_MODEL,
    content: [{ type: "text", text: "OK" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 8, output_tokens: 1 },
    ...overrides,
  }));
}

function transport(
  observations: string[],
  options: {
    readonly body?: Uint8Array;
    readonly status?: number;
    readonly inspect?: (request: AnthropicLiveCanaryTransportRequest) => void;
  } = {},
): AnthropicLiveCanaryTransport {
  return Object.freeze({
    kind: "deterministic-fake" as const,
    async post(request: AnthropicLiveCanaryTransportRequest, apiKey: string) {
      observations.push("transport");
      expect(apiKey).toBe("owned-test-key");
      options.inspect?.(request);
      return {
        status: options.status ?? 200,
        contentType: "application/json; charset=utf-8",
        body: options.body ?? responseBody(),
      };
    },
  });
}

function canary(options: {
  readonly observations?: string[];
  readonly transport?: AnthropicLiveCanaryTransport;
  readonly preflight?: (
    request: AnthropicLiveCanaryPreflightRequest,
  ) => Promise<Record<string, unknown>>;
  readonly now?: () => Date;
}) {
  const observations = options.observations ?? [];
  let tick = 0;
  return createAnthropicLiveCanary({
    instanceId: "anthropic:live-canary",
    apiKeyRef: REF,
    retentionMode: "standard-30-day",
    expectedCatalogFingerprint: CATALOG,
    expectedAuthorizationReference: AUTHORIZATION,
    broker: broker(observations),
    preflight: {
      async check(request) {
        observations.push("preflight");
        return options.preflight?.(request) ?? {
          allowed: true,
          decisionFingerprint: DECISION,
          catalogFingerprint: CATALOG,
          authorizationReference: AUTHORIZATION,
          retentionMode: "standard-30-day",
        };
      },
    },
    transport: options.transport ?? transport(observations),
    now: options.now ?? (() => new Date(tick++ === 0 ? 1_000 : 1_025)),
  });
}

describe("explicit opt-in Anthropic live canary", () => {
  it("refuses before policy, secret, or transport without the exact sentinel", async () => {
    const observations: string[] = [];
    const live = canary({ observations });
    await expect(live.run("1")).rejects.toMatchObject({ code: "NOT_OPTED_IN" });
    expect(observations).toEqual([]);
    await expect(live.run(ANTHROPIC_LIVE_CANARY_OPT_IN)).resolves.toMatchObject({
      statusCategory: "success",
      transportKind: "deterministic-fake",
    });
  });

  it("runs policy and exact identity preflight before scoped secret resolution", async () => {
    const observations: string[] = [];
    let wireRequest: AnthropicLiveCanaryTransportRequest | null = null;
    const live = canary({
      observations,
      transport: transport(observations, {
        inspect(request) {
          wireRequest = request;
        },
      }),
      async preflight(request) {
        expect(request.endpoint).toBe("https://api.anthropic.com/v1/messages");
        expect(request.apiVersion).toBe("2023-06-01");
        expect(request.modelId).toBe(ANTHROPIC_LIVE_CANARY_MODEL);
        expect(request.retentionMode).toBe("standard-30-day");
        return {
          allowed: true,
          decisionFingerprint: DECISION,
          catalogFingerprint: CATALOG,
          authorizationReference: AUTHORIZATION,
          retentionMode: "standard-30-day",
        };
      },
    });
    const result = await live.run(ANTHROPIC_LIVE_CANARY_OPT_IN);
    expect(observations).toEqual([
      "preflight",
      "availability",
      "secret",
      "transport",
    ]);
    expect(wireRequest).toMatchObject({
      endpoint: "https://api.anthropic.com/v1/messages",
      apiVersion: "2023-06-01",
      modelId: ANTHROPIC_LIVE_CANARY_MODEL,
      maximumResponseBytes: ANTHROPIC_LIVE_CANARY_MAX_RESPONSE_BYTES,
    });
    expect(JSON.parse(wireRequest!.body)).toEqual({
      model: ANTHROPIC_LIVE_CANARY_MODEL,
      max_tokens: 4,
      messages: [{ role: "user", content: "Reply with exactly OK." }],
    });
    expect(wireRequest!.body).not.toMatch(/repository|source|credential|account/i);
    expect(result).toEqual(expect.objectContaining({
      durationMs: 25,
      retentionMode: "standard-30-day",
      inputTokens: 8,
      outputTokens: 1,
      modelSubstitutionRejected: true,
      fixedRequestBody: true,
      repositorySourcePresent: false,
      credentialRetained: false,
      responseBodyRetained: false,
      policyDecisionFingerprint: DECISION,
    }));
    expect(JSON.stringify(result)).not.toContain("owned-test-key");
  });

  it("denies every preflight substitution before secret access and permits one attempt", async () => {
    const substitutions = [
      { catalogFingerprint: "c".repeat(64) },
      { authorizationReference: "authorization:substituted" },
      { retentionMode: "contracted-zero" },
    ];
    for (const substitution of substitutions) {
      const observations: string[] = [];
      const live = canary({
        observations,
        async preflight() {
          return {
            allowed: true,
            decisionFingerprint: DECISION,
            catalogFingerprint: CATALOG,
            authorizationReference: AUTHORIZATION,
            retentionMode: "standard-30-day",
            ...substitution,
          };
        },
      });
      await expect(live.run(ANTHROPIC_LIVE_CANARY_OPT_IN))
        .rejects.toMatchObject({ code: "PREFLIGHT_DENIED" });
      expect(observations).toEqual(["preflight"]);
      await expect(live.run(ANTHROPIC_LIVE_CANARY_OPT_IN))
        .rejects.toMatchObject({ code: "ALREADY_ATTEMPTED" });
    }
  });

  it("rejects model, content, token, byte, and status substitution with redacted errors", async () => {
    const cases = [
      responseBody({ model: "claude-fable-5" }),
      responseBody({ content: [{ type: "text", text: "repository source" }] }),
      responseBody({ content: [{ type: "text", text: " OK " }] }),
      responseBody({ usage: { input_tokens: 8, output_tokens: 5 } }),
      responseBody({ usage: { input_tokens: 257, output_tokens: 1 } }),
      new Uint8Array(ANTHROPIC_LIVE_CANARY_MAX_RESPONSE_BYTES + 1),
    ];
    for (const body of cases) {
      const observations: string[] = [];
      let caught: unknown;
      try {
        await canary({
          observations,
          transport: transport(observations, { body }),
        }).run(ANTHROPIC_LIVE_CANARY_OPT_IN);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AnthropicLiveCanaryError);
      expect((caught as AnthropicLiveCanaryError).code).toMatch(
        /RESPONSE_INVALID|TRANSPORT_FAILURE/,
      );
      expect(JSON.stringify(caught)).not.toMatch(/fable|repository|owned-test-key/i);
      expect([...body].every((byte) => byte === 0)).toBe(true);
    }

    const errorBody = responseBody({ content: [{ type: "text", text: "secret" }] });
    await expect(canary({
      transport: transport([], { body: errorBody, status: 500 }),
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN))
      .rejects.toMatchObject({ code: "TRANSPORT_FAILURE" });
    expect([...errorBody].every((byte) => byte === 0)).toBe(true);
  });

  it("bounds an uncooperative preflight by one wall timer", async () => {
    vi.useFakeTimers();
    try {
      const live = canary({
        async preflight() {
          return new Promise<Record<string, unknown>>(() => undefined);
        },
      });
      const pending = live.run(ANTHROPIC_LIVE_CANARY_OPT_IN);
      const rejected = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
      await vi.advanceTimersByTimeAsync(ANTHROPIC_LIVE_CANARY_TIMEOUT_MS);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("validates scoped SecretRef construction without resolving it", () => {
    expect(() => createAnthropicLiveCanary({
      instanceId: "anthropic:other",
      apiKeyRef: REF,
      retentionMode: "standard-30-day",
      expectedCatalogFingerprint: CATALOG,
      expectedAuthorizationReference: AUTHORIZATION,
      broker: broker([]),
      preflight: { async check() { throw new Error("unused"); } },
      transport: transport([]),
    })).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));

    expect(() => createAnthropicLiveCanary({
      instanceId: "anthropic:live-canary",
      apiKeyRef: REF,
      retentionMode: "standard-30-day",
      expectedCatalogFingerprint: CATALOG,
      expectedAuthorizationReference: AUTHORIZATION,
      broker: broker([]),
      preflight: { async check() { throw new Error("unused"); } },
      transport: {
        kind: "direct-anthropic-https",
        async post() { throw new Error("must not run"); },
      },
    })).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
  });

  it("rejects a late completion and captures transport identity at construction", async () => {
    const observations: string[] = [];
    const original = transport(observations);
    const mutable = {
      kind: "deterministic-fake" as const,
      post: original.post.bind(original),
    };
    const live = canary({ observations, transport: mutable });
    mutable.post = async () => { throw new Error("mutated transport must not run"); };
    await expect(live.run(ANTHROPIC_LIVE_CANARY_OPT_IN))
      .resolves.toMatchObject({ transportKind: "deterministic-fake" });

    let tick = 0;
    await expect(canary({
      now: () => new Date(tick++ === 0 ? 1_000 : 16_000),
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN))
      .rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("zeros direct-transport chunks and uses one caller-released response buffer", async () => {
    const chunks = [
      Buffer.from('{"type":"message",'),
      Buffer.from('"role":"assistant"}'),
    ];
    const requestBody = JSON.stringify({
      model: ANTHROPIC_LIVE_CANARY_MODEL,
      max_tokens: 4,
      messages: [{ role: "user", content: "Reply with exactly OK." }],
    });
    let capturedOptions: Record<string, unknown> | null = null;
    let capturedBody: Uint8Array | null = null;
    const fakeRequest = ((options: unknown, callback: (response: unknown) => void) => {
      capturedOptions = options as Record<string, unknown>;
      const request = new EventEmitter() as EventEmitter & {
        destroy(error?: Error): void;
        end(body?: Uint8Array): void;
      };
      request.destroy = (error?: Error) => {
        if (error !== undefined) request.emit("error", error);
        request.emit("close");
      };
      request.end = (body?: Uint8Array) => {
        capturedBody = body === undefined ? null : Uint8Array.from(body);
        queueMicrotask(() => {
          const response = new EventEmitter() as EventEmitter & {
            statusCode: number;
            headers: Record<string, string>;
          };
          response.statusCode = 200;
          response.headers = { "content-type": "application/json" };
          callback(response);
          for (const chunk of chunks) response.emit("data", chunk);
          response.emit("end");
        });
      };
      return request;
    }) as never;
    const direct = createDirectAnthropicLiveCanaryTransportForTesting(fakeRequest);
    const result = await direct.post({
      endpoint: "https://api.anthropic.com/v1/messages",
      apiVersion: "2023-06-01",
      modelId: ANTHROPIC_LIVE_CANARY_MODEL,
      body: requestBody,
      maximumResponseBytes: 64,
      signal: new AbortController().signal,
    }, "test-key");
    expect(capturedOptions).toEqual({
      protocol: "https:",
      hostname: "api.anthropic.com",
      port: 443,
      path: "/v1/messages",
      method: "POST",
      agent: false,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(requestBody),
        "anthropic-version": "2023-06-01",
        "x-api-key": "test-key",
      },
    });
    expect(new TextDecoder().decode(capturedBody!)).toBe(requestBody);
    expect(chunks.every((chunk) => chunk.every((byte) => byte === 0))).toBe(true);
    expect(new TextDecoder().decode(result.body)).toBe(
      '{"type":"message","role":"assistant"}',
    );
    result.body.fill(0);
    expect([...result.body].every((byte) => byte === 0)).toBe(true);
  });

  it("refuses pre-abort and destroys one in-flight direct request on abort", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    let requestCalls = 0;
    const unusedRequest = (() => {
      requestCalls += 1;
      throw new Error("must not construct a request");
    }) as never;
    await expect(createDirectAnthropicLiveCanaryTransportForTesting(unusedRequest)
      .post({
        endpoint: "https://api.anthropic.com/v1/messages",
        apiVersion: "2023-06-01",
        modelId: ANTHROPIC_LIVE_CANARY_MODEL,
        body: "{}",
        maximumResponseBytes: 64,
        signal: preAborted.signal,
      }, "test-key"))
      .rejects.toMatchObject({ code: "TIMEOUT" });
    expect(requestCalls).toBe(0);

    const controller = new AbortController();
    const destroyedWith: Error[] = [];
    const activeRequest = ((_options: unknown, _callback: (response: unknown) => void) => {
      requestCalls += 1;
      const request = new EventEmitter() as EventEmitter & {
        destroy(error?: Error): void;
        end(body?: Uint8Array): void;
      };
      request.destroy = (error?: Error) => {
        if (error !== undefined) destroyedWith.push(error);
        if (error !== undefined) request.emit("error", error);
        request.emit("close");
      };
      request.end = () => undefined;
      return request;
    }) as never;
    const pending = createDirectAnthropicLiveCanaryTransportForTesting(activeRequest)
      .post({
        endpoint: "https://api.anthropic.com/v1/messages",
        apiVersion: "2023-06-01",
        modelId: ANTHROPIC_LIVE_CANARY_MODEL,
        body: "{}",
        maximumResponseBytes: 64,
        signal: controller.signal,
      }, "test-key");
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(requestCalls).toBe(1);
    expect(destroyedWith).toHaveLength(1);
    expect(destroyedWith[0]).toMatchObject({ code: "TIMEOUT" });
  });

  it("rejects an over-chunked direct stream and zeros chunks arriving after settlement", async () => {
    const chunks = Array.from({ length: 130 }, () => Buffer.from("x"));
    const fakeRequest = ((_options: unknown, callback: (response: unknown) => void) => {
      const request = new EventEmitter() as EventEmitter & {
        destroy(error?: Error): void;
        end(body?: Uint8Array): void;
      };
      request.destroy = (error?: Error) => {
        if (error !== undefined) request.emit("error", error);
        request.emit("close");
      };
      request.end = () => {
        queueMicrotask(() => {
          const response = new EventEmitter() as EventEmitter & {
            statusCode: number;
            headers: Record<string, string>;
          };
          response.statusCode = 200;
          response.headers = { "content-type": "application/json" };
          callback(response);
          for (const chunk of chunks) response.emit("data", chunk);
          response.emit("end");
        });
      };
      return request;
    }) as never;
    await expect(createDirectAnthropicLiveCanaryTransportForTesting(fakeRequest)
      .post({
        endpoint: "https://api.anthropic.com/v1/messages",
        apiVersion: "2023-06-01",
        modelId: ANTHROPIC_LIVE_CANARY_MODEL,
        body: "{}",
        maximumResponseBytes: 256,
        signal: new AbortController().signal,
      }, "test-key"))
      .rejects.toMatchObject({ code: "RESPONSE_INVALID" });
    expect(chunks.every((chunk) => chunk.every((byte) => byte === 0))).toBe(true);
  });

  it("zeros an injected response that completes only after public timeout", async () => {
    vi.useFakeTimers();
    try {
      const body = responseBody();
      const lateTransport: AnthropicLiveCanaryTransport = Object.freeze({
        kind: "deterministic-fake" as const,
        post: () => new Promise((resolve) => {
          setTimeout(() => resolve({
            status: 200,
            contentType: "application/json",
            body,
          }), ANTHROPIC_LIVE_CANARY_TIMEOUT_MS + 1);
        }),
      });
      const pending = canary({ transport: lateTransport })
        .run(ANTHROPIC_LIVE_CANARY_OPT_IN);
      const rejected = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
      await vi.advanceTimersByTimeAsync(ANTHROPIC_LIVE_CANARY_TIMEOUT_MS);
      await rejected;
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      expect([...body].every((byte) => byte === 0)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps malformed and hostile clocks to one finite configuration error", async () => {
    expect(() => createAnthropicLiveCanary({
      instanceId: "anthropic:live-canary",
      apiKeyRef: REF,
      retentionMode: "standard-30-day",
      expectedCatalogFingerprint: CATALOG,
      expectedAuthorizationReference: AUTHORIZATION,
      broker: broker([]),
      preflight: { async check() { throw new Error("unused"); } },
      transport: transport([]),
      now: 1 as never,
    })).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));

    await expect(canary({
      now: (() => { throw new Error("secret-clock-canary"); }) as never,
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN))
      .rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await expect(canary({
      now: (() => ({ valueOf: () => 1_000 })) as never,
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN))
      .rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
  });
});
