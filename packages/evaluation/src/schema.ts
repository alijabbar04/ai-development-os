import { createHash } from "node:crypto";
import {
  canonicalizeJson,
  toCanonicalJson,
  validation,
  type JsonObject,
} from "@ai-dev-os/domain";
import {
  EVALUATION_CRITICALITIES,
  EVALUATION_KINDS,
  EVALUATION_SCHEMA_VERSION,
  type EvaluationAuthorityConfiguration,
  type EvaluationCriterion,
  type EvaluationEvidence,
  type EvaluationKind,
  type EvaluationRequest,
  type EvaluationSubject,
  type EvaluationWaiver,
  type ModelAdvisory,
  type RequirementCoverageEdge,
} from "./contracts.js";
import { EvaluationError } from "./errors.js";

const {
  ensureArray,
  ensureBoolean,
  ensureEnum,
  ensureExactKeys,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
  ensureString,
  ensureTimestamp,
} = validation;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const FAILURE_CODE = /^[a-z][a-z0-9._-]{0,63}$/;
const MAX_CRITERIA = 256;
const MAX_EVIDENCE = 1_024;
const MAX_WAIVERS = 256;
const MAX_ADVISORIES = 128;
const MAX_IDENTITIES = 2_048;
const MAX_PATHS = 4_096;
const MAX_ARTIFACTS = 1_024;
const MAX_COVERAGE_EDGES = 4_096;
// Keep the request below the domain JSON ceiling so the persisted authority
// configuration, deterministic result, run snapshot, and event envelope always
// have reserved node capacity. The closed collection maxima keep those derived
// projections below the remaining 25,000 nodes.
const MAX_REQUEST_NODES = 75_000;
const MAX_REQUEST_TEXT = 2_000_000;
const MAX_REQUEST_DEPTH = 32;

export const EVALUATION_LIMITS = Object.freeze({
  maximumCriteria: MAX_CRITERIA,
  maximumEvidence: MAX_EVIDENCE,
  maximumWaivers: MAX_WAIVERS,
  maximumAdvisories: MAX_ADVISORIES,
  maximumIdentities: MAX_IDENTITIES,
  maximumPaths: MAX_PATHS,
  maximumArtifacts: MAX_ARTIFACTS,
  maximumCoverageEdges: MAX_COVERAGE_EDGES,
  maximumRequestNodes: MAX_REQUEST_NODES,
  maximumRequestText: MAX_REQUEST_TEXT,
  maximumRequestDepth: MAX_REQUEST_DEPTH,
  maximumAttempts: 8,
  maximumJournalEvents: 9,
});

export function assertEvaluationInputBudget(value: unknown): void {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let text = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_REQUEST_NODES || current.depth > MAX_REQUEST_DEPTH) {
      throw new EvaluationError("LIMIT_EXCEEDED", "Evaluation request exceeds its structural work bound.", {
        maximumNodes: MAX_REQUEST_NODES,
        maximumDepth: MAX_REQUEST_DEPTH,
      });
    }
    const item = current.value;
    if (typeof item === "string") {
      text += item.length;
      if (text > MAX_REQUEST_TEXT) {
        throw new EvaluationError("LIMIT_EXCEEDED", "Evaluation request exceeds its cumulative text bound.", {
          maximumText: MAX_REQUEST_TEXT,
        });
      }
      continue;
    }
    if (item === null || typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new EvaluationError("INVALID_INPUT", "Evaluation request contains a non-finite number.");
      continue;
    }
    if (typeof item !== "object") throw new EvaluationError("INVALID_INPUT", "Evaluation request contains a non-data value.");
    if (seen.has(item)) throw new EvaluationError("INVALID_INPUT", "Evaluation request cannot contain cyclic or aliased objects.");
    seen.add(item);
    const prototype = Object.getPrototypeOf(item) as object | null;
    if (Array.isArray(item)) {
      if (prototype !== Array.prototype || item.length > MAX_REQUEST_NODES) {
        throw new EvaluationError("LIMIT_EXCEEDED", "Evaluation request contains an oversized or exotic array.");
      }
    } else if (prototype !== Object.prototype && prototype !== null) {
      throw new EvaluationError("INVALID_INPUT", "Evaluation request must contain only plain data objects.");
    }
    const keys = Reflect.ownKeys(item);
    if (keys.length > MAX_REQUEST_NODES || keys.some((key) => typeof key !== "string")) {
      throw new EvaluationError("LIMIT_EXCEEDED", "Evaluation request contains an oversized or symbol-keyed object.");
    }
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const key of keys as string[]) {
      if (!Array.isArray(item)) {
        text += key.length;
        if (text > MAX_REQUEST_TEXT) throw new EvaluationError("LIMIT_EXCEEDED", "Evaluation request exceeds its cumulative text bound.", { maximumText: MAX_REQUEST_TEXT });
      }
      if (key === "length") continue;
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        throw new EvaluationError("INVALID_INPUT", "Evaluation request fields must be enumerable data properties.");
      }
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
}

export function evaluationDigest(value: unknown): string {
  return createHash("sha256")
    .update(toCanonicalJson(canonicalizeJson(value, "evaluationDigest")))
    .digest("hex");
}

export function stableEvaluationId(prefix: string, ...parts: readonly string[]): string {
  const digest = evaluationDigest(parts).slice(0, 32);
  return `${prefix}:${digest}`;
}

export function compareEvaluationText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseEvaluationId(value: unknown, path: string): string {
  return ensureString(value, path, { maxLength: 128, pattern: ID, patternName: "identifier" });
}

export function parseEvaluationDigest(value: unknown, path: string): string {
  return ensureString(value, path, {
    minLength: 64,
    maxLength: 64,
    pattern: DIGEST,
    patternName: "sha-256 digest",
  });
}

export function parseFailureCode(value: unknown, path: string): string {
  return ensureString(value, path, {
    maxLength: 64,
    pattern: FAILURE_CODE,
    patternName: "finite failure code",
  });
}

function parseRevision(value: unknown, path: string): string {
  return ensureString(value, path, {
    minLength: 40,
    maxLength: 64,
    pattern: REVISION,
    patternName: "Git object identifier",
  });
}

function parseText(value: unknown, path: string, maximum = 4_000): string {
  const text = ensureString(value, path, { maxLength: maximum })
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
  if (text.length === 0) {
    throw new EvaluationError("INVALID_INPUT", "Evaluation text cannot be empty.", { path });
  }
  return text;
}

function parseUniqueIds(value: unknown, path: string, maximum = MAX_IDENTITIES): readonly string[] {
  const items = ensureArray(value, path, maximum).map((item, index) =>
    parseEvaluationId(item, `${path}[${index}]`),
  );
  if (new Set(items).size !== items.length) {
    throw new EvaluationError("INVALID_INPUT", "Evaluation identity lists cannot contain duplicates.", { path });
  }
  return Object.freeze([...items].sort(compareEvaluationText));
}

function parseCoverageEdges(value: unknown, path: string): readonly RequirementCoverageEdge[] {
  const edges = ensureArray(value, path, MAX_COVERAGE_EDGES).map((item, index) => {
    const edge = ensureRecord(item, `${path}[${index}]`);
    ensureExactKeys(edge, ["requirementId", "taskId", "resultId"], `${path}[${index}]`);
    return Object.freeze({
      requirementId: parseEvaluationId(edge["requirementId"], `${path}[${index}].requirementId`),
      taskId: parseEvaluationId(edge["taskId"], `${path}[${index}].taskId`),
      resultId: parseEvaluationId(edge["resultId"], `${path}[${index}].resultId`),
    });
  });
  const keys = edges.map((edge) => `${edge.requirementId}\u001f${edge.taskId}\u001f${edge.resultId}`);
  if (new Set(keys).size !== keys.length) {
    throw new EvaluationError("INVALID_INPUT", "Requirement coverage edges cannot contain duplicates.", { path });
  }
  return Object.freeze([...edges].sort((left, right) =>
    compareEvaluationText(left.requirementId, right.requirementId) ||
    compareEvaluationText(left.taskId, right.taskId) ||
    compareEvaluationText(left.resultId, right.resultId),
  ));
}

function parseUniqueDigests(value: unknown, path: string): readonly string[] {
  const items = ensureArray(value, path, MAX_ARTIFACTS).map((item, index) =>
    parseEvaluationDigest(item, `${path}[${index}]`),
  );
  if (new Set(items).size !== items.length) {
    throw new EvaluationError("INVALID_INPUT", "Artifact digest lists cannot contain duplicates.", { path });
  }
  return Object.freeze([...items].sort(compareEvaluationText));
}

function parseRelativePath(value: unknown, path: string): string {
  const candidate = ensureString(value, path, { maxLength: 512 });
  if (
    candidate.includes("\\") ||
    candidate.startsWith("/") ||
    /^[A-Za-z]:/.test(candidate) ||
    candidate.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new EvaluationError("INVALID_INPUT", "Evaluation paths must be normalized relative paths.", { path });
  }
  return candidate;
}

function parsePathList(value: unknown, path: string): readonly string[] {
  const items = ensureArray(value, path, MAX_PATHS).map((item, index) =>
    parseRelativePath(item, `${path}[${index}]`),
  );
  if (new Set(items).size !== items.length) {
    throw new EvaluationError("INVALID_INPUT", "Evaluation path lists cannot contain duplicates.", { path });
  }
  return Object.freeze([...items].sort(compareEvaluationText));
}

function dataObject(value: unknown, path: string): Record<string, unknown> {
  return ensureRecord(value, path);
}

function frozenData(value: Record<string, unknown>, path: string): JsonObject {
  const result = canonicalizeJson(value, path);
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new EvaluationError("INVALID_INPUT", "Evaluation evidence data must be an object.", { path });
  }
  return result as JsonObject;
}

function parseEvidenceData(kind: EvaluationKind, value: unknown, path: string): JsonObject {
  const record = dataObject(value, path);
  switch (kind) {
    case "output-schema":
      ensureExactKeys(record, ["parsed", "schemaDigest", "violationCount"], path);
      return frozenData({
        parsed: ensureBoolean(record["parsed"], `${path}.parsed`),
        schemaDigest: parseEvaluationDigest(record["schemaDigest"], `${path}.schemaDigest`),
        violationCount: ensureSafeInteger(record["violationCount"], `${path}.violationCount`, 0, 100_000),
      }, path);
    case "changed-paths":
      ensureExactKeys(record, ["changedPaths", "allowedPaths"], path);
      return frozenData({
        changedPaths: parsePathList(record["changedPaths"], `${path}.changedPaths`),
        allowedPaths: parsePathList(record["allowedPaths"], `${path}.allowedPaths`),
      }, path);
    case "compilation":
      ensureExactKeys(record, ["exitCode", "commandDigest"], path);
      return frozenData({
        exitCode: ensureSafeInteger(record["exitCode"], `${path}.exitCode`, 0, 255),
        commandDigest: parseEvaluationDigest(record["commandDigest"], `${path}.commandDigest`),
      }, path);
    case "tests":
      ensureExactKeys(record, ["passed", "failed", "skipped", "expectedSkips", "suiteDigest"], path);
      return frozenData({
        passed: ensureSafeInteger(record["passed"], `${path}.passed`, 0, 10_000_000),
        failed: ensureSafeInteger(record["failed"], `${path}.failed`, 0, 10_000_000),
        skipped: ensureSafeInteger(record["skipped"], `${path}.skipped`, 0, 10_000_000),
        expectedSkips: ensureSafeInteger(record["expectedSkips"], `${path}.expectedSkips`, 0, 10_000_000),
        suiteDigest: parseEvaluationDigest(record["suiteDigest"], `${path}.suiteDigest`),
      }, path);
    case "static-analysis":
      ensureExactKeys(record, ["blockingFindings", "totalFindings", "reportDigest"], path);
      return frozenData({
        blockingFindings: ensureSafeInteger(record["blockingFindings"], `${path}.blockingFindings`, 0, 1_000_000),
        totalFindings: ensureSafeInteger(record["totalFindings"], `${path}.totalFindings`, 0, 1_000_000),
        reportDigest: parseEvaluationDigest(record["reportDigest"], `${path}.reportDigest`),
      }, path);
    case "acceptance-criteria":
      ensureExactKeys(record, ["satisfied", "requirementDigest"], path);
      return frozenData({
        satisfied: ensureBoolean(record["satisfied"], `${path}.satisfied`),
        requirementDigest: parseEvaluationDigest(record["requirementDigest"], `${path}.requirementDigest`),
      }, path);
    case "requirement-coverage":
      ensureExactKeys(record, ["requirementIds", "taskIds", "resultIds", "coverageEdges"], path);
      {
        const requirementIds = parseUniqueIds(record["requirementIds"], `${path}.requirementIds`);
        const taskIds = parseUniqueIds(record["taskIds"], `${path}.taskIds`);
        const resultIds = parseUniqueIds(record["resultIds"], `${path}.resultIds`);
        const coverageEdges = parseCoverageEdges(record["coverageEdges"], `${path}.coverageEdges`);
        const edgeRequirements = [...new Set(coverageEdges.map((edge) => edge.requirementId))].sort(compareEvaluationText);
        const edgeTasks = [...new Set(coverageEdges.map((edge) => edge.taskId))].sort(compareEvaluationText);
        const edgeResults = [...new Set(coverageEdges.map((edge) => edge.resultId))].sort(compareEvaluationText);
        if (JSON.stringify(requirementIds) !== JSON.stringify(edgeRequirements) ||
            JSON.stringify(taskIds) !== JSON.stringify(edgeTasks) ||
            JSON.stringify(resultIds) !== JSON.stringify(edgeResults)) {
          throw new EvaluationError("INVALID_INPUT", "Coverage identity sets must equal their explicit requirement-task-result edges.", { path });
        }
        return frozenData({ requirementIds, taskIds, resultIds, coverageEdges }, path);
      }
    case "repository-state":
      ensureExactKeys(record, ["headSha", "treeSha"], path);
      {
        const headSha = parseRevision(record["headSha"], `${path}.headSha`);
        const treeSha = parseRevision(record["treeSha"], `${path}.treeSha`);
        if (headSha.length !== treeSha.length) {
          throw new EvaluationError("INVALID_INPUT", "Repository evidence must use one Git object format.", { path });
        }
        return frozenData({ headSha, treeSha }, path);
      }
  }
}

export function createEvaluationSubject(value: unknown, path = "subject"): EvaluationSubject {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, [
    "repositoryId",
    "headSha",
    "treeSha",
    "productSpecificationId",
    "productSpecificationDigest",
    "requirementIds",
    "taskIds",
    "resultIds",
    "coverageEdges",
  ], path);
  const requirementIds = parseUniqueIds(record["requirementIds"], `${path}.requirementIds`);
  const taskIds = parseUniqueIds(record["taskIds"], `${path}.taskIds`);
  const resultIds = parseUniqueIds(record["resultIds"], `${path}.resultIds`);
  const coverageEdges = parseCoverageEdges(record["coverageEdges"], `${path}.coverageEdges`);
  const headSha = parseRevision(record["headSha"], `${path}.headSha`);
  const treeSha = parseRevision(record["treeSha"], `${path}.treeSha`);
  if (headSha.length !== treeSha.length) {
    throw new EvaluationError("INVALID_INPUT", "Evaluation subject must use one Git object format.", { path });
  }
  const requirementSet = new Set(requirementIds);
  const taskSet = new Set(taskIds);
  const resultSet = new Set(resultIds);
  if (coverageEdges.some((edge) => !requirementSet.has(edge.requirementId) || !taskSet.has(edge.taskId) || !resultSet.has(edge.resultId)) ||
      requirementIds.some((id) => !coverageEdges.some((edge) => edge.requirementId === id)) ||
      taskIds.some((id) => !coverageEdges.some((edge) => edge.taskId === id)) ||
      resultIds.some((id) => !coverageEdges.some((edge) => edge.resultId === id))) {
    throw new EvaluationError("INVALID_INPUT", "Evaluation subject identities must be connected by explicit in-subject coverage edges.", { path });
  }
  const base = Object.freeze({
    repositoryId: parseEvaluationId(record["repositoryId"], `${path}.repositoryId`),
    headSha,
    treeSha,
    productSpecificationId: parseEvaluationId(record["productSpecificationId"], `${path}.productSpecificationId`),
    productSpecificationDigest: parseEvaluationDigest(record["productSpecificationDigest"], `${path}.productSpecificationDigest`),
    requirementIds,
    taskIds,
    resultIds,
    coverageEdges,
  });
  return Object.freeze({ ...base, subjectDigest: evaluationDigest(base) });
}

function parseEvaluationSubject(value: unknown, path: string): EvaluationSubject {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, [
    "repositoryId", "headSha", "treeSha", "productSpecificationId", "productSpecificationDigest",
    "requirementIds", "taskIds", "resultIds", "coverageEdges", "subjectDigest",
  ], path);
  const subject = createEvaluationSubject({
    repositoryId: record["repositoryId"],
    headSha: record["headSha"],
    treeSha: record["treeSha"],
    productSpecificationId: record["productSpecificationId"],
    productSpecificationDigest: record["productSpecificationDigest"],
    requirementIds: record["requirementIds"],
    taskIds: record["taskIds"],
    resultIds: record["resultIds"],
    coverageEdges: record["coverageEdges"],
  }, path);
  if (parseEvaluationDigest(record["subjectDigest"], `${path}.subjectDigest`) !== subject.subjectDigest) {
    throw new EvaluationError("INVALID_INPUT", "Evaluation subject digest does not match its canonical fields.");
  }
  return subject;
}

function parseCriterion(value: unknown, path: string): EvaluationCriterion {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, [
    "criterionId", "kind", "criticality", "requirementId", "description", "evaluatorId",
    "evaluatorVersion", "configurationDigest", "evidenceContractDigest", "expectedArtifactDigests",
  ], path);
  const requirementId = record["requirementId"] === null
    ? null
    : parseEvaluationId(record["requirementId"], `${path}.requirementId`);
  return Object.freeze({
    criterionId: parseEvaluationId(record["criterionId"], `${path}.criterionId`),
    kind: ensureEnum(record["kind"], `${path}.kind`, EVALUATION_KINDS),
    criticality: ensureEnum(record["criticality"], `${path}.criticality`, EVALUATION_CRITICALITIES),
    requirementId,
    description: parseText(record["description"], `${path}.description`, 1_000),
    evaluatorId: parseEvaluationId(record["evaluatorId"], `${path}.evaluatorId`),
    evaluatorVersion: ensureString(record["evaluatorVersion"], `${path}.evaluatorVersion`, { maxLength: 64, pattern: VERSION, patternName: "evaluator version" }),
    configurationDigest: parseEvaluationDigest(record["configurationDigest"], `${path}.configurationDigest`),
    evidenceContractDigest: parseEvaluationDigest(record["evidenceContractDigest"], `${path}.evidenceContractDigest`),
    expectedArtifactDigests: parseUniqueDigests(
      record["expectedArtifactDigests"],
      `${path}.expectedArtifactDigests`,
    ),
  });
}

export function evaluationCriterionManifestDigest(
  subjectDigestValue: unknown,
  criteriaValue: unknown,
): string {
  const subjectDigest = parseEvaluationDigest(subjectDigestValue, "subjectDigest");
  assertEvaluationInputBudget(criteriaValue);
  const criteria = ensureArray(criteriaValue, "criteria", MAX_CRITERIA).map((item, index) =>
    parseCriterion(item, `criteria[${index}]`),
  );
  return evaluationDigest({
    subjectDigest,
    criteria: [...criteria].sort((left, right) =>
      compareEvaluationText(left.criterionId, right.criterionId),
    ),
  });
}

function parseEvidence(value: unknown, path: string): EvaluationEvidence {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, [
    "evidenceId", "criterionId", "kind", "evaluatorId", "evaluatorVersion", "configurationDigest",
    "subjectDigest", "repositoryId", "headSha", "treeSha", "inputDigest", "artifactDigests",
    "observedAt", "validUntil", "data",
  ], path);
  const kind = ensureEnum(record["kind"], `${path}.kind`, EVALUATION_KINDS);
  const observedAt = ensureTimestamp(record["observedAt"], `${path}.observedAt`);
  const validUntil = ensureTimestamp(record["validUntil"], `${path}.validUntil`);
  if (validUntil < observedAt) {
    throw new EvaluationError("INVALID_INPUT", "Evidence validity cannot end before observation.", { path });
  }
  return Object.freeze({
    evidenceId: parseEvaluationId(record["evidenceId"], `${path}.evidenceId`),
    criterionId: parseEvaluationId(record["criterionId"], `${path}.criterionId`),
    kind,
    evaluatorId: parseEvaluationId(record["evaluatorId"], `${path}.evaluatorId`),
    evaluatorVersion: ensureString(record["evaluatorVersion"], `${path}.evaluatorVersion`, { maxLength: 64, pattern: VERSION, patternName: "evaluator version" }),
    configurationDigest: parseEvaluationDigest(record["configurationDigest"], `${path}.configurationDigest`),
    subjectDigest: parseEvaluationDigest(record["subjectDigest"], `${path}.subjectDigest`),
    repositoryId: parseEvaluationId(record["repositoryId"], `${path}.repositoryId`),
    headSha: parseRevision(record["headSha"], `${path}.headSha`),
    treeSha: parseRevision(record["treeSha"], `${path}.treeSha`),
    inputDigest: parseEvaluationDigest(record["inputDigest"], `${path}.inputDigest`),
    artifactDigests: parseUniqueDigests(record["artifactDigests"], `${path}.artifactDigests`),
    observedAt,
    validUntil,
    data: parseEvidenceData(kind, record["data"], `${path}.data`),
  });
}

function parseWaiver(value: unknown, path: string): EvaluationWaiver {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, [
    "waiverId", "criterionId", "subjectDigest", "configurationDigest", "authority",
    "approvalReference", "reason", "approvedAt", "expiresAt",
  ], path);
  const approvedAt = ensureTimestamp(record["approvedAt"], `${path}.approvedAt`);
  const expiresAt = ensureTimestamp(record["expiresAt"], `${path}.expiresAt`);
  if (expiresAt < approvedAt) {
    throw new EvaluationError("INVALID_INPUT", "Waiver expiry cannot precede approval.", { path });
  }
  return Object.freeze({
    waiverId: parseEvaluationId(record["waiverId"], `${path}.waiverId`),
    criterionId: parseEvaluationId(record["criterionId"], `${path}.criterionId`),
    subjectDigest: parseEvaluationDigest(record["subjectDigest"], `${path}.subjectDigest`),
    configurationDigest: parseEvaluationDigest(record["configurationDigest"], `${path}.configurationDigest`),
    authority: ensureEnum(record["authority"], `${path}.authority`, ["operator", "product-owner", "security-reviewer"] as const),
    approvalReference: parseEvaluationId(record["approvalReference"], `${path}.approvalReference`),
    reason: parseText(record["reason"], `${path}.reason`, 2_000),
    approvedAt,
    expiresAt,
  });
}

export function evaluationWaiverDigest(value: unknown, path = "waiver"): string {
  return evaluationDigest(parseWaiver(value, path));
}

function parseAuthorityConfigurationBody(
  value: unknown,
  path: string,
  full: boolean,
): Omit<EvaluationAuthorityConfiguration, "configurationFingerprint"> & {
  readonly configurationFingerprint?: string;
} {
  assertEvaluationInputBudget(value);
  const record = ensureRecord(value, path);
  const baseKeys = [
    "schemaVersion",
    "configurationId",
    "authorizedCriterionManifestDigests",
    "authorizedEvidenceDigests",
    "authorizedWaiverDigests",
  ];
  ensureExactKeys(record, full ? [...baseKeys, "configurationFingerprint"] : baseKeys, path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, EVALUATION_SCHEMA_VERSION);
  const authorizedCriterionManifestDigests = ensureArray(
    record["authorizedCriterionManifestDigests"],
    `${path}.authorizedCriterionManifestDigests`,
    MAX_CRITERIA,
  ).map((item, index) => parseEvaluationDigest(
    item,
    `${path}.authorizedCriterionManifestDigests[${index}]`,
  ));
  const authorizedWaiverDigests = ensureArray(
    record["authorizedWaiverDigests"],
    `${path}.authorizedWaiverDigests`,
    MAX_WAIVERS,
  ).map((item, index) => parseEvaluationDigest(item, `${path}.authorizedWaiverDigests[${index}]`));
  const authorizedEvidenceDigests = ensureArray(
    record["authorizedEvidenceDigests"],
    `${path}.authorizedEvidenceDigests`,
    MAX_EVIDENCE,
  ).map((item, index) => parseEvaluationDigest(item, `${path}.authorizedEvidenceDigests[${index}]`));
  if (new Set(authorizedCriterionManifestDigests).size !== authorizedCriterionManifestDigests.length ||
      new Set(authorizedEvidenceDigests).size !== authorizedEvidenceDigests.length ||
      new Set(authorizedWaiverDigests).size !== authorizedWaiverDigests.length) {
    throw new EvaluationError("INVALID_INPUT", "Authorized evaluation digests cannot contain duplicates.");
  }
  const body = Object.freeze({
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    configurationId: parseEvaluationId(record["configurationId"], `${path}.configurationId`),
    authorizedCriterionManifestDigests: Object.freeze(
      [...authorizedCriterionManifestDigests].sort(compareEvaluationText),
    ),
    authorizedEvidenceDigests: Object.freeze([...authorizedEvidenceDigests].sort(compareEvaluationText)),
    authorizedWaiverDigests: Object.freeze([...authorizedWaiverDigests].sort(compareEvaluationText)),
  });
  return full
    ? Object.freeze({
        ...body,
        configurationFingerprint: parseEvaluationDigest(
          record["configurationFingerprint"],
          `${path}.configurationFingerprint`,
        ),
      })
    : body;
}

export function createEvaluationAuthorityConfiguration(
  value: unknown,
  path = "authorityConfiguration",
): EvaluationAuthorityConfiguration {
  const body = parseAuthorityConfigurationBody(value, path, false);
  return Object.freeze({ ...body, configurationFingerprint: evaluationDigest(body) });
}

export function parseEvaluationAuthorityConfiguration(
  value: unknown,
  path = "authorityConfiguration",
): EvaluationAuthorityConfiguration {
  const body = parseAuthorityConfigurationBody(value, path, true);
  const configurationFingerprint = body.configurationFingerprint!;
  const canonicalBody = { ...body } as Record<string, unknown>;
  delete canonicalBody["configurationFingerprint"];
  if (evaluationDigest(canonicalBody) !== configurationFingerprint) {
    throw new EvaluationError("INVALID_INPUT", "Evaluation authority configuration fingerprint is inconsistent.");
  }
  return Object.freeze(body as EvaluationAuthorityConfiguration);
}

export const EMPTY_EVALUATION_AUTHORITY_CONFIGURATION = createEvaluationAuthorityConfiguration({
  schemaVersion: EVALUATION_SCHEMA_VERSION,
  configurationId: "evaluation-authority:none",
  authorizedCriterionManifestDigests: [],
  authorizedEvidenceDigests: [],
  authorizedWaiverDigests: [],
});

function parseAdvisory(value: unknown, path: string): ModelAdvisory {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["advisoryId", "criterionId", "routeIndependenceKey", "recommendation", "summary", "observedAt"], path);
  return Object.freeze({
    advisoryId: parseEvaluationId(record["advisoryId"], `${path}.advisoryId`),
    criterionId: parseEvaluationId(record["criterionId"], `${path}.criterionId`),
    routeIndependenceKey: parseEvaluationDigest(record["routeIndependenceKey"], `${path}.routeIndependenceKey`),
    recommendation: ensureEnum(record["recommendation"], `${path}.recommendation`, ["pass", "fail", "uncertain"] as const),
    summary: parseText(record["summary"], `${path}.summary`, 2_000),
    observedAt: ensureTimestamp(record["observedAt"], `${path}.observedAt`),
  });
}

function parseRequestBody(value: unknown, path: string, full: boolean): Omit<EvaluationRequest, "requestDigest"> & { readonly requestDigest?: string } {
  assertEvaluationInputBudget(value);
  const record = ensureRecord(value, path);
  const baseKeys = ["schemaVersion", "runId", "subject", "criteria", "evidence", "waivers", "advisories", "createdAt", "deadline", "maximumAttempts"];
  ensureExactKeys(record, full ? [...baseKeys, "requestDigest"] : baseKeys, path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, EVALUATION_SCHEMA_VERSION);
  const subject = parseEvaluationSubject(record["subject"], `${path}.subject`);
  const criteria = ensureArray(record["criteria"], `${path}.criteria`, MAX_CRITERIA).map((item, index) => parseCriterion(item, `${path}.criteria[${index}]`));
  const evidence = ensureArray(record["evidence"], `${path}.evidence`, MAX_EVIDENCE).map((item, index) => parseEvidence(item, `${path}.evidence[${index}]`));
  const waivers = ensureArray(record["waivers"], `${path}.waivers`, MAX_WAIVERS).map((item, index) => parseWaiver(item, `${path}.waivers[${index}]`));
  const advisories = ensureArray(record["advisories"], `${path}.advisories`, MAX_ADVISORIES).map((item, index) => parseAdvisory(item, `${path}.advisories[${index}]`));
  if (criteria.length === 0) {
    throw new EvaluationError("INVALID_INPUT", "At least one evaluation criterion is required.");
  }
  for (const [label, values] of [["criterion", criteria.map((item) => item.criterionId)], ["evidence", evidence.map((item) => item.evidenceId)], ["waiver", waivers.map((item) => item.waiverId)], ["advisory", advisories.map((item) => item.advisoryId)] ] as const) {
    if (new Set(values).size !== values.length) throw new EvaluationError("INVALID_INPUT", `Evaluation ${label} identifiers must be unique.`);
  }
  const criterionIds = new Set(criteria.map((item) => item.criterionId));
  const requirementIds = new Set(subject.requirementIds);
  if (criteria.some((item) => item.requirementId !== null && !requirementIds.has(item.requirementId))) {
    throw new EvaluationError("INVALID_INPUT", "A criterion references a requirement outside the exact subject.");
  }
  if ([...evidence, ...waivers, ...advisories].some((item) => !criterionIds.has(item.criterionId))) {
    throw new EvaluationError("INVALID_INPUT", "Evidence, waivers, and advisories must reference declared criteria.");
  }
  const createdAt = ensureTimestamp(record["createdAt"], `${path}.createdAt`);
  const deadline = ensureTimestamp(record["deadline"], `${path}.deadline`);
  if (deadline <= createdAt) throw new EvaluationError("INVALID_INPUT", "Evaluation deadline must follow creation.");
  const result = {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    runId: parseEvaluationId(record["runId"], `${path}.runId`),
    subject,
    criteria: Object.freeze([...criteria].sort((a, b) => compareEvaluationText(a.criterionId, b.criterionId))),
    evidence: Object.freeze([...evidence].sort((a, b) => compareEvaluationText(a.evidenceId, b.evidenceId))),
    waivers: Object.freeze([...waivers].sort((a, b) => compareEvaluationText(a.waiverId, b.waiverId))),
    advisories: Object.freeze([...advisories].sort((a, b) => compareEvaluationText(a.advisoryId, b.advisoryId))),
    createdAt,
    deadline,
    maximumAttempts: ensureSafeInteger(record["maximumAttempts"], `${path}.maximumAttempts`, 1, EVALUATION_LIMITS.maximumAttempts),
  } as const;
  return full ? { ...result, requestDigest: parseEvaluationDigest(record["requestDigest"], `${path}.requestDigest`) } : result;
}

export function createEvaluationRequest(value: unknown, path = "evaluationRequest"): EvaluationRequest {
  const body = parseRequestBody(value, path, false);
  return Object.freeze({ ...body, requestDigest: evaluationDigest(body) });
}

export function parseEvaluationRequest(value: unknown, path = "evaluationRequest"): EvaluationRequest {
  const body = parseRequestBody(value, path, true);
  const requestDigest = body.requestDigest!;
  const canonicalBody = { ...body } as Record<string, unknown>;
  delete canonicalBody["requestDigest"];
  if (evaluationDigest(canonicalBody) !== requestDigest) {
    throw new EvaluationError("INVALID_INPUT", "Evaluation request digest does not match its canonical fields.");
  }
  return Object.freeze(body as EvaluationRequest);
}

export const evaluationSchemaTesting = Object.freeze({
  parseEvidenceData,
  parseRelativePath,
  parseRequestBody,
});
