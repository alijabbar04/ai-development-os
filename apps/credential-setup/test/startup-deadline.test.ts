import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import {
  CREDENTIAL_STARTUP_DEADLINE_MS,
  CredentialStartupKnownError,
  runCredentialStartupTask,
  type CredentialStartupDeadlineController,
  type CredentialStartupTimer,
} from "../src/main/startup-diagnostic.js";

interface DeadlineRuntime {
  readonly CREDENTIAL_STARTUP_DEADLINE_MS: number;
  createCredentialStartupDeadline(options: Record<string, unknown>): CredentialStartupDeadlineController;
}

interface BootstrapRuntime {
  startProductionCredentialBootstrap(deadline: CredentialStartupDeadlineController, options: Readonly<{
    loadElectron(): unknown;
    electronVersion(): unknown;
    loadMain(): Promise<unknown> | unknown;
  }>): boolean;
}

const require = createRequire(import.meta.url);
const deadlineRuntime = require("../src/main/startup-deadline.cjs") as DeadlineRuntime;
const bootstrapRuntime = require("../src/main/startup-bootstrap-runtime.cjs") as BootstrapRuntime;

function fixture(overrides: Readonly<{
  scheduleThrows?: boolean;
  cancelThrows?: boolean;
  unrefThrows?: boolean;
  fireSynchronously?: boolean;
  exitThrows?: boolean;
  fallbackThrows?: boolean;
  installFatalHandlers?: boolean;
}> = {}) {
  let callback: (() => void) | null = null;
  let fatal: (() => void) | null = null;
  const lines: string[] = [];
  const exits: number[] = [];
  const fallbacks: number[] = [];
  const exitCodes: number[] = [];
  const handle = { unref: vi.fn(() => { if (overrides.unrefThrows) throw new Error("private-unref-canary"); }) };
  const timer: CredentialStartupTimer = {
    schedule: vi.fn((scheduled, delayMs) => {
      if (overrides.scheduleThrows) throw new Error("private-schedule-canary");
      callback = scheduled;
      expect(delayMs).toBe(CREDENTIAL_STARTUP_DEADLINE_MS);
      if (overrides.fireSynchronously) scheduled();
      return handle;
    }),
    cancel: vi.fn(() => { if (overrides.cancelThrows) throw new Error("private-cancel-canary"); }),
  };
  const disposeFatalHandlers = vi.fn();
  const deadline = deadlineRuntime.createCredentialStartupDeadline({
    timer,
    writeLine: (line: string) => { lines.push(line); },
    setExitCode: (code: number) => { exitCodes.push(code); },
    exit: (code: number) => { exits.push(code); if (overrides.exitThrows) throw new Error("private-exit-canary"); },
    fallbackExit: (code: number) => { fallbacks.push(code); if (overrides.fallbackThrows) throw new Error("private-fallback-canary"); },
    ...(overrides.installFatalHandlers
      ? { installFatalHandlers: (onFatal: () => void) => { fatal = onFatal; return disposeFatalHandlers; } }
      : {}),
  });
  return {
    deadline, timer, handle, lines, exits, fallbacks, exitCodes, disposeFatalHandlers,
    fire() {
      const scheduled = callback;
      if (scheduled === null) throw new Error("Synthetic deadline was not scheduled.");
      scheduled();
    },
    fireFatal() {
      const handler = fatal;
      if (handler === null) throw new Error("Synthetic fatal owner was not installed.");
      handler();
    },
  };
}

function electronBinding(exits: number[]) {
  return {
    app: { setName: vi.fn(), exit: (code: number) => { exits.push(code); } },
    protocol: { registerSchemesAsPrivileged: vi.fn() },
  };
}

describe("one continuous bootstrap-to-visible startup deadline", () => {
  it("uses one fixed absolute timer through a normal one-shot handoff", async () => {
    const f = fixture();
    const completion = runCredentialStartupTask({
      deadline: f.deadline,
      run(setPhase) { setPhase("renderer-load"); setPhase("surface-ready"); },
      exit: vi.fn(),
      fallbackExit: vi.fn(),
    });
    await expect(completion).resolves.toBe(true);
    expect(deadlineRuntime.CREDENTIAL_STARTUP_DEADLINE_MS).toBe(30_000);
    expect(f.timer.schedule).toHaveBeenCalledOnce();
    expect(f.timer.schedule).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(f.handle.unref).toHaveBeenCalledOnce();
    expect(f.timer.cancel).toHaveBeenCalledOnce();
    expect(f.deadline.isClaimed()).toBe(true);
    expect(f.lines).toEqual([]);
    f.fire();
    expect(f.lines).toEqual([]);
  });

  it("terminates a loadMain promise that never settles", async () => {
    const f = fixture();
    const appExits: number[] = [];
    expect(bootstrapRuntime.startProductionCredentialBootstrap(f.deadline, {
      loadElectron: () => electronBinding(appExits),
      electronVersion: () => "43.4.1",
      loadMain: () => new Promise(() => undefined),
    })).toBe(true);
    expect(f.deadline.currentPhase()).toBe("runtime-binding");
    f.fire();
    expect(f.lines).toHaveLength(1);
    expect(JSON.parse(f.lines[0]!) as unknown).toEqual({ schemaVersion: 1, operation: "credential-host-startup", phase: "runtime-binding", code: "STARTUP_TIMEOUT", terminal: true });
    expect(appExits).toEqual([1]);
    expect(f.timer.schedule).toHaveBeenCalledOnce();
  });

  it("bounds rejection before handoff and refuses a missing handoff", async () => {
    for (const mode of ["reject", "missing"] as const) {
      const f = fixture();
      const appExits: number[] = [];
      expect(bootstrapRuntime.startProductionCredentialBootstrap(f.deadline, {
        loadElectron: () => electronBinding(appExits),
        electronVersion: () => "43.4.1",
        loadMain: () => mode === "reject" ? Promise.reject(new Error("private-import-canary")) : Promise.resolve(),
      })).toBe(true);
      await vi.waitFor(() => expect(f.lines).toHaveLength(1));
      expect(f.lines[0]).toContain('"phase":"runtime-binding","code":"STARTUP_FAILED"');
      expect(f.lines[0]).not.toContain("private");
      expect(appExits).toEqual([1]);
      expect(f.timer.schedule).toHaveBeenCalledOnce();
      expect(f.timer.cancel).toHaveBeenCalledOnce();
    }
  });

  it("keeps timeout and rejection races single-owned after handoff", async () => {
    const f = fixture();
    const writeLine = vi.fn((line: string) => { f.lines.push(line); });
    const exit = vi.fn();
    let rejectRun: ((reason: unknown) => void) | null = null;
    const completion = runCredentialStartupTask({
      deadline: f.deadline,
      run(setPhase) {
        setPhase("renderer-load");
        return new Promise<void>((_resolve, reject) => { rejectRun = reject; });
      },
      exit,
      fallbackExit: vi.fn(),
      writeLine,
    });
    f.fire();
    rejectRun?.(new CredentialStartupKnownError("ENCRYPTION_UNAVAILABLE"));
    await expect(completion).resolves.toBe(false);
    await Promise.resolve();
    expect(f.lines).toHaveLength(1);
    expect(f.lines[0]).toContain('"phase":"renderer-load","code":"STARTUP_TIMEOUT"');
    expect(exit).toHaveBeenCalledOnce();
  });

  it("bounds a task rejection during handoff without resetting the deadline", async () => {
    const f = fixture();
    const exit = vi.fn();
    await expect(runCredentialStartupTask({
      deadline: f.deadline,
      run(setPhase) { setPhase("service-composition"); return Promise.reject(new CredentialStartupKnownError("ENCRYPTION_UNAVAILABLE")); },
      exit,
      fallbackExit: vi.fn(),
    })).resolves.toBe(false);
    expect(f.lines).toHaveLength(1);
    expect(f.lines[0]).toContain('"phase":"service-composition","code":"ENCRYPTION_UNAVAILABLE"');
    expect(exit).toHaveBeenCalledOnce();
    expect(f.timer.schedule).toHaveBeenCalledOnce();
  });

  it("refuses duplicate handoff with exactly one diagnostic and one exit", async () => {
    const f = fixture();
    const exit = vi.fn();
    const first = runCredentialStartupTask({ deadline: f.deadline, run: () => new Promise(() => undefined), exit, fallbackExit: vi.fn() });
    const second = runCredentialStartupTask({ deadline: f.deadline, run: vi.fn(), exit, fallbackExit: vi.fn() });
    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
    expect(f.lines).toHaveLength(1);
    expect(exit).toHaveBeenCalledOnce();
    expect(f.timer.schedule).toHaveBeenCalledOnce();
  });

  it("contains scheduling and cancellation failures without a second timer", async () => {
    const scheduling = fixture({ scheduleThrows: true });
    await expect(runCredentialStartupTask({ deadline: scheduling.deadline, run: vi.fn(), exit: vi.fn(), fallbackExit: vi.fn() })).resolves.toBe(false);
    expect(scheduling.lines).toHaveLength(1);
    expect(scheduling.lines[0]).toContain('"phase":"runtime-binding","code":"STARTUP_FAILED"');
    expect(scheduling.timer.schedule).toHaveBeenCalledOnce();

    const cancellation = fixture({ cancelThrows: true });
    await expect(runCredentialStartupTask({
      deadline: cancellation.deadline,
      run(setPhase) { setPhase("surface-ready"); },
      exit: vi.fn(),
      fallbackExit: vi.fn(),
    })).resolves.toBe(false);
    expect(cancellation.lines).toHaveLength(1);
    expect(cancellation.lines[0]).toContain('"phase":"cleanup","code":"CLEANUP_FAILED"');
    expect(cancellation.timer.schedule).toHaveBeenCalledOnce();
  });

  it("contains detachment failure and a synchronously firing timer without reopening startup", async () => {
    const detachment = fixture({ unrefThrows: true });
    await expect(runCredentialStartupTask({ deadline: detachment.deadline, run: vi.fn(), exit: vi.fn(), fallbackExit: vi.fn() })).resolves.toBe(false);
    expect(detachment.lines).toHaveLength(1);
    expect(detachment.lines[0]).toContain('"phase":"runtime-binding","code":"STARTUP_FAILED"');
    expect(detachment.timer.schedule).toHaveBeenCalledOnce();
    expect(detachment.timer.cancel).toHaveBeenCalledOnce();

    const synchronous = fixture({ fireSynchronously: true });
    await expect(runCredentialStartupTask({ deadline: synchronous.deadline, run: vi.fn(), exit: vi.fn(), fallbackExit: vi.fn() })).resolves.toBe(false);
    expect(synchronous.lines).toHaveLength(1);
    expect(synchronous.lines[0]).toContain('"phase":"runtime-binding","code":"STARTUP_TIMEOUT"');
    expect(synchronous.timer.schedule).toHaveBeenCalledOnce();
    expect(synchronous.timer.cancel).toHaveBeenCalledOnce();
    expect(synchronous.handle.unref).not.toHaveBeenCalled();
  });

  it("falls back once when safe exit fails and stays finite when the hard fallback also fails", () => {
    const fallback = fixture({ exitThrows: true });
    fallback.fire();
    expect(fallback.lines).toHaveLength(1);
    expect(fallback.exits).toEqual([1]);
    expect(fallback.fallbacks).toEqual([1]);

    const both = fixture({ exitThrows: true, fallbackThrows: true });
    expect(() => { both.fire(); }).not.toThrow();
    expect(both.lines).toHaveLength(1);
    expect(both.exits).toEqual([1]);
    expect(both.fallbacks).toEqual([1]);
    both.fire();
    expect(both.lines).toHaveLength(1);
  });

  it("owns hostile and late pre-ready fatal events, then removes the handlers on success", async () => {
    const failure = fixture({ installFatalHandlers: true });
    failure.fireFatal();
    failure.fireFatal();
    expect(failure.lines).toHaveLength(1);
    expect(failure.lines[0]).toContain('"code":"STARTUP_FAILED"');
    expect(failure.exits).toEqual([1]);

    const success = fixture({ installFatalHandlers: true });
    await expect(runCredentialStartupTask({
      deadline: success.deadline,
      run(setPhase) { setPhase("surface-ready"); },
      exit: vi.fn(),
      fallbackExit: vi.fn(),
    })).resolves.toBe(true);
    expect(success.disposeFatalHandlers).toHaveBeenCalledOnce();
    expect(success.lines).toEqual([]);
    success.fireFatal();
    expect(success.lines).toEqual([]);
  });

  it("loads the shared controller through one Node module-cache identity and exposes no reset", () => {
    const first = require("../src/main/startup-deadline.cjs") as Record<string, unknown>;
    const second = require("../src/main/startup-deadline.cjs") as Record<string, unknown>;
    expect(first).toBe(second);
    expect(first).not.toHaveProperty("reset");
    expect(first).not.toHaveProperty("cancelProductionCredentialStartupDeadline");
  });
});
