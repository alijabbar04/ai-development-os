import { describe, expect, it } from "vitest";
import {
  DATA_CLASSIFICATIONS,
  PolicyViolationError,
  ValidationError,
  assertDisclosureAllowed,
  compareDataClassification,
  createDataHandlingPolicy,
  defaultDataHandlingPolicy,
  disallowedProviderCapabilities,
  evaluateDisclosure,
  evaluateProviderEligibility,
  mayPersistArtifacts,
  mayRetainLogs,
  mayUseCloudProvider,
  parseDataClassification,
  parseDataHandlingPolicy,
  parseDisclosureTarget,
  requiredRedactions,
  requiresHumanApproval,
  requiresLocalModel,
  type DisclosureTarget,
} from "../src/index.js";

const CONTEXT = { evaluatedAt: "2026-08-02T12:00:00.000Z" };

const CLOUD_TARGET: DisclosureTarget = parseDisclosureTarget({
  locality: "cloud",
  retainsData: false,
  capabilities: [],
});

const LOCAL_TARGET: DisclosureTarget = parseDisclosureTarget({
  locality: "local",
  retainsData: false,
  capabilities: [],
});

describe("data classification", () => {
  it("parses members and orders them by sensitivity", () => {
    expect(parseDataClassification("public")).toBe("public");
    expect(() => parseDataClassification("ultra")).toThrow(ValidationError);
    expect(compareDataClassification("public", "secret")).toBe(-1);
    expect(compareDataClassification("secret", "public")).toBe(1);
    expect(compareDataClassification("personal", "personal")).toBe(0);
  });

  it("provides a conservative default policy for every classification", () => {
    for (const classification of DATA_CLASSIFICATIONS) {
      const policy = defaultDataHandlingPolicy(classification);
      expect(policy.classification).toBe(classification);
      expect(Object.isFrozen(policy)).toBe(true);
    }
    expect(defaultDataHandlingPolicy("secret").cloudProvidersAllowed).toBe(false);
    expect(defaultDataHandlingPolicy("secret").artifactPersistenceAllowed).toBe(false);
    expect(defaultDataHandlingPolicy("personal").humanApprovalRequired).toBe(true);
    expect(defaultDataHandlingPolicy("public").cloudProvidersAllowed).toBe(true);
  });
});

describe("policy parsing invariants", () => {
  it("rejects policies that weaken the classification floor", () => {
    expect(() =>
      createDataHandlingPolicy({
        ...defaultDataHandlingPolicy("secret"),
        cloudProvidersAllowed: true,
        localExecutionRequired: false,
      }),
    ).toThrow(ValidationError);

    expect(() =>
      createDataHandlingPolicy({
        ...defaultDataHandlingPolicy("personal"),
        cloudProvidersAllowed: true,
        localExecutionRequired: false,
        redactionsRequiredBeforeDisclosure: [],
      }),
    ).toThrow(ValidationError);
  });

  it("rejects contradictory locality flags and unknown fields", () => {
    expect(() =>
      createDataHandlingPolicy({
        ...defaultDataHandlingPolicy("internal"),
        cloudProvidersAllowed: true,
        localExecutionRequired: true,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      parseDataHandlingPolicy({ ...defaultDataHandlingPolicy("public"), vendor: "x" }),
    ).toThrow(ValidationError);
    expect(() =>
      parseDataHandlingPolicy({ ...defaultDataHandlingPolicy("public"), schemaVersion: 42 }),
    ).toThrow(ValidationError);
  });

  it("permits a personal policy allowing cloud only with personal-data redaction", () => {
    const policy = createDataHandlingPolicy({
      ...defaultDataHandlingPolicy("personal"),
      cloudProvidersAllowed: true,
      localExecutionRequired: false,
      redactionsRequiredBeforeDisclosure: ["personal-data", "secrets"],
    });
    expect(policy.cloudProvidersAllowed).toBe(true);
  });

  it("round-trips through JSON", () => {
    const policy = defaultDataHandlingPolicy("proprietary-source");
    expect(parseDataHandlingPolicy(JSON.parse(JSON.stringify(policy)))).toEqual(policy);
  });
});

describe("disclosure evaluation", () => {
  it("allows a public policy to reach the cloud with a clean decision", () => {
    const decision = evaluateDisclosure(defaultDataHandlingPolicy("public"), CLOUD_TARGET, CONTEXT);
    expect(decision.allowed).toBe(true);
    expect(decision.reasons).toEqual([]);
    expect(decision.requiredTransformations).toEqual([]);
    expect(decision.requiredApprovals).toEqual([]);
    expect(decision.audit.evaluatedAt).toBe(CONTEXT.evaluatedAt);
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it("denies cloud disclosure for secret content with structured reasons", () => {
    const decision = evaluateDisclosure(defaultDataHandlingPolicy("secret"), CLOUD_TARGET, CONTEXT);
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.map((reason) => reason.code)).toEqual([
      "CLOUD_DISCLOSURE_FORBIDDEN",
      "LOCAL_EXECUTION_REQUIRED",
    ]);
    expect(decision.audit.ruleCodes).toContain("HUMAN_APPROVAL_REQUIRED");
    expect(decision.requiredApprovals).toEqual(["human-review"]);
  });

  it("requires redaction before cloud disclosure when the policy demands it", () => {
    const decision = evaluateDisclosure(
      defaultDataHandlingPolicy("internal"),
      CLOUD_TARGET,
      CONTEXT,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.requiredTransformations).toEqual(["secrets"]);
    expect(decision.audit.ruleCodes).toContain("REDACTION_REQUIRED");
  });

  it("denies targets exhibiting forbidden capabilities or retention", () => {
    const policy = defaultDataHandlingPolicy("proprietary-source");
    const retaining = parseDisclosureTarget({
      locality: "cloud",
      retainsData: true,
      capabilities: ["model-training"],
    });
    const decision = evaluateDisclosure(policy, retaining, CONTEXT);
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.map((reason) => reason.code)).toEqual([
      "RETENTION_FORBIDDEN",
      "CAPABILITY_FORBIDDEN",
    ]);
  });

  it("is deterministic for identical inputs", () => {
    const policy = defaultDataHandlingPolicy("internal");
    const first = evaluateDisclosure(policy, CLOUD_TARGET, CONTEXT);
    const second = evaluateDisclosure(policy, CLOUD_TARGET, CONTEXT);
    expect(first).toEqual(second);
  });

  it("validates the evaluation context timestamp", () => {
    expect(() =>
      evaluateDisclosure(defaultDataHandlingPolicy("public"), CLOUD_TARGET, {
        evaluatedAt: "yesterday",
      }),
    ).toThrow(ValidationError);
  });

  it("wraps eligibility and assertion helpers around the same decision", () => {
    const eligibility = evaluateProviderEligibility(
      defaultDataHandlingPolicy("secret"),
      CLOUD_TARGET,
      CONTEXT,
    );
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.decision.allowed).toBe(false);

    expect(() =>
      assertDisclosureAllowed(defaultDataHandlingPolicy("secret"), CLOUD_TARGET, CONTEXT),
    ).toThrow(PolicyViolationError);
    const allowed = assertDisclosureAllowed(
      defaultDataHandlingPolicy("secret"),
      LOCAL_TARGET,
      CONTEXT,
    );
    expect(allowed.allowed).toBe(true);
  });
});

describe("policy question helpers", () => {
  it("answers the routing questions without provider knowledge", () => {
    const secret = defaultDataHandlingPolicy("secret");
    const publicPolicy = defaultDataHandlingPolicy("public");

    expect(mayUseCloudProvider(secret)).toBe(false);
    expect(mayUseCloudProvider(publicPolicy)).toBe(true);
    expect(requiresLocalModel(secret)).toBe(true);
    expect(requiredRedactions(secret)).toEqual([
      "personal-data",
      "proprietary-identifiers",
      "secrets",
    ]);
    expect(mayRetainLogs(secret)).toBe(false);
    expect(mayPersistArtifacts(secret)).toBe(false);
    expect(requiresHumanApproval(secret)).toBe(true);
    expect(disallowedProviderCapabilities(secret)).toContain("data-retention");
  });
});

describe("disclosure target validation", () => {
  it("rejects hostile targets", () => {
    expect(() => parseDisclosureTarget({ locality: "edge", retainsData: false, capabilities: [] })).toThrow(
      ValidationError,
    );
    expect(() =>
      parseDisclosureTarget({ locality: "cloud", retainsData: "no", capabilities: [] }),
    ).toThrow(ValidationError);
    expect(() =>
      parseDisclosureTarget({ locality: "cloud", retainsData: false, capabilities: ["root"] }),
    ).toThrow(ValidationError);
    expect(() => parseDisclosureTarget(null)).toThrow(ValidationError);
  });
});
