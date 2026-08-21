import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entry = join(root, "dist", "testing", "electron-smoke-main.js");
const preview = resolve(root, "..", "..", "docs", "release-evidence", "stage-18e-h-credential-setup.png");
const smokeRoot = await mkdtemp(join(tmpdir(), "ai-dev-os-credential-smoke-"));
const reports = [];

async function run(mode) {
  const modeRoot = join(smokeRoot, mode);
  const reportPath = join(modeRoot, "report.json");
  const args = [entry, `--smoke-root=${modeRoot}`, `--smoke-report=${reportPath}`, `--smoke-mode=${mode}`];
  if (mode === "default") args.push(`--smoke-preview=${preview}`);
  const priorRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  let child;
  try {
    delete process.env.ELECTRON_RUN_AS_NODE;
    child = spawn(electron, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  } finally {
    if (priorRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = priorRunAsNode;
  }
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-200_000); });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-200_000); });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 60_000);
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code));
  }).finally(() => clearTimeout(timeout));
  if (timedOut) {
    const stage = await readFile(join(modeRoot, "stage.txt"), "utf8").catch(() => "not-started");
    throw new Error(`Electron ${mode} smoke timed out at ${stage}.`);
  }
  const diagnosticLeak = stdout.includes("SYNTHETIC_CREDENTIAL_STAGE18E") || stderr.includes("SYNTHETIC_CREDENTIAL_STAGE18E");
  let report;
  try { report = JSON.parse(await readFile(reportPath, "utf8")); }
  catch { throw new Error(`Electron ${mode} smoke did not produce a report (exit ${exitCode}).`); }
  if (diagnosticLeak) throw new Error(`Electron ${mode} smoke leaked its synthetic canary to process diagnostics.`);
  if (exitCode !== 0 || !Array.isArray(report.failures) || report.failures.length !== 0) {
    const tail = stderr.trim().split(/\r?\n/u).slice(-8).join(" | ");
    throw new Error(`Electron ${mode} smoke failed (exit ${exitCode}): ${JSON.stringify(report.failures)}${tail.length === 0 ? "" : `; ${tail}`}`);
  }
  reports.push({ mode, reportPath, assertions: Object.keys(report.assertions).length });
}

for (const mode of ["default", "reduced", "forced"]) await run(mode);
process.stdout.write(`${JSON.stringify({ ok: true, electron: require("electron/package.json").version, smokeRoot, preview, reports }, null, 2)}\n`);
