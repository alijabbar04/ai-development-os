import { writeSync } from "node:fs";
import { createRequire } from "node:module";
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

export interface CredentialStartupDeadlineController {
  readonly deadlineMs: number;
  beginBootstrap(): boolean;
  bindElectronExit(exit: (code: 1) => void): boolean;
  claim(owner: Readonly<{
    exit(code: 1): void;
    fallbackExit(code: 1): void;
    onTerminal(result: boolean): void;
  }>): boolean;
  setPhase(phase: CredentialStartupPhase): boolean;
  fail(code: CredentialStartupCode): boolean;
  complete(): boolean;
  isActive(): boolean;
  isClaimed(): boolean;
  didSucceed(): boolean;
  currentPhase(): CredentialStartupPhase;
}

interface CredentialStartupDeadlineRuntime {
  createCredentialStartupDeadline(options: Readonly<{
    timer: CredentialStartupTimer;
    writeLine(line: string): void;
    setExitCode(code: 1): void;
    exit(code: 1): void;
    fallbackExit(code: 1): void;
    installFatalHandlers?: (onFatal: () => void) => () => void;
  }>): CredentialStartupDeadlineController;
  productionCredentialStartupDeadline(): CredentialStartupDeadlineController | null;
}

const require = createRequire(import.meta.url);
const DEADLINE_RUNTIME = require("./startup-deadline.cjs") as CredentialStartupDeadlineRuntime;

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

function writeStartupDiagnosticLine(line: string): void { writeSync(2, line); }

export function createCredentialStartupDiagnostic(writeLine: (line: string) => void = writeStartupDiagnosticLine): Readonly<{
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
  readonly run: (setPhase: (phase: CredentialStartupPhase) => void, signal: AbortSignal) => Promise<void> | void;
  readonly exit: (code: 1) => void;
  readonly fallbackExit: (code: 1) => void;
  readonly writeLine?: (line: string) => void;
  readonly timer?: CredentialStartupTimer;
  readonly deadline?: CredentialStartupDeadlineController;
}>): Promise<boolean> {
  const deadline = options.deadline
    ?? (options.timer !== undefined || options.writeLine !== undefined
      ? DEADLINE_RUNTIME.createCredentialStartupDeadline({
        timer: options.timer ?? PRODUCTION_STARTUP_TIMER,
        writeLine: options.writeLine ?? writeStartupDiagnosticLine,
        setExitCode: () => undefined,
        exit: options.exit,
        fallbackExit: options.fallbackExit,
      })
      : DEADLINE_RUNTIME.productionCredentialStartupDeadline());
  if (deadline === null) throw new Error("Credential startup deadline is not armed.");

  return new Promise<boolean>((resolveResult) => {
    let settled = false;
    const startupAbort = new AbortController();

    const settle = (result: boolean): void => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };

    const setPhase = (next: CredentialStartupPhase): void => {
      deadline.setPhase(next);
    };

    const claimed = deadline.claim({
      exit: options.exit,
      fallbackExit: options.fallbackExit,
      onTerminal(result) {
        if (!result) startupAbort.abort();
        settle(result);
      },
    });
    if (!claimed) {
      deadline.fail("STARTUP_FAILED");
      settle(false);
      return;
    }

    let running: Promise<void> | void;
    try { running = options.run(setPhase, startupAbort.signal); }
    catch (error) { deadline.fail(finiteCode(error)); settle(false); return; }

    void Promise.resolve(running).then(
      () => {
        if (!deadline.isActive()) {
          settle(deadline.didSucceed());
          return;
        }
        if (deadline.currentPhase() !== "surface-ready") deadline.fail("APP_NOT_READY");
        else deadline.complete();
        settle(deadline.didSucceed());
      },
      (error: unknown) => { deadline.fail(finiteCode(error)); settle(false); },
    );
  });
}
