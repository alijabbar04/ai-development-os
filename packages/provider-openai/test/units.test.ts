import { describe, expect, it } from "vitest";
import { defaultDataHandlingPolicy, type DataClassification } from "@ai-dev-os/domain";
import { isProviderError, type ProviderDescriptor, type ProviderError } from "@ai-dev-os/providers";
import { createDeterministicPolicyBroker, createManualPolicyClock, type PolicyRule } from "@ai-dev-os/policy";
import { createManualScheduler } from "@ai-dev-os/provider-testkit";
import {
  EMPTY_UPSTREAM_ERROR,
  createFetchOpenAiTransport,
  createPolicyBrokerDisclosurePort,
  httpStatusError,
  openAiSchedulerFromManual,
  parseOpenAiEndpoint,
  responseFailureError,
  summarizeUpstreamError,
  systemOpenAiScheduler,
  validateAgainstSchema,
  type DisclosureAuthorizationRequest,
} from "../src/index.js";
import { createFakeOpenAi, responseObject, textStreamScript } from "./helpers/fake-openai.js";
import { TEST_API_KEY, createTestProvider, testRequest } from "./helpers/fixtures.js";

function detailCode(error: unknown): unknown {
  return (error as ProviderError).details["detailCode"];
}

describe("scheduler", () => {
  it("resolves a real delay and supports cancellation", async () => {
    const handle = systemOpenAiScheduler.delay(1);
    await handle.promise;
    // Cancelling after resolution is harmless and idempotent.
    handle.cancel();
    handle.cancel();

    const cancelled = systemOpenAiScheduler.delay(50_000);
    cancelled.cancel();
    // A cancelled delay never resolves; racing proves it stays pending.
    const outcome = await Promise.race([
      cancelled.promise.then(() => "resolved" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 5)),
    ]);
    expect(outcome).toBe("pending");
  });

  it("reports the current time", () => {
    const before = Date.now();
    const now = systemOpenAiScheduler.now().valueOf();
    expect(now).toBeGreaterThanOrEqual(before - 1_000);
  });

  it("adapts a manual scheduler and honors cancellation on virtual time", async () => {
    const manual = createManualScheduler();
    const scheduler = openAiSchedulerFromManual(manual);
    expect(scheduler.now().toISOString()).toBe(manual.now().toISOString());

    let resolved = false;
    const handle = scheduler.delay(1_000);
    void handle.promise.then(() => {
      resolved = true;
    });
    manual.advance(1_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(true);

    let cancelledResolved = false;
    const cancelled = scheduler.delay(1_000);
    cancelled.cancel();
    void cancelled.promise.then(() => {
      cancelledResolved = true;
    });
    manual.advance(5_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelledResolved).toBe(false);

    // A negative delay is clamped rather than rejected.
    const clamped = scheduler.delay(-100);
    manual.advance(1);
    await clamped.promise;
  });
});

describe("upstream error summarization", () => {
  it("extracts only safe machine fields", () => {
    expect(
      summarizeUpstreamError({
        error: { type: "invalid_request_error", code: "bad_thing", param: "input[0].text", message: "leak me" },
      }),
    ).toEqual({ type: "invalid_request_error", code: "bad_thing", param: "input[0].text" });
  });

  it("accepts a bare error object without an envelope", () => {
    expect(summarizeUpstreamError({ type: "server_error", code: "server_error", param: null })).toEqual({
      type: "server_error",
      code: "server_error",
      param: null,
    });
  });

  it("drops values that do not match the safe shapes", () => {
    expect(
      summarizeUpstreamError({
        error: { type: "NOT lowercase; drop", code: "x".repeat(200), param: "<script>" },
      }),
    ).toEqual(EMPTY_UPSTREAM_ERROR);
    expect(summarizeUpstreamError(null)).toEqual(EMPTY_UPSTREAM_ERROR);
    expect(summarizeUpstreamError("string")).toEqual(EMPTY_UPSTREAM_ERROR);
    expect(summarizeUpstreamError([1, 2, 3])).toEqual(EMPTY_UPSTREAM_ERROR);
  });
});

describe("HTTP status mapping edges", () => {
  const base = {
    route: "createResponse",
    retryAfterMs: null,
    rateLimit: null,
    upstream: EMPTY_UPSTREAM_ERROR,
  };

  it("routes a 3xx through redirect rejection", () => {
    const error = httpStatusError({ ...base, status: 307 });
    expect(error.code).toBe("PROTOCOL_VIOLATION");
    expect(detailCode(error)).toBeUndefined();
    expect(error.details["httpStatus"]).toBe(307);
  });

  it("treats 422 like a rejected request", () => {
    expect(httpStatusError({ ...base, status: 422 }).code).toBe("INVALID_REQUEST");
  });

  it("maps an unsupported option to a capability failure", () => {
    const error = httpStatusError({
      ...base,
      status: 400,
      upstream: { type: "invalid_request_error", code: "unsupported_parameter", param: "seed" },
    });
    expect(error.code).toBe("UNSUPPORTED_CAPABILITY");
  });

  it("maps an oversized string to a context-limit failure", () => {
    const error = httpStatusError({
      ...base,
      status: 400,
      upstream: { type: "invalid_request_error", code: "string_above_max_length", param: null },
    });
    expect(error.code).toBe("CONTEXT_LIMIT_EXCEEDED");
  });

  it("maps 504 to overload and 500 to internal failure", () => {
    expect(httpStatusError({ ...base, status: 504 }).code).toBe("PROVIDER_OVERLOADED");
    expect(httpStatusError({ ...base, status: 500 }).code).toBe("INTERNAL_FAILURE");
    expect(httpStatusError({ ...base, status: 529 }).code).toBe("PROVIDER_OVERLOADED");
  });

  it("marks a background failure as possibly still running", () => {
    const error = httpStatusError({ ...base, status: 503, operationMayStillBeRunning: true });
    expect(error.retry.operationMayStillBeRunning).toBe(true);
    expect(error.retry.idempotencyRequired).toBe(true);
  });

  it("falls back on an unrecognized status", () => {
    expect(httpStatusError({ ...base, status: 418 }).code).toBe("INTERNAL_FAILURE");
    expect(
      httpStatusError({
        ...base,
        status: 418,
        upstream: { type: "invalid_request_error", code: null, param: null },
      }).code,
    ).toBe("INVALID_REQUEST");
  });

  it("classifies terminal response failures by documented code", () => {
    expect(responseFailureError({ type: null, code: "rate_limit_exceeded", param: null }).code).toBe(
      "RATE_LIMITED",
    );
    expect(responseFailureError({ type: null, code: "invalid_prompt", param: null }).code).toBe(
      "CONTENT_REJECTED",
    );
    expect(responseFailureError({ type: null, code: "bio_policy", param: null }).code).toBe(
      "CONTENT_REJECTED",
    );
    expect(
      responseFailureError({ type: null, code: "data_residency_mismatch", param: null }).code,
    ).toBe("AUTHORIZATION_FAILED");
    expect(responseFailureError({ type: null, code: "server_error", param: null }).code).toBe(
      "INTERNAL_FAILURE",
    );
    expect(responseFailureError({ type: null, code: null, param: null }).code).toBe("INTERNAL_FAILURE");
  });
});

describe("transport cancellation and stream failure", () => {
  const CALL = {
    apiKey: TEST_API_KEY,
    timeoutMs: 30_000,
    connectTimeoutMs: 5_000,
    maxResponseBytes: 1_024 * 1_024,
    maxErrorBodyBytes: 4_096,
  };

  function build(fake: ReturnType<typeof createFakeOpenAi>): ReturnType<typeof createFetchOpenAiTransport> {
    const manual = createManualScheduler();
    return createFetchOpenAiTransport({
      endpoint: parseOpenAiEndpoint("openai-api"),
      scheduler: openAiSchedulerFromManual(manual),
      fetchImpl: fake.fetchImpl,
    });
  }

  it("refuses a request whose caller signal is already aborted", async () => {
    const fake = createFakeOpenAi();
    fake.script("create", { json: responseObject() });
    const transport = build(fake);
    const signal = { aborted: true, addEventListener: (): void => undefined };
    await expect(
      transport.requestJson("createResponse", null, { ...CALL, signal }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    transport.close();
  });

  it("surfaces a mid-stream transport failure", async () => {
    const fake = createFakeOpenAi();
    fake.script("create", { stream: ["data: {}\n\n", { error: "ECONNRESET" }] });
    const transport = build(fake);
    const stream = await transport.requestStream("createResponse", null, CALL);
    const chunks: Uint8Array[] = [];
    let caught: unknown = null;
    try {
      for await (const chunk of stream.chunks()) {
        chunks.push(chunk);
      }
    } catch (error) {
      caught = error;
    }
    expect(isProviderError(caught, "NETWORK_FAILURE")).toBe(true);
    transport.close();
  });

  it("bounds an oversized streamed body", async () => {
    const fake = createFakeOpenAi();
    fake.script("create", { stream: [`data: ${"x".repeat(4_000)}\n\n`] });
    const transport = build(fake);
    const stream = await transport.requestStream("createResponse", null, {
      ...CALL,
      maxResponseBytes: 512,
    });
    let caught: unknown = null;
    try {
      for await (const chunk of stream.chunks()) {
        void chunk;
      }
    } catch (error) {
      caught = error;
    }
    expect(detailCode(caught)).toBe("oversized-stream-body");
    transport.close();
  });

  it("rejects a streaming response with the wrong content type", async () => {
    const fake = createFakeOpenAi();
    fake.script("create", { stream: ["data: {}\n\n"], contentType: "application/json" });
    const transport = build(fake);
    await expect(transport.requestStream("createResponse", null, CALL)).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    });
    transport.close();
  });

  it("returns a bounded error summary for a failed stream request", async () => {
    const fake = createFakeOpenAi();
    fake.script("create", {
      status: 429,
      stream: [],
      bodyText: JSON.stringify({ error: { type: "rate_limit_error", code: "rate_limit_exceeded" } }),
      headers: { "content-type": "application/json" },
    });
    const transport = build(fake);
    const stream = await transport.requestStream("createResponse", null, CALL);
    expect(stream.ok).toBe(false);
    expect(stream.upstreamError.code).toBe("rate_limit_exceeded");
    expect(() => stream.chunks()).toThrow();
    stream.abort();
    transport.close();
  });

  it("aborts in-flight work on close", async () => {
    const fake = createFakeOpenAi();
    fake.script("create", { stream: [{ holdUntilRelease: true }] });
    const transport = build(fake);
    const stream = await transport.requestStream("createResponse", null, CALL);
    const consuming = (async (): Promise<unknown> => {
      try {
        for await (const chunk of stream.chunks()) {
          void chunk;
        }
        return null;
      } catch (error) {
        return error;
      }
    })();
    transport.close();
    const error = await consuming;
    expect(isProviderError(error)).toBe(true);
  });
});

describe("policy composition branches", () => {
  const CLASSIFICATION: DataClassification = "public";

  function descriptorFor(retainsData: boolean): ProviderDescriptor {
    const handle = createTestProvider({
      configuration: retainsData ? { background: { mode: "allowed" } } : {},
    });
    const descriptor = handle.provider.describe();
    void handle.provider.close();
    return descriptor;
  }

  function rules(effects: {
    readonly disclosure: "allow" | "deny";
    readonly retention: "allow" | "deny";
  }): readonly PolicyRule[] {
    const template = (id: string, actions: readonly string[], effect: string): PolicyRule =>
      ({
        schemaVersion: 1,
        id,
        authority: "organization",
        effect,
        actions,
        classifications: [],
        risks: [],
        requiredTransformations: [],
        approval: null,
        requiredLocality: "any",
        forbidInputLogging: false,
        forbidOutputLogging: false,
        forbidArtifactPersistence: false,
        forbidRetention: false,
        maxRetentionDays: null,
        forbiddenCapabilities: [],
      }) as unknown as PolicyRule;
    return [
      template("disclosure", ["provider-disclosure"], effects.disclosure),
      template("retention", ["retention"], effects.retention),
      // A permissive allow is needed alongside a deny so the default-deny
      // rule does not mask which branch was exercised.
      template("allow-all", ["provider-disclosure", "retention"], "allow"),
    ];
  }

  function port(
    effects: Parameters<typeof rules>[0],
    retainsData = false,
  ): ReturnType<typeof createPolicyBrokerDisclosurePort> {
    const descriptor = descriptorFor(retainsData);
    return createPolicyBrokerDisclosurePort({
      policy: createDeterministicPolicyBroker({
        policyVersion: "units-1",
        rules: rules(effects),
        clock: createManualPolicyClock(),
      }),
      context: {
        handlingPolicy: (classification) => defaultDataHandlingPolicy(classification),
        risk: "low",
        projectId: null,
      },
      descriptor: () => descriptor,
      model: () => null,
    });
  }

  function request(overrides: Partial<DisclosureAuthorizationRequest> = {}): DisclosureAuthorizationRequest {
    return {
      providerInstanceId: "openai-test-1",
      operationId: "op-openai-000001",
      modelId: "test-model",
      disclosure: {
        classification: CLASSIFICATION,
        requiredLocality: "any",
        redactionApplied: false,
        decisionRef: null,
        retentionAllowed: false,
        loggingAllowed: false,
      },
      trace: { traceId: "trace-1", runId: null, taskId: null, taskRunId: null },
      requestsPersistence: false,
      requestsBackground: false,
      requestsArtifactDisclosure: false,
      ...overrides,
    } as DisclosureAuthorizationRequest;
  }

  it("allows a plain stateless disclosure without consulting retention rules", async () => {
    const decision = await port({ disclosure: "allow", retention: "deny" }).authorize(request());
    expect(decision.allowed).toBe(true);
    expect(decision.persistenceAllowed).toBe(false);
    expect(decision.temporaryServerStateAllowed).toBe(false);
    expect(decision.decisionFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("denies when the disclosure decision denies", async () => {
    const decision = await port({ disclosure: "deny", retention: "allow" }).authorize(request());
    expect(decision.allowed).toBe(false);
    expect(decision.denialCode).toBe("POLICY_DENIED");
  });

  it("evaluates retention separately for background mode", async () => {
    const allowed = await port({ disclosure: "allow", retention: "allow" }, true).authorize(
      request({ requestsBackground: true }),
    );
    expect(allowed.allowed).toBe(true);
    expect(allowed.temporaryServerStateAllowed).toBe(true);

    const denied = await port({ disclosure: "allow", retention: "deny" }, true).authorize(
      request({ requestsBackground: true }),
    );
    expect(denied.allowed).toBe(false);
    expect(denied.temporaryServerStateAllowed).toBe(false);
  });

  it("evaluates retention separately for persistence", async () => {
    const decision = await port({ disclosure: "allow", retention: "allow" }, true).authorize(
      request({ requestsPersistence: true }),
    );
    expect(decision.persistenceAllowed).toBe(true);
  });

  it("requests the image-input capability when artifacts are disclosed", async () => {
    // The provider under test has no artifact resolver, so image-input is
    // unavailable and the capability check must deny.
    const decision = await port({ disclosure: "allow", retention: "allow" }).authorize(
      request({ requestsArtifactDisclosure: true }),
    );
    expect(decision.allowed).toBe(false);
  });
});

describe("schema validator edges", () => {
  it("accepts nested boolean schemas but requires an object root", () => {
    // A root boolean is refused: the API's json_schema format requires an
    // object, so a boolean root indicates a malformed caller schema.
    expect(validateAgainstSchema(true as never, 1).violations[0]!.code).toBe("invalid_root_schema");
    expect(validateAgainstSchema({ properties: { a: true } }, { a: 1 }).valid).toBe(true);
    expect(validateAgainstSchema({ properties: { a: false } }, { a: 1 }).violations[0]!.code).toBe(
      "schema_forbids_value",
    );
  });

  it("validates additionalProperties as a schema", () => {
    const schema = { type: "object", properties: {}, additionalProperties: { type: "string" } };
    expect(validateAgainstSchema(schema, { x: "ok" }).valid).toBe(true);
    expect(validateAgainstSchema(schema, { x: 1 }).violations[0]!.code).toBe("type_mismatch");
  });

  it("reports malformed composition keywords", () => {
    expect(validateAgainstSchema({ anyOf: "nope" }, 1).violations[0]!.code).toBe("invalid_anyOf");
    expect(validateAgainstSchema({ allOf: "nope" }, 1).violations[0]!.code).toBe("invalid_allOf");
    expect(validateAgainstSchema({ oneOf: [] }, 1).violations[0]!.code).toBe("invalid_oneOf");
  });

  it("rejects an invalid nested schema node", () => {
    expect(validateAgainstSchema({ properties: { a: 5 } }, { a: 1 }).violations[0]!.code).toBe(
      "invalid_schema_node",
    );
  });

  it("supports a self-referential root ref", () => {
    const schema = {
      type: "object",
      properties: { next: { anyOf: [{ $ref: "#" }, { type: "null" }] } },
    };
    expect(validateAgainstSchema(schema, { next: { next: null } }).valid).toBe(true);
  });

  it("caps the number of reported violations", () => {
    const properties: Record<string, unknown> = {};
    const value: Record<string, unknown> = {};
    for (let index = 0; index < 100; index += 1) {
      properties[`p${index}`] = { type: "string" };
      value[`p${index}`] = index;
    }
    const result = validateAgainstSchema({ type: "object", properties }, value);
    expect(result.valid).toBe(false);
    expect(result.violations.length).toBeLessThanOrEqual(32);
  });
});

describe("provider health", () => {
  it("reports ready with the number of active operations", async () => {
    const handle = createTestProvider();
    const health = await handle.provider.health();
    expect(health.status).toBe("ready");
    expect(health.activeOperations).toBe(0);
    await handle.provider.close();
    expect((await handle.provider.health()).status).toBe("closed");
  });

  it("reports degraded when no catalog entry is effective", async () => {
    const handle = createTestProvider({
      configuration: {
        catalog: (await import("./helpers/fixtures.js")).testCatalog({
          effectiveFrom: "2099-01-01T00:00:00.000Z",
        }),
      },
    });
    const health = await handle.provider.health();
    expect(health.status).toBe("degraded");
    expect(health.detailCode).toBe("no-effective-models");
    expect(await handle.provider.listModels()).toHaveLength(0);
    await handle.provider.close();
  });

  it("refuses to list models after close", async () => {
    const handle = createTestProvider();
    await handle.provider.close();
    await expect(handle.provider.listModels()).rejects.toMatchObject({ code: "PROVIDER_CLOSED" });
  });

  it("reports a model with no effective catalog entry as unavailable", async () => {
    const handle = createTestProvider({
      configuration: {
        catalog: (await import("./helpers/fixtures.js")).testCatalog({
          effectiveFrom: "2099-01-01T00:00:00.000Z",
        }),
      },
    });
    await expect(handle.provider.start(testRequest("future"))).rejects.toMatchObject({
      code: "MODEL_UNAVAILABLE",
    });
    await handle.provider.close();
  });

  it("cancels through a caller-provided abort signal", async () => {
    const handle = createTestProvider();
    handle.fake.script("create", { stream: textStreamScript(["ok"]) });
    const listeners: Array<() => void> = [];
    let aborted = false;
    const signal = {
      get aborted(): boolean {
        return aborted;
      },
      addEventListener(_type: "abort", listener: () => void): void {
        listeners.push(listener);
      },
    };
    const operation = await handle.provider.start(testRequest("signal"), { signal });
    aborted = true;
    for (const listener of listeners) {
      listener();
    }
    await expect(operation.result).rejects.toMatchObject({ code: "CANCELLED" });
    await handle.provider.close();
  });
});
