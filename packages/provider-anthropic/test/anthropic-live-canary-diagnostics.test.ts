import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  SecretBrokerError,
  createSecretMaterial,
  type SecretAccessContext,
  type SecretBroker,
  type SecretRef,
} from "@ai-dev-os/secrets";
import {
  ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_CATEGORIES,
  ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_KEYS,
  ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_SCHEMA_VERSION,
  ANTHROPIC_LIVE_CANARY_ERROR_CODES,
  ANTHROPIC_LIVE_CANARY_FAILURE_PHASES,
  ANTHROPIC_LIVE_CANARY_MAX_RESPONSE_BYTES,
  ANTHROPIC_LIVE_CANARY_MAX_RETRY_AFTER_SECONDS,
  ANTHROPIC_LIVE_CANARY_MAX_TOKENS,
  ANTHROPIC_LIVE_CANARY_MODEL,
  ANTHROPIC_LIVE_CANARY_OPT_IN,
  ANTHROPIC_LIVE_CANARY_TIMEOUT_MS,
  ANTHROPIC_LIVE_CANARY_TRANSPORT_ERROR_KINDS,
  ANTHROPIC_PROVIDER_ERROR_TYPES,
  ANTHROPIC_PROVIDER_STOP_REASONS,
  AnthropicLiveCanaryError,
  anthropicLiveCanaryDiagnosticsEqual,
  classifyAnthropicLiveCanaryDiagnostics,
  createAnthropicLiveCanary,
  normalizeHttpStatus,
  normalizeRetryAfterSeconds,
  projectAnthropicLiveCanaryDiagnostics,
  readProviderResponseFacts,
  transportErrorKindOf,
  type AnthropicLiveCanaryDiagnostics,
  type AnthropicLiveCanaryOptions,
  type AnthropicLiveCanaryTransport,
  type AnthropicLiveCanaryTransportRequest,
} from "../src/testing/index.js";
import { createAnthropicLiveCanaryWithDirectTransportForTesting } from
  "../src/testing/live-canary.js";

/**
 * One recognizable string planted in every attacker-controlled position. Each
 * redaction assertion is paired with a positive control proving the string was
 * actually present in the fixture, so a vector cannot pass by being empty.
 */
const SECRET_CANARY = "ZZ-canary-leak-sentinel-9f13d2a7";
const REQUEST_ID_VALUE = `req_${SECRET_CANARY}`;

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
      return {
        available: true,
        reason: "available" as const,
        audit: {
          schemaVersion: 1 as const,
          operation: "availability" as const,
          phase: "outcome" as const,
          outcome: "success" as const,
          occurredAt: "2026-08-16T00:00:00.000Z",
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

function failingAvailabilityBroker(observations: string[]): SecretBroker {
  const base = broker(observations);
  return Object.freeze({
    ...base,
    async availability() {
      observations.push("availability");
      throw new SecretBrokerError(
        "BACKEND_FAILURE",
        `synthetic availability detail ${SECRET_CANARY}`,
      );
    },
  });
}

function postCallbackFailingBroker(observations: string[]): SecretBroker {
  const base = broker(observations);
  return Object.freeze({
    ...base,
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
        await callback(material);
        throw new SecretBrokerError(
          "AUDIT_FAILURE",
          `synthetic outcome audit detail ${SECRET_CANARY}`,
        );
      } catch {
        throw new SecretBrokerError(
          "CONSUMER_FAILURE",
          "The secret consumer failed.",
        );
      } finally {
        material.dispose();
      }
    },
  });
}

function successBody(overrides: Record<string, unknown> = {}): Uint8Array {
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

/** A provider error envelope whose message carries the leak sentinel. */
function errorBody(type: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    type: "error",
    error: { type, message: `provider prose ${SECRET_CANARY}` },
    request_id: REQUEST_ID_VALUE,
  }));
}

interface FakeTransportOptions {
  readonly body?: Uint8Array;
  readonly status?: number;
  readonly contentType?: string | null;
  readonly requestIdPresent?: boolean;
  readonly retryAfterSeconds?: unknown;
  readonly inspect?: (request: AnthropicLiveCanaryTransportRequest) => void;
}

function transport(
  observations: string[],
  options: FakeTransportOptions = {},
): AnthropicLiveCanaryTransport {
  return Object.freeze({
    kind: "deterministic-fake" as const,
    async post(request: AnthropicLiveCanaryTransportRequest) {
      observations.push("transport");
      options.inspect?.(request);
      const response: Record<string, unknown> = {
        status: options.status ?? 200,
        contentType: options.contentType === undefined
          ? "application/json; charset=utf-8"
          : options.contentType,
        body: options.body ?? successBody(),
      };
      if (options.requestIdPresent !== undefined) {
        response["requestIdPresent"] = options.requestIdPresent;
      }
      if (options.retryAfterSeconds !== undefined) {
        response["retryAfterSeconds"] = options.retryAfterSeconds;
      }
      return response as never;
    },
  });
}

interface CanaryFixtureOptions {
  readonly observations?: string[];
  readonly secretBroker?: SecretBroker;
  readonly transport?: AnthropicLiveCanaryTransport;
  readonly preflight?: () => Promise<Record<string, unknown>>;
  readonly now?: () => Date;
}

function canaryOptions(options: CanaryFixtureOptions): AnthropicLiveCanaryOptions {
  const observations = options.observations ?? [];
  let tick = 0;
  return {
    instanceId: "anthropic:live-canary",
    apiKeyRef: REF,
    retentionMode: "standard-30-day",
    expectedCatalogFingerprint: CATALOG,
    expectedAuthorizationReference: AUTHORIZATION,
    broker: options.secretBroker ?? broker(observations),
    preflight: {
      async check() {
        observations.push("preflight");
        return options.preflight?.() ?? {
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
  };
}

function canary(options: CanaryFixtureOptions) {
  return createAnthropicLiveCanary(canaryOptions(options));
}

/** Runs one canary and returns the thrown failure, asserting one was thrown. */
async function failureOf(options: CanaryFixtureOptions): Promise<AnthropicLiveCanaryError> {
  let caught: unknown;
  try {
    await canary(options).run(ANTHROPIC_LIVE_CANARY_OPT_IN);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AnthropicLiveCanaryError);
  return caught as AnthropicLiveCanaryError;
}

/** Every representation an operator or log could plausibly capture. */
function renderings(error: AnthropicLiveCanaryError): readonly string[] {
  return [
    JSON.stringify(error),
    JSON.stringify(error.diagnostics),
    String(error),
    error.message,
    inspect(error, { depth: 8 }),
    inspect(error.diagnostics, { depth: 8 }),
  ];
}

function expectNoLeak(error: AnthropicLiveCanaryError): void {
  for (const rendering of renderings(error)) {
    expect(rendering).not.toContain(SECRET_CANARY);
    expect(rendering).not.toMatch(/provider prose|synthetic|owned-test-key/i);
  }
}

describe("Anthropic live canary diagnostic envelope: provider status taxonomy", () => {
  it("1. accepts an authenticated successful response without altering the result", async () => {
    const observations: string[] = [];
    const result = await canary({ observations }).run(ANTHROPIC_LIVE_CANARY_OPT_IN);
    expect(result).toMatchObject({
      schemaVersion: 1,
      statusCategory: "success",
      modelId: ANTHROPIC_LIVE_CANARY_MODEL,
      inputTokens: 8,
      outputTokens: 1,
      credentialRetained: false,
      responseBodyRetained: false,
    });
    // The success contract is unchanged: diagnostics attach to failures only.
    expect(Object.keys(result)).not.toContain("diagnostics");
    expect(observations).toEqual([
      "preflight",
      "availability",
      "secret",
      "transport",
    ]);
  });

  it.each([
    [400, "invalid_request_error", "request-invalid"],
    [401, "authentication_error", "credential-unauthenticated"],
    [402, "billing_error", "billing-unavailable"],
    [403, "permission_error", "permission-denied"],
    [404, "not_found_error", "model-or-resource-unavailable"],
    [409, "conflict_error", "request-conflict"],
    [413, "request_too_large", "request-too-large"],
    [429, "rate_limit_error", "rate-limited"],
    [500, "api_error", "provider-internal-error"],
    [504, "timeout_error", "provider-timeout"],
    [529, "overloaded_error", "provider-overloaded"],
  ])(
    "2-12. classifies HTTP %i %s as %s",
    async (status, errorType, category) => {
      const body = errorBody(errorType);
      const error = await failureOf({
        transport: transport([], { status, body }),
      });
      expect(error.code).toBe("TRANSPORT_FAILURE");
      expect(error.failurePhase).toBe("response-received");
      expect(error.diagnostics).toMatchObject({
        schemaVersion: ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_SCHEMA_VERSION,
        category,
        httpStatus: status,
        providerErrorType: errorType,
        providerErrorEnvelopeObserved: true,
        responseStreamBegan: false,
      });
      expectNoLeak(error);
      expect([...body].every((byte) => byte === 0)).toBe(true);
    },
  );

  it("13. represents an unknown future 4xx error type as unknown while keeping the status class", async () => {
    const error = await failureOf({
      transport: transport([], {
        status: 400,
        body: errorBody("teapot_conformance_error_2031"),
      }),
    });
    expect(error.diagnostics).toMatchObject({
      category: "request-invalid",
      httpStatus: 400,
      providerErrorType: "unknown",
      providerErrorEnvelopeObserved: true,
    });
    expectNoLeak(error);
  });

  it("14. represents an unknown future 5xx error type as unknown while keeping the status class", async () => {
    const error = await failureOf({
      transport: transport([], {
        status: 500,
        body: errorBody("regional_brownout_error_2031"),
      }),
    });
    expect(error.diagnostics).toMatchObject({
      category: "provider-internal-error",
      httpStatus: 500,
      providerErrorType: "unknown",
    });
    expectNoLeak(error);
  });

  it("refuses to classify an undocumented status rather than guessing a family", async () => {
    for (const status of [418, 451, 503]) {
      const error = await failureOf({
        transport: transport([], { status, body: errorBody("api_error") }),
      });
      // The raw status still reaches the operator; only the label stays honest.
      expect(error.diagnostics.category).toBe("unknown");
      expect(error.diagnostics.httpStatus).toBe(status);
    }
  });
});

describe("Anthropic live canary diagnostic envelope: transport and timing", () => {
  function directCanary(
    observations: string[],
    build: (
      callback: (response: unknown) => void,
    ) => EventEmitter & { destroy(error?: Error): void; end(body?: Uint8Array): void },
  ) {
    const requestFunction = ((
      _options: unknown,
      callback: (response: unknown) => void,
    ) => build(callback)) as never;
    return createAnthropicLiveCanaryWithDirectTransportForTesting(
      { ...canaryOptions({ observations }), transport: undefined },
      requestFunction,
    );
  }

  function emitter(): EventEmitter & {
    destroy(error?: Error): void;
    end(body?: Uint8Array): void;
  } {
    const request = new EventEmitter() as EventEmitter & {
      destroy(error?: Error): void;
      end(body?: Uint8Array): void;
    };
    request.destroy = () => undefined;
    return request;
  }

  function codedError(code: string): Error & { code: string } {
    const error = new Error(`socket detail ${SECRET_CANARY}`) as Error & {
      code: string;
    };
    error.code = code;
    return error;
  }

  it.each([
    ["ENOTFOUND", "dns"],
    ["EAI_AGAIN", "dns"],
    ["ECONNREFUSED", "connection-refused"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls"],
    ["CERT_HAS_EXPIRED", "tls"],
    ["ERR_SSL_WRONG_VERSION_NUMBER", "tls"],
    ["ECONNRESET", "connection-reset"],
    ["EHOSTUNREACH", "unreachable"],
  ])(
    "15-18. maps socket failure %s to transport kind %s before any response",
    async (code, kind) => {
      const observations: string[] = [];
      let caught: unknown;
      try {
        await directCanary(observations, () => {
          const request = emitter();
          request.end = () =>
            queueMicrotask(() => request.emit("error", codedError(code)));
          return request;
        }).run(ANTHROPIC_LIVE_CANARY_OPT_IN);
      } catch (error) {
        caught = error;
      }
      const error = caught as AnthropicLiveCanaryError;
      expect(error.code).toBe("TRANSPORT_FAILURE");
      expect(error.failurePhase).toBe("possibly-dispatched");
      expect(error.diagnostics).toMatchObject({
        category: "network-transport",
        transportErrorKind: kind,
        httpStatus: null,
        providerErrorType: null,
        requestIdPresent: false,
      });
      expectNoLeak(error);
    },
  );

  it("19. classifies a socket reset after response headers at response-received", async () => {
    const observations: string[] = [];
    let caught: unknown;
    try {
      await directCanary(observations, (callback) => {
        const request = emitter();
        request.end = () =>
          queueMicrotask(() => {
            const response = new EventEmitter() as EventEmitter & {
              statusCode: number;
              headers: Record<string, string>;
            };
            response.statusCode = 200;
            response.headers = { "content-type": "application/json" };
            callback(response);
            response.emit("error", codedError("ECONNRESET"));
          });
        return request;
      }).run(ANTHROPIC_LIVE_CANARY_OPT_IN);
    } catch (error) {
      caught = error;
    }
    const error = caught as AnthropicLiveCanaryError;
    expect(error.failurePhase).toBe("response-received");
    expect(error.diagnostics).toMatchObject({
      category: "network-transport",
      transportErrorKind: "connection-reset",
    });
    expectNoLeak(error);
  });

  it("19b. treats an aborted response stream as a connection-level truncation", async () => {
    const observations: string[] = [];
    let caught: unknown;
    try {
      await directCanary(observations, (callback) => {
        const request = emitter();
        request.end = () =>
          queueMicrotask(() => {
            const response = new EventEmitter() as EventEmitter & {
              statusCode: number;
              headers: Record<string, string>;
            };
            response.statusCode = 200;
            response.headers = { "content-type": "application/json" };
            callback(response);
            response.emit("aborted");
          });
        return request;
      }).run(ANTHROPIC_LIVE_CANARY_OPT_IN);
    } catch (error) {
      caught = error;
    }
    const error = caught as AnthropicLiveCanaryError;
    expect(error.diagnostics).toMatchObject({
      category: "network-transport",
      transportErrorKind: "connection-reset",
    });
  });

  it("20. classifies a timeout before dispatch as a local bound", async () => {
    vi.useFakeTimers();
    try {
      const live = canary({
        async preflight() {
          return new Promise<Record<string, unknown>>(() => undefined);
        },
      });
      const pending = live.run(ANTHROPIC_LIVE_CANARY_OPT_IN);
      const settled = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(ANTHROPIC_LIVE_CANARY_TIMEOUT_MS);
      const error = await settled as AnthropicLiveCanaryError;
      expect(error.code).toBe("TIMEOUT");
      expect(error.failurePhase).toBe("pre-dispatch");
      expect(error.diagnostics).toMatchObject({
        category: "local-timeout",
        httpStatus: null,
        transportErrorKind: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("21. classifies a timeout while dispatch is uncertain as a local bound", async () => {
    vi.useFakeTimers();
    try {
      const observations: string[] = [];
      const live = directCanary(observations, () => {
        const request = emitter();
        request.end = () => undefined;
        return request;
      });
      const pending = live.run(ANTHROPIC_LIVE_CANARY_OPT_IN);
      const settled = pending.catch((error: unknown) => error);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(ANTHROPIC_LIVE_CANARY_TIMEOUT_MS);
      const error = await settled as AnthropicLiveCanaryError;
      expect(error.code).toBe("TIMEOUT");
      expect(error.failurePhase).toBe("possibly-dispatched");
      expect(error.diagnostics.category).toBe("local-timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("22. classifies a timeout after response receipt as a local bound", async () => {
    vi.useFakeTimers();
    try {
      const observations: string[] = [];
      const live = directCanary(observations, (callback) => {
        const request = emitter();
        request.end = () =>
          queueMicrotask(() => {
            const response = new EventEmitter() as EventEmitter & {
              statusCode: number;
              headers: Record<string, string>;
            };
            response.statusCode = 200;
            response.headers = { "content-type": "application/json" };
            callback(response);
          });
        return request;
      });
      const pending = live.run(ANTHROPIC_LIVE_CANARY_OPT_IN);
      const settled = pending.catch((error: unknown) => error);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(ANTHROPIC_LIVE_CANARY_TIMEOUT_MS);
      const error = await settled as AnthropicLiveCanaryError;
      expect(error.code).toBe("TIMEOUT");
      expect(error.failurePhase).toBe("response-received");
      expect(error.diagnostics.category).toBe("local-timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("42b. projects request-id presence and retry-after from direct transport headers", async () => {
    const observations: string[] = [];
    let caught: unknown;
    try {
      await directCanary(observations, (callback) => {
        const request = emitter();
        request.end = () =>
          queueMicrotask(() => {
            const response = new EventEmitter() as EventEmitter & {
              statusCode: number;
              headers: Record<string, string>;
            };
            response.statusCode = 429;
            response.headers = {
              "content-type": "application/json",
              "request-id": REQUEST_ID_VALUE,
              "retry-after": "30",
            };
            callback(response);
            response.emit("data", Buffer.from(errorBody("rate_limit_error")));
            response.emit("end");
          });
        return request;
      }).run(ANTHROPIC_LIVE_CANARY_OPT_IN);
    } catch (error) {
      caught = error;
    }
    const error = caught as AnthropicLiveCanaryError;
    expect(error.diagnostics).toMatchObject({
      category: "rate-limited",
      httpStatus: 429,
      providerErrorType: "rate_limit_error",
      requestIdPresent: true,
      retryAfterSeconds: 30,
    });
    expectNoLeak(error);
  });
});

describe("Anthropic live canary diagnostic envelope: streaming and response usability", () => {
  it("23. classifies a streaming error event delivered after HTTP 200", async () => {
    const stream = [
      "event: message_start",
      `data: ${JSON.stringify({
        type: "message_start",
        message: { type: "message", model: ANTHROPIC_LIVE_CANARY_MODEL },
      })}`,
      "",
      "event: error",
      `data: ${JSON.stringify({
        type: "error",
        error: { type: "overloaded_error", message: `prose ${SECRET_CANARY}` },
      })}`,
      "",
    ].join("\n");
    const error = await failureOf({
      transport: transport([], {
        status: 200,
        contentType: "text/event-stream",
        body: new TextEncoder().encode(stream),
      }),
    });
    expect(error.diagnostics).toMatchObject({
      category: "provider-overloaded",
      httpStatus: 200,
      providerErrorType: "overloaded_error",
      providerErrorEnvelopeObserved: true,
      responseStreamBegan: true,
      modelEcho: true,
    });
    expectNoLeak(error);
  });

  it("24. records a truncated stream as unusable rather than inventing a cause", async () => {
    const truncated = [
      "event: message_start",
      `data: ${JSON.stringify({
        type: "message_start",
        message: { type: "message", model: ANTHROPIC_LIVE_CANARY_MODEL },
      })}`,
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","delta":{"type":"text_de',
    ].join("\n");
    const error = await failureOf({
      transport: transport([], {
        status: 200,
        contentType: "text/event-stream",
        body: new TextEncoder().encode(truncated),
      }),
    });
    expect(error.diagnostics).toMatchObject({
      category: "response-unusable",
      httpStatus: 200,
      providerErrorType: null,
      providerErrorEnvelopeObserved: false,
      responseStreamBegan: true,
    });
  });

  it("25. records malformed JSON at HTTP 200 as unusable", async () => {
    const error = await failureOf({
      transport: transport([], {
        status: 200,
        body: new TextEncoder().encode(`{"type":"message",${SECRET_CANARY}`),
      }),
    });
    expect(error.code).toBe("RESPONSE_INVALID");
    expect(error.diagnostics).toMatchObject({
      category: "response-unusable",
      httpStatus: 200,
      providerErrorEnvelopeObserved: false,
      responseStreamBegan: false,
    });
    expectNoLeak(error);
  });

  it("26. rejects an oversized body without parsing it", async () => {
    const oversized = new Uint8Array(ANTHROPIC_LIVE_CANARY_MAX_RESPONSE_BYTES + 1);
    oversized.fill(0x20);
    const error = await failureOf({
      transport: transport([], { status: 200, body: oversized }),
    });
    expect(error.code).toBe("TRANSPORT_FAILURE");
    expect(error.diagnostics).toMatchObject({
      category: "response-unusable",
      httpStatus: 200,
      providerErrorEnvelopeObserved: false,
    });
  });

  it("classifies a provider refusal distinctly from a malformed payload", async () => {
    const error = await failureOf({
      transport: transport([], {
        status: 200,
        body: successBody({
          content: [{ type: "text", text: "I cannot help with that." }],
          stop_reason: "refusal",
        }),
      }),
    });
    expect(error.code).toBe("RESPONSE_INVALID");
    expect(error.diagnostics).toMatchObject({
      category: "provider-refusal",
      httpStatus: 200,
      stopReason: "refusal",
      modelEcho: true,
    });
    // The refusal text itself is never carried.
    expect(JSON.stringify(error)).not.toContain("cannot help");
  });

  it("reports a model mismatch without copying the served model identifier", async () => {
    const error = await failureOf({
      transport: transport([], {
        status: 200,
        body: successBody({ model: `some-other-model-${SECRET_CANARY}` }),
      }),
    });
    expect(error.diagnostics.modelEcho).toBe(false);
    expectNoLeak(error);
  });
});

describe("Anthropic live canary diagnostic envelope: bounded header projection", () => {
  it("27-28. rejects oversized, negative, fractional, and non-numeric retry values", async () => {
    const rejected: readonly unknown[] = [
      ANTHROPIC_LIVE_CANARY_MAX_RETRY_AFTER_SECONDS + 1,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "9".repeat(64),
      `30 ${SECRET_CANARY}`,
      "-30",
      "",
      {},
    ];
    for (const value of rejected) {
      const error = await failureOf({
        transport: transport([], {
          status: 429,
          body: errorBody("rate_limit_error"),
          retryAfterSeconds: value,
        }),
      });
      expect(error.diagnostics.category, inspect(value)).toBe("rate-limited");
      expect(error.diagnostics.retryAfterSeconds, inspect(value)).toBeNull();
      expectNoLeak(error);
    }
    // Positive control: a valid bounded value is preserved, so the assertions
    // above cannot be passing because the field is always null.
    const accepted = await failureOf({
      transport: transport([], {
        status: 429,
        body: errorBody("rate_limit_error"),
        retryAfterSeconds: 42,
      }),
    });
    expect(accepted.diagnostics.retryAfterSeconds).toBe(42);
  });

  it("29. resolves conflicting status and error-type evidence deterministically", async () => {
    // Status is produced by the transport layer and outranks a body that
    // disagrees with it; both observations are still reported.
    const conflicting = await failureOf({
      transport: transport([], {
        status: 401,
        body: errorBody("overloaded_error"),
      }),
    });
    expect(conflicting.diagnostics).toMatchObject({
      category: "credential-unauthenticated",
      httpStatus: 401,
      providerErrorType: "overloaded_error",
    });

    // Duplicate keys in the payload resolve the same way on every run.
    const duplicated = new TextEncoder().encode(
      '{"type":"error","error":{"type":"authentication_error"},' +
        '"error":{"type":"api_error"}}',
    );
    const first = await failureOf({
      transport: transport([], { status: 200, body: duplicated.slice() }),
    });
    const second = await failureOf({
      transport: transport([], { status: 200, body: duplicated.slice() }),
    });
    expect(first.diagnostics.providerErrorType).toBe("api_error");
    expect(
      anthropicLiveCanaryDiagnosticsEqual(first.diagnostics, second.diagnostics),
    ).toBe(true);
  });

  it("ignores provider prose that contradicts the structured evidence", async () => {
    // Message text is attacker-influenced and can echo request content. A
    // classifier that read it could be steered into reporting a credential or
    // billing cause for a plain provider outage.
    const misleading = new TextEncoder().encode(JSON.stringify({
      type: "error",
      error: {
        type: "api_error",
        message:
          "authentication_error: invalid x-api-key; billing credit balance " +
          `too low; rate_limit_error exceeded; ${SECRET_CANARY}`,
      },
    }));
    const error = await failureOf({
      transport: transport([], { status: 500, body: misleading }),
    });
    expect(error.diagnostics).toMatchObject({
      category: "provider-internal-error",
      httpStatus: 500,
      providerErrorType: "api_error",
    });
    expect(error.diagnostics.category).not.toBe("credential-unauthenticated");
    expect(error.diagnostics.category).not.toBe("billing-unavailable");
    expect(error.diagnostics.category).not.toBe("rate-limited");
    expectNoLeak(error);
  });

  it("30-31. exposes only request-identifier presence, never the identifier", async () => {
    const present = await failureOf({
      transport: transport([], {
        status: 401,
        body: errorBody("authentication_error"),
        requestIdPresent: true,
      }),
    });
    expect(present.diagnostics.requestIdPresent).toBe(true);
    // Positive control: the identifier really is in the fixture payload.
    expect(new TextDecoder().decode(errorBody("authentication_error")))
      .toContain(REQUEST_ID_VALUE);
    for (const rendering of renderings(present)) {
      expect(rendering).not.toContain(REQUEST_ID_VALUE);
      expect(rendering).not.toContain("req_");
    }

    const absent = await failureOf({
      transport: transport([], {
        status: 401,
        body: errorBody("authentication_error"),
        requestIdPresent: false,
      }),
    });
    expect(absent.diagnostics.requestIdPresent).toBe(false);
  });
});

describe("Anthropic live canary diagnostic envelope: hostile input", () => {
  it("32-34. keeps sentinel-bearing messages, headers, and nested fields out of every rendering", async () => {
    const nested = new TextEncoder().encode(JSON.stringify({
      type: "error",
      error: {
        type: "authentication_error",
        message: `provider prose ${SECRET_CANARY}`,
        details: { nested: { deeper: [SECRET_CANARY, { key: SECRET_CANARY }] } },
      },
      request_id: REQUEST_ID_VALUE,
      [`header_${SECRET_CANARY}`]: SECRET_CANARY,
    }));
    // Positive control: every planted position is present before classification.
    const decoded = new TextDecoder().decode(nested);
    expect(decoded.split(SECRET_CANARY).length - 1).toBeGreaterThanOrEqual(6);

    const error = await failureOf({
      transport: transport([], {
        status: 401,
        contentType: `application/json; charset=${SECRET_CANARY}`,
        body: nested,
      }),
    });
    expect(error.diagnostics).toMatchObject({
      category: "credential-unauthenticated",
      providerErrorType: "authentication_error",
    });
    expectNoLeak(error);
    for (const value of Object.values(error.diagnostics)) {
      expect(typeof value === "string" ? value : "").not.toContain(SECRET_CANARY);
    }
  });

  it("35. survives throwing getters, proxies, exotic prototypes, and symbol keys", async () => {
    const hostile: ReadonlyArray<{ name: string; post: () => unknown }> = [
      {
        name: "throwing status getter",
        post: () =>
          Object.defineProperties({}, {
            status: {
              enumerable: true,
              get() { throw new Error(`accessor ${SECRET_CANARY}`); },
            },
            contentType: { enumerable: true, value: "application/json" },
            body: { enumerable: true, value: errorBody("api_error") },
          }),
      },
      {
        name: "proxy response",
        post: () =>
          new Proxy({}, {
            get() { throw new Error(`proxy ${SECRET_CANARY}`); },
            ownKeys() { throw new Error(`ownKeys ${SECRET_CANARY}`); },
          }),
      },
      {
        name: "null prototype with symbol key",
        post: () => {
          const value = Object.create(null) as Record<string, unknown>;
          value["status"] = 401;
          value["contentType"] = "application/json";
          value["body"] = errorBody("authentication_error");
          (value as Record<symbol, unknown>)[Symbol("hostile")] = SECRET_CANARY;
          return value;
        },
      },
      {
        name: "prototype-poisoning payload",
        post: () => ({
          status: 200,
          contentType: "application/json",
          body: new TextEncoder().encode(
            `{"__proto__":{"polluted":"${SECRET_CANARY}"},"type":"error",` +
              '"error":{"type":"api_error"}}',
          ),
        }),
      },
      {
        name: "hostile toJSON on the response",
        post: () => ({
          status: 500,
          contentType: "application/json",
          body: errorBody("api_error"),
          toJSON() { throw new Error(`toJSON ${SECRET_CANARY}`); },
        }),
      },
    ];

    for (const vector of hostile) {
      const error = await failureOf({
        transport: Object.freeze({
          kind: "deterministic-fake" as const,
          async post() { return vector.post() as never; },
        }),
      });
      expect(ANTHROPIC_LIVE_CANARY_ERROR_CODES, vector.name)
        .toContain(error.code);
      expect(ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_CATEGORIES, vector.name)
        .toContain(error.diagnostics.category);
      expectNoLeak(error);
    }
    // No hostile payload reached Object.prototype.
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  /**
   * Two independent guards cover this vector: re-validation of the envelope in
   * `projectCallbackOutcome`, and diagnostics-aware exact-outcome equality.
   * Measured with each guard reintroduced as a defect: removing either alone
   * still refuses, and removing both lets the forged `rate-limited` claim
   * through as `TRANSPORT_FAILURE`. So this vector discriminates the pair, and
   * the validator itself is separately discriminated by the single-field
   * mutation test below.
   */
  it("refuses a substituted diagnostics envelope injected through the broker", async () => {
    const forged: SecretBroker = Object.freeze({
      ...broker([]),
      async withSecret<T>(
        _ref: SecretRef,
        _context: SecretAccessContext,
        callback: Parameters<SecretBroker["withSecret"]>[2],
      ): Promise<T> {
        const material = createSecretMaterial(
          "text",
          new TextEncoder().encode("owned-test-key"),
        );
        try {
          await callback(material);
          // A hostile broker claims a benign, low-alarm cause.
          return {
            status: "failure",
            code: "TRANSPORT_FAILURE",
            failurePhase: "response-received",
            diagnostics: { category: "rate-limited", leaked: SECRET_CANARY },
          } as T;
        } finally {
          material.dispose();
        }
      },
    });
    const error = await failureOf({
      secretBroker: forged,
      transport: transport([], { status: 401, body: errorBody("authentication_error") }),
    });
    expect(error.code).toBe("CALLBACK_RESULT_FAILURE");
    expect(error.diagnostics.category).not.toBe("rate-limited");
    expectNoLeak(error);
  });
});

describe("Anthropic live canary diagnostic envelope: broker boundary", () => {
  it("36. classifies a broker failure before secret resolution", async () => {
    const observations: string[] = [];
    const error = await failureOf({
      observations,
      secretBroker: failingAvailabilityBroker(observations),
    });
    expect(error.code).toBe("SECRET_UNAVAILABLE");
    expect(error.failurePhase).toBe("pre-dispatch");
    expect(error.diagnostics).toMatchObject({
      category: "broker-unavailable",
      httpStatus: null,
      providerErrorType: null,
      transportErrorKind: null,
    });
    expectNoLeak(error);
    expect(observations).not.toContain("transport");
  });

  it("37. classifies a consumer failure after secret resolution", async () => {
    const observations: string[] = [];
    const error = await failureOf({
      observations,
      secretBroker: postCallbackFailingBroker(observations),
    });
    expect(error.code).toBe("CALLBACK_RESULT_FAILURE");
    expect(error.diagnostics.category).toBe("broker-unavailable");
    expectNoLeak(error);
  });

  it("classifies unmet local preconditions without provider evidence", async () => {
    const live = canary({});
    const notOptedIn = await live.run("wrong-sentinel").catch((e: unknown) => e);
    expect(notOptedIn).toMatchObject({
      code: "NOT_OPTED_IN",
      diagnostics: { category: "local-precondition", httpStatus: null },
    });

    const denied = await failureOf({
      preflight: async () => ({
        allowed: false,
        decisionFingerprint: DECISION,
        catalogFingerprint: CATALOG,
        authorizationReference: AUTHORIZATION,
        retentionMode: "standard-30-day",
      }),
    });
    expect(denied.code).toBe("PREFLIGHT_DENIED");
    expect(denied.diagnostics.category).toBe("local-precondition");
  });
});

describe("Anthropic live canary diagnostic envelope: invariants and compatibility", () => {
  it("38. zeroes the response body on success and on every failure class", async () => {
    const successful = successBody();
    await canary({ transport: transport([], { body: successful }) })
      .run(ANTHROPIC_LIVE_CANARY_OPT_IN);
    expect([...successful].every((byte) => byte === 0)).toBe(true);

    const failures: ReadonlyArray<[string, number, Uint8Array]> = [
      ["unauthenticated", 401, errorBody("authentication_error")],
      ["rate limited", 429, errorBody("rate_limit_error")],
      ["overloaded", 529, errorBody("overloaded_error")],
      ["malformed", 200, new TextEncoder().encode("{not json")],
      [
        "refusal",
        200,
        successBody({
          content: [{ type: "text", text: "I cannot help with that." }],
          stop_reason: "refusal",
        }),
      ],
    ];
    for (const [name, status, body] of failures) {
      await failureOf({ transport: transport([], { status, body }) });
      expect([...body].every((byte) => byte === 0), name).toBe(true);
    }
  });

  it("39. round-trips through JSON and re-validates as the same envelope", async () => {
    const error = await failureOf({
      transport: transport([], {
        status: 429,
        body: errorBody("rate_limit_error"),
        requestIdPresent: true,
        retryAfterSeconds: 17,
      }),
    });
    const parsed = JSON.parse(JSON.stringify(error)) as {
      diagnostics: unknown;
    };
    const revalidated = projectAnthropicLiveCanaryDiagnostics(parsed.diagnostics);
    expect(revalidated).not.toBeNull();
    expect(
      anthropicLiveCanaryDiagnosticsEqual(
        revalidated as AnthropicLiveCanaryDiagnostics,
        error.diagnostics,
      ),
    ).toBe(true);
    expect(Object.keys(error.diagnostics)).toEqual([
      ...ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_KEYS,
    ]);
  });

  it("40. leaves the published code, phase, and success vocabularies unchanged", () => {
    expect([...ANTHROPIC_LIVE_CANARY_ERROR_CODES]).toEqual([
      "NOT_OPTED_IN",
      "ALREADY_ATTEMPTED",
      "INVALID_CONFIGURATION",
      "PREFLIGHT_DENIED",
      "SECRET_UNAVAILABLE",
      "TRANSPORT_FAILURE",
      "TIMEOUT",
      "RESPONSE_INVALID",
      "CALLBACK_RESULT_FAILURE",
    ]);
    expect([...ANTHROPIC_LIVE_CANARY_FAILURE_PHASES]).toEqual([
      "pre-dispatch",
      "possibly-dispatched",
      "response-received",
      "post-response",
    ]);
    expect([...ANTHROPIC_PROVIDER_ERROR_TYPES]).toEqual([
      "invalid_request_error",
      "authentication_error",
      "billing_error",
      "permission_error",
      "not_found_error",
      "conflict_error",
      "request_too_large",
      "rate_limit_error",
      "api_error",
      "timeout_error",
      "overloaded_error",
    ]);
    expect([...ANTHROPIC_PROVIDER_STOP_REASONS]).toContain("refusal");
  });

  it("41. preserves the exact fixed request body, fingerprint, and token cap", async () => {
    let observed: AnthropicLiveCanaryTransportRequest | null = null;
    const result = await canary({
      transport: transport([], { inspect: (request) => { observed = request; } }),
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN);

    const request = observed as unknown as AnthropicLiveCanaryTransportRequest;
    expect(request.endpoint).toBe("https://api.anthropic.com/v1/messages");
    expect(request.apiVersion).toBe("2023-06-01");
    expect(request.modelId).toBe("claude-haiku-4-5-20251001");
    expect(request.maximumResponseBytes).toBe(64 * 1024);
    expect(request.body).toBe(
      '{"model":"claude-haiku-4-5-20251001","max_tokens":4,' +
        '"messages":[{"role":"user","content":"Reply with exactly OK."}]}',
    );
    expect(Buffer.byteLength(request.body, "utf8")).toBe(116);
    expect(ANTHROPIC_LIVE_CANARY_MAX_TOKENS).toBe(4);

    // Literal-versus-computed on both sides: the published fingerprint, the
    // digest of the observed bytes, and the canary's own reported value.
    const computed = createHash("sha256").update(request.body, "utf8").digest("hex");
    expect(computed).toBe(
      "0982d0a5d19ff6bf01bc87a40b96da6a33e84bccd294846ea7ecf1ccd2d7a13a",
    );
    expect(result.requestFingerprint).toBe(computed);

    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["model", "max_tokens", "messages"]);
    expect(body["max_tokens"]).toBe(4);
    expect(request.body).not.toMatch(/stream|tool|system|metadata/i);
  });

  it("42. dispatches exactly once per attempt with no automatic retry", async () => {
    for (const [status, body] of [
      [200, successBody()],
      [429, errorBody("rate_limit_error")],
      [500, errorBody("api_error")],
      [529, errorBody("overloaded_error")],
      [504, errorBody("timeout_error")],
    ] as ReadonlyArray<[number, Uint8Array]>) {
      let dispatches = 0;
      const counting: AnthropicLiveCanaryTransport = Object.freeze({
        kind: "deterministic-fake" as const,
        async post() {
          dispatches += 1;
          return { status, contentType: "application/json", body } as never;
        },
      });
      await canary({ transport: counting })
        .run(ANTHROPIC_LIVE_CANARY_OPT_IN)
        .catch(() => undefined);
      // A retryable classification must not cause a retry.
      expect(dispatches, `status ${status}`).toBe(1);
    }
  });

  it("43. refuses a second attempt even after a diagnosed transient failure", async () => {
    let dispatches = 0;
    const live = canary({
      transport: Object.freeze({
        kind: "deterministic-fake" as const,
        async post() {
          dispatches += 1;
          return {
            status: 529,
            contentType: "application/json",
            body: errorBody("overloaded_error"),
          } as never;
        },
      }),
    });
    const first = await live.run(ANTHROPIC_LIVE_CANARY_OPT_IN)
      .catch((error: unknown) => error) as AnthropicLiveCanaryError;
    expect(first.diagnostics.category).toBe("provider-overloaded");

    const second = await live.run(ANTHROPIC_LIVE_CANARY_OPT_IN)
      .catch((error: unknown) => error) as AnthropicLiveCanaryError;
    expect(second.code).toBe("ALREADY_ATTEMPTED");
    expect(second.diagnostics.category).toBe("local-precondition");
    expect(dispatches).toBe(1);
  });

  it("44. never renders raw bodies, headers, identifiers, or exception text", async () => {
    const vectors: ReadonlyArray<CanaryFixtureOptions> = [
      { transport: transport([], { status: 401, body: errorBody("authentication_error") }) },
      { transport: transport([], { status: 402, body: errorBody("billing_error") }) },
      { transport: transport([], { status: 429, body: errorBody("rate_limit_error") }) },
      { transport: transport([], { status: 200, body: new TextEncoder().encode(`{${SECRET_CANARY}`) }) },
      {
        transport: Object.freeze({
          kind: "deterministic-fake" as const,
          async post(): Promise<never> {
            throw new Error(`transport prose ${SECRET_CANARY}`);
          },
        }),
      },
      { secretBroker: failingAvailabilityBroker([]) },
      { secretBroker: postCallbackFailingBroker([]) },
    ];
    for (const vector of vectors) {
      const error = await failureOf(vector);
      expectNoLeak(error);
      for (const rendering of renderings(error)) {
        expect(rendering).not.toContain(REQUEST_ID_VALUE);
      }
      // The published evidence form carries no stack or runtime internals.
      // (`util.inspect` of an Error always prints this process's own stack;
      // that is not provider content and is not what gets published.)
      expect(JSON.stringify(error)).not.toMatch(/\bstack\b|at Object|node:internal/);
      // The public message stays one of the fixed strings.
      expect(error.message).toMatch(/^The (Anthropic|scoped|requested)|^The /);
    }
  });
});

describe("Anthropic live canary diagnostic envelope: adversarial properties", () => {
  /** Deterministic pseudo-random source; tests must not vary between runs. */
  function lcg(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
  }

  it("classifies every plausible status into an allowlisted category without throwing", () => {
    for (let status = 100; status <= 599; status += 1) {
      const diagnostics = classifyAnthropicLiveCanaryDiagnostics({
        httpStatus: status,
        responseRejected: true,
      });
      expect(ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_CATEGORIES)
        .toContain(diagnostics.category);
      expect(diagnostics.httpStatus).toBe(status);
      expect(Object.keys(diagnostics))
        .toEqual([...ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_KEYS]);
    }
    for (const invalid of [99, 600, -1, 1.5, Number.NaN, "200", null, {}]) {
      expect(normalizeHttpStatus(invalid)).toBeNull();
    }
  });

  it("never emits an unallowlisted value from arbitrary byte payloads", () => {
    const random = lcg(20_260_816);
    const fragments = [
      '{"type":"error","error":{"type":"',
      '"}}',
      "authentication_error",
      SECRET_CANARY,
      " ￿",
      "data: ",
      '{"type":"message","stop_reason":"',
      "refusal",
      '","model":"',
      ANTHROPIC_LIVE_CANARY_MODEL,
      '"}',
      "[]{}\\",
      "__proto__",
    ];
    for (let iteration = 0; iteration < 400; iteration += 1) {
      let text = "";
      const parts = 1 + Math.floor(random() * 6);
      for (let part = 0; part < parts; part += 1) {
        text += fragments[Math.floor(random() * fragments.length)];
      }
      const facts = readProviderResponseFacts(
        new TextEncoder().encode(text),
        random() < 0.5 ? "application/json" : "text/event-stream",
        ANTHROPIC_LIVE_CANARY_MODEL,
      );
      if (facts.providerErrorType !== null) {
        expect(
          [...ANTHROPIC_PROVIDER_ERROR_TYPES, "unknown"],
        ).toContain(facts.providerErrorType);
      }
      if (facts.stopReason !== null) {
        expect([...ANTHROPIC_PROVIDER_STOP_REASONS, "unknown"])
          .toContain(facts.stopReason);
      }
      expect(typeof facts.providerErrorEnvelopeObserved).toBe("boolean");
      expect(typeof facts.responseStreamBegan).toBe("boolean");
      expect(facts.modelEcho === null || typeof facts.modelEcho === "boolean")
        .toBe(true);
      expect(JSON.stringify(facts)).not.toContain(SECRET_CANARY);
    }
  });

  it("rejects every single-field mutation of a valid envelope", () => {
    const valid = classifyAnthropicLiveCanaryDiagnostics({
      httpStatus: 429,
      requestIdPresent: true,
      retryAfterSeconds: 30,
      responseFacts: {
        providerErrorType: "rate_limit_error",
        providerErrorEnvelopeObserved: true,
        responseStreamBegan: false,
        stopReason: null,
        modelEcho: null,
      },
    });
    expect(projectAnthropicLiveCanaryDiagnostics({ ...valid })).not.toBeNull();

    const mutations: ReadonlyArray<Record<string, unknown>> = [
      { schemaVersion: 2 },
      { category: "totally-new-category" },
      { category: 1 },
      { httpStatus: 999 },
      { httpStatus: "429" },
      { providerErrorType: "made_up_error" },
      { providerErrorEnvelopeObserved: "true" },
      { requestIdPresent: 1 },
      { retryAfterSeconds: -5 },
      { retryAfterSeconds: ANTHROPIC_LIVE_CANARY_MAX_RETRY_AFTER_SECONDS + 1 },
      { responseStreamBegan: null },
      { stopReason: "invented_reason" },
      { modelEcho: "yes" },
      { transportErrorKind: "quantum" },
    ];
    for (const mutation of mutations) {
      expect(
        projectAnthropicLiveCanaryDiagnostics({ ...valid, ...mutation }),
        inspect(mutation),
      ).toBeNull();
    }
    // Extra and missing fields are both rejected.
    expect(projectAnthropicLiveCanaryDiagnostics({ ...valid, extra: 1 })).toBeNull();
    const { modelEcho: _removed, ...missing } = valid;
    expect(projectAnthropicLiveCanaryDiagnostics(missing)).toBeNull();
    expect(projectAnthropicLiveCanaryDiagnostics(null)).toBeNull();
    expect(projectAnthropicLiveCanaryDiagnostics("not an object")).toBeNull();
  });

  it("normalizes unallowlisted values supplied directly to the classifier", () => {
    // The constructor is the last place an unallowlisted value could enter the
    // envelope, so it re-checks its inputs rather than trusting its callers.
    const diagnostics = classifyAnthropicLiveCanaryDiagnostics({
      localCategory: "totally-made-up" as never,
      transportErrorKind: "quantum" as never,
      httpStatus: 4_000,
      retryAfterSeconds: -12,
      requestIdPresent: "yes" as never,
      responseFacts: {
        providerErrorType: "invented_error" as never,
        providerErrorEnvelopeObserved: "true" as never,
        responseStreamBegan: 1 as never,
        stopReason: "invented_reason" as never,
        modelEcho: "maybe" as never,
      },
    });
    expect(diagnostics).toEqual({
      schemaVersion: ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_SCHEMA_VERSION,
      category: "unknown",
      httpStatus: null,
      providerErrorType: null,
      providerErrorEnvelopeObserved: false,
      requestIdPresent: false,
      retryAfterSeconds: null,
      responseStreamBegan: false,
      stopReason: null,
      modelEcho: null,
      transportErrorKind: null,
    });
    // The result is still a valid envelope by the validator's own rules.
    expect(projectAnthropicLiveCanaryDiagnostics({ ...diagnostics })).not.toBeNull();

    // Positive control: allowlisted values in the same shape are preserved.
    const preserved = classifyAnthropicLiveCanaryDiagnostics({
      localCategory: "broker-unavailable",
      transportErrorKind: "dns",
      responseFacts: {
        providerErrorType: "api_error",
        providerErrorEnvelopeObserved: true,
        responseStreamBegan: true,
        stopReason: "refusal",
        modelEcho: true,
      },
    });
    expect(preserved).toMatchObject({
      category: "broker-unavailable",
      transportErrorKind: "dns",
      providerErrorType: "api_error",
      stopReason: "refusal",
      modelEcho: true,
      responseStreamBegan: true,
    });
  });

  it("maps only allowlisted runtime error codes and ignores prose", () => {
    for (const kind of ANTHROPIC_LIVE_CANARY_TRANSPORT_ERROR_KINDS) {
      expect(ANTHROPIC_LIVE_CANARY_TRANSPORT_ERROR_KINDS).toContain(kind);
    }
    expect(transportErrorKindOf({ code: "ENOTFOUND" })).toBe("dns");
    expect(transportErrorKindOf({ code: "ERR_TLS_ANYTHING_NEW" })).toBe("tls");
    expect(transportErrorKindOf({ code: "E_FUTURE_CODE" })).toBe("other");
    expect(transportErrorKindOf({ code: "X".repeat(200) })).toBe("other");
    expect(transportErrorKindOf({ code: 42 })).toBeNull();
    expect(transportErrorKindOf({})).toBeNull();
    expect(transportErrorKindOf(null)).toBeNull();
    // A message that names a code must not be read as one.
    expect(transportErrorKindOf(new Error("ECONNREFUSED happened"))).toBeNull();
    // A throwing accessor cannot escape as a classification or an exception.
    const throwing = Object.defineProperty({}, "code", {
      enumerable: true,
      get() { throw new Error(SECRET_CANARY); },
    });
    expect(transportErrorKindOf(throwing)).toBeNull();
  });

  it("normalizes retry values identically across numeric and string forms", () => {
    expect(normalizeRetryAfterSeconds(0)).toBe(0);
    expect(normalizeRetryAfterSeconds("0")).toBe(0);
    expect(normalizeRetryAfterSeconds(30)).toBe(30);
    expect(normalizeRetryAfterSeconds("30")).toBe(30);
    expect(normalizeRetryAfterSeconds(ANTHROPIC_LIVE_CANARY_MAX_RETRY_AFTER_SECONDS))
      .toBe(ANTHROPIC_LIVE_CANARY_MAX_RETRY_AFTER_SECONDS);
    expect(normalizeRetryAfterSeconds("+30")).toBeNull();
    expect(normalizeRetryAfterSeconds(" 30")).toBeNull();
    expect(normalizeRetryAfterSeconds("0x1e")).toBeNull();
    expect(normalizeRetryAfterSeconds("30.0")).toBeNull();
  });
});
