import type { CredentialStartupPhase } from "./startup-diagnostic.js";

export interface CredentialReadyApp {
  isReady(): boolean;
  once(event: "ready", listener: () => void): unknown;
}

export async function waitForCredentialAppReady(app: CredentialReadyApp): Promise<void> {
  if (app.isReady()) return;
  await new Promise<void>((resolveReady) => { app.once("ready", resolveReady); });
}

export interface CredentialSurfaceWindow {
  readonly webContents: Readonly<{
    readonly id: number;
    on(event: "render-process-gone", listener: () => void): unknown;
    removeListener(event: "render-process-gone", listener: () => void): unknown;
  }>;
  isDestroyed(): boolean;
  isVisible(): boolean;
  show(): void;
  destroy(): void;
  on(event: "closed", listener: () => void): unknown;
  once(event: "ready-to-show" | "show", listener: () => void): unknown;
  removeListener(event: "closed" | "ready-to-show" | "show", listener: () => void): unknown;
}

export interface CredentialSurfaceApp {
  on(event: "window-all-closed", listener: () => void): unknown;
  removeListener(event: "window-all-closed", listener: () => void): unknown;
  quit(): void;
  exit(code: number): void;
}

export interface CredentialSurfaceLifecycleOptions<TWindow extends CredentialSurfaceWindow> {
  readonly app: CredentialSurfaceApp;
  readonly service: Readonly<{ close(): Promise<void> }>;
  readonly createWindow: () => Promise<TWindow>;
  readonly installIpc: (window: TWindow, touch: () => void) => () => void;
  readonly load: (window: TWindow) => Promise<void>;
  readonly waitForVisible: (window: TWindow, signal: AbortSignal) => Promise<void>;
  readonly signal: AbortSignal;
  readonly onPhase?: (phase: Extract<CredentialStartupPhase, "window-creation" | "ipc-installation" | "renderer-load" | "surface-ready">) => void;
  readonly idleMs?: number;
}

export function waitForCredentialSurfaceVisible(window: CredentialSurfaceWindow, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolveVisible, rejectVisible) => {
    let settled = false;
    let visibilityCheck: NodeJS.Immediate | undefined;

    const cleanup = (): void => {
      const pendingVisibilityCheck = visibilityCheck;
      visibilityCheck = undefined;
      if (pendingVisibilityCheck !== undefined) {
        try { clearImmediate(pendingVisibilityCheck); } catch { /* terminal listener cleanup remains best effort */ }
      }
      try { window.removeListener("ready-to-show", onReadyToShow); } catch { /* cleanup is best effort after a terminal result */ }
      try { window.removeListener("show", onShow); } catch { /* cleanup is best effort after a terminal result */ }
      try { window.removeListener("closed", onClosed); } catch { /* cleanup is best effort after a terminal result */ }
      try { window.webContents.removeListener("render-process-gone", onRenderProcessGone); } catch { /* cleanup is best effort after a terminal result */ }
      try { signal.removeEventListener("abort", onAbort); } catch { /* cleanup is best effort after a terminal result */ }
    };

    const finish = (visible: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (visible) resolveVisible();
      else rejectVisible(new Error("Credential surface did not become visibly ready."));
    };

    const verifyAfterShow = (): void => {
      if (settled) return;
      try {
        if (window.isDestroyed()) { finish(false); return; }
        if (window.isVisible()) { finish(true); return; }
        if (visibilityCheck === undefined) {
          visibilityCheck = setImmediate(() => {
            visibilityCheck = undefined;
            try { finish(!window.isDestroyed() && window.isVisible()); }
            catch { finish(false); }
          });
        }
      } catch {
        finish(false);
      }
    };

    const showAndVerify = (): void => {
      if (settled) return;
      try {
        if (window.isDestroyed()) { finish(false); return; }
        window.show();
        if (settled) return;
        verifyAfterShow();
      } catch {
        finish(false);
      }
    };

    function onReadyToShow(): void { showAndVerify(); }
    function onShow(): void { verifyAfterShow(); }
    function onClosed(): void { finish(false); }
    function onRenderProcessGone(): void { finish(false); }
    function onAbort(): void { finish(false); }

    try {
      if (signal.aborted || window.isDestroyed()) { finish(false); return; }
      window.once("ready-to-show", onReadyToShow);
      window.once("show", onShow);
      window.on("closed", onClosed);
      window.webContents.on("render-process-gone", onRenderProcessGone);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted || window.isDestroyed()) { finish(false); return; }
      if (window.isVisible()) showAndVerify();
    } catch {
      finish(false);
    }
  });
}

export async function launchCredentialSurface<TWindow extends CredentialSurfaceWindow>(options: CredentialSurfaceLifecycleOptions<TWindow>): Promise<void> {
  let window: TWindow | null = null;
  let idleTimer: NodeJS.Timeout | undefined;
  let disposeIpc = (): void => undefined;
  let closePromise: Promise<void> | null = null;
  let allClosed: (() => void) | null = null;
  let readyForNormalClose = false;

  const beginClose = (exitWhenDone: boolean): Promise<void> => {
    if (closePromise !== null) return closePromise;
    closePromise = (async () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (allClosed !== null) options.app.removeListener("window-all-closed", allClosed);
      let cleanupFailed = false;
      try { disposeIpc(); } catch { cleanupFailed = true; }
      const serviceClose = await Promise.allSettled([options.service.close()]);
      if (serviceClose[0]?.status === "rejected") cleanupFailed = true;
      if (exitWhenDone) {
        if (cleanupFailed) options.app.exit(1);
        else options.app.quit();
      }
      if (cleanupFailed) throw new Error("CREDENTIAL_SURFACE_CLEANUP_FAILED");
    })();
    return closePromise;
  };

  try {
    if (options.signal.aborted) throw new Error("Credential surface startup was cancelled.");
    options.onPhase?.("window-creation");
    window = await options.createWindow();
    if (options.signal.aborted) throw new Error("Credential surface startup was cancelled.");
    const closeFromSurface = (): void => { void beginClose(readyForNormalClose).catch(() => undefined); };
    allClosed = closeFromSurface;
    window.on("closed", closeFromSurface);
    options.app.on("window-all-closed", closeFromSurface);
    const visibility = options.waitForVisible(window, options.signal);
    void visibility.catch(() => undefined);
    const touch = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { if (window !== null && !window.isDestroyed()) window.destroy(); }, options.idleMs ?? 600_000);
    };
    touch();
    options.onPhase?.("ipc-installation");
    disposeIpc = options.installIpc(window, touch);
    options.onPhase?.("renderer-load");
    await Promise.all([options.load(window), visibility]);
    if (window.isDestroyed() || !window.isVisible()) throw new Error("Credential surface visibility was lost before readiness.");
    options.onPhase?.("surface-ready");
    readyForNormalClose = true;
  } catch (error) {
    const cleanup = beginClose(false);
    if (window !== null && !window.isDestroyed()) window.destroy();
    await cleanup.catch(() => undefined);
    throw error;
  }
}
