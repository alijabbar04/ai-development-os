import type {
  IntegrationAuthorityConfiguration,
  IntegrationGitPort,
  IntegrationPreflightResult,
  IntegrationReceipt,
  IntegrationRecoveryState,
  IntegrationRequest,
  IntegrationValidationInput,
  IntegrationValidationPort,
  IntegrationValidationResult,
} from "../src/index.js";
import {
  INTEGRATION_SCHEMA_VERSION,
  integrationDigest,
  stableIntegrationId,
} from "../src/index.js";

export const T0 = "2026-08-11T09:00:00.000Z";
export const T1 = "2026-08-11T09:01:00.000Z";
export const T2 = "2026-08-11T09:02:00.000Z";
export const T3 = "2026-08-11T09:03:00.000Z";
export const T4 = "2026-08-11T09:04:00.000Z";
export const DEADLINE = "2026-08-11T10:00:00.000Z";
export const TEST_CLOCK = Object.freeze({ now: () => new Date(T4) });
export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const SHA_C = "c".repeat(40);
export const SHA_D = "d".repeat(40);
export const DIGEST_A = "1".repeat(64);
export const DIGEST_B = "2".repeat(64);
export const DIGEST_C = "3".repeat(64);
export const DIGEST_D = "4".repeat(64);
export const TEST_GIT_ROUTE_FINGERPRINT = integrationDigest({ portId: "git:test", schemaVersion: 1, route: "fixture-v1" });
export const TEST_GIT_TARGET_FINGERPRINT = integrationDigest({ portId: "git:test", schemaVersion: 1, target: "fixture-repository" });
export const TEST_VALIDATION_ROUTE_FINGERPRINT = integrationDigest({ portId: "validation:test", schemaVersion: 1, route: "fixture-v1" });

function withDigest<T extends Record<string, unknown>, K extends string>(value: T, key: K): T & Record<K, string> {
  return Object.freeze({ ...value, [key]: integrationDigest(value) }) as T & Record<K, string>;
}

export function requestInput(overrides: Readonly<Record<string, unknown>> = {}): IntegrationRequest {
  const admission = withDigest({
    evaluationRunId: "evaluation:stage19a",
    evaluationRequestDigest: DIGEST_A,
    evaluationResultDigest: DIGEST_B,
    evaluationSubjectDigest: DIGEST_C,
    evaluationDecision: "accepted" as const,
    authorityConfigurationFingerprint: DIGEST_D,
    criterionManifestDigest: "5".repeat(64),
    deterministicEvidenceDigest: "6".repeat(64),
    productSpecificationId: "specification:1",
    productSpecificationDigest: "7".repeat(64),
    requirementIds: Object.freeze(["requirement:1"]),
    requirementCoverageDigest: "8".repeat(64),
    waiverDigests: Object.freeze([]),
    dissentDigest: "9".repeat(64),
    securityFindingsDigest: "a".repeat(64),
    feasibilityFindingsDigest: "b".repeat(64),
  }, "admissionDigest");
  const validationPlan = withDigest({
    planId: "validation-plan:1",
    validatorId: "validation:test",
    validatorSchemaVersion: 1 as const,
    routeFingerprint: TEST_VALIDATION_ROUTE_FINGERPRINT,
    configurationDigest: "c".repeat(64),
    commandIds: Object.freeze(["check:root"]),
    requiredCriterionIds: Object.freeze(["criterion:1"]),
    thresholdDigest: "d".repeat(64),
    allowSkips: false as const,
  }, "planDigest");
  const candidateArtifact = withDigest({
    taskId: "task:integration-candidate",
    taskResultDigest: "f".repeat(64),
    artifactId: "artifact:integration-candidate",
    artifactDigest: "0".repeat(64),
    manifestId: "manifest:integration-candidate",
    manifestDigest: "1".repeat(64),
  }, "bindingDigest");
  const base = {
    schemaVersion: INTEGRATION_SCHEMA_VERSION,
    runId: "integration:1",
    repository: Object.freeze({
      repositoryId: "repository:fixture",
      objectFormat: "sha1" as const,
      targetRef: "refs/heads/integration-target",
      expectedTargetCommit: SHA_A,
      expectedTargetTree: SHA_B,
      sourceCommit: SHA_C,
      sourceTree: SHA_D,
      expectedIntegratedCommit: SHA_C,
      expectedIntegratedTree: SHA_D,
      expectedParents: Object.freeze([]),
      mergeCommitTimestamp: null,
    }),
    gitPortId: "git:test",
    gitPortSchemaVersion: 1 as const,
    gitRouteFingerprint: TEST_GIT_ROUTE_FINGERPRINT,
    gitTargetFingerprint: TEST_GIT_TARGET_FINGERPRINT,
    strategy: "fast-forward" as const,
    allowedPaths: Object.freeze(["packages/example/src/index.ts"]),
    candidateArtifact,
    admission,
    validationPlan,
    resolutionProposal: null,
    resolutionAuthorization: null,
    authorityDigest: "e".repeat(64),
    idempotencyKey: "integration-request:1",
    retryPolicy: Object.freeze({
      maximumAttempts: 3,
      retryableFailureCodes: Object.freeze(["preflight-boundary-failed"]),
      automaticRetryBeforeEffectOnly: true as const,
    }),
    bounds: Object.freeze({
      maximumPaths: 64,
      maximumFiles: 10_000,
      maximumBytes: 100_000_000,
      maximumConflicts: 64,
      maximumWallTimeMs: 30_000,
      maximumWorktrees: 1 as const,
    }),
    createdAt: T0,
    deadline: DEADLINE,
    ...overrides,
  };
  return Object.freeze({ ...base, requestDigest: integrationDigest(base) }) as IntegrationRequest;
}

export function authorityFor(request: IntegrationRequest, ...additional: readonly IntegrationRequest[]): IntegrationAuthorityConfiguration {
  const requests = [request, ...additional];
  const base = {
    schemaVersion: INTEGRATION_SCHEMA_VERSION,
    configurationId: "integration-authority:test",
    authorizedRequestDigests: Object.freeze([...new Set(requests.map((item) => item.requestDigest))].sort()),
    authorizedAuthorityDigests: Object.freeze([...new Set(requests.map((item) => item.authorityDigest))].sort()),
    authorizedAdmissionDigests: Object.freeze([...new Set(requests.map((item) => item.admission.admissionDigest))].sort()),
    authorizedResolutionDigests: Object.freeze([]),
  };
  return Object.freeze({ ...base, configurationFingerprint: integrationDigest(base) });
}

export function validationResult(input: IntegrationValidationInput, at = T2): IntegrationValidationResult {
  const base = {
    schemaVersion: INTEGRATION_SCHEMA_VERSION,
    resultId: stableIntegrationId("validation-result", input.request.runId, input.phase, at),
    validatorId: input.plan.validatorId,
    validatorSchemaVersion: input.plan.validatorSchemaVersion,
    phase: input.phase,
    planId: input.plan.planId,
    configurationDigest: input.plan.configurationDigest,
    headCommit: input.headCommit,
    treeId: input.treeId,
    passed: true,
    executedCommandIds: input.plan.commandIds,
    commandResultDigests: Object.freeze([DIGEST_A]),
    evaluatedCriterionIds: input.plan.requiredCriterionIds,
    criterionResultDigests: Object.freeze([DIGEST_B]),
    thresholdDigest: input.plan.thresholdDigest,
    coverageDigest: input.request.admission.requirementCoverageDigest,
    conflicts: Object.freeze([]),
    failedRuleCodes: Object.freeze([]),
    skippedCount: 0,
    evaluatedAt: at,
  };
  return Object.freeze({ ...base, resultDigest: integrationDigest(base) });
}

export function preflightResult(request: IntegrationRequest, at = T2): IntegrationPreflightResult {
  const base = {
    schemaVersion: INTEGRATION_SCHEMA_VERSION,
    preflightId: stableIntegrationId("integration-preflight", request.runId, request.requestDigest, at),
    requestDigest: request.requestDigest,
    repositoryId: request.repository.repositoryId,
    targetRef: request.repository.targetRef,
    targetCommit: request.repository.expectedTargetCommit,
    targetTree: request.repository.expectedTargetTree,
    sourceCommit: request.repository.sourceCommit,
    sourceTree: request.repository.sourceTree,
    clean: true,
    changedPaths: request.allowedPaths,
    fileCount: 2,
    totalBytes: 100,
    conflicts: Object.freeze([]),
    checkedAt: at,
  };
  return Object.freeze({ ...base, preflightDigest: integrationDigest(base) });
}

export function fakePorts(request: IntegrationRequest): {
  readonly git: IntegrationGitPort;
  readonly validation: IntegrationValidationPort;
  readonly counts: { preflight: number; integrate: number; reconcile: number; cleanup: number; validate: number };
} {
  const counts = { preflight: 0, integrate: 0, reconcile: 0, cleanup: 0, validate: 0 };
  let receipt: IntegrationReceipt | null = null;
  const validation: IntegrationValidationPort = Object.freeze({
    portId: "validation:test",
    schemaVersion: 1,
    routeFingerprint: request.validationPlan.routeFingerprint,
    async validate(input) {
      counts.validate += 1;
      return validationResult(input, input.phase === "pre-integration" ? T2 : T4);
    },
  });
  const git: IntegrationGitPort = Object.freeze({
    portId: "git:test",
    schemaVersion: 1,
    routeFingerprint: request.gitRouteFingerprint,
    targetFingerprint: request.gitTargetFingerprint,
    async preflight(candidate) {
      counts.preflight += 1;
      return preflightResult(candidate);
    },
    async integrate(intent, candidate) {
      counts.integrate += 1;
      const base = {
        schemaVersion: INTEGRATION_SCHEMA_VERSION,
        receiptId: stableIntegrationId("integration-receipt", intent.intentDigest, candidate.repository.expectedIntegratedCommit),
        intentDigest: intent.intentDigest,
        repositoryId: candidate.repository.repositoryId,
        targetRef: candidate.repository.targetRef,
        previousTargetCommit: candidate.repository.expectedTargetCommit,
        integratedCommit: candidate.repository.expectedIntegratedCommit,
        integratedTree: candidate.repository.expectedIntegratedTree,
        parents: candidate.repository.expectedParents,
        strategy: candidate.strategy,
        refUpdated: true as const,
        worktreeId: stableIntegrationId("integration-worktree", intent.intentId),
        changedPaths: candidate.allowedPaths,
        artifactDigest: candidate.candidateArtifact.artifactDigest,
        timingBasis: "observed" as const,
        committedAt: T4,
      };
      receipt = Object.freeze({ ...base, receiptDigest: integrationDigest(base) });
      return receipt;
    },
    async reconcile(intent, candidate, persistedReceipt) {
      counts.reconcile += 1;
      const recoveredReceipt = persistedReceipt ?? (receipt === null ? null : (() => {
        const projection = { ...receipt, timingBasis: "recovered-observation" as const, committedAt: T4 } as Record<string, unknown>;
        delete projection["receiptDigest"];
        return Object.freeze({ ...projection, receiptDigest: integrationDigest(projection) }) as unknown as IntegrationReceipt;
      })());
      const base = {
        state: recoveredReceipt === null ? "no-effect" as const : "ref-published" as const,
        effectGuardState: recoveredReceipt === null ? "revoked" as const : "absent" as const,
        intentDigest: intent.intentDigest,
        observedTargetCommit: recoveredReceipt?.integratedCommit ?? candidate.repository.expectedTargetCommit,
        observedTargetTree: recoveredReceipt?.integratedTree ?? candidate.repository.expectedTargetTree,
        receipt: recoveredReceipt,
        observedAt: T4,
      };
      return Object.freeze({ ...base, recoveryDigest: integrationDigest(base) }) as IntegrationRecoveryState;
    },
    async cleanup(worktreeId) {
      counts.cleanup += 1;
      return Object.freeze({ worktreeId, cleaned: true, preservedEvidence: true, failureCode: null, observedAt: T4 });
    },
  });
  void request;
  return Object.freeze({ git, validation, counts });
}

export function command(
  runId: string,
  commandId: string,
  expectedVersion: number,
  kind: "claim" | "fenced" | "cancel",
  at: string,
  fence = 1,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    runId,
    commandId,
    expectedVersion,
    owner: kind === "cancel" ? null : "worker:1",
    leaseId: kind === "cancel" ? null : "lease:1",
    fencingToken: kind === "fenced" ? fence : null,
    leaseExpiresAt: kind === "claim" ? "2026-08-11T09:30:00.000Z" : null,
    reasonCode: kind === "cancel" ? "operator-cancelled" : null,
    occurredAt: at,
  });
}
