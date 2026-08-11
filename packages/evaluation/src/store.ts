import { toCanonicalJson, validation } from "@ai-dev-os/domain";
import type { EventRecord, PersistenceAdapter, TransactionContext } from "@ai-dev-os/persistence";
import {
  EVALUATION_PRODUCTION_ENABLED,
  type EvaluationEvent,
  type EvaluationRunSnapshot,
  type ProductionDisabledEvaluationService,
} from "./contracts.js";
import { createCompletenessAudit } from "./evaluate.js";
import { EvaluationError } from "./errors.js";
import {
  EMPTY_EVALUATION_AUTHORITY_CONFIGURATION,
  EVALUATION_LIMITS,
  parseEvaluationDigest,
  parseEvaluationAuthorityConfiguration,
} from "./schema.js";
import {
  cancelEvaluationRun,
  completeEvaluationRun,
  createEvaluationRun,
  failEvaluationAttempt,
  parseEvaluationEvent,
  replayEvaluationEvents,
  type EvaluationTransition,
} from "./run.js";

export interface EvaluationAuditRecord {
  readonly operation: string;
  readonly outcome: "succeeded" | "failed" | "duplicate";
  readonly runVersion: number | null;
  readonly code: string | null;
}

export interface CreateEvaluationServiceOptions {
  readonly persistence: PersistenceAdapter;
  readonly audit?: (record: EvaluationAuditRecord) => void;
  readonly authorityConfiguration?: unknown;
  readonly trustedAuthorityConfigurationFingerprints?: unknown;
}

interface LoadedEvaluation {
  readonly snapshot: EvaluationRunSnapshot;
  readonly persistenceVersion: number;
  readonly history: readonly EvaluationEvent[];
}

function eventFromRecord(record: EventRecord): EvaluationEvent {
  try {
    const event = parseEvaluationEvent(record.payload);
    if (
      record.aggregateType !== "evaluation-run" ||
      record.aggregateId !== event.runId ||
      record.aggregateVersion !== event.aggregateVersion ||
      record.eventType !== "evaluation.event" ||
      record.eventSchemaVersion !== 1 ||
      record.eventId !== event.eventId ||
      record.occurredAt !== event.occurredAt ||
      record.traceId !== null ||
      record.causationId !== null
    ) {
      throw new EvaluationError("PERSISTENCE_MISMATCH", "Persisted evaluation event envelope is inconsistent.");
    }
    return event;
  } catch (error) {
    if (error instanceof EvaluationError && error.code === "PERSISTENCE_MISMATCH") throw error;
    throw new EvaluationError("PERSISTENCE_MISMATCH", "Persisted evaluation event is malformed.", {
      causeName: error instanceof Error ? error.name : typeof error,
    });
  }
}

async function listEvents(tx: TransactionContext, runId: string): Promise<readonly EventRecord[]> {
  const records: EventRecord[] = [];
  const maximumJournalEvents = EVALUATION_LIMITS.maximumJournalEvents;
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  let pages = 0;
  do {
    pages += 1;
    if (pages > maximumJournalEvents + 1 || cursor !== null && seenCursors.has(cursor)) {
      throw new EvaluationError("PERSISTENCE_MISMATCH", "Evaluation journal pagination did not make bounded progress.");
    }
    if (cursor !== null) seenCursors.add(cursor);
    const probeLimit = maximumJournalEvents + 1 - records.length;
    if (probeLimit <= 0) {
      throw new EvaluationError("PERSISTENCE_MISMATCH", "Evaluation journal exceeds its durable replay bound.");
    }
    const page = await tx.events.list({
      aggregateType: "evaluation-run",
      aggregateId: runId,
      limit: Math.min(100, probeLimit),
      cursor,
    });
    if (page.items.length === 0 && page.nextCursor !== null) {
      throw new EvaluationError("PERSISTENCE_MISMATCH", "Evaluation journal pagination returned an empty continuation page.");
    }
    records.push(...page.items);
    if (records.length > maximumJournalEvents) {
      throw new EvaluationError("PERSISTENCE_MISMATCH", "Evaluation journal exceeds its durable replay bound.");
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return Object.freeze(records);
}

async function appendEvent(tx: TransactionContext, event: EvaluationEvent): Promise<void> {
  await tx.events.append({
    eventId: event.eventId,
    aggregateType: "evaluation-run",
    aggregateId: event.runId,
    aggregateVersion: event.aggregateVersion,
    eventType: "evaluation.event",
    eventSchemaVersion: 1,
    payload: event,
    occurredAt: event.occurredAt,
    traceId: null,
    causationId: null,
  });
}

export function createProductionDisabledEvaluationService(
  options: CreateEvaluationServiceOptions,
): ProductionDisabledEvaluationService {
  const authorityConfiguration = parseEvaluationAuthorityConfiguration(
    options.authorityConfiguration ?? EMPTY_EVALUATION_AUTHORITY_CONFIGURATION,
  );
  const trustedAuthorityConfigurationFingerprints = new Set([
    authorityConfiguration.configurationFingerprint,
    ...validation.ensureArray(
      options.trustedAuthorityConfigurationFingerprints ?? [],
      "trustedAuthorityConfigurationFingerprints",
      1_024,
    ).map((item, index) => parseEvaluationDigest(
      item,
      `trustedAuthorityConfigurationFingerprints[${index}]`,
    )),
  ]);
  const observe = (
    operation: string,
    outcome: EvaluationAuditRecord["outcome"],
    snapshot: EvaluationRunSnapshot | null,
    code: string | null,
  ): void => {
    try {
      options.audit?.(Object.freeze({
        operation,
        outcome,
        runVersion: snapshot?.aggregateVersion ?? null,
        code,
      }));
    } catch {
      // Observation is non-authoritative and intentionally contains no evaluation content.
    }
  };

  async function load(tx: TransactionContext, runId: string): Promise<LoadedEvaluation | null> {
    const envelope = await tx.aggregates.get("evaluation-run", runId);
    if (envelope === null) return null;
    const records = await listEvents(tx, runId);
    const history = Object.freeze(records.map(eventFromRecord));
    const replayed = replayEvaluationEvents(history);
    if (
      envelope.aggregateType !== "evaluation-run" ||
      envelope.aggregateId !== runId ||
      envelope.schemaVersion !== 1 ||
      envelope.aggregateVersion !== replayed.aggregateVersion ||
      envelope.traceId !== null ||
      !trustedAuthorityConfigurationFingerprints.has(
        replayed.authorityConfiguration.configurationFingerprint,
      ) ||
      toCanonicalJson(envelope.payload) !== toCanonicalJson(replayed)
    ) {
      throw new EvaluationError("PERSISTENCE_MISMATCH", "Evaluation checkpoint differs from exact journal replay.");
    }
    return Object.freeze({ snapshot: replayed, persistenceVersion: envelope.aggregateVersion, history });
  }

  async function mutate(
    operation: string,
    runId: string,
    duplicate: (last: EvaluationEvent) => boolean,
    transition: (snapshot: EvaluationRunSnapshot) => EvaluationTransition,
  ): Promise<EvaluationRunSnapshot> {
    try {
      const outcome = await options.persistence.transact(async (tx) => {
        const loaded = await load(tx, runId);
        if (loaded === null) throw new EvaluationError("NOT_FOUND", "Evaluation run does not exist.", { runId });
        const last = loaded.history.at(-1)!;
        if (duplicate(last)) return Object.freeze({ snapshot: loaded.snapshot, changed: false });
        const next = transition(loaded.snapshot);
        const envelope = await tx.aggregates.update({
          aggregateType: "evaluation-run",
          aggregateId: runId,
          schemaVersion: 1,
          expectedVersion: loaded.persistenceVersion,
          payload: next.snapshot,
          traceId: null,
        });
        if (envelope.aggregateVersion !== next.snapshot.aggregateVersion) {
          throw new EvaluationError("PERSISTENCE_MISMATCH", "Evaluation persistence version did not advance exactly once.");
        }
        await appendEvent(tx, next.event);
        return Object.freeze({ snapshot: next.snapshot, changed: true });
      });
      observe(operation, outcome.changed ? "succeeded" : "duplicate", outcome.snapshot, null);
      return outcome.snapshot;
    } catch (error) {
      observe(operation, "failed", null, error instanceof EvaluationError ? error.code : "persistence-error");
      throw error;
    }
  }

  return Object.freeze({
    productionEnabled: EVALUATION_PRODUCTION_ENABLED,

    async accept(input: unknown): Promise<EvaluationRunSnapshot> {
      const candidate = createEvaluationRun(input, authorityConfiguration);
      try {
        const outcome = await options.persistence.transact(async (tx) => {
          const existing = await load(tx, candidate.snapshot.runId);
          if (existing !== null) {
            if (existing.snapshot.request.requestDigest !== candidate.snapshot.request.requestDigest) {
              throw new EvaluationError("CONFLICT", "Evaluation run identity was reused with different immutable input.");
            }
            return Object.freeze({ snapshot: existing.snapshot, changed: false });
          }
          const envelope = await tx.aggregates.create({
            aggregateType: "evaluation-run",
            aggregateId: candidate.snapshot.runId,
            schemaVersion: 1,
            payload: candidate.snapshot,
            traceId: null,
          });
          if (envelope.aggregateVersion !== candidate.snapshot.aggregateVersion) {
            throw new EvaluationError("PERSISTENCE_MISMATCH", "Evaluation creation version is inconsistent.");
          }
          await appendEvent(tx, candidate.event);
          return Object.freeze({ snapshot: candidate.snapshot, changed: true });
        });
        observe("accept", outcome.changed ? "succeeded" : "duplicate", outcome.snapshot, null);
        return outcome.snapshot;
      } catch (error) {
        observe("accept", "failed", null, error instanceof EvaluationError ? error.code : "persistence-error");
        throw error;
      }
    },

    async get(runId: string): Promise<EvaluationRunSnapshot | null> {
      const loaded = await options.persistence.transact((tx) => load(tx, runId));
      return loaded?.snapshot ?? null;
    },

    async history(runId: string): Promise<readonly EvaluationEvent[]> {
      const loaded = await options.persistence.transact((tx) => load(tx, runId));
      if (loaded === null) throw new EvaluationError("NOT_FOUND", "Evaluation run does not exist.", { runId });
      return loaded.history;
    },

    evaluate(runId: string, expectedVersion: number, evaluatedAt: string): Promise<EvaluationRunSnapshot> {
      return mutate(
        "evaluate",
        runId,
        (last) => last.type === "evaluation.completed" && last.occurredAt === evaluatedAt && last.command.expectedVersion === expectedVersion,
        (snapshot) => completeEvaluationRun(snapshot, expectedVersion, evaluatedAt),
      );
    },

    failAttempt(runId: string, expectedVersion: number, failureCode: string, retryable: boolean, occurredAt: string): Promise<EvaluationRunSnapshot> {
      return mutate(
        "fail-attempt",
        runId,
        (last) => last.type === "evaluation.attempt-failed" && last.occurredAt === occurredAt &&
          last.command.expectedVersion === expectedVersion && last.command.failureCode === failureCode && last.command.retryable === retryable,
        (snapshot) => failEvaluationAttempt(snapshot, expectedVersion, failureCode, retryable, occurredAt),
      );
    },

    cancel(runId: string, expectedVersion: number, reasonCode: string, occurredAt: string): Promise<EvaluationRunSnapshot> {
      return mutate(
        "cancel",
        runId,
        (last) => last.type === "evaluation.cancelled" && last.occurredAt === occurredAt &&
          last.command.expectedVersion === expectedVersion && last.command.reasonCode === reasonCode,
        (snapshot) => cancelEvaluationRun(snapshot, expectedVersion, reasonCode, occurredAt),
      );
    },

    completenessAudit: createCompletenessAudit,
  });
}

export const evaluationStoreTesting = Object.freeze({ listEvents });
