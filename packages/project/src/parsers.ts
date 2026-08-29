import type {
  AgentRun, ApprovalRequest, Blocker, CanonicalProjectRecord, ClarificationQuestion,
  CommunicationThread, Constraint, Decision, Deliverable, Dependency, EvidenceRecord,
  ExternalIntegration, Handover, HandoverPolicy, MoneyBinding, Notification,
  NotificationDelivery, PlanStage, Project, ProjectBrief, ProjectHealthProjection,
  ProjectDeepLink, ProjectPlan, ProjectRecordKind, ProjectStop, ProjectSummaryProjection, ProjectTask,
  ScopePattern, Session, SpendingRequest, SubjectSummary, UsageReservation,
} from "./contracts.js";
import {
  AGENT_RUN_STATES, APPROVAL_CLASSES, APPROVAL_STATES, BACKEND_SECURITY_CLASS_VALUES,
  BLOCKER_KINDS, BLOCKER_STATES, CONSTRAINT_KINDS, DATA_CLASSIFICATION_VALUES,
  DECISION_KINDS, FAILURE_CLASSIFICATION_VALUES, HANDOVER_STATES,
  NEEDS_YOU_KINDS, NOTIFICATION_CATEGORIES, NOTIFICATION_DELIVERY_STATES, PERMISSION_MODE_VALUES,
  PLAN_STATES, PLAN_STATE_DISPLAY_WORDS, PROJECT_DEEP_LINK_ROUTES, PROJECT_POLICY_ACTION_VALUES, PROJECT_RECORD_KINDS, PROJECT_STATUSES,
  SESSION_STATES, SPENDING_STATES, TASK_STATES,
} from "./contracts.js";
import {
  deriveBlockerCopy, deriveNeedsYouTitle, deriveNotificationCopy,
  needsYouDeepLinkRoute, notificationDeepLinkRoute,
} from "./copy.js";
import { refuse } from "./errors.js";
import {
  PROJECT_LIMITS, absoluteCanonicalPath, arrayValue, booleanValue, contentId,
  currency, digest, enumValue, exact, identifier, integer, jsonObject, literal,
  mediaType, nullableIdentifier, nullableTimestamp, optionalText, parseJsonText,
  record, ruleId, schema, stringArray, textValue, timestamp, unique,
} from "./validation.js";

const TASK_KINDS = ["plan", "architecture", "implement", "refactor", "debug", "review", "test", "document", "shell", "explain", "transform"] as const;
const TASK_RISKS = ["low", "medium", "high", "critical"] as const;
const REASONING_DEMANDS = ["low", "medium", "high", "extreme"] as const;
const EDIT_SCOPES = ["none", "single-file", "multi-file", "cross-package"] as const;
const TASK_CAPABILITIES = ["reasoning", "repository-read", "code-edit", "shell", "testing", "documentation", "vision", "structured-output", "tool-use"] as const;
const TASK_PRIORITIES = ["low", "normal", "high", "critical"] as const;
const WORKLOAD_CLASSES = ["general", "fable"] as const;
const APPROVER_CLASSES = ["user", "project-owner", "organization-admin"] as const;

function revision(value: unknown, path: string): number {
  return integer(value, path, 1, Number.MAX_SAFE_INTEGER);
}

function idArray(value: unknown, path: string, prefix?: string, minimum = 0): readonly string[] {
  return unique(arrayValue(value, path, (item, itemPath) => identifier(item, itemPath, prefix), { minimum }), path);
}

function nullable<T>(value: unknown, parse: (input: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

function parseBudget(value: unknown, path: string) {
  const input = record(value, path);
  exact(input, ["maximumInputTokens", "maximumOutputTokens", "maximumCostMicros", "maximumToolCalls", "maximumTurns"], path);
  return Object.freeze({
    maximumInputTokens: integer(input["maximumInputTokens"], `${path}.maximumInputTokens`, 0, PROJECT_LIMITS.tokenCount),
    maximumOutputTokens: integer(input["maximumOutputTokens"], `${path}.maximumOutputTokens`, 0, PROJECT_LIMITS.tokenCount),
    maximumCostMicros: integer(input["maximumCostMicros"], `${path}.maximumCostMicros`),
    maximumToolCalls: integer(input["maximumToolCalls"], `${path}.maximumToolCalls`, 0, 100_000),
    maximumTurns: integer(input["maximumTurns"], `${path}.maximumTurns`, 0, 100_000),
  });
}

function parseRetry(value: unknown, path: string) {
  const input = record(value, path);
  exact(input, ["maximumAttempts", "initialBackoffMs", "maximumBackoffMs", "retryableFailures"], path);
  const initialBackoffMs = integer(input["initialBackoffMs"], `${path}.initialBackoffMs`, 0, PROJECT_LIMITS.durationMs);
  const maximumBackoffMs = integer(input["maximumBackoffMs"], `${path}.maximumBackoffMs`, 0, PROJECT_LIMITS.durationMs);
  if (initialBackoffMs > maximumBackoffMs) refuse("INVARIANT_VIOLATION", path, "The retry backoff order is invalid.");
  return Object.freeze({
    maximumAttempts: integer(input["maximumAttempts"], `${path}.maximumAttempts`, 1, 100),
    initialBackoffMs,
    maximumBackoffMs,
    retryableFailures: unique(arrayValue(input["retryableFailures"], `${path}.retryableFailures`, (item, itemPath) => enumValue(item, FAILURE_CLASSIFICATION_VALUES, itemPath), { maximum: FAILURE_CLASSIFICATION_VALUES.length }), `${path}.retryableFailures`),
  });
}

function parseTimeout(value: unknown, path: string) {
  const input = record(value, path);
  exact(input, ["dispatchMs", "attemptMs"], path);
  const dispatchMs = integer(input["dispatchMs"], `${path}.dispatchMs`, 1, PROJECT_LIMITS.durationMs);
  const attemptMs = integer(input["attemptMs"], `${path}.attemptMs`, 1, PROJECT_LIMITS.durationMs);
  if (dispatchMs > attemptMs) refuse("INVARIANT_VIOLATION", path, "The dispatch timeout exceeds the attempt timeout.");
  return Object.freeze({ dispatchMs, attemptMs });
}

function parseTaskRequirements(value: unknown, path: string) {
  const input = record(value, path);
  exact(input, ["kind", "complexity", "risk", "reasoning", "editScope", "capabilities", "dataClassification", "expectedInputTokens", "expectedOutputTokens"], path);
  const editScope = enumValue(input["editScope"], EDIT_SCOPES, `${path}.editScope`);
  const capabilities = unique(arrayValue(input["capabilities"], `${path}.capabilities`, (item, itemPath) => enumValue(item, TASK_CAPABILITIES, itemPath), { maximum: TASK_CAPABILITIES.length }), `${path}.capabilities`);
  if (editScope !== "none" && !capabilities.includes("code-edit")) {
    refuse("INVARIANT_VIOLATION", `${path}.capabilities`, "Repository edits require the code-edit capability.");
  }
  return Object.freeze({
    kind: enumValue(input["kind"], TASK_KINDS, `${path}.kind`),
    complexity: integer(input["complexity"], `${path}.complexity`, 1, 5) as 1 | 2 | 3 | 4 | 5,
    risk: enumValue(input["risk"], TASK_RISKS, `${path}.risk`),
    reasoning: enumValue(input["reasoning"], REASONING_DEMANDS, `${path}.reasoning`),
    editScope,
    capabilities,
    dataClassification: enumValue(input["dataClassification"], DATA_CLASSIFICATION_VALUES, `${path}.dataClassification`),
    expectedInputTokens: nullable(input["expectedInputTokens"], (item) => integer(item, `${path}.expectedInputTokens`, 0, PROJECT_LIMITS.tokenCount)),
    expectedOutputTokens: nullable(input["expectedOutputTokens"], (item) => integer(item, `${path}.expectedOutputTokens`, 0, PROJECT_LIMITS.tokenCount)),
  });
}

function parseWorkspace(value: unknown, path: string) {
  const input = record(value, path);
  exact(input, ["projectId", "workspaceId", "snapshotId", "baseRevision"], path);
  return Object.freeze({
    projectId: identifier(input["projectId"], `${path}.projectId`, "prj:"),
    workspaceId: identifier(input["workspaceId"], `${path}.workspaceId`),
    snapshotId: identifier(input["snapshotId"], `${path}.snapshotId`),
    baseRevision: textValue(input["baseRevision"], `${path}.baseRevision`, { maximum: 128, allowNewlines: false }),
  });
}

function parseRoute(value: unknown, path: string) {
  const input = record(value, path);
  exact(input, ["candidateId", "providerId", "modelId", "profileId", "ownership"], path);
  return Object.freeze({
    candidateId: identifier(input["candidateId"], `${path}.candidateId`),
    providerId: identifier(input["providerId"], `${path}.providerId`),
    modelId: identifier(input["modelId"], `${path}.modelId`),
    profileId: identifier(input["profileId"], `${path}.profileId`),
    ownership: enumValue(input["ownership"], ["owned", "authorized-borrowed"] as const, `${path}.ownership`),
  });
}

function parseUsage(value: unknown, path: string) {
  const input = record(value, path);
  exact(input, ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningTokens", "toolCalls", "costMicros"], path);
  return Object.freeze({
    inputTokens: integer(input["inputTokens"], `${path}.inputTokens`, 0, PROJECT_LIMITS.tokenCount),
    cachedInputTokens: integer(input["cachedInputTokens"], `${path}.cachedInputTokens`, 0, PROJECT_LIMITS.tokenCount),
    cacheWriteInputTokens: integer(input["cacheWriteInputTokens"], `${path}.cacheWriteInputTokens`, 0, PROJECT_LIMITS.tokenCount),
    outputTokens: integer(input["outputTokens"], `${path}.outputTokens`, 0, PROJECT_LIMITS.tokenCount),
    reasoningTokens: integer(input["reasoningTokens"], `${path}.reasoningTokens`, 0, PROJECT_LIMITS.tokenCount),
    toolCalls: integer(input["toolCalls"], `${path}.toolCalls`, 0, 100_000),
    costMicros: nullable(input["costMicros"], (item) => integer(item, `${path}.costMicros`)),
  });
}

function patternedText(value: unknown, path: string, pattern: RegExp, maximum: number): string {
  const parsed = textValue(value, path, { maximum, allowNewlines: false });
  if (!pattern.test(parsed)) refuse("PROJECT_VALIDATION_REFUSED", path);
  return parsed;
}

function parseGitRevision(value: unknown, path: string): string {
  return patternedText(value, path, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u, 64);
}

function parseGitBranch(value: unknown, path: string): string | null {
  if (value === null) return null;
  const parsed = patternedText(value, path, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u, 255);
  const components = parsed.split("/");
  const invalidComponent = components.some((component) => component.length === 0
    || component.startsWith(".")
    || component.endsWith(".")
    || component.endsWith(".lock"));
  if (invalidComponent || parsed.includes("..") || parsed.includes("@{")) {
    refuse("PROJECT_VALIDATION_REFUSED", path, "The branch reference is not canonical.");
  }
  return parsed;
}

function parseProjectDeepLink(value: unknown, path: string): ProjectDeepLink {
  const input = record(value, path);
  exact(input, ["route", "params"], path);
  const route = enumValue(input["route"], PROJECT_DEEP_LINK_ROUTES, `${path}.route`);
  const params = record(input["params"], `${path}.params`);
  if (route === "home" || route === "providers" || route === "emergency-stop") {
    exact(params, [], `${path}.params`);
    return Object.freeze({ route, params: Object.freeze({}) });
  }
  if (route === "project" || route === "plan" || route === "activity") {
    exact(params, ["projectId"], `${path}.params`);
    return Object.freeze({ route, params: Object.freeze({ projectId: identifier(params["projectId"], `${path}.params.projectId`, "prj:") }) });
  }
  if (route === "task") {
    exact(params, ["projectId", "taskId"], `${path}.params`);
    return Object.freeze({ route, params: Object.freeze({ projectId: identifier(params["projectId"], `${path}.params.projectId`, "prj:"), taskId: identifier(params["taskId"], `${path}.params.taskId`, "tsk:") }) });
  }
  if (route === "session") {
    exact(params, ["projectId", "sessionId"], `${path}.params`);
    return Object.freeze({ route, params: Object.freeze({ projectId: identifier(params["projectId"], `${path}.params.projectId`, "prj:"), sessionId: identifier(params["sessionId"], `${path}.params.sessionId`, "ses:") }) });
  }
  if (route === "approval") {
    exact(params, ["projectId", "approvalRequestId"], `${path}.params`);
    return Object.freeze({ route, params: Object.freeze({ projectId: identifier(params["projectId"], `${path}.params.projectId`, "prj:"), approvalRequestId: identifier(params["approvalRequestId"], `${path}.params.approvalRequestId`, "apr:") }) });
  }
  exact(params, ["projectId", "spendingRequestId"], `${path}.params`);
  return Object.freeze({ route, params: Object.freeze({ projectId: identifier(params["projectId"], `${path}.params.projectId`, "prj:"), spendingRequestId: identifier(params["spendingRequestId"], `${path}.params.spendingRequestId`, "spd:") }) });
}

function deepLinkProjectId(deepLink: ProjectDeepLink): string | null {
  return "projectId" in deepLink.params ? deepLink.params.projectId : null;
}

/**
 * Pure structural projection of the existing @ai-dev-os/secrets SecretRef.
 * Importing its runtime parser would pull Node crypto and policy composition
 * into this package, so C6 keeps a compile-checked type-only dependency and an
 * exact, material-free validator at this boundary.
 */
function parseCredentialRef(value: unknown, path: string): NonNullable<ExternalIntegration["credentialRef"]> {
  const input = record(value, path);
  const type = enumValue(input["type"], ["named", "environment", "keychain", "encrypted-file", "external-vault"] as const, `${path}.type`);
  const shared = {
    schemaVersion: literal(input["schemaVersion"], 1, `${path}.schemaVersion`),
    namespace: patternedText(input["namespace"], `${path}.namespace`, /^[a-z][a-z0-9-]{0,31}$/u, 32),
    version: nullableIdentifier(input["version"], `${path}.version`),
    expectedKind: enumValue(input["expectedKind"], ["text", "bytes"] as const, `${path}.expectedKind`),
    providerInstanceId: nullableIdentifier(input["providerInstanceId"], `${path}.providerInstanceId`),
  };
  const namePattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
  if (type === "named") {
    exact(input, ["schemaVersion", "type", "namespace", "version", "expectedKind", "providerInstanceId", "name"], path);
    return Object.freeze({ ...shared, type, name: patternedText(input["name"], `${path}.name`, namePattern, 128) });
  }
  if (type === "environment") {
    exact(input, ["schemaVersion", "type", "namespace", "version", "expectedKind", "providerInstanceId", "variableName"], path);
    if (shared.expectedKind !== "text") refuse("INVARIANT_VIOLATION", `${path}.expectedKind`, "Environment references support text secrets only.");
    return Object.freeze({ ...shared, type, variableName: patternedText(input["variableName"], `${path}.variableName`, /^[A-Z][A-Z0-9_]{0,127}$/u, 128) });
  }
  if (type === "keychain") {
    exact(input, ["schemaVersion", "type", "namespace", "version", "expectedKind", "providerInstanceId", "service", "account"], path);
    return Object.freeze({ ...shared, type, service: patternedText(input["service"], `${path}.service`, namePattern, 128), account: patternedText(input["account"], `${path}.account`, namePattern, 128) });
  }
  if (type === "encrypted-file") {
    exact(input, ["schemaVersion", "type", "namespace", "version", "expectedKind", "providerInstanceId", "containerId", "entryName"], path);
    return Object.freeze({ ...shared, type, containerId: identifier(input["containerId"], `${path}.containerId`), entryName: patternedText(input["entryName"], `${path}.entryName`, namePattern, 128) });
  }
  exact(input, ["schemaVersion", "type", "namespace", "version", "expectedKind", "providerInstanceId", "vaultNamespace", "pathSegments", "entryName"], path);
  return Object.freeze({
    ...shared,
    type,
    vaultNamespace: patternedText(input["vaultNamespace"], `${path}.vaultNamespace`, /^[a-z][a-z0-9-]{0,31}$/u, 64),
    pathSegments: arrayValue(input["pathSegments"], `${path}.pathSegments`, (item, itemPath) => patternedText(item, itemPath, namePattern, 64), { minimum: 1, maximum: 16 }),
    entryName: patternedText(input["entryName"], `${path}.entryName`, namePattern, 128),
  });
}

export function parseConstraint(value: unknown, _callerPath?: string): Constraint {
  const path = "constraint";
  const input = record(value, path);
  exact(input, ["constraintId", "kind", "statement", "enforcement", "machineForm", "origin", "authority"], path);
  const enforcement = enumValue(input["enforcement"], ["hard", "advisory"] as const, `${path}.enforcement`);
  const origin = enumValue(input["origin"], ["operator", "repository", "model"] as const, `${path}.origin`);
  const authority = enumValue(input["authority"], ["none", "operator"] as const, `${path}.authority`);
  const machineForm = nullable(input["machineForm"], (item) => jsonObject(item, `${path}.machineForm`));
  if ((enforcement === "hard") !== (machineForm !== null)) {
    refuse("INVARIANT_VIOLATION", path, "Hard enforcement requires a deterministic machine form, and advisory constraints cannot claim one.");
  }
  if (origin === "model" && (enforcement !== "advisory" || authority !== "none")) {
    refuse("AUTHORITY_VIOLATION", path, "Model-origin constraints are advisory and carry no authority.");
  }
  if (authority === "operator" && origin !== "operator") {
    refuse("AUTHORITY_VIOLATION", path, "Only an operator-origin constraint can name operator authority.");
  }
  return Object.freeze({
    constraintId: identifier(input["constraintId"], `${path}.constraintId`),
    kind: enumValue(input["kind"], CONSTRAINT_KINDS, `${path}.kind`),
    statement: textValue(input["statement"], `${path}.statement`), enforcement, machineForm, origin, authority,
  });
}

function parseQuestion(value: unknown, path: string): ClarificationQuestion {
  const input = record(value, path);
  exact(input, ["questionId", "theme", "question", "whyItMatters", "options", "proposedDefault", "consequenceIfDefaulted", "blocking"], path);
  return Object.freeze({
    questionId: identifier(input["questionId"], `${path}.questionId`),
    theme: enumValue(input["theme"], ["scope", "quality-bar", "constraints", "environment", "delivery", "risk"] as const, `${path}.theme`),
    question: textValue(input["question"], `${path}.question`),
    whyItMatters: textValue(input["whyItMatters"], `${path}.whyItMatters`),
    options: nullable(input["options"], (item) => stringArray(item, `${path}.options`, { minimum: 2, maximum: 16 })),
    proposedDefault: textValue(input["proposedDefault"], `${path}.proposedDefault`),
    consequenceIfDefaulted: textValue(input["consequenceIfDefaulted"], `${path}.consequenceIfDefaulted`),
    blocking: booleanValue(input["blocking"], `${path}.blocking`),
  });
}

export function parseProject(value: unknown, _callerPath?: string): Project {
  const path = "project";
  const input = record(value, path);
  exact(input, ["schemaVersion", "projectId", "revision", "displayName", "repositoryRoots", "defaultBranch", "dataClassification", "permissionMode", "budgetAccountId", "effectiveConfigDigest", "status", "createdAt", "updatedAt"], path);
  const createdAt = timestamp(input["createdAt"], `${path}.createdAt`);
  const updatedAt = timestamp(input["updatedAt"], `${path}.updatedAt`);
  if (updatedAt < createdAt) refuse("INVARIANT_VIOLATION", path, "A project cannot be updated before it is created.");
  const repositoryRoots = unique(arrayValue(input["repositoryRoots"], `${path}.repositoryRoots`, absoluteCanonicalPath, { minimum: 1, maximum: 64 }), `${path}.repositoryRoots`);
  return Object.freeze({
    schemaVersion: schema(input["schemaVersion"], `${path}.schemaVersion`),
    projectId: identifier(input["projectId"], `${path}.projectId`, "prj:"),
    revision: revision(input["revision"], `${path}.revision`),
    displayName: textValue(input["displayName"], `${path}.displayName`, { maximum: 200 }),
    repositoryRoots,
    defaultBranch: optionalText(input["defaultBranch"], `${path}.defaultBranch`, 255),
    dataClassification: enumValue(input["dataClassification"], DATA_CLASSIFICATION_VALUES, `${path}.dataClassification`),
    permissionMode: enumValue(input["permissionMode"], PERMISSION_MODE_VALUES, `${path}.permissionMode`),
    budgetAccountId: identifier(input["budgetAccountId"], `${path}.budgetAccountId`),
    effectiveConfigDigest: digest(input["effectiveConfigDigest"], `${path}.effectiveConfigDigest`),
    status: enumValue(input["status"], PROJECT_STATUSES, `${path}.status`), createdAt, updatedAt,
  });
}

export function parseProjectBrief(value: unknown, _callerPath?: string): ProjectBrief {
  const path = "projectBrief";
  const input = record(value, path);
  exact(input, ["schemaVersion", "briefId", "projectId", "revision", "supersedes", "origin", "objective", "outcomes", "nonGoals", "audiences", "constraints", "assumptions", "openQuestions", "sourceThreadId", "createdAt"], path);
  const assumptions = arrayValue(input["assumptions"], `${path}.assumptions`, (item, itemPath) => {
    const assumption = record(item, itemPath);
    exact(assumption, ["text", "source", "confirmed"], itemPath);
    return Object.freeze({ text: textValue(assumption["text"], `${itemPath}.text`), source: enumValue(assumption["source"], ["operator", "repository", "model"] as const, `${itemPath}.source`), confirmed: booleanValue(assumption["confirmed"], `${itemPath}.confirmed`) });
  });
  const questions = arrayValue(input["openQuestions"], `${path}.openQuestions`, parseQuestion);
  unique(questions.map((item) => item.questionId), `${path}.openQuestions`);
  const constraints = arrayValue(input["constraints"], `${path}.constraints`, parseConstraint);
  unique(constraints.map((item) => item.constraintId), `${path}.constraints`);
  const briefId = identifier(input["briefId"], `${path}.briefId`, "brf:");
  const supersedes = nullableIdentifier(input["supersedes"], `${path}.supersedes`, "brf:");
  if (supersedes === briefId) refuse("INVARIANT_VIOLATION", path, "An immutable brief cannot supersede itself.");
  return Object.freeze({
    schemaVersion: schema(input["schemaVersion"], `${path}.schemaVersion`),
    briefId,
    projectId: identifier(input["projectId"], `${path}.projectId`, "prj:"),
    revision: literal(input["revision"], 1, `${path}.revision`),
    supersedes,
    origin: literal(input["origin"], "operator", `${path}.origin`),
    objective: textValue(input["objective"], `${path}.objective`),
    outcomes: stringArray(input["outcomes"], `${path}.outcomes`, { minimum: 1 }),
    nonGoals: stringArray(input["nonGoals"], `${path}.nonGoals`),
    audiences: stringArray(input["audiences"], `${path}.audiences`, { minimum: 1 }),
    constraints, assumptions, openQuestions: questions,
    sourceThreadId: nullableIdentifier(input["sourceThreadId"], `${path}.sourceThreadId`, "thr:"),
    createdAt: timestamp(input["createdAt"], `${path}.createdAt`),
  });
}

export function parsePlanStage(value: unknown, _callerPath?: string): PlanStage {
  const path = "planStage";
  const input = record(value, path);
  exact(input, ["stageId", "ordinal", "title", "intent", "exitCriteria", "exitEvidenceKinds", "taskIds", "gate"], path);
  return Object.freeze({
    stageId: identifier(input["stageId"], `${path}.stageId`, "stg:"),
    ordinal: integer(input["ordinal"], `${path}.ordinal`, 1, 10_000),
    title: textValue(input["title"], `${path}.title`, { maximum: 512 }),
    intent: textValue(input["intent"], `${path}.intent`),
    exitCriteria: stringArray(input["exitCriteria"], `${path}.exitCriteria`, { minimum: 1 }),
    exitEvidenceKinds: stringArray(input["exitEvidenceKinds"], `${path}.exitEvidenceKinds`, { minimum: 1, itemMaximum: 128 }),
    taskIds: idArray(input["taskIds"], `${path}.taskIds`, "tsk:", 1),
    gate: enumValue(input["gate"], ["automatic", "operator-review"] as const, `${path}.gate`),
  });
}

function parseHandoverPolicy(value: unknown, path: string): HandoverPolicy {
  const input = record(value, path);
  exact(input, ["requires", "acceptFrom", "maximumAgeMs"], path);
  const requires = enumValue(input["requires"], ["none", "optional", "required"] as const, `${path}.requires`);
  const acceptFrom = idArray(input["acceptFrom"], `${path}.acceptFrom`, "tsk:");
  const maximumAgeMs = nullable(input["maximumAgeMs"], (item) => integer(item, `${path}.maximumAgeMs`, 1, PROJECT_LIMITS.durationMs));
  if (requires === "none" && (acceptFrom.length > 0 || maximumAgeMs !== null)) refuse("INVARIANT_VIOLATION", path, "A no-handover policy cannot name sources or an age.");
  if (requires !== "none" && acceptFrom.length === 0) refuse("INVARIANT_VIOLATION", path, "A handover policy must name at least one source task.");
  return Object.freeze({ requires, acceptFrom, maximumAgeMs });
}

export function parseProjectTask(value: unknown, _callerPath?: string): ProjectTask {
  const path = "task";
  const input = record(value, path);
  exact(input, ["taskId", "stageId", "title", "objective", "requirements", "requirementIds", "workspaceMode", "acceptance", "expectedOutputSchema", "idempotencyClass", "budget", "retry", "timeout", "priority", "workloadClass", "handoverPolicy", "state", "stateRevision"], path);
  const acceptance = arrayValue(input["acceptance"], `${path}.acceptance`, (item, itemPath) => {
    const criterion = record(item, itemPath);
    exact(criterion, ["criterion", "validationCommand"], itemPath);
    const validationCommand = nullable(criterion["validationCommand"], (command) => arrayValue(command, `${itemPath}.validationCommand`, (argument, argumentPath) => textValue(argument, argumentPath, { maximum: PROJECT_LIMITS.commandArgumentLength }), { minimum: 1, maximum: PROJECT_LIMITS.commandArguments }));
    return Object.freeze({ criterion: textValue(criterion["criterion"], `${itemPath}.criterion`), validationCommand });
  }, { minimum: 1 });
  const requirements = parseTaskRequirements(input["requirements"], `${path}.requirements`);
  const workspaceMode = enumValue(input["workspaceMode"], ["none", "snapshot", "worktree"] as const, `${path}.workspaceMode`);
  if ((requirements.editScope !== "none" || requirements.capabilities.includes("code-edit")) && workspaceMode !== "worktree") {
    refuse("AUTHORITY_VIOLATION", `${path}.workspaceMode`, "Repository-write capability requires a managed worktree.");
  }
  return Object.freeze({
    taskId: identifier(input["taskId"], `${path}.taskId`, "tsk:"),
    stageId: identifier(input["stageId"], `${path}.stageId`, "stg:"),
    title: textValue(input["title"], `${path}.title`, { maximum: 512 }),
    objective: textValue(input["objective"], `${path}.objective`),
    requirements,
    requirementIds: idArray(input["requirementIds"], `${path}.requirementIds`),
    workspaceMode,
    acceptance,
    expectedOutputSchema: jsonObject(input["expectedOutputSchema"], `${path}.expectedOutputSchema`),
    idempotencyClass: enumValue(input["idempotencyClass"], ["pure", "replayable", "reconcilable", "approval-bound", "irreversible"] as const, `${path}.idempotencyClass`),
    budget: parseBudget(input["budget"], `${path}.budget`),
    retry: parseRetry(input["retry"], `${path}.retry`),
    timeout: parseTimeout(input["timeout"], `${path}.timeout`),
    priority: enumValue(input["priority"], TASK_PRIORITIES, `${path}.priority`),
    workloadClass: enumValue(input["workloadClass"], WORKLOAD_CLASSES, `${path}.workloadClass`),
    handoverPolicy: parseHandoverPolicy(input["handoverPolicy"], `${path}.handoverPolicy`),
    state: enumValue(input["state"], TASK_STATES, `${path}.state`),
    stateRevision: revision(input["stateRevision"], `${path}.stateRevision`),
  });
}

/** Canonical dossier name for the strict project-task parser. */
export const parseTask = parseProjectTask;

export function parseDependency(value: unknown, _callerPath?: string): Dependency {
  const path = "dependency";
  const input = record(value, path);
  exact(input, ["fromTaskId", "toTaskId", "kind", "artifactKind"], path);
  const fromTaskId = identifier(input["fromTaskId"], `${path}.fromTaskId`, "tsk:");
  const toTaskId = identifier(input["toTaskId"], `${path}.toTaskId`, "tsk:");
  const kind = enumValue(input["kind"], ["finish-to-start", "artifact", "advisory"] as const, `${path}.kind`);
  const artifactKind = optionalText(input["artifactKind"], `${path}.artifactKind`, 128);
  if (fromTaskId === toTaskId || (kind === "artifact") !== (artifactKind !== null)) {
    refuse("INVARIANT_VIOLATION", path, "The dependency endpoints or artifact binding are inconsistent.");
  }
  return Object.freeze({ fromTaskId, toTaskId, kind, artifactKind });
}

function assertPlanDag(tasks: readonly ProjectTask[], dependencies: readonly Dependency[], path: string): void {
  const graph = new Map(tasks.map((task) => [task.taskId, [] as string[]]));
  for (const dependency of dependencies) graph.get(dependency.fromTaskId)?.push(dependency.toTaskId);
  const active = new Set<string>();
  const done = new Set<string>();
  const visit = (taskId: string): void => {
    if (active.has(taskId)) refuse("INVARIANT_VIOLATION", path, "The plan dependency graph is cyclic.");
    if (done.has(taskId)) return;
    active.add(taskId);
    for (const next of graph.get(taskId) ?? []) visit(next);
    active.delete(taskId);
    done.add(taskId);
  };
  for (const task of tasks) visit(task.taskId);
}

export function parseProjectPlan(value: unknown, _callerPath?: string): ProjectPlan {
  const path = "projectPlan";
  const input = record(value, path);
  exact(input, ["schemaVersion", "planId", "projectId", "briefId", "briefRevision", "revision", "supersedes", "state", "stages", "tasks", "dependencies", "specificationRef", "coverageRef", "planDigest", "sealedAt", "sealedByApprovalId", "budgetCeiling", "origin", "authority", "createdAt", "updatedAt"], path);
  const planId = identifier(input["planId"], `${path}.planId`, "pln:");
  const planRevision = revision(input["revision"], `${path}.revision`);
  const supersedes = nullableIdentifier(input["supersedes"], `${path}.supersedes`, "pln:");
  if ((planRevision === 1) !== (supersedes === null) || supersedes === planId) refuse("INVARIANT_VIOLATION", path, "Plan revision and supersession identity are inconsistent.");
  const stages = arrayValue(input["stages"], `${path}.stages`, parsePlanStage, { minimum: 1 });
  const tasks = arrayValue(input["tasks"], `${path}.tasks`, parseProjectTask, { minimum: 1 });
  const dependencies = arrayValue(input["dependencies"], `${path}.dependencies`, parseDependency);
  unique(stages.map((stage) => stage.stageId), `${path}.stages`);
  unique(stages.map((stage) => String(stage.ordinal)), `${path}.stages.ordinal`);
  unique(tasks.map((task) => task.taskId), `${path}.tasks`);
  unique(dependencies.map((item) => `${item.fromTaskId}|${item.toTaskId}|${item.kind}|${item.artifactKind ?? ""}`), `${path}.dependencies`);
  const stageIds = new Set(stages.map((stage) => stage.stageId));
  const taskIds = new Set(tasks.map((task) => task.taskId));
  if (tasks.some((task) => !stageIds.has(task.stageId)) || dependencies.some((item) => !taskIds.has(item.fromTaskId) || !taskIds.has(item.toTaskId))) {
    refuse("REFERENCE_INCONSISTENT", path, "The plan contains an unresolved internal reference.");
  }
  const listedTasks = stages.flatMap((stage) => stage.taskIds);
  if (new Set(listedTasks).size !== listedTasks.length || listedTasks.length !== tasks.length || tasks.some((task) => !stages.find((stage) => stage.stageId === task.stageId)?.taskIds.includes(task.taskId))) {
    refuse("REFERENCE_INCONSISTENT", path, "Stage task membership is not one-to-one with plan tasks.");
  }
  assertPlanDag(tasks, dependencies, path);
  const state = enumValue(input["state"], PLAN_STATES, `${path}.state`);
  const sealedAt = nullableTimestamp(input["sealedAt"], `${path}.sealedAt`);
  const sealedByApprovalId = nullableIdentifier(input["sealedByApprovalId"], `${path}.sealedByApprovalId`, "apr:");
  const requiresSeal = ["sealed", "executing", "expanding", "stage_gate", "halted", "completed"] as const;
  const forbidsSeal = ["drafting", "clarifying", "proposed", "awaiting_scope_approval", "rejected"] as const;
  if ((requiresSeal as readonly string[]).includes(state) && sealedAt === null || (forbidsSeal as readonly string[]).includes(state) && sealedAt !== null) refuse("INVARIANT_VIOLATION", path, "Plan sealing metadata does not match the state.");
  if (sealedByApprovalId !== null && sealedAt === null) refuse("INVARIANT_VIOLATION", path, "An unsealed plan cannot carry a sealing approval.");
  const createdAt = timestamp(input["createdAt"], `${path}.createdAt`);
  const updatedAt = timestamp(input["updatedAt"], `${path}.updatedAt`);
  if (updatedAt < createdAt || (sealedAt !== null && sealedAt < createdAt)) refuse("INVARIANT_VIOLATION", path, "Plan timestamps are inconsistent.");
  return Object.freeze({
    schemaVersion: schema(input["schemaVersion"], `${path}.schemaVersion`),
    planId,
    projectId: identifier(input["projectId"], `${path}.projectId`, "prj:"),
    briefId: identifier(input["briefId"], `${path}.briefId`, "brf:"),
    briefRevision: revision(input["briefRevision"], `${path}.briefRevision`),
    revision: planRevision,
    supersedes,
    state, stages, tasks, dependencies,
    specificationRef: nullableIdentifier(input["specificationRef"], `${path}.specificationRef`),
    coverageRef: nullableIdentifier(input["coverageRef"], `${path}.coverageRef`),
    planDigest: digest(input["planDigest"], `${path}.planDigest`), sealedAt, sealedByApprovalId,
    budgetCeiling: parseBudget(input["budgetCeiling"], `${path}.budgetCeiling`),
    origin: literal(input["origin"], "model", `${path}.origin`),
    authority: literal(input["authority"], "none", `${path}.authority`), createdAt, updatedAt,
  });
}

export function parseAgentRun(value: unknown, _callerPath?: string): AgentRun {
  const path = "agentRun";
  const input = record(value, path);
  exact(input, ["schemaVersion", "runId", "projectId", "planId", "planRevision", "taskId", "attempt", "workId", "leaseId", "fencingToken", "route", "reservationId", "dispatchId", "sessionId", "grantDigest", "consumedApprovalIds", "consumedHandoverId", "state", "usage", "startedAt", "finishedAt", "terminal"], path);
  const state = enumValue(input["state"], AGENT_RUN_STATES, `${path}.state`);
  const startedAt = nullableTimestamp(input["startedAt"], `${path}.startedAt`);
  const finishedAt = nullableTimestamp(input["finishedAt"], `${path}.finishedAt`);
  const terminal = nullable(input["terminal"], (value) => {
    const item = record(value, `${path}.terminal`);
    exact(item, ["outcome", "classification", "code", "effectPhase"], `${path}.terminal`);
    const outcome = enumValue(item["outcome"], ["completed", "failed", "cancelled"] as const, `${path}.terminal.outcome`);
    const classification = nullable(item["classification"], (entry) => enumValue(entry, FAILURE_CLASSIFICATION_VALUES, `${path}.terminal.classification`));
    if ((outcome === "failed") !== (classification !== null)) refuse("INVARIANT_VIOLATION", `${path}.terminal`, "Only a failed terminal carries a failure classification.");
    return Object.freeze({
      outcome, classification,
      code: textValue(item["code"], `${path}.terminal.code`, { maximum: 128, allowNewlines: false }),
      effectPhase: enumValue(item["effectPhase"], ["pre-dispatch", "possibly-dispatched", "response-received", "post-response"] as const, `${path}.terminal.effectPhase`),
    });
  });
  const terminalStates = ["succeeded", "failed", "cancelled"] as const;
  if ((terminalStates as readonly string[]).includes(state) !== (terminal !== null && finishedAt !== null)) {
    refuse("INVARIANT_VIOLATION", path, "Run terminal metadata does not match the attempt state.");
  }
  if (state === "succeeded" && terminal?.outcome !== "completed" || state === "failed" && terminal?.outcome !== "failed" || state === "cancelled" && terminal?.outcome !== "cancelled") {
    refuse("INVARIANT_VIOLATION", path, "Run state and terminal outcome disagree.");
  }
  if (state === "leased" && startedAt !== null) refuse("INVARIANT_VIOLATION", path, "A leased run has not started.");
  if (startedAt !== null && finishedAt !== null && finishedAt < startedAt) refuse("INVARIANT_VIOLATION", path, "Run timestamps are inconsistent.");
  return Object.freeze({
    schemaVersion: schema(input["schemaVersion"], `${path}.schemaVersion`),
    runId: identifier(input["runId"], `${path}.runId`, "run:"),
    projectId: identifier(input["projectId"], `${path}.projectId`, "prj:"),
    planId: identifier(input["planId"], `${path}.planId`, "pln:"),
    planRevision: revision(input["planRevision"], `${path}.planRevision`),
    taskId: identifier(input["taskId"], `${path}.taskId`, "tsk:"),
    attempt: integer(input["attempt"], `${path}.attempt`, 1, 100),
    workId: identifier(input["workId"], `${path}.workId`),
    leaseId: identifier(input["leaseId"], `${path}.leaseId`),
    fencingToken: integer(input["fencingToken"], `${path}.fencingToken`, 1),
    route: parseRoute(input["route"], `${path}.route`),
    reservationId: nullableIdentifier(input["reservationId"], `${path}.reservationId`, "reservation:"),
    dispatchId: nullableIdentifier(input["dispatchId"], `${path}.dispatchId`),
    sessionId: nullableIdentifier(input["sessionId"], `${path}.sessionId`, "ses:"),
    grantDigest: digest(input["grantDigest"], `${path}.grantDigest`),
    consumedApprovalIds: idArray(input["consumedApprovalIds"], `${path}.consumedApprovalIds`, "apr:"),
    consumedHandoverId: nullableIdentifier(input["consumedHandoverId"], `${path}.consumedHandoverId`, "hnd:"),
    state, usage: parseUsage(input["usage"], `${path}.usage`), startedAt, finishedAt, terminal,
  });
}

export function parseSession(value: unknown, _callerPath?: string): Session {
  const path = "session";
  const input = record(value, path);
  exact(input, ["schemaVersion", "sessionId", "projectId", "providerId", "providerSessionRef", "workspace", "worktreePath", "containment", "state", "lastHeartbeatAt", "heartbeatIntervalMs", "ownerRunId", "resumable", "archivedAt", "archiveRef", "createdAt", "updatedAt"], path);
  const containmentInput = record(input["containment"], `${path}.containment`);
  exact(containmentInput, ["backendId", "securityClass", "jobObjectBound", "terminationConfirmable"], `${path}.containment`);
  const state = enumValue(input["state"], SESSION_STATES, `${path}.state`);
  const workspace = parseWorkspace(input["workspace"], `${path}.workspace`);
  const projectId = identifier(input["projectId"], `${path}.projectId`, "prj:");
  if (workspace.projectId !== projectId) refuse("REFERENCE_INCONSISTENT", `${path}.workspace`, "The workspace belongs to a different project.");
  const ownerRunId = nullableIdentifier(input["ownerRunId"], `${path}.ownerRunId`, "run:");
  if (["starting", "running", "awaiting_input", "stopping", "lost"].includes(state) && ownerRunId === null) {
    refuse("REFERENCE_INCONSISTENT", `${path}.ownerRunId`, "A live session requires an owner run.");
  }
  const providerSessionRef = optionalText(input["providerSessionRef"], `${path}.providerSessionRef`, 4_096);
  if (["running", "awaiting_input", "stopping", "stopped", "lost", "orphaned", "termination_unconfirmed"].includes(state) && providerSessionRef === null) {
    refuse("INVARIANT_VIOLATION", `${path}.providerSessionRef`, "A started provider session requires its opaque reference as data.");
  }
  const worktreePath = nullable(input["worktreePath"], (item) => absoluteCanonicalPath(item, `${path}.worktreePath`));
  const archivedAt = nullableTimestamp(input["archivedAt"], `${path}.archivedAt`);
  if ((state === "archived") !== (archivedAt !== null)) refuse("INVARIANT_VIOLATION", path, "Session archive metadata does not match its state.");
  const createdAt = timestamp(input["createdAt"], `${path}.createdAt`);
  const updatedAt = timestamp(input["updatedAt"], `${path}.updatedAt`);
  if (updatedAt < createdAt || (archivedAt !== null && archivedAt < createdAt)) refuse("INVARIANT_VIOLATION", path, "Session timestamps are inconsistent.");
  return Object.freeze({
    schemaVersion: schema(input["schemaVersion"], `${path}.schemaVersion`),
    sessionId: identifier(input["sessionId"], `${path}.sessionId`, "ses:"), projectId,
    providerId: identifier(input["providerId"], `${path}.providerId`), providerSessionRef, workspace, worktreePath,
    containment: Object.freeze({
      backendId: identifier(containmentInput["backendId"], `${path}.containment.backendId`),
      securityClass: enumValue(containmentInput["securityClass"], BACKEND_SECURITY_CLASS_VALUES, `${path}.containment.securityClass`),
      jobObjectBound: booleanValue(containmentInput["jobObjectBound"], `${path}.containment.jobObjectBound`),
      terminationConfirmable: booleanValue(containmentInput["terminationConfirmable"], `${path}.containment.terminationConfirmable`),
    }),
    state,
    lastHeartbeatAt: nullableTimestamp(input["lastHeartbeatAt"], `${path}.lastHeartbeatAt`),
    heartbeatIntervalMs: integer(input["heartbeatIntervalMs"], `${path}.heartbeatIntervalMs`, 1, 86_400_000),
    ownerRunId,
    resumable: booleanValue(input["resumable"], `${path}.resumable`), archivedAt,
    archiveRef: optionalText(input["archiveRef"], `${path}.archiveRef`, 128), createdAt, updatedAt,
  });
}

export function parseHandover(value: unknown, _callerPath?: string): Handover {
  const path = "handover";
  const input = record(value, path);
  exact(input, ["schemaVersion", "handoverId", "revision", "supersedes", "projectId", "planId", "planRevision", "fromRunId", "toTaskId", "sequence", "state", "repository", "goals", "nonGoals", "completed", "remaining", "risks", "operatorDecisionIds", "consumedApprovalIds", "evidenceIds", "budgetRemaining", "expectedOutputSchema", "origin", "authority", "modelNarrativeRef", "createdAt", "acknowledgedAt", "acknowledgedByRunId"], path);
  const repositoryInput = record(input["repository"], `${path}.repository`);
  exact(repositoryInput, ["repositoryRoot", "snapshotId", "baseRevision", "branch", "worktreeDisposition", "resultRevision"], `${path}.repository`);
  const completed = arrayValue(input["completed"], `${path}.completed`, (item, itemPath) => {
    const entry = record(item, itemPath); exact(entry, ["claim", "evidenceIds"], itemPath);
    return Object.freeze({ claim: textValue(entry["claim"], `${itemPath}.claim`), evidenceIds: idArray(entry["evidenceIds"], `${itemPath}.evidenceIds`, "evd:", 1) });
  });
  const remaining = arrayValue(input["remaining"], `${path}.remaining`, (item, itemPath) => {
    const entry = record(item, itemPath); exact(entry, ["item", "requirementIds"], itemPath);
    return Object.freeze({ item: textValue(entry["item"], `${itemPath}.item`), requirementIds: idArray(entry["requirementIds"], `${itemPath}.requirementIds`) });
  });
  const risks = arrayValue(input["risks"], `${path}.risks`, (item, itemPath) => {
    const entry = record(item, itemPath); exact(entry, ["risk", "severity", "mitigated"], itemPath);
    return Object.freeze({ risk: textValue(entry["risk"], `${itemPath}.risk`), severity: enumValue(entry["severity"], ["low", "medium", "high"] as const, `${itemPath}.severity`), mitigated: booleanValue(entry["mitigated"], `${itemPath}.mitigated`) });
  });
  const handoverId = contentId(input["handoverId"], `${path}.handoverId`, "hnd:");
  const supersedes = nullableIdentifier(input["supersedes"], `${path}.supersedes`, "hnd:");
  if (supersedes === handoverId) refuse("INVARIANT_VIOLATION", path, "An immutable handover cannot supersede itself.");
  const evidenceIds = idArray(input["evidenceIds"], `${path}.evidenceIds`, "evd:");
  const evidenceSet = new Set(evidenceIds);
  if (completed.some((entry) => entry.evidenceIds.some((evidenceId) => !evidenceSet.has(evidenceId)))) {
    refuse("REFERENCE_INCONSISTENT", `${path}.completed`, "Completed handover claims must reference top-level evidence.");
  }
  const worktreeDisposition = enumValue(repositoryInput["worktreeDisposition"], ["reuse", "fresh-from-base", "fresh-from-result"] as const, `${path}.repository.worktreeDisposition`);
  const resultRevision = nullable(repositoryInput["resultRevision"], (item) => parseGitRevision(item, `${path}.repository.resultRevision`));
  if ((worktreeDisposition === "fresh-from-result") !== (resultRevision !== null)) {
    refuse("INVARIANT_VIOLATION", `${path}.repository`, "The worktree disposition and result revision are inconsistent.");
  }
  const state = enumValue(input["state"], HANDOVER_STATES, `${path}.state`);
  const acknowledgedAt = nullableTimestamp(input["acknowledgedAt"], `${path}.acknowledgedAt`);
  const acknowledgedByRunId = nullableIdentifier(input["acknowledgedByRunId"], `${path}.acknowledgedByRunId`, "run:");
  if ((state === "acknowledged") !== (acknowledgedAt !== null && acknowledgedByRunId !== null) || (acknowledgedAt === null) !== (acknowledgedByRunId === null)) {
    refuse("INVARIANT_VIOLATION", path, "Handover acknowledgement is inconsistent.");
  }
  const createdAt = timestamp(input["createdAt"], `${path}.createdAt`);
  if (acknowledgedAt !== null && acknowledgedAt < createdAt) refuse("INVARIANT_VIOLATION", path, "A handover cannot be acknowledged before it exists.");
  return Object.freeze({
    schemaVersion: schema(input["schemaVersion"], `${path}.schemaVersion`),
    handoverId,
    revision: literal(input["revision"], 1, `${path}.revision`),
    supersedes,
    projectId: identifier(input["projectId"], `${path}.projectId`, "prj:"),
    planId: identifier(input["planId"], `${path}.planId`, "pln:"),
    planRevision: revision(input["planRevision"], `${path}.planRevision`),
    fromRunId: identifier(input["fromRunId"], `${path}.fromRunId`, "run:"),
    toTaskId: identifier(input["toTaskId"], `${path}.toTaskId`, "tsk:"),
    sequence: revision(input["sequence"], `${path}.sequence`), state,
    repository: Object.freeze({
      repositoryRoot: absoluteCanonicalPath(repositoryInput["repositoryRoot"], `${path}.repository.repositoryRoot`),
      snapshotId: identifier(repositoryInput["snapshotId"], `${path}.repository.snapshotId`),
      baseRevision: parseGitRevision(repositoryInput["baseRevision"], `${path}.repository.baseRevision`),
      branch: parseGitBranch(repositoryInput["branch"], `${path}.repository.branch`),
      worktreeDisposition,
      resultRevision,
    }),
    goals: stringArray(input["goals"], `${path}.goals`, { minimum: 1 }),
    nonGoals: stringArray(input["nonGoals"], `${path}.nonGoals`), completed, remaining, risks,
    operatorDecisionIds: idArray(input["operatorDecisionIds"], `${path}.operatorDecisionIds`, "dec:"),
    consumedApprovalIds: idArray(input["consumedApprovalIds"], `${path}.consumedApprovalIds`, "apr:"),
    evidenceIds,
    budgetRemaining: parseBudget(input["budgetRemaining"], `${path}.budgetRemaining`),
    expectedOutputSchema: jsonObject(input["expectedOutputSchema"], `${path}.expectedOutputSchema`),
    origin: literal(input["origin"], "system", `${path}.origin`),
    authority: literal(input["authority"], "none", `${path}.authority`),
    modelNarrativeRef: optionalText(input["modelNarrativeRef"], `${path}.modelNarrativeRef`, 128),
    createdAt, acknowledgedAt, acknowledgedByRunId,
  });
}

export function parseDecision(value: unknown, _callerPath?: string): Decision {
  const path = "decision";
  const input = record(value, path);
  exact(input, ["schemaVersion", "decisionId", "revision", "projectId", "scope", "kind", "decidedBy", "statement", "rationale", "supersedes", "subjectDigest", "decidedAt"], path);
  const scopeInput = record(input["scope"], `${path}.scope`);
  exact(scopeInput, ["planId", "planRevision", "stageId", "taskId"], `${path}.scope`);
  const scope = Object.freeze({
    planId: nullableIdentifier(scopeInput["planId"], `${path}.scope.planId`, "pln:"),
    planRevision: nullable(scopeInput["planRevision"], (item) => revision(item, `${path}.scope.planRevision`)),
    stageId: nullableIdentifier(scopeInput["stageId"], `${path}.scope.stageId`, "stg:"),
    taskId: nullableIdentifier(scopeInput["taskId"], `${path}.scope.taskId`, "tsk:"),
  });
  if ((scope.planId === null) !== (scope.planRevision === null) || scope.stageId !== null && scope.planId === null || scope.taskId !== null && scope.planId === null) refuse("REFERENCE_INCONSISTENT", `${path}.scope`, "Stage and task decision scope requires an exact plan revision.");
  const kind = enumValue(input["kind"], DECISION_KINDS, `${path}.kind`);
  const decidedBy = enumValue(input["decidedBy"], ["operator", "policy", "deterministic-evaluation"] as const, `${path}.decidedBy`);
  if (kind === "budget-extension-accepted" && (decidedBy !== "operator" || scope.planId === null || scope.planRevision === null || scope.taskId === null)) refuse("AUTHORITY_VIOLATION", path, "A budget extension is an operator decision bound to one task and plan revision.");
  const decisionId = contentId(input["decisionId"], `${path}.decisionId`, "dec:");
  const supersedes = nullableIdentifier(input["supersedes"], `${path}.supersedes`, "dec:");
  if (supersedes === decisionId) refuse("INVARIANT_VIOLATION", path, "An immutable decision cannot supersede itself.");
  return Object.freeze({
    schemaVersion: schema(input["schemaVersion"], `${path}.schemaVersion`),
    decisionId,
    revision: literal(input["revision"], 1, `${path}.revision`),
    projectId: identifier(input["projectId"], `${path}.projectId`, "prj:"), scope,
    kind, decidedBy,
    statement: textValue(input["statement"], `${path}.statement`),
    rationale: optionalText(input["rationale"], `${path}.rationale`, PROJECT_LIMITS.text),
    supersedes,
    subjectDigest: digest(input["subjectDigest"], `${path}.subjectDigest`),
    decidedAt: timestamp(input["decidedAt"], `${path}.decidedAt`),
  });
}

function parseApprovalScope(value: unknown, path: string) {
  const input = record(value, path);
  exact(input, ["projectId", "taskId", "providerInstanceId", "workspaceId", "operationId", "traceId"], path);
  const parsed = Object.freeze({
    projectId: nullableIdentifier(input["projectId"], `${path}.projectId`, "prj:"),
    taskId: nullableIdentifier(input["taskId"], `${path}.taskId`, "tsk:"),
    providerInstanceId: nullableIdentifier(input["providerInstanceId"], `${path}.providerInstanceId`),
    workspaceId: nullableIdentifier(input["workspaceId"], `${path}.workspaceId`),
    operationId: nullableIdentifier(input["operationId"], `${path}.operationId`),
    traceId: nullableIdentifier(input["traceId"], `${path}.traceId`),
  });
  if (Object.values(parsed).every((item) => item === null)) refuse("INVARIANT_VIOLATION", path, "Approval scope must bind at least one exact identifier.");
  return parsed;
}

function parseSubjectSummary(value: unknown, path: string): SubjectSummary {
  const input = record(value, path);
  exact(input, ["what", "why", "changes", "where", "reversible", "scope", "effects", "exclusions"], path);
  return Object.freeze({
    what: textValue(input["what"], `${path}.what`), why: textValue(input["why"], `${path}.why`),
    changes: textValue(input["changes"], `${path}.changes`), where: textValue(input["where"], `${path}.where`),
    reversible: booleanValue(input["reversible"], `${path}.reversible`), scope: textValue(input["scope"], `${path}.scope`),
    effects: stringArray(input["effects"], `${path}.effects`, { minimum: 1 }),
    exclusions: stringArray(input["exclusions"], `${path}.exclusions`, { minimum: 1 }),
  });
}

function parseScopePattern(value: unknown, path: string): ScopePattern {
  const input = record(value, path);
  const kind = enumValue(input["kind"], ["git-publication", "external-communication", "paid-usage"] as const, `${path}.kind`);
  if (kind === "git-publication") {
    exact(input, ["kind", "projectId", "remote", "refPrefix", "forcePush"], path);
    return Object.freeze({ kind, projectId: identifier(input["projectId"], `${path}.projectId`, "prj:"), remote: textValue(input["remote"], `${path}.remote`, { maximum: 2_048, allowNewlines: false }), refPrefix: textValue(input["refPrefix"], `${path}.refPrefix`, { maximum: 255, allowNewlines: false }), forcePush: literal(input["forcePush"], false, `${path}.forcePush`) });
  }
  if (kind === "external-communication") {
    exact(input, ["kind", "integrationId", "channelRef", "recipientRef", "redactionClass"], path);
    return Object.freeze({ kind, integrationId: identifier(input["integrationId"], `${path}.integrationId`, "ext:"), channelRef: identifier(input["channelRef"], `${path}.channelRef`), recipientRef: identifier(input["recipientRef"], `${path}.recipientRef`), redactionClass: enumValue(input["redactionClass"], ["summary-only", "status-only"] as const, `${path}.redactionClass`) });
  }
  exact(input, ["kind", "providerInstanceId", "modelId", "currency", "ceilingMinorUnits"], path);
  return Object.freeze({ kind, providerInstanceId: identifier(input["providerInstanceId"], `${path}.providerInstanceId`), modelId: identifier(input["modelId"], `${path}.modelId`), currency: currency(input["currency"], `${path}.currency`), ceilingMinorUnits: integer(input["ceilingMinorUnits"], `${path}.ceilingMinorUnits`, 1) });
}

function parseMoneyBinding(value: unknown, path: string): MoneyBinding {
  const input = record(value, path);
  exact(input, ["vendor", "amountMinorUnits", "currency", "kind", "period", "occurrences", "quoteDigest", "quotedAt", "quoteExpiresAt"], path);
  const vendorInput = record(input["vendor"], `${path}.vendor`); exact(vendorInput, ["name", "instanceRef"], `${path}.vendor`);
  const kind = enumValue(input["kind"], ["one-time", "per-period", "ceiling"] as const, `${path}.kind`);
  const period = nullable(input["period"], (item) => enumValue(item, ["monthly", "annual"] as const, `${path}.period`));
  const occurrences = nullable(input["occurrences"], (item) => integer(item, `${path}.occurrences`, 1, 10_000));
  const quoteDigest = nullable(input["quoteDigest"], (item) => digest(item, `${path}.quoteDigest`));
  const quotedAt = nullableTimestamp(input["quotedAt"], `${path}.quotedAt`);
  const quoteExpiresAt = nullableTimestamp(input["quoteExpiresAt"], `${path}.quoteExpiresAt`);
  if ((kind === "per-period") !== (period !== null) || kind !== "per-period" && occurrences !== null || (quoteDigest === null) !== (quotedAt === null) || (quotedAt === null) !== (quoteExpiresAt === null) || quotedAt !== null && quoteExpiresAt !== null && quoteExpiresAt <= quotedAt) {
    refuse("INVARIANT_VIOLATION", path, "The money binding fields are inconsistent.");
  }
  return Object.freeze({
    vendor: Object.freeze({ name: textValue(vendorInput["name"], `${path}.vendor.name`, { maximum: 256 }), instanceRef: identifier(vendorInput["instanceRef"], `${path}.vendor.instanceRef`) }),
    amountMinorUnits: integer(input["amountMinorUnits"], `${path}.amountMinorUnits`, 1),
    currency: currency(input["currency"], `${path}.currency`), kind, period, occurrences, quoteDigest, quotedAt, quoteExpiresAt,
  });
}

const APPROVAL_ACTIONS = Object.freeze({
  "credential-use": ["secret-access"],
  "live-provider-request": ["cloud-execution", "provider-disclosure"],
  elevation: ["elevation"],
  "destructive-filesystem": ["deletion"],
  "git-publication": ["git-write"],
  "external-communication": ["external-message"],
  "install-update": ["package-install"],
  "application-restart": ["application-restart"],
  "paid-usage": ["paid-usage"], purchase: ["purchase"], subscription: ["subscription"],
  "spending-limit": ["spending-limit"], "ui-automation": ["ui-automation"], "scope-expansion": ["approval"],
} as const satisfies Readonly<Record<ApprovalRequest["class"], readonly ApprovalRequest["actions"][number][]>>);

export function parseApprovalRequest(value: unknown, _callerPath?: string): ApprovalRequest {
  const path = "approvalRequest";
  const input = record(value, path);
  exact(input, ["schemaVersion", "approvalRequestId", "class", "actions", "risk", "scope", "subjectDigest", "subjectSummary", "usage", "scopePattern", "consumptionCeiling", "consumptionCount", "retryAllowance", "effects", "exclusions", "money", "requestedBy", "state", "createdAt", "expiresAt", "decidedAt", "approverClass", "consumedAt", "revokedAt", "voidedBy"], path);
  const approvalClass = enumValue(input["class"], APPROVAL_CLASSES, `${path}.class`);
  const actions = unique(arrayValue(input["actions"], `${path}.actions`, (item, itemPath) => enumValue(item, PROJECT_POLICY_ACTION_VALUES, itemPath), { minimum: 1, maximum: PROJECT_POLICY_ACTION_VALUES.length }), `${path}.actions`);
  if (JSON.stringify(actions) !== JSON.stringify(APPROVAL_ACTIONS[approvalClass])) refuse("INVARIANT_VIOLATION", `${path}.actions`, "Approval actions do not match the closed class contract.");
  const usage = enumValue(input["usage"], ["one-shot", "bounded-recurring", "standing-revocable"] as const, `${path}.usage`);
  const scopePattern = nullable(input["scopePattern"], (item) => parseScopePattern(item, `${path}.scopePattern`));
  const consumptionCeiling = nullable(input["consumptionCeiling"], (item) => integer(item, `${path}.consumptionCeiling`, 1, 10_000));
  const consumptionCount = integer(input["consumptionCount"], `${path}.consumptionCount`, 0, 10_000);
  if ((usage === "one-shot") !== (scopePattern === null) || (usage === "bounded-recurring") !== (consumptionCeiling !== null)) refuse("INVARIANT_VIOLATION", path, "Approval usage bounds are inconsistent.");
  if (consumptionCeiling !== null && consumptionCount > consumptionCeiling) refuse("INVARIANT_VIOLATION", path, "Approval consumption exceeds its ceiling.");
  const recurringClass = approvalClass === "git-publication" || approvalClass === "external-communication" || approvalClass === "paid-usage";
  if (usage !== "one-shot" && !recurringClass || scopePattern !== null && scopePattern.kind !== approvalClass) refuse("INVARIANT_VIOLATION", path, "This approval class cannot use the supplied recurring scope.");
  if ((approvalClass === "ui-automation" || approvalClass === "scope-expansion") && usage !== "one-shot") refuse("INVARIANT_VIOLATION", path, "This approval class is one-shot only.");
  const effects = stringArray(input["effects"], `${path}.effects`, { minimum: 1 });
  const exclusions = stringArray(input["exclusions"], `${path}.exclusions`, { minimum: 1 });
  const subjectSummary = parseSubjectSummary(input["subjectSummary"], `${path}.subjectSummary`);
  if (JSON.stringify(subjectSummary.effects) !== JSON.stringify(effects) || JSON.stringify(subjectSummary.exclusions) !== JSON.stringify(exclusions)) refuse("INVARIANT_VIOLATION", `${path}.subjectSummary`, "Approval summary effects must derive from the typed effect lists.");
  const money = nullable(input["money"], (item) => parseMoneyBinding(item, `${path}.money`));
  const moneyClass = ["paid-usage", "purchase", "subscription", "spending-limit"].includes(approvalClass);
  if (moneyClass !== (money !== null) || usage === "standing-revocable" && money !== null) refuse("INVARIANT_VIOLATION", path, "Money binding does not match the approval class or usage.");
  const requestedByInput = record(input["requestedBy"], `${path}.requestedBy`); exact(requestedByInput, ["kind", "runId", "reason"], `${path}.requestedBy`);
  const requestedBy = Object.freeze({ kind: literal(requestedByInput["kind"], "system", `${path}.requestedBy.kind`), runId: nullableIdentifier(requestedByInput["runId"], `${path}.requestedBy.runId`, "run:"), reason: textValue(requestedByInput["reason"], `${path}.requestedBy.reason`) });
  const state = enumValue(input["state"], APPROVAL_STATES, `${path}.state`);
  const createdAt = timestamp(input["createdAt"], `${path}.createdAt`);
  const expiresAt = timestamp(input["expiresAt"], `${path}.expiresAt`);
  if (expiresAt <= createdAt) refuse("INVARIANT_VIOLATION", `${path}.expiresAt`, "Approval expiry must follow creation.");
  const decidedAt = nullableTimestamp(input["decidedAt"], `${path}.decidedAt`);
  const approverClass = nullable(input["approverClass"], (item) => enumValue(item, APPROVER_CLASSES, `${path}.approverClass`));
  const consumedAt = nullableTimestamp(input["consumedAt"], `${path}.consumedAt`);
  const revokedAt = nullableTimestamp(input["revokedAt"], `${path}.revokedAt`);
  const voidedBy = nullableIdentifier(input["voidedBy"], `${path}.voidedBy`);
  if ((decidedAt === null) !== (approverClass === null)) refuse("INVARIANT_VIOLATION", path, "Approval decision metadata must remain paired.");
  const hasDecision = decidedAt !== null;
  if (["approved", "rejected", "consumed", "partially_consumed", "revoked"].includes(state) && !hasDecision || state === "requested" && hasDecision) {
    refuse("INVARIANT_VIOLATION", path, "Approval decision history does not match the reachable state.");
  }
  if (state === "partially_consumed" && (usage !== "bounded-recurring" || consumptionCeiling === null || consumptionCount < 1 || consumptionCount >= consumptionCeiling)) refuse("INVARIANT_VIOLATION", path, "Partial consumption requires a bounded recurring approval below its ceiling.");
  if (state === "consumed" && (usage === "one-shot" ? consumptionCount !== 1 : usage !== "bounded-recurring" || consumptionCeiling === null || consumptionCount !== consumptionCeiling)) refuse("INVARIANT_VIOLATION", path, "Consumed approval counts do not match the usage contract.");
  if ((state === "requested" || state === "approved" || state === "rejected") && consumptionCount !== 0) refuse("INVARIANT_VIOLATION", path, "An unused approval cannot report a consumption count.");
  if (usage === "one-shot" && state !== "consumed" && consumptionCount !== 0) refuse("INVARIANT_VIOLATION", path, "A one-shot approval cannot preserve partial consumption.");
  if (usage === "bounded-recurring" && consumptionCeiling !== null && ["revoked", "expired", "voided"].includes(state) && consumptionCount >= consumptionCeiling) refuse("INVARIANT_VIOLATION", path, "An interrupted recurring approval cannot already be fully consumed.");
  if ((state === "consumed") !== (consumedAt !== null) || (state === "revoked") !== (revokedAt !== null) || (state === "voided") !== (voidedBy !== null)) refuse("INVARIANT_VIOLATION", path, "Approval lifecycle metadata does not match state.");
  if (usage === "standing-revocable" && (state === "consumed" || state === "partially_consumed" || consumedAt !== null || consumptionCount !== 0)) refuse("INVARIANT_VIOLATION", path, "Standing approvals are checked per use and never consumed.");
  if (decidedAt !== null && (decidedAt < createdAt || decidedAt >= expiresAt)) refuse("INVARIANT_VIOLATION", path, "Approval decision time is outside the request lifetime.");
  if (consumedAt !== null && (decidedAt === null || consumedAt < decidedAt || consumedAt >= expiresAt)) refuse("INVARIANT_VIOLATION", path, "Approval consumption time is outside the decided lifetime.");
  if (revokedAt !== null && (decidedAt === null || revokedAt < decidedAt)) refuse("INVARIANT_VIOLATION", path, "Approval revocation cannot precede its decision.");
  return Object.freeze({
    schemaVersion: schema(input["schemaVersion"], `${path}.schemaVersion`), approvalRequestId: identifier(input["approvalRequestId"], `${path}.approvalRequestId`, "apr:"),
    class: approvalClass, actions, risk: enumValue(input["risk"], TASK_RISKS, `${path}.risk`), scope: parseApprovalScope(input["scope"], `${path}.scope`),
    subjectDigest: digest(input["subjectDigest"], `${path}.subjectDigest`), subjectSummary, usage, scopePattern, consumptionCeiling, consumptionCount,
    retryAllowance: integer(input["retryAllowance"], `${path}.retryAllowance`, 0, 2), effects, exclusions, money, requestedBy, state,
    createdAt, expiresAt, decidedAt, approverClass, consumedAt, revokedAt, voidedBy,
  });
}

export function parseSpendingRequest(value: unknown, _callerPath?: string): SpendingRequest {
  const path = "spendingRequest";
  const input = record(value, path);
  exact(input, ["schemaVersion", "spendingRequestId", "projectId", "kind", "vendor", "amountMinorUnits", "currency", "recurrence", "quotedAt", "quoteExpiresAt", "quoteDigest", "justification", "linkedApprovalRequestId", "state", "executedAt", "externalReceiptRef", "createdAt"], path);
  const vendorInput = record(input["vendor"], `${path}.vendor`); exact(vendorInput, ["name", "instanceRef"], `${path}.vendor`);
  const kind = enumValue(input["kind"], ["paid-usage", "purchase", "subscription", "recurring-limit-change"] as const, `${path}.kind`);
  const recurrence = nullable(input["recurrence"], (item) => {
    const recurrenceInput = record(item, `${path}.recurrence`); exact(recurrenceInput, ["period", "occurrences"], `${path}.recurrence`);
    return Object.freeze({ period: enumValue(recurrenceInput["period"], ["monthly", "annual"] as const, `${path}.recurrence.period`), occurrences: nullable(recurrenceInput["occurrences"], (entry) => integer(entry, `${path}.recurrence.occurrences`, 1, 10_000)) });
  });
  if ((kind === "subscription") !== (recurrence !== null)) refuse("INVARIANT_VIOLATION", path, "Only a subscription carries recurrence.");
  const quotedAt = timestamp(input["quotedAt"], `${path}.quotedAt`);
  const quoteExpiresAt = timestamp(input["quoteExpiresAt"], `${path}.quoteExpiresAt`);
  const createdAt = timestamp(input["createdAt"], `${path}.createdAt`);
  if (quoteExpiresAt <= quotedAt || quotedAt < createdAt) refuse("INVARIANT_VIOLATION", path, "Spending quote timestamps are inconsistent.");
  const state = enumValue(input["state"], SPENDING_STATES, `${path}.state`);
  const executedAt = nullableTimestamp(input["executedAt"], `${path}.executedAt`);
  const externalReceiptRef = optionalText(input["externalReceiptRef"], `${path}.externalReceiptRef`, 128);
  if (["operator_executed", "reconciled"].includes(state) !== (executedAt !== null) || (state === "reconciled") !== (externalReceiptRef !== null)) refuse("INVARIANT_VIOLATION", path, "Spending execution evidence does not match the state.");
  return Object.freeze({
    schemaVersion: schema(input["schemaVersion"], `${path}.schemaVersion`), spendingRequestId: identifier(input["spendingRequestId"], `${path}.spendingRequestId`, "spd:"),
    projectId: nullableIdentifier(input["projectId"], `${path}.projectId`, "prj:"), kind,
    vendor: Object.freeze({ name: textValue(vendorInput["name"], `${path}.vendor.name`, { maximum: 256 }), instanceRef: identifier(vendorInput["instanceRef"], `${path}.vendor.instanceRef`) }),
    amountMinorUnits: integer(input["amountMinorUnits"], `${path}.amountMinorUnits`, 1), currency: currency(input["currency"], `${path}.currency`), recurrence,
    quotedAt, quoteExpiresAt, quoteDigest: digest(input["quoteDigest"], `${path}.quoteDigest`), justification: textValue(input["justification"], `${path}.justification`),
    linkedApprovalRequestId: identifier(input["linkedApprovalRequestId"], `${path}.linkedApprovalRequestId`, "apr:"), state, executedAt, externalReceiptRef, createdAt,
  });
}

function parseCircuit(value: unknown, path: string) {
  const input = record(value, path); exact(input, ["schemaVersion", "evidenceId", "providerId", "profileId", "state", "observedAt", "sourceFingerprint"], path);
  return Object.freeze({ schemaVersion: literal(input["schemaVersion"], 1, `${path}.schemaVersion`), evidenceId: identifier(input["evidenceId"], `${path}.evidenceId`), providerId: identifier(input["providerId"], `${path}.providerId`), profileId: identifier(input["profileId"], `${path}.profileId`), state: enumValue(input["state"], ["closed", "open", "half-open"] as const, `${path}.state`), observedAt: timestamp(input["observedAt"], `${path}.observedAt`), sourceFingerprint: digest(input["sourceFingerprint"], `${path}.sourceFingerprint`) });
}

export function parseUsageReservation(value: unknown, _callerPath?: string): UsageReservation {
  const path = "usageReservation";
  const input = record(value, path);
  exact(input, ["reservationId", "snapshotId", "sourceAdapterVersion", "sourceFingerprint", "observedAt", "fiveHourWindowId", "fiveHourResetAt", "weeklyWindowId", "weeklyResetAt", "usedFiveHourBasisPoints", "usedWeeklyBasisPoints", "predictedFiveHourBasisPoints", "predictedWeeklyBasisPoints", "estimatedUsage", "circuit", "reservedAt", "status", "actualUsage", "reconciledAt"], path);
  const status = enumValue(input["status"], ["reserved", "reconciliation-required", "reconciled", "released"] as const, `${path}.status`);
  const actualUsage = nullable(input["actualUsage"], (item) => parseUsage(item, `${path}.actualUsage`));
  const reconciledAt = nullableTimestamp(input["reconciledAt"], `${path}.reconciledAt`);
  const terminalAccounting = status === "reconciled" || status === "released";
  if (terminalAccounting !== (actualUsage !== null && reconciledAt !== null) || (actualUsage === null) !== (reconciledAt === null)) refuse("INVARIANT_VIOLATION", path, "Usage reconciliation metadata does not match the scheduler-owned status.");
  const observedAt = timestamp(input["observedAt"], `${path}.observedAt`);
  const fiveHourResetAt = timestamp(input["fiveHourResetAt"], `${path}.fiveHourResetAt`);
  const weeklyResetAt = timestamp(input["weeklyResetAt"], `${path}.weeklyResetAt`);
  const reservedAt = timestamp(input["reservedAt"], `${path}.reservedAt`);
  return Object.freeze({
    reservationId: identifier(input["reservationId"], `${path}.reservationId`, "reservation:"), snapshotId: identifier(input["snapshotId"], `${path}.snapshotId`),
    sourceAdapterVersion: textValue(input["sourceAdapterVersion"], `${path}.sourceAdapterVersion`, { maximum: 128, allowNewlines: false }), sourceFingerprint: digest(input["sourceFingerprint"], `${path}.sourceFingerprint`), observedAt,
    fiveHourWindowId: identifier(input["fiveHourWindowId"], `${path}.fiveHourWindowId`), fiveHourResetAt, weeklyWindowId: identifier(input["weeklyWindowId"], `${path}.weeklyWindowId`), weeklyResetAt,
    usedFiveHourBasisPoints: integer(input["usedFiveHourBasisPoints"], `${path}.usedFiveHourBasisPoints`, 0, 10_000), usedWeeklyBasisPoints: integer(input["usedWeeklyBasisPoints"], `${path}.usedWeeklyBasisPoints`, 0, 10_000),
    predictedFiveHourBasisPoints: integer(input["predictedFiveHourBasisPoints"], `${path}.predictedFiveHourBasisPoints`, 0, 10_000), predictedWeeklyBasisPoints: integer(input["predictedWeeklyBasisPoints"], `${path}.predictedWeeklyBasisPoints`, 0, 10_000),
    estimatedUsage: parseUsage(input["estimatedUsage"], `${path}.estimatedUsage`), circuit: parseCircuit(input["circuit"], `${path}.circuit`), reservedAt, status, actualUsage, reconciledAt,
  });
}

export function parseEvidenceRecord(value: unknown, _callerPath?: string): EvidenceRecord {
  const path = "evidenceRecord";
  const input = record(value, path);
  exact(input, ["schemaVersion", "evidenceId", "revision", "supersedes", "projectId", "runId", "kind", "sha256", "mediaType", "sizeBytes", "producedBy", "claimsSupported", "sensitivity", "retentionClass", "createdAt"], path);
  const evidenceId = contentId(input["evidenceId"], `${path}.evidenceId`, "evd:");
  const supersedes = nullableIdentifier(input["supersedes"], `${path}.supersedes`, "evd:");
  if (supersedes === evidenceId) refuse("INVARIANT_VIOLATION", path, "Immutable evidence cannot supersede itself.");
  return Object.freeze({
    schemaVersion: schema(input["schemaVersion"], `${path}.schemaVersion`),
    evidenceId,
    revision: literal(input["revision"], 1, `${path}.revision`),
    supersedes,
    projectId: identifier(input["projectId"], `${path}.projectId`, "prj:"),
    runId: identifier(input["runId"], `${path}.runId`, "run:"),
    kind: textValue(input["kind"], `${path}.kind`, { maximum: 128, allowNewlines: false }),
    sha256: digest(input["sha256"], `${path}.sha256`),
    mediaType: mediaType(input["mediaType"], `${path}.mediaType`),
    sizeBytes: integer(input["sizeBytes"], `${path}.sizeBytes`, 0),
    producedBy: enumValue(input["producedBy"], ["deterministic-validation", "workspace-reconciliation", "provider", "operator"] as const, `${path}.producedBy`),
    claimsSupported: idArray(input["claimsSupported"], `${path}.claimsSupported`),
    sensitivity: enumValue(input["sensitivity"], DATA_CLASSIFICATION_VALUES, `${path}.sensitivity`),
    retentionClass: enumValue(input["retentionClass"], ["permanent", "bounded", "diagnostic"] as const, `${path}.retentionClass`),
    createdAt: timestamp(input["createdAt"], `${path}.createdAt`),
  });
}

export function parseDeliverable(value: unknown, _callerPath?: string): Deliverable {
  const path = "deliverable";
  const input = record(value, path);
  exact(input, ["schemaVersion", "deliverableId", "projectId", "stageId", "title", "kind", "evidenceIds", "repositoryRef", "acceptance", "acceptedByDecisionId", "createdAt"], path);
  const repositoryRef = nullable(input["repositoryRef"], (item) => {
    const entry = record(item, `${path}.repositoryRef`); exact(entry, ["revision", "branch"], `${path}.repositoryRef`);
    return Object.freeze({ revision: textValue(entry["revision"], `${path}.repositoryRef.revision`, { maximum: 128, allowNewlines: false }), branch: optionalText(entry["branch"], `${path}.repositoryRef.branch`, 255) });
  });
  const acceptance = enumValue(input["acceptance"], ["pending", "accepted", "rejected"] as const, `${path}.acceptance`);
  const acceptedByDecisionId = nullableIdentifier(input["acceptedByDecisionId"], `${path}.acceptedByDecisionId`, "dec:");
  if ((acceptance === "accepted") !== (acceptedByDecisionId !== null)) refuse("INVARIANT_VIOLATION", path, "Deliverable acceptance evidence does not match its state.");
  return Object.freeze({
    schemaVersion: schema(input["schemaVersion"], `${path}.schemaVersion`),
    deliverableId: identifier(input["deliverableId"], `${path}.deliverableId`, "dlv:"),
    projectId: identifier(input["projectId"], `${path}.projectId`, "prj:"),
    stageId: nullableIdentifier(input["stageId"], `${path}.stageId`, "stg:"),
    title: textValue(input["title"], `${path}.title`, { maximum: 512 }),
    kind: enumValue(input["kind"], ["commit", "branch", "patch", "document", "report", "artifact-set"] as const, `${path}.kind`),
    evidenceIds: idArray(input["evidenceIds"], `${path}.evidenceIds`, "evd:", 1), repositoryRef, acceptance, acceptedByDecisionId,
    createdAt: timestamp(input["createdAt"], `${path}.createdAt`),
  });
}

export function parseBlocker(value: unknown, _callerPath?: string): Blocker {
  const path = "blocker";
  const input = record(value, path);
  exact(input, ["schemaVersion", "blockerId", "projectId", "scope", "kind", "ruleIds", "statement", "unblockedBy", "operatorActionable", "state", "openedAt", "clearedAt", "clearedBy"], path);
  const scopeInput = record(input["scope"], `${path}.scope`); exact(scopeInput, ["planId", "stageId", "taskId", "runId"], `${path}.scope`);
  const scope = Object.freeze({ planId: nullableIdentifier(scopeInput["planId"], `${path}.scope.planId`, "pln:"), stageId: nullableIdentifier(scopeInput["stageId"], `${path}.scope.stageId`, "stg:"), taskId: nullableIdentifier(scopeInput["taskId"], `${path}.scope.taskId`, "tsk:"), runId: nullableIdentifier(scopeInput["runId"], `${path}.scope.runId`, "run:") });
  if (Object.values(scope).every((entry) => entry === null) || scope.stageId !== null && scope.planId === null || scope.taskId !== null && scope.planId === null) refuse("REFERENCE_INCONSISTENT", `${path}.scope`, "Blocker scope is incomplete.");
  const state = enumValue(input["state"], BLOCKER_STATES, `${path}.state`);
  const clearedAt = nullableTimestamp(input["clearedAt"], `${path}.clearedAt`);
  const clearedBy = nullableIdentifier(input["clearedBy"], `${path}.clearedBy`);
  if ((state === "cleared") !== (clearedAt !== null && clearedBy !== null) || (clearedAt === null) !== (clearedBy === null)) refuse("INVARIANT_VIOLATION", path, "Blocker clearing evidence does not match state.");
  const openedAt = timestamp(input["openedAt"], `${path}.openedAt`);
  if (clearedAt !== null && clearedAt < openedAt) refuse("INVARIANT_VIOLATION", path, "A blocker cannot clear before it opens.");
  const kind = enumValue(input["kind"], BLOCKER_KINDS, `${path}.kind`);
  const copy = deriveBlockerCopy(kind);
  const statement = textValue(input["statement"], `${path}.statement`);
  const unblockedBy = stringArray(input["unblockedBy"], `${path}.unblockedBy`, { minimum: 1 });
  const operatorActionable = booleanValue(input["operatorActionable"], `${path}.operatorActionable`);
  if (statement !== copy.statement || JSON.stringify(unblockedBy) !== JSON.stringify(copy.unblockedBy) || operatorActionable !== copy.operatorActionable) {
    refuse("AUTHORITY_VIOLATION", path, "Blocker presentation must come from the finite typed serializer.");
  }
  return Object.freeze({
    schemaVersion: schema(input["schemaVersion"], `${path}.schemaVersion`), blockerId: identifier(input["blockerId"], `${path}.blockerId`, "blk:"),
    projectId: identifier(input["projectId"], `${path}.projectId`, "prj:"), scope,
    kind,
    ruleIds: unique(arrayValue(input["ruleIds"], `${path}.ruleIds`, ruleId), `${path}.ruleIds`),
    statement, unblockedBy, operatorActionable, state, openedAt, clearedAt, clearedBy,
  });
}

function parseNotificationDelivery(value: unknown, path: string): NotificationDelivery {
  const input = record(value, path);
  exact(input, ["channel", "state", "attempt", "idempotencyKey", "lastAttemptAt", "failureCode"], path);
  const state = enumValue(input["state"], NOTIFICATION_DELIVERY_STATES, `${path}.state`);
  const attempt = integer(input["attempt"], `${path}.attempt`, 0, 10);
  const lastAttemptAt = nullableTimestamp(input["lastAttemptAt"], `${path}.lastAttemptAt`);
  const failureCode = optionalText(input["failureCode"], `${path}.failureCode`, 128);
  if ((attempt === 0) !== (lastAttemptAt === null) || (state === "failed") !== (failureCode !== null)) refuse("INVARIANT_VIOLATION", path, "Notification delivery attempt metadata is inconsistent.");
  return Object.freeze({ channel: enumValue(input["channel"], ["in-app", "windows-toast", "discord", "telegram", "whatsapp"] as const, `${path}.channel`), state, attempt, idempotencyKey: identifier(input["idempotencyKey"], `${path}.idempotencyKey`), lastAttemptAt, failureCode });
}

export function parseNotification(value: unknown, _callerPath?: string): Notification {
  const path = "notification";
  const input = record(value, path);
  exact(input, ["schemaVersion", "notificationId", "projectId", "category", "severity", "episodeKey", "title", "body", "deepLink", "actionable", "createdAt", "quietHoursDeferredUntil", "deliveries", "acknowledgedAt", "expiresAt"], path);
  const projectId = nullableIdentifier(input["projectId"], `${path}.projectId`, "prj:");
  const deepLink = nullable(input["deepLink"], (item) => parseProjectDeepLink(item, `${path}.deepLink`));
  const deliveries = arrayValue(input["deliveries"], `${path}.deliveries`, parseNotificationDelivery, { minimum: 1, maximum: 5 });
  unique(deliveries.map((entry) => entry.channel), `${path}.deliveries.channel`);
  unique(deliveries.map((entry) => entry.idempotencyKey), `${path}.deliveries.idempotencyKey`);
  const category = enumValue(input["category"], NOTIFICATION_CATEGORIES, `${path}.category`);
  const severity = enumValue(input["severity"], ["info", "success", "warning", "danger", "urgent"] as const, `${path}.severity`);
  if (["emergency-stop-activated", "session-termination-unconfirmed"].includes(category) !== (severity === "urgent")) refuse("INVARIANT_VIOLATION", path, "Urgent severity is reserved for the two urgent notification categories.");
  const actionable = booleanValue(input["actionable"], `${path}.actionable`);
  if (actionable !== (deepLink !== null)) refuse("INVARIANT_VIOLATION", path, "Actionable notifications require exactly one authenticated deep link.");
  if (deepLink !== null && deepLink.route !== notificationDeepLinkRoute(category)) refuse("REFERENCE_INCONSISTENT", `${path}.deepLink`, "The notification category and own-route link disagree.");
  const linkedProjectId = deepLink === null ? null : deepLinkProjectId(deepLink);
  if (linkedProjectId !== null && linkedProjectId !== projectId) refuse("REFERENCE_INCONSISTENT", `${path}.deepLink`, "The notification link belongs to a different project.");
  const copy = deriveNotificationCopy(category);
  const title = textValue(input["title"], `${path}.title`, { maximum: 1_024 });
  const body = textValue(input["body"], `${path}.body`, { maximum: 1_024 });
  if (title !== copy.title || body !== copy.body) refuse("AUTHORITY_VIOLATION", path, "Notification copy must come from the finite typed serializer.");
  return Object.freeze({
    schemaVersion: schema(input["schemaVersion"], `${path}.schemaVersion`), notificationId: identifier(input["notificationId"], `${path}.notificationId`, "ntf:"),
    projectId, category, severity,
    episodeKey: identifier(input["episodeKey"], `${path}.episodeKey`), title, body,
    deepLink, actionable, createdAt: timestamp(input["createdAt"], `${path}.createdAt`), quietHoursDeferredUntil: nullableTimestamp(input["quietHoursDeferredUntil"], `${path}.quietHoursDeferredUntil`),
    deliveries, acknowledgedAt: nullableTimestamp(input["acknowledgedAt"], `${path}.acknowledgedAt`), expiresAt: nullableTimestamp(input["expiresAt"], `${path}.expiresAt`),
  });
}

export function parseCommunicationThread(value: unknown, _callerPath?: string): CommunicationThread {
  const path = "communicationThread";
  const input = record(value, path);
  exact(input, ["schemaVersion", "threadId", "projectId", "channel", "participantRef", "messages", "createdAt"], path);
  const messages = arrayValue(input["messages"], `${path}.messages`, (item, itemPath) => {
    const entry = record(item, itemPath); exact(entry, ["messageId", "direction", "at", "bodyRef", "trust", "derivedRecordIds"], itemPath);
    const direction = enumValue(entry["direction"], ["inbound", "outbound"] as const, `${itemPath}.direction`);
    const trust = enumValue(entry["trust"], ["untrusted-input", "system-generated"] as const, `${itemPath}.trust`);
    if ((direction === "inbound") !== (trust === "untrusted-input")) refuse("AUTHORITY_VIOLATION", itemPath, "Inbound communication is always untrusted input.");
    return Object.freeze({ messageId: identifier(entry["messageId"], `${itemPath}.messageId`), direction, at: timestamp(entry["at"], `${itemPath}.at`), bodyRef: textValue(entry["bodyRef"], `${itemPath}.bodyRef`, { maximum: 128, allowNewlines: false }), trust, derivedRecordIds: idArray(entry["derivedRecordIds"], `${itemPath}.derivedRecordIds`) });
  });
  unique(messages.map((entry) => entry.messageId), `${path}.messages`);
  const createdAt = timestamp(input["createdAt"], `${path}.createdAt`);
  if (messages.some((entry) => entry.at < createdAt)) refuse("INVARIANT_VIOLATION", path, "A communication message cannot precede its thread.");
  return Object.freeze({
    schemaVersion: schema(input["schemaVersion"], `${path}.schemaVersion`), threadId: identifier(input["threadId"], `${path}.threadId`, "thr:"),
    projectId: nullableIdentifier(input["projectId"], `${path}.projectId`, "prj:"), channel: enumValue(input["channel"], ["in-app", "discord", "telegram", "whatsapp"] as const, `${path}.channel`),
    participantRef: identifier(input["participantRef"], `${path}.participantRef`), messages, createdAt,
  });
}

export function parseExternalIntegration(value: unknown, _callerPath?: string): ExternalIntegration {
  const path = "externalIntegration";
  const input = record(value, path);
  exact(input, ["schemaVersion", "integrationId", "kind", "implementationId", "state", "capabilities", "credentialRef", "allowlist", "boundVersion", "boundDigest", "lastVerifiedAt", "createdAt"], path);
  const state = enumValue(input["state"], ["planned", "configured", "unavailable", "revoked"] as const, `${path}.state`);
  const capabilities = stringArray(input["capabilities"], `${path}.capabilities`, { itemMaximum: 128 });
  if (capabilities.includes("*")) refuse("AUTHORITY_VIOLATION", `${path}.capabilities`, "Integration capabilities must be explicit.");
  const credentialRef = nullable(input["credentialRef"], (item) => parseCredentialRef(item, `${path}.credentialRef`));
  const allowlist = stringArray(input["allowlist"], `${path}.allowlist`, { itemMaximum: 512 });
  const boundVersion = optionalText(input["boundVersion"], `${path}.boundVersion`, 128);
  const boundDigest = nullable(input["boundDigest"], (item) => digest(item, `${path}.boundDigest`));
  const lastVerifiedAt = nullableTimestamp(input["lastVerifiedAt"], `${path}.lastVerifiedAt`);
  if (state === "planned" && (capabilities.length > 0 || credentialRef !== null || allowlist.length > 0 || boundVersion !== null || boundDigest !== null || lastVerifiedAt !== null)) refuse("INVARIANT_VIOLATION", path, "A planned integration has no configured capability or binding.");
  if (state === "configured" && capabilities.length === 0) refuse("INVARIANT_VIOLATION", path, "A configured integration must enumerate capabilities.");
  if ((boundVersion === null) !== (boundDigest === null) || (boundDigest === null) !== (lastVerifiedAt === null)) refuse("INVARIANT_VIOLATION", path, "Integration verification bindings are all present or all absent.");
  return Object.freeze({
    schemaVersion: schema(input["schemaVersion"], `${path}.schemaVersion`), integrationId: identifier(input["integrationId"], `${path}.integrationId`, "ext:"),
    kind: enumValue(input["kind"], ["editor", "messaging", "usage-source", "repository-host"] as const, `${path}.kind`), implementationId: identifier(input["implementationId"], `${path}.implementationId`), state, capabilities, credentialRef,
    allowlist, boundVersion, boundDigest, lastVerifiedAt, createdAt: timestamp(input["createdAt"], `${path}.createdAt`),
  });
}

function parseCounts(value: unknown, path: string) {
  const input = record(value, path); exact(input, ["running", "queued", "blocked", "awaitingApproval", "failed", "completed"], path);
  return Object.freeze({ running: integer(input["running"], `${path}.running`), queued: integer(input["queued"], `${path}.queued`), blocked: integer(input["blocked"], `${path}.blocked`), awaitingApproval: integer(input["awaitingApproval"], `${path}.awaitingApproval`), failed: integer(input["failed"], `${path}.failed`), completed: integer(input["completed"], `${path}.completed`) });
}

function parseCoverageCount(value: unknown, path: string) {
  const input = record(value, path); exact(input, ["covered", "total"], path);
  const covered = integer(input["covered"], `${path}.covered`); const total = integer(input["total"], `${path}.total`);
  if (covered > total) refuse("INVARIANT_VIOLATION", path, "Coverage count exceeds its total.");
  return Object.freeze({ covered, total });
}

export function parseProjectHealthProjection(value: unknown, _callerPath?: string): ProjectHealthProjection {
  const path = "projectHealth";
  const input = record(value, path);
  exact(input, ["schemaVersion", "projectId", "computedAt", "sourceSequence", "planState", "stageProgress", "counts", "openBlockers", "coverage", "budget", "capacity", "confidence", "staleReason"], path);
  const stageProgress = arrayValue(input["stageProgress"], `${path}.stageProgress`, (item, itemPath) => {
    const entry = record(item, itemPath); exact(entry, ["stageId", "done", "total", "gate"], itemPath);
    const done = integer(entry["done"], `${itemPath}.done`); const total = integer(entry["total"], `${itemPath}.total`);
    if (done > total) refuse("INVARIANT_VIOLATION", itemPath, "Stage progress exceeds its total.");
    return Object.freeze({ stageId: identifier(entry["stageId"], `${itemPath}.stageId`, "stg:"), done, total, gate: enumValue(entry["gate"], ["automatic", "operator-review"] as const, `${itemPath}.gate`) });
  });
  unique(stageProgress.map((entry) => entry.stageId), `${path}.stageProgress`);
  const openBlockers = arrayValue(input["openBlockers"], `${path}.openBlockers`, (item, itemPath) => {
    const entry = record(item, itemPath); exact(entry, ["blockerId", "kind", "operatorActionable"], itemPath);
    return Object.freeze({ blockerId: identifier(entry["blockerId"], `${itemPath}.blockerId`, "blk:"), kind: enumValue(entry["kind"], BLOCKER_KINDS, `${itemPath}.kind`), operatorActionable: booleanValue(entry["operatorActionable"], `${itemPath}.operatorActionable`) });
  });
  unique(openBlockers.map((entry) => entry.blockerId), `${path}.openBlockers`);
  const coverage = nullable(input["coverage"], (item) => { const entry = record(item, `${path}.coverage`); exact(entry, ["required", "expectedQuality"], `${path}.coverage`); return Object.freeze({ required: parseCoverageCount(entry["required"], `${path}.coverage.required`), expectedQuality: parseCoverageCount(entry["expectedQuality"], `${path}.coverage.expectedQuality`) }); });
  const budgetInput = record(input["budget"], `${path}.budget`); exact(budgetInput, ["reservedMicros", "actualMicros", "ceilingMicros"], `${path}.budget`);
  const budget = Object.freeze({ reservedMicros: integer(budgetInput["reservedMicros"], `${path}.budget.reservedMicros`), actualMicros: integer(budgetInput["actualMicros"], `${path}.budget.actualMicros`), ceilingMicros: integer(budgetInput["ceilingMicros"], `${path}.budget.ceilingMicros`) });
  const capacity = arrayValue(input["capacity"], `${path}.capacity`, (item, itemPath) => {
    const entry = record(item, itemPath); exact(entry, ["profileId", "windowStatus", "headroomBasisPoints"], itemPath);
    return Object.freeze({ profileId: identifier(entry["profileId"], `${itemPath}.profileId`), windowStatus: enumValue(entry["windowStatus"], ["active", "inactive", "stale", "unavailable"] as const, `${itemPath}.windowStatus`), headroomBasisPoints: nullable(entry["headroomBasisPoints"], (headroom) => integer(headroom, `${itemPath}.headroomBasisPoints`, 0, 10_000)) });
  });
  unique(capacity.map((entry) => entry.profileId), `${path}.capacity`);
  const confidence = enumValue(input["confidence"], ["current", "stale"] as const, `${path}.confidence`);
  const staleReason = optionalText(input["staleReason"], `${path}.staleReason`, 512);
  if ((confidence === "stale") !== (staleReason !== null)) refuse("INVARIANT_VIOLATION", path, "Projection confidence and stale reason disagree.");
  return Object.freeze({ schemaVersion: schema(input["schemaVersion"], `${path}.schemaVersion`), projectId: identifier(input["projectId"], `${path}.projectId`, "prj:"), computedAt: timestamp(input["computedAt"], `${path}.computedAt`), sourceSequence: integer(input["sourceSequence"], `${path}.sourceSequence`), planState: nullable(input["planState"], (item) => enumValue(item, PLAN_STATES, `${path}.planState`)), stageProgress, counts: parseCounts(input["counts"], `${path}.counts`), openBlockers, coverage, budget, capacity, confidence, staleReason });
}

export function parseProjectStop(value: unknown, _callerPath?: string): ProjectStop {
  const path = "projectStop";
  const input = record(value, path);
  exact(input, ["schemaVersion", "projectStopId", "revision", "projectId", "engagedAt", "effects", "resumedAt"], path);
  const effectsInput = record(input["effects"], `${path}.effects`);
  exact(effectsInput, ["cancelledTaskIds", "stoppingSessionIds", "unconfirmedSessionIds", "voidedApprovalIds", "voidedHandoverIds", "releasedReservationIds", "retainedReservationIds"], `${path}.effects`);
  const releasedReservationIds = idArray(effectsInput["releasedReservationIds"], `${path}.effects.releasedReservationIds`, "reservation:");
  const retainedReservationIds = idArray(effectsInput["retainedReservationIds"], `${path}.effects.retainedReservationIds`, "reservation:");
  if (releasedReservationIds.some((id) => retainedReservationIds.includes(id))) refuse("INVARIANT_VIOLATION", `${path}.effects`, "A reservation cannot be both released and retained.");
  const engagedAt = timestamp(input["engagedAt"], `${path}.engagedAt`); const resumedAt = nullableTimestamp(input["resumedAt"], `${path}.resumedAt`);
  if (resumedAt !== null && resumedAt < engagedAt) refuse("INVARIANT_VIOLATION", path, "A project stop cannot resume before engagement.");
  return Object.freeze({ schemaVersion: schema(input["schemaVersion"], `${path}.schemaVersion`), projectStopId: identifier(input["projectStopId"], `${path}.projectStopId`, "pst:"), revision: revision(input["revision"], `${path}.revision`), projectId: identifier(input["projectId"], `${path}.projectId`, "prj:"), engagedAt, effects: Object.freeze({ cancelledTaskIds: idArray(effectsInput["cancelledTaskIds"], `${path}.effects.cancelledTaskIds`, "tsk:"), stoppingSessionIds: idArray(effectsInput["stoppingSessionIds"], `${path}.effects.stoppingSessionIds`, "ses:"), unconfirmedSessionIds: idArray(effectsInput["unconfirmedSessionIds"], `${path}.effects.unconfirmedSessionIds`, "ses:"), voidedApprovalIds: idArray(effectsInput["voidedApprovalIds"], `${path}.effects.voidedApprovalIds`, "apr:"), voidedHandoverIds: idArray(effectsInput["voidedHandoverIds"], `${path}.effects.voidedHandoverIds`, "hnd:"), releasedReservationIds, retainedReservationIds }), resumedAt });
}

export function parseProjectSummaryProjection(value: unknown, _callerPath?: string): ProjectSummaryProjection {
  const path = "projectSummary";
  const input = record(value, path);
  exact(input, ["schemaVersion", "projectId", "displayName", "status", "planState", "currentStage", "nextMilestone", "counts", "needsYou", "usage", "capacity", "confidence", "sourceSequence", "computedAt"], path);
  const projectId = identifier(input["projectId"], `${path}.projectId`, "prj:");
  const currentStage = nullable(input["currentStage"], (item) => { const entry = record(item, `${path}.currentStage`); exact(entry, ["ordinal", "title", "gate"], `${path}.currentStage`); return Object.freeze({ ordinal: integer(entry["ordinal"], `${path}.currentStage.ordinal`, 1), title: textValue(entry["title"], `${path}.currentStage.title`, { maximum: 512 }), gate: enumValue(entry["gate"], ["automatic", "operator-review"] as const, `${path}.currentStage.gate`) }); });
  const nextMilestone = nullable(input["nextMilestone"], (item) => { const entry = record(item, `${path}.nextMilestone`); exact(entry, ["title", "expectedBy"], `${path}.nextMilestone`); return Object.freeze({ title: textValue(entry["title"], `${path}.nextMilestone.title`, { maximum: 512 }), expectedBy: nullableTimestamp(entry["expectedBy"], `${path}.nextMilestone.expectedBy`) }); });
  const countInput = record(input["counts"], `${path}.counts`); exact(countInput, ["running", "waiting", "blocked", "awaitingApproval", "queued", "done", "total"], `${path}.counts`);
  const counts = Object.freeze({ running: integer(countInput["running"], `${path}.counts.running`), waiting: integer(countInput["waiting"], `${path}.counts.waiting`), blocked: integer(countInput["blocked"], `${path}.counts.blocked`), awaitingApproval: integer(countInput["awaitingApproval"], `${path}.counts.awaitingApproval`), queued: integer(countInput["queued"], `${path}.counts.queued`), done: integer(countInput["done"], `${path}.counts.done`), total: integer(countInput["total"], `${path}.counts.total`) });
  if (counts.done > counts.total) refuse("INVARIANT_VIOLATION", `${path}.counts`, "Completed work exceeds the project total.");
  const needsYou = arrayValue(input["needsYou"], `${path}.needsYou`, (item, itemPath) => {
    const entry = record(item, itemPath);
    exact(entry, ["kind", "title", "expiresAt", "deepLink"], itemPath);
    const kind = enumValue(entry["kind"], NEEDS_YOU_KINDS, `${itemPath}.kind`);
    const title = textValue(entry["title"], `${itemPath}.title`, { maximum: 512 });
    const deepLink = parseProjectDeepLink(entry["deepLink"], `${itemPath}.deepLink`);
    if (title !== deriveNeedsYouTitle(kind) || deepLink.route !== needsYouDeepLinkRoute(kind) || deepLinkProjectId(deepLink) !== projectId) {
      refuse("AUTHORITY_VIOLATION", itemPath, "Operator-needs copy and link must come from the finite typed serializer.");
    }
    return Object.freeze({ kind, title, expiresAt: nullableTimestamp(entry["expiresAt"], `${itemPath}.expiresAt`), deepLink });
  });
  const usageInput = record(input["usage"], `${path}.usage`); exact(usageInput, ["reservedBp", "actualBp", "currency", "estimateMicros", "actualMicros", "pricingAt"], `${path}.usage`);
  const usage = Object.freeze({ reservedBp: integer(usageInput["reservedBp"], `${path}.usage.reservedBp`, 0, 10_000), actualBp: integer(usageInput["actualBp"], `${path}.usage.actualBp`, 0, 10_000), currency: currency(usageInput["currency"], `${path}.usage.currency`), estimateMicros: integer(usageInput["estimateMicros"], `${path}.usage.estimateMicros`), actualMicros: integer(usageInput["actualMicros"], `${path}.usage.actualMicros`), pricingAt: timestamp(usageInput["pricingAt"], `${path}.usage.pricingAt`) });
  const capacity = arrayValue(input["capacity"], `${path}.capacity`, (item, itemPath) => { const entry = record(item, itemPath); exact(entry, ["alias", "ownership", "windowStatus", "eligible", "blockingRuleId", "resetAt"], itemPath); const eligible = booleanValue(entry["eligible"], `${itemPath}.eligible`); const blockingRuleId = nullable(entry["blockingRuleId"], (rule) => ruleId(rule, `${itemPath}.blockingRuleId`)); if (eligible === (blockingRuleId !== null)) refuse("INVARIANT_VIOLATION", itemPath, "Capacity eligibility and blocking rule disagree."); return Object.freeze({ alias: textValue(entry["alias"], `${itemPath}.alias`, { maximum: 128 }), ownership: enumValue(entry["ownership"], ["owned", "authorized-borrowed"] as const, `${itemPath}.ownership`), windowStatus: enumValue(entry["windowStatus"], ["active", "inactive", "stale", "unavailable"] as const, `${itemPath}.windowStatus`), eligible, blockingRuleId, resetAt: nullableTimestamp(entry["resetAt"], `${itemPath}.resetAt`) }); });
  return Object.freeze({ schemaVersion: schema(input["schemaVersion"], `${path}.schemaVersion`), projectId, displayName: textValue(input["displayName"], `${path}.displayName`, { maximum: 200 }), status: enumValue(input["status"], [...PROJECT_STATUSES, "stopped"] as const, `${path}.status`), planState: nullable(input["planState"], (item) => enumValue(item, PLAN_STATE_DISPLAY_WORDS, `${path}.planState`)), currentStage, nextMilestone, counts, needsYou, usage, capacity, confidence: enumValue(input["confidence"], ["current", "stale"] as const, `${path}.confidence`), sourceSequence: integer(input["sourceSequence"], `${path}.sourceSequence`), computedAt: timestamp(input["computedAt"], `${path}.computedAt`) });
}

const RECORD_PARSERS: Readonly<Record<ProjectRecordKind, (value: unknown, path?: string) => CanonicalProjectRecord>> = Object.freeze({
  project: parseProject, "project-brief": parseProjectBrief, constraint: parseConstraint,
  "project-plan": parseProjectPlan, "plan-stage": parsePlanStage, task: parseProjectTask,
  dependency: parseDependency, "agent-run": parseAgentRun, session: parseSession,
  handover: parseHandover, decision: parseDecision, "approval-request": parseApprovalRequest,
  "spending-request": parseSpendingRequest, "usage-reservation": parseUsageReservation,
  "evidence-record": parseEvidenceRecord, deliverable: parseDeliverable, blocker: parseBlocker,
  notification: parseNotification, "communication-thread": parseCommunicationThread,
  "external-integration": parseExternalIntegration, "project-health": parseProjectHealthProjection,
  "project-stop": parseProjectStop,
});

export function parseProjectRecord(kind: ProjectRecordKind, value: unknown): CanonicalProjectRecord {
  if (!(PROJECT_RECORD_KINDS as readonly string[]).includes(kind)) refuse("UNKNOWN_RECORD_KIND", "recordKind", "The project record kind is not supported.");
  return RECORD_PARSERS[kind](value, kind);
}

export function parseProjectRecordJson(kind: ProjectRecordKind, json: unknown): CanonicalProjectRecord {
  return parseProjectRecord(kind, parseJsonText(json));
}
