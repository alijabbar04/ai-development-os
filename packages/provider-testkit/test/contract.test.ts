import {
  runCodingAgentProviderContractSuite,
  runInferenceProviderContractSuite,
} from "@ai-dev-os/providers/testing";
import {
  createStandardCodingAgentHarness,
  createStandardInferenceHarness,
} from "../src/index.js";

runInferenceProviderContractSuite("fake inference provider", async () =>
  createStandardInferenceHarness(),
);

runCodingAgentProviderContractSuite("fake coding-agent provider", async () =>
  createStandardCodingAgentHarness(),
);
