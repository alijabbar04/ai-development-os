import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOwnedNodeRuntime } from "../dist/main/owned-runtime.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = await resolveOwnedNodeRuntime(root);
const fixture = await mkdtemp(join(tmpdir(), "saved-runtime-probe-"));
const stdout = [];
try {
  const child = spawn(runtime, [join(root, "dist", "testing", "sqlite-runtime-probe.js"), fixture], {
    env: Object.fromEntries(["SYSTEMROOT", "WINDIR", "TEMP", "TMP"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])),
    shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
  const timeout = setTimeout(() => child.kill(), 20_000);
  const exit = await new Promise((resolveExit, reject) => { child.once("exit", resolveExit); child.once("error", reject); }).finally(() => clearTimeout(timeout));
  if (exit !== 0) throw new Error(`OWNED_RUNTIME_SQLITE_PROBE_FAILED: ${stderr}`);
  const result = JSON.parse(Buffer.concat(stdout).toString("utf8"));
  if (result.ok !== true || result.node !== "24.17.0" || result.modulesAbi !== "137" || result.electron !== null || (await realpath(result.execPath)) !== (await realpath(runtime))) throw new Error("OWNED_RUNTIME_SQLITE_IDENTITY_MISMATCH");
  result.runtimeSha256 = createHash("sha256").update(await readFile(runtime)).digest("hex");
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  const resolved = resolve(fixture);
  if (dirname(resolved) !== resolve(tmpdir()) || !resolved.startsWith(join(resolve(tmpdir()), "saved-runtime-probe-"))) throw new Error("SQLITE_PROBE_CLEANUP_OWNERSHIP");
  await rm(resolved, { recursive: true, force: true });
}
