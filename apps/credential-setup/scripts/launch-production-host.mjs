import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const productionMain = "dist/main/startup-bootstrap.cjs";
const removedRuntimeControlPrefixes = Object.freeze(["ELECTRON_", "NODE_"]);
const removedRuntimeControls = Object.freeze(["GOOGLE_API_KEY"]);

function asciiEnvironmentNameStartsWith(left, right) {
  if (left.length < right.length) return false;
  for (let index = 0; index < right.length; index += 1) {
    const leftCode = left.charCodeAt(index);
    const foldedLeftCode = leftCode >= 97 && leftCode <= 122 ? leftCode - 32 : leftCode;
    if (foldedLeftCode !== right.charCodeAt(index)) return false;
  }
  return true;
}

function asciiEnvironmentNameEquals(left, right) {
  return left.length === right.length && asciiEnvironmentNameStartsWith(left, right);
}

export const PRODUCTION_STARTUP_FAILURE_LINE = `${JSON.stringify({
  schemaVersion: 1,
  operation: "credential-host-startup",
  phase: "runtime-binding",
  code: "STARTUP_FAILED",
  terminal: true,
})}\n`;

export function productionHostEnvironment(source) {
  const output = Object.create(null);
  for (const [key, value] of Object.entries(source)) {
    if (removedRuntimeControlPrefixes.some((prefix) => asciiEnvironmentNameStartsWith(key, prefix))) continue;
    if (removedRuntimeControls.some((control) => asciiEnvironmentNameEquals(key, control))) continue;
    if (typeof value === "string") output[key] = value;
  }
  output.NODE_ENV = "production";
  return output;
}

export function productionHostTargetFromLayout(layout) {
  const { packagePath, packageVersion, executablePath, distributionVersion, applicationMain } = layout;
  const packageRoot = dirname(packagePath);
  if (packageVersion !== "43.4.1") throw new Error("ELECTRON_VERSION_UNREVIEWED");
  const distRoot = resolve(packageRoot, "dist");
  if (distributionVersion.trim().replace(/^v/u, "") !== packageVersion) throw new Error("ELECTRON_VERSION_UNREVIEWED");
  const executable = resolve(distRoot, executablePath.trim());
  const executableRelative = relative(distRoot, executable);
  if (executableRelative.startsWith("..") || isAbsolute(executableRelative)) throw new Error("ELECTRON_BINDING_UNAVAILABLE");
  if (applicationMain !== productionMain) throw new Error("ELECTRON_BINDING_UNAVAILABLE");
  const entry = resolve(appRoot, applicationMain);
  const entryRelative = relative(appRoot, entry);
  if (entryRelative !== join("dist", "main", "startup-bootstrap.cjs") || isAbsolute(entryRelative)) throw new Error("ELECTRON_BINDING_UNAVAILABLE");
  return Object.freeze({ executable, application: appRoot, entry, cwd: appRoot });
}

export async function resolveProductionHostTarget() {
  const packagePath = require.resolve("electron/package.json");
  const packageRoot = dirname(packagePath);
  const distRoot = resolve(packageRoot, "dist");
  const [manifestText, executablePath, distributionVersion, applicationManifestText] = await Promise.all([
    readFile(packagePath, "utf8"),
    readFile(join(packageRoot, "path.txt"), "utf8"),
    readFile(join(distRoot, "version"), "utf8"),
    readFile(join(appRoot, "package.json"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const applicationManifest = JSON.parse(applicationManifestText);
  return productionHostTargetFromLayout({
    packagePath,
    packageVersion: manifest.version,
    executablePath,
    distributionVersion,
    applicationMain: applicationManifest.main,
  });
}

export async function resolveProductionHostLaunch() {
  const target = await resolveProductionHostTarget();
  await Promise.all([access(target.executable), access(target.entry)]);
  return target;
}

export function terminateProductionHostTree(child, signal, options = {}) {
  const platform = options.platform ?? process.platform;
  const spawnChild = options.spawnChild ?? spawn;
  if (platform !== "win32") return child.kill(signal);
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return child.kill(signal);
  const systemRoot = options.systemRoot ?? process.env.SystemRoot;
  if (typeof systemRoot !== "string" || !isAbsolute(systemRoot)) return child.kill(signal);
  const root = resolve(systemRoot);
  const taskkill = resolve(root, "System32", "taskkill.exe");
  if (relative(root, taskkill) !== join("System32", "taskkill.exe")) return child.kill(signal);
  try {
    const reaper = spawnChild(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
      cwd: root,
      env: productionHostEnvironment(process.env),
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    let fallbackUsed = false;
    const fallback = () => {
      if (fallbackUsed) return;
      fallbackUsed = true;
      try { child.kill(signal); } catch { /* the exact tree reaper remains the primary path */ }
    };
    reaper.once("error", fallback);
    reaper.once("close", (code) => { if (code !== 0) fallback(); });
    return true;
  } catch {
    return child.kill(signal);
  }
}

export async function launchProductionHost() {
  const target = await resolveProductionHostLaunch();
  const child = spawn(target.executable, [target.application], {
    cwd: target.cwd,
    env: productionHostEnvironment(process.env),
    stdio: "inherit",
    windowsHide: false,
    shell: false,
  });
  let closed = false;
  let terminating = false;
  const signalHandlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
    const handler = () => {
      if (closed || terminating) return;
      terminating = true;
      terminateProductionHostTree(child, signal);
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  const removeSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    signalHandlers.clear();
  };
  return await new Promise((resolveExit, reject) => {
    child.once("error", (error) => { closed = true; removeSignalHandlers(); reject(error); });
    child.once("close", (code) => {
      closed = true;
      removeSignalHandlers();
      resolveExit(typeof code === "number" ? code : 1);
    });
  });
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error("START_ARGUMENTS_REFUSED");
    process.exitCode = await launchProductionHost();
  } catch {
    try { writeSync(2, PRODUCTION_STARTUP_FAILURE_LINE); } catch { /* bounded startup failure */ }
    process.exitCode = 1;
  }
}
