import type { PolicyRule } from "@ai-dev-os/policy";
import { describe, expect, it } from "vitest";
import {
  authorizationIsFresh,
  authorizationMatchesRequest,
  createPolicyAwarePromptAuthorizer,
  createPromptAuthorizationRequest,
  parsePromptAuthorizationDecision,
  promptAuthorizationFingerprint,
  sealPromptAuthorization,
  type PromptAuthorizationDecision,
  type PromptAuthorizer
} from "../src/authorization.js";
import { createPromptCompiler } from "../src/compiler.js";
import {
  PROMPT_FIXTURE_EPOCH,
  allowingPromptAuthorizer,
  jsonClone,
  promptCompilationRequestFixture,
  promptCompilerConfigurationFixture
} from "../src/testing/fixtures.js";

function reseal(
  decision: PromptAuthorizationDecision,
  changes: Partial<Omit<PromptAuthorizationDecision, "fingerprint">>
): PromptAuthorizationDecision {
  const { fingerprint: ignored, ...unsealed } = decision;
  expect(ignored).toMatch(/^[0-9a-f]{64}$/);
  return sealPromptAuthorization({ ...unsealed, ...changes });
}

async function allowedDecision(): Promise<{
  readonly authorizer: PromptAuthorizer;
  readonly request: ReturnType<typeof createPromptAuthorizationRequest>;
  readonly decision: PromptAuthorizationDecision;
}> {
  const compilation = promptCompilationRequestFixture();
  const request = createPromptAuthorizationRequest(compilation);
  const authorizer = allowingPromptAuthorizer();
  const decision = parsePromptAuthorizationDecision(await authorizer.authorize(request));
  return { authorizer, request, decision };
}

describe("prompt authorization", () => {
  it("seals two exact policy decisions into a target-bound allowed disclosure", async () => {
    const { request, decision } = await allowedDecision();
    expect(decision.outcome).toBe("allowed");
    expect(decision.policyBindings.map((item) => item.action)).toEqual([
      "provider-disclosure",
      "model-eligibility"
    ]);
    expect(decision.disclosure).toEqual({
      classification: "internal",
      requiredLocality: "any",
      redactionApplied: true,
      decisionRef: expect.stringMatching(/^[0-9a-f]{64}$/),
      retentionAllowed: true,
      loggingAllowed: true
    });
    expect(authorizationMatchesRequest(decision, request)).toBe(true);
    expect(authorizationIsFresh(decision, PROMPT_FIXTURE_EPOCH, 300_000)).toBe(true);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.policyBindings)).toBe(true);
  });

  it("returns conditional and denied outcomes without compiling a prompt", async () => {
    const conditionalRules: readonly PolicyRule[] = [
      {
        schemaVersion: 1,
        id: "conditional-disclosure",
        authority: "organization",
        effect: "conditional",
        actions: ["provider-disclosure", "model-eligibility"],
        classifications: ["internal"],
        risks: [],
        requiredTransformations: ["personal-data"],
        approval: null,
        requiredLocality: "any",
        forbidInputLogging: false,
        forbidOutputLogging: false,
        forbidArtifactPersistence: false,
        forbidRetention: false,
        maxRetentionDays: null,
        forbiddenCapabilities: []
      }
    ];
    const conditional = await createPromptCompiler({
      authorizer: allowingPromptAuthorizer({ rules: conditionalRules })
    }).compile(promptCompilationRequestFixture());
    expect(conditional).toMatchObject({
      ok: false,
      failure: { code: "AUTHORIZATION_CONDITIONAL" }
    });

    const deniedRules: readonly PolicyRule[] = conditionalRules.map((rule) => ({
      ...rule,
      id: "deny-disclosure",
      effect: "deny",
      requiredTransformations: []
    }));
    const denied = await createPromptCompiler({
      authorizer: allowingPromptAuthorizer({ rules: deniedRules })
    }).compile(promptCompilationRequestFixture());
    expect(denied).toMatchObject({
      ok: false,
      failure: { code: "AUTHORIZATION_DENIED" }
    });
  });

  it("fails unavailable on broker exceptions, authorizer exceptions, and malformed results", async () => {
    const request = promptCompilationRequestFixture();
    const unavailable = createPolicyAwarePromptAuthorizer({
      broker: {
        evaluate(): never {
          throw new Error("sensitive broker failure /private/path");
        }
      }
    });
    expect(await createPromptCompiler({ authorizer: unavailable }).compile(request)).toMatchObject({
      ok: false,
      failure: { code: "AUTHORIZATION_UNAVAILABLE" }
    });
    const throwing: PromptAuthorizer = {
      authorize(): never {
        throw new Error("secret output");
      }
    };
    const thrown = await createPromptCompiler({ authorizer: throwing }).compile(request);
    expect(thrown).toMatchObject({ ok: false, failure: { code: "AUTHORIZATION_UNAVAILABLE" } });
    expect(JSON.stringify(thrown)).not.toContain("secret output");
    const malformed = await createPromptCompiler({
      authorizer: { authorize: () => ({}) as PromptAuthorizationDecision }
    }).compile(request);
    expect(malformed).toMatchObject({
      ok: false,
      failure: { code: "AUTHORIZATION_UNAVAILABLE" }
    });
  });

  it("rejects stale and exact-binding substitutions", async () => {
    const compilation = promptCompilationRequestFixture();
    const stale = await createPromptCompiler({
      authorizer: allowingPromptAuthorizer({
        epoch: "2026-08-04T11:50:00.000Z",
        authorizationTtlMs: 1_200_000
      }),
      configuration: promptCompilerConfigurationFixture({ maxAuthorizationAgeMs: 300_000 })
    }).compile(compilation);
    expect(stale).toMatchObject({ ok: false, failure: { code: "AUTHORIZATION_STALE" } });

    const { decision } = await allowedDecision();
    const substitutions: Array<Partial<Omit<PromptAuthorizationDecision, "fingerprint">>> = [
      { subjectDigest: "f".repeat(64) },
      { traceId: "trace-substituted" },
      { targetFingerprint: "e".repeat(64) },
      { contextPackFingerprint: "d".repeat(64) },
      {
        classification: "public",
        disclosure: { ...decision.disclosure!, classification: "public" }
      }
    ];
    for (const changes of substitutions) {
      const authorizer: PromptAuthorizer = { authorize: () => reseal(decision, changes) };
      const result = await createPromptCompiler({ authorizer }).compile(compilation);
      expect(result).toMatchObject({
        ok: false,
        failure: { code: "AUTHORIZATION_MISMATCH" }
      });
    }
  });

  it("rejects malformed fingerprints, ordering, restrictions, and expirations", async () => {
    const { decision } = await allowedDecision();
    const fingerprint = jsonClone(decision) as unknown as Record<string, unknown>;
    fingerprint["fingerprint"] = "0".repeat(64);
    expect(() => parsePromptAuthorizationDecision(fingerprint)).toThrow(/fingerprint/);

    const order = jsonClone(decision) as unknown as Record<string, unknown>;
    order["policyBindings"] = [...decision.policyBindings].reverse();
    const { fingerprint: ignored, ...orderUnsealed } = order as unknown as PromptAuthorizationDecision;
    expect(ignored).toMatch(/^[0-9a-f]{64}$/);
    order["fingerprint"] = promptAuthorizationFingerprint(orderUnsealed);
    expect(() => parsePromptAuthorizationDecision(order)).toThrow(/fixed policy action order/);

    expect(() =>
      reseal(decision, {
        expiresAt: decision.evaluatedAt
      })
    ).toThrow(/after evaluatedAt/);
    expect(() =>
      reseal(decision, {
        restrictions: { ...decision.restrictions!, loggingAllowed: false }
      })
    ).toThrow(/effective restrictions/);

    const constrained = reseal(decision, {
      restrictions: {
        ...decision.restrictions!,
        capabilityConstraints: ["network-access"]
      }
    });
    expect(constrained.restrictions?.capabilityConstraints).toEqual(["network-access"]);
  });
});
