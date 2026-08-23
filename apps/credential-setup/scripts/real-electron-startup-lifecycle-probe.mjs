import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { productionHostEnvironment } from "./launch-production-host.mjs";

const require = createRequire(import.meta.url);
const electronExecutable = require("electron");
const electronVersion = require("electron/package.json").version;
const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "ai-dev-os-electron-readiness-"));

function bootstrapSource() {
  return `"use strict";
const { mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { app } = require("electron");
const runtimeRoot = join(__dirname, "runtime");
mkdirSync(join(runtimeRoot, "app-data"), { recursive: true });
mkdirSync(join(runtimeRoot, "user-data"), { recursive: true });
app.setPath("appData", join(runtimeRoot, "app-data"));
app.setPath("userData", join(runtimeRoot, "user-data"));
void import("./main.mjs").catch(() => { app.exit(91); });
`;
}

function mainSource(mode) {
  const startup = `
  if (!app.isReady()) await new Promise((resolveReady) => { app.once("ready", resolveReady); });
  readyObserved = true;
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  windowCreated = !window.isDestroyed();
  writeFileSync(reportPath, JSON.stringify({ mode: ${JSON.stringify(mode)}, timedOut: false, readyObserved, windowCreated, evaluationCompleted: true }));
  window.close();
  app.exit(0);
`;
  return `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
const reportPath = join(import.meta.dirname, "report.json");
const runtimeRoot = join(import.meta.dirname, "runtime");
mkdirSync(join(runtimeRoot, "app-data"), { recursive: true });
mkdirSync(join(runtimeRoot, "user-data"), { recursive: true });
app.setPath("appData", join(runtimeRoot, "app-data"));
app.setPath("userData", join(runtimeRoot, "user-data"));
let readyObserved = false;
let windowCreated = false;
const watchdog = setTimeout(() => {
  writeFileSync(reportPath, JSON.stringify({ mode: ${JSON.stringify(mode)}, timedOut: true, readyObserved, windowCreated, evaluationCompleted: false }));
  app.exit(90);
}, 1500);
${mode === "awaited" ? `await (async () => {${startup}})();\nclearTimeout(watchdog);` : `void (async () => {${startup}\nclearTimeout(watchdog); })().catch(() => { app.exit(92); });`}
`;
}

async function createFixture(mode) {
  const fixture = join(root, mode);
  await mkdir(fixture, { recursive: true });
  await writeFile(join(fixture, "package.json"), `${JSON.stringify({ name: `readiness-${mode}`, version: "0.0.0", private: true, main: "bootstrap.cjs" }, null, 2)}\n`, "utf8");
  await writeFile(join(fixture, "bootstrap.cjs"), bootstrapSource(), "utf8");
  await writeFile(join(fixture, "main.mjs"), mainSource(mode), "utf8");
  return fixture;
}

async function createDirectAwaitedFixture() {
  const fixture = join(root, "direct-awaited");
  await mkdir(fixture, { recursive: true });
  await writeFile(join(fixture, "package.json"), `${JSON.stringify({ name: "readiness-direct-awaited", version: "0.0.0", private: true, type: "module", main: "main.mjs" }, null, 2)}\n`, "utf8");
  await writeFile(join(fixture, "main.mjs"), mainSource("awaited"), "utf8");
  return fixture;
}

async function runFixture(mode) {
  const fixture = await createFixture(mode);
  const child = spawn(electronExecutable, [fixture], {
    cwd: fixture,
    env: productionHostEnvironment(process.env),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 10_000);
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => { resolveExit(code); });
  }).finally(() => { clearTimeout(timeout); });
  if (timedOut) throw new Error(`Disposable Electron ${mode} fixture exceeded its parent deadline.`);
  const report = JSON.parse(await readFile(join(fixture, "report.json"), "utf8"));
  return Object.freeze({ mode, exitCode, report });
}

async function runDirectAwaitedFixture() {
  const fixture = await createDirectAwaitedFixture();
  const child = spawn(electronExecutable, [fixture], {
    cwd: fixture,
    env: productionHostEnvironment(process.env),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  let parentTimedOut = false;
  const timeout = setTimeout(() => { parentTimedOut = true; child.kill(); }, 10_000);
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => { resolveExit(code); });
  }).finally(() => { clearTimeout(timeout); });
  if (parentTimedOut) throw new Error("Disposable direct-ESM awaited fixture exceeded its parent deadline.");
  const report = JSON.parse(await readFile(join(fixture, "report.json"), "utf8"));
  return Object.freeze({ mode: "direct-awaited", exitCode, report });
}

function commonJsMainSource(mode) {
  return `"use strict";
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { app, BrowserWindow } = require("electron");
const runtimeRoot = join(__dirname, "runtime");
const reportPath = join(__dirname, "report.json");
mkdirSync(join(runtimeRoot, "app-data"), { recursive: true });
mkdirSync(join(runtimeRoot, "user-data"), { recursive: true });
app.setPath("appData", join(runtimeRoot, "app-data"));
app.setPath("userData", join(runtimeRoot, "user-data"));
const requireMainEqualsModule = require.main === module;
let readyObserved = false;
let windowCreated = false;
const write = (timedOut) => writeFileSync(reportPath, JSON.stringify({ mode: ${JSON.stringify(mode)}, timedOut, requireMainEqualsModule, readyObserved, windowCreated }));
const watchdog = setTimeout(() => { write(true); app.exit(90); }, 1500);
function start() {
  const ready = () => {
    readyObserved = true;
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    windowCreated = !window.isDestroyed();
    clearTimeout(watchdog);
    write(false);
    window.close();
    app.exit(0);
  };
  if (app.isReady()) ready();
  else app.once("ready", ready);
}
${mode === "guarded" ? "if (require.main === module) start();" : "start();"}
`;
}

async function createCommonJsFixture(mode) {
  const fixture = join(root, `commonjs-${mode}`);
  await mkdir(fixture, { recursive: true });
  await writeFile(join(fixture, "package.json"), `${JSON.stringify({ name: `commonjs-${mode}`, version: "0.0.0", private: true, main: "main.cjs" }, null, 2)}\n`, "utf8");
  await writeFile(join(fixture, "main.cjs"), commonJsMainSource(mode), "utf8");
  return fixture;
}

async function runCommonJsFixture(mode) {
  const fixture = await createCommonJsFixture(mode);
  const child = spawn(electronExecutable, [fixture], {
    cwd: fixture,
    env: productionHostEnvironment(process.env),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  let parentTimedOut = false;
  const timeout = setTimeout(() => { parentTimedOut = true; child.kill(); }, 10_000);
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => { resolveExit(code); });
  }).finally(() => { clearTimeout(timeout); });
  if (parentTimedOut) throw new Error(`Disposable Electron CommonJS ${mode} fixture exceeded its parent deadline.`);
  const report = JSON.parse(await readFile(join(fixture, "report.json"), "utf8"));
  return Object.freeze({ mode, exitCode, report });
}

function watchdogMainSource(mode) {
  const runBody = mode === "timeout"
    ? `setPhase("window-creation");\n      await new Promise(() => undefined);`
    : `setPhase("app-readiness");
      if (!app.isReady()) await new Promise((resolveReady) => { app.once("ready", resolveReady); });
      readyObserved = true;
      setPhase("session-hardening");
      setPhase("service-composition");
      setPhase("window-creation");
      window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      windowCreated = !window.isDestroyed();
      setPhase("ipc-installation");
      setPhase("renderer-load");
      await window.loadURL("data:text/html,<title>Synthetic startup probe</title>");
      setPhase("surface-ready");`;
  return `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { CREDENTIAL_STARTUP_DEADLINE_MS, runCredentialStartupTask } from "./startup-diagnostic.js";
const runtimeRoot = join(import.meta.dirname, "runtime");
const reportPath = join(import.meta.dirname, "report.json");
app.setPath("appData", join(runtimeRoot, "app-data"));
app.setPath("userData", join(runtimeRoot, "user-data"));
let requestedDelayMs = null;
let timerCancelled = false;
let timerFired = false;
let readyObserved = false;
let windowCreated = false;
let window = null;
const lines = [];
const timer = {
  schedule(callback, delayMs) {
    requestedDelayMs = delayMs;
    const native = setTimeout(() => { timerFired = true; callback(); }, ${mode === "timeout" ? "75" : "5000"});
    return { native, unref() { native.unref(); } };
  },
  cancel(handle) { timerCancelled = true; clearTimeout(handle.native); },
};
const report = (result, exitCode) => writeFileSync(reportPath, JSON.stringify({
  mode: ${JSON.stringify(mode)}, result, exitCode, requestedDelayMs, expectedDelayMs: CREDENTIAL_STARTUP_DEADLINE_MS,
  timerCancelled, timerFired, readyObserved, windowCreated, diagnostics: lines.map((line) => JSON.parse(line)),
}));
const result = await runCredentialStartupTask({
  async run(setPhase) {
      ${runBody}
  },
  exit(code) { report(false, code); app.exit(code); },
  fallbackExit(code) { report(false, code); process.exit(code); },
  writeLine(line) { lines.push(line); },
  timer,
});
if (result) {
  report(true, 0);
  if (window !== null && !window.isDestroyed()) window.close();
  app.quit();
}
`;
}

async function createWatchdogFixture(mode) {
  const fixture = join(root, `watchdog-${mode}`);
  await mkdir(join(fixture, "runtime", "app-data"), { recursive: true });
  await mkdir(join(fixture, "runtime", "user-data"), { recursive: true });
  await writeFile(join(fixture, "package.json"), `${JSON.stringify({ name: `watchdog-${mode}`, version: "0.0.0", private: true, type: "module", main: "bootstrap.cjs" }, null, 2)}\n`, "utf8");
  await writeFile(join(fixture, "bootstrap.cjs"), bootstrapSource(), "utf8");
  await copyFile(join(appRoot, "dist", "main", "startup-diagnostic.js"), join(fixture, "startup-diagnostic.js"));
  await copyFile(join(appRoot, "dist", "main", "startup-deadline.cjs"), join(fixture, "startup-deadline.cjs"));
  await writeFile(join(fixture, "main.mjs"), watchdogMainSource(mode), "utf8");
  return fixture;
}

async function runWatchdogFixture(mode) {
  const fixture = await createWatchdogFixture(mode);
  const child = spawn(electronExecutable, [fixture], {
    cwd: fixture,
    env: productionHostEnvironment(process.env),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  let parentTimedOut = false;
  const timeout = setTimeout(() => { parentTimedOut = true; child.kill(); }, 10_000);
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => { resolveExit(code); });
  }).finally(() => { clearTimeout(timeout); });
  if (parentTimedOut) throw new Error(`Disposable Electron watchdog ${mode} fixture exceeded its parent deadline.`);
  const report = JSON.parse(await readFile(join(fixture, "report.json"), "utf8"));
  return Object.freeze({ mode, exitCode, report });
}

const directAwaited = await runDirectAwaitedFixture();
const awaited = await runFixture("awaited");
const detached = await runFixture("detached");
const guarded = await runCommonJsFixture("guarded");
const unconditional = await runCommonJsFixture("unconditional");
const watchdogTimeout = await runWatchdogFixture("timeout");
const watchdogSuccess = await runWatchdogFixture("success");

if (directAwaited.exitCode !== 90 || directAwaited.report.timedOut !== true || directAwaited.report.readyObserved !== false || directAwaited.report.windowCreated !== false) {
  throw new Error("Direct-ESM awaited startup did not reproduce the readiness deadlock control.");
}
if (awaited.exitCode !== 0 || awaited.report.timedOut !== false || awaited.report.readyObserved !== true || awaited.report.windowCreated !== true) {
  throw new Error("Awaited dynamic-ESM startup unexpectedly blocked Electron readiness.");
}
if (detached.exitCode !== 0 || detached.report.timedOut !== false || detached.report.readyObserved !== true || detached.report.windowCreated !== true || detached.report.evaluationCompleted !== true) {
  throw new Error("Detached module-level startup did not yield to Electron readiness and window creation.");
}
if (guarded.report.requireMainEqualsModule !== false || guarded.exitCode !== 90 || guarded.report.timedOut !== true || guarded.report.windowCreated !== false) {
  throw new Error("Guarded CommonJS package main did not reproduce the inert Electron entry.");
}
if (unconditional.report.requireMainEqualsModule !== false || unconditional.exitCode !== 0 || unconditional.report.timedOut !== false || unconditional.report.readyObserved !== true || unconditional.report.windowCreated !== true) {
  throw new Error("Unconditional CommonJS package main did not reach Electron readiness and window creation.");
}
if (watchdogTimeout.exitCode !== 1 || watchdogTimeout.report.result !== false || watchdogTimeout.report.requestedDelayMs !== 30_000 || watchdogTimeout.report.timerFired !== true || watchdogTimeout.report.timerCancelled !== true || watchdogTimeout.report.windowCreated !== false || watchdogTimeout.report.diagnostics.length !== 1 || watchdogTimeout.report.diagnostics[0]?.phase !== "window-creation" || watchdogTimeout.report.diagnostics[0]?.code !== "STARTUP_TIMEOUT") {
  throw new Error("Disposable Electron pre-window timeout did not remain finite and terminal.");
}
if (watchdogSuccess.exitCode !== 0 || watchdogSuccess.report.result !== true || watchdogSuccess.report.requestedDelayMs !== 30_000 || watchdogSuccess.report.timerFired !== false || watchdogSuccess.report.timerCancelled !== true || watchdogSuccess.report.readyObserved !== true || watchdogSuccess.report.windowCreated !== true || watchdogSuccess.report.diagnostics.length !== 0) {
  throw new Error("Disposable Electron successful readiness did not cancel the startup watchdog and shut down cleanly.");
}

process.stdout.write(`${JSON.stringify({ ok: true, electronVersion, root, directAwaited, awaited, detached, guarded, unconditional, watchdogTimeout, watchdogSuccess }, null, 2)}\n`);
