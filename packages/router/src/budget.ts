import {
  cancelReservation,
  commitReservation,
  createMoney,
  createUsageAmounts,
  evaluateReservation,
  parseBudgetAccountState,
  parseUsageAmounts,
  releaseReservation,
  validation,
  type BudgetAccountState,
  type BudgetDecision,
  type CommitCommand,
  type ReserveCommand,
  type SettleCommand,
  type UsageAmounts
} from "@ai-dev-os/domain";
import { parseTokenEstimate, type TokenEstimate } from "@ai-dev-os/profiler";
import type { RouterConfiguration } from "./config.js";
import { HEX_64, SAFE_ID, ceilRatio, checkedNumber, digest } from "./shared.js";

const {
  ensureEnum,
  ensureExactKeys,
  ensureNullable,
  ensureRecord,
  ensureSafeInteger,
  ensureString,
  ensureTimestamp,
  fail
} = validation;

export const ROUTING_COST_STATUSES = Object.freeze(["known", "unknown"] as const);
export type RoutingCostStatus = (typeof ROUTING_COST_STATUSES)[number];

export interface RoutingCostEstimate {
  readonly status: RoutingCostStatus;
  readonly currency: string | null;
  readonly amountMicros: number | null;
  readonly evidenceFingerprint: string;
  readonly fingerprint: string;
}

export function routingCostEstimateFingerprint(
  value: Omit<RoutingCostEstimate, "fingerprint">
): string {
  return digest(value);
}

export function parseRoutingCostEstimate(
  value: unknown,
  path = "routingCostEstimate"
): RoutingCostEstimate {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    ["status", "currency", "amountMicros", "evidenceFingerprint", "fingerprint"],
    path
  );
  const status = ensureEnum(record["status"], `${path}.status`, ROUTING_COST_STATUSES);
  const unsigned = Object.freeze({
    status,
    currency: ensureNullable(record["currency"], (raw) =>
      ensureString(raw, `${path}.currency`, {
        minLength: 3,
        maxLength: 3,
        pattern: /^[A-Z]{3}$/u,
        patternName: "ISO currency code"
      })
    ),
    amountMicros: ensureNullable(record["amountMicros"], (raw) =>
      ensureSafeInteger(raw, `${path}.amountMicros`, 0, Number.MAX_SAFE_INTEGER)
    ),
    evidenceFingerprint: ensureString(
      record["evidenceFingerprint"],
      `${path}.evidenceFingerprint`,
      { minLength: 64, maxLength: 64, pattern: HEX_64, patternName: "cost evidence fingerprint" }
    )
  });
  if (
    (status === "known" && (unsigned.currency === null || unsigned.amountMicros === null)) ||
    (status === "unknown" && (unsigned.currency !== null || unsigned.amountMicros !== null))
  ) {
    fail(path, "inconsistent_cost", "known cost requires amount/currency and unknown cost forbids them.");
  }
  const fingerprint = ensureString(record["fingerprint"], `${path}.fingerprint`, {
    minLength: 64,
    maxLength: 64,
    pattern: HEX_64,
    patternName: "cost estimate fingerprint"
  });
  if (routingCostEstimateFingerprint(unsigned) !== fingerprint) {
    fail(`${path}.fingerprint`, "fingerprint_mismatch", "does not match cost estimate content.");
  }
  return Object.freeze({ ...unsigned, fingerprint });
}

export function createRoutingCostEstimate(
  value:
    | { readonly status: "known"; readonly currency: string; readonly amountMicros: number; readonly evidenceFingerprint: string }
    | { readonly status: "unknown"; readonly evidenceFingerprint: string }
): RoutingCostEstimate {
  const unsigned =
    value.status === "known"
      ? Object.freeze({
          status: value.status,
          currency: value.currency,
          amountMicros: value.amountMicros,
          evidenceFingerprint: value.evidenceFingerprint
        })
      : Object.freeze({
          status: value.status,
          currency: null,
          amountMicros: null,
          evidenceFingerprint: value.evidenceFingerprint
        });
  return parseRoutingCostEstimate({
    ...unsigned,
    fingerprint: routingCostEstimateFingerprint(unsigned)
  });
}

export type BudgetReservationPlanCode =
  | "FIT"
  | "BUDGET_EXCEEDED"
  | "COST_UNKNOWN"
  | "CURRENCY_MISMATCH";

export interface BudgetReservationQuote {
  readonly estimate: UsageAmounts;
  readonly tokenEstimateFingerprint: string;
  readonly costEstimateFingerprint: string;
  readonly marginBps: RouterConfiguration["reservation"];
  readonly fingerprint: string;
}

export interface BudgetReservationPlan {
  readonly allowed: boolean;
  readonly code: BudgetReservationPlanCode;
  readonly accountVersion: number;
  readonly accountFingerprint: string;
  readonly quote: BudgetReservationQuote;
  readonly decision: BudgetDecision | null;
  readonly command: ReserveCommand | null;
  readonly authority: "none";
  readonly durableMutationPerformed: false;
  readonly fingerprint: string;
}

function withMargin(value: number, basisPoints: number, label: string): number {
  const amount = BigInt(value);
  return checkedNumber(
    amount + ceilRatio(amount * BigInt(basisPoints), 10_000n, `${label} margin`),
    label
  );
}

function quoteFingerprint(value: Omit<BudgetReservationQuote, "fingerprint">): string {
  return digest(value);
}

export function budgetReservationPlanFingerprint(
  value: Omit<BudgetReservationPlan, "fingerprint">
): string {
  return digest(value);
}

export function planBudgetReservation(input: {
  readonly account: BudgetAccountState | unknown;
  readonly reservationId: string;
  readonly requestedAt: string;
  readonly tokenEstimate: TokenEstimate | unknown;
  readonly costEstimate: RoutingCostEstimate | unknown;
  readonly expectedDurationMs: number;
  readonly configuration: RouterConfiguration;
}): BudgetReservationPlan {
  const account = parseBudgetAccountState(input.account);
  const tokenEstimate = parseTokenEstimate(input.tokenEstimate);
  const costEstimate = parseRoutingCostEstimate(input.costEstimate);
  const reservationId = ensureString(input.reservationId, "reservation.reservationId", {
    minLength: 1,
    maxLength: 128,
    pattern: SAFE_ID,
    patternName: "reservation identifier"
  });
  const requestedAt = ensureTimestamp(input.requestedAt, "reservation.requestedAt");
  const expectedDurationMs = ensureSafeInteger(
    input.expectedDurationMs,
    "reservation.expectedDurationMs",
    0,
    10_000_000_000_000
  );
  const margins = input.configuration.reservation;
  const cost =
    costEstimate.status === "known"
      ? createMoney(
          costEstimate.currency!,
          withMargin(costEstimate.amountMicros!, margins.costSafetyMarginBps, "cost estimate")
        )
      : null;
  const estimate = createUsageAmounts({
    tokens: {
      inputTokens: withMargin(
        tokenEstimate.inputTokens,
        margins.tokenSafetyMarginBps,
        "input tokens"
      ),
      outputTokens: withMargin(
        tokenEstimate.outputAllowanceTokens,
        margins.tokenSafetyMarginBps,
        "output tokens"
      ),
      cachedInputTokens:
        tokenEstimate.cachedInputTokens === null
          ? 0
          : withMargin(
              tokenEstimate.cachedInputTokens,
              margins.tokenSafetyMarginBps,
              "cached input tokens"
            ),
      reasoningTokens: withMargin(
        tokenEstimate.reasoningAllowanceTokens,
        margins.tokenSafetyMarginBps,
        "reasoning tokens"
      )
    },
    cost,
    durationMs: withMargin(
      expectedDurationMs,
      margins.durationSafetyMarginBps,
      "duration estimate"
    )
  });
  const quoteUnsigned = Object.freeze({
    estimate,
    tokenEstimateFingerprint: tokenEstimate.fingerprint,
    costEstimateFingerprint: costEstimate.fingerprint,
    marginBps: margins
  });
  const quote = Object.freeze({ ...quoteUnsigned, fingerprint: quoteFingerprint(quoteUnsigned) });
  const accountFingerprint = digest(account);
  let code: BudgetReservationPlanCode = "FIT";
  let decision: BudgetDecision | null = null;
  let command: ReserveCommand | null = null;
  if (
    account.budget.money !== null &&
    costEstimate.status === "unknown" &&
    input.configuration.hardEvidence.requireKnownCostWhenBudgeted
  ) {
    code = "COST_UNKNOWN";
  } else if (
    account.budget.money !== null &&
    cost !== null &&
    account.budget.money.limit.currency !== cost.currency
  ) {
    code = "CURRENCY_MISMATCH";
  } else {
    decision = evaluateReservation(account, estimate);
    if (!decision.allowed) code = "BUDGET_EXCEEDED";
    else {
      command = Object.freeze({
        reservationId,
        estimate,
        requestedAt,
        expectedVersion: account.version
      });
    }
  }
  const unsigned = Object.freeze({
    allowed: code === "FIT",
    code,
    accountVersion: account.version,
    accountFingerprint,
    quote,
    decision,
    command,
    authority: "none" as const,
    durableMutationPerformed: false as const
  });
  return Object.freeze({ ...unsigned, fingerprint: budgetReservationPlanFingerprint(unsigned) });
}

export type BudgetReconciliationAction = "commit" | "release" | "cancel";
export type BudgetReconciliationCode =
  | "PLANNED"
  | "ACTUAL_COST_UNKNOWN"
  | "CURRENCY_MISMATCH"
  | "INVALID_STATE";

export interface BudgetReconciliationPlan {
  readonly planned: boolean;
  readonly code: BudgetReconciliationCode;
  readonly action: BudgetReconciliationAction;
  readonly accountVersion: number;
  readonly accountFingerprint: string;
  readonly command: CommitCommand | SettleCommand | null;
  readonly previewVersion: number | null;
  readonly previewFingerprint: string | null;
  readonly authority: "none";
  readonly durableMutationPerformed: false;
  readonly fingerprint: string;
}

export function budgetReconciliationPlanFingerprint(
  value: Omit<BudgetReconciliationPlan, "fingerprint">
): string {
  return digest(value);
}

export function reconcileBudgetReservation(input: {
  readonly account: BudgetAccountState | unknown;
  readonly reservationId: string;
  readonly settledAt: string;
  readonly action: BudgetReconciliationAction;
  readonly actual: UsageAmounts | unknown | null;
}): BudgetReconciliationPlan {
  const account = parseBudgetAccountState(input.account);
  const reservationId = ensureString(input.reservationId, "reconcile.reservationId", {
    minLength: 1,
    maxLength: 128,
    pattern: SAFE_ID,
    patternName: "reservation identifier"
  });
  const settledAt = ensureTimestamp(input.settledAt, "reconcile.settledAt");
  const action = ensureEnum(input.action, "reconcile.action", ["commit", "release", "cancel"] as const);
  const actual = input.actual === null ? null : parseUsageAmounts(input.actual, "reconcile.actual");
  let code: BudgetReconciliationCode = "PLANNED";
  let command: CommitCommand | SettleCommand | null = null;
  let preview: BudgetAccountState | null = null;
  if (action === "commit" && actual === null) {
    code = "ACTUAL_COST_UNKNOWN";
  } else if (
    action === "commit" &&
    account.budget.money !== null &&
    actual?.cost === null
  ) {
    code = "ACTUAL_COST_UNKNOWN";
  } else if (
    action === "commit" &&
    account.budget.money !== null &&
    actual?.cost !== null &&
    actual?.cost.currency !== account.budget.money.limit.currency
  ) {
    code = "CURRENCY_MISMATCH";
  } else {
    try {
      if (action === "commit") {
        const commitCommand: CommitCommand = Object.freeze({
          reservationId,
          actual: actual!,
          settledAt,
          expectedVersion: account.version
        });
        command = commitCommand;
        preview = commitReservation(account, commitCommand);
      } else {
        command = Object.freeze({ reservationId, settledAt, expectedVersion: account.version });
        preview =
          action === "release"
            ? releaseReservation(account, command)
            : cancelReservation(account, command);
      }
    } catch {
      code = "INVALID_STATE";
      command = null;
      preview = null;
    }
  }
  const unsigned = Object.freeze({
    planned: code === "PLANNED",
    code,
    action,
    accountVersion: account.version,
    accountFingerprint: digest(account),
    command,
    previewVersion: preview?.version ?? null,
    previewFingerprint: preview === null ? null : digest(preview),
    authority: "none" as const,
    durableMutationPerformed: false as const
  });
  return Object.freeze({ ...unsigned, fingerprint: budgetReconciliationPlanFingerprint(unsigned) });
}
