import { ValidationError } from "@ai-dev-os/domain";
import {
  contextPackFingerprint,
  contextRequestFingerprint,
  type ContextPack
} from "@ai-dev-os/context";
import { describe, expect, it } from "vitest";
import {
  parsePromptAuthorityEnvelope,
  parsePromptCompilationRequest,
  parsePromptCompilerConfiguration,
  parsePromptTarget,
  contextItemReferences,
  promptCompilationRequestFingerprint,
  promptTargetFingerprint
} from "../src/model.js";
import {
  jsonClone,
  promptCompilationRequestFixture,
  promptCompilerConfigurationFixture,
  promptTargetFixture
} from "../src/testing/fixtures.js";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("test fixture is not a record");
  }
  return value as Record<string, unknown>;
}

describe("prompt compiler configuration", () => {
  it("parses the conservative defaults and freezes them", () => {
    const parsed = parsePromptCompilerConfiguration(promptCompilerConfigurationFixture());
    expect(parsed.maxMessages).toBe(3);
    expect(parsed.maxSchemaBytes).toBe(16_384);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("accepts exact minima and maxima and rejects one-over values", () => {
    expect(
      parsePromptCompilerConfiguration(
        promptCompilerConfigurationFixture({
          maxPromptBytes: 4_194_304,
          maxMessageBytes: 1_048_576,
          maxMessages: 16,
          maxSchemaBytes: 16_384,
          maxContextBytes: 1_048_576,
          maxOutputTokens: 1_000_000,
          maxAuthorizationAgeMs: 86_400_000
        })
      ).maxMessages
    ).toBe(16);
    expect(() =>
      parsePromptCompilerConfiguration(
        promptCompilerConfigurationFixture({ maxSchemaBytes: 16_385 })
      )
    ).toThrow(ValidationError);
    expect(() =>
      parsePromptCompilerConfiguration(
        promptCompilerConfigurationFixture({ maxMessages: 2 })
      )
    ).toThrow(ValidationError);
    expect(() =>
      parsePromptCompilerConfiguration(
        promptCompilerConfigurationFixture({
          maxPromptBytes: 10_000,
          maxMessageBytes: 11_000,
          maxContextBytes: 9_000
        })
      )
    ).toThrow(/cannot exceed maxPromptBytes/);
  });

  it("rejects unknown keys and unsupported versions", () => {
    expect(() =>
      parsePromptCompilerConfiguration({
        ...promptCompilerConfigurationFixture(),
        retryCount: 1
      })
    ).toThrow(/unexpected fields/);
    expect(() =>
      parsePromptCompilerConfiguration({
        ...promptCompilerConfigurationFixture(),
        templateVersion: 2
      })
    ).toThrow(/supported schema version/);
  });
});

describe("target and request parsing", () => {
  it("recomputes the target fingerprint and rejects substitution", () => {
    const target = promptTargetFixture();
    expect(parsePromptTarget(jsonClone(target))).toEqual(target);
    const raw = jsonClone(target) as unknown as Record<string, unknown>;
    raw["instanceId"] = "substituted-instance";
    expect(() => parsePromptTarget(raw)).toThrow(/provider.instanceId/);

    const fingerprint = jsonClone(target) as unknown as Record<string, unknown>;
    fingerprint["fingerprint"] = "a".repeat(64);
    expect(() => parsePromptTarget(fingerprint)).toThrow(/fingerprint/);
    const { fingerprint: ignored, ...unsealed } = target;
    expect(ignored).toBe(promptTargetFingerprint(unsealed));
  });

  it("normalizes authority and extension permutations into one request fingerprint", () => {
    const base = promptCompilationRequestFixture({
      extensions: [
        { namespace: "zz", key: "effort", value: "high" },
        { namespace: "aa", key: "mode", value: 1 }
      ]
    });
    const raw = jsonClone(base) as unknown as Record<string, unknown>;
    record(raw["authority"])["permittedTaskKinds"] = [
      "transform",
      "plan",
      "implement",
      "architecture",
      "refactor",
      "debug",
      "review",
      "test",
      "document",
      "explain"
    ];
    raw["extensions"] = [...base.extensions].reverse();
    const parsed = parsePromptCompilationRequest(raw);
    expect(promptCompilationRequestFingerprint(parsed)).toBe(
      promptCompilationRequestFingerprint(base)
    );
    expect(parsed.extensions.map((item) => item.namespace)).toEqual(["aa", "zz"]);
  });

  it("rejects a mutated pack and an unbound context request", () => {
    const raw = jsonClone(promptCompilationRequestFixture()) as unknown as Record<string, unknown>;
    const context = record(raw["context"]);
    const pack = record(context["pack"]);
    const items = pack["items"] as Array<Record<string, unknown>>;
    items[0]!["body"] = "tampered".padEnd(300, "x");
    expect(() => parsePromptCompilationRequest(raw)).toThrow(/fingerprint/);

    const wrongRequest = jsonClone(promptCompilationRequestFixture()) as unknown as Record<
      string,
      unknown
    >;
    record(record(wrongRequest["context"])["request"])["purpose"] = "review";
    expect(() => parsePromptCompilationRequest(wrongRequest)).toThrow(/request inputs/);
  });

  it("rejects scope, capability, edit-scope, reasoning, and classification widening", () => {
    const mutations: Array<(raw: Record<string, unknown>) => void> = [
      (raw) => {
        record(record(raw["policy"])["scope"])["traceId"] = "wrong-trace";
      },
      (raw) => {
        record(raw["taskRequirements"])["capabilities"] = ["reasoning", "shell"];
      },
      (raw) => {
        record(raw["taskRequirements"])["editScope"] = "cross-package";
      },
      (raw) => {
        record(raw["taskRequirements"])["reasoning"] = "extreme";
      },
      (raw) => {
        record(record(raw["policy"])["handlingPolicy"])["classification"] = "public";
      }
    ];
    for (const mutate of mutations) {
      const raw = jsonClone(promptCompilationRequestFixture()) as unknown as Record<string, unknown>;
      mutate(raw);
      expect(() => parsePromptCompilationRequest(raw)).toThrow();
    }
  });

  it("rejects empty task authority and writable scope without code-edit", () => {
    const base = promptCompilationRequestFixture().authority;
    expect(() =>
      parsePromptAuthorityEnvelope({ ...base, permittedTaskKinds: [] })
    ).toThrow(/at least one task kind/);
    expect(() =>
      parsePromptAuthorityEnvelope({
        ...base,
        capabilityCeiling: ["reasoning"],
        editScopeCeiling: "single-file"
      })
    ).toThrow(/code-edit/);
  });

  it("parses non-null policy, approval, retention, and deadline bindings", () => {
    const raw = jsonClone(promptCompilationRequestFixture()) as unknown as Record<string, unknown>;
    const context = record(raw["context"]);
    const pack = record(context["pack"]);
    const policyFingerprint = "a".repeat(64);
    context["policyDecisionFingerprint"] = policyFingerprint;
    pack["requestFingerprint"] = contextRequestFingerprint({
      request: context["request"] as ReturnType<typeof promptCompilationRequestFixture>["context"]["request"],
      configuration: context["configuration"] as ReturnType<typeof promptCompilationRequestFixture>["context"]["configuration"],
      estimatorId: record(pack["estimator"])["estimatorId"] as string,
      policyDecisionFingerprint: policyFingerprint
    });
    const unsealedPack = { ...pack };
    delete unsealedPack["fingerprint"];
    pack["fingerprint"] = contextPackFingerprint(
      unsealedPack as unknown as Omit<ContextPack, "fingerprint">
    );
    const policy = record(raw["policy"]);
    const transformationEvidence = policy["transformationEvidence"] as Array<
      Record<string, unknown>
    >;
    transformationEvidence[0]!["outputContextPackFingerprint"] = pack["fingerprint"];
    const scope = policy["scope"];
    const subjectDigest = record(context["request"])["subjectDigest"];
    policy["approvalEvidence"] = [
      {
        approvalRequestId: "approval-z",
        action: "provider-disclosure",
        risk: "medium",
        scope,
        subjectDigest,
        usage: "reusable",
        approverClass: "project-owner",
        approverIdentityRef: "identity-z",
        result: "approved",
        decidedAt: "2026-08-04T11:00:00.000Z",
        expiresAt: "2026-08-04T13:00:00.000Z",
        revokedAt: null,
        consumedAt: null,
        evidenceRef: "evidence-z"
      },
      {
        approvalRequestId: "approval-a",
        action: "model-eligibility",
        risk: "medium",
        scope,
        subjectDigest,
        usage: "reusable",
        approverClass: "project-owner",
        approverIdentityRef: "identity-a",
        result: "approved",
        decidedAt: "2026-08-04T11:00:00.000Z",
        expiresAt: "2026-08-04T13:00:00.000Z",
        revokedAt: null,
        consumedAt: null,
        evidenceRef: "evidence-a"
      }
    ];
    policy["retentionDays"] = 7;
    raw["deadline"] = "2026-08-04T12:05:00.000Z";
    const parsed = parsePromptCompilationRequest(raw);
    expect(parsed.context.policyDecisionFingerprint).toBe(policyFingerprint);
    expect(parsed.policy.approvalEvidence.map((item) => item.approvalRequestId)).toEqual([
      "approval-a",
      "approval-z"
    ]);
    expect(parsed.policy.retentionDays).toBe(7);
    expect(parsed.deadline).toBe("2026-08-04T12:05:00.000Z");
    expect(contextItemReferences(parsed.context.pack)).toEqual([
      expect.objectContaining({ identity: "task:stage-15-fixture" })
    ]);
  });

  it("requires one proof record per applied transformation bound to the exact pack", () => {
    const missing = jsonClone(promptCompilationRequestFixture()) as unknown as Record<
      string,
      unknown
    >;
    record(missing["policy"])["transformationEvidence"] = [];
    expect(() => parsePromptCompilationRequest(missing)).toThrow(/prove every applied transformation/);

    const wrongPack = jsonClone(promptCompilationRequestFixture()) as unknown as Record<
      string,
      unknown
    >;
    const evidence = record(wrongPack["policy"])["transformationEvidence"] as Array<
      Record<string, unknown>
    >;
    evidence[0]!["outputContextPackFingerprint"] = "f".repeat(64);
    expect(() => parsePromptCompilationRequest(wrongPack)).toThrow(/exact output context pack/);
  });
});
