import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createManualRouterClock,
  createRoutingRequest,
  routeTask,
  type RoutingRequest
} from "../src/index.js";
import {
  GOLDEN_ROUTING_MATRIX,
  ROUTER_FIXTURE_EPOCH,
  ROUTING_GOLDEN_SCENARIOS,
  goldenRouterConfiguration,
  goldenRoutingRequestFixture
} from "../src/testing/fixtures.js";

interface GoldenCase {
  readonly id: string;
  readonly tags: readonly string[];
  readonly requestFingerprint: string;
  readonly profileFingerprint: string;
  readonly routerConfigurationFingerprint: string;
  readonly outcome: "routed" | "no-route";
  readonly primaryCandidateId: string | null;
  readonly fallbackCandidateIds: readonly string[];
  readonly feasibleCandidateIds: readonly string[];
  readonly rejections: readonly {
    readonly candidateId: string;
    readonly codes: readonly string[];
  }[];
  readonly decisionFingerprint: string;
}

const golden = JSON.parse(
  readFileSync(new URL("../goldens/routing-v1.json", import.meta.url), "utf8")
) as {
  readonly schemaVersion: number;
  readonly fixedEpoch: string;
  readonly reviewRequired: boolean;
  readonly requiredMatrix: readonly string[];
  readonly cases: readonly GoldenCase[];
};

function replayResult(
  scenario: (typeof ROUTING_GOLDEN_SCENARIOS)[number],
  request: RoutingRequest
): GoldenCase {
  const configuration = goldenRouterConfiguration(scenario);
  const decision = routeTask(request, {
    configuration,
    clock: createManualRouterClock(ROUTER_FIXTURE_EPOCH)
  });
  return {
    id: scenario.id,
    tags: scenario.tags,
    requestFingerprint: request.fingerprint,
    profileFingerprint: request.profile.fingerprint,
    routerConfigurationFingerprint: configuration.fingerprint,
    outcome: decision.outcome,
    primaryCandidateId: decision.primary?.candidateId ?? null,
    fallbackCandidateIds: decision.fallbacks.map((choice) => choice.candidateId),
    feasibleCandidateIds: decision.feasible.map((choice) => choice.candidateId),
    rejections: decision.rejections.map((rejection) => ({
      candidateId: rejection.candidateId,
      codes: rejection.codes
    })),
    decisionFingerprint: decision.fingerprint
  };
}

describe("reviewed golden routing corpus", () => {
  it("covers the complete required matrix with explicit review metadata", () => {
    expect(golden.schemaVersion).toBe(1);
    expect(golden.fixedEpoch).toBe(ROUTER_FIXTURE_EPOCH);
    expect(golden.reviewRequired).toBe(true);
    expect(golden.requiredMatrix).toEqual(GOLDEN_ROUTING_MATRIX);
    expect(golden.cases).toHaveLength(ROUTING_GOLDEN_SCENARIOS.length);
    const covered = new Set(ROUTING_GOLDEN_SCENARIOS.flatMap((scenario) => scenario.tags));
    expect(GOLDEN_ROUTING_MATRIX.filter((tag) => !covered.has(tag))).toEqual([]);
  });

  it.each(ROUTING_GOLDEN_SCENARIOS)("replays $id byte-identically", async (scenario) => {
    const expected = golden.cases.find((item) => item.id === scenario.id);
    const request = await goldenRoutingRequestFixture(scenario);
    const first = replayResult(scenario, request);
    const second = replayResult(scenario, request);
    expect(first).toEqual(expected);
    expect(second).toEqual(first);
  });

  it("keeps the reviewed permutation case invariant to caller order", async () => {
    const scenario = ROUTING_GOLDEN_SCENARIOS.find((item) => item.id === "tie-and-permutation")!;
    const request = await goldenRoutingRequestFixture(scenario);
    const { schemaVersion: _schema, fingerprint: _fingerprint, ...base } = request;
    const permuted = createRoutingRequest({ ...base, candidates: [...request.candidates].reverse() });
    expect(permuted.fingerprint).toBe(request.fingerprint);
    expect(replayResult(scenario, permuted)).toEqual(replayResult(scenario, request));
  });
});
