"use strict";

const { writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { relative, resolve } = require("node:path");
const { app, BrowserWindow } = require("electron");

function argument(name) {
  const prefix = "--" + name + "=";
  const value = process.argv.find((item) => item.startsWith(prefix));
  if (value === undefined) throw new Error("PROBE_ARGUMENT_MISSING");
  return value.slice(prefix.length);
}

function withinTemporary(path) {
  const temporary = resolve(tmpdir());
  const rel = relative(temporary, path);
  return rel !== "" && !rel.startsWith("..") && resolve(temporary, rel) === path;
}

const mode = argument("probe-mode");
const root = resolve(argument("probe-root"));
const reportPath = resolve(argument("probe-report"));
if (!["visibility-success", "visibility-timeout"].includes(mode) || !withinTemporary(root) || !withinTemporary(reportPath)) throw new Error("PROBE_ARGUMENT_REFUSED");
app.setPath("appData", resolve(root, "app-data"));
app.setPath("userData", resolve(root, "user-data"));

let reported = false;
let window = null;
let requestedDelayMs = null;
let scheduleCount = 0;
let timerCancelled = false;
let timerFired = false;
let loadResolved = false;
let loadResolvedVisible = null;
let surfaceReadyVisible = null;
let pendingReady = false;
let readinessListener = null;
let readinessWrapper = null;
const timeline = [];
const diagnostics = [];

function mark(event) {
  timeline.push({
    event,
    visible: window !== null && !window.isDestroyed() && window.isVisible(),
  });
}

function report(result, exitCode) {
  if (reported) return;
  reported = true;
  writeFileSync(reportPath, JSON.stringify({
    mode,
    result,
    exitCode,
    requestedDelayMs,
    expectedDelayMs: 30_000,
    scheduleCount,
    timerCancelled,
    timerFired,
    loadResolvedVisible,
    surfaceReadyVisible,
    timeline,
    diagnostics: diagnostics.map((line) => JSON.parse(line)),
  }));
}

void Promise.all([
  import("../dist/main/startup-diagnostic.js"),
  import("../dist/main/startup-lifecycle.js"),
]).then(async ([diagnostic, lifecycle]) => {
  const timer = {
    schedule(callback, delayMs) {
      scheduleCount += 1;
      requestedDelayMs = delayMs;
      const native = setTimeout(() => {
        timerFired = true;
        callback();
      }, mode === "visibility-timeout" ? 200 : 5_000);
      return { native, unref() { native.unref(); } };
    },
    cancel(handle) {
      timerCancelled = true;
      clearTimeout(handle.native);
    },
  };

  const result = await diagnostic.runCredentialStartupTask({
    async run(setPhase, signal) {
      setPhase("app-readiness");
      if (!app.isReady()) await new Promise((resolveReady) => { app.once("ready", resolveReady); });
      setPhase("window-creation");
      window = new BrowserWindow({
        width: 640,
        height: 420,
        show: false,
        backgroundColor: "#0f1114",
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      window.setContentProtection(true);
      window.once("ready-to-show", () => { mark("ready-to-show-observed"); });
      window.once("show", () => { mark("show-observed"); });
      const observedWindow = {
        webContents: window.webContents,
        isDestroyed: () => window.isDestroyed(),
        isVisible: () => window.isVisible(),
        show: () => {
          mark("show-requested");
          window.show();
          mark("show-completed");
        },
        destroy: () => window.destroy(),
        on: (event, listener) => window.on(event, listener),
        once: (event, listener) => {
          if (event !== "ready-to-show") return window.once(event, listener);
          readinessListener = listener;
          if (mode === "visibility-timeout") return window;
          readinessWrapper = () => {
            if (loadResolved) setTimeout(() => { if (readinessListener !== null) readinessListener(); }, 25);
            else pendingReady = true;
          };
          return window.once(event, readinessWrapper);
        },
        removeListener: (event, listener) => {
          if (event === "ready-to-show" && readinessListener === listener) {
            if (readinessWrapper !== null) window.removeListener(event, readinessWrapper);
            readinessListener = null;
            readinessWrapper = null;
            return window;
          }
          return window.removeListener(event, listener);
        },
      };
      const visibility = lifecycle.waitForCredentialSurfaceVisible(observedWindow, signal);
      setPhase("ipc-installation");
      setPhase("renderer-load");
      const html = "<style>body{background:#0f1114;color:white}</style><h1>Synthetic visible startup</h1>";
      await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
      loadResolved = true;
      loadResolvedVisible = window.isVisible();
      mark("load-resolved");
      if (pendingReady) setTimeout(() => { if (readinessListener !== null) readinessListener(); }, 25);
      await visibility;
      surfaceReadyVisible = !window.isDestroyed() && window.isVisible();
      mark("visibility-verified");
      setPhase("surface-ready");
      mark("surface-ready");
    },
    exit(code) {
      report(false, code);
      app.exit(code);
    },
    fallbackExit(code) {
      report(false, code);
      process.exit(code);
    },
    writeLine(line) { diagnostics.push(line); },
    timer,
  });

  if (result) {
    report(true, 0);
    if (window !== null && !window.isDestroyed()) window.close();
    app.quit();
  }
}).catch(() => {
  report(false, 1);
  if (app.isReady()) app.exit(1);
  else process.exit(1);
});
