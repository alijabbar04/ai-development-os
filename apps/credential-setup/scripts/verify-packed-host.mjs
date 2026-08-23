import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { productionHostEnvironment, terminateProductionHostTree } from "./launch-production-host.mjs";

const require = createRequire(import.meta.url);
const electronExecutable = require("electron");
const electronVersion = require("electron/package.json").version;
const npmCli = process.env.npm_execpath ?? resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repository = resolve(appRoot, "..", "..");
const root = await mkdtemp(join(tmpdir(), "ai-dev-os-credential-packed-"));
const packs = join(root, "packs");
const consumer = join(root, "consumer");
await mkdir(packs, { recursive: true });
await mkdir(consumer, { recursive: true });

if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !basename(root).startsWith("ai-dev-os-credential-packed-")) throw new Error("Packed verifier root escaped the OS temporary directory.");

const workspaces = [
  "@ai-dev-os/artifacts",
  "@ai-dev-os/providers",
  "@ai-dev-os/domain",
  "@ai-dev-os/policy",
  "@ai-dev-os/secrets",
  "@ai-dev-os/secrets-app-vault",
  "@ai-dev-os/secrets-app-vault-electron",
  "@ai-dev-os/provider-anthropic",
  "@ai-dev-os/credential-ui",
  "@ai-dev-os/credential-setup",
];

async function command(executable, args, options = {}) {
  const child = spawn(executable, args, { cwd: options.cwd ?? repository, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-1_000_000); });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-1_000_000); });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code));
  });
  if (exitCode !== 0) throw new Error(`${executable} ${args[0] ?? ""} failed (${exitCode}): ${stderr.trim().split(/\r?\n/u).slice(-12).join(" | ")}`);
  return { stdout, stderr };
}

function npmCommand(args, options = {}) {
  return command(process.execPath, [npmCli, ...args], options);
}

const tarballs = new Map();
let appFiles = [];
for (const workspace of workspaces) {
  const packed = await npmCommand(["pack", "--workspace", workspace, "--json", "--pack-destination", packs]);
  const parsed = JSON.parse(packed.stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0].filename !== "string") throw new Error(`Invalid npm pack result for ${workspace}.`);
  tarballs.set(workspace, join(packs, parsed[0].filename));
  if (workspace === "@ai-dev-os/credential-setup") appFiles = parsed[0].files.map((file) => file.path);
}

const requiredAppFiles = [
  "dist/main/main.js",
  "dist/main/startup-bootstrap.cjs",
  "dist/main/startup-bootstrap-runtime.cjs",
  "dist/main/startup-deadline.cjs",
  "dist/main/host-service.js",
  "dist/main/anthropic-validation.js",
  "dist/main/anthropic-validation-authorization.js",
  "dist/preload/credential.cjs",
  "dist/renderer/credential/index.html",
  "dist/renderer/credential/entry.js",
  "dist/renderer/credential/entry.css",
  "README.md",
  "package.json",
];
let publishedCandidate = false;
try {
  await access(join(repository, "docs", "release-evidence", "stage-18e-i-subject-manifest.json"));
  publishedCandidate = true;
} catch { publishedCandidate = false; }
if (publishedCandidate) requiredAppFiles.push("dist/main/stage-18e-i-candidate-binding.json");
else if (appFiles.includes("dist/main/stage-18e-i-candidate-binding.json")) throw new Error("Unpublished packed host included a candidate binding.");
for (const path of requiredAppFiles) if (!appFiles.includes(path)) throw new Error(`Packed host omitted ${path}.`);
if (appFiles.some((path) => path.startsWith("src/") || path.startsWith("test/") || path.startsWith("scripts/") || path.startsWith("dist/testing/") || path.includes("coverage"))) throw new Error("Packed host included development or test material.");
const rendererFiles = appFiles.filter((path) => path.startsWith("dist/renderer/credential/")).sort();
if (JSON.stringify(rendererFiles) !== JSON.stringify(["dist/renderer/credential/entry.css", "dist/renderer/credential/entry.js", "dist/renderer/credential/index.html"])) throw new Error("Packed renderer allowlist drifted.");

const dependencies = Object.fromEntries([...tarballs].map(([name, path]) => [name, `file:${relative(consumer, path).replaceAll("\\", "/")}`]));
const consumerManifest = {
  name: "ai-dev-os-credential-packed-consumer",
  version: "0.0.0",
  private: true,
  type: "module",
  dependencies,
  devDependencies: { electron: electronVersion },
};
await writeFile(join(consumer, "package.json"), JSON.stringify(consumerManifest, null, 2), "utf8");
await npmCommand(["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer });
await npmCommand(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer });
await npmCommand(["audit", "--audit-level=high"], { cwd: consumer });

const ui = await import(pathToFileURL(join(consumer, "node_modules", "@ai-dev-os", "credential-ui", "dist", "index.js")).href);
if (ui.projectCredentialStatus === undefined || ui.captureModeActionSet === undefined) throw new Error("Packed credential UI public entry failed.");

const installedApp = join(consumer, "node_modules", "@ai-dev-os", "credential-setup");
const installedManifestPath = join(installedApp, "package.json");
const installedManifest = JSON.parse(await readFile(installedManifestPath, "utf8"));
if (installedManifest.main !== "dist/main/startup-bootstrap.cjs") throw new Error("Packed credential host main entry drifted.");
installedManifest.main = "packed-runtime-wrapper.cjs";
await writeFile(installedManifestPath, JSON.stringify(installedManifest, null, 2), "utf8");
await cp(join(appRoot, "scripts", "packed-runtime-wrapper.cjs"), join(installedApp, "packed-runtime-wrapper.cjs"));

const runtimeRoot = join(root, "runtime");
const runtimeReport = join(runtimeRoot, "report.json");
await mkdir(join(runtimeRoot, "app-data"), { recursive: true });
await mkdir(join(runtimeRoot, "user-data"), { recursive: true });
const child = spawn(electronExecutable, [installedApp, `--packed-root=${runtimeRoot}`, `--packed-report=${runtimeReport}`], {
  env: productionHostEnvironment(process.env),
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: false,
});
let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-200_000); });
child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-200_000); });
let timedOut = false;
const timeout = setTimeout(() => { timedOut = true; terminateProductionHostTree(child, "SIGTERM"); }, 45_000);
const exitCode = await new Promise((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolveExit(code));
}).finally(() => clearTimeout(timeout));
if (timedOut) throw new Error("Packed production host runtime smoke timed out.");
const runtime = JSON.parse(await readFile(runtimeReport, "utf8"));
if (exitCode !== 0 || runtime.ok !== true) throw new Error(`Packed production host runtime failed: ${JSON.stringify(runtime)} ${stderr.trim()}`);
if (runtime.visible !== true) throw new Error("Packed production host was not visibly ready.");
if (!resolve(runtime.appDataPath).startsWith(resolve(runtimeRoot) + sep) || !resolve(runtime.userDataPath).startsWith(resolve(runtimeRoot) + sep)) throw new Error("Packed production host escaped its disposable paths.");
if (JSON.stringify(runtime.renderer?.bridge) !== JSON.stringify(["cancel", "describe", "remove", "rotate", "save", "setEnabled", "validate"])) throw new Error("Packed production host bridge drifted.");
if (runtime.renderer?.validationButtons !== 0) throw new Error("Packed production host exposed validation without an authorization packet.");
if (stdout.includes("SYNTHETIC_CREDENTIAL") || stderr.includes("SYNTHETIC_CREDENTIAL")) throw new Error("Packed runtime emitted a synthetic credential canary.");

process.stdout.write(`${JSON.stringify({ ok: true, electron: electronVersion, root, packages: tarballs.size, appFiles: appFiles.length, rendererFiles, audit: "high-severity clean", cleanInstall: true, runtime }, null, 2)}\n`);
