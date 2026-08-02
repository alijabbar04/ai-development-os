import { ValidationError, type JsonValue } from "@ai-dev-os/domain";
import {
  ProviderError,
  UNKNOWN_COST,
  createOperationController,
  isDeadlineExpired,
  parseCodingAgentRequest,
  parseProviderDescriptor,
  parseProviderHealth,
  toProviderError,
  type ApprovalDecision,
  type CancellationReason,
  type ChangedFileSummary,
  type CodingAgentEvent,
  type CodingAgentOperation,
  type CodingAgentProvider,
  type CodingAgentRequest,
  type CodingAgentResult,
  type CodingCapability,
  type CompletionClassification,
  type FileChangeKind,
  type ProviderDescriptor,
  type ProviderErrorCode,
  type ProviderObserver,
  type ProviderOperationId,
  type ProviderUsage,
  type StartOperationOptions,
  type TestResultSummary,
  type ToolInvocation,
  type ToolRisk,
} from "@ai-dev-os/providers";
import { createImmediateScheduler, createSequentialIds, type ManualScheduler } from "./scheduler.js";

export type CodingAgentScriptStep =
  | { readonly kind: "status"; readonly message: string }
  | { readonly kind: "workspace-read"; readonly path: string }
  | {
      readonly kind: "tool-proposal";
      readonly toolName: string;
      readonly toolCallId?: string;
      readonly arguments: JsonValue;
    }
  | { readonly kind: "output"; readonly channel: "stdout" | "stderr"; readonly text: string }
  | {
      readonly kind: "file-change";
      readonly path: string;
      readonly changeKind: FileChangeKind;
      readonly applied?: boolean;
    }
  | { readonly kind: "patch"; readonly artifactId: string }
  | {
      readonly kind: "test-run";
      readonly suite: string;
      readonly passed: number;
      readonly failed: number;
      readonly skipped: number;
      readonly artifactId?: string;
    }
  | {
      readonly kind: "approval";
      readonly approvalId?: string;
      readonly summary: string;
      readonly risk: ToolRisk;
      readonly decision: "approved" | "denied";
    }
  | { readonly kind: "usage"; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly kind: "warning"; readonly message: string }
  | { readonly kind: "delay"; readonly ms: number }
  | { readonly kind: "fail"; readonly code: ProviderErrorCode; readonly message?: string }
  | {
      readonly kind: "finish";
      readonly completion?: CompletionClassification;
      readonly resumeToken?: string;
    };

export interface CodingAgentScript {
  readonly steps: readonly CodingAgentScriptStep[];
  readonly rejectStart?: { readonly code: ProviderErrorCode };
}

export interface FakeCodingAgentProviderOptions {
  readonly script: CodingAgentScript | ((request: CodingAgentRequest) => CodingAgentScript);
  readonly scheduler?: ManualScheduler;
  readonly grantedCapabilities?: readonly CodingCapability[];
  readonly unavailableWorkspaces?: readonly string[];
  readonly descriptor?: Partial<
    Pick<ProviderDescriptor, "providerId" | "instanceId" | "locality" | "supportedClassifications">
  >;
  readonly observer?: ProviderObserver;
}

export interface FakeCodingAgentProvider extends CodingAgentProvider {
  readonly capturedRequests: readonly CodingAgentRequest[];
}

export function createFakeCodingAgentProvider(
  options: FakeCodingAgentProviderOptions,
): FakeCodingAgentProvider {
  const scheduler = options.scheduler ?? createImmediateScheduler();
  const nextOperationId = createSequentialIds("agent-op");
  const granted = new Set<CodingCapability>(
    options.grantedCapabilities ?? ["read-files", "edit-files", "run-commands", "run-tests"],
  );
  const unavailableWorkspaces = new Set(options.unavailableWorkspaces ?? []);
  const captured: CodingAgentRequest[] = [];
  const activeCancels: Array<(reason: CancellationReason) => Promise<void>> = [];
  const pumps = new Set<Promise<void>>();
  let closed = false;

  const descriptor = parseProviderDescriptor({
    schemaVersion: 1,
    providerId: options.descriptor?.providerId ?? "fake-coding-agent",
    instanceId: options.descriptor?.instanceId ?? "fake-coding-agent-1",
    kind: "coding-agent",
    displayName: "Deterministic fake coding agent",
    locality: options.descriptor?.locality ?? "local",
    retainsData: false,
    trainsOnInputs: false,
    supportedClassifications:
      options.descriptor?.supportedClassifications ?? ["public", "internal", "proprietary-source"],
    capabilities: {
      streaming: true,
      structuredOutput: false,
      toolCalling: true,
      imageInput: false,
      repositoryEditing: true,
      commandExecution: true,
      networkAccess: false,
      resumability: true,
      cancellation: "guaranteed",
      deadlineEnforcement: true,
      usageReporting: true,
      pricingAvailable: false,
    },
  });

  async function pump(
    request: CodingAgentRequest,
    script: CodingAgentScript,
    controller: ReturnType<
      typeof createOperationController<CodingAgentEvent, CodingAgentResult>
    >,
  ): Promise<void> {
    const startedAtMs = scheduler.now().valueOf();
    const changedFiles: ChangedFileSummary[] = [];
    const producedArtifacts: string[] = [];
    const approvalDecisions: ApprovalDecision[] = [];
    let patchArtifactId: string | null = null;
    let sawTests = false;
    let testsPassed = 0;
    let testsFailed = 0;
    let testsSkipped = 0;
    let testArtifactId: string | null = null;
    let usage: ProviderUsage = {
      tokens: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
      toolCalls: 0,
    };
    let approvalCounter = 0;
    let toolCounter = 0;
    let completion: CompletionClassification | null = null;
    let resumeToken: string | null = null;

    const deadlineExpired = (): boolean => isDeadlineExpired(request.deadline, scheduler.now());
    let cancelWake!: () => void;
    const cancelledSignal = new Promise<void>((resolve) => {
      cancelWake = resolve;
    });
    controller.onCancel(() => cancelWake());

    try {
      controller.emit((base) => ({
        ...base,
        kind: "operation-started",
        payload: { workspaceId: request.workspaceId as string },
      }));

      for (const step of script.steps) {
        if (controller.isTerminal) {
          return;
        }
        if (deadlineExpired()) {
          break;
        }
        switch (step.kind) {
          case "delay":
            // Cancellation must wake a paused pump: manual-scheduler waits
            // only fire when tests advance virtual time.
            await Promise.race([scheduler.wait(step.ms), cancelledSignal]);
            break;
          case "status":
            controller.emit((base) => ({
              ...base,
              kind: "status-update",
              payload: { message: step.message },
            }));
            break;
          case "workspace-read":
            controller.emit((base) => ({
              ...base,
              kind: "workspace-read",
              payload: { path: step.path },
            }));
            break;
          case "tool-proposal": {
            toolCounter += 1;
            const invocation = {
              toolCallId: step.toolCallId ?? `agent-call-${toolCounter}`,
              toolName: step.toolName,
              arguments: step.arguments,
            } as ToolInvocation;
            usage = { ...usage, toolCalls: usage.toolCalls + 1 };
            controller.emit((base) => ({
              ...base,
              kind: "tool-call-proposed",
              payload: { invocation },
            }));
            controller.emit((base) => ({
              ...base,
              kind: "tool-call-started",
              payload: { toolCallId: invocation.toolCallId, toolName: invocation.toolName },
            }));
            break;
          }
          case "output":
            controller.emit((base) => ({
              ...base,
              kind: "output-chunk",
              payload: { channel: step.channel, text: step.text, artifactId: null },
            }));
            break;
          case "file-change": {
            const change: ChangedFileSummary = Object.freeze({
              path: step.path,
              changeKind: step.changeKind,
            });
            controller.emit((base) => ({
              ...base,
              kind: "file-change-proposed",
              payload: { change },
            }));
            if (step.applied !== false) {
              changedFiles.push(change);
              controller.emit((base) => ({
                ...base,
                kind: "file-change-applied",
                payload: { change },
              }));
            }
            break;
          }
          case "patch":
            patchArtifactId = step.artifactId;
            producedArtifacts.push(step.artifactId);
            controller.emit((base) => ({
              ...base,
              kind: "patch-produced",
              payload: { artifactId: step.artifactId },
            }));
            break;
          case "test-run": {
            controller.emit((base) => ({
              ...base,
              kind: "test-started",
              payload: { suite: step.suite },
            }));
            controller.emit((base) => ({
              ...base,
              kind: "test-completed",
              payload: {
                suite: step.suite,
                passed: step.passed,
                failed: step.failed,
                skipped: step.skipped,
              },
            }));
            const artifactId = step.artifactId ?? null;
            if (artifactId !== null) {
              producedArtifacts.push(artifactId);
              testArtifactId = artifactId;
            }
            sawTests = true;
            testsPassed += step.passed;
            testsFailed += step.failed;
            testsSkipped += step.skipped;
            break;
          }
          case "approval": {
            approvalCounter += 1;
            const approvalId = step.approvalId ?? `approval-${approvalCounter}`;
            controller.emit((base) => ({
              ...base,
              kind: "approval-requested",
              payload: { approvalId, summary: step.summary, risk: step.risk },
            }));
            approvalDecisions.push(Object.freeze({ approvalId, decision: step.decision }));
            break;
          }
          case "usage":
            usage = {
              tokens: {
                inputTokens: step.inputTokens,
                outputTokens: step.outputTokens,
                cachedInputTokens: 0,
                reasoningTokens: 0,
              },
              toolCalls: usage.toolCalls,
            };
            controller.emit((base) => ({ ...base, kind: "usage-update", payload: { usage } }));
            break;
          case "warning":
            controller.emit((base) => ({
              ...base,
              kind: "warning",
              payload: { message: step.message },
            }));
            break;
          case "fail": {
            const error = new ProviderError(
              step.code,
              step.message ?? "The agent failed as scripted.",
              {},
              { operationId: controller.operation.operationId, traceId: request.trace.traceId },
            );
            controller.fail(
              (base) => ({
                ...base,
                kind: "operation-failed",
                payload: {
                  code: error.code,
                  message: error.message,
                  retryStrategy: error.retry.strategy,
                },
              }),
              error,
            );
            return;
          }
          case "finish":
            completion = step.completion ?? null;
            resumeToken = step.resumeToken ?? null;
            break;
        }
      }

      if (controller.isTerminal) {
        return;
      }
      if (deadlineExpired()) {
        const error = new ProviderError("DEADLINE_EXCEEDED", "The operation deadline passed.", {}, {
          operationId: controller.operation.operationId,
          traceId: request.trace.traceId,
        });
        controller.fail(
          (base) => ({
            ...base,
            kind: "operation-failed",
            payload: { code: error.code, message: error.message, retryStrategy: error.retry.strategy },
          }),
          error,
        );
        return;
      }

      const result: CodingAgentResult = Object.freeze({
        schemaVersion: 1,
        operationId: controller.operation.operationId,
        requestId: request.requestId,
        completion:
          completion ?? (changedFiles.length > 0 ? "completed" : "completed-no-changes"),
        patchArtifactId: patchArtifactId as CodingAgentResult["patchArtifactId"],
        changedFiles: Object.freeze([...changedFiles]),
        testResults: sawTests
          ? Object.freeze({
              artifactId: testArtifactId as TestResultSummary["artifactId"],
              passed: testsPassed,
              failed: testsFailed,
              skipped: testsSkipped,
            })
          : null,
        commandLogArtifactId: null,
        diagnosticsArtifactId: null,
        producedArtifacts: Object.freeze([...producedArtifacts]) as CodingAgentResult["producedArtifacts"],
        baseRevision: request.baseRevision,
        resultRevision: changedFiles.length > 0 ? "fake-rev-result" : request.baseRevision,
        approvalDecisions: Object.freeze([...approvalDecisions]),
        usage,
        cost: UNKNOWN_COST,
        latency: Object.freeze({
          firstEventMs: 0,
          totalMs: Math.max(0, scheduler.now().valueOf() - startedAtMs),
        }),
        warnings: Object.freeze([]),
        resumeToken,
      });
      controller.complete((base) => ({ ...base, kind: "operation-completed", payload: {} }), result);
    } catch (error) {
      if (!controller.isTerminal) {
        const wrapped = toProviderError(error);
        controller.fail(
          (base) => ({
            ...base,
            kind: "operation-failed",
            payload: {
              code: wrapped.code,
              message: wrapped.message,
              retryStrategy: wrapped.retry.strategy,
            },
          }),
          wrapped,
        );
      }
    }
  }

  return {
    kind: "coding-agent",
    capturedRequests: captured,
    describe: () => descriptor,
    async health() {
      return parseProviderHealth({
        status: closed ? "closed" : "ready",
        checkedAt: scheduler.now().toISOString(),
        detailCode: null,
        activeOperations: pumps.size,
      });
    },
    async start(
      rawRequest: CodingAgentRequest,
      startOptions: StartOperationOptions = {},
    ): Promise<CodingAgentOperation> {
      if (closed) {
        throw new ProviderError("PROVIDER_CLOSED", "The provider is closed.", {});
      }
      let request: CodingAgentRequest;
      try {
        request = parseCodingAgentRequest(rawRequest);
      } catch (error) {
        if (error instanceof ProviderError) {
          throw error;
        }
        throw new ProviderError("INVALID_REQUEST", "The request failed validation.", {
          reason: error instanceof ValidationError ? error.issues[0]?.code ?? "invalid" : "invalid",
        });
      }
      if (!descriptor.supportedClassifications.includes(request.disclosure.classification)) {
        throw new ProviderError("POLICY_DENIED", "The agent does not accept this classification.", {
          classification: request.disclosure.classification,
        });
      }
      if (unavailableWorkspaces.has(request.workspaceId as string)) {
        throw new ProviderError("WORKSPACE_UNAVAILABLE", "The workspace cannot be resolved.", {
          workspaceId: request.workspaceId as string,
        });
      }
      for (const capability of request.capabilities) {
        if (!granted.has(capability)) {
          throw new ProviderError("UNSUPPORTED_CAPABILITY", "A requested capability is not granted.", {
            capability,
          });
        }
      }
      const script =
        typeof options.script === "function" ? options.script(request) : options.script;
      if (script.rejectStart !== undefined) {
        throw new ProviderError(script.rejectStart.code, "The agent rejected the request as scripted.", {});
      }
      if (isDeadlineExpired(request.deadline, scheduler.now())) {
        throw new ProviderError("DEADLINE_EXCEEDED", "The deadline passed before start.", {});
      }
      captured.push(request);

      const controller = createOperationController<CodingAgentEvent, CodingAgentResult>({
        operationId: nextOperationId() as ProviderOperationId,
        clock: scheduler,
        trace: request.trace,
        buildCancelledEvent: (base, reason) => ({
          ...base,
          kind: "operation-cancelled",
          payload: { reason },
        }),
        onTerminal: (outcome) => {
          options.observer?.(
            Object.freeze({
              providerKind: "coding-agent",
              providerId: descriptor.providerId as string,
              instanceId: descriptor.instanceId as string,
              modelId: (request.modelId as string | null) ?? null,
              outcome:
                outcome.kind === "operation-completed"
                  ? "succeeded"
                  : outcome.kind === "operation-cancelled"
                    ? "cancelled"
                    : "failed",
              errorCode: outcome.error?.code ?? null,
              retryStrategy: outcome.error?.retry.strategy ?? null,
              latencyMs: 0,
              totalTokens: 0,
              deadlineExpired: outcome.error?.code === "DEADLINE_EXCEEDED",
              cancelled: outcome.kind === "operation-cancelled",
            }),
          );
        },
      });

      if (startOptions.signal !== undefined) {
        if (startOptions.signal.aborted) {
          await controller.operation.cancel("caller-aborted");
        } else {
          startOptions.signal.addEventListener(
            "abort",
            () => {
              void controller.operation.cancel("caller-aborted");
            },
            { once: true },
          );
        }
      }

      activeCancels.push((reason) => controller.operation.cancel(reason));
      const running = pump(request, script, controller).finally(() => {
        pumps.delete(running);
      });
      pumps.add(running);
      return controller.operation;
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      for (const cancel of activeCancels.splice(0, activeCancels.length)) {
        await cancel("provider-closed");
      }
      await Promise.allSettled([...pumps]);
    },
  };
}
