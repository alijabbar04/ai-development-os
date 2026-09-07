import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopElectronEnvironment } from "./electron-environment.mjs";

const require = createRequire(import.meta.url);
const electron = require("electron");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entry = join(root, "dist", "testing", "electron-smoke-main.js");
const smokeRoot = await mkdtemp(join(tmpdir(), "ai-dev-os-desktop-smoke-"));
const evidenceArgument = process.argv.find((value) => value.startsWith("--evidence-root="))?.slice(16);
const evidenceRoot = resolve(evidenceArgument ?? join(smokeRoot, "screenshots"));
if (!isAbsolute(evidenceRoot)) throw new Error("Desktop smoke evidence root must be absolute.");

const reports = [];
try {
  for (const mode of ["default", "reduced", "forced"]) {
    const modeRoot = join(smokeRoot, mode);
    const reportPath = join(modeRoot, "report.json");
    const child = spawn(electron, [entry, `--smoke-root=${modeRoot}`, `--smoke-report=${reportPath}`, `--smoke-mode=${mode}`, `--evidence-root=${evidenceRoot}`], {
      env: desktopElectronEnvironment(process.env), shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-100_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-100_000); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90_000);
    const exitCode = await new Promise((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (code) => resolveExit(code));
    }).finally(() => clearTimeout(timer));
    if (timedOut) throw new Error(`Electron ${mode} smoke timed out. Phases: ${stdout.trim().slice(-2_000) || "none"}; diagnostics: ${stderr.trim().slice(-2_000) || "none"}`);
    let report;
    try { report = JSON.parse(await readFile(reportPath, "utf8")); }
    catch { throw new Error(`Electron ${mode} smoke produced no report (exit ${exitCode}). Phases: ${stdout.trim().slice(-2_000) || "none"}; diagnostics: ${stderr.trim().slice(-2_000) || "none"}`); }
    if (/(?:bearerToken|startNonce|Authorization: Bearer)/u.test(`${stdout}\n${stderr}`)) throw new Error(`Electron ${mode} smoke leaked boundary material.`);
    if (exitCode !== 0 || !Array.isArray(report.failures) || report.failures.length > 0) {
      throw new Error(`Electron ${mode} smoke failed: ${JSON.stringify(report.failures)}; phases: ${stdout.trim().slice(-2_000) || "none"}; diagnostics: ${stderr.trim().slice(-2_000) || "none"}`);
    }
    reports.push({ mode, assertions: Object.keys(report.assertions).length });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, electron: require("electron/package.json").version, evidenceRoot, reports }, null, 2)}\n`);
} finally {
  await rm(smokeRoot, { recursive: true, force: true });
}
