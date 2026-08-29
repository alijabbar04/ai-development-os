import { readdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createCanonicalTemporaryRoot } from "./temporary-root.js";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const RAW_AMBIENT_TEMP_ROOT = /mkdtemp\s*\(\s*join\s*\(\s*tmpdir\s*\(\s*\)/u;

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

describe("canonical disposable control-service roots", () => {
  it("creates a direct root whose supplied spelling already equals its real path", async () => {
    const root = await createCanonicalTemporaryRoot("ai-dev-os-canonical-root-");
    try {
      expect(samePath(await realpath(root), root)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps raw ambient temporary aliases out of storage-boundary fixtures", async () => {
    const testFiles = (await readdir(TEST_ROOT))
      .filter((name) => name.endsWith(".test.ts"))
      .sort();
    const text = (await Promise.all(testFiles.map(async (name) => await readFile(join(TEST_ROOT, name), "utf8")))).join("\n");
    expect(RAW_AMBIENT_TEMP_ROOT.test(text)).toBe(false);
    const planted = ["mkdtemp(", "join(", "tmpdir()", ', "planted-"))'].join("");
    expect(RAW_AMBIENT_TEMP_ROOT.test(planted)).toBe(true);
  });
});
