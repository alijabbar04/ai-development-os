"use strict";

const APPLICATION_NAME = "AI Development OS Credential Setup";
const ELECTRON_VERSION = "43.4.1";
const CREDENTIAL_PROTOCOL = "app-credential";

function productionOptions() {
  return Object.freeze({
    loadElectron: () => require("electron"),
    electronVersion: () => process.versions.electron,
    loadMain: () => import("./main.js"),
  });
}

function startProductionCredentialBootstrap(startupDeadline, injectedOptions) {
  const options = injectedOptions === undefined ? productionOptions() : injectedOptions;
  if (typeof startupDeadline !== "object" || startupDeadline === null || !startupDeadline.beginBootstrap()) {
    try { startupDeadline?.fail("STARTUP_FAILED"); } catch { /* the package entry owns malformed-controller failure */ }
    return false;
  }
  let app = null;

  const fail = (phase, code) => {
    try { startupDeadline.setPhase(phase); } catch { /* the deadline clamps its own output */ }
    startupDeadline.fail(code);
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
    if (!startupDeadline.bindElectronExit((code) => { candidateApp.exit(code); })) return fail("runtime-binding", "STARTUP_FAILED");
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
    startupDeadline.setPhase("protocol-registration");
    credentialProtocol.registerSchemesAsPrivileged([{
      scheme: CREDENTIAL_PROTOCOL,
      privileges: { standard: true, secure: true },
    }]);
  } catch {
    return fail("protocol-registration", "STARTUP_FAILED");
  }

  startupDeadline.setPhase("runtime-binding");
  let mainLoad;
  try { mainLoad = options.loadMain(); }
  catch { return fail("runtime-binding", "STARTUP_FAILED"); }
  void Promise.resolve(mainLoad).then(
    () => {
      if (startupDeadline.isActive() && !startupDeadline.isClaimed()) fail("runtime-binding", "STARTUP_FAILED");
    },
    () => { fail("runtime-binding", "STARTUP_FAILED"); },
  );
  return true;
}

module.exports = Object.freeze({ startProductionCredentialBootstrap });
