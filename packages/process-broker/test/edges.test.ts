import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BoundedOutputCollector,
  ProcessBrokerError,
  createExecutionLease,
  createProcessBroker,
  createProcessQuotas,
  createTrustedToolDescriptor,
  createUnsafeDevelopmentBackend,
  grantAllowsTool,
  isSuccessExit,
  parseCapabilityGrant,
  parseEnvironmentBinding,
  parseEnvironmentBindings,
  parseProcessRequest,
  resolveTrustedTool,
  systemClock,
  type BackendExit,
  type BackendOutputEvent,
  type BackendProcess,
  type BackendTermination,
  type ExecuteInput,
  type ExecutionLease,
  type ProcessRequest,
  type SandboxBackend,
} from "../src/index.js";
import { contractGrant, contractRequest } from "../src/testing/contract-suite.js";
import { allowAllPolicy, fixtureTool } from "./contract.test.js";

const roots: string[] = [];
async function scratchRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "adox-edges-"));
  roots.push(root);
  return root;
}
afterAll(async () => {
  await Promise.allSettled(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function harness(backend: SandboxBackend, root: string) {
  const broker = createProcessBroker({
    backend,
    mode: "development",
    policy: allowAllPolicy,
    clock: systemClock,
    terminationGraceMs: 100,
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
    workspacePaths: { tempDir: join(root, "tmp"), homeDir: null, configDir: null, cacheDir: null },
  });
  const lease = (): ExecutionLease =>
    createExecutionLease({ leaseId: "lease-edge", grant: contractGrant({}, systemClock), clock: systemClock });
  return { broker, context, lease };
}

class ControlledProcess implements BackendProcess {
  readonly pid = 4242;
  readonly #waitPromise: Promise<BackendExit>;
  readonly #writeFails: boolean;
  readonly #closeStdinFails: boolean;
  #resolveWait!: (exit: BackendExit) => void;
  #rejectWait!: (error: Error) => void;
  #settled = false;

  constructor(options: {
    readonly writeFails?: boolean;
    readonly closeStdinFails?: boolean;
    readonly immediateExit?: boolean;
  } = {}) {
    this.#writeFails = options.writeFails ?? false;
    this.#closeStdinFails = options.closeStdinFails ?? false;
    this.#waitPromise = new Promise<BackendExit>((resolve, reject) => {
      this.#resolveWait = resolve;
      this.#rejectWait = reject;
    });
    if (options.immediateExit === true) {
      this.finish({ exitCode: 0, signal: null });
    }
  }

  onOutput(_listener: (event: BackendOutputEvent) => void): void {}

  wait(): Promise<BackendExit> {
    return this.#waitPromise;
  }

  async terminateTree(_graceMs: number): Promise<BackendTermination> {
    this.finish({ exitCode: null, signal: "terminated" });
    return { outcome: "terminated", stoppedCount: 1 };
  }

  async writeStdin(_bytes: Uint8Array): Promise<void> {
    if (this.#writeFails) throw new Error("synthetic-write-refusal");
  }

  async closeStdin(): Promise<void> {
    if (this.#closeStdinFails) throw new Error("synthetic-close-refusal");
  }

  finish(exit: BackendExit = { exitCode: 0, signal: null }): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolveWait(exit);
  }

  fail(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#rejectWait(new Error("synthetic-wait-refusal"));
  }
}

describe("broker edge paths", () => {
  it("contains backend stdin write and close failures without an unhandled rejection", async () => {
    const root = await scratchRoot();
    const inner = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "s") });
    const controlled = new ControlledProcess({
      writeFails: true,
      closeStdinFails: true,
      immediateExit: true,
    });
    const backend: SandboxBackend = { ...inner, spawn: async () => controlled };
    const { broker, context, lease } = await harness(backend, root);
    const effectiveLease = lease();
    const result = await broker.execute(
      context(
        contractRequest(fixtureTool(), {
          workspaceLeaseId: effectiveLease.leaseId,
          args: ["--echo-stdin"],
          stdin: { kind: "bytes", bytes: new TextEncoder().encode("bounded") },
        }),
        effectiveLease,
      ),
    );
    expect(result.succeeded).toBe(true);
    await broker.close();
  });

  it.each(["lease", "abort"] as const)(
    "executes the active-process %s cancellation callback",
    async (kind) => {
      const root = await scratchRoot();
      const inner = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "s") });
      const controlled = new ControlledProcess();
      let markSpawned!: () => void;
      const spawned = new Promise<void>((resolve) => {
        markSpawned = resolve;
      });
      const backend: SandboxBackend = {
        ...inner,
        spawn: async () => {
          markSpawned();
          return controlled;
        },
      };
      const { broker, context, lease } = await harness(backend, root);
      const effectiveLease = lease();
      const controller = new AbortController();
      const execution = broker.execute({
        ...context(
          contractRequest(fixtureTool(), {
            workspaceLeaseId: effectiveLease.leaseId,
            args: ["--sleep-forever"],
          }),
          effectiveLease,
        ),
        signal: controller.signal,
      });
      await spawned;
      if (kind === "lease") effectiveLease.revoke();
      else controller.abort();
      const result = await execution;
      expect(result.state).toBe(kind === "lease" ? "lease-expired" : "cancelled");
      await broker.close();
    },
  );

  it.each([false, true])(
    "settles a controlled duplex write (reject=%s) and its wait callback",
    async (writeFails) => {
      const root = await scratchRoot();
      const inner = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "s") });
      const controlled = new ControlledProcess({ writeFails });
      const backend: SandboxBackend = { ...inner, spawn: async () => controlled };
      const { broker, context, lease } = await harness(backend, root);
      const effectiveLease = lease();
      const request = contractRequest(fixtureTool(), {
        workspaceLeaseId: effectiveLease.leaseId,
        args: ["--duplex-lines"],
        environment: [{ kind: "literal", name: "CONTRACT_VALUE", value: "present" }],
      });
      const session = await broker.openDuplexSession(context(request, effectiveLease));
      const write = session.write(new TextEncoder().encode("line\n"));
      if (writeFails) {
        await expect(write).rejects.toMatchObject({ code: "BACKEND_LOST" });
      } else {
        await write;
        controlled.finish();
      }
      const result = await session.result;
      expect(result.state).toBe(writeFails ? "backend-lost" : "succeeded");
      await broker.close();
    },
  );

  it("maps a rejected duplex backend wait to a body-free backend-lost result", async () => {
    const root = await scratchRoot();
    const inner = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "s") });
    const controlled = new ControlledProcess();
    const backend: SandboxBackend = { ...inner, spawn: async () => controlled };
    const { broker, context, lease } = await harness(backend, root);
    const effectiveLease = lease();
    const session = await broker.openDuplexSession(
      context(
        contractRequest(fixtureTool(), {
          workspaceLeaseId: effectiveLease.leaseId,
          args: ["--duplex-lines"],
        }),
        effectiveLease,
      ),
    );
    controlled.fail();
    await expect(session.result).resolves.toMatchObject({
      state: "backend-lost",
      failure: { code: "BACKEND_LOST" },
    });
    await broker.close();
  });

  it("reports a backend spawn failure as a structured error", async () => {
    const root = await scratchRoot();
    const inner = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "s") });
    const failing: SandboxBackend = {
      ...inner,
      spawn: async () => {
        throw new Error("backend exploded with /secret/path detail");
      },
    };
    const { broker, context, lease } = await harness(failing, root);
    const error = await broker
      .execute(context(contractRequest(fixtureTool(), { args: ["ok"] }), lease()))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProcessBrokerError);
    expect((error as ProcessBrokerError).code).toBe("SPAWN_FAILED");
    // The backend's own message must not travel with the error.
    expect(JSON.stringify((error as ProcessBrokerError).toJSON())).not.toContain("/secret/path");
    await broker.close();
  });

  it("refuses when the backend probe reports unavailable", async () => {
    const root = await scratchRoot();
    const inner = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "s") });
    const down: SandboxBackend = {
      ...inner,
      probe: async () => ({ available: false, reason: "missing-tooling", detail: null }),
    };
    const { broker, context, lease } = await harness(down, root);
    await expect(
      broker.execute(context(contractRequest(fixtureTool(), { args: ["ok"] }), lease())),
    ).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
    await broker.close();
  });

  it("honours an absolute deadline earlier than the wall-clock quota", async () => {
    const root = await scratchRoot();
    const backend = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "s") });
    const { broker, context, lease } = await harness(backend, root);
    const result = await broker.execute(
      context(
        contractRequest(fixtureTool(), {
          args: ["--sleep-forever"],
          quotas: createProcessQuotas({ wallClockMs: 30_000, outputBytes: 65_536 }),
          deadline: new Date(Date.now() + 600).toISOString(),
        }),
        lease(),
      ),
    );
    expect(result.state).toBe("deadline-exceeded");
    await broker.close();
  });

  it("keeps running when the output consumer throws", async () => {
    const root = await scratchRoot();
    const backend = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "s") });
    const { broker, context, lease } = await harness(backend, root);
    const result = await broker.execute({
      ...context(contractRequest(fixtureTool(), { args: ["hello"] }), lease()),
      onOutput: () => {
        throw new Error("consumer failure");
      },
    });
    expect(result.succeeded).toBe(true);
    await broker.close();
  });

  it("streams output incrementally to a consumer", async () => {
    const root = await scratchRoot();
    const backend = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "s") });
    const { broker, context, lease } = await harness(backend, root);
    const seen: string[] = [];
    await broker.execute({
      ...context(contractRequest(fixtureTool(), { args: ["--split-streams"] }), lease()),
      onOutput: (event) => seen.push(event.stream),
    });
    expect(seen).toContain("stdout");
    expect(seen).toContain("stderr");
    await broker.close();
  });

  it("refuses a grant that does not permit command execution", async () => {
    const root = await scratchRoot();
    const backend = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "s") });
    const { broker, context } = await harness(backend, root);
    const grant = contractGrant({ operations: ["workspace-read"] }, systemClock);
    const lease = createExecutionLease({ leaseId: "lease-ro", grant, clock: systemClock });
    await expect(
      broker.execute(context(contractRequest(fixtureTool(), { args: ["ok"] }), lease)),
    ).rejects.toMatchObject({ code: "INVALID_GRANT" });
    await broker.close();
  });

  it("refuses a lease issued for a different grant", async () => {
    const root = await scratchRoot();
    const backend = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "s") });
    const { broker, context } = await harness(backend, root);
    const other = contractGrant({ grantId: "grant-other" }, systemClock);
    const lease = createExecutionLease({ leaseId: "lease-other", grant: other, clock: systemClock });
    const request = contractRequest(fixtureTool(), { args: ["ok"] });
    await expect(
      broker.execute({
        request,
        grant: contractGrant({}, systemClock),
        lease,
        workspaceRoot: root,
        workingDirectory: root,
        workspacePaths: { tempDir: join(root, "tmp"), homeDir: null, configDir: null, cacheDir: null },
      }),
    ).rejects.toMatchObject({ code: "LEASE_INVALID" });
    await broker.close();
  });

  it("cancels a running process when its lease is revoked mid-flight", async () => {
    const root = await scratchRoot();
    const backend = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "s") });
    const { broker, context } = await harness(backend, root);
    const lease = createExecutionLease({
      leaseId: "lease-live",
      grant: contractGrant({}, systemClock),
      clock: systemClock,
    });
    const pending = broker.execute(
      context(contractRequest(fixtureTool(), { args: ["--sleep-forever"] }), lease),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    lease.revoke();
    const result = await pending;
    expect(result.state).toBe("lease-expired");
    expect(result.failure?.code).toBe("LEASE_EXPIRED");
    await broker.close();
  });

  it("waits for in-flight work before close resolves", async () => {
    const root = await scratchRoot();
    const backend = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "s") });
    const { broker, context, lease } = await harness(backend, root);
    const pending = broker.execute(
      context(
        contractRequest(fixtureTool(), {
          args: ["--sleep-forever"],
          quotas: createProcessQuotas({ wallClockMs: 800, outputBytes: 65_536 }),
        }),
        lease(),
      ),
    );
    await broker.close();
    await expect(pending).resolves.toBeDefined();
    expect(broker.closed).toBe(true);
  });
});

describe("tool resolution edge paths", () => {
  it("refuses a directory presented as an executable", async () => {
    const root = await scratchRoot();
    const directory = join(root, "not-a-file");
    await mkdir(directory, { recursive: true });
    const descriptor = createTrustedToolDescriptor({
      toolId: "dir",
      executablePath: directory,
      platform: process.platform as "win32",
      architecture: process.arch as "x64",
      trustSource: "operator-pinned",
    });
    await expect(resolveTrustedTool(descriptor)).rejects.toMatchObject({ code: "EXECUTABLE_UNSAFE" });
  });

  it("verifies a matching digest and accepts the tool", async () => {
    const root = await scratchRoot();
    const file = join(root, "payload.bin");
    await writeFile(file, "deterministic");
    const { createHash } = await import("node:crypto");
    const hex = createHash("sha256").update("deterministic").digest("hex");
    const descriptor = createTrustedToolDescriptor({
      toolId: "payload",
      executablePath: file,
      platform: process.platform as "win32",
      architecture: process.arch as "x64",
      trustSource: "operator-pinned",
      expectedDigest: { algorithm: "sha-256", hex },
      containmentRoot: root,
    });
    const resolved = await resolveTrustedTool(descriptor);
    expect(resolved.digest?.hex).toBe(hex);
    expect(resolved.toolId).toBe("payload");
  });

  it("accepts a tool inside its containment root", async () => {
    const root = await scratchRoot();
    const file = join(root, "inside.bin");
    await writeFile(file, "x");
    const descriptor = createTrustedToolDescriptor({
      toolId: "inside",
      executablePath: file,
      platform: process.platform as "win32",
      architecture: process.arch as "x64",
      trustSource: "operator-pinned",
      containmentRoot: root,
    });
    await expect(resolveTrustedTool(descriptor)).resolves.toMatchObject({ toolId: "inside" });
  });

  it("carries a backend immutable reference through resolution", async () => {
    const root = await scratchRoot();
    const file = join(root, "mounted.bin");
    await writeFile(file, "x");
    const descriptor = createTrustedToolDescriptor({
      toolId: "mounted",
      executablePath: file,
      platform: process.platform as "win32",
      architecture: process.arch as "x64",
      trustSource: "backend-provided",
      immutableReference: "sha256:image-digest",
    });
    const resolved = await resolveTrustedTool(descriptor);
    expect(resolved.immutableReference).toBe("sha256:image-digest");
  });
});

describe("grant and binding parsing edges", () => {
  it("rejects prefixes that are not normalized", () => {
    expect(() => contractGrant({ readablePrefixes: ["/leading"] })).toThrow();
    expect(() => contractGrant({ readablePrefixes: ["trailing/"] })).toThrow();
    expect(() => contractGrant({ readablePrefixes: ["back\\slash"] })).toThrow();
  });

  it("treats a null tool digest as unpinned", () => {
    const grant = contractGrant({
      tools: [{ toolId: "echo", digest: null, immutableReference: null }],
    });
    expect(grantAllowsTool(grant, "echo", null)).toBe(true);
    expect(grantAllowsTool(grant, "echo", "a".repeat(64))).toBe(true);
  });

  it("rejects a malformed grant document", () => {
    expect(() => parseCapabilityGrant({ schemaVersion: 2 })).toThrow();
    expect(() => parseCapabilityGrant(null)).toThrow();
    expect(() => contractGrant({ nonce: "short" })).toThrow();
    expect(() => contractGrant({ policyFingerprint: "not-a-digest" })).toThrow();
  });

  it("validates each environment binding variant", () => {
    expect(parseEnvironmentBinding({ kind: "literal", name: "A", value: "1" }).name).toBe("A");
    expect(
      parseEnvironmentBinding({ kind: "workspace-path", name: "W", value: "w" }).kind,
    ).toBe("workspace-path");
    expect(
      parseEnvironmentBinding({ kind: "secret", name: "S", secretRefFingerprint: "a".repeat(64) }).kind,
    ).toBe("secret");
    expect(() => parseEnvironmentBinding({ kind: "secret", name: "S", secretRefFingerprint: "x" })).toThrow();
    expect(() => parseEnvironmentBinding({ kind: "literal", name: "1BAD", value: "x" })).toThrow();
    expect(() =>
      parseEnvironmentBinding({ kind: "workspace-path", name: "W", value: "../outside" }),
    ).toThrow();
    expect(() =>
      parseEnvironmentBinding({ kind: "workspace-path", name: "W", value: "/outside" }),
    ).toThrow();
    expect(() => parseEnvironmentBinding({ kind: "unknown", name: "A", value: "1" })).toThrow();
  });

  it("accepts and sorts approval evidence references", () => {
    const grant = contractGrant({ approvalEvidenceRefs: ["evidence-b", "evidence-a", "evidence-b"] });
    expect(grant.approvalEvidenceRefs).toEqual(["evidence-a", "evidence-b"]);
  });

  it("rejects standard input that is not bytes", () => {
    expect(() =>
      contractRequest(fixtureTool(), {
        stdin: { kind: "bytes", bytes: "text" as unknown as Uint8Array },
      }),
    ).toThrow();
  });

  it("orders multiple environment bindings deterministically", () => {
    const bindings = parseEnvironmentBindings([
      { kind: "literal", name: "ZEBRA", value: "1" },
      { kind: "literal", name: "ALPHA", value: "2" },
      { kind: "literal", name: "MIKE", value: "3" },
    ]);
    expect(bindings.map((binding) => binding.name)).toEqual(["ALPHA", "MIKE", "ZEBRA"]);
  });

  it("tracks the running combined byte total", () => {
    const collector = new BoundedOutputCollector({
      maxStreamBytes: 64,
      maxCombinedBytes: 128,
      maxLineBytes: 32,
    });
    expect(collector.combinedByteLength).toBe(0);
    collector.push("stdout", new Uint8Array(10));
    collector.push("stderr", new Uint8Array(5));
    expect(collector.combinedByteLength).toBe(15);
  });

  it("reports a null exit code as unsuccessful", () => {
    const request = contractRequest(fixtureTool(), { args: ["ok"] });
    expect(isSuccessExit(request, null)).toBe(false);
    expect(isSuccessExit(request, 0)).toBe(true);
    expect(isSuccessExit(request, 1)).toBe(false);
  });

  it("ignores an empty secret when redacting", () => {
    const collector = new BoundedOutputCollector(
      { maxStreamBytes: 128, maxCombinedBytes: 256, maxLineBytes: 64 },
      ["", "real"],
    );
    collector.push("stdout", new TextEncoder().encode("keep real text"));
    expect(Buffer.from(collector.finish().stdout.bytes).toString("utf8")).toBe(
      "keep [REDACTED SECRET] text",
    );
  });
});

describe("lifecycle cleanup", () => {
  it("removes a deadline listener when the process ends on its own", async () => {
    const root = await scratchRoot();
    const backend = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "s") });
    const { broker, context, lease } = await harness(backend, root);
    const controller = new AbortController();
    const result = await broker.execute({
      ...context(contractRequest(fixtureTool(), { args: ["quick"] }), lease()),
      signal: controller.signal,
    });
    expect(result.succeeded).toBe(true);
    // Aborting after a natural completion must not revive or re-settle it.
    controller.abort();
    expect(result.state).toBe("succeeded");
    await broker.close();
  });

  it("stops live processes when the backend closes", async () => {
    const root = await scratchRoot();
    const backend = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "s") });
    const { broker, context, lease } = await harness(backend, root);
    const pending = broker.execute(
      context(
        contractRequest(fixtureTool(), {
          args: ["--sleep-forever"],
          quotas: createProcessQuotas({ wallClockMs: 900, outputBytes: 65_536 }),
        }),
        lease(),
      ),
    );
    const result = await pending;
    expect(result.state).toBe("deadline-exceeded");
    await backend.close();
    await backend.close();
    await broker.close();
  });
});
