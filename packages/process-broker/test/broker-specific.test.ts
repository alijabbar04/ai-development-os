import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BoundedOutputCollector,
  BoundedDuplexEventQueue,
  DENY_ALL_NETWORK,
  FORBIDDEN_ENVIRONMENT_NAMES,
  MAX_STDIN_BYTES,
  ProcessBrokerError,
  UNSAFE_BACKEND_ID,
  UNSAFE_BACKEND_LIMITATIONS,
  backendDescriptorFingerprint,
  buildEnvironment,
  commandSubjectDigest,
  createExecutionLease,
  createEnforcementAttestation,
  createDuplexSessionLimits,
  createManualTime,
  createProcessBroker,
  createProcessQuotas,
  createTrustedToolDescriptor,
  createUnsafeDevelopmentBackend,
  createWindowsSandboxBackend,
  createLinuxSandboxBackend,
  createMacosSandboxBackend,
  decodeSafeText,
  evaluateAdmission,
  grantAllowsTool,
  grantFingerprint,
  noQuotaSupport,
  parseBackendDescriptor,
  parseCapabilityGrant,
  parseEnvironmentBindings,
  parseDuplexSessionLimits,
  parseNetworkPolicy,
  parseProcessQuotas,
  parseProcessRequest,
  parseTrustedToolDescriptor,
  prefixCovers,
  requiredQuotaDimensions,
  resolveTrustedTool,
  systemClock,
  type CapabilityGrant,
  type ExecuteInput,
  type ExecutionLease,
  type PolicyGateway,
  type ProcessAuditRecord,
  type ProcessRequest,
  type SandboxBackend,
} from "../src/index.js";
import { issueProductionBackendRegistration } from "../src/trusted-evidence.js";
import {
  SECURE_BACKEND_ESCAPE_CORPUS_FINGERPRINT,
  SECURE_BACKEND_ESCAPE_CORPUS_VERSION,
  secureBackendEscapeVectorCount,
} from "../src/escape-corpus.js";
import { contractGrant, contractRequest } from "../src/testing/contract-suite.js";
import { FIXTURE, allowAllPolicy, fixtureTool } from "./contract.test.js";

const roots: string[] = [];
async function scratchRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "adox-broker-spec-"));
  roots.push(root);
  return root;
}
afterAll(async () => {
  await Promise.allSettled(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function tool(): ReturnType<typeof fixtureTool> {
  return fixtureTool();
}

async function brokerHarness(options: {
  readonly mode?: "production" | "development";
  readonly policy?: PolicyGateway;
  readonly approvedBackendIds?: readonly string[];
  readonly observer?: (record: ProcessAuditRecord) => void;
  readonly secrets?: { resolve(request: ProcessRequest): Promise<ReadonlyMap<string, string>> };
}): Promise<{
  root: string;
  execute: (request: ProcessRequest, lease?: ExecutionLease) => Promise<unknown>;
  close: () => Promise<void>;
  context: (request: ProcessRequest, lease: ExecutionLease) => ExecuteInput;
}> {
  const root = await scratchRoot();
  const backend = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "sessions") });
  const broker = createProcessBroker({
    backend,
    mode: options.mode ?? "development",
    policy: options.policy ?? allowAllPolicy,
    clock: systemClock,
    terminationGraceMs: 200,
    ...(options.approvedBackendIds === undefined
      ? {}
      : { approvedBackendIds: options.approvedBackendIds }),
    ...(options.observer === undefined ? {} : { observer: options.observer }),
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
  });
  const context = (request: ProcessRequest, lease: ExecutionLease): ExecuteInput => ({
    request:
      request.workspaceLeaseId === lease.leaseId
        ? request
        : parseProcessRequest({ ...request, workspaceLeaseId: lease.leaseId }),
    grant: lease.grant,
    lease,
    workspaceRoot: root,
    workingDirectory: root,
    workspacePaths: { tempDir: join(root, "tmp"), homeDir: join(root, "home"), configDir: null, cacheDir: null },
  });
  return {
    root,
    context,
    execute: (request, lease) => {
      const effective =
        lease ??
        createExecutionLease({ leaseId: "lease-spec", grant: contractGrant({}, systemClock), clock: systemClock });
      return broker.execute(context(request, effective));
    },
    close: () => broker.close(),
  };
}

describe("process request validation", () => {
  it("has no representation for a shell command", () => {
    const request = contractRequest(tool(), { args: ["a"] });
    expect(Object.keys(request)).not.toContain("shell");
    expect(Object.keys(request)).not.toContain("command");
    expect(
      () =>
        parseProcessRequest({ ...request, shell: true } as unknown) as unknown,
    ).toThrow();
  });

  it("rejects a command string smuggled in as an argument bundle", () => {
    // A caller cannot get shell behaviour by asking for it politely.
    expect(() =>
      parseProcessRequest({ ...contractRequest(tool()), commandLine: "rm -rf /" } as unknown),
    ).toThrow();
  });

  it("bounds argument count, argument size, and total argument bytes", () => {
    const narrow = createTrustedToolDescriptor({
      toolId: "narrow",
      executablePath: process.execPath,
      platform: process.platform as "win32",
      architecture: process.arch as "x64",
      trustSource: "operator-pinned",
      argumentPolicy: { maxArguments: 3, maxArgumentBytes: 8, pinnedLeadingArguments: null, denyOptionArguments: true },
    });
    expect(() => contractRequest(narrow, { args: ["a", "b", "c", "d"] })).toThrow();
    expect(() => contractRequest(narrow, { args: ["x".repeat(64)] })).toThrow();
    expect(() => contractRequest(narrow, { args: ["--flag"] })).toThrow(/option arguments/);
  });

  it("bounds standard input", () => {
    expect(() =>
      contractRequest(tool(), {
        stdin: { kind: "bytes", bytes: new Uint8Array(MAX_STDIN_BYTES + 1) },
      }),
    ).toThrow();
  });

  it("rejects a working directory that escapes the workspace", () => {
    for (const candidate of ["../outside", "/etc/passwd", "C:/Windows", "a/../../b", ".git/config"]) {
      expect(() => contractRequest(tool(), { workingSubdirectory: candidate })).toThrow();
    }
  });

  it("normalizes deterministically regardless of key order", () => {
    const a = contractRequest(tool(), { args: ["x"], successExitCodes: [3, 1, 1] });
    expect(a.successExitCodes).toEqual([1, 3]);
    const b = parseProcessRequest(JSON.parse(JSON.stringify({ ...a, stdin: { kind: "none" } })));
    expect(b.successExitCodes).toEqual(a.successExitCodes);
  });

  it("is deeply immutable", () => {
    const request = contractRequest(tool(), { args: ["x"] });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.args)).toBe(true);
    expect(Object.isFrozen(request.quotas)).toBe(true);
  });

  it("rejects prototype-polluting input", () => {
    expect(() => parseProcessRequest(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow();
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("executable identity", () => {
  it("refuses a Windows command-script shim", async () => {
    const root = await scratchRoot();
    const shim = join(root, "npm.cmd");
    await writeFile(shim, "@echo off\n");
    const descriptor = parseTrustedToolDescriptor({
      toolId: "shim",
      executablePath: shim,
      expectedDigest: null,
      immutableReference: null,
      containmentRoot: null,
      platform: "win32",
      architecture: "x64",
      argumentPolicy: { maxArguments: 4, maxArgumentBytes: 64, pinnedLeadingArguments: null, denyOptionArguments: false },
      versionEvidence: null,
      trustSource: "operator-pinned",
      allowLinkIndirection: false,
    });
    await expect(resolveTrustedTool(descriptor, { platform: "win32" })).rejects.toMatchObject({
      code: "EXECUTABLE_UNSAFE",
    });
  });

  it("refuses a tool outside its containment root", async () => {
    const root = await scratchRoot();
    const descriptor = createTrustedToolDescriptor({
      toolId: "contained",
      executablePath: process.execPath,
      platform: process.platform as "win32",
      architecture: process.arch as "x64",
      trustSource: "operator-pinned",
      containmentRoot: join(root, "nowhere"),
    });
    await expect(resolveTrustedTool(descriptor)).rejects.toMatchObject({ code: "EXECUTABLE_UNSAFE" });
  });

  it("refuses a missing tool without leaking the path", async () => {
    const root = await scratchRoot();
    const descriptor = createTrustedToolDescriptor({
      toolId: "absent",
      executablePath: join(root, "does-not-exist"),
      platform: process.platform as "win32",
      architecture: process.arch as "x64",
      trustSource: "operator-pinned",
    });
    const error = await resolveTrustedTool(descriptor).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProcessBrokerError);
    expect(JSON.stringify((error as ProcessBrokerError).toJSON())).not.toContain(root);
  });

  it("refuses a descriptor built for another platform", async () => {
    const other = process.platform === "win32" ? "linux" : "win32";
    const descriptor = createTrustedToolDescriptor({
      toolId: "other",
      executablePath: process.execPath,
      platform: other,
      architecture: process.arch as "x64",
      trustSource: "operator-pinned",
    });
    await expect(resolveTrustedTool(descriptor)).rejects.toMatchObject({
      code: "EXECUTABLE_UNAVAILABLE",
    });
  });
});

describe("environment construction", () => {
  it("starts from nothing and adds only what was named", () => {
    const built = buildEnvironment({
      bindings: [{ kind: "literal", name: "EXPLICIT", value: "yes" }],
      paths: { tempDir: "/w/tmp", homeDir: "/w/home", configDir: null, cacheDir: null },
      platform: "linux",
      hostEnvironment: { SECRET_TOKEN: "leak", PATH: "/usr/bin", HOME: "/root" },
    });
    expect(built.variables["EXPLICIT"]).toBe("yes");
    expect(built.variables["SECRET_TOKEN"]).toBeUndefined();
    expect(built.variables["PATH"]).toBeUndefined();
    expect(built.variables["HOME"]).toBe("/w/home");
    expect(built.variables["TMPDIR"]).toBe("/w/tmp");
  });

  it("refuses request bindings for credential and configuration redirection", () => {
    for (const name of ["SSH_AUTH_SOCK", "GIT_CONFIG_GLOBAL", "AWS_SECRET_ACCESS_KEY", "NODE_OPTIONS", "LD_PRELOAD"]) {
      expect(() => parseEnvironmentBindings([{ kind: "literal", name, value: "x" }])).toThrow(
        ProcessBrokerError,
      );
    }
    expect(FORBIDDEN_ENVIRONMENT_NAMES.has("GIT_ASKPASS")).toBe(true);
  });

  it("refuses to start when a secret binding was not resolved", () => {
    expect(() =>
      buildEnvironment({
        bindings: [{ kind: "secret", name: "TOKEN", secretRefFingerprint: "a".repeat(64) }],
        paths: { tempDir: "/w/tmp", homeDir: null, configDir: null, cacheDir: null },
        platform: "linux",
        hostEnvironment: {},
      }),
    ).toThrow(/not resolved/);
  });

  it("reports secret values for redaction without exposing them in names", () => {
    const built = buildEnvironment({
      bindings: [{ kind: "secret", name: "TOKEN", secretRefFingerprint: "a".repeat(64) }],
      paths: { tempDir: "/w/tmp", homeDir: null, configDir: null, cacheDir: null },
      platform: "linux",
      hostEnvironment: {},
      secretValues: new Map([["TOKEN", "s3cret-value"]]),
    });
    expect(built.secretValues).toEqual(["s3cret-value"]);
    expect(built.names).toContain("TOKEN");
  });
});

describe("bounded output", () => {
  it("redacts a secret that straddles a chunk boundary", () => {
    const collector = new BoundedOutputCollector(
      { maxStreamBytes: 4_096, maxCombinedBytes: 8_192, maxLineBytes: 512 },
      ["super-secret"],
    );
    collector.push("stdout", new TextEncoder().encode("prefix super-se"));
    collector.push("stdout", new TextEncoder().encode("cret suffix"));
    const text = Buffer.from(collector.finish().stdout.bytes).toString("utf8");
    expect(text).toBe("prefix [REDACTED SECRET] suffix");
  });

  it("stops accepting output at the cap and classifies the truncation", () => {
    const collector = new BoundedOutputCollector({
      maxStreamBytes: 8,
      maxCombinedBytes: 16,
      maxLineBytes: 8,
    });
    expect(collector.push("stdout", new Uint8Array(4))).toBe(true);
    expect(collector.push("stdout", new Uint8Array(32))).toBe(false);
    const capture = collector.finish();
    expect(capture.stdout.byteLength).toBe(8);
    expect(capture.stdout.truncation).toBe("stream-limit");
    expect(collector.overflow?.stream).toBe("stdout");
  });

  it("keeps binary output intact and digests it", () => {
    const collector = new BoundedOutputCollector({
      maxStreamBytes: 64,
      maxCombinedBytes: 128,
      maxLineBytes: 64,
    });
    collector.push("stdout", new Uint8Array([0, 1, 2, 255, 254]));
    const capture = collector.finish();
    expect([...capture.stdout.bytes]).toEqual([0, 1, 2, 255, 254]);
    expect(capture.stdout.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("strips terminal control sequences from decoded text", () => {
    const collector = new BoundedOutputCollector({
      maxStreamBytes: 256,
      maxCombinedBytes: 512,
      maxLineBytes: 256,
    });
    collector.push("stdout", new TextEncoder().encode("\u001b[31mred\u001b[0m\u0007plain\u001b]0;t\u0007"));
    // The window-title payload must be removed with its introducer, not
    // left behind as text a consumer would print.
    expect(decodeSafeText(collector.finish().stdout)).toBe("redplain");
  });
});

describe("bounded duplex queues", () => {
  it("validates a complete, immutable limit object and rejects malformed variants", () => {
    const limits = createDuplexSessionLimits({ maxEventBytes: 32, maxQueuedEventBytes: 64 });
    expect(Object.isFrozen(limits)).toBe(true);
    expect(limits.maxEventBytes).toBe(32);
    expect(() => parseDuplexSessionLimits({ ...limits, extra: 1 })).toThrow();
    expect(() => parseDuplexSessionLimits({ ...limits, maxMessageBytes: 0 })).toThrow();
    expect(() =>
      parseDuplexSessionLimits({ ...limits, maxQueuedWriteBytes: limits.maxMessageBytes - 1 }),
    ).toThrow();
    expect(() =>
      parseDuplexSessionLimits({ ...limits, maxTotalWriteBytes: limits.maxMessageBytes - 1 }),
    ).toThrow();
    expect(() =>
      parseDuplexSessionLimits({ ...limits, maxQueuedEventBytes: limits.maxEventBytes - 1 }),
    ).toThrow();
    expect(() => parseDuplexSessionLimits(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow();
    expect(() =>
      parseDuplexSessionLimits(
        Object.assign(Object.create({ polluted: true }), limits) as unknown,
      ),
    ).toThrow();
  });

  it("reports queue occupancy and lets a consumer stop without retaining more output", async () => {
    const limits = createDuplexSessionLimits({
      maxEventBytes: 2,
      maxQueuedEvents: 4,
      maxQueuedEventBytes: 8,
    });
    const queue = new BoundedDuplexEventQueue(limits);
    expect(queue.push("stdout", new Uint8Array([1, 2, 3, 4]))).toBe(true);
    expect(queue.queuedEvents).toBe(2);
    expect(queue.queuedBytes).toBe(4);
    const iterator = queue[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.sequence).toBe(1);
    expect(queue.queuedEvents).toBe(1);
    await iterator.return?.();
    expect(queue.queuedBytes).toBe(0);
    expect(queue.push("stderr", new Uint8Array(8))).toBe(true);
    queue.finish();
    queue.finish();
  });

  it("completes a pending event read when the producer finishes", async () => {
    const queue = new BoundedDuplexEventQueue(createDuplexSessionLimits());
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();
    queue.finish();
    expect(await pending).toEqual({ done: true, value: undefined });
  });
});

describe("grants and leases", () => {
  it("rejects a traversing path prefix", () => {
    expect(() => contractGrant({ readablePrefixes: ["../escape"] })).toThrow();
    expect(() => contractGrant({ writablePrefixes: ["a/../../b"] })).toThrow();
  });

  it("covers only paths inside a granted prefix", () => {
    expect(prefixCovers(["src"], "src/main.ts")).toBe(true);
    expect(prefixCovers(["src"], "srcx/main.ts")).toBe(false);
    expect(prefixCovers([""], "anything")).toBe(true);
    expect(prefixCovers(["src"], "other")).toBe(false);
  });

  it("binds a tool digest when the grant pins one", () => {
    const grant = contractGrant({
      tools: [{ toolId: "echo", digest: "c".repeat(64), immutableReference: null }],
    });
    expect(grantAllowsTool(grant, "echo", "c".repeat(64))).toBe(true);
    expect(grantAllowsTool(grant, "echo", "d".repeat(64))).toBe(false);
    expect(grantAllowsTool(grant, "other", null)).toBe(false);
  });

  it("expires on a manual clock and cancels dependent work exactly once", () => {
    const time = createManualTime();
    const grant = contractGrant({}, time);
    const lease = createExecutionLease({ leaseId: "lease-1", grant, clock: time, expiresAt: new Date(time.now().valueOf() + 1_000).toISOString() });
    let cancellations = 0;
    lease.onInvalidated(() => (cancellations += 1));
    expect(lease.isValid()).toBe(true);
    time.advance(2_000);
    expect(lease.isValid()).toBe(false);
    expect(() => lease.assertValid()).toThrow(/expired/);
    expect(() => lease.assertValid()).toThrow(/expired/);
    expect(cancellations).toBe(1);
    expect(lease.record().state).toBe("expired");
  });

  it("releases idempotently and refuses renewal unless allowed", () => {
    const time = createManualTime();
    const lease = createExecutionLease({ leaseId: "lease-2", grant: contractGrant({}, time), clock: time });
    lease.release();
    lease.release();
    expect(lease.record().state).toBe("released");
    expect(() => lease.renew(new Date(time.now().valueOf() + 1_000).toISOString())).toThrow(
      /not renewable/,
    );
  });

  it("cannot be renewed beyond its grant", () => {
    const time = createManualTime();
    const grant = contractGrant({}, time);
    const lease = createExecutionLease({ leaseId: "lease-3", grant, clock: time, renewable: true });
    expect(() => lease.renew(new Date(new Date(grant.expiresAt).valueOf() + 1_000).toISOString())).toThrow();
  });

  it("notifies a listener registered after invalidation", () => {
    const time = createManualTime();
    const lease = createExecutionLease({ leaseId: "lease-4", grant: contractGrant({}, time), clock: time });
    lease.revoke();
    let called = 0;
    lease.onInvalidated(() => (called += 1));
    expect(called).toBe(1);
  });
});

describe("quotas", () => {
  it("demands only the dimensions a request actually constrains", () => {
    const minimal = parseProcessQuotas({
      wallClockMs: 1_000,
      cpuTimeMs: null,
      memoryBytes: null,
      processCount: null,
      outputBytes: 1_024,
      diskBytes: null,
      fileCount: null,
    });
    expect(requiredQuotaDimensions(minimal, DENY_ALL_NETWORK)).toEqual([
      "network",
      "output-bytes",
      "wall-clock",
    ]);
    const full = createProcessQuotas({
      wallClockMs: 1_000,
      outputBytes: 1_024,
      cpuTimeMs: 500,
      memoryBytes: 1_024,
      processCount: 2,
      diskBytes: 1_024,
      fileCount: 4,
    });
    expect(requiredQuotaDimensions(full, DENY_ALL_NETWORK)).toContain("cpu-time");
    expect(requiredQuotaDimensions(full, DENY_ALL_NETWORK)).toContain("memory");
  });

  it("rejects an allowlist with no domains and domains without an allowlist", () => {
    expect(() => parseNetworkPolicy({ mode: "allowlist", egressDomains: [] })).toThrow();
    expect(() => parseNetworkPolicy({ mode: "denied", egressDomains: ["example.com"] })).toThrow();
    expect(() => parseNetworkPolicy({ mode: "allowlist", egressDomains: ["Example.COM"] })).toThrow();
  });
});

describe("backend descriptors", () => {
  it("refuses a descriptor that claims enforcement it does not have", () => {
    expect(() =>
      parseBackendDescriptor({
        schemaVersion: 2,
        backendId: "liar",
        kind: "same-user-subprocess",
        platform: "linux",
        securityClass: "secure-enforcing",
        capabilities: {
          filesystemIsolation: false,
          processTreeControl: false,
          networkBoundary: "unsupported",
          identityIsolation: false,
          profileIsolation: false,
          quotas: noQuotaSupport(),
        },
        versionEvidence: null,
      }),
    ).toThrow(/secure-enforcing/);
  });

  it("names the unsafe backend so its risk cannot be mistaken", () => {
    expect(UNSAFE_BACKEND_ID).toBe("unsafe-development-current-user");
    expect(UNSAFE_BACKEND_ID).not.toBe("local");
    expect(UNSAFE_BACKEND_ID).not.toBe("default");
    expect(UNSAFE_BACKEND_ID).not.toBe("native");
    expect(UNSAFE_BACKEND_LIMITATIONS.length).toBeGreaterThan(5);
  });

  it("classifies the unsafe backend as unsafe with no enforced quota", async () => {
    const root = await scratchRoot();
    const backend = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "s") });
    const descriptor = backend.describe();
    expect(descriptor.securityClass).toBe("unsafe-development");
    expect(descriptor.capabilities.filesystemIsolation).toBe(false);
    expect(Object.values(descriptor.capabilities.quotas)).not.toContain("enforced");
    await backend.close();
  });

  it("reports each platform backend as unavailable rather than pretending", async () => {
    for (const backend of [
      createWindowsSandboxBackend({ platform: "win32" }),
      createLinuxSandboxBackend({ platform: "linux" }),
      createMacosSandboxBackend({ platform: "darwin" }),
    ]) {
      expect(backend.describe().securityClass).toBe("unavailable");
      expect(backend.describe().capabilities.filesystemIsolation).toBe(false);
      await backend.close();
    }
  });
});

describe("production gate", () => {
  const baseline = (overrides: Record<string, unknown> = {}): Parameters<typeof evaluateAdmission>[0] => {
    const grant = contractGrant({}, systemClock);
    const request = contractRequest(tool(), { args: ["ok"] });
    const descriptor = parseBackendDescriptor({
      schemaVersion: 2,
      backendId: "secure-test",
      kind: "container",
      platform: process.platform,
      securityClass: "secure-enforcing",
      capabilities: {
        filesystemIsolation: true,
        processTreeControl: true,
        networkBoundary: "deny-all",
        identityIsolation: true,
        profileIsolation: true,
        quotas: noQuotaSupport({
          "wall-clock": "enforced",
          "output-bytes": "enforced",
          network: "enforced",
        }),
      },
      versionEvidence: "1.0.0",
    });
    const backend: SandboxBackend = {
      describe: () => descriptor,
      probe: async () => ({ available: true, reason: "available", detail: null }),
      validateGrant: () => ({ available: true, reason: "available", detail: null }),
      prepare: async () => {
        throw new Error("not used");
      },
      spawn: async () => {
        throw new Error("not used");
      },
      dispose: async () => undefined,
      close: async () => undefined,
    };
    const now = systemClock.now().valueOf();
    const attestation = createEnforcementAttestation({
      schemaVersion: 1,
      algorithmVersion: 1,
      backendId: descriptor.backendId,
      backendFactoryId: "test-secure-v1",
      enforcementProfile: "test-complete-v1",
      descriptorFingerprint: backendDescriptorFingerprint(descriptor),
      platform: {
        os: process.platform as "win32" | "linux" | "darwin",
        version: "test-1",
        kernel: "test-1",
        architecture: process.arch as "x64" | "arm64",
        distribution: null,
      },
      helper: {
        protocolVersion: 1,
        sourceDigest: "1".repeat(64),
        binaryDigest: "2".repeat(64),
        buildDigest: "3".repeat(64),
      },
      boundaries: {
        filesystem: "enforced",
        "process-tree": "enforced",
        identity: "enforced",
        profile: "enforced",
        "network-denial": "enforced",
        "controlled-egress": "unverified",
        credentials: "enforced",
        ipc: "enforced",
        cleanup: "enforced",
      },
      quotas: descriptor.capabilities.quotas,
      endpointPolicyFingerprint: null,
      escapeCorpus: {
        version: SECURE_BACKEND_ESCAPE_CORPUS_VERSION,
        fingerprint: SECURE_BACKEND_ESCAPE_CORPUS_FINGERPRINT,
        result: "passed",
        positiveControlsPassed: true,
        testCount: secureBackendEscapeVectorCount(
          process.platform as "win32" | "linux" | "darwin",
        ),
      },
      observedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      limitations: [],
    });
    const registration = issueProductionBackendRegistration({
      backend,
      descriptor,
      attestation,
      purpose: "production",
    });
    return {
      mode: "production",
      backend,
      descriptor,
      availability: { available: true, reason: "available", detail: null },
      grantValidation: { available: true, reason: "available", detail: null },
      approvedBackendIds: ["secure-test"],
      productionRegistration: registration,
      controlPlaneEndpointPolicy: null,
      grant,
      grantFingerprint: grantFingerprint(grant),
      request,
      lease: {
        leaseId: request.workspaceLeaseId,
        grantId: grant.grantId,
        grantFingerprint: grantFingerprint(grant),
        workspaceId: grant.workspaceId,
        attemptId: grant.attemptId,
        state: "active",
        expiresAt: grant.expiresAt,
        version: 1,
      },
      clock: systemClock,
      policyOutcome: "allowed",
      policyFingerprint: request.policyDecisionFingerprint,
      policyApprovalEvidenceRefs: [],
      resolvedExecutableDigest: "a".repeat(64),
      resolvedImmutableReference: null,
      workspacePathTrusted: true,
      ...overrides,
    } as Parameters<typeof evaluateAdmission>[0];
  };

  it("admits an approved secure backend that enforces the requested dimensions", () => {
    expect(evaluateAdmission(baseline()).admitted).toBe(true);
  });

  it("refuses the unsafe backend in production", async () => {
    const root = await scratchRoot();
    const backend = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "s") });
    const decision = evaluateAdmission(baseline({ descriptor: backend.describe() }));
    expect(decision.admitted).toBe(false);
    expect(decision.reasons).toContain("backend-not-secure");
    expect(decision.reasons).toContain("backend-not-approved");
    await backend.close();
  });

  it("refuses a backend that is secure but not on the approved list", () => {
    expect(evaluateAdmission(baseline({ approvedBackendIds: [] })).reasons).toContain(
      "backend-not-approved",
    );
  });

  it("refuses when a requested quota is only observed", () => {
    const descriptor = parseBackendDescriptor({
      ...baseline().descriptor,
      capabilities: {
        ...baseline().descriptor.capabilities,
        quotas: noQuotaSupport({
          "wall-clock": "observed",
          "output-bytes": "enforced",
          network: "enforced",
        }),
      },
    });
    expect(evaluateAdmission(baseline({ descriptor })).reasons).toContain("quota-not-enforced");
  });

  it("refuses a denied, conditional, or missing policy decision", () => {
    expect(evaluateAdmission(baseline({ policyOutcome: "denied" })).reasons).toContain(
      "policy-decision-denied",
    );
    expect(evaluateAdmission(baseline({ policyOutcome: "conditional" })).reasons).toContain(
      "policy-approval-outstanding",
    );
    expect(evaluateAdmission(baseline({ policyOutcome: null })).reasons).toContain(
      "policy-decision-missing",
    );
  });

  it("refuses a mismatched policy fingerprint, lease, or workspace path", () => {
    expect(evaluateAdmission(baseline({ policyFingerprint: "f".repeat(64) })).reasons).toContain(
      "policy-fingerprint-mismatch",
    );
    const base = baseline();
    expect(
      evaluateAdmission({
        ...base,
        lease: { ...base.lease, state: "revoked" },
      }).reasons,
    ).toContain("workspace-lease-invalid");
    expect(evaluateAdmission(baseline({ workspacePathTrusted: false })).reasons).toContain(
      "workspace-path-untrusted",
    );
  });

  it("refuses an expired grant", () => {
    const past = createManualTime("2020-01-01T00:00:00.000Z");
    const grant = contractGrant({}, past);
    expect(evaluateAdmission(baseline({ grant })).reasons).toContain("grant-expired");
  });

  it("refuses network denial the backend cannot provide", () => {
    const descriptor = parseBackendDescriptor({
      ...baseline().descriptor,
      capabilities: { ...baseline().descriptor.capabilities, networkBoundary: "unsupported" },
    });
    expect(evaluateAdmission(baseline({ descriptor })).reasons).toContain(
      "network-denial-unavailable",
    );
  });

  it("still binds authority in development mode", () => {
    const decision = evaluateAdmission(baseline({ mode: "development", policyOutcome: "denied" }));
    expect(decision.admitted).toBe(false);
    expect(decision.reasons).toContain("policy-decision-denied");
  });
});

describe("broker behaviour", () => {
  it("does not lose duplex cancellation while the backend is starting", async () => {
    const root = await scratchRoot();
    const controller = new AbortController();
    const inner = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "cancellation-race") });
    const backend = {
      ...inner,
      spawn: async (input: Parameters<typeof inner.spawn>[0]) => {
        const child = await inner.spawn(input);
        controller.abort();
        return child;
      },
    };
    const broker = createProcessBroker({ backend, mode: "development", policy: allowAllPolicy, clock: systemClock });
    const grant = contractGrant({}, systemClock);
    const lease = createExecutionLease({ leaseId: "duplex-cancellation-race", grant, clock: systemClock });
    const request = contractRequest(tool(), {
      args: ["--sleep-forever"],
      workspaceLeaseId: lease.leaseId,
    });
    const session = await broker.openDuplexSession({
      request,
      grant,
      lease,
      workspaceRoot: root,
      workingDirectory: root,
      workspacePaths: { tempDir: join(root, "tmp"), homeDir: join(root, "home"), configDir: null, cacheDir: null },
      signal: controller.signal,
    });
    await expect(session.result).resolves.toMatchObject({ state: "cancelled", failure: { code: "CANCELLED" } });
    await broker.close();
  });

  it("refuses a duplex session in production before an armed child can spawn", async () => {
    const root = await scratchRoot();
    const marker = join(root, "armed-child-marker");
    const backend = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "sessions") });
    const production = createProcessBroker({
      backend,
      mode: "production",
      policy: allowAllPolicy,
      clock: systemClock,
    });
    const grant = contractGrant({}, systemClock);
    const lease = createExecutionLease({ leaseId: "duplex-production", grant, clock: systemClock });
    const request = contractRequest(tool(), {
      args: ["--armed-marker", marker],
      workspaceLeaseId: lease.leaseId,
    });
    const input: ExecuteInput = {
      request,
      grant,
      lease,
      workspaceRoot: root,
      workingDirectory: root,
      workspacePaths: {
        tempDir: join(root, "tmp"),
        homeDir: join(root, "home"),
        configDir: null,
        cacheDir: null,
      },
    };
    await expect(production.openDuplexSession(input)).rejects.toMatchObject({
      code: "PRODUCTION_ISOLATION_REQUIRED",
    });
    await expect(access(marker)).rejects.toBeDefined();
    await production.close();

    const developmentBackend = createUnsafeDevelopmentBackend({
      sessionRoot: join(root, "development-sessions"),
    });
    const development = createProcessBroker({
      backend: developmentBackend,
      mode: "development",
      policy: allowAllPolicy,
      clock: systemClock,
    });
    const positive = await development.openDuplexSession(input);
    expect((await positive.result).state).toBe("succeeded");
    await expect(access(marker)).resolves.toBeUndefined();
    await development.close();
  });

  it("refuses in production before any process starts", async () => {
    const harness = await brokerHarness({ mode: "production" });
    const before = Date.now();
    const error = await harness
      .execute(contractRequest(tool(), { args: ["--flood"] }))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProcessBrokerError);
    expect((error as ProcessBrokerError).code).toBe("PRODUCTION_ISOLATION_REQUIRED");
    // A refusal is a decision, not an execution: it returns promptly and the
    // workload never ran.
    expect(Date.now() - before).toBeLessThan(3_000);
    await harness.close();
  });

  it("does not spawn when policy denies", async () => {
    let spawned = 0;
    const root = await scratchRoot();
    const inner = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "s") });
    const counting = { ...inner, spawn: async (input: Parameters<typeof inner.spawn>[0]) => { spawned += 1; return inner.spawn(input); } };
    const broker = createProcessBroker({
      backend: counting,
      mode: "development",
      policy: {
        evaluateCommand: ({ request }) => ({
          outcome: "denied" as const,
          fingerprint: request.policyDecisionFingerprint,
          approvalsToConsume: [],
        }),
      },
      clock: systemClock,
    });
    const lease = createExecutionLease({ leaseId: "l", grant: contractGrant({}, systemClock), clock: systemClock });
    await expect(
      broker.execute({
        request: contractRequest(tool(), { args: ["ok"], workspaceLeaseId: lease.leaseId }),
        grant: lease.grant,
        lease,
        workspaceRoot: root,
        workingDirectory: root,
        workspacePaths: { tempDir: join(root, "tmp"), homeDir: null, configDir: null, cacheDir: null },
      }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(spawned).toBe(0);
    await broker.close();
  });

  it("requires approval before spawning when policy is conditional", async () => {
    const harness = await brokerHarness({
      policy: {
        evaluateCommand: ({ request }) => ({
          outcome: "conditional" as const,
          fingerprint: request.policyDecisionFingerprint,
          approvalsToConsume: [],
        }),
      },
    });
    await expect(harness.execute(contractRequest(tool(), { args: ["ok"] }))).rejects.toMatchObject({
      code: "APPROVAL_REQUIRED",
    });
    await harness.close();
  });

  it("emits audit records that carry no output or environment values", async () => {
    const records: ProcessAuditRecord[] = [];
    const harness = await brokerHarness({ observer: (record) => records.push(record) });
    await harness.execute(
      contractRequest(tool(), {
        args: ["--print-env-value", "CANARY"],
        environment: [{ kind: "literal", name: "CANARY", value: "canary-secret" }],
      }),
    );
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("canary-secret");
    expect(records.map((record) => record.event)).toContain("process-terminal");
    expect(records.every((record) => record.schemaVersion === 1)).toBe(true);
    await harness.close();
  });

  it("survives an observer that throws", async () => {
    const harness = await brokerHarness({
      observer: () => {
        throw new Error("observer failure");
      },
    });
    await expect(harness.execute(contractRequest(tool(), { args: ["ok"] }))).resolves.toBeDefined();
    await harness.close();
  });

  it("redacts an injected secret from captured output", async () => {
    const harness = await brokerHarness({
      secrets: {
        resolve: async () => new Map([["INJECTED", "top-secret-token"]]),
      },
    });
    const result = (await harness.execute(
      contractRequest(tool(), {
        args: ["--print-env-value", "INJECTED"],
        environment: [{ kind: "secret", name: "INJECTED", secretRefFingerprint: "a".repeat(64) }],
      }),
    )) as { output: { stdout: { bytes: Uint8Array } } };
    const text = Buffer.from(result.output.stdout.bytes).toString("utf8");
    expect(text).not.toContain("top-secret-token");
    expect(text).toContain("[REDACTED SECRET]");
    await harness.close();
  });

  it("treats a non-zero exit as failure, not as an error", async () => {
    const harness = await brokerHarness({});
    const result = (await harness.execute(
      contractRequest(tool(), { args: ["--exit-code", "3"] }),
    )) as { succeeded: boolean; exitCode: number; state: string };
    expect(result.succeeded).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.state).toBe("failed");
    await harness.close();
  });

  it("honours a configured success exit code", async () => {
    const harness = await brokerHarness({});
    const result = (await harness.execute(
      contractRequest(tool(), { args: ["--exit-code", "3"], successExitCodes: [3] }),
    )) as { succeeded: boolean };
    expect(result.succeeded).toBe(true);
    await harness.close();
  });
});

describe("normalized command subject", () => {
  const base = {
    toolId: "echo",
    executableDigest: "a".repeat(64),
    immutableReference: null,
    arguments: ["build", "--fast"],
    workingDirectory: "src",
    workspaceId: "workspace-1",
    snapshotId: "snapshot-1",
    networkMode: "denied",
    egressDomains: [] as readonly string[],
    controlPlaneEndpointPolicyFingerprint: null,
    quotas: { wallClockMs: 1_000, outputBytes: 1_024 },
    environmentNames: ["A", "B"],
    environmentBindingsFingerprint: "d".repeat(64),
    stdinDigest: null,
  };

  it("is stable under key and collection ordering", () => {
    expect(commandSubjectDigest({ ...base, environmentNames: ["B", "A"] })).toBe(
      commandSubjectDigest(base),
    );
  });

  it("changes when anything that matters changes", () => {
    const digests = new Set([
      commandSubjectDigest(base),
      commandSubjectDigest({ ...base, arguments: ["build", "--slow"] }),
      commandSubjectDigest({ ...base, arguments: ["build"] }),
      commandSubjectDigest({ ...base, workingDirectory: "other" }),
      commandSubjectDigest({ ...base, workspaceId: "workspace-2" }),
      commandSubjectDigest({ ...base, networkMode: "allowlist" }),
      commandSubjectDigest({ ...base, executableDigest: "b".repeat(64) }),
      commandSubjectDigest({ ...base, quotas: { wallClockMs: 2_000, outputBytes: 1_024 } }),
      commandSubjectDigest({ ...base, stdinDigest: "c".repeat(64) }),
    ]);
    expect(digests.size).toBe(9);
  });
});

describe("fixture reachability", () => {
  it("uses the interpreter plus a pinned entry point rather than a shim", () => {
    const descriptor = fixtureTool();
    expect(descriptor.executablePath).toBe(process.execPath);
    expect(descriptor.argumentPolicy.pinnedLeadingArguments).toEqual([FIXTURE]);
  });
});
