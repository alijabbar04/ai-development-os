import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const packagePath = require.resolve("electron/package.json");
const packageRoot = dirname(packagePath);
const manifest = JSON.parse(await readFile(packagePath, "utf8"));
if (manifest.version !== "43.4.1") throw new Error(`Electron runtime pin mismatch: ${String(manifest.version)}`);

for (const name of [
  "ELECTRON_OVERRIDE_DIST_PATH", "ELECTRON_INSTALL_PLATFORM", "ELECTRON_INSTALL_ARCH",
  "npm_config_platform", "npm_config_arch",
  "electron_use_remote_checksums", "npm_config_electron_use_remote_checksums",
  "ELECTRON_USE_REMOTE_CHECKSUMS", "NPM_CONFIG_ELECTRON_USE_REMOTE_CHECKSUMS",
]) {
  if (process.env[name] !== undefined) throw new Error(`Refusing environment-controlled Electron runtime selection: ${name}`);
}

const distRoot = resolve(packageRoot, "dist");

async function installedExecutable() {
  const [pathText, versionText] = await Promise.all([
    readFile(join(packageRoot, "path.txt"), "utf8"),
    readFile(join(distRoot, "version"), "utf8"),
  ]);
  if (versionText.trim().replace(/^v/u, "") !== manifest.version) throw new Error("Electron dist version does not match its exact package pin.");
  const executable = resolve(distRoot, pathText.trim());
  const rel = relative(distRoot, executable);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Electron path.txt escapes the exact package dist directory.");
  await access(executable);
  return executable;
}

let executable;
let restored = false;
try {
  executable = await installedExecutable();
} catch {
  restored = true;
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [join(packageRoot, "install.js")], { stdio: "inherit", windowsHide: true });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => code === 0 ? resolveRun() : rejectRun(new Error(`Exact Electron installer failed (${String(code ?? signal)}).`)));
  });
  executable = await installedExecutable();
}

process.stdout.write(`${JSON.stringify({ ok: true, electron: manifest.version, restored, executable: relative(packageRoot, executable).replaceAll("\\", "/") })}\n`);
