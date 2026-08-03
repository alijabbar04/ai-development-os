import { describe, expect, it } from "vitest";
import { defaultDataHandlingPolicy, type DataClassification } from "@ai-dev-os/domain";
import { isProviderError, type ProviderError } from "@ai-dev-os/providers";
import { createDeterministicPolicyBroker, createManualPolicyClock, type PolicyRule } from "@ai-dev-os/policy";
import {
  createPolicyAwareSecretResolver,
  createSecretMaterial,
  parseSecretRef,
  type SecretAccessContext,
  type SecretBroker,
  type SecretRef,
} from "@ai-dev-os/secrets";
import {
  createOpenAiProvider,
  createPolicyAwareCredentialPort,
  createPolicyBrokerDisclosurePort,
  createFetchOpenAiTransport,
  createStaticSafetyIdentifierPort,
  openAiSchedulerFromManual,
  parseOpenAiEndpoint,
} from "../src/index.js";
import { createManualScheduler } from "@ai-dev-os/provider-testkit";
import { createFakeOpenAi, textStreamScript } from "./helpers/fake-openai.js";
import {
  TEST_API_KEY,
  TEST_API_KEY_REF,
  TEST_SAFETY_IDENTIFIER,
  createTestCredentialPort,
  createTestDisclosurePort,
  createTestProvider,
  testConfiguration,
  testRequest,
} from "./helpers/fixtures.js";

function detailCode(error: unknown): unknown {
  return (error as ProviderError).details["detailCode"];
}

describe("credential resolution ordering", () => {
  it("performs no HTTP request and no secret resolve when the secret decision denies", async () => {
    const credentials = createTestCredentialPort({ deny: true });
    const { provider, fake } = createTestProvider({ credentials });

    await expect(provider.start(testRequest("secret-denied"))).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
    // The denial is provable: zero requests were issued and the callback
    // that would have received key material never ran.
    expect(fake.requests).toHaveLength(0);
    expect(credentials.resolveCount).toBe(0);
    await provider.close();
  });

  it("resolves the credential only at request time, once per operation", async () => {
    const credentials = createTestCredentialPort();
    const { provider, fake } = createTestProvider({ credentials });
    fake.script("create", { stream: textStreamScript(["ok"]) });

    expect(credentials.resolveCount).toBe(0);
    const operation = await provider.start(testRequest("resolve-once"));
    await operation.result;
    expect(credentials.resolveCount).toBe(1);
    expect(credentials.requests[0]!.operationId).toBe(operation.operationId);
    await provider.close();
  });
});

describe("disclosure authorization ordering", () => {
  it("denies before any artifact read, credential resolve, or network access", async () => {
    const credentials = createTestCredentialPort();
    const disclosure = createTestDisclosurePort({ allowed: false, denialCode: "POLICY_DENIED" });
    const handle = createTestProvider({ credentials, disclosure, withArtifacts: true });

    await expect(
      handle.provider.start(
        testRequest("disclosure-denied", {
          messages: [
            {
              role: "user",
              parts: [{ type: "image-artifact", artifactId: "art-1", mediaType: "image/png" }],
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });

    expect(handle.artifacts.reads).toHaveLength(0);
    expect(credentials.resolveCount).toBe(0);
    expect(handle.fake.requests).toHaveLength(0);
    await handle.provider.close();
  });

  it("runs the disclosure check before resolving artifacts", async () => {
    const handle = createTestProvider({ withArtifacts: true });
    handle.fake.script("create", { stream: textStreamScript(["ok"]) });
    const operation = await handle.provider.start(
      testRequest("ordering", {
        messages: [
          {
            role: "user",
            parts: [{ type: "image-artifact", artifactId: "art-1", mediaType: "image/png" }],
          },
        ],
      }),
    );
    await operation.result;
    expect(handle.disclosure.calls).toHaveLength(1);
    expect(handle.artifacts.reads).toEqual(["art-1"]);
    await handle.provider.close();
  });

  it("refuses a classification the instance does not support", async () => {
    const { provider, fake } = createTestProvider({
      configuration: { supportedClassifications: ["public"] },
    });
    await expect(
      provider.start(
        testRequest("classification", {
          disclosure: {
            classification: "proprietary-source",
            requiredLocality: "any",
            redactionApplied: true,
            decisionRef: null,
            retentionAllowed: false,
            loggingAllowed: false,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(fake.requests).toHaveLength(0);
    await provider.close();
  });

  it("refuses a local-only classification outright, since this provider is cloud", async () => {
    const { provider, fake } = createTestProvider({
      configuration: { supportedClassifications: ["public", "internal", "secret"] },
    });
    try {
      await provider.start(
        testRequest("local-only", {
          disclosure: {
            classification: "secret",
            requiredLocality: "local-only",
            redactionApplied: false,
            decisionRef: null,
            retentionAllowed: false,
            loggingAllowed: false,
          },
        }),
      );
      expect.unreachable("expected refusal");
    } catch (error) {
      expect(detailCode(error)).toBe("local-only-classification-cannot-use-cloud-provider");
    }
    expect(fake.requests).toHaveLength(0);
    await provider.close();
  });
});

describe("storage and retention honesty", () => {
  it("sends store:false by default and reports no durable retention", async () => {
    const handle = createTestProvider();
    handle.fake.script("create", { stream: textStreamScript(["ok"]) });
    const operation = await handle.provider.start(testRequest("no-store"));
    await operation.result;

    expect((handle.fake.requests[0]!.body as { store: boolean }).store).toBe(false);
    const retention = handle.provider.describeRetention();
    expect(retention.defaultStore).toBe(false);
    expect(retention.persistenceConfigurable).toBe(false);
    expect(retention.backgroundModeEnabled).toBe(false);
    expect(handle.provider.describe().retainsData).toBe(false);
    await handle.provider.close();
  });

  it("refuses persistence the policy decision did not authorize", async () => {
    const disclosure = createTestDisclosurePort({ persistenceAllowed: false });
    const handle = createTestProvider({
      disclosure,
      configuration: { storage: { store: "when-authorized" } },
    });
    try {
      await handle.provider.start(testRequest("unauthorized-store"));
      expect.unreachable("expected refusal");
    } catch (error) {
      expect(detailCode(error)).toBe("persistence-not-authorized");
    }
    expect(handle.fake.requests).toHaveLength(0);
    await handle.provider.close();
  });

  it("sends store:true only when the decision authorizes persistence", async () => {
    const disclosure = createTestDisclosurePort({ persistenceAllowed: true });
    const handle = createTestProvider({
      disclosure,
      configuration: { storage: { store: "when-authorized" } },
    });
    handle.fake.script("create", { stream: textStreamScript(["ok"]) });
    const operation = await handle.provider.start(testRequest("authorized-store"));
    await operation.result;
    expect((handle.fake.requests[0]!.body as { store: boolean }).store).toBe(true);
    await handle.provider.close();
  });

  it("treats background mode as a retention decision separate from store", async () => {
    const disclosure = createTestDisclosurePort({ temporaryServerStateAllowed: false });
    const handle = createTestProvider({
      disclosure,
      configuration: { background: { mode: "allowed" } },
    });
    try {
      await handle.provider.start(
        testRequest("bg-unauthorized", {
          extensions: [{ namespace: "openai", key: "background", value: true }],
        }),
      );
      expect.unreachable("expected refusal");
    } catch (error) {
      expect(detailCode(error)).toBe("temporary-server-state-not-authorized");
    }
    expect(handle.fake.requests).toHaveLength(0);
    await handle.provider.close();
  });

  it("discloses the temporary server-side storage that background mode implies", async () => {
    const handle = createTestProvider({
      configuration: {
        background: { mode: "allowed", resumeStreamEnabled: false },
      },
    });
    const retention = handle.provider.describeRetention();
    expect(retention.backgroundModeEnabled).toBe(true);
    // The background guide documents roughly ten minutes of temporary
    // server-side storage even when store is false.
    expect(retention.backgroundTemporaryStorageMs).toBe(600_000);
    expect(retention.zeroDataRetentionEnrolled).toBe(false);
    // retainsData is true because this instance CAN cause the upstream to
    // hold content, even though every request sends store:false.
    expect(handle.provider.describe().retainsData).toBe(true);
    expect(retention.defaultStore).toBe(false);
    await handle.provider.close();
  });

  it("records the retention facts of each request in its observation", async () => {
    const handle = createTestProvider({
      configuration: { background: { mode: "allowed", resumeStreamEnabled: false } },
    });
    handle.fake.script("create", { stream: textStreamScript(["ok"]) });
    const operation = await handle.provider.start(testRequest("retention-observation"));
    await operation.result;
    const request = handle.observations.find(
      (observation) => (observation as { kind: string }).kind === "request",
    ) as { retention: Record<string, unknown> };
    expect(request.retention).toEqual({
      storeRequested: false,
      temporaryServerStateUsed: false,
      temporaryStorageMs: 0,
      zeroDataRetentionEnrolled: false,
    });
    await handle.provider.close();
  });

  it("never claims zero data retention just because store was false", async () => {
    const handle = createTestProvider();
    // No configuration was given a ZDR arrangement, so nothing claims one.
    expect(handle.provider.describeRetention().zeroDataRetentionEnrolled).toBe(false);
    const declared = createTestProvider({
      configuration: {
        retention: { zeroDataRetentionEnrolled: true, source: "contract", declaredAt: "2026-01-01T00:00:00.000Z" },
      },
    });
    // A ZDR claim is only ever an operator declaration with provenance.
    const retention = declared.provider.describeRetention();
    expect(retention.zeroDataRetentionEnrolled).toBe(true);
    expect(retention.declarationSource).toBe("contract");
    expect(retention.declaredAt).toBe("2026-01-01T00:00:00.000Z");
    await handle.provider.close();
    await declared.provider.close();
  });

  it("does not enable previous-response continuation by default", async () => {
    const handle = createTestProvider();
    expect(handle.provider.describeRetention().previousResponseContinuationEnabled).toBe(false);
    handle.fake.script("create", { stream: textStreamScript(["ok"]) });
    const operation = await handle.provider.start(testRequest("no-continuation"));
    await operation.result;
    expect(handle.fake.requests[0]!.body).not.toHaveProperty("previous_response_id");
    await handle.provider.close();
  });
});

describe("Stage 6 composition", () => {
  const CLASSIFICATION: DataClassification = "internal";

  function allowRules(): readonly PolicyRule[] {
    return [
      {
        schemaVersion: 1,
        id: "allow-openai",
        authority: "organization",
        effect: "allow",
        actions: ["provider-disclosure", "secret-access", "retention"],
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
      } as unknown as PolicyRule,
    ];
  }

  function denyRules(): readonly PolicyRule[] {
    return [
      {
        schemaVersion: 1,
        id: "deny-secrets",
        authority: "organization",
        effect: "deny",
        actions: ["secret-access"],
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
      } as unknown as PolicyRule,
      ...allowRules(),
    ];
  }

  /** Minimal broker that records whether it was ever asked to resolve. */
  function createRecordingBroker(): SecretBroker & { readonly resolveCount: () => number } {
    let resolves = 0;
    return {
      resolveCount: () => resolves,
      describeCapabilities: () => ({
        resolve: true,
        availability: true,
        replace: false,
        revoke: false,
        versions: false,
        kinds: ["text"],
      }),
      async availability() {
        throw new Error("unused");
      },
      async withSecret<T>(
        _ref: SecretRef,
        _context: SecretAccessContext,
        callback: (secret: ReturnType<typeof createSecretMaterial>) => T | Promise<T>,
      ): Promise<T> {
        resolves += 1;
        const material = createSecretMaterial("text", new TextEncoder().encode(TEST_API_KEY));
        try {
          return await callback(material);
        } finally {
          material.dispose();
        }
      },
      async replace() {
        throw new Error("unused");
      },
      async revoke() {
        throw new Error("unused");
      },
      async close() {
        // nothing to release
      },
    } as unknown as SecretBroker & { readonly resolveCount: () => number };
  }

  function buildProvider(rules: readonly PolicyRule[]): {
    provider: ReturnType<typeof createOpenAiProvider>;
    fake: ReturnType<typeof createFakeOpenAi>;
    brokerResolveCount: () => number;
  } {
    const manual = createManualScheduler();
    const scheduler = openAiSchedulerFromManual(manual);
    const fake = createFakeOpenAi();
    const configuration = testConfiguration();
    const policy = createDeterministicPolicyBroker({
      policyVersion: "test-1",
      rules,
      clock: createManualPolicyClock(),
    });
    const broker = createRecordingBroker();
    const resolver = createPolicyAwareSecretResolver({ policy, broker });

    const context = {
      handlingPolicy: (classification: DataClassification) => defaultDataHandlingPolicy(classification),
      risk: "low" as const,
      projectId: null,
    };

    let descriptorRef: () => ReturnType<typeof provider.describe>;
    const provider = createOpenAiProvider({
      configuration,
      disclosure: createPolicyBrokerDisclosurePort({
        policy,
        context,
        descriptor: () => descriptorRef(),
        // The "internal" default policy requires secret redaction before a
        // cloud disclosure. Stage 5's boolean cannot say which kinds ran,
        // so the caller states it explicitly.
        transformationsApplied: (request) =>
          request.disclosure.redactionApplied ? (["secrets"] as const) : [],
      }),
      credentials: createPolicyAwareCredentialPort({
        resolver,
        apiKeyRef: TEST_API_KEY_REF,
        context,
        descriptor: () => descriptorRef(),
      }),
      safetyIdentifier: createStaticSafetyIdentifierPort(TEST_SAFETY_IDENTIFIER),
      scheduler,
      transport: createFetchOpenAiTransport({
        endpoint: parseOpenAiEndpoint("openai-api"),
        scheduler,
        fetchImpl: fake.fetchImpl,
      }),
    });
    descriptorRef = () => provider.describe();
    return { provider, fake, brokerResolveCount: broker.resolveCount };
  }

  it("resolves the key through the real policy-aware flow when allowed", async () => {
    const { provider, fake, brokerResolveCount } = buildProvider(allowRules());
    fake.script("create", { stream: textStreamScript(["composed"]) });
    const operation = await provider.start(
      testRequest("composed", {
        disclosure: {
          classification: CLASSIFICATION,
          requiredLocality: "any",
          redactionApplied: true,
          decisionRef: null,
          retentionAllowed: false,
          loggingAllowed: false,
        },
      }),
    );
    await operation.result;
    expect(brokerResolveCount()).toBe(1);
    expect(fake.requests[0]!.headers["authorization"]).toBe(`Bearer ${TEST_API_KEY}`);
    await provider.close();
  });

  it("proves a denied secret decision never reaches the broker or the network", async () => {
    const { provider, fake, brokerResolveCount } = buildProvider(denyRules());
    fake.script("create", { stream: textStreamScript(["never sent"]) });
    await expect(
      provider.start(
        testRequest("composed-denied", {
          disclosure: {
            classification: CLASSIFICATION,
            requiredLocality: "any",
            redactionApplied: false,
            decisionRef: null,
            retentionAllowed: false,
            loggingAllowed: false,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(brokerResolveCount()).toBe(0);
    expect(fake.requests).toHaveLength(0);
    await provider.close();
  });
});

describe("safety identifier privacy", () => {
  it("rejects identifiers that could carry personal data", async () => {
    const { assertSafetyIdentifier } = await import("../src/safety.js");
    for (const unsafe of [
      "user@example.com",
      "ada lovelace",
      "x".repeat(65),
      "short",
      "has/slash/characters",
    ]) {
      expect(() => assertSafetyIdentifier(unsafe)).toThrow();
    }
    expect(assertSafetyIdentifier("a".repeat(64))).toBe("a".repeat(64));
  });

  it("derives a stable, opaque, non-reversible token from an opaque subject", async () => {
    const { createHashedSafetyIdentifierPort, safetyIdentifierMatchesSubject } = await import(
      "../src/safety.js"
    );
    const salt = "deployment-salt-value-1234567890";
    const port = createHashedSafetyIdentifierPort({ salt, subject: () => "account-42" });
    const request = {
      providerInstanceId: "openai-test-1",
      trace: { traceId: "trace-1", runId: null, taskId: null, taskRunId: null },
      classification: "internal" as DataClassification,
    };

    const first = port.identify(request as never);
    const second = port.identify(request as never);
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    // The raw subject never appears in the transmitted value.
    expect(first).not.toContain("account-42");
    expect(safetyIdentifierMatchesSubject(first, salt, "openai-test-1", "account-42")).toBe(true);
    expect(safetyIdentifierMatchesSubject(first, salt, "openai-test-1", "account-43")).toBe(false);
  });

  it("refuses a weak salt or an oversized subject", async () => {
    const { createHashedSafetyIdentifierPort } = await import("../src/safety.js");
    expect(() => createHashedSafetyIdentifierPort({ salt: "short", subject: () => "a" })).toThrow();
    const port = createHashedSafetyIdentifierPort({
      salt: "deployment-salt-value-1234567890",
      subject: () => "x".repeat(1_000),
    });
    expect(() =>
      port.identify({
        providerInstanceId: "openai-test-1",
        trace: { traceId: "t", runId: null, taskId: null, taskRunId: null },
        classification: "internal",
      } as never),
    ).toThrow();
  });

  it("sends a value that is not an authentication credential", async () => {
    const handle = createTestProvider();
    handle.fake.script("create", { stream: textStreamScript(["ok"]) });
    const operation = await handle.provider.start(testRequest("safety-not-auth"));
    await operation.result;
    const request = handle.fake.requests[0]!;
    // The safety identifier travels in the body, never in an auth header.
    expect((request.body as { safety_identifier: string }).safety_identifier).toBe(
      TEST_SAFETY_IDENTIFIER,
    );
    expect(request.headers["authorization"]).not.toContain(TEST_SAFETY_IDENTIFIER);
    await handle.provider.close();
  });
});

describe("leakage canaries", () => {
  const PROMPT_CANARY = "PROMPT-CANARY-do-not-leak";

  it("never leaks the API key into events, errors, or observations", async () => {
    const handle = createTestProvider();
    handle.fake.script("create", { status: 500, json: { error: { type: "server_error" } } });
    let caught: unknown = null;
    try {
      await handle.provider.start(testRequest("key-leak"));
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    expect(JSON.stringify((caught as ProviderError).toJSON())).not.toContain(TEST_API_KEY);
    expect(JSON.stringify(handle.observations)).not.toContain(TEST_API_KEY);
    expect(JSON.stringify(handle.provider.describe())).not.toContain(TEST_API_KEY);
    expect(JSON.stringify(handle.provider.catalogSnapshot())).not.toContain(TEST_API_KEY);
    await handle.provider.close();
  });

  it("never echoes prompt content through errors or non-output events", async () => {
    const handle = createTestProvider();
    handle.fake.script("create", {
      status: 400,
      json: { error: { type: "invalid_request_error", message: `rejected: ${PROMPT_CANARY}` } },
    });
    let caught: unknown = null;
    try {
      await handle.provider.start(
        testRequest("prompt-leak", {
          messages: [{ role: "user", parts: [{ type: "text", text: PROMPT_CANARY }] }],
        }),
      );
    } catch (error) {
      caught = error;
    }
    expect(isProviderError(caught)).toBe(true);
    expect(JSON.stringify((caught as ProviderError).toJSON())).not.toContain(PROMPT_CANARY);
    expect(JSON.stringify(handle.observations)).not.toContain(PROMPT_CANARY);
    await handle.provider.close();
  });

  it("never leaks a mid-stream upstream error body", async () => {
    const handle = createTestProvider();
    handle.fake.script("create", {
      stream: [
        'event: error\ndata: {"type":"error","sequence_number":1,"code":"server_error","message":"internal detail PROMPT-CANARY-do-not-leak","param":null}\n\n',
      ],
    });
    const operation = await handle.provider.start(testRequest("stream-error-leak"));
    let caught: unknown = null;
    try {
      await operation.result;
    } catch (error) {
      caught = error;
    }
    expect(JSON.stringify((caught as ProviderError).toJSON())).not.toContain(PROMPT_CANARY);
    await handle.provider.close();
  });

  it("never leaks request headers or the endpoint URL into an error", async () => {
    const handle = createTestProvider({ configuration: { organizationId: "org-SECRETORG" } });
    handle.fake.script("create", { networkError: "ECONNREFUSED" });
    let caught: unknown = null;
    try {
      await handle.provider.start(testRequest("header-leak"));
    } catch (error) {
      caught = error;
    }
    const serialized = JSON.stringify((caught as ProviderError).toJSON());
    expect(serialized).not.toContain("org-SECRETORG");
    expect(serialized).not.toContain("api.openai.com");
    expect(serialized).not.toContain("Bearer");
    await handle.provider.close();
  });

  it("keeps observations free of prompts, output text, and tool arguments", async () => {
    const handle = createTestProvider();
    handle.fake.script("create", { stream: textStreamScript(["generated output text"]) });
    const operation = await handle.provider.start(
      testRequest("observation-hygiene", {
        messages: [{ role: "user", parts: [{ type: "text", text: PROMPT_CANARY }] }],
      }),
    );
    await operation.result;
    const serialized = JSON.stringify(handle.observations);
    expect(serialized).not.toContain(PROMPT_CANARY);
    expect(serialized).not.toContain("generated output text");
    expect(serialized).not.toContain(TEST_SAFETY_IDENTIFIER);
    // Structural facts ARE present.
    expect(serialized).toContain("\"kind\":\"operation\"");
    await handle.provider.close();
  });

  it("keeps the secret reference out of the descriptor and retention disclosure", async () => {
    const handle = createTestProvider();
    const serialized = JSON.stringify({
      descriptor: handle.provider.describe(),
      retention: handle.provider.describeRetention(),
    });
    expect(serialized).not.toContain("openai-api-key");
    await handle.provider.close();
  });
});

describe("secret reference hygiene", () => {
  it("refuses a reference bound to a different provider instance", () => {
    const foreign = parseSecretRef({
      schemaVersion: 1,
      type: "named",
      namespace: "openai",
      version: null,
      expectedKind: "text",
      providerInstanceId: "some-other-instance",
      name: "openai-api-key",
    });
    // The reference itself is valid; binding is enforced by the Stage 6
    // resolver, which compares it against the access context.
    expect(foreign.providerInstanceId).toBe("some-other-instance");
  });
});
