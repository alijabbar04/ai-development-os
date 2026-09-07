import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import type { BrowserWindow as WindowType, IpcMainEvent } from "electron";
const state = vi.hoisted(() => ({ windows: [] as unknown[] }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    ipcMain: new EventEmitter(),
    session: { fromPartition: () => Object.assign(new EventEmitter(), { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } }) },
    BrowserWindow: class extends EventEmitter {
      destroyed = false; url = "";
      webContents: EventEmitter & { session: unknown; mainFrame: object; getURL(): string; setWindowOpenHandler(): void };
      constructor(readonly options: { webPreferences: { session: unknown; additionalArguments: string[] } }) { super(); state.windows.push(this); this.webContents = Object.assign(new EventEmitter(), { session: options.webPreferences.session, mainFrame: {}, getURL: () => this.url, setWindowOpenHandler() {} }); }
      isDestroyed() { return this.destroyed; } setContentProtection() {} setMenu() {} show() {} focus() {}
      destroy() { this.destroyed = true; this.emit("closed"); }
      async loadURL(url: string) { this.url = url; this.emit("ready-to-show"); }
    },
  };
});
import { ipcMain } from "electron";
import { showPlanningConfirmation } from "../src/main/planning-confirmation.js";
interface WindowFake extends EventEmitter { options: { webPreferences: { additionalArguments: string[] } }; url: string; destroyed: boolean; webContents: EventEmitter & { session: unknown; mainFrame: object; getURL(): string }; destroy(): void }
const review = { reviewId: "review:owned", action: "approve-scope" as const, title: "Approve exact local scope", detail: "<script>Never execute this operator prose</script>\nA long scope is scrollable.", subjectDigest: "a".repeat(64) };
afterEach(() => { for (const value of state.windows.splice(0)) (value as WindowFake).destroy(); });
it("requires the exact native window, main frame, session, document and one-use identity", async () => {
  const parent = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WindowType;
  const result = showPlanningConfirmation(parent, review), window = state.windows.at(-1) as WindowFake;
  const identity = window.options.webPreferences.additionalArguments[0]!.slice(27), sender = window.webContents;
  const event = { sender, senderFrame: sender.mainFrame } as unknown as IpcMainEvent;
  const channel = "ai-dev-os:native-planning-review-result";
  ipcMain.emit(channel, { ...event, sender: {} }, { identity, action: "confirm" });
  ipcMain.emit(channel, { ...event, senderFrame: {} }, { identity, action: "confirm" });
  ipcMain.emit(channel, event, { identity: "wrong", action: "confirm" });
  ipcMain.emit(channel, event, { identity, action: "confirm", operatorConfirmed: true });
  const original = window.url; window.url = "https://example.invalid/"; ipcMain.emit(channel, event, { identity, action: "confirm" }); window.url = original;
  expect(window.destroyed).toBe(false); expect(decodeURIComponent(original)).toContain("&lt;script&gt;"); expect(decodeURIComponent(original)).toContain("overflow:auto");
  ipcMain.emit(channel, event, { identity, action: "confirm" }); expect(await result).toBe(true); expect(window.destroyed).toBe(true);
  expect(ipcMain.listenerCount(channel)).toBe(0); ipcMain.emit(channel, event, { identity, action: "confirm" });
});
it("cancels on Escape or parent shutdown, releasing all decision listeners", async () => {
  for (const cause of ["escape", "parent"] as const) {
    const parent = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WindowType;
    const result = showPlanningConfirmation(parent, review), window = state.windows.at(-1) as WindowFake;
    if (cause === "escape") window.webContents.emit("before-input-event", { preventDefault() {} }, { type: "keyDown", key: "Escape" });
    else parent.emit("closed");
    expect(await result).toBe(false); expect(ipcMain.listenerCount("ai-dev-os:native-planning-review-result")).toBe(0);
  }
});
