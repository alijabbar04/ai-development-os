import { lstat, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Creates a disposable test root beneath the canonical spelling of the OS
 * temporary directory. Hosted Windows can expose TEMP through an 8.3 or
 * junction-backed alias. Passing that ambient spelling to the artifact store
 * would correctly trigger its fail-closed linked-path boundary before a test
 * reaches the behavior it is intended to exercise.
 */
export async function createCanonicalTemporaryRoot(prefix: string): Promise<string> {
  if (!/^ai-dev-os-[a-z0-9-]+-$/u.test(prefix)) {
    throw new Error("The test temporary-root prefix is not an owned AI Development OS prefix.");
  }
  const canonicalParent = await realpath(tmpdir());
  const root = await mkdtemp(join(canonicalParent, prefix));
  const observed = await lstat(root);
  if (!observed.isDirectory() || observed.isSymbolicLink() || !samePath(await realpath(root), resolve(root))) {
    throw new Error("The test temporary root is not a direct canonical directory.");
  }
  return root;
}
