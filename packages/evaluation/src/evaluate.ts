import { validation } from "@ai-dev-os/domain";
import {
  CRITERION_OUTCOMES,
  EVALUATION_CRITICALITIES,
  EVALUATION_KINDS,
  EVALUATION_SCHEMA_VERSION,
  type CompletenessAudit,
  type CompletenessFinding,
  type CriterionEvaluation,
  type CriterionOutcome,
  type EvaluationAuthorityConfiguration,
  type EvaluationCriterion,
  type EvaluationDisagreement,
  type EvaluationEvidence,
  type EvaluationRequest,
  type EvaluationResult,
} from "./contracts.js";
import { EvaluationError } from "./errors.js";
import {
  assertEvaluationInputBudget,
  compareEvaluationText,
  EMPTY_EVALUATION_AUTHORITY_CONFIGURATION,
  evaluationCriterionManifestDigest,
  evaluationDigest,
  evaluationWaiverDigest,
  parseEvaluationAuthorityConfiguration,
  parseEvaluationDigest,
  parseEvaluationId,
  parseEvaluationRequest,
  stableEvaluationId,
} from "./schema.js";

const {
  ensureArray,
  ensureEnum,
  ensureExactKeys,
  ensureRecord,
  ensureSchemaVersion,
  ensureTimestamp,
} = validation;

const EVALUATION_RULE_CODES = Object.freeze([
  "ARTIFACT_PROVENANCE_MISMATCH",
  "AUTHORIZED_WAIVER_APPLIED",
  "CONFIGURATION_MISMATCH",
  "DETERMINISTIC_CHECK_FAILED",
  "DETERMINISTIC_CHECK_PASSED",
  "EVALUATOR_PROVENANCE_MISMATCH",
  "EVIDENCE_CONTRACT_MISMATCH",
  "EVIDENCE_INSTANCE_UNAUTHORIZED",
  "EVIDENCE_EXPIRED",
  "EVIDENCE_FROM_FUTURE",
  "EVIDENCE_INVALID",
  "EVIDENCE_KIND_MISMATCH",
  "EVIDENCE_MISSING",
  "INPUT_DIGEST_MISMATCH",
  "REPOSITORY_MISMATCH",
  "REVISION_MISMATCH",
  "SUBJECT_MISMATCH",
  "UNVERIFIED_WAIVER_IGNORED",
] as const);

export function expectedEvidenceInputDigest(
  request: EvaluationRequest,
  criterion: EvaluationCriterion,
): string {
  return evaluationDigest({
    subjectDigest: request.subject.subjectDigest,
    criterionId: criterion.criterionId,
    kind: criterion.kind,
    evaluatorId: criterion.evaluatorId,
    evaluatorVersion: criterion.evaluatorVersion,
    configurationDigest: criterion.configurationDigest,
    evidenceContractDigest: criterion.evidenceContractDigest,
    expectedArtifactDigests: criterion.expectedArtifactDigests,
  });
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function coverageEdges(value: unknown): readonly { readonly requirementId: string; readonly taskId: string; readonly resultId: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const edge = item as Record<string, unknown>;
    return typeof edge["requirementId"] === "string" && typeof edge["taskId"] === "string" && typeof edge["resultId"] === "string"
      ? [{ requirementId: edge["requirementId"], taskId: edge["taskId"], resultId: edge["resultId"] }]
      : [];
  });
}

function actualEvidenceContractDigest(evidence: EvaluationEvidence): string {
  const data = evidence.data;
  switch (evidence.kind) {
    case "output-schema": return String(data["schemaDigest"]);
    case "changed-paths": return evaluationDigest(data["allowedPaths"]);
    case "compilation": return String(data["commandDigest"]);
    case "tests": return String(data["suiteDigest"]);
    case "static-analysis": return String(data["reportDigest"]);
    case "acceptance-criteria": return String(data["requirementDigest"]);
    case "requirement-coverage": return evaluationDigest(data["coverageEdges"]);
    case "repository-state": return evaluationDigest({ headSha: data["headSha"], treeSha: data["treeSha"] });
  }
}

function evidenceDataPasses(
  evidence: EvaluationEvidence,
  criterion: EvaluationCriterion,
  request: EvaluationRequest,
): boolean {
  const data = evidence.data;
  switch (criterion.kind) {
    case "output-schema":
      return data["parsed"] === true && data["violationCount"] === 0;
    case "changed-paths": {
      const changed = stringArray(data["changedPaths"]);
      const allowed = new Set(stringArray(data["allowedPaths"]));
      return changed.every((path) => allowed.has(path));
    }
    case "compilation":
      return data["exitCode"] === 0;
    case "tests":
      return data["failed"] === 0 && data["skipped"] === data["expectedSkips"];
    case "static-analysis":
      return typeof data["totalFindings"] === "number" &&
        typeof data["blockingFindings"] === "number" &&
        data["blockingFindings"] === 0 &&
        data["totalFindings"] >= data["blockingFindings"];
    case "acceptance-criteria":
      return data["satisfied"] === true;
    case "requirement-coverage": {
      const actual = coverageEdges(data["coverageEdges"]);
      const expected = criterion.requirementId === null
        ? request.subject.coverageEdges
        : request.subject.coverageEdges.filter((edge) => edge.requirementId === criterion.requirementId);
      return expected.length > 0 && JSON.stringify(actual) === JSON.stringify(expected);
    }
    case "repository-state":
      return data["headSha"] === request.subject.headSha && data["treeSha"] === request.subject.treeSha;
  }
}

function evidenceRuleCodes(
  evidence: EvaluationEvidence,
  criterion: EvaluationCriterion,
  request: EvaluationRequest,
  evaluatedAt: string,
  authorityConfiguration: EvaluationAuthorityConfiguration,
): readonly string[] {
  const codes: string[] = [];
  if (evidence.kind !== criterion.kind) codes.push("EVIDENCE_KIND_MISMATCH");
  if (evidence.evaluatorId !== criterion.evaluatorId || evidence.evaluatorVersion !== criterion.evaluatorVersion) codes.push("EVALUATOR_PROVENANCE_MISMATCH");
  if (evidence.configurationDigest !== criterion.configurationDigest) codes.push("CONFIGURATION_MISMATCH");
  if (actualEvidenceContractDigest(evidence) !== criterion.evidenceContractDigest) codes.push("EVIDENCE_CONTRACT_MISMATCH");
  if (JSON.stringify(evidence.artifactDigests) !== JSON.stringify(criterion.expectedArtifactDigests)) codes.push("ARTIFACT_PROVENANCE_MISMATCH");
  if (evidence.subjectDigest !== request.subject.subjectDigest) codes.push("SUBJECT_MISMATCH");
  if (evidence.repositoryId !== request.subject.repositoryId) codes.push("REPOSITORY_MISMATCH");
  if (evidence.headSha !== request.subject.headSha || evidence.treeSha !== request.subject.treeSha) codes.push("REVISION_MISMATCH");
  if (evidence.inputDigest !== expectedEvidenceInputDigest(request, criterion)) codes.push("INPUT_DIGEST_MISMATCH");
  if (!authorityConfiguration.authorizedEvidenceDigests.includes(evaluationDigest(evidence))) codes.push("EVIDENCE_INSTANCE_UNAUTHORIZED");
  if (evidence.observedAt > evaluatedAt) codes.push("EVIDENCE_FROM_FUTURE");
  if (evidence.validUntil < evaluatedAt) codes.push("EVIDENCE_EXPIRED");
  return Object.freeze(codes.sort(compareEvaluationText));
}

function evaluateCriterion(
  request: EvaluationRequest,
  criterion: EvaluationCriterion,
  evaluatedAt: string,
  authorityConfiguration: EvaluationAuthorityConfiguration,
): CriterionEvaluation {
  const evidence = request.evidence.filter((item) => item.criterionId === criterion.criterionId);
  const integrityCodes = new Set<string>();
  const structurallyValid: EvaluationEvidence[] = [];
  for (const item of evidence) {
    const codes = evidenceRuleCodes(item, criterion, request, evaluatedAt, authorityConfiguration);
    codes.forEach((code) => integrityCodes.add(code));
    if (codes.length === 0) structurallyValid.push(item);
  }
  let outcome: CriterionOutcome;
  const dataFailed = structurallyValid.some((item) => !evidenceDataPasses(item, criterion, request));
  if (dataFailed) {
    outcome = "failed";
    integrityCodes.add("DETERMINISTIC_CHECK_FAILED");
  } else if (structurallyValid.length > 0) {
    outcome = "passed";
    integrityCodes.add("DETERMINISTIC_CHECK_PASSED");
  } else {
    outcome = "missing";
    integrityCodes.add(evidence.length === 0 ? "EVIDENCE_MISSING" : "EVIDENCE_INVALID");
  }

  const eligibleWaivers = request.waivers.filter((item) =>
    item.criterionId === criterion.criterionId &&
    item.subjectDigest === request.subject.subjectDigest &&
    item.configurationDigest === criterion.configurationDigest &&
    item.approvedAt <= evaluatedAt &&
    item.expiresAt >= evaluatedAt,
  );
  const authorizedWaiverDigests = new Set(authorityConfiguration.authorizedWaiverDigests);
  const waiver = eligibleWaivers.find((item) => authorizedWaiverDigests.has(evaluationWaiverDigest(item)));
  if (outcome !== "passed" && waiver !== undefined) {
    outcome = "waived";
    integrityCodes.add("AUTHORIZED_WAIVER_APPLIED");
  } else if (outcome !== "passed" && eligibleWaivers.length > 0) {
    integrityCodes.add("UNVERIFIED_WAIVER_IGNORED");
  }

  return Object.freeze({
    criterionId: criterion.criterionId,
    kind: criterion.kind,
    criticality: criterion.criticality,
    outcome,
    evidenceIds: Object.freeze(evidence.map((item) => item.evidenceId).sort(compareEvaluationText)),
    waiverId: outcome === "waived" ? waiver!.waiverId : null,
    ruleCodes: Object.freeze([...integrityCodes].sort(compareEvaluationText)),
  });
}

export function evaluateDeterministically(
  requestValue: unknown,
  evaluatedAtValue: unknown,
  authorityConfigurationValue: unknown = EMPTY_EVALUATION_AUTHORITY_CONFIGURATION,
): EvaluationResult {
  const request = parseEvaluationRequest(requestValue);
  const evaluatedAt = ensureTimestamp(evaluatedAtValue, "evaluatedAt");
  const authorityConfiguration = parseEvaluationAuthorityConfiguration(authorityConfigurationValue);
  if (evaluatedAt < request.createdAt) {
    throw new EvaluationError("INVALID_INPUT", "Evaluation cannot precede request creation.");
  }
  if (evaluatedAt > request.deadline) {
    throw new EvaluationError("INVALID_TRANSITION", "Evaluation deadline has expired.", { runId: request.runId });
  }
  const criteria = Object.freeze(request.criteria.map((criterion) =>
    evaluateCriterion(request, criterion, evaluatedAt, authorityConfiguration),
  ));
  const blockingCriterionIds = Object.freeze(criteria
    .filter((item) =>
      (item.criticality === "required" || item.criticality === "expected-quality") &&
      (item.outcome === "failed" || item.outcome === "missing"),
    )
    .map((item) => item.criterionId)
    .sort(compareEvaluationText));
  const criterionManifestDigest = evaluationCriterionManifestDigest(
    request.subject.subjectDigest,
    request.criteria,
  );
  const requestRuleCodes = authorityConfiguration.authorizedCriterionManifestDigests.includes(
    criterionManifestDigest,
  )
    ? Object.freeze([] as string[])
    : Object.freeze(["CRITERION_MANIFEST_UNAUTHORIZED"]);
  const byCriterion = new Map(criteria.map((item) => [item.criterionId, item]));
  const disagreements: EvaluationDisagreement[] = [];
  for (const advisory of request.advisories) {
    if (advisory.observedAt > evaluatedAt) continue;
    const deterministic = byCriterion.get(advisory.criterionId)!;
    const recommendation = deterministic.outcome === "passed" || deterministic.outcome === "waived" ? "pass" : "fail";
    if (advisory.recommendation !== recommendation) {
      disagreements.push(Object.freeze({
        disagreementId: stableEvaluationId("evaluation-disagreement", request.runId, advisory.advisoryId, deterministic.outcome),
        criterionId: deterministic.criterionId,
        advisoryId: advisory.advisoryId,
        deterministicOutcome: deterministic.outcome,
        advisoryRecommendation: advisory.recommendation,
      }));
    }
  }
  disagreements.sort((a, b) => compareEvaluationText(a.disagreementId, b.disagreementId));
  const body = Object.freeze({
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    runId: request.runId,
    subjectDigest: request.subject.subjectDigest,
    requestDigest: request.requestDigest,
    authorityConfigurationFingerprint: authorityConfiguration.configurationFingerprint,
    criterionManifestDigest,
    requestRuleCodes,
    decision: blockingCriterionIds.length === 0 && requestRuleCodes.length === 0
      ? "accepted" as const
      : "rejected" as const,
    criteria,
    disagreements: Object.freeze(disagreements),
    blockingCriterionIds,
    evaluatedAt,
  });
  return Object.freeze({ ...body, resultDigest: evaluationDigest(body) });
}

function parseCriterionEvaluation(value: unknown, path: string): CriterionEvaluation {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["criterionId", "kind", "criticality", "outcome", "evidenceIds", "waiverId", "ruleCodes"], path);
  const evidenceIds = ensureArray(record["evidenceIds"], `${path}.evidenceIds`, 1_024).map((item, index) => parseEvaluationId(item, `${path}.evidenceIds[${index}]`));
  const ruleCodes = ensureArray(record["ruleCodes"], `${path}.ruleCodes`, 64).map((item, index) => ensureEnum(
    item,
    `${path}.ruleCodes[${index}]`,
    EVALUATION_RULE_CODES,
  ));
  if (new Set(evidenceIds).size !== evidenceIds.length ||
      new Set(ruleCodes).size !== ruleCodes.length ||
      JSON.stringify(evidenceIds) !== JSON.stringify([...evidenceIds].sort(compareEvaluationText)) ||
      JSON.stringify(ruleCodes) !== JSON.stringify([...ruleCodes].sort(compareEvaluationText))) {
    throw new EvaluationError("INVALID_INPUT", "Criterion evaluation collections must be unique and canonically ordered.");
  }
  const outcome = ensureEnum(record["outcome"], `${path}.outcome`, CRITERION_OUTCOMES);
  const waiverId = record["waiverId"] === null
    ? null
    : parseEvaluationId(record["waiverId"], `${path}.waiverId`);
  const passedMarker = ruleCodes.includes("DETERMINISTIC_CHECK_PASSED");
  const failedMarker = ruleCodes.includes("DETERMINISTIC_CHECK_FAILED");
  const missingMarkerCount = Number(ruleCodes.includes("EVIDENCE_MISSING")) +
    Number(ruleCodes.includes("EVIDENCE_INVALID"));
  const waiverMarker = ruleCodes.includes("AUTHORIZED_WAIVER_APPLIED");
  const markersMatch = outcome === "passed"
    ? passedMarker && !failedMarker && missingMarkerCount === 0 && !waiverMarker
    : outcome === "failed"
      ? !passedMarker && failedMarker && missingMarkerCount === 0 && !waiverMarker
      : outcome === "missing"
        ? !passedMarker && !failedMarker && missingMarkerCount === 1 && !waiverMarker
        : !passedMarker && waiverMarker && Number(failedMarker) + missingMarkerCount === 1;
  if ((outcome === "waived") !== (waiverId !== null) || !markersMatch) {
    throw new EvaluationError("INVALID_INPUT", "Criterion outcome, waiver, and rule projections are inconsistent.");
  }
  return Object.freeze({
    criterionId: parseEvaluationId(record["criterionId"], `${path}.criterionId`),
    kind: ensureEnum(record["kind"], `${path}.kind`, EVALUATION_KINDS),
    criticality: ensureEnum(record["criticality"], `${path}.criticality`, EVALUATION_CRITICALITIES),
    outcome,
    evidenceIds: Object.freeze(evidenceIds),
    waiverId,
    ruleCodes: Object.freeze(ruleCodes),
  });
}

export function parseEvaluationResult(value: unknown, path = "evaluationResult"): EvaluationResult {
  assertEvaluationInputBudget(value);
  const record = ensureRecord(value, path);
  ensureExactKeys(record, [
    "schemaVersion", "runId", "subjectDigest", "requestDigest", "authorityConfigurationFingerprint",
    "criterionManifestDigest", "requestRuleCodes", "decision", "criteria", "disagreements",
    "blockingCriterionIds", "evaluatedAt", "resultDigest",
  ], path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, EVALUATION_SCHEMA_VERSION);
  const runId = parseEvaluationId(record["runId"], `${path}.runId`);
  const criteria = Object.freeze(ensureArray(record["criteria"], `${path}.criteria`, 256).map((item, index) => parseCriterionEvaluation(item, `${path}.criteria[${index}]`)));
  if (criteria.length === 0 || new Set(criteria.map((item) => item.criterionId)).size !== criteria.length ||
      JSON.stringify(criteria.map((item) => item.criterionId)) !== JSON.stringify(
        criteria.map((item) => item.criterionId).sort(compareEvaluationText),
      )) {
    throw new EvaluationError("INVALID_INPUT", "Result criteria must be a unique nonempty canonical collection.");
  }
  const allEvidenceIds = criteria.flatMap((item) => item.evidenceIds);
  const allWaiverIds = criteria.flatMap((item) => item.waiverId === null ? [] : [item.waiverId]);
  if (allEvidenceIds.length > 1_024 || new Set(allEvidenceIds).size !== allEvidenceIds.length ||
      new Set(allWaiverIds).size !== allWaiverIds.length) {
    throw new EvaluationError("INVALID_INPUT", "Evidence and waiver identities must be globally unique in a result.");
  }
  const disagreements = Object.freeze(ensureArray(record["disagreements"], `${path}.disagreements`, 128).map((item, index) => {
    const entry = ensureRecord(item, `${path}.disagreements[${index}]`);
    ensureExactKeys(entry, ["disagreementId", "criterionId", "advisoryId", "deterministicOutcome", "advisoryRecommendation"], `${path}.disagreements[${index}]`);
    return Object.freeze({
      disagreementId: parseEvaluationId(entry["disagreementId"], `${path}.disagreements[${index}].disagreementId`),
      criterionId: parseEvaluationId(entry["criterionId"], `${path}.disagreements[${index}].criterionId`),
      advisoryId: parseEvaluationId(entry["advisoryId"], `${path}.disagreements[${index}].advisoryId`),
      deterministicOutcome: ensureEnum(entry["deterministicOutcome"], `${path}.disagreements[${index}].deterministicOutcome`, CRITERION_OUTCOMES),
      advisoryRecommendation: ensureEnum(entry["advisoryRecommendation"], `${path}.disagreements[${index}].advisoryRecommendation`, ["pass", "fail", "uncertain"] as const),
    });
  }));
  const criterionById = new Map(criteria.map((item) => [item.criterionId, item]));
  if (new Set(disagreements.map((item) => item.disagreementId)).size !== disagreements.length ||
      new Set(disagreements.map((item) => item.advisoryId)).size !== disagreements.length ||
      JSON.stringify(disagreements.map((item) => item.disagreementId)) !== JSON.stringify(
        disagreements.map((item) => item.disagreementId).sort(compareEvaluationText),
      ) || disagreements.some((item) => {
        const criterion = criterionById.get(item.criterionId);
        if (criterion?.outcome !== item.deterministicOutcome) return true;
        const deterministicRecommendation = criterion.outcome === "passed" || criterion.outcome === "waived"
          ? "pass"
          : "fail";
        return item.advisoryRecommendation === deterministicRecommendation ||
          item.disagreementId !== stableEvaluationId(
            "evaluation-disagreement",
            runId,
            item.advisoryId,
            item.deterministicOutcome,
          );
      })) {
    throw new EvaluationError("INVALID_INPUT", "Evaluation disagreements are not a canonical result projection.");
  }
  const blockingCriterionIds = Object.freeze(ensureArray(record["blockingCriterionIds"], `${path}.blockingCriterionIds`, 256).map((item, index) => parseEvaluationId(item, `${path}.blockingCriterionIds[${index}]`)));
  const requestRuleCodes = Object.freeze(ensureArray(
    record["requestRuleCodes"],
    `${path}.requestRuleCodes`,
    1,
  ).map((item, index) => ensureEnum(
    item,
    `${path}.requestRuleCodes[${index}]`,
    ["CRITERION_MANIFEST_UNAUTHORIZED"] as const,
  )));
  const body = Object.freeze({
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    runId,
    subjectDigest: parseEvaluationDigest(record["subjectDigest"], `${path}.subjectDigest`),
    requestDigest: parseEvaluationDigest(record["requestDigest"], `${path}.requestDigest`),
    authorityConfigurationFingerprint: parseEvaluationDigest(
      record["authorityConfigurationFingerprint"],
      `${path}.authorityConfigurationFingerprint`,
    ),
    criterionManifestDigest: parseEvaluationDigest(
      record["criterionManifestDigest"],
      `${path}.criterionManifestDigest`,
    ),
    requestRuleCodes,
    decision: ensureEnum(record["decision"], `${path}.decision`, ["accepted", "rejected"] as const),
    criteria,
    disagreements,
    blockingCriterionIds,
    evaluatedAt: ensureTimestamp(record["evaluatedAt"], `${path}.evaluatedAt`),
  });
  const resultDigest = parseEvaluationDigest(record["resultDigest"], `${path}.resultDigest`);
  if (evaluationDigest(body) !== resultDigest) {
    throw new EvaluationError("INVALID_INPUT", "Evaluation result digest does not match its canonical fields.");
  }
  const derivedBlocking = criteria
    .filter((item) => (item.criticality === "required" || item.criticality === "expected-quality") && (item.outcome === "failed" || item.outcome === "missing"))
    .map((item) => item.criterionId)
    .sort(compareEvaluationText);
  if (new Set(blockingCriterionIds).size !== blockingCriterionIds.length ||
      JSON.stringify(derivedBlocking) !== JSON.stringify(blockingCriterionIds) ||
      body.decision !== (derivedBlocking.length === 0 && requestRuleCodes.length === 0 ? "accepted" : "rejected")) {
    throw new EvaluationError("INVALID_INPUT", "Evaluation result decision is inconsistent with deterministic blocking outcomes.");
  }
  return Object.freeze({ ...body, resultDigest });
}

export function createCompletenessAudit(value: unknown): CompletenessAudit {
  const result = parseEvaluationResult(value);
  const findings: CompletenessFinding[] = result.criteria
    .filter((criterion) => criterion.outcome !== "passed")
    .map((criterion) => {
      const blocking = result.blockingCriterionIds.includes(criterion.criterionId);
      return Object.freeze({
        findingId: stableEvaluationId("completeness-finding", result.resultDigest, criterion.criterionId),
        criterionId: criterion.criterionId,
        outcome: criterion.outcome,
        blocking,
        proposedCorrectiveTaskKey: blocking
          ? stableEvaluationId("corrective-task-proposal", result.resultDigest, criterion.criterionId)
          : null,
      });
    });
  if (result.requestRuleCodes.includes("CRITERION_MANIFEST_UNAUTHORIZED")) {
    findings.push(Object.freeze({
      findingId: stableEvaluationId("completeness-finding", result.resultDigest, "criterion-manifest"),
      criterionId: "criterion-manifest:authorization",
      outcome: "missing" as const,
      blocking: true,
      proposedCorrectiveTaskKey: stableEvaluationId(
        "corrective-task-proposal",
        result.resultDigest,
        "criterion-manifest",
      ),
    }));
  }
  findings.sort((a, b) => compareEvaluationText(a.findingId, b.findingId));
  const body = Object.freeze({
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    auditId: stableEvaluationId("completeness-audit", result.resultDigest),
    resultDigest: result.resultDigest,
    authority: "none" as const,
    mayAuthorizeExecution: false as const,
    mayApproveWaiver: false as const,
    mayWidenScope: false as const,
    findings: Object.freeze(findings),
  });
  return Object.freeze({ ...body, auditDigest: evaluationDigest(body) });
}
