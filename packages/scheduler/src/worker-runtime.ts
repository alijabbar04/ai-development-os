import { createHash } from "node:crypto";
import {
  toCanonicalJson,
  validation,
  type JsonObject,
} from "@ai-dev-os/domain";
import type {
  AggregateEnvelope,
  PersistenceAdapter,
  TransactionContext,
} from "@ai-dev-os/persistence";
import { SchedulerError } from "./errors.js";
import { evaluateStaticRouteEligibility, routeTask } from "./routing.js";
import { parseNormalizedUsage, ZERO_NORMALIZED_USAGE } from "./schema.js";
import type { NormalizedUsage, SchedulerClock } from "./types.js";
import {
  BORROWED_WEEKLY_CAP,
  BORROWED_WORK_HOURS_FIVE_HOUR_CAP,
  isLondonWorkHours,
  parseCanonicalUsageSnapshot,
  validateUsageFreshness,
  type NormalizedCanonicalUsageSnapshot,
} from "./usage.js";
import {
  addNormalizedUsage,
  applyWorkerRuntimeEvent,
  createWorkerRuntimeEvent,
  parseProviderCircuitEvidence,
  parseRuntimeUsageAdapterBinding,
  parseWorkerRuntimeConfiguration,
  parseWorkerRuntimeEvent,
  parseWorkerWorkDefinition,
  replayWorkerRuntimeEvents,
  routeForDefinition,
  stableCodeUnitCompare,
  terminalizeDispatch,
  terminalizeReservation,
  usageWithinTaskBudget,
  workerCommandFingerprint,
  workerDefinitionFingerprint,
  workerRuntimeStateEquals,
  workerTickCommandId,
  ZERO_CUMULATIVE_USAGE,
} from "./worker-runtime-state.js";
import {
  parseWorkerRuntimeCommand,
  parseWorkerRuntimeIdempotencyKey,
} from "./worker-runtime-command.js";
import {
  STAGE_18C_PRODUCTION_ENABLED,
  WORKER_RUNTIME_SCHEMA_VERSION,
  type CancelWorkCommand,
  type ClaimWorkCommand,
  type CompleteWorkCommand,
  type DurableWorkerRuntime,
  type EnqueueWorkCommand,
  type FailWorkCommand,
  type FencedWorkCommand,
  type MarkDispatchStartedCommand,
  type PrepareDispatchCommand,
  type ProviderCircuitEvidence,
  type ReconcileUsageCommand,
  type RenewLeaseCommand,
  type ReserveUsageCommand,
  type RuntimeDispatchIntent,
  type RuntimeUsageAdapterBinding,
  type RuntimeUsageReservation,
  type WorkerLease,
  type WorkerRuntimeConfiguration,
  type WorkerRuntimeCommand,
  type WorkerRuntimeEvent,
  type WorkerRuntimeFaultPoint,
  type WorkerRuntimeOptions,
  type WorkerRuntimeState,
  type WorkerRuntimeTerminal,
} from "./worker-runtime-types.js";

const { ensureArray, ensureExactKeys, ensureRecord, ensureString } = validation;
const AGGREGATE_TYPE = "worker-run" as const;
const AGGREGATE_PREFIX = "worker-runtime:" as const;
const EVENT_SCHEMA_VERSION = 1;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KIND = /^[a-z][a-z0-9._-]{0,63}$/;

export const DEFAULT_WORKER_RUNTIME_CONFIGURATION: WorkerRuntimeConfiguration =
  Object.freeze({
    maximumQueueDepth: 1_000,
    maximumRetainedWorkItems: 1_000,
    leaseDurationMs: 30_000,
    maximumLeaseRenewalsPerAttempt: 256,
    usageReadTimeoutMs: 5_000,
    usageFreshnessMs: 15 * 60_000,
    circuitFreshnessMs: 5 * 60_000,
    starvationAgingMs: 5 * 60_000,
    capacityPools: Object.freeze([
      Object.freeze({ poolId: "default", maximumActive: 4 }),
    ]),
  });

const systemClock: SchedulerClock = Object.freeze({ now: () => new Date() });

function finiteId(value: unknown, path: string): string {
  return ensureString(value, path, {
    maxLength: 128,
    pattern: ID,
    patternName: "identifier",
  });
}

function finiteCode(value: unknown, path: string): string {
  return ensureString(value, path, {
    maxLength: 64,
    pattern: KIND,
    patternName: "finite code",
  });
}

function commandOf<T extends WorkerRuntimeCommand["type"]>(
  value: unknown,
  expectedType: T,
): Extract<WorkerRuntimeCommand, { readonly type: T }> {
  const command = parseWorkerRuntimeCommand(value);
  if (command.type !== expectedType) {
    throw new SchedulerError(
      "INVALID_TASK",
      "The worker command type is invalid.",
    );
  }
  return command as Extract<WorkerRuntimeCommand, { readonly type: T }>;
}

function aggregateIdFor(idempotencyKey: string): string {
  return `${AGGREGATE_PREFIX}${createHash("sha256")
    .update(idempotencyKey)
    .digest("hex")
    .slice(0, 40)}`;
}

function addMs(at: string, milliseconds: number): string {
  return new Date(Date.parse(at) + milliseconds).toISOString();
}

function clockNow(clock: SchedulerClock): Date {
  const value = clock.now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new SchedulerError(
      "STATE_CORRUPTION",
      "The worker runtime clock is invalid.",
    );
  }
  return new Date(value.valueOf());
}

interface WorkerJournalEntry {
  readonly event: WorkerRuntimeEvent;
  readonly globalSequence: number;
}

async function listEvents(
  tx: TransactionContext,
  aggregateId: string,
  expectedTraceId: string | null,
): Promise<readonly WorkerJournalEntry[]> {
  const entries: WorkerJournalEntry[] = [];
  let cursor: string | null = null;
  do {
    const page = await tx.events.list({
      aggregateType: AGGREGATE_TYPE,
      aggregateId,
      limit: 100,
      cursor,
    });
    for (const record of page.items) {
      const wrapper = ensureRecord(
        record.payload,
        "persistedWorkerEvent.payload",
      );
      ensureExactKeys(wrapper, ["event"], "persistedWorkerEvent.payload");
      const event = parseWorkerRuntimeEvent(
        wrapper["event"],
        "persistedWorkerEvent.payload.event",
      );
      const previous = entries.at(-1)?.event;
      if (
        record.eventId !== event.eventId ||
        record.eventType !== event.type ||
        record.aggregateVersion !== event.sequence ||
        record.eventSchemaVersion !== EVENT_SCHEMA_VERSION ||
        record.occurredAt !== event.occurredAt ||
        record.traceId !== expectedTraceId ||
        record.causationId !== (previous?.eventId ?? null) ||
        !Number.isSafeInteger(record.globalSequence) ||
        record.globalSequence < 1 ||
        (entries.at(-1)?.globalSequence ?? 0) >= record.globalSequence
      ) {
        throw new SchedulerError(
          "STATE_CORRUPTION",
          "Persisted worker event metadata is inconsistent.",
        );
      }
      entries.push(
        Object.freeze({ event, globalSequence: record.globalSequence }),
      );
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return Object.freeze(entries);
}

async function loadState(
  tx: TransactionContext,
  aggregateId: string,
  envelope?: AggregateEnvelope | null,
  expectedConfigurationFingerprint?: string,
): Promise<{
  readonly state: WorkerRuntimeState;
  readonly events: readonly WorkerRuntimeEvent[];
  readonly journal: readonly WorkerJournalEntry[];
  readonly envelope: AggregateEnvelope;
} | null> {
  const current =
    envelope === undefined
      ? await tx.aggregates.get(AGGREGATE_TYPE, aggregateId)
      : envelope;
  if (current === null) return null;
  if (
    current.aggregateType !== AGGREGATE_TYPE ||
    current.aggregateId !== aggregateId ||
    current.schemaVersion !== WORKER_RUNTIME_SCHEMA_VERSION
  ) {
    throw new SchedulerError(
      "STATE_CORRUPTION",
      "Worker aggregate envelope is inconsistent.",
    );
  }
  const journal = await listEvents(tx, aggregateId, current.traceId);
  const events = Object.freeze(journal.map((entry) => entry.event));
  const state = replayWorkerRuntimeEvents(events);
  if (
    state.sequence !== current.aggregateVersion ||
    !workerRuntimeStateEquals(state, current.payload) ||
    current.aggregateId !==
      aggregateIdFor(state.definition.task.idempotencyKey) ||
    current.traceId !== state.definition.task.correlationId ||
    (expectedConfigurationFingerprint !== undefined &&
      state.configurationFingerprint !== expectedConfigurationFingerprint)
  ) {
    throw new SchedulerError(
      "STATE_CORRUPTION",
      "The worker checkpoint does not match its exact append-only journal.",
    );
  }
  return Object.freeze({ state, events, journal, envelope: current });
}

interface ReservationUsageEvidence {
  readonly globalSequence: number;
  readonly recordedAt: string;
  readonly observedAt: string;
  readonly usedFiveHourBasisPoints: number;
  readonly usedWeeklyBasisPoints: number;
}

interface ReservationJournalRecord {
  readonly state: WorkerRuntimeState;
  readonly reservation: RuntimeUsageReservation;
  readonly admissionGlobalSequence: number;
  readonly evidenceHistory: readonly ReservationUsageEvidence[];
  readonly releaseGlobalSequence: number | null;
  readonly evidenceRecordedAt: string;
  readonly evidenceObservedAt: string;
  readonly evidenceUsedFiveHourBasisPoints: number;
  readonly evidenceUsedWeeklyBasisPoints: number;
}

interface UsageCapacityEvidence {
  readonly observedAt: string;
  readonly fiveHour: {
    readonly windowId: string;
    readonly resetAt: string;
    readonly usedBasisPoints: number;
  };
  readonly weekly: {
    readonly windowId: string;
    readonly resetAt: string;
    readonly usedBasisPoints: number;
  };
}

function reservationJournalRecords(
  loaded: readonly {
    readonly state: WorkerRuntimeState;
    readonly journal: readonly WorkerJournalEntry[];
  }[],
): readonly ReservationJournalRecord[] {
  const records = new Map<string, ReservationJournalRecord>();
  for (const item of loaded) {
    for (const entry of item.journal) {
      const { event, globalSequence } = entry;
      if (
        event.type === "dispatch.prepared" ||
        event.type === "dispatch.started"
      ) {
        const rawDispatch = event.payload["dispatch"];
        const rawSnapshot = event.payload["usageSnapshot"];
        if (rawDispatch === null || rawSnapshot === null) continue;
        const dispatch = rawDispatch as unknown as RuntimeDispatchIntent;
        const snapshot =
          rawSnapshot as unknown as NormalizedCanonicalUsageSnapshot;
        const previous = records.get(dispatch.reservationId);
        if (previous === undefined) {
          throw new SchedulerError(
            "STATE_CORRUPTION",
            "A prepared dispatch has no durable reservation admission record.",
          );
        }
        records.set(dispatch.reservationId, {
          state: previous.state,
          reservation: previous.reservation,
          admissionGlobalSequence: previous.admissionGlobalSequence,
          evidenceHistory: Object.freeze([
            ...previous.evidenceHistory,
            Object.freeze({
              globalSequence,
              recordedAt: event.occurredAt,
              observedAt: snapshot.observedAt,
              usedFiveHourBasisPoints: snapshot.fiveHour.usedBasisPoints,
              usedWeeklyBasisPoints: snapshot.weekly.usedBasisPoints,
            }),
          ]),
          releaseGlobalSequence: previous.releaseGlobalSequence,
          evidenceRecordedAt: event.occurredAt,
          evidenceObservedAt: snapshot.observedAt,
          evidenceUsedFiveHourBasisPoints: snapshot.fiveHour.usedBasisPoints,
          evidenceUsedWeeklyBasisPoints: snapshot.weekly.usedBasisPoints,
        });
        continue;
      }
      if (
        event.type !== "usage.reserved" &&
        event.type !== "attempt.retry-scheduled" &&
        event.type !== "work.completed" &&
        event.type !== "work.failed" &&
        event.type !== "work.cancelled" &&
        event.type !== "usage.reconciled"
      ) {
        continue;
      }
      const rawReservation = event.payload["reservation"];
      if (rawReservation === null || rawReservation === undefined) continue;
      // The aggregate replay immediately preceding this scan fully parsed and
      // command-validated each reservation projection.
      const reservation = rawReservation as unknown as RuntimeUsageReservation;
      if (event.type === "usage.reserved") {
        if (records.has(reservation.reservationId)) {
          throw new SchedulerError(
            "STATE_CORRUPTION",
            "A durable usage reservation identity was reused.",
          );
        }
        records.set(reservation.reservationId, {
          state: item.state,
          reservation,
          admissionGlobalSequence: globalSequence,
          evidenceHistory: Object.freeze([]),
          releaseGlobalSequence: null,
          evidenceRecordedAt: event.occurredAt,
          evidenceObservedAt: reservation.observedAt,
          evidenceUsedFiveHourBasisPoints: reservation.usedFiveHourBasisPoints,
          evidenceUsedWeeklyBasisPoints: reservation.usedWeeklyBasisPoints,
        });
      } else {
        const previous = records.get(reservation.reservationId);
        if (previous === undefined) {
          throw new SchedulerError(
            "STATE_CORRUPTION",
            "A reservation lifecycle update has no durable admission record.",
          );
        }
        records.set(reservation.reservationId, {
          state: previous.state,
          reservation,
          admissionGlobalSequence: previous.admissionGlobalSequence,
          evidenceHistory: previous.evidenceHistory,
          releaseGlobalSequence:
            previous.releaseGlobalSequence ??
            (reservation.status === "released" ||
            reservation.status === "reconciled"
              ? globalSequence
              : null),
          evidenceRecordedAt: previous.evidenceRecordedAt,
          evidenceObservedAt: previous.evidenceObservedAt,
          evidenceUsedFiveHourBasisPoints:
            previous.evidenceUsedFiveHourBasisPoints,
          evidenceUsedWeeklyBasisPoints: previous.evidenceUsedWeeklyBasisPoints,
        });
      }
    }
  }
  return Object.freeze([...records.values()]);
}

function addBasisPoints(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
    throw new SchedulerError(
      "STATE_CORRUPTION",
      "Reservation capacity contains a non-integer value.",
    );
  }
  const total = left + right;
  if (!Number.isSafeInteger(total)) {
    throw new SchedulerError(
      "STATE_CORRUPTION",
      "Reservation capacity exceeds the exact numeric bound.",
    );
  }
  return total;
}

function sameReservationAuthority(
  left: ReservationJournalRecord,
  right: ReservationJournalRecord,
): boolean {
  return (
    left.state.usageAdapter.adapterId === right.state.usageAdapter.adapterId &&
    left.state.usageAdapter.schemaVersion ===
      right.state.usageAdapter.schemaVersion &&
    left.state.definition.candidate.providerId ===
      right.state.definition.candidate.providerId &&
    left.state.definition.candidate.profileId ===
      right.state.definition.candidate.profileId
  );
}

function assertReservationOwnership(
  left: ReservationJournalRecord,
  right: ReservationJournalRecord,
  errorCode: "STATE_CORRUPTION" | "USAGE_REFUSED",
): void {
  if (
    left.state.definition.candidate.ownership !==
    right.state.definition.candidate.ownership
  ) {
    throw new SchedulerError(
      errorCode,
      "Durable usage evidence changed profile ownership classification.",
    );
  }
}

function assertWindowProgression(
  previous: {
    readonly windowId: string;
    readonly resetAt: string;
  },
  next: {
    readonly windowId: string;
    readonly resetAt: string;
  },
  transitionAt: string,
  nextObservedAt: string,
  errorCode: "STATE_CORRUPTION" | "USAGE_REFUSED",
): void {
  const sameId = previous.windowId === next.windowId;
  const sameReset = previous.resetAt === next.resetAt;
  if (
    sameId !== sameReset ||
    (!sameId &&
      (previous.resetAt > transitionAt ||
        nextObservedAt < previous.resetAt ||
        next.resetAt <= previous.resetAt))
  ) {
    throw new SchedulerError(
      errorCode,
      "Usage window identity advanced before its durable reset boundary.",
    );
  }
}

function nextCapacityGlobalSequence(
  records: readonly ReservationJournalRecord[],
): number {
  let latest = 0;
  for (const record of records) {
    latest = Math.max(latest, record.admissionGlobalSequence);
    for (const evidence of record.evidenceHistory) {
      latest = Math.max(latest, evidence.globalSequence);
    }
    if (record.releaseGlobalSequence !== null) {
      latest = Math.max(latest, record.releaseGlobalSequence);
    }
  }
  if (!Number.isSafeInteger(latest) || latest >= Number.MAX_SAFE_INTEGER) {
    throw new SchedulerError(
      "STATE_CORRUPTION",
      "The durable usage ledger exhausted its exact sequence bound.",
    );
  }
  return latest + 1;
}

function assertBorrowedReservationCaps(
  records: readonly ReservationJournalRecord[],
  errorCode: "STATE_CORRUPTION" | "USAGE_REFUSED" = "STATE_CORRUPTION",
): void {
  type Evidence = {
    readonly observedAt: string;
    readonly usedFiveHourBasisPoints: number;
    readonly usedWeeklyBasisPoints: number;
  };
  type CapacityEvent =
    | {
        readonly kind: "admission" | "observation";
        readonly globalSequence: number;
        readonly at: string;
        readonly record: ReservationJournalRecord;
        readonly evidence: Evidence;
      }
    | {
        readonly kind: "release";
        readonly globalSequence: number;
        readonly at: string;
        readonly record: ReservationJournalRecord;
      };
  type WindowIdentity = {
    readonly windowId: string;
    readonly resetAt: string;
  };

  const authorityKey = (record: ReservationJournalRecord): string =>
    toCanonicalJson([
      record.state.usageAdapter.adapterId,
      record.state.usageAdapter.schemaVersion,
      record.state.definition.candidate.providerId,
      record.state.definition.candidate.profileId,
    ]);
  const windowKey = (windowId: string, resetAt: string): string =>
    toCanonicalJson([windowId, resetAt]);
  const groups = new Map<string, ReservationJournalRecord[]>();
  const seenSequences = new Set<number>();
  const acceptSequence = (sequence: number): void => {
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      seenSequences.has(sequence)
    ) {
      throw new SchedulerError(
        errorCode,
        "Durable usage evidence has an invalid global event order.",
      );
    }
    seenSequences.add(sequence);
  };
  for (const record of records) {
    acceptSequence(record.admissionGlobalSequence);
    for (const evidence of record.evidenceHistory) {
      acceptSequence(evidence.globalSequence);
    }
    if (record.releaseGlobalSequence !== null) {
      acceptSequence(record.releaseGlobalSequence);
    }
    const key = authorityKey(record);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [record]);
    else group.push(record);
  }

  for (const group of groups.values()) {
    const ownership = group[0]!.state.definition.candidate.ownership;
    if (
      group.some(
        (record) => record.state.definition.candidate.ownership !== ownership,
      )
    ) {
      throw new SchedulerError(
        errorCode,
        "Durable usage evidence changed profile ownership classification.",
      );
    }
    const borrowed = ownership === "authorized-borrowed";
    const events: CapacityEvent[] = [];
    for (const record of group) {
      events.push({
        kind: "admission",
        globalSequence: record.admissionGlobalSequence,
        at: record.reservation.reservedAt,
        record,
        evidence: {
          observedAt: record.reservation.observedAt,
          usedFiveHourBasisPoints: record.reservation.usedFiveHourBasisPoints,
          usedWeeklyBasisPoints: record.reservation.usedWeeklyBasisPoints,
        },
      });
      for (const evidence of record.evidenceHistory) {
        events.push({
          kind: "observation",
          globalSequence: evidence.globalSequence,
          at: evidence.recordedAt,
          record,
          evidence,
        });
      }
      if (
        record.releaseGlobalSequence !== null &&
        record.reservation.reconciledAt !== null
      ) {
        events.push({
          kind: "release",
          globalSequence: record.releaseGlobalSequence,
          at: record.reservation.reconciledAt,
          record,
        });
      }
    }
    events.sort((left, right) => left.globalSequence - right.globalSequence);

    const active = new Set<string>();
    const weeklyUsed = new Map<string, number>();
    const fiveHourUsed = new Map<string, number>();
    let weeklyLiability = 0;
    let fiveHourLiability = 0;
    const reconciledWeeklyLiability = new Map<string, number>();
    const reconciledFiveHourLiability = new Map<string, number>();
    let unassignedReconciledWeeklyLiability = 0;
    let unassignedReconciledFiveHourLiability = 0;
    let latestObservedAt = "";
    let latestWeeklyIdentity: WindowIdentity | null = null;
    let latestFiveHourIdentity: WindowIdentity | null = null;

    const changeLiability = (current: number, amount: number): number => {
      const next = current + amount;
      if (!Number.isSafeInteger(next) || next < 0) {
        throw new SchedulerError(
          errorCode,
          "Durable usage liability arithmetic is inconsistent.",
        );
      }
      return next;
    };
    const assertCap = (
      at: string,
      weeklyKey: string,
      fiveHourKey: string,
      weeklyBase: number,
      fiveHourBase: number,
      extraWeekly = 0,
      extraFiveHour = 0,
    ): void => {
      if (!borrowed) return;
      const weeklyProjected = addBasisPoints(
        weeklyBase,
        addBasisPoints(
          weeklyLiability,
          addBasisPoints(
            reconciledWeeklyLiability.get(weeklyKey) ?? 0,
            extraWeekly,
          ),
        ),
      );
      const fiveHourProjected = addBasisPoints(
        fiveHourBase,
        addBasisPoints(
          fiveHourLiability,
          addBasisPoints(
            reconciledFiveHourLiability.get(fiveHourKey) ?? 0,
            extraFiveHour,
          ),
        ),
      );
      if (
        weeklyBase >= BORROWED_WEEKLY_CAP ||
        weeklyProjected > BORROWED_WEEKLY_CAP ||
        (isLondonWorkHours(new Date(at)) &&
          (fiveHourBase >= BORROWED_WORK_HOURS_FIVE_HOUR_CAP ||
            fiveHourProjected > BORROWED_WORK_HOURS_FIVE_HOUR_CAP))
      ) {
        throw new SchedulerError(
          errorCode,
          "Durable borrowed-profile reservations exceed a hard usage cap.",
        );
      }
    };

    for (const event of events) {
      const record = event.record;
      const weeklyKey = windowKey(
        record.reservation.weeklyWindowId,
        record.reservation.weeklyResetAt,
      );
      const fiveHourKey = windowKey(
        record.reservation.fiveHourWindowId,
        record.reservation.fiveHourResetAt,
      );
      if (event.kind === "release") {
        if (!active.delete(record.reservation.reservationId)) {
          throw new SchedulerError(
            errorCode,
            "A durable usage reservation was released before admission.",
          );
        }
        weeklyLiability = changeLiability(
          weeklyLiability,
          -record.reservation.predictedWeeklyBasisPoints,
        );
        fiveHourLiability = changeLiability(
          fiveHourLiability,
          -record.reservation.predictedFiveHourBasisPoints,
        );
        if (record.reservation.status === "reconciled") {
          if (event.at < record.reservation.weeklyResetAt) {
            reconciledWeeklyLiability.set(
              weeklyKey,
              changeLiability(
                reconciledWeeklyLiability.get(weeklyKey) ?? 0,
                record.reservation.predictedWeeklyBasisPoints,
              ),
            );
          } else {
            unassignedReconciledWeeklyLiability = changeLiability(
              unassignedReconciledWeeklyLiability,
              record.reservation.predictedWeeklyBasisPoints,
            );
          }
          if (event.at < record.reservation.fiveHourResetAt) {
            reconciledFiveHourLiability.set(
              fiveHourKey,
              changeLiability(
                reconciledFiveHourLiability.get(fiveHourKey) ?? 0,
                record.reservation.predictedFiveHourBasisPoints,
              ),
            );
          } else {
            unassignedReconciledFiveHourLiability = changeLiability(
              unassignedReconciledFiveHourLiability,
              record.reservation.predictedFiveHourBasisPoints,
            );
          }
        }
        continue;
      }

      const weeklyIdentity = {
        windowId: record.reservation.weeklyWindowId,
        resetAt: record.reservation.weeklyResetAt,
      };
      const fiveHourIdentity = {
        windowId: record.reservation.fiveHourWindowId,
        resetAt: record.reservation.fiveHourResetAt,
      };
      if (latestWeeklyIdentity !== null) {
        assertWindowProgression(
          latestWeeklyIdentity,
          weeklyIdentity,
          event.at,
          event.evidence.observedAt,
          errorCode,
        );
      }
      if (latestFiveHourIdentity !== null) {
        assertWindowProgression(
          latestFiveHourIdentity,
          fiveHourIdentity,
          event.at,
          event.evidence.observedAt,
          errorCode,
        );
      }
      if (
        latestObservedAt !== "" &&
        event.evidence.observedAt < latestObservedAt
      ) {
        throw new SchedulerError(
          errorCode,
          "Usage evidence moved backwards for a durable authority.",
        );
      }
      const priorWeekly = weeklyUsed.get(weeklyKey) ?? 0;
      const priorFiveHour = fiveHourUsed.get(fiveHourKey) ?? 0;
      if (
        event.evidence.usedWeeklyBasisPoints < priorWeekly ||
        event.evidence.usedFiveHourBasisPoints < priorFiveHour
      ) {
        throw new SchedulerError(
          errorCode,
          "Usage evidence moved backwards within a durable source window.",
        );
      }
      const admission = event.kind === "admission";
      if (admission && active.has(record.reservation.reservationId)) {
        throw new SchedulerError(
          errorCode,
          "A durable usage reservation identity was admitted twice.",
        );
      }
      const weeklyBase = Math.max(
        priorWeekly,
        event.evidence.usedWeeklyBasisPoints,
      );
      const fiveHourBase = Math.max(
        priorFiveHour,
        event.evidence.usedFiveHourBasisPoints,
      );
      if (unassignedReconciledWeeklyLiability > 0) {
        reconciledWeeklyLiability.set(
          weeklyKey,
          changeLiability(
            reconciledWeeklyLiability.get(weeklyKey) ?? 0,
            unassignedReconciledWeeklyLiability,
          ),
        );
        unassignedReconciledWeeklyLiability = 0;
      }
      if (unassignedReconciledFiveHourLiability > 0) {
        reconciledFiveHourLiability.set(
          fiveHourKey,
          changeLiability(
            reconciledFiveHourLiability.get(fiveHourKey) ?? 0,
            unassignedReconciledFiveHourLiability,
          ),
        );
        unassignedReconciledFiveHourLiability = 0;
      }
      assertCap(
        event.at,
        weeklyKey,
        fiveHourKey,
        weeklyBase,
        fiveHourBase,
        admission ? record.reservation.predictedWeeklyBasisPoints : 0,
        admission ? record.reservation.predictedFiveHourBasisPoints : 0,
      );
      weeklyUsed.set(weeklyKey, weeklyBase);
      fiveHourUsed.set(fiveHourKey, fiveHourBase);
      latestObservedAt = event.evidence.observedAt;
      latestWeeklyIdentity = weeklyIdentity;
      latestFiveHourIdentity = fiveHourIdentity;
      if (admission) {
        active.add(record.reservation.reservationId);
        weeklyLiability = changeLiability(
          weeklyLiability,
          record.reservation.predictedWeeklyBasisPoints,
        );
        fiveHourLiability = changeLiability(
          fiveHourLiability,
          record.reservation.predictedFiveHourBasisPoints,
        );
      }
    }
  }
}

function assertReservationAdmissionEvidence(
  records: readonly ReservationJournalRecord[],
  state: WorkerRuntimeState,
  reservation: RuntimeUsageReservation,
): void {
  const target: ReservationJournalRecord = {
    state,
    reservation,
    admissionGlobalSequence: nextCapacityGlobalSequence(records),
    evidenceHistory: Object.freeze([]),
    releaseGlobalSequence: null,
    evidenceRecordedAt: reservation.reservedAt,
    evidenceObservedAt: reservation.observedAt,
    evidenceUsedFiveHourBasisPoints: reservation.usedFiveHourBasisPoints,
    evidenceUsedWeeklyBasisPoints: reservation.usedWeeklyBasisPoints,
  };
  for (const other of records) {
    if (!sameReservationAuthority(target, other)) continue;
    assertReservationOwnership(target, other, "USAGE_REFUSED");
    assertWindowProgression(
      {
        windowId: other.reservation.weeklyWindowId,
        resetAt: other.reservation.weeklyResetAt,
      },
      {
        windowId: reservation.weeklyWindowId,
        resetAt: reservation.weeklyResetAt,
      },
      reservation.reservedAt,
      reservation.observedAt,
      "USAGE_REFUSED",
    );
    assertWindowProgression(
      {
        windowId: other.reservation.fiveHourWindowId,
        resetAt: other.reservation.fiveHourResetAt,
      },
      {
        windowId: reservation.fiveHourWindowId,
        resetAt: reservation.fiveHourResetAt,
      },
      reservation.reservedAt,
      reservation.observedAt,
      "USAGE_REFUSED",
    );
    if (
      other.evidenceObservedAt > reservation.observedAt ||
      (other.reservation.weeklyResetAt === reservation.weeklyResetAt &&
        (other.evidenceObservedAt > reservation.observedAt ||
          other.evidenceUsedWeeklyBasisPoints >
            reservation.usedWeeklyBasisPoints)) ||
      (other.reservation.fiveHourResetAt === reservation.fiveHourResetAt &&
        (other.evidenceObservedAt > reservation.observedAt ||
          other.evidenceUsedFiveHourBasisPoints >
            reservation.usedFiveHourBasisPoints))
    ) {
      throw new SchedulerError(
        "USAGE_REFUSED",
        "Usage evidence moved backwards within a durable source window.",
      );
    }
  }
}

function withProspectiveUsageEvidence(
  records: readonly ReservationJournalRecord[],
  state: WorkerRuntimeState,
  reservation: RuntimeUsageReservation,
  snapshot: UsageCapacityEvidence,
  at: string,
): readonly ReservationJournalRecord[] {
  const globalSequence = nextCapacityGlobalSequence(records);
  let found = false;
  const next = records.map((record): ReservationJournalRecord => {
    if (record.reservation.reservationId !== reservation.reservationId) {
      return record;
    }
    if (found) {
      throw new SchedulerError(
        "STATE_CORRUPTION",
        "A durable usage reservation identity was reused.",
      );
    }
    found = true;
    return Object.freeze({
      ...record,
      state,
      reservation,
      evidenceHistory: Object.freeze([
        ...record.evidenceHistory,
        Object.freeze({
          globalSequence,
          recordedAt: at,
          observedAt: snapshot.observedAt,
          usedFiveHourBasisPoints: snapshot.fiveHour.usedBasisPoints,
          usedWeeklyBasisPoints: snapshot.weekly.usedBasisPoints,
        }),
      ]),
      evidenceRecordedAt: at,
      evidenceObservedAt: snapshot.observedAt,
      evidenceUsedFiveHourBasisPoints: snapshot.fiveHour.usedBasisPoints,
      evidenceUsedWeeklyBasisPoints: snapshot.weekly.usedBasisPoints,
    });
  });
  if (!found) {
    throw new SchedulerError(
      "STATE_CORRUPTION",
      "Usage evidence has no durable reservation admission record.",
    );
  }
  return Object.freeze(next);
}

async function listStates(
  tx: TransactionContext,
  expectedConfigurationFingerprint?: string,
): Promise<
  readonly {
    readonly state: WorkerRuntimeState;
    readonly events: readonly WorkerRuntimeEvent[];
    readonly journal: readonly WorkerJournalEntry[];
    readonly envelope: AggregateEnvelope;
  }[]
> {
  const loaded: Array<{
    readonly state: WorkerRuntimeState;
    readonly events: readonly WorkerRuntimeEvent[];
    readonly journal: readonly WorkerJournalEntry[];
    readonly envelope: AggregateEnvelope;
  }> = [];
  let cursor: string | null = null;
  do {
    const page = await tx.aggregates.list({
      aggregateType: AGGREGATE_TYPE,
      limit: 100,
      cursor,
    });
    for (const envelope of page.items) {
      if (!envelope.aggregateId.startsWith(AGGREGATE_PREFIX)) continue;
      const item = await loadState(
        tx,
        envelope.aggregateId,
        envelope,
        expectedConfigurationFingerprint,
      );
      if (item !== null) loaded.push(item);
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  assertBorrowedReservationCaps(reservationJournalRecords(loaded));
  return Object.freeze(loaded);
}

function duplicateCommand(
  events: readonly WorkerRuntimeEvent[],
  commandId: string,
  fingerprint: string,
): boolean {
  const existing = events.find((event) => event.commandId === commandId);
  if (existing === undefined) return false;
  if (existing.commandFingerprint !== fingerprint) {
    throw new SchedulerError(
      "IDEMPOTENCY_CONFLICT",
      "A worker command identifier was reused with different content.",
    );
  }
  return true;
}

async function appendEvent(
  tx: TransactionContext,
  loaded: {
    readonly state: WorkerRuntimeState;
    readonly events: readonly WorkerRuntimeEvent[];
    readonly envelope: AggregateEnvelope;
  },
  event: WorkerRuntimeEvent,
  fault: ((point: WorkerRuntimeFaultPoint) => Promise<void> | void) | undefined,
): Promise<WorkerRuntimeState> {
  if (
    duplicateCommand(loaded.events, event.commandId, event.commandFingerprint)
  ) {
    return loaded.state;
  }
  const next = applyWorkerRuntimeEvent(loaded.state, event);
  const aggregateVersion = loaded.envelope.aggregateVersion + 1;
  if (aggregateVersion !== event.sequence) {
    throw new SchedulerError(
      "STATE_CORRUPTION",
      "Worker aggregate and event versions diverged.",
    );
  }
  await tx.aggregates.update({
    aggregateType: AGGREGATE_TYPE,
    aggregateId: loaded.envelope.aggregateId,
    schemaVersion: WORKER_RUNTIME_SCHEMA_VERSION,
    payload: next as unknown as JsonObject,
    expectedVersion: loaded.envelope.aggregateVersion,
    traceId: loaded.state.definition.task.correlationId,
  });
  await fault?.("after-aggregate-before-event");
  await tx.events.append({
    eventId: event.eventId,
    aggregateType: AGGREGATE_TYPE,
    aggregateId: loaded.envelope.aggregateId,
    aggregateVersion,
    eventType: event.type,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    payload: { event },
    occurredAt: event.occurredAt,
    traceId: loaded.state.definition.task.correlationId,
    causationId: loaded.state.lastEventId,
  });
  return next;
}

function eventFor(
  loaded: { readonly state: WorkerRuntimeState },
  command: unknown & { readonly commandId: string },
  occurredAt: string,
  type: WorkerRuntimeEvent["type"],
  payload: unknown,
): WorkerRuntimeEvent {
  return createWorkerRuntimeEvent({
    workId: loaded.state.definition.workId,
    sequence: loaded.state.sequence + 1,
    occurredAt,
    type,
    command,
    payload,
  });
}

function priorityRank(
  priority: WorkerRuntimeState["definition"]["task"]["priority"],
): number {
  return priority === "critical"
    ? 3
    : priority === "high"
      ? 2
      : priority === "normal"
        ? 1
        : 0;
}

function effectivePriority(
  state: WorkerRuntimeState,
  nowMs: number,
  agingMs: number,
): number {
  if (state.readySince === null) {
    throw new SchedulerError(
      "STATE_CORRUPTION",
      "Only ready work may participate in queue aging.",
    );
  }
  const waited = Math.max(0, nowMs - Date.parse(state.readySince));
  return Math.min(
    3,
    priorityRank(state.definition.task.priority) + Math.floor(waited / agingMs),
  );
}

function isTerminal(state: WorkerRuntimeState): boolean {
  return (
    state.status === "completed" ||
    state.status === "failed" ||
    state.status === "cancelled"
  );
}

function usagePermitsAnotherAttempt(state: WorkerRuntimeState): boolean {
  const projected = addNormalizedUsage(
    state.cumulativeUsage,
    state.definition.estimatedUsage,
  );
  return (
    projected.costMicros !== null &&
    usageWithinTaskBudget(state.definition, projected)
  );
}

function assertReservableState(state: WorkerRuntimeState): void {
  if (
    state.status !== "leased" ||
    state.reservation !== null ||
    !usagePermitsAnotherAttempt(state)
  ) {
    throw new SchedulerError(
      "INVALID_TRANSITION",
      "Reservation requires an unreserved leased attempt.",
    );
  }
}

function assertPreparableState(state: WorkerRuntimeState): void {
  if (
    state.status !== "leased" ||
    state.reservation?.status !== "reserved" ||
    state.dispatch !== null
  ) {
    throw new SchedulerError(
      "INVALID_TRANSITION",
      "Dispatch requires a reserved leased attempt.",
    );
  }
}

function assertStartableState(
  state: WorkerRuntimeState,
  dispatchId: string,
): RuntimeDispatchIntent {
  const dispatch = state.dispatch;
  if (
    state.status !== "leased" ||
    state.reservation?.status !== "reserved" ||
    dispatch?.status !== "prepared" ||
    dispatch.dispatchId !== dispatchId
  ) {
    throw new SchedulerError(
      "INVALID_TRANSITION",
      "Only the exact reserved and prepared dispatch may start.",
    );
  }
  return dispatch;
}

function isKnownZeroUsage(usage: NormalizedUsage): boolean {
  return (
    usage.inputTokens === 0 &&
    usage.cachedInputTokens === 0 &&
    usage.cacheWriteInputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.reasoningTokens === 0 &&
    usage.toolCalls === 0 &&
    usage.costMicros === 0
  );
}

function assertFenced(
  state: WorkerRuntimeState,
  command: FencedWorkCommand,
  now: string,
): WorkerLease {
  const lease = state.lease;
  if (
    lease === null ||
    lease.leaseId !== command.leaseId ||
    lease.workerId !== command.workerId ||
    lease.fencingToken !== command.fencingToken
  ) {
    throw new SchedulerError(
      "FENCING_REJECTED",
      "The worker command does not own the exact current lease and fencing token.",
    );
  }
  if (lease.expiresAt <= now) {
    throw new SchedulerError("LEASE_CONFLICT", "The worker lease has expired.");
  }
  if (state.definition.task.deadline <= now) {
    throw new SchedulerError(
      "LEASE_CONFLICT",
      "The worker task deadline has expired.",
    );
  }
  return lease;
}

function assertCircuit(
  raw: ProviderCircuitEvidence,
  state: WorkerRuntimeState,
  now: Date,
  maximumAgeMs: number,
): ProviderCircuitEvidence {
  const circuit = parseProviderCircuitEvidence(raw);
  if (
    circuit.providerId !== state.definition.candidate.providerId ||
    circuit.profileId !== state.definition.candidate.profileId
  ) {
    throw new SchedulerError(
      "CIRCUIT_OPEN",
      "Circuit evidence is bound to another route.",
    );
  }
  const observed = Date.parse(circuit.observedAt);
  if (
    circuit.state !== "closed" ||
    observed > now.valueOf() ||
    now.valueOf() - observed > maximumAgeMs
  ) {
    throw new SchedulerError(
      "CIRCUIT_OPEN",
      "Provider circuit evidence is open, stale, or future-dated.",
    );
  }
  return circuit;
}

function assertCircuitRefresh(
  previous: ProviderCircuitEvidence,
  next: ProviderCircuitEvidence,
): void {
  if (
    next.sourceFingerprint !== previous.sourceFingerprint ||
    next.observedAt < previous.observedAt
  ) {
    throw new SchedulerError(
      "CIRCUIT_OPEN",
      "Refreshed circuit evidence changed source identity or moved backwards.",
    );
  }
}

function assertStaticRouteEligibility(
  state: WorkerRuntimeState,
  now: Date,
  maximumAgeMs: number,
): void {
  const evaluation = evaluateStaticRouteEligibility({
    task: state.definition.task,
    workloadClass: state.definition.workloadClass,
    candidate: state.definition.candidate,
    now,
    maximumSnapshotAgeMs: maximumAgeMs,
  });
  if (!evaluation.eligible) {
    throw new SchedulerError(
      "USAGE_REFUSED",
      "The exact persisted route candidate is not statically eligible.",
    );
  }
}

function assertNativeUsageAdapterBinding(
  adapter: WorkerRuntimeOptions["usageAdapter"],
  state: WorkerRuntimeState,
): void {
  let liveBinding: RuntimeUsageAdapterBinding;
  try {
    liveBinding = parseRuntimeUsageAdapterBinding({
      adapterId: adapter.adapterId,
      schemaVersion: adapter.schemaVersion,
    });
  } catch {
    throw new SchedulerError(
      "USAGE_REFUSED",
      "The live usage adapter binding is invalid.",
    );
  }
  if (
    liveBinding.schemaVersion !== 2 ||
    liveBinding.adapterId !== state.usageAdapter.adapterId ||
    liveBinding.schemaVersion !== state.usageAdapter.schemaVersion
  ) {
    throw new SchedulerError(
      "USAGE_REFUSED",
      "Runtime authorization requires the exact persisted native usage adapter binding.",
    );
  }
}

async function readFreshUsage(
  adapter: WorkerRuntimeOptions["usageAdapter"],
  state: WorkerRuntimeState,
  circuit: ProviderCircuitEvidence,
  now: Date,
  configuration: WorkerRuntimeConfiguration,
  registerRead: (controller: AbortController) => void,
  unregisterRead: (controller: AbortController) => void,
): Promise<NormalizedCanonicalUsageSnapshot> {
  let raw: unknown | null;
  assertStaticRouteEligibility(state, now, configuration.usageFreshnessMs);
  assertNativeUsageAdapterBinding(adapter, state);
  const deadlineMs = Math.min(
    now.valueOf() + configuration.usageReadTimeoutMs,
    state.lease === null
      ? Date.parse(state.definition.task.deadline)
      : Date.parse(state.lease.expiresAt),
    Date.parse(state.definition.task.deadline),
  );
  if (deadlineMs <= now.valueOf()) {
    throw new SchedulerError(
      "USAGE_REFUSED",
      "The bounded usage-read window has expired.",
    );
  }
  const controller = new AbortController();
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new Error("usage-read-aborted")),
      { once: true },
    );
  });
  registerRead(controller);
  const timer = setTimeout(
    () => controller.abort(),
    deadlineMs - now.valueOf(),
  );
  try {
    raw = await Promise.race([
      adapter.readAuthorizedSnapshot(state.definition.candidate.profileId, {
        signal: controller.signal,
        deadline: new Date(deadlineMs).toISOString(),
      }),
      aborted,
    ]);
  } catch {
    throw new SchedulerError(
      "USAGE_REFUSED",
      "The usage adapter refused the scoped snapshot.",
    );
  } finally {
    clearTimeout(timer);
    unregisterRead(controller);
    controller.abort();
  }
  assertNativeUsageAdapterBinding(adapter, state);
  if (raw === null) {
    throw new SchedulerError(
      "USAGE_REFUSED",
      "A fresh scoped usage snapshot is required.",
    );
  }
  let snapshot: NormalizedCanonicalUsageSnapshot;
  try {
    const rawSnapshot = ensureRecord(raw, "usageSnapshot");
    if (rawSnapshot["schemaVersion"] !== 2) {
      throw new SchedulerError(
        "USAGE_REFUSED",
        "Runtime authorization requires matching native usage schema v2 evidence.",
      );
    }
    snapshot = parseCanonicalUsageSnapshot(raw);
  } catch {
    throw new SchedulerError(
      "USAGE_REFUSED",
      "The usage adapter returned invalid evidence.",
    );
  }
  return assertFreshUsageSnapshot(
    state,
    circuit,
    snapshot,
    now,
    configuration,
  );
}

function assertFreshUsageSnapshot(
  state: WorkerRuntimeState,
  circuit: ProviderCircuitEvidence,
  snapshot: NormalizedCanonicalUsageSnapshot,
  now: Date,
  configuration: WorkerRuntimeConfiguration,
): NormalizedCanonicalUsageSnapshot {
  const candidate = state.definition.candidate;
  const validity = validateUsageFreshness(
    snapshot,
    now,
    configuration.usageFreshnessMs,
  );
  const decision = routeTask({
    task: state.definition.task,
    workloadClass: state.definition.workloadClass,
    preference: "balanced",
    candidates: [candidate],
    usageSnapshots: [snapshot],
    now,
    maximumSnapshotAgeMs: configuration.usageFreshnessMs,
  });
  if (
    !validity.eligible ||
    decision.selected?.candidateId !== candidate.candidateId ||
    snapshot.sourceAdapterId !== state.usageAdapter.adapterId ||
    snapshot.profileId !== candidate.profileId ||
    snapshot.providerId !== candidate.providerId ||
    snapshot.ownership !== candidate.ownership
  ) {
    throw new SchedulerError(
      "USAGE_REFUSED",
      "The usage snapshot did not authorize the exact selected route.",
    );
  }
  return snapshot;
}

function reservationFor(
  state: WorkerRuntimeState,
  snapshot: NormalizedCanonicalUsageSnapshot,
  circuit: ProviderCircuitEvidence,
  at: string,
): RuntimeUsageReservation {
  const reservationId = `reservation:${createHash("sha256")
    .update(
      toCanonicalJson({
        definitionFingerprint: state.definitionFingerprint,
        attempt: state.attempt,
        snapshotId: snapshot.snapshotId,
      }),
    )
    .digest("hex")
    .slice(0, 32)}`;
  return Object.freeze({
    reservationId,
    snapshotId: snapshot.snapshotId,
    sourceAdapterVersion: snapshot.sourceAdapterVersion,
    sourceFingerprint: snapshot.sourceFingerprint,
    observedAt: snapshot.observedAt,
    fiveHourWindowId: snapshot.fiveHour.windowId,
    fiveHourResetAt: snapshot.fiveHour.resetAt,
    weeklyWindowId: snapshot.weekly.windowId,
    weeklyResetAt: snapshot.weekly.resetAt,
    usedFiveHourBasisPoints: snapshot.fiveHour.usedBasisPoints,
    usedWeeklyBasisPoints: snapshot.weekly.usedBasisPoints,
    predictedFiveHourBasisPoints:
      state.definition.candidate.predictedFiveHourBasisPoints,
    predictedWeeklyBasisPoints:
      state.definition.candidate.predictedWeeklyBasisPoints,
    estimatedUsage: state.definition.estimatedUsage,
    circuit,
    reservedAt: at,
    status: "reserved",
    actualUsage: null,
    reconciledAt: null,
  });
}

function assertReservationRefresh(
  state: WorkerRuntimeState,
  snapshot: NormalizedCanonicalUsageSnapshot,
): RuntimeUsageReservation {
  const reservation = state.reservation;
  if (reservation === null || reservation.status !== "reserved") {
    throw new SchedulerError(
      "USAGE_REFUSED",
      "A current usage reservation is required.",
    );
  }
  if (
    snapshot.sourceAdapterVersion !== reservation.sourceAdapterVersion ||
    snapshot.sourceFingerprint !== reservation.sourceFingerprint ||
    snapshot.fiveHour.windowId !== reservation.fiveHourWindowId ||
    snapshot.fiveHour.resetAt !== reservation.fiveHourResetAt ||
    snapshot.weekly.windowId !== reservation.weeklyWindowId ||
    snapshot.weekly.resetAt !== reservation.weeklyResetAt ||
    snapshot.observedAt < reservation.observedAt ||
    snapshot.fiveHour.usedBasisPoints < reservation.usedFiveHourBasisPoints ||
    snapshot.weekly.usedBasisPoints < reservation.usedWeeklyBasisPoints
  ) {
    throw new SchedulerError(
      "USAGE_REFUSED",
      "Refreshed usage changed source/window identity or moved backwards.",
    );
  }
  return reservation;
}

function dispatchFor(
  state: WorkerRuntimeState,
  reservation: RuntimeUsageReservation,
  snapshot: NormalizedCanonicalUsageSnapshot,
  circuit: ProviderCircuitEvidence,
  at: string,
): RuntimeDispatchIntent {
  const route = routeForDefinition(state.definition);
  const material = {
    definitionFingerprint: state.definitionFingerprint,
    attempt: state.attempt,
    route,
    reservationId: reservation.reservationId,
  };
  const dispatchId = `dispatch:${createHash("sha256")
    .update(toCanonicalJson(material))
    .digest("hex")
    .slice(0, 32)}`;
  const requestFingerprint = createHash("sha256")
    .update(
      toCanonicalJson({
        ...material,
        dispatchId,
        usageSnapshot: snapshot,
        circuit,
      }),
    )
    .digest("hex");
  return Object.freeze({
    dispatchId,
    route,
    reservationId: reservation.reservationId,
    usageSnapshotId: snapshot.snapshotId,
    circuit,
    requestFingerprint,
    preparedAt: at,
    status: "prepared",
    startedAt: null,
    terminalAt: null,
  });
}

function terminalReceipt(
  outcome: WorkerRuntimeTerminal["outcome"],
  codeValue: string,
  classification: WorkerRuntimeTerminal["classification"],
  actualUsage: NormalizedUsage,
  at: string,
): WorkerRuntimeTerminal {
  return Object.freeze({
    outcome,
    code: finiteCode(codeValue, "terminal.code"),
    classification,
    actualUsage,
    finishedAt: at,
  });
}

function retryAt(state: WorkerRuntimeState, at: string): string {
  const exponent = Math.max(0, state.attempt - 1);
  const delay = Math.min(
    state.definition.task.retry.maximumBackoffMs,
    state.definition.task.retry.initialBackoffMs * 2 ** exponent,
  );
  return addMs(at, delay);
}

export function createProductionDisabledWorkerRuntime(
  options: WorkerRuntimeOptions,
): DurableWorkerRuntime {
  const persistence: PersistenceAdapter = options.persistence;
  const clock = options.clock ?? systemClock;
  if (
    options.usageAdapter === null ||
    typeof options.usageAdapter !== "object" ||
    typeof options.usageAdapter.readAuthorizedSnapshot !== "function"
  ) {
    throw new SchedulerError("INVALID_TASK", "The usage adapter is invalid.");
  }
  const configuration = parseWorkerRuntimeConfiguration(
    options.configuration ?? DEFAULT_WORKER_RUNTIME_CONFIGURATION,
  );
  const usageAdapter = parseRuntimeUsageAdapterBinding({
    adapterId: options.usageAdapter.adapterId,
    schemaVersion: options.usageAdapter.schemaVersion,
  });
  const configurationFingerprint = createHash("sha256")
    .update(toCanonicalJson({ configuration, usageAdapter }))
    .digest("hex");
  const poolLimits = new Map(
    configuration.capacityPools.map(
      (pool) => [pool.poolId, pool.maximumActive] as const,
    ),
  );
  let closed = false;
  const activeUsageReads = new Set<AbortController>();

  const assertOpen = (): void => {
    if (closed)
      throw new SchedulerError(
        "STATE_CORRUPTION",
        "The worker runtime is closed.",
      );
  };
  const registerUsageRead = (controller: AbortController): void => {
    assertOpen();
    activeUsageReads.add(controller);
  };
  const unregisterUsageRead = (controller: AbortController): void => {
    activeUsageReads.delete(controller);
  };

  async function mutate(
    idempotencyKey: string,
    command: unknown & { readonly commandId: string },
    build: (
      loaded: {
        readonly state: WorkerRuntimeState;
        readonly events: readonly WorkerRuntimeEvent[];
        readonly envelope: AggregateEnvelope;
      },
      at: string,
    ) => {
      readonly type: WorkerRuntimeEvent["type"];
      readonly payload: unknown;
    } | null,
  ): Promise<WorkerRuntimeState> {
    assertOpen();
    const aggregateId = aggregateIdFor(
      parseWorkerRuntimeIdempotencyKey(
        idempotencyKey,
        "command.idempotencyKey",
      ),
    );
    const fingerprint = workerCommandFingerprint(command);
    return persistence.transact(async (tx) => {
      const loaded = await loadState(
        tx,
        aggregateId,
        undefined,
        configurationFingerprint,
      );
      if (loaded === null)
        throw new SchedulerError(
          "NOT_FOUND",
          "The worker work item does not exist.",
        );
      if (
        duplicateCommand(
          loaded.events,
          finiteId(command.commandId, "command.commandId"),
          fingerprint,
        )
      ) {
        return loaded.state;
      }
      const at = clockNow(clock).toISOString();
      const transition = build(loaded, at);
      if (transition === null) return loaded.state;
      const event = eventFor(
        loaded,
        command,
        at,
        transition.type,
        transition.payload,
      );
      return appendEvent(tx, loaded, event, options.fault);
    });
  }

  async function preflightExternalRead(
    idempotencyKey: string,
    command: unknown & { readonly commandId: string },
  ): Promise<{
    readonly state: WorkerRuntimeState;
    readonly duplicate: boolean;
  }> {
    assertOpen();
    const aggregateId = aggregateIdFor(
      parseWorkerRuntimeIdempotencyKey(
        idempotencyKey,
        "command.idempotencyKey",
      ),
    );
    const fingerprint = workerCommandFingerprint(command);
    return persistence.transact(async (tx) => {
      const loaded = await loadState(
        tx,
        aggregateId,
        undefined,
        configurationFingerprint,
      );
      if (loaded === null) {
        throw new SchedulerError(
          "NOT_FOUND",
          "The worker work item does not exist.",
        );
      }
      return Object.freeze({
        state: loaded.state,
        duplicate: duplicateCommand(
          loaded.events,
          finiteId(command.commandId, "command.commandId"),
          fingerprint,
        ),
      });
    });
  }

  const runtime: DurableWorkerRuntime = Object.freeze({
    async enqueue(command: EnqueueWorkCommand) {
      assertOpen();
      command = commandOf(command, "enqueue-work");
      const commandId = finiteId(command.commandId, "command.commandId");
      const definition = parseWorkerWorkDefinition(command.definition);
      if (!poolLimits.has(definition.capacityPool)) {
        throw new SchedulerError(
          "CAPACITY_UNAVAILABLE",
          "The requested capacity pool is not configured.",
        );
      }
      const aggregateId = aggregateIdFor(definition.task.idempotencyKey);
      const fingerprint = workerCommandFingerprint(command);
      const definitionFingerprint = workerDefinitionFingerprint(definition);
      return persistence.transact(async (tx) => {
        const existingStates = await listStates(tx, configurationFingerprint);
        const existing = existingStates.find(
          (item) => item.envelope.aggregateId === aggregateId,
        );
        if (existing !== undefined) {
          if (existing.state.definitionFingerprint !== definitionFingerprint) {
            throw new SchedulerError(
              "IDEMPOTENCY_CONFLICT",
              "The work idempotency key was reused with different content.",
            );
          }
          duplicateCommand(existing.events, commandId, fingerprint);
          return Object.freeze({
            outcome: "duplicate" as const,
            state: existing.state,
          });
        }
        if (
          existingStates.some(
            ({ state }) =>
              state.definition.workId === definition.workId ||
              state.definition.task.taskId === definition.task.taskId,
          )
        ) {
          throw new SchedulerError(
            "IDEMPOTENCY_CONFLICT",
            "The work or task identity is already bound to another idempotency key.",
          );
        }
        if (existingStates.length >= configuration.maximumRetainedWorkItems) {
          throw new SchedulerError(
            "BACKPRESSURE",
            "The bounded durable work-history ledger is full.",
          );
        }
        const queued = existingStates.filter(
          (item) => !isTerminal(item.state),
        ).length;
        if (queued >= configuration.maximumQueueDepth) {
          throw new SchedulerError(
            "BACKPRESSURE",
            "The durable ready queue is full.",
          );
        }
        const at = clockNow(clock).toISOString();
        const event = createWorkerRuntimeEvent({
          workId: definition.workId,
          sequence: 1,
          occurredAt: at,
          type: "work.enqueued",
          command,
          payload: {
            definition,
            definitionFingerprint,
            configuration,
            usageAdapter,
            configurationFingerprint,
          },
        });
        const state = replayWorkerRuntimeEvents([event]);
        await tx.aggregates.create({
          aggregateType: AGGREGATE_TYPE,
          aggregateId,
          schemaVersion: WORKER_RUNTIME_SCHEMA_VERSION,
          payload: state,
          traceId: definition.task.correlationId,
        });
        await options.fault?.("after-aggregate-before-event");
        await tx.events.append({
          eventId: event.eventId,
          aggregateType: AGGREGATE_TYPE,
          aggregateId,
          aggregateVersion: 1,
          eventType: event.type,
          eventSchemaVersion: EVENT_SCHEMA_VERSION,
          payload: { event },
          occurredAt: at,
          traceId: definition.task.correlationId,
          causationId: null,
        });
        return Object.freeze({ outcome: "created" as const, state });
      });
    },

    async get(idempotencyKey: string): Promise<WorkerRuntimeState | null> {
      assertOpen();
      return persistence.transact(
        async (tx) =>
          (
            await loadState(
              tx,
              aggregateIdFor(
                parseWorkerRuntimeIdempotencyKey(
                  idempotencyKey,
                  "idempotencyKey",
                ),
              ),
              undefined,
              configurationFingerprint,
            )
          )?.state ?? null,
      );
    },

    async list(): Promise<readonly WorkerRuntimeState[]> {
      assertOpen();
      return persistence.transact(async (tx) =>
        Object.freeze(
          (await listStates(tx, configurationFingerprint))
            .map((item) => item.state)
            .sort(
              (left, right) =>
                stableCodeUnitCompare(
                  left.definition.task.createdAt,
                  right.definition.task.createdAt,
                ) ||
                stableCodeUnitCompare(
                  left.definition.workId,
                  right.definition.workId,
                ),
            ),
        ),
      );
    },

    async history(
      idempotencyKey: string,
    ): Promise<readonly WorkerRuntimeEvent[]> {
      assertOpen();
      return persistence.transact(
        async (tx) =>
          (
            await loadState(
              tx,
              aggregateIdFor(
                parseWorkerRuntimeIdempotencyKey(
                  idempotencyKey,
                  "idempotencyKey",
                ),
              ),
              undefined,
              configurationFingerprint,
            )
          )?.events ?? Object.freeze([]),
      );
    },

    async claim(command: ClaimWorkCommand): Promise<WorkerRuntimeState | null> {
      assertOpen();
      command = commandOf(command, "claim-work");
      const commandId = finiteId(command.commandId, "command.commandId");
      const workerId = finiteId(command.workerId, "command.workerId");
      const allowedPools = ensureArray(
        command.allowedCapacityPools,
        "command.allowedCapacityPools",
        64,
      ).map((pool, index) =>
        finiteId(pool, `command.allowedCapacityPools[${index}]`),
      );
      if (
        allowedPools.length === 0 ||
        new Set(allowedPools).size !== allowedPools.length
      ) {
        throw new SchedulerError(
          "INVALID_TASK",
          "Claim capacity pools must be nonempty and unique.",
        );
      }
      for (const pool of allowedPools) {
        if (!poolLimits.has(pool)) {
          throw new SchedulerError(
            "CAPACITY_UNAVAILABLE",
            "A claimed capacity pool is not configured.",
          );
        }
      }
      const fingerprint = workerCommandFingerprint(command);
      return persistence.transact(async (tx) => {
        const all = await listStates(tx, configurationFingerprint);
        for (const item of all) {
          if (duplicateCommand(item.events, commandId, fingerprint))
            return item.state;
        }
        const now = clockNow(clock);
        const nowIso = now.toISOString();
        const activeByPool = new Map<string, number>();
        const attemptsByFairnessKey = new Map<string, number>();
        for (const item of all) {
          const state = item.state;
          if (!isTerminal(state)) {
            attemptsByFairnessKey.set(
              state.definition.fairnessKey,
              (attemptsByFairnessKey.get(state.definition.fairnessKey) ?? 0) +
                state.attempt,
            );
          }
          if (state.status === "leased" || state.status === "running") {
            activeByPool.set(
              state.definition.capacityPool,
              (activeByPool.get(state.definition.capacityPool) ?? 0) + 1,
            );
          }
        }
        const eligible = all.filter(
          ({ state }) =>
            state.status === "ready" &&
            state.definition.readyAt <= nowIso &&
            state.definition.task.deadline > nowIso &&
            state.attempt < state.definition.task.retry.maximumAttempts &&
            usagePermitsAnotherAttempt(state) &&
            allowedPools.includes(state.definition.capacityPool) &&
            (activeByPool.get(state.definition.capacityPool) ?? 0) <
              (poolLimits.get(state.definition.capacityPool) ?? 0),
        );
        eligible.sort(
          (left, right) =>
            effectivePriority(
              right.state,
              now.valueOf(),
              configuration.starvationAgingMs,
            ) -
              effectivePriority(
                left.state,
                now.valueOf(),
                configuration.starvationAgingMs,
              ) ||
            (attemptsByFairnessKey.get(left.state.definition.fairnessKey) ??
              0) -
              (attemptsByFairnessKey.get(right.state.definition.fairnessKey) ??
                0) ||
            stableCodeUnitCompare(
              left.state.readySince!,
              right.state.readySince!,
            ) ||
            stableCodeUnitCompare(
              left.state.definition.fairnessKey,
              right.state.definition.fairnessKey,
            ) ||
            stableCodeUnitCompare(
              left.state.definition.workId,
              right.state.definition.workId,
            ),
        );
        const selected = eligible[0];
        if (selected === undefined) return null;
        const fencingToken = selected.state.lastFencingToken + 1;
        const lease: WorkerLease = Object.freeze({
          leaseId: `lease:${createHash("sha256")
            .update(
              toCanonicalJson({
                definitionFingerprint: selected.state.definitionFingerprint,
                workerId,
                attempt: selected.state.attempt + 1,
                fencingToken,
                commandId,
              }),
            )
            .digest("hex")
            .slice(0, 32)}`,
          workerId,
          fencingToken,
          acquiredAt: nowIso,
          heartbeatAt: nowIso,
          expiresAt: new Date(
            Math.min(
              now.valueOf() + configuration.leaseDurationMs,
              now.valueOf() + selected.state.definition.task.timeout.dispatchMs,
              now.valueOf() + selected.state.definition.task.timeout.attemptMs,
              Date.parse(selected.state.definition.task.deadline),
            ),
          ).toISOString(),
        });
        const event = eventFor(selected, command, nowIso, "lease.acquired", {
          lease,
        });
        return appendEvent(tx, selected, event, options.fault);
      });
    },

    async renew(command: RenewLeaseCommand): Promise<WorkerRuntimeState> {
      command = commandOf(command, "renew-lease");
      return mutate(command.idempotencyKey, command, (loaded, at) => {
        const lease = assertFenced(loaded.state, command, at);
        const maximumExpiry = Math.min(
          Date.parse(lease.acquiredAt) +
            loaded.state.definition.task.timeout.attemptMs,
          Date.parse(loaded.state.definition.task.deadline),
          loaded.state.status === "leased"
            ? Date.parse(lease.acquiredAt) +
                loaded.state.definition.task.timeout.dispatchMs
            : Number.MAX_SAFE_INTEGER,
        );
        const desiredExpiry = Math.min(
          Math.max(
            Date.parse(lease.expiresAt) + 1,
            Date.parse(at) + configuration.leaseDurationMs,
          ),
          maximumExpiry,
        );
        if (
          at <= lease.heartbeatAt ||
          loaded.state.leaseRenewals >=
            configuration.maximumLeaseRenewalsPerAttempt ||
          desiredExpiry <= Date.parse(lease.expiresAt)
        ) {
          throw new SchedulerError(
            "LEASE_CONFLICT",
            "The lease renewal limit or task timeout has been reached.",
          );
        }
        return {
          type: "lease.renewed",
          payload: {
            lease: {
              ...lease,
              heartbeatAt: at,
              expiresAt: new Date(desiredExpiry).toISOString(),
            },
          },
        };
      });
    },

    async reserveUsage(
      command: ReserveUsageCommand,
    ): Promise<WorkerRuntimeState> {
      command = commandOf(command, "reserve-usage");
      const preflight = await preflightExternalRead(
        command.idempotencyKey,
        command,
      );
      if (preflight.duplicate) return preflight.state;
      const initial = preflight.state;
      const beforeRead = clockNow(clock);
      assertFenced(initial, command, beforeRead.toISOString());
      assertReservableState(initial);
      const circuit = assertCircuit(
        command.circuit,
        initial,
        beforeRead,
        configuration.circuitFreshnessMs,
      );
      if (initial.definition.estimatedUsage.costMicros === null) {
        throw new SchedulerError(
          "USAGE_REFUSED",
          "Unknown estimated cost cannot be reserved.",
        );
      }
      const snapshot = await readFreshUsage(
        options.usageAdapter,
        initial,
        circuit,
        beforeRead,
        configuration,
        registerUsageRead,
        unregisterUsageRead,
      );
      const aggregateId = aggregateIdFor(command.idempotencyKey);
      const commandFingerprint = workerCommandFingerprint(command);
      return persistence.transact(async (tx) => {
        const all = await listStates(tx, configurationFingerprint);
        const loaded = all.find(
          (item) => item.envelope.aggregateId === aggregateId,
        );
        if (loaded === undefined) {
          throw new SchedulerError(
            "NOT_FOUND",
            "The worker work item does not exist.",
          );
        }
        if (
          duplicateCommand(loaded.events, command.commandId, commandFingerprint)
        ) {
          return loaded.state;
        }
        const at = clockNow(clock).toISOString();
        assertFenced(loaded.state, command, at);
        const commitCircuit = assertCircuit(
          command.circuit,
          loaded.state,
          new Date(at),
          configuration.circuitFreshnessMs,
        );
        assertFreshUsageSnapshot(
          loaded.state,
          commitCircuit,
          snapshot,
          new Date(at),
          configuration,
        );
        assertReservableState(loaded.state);
        const reservation = reservationFor(
          loaded.state,
          snapshot,
          commitCircuit,
          at,
        );
        const existingReservations = reservationJournalRecords(all);
        assertReservationAdmissionEvidence(
          existingReservations,
          loaded.state,
          reservation,
        );
        assertBorrowedReservationCaps(
          [
            ...existingReservations,
            {
              state: loaded.state,
              reservation,
              admissionGlobalSequence:
                nextCapacityGlobalSequence(existingReservations),
              evidenceHistory: Object.freeze([]),
              releaseGlobalSequence: null,
              evidenceRecordedAt: reservation.reservedAt,
              evidenceObservedAt: reservation.observedAt,
              evidenceUsedFiveHourBasisPoints:
                reservation.usedFiveHourBasisPoints,
              evidenceUsedWeeklyBasisPoints: reservation.usedWeeklyBasisPoints,
            },
          ],
          "USAGE_REFUSED",
        );
        const event = eventFor(loaded, command, at, "usage.reserved", {
          reservation,
          usageSnapshot: snapshot,
        });
        return appendEvent(tx, loaded, event, options.fault);
      });
    },

    async prepareDispatch(
      command: PrepareDispatchCommand,
    ): Promise<WorkerRuntimeState> {
      command = commandOf(command, "prepare-dispatch");
      const preflight = await preflightExternalRead(
        command.idempotencyKey,
        command,
      );
      if (preflight.duplicate) return preflight.state;
      const initial = preflight.state;
      const beforeRead = clockNow(clock);
      assertFenced(initial, command, beforeRead.toISOString());
      assertPreparableState(initial);
      const circuit = assertCircuit(
        command.circuit,
        initial,
        beforeRead,
        configuration.circuitFreshnessMs,
      );
      if (initial.reservation === null) {
        throw new SchedulerError(
          "STATE_CORRUPTION",
          "A preparable attempt is missing its usage reservation.",
        );
      }
      assertCircuitRefresh(initial.reservation.circuit, circuit);
      const snapshot = await readFreshUsage(
        options.usageAdapter,
        initial,
        circuit,
        beforeRead,
        configuration,
        registerUsageRead,
        unregisterUsageRead,
      );
      assertReservationRefresh(initial, snapshot);
      const aggregateId = aggregateIdFor(command.idempotencyKey);
      const commandFingerprint = workerCommandFingerprint(command);
      return persistence.transact(async (tx) => {
        const all = await listStates(tx, configurationFingerprint);
        const loaded = all.find(
          (item) => item.envelope.aggregateId === aggregateId,
        );
        if (loaded === undefined) {
          throw new SchedulerError(
            "NOT_FOUND",
            "The worker work item does not exist.",
          );
        }
        if (
          duplicateCommand(loaded.events, command.commandId, commandFingerprint)
        ) {
          return loaded.state;
        }
        const at = clockNow(clock).toISOString();
        assertFenced(loaded.state, command, at);
        const commitCircuit = assertCircuit(
          command.circuit,
          loaded.state,
          new Date(at),
          configuration.circuitFreshnessMs,
        );
        if (loaded.state.reservation === null) {
          throw new SchedulerError(
            "STATE_CORRUPTION",
            "A preparable attempt is missing its usage reservation.",
          );
        }
        assertCircuitRefresh(loaded.state.reservation.circuit, commitCircuit);
        const commitSnapshot = assertFreshUsageSnapshot(
          loaded.state,
          commitCircuit,
          snapshot,
          new Date(at),
          configuration,
        );
        assertPreparableState(loaded.state);
        const reservation = assertReservationRefresh(
          loaded.state,
          commitSnapshot,
        );
        assertBorrowedReservationCaps(
          withProspectiveUsageEvidence(
            reservationJournalRecords(all),
            loaded.state,
            reservation,
            commitSnapshot,
            at,
          ),
          "USAGE_REFUSED",
        );
        const event = eventFor(loaded, command, at, "dispatch.prepared", {
          dispatch: dispatchFor(
            loaded.state,
            reservation,
            commitSnapshot,
            commitCircuit,
            at,
          ),
          usageSnapshot: commitSnapshot,
        });
        return appendEvent(tx, loaded, event, options.fault);
      });
    },

    async markDispatchStarted(
      command: MarkDispatchStartedCommand,
    ): Promise<WorkerRuntimeState> {
      command = commandOf(command, "mark-dispatch-started");
      const preflight = await preflightExternalRead(
        command.idempotencyKey,
        command,
      );
      if (preflight.duplicate) return preflight.state;
      const initial = preflight.state;
      const beforeRead = clockNow(clock);
      assertFenced(initial, command, beforeRead.toISOString());
      const initialDispatch = assertStartableState(initial, command.dispatchId);
      const circuit = assertCircuit(
        initialDispatch.circuit,
        initial,
        beforeRead,
        configuration.circuitFreshnessMs,
      );
      const snapshot = await readFreshUsage(
        options.usageAdapter,
        initial,
        circuit,
        beforeRead,
        configuration,
        registerUsageRead,
        unregisterUsageRead,
      );
      assertReservationRefresh(initial, snapshot);
      const aggregateId = aggregateIdFor(command.idempotencyKey);
      const commandFingerprint = workerCommandFingerprint(command);
      return persistence.transact(async (tx) => {
        const all = await listStates(tx, configurationFingerprint);
        const loaded = all.find(
          (item) => item.envelope.aggregateId === aggregateId,
        );
        if (loaded === undefined) {
          throw new SchedulerError(
            "NOT_FOUND",
            "The worker work item does not exist.",
          );
        }
        if (
          duplicateCommand(loaded.events, command.commandId, commandFingerprint)
        ) {
          return loaded.state;
        }
        const at = clockNow(clock).toISOString();
        assertFenced(loaded.state, command, at);
        const dispatch = assertStartableState(loaded.state, command.dispatchId);
        const commitCircuit = assertCircuit(
          dispatch.circuit,
          loaded.state,
          new Date(at),
          configuration.circuitFreshnessMs,
        );
        const commitSnapshot = assertFreshUsageSnapshot(
          loaded.state,
          commitCircuit,
          snapshot,
          new Date(at),
          configuration,
        );
        const reservation = assertReservationRefresh(
          loaded.state,
          commitSnapshot,
        );
        assertBorrowedReservationCaps(
          withProspectiveUsageEvidence(
            reservationJournalRecords(all),
            loaded.state,
            reservation,
            commitSnapshot,
            at,
          ),
          "USAGE_REFUSED",
        );
        const event = eventFor(loaded, command, at, "dispatch.started", {
          dispatch: { ...dispatch, status: "started", startedAt: at },
          usageSnapshot: commitSnapshot,
        });
        return appendEvent(tx, loaded, event, options.fault);
      });
    },

    async complete(command: CompleteWorkCommand): Promise<WorkerRuntimeState> {
      command = commandOf(command, "complete-work");
      return mutate(command.idempotencyKey, command, (loaded, at) => {
        assertFenced(loaded.state, command, at);
        const dispatch = loaded.state.dispatch;
        if (
          loaded.state.status !== "running" ||
          dispatch?.status !== "started" ||
          dispatch.dispatchId !== command.dispatchId
        ) {
          throw new SchedulerError(
            "INVALID_TRANSITION",
            "Completion requires the exact running dispatch.",
          );
        }
        const actualUsage = parseNormalizedUsage(command.actualUsage);
        const cumulativeUsage = addNormalizedUsage(
          loaded.state.cumulativeUsage,
          actualUsage,
        );
        if (cumulativeUsage.costMicros === null) {
          return {
            type: "work.failed",
            payload: {
              attemptUsage: actualUsage,
              terminal: terminalReceipt(
                "failed",
                "usage-cost-unknown",
                "usage",
                cumulativeUsage,
                at,
              ),
              reservation: terminalizeReservation(
                loaded.state.reservation,
                "reconciled",
                actualUsage,
                at,
              ),
              dispatch: terminalizeDispatch(dispatch, at),
            },
          };
        }
        if (!usageWithinTaskBudget(loaded.state.definition, cumulativeUsage)) {
          return {
            type: "work.failed",
            payload: {
              attemptUsage: actualUsage,
              terminal: terminalReceipt(
                "failed",
                "usage-budget-exceeded",
                "usage",
                cumulativeUsage,
                at,
              ),
              reservation: terminalizeReservation(
                loaded.state.reservation,
                "reconciled",
                actualUsage,
                at,
              ),
              dispatch: terminalizeDispatch(dispatch, at),
            },
          };
        }
        return {
          type: "work.completed",
          payload: {
            attemptUsage: actualUsage,
            terminal: terminalReceipt(
              "completed",
              "completed",
              null,
              cumulativeUsage,
              at,
            ),
            reservation: terminalizeReservation(
              loaded.state.reservation,
              "reconciled",
              actualUsage,
              at,
            ),
            dispatch: terminalizeDispatch(dispatch, at),
          },
        };
      });
    },

    async fail(command: FailWorkCommand): Promise<WorkerRuntimeState> {
      command = commandOf(command, "fail-work");
      return mutate(command.idempotencyKey, command, (loaded, at) => {
        assertFenced(loaded.state, command, at);
        if (
          loaded.state.status !== "leased" &&
          loaded.state.status !== "running"
        ) {
          throw new SchedulerError(
            "INVALID_TRANSITION",
            "Only an active attempt may fail.",
          );
        }
        if (
          (loaded.state.dispatch === null) !== (command.dispatchId === null) ||
          (command.dispatchId !== null &&
            loaded.state.dispatch?.dispatchId !== command.dispatchId)
        ) {
          throw new SchedulerError(
            "INVALID_TRANSITION",
            "Failure dispatch identity is inconsistent.",
          );
        }
        const actualUsage = parseNormalizedUsage(command.actualUsage);
        if (
          loaded.state.status === "leased" &&
          !isKnownZeroUsage(actualUsage)
        ) {
          throw new SchedulerError(
            "INVALID_TASK",
            "Usage before a durably started dispatch must be exact known zero.",
          );
        }
        const cumulativeUsage = addNormalizedUsage(
          loaded.state.cumulativeUsage,
          actualUsage,
        );
        const projectedRetryUsage = addNormalizedUsage(
          cumulativeUsage,
          loaded.state.definition.estimatedUsage,
        );
        const retryable =
          command.retryable &&
          loaded.state.definition.task.retry.retryableFailures.includes(
            command.classification,
          ) &&
          loaded.state.attempt <
            loaded.state.definition.task.retry.maximumAttempts &&
          cumulativeUsage.costMicros !== null &&
          usageWithinTaskBudget(loaded.state.definition, cumulativeUsage) &&
          projectedRetryUsage.costMicros !== null &&
          usageWithinTaskBudget(loaded.state.definition, projectedRetryUsage);
        const reservation = terminalizeReservation(
          loaded.state.reservation,
          loaded.state.status === "running" ||
            loaded.state.dispatch?.status === "started"
            ? "reconciled"
            : "released",
          actualUsage,
          at,
        );
        const dispatch = terminalizeDispatch(loaded.state.dispatch, at);
        if (retryable) {
          return {
            type: "attempt.retry-scheduled",
            payload: {
              nextReadyAt: retryAt(loaded.state, at),
              failure: {
                classification: command.classification,
                code: finiteCode(command.code, "command.code"),
                retryable: true,
                actualUsage,
              },
              reservation,
              dispatch,
            },
          };
        }
        return {
          type: "work.failed",
          payload: {
            attemptUsage: actualUsage,
            terminal: terminalReceipt(
              "failed",
              command.code,
              command.classification,
              cumulativeUsage,
              at,
            ),
            reservation,
            dispatch,
          },
        };
      });
    },

    async cancel(command: CancelWorkCommand): Promise<WorkerRuntimeState> {
      command = commandOf(command, "cancel-work");
      return mutate(command.idempotencyKey, command, (loaded, at) => {
        if (isTerminal(loaded.state)) return null;
        const needsLaterReconciliation =
          loaded.state.status === "running" &&
          loaded.state.dispatch?.status === "started";
        const attemptUsage = needsLaterReconciliation
          ? null
          : ZERO_CUMULATIVE_USAGE;
        return {
          type: "work.cancelled",
          payload: {
            attemptUsage,
            terminal: terminalReceipt(
              "cancelled",
              needsLaterReconciliation
                ? "cancellation-reconciliation-required"
                : command.code,
              null,
              loaded.state.cumulativeUsage,
              at,
            ),
            reservation: terminalizeReservation(
              loaded.state.reservation,
              needsLaterReconciliation ? "reconciliation-required" : "released",
              attemptUsage,
              at,
            ),
            dispatch: terminalizeDispatch(loaded.state.dispatch, at),
          },
        };
      });
    },

    async reconcileUsage(
      command: ReconcileUsageCommand,
    ): Promise<WorkerRuntimeState> {
      command = commandOf(command, "reconcile-usage");
      return mutate(command.idempotencyKey, command, (loaded, at) => {
        const reservation = loaded.state.reservation;
        const dispatch = loaded.state.dispatch;
        const terminal = loaded.state.terminal;
        if (
          !isTerminal(loaded.state) ||
          reservation?.status !== "reconciliation-required" ||
          dispatch?.status !== "terminal" ||
          terminal === null ||
          reservation.reservationId !== command.reservationId ||
          dispatch.dispatchId !== command.dispatchId
        ) {
          throw new SchedulerError(
            "INVALID_TRANSITION",
            "Usage reconciliation requires the exact terminal reservation and dispatch.",
          );
        }
        const actualUsage = parseNormalizedUsage(command.actualUsage);
        const cumulativeUsage = addNormalizedUsage(
          loaded.state.cumulativeUsage,
          actualUsage,
        );
        return {
          type: "usage.reconciled",
          payload: {
            attemptUsage: actualUsage,
            reservation: {
              ...reservation,
              status: "reconciled",
              actualUsage,
              reconciledAt: at,
            },
            terminal: { ...terminal, actualUsage: cumulativeUsage },
          },
        };
      });
    },

    async tick(): Promise<readonly WorkerRuntimeState[]> {
      assertOpen();
      const now = clockNow(clock).toISOString();
      const changed: WorkerRuntimeState[] = [];
      // Each transition is its own short transaction. Reopening after any
      // interruption replays the completed prefix and safely resumes the rest.
      for (const snapshot of await runtime.list()) {
        if (isTerminal(snapshot)) continue;
        const idempotencyKey = snapshot.definition.task.idempotencyKey;
        const current = await runtime.get(idempotencyKey);
        if (current === null || isTerminal(current)) continue;
        if (current.definition.task.deadline <= now) {
          const transition = await persistence.transact(async (tx) => {
            const loaded = await loadState(
              tx,
              aggregateIdFor(idempotencyKey),
              undefined,
              configurationFingerprint,
            );
            if (loaded === null) return null;
            const state = loaded.state;
            const commitAt = clockNow(clock).toISOString();
            if (
              isTerminal(state) ||
              state.definition.task.deadline > commitAt
            ) {
              return null;
            }
            const command = {
              type: "deadline-expired",
              commandId: workerTickCommandId(
                state.definitionFingerprint,
                commitAt,
                state.sequence,
              ),
              idempotencyKey,
            } as const;
            const needsLaterReconciliation =
              state.status === "running" &&
              state.dispatch?.status === "started";
            const attemptUsage = needsLaterReconciliation
              ? null
              : ZERO_CUMULATIVE_USAGE;
            const event = eventFor(
              loaded,
              command,
              commitAt,
              "work.cancelled",
              {
                attemptUsage,
                terminal: terminalReceipt(
                  "cancelled",
                  needsLaterReconciliation
                    ? "cancellation-reconciliation-required"
                    : "deadline-expired",
                  null,
                  state.cumulativeUsage,
                  commitAt,
                ),
                reservation: terminalizeReservation(
                  state.reservation,
                  needsLaterReconciliation
                    ? "reconciliation-required"
                    : "released",
                  attemptUsage,
                  commitAt,
                ),
                dispatch: terminalizeDispatch(state.dispatch, commitAt),
              },
            );
            return appendEvent(tx, loaded, event, options.fault);
          });
          if (transition !== null) changed.push(transition);
          continue;
        }
        if (
          (current.status === "leased" || current.status === "running") &&
          current.lease !== null &&
          current.lease.expiresAt <= now
        ) {
          const transition = await persistence.transact(async (tx) => {
            const loaded = await loadState(
              tx,
              aggregateIdFor(idempotencyKey),
              undefined,
              configurationFingerprint,
            );
            if (loaded === null) return null;
            const state = loaded.state;
            const commitAt = clockNow(clock).toISOString();
            if (
              isTerminal(state) ||
              (state.status !== "leased" && state.status !== "running") ||
              state.lease === null ||
              state.lease.expiresAt > commitAt ||
              state.definition.task.deadline <= commitAt
            ) {
              return null;
            }
            const tickCommandId = workerTickCommandId(
              state.definitionFingerprint,
              commitAt,
              state.sequence,
            );
            if (
              state.status === "running" ||
              state.dispatch?.status === "started"
            ) {
              const command: FailWorkCommand = {
                type: "fail-work",
                commandId: tickCommandId,
                idempotencyKey,
                leaseId: state.lease.leaseId,
                workerId: state.lease.workerId,
                fencingToken: state.lease.fencingToken,
                dispatchId: state.dispatch?.dispatchId ?? null,
                classification: "disconnected",
                code: "lease-expired-reconciliation-required",
                retryable: false,
                actualUsage:
                  state.reservation?.actualUsage ?? ZERO_NORMALIZED_USAGE,
              };
              const event = eventFor(loaded, command, commitAt, "work.failed", {
                attemptUsage: null,
                terminal: terminalReceipt(
                  "failed",
                  command.code,
                  "disconnected",
                  state.cumulativeUsage,
                  commitAt,
                ),
                reservation: terminalizeReservation(
                  state.reservation,
                  "reconciliation-required",
                  null,
                  commitAt,
                ),
                dispatch: terminalizeDispatch(state.dispatch, commitAt),
              });
              return appendEvent(tx, loaded, event, options.fault);
            }
            if (state.attempt < state.definition.task.retry.maximumAttempts) {
              const tickCommand = {
                type: "lease-expired",
                commandId: tickCommandId,
                idempotencyKey,
              } as const;
              const event = eventFor(
                loaded,
                tickCommand,
                commitAt,
                "attempt.retry-scheduled",
                {
                  nextReadyAt: retryAt(state, commitAt),
                  failure: {
                    classification: "disconnected",
                    code: "lease-expired-before-dispatch",
                    retryable: true,
                    actualUsage: ZERO_CUMULATIVE_USAGE,
                  },
                  reservation: terminalizeReservation(
                    state.reservation,
                    "released",
                    ZERO_CUMULATIVE_USAGE,
                    commitAt,
                  ),
                  dispatch: terminalizeDispatch(state.dispatch, commitAt),
                },
              );
              return appendEvent(tx, loaded, event, options.fault);
            }
            const tickCommand = {
              type: "lease-exhausted",
              commandId: tickCommandId,
              idempotencyKey,
            } as const;
            const event = eventFor(
              loaded,
              tickCommand,
              commitAt,
              "work.failed",
              {
                attemptUsage: ZERO_CUMULATIVE_USAGE,
                terminal: terminalReceipt(
                  "failed",
                  "retry-exhausted",
                  "disconnected",
                  state.cumulativeUsage,
                  commitAt,
                ),
                reservation: terminalizeReservation(
                  state.reservation,
                  "released",
                  ZERO_CUMULATIVE_USAGE,
                  commitAt,
                ),
                dispatch: terminalizeDispatch(state.dispatch, commitAt),
              },
            );
            return appendEvent(tx, loaded, event, options.fault);
          });
          if (transition !== null) changed.push(transition);
          continue;
        }
        if (
          current.status === "retry-wait" &&
          current.nextReadyAt !== null &&
          current.nextReadyAt <= now
        ) {
          const transition = await persistence.transact(async (tx) => {
            const loaded = await loadState(
              tx,
              aggregateIdFor(idempotencyKey),
              undefined,
              configurationFingerprint,
            );
            if (loaded === null) return null;
            const state = loaded.state;
            const commitAt = clockNow(clock).toISOString();
            if (
              state.status !== "retry-wait" ||
              state.nextReadyAt === null ||
              state.nextReadyAt > commitAt ||
              state.definition.task.deadline <= commitAt
            ) {
              return null;
            }
            const tickCommand = {
              type: "retry-ready",
              commandId: workerTickCommandId(
                state.definitionFingerprint,
                commitAt,
                state.sequence,
              ),
              idempotencyKey,
            } as const;
            const event = eventFor(
              loaded,
              tickCommand,
              commitAt,
              "work.ready",
              {},
            );
            return appendEvent(tx, loaded, event, options.fault);
          });
          if (transition !== null) changed.push(transition);
        }
      }
      return Object.freeze(changed);
    },

    assertLiveEffectDisabled(effectClass: string): never {
      finiteCode(effectClass, "effectClass");
      if (STAGE_18C_PRODUCTION_ENABLED === false) {
        throw new SchedulerError(
          "PRODUCTION_DISABLED",
          "Stage 18C cannot perform live provider, workspace, Git, network, native, credential, or production effects.",
        );
      }
      throw new SchedulerError(
        "PRODUCTION_DISABLED",
        "Production effects are unavailable.",
      );
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const controller of activeUsageReads) controller.abort();
      activeUsageReads.clear();
      await persistence.close();
    },
  });
  return runtime;
}
