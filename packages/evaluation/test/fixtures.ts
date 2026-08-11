import {
  EVALUATION_SCHEMA_VERSION,
  createEvaluationAuthorityConfiguration,
  createEvaluationRequest,
  createEvaluationSubject,
  evaluationCriterionManifestDigest,
  evaluationDigest,
  type EvaluationCriterion,
  type EvaluationEvidence,
  type EvaluationKind,
  type EvaluationRequest,
} from "../src/index.js";

export const T0 = "2026-08-11T03:40:00.000Z";
export const T1 = "2026-08-11T03:41:00.000Z";
export const T2 = "2026-08-11T04:40:00.000Z";
export const DEADLINE = "2026-08-11T05:20:00.000Z";
export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const DIGEST_A = "a".repeat(64);

export const subject = createEvaluationSubject({
  repositoryId: "repository:fixture",
  headSha: SHA_A,
  treeSha: SHA_B,
  productSpecificationId: "specification:1",
  productSpecificationDigest: DIGEST_A,
  requirementIds: ["requirement:1"],
  taskIds: ["task:1"],
  resultIds: ["result:1"],
  coverageEdges: [{ requirementId: "requirement:1", taskId: "task:1", resultId: "result:1" }],
});

const kinds = [
  "output-schema",
  "changed-paths",
  "compilation",
  "tests",
  "static-analysis",
  "acceptance-criteria",
  "requirement-coverage",
  "repository-state",
] as const;

function coverageEdges(): readonly Record<string, string>[] {
  return [{ requirementId: "requirement:1", taskId: "task:1", resultId: "result:1" }];
}

function evidenceContractDigest(kind: EvaluationKind): string {
  switch (kind) {
    case "output-schema":
    case "compilation":
    case "tests":
    case "static-analysis":
    case "acceptance-criteria":
      return DIGEST_A;
    case "changed-paths":
      return evaluationDigest(["packages/example/src/index.ts"]);
    case "requirement-coverage":
      return evaluationDigest(coverageEdges());
    case "repository-state":
      return evaluationDigest({ headSha: SHA_A, treeSha: SHA_B });
  }
}

export const criteria: readonly EvaluationCriterion[] = Object.freeze(kinds.map((kind, index) => Object.freeze({
  criterionId: `criterion:${index + 1}`,
  kind,
  criticality: index === 7 ? "expected-quality" as const : "required" as const,
  requirementId: kind === "acceptance-criteria" || kind === "requirement-coverage" ? "requirement:1" : null,
  description: `Deterministically validate ${kind}.`,
  evaluatorId: `evaluator:${kind}`,
  evaluatorVersion: "1.0.0",
  configurationDigest: evaluationDigest({ kind, version: 1 }),
  evidenceContractDigest: evidenceContractDigest(kind),
  expectedArtifactDigests: [DIGEST_A],
})));

function evidenceData(kind: EvaluationKind): Record<string, unknown> {
  switch (kind) {
    case "output-schema": return { parsed: true, schemaDigest: DIGEST_A, violationCount: 0 };
    case "changed-paths": return { changedPaths: ["packages/example/src/index.ts"], allowedPaths: ["packages/example/src/index.ts"] };
    case "compilation": return { exitCode: 0, commandDigest: DIGEST_A };
    case "tests": return { passed: 10, failed: 0, skipped: 1, expectedSkips: 1, suiteDigest: DIGEST_A };
    case "static-analysis": return { blockingFindings: 0, totalFindings: 2, reportDigest: DIGEST_A };
    case "acceptance-criteria": return { satisfied: true, requirementDigest: DIGEST_A };
    case "requirement-coverage": return {
      requirementIds: ["requirement:1"],
      taskIds: ["task:1"],
      resultIds: ["result:1"],
      coverageEdges: coverageEdges(),
    };
    case "repository-state": return { headSha: SHA_A, treeSha: SHA_B };
  }
}

export function evidenceFor(criterion: EvaluationCriterion, overrides: Record<string, unknown> = {}): EvaluationEvidence {
  const base = {
    evidenceId: `evidence:${criterion.criterionId}`,
    criterionId: criterion.criterionId,
    kind: criterion.kind,
    evaluatorId: criterion.evaluatorId,
    evaluatorVersion: criterion.evaluatorVersion,
    configurationDigest: criterion.configurationDigest,
    subjectDigest: subject.subjectDigest,
    repositoryId: subject.repositoryId,
    headSha: subject.headSha,
    treeSha: subject.treeSha,
    inputDigest: evaluationDigest({
      subjectDigest: subject.subjectDigest,
      criterionId: criterion.criterionId,
      kind: criterion.kind,
      evaluatorId: criterion.evaluatorId,
      evaluatorVersion: criterion.evaluatorVersion,
      configurationDigest: criterion.configurationDigest,
      evidenceContractDigest: criterion.evidenceContractDigest,
      expectedArtifactDigests: criterion.expectedArtifactDigests,
    }),
    artifactDigests: [DIGEST_A],
    observedAt: T0,
    validUntil: DEADLINE,
    data: evidenceData(criterion.kind),
  };
  return { ...base, ...overrides } as EvaluationEvidence;
}

export function authorityConfigurationFor(
  configuredCriteria: readonly EvaluationCriterion[],
  configuredEvidence: readonly EvaluationEvidence[],
  authorizedWaiverDigests: readonly string[] = [],
) {
  return createEvaluationAuthorityConfiguration({
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    configurationId: "evaluation-authority:fixture",
    authorizedCriterionManifestDigests: [
      evaluationCriterionManifestDigest(subject.subjectDigest, configuredCriteria),
    ],
    authorizedEvidenceDigests: configuredEvidence.map((item) => evaluationDigest(item)),
    authorizedWaiverDigests,
  });
}

export const authorityConfiguration = authorityConfigurationFor(
  criteria,
  criteria.map((criterion) => evidenceFor(criterion)),
);

export function requestInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    runId: "evaluation:fixture",
    subject,
    criteria,
    evidence: criteria.map((criterion) => evidenceFor(criterion)),
    waivers: [],
    advisories: [],
    createdAt: T0,
    deadline: DEADLINE,
    maximumAttempts: 2,
    ...overrides,
  };
}

export function request(overrides: Record<string, unknown> = {}): EvaluationRequest {
  return createEvaluationRequest(requestInput(overrides));
}
