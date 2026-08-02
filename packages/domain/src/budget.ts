import { InvariantViolationError } from "./errors.js";
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
import type { Branded } from "./ids.js";
import { MAX_DURATION_MS, MAX_TOKEN_COUNT } from "./task.js";

export const USAGE_RECORD_SCHEMA_VERSION = 1 as const;

/** ISO-4217 style uppercase three-letter currency code. */
export type CurrencyCode = string & Branded<"CurrencyCode">;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export function parseCurrencyCode(value: unknown, path = "currency"): CurrencyCode {
  return ensureString(value, path, {
    minLength: 3,
    maxLength: 3,
    pattern: CURRENCY_PATTERN,
    patternName: "ISO-4217 currency code",
  }) as CurrencyCode;
}

/**
 * Exact monetary value: an integer count of micro-units of the major
 * currency unit (1,000,000 micros = 1 USD, 1 EUR, ...). Floating-point
 * amounts are rejected everywhere.
 */
export interface Money {
  readonly currency: CurrencyCode;
  readonly amountMicros: number;
}

export const MICROS_PER_CURRENCY_UNIT = 1_000_000;
export const MAX_MONEY_MICROS = Number.MAX_SAFE_INTEGER;

export function parseMoney(value: unknown, path = "money"): Money {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["currency", "amountMicros"], path);
  return Object.freeze({
    currency: parseCurrencyCode(record["currency"], `${path}.currency`),
    amountMicros: ensureSafeInteger(record["amountMicros"], `${path}.amountMicros`, 0, MAX_MONEY_MICROS),
  });
}

export function createMoney(currency: string, amountMicros: number): Money {
  return parseMoney({ currency, amountMicros });
}

export function zeroMoney(currency: CurrencyCode): Money {
  return createMoney(currency, 0);
}

function assertSameCurrency(a: Money, b: Money, operation: string): void {
  if (a.currency !== b.currency) {
    throw new InvariantViolationError(`Cannot ${operation} money in different currencies.`, {
      left: a.currency,
      right: b.currency,
    });
  }
}

function checkedAddMicros(a: number, b: number): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum) || sum > MAX_MONEY_MICROS) {
    throw new InvariantViolationError("Monetary addition overflowed the safe integer range.");
  }
  return sum;
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b, "add");
  return Object.freeze({
    currency: a.currency,
    amountMicros: checkedAddMicros(a.amountMicros, b.amountMicros),
  });
}

/** Throws when the result would be negative: domain money is non-negative. */
export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b, "subtract");
  const difference = a.amountMicros - b.amountMicros;
  if (difference < 0) {
    throw new InvariantViolationError("Monetary subtraction would produce a negative amount.");
  }
  return Object.freeze({ currency: a.currency, amountMicros: difference });
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b, "compare");
  return a.amountMicros < b.amountMicros ? -1 : a.amountMicros > b.amountMicros ? 1 : 0;
}

export function moneyEquals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMicros === b.amountMicros;
}

/**
 * Token categories are additive and disjoint: `inputTokens` excludes
 * `cachedInputTokens`; `outputTokens` excludes `reasoningTokens`.
 */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningTokens: number;
}

export function parseTokenUsage(value: unknown, path = "tokenUsage"): TokenUsage {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens"],
    path,
  );
  const read = (key: keyof TokenUsage): number =>
    ensureSafeInteger(record[key], `${path}.${key}`, 0, MAX_TOKEN_COUNT);
  return Object.freeze({
    inputTokens: read("inputTokens"),
    outputTokens: read("outputTokens"),
    cachedInputTokens: read("cachedInputTokens"),
    reasoningTokens: read("reasoningTokens"),
  });
}

export function createTokenUsage(input: Partial<TokenUsage> = {}): TokenUsage {
  return parseTokenUsage({
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    cachedInputTokens: input.cachedInputTokens ?? 0,
    reasoningTokens: input.reasoningTokens ?? 0,
  });
}

export const ZERO_TOKEN_USAGE: TokenUsage = createTokenUsage();

function checkedAddTokens(a: number, b: number, label: string): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) {
    throw new InvariantViolationError(`Token addition overflowed for ${label}.`);
  }
  return sum;
}

export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return Object.freeze({
    inputTokens: checkedAddTokens(a.inputTokens, b.inputTokens, "inputTokens"),
    outputTokens: checkedAddTokens(a.outputTokens, b.outputTokens, "outputTokens"),
    cachedInputTokens: checkedAddTokens(a.cachedInputTokens, b.cachedInputTokens, "cachedInputTokens"),
    reasoningTokens: checkedAddTokens(a.reasoningTokens, b.reasoningTokens, "reasoningTokens"),
  });
}

export function totalTokens(usage: TokenUsage): number {
  return checkedAddTokens(
    checkedAddTokens(usage.inputTokens, usage.cachedInputTokens, "inputTokens"),
    checkedAddTokens(usage.outputTokens, usage.reasoningTokens, "outputTokens"),
    "totalTokens",
  );
}

export interface TokenBudget {
  readonly maxTotalTokens: number;
  readonly maxInputTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly softMaxTotalTokens: number | null;
}

export function parseTokenBudget(value: unknown, path = "tokenBudget"): TokenBudget {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    ["maxTotalTokens", "maxInputTokens", "maxOutputTokens", "softMaxTotalTokens"],
    path,
  );
  const maxTotalTokens = ensureSafeInteger(
    record["maxTotalTokens"],
    `${path}.maxTotalTokens`,
    1,
    MAX_TOKEN_COUNT,
  );
  const limitWithin = (key: string): number | null =>
    ensureNullable(record[key], (limit) =>
      ensureSafeInteger(limit, `${path}.${key}`, 1, maxTotalTokens),
    );
  return Object.freeze({
    maxTotalTokens,
    maxInputTokens: limitWithin("maxInputTokens"),
    maxOutputTokens: limitWithin("maxOutputTokens"),
    softMaxTotalTokens: limitWithin("softMaxTotalTokens"),
  });
}

export interface MonetaryBudget {
  readonly limit: Money;
  readonly softLimit: Money | null;
}

export function parseMonetaryBudget(value: unknown, path = "monetaryBudget"): MonetaryBudget {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["limit", "softLimit"], path);
  const limit = parseMoney(record["limit"], `${path}.limit`);
  const softLimit = ensureNullable(record["softLimit"], (soft) =>
    parseMoney(soft, `${path}.softLimit`),
  );
  if (softLimit !== null) {
    if (softLimit.currency !== limit.currency) {
      fail(`${path}.softLimit`, "currency_mismatch", "must use the same currency as the hard limit.");
    }
    if (softLimit.amountMicros > limit.amountMicros) {
      fail(`${path}.softLimit`, "soft_above_hard", "cannot exceed the hard limit.");
    }
  }
  return Object.freeze({ limit, softLimit });
}

export interface TimeBudget {
  readonly maxDurationMs: number;
  readonly softMaxDurationMs: number | null;
}

export function parseTimeBudget(value: unknown, path = "timeBudget"): TimeBudget {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["maxDurationMs", "softMaxDurationMs"], path);
  const maxDurationMs = ensureSafeInteger(
    record["maxDurationMs"],
    `${path}.maxDurationMs`,
    1,
    MAX_DURATION_MS,
  );
  return Object.freeze({
    maxDurationMs,
    softMaxDurationMs: ensureNullable(record["softMaxDurationMs"], (soft) =>
      ensureSafeInteger(soft, `${path}.softMaxDurationMs`, 1, maxDurationMs),
    ),
  });
}

export interface AggregateBudget {
  readonly tokens: TokenBudget | null;
  readonly money: MonetaryBudget | null;
  readonly time: TimeBudget | null;
}

export function parseAggregateBudget(value: unknown, path = "aggregateBudget"): AggregateBudget {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["tokens", "money", "time"], path);
  const budget = Object.freeze({
    tokens: ensureNullable(record["tokens"], (tokens) => parseTokenBudget(tokens, `${path}.tokens`)),
    money: ensureNullable(record["money"], (money) => parseMonetaryBudget(money, `${path}.money`)),
    time: ensureNullable(record["time"], (time) => parseTimeBudget(time, `${path}.time`)),
  });
  if (budget.tokens === null && budget.money === null && budget.time === null) {
    fail(path, "empty_budget", "must define at least one of tokens, money, or time.");
  }
  return budget;
}

export function createAggregateBudget(input: Partial<AggregateBudget>): AggregateBudget {
  return parseAggregateBudget({
    tokens: input.tokens ?? null,
    money: input.money ?? null,
    time: input.time ?? null,
  });
}

/** One measured or estimated quantity of consumption. */
export interface UsageAmounts {
  readonly tokens: TokenUsage;
  readonly cost: Money | null;
  readonly durationMs: number;
}

export function parseUsageAmounts(value: unknown, path = "usageAmounts"): UsageAmounts {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["tokens", "cost", "durationMs"], path);
  return Object.freeze({
    tokens: parseTokenUsage(record["tokens"], `${path}.tokens`),
    cost: ensureNullable(record["cost"], (cost) => parseMoney(cost, `${path}.cost`)),
    durationMs: ensureSafeInteger(record["durationMs"], `${path}.durationMs`, 0, MAX_DURATION_MS),
  });
}

export function createUsageAmounts(input: {
  readonly tokens?: Partial<TokenUsage>;
  readonly cost?: Money | null;
  readonly durationMs?: number;
}): UsageAmounts {
  return parseUsageAmounts({
    tokens: createTokenUsage(input.tokens ?? {}),
    cost: input.cost ?? null,
    durationMs: input.durationMs ?? 0,
  });
}

export function addUsageAmounts(a: UsageAmounts, b: UsageAmounts): UsageAmounts {
  let cost: Money | null;
  if (a.cost === null) {
    cost = b.cost;
  } else if (b.cost === null) {
    cost = a.cost;
  } else {
    cost = addMoney(a.cost, b.cost);
  }
  const durationMs = a.durationMs + b.durationMs;
  if (!Number.isSafeInteger(durationMs)) {
    throw new InvariantViolationError("Duration addition overflowed the safe integer range.");
  }
  return Object.freeze({
    tokens: addTokenUsage(a.tokens, b.tokens),
    cost,
    durationMs,
  });
}

export const ZERO_USAGE: UsageAmounts = Object.freeze({
  tokens: ZERO_TOKEN_USAGE,
  cost: null,
  durationMs: 0,
});

export function usageAmountsEqual(a: UsageAmounts, b: UsageAmounts): boolean {
  const costEqual =
    a.cost === null ? b.cost === null : b.cost !== null && moneyEquals(a.cost, b.cost);
  return (
    costEqual &&
    a.durationMs === b.durationMs &&
    a.tokens.inputTokens === b.tokens.inputTokens &&
    a.tokens.outputTokens === b.tokens.outputTokens &&
    a.tokens.cachedInputTokens === b.tokens.cachedInputTokens &&
    a.tokens.reasoningTokens === b.tokens.reasoningTokens
  );
}

export const USAGE_KINDS = Object.freeze(["estimated", "actual"] as const);
export type UsageKind = (typeof USAGE_KINDS)[number];

export const BUDGET_SCOPE_TYPES = Object.freeze(["task", "run", "project"] as const);
export type BudgetScopeType = (typeof BUDGET_SCOPE_TYPES)[number];

export interface BudgetScope {
  readonly scopeType: BudgetScopeType;
  readonly scopeId: string;
}

const SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function parseBudgetScope(value: unknown, path = "budgetScope"): BudgetScope {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["scopeType", "scopeId"], path);
  return Object.freeze({
    scopeType: ensureEnum(record["scopeType"], `${path}.scopeType`, BUDGET_SCOPE_TYPES),
    scopeId: ensureString(record["scopeId"], `${path}.scopeId`, {
      maxLength: 128,
      pattern: SCOPE_ID_PATTERN,
      patternName: "scope identifier",
    }),
  });
}

/** Immutable ledger entry distinguishing estimated from actual consumption. */
export interface UsageRecord {
  readonly schemaVersion: typeof USAGE_RECORD_SCHEMA_VERSION;
  readonly kind: UsageKind;
  readonly scope: BudgetScope;
  readonly amounts: UsageAmounts;
  readonly recordedAt: string;
  readonly traceId: string | null;
}

export function parseUsageRecord(value: unknown, path = "usageRecord"): UsageRecord {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["schemaVersion", "kind", "scope", "amounts", "recordedAt", "traceId"], path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, USAGE_RECORD_SCHEMA_VERSION);
  return Object.freeze({
    schemaVersion: USAGE_RECORD_SCHEMA_VERSION,
    kind: ensureEnum(record["kind"], `${path}.kind`, USAGE_KINDS),
    scope: parseBudgetScope(record["scope"], `${path}.scope`),
    amounts: parseUsageAmounts(record["amounts"], `${path}.amounts`),
    recordedAt: ensureTimestamp(record["recordedAt"], `${path}.recordedAt`),
    traceId: ensureNullable(record["traceId"], (trace) =>
      ensureString(trace, `${path}.traceId`, {
        maxLength: 128,
        pattern: SCOPE_ID_PATTERN,
        patternName: "trace identifier",
      }),
    ),
  });
}

export function createUsageRecord(input: {
  readonly kind: UsageKind;
  readonly scope: BudgetScope;
  readonly amounts: UsageAmounts;
  readonly recordedAt: string;
  readonly traceId?: string | null;
}): UsageRecord {
  return parseUsageRecord({
    schemaVersion: USAGE_RECORD_SCHEMA_VERSION,
    kind: input.kind,
    scope: input.scope,
    amounts: input.amounts,
    recordedAt: input.recordedAt,
    traceId: input.traceId ?? null,
  });
}

export interface UsageSummary {
  readonly estimated: UsageAmounts;
  readonly actual: UsageAmounts;
  readonly recordCount: number;
}

/** Aggregates ledger entries into estimated and actual totals with exact arithmetic. */
export function summarizeUsage(records: readonly UsageRecord[]): UsageSummary {
  let estimated = ZERO_USAGE;
  let actual = ZERO_USAGE;
  for (const record of records) {
    const parsed = parseUsageRecord(record);
    if (parsed.kind === "estimated") {
      estimated = addUsageAmounts(estimated, parsed.amounts);
    } else {
      actual = addUsageAmounts(actual, parsed.amounts);
    }
  }
  return Object.freeze({ estimated, actual, recordCount: records.length });
}
