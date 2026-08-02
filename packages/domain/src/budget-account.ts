import {
  ConcurrencyConflictError,
  DomainError,
  InvariantViolationError,
} from "./errors.js";
import {
  ensureEnum,
  ensureExactKeys,
  ensureNullable,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
  ensureString,
  ensureTimestamp,
  fail,
} from "./internal/guards.js";
import {
  addUsageAmounts,
  parseAggregateBudget,
  parseBudgetScope,
  parseUsageAmounts,
  totalTokens,
  usageAmountsEqual,
  ZERO_USAGE,
  type AggregateBudget,
  type BudgetScope,
  type CurrencyCode,
  type UsageAmounts,
} from "./budget.js";

export const BUDGET_ACCOUNT_SCHEMA_VERSION = 1 as const;

export const MAX_RESERVATIONS_PER_ACCOUNT = 10_000;

export const RESERVATION_STATUSES = Object.freeze(["held", "committed", "released", "cancelled"] as const);
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const BUDGET_ACCOUNT_STATUSES = Object.freeze(["open", "cancelled"] as const);
export type BudgetAccountStatus = (typeof BUDGET_ACCOUNT_STATUSES)[number];

export const BUDGET_DIMENSIONS = Object.freeze([
  "input-tokens",
  "output-tokens",
  "total-tokens",
  "money",
  "duration",
] as const);
export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number];

export interface LimitBreach {
  readonly dimension: BudgetDimension;
  readonly severity: "hard" | "soft";
  /** Micro-units for "money", token counts for token dimensions, milliseconds for "duration". */
  readonly limit: number;
  readonly attempted: number;
  readonly currency: CurrencyCode | null;
}

export interface BudgetDecision {
  readonly allowed: boolean;
  readonly breaches: readonly LimitBreach[];
  readonly reasons: readonly string[];
}

export class BudgetExceededError extends DomainError {
  readonly decision: BudgetDecision;

  constructor(message: string, decision: BudgetDecision) {
    super("BUDGET_EXCEEDED", message, {
      breachedDimensions: Object.freeze(decision.breaches.map((breach) => breach.dimension)),
    });
    this.name = "BudgetExceededError";
    this.decision = decision;
  }
}

const RESERVATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface BudgetReservation {
  readonly id: string;
  readonly status: ReservationStatus;
  readonly estimate: UsageAmounts;
  readonly actual: UsageAmounts | null;
  readonly createdAt: string;
  readonly settledAt: string | null;
}

export interface BudgetAccountState {
  readonly schemaVersion: typeof BUDGET_ACCOUNT_SCHEMA_VERSION;
  readonly scope: BudgetScope;
  readonly budget: AggregateBudget;
  readonly status: BudgetAccountStatus;
  /** Optimistic concurrency token; incremented by every effective mutation. */
  readonly version: number;
  readonly reservations: readonly BudgetReservation[];
}

function parseReservationId(value: unknown, path: string): string {
  return ensureString(value, path, {
    maxLength: 128,
    pattern: RESERVATION_ID_PATTERN,
    patternName: "reservation identifier",
  });
}

function parseReservation(value: unknown, path: string): BudgetReservation {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["id", "status", "estimate", "actual", "createdAt", "settledAt"], path);

  const status = ensureEnum(record["status"], `${path}.status`, RESERVATION_STATUSES);
  const actual = ensureNullable(record["actual"], (actualValue) =>
    parseUsageAmounts(actualValue, `${path}.actual`),
  );
  const settledAt = ensureNullable(record["settledAt"], (settledValue) =>
    ensureTimestamp(settledValue, `${path}.settledAt`),
  );

  if (status === "held" && (actual !== null || settledAt !== null)) {
    fail(`${path}.status`, "inconsistent_reservation", "held reservations cannot carry actual usage or a settlement time.");
  }
  if (status !== "held" && settledAt === null) {
    fail(`${path}.settledAt`, "inconsistent_reservation", "settled reservations must carry a settlement time.");
  }
  if (status === "committed" && actual === null) {
    fail(`${path}.actual`, "inconsistent_reservation", "committed reservations must carry actual usage.");
  }
  if ((status === "released" || status === "cancelled") && actual !== null) {
    fail(`${path}.actual`, "inconsistent_reservation", `${status} reservations cannot carry actual usage.`);
  }

  return Object.freeze({
    id: parseReservationId(record["id"], `${path}.id`),
    status,
    estimate: parseUsageAmounts(record["estimate"], `${path}.estimate`),
    actual,
    createdAt: ensureTimestamp(record["createdAt"], `${path}.createdAt`),
    settledAt,
  });
}

export function parseBudgetAccountState(
  value: unknown,
  path = "budgetAccount",
): BudgetAccountState {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["schemaVersion", "scope", "budget", "status", "version", "reservations"], path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, BUDGET_ACCOUNT_SCHEMA_VERSION);

  const reservationsValue = record["reservations"];
  if (!Array.isArray(reservationsValue) || reservationsValue.length > MAX_RESERVATIONS_PER_ACCOUNT) {
    fail(`${path}.reservations`, "bad_reservations", `must be an array of at most ${MAX_RESERVATIONS_PER_ACCOUNT} reservations.`);
  }

  const budget = parseAggregateBudget(record["budget"], `${path}.budget`);
  const seen = new Set<string>();
  const reservations = reservationsValue.map((entry, index) => {
    const reservation = parseReservation(entry, `${path}.reservations[${index}]`);
    if (seen.has(reservation.id)) {
      fail(`${path}.reservations[${index}].id`, "duplicate_reservation", "duplicates another reservation id.");
    }
    seen.add(reservation.id);
    assertCurrencyMatchesBudget(budget, reservation.estimate, `${path}.reservations[${index}].estimate`);
    if (reservation.actual !== null) {
      assertCurrencyMatchesBudget(budget, reservation.actual, `${path}.reservations[${index}].actual`);
    }
    return reservation;
  });

  return Object.freeze({
    schemaVersion: BUDGET_ACCOUNT_SCHEMA_VERSION,
    scope: parseBudgetScope(record["scope"], `${path}.scope`),
    budget,
    status: ensureEnum(record["status"], `${path}.status`, BUDGET_ACCOUNT_STATUSES),
    version: ensureSafeInteger(record["version"], `${path}.version`, 0, Number.MAX_SAFE_INTEGER),
    reservations: Object.freeze(reservations),
  });
}

function assertCurrencyMatchesBudget(
  budget: AggregateBudget,
  amounts: UsageAmounts,
  path: string,
): void {
  if (budget.money !== null && amounts.cost !== null && amounts.cost.currency !== budget.money.limit.currency) {
    fail(`${path}.cost.currency`, "currency_mismatch", "must match the budget currency.");
  }
}

export function createBudgetAccount(input: {
  readonly scope: BudgetScope;
  readonly budget: AggregateBudget;
}): BudgetAccountState {
  return parseBudgetAccountState({
    schemaVersion: BUDGET_ACCOUNT_SCHEMA_VERSION,
    scope: input.scope,
    budget: input.budget,
    status: "open",
    version: 0,
    reservations: [],
  });
}

/** Sum of estimates still held against the budget. */
export function reservedTotals(state: BudgetAccountState): UsageAmounts {
  return state.reservations
    .filter((reservation) => reservation.status === "held")
    .reduce((sum, reservation) => addUsageAmounts(sum, reservation.estimate), ZERO_USAGE);
}

/** Sum of committed actual usage. */
export function committedTotals(state: BudgetAccountState): UsageAmounts {
  return state.reservations
    .filter((reservation) => reservation.status === "committed")
    .reduce(
      (sum, reservation) => addUsageAmounts(sum, reservation.actual ?? ZERO_USAGE),
      ZERO_USAGE,
    );
}

function collectBreaches(
  budget: AggregateBudget,
  prospective: UsageAmounts,
): readonly LimitBreach[] {
  const breaches: LimitBreach[] = [];

  const push = (
    dimension: BudgetDimension,
    severity: "hard" | "soft",
    limit: number,
    attempted: number,
    currency: CurrencyCode | null = null,
  ): void => {
    if (attempted > limit) {
      breaches.push(Object.freeze({ dimension, severity, limit, attempted, currency }));
    }
  };

  if (budget.tokens !== null) {
    const inputTotal = prospective.tokens.inputTokens + prospective.tokens.cachedInputTokens;
    const outputTotal = prospective.tokens.outputTokens + prospective.tokens.reasoningTokens;
    if (budget.tokens.maxInputTokens !== null) {
      push("input-tokens", "hard", budget.tokens.maxInputTokens, inputTotal);
    }
    if (budget.tokens.maxOutputTokens !== null) {
      push("output-tokens", "hard", budget.tokens.maxOutputTokens, outputTotal);
    }
    push("total-tokens", "hard", budget.tokens.maxTotalTokens, totalTokens(prospective.tokens));
    if (budget.tokens.softMaxTotalTokens !== null) {
      push("total-tokens", "soft", budget.tokens.softMaxTotalTokens, totalTokens(prospective.tokens));
    }
  }

  if (budget.money !== null && prospective.cost !== null) {
    push(
      "money",
      "hard",
      budget.money.limit.amountMicros,
      prospective.cost.amountMicros,
      budget.money.limit.currency,
    );
    if (budget.money.softLimit !== null) {
      push(
        "money",
        "soft",
        budget.money.softLimit.amountMicros,
        prospective.cost.amountMicros,
        budget.money.softLimit.currency,
      );
    }
  }

  if (budget.time !== null) {
    push("duration", "hard", budget.time.maxDurationMs, prospective.durationMs);
    if (budget.time.softMaxDurationMs !== null) {
      push("duration", "soft", budget.time.softMaxDurationMs, prospective.durationMs);
    }
  }

  return Object.freeze(breaches);
}

/**
 * Non-throwing admission check: would reserving `estimate` on top of all held
 * and committed usage breach the budget? Soft breaches warn; hard breaches deny.
 */
export function evaluateReservation(
  state: BudgetAccountState,
  estimate: UsageAmounts,
): BudgetDecision {
  const parsedEstimate = parseUsageAmounts(estimate, "estimate");
  assertCurrencyMatchesBudget(state.budget, parsedEstimate, "estimate");
  const prospective = addUsageAmounts(
    addUsageAmounts(reservedTotals(state), committedTotals(state)),
    parsedEstimate,
  );
  const breaches = collectBreaches(state.budget, prospective);
  const hard = breaches.filter((breach) => breach.severity === "hard");
  return Object.freeze({
    allowed: hard.length === 0,
    breaches,
    reasons: Object.freeze(
      breaches.map(
        (breach) =>
          `${breach.severity} ${breach.dimension} limit ${breach.limit} exceeded by attempted ${breach.attempted}.`,
      ),
    ),
  });
}

function checkVersion(state: BudgetAccountState, expectedVersion: number | undefined): void {
  if (expectedVersion !== undefined && expectedVersion !== state.version) {
    throw new ConcurrencyConflictError("Budget account version mismatch.", {
      expected: expectedVersion,
      actual: state.version,
    });
  }
}

function findReservation(
  state: BudgetAccountState,
  reservationId: string,
): BudgetReservation | undefined {
  return state.reservations.find((reservation) => reservation.id === reservationId);
}

function withReservation(
  state: BudgetAccountState,
  next: BudgetReservation,
): BudgetAccountState {
  return Object.freeze({
    ...state,
    version: state.version + 1,
    reservations: Object.freeze(
      state.reservations.map((reservation) => (reservation.id === next.id ? next : reservation)),
    ),
  });
}

export interface ReserveCommand {
  readonly reservationId: string;
  readonly estimate: UsageAmounts;
  readonly requestedAt: string;
  readonly expectedVersion?: number;
}

/**
 * Places a hold for estimated usage. Throws BudgetExceededError when a hard
 * limit would be breached. Replaying an identical reserve command is
 * idempotent and returns the state unchanged.
 */
export function reserveBudget(
  state: BudgetAccountState,
  command: ReserveCommand,
): BudgetAccountState {
  const reservationId = parseReservationId(command.reservationId, "reserve.reservationId");
  const estimate = parseUsageAmounts(command.estimate, "reserve.estimate");
  const requestedAt = ensureTimestamp(command.requestedAt, "reserve.requestedAt");
  checkVersion(state, command.expectedVersion);

  const existing = findReservation(state, reservationId);
  if (existing !== undefined) {
    if (
      existing.status === "held" &&
      usageAmountsEqual(existing.estimate, estimate) &&
      existing.createdAt === requestedAt
    ) {
      return state;
    }
    throw new InvariantViolationError("Reservation id already exists with different content.", {
      reservationId,
      status: existing.status,
    });
  }

  if (state.status !== "open") {
    throw new InvariantViolationError("Cannot reserve budget on a cancelled account.", {
      status: state.status,
    });
  }
  if (state.reservations.length >= MAX_RESERVATIONS_PER_ACCOUNT) {
    throw new InvariantViolationError("Reservation limit reached for this budget account.", {
      maximum: MAX_RESERVATIONS_PER_ACCOUNT,
    });
  }

  const decision = evaluateReservation(state, estimate);
  if (!decision.allowed) {
    throw new BudgetExceededError("Reservation denied: hard budget limit exceeded.", decision);
  }

  const reservation: BudgetReservation = Object.freeze({
    id: reservationId,
    status: "held",
    estimate,
    actual: null,
    createdAt: requestedAt,
    settledAt: null,
  });

  return Object.freeze({
    ...state,
    version: state.version + 1,
    reservations: Object.freeze([...state.reservations, reservation]),
  });
}

export interface CommitCommand {
  readonly reservationId: string;
  readonly actual: UsageAmounts;
  readonly settledAt: string;
  readonly expectedVersion?: number;
}

/**
 * Settles a held reservation with actual usage. Committing twice with
 * identical actual usage is an idempotent acknowledgement; committing with
 * different usage, or committing a released/cancelled reservation, throws.
 * Commits are accepted even after account cancellation so in-flight work can
 * still be accounted for exactly.
 */
export function commitReservation(
  state: BudgetAccountState,
  command: CommitCommand,
): BudgetAccountState {
  const reservationId = parseReservationId(command.reservationId, "commit.reservationId");
  const actual = parseUsageAmounts(command.actual, "commit.actual");
  const settledAt = ensureTimestamp(command.settledAt, "commit.settledAt");
  assertCurrencyMatchesBudget(state.budget, actual, "commit.actual");
  checkVersion(state, command.expectedVersion);

  const existing = findReservation(state, reservationId);
  if (existing === undefined) {
    throw new InvariantViolationError("Cannot commit an unknown reservation.", { reservationId });
  }
  if (existing.status === "committed") {
    if (
      existing.actual !== null &&
      usageAmountsEqual(existing.actual, actual) &&
      existing.settledAt === settledAt
    ) {
      return state;
    }
    throw new InvariantViolationError("Reservation is already committed with different usage.", {
      reservationId,
    });
  }
  if (existing.status !== "held") {
    throw new InvariantViolationError(`Cannot commit a ${existing.status} reservation.`, {
      reservationId,
      status: existing.status,
    });
  }

  return withReservation(state, Object.freeze({ ...existing, status: "committed", actual, settledAt }));
}

export interface SettleCommand {
  readonly reservationId: string;
  readonly settledAt: string;
  readonly expectedVersion?: number;
}

function settleWithoutUsage(
  state: BudgetAccountState,
  command: SettleCommand,
  terminalStatus: "released" | "cancelled",
  operation: string,
): BudgetAccountState {
  const reservationId = parseReservationId(command.reservationId, `${operation}.reservationId`);
  const settledAt = ensureTimestamp(command.settledAt, `${operation}.settledAt`);
  checkVersion(state, command.expectedVersion);

  const existing = findReservation(state, reservationId);
  if (existing === undefined) {
    throw new InvariantViolationError(`Cannot ${operation} an unknown reservation.`, {
      reservationId,
    });
  }
  if (existing.status === terminalStatus) {
    if (existing.settledAt === settledAt) {
      return state;
    }
    throw new InvariantViolationError(
      `Reservation is already ${terminalStatus} at a different time.`,
      { reservationId },
    );
  }
  if (existing.status !== "held") {
    throw new InvariantViolationError(`Cannot ${operation} a ${existing.status} reservation.`, {
      reservationId,
      status: existing.status,
    });
  }

  return withReservation(
    state,
    Object.freeze({ ...existing, status: terminalStatus, settledAt }),
  );
}

/** Frees an unused hold. Releasing a committed reservation (over-release) throws. */
export function releaseReservation(
  state: BudgetAccountState,
  command: SettleCommand,
): BudgetAccountState {
  return settleWithoutUsage(state, command, "released", "release");
}

/** Cancels a held reservation, freeing its hold. */
export function cancelReservation(
  state: BudgetAccountState,
  command: SettleCommand,
): BudgetAccountState {
  return settleWithoutUsage(state, command, "cancelled", "cancel");
}

export interface CancelAccountCommand {
  readonly cancelledAt: string;
  readonly expectedVersion?: number;
}

/**
 * Cancels the account: all held reservations become cancelled and no new
 * reservations are accepted. Idempotent when repeated.
 */
export function cancelBudgetAccount(
  state: BudgetAccountState,
  command: CancelAccountCommand,
): BudgetAccountState {
  const cancelledAt = ensureTimestamp(command.cancelledAt, "cancelAccount.cancelledAt");
  checkVersion(state, command.expectedVersion);

  if (state.status === "cancelled") {
    return state;
  }

  return Object.freeze({
    ...state,
    status: "cancelled" as const,
    version: state.version + 1,
    reservations: Object.freeze(
      state.reservations.map((reservation) =>
        reservation.status === "held"
          ? Object.freeze({ ...reservation, status: "cancelled" as const, settledAt: cancelledAt })
          : reservation,
      ),
    ),
  });
}
