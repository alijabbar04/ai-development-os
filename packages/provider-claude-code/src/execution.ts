/**
 * The process-broker execution seam.
 *
 * This is the only way a Claude process is created. The adapter hands over a
 * finite argument vector and bounded stdin; this module turns that into a
 * Stage 8 `ProcessRequest` and calls the broker, which resolves the trusted
 * image, builds an environment from an empty baseline, evaluates policy, runs
 * the production admission gate, and only then spawns.
 *
 * The production gate is not touched here. When it refuses, the refusal
 * propagates unchanged: it is not caught, retried around, relabelled, or
 * downgraded to the unsafe backend. That refusal happens before any child
 * process exists, which is what makes "no Claude process started" provable
 * rather than merely intended.
 */

import {
  createProcessRequest,
  createTrustedToolDescriptor,
  isProcessBrokerError,
  type CapabilityGrant,
  type EnvironmentBinding,
  type ExecutionLease,
  type ProcessBroker,
  type ProcessResult,
  type WorkspaceEnvironmentPaths,
} from "@ai-dev-os/process-broker";
import type { ClaudeAdapterConfiguration } from "./config.js";
import type { ClaudeExecutionPort, ClaudeExecutionRequest } from "./ports.js";

export interface BrokerExecutionOptions {
  readonly broker: ProcessBroker;
  readonly configuration: ClaudeAdapterConfiguration;
  readonly grant: CapabilityGrant;
  readonly lease: ExecutionLease;
  readonly projectId: string;
  readonly attemptId: string;
  readonly policyDecisionFingerprint: string;
  readonly approvalEvidenceRefs?: readonly string[];
  /** Absolute managed workspace root. Never the user's source working tree. */
  readonly workspaceRoot: string;
  /** Absolute working directory inside the root: the managed worktree. */
  readonly workingDirectory: string;
  readonly workspacePaths: WorkspaceEnvironmentPaths;
  /** False when the caller could not prove the root is a managed path. */
  readonly workspacePathTrusted?: boolean;
  /** Environment bindings applied to every invocation, before per-call ones. */
  readonly baseEnvironment?: readonly EnvironmentBinding[];
  readonly requestIdPrefix?: string;
}

/**
 * Builds the execution port. One instance serves one attempt: the grant, lease,
 * and workspace are fixed at construction, so an invocation cannot widen its
 * own authority by varying them.
 */
export function createBrokerExecutionPort(options: BrokerExecutionOptions): ClaudeExecutionPort {
  const descriptor = options.configuration.executable;
  const tool = createTrustedToolDescriptor({
    toolId: descriptor.toolId,
    executablePath: descriptor.executablePath,
    platform: descriptor.platform,
    architecture: descriptor.architecture,
    trustSource: "operator-pinned",
    expectedDigest:
      descriptor.expectedDigestHex === null
        ? null
        : { algorithm: "sha-256", hex: descriptor.expectedDigestHex },
    immutableReference: descriptor.immutableReference,
    containmentRoot: descriptor.containmentRoot,
    allowLinkIndirection: false,
    argumentPolicy: {
      maxArguments: 64,
      maxArgumentBytes: 8_192,
      pinnedLeadingArguments: descriptor.pinnedLeadingArguments,
      // The adapter's own vector legitimately contains options, so this cannot
      // be enabled; flag safety is enforced by construction in invocation.ts,
      // where every argument is a literal or a pattern-checked token.
      denyOptionArguments: false,
    },
  });

  let sequence = 0;
  const prefix = options.requestIdPrefix ?? "claude";

  return Object.freeze({
    async execute(request: ClaudeExecutionRequest): Promise<ProcessResult> {
      sequence += 1;
      const processRequest = createProcessRequest({
        requestId: `${prefix}-${request.kind}-${sequence.toString().padStart(6, "0")}`,
        projectId: options.projectId,
        // The workspace identity comes from the grant, never from the
        // invocation, so no request can name a workspace it was not granted.
        workspaceId: options.grant.workspaceId,
        workspaceLeaseId: options.lease.leaseId,
        attemptId: options.attemptId,
        grantId: options.grant.grantId,
        policyDecisionFingerprint: options.policyDecisionFingerprint,
        approvalEvidenceRefs: options.approvalEvidenceRefs ?? [],
        tool,
        args: request.args,
        quotas: {
          wallClockMs: Math.max(1, Math.min(request.wallClockMs, 86_400_000)),
          outputBytes: Math.max(1, Math.min(request.outputBytes, 1_073_741_824)),
          cpuTimeMs: null,
          memoryBytes: null,
          processCount: null,
          diskBytes: null,
          fileCount: null,
        },
        // Claude's own service connection is a property of the execution
        // backend, not an agent capability. The request denies agent egress;
        // a backend that cannot enforce that is refused in production by the
        // Stage 8 gate rather than quietly accepted here.
        network: { mode: "denied", egressDomains: [] },
        environment: [...(options.baseEnvironment ?? []), ...request.environment],
        stdin: request.stdin === null ? { kind: "none" } : { kind: "bytes", bytes: request.stdin },
        deadline: request.deadline,
        trace: request.trace,
        successExitCodes: [],
      });

      return await options.broker.execute({
        request: processRequest,
        grant: options.grant,
        lease: options.lease,
        workspaceRoot: options.workspaceRoot,
        workingDirectory: options.workingDirectory,
        workspacePaths: options.workspacePaths,
        ...(options.workspacePathTrusted === undefined
          ? {}
          : { workspacePathTrusted: options.workspacePathTrusted }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.onOutput === undefined ? {} : { onOutput: request.onOutput }),
      });
    },
  });
}

/**
 * Classifies a process-broker failure without copying its message. Production
 * refusal is reported as itself so a caller can tell "refused before start"
 * from "started and failed".
 */
export function classifyBrokerFailure(error: unknown): {
  readonly productionRefusal: boolean;
  readonly code: string;
} {
  if (isProcessBrokerError(error)) {
    return Object.freeze({
      productionRefusal:
        error.code === "PRODUCTION_ISOLATION_REQUIRED" || error.code === "BACKEND_INSECURE",
      code: error.code,
    });
  }
  return Object.freeze({ productionRefusal: false, code: "UNKNOWN" });
}
