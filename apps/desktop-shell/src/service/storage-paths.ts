import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";

/** Resolve existing 8.3/case aliases without granting traversal through links.
 * Missing descendants are returned prospectively; this function creates nothing.
 */
export async function canonicalServicePath(input: string): Promise<string> {
  if (!isAbsolute(input) || input.length > 1_024 || input.includes("\0") ||
      process.platform === "win32" && (!/^[A-Za-z]:[\\/]/u.test(input) || input.slice(2).includes(":"))) {
    throw new Error("SERVICE_STORAGE_UNSAFE");
  }
  const requested = resolve(input), components = requested.slice(parse(requested).root.length).split(/[\\/]+/u).filter(Boolean);
  if (components.length > 128) throw new Error("SERVICE_STORAGE_UNSAFE");
  let cursor = parse(requested).root;
  for (let index = 0; index < components.length; index++) {
    const next = join(cursor, components[index]!);
    let observed;
    // Windows file IDs are 64-bit; Number can make distinct identities equal.
    try { observed = await lstat(next, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return join(cursor, ...components.slice(index));
    }
    if (!observed.isDirectory() || observed.isSymbolicLink()) throw new Error("SERVICE_STORAGE_UNSAFE");
    const canonical = await realpath(next), resolved = await lstat(canonical, { bigint: true });
    if (!resolved.isDirectory() || resolved.isSymbolicLink() || observed.dev !== resolved.dev || observed.ino !== resolved.ino) {
      throw new Error("SERVICE_STORAGE_UNSAFE");
    }
    cursor = canonical;
  }
  return cursor;
}
