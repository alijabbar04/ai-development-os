/**
 * Reusable contract suites.
 *
 * `runProcessBrokerContractSuite` states what any broker must do regardless of
 * which backend is underneath. `runSandboxBackendContractSuite` states what any
 * backend must do regardless of how much isolation it provides.
 *
 * The suites are exported so a future secure backend is held to the same
 * behaviour as the unsafe development backend it replaces.
 */

import { describe, expect, it } from "vitest";
import type { SandboxBackend } from "../backend.js";
import { ProcessBrokerError } from "../errors.js";
import {
  createExecutionLease,
  parseCapabilityGrant,
  type CapabilityGrant,
  type ExecutionLease,
} from "../grant.js";
import { createProcessRequest, type ProcessRequest } from "../request.js";
import { createProcessQuotas, DENY_ALL_NETWORK } from "../quota.js";
import {
  createTrustedToolDescriptor,
  type TrustedToolDescriptor,
} from "../tool.js";
import { createManualTime, systemClock, type Clock } from "../time.js";
import type { ExecuteInput, ProcessBroker, ProcessResult } from "../broker.js";

export const CONTRACT_EPOCH = "2026-08-02T00:00:00.000Z";
const SUBJECT_FINGERPRINT = "a".repeat(64);

export interface ProcessBrokerContractHarness {
  readonly broker: ProcessBroker;
  /** A tool that prints its arguments and exits zero. */
  readonly echoTool: TrustedToolDescriptor;
  /** Builds the remaining execute() input for a request. */
  readonly context: (request: ProcessRequest, lease: ExecutionLease) => ExecuteInput;
  readonly clock: Clock;
  readonly close: () => Promise<void>;
}

export type ProcessBrokerContractFactory = () => Promise<ProcessBrokerContractHarness>;

/**
 * A grant whose validity window is relative to the supplied clock, so the
 * suite exercises live processes without a hard-coded date going stale.
 */
export function contractGrant(
  overrides: Partial<CapabilityGrant> = {},
  clock: Clock = systemClock,
): CapabilityGrant {
  const now = clock.now().valueOf();
  return parseCapabilityGrant({
    schemaVersion: 1,
    grantId: "grant-contract",
    projectId: "project-contract",
    runId: "run-contract",
    taskId: "task-contract",
    attemptId: "attempt-contract",
    snapshotId: "snapshot-contract",
    workspaceId: "workspace-contract",
    operations: ["command-execution", "workspace-read"],
    readablePrefixes: [""],
    writablePrefixes: ["out"],
    tools: [{ toolId: "echo", digest: null }],
    network: DENY_ALL_NETWORK,
    quotas: {
      wallClockMs: 30_000,
      cpuTimeMs: null,
      memoryBytes: null,
      processCount: null,
      outputBytes: 1_048_576,
      diskBytes: null,
      fileCount: null,
    },
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    nonce: "0".repeat(32),
    policyFingerprint: SUBJECT_FINGERPRINT,
    approvalEvidenceRefs: [],
    ...overrides,
  });
}

export function contractRequest(
  tool: TrustedToolDescriptor,
  overrides: Partial<Parameters<typeof createProcessRequest>[0]> = {},
): ProcessRequest {
  return createProcessRequest({
    requestId: "request-contract",
    projectId: "project-contract",
    workspaceId: "workspace-contract",
    workspaceLeaseId: "lease-contract",
    attemptId: "attempt-contract",
    grantId: "grant-contract",
    policyDecisionFingerprint: SUBJECT_FINGERPRINT,
    tool,
    args: [],
    quotas: createProcessQuotas({ wallClockMs: 30_000, outputBytes: 1_048_576 }),
    trace: {
      traceId: "trace-contract",
      runId: "run-contract",
      taskId: "task-contract",
      taskRunId: "attempt-contract",
    },
    ...overrides,
  });
}

export function contractLease(grant: CapabilityGrant, clock: Clock): ExecutionLease {
  return createExecutionLease({ leaseId: "lease-contract", grant, clock });
}

export function runProcessBrokerContractSuite(factory: ProcessBrokerContractFactory): void {
  describe("process broker contract", () => {
    async function withHarness<T>(
      body: (harness: ProcessBrokerContractHarness) => Promise<T>,
    ): Promise<T> {
      const harness = await factory();
      try {
        return await body(harness);
      } finally {
        await harness.close();
      }
    }

    async function execute(
      harness: ProcessBrokerContractHarness,
      request: ProcessRequest,
      lease?: ExecutionLease,
    ): Promise<ProcessResult> {
      const effective = lease ?? contractLease(contractGrant({}, harness.clock), harness.clock);
      return await harness.broker.execute(harness.context(request, effective));
    }

    it("runs an executable with a structured argument array", async () => {
      await withHarness(async (harness) => {
        const result = await execute(
          harness,
          contractRequest(harness.echoTool, { args: ["alpha", "beta"] }),
        );
        expect(result.succeeded).toBe(true);
        expect(result.exitCode).toBe(0);
        const text = Buffer.from(result.output.stdout.bytes).toString("utf8");
        expect(text).toContain("alpha");
        expect(text).toContain("beta");
      });
    });

    it("passes arguments verbatim without shell interpretation", async () => {
      await withHarness(async (harness) => {
        // If any layer handed this to a shell, the substitution or the
        // separator would change what the child observes.
        const hostile = ["$(echo pwned)", "`echo pwned`", "a && echo pwned", "%PATH%", "a;b|c"];
        const result = await execute(harness, contractRequest(harness.echoTool, { args: hostile }));
        const text = Buffer.from(result.output.stdout.bytes).toString("utf8");
        expect(result.succeeded).toBe(true);
        // The child must observe exactly the array that was sent: no
        // substitution performed, no token split, nothing added or removed.
        expect(text.split("\n")).toEqual(hostile);
      });
    });

    it("gives the child no ambient environment", async () => {
      await withHarness(async (harness) => {
        const result = await execute(
          harness,
          contractRequest(harness.echoTool, { args: ["--print-env"] }),
        );
        const text = Buffer.from(result.output.stdout.bytes).toString("utf8");
        const names = new Set(
          text
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
        );
        for (const forbidden of ["SSH_AUTH_SOCK", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "NODE_OPTIONS"]) {
          expect(names.has(forbidden)).toBe(false);
        }
      });
    });

    it("carries an explicitly configured environment binding", async () => {
      await withHarness(async (harness) => {
        const result = await execute(
          harness,
          contractRequest(harness.echoTool, {
            args: ["--print-env-value", "CONTRACT_VALUE"],
            environment: [{ kind: "literal", name: "CONTRACT_VALUE", value: "present" }],
          }),
        );
        expect(Buffer.from(result.output.stdout.bytes).toString("utf8")).toContain("present");
      });
    });

    it("delivers bounded standard input", async () => {
      await withHarness(async (harness) => {
        const result = await execute(
          harness,
          contractRequest(harness.echoTool, {
            args: ["--echo-stdin"],
            stdin: { kind: "bytes", bytes: new TextEncoder().encode("from-stdin") },
          }),
        );
        expect(Buffer.from(result.output.stdout.bytes).toString("utf8")).toContain("from-stdin");
      });
    });

    it("separates stdout and stderr", async () => {
      await withHarness(async (harness) => {
        const result = await execute(
          harness,
          contractRequest(harness.echoTool, { args: ["--split-streams"] }),
        );
        expect(Buffer.from(result.output.stdout.bytes).toString("utf8")).toContain("to-stdout");
        expect(Buffer.from(result.output.stderr.bytes).toString("utf8")).toContain("to-stderr");
      });
    });

    it("stops an endless writer at the output quota and never reports success", async () => {
      await withHarness(async (harness) => {
        const result = await execute(
          harness,
          contractRequest(harness.echoTool, {
            args: ["--flood"],
            outputLimits: { maxStreamBytes: 8_192, maxCombinedBytes: 16_384, maxLineBytes: 1_024 },
          }),
        );
        expect(result.succeeded).toBe(false);
        expect(result.state).toBe("quota-exceeded");
        expect(result.failure?.code).toBe("OUTPUT_QUOTA_EXCEEDED");
        expect(result.output.stdout.byteLength).toBeLessThanOrEqual(8_192);
        expect(result.output.combinedByteLength).toBeLessThanOrEqual(16_384);
      });
    });

    it("enforces a wall-clock deadline on a process that would never exit", async () => {
      await withHarness(async (harness) => {
        const result = await execute(
          harness,
          contractRequest(harness.echoTool, {
            args: ["--sleep-forever"],
            quotas: createProcessQuotas({ wallClockMs: 750, outputBytes: 65_536 }),
          }),
        );
        expect(result.state).toBe("deadline-exceeded");
        expect(result.failure?.code).toBe("DEADLINE_EXCEEDED");
        expect(result.succeeded).toBe(false);
      });
    });

    it("cancels on an abort signal and settles exactly once", async () => {
      await withHarness(async (harness) => {
        const controller = new AbortController();
        const lease = contractLease(contractGrant({}, harness.clock), harness.clock);
        const request = contractRequest(harness.echoTool, { args: ["--sleep-forever"] });
        const pending = harness.broker.execute({
          ...harness.context(request, lease),
          signal: controller.signal,
        });
        controller.abort();
        controller.abort();
        const result = await pending;
        expect(result.state).toBe("cancelled");
        expect(result.failure?.code).toBe("CANCELLED");
      });
    });

    it("treats an already-aborted signal as immediate cancellation", async () => {
      await withHarness(async (harness) => {
        const lease = contractLease(contractGrant({}, harness.clock), harness.clock);
        const request = contractRequest(harness.echoTool, { args: ["--sleep-forever"] });
        const result = await harness.broker.execute({
          ...harness.context(request, lease),
          signal: AbortSignal.abort(),
        });
        expect(result.state).toBe("cancelled");
      });
    });

    it("terminates children and grandchildren", async () => {
      await withHarness(async (harness) => {
        const result = await execute(
          harness,
          contractRequest(harness.echoTool, {
            args: ["--spawn-tree"],
            quotas: createProcessQuotas({ wallClockMs: 1_500, outputBytes: 65_536 }),
          }),
        );
        expect(result.state).toBe("deadline-exceeded");
      });
    });

    it("force-stops a process that ignores a polite termination signal", async () => {
      await withHarness(async (harness) => {
        const result = await execute(
          harness,
          contractRequest(harness.echoTool, {
            args: ["--ignore-signals"],
            quotas: createProcessQuotas({ wallClockMs: 1_000, outputBytes: 65_536 }),
          }),
        );
        expect(result.state).toBe("deadline-exceeded");
      });
    });

    it("refuses a request whose lease already expired", async () => {
      await withHarness(async (harness) => {
        const time = createManualTime(CONTRACT_EPOCH);
        const grant = contractGrant();
        const lease = createExecutionLease({
          leaseId: "lease-contract",
          grant,
          clock: time,
          expiresAt: "2026-08-02T00:00:01.000Z",
        });
        time.advance(5_000);
        await expect(
          execute(harness, contractRequest(harness.echoTool, { args: ["ok"] }), lease),
        ).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
      });
    });

    it("refuses a request whose lease was revoked", async () => {
      await withHarness(async (harness) => {
        const lease = contractLease(contractGrant({}, harness.clock), harness.clock);
        lease.revoke();
        await expect(
          execute(harness, contractRequest(harness.echoTool, { args: ["ok"] }), lease),
        ).rejects.toMatchObject({ code: "LEASE_REVOKED" });
      });
    });

    it("refuses a tool whose digest does not match", async () => {
      await withHarness(async (harness) => {
        const wrong = createTrustedToolDescriptor({
          ...harness.echoTool,
          expectedDigest: { algorithm: "sha-256", hex: "b".repeat(64) },
          argumentPolicy: harness.echoTool.argumentPolicy,
        });
        await expect(
          execute(harness, contractRequest(wrong, { args: ["ok"] })),
        ).rejects.toMatchObject({ code: "EXECUTABLE_DIGEST_MISMATCH" });
      });
    });

    it("rejects start after close and closes idempotently", async () => {
      const harness = await factory();
      await harness.broker.close();
      await harness.broker.close();
      expect(harness.broker.closed).toBe(true);
      await expect(
        harness.broker.execute(
          harness.context(
            contractRequest(harness.echoTool, { args: ["ok"] }),
            contractLease(contractGrant({}, harness.clock), harness.clock),
          ),
        ),
      ).rejects.toMatchObject({ code: "BROKER_CLOSED" });
      await harness.close();
    });

    it("keeps output and environment values out of errors", async () => {
      await withHarness(async (harness) => {
        const result = await execute(
          harness,
          contractRequest(harness.echoTool, {
            args: ["--flood"],
            environment: [{ kind: "literal", name: "CONTRACT_VALUE", value: "canary-value" }],
            outputLimits: { maxStreamBytes: 4_096, maxCombinedBytes: 8_192, maxLineBytes: 1_024 },
          }),
        );
        const serialized = JSON.stringify(result.failure?.toJSON() ?? {});
        expect(serialized).not.toContain("canary-value");
        expect(serialized.length).toBeLessThan(1_000);
      });
    });
  });
}

export interface SandboxBackendContractHarness {
  readonly backend: SandboxBackend;
  /** True when this backend is expected to be able to start processes. */
  readonly canSpawn: boolean;
}

export type SandboxBackendContractFactory = () => Promise<SandboxBackendContractHarness>;

export function runSandboxBackendContractSuite(factory: SandboxBackendContractFactory): void {
  describe("sandbox backend contract", () => {
    it("describes itself with a validated, immutable descriptor", async () => {
      const { backend } = await factory();
      const descriptor = backend.describe();
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(Object.isFrozen(descriptor.capabilities)).toBe(true);
      expect(descriptor.backendId).toMatch(/^[a-z][a-z0-9-]*$/);
      await backend.close();
    });

    it("never claims to be enforcing without filesystem and process-tree control", async () => {
      const { backend } = await factory();
      const descriptor = backend.describe();
      if (descriptor.securityClass === "secure-enforcing") {
        expect(descriptor.capabilities.filesystemIsolation).toBe(true);
        expect(descriptor.capabilities.processTreeControl).toBe(true);
      }
      await backend.close();
    });

    it("reports every quota dimension explicitly", async () => {
      const { backend } = await factory();
      const quotas = backend.describe().capabilities.quotas;
      for (const level of Object.values(quotas)) {
        expect(["enforced", "observed", "estimated", "unsupported"]).toContain(level);
      }
      await backend.close();
    });

    it("answers a probe with a stable reason code", async () => {
      const { backend } = await factory();
      const availability = await backend.probe();
      expect([
        "available",
        "unsupported-platform",
        "missing-privilege",
        "missing-tooling",
        "version-unsupported",
        "not-implemented",
      ]).toContain(availability.reason);
      await backend.close();
    });

    it("refuses to act when it is unavailable", async () => {
      const { backend, canSpawn } = await factory();
      if (canSpawn) {
        await backend.close();
        return;
      }
      await expect(
        backend.prepare({
          projectId: "project-contract",
          workspaceId: "workspace-contract",
          snapshotId: null,
          attemptId: "attempt-contract",
          leaseId: "lease-contract",
          grant: contractGrant(),
          grantFingerprint: SUBJECT_FINGERPRINT,
          policyDecisionFingerprint: SUBJECT_FINGERPRINT,
          workspaceRoot: process.cwd(),
          expiresAt: "2026-08-02T01:00:00.000Z",
          nonce: "0".repeat(32),
        }),
      ).rejects.toBeInstanceOf(ProcessBrokerError);
      await backend.close();
    });

    it("disposes and closes idempotently", async () => {
      const { backend, canSpawn } = await factory();
      if (canSpawn) {
        const session = await backend.prepare({
          projectId: "project-contract",
          workspaceId: "workspace-contract",
          snapshotId: null,
          attemptId: "attempt-contract",
          leaseId: "lease-contract",
          grant: contractGrant(),
          grantFingerprint: SUBJECT_FINGERPRINT,
          policyDecisionFingerprint: SUBJECT_FINGERPRINT,
          workspaceRoot: process.cwd(),
          expiresAt: "2026-08-02T01:00:00.000Z",
          nonce: "0".repeat(32),
        });
        await backend.dispose(session);
        await backend.dispose(session);
      }
      await backend.close();
      await backend.close();
    });
  });
}

export { systemClock };
