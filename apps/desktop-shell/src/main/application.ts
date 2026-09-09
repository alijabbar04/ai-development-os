import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, ipcMain, Menu, session, type BrowserWindow, type Event as ElectronEvent } from "electron";
import { createOwnedServiceController, type OwnedServiceController } from "../service/controller.js";
import {
  DESKTOP_PROTOCOL,
  DESKTOP_SESSION_PARTITION,
  type DesktopPreferences,
  type DesktopServiceState,
  type DesktopSnapshot,
} from "../shared/contracts.js";
import { assertDesktopElectronVersion, VISIBLE_WINDOW_DEADLINE_MS } from "./constants.js";
import {
  createHardenedDesktopWindow,
  hardenDesktopSession,
  installDesktopMenu,
  installGlobalWebContentsGuard,
  loadDesktopWindow,
  showDesktopWindowWithinDeadline,
} from "./hardening.js";
import { installDesktopIpc, publishDesktopSnapshot } from "./ipc.js";
import { createDesktopSnapshot } from "./lifecycle.js";
import { readDesktopPreferences, writeDesktopPreferences } from "./preferences.js";
import { installDesktopProtocol } from "./protocol.js";
import { resolveOwnedNodeRuntime } from "./owned-runtime.js";
import { nativePlanningDialog } from "./planning-dialog.js";
import type { NativePlanningReply, NativePlanningRequest } from "../shared/planning-ipc.js";

export interface DesktopApplicationOptions {
  readonly applicationRoot?: string;
  readonly userDataRoot?: string;
  readonly serviceReadyDeadlineMs?: number;
  readonly shutdownDeadlineMs?: number;
  readonly onStartupPhase?: (phase: string) => void;
  /** Owned integration harness only; never exposed by preload or IPC. */
  readonly nativePlanningForTest?: (request: NativePlanningRequest) => Promise<NativePlanningReply>;
  /** Finite owned-fixture entry; no renderer, environment or production CLI clock switch. */
  readonly savedRecoveryFixtureForTest?: true;
  /** Separate synthetic inference entry, selected only by an owned test host. */
  readonly aiPlanningFixtureForTest?: true;
}

export interface DesktopApplicationHandle {
  readonly window: BrowserWindow;
  readonly service: OwnedServiceController;
  readonly visibleElapsedMs: number;
  snapshot(): DesktopSnapshot;
  waitForState(state: DesktopServiceState, timeoutMs?: number): Promise<DesktopSnapshot>;
  close(): Promise<void>;
}

export async function launchDesktopApplication(options: DesktopApplicationOptions = {}): Promise<DesktopApplicationHandle> {
  if (options.aiPlanningFixtureForTest === true && options.savedRecoveryFixtureForTest === true) throw new Error("DESKTOP_FIXTURE_SELECTION_INVALID");
  const visibleStartedAt = Date.now();
  const phase = (value: string): void => { options.onStartupPhase?.(value); };
  phase("version-check");
  assertDesktopElectronVersion(process.versions["electron"]);
  const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const applicationRoot = resolve(options.applicationRoot ?? moduleRoot);
  const userDataRoot = resolve(options.userDataRoot ?? join(app.getPath("appData"), "AI Development OS", "desktop-shell-development"));
  app.setName("AI Development OS — AI Powerhouse");
  await mkdir(userDataRoot, { recursive: true });
  phase("app-configured");
  installGlobalWebContentsGuard(app);
  phase("global-guard-installed");
  if (!app.requestSingleInstanceLock()) throw new Error("DESKTOP_SINGLE_INSTANCE_UNAVAILABLE");
  phase("single-instance-owned");
  let readinessTimer: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      app.whenReady(),
      new Promise<never>((_resolveReady, rejectReady) => {
        readinessTimer = setTimeout(() => rejectReady(new Error("DESKTOP_VISIBLE_DEADLINE_EXCEEDED")), Math.max(1, VISIBLE_WINDOW_DEADLINE_MS - (Date.now() - visibleStartedAt)));
      }),
    ]);
  } finally {
    if (readinessTimer !== null) clearTimeout(readinessTimer);
  }
  phase("app-ready");

  const preferenceRoot = join(userDataRoot, "preferences");
  const runtimeRoot = join(userDataRoot, "runtime");
  const ownedNodeRuntime = await resolveOwnedNodeRuntime(applicationRoot);
  let preferences = await readDesktopPreferences(preferenceRoot);
  phase("preferences-ready");
  let window: BrowserWindow | null = null;
  let disposed = false;
  let closing: Promise<void> | null = null;
  let preferenceOperation: Promise<DesktopSnapshot> | null = null;
  const stateWaiters = new Set<() => void>();

  const service = createOwnedServiceController({
    childPath: options.aiPlanningFixtureForTest === true ? join(applicationRoot, "dist", "testing", "ai-planning-child.js") : options.savedRecoveryFixtureForTest === true ? join(applicationRoot, "dist", "testing", "saved-recovery-child.js") : join(applicationRoot, "dist", "service", "child.js"),
    execPath: ownedNodeRuntime,
    dataRoot: join(userDataRoot, "saved-workspace"),
    storageParent: runtimeRoot,
    initialMode: preferences.presentationMode,
    nativePlanning: async (request) => {
      if (window === null || window.isDestroyed() || disposed) return null;
      return options.nativePlanningForTest === undefined ? await nativePlanningDialog(window, request) : await options.nativePlanningForTest(request);
    },
    ...(options.serviceReadyDeadlineMs === undefined ? {} : { serviceReadyDeadlineMs: options.serviceReadyDeadlineMs }),
    ...(options.shutdownDeadlineMs === undefined ? {} : { shutdownDeadlineMs: options.shutdownDeadlineMs }),
    onChange: () => {
      for (const notify of [...stateWaiters]) notify();
      if (window !== null) publishDesktopSnapshot(window, createDesktopSnapshot(service.snapshot(), preferences));
    },
  });

  const snapshot = (): DesktopSnapshot => createDesktopSnapshot(service.snapshot(), preferences);
  const desktopSession = session.fromPartition(DESKTOP_SESSION_PARTITION, { cache: false });
  hardenDesktopSession(desktopSession);
  installDesktopProtocol(desktopSession, applicationRoot);
  installDesktopMenu(Menu);
  phase("session-ready");
  const token = randomBytes(32).toString("hex");
  window = await createHardenedDesktopWindow({
    desktopSession,
    preloadPath: join(applicationRoot, "dist", "preload", "desktop.cjs"),
    sessionToken: token,
  });
  phase("window-created");
  const createdWindow = window;
  createdWindow.webContents.on("did-start-loading", () => phase("renderer-started-loading"));
  createdWindow.webContents.on("dom-ready", () => phase("renderer-dom-ready"));
  createdWindow.webContents.on("did-finish-load", () => phase("renderer-finished-loading"));
  createdWindow.webContents.on("did-fail-load", (_event, code) => phase(`renderer-failed-${code}`));
  createdWindow.on("ready-to-show", () => phase("renderer-ready-to-show"));
  createdWindow.on("show", () => phase("window-show-event"));

  const beginClose = (beforeDestroy: () => void = () => undefined): Promise<void> => {
    if (closing !== null) return closing;
    closing = (async () => {
      if (disposed) return;
      disposed = true;
      disposeIpc();
      await service.stop();
      try { await desktopSession.protocol.unhandle(DESKTOP_PROTOCOL); } catch { /* session is already closing */ }
      beforeDestroy();
      if (!createdWindow.isDestroyed()) createdWindow.destroy();
    })();
    return closing;
  };

  const disposeIpc = installDesktopIpc(ipcMain, {
    token,
    webContentsId: createdWindow.webContents.id,
    desktopSession,
    window: createdWindow,
    actions: {
      snapshot,
      planning: async (query) => await service.planning(query),
      async retryService() { await service.retry(); return snapshot(); },
      openReadOnly() { service.openReadOnly(); return snapshot(); },
      async setPreferences(next) {
        const update = async (): Promise<DesktopSnapshot> => {
          const previousMode = preferences.presentationMode;
          if (previousMode !== next.presentationMode && service.snapshot().phase !== "ready") throw new Error("ACTION_UNAVAILABLE");
          preferences = await writeDesktopPreferences(preferenceRoot, next);
          if (previousMode !== preferences.presentationMode) await service.start(preferences.presentationMode);
          else publishDesktopSnapshot(createdWindow, snapshot());
          return snapshot();
        };
        const prior = preferenceOperation;
        const pending = prior === null ? update() : prior.then(update, update);
        preferenceOperation = pending;
        try { return await pending; }
        finally { if (preferenceOperation === pending) preferenceOperation = null; }
      },
      async relaunch() { await beginClose(() => app.relaunch()); app.quit(); },
      async quit() { await beginClose(); app.quit(); },
    },
  });
  phase("ipc-ready");

  let allowQuit = false;
  const beforeQuit = (event: ElectronEvent): void => {
    if (allowQuit) return;
    event.preventDefault();
    void beginClose().finally(() => { allowQuit = true; app.quit(); });
  };
  app.on("before-quit", beforeQuit);
  createdWindow.on("closed", () => { if (!disposed) app.quit(); });
  app.on("second-instance", () => {
    if (createdWindow.isDestroyed()) return;
    if (createdWindow.isMinimized()) createdWindow.restore();
    createdWindow.show();
    createdWindow.focus();
  });

  const visibleRemainingMs = Math.max(1, VISIBLE_WINDOW_DEADLINE_MS - (Date.now() - visibleStartedAt));
  const visible = showDesktopWindowWithinDeadline(createdWindow, visibleRemainingMs);
  phase("renderer-loading");
  await Promise.all([loadDesktopWindow(createdWindow), visible]);
  phase("window-visible");
  const visibleElapsedMs = Date.now() - visibleStartedAt;
  publishDesktopSnapshot(createdWindow, snapshot());
  void service.start(preferences.presentationMode).catch(() => undefined);

  return Object.freeze({
    window: createdWindow,
    service,
    visibleElapsedMs,
    snapshot,
    async waitForState(state: DesktopServiceState, timeoutMs: number = 10_000) {
      const current = snapshot();
      if (current.state === state) return current;
      return await new Promise<DesktopSnapshot>((resolveState, rejectState) => {
        const check = (): void => {
          const next = snapshot();
          if (next.state !== state) return;
          clearTimeout(timer);
          stateWaiters.delete(check);
          resolveState(next);
        };
        const timer = setTimeout(() => {
          stateWaiters.delete(check);
          rejectState(new Error("DESKTOP_STATE_WAIT_TIMEOUT"));
        }, timeoutMs);
        stateWaiters.add(check);
      });
    },
    async close() {
      app.removeListener("before-quit", beforeQuit);
      allowQuit = true;
      await beginClose();
    },
  });
}
