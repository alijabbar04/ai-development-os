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
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
    process.once(signal, () => { if (!closed) child.kill(signal); });
  }
  return await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      closed = true;
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
