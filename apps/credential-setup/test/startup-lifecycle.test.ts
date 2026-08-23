import { describe, expect, it, vi } from "vitest";
import { launchCredentialSurface, waitForCredentialAppReady } from "../src/main/startup-lifecycle.js";

function fixture() {
  const appEvents = new Map<string, () => void>();
  const windowEvents = new Map<string, () => void>();
  const app = {
    on: vi.fn((name: string, listener: () => void) => { appEvents.set(name, listener); }),
    removeListener: vi.fn((name: string, listener: () => void) => { if (appEvents.get(name) === listener) appEvents.delete(name); }),
    quit: vi.fn(),
    exit: vi.fn(),
  };
  const window = {
    webContents: { id: 17 },
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    destroy: vi.fn(() => { window.destroyed = true; windowEvents.get("closed")?.(); }),
    on: vi.fn((name: string, listener: () => void) => { windowEvents.set(name, listener); }),
  };
  const service = { close: vi.fn(async () => undefined) };
  const dispose = vi.fn();
  return { app, appEvents, window, windowEvents, service, dispose };
}

describe("credential surface startup ownership", () => {
  it("continues immediately when asynchronous ESM loading observes an already-ready app", async () => {
    const once = vi.fn();
    await expect(waitForCredentialAppReady({ isReady: () => true, once })).resolves.toBeUndefined();
    expect(once).not.toHaveBeenCalled();
  });

  it("waits on the finite ready event when startup reaches the app before readiness", async () => {
    let ready: (() => void) | undefined;
    const waiting = waitForCredentialAppReady({
      isReady: () => false,
      once: vi.fn((_event: "ready", listener: () => void) => { ready = listener; }),
    });
    expect(ready).toBeTypeOf("function");
    ready?.();
    await expect(waiting).resolves.toBeUndefined();
  });

  it("remains pending when readiness never arrives so the owning startup watchdog can adjudicate it", async () => {
    const once = vi.fn();
    let settled = false;
    void waitForCredentialAppReady({ isReady: () => false, once }).then(() => { settled = true; });
    await Promise.resolve();
    expect(once).toHaveBeenCalledOnce();
    expect(once).toHaveBeenCalledWith("ready", expect.any(Function));
    expect(settled).toBe(false);
  });

  it("closes the service when window construction fails", async () => {
    const f = fixture();
    const failure = new Error("window-construction-failure");
    await expect(launchCredentialSurface({ app: f.app, service: f.service, createWindow: async () => { throw failure; }, installIpc: () => f.dispose, load: async () => undefined, idleMs: 60_000 })).rejects.toBe(failure);
    expect(f.service.close).toHaveBeenCalledOnce();
    expect(f.app.quit).not.toHaveBeenCalled();
    expect(f.app.exit).not.toHaveBeenCalled();
  });

  it("preserves the startup failure even when cleanup also fails", async () => {
    const f = fixture();
    const failure = new Error("window-construction-failure");
    f.service.close.mockRejectedValueOnce(new Error("close-failure"));
    await expect(launchCredentialSurface({ app: f.app, service: f.service, createWindow: async () => { throw failure; }, installIpc: () => f.dispose, load: async () => undefined, idleMs: 60_000 })).rejects.toBe(failure);
    expect(f.service.close).toHaveBeenCalledOnce();
  });

  it("destroys the window and closes the service when IPC installation fails", async () => {
    const f = fixture();
    const failure = new Error("ipc-install-failure");
    await expect(launchCredentialSurface({ app: f.app, service: f.service, createWindow: async () => f.window, installIpc: () => { throw failure; }, load: async () => undefined, idleMs: 60_000 })).rejects.toBe(failure);
    expect(f.window.destroy).toHaveBeenCalledOnce();
    expect(f.service.close).toHaveBeenCalledOnce();
    expect(f.appEvents.has("window-all-closed")).toBe(false);
  });

  it("disposes IPC, destroys the window, and closes the service when initial load fails", async () => {
    const f = fixture();
    const failure = new Error("initial-load-failure");
    await expect(launchCredentialSurface({ app: f.app, service: f.service, createWindow: async () => f.window, installIpc: () => f.dispose, load: async () => { throw failure; }, idleMs: 60_000 })).rejects.toBe(failure);
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.window.destroy).toHaveBeenCalledOnce();
    expect(f.service.close).toHaveBeenCalledOnce();
  });

  it("attaches cleanup before load and quits only after successful close", async () => {
    const f = fixture();
    let handlersPresentDuringLoad = false;
    await launchCredentialSurface({
      app: f.app,
      service: f.service,
      createWindow: async () => f.window,
      installIpc: () => f.dispose,
      async load() { handlersPresentDuringLoad = f.windowEvents.has("closed") && f.appEvents.has("window-all-closed"); },
      idleMs: 60_000,
    });
    expect(handlersPresentDuringLoad).toBe(true);
    f.windowEvents.get("closed")?.();
    await vi.waitFor(() => expect(f.app.quit).toHaveBeenCalledOnce());
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.service.close).toHaveBeenCalledOnce();
    expect(f.app.exit).not.toHaveBeenCalled();
  });

  it("reports the finite window, IPC, renderer, and ready startup phases in order", async () => {
    const f = fixture();
    const phases: string[] = [];
    await launchCredentialSurface({
      app: f.app,
      service: f.service,
      createWindow: async () => f.window,
      installIpc: () => f.dispose,
      load: async () => undefined,
      onPhase: (phase) => { phases.push(phase); },
      idleMs: 60_000,
    });
    expect(phases).toEqual(["window-creation", "ipc-installation", "renderer-load", "surface-ready"]);
    f.windowEvents.get("closed")?.();
    await vi.waitFor(() => expect(f.app.quit).toHaveBeenCalledOnce());
  });

  it("destroys and closes an idle credential surface", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      await launchCredentialSurface({ app: f.app, service: f.service, createWindow: async () => f.window, installIpc: () => f.dispose, load: async () => undefined, idleMs: 25 });
      await vi.advanceTimersByTimeAsync(25);
      await Promise.resolve();
      expect(f.window.destroy).toHaveBeenCalledOnce();
      expect(f.service.close).toHaveBeenCalledOnce();
      expect(f.app.quit).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("attempts every cleanup and exits finitely when service close fails", async () => {
    const f = fixture();
    f.service.close.mockRejectedValueOnce(new Error("close-failure"));
    f.dispose.mockImplementationOnce(() => { throw new Error("dispose-failure"); });
    await launchCredentialSurface({ app: f.app, service: f.service, createWindow: async () => f.window, installIpc: () => f.dispose, load: async () => undefined, idleMs: 60_000 });
    f.windowEvents.get("closed")?.();
    await vi.waitFor(() => expect(f.app.exit).toHaveBeenCalledWith(1));
    expect(f.service.close).toHaveBeenCalledOnce();
    expect(f.app.quit).not.toHaveBeenCalled();
  });
});
