import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  GOLDEN_ROUTING_MATRIX,
  ROUTER_FIXTURE_EPOCH,
  ROUTING_GOLDEN_SCENARIOS,
  goldenRouterConfiguration,
  goldenRoutingRequestFixture
} from "../dist/testing/fixtures.js";
import {
  ROUTER_SCHEMA_VERSION,
  ROUTING_ALGORITHM_VERSION,
  createManualRouterClock,
  routeTask
} from "../dist/index.js";

if (process.argv[2] !== "--approve") {
  throw new Error(
    "Golden updates are review-only. Build the package, inspect the diff, then rerun with --approve."
  );
}

const covered = new Set(ROUTING_GOLDEN_SCENARIOS.flatMap((scenario) => scenario.tags));
const missing = GOLDEN_ROUTING_MATRIX.filter((tag) => !covered.has(tag));
if (missing.length > 0) {
  throw new Error(`Golden matrix is incomplete: ${missing.join(", ")}`);
}

const cases = [];
for (const scenario of ROUTING_GOLDEN_SCENARIOS) {
  const configuration = goldenRouterConfiguration(scenario);
  const request = await goldenRoutingRequestFixture(scenario);
  const decision = routeTask(request, {
    configuration,
    clock: createManualRouterClock(ROUTER_FIXTURE_EPOCH)
  });
  cases.push({
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
  });
}

const document = {
  schemaVersion: 1,
  routerSchemaVersion: ROUTER_SCHEMA_VERSION,
  routingAlgorithmVersion: ROUTING_ALGORITHM_VERSION,
  fixedEpoch: ROUTER_FIXTURE_EPOCH,
  updateCommand: "npm --prefix packages/router run build && node packages/router/scripts/update-goldens.mjs --approve",
  reviewRequired: true,
  requiredMatrix: GOLDEN_ROUTING_MATRIX,
  cases
};

const outputUrl = new URL("../goldens/routing-v1.json", import.meta.url);
await mkdir(new URL("../goldens/", import.meta.url), { recursive: true });
await writeFile(fileURLToPath(outputUrl), `${JSON.stringify(document, null, 2)}\n`, "utf8");
