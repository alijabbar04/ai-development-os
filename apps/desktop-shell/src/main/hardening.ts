import type { BrowserWindow as BrowserWindowType, MenuItemConstructorOptions, Session } from "electron";
import { DESKTOP_ENTRY_URL, DESKTOP_SESSION_ARGUMENT } from "../shared/contracts.js";
import { DESKTOP_MIN_HEIGHT, DESKTOP_MIN_WIDTH, VISIBLE_WINDOW_DEADLINE_MS } from "./constants.js";

export interface DesktopWindowOptions {
  readonly desktopSession: Session;
  readonly preloadPath: string;
  readonly sessionToken: string;
}

export async function createHardenedDesktopWindow(options: DesktopWindowOptions): Promise<BrowserWindowType> {
  const { BrowserWindow } = await import("electron");
  const window = new BrowserWindow({
    width: 1_280,
    height: 800,
    minWidth: DESKTOP_MIN_WIDTH,
    minHeight: DESKTOP_MIN_HEIGHT,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: false,
    show: false,
    autoHideMenuBar: true,
    title: "AI Powerhouse — AI Development OS",
    backgroundColor: "#0b0f15",
    webPreferences: {
      preload: options.preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      enableBlinkFeatures: "",
      webviewTag: false,
      devTools: false,
      spellcheck: false,
      backgroundThrottling: false,
      session: options.desktopSession,
      additionalArguments: [`${DESKTOP_SESSION_ARGUMENT}${options.sessionToken}`],
    },
  });
  window.setContentProtection(true);
  window.setMenuBarVisibility(false);
  const refuseNavigation = (event: { preventDefault(): void }): void => event.preventDefault();
  window.webContents.on("will-navigate", refuseNavigation);
  window.webContents.on("will-frame-navigate", refuseNavigation);
  window.webContents.on("will-redirect", refuseNavigation);
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("before-input-event", (event, input) => {
    const history = input.alt && ["ArrowLeft", "ArrowRight", "Left", "Right", "BrowserBack", "BrowserForward"].includes(input.key);
    const reload = input.key === "F5" || input.key === "BrowserRefresh" || ((input.control || input.meta) && input.key.toLowerCase() === "r");
    if (history || reload) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return window;
}

export function hardenDesktopSession(desktopSession: Session): void {
  desktopSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  desktopSession.setPermissionCheckHandler(() => false);
  desktopSession.setDevicePermissionHandler(() => false);
  desktopSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  desktopSession.on("will-download", (event) => event.preventDefault());
}

export function installGlobalWebContentsGuard(app: typeof import("electron").app): void {
  app.on("web-contents-created", (_event, contents) => {
    const refuse = (event: { preventDefault(): void }): void => event.preventDefault();
    contents.on("will-navigate", refuse);
    contents.on("will-frame-navigate", refuse);
    contents.on("will-redirect", refuse);
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
  });
}

export function installDesktopMenu(Menu: typeof import("electron").Menu): void {
  const template: MenuItemConstructorOptions[] = [{
    label: "Edit",
    submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" },
      { role: "delete" }, { role: "selectAll" },
    ],
  }];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export async function loadDesktopWindow(window: BrowserWindowType): Promise<void> {
  await window.loadURL(DESKTOP_ENTRY_URL);
}

export function showDesktopWindowWithinDeadline(window: BrowserWindowType, timeoutMs: number = VISIBLE_WINDOW_DEADLINE_MS): Promise<void> {
  return new Promise<void>((resolveVisible, rejectVisible) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeListener("ready-to-show", show);
      window.removeListener("show", verify);
      window.removeListener("closed", closed);
      if (error === undefined) resolveVisible(); else rejectVisible(error);
    };
    const verify = (): void => {
      try {
        if (!window.isDestroyed() && window.isVisible()) finish();
      } catch { finish(new Error("DESKTOP_WINDOW_VISIBILITY_FAILED")); }
    };
    const show = (): void => {
      try { if (!window.isDestroyed()) window.show(); verify(); }
      catch { finish(new Error("DESKTOP_WINDOW_VISIBILITY_FAILED")); }
    };
    const closed = (): void => finish(new Error("DESKTOP_WINDOW_CLOSED_DURING_STARTUP"));
    const timer = setTimeout(() => finish(new Error("DESKTOP_VISIBLE_DEADLINE_EXCEEDED")), timeoutMs);
    window.once("ready-to-show", show);
    window.once("show", verify);
    window.once("closed", closed);
  });
}
