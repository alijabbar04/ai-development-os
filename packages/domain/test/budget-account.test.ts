import { describe, expect, it } from "vitest";
import {
  BudgetExceededError,
  ConcurrencyConflictError,
  InvariantViolationError,
  ValidationError,
  cancelBudgetAccount,
  cancelReservation,
  commitReservation,
  committedTotals,
  createAggregateBudget,
  createBudgetAccount,
  createMoney,
  createUsageAmounts,
  evaluateReservation,
  parseBudgetAccountState,
  parseBudgetScope,
  parseMonetaryBudget,
  parseTimeBudget,
  parseTokenBudget,
  releaseReservation,
  reserveBudget,
  reservedTotals,
  type BudgetAccountState,
} from "../src/index.js";

const SCOPE = parseBudgetScope({ scopeType: "run", scopeId: "run-1" });

const BUDGET = createAggregateBudget({
  tokens: parseTokenBudget({
    maxTotalTokens: 10_000,
    maxInputTokens: 8_000,
    maxOutputTokens: 4_000,
    softMaxTotalTokens: 6_000,
  }),
  money: parseMonetaryBudget({
    limit: createMoney("GBP", 1_000_000),
    softLimit: createMoney("GBP", 500_000),
  }),
  time: parseTimeBudget({ maxDurationMs: 60_000, softMaxDurationMs: 30_000 }),
});

const T0 = "2026-08-02T09:00:00.000Z";
const T1 = "2026-08-02T09:05:00.000Z";

const smallEstimate = createUsageAmounts({
  tokens: { inputTokens: 1_000, outputTokens: 500 },
  cost: createMoney("GBP", 100_000),
  durationMs: 5_000,
});

function accountWithHold(): BudgetAccountState {
  return reserveBudget(createBudgetAccount({ scope: SCOPE, budget: BUDGET }), {
    reservationId: "res-1",
    estimate: smallEstimate,
    requestedAt: T0,
  });
}

describe("budget account creation and hydration", () => {
  it("creates an open, versioned, frozen account", () => {
    const account = createBudgetAccount({ scope: SCOPE, budget: BUDGET });
    expect(account.status).toBe("open");
    expect(account.version).toBe(0);
    expect(account.reservations).toEqual([]);
    expect(Object.isFrozen(account)).toBe(true);
  });

  it("round-trips through JSON", () => {
    const account = accountWithHold();
    const revived = parseBudgetAccountState(JSON.parse(JSON.stringify(account)));
    expect(revived).toEqual(account);
  });

  it("rejects hostile snapshots", () => {
    const account = accountWithHold();
    const plain = JSON.parse(JSON.stringify(account)) as Record<string, unknown>;

    expect(() => parseBudgetAccountState({ ...plain, schemaVersion: 99 })).toThrow(
      ValidationError,
    );
    expect(() => parseBudgetAccountState({ ...plain, version: -1 })).toThrow(ValidationError);
    expect(() => parseBudgetAccountState({ ...plain, status: "paused" })).toThrow(ValidationError);
    expect(() => parseBudgetAccountState({ ...plain, reservations: "none" })).toThrow(
      ValidationError,
    );

    const reservations = plain["reservations"] as ReadonlyArray<Record<string, unknown>>;
    const reservation = reservations[0] as Record<string, unknown>;
    expect(() =>
      parseBudgetAccountState({ ...plain, reservations: [reservation, reservation] }),
    ).toThrow(ValidationError);
    expect(() =>
      parseBudgetAccountState({
        ...plain,
        reservations: [{ ...reservation, status: "committed" }],
      }),
    ).toThrow(ValidationError);
    expect(() =>
      parseBudgetAccountState({
        ...plain,
        reservations: [{ ...reservation, settledAt: T1 }],
      }),
    ).toThrow(ValidationError);
    expect(() =>
      parseBudgetAccountState({
        ...plain,
        reservations: [
          {
            ...reservation,
            estimate: { ...smallEstimate, cost: createMoney("USD", 1) },
          },
        ],
      }),
    ).toThrow(ValidationError);
  });
});

describe("reservation lifecycle", () => {
  it("reserves, tracks held totals, and bumps the version", () => {
    const account = accountWithHold();
    expect(account.version).toBe(1);
    expect(reservedTotals(account).tokens.inputTokens).toBe(1_000);
    expect(committedTotals(account)).toMatchObject({ durationMs: 0 });
  });

  it("is idempotent for an identical replayed reserve command", () => {
    const account = accountWithHold();
    const replayed = reserveBudget(account, {
      reservationId: "res-1",
      estimate: smallEstimate,
      requestedAt: T0,
    });
    expect(replayed).toBe(account);
  });

  it("rejects a conflicting reserve with a reused id", () => {
    const account = accountWithHold();
    expect(() =>
      reserveBudget(account, {
        reservationId: "res-1",
        estimate: createUsageAmounts({ tokens: { inputTokens: 1 } }),
        requestedAt: T0,
      }),
    ).toThrow(InvariantViolationError);
  });

  it("commits actual usage, moving it from reserved to committed", () => {
    const actual = createUsageAmounts({
      tokens: { inputTokens: 900, outputTokens: 400 },
      cost: createMoney("GBP", 90_000),
      durationMs: 4_000,
    });
    const account = commitReservation(accountWithHold(), {
      reservationId: "res-1",
      actual,
      settledAt: T1,
    });
    expect(reservedTotals(account).tokens.inputTokens).toBe(0);
    expect(committedTotals(account).tokens.inputTokens).toBe(900);
    expect(committedTotals(account).cost?.amountMicros).toBe(90_000);
    expect(account.version).toBe(2);
  });

  it("prevents double commit with different usage but acknowledges identical commits", () => {
    const actual = createUsageAmounts({ tokens: { inputTokens: 10 } });
    const committed = commitReservation(accountWithHold(), {
      reservationId: "res-1",
      actual,
      settledAt: T1,
    });

    const replayed = commitReservation(committed, {
      reservationId: "res-1",
      actual,
      settledAt: T1,
    });
    expect(replayed).toBe(committed);

    expect(() =>
      commitReservation(committed, {
        reservationId: "res-1",
        actual: createUsageAmounts({ tokens: { inputTokens: 11 } }),
        settledAt: T1,
      }),
    ).toThrow(InvariantViolationError);
    expect(() =>
      commitReservation(committed, { reservationId: "res-1", actual, settledAt: T0 }),
    ).toThrow(InvariantViolationError);
  });

  it("releases unused holds and prevents over-release", () => {
    const released = releaseReservation(accountWithHold(), {
      reservationId: "res-1",
      settledAt: T1,
    });
    expect(reservedTotals(released).tokens.inputTokens).toBe(0);

    const replayed = releaseReservation(released, { reservationId: "res-1", settledAt: T1 });
    expect(replayed).toBe(released);

    expect(() =>
      releaseReservation(released, { reservationId: "res-1", settledAt: T0 }),
    ).toThrow(InvariantViolationError);

    const committed = commitReservation(accountWithHold(), {
      reservationId: "res-1",
      actual: smallEstimate,
      settledAt: T1,
    });
    expect(() =>
      releaseReservation(committed, { reservationId: "res-1", settledAt: T1 }),
    ).toThrow(InvariantViolationError);
  });

  it("cancels a hold and refuses to commit a cancelled reservation", () => {
    const cancelled = cancelReservation(accountWithHold(), {
      reservationId: "res-1",
      settledAt: T1,
    });
    expect(cancelReservation(cancelled, { reservationId: "res-1", settledAt: T1 })).toBe(
      cancelled,
    );
    expect(() =>
      commitReservation(cancelled, {
        reservationId: "res-1",
        actual: smallEstimate,
        settledAt: T1,
      }),
    ).toThrow(InvariantViolationError);
  });

  it("rejects operations on unknown reservations", () => {
    const account = accountWithHold();
    expect(() =>
      commitReservation(account, { reservationId: "ghost", actual: smallEstimate, settledAt: T1 }),
    ).toThrow(InvariantViolationError);
    expect(() =>
      releaseReservation(account, { reservationId: "ghost", settledAt: T1 }),
    ).toThrow(InvariantViolationError);
    expect(() => reserveBudget(account, { reservationId: "!bad!", estimate: smallEstimate, requestedAt: T0 })).toThrow(
      ValidationError,
    );
  });
});

describe("budget enforcement", () => {
  it("evaluates soft breaches as warnings and hard breaches as denial", () => {
    const account = createBudgetAccount({ scope: SCOPE, budget: BUDGET });

    const soft = evaluateReservation(
      account,
      createUsageAmounts({
        tokens: { inputTokens: 6_500 },
        cost: createMoney("GBP", 600_000),
        durationMs: 40_000,
      }),
    );
    expect(soft.allowed).toBe(true);
    expect(soft.breaches.every((breach) => breach.severity === "soft")).toBe(true);
    expect(soft.breaches.map((breach) => breach.dimension)).toEqual([
      "total-tokens",
      "money",
      "duration",
    ]);
    expect(soft.reasons).toHaveLength(3);

    const hard = evaluateReservation(
      account,
      createUsageAmounts({
        tokens: { inputTokens: 9_000, outputTokens: 5_000 },
        cost: createMoney("GBP", 2_000_000),
        durationMs: 100_000,
      }),
    );
    expect(hard.allowed).toBe(false);
    expect(hard.breaches.filter((breach) => breach.severity === "hard").map((b) => b.dimension))
      .toEqual(["input-tokens", "output-tokens", "total-tokens", "money", "duration"]);
    const moneyBreach = hard.breaches.find(
      (breach) => breach.dimension === "money" && breach.severity === "hard",
    );
    expect(moneyBreach?.currency).toBe("GBP");
    expect(moneyBreach?.limit).toBe(1_000_000);
  });

  it("throws BudgetExceededError with the structured decision on hard breach", () => {
    const account = createBudgetAccount({ scope: SCOPE, budget: BUDGET });
    try {
      reserveBudget(account, {
        reservationId: "res-big",
        estimate: createUsageAmounts({ cost: createMoney("GBP", 2_000_000) }),
        requestedAt: T0,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BudgetExceededError);
      const decision = (error as BudgetExceededError).decision;
      expect(decision.allowed).toBe(false);
      expect(decision.breaches.some((breach) => breach.dimension === "money")).toBe(true);
      expect((error as BudgetExceededError).code).toBe("BUDGET_EXCEEDED");
    }
  });

  it("counts held and committed usage toward new reservations", () => {
    let account = accountWithHold();
    account = commitReservation(account, {
      reservationId: "res-1",
      actual: createUsageAmounts({ cost: createMoney("GBP", 900_000) }),
      settledAt: T1,
    });
    expect(() =>
      reserveBudget(account, {
        reservationId: "res-2",
        estimate: createUsageAmounts({ cost: createMoney("GBP", 200_000) }),
        requestedAt: T1,
      }),
    ).toThrow(BudgetExceededError);

    const allowed = reserveBudget(account, {
      reservationId: "res-3",
      estimate: createUsageAmounts({ cost: createMoney("GBP", 50_000) }),
      requestedAt: T1,
    });
    expect(allowed.reservations).toHaveLength(2);
  });

  it("rejects estimates in a different currency than the budget", () => {
    const account = createBudgetAccount({ scope: SCOPE, budget: BUDGET });
    expect(() =>
      evaluateReservation(account, createUsageAmounts({ cost: createMoney("USD", 1) })),
    ).toThrow(ValidationError);
  });
});

describe("concurrency and cancellation", () => {
  it("enforces expectedVersion on every mutation", () => {
    const account = accountWithHold();
    expect(() =>
      reserveBudget(account, {
        reservationId: "res-2",
        estimate: smallEstimate,
        requestedAt: T0,
        expectedVersion: 0,
      }),
    ).toThrow(ConcurrencyConflictError);
    expect(() =>
      commitReservation(account, {
        reservationId: "res-1",
        actual: smallEstimate,
        settledAt: T1,
        expectedVersion: 5,
      }),
    ).toThrow(ConcurrencyConflictError);
    expect(() =>
      cancelBudgetAccount(account, { cancelledAt: T1, expectedVersion: 9 }),
    ).toThrow(ConcurrencyConflictError);

    const committed = commitReservation(account, {
      reservationId: "res-1",
      actual: smallEstimate,
      settledAt: T1,
      expectedVersion: 1,
    });
    expect(committed.version).toBe(2);
  });

  it("cancelling the account cancels holds, blocks new reservations, allows commits", () => {
    let account = accountWithHold();
    account = reserveBudget(account, {
      reservationId: "res-2",
      estimate: createUsageAmounts({ tokens: { outputTokens: 5 } }),
      requestedAt: T0,
    });

    const cancelled = cancelBudgetAccount(account, { cancelledAt: T1 });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.reservations.every((r) => r.status === "cancelled")).toBe(true);
    expect(cancelBudgetAccount(cancelled, { cancelledAt: T1 })).toBe(cancelled);

    expect(() =>
      reserveBudget(cancelled, {
        reservationId: "res-3",
        estimate: smallEstimate,
        requestedAt: T1,
      }),
    ).toThrow(InvariantViolationError);

    const committedBeforeCancel = commitReservation(accountWithHold(), {
      reservationId: "res-1",
      actual: smallEstimate,
      settledAt: T0,
    });
    const cancelledAfterCommit = cancelBudgetAccount(committedBeforeCancel, { cancelledAt: T1 });
    expect(cancelledAfterCommit.reservations[0]?.status).toBe("committed");
  });
});
