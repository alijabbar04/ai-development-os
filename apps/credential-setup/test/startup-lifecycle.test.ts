import { describe, expect, it, vi } from "vitest";
import { runCredentialStartupTask, type CredentialStartupTimer } from "../src/main/startup-diagnostic.js";
import { launchCredentialSurface, waitForCredentialAppReady, waitForCredentialSurfaceVisible } from "../src/main/startup-lifecycle.js";

function fixture() {
  const appEvents = new Map<string, () => void>();
  const windowEvents = new Map<string, Set<() => void>>();
  const contentsEvents = new Map<string, Set<() => void>>();
  const add = (events: Map<string, Set<() => void>>, name: string, listener: () => void): void => {
    const listeners = events.get(name) ?? new Set<() => void>();
    listeners.add(listener);
    events.set(name, listeners);
  };
  const remove = (events: Map<string, Set<() => void>>, name: string, listener: () => void): void => { events.get(name)?.delete(listener); };
  const emit = (events: Map<string, Set<() => void>>, name: string): void => { for (const listener of [...(events.get(name) ?? [])]) listener(); };
  const app = {
    on: vi.fn((name: string, listener: () => void) => { appEvents.set(name, listener); }),
    removeListener: vi.fn((name: string, listener: () => void) => { if (appEvents.get(name) === listener) appEvents.delete(name); }),
    quit: vi.fn(),
    exit: vi.fn(),
  };
  const window = {
    webContents: {
      id: 17,
      on: vi.fn((name: string, listener: () => void) => { add(contentsEvents, name, listener); }),
      removeListener: vi.fn((name: string, listener: () => void) => { remove(contentsEvents, name, listener); }),
    },
    destroyed: false,
    visible: true,
    isDestroyed() { return this.destroyed; },
    isVisible() { return this.visible; },
    show: vi.fn(() => { window.visible = true; }),
    destroy: vi.fn(() => { window.destroyed = true; window.visible = false; emit(windowEvents, "closed"); }),
    on: vi.fn((name: string, listener: () => void) => { add(windowEvents, name, listener); }),
    once: vi.fn((name: string, listener: () => void) => {
      const once = () => { remove(windowEvents, name, once); listener(); };
      Object.defineProperty(once, "listener", { value: listener });
      add(windowEvents, name, once);
    }),
    removeListener: vi.fn((name: string, listener: () => void) => {
      for (const candidate of [...(windowEvents.get(name) ?? [])]) {
        if (candidate === listener || (candidate as { listener?: () => void }).listener === listener) remove(windowEvents, name, candidate);
      }
    }),
  };
  const service = { close: vi.fn(async () => undefined) };
  const dispose = vi.fn();
  return {
    app, appEvents, window, windowEvents, contentsEvents, service, dispose,
    emitWindow: (name: string) => { emit(windowEvents, name); },
    emitContents: (name: string) => { emit(contentsEvents, name); },
  };
}

function baseOptions(f: ReturnType<typeof fixture>) {
  return {
    app: f.app,
    service: f.service,
    createWindow: async () => f.window,
    installIpc: () => f.dispose,
    load: async () => undefined,
    waitForVisible: waitForCredentialSurfaceVisible,
    signal: new AbortController().signal,
    idleMs: 60_000,
  };
}

function startupTimerFixture() {
  let callback: (() => void) | null = null;
  const handle = { unref: vi.fn() };
  const timer: CredentialStartupTimer = {
    schedule: vi.fn((scheduled) => { callback = scheduled; return handle; }),
    cancel: vi.fn(),
  };
  return {
    timer,
    handle,
    fire() {
      const scheduled = callback;
      if (scheduled === null) throw new Error("Synthetic startup deadline was not scheduled.");
      scheduled();
    },
  };
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
    await expect(launchCredentialSurface({ ...baseOptions(f), createWindow: async () => { throw failure; } })).rejects.toBe(failure);
    expect(f.service.close).toHaveBeenCalledOnce();
    expect(f.app.quit).not.toHaveBeenCalled();
    expect(f.app.exit).not.toHaveBeenCalled();
  });

  it("preserves the startup failure even when cleanup also fails", async () => {
    const f = fixture();
    const failure = new Error("window-construction-failure");
    f.service.close.mockRejectedValueOnce(new Error("close-failure"));
    await expect(launchCredentialSurface({ ...baseOptions(f), createWindow: async () => { throw failure; } })).rejects.toBe(failure);
    expect(f.service.close).toHaveBeenCalledOnce();
  });

  it("destroys the window and closes the service when IPC installation fails", async () => {
    const f = fixture();
    const failure = new Error("ipc-install-failure");
    await expect(launchCredentialSurface({ ...baseOptions(f), installIpc: () => { throw failure; } })).rejects.toBe(failure);
    expect(f.window.destroy).toHaveBeenCalledOnce();
    expect(f.service.close).toHaveBeenCalledOnce();
    expect(f.appEvents.has("window-all-closed")).toBe(false);
  });

  it("disposes IPC, destroys the window, and closes the service when initial load fails", async () => {
    const f = fixture();
    const failure = new Error("initial-load-failure");
    await expect(launchCredentialSurface({ ...baseOptions(f), load: async () => { throw failure; } })).rejects.toBe(failure);
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.window.destroy).toHaveBeenCalledOnce();
    expect(f.service.close).toHaveBeenCalledOnce();
  });

  it("attaches cleanup before load and quits only after successful close", async () => {
    const f = fixture();
    let handlersPresentDuringLoad = false;
    await launchCredentialSurface({
      ...baseOptions(f),
      async load() { handlersPresentDuringLoad = f.windowEvents.has("closed") && f.appEvents.has("window-all-closed"); },
    });
    expect(handlersPresentDuringLoad).toBe(true);
    f.emitWindow("closed");
    await vi.waitFor(() => expect(f.app.quit).toHaveBeenCalledOnce());
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.service.close).toHaveBeenCalledOnce();
    expect(f.app.exit).not.toHaveBeenCalled();
  });

  it("reports the finite window, IPC, renderer, and ready startup phases in order", async () => {
    const f = fixture();
    const phases: string[] = [];
    await launchCredentialSurface({
      ...baseOptions(f),
      onPhase: (phase) => { phases.push(phase); },
    });
    expect(phases).toEqual(["window-creation", "ipc-installation", "renderer-load", "surface-ready"]);
    f.emitWindow("closed");
    await vi.waitFor(() => expect(f.app.quit).toHaveBeenCalledOnce());
  });

  it("keeps surface readiness pending when load resolves before ready-to-show", async () => {
    const f = fixture();
    f.window.visible = false;
    const phases: string[] = [];
    let settled = false;
    const launch = launchCredentialSurface({ ...baseOptions(f), onPhase: (phase) => { phases.push(phase); } });
    void launch.then(() => { settled = true; });
    await vi.waitFor(() => expect(phases).toContain("renderer-load"));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(phases).not.toContain("surface-ready");
    expect(f.window.show).not.toHaveBeenCalled();
    f.emitWindow("ready-to-show");
    await expect(launch).resolves.toBeUndefined();
    expect(f.window.show).toHaveBeenCalledOnce();
    expect(f.window.isVisible()).toBe(true);
    expect(phases.at(-1)).toBe("surface-ready");
  });

  it("waits for renderer load when visibility occurs first", async () => {
    const f = fixture();
    f.window.visible = false;
    let finishLoad: (() => void) | null = null;
    const phases: string[] = [];
    const launch = launchCredentialSurface({
      ...baseOptions(f),
      load: () => new Promise<void>((resolveLoad) => { finishLoad = resolveLoad; }),
      onPhase: (phase) => { phases.push(phase); },
    });
    await vi.waitFor(() => expect(f.windowEvents.get("ready-to-show")?.size).toBe(1));
    f.emitWindow("ready-to-show");
    expect(f.window.isVisible()).toBe(true);
    expect(phases).not.toContain("surface-ready");
    finishLoad?.();
    await expect(launch).resolves.toBeUndefined();
    expect(phases.at(-1)).toBe("surface-ready");
  });

  it("accepts an already-visible intended window only after show completes", async () => {
    const f = fixture();
    await expect(launchCredentialSurface(baseOptions(f))).resolves.toBeUndefined();
    expect(f.window.show).toHaveBeenCalledOnce();
    expect(f.window.isVisible()).toBe(true);
    expect(f.windowEvents.get("ready-to-show")?.size ?? 0).toBe(0);
    expect(f.contentsEvents.get("render-process-gone")?.size ?? 0).toBe(0);
  });

  it("rejects destruction, renderer loss, show failure, and false visibility without listener residue", async () => {
    const cases = ["destroyed", "renderer-gone", "show-throws", "show-stays-hidden"] as const;
    for (const kind of cases) {
      const f = fixture();
      f.window.visible = false;
      if (kind === "show-throws") f.window.show.mockImplementationOnce(() => { throw new Error("private-show-canary"); });
      if (kind === "show-stays-hidden") f.window.show.mockImplementationOnce(() => undefined);
      const controller = new AbortController();
      const visible = waitForCredentialSurfaceVisible(f.window, controller.signal);
      if (kind === "destroyed") f.window.destroy();
      else if (kind === "renderer-gone") f.emitContents("render-process-gone");
      else {
        f.emitWindow("ready-to-show");
        if (kind === "show-stays-hidden") f.emitWindow("show");
      }
      await expect(visible).rejects.toThrow("Credential surface did not become visibly ready.");
      expect(f.windowEvents.get("ready-to-show")?.size ?? 0).toBe(0);
      expect(f.windowEvents.get("show")?.size ?? 0).toBe(0);
      expect(f.windowEvents.get("closed")?.size ?? 0).toBe(0);
      expect(f.contentsEvents.get("render-process-gone")?.size ?? 0).toBe(0);
    }
  });

  it("waits for Electron's asynchronous show event before accepting visibility", async () => {
    const f = fixture();
    f.window.visible = false;
    f.window.show.mockImplementationOnce(() => undefined);
    let settled = false;
    const visible = waitForCredentialSurfaceVisible(f.window, new AbortController().signal);
    void visible.then(() => { settled = true; });
    f.emitWindow("ready-to-show");
    await Promise.resolve();
    expect(settled).toBe(false);
    f.window.visible = true;
    f.emitWindow("show");
    await expect(visible).resolves.toBeUndefined();
    expect(f.windowEvents.get("show")?.size ?? 0).toBe(0);
  });

  it("fails promptly without normal-close semantics when the surface disappears during a pending load", async () => {
    for (const event of ["closed", "render-process-gone"] as const) {
      const f = fixture();
      f.window.visible = false;
      const launch = launchCredentialSurface({
        ...baseOptions(f),
        load: () => new Promise<void>(() => undefined),
      });
      await vi.waitFor(() => expect(f.windowEvents.get("ready-to-show")?.size).toBe(1));
      if (event === "closed") f.window.destroy();
      else f.emitContents("render-process-gone");
      await expect(launch).rejects.toThrow("Credential surface did not become visibly ready.");
      expect(f.service.close).toHaveBeenCalledOnce();
      expect(f.app.quit).not.toHaveBeenCalled();
      expect(f.app.exit).not.toHaveBeenCalled();
    }
  });

  it("does no late IPC or renderer work when cancellation wins asynchronous window construction", async () => {
    const f = fixture();
    const controller = new AbortController();
    let finishCreate: ((window: typeof f.window) => void) | null = null;
    const installIpc = vi.fn(() => f.dispose);
    const load = vi.fn(async () => undefined);
    const launch = launchCredentialSurface({
      ...baseOptions(f),
      signal: controller.signal,
      createWindow: () => new Promise<typeof f.window>((resolveWindow) => { finishCreate = resolveWindow; }),
      installIpc,
      load,
    });
    await vi.waitFor(() => expect(finishCreate).toBeTypeOf("function"));
    controller.abort();
    finishCreate?.(f.window);
    await expect(launch).rejects.toThrow("Credential surface startup was cancelled.");
    expect(installIpc).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(f.window.destroy).toHaveBeenCalledOnce();
    expect(f.service.close).toHaveBeenCalledOnce();
  });

  it("cancels a queued post-show visibility check without late settlement", async () => {
    const f = fixture();
    f.window.visible = false;
    f.window.show.mockImplementationOnce(() => undefined);
    const controller = new AbortController();
    const visible = waitForCredentialSurfaceVisible(f.window, controller.signal);
    f.emitWindow("ready-to-show");
    controller.abort();
    await expect(visible).rejects.toThrow("Credential surface did not become visibly ready.");
    await new Promise<void>((resolveTurn) => { setImmediate(resolveTurn); });
    expect(f.windowEvents.get("show")?.size ?? 0).toBe(0);
  });

  it("suppresses duplicate and late ready-to-show delivery after terminal abort", async () => {
    const success = fixture();
    success.window.visible = false;
    const visible = waitForCredentialSurfaceVisible(success.window, new AbortController().signal);
    const duplicate = [...(success.windowEvents.get("ready-to-show") ?? [])][0];
    duplicate?.();
    duplicate?.();
    await expect(visible).resolves.toBeUndefined();
    expect(success.window.show).toHaveBeenCalledOnce();

    const late = fixture();
    late.window.visible = false;
    const controller = new AbortController();
    const waiting = waitForCredentialSurfaceVisible(late.window, controller.signal);
    const lateReady = [...(late.windowEvents.get("ready-to-show") ?? [])][0];
    controller.abort();
    await expect(waiting).rejects.toThrow("Credential surface did not become visibly ready.");
    lateReady?.();
    expect(late.window.show).not.toHaveBeenCalled();
    expect(late.windowEvents.get("ready-to-show")?.size ?? 0).toBe(0);
    expect(late.contentsEvents.get("render-process-gone")?.size ?? 0).toBe(0);
  });

  it("cancels the one startup deadline only after verified visibility", async () => {
    const f = fixture();
    f.window.visible = false;
    const timer = startupTimerFixture();
    const phases: string[] = [];
    const completion = runCredentialStartupTask({
      run: async (setPhase, signal) => await launchCredentialSurface({ ...baseOptions(f), signal, onPhase: (phase) => { phases.push(phase); setPhase(phase); } }),
      exit: vi.fn(),
      fallbackExit: vi.fn(),
      writeLine: vi.fn(),
      timer: timer.timer,
    });
    await vi.waitFor(() => expect(phases).toContain("renderer-load"));
    expect(timer.timer.schedule).toHaveBeenCalledOnce();
    expect(timer.timer.cancel).not.toHaveBeenCalled();
    f.emitWindow("ready-to-show");
    await expect(completion).resolves.toBe(true);
    expect(f.window.isVisible()).toBe(true);
    expect(phases.at(-1)).toBe("surface-ready");
    expect(timer.timer.cancel).toHaveBeenCalledOnce();
  });

  it("bounds omitted visibility with one finite diagnostic and removes the observer before a late event", async () => {
    const f = fixture();
    f.window.visible = false;
    const timer = startupTimerFixture();
    const writeLine = vi.fn();
    const exit = vi.fn();
    const completion = runCredentialStartupTask({
      run: async (setPhase, signal) => await launchCredentialSurface({ ...baseOptions(f), signal, onPhase: setPhase }),
      exit,
      fallbackExit: vi.fn(),
      writeLine,
      timer: timer.timer,
    });
    await vi.waitFor(() => expect(f.windowEvents.get("ready-to-show")?.size).toBe(1));
    const lateReady = [...(f.windowEvents.get("ready-to-show") ?? [])][0];
    timer.fire();
    await expect(completion).resolves.toBe(false);
    expect(writeLine).toHaveBeenCalledOnce();
    expect(JSON.parse(writeLine.mock.calls[0]![0]) as unknown).toEqual({ schemaVersion: 1, operation: "credential-host-startup", phase: "renderer-load", code: "STARTUP_TIMEOUT", terminal: true });
    expect(exit).toHaveBeenCalledOnce();
    expect(f.windowEvents.get("ready-to-show")?.size ?? 0).toBe(0);
    expect(f.contentsEvents.get("render-process-gone")?.size ?? 0).toBe(0);
    lateReady?.();
    expect(f.window.show).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.service.close).toHaveBeenCalledOnce());
  });

  it("destroys and closes an idle credential surface", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      await launchCredentialSurface({ ...baseOptions(f), idleMs: 25 });
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
    await launchCredentialSurface(baseOptions(f));
    f.emitWindow("closed");
    await vi.waitFor(() => expect(f.app.exit).toHaveBeenCalledWith(1));
    expect(f.service.close).toHaveBeenCalledOnce();
    expect(f.app.quit).not.toHaveBeenCalled();
  });
});
