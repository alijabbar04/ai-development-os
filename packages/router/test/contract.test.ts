import { createRouter } from "../src/index.js";
import {
  describeRouterContract,
  fixedContractClock
} from "../src/testing/contract-suite.js";

describeRouterContract("reference implementation", () => ({
  router: createRouter({ clock: fixedContractClock() }),
  providerInvocationCount: () => 0,
  durableMutationCount: () => 0
}));
