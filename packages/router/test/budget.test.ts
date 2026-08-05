import { describe, expect, it } from "vitest";
import { createMoney, createUsageAmounts, reserveBudget } from "@ai-dev-os/domain";
import {
  DEFAULT_ROUTER_CONFIGURATION,
  budgetReconciliationPlanFingerprint,
  budgetReservationPlanFingerprint,
  createRouterConfiguration,
  createRoutingCostEstimate,
  parseRoutingCostEstimate,
  planBudgetReservation,
  reconcileBudgetReservation
} from "../src/index.js";
import {
  budgetAccountFixture,
  fixtureDigest,
  routingRequestFixture
} from "../src/testing/fixtures.js";

describe("budget reservation plans", () => {
  it("returns an immutable version-bound conservative fit plan", async () => {
    const request = await routingRequestFixture({ specs: [{ candidateId: "fit", alias: "fit" }] });
    const candidate = request.candidates[0]!;
    const plan = planBudgetReservation({
      account: request.budgetAccount,
      reservationId: "reservation-fit",
      requestedAt: request.requestedAt,
      tokenEstimate: candidate.tokenEstimate,
      costEstimate: candidate.costEstimate,
      expectedDurationMs: request.expectedDurationMs,
      configuration: DEFAULT_ROUTER_CONFIGURATION
    });
    expect(plan.code).toBe("FIT");
    expect(plan.allowed).toBe(true);
    expect(plan.command?.expectedVersion).toBe(request.budgetAccount.version);
    expect(plan.quote.estimate.tokens.inputTokens).toBeGreaterThan(candidate.tokenEstimate.inputTokens);
    expect(plan.authority).toBe("none");
    expect(plan.durableMutationPerformed).toBe(false);
    const { fingerprint, ...unsigned } = plan;
    expect(budgetReservationPlanFingerprint(unsigned)).toBe(fingerprint);
  });

  it("fails closed for unknown cost, currency mismatch, and exhausted budgets", async () => {
    const request = await routingRequestFixture({ specs: [{ candidateId: "budget", alias: "budget" }] });
    const estimate = request.candidates[0]!.tokenEstimate;
    const base = {
      reservationId: "reservation-check",
      requestedAt: request.requestedAt,
      tokenEstimate: estimate,
      expectedDurationMs: 1_000,
      configuration: DEFAULT_ROUTER_CONFIGURATION
    } as const;
    const unknown = createRoutingCostEstimate({
      status: "unknown",
      evidenceFingerprint: fixtureDigest("unknown")
    });
    expect(planBudgetReservation({
      ...base,
      account: budgetAccountFixture(),
      costEstimate: unknown
    }).code).toBe("COST_UNKNOWN");
    const knownUsd = createRoutingCostEstimate({
      status: "known",
      currency: "USD",
      amountMicros: 1_000,
      evidenceFingerprint: fixtureDigest("known")
    });
    expect(planBudgetReservation({
      ...base,
      account: budgetAccountFixture({ currency: "GBP" }),
      costEstimate: knownUsd
    }).code).toBe("CURRENCY_MISMATCH");
    expect(planBudgetReservation({
      ...base,
      account: budgetAccountFixture({ maximumTokens: 1 }),
      costEstimate: knownUsd
    }).code).toBe("BUDGET_EXCEEDED");
  });

  it("validates known/unknown cost shapes and fingerprints", () => {
    const unknown = createRoutingCostEstimate({
      status: "unknown",
      evidenceFingerprint: fixtureDigest("cost")
    });
    expect(parseRoutingCostEstimate(unknown)).toEqual(unknown);
    expect(() => parseRoutingCostEstimate({ ...unknown, currency: "USD" }))
      .toThrow(/unknown cost forbids/u);
    expect(() => parseRoutingCostEstimate({ ...unknown, fingerprint: "0".repeat(64) }))
      .toThrow(/fingerprint/u);
  });

  it("detects safe-integer overflow while applying reservation margins", async () => {
    const request = await routingRequestFixture({ specs: [{ candidateId: "overflow", alias: "overflow" }] });
    const candidate = request.candidates[0]!;
    const configuration = createRouterConfiguration({
      reservation: Object.freeze({
        tokenSafetyMarginBps: 100_000,
        costSafetyMarginBps: 100_000,
        durationSafetyMarginBps: 100_000
      })
    });
    const hugeCost = createRoutingCostEstimate({
      status: "known",
      currency: "USD",
      amountMicros: Number.MAX_SAFE_INTEGER,
      evidenceFingerprint: fixtureDigest("huge")
    });
    expect(() => planBudgetReservation({
      account: request.budgetAccount,
      reservationId: "overflow-plan",
      requestedAt: request.requestedAt,
      tokenEstimate: candidate.tokenEstimate,
      costEstimate: hugeCost,
      expectedDurationMs: 1,
      configuration
    })).toThrow(/safe integer range/u);
  });
});

describe("budget reconciliation plans", () => {
  async function heldAccount() {
    const request = await routingRequestFixture({ specs: [{ candidateId: "held", alias: "held" }] });
    const candidate = request.candidates[0]!;
    const plan = planBudgetReservation({
      account: request.budgetAccount,
      reservationId: "held-reservation",
      requestedAt: request.requestedAt,
      tokenEstimate: candidate.tokenEstimate,
      costEstimate: candidate.costEstimate,
      expectedDurationMs: 1_000,
      configuration: DEFAULT_ROUTER_CONFIGURATION
    });
    return {
      account: reserveBudget(request.budgetAccount, plan.command!),
      actual: plan.quote.estimate
    };
  }

  it("previews commit, release, and cancel without durable mutation", async () => {
    const held = await heldAccount();
    for (const action of ["commit", "release", "cancel"] as const) {
      const actual = action === "commit" ? held.actual : null;
      const first = reconcileBudgetReservation({
        account: held.account,
        reservationId: "held-reservation",
        settledAt: "2026-08-05T10:01:00.000Z",
        action,
        actual
      });
      const second = reconcileBudgetReservation({
        account: held.account,
        reservationId: "held-reservation",
        settledAt: "2026-08-05T10:01:00.000Z",
        action,
        actual
      });
      expect(first).toEqual(second);
      expect(first.code).toBe("PLANNED");
      expect(first.previewVersion).toBe(held.account.version + 1);
      expect(first.durableMutationPerformed).toBe(false);
      const { fingerprint, ...unsigned } = first;
      expect(budgetReconciliationPlanFingerprint(unsigned)).toBe(fingerprint);
    }
  });

  it("handles missing actuals, currency mismatch, and invalid state", async () => {
    const held = await heldAccount();
    expect(reconcileBudgetReservation({
      account: held.account,
      reservationId: "held-reservation",
      settledAt: "2026-08-05T10:01:00.000Z",
      action: "commit",
      actual: null
    }).code).toBe("ACTUAL_COST_UNKNOWN");
    expect(reconcileBudgetReservation({
      account: held.account,
      reservationId: "held-reservation",
      settledAt: "2026-08-05T10:01:00.000Z",
      action: "commit",
      actual: createUsageAmounts({
        tokens: { inputTokens: 1 },
        cost: createMoney("GBP", 1),
        durationMs: 1
      })
    }).code).toBe("CURRENCY_MISMATCH");
    expect(reconcileBudgetReservation({
      account: held.account,
      reservationId: "missing-reservation",
      settledAt: "2026-08-05T10:01:00.000Z",
      action: "release",
      actual: null
    }).code).toBe("INVALID_STATE");
    const overuse = reconcileBudgetReservation({
      account: held.account,
      reservationId: "held-reservation",
      settledAt: "2026-08-05T10:01:00.000Z",
      action: "commit",
      actual: createUsageAmounts({
        tokens: { inputTokens: 2_000_000 },
        cost: createMoney("USD", 1),
        durationMs: 1
      })
    });
    expect(overuse.code).toBe("PLANNED");
    expect(overuse.previewVersion).toBe(held.account.version + 1);
  });
});
