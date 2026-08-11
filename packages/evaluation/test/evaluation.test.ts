import { describe, expect, it } from "vitest";
import {
  EvaluationError,
  createCompletenessAudit,
  createEvaluationAuthorityConfiguration,
  createEvaluationRequest,
  createEvaluationRun,
  createEvaluationSubject,
  completeEvaluationRun,
  evaluateDeterministically,
  evaluationDigest,
  evaluationCriterionManifestDigest,
  evaluationWaiverDigest,
  parseEvaluationRequest,
  parseEvaluationResult,
  stableEvaluationId,
} from "../src/index.js";
import {
  DEADLINE,
  DIGEST_A,
  SHA_A,
  T0,
  T1,
  T2,
  authorityConfiguration,
  authorityConfigurationFor,
  criteria,
  evidenceFor,
  request,
  requestInput,
  subject,
} from "./fixtures.js";

describe("evaluation request and deterministic evaluators", () => {
  it("binds canonical subject/request identities and evaluates every supported kind", () => {
    const input = requestInput({
      advisories: [{
        advisoryId: "advisory:1",
        criterionId: "criterion:1",
        routeIndependenceKey: DIGEST_A,
        recommendation: "fail",
        summary: "Advisory concern remains visible but has no authority.",
        observedAt: T0,
      }],
    });
    const created = createEvaluationRequest(input);
    expect(parseEvaluationRequest(created)).toEqual(created);
    expect(created.subject.subjectDigest).toBe(evaluationDigest({
      repositoryId: subject.repositoryId,
      headSha: subject.headSha,
      treeSha: subject.treeSha,
      productSpecificationId: subject.productSpecificationId,
      productSpecificationDigest: subject.productSpecificationDigest,
      requirementIds: subject.requirementIds,
      taskIds: subject.taskIds,
      resultIds: subject.resultIds,
      coverageEdges: subject.coverageEdges,
    }));

    const result = evaluateDeterministically(created, T1, authorityConfiguration);
    expect(result.decision).toBe("accepted");
    expect(result.criteria).toHaveLength(8);
    expect(result.criteria.every((item) => item.outcome === "passed")).toBe(true);
    expect(result.disagreements).toEqual([
      expect.objectContaining({ advisoryId: "advisory:1", deterministicOutcome: "passed" }),
    ]);
    expect(parseEvaluationResult(result)).toEqual(result);
  });

  it("fails closed on deterministic path/test evidence and cannot be overridden by a model advisory", () => {
    const pathCriterion = criteria[1]!;
    const testCriterion = criteria[3]!;
    const evidence = criteria.map((criterion) => evidenceFor(criterion));
    evidence[1] = evidenceFor(pathCriterion, {
      data: { changedPaths: ["outside/scope.ts"], allowedPaths: ["packages/example/src/index.ts"] },
    });
    evidence[3] = evidenceFor(testCriterion, {
      data: { passed: 10, failed: 0, skipped: 0, expectedSkips: 1, suiteDigest: DIGEST_A },
    });
    const candidate = request({
      evidence,
      advisories: [{
        advisoryId: "advisory:pass",
        criterionId: pathCriterion.criterionId,
        routeIndependenceKey: DIGEST_A,
        recommendation: "pass",
        summary: "Narrative approval cannot replace deterministic evidence.",
        observedAt: T0,
      }],
    });
    const result = evaluateDeterministically(
      candidate,
      T1,
      authorityConfigurationFor(criteria, evidence),
    );
    expect(result.decision).toBe("rejected");
    expect(result.blockingCriterionIds).toEqual([pathCriterion.criterionId, testCriterion.criterionId]);
    expect(result.criteria.find((item) => item.criterionId === pathCriterion.criterionId)?.ruleCodes)
      .toContain("DETERMINISTIC_CHECK_FAILED");
  });

  it("treats stale, future, wrong-head, wrong-input, and mismatched evidence as invalid", () => {
    const criterion = criteria[0]!;
    const invalid = evidenceFor(criterion, {
      kind: "tests",
      configurationDigest: "b".repeat(64),
      subjectDigest: "c".repeat(64),
      repositoryId: "repository:other",
      headSha: "d".repeat(40),
      inputDigest: "e".repeat(64),
      evaluatorId: "evaluator:substituted",
      artifactDigests: ["b".repeat(64)],
      observedAt: T2,
      validUntil: T2,
      data: { passed: 1, failed: 0, skipped: 0, expectedSkips: 0, suiteDigest: "b".repeat(64) },
    });
    const evidence = criteria.map((item) => evidenceFor(item));
    evidence[0] = invalid;
    const result = evaluateDeterministically(request({ evidence }), T1, authorityConfiguration);
    const evaluated = result.criteria[0]!;
    expect(evaluated.outcome).toBe("missing");
    expect(evaluated.ruleCodes).toEqual(expect.arrayContaining([
      "ARTIFACT_PROVENANCE_MISMATCH", "CONFIGURATION_MISMATCH", "EVIDENCE_FROM_FUTURE", "EVIDENCE_KIND_MISMATCH",
      "EVALUATOR_PROVENANCE_MISMATCH", "EVIDENCE_CONTRACT_MISMATCH", "INPUT_DIGEST_MISMATCH",
      "EVIDENCE_INSTANCE_UNAUTHORIZED", "REPOSITORY_MISMATCH", "REVISION_MISMATCH", "SUBJECT_MISMATCH",
    ]));
  });

  it("applies only exact externally authorized waiver digests and ignores inline self-assertion", () => {
    const criterion = criteria[0]!;
    const evidence = criteria.map((item) => evidenceFor(item));
    evidence.splice(0, 1);
    const waiver = {
      waiverId: "waiver:1",
      criterionId: criterion.criterionId,
      subjectDigest: subject.subjectDigest,
      configurationDigest: criterion.configurationDigest,
      authority: "product-owner" as const,
      approvalReference: "approval:1",
      reason: "Explicitly approved bounded exception.",
      approvedAt: T0,
      expiresAt: DEADLINE,
    };
    const waived = request({
      evidence,
      waivers: [waiver],
    });
    const unverified = evaluateDeterministically(waived, T1, authorityConfiguration);
    expect(unverified.decision).toBe("rejected");
    expect(unverified.criteria[0]).toEqual(expect.objectContaining({
      outcome: "missing",
      waiverId: null,
      ruleCodes: expect.arrayContaining(["UNVERIFIED_WAIVER_IGNORED"]),
    }));
    const trustedWaiverConfiguration = authorityConfigurationFor(
      criteria,
      evidence,
      [evaluationWaiverDigest(waiver)],
    );
    const result = evaluateDeterministically(waived, T1, trustedWaiverConfiguration);
    expect(result.decision).toBe("accepted");
    expect(result.authorityConfigurationFingerprint).toBe(trustedWaiverConfiguration.configurationFingerprint);
    expect(result.criteria[0]).toEqual(expect.objectContaining({ outcome: "waived", waiverId: "waiver:1" }));
    const audit = createCompletenessAudit(result);
    expect(audit.authority).toBe("none");
    expect(audit.mayAuthorizeExecution).toBe(false);
    expect(audit.findings[0]).toEqual(expect.objectContaining({ outcome: "waived", blocking: false }));
  });

  it("keeps delight gaps visible but nonblocking and proposes no authoritative action", () => {
    const delight = { ...criteria[0]!, criterionId: "criterion:delight", criticality: "delight" as const };
    const delightConfiguration = createEvaluationAuthorityConfiguration({
      schemaVersion: 1,
      configurationId: "evaluation-authority:delight",
      authorizedCriterionManifestDigests: [evaluationCriterionManifestDigest(subject.subjectDigest, [delight])],
      authorizedEvidenceDigests: [],
      authorizedWaiverDigests: [],
    });
    const result = evaluateDeterministically(request({ criteria: [delight], evidence: [] }), T1, delightConfiguration);
    expect(result.decision).toBe("accepted");
    expect(result.criteria[0]?.outcome).toBe("missing");
    const audit = createCompletenessAudit(result);
    expect(audit.findings).toHaveLength(1);
    expect(audit.findings[0]?.proposedCorrectiveTaskKey).toBeNull();
    expect(audit.mayApproveWaiver).toBe(false);
    expect(audit.mayWidenScope).toBe(false);
  });

  it("rejects a caller-truncated criterion set against the trusted exact manifest", () => {
    const repositoryCriterion = criteria[7]!;
    const truncated = request({
      criteria: [repositoryCriterion],
      evidence: [evidenceFor(repositoryCriterion)],
    });
    const result = evaluateDeterministically(truncated, T1, authorityConfiguration);
    expect(result.decision).toBe("rejected");
    expect(result.blockingCriterionIds).toEqual([]);
    expect(result.requestRuleCodes).toEqual(["CRITERION_MANIFEST_UNAUTHORIZED"]);
    expect(createCompletenessAudit(result).findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ criterionId: "criterion-manifest:authorization", blocking: true }),
    ]));
    const changedSubject = createEvaluationSubject({
      repositoryId: subject.repositoryId,
      headSha: subject.headSha,
      treeSha: subject.treeSha,
      productSpecificationId: subject.productSpecificationId,
      productSpecificationDigest: "b".repeat(64),
      requirementIds: subject.requirementIds,
      taskIds: subject.taskIds,
      resultIds: subject.resultIds,
      coverageEdges: subject.coverageEdges,
    });
    const changedSubjectResult = evaluateDeterministically(
      request({ subject: changedSubject, evidence: [] }),
      T1,
      authorityConfiguration,
    );
    expect(changedSubjectResult.requestRuleCodes).toEqual(["CRITERION_MANIFEST_UNAUTHORIZED"]);
  });

  it("requires task and result linkage for requirement-specific coverage", () => {
    const coverage = criteria[6]!;
    const evidence = criteria.map((item) => evidenceFor(item));
    evidence[6] = evidenceFor(coverage, {
      data: {
        requirementIds: ["requirement:other"],
        taskIds: ["task:other"],
        resultIds: ["result:other"],
        coverageEdges: [{ requirementId: "requirement:other", taskId: "task:other", resultId: "result:other" }],
      },
    });
    const result = evaluateDeterministically(request({ evidence }), T1, authorityConfiguration);
    expect(result.criteria[6]).toEqual(expect.objectContaining({
      outcome: "missing",
      ruleCodes: expect.arrayContaining(["EVIDENCE_CONTRACT_MISMATCH"]),
    }));
    expect(result.decision).toBe("rejected");
  });

  it("rejects malformed identities, paths, duplicate ids, digest tampering, and bad windows", () => {
    expect(() => createEvaluationSubject({
      repositoryId: "bad id", headSha: SHA_A, treeSha: SHA_A,
      productSpecificationId: "spec:1", productSpecificationDigest: DIGEST_A,
      requirementIds: [], taskIds: [], resultIds: [], coverageEdges: [],
    })).toThrow();
    expect(() => createEvaluationSubject({
      repositoryId: "repository:mixed", headSha: SHA_A, treeSha: "b".repeat(64),
      productSpecificationId: "spec:1", productSpecificationDigest: DIGEST_A,
      requirementIds: [], taskIds: [], resultIds: [], coverageEdges: [],
    })).toThrow(EvaluationError);
    const badPathEvidence = evidenceFor(criteria[1]!, { data: { changedPaths: ["../escape"], allowedPaths: [] } });
    expect(() => request({ evidence: [badPathEvidence] })).toThrow();
    expect(() => request({ criteria: [criteria[0], criteria[0]] })).toThrow(EvaluationError);
    expect(() => request({ deadline: T0 })).toThrow(EvaluationError);
    const valid = request();
    expect(() => parseEvaluationRequest({ ...valid, requestDigest: "f".repeat(64) })).toThrow(EvaluationError);
    const result = evaluateDeterministically(valid, T1, authorityConfiguration);
    expect(() => parseEvaluationResult({ ...result, resultDigest: "f".repeat(64) })).toThrow(EvaluationError);
    const forgedBody = {
      ...result,
      criteria: [{ ...result.criteria[0]!, waiverId: "waiver:forged" }, ...result.criteria.slice(1)],
    } as Record<string, unknown>;
    delete forgedBody["resultDigest"];
    expect(() => parseEvaluationResult({
      ...forgedBody,
      resultDigest: evaluationDigest(forgedBody),
    })).toThrow(EvaluationError);
    const duplicateEvidenceBody = {
      ...result,
      criteria: [
        result.criteria[0]!,
        { ...result.criteria[1]!, evidenceIds: result.criteria[0]!.evidenceIds },
        ...result.criteria.slice(2),
      ],
    } as Record<string, unknown>;
    delete duplicateEvidenceBody["resultDigest"];
    expect(() => parseEvaluationResult({
      ...duplicateEvidenceBody,
      resultDigest: evaluationDigest(duplicateEvidenceBody),
    })).toThrow(EvaluationError);
    const contradictoryBody = {
      ...result,
      criteria: [{
        ...result.criteria[0]!,
        ruleCodes: [
          ...result.criteria[0]!.ruleCodes,
          "DETERMINISTIC_CHECK_FAILED",
        ].sort(),
      }, ...result.criteria.slice(1)],
    } as Record<string, unknown>;
    delete contradictoryBody["resultDigest"];
    expect(() => parseEvaluationResult({
      ...contradictoryBody,
      resultDigest: evaluationDigest(contradictoryBody),
    })).toThrow(EvaluationError);
    const disagreementResult = evaluateDeterministically(request({
      advisories: [{
        advisoryId: "advisory:forged-result",
        criterionId: criteria[0]!.criterionId,
        routeIndependenceKey: DIGEST_A,
        recommendation: "fail",
        summary: "Create one genuine disagreement for parser tampering.",
        observedAt: T0,
      }],
    }), T1, authorityConfiguration);
    const disagreementBody = {
      ...disagreementResult,
      disagreements: [{
        ...disagreementResult.disagreements[0]!,
        advisoryRecommendation: "pass",
      }],
    } as Record<string, unknown>;
    delete disagreementBody["resultDigest"];
    expect(() => parseEvaluationResult({
      ...disagreementBody,
      resultDigest: evaluationDigest(disagreementBody),
    })).toThrow(EvaluationError);
    expect(() => evaluateDeterministically(valid, "2026-08-11T03:39:59.000Z", authorityConfiguration)).toThrow(EvaluationError);
    expect(() => evaluateDeterministically(valid, "2026-08-11T05:20:00.001Z", authorityConfiguration)).toThrow(EvaluationError);
  });

  it("uses delimiter-safe stable identifiers", () => {
    expect(stableEvaluationId("x", "a\u001fb", "c")).not.toBe(stableEvaluationId("x", "a", "b\u001fc"));
  });

  it("rejects cumulative nested evidence text before per-item parsing can amplify work", () => {
    const artifactDigests = Array.from({ length: 1_024 }, (_, index) =>
      index.toString(16).padStart(64, "0"));
    const evidence = Array.from({ length: 31 }, (_, index) => evidenceFor(criteria[0]!, {
      evidenceId: `evidence:bounded-${index}`,
      artifactDigests: [...artifactDigests],
    }));
    expect(() => createEvaluationRequest(requestInput({ evidence }))).toThrowError(
      expect.objectContaining({ code: "LIMIT_EXCEEDED" }),
    );
  });

  it("validates unknown direct evaluator input before producing a decision", () => {
    const valid = request();
    expect(() => evaluateDeterministically(
      { ...valid, requestDigest: "f".repeat(64) },
      T1,
      authorityConfiguration,
    )).toThrow(EvaluationError);

    const sparseCriteria = new Array(1);
    expect(() => evaluateDeterministically(
      { ...valid, criteria: sparseCriteria },
      T1,
      authorityConfiguration,
    )).toThrow();

    const exoticCriteria = Object.setPrototypeOf([...valid.criteria], null);
    expect(() => evaluateDeterministically(
      { ...valid, criteria: exoticCriteria },
      T1,
      authorityConfiguration,
    )).toThrow();

    const artifactDigests = Array.from({ length: 1_024 }, (_, index) =>
      index.toString(16).padStart(64, "0"));
    const evidence = Array.from({ length: 31 }, (_, index) => evidenceFor(criteria[0]!, {
      evidenceId: `evidence:direct-bounded-${index}`,
      artifactDigests: [...artifactDigests],
    }));
    const oversizedBody = requestInput({ evidence });
    expect(() => evaluateDeterministically({
      ...oversizedBody,
      requestDigest: evaluationDigest(oversizedBody),
    }, T1, authorityConfiguration)).toThrowError(
      expect.objectContaining({ code: "LIMIT_EXCEEDED" }),
    );
  });

  it("reserves enough enclosing JSON capacity for every accepted run to complete", () => {
    const pathCriterion = criteria[1]!;
    const paths = Array.from({ length: 20 }, (_, index) => `packages/example/path-${index}.ts`);
    const evidence = Array.from({ length: 1_024 }, (_, index) => evidenceFor(pathCriterion, {
      evidenceId: `evidence:near-envelope-limit-${index}`,
      data: { changedPaths: [...paths], allowedPaths: [...paths] },
    }));
    const configuration = authorityConfigurationFor([pathCriterion], evidence);
    const accepted = createEvaluationRun(requestInput({
      criteria: [pathCriterion],
      evidence,
    }), configuration);
    const completed = completeEvaluationRun(accepted.snapshot, 1, T1);
    expect(completed.snapshot.status).toBe("completed");
    expect(completed.snapshot.result?.criteria[0]?.evidenceIds).toHaveLength(1_024);

    const oversizedPaths = Array.from({ length: 39 }, (_, index) => `p/${index}`);
    const oversizedEvidence = Array.from({ length: 1_024 }, (_, index) => evidenceFor(pathCriterion, {
      evidenceId: `evidence:stranded-envelope-${index}`,
      data: { changedPaths: [...oversizedPaths], allowedPaths: [...oversizedPaths] },
    }));
    expect(() => createEvaluationRun(requestInput({
      criteria: [pathCriterion],
      evidence: oversizedEvidence,
    }), authorityConfigurationFor([pathCriterion], oversizedEvidence))).toThrowError(
      expect.objectContaining({ code: "LIMIT_EXCEEDED" }),
    );
  });
});
