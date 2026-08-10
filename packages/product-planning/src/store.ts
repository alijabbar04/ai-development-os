import { toCanonicalJson, validation } from "@ai-dev-os/domain";
import type { EventRecord, PersistenceAdapter, TransactionContext } from "@ai-dev-os/persistence";
import { replayTaskGraphEvents, type TaskGraphEvent } from "@ai-dev-os/task-graph";
import { PlanningError } from "./errors.js";
import type {
  ApproveSpecificationInput,
  PlanningAuditRecord,
  PlanningContributionEvidence,
  PlanningEvent,
  ProductPlanAcceptanceInput,
  ProductPlanSnapshot,
  ProductPlanningConfiguration,
  ProductPlanningStore,
  ScopeDecisionInput,
} from "./contracts.js";
import { ProductPlan, replayPlanningEvents } from "./plan.js";
import { parsePlanningEvent, stablePlanningId } from "./schema.js";

const { ensureRecord, ensureSafeInteger, ensureString } = validation;

export interface CreateProductPlanningStoreOptions {
  readonly persistence: PersistenceAdapter;
  readonly configuration: ProductPlanningConfiguration;
  readonly clock?: { now(): Date };
  readonly audit?: (record: PlanningAuditRecord) => void;
}

interface LoadedPlan {
  readonly plan: ProductPlan;
  readonly persistenceVersion: number;
  readonly history: readonly PlanningEvent[];
}

function planningEventFromRecord(record: EventRecord, configuration: ProductPlanningConfiguration): PlanningEvent {
  try {
    const event = parsePlanningEvent(record.payload, configuration);
    if (record.aggregateType !== "product-plan" || record.aggregateId !== event.planId ||
        record.aggregateVersion !== event.aggregateVersion || record.eventType !== "planning.event" ||
        record.eventSchemaVersion !== 1 || record.eventId !== event.eventId ||
        record.occurredAt !== event.occurredAt || record.traceId !== null || record.causationId !== null) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted planning event record envelope is inconsistent.");
    }
    return event;
  } catch (error) {
    throw new PlanningError("PERSISTENCE_MISMATCH", "Persisted planning event is malformed.", {
      causeName: error instanceof Error ? error.name : typeof error,
    });
  }
}

async function listAllEvents(tx: TransactionContext, planId: string): Promise<readonly EventRecord[]> {
  const records: EventRecord[] = [];
  let cursor: string | null = null;
  do {
    const page = await tx.events.list({
      aggregateType: "product-plan",
      aggregateId: planId,
      limit: 100,
      cursor,
    });
    records.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return Object.freeze(records);
}

function verifyGraphJournal(records: readonly EventRecord[], snapshot: ProductPlanSnapshot): void {
  const graphRecords = records.filter((record) => record.eventType === "planning.graph-event");
  const planningByVersion = new Map(records
    .filter((record) => record.eventType === "planning.event")
    .map((record) => [record.aggregateVersion, record.eventId]));
  for (const record of graphRecords) {
    const payload = ensureRecord(record.payload, "planningGraphEvent") as unknown as TaskGraphEvent;
    const sequence = ensureSafeInteger((payload as unknown as Record<string, unknown>)["sequence"], "planningGraphEvent.sequence", 1, Number.MAX_SAFE_INTEGER);
    const graphId = ensureString((payload as unknown as Record<string, unknown>)["graphId"], "planningGraphEvent.graphId", { maxLength: 128 });
    const graphVersion = ensureSafeInteger((payload as unknown as Record<string, unknown>)["aggregateVersion"], "planningGraphEvent.aggregateVersion", 1, Number.MAX_SAFE_INTEGER);
    const occurredAt = ensureString((payload as unknown as Record<string, unknown>)["occurredAt"], "planningGraphEvent.occurredAt", { maxLength: 64 });
    if (sequence !== graphRecords.indexOf(record) + 1 || graphId !== snapshot.taskGraph.graphId ||
        record.aggregateType !== "product-plan" || record.aggregateId !== snapshot.planId ||
        record.eventSchemaVersion !== 1 || record.traceId !== null || record.occurredAt !== occurredAt ||
        record.eventId !== stablePlanningId("planning-graph-event", snapshot.planId, String(sequence), String(graphVersion)) ||
        record.causationId !== (planningByVersion.get(record.aggregateVersion) ?? null)) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Planning task-graph journal record is reordered or cross-bound.");
    }
  }
  try {
    const replayed = replayTaskGraphEvents(graphRecords.map((record) => record.payload), snapshot.taskGraph);
    if (toCanonicalJson(replayed) !== toCanonicalJson(snapshot.taskGraph)) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Planning task-graph checkpoint differs from exact graph-journal replay.");
    }
  } catch (error) {
    if (error instanceof PlanningError) throw error;
    throw new PlanningError("PERSISTENCE_MISMATCH", "Planning task-graph journal validation failed closed.", {
      causeName: error instanceof Error ? error.name : typeof error,
    });
  }
}

async function appendChanges(
  tx: TransactionContext,
  plan: ProductPlan,
  persistenceVersion: number,
): Promise<void> {
  const changes = plan.peekChanges();
  for (const event of changes.planningEvents) {
    await tx.events.append({
      eventId: event.eventId,
      aggregateType: "product-plan",
      aggregateId: plan.planId,
      aggregateVersion: persistenceVersion,
      eventType: "planning.event",
      eventSchemaVersion: 1,
      payload: event,
      occurredAt: event.occurredAt,
      traceId: null,
      causationId: null,
    });
  }
  const causationId = changes.planningEvents.at(-1)?.eventId ?? null;
  for (const event of changes.taskGraphEvents) {
    await tx.events.append({
      eventId: stablePlanningId("planning-graph-event", plan.planId, String(event.sequence), String(event.aggregateVersion)),
      aggregateType: "product-plan",
      aggregateId: plan.planId,
      aggregateVersion: persistenceVersion,
      eventType: "planning.graph-event",
      eventSchemaVersion: 1,
      payload: event,
      occurredAt: event.occurredAt,
      traceId: null,
      causationId,
    });
  }
}

export function createProductPlanningStore(options: CreateProductPlanningStoreOptions): ProductPlanningStore {
  const { persistence, configuration } = options;
  const observe = (operation: string, outcome: PlanningAuditRecord["outcome"], snapshot: ProductPlanSnapshot | null, code: string | null): void => {
    try {
      options.audit?.(Object.freeze({
        operation,
        outcome,
        planVersion: snapshot?.aggregateVersion ?? null,
        eventSequence: snapshot?.eventSequence ?? null,
        code,
      }));
    } catch {
      // Audit observation is non-authoritative and contains no plan content.
    }
  };

  async function load(tx: TransactionContext, planId: string): Promise<LoadedPlan | null> {
    const envelope = await tx.aggregates.get("product-plan", planId);
    if (envelope === null) return null;
    const records = await listAllEvents(tx, planId);
    if (records.some((record) => record.eventType !== "planning.event" && record.eventType !== "planning.graph-event")) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Product-plan journal contains an unrecognized event type.");
    }
    const history = records
      .filter((record) => record.eventType === "planning.event")
      .map((record) => planningEventFromRecord(record, configuration));
    const replayed = replayPlanningEvents(history, configuration);
    if (envelope.aggregateType !== "product-plan" || envelope.aggregateId !== planId ||
        envelope.schemaVersion !== 1 || envelope.aggregateVersion !== replayed.aggregateVersion ||
        envelope.traceId !== null || toCanonicalJson(replayed) !== toCanonicalJson(envelope.payload)) {
      throw new PlanningError("PERSISTENCE_MISMATCH", "Planning aggregate checkpoint differs from exact journal replay.");
    }
    verifyGraphJournal(records, replayed);
    return Object.freeze({
      plan: ProductPlan.hydrate(replayed, configuration, options.clock === undefined ? {} : { clock: options.clock }),
      persistenceVersion: envelope.aggregateVersion,
      history,
    });
  }

  async function mutate(
    operation: string,
    planId: string,
    work: (plan: ProductPlan) => void,
  ): Promise<ProductPlanSnapshot> {
    const committed: { plan: ProductPlan | null } = { plan: null };
    try {
      const outcome = await persistence.transact(async (tx) => {
        const loaded = await load(tx, planId);
        if (loaded === null) throw new PlanningError("NOT_FOUND", "Product plan does not exist.", { planId });
        work(loaded.plan);
        const next = loaded.plan.toSnapshot();
        const changes = loaded.plan.peekChanges();
        if (changes.planningEvents.length === 0 && changes.taskGraphEvents.length === 0) {
          return Object.freeze({ snapshot: next, changed: false });
        }
        const envelope = await tx.aggregates.update({
          aggregateType: "product-plan",
          aggregateId: planId,
          schemaVersion: 1,
          expectedVersion: loaded.persistenceVersion,
          payload: next,
          traceId: null,
        });
        await appendChanges(tx, loaded.plan, envelope.aggregateVersion);
        committed.plan = loaded.plan;
        return Object.freeze({ snapshot: next, changed: true });
      });
      committed.plan?.acknowledgeChanges();
      observe(operation, outcome.changed ? "succeeded" : "duplicate", outcome.snapshot, null);
      return outcome.snapshot;
    } catch (error) {
      observe(operation, "failed", null, error instanceof PlanningError ? error.code : "persistence-error");
      throw error;
    }
  }

  return Object.freeze({
    async accept(input: ProductPlanAcceptanceInput): Promise<ProductPlanSnapshot> {
      const accepted: { plan: ProductPlan | null } = { plan: null };
      try {
        const outcome = await persistence.transact(async (tx) => {
          const plan = ProductPlan.create(
            input.intent,
            configuration,
            options.clock === undefined ? {} : { clock: options.clock },
          );
          const existing = await load(tx, plan.planId);
          if (existing !== null) {
            const current = existing.plan.toSnapshot();
            if (toCanonicalJson(current.intent) !== toCanonicalJson(plan.toSnapshot().intent) ||
                current.configurationFingerprint !== configuration.configurationFingerprint) {
              throw new PlanningError("CONFLICT", "Product-plan acceptance identity was reused with different immutable input.");
            }
            return Object.freeze({ snapshot: current, changed: false });
          }
          accepted.plan = plan;
          const current = plan.toSnapshot();
          const envelope = await tx.aggregates.create({
            aggregateType: "product-plan",
            aggregateId: plan.planId,
            schemaVersion: 1,
            payload: current,
            traceId: null,
          });
          await appendChanges(tx, plan, envelope.aggregateVersion);
          return Object.freeze({ snapshot: current, changed: true });
        });
        accepted.plan?.acknowledgeChanges();
        observe("accept", outcome.changed ? "succeeded" : "duplicate", outcome.snapshot, null);
        return outcome.snapshot;
      } catch (error) {
        observe("accept", "failed", null, error instanceof PlanningError ? error.code : "persistence-error");
        throw error;
      }
    },

    async get(planId: string): Promise<ProductPlanSnapshot | null> {
      const loaded = await persistence.transact((tx) => load(tx, planId));
      return loaded?.plan.toSnapshot() ?? null;
    },

    async history(planId: string): Promise<readonly PlanningEvent[]> {
      const loaded = await persistence.transact((tx) => load(tx, planId));
      if (loaded === null) throw new PlanningError("NOT_FOUND", "Product plan does not exist.", { planId });
      return loaded.history;
    },

    stageContribution(planId: string, evidence: PlanningContributionEvidence, draft: unknown): Promise<ProductPlanSnapshot> {
      return mutate("stage-contribution", planId, (plan) => { plan.stageContribution(evidence, draft); });
    },

    applyStagedContribution(planId: string, contributionId: string, expectedPlanVersion: number): Promise<ProductPlanSnapshot> {
      return mutate("apply-contribution", planId, (plan) => { plan.applyStagedContribution(contributionId, expectedPlanVersion); });
    },

    decideScope(planId: string, input: ScopeDecisionInput): Promise<ProductPlanSnapshot> {
      return mutate("decide-scope", planId, (plan) => { plan.decideScope(input); });
    },

    approveSpecification(planId: string, input: ApproveSpecificationInput): Promise<ProductPlanSnapshot> {
      return mutate("approve-specification", planId, (plan) => { plan.approveSpecification(input); });
    },

    failPhase(planId: string, phaseId: string, failureCode: string, expectedPlanVersion: number): Promise<ProductPlanSnapshot> {
      return mutate("fail-phase", planId, (plan) => { plan.failPhase(phaseId, failureCode, expectedPlanVersion); });
    },

    cancel(planId: string, reason: string, expectedPlanVersion: number): Promise<ProductPlanSnapshot> {
      return mutate("cancel", planId, (plan) => { plan.cancel(reason, expectedPlanVersion); });
    },
  });
}
