/**
 * The process broker.
 *
 * The broker owns the order in which things happen: validate, admit, resolve
 * the executable, build the environment, prepare the sandbox, start, bound the
 * output, enforce the deadline, and settle exactly once. Every path out of a
 * started process releases the sandbox and the lease.
 */

import { createAuditRecord, notifyObserver, type ProcessObserver } from "./audit.js";
import type {
  BackendProcess,
  SandboxBackend,
  SandboxBinding,
  SandboxSession,
} from "./backend.js";
import { ProcessBrokerError, errorCategory } from "./errors.js";
import {
  buildEnvironment,
  type BuiltEnvironment,
  type WorkspaceEnvironmentPaths,
} from "./environment.js";
import { commandSubjectDigest, digestBytes } from "./fingerprint.js";
import {
  grantAllowsOperation,
  grantFingerprint,
  type CapabilityGrant,
  type ExecutionLease,
} from "./grant.js";
import { BoundedOutputCollector, type OutputCapture } from "./output.js";
import {
  assertAdmitted,
  evaluateAdmission,
  type AdmissionDecision,
  type ExecutionMode,
} from "./production-gate.js";
import { isSuccessExit, type ProcessRequest } from "./request.js";
import { applyArgumentPolicy, resolveTrustedTool } from "./tool.js";
import { systemClock, systemScheduler, type Clock, type Scheduler } from "./time.js";

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

export interface ProcessBroker {
  execute(input: ExecuteInput): Promise<ProcessResult>;
  close(): Promise<void>;
  readonly closed: boolean;
}

export function createProcessBroker(options: ProcessBrokerOptions): ProcessBroker {
  const clock = options.clock ?? systemClock;
  const scheduler = options.scheduler ?? systemScheduler;
  const graceMs = options.terminationGraceMs ?? 2_000;
  const approved = Object.freeze([...(options.approvedBackendIds ?? [])]);
  const inflight = new Set<Promise<unknown>>();
  let closed = false;

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

  async function runExecution(input: ExecuteInput): Promise<ProcessResult> {
    const { request, grant, lease } = input;
    const startedAt = clock.now();
    const descriptor = options.backend.describe();

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

    // 2. The exact image, verified now rather than earlier.
    const resolved = await resolveTrustedTool(request.tool);
    const argv = applyArgumentPolicy(request.tool, request.args);

    // 3. The normalized subject. Any change here invalidates the approval.
    const subjectDigest = commandSubjectDigest({
      toolId: resolved.toolId,
      executableDigest: resolved.digest?.hex ?? null,
      immutableReference: resolved.immutableReference,
      arguments: argv,
      workingDirectory: request.workingSubdirectory,
      workspaceId: request.workspaceId,
      snapshotId: grant.snapshotId,
      networkMode: request.network.mode,
      egressDomains: request.network.egressDomains,
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
      stdinDigest: request.stdin.kind === "bytes" ? digestBytes(request.stdin.bytes) : null,
    });

    const evaluation = await options.policy.evaluateCommand({ request, grant, subjectDigest });
    const availability = await options.backend.probe();

    // 4. Admission. Nothing has been created yet; a refusal here is clean.
    const decision = evaluateAdmission({
      mode: options.mode,
      descriptor,
      availability,
      approvedBackendIds: approved,
      grant,
      request,
      clock,
      policyOutcome: evaluation.outcome,
      policyFingerprint: evaluation.fingerprint,
      resolvedExecutableDigest: resolved.digest?.hex ?? null,
      workspaceLeaseValid: lease.isValid(),
      workspacePathTrusted: input.workspacePathTrusted ?? true,
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
    const binding: SandboxBinding = Object.freeze({
      projectId: request.projectId,
      workspaceId: request.workspaceId,
      snapshotId: grant.snapshotId,
      attemptId: request.attemptId,
      leaseId: lease.leaseId,
      grant,
      grantFingerprint: grantFingerprint(grant),
      policyDecisionFingerprint: evaluation.fingerprint,
      workspaceRoot: input.workspaceRoot,
      expiresAt: grant.expiresAt,
      nonce: grant.nonce,
    });
    const session = await options.backend.prepare(binding);
    emit("sandbox-prepared", {
      request,
      grant,
      decision,
      outcome: "prepared",
      occurredAt: clock.now().toISOString(),
      environmentNameCount: request.environment.length,
    });

    try {
      return await runProcess({
        input,
        session,
        resolvedPath: resolved.executablePath,
        combinedArgs: argv,
        decision,
        evaluation,
        startedAt,
      });
    } finally {
      await options.backend.dispose(session).catch(() => undefined);
      emit("sandbox-disposed", {
        request,
        grant,
        decision,
        outcome: "disposed",
        occurredAt: clock.now().toISOString(),
        environmentNameCount: request.environment.length,
      });
    }
  }

  async function runProcess(context: {
    readonly input: ExecuteInput;
    readonly session: SandboxSession;
    readonly resolvedPath: string;
    readonly combinedArgs: readonly string[];
    readonly decision: AdmissionDecision;
    readonly evaluation: PolicyEvaluation;
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
        paths: {
          tempDir: session.tempDir,
          homeDir: input.workspacePaths.homeDir ?? session.homeDir,
          configDir: input.workspacePaths.configDir,
          cacheDir: input.workspacePaths.cacheDir,
        },
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
    const settle = (next: ProcessState, error: ProcessBrokerError | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      state = next;
      failure = error;
    };

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
        workingDirectory: input.workingDirectory,
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
      settle(next, error);
      void child.terminateTree(graceMs).catch(() => undefined);
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
    get closed(): boolean {
      return closed;
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await Promise.allSettled([...inflight]);
      await options.backend.close().catch(() => undefined);
    },
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
