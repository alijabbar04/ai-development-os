import { createHash } from "node:crypto";
import {
  canonicalizeJson,
  parseArtifactId,
  parseEventId,
  parseModelId,
  parseProjectId,
  parseProviderId,
  parseTaskId,
  parseWorkspaceId,
  toCanonicalJson,
  validation,
  type JsonObject,
} from "@ai-dev-os/domain";
import { SchedulerError } from "./errors.js";
import {
  AGENT_CAPABILITIES,
  FAILURE_CLASSIFICATIONS,
  ORCHESTRATION_EVENT_SCHEMA_VERSION,
  ORCHESTRATION_EVENT_TYPES,
  ORCHESTRATION_SCHEMA_VERSION,
  PERMISSION_MODES,
  PROFILE_OWNERSHIP_CLASSES,
  TASK_PRIORITIES,
  type ArtifactReference,
  type EvidenceReference,
  type NormalizedUsage,
  type OrchestrationEvent,
  type OrchestrationTaskEnvelope,
  type OrchestrationTerminalResult,
  type ProviderThreadIdentity,
} from "./types.js";

const {
  ensureArray,
  ensureBoolean,
  ensureEnum,
  ensureEnumArray,
  ensureExactKeys,
  ensureNullable,
  ensureRecord,
  ensureSafeInteger,
  ensureString,
  ensureTimestamp,
  fail,
} = validation;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KIND = /^[a-z][a-z0-9._-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REVISION = /^[A-Fa-f0-9]{7,64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/;
const MAX_OBJECTIVE_CHARACTERS = 100_000;
const MAX_EXPECTED_SCHEMA_CHARACTERS = 100_000;
const MAX_TOKEN_COUNT = 1_000_000_000_000;
const MAX_COST_MICROS = Number.MAX_SAFE_INTEGER;

function parseId(value: unknown, path: string): string {
  return ensureString(value, path, { maxLength: 128, pattern: ID, patternName: "identifier" });
}

function parseSha(value: unknown, path: string): string {
  return ensureString(value, path, { maxLength: 64, pattern: SHA256, patternName: "lowercase SHA-256" });
}

function parseJsonObject(value: unknown, path: string, maximumCharacters: number): JsonObject {
  const normalized = canonicalizeJson(value, path);
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== "object") {
    fail(path, "not_object", "must be a JSON object.");
  }
  if (toCanonicalJson(normalized).length > maximumCharacters) {
    fail(path, "too_large", `cannot exceed ${maximumCharacters} canonical characters.`);
  }
  return normalized as JsonObject;
}

function parseNormalizedUsageInternal(value: unknown, path: string): NormalizedUsage {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, [
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningTokens",
    "toolCalls",
    "costMicros",
  ], path);
  return Object.freeze({
    inputTokens: ensureSafeInteger(input["inputTokens"], `${path}.inputTokens`, 0, MAX_TOKEN_COUNT),
    cachedInputTokens: ensureSafeInteger(input["cachedInputTokens"], `${path}.cachedInputTokens`, 0, MAX_TOKEN_COUNT),
    cacheWriteInputTokens: ensureSafeInteger(input["cacheWriteInputTokens"], `${path}.cacheWriteInputTokens`, 0, MAX_TOKEN_COUNT),
    outputTokens: ensureSafeInteger(input["outputTokens"], `${path}.outputTokens`, 0, MAX_TOKEN_COUNT),
    reasoningTokens: ensureSafeInteger(input["reasoningTokens"], `${path}.reasoningTokens`, 0, MAX_TOKEN_COUNT),
    toolCalls: ensureSafeInteger(input["toolCalls"], `${path}.toolCalls`, 0, 1_000_000),
    costMicros: ensureNullable(input["costMicros"], (raw) =>
      ensureSafeInteger(raw, `${path}.costMicros`, 0, MAX_COST_MICROS)),
  });
}

export const ZERO_NORMALIZED_USAGE: NormalizedUsage = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  toolCalls: 0,
  costMicros: null,
});

export function parseNormalizedUsage(value: unknown, path = "usage"): NormalizedUsage {
  return parseNormalizedUsageInternal(value, path);
}

function parseArtifactReference(value: unknown, path: string): ArtifactReference {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, ["artifactId", "kind", "sha256"], path);
  return Object.freeze({
    artifactId: parseArtifactId(input["artifactId"], `${path}.artifactId`) as string,
    kind: ensureString(input["kind"], `${path}.kind`, { maxLength: 64, pattern: KIND, patternName: "artifact kind" }),
    sha256: parseSha(input["sha256"], `${path}.sha256`),
  });
}

function parseEvidenceReference(value: unknown, path: string): EvidenceReference {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, ["evidenceId", "kind", "sha256"], path);
  return Object.freeze({
    evidenceId: parseId(input["evidenceId"], `${path}.evidenceId`),
    kind: ensureString(input["kind"], `${path}.kind`, { maxLength: 64, pattern: KIND, patternName: "evidence kind" }),
    sha256: parseSha(input["sha256"], `${path}.sha256`),
  });
}

function parseProviderThreadIdentity(value: unknown, path: string): ProviderThreadIdentity {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, ["providerId", "modelId", "profileId", "threadId", "providerRunId"], path);
  return Object.freeze({
    providerId: parseProviderId(input["providerId"], `${path}.providerId`) as string,
    modelId: parseModelId(input["modelId"], `${path}.modelId`) as string,
    profileId: parseId(input["profileId"], `${path}.profileId`),
    threadId: parseId(input["threadId"], `${path}.threadId`),
    providerRunId: parseId(input["providerRunId"], `${path}.providerRunId`),
  });
}

export function parseTerminalResult(
  value: unknown,
  path = "result",
): OrchestrationTerminalResult {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, [
    "schemaVersion",
    "outcome",
    "artifacts",
    "evidence",
    "usage",
    "startedAt",
    "finishedAt",
    "provider",
    "failure",
    "nonclaims",
  ], path);
  if (input["schemaVersion"] !== ORCHESTRATION_SCHEMA_VERSION) {
    fail(`${path}.schemaVersion`, "unsupported_schema", "must be schema version 1.");
  }
  const artifacts = ensureArray(input["artifacts"], `${path}.artifacts`, 1_000)
    .map((item, index) => parseArtifactReference(item, `${path}.artifacts[${index}]`));
  const evidence = ensureArray(input["evidence"], `${path}.evidence`, 1_000)
    .map((item, index) => parseEvidenceReference(item, `${path}.evidence[${index}]`));
  const startedAt = ensureNullable(input["startedAt"], (raw) => ensureTimestamp(raw, `${path}.startedAt`));
  const finishedAt = ensureTimestamp(input["finishedAt"], `${path}.finishedAt`);
  if (startedAt !== null && startedAt > finishedAt) {
    fail(`${path}.finishedAt`, "backwards_time", "cannot precede startedAt.");
  }
  const failure = ensureNullable(input["failure"], (raw) => {
    const item = ensureRecord(raw, `${path}.failure`);
    ensureExactKeys(item, ["classification", "code", "retryable"], `${path}.failure`);
    return Object.freeze({
      classification: ensureEnum(item["classification"], `${path}.failure.classification`, FAILURE_CLASSIFICATIONS),
      code: ensureString(item["code"], `${path}.failure.code`, { maxLength: 64, pattern: KIND, patternName: "failure code" }),
      retryable: ensureBoolean(item["retryable"], `${path}.failure.retryable`),
    });
  });
  const outcome = ensureEnum(input["outcome"], `${path}.outcome`, ["completed", "failed", "cancelled", "policy-blocked"] as const);
  if ((outcome === "failed" || outcome === "policy-blocked") !== (failure !== null)) {
    fail(`${path}.failure`, "failure_mismatch", "must be present exactly for failed or policy-blocked outcomes.");
  }
  const nonclaims = ensureArray(input["nonclaims"], `${path}.nonclaims`, 32)
    .map((item, index) => ensureString(item, `${path}.nonclaims[${index}]`, { maxLength: 256 }));
  return Object.freeze({
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    outcome,
    artifacts: Object.freeze(artifacts),
    evidence: Object.freeze(evidence),
    usage: parseNormalizedUsageInternal(input["usage"], `${path}.usage`),
    startedAt,
    finishedAt,
    provider: ensureNullable(input["provider"], (raw) => parseProviderThreadIdentity(raw, `${path}.provider`)),
    failure,
    nonclaims: Object.freeze(nonclaims),
  });
}

function parseTaskUnsafe(value: unknown, path: string): OrchestrationTaskEnvelope {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, [
    "schemaVersion",
    "taskId",
    "parentTaskId",
    "correlationId",
    "idempotencyKey",
    "objective",
    "workspace",
    "requestedRoute",
    "capabilities",
    "permissionMode",
    "budget",
    "retry",
    "timeout",
    "expectedResultSchema",
    "priority",
    "createdAt",
    "deadline",
  ], path);
  if (input["schemaVersion"] !== ORCHESTRATION_SCHEMA_VERSION) {
    fail(`${path}.schemaVersion`, "unsupported_schema", "must be schema version 1.");
  }
  const workspaceInput = ensureRecord(input["workspace"], `${path}.workspace`);
  ensureExactKeys(workspaceInput, ["projectId", "workspaceId", "snapshotId", "baseRevision"], `${path}.workspace`);
  const routeInput = ensureRecord(input["requestedRoute"], `${path}.requestedRoute`);
  ensureExactKeys(routeInput, ["providerId", "modelId", "profileId", "ownership"], `${path}.requestedRoute`);
  const providerId = ensureNullable(routeInput["providerId"], (raw) => parseProviderId(raw, `${path}.requestedRoute.providerId`) as string);
  const modelId = ensureNullable(routeInput["modelId"], (raw) => parseModelId(raw, `${path}.requestedRoute.modelId`) as string);
  const profileId = ensureNullable(routeInput["profileId"], (raw) => parseId(raw, `${path}.requestedRoute.profileId`));
  const ownership = ensureNullable(routeInput["ownership"], (raw) => ensureEnum(raw, `${path}.requestedRoute.ownership`, PROFILE_OWNERSHIP_CLASSES));
  const specifiedRouteParts = [providerId, modelId, profileId, ownership].filter((item) => item !== null).length;
  if (specifiedRouteParts !== 0 && specifiedRouteParts !== 4) {
    fail(`${path}.requestedRoute`, "ambiguous_route", "must specify all provider/model/profile/ownership fields or none.");
  }
  const budgetInput = ensureRecord(input["budget"], `${path}.budget`);
  ensureExactKeys(budgetInput, ["maximumInputTokens", "maximumOutputTokens", "maximumCostMicros", "maximumToolCalls", "maximumTurns"], `${path}.budget`);
  const retryInput = ensureRecord(input["retry"], `${path}.retry`);
  ensureExactKeys(retryInput, ["maximumAttempts", "initialBackoffMs", "maximumBackoffMs", "retryableFailures"], `${path}.retry`);
  const initialBackoffMs = ensureSafeInteger(retryInput["initialBackoffMs"], `${path}.retry.initialBackoffMs`, 0, 60_000);
  const maximumBackoffMs = ensureSafeInteger(retryInput["maximumBackoffMs"], `${path}.retry.maximumBackoffMs`, initialBackoffMs, 3_600_000);
  const timeoutInput = ensureRecord(input["timeout"], `${path}.timeout`);
  ensureExactKeys(timeoutInput, ["dispatchMs", "attemptMs"], `${path}.timeout`);
  const createdAt = ensureTimestamp(input["createdAt"], `${path}.createdAt`);
  const deadline = ensureTimestamp(input["deadline"], `${path}.deadline`);
  if (deadline <= createdAt) {
    fail(`${path}.deadline`, "backwards_time", "must be later than createdAt.");
  }
  const parentTaskId = ensureNullable(input["parentTaskId"], (raw) => parseTaskId(raw, `${path}.parentTaskId`) as string);
  const taskId = parseTaskId(input["taskId"], `${path}.taskId`) as string;
  if (parentTaskId === taskId) {
    fail(`${path}.parentTaskId`, "self_parent", "cannot equal taskId.");
  }
  return Object.freeze({
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    taskId,
    parentTaskId,
    correlationId: parseId(input["correlationId"], `${path}.correlationId`),
    idempotencyKey: ensureString(input["idempotencyKey"], `${path}.idempotencyKey`, { maxLength: 256, pattern: IDEMPOTENCY_KEY, patternName: "idempotency key" }),
    objective: ensureString(input["objective"], `${path}.objective`, { maxLength: MAX_OBJECTIVE_CHARACTERS }),
    workspace: Object.freeze({
      projectId: parseProjectId(workspaceInput["projectId"], `${path}.workspace.projectId`) as string,
      workspaceId: parseWorkspaceId(workspaceInput["workspaceId"], `${path}.workspace.workspaceId`) as string,
      snapshotId: parseId(workspaceInput["snapshotId"], `${path}.workspace.snapshotId`),
      baseRevision: ensureString(workspaceInput["baseRevision"], `${path}.workspace.baseRevision`, { maxLength: 64, pattern: REVISION, patternName: "revision" }),
    }),
    requestedRoute: Object.freeze({ providerId, modelId, profileId, ownership }),
    capabilities: ensureEnumArray(input["capabilities"], `${path}.capabilities`, AGENT_CAPABILITIES, AGENT_CAPABILITIES.length),
    permissionMode: ensureEnum(input["permissionMode"], `${path}.permissionMode`, PERMISSION_MODES),
    budget: Object.freeze({
      maximumInputTokens: ensureSafeInteger(budgetInput["maximumInputTokens"], `${path}.budget.maximumInputTokens`, 0, MAX_TOKEN_COUNT),
      maximumOutputTokens: ensureSafeInteger(budgetInput["maximumOutputTokens"], `${path}.budget.maximumOutputTokens`, 0, MAX_TOKEN_COUNT),
      maximumCostMicros: ensureSafeInteger(budgetInput["maximumCostMicros"], `${path}.budget.maximumCostMicros`, 0, MAX_COST_MICROS),
      maximumToolCalls: ensureSafeInteger(budgetInput["maximumToolCalls"], `${path}.budget.maximumToolCalls`, 0, 1_000_000),
      maximumTurns: ensureSafeInteger(budgetInput["maximumTurns"], `${path}.budget.maximumTurns`, 1, 32),
    }),
    retry: Object.freeze({
      maximumAttempts: ensureSafeInteger(retryInput["maximumAttempts"], `${path}.retry.maximumAttempts`, 1, 8),
      initialBackoffMs,
      maximumBackoffMs,
      retryableFailures: ensureEnumArray(retryInput["retryableFailures"], `${path}.retry.retryableFailures`, FAILURE_CLASSIFICATIONS, FAILURE_CLASSIFICATIONS.length),
    }),
    timeout: Object.freeze({
      dispatchMs: ensureSafeInteger(timeoutInput["dispatchMs"], `${path}.timeout.dispatchMs`, 100, 60_000),
      attemptMs: ensureSafeInteger(timeoutInput["attemptMs"], `${path}.timeout.attemptMs`, 100, 86_400_000),
    }),
    expectedResultSchema: parseJsonObject(input["expectedResultSchema"], `${path}.expectedResultSchema`, MAX_EXPECTED_SCHEMA_CHARACTERS),
    priority: ensureEnum(input["priority"], `${path}.priority`, TASK_PRIORITIES),
    createdAt,
    deadline,
  });
}

export function parseOrchestrationTaskEnvelope(
  value: unknown,
  path = "task",
): OrchestrationTaskEnvelope {
  try {
    return parseTaskUnsafe(value, path);
  } catch (error) {
    if (error instanceof SchedulerError) throw error;
    throw new SchedulerError("INVALID_TASK", "The orchestration task envelope is invalid.", {
      cause: error instanceof Error ? error.name : typeof error,
    });
  }
}

export function taskFingerprint(task: OrchestrationTaskEnvelope): string {
  return createHash("sha256").update(toCanonicalJson(task)).digest("hex");
}

export function parseOrchestrationEvent(value: unknown, path = "event"): OrchestrationEvent {
  try {
    const input = ensureRecord(value, path);
    ensureExactKeys(input, ["schemaVersion", "eventId", "taskId", "sequence", "occurredAt", "type", "payload"], path);
    if (input["schemaVersion"] !== ORCHESTRATION_EVENT_SCHEMA_VERSION) {
      fail(`${path}.schemaVersion`, "unsupported_schema", "must be schema version 1.");
    }
    return Object.freeze({
      schemaVersion: ORCHESTRATION_EVENT_SCHEMA_VERSION,
      eventId: parseEventId(input["eventId"], `${path}.eventId`) as string,
      taskId: parseTaskId(input["taskId"], `${path}.taskId`) as string,
      sequence: ensureSafeInteger(input["sequence"], `${path}.sequence`, 1, Number.MAX_SAFE_INTEGER),
      occurredAt: ensureTimestamp(input["occurredAt"], `${path}.occurredAt`),
      type: ensureEnum(input["type"], `${path}.type`, ORCHESTRATION_EVENT_TYPES),
      payload: parseJsonObject(input["payload"], `${path}.payload`, 1_000_000),
    });
  } catch (error) {
    if (error instanceof SchedulerError) throw error;
    throw new SchedulerError("INVALID_EVENT", "The orchestration event is invalid.", {
      cause: error instanceof Error ? error.name : typeof error,
    });
  }
}
