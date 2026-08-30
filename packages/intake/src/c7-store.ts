import {
  isPersistenceError,
  type AggregateEnvelope,
  type PersistenceAdapter,
} from "@ai-dev-os/persistence";
import { ProjectContractError, parseProjectBrief, type ProjectBrief } from "@ai-dev-os/project";
import {
  acceptanceReplayMaterial,
  parseIntakeAcceptanceEvent,
  parsePreparedAcceptance,
} from "./acceptance.js";
import {
  INTAKE_LIMITS,
  type IntakeDigestPort,
  type IntakeAcceptanceEventPayload,
  type IntakeAcceptanceStore,
  type PreparedAcceptance,
  type StoreReconciliation,
  type StoreWriteAttempt,
} from "./contracts.js";
import { intakeSha256 } from "./digest.js";
import { IntakeError } from "./errors.js";

class ExpectedAcceptanceConflict extends Error {
  constructor() {
    super("The expected project-brief head does not match the durable head.");
    this.name = "ExpectedAcceptanceConflict";
  }
}

function parseHead(envelope: AggregateEnvelope): ProjectBrief {
  return parseProjectBrief(envelope.payload);
}

function sameBinding(
  left: IntakeAcceptanceEventPayload["binding"],
  right: IntakeAcceptanceEventPayload["binding"],
): boolean {
  return left.candidateDigest === right.candidateDigest
    && left.expectedHeadBriefId === right.expectedHeadBriefId
    && left.expectedAggregateVersion === right.expectedAggregateVersion
    && left.intakeDecisionDigest === right.intakeDecisionDigest;
}

function classifyAttemptError(error: unknown): StoreWriteAttempt {
  if (error instanceof ExpectedAcceptanceConflict) return Object.freeze({ kind: "conflict" });
  if (isPersistenceError(error)) {
    if (["CONCURRENCY_CONFLICT", "NOT_FOUND", "DUPLICATE_ID"].includes(error.code)) {
      return Object.freeze({ kind: "conflict" });
    }
    if (error.code === "STORAGE_FAILURE") return Object.freeze({ kind: "unknown" });
    return Object.freeze({ kind: "refused" });
  }
  if (error instanceof ProjectContractError || error instanceof IntakeError) {
    return Object.freeze({ kind: "refused" });
  }
  return Object.freeze({ kind: "unknown" });
}

async function attempt(
  adapter: PersistenceAdapter,
  preparedValue: PreparedAcceptance,
  digest: IntakeDigestPort,
): Promise<StoreWriteAttempt> {
  try {
    const prepared = parsePreparedAcceptance(preparedValue, digest);
    await adapter.transact(async (tx) => {
      const current = await tx.aggregates.get("project-brief", prepared.aggregateId);
      if (prepared.binding.expectedAggregateVersion === 0) {
        if (current !== null || prepared.binding.expectedHeadBriefId !== null) {
          throw new ExpectedAcceptanceConflict();
        }
      } else {
        if (current === null || current.aggregateVersion !== prepared.binding.expectedAggregateVersion) {
          throw new ExpectedAcceptanceConflict();
        }
        const head = parseHead(current);
        if (
          head.briefId !== prepared.binding.expectedHeadBriefId
          || head.projectId !== prepared.brief.projectId
        ) {
          throw new ExpectedAcceptanceConflict();
        }
      }
      const envelope = prepared.binding.expectedAggregateVersion === 0
        ? await tx.aggregates.create({
            aggregateType: "project-brief",
            aggregateId: prepared.aggregateId,
            schemaVersion: 1,
            payload: prepared.brief,
          })
        : await tx.aggregates.update({
            aggregateType: "project-brief",
            aggregateId: prepared.aggregateId,
            schemaVersion: 1,
            payload: prepared.brief,
            expectedVersion: prepared.binding.expectedAggregateVersion,
          });
      if (envelope.aggregateVersion !== prepared.aggregateVersion) {
        throw new ExpectedAcceptanceConflict();
      }
      const event = await tx.events.append({
        eventId: prepared.eventId,
        aggregateType: "project-brief",
        aggregateId: prepared.aggregateId,
        aggregateVersion: prepared.aggregateVersion,
        eventType: "project-brief.accepted",
        eventSchemaVersion: 1,
        payload: prepared.event,
        occurredAt: prepared.brief.createdAt,
      });
      if (event.eventId !== prepared.eventId || event.aggregateVersion !== prepared.aggregateVersion) {
        throw new ExpectedAcceptanceConflict();
      }
    });
    return Object.freeze({ kind: "committed", event: prepared.event });
  } catch (error) {
    return classifyAttemptError(error);
  }
}

async function reconcile(
  adapter: PersistenceAdapter,
  preparedValue: PreparedAcceptance,
  digest: IntakeDigestPort,
): Promise<StoreReconciliation> {
  try {
    const prepared = parsePreparedAcceptance(preparedValue, digest);
    return await adapter.transact(async (tx) => {
      const current = await tx.aggregates.get("project-brief", prepared.aggregateId);
      let head: ProjectBrief | null = null;
      if (current !== null) head = parseHead(current);
      let cursor: string | null = null;
      let examined = 0;
      let pages = 0;
      const seenCursors = new Set<string>();
      let match: IntakeAcceptanceEventPayload | null = null;
      do {
        pages += 1;
        if (pages > Math.ceil(INTAKE_LIMITS.reconciliationEvents / INTAKE_LIMITS.reconciliationPageSize) + 1) {
          return Object.freeze({ kind: "limit" as const });
        }
        if (cursor !== null) {
          if (seenCursors.has(cursor)) return Object.freeze({ kind: "unknown" as const });
          seenCursors.add(cursor);
        }
        const remaining = INTAKE_LIMITS.reconciliationEvents - examined;
        if (remaining <= 0) return Object.freeze({ kind: "limit" as const });
        const page = await tx.events.list({
          aggregateType: "project-brief",
          aggregateId: prepared.aggregateId,
          limit: Math.min(INTAKE_LIMITS.reconciliationPageSize, remaining),
          cursor,
        });
        if (page.items.length === 0 && page.nextCursor !== null) {
          return Object.freeze({ kind: "unknown" as const });
        }
        examined += page.items.length;
        for (const record of page.items) {
          if (record.eventType !== "project-brief.accepted") continue;
          const parsed = parseIntakeAcceptanceEvent(record.payload, digest);
          if (parsed.aggregateVersion !== record.aggregateVersion) {
            return Object.freeze({ kind: "unknown" as const });
          }
          if (record.eventId === prepared.eventId) {
            if (!sameBinding(parsed.binding, prepared.binding)) {
              return Object.freeze({ kind: "unknown" as const });
            }
            if (acceptanceReplayMaterial(parsed) !== acceptanceReplayMaterial(prepared.event)) {
              return Object.freeze({ kind: "unknown" as const });
            }
            match = parsed;
            break;
          }
        }
        if (match !== null) break;
        cursor = page.nextCursor;
        if (cursor !== null && examined >= INTAKE_LIMITS.reconciliationEvents) {
          return Object.freeze({ kind: "limit" as const });
        }
      } while (cursor !== null);

      if (match !== null) {
        if (current === null || current.aggregateVersion < match.aggregateVersion || head?.projectId !== match.brief.projectId) {
          return Object.freeze({ kind: "unknown" as const });
        }
        return Object.freeze({ kind: "committed" as const, event: match });
      }
      if (current === null) return Object.freeze({ kind: "not-recorded" as const });
      if (
        current.aggregateVersion === prepared.binding.expectedAggregateVersion
        && head?.briefId === prepared.binding.expectedHeadBriefId
      ) {
        return Object.freeze({ kind: "not-recorded" as const });
      }
      if (
        current.aggregateVersion === prepared.aggregateVersion
        && head?.briefId === prepared.brief.briefId
      ) {
        return Object.freeze({ kind: "unknown" as const });
      }
      return Object.freeze({ kind: "superseded" as const });
    });
  } catch {
    return Object.freeze({ kind: "unknown" });
  }
}

/**
 * Generic bridge only: it uses the public C7 transaction, aggregate, and
 * journal ports and contains no memory/SQLite/PostgreSQL adapter knowledge.
 */
export function createC7IntakeStore(
  adapter: PersistenceAdapter,
  digest: IntakeDigestPort = intakeSha256,
): IntakeAcceptanceStore {
  return Object.freeze({
    attempt: (prepared: PreparedAcceptance): Promise<StoreWriteAttempt> => attempt(adapter, prepared, digest),
    reconcile: (prepared: PreparedAcceptance): Promise<StoreReconciliation> => reconcile(adapter, prepared, digest),
  });
}
