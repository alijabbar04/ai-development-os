import {
  memorySnapshotHarness,
  runRepositoryIndexContractSuite,
} from "../src/testing/contract-suite.js";

runRepositoryIndexContractSuite("in-memory snapshot", memorySnapshotHarness);
