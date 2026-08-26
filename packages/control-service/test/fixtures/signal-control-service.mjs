import process from "node:process";
import { createControlArtifactStore } from "../../dist/artifacts.js";
import { startControlServiceInternal } from "../../dist/listener.js";

const storageRoot = process.argv[2];
if (typeof storageRoot !== "string" || storageRoot.length === 0 || typeof process.send !== "function") {
  process.exitCode = 2;
} else {
  const handle = await startControlServiceInternal({
    store: createControlArtifactStore({ root: storageRoot }),
    clock: () => "2026-08-26T10:00:00.000Z",
    processId: process.pid,
    liveness: Object.freeze({ inspect: async () => "live" }),
    testingPort: 0,
    presentationMode: "normal",
    projectionDataset: {
      health: {
        startupMode: "fresh",
        stoppedByRestart: 0,
        recoveredSessions: 0,
        unresolvedRuns: 0,
        unconfirmedSessions: 0,
        sweepCompletedAt: "2026-08-26T10:00:00.000Z",
        providerHealth: [],
        probes: [],
        sweepTimings: [],
        computedAt: "2026-08-26T10:00:00.000Z",
        confidence: "current",
        staleReason: null,
      },
      usageProfiles: [],
      routingDecisions: [],
    },
  });
  let closing = false;
  const closeForSignal = async () => {
    if (closing) return;
    closing = true;
    try {
      await handle.close();
      process.exitCode = 0;
      process.send?.({ type: "closed" }, () => process.disconnect());
    } catch {
      process.exitCode = 3;
    }
  };
  process.once("SIGTERM", () => { void closeForSignal(); });
  process.on("message", (message) => {
    if (message === "emit-task-owned-sigterm") process.emit("SIGTERM", "SIGTERM");
  });
  process.send({ type: "ready" });
}
