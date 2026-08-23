import { join } from "node:path";
import type { BrowserWindow as BrowserWindowType, MenuItemConstructorOptions, Session } from "electron";
import { CREDENTIAL_ENTRY_URL, CREDENTIAL_SESSION_ARGUMENT } from "./constants.js";

export interface CredentialWindowOptions {
  readonly credentialSession: Session;
  readonly preloadPath: string;
  readonly sessionToken: string;
}

export function installMinimalEditMenu(Menu: typeof import("electron").Menu): void {
  const template: MenuItemConstructorOptions[] = [{
    label: "Edit",
    submenu: [
      { role: "paste" },
      { role: "delete" },
      { role: "selectAll" },
    ],
  }];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export async function createHardenedCredentialWindow(options: CredentialWindowOptions): Promise<BrowserWindowType> {
  const { BrowserWindow } = await import("electron");
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 700,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: false,
    show: false,
    autoHideMenuBar: true,
    title: "Credential setup — AI Development OS",
    backgroundColor: "#0f1114",
    webPreferences: {
      preload: join(options.preloadPath),
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
      session: options.credentialSession,
      additionalArguments: [`${CREDENTIAL_SESSION_ARGUMENT}${options.sessionToken}`],
    },
  });
  window.setContentProtection(true);
  window.setMenuBarVisibility(false);
  window.once("close", (event) => {
    event.preventDefault();
    if (!window.isDestroyed()) window.destroy();
  });
  const refuseNavigation = (event: { preventDefault(): void }): void => {
    event.preventDefault();
    if (!window.isDestroyed()) window.destroy();
  };
  window.webContents.on("will-navigate", refuseNavigation);
  window.webContents.on("will-frame-navigate", refuseNavigation);
  window.webContents.on("will-redirect", refuseNavigation);
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("will-prevent-unload", (event) => event.preventDefault());
  window.webContents.on("before-input-event", (event, input) => {
    const historyShortcut = input.alt && ["ArrowLeft", "ArrowRight", "Left", "Right", "BrowserBack", "BrowserForward"].includes(input.key);
    const reloadShortcut = input.key === "F5" || input.key === "BrowserRefresh" || ((input.control || input.meta) && input.key.toLowerCase() === "r");
    if (historyShortcut || reloadShortcut) refuseNavigation(event);
  });
  window.webContents.on("render-process-gone", () => { if (!window.isDestroyed()) window.destroy(); });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return window;
}

export async function loadCredentialWindow(window: BrowserWindowType): Promise<void> {
  await window.loadURL(CREDENTIAL_ENTRY_URL);
}

export function hardenCredentialSession(credentialSession: Session): void {
  credentialSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  credentialSession.setPermissionCheckHandler(() => false);
  credentialSession.setDevicePermissionHandler(() => false);
  credentialSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  credentialSession.on("will-download", (event) => event.preventDefault());
}

export function installGlobalWebContentsGuard(app: typeof import("electron").app): void {
  app.on("web-contents-created", (_event, contents) => {
    const refuseNavigation = (event: { preventDefault(): void }): void => { event.preventDefault(); contents.close(); };
    contents.on("will-navigate", refuseNavigation);
    contents.on("will-frame-navigate", refuseNavigation);
    contents.on("will-redirect", refuseNavigation);
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
  });
}
