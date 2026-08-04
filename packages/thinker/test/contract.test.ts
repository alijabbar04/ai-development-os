import { describeThinkerBackendContract } from "../src/testing/contract-suite.js";
import { createThinkerContractHarness } from "../src/testing/fixtures.js";

describeThinkerBackendContract("opaque primary inference target", () =>
  createThinkerContractHarness({ target: "primary" })
);

describeThinkerBackendContract("differently identified alternate inference target", () =>
  createThinkerContractHarness({ target: "alternate" })
);
