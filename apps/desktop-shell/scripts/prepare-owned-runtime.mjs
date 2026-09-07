import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Preparation is explicit and outside the visible-window deadline. Launch never
// falls back to PATH, Electron-as-Node, or an unpinned installed runtime.
const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const pin = JSON.parse(await readFile(join(root, "runtime-pin.json"), "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (process.platform !== pin.platform || process.arch !== pin.arch ||
    process.versions.node !== pin.nodeVersion || process.versions.modules !== pin.modulesAbi ||
    digest(await readFile(process.execPath)) !== pin.sha256) {
  throw new Error("OWNED_RUNTIME_SOURCE_PIN_MISMATCH: prepare with the documented Windows x64 Node runtime.");
}
const runtimeParent = join(root, ".runtime");
try { await mkdir(runtimeParent); } catch (error) { if (error.code !== "EEXIST") throw error; }
if (!(await lstat(runtimeParent)).isDirectory() || (await realpath(runtimeParent)).toLowerCase() !== runtimeParent.toLowerCase()) throw new Error("OWNED_RUNTIME_DIRECTORY_ALIAS");
const directory = join(runtimeParent, `node-${pin.nodeVersion}-${pin.platform}-${pin.arch}`);
try { await mkdir(directory); } catch (error) { if (error.code !== "EEXIST") throw error; }
if ((await realpath(directory)).toLowerCase() !== directory.toLowerCase()) throw new Error("OWNED_RUNTIME_DIRECTORY_ALIAS");
const target = join(directory, "node.exe");
try { await copyFile(process.execPath, target, constants.COPYFILE_EXCL); }
catch (error) { if (error.code !== "EEXIST") throw error; }
if (!(await lstat(target)).isFile() || digest(await readFile(target)) !== pin.sha256) throw new Error("OWNED_RUNTIME_TARGET_PIN_MISMATCH");
process.stdout.write(`${JSON.stringify({ kind: "owned-runtime-prepared", nodeVersion: pin.nodeVersion, modulesAbi: pin.modulesAbi, sha256: pin.sha256, bytes: (await lstat(target)).size })}\n`);
