"use strict";

const APPLICATION_NAME = "AI Development OS Credential Setup";
const ELECTRON_VERSION = "43.4.1";
const CREDENTIAL_PROTOCOL = "app-credential";
const FAILURE_PHASES = new Set(["runtime-binding", "protocol-registration"]);
const FAILURE_CODES = new Set([
  "ELECTRON_RUNTIME_REQUIRED",
  "ELECTRON_BINDING_UNAVAILABLE",
  "ELECTRON_VERSION_UNREVIEWED",
  "STARTUP_FAILED",
]);

function boundedFailureLine(phase, code) {
  const finitePhase = FAILURE_PHASES.has(phase) ? phase : "runtime-binding";
  const finiteCode = FAILURE_CODES.has(code) ? code : "STARTUP_FAILED";
  return `${JSON.stringify({
    schemaVersion: 1,
    operation: "credential-host-startup",
    phase: finitePhase,
    code: finiteCode,
    terminal: true,
  })}\n`;
}

function productionOptions() {
  return Object.freeze({
    loadElectron: () => require("electron"),
    electronVersion: () => process.versions.electron,
    loadMain: () => import("./main.js"),
    writeLine: (line) => { require("node:fs").writeSync(2, line); },
    setExitCode: (code) => { process.exitCode = code; },
    exitElectron: (app, code) => { app.exit(code); },
    forceExit: (code) => { process.exit(code); },
  });
}

function startProductionCredentialBootstrap(injectedOptions) {
  const options = injectedOptions === undefined ? productionOptions() : injectedOptions;
  let app = null;
  let terminal = false;

  const fail = (phase, code) => {
    if (terminal) return false;
    terminal = true;
    try { options.writeLine(boundedFailureLine(phase, code)); } catch { /* bounded stderr is best effort */ }
    try { options.setExitCode(1); } catch { /* Electron exit remains the primary terminal path */ }
    if (app !== null) {
      try { options.exitElectron(app, 1); return false; }
      catch { /* fall through to the pre-service abrupt terminal fallback */ }
    }
    try { options.forceExit(1); } catch {
      try { options.setExitCode(1); } catch { /* no output or retry */ }
    }
    return false;
  };

  let electron;
  try { electron = options.loadElectron(); }
  catch { return fail("runtime-binding", "ELECTRON_BINDING_UNAVAILABLE"); }
  let credentialProtocol;
  try {
    if (typeof electron !== "object" || electron === null) return fail("runtime-binding", "ELECTRON_BINDING_UNAVAILABLE");
    const candidateApp = electron.app;
    if (typeof candidateApp !== "object" || candidateApp === null || typeof candidateApp.setName !== "function" || typeof candidateApp.exit !== "function") return fail("runtime-binding", "ELECTRON_BINDING_UNAVAILABLE");
    app = candidateApp;
    const candidateProtocol = electron.protocol;
    if (typeof candidateProtocol !== "object" || candidateProtocol === null || typeof candidateProtocol.registerSchemesAsPrivileged !== "function") return fail("runtime-binding", "ELECTRON_BINDING_UNAVAILABLE");
    credentialProtocol = candidateProtocol;
  } catch {
    return fail("runtime-binding", "ELECTRON_BINDING_UNAVAILABLE");
  }

  let version;
  try { version = options.electronVersion(); }
  catch { return fail("runtime-binding", "STARTUP_FAILED"); }
  if (version === undefined) return fail("runtime-binding", "ELECTRON_RUNTIME_REQUIRED");
  if (version !== ELECTRON_VERSION) return fail("runtime-binding", "ELECTRON_VERSION_UNREVIEWED");

  try {
    app.setName(APPLICATION_NAME);
    credentialProtocol.registerSchemesAsPrivileged([{
      scheme: CREDENTIAL_PROTOCOL,
      privileges: { standard: true, secure: true },
    }]);
  } catch {
    return fail("protocol-registration", "STARTUP_FAILED");
  }

  let mainLoad;
  try { mainLoad = options.loadMain(); }
  catch { return fail("runtime-binding", "STARTUP_FAILED"); }
  void Promise.resolve(mainLoad).catch(() => { fail("runtime-binding", "STARTUP_FAILED"); });
  return true;
}

module.exports = Object.freeze({ boundedFailureLine, startProductionCredentialBootstrap });
