import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";
import { canonicalizeJson, toCanonicalJson, validation } from "@ai-dev-os/domain";
import {
  INTEGRATION_CONFLICT_KINDS,
  INTEGRATION_PRODUCTION_ENABLED,
  INTEGRATION_SCHEMA_VERSION,
  INTEGRATION_STRATEGIES,
  type IntegrationAdmission,
  type IntegrationAuthorityConfiguration,
  type IntegrationBounds,
  type IntegrationCandidateArtifact,
  type IntegrationCleanupResult,
  type IntegrationConflict,
  type IntegrationEffectIntent,
  type IntegrationLease,
  type IntegrationPreflightResult,
  type IntegrationReceipt,
  type IntegrationRecoveryState,
  type IntegrationRequest,
  type IntegrationResolutionProposal,
  type IntegrationRetryPolicy,
  type IntegrationTerminalResult,
  type IntegrationValidationPlan,
  type IntegrationValidationResult,
  type RepositoryIntegrationIdentity,
  type ReviewedResolutionAuthorization,
} from "./contracts.js";
import { IntegrationError } from "./errors.js";

const {
  ensureArray,
  ensureBoolean,
  ensureEnum,
  ensureExactKeys: ensureDomainExactKeys,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
  ensureString,
  ensureTimestamp,
} = validation;

function ensureExactKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[], _path: string): void {
  try {
    ensureDomainExactKeys(record, keys, "integration-input");
  } catch {
    throw new IntegrationError("INVALID_INPUT", "Integration input contains unsupported or missing fields.");
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODE = /^[a-z][a-z0-9._-]{0,63}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,191}$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*[\u0000-\u001f])[\s\S]{1,1024}$/;
const TRANSIENT_PRE_EFFECT_FAILURE_CODES = Object.freeze([
  "git-boundary-failure",
  "preflight-boundary-failed",
  "timeout",
] as const);

export const INTEGRATION_LIMITS = Object.freeze({
  maximumPaths: 4_096,
  maximumRequirements: 2_048,
  maximumConflicts: 1_024,
  maximumCommands: 256,
  maximumAttempts: 8,
  maximumJournalEvents: 30,
  maximumRetainedRuns: 10_000,
  maximumInputNodes: 75_000,
  maximumInputText: 2_000_000,
  maximumInputDepth: 32,
  maximumWallTimeMs: 900_000,
  maximumFiles: 50_000,
  maximumBytes: 2_000_000_000,
});

export function integrationDigest(value: unknown): string {
  return createHash("sha256").update(toCanonicalJson(canonicalizeJson(value, "integrationDigest")), "utf8").digest("hex");
}

export function stableIntegrationId(kind: string, ...parts: readonly string[]): string {
  return `${kind}:${createHash("sha256").update(toCanonicalJson([kind, ...parts]), "utf8").digest("hex")}`;
}

export function compareIntegrationText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseIntegrationId(value: unknown, path: string): string {
  return ensureString(value, path, { maxLength: 128, pattern: ID, patternName: "identifier" });
}

export function parseIntegrationDigest(value: unknown, path: string): string {
  return ensureString(value, path, { maxLength: 64, pattern: DIGEST, patternName: "sha256" });
}

export function parseIntegrationCode(value: unknown, path: string): string {
  return ensureString(value, path, { maxLength: 64, pattern: CODE, patternName: "code" });
}

function parseRevision(value: unknown, path: string, objectFormat?: "sha1" | "sha256"): string {
  const revision = ensureString(value, path, { maxLength: 64, pattern: REVISION, patternName: "git-object-id" });
  if (objectFormat !== undefined && revision.length !== (objectFormat === "sha1" ? 40 : 64)) {
    throw new IntegrationError("INVALID_INPUT", "Git object identity does not match the declared object format.");
  }
  return revision;
}

function sortedUnique(
  value: unknown,
  path: string,
  maximum: number,
  parse: (item: unknown, itemPath: string) => string,
): readonly string[] {
  const parsed = ensureArray(value, path, maximum).map((item, index) => parse(item, `${path}[${index}]`));
  const sorted = [...parsed].sort(compareIntegrationText);
  if (new Set(sorted).size !== sorted.length || parsed.some((item, index) => item !== sorted[index])) {
    throw new IntegrationError("INVALID_INPUT", `${path} must be unique and canonically ordered.`);
  }
  return Object.freeze(parsed);
}

function pathList(value: unknown, path: string, maximum: number = INTEGRATION_LIMITS.maximumPaths): readonly string[] {
  return sortedUnique(value, path, maximum, (item, itemPath) =>
    ensureString(item, itemPath, { maxLength: 1024, pattern: SAFE_PATH, patternName: "repository-relative-path" }));
}

function literalBoolean<T extends boolean>(value: unknown, path: string, expected: T): T {
  const parsed = ensureBoolean(value, path);
  if (parsed !== expected) throw new IntegrationError("INVALID_INPUT", `${path} must retain its reviewed literal value.`);
  return expected;
}

function schemaVersion(value: unknown, path: string): typeof INTEGRATION_SCHEMA_VERSION {
  ensureSchemaVersion(value, path, INTEGRATION_SCHEMA_VERSION);
  return INTEGRATION_SCHEMA_VERSION;
}

function idList(value: unknown, path: string, maximum: number): readonly string[] {
  return sortedUnique(value, path, maximum, parseIntegrationId);
}

function digestList(value: unknown, path: string, maximum: number): readonly string[] {
  return sortedUnique(value, path, maximum, parseIntegrationDigest);
}

export function assertIntegrationInputBudget(value: unknown): void {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let text = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > INTEGRATION_LIMITS.maximumInputNodes || current.depth > INTEGRATION_LIMITS.maximumInputDepth) {
      throw new IntegrationError("LIMIT_EXCEEDED", "Integration input exceeds its structural work bound.");
    }
    const item = current.value;
    if (typeof item === "string") {
      text += item.length;
      if (text > INTEGRATION_LIMITS.maximumInputText) {
        throw new IntegrationError("LIMIT_EXCEEDED", "Integration input exceeds its cumulative text bound.");
      }
      continue;
    }
    if (item === null || typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new IntegrationError("INVALID_INPUT", "Integration input contains a non-finite number.");
      continue;
    }
    if (typeof item !== "object") throw new IntegrationError("INVALID_INPUT", "Integration input must contain only data values.");
    if (seen.has(item)) throw new IntegrationError("INVALID_INPUT", "Integration input cannot contain cyclic or aliased objects.");
    seen.add(item);
    if (nodeTypes.isProxy(item)) {
      throw new IntegrationError("INVALID_INPUT", "Integration input cannot contain proxy objects.");
    }
    let prototype: object | null;
    let keys: readonly PropertyKey[];
    try {
      prototype = Object.getPrototypeOf(item) as object | null;
      keys = Reflect.ownKeys(item);
    } catch {
      /* v8 ignore next -- proxies are rejected first; plain-data prototype/key reflection cannot install traps. */
      throw new IntegrationError("INVALID_INPUT", "Integration input could not be inspected as finite plain data.");
    }
    if (Array.isArray(item)) {
      if (prototype !== Array.prototype || item.length > INTEGRATION_LIMITS.maximumInputNodes) {
        throw new IntegrationError("LIMIT_EXCEEDED", "Integration input contains an oversized or exotic array.");
      }
    } else if (prototype !== Object.prototype && prototype !== null) {
      throw new IntegrationError("INVALID_INPUT", "Integration input must contain only plain objects.");
    }
    if (keys.length > INTEGRATION_LIMITS.maximumInputNodes || keys.some((key) => typeof key !== "string")) {
      throw new IntegrationError("LIMIT_EXCEEDED", "Integration input contains an oversized or symbol-keyed object.");
    }
    let descriptors: PropertyDescriptorMap;
    try {
      descriptors = Object.getOwnPropertyDescriptors(item);
    } catch {
      /* v8 ignore next -- bounded plain-data descriptors cannot invoke caller code after the proxy check. */
      throw new IntegrationError("INVALID_INPUT", "Integration input could not be inspected as finite plain data.");
    }
    for (const key of keys as string[]) {
      if (!Array.isArray(item)) text += key.length;
      if (text > INTEGRATION_LIMITS.maximumInputText) throw new IntegrationError("LIMIT_EXCEEDED", "Integration input exceeds its cumulative text bound.");
      if (key === "length") continue;
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        throw new IntegrationError("INVALID_INPUT", "Integration input fields must be enumerable data properties.");
      }
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
}

function parseRepository(value: unknown, path: string): RepositoryIntegrationIdentity {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, [
    "repositoryId", "objectFormat", "targetRef", "expectedTargetCommit", "expectedTargetTree",
    "sourceCommit", "sourceTree", "expectedIntegratedCommit", "expectedIntegratedTree", "expectedParents", "mergeCommitTimestamp",
  ], path);
  const objectFormat = ensureEnum(record["objectFormat"], `${path}.objectFormat`, ["sha1", "sha256"] as const);
  const targetRef = ensureString(record["targetRef"], `${path}.targetRef`, { maxLength: 202, pattern: REF, patternName: "local-branch-ref" });
  if (["refs/heads/main", "refs/heads/master"].includes(targetRef.toLowerCase())) {
    throw new IntegrationError("INVALID_INPUT", "This checkpoint cannot target a protected primary branch.");
  }
  const expectedParents = sortedOrExactRevisions(record["expectedParents"], `${path}.expectedParents`, objectFormat);
  return Object.freeze({
    repositoryId: parseIntegrationId(record["repositoryId"], `${path}.repositoryId`),
    objectFormat,
    targetRef,
    expectedTargetCommit: parseRevision(record["expectedTargetCommit"], `${path}.expectedTargetCommit`, objectFormat),
    expectedTargetTree: parseRevision(record["expectedTargetTree"], `${path}.expectedTargetTree`, objectFormat),
    sourceCommit: parseRevision(record["sourceCommit"], `${path}.sourceCommit`, objectFormat),
    sourceTree: parseRevision(record["sourceTree"], `${path}.sourceTree`, objectFormat),
    expectedIntegratedCommit: parseRevision(record["expectedIntegratedCommit"], `${path}.expectedIntegratedCommit`, objectFormat),
    expectedIntegratedTree: parseRevision(record["expectedIntegratedTree"], `${path}.expectedIntegratedTree`, objectFormat),
    expectedParents,
    mergeCommitTimestamp: record["mergeCommitTimestamp"] === null ? null : ensureTimestamp(record["mergeCommitTimestamp"], `${path}.mergeCommitTimestamp`),
  });
}

function sortedOrExactRevisions(value: unknown, path: string, objectFormat: "sha1" | "sha256"): readonly string[] {
  const values = ensureArray(value, path, 2).map((item, index) => parseRevision(item, `${path}[${index}]`, objectFormat));
  if (new Set(values).size !== values.length) throw new IntegrationError("INVALID_INPUT", "Expected parents must be unique.");
  return Object.freeze(values);
}

function parseAdmission(value: unknown, path: string): IntegrationAdmission {
  const record = ensureRecord(value, path);
  const keys = [
    "evaluationRunId", "evaluationRequestDigest", "evaluationResultDigest", "evaluationSubjectDigest",
    "evaluationDecision", "authorityConfigurationFingerprint", "criterionManifestDigest",
    "deterministicEvidenceDigest", "productSpecificationId", "productSpecificationDigest",
    "requirementIds", "requirementCoverageDigest", "waiverDigests", "dissentDigest",
    "securityFindingsDigest", "feasibilityFindingsDigest", "admissionDigest",
  ] as const;
  ensureExactKeys(record, keys, path);
  const admission = Object.freeze({
    evaluationRunId: parseIntegrationId(record["evaluationRunId"], `${path}.evaluationRunId`),
    evaluationRequestDigest: parseIntegrationDigest(record["evaluationRequestDigest"], `${path}.evaluationRequestDigest`),
    evaluationResultDigest: parseIntegrationDigest(record["evaluationResultDigest"], `${path}.evaluationResultDigest`),
    evaluationSubjectDigest: parseIntegrationDigest(record["evaluationSubjectDigest"], `${path}.evaluationSubjectDigest`),
    evaluationDecision: ensureEnum(record["evaluationDecision"], `${path}.evaluationDecision`, ["accepted"] as const),
    authorityConfigurationFingerprint: parseIntegrationDigest(record["authorityConfigurationFingerprint"], `${path}.authorityConfigurationFingerprint`),
    criterionManifestDigest: parseIntegrationDigest(record["criterionManifestDigest"], `${path}.criterionManifestDigest`),
    deterministicEvidenceDigest: parseIntegrationDigest(record["deterministicEvidenceDigest"], `${path}.deterministicEvidenceDigest`),
    productSpecificationId: parseIntegrationId(record["productSpecificationId"], `${path}.productSpecificationId`),
    productSpecificationDigest: parseIntegrationDigest(record["productSpecificationDigest"], `${path}.productSpecificationDigest`),
    requirementIds: idList(record["requirementIds"], `${path}.requirementIds`, INTEGRATION_LIMITS.maximumRequirements),
    requirementCoverageDigest: parseIntegrationDigest(record["requirementCoverageDigest"], `${path}.requirementCoverageDigest`),
    waiverDigests: digestList(record["waiverDigests"], `${path}.waiverDigests`, 256),
    dissentDigest: parseIntegrationDigest(record["dissentDigest"], `${path}.dissentDigest`),
    securityFindingsDigest: parseIntegrationDigest(record["securityFindingsDigest"], `${path}.securityFindingsDigest`),
    feasibilityFindingsDigest: parseIntegrationDigest(record["feasibilityFindingsDigest"], `${path}.feasibilityFindingsDigest`),
    admissionDigest: parseIntegrationDigest(record["admissionDigest"], `${path}.admissionDigest`),
  });
  if (admission.requirementIds.length === 0) throw new IntegrationError("INVALID_INPUT", "Integration admission must retain at least one product requirement.");
  const projection = { ...admission } as Record<string, unknown>;
  delete projection["admissionDigest"];
  if (admission.admissionDigest !== integrationDigest(projection)) {
    throw new IntegrationError("INVALID_INPUT", "Integration admission digest does not match its exact projection.");
  }
  return admission;
}

function parseValidationPlan(value: unknown, path: string): IntegrationValidationPlan {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["planId", "validatorId", "validatorSchemaVersion", "routeFingerprint", "configurationDigest", "commandIds", "requiredCriterionIds", "thresholdDigest", "allowSkips", "planDigest"], path);
  const plan = Object.freeze({
    planId: parseIntegrationId(record["planId"], `${path}.planId`),
    validatorId: parseIntegrationId(record["validatorId"], `${path}.validatorId`),
    validatorSchemaVersion: schemaVersion(record["validatorSchemaVersion"], `${path}.validatorSchemaVersion`),
    routeFingerprint: parseIntegrationDigest(record["routeFingerprint"], `${path}.routeFingerprint`),
    configurationDigest: parseIntegrationDigest(record["configurationDigest"], `${path}.configurationDigest`),
    commandIds: idList(record["commandIds"], `${path}.commandIds`, INTEGRATION_LIMITS.maximumCommands),
    requiredCriterionIds: idList(record["requiredCriterionIds"], `${path}.requiredCriterionIds`, 256),
    thresholdDigest: parseIntegrationDigest(record["thresholdDigest"], `${path}.thresholdDigest`),
    allowSkips: literalBoolean(record["allowSkips"], `${path}.allowSkips`, false),
    planDigest: parseIntegrationDigest(record["planDigest"], `${path}.planDigest`),
  });
  if (plan.commandIds.length === 0 || plan.requiredCriterionIds.length === 0) throw new IntegrationError("INVALID_INPUT", "Validation plan must retain at least one command and required criterion.");
  const projection = { ...plan } as Record<string, unknown>;
  delete projection["planDigest"];
  if (plan.planDigest !== integrationDigest(projection)) throw new IntegrationError("INVALID_INPUT", "Validation plan digest is inconsistent.");
  return plan;
}

function parseProposal(value: unknown, path: string): IntegrationResolutionProposal | null {
  if (value === null) return null;
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["proposalId", "authority", "conflictIds", "patchArtifactDigest", "resultingTree", "allowedPaths", "validationPlanDigest", "proposalDigest"], path);
  const proposal = Object.freeze({
    proposalId: parseIntegrationId(record["proposalId"], `${path}.proposalId`),
    authority: ensureEnum(record["authority"], `${path}.authority`, ["none"] as const),
    conflictIds: idList(record["conflictIds"], `${path}.conflictIds`, INTEGRATION_LIMITS.maximumConflicts),
    patchArtifactDigest: parseIntegrationDigest(record["patchArtifactDigest"], `${path}.patchArtifactDigest`),
    resultingTree: parseRevision(record["resultingTree"], `${path}.resultingTree`),
    allowedPaths: pathList(record["allowedPaths"], `${path}.allowedPaths`),
    validationPlanDigest: parseIntegrationDigest(record["validationPlanDigest"], `${path}.validationPlanDigest`),
    proposalDigest: parseIntegrationDigest(record["proposalDigest"], `${path}.proposalDigest`),
  });
  const projection = { ...proposal } as Record<string, unknown>;
  delete projection["proposalDigest"];
  if (proposal.conflictIds.length === 0) throw new IntegrationError("INVALID_INPUT", "Resolution proposal must bind at least one exact conflict.");
  if (proposal.proposalDigest !== integrationDigest(projection)) throw new IntegrationError("INVALID_INPUT", "Resolution proposal digest is inconsistent.");
  return proposal;
}

function parseResolutionAuthorization(value: unknown, path: string): ReviewedResolutionAuthorization | null {
  if (value === null) return null;
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["proposalDigest", "authorityDigest", "approvalReference", "approvedAt", "authorizationDigest"], path);
  const authorization = Object.freeze({
    proposalDigest: parseIntegrationDigest(record["proposalDigest"], `${path}.proposalDigest`),
    authorityDigest: parseIntegrationDigest(record["authorityDigest"], `${path}.authorityDigest`),
    approvalReference: parseIntegrationId(record["approvalReference"], `${path}.approvalReference`),
    approvedAt: ensureTimestamp(record["approvedAt"], `${path}.approvedAt`),
    authorizationDigest: parseIntegrationDigest(record["authorizationDigest"], `${path}.authorizationDigest`),
  });
  const projection = { ...authorization } as Record<string, unknown>;
  delete projection["authorizationDigest"];
  if (authorization.authorizationDigest !== integrationDigest(projection)) throw new IntegrationError("INVALID_INPUT", "Resolution authorization digest is inconsistent.");
  return authorization;
}

function parseRetryPolicy(value: unknown, path: string): IntegrationRetryPolicy {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["maximumAttempts", "retryableFailureCodes", "automaticRetryBeforeEffectOnly"], path);
  const retryableFailureCodes = sortedUnique(record["retryableFailureCodes"], `${path}.retryableFailureCodes`, TRANSIENT_PRE_EFFECT_FAILURE_CODES.length, parseIntegrationCode);
  if (retryableFailureCodes.some((code) => !(TRANSIENT_PRE_EFFECT_FAILURE_CODES as readonly string[]).includes(code))) {
    throw new IntegrationError("INVALID_INPUT", "Retry policy contains a non-transient or deterministic integration failure code.");
  }
  return Object.freeze({
    maximumAttempts: ensureSafeInteger(record["maximumAttempts"], `${path}.maximumAttempts`, 1, INTEGRATION_LIMITS.maximumAttempts),
    retryableFailureCodes,
    automaticRetryBeforeEffectOnly: literalBoolean(record["automaticRetryBeforeEffectOnly"], `${path}.automaticRetryBeforeEffectOnly`, true),
  });
}

function parseBounds(value: unknown, path: string): IntegrationBounds {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["maximumPaths", "maximumFiles", "maximumBytes", "maximumConflicts", "maximumWallTimeMs", "maximumWorktrees"], path);
  return Object.freeze({
    maximumPaths: ensureSafeInteger(record["maximumPaths"], `${path}.maximumPaths`, 1, INTEGRATION_LIMITS.maximumPaths),
    maximumFiles: ensureSafeInteger(record["maximumFiles"], `${path}.maximumFiles`, 1, INTEGRATION_LIMITS.maximumFiles),
    maximumBytes: ensureSafeInteger(record["maximumBytes"], `${path}.maximumBytes`, 1, INTEGRATION_LIMITS.maximumBytes),
    maximumConflicts: ensureSafeInteger(record["maximumConflicts"], `${path}.maximumConflicts`, 0, INTEGRATION_LIMITS.maximumConflicts),
    maximumWallTimeMs: ensureSafeInteger(record["maximumWallTimeMs"], `${path}.maximumWallTimeMs`, 1, INTEGRATION_LIMITS.maximumWallTimeMs),
    maximumWorktrees: (() => {
      const parsed = ensureSafeInteger(record["maximumWorktrees"], `${path}.maximumWorktrees`, 1, 1);
      return parsed as 1;
    })(),
  });
}

function parseCandidateArtifact(value: unknown, path: string): IntegrationCandidateArtifact {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["taskId", "taskResultDigest", "artifactId", "artifactDigest", "manifestId", "manifestDigest", "bindingDigest"], path);
  const artifact = Object.freeze({
    taskId: parseIntegrationId(record["taskId"], `${path}.taskId`),
    taskResultDigest: parseIntegrationDigest(record["taskResultDigest"], `${path}.taskResultDigest`),
    artifactId: parseIntegrationId(record["artifactId"], `${path}.artifactId`),
    artifactDigest: parseIntegrationDigest(record["artifactDigest"], `${path}.artifactDigest`),
    manifestId: parseIntegrationId(record["manifestId"], `${path}.manifestId`),
    manifestDigest: parseIntegrationDigest(record["manifestDigest"], `${path}.manifestDigest`),
    bindingDigest: parseIntegrationDigest(record["bindingDigest"], `${path}.bindingDigest`),
  });
  const projection = { ...artifact } as Record<string, unknown>;
  delete projection["bindingDigest"];
  if (artifact.bindingDigest !== integrationDigest(projection)) throw new IntegrationError("INVALID_INPUT", "Candidate artifact binding digest is inconsistent.");
  return artifact;
}

export function createIntegrationRequest(value: unknown): IntegrationRequest {
  assertIntegrationInputBudget(value);
  const record = ensureRecord(value, "request");
  const keys = [
    "schemaVersion", "runId", "repository", "gitPortId", "gitPortSchemaVersion", "gitRouteFingerprint", "gitTargetFingerprint", "strategy", "allowedPaths", "candidateArtifact", "admission", "validationPlan",
    "resolutionProposal", "resolutionAuthorization", "authorityDigest", "idempotencyKey", "retryPolicy",
    "bounds", "createdAt", "deadline", "requestDigest",
  ] as const;
  ensureExactKeys(record, keys, "request");
  const repository = parseRepository(record["repository"], "request.repository");
  const strategy = ensureEnum(record["strategy"], "request.strategy", INTEGRATION_STRATEGIES);
  const allowedPaths = pathList(record["allowedPaths"], "request.allowedPaths");
  const candidateArtifact = parseCandidateArtifact(record["candidateArtifact"], "request.candidateArtifact");
  const admission = parseAdmission(record["admission"], "request.admission");
  const validationPlan = parseValidationPlan(record["validationPlan"], "request.validationPlan");
  const resolutionProposal = parseProposal(record["resolutionProposal"], "request.resolutionProposal");
  const resolutionAuthorization = parseResolutionAuthorization(record["resolutionAuthorization"], "request.resolutionAuthorization");
  const authorityDigest = parseIntegrationDigest(record["authorityDigest"], "request.authorityDigest");
  const createdAt = ensureTimestamp(record["createdAt"], "request.createdAt");
  const deadline = ensureTimestamp(record["deadline"], "request.deadline");
  if (deadline <= createdAt) throw new IntegrationError("INVALID_INPUT", "Integration deadline must follow creation time.");
  if (strategy === "fast-forward" && repository.expectedParents.length !== 0) {
    throw new IntegrationError("INVALID_INPUT", "Fast-forward integration cannot claim a newly created parent list.");
  }
  if (strategy === "fast-forward" && repository.mergeCommitTimestamp !== null) throw new IntegrationError("INVALID_INPUT", "Fast-forward integration cannot declare merge-commit metadata.");
  if (strategy === "fast-forward" && repository.expectedIntegratedTree !== repository.sourceTree) {
    throw new IntegrationError("INVALID_INPUT", "Fast-forward integration tree must equal the exact source tree.");
  }
  if (strategy === "fast-forward" && repository.expectedIntegratedCommit !== repository.sourceCommit) {
    throw new IntegrationError("INVALID_INPUT", "Fast-forward integration commit must equal the exact source commit.");
  }
  if (repository.sourceCommit === repository.expectedTargetCommit) {
    throw new IntegrationError("INVALID_INPUT", "Integration source and target commits must be distinct exact revisions.");
  }
  if (strategy === "merge" && (repository.expectedParents.length !== 2 || repository.expectedParents[0] !== repository.expectedTargetCommit || repository.expectedParents[1] !== repository.sourceCommit)) {
    throw new IntegrationError("INVALID_INPUT", "Merge integration requires exact target-first, source-second parent ordering.");
  }
  if (strategy === "merge" && repository.mergeCommitTimestamp === null) throw new IntegrationError("INVALID_INPUT", "Merge integration requires an exact reviewed commit timestamp.");
  if (resolutionProposal === null !== (resolutionAuthorization === null)) {
    throw new IntegrationError("INVALID_INPUT", "A resolution proposal and its reviewed authorization must be supplied together.");
  }
  if (resolutionProposal !== null && resolutionAuthorization !== null) {
    if (
      strategy !== "merge" ||
      resolutionAuthorization.proposalDigest !== resolutionProposal.proposalDigest ||
      resolutionAuthorization.authorityDigest !== authorityDigest ||
      resolutionProposal.validationPlanDigest !== validationPlan.planDigest ||
      resolutionProposal.resultingTree !== repository.expectedIntegratedTree ||
      toCanonicalJson(resolutionProposal.allowedPaths) !== toCanonicalJson(allowedPaths) ||
      resolutionAuthorization.approvedAt < createdAt || resolutionAuthorization.approvedAt > deadline
    ) throw new IntegrationError("UNAUTHORIZED", "Resolution authorization does not bind the exact proposal, authority, scope, and validation plan.");
  }
  const request: IntegrationRequest = Object.freeze({
    schemaVersion: schemaVersion(record["schemaVersion"], "request.schemaVersion"),
    runId: parseIntegrationId(record["runId"], "request.runId"),
    repository,
    gitPortId: parseIntegrationId(record["gitPortId"], "request.gitPortId"),
    gitPortSchemaVersion: schemaVersion(record["gitPortSchemaVersion"], "request.gitPortSchemaVersion"),
    gitRouteFingerprint: parseIntegrationDigest(record["gitRouteFingerprint"], "request.gitRouteFingerprint"),
    gitTargetFingerprint: parseIntegrationDigest(record["gitTargetFingerprint"], "request.gitTargetFingerprint"),
    strategy,
    allowedPaths,
    candidateArtifact,
    admission,
    validationPlan,
    resolutionProposal,
    resolutionAuthorization,
    authorityDigest,
    idempotencyKey: parseIntegrationId(record["idempotencyKey"], "request.idempotencyKey"),
    retryPolicy: parseRetryPolicy(record["retryPolicy"], "request.retryPolicy"),
    bounds: parseBounds(record["bounds"], "request.bounds"),
    createdAt,
    deadline,
    requestDigest: parseIntegrationDigest(record["requestDigest"], "request.requestDigest"),
  });
  if (request.idempotencyKey.startsWith("integration-internal:")) throw new IntegrationError("INVALID_INPUT", "Integration idempotency keys cannot use the internal command namespace.");
  if (request.allowedPaths.length > request.bounds.maximumPaths) throw new IntegrationError("LIMIT_EXCEEDED", "Allowed paths exceed the request bound.");
  const projection = { ...request } as Record<string, unknown>;
  delete projection["requestDigest"];
  if (request.requestDigest !== integrationDigest(projection)) throw new IntegrationError("INVALID_INPUT", "Integration request digest is inconsistent.");
  return request;
}

export const parseIntegrationRequest = createIntegrationRequest;

export const EMPTY_INTEGRATION_AUTHORITY_CONFIGURATION: IntegrationAuthorityConfiguration = Object.freeze({
  schemaVersion: INTEGRATION_SCHEMA_VERSION,
  configurationId: "integration-authority:none",
  authorizedRequestDigests: Object.freeze([]),
  authorizedAuthorityDigests: Object.freeze([]),
  authorizedAdmissionDigests: Object.freeze([]),
  authorizedResolutionDigests: Object.freeze([]),
  configurationFingerprint: integrationDigest({
    schemaVersion: INTEGRATION_SCHEMA_VERSION,
    configurationId: "integration-authority:none",
    authorizedRequestDigests: [],
    authorizedAuthorityDigests: [],
    authorizedAdmissionDigests: [],
    authorizedResolutionDigests: [],
  }),
});

export function createIntegrationAuthorityConfiguration(value: unknown): IntegrationAuthorityConfiguration {
  assertIntegrationInputBudget(value);
  const record = ensureRecord(value, "authorityConfiguration");
  ensureExactKeys(record, ["schemaVersion", "configurationId", "authorizedRequestDigests", "authorizedAuthorityDigests", "authorizedAdmissionDigests", "authorizedResolutionDigests", "configurationFingerprint"], "authorityConfiguration");
  const configuration = Object.freeze({
    schemaVersion: schemaVersion(record["schemaVersion"], "authorityConfiguration.schemaVersion"),
    configurationId: parseIntegrationId(record["configurationId"], "authorityConfiguration.configurationId"),
    authorizedRequestDigests: digestList(record["authorizedRequestDigests"], "authorityConfiguration.authorizedRequestDigests", 1_024),
    authorizedAuthorityDigests: digestList(record["authorizedAuthorityDigests"], "authorityConfiguration.authorizedAuthorityDigests", 1_024),
    authorizedAdmissionDigests: digestList(record["authorizedAdmissionDigests"], "authorityConfiguration.authorizedAdmissionDigests", 1_024),
    authorizedResolutionDigests: digestList(record["authorizedResolutionDigests"], "authorityConfiguration.authorizedResolutionDigests", 1_024),
    configurationFingerprint: parseIntegrationDigest(record["configurationFingerprint"], "authorityConfiguration.configurationFingerprint"),
  });
  const projection = { ...configuration } as Record<string, unknown>;
  delete projection["configurationFingerprint"];
  if (configuration.configurationFingerprint !== integrationDigest(projection)) throw new IntegrationError("INVALID_INPUT", "Authority configuration fingerprint is inconsistent.");
  return configuration;
}

export const parseIntegrationAuthorityConfiguration = createIntegrationAuthorityConfiguration;

export function authorizeIntegrationRequest(request: IntegrationRequest, configuration: IntegrationAuthorityConfiguration): void {
  if (!configuration.authorizedRequestDigests.includes(request.requestDigest) ||
      !configuration.authorizedAuthorityDigests.includes(request.authorityDigest) ||
      !configuration.authorizedAdmissionDigests.includes(request.admission.admissionDigest)) {
    throw new IntegrationError("UNAUTHORIZED", "Integration authority or evaluation admission is not trusted by this service configuration.");
  }
  if (request.resolutionAuthorization !== null && !configuration.authorizedResolutionDigests.includes(request.resolutionAuthorization.authorizationDigest)) {
    throw new IntegrationError("UNAUTHORIZED", "Reviewed resolution authorization is not trusted by this service configuration.");
  }
}

export function parseIntegrationLease(value: unknown, path = "lease"): IntegrationLease {
  assertIntegrationInputBudget(value);
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["leaseId", "owner", "fencingToken", "acquiredAt", "expiresAt"], path);
  const acquiredAt = ensureTimestamp(record["acquiredAt"], `${path}.acquiredAt`);
  const expiresAt = ensureTimestamp(record["expiresAt"], `${path}.expiresAt`);
  if (expiresAt <= acquiredAt) throw new IntegrationError("INVALID_INPUT", "Lease expiry must follow acquisition.");
  return Object.freeze({
    leaseId: parseIntegrationId(record["leaseId"], `${path}.leaseId`),
    owner: parseIntegrationId(record["owner"], `${path}.owner`),
    fencingToken: ensureSafeInteger(record["fencingToken"], `${path}.fencingToken`, 1, Number.MAX_SAFE_INTEGER),
    acquiredAt,
    expiresAt,
  });
}

export function parseIntegrationConflict(value: unknown, path: string): IntegrationConflict {
  assertIntegrationInputBudget(value);
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["conflictId", "kind", "path", "ruleCode", "blocking"], path);
  const conflictPath = record["path"] === null ? null : pathList([record["path"]], `${path}.path`, 1)[0]!;
  return Object.freeze({
    conflictId: parseIntegrationId(record["conflictId"], `${path}.conflictId`),
    kind: ensureEnum(record["kind"], `${path}.kind`, INTEGRATION_CONFLICT_KINDS),
    path: conflictPath,
    ruleCode: parseIntegrationCode(record["ruleCode"], `${path}.ruleCode`),
    blocking: literalBoolean(record["blocking"], `${path}.blocking`, true),
  });
}

export function parseIntegrationPreflightResult(value: unknown, path = "preflight"): IntegrationPreflightResult {
  assertIntegrationInputBudget(value);
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["schemaVersion", "preflightId", "requestDigest", "repositoryId", "targetRef", "targetCommit", "targetTree", "sourceCommit", "sourceTree", "clean", "changedPaths", "fileCount", "totalBytes", "conflicts", "checkedAt", "preflightDigest"], path);
  const conflicts = ensureArray(record["conflicts"], `${path}.conflicts`, INTEGRATION_LIMITS.maximumConflicts).map((item, index) => parseIntegrationConflict(item, `${path}.conflicts[${index}]`));
  const conflictIds = conflicts.map((item) => item.conflictId);
  if (new Set(conflictIds).size !== conflictIds.length || [...conflictIds].sort(compareIntegrationText).some((item, index) => item !== conflictIds[index])) throw new IntegrationError("INVALID_INPUT", "Preflight conflicts must be unique and ordered.");
  const result = Object.freeze({
    schemaVersion: schemaVersion(record["schemaVersion"], `${path}.schemaVersion`),
    preflightId: parseIntegrationId(record["preflightId"], `${path}.preflightId`),
    requestDigest: parseIntegrationDigest(record["requestDigest"], `${path}.requestDigest`),
    repositoryId: parseIntegrationId(record["repositoryId"], `${path}.repositoryId`),
    targetRef: ensureString(record["targetRef"], `${path}.targetRef`, { maxLength: 202, pattern: REF, patternName: "local-branch-ref" }),
    targetCommit: parseRevision(record["targetCommit"], `${path}.targetCommit`),
    targetTree: parseRevision(record["targetTree"], `${path}.targetTree`),
    sourceCommit: parseRevision(record["sourceCommit"], `${path}.sourceCommit`),
    sourceTree: parseRevision(record["sourceTree"], `${path}.sourceTree`),
    clean: ensureBoolean(record["clean"], `${path}.clean`),
    changedPaths: pathList(record["changedPaths"], `${path}.changedPaths`),
    fileCount: ensureSafeInteger(record["fileCount"], `${path}.fileCount`, 0, INTEGRATION_LIMITS.maximumFiles),
    totalBytes: ensureSafeInteger(record["totalBytes"], `${path}.totalBytes`, 0, INTEGRATION_LIMITS.maximumBytes),
    conflicts: Object.freeze(conflicts),
    checkedAt: ensureTimestamp(record["checkedAt"], `${path}.checkedAt`),
    preflightDigest: parseIntegrationDigest(record["preflightDigest"], `${path}.preflightDigest`),
  });
  const projection = { ...result } as Record<string, unknown>; delete projection["preflightDigest"];
  if (result.preflightDigest !== integrationDigest(projection)) throw new IntegrationError("INVALID_INPUT", "Preflight digest is inconsistent.");
  return result;
}

export function parseIntegrationValidationResult(value: unknown, path = "validationResult"): IntegrationValidationResult {
  assertIntegrationInputBudget(value);
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["schemaVersion", "resultId", "validatorId", "validatorSchemaVersion", "phase", "planId", "configurationDigest", "headCommit", "treeId", "passed", "executedCommandIds", "commandResultDigests", "evaluatedCriterionIds", "criterionResultDigests", "thresholdDigest", "coverageDigest", "conflicts", "failedRuleCodes", "skippedCount", "evaluatedAt", "resultDigest"], path);
  const conflicts = ensureArray(record["conflicts"], `${path}.conflicts`, INTEGRATION_LIMITS.maximumConflicts).map((item, index) => parseIntegrationConflict(item, `${path}.conflicts[${index}]`));
  const conflictIds = conflicts.map((item) => item.conflictId);
  if (new Set(conflictIds).size !== conflictIds.length || [...conflictIds].sort(compareIntegrationText).some((item, index) => item !== conflictIds[index])) throw new IntegrationError("INVALID_INPUT", "Validation conflicts must be unique and ordered.");
  const result = Object.freeze({
    schemaVersion: schemaVersion(record["schemaVersion"], `${path}.schemaVersion`),
    resultId: parseIntegrationId(record["resultId"], `${path}.resultId`),
    validatorId: parseIntegrationId(record["validatorId"], `${path}.validatorId`),
    validatorSchemaVersion: schemaVersion(record["validatorSchemaVersion"], `${path}.validatorSchemaVersion`),
    phase: ensureEnum(record["phase"], `${path}.phase`, ["pre-integration", "post-integration"] as const),
    planId: parseIntegrationId(record["planId"], `${path}.planId`),
    configurationDigest: parseIntegrationDigest(record["configurationDigest"], `${path}.configurationDigest`),
    headCommit: parseRevision(record["headCommit"], `${path}.headCommit`),
    treeId: parseRevision(record["treeId"], `${path}.treeId`),
    passed: ensureBoolean(record["passed"], `${path}.passed`),
    executedCommandIds: idList(record["executedCommandIds"], `${path}.executedCommandIds`, INTEGRATION_LIMITS.maximumCommands),
    commandResultDigests: digestList(record["commandResultDigests"], `${path}.commandResultDigests`, INTEGRATION_LIMITS.maximumCommands),
    evaluatedCriterionIds: idList(record["evaluatedCriterionIds"], `${path}.evaluatedCriterionIds`, 256),
    criterionResultDigests: digestList(record["criterionResultDigests"], `${path}.criterionResultDigests`, 256),
    thresholdDigest: parseIntegrationDigest(record["thresholdDigest"], `${path}.thresholdDigest`),
    coverageDigest: parseIntegrationDigest(record["coverageDigest"], `${path}.coverageDigest`),
    conflicts: Object.freeze(conflicts),
    failedRuleCodes: sortedUnique(record["failedRuleCodes"], `${path}.failedRuleCodes`, 256, parseIntegrationCode),
    skippedCount: ensureSafeInteger(record["skippedCount"], `${path}.skippedCount`, 0, 1_000_000),
    evaluatedAt: ensureTimestamp(record["evaluatedAt"], `${path}.evaluatedAt`),
    resultDigest: parseIntegrationDigest(record["resultDigest"], `${path}.resultDigest`),
  });
  if (result.executedCommandIds.length !== result.commandResultDigests.length || result.evaluatedCriterionIds.length !== result.criterionResultDigests.length) throw new IntegrationError("INVALID_INPUT", "Validation identities and result digests must have exact cardinality.");
  if (result.passed !== (result.failedRuleCodes.length === 0 && result.skippedCount === 0 && result.conflicts.length === 0)) throw new IntegrationError("INVALID_INPUT", "Validation outcome contradicts deterministic rule or conflict evidence.");
  const projection = { ...result } as Record<string, unknown>; delete projection["resultDigest"];
  if (result.resultDigest !== integrationDigest(projection)) throw new IntegrationError("INVALID_INPUT", "Validation result digest is inconsistent.");
  return result;
}

export function parseIntegrationEffectIntent(value: unknown, path = "intent"): IntegrationEffectIntent {
  assertIntegrationInputBudget(value);
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["intentId", "requestDigest", "preflightDigest", "validationResultDigest", "resolutionAuthorizationDigest", "leaseId", "fencingToken", "createdAt", "intentDigest"], path);
  const result = Object.freeze({
    intentId: parseIntegrationId(record["intentId"], `${path}.intentId`),
    requestDigest: parseIntegrationDigest(record["requestDigest"], `${path}.requestDigest`),
    preflightDigest: parseIntegrationDigest(record["preflightDigest"], `${path}.preflightDigest`),
    validationResultDigest: parseIntegrationDigest(record["validationResultDigest"], `${path}.validationResultDigest`),
    resolutionAuthorizationDigest: record["resolutionAuthorizationDigest"] === null ? null : parseIntegrationDigest(record["resolutionAuthorizationDigest"], `${path}.resolutionAuthorizationDigest`),
    leaseId: parseIntegrationId(record["leaseId"], `${path}.leaseId`),
    fencingToken: ensureSafeInteger(record["fencingToken"], `${path}.fencingToken`, 1, Number.MAX_SAFE_INTEGER),
    createdAt: ensureTimestamp(record["createdAt"], `${path}.createdAt`),
    intentDigest: parseIntegrationDigest(record["intentDigest"], `${path}.intentDigest`),
  });
  const projection = { ...result } as Record<string, unknown>; delete projection["intentDigest"];
  if (result.intentDigest !== integrationDigest(projection)) throw new IntegrationError("INVALID_INPUT", "Effect intent digest is inconsistent.");
  return result;
}

export function parseIntegrationReceipt(value: unknown, path = "receipt"): IntegrationReceipt {
  assertIntegrationInputBudget(value);
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["schemaVersion", "receiptId", "intentDigest", "repositoryId", "targetRef", "previousTargetCommit", "integratedCommit", "integratedTree", "parents", "strategy", "refUpdated", "worktreeId", "changedPaths", "artifactDigest", "timingBasis", "committedAt", "receiptDigest"], path);
  const strategy = ensureEnum(record["strategy"], `${path}.strategy`, INTEGRATION_STRATEGIES);
  const result = Object.freeze({
    schemaVersion: schemaVersion(record["schemaVersion"], `${path}.schemaVersion`),
    receiptId: parseIntegrationId(record["receiptId"], `${path}.receiptId`),
    intentDigest: parseIntegrationDigest(record["intentDigest"], `${path}.intentDigest`),
    repositoryId: parseIntegrationId(record["repositoryId"], `${path}.repositoryId`),
    targetRef: ensureString(record["targetRef"], `${path}.targetRef`, { maxLength: 202, pattern: REF, patternName: "local-branch-ref" }),
    previousTargetCommit: parseRevision(record["previousTargetCommit"], `${path}.previousTargetCommit`),
    integratedCommit: parseRevision(record["integratedCommit"], `${path}.integratedCommit`),
    integratedTree: parseRevision(record["integratedTree"], `${path}.integratedTree`),
    parents: sortedOrExactRevisions(record["parents"], `${path}.parents`, parseRevision(record["integratedCommit"], `${path}.integratedCommit`).length === 40 ? "sha1" : "sha256"),
    strategy,
    refUpdated: literalBoolean(record["refUpdated"], `${path}.refUpdated`, true),
    worktreeId: parseIntegrationId(record["worktreeId"], `${path}.worktreeId`),
    changedPaths: pathList(record["changedPaths"], `${path}.changedPaths`),
    artifactDigest: parseIntegrationDigest(record["artifactDigest"], `${path}.artifactDigest`),
    timingBasis: ensureEnum(record["timingBasis"], `${path}.timingBasis`, ["observed", "recovered-observation"] as const),
    committedAt: ensureTimestamp(record["committedAt"], `${path}.committedAt`),
    receiptDigest: parseIntegrationDigest(record["receiptDigest"], `${path}.receiptDigest`),
  });
  if ((strategy === "fast-forward" && result.parents.length !== 0) || (strategy === "merge" && result.parents.length !== 2)) throw new IntegrationError("INVALID_INPUT", "Receipt parent projection contradicts integration strategy.");
  const projection = { ...result } as Record<string, unknown>; delete projection["receiptDigest"];
  if (result.receiptDigest !== integrationDigest(projection)) throw new IntegrationError("INVALID_INPUT", "Integration receipt digest is inconsistent.");
  return result;
}

export function parseIntegrationRecoveryState(value: unknown, path = "recovery"): IntegrationRecoveryState {
  assertIntegrationInputBudget(value);
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["state", "effectGuardState", "intentDigest", "observedTargetCommit", "observedTargetTree", "receipt", "observedAt", "recoveryDigest"], path);
  const result = Object.freeze({
    state: ensureEnum(record["state"], `${path}.state`, ["no-effect", "prepared", "commit-created", "ref-published", "diverged"] as const),
    effectGuardState: ensureEnum(record["effectGuardState"], `${path}.effectGuardState`, ["revoked", "absent"] as const),
    intentDigest: parseIntegrationDigest(record["intentDigest"], `${path}.intentDigest`),
    observedTargetCommit: record["observedTargetCommit"] === null ? null : parseRevision(record["observedTargetCommit"], `${path}.observedTargetCommit`),
    observedTargetTree: record["observedTargetTree"] === null ? null : parseRevision(record["observedTargetTree"], `${path}.observedTargetTree`),
    receipt: record["receipt"] === null ? null : parseIntegrationReceipt(record["receipt"], `${path}.receipt`),
    observedAt: ensureTimestamp(record["observedAt"], `${path}.observedAt`),
    recoveryDigest: parseIntegrationDigest(record["recoveryDigest"], `${path}.recoveryDigest`),
  });
  if ((result.state === "ref-published") !== (result.receipt !== null)) throw new IntegrationError("INVALID_INPUT", "Recovery receipt must exist exactly for a published local ref.");
  const projection = { ...result } as Record<string, unknown>; delete projection["recoveryDigest"];
  if (result.recoveryDigest !== integrationDigest(projection)) throw new IntegrationError("INVALID_INPUT", "Recovery digest is inconsistent.");
  return result;
}

export function parseIntegrationCleanupResult(value: unknown, path = "cleanup"): IntegrationCleanupResult {
  assertIntegrationInputBudget(value);
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["worktreeId", "cleaned", "preservedEvidence", "failureCode", "observedAt"], path);
  const cleaned = ensureBoolean(record["cleaned"], `${path}.cleaned`);
  const failureCode = record["failureCode"] === null ? null : parseIntegrationCode(record["failureCode"], `${path}.failureCode`);
  if (cleaned === (failureCode !== null)) throw new IntegrationError("INVALID_INPUT", "Cleanup success and failure evidence are inconsistent.");
  return Object.freeze({
    worktreeId: parseIntegrationId(record["worktreeId"], `${path}.worktreeId`),
    cleaned,
    preservedEvidence: ensureBoolean(record["preservedEvidence"], `${path}.preservedEvidence`),
    failureCode,
    observedAt: ensureTimestamp(record["observedAt"], `${path}.observedAt`),
  });
}

export function parseIntegrationTerminalResult(value: unknown, path = "terminal"): IntegrationTerminalResult {
  assertIntegrationInputBudget(value);
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["outcome", "receiptDigest", "validationResultDigest", "failureCode", "cleanup", "completedAt", "terminalDigest"], path);
  const result = Object.freeze({
    outcome: ensureEnum(record["outcome"], `${path}.outcome`, ["completed", "failed", "cancelled"] as const),
    receiptDigest: record["receiptDigest"] === null ? null : parseIntegrationDigest(record["receiptDigest"], `${path}.receiptDigest`),
    validationResultDigest: record["validationResultDigest"] === null ? null : parseIntegrationDigest(record["validationResultDigest"], `${path}.validationResultDigest`),
    failureCode: record["failureCode"] === null ? null : parseIntegrationCode(record["failureCode"], `${path}.failureCode`),
    cleanup: record["cleanup"] === null ? null : parseIntegrationCleanupResult(record["cleanup"], `${path}.cleanup`),
    completedAt: ensureTimestamp(record["completedAt"], `${path}.completedAt`),
    terminalDigest: parseIntegrationDigest(record["terminalDigest"], `${path}.terminalDigest`),
  });
  if ((result.outcome === "completed") !== (result.failureCode === null) || (result.outcome === "completed" && (result.receiptDigest === null || result.validationResultDigest === null))) {
    throw new IntegrationError("INVALID_INPUT", "Terminal outcome contradicts its receipt, validation, or failure evidence.");
  }
  const projection = { ...result } as Record<string, unknown>; delete projection["terminalDigest"];
  if (result.terminalDigest !== integrationDigest(projection)) throw new IntegrationError("INVALID_INPUT", "Terminal digest is inconsistent.");
  return result;
}

export const integrationSchemaTesting = Object.freeze({ parseRepository, parseAdmission, parseValidationPlan });
