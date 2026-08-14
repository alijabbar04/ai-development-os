import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import { describe, expect, it } from "vitest";
import {
  createCompletenessAudit,
  createEvaluationAuthorityConfiguration,
  createEvaluationRequest,
  createEvaluationSubject,
  createProductionDisabledEvaluationService,
  evaluateDeterministically,
  evaluationCriterionManifestDigest,
  evaluationDigest,
  replayEvaluationEvents,
  type EvaluationCriterion,
  type EvaluationCriticality,
  type EvaluationEvidence,
  type EvaluationRequest,
} from "../src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..");
const specificationPath = resolve(
  repositoryRoot,
  "docs",
  "release-evidence",
  "stage-18-audit-specification-overlay-v1.json",
);
const auditSummaryPath = resolve(
  repositoryRoot,
  "docs",
  "release-evidence",
  "stage-18-completeness-audit-untrusted-summary.json",
);

const SUBJECT_HEAD = "f5372fece6371385e15b6cbb2edd2f4063c7eac3";
const SUBJECT_TREE = "9f5a842192bb9317127cc4b57af5fbf50d0d36dc";
const CREATED_AT = "2026-08-14T13:19:40.000Z";
const EVALUATED_AT = "2026-08-14T13:20:00.000Z";
const DEADLINE = "2026-08-15T13:19:40.000Z";
const MATRIX_SOURCE_BASE = "c50c4725981013f123ebef0d0a87082f085b333d";
const MATRIX_PERMITTED_OUTCOME = "Stage 18D production-disabled checkpoint complete";
const MATRIX_CHECKPOINT_ROWS = Object.freeze(["ADM-01", "SCH-02", "PER-02", "PER-03", "EVD-01"]);

const MATRIX_STATUSES = Object.freeze({
  "ADM-01": "proven",
  "ANT-01": "proven",
  "ANT-02": "incomplete",
  "PLN-01": "proven",
  "PLN-02": "incomplete",
  "SCH-01": "proven",
  "SCH-02": "proven",
  "PER-01": "proven",
  "PER-02": "proven",
  "PER-03": "proven",
  "USE-01": "proven",
  "AM-01": "proven",
  "AM-02": "incomplete",
  "INT-01": "proven",
  "EVD-01": "proven",
  "PRD-01": "production-gated",
} as const);

const CRITICALITIES = Object.freeze({
  "ADM-01": "required",
  "ANT-01": "required",
  "ANT-02": "required",
  "PLN-01": "required",
  "PLN-02": "required",
  "SCH-01": "required",
  "SCH-02": "expected-quality",
  "PER-01": "required",
  "PER-02": "expected-quality",
  "PER-03": "expected-quality",
  "USE-01": "required",
  "AM-01": "expected-quality",
  "AM-02": "required",
  "INT-01": "required",
  "EVD-01": "expected-quality",
  "PRD-01": "required",
} as const satisfies Record<keyof typeof MATRIX_STATUSES, EvaluationCriticality>);

const CONCERNS = Object.freeze([
  "security",
  "privacy",
  "data-lifecycle",
  "accessibility",
  "failure-recovery",
  "testing",
  "performance",
  "operations",
  "maintainability",
  "documentation",
] as const);

const CANDIDATE_DISPOSITIONS = Object.freeze({
  "candidate:stage18:accessibility-ui": "deferred",
  "candidate:stage18:linux-macos-production": "deferred",
  "candidate:stage18:query-native-team-scale": "deferred",
  "candidate:stage18:production-activation": "needs-user-decision",
} as const);

const SUBJECT_ANCHOR_PATHS = Object.freeze([
  "docs/adr/0016-product-completeness-planning-assembly.md",
  "docs/adr/0021-stage-18a-production-disabled-orchestration-foundation.md",
  "docs/adr/0022-stage-18b-anthropic-product-planning.md",
  "docs/adr/0023-stage-18c-durable-runtime-usage-adapter.md",
  "docs/adr/0024-stage-18d-postgres-admission-readiness.md",
  "docs/adr/0025-stage-19a-production-disabled-evaluation.md",
  "docs/adr/0027-stage-18-live-boundary-checkpoint.md",
  "docs/adr/0028-stage-18-windows-credential-secret-broker.md",
  "docs/implementation-roadmap.md",
  "docs/product-direction.md",
  "docs/technical-design.md",
  "docs/release-evidence/stage-18-development-acceptance-matrix.json",
  "docs/release-evidence/stage-18-operator-continuation-2026-08-14.md",
] as const);

type MatrixStatus = (typeof MATRIX_STATUSES)[keyof typeof MATRIX_STATUSES];
type MatrixRowId = keyof typeof MATRIX_STATUSES;

interface MatrixRow {
  readonly id: MatrixRowId;
  readonly requirement: string;
  readonly authority: readonly string[];
  readonly implementation: readonly string[];
  readonly tests: readonly string[];
  readonly evidence: readonly string[];
  readonly status: MatrixStatus;
  readonly ownerStage: string;
  readonly blocksDevelopmentAcceptance: boolean;
  readonly blocksProduction: boolean;
  readonly rationale: string;
}

interface Matrix {
  readonly schemaVersion: number;
  readonly branch: string;
  readonly sourceBase: string;
  readonly productionAdmitted: boolean;
  readonly developmentAccepted: boolean;
  readonly permittedOutcome: string;
  readonly checkpointRows: readonly string[];
  readonly rows: readonly MatrixRow[];
}

interface RequirementSpecification {
  readonly requirementId: string;
  readonly matrixRowId: MatrixRowId;
  readonly criticality: EvaluationCriticality;
  readonly taskId: string;
  readonly resultId: string;
  readonly journeyIds: readonly string[];
  readonly concerns: readonly string[];
}

interface Stage18Specification {
  readonly schemaVersion: number;
  readonly artifactKind: string;
  readonly specificationId: string;
  readonly status: string;
  readonly repositoryId: string;
  readonly branch: string;
  readonly sourceHeadSha: string;
  readonly sourceTreeSha: string;
  readonly matrixPath: string;
  readonly provenancePath: string;
  readonly authorityStatus: string;
  readonly subjectAnchorPaths: readonly string[];
  readonly authoringRoute: {
    readonly routeId: string;
    readonly routeIndependenceKey: string;
    readonly family: string;
    readonly claim: string;
  };
  readonly auditRoute: {
    readonly routeId: string;
    readonly routeIndependenceKey: string;
    readonly family: string;
    readonly claim: string;
  };
  readonly journeys: readonly {
    readonly journeyId: string;
    readonly description: string;
  }[];
  readonly requirements: readonly RequirementSpecification[];
  readonly concernDispositions: readonly {
    readonly concern: string;
    readonly disposition: "accepted" | "deferred";
    readonly requirementIds: readonly string[];
    readonly reason: string;
  }[];
  readonly candidateDispositions: readonly {
    readonly candidateId: keyof typeof CANDIDATE_DISPOSITIONS;
    readonly disposition: (typeof CANDIDATE_DISPOSITIONS)[keyof typeof CANDIDATE_DISPOSITIONS];
    readonly sourcePath: string;
    readonly reason: string;
  }[];
}

interface AuditBundle {
  readonly specification: Stage18Specification;
  readonly matrix: Matrix;
  readonly specificationDigest: string;
  readonly subject: ReturnType<typeof createEvaluationSubject>;
  readonly criteria: readonly EvaluationCriterion[];
  readonly evidence: readonly EvaluationEvidence[];
  readonly authorityConfiguration: ReturnType<typeof createEvaluationAuthorityConfiguration>;
  readonly request: EvaluationRequest;
  readonly result: ReturnType<typeof evaluateDeterministically>;
  readonly audit: ReturnType<typeof createCompletenessAudit>;
}

const specificationInput = JSON.parse(readFileSync(specificationPath, "utf8")) as unknown;
const recordedAuditSummary = JSON.parse(readFileSync(auditSummaryPath, "utf8")) as unknown;
const blobCache = new Map<string, Buffer>();

function keys(value: object): readonly string[] {
  return Object.keys(value).sort();
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  if (JSON.stringify(keys(value)) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} has an unexpected key set.`);
  }
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain data object.`);
  }
  return value as Record<string, unknown>;
}

function normalizedPath(value: string): string {
  const path = value.split("#", 1)[0] ?? "";
  if (path.length === 0 || path.includes("\\") || path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Invalid repository path: ${value}`);
  }
  return path;
}

function subjectBlob(pathValue: string, head = SUBJECT_HEAD): Buffer {
  const path = normalizedPath(pathValue);
  const key = `${head}:${path}`;
  const cached = blobCache.get(key);
  if (cached !== undefined) return cached;
  const value = execFileSync("git", ["show", `${head}:${path}`], {
    cwd: repositoryRoot,
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  blobCache.set(key, value);
  return value;
}

function subjectJson(path: string, head = SUBJECT_HEAD): unknown {
  return JSON.parse(subjectBlob(path, head).toString("utf8")) as unknown;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function validateMatrix(value: unknown): Matrix {
  const matrix = dataRecord(value, "matrix");
  exactKeys(matrix, [
    "schemaVersion", "branch", "sourceBase", "productionAdmitted", "developmentAccepted",
    "permittedOutcome", "checkpointRows", "rows",
  ], "matrix");
  if (matrix["schemaVersion"] !== 1 || matrix["branch"] !== "feat/stage-18-pln-completeness-audit" ||
      matrix["sourceBase"] !== MATRIX_SOURCE_BASE ||
      matrix["developmentAccepted"] !== false || matrix["productionAdmitted"] !== false ||
      matrix["permittedOutcome"] !== MATRIX_PERMITTED_OUTCOME ||
      JSON.stringify(matrix["checkpointRows"]) !== JSON.stringify(MATRIX_CHECKPOINT_ROWS) ||
      !Array.isArray(matrix["rows"])) {
    throw new Error("Matrix envelope differs from the frozen rejected Stage 18 state.");
  }
  const rows = matrix["rows"] as unknown[];
  if (rows.length !== Object.keys(MATRIX_STATUSES).length) throw new Error("Matrix row coverage is incomplete.");
  const seen = new Set<string>();
  for (const rawRow of rows) {
    const row = dataRecord(rawRow, "matrix row");
    exactKeys(row, [
      "id", "requirement", "authority", "implementation", "tests", "evidence", "status",
      "ownerStage", "blocksDevelopmentAcceptance", "blocksProduction", "rationale",
    ], "matrix row");
    const id = row["id"] as MatrixRowId;
    if (!(id in MATRIX_STATUSES) || seen.has(id) || row["status"] !== MATRIX_STATUSES[id]) {
      throw new Error("Matrix identity or status differs from the frozen truth projection.");
    }
    seen.add(id);
    for (const field of ["authority", "implementation", "tests", "evidence"] as const) {
      if (!Array.isArray(row[field]) || row[field].length === 0 || row[field].some((item) => typeof item !== "string")) {
        throw new Error(`${id}.${field} must be a nonempty path list.`);
      }
      for (const anchor of row[field] as string[]) subjectBlob(anchor);
    }
  }
  if (seen.size !== Object.keys(MATRIX_STATUSES).length) throw new Error("Matrix row identity coverage is incomplete.");
  return value as Matrix;
}

function validateSpecification(value: unknown, matrix: Matrix): Stage18Specification {
  const specification = dataRecord(value, "specification");
  exactKeys(specification, [
    "schemaVersion", "artifactKind", "specificationId", "status", "repositoryId", "branch", "sourceHeadSha",
    "sourceTreeSha", "matrixPath", "provenancePath", "authorityStatus", "subjectAnchorPaths",
    "authoringRoute", "auditRoute", "journeys", "requirements", "concernDispositions",
    "candidateDispositions",
  ], "specification");
  if (
    specification["schemaVersion"] !== 1 ||
    specification["artifactKind"] !== "stage18-audit-specification-overlay" ||
    specification["specificationId"] !== "audit-specification-overlay:stage-18:1" ||
    specification["status"] !== "unapproved-production-disabled-audit-candidate" ||
    specification["repositoryId"] !== "repository:ai-development-os" ||
    specification["branch"] !== matrix.branch ||
    specification["sourceHeadSha"] !== SUBJECT_HEAD ||
    specification["sourceTreeSha"] !== SUBJECT_TREE ||
    specification["matrixPath"] !== "docs/release-evidence/stage-18-development-acceptance-matrix.json" ||
    specification["provenancePath"] !== "docs/release-evidence/stage-18-operator-continuation-2026-08-14.md" ||
    specification["authorityStatus"] !== "unapproved-repository-bound-candidate"
  ) {
    throw new Error("Specification authority or subject identity differs from the reviewed candidate.");
  }
  const actualTree = execFileSync("git", ["rev-parse", `${SUBJECT_HEAD}^{tree}`], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  if (actualTree !== SUBJECT_TREE) throw new Error("The specification subject tree is not the exact Git tree.");
  subjectBlob(specification["provenancePath"] as string);

  const authoringRoute = dataRecord(specification["authoringRoute"], "authoringRoute");
  const auditRoute = dataRecord(specification["auditRoute"], "auditRoute");
  if (
    authoringRoute["routeId"] !== "route:stage18:pln-author" ||
    auditRoute["routeId"] !== "route:stage18:pln-audit" ||
    authoringRoute["family"] !== "gpt-5.6-sol" ||
    auditRoute["family"] !== "gpt-5.6-sol"
  ) {
    throw new Error("Declared route identities or same-family limitation differ from the reviewed metadata.");
  }
  for (const [label, route] of [["authoringRoute", authoringRoute], ["auditRoute", auditRoute]] as const) {
    exactKeys(route, ["routeId", "routeIndependenceKey", "family", "claim"], label);
    if (typeof route["routeIndependenceKey"] !== "string" || !/^[a-f0-9]{64}$/.test(route["routeIndependenceKey"])) {
      throw new Error(`${label} lacks a finite route key.`);
    }
    if (route["routeIndependenceKey"] !== evaluationDigest({
      routeId: route["routeId"],
      family: route["family"],
      claim: route["claim"],
    })) {
      throw new Error(`${label} key does not bind its declared candidate metadata.`);
    }
  }
  if (authoringRoute["routeIndependenceKey"] === auditRoute["routeIndependenceKey"] ||
      authoringRoute["claim"] !== "declared-implementation-route-unauthenticated" ||
      auditRoute["claim"] !== "declared-separate-read-only-route-same-family-unauthenticated") {
    throw new Error("The audit route limitation or separation is not explicit.");
  }

  if (!Array.isArray(specification["subjectAnchorPaths"])) throw new Error("Subject anchor paths are absent.");
  const subjectAnchorPaths = specification["subjectAnchorPaths"] as unknown[];
  if (JSON.stringify(subjectAnchorPaths) !== JSON.stringify(SUBJECT_ANCHOR_PATHS)) {
    throw new Error("Subject anchor path inventory differs from the exact finite set.");
  }
  for (const path of subjectAnchorPaths as string[]) subjectBlob(path);

  if (!Array.isArray(specification["journeys"]) || !Array.isArray(specification["requirements"]) ||
      !Array.isArray(specification["concernDispositions"]) || !Array.isArray(specification["candidateDispositions"])) {
    throw new Error("Specification collections are missing.");
  }
  const journeys = specification["journeys"] as Record<string, unknown>[];
  const journeyIds = new Set<string>();
  for (const journey of journeys) {
    exactKeys(journey, ["journeyId", "description"], "journey");
    if (typeof journey["journeyId"] !== "string" || typeof journey["description"] !== "string" || journeyIds.has(journey["journeyId"])) {
      throw new Error("Journey identity is invalid or duplicated.");
    }
    journeyIds.add(journey["journeyId"]);
  }

  const requirements = specification["requirements"] as Record<string, unknown>[];
  if (requirements.length !== Object.keys(MATRIX_STATUSES).length) throw new Error("Specification omits a matrix requirement.");
  const requirementIds = new Set<string>();
  const rowIds = new Set<string>();
  const taskIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const requirement of requirements) {
    exactKeys(requirement, [
      "requirementId", "matrixRowId", "criticality", "taskId", "resultId", "journeyIds", "concerns",
    ], "requirement");
    const rowId = requirement["matrixRowId"] as MatrixRowId;
    if (!(rowId in CRITICALITIES) || requirement["criticality"] !== CRITICALITIES[rowId]) {
      throw new Error("A criterion was omitted or lowered from the reviewed criticality map.");
    }
    for (const [field, set] of [["requirementId", requirementIds], ["taskId", taskIds], ["resultId", resultIds]] as const) {
      const identity = requirement[field];
      if (typeof identity !== "string" || set.has(identity)) throw new Error(`${field} is invalid or duplicated.`);
      set.add(identity);
    }
    if (rowIds.has(rowId) || !matrix.rows.some((row) => row.id === rowId)) throw new Error("Matrix coverage is duplicated or missing.");
    rowIds.add(rowId);
    if (!Array.isArray(requirement["journeyIds"]) || requirement["journeyIds"].length === 0 ||
        requirement["journeyIds"].some((id) => typeof id !== "string" || !journeyIds.has(id))) {
      throw new Error("Requirement journey coverage is missing or invalid.");
    }
    if (!Array.isArray(requirement["concerns"]) || requirement["concerns"].length === 0 ||
        requirement["concerns"].some((item) => typeof item !== "string" || !CONCERNS.includes(item as typeof CONCERNS[number]))) {
      throw new Error("Requirement concern coverage is missing or invalid.");
    }
  }

  const concernDispositions = specification["concernDispositions"] as Record<string, unknown>[];
  if (concernDispositions.length !== CONCERNS.length) throw new Error("Specialist concern dispositions are incomplete.");
  for (const concern of CONCERNS) {
    const disposition = concernDispositions.find((item) => item["concern"] === concern);
    if (disposition === undefined) throw new Error(`Specialist concern ${concern} was silently omitted.`);
    exactKeys(disposition, ["concern", "disposition", "requirementIds", "reason"], "concern disposition");
    const tagged = requirements
      .filter((item) => (item["concerns"] as string[]).includes(concern))
      .map((item) => item["requirementId"] as string)
      .sort();
    const declared = Array.isArray(disposition["requirementIds"])
      ? [...disposition["requirementIds"] as string[]].sort()
      : [];
    const expectedDisposition = concern === "accessibility" ? "deferred" : "accepted";
    const reason = disposition["reason"];
    if (JSON.stringify(tagged) !== JSON.stringify(declared) ||
        disposition["disposition"] !== expectedDisposition ||
        typeof reason !== "string" || reason.trim().length === 0 || reason.length > 1_024) {
      throw new Error(`Specialist concern ${concern} has an inconsistent disposition.`);
    }
  }

  const candidates = specification["candidateDispositions"] as Record<string, unknown>[];
  if (candidates.length !== Object.keys(CANDIDATE_DISPOSITIONS).length) throw new Error("Candidate disposition ledger is incomplete.");
  for (const [candidateId, expected] of Object.entries(CANDIDATE_DISPOSITIONS)) {
    const candidate = candidates.find((item) => item["candidateId"] === candidateId);
    if (candidate === undefined) throw new Error(`Candidate ${candidateId} was silently omitted.`);
    exactKeys(candidate, ["candidateId", "disposition", "sourcePath", "reason"], "candidate disposition");
    if (candidate["disposition"] !== expected || typeof candidate["sourcePath"] !== "string") {
      throw new Error(`Candidate ${candidateId} has an unauthorized disposition.`);
    }
    subjectBlob(candidate["sourcePath"]);
  }
  return value as Stage18Specification;
}

function artifactProjection(row: MatrixRow): readonly { readonly path: string; readonly sha256: string }[] {
  const paths = [...row.authority, ...row.implementation, ...row.tests, ...row.evidence]
    .map(normalizedPath)
    .filter((path, index, values) => values.indexOf(path) === index)
    .sort();
  return Object.freeze(paths.map((path) => Object.freeze({ path, sha256: sha256(subjectBlob(path)) })));
}

function compileAudit(specificationValue: unknown = specificationInput, matrixValue?: unknown): AuditBundle {
  const preliminary = dataRecord(specificationValue, "specification");
  const matrixPath = typeof preliminary["matrixPath"] === "string"
    ? preliminary["matrixPath"]
    : "docs/release-evidence/stage-18-development-acceptance-matrix.json";
  const matrix = validateMatrix(matrixValue ?? subjectJson(matrixPath));
  const specification = validateSpecification(specificationValue, matrix);
  const specificationDigest = evaluationDigest(specification);
  const coverageEdges = specification.requirements.map((item) => Object.freeze({
    requirementId: item.requirementId,
    taskId: item.taskId,
    resultId: item.resultId,
  }));
  const subject = createEvaluationSubject({
    repositoryId: specification.repositoryId,
    headSha: specification.sourceHeadSha,
    treeSha: specification.sourceTreeSha,
    productSpecificationId: specification.specificationId,
    productSpecificationDigest: specificationDigest,
    requirementIds: specification.requirements.map((item) => item.requirementId),
    taskIds: specification.requirements.map((item) => item.taskId),
    resultIds: specification.requirements.map((item) => item.resultId),
    coverageEdges,
  });
  const rowById = new Map(matrix.rows.map((row) => [row.id, row]));
  const criteria = specification.requirements.map((requirement): EvaluationCriterion => {
    const row = rowById.get(requirement.matrixRowId)!;
    const artifacts = artifactProjection(row);
    const evidenceContractDigest = evaluationDigest({
      schemaVersion: 1,
      sourceHeadSha: specification.sourceHeadSha,
      sourceTreeSha: specification.sourceTreeSha,
      requirementId: requirement.requirementId,
      matrixRowId: row.id,
      requirement: row.requirement,
      status: row.status,
      blocksDevelopmentAcceptance: row.blocksDevelopmentAcceptance,
      blocksProduction: row.blocksProduction,
      rationale: row.rationale,
      artifacts,
    });
    return Object.freeze({
      criterionId: `criterion:stage18:${row.id}`,
      kind: "acceptance-criteria" as const,
      criticality: requirement.criticality,
      requirementId: requirement.requirementId,
      description: row.requirement,
      evaluatorId: "evaluator:stage18-matrix-status",
      evaluatorVersion: "1.0.0",
      configurationDigest: evaluationDigest({
        schemaVersion: 1,
        rule: "only-exact-proven-status-satisfies",
        expectedStatus: row.status,
        criticality: requirement.criticality,
      }),
      evidenceContractDigest,
      expectedArtifactDigests: Object.freeze([...new Set(artifacts.map((item) => item.sha256))].sort()),
    });
  });
  const evidence = criteria.map((criterion, index): EvaluationEvidence => {
    const requirement = specification.requirements[index]!;
    const row = rowById.get(requirement.matrixRowId)!;
    return Object.freeze({
      evidenceId: `evidence:stage18:${row.id}`,
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
      artifactDigests: [...criterion.expectedArtifactDigests],
      observedAt: CREATED_AT,
      validUntil: DEADLINE,
      data: Object.freeze({
        satisfied: row.status === "proven",
        requirementDigest: criterion.evidenceContractDigest,
      }),
    });
  });
  const criterionManifestDigest = evaluationCriterionManifestDigest(subject.subjectDigest, criteria);
  const authorityConfiguration = createEvaluationAuthorityConfiguration({
    schemaVersion: 1,
    configurationId: "evaluation-authority:stage18:unavailable",
    authorizedCriterionManifestDigests: [],
    authorizedEvidenceDigests: [],
    authorizedWaiverDigests: [],
  });
  const request = createEvaluationRequest({
    schemaVersion: 1,
    runId: "evaluation:stage18:completeness:1",
    subject,
    criteria,
    evidence,
    waivers: [],
    advisories: [{
      advisoryId: "advisory:stage18:pln-audit:1",
      criterionId: "criterion:stage18:PLN-02",
      routeIndependenceKey: specification.auditRoute.routeIndependenceKey,
      recommendation: "fail",
      summary: "A separate read-only same-family route found an exact audit-overlay-bound rejection, but no approved ProductSpecification, externally authorized manifest and evidence set, or authenticated fully independent route is available.",
      observedAt: CREATED_AT,
    }],
    createdAt: CREATED_AT,
    deadline: DEADLINE,
    maximumAttempts: 1,
  });
  const result = evaluateDeterministically(request, EVALUATED_AT, authorityConfiguration);
  const audit = createCompletenessAudit(result);
  return Object.freeze({
    specification,
    matrix,
    specificationDigest,
    subject,
    criteria,
    evidence,
    authorityConfiguration,
    request,
    result,
    audit,
  });
}

function requestBody(request: EvaluationRequest): Omit<EvaluationRequest, "requestDigest"> {
  const { requestDigest: _requestDigest, ...body } = request;
  return body;
}

function auditSummary(bundle: AuditBundle): Record<string, unknown> {
  return {
    schemaVersion: 1,
    artifactKind: "untrusted-derived-audit-summary",
    productionEnabled: false,
    subjectHeadSha: bundle.subject.headSha,
    subjectTreeSha: bundle.subject.treeSha,
    productSpecificationId: bundle.subject.productSpecificationId,
    productSpecificationDigest: bundle.specificationDigest,
    subjectDigest: bundle.subject.subjectDigest,
    requirementCount: bundle.specification.requirements.length,
    criterionCount: bundle.criteria.length,
    evidenceCount: bundle.evidence.length,
    authorizedCriterionManifestCount: bundle.authorityConfiguration.authorizedCriterionManifestDigests.length,
    authorizedEvidenceCount: bundle.authorityConfiguration.authorizedEvidenceDigests.length,
    authorizedWaiverCount: bundle.authorityConfiguration.authorizedWaiverDigests.length,
    criterionManifestDigest: bundle.result.criterionManifestDigest,
    authorityConfigurationFingerprint: bundle.authorityConfiguration.configurationFingerprint,
    requestDigest: bundle.request.requestDigest,
    decision: bundle.result.decision,
    requestRuleCodes: bundle.result.requestRuleCodes,
    passedCriterionIds: bundle.result.criteria.filter((item) => item.outcome === "passed").map((item) => item.criterionId),
    semanticStatusBlockerIds: bundle.matrix.rows
      .filter((row) => row.status !== "proven")
      .map((row) => `criterion:stage18:${row.id}`)
      .sort(),
    blockingCriterionIds: bundle.result.blockingCriterionIds,
    resultDigest: bundle.result.resultDigest,
    auditId: bundle.audit.auditId,
    auditDigest: bundle.audit.auditDigest,
    auditAuthority: bundle.audit.authority,
    mayAuthorizeExecution: bundle.audit.mayAuthorizeExecution,
    mayApproveWaiver: bundle.audit.mayApproveWaiver,
    mayWidenScope: bundle.audit.mayWidenScope,
    authoringRouteKey: bundle.specification.authoringRoute.routeIndependenceKey,
    auditRouteKey: bundle.specification.auditRoute.routeIndependenceKey,
    routeIndependenceClaim: "unavailable-same-family-unauthenticated",
    developmentAccepted: false,
    productionAdmitted: false,
  };
}

const compiledAudit = compileAudit();

describe("Stage 18 audit-overlay-bound completeness audit", () => {
  it("gives only the two audit-executing hosted jobs the required subject history", () => {
    const workflow = readFileSync(resolve(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8")
      .replaceAll("\r\n", "\n");
    expect(workflow.match(/uses: actions\/checkout@/g)).toHaveLength(4);
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(4);
    expect(workflow.match(/fetch-depth: 0/g)).toHaveLength(2);
    const job = (name: "check" | "audit" | "coverage" | "postgres", next: string): string => {
      const start = workflow.indexOf(`  ${name}:\n`);
      const end = workflow.indexOf(next, start + 1);
      expect(start, `${name} job is missing`).toBeGreaterThanOrEqual(0);
      expect(end, `${name} job boundary is missing`).toBeGreaterThan(start);
      return workflow.slice(start, end);
    };
    const check = job("check", "  audit:\n");
    const audit = job("audit", "  coverage:\n");
    const coverage = job("coverage", "  postgres:\n");
    const postgres = job("postgres", "# What this workflow deliberately does NOT do");
    for (const body of [check, audit, coverage, postgres]) {
      expect(body.match(/uses: actions\/checkout@/g)).toHaveLength(1);
      expect(body.match(/persist-credentials: false/g)).toHaveLength(1);
    }
    expect(check.match(/fetch-depth: 0/g)).toHaveLength(1);
    expect(coverage.match(/fetch-depth: 0/g)).toHaveLength(1);
    expect(audit).not.toContain("fetch-depth:");
    expect(postgres).not.toContain("fetch-depth:");
  });

  it("binds every matrix row and specialist concern to one exact rejected subject", () => {
    const bundle = compiledAudit;
    expect(bundle.criteria).toHaveLength(16);
    expect(bundle.evidence).toHaveLength(16);
    expect(bundle.authorityConfiguration.authorizedCriterionManifestDigests).toEqual([]);
    expect(bundle.authorityConfiguration.authorizedEvidenceDigests).toEqual([]);
    expect(bundle.authorityConfiguration.authorizedWaiverDigests).toEqual([]);
    expect(bundle.result.decision).toBe("rejected");
    expect(bundle.result.requestRuleCodes).toEqual(["CRITERION_MANIFEST_UNAUTHORIZED"]);
    expect(bundle.result.criteria.every((item) => item.outcome === "missing")).toBe(true);
    expect(bundle.result.blockingCriterionIds).toEqual(
      bundle.criteria.map((item) => item.criterionId).sort(),
    );
    expect(bundle.audit.authority).toBe("none");
    expect(bundle.audit.mayAuthorizeExecution).toBe(false);
    expect(bundle.audit.mayApproveWaiver).toBe(false);
    expect(bundle.audit.mayWidenScope).toBe(false);
    expect(bundle.audit.findings).toHaveLength(17);
    expect(auditSummary(bundle)).toEqual(recordedAuditSummary);
  });

  it("persists, replays, and exactly retries the authority-free rejected audit", async () => {
    const bundle = compiledAudit;
    const persistence = createMemoryPersistenceAdapter({ clock: { now: () => new Date(CREATED_AT) } });
    try {
      const service = createProductionDisabledEvaluationService({
        persistence,
        authorityConfiguration: bundle.authorityConfiguration,
      });
      expect(service.productionEnabled).toBe(false);
      const accepted = await service.accept(requestBody(bundle.request));
      const completed = await service.evaluate(accepted.runId, 1, EVALUATED_AT);
      expect(completed.status).toBe("completed");
      expect(completed.result).toEqual(bundle.result);
      expect(await service.evaluate(accepted.runId, 1, EVALUATED_AT)).toEqual(completed);
      const history = await service.history(accepted.runId);
      expect(history).toHaveLength(2);
      expect(replayEvaluationEvents(history)).toEqual(completed);
      expect(service.completenessAudit(completed.result)).toEqual(bundle.audit);
    } finally {
      await persistence.close();
    }
  });

  it("rejects omitted rows, hidden gaps, lowered criticality, and route collision", () => {
    const missingRequirement = clone(specificationInput) as Stage18Specification;
    (missingRequirement.requirements as RequirementSpecification[]).pop();
    expect(() => compileAudit(missingRequirement)).toThrow(/omits a matrix requirement/);

    const missingRow = clone(subjectJson("docs/release-evidence/stage-18-development-acceptance-matrix.json")) as Matrix;
    (missingRow.rows as MatrixRow[]).pop();
    expect(() => compileAudit(specificationInput, missingRow)).toThrow(/row coverage is incomplete/);

    const lowered = clone(specificationInput) as Stage18Specification;
    const required = (lowered.requirements as RequirementSpecification[]).find((item) => item.matrixRowId === "ANT-02")!;
    (required as { criticality: EvaluationCriticality }).criticality = "delight";
    expect(() => compileAudit(lowered)).toThrow(/omitted or lowered/);

    const collidingRoute = clone(specificationInput) as Stage18Specification;
    (collidingRoute.auditRoute as { routeIndependenceKey: string }).routeIndependenceKey = collidingRoute.authoringRoute.routeIndependenceKey;
    expect(() => compileAudit(collidingRoute)).toThrow(/route limitation|does not bind/);

    const substitutedAnchor = clone(specificationInput) as Stage18Specification;
    (substitutedAnchor.subjectAnchorPaths as string[])[0] = substitutedAnchor.matrixPath;
    expect(() => compileAudit(substitutedAnchor)).toThrow(/Subject anchor path inventory/);

    const familyDrift = clone(specificationInput) as Stage18Specification;
    (familyDrift.auditRoute as { family: string }).family = "other-family";
    expect(() => compileAudit(familyDrift)).toThrow(/route identities or same-family/);

    const rejectedConcern = clone(specificationInput) as Stage18Specification;
    const securityConcern = (rejectedConcern.concernDispositions as Stage18Specification["concernDispositions"])
      .find((item) => item.concern === "security")!;
    (securityConcern as { disposition: string }).disposition = "rejected";
    expect(() => compileAudit(rejectedConcern)).toThrow(/inconsistent disposition/);

    const emptyConcernReason = clone(specificationInput) as Stage18Specification;
    const privacyConcern = (emptyConcernReason.concernDispositions as Stage18Specification["concernDispositions"])
      .find((item) => item.concern === "privacy")!;
    (privacyConcern as { reason: string }).reason = "";
    expect(() => compileAudit(emptyConcernReason)).toThrow(/inconsistent disposition/);

    const oversizedConcernReason = clone(specificationInput) as Stage18Specification;
    const operationsConcern = (oversizedConcernReason.concernDispositions as Stage18Specification["concernDispositions"])
      .find((item) => item.concern === "operations")!;
    (operationsConcern as { reason: string }).reason = "x".repeat(1_025);
    expect(() => compileAudit(oversizedConcernReason)).toThrow(/inconsistent disposition/);

    const acceptedAccessibility = clone(specificationInput) as Stage18Specification;
    const accessibilityConcern = (acceptedAccessibility.concernDispositions as Stage18Specification["concernDispositions"])
      .find((item) => item.concern === "accessibility")!;
    (accessibilityConcern as { disposition: string }).disposition = "accepted";
    expect(() => compileAudit(acceptedAccessibility)).toThrow(/inconsistent disposition/);
  });

  it("rejects wrong source identities, status confusion, and removed coverage edges", () => {
    const wrongTree = clone(specificationInput) as Stage18Specification;
    (wrongTree as { sourceTreeSha: string }).sourceTreeSha = "0".repeat(40);
    expect(() => compileAudit(wrongTree)).toThrow(/authority or subject identity/);

    const promotedMatrix = clone(subjectJson("docs/release-evidence/stage-18-development-acceptance-matrix.json")) as Matrix;
    const anthropic = (promotedMatrix.rows as MatrixRow[]).find((row) => row.id === "ANT-02")!;
    (anthropic as { status: MatrixStatus }).status = "proven";
    expect(() => compileAudit(specificationInput, promotedMatrix)).toThrow(/status differs/);

    for (const changedMatrix of [
      { sourceBase: "0".repeat(40) },
      { permittedOutcome: "Stage 18 accepted" },
      { checkpointRows: ["ADM-01"] },
    ]) {
      const changed = Object.assign(
        clone(subjectJson("docs/release-evidence/stage-18-development-acceptance-matrix.json")) as Matrix,
        changedMatrix,
      );
      expect(() => compileAudit(specificationInput, changed)).toThrow(/Matrix envelope differs/);
    }

    const bundle = compiledAudit;
    expect(() => createEvaluationSubject({
      repositoryId: bundle.subject.repositoryId,
      headSha: bundle.subject.headSha,
      treeSha: bundle.subject.treeSha,
      productSpecificationId: bundle.subject.productSpecificationId,
      productSpecificationDigest: bundle.subject.productSpecificationDigest,
      requirementIds: bundle.subject.requirementIds,
      taskIds: bundle.subject.taskIds,
      resultIds: bundle.subject.resultIds,
      coverageEdges: bundle.subject.coverageEdges.slice(1),
    })).toThrow();
  });

  it("does not let narrative approval, a reduced manifest, or a fabricated waiver pass", () => {
    const bundle = compiledAudit;
    const narrativeRequest = createEvaluationRequest({
      ...requestBody(bundle.request),
      advisories: [{
        advisoryId: "advisory:stage18:false-pass",
        criterionId: "criterion:stage18:ANT-02",
        routeIndependenceKey: "f".repeat(64),
        recommendation: "pass",
        summary: "Narrative approval is not deterministic evidence.",
        observedAt: CREATED_AT,
      }],
    });
    const narrativeResult = evaluateDeterministically(narrativeRequest, EVALUATED_AT, bundle.authorityConfiguration);
    expect(narrativeResult.decision).toBe("rejected");
    expect(narrativeResult.blockingCriterionIds).toContain("criterion:stage18:ANT-02");
    expect(narrativeResult.disagreements).toHaveLength(1);

    const removedId = "criterion:stage18:PLN-02";
    const reducedRequest = createEvaluationRequest({
      ...requestBody(bundle.request),
      criteria: bundle.criteria.filter((item) => item.criterionId !== removedId),
      evidence: bundle.evidence.filter((item) => item.criterionId !== removedId),
      advisories: [],
    });
    const reducedResult = evaluateDeterministically(reducedRequest, EVALUATED_AT, bundle.authorityConfiguration);
    expect(reducedResult.decision).toBe("rejected");
    expect(reducedResult.requestRuleCodes).toEqual(["CRITERION_MANIFEST_UNAUTHORIZED"]);
    expect(reducedResult.criterionManifestDigest).not.toBe(bundle.result.criterionManifestDigest);

    const criterion = bundle.criteria.find((item) => item.criterionId === "criterion:stage18:ANT-02")!;
    const waivedRequest = createEvaluationRequest({
      ...requestBody(bundle.request),
      waivers: [{
        waiverId: "waiver:stage18:fabricated",
        criterionId: criterion.criterionId,
        subjectDigest: bundle.subject.subjectDigest,
        configurationDigest: criterion.configurationDigest,
        authority: "product-owner",
        approvalReference: "approval:fabricated",
        reason: "An inline claim cannot authorize itself.",
        approvedAt: CREATED_AT,
        expiresAt: DEADLINE,
      }],
    });
    const waivedResult = evaluateDeterministically(waivedRequest, EVALUATED_AT, bundle.authorityConfiguration);
    const anthropicResult = waivedResult.criteria.find((item) => item.criterionId === criterion.criterionId)!;
    expect(waivedResult.decision).toBe("rejected");
    expect(anthropicResult.outcome).toBe("missing");
    expect(anthropicResult.ruleCodes).toContain("UNVERIFIED_WAIVER_IGNORED");
  });

  it("rejects duplicated, stale, wrong-head, and artifact-substituted evidence", () => {
    const bundle = compiledAudit;
    expect(() => createEvaluationRequest({
      ...requestBody(bundle.request),
      evidence: [...bundle.evidence, bundle.evidence[0]],
    })).toThrow();

    const target = bundle.evidence.find((item) => item.criterionId === "criterion:stage18:ANT-02")!;
    for (const changed of [
      { ...target, headSha: "0".repeat(40) },
      { ...target, validUntil: CREATED_AT },
      { ...target, artifactDigests: ["0".repeat(64)] },
    ]) {
      const request = createEvaluationRequest({
        ...requestBody(bundle.request),
        evidence: bundle.evidence.map((item) => item.evidenceId === target.evidenceId ? changed : item),
      });
      const result = evaluateDeterministically(request, EVALUATED_AT, bundle.authorityConfiguration);
      const evaluated = result.criteria.find((item) => item.criterionId === target.criterionId)!;
      expect(result.decision).toBe("rejected");
      expect(evaluated.outcome).toBe("missing");
      expect(evaluated.ruleCodes).toContain("EVIDENCE_INVALID");
    }
  });
});
