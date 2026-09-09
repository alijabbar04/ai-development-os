import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { desktopElectronEnvironment } from "./electron-environment.mjs";
import { runSavedRecoverySmoke } from "./recovery-electron-smoke.mjs";
import { runAiPlanningSmoke } from "./ai-planning-electron-smoke.mjs";
import { runProfileLockControl } from "./profile-lock-control.mjs";

const require = createRequire(import.meta.url);
const electron = require("electron");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entry = join(root, "dist", "testing", "electron-smoke-main.js");
const smokeRoot = await mkdtemp(join(tmpdir(), "ai-dev-os-desktop-saved-smoke-"));
const evidenceArgument = process.argv.find((value) => value.startsWith("--evidence-root="))?.slice(16) ?? null;
const evidenceRoot = evidenceArgument === null ? join(tmpdir(), `ai-dev-os-desktop-saved-evidence-${Date.now()}`) : resolve(evidenceArgument);
if (!isAbsolute(evidenceRoot)) throw new Error("Desktop smoke evidence root must be absolute.");
const evidenceRelative = relative(smokeRoot, evidenceRoot);
const evidenceInsideSmokeRoot = evidenceRelative === "" || evidenceRelative !== ".." && !evidenceRelative.startsWith("..\\") && !evidenceRelative.startsWith("../") && !isAbsolute(evidenceRelative);
if (evidenceInsideSmokeRoot) throw new Error("Desktop smoke evidence must remain outside its disposable data root.");

const repositoryRoot = join(smokeRoot, "repository-fixture");
await mkdir(join(repositoryRoot, ".git", "refs", "heads"), { recursive: true });
await writeFile(join(repositoryRoot, ".git", "HEAD"), "ref: refs/heads/main\n", { encoding: "utf8", flag: "wx" });
await writeFile(join(repositoryRoot, ".git", "refs", "heads", "main"), `${"1".repeat(40)}\n`, { encoding: "utf8", flag: "wx" });
await writeFile(join(repositoryRoot, "package.json"), `${JSON.stringify({ name: "garden-field-journal", private: true }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
await mkdir(evidenceRoot, { recursive: true });

const preSeedPhaseSpecs = [
  { phase: "create", mode: "default" },
  { phase: "reopen", mode: "default" },
  { phase: "reopen", mode: "reduced" },
  { phase: "reopen", mode: "forced" },
];
const reports = [];
const createReportPath = join(smokeRoot, "reports", "create-default.json");
let cleanShutdownProven = false;
let failure = null;
let historicalSeed = null;
let historicalVerification = null;
let recovery = null;
let aiPlanning = null;
let profileIsolation = null;
function ownedFixtureEnvironment() {
  const environment = Object.create(null);
  for (const name of ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"]) if (process.env[name] !== undefined) environment[name] = process.env[name];
  return environment;
}

async function runElectron(spec, index) {
  const reportPath = spec.phase === "create" ? createReportPath : join(smokeRoot, "reports", `${index}-${spec.phase}-${spec.mode}.json`);
  await mkdir(dirname(reportPath), { recursive: true });
  const args = [entry, `--smoke-root=${smokeRoot}`, `--smoke-report=${reportPath}`, `--smoke-phase=${spec.phase}`, `--smoke-mode=${spec.mode}`, `--evidence-root=${evidenceRoot}`, `--repository-root=${repositoryRoot}`];
  if (spec.phase === "reopen") args.push(`--baseline-report=${createReportPath}`);
  const child = spawn(electron, args, { env: desktopElectronEnvironment(process.env), shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: false });
  let stdout = "", stderr = "", timedOut = false, abandoned = false;
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-100_000); });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-100_000); });
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    let settled = false, killTimer = null;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(runtimeTimer); if (killTimer !== null) clearTimeout(killTimer); resolveExit(value); };
    child.once("error", (error) => { if (settled) return; settled = true; clearTimeout(runtimeTimer); if (killTimer !== null) clearTimeout(killTimer); rejectExit(error); });
    child.once("exit", (code) => finish(code));
    const runtimeTimer = setTimeout(() => {
      timedOut = true;
      child.kill();
      killTimer = setTimeout(() => { abandoned = true; finish(null); }, 5_000);
    }, 180_000);
  });
  if (timedOut) throw new Error(`Electron ${spec.phase}/${spec.mode} smoke exceeded 180 seconds${abandoned ? " and its parent process exit is unconfirmed" : ""}. Phases: ${stdout.trim().slice(-2_000) || "none"}; diagnostics: ${stderr.trim().slice(-2_000) || "none"}`);
  let report;
  try { report = JSON.parse(await readFile(reportPath, "utf8")); }
  catch { throw new Error(`Electron ${spec.phase}/${spec.mode} smoke produced no report (exit ${exitCode}). Phases: ${stdout.trim().slice(-2_000) || "none"}; diagnostics: ${stderr.trim().slice(-2_000) || "none"}`); }
  if (/(?:bearerToken|startNonce|Authorization: Bearer)/u.test(`${stdout}\n${stderr}`)) throw new Error(`Electron ${spec.phase}/${spec.mode} smoke leaked boundary material.`);
  if (exitCode !== 0 || !Array.isArray(report.failures) || report.failures.length > 0 || report.shutdown?.explicitReceipt !== true) {
    throw new Error(`Electron ${spec.phase}/${spec.mode} smoke failed: ${JSON.stringify(report.failures)}; journey: ${JSON.stringify(report.diagnostics)?.slice(0, 8_000)}; shutdown: ${JSON.stringify(report.shutdown)}; phases: ${stdout.trim().slice(-2_000) || "none"}; diagnostics: ${stderr.trim().slice(-2_000) || "none"}`);
  }
  return report;
}

async function runHistoricalEntry(extraArguments, expectedKind, label) {
  const { resolveOwnedNodeRuntime } = await import(pathToFileURL(join(root, "dist", "main", "owned-runtime.js")).href);
  const ownedNode = await resolveOwnedNodeRuntime(root), seedEntry = join(root, "dist", "testing", "seed-historical-main.js");
  const child = spawn(ownedNode, [seedEntry, smokeRoot, ...extraArguments], { env: ownedFixtureEnvironment(), shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = "", timedOut = false, abandoned = false;
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-100_000); });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-100_000); });
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    let settled = false, killTimer = null;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(runtimeTimer); if (killTimer !== null) clearTimeout(killTimer); resolveExit(value); };
    child.once("error", (error) => { if (settled) return; settled = true; clearTimeout(runtimeTimer); if (killTimer !== null) clearTimeout(killTimer); rejectExit(error); });
    child.once("exit", (code) => finish(code));
    const runtimeTimer = setTimeout(() => { timedOut = true; child.kill(); killTimer = setTimeout(() => { abandoned = true; finish(null); }, 5_000); }, 60_000);
  });
  if (timedOut) throw new Error(`Owned historical ${label} exceeded 60 seconds${abandoned ? " and process exit is unconfirmed" : ""}. Output: ${stdout.trim().slice(-2_000) || "none"}; diagnostics: ${stderr.trim().slice(-2_000) || "none"}`);
  if (/(?:bearerToken|startNonce|Authorization: Bearer)/u.test(`${stdout}\n${stderr}`)) throw new Error(`Owned historical ${label} leaked boundary material.`);
  let result;
  try { result = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1) ?? ""); }
  catch { throw new Error(`Owned historical ${label} produced no result (exit ${exitCode}). Output: ${stdout.trim().slice(-2_000) || "none"}; diagnostics: ${stderr.trim().slice(-2_000) || "none"}`); }
  if (exitCode !== 0 || result?.ok !== true || result?.kind !== expectedKind) throw new Error(`Owned historical ${label} failed (exit ${exitCode}): ${JSON.stringify(result)}; diagnostics: ${stderr.trim().slice(-2_000) || "none"}`);
  return result;
}

try {
  profileIsolation = await runProfileLockControl({ electron, applicationRoot: root, smokeRoot, evidenceRoot });
  for (const [index, spec] of preSeedPhaseSpecs.entries()) {
    const report = await runElectron(spec, index);
    reports.push({ phase: spec.phase, mode: spec.mode, assertions: report.assertions, baseline: report.baseline, historyReconciled: report.historyReconciled ?? null, diagnostics: report.diagnostics ?? null, shutdown: report.shutdown });
  }
  historicalSeed = await runHistoricalEntry([], "owned-synthetic-history-fixture", "seed");
  const historySpec = { phase: "history", mode: "default" }, historyReport = await runElectron(historySpec, preSeedPhaseSpecs.length);
  reports.push({ phase: historySpec.phase, mode: historySpec.mode, assertions: historyReport.assertions, baseline: historyReport.baseline, historyReconciled: historyReport.historyReconciled ?? null, diagnostics: historyReport.diagnostics ?? null, shutdown: historyReport.shutdown });
  historicalVerification = await runHistoricalEntry(["--verify-result"], "owned-synthetic-history-verification", "verification");
  if (historicalVerification.approvalUnchanged !== true || historicalVerification.consumptionCount !== 1 || historicalVerification.amountMinorUnits !== 500 || historicalVerification.currency !== "GBP"
    || historicalVerification.spendingState !== "reconciled" || historicalVerification.stillStopped !== true || historicalVerification.planUnchanged !== true || historicalVerification.scopeApprovalUnchanged !== true) {
    throw new Error(`Owned historical verification contract failed: ${JSON.stringify(historicalVerification)}`);
  }
  const evidence = await Promise.all((await readdir(evidenceRoot, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".png")).map(async (entry) => (await lstat(join(evidenceRoot, entry.name))).size));
  if (evidence.length !== 7 || evidence.reduce((total, size) => total + size, 0) > 10_000_000) throw new Error(`Electron journey evidence bounds failed: ${evidence.length} PNG files, ${evidence.reduce((total, size) => total + size, 0)} bytes.`);
  cleanShutdownProven = profileIsolation?.ok === true && reports.length === preSeedPhaseSpecs.length + 1 && reports.every((item) => item.shutdown.explicitReceipt === true);
  if (!cleanShutdownProven) throw new Error("Electron journey did not produce explicit clean shutdown receipts.");
  recovery = await runSavedRecoverySmoke({ electron, applicationRoot: root, smokeRoot, evidenceRoot });
  cleanShutdownProven = cleanShutdownProven && recovery.ok === true && recovery.phases.every(item => item.shutdown.explicitReceipt === true);
  const allCaptures = await Promise.all((await readdir(evidenceRoot, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith(".png")).map(async entry => (await lstat(join(evidenceRoot, entry.name))).size));
  if (allCaptures.length !== 9 || allCaptures.reduce((sum, size) => sum + size, 0) > 10_000_000) throw new Error("Combined Electron recovery evidence exceeds its bounds.");
  aiPlanning = await runAiPlanningSmoke({ electron, applicationRoot: root, smokeRoot, evidenceRoot });
  cleanShutdownProven = cleanShutdownProven && aiPlanning.ok === true && aiPlanning.phases.every(item => item.shutdown.explicitReceipt === true);
  const finalCaptures = await Promise.all((await readdir(evidenceRoot, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith(".png")).map(async entry => (await lstat(join(evidenceRoot, entry.name))).size));
  if (finalCaptures.length !== 11 || finalCaptures.reduce((sum, size) => sum + size, 0) > 10_000_000) throw new Error("Combined Electron AI planning evidence exceeds its bounds.");
} catch (error) {
  failure = error instanceof Error ? error.message : "Unclassified Electron journey failure.";
}

let cleanupAuthorized = false;
let canonicalCleanupRoot = null;
if (failure === null && cleanShutdownProven) {
  try {
    const smokeStat = await lstat(smokeRoot), canonical = await realpath(smokeRoot), canonicalTemporaryRoot = await realpath(tmpdir());
    const ownedName = basename(smokeRoot).startsWith("ai-dev-os-desktop-saved-smoke-") && basename(canonical).startsWith("ai-dev-os-desktop-saved-smoke-");
    cleanupAuthorized = smokeStat.isDirectory() && !smokeStat.isSymbolicLink() && dirname(canonical).toLowerCase() === canonicalTemporaryRoot.toLowerCase() && ownedName;
    if (cleanupAuthorized) canonicalCleanupRoot = canonical;
    if (!cleanupAuthorized) failure = `Refusing to remove unverified smoke root: ${smokeRoot}`;
  } catch (error) { failure = error instanceof Error ? error.message : "Smoke root verification failed."; }
}
const reportValue = () => ({
  schemaVersion: 1,
  ok: failure === null,
  electron: require("electron/package.json").version,
  provenance: "native folder/result selections are synthetic; actual main-owned confirmation window/preload/IPC/application/child/SQLite real, confirmation buttons automated",
  evidenceRoot,
  temporaryDataRoot: smokeRoot,
  temporaryDataRootPreserved: failure !== null || !cleanupAuthorized,
  phases: reports,
  baseline: reports[0]?.baseline ?? null,
  historicalSeed,
  historicalVerification,
  recovery,
  aiPlanning,
  profileIsolation,
  historyReconciled: reports.find((item) => item.phase === "history")?.historyReconciled ?? null,
  failure,
});
await writeFile(join(evidenceRoot, "ELECTRON-JOURNEY.json"), `${JSON.stringify(reportValue(), null, 2)}\n`, "utf8");

if (cleanupAuthorized && failure === null) {
  try {
    if (canonicalCleanupRoot === null) throw new Error("Verified smoke cleanup root is unavailable.");
    await rm(canonicalCleanupRoot, { recursive: true, force: false });
    process.stdout.write(`${JSON.stringify(reportValue(), null, 2)}\n`);
  } catch (error) {
    cleanupAuthorized = false;
    failure = error instanceof Error ? error.message : "Smoke root cleanup failed.";
    await writeFile(join(evidenceRoot, "ELECTRON-JOURNEY.json"), `${JSON.stringify(reportValue(), null, 2)}\n`, "utf8");
    process.stderr.write(`Electron journey evidence preserved at ${smokeRoot}\n${failure}\n`);
    process.exitCode = 1;
  }
} else {
  process.stderr.write(`Electron journey evidence preserved at ${smokeRoot}\n${failure}\n`);
  process.exitCode = 1;
}
