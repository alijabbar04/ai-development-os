import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { productionHostEnvironment, terminateProductionHostTree } from "./launch-production-host.mjs";

const require = createRequire(import.meta.url);
const electronExecutable = require("electron");
const electronVersion = require("electron/package.json").version;
const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const probeMain = join(appRoot, "scripts", "disposable-visible-startup-probe.cjs");
const root = await mkdtemp(join(tmpdir(), "ai-dev-os-visible-startup-"));
if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !basename(root).startsWith("ai-dev-os-visible-startup-")) throw new Error("Visible-startup probe root escaped the OS temporary directory.");

async function runMode(mode) {
  const runtimeRoot = join(root, mode);
  const reportPath = join(runtimeRoot, "report.json");
  await Promise.all([
    mkdir(join(runtimeRoot, "app-data"), { recursive: true }),
    mkdir(join(runtimeRoot, "user-data"), { recursive: true }),
  ]);
  const child = spawn(electronExecutable, [
    probeMain,
    "--probe-mode=" + mode,
    "--probe-root=" + runtimeRoot,
    "--probe-report=" + reportPath,
  ], {
    cwd: appRoot,
    env: productionHostEnvironment(process.env),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
    shell: false,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-100_000); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-100_000); });
  let parentTimedOut = false;
  const parentDeadline = setTimeout(() => {
    parentTimedOut = true;
    terminateProductionHostTree(child, "SIGTERM");
  }, 10_000);
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => { resolveExit(code); });
  }).finally(() => { clearTimeout(parentDeadline); });
  if (parentTimedOut) throw new Error("Disposable Electron " + mode + " probe required external termination.");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  return Object.freeze({ mode, exitCode, parentTimedOut, stdout, stderr, report });
}

const success = await runMode("visibility-success");
const timeout = await runMode("visibility-timeout");
const successEvents = success.report.timeline.map((entry) => entry.event);

if (electronVersion !== "43.4.1") throw new Error("Visible-startup probe used an unreviewed Electron version.");
if (success.exitCode !== 0 || success.parentTimedOut || success.stdout.trim() !== "" || success.stderr.trim() !== "" || success.report.result !== true || success.report.requestedDelayMs !== 30_000 || success.report.scheduleCount !== 1 || success.report.timerFired !== false || success.report.timerCancelled !== true || success.report.loadResolvedVisible !== false || success.report.surfaceReadyVisible !== true || success.report.diagnostics.length !== 0) throw new Error("Disposable Electron visible-startup success contract failed: " + JSON.stringify(success));
if (successEvents.indexOf("load-resolved") === -1 || successEvents.indexOf("show-observed") === -1 || successEvents.indexOf("visibility-verified") === -1 || successEvents.indexOf("surface-ready") === -1 || successEvents.indexOf("load-resolved") >= successEvents.indexOf("show-observed") || successEvents.indexOf("show-observed") >= successEvents.indexOf("visibility-verified") || successEvents.indexOf("visibility-verified") >= successEvents.indexOf("surface-ready")) throw new Error("Surface readiness preceded verified visibility in the disposable Electron success probe.");
if (timeout.exitCode !== 1 || timeout.parentTimedOut || timeout.stdout.trim() !== "" || timeout.stderr.trim() !== "" || timeout.report.result !== false || timeout.report.requestedDelayMs !== 30_000 || timeout.report.scheduleCount !== 1 || timeout.report.timerFired !== true || timeout.report.timerCancelled !== true || timeout.report.loadResolvedVisible !== false || timeout.report.surfaceReadyVisible !== null || timeout.report.diagnostics.length !== 1 || timeout.report.diagnostics[0]?.phase !== "renderer-load" || timeout.report.diagnostics[0]?.code !== "STARTUP_TIMEOUT" || timeout.report.timeline.some((entry) => entry.event === "show-completed" || entry.event === "surface-ready")) throw new Error("Disposable Electron omitted-visibility probe did not self-terminate with one STARTUP_TIMEOUT: " + JSON.stringify(timeout));

const output = { ok: true, electronVersion, externalTerminationRequired: false, success, timeout };
await rm(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify(output, null, 2) + "\n");
