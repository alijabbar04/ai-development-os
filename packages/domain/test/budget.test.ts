import { describe, expect, it } from "vitest";
import {
  InvariantViolationError,
  MAX_MONEY_MICROS,
  ValidationError,
  ZERO_TOKEN_USAGE,
  ZERO_USAGE,
  addMoney,
  addTokenUsage,
  addUsageAmounts,
  compareMoney,
  createAggregateBudget,
  createMoney,
  createTokenUsage,
  createUsageAmounts,
  createUsageRecord,
  moneyEquals,
  parseAggregateBudget,
  parseBudgetScope,
  parseCurrencyCode,
  parseMoney,
  parseMonetaryBudget,
  parseTimeBudget,
  parseTokenBudget,
  parseTokenUsage,
  parseUsageAmounts,
  parseUsageRecord,
  subtractMoney,
  summarizeUsage,
  totalTokens,
  usageAmountsEqual,
  zeroMoney,
  type UsageRecord,
} from "../src/index.js";

const GBP = parseCurrencyCode("GBP");

describe("Money", () => {
  it("creates exact integer-micro money and freezes it", () => {
    const money = createMoney("GBP", 1_500_000);
    expect(money).toEqual({ currency: "GBP", amountMicros: 1_500_000 });
    expect(Object.isFrozen(money)).toBe(true);
    expect(zeroMoney(GBP).amountMicros).toBe(0);
  });

  it("rejects floating-point, negative, non-finite, and hostile amounts", () => {
    expect(() => createMoney("GBP", 1.5)).toThrow(ValidationError);
    expect(() => createMoney("GBP", -1)).toThrow(ValidationError);
    expect(() => createMoney("GBP", Number.NaN)).toThrow(ValidationError);
    expect(() => createMoney("GBP", Number.POSITIVE_INFINITY)).toThrow(ValidationError);
    expect(() => createMoney("GBP", Number.MAX_SAFE_INTEGER + 2)).toThrow(ValidationError);
    expect(() => createMoney("gbp", 1)).toThrow(ValidationError);
    expect(() => createMoney("GBPX", 1)).toThrow(ValidationError);
    expect(() => parseMoney({ currency: "GBP", amountMicros: 1, extra: true })).toThrow(
      ValidationError,
    );
    expect(() => parseMoney("money" as unknown)).toThrow(ValidationError);
  });

  it("normalizes -0 to 0", () => {
    expect(Object.is(createMoney("GBP", -0).amountMicros, 0)).toBe(true);
  });

  it("adds, subtracts, and compares deterministically", () => {
    const a = createMoney("GBP", 100);
    const b = createMoney("GBP", 250);
    expect(addMoney(a, b).amountMicros).toBe(350);
    expect(subtractMoney(b, a).amountMicros).toBe(150);
    expect(compareMoney(a, b)).toBe(-1);
    expect(compareMoney(b, a)).toBe(1);
    expect(compareMoney(a, createMoney("GBP", 100))).toBe(0);
    expect(moneyEquals(a, createMoney("GBP", 100))).toBe(true);
    expect(moneyEquals(a, b)).toBe(false);
    expect(moneyEquals(a, createMoney("USD", 100))).toBe(false);
  });

  it("refuses cross-currency arithmetic", () => {
    const gbp = createMoney("GBP", 100);
    const usd = createMoney("USD", 100);
    expect(() => addMoney(gbp, usd)).toThrow(InvariantViolationError);
    expect(() => subtractMoney(gbp, usd)).toThrow(InvariantViolationError);
    expect(() => compareMoney(gbp, usd)).toThrow(InvariantViolationError);
  });

  it("never overflows silently and never goes negative", () => {
    const nearMax = createMoney("GBP", MAX_MONEY_MICROS - 1);
    expect(() => addMoney(nearMax, createMoney("GBP", 2))).toThrow(InvariantViolationError);
    expect(() => subtractMoney(createMoney("GBP", 1), createMoney("GBP", 2))).toThrow(
      InvariantViolationError,
    );
  });

  it("keeps addition exact across a seeded pseudo-random sweep", () => {
    let seed = 20260802;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let round = 0; round < 500; round += 1) {
      const a = next();
      const b = next();
      const sum = addMoney(createMoney("GBP", a), createMoney("GBP", b));
      expect(sum.amountMicros).toBe(a + b);
      expect(Number.isSafeInteger(sum.amountMicros)).toBe(true);
      expect(subtractMoney(sum, createMoney("GBP", b)).amountMicros).toBe(a);
    }
  });
});

describe("TokenUsage", () => {
  it("defaults categories to zero and freezes the result", () => {
    expect(createTokenUsage()).toEqual(ZERO_TOKEN_USAGE);
    const usage = createTokenUsage({ inputTokens: 10, outputTokens: 5 });
    expect(totalTokens(usage)).toBe(15);
    expect(Object.isFrozen(usage)).toBe(true);
  });

  it("rejects negatives, floats, and unexpected fields", () => {
    expect(() => parseTokenUsage({ ...ZERO_TOKEN_USAGE, inputTokens: -1 })).toThrow(
      ValidationError,
    );
    expect(() => parseTokenUsage({ ...ZERO_TOKEN_USAGE, outputTokens: 0.5 })).toThrow(
      ValidationError,
    );
    expect(() => parseTokenUsage({ ...ZERO_TOKEN_USAGE, bonus: 1 })).toThrow(ValidationError);
  });

  it("adds with overflow protection", () => {
    const big = createTokenUsage({ inputTokens: 1_000_000_000_000 });
    const sum = addTokenUsage(big, big);
    expect(sum.inputTokens).toBe(2_000_000_000_000);
  });
});

describe("budgets", () => {
  it("parses token, monetary, time, and aggregate budgets", () => {
    const budget = createAggregateBudget({
      tokens: parseTokenBudget({
        maxTotalTokens: 100_000,
        maxInputTokens: 80_000,
        maxOutputTokens: 20_000,
        softMaxTotalTokens: 90_000,
      }),
      money: parseMonetaryBudget({
        limit: createMoney("GBP", 5_000_000),
        softLimit: createMoney("GBP", 4_000_000),
      }),
      time: parseTimeBudget({ maxDurationMs: 600_000, softMaxDurationMs: 300_000 }),
    });
    expect(budget.tokens?.maxTotalTokens).toBe(100_000);
    expect(budget.money?.limit.amountMicros).toBe(5_000_000);
    expect(budget.time?.softMaxDurationMs).toBe(300_000);
  });

  it("rejects an empty aggregate budget and soft limits above hard limits", () => {
    expect(() => parseAggregateBudget({ tokens: null, money: null, time: null })).toThrow(
      ValidationError,
    );
    expect(() =>
      parseMonetaryBudget({
        limit: createMoney("GBP", 100),
        softLimit: createMoney("GBP", 200),
      }),
    ).toThrow(ValidationError);
    expect(() =>
      parseMonetaryBudget({
        limit: createMoney("GBP", 100),
        softLimit: createMoney("USD", 50),
      }),
    ).toThrow(ValidationError);
    expect(() =>
      parseTokenBudget({
        maxTotalTokens: 1_000,
        maxInputTokens: 2_000,
        maxOutputTokens: null,
        softMaxTotalTokens: null,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      parseTimeBudget({ maxDurationMs: 1_000, softMaxDurationMs: 2_000 }),
    ).toThrow(ValidationError);
  });
});

describe("usage records", () => {
  const RECORD_INPUT = {
    kind: "actual",
    scope: parseBudgetScope({ scopeType: "task", scopeId: "task-1" }),
    amounts: createUsageAmounts({
      tokens: { inputTokens: 100, outputTokens: 50 },
      cost: createMoney("GBP", 2_000),
      durationMs: 1_500,
    }),
    recordedAt: "2026-08-02T10:00:00.000Z",
    traceId: "trace-1",
  } as const;

  it("creates immutable records and round-trips through JSON", () => {
    const record = createUsageRecord(RECORD_INPUT);
    expect(record.schemaVersion).toBe(1);
    expect(Object.isFrozen(record)).toBe(true);
    const revived = parseUsageRecord(JSON.parse(JSON.stringify(record)));
    expect(revived).toEqual(record);
  });

  it("rejects invalid timestamps, scopes, and unknown schema versions", () => {
    expect(() =>
      createUsageRecord({ ...RECORD_INPUT, recordedAt: "02/08/2026" }),
    ).toThrow(ValidationError);
    expect(() =>
      createUsageRecord({ ...RECORD_INPUT, recordedAt: "2026-08-02T10:00:00+01:00" }),
    ).toThrow(ValidationError);
    expect(() =>
      createUsageRecord({
        ...RECORD_INPUT,
        scope: { scopeType: "galaxy", scopeId: "x" } as never,
      }),
    ).toThrow(ValidationError);
    const record = createUsageRecord(RECORD_INPUT);
    expect(() => parseUsageRecord({ ...record, schemaVersion: 2 })).toThrow(ValidationError);
  });

  it("summarizes estimated and actual usage separately with exact totals", () => {
    const estimate = createUsageRecord({
      ...RECORD_INPUT,
      kind: "estimated",
      amounts: createUsageAmounts({
        tokens: { inputTokens: 200 },
        cost: createMoney("GBP", 5_000),
        durationMs: 2_000,
      }),
    });
    const actualOne = createUsageRecord(RECORD_INPUT);
    const actualTwo = createUsageRecord({
      ...RECORD_INPUT,
      amounts: createUsageAmounts({
        tokens: { inputTokens: 25, cachedInputTokens: 10 },
        durationMs: 500,
      }),
    });

    const summary = summarizeUsage([estimate, actualOne, actualTwo]);
    expect(summary.recordCount).toBe(3);
    expect(summary.estimated.tokens.inputTokens).toBe(200);
    expect(summary.estimated.cost?.amountMicros).toBe(5_000);
    expect(summary.actual.tokens.inputTokens).toBe(125);
    expect(summary.actual.tokens.cachedInputTokens).toBe(10);
    expect(summary.actual.cost?.amountMicros).toBe(2_000);
    expect(summary.actual.durationMs).toBe(2_000);
  });

  it("summarizeUsage of an empty ledger returns zero usage", () => {
    const summary = summarizeUsage([] as readonly UsageRecord[]);
    expect(summary.estimated).toEqual(ZERO_USAGE);
    expect(summary.actual).toEqual(ZERO_USAGE);
  });
});

describe("usage amounts", () => {
  it("adds amounts merging null costs", () => {
    const withCost = createUsageAmounts({ cost: createMoney("GBP", 100), durationMs: 10 });
    const noCost = createUsageAmounts({ tokens: { outputTokens: 3 } });
    const sum = addUsageAmounts(withCost, noCost);
    expect(sum.cost?.amountMicros).toBe(100);
    expect(sum.durationMs).toBe(10);
    expect(sum.tokens.outputTokens).toBe(3);
    expect(addUsageAmounts(noCost, withCost).cost?.amountMicros).toBe(100);
    expect(addUsageAmounts(withCost, withCost).cost?.amountMicros).toBe(200);
  });

  it("compares amounts deterministically", () => {
    const a = createUsageAmounts({ tokens: { inputTokens: 1 } });
    expect(usageAmountsEqual(a, createUsageAmounts({ tokens: { inputTokens: 1 } }))).toBe(true);
    expect(usageAmountsEqual(a, ZERO_USAGE)).toBe(false);
    expect(
      usageAmountsEqual(
        createUsageAmounts({ cost: createMoney("GBP", 1) }),
        createUsageAmounts({ cost: createMoney("GBP", 1) }),
      ),
    ).toBe(true);
    expect(
      usageAmountsEqual(createUsageAmounts({ cost: createMoney("GBP", 1) }), ZERO_USAGE),
    ).toBe(false);
    expect(
      usageAmountsEqual(ZERO_USAGE, createUsageAmounts({ cost: createMoney("GBP", 1) })),
    ).toBe(false);
  });

  it("rejects hostile usage amounts", () => {
    expect(() => parseUsageAmounts({ tokens: ZERO_TOKEN_USAGE, cost: null })).toThrow(
      ValidationError,
    );
    expect(() =>
      parseUsageAmounts({ tokens: ZERO_TOKEN_USAGE, cost: null, durationMs: -5 }),
    ).toThrow(ValidationError);
  });
});
