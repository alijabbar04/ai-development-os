import { join, resolve, sep } from "node:path";
import type { BrowserWindow } from "electron";
import { beforeEach, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({ mode: "stable", reads: 0, closes: 0, stats: 0 }));
const root = resolve("manual-result-identity-control"), selected = join(root, "manual.json"), content = Buffer.from('{"text":"owned manual information"}');
const idA = 9_007_199_254_740_992n, idB = 9_007_199_254_740_993n;
function stat(file: boolean, id: bigint, options?: { bigint?: boolean }, after = false) {
  const integer = (n: bigint) => options?.bigint === true ? n : Number(n);
  const time = 1_700_000_000_000_000_000n + (after && control.mode === "changed-time" ? 100n : 0n);
  return { dev: integer(11n), ino: integer(id), size: integer(file ? BigInt(content.length) : 0n), nlink: integer(1n), mtimeMs: options?.bigint === true ? time / 1_000_000n : Number(time) / 1_000_000, mtimeNs: time,
    isFile: () => file, isDirectory: () => !file, isSymbolicLink: () => false };
}
vi.mock("electron", () => ({ dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }) } }));
vi.mock("../src/main/planning-confirmation.js", () => ({ showPlanningConfirmation: async () => { throw new Error("UNEXPECTED_CONFIRMATION"); } }));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual,
    async lstat(value: string, options?: { bigint?: boolean }) { if (resolve(value) === selected) return stat(true, control.mode === "changed-name" && control.reads > 0 ? idB : idA, options); if (resolve(value) === root) return stat(false, 71n, options); return await actual.lstat(value, options); },
    async realpath(value: string) { return resolve(value) === root || resolve(value).startsWith(root + sep) ? resolve(value) : await actual.realpath(value); },
    async open(value: string, flags: string) { if (resolve(value) !== selected) return await actual.open(value, flags); return {
      async stat(options?: { bigint?: boolean }) { control.stats++; return stat(true, control.mode === "different-opened-file" ? idB : idA, options, control.stats > 1); },
      async read(buffer: Buffer, offset: number, length: number, position: number) { control.reads++; const bytesRead = content.copy(buffer, offset, position, position + length); return { bytesRead, buffer }; },
      async close() { control.closes++; },
    }; },
  };
});
import { nativePlanningDialog } from "../src/main/planning-dialog.js";
beforeEach(() => { control.mode = "stable"; control.reads = 0; control.closes = 0; control.stats = 0; });
const read = () => nativePlanningDialog({} as BrowserWindow, { kind: "result" });
it("imports the selected file when its exact identity remains stable", async () => {
  expect(await read()).toEqual({ name: "manual.json", text: content.toString() });
  expect(control.reads).toBeGreaterThan(0); expect(control.closes).toBe(1);
});
it("refuses rounded-equal substituted file IDs before reading manual-result bytes", async () => {
  control.mode = "different-opened-file"; expect(Number(idA)).toBe(Number(idB));
  let failure: unknown; try { await read(); } catch (error) { failure = error; }
  expect(control.reads).toBe(0); expect(control.closes).toBe(1);
  expect(failure).toMatchObject({ message: "RESULT_FILE_CHANGED" });
});
it.each(["changed-name", "changed-time"])("refuses a selected file with %s after reading", async (mode) => {
  control.mode = mode; await expect(read()).rejects.toThrow("RESULT_FILE_CHANGED"); expect(control.closes).toBe(1);
});
