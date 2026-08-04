import { createHash } from "node:crypto";
import {
  DATA_CLASSIFICATIONS,
  EDIT_SCOPES,
  REDACTION_KINDS,
  REASONING_DEMANDS,
  TASK_CAPABILITIES,
  TASK_KINDS,
  TASK_RISKS,
  parseDataHandlingPolicy,
  parseModelCapabilities,
  parseTaskRequirements,
  toCanonicalJson,
  validation,
  type DataClassification,
  type DataHandlingPolicy,
  type EditScope,
  type ModelCapabilities,
  type ReasoningDemand,
  type RedactionKind,
  type TaskCapability,
  type TaskKind,
  type TaskRequirements,
  type TaskRisk
} from "@ai-dev-os/domain";
import {
  contextRequestFingerprint,
  parseContextConfiguration,
  parseContextPack,
  parseContextRequest,
  type ContextConfiguration,
  type ContextPack,
  type ContextRequest
} from "@ai-dev-os/context";
import {
  parseApprovalEvidence,
  parseApprovalScope,
  type ApprovalEvidence,
  type ApprovalScope
} from "@ai-dev-os/policy";
import {
  parseDeadline,
  parseExecutionTraceMetadata,
  parseProviderDescriptor,
  parseProviderExtensions,
  type ExecutionTraceMetadata,
  type ProviderDescriptor,
  type ProviderExtension
} from "@ai-dev-os/providers";
import {
  MAX_PROPOSAL_DEPENDENCIES,
  MAX_PROPOSAL_LIST_ITEMS,
  MAX_PROPOSAL_TASKS,
  MAX_PROPOSAL_TEXT
} from "./schema.js";

const {
  ensureArray,
  ensureEnum,
  ensureExactKeys,
  ensureNullable,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
  ensureString,
  ensureTimestamp,
  fail
} = validation;

export const PROMPT_COMPILER_SCHEMA_VERSION = 1 as const;
export const PROMPT_TEMPLATE_VERSION = 1 as const;
export const PROMPT_FINGERPRINT_ALGORITHM_VERSION = 1 as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function id(value: unknown, path: string, maxLength = 128): string {
  return ensureString(value, path, {
    maxLength,
    pattern: ID_PATTERN,
    patternName: "stable identifier"
  });
}

function hex64(value: unknown, path: string): string {
  return ensureString(value, path, {
    minLength: 64,
    maxLength: 64,
    pattern: HEX_64,
    patternName: "sha-256 digest"
  });
}

function hash(value: unknown, label: string): string {
  return createHash("sha256").update(toCanonicalJson(value, label), "utf8").digest("hex");
}

function orderedEnums<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[]
): readonly T[] {
  const items = ensureArray(value, path, allowed.length);
  const selected = new Set<T>();
  items.forEach((item, index) => selected.add(ensureEnum(item, `${path}[${index}]`, allowed)));
  return Object.freeze(allowed.filter((item) => selected.has(item)));
}

export interface PromptCompilerConfiguration {
  readonly schemaVersion: typeof PROMPT_COMPILER_SCHEMA_VERSION;
  readonly templateVersion: typeof PROMPT_TEMPLATE_VERSION;
  readonly maxPromptBytes: number;
  readonly maxMessageBytes: number;
  readonly maxMessages: number;
  readonly maxSchemaBytes: number;
  readonly maxContextBytes: number;
  readonly maxOutputTokens: number;
  readonly maxAuthorizationAgeMs: number;
}

export const DEFAULT_PROMPT_COMPILER_CONFIGURATION: PromptCompilerConfiguration = Object.freeze({
  schemaVersion: PROMPT_COMPILER_SCHEMA_VERSION,
  templateVersion: PROMPT_TEMPLATE_VERSION,
  maxPromptBytes: 262_144,
  maxMessageBytes: 196_608,
  maxMessages: 3,
  maxSchemaBytes: 16_384,
  maxContextBytes: 180_000,
  maxOutputTokens: 8_192,
  maxAuthorizationAgeMs: 300_000
});

export function parsePromptCompilerConfiguration(
  value: unknown,
  path = "promptCompilerConfiguration"
): PromptCompilerConfiguration {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "schemaVersion",
      "templateVersion",
      "maxPromptBytes",
      "maxMessageBytes",
      "maxMessages",
      "maxSchemaBytes",
      "maxContextBytes",
      "maxOutputTokens",
      "maxAuthorizationAgeMs"
    ],
    path
  );
  ensureSchemaVersion(
    record["schemaVersion"],
    `${path}.schemaVersion`,
    PROMPT_COMPILER_SCHEMA_VERSION
  );
  ensureSchemaVersion(
    record["templateVersion"],
    `${path}.templateVersion`,
    PROMPT_TEMPLATE_VERSION
  );
  const result = Object.freeze({
    schemaVersion: PROMPT_COMPILER_SCHEMA_VERSION,
    templateVersion: PROMPT_TEMPLATE_VERSION,
    maxPromptBytes: ensureSafeInteger(
      record["maxPromptBytes"],
      `${path}.maxPromptBytes`,
      1_024,
      4_194_304
    ),
    maxMessageBytes: ensureSafeInteger(
      record["maxMessageBytes"],
      `${path}.maxMessageBytes`,
      256,
      1_048_576
    ),
    maxMessages: ensureSafeInteger(record["maxMessages"], `${path}.maxMessages`, 3, 16),
    maxSchemaBytes: ensureSafeInteger(
      record["maxSchemaBytes"],
      `${path}.maxSchemaBytes`,
      1_024,
      16_384
    ),
    maxContextBytes: ensureSafeInteger(
      record["maxContextBytes"],
      `${path}.maxContextBytes`,
      0,
      1_048_576
    ),
    maxOutputTokens: ensureSafeInteger(
      record["maxOutputTokens"],
      `${path}.maxOutputTokens`,
      1,
      1_000_000
    ),
    maxAuthorizationAgeMs: ensureSafeInteger(
      record["maxAuthorizationAgeMs"],
      `${path}.maxAuthorizationAgeMs`,
      1,
      86_400_000
    )
  });
  if (result.maxMessageBytes > result.maxPromptBytes) {
    fail(`${path}.maxMessageBytes`, "inconsistent_bound", "cannot exceed maxPromptBytes.");
  }
  if (result.maxContextBytes > result.maxMessageBytes) {
    fail(`${path}.maxContextBytes`, "inconsistent_bound", "cannot exceed maxMessageBytes.");
  }
  return result;
}

export function promptCompilerConfigurationFingerprint(
  configuration: PromptCompilerConfiguration
): string {
  return hash(parsePromptCompilerConfiguration(configuration), "promptCompilerConfiguration");
}

export interface PromptTargetSnapshot {
  readonly schemaVersion: typeof PROMPT_COMPILER_SCHEMA_VERSION;
  readonly instanceId: string;
  readonly provider: ProviderDescriptor;
  readonly model: ModelCapabilities;
  readonly fingerprint: string;
}

function targetFingerprintInput(
  target: Omit<PromptTargetSnapshot, "fingerprint">
): Omit<PromptTargetSnapshot, "fingerprint"> {
  return target;
}

export function promptTargetFingerprint(
  target: Omit<PromptTargetSnapshot, "fingerprint">
): string {
  return hash(targetFingerprintInput(target), "promptTarget");
}

export function sealPromptTarget(
  target: Omit<PromptTargetSnapshot, "fingerprint">
): PromptTargetSnapshot {
  const parsed = parsePromptTarget({
    ...target,
    fingerprint: promptTargetFingerprint(target)
  });
  return parsed;
}

export function parsePromptTarget(value: unknown, path = "promptTarget"): PromptTargetSnapshot {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["schemaVersion", "instanceId", "provider", "model", "fingerprint"], path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, PROMPT_COMPILER_SCHEMA_VERSION);
  const instanceId = id(record["instanceId"], `${path}.instanceId`);
  const provider = parseProviderDescriptor(record["provider"], `${path}.provider`);
  const model = parseModelCapabilities(record["model"], `${path}.model`);
  if (provider.instanceId !== instanceId) {
    fail(`${path}.instanceId`, "provider_instance_mismatch", "must match provider.instanceId.");
  }
  if (provider.kind !== "inference") {
    fail(`${path}.provider.kind`, "wrong_provider_kind", "must be inference.");
  }
  if (provider.providerId !== model.providerId || provider.locality !== model.locality) {
    fail(`${path}.model`, "provider_model_mismatch", "must belong to the selected provider and locality.");
  }
  const unsealed = Object.freeze({
    schemaVersion: PROMPT_COMPILER_SCHEMA_VERSION,
    instanceId,
    provider,
    model
  });
  const fingerprint = hex64(record["fingerprint"], `${path}.fingerprint`);
  if (fingerprint !== promptTargetFingerprint(unsealed)) {
    fail(`${path}.fingerprint`, "fingerprint_mismatch", "does not match the target contents.");
  }
  return Object.freeze({ ...unsealed, fingerprint });
}

export interface PromptAuthorityEnvelope {
  readonly schemaVersion: typeof PROMPT_COMPILER_SCHEMA_VERSION;
  readonly minimumRisk: TaskRisk;
  readonly minimumClassification: DataClassification;
  readonly permittedTaskKinds: readonly TaskKind[];
  readonly capabilityCeiling: readonly TaskCapability[];
  readonly editScopeCeiling: EditScope;
  readonly reasoningCeiling: ReasoningDemand;
  readonly maxTasks: number;
  readonly maxDependenciesPerTask: number;
  readonly maxCriteriaPerTask: number;
  readonly maxEvidencePerTask: number;
  readonly maxUnsupportedAssumptionsPerTask: number;
  readonly maxAssumptions: number;
  readonly maxRisks: number;
  readonly maxQuestions: number;
  readonly maxCompletionCriteria: number;
  readonly maxTextLength: number;
  readonly maxTitleLength: number;
  readonly maxObjectiveLength: number;
}

export function parsePromptAuthorityEnvelope(
  value: unknown,
  path = "authority"
): PromptAuthorityEnvelope {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "schemaVersion",
      "minimumRisk",
      "minimumClassification",
      "permittedTaskKinds",
      "capabilityCeiling",
      "editScopeCeiling",
      "reasoningCeiling",
      "maxTasks",
      "maxDependenciesPerTask",
      "maxCriteriaPerTask",
      "maxEvidencePerTask",
      "maxUnsupportedAssumptionsPerTask",
      "maxAssumptions",
      "maxRisks",
      "maxQuestions",
      "maxCompletionCriteria",
      "maxTextLength",
      "maxTitleLength",
      "maxObjectiveLength"
    ],
    path
  );
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, PROMPT_COMPILER_SCHEMA_VERSION);
  const permittedTaskKinds = orderedEnums(
    record["permittedTaskKinds"],
    `${path}.permittedTaskKinds`,
    TASK_KINDS
  );
  if (permittedTaskKinds.length === 0) {
    fail(`${path}.permittedTaskKinds`, "empty_authority", "must permit at least one task kind.");
  }
  const capabilityCeiling = orderedEnums(
    record["capabilityCeiling"],
    `${path}.capabilityCeiling`,
    TASK_CAPABILITIES
  );
  const editScopeCeiling = ensureEnum(
    record["editScopeCeiling"],
    `${path}.editScopeCeiling`,
    EDIT_SCOPES
  );
  if (editScopeCeiling !== "none" && !capabilityCeiling.includes("code-edit")) {
    fail(`${path}.capabilityCeiling`, "missing_code_edit", "must include code-edit for a writable edit scope.");
  }
  return Object.freeze({
    schemaVersion: PROMPT_COMPILER_SCHEMA_VERSION,
    minimumRisk: ensureEnum(record["minimumRisk"], `${path}.minimumRisk`, TASK_RISKS),
    minimumClassification: ensureEnum(
      record["minimumClassification"],
      `${path}.minimumClassification`,
      DATA_CLASSIFICATIONS
    ),
    permittedTaskKinds,
    capabilityCeiling,
    editScopeCeiling,
    reasoningCeiling: ensureEnum(
      record["reasoningCeiling"],
      `${path}.reasoningCeiling`,
      REASONING_DEMANDS
    ),
    maxTasks: ensureSafeInteger(record["maxTasks"], `${path}.maxTasks`, 0, MAX_PROPOSAL_TASKS),
    maxDependenciesPerTask: ensureSafeInteger(
      record["maxDependenciesPerTask"],
      `${path}.maxDependenciesPerTask`,
      0,
      MAX_PROPOSAL_DEPENDENCIES
    ),
    maxCriteriaPerTask: ensureSafeInteger(
      record["maxCriteriaPerTask"],
      `${path}.maxCriteriaPerTask`,
      0,
      MAX_PROPOSAL_LIST_ITEMS
    ),
    maxEvidencePerTask: ensureSafeInteger(
      record["maxEvidencePerTask"],
      `${path}.maxEvidencePerTask`,
      0,
      MAX_PROPOSAL_LIST_ITEMS
    ),
    maxUnsupportedAssumptionsPerTask: ensureSafeInteger(
      record["maxUnsupportedAssumptionsPerTask"],
      `${path}.maxUnsupportedAssumptionsPerTask`,
      0,
      MAX_PROPOSAL_LIST_ITEMS
    ),
    maxAssumptions: ensureSafeInteger(
      record["maxAssumptions"],
      `${path}.maxAssumptions`,
      0,
      MAX_PROPOSAL_LIST_ITEMS
    ),
    maxRisks: ensureSafeInteger(record["maxRisks"], `${path}.maxRisks`, 0, MAX_PROPOSAL_LIST_ITEMS),
    maxQuestions: ensureSafeInteger(
      record["maxQuestions"],
      `${path}.maxQuestions`,
      0,
      MAX_PROPOSAL_LIST_ITEMS
    ),
    maxCompletionCriteria: ensureSafeInteger(
      record["maxCompletionCriteria"],
      `${path}.maxCompletionCriteria`,
      0,
      MAX_PROPOSAL_LIST_ITEMS
    ),
    maxTextLength: ensureSafeInteger(
      record["maxTextLength"],
      `${path}.maxTextLength`,
      1,
      MAX_PROPOSAL_TEXT
    ),
    maxTitleLength: ensureSafeInteger(record["maxTitleLength"], `${path}.maxTitleLength`, 1, 240),
    maxObjectiveLength: ensureSafeInteger(
      record["maxObjectiveLength"],
      `${path}.maxObjectiveLength`,
      1,
      MAX_PROPOSAL_TEXT
    )
  });
}

export function promptAuthorityFingerprint(authority: PromptAuthorityEnvelope): string {
  return hash(parsePromptAuthorityEnvelope(authority), "promptAuthority");
}

export interface PromptContextBinding {
  readonly request: ContextRequest;
  readonly configuration: ContextConfiguration;
  readonly policyDecisionFingerprint: string | null;
  readonly pack: ContextPack;
}

function parseContextBinding(value: unknown, path: string): PromptContextBinding {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["request", "configuration", "policyDecisionFingerprint", "pack"], path);
  const request = parseContextRequest(record["request"], `${path}.request`);
  const parsedConfiguration = parseContextConfiguration(record["configuration"], `${path}.configuration`);
  const configuration = parsedConfiguration.ok
    ? parsedConfiguration.value
    : fail(
        `${path}.configuration`,
        "invalid_context_configuration",
        "must be a valid context configuration."
      );
  const pack = parseContextPack(record["pack"], `${path}.pack`);
  const policyDecisionFingerprint = ensureNullable(record["policyDecisionFingerprint"], (raw) =>
    hex64(raw, `${path}.policyDecisionFingerprint`)
  );
  const expected = contextRequestFingerprint({
    request,
    configuration,
    estimatorId: pack.estimator.estimatorId,
    policyDecisionFingerprint
  });
  if (expected !== pack.requestFingerprint) {
    fail(`${path}.pack.requestFingerprint`, "request_binding_mismatch", "does not match the supplied context request inputs.");
  }
  return Object.freeze({
    request,
    configuration,
    policyDecisionFingerprint,
    pack
  });
}

export interface PromptPolicyInput {
  readonly handlingPolicy: DataHandlingPolicy;
  readonly scope: ApprovalScope;
  readonly transformationsApplied: readonly RedactionKind[];
  readonly transformationEvidence: readonly PromptTransformationEvidence[];
  readonly approvalEvidence: readonly ApprovalEvidence[];
  readonly retentionDays: number | null;
}

export interface PromptTransformationEvidence {
  readonly kind: RedactionKind;
  readonly evidenceRef: string;
  readonly evidenceFingerprint: string;
  readonly outputContextPackFingerprint: string;
}

function parseTransformationEvidence(
  value: unknown,
  path: string
): PromptTransformationEvidence {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    ["kind", "evidenceRef", "evidenceFingerprint", "outputContextPackFingerprint"],
    path
  );
  return Object.freeze({
    kind: ensureEnum(record["kind"], `${path}.kind`, REDACTION_KINDS),
    evidenceRef: id(record["evidenceRef"], `${path}.evidenceRef`),
    evidenceFingerprint: hex64(record["evidenceFingerprint"], `${path}.evidenceFingerprint`),
    outputContextPackFingerprint: hex64(
      record["outputContextPackFingerprint"],
      `${path}.outputContextPackFingerprint`
    )
  });
}

function parsePolicyInput(value: unknown, path: string): PromptPolicyInput {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "handlingPolicy",
      "scope",
      "transformationsApplied",
      "transformationEvidence",
      "approvalEvidence",
      "retentionDays"
    ],
    path
  );
  const transformationsApplied = orderedEnums(
    record["transformationsApplied"],
    `${path}.transformationsApplied`,
    REDACTION_KINDS
  );
  const rawEvidence = ensureArray(
    record["transformationEvidence"],
    `${path}.transformationEvidence`,
    REDACTION_KINDS.length
  );
  const parsedEvidence = rawEvidence.map((item, index) =>
    parseTransformationEvidence(item, `${path}.transformationEvidence[${index}]`)
  );
  const evidenceByKind = new Map(parsedEvidence.map((item) => [item.kind, item]));
  if (
    evidenceByKind.size !== parsedEvidence.length ||
    transformationsApplied.length !== parsedEvidence.length ||
    transformationsApplied.some((kind) => !evidenceByKind.has(kind))
  ) {
    fail(
      `${path}.transformationEvidence`,
      "transformation_evidence_mismatch",
      "must prove every applied transformation exactly once."
    );
  }
  const transformationEvidence = Object.freeze(
    REDACTION_KINDS.filter((kind) => evidenceByKind.has(kind)).map(
      (kind) => evidenceByKind.get(kind)!
    )
  );
  const evidence = ensureArray(record["approvalEvidence"], `${path}.approvalEvidence`, 32)
    .map((item, index) => parseApprovalEvidence(item, `${path}.approvalEvidence[${index}]`))
    .sort((a, b) =>
      compareText(a.approvalRequestId, b.approvalRequestId) || compareText(a.evidenceRef, b.evidenceRef)
    );
  return Object.freeze({
    handlingPolicy: parseDataHandlingPolicy(record["handlingPolicy"], `${path}.handlingPolicy`),
    scope: parseApprovalScope(record["scope"], `${path}.scope`),
    transformationsApplied,
    transformationEvidence,
    approvalEvidence: Object.freeze(evidence),
    retentionDays: ensureNullable(record["retentionDays"], (raw) =>
      ensureSafeInteger(raw, `${path}.retentionDays`, 0, 36_500)
    )
  });
}

export interface PromptCompilationRequest {
  readonly schemaVersion: typeof PROMPT_COMPILER_SCHEMA_VERSION;
  readonly requestId: string;
  readonly context: PromptContextBinding;
  readonly taskRequirements: TaskRequirements;
  readonly authority: PromptAuthorityEnvelope;
  readonly target: PromptTargetSnapshot;
  readonly policy: PromptPolicyInput;
  readonly trace: ExecutionTraceMetadata;
  readonly authorizationAt: string;
  readonly deadline: string | null;
  readonly extensions: readonly ProviderExtension[];
}

function maximumClassification(request: PromptCompilationRequest): DataClassification {
  let rank = DATA_CLASSIFICATIONS.indexOf(request.taskRequirements.dataClassification);
  rank = Math.max(rank, DATA_CLASSIFICATIONS.indexOf(request.authority.minimumClassification));
  for (const item of request.context.pack.items) {
    rank = Math.max(rank, DATA_CLASSIFICATIONS.indexOf(item.classification));
  }
  return DATA_CLASSIFICATIONS[rank] ?? "secret";
}

export function effectivePromptClassification(
  request: PromptCompilationRequest
): DataClassification {
  return maximumClassification(request);
}

export function effectivePromptRisk(request: PromptCompilationRequest): TaskRisk {
  const rank = Math.max(
    TASK_RISKS.indexOf(request.taskRequirements.risk),
    TASK_RISKS.indexOf(request.authority.minimumRisk)
  );
  return TASK_RISKS[rank] ?? "critical";
}

function validateRequestRelationships(request: PromptCompilationRequest, path: string): void {
  if (!request.authority.permittedTaskKinds.includes(request.taskRequirements.kind)) {
    fail(`${path}.taskRequirements.kind`, "task_kind_outside_authority", "is outside the authority envelope.");
  }
  for (const capability of request.taskRequirements.capabilities) {
    if (!request.authority.capabilityCeiling.includes(capability)) {
      fail(`${path}.taskRequirements.capabilities`, "capability_outside_authority", "exceeds the authority envelope.");
    }
  }
  if (
    EDIT_SCOPES.indexOf(request.taskRequirements.editScope) >
    EDIT_SCOPES.indexOf(request.authority.editScopeCeiling)
  ) {
    fail(`${path}.taskRequirements.editScope`, "edit_scope_outside_authority", "exceeds the authority envelope.");
  }
  if (
    REASONING_DEMANDS.indexOf(request.taskRequirements.reasoning) >
    REASONING_DEMANDS.indexOf(request.authority.reasoningCeiling)
  ) {
    fail(`${path}.taskRequirements.reasoning`, "reasoning_outside_authority", "exceeds the authority envelope.");
  }
  if (request.policy.handlingPolicy.classification !== maximumClassification(request)) {
    fail(`${path}.policy.handlingPolicy.classification`, "classification_mismatch", "must equal the effective content classification.");
  }
  const scope = request.policy.scope;
  if (
    scope.projectId !== request.context.request.projectId ||
    scope.workspaceId !== request.context.request.workspaceId ||
    scope.providerInstanceId !== request.target.instanceId ||
    scope.traceId !== request.trace.traceId
  ) {
    fail(`${path}.policy.scope`, "scope_binding_mismatch", "must bind the exact context, target, and trace scope.");
  }
  if (!request.target.provider.supportedClassifications.includes(maximumClassification(request))) {
    fail(`${path}.target.provider.supportedClassifications`, "classification_unsupported", "does not include the effective classification.");
  }
  for (const evidence of request.policy.transformationEvidence) {
    if (evidence.outputContextPackFingerprint !== request.context.pack.fingerprint) {
      fail(
        `${path}.policy.transformationEvidence`,
        "transformation_output_mismatch",
        "must bind the exact output context pack."
      );
    }
  }
  if (
    !request.target.provider.capabilities.structuredOutput ||
    !request.target.model.supportsStructuredOutput
  ) {
    fail(`${path}.target`, "structured_output_unsupported", "must support strict structured output.");
  }
}

export function parsePromptCompilationRequest(
  value: unknown,
  path = "promptCompilationRequest"
): PromptCompilationRequest {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "schemaVersion",
      "requestId",
      "context",
      "taskRequirements",
      "authority",
      "target",
      "policy",
      "trace",
      "authorizationAt",
      "deadline",
      "extensions"
    ],
    path
  );
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, PROMPT_COMPILER_SCHEMA_VERSION);
  const extensions = [...parseProviderExtensions(record["extensions"], `${path}.extensions`)].sort(
    (a, b) => compareText(a.namespace, b.namespace) || compareText(a.key, b.key)
  );
  const request = Object.freeze({
    schemaVersion: PROMPT_COMPILER_SCHEMA_VERSION,
    requestId: id(record["requestId"], `${path}.requestId`),
    context: parseContextBinding(record["context"], `${path}.context`),
    taskRequirements: parseTaskRequirements(record["taskRequirements"], `${path}.taskRequirements`),
    authority: parsePromptAuthorityEnvelope(record["authority"], `${path}.authority`),
    target: parsePromptTarget(record["target"], `${path}.target`),
    policy: parsePolicyInput(record["policy"], `${path}.policy`),
    trace: parseExecutionTraceMetadata(record["trace"], `${path}.trace`),
    authorizationAt: ensureTimestamp(record["authorizationAt"], `${path}.authorizationAt`),
    deadline: ensureNullable(record["deadline"], (raw) => parseDeadline(raw, `${path}.deadline`)),
    extensions: Object.freeze(extensions)
  });
  validateRequestRelationships(request, path);
  return request;
}

export function promptCompilationRequestFingerprint(request: PromptCompilationRequest): string {
  return hash(parsePromptCompilationRequest(request), "promptCompilationRequest");
}

export function contextEvidenceFingerprint(pack: ContextPack): string {
  return hash(
    pack.items.map((item) => ({ identity: item.identity, digest: item.digest })),
    "contextEvidence"
  );
}

export function contextItemReferences(pack: ContextPack): readonly {
  readonly identity: string;
  readonly digest: string;
  readonly classification: DataClassification;
  readonly disclosure: string;
}[] {
  return Object.freeze(
    pack.items.map((item) =>
      Object.freeze({
        identity: item.identity,
        digest: item.digest,
        classification: item.classification,
        disclosure: item.disclosure
      })
    )
  );
}
