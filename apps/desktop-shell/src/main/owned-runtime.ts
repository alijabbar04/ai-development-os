import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export async function resolveOwnedNodeRuntime(applicationRoot: string): Promise<string> {
  const requestedRoot = resolve(applicationRoot);
  const refuseLinks = async (path: string): Promise<void> => {
    for (let cursor = path, count = 0; ; count++) {
      if (count >= 128 || (await lstat(cursor)).isSymbolicLink()) throw new Error("OWNED_RUNTIME_UNAVAILABLE");
      const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
  };
  await refuseLinks(requestedRoot);
  const root = await realpath(requestedRoot);
  const pinFile = await lstat(join(root, "runtime-pin.json"));
  if (!pinFile.isFile() || pinFile.nlink !== 1) throw new Error("OWNED_RUNTIME_PIN_INVALID");
  const pin = JSON.parse(await readFile(join(root, "runtime-pin.json"), "utf8")) as Record<string, unknown>;
  if (Object.keys(pin).sort().join(",") !== "arch,modulesAbi,nodeVersion,platform,schemaVersion,sha256" ||
      pin["schemaVersion"] !== 1 || pin["platform"] !== "win32" || pin["arch"] !== "x64" ||
      pin["nodeVersion"] !== "24.17.0" || pin["modulesAbi"] !== "137" ||
      pin["sha256"] !== "c6335d08331c23d68b9f2b18adb102002d76ef150b47248e954c507e0d033664" ||
      process.platform !== pin["platform"] || process.arch !== pin["arch"]) throw new Error("OWNED_RUNTIME_PIN_INVALID");
  const executable = join(root, ".runtime", `node-${pin["nodeVersion"]}-${pin["platform"]}-${pin["arch"]}`, "node.exe");
  await refuseLinks(executable);
  const file = await lstat(executable);
  if (!file.isFile() || file.nlink !== 1 ||
      (await realpath(executable)).toLowerCase() !== executable.toLowerCase() ||
      createHash("sha256").update(await readFile(executable)).digest("hex") !== pin["sha256"]) throw new Error("OWNED_RUNTIME_UNAVAILABLE");
  return executable;
}
