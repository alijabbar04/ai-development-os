import { describe, expect, it } from "vitest";
import {
  createManualRouterClock,
  explainRouteDecision,
  summarizeRouteDecision,
  type Router
} from "../index.js";
import { routingRequestFixture } from "./fixtures.js";

export interface RouterContractHarness {
  readonly router: Router;
  readonly providerInvocationCount: () => number;
  readonly durableMutationCount: () => number;
}

export function describeRouterContract(
  name: string,
  create: () => RouterContractHarness
): void {
  describe(`router contract: ${name}`, () => {
    it("returns a deterministic immutable decision without invoking or mutating", async () => {
      const harness = create();
      const request = await routingRequestFixture();
      const first = harness.router.route(request);
      const second = harness.router.route(request);
      expect(first).toEqual(second);
      expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
      expect(Object.isFrozen(first)).toBe(true);
      expect(first.authority).toBe("none");
      expect(first.providerInvocationPerformed).toBe(false);
      expect(first.durableMutationPerformed).toBe(false);
      expect(harness.providerInvocationCount()).toBe(0);
      expect(harness.durableMutationCount()).toBe(0);
    });

    it("never revives a policy-denied candidate through scoring", async () => {
      const harness = create();
      const request = await routingRequestFixture({
        specs: [
          { candidateId: "denied", alias: "denied", policyOutcome: "denied", expectedLatencyMs: 1 },
          { candidateId: "allowed", alias: "allowed", expectedLatencyMs: 5_000 }
        ]
      });
      const decision = harness.router.route(request);
      expect(decision.primary?.candidateId).toBe("allowed");
      expect(decision.rejections.find((item) => item.candidateId === "denied")?.codes)
        .toContain("POLICY_DENIED");
    });

    it("respects an explicit strict alias without silent fallback", async () => {
      const harness = create();
      const request = await routingRequestFixture({
        specs: [
          { candidateId: "pinned", alias: "pinned", quotaState: "exhausted" },
          { candidateId: "other", alias: "other" }
        ],
        explicitAlias: "pinned",
        allowFallbacks: false
      });
      const decision = harness.router.route(request);
      expect(decision.outcome).toBe("no-route");
      expect(decision.primary).toBeNull();
      expect(decision.fallbacks).toEqual([]);
    });

    it("returns body-free summaries and explanations", async () => {
      const harness = create();
      const decision = harness.router.route(await routingRequestFixture());
      const summary = summarizeRouteDecision(decision);
      const explanation = explainRouteDecision(decision);
      expect(summary.decisionFingerprint).toBe(decision.fingerprint);
      expect(explanation.statement).toBe("ROUTE_GRANTS_NO_AUTHORITY");
      expect(JSON.stringify({ summary, explanation })).not.toContain("STAGE16-ROUTER-CANARY-6E2A");
    });
  });
}

export function fixedContractClock() {
  return createManualRouterClock("2026-08-05T10:00:00.000Z");
}
