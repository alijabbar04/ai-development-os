import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import electronExecutable from "electron";

const tempBase = resolve(tmpdir());
const smokeRoot = await mkdtemp(join(tempBase, "ai-dev-os-stage18e-electron-"));
const resolvedRoot = resolve(smokeRoot);
if (!resolvedRoot.startsWith(tempBase + sep) || !basename(resolvedRoot).startsWith("ai-dev-os-stage18e-electron-")) {
  throw new Error("The Electron smoke temporary root escaped the OS temporary directory.");
}

const childScript = fileURLToPath(new URL("./electron-safe-storage-smoke-child.mjs", import.meta.url));

async function runSmoke() {
  const inheritedRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  let child;
  try {
    delete process.env.ELECTRON_RUN_AS_NODE;
    child = spawn(electronExecutable, [childScript, resolvedRoot], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } finally {
    if (inheritedRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = inheritedRunAsNode;
  }
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { if (stdout.length < 16_384) stdout += chunk; });
  child.stderr.on("data", (chunk) => { if (stderr.length < 16_384) stderr += chunk; });
  const timeout = setTimeout(() => { child.kill(); }, 30_000);
  try {
    const exitCode = await new Promise((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("exit", (code) => resolvePromise(code));
    });
    if (exitCode !== 0 || stdout.trim() !== '{"electronAsyncSafeStorage":"ok","productionBroker":"ok","syntheticOnly":true}') {
      const stage = await readFile(join(resolvedRoot, "stage.txt"), "utf8").catch(() => "not-started");
      throw new Error(stderr.trim() || `The Electron safe-storage smoke returned an invalid result at stage ${stage}.`);
    }
    process.stdout.write(`${stdout.trim()}\n`);
  } finally {
    clearTimeout(timeout);
  }
}

try {
  await runSmoke();
} finally {
  await rm(resolvedRoot, { recursive: true, force: true, maxRetries: 3 });
  try {
    await access(resolvedRoot);
    throw new Error("The Electron smoke temporary root was not removed.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
