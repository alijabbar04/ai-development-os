import { describe, expect, it, vi } from "vitest";
import {
  CREDENTIAL_STARTUP_DEADLINE_MS,
  CREDENTIAL_STARTUP_PHASES,
  CredentialStartupKnownError,
  createCredentialStartupDiagnostic,
  credentialStartupDiagnosticRecord,
  runCredentialStartupTask,
  type CredentialStartupCode,
  type CredentialStartupPhase,
  type CredentialStartupTimer,
} from "../src/main/startup-diagnostic.js";

function codedError(code: string): Error {
  return Object.assign(new Error("private-startup-canary"), { code });
}

function timerFixture() {
  let callback: (() => void) | null = null;
  const handle = { unref: vi.fn() };
  const timer: CredentialStartupTimer = {
    schedule: vi.fn((scheduled, delayMs) => {
      expect(delayMs).toBe(CREDENTIAL_STARTUP_DEADLINE_MS);
      callback = scheduled;
      return handle;
    }),
    cancel: vi.fn(),
  };
  return {
    timer,
    handle,
    fire() {
      const scheduled = callback;
      if (scheduled === null) throw new Error("Synthetic startup watchdog was not scheduled.");
      scheduled();
    },
  };
}

describe("bounded credential-host startup diagnostics", () => {
  it("emits every finite startup phase without copying error content", () => {
    for (const phase of CREDENTIAL_STARTUP_PHASES) {
      expect(credentialStartupDiagnosticRecord(phase, new Error("private-startup-canary"))).toEqual({
        schemaVersion: 1,
        operation: "credential-host-startup",
        phase,
        code: "STARTUP_FAILED",
        terminal: true,
      });
    }
  });

  it("maps only the reviewed internal code vocabulary", () => {
    const cases: readonly [string, CredentialStartupCode][] = [
      ["ELECTRON_RUNTIME_REQUIRED", "ELECTRON_RUNTIME_REQUIRED"],
      ["ELECTRON_BINDING_UNAVAILABLE", "ELECTRON_BINDING_UNAVAILABLE"],
      ["ELECTRON_VERSION_UNREVIEWED", "ELECTRON_VERSION_UNREVIEWED"],
      ["SINGLE_INSTANCE_UNAVAILABLE", "SINGLE_INSTANCE_UNAVAILABLE"],
      ["ENCRYPTION_UNAVAILABLE", "ENCRYPTION_UNAVAILABLE"],
      ["APP_NOT_READY", "APP_NOT_READY"],
      ["PLATFORM_UNSUPPORTED", "PLATFORM_UNSUPPORTED"],
      ["INVALID_CONFIGURATION", "STARTUP_CONFIGURATION_INVALID"],
      ["CLEANUP_FAILED", "CLEANUP_FAILED"],
      ["STARTUP_TIMEOUT", "STARTUP_TIMEOUT"],
    ];
    for (const [internal, expected] of cases) expect(credentialStartupDiagnosticRecord("runtime-binding", codedError(internal)).code).toBe(expected);
    expect(credentialStartupDiagnosticRecord("runtime-binding", new CredentialStartupKnownError("ELECTRON_RUNTIME_REQUIRED")).code).toBe("ELECTRON_RUNTIME_REQUIRED");
    expect(credentialStartupDiagnosticRecord("runtime-binding", codedError("UNREVIEWED_CODE")).code).toBe("STARTUP_FAILED");
    for (const inherited of ["__proto__", "constructor", "toString", "valueOf"]) expect(credentialStartupDiagnosticRecord("runtime-binding", codedError(inherited)).code).toBe("STARTUP_FAILED");
  });

  it("collapses hostile errors, accessors, controls, cycles, symbols, and enormous values", () => {
    const cycle: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    cycle["self"] = cycle;
    const accessor = Object.defineProperty(new Error("private-startup-canary"), "code", { get() { throw new Error("private-getter-canary"); } });
    const hostile = [
      new Proxy(new Error("private-proxy-canary"), {}),
      accessor,
      cycle,
      Symbol("private-symbol-canary"),
      codedError("ENCRYPTION_UNAVAILABLE\nprivate-injection-canary"),
      codedError("x".repeat(1_000_000)),
    ];
    for (const value of hostile) {
      const record = credentialStartupDiagnosticRecord("service-composition", value);
      expect(record.code).toBe("STARTUP_FAILED");
      expect(JSON.stringify(record)).not.toMatch(/private|injection|getter|proxy|symbol/iu);
    }
  });

  it("emits at most one bounded JSON line even when called repeatedly", () => {
    const lines: string[] = [];
    const diagnostic = createCredentialStartupDiagnostic((line) => { lines.push(line); });
    expect(diagnostic.emitFailure("renderer-load", new Error("private-first-canary"))).toBe(true);
    expect(diagnostic.emitFailure("cleanup", new Error("private-second-canary"))).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBeLessThan(256);
    expect(lines[0]!.match(/\n/gu)).toHaveLength(1);
    expect(JSON.parse(lines[0]!) as unknown).toEqual({ schemaVersion: 1, operation: "credential-host-startup", phase: "renderer-load", code: "STARTUP_FAILED", terminal: true });
    expect(lines[0]).not.toContain("private");
  });

  it("does not retry output when the bounded stderr writer fails", () => {
    const writer = vi.fn(() => { throw new Error("synthetic-stderr-failure"); });
    const diagnostic = createCredentialStartupDiagnostic(writer);
    expect(diagnostic.emitFailure("runtime-binding", new Error("private"))).toBe(true);
    expect(diagnostic.emitFailure("runtime-binding", new Error("private"))).toBe(false);
    expect(writer).toHaveBeenCalledOnce();
  });

  it("uses the synchronous bounded stderr writer by default", () => {
    const diagnostic = createCredentialStartupDiagnostic();
    expect(diagnostic.emitFailure("cleanup", new CredentialStartupKnownError("CLEANUP_FAILED"))).toBe(true);
  });

  it("emits nothing and does not exit on success", async () => {
    const timer = timerFixture();
    const writeLine = vi.fn();
    const exit = vi.fn();
    const fallbackExit = vi.fn();
    await expect(runCredentialStartupTask({ run: async (setPhase) => { setPhase("surface-ready"); }, exit, fallbackExit, writeLine, timer: timer.timer })).resolves.toBe(true);
    expect(writeLine).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(fallbackExit).not.toHaveBeenCalled();
    expect(timer.timer.schedule).toHaveBeenCalledOnce();
    expect(timer.handle.unref).toHaveBeenCalledOnce();
    expect(timer.timer.cancel).toHaveBeenCalledOnce();
    timer.fire();
    expect(writeLine).not.toHaveBeenCalled();
  });

  it("times out once at every finite phase before surface-ready and retains only the last phase", async () => {
    const preSurfacePhases = CREDENTIAL_STARTUP_PHASES.slice(0, CREDENTIAL_STARTUP_PHASES.indexOf("surface-ready"));
    for (const phase of preSurfacePhases) {
      const timer = timerFixture();
      const writeLine = vi.fn();
      const exit = vi.fn();
      const completion = runCredentialStartupTask({
        run(setPhase) {
          setPhase(phase as CredentialStartupPhase);
          return new Promise<void>(() => undefined);
        },
        exit,
        fallbackExit: vi.fn(),
        writeLine,
        timer: timer.timer,
      });
      timer.fire();
      await expect(completion).resolves.toBe(false);
      expect(exit).toHaveBeenCalledOnce();
      expect(writeLine).toHaveBeenCalledOnce();
      expect(JSON.parse(writeLine.mock.calls[0]![0]) as unknown).toEqual({
        schemaVersion: 1,
        operation: "credential-host-startup",
        phase,
        code: "STARTUP_TIMEOUT",
        terminal: true,
      });
    }
  });

  it("adjudicates app-never-ready timeout and suppresses a later task rejection", async () => {
    const timer = timerFixture();
    const writeLine = vi.fn();
    const exit = vi.fn();
    let rejectRun: ((reason: unknown) => void) | undefined;
    const completion = runCredentialStartupTask({
      run(setPhase) {
        setPhase("app-readiness");
        return new Promise<void>((_resolve, reject) => { rejectRun = reject; });
      },
      exit,
      fallbackExit: vi.fn(),
      writeLine,
      timer: timer.timer,
    });
    timer.fire();
    await expect(completion).resolves.toBe(false);
    rejectRun?.(new Error("private-late-rejection-canary"));
    await Promise.resolve();
    expect(writeLine).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
    expect(writeLine.mock.calls[0]![0]).toContain('"phase":"app-readiness","code":"STARTUP_TIMEOUT"');
    expect(writeLine.mock.calls[0]![0]).not.toContain("private");
  });

  it("rejects a premature successful return before surface-ready", async () => {
    const timer = timerFixture();
    const writeLine = vi.fn();
    const exit = vi.fn();
    await expect(runCredentialStartupTask({
      run(setPhase) { setPhase("renderer-load"); },
      exit,
      fallbackExit: vi.fn(),
      writeLine,
      timer: timer.timer,
    })).resolves.toBe(false);
    expect(writeLine).toHaveBeenCalledOnce();
    expect(writeLine.mock.calls[0]![0]).toContain('"phase":"renderer-load","code":"APP_NOT_READY"');
    expect(exit).toHaveBeenCalledOnce();
  });

  it("contains watchdog scheduling and detachment failures inside one terminal boundary", async () => {
    for (const timer of [
      { schedule() { throw new Error("private-schedule-canary"); }, cancel: vi.fn() },
      { schedule() { return { unref() { throw new Error("private-unref-canary"); } }; }, cancel: vi.fn() },
    ] satisfies CredentialStartupTimer[]) {
      const writeLine = vi.fn();
      const exit = vi.fn();
      await expect(runCredentialStartupTask({ run: vi.fn(), exit, fallbackExit: vi.fn(), writeLine, timer })).resolves.toBe(false);
      expect(writeLine).toHaveBeenCalledOnce();
      expect(writeLine.mock.calls[0]![0]).not.toContain("private");
      expect(exit).toHaveBeenCalledOnce();
    }
  });

  it("fails finitely when a successful surface cannot cancel its watchdog", async () => {
    const timer = timerFixture();
    timer.timer.cancel = vi.fn(() => { throw new Error("private-cancel-canary"); });
    const writeLine = vi.fn();
    const exit = vi.fn();
    await expect(runCredentialStartupTask({
      run(setPhase) { setPhase("surface-ready"); },
      exit,
      fallbackExit: vi.fn(),
      writeLine,
      timer: timer.timer,
    })).resolves.toBe(false);
    expect(writeLine).toHaveBeenCalledOnce();
    expect(writeLine.mock.calls[0]![0]).toContain('"phase":"surface-ready","code":"STARTUP_FAILED"');
    expect(writeLine.mock.calls[0]![0]).not.toContain("private");
    expect(exit).toHaveBeenCalledOnce();
  });

  it("resolves finitely when both application exit paths throw", async () => {
    const timer = timerFixture();
    const writeLine = vi.fn();
    await expect(runCredentialStartupTask({
      run() { throw new Error("private-run-canary"); },
      exit() { throw new Error("private-exit-canary"); },
      fallbackExit() { throw new Error("private-fallback-canary"); },
      writeLine,
      timer: timer.timer,
    })).resolves.toBe(false);
    expect(writeLine).toHaveBeenCalledOnce();
    expect(writeLine.mock.calls[0]![0]).not.toContain("private");
  });

  it("catches synchronous and asynchronous failures, preserves cleanup, and exits once", async () => {
    for (const asynchronous of [false, true]) {
      const writeLine = vi.fn();
      const exit = vi.fn();
      const cleanup = vi.fn();
      const failure = new CredentialStartupKnownError("ENCRYPTION_UNAVAILABLE");
      const result = await runCredentialStartupTask({
        run: async (setPhase) => {
          setPhase("service-composition");
          try {
            if (asynchronous) await Promise.reject(failure);
            throw failure;
          } finally { cleanup(); }
        },
        exit,
        fallbackExit: vi.fn(),
        writeLine,
      });
      expect(result).toBe(false);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(1);
      expect(writeLine).toHaveBeenCalledOnce();
      expect(writeLine.mock.calls[0]![0]).toContain('"phase":"service-composition","code":"ENCRYPTION_UNAVAILABLE"');
    }
  });

  it("uses the finite fallback exit when the primary exit throws", async () => {
    const fallbackExit = vi.fn();
    const result = await runCredentialStartupTask({
      run() { throw new Error("private-startup-canary"); },
      exit() { throw new Error("private-exit-canary"); },
      fallbackExit,
      writeLine: vi.fn(),
    });
    expect(result).toBe(false);
    expect(fallbackExit).toHaveBeenCalledOnce();
    expect(fallbackExit).toHaveBeenCalledWith(1);
  });

  it("refuses an invalid internal phase without emitting it", async () => {
    const lines: string[] = [];
    const result = await runCredentialStartupTask({
      run(setPhase) { setPhase("private-phase\ncanary" as never); },
      exit: vi.fn(),
      fallbackExit: vi.fn(),
      writeLine(line) { lines.push(line); },
    });
    expect(result).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"phase":"runtime-binding","code":"STARTUP_FAILED"');
    expect(lines[0]).not.toContain("private-phase");
  });
});
