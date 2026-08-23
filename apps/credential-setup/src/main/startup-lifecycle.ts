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
  readonly webContents: Readonly<{ readonly id: number }>;
  isDestroyed(): boolean;
  destroy(): void;
  on(event: "closed", listener: () => void): unknown;
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
  readonly onPhase?: (phase: Extract<CredentialStartupPhase, "window-creation" | "ipc-installation" | "renderer-load" | "surface-ready">) => void;
  readonly idleMs?: number;
}

export async function launchCredentialSurface<TWindow extends CredentialSurfaceWindow>(options: CredentialSurfaceLifecycleOptions<TWindow>): Promise<void> {
  let window: TWindow | null = null;
  let idleTimer: NodeJS.Timeout | undefined;
  let disposeIpc = (): void => undefined;
  let closePromise: Promise<void> | null = null;
  let allClosed: (() => void) | null = null;

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
    options.onPhase?.("window-creation");
    window = await options.createWindow();
    const closeFromSurface = (): void => { void beginClose(true).catch(() => undefined); };
    allClosed = closeFromSurface;
    window.on("closed", closeFromSurface);
    options.app.on("window-all-closed", closeFromSurface);
    const touch = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { if (window !== null && !window.isDestroyed()) window.destroy(); }, options.idleMs ?? 600_000);
    };
    touch();
    options.onPhase?.("ipc-installation");
    disposeIpc = options.installIpc(window, touch);
    options.onPhase?.("renderer-load");
    await options.load(window);
    options.onPhase?.("surface-ready");
  } catch (error) {
    const cleanup = beginClose(false);
    if (window !== null && !window.isDestroyed()) window.destroy();
    await cleanup.catch(() => undefined);
    throw error;
  }
}
