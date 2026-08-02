import { createHash } from "node:crypto";
import {
  DATA_CLASSIFICATIONS,
  REDACTION_KINDS,
  TASK_RISKS,
  evaluateDisclosure,
  findUnmetRequirements,
  parseDataHandlingPolicy,
  parseModelCapabilities,
  toCanonicalJson,
  validation,
  type DataClassification,
  type DataHandlingPolicy,
  type ModelCapabilities,
  type RedactionKind,
  type TaskRisk,
} from "@ai-dev-os/domain";
import {
  parseExecutionTraceMetadata,
  parseProviderDescriptor,
  type ExecutionTraceMetadata,
  type ProviderDescriptor,
} from "@ai-dev-os/providers";

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
  fail,
} = validation;

export const POLICY_SCHEMA_VERSION = 1 as const;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RULE_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

export const POLICY_ACTIONS = Object.freeze([
  "provider-disclosure", "model-eligibility", "cloud-execution", "local-execution",
  "artifact-persistence", "input-logging", "output-logging", "workspace-read",
  "workspace-write", "command-execution", "network-access", "tool-invocation",
  "secret-access", "approval", "retention", "export", "deletion", "package-install", "git-write",
] as const);
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

export const POLICY_OUTCOMES = Object.freeze(["allowed", "denied", "conditional"] as const);
export type PolicyOutcome = (typeof POLICY_OUTCOMES)[number];
export const POLICY_AUTHORITIES = Object.freeze(["organization", "project", "user"] as const);
export type PolicyAuthority = (typeof POLICY_AUTHORITIES)[number];
export const POLICY_RULE_EFFECTS = Object.freeze(["allow", "deny", "conditional"] as const);
export type PolicyRuleEffect = (typeof POLICY_RULE_EFFECTS)[number];
export const POLICY_CAPABILITIES = Object.freeze([
  "streaming", "structured-output", "tool-calling", "image-input", "repository-editing",
  "command-execution", "network-access", "resumability", "data-retention", "model-training",
] as const);
export type PolicyCapability = (typeof POLICY_CAPABILITIES)[number];
export const APPROVAL_RESULTS = Object.freeze(["approved", "denied"] as const);
export type ApprovalResult = (typeof APPROVAL_RESULTS)[number];
export const APPROVAL_USAGES = Object.freeze(["one-shot", "reusable"] as const);
export type ApprovalUsage = (typeof APPROVAL_USAGES)[number];
export const APPROVER_CLASSES = Object.freeze(["user", "project-owner", "organization-admin"] as const);
export type ApproverClass = (typeof APPROVER_CLASSES)[number];
export const REQUESTER_KINDS = Object.freeze(["user", "system", "model"] as const);
export type RequesterKind = (typeof REQUESTER_KINDS)[number];

export class PolicyError extends Error {
  readonly code: "INVALID_POLICY" | "INVALID_REQUEST";
  readonly details: Readonly<Record<string, string | number | boolean | null | readonly string[]>>;
  constructor(code: PolicyError["code"], message: string, details: PolicyError["details"] = {}) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
  toJSON(): object {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

export interface ApprovalScope {
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly providerInstanceId: string | null;
  readonly workspaceId: string | null;
  readonly operationId: string | null;
  readonly traceId: string | null;
}

function nullableId(value: unknown, path: string): string | null {
  return ensureNullable(value, (raw) => ensureString(raw, path, { maxLength: 128, pattern: ID_PATTERN, patternName: "identifier" }));
}

export function parseApprovalScope(value: unknown, path = "approvalScope"): ApprovalScope {
  const record = ensureRecord(value, path);
  const keys = ["projectId", "taskId", "providerInstanceId", "workspaceId", "operationId", "traceId"] as const;
  ensureExactKeys(record, keys, path);
  const parsed = Object.freeze({
    projectId: nullableId(record["projectId"], `${path}.projectId`),
    taskId: nullableId(record["taskId"], `${path}.taskId`),
    providerInstanceId: nullableId(record["providerInstanceId"], `${path}.providerInstanceId`),
    workspaceId: nullableId(record["workspaceId"], `${path}.workspaceId`),
    operationId: nullableId(record["operationId"], `${path}.operationId`),
    traceId: nullableId(record["traceId"], `${path}.traceId`),
  });
  if (Object.values(parsed).every((entry) => entry === null)) {
    fail(path, "empty_scope", "must bind at least one scope identifier.");
  }
  return parsed;
}

export interface ApprovalEvidence {
  readonly approvalRequestId: string;
  readonly action: PolicyAction;
  readonly risk: TaskRisk;
  readonly scope: ApprovalScope;
  readonly subjectDigest: string;
  readonly usage: ApprovalUsage;
  readonly approverClass: ApproverClass;
  readonly approverIdentityRef: string;
  readonly result: ApprovalResult;
  readonly decidedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly consumedAt: string | null;
  readonly evidenceRef: string;
}

export function parseApprovalEvidence(value: unknown, path = "approvalEvidence"): ApprovalEvidence {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["approvalRequestId", "action", "risk", "scope", "subjectDigest", "usage", "approverClass", "approverIdentityRef", "result", "decidedAt", "expiresAt", "revokedAt", "consumedAt", "evidenceRef"], path);
  const decidedAt = ensureTimestamp(record["decidedAt"], `${path}.decidedAt`);
  const expiresAt = ensureTimestamp(record["expiresAt"], `${path}.expiresAt`);
  if (expiresAt <= decidedAt) fail(`${path}.expiresAt`, "bad_expiration", "must be after decidedAt.");
  return Object.freeze({
    approvalRequestId: ensureString(record["approvalRequestId"], `${path}.approvalRequestId`, { maxLength: 128, pattern: ID_PATTERN, patternName: "approval request id" }),
    action: ensureEnum(record["action"], `${path}.action`, POLICY_ACTIONS),
    risk: ensureEnum(record["risk"], `${path}.risk`, TASK_RISKS),
    scope: parseApprovalScope(record["scope"], `${path}.scope`),
    subjectDigest: ensureString(record["subjectDigest"], `${path}.subjectDigest`, { maxLength: 64, pattern: /^[a-f0-9]{64}$/, patternName: "normalized subject digest" }),
    usage: ensureEnum(record["usage"], `${path}.usage`, APPROVAL_USAGES),
    approverClass: ensureEnum(record["approverClass"], `${path}.approverClass`, APPROVER_CLASSES),
    approverIdentityRef: ensureString(record["approverIdentityRef"], `${path}.approverIdentityRef`, { maxLength: 128, pattern: ID_PATTERN, patternName: "identity reference" }),
    result: ensureEnum(record["result"], `${path}.result`, APPROVAL_RESULTS),
    decidedAt,
    expiresAt,
    revokedAt: ensureNullable(record["revokedAt"], (raw) => ensureTimestamp(raw, `${path}.revokedAt`)),
    consumedAt: ensureNullable(record["consumedAt"], (raw) => ensureTimestamp(raw, `${path}.consumedAt`)),
    evidenceRef: ensureString(record["evidenceRef"], `${path}.evidenceRef`, { maxLength: 128, pattern: ID_PATTERN, patternName: "evidence reference" }),
  });
}

interface ApprovalTemplate {
  readonly approverClass: ApproverClass;
  readonly usage: ApprovalUsage;
  readonly ttlMs: number;
}

export interface PolicyRule {
  readonly schemaVersion: typeof POLICY_SCHEMA_VERSION;
  readonly id: string;
  readonly authority: PolicyAuthority;
  readonly effect: PolicyRuleEffect;
  readonly actions: readonly PolicyAction[];
  readonly classifications: readonly DataClassification[];
  readonly risks: readonly TaskRisk[];
  readonly requiredTransformations: readonly RedactionKind[];
  readonly approval: ApprovalTemplate | null;
  readonly requiredLocality: "local" | "any";
  readonly forbidInputLogging: boolean;
  readonly forbidOutputLogging: boolean;
  readonly forbidArtifactPersistence: boolean;
  readonly forbidRetention: boolean;
  readonly maxRetentionDays: number | null;
  readonly forbiddenCapabilities: readonly PolicyCapability[];
}

function enumArray<T extends string>(value: unknown, path: string, allowed: readonly T[], max: number): readonly T[] {
  return ensureEnumArray(value, path, allowed, max);
}

export function parsePolicyRule(value: unknown, path = "policyRule"): PolicyRule {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["schemaVersion", "id", "authority", "effect", "actions", "classifications", "risks", "requiredTransformations", "approval", "requiredLocality", "forbidInputLogging", "forbidOutputLogging", "forbidArtifactPersistence", "forbidRetention", "maxRetentionDays", "forbiddenCapabilities"], path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, POLICY_SCHEMA_VERSION);
  const approval = ensureNullable(record["approval"], (raw) => {
    const item = ensureRecord(raw, `${path}.approval`);
    ensureExactKeys(item, ["approverClass", "usage", "ttlMs"], `${path}.approval`);
    return Object.freeze({
      approverClass: ensureEnum(item["approverClass"], `${path}.approval.approverClass`, APPROVER_CLASSES),
      usage: ensureEnum(item["usage"], `${path}.approval.usage`, APPROVAL_USAGES),
      ttlMs: ensureSafeInteger(item["ttlMs"], `${path}.approval.ttlMs`, 1, 86_400_000),
    });
  });
  return Object.freeze({
    schemaVersion: POLICY_SCHEMA_VERSION,
    id: ensureString(record["id"], `${path}.id`, { maxLength: 64, pattern: RULE_ID_PATTERN, patternName: "rule id" }),
    authority: ensureEnum(record["authority"], `${path}.authority`, POLICY_AUTHORITIES),
    effect: ensureEnum(record["effect"], `${path}.effect`, POLICY_RULE_EFFECTS),
    actions: enumArray(record["actions"], `${path}.actions`, POLICY_ACTIONS, POLICY_ACTIONS.length),
    classifications: enumArray(record["classifications"], `${path}.classifications`, DATA_CLASSIFICATIONS, DATA_CLASSIFICATIONS.length),
    risks: enumArray(record["risks"], `${path}.risks`, TASK_RISKS, TASK_RISKS.length),
    requiredTransformations: enumArray(record["requiredTransformations"], `${path}.requiredTransformations`, REDACTION_KINDS, REDACTION_KINDS.length),
    approval,
    requiredLocality: ensureEnum(record["requiredLocality"], `${path}.requiredLocality`, ["local", "any"] as const),
    forbidInputLogging: ensureBoolean(record["forbidInputLogging"], `${path}.forbidInputLogging`),
    forbidOutputLogging: ensureBoolean(record["forbidOutputLogging"], `${path}.forbidOutputLogging`),
    forbidArtifactPersistence: ensureBoolean(record["forbidArtifactPersistence"], `${path}.forbidArtifactPersistence`),
    forbidRetention: ensureBoolean(record["forbidRetention"], `${path}.forbidRetention`),
    maxRetentionDays: ensureNullable(record["maxRetentionDays"], (raw) => ensureSafeInteger(raw, `${path}.maxRetentionDays`, 0, 36_500)),
    forbiddenCapabilities: enumArray(record["forbiddenCapabilities"], `${path}.forbiddenCapabilities`, POLICY_CAPABILITIES, POLICY_CAPABILITIES.length),
  });
}

export interface PolicyRequest {
  readonly schemaVersion: typeof POLICY_SCHEMA_VERSION;
  readonly action: PolicyAction;
  readonly classification: DataClassification;
  readonly handlingPolicy: DataHandlingPolicy;
  readonly risk: TaskRisk;
  readonly locality: "local" | "cloud" | "unspecified";
  readonly provider: ProviderDescriptor | null;
  readonly model: ModelCapabilities | null;
  readonly scope: ApprovalScope;
  readonly subjectDigest: string | null;
  readonly requestedCapabilities: readonly PolicyCapability[];
  readonly transformationsApplied: readonly RedactionKind[];
  readonly approvalEvidence: readonly ApprovalEvidence[];
  readonly retentionDays: number | null;
  readonly trace: ExecutionTraceMetadata;
  readonly requesterKind: RequesterKind;
}

export function parsePolicyRequest(value: unknown, path = "policyRequest"): PolicyRequest {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["schemaVersion", "action", "classification", "handlingPolicy", "risk", "locality", "provider", "model", "scope", "subjectDigest", "requestedCapabilities", "transformationsApplied", "approvalEvidence", "retentionDays", "trace", "requesterKind"], path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, POLICY_SCHEMA_VERSION);
  const evidence = ensureArray(record["approvalEvidence"], `${path}.approvalEvidence`, 32)
    .map((entry, index) => parseApprovalEvidence(entry, `${path}.approvalEvidence[${index}]`))
    .sort((a, b) => a.approvalRequestId.localeCompare(b.approvalRequestId) || a.evidenceRef.localeCompare(b.evidenceRef));
  const request = Object.freeze({
    schemaVersion: POLICY_SCHEMA_VERSION,
    action: ensureEnum(record["action"], `${path}.action`, POLICY_ACTIONS),
    classification: ensureEnum(record["classification"], `${path}.classification`, DATA_CLASSIFICATIONS),
    handlingPolicy: parseDataHandlingPolicy(record["handlingPolicy"], `${path}.handlingPolicy`),
    risk: ensureEnum(record["risk"], `${path}.risk`, TASK_RISKS),
    locality: ensureEnum(record["locality"], `${path}.locality`, ["local", "cloud", "unspecified"] as const),
    provider: ensureNullable(record["provider"], (raw) => parseProviderDescriptor(raw, `${path}.provider`)),
    model: ensureNullable(record["model"], (raw) => parseModelCapabilities(raw, `${path}.model`)),
    scope: parseApprovalScope(record["scope"], `${path}.scope`),
    subjectDigest: ensureNullable(record["subjectDigest"], (raw) => ensureString(raw, `${path}.subjectDigest`, { maxLength: 64, pattern: /^[a-f0-9]{64}$/, patternName: "normalized subject digest" })),
    requestedCapabilities: enumArray(record["requestedCapabilities"], `${path}.requestedCapabilities`, POLICY_CAPABILITIES, POLICY_CAPABILITIES.length),
    transformationsApplied: enumArray(record["transformationsApplied"], `${path}.transformationsApplied`, REDACTION_KINDS, REDACTION_KINDS.length),
    approvalEvidence: Object.freeze(evidence),
    retentionDays: ensureNullable(record["retentionDays"], (raw) => ensureSafeInteger(raw, `${path}.retentionDays`, 0, 36_500)),
    trace: parseExecutionTraceMetadata(record["trace"], `${path}.trace`),
    requesterKind: ensureEnum(record["requesterKind"], `${path}.requesterKind`, REQUESTER_KINDS),
  });
  if (request.handlingPolicy.classification !== request.classification) {
    fail(`${path}.classification`, "classification_mismatch", "must match handlingPolicy.classification.");
  }
  if (request.scope.traceId !== null && request.scope.traceId !== request.trace.traceId) fail(`${path}.scope.traceId`, "trace_scope_mismatch", "must match trace.traceId.");
  if (request.scope.taskId !== null && request.trace.taskId !== null && request.scope.taskId !== request.trace.taskId) fail(`${path}.scope.taskId`, "task_scope_mismatch", "must match trace.taskId when both are present.");
  if (request.provider !== null && request.scope.providerInstanceId !== null && request.scope.providerInstanceId !== request.provider.instanceId) fail(`${path}.scope.providerInstanceId`, "provider_scope_mismatch", "must match provider.instanceId.");
  if (request.provider !== null && request.model !== null && (request.provider.providerId !== request.model.providerId || request.provider.locality !== request.model.locality)) fail(`${path}.model`, "provider_model_mismatch", "must belong to the selected provider and locality.");
  return request;
}

export interface ApprovalRequirement {
  readonly approvalRequestId: string;
  readonly action: PolicyAction;
  readonly risk: TaskRisk;
  readonly scope: ApprovalScope;
  readonly subjectDigest: string;
  readonly expiresAt: string;
  readonly usage: ApprovalUsage;
  readonly approverClass: ApproverClass;
  readonly traceId: string;
}
export interface PolicyReason { readonly code: string; readonly message: string }
export interface PolicyDecision {
  readonly outcome: PolicyOutcome;
  readonly code: string;
  readonly reasons: readonly PolicyReason[];
  readonly matchedRuleIds: readonly string[];
  readonly requiredTransformations: readonly RedactionKind[];
  readonly requiredApprovals: readonly ApprovalRequirement[];
  readonly requiredLocality: "local" | "any";
  readonly loggingRestrictions: { readonly inputAllowed: boolean; readonly outputAllowed: boolean };
  readonly retentionRestrictions: { readonly allowed: boolean; readonly maxDays: number | null };
  readonly capabilityConstraints: readonly PolicyCapability[];
  readonly approvalsToConsume: readonly string[];
  readonly audit: {
    readonly action: PolicyAction; readonly outcome: PolicyOutcome; readonly code: string;
    readonly classification: DataClassification; readonly evaluatedAt: string; readonly traceId: string;
    readonly matchedRuleIds: readonly string[];
  };
  readonly policyVersion: string;
  readonly fingerprint: string;
}
export interface PolicyClock { now(): Date }
export type PolicyObserver = (record: PolicyDecision["audit"]) => void;
export interface PolicyBroker { evaluate(request: PolicyRequest): PolicyDecision }

export function createManualPolicyClock(startIso = "2026-08-02T00:00:00.000Z"): PolicyClock & { advance(ms: number): void } {
  let time = new Date(ensureTimestamp(startIso, "startIso")).valueOf();
  return Object.freeze({
    now: (): Date => new Date(time),
    advance(ms: number): void { time += ensureSafeInteger(ms, "advanceMs", 0, 86_400_000); },
  });
}

function scopeCovers(granted: ApprovalScope, requested: ApprovalScope): boolean {
  const keys = Object.keys(granted) as Array<keyof ApprovalScope>;
  return keys.every((key) => granted[key] === null || granted[key] === requested[key]);
}

function capabilityAvailable(capability: PolicyCapability, provider: ProviderDescriptor | null): boolean {
  if (provider === null) return false;
  const map: Readonly<Record<PolicyCapability, boolean>> = {
    "streaming": provider.capabilities.streaming,
    "structured-output": provider.capabilities.structuredOutput,
    "tool-calling": provider.capabilities.toolCalling,
    "image-input": provider.capabilities.imageInput,
    "repository-editing": provider.capabilities.repositoryEditing,
    "command-execution": provider.capabilities.commandExecution,
    "network-access": provider.capabilities.networkAccess,
    "resumability": provider.capabilities.resumability,
    "data-retention": provider.retainsData,
    "model-training": provider.trainsOnInputs,
  };
  return map[capability];
}

export function createDeterministicPolicyBroker(options: {
  readonly policyVersion: string;
  readonly rules: readonly PolicyRule[];
  readonly clock: PolicyClock;
  readonly observer?: PolicyObserver;
  readonly idSource?: (ruleId: string, request: PolicyRequest) => string;
}): PolicyBroker {
  const policyVersion = ensureString(options.policyVersion, "policyVersion", { maxLength: 64, pattern: ID_PATTERN, patternName: "policy version" });
  const authorityRank: Readonly<Record<PolicyAuthority, number>> = { organization: 0, project: 1, user: 2 };
  const rules = options.rules.map((rule, index) => parsePolicyRule(rule, `rules[${index}]`)).sort((a, b) => authorityRank[a.authority] - authorityRank[b.authority] || a.id.localeCompare(b.id));
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) throw new PolicyError("INVALID_POLICY", "Policy rule identifiers must be unique.");

  return Object.freeze({
    evaluate(rawRequest: PolicyRequest): PolicyDecision {
      const request = parsePolicyRequest(rawRequest);
      const now = options.clock.now().toISOString();
      const matched = rules.filter((rule) => rule.actions.includes(request.action) && (rule.classifications.length === 0 || rule.classifications.includes(request.classification)) && (rule.risks.length === 0 || rule.risks.includes(request.risk)));
      const reasons: PolicyReason[] = [];
      const transformations = new Set<RedactionKind>();
      const approvals: ApprovalRequirement[] = [];
      const approvalsToConsume: string[] = [];
      const forbiddenCapabilities = new Set<PolicyCapability>();
      let allowedByRule = false;
      let denied = false;
      let requiredLocality: "local" | "any" = "any";
      let inputAllowed = request.handlingPolicy.logRetentionAllowed;
      let outputAllowed = request.handlingPolicy.logRetentionAllowed;
      let retentionAllowed = request.handlingPolicy.logRetentionAllowed;
      let maxDays: number | null = null;

      for (const rule of matched) {
        if (rule.effect === "deny") { denied = true; reasons.push(Object.freeze({ code: "RULE_DENIED", message: "A mandatory policy rule denied the action." })); }
        if (rule.effect === "allow" || rule.effect === "conditional") allowedByRule = true;
        for (const item of rule.requiredTransformations) transformations.add(item);
        if (rule.requiredLocality === "local") requiredLocality = "local";
        inputAllowed = inputAllowed && !rule.forbidInputLogging;
        outputAllowed = outputAllowed && !rule.forbidOutputLogging;
        retentionAllowed = retentionAllowed && !rule.forbidRetention;
        if (rule.maxRetentionDays !== null) maxDays = maxDays === null ? rule.maxRetentionDays : Math.min(maxDays, rule.maxRetentionDays);
        for (const item of rule.forbiddenCapabilities) forbiddenCapabilities.add(item);
        if (rule.approval !== null) {
          if (request.subjectDigest === null) { denied = true; reasons.push(Object.freeze({ code: "APPROVAL_SUBJECT_REQUIRED", message: "Approval requires a digest of the normalized action subject." })); continue; }
          const approvalRequestId = options.idSource?.(rule.id, request) ?? `approval-${createHash("sha256").update(toCanonicalJson({ policyVersion, ruleId: rule.id, action: request.action, risk: request.risk, scope: request.scope, subjectDigest: request.subjectDigest, traceId: request.trace.traceId })).digest("hex").slice(0, 24)}`;
          approvals.push(Object.freeze({ approvalRequestId, action: request.action, risk: request.risk, scope: request.scope, subjectDigest: request.subjectDigest, expiresAt: new Date(new Date(now).valueOf() + rule.approval.ttlMs).toISOString(), usage: rule.approval.usage, approverClass: rule.approval.approverClass, traceId: request.trace.traceId }));
        }
      }

      if (!allowedByRule) { denied = true; reasons.push(Object.freeze({ code: "DEFAULT_DENY", message: "No policy rule explicitly allows this action." })); }
      if (request.provider !== null && ["provider-disclosure", "model-eligibility", "cloud-execution"].includes(request.action)) {
        const targetCaps = [request.provider.retainsData ? "data-retention" : null, request.provider.trainsOnInputs ? "model-training" : null].filter((item): item is "data-retention" | "model-training" => item !== null);
        const disclosure = evaluateDisclosure(request.handlingPolicy, { locality: request.provider.locality, retainsData: request.provider.retainsData, capabilities: targetCaps }, { evaluatedAt: now });
        if (!disclosure.allowed) { denied = true; reasons.push(...disclosure.reasons.map((reason) => Object.freeze({ code: reason.code, message: reason.message }))); }
        for (const item of disclosure.requiredTransformations) transformations.add(item);
        if (request.handlingPolicy.localExecutionRequired) requiredLocality = "local";
      }
      if (request.provider !== null && !request.provider.supportedClassifications.includes(request.classification)) { denied = true; reasons.push(Object.freeze({ code: "PROVIDER_CLASSIFICATION_UNSUPPORTED", message: "The provider does not support this data classification." })); }
      if ((request.action === "local-execution" && request.locality !== "local") || (request.action === "cloud-execution" && request.locality !== "cloud")) { denied = true; reasons.push(Object.freeze({ code: "LOCALITY_MISMATCH", message: "The execution action does not match the requested locality." })); }
      if (request.model !== null) {
        const unmet = findUnmetRequirements(request.model, { minContextWindowTokens: null, minOutputTokens: null, requireToolUse: request.requestedCapabilities.includes("tool-calling"), requireStructuredOutput: request.requestedCapabilities.includes("structured-output"), requireVision: request.requestedCapabilities.includes("image-input"), requireLocalExecution: requiredLocality === "local", minCodingCapability: null, minReasoningCapability: null });
        if (unmet.length > 0) { denied = true; reasons.push(Object.freeze({ code: "MODEL_CAPABILITY_MISMATCH", message: "The model does not satisfy required capabilities." })); }
      }
      for (const capability of request.requestedCapabilities) {
        if (forbiddenCapabilities.has(capability) || !capabilityAvailable(capability, request.provider)) { denied = true; reasons.push(Object.freeze({ code: "CAPABILITY_FORBIDDEN", message: "A requested capability is unavailable or forbidden." })); }
      }
      if (requiredLocality === "local" && request.locality === "cloud") { denied = true; reasons.push(Object.freeze({ code: "LOCALITY_MISMATCH", message: "The action requires local execution." })); }
      if (request.action === "artifact-persistence" && (!request.handlingPolicy.artifactPersistenceAllowed || matched.some((rule) => rule.forbidArtifactPersistence))) { denied = true; reasons.push(Object.freeze({ code: "ARTIFACT_PERSISTENCE_FORBIDDEN", message: "Artifact persistence is forbidden." })); }
      if (request.action === "input-logging" && !inputAllowed) { denied = true; reasons.push(Object.freeze({ code: "INPUT_LOGGING_FORBIDDEN", message: "Input logging is forbidden." })); }
      if (request.action === "output-logging" && !outputAllowed) { denied = true; reasons.push(Object.freeze({ code: "OUTPUT_LOGGING_FORBIDDEN", message: "Output logging is forbidden." })); }
      if (request.action === "retention" && (!retentionAllowed || (maxDays !== null && request.retentionDays !== null && request.retentionDays > maxDays))) { denied = true; reasons.push(Object.freeze({ code: "RETENTION_FORBIDDEN", message: "The requested retention is forbidden." })); }

      const missingTransformations = [...transformations].sort().filter((item) => !request.transformationsApplied.includes(item));
      const missingApprovals: ApprovalRequirement[] = [];
      for (const requirement of approvals.sort((a, b) => a.approvalRequestId.localeCompare(b.approvalRequestId))) {
        const denial = request.approvalEvidence.find((item) => item.approvalRequestId === requirement.approvalRequestId && item.subjectDigest === requirement.subjectDigest && item.result === "denied" && item.revokedAt === null && item.expiresAt > now);
        if (denial !== undefined) { denied = true; reasons.push(Object.freeze({ code: "APPROVAL_DENIED", message: "Required approval evidence records a denial." })); continue; }
        const evidence = request.approvalEvidence.find((item) => item.approvalRequestId === requirement.approvalRequestId && item.action === requirement.action && item.risk === requirement.risk && item.subjectDigest === requirement.subjectDigest && scopeCovers(item.scope, request.scope) && item.approverClass === requirement.approverClass && item.result === "approved" && item.expiresAt > now && item.revokedAt === null && (item.usage === "reusable" || item.consumedAt === null));
        if (evidence === undefined || request.requesterKind === "model") missingApprovals.push(requirement);
        else if (evidence.usage === "one-shot") approvalsToConsume.push(evidence.approvalRequestId);
      }
      const conditional = !denied && (missingTransformations.length > 0 || missingApprovals.length > 0 || (requiredLocality === "local" && request.locality === "unspecified"));
      const outcome: PolicyOutcome = denied ? "denied" : conditional ? "conditional" : "allowed";
      const code = denied ? "POLICY_DENIED" : conditional ? "POLICY_CONDITIONS_REQUIRED" : "POLICY_ALLOWED";
      if (conditional) reasons.push(Object.freeze({ code: "CONDITIONS_REQUIRED", message: "Transformations, locality, or structured approval evidence are still required." }));
      const matchedRuleIds = Object.freeze(matched.map((rule) => rule.id));
      const fingerprintInput = { policyVersion, evaluatedAt: now, action: request.action, classification: request.classification, handlingPolicy: request.handlingPolicy, risk: request.risk, locality: request.locality, provider: request.provider, model: request.model, scope: request.scope, subjectDigest: request.subjectDigest, requestedCapabilities: request.requestedCapabilities, transformationsApplied: request.transformationsApplied, approvals: request.approvalEvidence.map((item) => ({ approvalRequestId: item.approvalRequestId, action: item.action, risk: item.risk, scope: item.scope, subjectDigest: item.subjectDigest, usage: item.usage, approverClass: item.approverClass, result: item.result, decidedAt: item.decidedAt, expiresAt: item.expiresAt, revokedAt: item.revokedAt, consumedAt: item.consumedAt, evidenceRef: item.evidenceRef })), retentionDays: request.retentionDays, requesterKind: request.requesterKind, matchedRules: matched };
      const fingerprint = createHash("sha256").update(toCanonicalJson(fingerprintInput)).digest("hex");
      const audit = Object.freeze({ action: request.action, outcome, code, classification: request.classification, evaluatedAt: now, traceId: request.trace.traceId, matchedRuleIds });
      const decision: PolicyDecision = Object.freeze({ outcome, code, reasons: Object.freeze(reasons), matchedRuleIds, requiredTransformations: Object.freeze(missingTransformations), requiredApprovals: Object.freeze(missingApprovals), requiredLocality, loggingRestrictions: Object.freeze({ inputAllowed, outputAllowed }), retentionRestrictions: Object.freeze({ allowed: retentionAllowed, maxDays }), capabilityConstraints: Object.freeze([...forbiddenCapabilities].sort()), approvalsToConsume: Object.freeze(approvalsToConsume.sort()), audit, policyVersion, fingerprint });
      try { options.observer?.(audit); }
      catch (error) { throw new PolicyError("INVALID_REQUEST", "The policy observer failed.", { causeName: error instanceof Error ? error.name : typeof error }); }
      return decision;
    },
  });
}
