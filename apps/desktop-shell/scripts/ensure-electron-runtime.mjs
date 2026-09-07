import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const require = createRequire(import.meta.url), packageRoot = dirname(require.resolve("electron/package.json"));
const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
if (manifest.version !== "43.4.1") throw new Error("ELECTRON_PACKAGE_PIN_MISMATCH");
const dist = resolve(packageRoot, "dist");
async function installed() {
  const version = await readFile(join(dist, "version"), "utf8"), name = await readFile(join(packageRoot, "path.txt"), "utf8");
  if (version.trim().replace(/^v/u, "") !== manifest.version) throw new Error("ELECTRON_DIST_PIN_MISMATCH");
  const executable = resolve(dist, name.trim()), part = relative(dist, executable);
  if (part === ".." || part.startsWith("..\\") || part.startsWith("../") || isAbsolute(part)) throw new Error("ELECTRON_DIST_ESCAPE");
  await access(executable); return executable;
}
try { await installed(); }
catch (error) {
  if (error.code !== "ENOENT") throw error;
  // The exact npm package carries the archive checksums. Installer environment
  // controls and credentials cannot redirect this explicit preparation step.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:SYSTEMROOT|WINDIR|USERPROFILE|HOME|LOCALAPPDATA|TEMP|TMP|PATH)$/iu.test(name)));
  const child = spawn(process.execPath, [join(packageRoot, "install.js")], { env: environment, shell: false, windowsHide: true, stdio: "inherit" });
  const timeout = setTimeout(() => child.kill(), 180000);
  const code = await new Promise((done, fail) => { child.once("error", fail); child.once("close", done); }).finally(() => clearTimeout(timeout));
  if (code !== 0) throw new Error("ELECTRON_RUNTIME_PREPARATION_FAILED");
  await installed();
}
process.stdout.write(`${JSON.stringify({ ok: true, electron: manifest.version, archiveVerification: "exact-package-checksums", purpose: "owned development runtime" })}\n`);
