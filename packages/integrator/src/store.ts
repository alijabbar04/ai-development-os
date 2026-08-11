import { DomainError, toCanonicalJson, validation } from "@ai-dev-os/domain";
import { PersistenceError, type AggregateEnvelope, type Clock, type EventRecord, type PersistenceAdapter, type TransactionContext } from "@ai-dev-os/persistence";
import { performance } from "node:perf_hooks";
import {
  INTEGRATION_PRODUCTION_ENABLED,
  type IntegrationAuditRecord,
  type IntegrationAuthorityConfiguration,
  type IntegrationEvent,
  type IntegrationEventCommand,
  type IntegrationGitPort,
  type IntegrationReceipt,
  type IntegrationRunSnapshot,
  type IntegrationValidationInput,
  type IntegrationValidationPort,
  type ProductionDisabledIntegrationService,
} from "./contracts.js";
import { INTEGRATION_ERROR_CODES, IntegrationError } from "./errors.js";
import {
  EMPTY_INTEGRATION_AUTHORITY_CONFIGURATION,
  INTEGRATION_LIMITS,
  integrationDigest,
  parseIntegrationAuthorityConfiguration,
  parseIntegrationCleanupResult,
  parseIntegrationCode,
  parseIntegrationId,
  parseIntegrationPreflightResult,
  parseIntegrationReceipt,
  parseIntegrationRecoveryState,
  parseIntegrationValidationResult,
  stableIntegrationId,
} from "./schema.js";
import {
  cancelIntegrationRun,
  claimIntegrationRun,
  completeIntegrationRun,
  exhaustIntegrationRecovery,
  createIntegrationRun,
  failIntegrationRun,
  exactIntegrationValidation,
  parseIntegrationCommandInput,
  parseIntegrationEvent,
  parseIntegrationRunSnapshot,
  prepareIntegrationRun,
  reconcileIntegrationRun,
  recordIntegrationReceipt,
  replayIntegrationEvents,
  startIntegrationRecovery,
  startIntegrationEffect,
  type IntegrationTransition,
  type ParsedIntegrationCommandInput,
} from "./state.js";

export interface CreateIntegrationServiceOptions {
  readonly persistence: PersistenceAdapter;
  readonly clock: Clock;
  readonly git: IntegrationGitPort;
  readonly validation: IntegrationValidationPort;
  readonly authorityConfiguration?: unknown;
  readonly trustedAuthorityConfigurationFingerprints?: unknown;
  readonly audit?: (record: IntegrationAuditRecord) => void;
  readonly effectsEnabledForTesting?: boolean;
}

interface LoadedIntegration {
  readonly snapshot: IntegrationRunSnapshot;
  readonly persistenceVersion: number;
  readonly history: readonly IntegrationEvent[];
}

function eventFromRecord(record: EventRecord): IntegrationEvent {
  try {
    const event = parseIntegrationEvent(record.payload);
    if (
      record.aggregateType !== "integration-run" || record.aggregateId !== event.runId ||
      record.aggregateVersion !== event.aggregateVersion || record.eventType !== "integration.event" ||
      record.eventSchemaVersion !== 1 || record.eventId !== event.eventId || record.occurredAt !== event.occurredAt ||
      record.traceId !== null || record.causationId !== null
    ) throw new IntegrationError("PERSISTENCE_MISMATCH", "Persisted integration event envelope is inconsistent.");
    return event;
  } catch (error) {
    if (error instanceof IntegrationError && error.code === "PERSISTENCE_MISMATCH") throw error;
    throw new IntegrationError("PERSISTENCE_MISMATCH", "Persisted integration event is malformed.", { failureKind: error instanceof Error ? "error" : "non-error" });
  }
}

async function listEvents(tx: TransactionContext, runId: string): Promise<readonly EventRecord[]> {
  const records: EventRecord[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    if (cursor !== null) {
      if (seen.has(cursor)) throw new IntegrationError("PERSISTENCE_MISMATCH", "Integration journal pagination repeated a cursor.");
      seen.add(cursor);
    }
    const remaining = INTEGRATION_LIMITS.maximumJournalEvents + 1 - records.length;
    if (remaining <= 0) throw new IntegrationError("PERSISTENCE_MISMATCH", "Integration journal exceeds its exact bound.");
    const page = await tx.events.list({ aggregateType: "integration-run", aggregateId: runId, limit: remaining, cursor });
    if (page.items.length === 0 && page.nextCursor !== null) throw new IntegrationError("PERSISTENCE_MISMATCH", "Integration journal pagination did not make progress.");
    records.push(...page.items);
    if (records.length > INTEGRATION_LIMITS.maximumJournalEvents) throw new IntegrationError("PERSISTENCE_MISMATCH", "Integration journal exceeds its exact bound.");
    cursor = page.nextCursor;
  } while (cursor !== null);
  return Object.freeze(records);
}

async function appendEvent(tx: TransactionContext, event: IntegrationEvent): Promise<void> {
  await tx.events.append({
    eventId: event.eventId,
    aggregateType: "integration-run",
    aggregateId: event.runId,
    aggregateVersion: event.aggregateVersion,
    eventType: "integration.event",
    eventSchemaVersion: 1,
    payload: event,
    occurredAt: event.occurredAt,
    traceId: null,
    causationId: null,
  });
}

function envelopeMatches(envelope: AggregateEnvelope, replayed: IntegrationRunSnapshot): boolean {
  return envelope.aggregateType === "integration-run" && envelope.aggregateId === replayed.runId &&
    envelope.schemaVersion === 1 && envelope.aggregateVersion === replayed.aggregateVersion && envelope.traceId === null &&
    toCanonicalJson(envelope.payload) === toCanonicalJson(replayed);
}

function publicCommandMatches(event: IntegrationEvent, input: ParsedIntegrationCommandInput): boolean {
  const command = event.command;
  return command.commandId === input.commandId && command.expectedVersion === input.expectedVersion &&
    command.owner === input.owner && command.leaseId === input.leaseId && command.leaseExpiresAt === input.leaseExpiresAt &&
    (input.fencingToken === null || command.fencingToken === input.fencingToken) && command.submittedAt === input.occurredAt &&
    input.reasonCode === (event.type === "integration.cancelled" ? command.reasonCode : null);
}

type PublicOperation = "claim" | "prepare" | "execute" | "reconcile" | "cancel";

function eventMatchesOperation(event: IntegrationEvent, operation: PublicOperation): boolean {
  if (operation === "claim") return event.type === "integration.leased";
  if (operation === "prepare") return ["integration.prepared", "integration.failed", "integration.retry-scheduled"].includes(event.type);
  if (operation === "execute") return event.type === "integration.effect-started";
  if (operation === "reconcile") return ["integration.recovery-started", "integration.recovery-exhausted"].includes(event.type);
  return event.type === "integration.cancelled";
}

function internalCommand(input: ParsedIntegrationCommandInput, suffix: string, expectedVersion: number, occurredAt: string, binding = input.commandId): ParsedIntegrationCommandInput {
  return Object.freeze({
    ...input,
    commandId: stableIntegrationId("integration-internal", binding, suffix),
    expectedVersion,
    leaseExpiresAt: null,
    reasonCode: null,
    occurredAt,
  });
}

function maxTimestamp(...values: readonly string[]): string {
  return [...values].sort().at(-1)!;
}

export function createIntegrationService(options: CreateIntegrationServiceOptions): ProductionDisabledIntegrationService {
  const authorityConfiguration = parseIntegrationAuthorityConfiguration(options.authorityConfiguration ?? EMPTY_INTEGRATION_AUTHORITY_CONFIGURATION);
  const gitPort: IntegrationGitPort = Object.freeze({
    portId: options.git.portId,
    schemaVersion: options.git.schemaVersion,
    routeFingerprint: options.git.routeFingerprint,
    targetFingerprint: options.git.targetFingerprint,
    preflight: options.git.preflight.bind(options.git),
    integrate: options.git.integrate.bind(options.git),
    reconcile: options.git.reconcile.bind(options.git),
    cleanup: options.git.cleanup.bind(options.git),
  });
  const validationPort: IntegrationValidationPort = Object.freeze({
    portId: options.validation.portId,
    schemaVersion: options.validation.schemaVersion,
    routeFingerprint: options.validation.routeFingerprint,
    validate: options.validation.validate.bind(options.validation),
  });
  const trustedFingerprints = new Set([
    authorityConfiguration.configurationFingerprint,
    ...validation.ensureArray(options.trustedAuthorityConfigurationFingerprints ?? [], "trustedAuthorityConfigurationFingerprints", 1_024)
      .map((value, index) => validation.ensureString(value, `trustedAuthorityConfigurationFingerprints[${index}]`, { maxLength: 64, pattern: /^[a-f0-9]{64}$/, patternName: "sha256" })),
  ]);
  const effectsEnabled = options.effectsEnabledForTesting === true;

  const currentTimestamp = (): string => {
    const now = options.clock.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new IntegrationError("INVALID_INPUT", "Integration clock returned an invalid instant.");
    return now.toISOString();
  };

  const assertCommandNotFromFuture = (input: ParsedIntegrationCommandInput): string => {
    const now = currentTimestamp();
    if (input.occurredAt > now) throw new IntegrationError("INVALID_INPUT", "Integration command time is later than the trusted service clock.");
    return now;
  };

  const observe = (operation: string, outcome: IntegrationAuditRecord["outcome"], snapshot: IntegrationRunSnapshot | null, code: string | null): void => {
    try { options.audit?.(Object.freeze({ operation, outcome, runVersion: snapshot?.aggregateVersion ?? null, code })); } catch { /* observer is non-authoritative */ }
  };

  const closedIntegrationCode = (error: unknown): IntegrationError["code"] | null =>
    error instanceof IntegrationError && (INTEGRATION_ERROR_CODES as readonly string[]).includes(error.code) ? error.code : null;

  const finitePublicError = (error: unknown): IntegrationError => {
    const code = closedIntegrationCode(error);
    if (code !== null) {
      return new IntegrationError(code, `Integration operation failed with finite code ${code}.`);
    }
    if (error instanceof DomainError) return new IntegrationError("INVALID_INPUT", "Integration input failed finite validation.");
    if (error instanceof PersistenceError) return new IntegrationError("PERSISTENCE_MISMATCH", "Integration persistence boundary failed.");
    return new IntegrationError("PERSISTENCE_MISMATCH", "Integration operation failed at a finite boundary.");
  };

  const assertEffectsEnabled = (): void => {
    if (!effectsEnabled) throw new IntegrationError("PRODUCTION_DISABLED", "Git integration effects are disabled in this checkpoint.");
  };

  const assertPortBindings = (snapshot: IntegrationRunSnapshot): void => {
    const request = snapshot.request;
    if (gitPort.portId !== request.gitPortId || gitPort.schemaVersion !== request.gitPortSchemaVersion ||
        gitPort.routeFingerprint !== request.gitRouteFingerprint || gitPort.targetFingerprint !== request.gitTargetFingerprint ||
        validationPort.portId !== request.validationPlan.validatorId || validationPort.schemaVersion !== request.validationPlan.validatorSchemaVersion ||
        validationPort.routeFingerprint !== request.validationPlan.routeFingerprint) {
      throw new IntegrationError("UNAUTHORIZED", "Injected Git or validation port does not match the exact authorized request route.");
    }
  };

  async function load(tx: TransactionContext, runId: string): Promise<LoadedIntegration | null> {
    const envelope = await tx.aggregates.get("integration-run", runId);
    if (envelope === null) return null;
    const records = await listEvents(tx, runId);
    const history = Object.freeze(records.map(eventFromRecord));
    const replayed = replayIntegrationEvents(history);
    if (!trustedFingerprints.has(replayed.authorityConfiguration.configurationFingerprint) || !envelopeMatches(envelope, replayed)) {
      throw new IntegrationError("PERSISTENCE_MISMATCH", "Integration checkpoint differs from exact journal replay.");
    }
    return Object.freeze({ snapshot: replayed, persistenceVersion: envelope.aggregateVersion, history });
  }

  async function listCheckpoints(tx: TransactionContext): Promise<readonly IntegrationRunSnapshot[]> {
    const snapshots: IntegrationRunSnapshot[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      if (cursor !== null) {
        if (seen.has(cursor)) throw new IntegrationError("PERSISTENCE_MISMATCH", "Integration listing repeated a cursor.");
        seen.add(cursor);
      }
      const remaining = INTEGRATION_LIMITS.maximumRetainedRuns + 1 - snapshots.length;
      if (remaining <= 0) throw new IntegrationError("LIMIT_EXCEEDED", "Retained integration-run bound is exhausted.");
      const page = await tx.aggregates.list({ aggregateType: "integration-run", limit: Math.min(1_000, remaining), cursor });
      if (page.items.length === 0 && page.nextCursor !== null) throw new IntegrationError("PERSISTENCE_MISMATCH", "Integration listing did not make progress.");
      for (const item of page.items) {
        if (item.aggregateType !== "integration-run") throw new IntegrationError("PERSISTENCE_MISMATCH", "Integration listing returned a foreign aggregate.");
        const loaded = await load(tx, item.aggregateId);
        if (loaded === null) throw new IntegrationError("PERSISTENCE_MISMATCH", "Integration listing returned an absent aggregate.");
        snapshots.push(loaded.snapshot);
      }
      if (snapshots.length > INTEGRATION_LIMITS.maximumRetainedRuns) throw new IntegrationError("LIMIT_EXCEEDED", "Retained integration-run bound is exhausted.");
      cursor = page.nextCursor;
    } while (cursor !== null);
    return Object.freeze(snapshots);
  }

  async function persistTransition(tx: TransactionContext, previousVersion: number, transition: IntegrationTransition): Promise<void> {
    const envelope = await tx.aggregates.update({
      aggregateType: "integration-run",
      aggregateId: transition.snapshot.runId,
      schemaVersion: 1,
      expectedVersion: previousVersion,
      payload: transition.snapshot,
      traceId: null,
    });
    if (envelope.aggregateVersion !== transition.snapshot.aggregateVersion) throw new IntegrationError("PERSISTENCE_MISMATCH", "Integration persistence version did not advance exactly once.");
    await appendEvent(tx, transition.event);
  }

  async function duplicateOrLoaded(tx: TransactionContext, input: ParsedIntegrationCommandInput, operation: PublicOperation): Promise<{ readonly loaded: LoadedIntegration; readonly duplicate: boolean }> {
    const loaded = await load(tx, input.runId);
    if (loaded === null) throw new IntegrationError("NOT_FOUND", "Integration run does not exist.");
    const existing = loaded.history.find((event) => event.command.commandId === input.commandId);
    if (existing === undefined) return Object.freeze({ loaded, duplicate: false });
    if (!eventMatchesOperation(existing, operation) || !publicCommandMatches(existing, input)) throw new IntegrationError("CONFLICT", "Integration command identity was reused with different content.");
    return Object.freeze({ loaded, duplicate: true });
  }

  interface PortDeadline {
    readonly primaryMonotonicDeadline: number;
    readonly cleanupMonotonicDeadline: number;
  }

  function createPortDeadline(snapshot: IntegrationRunSnapshot, allowExpiredRequest = false): PortDeadline {
    const remainingRequestMs = Date.parse(snapshot.request.deadline) - Date.parse(currentTimestamp());
    if (!Number.isFinite(remainingRequestMs) || (!allowExpiredRequest && remainingRequestMs <= 0)) throw new IntegrationError("TIMEOUT", "Integration request deadline has expired.");
    const availableMs = allowExpiredRequest && remainingRequestMs <= 0
      ? snapshot.request.bounds.maximumWallTimeMs
      : Math.min(snapshot.request.bounds.maximumWallTimeMs, remainingRequestMs);
    const now = performance.now();
    const cleanupReserveMs = Math.min(5_000, Math.max(1, Math.floor(availableMs / 4)));
    return Object.freeze({
      primaryMonotonicDeadline: now + Math.max(0, availableMs - cleanupReserveMs),
      // Cleanup is containment, so it retains a separate finite grace even if
      // cancellation of the preceding boundary consumes the full drain bound.
      cleanupMonotonicDeadline: now + availableMs + 5_000,
    });
  }

  async function withPortDeadline<T>(deadline: PortDeadline, work: (signal: AbortSignal) => Promise<T>, useCleanupReserve = false): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remainingMs = (useCleanupReserve ? deadline.cleanupMonotonicDeadline : deadline.primaryMonotonicDeadline) - performance.now();
    if (remainingMs <= 0) throw new IntegrationError("TIMEOUT", "Integration operation exhausted its reviewed wall-time bound.");
    const workOutcome = Promise.resolve().then(() => work(controller.signal)).then(
      (value) => Object.freeze({ kind: "value" as const, value }),
      (error: unknown) => Object.freeze({ kind: "error" as const, error }),
    );
    try {
      const outcome = await Promise.race([
        workOutcome,
        new Promise<Readonly<{ kind: "timeout" }>>((resolveTimeout) => {
          timer = setTimeout(() => {
            controller.abort();
            resolveTimeout(Object.freeze({ kind: "timeout" as const }));
          }, Math.max(1, Math.ceil(remainingMs)));
        }),
      ]);
      if (outcome.kind === "value") return outcome.value;
      if (outcome.kind === "error") throw outcome.error;
      const drained = await Promise.race([
        workOutcome.then(() => true),
        new Promise<false>((resolveDrain) => {
          setTimeout(() => resolveDrain(false), 5_000);
        }),
      ]);
      if (!drained) throw new IntegrationError("TIMEOUT", "Integration boundary cancellation did not settle within its finite drain bound.", { reason: "drain-unconfirmed" });
      throw new IntegrationError("TIMEOUT", "Integration boundary exceeded its reviewed wall-time bound.");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function persistFailure(input: ParsedIntegrationCommandInput, code: string): Promise<IntegrationRunSnapshot> {
    return await options.persistence.transact(async (tx) => {
      const result = await duplicateOrLoaded(tx, input, "prepare");
      if (result.duplicate) return result.loaded.snapshot;
      const failureAt = maxTimestamp(input.occurredAt, currentTimestamp());
      const transition = failIntegrationRun(result.loaded.snapshot, input, parseIntegrationCode(code, "failureCode"), null, failureAt);
      await persistTransition(tx, result.loaded.persistenceVersion, transition);
      return transition.snapshot;
    });
  }

  async function claimWithBoundedConcurrencyRetry<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (!(error instanceof PersistenceError) || error.code !== "CONCURRENCY_CONFLICT" || attempt === 2) throw error;
      }
    }
    throw new IntegrationError("PERSISTENCE_MISMATCH", "Bounded integration claim retry was exhausted.");
  }

  function assertExternalPreconditions(snapshot: IntegrationRunSnapshot, input: ParsedIntegrationCommandInput, statuses: readonly IntegrationRunSnapshot["status"][], requireActiveLease = true): void {
    if (snapshot.aggregateVersion !== input.expectedVersion || input.runId !== snapshot.runId || !statuses.includes(snapshot.status)) {
      throw new IntegrationError("INVALID_TRANSITION", "Integration command cannot invoke an external boundary from the current durable state.");
    }
    const lease = snapshot.lease;
    if (lease === null || lease.owner !== input.owner || lease.leaseId !== input.leaseId || lease.fencingToken !== input.fencingToken) {
      throw new IntegrationError("STALE_FENCE", "Integration command cannot invoke an external boundary with stale ownership.");
    }
    if (input.occurredAt < snapshot.updatedAt || input.occurredAt < lease.acquiredAt) {
      throw new IntegrationError("INVALID_INPUT", "Integration command predates the durable state or active lease.");
    }
    const now = assertCommandNotFromFuture(input);
    if (requireActiveLease && (input.occurredAt >= lease.expiresAt || now >= lease.expiresAt || now >= snapshot.request.deadline)) throw new IntegrationError("LEASE_CONFLICT", "Integration command cannot invoke an external boundary after lease or request expiry.");
  }

  const failedCleanup = (worktreeId: string): ReturnType<typeof parseIntegrationCleanupResult> => parseIntegrationCleanupResult(Object.freeze({
    worktreeId,
    cleaned: false,
    preservedEvidence: false,
    failureCode: "cleanup-boundary-failed",
    observedAt: currentTimestamp(),
  }));

  async function finishCommitted(input: ParsedIntegrationCommandInput, snapshot: IntegrationRunSnapshot, deadline: PortDeadline): Promise<IntegrationRunSnapshot> {
    const receipt = snapshot.receipt;
    if (receipt === null) throw new IntegrationError("PERSISTENCE_MISMATCH", "Committed integration has no receipt.");
    let validationResult: ReturnType<typeof parseIntegrationValidationResult> | null = null;
    let validationFailureCode = "post-validation-boundary-failed";
    try {
      const validationInput: IntegrationValidationInput = Object.freeze({ phase: "post-integration", request: snapshot.request, headCommit: receipt.integratedCommit, treeId: receipt.integratedTree, plan: snapshot.request.validationPlan });
      validationResult = parseIntegrationValidationResult(await withPortDeadline(deadline, (signal) => validationPort.validate(validationInput, signal)));
      const afterValidation = currentTimestamp();
      if (afterValidation > snapshot.request.deadline || validationResult.evaluatedAt > afterValidation || !exactIntegrationValidation(snapshot.request, validationResult, "post-integration", receipt.integratedCommit, receipt.integratedTree, true)) {
        validationResult = null;
        validationFailureCode = "post-validation-invalid";
      }
    } catch { /* the durable failure below records a finite boundary code */ }
    let cleanupResult: ReturnType<typeof parseIntegrationCleanupResult>;
    try {
      cleanupResult = parseIntegrationCleanupResult(await withPortDeadline(deadline, (signal) => gitPort.cleanup(receipt.worktreeId, signal), true));
      const afterCleanup = currentTimestamp();
      if (afterCleanup > snapshot.request.deadline || cleanupResult.worktreeId !== receipt.worktreeId || cleanupResult.observedAt < snapshot.updatedAt || cleanupResult.observedAt > afterCleanup) cleanupResult = failedCleanup(receipt.worktreeId);
    } catch {
      cleanupResult = failedCleanup(receipt.worktreeId);
    }
    const terminalAt = maxTimestamp(input.occurredAt, validationResult?.evaluatedAt ?? snapshot.updatedAt, cleanupResult.observedAt);
    const terminalInput = internalCommand(input, validationResult === null ? "terminal-failure" : "terminal", snapshot.aggregateVersion, terminalAt, receipt.receiptDigest);
    return await options.persistence.transact(async (tx) => {
      const loaded = await load(tx, input.runId);
      if (loaded === null) throw new IntegrationError("NOT_FOUND", "Integration run does not exist.");
      if (loaded.snapshot.status !== "committed") return loaded.snapshot;
      const transition = validationResult === null
        ? failIntegrationRun(loaded.snapshot, terminalInput, validationFailureCode, cleanupResult)
        : completeIntegrationRun(loaded.snapshot, terminalInput, validationResult, cleanupResult);
      await persistTransition(tx, loaded.persistenceVersion, transition);
      return transition.snapshot;
    });
  }

  const service: ProductionDisabledIntegrationService = {
    productionEnabled: INTEGRATION_PRODUCTION_ENABLED,

    async accept(input: unknown): Promise<IntegrationRunSnapshot> {
      const candidate = createIntegrationRun(input, authorityConfiguration);
      assertPortBindings(candidate.snapshot);
      try {
        const outcome = await options.persistence.transact(async (tx) => {
          const existing = await load(tx, candidate.snapshot.runId);
          if (existing !== null) {
            if (existing.snapshot.request.requestDigest !== candidate.snapshot.request.requestDigest) throw new IntegrationError("CONFLICT", "Integration run identity was reused with different immutable input.");
            return Object.freeze({ snapshot: existing.snapshot, changed: false });
          }
          const all = await listCheckpoints(tx);
          const sameIdempotency = all.find((item) => item.request.idempotencyKey === candidate.snapshot.request.idempotencyKey);
          if (sameIdempotency !== undefined) {
            if (sameIdempotency.request.requestDigest === candidate.snapshot.request.requestDigest) return Object.freeze({ snapshot: sameIdempotency, changed: false });
            throw new IntegrationError("CONFLICT", "Integration idempotency key was reused with different immutable input.");
          }
          if (all.length >= INTEGRATION_LIMITS.maximumRetainedRuns) throw new IntegrationError("LIMIT_EXCEEDED", "Retained integration-run bound is exhausted.");
          const envelope = await tx.aggregates.create({ aggregateType: "integration-run", aggregateId: candidate.snapshot.runId, schemaVersion: 1, payload: candidate.snapshot, traceId: null });
          if (envelope.aggregateVersion !== 1) throw new IntegrationError("PERSISTENCE_MISMATCH", "Integration creation version is inconsistent.");
          await appendEvent(tx, candidate.event);
          return Object.freeze({ snapshot: candidate.snapshot, changed: true });
        });
        observe("accept", outcome.changed ? "succeeded" : "duplicate", outcome.snapshot, null);
        return outcome.snapshot;
      } catch (error) { observe("accept", "failed", null, closedIntegrationCode(error) ?? "persistence-error"); throw error; }
    },

    async claim(value: unknown): Promise<IntegrationRunSnapshot> {
      const input = parseIntegrationCommandInput(value, "claim");
      try {
        const outcome = await claimWithBoundedConcurrencyRetry(() => options.persistence.transact(async (tx) => {
          const result = await duplicateOrLoaded(tx, input, "claim");
          if (result.duplicate) return Object.freeze({ snapshot: result.loaded.snapshot, changed: false });
          const now = assertCommandNotFromFuture(input);
          if (input.leaseExpiresAt === null || now >= input.leaseExpiresAt || now >= result.loaded.snapshot.request.deadline) throw new IntegrationError("LEASE_CONFLICT", "Integration claim cannot create an already-expired lease.");
          const all = await listCheckpoints(tx);
          const targetRequest = result.loaded.snapshot.request;
          const blocking = all.find((item) => item.runId !== input.runId && item.request.gitTargetFingerprint === targetRequest.gitTargetFingerprint && item.request.repository.targetRef.toLowerCase() === targetRequest.repository.targetRef.toLowerCase() &&
            (["effect-uncertain", "committed", "reconciling", "manual-reconciliation-required"].includes(item.status) || ["leased", "prepared"].includes(item.status) && item.lease !== null && now < item.lease.expiresAt));
          if (blocking !== undefined) throw new IntegrationError("LEASE_CONFLICT", "Another integration run serializes this repository target.");
          const transition = claimIntegrationRun(result.loaded.snapshot, input);
          await persistTransition(tx, result.loaded.persistenceVersion, transition);
          return Object.freeze({ snapshot: transition.snapshot, changed: true });
        }));
        observe("claim", outcome.changed ? "succeeded" : "duplicate", outcome.snapshot, null);
        return outcome.snapshot;
      } catch (error) { observe("claim", "failed", null, closedIntegrationCode(error) ?? "persistence-error"); throw error; }
    },

    async prepare(value: unknown): Promise<IntegrationRunSnapshot> {
      assertEffectsEnabled();
      const input = parseIntegrationCommandInput(value, "prepare");
      const initial = await options.persistence.transact((tx) => duplicateOrLoaded(tx, input, "prepare"));
      if (initial.duplicate) return initial.loaded.snapshot;
      const snapshot = initial.loaded.snapshot;
      assertPortBindings(snapshot);
      assertExternalPreconditions(snapshot, input, ["leased"]);
      try {
        const deadline = createPortDeadline(snapshot);
        const preflight = parseIntegrationPreflightResult(await withPortDeadline(deadline, (signal) => gitPort.preflight(snapshot.request, signal)));
        const afterPreflight = currentTimestamp();
        if (snapshot.lease === null || afterPreflight >= snapshot.lease.expiresAt || afterPreflight >= snapshot.request.deadline) throw new IntegrationError("TIMEOUT", "Git preflight returned after the active lease or request deadline.");
        if (preflight.checkedAt > afterPreflight) throw new IntegrationError("INVALID_INPUT", "Git preflight returned future-dated evidence.");
        const validationInput: IntegrationValidationInput = Object.freeze({ phase: "pre-integration", request: snapshot.request, headCommit: snapshot.request.repository.sourceCommit, treeId: snapshot.request.repository.expectedIntegratedTree, plan: snapshot.request.validationPlan });
        const validationResult = parseIntegrationValidationResult(await withPortDeadline(deadline, (signal) => validationPort.validate(validationInput, signal)));
        const afterValidation = currentTimestamp();
        if (snapshot.lease === null || afterValidation >= snapshot.lease.expiresAt || afterValidation >= snapshot.request.deadline) throw new IntegrationError("TIMEOUT", "Preparation validation returned after the active lease or request deadline.");
        if (validationResult.evaluatedAt > afterValidation) throw new IntegrationError("INVALID_INPUT", "Validation returned future-dated preparation evidence.");
        const outcome = await options.persistence.transact(async (tx) => {
          const current = await duplicateOrLoaded(tx, input, "prepare");
          if (current.duplicate) return Object.freeze({ snapshot: current.loaded.snapshot, changed: false });
          assertPortBindings(current.loaded.snapshot);
          assertExternalPreconditions(current.loaded.snapshot, input, ["leased"]);
          const transition = prepareIntegrationRun(current.loaded.snapshot, input, preflight, validationResult);
          await persistTransition(tx, current.loaded.persistenceVersion, transition);
          return Object.freeze({ snapshot: transition.snapshot, changed: true });
        });
        observe("prepare", outcome.changed ? "succeeded" : "duplicate", outcome.snapshot, null);
        return outcome.snapshot;
      } catch (error) {
        const finiteCode = closedIntegrationCode(error);
        const failed = await persistFailure(input, finiteCode === null ? "preflight-boundary-failed" : finiteCode.toLowerCase().replaceAll("_", "-"));
        observe("prepare", "failed", failed, failed.lastFailureCode);
        return failed;
      }
    },

    async execute(value: unknown): Promise<IntegrationRunSnapshot> {
      assertEffectsEnabled();
      const input = parseIntegrationCommandInput(value, "execute");
      const initial = await options.persistence.transact((tx) => duplicateOrLoaded(tx, input, "execute"));
      if (initial.duplicate) return initial.loaded.snapshot;
      assertPortBindings(initial.loaded.snapshot);
      assertExternalPreconditions(initial.loaded.snapshot, input, ["prepared"]);
      const started = await options.persistence.transact(async (tx) => {
        const current = await duplicateOrLoaded(tx, input, "execute");
        if (current.duplicate) return Object.freeze({ snapshot: current.loaded.snapshot, changed: false });
        assertPortBindings(current.loaded.snapshot);
        assertExternalPreconditions(current.loaded.snapshot, input, ["prepared"]);
        const transition = startIntegrationEffect(current.loaded.snapshot, input, maxTimestamp(input.occurredAt, currentTimestamp()));
        await persistTransition(tx, current.loaded.persistenceVersion, transition);
        return Object.freeze({ snapshot: transition.snapshot, changed: true });
      });
      if (!started.changed) return started.snapshot;
      const intent = started.snapshot.intent!;
      let receipt: IntegrationReceipt;
      let committed: IntegrationRunSnapshot;
      let deadline: PortDeadline;
      try {
        deadline = createPortDeadline(started.snapshot);
        receipt = parseIntegrationReceipt(await withPortDeadline(deadline, (signal) => gitPort.integrate(intent, started.snapshot.request, signal)));
        assertPortBindings(started.snapshot);
        const afterEffect = currentTimestamp();
        if (receipt.committedAt > afterEffect) throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Git integration returned a future-dated receipt.");
        if (started.snapshot.lease === null || afterEffect >= started.snapshot.lease.expiresAt || afterEffect >= started.snapshot.request.deadline) {
          throw new IntegrationError("TIMEOUT", "Git integration returned after the active lease or request deadline.");
        }
        const receiptInput = internalCommand(input, "receipt", started.snapshot.aggregateVersion, maxTimestamp(input.occurredAt, receipt.committedAt), intent.intentDigest);
        committed = await options.persistence.transact(async (tx) => {
          const loaded = await load(tx, input.runId);
          if (loaded === null) throw new IntegrationError("NOT_FOUND", "Integration run does not exist.");
          const transition = recordIntegrationReceipt(loaded.snapshot, receiptInput, receipt);
          await persistTransition(tx, loaded.persistenceVersion, transition);
          return transition.snapshot;
        });
      } catch (error) {
        observe("execute", "failed", started.snapshot, "EFFECT_UNCERTAIN");
        throw new IntegrationError("EFFECT_UNCERTAIN", "Git effect outcome is uncertain; reconciliation is required before any retry.", {
          causeCode: error instanceof IntegrationError ? error.code : "boundary-failure",
          causeKind: error instanceof Error ? "error" : "non-error",
          causeExitCode: error instanceof IntegrationError && typeof error.details["exitCode"] === "number" ? error.details["exitCode"] : null,
        });
      }
      const terminal = await finishCommitted(input, committed, deadline);
      observe("execute", terminal.status === "completed" ? "succeeded" : "failed", terminal, terminal.lastFailureCode);
      return terminal;
    },

    async reconcile(value: unknown): Promise<IntegrationRunSnapshot> {
      assertEffectsEnabled();
      const input = parseIntegrationCommandInput(value, "reconcile");
      const started = await options.persistence.transact(async (tx) => {
        const current = await duplicateOrLoaded(tx, input, "reconcile");
        if (current.duplicate) return Object.freeze({ snapshot: current.loaded.snapshot, changed: false, exhausted: false });
        const snapshot = current.loaded.snapshot;
        assertPortBindings(snapshot);
        if (!["effect-uncertain", "committed", "reconciling"].includes(snapshot.status)) throw new IntegrationError("INVALID_TRANSITION", "Only an uncertain, committed, or expired recovery attempt can be reconciled.");
        const now = currentTimestamp();
        const retryAt = new Date(snapshot.updatedAt).getTime() + snapshot.request.bounds.maximumWallTimeMs + 5_000;
        if (new Date(now).getTime() <= retryAt) throw new IntegrationError("LEASE_CONFLICT", "The prior effect, terminalization, or recovery boundary has not yet become durably stale.");
        assertExternalPreconditions(snapshot, input, ["effect-uncertain", "committed", "reconciling"], false);
        if (snapshot.status === "reconciling" && snapshot.recoveryAttempts === snapshot.request.retryPolicy.maximumAttempts) {
          const exhaustionInput = Object.freeze({
            ...input,
            expectedVersion: snapshot.aggregateVersion,
          });
          const exhausted = exhaustIntegrationRecovery(snapshot, exhaustionInput, now);
          await persistTransition(tx, current.loaded.persistenceVersion, exhausted);
          return Object.freeze({ snapshot: exhausted.snapshot, changed: false, exhausted: true });
        }
        const transition = startIntegrationRecovery(snapshot, input, now);
        await persistTransition(tx, current.loaded.persistenceVersion, transition);
        return Object.freeze({ snapshot: transition.snapshot, changed: true, exhausted: false });
      });
      if (!started.changed) {
        if (started.exhausted) observe("reconcile", "failed", started.snapshot, started.snapshot.lastFailureCode);
        return started.snapshot;
      }
      const snapshot = started.snapshot;
      const deadline = createPortDeadline(snapshot, true);
      let recovery: ReturnType<typeof parseIntegrationRecoveryState>;
      try {
        recovery = parseIntegrationRecoveryState(await withPortDeadline(deadline, (signal) => gitPort.reconcile(snapshot.intent!, snapshot.request, snapshot.receipt, signal)));
      } catch {
        if (snapshot.recoveryAttempts === snapshot.request.retryPolicy.maximumAttempts) {
          const exhaustionAt = currentTimestamp();
          const exhaustionInput = Object.freeze({
            ...input,
            expectedVersion: snapshot.aggregateVersion,
          });
          const exhausted = await options.persistence.transact(async (tx) => {
            const current = await load(tx, input.runId);
            if (current === null) throw new IntegrationError("NOT_FOUND", "Integration run does not exist.");
            if (current.snapshot.aggregateVersion !== snapshot.aggregateVersion || current.snapshot.status !== "reconciling") return current.snapshot;
            const next = exhaustIntegrationRecovery(current.snapshot, exhaustionInput, exhaustionAt);
            await persistTransition(tx, current.persistenceVersion, next);
            return next.snapshot;
          });
          observe("reconcile", "failed", exhausted, exhausted.lastFailureCode);
          return exhausted;
        }
        throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Git reconciliation boundary failed with finite redacted evidence.");
      }
      if (recovery.observedAt > currentTimestamp()) throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Git reconciliation returned future-dated recovery evidence.");
      let validationResult: ReturnType<typeof parseIntegrationValidationResult> | null = null;
      let evidenceFailureCode: string | null = null;
      if (recovery.state === "ref-published" && recovery.receipt !== null) {
        const validationInput: IntegrationValidationInput = Object.freeze({ phase: "post-integration", request: snapshot.request, headCommit: recovery.receipt.integratedCommit, treeId: recovery.receipt.integratedTree, plan: snapshot.request.validationPlan });
        try {
          validationResult = parseIntegrationValidationResult(await withPortDeadline(deadline, (signal) => validationPort.validate(validationInput, signal)));
          if (!exactIntegrationValidation(snapshot.request, validationResult, "post-integration", recovery.receipt.integratedCommit, recovery.receipt.integratedTree, false)) {
            validationResult = null;
            evidenceFailureCode = "post-validation-invalid";
          }
        } catch {
          validationResult = null;
          evidenceFailureCode = "post-validation-boundary-failed";
        }
      }
      const worktreeId = recovery.receipt?.worktreeId ?? stableIntegrationId("integration-worktree", snapshot.intent!.intentId);
      let cleanupResult = await withPortDeadline(deadline, (signal) => gitPort.cleanup(worktreeId, signal), true).then((value) => parseIntegrationCleanupResult(value)).catch(() => failedCleanup(worktreeId));
      const observedNow = currentTimestamp();
      if (validationResult !== null && validationResult.evaluatedAt > observedNow) {
        validationResult = null;
        evidenceFailureCode = "post-validation-invalid";
      }
      const minimumCleanupAt = validationResult?.evaluatedAt ?? recovery.observedAt;
      if (cleanupResult.worktreeId !== worktreeId || cleanupResult.observedAt < minimumCleanupAt || cleanupResult.observedAt > observedNow) cleanupResult = failedCleanup(worktreeId);
      const terminalInput = internalCommand(input, "reconciled", snapshot.aggregateVersion, snapshot.updatedAt, recovery.recoveryDigest);
      const transition = await options.persistence.transact(async (tx) => {
        const current = await load(tx, input.runId);
        if (current === null) throw new IntegrationError("NOT_FOUND", "Integration run does not exist.");
        if (current.snapshot.aggregateVersion !== snapshot.aggregateVersion || current.snapshot.status !== "reconciling") return current.snapshot;
        assertPortBindings(current.snapshot);
        const next = reconcileIntegrationRun(current.snapshot, terminalInput, recovery, validationResult, cleanupResult, evidenceFailureCode);
        await persistTransition(tx, current.persistenceVersion, next);
        return next.snapshot;
      });
      observe("reconcile", transition.status === "completed" ? "succeeded" : "failed", transition, transition.lastFailureCode);
      return transition;
    },

    async cancel(value: unknown): Promise<IntegrationRunSnapshot> {
      const input = parseIntegrationCommandInput(value, "cancel");
      const outcome = await options.persistence.transact(async (tx) => {
        const current = await duplicateOrLoaded(tx, input, "cancel");
        if (current.duplicate) return Object.freeze({ snapshot: current.loaded.snapshot, changed: false });
        assertCommandNotFromFuture(input);
        const transition = cancelIntegrationRun(current.loaded.snapshot, input);
        await persistTransition(tx, current.loaded.persistenceVersion, transition);
        return Object.freeze({ snapshot: transition.snapshot, changed: true });
      });
      observe("cancel", outcome.changed ? "succeeded" : "duplicate", outcome.snapshot, null);
      return outcome.snapshot;
    },

    async get(runIdValue: string): Promise<IntegrationRunSnapshot | null> {
      const runId = parseIntegrationId(runIdValue, "runId");
      return (await options.persistence.transact((tx) => load(tx, runId)))?.snapshot ?? null;
    },

    async history(runIdValue: string): Promise<readonly IntegrationEvent[]> {
      const runId = parseIntegrationId(runIdValue, "runId");
      const loaded = await options.persistence.transact((tx) => load(tx, runId));
      if (loaded === null) throw new IntegrationError("NOT_FOUND", "Integration run does not exist.");
      return loaded.history;
    },
  };
  const finiteService: ProductionDisabledIntegrationService = Object.freeze({
    productionEnabled: INTEGRATION_PRODUCTION_ENABLED,
    accept: async (value: unknown) => await service.accept(value).catch((error: unknown) => { throw finitePublicError(error); }),
    claim: async (value: unknown) => await service.claim(value).catch((error: unknown) => { throw finitePublicError(error); }),
    prepare: async (value: unknown) => await service.prepare(value).catch((error: unknown) => { throw finitePublicError(error); }),
    execute: async (value: unknown) => await service.execute(value).catch((error: unknown) => { throw finitePublicError(error); }),
    reconcile: async (value: unknown) => await service.reconcile(value).catch((error: unknown) => { throw finitePublicError(error); }),
    cancel: async (value: unknown) => await service.cancel(value).catch((error: unknown) => { throw finitePublicError(error); }),
    get: async (runId: string) => await service.get(runId).catch((error: unknown) => { throw finitePublicError(error); }),
    history: async (runId: string) => await service.history(runId).catch((error: unknown) => { throw finitePublicError(error); }),
  });
  return finiteService;
}

export function createProductionDisabledIntegrationService(
  options: Omit<CreateIntegrationServiceOptions, "effectsEnabledForTesting">,
): ProductionDisabledIntegrationService {
  return createIntegrationService({ ...options, effectsEnabledForTesting: false });
}

export const integrationStoreTesting = Object.freeze({ eventFromRecord, listEvents, publicCommandMatches, internalCommand });
