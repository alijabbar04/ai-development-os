import {
  createDuplexSessionLimits,
  createProcessQuotas,
  createProcessRequest,
  isProcessBrokerError,
  type CapabilityGrant,
  type EnvironmentBinding,
  type ExecutionLease,
  type ProcessBroker,
  type WorkspaceEnvironmentPaths,
} from "@ai-dev-os/process-broker";
import type { CodexAdapterConfiguration } from "./config.js";
import { ProviderError } from "@ai-dev-os/providers";
import {
  codexCancelled,
  codexDeadlineExceeded,
  codexInternalFailure,
  codexMalformedResponse,
  codexWorkspaceUnavailable,
  unsupportedCodexCapability,
} from "./errors.js";
import type { CodexProcessPort, CodexProcessRequest } from "./ports.js";

export interface BrokeredCodexProcessPortOptions {
  readonly broker: ProcessBroker;
  readonly configuration: CodexAdapterConfiguration;
  readonly projectId: string;
  readonly attemptId: string;
  readonly grant: CapabilityGrant;
  readonly lease: ExecutionLease;
  readonly policyDecisionFingerprint: string;
  readonly workspaceRoot: string;
  readonly workingDirectory: string;
  readonly workspacePaths: WorkspaceEnvironmentPaths;
  readonly workspacePathTrusted?: boolean;
  readonly baseEnvironment?: readonly EnvironmentBinding[];
}

/** The only production process seam used by probe, schema generation, and App Server. */
export function createBrokeredCodexProcessPort(options: BrokeredCodexProcessPortOptions): CodexProcessPort {
  let sequence = 0;
  const input = (request: CodexProcessRequest) => {
    const processRequest = createProcessRequest({
      requestId: `codex-${request.kind}-${++sequence}`,
      projectId: options.projectId,
      workspaceId: options.grant.workspaceId,
      workspaceLeaseId: options.lease.leaseId,
      attemptId: options.attemptId,
      grantId: options.grant.grantId,
      policyDecisionFingerprint: options.policyDecisionFingerprint,
      tool: options.configuration.executable,
      args: request.args,
      quotas: createProcessQuotas({ wallClockMs: Math.min(request.wallClockMs, options.configuration.deadlines.operationMs), outputBytes: Math.min(request.outputBytes, options.configuration.ceilings.maxProcessOutputBytes) }),
      trace: request.trace,
      environment: [...(options.baseEnvironment ?? []), ...request.environment],
      deadline: request.deadline,
      successExitCodes: [],
    });
    return {
      request: processRequest,
      grant: options.grant,
      lease: options.lease,
      workspaceRoot: options.workspaceRoot,
      workingDirectory: options.workingDirectory,
      workspacePaths: options.workspacePaths,
      ...(options.workspacePathTrusted === undefined ? {} : { workspacePathTrusted: options.workspacePathTrusted }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    };
  };

  return Object.freeze({
    execute: async (request: CodexProcessRequest) => await options.broker.execute(input(request)),
    open: async (request: CodexProcessRequest) => await options.broker.openDuplexSession({
      ...input(request),
      limits: createDuplexSessionLimits({
        maxMessageBytes: options.configuration.jsonl.maxRecordBytes,
        maxQueuedWriteBytes: options.configuration.jsonl.maxQueuedWriteBytes,
        maxTotalWriteBytes: options.configuration.jsonl.maxStreamBytes,
        maxEventBytes: options.configuration.jsonl.maxRecordBytes,
        maxQueuedEvents: options.configuration.jsonl.maxQueuedEvents,
        maxQueuedEventBytes: options.configuration.jsonl.maxQueuedEventBytes,
      }),
    }),
  });
}

export function classifyCodexBrokerFailure(error: unknown): { readonly code: string; readonly productionRefusal: boolean } {
  if (!isProcessBrokerError(error)) return Object.freeze({ code: "UNKNOWN", productionRefusal: false });
  return Object.freeze({
    code: error.code,
    productionRefusal: error.code === "PRODUCTION_ISOLATION_REQUIRED" || error.code === "BACKEND_INSECURE",
  });
}

/** Total, redacted translation of process-broker failures into provider vocabulary. */
export function mapCodexBrokerFailure(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (!isProcessBrokerError(error)) return codexInternalFailure("internal", { phase: "process" });
  switch (error.code) {
    case "PRODUCTION_ISOLATION_REQUIRED":
    case "BACKEND_INSECURE":
    case "BACKEND_UNAVAILABLE":
    case "POLICY_DENIED":
    case "ENVIRONMENT_REJECTED":
      return unsupportedCodexCapability("production-isolation-required", { brokerCode: error.code });
    case "CANCELLED":
      return codexCancelled({ brokerCode: error.code });
    case "DEADLINE_EXCEEDED":
      return codexDeadlineExceeded({ brokerCode: error.code });
    case "OUTPUT_QUOTA_EXCEEDED":
    case "EVENT_QUEUE_QUOTA_EXCEEDED":
      return codexMalformedResponse("stream-oversized", { brokerCode: error.code });
    case "LEASE_EXPIRED":
    case "LEASE_INVALID":
    case "LEASE_REVOKED":
    case "GRANT_EXPIRED":
    case "INVALID_GRANT":
      return codexWorkspaceUnavailable("workspace-lineage-mismatch", { brokerCode: error.code });
    case "EXECUTABLE_UNAVAILABLE":
    case "EXECUTABLE_UNSAFE":
    case "EXECUTABLE_DIGEST_MISMATCH":
    case "SHELL_PROHIBITED":
      return unsupportedCodexCapability("executable-missing", { brokerCode: error.code });
    default:
      return codexInternalFailure("internal", { brokerCode: error.code, phase: "process" });
  }
}
