"use strict";

const { writeSync } = require("node:fs");

const CREDENTIAL_STARTUP_DEADLINE_MS = 30_000;
const STARTUP_PHASES = new Set([
  "runtime-binding",
  "protocol-registration",
  "app-readiness",
  "session-hardening",
  "service-composition",
  "window-creation",
  "ipc-installation",
  "renderer-load",
  "surface-ready",
  "cleanup",
]);
const STARTUP_CODES = new Set([
  "ELECTRON_RUNTIME_REQUIRED",
  "ELECTRON_BINDING_UNAVAILABLE",
  "ELECTRON_VERSION_UNREVIEWED",
  "SINGLE_INSTANCE_UNAVAILABLE",
  "ENCRYPTION_UNAVAILABLE",
  "APP_NOT_READY",
  "PLATFORM_UNSUPPORTED",
  "STARTUP_CONFIGURATION_INVALID",
  "CLEANUP_FAILED",
  "STARTUP_TIMEOUT",
  "STARTUP_FAILED",
]);

const PRODUCTION_TIMER = Object.freeze({
  schedule(callback, delayMs) { return setTimeout(callback, delayMs); },
  cancel(handle) { clearTimeout(handle); },
});

function boundedFailureLine(phase, code) {
  const finitePhase = STARTUP_PHASES.has(phase) ? phase : "runtime-binding";
  const finiteCode = STARTUP_CODES.has(code) ? code : "STARTUP_FAILED";
  return `${JSON.stringify({
    schemaVersion: 1,
    operation: "credential-host-startup",
    phase: finitePhase,
    code: finiteCode,
    terminal: true,
  })}\n`;
}

function installProductionFatalHandlers(onFatal) {
  const onUnhandledRejection = () => { onFatal(); };
  const onUncaughtException = () => { onFatal(); };
  process.on("unhandledRejection", onUnhandledRejection);
  try { process.on("uncaughtException", onUncaughtException); }
  catch (error) {
    process.removeListener("unhandledRejection", onUnhandledRejection);
    throw error;
  }
  return () => {
    process.removeListener("unhandledRejection", onUnhandledRejection);
    process.removeListener("uncaughtException", onUncaughtException);
  };
}

function productionOptions() {
  return Object.freeze({
    timer: PRODUCTION_TIMER,
    writeLine: (line) => { writeSync(2, line); },
    setExitCode: (code) => { process.exitCode = code; },
    exit: (code) => { process.exit(code); },
    fallbackExit: (code) => { process.exitCode = code; process.exit(code); },
    installFatalHandlers: installProductionFatalHandlers,
  });
}

function createCredentialStartupDeadline(injectedOptions) {
  const options = injectedOptions === undefined ? productionOptions() : injectedOptions;
  const timer = options.timer ?? PRODUCTION_TIMER;
  let phase = "runtime-binding";
  let terminal = false;
  let succeeded = false;
  let bootstrapStarted = false;
  let claimed = false;
  let emitted = false;
  let handle = null;
  let disposeFatalHandlers = null;
  let primaryExit = options.exit;
  let fallbackExit = options.fallbackExit;
  let onTerminal = null;

  const cancelDeadline = () => {
    const scheduled = handle;
    handle = null;
    if (scheduled === null) return true;
    try { timer.cancel(scheduled); return true; }
    catch { return false; }
  };

  const notifyTerminal = (result) => {
    const listener = onTerminal;
    onTerminal = null;
    if (listener === null) return;
    try { listener(result); } catch { /* the terminal owner cannot reopen startup */ }
  };

  const emitFailure = (code) => {
    if (emitted) return false;
    emitted = true;
    try { options.writeLine(boundedFailureLine(phase, code)); } catch { /* bounded stderr is best effort */ }
    return true;
  };

  const fail = (code) => {
    if (terminal) return false;
    terminal = true;
    cancelDeadline();
    emitFailure(code);
    notifyTerminal(false);
    try { options.setExitCode(1); } catch { /* the exit paths remain authoritative */ }
    try { primaryExit(1); }
    catch {
      try { fallbackExit(1); }
      catch {
        try { options.setExitCode(1); } catch { /* no output, reset, or retry */ }
      }
    }
    return true;
  };

  const controller = Object.freeze({
    beginBootstrap() {
      if (terminal || bootstrapStarted) return false;
      bootstrapStarted = true;
      return true;
    },
    bindElectronExit(exitElectron) {
      if (terminal || typeof exitElectron !== "function") return false;
      primaryExit = exitElectron;
      return true;
    },
    claim(owner) {
      if (terminal || claimed) return false;
      try {
        if (typeof owner !== "object" || owner === null || typeof owner.exit !== "function" || typeof owner.fallbackExit !== "function" || typeof owner.onTerminal !== "function") return false;
        primaryExit = owner.exit;
        fallbackExit = owner.fallbackExit;
        onTerminal = owner.onTerminal;
      } catch {
        return false;
      }
      claimed = true;
      return true;
    },
    setPhase(next) {
      if (terminal) return false;
      if (!STARTUP_PHASES.has(next)) throw new Error("Invalid credential startup phase.");
      phase = next;
      return true;
    },
    fail,
    complete() {
      if (terminal) return false;
      if (phase !== "surface-ready") return fail("APP_NOT_READY");
      phase = "cleanup";
      let cleanupSucceeded = cancelDeadline();
      const dispose = disposeFatalHandlers;
      disposeFatalHandlers = null;
      if (dispose !== null) {
        try { dispose(); } catch { cleanupSucceeded = false; }
      }
      if (!cleanupSucceeded) return fail("CLEANUP_FAILED");
      terminal = true;
      succeeded = true;
      notifyTerminal(true);
      return true;
    },
    isActive() { return !terminal; },
    isClaimed() { return claimed; },
    didSucceed() { return succeeded; },
    currentPhase() { return phase; },
    deadlineMs: CREDENTIAL_STARTUP_DEADLINE_MS,
  });

  try {
    const scheduled = timer.schedule(() => { fail("STARTUP_TIMEOUT"); }, CREDENTIAL_STARTUP_DEADLINE_MS);
    handle = scheduled;
    if (terminal) {
      cancelDeadline();
      return controller;
    }
    try { scheduled.unref?.(); }
    catch { fail("STARTUP_FAILED"); return controller; }
  } catch {
    fail("STARTUP_FAILED");
    return controller;
  }

  if (typeof options.installFatalHandlers === "function") {
    try { disposeFatalHandlers = options.installFatalHandlers(() => { fail("STARTUP_FAILED"); }); }
    catch { fail("STARTUP_FAILED"); }
  }
  return controller;
}

let productionDeadline = null;

function armProductionCredentialStartupDeadline() {
  if (productionDeadline !== null) {
    productionDeadline.fail("STARTUP_FAILED");
    return productionDeadline;
  }
  productionDeadline = createCredentialStartupDeadline();
  return productionDeadline;
}

function productionCredentialStartupDeadline() {
  return productionDeadline;
}

module.exports = Object.freeze({
  CREDENTIAL_STARTUP_DEADLINE_MS,
  armProductionCredentialStartupDeadline,
  boundedFailureLine,
  createCredentialStartupDeadline,
  productionCredentialStartupDeadline,
});
