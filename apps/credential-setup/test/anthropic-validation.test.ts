import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const validationFactory = vi.hoisted(() => vi.fn());

vi.mock("@ai-dev-os/provider-anthropic/validation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-dev-os/provider-anthropic/validation")>();
  return {
    ...actual,
    createProductionDisabledAnthropicValidation: validationFactory,
  };
});
import {
  ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_CATEGORIES,
  ANTHROPIC_LIVE_CANARY_REQUEST_SHA256,
  AnthropicLiveCanaryError,
  type AnthropicLiveCanaryDiagnosticCategory,
  type AnthropicLiveCanaryDiagnostics,
  type AnthropicLiveCanaryResult,
  type ProductionDisabledAnthropicValidationOptions,
  type ProductionDisabledAnthropicValidationRunner,
} from "@ai-dev-os/provider-anthropic/validation";
import {
  createSecretMaterial,
  secretRefFingerprint,
  type SecretAccessContext,
  type SecretMaterial,
} from "@ai-dev-os/secrets";
import { appVaultReferenceForSlot } from "@ai-dev-os/secrets-app-vault";
import {
  ANTHROPIC_VALIDATION_AUTHORIZATION_RELATIVE_PATH,
  ANTHROPIC_VALIDATION_MARKER_NAMESPACE_PREFIX,
  createAnthropicValidationAuthorizationGate,
  createAnthropicValidationAuthorizationPacket,
  serializeAnthropicValidationAuthorizationPacket,
  type Stage18eICandidateBinding,
} from "../src/main/anthropic-validation-authorization.js";
import {
  createAnthropicCredentialValidationPort,
  exactAnthropicValidationSuccess,
  finiteAnthropicValidationFailure,
  finiteResultForAnthropicOutcome,
} from "../src/main/anthropic-validation.js";

const POLICY = "7".repeat(64);
const ISSUED = "2026-08-23T12:00:00.000Z";
const roots: string[] = [];
const candidate: Stage18eICandidateBinding = Object.freeze({
  schemaVersion: 1,
  status: "published",
  head: "1".repeat(40),
  tree: "2".repeat(40),
  sourceCommit: "3".repeat(40),
  sourceTree: "4".repeat(40),
  manifestPath: "docs/release-evidence/stage-18e-i-subject-manifest.json",
  manifestSha256: "5".repeat(64),
  manifestAggregate: "6".repeat(64),
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

beforeEach(() => {
  validationFactory.mockReset();
});

function successEnvelope(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    endpoint: "https://api.anthropic.com/v1/messages",
    apiVersion: "2023-06-01",
    modelId: "claude-haiku-4-5-20251001",
    retentionMode: "standard-30-day",
    statusCategory: "success",
    transportKind: "direct-anthropic-https",
    durationMs: 14_999,
    inputTokens: 256,
    outputTokens: 4,
    modelSubstitutionRejected: true,
    fixedRequestBody: true,
    repositorySourcePresent: false,
    credentialRetained: false,
    responseBodyRetained: false,
    requestFingerprint: ANTHROPIC_LIVE_CANARY_REQUEST_SHA256,
    policyDecisionFingerprint: POLICY,
  };
}

function diagnostics(category: AnthropicLiveCanaryDiagnosticCategory): AnthropicLiveCanaryDiagnostics {
  return Object.freeze({
    schemaVersion: 1,
    category,
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
}

function secretContext(signal: AbortSignal): SecretAccessContext {
  return {
    operationId: "anthropic-live-canary-v1",
    providerInstanceId: "anthropic-default",
    purpose: "provider-authentication",
    requestedLifetimeMs: 15_000,
    accessForm: "text",
    classification: "public",
    projectId: null,
    taskId: null,
    approvalEvidenceRefs: ["operator-review-stage-18e-i"],
    disclosureDecisionFingerprint: POLICY,
    locality: "cloud",
    trace: { traceId: "trace:anthropic-live-canary-v1" } as SecretAccessContext["trace"],
    deadline: null,
    signal,
  };
}

async function authorizationPort() {
  const root = await mkdtemp(join(tmpdir(), "ai-dev-os-anthropic-validation-port-test-"));
  roots.push(root);
  const path = join(root, ...ANTHROPIC_VALIDATION_AUTHORIZATION_RELATIVE_PATH.split("/"));
  await mkdir(join(path, ".."), { recursive: true });
  const packet = createAnthropicValidationAuthorizationPacket({
    candidate,
    authorizationReference: "operator-review-stage-18e-i",
    markerNamespace: `${ANTHROPIC_VALIDATION_MARKER_NAMESPACE_PREFIX}${"8".repeat(32)}`,
    issuedAt: ISSUED,
    expiresAt: "2026-08-23T13:00:00.000Z",
  });
  await writeFile(path, serializeAnthropicValidationAuthorizationPacket(packet), "utf8");
  const gate = await createAnthropicValidationAuthorizationGate({ root, candidateBinding: candidate, now: () => new Date(ISSUED) });
  return { root, gate, port: createAnthropicCredentialValidationPort({ gate, now: () => new Date(ISSUED) }) };
}

describe("Anthropic validation promotion boundary", () => {
  it("accepts only the exact producible direct-HTTPS success envelope", () => {
    expect(exactAnthropicValidationSuccess(successEnvelope(), POLICY)).toEqual({ outcome: "valid", resultCode: "VALIDATION_OK" });
    const mutations: Array<(value: any) => void> = [
      (value) => { value.schemaVersion = 2; },
      (value) => { value.endpoint = "https://example.invalid"; },
      (value) => { value.apiVersion = "future"; },
      (value) => { value.modelId = "model-substitution"; },
      (value) => { value.retentionMode = "contracted-zero"; },
      (value) => { value.statusCategory = "failure"; },
      (value) => { value.transportKind = "deterministic-fake"; },
      (value) => { value.transportKind = "direct"; },
      (value) => { value.transportKind = "injected"; },
      (value) => { value.durationMs = 15_000; },
      (value) => { value.durationMs = -1; },
      (value) => { value.inputTokens = 257; },
      (value) => { value.outputTokens = 5; },
      (value) => { value.modelSubstitutionRejected = false; },
      (value) => { value.fixedRequestBody = false; },
      (value) => { value.repositorySourcePresent = true; },
      (value) => { value.credentialRetained = true; },
      (value) => { value.responseBodyRetained = true; },
      (value) => { value.requestFingerprint = "0".repeat(64); },
      (value) => { value.policyDecisionFingerprint = "9".repeat(64); },
      (value) => { value.extra = "not-allowed"; },
    ];
    for (const mutate of mutations) {
      const value: any = successEnvelope();
      mutate(value);
      expect(exactAnthropicValidationSuccess(value, POLICY)).toBeNull();
    }
  });

  it("rejects fake, malformed, proxy, accessor, and prototype envelopes without invoking accessors", () => {
    expect(exactAnthropicValidationSuccess(new Proxy(successEnvelope(), {}), POLICY)).toBeNull();
    expect(exactAnthropicValidationSuccess(Object.assign(Object.create({ polluted: true }), successEnvelope()), POLICY)).toBeNull();
    const accessor = successEnvelope();
    let reads = 0;
    Object.defineProperty(accessor, "modelId", { enumerable: true, get() { reads += 1; return "claude-haiku-4-5-20251001"; } });
    expect(exactAnthropicValidationSuccess(accessor, POLICY)).toBeNull();
    expect(reads).toBe(0);
    expect(exactAnthropicValidationSuccess({ ...successEnvelope(), transportKind: "deterministic-fake" }, POLICY)).toBeNull();
  });

  it("maps every allowlisted diagnostic category into a finite non-prose outcome", () => {
    for (const category of ANTHROPIC_LIVE_CANARY_DIAGNOSTIC_CATEGORIES) {
      const result = finiteAnthropicValidationFailure(new AnthropicLiveCanaryError("TRANSPORT_FAILURE", "response-received", diagnostics(category)));
      const expected = category === "credential-unauthenticated"
        ? "invalid"
        : category === "billing-unavailable" || category === "permission-denied"
          ? "unauthorized"
          : ["network-transport", "local-timeout", "rate-limited", "provider-internal-error", "provider-timeout", "provider-overloaded"].includes(category)
            ? "unreachable"
            : "ambiguous";
      expect(result.outcome).toBe(expected);
      expect(JSON.stringify(result)).not.toContain("provider prose");
    }
    expect(finiteAnthropicValidationFailure(new Error("PRIVATE_PROVIDER_TEXT"))).toEqual({ outcome: "ambiguous", resultCode: "RESULT_AMBIGUOUS" });
  });

  it("does not consume on pre-confirm cancellation and remains consumed after post-confirm cancellation", async () => {
    const before = await authorizationPort();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(before.port.prepare!({
      slotId: "anthropic",
      providerInstanceId: "anthropic-default",
      secretRefFingerprint: secretRefFingerprint(appVaultReferenceForSlot("anthropic")),
      signal: cancelled.signal,
    })).rejects.toMatchObject({ code: "VALIDATION_CANCELLED" });
    expect(before.gate.authorization().state).toBe("available");

    const after = await authorizationPort();
    const controller = new AbortController();
    const attempt = await after.port.prepare!({
      slotId: "anthropic",
      providerInstanceId: "anthropic-default",
      secretRefFingerprint: secretRefFingerprint(appVaultReferenceForSlot("anthropic")),
      signal: controller.signal,
    });
    expect(after.gate.authorization().state).toBe("consumed");
    controller.abort();
    const neverRead: SecretMaterial = Object.freeze({
      kind: "text",
      async useText() { throw new Error("secret-must-not-be-read-after-cancel"); },
      async useBytes() { throw new Error("secret-must-not-be-read-after-cancel"); },
      toString() { return "[REDACTED SECRET]"; },
      toJSON() { return "[REDACTED SECRET]"; },
    });
    await expect(after.port.validate({
      slotId: "anthropic",
      credentialId: `cred-${"a".repeat(32)}`,
      recordRevision: 1,
      recordToken: "b".repeat(64),
      secret: neverRead,
      signal: controller.signal,
      policyDecisionFingerprint: POLICY,
      authorizationAttempt: attempt,
    })).rejects.toMatchObject({ code: "VALIDATION_CANCELLED" });
    await expect(after.port.prepare!({
      slotId: "anthropic",
      providerInstanceId: "anthropic-default",
      secretRefFingerprint: secretRefFingerprint(appVaultReferenceForSlot("anthropic")),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "VALIDATION_AUTHORIZATION_CONSUMED" });
  });

  it("composes the claimed authorization, callback-scoped broker, exact preflight, and dispatch observer", async () => {
    let secretReads = 0;
    validationFactory.mockImplementation((options: ProductionDisabledAnthropicValidationOptions): ProductionDisabledAnthropicValidationRunner => ({
      async runOnce(signal?: AbortSignal): Promise<AnthropicLiveCanaryResult> {
        expect(signal).toBeInstanceOf(AbortSignal);
        const boundedSignal = signal!;
        const decision = await options.preflight.check({
          endpoint: "https://api.anthropic.com/v1/messages",
          apiVersion: "2023-06-01",
          modelId: "claude-haiku-4-5-20251001",
          retentionMode: "standard-30-day",
          catalogFingerprint: candidate.manifestAggregate,
          authorizationReference: "operator-review-stage-18e-i",
          requestFingerprint: ANTHROPIC_LIVE_CANARY_REQUEST_SHA256,
          signal: boundedSignal,
        });
        expect(decision).toEqual({
          allowed: true,
          decisionFingerprint: POLICY,
          catalogFingerprint: candidate.manifestAggregate,
          authorizationReference: "operator-review-stage-18e-i",
          retentionMode: "standard-30-day",
        });
        expect(options.broker.describeCapabilities()).toMatchObject({
          resolve: true,
          availability: true,
          replace: false,
          revoke: false,
          versions: false,
          kinds: ["text"],
        });
        const context = secretContext(boundedSignal);
        const firstAvailability = await options.broker.availability(options.apiKeyRef, context);
        expect(firstAvailability.available).toBe(true);
        expect(firstAvailability.audit).toMatchObject({
          operation: "availability",
          outcome: "success",
          reference: null,
        });
        expect(Number.isFinite(Date.parse(firstAvailability.audit.occurredAt))).toBe(true);
        await options.broker.withSecret(options.apiKeyRef, context, async (secret) => {
          await secret.useText((text) => {
            secretReads += 1;
            expect(text).toBe("synthetic-anthropic-key");
          });
        });
        const secondAvailability = await options.broker.availability(options.apiKeyRef, context);
        expect(secondAvailability).toMatchObject({ available: false, reason: "unavailable" });
        await expect(options.broker.withSecret(options.apiKeyRef, context, async () => undefined))
          .rejects.toMatchObject({ code: "REFUSED" });
        await expect(options.broker.replace(options.apiKeyRef, { kind: "text", text: "synthetic" }, context))
          .rejects.toMatchObject({ code: "REFUSED" });
        await expect(options.broker.revoke(options.apiKeyRef, context))
          .rejects.toMatchObject({ code: "REFUSED" });
        await expect(options.broker.close()).resolves.toBeUndefined();
        options.observeFailurePhase?.("possibly-dispatched");
        return successEnvelope() as unknown as AnthropicLiveCanaryResult;
      },
    }));

    const fixture = await authorizationPort();
    const port = createAnthropicCredentialValidationPort({ gate: fixture.gate });
    expect(port.preciseDispatchObservation).toBe(true);
    expect(port.authorization?.()).toMatchObject({ state: "available" });
    const controller = new AbortController();
    const attempt = await port.prepare!({
      slotId: "anthropic",
      providerInstanceId: "anthropic-default",
      secretRefFingerprint: secretRefFingerprint(appVaultReferenceForSlot("anthropic")),
      signal: controller.signal,
    });
    const material = createSecretMaterial("text", new TextEncoder().encode("synthetic-anthropic-key"));
    let dispatches = 0;
    try {
      await expect(port.validate({
        slotId: "anthropic",
        credentialId: `cred-${"c".repeat(32)}`,
        recordRevision: 1,
        recordToken: "d".repeat(64),
        secret: material,
        signal: controller.signal,
        policyDecisionFingerprint: POLICY,
        authorizationAttempt: attempt,
        observeProviderDispatch: () => { dispatches += 1; },
      })).resolves.toEqual({ outcome: "valid", resultCode: "VALIDATION_OK" });
    } finally {
      material.dispose();
    }
    expect(secretReads).toBe(1);
    expect(dispatches).toBe(1);
    expect(validationFactory).toHaveBeenCalledTimes(1);
  });

  it("refuses invalid composition inputs and projects ambiguous adapter failures finitely", async () => {
    const fixture = await authorizationPort();
    const signal = new AbortController().signal;
    await expect(fixture.port.prepare!({
      slotId: "openai" as "anthropic",
      providerInstanceId: "anthropic-default",
      secretRefFingerprint: secretRefFingerprint(appVaultReferenceForSlot("anthropic")),
      signal,
    })).rejects.toMatchObject({ code: "VALIDATION_AUTHORIZATION_INVALID" });

    const material = createSecretMaterial("text", new TextEncoder().encode("synthetic-never-read"));
    try {
      await expect(fixture.port.validate({
        slotId: "anthropic",
        credentialId: `cred-${"e".repeat(32)}`,
        recordRevision: 1,
        recordToken: "f".repeat(64),
        secret: material,
        signal,
        policyDecisionFingerprint: "not-a-fingerprint",
        authorizationAttempt: Object.freeze({}) as never,
      })).rejects.toMatchObject({ code: "VALIDATION_AUTHORIZATION_INVALID" });
    } finally {
      material.dispose();
    }

    const plainFailureGate = {
      authorization: fixture.gate.authorization,
      consume: fixture.gate.consume,
      claim() { throw new Error("synthetic-claim-failure"); },
    };
    const ambiguousPort = createAnthropicCredentialValidationPort({ gate: plainFailureGate });
    const ambiguousMaterial = createSecretMaterial("text", new TextEncoder().encode("synthetic-never-read"));
    try {
      await expect(ambiguousPort.validate({
        slotId: "anthropic",
        credentialId: `cred-${"1".repeat(32)}`,
        recordRevision: 1,
        recordToken: "2".repeat(64),
        secret: ambiguousMaterial,
        signal,
        policyDecisionFingerprint: POLICY,
        authorizationAttempt: Object.freeze({}) as never,
      })).rejects.toMatchObject({ code: "VALIDATION_AUTHORIZATION_AMBIGUOUS" });
    } finally {
      ambiguousMaterial.dispose();
    }

    expect(finiteResultForAnthropicOutcome("invalid")).toEqual({
      outcome: "invalid",
      resultCode: "AUTHENTICATION_FAILED",
    });
  });

  it("turns a callback-clock failure into an inconclusive result without exposing the secret", async () => {
    validationFactory.mockImplementation((options: ProductionDisabledAnthropicValidationOptions): ProductionDisabledAnthropicValidationRunner => ({
      async runOnce(signal?: AbortSignal): Promise<AnthropicLiveCanaryResult> {
        const boundedSignal = signal!;
        const decision = await options.preflight.check({
          endpoint: "https://api.anthropic.com/v1/messages",
          apiVersion: "2023-06-01",
          modelId: "claude-haiku-4-5-20251001",
          retentionMode: "standard-30-day",
          catalogFingerprint: candidate.manifestAggregate,
          authorizationReference: "operator-review-stage-18e-i",
          requestFingerprint: ANTHROPIC_LIVE_CANARY_REQUEST_SHA256,
          signal: boundedSignal,
        });
        expect(decision.allowed).toBe(true);
        await options.broker.availability(options.apiKeyRef, secretContext(boundedSignal));
        throw new Error("unreachable");
      },
    }));
    const fixture = await authorizationPort();
    const port = createAnthropicCredentialValidationPort({
      gate: fixture.gate,
      now: () => { throw new Error("synthetic-clock-failure"); },
    });
    const controller = new AbortController();
    const attempt = await port.prepare!({
      slotId: "anthropic",
      providerInstanceId: "anthropic-default",
      secretRefFingerprint: secretRefFingerprint(appVaultReferenceForSlot("anthropic")),
      signal: controller.signal,
    });
    const material = createSecretMaterial("text", new TextEncoder().encode("PRIVATE_SYNTHETIC_SECRET"));
    try {
      const result = await port.validate({
        slotId: "anthropic",
        credentialId: `cred-${"3".repeat(32)}`,
        recordRevision: 1,
        recordToken: "4".repeat(64),
        secret: material,
        signal: controller.signal,
        policyDecisionFingerprint: POLICY,
        authorizationAttempt: attempt,
      });
      expect(result).toEqual({ outcome: "ambiguous", resultCode: "RESULT_AMBIGUOUS" });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_SYNTHETIC_SECRET");
    } finally {
      material.dispose();
    }
  });
});
