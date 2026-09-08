import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalServicePath } from "../src/service/storage-paths.js";

const boundary = vi.hoisted(() => ({ alias: "", target: "", changed: false }));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    async lstat(value: string, options?: { bigint?: boolean }) {
      const selected = value === boundary.alias ? boundary.target : value;
      const observed = await actual.lstat(selected, options);
      if (value !== boundary.alias && value !== boundary.target) return observed;
      const exact = value === boundary.target && boundary.changed ? 9_007_199_254_740_993n : 9_007_199_254_740_992n;
      return new Proxy(observed, { get(object, key) {
        if (key === "ino") return options?.bigint === true ? exact : Number(exact);
        const item = Reflect.get(object, key); return typeof item === "function" ? item.bind(object) : item;
      } });
    },
    async realpath(value: string) { return await actual.realpath(value === boundary.alias ? boundary.target : value); },
  };
});

const roots: string[] = [];
afterEach(async () => {
  boundary.alias = ""; boundary.target = ""; boundary.changed = false;
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), "desktop-exact-identity-"))) throw new Error("UNOWNED_FIXTURE");
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "desktop-exact-identity-")); roots.push(root);
  const target = join(root, "directory"); await mkdir(target);
  boundary.target = await realpath(target); boundary.alias = join(boundary.target, "controlled-alias");
  return boundary.alias;
}

it("accepts the same exact 64-bit directory identity through an alias", async () => {
  const alias = await fixture();
  expect(await canonicalServicePath(alias)).toBe(boundary.target);
});

it("refuses different 64-bit identities even when JavaScript Numbers round them equal", async () => {
  const alias = await fixture(); boundary.changed = true;
  // A Number-based identity check is the planted broken control. The I/O seam
  // supplies different legitimate 64-bit IDs to the actual path boundary.
  expect(Number(9_007_199_254_740_992n)).toBe(Number(9_007_199_254_740_993n));
  await expect(canonicalServicePath(alias)).rejects.toThrow("SERVICE_STORAGE_UNSAFE");
});
