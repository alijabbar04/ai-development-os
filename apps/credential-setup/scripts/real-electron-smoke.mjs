import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { productionHostEnvironment } from "./launch-production-host.mjs";
import { selectSmokePreview } from "./smoke-preview-policy.mjs";

const require = createRequire(import.meta.url);
const electron = require("electron");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entry = join(root, "dist", "testing", "electron-smoke-main.js");
const smokeRoot = await mkdtemp(join(tmpdir(), "ai-dev-os-credential-smoke-"));
const committedPreview = resolve(root, "..", "..", "docs", "release-evidence", "stage-18e-h-credential-setup.png");
const previewPolicy = selectSmokePreview(process.argv.slice(2), { smokeRoot, committedPreview });
const preview = previewPolicy.path;
const reports = [];
const FINITE_LABEL = /^[a-z0-9][a-z0-9-]{0,79}$/u;
const CREDENTIAL_DIAGNOSTIC = /(?:SYNTHETIC_(?:CREDENTIAL|REPLACEMENT)_STAGE18E|sk-ant-api\d{2}-[A-Za-z0-9_-]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|sk-or-v1-[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9]{32,})/u;

function finiteLabel(value, fallback) {
  return typeof value === "string" && FINITE_LABEL.test(value) ? value : fallback;
}

async function run(mode) {
  const modeRoot = join(smokeRoot, mode);
  const reportPath = join(modeRoot, "report.json");
  const args = [entry, `--smoke-root=${modeRoot}`, `--smoke-report=${reportPath}`, `--smoke-mode=${mode}`];
  if (mode === "default") args.push(`--smoke-preview=${preview}`);
  const child = spawn(electron, args, {
    env: productionHostEnvironment(process.env),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
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
    const rawStage = await readFile(join(modeRoot, "stage.txt"), "utf8").catch(() => "not-started");
    const stage = finiteLabel(rawStage.trim(), "unclassified");
    throw new Error(`Electron ${finiteLabel(mode, "unknown")} smoke timed out at ${stage}.`);
  }
  const diagnosticLeak = CREDENTIAL_DIAGNOSTIC.test(stdout) || CREDENTIAL_DIAGNOSTIC.test(stderr);
  let report;
  try { report = JSON.parse(await readFile(reportPath, "utf8")); }
  catch { throw new Error(`Electron ${mode} smoke did not produce a report (exit ${exitCode}).`); }
  if (diagnosticLeak) throw new Error(`Electron ${mode} smoke leaked its synthetic canary to process diagnostics.`);
  if (exitCode !== 0 || !Array.isArray(report.failures) || report.failures.length !== 0) {
    const stage = finiteLabel(report.stage, "unclassified");
    const failures = report.failures
      .slice(0, 100)
      .map((name) => finiteLabel(name, "unclassified"));
    throw new Error(`Electron ${finiteLabel(mode, "unknown")} smoke failed (exit ${exitCode}): ${JSON.stringify({ stage, failures })}`);
  }
  reports.push({ mode, reportPath, assertions: Object.keys(report.assertions).length });
}

for (const mode of ["default", "reduced", "forced"]) await run(mode);
process.stdout.write(`${JSON.stringify({ ok: true, electron: require("electron/package.json").version, smokeRoot, preview, regeneratesEvidence: previewPolicy.regeneratesEvidence, reports }, null, 2)}\n`);
