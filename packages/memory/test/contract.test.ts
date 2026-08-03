import { createInMemoryMemoryStore } from "../src/in-memory-port.js";
import { runMemoryPortContractSuite } from "../src/testing/contract-suite.js";

runMemoryPortContractSuite("in-memory reference adapter", () => ({
  createPort: () => createInMemoryMemoryStore(),
}));
