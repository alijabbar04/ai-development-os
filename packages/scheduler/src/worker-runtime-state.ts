import { createHash } from "node:crypto";
import {
  canonicalizeJson,
  toCanonicalJson,
  validation,
  type JsonObject,
} from "@ai-dev-os/domain";
import { SchedulerError } from "./errors.js";
import { parseRouteCandidate, routeTask } from "./routing.js";
import {
  parseNormalizedUsage,
  parseOrchestrationTaskEnvelope,
  taskFingerprint,
  ZERO_NORMALIZED_USAGE,
} from "./schema.js";
import {
  FAILURE_CLASSIFICATIONS,
  type NormalizedUsage,
  type SelectedRoute,
} from "./types.js";
import {
  parseCanonicalUsageSnapshot,
  validateUsageFreshness,
  type AllocatableCanonicalUsageSnapshot,
  type NormalizedCanonicalUsageSnapshot,
} from "./usage.js";
import {
  WORKER_RUNTIME_EVENT_SCHEMA_VERSION,
  WORKER_RUNTIME_EVENT_TYPES,
  WORKER_RUNTIME_SCHEMA_VERSION,
  WORKER_WORK_DEFINITION_SCHEMA_VERSION,
  type ProviderCircuitEvidence,
  type RuntimeUsageAdapterBinding,
  type RuntimeDispatchIntent,
  type RuntimeUsageReservation,
  type WorkerLease,
  type WorkerRuntimeEvent,
  type WorkerRuntimeEventType,
  type WorkerRuntimeConfiguration,
  type WorkerRuntimeState,
  type WorkerRuntimeTerminal,
  type WorkerWorkDefinition,
} from "./worker-runtime-types.js";
import {
  isInternalWorkerCancellationCode,
  isInternalWorkerFailureCode,
} from "./worker-runtime-codes.js";

const {
  ensureArray,
  ensureBoolean,
  ensureEnum,
  ensureExactKeys,
  ensureRecord,
  ensureSafeInteger,
  ensureString,
  ensureTimestamp,
  fail,
} = validation;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/;
const KIND = /^[a-z][a-z0-9._-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function id(value: unknown, path: string): string {
  return ensureString(value, path, {
    maxLength: 128,
    pattern: ID,
    patternName: "identifier",
  });
}

function sha(value: unknown, path: string): string {
  return ensureString(value, path, {
    maxLength: 64,
    pattern: SHA256,
    patternName: "lowercase SHA-256",
  });
}

function code(value: unknown, path: string): string {
  return ensureString(value, path, {
    maxLength: 64,
    pattern: KIND,
    patternName: "finite code",
  });
}

function idempotencyKey(value: unknown, path: string): string {
  return ensureString(value, path, {
    maxLength: 256,
    pattern: IDEMPOTENCY_KEY,
    patternName: "idempotency key",
  });
}

export function stableCodeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const ZERO_CUMULATIVE_USAGE: NormalizedUsage = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  toolCalls: 0,
  costMicros: 0,
});

function addSafeUsageValue(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
    throw new SchedulerError(
      "STATE_CORRUPTION",
      "Cumulative usage contains a non-integer value.",
    );
  }
  const total = left + right;
  if (!Number.isSafeInteger(total)) {
    throw new SchedulerError(
      "STATE_CORRUPTION",
      "Cumulative usage exceeds the exact numeric representation bound.",
    );
  }
  return total;
}

export function addNormalizedUsage(
  accumulated: NormalizedUsage,
  attempt: NormalizedUsage,
): NormalizedUsage {
  return Object.freeze({
    inputTokens: addSafeUsageValue(
      accumulated.inputTokens,
      attempt.inputTokens,
    ),
    cachedInputTokens: addSafeUsageValue(
      accumulated.cachedInputTokens,
      attempt.cachedInputTokens,
    ),
    cacheWriteInputTokens: addSafeUsageValue(
      accumulated.cacheWriteInputTokens,
      attempt.cacheWriteInputTokens,
    ),
    outputTokens: addSafeUsageValue(
      accumulated.outputTokens,
      attempt.outputTokens,
    ),
    reasoningTokens: addSafeUsageValue(
      accumulated.reasoningTokens,
      attempt.reasoningTokens,
    ),
    toolCalls: addSafeUsageValue(accumulated.toolCalls, attempt.toolCalls),
    costMicros:
      accumulated.costMicros === null || attempt.costMicros === null
        ? null
        : addSafeUsageValue(accumulated.costMicros, attempt.costMicros),
  });
}

function parseCumulativeUsage(value: unknown, path: string): NormalizedUsage {
  const input = ensureRecord(value, path);
  ensureExactKeys(
    input,
    [
      "inputTokens",
      "cachedInputTokens",
      "cacheWriteInputTokens",
      "outputTokens",
      "reasoningTokens",
      "toolCalls",
      "costMicros",
    ],
    path,
  );
  const costMicros =
    input["costMicros"] === null
      ? null
      : ensureSafeInteger(
          input["costMicros"],
          `${path}.costMicros`,
          0,
          Number.MAX_SAFE_INTEGER,
        );
  return Object.freeze({
    inputTokens: ensureSafeInteger(
      input["inputTokens"],
      `${path}.inputTokens`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    cachedInputTokens: ensureSafeInteger(
      input["cachedInputTokens"],
      `${path}.cachedInputTokens`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    cacheWriteInputTokens: ensureSafeInteger(
      input["cacheWriteInputTokens"],
      `${path}.cacheWriteInputTokens`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    outputTokens: ensureSafeInteger(
      input["outputTokens"],
      `${path}.outputTokens`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    reasoningTokens: ensureSafeInteger(
      input["reasoningTokens"],
      `${path}.reasoningTokens`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    toolCalls: ensureSafeInteger(
      input["toolCalls"],
      `${path}.toolCalls`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    costMicros,
  });
}

function valuesWithinLimit(
  values: readonly number[],
  maximum: number,
): boolean {
  let remaining = maximum;
  for (const value of values) {
    if (value > remaining) return false;
    remaining -= value;
  }
  return true;
}

export function parseWorkerRuntimeConfiguration(
  value: unknown,
  path = "configuration",
): WorkerRuntimeConfiguration {
  const configuration = ensureRecord(value, path);
  ensureExactKeys(
    configuration,
    [
      "maximumQueueDepth",
      "maximumRetainedWorkItems",
      "leaseDurationMs",
      "maximumLeaseRenewalsPerAttempt",
      "usageReadTimeoutMs",
      "usageFreshnessMs",
      "circuitFreshnessMs",
      "starvationAgingMs",
      "capacityPools",
    ],
    path,
  );
  const capacityPools = ensureArray(
    configuration["capacityPools"],
    `${path}.capacityPools`,
    64,
  )
    .map((value, index) => {
      const pool = ensureRecord(value, `${path}.capacityPools[${index}]`);
      ensureExactKeys(
        pool,
        ["poolId", "maximumActive"],
        `${path}.capacityPools[${index}]`,
      );
      return Object.freeze({
        poolId: id(pool["poolId"], `${path}.capacityPools[${index}].poolId`),
        maximumActive: ensureSafeInteger(
          pool["maximumActive"],
          `${path}.capacityPools[${index}].maximumActive`,
          1,
          1_000,
        ),
      });
    })
    .sort((left, right) => stableCodeUnitCompare(left.poolId, right.poolId));
  if (
    capacityPools.length === 0 ||
    new Set(capacityPools.map((pool) => pool.poolId)).size !==
      capacityPools.length
  ) {
    throw new SchedulerError(
      "INVALID_TASK",
      "Capacity pool identifiers must be nonempty and unique.",
    );
  }
  return Object.freeze({
    maximumQueueDepth: ensureSafeInteger(
      configuration["maximumQueueDepth"],
      `${path}.maximumQueueDepth`,
      1,
      100_000,
    ),
    maximumRetainedWorkItems: ensureSafeInteger(
      configuration["maximumRetainedWorkItems"],
      `${path}.maximumRetainedWorkItems`,
      1,
      10_000,
    ),
    leaseDurationMs: ensureSafeInteger(
      configuration["leaseDurationMs"],
      `${path}.leaseDurationMs`,
      100,
      86_400_000,
    ),
    maximumLeaseRenewalsPerAttempt: ensureSafeInteger(
      configuration["maximumLeaseRenewalsPerAttempt"],
      `${path}.maximumLeaseRenewalsPerAttempt`,
      0,
      10_000,
    ),
    usageReadTimeoutMs: ensureSafeInteger(
      configuration["usageReadTimeoutMs"],
      `${path}.usageReadTimeoutMs`,
      10,
      60_000,
    ),
    usageFreshnessMs: ensureSafeInteger(
      configuration["usageFreshnessMs"],
      `${path}.usageFreshnessMs`,
      1,
      86_400_000,
    ),
    circuitFreshnessMs: ensureSafeInteger(
      configuration["circuitFreshnessMs"],
      `${path}.circuitFreshnessMs`,
      1,
      86_400_000,
    ),
    starvationAgingMs: ensureSafeInteger(
      configuration["starvationAgingMs"],
      `${path}.starvationAgingMs`,
      1,
      86_400_000,
    ),
    capacityPools: Object.freeze(capacityPools),
  });
}

export function parseRuntimeUsageAdapterBinding(
  value: unknown,
  path = "usageAdapter",
): RuntimeUsageAdapterBinding {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, ["adapterId", "schemaVersion"], path);
  const schemaVersion = input["schemaVersion"];
  if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3) {
    throw new SchedulerError(
      "INVALID_TASK",
      "The usage adapter schema version is unsupported.",
    );
  }
  return Object.freeze({
    adapterId: id(input["adapterId"], `${path}.adapterId`),
    schemaVersion,
  });
}

function selectedRoute(definition: WorkerWorkDefinition): SelectedRoute {
  return Object.freeze({
    candidateId: definition.candidate.candidateId,
    providerId: definition.candidate.providerId,
    modelId: definition.candidate.modelId,
    profileId: definition.candidate.profileId,
    ownership: definition.candidate.ownership,
  });
}

function assertUsageSnapshotForEvent(
  state: WorkerRuntimeState,
  rawSnapshot: unknown,
  snapshot: NormalizedCanonicalUsageSnapshot,
  circuit: ProviderCircuitEvidence,
  event: WorkerRuntimeEvent,
): asserts snapshot is AllocatableCanonicalUsageSnapshot {
  const snapshotRecord = ensureRecord(rawSnapshot, "event.usageSnapshot");
  const now = new Date(event.occurredAt);
  const validity = validateUsageFreshness(
    snapshot,
    now,
    state.configuration.usageFreshnessMs,
  );
  const candidate = state.definition.candidate;
  const decision = routeTask({
    task: state.definition.task,
    workloadClass: state.definition.workloadClass,
    preference: "balanced",
    candidates: [candidate],
    usageSnapshots: [snapshot],
    now,
    maximumSnapshotAgeMs: state.configuration.usageFreshnessMs,
  });
  if (
    !validity.eligible ||
    snapshot.fiveHour.status !== "active" ||
    snapshot.weekly.status !== "active" ||
    state.usageAdapter.schemaVersion !== 3 ||
    snapshotRecord["schemaVersion"] !== 3 ||
    snapshot.sourceAdapterId !== state.usageAdapter.adapterId ||
    snapshot.profileId !== state.definition.candidate.profileId ||
    snapshot.providerId !== state.definition.candidate.providerId ||
    snapshot.ownership !== state.definition.candidate.ownership ||
    circuit.providerId !== state.definition.candidate.providerId ||
    circuit.profileId !== state.definition.candidate.profileId ||
    circuit.state !== "closed" ||
    circuit.observedAt > event.occurredAt ||
    Date.parse(event.occurredAt) - Date.parse(circuit.observedAt) >
      state.configuration.circuitFreshnessMs ||
    decision.selected?.candidateId !== candidate.candidateId
  ) {
    throw new SchedulerError(
      "INVALID_EVENT",
      "Usage and circuit evidence cannot authorize the exact event route.",
    );
  }
}

function assertUsageSnapshotMonotonic(
  previous: NormalizedCanonicalUsageSnapshot,
  next: NormalizedCanonicalUsageSnapshot,
  message: string,
): void {
  if (
    previous.fiveHour.status !== "active" ||
    previous.weekly.status !== "active" ||
    next.fiveHour.status !== "active" ||
    next.weekly.status !== "active" ||
    next.sourceAdapterVersion !== previous.sourceAdapterVersion ||
    next.sourceFingerprint !== previous.sourceFingerprint ||
    next.fiveHour.windowId !== previous.fiveHour.windowId ||
    next.fiveHour.resetAt !== previous.fiveHour.resetAt ||
    next.weekly.windowId !== previous.weekly.windowId ||
    next.weekly.resetAt !== previous.weekly.resetAt ||
    next.observedAt < previous.observedAt ||
    next.fiveHour.usedBasisPoints < previous.fiveHour.usedBasisPoints ||
    next.weekly.usedBasisPoints < previous.weekly.usedBasisPoints
  ) {
    throw new SchedulerError("INVALID_EVENT", message);
  }
}

export function usageWithinTaskBudget(
  definition: WorkerWorkDefinition,
  usage: NormalizedUsage,
): boolean {
  const budget = definition.task.budget;
  return (
    valuesWithinLimit(
      [usage.inputTokens, usage.cachedInputTokens, usage.cacheWriteInputTokens],
      budget.maximumInputTokens,
    ) &&
    valuesWithinLimit(
      [usage.outputTokens, usage.reasoningTokens],
      budget.maximumOutputTokens,
    ) &&
    usage.toolCalls <= budget.maximumToolCalls &&
    (usage.costMicros === null || usage.costMicros <= budget.maximumCostMicros)
  );
}

export function parseWorkerWorkDefinition(
  value: unknown,
  path = "definition",
): WorkerWorkDefinition {
  try {
    const input = ensureRecord(value, path);
    ensureExactKeys(
      input,
      [
        "schemaVersion",
        "workId",
        "task",
        "candidate",
        "workloadClass",
        "capacityPool",
        "fairnessKey",
        "readyAt",
        "estimatedUsage",
      ],
      path,
    );
    if (input["schemaVersion"] !== WORKER_WORK_DEFINITION_SCHEMA_VERSION) {
      fail(
        `${path}.schemaVersion`,
        "unsupported_schema",
        "must be schema version 1.",
      );
    }
    const task = parseOrchestrationTaskEnvelope(input["task"], `${path}.task`);
    const candidate = parseRouteCandidate(
      input["candidate"],
      `${path}.candidate`,
    );
    const requested = task.requestedRoute;
    if (
      requested.providerId !== null &&
      (requested.providerId !== candidate.providerId ||
        requested.modelId !== candidate.modelId ||
        requested.profileId !== candidate.profileId ||
        requested.ownership !== candidate.ownership)
    ) {
      fail(
        `${path}.candidate`,
        "route_mismatch",
        "must equal the task's exact requested route.",
      );
    }
    const readyAt = ensureTimestamp(input["readyAt"], `${path}.readyAt`);
    if (readyAt < task.createdAt || readyAt >= task.deadline) {
      fail(
        `${path}.readyAt`,
        "invalid_ready_time",
        "must fall within the task window.",
      );
    }
    const definition: WorkerWorkDefinition = Object.freeze({
      schemaVersion: WORKER_WORK_DEFINITION_SCHEMA_VERSION,
      workId: id(input["workId"], `${path}.workId`),
      task,
      candidate,
      workloadClass: ensureEnum(
        input["workloadClass"],
        `${path}.workloadClass`,
        ["general", "fable"] as const,
      ),
      capacityPool: id(input["capacityPool"], `${path}.capacityPool`),
      fairnessKey: id(input["fairnessKey"], `${path}.fairnessKey`),
      readyAt,
      estimatedUsage: parseNormalizedUsage(
        input["estimatedUsage"],
        `${path}.estimatedUsage`,
      ),
    });
    if (
      definition.estimatedUsage.costMicros === null ||
      !usageWithinTaskBudget(definition, definition.estimatedUsage)
    ) {
      fail(
        `${path}.estimatedUsage`,
        "budget_exceeded",
        "must have known cost and cannot exceed the task budget.",
      );
    }
    return definition;
  } catch (error) {
    if (error instanceof SchedulerError) throw error;
    throw new SchedulerError(
      "INVALID_TASK",
      "The worker work definition is invalid.",
      {
        cause: error instanceof Error ? error.name : typeof error,
      },
    );
  }
}

export function workerDefinitionFingerprint(
  definition: WorkerWorkDefinition,
): string {
  return createHash("sha256").update(toCanonicalJson(definition)).digest("hex");
}

export function parseProviderCircuitEvidence(
  value: unknown,
  path = "circuit",
): ProviderCircuitEvidence {
  const input = ensureRecord(value, path);
  ensureExactKeys(
    input,
    [
      "schemaVersion",
      "evidenceId",
      "providerId",
      "profileId",
      "state",
      "observedAt",
      "sourceFingerprint",
    ],
    path,
  );
  if (input["schemaVersion"] !== 1) {
    fail(
      `${path}.schemaVersion`,
      "unsupported_schema",
      "must be schema version 1.",
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    evidenceId: id(input["evidenceId"], `${path}.evidenceId`),
    providerId: id(input["providerId"], `${path}.providerId`),
    profileId: id(input["profileId"], `${path}.profileId`),
    state: ensureEnum(input["state"], `${path}.state`, [
      "closed",
      "open",
      "half-open",
    ] as const),
    observedAt: ensureTimestamp(input["observedAt"], `${path}.observedAt`),
    sourceFingerprint: sha(
      input["sourceFingerprint"],
      `${path}.sourceFingerprint`,
    ),
  });
}

function parseLease(value: unknown, path: string): WorkerLease {
  const input = ensureRecord(value, path);
  ensureExactKeys(
    input,
    [
      "leaseId",
      "workerId",
      "fencingToken",
      "acquiredAt",
      "heartbeatAt",
      "expiresAt",
    ],
    path,
  );
  const acquiredAt = ensureTimestamp(input["acquiredAt"], `${path}.acquiredAt`);
  const heartbeatAt = ensureTimestamp(
    input["heartbeatAt"],
    `${path}.heartbeatAt`,
  );
  const expiresAt = ensureTimestamp(input["expiresAt"], `${path}.expiresAt`);
  if (heartbeatAt < acquiredAt || expiresAt <= heartbeatAt) {
    fail(path, "invalid_lease_time", "lease times are inconsistent.");
  }
  return Object.freeze({
    leaseId: id(input["leaseId"], `${path}.leaseId`),
    workerId: id(input["workerId"], `${path}.workerId`),
    fencingToken: ensureSafeInteger(
      input["fencingToken"],
      `${path}.fencingToken`,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    acquiredAt,
    heartbeatAt,
    expiresAt,
  });
}

function parseReservation(
  value: unknown,
  path: string,
): RuntimeUsageReservation {
  const input = ensureRecord(value, path);
  ensureExactKeys(
    input,
    [
      "reservationId",
      "snapshotId",
      "sourceAdapterVersion",
      "sourceFingerprint",
      "observedAt",
      "fiveHourWindowId",
      "fiveHourResetAt",
      "weeklyWindowId",
      "weeklyResetAt",
      "usedFiveHourBasisPoints",
      "usedWeeklyBasisPoints",
      "predictedFiveHourBasisPoints",
      "predictedWeeklyBasisPoints",
      "estimatedUsage",
      "circuit",
      "reservedAt",
      "status",
      "actualUsage",
      "reconciledAt",
    ],
    path,
  );
  const status = ensureEnum(input["status"], `${path}.status`, [
    "reserved",
    "reconciliation-required",
    "reconciled",
    "released",
  ] as const);
  const actualUsage =
    input["actualUsage"] === null
      ? null
      : parseNormalizedUsage(input["actualUsage"], `${path}.actualUsage`);
  const reconciledAt =
    input["reconciledAt"] === null
      ? null
      : ensureTimestamp(input["reconciledAt"], `${path}.reconciledAt`);
  if (
    ((status === "reserved" || status === "reconciliation-required") &&
      (actualUsage !== null || reconciledAt !== null)) ||
    ((status === "reconciled" || status === "released") &&
      (actualUsage === null || reconciledAt === null))
  ) {
    fail(
      path,
      "reservation_state_mismatch",
      "reservation terminal fields are inconsistent.",
    );
  }
  return Object.freeze({
    reservationId: id(input["reservationId"], `${path}.reservationId`),
    snapshotId: id(input["snapshotId"], `${path}.snapshotId`),
    sourceAdapterVersion: id(
      input["sourceAdapterVersion"],
      `${path}.sourceAdapterVersion`,
    ),
    sourceFingerprint: sha(
      input["sourceFingerprint"],
      `${path}.sourceFingerprint`,
    ),
    observedAt: ensureTimestamp(input["observedAt"], `${path}.observedAt`),
    fiveHourWindowId: id(input["fiveHourWindowId"], `${path}.fiveHourWindowId`),
    fiveHourResetAt: ensureTimestamp(
      input["fiveHourResetAt"],
      `${path}.fiveHourResetAt`,
    ),
    weeklyWindowId: id(input["weeklyWindowId"], `${path}.weeklyWindowId`),
    weeklyResetAt: ensureTimestamp(
      input["weeklyResetAt"],
      `${path}.weeklyResetAt`,
    ),
    usedFiveHourBasisPoints: ensureSafeInteger(
      input["usedFiveHourBasisPoints"],
      `${path}.usedFiveHourBasisPoints`,
      0,
      10_000,
    ),
    usedWeeklyBasisPoints: ensureSafeInteger(
      input["usedWeeklyBasisPoints"],
      `${path}.usedWeeklyBasisPoints`,
      0,
      10_000,
    ),
    predictedFiveHourBasisPoints: ensureSafeInteger(
      input["predictedFiveHourBasisPoints"],
      `${path}.predictedFiveHourBasisPoints`,
      0,
      10_000,
    ),
    predictedWeeklyBasisPoints: ensureSafeInteger(
      input["predictedWeeklyBasisPoints"],
      `${path}.predictedWeeklyBasisPoints`,
      0,
      10_000,
    ),
    estimatedUsage: parseNormalizedUsage(
      input["estimatedUsage"],
      `${path}.estimatedUsage`,
    ),
    circuit: parseProviderCircuitEvidence(input["circuit"], `${path}.circuit`),
    reservedAt: ensureTimestamp(input["reservedAt"], `${path}.reservedAt`),
    status,
    actualUsage,
    reconciledAt,
  });
}

function parseSelectedRoute(value: unknown, path: string): SelectedRoute {
  const input = ensureRecord(value, path);
  ensureExactKeys(
    input,
    ["candidateId", "providerId", "modelId", "profileId", "ownership"],
    path,
  );
  return Object.freeze({
    candidateId: id(input["candidateId"], `${path}.candidateId`),
    providerId: id(input["providerId"], `${path}.providerId`),
    modelId: id(input["modelId"], `${path}.modelId`),
    profileId: id(input["profileId"], `${path}.profileId`),
    ownership: ensureEnum(input["ownership"], `${path}.ownership`, [
      "owned",
      "authorized-borrowed",
    ] as const),
  });
}

function parseDispatch(value: unknown, path: string): RuntimeDispatchIntent {
  const input = ensureRecord(value, path);
  ensureExactKeys(
    input,
    [
      "dispatchId",
      "route",
      "reservationId",
      "usageSnapshotId",
      "circuit",
      "requestFingerprint",
      "preparedAt",
      "status",
      "startedAt",
      "terminalAt",
    ],
    path,
  );
  const status = ensureEnum(input["status"], `${path}.status`, [
    "prepared",
    "started",
    "terminal",
  ] as const);
  const startedAt =
    input["startedAt"] === null
      ? null
      : ensureTimestamp(input["startedAt"], `${path}.startedAt`);
  const terminalAt =
    input["terminalAt"] === null
      ? null
      : ensureTimestamp(input["terminalAt"], `${path}.terminalAt`);
  if (
    (status === "prepared" && (startedAt !== null || terminalAt !== null)) ||
    (status === "started" && (startedAt === null || terminalAt !== null)) ||
    (status === "terminal" && terminalAt === null)
  ) {
    fail(
      path,
      "dispatch_state_mismatch",
      "dispatch terminal fields are inconsistent.",
    );
  }
  return Object.freeze({
    dispatchId: id(input["dispatchId"], `${path}.dispatchId`),
    route: parseSelectedRoute(input["route"], `${path}.route`),
    reservationId: id(input["reservationId"], `${path}.reservationId`),
    usageSnapshotId: id(input["usageSnapshotId"], `${path}.usageSnapshotId`),
    circuit: parseProviderCircuitEvidence(input["circuit"], `${path}.circuit`),
    requestFingerprint: sha(
      input["requestFingerprint"],
      `${path}.requestFingerprint`,
    ),
    preparedAt: ensureTimestamp(input["preparedAt"], `${path}.preparedAt`),
    status,
    startedAt,
    terminalAt,
  });
}

function parseTerminal(value: unknown, path: string): WorkerRuntimeTerminal {
  const input = ensureRecord(value, path);
  ensureExactKeys(
    input,
    ["outcome", "code", "classification", "actualUsage", "finishedAt"],
    path,
  );
  const outcome = ensureEnum(input["outcome"], `${path}.outcome`, [
    "completed",
    "failed",
    "cancelled",
  ] as const);
  const classification =
    input["classification"] === null
      ? null
      : ensureEnum(
          input["classification"],
          `${path}.classification`,
          FAILURE_CLASSIFICATIONS,
        );
  if ((outcome === "failed") !== (classification !== null)) {
    fail(
      path,
      "terminal_classification_mismatch",
      "failure classification is inconsistent.",
    );
  }
  return Object.freeze({
    outcome,
    code: code(input["code"], `${path}.code`),
    classification,
    actualUsage: parseCumulativeUsage(
      input["actualUsage"],
      `${path}.actualUsage`,
    ),
    finishedAt: ensureTimestamp(input["finishedAt"], `${path}.finishedAt`),
  });
}

function exactPayload(
  event: WorkerRuntimeEvent,
  keys: readonly string[],
): Record<string, unknown> {
  const payload = ensureRecord(event.payload, `event.${event.type}.payload`);
  ensureExactKeys(payload, keys, `event.${event.type}.payload`);
  return payload;
}

function exactCommand(
  event: WorkerRuntimeEvent,
  type: string,
  keys: readonly string[],
  schedulerOwnedOverride = false,
): Record<string, unknown> {
  const command = ensureRecord(event.command, `event.${event.type}.command`);
  ensureExactKeys(
    command,
    ["type", "commandId", ...keys],
    `event.${event.type}.command`,
  );
  const commandId = id(
    command["commandId"],
    `event.${event.type}.command.commandId`,
  );
  const schedulerOwned =
    schedulerOwnedOverride ||
    type === "lease-expired" ||
    type === "retry-ready" ||
    type === "deadline-expired" ||
    type === "lease-exhausted";
  if (
    command["type"] !== type ||
    commandId !== event.commandId ||
    commandId.startsWith("tick:") !== schedulerOwned
  ) {
    throw new SchedulerError(
      "INVALID_EVENT",
      "The worker event is bound to the wrong command type or identity.",
    );
  }
  return command;
}

export function workerTickCommandId(
  definitionFingerprint: string,
  occurredAt: string,
  priorSequence: number,
): string {
  return `tick:${createHash("sha256")
    .update(`${definitionFingerprint}|${occurredAt}|${priorSequence}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function assertTickCommandIdentity(
  state: WorkerRuntimeState,
  event: WorkerRuntimeEvent,
): void {
  if (
    event.commandId !==
    workerTickCommandId(
      state.definitionFingerprint,
      event.occurredAt,
      state.sequence,
    )
  ) {
    throw new SchedulerError(
      "INVALID_EVENT",
      "The scheduler-owned transition has an invalid deterministic command identity.",
    );
  }
}

function assertFencedEventCommand(
  state: WorkerRuntimeState,
  event: WorkerRuntimeEvent,
  type: string,
  extraKeys: readonly string[] = [],
  schedulerOwned = false,
): Record<string, unknown> {
  const command = exactCommand(
    event,
    type,
    ["idempotencyKey", "leaseId", "workerId", "fencingToken", ...extraKeys],
    schedulerOwned,
  );
  if (
    idempotencyKey(
      command["idempotencyKey"],
      `event.${event.type}.command.idempotencyKey`,
    ) !== state.definition.task.idempotencyKey ||
    state.lease === null ||
    id(command["leaseId"], `event.${event.type}.command.leaseId`) !==
      state.lease.leaseId ||
    id(command["workerId"], `event.${event.type}.command.workerId`) !==
      state.lease.workerId ||
    ensureSafeInteger(
      command["fencingToken"],
      `event.${event.type}.command.fencingToken`,
      1,
      Number.MAX_SAFE_INTEGER,
    ) !== state.lease.fencingToken
  ) {
    throw new SchedulerError(
      "INVALID_EVENT",
      "The event command is not bound to the exact current work fence.",
    );
  }
  return command;
}

function assertCompleteEventCommand(
  state: WorkerRuntimeState,
  event: WorkerRuntimeEvent,
  actualUsage: NormalizedUsage,
): void {
  const command = assertFencedEventCommand(state, event, "complete-work", [
    "dispatchId",
    "actualUsage",
  ]);
  if (
    state.dispatch === null ||
    id(command["dispatchId"], `event.${event.type}.command.dispatchId`) !==
      state.dispatch.dispatchId ||
    !same(
      parseNormalizedUsage(
        command["actualUsage"],
        `event.${event.type}.command.actualUsage`,
      ),
      actualUsage,
    )
  ) {
    throw new SchedulerError(
      "INVALID_EVENT",
      "Completion command evidence does not match its terminal projection.",
    );
  }
}

function assertFailEventCommand(
  state: WorkerRuntimeState,
  event: WorkerRuntimeEvent,
  expected: {
    readonly classification: string;
    readonly code: string;
    readonly retryable: boolean | null;
    readonly actualUsage: NormalizedUsage;
  },
  schedulerOwned = false,
): boolean {
  const command = assertFencedEventCommand(
    state,
    event,
    "fail-work",
    ["dispatchId", "classification", "code", "retryable", "actualUsage"],
    schedulerOwned,
  );
  const dispatchId =
    command["dispatchId"] === null
      ? null
      : id(command["dispatchId"], `event.${event.type}.command.dispatchId`);
  const classification = ensureEnum(
    command["classification"],
    `event.${event.type}.command.classification`,
    FAILURE_CLASSIFICATIONS,
  );
  const requestedRetryable = ensureBoolean(
    command["retryable"],
    `event.${event.type}.command.retryable`,
  );
  if (
    dispatchId !== (state.dispatch?.dispatchId ?? null) ||
    classification !== expected.classification ||
    code(command["code"], `event.${event.type}.command.code`) !==
      expected.code ||
    (expected.retryable !== null &&
      requestedRetryable !== expected.retryable) ||
    !same(
      parseNormalizedUsage(
        command["actualUsage"],
        `event.${event.type}.command.actualUsage`,
      ),
      expected.actualUsage,
    )
  ) {
    throw new SchedulerError(
      "INVALID_EVENT",
      "Failure command evidence does not match its failure projection.",
    );
  }
  return requestedRetryable;
}

function same(left: unknown, right: unknown): boolean {
  return toCanonicalJson(left) === toCanonicalJson(right);
}

function deterministicId(prefix: string, material: unknown): string {
  return `${prefix}:${createHash("sha256")
    .update(toCanonicalJson(material))
    .digest("hex")
    .slice(0, 32)}`;
}

function sameReservationIdentity(
  previous: RuntimeUsageReservation,
  next: RuntimeUsageReservation,
): boolean {
  const dynamic = new Set(["status", "actualUsage", "reconciledAt"]);
  return same(
    Object.fromEntries(
      Object.entries(previous).filter(([key]) => !dynamic.has(key)),
    ),
    Object.fromEntries(
      Object.entries(next).filter(([key]) => !dynamic.has(key)),
    ),
  );
}

function sameDispatchIdentity(
  previous: RuntimeDispatchIntent,
  next: RuntimeDispatchIntent,
): boolean {
  const dynamic = new Set(["status", "terminalAt"]);
  return same(
    Object.fromEntries(
      Object.entries(previous).filter(([key]) => !dynamic.has(key)),
    ),
    Object.fromEntries(
      Object.entries(next).filter(([key]) => !dynamic.has(key)),
    ),
  );
}

function assertLeaseActive(
  state: WorkerRuntimeState,
  event: WorkerRuntimeEvent,
): WorkerLease {
  if (
    state.lease === null ||
    state.lease.expiresAt <= event.occurredAt ||
    state.definition.task.deadline <= event.occurredAt
  ) {
    throw new SchedulerError(
      "INVALID_EVENT",
      "An active unexpired lease within the task deadline is required.",
    );
  }
  return state.lease;
}

function withEvent(
  state: WorkerRuntimeState,
  event: WorkerRuntimeEvent,
  update: Partial<WorkerRuntimeState>,
): WorkerRuntimeState {
  return Object.freeze({
    ...state,
    ...update,
    sequence: event.sequence,
    lastEventId: event.eventId,
    lastOccurredAt: event.occurredAt,
  });
}

function baseState(event: WorkerRuntimeEvent): WorkerRuntimeState {
  if (event.type !== "work.enqueued" || event.sequence !== 1) {
    throw new SchedulerError(
      "INVALID_TRANSITION",
      "The first worker event must enqueue work.",
    );
  }
  const payload = exactPayload(event, [
    "definition",
    "definitionFingerprint",
    "configuration",
    "usageAdapter",
    "configurationFingerprint",
  ]);
  const definition = parseWorkerWorkDefinition(payload["definition"]);
  const configuration = parseWorkerRuntimeConfiguration(
    payload["configuration"],
    "event.work.enqueued.payload.configuration",
  );
  const usageAdapter = parseRuntimeUsageAdapterBinding(
    payload["usageAdapter"],
    "event.work.enqueued.payload.usageAdapter",
  );
  const command = exactCommand(event, "enqueue-work", ["definition"]);
  const commandDefinition = parseWorkerWorkDefinition(
    command["definition"],
    "event.work.enqueued.command.definition",
  );
  const fingerprint = sha(
    payload["definitionFingerprint"],
    "event.work.enqueued.payload.definitionFingerprint",
  );
  const configurationFingerprint = sha(
    payload["configurationFingerprint"],
    "event.work.enqueued.payload.configurationFingerprint",
  );
  if (
    fingerprint !== workerDefinitionFingerprint(definition) ||
    !same(commandDefinition, definition) ||
    configurationFingerprint !==
      createHash("sha256")
        .update(toCanonicalJson({ configuration, usageAdapter }))
        .digest("hex") ||
    !configuration.capacityPools.some(
      (pool) => pool.poolId === definition.capacityPool,
    ) ||
    definition.workId !== event.workId ||
    event.occurredAt < definition.task.createdAt
  ) {
    throw new SchedulerError(
      "STATE_CORRUPTION",
      "The enqueued work identity is inconsistent.",
    );
  }
  return Object.freeze({
    schemaVersion: WORKER_RUNTIME_SCHEMA_VERSION,
    configuration,
    usageAdapter,
    configurationFingerprint,
    definition,
    definitionFingerprint: fingerprint,
    status: "ready",
    sequence: 1,
    lastEventId: event.eventId,
    lastOccurredAt: event.occurredAt,
    attempt: 0,
    cumulativeUsage: ZERO_CUMULATIVE_USAGE,
    lastFencingToken: 0,
    leaseRenewals: 0,
    lease: null,
    reservation: null,
    latestUsageSnapshot: null,
    dispatch: null,
    readySince: definition.readyAt,
    nextReadyAt: null,
    terminal: null,
  });
}

export function applyWorkerRuntimeEvent(
  state: WorkerRuntimeState,
  rawEvent: WorkerRuntimeEvent,
): WorkerRuntimeState {
  const event = parseWorkerRuntimeEvent(rawEvent);
  if ((state.status === "ready") !== (state.readySince !== null)) {
    throw new SchedulerError(
      "STATE_CORRUPTION",
      "Ready-queue aging state is inconsistent.",
    );
  }
  if (
    event.workId !== state.definition.workId ||
    event.sequence !== state.sequence + 1 ||
    event.occurredAt < state.lastOccurredAt
  ) {
    throw new SchedulerError(
      "INVALID_EVENT",
      "Worker event identity, sequence, or time is inconsistent.",
    );
  }
  if (
    ["completed", "failed", "cancelled"].includes(state.status) &&
    event.type !== "usage.reconciled"
  ) {
    throw new SchedulerError(
      "DUPLICATE_TERMINAL",
      "No event may follow terminal worker state.",
    );
  }
  switch (event.type) {
    case "work.enqueued":
      throw new SchedulerError(
        "INVALID_TRANSITION",
        "Work may be enqueued only once.",
      );
    case "lease.acquired": {
      if (state.status !== "ready" || state.lease !== null) {
        throw new SchedulerError(
          "INVALID_TRANSITION",
          "Only ready unleased work may be acquired.",
        );
      }
      const payload = exactPayload(event, ["lease"]);
      const lease = parseLease(
        payload["lease"],
        "event.lease.acquired.payload.lease",
      );
      const command = exactCommand(event, "claim-work", [
        "workerId",
        "allowedCapacityPools",
      ]);
      const allowedCapacityPools = ensureArray(
        command["allowedCapacityPools"],
        "event.lease.acquired.command.allowedCapacityPools",
        64,
      ).map((pool, index) =>
        id(pool, `event.lease.acquired.command.allowedCapacityPools[${index}]`),
      );
      if (
        lease.leaseId !==
          deterministicId("lease", {
            definitionFingerprint: state.definitionFingerprint,
            workerId: lease.workerId,
            attempt: state.attempt + 1,
            fencingToken: lease.fencingToken,
            commandId: event.commandId,
          }) ||
        lease.acquiredAt !== event.occurredAt ||
        lease.heartbeatAt !== event.occurredAt ||
        lease.expiresAt !==
          new Date(
            Math.min(
              Date.parse(event.occurredAt) +
                state.configuration.leaseDurationMs,
              Date.parse(event.occurredAt) +
                state.definition.task.timeout.dispatchMs,
              Date.parse(event.occurredAt) +
                state.definition.task.timeout.attemptMs,
              Date.parse(state.definition.task.deadline),
            ),
          ).toISOString() ||
        lease.fencingToken !== state.lastFencingToken + 1 ||
        state.attempt >= state.definition.task.retry.maximumAttempts ||
        state.definition.readyAt > event.occurredAt ||
        state.definition.task.deadline <= event.occurredAt ||
        id(command["workerId"], "event.lease.acquired.command.workerId") !==
          lease.workerId ||
        allowedCapacityPools.length === 0 ||
        new Set(allowedCapacityPools).size !== allowedCapacityPools.length ||
        !allowedCapacityPools.includes(state.definition.capacityPool) ||
        allowedCapacityPools.some(
          (poolId) =>
            !state.configuration.capacityPools.some(
              (configured) => configured.poolId === poolId,
            ),
        ) ||
        !same(
          allowedCapacityPools,
          [...allowedCapacityPools].sort(stableCodeUnitCompare),
        )
      ) {
        throw new SchedulerError(
          "INVALID_EVENT",
          "Lease acquisition does not increment attempt and fence exactly.",
        );
      }
      return withEvent(state, event, {
        status: "leased",
        attempt: state.attempt + 1,
        lastFencingToken: lease.fencingToken,
        leaseRenewals: 0,
        lease,
        readySince: null,
        reservation: null,
        latestUsageSnapshot: null,
        dispatch: null,
        nextReadyAt: null,
      });
    }
    case "lease.renewed": {
      if (state.status !== "leased" && state.status !== "running") {
        throw new SchedulerError(
          "INVALID_TRANSITION",
          "Only active work may renew a lease.",
        );
      }
      const previous = assertLeaseActive(state, event);
      assertFencedEventCommand(state, event, "renew-lease");
      const payload = exactPayload(event, ["lease"]);
      const lease = parseLease(
        payload["lease"],
        "event.lease.renewed.payload.lease",
      );
      if (
        lease.leaseId !== previous.leaseId ||
        lease.workerId !== previous.workerId ||
        lease.fencingToken !== previous.fencingToken ||
        lease.acquiredAt !== previous.acquiredAt ||
        lease.heartbeatAt !== event.occurredAt ||
        event.occurredAt <= previous.heartbeatAt ||
        state.leaseRenewals >=
          state.configuration.maximumLeaseRenewalsPerAttempt ||
        lease.expiresAt <= previous.expiresAt ||
        lease.expiresAt !==
          new Date(
            Math.min(
              Math.max(
                Date.parse(previous.expiresAt) + 1,
                Date.parse(event.occurredAt) +
                  state.configuration.leaseDurationMs,
              ),
              Date.parse(previous.acquiredAt) +
                state.definition.task.timeout.attemptMs,
              Date.parse(state.definition.task.deadline),
              state.status === "leased"
                ? Date.parse(previous.acquiredAt) +
                    state.definition.task.timeout.dispatchMs
                : Number.MAX_SAFE_INTEGER,
            ),
          ).toISOString()
      ) {
        throw new SchedulerError(
          "INVALID_EVENT",
          "Lease renewal changed immutable ownership or failed to extend expiry.",
        );
      }
      return withEvent(state, event, {
        lease,
        leaseRenewals: state.leaseRenewals + 1,
      });
    }
    case "usage.reserved": {
      if (state.status !== "leased" || state.reservation !== null) {
        throw new SchedulerError(
          "INVALID_TRANSITION",
          "Usage may be reserved once for a leased attempt.",
        );
      }
      assertLeaseActive(state, event);
      const command = assertFencedEventCommand(state, event, "reserve-usage", [
        "circuit",
      ]);
      const payload = exactPayload(event, ["reservation", "usageSnapshot"]);
      const reservation = parseReservation(
        payload["reservation"],
        "event.usage.reserved.payload.reservation",
      );
      const usageSnapshot = parseCanonicalUsageSnapshot(
        payload["usageSnapshot"],
        "event.usage.reserved.payload.usageSnapshot",
      );
      assertUsageSnapshotForEvent(
        state,
        payload["usageSnapshot"],
        usageSnapshot,
        reservation.circuit,
        event,
      );
      const projectedUsage = addNormalizedUsage(
        state.cumulativeUsage,
        state.definition.estimatedUsage,
      );
      if (
        projectedUsage.costMicros === null ||
        !usageWithinTaskBudget(state.definition, projectedUsage) ||
        reservation.status !== "reserved" ||
        reservation.reservationId !==
          deterministicId("reservation", {
            definitionFingerprint: state.definitionFingerprint,
            attempt: state.attempt,
            snapshotId: reservation.snapshotId,
          }) ||
        reservation.reservedAt !== event.occurredAt ||
        reservation.snapshotId !== usageSnapshot.snapshotId ||
        reservation.sourceAdapterVersion !==
          usageSnapshot.sourceAdapterVersion ||
        reservation.sourceFingerprint !== usageSnapshot.sourceFingerprint ||
        reservation.observedAt !== usageSnapshot.observedAt ||
        reservation.fiveHourWindowId !== usageSnapshot.fiveHour.windowId ||
        reservation.fiveHourResetAt !== usageSnapshot.fiveHour.resetAt ||
        reservation.weeklyWindowId !== usageSnapshot.weekly.windowId ||
        reservation.weeklyResetAt !== usageSnapshot.weekly.resetAt ||
        reservation.usedFiveHourBasisPoints !==
          usageSnapshot.fiveHour.usedBasisPoints ||
        reservation.usedWeeklyBasisPoints !==
          usageSnapshot.weekly.usedBasisPoints ||
        !same(reservation.estimatedUsage, state.definition.estimatedUsage) ||
        reservation.predictedFiveHourBasisPoints !==
          state.definition.candidate.predictedFiveHourBasisPoints ||
        reservation.predictedWeeklyBasisPoints !==
          state.definition.candidate.predictedWeeklyBasisPoints ||
        reservation.circuit.providerId !==
          state.definition.candidate.providerId ||
        reservation.circuit.profileId !==
          state.definition.candidate.profileId ||
        reservation.circuit.state !== "closed" ||
        reservation.circuit.observedAt > event.occurredAt ||
        !same(
          parseProviderCircuitEvidence(
            command["circuit"],
            "event.usage.reserved.command.circuit",
          ),
          reservation.circuit,
        )
      ) {
        throw new SchedulerError(
          "INVALID_EVENT",
          "The usage reservation is not bound to the work estimate.",
        );
      }
      return withEvent(state, event, {
        reservation,
        latestUsageSnapshot: usageSnapshot,
      });
    }
    case "dispatch.prepared": {
      if (
        state.status !== "leased" ||
        state.reservation?.status !== "reserved" ||
        state.dispatch !== null
      ) {
        throw new SchedulerError(
          "INVALID_TRANSITION",
          "Dispatch preparation requires one active reservation.",
        );
      }
      assertLeaseActive(state, event);
      const command = assertFencedEventCommand(
        state,
        event,
        "prepare-dispatch",
        ["circuit"],
      );
      const payload = exactPayload(event, ["dispatch", "usageSnapshot"]);
      const dispatch = parseDispatch(
        payload["dispatch"],
        "event.dispatch.prepared.payload.dispatch",
      );
      const usageSnapshot = parseCanonicalUsageSnapshot(
        payload["usageSnapshot"],
        "event.dispatch.prepared.payload.usageSnapshot",
      );
      assertUsageSnapshotForEvent(
        state,
        payload["usageSnapshot"],
        usageSnapshot,
        dispatch.circuit,
        event,
      );
      if (state.latestUsageSnapshot === null) {
        throw new SchedulerError(
          "STATE_CORRUPTION",
          "A reserved attempt is missing its durable usage observation.",
        );
      }
      assertUsageSnapshotMonotonic(
        state.latestUsageSnapshot,
        usageSnapshot,
        "Dispatch preparation usage moved backwards.",
      );
      const route = selectedRoute(state.definition);
      const dispatchMaterial = {
        definitionFingerprint: state.definitionFingerprint,
        attempt: state.attempt,
        route,
        reservationId: state.reservation.reservationId,
      };
      const expectedDispatchId = deterministicId("dispatch", dispatchMaterial);
      const expectedRequestFingerprint = createHash("sha256")
        .update(
          toCanonicalJson({
            ...dispatchMaterial,
            dispatchId: expectedDispatchId,
            usageSnapshot,
            circuit: dispatch.circuit,
          }),
        )
        .digest("hex");
      if (
        dispatch.status !== "prepared" ||
        dispatch.dispatchId !== expectedDispatchId ||
        dispatch.usageSnapshotId !== usageSnapshot.snapshotId ||
        usageSnapshot.sourceAdapterVersion !==
          state.reservation.sourceAdapterVersion ||
        usageSnapshot.sourceFingerprint !==
          state.reservation.sourceFingerprint ||
        usageSnapshot.fiveHour.windowId !==
          state.reservation.fiveHourWindowId ||
        usageSnapshot.fiveHour.resetAt !== state.reservation.fiveHourResetAt ||
        usageSnapshot.weekly.windowId !== state.reservation.weeklyWindowId ||
        usageSnapshot.weekly.resetAt !== state.reservation.weeklyResetAt ||
        usageSnapshot.observedAt < state.reservation.observedAt ||
        usageSnapshot.fiveHour.usedBasisPoints <
          state.reservation.usedFiveHourBasisPoints ||
        usageSnapshot.weekly.usedBasisPoints <
          state.reservation.usedWeeklyBasisPoints ||
        dispatch.requestFingerprint !== expectedRequestFingerprint ||
        dispatch.circuit.providerId !== state.definition.candidate.providerId ||
        dispatch.circuit.profileId !== state.definition.candidate.profileId ||
        dispatch.circuit.sourceFingerprint !==
          state.reservation.circuit.sourceFingerprint ||
        dispatch.circuit.observedAt < state.reservation.circuit.observedAt ||
        dispatch.circuit.state !== "closed" ||
        dispatch.circuit.observedAt > event.occurredAt ||
        dispatch.preparedAt !== event.occurredAt ||
        dispatch.reservationId !== state.reservation.reservationId ||
        !same(
          parseProviderCircuitEvidence(
            command["circuit"],
            "event.dispatch.prepared.command.circuit",
          ),
          dispatch.circuit,
        ) ||
        !same(dispatch.route, route)
      ) {
        throw new SchedulerError(
          "INVALID_EVENT",
          "The dispatch intent is not bound to the selected route and reservation.",
        );
      }
      return withEvent(state, event, {
        dispatch,
        latestUsageSnapshot: usageSnapshot,
      });
    }
    case "dispatch.started": {
      if (state.status !== "leased" || state.dispatch?.status !== "prepared") {
        throw new SchedulerError(
          "INVALID_TRANSITION",
          "Only a prepared leased dispatch may start.",
        );
      }
      assertLeaseActive(state, event);
      const command = assertFencedEventCommand(
        state,
        event,
        "mark-dispatch-started",
        ["dispatchId"],
      );
      const payload = exactPayload(event, ["dispatch", "usageSnapshot"]);
      const dispatch = parseDispatch(
        payload["dispatch"],
        "event.dispatch.started.payload.dispatch",
      );
      const usageSnapshot = parseCanonicalUsageSnapshot(
        payload["usageSnapshot"],
        "event.dispatch.started.payload.usageSnapshot",
      );
      assertUsageSnapshotForEvent(
        state,
        payload["usageSnapshot"],
        usageSnapshot,
        dispatch.circuit,
        event,
      );
      if (state.latestUsageSnapshot === null) {
        throw new SchedulerError(
          "STATE_CORRUPTION",
          "A prepared dispatch is missing its durable usage observation.",
        );
      }
      assertUsageSnapshotMonotonic(
        state.latestUsageSnapshot,
        usageSnapshot,
        "Dispatch start usage moved backwards.",
      );
      if (
        dispatch.status !== "started" ||
        id(
          command["dispatchId"],
          "event.dispatch.started.command.dispatchId",
        ) !== dispatch.dispatchId ||
        dispatch.startedAt !== event.occurredAt ||
        state.reservation === null ||
        usageSnapshot.sourceAdapterVersion !==
          state.reservation.sourceAdapterVersion ||
        usageSnapshot.sourceFingerprint !==
          state.reservation.sourceFingerprint ||
        usageSnapshot.fiveHour.windowId !==
          state.reservation.fiveHourWindowId ||
        usageSnapshot.fiveHour.resetAt !== state.reservation.fiveHourResetAt ||
        usageSnapshot.weekly.windowId !== state.reservation.weeklyWindowId ||
        usageSnapshot.weekly.resetAt !== state.reservation.weeklyResetAt ||
        usageSnapshot.observedAt < state.reservation.observedAt ||
        usageSnapshot.fiveHour.usedBasisPoints <
          state.reservation.usedFiveHourBasisPoints ||
        usageSnapshot.weekly.usedBasisPoints <
          state.reservation.usedWeeklyBasisPoints ||
        !same(
          { ...dispatch, status: "prepared", startedAt: null },
          state.dispatch,
        )
      ) {
        throw new SchedulerError(
          "INVALID_EVENT",
          "Dispatch start changed immutable intent fields.",
        );
      }
      return withEvent(state, event, {
        status: "running",
        dispatch,
        latestUsageSnapshot: usageSnapshot,
      });
    }
    case "usage.reconciled": {
      if (
        !["failed", "cancelled"].includes(state.status) ||
        state.reservation?.status !== "reconciliation-required" ||
        state.dispatch?.status !== "terminal" ||
        state.terminal === null
      ) {
        throw new SchedulerError(
          "INVALID_TRANSITION",
          "Only terminal work with an explicit pending reservation may reconcile usage.",
        );
      }
      const payload = exactPayload(event, [
        "attemptUsage",
        "reservation",
        "terminal",
      ]);
      const attemptUsage = parseNormalizedUsage(
        payload["attemptUsage"],
        "event.usage.reconciled.payload.attemptUsage",
      );
      const cumulativeUsage = addNormalizedUsage(
        state.cumulativeUsage,
        attemptUsage,
      );
      const reservation = parseReservation(
        payload["reservation"],
        "event.usage.reconciled.payload.reservation",
      );
      const terminal = parseTerminal(
        payload["terminal"],
        "event.usage.reconciled.payload.terminal",
      );
      const command = exactCommand(event, "reconcile-usage", [
        "idempotencyKey",
        "reservationId",
        "dispatchId",
        "actualUsage",
      ]);
      if (
        reservation.status !== "reconciled" ||
        reservation.reconciledAt !== event.occurredAt ||
        !sameReservationIdentity(state.reservation, reservation) ||
        reservation.actualUsage === null ||
        !same(reservation.actualUsage, attemptUsage) ||
        !same(terminal.actualUsage, cumulativeUsage) ||
        !same(
          { ...terminal, actualUsage: state.terminal.actualUsage },
          state.terminal,
        ) ||
        idempotencyKey(
          command["idempotencyKey"],
          "event.usage.reconciled.command.idempotencyKey",
        ) !== state.definition.task.idempotencyKey ||
        id(
          command["reservationId"],
          "event.usage.reconciled.command.reservationId",
        ) !== reservation.reservationId ||
        id(
          command["dispatchId"],
          "event.usage.reconciled.command.dispatchId",
        ) !== state.dispatch.dispatchId ||
        !same(
          parseNormalizedUsage(
            command["actualUsage"],
            "event.usage.reconciled.command.actualUsage",
          ),
          attemptUsage,
        )
      ) {
        throw new SchedulerError(
          "INVALID_EVENT",
          "Usage reconciliation changed terminal or reservation identity.",
        );
      }
      return withEvent(state, event, {
        reservation,
        terminal,
        cumulativeUsage,
      });
    }
    case "attempt.retry-scheduled": {
      if (state.status !== "leased" && state.status !== "running") {
        throw new SchedulerError(
          "INVALID_TRANSITION",
          "Only an active attempt may schedule retry.",
        );
      }
      const payload = exactPayload(event, [
        "nextReadyAt",
        "failure",
        "reservation",
        "dispatch",
      ]);
      const nextReadyAt = ensureTimestamp(
        payload["nextReadyAt"],
        "event.attempt.retry-scheduled.payload.nextReadyAt",
      );
      if (
        nextReadyAt < event.occurredAt ||
        state.attempt >= state.definition.task.retry.maximumAttempts
      ) {
        throw new SchedulerError(
          "INVALID_EVENT",
          "Retry time or attempt bound is invalid.",
        );
      }
      const failure = ensureRecord(
        payload["failure"],
        "event.attempt.retry-scheduled.payload.failure",
      );
      ensureExactKeys(
        failure,
        ["classification", "code", "retryable", "actualUsage"],
        "event.attempt.retry-scheduled.payload.failure",
      );
      const failureClassification = ensureEnum(
        failure["classification"],
        "event.attempt.retry-scheduled.payload.failure.classification",
        FAILURE_CLASSIFICATIONS,
      );
      const failureCode = code(
        failure["code"],
        "event.attempt.retry-scheduled.payload.failure.code",
      );
      if (
        ensureBoolean(
          failure["retryable"],
          "event.attempt.retry-scheduled.payload.failure.retryable",
        ) !== true
      ) {
        throw new SchedulerError(
          "INVALID_EVENT",
          "A scheduled retry must be retryable.",
        );
      }
      const actualUsage = parseNormalizedUsage(
        failure["actualUsage"],
        "event.attempt.retry-scheduled.payload.failure.actualUsage",
      );
      const cumulativeUsage = addNormalizedUsage(
        state.cumulativeUsage,
        actualUsage,
      );
      const projectedRetryUsage = addNormalizedUsage(
        cumulativeUsage,
        state.definition.estimatedUsage,
      );
      const expectedRetryAt = new Date(
        Date.parse(event.occurredAt) +
          Math.min(
            state.definition.task.retry.maximumBackoffMs,
            state.definition.task.retry.initialBackoffMs *
              2 ** Math.max(0, state.attempt - 1),
          ),
      ).toISOString();
      const isLeaseExpiry =
        failureClassification === "disconnected" &&
        failureCode === "lease-expired-before-dispatch";
      if (!isLeaseExpiry && isInternalWorkerFailureCode(failureCode)) {
        throw new SchedulerError(
          "INVALID_EVENT",
          "A worker retry cannot reuse a scheduler-owned failure code.",
        );
      }
      if (isLeaseExpiry) {
        const command = exactCommand(event, "lease-expired", [
          "idempotencyKey",
        ]);
        assertTickCommandIdentity(state, event);
        if (
          idempotencyKey(
            command["idempotencyKey"],
            "event.attempt.retry-scheduled.command.idempotencyKey",
          ) !== state.definition.task.idempotencyKey
        ) {
          throw new SchedulerError(
            "INVALID_EVENT",
            "Lease-expiry retry is bound to another work item.",
          );
        }
      } else {
        assertFailEventCommand(state, event, {
          classification: failureClassification,
          code: failureCode,
          retryable: true,
          actualUsage,
        });
      }
      if (
        nextReadyAt !== expectedRetryAt ||
        state.lease === null ||
        (state.status === "leased" &&
          !same(actualUsage, ZERO_CUMULATIVE_USAGE)) ||
        cumulativeUsage.costMicros === null ||
        !usageWithinTaskBudget(state.definition, cumulativeUsage) ||
        projectedRetryUsage.costMicros === null ||
        !usageWithinTaskBudget(state.definition, projectedRetryUsage) ||
        (!isLeaseExpiry &&
          !state.definition.task.retry.retryableFailures.includes(
            failureClassification,
          )) ||
        (isLeaseExpiry
          ? state.lease.expiresAt > event.occurredAt ||
            state.status !== "leased" ||
            state.dispatch?.status === "started" ||
            !same(actualUsage, ZERO_CUMULATIVE_USAGE)
          : state.lease.expiresAt <= event.occurredAt)
      ) {
        throw new SchedulerError(
          "INVALID_EVENT",
          "Retry evidence is not bound to the exact active or expired attempt.",
        );
      }
      const reservation =
        payload["reservation"] === null
          ? null
          : parseReservation(
              payload["reservation"],
              "event.attempt.retry-scheduled.payload.reservation",
            );
      const dispatch =
        payload["dispatch"] === null
          ? null
          : parseDispatch(
              payload["dispatch"],
              "event.attempt.retry-scheduled.payload.dispatch",
            );
      if (
        (state.reservation === null) !== (reservation === null) ||
        (state.dispatch === null) !== (dispatch === null) ||
        (reservation !== null &&
          ((reservation.status !== "released" &&
            reservation.status !== "reconciled") ||
            state.reservation === null ||
            !sameReservationIdentity(state.reservation, reservation) ||
            reservation.status !==
              (isLeaseExpiry || state.status === "leased"
                ? "released"
                : "reconciled") ||
            !same(reservation.actualUsage, actualUsage) ||
            reservation.reconciledAt !== event.occurredAt)) ||
        (dispatch !== null &&
          (dispatch.status !== "terminal" ||
            state.dispatch === null ||
            !sameDispatchIdentity(state.dispatch, dispatch) ||
            dispatch.terminalAt !== event.occurredAt))
      ) {
        throw new SchedulerError(
          "INVALID_EVENT",
          "Retry must release reservation and terminalize dispatch intent.",
        );
      }
      return withEvent(state, event, {
        status: "retry-wait",
        lease: null,
        reservation,
        dispatch,
        cumulativeUsage,
        readySince: null,
        nextReadyAt,
      });
    }
    case "work.ready": {
      if (
        state.status !== "retry-wait" ||
        state.nextReadyAt === null ||
        event.occurredAt < state.nextReadyAt ||
        state.definition.task.deadline <= event.occurredAt
      ) {
        throw new SchedulerError(
          "INVALID_TRANSITION",
          "Retry work is not ready yet.",
        );
      }
      exactPayload(event, []);
      const command = exactCommand(event, "retry-ready", ["idempotencyKey"]);
      assertTickCommandIdentity(state, event);
      if (
        idempotencyKey(
          command["idempotencyKey"],
          "event.work.ready.command.idempotencyKey",
        ) !== state.definition.task.idempotencyKey
      ) {
        throw new SchedulerError(
          "INVALID_EVENT",
          "Retry readiness is bound to another work item.",
        );
      }
      return withEvent(state, event, {
        status: "ready",
        reservation: null,
        latestUsageSnapshot: null,
        dispatch: null,
        readySince: event.occurredAt,
        nextReadyAt: null,
      });
    }
    case "work.completed":
    case "work.failed":
    case "work.cancelled": {
      const allowed =
        event.type === "work.cancelled"
          ? ["ready", "leased", "running", "retry-wait"]
          : event.type === "work.completed"
            ? ["running"]
            : ["leased", "running"];
      if (!allowed.includes(state.status)) {
        throw new SchedulerError(
          "INVALID_TRANSITION",
          "Terminal worker transition is invalid.",
        );
      }
      const payload = exactPayload(event, [
        "attemptUsage",
        "terminal",
        "reservation",
        "dispatch",
      ]);
      const attemptUsage =
        payload["attemptUsage"] === null
          ? null
          : parseNormalizedUsage(
              payload["attemptUsage"],
              `event.${event.type}.payload.attemptUsage`,
            );
      const terminal = parseTerminal(
        payload["terminal"],
        `event.${event.type}.payload.terminal`,
      );
      const expected =
        event.type === "work.completed"
          ? "completed"
          : event.type === "work.failed"
            ? "failed"
            : "cancelled";
      if (
        terminal.outcome !== expected ||
        terminal.finishedAt !== event.occurredAt
      ) {
        throw new SchedulerError(
          "INVALID_EVENT",
          "Terminal event and receipt outcomes differ.",
        );
      }
      const isExpiredRunningFailure =
        event.type === "work.failed" &&
        terminal.classification === "disconnected" &&
        terminal.code === "lease-expired-reconciliation-required" &&
        state.status === "running" &&
        state.dispatch?.status === "started";
      const isExpiredBeforeDispatchFailure =
        event.type === "work.failed" &&
        terminal.classification === "disconnected" &&
        terminal.code === "retry-exhausted" &&
        state.status === "leased" &&
        state.dispatch?.status !== "started" &&
        state.attempt >= state.definition.task.retry.maximumAttempts;
      const terminalCommand = ensureRecord(
        event.command,
        `event.${event.type}.command`,
      );
      const isDeadlineCancellation =
        event.type === "work.cancelled" &&
        terminalCommand["type"] === "deadline-expired";
      const isRunningCancellation =
        event.type === "work.cancelled" &&
        state.status === "running" &&
        state.dispatch?.status === "started";
      const isUnknownCostFailure =
        event.type === "work.failed" &&
        terminal.code === "usage-cost-unknown" &&
        terminal.classification === "usage" &&
        terminal.actualUsage.costMicros === null &&
        state.status === "running" &&
        state.dispatch?.status === "started";
      const needsLaterReconciliation =
        isExpiredRunningFailure || isRunningCancellation;
      const cumulativeUsage =
        attemptUsage === null
          ? state.cumulativeUsage
          : addNormalizedUsage(state.cumulativeUsage, attemptUsage);
      if (
        needsLaterReconciliation !== (attemptUsage === null) ||
        !same(terminal.actualUsage, cumulativeUsage) ||
        (state.status === "leased" &&
          !same(attemptUsage, ZERO_CUMULATIVE_USAGE)) ||
        (event.type !== "work.cancelled" &&
          state.definition.task.deadline <= event.occurredAt) ||
        (event.type === "work.completed" &&
          (terminal.code !== "completed" ||
            terminal.actualUsage.costMicros === null ||
            !usageWithinTaskBudget(state.definition, terminal.actualUsage))) ||
        (event.type === "work.failed" &&
          terminal.code === "usage-budget-exceeded" &&
          (terminal.classification !== "usage" ||
            terminal.actualUsage.costMicros === null ||
            state.status !== "running" ||
            state.dispatch?.status !== "started" ||
            usageWithinTaskBudget(state.definition, terminal.actualUsage))) ||
        (event.type === "work.failed" &&
          terminal.code === "usage-cost-unknown" &&
          !isUnknownCostFailure) ||
        (isExpiredBeforeDispatchFailure &&
          !same(attemptUsage, ZERO_CUMULATIVE_USAGE)) ||
        (isRunningCancellation &&
          terminal.code !== "cancellation-reconciliation-required") ||
        (event.type === "work.cancelled" &&
          !isRunningCancellation &&
          !same(attemptUsage, ZERO_CUMULATIVE_USAGE))
      ) {
        throw new SchedulerError(
          "INVALID_EVENT",
          "Terminal evidence is not command-equivalent for the current work state.",
        );
      }
      if (event.type !== "work.cancelled") {
        if (isExpiredRunningFailure || isExpiredBeforeDispatchFailure) {
          assertTickCommandIdentity(state, event);
          if (
            state.lease === null ||
            state.lease.expiresAt > event.occurredAt
          ) {
            throw new SchedulerError(
              "INVALID_EVENT",
              "Lease-expiry failure occurred before expiry.",
            );
          }
        } else {
          assertLeaseActive(state, event);
        }
      }
      if (event.type === "work.completed") {
        assertCompleteEventCommand(state, event, attemptUsage!);
      } else if (event.type === "work.cancelled") {
        if (isDeadlineCancellation) {
          const command = exactCommand(event, "deadline-expired", [
            "idempotencyKey",
          ]);
          assertTickCommandIdentity(state, event);
          if (
            idempotencyKey(
              command["idempotencyKey"],
              "event.work.cancelled.command.idempotencyKey",
            ) !== state.definition.task.idempotencyKey ||
            event.occurredAt < state.definition.task.deadline ||
            terminal.code !==
              (isRunningCancellation
                ? "cancellation-reconciliation-required"
                : "deadline-expired")
          ) {
            throw new SchedulerError(
              "INVALID_EVENT",
              "Deadline cancellation is not bound to the exact expired task.",
            );
          }
        } else {
          const command = exactCommand(event, "cancel-work", [
            "idempotencyKey",
            "code",
          ]);
          const cancellationCode = code(
            command["code"],
            "event.work.cancelled.command.code",
          );
          if (
            isInternalWorkerCancellationCode(cancellationCode) ||
            idempotencyKey(
              command["idempotencyKey"],
              "event.work.cancelled.command.idempotencyKey",
            ) !== state.definition.task.idempotencyKey ||
            (!isRunningCancellation && terminal.code !== cancellationCode)
          ) {
            throw new SchedulerError(
              "INVALID_EVENT",
              "Cancellation command evidence does not match its terminal projection.",
            );
          }
        }
      } else if (
        terminal.code === "usage-budget-exceeded" ||
        isUnknownCostFailure
      ) {
        assertCompleteEventCommand(state, event, attemptUsage!);
      } else if (isExpiredBeforeDispatchFailure) {
        const command = exactCommand(event, "lease-exhausted", [
          "idempotencyKey",
        ]);
        if (
          idempotencyKey(
            command["idempotencyKey"],
            "event.work.failed.command.idempotencyKey",
          ) !== state.definition.task.idempotencyKey
        ) {
          throw new SchedulerError(
            "INVALID_EVENT",
            "Exhausted-lease failure is bound to another work item.",
          );
        }
      } else {
        if (
          !isExpiredRunningFailure &&
          isInternalWorkerFailureCode(terminal.code)
        ) {
          throw new SchedulerError(
            "INVALID_EVENT",
            "A worker failure cannot reuse a scheduler-owned terminal code.",
          );
        }
        const requestedRetryable = assertFailEventCommand(
          state,
          event,
          {
            classification: terminal.classification!,
            code: terminal.code,
            retryable: isExpiredRunningFailure ? false : null,
            actualUsage: isExpiredRunningFailure
              ? ZERO_NORMALIZED_USAGE
              : attemptUsage!,
          },
          isExpiredRunningFailure,
        );
        const projectedRetryUsage = addNormalizedUsage(
          cumulativeUsage,
          state.definition.estimatedUsage,
        );
        const usagePermitsRetry =
          cumulativeUsage.costMicros !== null &&
          usageWithinTaskBudget(state.definition, cumulativeUsage) &&
          projectedRetryUsage.costMicros !== null &&
          usageWithinTaskBudget(state.definition, projectedRetryUsage);
        if (
          !isExpiredRunningFailure &&
          requestedRetryable &&
          state.definition.task.retry.retryableFailures.includes(
            terminal.classification!,
          ) &&
          state.attempt < state.definition.task.retry.maximumAttempts &&
          usagePermitsRetry
        ) {
          throw new SchedulerError(
            "INVALID_EVENT",
            "A retry-eligible failure cannot directly become terminal.",
          );
        }
      }
      const reservation =
        payload["reservation"] === null
          ? null
          : parseReservation(
              payload["reservation"],
              `event.${event.type}.payload.reservation`,
            );
      const dispatch =
        payload["dispatch"] === null
          ? null
          : parseDispatch(
              payload["dispatch"],
              `event.${event.type}.payload.dispatch`,
            );
      if (
        (state.reservation === null) !== (reservation === null) ||
        (state.dispatch === null) !== (dispatch === null) ||
        (reservation !== null &&
          (state.reservation === null ||
            !sameReservationIdentity(state.reservation, reservation) ||
            (state.reservation.status === "reserved"
              ? (() => {
                  if (needsLaterReconciliation) {
                    return (
                      reservation.status !== "reconciliation-required" ||
                      reservation.actualUsage !== null ||
                      reservation.reconciledAt !== null
                    );
                  }
                  const expectedStatus =
                    event.type === "work.cancelled" ||
                    isExpiredBeforeDispatchFailure ||
                    (event.type === "work.failed" && state.status === "leased")
                      ? "released"
                      : "reconciled";
                  return (
                    reservation.status !== expectedStatus ||
                    reservation.reconciledAt !== event.occurredAt ||
                    !same(reservation.actualUsage, attemptUsage)
                  );
                })()
              : !same(state.reservation, reservation)))) ||
        (dispatch !== null &&
          (state.dispatch === null ||
            !sameDispatchIdentity(state.dispatch, dispatch) ||
            dispatch.status !== "terminal" ||
            (state.dispatch.status === "terminal"
              ? !same(state.dispatch, dispatch)
              : dispatch.terminalAt !== event.occurredAt)))
      ) {
        throw new SchedulerError(
          "INVALID_EVENT",
          "Terminal reservation or dispatch state is inconsistent.",
        );
      }
      return withEvent(state, event, {
        status: expected,
        lease: null,
        reservation,
        dispatch,
        readySince: null,
        nextReadyAt: null,
        terminal,
        cumulativeUsage,
      });
    }
  }
}

export function createWorkerRuntimeEvent(input: {
  readonly workId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly type: WorkerRuntimeEventType;
  readonly command: unknown;
  readonly payload: unknown;
}): WorkerRuntimeEvent {
  const command = canonicalizeWorkerEventCommand(
    input.command,
    "event.command",
  );
  const commandId = id(command["commandId"], "event.command.commandId");
  const commandFingerprint = workerCommandFingerprint(command);
  const payload = canonicalizeWorkerEventPayload(
    input.payload,
    "event.payload",
  );
  const material = {
    workId: input.workId,
    sequence: input.sequence,
    occurredAt: input.occurredAt,
    type: input.type,
    command,
    commandId,
    commandFingerprint,
    payload,
  };
  const eventId = workerRuntimeEventId(material);
  return parseWorkerRuntimeEvent({
    schemaVersion: WORKER_RUNTIME_EVENT_SCHEMA_VERSION,
    eventId,
    ...material,
  });
}

export function parseWorkerRuntimeEvent(
  value: unknown,
  path = "event",
): WorkerRuntimeEvent {
  try {
    const input = ensureRecord(value, path);
    ensureExactKeys(
      input,
      [
        "schemaVersion",
        "eventId",
        "workId",
        "sequence",
        "occurredAt",
        "type",
        "command",
        "commandId",
        "commandFingerprint",
        "payload",
      ],
      path,
    );
    if (input["schemaVersion"] !== WORKER_RUNTIME_EVENT_SCHEMA_VERSION) {
      throw new SchedulerError(
        "INVALID_EVENT",
        `Worker runtime events must use schema version ${WORKER_RUNTIME_EVENT_SCHEMA_VERSION}.`,
        { supportedSchemaVersion: WORKER_RUNTIME_EVENT_SCHEMA_VERSION },
      );
    }
    const payload = canonicalizeWorkerEventPayload(
      input["payload"],
      `${path}.payload`,
    );
    const command = canonicalizeWorkerEventCommand(
      input["command"],
      `${path}.command`,
    );
    const parsed = Object.freeze({
      schemaVersion: WORKER_RUNTIME_EVENT_SCHEMA_VERSION,
      eventId: id(input["eventId"], `${path}.eventId`),
      workId: id(input["workId"], `${path}.workId`),
      sequence: ensureSafeInteger(
        input["sequence"],
        `${path}.sequence`,
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      occurredAt: ensureTimestamp(input["occurredAt"], `${path}.occurredAt`),
      type: ensureEnum(
        input["type"],
        `${path}.type`,
        WORKER_RUNTIME_EVENT_TYPES,
      ),
      command,
      commandId: id(input["commandId"], `${path}.commandId`),
      commandFingerprint: sha(
        input["commandFingerprint"],
        `${path}.commandFingerprint`,
      ),
      payload,
    });
    const expectedEventId = workerRuntimeEventId({
      workId: parsed.workId,
      sequence: parsed.sequence,
      occurredAt: parsed.occurredAt,
      type: parsed.type,
      command: parsed.command,
      commandId: parsed.commandId,
      commandFingerprint: parsed.commandFingerprint,
      payload: parsed.payload,
    });
    if (
      parsed.command["commandId"] !== parsed.commandId ||
      workerCommandFingerprint(parsed.command) !== parsed.commandFingerprint ||
      parsed.eventId !== expectedEventId
    ) {
      throw new SchedulerError(
        "INVALID_EVENT",
        "The worker runtime event identity is invalid.",
      );
    }
    return parsed;
  } catch (error) {
    if (error instanceof SchedulerError) throw error;
    throw new SchedulerError(
      "INVALID_EVENT",
      "The worker runtime event is invalid.",
      {
        cause: error instanceof Error ? error.name : typeof error,
      },
    );
  }
}

function canonicalizeWorkerEventCommand(
  value: unknown,
  path: string,
): JsonObject {
  const command = canonicalizeJson(value, path);
  if (
    command === null ||
    Array.isArray(command) ||
    typeof command !== "object" ||
    toCanonicalJson(command).length > 500_000
  ) {
    throw new SchedulerError(
      "INVALID_EVENT",
      "The worker runtime event command must be a bounded object.",
    );
  }
  return command as JsonObject;
}

function canonicalizeWorkerEventPayload(
  value: unknown,
  path: string,
): JsonObject {
  const payload = canonicalizeJson(value, path);
  if (
    payload === null ||
    Array.isArray(payload) ||
    typeof payload !== "object"
  ) {
    throw new SchedulerError(
      "INVALID_EVENT",
      "The worker runtime event payload must be an object.",
    );
  }
  return payload as JsonObject;
}

function workerRuntimeEventId(material: {
  readonly workId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly type: WorkerRuntimeEventType;
  readonly command: JsonObject;
  readonly commandId: string;
  readonly commandFingerprint: string;
  readonly payload: JsonObject;
}): string {
  return `runtime-event:${createHash("sha256")
    .update(toCanonicalJson(material))
    .digest("hex")
    .slice(0, 40)}`;
}

export function replayWorkerRuntimeEvents(
  events: readonly WorkerRuntimeEvent[],
): WorkerRuntimeState {
  if (events.length === 0) {
    throw new SchedulerError(
      "STATE_CORRUPTION",
      "A worker runtime journal cannot be empty.",
    );
  }
  const rawFirst = events[0];
  if (rawFirst === undefined) {
    throw new SchedulerError(
      "STATE_CORRUPTION",
      "The first worker runtime event is missing.",
    );
  }
  const first = parseWorkerRuntimeEvent(rawFirst, "events[0]");
  const eventIds = new Set<string>();
  const commandIds = new Set<string>();
  let state = baseState(first);
  eventIds.add(first.eventId);
  commandIds.add(first.commandId);
  for (let index = 1; index < events.length; index += 1) {
    const rawEvent = events[index];
    if (rawEvent === undefined) {
      throw new SchedulerError(
        "STATE_CORRUPTION",
        "A worker runtime event is missing.",
      );
    }
    const event = parseWorkerRuntimeEvent(rawEvent, `events[${index}]`);
    if (eventIds.has(event.eventId) || commandIds.has(event.commandId)) {
      throw new SchedulerError(
        "INVALID_EVENT",
        "Duplicate worker event or command identity is refused.",
      );
    }
    eventIds.add(event.eventId);
    commandIds.add(event.commandId);
    state = applyWorkerRuntimeEvent(state, event);
  }
  return state;
}

export function workerRuntimeStateEquals(
  left: WorkerRuntimeState,
  right: unknown,
): boolean {
  return toCanonicalJson(left) === toCanonicalJson(right);
}

export function workerCommandFingerprint(command: unknown): string {
  return createHash("sha256").update(toCanonicalJson(command)).digest("hex");
}

export function terminalizeReservation(
  reservation: RuntimeUsageReservation | null,
  status: "reconciliation-required" | "reconciled" | "released",
  actualUsage: NormalizedUsage | null,
  at: string,
): RuntimeUsageReservation | null {
  if (reservation === null) return null;
  if (reservation.status !== "reserved") return reservation;
  if (status === "reconciliation-required") {
    return Object.freeze({
      ...reservation,
      status,
      actualUsage: null,
      reconciledAt: null,
    });
  }
  if (actualUsage === null) {
    throw new SchedulerError(
      "STATE_CORRUPTION",
      "Terminal usage is required for reconciliation.",
    );
  }
  return Object.freeze({
    ...reservation,
    status,
    actualUsage,
    reconciledAt: at,
  });
}

export function terminalizeDispatch(
  dispatch: RuntimeDispatchIntent | null,
  at: string,
): RuntimeDispatchIntent | null {
  if (dispatch === null) return null;
  if (dispatch.status === "terminal") return dispatch;
  return Object.freeze({ ...dispatch, status: "terminal", terminalAt: at });
}

export function routeForDefinition(
  definition: WorkerWorkDefinition,
): SelectedRoute {
  return selectedRoute(definition);
}

export function assertDefinitionIdentity(
  definition: WorkerWorkDefinition,
): void {
  // Recompute both nested and outer fingerprints so callers cannot bind an
  // independently mutated task after parsing.
  taskFingerprint(definition.task);
  workerDefinitionFingerprint(definition);
}
