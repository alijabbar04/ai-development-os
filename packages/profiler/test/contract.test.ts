import { createTaskProfiler } from "../src/index.js";
import { describeProfilerContract } from "../src/testing/contract-suite.js";

describeProfilerContract("reference", () => ({ profiler: createTaskProfiler() }));
