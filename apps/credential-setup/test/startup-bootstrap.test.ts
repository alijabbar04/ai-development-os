import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

interface BootstrapApp {
  setName(name: string): void;
  exit(code: number): void;
}

interface BootstrapOptions {
  loadElectron(): unknown;
  electronVersion(): unknown;
  loadMain(): Promise<unknown> | unknown;
}

interface BootstrapModule {
  startProductionCredentialBootstrap(deadline: BootstrapDeadline, options: BootstrapOptions): boolean;
}

interface BootstrapDeadline {
  beginBootstrap(): boolean;
  bindElectronExit(exit: (code: 1) => void): boolean;
  claim(owner: { exit(code: 1): void; fallbackExit(code: 1): void; onTerminal(result: boolean): void }): boolean;
  setPhase(phase: string): boolean;
  fail(code: string): boolean;
  isActive(): boolean;
  isClaimed(): boolean;
}

interface DeadlineModule {
  boundedFailureLine(phase: unknown, code: unknown): string;
  createCredentialStartupDeadline(options: Record<string, unknown>): BootstrapDeadline;
}

const require = createRequire(import.meta.url);
const bootstrap = require("../src/main/startup-bootstrap-runtime.cjs") as BootstrapModule;
const deadlineRuntime = require("../src/main/startup-deadline.cjs") as DeadlineModule;

function fixture(overrides: Partial<BootstrapOptions> = {}) {
  const events: string[] = [];
  const lines: string[] = [];
  let deadline!: BootstrapDeadline;
  const app: BootstrapApp = {
    setName(name) { events.push(`set-name:${name}`); },
    exit(code) { events.push(`app-exit:${code}`); },
  };
  const options: BootstrapOptions = {
    loadElectron() {
      events.push("load-electron");
      return {
        app,
        protocol: {
          registerSchemesAsPrivileged(value: unknown) {
            events.push(`register:${JSON.stringify(value)}`);
          },
        },
      };
    },
    electronVersion() { events.push("electron-version"); return "43.4.1"; },
    loadMain() {
      events.push("load-main");
      deadline.claim({ exit: () => undefined, fallbackExit: () => undefined, onTerminal: () => undefined });
      return Promise.resolve();
    },
    ...overrides,
  };
  deadline = deadlineRuntime.createCredentialStartupDeadline({
    timer: { schedule: () => ({ unref() {} }), cancel() {} },
    writeLine: (line: string) => { lines.push(line); },
    setExitCode: (code: number) => { events.push(`process-exit-code:${code}`); },
    exit: (code: number) => { events.push(`force-exit:${code}`); },
    fallbackExit: (code: number) => { events.push(`fallback-exit:${code}`); },
  });
  return { app, deadline, events, lines, options };
}

describe("synchronous production startup bootstrap", () => {
  it("invokes the package-root entry exactly once without a require.main gate", () => {
    const entry = readFileSync(new URL("../src/main/startup-bootstrap.cjs", import.meta.url), "utf8");
    const startProductionCredentialBootstrap = vi.fn(() => true);
    const startupDeadline = { isActive: () => true, fail: vi.fn() };
    const armProductionCredentialStartupDeadline = vi.fn(() => startupDeadline);
    const module = { exports: {} as unknown };
    runInNewContext(entry, {
      module,
      exports: module.exports,
      require(specifier: string) {
        if (specifier === "./startup-deadline.cjs") return { armProductionCredentialStartupDeadline };
        if (specifier === "./startup-bootstrap-runtime.cjs") return { startProductionCredentialBootstrap };
        throw new Error("Unexpected bootstrap dependency.");
      },
    });
    expect(entry).not.toContain("require.main");
    expect(armProductionCredentialStartupDeadline).toHaveBeenCalledOnce();
    expect(startProductionCredentialBootstrap).toHaveBeenCalledOnce();
    expect(startProductionCredentialBootstrap).toHaveBeenCalledWith(startupDeadline);
    expect(module.exports).toMatchObject({ bootstrapStarted: true });
    expect(module.exports).not.toHaveProperty("startProductionCredentialBootstrap");
  });

  it("binds the exact runtime and registers the fixed privileged scheme before loading ESM", async () => {
    const f = fixture();
    expect(bootstrap.startProductionCredentialBootstrap(f.deadline, f.options)).toBe(true);
    await Promise.resolve();
    expect(f.events).toEqual([
      "load-electron",
      "electron-version",
      "set-name:AI Development OS Credential Setup",
      'register:[{"scheme":"app-credential","privileges":{"standard":true,"secure":true}}]',
      "load-main",
    ]);
    expect(f.lines).toEqual([]);
  });

  it("refuses missing, malformed, and unreviewed runtime bindings with one finite line", () => {
    const cases: readonly [Partial<BootstrapOptions>, string][] = [
      [{ loadElectron: () => "not-electron" }, "ELECTRON_BINDING_UNAVAILABLE"],
      [{ electronVersion: () => undefined }, "ELECTRON_RUNTIME_REQUIRED"],
      [{ electronVersion: () => "43.4.0" }, "ELECTRON_VERSION_UNREVIEWED"],
    ];
    for (const [override, code] of cases) {
      const f = fixture(override);
      expect(bootstrap.startProductionCredentialBootstrap(f.deadline, f.options)).toBe(false);
      expect(f.lines).toHaveLength(1);
      expect(JSON.parse(f.lines[0]!) as unknown).toEqual({ schemaVersion: 1, operation: "credential-host-startup", phase: "runtime-binding", code, terminal: true });
      expect(f.events.filter((event) => event === "process-exit-code:1")).toHaveLength(1);
    }
  });

  it("contains hostile Electron binding proxies and accessors inside the finite boundary", () => {
    const hostileBindings = [
      new Proxy({}, { get() { throw new Error("private-proxy-get-canary"); } }),
      Object.defineProperty({}, "app", { get() { throw new Error("private-app-getter-canary"); } }),
      Object.defineProperties({}, {
        app: { value: { setName() {}, exit() {} } },
        protocol: { get() { throw new Error("private-protocol-getter-canary"); } },
      }),
    ];
    for (const binding of hostileBindings) {
      const f = fixture({ loadElectron: () => binding });
      expect(bootstrap.startProductionCredentialBootstrap(f.deadline, f.options)).toBe(false);
      expect(f.lines).toHaveLength(1);
      expect(f.lines[0]).toContain('"phase":"runtime-binding","code":"ELECTRON_BINDING_UNAVAILABLE"');
      expect(f.lines[0]).not.toContain("private");
      expect(f.events.filter((event) => event === "process-exit-code:1")).toHaveLength(1);
      expect(f.events.filter((event) => event.endsWith("exit:1")).length).toBeLessThanOrEqual(1);
    }
  });

  it("forces a finite pre-service exit only when no safe Electron exit remains", () => {
    const normal = fixture({ electronVersion: () => "43.4.0" });
    expect(bootstrap.startProductionCredentialBootstrap(normal.deadline, normal.options)).toBe(false);
    expect(normal.events).toContain("app-exit:1");
    expect(normal.events).not.toContain("force-exit:1");

    const fallback = fixture({
      loadElectron: () => ({
        app: { setName() {}, exit() { throw new Error("private-exit-canary"); } },
        protocol: { registerSchemesAsPrivileged() { throw new Error("private-protocol-canary"); } },
      }),
    });
    expect(bootstrap.startProductionCredentialBootstrap(fallback.deadline, fallback.options)).toBe(false);
    expect(fallback.lines).toHaveLength(1);
    expect(fallback.events).toContain("process-exit-code:1");
    expect(fallback.events).toContain("fallback-exit:1");
  });

  it("collapses protocol and ESM loader failures without copying hostile content", async () => {
    const protocol = fixture({
      loadElectron() {
        return {
          app: { setName() {}, exit() {} },
          protocol: { registerSchemesAsPrivileged() { throw new Error("private-protocol-canary\nprivate-injection"); } },
        };
      },
    });
    expect(bootstrap.startProductionCredentialBootstrap(protocol.deadline, protocol.options)).toBe(false);
    expect(protocol.lines).toHaveLength(1);
    expect(protocol.lines[0]).toContain('"phase":"protocol-registration","code":"STARTUP_FAILED"');
    expect(protocol.lines[0]).not.toContain("private");

    const loader = fixture({ loadMain: () => Promise.reject(new Error("private-loader-canary")) });
    expect(bootstrap.startProductionCredentialBootstrap(loader.deadline, loader.options)).toBe(true);
    await vi.waitFor(() => expect(loader.lines).toHaveLength(1));
    expect(loader.lines[0]).toContain('"phase":"runtime-binding","code":"STARTUP_FAILED"');
    expect(loader.lines[0]).not.toContain("private");
  });

  it("clamps unreviewed failure fields to the finite bootstrap vocabulary", () => {
    const line = deadlineRuntime.boundedFailureLine("private-phase\ncanary", "private-code\ncanary");
    expect(line.match(/\n/gu)).toHaveLength(1);
    expect(line.length).toBeLessThan(256);
    expect(JSON.parse(line) as unknown).toEqual({ schemaVersion: 1, operation: "credential-host-startup", phase: "runtime-binding", code: "STARTUP_FAILED", terminal: true });
    expect(line).not.toContain("private");
  });
});
