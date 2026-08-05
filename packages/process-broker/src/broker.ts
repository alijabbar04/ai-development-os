/**
 * The process broker.
 *
 * The broker owns the order in which things happen: validate, admit, resolve
 * the executable, build the environment, prepare the sandbox, start, bound the
 * output, enforce the deadline, and settle exactly once. Every path out of a
 * started process releases the sandbox and the lease.
 */

import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

import { createAuditRecord, notifyObserver, type ProcessObserver } from "./audit.js";
import type {
  BackendProcess,
  BackendTermination,
  SandboxBackend,
  SandboxBinding,
  SandboxSession,
} from "./backend.js";
import {
  backendDescriptorFingerprint,
  parseBackendAvailability,
  parseBackendDescriptor,
} from "./backend.js";
import { ProcessBrokerError, errorCategory } from "./errors.js";
import {
  BoundedDuplexEventQueue,
  createDuplexSessionLimits,
  parseDuplexSessionLimits,
  type DuplexSessionLimits,
  type DuplexSessionOutputEvent,
} from "./duplex.js";
import {
  buildEnvironment,
  environmentBindingsFingerprint,
  type BuiltEnvironment,
  type WorkspaceEnvironmentPaths,
} from "./environment.js";
import type { ControlPlaneEndpointPolicy } from "./endpoint-policy.js";
import { parseControlPlaneEndpointPolicy } from "./endpoint-policy.js";
import { commandSubjectDigest, digestBytes, fingerprintOf } from "./fingerprint.js";
import {
  grantAllowsOperation,
  grantFingerprint,
  type CapabilityGrant,
  type ExecutionLease,
} from "./grant.js";
import type { LeaseAuthoritySnapshot } from "./grant-containment.js";
import { BoundedOutputCollector, type OutputCapture } from "./output.js";
import { parseWorkspaceRelativePath } from "./paths.js";
import {
  assertAdmitted,
  assertFinalAdmitted,
  evaluateAdmission,
  evaluateFinalAdmission,
  type AdmissionDecision,
  type ExecutionMode,
} from "./production-gate.js";
import { isSuccessExit, type ProcessRequest } from "./request.js";
import { applyArgumentPolicy, resolveTrustedTool } from "./tool.js";
import { systemClock, systemScheduler, type Clock, type Scheduler } from "./time.js";
import {
  invalidateProductionBackendRegistration,
  sandboxSessionFingerprint,
  type ProductionBackendRegistration,
} from "./trusted-evidence.js";

export const PROCESS_STATES = Object.freeze([
  "created",
  "admitted",
  "starting",
  "running",
  "terminating",
  "succeeded",
  "failed",
  "cancelled",
  "deadline-exceeded",
  "quota-exceeded",
  "lease-expired",
  "backend-lost",
  "closed",
] as const);
export type ProcessState = (typeof PROCESS_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<ProcessState> = Object.freeze(
  new Set<ProcessState>([
    "succeeded",
    "failed",
    "cancelled",
    "deadline-exceeded",
    "quota-exceeded",
    "lease-expired",
    "backend-lost",
    "closed",
  ]),
);

export interface ProcessResult {
  readonly requestId: string;
  readonly state: ProcessState;
  readonly succeeded: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly output: OutputCapture;
  readonly backendId: string;
  readonly securityClass: string;
  /** Present when the process ended for a reason other than a normal exit. */
  readonly failure: ProcessBrokerError | null;
}

export interface SecretResolver {
  /**
   * Resolves the secret bindings for one invocation. Values live only for the
   * duration of the call to `spawn` and are never retained by the broker.
   */
  resolve(
    request: ProcessRequest,
  ): Promise<ReadonlyMap<string, string>>;
}

export interface PolicyEvaluation {
  readonly outcome: "allowed" | "denied" | "conditional";
  readonly fingerprint: string;
  readonly approvalsToConsume: readonly string[];
}

/**
 * How the broker learns whether this exact command is authorized. The caller
 * supplies the bridge to the Stage 6 policy broker, because only the caller
 * knows the project's rules, classification, and approval evidence.
 */
export interface PolicyGateway {
  evaluateCommand(input: {
    readonly request: ProcessRequest;
    readonly grant: CapabilityGrant;
    readonly subjectDigest: string;
  }): Promise<PolicyEvaluation> | PolicyEvaluation;
}

export interface ProcessBrokerOptions {
  readonly backend: SandboxBackend;
  readonly mode: ExecutionMode;
  /** Backends the trusted composition layer permits in production. */
  readonly approvedBackendIds?: readonly string[];
  /** Opaque first-party evidence. Required in production; never parsed from configuration. */
  readonly productionRegistration?: ProductionBackendRegistration | null;
  /** Trusted locked provider control-plane destinations, separate from workload network. */
  readonly controlPlaneEndpointPolicy?: ControlPlaneEndpointPolicy | null;
  readonly policy: PolicyGateway;
  readonly clock?: Clock;
  readonly scheduler?: Scheduler;
  readonly observer?: ProcessObserver;
  readonly secrets?: SecretResolver;
  /** Milliseconds allowed for a polite stop before force. */
  readonly terminationGraceMs?: number;
}

export interface ExecuteInput {
  readonly request: ProcessRequest;
  readonly grant: CapabilityGrant;
  readonly lease: ExecutionLease;
  /** Absolute, already-validated workspace root owned by the caller. */
  readonly workspaceRoot: string;
  /** Resolved absolute working directory, contained within the root. */
  readonly workingDirectory: string;
  readonly workspacePaths: WorkspaceEnvironmentPaths;
  /** Set false when the caller could not prove the root is a managed path. */
  readonly workspacePathTrusted?: boolean;
  readonly signal?: AbortSignal;
  readonly onOutput?: (event: { stream: "stdout" | "stderr"; chunk: Uint8Array }) => void;
}

export interface OpenDuplexSessionInput extends Omit<ExecuteInput, "onOutput"> {
  /** Queue and message bounds specific to interactive stdin/stdout traffic. */
  readonly limits?: DuplexSessionLimits;
}

export interface DuplexProcessSession {
  readonly sessionId: string;
  readonly requestId: string;
  readonly pid: number | null;
  readonly events: AsyncIterable<DuplexSessionOutputEvent>;
  readonly result: Promise<ProcessResult>;
  readonly state: ProcessState;
  /**
   * Resolves only after the backend has accepted the complete byte message.
   * Concurrent calls are serialized and rejected before memory bounds cross.
   */
  write(bytes: Uint8Array): Promise<void>;
  /** Flushes accepted writes and closes stdin. Idempotent. */
  closeStdin(): Promise<void>;
  /** Cancels the process tree. Idempotent; the first terminal outcome wins. */
  terminate(): Promise<ProcessResult>;
  /** Closes the process session and its process tree. Idempotent. */
  close(): Promise<ProcessResult>;
}

export interface ProcessBroker {
  execute(input: ExecuteInput): Promise<ProcessResult>;
  openDuplexSession(input: OpenDuplexSessionInput): Promise<DuplexProcessSession>;
  close(): Promise<void>;
  readonly closed: boolean;
}

export function createProcessBroker(options: ProcessBrokerOptions): ProcessBroker {
  const clock = options.clock ?? systemClock;
  const scheduler = options.scheduler ?? systemScheduler;
  const graceMs = options.terminationGraceMs ?? 2_000;
  const approved = Object.freeze([...(options.approvedBackendIds ?? [])]);
  const productionRegistration = options.productionRegistration ?? null;
  const controlPlaneEndpointPolicy =
    options.controlPlaneEndpointPolicy === undefined ||
    options.controlPlaneEndpointPolicy === null
      ? null
      : parseControlPlaneEndpointPolicy(options.controlPlaneEndpointPolicy);
  const inflight = new Set<Promise<unknown>>();
  const sessions = new Set<DuplexProcessSession>();
  let closed = false;

  async function disposeSandbox(session: SandboxSession): Promise<ProcessBrokerError | null> {
    try {
      await options.backend.dispose(session);
      return null;
    } catch (error) {
      invalidateProductionBackendRegistration(productionRegistration);
      return new ProcessBrokerError(
        "SANDBOX_DISPOSAL_FAILED",
        "Sandbox cleanup could not be confirmed.",
        { backendId: session.backendId, cause: errorCategory(error) },
      );
    }
  }

  async function execute(input: ExecuteInput): Promise<ProcessResult> {
    if (closed) {
      throw new ProcessBrokerError("BROKER_CLOSED", "The process broker is closed.");
    }
    const tracked = runExecution(input);
    inflight.add(tracked);
    try {
      return await tracked;
    } finally {
      inflight.delete(tracked);
    }
  }

  async function openDuplexSession(
    input: OpenDuplexSessionInput,
  ): Promise<DuplexProcessSession> {
    if (closed) {
      throw new ProcessBrokerError("BROKER_CLOSED", "The process broker is closed.");
    }
    const tracked = runDuplexSession(input);
    inflight.add(tracked);
    try {
      const session = await tracked;
      if (closed) {
        await session.close();
        throw new ProcessBrokerError("BROKER_CLOSED", "The process broker is closed.");
      }
      sessions.add(session);
      void session.result.finally(() => sessions.delete(session));
      return session;
    } finally {
      inflight.delete(tracked);
    }
  }

  async function runDuplexSession(
    input: OpenDuplexSessionInput,
  ): Promise<DuplexProcessSession> {
    const { request, grant, lease } = input;
    const startedAt = clock.now();
    const descriptor = parseBackendDescriptor(options.backend.describe());
    const limits = parseDuplexSessionLimits(
      input.limits ?? createDuplexSessionLimits(),
      "input.limits",
    );

    if (request.stdin.kind !== "none") {
      throw new ProcessBrokerError(
        "INVALID_REQUEST",
        "A duplex session requires empty initial stdin; use session.write() after admission.",
      );
    }
    if (input.signal?.aborted === true) {
      throw new ProcessBrokerError("CANCELLED", "The process session was cancelled before start.");
    }
    if (!grantAllowsOperation(grant, "command-execution")) {
      throw new ProcessBrokerError(
        "INVALID_GRANT",
        "The capability grant does not permit command execution.",
        { grantId: grant.grantId },
      );
    }
    lease.assertValid();
    if (lease.grant.grantId !== grant.grantId) {
      throw new ProcessBrokerError("LEASE_INVALID", "The lease does not cover this grant.", {
        leaseId: lease.leaseId,
      });
    }

    const workspaceBinding = await resolveWorkspaceBinding(
      input.workspaceRoot,
      input.workingDirectory,
    );

    const resolved = await resolveTrustedTool(request.tool);
    const argv = applyArgumentPolicy(request.tool, request.args);
    const subjectDigest = commandSubjectDigest({
      toolId: resolved.toolId,
      executableDigest: resolved.digest?.hex ?? null,
      immutableReference: resolved.immutableReference,
      arguments: argv,
      workingDirectory: workspaceBinding.actualWorkingSubdirectory,
      workspaceId: request.workspaceId,
      snapshotId: grant.snapshotId,
      networkMode: request.network.mode,
      egressDomains: request.network.egressDomains,
      controlPlaneEndpointPolicyFingerprint:
        controlPlaneEndpointPolicy?.fingerprint ?? null,
      quotas: {
        wallClockMs: request.quotas.wallClockMs,
        outputBytes: request.quotas.outputBytes,
        cpuTimeMs: request.quotas.cpuTimeMs,
        memoryBytes: request.quotas.memoryBytes,
        processCount: request.quotas.processCount,
        diskBytes: request.quotas.diskBytes,
        fileCount: request.quotas.fileCount,
      },
      environmentNames: request.environment.map((binding) => binding.name),
      environmentBindingsFingerprint: environmentBindingsFingerprint(request.environment),
      stdinDigest: null,
    });

    const evaluation = await options.policy.evaluateCommand({ request, grant, subjectDigest });
    const availability = parseBackendAvailability(
      await options.backend.probe(),
      "backend.probe",
    );
    const grantValidation = parseBackendAvailability(
      options.backend.validateGrant(grant),
      "backend.validateGrant",
    );
    const currentGrantFingerprint = grantFingerprint(grant);
    const leaseSnapshot = leaseAuthoritySnapshot(lease);
    const decision = evaluateAdmission({
      mode: options.mode,
      backend: options.backend,
      descriptor,
      availability,
      grantValidation,
      approvedBackendIds: approved,
      productionRegistration,
      controlPlaneEndpointPolicy,
      grant,
      grantFingerprint: currentGrantFingerprint,
      request,
      actualWorkingSubdirectory: workspaceBinding.actualWorkingSubdirectory,
      lease: leaseSnapshot,
      clock,
      policyOutcome: evaluation.outcome,
      policyFingerprint: evaluation.fingerprint,
      policyApprovalEvidenceRefs: evaluation.approvalsToConsume,
      resolvedExecutableDigest: resolved.digest?.hex ?? null,
      resolvedImmutableReference: resolved.immutableReference,
      workspacePathTrusted:
        workspaceBinding.trusted && (input.workspacePathTrusted ?? true),
    });
    emit(decision.admitted ? "admission" : "production-refusal", {
      request,
      grant,
      decision,
      outcome: decision.admitted ? "admitted" : "refused",
      occurredAt: clock.now().toISOString(),
      environmentNameCount: request.environment.length,
    });
    assertAdmitted(decision);

    const executionBindingFingerprint = createExecutionBindingFingerprint({
      descriptorFingerprint: backendDescriptorFingerprint(descriptor),
      attestationFingerprint: decision.attestationFingerprint,
      grantValidationFingerprint: fingerprintOf(grantValidation),
      subjectFingerprint: subjectDigest,
      grantFingerprint: currentGrantFingerprint,
      lease: leaseSnapshot,
      workspaceRoot: workspaceBinding.workspaceRoot,
      workingDirectory: workspaceBinding.workingDirectory,
      executablePath: resolved.executablePath,
      executableDigest: resolved.digest?.hex ?? null,
      immutableReference: resolved.immutableReference,
      endpointPolicyFingerprint: controlPlaneEndpointPolicy?.fingerprint ?? null,
    });
    const binding: SandboxBinding = Object.freeze({
      projectId: request.projectId,
      workspaceId: request.workspaceId,
      snapshotId: grant.snapshotId,
      attemptId: request.attemptId,
      leaseId: lease.leaseId,
      grant,
      grantFingerprint: currentGrantFingerprint,
      policyDecisionFingerprint: evaluation.fingerprint,
      subjectFingerprint: subjectDigest,
      executionBindingFingerprint,
      attestationFingerprint: decision.attestationFingerprint,
      workspaceRoot: workspaceBinding.workspaceRoot,
      expiresAt: grant.expiresAt,
      nonce: grant.nonce,
    });
    const sandbox = await options.backend.prepare(binding);
    if (sandbox.backendId !== descriptor.backendId) {
      const disposalFailure = await disposeSandbox(sandbox);
      throw disposalFailure ?? new ProcessBrokerError(
        "BACKEND_INSECURE",
        "The prepared sandbox identity does not match the admitted backend.",
        { backendId: descriptor.backendId },
      );
    }
    emit("sandbox-prepared", {
      request,
      grant,
      decision,
      outcome: "prepared",
      occurredAt: clock.now().toISOString(),
      environmentNameCount: request.environment.length,
    });

    try {
      return await startDuplexProcess({
        input,
        sandbox,
        resolvedPath: resolved.executablePath,
        combinedArgs: argv,
        decision,
        executionBindingFingerprint,
        workingDirectory: workspaceBinding.workingDirectory,
        limits,
        startedAt,
      });
    } catch (error) {
      const disposalFailure = await disposeSandbox(sandbox);
      emit("sandbox-disposed", {
        request,
        grant,
        decision,
        outcome: disposalFailure === null ? "disposed" : "disposal-failed",
        occurredAt: clock.now().toISOString(),
        environmentNameCount: request.environment.length,
      });
      if (options.mode === "production" && disposalFailure !== null) {
        throw disposalFailure;
      }
      throw error;
    }
  }

  async function startDuplexProcess(context: {
    readonly input: OpenDuplexSessionInput;
    readonly sandbox: SandboxSession;
    readonly resolvedPath: string;
    readonly combinedArgs: readonly string[];
    readonly decision: AdmissionDecision;
    readonly executionBindingFingerprint: string;
    readonly workingDirectory: string;
    readonly limits: DuplexSessionLimits;
    readonly startedAt: Date;
  }): Promise<DuplexProcessSession> {
    const { input, sandbox, decision, limits, startedAt } = context;
    const { request, grant, lease } = input;
    const secretValues =
      options.secrets === undefined ? new Map<string, string>() : await options.secrets.resolve(request);
    let environment: BuiltEnvironment;
    try {
      environment = buildEnvironment({
        bindings: request.environment,
        paths: environmentPathsForSession(options.mode, sandbox, input.workspacePaths),
        secretValues,
      });
    } catch (error) {
      throw error instanceof ProcessBrokerError
        ? error
        : new ProcessBrokerError("ENVIRONMENT_REJECTED", "The child environment could not be built.", {
            cause: errorCategory(error),
          });
    }

    const collector = new BoundedOutputCollector(request.outputLimits, [...environment.secretValues]);
    const eventQueue = new BoundedDuplexEventQueue(limits);
    let state: ProcessState = "starting";
    let failure: ProcessBrokerError | null = null;
    let settled = false;
    let stdinClosed = false;
    let queuedWriteBytes = 0;
    let totalWriteBytes = 0;
    let writeTail = Promise.resolve();
    let closeStdinPromise: Promise<void> | null = null;
    const currentState = (): ProcessState => state;

    const settle = (next: ProcessState, error: ProcessBrokerError | null): boolean => {
      if (settled) {
        return false;
      }
      settled = true;
      state = next;
      failure = error;
      stdinClosed = true;
      return true;
    };

    // Consume preparation evidence only after every asynchronous setup step,
    // then re-resolve the image immediately before the backend spawn call.
    const currentTool = await resolveTrustedTool(request.tool);
    const finalDecision = evaluateFinalAdmission({
      mode: options.mode,
      registration: productionRegistration,
      receipt: sandbox.productionReceipt,
      executionBindingFingerprint: context.executionBindingFingerprint,
      sandboxSessionFingerprint: sandboxSessionFingerprint(sandbox),
      leaseValid: lease.isValid(),
      grantExpiresAt: grant.expiresAt,
      endpointPolicyExpiresAt: controlPlaneEndpointPolicy?.expiresAt ?? null,
      executableUnchanged:
        currentTool.executablePath === context.resolvedPath &&
        (currentTool.digest?.hex ?? null) === (request.tool.expectedDigest?.hex ?? null) &&
        currentTool.immutableReference === request.tool.immutableReference,
      clock,
    });
    assertFinalAdmitted(finalDecision);

    let child: BackendProcess;
    try {
      child = await options.backend.spawn({
        session: sandbox,
        request,
        tool: {
          toolId: request.tool.toolId,
          executablePath: context.resolvedPath,
          digest: request.tool.expectedDigest,
          immutableReference: request.tool.immutableReference,
        },
        argv: [context.resolvedPath, ...context.combinedArgs],
        environment,
        workingDirectory: context.workingDirectory,
      });
    } catch (error) {
      const wrapped =
        error instanceof ProcessBrokerError
          ? error
          : new ProcessBrokerError("SPAWN_FAILED", "The process could not be started.", {
              cause: errorCategory(error),
            });
      emitTerminal("failed", wrapped, null, null, startedAt, collector.finish(), context);
      throw wrapped;
    }

    state = "running";
    emit("process-start", {
      request,
      grant,
      decision,
      outcome: "running",
      occurredAt: clock.now().toISOString(),
      environmentNameCount: environment.names.length,
    });

    const stoppers: Array<() => void> = [];
    let terminationPromise: Promise<BackendTermination> | null = null;
    const stopAll = (): void => {
      for (const stop of stoppers.splice(0)) {
        try {
          stop();
        } catch {
          // Cleanup never replaces the first terminal outcome.
        }
      }
    };
    const terminateWith = (next: ProcessState, error: ProcessBrokerError): void => {
      if (settle(next, error)) {
        terminationPromise = child.terminateTree(graceMs);
      }
    };

    child.onOutput((event) => {
      const accepted = collector.push(event.stream, event.chunk);
      if (!accepted) {
        const overflow = collector.overflow;
        terminateWith(
          "quota-exceeded",
          new ProcessBrokerError("OUTPUT_QUOTA_EXCEEDED", "The process exceeded its output quota.", {
            stream: overflow?.stream ?? "combined",
            limitBytes: overflow?.limitBytes ?? request.outputLimits.maxCombinedBytes,
          }),
        );
        return;
      }
      if (!eventQueue.push(event.stream, event.chunk)) {
        terminateWith(
          "quota-exceeded",
          new ProcessBrokerError(
            "EVENT_QUEUE_QUOTA_EXCEEDED",
            "The duplex-session output event queue exceeded its bound.",
            {
              maxQueuedEvents: limits.maxQueuedEvents,
              maxQueuedEventBytes: limits.maxQueuedEventBytes,
            },
          ),
        );
      }
    });

    const deadlineMs = resolveDeadlineMs(request, clock);
    if (deadlineMs !== null) {
      const timer = scheduler.schedule(deadlineMs, () => {
        terminateWith(
          "deadline-exceeded",
          new ProcessBrokerError("DEADLINE_EXCEEDED", "The process exceeded its deadline.", {
            wallClockMs: request.quotas.wallClockMs,
          }),
        );
      });
      stoppers.push(() => timer.cancel());
    }
    const unsubscribe = lease.onInvalidated(() => {
      terminateWith(
        "lease-expired",
        new ProcessBrokerError("LEASE_EXPIRED", "The execution lease ended while the process ran.", {
          leaseId: lease.leaseId,
        }),
      );
    });
    stoppers.push(unsubscribe);
    if (input.signal !== undefined) {
      const onAbort = (): void => {
        terminateWith("cancelled", new ProcessBrokerError("CANCELLED", "The process was cancelled."));
      };
      if (input.signal.aborted) {
        onAbort();
      } else {
        input.signal.addEventListener("abort", onAbort, { once: true });
        stoppers.push(() => input.signal?.removeEventListener("abort", onAbort));
      }
    }

    let resolveResult!: (result: ProcessResult) => void;
    const resultPromise = new Promise<ProcessResult>((resolve) => {
      resolveResult = resolve;
    });

    const finalize = async (exit: { exitCode: number | null; signal: string | null }): Promise<void> => {
      stopAll();
      if (!settled) {
        if (exit.exitCode === null && exit.signal === null) {
          settle(
            "backend-lost",
            new ProcessBrokerError("BACKEND_LOST", "The backend process connection was lost."),
          );
        } else {
          settle(isSuccessExit(request, exit.exitCode) ? "succeeded" : "failed", null);
        }
      }
      if (terminationPromise !== null) {
        try {
          const termination = await terminationPromise;
          if (termination.outcome === "termination-unconfirmed") {
            state = "backend-lost";
            failure = new ProcessBrokerError(
              "PROCESS_TREE_TERMINATION_FAILED",
              "Process-tree termination could not be confirmed.",
              { backendId: decision.backendId, outcome: termination.outcome },
            );
            invalidateProductionBackendRegistration(productionRegistration);
          }
        } catch (error) {
          state = "backend-lost";
          failure = new ProcessBrokerError(
            "PROCESS_TREE_TERMINATION_FAILED",
            "Process-tree termination could not be confirmed.",
            { backendId: decision.backendId, cause: errorCategory(error) },
          );
          invalidateProductionBackendRegistration(productionRegistration);
        }
      }
      eventQueue.finish();
      const output = collector.finish();
      const endedAt = clock.now();
      const disposalFailure = await disposeSandbox(sandbox);
      if (options.mode === "production" && disposalFailure !== null) {
        state = "backend-lost";
        failure = disposalFailure;
      }
      const finalState = currentState();
      const result: ProcessResult = Object.freeze({
        requestId: request.requestId,
        state: finalState,
        succeeded: finalState === "succeeded",
        exitCode: exit.exitCode,
        signal: exit.signal,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: Math.max(0, endedAt.valueOf() - startedAt.valueOf()),
        output,
        backendId: decision.backendId,
        securityClass: decision.securityClass,
        failure,
      });
      emitTerminal(finalState, failure, exit.exitCode, result.durationMs, startedAt, output, context);
      emit("sandbox-disposed", {
        request,
        grant,
        decision,
        outcome: disposalFailure === null ? "disposed" : "disposal-failed",
        occurredAt: clock.now().toISOString(),
        environmentNameCount: request.environment.length,
      });
      resolveResult(result);
    };
    void child.wait().then(
      finalize,
      () => finalize({ exitCode: null, signal: null }),
    );

    const write = async (bytes: Uint8Array): Promise<void> => {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
        throw new ProcessBrokerError("INVALID_REQUEST", "A duplex write must contain bytes.");
      }
      if (settled) {
        throw new ProcessBrokerError("SESSION_CLOSED", "The duplex process session is closed.");
      }
      if (stdinClosed) {
        throw new ProcessBrokerError("SESSION_STDIN_CLOSED", "Standard input is already closed.");
      }
      if (
        bytes.byteLength > limits.maxMessageBytes ||
        totalWriteBytes + bytes.byteLength > limits.maxTotalWriteBytes
      ) {
        throw new ProcessBrokerError(
          "INPUT_QUOTA_EXCEEDED",
          "The duplex session exceeded its input byte limit.",
          {
            messageBytes: bytes.byteLength,
            maxMessageBytes: limits.maxMessageBytes,
            maxTotalWriteBytes: limits.maxTotalWriteBytes,
          },
        );
      }
      if (queuedWriteBytes + bytes.byteLength > limits.maxQueuedWriteBytes) {
        throw new ProcessBrokerError("WRITE_QUEUE_FULL", "The duplex-session write queue is full.", {
          queuedWriteBytes,
          maxQueuedWriteBytes: limits.maxQueuedWriteBytes,
        });
      }

      const copy = new Uint8Array(bytes);
      queuedWriteBytes += copy.byteLength;
      totalWriteBytes += copy.byteLength;
      const operation = writeTail.then(async () => {
        if (settled) {
          throw new ProcessBrokerError("SESSION_CLOSED", "The duplex process session is closed.");
        }
        try {
          await child.writeStdin(copy);
        } catch (error) {
          const wrapped = new ProcessBrokerError(
            "BACKEND_LOST",
            "The backend rejected a standard-input write.",
            { cause: errorCategory(error) },
          );
          terminateWith("backend-lost", wrapped);
          throw wrapped;
        }
      });
      writeTail = operation.then(
        () => undefined,
        () => undefined,
      );
      try {
        await operation;
      } finally {
        queuedWriteBytes -= copy.byteLength;
      }
    };

    const closeStdin = (): Promise<void> => {
      if (closeStdinPromise !== null) {
        return closeStdinPromise;
      }
      if (settled) {
        return Promise.resolve();
      }
      stdinClosed = true;
      closeStdinPromise = writeTail.then(async () => {
        if (settled) {
          return;
        }
        try {
          await child.closeStdin();
        } catch (error) {
          terminateWith(
            "backend-lost",
            new ProcessBrokerError("BACKEND_LOST", "The backend rejected stdin closure.", {
              cause: errorCategory(error),
            }),
          );
        }
      });
      return closeStdinPromise;
    };

    const terminate = async (): Promise<ProcessResult> => {
      terminateWith("cancelled", new ProcessBrokerError("CANCELLED", "The process was cancelled."));
      return await resultPromise;
    };
    const closeSession = async (): Promise<ProcessResult> => {
      terminateWith("closed", new ProcessBrokerError("SESSION_CLOSED", "The process session was closed."));
      return await resultPromise;
    };

    return Object.freeze({
      sessionId: sandbox.sessionId,
      requestId: request.requestId,
      pid: child.pid,
      events: eventQueue,
      result: resultPromise,
      get state(): ProcessState {
        return currentState();
      },
      write,
      closeStdin,
      terminate,
      close: closeSession,
    });
  }

  async function runExecution(input: ExecuteInput): Promise<ProcessResult> {
    const { request, grant, lease } = input;
    const startedAt = clock.now();
    const descriptor = parseBackendDescriptor(options.backend.describe());

    // 1. Authority that does not depend on the filesystem or the backend.
    if (!grantAllowsOperation(grant, "command-execution")) {
      throw new ProcessBrokerError(
        "INVALID_GRANT",
        "The capability grant does not permit command execution.",
        { grantId: grant.grantId },
      );
    }
    lease.assertValid();
    if (lease.grant.grantId !== grant.grantId) {
      throw new ProcessBrokerError("LEASE_INVALID", "The lease does not cover this grant.", {
        leaseId: lease.leaseId,
      });
    }

    const workspaceBinding = await resolveWorkspaceBinding(
      input.workspaceRoot,
      input.workingDirectory,
    );

    // 2. The exact image, verified now rather than earlier.
    const resolved = await resolveTrustedTool(request.tool);
    const argv = applyArgumentPolicy(request.tool, request.args);

    // 3. The normalized subject. Any change here invalidates the approval.
    const subjectDigest = commandSubjectDigest({
      toolId: resolved.toolId,
      executableDigest: resolved.digest?.hex ?? null,
      immutableReference: resolved.immutableReference,
      arguments: argv,
      workingDirectory: workspaceBinding.actualWorkingSubdirectory,
      workspaceId: request.workspaceId,
      snapshotId: grant.snapshotId,
      networkMode: request.network.mode,
      egressDomains: request.network.egressDomains,
      controlPlaneEndpointPolicyFingerprint:
        controlPlaneEndpointPolicy?.fingerprint ?? null,
      quotas: {
        wallClockMs: request.quotas.wallClockMs,
        outputBytes: request.quotas.outputBytes,
        cpuTimeMs: request.quotas.cpuTimeMs,
        memoryBytes: request.quotas.memoryBytes,
        processCount: request.quotas.processCount,
        diskBytes: request.quotas.diskBytes,
        fileCount: request.quotas.fileCount,
      },
      environmentNames: request.environment.map((binding) => binding.name),
      environmentBindingsFingerprint: environmentBindingsFingerprint(request.environment),
      stdinDigest: request.stdin.kind === "bytes" ? digestBytes(request.stdin.bytes) : null,
    });

    const evaluation = await options.policy.evaluateCommand({ request, grant, subjectDigest });
    const availability = parseBackendAvailability(
      await options.backend.probe(),
      "backend.probe",
    );
    const grantValidation = parseBackendAvailability(
      options.backend.validateGrant(grant),
      "backend.validateGrant",
    );
    const currentGrantFingerprint = grantFingerprint(grant);
    const leaseSnapshot = leaseAuthoritySnapshot(lease);

    // 4. Admission. Nothing has been created yet; a refusal here is clean.
    const decision = evaluateAdmission({
      mode: options.mode,
      backend: options.backend,
      descriptor,
      availability,
      grantValidation,
      approvedBackendIds: approved,
      productionRegistration,
      controlPlaneEndpointPolicy,
      grant,
      grantFingerprint: currentGrantFingerprint,
      request,
      actualWorkingSubdirectory: workspaceBinding.actualWorkingSubdirectory,
      lease: leaseSnapshot,
      clock,
      policyOutcome: evaluation.outcome,
      policyFingerprint: evaluation.fingerprint,
      policyApprovalEvidenceRefs: evaluation.approvalsToConsume,
      resolvedExecutableDigest: resolved.digest?.hex ?? null,
      resolvedImmutableReference: resolved.immutableReference,
      workspacePathTrusted:
        workspaceBinding.trusted && (input.workspacePathTrusted ?? true),
    });
    emit(decision.admitted ? "admission" : "production-refusal", {
      request,
      grant,
      decision,
      outcome: decision.admitted ? "admitted" : "refused",
      occurredAt: clock.now().toISOString(),
      environmentNameCount: request.environment.length,
    });
    assertAdmitted(decision);

    // 5. Prepare the sandbox only after admission succeeded.
    const executionBindingFingerprint = createExecutionBindingFingerprint({
      descriptorFingerprint: backendDescriptorFingerprint(descriptor),
      attestationFingerprint: decision.attestationFingerprint,
      grantValidationFingerprint: fingerprintOf(grantValidation),
      subjectFingerprint: subjectDigest,
      grantFingerprint: currentGrantFingerprint,
      lease: leaseSnapshot,
      workspaceRoot: workspaceBinding.workspaceRoot,
      workingDirectory: workspaceBinding.workingDirectory,
      executablePath: resolved.executablePath,
      executableDigest: resolved.digest?.hex ?? null,
      immutableReference: resolved.immutableReference,
      endpointPolicyFingerprint: controlPlaneEndpointPolicy?.fingerprint ?? null,
    });
    const binding: SandboxBinding = Object.freeze({
      projectId: request.projectId,
      workspaceId: request.workspaceId,
      snapshotId: grant.snapshotId,
      attemptId: request.attemptId,
      leaseId: lease.leaseId,
      grant,
      grantFingerprint: currentGrantFingerprint,
      policyDecisionFingerprint: evaluation.fingerprint,
      subjectFingerprint: subjectDigest,
      executionBindingFingerprint,
      attestationFingerprint: decision.attestationFingerprint,
      workspaceRoot: workspaceBinding.workspaceRoot,
      expiresAt: grant.expiresAt,
      nonce: grant.nonce,
    });
    const session = await options.backend.prepare(binding);
    if (session.backendId !== descriptor.backendId) {
      const disposalFailure = await disposeSandbox(session);
      throw disposalFailure ?? new ProcessBrokerError(
        "BACKEND_INSECURE",
        "The prepared sandbox identity does not match the admitted backend.",
        { backendId: descriptor.backendId },
      );
    }
    emit("sandbox-prepared", {
      request,
      grant,
      decision,
      outcome: "prepared",
      occurredAt: clock.now().toISOString(),
      environmentNameCount: request.environment.length,
    });

    let result: ProcessResult | null = null;
    let executionFailure: unknown = null;
    try {
      result = await runProcess({
        input,
        session,
        resolvedPath: resolved.executablePath,
        combinedArgs: argv,
        decision,
        evaluation,
        executionBindingFingerprint,
        workingDirectory: workspaceBinding.workingDirectory,
        startedAt,
      });
    } catch (error) {
      executionFailure = error;
    }
    const disposalFailure = await disposeSandbox(session);
    emit("sandbox-disposed", {
      request,
      grant,
      decision,
      outcome: disposalFailure === null ? "disposed" : "disposal-failed",
      occurredAt: clock.now().toISOString(),
      environmentNameCount: request.environment.length,
    });
    if (options.mode === "production" && disposalFailure !== null) {
      throw disposalFailure;
    }
    if (executionFailure !== null) {
      throw executionFailure;
    }
    if (result === null) {
      throw new ProcessBrokerError("BACKEND_LOST", "Execution did not produce a result.");
    }
    return result;
  }

  async function runProcess(context: {
    readonly input: ExecuteInput;
    readonly session: SandboxSession;
    readonly resolvedPath: string;
    readonly combinedArgs: readonly string[];
    readonly decision: AdmissionDecision;
    readonly evaluation: PolicyEvaluation;
    readonly executionBindingFingerprint: string;
    readonly workingDirectory: string;
    readonly startedAt: Date;
  }): Promise<ProcessResult> {
    const { input, session, decision, startedAt } = context;
    const { request, grant, lease } = input;

    // Secrets are resolved as late as possible and never stored.
    const secretValues =
      options.secrets === undefined ? new Map<string, string>() : await options.secrets.resolve(request);

    let environment: BuiltEnvironment;
    try {
      environment = buildEnvironment({
        bindings: request.environment,
        paths: environmentPathsForSession(options.mode, session, input.workspacePaths),
        secretValues,
      });
    } catch (error) {
      throw error instanceof ProcessBrokerError
        ? error
        : new ProcessBrokerError("ENVIRONMENT_REJECTED", "The child environment could not be built.", {
            cause: errorCategory(error),
          });
    }

    const collector = new BoundedOutputCollector(request.outputLimits, [...environment.secretValues]);
    let state: ProcessState = "starting";
    let failure: ProcessBrokerError | null = null;
    let settled = false;
    // Read through a function: the callbacks below are the only writers for
    // several states, and control-flow narrowing cannot see them.
    const currentState = (): ProcessState => state;

    /** First terminal outcome wins; later ones are ignored entirely. */
    const settle = (next: ProcessState, error: ProcessBrokerError | null): boolean => {
      if (settled) {
        return false;
      }
      settled = true;
      state = next;
      failure = error;
      return true;
    };

    // Consume preparation evidence only after every asynchronous setup step,
    // then re-resolve the image immediately before the backend spawn call.
    const currentTool = await resolveTrustedTool(request.tool);
    const finalDecision = evaluateFinalAdmission({
      mode: options.mode,
      registration: productionRegistration,
      receipt: session.productionReceipt,
      executionBindingFingerprint: context.executionBindingFingerprint,
      sandboxSessionFingerprint: sandboxSessionFingerprint(session),
      leaseValid: lease.isValid(),
      grantExpiresAt: grant.expiresAt,
      endpointPolicyExpiresAt: controlPlaneEndpointPolicy?.expiresAt ?? null,
      executableUnchanged:
        currentTool.executablePath === context.resolvedPath &&
        (currentTool.digest?.hex ?? null) === (request.tool.expectedDigest?.hex ?? null) &&
        currentTool.immutableReference === request.tool.immutableReference,
      clock,
    });
    assertFinalAdmitted(finalDecision);

    let child: BackendProcess;
    try {
      child = await options.backend.spawn({
        session,
        request,
        tool: {
          toolId: request.tool.toolId,
          executablePath: context.resolvedPath,
          digest: request.tool.expectedDigest,
          immutableReference: request.tool.immutableReference,
        },
        argv: [context.resolvedPath, ...context.combinedArgs],
        environment,
        workingDirectory: context.workingDirectory,
      });
    } catch (error) {
      const wrapped =
        error instanceof ProcessBrokerError
          ? error
          : new ProcessBrokerError("SPAWN_FAILED", "The process could not be started.", {
              cause: errorCategory(error),
            });
      emitTerminal("failed", wrapped, null, null, startedAt, collector.finish(), context);
      throw wrapped;
    }

    state = "running";
    emit("process-start", {
      request,
      grant,
      decision,
      outcome: "running",
      occurredAt: clock.now().toISOString(),
      environmentNameCount: environment.names.length,
    });

    // Every asynchronous stopper below funnels into one termination path so a
    // process can never be left running by a race between them.
    const stoppers: Array<() => void> = [];
    let terminationPromise: Promise<BackendTermination> | null = null;
    const currentTermination = (): Promise<BackendTermination> | null => terminationPromise;
    const stopAll = (): void => {
      for (const stop of stoppers.splice(0)) {
        try {
          stop();
        } catch {
          // A cleanup failure must not mask the terminal outcome.
        }
      }
    };

    // `settle` records the terminal outcome; the tree stop that follows must
    // not overwrite it, or the reason the process ended would be lost.
    const terminate = (next: ProcessState, error: ProcessBrokerError): void => {
      if (settle(next, error)) {
        terminationPromise = child.terminateTree(graceMs);
      }
    };

    child.onOutput((event) => {
      if (input.onOutput !== undefined) {
        try {
          input.onOutput(event);
        } catch {
          // A consumer failure must not stop draining or leak the process.
        }
      }
      const accepted = collector.push(event.stream, event.chunk);
      if (!accepted) {
        const overflow = collector.overflow;
        terminate(
          "quota-exceeded",
          new ProcessBrokerError("OUTPUT_QUOTA_EXCEEDED", "The process exceeded its output quota.", {
            stream: overflow?.stream ?? "combined",
            limitBytes: overflow?.limitBytes ?? request.outputLimits.maxCombinedBytes,
          }),
        );
      }
    });

    // Wall-clock deadline. The broker enforces this itself because it observes
    // it directly; it does not depend on the backend.
    const deadlineMs = resolveDeadlineMs(request, clock);
    if (deadlineMs !== null) {
      const timer = scheduler.schedule(deadlineMs, () => {
        terminate(
          "deadline-exceeded",
          new ProcessBrokerError("DEADLINE_EXCEEDED", "The process exceeded its deadline.", {
            wallClockMs: request.quotas.wallClockMs,
          }),
        );
      });
      stoppers.push(() => timer.cancel());
    }

    // Lease revocation or expiry cancels work already running.
    const unsubscribe = lease.onInvalidated(() => {
      terminate(
        "lease-expired",
        new ProcessBrokerError("LEASE_EXPIRED", "The execution lease ended while the process ran.", {
          leaseId: lease.leaseId,
        }),
      );
    });
    stoppers.push(unsubscribe);

    if (input.signal !== undefined) {
      const onAbort = (): void => {
        terminate("cancelled", new ProcessBrokerError("CANCELLED", "The process was cancelled."));
      };
      if (input.signal.aborted) {
        onAbort();
      } else {
        input.signal.addEventListener("abort", onAbort, { once: true });
        stoppers.push(() => input.signal?.removeEventListener("abort", onAbort));
      }
    }

    if (request.stdin.kind === "bytes") {
      await child.writeStdin(request.stdin.bytes).catch(() => undefined);
    }
    await child.closeStdin().catch(() => undefined);

    const exit = await child.wait();
    stopAll();

    const pendingTermination = currentTermination();
    if (pendingTermination !== null) {
      try {
        const termination = await pendingTermination;
        if (termination.outcome === "termination-unconfirmed") {
          state = "backend-lost";
          failure = new ProcessBrokerError(
            "PROCESS_TREE_TERMINATION_FAILED",
            "Process-tree termination could not be confirmed.",
            { backendId: decision.backendId, outcome: termination.outcome },
          );
          invalidateProductionBackendRegistration(productionRegistration);
        }
      } catch (error) {
        state = "backend-lost";
        failure = new ProcessBrokerError(
          "PROCESS_TREE_TERMINATION_FAILED",
          "Process-tree termination could not be confirmed.",
          { backendId: decision.backendId, cause: errorCategory(error) },
        );
        invalidateProductionBackendRegistration(productionRegistration);
      }
    }

    const output = collector.finish();
    const endedAt = clock.now();

    if (!settled) {
      // The process ended on its own. A zero exit is transport success only:
      // the caller still has to validate what the command actually produced.
      settle(isSuccessExit(request, exit.exitCode) ? "succeeded" : "failed", null);
    }

    const finalState = currentState();
    const result: ProcessResult = Object.freeze({
      requestId: request.requestId,
      state: finalState,
      succeeded: finalState === "succeeded",
      exitCode: exit.exitCode,
      signal: exit.signal,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: Math.max(0, endedAt.valueOf() - startedAt.valueOf()),
      output,
      backendId: decision.backendId,
      securityClass: decision.securityClass,
      failure,
    });

    emitTerminal(finalState, failure, exit.exitCode, result.durationMs, startedAt, output, context);
    return result;
  }

  function emitTerminal(
    finalState: ProcessState,
    error: ProcessBrokerError | null,
    exitCode: number | null,
    durationMs: number | null,
    _startedAt: Date,
    output: OutputCapture,
    context: {
      readonly input: ExecuteInput;
      readonly decision: AdmissionDecision;
    },
  ): void {
    notifyObserver(
      options.observer,
      createAuditRecord({
        event: "process-terminal",
        occurredAt: clock.now().toISOString(),
        requestId: context.input.request.requestId,
        attemptId: context.input.request.attemptId,
        workspaceId: context.input.request.workspaceId,
        projectId: context.input.request.projectId,
        traceId: context.input.request.trace.traceId,
        backendId: context.decision.backendId,
        securityClass: context.decision.securityClass,
        mode: context.decision.mode,
        toolId: context.input.request.tool.toolId,
        argumentCount: context.input.request.args.length,
        policyFingerprint: context.input.request.policyDecisionFingerprint,
        grantFingerprint: grantFingerprint(context.input.grant),
        outcome: finalState,
        reasons: error === null ? [] : [error.code],
        exitCode,
        durationMs,
        stdoutBytes: output.stdout.byteLength,
        stderrBytes: output.stderr.byteLength,
        environmentNameCount: context.input.request.environment.length,
      }),
    );
  }

  function emit(
    event: Parameters<typeof createAuditRecord>[0]["event"],
    input: {
      readonly request: ProcessRequest;
      readonly grant: CapabilityGrant;
      readonly decision: AdmissionDecision;
      readonly outcome: string;
      readonly occurredAt: string;
      readonly environmentNameCount: number;
    },
  ): void {
    notifyObserver(
      options.observer,
      createAuditRecord({
        event,
        occurredAt: input.occurredAt,
        requestId: input.request.requestId,
        attemptId: input.request.attemptId,
        workspaceId: input.request.workspaceId,
        projectId: input.request.projectId,
        traceId: input.request.trace.traceId,
        backendId: input.decision.backendId,
        securityClass: input.decision.securityClass,
        mode: input.decision.mode,
        toolId: input.request.tool.toolId,
        argumentCount: input.request.args.length,
        policyFingerprint: input.request.policyDecisionFingerprint,
        grantFingerprint: grantFingerprint(input.grant),
        outcome: input.outcome,
        reasons: input.decision.reasons,
        exitCode: null,
        durationMs: null,
        stdoutBytes: 0,
        stderrBytes: 0,
        environmentNameCount: input.environmentNameCount,
      }),
    );
  }

  return Object.freeze({
    execute,
    openDuplexSession,
    get closed(): boolean {
      return closed;
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await Promise.allSettled([...sessions].map((session) => session.close()));
      await Promise.allSettled([...inflight]);
      try {
        await options.backend.close();
      } catch (error) {
        invalidateProductionBackendRegistration(productionRegistration);
        if (options.mode === "production") {
          throw new ProcessBrokerError(
            "SANDBOX_DISPOSAL_FAILED",
            "Backend shutdown cleanup could not be confirmed.",
            { cause: errorCategory(error) },
          );
        }
      }
    },
  });
}

interface ResolvedWorkspaceBinding {
  readonly trusted: boolean;
  readonly workspaceRoot: string;
  readonly workingDirectory: string;
  readonly actualWorkingSubdirectory: string;
}

/** Resolve the actual paths and reject traversal, cross-volume, and link escape. */
async function resolveWorkspaceBinding(
  workspaceRoot: string,
  workingDirectory: string,
): Promise<ResolvedWorkspaceBinding> {
  const refused = (): ResolvedWorkspaceBinding => Object.freeze({
    trusted: false,
    workspaceRoot,
    workingDirectory,
    actualWorkingSubdirectory: "",
  });
  if (!isAbsolute(workspaceRoot) || !isAbsolute(workingDirectory)) return refused();
  try {
    const canonicalRoot = await realpath(workspaceRoot);
    const canonicalWorkingDirectory = await realpath(workingDirectory);
    const platformRelative = relative(canonicalRoot, canonicalWorkingDirectory);
    if (
      isAbsolute(platformRelative) ||
      platformRelative === ".." ||
      platformRelative.startsWith(`..${sep}`)
    ) {
      return refused();
    }
    const actualWorkingSubdirectory =
      platformRelative.length === 0
        ? ""
        : parseWorkspaceRelativePath(platformRelative.split(sep).join("/"));
    return Object.freeze({
      trusted: true,
      workspaceRoot: canonicalRoot,
      workingDirectory: canonicalWorkingDirectory,
      actualWorkingSubdirectory,
    });
  } catch {
    return refused();
  }
}

function environmentPathsForSession(
  mode: ExecutionMode,
  session: SandboxSession,
  requested: WorkspaceEnvironmentPaths,
): WorkspaceEnvironmentPaths {
  if (mode === "production") {
    return Object.freeze({
      tempDir: session.tempDir,
      homeDir: session.homeDir,
      configDir: null,
      cacheDir: null,
    });
  }
  return Object.freeze({
    tempDir: session.tempDir,
    homeDir: requested.homeDir ?? session.homeDir,
    configDir: requested.configDir,
    cacheDir: requested.cacheDir,
  });
}

function resolveDeadlineMs(request: ProcessRequest, clock: Clock): number | null {
  const fromQuota = request.quotas.wallClockMs;
  if (request.deadline === null) {
    return fromQuota;
  }
  const remaining = new Date(request.deadline).valueOf() - clock.now().valueOf();
  return Math.max(0, Math.min(fromQuota, remaining));
}

function leaseAuthoritySnapshot(lease: ExecutionLease): LeaseAuthoritySnapshot {
  const record = lease.record();
  return Object.freeze({
    leaseId: lease.leaseId,
    grantId: record.grantId,
    grantFingerprint: grantFingerprint(lease.grant),
    workspaceId: record.workspaceId,
    attemptId: record.attemptId,
    state: record.state,
    expiresAt: record.expiresAt,
    version: record.version,
  });
}

function createExecutionBindingFingerprint(input: {
  readonly descriptorFingerprint: string;
  readonly attestationFingerprint: string | null;
  readonly grantValidationFingerprint: string;
  readonly subjectFingerprint: string;
  readonly grantFingerprint: string;
  readonly lease: LeaseAuthoritySnapshot;
  readonly workspaceRoot: string;
  readonly workingDirectory: string;
  readonly executablePath: string;
  readonly executableDigest: string | null;
  readonly immutableReference: string | null;
  readonly endpointPolicyFingerprint: string | null;
}): string {
  return fingerprintOf({
    version: 1,
    descriptorFingerprint: input.descriptorFingerprint,
    attestationFingerprint: input.attestationFingerprint,
    grantValidationFingerprint: input.grantValidationFingerprint,
    subjectFingerprint: input.subjectFingerprint,
    grantFingerprint: input.grantFingerprint,
    lease: input.lease,
    workspaceRootFingerprint: fingerprintOf(input.workspaceRoot),
    workingDirectoryFingerprint: fingerprintOf(input.workingDirectory),
    executablePathFingerprint: fingerprintOf(input.executablePath),
    executableDigest: input.executableDigest,
    immutableReference: input.immutableReference,
    endpointPolicyFingerprint: input.endpointPolicyFingerprint,
  });
}
