import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { dialog, type BrowserWindow } from "electron";
import { parseNativePlanningRequest, type NativePlanningReply, type NativePlanningRequest } from "../shared/planning-ipc.js";
import { showPlanningConfirmation } from "./planning-confirmation.js";

async function selectedResult(path: string): Promise<Readonly<{ name: string; text: string }>> {
  if (!isAbsolute(path) || process.platform === "win32" && (!/^[A-Za-z]:[\\/]/u.test(path) || path.slice(2).includes(":"))) throw new Error("RESULT_LOCAL_FILE_REQUIRED");
  const deadline = Date.now() + 10_000;
  const check = (): void => { if (Date.now() >= deadline) throw new Error("RESULT_READ_BOUND"); };
  const ancestors = async (): Promise<void> => {
    let cursor = resolve(path);
    for (let count = 0; ; count++) {
      check(); if (count >= 128) throw new Error("RESULT_READ_BOUND");
      const entry = await lstat(cursor); check();
      if (entry.isSymbolicLink()) throw new Error("RESULT_LINK_REFUSED");
      const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
  };
  await ancestors();
  const before = await lstat(path, { bigint: true }), canonical = await realpath(path);
  check();
  if (!before.isFile() || before.nlink !== 1n || before.size > 65536n || !path.toLowerCase().endsWith(".json")) throw new Error("RESULT_FILE_REFUSED");
  const handle = await open(canonical, "r");
  try {
    const bound = await handle.stat({ bigint: true });
    if (!bound.isFile() || bound.dev !== before.dev || bound.ino !== before.ino || bound.size !== before.size || bound.mtimeNs !== before.mtimeNs || bound.nlink !== 1n) throw new Error("RESULT_FILE_CHANGED");
    const bytes = Buffer.alloc(65537); let bytesRead = 0;
    while (bytesRead < bytes.length) { check(); const part = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead); if (part.bytesRead === 0) break; bytesRead += part.bytesRead; }
    const after = await handle.stat({ bigint: true }), named = await lstat(path, { bigint: true }); await ancestors(); check();
    if (BigInt(bytesRead) !== before.size || bytesRead > 65536 || after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1n || after.size !== before.size || after.mtimeNs !== before.mtimeNs
      || !named.isFile() || named.isSymbolicLink() || named.ino !== after.ino || named.dev !== after.dev || named.size !== after.size || named.mtimeNs !== after.mtimeNs || named.nlink !== 1n || await realpath(path) !== canonical) throw new Error("RESULT_FILE_CHANGED");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
    return Object.freeze({ name: basename(canonical), text });
  } finally { await handle.close(); }
}
export async function nativePlanningDialog(window: BrowserWindow, value: NativePlanningRequest): Promise<NativePlanningReply> {
  const request = parseNativePlanningRequest(value);
  if (request.kind === "confirm") {
    return await showPlanningConfirmation(window, request.review);
  }
  const folder = request.kind === "repository";
  const selected = await dialog.showOpenDialog(window, folder
    ? { title: "Select one repository for bounded read-only inspection", properties: ["openDirectory", "dontAddToRecent"] }
    : { title: "Attach an untrusted manual result JSON", properties: ["openFile", "dontAddToRecent"], filters: [{ name: "Planning manual result", extensions: ["json"] }] });
  if (selected.canceled || selected.filePaths.length !== 1) return null;
  return folder ? selected.filePaths[0]! : await selectedResult(selected.filePaths[0]!);
}
