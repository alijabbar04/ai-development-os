import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  SecretBrokerError,
  createSecretMaterial,
  type SecretAccessContext,
  type SecretBroker,
  type SecretMaterial,
  type SecretRef,
} from "@ai-dev-os/secrets";
import {
  ANTHROPIC_LIVE_CANARY_CALLBACK_DRAIN_MS,
  ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_KEYS,
  ANTHROPIC_LIVE_CANARY_FAILURE_PHASES,
  ANTHROPIC_LIVE_CANARY_MAX_RESPONSE_BYTES,
  ANTHROPIC_LIVE_CANARY_MODEL,
  ANTHROPIC_LIVE_CANARY_OPT_IN,
  ANTHROPIC_LIVE_CANARY_TIMEOUT_MS,
  AnthropicLiveCanaryError,
  createAnthropicLiveCanary,
  type AnthropicLiveCanaryOptions,
  type AnthropicLiveCanaryPreflightRequest,
  type AnthropicLiveCanaryTransport,
  type AnthropicLiveCanaryTransportRequest,
  type AnthropicLiveCanaryTransportResponse,
} from "../src/testing/index.js";
import { createDirectAnthropicLiveCanaryTransportForTesting } from
  "../src/testing/live-canary.js";
import { createAnthropicLiveCanaryWithDirectTransportForTesting } from
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

function callbackCollapsingBroker(
  observations: string[],
  options: {
    readonly availabilityError?: boolean;
    readonly failAfterCallback?: boolean;
  } = {},
): SecretBroker {
  const base = broker(observations);
  return Object.freeze({
    ...base,
    async availability(ref: SecretRef, context: SecretAccessContext) {
      if (options.availabilityError === true) {
        observations.push("availability");
        throw new SecretBrokerError(
          "BACKEND_FAILURE",
          "synthetic availability detail that must not escape",
        );
      }
      return base.availability(ref, context);
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
        const value = await callback(material) as T;
        if (options.failAfterCallback === true) {
          throw new SecretBrokerError(
            "AUDIT_FAILURE",
            "synthetic outcome audit detail that must not escape",
          );
        }
        return value;
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

interface CanaryFixtureOptions {
  readonly observations?: string[];
  readonly secretBroker?: SecretBroker;
  readonly transport?: AnthropicLiveCanaryTransport;
  readonly preflight?: (
    request: AnthropicLiveCanaryPreflightRequest,
  ) => Promise<Record<string, unknown>>;
  readonly now?: () => Date;
  readonly observeFailurePhase?: AnthropicLiveCanaryOptions["observeFailurePhase"];
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
    ...(options.observeFailurePhase === undefined ? {} : { observeFailurePhase: options.observeFailurePhase }),
  };
}

function canary(options: CanaryFixtureOptions) {
  return createAnthropicLiveCanary(canaryOptions(options));
}

describe("explicit opt-in Anthropic live canary", () => {
  it("publishes one exact finite failure-phase vocabulary", () => {
    expect(ANTHROPIC_LIVE_CANARY_FAILURE_PHASES).toEqual([
      "pre-dispatch",
      "possibly-dispatched",
      "response-received",
      "post-response",
    ]);
  });

  it("reports bounded phase advances and accepts external cancellation without widening the result", async () => {
    const phases: string[] = [];
    let started!: () => void;
    const transportStarted = new Promise<void>((resolve) => { started = resolve; });
    const external = new AbortController();
    const live = canary({
      observeFailurePhase(phase) { phases.push(phase); },
      transport: Object.freeze({
        kind: "deterministic-fake" as const,
        async post(request: AnthropicLiveCanaryTransportRequest) {
          started();
          await new Promise<void>((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(new Error("synthetic abort")), { once: true });
          });
          throw new Error("unreachable");
        },
      }),
    });
    const pending = live.run(ANTHROPIC_LIVE_CANARY_OPT_IN, external.signal);
    await transportStarted;
    external.abort();
    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT", failurePhase: "possibly-dispatched" });
    expect(phases).toEqual(["possibly-dispatched"]);
    await expect(live.run(ANTHROPIC_LIVE_CANARY_OPT_IN)).rejects.toMatchObject({ code: "ALREADY_ATTEMPTED" });
  });

  it("refuses a success when external cancellation wins after the response callback", async () => {
    const observations: string[] = [];
    const external = new AbortController();
    const base = broker(observations);
    const cancelAfterCallback: SecretBroker = Object.freeze({
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
          const value = await callback(material) as T;
          external.abort();
          return value;
        } finally {
          material.dispose();
        }
      },
    });
    const live = canary({ observations, secretBroker: cancelAfterCallback });
    await expect(live.run(ANTHROPIC_LIVE_CANARY_OPT_IN, external.signal))
      .rejects.toMatchObject({ code: "TIMEOUT", failurePhase: "post-response" });
    expect(observations).toEqual(["preflight", "availability", "secret", "transport"]);
  });

  it("refuses before policy, secret, or transport without the exact sentinel", async () => {
    const observations: string[] = [];
    const live = canary({ observations });
    await expect(live.run("1")).rejects.toMatchObject({
      code: "NOT_OPTED_IN",
      failurePhase: "pre-dispatch",
    });
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
        .rejects.toMatchObject({
          code: "PREFLIGHT_DENIED",
          failurePhase: "pre-dispatch",
        });
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
      expect((caught as AnthropicLiveCanaryError).failurePhase).toBe(
        "response-received",
      );
      expect(JSON.stringify(caught)).not.toMatch(/fable|repository|owned-test-key/i);
      expect([...body].every((byte) => byte === 0)).toBe(true);
    }

    const errorBody = responseBody({ content: [{ type: "text", text: "secret" }] });
    await expect(canary({
      transport: transport([], { body: errorBody, status: 500 }),
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN))
      .rejects.toMatchObject({
        code: "TRANSPORT_FAILURE",
        failurePhase: "response-received",
      });
    expect([...errorBody].every((byte) => byte === 0)).toBe(true);
  });

  it("rejects duplicate JSON members at the root and nested response boundaries", async () => {
    const model = ANTHROPIC_LIVE_CANARY_MODEL;
    const cases = [
      `{"type":"message","role":"assistant","model":"substituted","model":"${model}","content":[{"type":"text","text":"OK"}],"usage":{"input_tokens":8,"output_tokens":1}}`,
      `{"type":"message","role":"assistant","\\u006dodel":"substituted","model":"${model}","content":[{"type":"text","text":"OK"}],"usage":{"input_tokens":8,"output_tokens":1}}`,
      `{"type":"message","role":"assistant","model":"${model}","content":[{"type":"text","text":"NOT_OK","text":"OK"}],"usage":{"input_tokens":8,"output_tokens":1}}`,
      `{"type":"message","role":"assistant","model":"${model}","content":[{"type":"text","text":"OK"}],"usage":{"input_tokens":8,"output_tokens":4,"output_tokens":1}}`,
    ];
    for (const raw of cases) {
      const body = new TextEncoder().encode(raw);
      await expect(canary({
        transport: transport([], { body }),
      }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).rejects.toMatchObject({
        code: "RESPONSE_INVALID",
        failurePhase: "response-received",
      });
      expect([...body].every((byte) => byte === 0)).toBe(true);
    }
  });

  it("zeros response bytes through an intrinsic despite fill substitution", async () => {
    const ownBody = responseBody();
    const ownFill = vi.fn(function(this: Uint8Array): Uint8Array {
      return this;
    });
    Object.defineProperty(ownBody, "fill", {
      value: ownFill,
      configurable: true,
    });
    await expect(canary({
      transport: transport([], { body: ownBody }),
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).resolves.toMatchObject({
      statusCategory: "success",
    });
    expect(ownFill).not.toHaveBeenCalled();
    expect([...ownBody].every((byte) => byte === 0)).toBe(true);

    const prototypeBody = responseBody();
    const prototypeFill = vi.fn(function(this: Uint8Array): Uint8Array {
      return this;
    });
    const substitutedPrototype = Object.create(Uint8Array.prototype) as object;
    Object.defineProperty(substitutedPrototype, "fill", {
      value: prototypeFill,
      configurable: true,
      writable: true,
    });
    Object.setPrototypeOf(prototypeBody, substitutedPrototype);
    await expect(canary({
      transport: transport([], { body: prototypeBody }),
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).resolves.toMatchObject({
      statusCategory: "success",
    });
    expect(prototypeFill).not.toHaveBeenCalled();
    expect([...prototypeBody].every((byte) => byte === 0)).toBe(true);

    const malformedBody = responseBody();
    await expect(canary({
      transport: Object.freeze({
        kind: "deterministic-fake" as const,
        async post() {
          return Object.defineProperties({}, {
            status: {
              enumerable: true,
              get() { throw new Error("private status accessor"); },
            },
            contentType: { enumerable: true, value: "application/json" },
            body: { enumerable: true, value: malformedBody },
          }) as never;
        },
      }),
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).rejects.toMatchObject({
      code: "TRANSPORT_FAILURE",
      failurePhase: "response-received",
    });
    expect([...malformedBody].every((byte) => byte === 0)).toBe(true);

    let statusReads = 0;
    let contentTypeReads = 0;
    const driftingBody = responseBody();
    await expect(canary({
      transport: Object.freeze({
        kind: "deterministic-fake" as const,
        async post() {
          return Object.defineProperties({}, {
            status: {
              enumerable: true,
              get() {
                statusReads += 1;
                return statusReads === 1 ? 200 : 500;
              },
            },
            contentType: {
              enumerable: true,
              get() {
                contentTypeReads += 1;
                return contentTypeReads === 1
                  ? "application/json"
                  : "text/plain";
              },
            },
            body: { enumerable: true, value: driftingBody },
          }) as never;
        },
      }),
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).rejects.toMatchObject({
      code: "TRANSPORT_FAILURE",
      failurePhase: "response-received",
    });
    expect({ statusReads, contentTypeReads }).toEqual({
      statusReads: 0,
      contentTypeReads: 0,
    });
    expect([...driftingBody].every((byte) => byte === 0)).toBe(true);

    const shadowedLengthBody = new Uint8Array(
      ANTHROPIC_LIVE_CANARY_MAX_RESPONSE_BYTES + 1,
    );
    const shadowedByteLength = vi.fn(() => 2);
    Object.defineProperty(shadowedLengthBody, "byteLength", {
      get: shadowedByteLength,
      configurable: true,
    });
    await expect(canary({
      transport: transport([], { body: shadowedLengthBody }),
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).rejects.toMatchObject({
      code: "TRANSPORT_FAILURE",
      failurePhase: "response-received",
    });
    expect(shadowedByteLength).not.toHaveBeenCalled();
    expect([...shadowedLengthBody].every((byte) => byte === 0)).toBe(true);

    const rejectedBody = responseBody();
    await expect(canary({
      transport: Object.freeze({
        kind: "deterministic-fake" as const,
        async post() {
          throw { body: rejectedBody, detail: "private rejection detail" };
        },
      }),
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).rejects.toMatchObject({
      code: "TRANSPORT_FAILURE",
      failurePhase: "possibly-dispatched",
    });
    expect([...rejectedBody].every((byte) => byte === 0)).toBe(true);
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
      const rejected = expect(pending).rejects.toMatchObject({
        code: "TIMEOUT",
        failurePhase: "pre-dispatch",
      });
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
    Object.defineProperty(mutable.post, "bind", {
      value: () => { throw new Error("shadowed bind must not run"); },
    });
    const live = canary({ observations, transport: mutable });
    mutable.post = async () => { throw new Error("mutated transport must not run"); };
    await expect(live.run(ANTHROPIC_LIVE_CANARY_OPT_IN))
      .resolves.toMatchObject({ transportKind: "deterministic-fake" });

    const accessorObservations: string[] = [];
    const accessorOriginal = transport(accessorObservations);
    let kindReads = 0;
    let postReads = 0;
    const accessorTransport = Object.defineProperties({}, {
      kind: {
        enumerable: true,
        get() {
          kindReads += 1;
          return kindReads === 1
            ? "deterministic-fake"
            : "direct-anthropic-https";
        },
      },
      post: {
        enumerable: true,
        get() {
          postReads += 1;
          return accessorOriginal.post;
        },
      },
    }) as AnthropicLiveCanaryTransport;
    await expect(canary({
      observations: accessorObservations,
      transport: accessorTransport,
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).resolves.toMatchObject({
      transportKind: "deterministic-fake",
    });
    expect({ kindReads, postReads }).toEqual({ kindReads: 1, postReads: 1 });

    let tick = 0;
    await expect(canary({
      now: () => new Date(tick++ === 0 ? 1_000 : 16_000),
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN))
      .rejects.toMatchObject({
        code: "TIMEOUT",
        failurePhase: "post-response",
      });
  });

  it("captures the preflight method without losing its original receiver", async () => {
    const observations: string[] = [];
    let receiverObserved = false;
    const preflight = {
      marker: "original-preflight-receiver",
      async check(
        this: { readonly marker: string },
        request: AnthropicLiveCanaryPreflightRequest,
      ) {
        observations.push("preflight");
        receiverObserved = this === preflight;
        expect(this.marker).toBe("original-preflight-receiver");
        expect(request.modelId).toBe(ANTHROPIC_LIVE_CANARY_MODEL);
        return {
          allowed: true,
          decisionFingerprint: DECISION,
          catalogFingerprint: CATALOG,
          authorizationReference: AUTHORIZATION,
          retentionMode: "standard-30-day" as const,
        };
      },
    };
    Object.defineProperty(preflight.check, "bind", {
      value: () => { throw new Error("shadowed bind must not run"); },
    });
    const live = createAnthropicLiveCanary({
      ...canaryOptions({ observations }),
      preflight,
    });
    preflight.check = async () => {
      throw new Error("mutated preflight method must not run");
    };

    await expect(live.run(ANTHROPIC_LIVE_CANARY_OPT_IN))
      .resolves.toMatchObject({ statusCategory: "success" });
    expect(receiverObserved).toBe(true);
    expect(observations).toEqual([
      "preflight",
      "availability",
      "secret",
      "transport",
    ]);
  });

  it("uses one descriptor-safe top-level option snapshot", async () => {
    const observations: string[] = [];
    const stable = canaryOptions({ observations });
    let livePropertyReads = 0;
    const proxied = new Proxy(stable, {
      get() {
        livePropertyReads += 1;
        throw new Error("live option property must not be read");
      },
    });
    const live = createAnthropicLiveCanary(proxied);
    await expect(live.run(ANTHROPIC_LIVE_CANARY_OPT_IN))
      .resolves.toMatchObject({ statusCategory: "success" });
    expect(livePropertyReads).toBe(0);
    expect(observations).toEqual([
      "preflight",
      "availability",
      "secret",
      "transport",
    ]);
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
      .rejects.toMatchObject({
        code: "TIMEOUT",
        failurePhase: "pre-dispatch",
      });
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
    await expect(pending).rejects.toMatchObject({
      code: "TIMEOUT",
      failurePhase: "possibly-dispatched",
    });
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
      .rejects.toMatchObject({
        code: "RESPONSE_INVALID",
        failurePhase: "response-received",
      });
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
      let settled = false;
      void pending.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      const rejected = expect(pending).rejects.toMatchObject({
        code: "TIMEOUT",
        failurePhase: "response-received",
      });
      await vi.advanceTimersByTimeAsync(ANTHROPIC_LIVE_CANARY_TIMEOUT_MS);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(settled).toBe(true);
      expect([...body].every((byte) => byte === 0)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains response-received phase when the outer timeout wins before end", async () => {
    vi.useFakeTimers();
    try {
      const observations: string[] = [];
      const requestFunction = ((_options: unknown, callback: (value: unknown) => void) => {
        const request = new EventEmitter() as EventEmitter & {
          destroy(error?: Error): void;
          end(body?: Uint8Array): void;
        };
        request.destroy = (error?: Error) => {
          if (error !== undefined) request.emit("error", error);
          request.emit("close");
        };
        request.end = () => queueMicrotask(() => {
          const response = new EventEmitter() as EventEmitter & {
            statusCode: number;
            headers: Record<string, string>;
          };
          response.statusCode = 200;
          response.headers = { "content-type": "application/json" };
          callback(response);
        });
        return request;
      }) as never;
      const live = createAnthropicLiveCanaryWithDirectTransportForTesting(
        {
          ...canaryOptions({ observations }),
          transport: undefined,
        },
        requestFunction,
      );
      const pending = live.run(ANTHROPIC_LIVE_CANARY_OPT_IN);
      await Promise.resolve();
      await Promise.resolve();
      const rejected = expect(pending).rejects.toMatchObject({
        code: "TIMEOUT",
        failurePhase: "response-received",
      });
      await vi.advanceTimersByTimeAsync(ANTHROPIC_LIVE_CANARY_TIMEOUT_MS);
      await rejected;
      expect(observations).toEqual(["preflight", "availability", "secret"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves exact provider failure classes outside a callback-collapsing broker", async () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly response?: Uint8Array;
      readonly status?: number;
      readonly postError?: Error;
      readonly code: string;
      readonly failurePhase: string;
    }> = [
      {
        name: "transport rejection",
        postError: new Error("private transport marker"),
        code: "TRANSPORT_FAILURE",
        failurePhase: "possibly-dispatched",
      },
      {
        name: "HTTP response",
        response: responseBody({ content: [{ type: "text", text: "private-http" }] }),
        status: 500,
        code: "TRANSPORT_FAILURE",
        failurePhase: "response-received",
      },
      {
        name: "invalid response",
        response: responseBody({ content: [{ type: "text", text: "private-body" }] }),
        code: "RESPONSE_INVALID",
        failurePhase: "response-received",
      },
    ];

    for (const testCase of cases) {
      const observations: string[] = [];
      const body = testCase.response;
      const candidateTransport: AnthropicLiveCanaryTransport = Object.freeze({
        kind: "deterministic-fake" as const,
        async post() {
          observations.push("transport");
          if (testCase.postError !== undefined) throw testCase.postError;
          return {
            status: testCase.status ?? 200,
            contentType: "application/json",
            body: body!,
          };
        },
      });
      let caught: unknown;
      try {
        await canary({
          observations,
          secretBroker: callbackCollapsingBroker(observations),
          transport: candidateTransport,
        }).run(ANTHROPIC_LIVE_CANARY_OPT_IN);
      } catch (error) {
        caught = error;
      }
      expect(caught, testCase.name).toBeInstanceOf(AnthropicLiveCanaryError);
      expect(caught, testCase.name).toMatchObject({
        code: testCase.code,
        failurePhase: testCase.failurePhase,
      });
      // The serialized failure gained exactly one additive member in the
      // diagnostic-envelope change; the key set stays exact so any further
      // field still fails here.
      const serialized = JSON.parse(JSON.stringify(caught)) as Record<
        string,
        unknown
      >;
      expect(Object.keys(serialized)).toEqual([
        "name",
        "code",
        "failurePhase",
        "message",
        "diagnostics",
      ]);
      expect(Object.keys(serialized["diagnostics"] as object)).toEqual([
        ...ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_KEYS,
      ]);
      expect(JSON.stringify(caught)).not.toMatch(
        /private|owned-test-key|synthetic/i,
      );
      if (body !== undefined) {
        expect([...body].every((byte) => byte === 0), testCase.name).toBe(true);
      }
      expect(observations).toEqual([
        "preflight",
        "availability",
        "secret",
        "transport",
      ]);
    }
  });

  it("distinguishes pre-dispatch refusal from a post-response broker failure", async () => {
    const preflightObservations: string[] = [];
    await expect(canary({
      observations: preflightObservations,
      async preflight() {
        throw new Error("private preflight marker");
      },
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).rejects.toMatchObject({
      code: "PREFLIGHT_DENIED",
      failurePhase: "pre-dispatch",
    });
    expect(preflightObservations).toEqual(["preflight"]);

    const unavailableObservations: string[] = [];
    await expect(canary({
      observations: unavailableObservations,
      secretBroker: callbackCollapsingBroker(unavailableObservations, {
        availabilityError: true,
      }),
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).rejects.toMatchObject({
      code: "SECRET_UNAVAILABLE",
      failurePhase: "pre-dispatch",
    });
    expect(unavailableObservations).toEqual(["preflight", "availability"]);

    const auditObservations: string[] = [];
    let caught: unknown;
    try {
      await canary({
        observations: auditObservations,
        secretBroker: callbackCollapsingBroker(auditObservations, {
          failAfterCallback: true,
        }),
      }).run(ANTHROPIC_LIVE_CANARY_OPT_IN);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "CALLBACK_RESULT_FAILURE",
      failurePhase: "post-response",
    });
    expect(JSON.stringify(caught)).not.toMatch(/synthetic|owned-test-key/i);
    expect(auditObservations).toEqual([
      "preflight",
      "availability",
      "secret",
      "transport",
    ]);

    const responseAuditObservations: string[] = [];
    const responseAuditBody = responseBody();
    await expect(canary({
      observations: responseAuditObservations,
      secretBroker: callbackCollapsingBroker(responseAuditObservations, {
        failAfterCallback: true,
      }),
      transport: transport(responseAuditObservations, {
        body: responseAuditBody,
        status: 500,
      }),
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).rejects.toMatchObject({
      code: "CALLBACK_RESULT_FAILURE",
      failurePhase: "response-received",
    });
    expect([...responseAuditBody].every((byte) => byte === 0)).toBe(true);

    const constructionAuditObservations: string[] = [];
    const constructionOptions = canaryOptions({
      observations: constructionAuditObservations,
      secretBroker: callbackCollapsingBroker(
        constructionAuditObservations,
        { failAfterCallback: true },
      ),
    });
    await expect(createAnthropicLiveCanaryWithDirectTransportForTesting({
      ...constructionOptions,
      transport: undefined,
    }, (() => {
      throw new Error("private construction marker");
    }) as never).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).rejects.toMatchObject({
      code: "CALLBACK_RESULT_FAILURE",
      failurePhase: "pre-dispatch",
    });
    expect(constructionAuditObservations).toEqual([
      "preflight",
      "availability",
      "secret",
    ]);
  });

  it("projects availability once and maps every malformed result before secret use", async () => {
    let driftingAvailabilityReads = 0;
    const driftingAvailability = Object.defineProperties({}, {
      available: {
        enumerable: true,
        get() {
          driftingAvailabilityReads += 1;
          return driftingAvailabilityReads > 1;
        },
      },
      reason: { enumerable: true, value: "available" },
      audit: { enumerable: true, value: {} },
    });
    const cases: readonly unknown[] = [
      null,
      { available: true, reason: "available" },
      { available: true, reason: "available", audit: {}, extra: true },
      Object.defineProperties({}, {
        available: {
          enumerable: true,
          get() { throw new Error("private availability getter"); },
        },
        reason: { enumerable: true, value: "available" },
        audit: { enumerable: true, value: {} },
      }),
      driftingAvailability,
    ];
    for (const malformed of cases) {
      const observations: string[] = [];
      const base = broker(observations);
      const malformedBroker: SecretBroker = Object.freeze({
        ...base,
        async availability() {
          observations.push("availability");
          return malformed as never;
        },
      });
      let caught: unknown;
      try {
        await canary({
          observations,
          secretBroker: malformedBroker,
        }).run(ANTHROPIC_LIVE_CANARY_OPT_IN);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: "SECRET_UNAVAILABLE",
        failurePhase: "pre-dispatch",
      });
      expect(JSON.stringify(caught)).not.toContain("private");
      expect(observations).toEqual(["preflight", "availability"]);
    }
    expect(driftingAvailabilityReads).toBe(0);
  });

  it("rebuilds forged exported errors at every untrusted port boundary", async () => {
    const forged = (): AnthropicLiveCanaryError => {
      const error = new AnthropicLiveCanaryError(
        "NOT_OPTED_IN",
        "pre-dispatch",
      );
      Object.defineProperty(error, "code", {
        value: "private-code-marker",
        configurable: true,
      });
      Object.defineProperty(error, "failurePhase", {
        value: "private-phase-marker",
        configurable: true,
      });
      return error;
    };

    const preflightObservations: string[] = [];
    let preflightError: unknown;
    try {
      await canary({
        observations: preflightObservations,
        async preflight() { throw forged(); },
      }).run(ANTHROPIC_LIVE_CANARY_OPT_IN);
    } catch (error) {
      preflightError = error;
    }
    expect(preflightError).toMatchObject({
      code: "PREFLIGHT_DENIED",
      failurePhase: "pre-dispatch",
    });
    expect(JSON.stringify(preflightError)).not.toContain("private");
    expect(preflightObservations).toEqual(["preflight"]);

    const availabilityObservations: string[] = [];
    const availabilityBase = broker(availabilityObservations);
    const forgedAvailability: SecretBroker = Object.freeze({
      ...availabilityBase,
      async availability() {
        availabilityObservations.push("availability");
        throw forged();
      },
    });
    let availabilityError: unknown;
    try {
      await canary({
        observations: availabilityObservations,
        secretBroker: forgedAvailability,
      }).run(ANTHROPIC_LIVE_CANARY_OPT_IN);
    } catch (error) {
      availabilityError = error;
    }
    expect(availabilityError).toMatchObject({
      code: "SECRET_UNAVAILABLE",
      failurePhase: "pre-dispatch",
    });
    expect(JSON.stringify(availabilityError)).not.toContain("private");
    expect(availabilityObservations).toEqual(["preflight", "availability"]);

    const transportObservations: string[] = [];
    let transportError: unknown;
    try {
      await canary({
        observations: transportObservations,
        transport: Object.freeze({
          kind: "deterministic-fake" as const,
          async post() {
            transportObservations.push("transport");
            throw forged();
          },
        }),
      }).run(ANTHROPIC_LIVE_CANARY_OPT_IN);
    } catch (error) {
      transportError = error;
    }
    expect(transportError).toMatchObject({
      code: "TRANSPORT_FAILURE",
      failurePhase: "possibly-dispatched",
    });
    expect(JSON.stringify(transportError)).not.toContain("private");
    expect(transportObservations).toEqual([
      "preflight",
      "availability",
      "secret",
      "transport",
    ]);
  });

  it("does not expose reusable internal-error provenance on public failures", async () => {
    let harmlessFailure: unknown;
    try {
      await canary({}).run("not-the-opt-in-sentinel");
    } catch (error) {
      harmlessFailure = error;
    }
    expect(harmlessFailure).toBeInstanceOf(AnthropicLiveCanaryError);
    const leakedSymbols = Object.getOwnPropertySymbols(harmlessFailure as object);
    expect(leakedSymbols).toEqual([]);

    const forged = new AnthropicLiveCanaryError(
      "NOT_OPTED_IN",
      "pre-dispatch",
    );
    for (const symbol of leakedSymbols) {
      Object.defineProperty(forged, symbol, {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false,
      });
    }
    Object.freeze(forged);
    await expect(canary({
      async preflight() { throw forged; },
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).rejects.toMatchObject({
      code: "PREFLIGHT_DENIED",
      failurePhase: "pre-dispatch",
    });

    const reusable = harmlessFailure as AnthropicLiveCanaryError;
    const malformedOptions = canaryOptions({});
    Object.defineProperty(malformedOptions, "instanceId", {
      enumerable: true,
      get() { throw reusable; },
    });
    expect(() => createAnthropicLiveCanary(malformedOptions))
      .toThrowError(expect.objectContaining({
        code: "INVALID_CONFIGURATION",
        failurePhase: "pre-dispatch",
      }));

    await expect(canary({
      now: () => { throw reusable; },
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION",
      failurePhase: "pre-dispatch",
    });
    let clockReads = 0;
    await expect(canary({
      now: () => {
        clockReads += 1;
        if (clockReads === 1) return new Date(1_000);
        throw reusable;
      },
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).rejects.toMatchObject({
      code: "CALLBACK_RESULT_FAILURE",
      failurePhase: "post-response",
    });

    await expect(canary({
      async preflight() { throw reusable; },
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).rejects.toMatchObject({
      code: "PREFLIGHT_DENIED",
      failurePhase: "pre-dispatch",
    });
    const availabilityBase = broker([]);
    await expect(canary({
      secretBroker: Object.freeze({
        ...availabilityBase,
        async availability() { throw reusable; },
      }),
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).rejects.toMatchObject({
      code: "SECRET_UNAVAILABLE",
      failurePhase: "pre-dispatch",
    });
    await expect(canary({
      secretBroker: Object.freeze({
        ...availabilityBase,
        async withSecret() { throw reusable; },
      }),
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).rejects.toMatchObject({
      code: "SECRET_UNAVAILABLE",
      failurePhase: "pre-dispatch",
    });
    const reusedMaterial: SecretMaterial = {
      kind: "text",
      async useText() { throw reusable; },
      async useBytes() { throw new Error("unused"); },
      toString: () => "[REDACTED SECRET]",
      toJSON: () => "[REDACTED SECRET]",
    };
    await expect(canary({
      secretBroker: Object.freeze({
        ...availabilityBase,
        async withSecret<T>(
          _ref: SecretRef,
          _context: SecretAccessContext,
          callback: Parameters<SecretBroker["withSecret"]>[2],
        ): Promise<T> {
          return await callback(reusedMaterial) as T;
        },
      }),
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).rejects.toMatchObject({
      code: "CALLBACK_RESULT_FAILURE",
      failurePhase: "pre-dispatch",
    });
    await expect(canary({
      transport: Object.freeze({
        kind: "deterministic-fake" as const,
        async post() { throw reusable; },
      }),
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).rejects.toMatchObject({
      code: "TRANSPORT_FAILURE",
      failurePhase: "possibly-dispatched",
    });
    await expect(canary({
      transport: Object.freeze({
        kind: "deterministic-fake" as const,
        async post() {
          return Object.defineProperties({}, {
            status: { enumerable: true, value: 200 },
            contentType: { enumerable: true, value: "application/json" },
            body: {
              enumerable: true,
              get() { throw reusable; },
            },
          }) as never;
        },
      }),
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).rejects.toMatchObject({
      code: "TRANSPORT_FAILURE",
      failurePhase: "response-received",
    });
  });

  it("refuses a broker-substituted callback outcome after the material is disposed", async () => {
    const observations: string[] = [];
    const base = broker(observations);
    const substitutingBroker: SecretBroker = Object.freeze({
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
        } finally {
          material.dispose();
        }
        return {
          status: "failure",
          code: "private-code",
          failurePhase: "private-phase",
        } as T;
      },
    });
    let caught: unknown;
    try {
      await canary({
        observations,
        secretBroker: substitutingBroker,
      }).run(ANTHROPIC_LIVE_CANARY_OPT_IN);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "CALLBACK_RESULT_FAILURE",
      failurePhase: "post-response",
    });
    expect(JSON.stringify(caught)).not.toMatch(/private|owned-test-key/i);
    expect(observations).toEqual([
      "preflight",
      "availability",
      "secret",
      "transport",
    ]);
  });

  it("requires one exact callback and rejects valid broker outcome substitution", async () => {
    const noCallbackObservations: string[] = [];
    const noCallbackBase = broker(noCallbackObservations);
    const noCallbackBroker: SecretBroker = Object.freeze({
      ...noCallbackBase,
      async withSecret<T>(): Promise<T> {
        noCallbackObservations.push("secret");
        return {
          status: "success",
          usage: { inputTokens: 0, outputTokens: 0 },
        } as T;
      },
    });
    await expect(canary({
      observations: noCallbackObservations,
      secretBroker: noCallbackBroker,
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).rejects.toMatchObject({
      code: "CALLBACK_RESULT_FAILURE",
      failurePhase: "pre-dispatch",
    });
    expect(noCallbackObservations).toEqual([
      "preflight",
      "availability",
      "secret",
    ]);

    const duplicateObservations: string[] = [];
    const duplicateBase = broker(duplicateObservations);
    const duplicateBroker: SecretBroker = Object.freeze({
      ...duplicateBase,
      async withSecret<T>(
        _ref: SecretRef,
        _context: SecretAccessContext,
        callback: Parameters<SecretBroker["withSecret"]>[2],
      ): Promise<T> {
        duplicateObservations.push("secret");
        const material = createSecretMaterial(
          "text",
          new TextEncoder().encode("owned-test-key"),
        );
        try {
          const first = await callback(material) as T;
          await callback(material);
          return first;
        } finally {
          material.dispose();
        }
      },
    });
    await expect(canary({
      observations: duplicateObservations,
      secretBroker: duplicateBroker,
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).rejects.toMatchObject({
      code: "CALLBACK_RESULT_FAILURE",
      failurePhase: "post-response",
    });
    expect(duplicateObservations).toEqual([
      "preflight",
      "availability",
      "secret",
      "transport",
    ]);

    const substitutions = [
      {
        name: "success to failure",
        transport: undefined,
        replacement: {
          status: "failure",
          code: "TRANSPORT_FAILURE",
          failurePhase: "response-received",
        },
        failurePhase: "post-response",
      },
      {
        name: "failure to success",
        transport: Object.freeze({
          kind: "deterministic-fake" as const,
          async post() { throw new Error("private transport marker"); },
        }),
        replacement: {
          status: "success",
          usage: { inputTokens: 0, outputTokens: 0 },
        },
        failurePhase: "possibly-dispatched",
      },
    ] as const;
    for (const substitution of substitutions) {
      const observations: string[] = [];
      const base = broker(observations);
      const substituting: SecretBroker = Object.freeze({
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
            return substitution.replacement as T;
          } finally {
            material.dispose();
          }
        },
      });
      let caught: unknown;
      try {
        await canary({
          observations,
          secretBroker: substituting,
          transport: substitution.transport,
        }).run(ANTHROPIC_LIVE_CANARY_OPT_IN);
      } catch (error) {
        caught = error;
      }
      expect(caught, substitution.name).toMatchObject({
        code: "CALLBACK_RESULT_FAILURE",
        failurePhase: substitution.failurePhase,
      });
      expect(JSON.stringify(caught)).not.toMatch(/private|owned-test-key/i);
    }
  });

  it("aborts and drains an entered callback when the broker returns early", async () => {
    vi.useFakeTimers();
    try {
      const observations: string[] = [];
      let aborts = 0;
      let lateEffects = 0;
      const earlyTransport: AnthropicLiveCanaryTransport = Object.freeze({
        kind: "deterministic-fake" as const,
        async post(request) {
          observations.push("transport");
          return new Promise<AnthropicLiveCanaryTransportResponse>(
            (resolve, reject) => {
              const effectTimer = setTimeout(() => {
                lateEffects += 1;
                resolve({
                  status: 200,
                  contentType: "application/json",
                  body: responseBody(),
                });
              }, 1_000);
              request.signal.addEventListener("abort", () => {
                aborts += 1;
                clearTimeout(effectTimer);
                reject(new Error("private abort detail"));
              }, { once: true });
            },
          );
        },
      });
      const base = broker(observations);
      const earlyBroker: SecretBroker = Object.freeze({
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
          void Promise.resolve(callback(material)).finally(() => {
            material.dispose();
          });
          return {
            status: "success",
            usage: { inputTokens: 0, outputTokens: 0 },
          } as T;
        },
      });
      await expect(canary({
        observations,
        secretBroker: earlyBroker,
        transport: earlyTransport,
      }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).rejects.toMatchObject({
        code: "CALLBACK_RESULT_FAILURE",
        failurePhase: "possibly-dispatched",
      });
      expect({ aborts, lateEffects }).toEqual({ aborts: 1, lateEffects: 0 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(lateEffects).toBe(0);
      expect(observations).toEqual([
        "preflight",
        "availability",
        "secret",
        "transport",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a saved broker callback before any late invocation", async () => {
    const observations: string[] = [];
    let savedCallback: Parameters<SecretBroker["withSecret"]>[2] | null = null;
    let transportCalls = 0;
    const base = broker(observations);
    const savingBroker: SecretBroker = Object.freeze({
      ...base,
      async withSecret<T>(
        _ref: SecretRef,
        _context: SecretAccessContext,
        callback: Parameters<SecretBroker["withSecret"]>[2],
      ): Promise<T> {
        observations.push("secret");
        savedCallback = callback;
        return {
          status: "success",
          usage: { inputTokens: 0, outputTokens: 0 },
        } as T;
      },
    });
    await expect(canary({
      observations,
      secretBroker: savingBroker,
      transport: Object.freeze({
        kind: "deterministic-fake" as const,
        async post() {
          transportCalls += 1;
          return {
            status: 200,
            contentType: "application/json",
            body: responseBody(),
          };
        },
      }),
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).rejects.toMatchObject({
      code: "CALLBACK_RESULT_FAILURE",
      failurePhase: "pre-dispatch",
    });
    const material = createSecretMaterial(
      "text",
      new TextEncoder().encode("owned-test-key"),
    );
    try {
      await (savedCallback as NonNullable<typeof savedCallback>)(material);
    } finally {
      material.dispose();
    }
    expect(transportCalls).toBe(0);
    expect(observations).toEqual(["preflight", "availability", "secret"]);
  });

  it("binds one exact primitive text-consumer outcome before transport authority", async () => {
    const runWithMaterial = async (
      material: SecretMaterial,
      observations: string[],
      onTransport: () => void,
    ): Promise<unknown> => {
      const base = broker(observations);
      const materialBroker: SecretBroker = Object.freeze({
        ...base,
        async withSecret<T>(
          _ref: SecretRef,
          _context: SecretAccessContext,
          callback: Parameters<SecretBroker["withSecret"]>[2],
        ): Promise<T> {
          observations.push("secret");
          return await callback(material) as T;
        },
      });
      try {
        await canary({
          observations,
          secretBroker: materialBroker,
          transport: Object.freeze({
            kind: "deterministic-fake" as const,
            async post() {
              onTransport();
              observations.push("transport");
              return {
                status: 200,
                contentType: "application/json",
                body: responseBody(),
              };
            },
          }),
        }).run(ANTHROPIC_LIVE_CANARY_OPT_IN);
      } catch (error) {
        return error;
      }
      return null;
    };
    const material = (
      useText: SecretMaterial["useText"],
    ): SecretMaterial => ({
      kind: "text",
      useText,
      async useBytes() { throw new Error("unused"); },
      toString: () => "[REDACTED SECRET]",
      toJSON: () => "[REDACTED SECRET]",
    });

    let transportCalls = 0;
    const noCallObservations: string[] = [];
    const noCallError = await runWithMaterial(material(async <T>() => ({
      status: "success",
      usage: { inputTokens: 0, outputTokens: 0 },
    }) as T), noCallObservations, () => { transportCalls += 1; });
    expect(noCallError).toMatchObject({
      code: "CALLBACK_RESULT_FAILURE",
      failurePhase: "pre-dispatch",
    });
    expect(transportCalls).toBe(0);

    const nonStringObservations: string[] = [];
    const nonStringError = await runWithMaterial(material(async <T>(consumer) =>
      await (consumer as (value: unknown) => Promise<T>)({ length: 1 })
    ), nonStringObservations, () => { transportCalls += 1; });
    expect(nonStringError).toMatchObject({
      code: "SECRET_UNAVAILABLE",
      failurePhase: "pre-dispatch",
    });
    expect(transportCalls).toBe(0);

    let wrongKindUseCalls = 0;
    const wrongKindObservations: string[] = [];
    const wrongKindMaterial = {
      ...material(async <T>() => {
        wrongKindUseCalls += 1;
        return null as T;
      }),
      kind: "bytes" as const,
    } as SecretMaterial;
    const wrongKindError = await runWithMaterial(
      wrongKindMaterial,
      wrongKindObservations,
      () => { transportCalls += 1; },
    );
    expect(wrongKindError).toMatchObject({
      code: "SECRET_UNAVAILABLE",
      failurePhase: "pre-dispatch",
    });
    expect({ transportCalls, wrongKindUseCalls }).toEqual({
      transportCalls: 0,
      wrongKindUseCalls: 0,
    });

    const substitutedObservations: string[] = [];
    const substitutedError = await runWithMaterial(material(async <T>(consumer) => {
      await consumer("owned-test-key");
      return {
        status: "failure",
        code: "TRANSPORT_FAILURE",
        failurePhase: "response-received",
      } as T;
    }), substitutedObservations, () => { transportCalls += 1; });
    expect(substitutedError).toMatchObject({
      code: "CALLBACK_RESULT_FAILURE",
      failurePhase: "post-response",
    });
    expect(transportCalls).toBe(1);

    const duplicateObservations: string[] = [];
    const duplicateError = await runWithMaterial(material(async <T>(consumer) => {
      const first = await consumer("owned-test-key");
      await consumer("owned-test-key");
      return first;
    }), duplicateObservations, () => { transportCalls += 1; });
    expect(duplicateError).toMatchObject({
      code: "CALLBACK_RESULT_FAILURE",
      failurePhase: "post-response",
    });
    expect(transportCalls).toBe(2);

    let savedTextConsumer: ((text: string) => unknown) | null = null;
    const lateObservations: string[] = [];
    const lateError = await runWithMaterial(material(async <T>(consumer) => {
      savedTextConsumer = consumer;
      return {
        status: "success",
        usage: { inputTokens: 0, outputTokens: 0 },
      } as T;
    }), lateObservations, () => { transportCalls += 1; });
    expect(lateError).toMatchObject({
      code: "CALLBACK_RESULT_FAILURE",
      failurePhase: "pre-dispatch",
    });
    await (savedTextConsumer as NonNullable<typeof savedTextConsumer>)(
      "owned-test-key",
    );
    expect(transportCalls).toBe(2);
  });

  it("aborts and drains an entered text consumer when useText returns early", async () => {
    vi.useFakeTimers();
    try {
      let aborts = 0;
      let lateEffects = 0;
      const observations: string[] = [];
      const earlyMaterial: SecretMaterial = {
        kind: "text",
        async useText<T>(consumer: (text: string) => T | Promise<T>): Promise<T> {
          void Promise.resolve(consumer("owned-test-key"));
          return {
            status: "success",
            usage: { inputTokens: 0, outputTokens: 0 },
          } as T;
        },
        async useBytes() { throw new Error("unused"); },
        toString: () => "[REDACTED SECRET]",
        toJSON: () => "[REDACTED SECRET]",
      };
      const base = broker(observations);
      const materialBroker: SecretBroker = Object.freeze({
        ...base,
        async withSecret<T>(
          _ref: SecretRef,
          _context: SecretAccessContext,
          callback: Parameters<SecretBroker["withSecret"]>[2],
        ): Promise<T> {
          observations.push("secret");
          return await callback(earlyMaterial) as T;
        },
      });
      await expect(canary({
        observations,
        secretBroker: materialBroker,
        transport: Object.freeze({
          kind: "deterministic-fake" as const,
          async post(request) {
            observations.push("transport");
            return new Promise<AnthropicLiveCanaryTransportResponse>(
              (resolve, reject) => {
                const effectTimer = setTimeout(() => {
                  lateEffects += 1;
                  resolve({
                    status: 200,
                    contentType: "application/json",
                    body: responseBody(),
                  });
                }, 1_000);
                request.signal.addEventListener("abort", () => {
                  aborts += 1;
                  clearTimeout(effectTimer);
                  reject(new Error("private abort detail"));
                }, { once: true });
              },
            );
          },
        }),
      }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).rejects.toMatchObject({
        code: "CALLBACK_RESULT_FAILURE",
        failurePhase: "possibly-dispatched",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect({ aborts, lateEffects }).toEqual({ aborts: 1, lateEffects: 0 });
      expect(observations).toEqual([
        "preflight",
        "availability",
        "secret",
        "transport",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits a bounded drain interval for an uncooperative secret callback boundary", async () => {
    vi.useFakeTimers();
    try {
      const observations: string[] = [];
      const base = broker(observations);
      const uncooperative: SecretBroker = Object.freeze({
        ...base,
        withSecret: () => {
          observations.push("secret");
          return new Promise<never>(() => undefined);
        },
      });
      const pending = canary({
        observations,
        secretBroker: uncooperative,
      }).run(ANTHROPIC_LIVE_CANARY_OPT_IN);
      let settled = false;
      void pending.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      const rejected = expect(pending).rejects.toMatchObject({
        code: "CALLBACK_RESULT_FAILURE",
        failurePhase: "pre-dispatch",
      });
      await vi.advanceTimersByTimeAsync(ANTHROPIC_LIVE_CANARY_TIMEOUT_MS);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(
        ANTHROPIC_LIVE_CANARY_CALLBACK_DRAIN_MS,
      );
      await rejected;
      expect(settled).toBe(true);
      expect(observations).toEqual([
        "preflight",
        "availability",
        "secret",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the same single drain ceiling for an entered uncooperative transport", async () => {
    vi.useFakeTimers();
    try {
      const observations: string[] = [];
      const pending = canary({
        observations,
        transport: Object.freeze({
          kind: "deterministic-fake" as const,
          async post() {
            observations.push("transport");
            return new Promise<never>(() => undefined);
          },
        }),
      }).run(ANTHROPIC_LIVE_CANARY_OPT_IN);
      let settled = false;
      void pending.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      const rejected = expect(pending).rejects.toMatchObject({
        code: "CALLBACK_RESULT_FAILURE",
        failurePhase: "possibly-dispatched",
      });
      await vi.advanceTimersByTimeAsync(ANTHROPIC_LIVE_CANARY_TIMEOUT_MS);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(
        ANTHROPIC_LIVE_CANARY_CALLBACK_DRAIN_MS,
      );
      await rejected;
      expect(settled).toBe(true);
      expect(observations).toEqual([
        "preflight",
        "availability",
        "secret",
        "transport",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a pre-callback broker rejection after deadline classified as timeout", async () => {
    vi.useFakeTimers();
    try {
      const observations: string[] = [];
      const base = broker(observations);
      const rejectingBroker: SecretBroker = Object.freeze({
        ...base,
        withSecret: (
          _ref: SecretRef,
          context: SecretAccessContext,
        ) => {
          observations.push("secret");
          return new Promise<never>((_resolve, reject) => {
            context.signal.addEventListener("abort", () => {
              reject(new SecretBrokerError(
                "RESOLUTION_TIMEOUT",
                "private backend timeout detail",
              ));
            }, { once: true });
          });
        },
      });
      const pending = canary({
        observations,
        secretBroker: rejectingBroker,
      }).run(ANTHROPIC_LIVE_CANARY_OPT_IN);
      const rejected = expect(pending).rejects.toMatchObject({
        code: "TIMEOUT",
        failurePhase: "pre-dispatch",
      });
      await vi.advanceTimersByTimeAsync(ANTHROPIC_LIVE_CANARY_TIMEOUT_MS);
      await rejected;
      expect(observations).toEqual([
        "preflight",
        "availability",
        "secret",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies direct request construction, submission, and response failures", async () => {
    const request = {
      endpoint: "https://api.anthropic.com/v1/messages" as const,
      apiVersion: "2023-06-01" as const,
      modelId: ANTHROPIC_LIVE_CANARY_MODEL,
      body: "{}",
      maximumResponseBytes: 64,
      signal: new AbortController().signal,
    };
    await expect(createDirectAnthropicLiveCanaryTransportForTesting((() => {
      throw new Error("constructor detail");
    }) as never).post(request, "test-key")).rejects.toMatchObject({
      code: "TRANSPORT_FAILURE",
      failurePhase: "pre-dispatch",
    });

    const submittedRequest = ((_options: unknown, _callback: unknown) => {
      const emitter = new EventEmitter() as EventEmitter & {
        destroy(error?: Error): void;
        end(body?: Uint8Array): void;
      };
      emitter.destroy = () => undefined;
      emitter.end = () => queueMicrotask(() => emitter.emit("error", new Error("wire")));
      return emitter;
    }) as never;
    await expect(createDirectAnthropicLiveCanaryTransportForTesting(submittedRequest)
      .post(request, "test-key")).rejects.toMatchObject({
      code: "TRANSPORT_FAILURE",
      failurePhase: "possibly-dispatched",
    });

    for (const destroyThrows of [false, true]) {
      let destroyed = 0;
      let lateEffects = 0;
      const endThrowingRequest = ((_options: unknown, _callback: unknown) => {
        const emitter = new EventEmitter() as EventEmitter & {
          destroy(error?: Error): void;
          end(body?: Uint8Array): void;
        };
        emitter.destroy = () => {
          destroyed += 1;
          if (destroyThrows) throw new Error("private destroy marker");
          emitter.emit("close");
        };
        emitter.end = () => {
          queueMicrotask(() => {
            if (destroyed === 0) lateEffects += 1;
          });
          throw new Error("private end marker");
        };
        return emitter;
      }) as never;
      let caught: unknown;
      try {
        await createDirectAnthropicLiveCanaryTransportForTesting(
          endThrowingRequest,
        ).post(request, "test-key");
      } catch (error) {
        caught = error;
      }
      await Promise.resolve();
      expect(caught).toMatchObject({
        code: "TRANSPORT_FAILURE",
        failurePhase: "possibly-dispatched",
      });
      expect(JSON.stringify(caught)).not.toMatch(/private|end|destroy/i);
      expect({ destroyed, lateEffects }).toEqual({ destroyed: 1, lateEffects: 0 });
    }

    const responseRequest = ((_options: unknown, callback: (value: unknown) => void) => {
      const emitter = new EventEmitter() as EventEmitter & {
        destroy(error?: Error): void;
        end(body?: Uint8Array): void;
      };
      emitter.destroy = () => undefined;
      emitter.end = () => queueMicrotask(() => {
        const response = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
        };
        response.statusCode = 200;
        response.headers = { "content-type": "application/json" };
        callback(response);
        response.emit("aborted");
      });
      return emitter;
    }) as never;
    await expect(createDirectAnthropicLiveCanaryTransportForTesting(responseRequest)
      .post(request, "test-key")).rejects.toMatchObject({
      code: "TRANSPORT_FAILURE",
      failurePhase: "response-received",
    });
  });

  it("maps malformed initial clocks and post-response clock failure finitely", async () => {
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
      .rejects.toMatchObject({
        code: "INVALID_CONFIGURATION",
        failurePhase: "pre-dispatch",
      });
    await expect(canary({
      now: (() => ({ valueOf: () => 1_000 })) as never,
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN))
      .rejects.toMatchObject({
        code: "INVALID_CONFIGURATION",
        failurePhase: "pre-dispatch",
      });

    const shadowedValueOf = vi.fn(() => {
      throw new Error("shadowed Date.valueOf must not run");
    });
    const clockValues = [new Date(1_000), new Date(1_025)];
    for (const value of clockValues) {
      Object.defineProperty(value, "valueOf", {
        value: shadowedValueOf,
        configurable: true,
      });
    }
    await expect(canary({
      now: () => clockValues.shift()!,
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN)).resolves.toMatchObject({
      durationMs: 25,
      statusCategory: "success",
    });
    expect(shadowedValueOf).not.toHaveBeenCalled();

    let reads = 0;
    await expect(canary({
      now: () => {
        reads += 1;
        if (reads === 1) return new Date(1_000);
        throw new Error("private-final-clock");
      },
    }).run(ANTHROPIC_LIVE_CANARY_OPT_IN))
      .rejects.toMatchObject({
        code: "CALLBACK_RESULT_FAILURE",
        failurePhase: "post-response",
      });
  });
});
