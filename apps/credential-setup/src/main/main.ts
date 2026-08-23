import { runCredentialStartupTask } from "./startup-diagnostic.js";

let exitProductionHost: ((code: 1) => void) | null = null;

await runCredentialStartupTask({
  async run(setPhase, signal) {
    setPhase("runtime-binding");
    const electronRuntime = await import("electron");
    if (typeof electronRuntime.app === "object" && electronRuntime.app !== null && typeof electronRuntime.app.exit === "function") {
      exitProductionHost = (code) => { electronRuntime.app.exit(code); };
    }
    const entry = await import("./startup-entry.js");
    exitProductionHost ??= entry.exitProductionCredentialHost;
    await entry.startProductionCredentialHost(setPhase, signal);
  },
  exit(code) {
    if (exitProductionHost === null) {
      process.exitCode = code;
      process.exit(code);
      return;
    }
    exitProductionHost(code);
  },
  fallbackExit(code) { process.exitCode = code; process.exit(code); },
});
