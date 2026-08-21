import type { Session } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronFake = vi.hoisted(() => {
  const windows: FakeWindow[] = [];
  const netFetch = vi.fn(async () => new Response("bounded", { status: 200, headers: { "x-source": "local" } }));
  class FakeWindow {
    readonly options: Record<string, unknown>;
    readonly events = new Map<string, (...args: any[]) => void>();
    readonly contentsEvents = new Map<string, (...args: any[]) => void>();
    readonly webContents = {
      on: (name: string, handler: (...args: any[]) => void) => { this.contentsEvents.set(name, handler); },
      setWindowOpenHandler: vi.fn((handler: () => unknown) => { this.windowOpenHandler = handler; }),
    };
    readonly setContentProtection = vi.fn();
    readonly setMenuBarVisibility = vi.fn();
    readonly show = vi.fn();
    readonly loadURL = vi.fn(async () => undefined);
    destroyed = false;
    windowOpenHandler: (() => unknown) | null = null;
    constructor(options: Record<string, unknown>) { this.options = options; windows.push(this); }
    once(name: string, handler: (...args: any[]) => void) { this.events.set(name, handler); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  return { windows, netFetch, FakeWindow };
});

vi.mock("electron", () => ({ BrowserWindow: electronFake.FakeWindow, net: { fetch: electronFake.netFetch } }));

import { assertCredentialElectronVersion, CREDENTIAL_CSP, CREDENTIAL_ENTRY_URL } from "../src/main/constants.js";
import { createHardenedCredentialWindow, hardenCredentialSession, installGlobalWebContentsGuard, installMinimalEditMenu, loadCredentialWindow } from "../src/main/hardening.js";
import { installCredentialProtocol } from "../src/main/protocol.js";

beforeEach(() => {
  electronFake.windows.length = 0;
  electronFake.netFetch.mockClear();
});

describe("Electron hardening wiring", () => {
  it("accepts only the reviewed Electron runtime version", () => {
    expect(() => assertCredentialElectronVersion("43.4.1")).not.toThrow();
    expect(() => assertCredentialElectronVersion("44.0.0")).toThrow("CREDENTIAL_ELECTRON_VERSION_UNREVIEWED");
  });

  it("constructs the bounded BrowserWindow, denies navigation/window creation, and loads only the exact entry", async () => {
    const dedicatedSession = Object.freeze({ partition: "bounded" }) as unknown as Session;
    const window = await createHardenedCredentialWindow({ credentialSession: dedicatedSession, preloadPath: "C:\\bounded\\credential.cjs", sessionToken: "a".repeat(64) }) as unknown as InstanceType<typeof electronFake.FakeWindow>;
    const preferences = window.options["webPreferences"] as Record<string, unknown>;
    expect(window.options).toMatchObject({ minWidth: 900, minHeight: 700, fullscreenable: false, show: false, autoHideMenuBar: true });
    expect(preferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: false, spellcheck: false, session: dedicatedSession });
    expect(preferences["additionalArguments"]).toEqual([`--credential-session-token=${"a".repeat(64)}`]);
    expect(window.setContentProtection).toHaveBeenCalledWith(true);
    expect(window.setMenuBarVisibility).toHaveBeenCalledWith(false);
    expect([...window.contentsEvents.keys()].sort()).toEqual(["before-input-event", "render-process-gone", "will-attach-webview", "will-frame-navigate", "will-navigate", "will-prevent-unload", "will-redirect"]);
    for (const name of ["will-navigate", "will-frame-navigate", "will-redirect"] as const) {
      const handler = window.contentsEvents.get(name)!;
      window.destroyed = false;
      const event = { preventDefault: vi.fn() };
      handler(event);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(window.destroyed).toBe(true);
    }
    window.destroyed = true;
    const alreadyDestroyed = { preventDefault: vi.fn() };
    window.contentsEvents.get("will-navigate")?.(alreadyDestroyed);
    expect(alreadyDestroyed.preventDefault).toHaveBeenCalledOnce();
    const webview = { preventDefault: vi.fn() };
    window.contentsEvents.get("will-attach-webview")?.(webview);
    expect(webview.preventDefault).toHaveBeenCalledOnce();
    const unload = { preventDefault: vi.fn() };
    window.contentsEvents.get("will-prevent-unload")?.(unload);
    expect(unload.preventDefault).toHaveBeenCalledOnce();
    window.destroyed = false;
    const nativeClose = { preventDefault: vi.fn() };
    window.events.get("close")?.(nativeClose);
    expect(nativeClose.preventDefault).toHaveBeenCalledOnce();
    expect(window.destroyed).toBe(true);
    window.destroyed = false;
    const shortcut = { preventDefault: vi.fn() };
    window.contentsEvents.get("before-input-event")?.(shortcut, { alt: true, key: "ArrowLeft" });
    expect(shortcut.preventDefault).toHaveBeenCalledOnce();
    expect(window.destroyed).toBe(true);
    window.destroyed = false;
    const ordinaryInput = { preventDefault: vi.fn() };
    window.contentsEvents.get("before-input-event")?.(ordinaryInput, { alt: false, key: "ArrowLeft" });
    expect(ordinaryInput.preventDefault).not.toHaveBeenCalled();
    expect(window.destroyed).toBe(false);
    for (const input of [{ key: "F5" }, { key: "BrowserRefresh" }, { key: "r", control: true }, { key: "R", meta: true }]) {
      window.destroyed = false;
      const reload = { preventDefault: vi.fn() };
      window.contentsEvents.get("before-input-event")?.(reload, input);
      expect(reload.preventDefault).toHaveBeenCalledOnce();
      expect(window.destroyed).toBe(true);
    }
    window.destroyed = false;
    window.contentsEvents.get("render-process-gone")?.();
    expect(window.destroyed).toBe(true);
    window.contentsEvents.get("render-process-gone")?.();
    expect(window.destroyed).toBe(true);
    expect(window.windowOpenHandler?.()).toEqual({ action: "deny" });
    window.destroyed = false;
    window.events.get("ready-to-show")?.();
    expect(window.show).toHaveBeenCalledOnce();
    window.destroyed = true;
    window.events.get("ready-to-show")?.();
    expect(window.show).toHaveBeenCalledOnce();
    await loadCredentialWindow(window as never);
    expect(window.loadURL).toHaveBeenCalledWith(CREDENTIAL_ENTRY_URL);
  });

  it("installs only Edit roles and refuses every permission, display-media request, and download", () => {
    const setApplicationMenu = vi.fn();
    const buildFromTemplate = vi.fn((template) => ({ template }));
    installMinimalEditMenu({ setApplicationMenu, buildFromTemplate } as never);
    const template = buildFromTemplate.mock.calls[0]?.[0] as Array<{ submenu: Array<{ role?: string }> }>;
    expect(template[0]?.submenu.map((item) => item.role).filter(Boolean)).toEqual(["paste", "delete", "selectAll"]);
    expect(template[0]?.submenu.some((item) => item.role === "copy" || item.role === "cut")).toBe(false);
    expect(setApplicationMenu).toHaveBeenCalledOnce();

    const callbacks: Record<string, (...args: any[]) => unknown> = Object.create(null);
    const credentialSession = {
      setPermissionRequestHandler: (handler: (...args: any[]) => unknown) => { callbacks.permissionRequest = handler; },
      setPermissionCheckHandler: (handler: (...args: any[]) => unknown) => { callbacks.permissionCheck = handler; },
      setDevicePermissionHandler: (handler: (...args: any[]) => unknown) => { callbacks.devicePermission = handler; },
      setDisplayMediaRequestHandler: (handler: (...args: any[]) => unknown) => { callbacks.displayMedia = handler; },
      on: (name: string, handler: (...args: any[]) => unknown) => { callbacks[name] = handler; },
    };
    hardenCredentialSession(credentialSession as never);
    const permissionReply = vi.fn();
    callbacks.permissionRequest?.({}, "camera", permissionReply);
    expect(permissionReply).toHaveBeenCalledWith(false);
    expect(callbacks.permissionCheck?.()).toBe(false);
    expect(callbacks.devicePermission?.()).toBe(false);
    const displayReply = vi.fn();
    callbacks.displayMedia?.({}, displayReply);
    expect(displayReply).toHaveBeenCalledWith({});
    const download = { preventDefault: vi.fn() };
    callbacks["will-download"]?.(download);
    expect(download.preventDefault).toHaveBeenCalledOnce();
  });

  it("applies the same navigation, popup, and webview guard to every created WebContents", () => {
    let created!: (_event: unknown, contents: any) => void;
    installGlobalWebContentsGuard({ on: (_name: string, handler: typeof created) => { created = handler; } } as never);
    const handlers = new Map<string, (...args: any[]) => void>();
    let openHandler!: () => unknown;
    const close = vi.fn();
    const contents = { on: (name: string, handler: (...args: any[]) => void) => handlers.set(name, handler), setWindowOpenHandler: (handler: () => unknown) => { openHandler = handler; }, close };
    created({}, contents);
    expect([...handlers.keys()].sort()).toEqual(["will-attach-webview", "will-frame-navigate", "will-navigate", "will-redirect"]);
    for (const handler of handlers.values()) {
      const event = { preventDefault: vi.fn() };
      handler(event);
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
    expect(close).toHaveBeenCalledTimes(3);
    expect(openHandler()).toEqual({ action: "deny" });
  });
});

describe("custom protocol response wiring", () => {
  it("serves only allowlisted local files with security headers and refuses other paths before local fetch", async () => {
    let handler!: (request: { url: string }) => Promise<Response>;
    const credentialSession = { protocol: { handle: (_scheme: string, installed: typeof handler) => { handler = installed; } } };
    installCredentialProtocol(credentialSession as never, "C:\\bounded\\renderer\\credential");

    const denied = await handler({ url: "app-credential://entry/unexpected.json" });
    expect(denied.status).toBe(404);
    expect(electronFake.netFetch).not.toHaveBeenCalled();

    const served = await handler({ url: CREDENTIAL_ENTRY_URL });
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("bounded");
    expect(served.headers.get("content-security-policy")).toBe(CREDENTIAL_CSP);
    expect(served.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("referrer-policy")).toBe("no-referrer");
    expect(served.headers.get("cache-control")).toBe("no-store");
    expect(electronFake.netFetch).toHaveBeenCalledOnce();
    expect(String(electronFake.netFetch.mock.calls[0]?.[0])).toMatch(/^file:\/\/\/C:\/bounded\/renderer\/credential\/index\.html$/u);
  });
});
