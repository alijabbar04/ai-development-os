import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopElectronEnvironment } from "./electron-environment.mjs";

const require = createRequire(import.meta.url);
const electron = require("electron");
const applicationRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(electron, [applicationRoot], {
  cwd: applicationRoot,
  env: desktopElectronEnvironment(process.env),
  shell: false,
  stdio: "inherit",
  windowsHide: false,
});

const result = await new Promise((resolveExit, rejectExit) => {
  child.once("error", rejectExit);
  child.once("exit", (code, signal) => resolveExit({ code, signal }));
});
if (result.signal !== null) throw new Error(`Desktop Electron exited by signal ${result.signal}.`);
process.exitCode = result.code ?? 1;
