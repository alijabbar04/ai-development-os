import { describe, expect, it } from "vitest";
import { isProviderError, type ProviderError } from "@ai-dev-os/providers";
import { parseSecretRef } from "@ai-dev-os/secrets";
import {
  DEFAULT_OPENAI_ENDPOINT_PROFILE,
  buildOpenAiUrl,
  createOpenAiAdapterConfiguration,
  isOpenAiEndpoint,
  parseOpenAiAdapterConfiguration,
  parseOpenAiEndpoint,
  parseOpenAiResponseId,
} from "../src/index.js";
import { TEST_API_KEY_REF, TEST_MODEL, testCatalog, testConfiguration } from "./helpers/fixtures.js";

function detailCode(error: unknown): unknown {
  return (error as ProviderError).details["detailCode"];
}

describe("endpoint profile validation", () => {
  it("resolves the profile name and its exact canonical base URL", () => {
    const byName = parseOpenAiEndpoint(DEFAULT_OPENAI_ENDPOINT_PROFILE);
    const byUrl = parseOpenAiEndpoint("https://api.openai.com/v1");
    expect(byName.baseUrl).toBe("https://api.openai.com/v1");
    expect(byUrl).toEqual(byName);
    expect(byName.hostname).toBe("api.openai.com");
    expect(byName.port).toBe(443);
  });

  it.each([
    ["http://api.openai.com/v1", "not-https"],
    ["https://evil.example.com/v1", "not-a-known-first-party-endpoint"],
    ["https://api.openai.com/v1/", "not-a-known-first-party-endpoint"],
    ["https://api.openai.com/v2", "not-a-known-first-party-endpoint"],
    ["https://api.openai.com", "not-a-known-first-party-endpoint"],
    ["https://user:pass@api.openai.com/v1", "not-a-known-first-party-endpoint"],
    ["https://api.openai.com:8443/v1", "not-a-known-first-party-endpoint"],
    ["https://api.openai.com/v1?x=1", "not-a-known-first-party-endpoint"],
    ["https://api.openai.com/v1#frag", "not-a-known-first-party-endpoint"],
    ["https://api.openai.com.evil.test/v1", "not-a-known-first-party-endpoint"],
    ["https://api%2eopenai%2ecom/v1", "not-a-known-first-party-endpoint"],
    ["ftp://api.openai.com/v1", "not-https"],
    ["", "not-a-bounded-string"],
    ["unknown-profile", "not-https"],
  ])("rejects %s", (candidate, expectedCode) => {
    expect(isOpenAiEndpoint(candidate)).toBe(false);
    try {
      parseOpenAiEndpoint(candidate);
      expect.unreachable("expected rejection");
    } catch (error) {
      expect(isProviderError(error, "INVALID_REQUEST")).toBe(true);
      expect(detailCode(error)).toBe(expectedCode);
    }
  });

  it("rejects non-string and oversized endpoint values", () => {
    for (const candidate of [null, 42, {}, [], "x".repeat(300)]) {
      expect(isOpenAiEndpoint(candidate)).toBe(false);
    }
  });
});

describe("URL construction", () => {
  const endpoint = parseOpenAiEndpoint(DEFAULT_OPENAI_ENDPOINT_PROFILE);

  it("builds fixed routes with validated response ids", () => {
    expect(buildOpenAiUrl(endpoint, "createResponse")).toBe("https://api.openai.com/v1/responses");
    expect(buildOpenAiUrl(endpoint, "getResponse", { responseId: "resp_abc123" })).toBe(
      "https://api.openai.com/v1/responses/resp_abc123",
    );
    expect(buildOpenAiUrl(endpoint, "cancelResponse", { responseId: "resp_abc123" })).toBe(
      "https://api.openai.com/v1/responses/resp_abc123/cancel",
    );
    expect(
      buildOpenAiUrl(endpoint, "streamResponse", {
        responseId: "resp_abc123",
        query: { stream: true, startingAfter: 42 },
      }),
    ).toBe("https://api.openai.com/v1/responses/resp_abc123?stream=true&starting_after=42");
  });

  it("refuses response ids that could alter the request boundary", () => {
    for (const hostile of [
      "resp_abc/../../admin",
      "resp_abc?x=1",
      "resp_abc#frag",
      "../responses",
      "resp_",
      "abc123",
      "resp_" + "x".repeat(200),
    ]) {
      expect(() => parseOpenAiResponseId(hostile)).toThrow();
      expect(() => buildOpenAiUrl(endpoint, "getResponse", { responseId: hostile })).toThrow();
    }
  });

  it("refuses a negative or unsafe resume cursor", () => {
    expect(() =>
      buildOpenAiUrl(endpoint, "streamResponse", {
        responseId: "resp_a",
        query: { stream: true, startingAfter: -1 },
      }),
    ).toThrow();
    expect(() =>
      buildOpenAiUrl(endpoint, "streamResponse", {
        responseId: "resp_a",
        query: { stream: true, startingAfter: Number.MAX_VALUE },
      }),
    ).toThrow();
  });

  it("requires a response id exactly when the route has one", () => {
    expect(() => buildOpenAiUrl(endpoint, "getResponse")).toThrow();
    expect(() => buildOpenAiUrl(endpoint, "createResponse", { responseId: "resp_a" })).toThrow();
  });
});

describe("configuration validation", () => {
  it("applies restrictive defaults", () => {
    const configuration = testConfiguration();
    expect(configuration.storage.store).toBe("never");
    expect(configuration.storage.allowPreviousResponseContinuation).toBe(false);
    expect(configuration.background.mode).toBe("disabled");
    expect(configuration.reasoning.discloseReasoning).toBe(false);
    expect(configuration.parallelToolCallsEnabled).toBe(false);
    expect(configuration.safetyIdentifierRequired).toBe(true);
    expect(configuration.endpoint.baseUrl).toBe("https://api.openai.com/v1");
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Object.isFrozen(configuration.limits)).toBe(true);
  });

  it("rejects unknown fields", () => {
    expect(() =>
      parseOpenAiAdapterConfiguration({
        ...testConfiguration(),
        surpriseField: true,
      }),
    ).toThrow();
  });

  it("does not accept an unused admin credential or an implicit default model", () => {
    for (const unsupported of [
      { adminApiKeyRef: TEST_API_KEY_REF },
      { defaultModelId: TEST_MODEL },
    ]) {
      expect(() =>
        parseOpenAiAdapterConfiguration({
          ...testConfiguration(),
          ...unsupported,
        }),
      ).toThrow();
    }
  });

  it("rejects prototype-pollution input", () => {
    const polluted = JSON.parse('{"__proto__": {"polluted": true}}') as object;
    try {
      parseOpenAiAdapterConfiguration(polluted);
      expect.unreachable("expected rejection");
    } catch (error) {
      expect(isProviderError(error, "INVALID_REQUEST")).toBe(true);
    }
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("rejects inline credential material", () => {
    try {
      parseOpenAiAdapterConfiguration({
        ...testConfiguration(),
        // A key-shaped field anywhere in the record is refused outright.
        apiKey: "sk-inline-secret",
      } as never);
      expect.unreachable("expected rejection");
    } catch (error) {
      expect(isProviderError(error, "INVALID_REQUEST")).toBe(true);
    }
  });

  it("requires a text-kind API key reference", () => {
    const bytesRef = parseSecretRef({
      schemaVersion: 1,
      type: "named",
      namespace: "openai",
      version: null,
      expectedKind: "bytes",
      providerInstanceId: null,
      name: "openai-api-key",
    });
    try {
      createOpenAiAdapterConfiguration({
        instanceId: "openai-test-1",
        apiKeyRef: bytesRef,
        permittedModels: [TEST_MODEL],
      });
      expect.unreachable("expected rejection");
    } catch (error) {
      expect(detailCode(error)).toBe("api-key-must-be-text");
    }
  });

  it("requires at least one permitted model", () => {
    try {
      createOpenAiAdapterConfiguration({
        instanceId: "openai-test-1",
        apiKeyRef: TEST_API_KEY_REF,
        permittedModels: [],
      });
      expect.unreachable("expected rejection");
    } catch (error) {
      expect(detailCode(error)).toBe("no-permitted-models");
    }
  });

  it("refuses continuation without storage, since previous_response_id needs stored state", () => {
    try {
      createOpenAiAdapterConfiguration({
        instanceId: "openai-test-1",
        apiKeyRef: TEST_API_KEY_REF,
        permittedModels: [TEST_MODEL],
        storage: { store: "never", allowPreviousResponseContinuation: true },
      });
      expect.unreachable("expected rejection");
    } catch (error) {
      expect(detailCode(error)).toBe("continuation-requires-storage");
    }
  });

  it("refuses a zero-data-retention claim alongside requested persistence", () => {
    try {
      createOpenAiAdapterConfiguration({
        instanceId: "openai-test-1",
        apiKeyRef: TEST_API_KEY_REF,
        permittedModels: [TEST_MODEL],
        storage: { store: "when-authorized" },
        retention: { zeroDataRetentionEnrolled: true },
      });
      expect.unreachable("expected rejection");
    } catch (error) {
      expect(detailCode(error)).toBe("zero-data-retention-conflicts-with-storage");
    }
  });

  it("refuses reasoning disclosure without a requested summary", () => {
    try {
      createOpenAiAdapterConfiguration({
        instanceId: "openai-test-1",
        apiKeyRef: TEST_API_KEY_REF,
        permittedModels: [TEST_MODEL],
        reasoning: { discloseReasoning: true },
      });
      expect.unreachable("expected rejection");
    } catch (error) {
      expect(detailCode(error)).toBe("disclose-reasoning-requires-summary");
    }
  });

  it("validates deadline and limit orderings", () => {
    const attempts: Array<[Partial<Parameters<typeof createOpenAiAdapterConfiguration>[0]>, string]> = [
      [{ deadlines: { connectTimeoutMs: 400_000, requestTimeoutMs: 300_000 } }, "connect-timeout-exceeds-request-timeout"],
      [
        { deadlines: { requestTimeoutMs: 900_000, totalOperationTimeoutMs: 300_000 } },
        "request-timeout-exceeds-total-operation-timeout",
      ],
      [{ limits: { maxSseLineBytes: 4_000_000, maxSseEventBytes: 2_000_000 } }, "sse-line-bound-exceeds-event-bound"],
      [
        { limits: { maxSseEventBytes: 16_000_000, maxStreamBytes: 1_048_576 } },
        "sse-event-bound-exceeds-stream-bound",
      ],
    ];
    for (const [overrides, expected] of attempts) {
      try {
        createOpenAiAdapterConfiguration({
          instanceId: "openai-test-1",
          apiKeyRef: TEST_API_KEY_REF,
          permittedModels: [TEST_MODEL],
          ...overrides,
        });
        expect.unreachable(`expected ${expected}`);
      } catch (error) {
        expect(detailCode(error)).toBe(expected);
      }
    }
  });

  it("validates organization and project identifier shapes", () => {
    expect(() =>
      createOpenAiAdapterConfiguration({
        instanceId: "openai-test-1",
        apiKeyRef: TEST_API_KEY_REF,
        permittedModels: [TEST_MODEL],
        organizationId: "not-an-org",
      }),
    ).toThrow();
    expect(() =>
      createOpenAiAdapterConfiguration({
        instanceId: "openai-test-1",
        apiKeyRef: TEST_API_KEY_REF,
        permittedModels: [TEST_MODEL],
        projectId: "not-a-project",
      }),
    ).toThrow();
    const ok = createOpenAiAdapterConfiguration({
      instanceId: "openai-test-1",
      apiKeyRef: TEST_API_KEY_REF,
      permittedModels: [TEST_MODEL],
      organizationId: "org-ABC123",
      projectId: "proj_ABC123",
    });
    expect(ok.organizationId).toBe("org-ABC123");
    expect(ok.projectId).toBe("proj_ABC123");
  });

  it("rejects unsafe numbers and out-of-range ratios", () => {
    for (const overrides of [
      { retry: { jitterRatio: 1.5 } },
      { retry: { jitterRatio: Number.NaN } },
      { background: { pollJitterRatio: -0.1 } },
      { limits: { maxStreamEvents: 0.5 } },
      { deadlines: { requestTimeoutMs: Number.MAX_VALUE } },
    ] as Array<Partial<Parameters<typeof createOpenAiAdapterConfiguration>[0]>>) {
      expect(() =>
        createOpenAiAdapterConfiguration({
          instanceId: "openai-test-1",
          apiKeyRef: TEST_API_KEY_REF,
          permittedModels: [TEST_MODEL],
          ...overrides,
        }),
      ).toThrow();
    }
  });

  it("rejects duplicate capability overrides", () => {
    expect(() =>
      createOpenAiAdapterConfiguration({
        instanceId: "openai-test-1",
        apiKeyRef: TEST_API_KEY_REF,
        permittedModels: [TEST_MODEL],
        catalog: testCatalog(),
        capabilityOverrides: [{ modelId: TEST_MODEL }, { modelId: TEST_MODEL }],
      }),
    ).toThrow();
  });

  it("round-trips a parsed configuration without drift", () => {
    const configuration = testConfiguration();
    const reparsed = parseOpenAiAdapterConfiguration(configuration);
    expect(reparsed).toEqual(configuration);
  });
});
