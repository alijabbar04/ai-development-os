import { join, resolve, sep } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { canonicalPlanningDirectory, inspectPlanningRepository } from "../src/planning-repository.js";

const boundary = vi.hoisted(() => ({ mode: "same-file", reads: 0, closes: 0, stats: 0 }));
const base = resolve("repository-identity-control"), selected = join(base, "selected"), other = join(base, "other"), headPath = join(selected, ".git", "HEAD");
const idA = 9_007_199_254_740_992n, idB = 9_007_199_254_740_993n, contents = Buffer.from("a".repeat(40) + "\n");
function stat(directory: boolean, id: bigint, options?: { bigint?: boolean }, after = false) {
  const integer = (value: bigint) => options?.bigint === true ? value : Number(value);
  const time = 1_700_000_000_000_000_000n + (after && boundary.mode === "changed-time" ? 100n : 0n);
  return {
    dev: integer(11n), ino: integer(id), size: integer(directory ? 0n : BigInt(contents.length)),
    nlink: integer(after && boundary.mode === "changed-links" ? 2n : 1n),
    mtimeMs: options?.bigint === true ? time / 1_000_000n : Number(time) / 1_000_000, mtimeNs: time,
    isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false,
  };
}
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    async lstat(value: string, options?: { bigint?: boolean }) {
      const path = resolve(value);
      if (path === headPath) return stat(false, idA, options);
      if ([base, selected, other, join(selected, ".git")].includes(path)) return stat(true, path === other && boundary.mode === "different-directory" ? idB : idA, options);
      if (path.startsWith(base + sep)) throw Object.assign(new Error("missing owned virtual entry"), { code: "ENOENT" });
      return await actual.lstat(value, options);
    },
    async realpath(value: string) {
      const path = resolve(value);
      if (path === selected && boundary.mode.endsWith("directory")) return other;
      return path === base || path.startsWith(base + sep) ? path : await actual.realpath(value);
    },
    async open(value: string, flags: string) {
      if (resolve(value) !== headPath) return await actual.open(value, flags);
      return {
        async stat(options?: { bigint?: boolean }) { boundary.stats += 1; return stat(false, boundary.mode === "different-file" ? idB : idA, options, boundary.stats > 1); },
        async read(buffer: Buffer) { boundary.reads += 1; contents.copy(buffer); return { bytesRead: contents.length, buffer }; },
        async close() { boundary.closes += 1; },
      };
    },
  };
});
beforeEach(() => { boundary.mode = "same-file"; boundary.reads = 0; boundary.closes = 0; boundary.stats = 0; });
const observedHead = async () => (await inspectPlanningRepository(selected, "2026-09-08T00:00:00.000Z")).report.facts.find((fact) => fact.kind === "git-head")?.value;

it("allows a canonical alias only when it retains the exact selected directory identity", async () => {
  boundary.mode = "same-directory";
  expect(await canonicalPlanningDirectory(selected)).toBe(other);
});
it("refuses a different directory introduced during canonical resolution", async () => {
  boundary.mode = "different-directory";
  await expect(canonicalPlanningDirectory(selected)).rejects.toMatchObject({ reason: "repository.root-changed" });
});
it("reads a stable reference through the same exact 64-bit file identity", async () => {
  expect(await observedHead()).toBe("a".repeat(40));
  expect(boundary.reads).toBe(2); expect(boundary.closes).toBe(2);
});
it("closes a substituted reference before reading when distinct 64-bit IDs round to the same Number", async () => {
  boundary.mode = "different-file";
  // The Number equality is the planted broken control; the production read
  // boundary must distinguish these legitimate exact file IDs before I/O.
  expect(Number(idA)).toBe(Number(idB));
  expect(await observedHead()).toBeUndefined();
  expect(boundary.reads).toBe(0); expect(boundary.closes).toBe(1);
});
it.each(["changed-time", "changed-links"])("refuses a reference that has %s during the bounded read", async (mode) => {
  boundary.mode = mode;
  expect(await observedHead()).toBeUndefined();
  expect(boundary.reads).toBe(1); expect(boundary.closes).toBe(1);
});
