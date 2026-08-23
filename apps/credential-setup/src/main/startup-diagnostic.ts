import { writeSync } from "node:fs";
import { types } from "node:util";

export const CREDENTIAL_STARTUP_PHASES = Object.freeze([
  "runtime-binding",
  "protocol-registration",
  "app-readiness",
  "session-hardening",
  "service-composition",
  "window-creation",
  "ipc-installation",
  "renderer-load",
  "surface-ready",
  "cleanup",
] as const);

export type CredentialStartupPhase = (typeof CREDENTIAL_STARTUP_PHASES)[number];

export const CREDENTIAL_STARTUP_CODES = Object.freeze([
  "ELECTRON_RUNTIME_REQUIRED",
  "ELECTRON_BINDING_UNAVAILABLE",
  "ELECTRON_VERSION_UNREVIEWED",
  "SINGLE_INSTANCE_UNAVAILABLE",
  "ENCRYPTION_UNAVAILABLE",
  "APP_NOT_READY",
  "PLATFORM_UNSUPPORTED",
  "STARTUP_CONFIGURATION_INVALID",
  "CLEANUP_FAILED",
  "STARTUP_TIMEOUT",
  "STARTUP_FAILED",
] as const);

export type CredentialStartupCode = (typeof CREDENTIAL_STARTUP_CODES)[number];

export interface CredentialStartupDiagnosticRecord {
  readonly schemaVersion: 1;
  readonly operation: "credential-host-startup";
  readonly phase: CredentialStartupPhase;
  readonly code: CredentialStartupCode;
  readonly terminal: true;
}

const INTERNAL_CODE_MAP = Object.freeze({
  ELECTRON_RUNTIME_REQUIRED: "ELECTRON_RUNTIME_REQUIRED",
  ELECTRON_BINDING_UNAVAILABLE: "ELECTRON_BINDING_UNAVAILABLE",
  ELECTRON_VERSION_UNREVIEWED: "ELECTRON_VERSION_UNREVIEWED",
  SINGLE_INSTANCE_UNAVAILABLE: "SINGLE_INSTANCE_UNAVAILABLE",
  ENCRYPTION_UNAVAILABLE: "ENCRYPTION_UNAVAILABLE",
  APP_NOT_READY: "APP_NOT_READY",
  PLATFORM_UNSUPPORTED: "PLATFORM_UNSUPPORTED",
  INVALID_CONFIGURATION: "STARTUP_CONFIGURATION_INVALID",
  CLEANUP_FAILED: "CLEANUP_FAILED",
  STARTUP_TIMEOUT: "STARTUP_TIMEOUT",
} as const satisfies Readonly<Record<string, CredentialStartupCode>>);

export const CREDENTIAL_STARTUP_DEADLINE_MS = 30_000;

export interface CredentialStartupTimerHandle {
  unref?(): unknown;
}

export interface CredentialStartupTimer {
  schedule(callback: () => void, delayMs: number): CredentialStartupTimerHandle;
  cancel(handle: CredentialStartupTimerHandle): void;
}

const PRODUCTION_STARTUP_TIMER: CredentialStartupTimer = Object.freeze({
  schedule(callback: () => void, delayMs: number) { return setTimeout(callback, delayMs); },
  cancel(handle: CredentialStartupTimerHandle) { clearTimeout(handle as NodeJS.Timeout); },
});

export class CredentialStartupKnownError extends Error {
  readonly code: keyof typeof INTERNAL_CODE_MAP;

  constructor(code: keyof typeof INTERNAL_CODE_MAP) {
    super("Credential host startup failed.");
    this.name = "CredentialStartupKnownError";
    this.code = code;
  }
}

function finiteCode(error: unknown): CredentialStartupCode {
  try {
    if (typeof error !== "object" || error === null || types.isProxy(error) || !(error instanceof Error)) return "STARTUP_FAILED";
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string") return "STARTUP_FAILED";
    if (!Object.hasOwn(INTERNAL_CODE_MAP, descriptor.value)) return "STARTUP_FAILED";
    return INTERNAL_CODE_MAP[descriptor.value as keyof typeof INTERNAL_CODE_MAP];
  } catch {
    return "STARTUP_FAILED";
  }
}

export function credentialStartupDiagnosticRecord(phase: CredentialStartupPhase, error: unknown): CredentialStartupDiagnosticRecord {
  return Object.freeze({
    schemaVersion: 1,
    operation: "credential-host-startup",
    phase,
    code: finiteCode(error),
    terminal: true,
  });
}

export function createCredentialStartupDiagnostic(writeLine: (line: string) => void = (line) => { writeSync(2, line); }): Readonly<{
  emitFailure(phase: CredentialStartupPhase, error: unknown): boolean;
}> {
  let emitted = false;
  return Object.freeze({
    emitFailure(phase, error) {
      if (emitted) return false;
      emitted = true;
      const line = `${JSON.stringify(credentialStartupDiagnosticRecord(phase, error))}\n`;
      try { writeLine(line); } catch { /* preserve finite exit semantics when stderr is unavailable */ }
      return true;
    },
  });
}

export function runCredentialStartupTask(options: Readonly<{
  readonly run: (setPhase: (phase: CredentialStartupPhase) => void) => Promise<void> | void;
  readonly exit: (code: 1) => void;
  readonly fallbackExit: (code: 1) => void;
  readonly writeLine?: (line: string) => void;
  readonly timer?: CredentialStartupTimer;
}>): Promise<boolean> {
  return new Promise<boolean>((resolveResult) => {
    let phase: CredentialStartupPhase = "runtime-binding";
    let terminal = false;
    let settled = false;
    let watchdog: CredentialStartupTimerHandle | null = null;
    const diagnostic = createCredentialStartupDiagnostic(options.writeLine);
    const timer = options.timer ?? PRODUCTION_STARTUP_TIMER;

    const settle = (result: boolean): void => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };

    const cancelWatchdog = (): boolean => {
      const handle = watchdog;
      watchdog = null;
      if (handle === null) return true;
      try { timer.cancel(handle); return true; }
      catch { return false; }
    };

    const fail = (error: unknown): boolean => {
      if (terminal) return false;
      terminal = true;
      cancelWatchdog();
      diagnostic.emitFailure(phase, error);
      try { options.exit(1); }
      catch {
        try { options.fallbackExit(1); } catch { /* no further output or retry */ }
      }
      settle(false);
      return true;
    };

    const setPhase = (next: CredentialStartupPhase): void => {
      if (terminal) return;
      if (!CREDENTIAL_STARTUP_PHASES.includes(next)) throw new Error("Invalid credential startup phase.");
      phase = next;
      if (next === "surface-ready" && !cancelWatchdog()) throw new Error("Credential startup watchdog cancellation failed.");
    };

    try {
      const scheduled = timer.schedule(() => { fail(new CredentialStartupKnownError("STARTUP_TIMEOUT")); }, CREDENTIAL_STARTUP_DEADLINE_MS);
      watchdog = scheduled;
      if (terminal) {
        cancelWatchdog();
        return;
      }
      try { scheduled.unref?.(); }
      catch { throw new Error("Credential startup watchdog detachment failed."); }

      let running: Promise<void> | void;
      try { running = options.run(setPhase); }
      catch (error) { fail(error); return; }

      void Promise.resolve(running).then(
        () => {
          if (terminal) return;
          if (phase !== "surface-ready") {
            fail(new CredentialStartupKnownError("APP_NOT_READY"));
            return;
          }
          if (!cancelWatchdog()) {
            fail(new Error("Credential startup watchdog cancellation failed."));
            return;
          }
          terminal = true;
          settle(true);
        },
        (error: unknown) => { fail(error); },
      );
    } catch (error) {
      fail(error);
    }
  });
}
