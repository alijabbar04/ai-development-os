import { toCanonicalJson, validation } from "@ai-dev-os/domain";
import { SchedulerError } from "./errors.js";
import { parseNormalizedUsage, parseOrchestrationTaskEnvelope, parseTerminalResult, taskFingerprint, ZERO_NORMALIZED_USAGE } from "./schema.js";
import {
  ORCHESTRATION_SCHEMA_VERSION,
  PROFILE_OWNERSHIP_CLASSES,
  RUN_STATUSES,
  type DispatchReceipt,
  type NormalizedUsage,
  type OrchestrationEvent,
  type OrchestrationRunState,
  type OrchestrationTerminalResult,
  type PolicyBlock,
  type RunStatus,
  type SelectedRoute,
} from "./types.js";

const { ensureArray, ensureBoolean, ensureEnum, ensureExactKeys, ensureRecord, ensureSafeInteger, ensureString, ensureTimestamp, fail } = validation;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function id(value: unknown, path: string): string {
  return ensureString(value, path, { maxLength: 128, pattern: ID, patternName: "identifier" });
}

function exactPayload(event: OrchestrationEvent, keys: readonly string[]): Record<string, unknown> {
  const payload = ensureRecord(event.payload, `event.${event.type}.payload`);
  ensureExactKeys(payload, keys, `event.${event.type}.payload`);
  return payload;
}

function parseRoute(value: unknown, path: string): SelectedRoute {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, ["candidateId", "providerId", "modelId", "profileId", "ownership"], path);
  return Object.freeze({
    candidateId: id(input["candidateId"], `${path}.candidateId`),
    providerId: id(input["providerId"], `${path}.providerId`),
    modelId: id(input["modelId"], `${path}.modelId`),
    profileId: id(input["profileId"], `${path}.profileId`),
    ownership: ensureEnum(input["ownership"], `${path}.ownership`, PROFILE_OWNERSHIP_CLASSES),
  });
}

function parseStringArray(value: unknown, path: string, maximum: number): readonly string[] {
  return Object.freeze(ensureArray(value, path, maximum)
    .map((item, index) => ensureString(item, `${path}[${index}]`, { maxLength: 4_000 })));
}

function sameRoute(left: SelectedRoute, right: SelectedRoute): boolean {
  return toCanonicalJson(left) === toCanonicalJson(right);
}

function parseConsideredRoute(value: unknown, path: string): {
  readonly candidate: SelectedRoute;
  readonly eligible: boolean;
  readonly score: number | null;
} {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, ["candidate", "eligible", "score", "ruleIds", "reasons"], path);
  const eligible = ensureBoolean(input["eligible"], `${path}.eligible`);
  const score = input["score"] === null ? null : ensureSafeInteger(input["score"], `${path}.score`, 0, 10_000);
  if (eligible !== (score !== null)) throw new SchedulerError("INVALID_EVENT", "A considered route has inconsistent eligibility and score.");
  parseStringArray(input["ruleIds"], `${path}.ruleIds`, 128);
  parseStringArray(input["reasons"], `${path}.reasons`, 128);
  return Object.freeze({ candidate: parseRoute(input["candidate"], `${path}.candidate`), eligible, score });
}

function parseBlock(value: unknown, path: string): PolicyBlock {
  const input = ensureRecord(value, path);
  ensureExactKeys(input, ["blockId", "operationFingerprint", "ruleIds", "reason", "humanResumable"], path);
  const ruleIds = ensureArray(input["ruleIds"], `${path}.ruleIds`, 64)
    .map((item, index) => id(item, `${path}.ruleIds[${index}]`));
  return Object.freeze({
    blockId: id(input["blockId"], `${path}.blockId`),
    operationFingerprint: ensureString(input["operationFingerprint"], `${path}.operationFingerprint`, { maxLength: 64, pattern: /^[a-f0-9]{64}$/, patternName: "SHA-256" }),
    ruleIds: Object.freeze(ruleIds),
    reason: ensureString(input["reason"], `${path}.reason`, { maxLength: 4_000 }),
    humanResumable: ensureBoolean(input["humanResumable"], `${path}.humanResumable`),
  });
}

function assertUsageMonotonic(previous: NormalizedUsage, next: NormalizedUsage): void {
  const numeric: ReadonlyArray<Exclude<keyof NormalizedUsage, "costMicros">> = [
    "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningTokens", "toolCalls",
  ];
  if (numeric.some((key) => next[key] < previous[key]) ||
      previous.costMicros !== null && (next.costMicros === null || next.costMicros < previous.costMicros)) {
    throw new SchedulerError("INVALID_EVENT", "Usage snapshots must be cumulative and non-decreasing.");
  }
}

function isTerminal(state: OrchestrationRunState): boolean {
  return state.status === "completed" || state.status === "failed" || state.status === "cancelled" ||
    (state.status === "policy-blocked" && state.block?.humanResumable === false);
}

function assertTerminalBinding(
  state: OrchestrationRunState,
  result: OrchestrationTerminalResult,
  event: OrchestrationEvent,
): void {
  assertUsageMonotonic(state.usage, result.usage);
  if (result.finishedAt > event.occurredAt) throw new SchedulerError("INVALID_EVENT", "A terminal result cannot be future-dated relative to its journal event.");
  if (state.threadId !== null) {
    if (result.provider === null || state.route === null || result.provider.threadId !== state.threadId ||
        result.provider.providerRunId !== state.providerRunId || result.provider.providerId !== state.route.providerId ||
        result.provider.modelId !== state.route.modelId || result.provider.profileId !== state.route.profileId) {
      throw new SchedulerError("INVALID_EVENT", "Terminal provider identity must match the durable dispatch thread.");
    }
  } else if (result.provider !== null) {
    throw new SchedulerError("INVALID_EVENT", "A result cannot claim provider identity before a durable thread starts.");
  }
}

function baseState(event: OrchestrationEvent): OrchestrationRunState {
  if (event.type !== "queued" || event.sequence !== 1) {
    throw new SchedulerError("INVALID_TRANSITION", "The first orchestration event must be queued at sequence 1.");
  }
  const payload = exactPayload(event, ["task", "taskFingerprint"]);
  const task = parseOrchestrationTaskEnvelope(payload["task"]);
  const fingerprint = ensureString(payload["taskFingerprint"], "event.queued.payload.taskFingerprint", { maxLength: 64, pattern: /^[a-f0-9]{64}$/, patternName: "SHA-256" });
  if (fingerprint !== taskFingerprint(task) || task.taskId !== event.taskId) {
    throw new SchedulerError("STATE_CORRUPTION", "The queued task fingerprint or identity is inconsistent.");
  }
  if (task.createdAt > event.occurredAt) {
    throw new SchedulerError("INVALID_EVENT", "A task cannot be queued before its creation time.");
  }
  return Object.freeze({
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    task,
    taskFingerprint: fingerprint,
    status: "queued",
    sequence: event.sequence,
    lastEventId: event.eventId,
    lastOccurredAt: event.occurredAt,
    attempt: 0,
    turns: 0,
    routingDecisionId: null,
    routingOutcome: null,
    route: null,
    dispatch: null,
    threadId: null,
    providerRunId: null,
    nextAttemptAt: null,
    usage: ZERO_NORMALIZED_USAGE,
    approvalId: null,
    block: null,
    result: null,
  });
}

function withEvent(state: OrchestrationRunState, event: OrchestrationEvent, update: Partial<OrchestrationRunState>): OrchestrationRunState {
  return Object.freeze({ ...state, ...update, sequence: event.sequence, lastEventId: event.eventId, lastOccurredAt: event.occurredAt });
}

function assertStatus(state: OrchestrationRunState, allowed: readonly RunStatus[], event: OrchestrationEvent): void {
  if (!allowed.includes(state.status)) {
    throw new SchedulerError("INVALID_TRANSITION", `Event ${event.type} is invalid from state ${state.status}.`, { from: state.status, event: event.type });
  }
}

export function applyOrchestrationEvent(state: OrchestrationRunState, event: OrchestrationEvent): OrchestrationRunState {
  if (event.taskId !== state.task.taskId || event.sequence !== state.sequence + 1) {
    throw new SchedulerError("INVALID_EVENT", "Event identity or sequence is inconsistent.");
  }
  if (state.lastOccurredAt !== null && event.occurredAt < state.lastOccurredAt) {
    throw new SchedulerError("INVALID_EVENT", "Event time cannot move backwards.");
  }
  if (isTerminal(state)) {
    throw new SchedulerError("DUPLICATE_TERMINAL", "No event may follow a terminal orchestration result.");
  }
  switch (event.type) {
    case "queued":
      throw new SchedulerError("INVALID_TRANSITION", "Queued may occur only as the first event.");
    case "routing_decision": {
      assertStatus(state, ["queued"], event);
      if (state.routingDecisionId !== null) throw new SchedulerError("INVALID_TRANSITION", "A queued attempt may have only one routing decision.");
      const payload = exactPayload(event, ["decisionId", "outcome", "selected", "considered", "ruleIds", "reasons", "decidedAt"]);
      const routingDecisionId = id(payload["decisionId"], "event.routing_decision.payload.decisionId");
      const routingOutcome = ensureEnum(payload["outcome"], "event.routing_decision.payload.outcome", ["selected", "denied"] as const);
      const selected = payload["selected"] === null ? null : parseRoute(payload["selected"], "event.routing_decision.payload.selected");
      if ((routingOutcome === "selected") !== (selected !== null)) throw new SchedulerError("INVALID_EVENT", "Routing outcome and selected route must agree.");
      const considered = ensureArray(payload["considered"], "event.routing_decision.payload.considered", 256)
        .map((item, index) => parseConsideredRoute(item, `event.routing_decision.payload.considered[${index}]`));
      const consideredIds = new Set(considered.map((item) => item.candidate.candidateId));
      if (consideredIds.size !== considered.length) throw new SchedulerError("INVALID_EVENT", "Considered route identities must be unique.");
      if (selected !== null && !considered.some((item) => item.eligible && sameRoute(item.candidate, selected))) {
        throw new SchedulerError("INVALID_EVENT", "The selected route must be one eligible considered route.");
      }
      parseStringArray(payload["ruleIds"], "event.routing_decision.payload.ruleIds", 128);
      parseStringArray(payload["reasons"], "event.routing_decision.payload.reasons", 128);
      const decidedAt = ensureTimestamp(payload["decidedAt"], "event.routing_decision.payload.decidedAt");
      if (decidedAt > event.occurredAt || decidedAt < state.task.createdAt) throw new SchedulerError("INVALID_EVENT", "Routing decision time must fall between task creation and journal occurrence.");
      return withEvent(state, event, { routingDecisionId, routingOutcome, route: selected });
    }
    case "dispatched": {
      assertStatus(state, ["queued"], event);
      if (state.routingOutcome !== "selected" || state.route === null) throw new SchedulerError("INVALID_TRANSITION", "Dispatch requires the selected route from this attempt's routing decision.");
      const payload = exactPayload(event, ["attempt", "dispatchId", "route", "leaseExpiresAt"]);
      const attempt = ensureSafeInteger(payload["attempt"], "event.dispatched.payload.attempt", 1, 8);
      if (attempt !== state.attempt + 1) throw new SchedulerError("INVALID_EVENT", "Dispatch attempt must increment exactly once.");
      const dispatchId = id(payload["dispatchId"], "event.dispatched.payload.dispatchId");
      const route = parseRoute(payload["route"], "event.dispatched.payload.route");
      if (!sameRoute(route, state.route)) throw new SchedulerError("INVALID_EVENT", "Dispatch route must equal the selected routing decision.");
      const leaseExpiresAt = ensureTimestamp(payload["leaseExpiresAt"], "event.dispatched.payload.leaseExpiresAt");
      if (leaseExpiresAt <= event.occurredAt) throw new SchedulerError("INVALID_EVENT", "A dispatch lease must expire after dispatch.");
      const dispatch: DispatchReceipt = Object.freeze({ dispatchId, attempt, route, leaseExpiresAt });
      return withEvent(state, event, { status: "dispatched", attempt, route, dispatch, nextAttemptAt: null, approvalId: null, block: null });
    }
    case "started": {
      assertStatus(state, ["dispatched", "running"], event);
      const payload = exactPayload(event, ["threadId", "providerRunId", "continued"]);
      const continued = ensureBoolean(payload["continued"], "event.started.payload.continued");
      if ((state.status === "running") !== continued) throw new SchedulerError("INVALID_EVENT", "Continuation marker does not match the current state.");
      const threadId = id(payload["threadId"], "event.started.payload.threadId");
      const providerRunId = id(payload["providerRunId"], "event.started.payload.providerRunId");
      if (continued && (threadId !== state.threadId || providerRunId !== state.providerRunId)) {
        throw new SchedulerError("INVALID_EVENT", "A continuation cannot change durable provider identity.");
      }
      const turns = state.turns + 1;
      if (turns > state.task.budget.maximumTurns) throw new SchedulerError("INVALID_TRANSITION", "The bounded turn ceiling is exhausted.");
      return withEvent(state, event, {
        status: "running",
        threadId,
        providerRunId,
        turns,
      });
    }
    case "progress": {
      assertStatus(state, ["running"], event);
      const payload = exactPayload(event, ["message", "percent"]);
      ensureString(payload["message"], "event.progress.payload.message", { maxLength: 4_000 });
      if (payload["percent"] !== null) ensureSafeInteger(payload["percent"], "event.progress.payload.percent", 0, 100);
      return withEvent(state, event, {});
    }
    case "checkpoint": {
      assertStatus(state, ["running"], event);
      const payload = exactPayload(event, ["checkpointId", "kind", "artifactIds"]);
      id(payload["checkpointId"], "event.checkpoint.payload.checkpointId");
      id(payload["kind"], "event.checkpoint.payload.kind");
      ensureArray(payload["artifactIds"], "event.checkpoint.payload.artifactIds", 1_000).forEach((item, index) => id(item, `event.checkpoint.payload.artifactIds[${index}]`));
      return withEvent(state, event, {});
    }
    case "usage_snapshot": {
      assertStatus(state, ["running"], event);
      const payload = exactPayload(event, ["usage"]);
      const usage = parseNormalizedUsage(payload["usage"], "event.usage_snapshot.payload.usage");
      assertUsageMonotonic(state.usage, usage);
      return withEvent(state, event, { usage });
    }
    case "approval_required": {
      assertStatus(state, ["dispatched", "running"], event);
      const payload = exactPayload(event, ["approvalId", "reason", "humanResumable"]);
      id(payload["approvalId"], "event.approval_required.payload.approvalId");
      ensureString(payload["reason"], "event.approval_required.payload.reason", { maxLength: 4_000 });
      if (ensureBoolean(payload["humanResumable"], "event.approval_required.payload.humanResumable") !== true) throw new SchedulerError("INVALID_EVENT", "Approval waits must be explicitly human-resumable.");
      return withEvent(state, event, { status: "awaiting-approval", approvalId: id(payload["approvalId"], "event.approval_required.payload.approvalId") });
    }
    case "policy_blocked": {
      assertStatus(state, ["queued", "dispatched", "running", "awaiting-approval"], event);
      if (state.status === "queued" && state.routingDecisionId === null) throw new SchedulerError("INVALID_TRANSITION", "A queued policy block requires a routing decision.");
      const payload = exactPayload(event, ["block", "result"]);
      const block = parseBlock(payload["block"], "event.policy_blocked.payload.block");
      const result = payload["result"] === null ? null : parseTerminalResult(payload["result"], "event.policy_blocked.payload.result");
      if ((block.humanResumable && result !== null) || (!block.humanResumable && result?.outcome !== "policy-blocked")) {
        throw new SchedulerError("INVALID_EVENT", "Policy-block result must be absent only for a human-resumable block.");
      }
      if (result !== null) assertTerminalBinding(state, result, event);
      return withEvent(state, event, { status: "policy-blocked", approvalId: null, block, result });
    }
    case "retry_scheduled": {
      assertStatus(state, ["dispatched", "running"], event);
      const payload = exactPayload(event, ["attempt", "runAt", "delayMs", "failureClassification"]);
      const attempt = ensureSafeInteger(payload["attempt"], "event.retry_scheduled.payload.attempt", 1, 8);
      if (attempt !== state.attempt) throw new SchedulerError("INVALID_EVENT", "Retry must refer to the current attempt.");
      ensureSafeInteger(payload["delayMs"], "event.retry_scheduled.payload.delayMs", 0, 3_600_000);
      const runAt = ensureTimestamp(payload["runAt"], "event.retry_scheduled.payload.runAt");
      if (runAt < event.occurredAt) throw new SchedulerError("INVALID_EVENT", "Retry time cannot precede the event.");
      ensureString(payload["failureClassification"], "event.retry_scheduled.payload.failureClassification", { maxLength: 64 });
      return withEvent(state, event, { status: "retry-wait", nextAttemptAt: runAt, threadId: null, providerRunId: null, approvalId: null });
    }
    case "completed":
    case "failed":
    case "cancelled": {
      const allowed: readonly RunStatus[] = event.type === "cancelled"
        ? ["queued", "dispatched", "running", "awaiting-approval", "retry-wait", "policy-blocked"]
        : ["dispatched", "running"];
      assertStatus(state, allowed, event);
      const payload = exactPayload(event, ["result"]);
      const result = parseTerminalResult(payload["result"], `event.${event.type}.payload.result`);
      const expectedOutcome = event.type === "completed" ? "completed" : event.type;
      if (result.outcome !== expectedOutcome) throw new SchedulerError("INVALID_EVENT", "Terminal event/result outcomes must agree.");
      assertTerminalBinding(state, result, event);
      return withEvent(state, event, { status: event.type, usage: result.usage, approvalId: null, result });
    }
    case "recovered": {
      const payload = exactPayload(event, ["fromStatus", "toStatus", "action", "reason", "leaseExpiresAt"]);
      const fromStatus = ensureEnum(payload["fromStatus"], "event.recovered.payload.fromStatus", RUN_STATUSES);
      const toStatus = ensureEnum(payload["toStatus"], "event.recovered.payload.toStatus", RUN_STATUSES);
      const action = ensureEnum(payload["action"], "event.recovered.payload.action", ["retry-due", "human-resume", "lease-reconciled", "provider-resumed"] as const);
      ensureString(payload["reason"], "event.recovered.payload.reason", { maxLength: 2_000 });
      if (fromStatus !== state.status) throw new SchedulerError("INVALID_EVENT", "Recovery source state must match current state.");
      const legal =
        (fromStatus === "retry-wait" && toStatus === "queued" && action === "retry-due") ||
        ((fromStatus === "awaiting-approval" || fromStatus === "policy-blocked") && toStatus === "queued" && action === "human-resume") ||
        ((fromStatus === "dispatched" || fromStatus === "running") && toStatus === fromStatus && (action === "lease-reconciled" || action === "provider-resumed"));
      if (!legal) throw new SchedulerError("INVALID_TRANSITION", "The recovery transition is not legal.");
      if (fromStatus === "policy-blocked" && state.block?.humanResumable !== true) throw new SchedulerError("INVALID_TRANSITION", "A terminal policy block cannot be resumed.");
      const leaseExpiresAt = payload["leaseExpiresAt"] === null ? null : ensureTimestamp(payload["leaseExpiresAt"], "event.recovered.payload.leaseExpiresAt");
      if ((toStatus === "dispatched" || toStatus === "running") && (leaseExpiresAt === null || leaseExpiresAt <= event.occurredAt)) {
        throw new SchedulerError("INVALID_EVENT", "Recovered active work requires a fresh future lease.");
      }
      const dispatch = leaseExpiresAt === null || state.dispatch === null ? state.dispatch : Object.freeze({ ...state.dispatch, leaseExpiresAt });
      return withEvent(state, event, {
        status: toStatus,
        routingDecisionId: toStatus === "queued" ? null : state.routingDecisionId,
        routingOutcome: toStatus === "queued" ? null : state.routingOutcome,
        route: toStatus === "queued" ? null : state.route,
        dispatch: toStatus === "queued" ? null : dispatch,
        threadId: toStatus === "queued" ? null : state.threadId,
        providerRunId: toStatus === "queued" ? null : state.providerRunId,
        approvalId: null,
        block: toStatus === "queued" ? null : state.block,
        result: toStatus === "queued" ? null : state.result,
        nextAttemptAt: toStatus === "queued" ? null : state.nextAttemptAt,
      });
    }
  }
}

export function replayOrchestrationEvents(events: readonly OrchestrationEvent[]): OrchestrationRunState {
  if (events.length === 0) throw new SchedulerError("STATE_CORRUPTION", "An orchestration journal cannot be empty.");
  const seen = new Set<string>();
  let state = baseState(events[0] as OrchestrationEvent);
  seen.add(events[0]?.eventId ?? "");
  for (let index = 1; index < events.length; index++) {
    const event = events[index];
    if (event === undefined) throw new SchedulerError("STATE_CORRUPTION", "A journal event is missing.");
    if (seen.has(event.eventId)) throw new SchedulerError("INVALID_EVENT", "Duplicate event identifiers are refused.");
    seen.add(event.eventId);
    state = applyOrchestrationEvent(state, event);
  }
  return state;
}

export function stateEquals(left: OrchestrationRunState, right: unknown): boolean {
  return toCanonicalJson(left) === toCanonicalJson(right);
}
