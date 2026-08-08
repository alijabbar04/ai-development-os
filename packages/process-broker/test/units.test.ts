import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DENY_ALL_NETWORK,
  MAX_WORKSPACE_PATH_DEPTH,
  ProcessBrokerError,
  applyArgumentPolicy,
  buildEnvironment,
  createExecutionLease,
  createLinuxSandboxBackend,
  createMacosSandboxBackend,
  createManualTime,
  createPlatformSandboxBackend,
  createProcessQuotas,
  createTrustedToolDescriptor,
  createUnsafeDevelopmentBackend,
  createWindowsSandboxBackend,
  errorCategory,
  fingerprintOf,
  grantAllowsOperation,
  grantFingerprint,
  isProcessBrokerError,
  isReservedWorkspaceSegment,
  isSensitiveEnvironmentName,
  parseOutputLimits,
  parseProcessQuotas,
  parseToolDigest,
  parseWorkspaceRelativePath,
  strippedNames,
  systemClock,
  systemScheduler,
} from "../src/index.js";
import { contractGrant, contractRequest } from "../src/testing/contract-suite.js";

const roots: string[] = [];
async function scratchRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "adox-units-"));
  roots.push(root);
  return root;
}
afterAll(async () => {
  await Promise.allSettled(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("injected time", () => {
  it("fires timers in deadline order then scheduling order", () => {
    const time = createManualTime();
    const fired: string[] = [];
    time.schedule(20, () => fired.push("b"));
    time.schedule(10, () => fired.push("a"));
    time.schedule(20, () => fired.push("c"));
    expect(time.pendingCount()).toBe(3);
    time.advance(25);
    expect(fired).toEqual(["a", "b", "c"]);
    expect(time.pendingCount()).toBe(0);
  });

  it("does not fire a cancelled timer and reports the pending count", () => {
    const time = createManualTime();
    let fired = 0;
    const task = time.schedule(10, () => (fired += 1));
    task.cancel();
    expect(time.pendingCount()).toBe(0);
    time.advance(100);
    expect(fired).toBe(0);
  });

  it("advances the clock even when nothing is scheduled", () => {
    const time = createManualTime("2026-08-02T00:00:00.000Z");
    time.advance(1_000);
    expect(time.now().toISOString()).toBe("2026-08-02T00:00:01.000Z");
    time.advance(-5);
    expect(time.now().toISOString()).toBe("2026-08-02T00:00:01.000Z");
  });

  it("rejects an invalid start instant", () => {
    expect(() => createManualTime("not-a-date")).toThrow(TypeError);
  });

  it("runs and cancels real timers", async () => {
    await new Promise<void>((resolve) => {
      systemScheduler.schedule(1, resolve);
    });
    const cancelled = systemScheduler.schedule(10_000, () => {
      throw new Error("must not run");
    });
    cancelled.cancel();
    expect(systemClock.now()).toBeInstanceOf(Date);
  });
});

describe("workspace-relative paths", () => {
  it("accepts an ordinary nested path", () => {
    expect(parseWorkspaceRelativePath("src/lib/main.ts")).toBe("src/lib/main.ts");
  });

  it("rejects administrative directories in any position and any case", () => {
    for (const candidate of [".git", ".git/config", "src/.git/hooks", "SRC/.GIT/x", ".hg/store", ".svn/entries", ".ai-dev-os/state"]) {
      expect(() => parseWorkspaceRelativePath(candidate)).toThrow(ProcessBrokerError);
    }
  });

  it("rejects a decomposed Unicode form of an administrative directory", () => {
    expect(isReservedWorkspaceSegment(".GIT")).toBe(true);
    expect(isReservedWorkspaceSegment("src")).toBe(false);
  });

  it("bounds nesting depth", () => {
    const deep = Array.from({ length: MAX_WORKSPACE_PATH_DEPTH + 1 }, (_, i) => `d${i}`).join("/");
    expect(() => parseWorkspaceRelativePath(deep)).toThrow(/nested/);
  });

  it("rejects traversal, absolute forms, and device names through the lexical layer", () => {
    for (const candidate of ["../x", "/abs", "C:/x", "a//b", "con/x", "a/b.", "a\\b", "x/../../y"]) {
      expect(() => parseWorkspaceRelativePath(candidate)).toThrow();
    }
  });
});

describe("error classification", () => {
  it("recognizes its own errors", () => {
    const error = new ProcessBrokerError("CANCELLED", "stopped");
    expect(isProcessBrokerError(error)).toBe(true);
    expect(isProcessBrokerError(new Error("x"))).toBe(false);
    expect(error.toJSON().code).toBe("CANCELLED");
    expect(Object.isFrozen(error)).toBe(true);
  });

  it("summarizes foreign failures as a category, never a payload", () => {
    expect(errorCategory(new ProcessBrokerError("SPAWN_FAILED", "x"))).toBe("SPAWN_FAILED");
    expect(errorCategory({ code: "ENOENT" })).toBe("ENOENT");
    expect(errorCategory({ code: "a".repeat(500) })).toBe("unknown");
    expect(errorCategory(new TypeError("secret detail"))).toBe("TypeError");
    expect(errorCategory("a raw string with secrets")).toBe("unknown");
    expect(errorCategory(null)).toBe("unknown");
  });
});

describe("environment helpers", () => {
  it("reports which host names were withheld", () => {
    const host = { SSH_AUTH_SOCK: "/tmp/agent", GITHUB_TOKEN: "t", LANG: "en_US.UTF-8" };
    const built = buildEnvironment({
      bindings: [],
      paths: { tempDir: "/w/tmp", homeDir: null, configDir: null, cacheDir: null },
      platform: "linux",
      hostEnvironment: host,
    });
    const stripped = strippedNames(host, built);
    expect(stripped).toContain("SSH_AUTH_SOCK");
    expect(stripped).toContain("GITHUB_TOKEN");
    expect(isSensitiveEnvironmentName("SSH_AUTH_SOCK")).toBe(true);
    expect(isSensitiveEnvironmentName("MY_APP_SETTING")).toBe(false);
  });

  it("supplies the Windows system minimum and a profile directory", () => {
    const built = buildEnvironment({
      bindings: [],
      paths: { tempDir: "C:/w/tmp", homeDir: "C:/w/home", configDir: "C:/w/cfg", cacheDir: "C:/w/cache" },
      platform: "win32",
      hostEnvironment: { SystemRoot: "C:/Windows", PATHEXT: ".EXE", SECRET: "no" },
    });
    expect(built.variables["SystemRoot"]).toBe("C:/Windows");
    expect(built.variables["USERPROFILE"]).toBe("C:/w/home");
    expect(built.variables["SECRET"]).toBeUndefined();
    expect(built.variables["XDG_CONFIG_HOME"]).toBe("C:/w/cfg");
    expect(built.variables["XDG_CACHE_HOME"]).toBe("C:/w/cache");
  });

  it("builds PATH only from granted directories", () => {
    const built = buildEnvironment({
      bindings: [],
      paths: { tempDir: "/w/tmp", homeDir: null, configDir: null, cacheDir: null },
      platform: "linux",
      hostEnvironment: { PATH: "/usr/local/bin:/usr/bin" },
      pathEntries: ["/granted/bin"],
    });
    expect(built.variables["PATH"]).toBe("/granted/bin");
  });
});

describe("output limits", () => {
  it("rejects malformed or contradictory limits", () => {
    expect(() => parseOutputLimits(null)).toThrow();
    expect(() => parseOutputLimits({ maxStreamBytes: 0, maxCombinedBytes: 1, maxLineBytes: 1 })).toThrow();
    expect(() => parseOutputLimits({ maxStreamBytes: 10, maxCombinedBytes: 5, maxLineBytes: 1 })).toThrow(
      /at least/,
    );
    expect(parseOutputLimits({ maxStreamBytes: 10, maxCombinedBytes: 20, maxLineBytes: 5 })).toEqual({
      maxStreamBytes: 10,
      maxCombinedBytes: 20,
      maxLineBytes: 5,
    });
  });
});

describe("quota parsing", () => {
  it("rejects out-of-range and unknown fields", () => {
    expect(() => parseProcessQuotas({ wallClockMs: 0, outputBytes: 1, cpuTimeMs: null, memoryBytes: null, processCount: null, diskBytes: null, fileCount: null })).toThrow();
    expect(() => parseProcessQuotas({ wallClockMs: 1, outputBytes: 1, extra: 1 })).toThrow();
    const quotas = createProcessQuotas({ wallClockMs: 1_000, outputBytes: 2_048 });
    expect(quotas.cpuTimeMs).toBeNull();
    expect(Object.isFrozen(quotas)).toBe(true);
  });
});

describe("tool digests and argument policy", () => {
  it("validates digest shape per algorithm", () => {
    expect(parseToolDigest({ algorithm: "sha-256", hex: "a".repeat(64) }).hex).toHaveLength(64);
    expect(() => parseToolDigest({ algorithm: "sha-256", hex: "a".repeat(63) })).toThrow();
    expect(() => parseToolDigest({ algorithm: "sha-512", hex: "a".repeat(64) })).toThrow();
    expect(() => parseToolDigest({ algorithm: "sha-256", hex: "A".repeat(64) })).toThrow();
  });

  it("prepends the pinned prefix and counts it against the limit", () => {
    const descriptor = createTrustedToolDescriptor({
      toolId: "pinned",
      executablePath: process.execPath,
      platform: process.platform as "win32",
      architecture: process.arch as "x64",
      trustSource: "operator-pinned",
      argumentPolicy: { maxArguments: 3, maxArgumentBytes: 64, pinnedLeadingArguments: ["entry.mjs"], denyOptionArguments: false },
    });
    expect(applyArgumentPolicy(descriptor, ["a"])).toEqual(["entry.mjs", "a"]);
    expect(() => applyArgumentPolicy(descriptor, ["a", "b", "c"])).toThrow(/argument count/);
  });

  it("rejects a pinned prefix larger than the argument limit", () => {
    expect(() =>
      createTrustedToolDescriptor({
        toolId: "over",
        executablePath: process.execPath,
        platform: process.platform as "win32",
        architecture: process.arch as "x64",
        trustSource: "operator-pinned",
        argumentPolicy: { maxArguments: 1, maxArgumentBytes: 64, pinnedLeadingArguments: ["a", "b"], denyOptionArguments: false },
      }),
    ).toThrow();
  });

  it("rejects a relative executable path", () => {
    expect(() =>
      createTrustedToolDescriptor({
        toolId: "relative",
        executablePath: "node",
        platform: process.platform as "win32",
        architecture: process.arch as "x64",
        trustSource: "operator-pinned",
      }),
    ).toThrow(/absolute/);
  });
});

describe("grant helpers", () => {
  it("exposes a stable fingerprint and operation check", () => {
    const grant = contractGrant({}, systemClock);
    expect(grantFingerprint(grant)).toMatch(/^[0-9a-f]{64}$/);
    expect(grantFingerprint(grant)).toBe(grantFingerprint(grant));
    expect(grantAllowsOperation(grant, "command-execution")).toBe(true);
    expect(grantAllowsOperation(grant, "git-commit")).toBe(false);
  });

  it("rejects an empty operation set, duplicate tools, and a bad window", () => {
    expect(() => contractGrant({ operations: [] })).toThrow();
    expect(() =>
      contractGrant({
        tools: [
          { toolId: "echo", digest: null, immutableReference: null },
          { toolId: "echo", digest: null, immutableReference: null },
        ],
      }),
    ).toThrow(/same tool/);
    expect(() =>
      contractGrant({ issuedAt: "2026-08-02T01:00:00.000Z", expiresAt: "2026-08-02T00:00:00.000Z" }),
    ).toThrow(/expire after/);
  });

  it("sorts multiple granted tools deterministically", () => {
    const grant = contractGrant({
      tools: [
        { toolId: "z-tool", digest: null, immutableReference: null },
        { toolId: "a-tool", digest: null, immutableReference: null },
      ],
    });
    expect(grant.tools.map((tool) => tool.toolId)).toEqual(["a-tool", "z-tool"]);
  });

  it("rejects a lease that would outlive its grant", () => {
    const time = createManualTime();
    const grant = contractGrant({}, time);
    expect(() =>
      createExecutionLease({
        leaseId: "lease-x",
        grant,
        clock: time,
        expiresAt: new Date(new Date(grant.expiresAt).valueOf() + 1_000).toISOString(),
      }),
    ).toThrow(/outlive/);
  });

  it("keeps a revoked lease revoked", () => {
    const time = createManualTime();
    const lease = createExecutionLease({ leaseId: "lease-y", grant: contractGrant({}, time), clock: time });
    lease.revoke();
    lease.release();
    expect(lease.record().state).toBe("revoked");
    expect(() => lease.assertValid()).toThrow(/revoked/);
  });

  it("reports a released lease distinctly from an expired one", () => {
    const time = createManualTime();
    const lease = createExecutionLease({ leaseId: "lease-z", grant: contractGrant({}, time), clock: time });
    lease.release();
    expect(() => lease.assertValid()).toThrow(/already released/);
    const unsubscribe = lease.onInvalidated(() => undefined);
    expect(unsubscribe()).toBeUndefined();
  });

  it("renews within the grant when renewal was allowed", () => {
    const time = createManualTime();
    const grant = contractGrant({}, time);
    const lease = createExecutionLease({
      leaseId: "lease-r",
      grant,
      clock: time,
      renewable: true,
      expiresAt: new Date(time.now().valueOf() + 1_000).toISOString(),
    });
    lease.renew(new Date(time.now().valueOf() + 5_000).toISOString());
    time.advance(2_000);
    expect(lease.isValid()).toBe(true);
    time.advance(10_000);
    expect(() => lease.renew(new Date(time.now().valueOf() + 1_000).toISOString())).toThrow();
  });
});

describe("platform backend probes", () => {
  it("reports the reason each platform backend is unusable here", async () => {
    const cases = [
      { backend: createWindowsSandboxBackend({ platform: "win32" }), expected: "not-implemented" },
      { backend: createWindowsSandboxBackend({ platform: "linux" }), expected: "unsupported-platform" },
      { backend: createLinuxSandboxBackend({ platform: "darwin" }), expected: "unsupported-platform" },
      { backend: createMacosSandboxBackend({ platform: "win32" }), expected: "unsupported-platform" },
    ];
    for (const { backend, expected } of cases) {
      const availability = await backend.probe();
      expect(availability.available).toBe(false);
      expect(availability.reason).toBe(expected);
      await backend.close();
    }
  });

  it("keeps the Windows lane unavailable at both probe and grant validation", async () => {
    const backend = createWindowsSandboxBackend({ platform: "win32" });
    const expectedDetail =
      "windows-native-process-composition-and-corpus-unverified";

    await expect(backend.probe()).resolves.toEqual({
      available: false,
      reason: "not-implemented",
      detail: expectedDetail,
    });
    expect(backend.validateGrant(contractGrant({}, systemClock))).toEqual({
      available: false,
      reason: "not-implemented",
      detail: expectedDetail,
    });
    expect(backend.describe()).toMatchObject({
      backendId: "windows-restricted-job-object",
      securityClass: "unavailable",
      capabilities: {
        filesystemIsolation: false,
        processTreeControl: false,
        networkBoundary: "unsupported",
        identityIsolation: false,
        profileIsolation: false,
      },
    });
    await backend.close();
  });

  it("probes the Linux and macOS primitives without installing anything", async () => {
    const linux = createLinuxSandboxBackend({ platform: "linux" });
    const linuxAvailability = await linux.probe();
    expect(linuxAvailability.available).toBe(false);
    expect(["missing-tooling", "missing-privilege", "not-implemented"]).toContain(
      linuxAvailability.reason,
    );
    await linux.close();

    const macos = createMacosSandboxBackend({ platform: "darwin" });
    const macosAvailability = await macos.probe();
    expect(macosAvailability.available).toBe(false);
    expect(["missing-tooling", "not-implemented"]).toContain(macosAvailability.reason);
    await macos.close();
  });

  it("refuses to prepare, spawn, or validate a grant", async () => {
    const backend = createPlatformSandboxBackend();
    expect(backend.validateGrant(contractGrant({}, systemClock)).available).toBe(false);
    await expect(
      backend.prepare({
        projectId: "p",
        workspaceId: "w",
        snapshotId: null,
        attemptId: "a",
        leaseId: "l",
        grant: contractGrant({}, systemClock),
        grantFingerprint: "a".repeat(64),
        policyDecisionFingerprint: "a".repeat(64),
        workspaceRoot: process.cwd(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        nonce: "0".repeat(32),
      }),
    ).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
    await expect(
      backend.spawn({} as unknown as Parameters<typeof backend.spawn>[0]),
    ).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
    await backend.dispose({
      sessionId: "s",
      backendId: "b",
      tempDir: "t",
      homeDir: null,
      productionReceipt: null,
    });
    await backend.close();
  });

  it("selects the seam for the running platform", () => {
    const backend = createPlatformSandboxBackend();
    expect(backend.describe().platform).toBe(process.platform);
    expect(backend.describe().securityClass).toBe("unavailable");
  });
});

describe("unsafe development backend", () => {
  it("refuses a grant whose network denial it cannot honour", async () => {
    const root = await scratchRoot();
    const backend = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "s") });
    const availability = backend.validateGrant(contractGrant({ network: DENY_ALL_NETWORK }, systemClock));
    expect(availability.available).toBe(false);
    expect(availability.detail).toBe("network-denial-unsupported");
    await backend.close();
  });

  it("accepts a grant that only asks for an egress allowlist", async () => {
    const root = await scratchRoot();
    const backend = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "s") });
    const grant = contractGrant(
      { network: { mode: "allowlist", egressDomains: ["example.com"] } },
      systemClock,
    );
    expect(backend.validateGrant(grant).available).toBe(true);
    await backend.close();
  });

  it("refuses to prepare after close and probes as unavailable", async () => {
    const root = await scratchRoot();
    const backend = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "s") });
    await backend.close();
    expect((await backend.probe()).available).toBe(false);
    await expect(
      backend.prepare({
        projectId: "p",
        workspaceId: "w",
        snapshotId: null,
        attemptId: "a",
        leaseId: "l",
        grant: contractGrant({}, systemClock),
        grantFingerprint: "a".repeat(64),
        policyDecisionFingerprint: "a".repeat(64),
        workspaceRoot: root,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        nonce: "0".repeat(32),
      }),
    ).rejects.toMatchObject({ code: "BROKER_CLOSED" });
  });

  it("creates a fresh scoped home and removes only its own session directory", async () => {
    const root = await scratchRoot();
    const sessionRoot = join(root, "sessions");
    const siblingRoot = join(root, "sessions-sibling");
    const siblingMarker = join(siblingRoot, "keep.txt");
    await mkdir(siblingRoot, { recursive: true });
    await writeFile(siblingMarker, "keep", "utf8");
    const backend = createUnsafeDevelopmentBackend({ sessionRoot });
    const binding = {
      projectId: "p",
      workspaceId: "w",
      snapshotId: null,
      attemptId: "attempt-1",
      leaseId: "l",
      grant: contractGrant({}, systemClock),
      grantFingerprint: "a".repeat(64),
      policyDecisionFingerprint: "a".repeat(64),
      workspaceRoot: root,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      nonce: "0".repeat(32),
    } as const;
    const session = await backend.prepare(binding);
    if (session.homeDir === null) {
      throw new Error("The unsafe development backend did not create its scoped home.");
    }
    const expectedSessionRoot = join(sessionRoot, session.sessionId);
    expect(session.sessionId).toContain("attempt-1");
    expect(session.tempDir).toBe(join(expectedSessionRoot, "tmp"));
    expect(session.homeDir).toBe(join(expectedSessionRoot, "home"));
    await access(session.tempDir);
    await access(session.homeDir);
    const staleMarker = join(session.homeDir, "stale-credential");
    await writeFile(staleMarker, "must be deleted", "utf8");

    await backend.dispose(session);
    await backend.dispose(session);
    await expect(access(expectedSessionRoot)).rejects.toThrow();
    expect(await readFile(siblingMarker, "utf8")).toBe("keep");

    const [recreated, concurrent] = await Promise.all([
      backend.prepare(binding),
      backend.prepare(binding),
    ]);
    if (recreated.homeDir === null || concurrent.homeDir === null) {
      throw new Error("The unsafe development backend did not recreate its scoped homes.");
    }
    expect(recreated.homeDir).not.toBe(session.homeDir);
    expect(concurrent.homeDir).not.toBe(session.homeDir);
    expect(concurrent.homeDir).not.toBe(recreated.homeDir);
    await expect(access(staleMarker)).rejects.toThrow();
    await backend.dispose(recreated);
    await access(concurrent.homeDir);
    await backend.dispose(concurrent);
    await backend.close();
  });

  it("closes a live process through the POSIX process-group fallback", async () => {
    const root = await scratchRoot();
    const backend = createUnsafeDevelopmentBackend({
      sessionRoot: join(root, "sessions"),
      platform: "linux",
    });
    const grant = contractGrant({}, systemClock);
    const session = await backend.prepare({
      projectId: grant.projectId,
      workspaceId: grant.workspaceId,
      snapshotId: grant.snapshotId,
      attemptId: grant.attemptId,
      leaseId: "lease-posix-fallback",
      grant,
      grantFingerprint: grantFingerprint(grant),
      policyDecisionFingerprint: grant.policyFingerprint,
      workspaceRoot: root,
      expiresAt: grant.expiresAt,
      nonce: "1".repeat(32),
    });
    const tool = createTrustedToolDescriptor({
      toolId: "node-posix-fallback",
      executablePath: process.execPath,
      platform: process.platform as "win32" | "darwin" | "linux",
      architecture: process.arch as "x64" | "arm64",
      trustSource: "operator-pinned",
    });
    const script = "setInterval(() => {}, 1000)";
    const child = await backend.spawn({
      session,
      request: contractRequest(tool, { args: ["-e", script] }),
      tool: {
        toolId: tool.toolId,
        executablePath: tool.executablePath,
        digest: tool.expectedDigest,
        immutableReference: tool.immutableReference,
      },
      argv: [process.execPath, "-e", script],
      environment: buildEnvironment({
        bindings: [],
        paths: { tempDir: session.tempDir, homeDir: session.homeDir, configDir: null, cacheDir: null },
        platform: process.platform,
        hostEnvironment: process.env,
      }),
      workingDirectory: root,
    });
    expect(child.pid).not.toBeNull();
    await backend.close();
    const exit = await child.wait();
    expect(exit.exitCode === null || exit.exitCode !== 0).toBe(true);
  });
});

describe("fingerprints", () => {
  it("ignores key insertion order", () => {
    expect(fingerprintOf({ a: 1, b: 2 })).toBe(fingerprintOf({ b: 2, a: 1 }));
    expect(fingerprintOf({ a: 1 })).not.toBe(fingerprintOf({ a: 2 }));
  });
});
