import { toCanonicalJson, validation } from "@ai-dev-os/domain";
import {
  EVALUATION_EVENT_TYPES,
  EVALUATION_PRODUCTION_ENABLED,
  EVALUATION_RUN_STATUSES,
  EVALUATION_SCHEMA_VERSION,
  type EvaluationEvent,
  type EvaluationEventCommand,
  type EvaluationEventType,
  type EvaluationRequest,
  type EvaluationRunSnapshot,
} from "./contracts.js";
import { evaluateDeterministically, parseEvaluationResult } from "./evaluate.js";
import { EvaluationError } from "./errors.js";
import {
  createEvaluationRequest,
  EMPTY_EVALUATION_AUTHORITY_CONFIGURATION,
  EVALUATION_LIMITS,
  evaluationDigest,
  parseEvaluationAuthorityConfiguration,
  parseEvaluationDigest,
  parseEvaluationId,
  parseEvaluationRequest,
  parseFailureCode,
  stableEvaluationId,
} from "./schema.js";

const {
  ensureArray,
  ensureBoolean,
  ensureEnum,
  ensureExactKeys,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
  ensureTimestamp,
} = validation;

export interface EvaluationTransition {
  readonly snapshot: EvaluationRunSnapshot;
  readonly event: EvaluationEvent;
}

function command(
  expectedVersion: number | null,
  failureCode: string | null,
  retryable: boolean | null,
  reasonCode: string | null,
): EvaluationEventCommand {
  return Object.freeze({ expectedVersion, failureCode, retryable, reasonCode });
}

function eventFor(
  previous: EvaluationRunSnapshot | null,
  snapshot: EvaluationRunSnapshot,
  type: EvaluationEventType,
  occurredAt: string,
  eventCommand: EvaluationEventCommand,
): EvaluationEvent {
  const beforeDigest = previous === null ? null : evaluationDigest(previous);
  const afterDigest = evaluationDigest(snapshot);
  return Object.freeze({
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    eventId: stableEvaluationId(
      "evaluation-event",
      snapshot.runId,
      String(snapshot.eventSequence),
      type,
      evaluationDigest(eventCommand),
    ),
    runId: snapshot.runId,
    sequence: snapshot.eventSequence,
    aggregateVersion: snapshot.aggregateVersion,
    type,
    occurredAt,
    beforeDigest,
    afterDigest,
    command: eventCommand,
    snapshot,
  });
}

function ensureMutable(snapshot: EvaluationRunSnapshot, expectedVersion: number): void {
  if (snapshot.aggregateVersion !== expectedVersion) {
    throw new EvaluationError("CONFLICT", "Evaluation run version does not match the expected version.", {
      expectedVersion,
      actualVersion: snapshot.aggregateVersion,
    });
  }
  if (snapshot.status !== "pending") {
    throw new EvaluationError("INVALID_TRANSITION", "Only a pending evaluation run can transition.", {
      status: snapshot.status,
    });
  }
}

function transitionTime(snapshot: EvaluationRunSnapshot, value: unknown, path: string): string {
  const occurredAt = ensureTimestamp(value, path);
  if (occurredAt < snapshot.updatedAt) {
    throw new EvaluationError("INVALID_INPUT", "Evaluation transition time cannot move backwards.");
  }
  return occurredAt;
}

export function createEvaluationRun(
  value: unknown,
  authorityConfigurationValue: unknown = EMPTY_EVALUATION_AUTHORITY_CONFIGURATION,
): EvaluationTransition {
  const request = createEvaluationRequest(value);
  const authorityConfiguration = parseEvaluationAuthorityConfiguration(authorityConfigurationValue);
  const snapshot: EvaluationRunSnapshot = Object.freeze({
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    productionEnabled: EVALUATION_PRODUCTION_ENABLED,
    runId: request.runId,
    aggregateVersion: 1,
    eventSequence: 1,
    status: "pending",
    attemptsUsed: 0,
    request,
    authorityConfiguration,
    result: null,
    lastFailureCode: null,
    createdAt: request.createdAt,
    updatedAt: request.createdAt,
  });
  const acceptedCommand = command(null, null, null, null);
  return Object.freeze({
    snapshot,
    event: eventFor(null, snapshot, "evaluation.accepted", request.createdAt, acceptedCommand),
  });
}

export function completeEvaluationRun(
  value: unknown,
  expectedVersionValue: unknown,
  evaluatedAtValue: unknown,
): EvaluationTransition {
  const previous = parseEvaluationRunSnapshot(value);
  const expectedVersion = ensureSafeInteger(expectedVersionValue, "expectedVersion", 1, Number.MAX_SAFE_INTEGER);
  ensureMutable(previous, expectedVersion);
  const evaluatedAt = transitionTime(previous, evaluatedAtValue, "evaluatedAt");
  const expired = evaluatedAt > previous.request.deadline;
  const snapshot: EvaluationRunSnapshot = Object.freeze({
    ...previous,
    aggregateVersion: previous.aggregateVersion + 1,
    eventSequence: previous.eventSequence + 1,
    status: expired ? "expired" : "completed",
    attemptsUsed: previous.attemptsUsed + 1,
    result: expired ? null : evaluateDeterministically(
      previous.request,
      evaluatedAt,
      previous.authorityConfiguration,
    ),
    lastFailureCode: expired ? "deadline-expired" : null,
    updatedAt: evaluatedAt,
  });
  const completedCommand = command(expectedVersion, null, null, null);
  return Object.freeze({
    snapshot,
    event: eventFor(previous, snapshot, "evaluation.completed", evaluatedAt, completedCommand),
  });
}

export function failEvaluationAttempt(
  value: unknown,
  expectedVersionValue: unknown,
  failureCodeValue: unknown,
  retryableValue: unknown,
  occurredAtValue: unknown,
): EvaluationTransition {
  const previous = parseEvaluationRunSnapshot(value);
  const expectedVersion = ensureSafeInteger(expectedVersionValue, "expectedVersion", 1, Number.MAX_SAFE_INTEGER);
  ensureMutable(previous, expectedVersion);
  const failureCode = parseFailureCode(failureCodeValue, "failureCode");
  const retryable = ensureBoolean(retryableValue, "retryable");
  const occurredAt = transitionTime(previous, occurredAtValue, "occurredAt");
  const attemptsUsed = previous.attemptsUsed + 1;
  const expired = occurredAt > previous.request.deadline;
  const canRetry = retryable && !expired && attemptsUsed < previous.request.maximumAttempts;
  const snapshot: EvaluationRunSnapshot = Object.freeze({
    ...previous,
    aggregateVersion: previous.aggregateVersion + 1,
    eventSequence: previous.eventSequence + 1,
    status: expired ? "expired" : canRetry ? "pending" : "failed",
    attemptsUsed,
    result: null,
    lastFailureCode: expired ? "deadline-expired" : failureCode,
    updatedAt: occurredAt,
  });
  const failedCommand = command(expectedVersion, failureCode, retryable, null);
  return Object.freeze({
    snapshot,
    event: eventFor(previous, snapshot, "evaluation.attempt-failed", occurredAt, failedCommand),
  });
}

export function cancelEvaluationRun(
  value: unknown,
  expectedVersionValue: unknown,
  reasonCodeValue: unknown,
  occurredAtValue: unknown,
): EvaluationTransition {
  const previous = parseEvaluationRunSnapshot(value);
  const expectedVersion = ensureSafeInteger(expectedVersionValue, "expectedVersion", 1, Number.MAX_SAFE_INTEGER);
  ensureMutable(previous, expectedVersion);
  const reasonCode = parseFailureCode(reasonCodeValue, "reasonCode");
  const occurredAt = transitionTime(previous, occurredAtValue, "occurredAt");
  const snapshot: EvaluationRunSnapshot = Object.freeze({
    ...previous,
    aggregateVersion: previous.aggregateVersion + 1,
    eventSequence: previous.eventSequence + 1,
    status: "cancelled",
    result: null,
    lastFailureCode: reasonCode,
    updatedAt: occurredAt,
  });
  const cancelledCommand = command(expectedVersion, null, null, reasonCode);
  return Object.freeze({
    snapshot,
    event: eventFor(previous, snapshot, "evaluation.cancelled", occurredAt, cancelledCommand),
  });
}

export function parseEvaluationRunSnapshot(value: unknown, path = "evaluationRun"): EvaluationRunSnapshot {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, [
    "schemaVersion", "productionEnabled", "runId", "aggregateVersion", "eventSequence", "status",
    "attemptsUsed", "request", "authorityConfiguration", "result", "lastFailureCode", "createdAt", "updatedAt",
  ], path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, EVALUATION_SCHEMA_VERSION);
  if (record["productionEnabled"] !== false) {
    throw new EvaluationError("PRODUCTION_DISABLED", "Evaluation production execution is disabled.");
  }
  const request = parseEvaluationRequest(record["request"], `${path}.request`);
  const authorityConfiguration = parseEvaluationAuthorityConfiguration(
    record["authorityConfiguration"],
    `${path}.authorityConfiguration`,
  );
  const result = record["result"] === null ? null : parseEvaluationResult(record["result"], `${path}.result`);
  const aggregateVersion = ensureSafeInteger(record["aggregateVersion"], `${path}.aggregateVersion`, 1, Number.MAX_SAFE_INTEGER);
  const eventSequence = ensureSafeInteger(record["eventSequence"], `${path}.eventSequence`, 1, Number.MAX_SAFE_INTEGER);
  const status = ensureEnum(record["status"], `${path}.status`, EVALUATION_RUN_STATUSES);
  const attemptsUsed = ensureSafeInteger(record["attemptsUsed"], `${path}.attemptsUsed`, 0, request.maximumAttempts);
  const lastFailureCode = record["lastFailureCode"] === null ? null : parseFailureCode(record["lastFailureCode"], `${path}.lastFailureCode`);
  const createdAt = ensureTimestamp(record["createdAt"], `${path}.createdAt`);
  const updatedAt = ensureTimestamp(record["updatedAt"], `${path}.updatedAt`);
  const snapshot: EvaluationRunSnapshot = Object.freeze({
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    productionEnabled: false,
    runId: parseEvaluationId(record["runId"], `${path}.runId`),
    aggregateVersion,
    eventSequence,
    status,
    attemptsUsed,
    request,
    authorityConfiguration,
    result,
    lastFailureCode,
    createdAt,
    updatedAt,
  });
  if (snapshot.runId !== request.runId || aggregateVersion !== eventSequence || createdAt !== request.createdAt || updatedAt < createdAt) {
    throw new EvaluationError("INVALID_INPUT", "Evaluation snapshot identity, version, or time linkage is inconsistent.");
  }
  if (status === "pending" && result !== null || status === "completed" && result === null ||
      status !== "completed" && result !== null || status === "completed" && lastFailureCode !== null ||
      (status === "failed" || status === "cancelled" || status === "expired") && lastFailureCode === null) {
    throw new EvaluationError("INVALID_INPUT", "Evaluation snapshot terminal projections are inconsistent.");
  }
  if (((status === "pending" || status === "cancelled") && attemptsUsed >= request.maximumAttempts) ||
      ((status === "completed" || status === "failed" || status === "expired") && attemptsUsed === 0)) {
    throw new EvaluationError("INVALID_INPUT", "Evaluation attempt projection is command-impossible.");
  }
  const commandReachableVersion = status === "cancelled" ? attemptsUsed + 2 : attemptsUsed + 1;
  if (aggregateVersion !== commandReachableVersion ||
      status === "pending" && attemptsUsed === 0 && (lastFailureCode !== null || updatedAt !== createdAt) ||
      status === "pending" && attemptsUsed > 0 && lastFailureCode === null ||
      (status === "pending" || status === "completed" || status === "failed") && updatedAt > request.deadline) {
    throw new EvaluationError("INVALID_INPUT", "Evaluation snapshot is not reachable through the bounded command lifecycle.");
  }
  if (result !== null) {
    const expected = evaluateDeterministically(request, result.evaluatedAt, authorityConfiguration);
    if (result.runId !== request.runId || result.requestDigest !== request.requestDigest ||
        result.subjectDigest !== request.subject.subjectDigest ||
        result.authorityConfigurationFingerprint !== authorityConfiguration.configurationFingerprint ||
        toCanonicalJson(result) !== toCanonicalJson(expected)) {
      throw new EvaluationError("INVALID_INPUT", "Evaluation result is not the exact deterministic request projection.");
    }
    if (updatedAt !== result.evaluatedAt) {
      throw new EvaluationError("INVALID_INPUT", "Completed evaluation time must equal the deterministic result time.");
    }
  }
  if (status === "expired" && (updatedAt <= request.deadline || lastFailureCode !== "deadline-expired")) {
    throw new EvaluationError("INVALID_INPUT", "Expired evaluation state is not bound to its deadline.");
  }
  return snapshot;
}

function parseEventCommand(value: unknown, path: string): EvaluationEventCommand {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["expectedVersion", "failureCode", "retryable", "reasonCode"], path);
  return Object.freeze({
    expectedVersion: record["expectedVersion"] === null ? null : ensureSafeInteger(record["expectedVersion"], `${path}.expectedVersion`, 1, Number.MAX_SAFE_INTEGER),
    failureCode: record["failureCode"] === null ? null : parseFailureCode(record["failureCode"], `${path}.failureCode`),
    retryable: record["retryable"] === null ? null : ensureBoolean(record["retryable"], `${path}.retryable`),
    reasonCode: record["reasonCode"] === null ? null : parseFailureCode(record["reasonCode"], `${path}.reasonCode`),
  });
}

export function parseEvaluationEvent(value: unknown, path = "evaluationEvent"): EvaluationEvent {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, [
    "schemaVersion", "eventId", "runId", "sequence", "aggregateVersion", "type", "occurredAt",
    "beforeDigest", "afterDigest", "command", "snapshot",
  ], path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, EVALUATION_SCHEMA_VERSION);
  const snapshot = parseEvaluationRunSnapshot(record["snapshot"], `${path}.snapshot`);
  const event: EvaluationEvent = Object.freeze({
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    eventId: parseEvaluationId(record["eventId"], `${path}.eventId`),
    runId: parseEvaluationId(record["runId"], `${path}.runId`),
    sequence: ensureSafeInteger(record["sequence"], `${path}.sequence`, 1, Number.MAX_SAFE_INTEGER),
    aggregateVersion: ensureSafeInteger(record["aggregateVersion"], `${path}.aggregateVersion`, 1, Number.MAX_SAFE_INTEGER),
    type: ensureEnum(record["type"], `${path}.type`, EVALUATION_EVENT_TYPES),
    occurredAt: ensureTimestamp(record["occurredAt"], `${path}.occurredAt`),
    beforeDigest: record["beforeDigest"] === null ? null : parseEvaluationDigest(record["beforeDigest"], `${path}.beforeDigest`),
    afterDigest: parseEvaluationDigest(record["afterDigest"], `${path}.afterDigest`),
    command: parseEventCommand(record["command"], `${path}.command`),
    snapshot,
  });
  if (event.runId !== snapshot.runId || event.sequence !== snapshot.eventSequence ||
      event.aggregateVersion !== snapshot.aggregateVersion || event.occurredAt !== snapshot.updatedAt ||
      event.afterDigest !== evaluationDigest(snapshot)) {
    throw new EvaluationError("INVALID_INPUT", "Evaluation event envelope is inconsistent with its snapshot.");
  }
  return event;
}

function expectedTransition(previous: EvaluationRunSnapshot | null, event: EvaluationEvent): EvaluationTransition {
  if (event.type === "evaluation.accepted") {
    if (previous !== null || event.command.expectedVersion !== null || event.command.failureCode !== null ||
        event.command.retryable !== null || event.command.reasonCode !== null) {
      throw new EvaluationError("PERSISTENCE_MISMATCH", "Evaluation acceptance event is not the initial command.");
    }
    const request = event.snapshot.request;
    const input = { ...request } as Record<string, unknown>;
    delete input["requestDigest"];
    return createEvaluationRun(input, event.snapshot.authorityConfiguration);
  }
  if (previous === null || event.command.expectedVersion === null) {
    throw new EvaluationError("PERSISTENCE_MISMATCH", "Evaluation journal does not begin with acceptance.");
  }
  switch (event.type) {
    case "evaluation.completed":
      if (event.command.failureCode !== null || event.command.retryable !== null || event.command.reasonCode !== null) throw new EvaluationError("PERSISTENCE_MISMATCH", "Completion command contains unrelated fields.");
      return completeEvaluationRun(previous, event.command.expectedVersion, event.occurredAt);
    case "evaluation.attempt-failed":
      if (event.command.failureCode === null || event.command.retryable === null || event.command.reasonCode !== null) throw new EvaluationError("PERSISTENCE_MISMATCH", "Attempt failure command is incomplete.");
      return failEvaluationAttempt(previous, event.command.expectedVersion, event.command.failureCode, event.command.retryable, event.occurredAt);
    case "evaluation.cancelled":
      if (event.command.failureCode !== null || event.command.retryable !== null || event.command.reasonCode === null) throw new EvaluationError("PERSISTENCE_MISMATCH", "Cancellation command is incomplete.");
      return cancelEvaluationRun(previous, event.command.expectedVersion, event.command.reasonCode, event.occurredAt);
  }
}

export function replayEvaluationEvents(values: readonly unknown[]): EvaluationRunSnapshot {
  let events: readonly unknown[];
  try {
    events = ensureArray(values, "events", EVALUATION_LIMITS.maximumJournalEvents);
  } catch {
    throw new EvaluationError("PERSISTENCE_MISMATCH", "Evaluation journal must contain a bounded nonempty event list.");
  }
  if (events.length === 0) {
    throw new EvaluationError("PERSISTENCE_MISMATCH", "Evaluation journal must contain a bounded nonempty event list.");
  }
  let current: EvaluationRunSnapshot | null = null;
  events.forEach((value, index) => {
    const event = parseEvaluationEvent(value, `events[${index}]`);
    const expected = expectedTransition(current, event);
    if (event.sequence !== index + 1 || event.beforeDigest !== (current === null ? null : evaluationDigest(current)) ||
        toCanonicalJson(event) !== toCanonicalJson(expected.event)) {
      throw new EvaluationError("PERSISTENCE_MISMATCH", "Evaluation journal event is reordered or not command-equivalent.");
    }
    current = expected.snapshot;
  });
  if (current === null) {
    throw new EvaluationError("PERSISTENCE_MISMATCH", "Evaluation journal did not produce a checkpoint.");
  }
  return current;
}

export function eventCommandEquals(left: EvaluationEventCommand, right: EvaluationEventCommand): boolean {
  return toCanonicalJson(left) === toCanonicalJson(right);
}
