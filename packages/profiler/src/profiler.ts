import {
  DATA_CLASSIFICATIONS,
  EDIT_SCOPES,
  REASONING_DEMANDS,
  TASK_CAPABILITIES,
  TASK_RISKS,
  compareDataClassification,
  parseTaskRequirements,
  validation,
  type DataClassification,
  type EditScope,
  type ReasoningDemand,
  type TaskCapability,
  type TaskRequirements,
  type TaskRisk
} from "@ai-dev-os/domain";
import { parseContextPack, type ContextPack } from "@ai-dev-os/context";
import {
  parseRepositoryIndex,
  type RepositoryIndex
} from "@ai-dev-os/repository-index";
import {
  parseCompiledThinkerPrompt,
  type CompiledThinkerPrompt
} from "@ai-dev-os/prompt-compiler";
import {
  parseThinkerProposal,
  thinkerPlanFingerprint,
  type ThinkerProposal
} from "@ai-dev-os/thinker";
import {
  createDeterministicClassifierFallback,
  parseClassifierHint,
  type ClassifierFallbackResult,
  type ClassifierHint,
  type ClassifierPort,
  type ClassifierStructuralInput
} from "./classifier.js";
import {
  DEFAULT_PROFILER_CONFIGURATION,
  parseProfilerConfiguration,
  type ProfilerConfiguration
} from "./config.js";
import { HEX_64, SAFE_ID, SAFE_KIND, compareText, digest } from "./shared.js";

const {
  ensureArray,
  ensureBoolean,
  ensureEnum,
  ensureEnumArray,
  ensureExactKeys,
  ensureNullable,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
  ensureString,
  ensureTimestamp,
  fail
} = validation;

function safeCount(value: unknown, path: string, minimum = 0): number {
  return ensureSafeInteger(value, path, minimum, Number.MAX_SAFE_INTEGER);
}

export const PROFILER_SCHEMA_VERSION = 1 as const;
export const TASK_PROFILE_ALGORITHM_VERSION = 1 as const;
export const TASK_PROFILE_PROVENANCE_VERSION = 1 as const;
export const PROFILE_COMPLETENESS = Object.freeze(["complete", "partial", "unknown"] as const);
export type ProfileCompleteness = (typeof PROFILE_COMPLETENESS)[number];
export const PROFILE_UNKNOWN_FIELDS = Object.freeze([
  "repository-scale",
  "context-size",
  "compiled-prompt-size",
  "proposal-shape",
  "expected-input-tokens",
  "expected-output-tokens"
] as const);
export type ProfileUnknownField = (typeof PROFILE_UNKNOWN_FIELDS)[number];

export interface TaskAuthorityCeilings {
  readonly authority: "none";
  readonly minimumRisk: TaskRisk;
  readonly minimumClassification: DataClassification;
  readonly maximumEditScope: EditScope;
  readonly requiredCapabilities: readonly TaskCapability[];
  readonly requiredLocality: "local" | "any";
  readonly approvalRequired: boolean;
  readonly fingerprint: string;
}

export function taskAuthorityCeilingsFingerprint(
  value: Omit<TaskAuthorityCeilings, "fingerprint">
): string {
  return digest(value);
}

function parseAuthorityCeilings(value: unknown, path: string): TaskAuthorityCeilings {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "authority",
      "minimumRisk",
      "minimumClassification",
      "maximumEditScope",
      "requiredCapabilities",
      "requiredLocality",
      "approvalRequired",
      "fingerprint"
    ],
    path
  );
  const unsigned = Object.freeze({
    authority: ensureEnum(record["authority"], `${path}.authority`, ["none"] as const),
    minimumRisk: ensureEnum(record["minimumRisk"], `${path}.minimumRisk`, TASK_RISKS),
    minimumClassification: ensureEnum(
      record["minimumClassification"],
      `${path}.minimumClassification`,
      DATA_CLASSIFICATIONS
    ),
    maximumEditScope: ensureEnum(record["maximumEditScope"], `${path}.maximumEditScope`, EDIT_SCOPES),
    requiredCapabilities: ensureEnumArray(
      record["requiredCapabilities"],
      `${path}.requiredCapabilities`,
      TASK_CAPABILITIES,
      TASK_CAPABILITIES.length
    ),
    requiredLocality: ensureEnum(
      record["requiredLocality"],
      `${path}.requiredLocality`,
      ["local", "any"] as const
    ),
    approvalRequired: ensureBoolean(record["approvalRequired"], `${path}.approvalRequired`)
  });
  const fingerprint = ensureString(record["fingerprint"], `${path}.fingerprint`, {
    minLength: 64,
    maxLength: 64,
    pattern: HEX_64,
    patternName: "authority fingerprint"
  });
  if (taskAuthorityCeilingsFingerprint(unsigned) !== fingerprint) {
    fail(`${path}.fingerprint`, "fingerprint_mismatch", "does not match authority ceilings.");
  }
  return Object.freeze({ ...unsigned, fingerprint });
}

export function createTaskAuthorityCeilings(
  value: Omit<TaskAuthorityCeilings, "authority" | "fingerprint">
): TaskAuthorityCeilings {
  const unsigned = Object.freeze({ authority: "none" as const, ...value });
  return parseAuthorityCeilings({
    ...unsigned,
    fingerprint: taskAuthorityCeilingsFingerprint(unsigned)
  }, "authority");
}

export interface TaskProfileRequest {
  readonly schemaVersion: typeof PROFILER_SCHEMA_VERSION;
  readonly profiledAt: string;
  readonly requirements: TaskRequirements;
  readonly authorityCeilings: TaskAuthorityCeilings;
  readonly repositoryIndex: RepositoryIndex | null;
  readonly contextPack: ContextPack | null;
  readonly compiledPrompt: CompiledThinkerPrompt | null;
  readonly thinkerProposal: ThinkerProposal | null;
  readonly selectedProposalTaskId: string | null;
  readonly classifierHint: ClassifierHint | null;
  readonly allowClassifierFallback: boolean;
}

export function parseTaskProfileRequest(
  value: unknown,
  path = "taskProfileRequest"
): TaskProfileRequest {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "schemaVersion",
      "profiledAt",
      "requirements",
      "authorityCeilings",
      "repositoryIndex",
      "contextPack",
      "compiledPrompt",
      "thinkerProposal",
      "selectedProposalTaskId",
      "classifierHint",
      "allowClassifierFallback"
    ],
    path
  );
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, PROFILER_SCHEMA_VERSION);
  const request = Object.freeze({
    schemaVersion: PROFILER_SCHEMA_VERSION,
    profiledAt: ensureTimestamp(record["profiledAt"], `${path}.profiledAt`),
    requirements: parseTaskRequirements(record["requirements"], `${path}.requirements`),
    authorityCeilings: parseAuthorityCeilings(
      record["authorityCeilings"],
      `${path}.authorityCeilings`
    ),
    repositoryIndex: ensureNullable(record["repositoryIndex"], (raw) =>
      parseRepositoryIndex(raw, `${path}.repositoryIndex`)
    ),
    contextPack: ensureNullable(record["contextPack"], (raw) =>
      parseContextPack(raw, `${path}.contextPack`)
    ),
    compiledPrompt: ensureNullable(record["compiledPrompt"], (raw) =>
      parseCompiledThinkerPrompt(raw, `${path}.compiledPrompt`)
    ),
    thinkerProposal: ensureNullable(record["thinkerProposal"], (raw) =>
      parseThinkerProposal(raw, `${path}.thinkerProposal`)
    ),
    selectedProposalTaskId: ensureNullable(record["selectedProposalTaskId"], (raw) =>
      ensureString(raw, `${path}.selectedProposalTaskId`, {
        maxLength: 64,
        pattern: SAFE_KIND,
        patternName: "proposal task identifier"
      })
    ),
    classifierHint: ensureNullable(record["classifierHint"], (raw) =>
      parseClassifierHint(raw, `${path}.classifierHint`)
    ),
    allowClassifierFallback: ensureBoolean(
      record["allowClassifierFallback"],
      `${path}.allowClassifierFallback`
    )
  });
  const editScopeRank = EDIT_SCOPES.indexOf(request.requirements.editScope);
  if (editScopeRank > EDIT_SCOPES.indexOf(request.authorityCeilings.maximumEditScope)) {
    fail(`${path}.requirements.editScope`, "authority_ceiling_exceeded", "exceeds maximum edit scope.");
  }
  if (
    request.selectedProposalTaskId !== null &&
    request.thinkerProposal?.tasks.some(
      (task) => task.proposalId === request.selectedProposalTaskId
    ) !== true
  ) {
    fail(`${path}.selectedProposalTaskId`, "unknown_proposal_task", "must reference the proposal.");
  }
  return request;
}

export interface CountMeasurement {
  readonly key: string;
  readonly count: number;
}

export interface RepositoryMeasurements {
  readonly sourceFingerprint: string;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly declaredBytes: number;
  readonly indexedTextBytes: number;
  readonly manifestCount: number;
  readonly workspaceManifestCount: number;
  readonly dependencyCount: number;
  readonly rejectionCount: number;
  readonly languageCounts: readonly CountMeasurement[];
  readonly fileKindCounts: readonly CountMeasurement[];
  readonly relevantLexicalResultCount: number;
  readonly limitsExhausted: boolean;
  readonly diagnosticsTruncated: boolean;
}

export interface ContextMeasurements {
  readonly sourceFingerprint: string;
  readonly requestFingerprint: string;
  readonly exactBytes: number;
  readonly conservativeUnits: number;
  readonly itemCount: number;
  readonly omissionCount: number;
  readonly omissionsTruncated: boolean;
  readonly truncatedItemCount: number;
  readonly sentinelOccurrences: number;
  readonly diagnosticCount: number;
  readonly categoryBytes: readonly CountMeasurement[];
  readonly sourceKindBytes: readonly CountMeasurement[];
}

export interface PromptMeasurements {
  readonly sourceFingerprint: string;
  readonly templateVersion: number;
  readonly outputSchemaVersion: number;
  readonly exactPromptBytes: number;
  readonly schemaBytes: number;
  readonly contextBytes: number;
  readonly messageCount: number;
  readonly toolCount: number;
  readonly requestedMaximumOutputTokens: number | null;
  readonly targetFingerprint: string;
}

export interface ProposalMeasurements {
  readonly sourceFingerprint: string;
  readonly authority: "none";
  readonly taskCount: number;
  readonly dependencyCount: number;
  readonly acceptanceCriterionCount: number;
  readonly evidenceReferenceCount: number;
  readonly unsupportedAssumptionCount: number;
  readonly selectedTaskId: string | null;
}

export interface TaskProfileMeasurements {
  readonly repository: RepositoryMeasurements | null;
  readonly context: ContextMeasurements | null;
  readonly prompt: PromptMeasurements | null;
  readonly proposal: ProposalMeasurements | null;
}

export interface InferredProfileFacts {
  readonly complexityFloor: number;
  readonly reasoningFloor: ReasoningDemand;
  readonly riskFloor: TaskRisk;
  readonly classificationFloor: DataClassification;
  readonly requiredCapabilities: readonly TaskCapability[];
  readonly reasonCodes: readonly string[];
}

export interface ProfileConfidence {
  readonly score: number;
  readonly completeness: ProfileCompleteness;
  readonly reasonCodes: readonly string[];
}

export interface TaskProfile {
  readonly schemaVersion: typeof PROFILER_SCHEMA_VERSION;
  readonly algorithmVersion: typeof TASK_PROFILE_ALGORITHM_VERSION;
  readonly provenanceVersion: typeof TASK_PROFILE_PROVENANCE_VERSION;
  readonly profiledAt: string;
  readonly configurationFingerprint: string;
  readonly declared: TaskRequirements;
  readonly authorityCeilings: TaskAuthorityCeilings;
  readonly measured: TaskProfileMeasurements;
  readonly inferred: InferredProfileFacts;
  readonly classifierHint: ClassifierHint | null;
  readonly classifierOutcome: ClassifierFallbackResult["outcome"] | "not-requested";
  readonly classifierCode: Exclude<ClassifierFallbackResult, { readonly outcome: "hint" }>["code"] | null;
  readonly unknownFields: readonly ProfileUnknownField[];
  readonly effective: TaskRequirements;
  readonly confidence: ProfileConfidence;
  readonly authority: "none";
  readonly sourceFingerprints: readonly string[];
  readonly fingerprint: string;
}

function counts(values: readonly string[]): readonly CountMeasurement[] {
  const map = new Map<string, number>();
  for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
  return Object.freeze(
    [...map.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, count]) => Object.freeze({ key, count }))
  );
}

function measureRepository(index: RepositoryIndex): RepositoryMeasurements {
  return Object.freeze({
    sourceFingerprint: index.fingerprint,
    fileCount: index.totals.fileCount,
    directoryCount: index.totals.directoryCount,
    declaredBytes: index.totals.declaredBytes,
    indexedTextBytes: index.totals.indexedTextBytes,
    manifestCount: index.manifests.length,
    workspaceManifestCount: index.manifests.filter((manifest) => manifest.workspacePatterns.length > 0)
      .length,
    dependencyCount: index.dependencies.length,
    rejectionCount: index.rejections.length,
    languageCounts: counts(index.entries.map((entry) => entry.language.languageId)),
    fileKindCounts: counts(index.entries.map((entry) => entry.kind)),
    relevantLexicalResultCount: index.lexical.distinctTermCount,
    limitsExhausted: index.totals.limitsExhausted,
    diagnosticsTruncated: index.totals.diagnosticsTruncated
  });
}

function measureContext(pack: ContextPack): ContextMeasurements {
  return Object.freeze({
    sourceFingerprint: pack.fingerprint,
    requestFingerprint: pack.requestFingerprint,
    exactBytes: pack.usage.bytes,
    conservativeUnits: pack.usage.units,
    itemCount: pack.items.length,
    omissionCount: pack.omissions.length,
    omissionsTruncated: pack.omissionsTruncated,
    truncatedItemCount: pack.items.filter((item) => item.truncated).length,
    sentinelOccurrences: pack.items.reduce(
      (total, item) => total + item.frameSentinelOccurrences,
      0
    ),
    diagnosticCount: pack.diagnostics.length,
    categoryBytes: Object.freeze(
      Object.entries(pack.usage.bytesByCategory)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, count]) => Object.freeze({ key, count }))
    ),
    sourceKindBytes: Object.freeze(
      Object.entries(pack.usage.bytesBySourceKind)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, count]) => Object.freeze({ key, count }))
    )
  });
}

function measurePrompt(prompt: CompiledThinkerPrompt): PromptMeasurements {
  return Object.freeze({
    sourceFingerprint: prompt.fingerprint,
    templateVersion: prompt.templateVersion,
    outputSchemaVersion: prompt.outputSchemaVersion,
    exactPromptBytes: prompt.accounting.promptBytes,
    schemaBytes: prompt.accounting.schemaBytes,
    contextBytes: prompt.accounting.contextBytes,
    messageCount: prompt.inferenceRequest.messages.length,
    toolCount: prompt.inferenceRequest.tools.length,
    requestedMaximumOutputTokens: prompt.inferenceRequest.maxOutputTokens,
    targetFingerprint: prompt.target.fingerprint
  });
}

function measureProposal(
  proposal: ThinkerProposal,
  selectedTaskId: string | null
): ProposalMeasurements {
  return Object.freeze({
    sourceFingerprint: thinkerPlanFingerprint(proposal),
    authority: "none" as const,
    taskCount: proposal.tasks.length,
    dependencyCount: proposal.tasks.reduce((total, task) => total + task.dependencies.length, 0),
    acceptanceCriterionCount: proposal.tasks.reduce(
      (total, task) => total + task.acceptanceCriteria.length,
      0
    ),
    evidenceReferenceCount: proposal.tasks.reduce((total, task) => total + task.evidence.length, 0),
    unsupportedAssumptionCount: proposal.tasks.reduce(
      (total, task) => total + task.unsupportedAssumptions.length,
      0
    ),
    selectedTaskId
  });
}

function maximumByOrder<T>(values: readonly T[], order: readonly T[]): T {
  return values.reduce((current, value) =>
    order.indexOf(value) > order.indexOf(current) ? value : current
  );
}

function inferFacts(
  request: TaskProfileRequest,
  measured: TaskProfileMeasurements
): InferredProfileFacts {
  const reasons: string[] = [];
  let complexityFloor: number = request.requirements.complexity;
  let reasoningFloor = request.requirements.reasoning;
  if (measured.repository?.limitsExhausted === true) {
    complexityFloor = Math.max(complexityFloor, 5);
    reasoningFloor = maximumByOrder([reasoningFloor, "high"], REASONING_DEMANDS);
    reasons.push("repository-limits-exhausted");
  } else if ((measured.repository?.fileCount ?? 0) >= 10_000) {
    complexityFloor = Math.max(complexityFloor, 4);
    reasoningFloor = maximumByOrder([reasoningFloor, "high"], REASONING_DEMANDS);
    reasons.push("large-repository");
  }
  if ((measured.context?.omissionsTruncated ?? false) || (measured.context?.truncatedItemCount ?? 0) > 0) {
    reasoningFloor = maximumByOrder([reasoningFloor, "high"], REASONING_DEMANDS);
    reasons.push("context-incomplete");
  }
  const riskValues: TaskRisk[] = [
    request.requirements.risk,
    request.authorityCeilings.minimumRisk
  ];
  const classificationValues: DataClassification[] = [
    request.requirements.dataClassification,
    request.authorityCeilings.minimumClassification
  ];
  if (request.compiledPrompt !== null) {
    riskValues.push(request.compiledPrompt.minimumRisk);
    classificationValues.push(request.compiledPrompt.classification);
  }
  const riskFloor = maximumByOrder(riskValues, TASK_RISKS);
  const classificationFloor = classificationValues.reduce((current, value) =>
    compareDataClassification(value, current) > 0 ? value : current
  );
  if (riskFloor !== request.requirements.risk) reasons.push("trusted-risk-floor");
  if (classificationFloor !== request.requirements.dataClassification) {
    reasons.push("trusted-classification-floor");
  }
  const requiredCapabilities = Object.freeze(
    [...new Set([
      ...request.requirements.capabilities,
      ...request.authorityCeilings.requiredCapabilities
    ])].sort(compareText)
  );
  return Object.freeze({
    complexityFloor,
    reasoningFloor,
    riskFloor,
    classificationFloor,
    requiredCapabilities,
    reasonCodes: Object.freeze(reasons.sort(compareText))
  });
}

function unknownFieldsFor(request: TaskProfileRequest): readonly ProfileUnknownField[] {
  const result: ProfileUnknownField[] = [];
  if (request.repositoryIndex === null) result.push("repository-scale");
  if (request.contextPack === null) result.push("context-size");
  if (request.compiledPrompt === null) result.push("compiled-prompt-size");
  if (request.thinkerProposal === null) result.push("proposal-shape");
  if (request.requirements.expectedInputTokens === null) result.push("expected-input-tokens");
  if (request.requirements.expectedOutputTokens === null) result.push("expected-output-tokens");
  return Object.freeze(result.sort(compareText));
}

function confidenceFor(
  measured: TaskProfileMeasurements,
  unknownFields: readonly ProfileUnknownField[]
): ProfileConfidence {
  const reasons: string[] = [];
  let score = 1_000 - unknownFields.length * 100;
  if (measured.repository?.limitsExhausted === true) {
    score -= 200;
    reasons.push("repository-limit-exhaustion");
  }
  if (measured.repository?.diagnosticsTruncated === true) {
    score -= 100;
    reasons.push("repository-diagnostics-truncated");
  }
  if (measured.context?.omissionsTruncated === true) {
    score -= 150;
    reasons.push("context-omissions-truncated");
  }
  if ((measured.context?.truncatedItemCount ?? 0) > 0) {
    score -= 50;
    reasons.push("context-items-truncated");
  }
  if ((measured.context?.sentinelOccurrences ?? 0) > 0) {
    score -= 100;
    reasons.push("context-framing-sentinels");
  }
  for (const field of unknownFields) reasons.push(`unknown-${field}`);
  score = Math.max(0, score);
  const completeness: ProfileCompleteness =
    unknownFields.length === 0 && reasons.length === 0
      ? "complete"
      : score === 0
        ? "unknown"
        : "partial";
  return Object.freeze({
    score,
    completeness,
    reasonCodes: Object.freeze([...new Set(reasons)].sort(compareText))
  });
}

export function taskProfileFingerprint(value: Omit<TaskProfile, "fingerprint">): string {
  return digest(value);
}

function buildTaskProfile(
  request: TaskProfileRequest,
  configuration: ProfilerConfiguration,
  classifierOutcome: TaskProfile["classifierOutcome"],
  classifierCode: TaskProfile["classifierCode"]
): TaskProfile {
  if ((request.repositoryIndex?.totals.fileCount ?? 0) > configuration.maximumRepositoryFiles) {
    fail("taskProfileRequest.repositoryIndex", "profile_bound_exceeded", "repository file bound exceeded.");
  }
  if ((request.contextPack?.items.length ?? 0) > configuration.maximumContextItems) {
    fail("taskProfileRequest.contextPack", "profile_bound_exceeded", "context item bound exceeded.");
  }
  if ((request.thinkerProposal?.tasks.length ?? 0) > configuration.maximumProposalTasks) {
    fail("taskProfileRequest.thinkerProposal", "profile_bound_exceeded", "proposal task bound exceeded.");
  }
  const measured = Object.freeze({
    repository: request.repositoryIndex === null ? null : measureRepository(request.repositoryIndex),
    context: request.contextPack === null ? null : measureContext(request.contextPack),
    prompt: request.compiledPrompt === null ? null : measurePrompt(request.compiledPrompt),
    proposal:
      request.thinkerProposal === null
        ? null
        : measureProposal(request.thinkerProposal, request.selectedProposalTaskId)
  });
  const inferred = inferFacts(request, measured);
  const unknownFields = unknownFieldsFor(request);
  const effective = parseTaskRequirements({
    ...request.requirements,
    complexity: inferred.complexityFloor,
    reasoning: inferred.reasoningFloor,
    risk: inferred.riskFloor,
    capabilities: inferred.requiredCapabilities,
    dataClassification: inferred.classificationFloor
  }, "taskProfile.effective");
  const sourceFingerprints = Object.freeze(
    [...new Set([
      request.authorityCeilings.fingerprint,
      measured.repository?.sourceFingerprint,
      measured.context?.sourceFingerprint,
      measured.prompt?.sourceFingerprint,
      measured.proposal?.sourceFingerprint,
      request.classifierHint?.fingerprint
    ].filter((value): value is string => value !== undefined))]
      .sort(compareText)
  );
  const unsigned = Object.freeze({
    schemaVersion: PROFILER_SCHEMA_VERSION,
    algorithmVersion: TASK_PROFILE_ALGORITHM_VERSION,
    provenanceVersion: TASK_PROFILE_PROVENANCE_VERSION,
    profiledAt: request.profiledAt,
    configurationFingerprint: configuration.fingerprint,
    declared: request.requirements,
    authorityCeilings: request.authorityCeilings,
    measured,
    inferred,
    classifierHint: request.classifierHint,
    classifierOutcome,
    classifierCode,
    unknownFields,
    effective,
    confidence: confidenceFor(measured, unknownFields),
    authority: "none" as const,
    sourceFingerprints
  });
  return parseTaskProfile({ ...unsigned, fingerprint: taskProfileFingerprint(unsigned) });
}

function parseCountMeasurements(value: unknown, path: string): readonly CountMeasurement[] {
  const items = ensureArray(value, path, 512).map((raw, index) => {
    const itemPath = `${path}[${index}]`;
    const record = ensureRecord(raw, itemPath);
    ensureExactKeys(record, ["key", "count"], itemPath);
    return Object.freeze({
      key: ensureString(record["key"], `${itemPath}.key`, {
        minLength: 1,
        maxLength: 64,
        pattern: SAFE_KIND,
        patternName: "measurement key"
      }),
      count: safeCount(record["count"], `${itemPath}.count`)
    });
  });
  items.sort((left, right) => compareText(left.key, right.key));
  if (new Set(items.map((item) => item.key)).size !== items.length) {
    fail(path, "duplicate_measurement", "measurement keys must be unique.");
  }
  return Object.freeze(items);
}

function parseRepositoryMeasurements(value: unknown, path: string): RepositoryMeasurements {
  const record = ensureRecord(value, path);
  const keys = [
    "sourceFingerprint", "fileCount", "directoryCount", "declaredBytes", "indexedTextBytes",
    "manifestCount", "workspaceManifestCount", "dependencyCount", "rejectionCount",
    "languageCounts", "fileKindCounts", "relevantLexicalResultCount", "limitsExhausted",
    "diagnosticsTruncated"
  ] as const;
  ensureExactKeys(record, keys, path);
  const integer = (key: (typeof keys)[number]): number =>
    safeCount(record[key], `${path}.${key}`);
  return Object.freeze({
    sourceFingerprint: fingerprint(record["sourceFingerprint"], `${path}.sourceFingerprint`),
    fileCount: integer("fileCount"),
    directoryCount: integer("directoryCount"),
    declaredBytes: integer("declaredBytes"),
    indexedTextBytes: integer("indexedTextBytes"),
    manifestCount: integer("manifestCount"),
    workspaceManifestCount: integer("workspaceManifestCount"),
    dependencyCount: integer("dependencyCount"),
    rejectionCount: integer("rejectionCount"),
    languageCounts: parseCountMeasurements(record["languageCounts"], `${path}.languageCounts`),
    fileKindCounts: parseCountMeasurements(record["fileKindCounts"], `${path}.fileKindCounts`),
    relevantLexicalResultCount: integer("relevantLexicalResultCount"),
    limitsExhausted: ensureBoolean(record["limitsExhausted"], `${path}.limitsExhausted`),
    diagnosticsTruncated: ensureBoolean(
      record["diagnosticsTruncated"],
      `${path}.diagnosticsTruncated`
    )
  });
}

function fingerprint(value: unknown, path: string): string {
  return ensureString(value, path, {
    minLength: 64,
    maxLength: 64,
    pattern: HEX_64,
    patternName: "fingerprint"
  });
}

function parseContextMeasurements(value: unknown, path: string): ContextMeasurements {
  const record = ensureRecord(value, path);
  const keys = [
    "sourceFingerprint", "requestFingerprint", "exactBytes", "conservativeUnits", "itemCount",
    "omissionCount", "omissionsTruncated", "truncatedItemCount", "sentinelOccurrences",
    "diagnosticCount", "categoryBytes", "sourceKindBytes"
  ] as const;
  ensureExactKeys(record, keys, path);
  const integer = (key: (typeof keys)[number]): number =>
    safeCount(record[key], `${path}.${key}`);
  return Object.freeze({
    sourceFingerprint: fingerprint(record["sourceFingerprint"], `${path}.sourceFingerprint`),
    requestFingerprint: fingerprint(record["requestFingerprint"], `${path}.requestFingerprint`),
    exactBytes: integer("exactBytes"),
    conservativeUnits: integer("conservativeUnits"),
    itemCount: integer("itemCount"),
    omissionCount: integer("omissionCount"),
    omissionsTruncated: ensureBoolean(record["omissionsTruncated"], `${path}.omissionsTruncated`),
    truncatedItemCount: integer("truncatedItemCount"),
    sentinelOccurrences: integer("sentinelOccurrences"),
    diagnosticCount: integer("diagnosticCount"),
    categoryBytes: parseCountMeasurements(record["categoryBytes"], `${path}.categoryBytes`),
    sourceKindBytes: parseCountMeasurements(record["sourceKindBytes"], `${path}.sourceKindBytes`)
  });
}

function parsePromptMeasurements(value: unknown, path: string): PromptMeasurements {
  const record = ensureRecord(value, path);
  const keys = [
    "sourceFingerprint", "templateVersion", "outputSchemaVersion", "exactPromptBytes", "schemaBytes",
    "contextBytes", "messageCount", "toolCount", "requestedMaximumOutputTokens", "targetFingerprint"
  ] as const;
  ensureExactKeys(record, keys, path);
  return Object.freeze({
    sourceFingerprint: fingerprint(record["sourceFingerprint"], `${path}.sourceFingerprint`),
    templateVersion: safeCount(record["templateVersion"], `${path}.templateVersion`, 1),
    outputSchemaVersion: safeCount(
      record["outputSchemaVersion"],
      `${path}.outputSchemaVersion`,
      1
    ),
    exactPromptBytes: safeCount(record["exactPromptBytes"], `${path}.exactPromptBytes`),
    schemaBytes: safeCount(record["schemaBytes"], `${path}.schemaBytes`),
    contextBytes: safeCount(record["contextBytes"], `${path}.contextBytes`),
    messageCount: safeCount(record["messageCount"], `${path}.messageCount`),
    toolCount: safeCount(record["toolCount"], `${path}.toolCount`),
    requestedMaximumOutputTokens: ensureNullable(record["requestedMaximumOutputTokens"], (raw) =>
      safeCount(raw, `${path}.requestedMaximumOutputTokens`)
    ),
    targetFingerprint: fingerprint(record["targetFingerprint"], `${path}.targetFingerprint`)
  });
}

function parseProposalMeasurements(value: unknown, path: string): ProposalMeasurements {
  const record = ensureRecord(value, path);
  const keys = [
    "sourceFingerprint", "authority", "taskCount", "dependencyCount", "acceptanceCriterionCount",
    "evidenceReferenceCount", "unsupportedAssumptionCount", "selectedTaskId"
  ] as const;
  ensureExactKeys(record, keys, path);
  return Object.freeze({
    sourceFingerprint: fingerprint(record["sourceFingerprint"], `${path}.sourceFingerprint`),
    authority: ensureEnum(record["authority"], `${path}.authority`, ["none"] as const),
    taskCount: safeCount(record["taskCount"], `${path}.taskCount`),
    dependencyCount: safeCount(record["dependencyCount"], `${path}.dependencyCount`),
    acceptanceCriterionCount: safeCount(
      record["acceptanceCriterionCount"],
      `${path}.acceptanceCriterionCount`
    ),
    evidenceReferenceCount: safeCount(
      record["evidenceReferenceCount"],
      `${path}.evidenceReferenceCount`
    ),
    unsupportedAssumptionCount: safeCount(
      record["unsupportedAssumptionCount"],
      `${path}.unsupportedAssumptionCount`
    ),
    selectedTaskId: ensureNullable(record["selectedTaskId"], (raw) =>
      ensureString(raw, `${path}.selectedTaskId`, {
        maxLength: 64,
        pattern: SAFE_KIND,
        patternName: "proposal task identifier"
      })
    )
  });
}

function parseMeasurements(value: unknown, path: string): TaskProfileMeasurements {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["repository", "context", "prompt", "proposal"], path);
  return Object.freeze({
    repository: ensureNullable(record["repository"], (raw) =>
      parseRepositoryMeasurements(raw, `${path}.repository`)
    ),
    context: ensureNullable(record["context"], (raw) =>
      parseContextMeasurements(raw, `${path}.context`)
    ),
    prompt: ensureNullable(record["prompt"], (raw) =>
      parsePromptMeasurements(raw, `${path}.prompt`)
    ),
    proposal: ensureNullable(record["proposal"], (raw) =>
      parseProposalMeasurements(raw, `${path}.proposal`)
    )
  });
}

function parseInferred(value: unknown, path: string): InferredProfileFacts {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "complexityFloor", "reasoningFloor", "riskFloor", "classificationFloor",
      "requiredCapabilities", "reasonCodes"
    ],
    path
  );
  return Object.freeze({
    complexityFloor: ensureSafeInteger(record["complexityFloor"], `${path}.complexityFloor`, 1, 5),
    reasoningFloor: ensureEnum(record["reasoningFloor"], `${path}.reasoningFloor`, REASONING_DEMANDS),
    riskFloor: ensureEnum(record["riskFloor"], `${path}.riskFloor`, TASK_RISKS),
    classificationFloor: ensureEnum(
      record["classificationFloor"],
      `${path}.classificationFloor`,
      DATA_CLASSIFICATIONS
    ),
    requiredCapabilities: ensureEnumArray(
      record["requiredCapabilities"],
      `${path}.requiredCapabilities`,
      TASK_CAPABILITIES,
      TASK_CAPABILITIES.length
    ),
    reasonCodes: parseReasonCodes(record["reasonCodes"], `${path}.reasonCodes`)
  });
}

function parseReasonCodes(value: unknown, path: string): readonly string[] {
  const items = ensureArray(value, path, 64)
    .map((raw, index) =>
      ensureString(raw, `${path}[${index}]`, {
        minLength: 1,
        maxLength: 64,
        pattern: SAFE_KIND,
        patternName: "reason code"
      })
    )
    .sort(compareText);
  if (new Set(items).size !== items.length) fail(path, "duplicate_reason", "reasons must be unique.");
  return Object.freeze(items);
}

function parseConfidence(value: unknown, path: string): ProfileConfidence {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["score", "completeness", "reasonCodes"], path);
  return Object.freeze({
    score: ensureSafeInteger(record["score"], `${path}.score`, 0, 1_000),
    completeness: ensureEnum(record["completeness"], `${path}.completeness`, PROFILE_COMPLETENESS),
    reasonCodes: parseReasonCodes(record["reasonCodes"], `${path}.reasonCodes`)
  });
}

export function parseTaskProfile(value: unknown, path = "taskProfile"): TaskProfile {
  const record = ensureRecord(value, path);
  const keys = [
    "schemaVersion", "algorithmVersion", "provenanceVersion", "profiledAt",
    "configurationFingerprint", "declared", "authorityCeilings", "measured", "inferred",
    "classifierHint", "classifierOutcome", "classifierCode", "unknownFields", "effective", "confidence", "authority",
    "sourceFingerprints", "fingerprint"
  ] as const;
  ensureExactKeys(record, keys, path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, PROFILER_SCHEMA_VERSION);
  ensureSchemaVersion(
    record["algorithmVersion"],
    `${path}.algorithmVersion`,
    TASK_PROFILE_ALGORITHM_VERSION
  );
  ensureSchemaVersion(
    record["provenanceVersion"],
    `${path}.provenanceVersion`,
    TASK_PROFILE_PROVENANCE_VERSION
  );
  const sourceFingerprints = ensureArray(record["sourceFingerprints"], `${path}.sourceFingerprints`, 16)
    .map((raw, index) => fingerprint(raw, `${path}.sourceFingerprints[${index}]`))
    .sort(compareText);
  if (new Set(sourceFingerprints).size !== sourceFingerprints.length) {
    fail(`${path}.sourceFingerprints`, "duplicate_fingerprint", "source fingerprints must be unique.");
  }
  const unsigned = Object.freeze({
    schemaVersion: PROFILER_SCHEMA_VERSION,
    algorithmVersion: TASK_PROFILE_ALGORITHM_VERSION,
    provenanceVersion: TASK_PROFILE_PROVENANCE_VERSION,
    profiledAt: ensureTimestamp(record["profiledAt"], `${path}.profiledAt`),
    configurationFingerprint: fingerprint(
      record["configurationFingerprint"],
      `${path}.configurationFingerprint`
    ),
    declared: parseTaskRequirements(record["declared"], `${path}.declared`),
    authorityCeilings: parseAuthorityCeilings(
      record["authorityCeilings"],
      `${path}.authorityCeilings`
    ),
    measured: parseMeasurements(record["measured"], `${path}.measured`),
    inferred: parseInferred(record["inferred"], `${path}.inferred`),
    classifierHint: ensureNullable(record["classifierHint"], (raw) =>
      parseClassifierHint(raw, `${path}.classifierHint`)
    ),
    classifierOutcome: ensureEnum(
      record["classifierOutcome"],
      `${path}.classifierOutcome`,
      ["hint", "unknown", "not-requested"] as const
    ),
    classifierCode: ensureNullable(record["classifierCode"], (raw) =>
      ensureEnum(
        raw,
        `${path}.classifierCode`,
        ["DISABLED", "NOT_NEEDED", "UNAVAILABLE", "MALFORMED", "LOW_CONFIDENCE"] as const
      )
    ),
    unknownFields: Object.freeze(
      [...ensureEnumArray(
        record["unknownFields"],
        `${path}.unknownFields`,
        PROFILE_UNKNOWN_FIELDS,
        PROFILE_UNKNOWN_FIELDS.length
      )].sort(compareText)
    ),
    effective: parseTaskRequirements(record["effective"], `${path}.effective`),
    confidence: parseConfidence(record["confidence"], `${path}.confidence`),
    authority: ensureEnum(record["authority"], `${path}.authority`, ["none"] as const),
    sourceFingerprints: Object.freeze(sourceFingerprints)
  });
  if (record["classifierHint"] !== null && unsigned.classifierOutcome !== "hint") {
    fail(`${path}.classifierOutcome`, "classifier_outcome_mismatch", "a hint requires hint outcome.");
  }
  if (
    (unsigned.classifierOutcome === "unknown") !== (unsigned.classifierCode !== null) ||
    (unsigned.classifierOutcome === "hint") !== (unsigned.classifierHint !== null)
  ) {
    fail(
      `${path}.classifierCode`,
      "classifier_outcome_mismatch",
      "classifier outcome, hint, and structured unknown code must agree."
    );
  }
  const resultFingerprint = fingerprint(record["fingerprint"], `${path}.fingerprint`);
  if (taskProfileFingerprint(unsigned) !== resultFingerprint) {
    fail(`${path}.fingerprint`, "fingerprint_mismatch", "does not match task profile content.");
  }
  return Object.freeze({ ...unsigned, fingerprint: resultFingerprint });
}

export function profileTask(
  value: TaskProfileRequest | unknown,
  configurationValue: ProfilerConfiguration | unknown = DEFAULT_PROFILER_CONFIGURATION
): TaskProfile {
  const request = parseTaskProfileRequest(value);
  const configuration = parseProfilerConfiguration(configurationValue);
  return buildTaskProfile(
    request,
    configuration,
    request.classifierHint === null ? "not-requested" : "hint",
    null
  );
}

export interface TaskProfileSummary {
  readonly schemaVersion: typeof PROFILER_SCHEMA_VERSION;
  readonly profileFingerprint: string;
  readonly taskKind: TaskRequirements["kind"];
  readonly risk: TaskRisk;
  readonly classification: DataClassification;
  readonly repositoryFiles: number | null;
  readonly contextBytes: number | null;
  readonly promptBytes: number | null;
  readonly proposalTasks: number | null;
  readonly confidence: number;
  readonly completeness: ProfileCompleteness;
  readonly unknownFields: readonly ProfileUnknownField[];
  readonly authority: "none";
}

export function summarizeTaskProfile(profileValue: TaskProfile | unknown): TaskProfileSummary {
  const profile = parseTaskProfile(profileValue);
  return Object.freeze({
    schemaVersion: PROFILER_SCHEMA_VERSION,
    profileFingerprint: profile.fingerprint,
    taskKind: profile.effective.kind,
    risk: profile.effective.risk,
    classification: profile.effective.dataClassification,
    repositoryFiles: profile.measured.repository?.fileCount ?? null,
    contextBytes: profile.measured.context?.exactBytes ?? null,
    promptBytes: profile.measured.prompt?.exactPromptBytes ?? null,
    proposalTasks: profile.measured.proposal?.taskCount ?? null,
    confidence: profile.confidence.score,
    completeness: profile.confidence.completeness,
    unknownFields: profile.unknownFields,
    authority: "none"
  });
}

export interface TaskProfiler {
  readonly configuration: ProfilerConfiguration;
  profile(value: TaskProfileRequest | unknown): Promise<TaskProfile>;
}

export type TaskProfileObserver = (summary: TaskProfileSummary) => void;

export function createTaskProfiler(options: {
  readonly configuration?: ProfilerConfiguration | unknown;
  readonly classifierPort?: ClassifierPort | null;
  readonly observer?: TaskProfileObserver;
} = {}): TaskProfiler {
  const configuration = parseProfilerConfiguration(
    options.configuration ?? DEFAULT_PROFILER_CONFIGURATION
  );
  const classifier = createDeterministicClassifierFallback({
    port: options.classifierPort ?? null,
    enabled: configuration.classifierEnabled,
    minimumConfidence: configuration.minimumClassifierConfidence
  });
  return Object.freeze({
    configuration,
    profile: async (value: TaskProfileRequest | unknown): Promise<TaskProfile> => {
      let request = parseTaskProfileRequest(value);
      let outcome: TaskProfile["classifierOutcome"] =
        request.classifierHint === null ? "not-requested" : "hint";
      let classifierCode: TaskProfile["classifierCode"] = null;
      if (request.classifierHint === null && request.allowClassifierFallback) {
        const unknownFields = unknownFieldsFor(request);
        const classifierInput: ClassifierStructuralInput = Object.freeze({
          requestFingerprint: digest({
            requirements: request.requirements,
            authorityCeilingsFingerprint: request.authorityCeilings.fingerprint,
            sourceFingerprints: [
              request.repositoryIndex?.fingerprint,
              request.contextPack?.fingerprint,
              request.compiledPrompt?.fingerprint,
              request.thinkerProposal === null ? undefined : thinkerPlanFingerprint(request.thinkerProposal)
            ].filter((item): item is string => item !== undefined)
          }),
          unknownFields: Object.freeze(
            unknownFields.filter(
              (field): field is ClassifierStructuralInput["unknownFields"][number] =>
                field === "expected-input-tokens" ||
                field === "expected-output-tokens" ||
                field === "repository-scale"
            )
          ),
          repositoryFileCount: request.repositoryIndex?.totals.fileCount ?? null,
          contextItemCount: request.contextPack?.items.length ?? null,
          proposalTaskCount: request.thinkerProposal?.tasks.length ?? null
        });
        const result = await classifier.classify(classifierInput);
        outcome = result.outcome;
        if (result.outcome === "hint") {
          request = Object.freeze({ ...request, classifierHint: result.hint });
        } else {
          classifierCode = result.code;
        }
      }
      const profile = buildTaskProfile(request, configuration, outcome, classifierCode);
      if (options.observer !== undefined) {
        try {
          options.observer(summarizeTaskProfile(profile));
        } catch {
          // Observers are non-authoritative and their values are never inspected or serialized.
        }
      }
      return profile;
    }
  });
}
