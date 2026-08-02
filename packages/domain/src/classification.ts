import { PolicyViolationError } from "./errors.js";
import {
  ensureBoolean,
  ensureEnum,
  ensureEnumArray,
  ensureExactKeys,
  ensureRecord,
  ensureSchemaVersion,
  ensureTimestamp,
  fail,
} from "./internal/guards.js";

export const DATA_HANDLING_POLICY_SCHEMA_VERSION = 1 as const;

/**
 * Data classifications ordered from least to most sensitive.
 *
 * - `public`: content that may be disclosed anywhere.
 * - `internal`: non-public operational content.
 * - `proprietary-source`: proprietary source code and derived analysis.
 * - `personal`: personally identifiable data.
 * - `secret`: credential-bearing or secret-bearing content; never leaves
 *   the local machine and is never persisted unredacted.
 */
export const DATA_CLASSIFICATIONS = Object.freeze([
  "public",
  "internal",
  "proprietary-source",
  "personal",
  "secret",
] as const);

export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];

export function parseDataClassification(
  value: unknown,
  path = "dataClassification",
): DataClassification {
  return ensureEnum(value, path, DATA_CLASSIFICATIONS);
}

/** Compares by sensitivity. Negative when `a` is less sensitive than `b`. */
export function compareDataClassification(
  a: DataClassification,
  b: DataClassification,
): -1 | 0 | 1 {
  const rankA = DATA_CLASSIFICATIONS.indexOf(a);
  const rankB = DATA_CLASSIFICATIONS.indexOf(b);
  return rankA < rankB ? -1 : rankA > rankB ? 1 : 0;
}

export const REDACTION_KINDS = Object.freeze([
  "personal-data",
  "proprietary-identifiers",
  "secrets",
] as const);

export type RedactionKind = (typeof REDACTION_KINDS)[number];

/**
 * Provider-neutral behaviors a disclosure target may exhibit. Policies
 * disallow behaviors; they never name concrete vendors.
 */
export const PROVIDER_DATA_CAPABILITIES = Object.freeze([
  "data-retention",
  "external-network-tools",
  "model-training",
  "third-party-sharing",
] as const);

export type ProviderDataCapability = (typeof PROVIDER_DATA_CAPABILITIES)[number];

export const APPROVAL_KINDS = Object.freeze(["human-review"] as const);
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export interface DataHandlingPolicy {
  readonly schemaVersion: typeof DATA_HANDLING_POLICY_SCHEMA_VERSION;
  readonly classification: DataClassification;
  readonly cloudProvidersAllowed: boolean;
  readonly localExecutionRequired: boolean;
  readonly redactionsRequiredBeforeDisclosure: readonly RedactionKind[];
  readonly logRetentionAllowed: boolean;
  readonly artifactPersistenceAllowed: boolean;
  readonly humanApprovalRequired: boolean;
  readonly disallowedProviderCapabilities: readonly ProviderDataCapability[];
}

const POLICY_KEYS = [
  "schemaVersion",
  "classification",
  "cloudProvidersAllowed",
  "localExecutionRequired",
  "redactionsRequiredBeforeDisclosure",
  "logRetentionAllowed",
  "artifactPersistenceAllowed",
  "humanApprovalRequired",
  "disallowedProviderCapabilities",
] as const;

/**
 * Classification floors. A policy may always be stricter than its
 * classification requires, but parsing rejects policies that weaken the
 * floor (for example, a `secret` policy that allows cloud disclosure).
 */
export function parseDataHandlingPolicy(
  value: unknown,
  path = "dataHandlingPolicy",
): DataHandlingPolicy {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, POLICY_KEYS, path);
  ensureSchemaVersion(
    record["schemaVersion"],
    `${path}.schemaVersion`,
    DATA_HANDLING_POLICY_SCHEMA_VERSION,
  );

  const classification = parseDataClassification(
    record["classification"],
    `${path}.classification`,
  );
  const cloudProvidersAllowed = ensureBoolean(
    record["cloudProvidersAllowed"],
    `${path}.cloudProvidersAllowed`,
  );
  const localExecutionRequired = ensureBoolean(
    record["localExecutionRequired"],
    `${path}.localExecutionRequired`,
  );
  const redactions = ensureEnumArray(
    record["redactionsRequiredBeforeDisclosure"],
    `${path}.redactionsRequiredBeforeDisclosure`,
    REDACTION_KINDS,
    REDACTION_KINDS.length,
  );

  if (localExecutionRequired && cloudProvidersAllowed) {
    fail(
      `${path}.cloudProvidersAllowed`,
      "policy_conflict",
      "must be false when localExecutionRequired is true.",
    );
  }
  if (classification === "secret" && (cloudProvidersAllowed || !localExecutionRequired)) {
    fail(
      `${path}.classification`,
      "classification_floor",
      "secret-classified content must require local execution and forbid cloud providers.",
    );
  }
  if (classification === "personal" && cloudProvidersAllowed && !redactions.includes("personal-data")) {
    fail(
      `${path}.redactionsRequiredBeforeDisclosure`,
      "classification_floor",
      'must include "personal-data" when personal data may reach a cloud provider.',
    );
  }

  return Object.freeze({
    schemaVersion: DATA_HANDLING_POLICY_SCHEMA_VERSION,
    classification,
    cloudProvidersAllowed,
    localExecutionRequired,
    redactionsRequiredBeforeDisclosure: redactions,
    logRetentionAllowed: ensureBoolean(record["logRetentionAllowed"], `${path}.logRetentionAllowed`),
    artifactPersistenceAllowed: ensureBoolean(
      record["artifactPersistenceAllowed"],
      `${path}.artifactPersistenceAllowed`,
    ),
    humanApprovalRequired: ensureBoolean(
      record["humanApprovalRequired"],
      `${path}.humanApprovalRequired`,
    ),
    disallowedProviderCapabilities: ensureEnumArray(
      record["disallowedProviderCapabilities"],
      `${path}.disallowedProviderCapabilities`,
      PROVIDER_DATA_CAPABILITIES,
      PROVIDER_DATA_CAPABILITIES.length,
    ),
  });
}

export function createDataHandlingPolicy(
  input: Omit<DataHandlingPolicy, "schemaVersion">,
): DataHandlingPolicy {
  return parseDataHandlingPolicy({
    schemaVersion: DATA_HANDLING_POLICY_SCHEMA_VERSION,
    ...input,
  });
}

/** Conservative defaults per classification. */
export function defaultDataHandlingPolicy(
  classification: DataClassification,
): DataHandlingPolicy {
  const parsedClassification = parseDataClassification(classification);
  switch (parsedClassification) {
    case "public":
      return createDataHandlingPolicy({
        classification: parsedClassification,
        cloudProvidersAllowed: true,
        localExecutionRequired: false,
        redactionsRequiredBeforeDisclosure: [],
        logRetentionAllowed: true,
        artifactPersistenceAllowed: true,
        humanApprovalRequired: false,
        disallowedProviderCapabilities: [],
      });
    case "internal":
      return createDataHandlingPolicy({
        classification: parsedClassification,
        cloudProvidersAllowed: true,
        localExecutionRequired: false,
        redactionsRequiredBeforeDisclosure: ["secrets"],
        logRetentionAllowed: true,
        artifactPersistenceAllowed: true,
        humanApprovalRequired: false,
        disallowedProviderCapabilities: ["model-training", "third-party-sharing"],
      });
    case "proprietary-source":
      return createDataHandlingPolicy({
        classification: parsedClassification,
        cloudProvidersAllowed: true,
        localExecutionRequired: false,
        redactionsRequiredBeforeDisclosure: ["secrets"],
        logRetentionAllowed: true,
        artifactPersistenceAllowed: true,
        humanApprovalRequired: false,
        disallowedProviderCapabilities: [
          "data-retention",
          "model-training",
          "third-party-sharing",
        ],
      });
    case "personal":
      return createDataHandlingPolicy({
        classification: parsedClassification,
        cloudProvidersAllowed: false,
        localExecutionRequired: true,
        redactionsRequiredBeforeDisclosure: ["personal-data", "secrets"],
        logRetentionAllowed: false,
        artifactPersistenceAllowed: true,
        humanApprovalRequired: true,
        disallowedProviderCapabilities: [
          "data-retention",
          "external-network-tools",
          "model-training",
          "third-party-sharing",
        ],
      });
    case "secret":
      return createDataHandlingPolicy({
        classification: parsedClassification,
        cloudProvidersAllowed: false,
        localExecutionRequired: true,
        redactionsRequiredBeforeDisclosure: ["personal-data", "proprietary-identifiers", "secrets"],
        logRetentionAllowed: false,
        artifactPersistenceAllowed: false,
        humanApprovalRequired: true,
        disallowedProviderCapabilities: [
          "data-retention",
          "external-network-tools",
          "model-training",
          "third-party-sharing",
        ],
      });
  }
}

export const DISCLOSURE_LOCALITIES = Object.freeze(["local", "cloud"] as const);
export type DisclosureLocality = (typeof DISCLOSURE_LOCALITIES)[number];

/** Provider-neutral description of where content would be disclosed. */
export interface DisclosureTarget {
  readonly locality: DisclosureLocality;
  readonly retainsData: boolean;
  readonly capabilities: readonly ProviderDataCapability[];
}

export function parseDisclosureTarget(value: unknown, path = "disclosureTarget"): DisclosureTarget {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["locality", "retainsData", "capabilities"], path);
  return Object.freeze({
    locality: ensureEnum(record["locality"], `${path}.locality`, DISCLOSURE_LOCALITIES),
    retainsData: ensureBoolean(record["retainsData"], `${path}.retainsData`),
    capabilities: ensureEnumArray(
      record["capabilities"],
      `${path}.capabilities`,
      PROVIDER_DATA_CAPABILITIES,
      PROVIDER_DATA_CAPABILITIES.length,
    ),
  });
}

export interface PolicyReason {
  readonly code: string;
  readonly message: string;
}

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly reasons: readonly PolicyReason[];
  readonly requiredTransformations: readonly RedactionKind[];
  readonly requiredApprovals: readonly ApprovalKind[];
  readonly audit: {
    readonly classification: DataClassification;
    readonly policySchemaVersion: number;
    readonly evaluatedAt: string;
    readonly ruleCodes: readonly string[];
  };
}

export interface PolicyEvaluationContext {
  /** Canonical ISO-8601 UTC timestamp supplied by the caller for audit records. */
  readonly evaluatedAt: string;
}

/**
 * Evaluates whether task content governed by `policy` may be disclosed to
 * `target`. Deterministic: rules fire in a fixed order and every fired rule
 * code is recorded in the audit block.
 */
export function evaluateDisclosure(
  policy: DataHandlingPolicy,
  target: DisclosureTarget,
  context: PolicyEvaluationContext,
): PolicyDecision {
  const parsedPolicy = parseDataHandlingPolicy(policy);
  const parsedTarget = parseDisclosureTarget(target);
  const evaluatedAt = ensureTimestamp(
    ensureRecord(context, "policyEvaluationContext")["evaluatedAt"],
    "policyEvaluationContext.evaluatedAt",
  );

  const reasons: PolicyReason[] = [];
  const ruleCodes: string[] = [];
  const requiredTransformations: RedactionKind[] = [];
  const requiredApprovals: ApprovalKind[] = [];

  if (parsedTarget.locality === "cloud" && !parsedPolicy.cloudProvidersAllowed) {
    ruleCodes.push("CLOUD_DISCLOSURE_FORBIDDEN");
    reasons.push({
      code: "CLOUD_DISCLOSURE_FORBIDDEN",
      message: `Content classified "${parsedPolicy.classification}" may not be sent to a cloud provider.`,
    });
  }

  if (parsedPolicy.localExecutionRequired && parsedTarget.locality !== "local") {
    ruleCodes.push("LOCAL_EXECUTION_REQUIRED");
    reasons.push({
      code: "LOCAL_EXECUTION_REQUIRED",
      message: "This content requires a local-only execution target.",
    });
  }

  if (
    parsedTarget.retainsData &&
    parsedPolicy.disallowedProviderCapabilities.includes("data-retention")
  ) {
    ruleCodes.push("RETENTION_FORBIDDEN");
    reasons.push({
      code: "RETENTION_FORBIDDEN",
      message: "The target retains data, which this policy forbids.",
    });
  }

  const forbiddenCapabilities = parsedTarget.capabilities.filter((capability) =>
    parsedPolicy.disallowedProviderCapabilities.includes(capability),
  );
  if (forbiddenCapabilities.length > 0) {
    ruleCodes.push("CAPABILITY_FORBIDDEN");
    reasons.push({
      code: "CAPABILITY_FORBIDDEN",
      message: `The target exposes forbidden capabilities: ${forbiddenCapabilities.join(", ")}.`,
    });
  }

  if (
    parsedTarget.locality === "cloud" &&
    parsedPolicy.redactionsRequiredBeforeDisclosure.length > 0
  ) {
    ruleCodes.push("REDACTION_REQUIRED");
    requiredTransformations.push(...parsedPolicy.redactionsRequiredBeforeDisclosure);
  }

  if (parsedPolicy.humanApprovalRequired) {
    ruleCodes.push("HUMAN_APPROVAL_REQUIRED");
    requiredApprovals.push("human-review");
  }

  return Object.freeze({
    allowed: reasons.length === 0,
    reasons: Object.freeze(reasons.map((reason) => Object.freeze(reason))),
    requiredTransformations: Object.freeze(requiredTransformations),
    requiredApprovals: Object.freeze(requiredApprovals),
    audit: Object.freeze({
      classification: parsedPolicy.classification,
      policySchemaVersion: parsedPolicy.schemaVersion,
      evaluatedAt,
      ruleCodes: Object.freeze(ruleCodes),
    }),
  });
}

export interface ProviderEligibility {
  readonly eligible: boolean;
  readonly decision: PolicyDecision;
}

/** Answers "may this provider-shaped target be used at all for this policy?". */
export function evaluateProviderEligibility(
  policy: DataHandlingPolicy,
  target: DisclosureTarget,
  context: PolicyEvaluationContext,
): ProviderEligibility {
  const decision = evaluateDisclosure(policy, target, context);
  return Object.freeze({ eligible: decision.allowed, decision });
}

/** Throws PolicyViolationError when disclosure is denied. */
export function assertDisclosureAllowed(
  policy: DataHandlingPolicy,
  target: DisclosureTarget,
  context: PolicyEvaluationContext,
): PolicyDecision {
  const decision = evaluateDisclosure(policy, target, context);
  if (!decision.allowed) {
    throw new PolicyViolationError(
      "Disclosure denied by data handling policy.",
      decision.reasons.map((reason) => reason.code),
    );
  }
  return decision;
}

export function mayUseCloudProvider(policy: DataHandlingPolicy): boolean {
  return parseDataHandlingPolicy(policy).cloudProvidersAllowed;
}

export function requiresLocalModel(policy: DataHandlingPolicy): boolean {
  return parseDataHandlingPolicy(policy).localExecutionRequired;
}

export function requiredRedactions(policy: DataHandlingPolicy): readonly RedactionKind[] {
  return parseDataHandlingPolicy(policy).redactionsRequiredBeforeDisclosure;
}

export function mayRetainLogs(policy: DataHandlingPolicy): boolean {
  return parseDataHandlingPolicy(policy).logRetentionAllowed;
}

export function mayPersistArtifacts(policy: DataHandlingPolicy): boolean {
  return parseDataHandlingPolicy(policy).artifactPersistenceAllowed;
}

export function requiresHumanApproval(policy: DataHandlingPolicy): boolean {
  return parseDataHandlingPolicy(policy).humanApprovalRequired;
}

export function disallowedProviderCapabilities(
  policy: DataHandlingPolicy,
): readonly ProviderDataCapability[] {
  return parseDataHandlingPolicy(policy).disallowedProviderCapabilities;
}
