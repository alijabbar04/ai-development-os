import { ProviderError, type ProviderOperation } from "@ai-dev-os/providers";
import type {
  AgentAdapterRequest,
  AgentAdapter,
  AgentAdapterSession,
  AgentAdapterSignal,
  AgentAdapterStatus,
  AgentContinuationRequest,
  AgentResumeRequest,
  NormalizedUsage,
  OrchestrationTerminalResult,
} from "@ai-dev-os/scheduler";
import type { InferenceEvent, InferenceResult } from "@ai-dev-os/providers";
import type { InferencePlanningAdapterOptions } from "../contracts.js";
import { parsePlanningContributionDraft, planningDigest, stablePlanningId } from "../schema.js";
import { toCanonicalJson } from "@ai-dev-os/domain";

function normalizedUsage(result: InferenceResult): NormalizedUsage {
  const money = result.cost.providerReported ?? result.cost.locallyComputed;
  return Object.freeze({
    inputTokens: result.usage.tokens.inputTokens,
    cachedInputTokens: result.usage.tokens.cachedInputTokens,
    cacheWriteInputTokens: 0,
    outputTokens: result.usage.tokens.outputTokens,
    reasoningTokens: result.usage.tokens.reasoningTokens,
    toolCalls: result.usage.toolCalls,
    costMicros: money?.amountMicros ?? null,
  });
}

const ZERO_USAGE: NormalizedUsage = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  toolCalls: 0,
  costMicros: null,
});

function addUsage(left: NormalizedUsage, right: NormalizedUsage): NormalizedUsage {
  const add = (first: number, second: number): number => {
    const value = first + second;
    if (!Number.isSafeInteger(value)) throw new ProviderError("INTERNAL_FAILURE", "Planning usage exceeded safe integer bounds.");
    return value;
  };
  return Object.freeze({
    inputTokens: add(left.inputTokens, right.inputTokens),
    cachedInputTokens: add(left.cachedInputTokens, right.cachedInputTokens),
    cacheWriteInputTokens: add(left.cacheWriteInputTokens, right.cacheWriteInputTokens),
    outputTokens: add(left.outputTokens, right.outputTokens),
    reasoningTokens: add(left.reasoningTokens, right.reasoningTokens),
    toolCalls: add(left.toolCalls, right.toolCalls),
    costMicros: left.costMicros === null || right.costMicros === null ? null : add(left.costMicros, right.costMicros),
  });
}

function failedResult(
  request: AgentAdapterRequest,
  startedAt: string,
  finishedAt: string,
  code: string,
  threadId: string,
  providerRunId: string,
  observedUsage: NormalizedUsage,
  retryable: boolean,
): OrchestrationTerminalResult {
  return Object.freeze({
    schemaVersion: 1,
    outcome: "failed" as const,
    artifacts: Object.freeze([]),
    evidence: Object.freeze([]),
    usage: observedUsage,
    startedAt,
    finishedAt,
    provider: Object.freeze({
      providerId: request.route.providerId,
      modelId: request.route.modelId,
      profileId: request.route.profileId,
      threadId,
      providerRunId,
    }),
    failure: Object.freeze({ classification: "provider" as const, code, retryable }),
    nonclaims: Object.freeze(["deterministic-fake-planning-only", "no-workspace-effects"]),
  });
}

export function createInferencePlanningAgentAdapter(
  options: InferencePlanningAdapterOptions,
): AgentAdapter & { readonly testingOnly: true } {
  const providerId = options.provider.describe().providerId;
  const statuses = new Map<string, AgentAdapterStatus>();
  const results = new Map<string, OrchestrationTerminalResult>();
  const usage = new Map<string, NormalizedUsage>();
  const active = new Map<string, ProviderOperation<InferenceEvent, InferenceResult>>();
  let closed = false;

  return Object.freeze({
    testingOnly: true as const,
    adapterId: "adapter:planning-inference-fake",
    providerId,

    async start(request: AgentAdapterRequest): Promise<AgentAdapterSession> {
      if (closed) throw new Error("planning inference adapter closed");
      if (providerId !== request.route.providerId) throw new Error("planning provider route identity mismatch");
      const attempt = request.attempt ?? 1;
      const priorUsage = request.accumulatedUsage ?? ZERO_USAGE;
      const resolution = await options.resolve(request);
      const evidence = resolution.evidence;
      if (resolution.inferenceRequest.modelId !== request.route.modelId ||
          resolution.inferenceRequest.deadline !== request.deadline ||
          resolution.inferenceRequest.maxOutputTokens !== request.task.budget.maximumOutputTokens ||
          resolution.inferenceRequest.structuredOutput === null || !resolution.inferenceRequest.structuredOutput.strict ||
          toCanonicalJson(resolution.inferenceRequest.structuredOutput.schema) !== toCanonicalJson(request.task.expectedResultSchema) ||
          evidence.attempt !== attempt || evidence.schedulerTaskId !== request.task.taskId ||
          evidence.schedulerIdempotencyKey !== request.task.idempotencyKey ||
          evidence.route.providerId !== request.route.providerId || evidence.route.modelId !== request.route.modelId ||
          evidence.route.profileId !== request.route.profileId || evidence.route.ownership !== request.route.ownership ||
          evidence.inputDigest.length !== 64 || evidence.sourceFingerprint !== planningDigest(resolution.inferenceRequest) || evidence.phaseId.length < 1) {
        throw new Error("planning inference resolution evidence is cross-bound");
      }
      const threadId = stablePlanningId("planning-thread", request.dispatchId);
      const providerRunId = stablePlanningId("planning-provider-run", request.dispatchId);
      statuses.set(request.dispatchId, "running");
      const startedAt = options.clock.now().toISOString();
      const events: AsyncIterable<AgentAdapterSignal> = Object.freeze({
        async *[Symbol.asyncIterator](): AsyncGenerator<AgentAdapterSignal> {
          let observedUsage = ZERO_USAGE;
          let eventConsumption: Promise<void> | null = null;
          try {
            const operation = await options.provider.start(
              resolution.inferenceRequest,
              request.signal === undefined ? {} : { signal: request.signal },
            );
            active.set(request.dispatchId, operation);
            eventConsumption = (async (): Promise<void> => {
              for await (const event of operation.events()) {
                if (event.kind === "usage-update") {
                  observedUsage = Object.freeze({
                    inputTokens: event.payload.usage.tokens.inputTokens,
                    cachedInputTokens: event.payload.usage.tokens.cachedInputTokens,
                    cacheWriteInputTokens: 0,
                    outputTokens: event.payload.usage.tokens.outputTokens,
                    reasoningTokens: event.payload.usage.tokens.reasoningTokens,
                    toolCalls: event.payload.usage.toolCalls,
                    costMicros: null,
                  });
                }
              }
            })();
            const inference = await operation.result;
            await eventConsumption;
            active.delete(request.dispatchId);
            if (inference.modelId !== request.route.modelId) {
              throw new ProviderError("PROTOCOL_VIOLATION", "Planning inference result model differs from the trusted route.");
            }
            if (inference.structuredOutput === null) {
              throw new ProviderError("MALFORMED_RESPONSE", "Planning inference returned no structured contribution.");
            }
            const draft = parsePlanningContributionDraft(inference.structuredOutput);
            const finishedAt = options.clock.now().toISOString();
            const actualUsage = addUsage(priorUsage, normalizedUsage(inference));
            const resultId = stablePlanningId("planning-result", request.dispatchId, inference.operationId);
            yield Object.freeze({ type: "usage" as const, usage: actualUsage });
            const staged = await resolution.stage(resultId, finishedAt, actualUsage, draft as unknown as import("@ai-dev-os/domain").JsonValue);
            yield Object.freeze({
              type: "checkpoint" as const,
              checkpointId: resultId,
              kind: "planning-contribution",
              artifactIds: Object.freeze([]),
            });
            const terminal: OrchestrationTerminalResult = Object.freeze({
              schemaVersion: 1,
              outcome: "completed" as const,
              artifacts: Object.freeze([]),
              evidence: Object.freeze([Object.freeze({
                evidenceId: resultId,
                kind: "planning-contribution",
                sha256: staged.contributionDigest,
              })]),
              usage: actualUsage,
              startedAt,
              finishedAt,
              provider: Object.freeze({
                providerId: request.route.providerId,
                modelId: request.route.modelId,
                profileId: request.route.profileId,
                threadId,
                providerRunId,
              }),
              failure: null,
              nonclaims: Object.freeze(["deterministic-fake-planning-only", "model-authority-none", "no-workspace-effects"]),
            });
            statuses.set(request.dispatchId, "completed");
            results.set(request.dispatchId, terminal);
            usage.set(request.dispatchId, actualUsage);
            yield Object.freeze({ type: "completed" as const, result: terminal });
          } catch (error) {
            active.delete(request.dispatchId);
            if (eventConsumption !== null) await eventConsumption.catch(() => undefined);
            const finishedAt = options.clock.now().toISOString();
            const code = error instanceof ProviderError ? error.code.toLocaleLowerCase("en-US").replace(/_/g, "-") : "planning-provider-failure";
            const retryable = error instanceof ProviderError && error.retry.strategy !== "never";
            const totalUsage = addUsage(priorUsage, observedUsage);
            const terminal = failedResult(request, startedAt, finishedAt, code, threadId, providerRunId, totalUsage, retryable);
            statuses.set(request.dispatchId, "failed");
            results.set(request.dispatchId, terminal);
            usage.set(request.dispatchId, totalUsage);
            if (totalUsage.inputTokens + totalUsage.cachedInputTokens + totalUsage.outputTokens + totalUsage.reasoningTokens + totalUsage.toolCalls > 0) {
              yield Object.freeze({ type: "usage" as const, usage: totalUsage });
            }
            yield Object.freeze({ type: "failed" as const, result: terminal });
          }
        },
      });
      return Object.freeze({ threadId, providerRunId, events });
    },

    async continue(_request: AgentContinuationRequest): Promise<AgentAdapterSession> {
      throw new Error("bounded planning phases are single-turn");
    },

    async resume(_request: AgentResumeRequest): Promise<AgentAdapterSession> {
      throw new Error("planning inference sessions are not resumable");
    },

    async cancel(request: Parameters<AgentAdapter["cancel"]>[0]): Promise<void> {
      await active.get(request.dispatchId)?.cancel("caller-requested");
      active.delete(request.dispatchId);
      statuses.set(request.dispatchId, "cancelled");
    },

    async status(request: Parameters<AgentAdapter["status"]>[0]): Promise<AgentAdapterStatus> {
      return statuses.get(request.dispatchId) ?? "not-found";
    },

    async usage(request: Parameters<AgentAdapter["usage"]>[0]): Promise<NormalizedUsage | null> {
      return usage.get(request.dispatchId) ?? null;
    },

    async result(request: Parameters<AgentAdapter["result"]>[0]): Promise<OrchestrationTerminalResult | null> {
      return results.get(request.dispatchId) ?? null;
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await Promise.all([...active.values()].map((operation) => operation.cancel("provider-closed")));
      active.clear();
      await options.provider.close();
    },
  });
}
