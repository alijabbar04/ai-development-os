import { validation } from "@ai-dev-os/domain";
import type { RouterConfiguration } from "./config.js";
import { HEX_64, SAFE_ID, SAFE_KIND, compareText, digest } from "./shared.js";

const {
  ensureArray,
  ensureBoolean,
  ensureEnum,
  ensureExactKeys,
  ensureNullable,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
  ensureString,
  ensureTimestamp,
  fail
} = validation;

export const CIRCUIT_BREAKER_ALGORITHM_VERSION = 1 as const;
export const CIRCUIT_BREAKER_SCHEMA_VERSION = 1 as const;
export const CIRCUIT_BREAKER_PHASES = Object.freeze(["closed", "open", "half-open"] as const);
export type CircuitBreakerPhase = (typeof CIRCUIT_BREAKER_PHASES)[number];
export const CIRCUIT_EVENT_KINDS = Object.freeze([
  "success",
  "retryable-failure",
  "terminal-provider-failure",
  "admit-probe"
] as const);
export type CircuitEventKind = (typeof CIRCUIT_EVENT_KINDS)[number];

export interface CircuitBreakerIdentity {
  readonly providerInstanceId: string;
  readonly contractModelId: string;
  readonly operationClass: string;
}

export interface CircuitBreakerState {
  readonly schemaVersion: typeof CIRCUIT_BREAKER_SCHEMA_VERSION;
  readonly algorithmVersion: typeof CIRCUIT_BREAKER_ALGORITHM_VERSION;
  readonly identity: CircuitBreakerIdentity;
  readonly phase: CircuitBreakerPhase;
  readonly consecutiveFailures: number;
  readonly openedAt: string | null;
  readonly coolDownUntil: string | null;
  readonly probeInFlight: boolean;
  readonly lastEventAt: string | null;
  readonly rememberedEventIds: readonly string[];
  readonly fingerprint: string;
}

function parseIdentity(value: unknown, path: string): CircuitBreakerIdentity {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["providerInstanceId", "contractModelId", "operationClass"], path);
  return Object.freeze({
    providerInstanceId: ensureString(
      record["providerInstanceId"],
      `${path}.providerInstanceId`,
      { maxLength: 128, pattern: SAFE_ID, patternName: "provider instance identifier" }
    ),
    contractModelId: ensureString(record["contractModelId"], `${path}.contractModelId`, {
      maxLength: 128,
      pattern: SAFE_ID,
      patternName: "contract model identifier"
    }),
    operationClass: ensureString(record["operationClass"], `${path}.operationClass`, {
      maxLength: 64,
      pattern: SAFE_KIND,
      patternName: "operation class"
    })
  });
}

export function circuitBreakerStateFingerprint(
  value: Omit<CircuitBreakerState, "fingerprint">
): string {
  return digest(value);
}

export function parseCircuitBreakerState(
  value: unknown,
  path = "circuitBreakerState"
): CircuitBreakerState {
  const record = ensureRecord(value, path);
  const keys = [
    "schemaVersion", "algorithmVersion", "identity", "phase", "consecutiveFailures",
    "openedAt", "coolDownUntil", "probeInFlight", "lastEventAt", "rememberedEventIds",
    "fingerprint"
  ] as const;
  ensureExactKeys(record, keys, path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, CIRCUIT_BREAKER_SCHEMA_VERSION);
  ensureSchemaVersion(
    record["algorithmVersion"],
    `${path}.algorithmVersion`,
    CIRCUIT_BREAKER_ALGORITHM_VERSION
  );
  const rememberedEventIds = ensureArray(
    record["rememberedEventIds"],
    `${path}.rememberedEventIds`,
    10_000
  ).map((raw, index) =>
    ensureString(raw, `${path}.rememberedEventIds[${index}]`, {
      maxLength: 128,
      pattern: SAFE_ID,
      patternName: "event identifier"
    })
  );
  if (new Set(rememberedEventIds).size !== rememberedEventIds.length) {
    fail(`${path}.rememberedEventIds`, "duplicate_event", "event identifiers must be unique.");
  }
  const unsigned = Object.freeze({
    schemaVersion: CIRCUIT_BREAKER_SCHEMA_VERSION,
    algorithmVersion: CIRCUIT_BREAKER_ALGORITHM_VERSION,
    identity: parseIdentity(record["identity"], `${path}.identity`),
    phase: ensureEnum(record["phase"], `${path}.phase`, CIRCUIT_BREAKER_PHASES),
    consecutiveFailures: ensureSafeInteger(
      record["consecutiveFailures"],
      `${path}.consecutiveFailures`,
      0,
      1_000_000
    ),
    openedAt: ensureNullable(record["openedAt"], (raw) =>
      ensureTimestamp(raw, `${path}.openedAt`)
    ),
    coolDownUntil: ensureNullable(record["coolDownUntil"], (raw) =>
      ensureTimestamp(raw, `${path}.coolDownUntil`)
    ),
    probeInFlight: ensureBoolean(record["probeInFlight"], `${path}.probeInFlight`),
    lastEventAt: ensureNullable(record["lastEventAt"], (raw) =>
      ensureTimestamp(raw, `${path}.lastEventAt`)
    ),
    rememberedEventIds: Object.freeze(rememberedEventIds)
  });
  if (
    (unsigned.phase === "closed" &&
      (unsigned.openedAt !== null || unsigned.coolDownUntil !== null || unsigned.probeInFlight)) ||
    (unsigned.phase === "open" &&
      (unsigned.openedAt === null || unsigned.coolDownUntil === null || unsigned.probeInFlight)) ||
    (unsigned.phase === "half-open" &&
      (unsigned.openedAt === null || unsigned.coolDownUntil === null || !unsigned.probeInFlight))
  ) {
    fail(path, "inconsistent_circuit", "phase metadata is inconsistent.");
  }
  const fingerprint = ensureString(record["fingerprint"], `${path}.fingerprint`, {
    minLength: 64,
    maxLength: 64,
    pattern: HEX_64,
    patternName: "circuit state fingerprint"
  });
  if (circuitBreakerStateFingerprint(unsigned) !== fingerprint) {
    fail(`${path}.fingerprint`, "fingerprint_mismatch", "does not match circuit state.");
  }
  return Object.freeze({ ...unsigned, fingerprint });
}

export function createCircuitBreakerState(identity: CircuitBreakerIdentity): CircuitBreakerState {
  const unsigned = Object.freeze({
    schemaVersion: CIRCUIT_BREAKER_SCHEMA_VERSION,
    algorithmVersion: CIRCUIT_BREAKER_ALGORITHM_VERSION,
    identity: parseIdentity(identity, "circuitIdentity"),
    phase: "closed" as const,
    consecutiveFailures: 0,
    openedAt: null,
    coolDownUntil: null,
    probeInFlight: false,
    lastEventAt: null,
    rememberedEventIds: Object.freeze([] as string[])
  });
  return parseCircuitBreakerState({
    ...unsigned,
    fingerprint: circuitBreakerStateFingerprint(unsigned)
  });
}

export interface CircuitBreakerEvent {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly kind: CircuitEventKind;
  readonly identityFingerprint: string;
}

function parseEvent(value: unknown, path: string): CircuitBreakerEvent {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["eventId", "occurredAt", "kind", "identityFingerprint"], path);
  return Object.freeze({
    eventId: ensureString(record["eventId"], `${path}.eventId`, {
      maxLength: 128,
      pattern: SAFE_ID,
      patternName: "event identifier"
    }),
    occurredAt: ensureTimestamp(record["occurredAt"], `${path}.occurredAt`),
    kind: ensureEnum(record["kind"], `${path}.kind`, CIRCUIT_EVENT_KINDS),
    identityFingerprint: ensureString(
      record["identityFingerprint"],
      `${path}.identityFingerprint`,
      { minLength: 64, maxLength: 64, pattern: HEX_64, patternName: "identity fingerprint" }
    )
  });
}

export type CircuitTransitionCode =
  | "SUCCESS_RECORDED"
  | "FAILURE_RECORDED"
  | "CIRCUIT_OPENED"
  | "PROBE_ADMITTED"
  | "CIRCUIT_CLOSED"
  | "CIRCUIT_REOPENED"
  | "DUPLICATE_EVENT"
  | "OUT_OF_ORDER_EVENT"
  | "EVENT_NOT_APPLICABLE"
  | "IDENTITY_MISMATCH";

export interface CircuitBreakerTransition {
  readonly accepted: boolean;
  readonly code: CircuitTransitionCode;
  readonly priorFingerprint: string;
  readonly state: CircuitBreakerState;
  readonly eventId: string;
  readonly fingerprint: string;
}

function sealState(
  state: Omit<CircuitBreakerState, "fingerprint">,
  maximumRememberedEvents: number
): CircuitBreakerState {
  const remembered = state.rememberedEventIds.slice(-maximumRememberedEvents);
  const unsigned = Object.freeze({ ...state, rememberedEventIds: Object.freeze(remembered) });
  return parseCircuitBreakerState({
    ...unsigned,
    fingerprint: circuitBreakerStateFingerprint(unsigned)
  });
}

function transitionResult(
  accepted: boolean,
  code: CircuitTransitionCode,
  prior: CircuitBreakerState,
  state: CircuitBreakerState,
  eventId: string
): CircuitBreakerTransition {
  const unsigned = Object.freeze({
    accepted,
    code,
    priorFingerprint: prior.fingerprint,
    state,
    eventId
  });
  return Object.freeze({ ...unsigned, fingerprint: digest(unsigned) });
}

export function transitionCircuitBreaker(input: {
  readonly state: CircuitBreakerState | unknown;
  readonly event: CircuitBreakerEvent | unknown;
  readonly configuration: RouterConfiguration;
}): CircuitBreakerTransition {
  const state = parseCircuitBreakerState(input.state);
  const event = parseEvent(input.event, "circuitEvent");
  const identityFingerprint = digest(state.identity);
  if (event.identityFingerprint !== identityFingerprint) {
    return transitionResult(false, "IDENTITY_MISMATCH", state, state, event.eventId);
  }
  if (state.rememberedEventIds.includes(event.eventId)) {
    return transitionResult(true, "DUPLICATE_EVENT", state, state, event.eventId);
  }
  if (state.lastEventAt !== null && event.occurredAt <= state.lastEventAt) {
    return transitionResult(false, "OUT_OF_ORDER_EVENT", state, state, event.eventId);
  }
  const configuration = input.configuration.circuitBreaker;
  const eventIds = Object.freeze([...state.rememberedEventIds, event.eventId]);
  const common = {
    schemaVersion: CIRCUIT_BREAKER_SCHEMA_VERSION,
    algorithmVersion: CIRCUIT_BREAKER_ALGORITHM_VERSION,
    identity: state.identity,
    lastEventAt: event.occurredAt,
    rememberedEventIds: eventIds
  } as const;
  if (event.kind === "admit-probe") {
    if (
      state.phase !== "open" ||
      state.coolDownUntil === null ||
      event.occurredAt < state.coolDownUntil
    ) {
      return transitionResult(false, "EVENT_NOT_APPLICABLE", state, state, event.eventId);
    }
    const next = sealState(
      {
        ...common,
        phase: "half-open",
        consecutiveFailures: state.consecutiveFailures,
        openedAt: state.openedAt,
        coolDownUntil: state.coolDownUntil,
        probeInFlight: true
      },
      configuration.maximumRememberedEvents
    );
    return transitionResult(true, "PROBE_ADMITTED", state, next, event.eventId);
  }
  if (state.phase === "open") {
    return transitionResult(false, "EVENT_NOT_APPLICABLE", state, state, event.eventId);
  }
  if (event.kind === "success") {
    const next = sealState(
      {
        ...common,
        phase: "closed",
        consecutiveFailures: 0,
        openedAt: null,
        coolDownUntil: null,
        probeInFlight: false
      },
      configuration.maximumRememberedEvents
    );
    return transitionResult(
      true,
      state.phase === "half-open" ? "CIRCUIT_CLOSED" : "SUCCESS_RECORDED",
      state,
      next,
      event.eventId
    );
  }
  const nextFailureCount = ensureSafeInteger(
    state.consecutiveFailures + 1,
    "circuit.consecutiveFailures",
    0,
    1_000_000
  );
  const shouldOpen = state.phase === "half-open" || nextFailureCount >= configuration.failureThreshold;
  if (shouldOpen) {
    const coolDownUntil = new Date(
      new Date(event.occurredAt).valueOf() + configuration.coolDownMs
    ).toISOString();
    const next = sealState(
      {
        ...common,
        phase: "open",
        consecutiveFailures: nextFailureCount,
        openedAt: event.occurredAt,
        coolDownUntil,
        probeInFlight: false
      },
      configuration.maximumRememberedEvents
    );
    return transitionResult(
      true,
      state.phase === "half-open" ? "CIRCUIT_REOPENED" : "CIRCUIT_OPENED",
      state,
      next,
      event.eventId
    );
  }
  const next = sealState(
    {
      ...common,
      phase: "closed",
      consecutiveFailures: nextFailureCount,
      openedAt: null,
      coolDownUntil: null,
      probeInFlight: false
    },
    configuration.maximumRememberedEvents
  );
  return transitionResult(true, "FAILURE_RECORDED", state, next, event.eventId);
}

export function circuitIdentityFingerprint(identity: CircuitBreakerIdentity): string {
  return digest(parseIdentity(identity, "circuitIdentity"));
}
