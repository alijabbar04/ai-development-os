import { toCanonicalJson, validation } from "@ai-dev-os/domain";
import {
  INTEGRATION_EVENT_TYPES,
  INTEGRATION_PRODUCTION_ENABLED,
  INTEGRATION_SCHEMA_VERSION,
  INTEGRATION_STATUSES,
  type IntegrationAuthorityConfiguration,
  type IntegrationCleanupResult,
  type IntegrationEffectIntent,
  type IntegrationEvent,
  type IntegrationEventCommand,
  type IntegrationEventType,
  type IntegrationLease,
  type IntegrationPreflightResult,
  type IntegrationReceipt,
  type IntegrationRecoveryState,
  type IntegrationRequest,
  type IntegrationRunSnapshot,
  type IntegrationTerminalResult,
  type IntegrationValidationResult,
} from "./contracts.js";
import { IntegrationError } from "./errors.js";
import {
  INTEGRATION_LIMITS,
  assertIntegrationInputBudget,
  authorizeIntegrationRequest,
  createIntegrationRequest,
  integrationDigest,
  parseIntegrationAuthorityConfiguration,
  parseIntegrationCleanupResult,
  parseIntegrationCode,
  parseIntegrationDigest,
  parseIntegrationEffectIntent,
  parseIntegrationId,
  parseIntegrationLease,
  parseIntegrationPreflightResult,
  parseIntegrationReceipt,
  parseIntegrationRecoveryState,
  parseIntegrationTerminalResult,
  parseIntegrationValidationResult,
  stableIntegrationId,
} from "./schema.js";

const {
  ensureArray,
  ensureExactKeys: ensureDomainExactKeys,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
  ensureTimestamp,
} = validation;

function ensureExactKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[], _path: string): void {
  try {
    ensureDomainExactKeys(record, keys, "integration-state");
  } catch {
    throw new IntegrationError("INVALID_INPUT", "Integration state contains unsupported or missing fields.");
  }
}

export interface IntegrationTransition {
  readonly snapshot: IntegrationRunSnapshot;
  readonly event: IntegrationEvent;
}

export interface ParsedIntegrationCommandInput {
  readonly runId: string;
  readonly commandId: string;
  readonly expectedVersion: number;
  readonly owner: string | null;
  readonly leaseId: string | null;
  readonly fencingToken: number | null;
  readonly leaseExpiresAt: string | null;
  readonly reasonCode: string | null;
  readonly occurredAt: string;
}

export function parseIntegrationCommandInput(
  value: unknown,
  kind: "claim" | "prepare" | "execute" | "reconcile" | "cancel",
): ParsedIntegrationCommandInput {
  assertIntegrationInputBudget(value);
  const record = ensureRecord(value, "command");
  const common = ["runId", "commandId", "expectedVersion", "owner", "leaseId", "fencingToken", "leaseExpiresAt", "reasonCode", "occurredAt"] as const;
  ensureExactKeys(record, common, "command");
  const owner = record["owner"] === null ? null : parseIntegrationId(record["owner"], "command.owner");
  const leaseId = record["leaseId"] === null ? null : parseIntegrationId(record["leaseId"], "command.leaseId");
  const fencingToken = record["fencingToken"] === null ? null : ensureSafeInteger(record["fencingToken"], "command.fencingToken", 1, Number.MAX_SAFE_INTEGER);
  const leaseExpiresAt = record["leaseExpiresAt"] === null ? null : ensureTimestamp(record["leaseExpiresAt"], "command.leaseExpiresAt");
  const reasonCode = record["reasonCode"] === null ? null : parseIntegrationCode(record["reasonCode"], "command.reasonCode");
  if (kind === "claim") {
    if (owner === null || leaseId === null || leaseExpiresAt === null || fencingToken !== null || reasonCode !== null) {
      throw new IntegrationError("INVALID_INPUT", "Claim command fields are inconsistent.");
    }
  } else if (kind === "cancel") {
    if (owner !== null || leaseId !== null || fencingToken !== null || leaseExpiresAt !== null || reasonCode === null) {
      throw new IntegrationError("INVALID_INPUT", "Cancellation command fields are inconsistent.");
    }
  } else if (owner === null || leaseId === null || fencingToken === null || leaseExpiresAt !== null || reasonCode !== null) {
    throw new IntegrationError("INVALID_INPUT", "Fenced integration command fields are inconsistent.");
  }
  const parsed = Object.freeze({
    runId: parseIntegrationId(record["runId"], "command.runId"),
    commandId: parseIntegrationId(record["commandId"], "command.commandId"),
    expectedVersion: ensureSafeInteger(record["expectedVersion"], "command.expectedVersion", 1, Number.MAX_SAFE_INTEGER),
    owner,
    leaseId,
    fencingToken,
    leaseExpiresAt,
    reasonCode,
    occurredAt: ensureTimestamp(record["occurredAt"], "command.occurredAt"),
  });
  if (parsed.commandId.startsWith("integration-internal:")) throw new IntegrationError("INVALID_INPUT", "Public commands cannot use the internal integration namespace.");
  return parsed;
}

function eventCommand(input: Omit<IntegrationEventCommand, "commandFingerprint">): IntegrationEventCommand {
  return Object.freeze({ ...input, commandFingerprint: integrationDigest(input) });
}

function eventFor(
  previous: IntegrationRunSnapshot | null,
  snapshot: IntegrationRunSnapshot,
  type: IntegrationEventType,
  occurredAt: string,
  command: IntegrationEventCommand,
): IntegrationEvent {
  assertIntegrationInputBudget(snapshot);
  const beforeDigest = previous === null ? null : integrationDigest(previous);
  const afterDigest = integrationDigest(snapshot);
  const event = Object.freeze({
    schemaVersion: INTEGRATION_SCHEMA_VERSION,
    eventId: stableIntegrationId("integration-event", snapshot.runId, String(snapshot.eventSequence), type, command.commandFingerprint, afterDigest),
    runId: snapshot.runId,
    sequence: snapshot.eventSequence,
    aggregateVersion: snapshot.aggregateVersion,
    type,
    occurredAt,
    beforeDigest,
    afterDigest,
    command,
    snapshot,
  });
  assertIntegrationInputBudget(event);
  return event;
}

function nextSnapshot(
  previous: IntegrationRunSnapshot,
  occurredAt: string,
  changes: Partial<Omit<IntegrationRunSnapshot, "schemaVersion" | "productionEnabled" | "runId" | "aggregateVersion" | "eventSequence" | "request" | "authorityConfiguration" | "createdAt" | "updatedAt">>,
): IntegrationRunSnapshot {
  if (occurredAt < previous.updatedAt) throw new IntegrationError("INVALID_INPUT", "Integration time cannot move backwards.");
  return Object.freeze({
    ...previous,
    ...changes,
    aggregateVersion: previous.aggregateVersion + 1,
    eventSequence: previous.eventSequence + 1,
    updatedAt: occurredAt,
  });
}

function assertMutable(previous: IntegrationRunSnapshot, expectedVersion: number, statuses: readonly IntegrationRunSnapshot["status"][]): void {
  if (previous.aggregateVersion !== expectedVersion) throw new IntegrationError("CONFLICT", "Integration version does not match the expected version.", { expectedVersion, actualVersion: previous.aggregateVersion });
  if (!statuses.includes(previous.status)) throw new IntegrationError("INVALID_TRANSITION", "Integration status does not permit this transition.", { status: previous.status });
}

function assertFence(previous: IntegrationRunSnapshot, command: ParsedIntegrationCommandInput, allowExpired = false): IntegrationLease {
  if (command.runId !== previous.runId) {
    throw new IntegrationError("INVALID_INPUT", "Integration command does not target the exact run snapshot.");
  }
  const lease = previous.lease;
  if (lease === null || command.owner !== lease.owner || command.leaseId !== lease.leaseId || command.fencingToken !== lease.fencingToken) {
    throw new IntegrationError("STALE_FENCE", "Integration ownership or fencing token is stale.");
  }
  if (command.occurredAt < previous.updatedAt || command.occurredAt < lease.acquiredAt) {
    throw new IntegrationError("INVALID_INPUT", "Integration command predates the durable state or active lease.");
  }
  if (!allowExpired && command.occurredAt >= lease.expiresAt) throw new IntegrationError("LEASE_CONFLICT", "Integration lease expired before the command.");
  return lease;
}

function exactPreflight(request: IntegrationRequest, preflight: IntegrationPreflightResult): boolean {
  return preflight.requestDigest === request.requestDigest && preflight.repositoryId === request.repository.repositoryId &&
    preflight.targetRef === request.repository.targetRef && preflight.targetCommit === request.repository.expectedTargetCommit &&
    preflight.targetTree === request.repository.expectedTargetTree && preflight.sourceCommit === request.repository.sourceCommit &&
    preflight.sourceTree === request.repository.sourceTree && preflight.clean &&
    preflight.fileCount <= request.bounds.maximumFiles && preflight.totalBytes <= request.bounds.maximumBytes &&
    preflight.conflicts.length <= request.bounds.maximumConflicts &&
    toCanonicalJson(preflight.changedPaths) === toCanonicalJson(request.allowedPaths) &&
    preflight.preflightId === stableIntegrationId("integration-preflight", request.runId, request.requestDigest, preflight.checkedAt) &&
    preflight.checkedAt >= request.createdAt && preflight.checkedAt <= request.deadline;
}

function resolutionMismatch(request: IntegrationRequest, preflight: IntegrationPreflightResult): boolean {
  const proposal = request.resolutionProposal;
  if (preflight.conflicts.length === 0) return proposal !== null;
  return proposal === null || preflight.conflicts.some((item) => item.kind !== "textual") ||
    toCanonicalJson(proposal.conflictIds) !== toCanonicalJson(preflight.conflicts.map((item) => item.conflictId));
}

export function exactIntegrationValidation(
  request: IntegrationRequest,
  result: IntegrationValidationResult,
  phase: IntegrationValidationResult["phase"],
  headCommit: string,
  treeId: string,
  enforceRequestDeadline: boolean,
): boolean {
  return result.resultId === stableIntegrationId("validation-result", request.runId, phase, result.evaluatedAt) &&
    result.phase === phase && result.planId === request.validationPlan.planId &&
    result.validatorId === request.validationPlan.validatorId && result.validatorSchemaVersion === request.validationPlan.validatorSchemaVersion &&
    result.configurationDigest === request.validationPlan.configurationDigest && result.headCommit === headCommit && result.treeId === treeId &&
    result.thresholdDigest === request.validationPlan.thresholdDigest && result.coverageDigest === request.admission.requirementCoverageDigest &&
    result.conflicts.length <= request.bounds.maximumConflicts &&
    toCanonicalJson(result.executedCommandIds) === toCanonicalJson(request.validationPlan.commandIds) &&
    toCanonicalJson(result.evaluatedCriterionIds) === toCanonicalJson(request.validationPlan.requiredCriterionIds) &&
    result.evaluatedAt >= request.createdAt && (!enforceRequestDeadline || result.evaluatedAt <= request.deadline);
}

function exactRecoveryProjection(
  request: IntegrationRequest,
  intent: IntegrationEffectIntent,
  recovery: IntegrationRecoveryState,
  publishedReceiptExists = false,
): boolean {
  const revisionLength = request.repository.objectFormat === "sha1" ? 40 : 64;
  const identityPairIsValid = (recovery.observedTargetCommit === null) === (recovery.observedTargetTree === null) &&
    [recovery.observedTargetCommit, recovery.observedTargetTree].every((identity) => identity === null || identity.length === revisionLength);
  if (!identityPairIsValid) return false;
  const unchangedTarget = recovery.observedTargetCommit === request.repository.expectedTargetCommit && recovery.observedTargetTree === request.repository.expectedTargetTree;
  const publishedTarget = recovery.observedTargetCommit === request.repository.expectedIntegratedCommit && recovery.observedTargetTree === request.repository.expectedIntegratedTree;
  return recovery.intentDigest === intent.intentDigest && recovery.observedAt >= intent.createdAt &&
    (recovery.state === "ref-published" ? publishedTarget && recovery.effectGuardState === "absent" :
      ["no-effect", "prepared", "commit-created"].includes(recovery.state) ? unchangedTarget && recovery.effectGuardState === "revoked" :
        publishedReceiptExists ? !publishedTarget : !publishedTarget && (!unchangedTarget || recovery.effectGuardState === "absent"));
}

export function createIntegrationRun(value: unknown, authorityValue: unknown): IntegrationTransition {
  const request = createIntegrationRequest(value);
  const authorityConfiguration = parseIntegrationAuthorityConfiguration(authorityValue);
  authorizeIntegrationRequest(request, authorityConfiguration);
  const snapshot: IntegrationRunSnapshot = Object.freeze({
    schemaVersion: INTEGRATION_SCHEMA_VERSION,
    productionEnabled: INTEGRATION_PRODUCTION_ENABLED,
    runId: request.runId,
    aggregateVersion: 1,
    eventSequence: 1,
    status: "pending",
    attemptsUsed: 0,
    retriesScheduled: 0,
    recoveryAttempts: 0,
    nextFencingToken: 1,
    request,
    authorityConfiguration,
    lease: null,
    preflight: null,
    preValidation: null,
    intent: null,
    receipt: null,
    postValidation: null,
    recovery: null,
    terminal: null,
    lastFailureCode: null,
    createdAt: request.createdAt,
    updatedAt: request.createdAt,
  });
  const command = eventCommand({
    commandId: request.idempotencyKey,
    submittedAt: request.createdAt,
    expectedVersion: null,
    owner: null,
    leaseId: null,
    fencingToken: null,
    leaseExpiresAt: null,
    reasonCode: null,
    evidenceDigest: request.requestDigest,
  });
  return Object.freeze({ snapshot, event: eventFor(null, snapshot, "integration.accepted", request.createdAt, command) });
}

export function claimIntegrationRun(value: unknown, input: ParsedIntegrationCommandInput): IntegrationTransition {
  const previous = parseIntegrationRunSnapshot(value);
  assertMutable(previous, input.expectedVersion, ["pending", "leased", "prepared"]);
  if (input.runId !== previous.runId || input.leaseExpiresAt === null || input.owner === null || input.leaseId === null) throw new IntegrationError("INVALID_INPUT", "Claim identity is inconsistent.");
  if (["leased", "prepared"].includes(previous.status) && previous.lease !== null && input.occurredAt < previous.lease.expiresAt) throw new IntegrationError("LEASE_CONFLICT", "Another owner holds the active integration lease.");
  if (input.leaseExpiresAt <= input.occurredAt || input.leaseExpiresAt > previous.request.deadline) throw new IntegrationError("INVALID_INPUT", "Lease expiry is outside the request window.");
  if (previous.attemptsUsed >= previous.request.retryPolicy.maximumAttempts) throw new IntegrationError("INVALID_TRANSITION", "Integration retry budget is exhausted.");
  const lease: IntegrationLease = Object.freeze({
    leaseId: input.leaseId,
    owner: input.owner,
    fencingToken: previous.nextFencingToken,
    acquiredAt: input.occurredAt,
    expiresAt: input.leaseExpiresAt,
  });
  const snapshot = nextSnapshot(previous, input.occurredAt, {
    status: "leased",
    attemptsUsed: previous.attemptsUsed + 1,
    retriesScheduled: previous.retriesScheduled + (previous.status === "prepared" ? 1 : 0),
    nextFencingToken: previous.nextFencingToken + 1,
    lease,
    preflight: null,
    preValidation: null,
    intent: null,
    lastFailureCode: null,
  });
  const command = eventCommand({
    commandId: input.commandId,
    submittedAt: input.occurredAt,
    expectedVersion: input.expectedVersion,
    owner: input.owner,
    leaseId: input.leaseId,
    fencingToken: lease.fencingToken,
    leaseExpiresAt: input.leaseExpiresAt,
    reasonCode: null,
    evidenceDigest: null,
  });
  return Object.freeze({ snapshot, event: eventFor(previous, snapshot, "integration.leased", input.occurredAt, command) });
}

export function prepareIntegrationRun(
  value: unknown,
  input: ParsedIntegrationCommandInput,
  preflightValue: unknown,
  validationValue: unknown,
): IntegrationTransition {
  const previous = parseIntegrationRunSnapshot(value);
  assertMutable(previous, input.expectedVersion, ["leased"]);
  const lease = assertFence(previous, input);
  const preflight = parseIntegrationPreflightResult(preflightValue);
  const validation = parseIntegrationValidationResult(validationValue);
  const request = previous.request;
  if (!exactPreflight(request, preflight)) throw new IntegrationError("TARGET_DRIFT", "Preflight does not bind the exact clean repository, revisions, scope, bounds, identity, and request window.");
  const unresolvedConflicts = resolutionMismatch(request, preflight);
  const minimumEvidenceAt = [previous.updatedAt, input.occurredAt].sort().at(-1)!;
  if (preflight.checkedAt < minimumEvidenceAt || validation.evaluatedAt < preflight.checkedAt) {
    throw new IntegrationError("INVALID_INPUT", "Preparation evidence predates the durable state, submitted command, or preceding boundary.");
  }
  const transitionAt = [input.occurredAt, preflight.checkedAt, validation.evaluatedAt].sort().at(-1)!;
  if (transitionAt >= lease.expiresAt || transitionAt >= request.deadline) throw new IntegrationError("LEASE_CONFLICT", "Preparation evidence completed outside the active lease or request window.");
  if (!exactIntegrationValidation(request, validation, "pre-integration", request.repository.sourceCommit, request.repository.expectedIntegratedTree, true)) {
    throw new IntegrationError("VALIDATION_FAILED", "Pre-integration validation does not bind the exact reviewed validator, plan, criteria, thresholds, identity, revision, and request window.");
  }
  if (unresolvedConflicts || !validation.passed || validation.skippedCount !== 0) {
    const failureCode = unresolvedConflicts ? "unresolved-conflicts" : "pre-validation-failed";
    const terminal = terminalProjection("failed", null, validation.resultDigest, failureCode, null, transitionAt);
    const snapshot = nextSnapshot(previous, transitionAt, { status: "failed", preflight, preValidation: validation, terminal, lastFailureCode: failureCode, lease: null });
    const command = eventCommand({ commandId: input.commandId, submittedAt: input.occurredAt, expectedVersion: input.expectedVersion, owner: lease.owner, leaseId: lease.leaseId, fencingToken: lease.fencingToken, leaseExpiresAt: null, reasonCode: failureCode, evidenceDigest: terminal.terminalDigest });
    return Object.freeze({ snapshot, event: eventFor(previous, snapshot, "integration.failed", transitionAt, command) });
  }
  const intentProjection = {
    intentId: stableIntegrationId("integration-intent", request.runId, input.commandId, String(lease.fencingToken)),
    requestDigest: request.requestDigest,
    preflightDigest: preflight.preflightDigest,
    validationResultDigest: validation.resultDigest,
    resolutionAuthorizationDigest: request.resolutionAuthorization?.authorizationDigest ?? null,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    createdAt: transitionAt,
  };
  const intent: IntegrationEffectIntent = Object.freeze({ ...intentProjection, intentDigest: integrationDigest(intentProjection) });
  const snapshot = nextSnapshot(previous, transitionAt, { status: "prepared", preflight, preValidation: validation, intent });
  const command = eventCommand({ commandId: input.commandId, submittedAt: input.occurredAt, expectedVersion: input.expectedVersion, owner: lease.owner, leaseId: lease.leaseId, fencingToken: lease.fencingToken, leaseExpiresAt: null, reasonCode: null, evidenceDigest: intent.intentDigest });
  return Object.freeze({ snapshot, event: eventFor(previous, snapshot, "integration.prepared", transitionAt, command) });
}

export function startIntegrationEffect(value: unknown, input: ParsedIntegrationCommandInput, transitionAtValue: string = input.occurredAt): IntegrationTransition {
  const previous = parseIntegrationRunSnapshot(value);
  assertMutable(previous, input.expectedVersion, ["prepared"]);
  const lease = assertFence(previous, input);
  if (previous.intent === null) throw new IntegrationError("INVALID_TRANSITION", "Prepared integration intent is absent.");
  const transitionAt = ensureTimestamp(transitionAtValue, "effectStartAt");
  if (transitionAt < input.occurredAt || transitionAt < previous.updatedAt || transitionAt >= lease.expiresAt || transitionAt >= previous.request.deadline) throw new IntegrationError("INVALID_INPUT", "Effect start is outside the exact command, durable-state, lease, or request window.");
  const snapshot = nextSnapshot(previous, transitionAt, { status: "effect-uncertain" });
  const command = eventCommand({ commandId: input.commandId, submittedAt: input.occurredAt, expectedVersion: input.expectedVersion, owner: lease.owner, leaseId: lease.leaseId, fencingToken: lease.fencingToken, leaseExpiresAt: null, reasonCode: null, evidenceDigest: previous.intent.intentDigest });
  return Object.freeze({ snapshot, event: eventFor(previous, snapshot, "integration.effect-started", transitionAt, command) });
}

function assertReceipt(
  previous: IntegrationRunSnapshot,
  receipt: IntegrationReceipt,
  allowRecoveredTiming = false,
  minimumCommittedAt = previous.intent?.createdAt ?? previous.createdAt,
): void {
  const request = previous.request;
  if (previous.intent === null || receipt.intentDigest !== previous.intent.intentDigest || receipt.repositoryId !== request.repository.repositoryId ||
      receipt.targetRef !== request.repository.targetRef || receipt.previousTargetCommit !== request.repository.expectedTargetCommit ||
      receipt.integratedTree !== request.repository.expectedIntegratedTree || receipt.strategy !== request.strategy ||
      toCanonicalJson(receipt.changedPaths) !== toCanonicalJson(request.allowedPaths) ||
      receipt.receiptId !== stableIntegrationId("integration-receipt", previous.intent.intentDigest, receipt.integratedCommit) ||
      receipt.worktreeId !== stableIntegrationId("integration-worktree", previous.intent.intentId) ||
      receipt.artifactDigest !== request.candidateArtifact.artifactDigest ||
      receipt.committedAt < minimumCommittedAt ||
      (receipt.timingBasis === "observed" && receipt.committedAt > request.deadline) ||
      (receipt.timingBasis === "recovered-observation" && !allowRecoveredTiming)) {
    throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Integration receipt does not bind the exact prepared effect.");
  }
  if (request.strategy === "fast-forward") {
    if (receipt.integratedCommit !== request.repository.sourceCommit || receipt.parents.length !== 0) throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Fast-forward receipt created an unexpected commit.");
  } else if (receipt.integratedCommit !== request.repository.expectedIntegratedCommit || toCanonicalJson(receipt.parents) !== toCanonicalJson(request.repository.expectedParents)) {
    throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Merge receipt parent ordering differs from the request.");
  }
}

export function recordIntegrationReceipt(value: unknown, input: ParsedIntegrationCommandInput, receiptValue: unknown): IntegrationTransition {
  const previous = parseIntegrationRunSnapshot(value);
  assertMutable(previous, input.expectedVersion, ["effect-uncertain"]);
  const lease = assertFence(previous, input);
  const receipt = parseIntegrationReceipt(receiptValue);
  assertReceipt(previous, receipt, false, previous.updatedAt);
  if (input.commandId !== stableIntegrationId("integration-internal", previous.intent!.intentDigest, "receipt") || input.occurredAt !== [previous.updatedAt, receipt.committedAt].sort().at(-1)) {
    throw new IntegrationError("INVALID_INPUT", "Receipt persistence command is not the exact derived internal transition.");
  }
  const snapshot = nextSnapshot(previous, input.occurredAt, { status: "committed", receipt });
  const command = eventCommand({ commandId: input.commandId, submittedAt: input.occurredAt, expectedVersion: input.expectedVersion, owner: lease.owner, leaseId: lease.leaseId, fencingToken: lease.fencingToken, leaseExpiresAt: null, reasonCode: null, evidenceDigest: receipt.receiptDigest });
  return Object.freeze({ snapshot, event: eventFor(previous, snapshot, "integration.receipt-recorded", input.occurredAt, command) });
}

export function startIntegrationRecovery(
  value: unknown,
  input: ParsedIntegrationCommandInput,
  transitionAtValue: string = input.occurredAt,
): IntegrationTransition {
  const previous = parseIntegrationRunSnapshot(value);
  assertMutable(previous, input.expectedVersion, ["effect-uncertain", "committed", "reconciling"]);
  const lease = assertFence(previous, input, true);
  if (previous.intent === null || previous.recovery !== null || previous.terminal !== null) {
    /* v8 ignore next -- parsed nonterminal recoverable snapshots already require exact intent and null recovery/terminal projections. */
    throw new IntegrationError("INVALID_TRANSITION", "Only a nonterminal started effect can begin recovery.");
  }
  if (previous.recoveryAttempts >= previous.request.retryPolicy.maximumAttempts) {
    throw new IntegrationError("LIMIT_EXCEEDED", "Integration recovery attempt bound is exhausted.");
  }
  const transitionAt = ensureTimestamp(transitionAtValue, "recoveryStartAt");
  if (transitionAt < input.occurredAt || transitionAt < previous.updatedAt) {
    throw new IntegrationError("INVALID_INPUT", "Recovery start cannot precede its submitted command or durable state.");
  }
  const snapshot = nextSnapshot(previous, transitionAt, {
    status: "reconciling",
    recoveryAttempts: previous.recoveryAttempts + 1,
  });
  const command = eventCommand({
    commandId: input.commandId,
    submittedAt: input.occurredAt,
    expectedVersion: input.expectedVersion,
    owner: lease.owner,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    leaseExpiresAt: null,
    reasonCode: null,
    evidenceDigest: previous.intent.intentDigest,
  });
  return Object.freeze({ snapshot, event: eventFor(previous, snapshot, "integration.recovery-started", transitionAt, command) });
}

export function exhaustIntegrationRecovery(
  value: unknown,
  input: ParsedIntegrationCommandInput,
  transitionAtValue: string = input.occurredAt,
): IntegrationTransition {
  const previous = parseIntegrationRunSnapshot(value);
  assertMutable(previous, input.expectedVersion, ["reconciling"]);
  if (input.runId !== previous.runId) throw new IntegrationError("INVALID_INPUT", "Integration command does not target the exact run snapshot.");
  const lease = previous.lease;
  if (lease === null || input.owner !== lease.owner || input.leaseId !== lease.leaseId || input.fencingToken !== lease.fencingToken) {
    throw new IntegrationError("STALE_FENCE", "Integration ownership or fencing token is stale.");
  }
  const transitionAt = ensureTimestamp(transitionAtValue, "recoveryExhaustedAt");
  if (input.occurredAt < lease.acquiredAt || input.occurredAt > transitionAt || transitionAt < previous.updatedAt) {
    throw new IntegrationError("INVALID_INPUT", "Recovery exhaustion time does not bind the submitted command and durable state.");
  }
  if (previous.intent === null || previous.recoveryAttempts !== previous.request.retryPolicy.maximumAttempts || previous.recovery !== null || previous.terminal !== null) {
    throw new IntegrationError("INVALID_TRANSITION", "Only the final unresolved recovery boundary can require manual reconciliation.");
  }
  if (input.commandId.startsWith("integration-internal:")) throw new IntegrationError("INVALID_INPUT", "Recovery exhaustion must retain the exact public reconciliation command identity.");
  const failureCode = "recovery-boundary-exhausted";
  const snapshot = nextSnapshot(previous, transitionAt, {
    status: "manual-reconciliation-required",
    lease: null,
    lastFailureCode: failureCode,
  });
  const command = eventCommand({
    commandId: input.commandId,
    submittedAt: input.occurredAt,
    expectedVersion: input.expectedVersion,
    owner: lease.owner,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    leaseExpiresAt: null,
    reasonCode: failureCode,
    evidenceDigest: previous.intent.intentDigest,
  });
  return Object.freeze({ snapshot, event: eventFor(previous, snapshot, "integration.recovery-exhausted", transitionAt, command) });
}

function terminalProjection(
  outcome: IntegrationTerminalResult["outcome"],
  receiptDigest: string | null,
  validationResultDigest: string | null,
  failureCode: string | null,
  cleanup: IntegrationCleanupResult | null,
  completedAt: string,
): IntegrationTerminalResult {
  const projection = { outcome, receiptDigest, validationResultDigest, failureCode, cleanup, completedAt };
  return Object.freeze({ ...projection, terminalDigest: integrationDigest(projection) });
}

export function completeIntegrationRun(
  value: unknown,
  input: ParsedIntegrationCommandInput,
  validationValue: unknown,
  cleanupValue: unknown,
): IntegrationTransition {
  const previous = parseIntegrationRunSnapshot(value);
  assertMutable(previous, input.expectedVersion, ["committed"]);
  const lease = assertFence(previous, input);
  if (previous.receipt === null) throw new IntegrationError("INVALID_TRANSITION", "Committed integration receipt is absent.");
  const validation = parseIntegrationValidationResult(validationValue);
  const cleanup = parseIntegrationCleanupResult(cleanupValue);
  const receipt = previous.receipt;
  const expectedCompletedAt = [previous.updatedAt, validation.evaluatedAt, cleanup.observedAt].sort().at(-1)!;
  if (validation.evaluatedAt < previous.updatedAt || cleanup.observedAt < validation.evaluatedAt) {
    throw new IntegrationError("INVALID_INPUT", "Terminal validation or cleanup evidence predates the committed state or preceding boundary.");
  }
  if (input.commandId !== stableIntegrationId("integration-internal", receipt.receiptDigest, "terminal") || input.occurredAt !== expectedCompletedAt) {
    throw new IntegrationError("INVALID_INPUT", "Terminal validation command is not the exact derived internal transition.");
  }
  if (!exactIntegrationValidation(previous.request, validation, "post-integration", receipt.integratedCommit, receipt.integratedTree, true)) {
    throw new IntegrationError("VALIDATION_FAILED", "Post-integration validation evidence does not bind the exact request, route, revision, coverage, and plan.");
  }
  if (cleanup.worktreeId !== receipt.worktreeId || cleanup.observedAt < previous.updatedAt || cleanup.observedAt > previous.request.deadline) {
    throw new IntegrationError("INVALID_INPUT", "Cleanup evidence does not bind the exact committed worktree and time window.");
  }
  const exactValidationResult = validation.passed && validation.skippedCount === 0;
  const cleanupAcceptable = cleanup.cleaned || cleanup.preservedEvidence;
  const outcome = exactValidationResult && cleanupAcceptable ? "completed" : "failed";
  const failureCode = exactValidationResult ? (cleanupAcceptable ? null : "cleanup-evidence-lost") : "post-validation-failed";
  const terminal = terminalProjection(outcome, receipt.receiptDigest, validation.resultDigest, failureCode, cleanup, input.occurredAt);
  const snapshot = nextSnapshot(previous, input.occurredAt, { status: outcome, postValidation: validation, terminal, lastFailureCode: failureCode, lease: null });
  const command = eventCommand({ commandId: input.commandId, submittedAt: input.occurredAt, expectedVersion: input.expectedVersion, owner: lease.owner, leaseId: lease.leaseId, fencingToken: lease.fencingToken, leaseExpiresAt: null, reasonCode: failureCode, evidenceDigest: terminal.terminalDigest });
  return Object.freeze({ snapshot, event: eventFor(previous, snapshot, outcome === "completed" ? "integration.completed" : "integration.failed", input.occurredAt, command) });
}

export function failIntegrationRun(
  value: unknown,
  input: ParsedIntegrationCommandInput,
  failureCode: string,
  cleanupValue: unknown | null = null,
  transitionAtValue: string = input.occurredAt,
): IntegrationTransition {
  const previous = parseIntegrationRunSnapshot(value);
  assertMutable(previous, input.expectedVersion, ["leased", "prepared", "committed"]);
  const lease = assertFence(previous, input);
  const transitionAt = ensureTimestamp(transitionAtValue, "failureTransitionAt");
  if (transitionAt < input.occurredAt || transitionAt < previous.updatedAt) throw new IntegrationError("INVALID_INPUT", "Failure transition cannot precede its submitted command or durable state.");
  const parsedFailure = parseIntegrationCode(failureCode, "failureCode");
  const cleanup = cleanupValue === null ? null : parseIntegrationCleanupResult(cleanupValue, "failureCleanup");
  if (previous.status !== "committed" && cleanup !== null) throw new IntegrationError("INVALID_INPUT", "Pre-effect failure cannot attach integration cleanup evidence.");
  if (previous.status === "committed") {
    if (previous.receipt === null || cleanup === null || cleanup.worktreeId !== previous.receipt.worktreeId || cleanup.observedAt < previous.updatedAt) {
      throw new IntegrationError("INVALID_INPUT", "Committed failure must retain exact worktree cleanup evidence.");
    }
    const expectedFailureAt = [previous.updatedAt, cleanup.observedAt].sort().at(-1)!;
    if (input.commandId !== stableIntegrationId("integration-internal", previous.receipt.receiptDigest, "terminal-failure") || transitionAt !== expectedFailureAt || input.occurredAt !== transitionAt) {
      throw new IntegrationError("INVALID_INPUT", "Committed failure command is not the exact derived internal transition.");
    }
  }
  if (previous.status === "leased" && transitionAt < previous.request.deadline && previous.request.retryPolicy.retryableFailureCodes.includes(parsedFailure) && previous.attemptsUsed < previous.request.retryPolicy.maximumAttempts) {
    const retriesScheduled = previous.retriesScheduled + 1;
    const retryDigest = integrationDigest({ runId: previous.runId, failureCode: parsedFailure, attemptsUsed: previous.attemptsUsed, retriesScheduled });
    const snapshot = nextSnapshot(previous, transitionAt, { status: "pending", retriesScheduled, lease: null, lastFailureCode: parsedFailure });
    const retryCommand = eventCommand({ commandId: input.commandId, submittedAt: input.occurredAt, expectedVersion: input.expectedVersion, owner: lease.owner, leaseId: lease.leaseId, fencingToken: lease.fencingToken, leaseExpiresAt: null, reasonCode: parsedFailure, evidenceDigest: retryDigest });
    return Object.freeze({ snapshot, event: eventFor(previous, snapshot, "integration.retry-scheduled", transitionAt, retryCommand) });
  }
  const terminal = terminalProjection("failed", previous.receipt?.receiptDigest ?? null, previous.postValidation?.resultDigest ?? null, parsedFailure, cleanup, transitionAt);
  const snapshot = nextSnapshot(previous, transitionAt, { status: "failed", terminal, lastFailureCode: parsedFailure, lease: null });
  const exactCommand = eventCommand({ commandId: input.commandId, submittedAt: input.occurredAt, expectedVersion: input.expectedVersion, owner: lease.owner, leaseId: lease.leaseId, fencingToken: lease.fencingToken, leaseExpiresAt: null, reasonCode: parsedFailure, evidenceDigest: terminal.terminalDigest });
  return Object.freeze({ snapshot, event: eventFor(previous, snapshot, "integration.failed", transitionAt, exactCommand) });
}

export function reconcileIntegrationRun(
  value: unknown,
  input: ParsedIntegrationCommandInput,
  recoveryValue: unknown,
  validationValue: unknown | null,
  cleanupValue: unknown | null,
  evidenceFailureCodeValue: string | null = null,
): IntegrationTransition {
  const previous = parseIntegrationRunSnapshot(value);
  assertMutable(previous, input.expectedVersion, ["reconciling"]);
  const lease = assertFence(previous, input, true);
  if (previous.intent === null || previous.recoveryAttempts === 0) throw new IntegrationError("INVALID_TRANSITION", "Reconciliation requires an exact durable recovery-start marker.");
  const recovery = parseIntegrationRecoveryState(recoveryValue);
  if (input.commandId !== stableIntegrationId("integration-internal", recovery.recoveryDigest, "reconciled") || input.occurredAt !== previous.updatedAt) {
    throw new IntegrationError("INVALID_INPUT", "Reconciliation command is not the exact derived internal transition.");
  }
  const newlyReconstructedReceiptIsExact = previous.receipt !== null || recovery.state !== "ref-published" ||
    recovery.receipt !== null && recovery.receipt.timingBasis === "recovered-observation" && recovery.receipt.committedAt === recovery.observedAt;
  const recoveryPreservesPublishedReceipt = previous.receipt === null ||
    recovery.state === "ref-published" && toCanonicalJson(recovery.receipt) === toCanonicalJson(previous.receipt) ||
    recovery.state === "diverged" && recovery.receipt === null;
  if (!exactRecoveryProjection(previous.request, previous.intent, recovery, previous.receipt !== null) || !recoveryPreservesPublishedReceipt || !newlyReconstructedReceiptIsExact) {
    throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Recovery evidence does not describe the exact durable target and receipt state.");
  }
  let receipt: IntegrationReceipt | null = previous.receipt;
  let validation: IntegrationValidationResult | null = recovery.state === "ref-published" && validationValue !== null
    ? parseIntegrationValidationResult(validationValue)
    : null;
  let evidenceFailureCode = evidenceFailureCodeValue === null ? null : parseIntegrationCode(evidenceFailureCodeValue, "evidenceFailureCode");
  if (evidenceFailureCode !== null && !["post-validation-boundary-failed", "post-validation-invalid"].includes(evidenceFailureCode)) throw new IntegrationError("INVALID_INPUT", "Reconciliation evidence failure code is not an exact boundary classification.");
  if (recovery.state !== "ref-published" && validationValue !== null) throw new IntegrationError("INVALID_INPUT", "Non-published recovery cannot attach post-integration validation evidence.");
  const cleanup: IntegrationCleanupResult | null = cleanupValue === null ? null : parseIntegrationCleanupResult(cleanupValue);
  let outcome: "completed" | "failed" = "failed";
  let failureCode = `recovery-${recovery.state}`;
  const expectedWorktreeId = stableIntegrationId("integration-worktree", previous.intent.intentId);
  if (cleanup !== null && cleanup.worktreeId !== expectedWorktreeId) throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Recovery cleanup evidence belongs to a different integration worktree.");
  const minimumRecoveryAt = [previous.updatedAt, input.occurredAt].sort().at(-1)!;
  if (recovery.observedAt < minimumRecoveryAt || validation !== null && validation.evaluatedAt < recovery.observedAt || cleanup !== null && cleanup.observedAt < (validation?.evaluatedAt ?? recovery.observedAt)) {
    throw new IntegrationError("INVALID_INPUT", "Recovery, validation, or cleanup evidence predates the durable state, submitted command, or preceding boundary.");
  }
  if (recovery.state === "ref-published" && recovery.receipt !== null) {
    assertReceipt(previous, recovery.receipt, true, previous.intent.createdAt);
    // Keep the snapshot projection JSON-like: receipt and recovery.receipt are
    // equal values, but they must not be the same object reference because the
    // public structural budget rejects aliased object graphs.
    receipt = parseIntegrationReceipt(recovery.receipt);
    if (validation !== null && !exactIntegrationValidation(previous.request, validation, "post-integration", receipt.integratedCommit, receipt.integratedTree, false)) {
      validation = null;
      evidenceFailureCode = "post-validation-invalid";
    }
    if (validation !== null && cleanupValue !== null) {
      const valid = validation.passed && validation.skippedCount === 0;
      if (valid && cleanup !== null && cleanup.worktreeId === receipt.worktreeId && cleanup.observedAt >= previous.updatedAt && (cleanup.cleaned || cleanup.preservedEvidence)) {
        outcome = "completed";
        failureCode = "";
      } else if (!valid) failureCode = "post-validation-failed";
      else failureCode = "cleanup-evidence-lost";
    } else if (validation === null) failureCode = evidenceFailureCode ?? "recovery-validation-missing";
    else failureCode = "recovery-cleanup-missing";
  }
  const transitionAt = [input.occurredAt, recovery.observedAt, validation?.evaluatedAt ?? previous.updatedAt, cleanup?.observedAt ?? previous.updatedAt].sort().at(-1)!;
  const terminal = terminalProjection(outcome, receipt?.receiptDigest ?? null, validation?.resultDigest ?? null, outcome === "completed" ? null : failureCode, cleanup, transitionAt);
  const snapshot = nextSnapshot(previous, transitionAt, { status: outcome, recovery, receipt, postValidation: validation, terminal, lastFailureCode: outcome === "completed" ? null : failureCode, lease: null });
  const command = eventCommand({ commandId: input.commandId, submittedAt: input.occurredAt, expectedVersion: input.expectedVersion, owner: lease.owner, leaseId: lease.leaseId, fencingToken: lease.fencingToken, leaseExpiresAt: null, reasonCode: outcome === "completed" ? null : failureCode, evidenceDigest: recovery.recoveryDigest });
  return Object.freeze({ snapshot, event: eventFor(previous, snapshot, "integration.reconciled", transitionAt, command) });
}

export function cancelIntegrationRun(value: unknown, input: ParsedIntegrationCommandInput): IntegrationTransition {
  const previous = parseIntegrationRunSnapshot(value);
  assertMutable(previous, input.expectedVersion, ["pending", "leased", "prepared"]);
  if (input.runId !== previous.runId || input.reasonCode === null) throw new IntegrationError("INVALID_INPUT", "Cancellation identity is inconsistent.");
  const terminal = terminalProjection("cancelled", null, null, input.reasonCode, null, input.occurredAt);
  const snapshot = nextSnapshot(previous, input.occurredAt, { status: "cancelled", lease: null, terminal, lastFailureCode: input.reasonCode });
  const command = eventCommand({ commandId: input.commandId, submittedAt: input.occurredAt, expectedVersion: input.expectedVersion, owner: null, leaseId: null, fencingToken: null, leaseExpiresAt: null, reasonCode: input.reasonCode, evidenceDigest: terminal.terminalDigest });
  return Object.freeze({ snapshot, event: eventFor(previous, snapshot, "integration.cancelled", input.occurredAt, command) });
}

export function parseIntegrationRunSnapshot(value: unknown): IntegrationRunSnapshot {
  assertIntegrationInputBudget(value);
  const record = ensureRecord(value, "snapshot");
  ensureExactKeys(record, ["schemaVersion", "productionEnabled", "runId", "aggregateVersion", "eventSequence", "status", "attemptsUsed", "retriesScheduled", "recoveryAttempts", "nextFencingToken", "request", "authorityConfiguration", "lease", "preflight", "preValidation", "intent", "receipt", "postValidation", "recovery", "terminal", "lastFailureCode", "createdAt", "updatedAt"], "snapshot");
  const request = createIntegrationRequest(record["request"]);
  const authorityConfiguration = parseIntegrationAuthorityConfiguration(record["authorityConfiguration"]);
  authorizeIntegrationRequest(request, authorityConfiguration);
  const snapshot: IntegrationRunSnapshot = Object.freeze({
    schemaVersion: (ensureSchemaVersion(record["schemaVersion"], "snapshot.schemaVersion", INTEGRATION_SCHEMA_VERSION), INTEGRATION_SCHEMA_VERSION),
    productionEnabled: (() => {
      if (validation.ensureBoolean(record["productionEnabled"], "snapshot.productionEnabled") !== INTEGRATION_PRODUCTION_ENABLED) throw new IntegrationError("INVALID_INPUT", "Integration production flag must remain disabled.");
      return INTEGRATION_PRODUCTION_ENABLED;
    })(),
    runId: parseIntegrationId(record["runId"], "snapshot.runId"),
    aggregateVersion: ensureSafeInteger(record["aggregateVersion"], "snapshot.aggregateVersion", 1, Number.MAX_SAFE_INTEGER),
    eventSequence: ensureSafeInteger(record["eventSequence"], "snapshot.eventSequence", 1, Number.MAX_SAFE_INTEGER),
    status: validation.ensureEnum(record["status"], "snapshot.status", INTEGRATION_STATUSES),
    attemptsUsed: ensureSafeInteger(record["attemptsUsed"], "snapshot.attemptsUsed", 0, request.retryPolicy.maximumAttempts),
    retriesScheduled: ensureSafeInteger(record["retriesScheduled"], "snapshot.retriesScheduled", 0, request.retryPolicy.maximumAttempts - 1),
    recoveryAttempts: ensureSafeInteger(record["recoveryAttempts"], "snapshot.recoveryAttempts", 0, request.retryPolicy.maximumAttempts),
    nextFencingToken: ensureSafeInteger(record["nextFencingToken"], "snapshot.nextFencingToken", 1, Number.MAX_SAFE_INTEGER),
    request,
    authorityConfiguration,
    lease: record["lease"] === null ? null : parseIntegrationLease(record["lease"], "snapshot.lease"),
    preflight: record["preflight"] === null ? null : parseIntegrationPreflightResult(record["preflight"], "snapshot.preflight"),
    preValidation: record["preValidation"] === null ? null : parseIntegrationValidationResult(record["preValidation"], "snapshot.preValidation"),
    intent: record["intent"] === null ? null : parseIntegrationEffectIntent(record["intent"], "snapshot.intent"),
    receipt: record["receipt"] === null ? null : parseIntegrationReceipt(record["receipt"], "snapshot.receipt"),
    postValidation: record["postValidation"] === null ? null : parseIntegrationValidationResult(record["postValidation"], "snapshot.postValidation"),
    recovery: record["recovery"] === null ? null : parseIntegrationRecoveryState(record["recovery"], "snapshot.recovery"),
    terminal: record["terminal"] === null ? null : parseIntegrationTerminalResult(record["terminal"], "snapshot.terminal"),
    lastFailureCode: record["lastFailureCode"] === null ? null : parseIntegrationCode(record["lastFailureCode"], "snapshot.lastFailureCode"),
    createdAt: ensureTimestamp(record["createdAt"], "snapshot.createdAt"),
    updatedAt: ensureTimestamp(record["updatedAt"], "snapshot.updatedAt"),
  });
  if (snapshot.runId !== request.runId || snapshot.createdAt !== request.createdAt || snapshot.updatedAt < snapshot.createdAt || snapshot.aggregateVersion !== snapshot.eventSequence || snapshot.nextFencingToken !== snapshot.attemptsUsed + 1 || snapshot.retriesScheduled > snapshot.attemptsUsed) throw new IntegrationError("INVALID_INPUT", "Integration snapshot identity, time, or counters are inconsistent.");
  const baseReachableVersion = 1 + snapshot.attemptsUsed + snapshot.retriesScheduled + snapshot.recoveryAttempts + (snapshot.intent === null ? 0 : 1) +
    (snapshot.receipt !== null && snapshot.recovery === null ? 1 : 0) +
    (snapshot.recovery === null && snapshot.terminal !== null ? 1 : 0) +
    (snapshot.recovery === null ? 0 : 1) +
    (snapshot.status === "manual-reconciliation-required" ? 1 : 0);
  const effectDefinitelyStarted = ["effect-uncertain", "committed", "reconciling", "manual-reconciliation-required", "completed"].includes(snapshot.status) || snapshot.receipt !== null || snapshot.recovery !== null;
  const reachableVersions = [baseReachableVersion + (effectDefinitelyStarted ? 1 : 0)];
  const exactReachableVersions = snapshot.recovery !== null && snapshot.receipt !== null
    ? [...reachableVersions, ...reachableVersions.map((item) => item + 1)]
    : reachableVersions;
  if (!exactReachableVersions.includes(snapshot.aggregateVersion)) throw new IntegrationError("INVALID_INPUT", "Integration snapshot version is not reachable through the command lifecycle.");
  const preflightRequired = ["prepared", "effect-uncertain", "committed", "reconciling", "manual-reconciliation-required", "completed"].includes(snapshot.status);
  const receiptRequired = ["committed", "completed"].includes(snapshot.status);
  const terminalRequired = ["completed", "failed", "cancelled"].includes(snapshot.status);
  const liveLeaseRequired = ["leased", "prepared", "effect-uncertain", "committed", "reconciling"].includes(snapshot.status);
  if (preflightRequired && (snapshot.preflight === null || snapshot.preValidation === null || snapshot.intent === null)) throw new IntegrationError("INVALID_INPUT", "Integration snapshot is missing prepared evidence.");
  if (receiptRequired && snapshot.receipt === null) throw new IntegrationError("INVALID_INPUT", "Integration receipt does not match status.");
  if (["pending", "leased", "prepared", "effect-uncertain", "cancelled"].includes(snapshot.status) && snapshot.receipt !== null) throw new IntegrationError("INVALID_INPUT", "Pre-receipt integration status contains a receipt.");
  if (snapshot.status === "reconciling" && (snapshot.recoveryAttempts === 0 || snapshot.recovery !== null || snapshot.terminal !== null)) throw new IntegrationError("INVALID_INPUT", "Recovery-in-progress snapshot is not an exact nonterminal attempt.");
  if (snapshot.status === "manual-reconciliation-required" && (snapshot.recoveryAttempts !== request.retryPolicy.maximumAttempts || snapshot.recovery !== null || snapshot.terminal !== null || snapshot.lastFailureCode !== "recovery-boundary-exhausted")) throw new IntegrationError("INVALID_INPUT", "Manual-reconciliation snapshot is not the exact exhausted recovery checkpoint.");
  if (snapshot.recoveryAttempts > 0 && snapshot.intent === null) throw new IntegrationError("INVALID_INPUT", "Recovery attempts require an exact started effect intent.");
  if (snapshot.recovery !== null && snapshot.recoveryAttempts === 0) throw new IntegrationError("INVALID_INPUT", "Recovery evidence requires a preceding durable recovery-start marker.");
  if (terminalRequired !== (snapshot.terminal !== null)) throw new IntegrationError("INVALID_INPUT", "Integration terminal evidence does not match status.");
  if (liveLeaseRequired !== (snapshot.lease !== null)) throw new IntegrationError("INVALID_INPUT", "Integration lease does not match the durable status.");
  if (snapshot.lease !== null && (snapshot.lease.acquiredAt < request.createdAt || snapshot.lease.expiresAt > request.deadline || snapshot.lease.fencingToken !== snapshot.attemptsUsed)) throw new IntegrationError("INVALID_INPUT", "Integration lease is outside the exact request attempt and time window.");
  if (["pending", "leased"].includes(snapshot.status) && (snapshot.preflight !== null || snapshot.intent !== null || snapshot.receipt !== null)) throw new IntegrationError("INVALID_INPUT", "Pre-effect integration snapshot contains impossible effect evidence.");
  if ((snapshot.preflight === null) !== (snapshot.preValidation === null)) throw new IntegrationError("INVALID_INPUT", "Integration preflight and validation evidence must be paired.");
  if (snapshot.preflight !== null && snapshot.preValidation !== null) {
    if (!exactPreflight(request, snapshot.preflight) || !exactIntegrationValidation(request, snapshot.preValidation, "pre-integration", request.repository.sourceCommit, request.repository.expectedIntegratedTree, true)) {
      throw new IntegrationError("INVALID_INPUT", "Persisted preparation evidence is not exact.");
    }
    const unresolved = resolutionMismatch(request, snapshot.preflight);
    const deterministicFailure = unresolved || !snapshot.preValidation.passed || snapshot.preValidation.skippedCount !== 0;
    if (snapshot.intent !== null && deterministicFailure) throw new IntegrationError("INVALID_INPUT", "Prepared intent cannot follow failed or unresolved deterministic evidence.");
    if (snapshot.intent === null && (snapshot.status !== "failed" || !deterministicFailure)) throw new IntegrationError("INVALID_INPUT", "Preparation evidence without an intent must be the exact deterministic failure outcome.");
  }
  if (snapshot.status === "completed" && (snapshot.postValidation === null || snapshot.terminal?.outcome !== "completed" || snapshot.lastFailureCode !== null)) throw new IntegrationError("INVALID_INPUT", "Completed integration evidence is inconsistent.");
  if (snapshot.status === "failed" && (snapshot.terminal?.outcome !== "failed" || snapshot.lastFailureCode === null)) throw new IntegrationError("INVALID_INPUT", "Failed integration evidence is inconsistent.");
  if (snapshot.status === "failed" && snapshot.receipt !== null && snapshot.recovery === null && snapshot.terminal?.cleanup == null) throw new IntegrationError("INVALID_INPUT", "Post-effect failure without recovery requires exact cleanup evidence.");
  if (snapshot.status === "cancelled" && snapshot.terminal?.outcome !== "cancelled") throw new IntegrationError("INVALID_INPUT", "Cancelled integration evidence is inconsistent.");
  if (snapshot.intent !== null && (snapshot.preflight === null || snapshot.preValidation === null || snapshot.intent.requestDigest !== request.requestDigest || snapshot.intent.preflightDigest !== snapshot.preflight.preflightDigest || snapshot.intent.validationResultDigest !== snapshot.preValidation.resultDigest || snapshot.intent.resolutionAuthorizationDigest !== (request.resolutionAuthorization?.authorizationDigest ?? null))) throw new IntegrationError("INVALID_INPUT", "Persisted effect intent is not exactly linked.");
  if (snapshot.intent !== null && snapshot.lease !== null && (snapshot.intent.leaseId !== snapshot.lease.leaseId || snapshot.intent.fencingToken !== snapshot.lease.fencingToken || snapshot.intent.createdAt < snapshot.lease.acquiredAt || snapshot.intent.createdAt >= snapshot.lease.expiresAt)) throw new IntegrationError("INVALID_INPUT", "Prepared intent does not bind the active lease and request window.");
  if (snapshot.receipt !== null) assertReceipt(snapshot, snapshot.receipt, snapshot.recovery !== null);
  if (snapshot.postValidation !== null && (snapshot.receipt === null || !exactIntegrationValidation(request, snapshot.postValidation, "post-integration", snapshot.receipt.integratedCommit, snapshot.receipt.integratedTree, snapshot.recovery === null))) throw new IntegrationError("INVALID_INPUT", "Persisted post-integration validation is not exactly linked.");
  if (snapshot.status === "completed") {
    const cleanup = snapshot.terminal?.cleanup;
    if (snapshot.postValidation === null || !snapshot.postValidation.passed || snapshot.postValidation.skippedCount !== 0 || cleanup === null || cleanup === undefined || (!cleanup.cleaned && !cleanup.preservedEvidence)) throw new IntegrationError("INVALID_INPUT", "Completed integration lacks exact passing validation and cleanup evidence.");
  }
  const expectedTerminalValidationDigest = snapshot.postValidation?.resultDigest ?? (snapshot.status === "failed" && snapshot.intent === null ? snapshot.preValidation?.resultDigest ?? null : null);
  if (snapshot.terminal !== null && (snapshot.terminal.receiptDigest !== (snapshot.receipt?.receiptDigest ?? null) || snapshot.terminal.validationResultDigest !== expectedTerminalValidationDigest || snapshot.terminal.failureCode !== snapshot.lastFailureCode || snapshot.terminal.completedAt !== snapshot.updatedAt)) throw new IntegrationError("INVALID_INPUT", "Terminal result does not bind the persisted receipt, validation, failure, and event time.");
  if (snapshot.terminal?.cleanup !== null && snapshot.terminal?.cleanup !== undefined) {
    const expectedWorktreeId = snapshot.receipt?.worktreeId ?? (snapshot.intent === null ? null : stableIntegrationId("integration-worktree", snapshot.intent.intentId));
    if (expectedWorktreeId === null || snapshot.terminal.cleanup.worktreeId !== expectedWorktreeId || snapshot.terminal.cleanup.observedAt < request.createdAt) throw new IntegrationError("INVALID_INPUT", "Terminal cleanup does not bind the exact integration worktree.");
  }
  if (snapshot.recovery !== null) {
    const recoveryReceiptMatches = snapshot.recovery.state === "ref-published"
      ? snapshot.recovery.receipt?.receiptDigest === snapshot.receipt?.receiptDigest
      : snapshot.recovery.receipt === null;
    const recoveredReceiptTimeIsExact = snapshot.recovery.receipt?.timingBasis !== "recovered-observation" ||
      snapshot.recovery.receipt.committedAt === snapshot.recovery.observedAt;
    if (snapshot.intent === null || !exactRecoveryProjection(request, snapshot.intent, snapshot.recovery, snapshot.receipt !== null) || !recoveryReceiptMatches || !recoveredReceiptTimeIsExact) throw new IntegrationError("INVALID_INPUT", "Recovery result does not bind the persisted intent, receipt, target, and observation time.");
  }
  return snapshot;
}

export function parseIntegrationEvent(value: unknown): IntegrationEvent {
  assertIntegrationInputBudget(value);
  const record = ensureRecord(value, "event");
  ensureExactKeys(record, ["schemaVersion", "eventId", "runId", "sequence", "aggregateVersion", "type", "occurredAt", "beforeDigest", "afterDigest", "command", "snapshot"], "event");
  const commandRecord = ensureRecord(record["command"], "event.command");
  ensureExactKeys(commandRecord, ["commandId", "submittedAt", "expectedVersion", "owner", "leaseId", "fencingToken", "leaseExpiresAt", "reasonCode", "evidenceDigest", "commandFingerprint"], "event.command");
  const commandBase = {
    commandId: parseIntegrationId(commandRecord["commandId"], "event.command.commandId"),
    submittedAt: ensureTimestamp(commandRecord["submittedAt"], "event.command.submittedAt"),
    expectedVersion: commandRecord["expectedVersion"] === null ? null : ensureSafeInteger(commandRecord["expectedVersion"], "event.command.expectedVersion", 1, Number.MAX_SAFE_INTEGER),
    owner: commandRecord["owner"] === null ? null : parseIntegrationId(commandRecord["owner"], "event.command.owner"),
    leaseId: commandRecord["leaseId"] === null ? null : parseIntegrationId(commandRecord["leaseId"], "event.command.leaseId"),
    fencingToken: commandRecord["fencingToken"] === null ? null : ensureSafeInteger(commandRecord["fencingToken"], "event.command.fencingToken", 1, Number.MAX_SAFE_INTEGER),
    leaseExpiresAt: commandRecord["leaseExpiresAt"] === null ? null : ensureTimestamp(commandRecord["leaseExpiresAt"], "event.command.leaseExpiresAt"),
    reasonCode: commandRecord["reasonCode"] === null ? null : parseIntegrationCode(commandRecord["reasonCode"], "event.command.reasonCode"),
    evidenceDigest: commandRecord["evidenceDigest"] === null ? null : parseIntegrationDigest(commandRecord["evidenceDigest"], "event.command.evidenceDigest"),
  };
  const command = Object.freeze({ ...commandBase, commandFingerprint: parseIntegrationDigest(commandRecord["commandFingerprint"], "event.command.commandFingerprint") });
  if (command.commandFingerprint !== integrationDigest(commandBase)) throw new IntegrationError("INVALID_INPUT", "Integration event command fingerprint is inconsistent.");
  const snapshot = parseIntegrationRunSnapshot(record["snapshot"]);
  const event = Object.freeze({
    schemaVersion: (ensureSchemaVersion(record["schemaVersion"], "event.schemaVersion", INTEGRATION_SCHEMA_VERSION), INTEGRATION_SCHEMA_VERSION),
    eventId: parseIntegrationId(record["eventId"], "event.eventId"),
    runId: parseIntegrationId(record["runId"], "event.runId"),
    sequence: ensureSafeInteger(record["sequence"], "event.sequence", 1, Number.MAX_SAFE_INTEGER),
    aggregateVersion: ensureSafeInteger(record["aggregateVersion"], "event.aggregateVersion", 1, Number.MAX_SAFE_INTEGER),
    type: validation.ensureEnum(record["type"], "event.type", INTEGRATION_EVENT_TYPES),
    occurredAt: ensureTimestamp(record["occurredAt"], "event.occurredAt"),
    beforeDigest: record["beforeDigest"] === null ? null : parseIntegrationDigest(record["beforeDigest"], "event.beforeDigest"),
    afterDigest: parseIntegrationDigest(record["afterDigest"], "event.afterDigest"),
    command,
    snapshot,
  });
  if (event.runId !== snapshot.runId || event.sequence !== snapshot.eventSequence || event.aggregateVersion !== snapshot.aggregateVersion || event.occurredAt !== snapshot.updatedAt || event.afterDigest !== integrationDigest(snapshot) || event.eventId !== stableIntegrationId("integration-event", event.runId, String(event.sequence), event.type, command.commandFingerprint, event.afterDigest)) throw new IntegrationError("INVALID_INPUT", "Integration event envelope is inconsistent.");
  return event;
}

function replayInput(event: IntegrationEvent): ParsedIntegrationCommandInput {
  if (event.command.expectedVersion === null) throw new IntegrationError("PERSISTENCE_MISMATCH", "Transition event lacks an expected version.");
  return Object.freeze({
    runId: event.runId,
    commandId: event.command.commandId,
    expectedVersion: event.command.expectedVersion,
    owner: event.command.owner,
    leaseId: event.command.leaseId,
    fencingToken: event.command.fencingToken,
    leaseExpiresAt: event.command.leaseExpiresAt,
    reasonCode: event.command.reasonCode,
    occurredAt: event.command.submittedAt,
  });
}

function assertDerivedTransition(event: IntegrationEvent, derived: IntegrationTransition, label: string): void {
  if (toCanonicalJson(event.snapshot) !== toCanonicalJson(derived.snapshot) || toCanonicalJson(event.command) !== toCanonicalJson(derived.event.command)) {
    throw new IntegrationError("PERSISTENCE_MISMATCH", `${label} is not command-equivalent.`);
  }
}

function assertReplayDelta(previous: IntegrationRunSnapshot | null, event: IntegrationEvent): void {
  const next = event.snapshot;
  if (previous === null) {
    if (event.type !== "integration.accepted" || event.beforeDigest !== null || next.status !== "pending" || next.aggregateVersion !== 1 || event.command.expectedVersion !== null) throw new IntegrationError("PERSISTENCE_MISMATCH", "First integration event is not the exact acceptance event.");
    assertDerivedTransition(event, createIntegrationRun(next.request, next.authorityConfiguration), "Acceptance transition");
    return;
  }
  if (event.beforeDigest !== integrationDigest(previous) || next.aggregateVersion !== previous.aggregateVersion + 1 || next.eventSequence !== previous.eventSequence + 1 || event.command.expectedVersion !== previous.aggregateVersion) throw new IntegrationError("PERSISTENCE_MISMATCH", "Integration event does not extend the prior version exactly.");
  switch (event.type) {
    case "integration.leased":
      assertDerivedTransition(event, claimIntegrationRun(previous, replayInput(event)), "Lease transition");
      break;
    case "integration.retry-scheduled": {
      if (next.lastFailureCode === null) throw new IntegrationError("PERSISTENCE_MISMATCH", "Retry transition lacks a failure code.");
      assertDerivedTransition(event, failIntegrationRun(previous, replayInput(event), next.lastFailureCode, null, event.occurredAt), "Retry transition");
      break;
    }
    case "integration.prepared":
      if (next.preflight === null || next.preValidation === null) throw new IntegrationError("PERSISTENCE_MISMATCH", "Preparation event lacks exact evidence.");
      assertDerivedTransition(event, prepareIntegrationRun(previous, replayInput(event), next.preflight, next.preValidation), "Preparation transition");
      break;
    case "integration.effect-started":
      assertDerivedTransition(event, startIntegrationEffect(previous, replayInput(event), event.occurredAt), "Effect-start transition");
      break;
    case "integration.receipt-recorded":
      if (next.receipt === null) throw new IntegrationError("PERSISTENCE_MISMATCH", "Receipt event lacks a receipt.");
      assertDerivedTransition(event, recordIntegrationReceipt(previous, replayInput(event), next.receipt), "Receipt transition");
      break;
    case "integration.recovery-started":
      assertDerivedTransition(event, startIntegrationRecovery(previous, replayInput(event), event.occurredAt), "Recovery-start transition");
      break;
    case "integration.recovery-exhausted":
      assertDerivedTransition(event, exhaustIntegrationRecovery(previous, replayInput(event), event.occurredAt), "Recovery-exhaustion transition");
      break;
    case "integration.completed":
      if (next.postValidation === null || next.terminal?.cleanup === null || next.terminal?.cleanup === undefined) throw new IntegrationError("PERSISTENCE_MISMATCH", "Completion event lacks terminal evidence.");
      assertDerivedTransition(event, completeIntegrationRun(previous, replayInput(event), next.postValidation, next.terminal.cleanup), "Completion transition");
      break;
    case "integration.failed": {
      const preparationEvidenceAdded = previous.preflight === null && previous.preValidation === null && next.preflight !== null && next.preValidation !== null;
      if (preparationEvidenceAdded && next.preflight !== null && next.preValidation !== null) {
        assertDerivedTransition(event, prepareIntegrationRun(previous, replayInput(event), next.preflight, next.preValidation), "Preparation failure transition");
      } else if (previous.status === "committed" && next.postValidation !== null && next.terminal?.cleanup !== null && next.terminal?.cleanup !== undefined) {
        assertDerivedTransition(event, completeIntegrationRun(previous, replayInput(event), next.postValidation, next.terminal.cleanup), "Terminal validation failure transition");
      } else {
        if (next.lastFailureCode === null) throw new IntegrationError("PERSISTENCE_MISMATCH", "Failure transition lacks a failure code.");
        assertDerivedTransition(event, failIntegrationRun(previous, replayInput(event), next.lastFailureCode, next.terminal?.cleanup ?? null, event.occurredAt), "Failure transition");
      }
      break;
    }
    case "integration.cancelled":
      assertDerivedTransition(event, cancelIntegrationRun(previous, replayInput(event)), "Cancellation transition");
      break;
    case "integration.reconciled":
      if (next.recovery === null) throw new IntegrationError("PERSISTENCE_MISMATCH", "Reconciliation event lacks recovery evidence.");
      assertDerivedTransition(event, reconcileIntegrationRun(
        previous,
        replayInput(event),
        next.recovery,
        next.postValidation,
        next.terminal?.cleanup ?? null,
        next.recovery.state === "ref-published" && ["post-validation-boundary-failed", "post-validation-invalid"].includes(next.lastFailureCode ?? "") ? next.lastFailureCode : null,
      ), "Reconciliation transition");
      break;
    case "integration.accepted":
      throw new IntegrationError("PERSISTENCE_MISMATCH", "Acceptance can occur only once.");
  }
}

export function replayIntegrationEvents(value: unknown): IntegrationRunSnapshot {
  const values = ensureArray(value, "events", INTEGRATION_LIMITS.maximumJournalEvents);
  if (values.length === 0) throw new IntegrationError("PERSISTENCE_MISMATCH", "Integration journal cannot be empty.");
  let current: IntegrationRunSnapshot | null = null;
  let priorEvent: IntegrationEvent | null = null;
  const commandFingerprints = new Map<string, string>();
  values.forEach((item) => {
    const event = parseIntegrationEvent(item);
    const prior = commandFingerprints.get(event.command.commandId);
    const exactRecoveryExhaustionContinuation = prior !== undefined && priorEvent?.type === "integration.recovery-started" &&
      event.type === "integration.recovery-exhausted" && priorEvent.command.commandId === event.command.commandId &&
      priorEvent.command.submittedAt === event.command.submittedAt && priorEvent.command.owner === event.command.owner &&
      priorEvent.command.leaseId === event.command.leaseId && priorEvent.command.fencingToken === event.command.fencingToken;
    if (prior !== undefined && !exactRecoveryExhaustionContinuation) throw new IntegrationError("PERSISTENCE_MISMATCH", prior === event.command.commandFingerprint ? "Duplicate integration command was appended twice." : "Integration command identity was reused with different content.");
    commandFingerprints.set(event.command.commandId, event.command.commandFingerprint);
    assertReplayDelta(current, event);
    current = event.snapshot;
    priorEvent = event;
  });
  return current!;
}

export function integrationCommandEquals(event: IntegrationEvent, commandId: string, fingerprint: string): boolean {
  return event.command.commandId === commandId && event.command.commandFingerprint === fingerprint;
}

export const integrationStateTesting = Object.freeze({ eventCommand, eventFor, assertReplayDelta, assertReceipt });
