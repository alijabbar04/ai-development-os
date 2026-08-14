import { defaultDataHandlingPolicy } from "@ai-dev-os/domain";
import { createDeterministicPolicyBroker, createManualPolicyClock, parsePolicyRequest, parsePolicyRule } from "@ai-dev-os/policy";
import {
  SecretBrokerError,
  createPolicyAwareSecretResolver,
  createSecretMaterial,
  parseSecretRef,
  secretRefFingerprint,
  type PolicyAwareSecretResolver,
} from "@ai-dev-os/secrets";
import { createWindowsCredentialSecretBrokerForTesting } from "@ai-dev-os/secrets-windows/testing";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  createAnthropicAdapterConfiguration,
  AnthropicTransportFailure,
  createPolicyAwareAnthropicCredentialPort,
  type AnthropicCredentialRequest,
} from "../src/index.js";
import { createAnthropicProviderForTesting } from "../src/testing/index.js";
import {
  PLACEHOLDER_SECRET,
  configuration,
  fakePorts,
  request,
  textScript,
} from "./helpers.js";

const REF = parseSecretRef({
  schemaVersion: 1,
  type: "keychain",
  namespace: "anthropic",
  service: "api-key",
  account: "operator",
  version: null,
  expectedKind: "text",
  providerInstanceId: "anthropic:test",
});

function policy(effect: "allow" | "deny", requiredLocality: "local" | "any" = "any") {
  return createDeterministicPolicyBroker({
    policyVersion: "windows-credential-v1",
    rules: [parsePolicyRule({
      schemaVersion: 1,
      id: `windows-credential-${effect}`,
      authority: "organization",
      effect,
      actions: ["secret-access"],
      classifications: [],
      risks: [],
      requiredTransformations: [],
      approval: null,
      requiredLocality,
      forbidInputLogging: true,
      forbidOutputLogging: true,
      forbidArtifactPersistence: true,
      forbidRetention: true,
      maxRetentionDays: 0,
      forbiddenCapabilities: [],
    })],
    clock: createManualPolicyClock(),
  });
}

function policyRequestFor(value: AnthropicCredentialRequest) {
  return parsePolicyRequest({
    schemaVersion: 1,
    action: "secret-access",
    classification: value.classification,
    handlingPolicy: defaultDataHandlingPolicy(value.classification),
    risk: "low",
    locality: "cloud",
    provider: null,
    model: null,
    scope: {
      projectId: "project-1",
      taskId: value.trace.taskId,
      providerInstanceId: value.instanceId,
      workspaceId: null,
      operationId: value.operationId,
      traceId: value.trace.traceId,
    },
    subjectDigest: secretRefFingerprint(value.secretRef),
    requestedCapabilities: [],
    transformationsApplied: [],
    approvalEvidence: [],
    retentionDays: 0,
    trace: value.trace,
    requesterKind: "system",
  });
}

function credentialRequest(): AnthropicCredentialRequest {
  return Object.freeze({
    instanceId: "anthropic:test",
    operationId: "operation-1",
    secretRef: REF,
    classification: "internal",
    policyDecisionFingerprint: "a".repeat(64),
    deadline: "2026-08-03T12:00:00.000Z",
    trace: { traceId: "trace-1", runId: "run-1", taskId: "task-1", taskRunId: "attempt-1" },
    signal: new AbortController().signal,
  });
}

function composition(effect: "allow" | "deny" = "allow") {
  const observations: string[] = [];
  const clock = { now: () => new Date("2026-08-02T00:00:00.000Z") };
  const broker = createWindowsCredentialSecretBrokerForTesting({
    schemaVersion: 1,
    reference: REF,
    clock,
    native: {
      async availability() { observations.push("native-availability"); return { status: "ok" as const }; },
      async read() { observations.push("native-read"); return { status: "ok" as const, bytes: new TextEncoder().encode(PLACEHOLDER_SECRET) }; },
    },
  });
  const resolver = createPolicyAwareSecretResolver({ policy: policy(effect), broker });
  const credentials = createPolicyAwareAnthropicCredentialPort({ resolver, policyRequestFor, requestedLifetimeMs: 15_000 });
  return { broker, credentials, observations };
}

describe("policy-aware Anthropic credential composition", () => {
  it("evaluates secret-access policy before the exact native read", async () => {
    const fixture = composition("allow");
    const value = await fixture.credentials.withApiKey(credentialRequest(), async (secret) => {
      fixture.observations.push("consumer");
      return secret.length;
    });
    expect(value).toBe(PLACEHOLDER_SECRET.length);
    expect(fixture.observations).toEqual(["native-read", "consumer"]);
    await fixture.broker.close();
  });

  it("denies before native access and refuses mismatched policy subject/scope", async () => {
    const denied = composition("deny");
    await expect(denied.credentials.withApiKey(credentialRequest(), async () => undefined)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(denied.observations).toHaveLength(0);

    const allowed = composition("allow");
    const wrong = createPolicyAwareAnthropicCredentialPort({
      resolver: createPolicyAwareSecretResolver({ policy: policy("allow"), broker: allowed.broker }),
      policyRequestFor: (value) => parsePolicyRequest({ ...policyRequestFor(value), subjectDigest: "f".repeat(64) }),
      requestedLifetimeMs: 15_000,
    });
    await expect(wrong.withApiKey(credentialRequest(), async () => undefined)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(allowed.observations).toHaveLength(0);
  });

  it("refuses a local-only secret policy before native access or cloud transport", async () => {
    const fixture = composition("allow");
    const credentials = createPolicyAwareAnthropicCredentialPort({
      resolver: createPolicyAwareSecretResolver({ policy: policy("allow", "local"), broker: fixture.broker }),
      policyRequestFor,
      requestedLifetimeMs: 15_000,
    });
    let transportCalls = 0;
    await expect(credentials.withApiKey(credentialRequest(), async () => { transportCalls += 1; })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(fixture.observations).toHaveLength(0);
    expect(transportCalls).toBe(0);
    await fixture.broker.close();
  });

  it("passes the scoped secret through the real provider credential seam and into no other state", async () => {
    const fixture = composition("allow");
    const fake = fakePorts({ script: { events: textScript(["ok"]) } });
    const base = configuration();
    const provider = createAnthropicProviderForTesting({
      configuration: createAnthropicAdapterConfiguration({
        instanceId: base.instanceId,
        endpoint: base.endpoint,
        apiVersion: base.apiVersion,
        model: base.model,
        apiKeyRef: REF,
        retention: base.retention,
        bounds: base.bounds,
        supportedClassifications: base.supportedClassifications,
      }),
      ports: Object.freeze({ ...fake.ports, credentials: fixture.credentials }),
    });
    try {
      const operation = await provider.start(request("windows-credential"));
      const settled = operation.result;
      for await (const _event of operation.events()) { /* bounded drain */ }
      const result = await settled;
      expect(result.finishReason).toBe("stop");
      expect(fixture.observations).toEqual(["native-read"]);
      expect(fake.observations.map((item) => item.operation)).toEqual(["policy", "transport"]);
    } finally {
      fake.release();
      await provider.close();
      await fixture.broker.close();
    }
  });

  it("preserves finite authentication and rate-limit transport classifications after secret disposal", async () => {
    for (const [kind, expectedCode, retryAfterMs] of [["authentication_error", "AUTHENTICATION_FAILED", null], ["rate_limit_error", "RATE_LIMITED", 1_500]] as const) {
      const fixture = composition("allow");
      const fake = fakePorts({ script: { failureBefore: new AnthropicTransportFailure(kind, { status: kind === "authentication_error" ? 401 : 429, retryAfterMs }) } });
      const base = configuration();
      const provider = createAnthropicProviderForTesting({
        configuration: createAnthropicAdapterConfiguration({
          instanceId: base.instanceId,
          endpoint: base.endpoint,
          apiVersion: base.apiVersion,
          model: base.model,
          apiKeyRef: REF,
          retention: base.retention,
          bounds: base.bounds,
          supportedClassifications: base.supportedClassifications,
        }),
        ports: Object.freeze({ ...fake.ports, credentials: fixture.credentials }),
      });
      try {
        const error = await provider.start(request(`windows-credential-${kind}`)).catch((value: unknown) => value);
        expect(error).toMatchObject({ code: expectedCode, retryAfterMs });
        if (kind === "rate_limit_error") expect(error).toMatchObject({ retry: { strategy: "same-after-delay", retryAfterMs: 1_500 } });
        expect(JSON.stringify(error)).not.toContain(PLACEHOLDER_SECRET);
        expect(inspect(error)).not.toContain(PLACEHOLDER_SECRET);
        expect(fixture.observations).toEqual(["native-read"]);
        expect(fake.observations.map((item) => item.operation)).toEqual(["policy", "transport"]);
      } finally {
        fake.release();
        await provider.close();
        await fixture.broker.close();
      }
    }
  });

  it("disposes material when the Anthropic consumer rejects or cancellation is already set", async () => {
    const fixture = composition("allow");
    await expect(fixture.credentials.withApiKey(credentialRequest(), async () => { throw new Error(PLACEHOLDER_SECRET); })).rejects.toMatchObject({ code: "CONSUMER_FAILURE" });
    const controller = new AbortController(); controller.abort();
    await expect(fixture.credentials.withApiKey({ ...credentialRequest(), signal: controller.signal }, async () => undefined)).rejects.toMatchObject({ code: "RESOLUTION_TIMEOUT" });
    expect(fixture.observations).toEqual(["native-read"]);
    await fixture.broker.close();
  });

  it("captures exact resolver and policy methods and rejects accessor/proxy option surfaces", async () => {
    const fixture = composition("allow");
    const baseResolver = createPolicyAwareSecretResolver({ policy: policy("allow"), broker: fixture.broker });
    const capturedWithSecret = function <T>(input: Parameters<PolicyAwareSecretResolver["withSecret"]>[0], callback: Parameters<PolicyAwareSecretResolver["withSecret"]>[1]) {
      return Reflect.apply(baseResolver.withSecret, baseResolver, [input, callback]) as ReturnType<PolicyAwareSecretResolver["withSecret"]>;
    };
    Object.defineProperty(capturedWithSecret, "bind", { value: () => async () => { throw new Error("shadowed-bind"); } });
    const mutableResolver = { withSecret: capturedWithSecret as PolicyAwareSecretResolver["withSecret"] };
    let policyBuilderThis: unknown = "not-called";
    const standalonePolicyRequestFor = function (this: unknown, request: AnthropicCredentialRequest) {
      policyBuilderThis = this;
      return policyRequestFor(request);
    };
    const credential = createPolicyAwareAnthropicCredentialPort({ resolver: mutableResolver, policyRequestFor: standalonePolicyRequestFor, requestedLifetimeMs: 15_000 });
    mutableResolver.withSecret = async () => { throw new Error("substituted"); };
    await expect(credential.withApiKey(credentialRequest(), async (value) => value.length)).resolves.toBe(PLACEHOLDER_SECRET.length);
    expect(policyBuilderThis).toBeUndefined();

    const valid = { resolver: mutableResolver, policyRequestFor, requestedLifetimeMs: 15_000 };
    expect(() => createPolicyAwareAnthropicCredentialPort(new Proxy(valid, {}))).toThrow();
    const accessor = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessor, "policyRequestFor", { enumerable: true, get: () => policyRequestFor });
    expect(() => createPolicyAwareAnthropicCredentialPort(accessor as unknown as typeof valid)).toThrow();
    await fixture.broker.close();
  });

  it("accepts an omitted signal and binds sorted approval evidence into the resolver context", async () => {
    const seen: unknown[] = [];
    const resolver: PolicyAwareSecretResolver = {
      async withSecret(input, callback) {
        seen.push(input);
        const material = createSecretMaterial("text", new TextEncoder().encode(PLACEHOLDER_SECRET));
        try {
          return Object.freeze({ value: await callback(material, "d".repeat(64)), decisionFingerprint: "d".repeat(64) });
        } finally {
          material.dispose();
        }
      },
    };
    const requestWithoutSignal = { ...credentialRequest() } as Record<string, unknown>;
    delete requestWithoutSignal["signal"];
    const credentials = createPolicyAwareAnthropicCredentialPort({
      resolver,
      requestedLifetimeMs: 15_000,
      policyRequestFor: (value) => {
        const base = policyRequestFor(value);
        const approval = {
          approvalRequestId: "approval-1",
          action: "secret-access",
          risk: "low",
          scope: base.scope,
          subjectDigest: base.subjectDigest,
          usage: "one-shot",
          approverClass: "user",
          approverIdentityRef: "operator-1",
          result: "approved",
          decidedAt: "2026-08-02T00:00:00.000Z",
          expiresAt: "2026-08-02T00:10:00.000Z",
          revokedAt: null,
          consumedAt: null,
          evidenceRef: "evidence-1",
        } as const;
        return parsePolicyRequest({ ...base, approvalEvidence: [approval] });
      },
    });
    await expect(credentials.withApiKey(requestWithoutSignal as unknown as AnthropicCredentialRequest, async (value) => value.length)).resolves.toBe(PLACEHOLDER_SECRET.length);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      ref: REF,
      context: {
        approvalEvidenceRefs: ["evidence-1"],
        disclosureDecisionFingerprint: "a".repeat(64),
        requestedLifetimeMs: 15_000,
      },
    });
    expect((seen[0] as { context: { signal?: unknown } }).context.signal).toBeUndefined();
  });

  it("rejects malformed options, requests, policies, and resolver results with finite errors", async () => {
    const fixture = composition("allow");
    const valid = { resolver: createPolicyAwareSecretResolver({ policy: policy("allow"), broker: fixture.broker }), policyRequestFor, requestedLifetimeMs: 15_000 };
    for (const options of [
      { ...valid, resolver: null },
      { ...valid, resolver: {} },
      { ...valid, resolver: Object.defineProperty({}, "withSecret", { enumerable: true, get: () => async () => undefined }) },
      { ...valid, policyRequestFor: 1 },
      { ...valid, requestedLifetimeMs: 0 },
      { ...valid, requestedLifetimeMs: 60_001 },
      { ...valid, requestedLifetimeMs: 1.5 },
    ]) {
      expect(() => createPolicyAwareAnthropicCredentialPort(options as never)).toThrow(SecretBrokerError);
    }

    const credentials = createPolicyAwareAnthropicCredentialPort(valid);
    await expect(credentials.withApiKey(credentialRequest(), 1 as never)).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
    const invalidRequests: unknown[] = [
      { ...credentialRequest(), extra: true },
      { ...credentialRequest(), signal: {} },
      { ...credentialRequest(), signal: new Proxy(new AbortController().signal, {}) },
      Object.assign(Object.create({ inherited: true }), credentialRequest()),
      new Proxy(credentialRequest(), {}),
      { ...credentialRequest(), [Symbol("hidden")]: true },
      Object.defineProperty({ ...credentialRequest() }, "operationId", { enumerable: true, get: () => "operation-1" }),
    ];
    for (const request of invalidRequests) {
      await expect(credentials.withApiKey(request as AnthropicCredentialRequest, async () => undefined)).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
    }

    const policyFailure = createPolicyAwareAnthropicCredentialPort({ ...valid, policyRequestFor: () => { throw new Error(PLACEHOLDER_SECRET); } });
    await expect(policyFailure.withApiKey(credentialRequest(), async () => undefined)).rejects.toMatchObject({ code: "ACCESS_DENIED" });

    for (const rawResult of [{ value: 1, decisionFingerprint: "invalid" }, { value: 1, decisionFingerprint: "d".repeat(64), extra: true }]) {
      const resolver: PolicyAwareSecretResolver = { async withSecret() { return rawResult as never; } };
      const port = createPolicyAwareAnthropicCredentialPort({ ...valid, resolver });
      await expect(port.withApiKey(credentialRequest(), async () => undefined)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    }
    const throwingResolver: PolicyAwareSecretResolver = { async withSecret() { throw new Error(PLACEHOLDER_SECRET); } };
    const throwingPort = createPolicyAwareAnthropicCredentialPort({ ...valid, resolver: throwingResolver });
    const error = await throwingPort.withApiKey(credentialRequest(), async () => undefined).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "BACKEND_FAILURE", message: "The Anthropic credential resolution failed." });
    expect(JSON.stringify(error)).not.toContain(PLACEHOLDER_SECRET);
    const secretErrorResolver: PolicyAwareSecretResolver = { async withSecret() { throw new SecretBrokerError("BACKEND_FAILURE", PLACEHOLDER_SECRET, { leaked: PLACEHOLDER_SECRET }, PLACEHOLDER_SECRET); } };
    const secretErrorPort = createPolicyAwareAnthropicCredentialPort({ ...valid, resolver: secretErrorResolver });
    const secretError = await secretErrorPort.withApiKey(credentialRequest(), async () => undefined).catch((value: unknown) => value);
    expect(secretError).toMatchObject({ code: "BACKEND_FAILURE", message: "The Anthropic credential backend failed.", details: {}, causeCategory: null });
    expect(JSON.stringify(secretError)).not.toContain(PLACEHOLDER_SECRET);
    expect(inspect(secretError)).not.toContain(PLACEHOLDER_SECRET);
    for (const thrown of ["toString", "__proto__"].map((code) => { const value = new SecretBrokerError("BACKEND_FAILURE", PLACEHOLDER_SECRET); Object.defineProperty(value, "code", { value: code, enumerable: true, configurable: true }); return value; }).concat([new Proxy(new SecretBrokerError("BACKEND_FAILURE", PLACEHOLDER_SECRET), {})])) {
      const forgedPort = createPolicyAwareAnthropicCredentialPort({ ...valid, resolver: { async withSecret() { throw thrown; } } });
      await expect(forgedPort.withApiKey(credentialRequest(), async () => undefined)).rejects.toMatchObject({ code: "BACKEND_FAILURE", message: "The Anthropic credential resolution failed." });
    }

    let consumerCalls = 0;
    const invalidPreCallback: PolicyAwareSecretResolver = {
      async withSecret(_input, callback) {
        const material = createSecretMaterial("text", new TextEncoder().encode(PLACEHOLDER_SECRET));
        try {
          return { value: await callback(material, "invalid"), decisionFingerprint: "invalid" };
        } finally {
          material.dispose();
        }
      },
    };
    const invalidPreCallbackPort = createPolicyAwareAnthropicCredentialPort({ ...valid, resolver: invalidPreCallback });
    await expect(invalidPreCallbackPort.withApiKey(credentialRequest(), async () => { consumerCalls += 1; })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(consumerCalls).toBe(0);

    const mismatchedReturn: PolicyAwareSecretResolver = {
      async withSecret(_input, callback) {
        const material = createSecretMaterial("text", new TextEncoder().encode(PLACEHOLDER_SECRET));
        try {
          await callback(material, "d".repeat(64));
          return { value: "resolver-substitution", decisionFingerprint: "e".repeat(64) } as never;
        } finally {
          material.dispose();
        }
      },
    };
    const mismatchedPort = createPolicyAwareAnthropicCredentialPort({ ...valid, resolver: mismatchedReturn });
    await expect(mismatchedPort.withApiKey(credentialRequest(), async () => { consumerCalls += 1; return "transport-result"; })).resolves.toBe("transport-result");
    expect(consumerCalls).toBe(1);

    const duplicateCallback: PolicyAwareSecretResolver = {
      async withSecret(_input, callback) {
        const material = createSecretMaterial("text", new TextEncoder().encode(PLACEHOLDER_SECRET));
        try {
          await callback(material, "d".repeat(64));
          return { value: await callback(material, "d".repeat(64)), decisionFingerprint: "d".repeat(64) };
        } finally {
          material.dispose();
        }
      },
    };
    const duplicateCallbackPort = createPolicyAwareAnthropicCredentialPort({ ...valid, resolver: duplicateCallback });
    await expect(duplicateCallbackPort.withApiKey(credentialRequest(), async () => { consumerCalls += 1; })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(consumerCalls).toBe(2);
    await fixture.broker.close();
  });

  it("binds every trace and policy-scope field before native access", async () => {
    for (const mutate of [
      (base: ReturnType<typeof policyRequestFor>) => ({ ...base, trace: { ...base.trace, traceId: "other-trace" } }),
      (base: ReturnType<typeof policyRequestFor>) => ({ ...base, trace: { ...base.trace, runId: "other-run" } }),
      (base: ReturnType<typeof policyRequestFor>) => ({ ...base, trace: { ...base.trace, taskId: "other-task" } }),
      (base: ReturnType<typeof policyRequestFor>) => ({ ...base, trace: { ...base.trace, taskRunId: "other-attempt" } }),
      (base: ReturnType<typeof policyRequestFor>) => ({ ...base, scope: { ...base.scope, taskId: "other-task" } }),
      (base: ReturnType<typeof policyRequestFor>) => ({ ...base, scope: { ...base.scope, taskId: null } }),
      (base: ReturnType<typeof policyRequestFor>) => ({ ...base, scope: { ...base.scope, operationId: "other-operation" } }),
      (base: ReturnType<typeof policyRequestFor>) => ({ ...base, scope: { ...base.scope, providerInstanceId: "anthropic:other" } }),
      (base: ReturnType<typeof policyRequestFor>) => ({ ...base, scope: { ...base.scope, traceId: "other-trace" } }),
      (base: ReturnType<typeof policyRequestFor>) => ({ ...base, scope: { ...base.scope, traceId: null } }),
      (base: ReturnType<typeof policyRequestFor>) => ({ ...base, scope: { ...base.scope, workspaceId: "other-workspace" } }),
      (base: ReturnType<typeof policyRequestFor>) => ({ ...base, locality: "local" as const }),
      (base: ReturnType<typeof policyRequestFor>) => ({ ...base, locality: "unspecified" as const }),
      (base: ReturnType<typeof policyRequestFor>) => ({ ...base, classification: "public" as const, handlingPolicy: defaultDataHandlingPolicy("public") }),
      (base: ReturnType<typeof policyRequestFor>) => ({ ...base, subjectDigest: "f".repeat(64) }),
    ]) {
      const fixture = composition("allow");
      const credentials = createPolicyAwareAnthropicCredentialPort({
        resolver: createPolicyAwareSecretResolver({ policy: policy("allow"), broker: fixture.broker }),
        policyRequestFor: (value) => parsePolicyRequest(mutate(policyRequestFor(value))),
        requestedLifetimeMs: 15_000,
      });
      await expect(credentials.withApiKey(credentialRequest(), async () => undefined)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      expect(fixture.observations).toHaveLength(0);
      await fixture.broker.close();
    }
  });
});
