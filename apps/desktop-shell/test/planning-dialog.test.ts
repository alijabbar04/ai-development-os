import { link, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { BrowserWindow } from "electron";
import { afterEach, expect, it, vi } from "vitest";

const picker = vi.hoisted(() => ({ selected: { canceled: false, filePaths: [] as string[] }, opened: 0 }));
vi.mock("electron", () => ({ dialog: { showOpenDialog: async () => { picker.opened++; return picker.selected; } } }));
vi.mock("../src/main/planning-confirmation.js", () => ({ showPlanningConfirmation: async () => { throw new Error("CONFIRMATION_NOT_PART_OF_FILE_GRANT"); } }));
import { nativePlanningDialog } from "../src/main/planning-dialog.js";
const parent = {} as BrowserWindow, owned: string[] = [];
afterEach(async () => {
  picker.selected = { canceled: false, filePaths: [] }; picker.opened = 0;
  for (const root of owned.splice(0)) {
    const canonical = await realpath(root), parent = await realpath(tmpdir());
    if (dirname(canonical).toLowerCase() !== parent.toLowerCase() || !basename(root).startsWith("saved-result-picker-") || (await lstat(root)).isSymbolicLink()) throw new Error("RESULT_FIXTURE_OWNERSHIP_CHANGED");
    await rm(canonical, { recursive: true });
  }
});
async function fixture() { const root = await mkdtemp(join(tmpdir(), "saved-result-picker-")); owned.push(root); return root; }
it("reads only the one explicitly chosen regular JSON and retains untrusted text for application validation", async () => {
  const root = await fixture(), path = join(root, "manual.json"), text = JSON.stringify({ kind: "planning-manual-result", authority: "none", text: "Owned manual observation" });
  await writeFile(path, text); picker.selected.filePaths = [path];
  expect(await nativePlanningDialog(parent, { kind: "result" })).toEqual({ name: "manual.json", text });
  expect(picker.opened).toBe(1);
});
it.each(["hardlink", "junction", "oversized", "invalid-utf8", "wrong-extension", "directory"] as const)("refuses a selected %s without importing its contents", async (kind) => {
  const root = await fixture(); let path = join(root, kind === "wrong-extension" ? "manual.txt" : "manual.json");
  if (kind === "directory") await mkdir(path);
  else await writeFile(path, kind === "oversized" ? "x".repeat(65537) : kind === "invalid-utf8" ? Buffer.from([0xc3, 0x28]) : "{\"owned\":true}");
  if (kind === "hardlink") await link(path, join(root, "second.json"));
  if (kind === "junction") {
    const real = join(root, "real"), alias = join(root, "alias"); await mkdir(real); await writeFile(join(real, "manual.json"), "{}");
    await symlink(real, alias, process.platform === "win32" ? "junction" : "dir"); path = join(alias, "manual.json");
  }
  picker.selected.filePaths = [path]; await expect(nativePlanningDialog(parent, { kind: "result" })).rejects.toThrow();
});
it("does not convert a cancelled or ambiguous picker result into any grant", async () => {
  picker.selected = { canceled: true, filePaths: ["not-opened.json"] }; expect(await nativePlanningDialog(parent, { kind: "result" })).toBeNull();
  picker.selected = { canceled: false, filePaths: ["first.json", "second.json"] }; expect(await nativePlanningDialog(parent, { kind: "result" })).toBeNull();
  picker.selected.filePaths = ["relative.json"]; await expect(nativePlanningDialog(parent, { kind: "result" })).rejects.toThrow("RESULT_LOCAL_FILE_REQUIRED");
});
it("rejects renderer-supplied paths before opening a native picker", async () => {
  await expect(nativePlanningDialog(parent, { kind: "result", path: "forged.json" } as never)).rejects.toThrow(); expect(picker.opened).toBe(0);
});
