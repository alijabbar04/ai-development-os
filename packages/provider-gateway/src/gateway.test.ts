import { describe, expect, it } from "vitest";
import { createModelCapabilities, parseModelId, parseProviderId } from "@ai-dev-os/domain";
import { BUILTIN_PROVIDER_CATALOG } from "@ai-dev-os/provider-catalog";
import { createFakeInferenceProvider } from "@ai-dev-os/provider-testkit";
import { createInferenceRequest, createTrace, parseProviderInstanceId, type InferenceRequest } from "@ai-dev-os/providers";
import { parseSecretRef } from "@ai-dev-os/secrets";
import { createProviderGateway, createUnknownQuotaPort, parseRuntimeQuotaObservation, type ProviderGatewayRegistration, type RuntimeQuotaPort } from "./index.js";
import { describeProviderGatewayContract } from "./testing/contract-suite.js";

const clock = { now: () => new Date("2026-08-04T00:00:00.000Z") };
function model(providerId: "groq" | "cerebras") { return createModelCapabilities({ providerId: parseProviderId(providerId), modelId: parseModelId("gpt-oss-120b"), contextWindowTokens: 131_072, maxOutputTokens: 65_536, supportsToolUse: true, supportsStructuredOutput: true, supportsVision: false, locality: "cloud", latencyClass: "fast", codingCapability: 2, reasoningCapability: 2, cost: null }); }
function fake(providerId: "groq" | "cerebras", instanceId: string, fail = false) {
  return createFakeInferenceProvider({ descriptor: { providerId: parseProviderId(providerId), instanceId: parseProviderInstanceId(instanceId), locality: "cloud" }, models: [model(providerId)], script: { steps: fail ? [{ kind: "fail", code: "RATE_LIMITED" }] : [{ kind: "text", text: `${providerId}-ok` }] } });
}
function ref(instanceId: string | null, name = `${instanceId ?? "unbound"}-key`) { return parseSecretRef({ schemaVersion: 1, type: "named", namespace: "provider", version: null, expectedKind: "text", providerInstanceId: instanceId, name }); }
function registration(providerId: "groq" | "cerebras", instanceId: string, overrides: Partial<ProviderGatewayRegistration> = {}): ProviderGatewayRegistration {
  const provider = fake(providerId, instanceId);
  return { provider, catalogProviderId: providerId, catalogModelId: providerId === "groq" ? "openai/gpt-oss-120b" : "gpt-oss-120b", contractModelId: "gpt-oss-120b", secretRef: ref(instanceId), eligibility: "verified-free-only", userPreference: "enabled", adapter: { packageName: "@ai-dev-os/provider-openai-compatible", profileId: providerId === "groq" ? "groq-chat-completions-v1" : "cerebras-chat-completions-v2", version: "0.1.0" }, ...overrides };
}
function request(id: string, modelId = "gpt-oss-120b"): InferenceRequest { return createInferenceRequest({ requestId: id, modelId, messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }], disclosure: { classification: "public", requiredLocality: "any", redactionApplied: false, decisionRef: null, retentionAllowed: false, loggingAllowed: false }, trace: createTrace(`trace-${id}`) }); }

describe("explicit registry construction", () => {
  it("separates contract/upstream identities, secret references, preferences, and runtime state", async () => {
    const quota: RuntimeQuotaPort = { async observe() { return { schemaVersion: 1, state: "limited", checkedAt: clock.now().toISOString(), source: "response-headers", requestsRemaining: 3, tokensRemaining: null, resetsAt: null, detailCode: "near-limit" }; } };
    const gateway = await createProviderGateway({ catalog: BUILTIN_PROVIDER_CATALOG, registrations: [registration("groq", "groq-a", { quota })], clock });
    const snapshot = gateway.listInstances()[0]!;
    expect(snapshot).toMatchObject({ instanceId: "groq-a", contractModelId: "gpt-oss-120b", catalog: { modelId: "openai/gpt-oss-120b", adapterProfileId: "groq-chat-completions-v1" }, eligibility: "verified-free-only", userPreference: "enabled" });
    expect(snapshot.secretRefFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(snapshot)).not.toContain("groq-a-key");
    expect(await gateway.status("groq-a")).toMatchObject({ health: { status: "ready" }, quota: { state: "limited", requestsRemaining: 3 } });
    expect(gateway.getInstance("groq-a")).toBe(snapshot); expect(gateway.catalog().fingerprint).toBe(BUILTIN_PROVIDER_CATALOG.fingerprint); expect(gateway.fingerprint()).toMatch(/^[a-f0-9]{64}$/u);
    await gateway.close();
  });

  it("sorts instances and fingerprints deterministic configuration, never runtime quota", async () => {
    const first = await createProviderGateway({ catalog: BUILTIN_PROVIDER_CATALOG, registrations: [registration("groq", "groq-b"), registration("cerebras", "cerebras-a")], clock });
    const differentQuota: RuntimeQuotaPort = { async observe() { return { schemaVersion: 1, state: "exhausted", checkedAt: clock.now().toISOString(), source: "operator", requestsRemaining: 0, tokensRemaining: 0, resetsAt: null, detailCode: null }; } };
    const second = await createProviderGateway({ catalog: BUILTIN_PROVIDER_CATALOG, registrations: [registration("cerebras", "cerebras-a", { quota: differentQuota }), registration("groq", "groq-b")], clock });
    expect(first.listInstances().map((item) => item.instanceId)).toEqual(["cerebras-a", "groq-b"]);
    expect(first.fingerprint()).toBe(second.fingerprint());
    await first.close(); await second.close();
  });

  it.each([
    ["duplicate instance", [registration("groq", "same"), registration("groq", "same")]],
    ["reused secret", [registration("groq", "one", { secretRef: ref(null, "shared-key") }), registration("cerebras", "two", { secretRef: ref(null, "shared-key") })]],
  ])("rejects %s", async (_label, registrations) => {
    await expect(createProviderGateway({ catalog: BUILTIN_PROVIDER_CATALOG, registrations, clock })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await Promise.all(registrations.map((item) => item.provider.close()));
  });

  it("rejects descriptor, model, profile, catalog, and SecretRef binding mismatches", async () => {
    const cases: ProviderGatewayRegistration[] = [
      registration("groq", "descriptor", { catalogProviderId: "cerebras", catalogModelId: "gpt-oss-120b", adapter: { packageName: "@ai-dev-os/provider-openai-compatible", profileId: "cerebras-chat-completions-v2", version: "0.1.0" } }),
      registration("groq", "model", { contractModelId: "other" }),
      registration("groq", "profile", { adapter: { packageName: "custom", profileId: "wrong-profile", version: "1" } }),
      registration("groq", "catalog", { catalogModelId: "absent" }),
      registration("groq", "binding", { secretRef: ref("different") }),
    ];
    for (const item of cases) { await expect(createProviderGateway({ catalog: BUILTIN_PROVIDER_CATALOG, registrations: [item], clock })).rejects.toBeTruthy(); await item.provider.close(); }
  });
});

describe("explicit preflight and invocation", () => {
  it("invokes exactly one chosen provider without ranking, fallback, retry, or fan-out", async () => {
    const groq = fake("groq", "groq-only", true); const cerebras = fake("cerebras", "cerebras-idle");
    const gateway = await createProviderGateway({ catalog: BUILTIN_PROVIDER_CATALOG, registrations: [registration("groq", "ignored", { provider: groq, secretRef: ref("groq-only") }), registration("cerebras", "ignored-2", { provider: cerebras, secretRef: ref("cerebras-idle") })], clock });
    const operation = await gateway.invoke({ instanceId: "groq-only", request: request("one") });
    await expect(operation.result).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(groq.capturedRequests).toHaveLength(1); expect(cerebras.capturedRequests).toHaveLength(0);
    await gateway.close();
  });

  it("requires explicit existing instance, exact contract model, and enabled preference", async () => {
    const gateway = await createProviderGateway({ catalog: BUILTIN_PROVIDER_CATALOG, registrations: [registration("groq", "groq-on"), registration("cerebras", "cerebras-off", { userPreference: "disabled" })], clock });
    expect(() => gateway.preflight({ instanceId: "absent", request: request("absent") })).toThrowError(expect.objectContaining({ code: "MODEL_UNAVAILABLE" }));
    expect(() => gateway.preflight({ instanceId: "groq-on", request: request("wrong", "other") })).toThrowError(expect.objectContaining({ code: "MODEL_UNAVAILABLE" }));
    expect(() => gateway.preflight({ instanceId: "cerebras-off", request: request("off") })).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(gateway.preflight({ instanceId: "groq-on", request: request("ok") }).catalogFreeTierState).toBe("verified");
    await gateway.close();
  });

  it("fails closed for verified-free-only when catalog evidence expires, while any remains explicit", async () => {
    const expiredClock = { now: () => new Date("2026-08-10T00:00:00.000Z") };
    const free = await createProviderGateway({ catalog: BUILTIN_PROVIDER_CATALOG, registrations: [registration("groq", "free")], clock: expiredClock });
    expect(() => free.preflight({ instanceId: "free", request: request("expired") })).toThrowError(expect.objectContaining({ code: "MODEL_UNAVAILABLE" })); await free.close();
    const any = await createProviderGateway({ catalog: BUILTIN_PROVIDER_CATALOG, registrations: [registration("groq", "any", { eligibility: "any" })], clock: expiredClock });
    expect(any.preflight({ instanceId: "any", request: request("allowed") }).catalogFreeTierState).toBe("unknown"); await any.close();
  });

  it("closes idempotently and rejects later operations", async () => {
    const gateway = await createProviderGateway({ catalog: BUILTIN_PROVIDER_CATALOG, registrations: [registration("groq", "close")], clock });
    await gateway.close(); await gateway.close(); await expect(gateway.status("close")).rejects.toMatchObject({ code: "PROVIDER_CLOSED" });
  });
});

describe("typed quota observations", () => {
  it("parses finite states and provides an immutable unknown default", async () => {
    const value = parseRuntimeQuotaObservation({ schemaVersion: 1, state: "available", checkedAt: "2026-08-04T00:00:00.000Z", source: "operator", requestsRemaining: 5, tokensRemaining: 10, resetsAt: "2026-08-05T00:00:00.000Z", detailCode: null });
    expect(Object.isFrozen(value)).toBe(true); expect(value.state).toBe("available");
    expect(await createUnknownQuotaPort(clock).observe({ instanceId: "x", providerId: "x", catalogModelId: "x" })).toMatchObject({ state: "unknown", source: "unobserved" });
    expect(() => parseRuntimeQuotaObservation({ ...value, state: "future" })).toThrow();
    expect(() => parseRuntimeQuotaObservation({ ...value, schemaVersion: 2 })).toThrow("unsupported schema");
  });
});

describeProviderGatewayContract("Stage 12 explicit registry", async () => {
  const primary = fake("groq", "contract-primary");
  const secondary = fake("cerebras", "contract-secondary");
  const gateway = await createProviderGateway({
    catalog: BUILTIN_PROVIDER_CATALOG,
    registrations: [
      registration("groq", "unused-primary", { provider: primary, secretRef: ref("contract-primary"), eligibility: "any" }),
      registration("cerebras", "unused-secondary", { provider: secondary, secretRef: ref("contract-secondary"), eligibility: "any" }),
    ],
    clock,
  });
  return {
    gateway,
    primaryInstanceId: "contract-primary",
    secondaryInstanceId: "contract-secondary",
    request: request("contract"),
    mismatchedRequest: request("contract-mismatch", "other"),
    primaryInvocationCount: () => primary.capturedRequests.length,
    secondaryInvocationCount: () => secondary.capturedRequests.length,
    close: () => gateway.close(),
  };
});
