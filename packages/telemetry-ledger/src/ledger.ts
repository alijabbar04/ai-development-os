import {
  isPersistenceError,
  type AggregateEnvelope,
  type EventRecord,
  type PersistenceAdapter,
  type TransactionContext,
} from "@ai-dev-os/persistence";
import { toCanonicalJson, validation } from "@ai-dev-os/domain";
import { parseTelemetryLedgerConfiguration } from "./config.js";
import { TelemetryError, isTelemetryError } from "./errors.js";
import { canonicalTelemetryValue, observationIdempotencyFingerprint, telemetrySnapshotFingerprint } from "./fingerprint.js";
import { currentEffectiveObservation, forecastCapacity as deriveForecast, telemetrySignalKey } from "./forecast.js";
import { activeTelemetryObservations, reconcileOperationTelemetry as reconcileOperation, validateCorrectionTargets } from "./reconciliation.js";
import { queryCostSummary as summarizeCost, queryUsageSummary as summarizeUsage } from "./summaries.js";
import {
  TELEMETRY_ALGORITHM_VERSION,
  TELEMETRY_CHECKPOINT_SCHEMA_VERSION,
  type CapacitySnapshot,
  type CreateTelemetryLedgerOptions,
  type ForecastData,
  type IngestionResult,
  type TelemetryAccessContext,
  type TelemetryAuditRecord,
  type TelemetryCheckpoint,
  type TelemetryLedger,
  type TelemetryObservation,
  type TelemetryObservationDraft,
  type TelemetryPage,
  type TelemetryQuery,
  type TelemetryScope,
  type TelemetrySnapshot,
  type TelemetryVerificationResult,
} from "./types.js";
import { createTelemetryObservation, deterministicPartition, parseTelemetryObservation } from "./validation.js";

const { ensureArray, ensureEnum, ensureExactKeys, ensureRecord, ensureSafeInteger, ensureString, ensureTimestamp } = validation;
const HEX = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EVENT_TYPE = "telemetry-observation";
const MAX_CHECKPOINT_CANONICAL_CHARACTERS = 9_000_000;

function sourceKey(observation: TelemetryObservation): string {
  return telemetrySnapshotFingerprint({
    ledgerId: observation.ledgerId,
    providerId: observation.identity.providerId,
    providerInstanceId: observation.identity.configuredInstanceId,
    category: observation.source.category,
    sourceObservationId: observation.source.sourceObservationId,
  });
}

function checkpointFingerprint(checkpoint: Omit<TelemetryCheckpoint, "checkpointFingerprint"> | TelemetryCheckpoint): string {
  const copy = { ...checkpoint } as Record<string, unknown>;
  delete copy["checkpointFingerprint"];
  return telemetrySnapshotFingerprint(copy);
}

function buildCheckpoint(input: {
  readonly ledgerId: string;
  readonly partitionId: string;
  readonly partitionStart: string;
  readonly partitionEnd: string;
  readonly observations: readonly TelemetryObservation[];
  readonly lastEventId: string | null;
}): TelemetryCheckpoint {
  const superseded = input.observations.flatMap((item) => item.kind === "correction" ? [item.data.targetObservationId] : []);
  const idempotency = input.observations.map((item) => ({
    observationId: item.observationId,
    idempotencyKey: item.idempotencyKey,
    sourceKey: sourceKey(item),
    sourceFingerprint: item.provenance.sourceFingerprint,
    fingerprint: observationIdempotencyFingerprint(item),
  }));
  const base = canonicalTelemetryValue({
    schemaVersion: TELEMETRY_CHECKPOINT_SCHEMA_VERSION,
    algorithmVersion: TELEMETRY_ALGORITHM_VERSION,
    ledgerId: input.ledgerId,
    partitionId: input.partitionId,
    partitionStart: input.partitionStart,
    partitionEnd: input.partitionEnd,
    observations: input.observations,
    idempotency,
    supersededObservationIds: [...new Set(superseded)].sort(),
    eventCount: input.observations.length,
    lastEventId: input.lastEventId,
  }) as Omit<TelemetryCheckpoint, "checkpointFingerprint">;
  return canonicalTelemetryValue({ ...base, checkpointFingerprint: checkpointFingerprint(base) });
}

export function parseTelemetryCheckpoint(value: unknown): TelemetryCheckpoint {
  const input = ensureRecord(value, "telemetryCheckpoint");
  ensureExactKeys(input, ["schemaVersion", "algorithmVersion", "ledgerId", "partitionId", "partitionStart", "partitionEnd", "observations", "idempotency", "supersededObservationIds", "eventCount", "lastEventId", "checkpointFingerprint"], "telemetryCheckpoint");
  if (input["schemaVersion"] !== TELEMETRY_CHECKPOINT_SCHEMA_VERSION || input["algorithmVersion"] !== TELEMETRY_ALGORITHM_VERSION) {
    throw new TelemetryError("UNSUPPORTED_SCHEMA", "checkpoint-schema-unsupported");
  }
  const observations = ensureArray(input["observations"], "telemetryCheckpoint.observations", 100_000).map((item, index) => parseTelemetryObservation(item, `telemetryCheckpoint.observations[${index}]`));
  const checkpoint = canonicalTelemetryValue({
    schemaVersion: TELEMETRY_CHECKPOINT_SCHEMA_VERSION,
    algorithmVersion: TELEMETRY_ALGORITHM_VERSION,
    ledgerId: ensureString(input["ledgerId"], "telemetryCheckpoint.ledgerId", { maxLength: 128, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u, patternName: "ledger id" }),
    partitionId: ensureString(input["partitionId"], "telemetryCheckpoint.partitionId", { maxLength: 128, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u, patternName: "partition id" }),
    partitionStart: ensureTimestamp(input["partitionStart"], "telemetryCheckpoint.partitionStart"),
    partitionEnd: ensureTimestamp(input["partitionEnd"], "telemetryCheckpoint.partitionEnd"),
    observations,
    idempotency: ensureArray(input["idempotency"], "telemetryCheckpoint.idempotency", 100_000).map((item, index) => {
      const record = ensureRecord(item, `telemetryCheckpoint.idempotency[${index}]`);
      ensureExactKeys(record, ["observationId", "idempotencyKey", "sourceKey", "sourceFingerprint", "fingerprint"], `telemetryCheckpoint.idempotency[${index}]`);
      return {
        observationId: ensureString(record["observationId"], `telemetryCheckpoint.idempotency[${index}].observationId`, { maxLength: 128 }),
        idempotencyKey: ensureString(record["idempotencyKey"], `telemetryCheckpoint.idempotency[${index}].idempotencyKey`, { maxLength: 256 }),
        sourceKey: ensureString(record["sourceKey"], `telemetryCheckpoint.idempotency[${index}].sourceKey`, { maxLength: 256 }),
        sourceFingerprint: ensureString(record["sourceFingerprint"], `telemetryCheckpoint.idempotency[${index}].sourceFingerprint`, { maxLength: 64, pattern: HEX, patternName: "SHA-256 fingerprint" }),
        fingerprint: ensureString(record["fingerprint"], `telemetryCheckpoint.idempotency[${index}].fingerprint`, { maxLength: 64, pattern: HEX, patternName: "SHA-256 fingerprint" }),
      };
    }),
    supersededObservationIds: ensureArray(input["supersededObservationIds"], "telemetryCheckpoint.supersededObservationIds", 100_000).map((item, index) => ensureString(item, `telemetryCheckpoint.supersededObservationIds[${index}]`, { maxLength: 128 })),
    eventCount: ensureSafeInteger(input["eventCount"], "telemetryCheckpoint.eventCount", 0, Number.MAX_SAFE_INTEGER),
    lastEventId: input["lastEventId"] === null ? null : ensureString(input["lastEventId"], "telemetryCheckpoint.lastEventId", { maxLength: 128 }),
    checkpointFingerprint: ensureString(input["checkpointFingerprint"], "telemetryCheckpoint.checkpointFingerprint", { maxLength: 64, pattern: HEX, patternName: "SHA-256 fingerprint" }),
  }) as TelemetryCheckpoint;
  if (checkpoint.eventCount !== observations.length || checkpoint.idempotency.length !== observations.length || checkpointFingerprint(checkpoint) !== checkpoint.checkpointFingerprint) {
    throw new TelemetryError("INTEGRITY_FAILURE", "checkpoint-fingerprint-mismatch");
  }
  if (observations.some((item) => item.ledgerId !== checkpoint.ledgerId || item.partitionId !== checkpoint.partitionId)) throw new TelemetryError("INTEGRITY_FAILURE", "checkpoint-observation-identity-mismatch");
  const rebuilt = buildCheckpoint({ ledgerId: checkpoint.ledgerId, partitionId: checkpoint.partitionId, partitionStart: checkpoint.partitionStart, partitionEnd: checkpoint.partitionEnd, observations, lastEventId: checkpoint.lastEventId });
  if (rebuilt.checkpointFingerprint !== checkpoint.checkpointFingerprint) throw new TelemetryError("INTEGRITY_FAILURE", "checkpoint-index-mismatch");
  return checkpoint;
}

function observationFromEvent(event: EventRecord): TelemetryObservation {
  if (event.eventType !== EVENT_TYPE || event.eventSchemaVersion !== 1) throw new TelemetryError("UNSUPPORTED_SCHEMA", "event-schema-unsupported");
  const payload = ensureRecord(event.payload, "telemetryEvent.payload");
  ensureExactKeys(payload, ["observation"], "telemetryEvent.payload");
  const observation = parseTelemetryObservation(payload["observation"]);
  if (event.eventId !== eventIdFor(observation)) throw new TelemetryError("INTEGRITY_FAILURE", "event-id-mismatch");
  if (event.aggregateType !== "telemetry-ledger" || event.aggregateId !== observation.partitionId) throw new TelemetryError("INTEGRITY_FAILURE", "event-aggregate-mismatch");
  return observation;
}

function eventIdFor(observation: TelemetryObservation): string {
  return `tlm-${telemetrySnapshotFingerprint({ observationId: observation.observationId, fingerprint: observation.canonicalPayloadFingerprint }).slice(0, 48)}`;
}

async function listPartitionEvents(tx: TransactionContext, partitionId: string, pageSize: number): Promise<readonly EventRecord[]> {
  const result: EventRecord[] = [];
  let cursor: string | null = null;
  do {
    const page = await tx.events.list({ aggregateType: "telemetry-ledger", aggregateId: partitionId, limit: pageSize, cursor });
    result.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return Object.freeze(result);
}

async function listLedgerObservations(
  tx: TransactionContext,
  ledgerId: string,
  options: CreateTelemetryLedgerOptions,
): Promise<readonly TelemetryObservation[]> {
  const result: TelemetryObservation[] = [];
  const maximum = options.configuration.maximumPartitionCount * options.configuration.maximumObservationsPerPartition;
  let cursor: string | null = null;
  do {
    const page = await tx.events.list({ aggregateType: "telemetry-ledger", limit: options.configuration.eventPageSize, cursor });
    for (const event of page.items) {
      const observation = observationFromEvent(event);
      if (observation.ledgerId === ledgerId) result.push(observation);
      if (result.length > maximum) throw new TelemetryError("INTEGRITY_FAILURE", "ledger-observation-bound-exceeded");
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return Object.freeze(result);
}

export function replayTelemetryPartition(input: {
  readonly events: readonly EventRecord[];
  readonly ledgerId: string;
  readonly partitionId: string;
  readonly partitionStart: string;
  readonly partitionEnd: string;
}): TelemetryCheckpoint {
  const ordered = input.events.slice().sort((left, right) => left.globalSequence - right.globalSequence);
  const observations = ordered.map(observationFromEvent);
  if (observations.some((item) => item.ledgerId !== input.ledgerId || item.partitionId !== input.partitionId)) throw new TelemetryError("INTEGRITY_FAILURE", "event-partition-mismatch");
  for (const operationId of new Set(observations.flatMap((item) => item.operationId === null ? [] : [item.operationId]))) {
    const relevant = observations.filter((item) => item.operationId === operationId && (item.kind === "operation-estimate" || item.kind === "cumulative-usage" || item.kind === "terminal-reconciliation" || item.kind === "correction"));
    if (activeTelemetryObservations(relevant).some((item) => item.kind !== "correction")) reconcileOperation(relevant, operationId);
  }
  return buildCheckpoint({ ...input, observations, lastEventId: ordered.at(-1)?.eventId ?? null });
}

function requestedScope(access: TelemetryAccessContext): TelemetryScope {
  return Object.freeze({ organizationId: access.organizationId, userId: access.subjectId, projectId: access.projectId, workspaceId: access.workspaceId, taskId: null, runId: null });
}

function matchesAccess(item: TelemetryObservation, access: TelemetryAccessContext): boolean {
  return item.scope.organizationId === access.organizationId &&
    item.scope.projectId === access.projectId &&
    item.scope.workspaceId === access.workspaceId &&
    (item.scope.userId === null || item.scope.userId === access.subjectId);
}

async function authorize(options: CreateTelemetryLedgerOptions, action: "write" | "read", access: TelemetryAccessContext, scope: TelemetryScope, providerInstanceId: string, operationId: string | null): Promise<boolean> {
  try {
    return await options.authorizer.authorize({ action, ledgerId: options.ledgerId, access, scope, providerInstanceId, operationId });
  } catch {
    return false;
  }
}

async function audit(options: CreateTelemetryLedgerOptions, record: Omit<TelemetryAuditRecord, "schemaVersion" | "occurredAt">): Promise<boolean> {
  try {
    await options.audit(Object.freeze({ schemaVersion: 1, occurredAt: options.clock.now().toISOString(), ...record }));
    return true;
  } catch {
    return false;
  }
}

function auditShape(action: TelemetryAuditRecord["action"], outcome: TelemetryAuditRecord["outcome"], access: TelemetryAccessContext, detailCode: string, providerInstanceScoped: boolean): Omit<TelemetryAuditRecord, "schemaVersion" | "occurredAt"> {
  return Object.freeze({ action, outcome, purpose: access.purpose, classification: access.classification, organizationScoped: access.organizationId !== null, projectScoped: access.projectId !== null, workspaceScoped: access.workspaceId !== null, providerInstanceScoped, detailCode });
}

function validateConfiguredObservation(observation: TelemetryObservation, options: CreateTelemetryLedgerOptions): void {
  if (observation.kind === "cost") for (const component of observation.data.components) {
    if (!options.configuration.acceptedCostSemantics.includes(component.semanticClass) || (component.currency !== null && !options.configuration.acceptedCurrencies.includes(component.currency))) throw new TelemetryError("INVALID_OBSERVATION", "cost-class-not-configured");
  }
  const bridge = observation.identity.adapterPackage === "@ai-dev-os/provider-ollama" ? "ollama"
    : observation.identity.adapterPackage === "@ai-dev-os/provider-claude-code" ? "claude-code"
      : observation.identity.adapterPackage === "@ai-dev-os/provider-codex" ? "codex"
        : observation.identity.adapterPackage === "@ai-dev-os/provider-openai" ? "openai"
          : observation.identity.adapterPackage === "@ai-dev-os/provider-gateway" ? "gateway"
            : "generic";
  if (!options.configuration.enabledBridges.includes(bridge)) throw new TelemetryError("INVALID_OBSERVATION", "provider-bridge-disabled");
  if (observation.observedAt >= deterministicPartition(observation.ledgerId, observation.observedAt, options.configuration.partitionDurationMs).end) throw new TelemetryError("INVALID_OBSERVATION", "partition-time-invalid");
}

function configuredStaleAt(draft: TelemetryObservationDraft, options: CreateTelemetryLedgerOptions): string | null {
  if (draft.staleAt !== null) return draft.staleAt;
  const duration = draft.kind === "cost" ? options.configuration.stalenessMs.cost
    : draft.kind === "provider-health" ? options.configuration.stalenessMs.health
      : draft.kind === "quota-window" ? options.configuration.stalenessMs.quota
        : draft.kind === "capacity" ? options.configuration.stalenessMs.capacity
          : draft.kind === "operation-estimate" || draft.kind === "cumulative-usage" || draft.kind === "terminal-reconciliation" || draft.kind === "account-usage" ? options.configuration.stalenessMs.usage
            : null;
  return duration === null ? null : new Date(Date.parse(draft.observedAt) + duration).toISOString();
}

function duplicateResult(observation: TelemetryObservation, eventId: string, checkpoint: TelemetryCheckpoint): IngestionResult {
  return Object.freeze({ outcome: "duplicate", observation, eventId, checkpointFingerprint: checkpoint.checkpointFingerprint, code: "duplicate-replay" });
}

async function persistObservation(adapter: PersistenceAdapter, observation: TelemetryObservation, options: CreateTelemetryLedgerOptions): Promise<IngestionResult> {
  const partition = deterministicPartition(observation.ledgerId, observation.observedAt, options.configuration.partitionDurationMs);
  const eventId = eventIdFor(observation);
  return adapter.transact(async (tx) => {
    const envelope: AggregateEnvelope | null = await tx.aggregates.get("telemetry-ledger", partition.partitionId);
    const journal = await listPartitionEvents(tx, partition.partitionId, options.configuration.eventPageSize);
    let checkpoint: TelemetryCheckpoint;
    if (envelope === null) {
      let partitionCursor: string | null = null;
      let partitionCount = 0;
      do {
        const page = await tx.aggregates.list({ aggregateType: "telemetry-ledger", limit: options.configuration.queryPageSize, cursor: partitionCursor });
        for (const candidate of page.items) {
          try { if (parseTelemetryCheckpoint(candidate.payload).ledgerId === observation.ledgerId) partitionCount += 1; }
          catch { if (candidate.aggregateId.startsWith(`${observation.ledgerId.slice(0, 72)}-`)) partitionCount += 1; }
        }
        partitionCursor = page.nextCursor;
      } while (partitionCursor !== null && partitionCount < options.configuration.maximumPartitionCount);
      if (partitionCount >= options.configuration.maximumPartitionCount) throw new TelemetryError("PARTITION_FULL", "partition-count-limit");
      checkpoint = journal.length === 0
        ? buildCheckpoint({ ledgerId: observation.ledgerId, partitionId: partition.partitionId, partitionStart: partition.start, partitionEnd: partition.end, observations: [], lastEventId: null })
        : replayTelemetryPartition({ events: journal, ledgerId: observation.ledgerId, partitionId: partition.partitionId, partitionStart: partition.start, partitionEnd: partition.end });
    } else {
      try {
        checkpoint = parseTelemetryCheckpoint(envelope.payload);
        if (checkpoint.ledgerId !== observation.ledgerId || checkpoint.partitionId !== partition.partitionId || checkpoint.partitionStart !== partition.start || checkpoint.partitionEnd !== partition.end || checkpoint.eventCount !== journal.length || checkpoint.lastEventId !== (journal.at(-1)?.eventId ?? null)) checkpoint = replayTelemetryPartition({ events: journal, ledgerId: observation.ledgerId, partitionId: partition.partitionId, partitionStart: partition.start, partitionEnd: partition.end });
      } catch (error) {
        if (isTelemetryError(error) && error.code === "UNSUPPORTED_SCHEMA") throw error;
        checkpoint = replayTelemetryPartition({ events: journal, ledgerId: observation.ledgerId, partitionId: partition.partitionId, partitionStart: partition.start, partitionEnd: partition.end });
      }
    }
    const ledgerHistory = await listLedgerObservations(tx, observation.ledgerId, options);
    const collision = ledgerHistory.find((item) => item.observationId === observation.observationId || item.idempotencyKey === observation.idempotencyKey);
    if (collision !== undefined) {
      if (observationIdempotencyFingerprint(collision) === observationIdempotencyFingerprint(observation)) return duplicateResult(collision, eventIdFor(collision), checkpoint);
      return Object.freeze({ outcome: "conflict", observation: null, eventId: null, checkpointFingerprint: checkpoint.checkpointFingerprint, code: "idempotency-conflict" });
    }
    const sourceCollision = ledgerHistory.find((item) => sourceKey(item) === sourceKey(observation));
    if (sourceCollision !== undefined && sourceCollision.provenance.sourceFingerprint !== observation.provenance.sourceFingerprint) return Object.freeze({ outcome: "conflict", observation: null, eventId: null, checkpointFingerprint: checkpoint.checkpointFingerprint, code: "source-identity-conflict" });
    if (checkpoint.observations.length >= options.configuration.maximumObservationsPerPartition || checkpoint.idempotency.length >= options.configuration.maximumIdempotencyRecordsPerPartition) throw new TelemetryError("PARTITION_FULL", "partition-observation-limit");
    const observations = Object.freeze([...checkpoint.observations, observation]);
    if (observation.kind === "correction") {
      const target = ledgerHistory.find((item) => item.observationId === observation.data.targetObservationId);
      if (target === undefined || target.kind === "correction") throw new TelemetryError("IDENTITY_CONFLICT", "correction-target-missing");
      if (target.operationId !== observation.operationId || telemetrySnapshotFingerprint({ scope: target.scope, identity: target.identity }) !== telemetrySnapshotFingerprint({ scope: observation.scope, identity: observation.identity })) throw new TelemetryError("IDENTITY_CONFLICT", "correction-target-identity-mismatch");
    }
    if (observation.operationId !== null && (observation.kind === "operation-estimate" || observation.kind === "cumulative-usage" || observation.kind === "terminal-reconciliation" || observation.kind === "correction")) {
      const operationItems = [...ledgerHistory, observation].filter((item) => item.operationId === observation.operationId && (item.kind === "operation-estimate" || item.kind === "cumulative-usage" || item.kind === "terminal-reconciliation" || item.kind === "correction"));
      if (activeTelemetryObservations(operationItems).some((item) => item.kind !== "correction")) reconcileOperation(operationItems, observation.operationId);
    }
    const next = buildCheckpoint({ ledgerId: observation.ledgerId, partitionId: partition.partitionId, partitionStart: partition.start, partitionEnd: partition.end, observations, lastEventId: eventId });
    if (toCanonicalJson(next, "telemetry checkpoint").length > MAX_CHECKPOINT_CANONICAL_CHARACTERS) throw new TelemetryError("PARTITION_FULL", "checkpoint-size-limit");
    const nextVersion = journal.length + 1;
    if (envelope === null) await tx.aggregates.create({ aggregateType: "telemetry-ledger", aggregateId: partition.partitionId, schemaVersion: TELEMETRY_CHECKPOINT_SCHEMA_VERSION, payload: next, traceId: observation.traceId });
    else await tx.aggregates.update({ aggregateType: "telemetry-ledger", aggregateId: partition.partitionId, schemaVersion: TELEMETRY_CHECKPOINT_SCHEMA_VERSION, payload: next, traceId: observation.traceId, expectedVersion: envelope.aggregateVersion });
    await tx.events.append({ eventId, aggregateType: "telemetry-ledger", aggregateId: partition.partitionId, aggregateVersion: nextVersion, eventType: EVENT_TYPE, eventSchemaVersion: 1, payload: { observation }, occurredAt: observation.observedAt, traceId: observation.traceId, causationId: observation.previousObservationId });
    return Object.freeze({ outcome: "accepted", observation, eventId, checkpointFingerprint: next.checkpointFingerprint, code: "accepted" });
  });
}

function nullableQueryId(value: unknown, path: string): string | null {
  return value === undefined || value === null ? null : ensureString(value, path, { maxLength: 128, pattern: ID, patternName: "identifier" });
}

function parseTelemetryQuery(value: unknown, options: CreateTelemetryLedgerOptions): TelemetryQuery {
  const input = ensureRecord(value, "telemetryQuery");
  ensureExactKeys(input, ["access", "from", "to", "providerInstanceId", "contractModelId", "upstreamModelId", "operationId", "observationId", "dimension", "window", "providerWindowId", "limit", "cursor"], "telemetryQuery");
  const rawAccess = ensureRecord(input["access"], "telemetryQuery.access");
  ensureExactKeys(rawAccess, ["subjectId", "organizationId", "projectId", "workspaceId", "purpose", "classification"], "telemetryQuery.access");
  const from = ensureTimestamp(input["from"], "telemetryQuery.from");
  const to = ensureTimestamp(input["to"], "telemetryQuery.to");
  if (from >= to) throw new TelemetryError("INVALID_OBSERVATION", "query-interval-invalid");
  const access = Object.freeze({
    subjectId: ensureString(rawAccess["subjectId"], "telemetryQuery.access.subjectId", { maxLength: 128, pattern: ID, patternName: "subject id" }),
    organizationId: nullableQueryId(rawAccess["organizationId"], "telemetryQuery.access.organizationId"),
    projectId: nullableQueryId(rawAccess["projectId"], "telemetryQuery.access.projectId"),
    workspaceId: nullableQueryId(rawAccess["workspaceId"], "telemetryQuery.access.workspaceId"),
    purpose: ensureEnum(rawAccess["purpose"], "telemetryQuery.access.purpose", ["ingest", "operations", "usage", "cost", "capacity", "history", "export", "verify"] as const),
    classification: ensureEnum(rawAccess["classification"], "telemetryQuery.access.classification", ["internal", "confidential", "restricted"] as const),
  });
  const limit = input["limit"] === undefined ? undefined : ensureSafeInteger(input["limit"], "telemetryQuery.limit", 1, options.configuration.queryPageSize);
  const cursor = input["cursor"] === undefined || input["cursor"] === null ? null : ensureString(input["cursor"], "telemetryQuery.cursor", { maxLength: 2_048 });
  return Object.freeze({
    access, from, to,
    providerInstanceId: nullableQueryId(input["providerInstanceId"], "telemetryQuery.providerInstanceId"),
    contractModelId: nullableQueryId(input["contractModelId"], "telemetryQuery.contractModelId"),
    upstreamModelId: nullableQueryId(input["upstreamModelId"], "telemetryQuery.upstreamModelId"),
    operationId: nullableQueryId(input["operationId"], "telemetryQuery.operationId"),
    observationId: nullableQueryId(input["observationId"], "telemetryQuery.observationId"),
    dimension: input["dimension"] === undefined || input["dimension"] === null ? null : ensureEnum(input["dimension"], "telemetryQuery.dimension", ["tokens", "requests", "concurrency", "memory-bytes", "credits", "usage-percentage"] as const),
    window: input["window"] === undefined || input["window"] === null ? null : ensureEnum(input["window"], "telemetryQuery.window", ["rolling", "fixed", "daily", "five-hour", "seven-day", "primary", "secondary", "provider-defined"] as const),
    providerWindowId: nullableQueryId(input["providerWindowId"], "telemetryQuery.providerWindowId"),
    ...(limit === undefined ? {} : { limit }), cursor,
  });
}

interface InternalReadResult {
  readonly items: readonly TelemetryObservation[];
  readonly nextCursor: string | null;
  readonly authorizationFiltered: boolean;
}

async function readPage(adapter: PersistenceAdapter, options: CreateTelemetryLedgerOptions, query: TelemetryQuery, includeCorrectionsOutsideInterval = false): Promise<InternalReadResult> {
  const limit = Math.min(query.limit ?? options.configuration.queryPageSize, options.configuration.queryPageSize);
  return adapter.transact(async (tx) => {
    const items: TelemetryObservation[] = [];
    let authorizationFiltered = false;
    let cursor = query.cursor ?? null;
    do {
      const page = await tx.events.list({ aggregateType: "telemetry-ledger", limit: limit - items.length, cursor });
      cursor = page.nextCursor;
      for (const event of page.items) {
        const item = observationFromEvent(event);
        const correctionForFilter = includeCorrectionsOutsideInterval && item.kind === "correction";
        const signal = item.kind === "quota-window" || item.kind === "capacity" ? item.data : null;
        if (!(item.ledgerId === options.ledgerId && (item.observedAt >= query.from && item.observedAt < query.to || correctionForFilter) && matchesAccess(item, query.access) &&
          (query.providerInstanceId === undefined || query.providerInstanceId === null || item.identity.configuredInstanceId === query.providerInstanceId) &&
          (query.contractModelId === undefined || query.contractModelId === null || item.identity.contractModelId === query.contractModelId) &&
          (query.upstreamModelId === undefined || query.upstreamModelId === null || item.identity.upstreamModelId === query.upstreamModelId) &&
          (query.operationId === undefined || query.operationId === null || item.operationId === query.operationId) &&
          (query.observationId === undefined || query.observationId === null || item.observationId === query.observationId || correctionForFilter && item.data.targetObservationId === query.observationId) &&
          (query.dimension === undefined || query.dimension === null || correctionForFilter || signal?.dimension === query.dimension) &&
          (query.window === undefined || query.window === null || correctionForFilter || signal?.window === query.window) &&
          (query.providerWindowId === undefined || query.providerWindowId === null || correctionForFilter || signal?.providerWindowId === query.providerWindowId))) continue;
        const allowed = await authorize(options, "read", query.access, item.scope, item.identity.configuredInstanceId, item.operationId);
        if (!allowed) {
          const audited = await audit(options, auditShape("read", "denied", query.access, "observation-read-denied", true));
          if (!audited) throw new TelemetryError("AUDIT_FAILURE", "audit-failure");
          authorizationFiltered = true;
          continue;
        }
        items.push(item);
      }
    } while (cursor !== null && items.length < limit);
    return Object.freeze({ items: Object.freeze(items), nextCursor: cursor, authorizationFiltered });
  });
}

async function readAll(adapter: PersistenceAdapter, options: CreateTelemetryLedgerOptions, query: TelemetryQuery): Promise<{ readonly items: readonly TelemetryObservation[]; readonly authorizationFiltered: boolean }> {
  const items: TelemetryObservation[] = [];
  let authorizationFiltered = false;
  let cursor: string | null = null;
  do {
    const page = await readPage(adapter, options, { ...query, cursor, limit: options.configuration.queryPageSize }, true);
    items.push(...page.items);
    authorizationFiltered ||= page.authorizationFiltered;
    cursor = page.nextCursor;
  } while (cursor !== null);
  return Object.freeze({ items: Object.freeze(items), authorizationFiltered });
}

function withPartialUsage(summary: ReturnType<typeof summarizeUsage>, partial: boolean): ReturnType<typeof summarizeUsage> {
  if (!partial || summary.completeness !== "complete") return summary;
  const base = { ...summary, completeness: "partial" as const };
  const fingerprintInput = { ...base } as Record<string, unknown>;
  delete fingerprintInput["fingerprint"];
  return Object.freeze({ ...base, fingerprint: telemetrySnapshotFingerprint(fingerprintInput) });
}

function withPartialCost(summary: ReturnType<typeof summarizeCost>, partial: boolean): ReturnType<typeof summarizeCost> {
  if (!partial || summary.completeness !== "complete") return summary;
  const base = { ...summary, completeness: "partial" as const };
  const fingerprintInput = { ...base } as Record<string, unknown>;
  delete fingerprintInput["fingerprint"];
  return Object.freeze({ ...base, fingerprint: telemetrySnapshotFingerprint(fingerprintInput) });
}

export function createPersistenceTelemetryStore(rawOptions: CreateTelemetryLedgerOptions): TelemetryLedger {
  const options: CreateTelemetryLedgerOptions = Object.freeze({ ...rawOptions, ledgerId: ensureString(rawOptions.ledgerId, "telemetryLedger.ledgerId", { maxLength: 128, pattern: ID, patternName: "ledger id" }), configuration: parseTelemetryLedgerConfiguration(rawOptions.configuration) });
  let closed = false;
  const assertOpen = (): void => { if (closed) throw new TelemetryError("STORE_CLOSED", "ledger-closed"); };
  const authorizeQuery = async (rawQuery: TelemetryQuery): Promise<TelemetryQuery> => {
    assertOpen();
    const query = parseTelemetryQuery(rawQuery, options);
    const allowed = await authorize(options, "read", query.access, requestedScope(query.access), query.providerInstanceId ?? "scope-query", query.operationId ?? null);
    const audited = await audit(options, auditShape("read", allowed ? "allowed" : "denied", query.access, allowed ? "query-authorized" : "query-denied", query.providerInstanceId !== undefined && query.providerInstanceId !== null));
    if (!allowed) throw new TelemetryError("ACCESS_DENIED", "query-denied");
    if (!audited) throw new TelemetryError("AUDIT_FAILURE", "audit-failure");
    return query;
  };
  const queryPage = async (query: TelemetryQuery): Promise<TelemetryPage> => {
    const page = await readPage(options.adapter, options, await authorizeQuery(query));
    return Object.freeze({ items: page.items, nextCursor: page.nextCursor, truncated: page.nextCursor !== null || page.authorizationFiltered });
  };
  const queryAll = async (query: TelemetryQuery) => readAll(options.adapter, options, await authorizeQuery(query));
  const ledger: TelemetryLedger = {
    async ingestTelemetryObservation(draft: TelemetryObservationDraft, access: TelemetryAccessContext): Promise<IngestionResult> {
      assertOpen();
      try {
        const partition = deterministicPartition(draft.ledgerId, draft.observedAt, options.configuration.partitionDurationMs);
        const observation = createTelemetryObservation({ ...draft, staleAt: configuredStaleAt(draft, options) } as TelemetryObservationDraft, { partitionId: partition.partitionId, ingestedAt: options.clock.now().toISOString() });
        if (observation.ledgerId !== options.ledgerId) throw new TelemetryError("IDENTITY_CONFLICT", "ledger-id-mismatch");
        validateConfiguredObservation(observation, options);
        const allowed = matchesAccess(observation, access) && await authorize(options, "write", access, observation.scope, observation.identity.configuredInstanceId, observation.operationId);
        const audited = await audit(options, auditShape("write", allowed ? "allowed" : "denied", access, allowed ? "ingest-authorized" : "ingest-denied", true));
        if (!allowed) return Object.freeze({ outcome: "rejected", observation: null, eventId: null, checkpointFingerprint: null, code: "access-denied" });
        if (!audited) return Object.freeze({ outcome: "rejected", observation: null, eventId: null, checkpointFingerprint: null, code: "audit-failure" });
        for (let attempt = 0; attempt <= options.configuration.concurrency.maximumRetries; attempt += 1) {
          try { return await persistObservation(options.adapter, observation, options); }
          catch (error) {
            if (isPersistenceError(error, "CONCURRENCY_CONFLICT") && attempt < options.configuration.concurrency.maximumRetries) continue;
            throw error;
          }
        }
        throw new TelemetryError("CONCURRENCY_EXHAUSTED", "optimistic-retries-exhausted");
      } catch (error) {
        const conflict = isTelemetryError(error) && (error.code === "IDEMPOTENCY_CONFLICT" || error.code === "IDENTITY_CONFLICT" || error.code === "NON_MONOTONIC_USAGE" || error.code === "TERMINAL_CONTRADICTION");
        const code = isTelemetryError(error) ? error.detailCode : isPersistenceError(error) ? "persistence-failure" : "invalid-observation";
        await audit(options, auditShape("write", "failure", access, conflict ? "ingest-conflict" : code, false));
        if (conflict) return Object.freeze({ outcome: "conflict", observation: null, eventId: null, checkpointFingerprint: null, code });
        return Object.freeze({ outcome: "rejected", observation: null, eventId: null, checkpointFingerprint: null, code });
      }
    },
    queryObservations: queryPage,
    async reconcileOperationTelemetry(query) { const result = await queryAll(query); if (result.authorizationFiltered) throw new TelemetryError("ACCESS_DENIED", "observation-read-denied"); return reconcileOperation(result.items, query.operationId); },
    async queryUsageSummary(query) { const result = await queryAll(query); return withPartialUsage(summarizeUsage(result.items, query), result.authorizationFiltered); },
    async queryCostSummary(query) { const result = await queryAll(query); return withPartialCost(summarizeCost(result.items, query), result.authorizationFiltered); },
    async queryCapacitySnapshot(query): Promise<CapacitySnapshot> {
      const result = await queryAll(query); const active = activeTelemetryObservations(result.items).filter((item) => item.kind === "quota-window" || item.kind === "capacity" || item.kind === "provider-health");
      const keys = [...new Set(active.map(telemetrySignalKey))];
      const observations = Object.freeze(keys.flatMap((key) => { const group = active.filter((item) => telemetrySignalKey(item) === key); const current = currentEffectiveObservation(group, options.clock.now().toISOString()); return current === null ? [] : [current]; }));
      const now = options.clock.now().toISOString(); const staleCount = observations.filter((item) => item.staleAt !== null && item.staleAt <= now).length;
      const unknownCount = observations.filter((item) => (item.kind === "quota-window" || item.kind === "capacity" || item.kind === "provider-health") && item.data.state === "unknown").length;
      const unsupportedCount = observations.filter((item) => (item.kind === "quota-window" || item.kind === "capacity") && item.data.state === "unsupported").length;
      const sourceFingerprints = Object.freeze([...new Set(observations.map((item) => item.provenance.sourceFingerprint))].sort());
      const filters = Object.freeze({ providerInstanceId: query.providerInstanceId ?? null, contractModelId: query.contractModelId ?? null, upstreamModelId: query.upstreamModelId ?? null, operationId: query.operationId ?? null, observationId: query.observationId ?? null, dimension: query.dimension ?? null, window: query.window ?? null, providerWindowId: query.providerWindowId ?? null });
      const base = { asOf: now, interval: { from: query.from, to: query.to }, filters, observations, staleCount, unknownCount, unsupportedCount, sourceFingerprints, completeness: observations.length === 0 ? "unknown" as const : result.authorizationFiltered || staleCount + unknownCount + unsupportedCount > 0 ? "partial" as const : "complete" as const };
      return Object.freeze({ ...base, fingerprint: telemetrySnapshotFingerprint(base) });
    },
    async forecastCapacity(query): Promise<ForecastData> { const result = await queryAll(query); if (result.authorizationFiltered) throw new TelemetryError("ACCESS_DENIED", "observation-read-denied"); return deriveForecast(activeTelemetryObservations(result.items), { now: options.clock.now().toISOString(), configuration: options.configuration }); },
    async exportSnapshot(query): Promise<TelemetrySnapshot> {
      const page = await queryPage(query); const base = { schemaVersion: 1 as const, ledgerId: options.ledgerId, generatedAt: options.clock.now().toISOString(), interval: { from: query.from, to: query.to }, observations: page.items, truncated: page.truncated, nextCursor: page.nextCursor };
      return Object.freeze({ ...base, fingerprint: telemetrySnapshotFingerprint(base) });
    },
    async verifyTelemetryLedger(access: TelemetryAccessContext): Promise<TelemetryVerificationResult> {
      assertOpen(); const allowed = await authorize(options, "read", access, requestedScope(access), "scope-query", null);
      const audited = await audit(options, auditShape("verify", allowed ? "allowed" : "denied", access, allowed ? "verify-authorized" : "verify-denied", false));
      if (!allowed) throw new TelemetryError("ACCESS_DENIED", "verify-denied");
      if (!audited) throw new TelemetryError("AUDIT_FAILURE", "audit-failure");
      const checkpoints: string[] = []; const failures: string[] = []; const verifiedObservations: TelemetryObservation[] = []; let eventCount = 0; let partitionCount = 0;
      await options.adapter.transact(async (tx) => {
        let cursor: string | null = null;
        do {
          const page = await tx.aggregates.list({ aggregateType: "telemetry-ledger", limit: options.configuration.queryPageSize, cursor });
          for (const envelope of page.items) {
            let identified = false;
            try {
              const stored = parseTelemetryCheckpoint(envelope.payload);
              if (stored.ledgerId !== options.ledgerId) continue;
              identified = true;
              partitionCount += 1;
              const events = await listPartitionEvents(tx, envelope.aggregateId, options.configuration.eventPageSize); eventCount += events.length;
              const replayed = replayTelemetryPartition({ events, ledgerId: stored.ledgerId, partitionId: stored.partitionId, partitionStart: stored.partitionStart, partitionEnd: stored.partitionEnd });
              if (replayed.checkpointFingerprint !== stored.checkpointFingerprint) failures.push("checkpoint-replay-mismatch");
              checkpoints.push(replayed.checkpointFingerprint); verifiedObservations.push(...replayed.observations);
            } catch (error) {
              const likelyOwned = identified || envelope.aggregateId.startsWith(`${options.ledgerId.slice(0, 72)}-`);
              if (likelyOwned) { if (!identified) partitionCount += 1; failures.push(isTelemetryError(error) ? error.detailCode : "verification-failure"); }
            }
          }
          cursor = page.nextCursor;
          if (partitionCount > options.configuration.maximumPartitionCount) { failures.push("partition-count-exceeded"); break; }
        } while (cursor !== null);
      });
      try {
        const observationIds = new Set<string>(); const idempotencyKeys = new Set<string>(); const sources = new Map<string, string>();
        for (const observation of verifiedObservations) {
          if (observationIds.has(observation.observationId) || idempotencyKeys.has(observation.idempotencyKey)) throw new TelemetryError("INTEGRITY_FAILURE", "global-idempotency-conflict");
          observationIds.add(observation.observationId); idempotencyKeys.add(observation.idempotencyKey);
          const key = sourceKey(observation); const fingerprint = sources.get(key);
          if (fingerprint !== undefined && fingerprint !== observation.provenance.sourceFingerprint) throw new TelemetryError("INTEGRITY_FAILURE", "global-source-identity-conflict");
          sources.set(key, observation.provenance.sourceFingerprint);
        }
        validateCorrectionTargets(verifiedObservations);
        for (const operationId of new Set(verifiedObservations.flatMap((item) => item.operationId === null ? [] : [item.operationId]))) {
          const relevant = verifiedObservations.filter((item) => item.operationId === operationId && (item.kind === "operation-estimate" || item.kind === "cumulative-usage" || item.kind === "terminal-reconciliation" || item.kind === "correction"));
          if (activeTelemetryObservations(relevant).some((item) => item.kind !== "correction")) reconcileOperation(relevant, operationId);
        }
      } catch (error) { failures.push(isTelemetryError(error) ? error.detailCode : "verification-failure"); }
      failures.sort(); checkpoints.sort(); const base = { ok: failures.length === 0, partitionCount, eventCount, replayedCheckpointFingerprints: Object.freeze(checkpoints), failureCodes: Object.freeze(failures) };
      return Object.freeze({ ...base, fingerprint: telemetrySnapshotFingerprint(base) });
    },
    async close(): Promise<void> { if (!closed) { closed = true; await options.adapter.close(); } },
  };
  return Object.freeze(ledger);
}

export const createTelemetryLedger = createPersistenceTelemetryStore;
