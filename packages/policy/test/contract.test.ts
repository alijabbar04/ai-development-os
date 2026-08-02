import { createDeterministicPolicyBroker } from "../src/index.js";
import { runPolicyBrokerContractSuite } from "../src/testing/contract-suite.js";

runPolicyBrokerContractSuite((rules, clock) => createDeterministicPolicyBroker({ policyVersion: "policy-v1", rules, clock }));
