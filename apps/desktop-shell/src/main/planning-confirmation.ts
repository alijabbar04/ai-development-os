import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, ipcMain, session, type IpcMainEvent } from "electron";
import { exactPlanningRecord, type NativePlanningRequest } from "../shared/planning-ipc.js";

const CHANNEL = "ai-dev-os:native-planning-review-result";
function escape(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
/** A separate main-owned modal with no exposed bridge. The workspace renderer
 * cannot render this content, submit a decision, or reuse its one-use identity. */
export async function showPlanningConfirmation(parent: BrowserWindow, review: Extract<NativePlanningRequest, { kind: "confirm" }>["review"]): Promise<boolean> {
  const identity = randomUUID(), isolated = session.fromPartition(`planning-confirmation:${identity}`);
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on("will-download", (event) => event.preventDefault());
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("data:text/html;charset=utf-8,") }));
  const window = new BrowserWindow({ parent, modal: true, title: review.title, width: 880, height: 680, minWidth: 640, minHeight: 480, show: false, autoHideMenuBar: true,
    webPreferences: { session: isolated, preload: join(dirname(fileURLToPath(import.meta.url)), "../preload/planning-confirmation.cjs"), additionalArguments: [`--planning-review-identity=${identity}`],
      sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false, spellcheck: false, navigateOnDragDrop: false } });
  window.setContentProtection(true); window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'"><title>${escape(review.title)}</title><style>html{font:16px/1.5 'Segoe UI',sans-serif;color:#20342c;background:#f4f6f2}body{margin:0;height:100vh;display:flex;flex-direction:column}header,footer{padding:18px 24px;flex:none}h1{font-size:1.35rem;margin:0}header p{margin:6px 0 0}main{overflow:auto;flex:1;padding:0 24px;white-space:pre-wrap;overflow-wrap:anywhere}footer{display:flex;justify-content:flex-end;gap:12px;border-top:1px solid #b6c8bb}button{font:inherit;padding:9px 16px;border-radius:7px;border:1px solid #375342;background:white;color:#20342c}button:last-child{background:#284d3b;color:white}:focus-visible{outline:3px solid #3776ac;outline-offset:3px}@media(forced-colors:active){button,button:last-child{background:ButtonFace;color:ButtonText;border-color:ButtonText}footer{border-color:CanvasText}}</style></head><body><header><h1 id="review-title">${escape(review.title)}</h1><p>Review the exact action and its effects below. Cancelling does not approve it.</p></header><main id="native-review-content" tabindex="0" aria-labelledby="review-title">${escape(review.detail)}</main><footer><button id="native-cancel" autofocus>Cancel</button><button id="native-confirm">Confirm exact action</button></footer></body></html>`;
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  return await new Promise<boolean>((resolveResult) => {
    let done = false;
    const finish = (accepted: boolean): void => {
      if (done) return; done = true; clearTimeout(timeout); ipcMain.removeListener(CHANNEL, receive); parent.removeListener("closed", cancel);
      if (!window.isDestroyed()) window.destroy(); resolveResult(accepted);
    };
    const cancel = (): void => finish(false);
    const receive = (event: IpcMainEvent, value: unknown): void => {
      if (done || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.sender.session !== isolated || event.sender.getURL() !== url) return;
      try { const message = exactPlanningRecord(value, ["identity", "action"]); if (message["identity"] !== identity || !["confirm", "cancel"].includes(String(message["action"]))) return; finish(message["action"] === "confirm"); }
      catch { /* Malformed input never constitutes operator authority. */ }
    };
    const timeout = setTimeout(cancel, 100_000);
    ipcMain.on(CHANNEL, receive); window.once("closed", cancel); parent.once("closed", cancel);
    window.webContents.on("before-input-event", (event, input) => { if (input.type === "keyDown" && input.key === "Escape") { event.preventDefault(); cancel(); } });
    window.once("ready-to-show", () => { if (!done && !parent.isDestroyed()) { window.show(); window.focus(); } });
    void window.loadURL(url).catch(cancel);
  });
}
