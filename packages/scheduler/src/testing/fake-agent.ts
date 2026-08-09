import type {
  AgentAdapterSession,
  AgentAdapterSignal,
  AgentAdapterStatus,
  AgentContinuationRequest,
  AgentAdapterRequest,
  AgentResumeRequest,
  DeterministicFakeAgentAdapter,
} from "../provider.js";
import type { NormalizedUsage, OrchestrationTerminalResult } from "../types.js";

export interface FakeAgentTurn {
  readonly signals?: readonly AgentAdapterSignal[];
  readonly throws?: boolean;
}

export interface FakeAgentScript {
  readonly start: readonly FakeAgentTurn[];
  readonly continue?: readonly FakeAgentTurn[];
  readonly resume?: readonly FakeAgentTurn[];
}

export interface FakeAgentObservation {
  readonly operation: "start" | "continue" | "resume" | "cancel" | "status" | "usage" | "result" | "close";
  readonly dispatchId: string | null;
  readonly threadId: string | null;
}

export interface FakeAgentHarness {
  readonly adapter: DeterministicFakeAgentAdapter;
  readonly observations: readonly FakeAgentObservation[];
  setStatus(dispatchId: string, status: AgentAdapterStatus): void;
  setResult(dispatchId: string, result: OrchestrationTerminalResult | null): void;
  setUsage(dispatchId: string, usage: NormalizedUsage | null): void;
}

function eventsOf(signals: readonly AgentAdapterSignal[]): AsyncIterable<AgentAdapterSignal> {
  return Object.freeze({
    async *[Symbol.asyncIterator](): AsyncIterator<AgentAdapterSignal> {
      for (const signal of signals) yield signal;
    },
  });
}

export function createFakeAgentHarness(options: {
  readonly providerId?: string;
  readonly script: FakeAgentScript;
}): FakeAgentHarness {
  const providerId = options.providerId ?? "provider:fake";
  const observations: FakeAgentObservation[] = [];
  const statuses = new Map<string, AgentAdapterStatus>();
  const results = new Map<string, OrchestrationTerminalResult | null>();
  const usages = new Map<string, NormalizedUsage | null>();
  let startIndex = 0;
  let continueIndex = 0;
  let resumeIndex = 0;
  let closed = false;

  const observe = (operation: FakeAgentObservation["operation"], dispatchId: string | null, threadId: string | null): void => {
    observations.push(Object.freeze({ operation, dispatchId, threadId }));
  };
  const turn = (items: readonly FakeAgentTurn[] | undefined, index: number): FakeAgentTurn => items?.[index] ?? Object.freeze({ signals: Object.freeze([]) });
  const session = (dispatchId: string, selected: FakeAgentTurn, threadId = `thread:${dispatchId.slice(-16)}`): AgentAdapterSession => {
    if (selected.throws === true) throw new Error("scripted fake disconnect");
    statuses.set(dispatchId, "running");
    for (const signal of selected.signals ?? []) {
      if (signal.type === "completed") { statuses.set(dispatchId, "completed"); results.set(dispatchId, signal.result); }
      if (signal.type === "failed") { statuses.set(dispatchId, "failed"); results.set(dispatchId, signal.result); }
      if (signal.type === "usage") usages.set(dispatchId, signal.usage);
    }
    return Object.freeze({ threadId, providerRunId: `run:${dispatchId.slice(-16)}`, events: eventsOf(selected.signals ?? []) });
  };

  const adapter: DeterministicFakeAgentAdapter = Object.freeze({
    testingOnly: true as const,
    adapterId: "adapter:deterministic-fake",
    providerId,
    async start(request: AgentAdapterRequest): Promise<AgentAdapterSession> {
      if (closed) throw new Error("fake closed");
      observe("start", request.dispatchId, null);
      const selected = turn(options.script.start, startIndex++);
      return session(request.dispatchId, selected);
    },
    async continue(request: AgentContinuationRequest): Promise<AgentAdapterSession> {
      if (closed) throw new Error("fake closed");
      observe("continue", request.dispatchId, request.threadId);
      const selected = turn(options.script.continue, continueIndex++);
      return session(request.dispatchId, selected, request.threadId);
    },
    async resume(request: AgentResumeRequest): Promise<AgentAdapterSession> {
      if (closed) throw new Error("fake closed");
      observe("resume", request.dispatchId, request.threadId);
      const selected = turn(options.script.resume, resumeIndex++);
      return session(request.dispatchId, selected, request.threadId);
    },
    async cancel(request: Parameters<DeterministicFakeAgentAdapter["cancel"]>[0]): Promise<void> {
      observe("cancel", request.dispatchId, request.threadId);
      statuses.set(request.dispatchId, "cancelled");
    },
    async status(request: Parameters<DeterministicFakeAgentAdapter["status"]>[0]): Promise<AgentAdapterStatus> {
      observe("status", request.dispatchId, request.threadId);
      return statuses.get(request.dispatchId) ?? "not-found";
    },
    async usage(request: Parameters<DeterministicFakeAgentAdapter["usage"]>[0]): Promise<NormalizedUsage | null> {
      observe("usage", request.dispatchId, request.threadId);
      return usages.get(request.dispatchId) ?? null;
    },
    async result(request: Parameters<DeterministicFakeAgentAdapter["result"]>[0]): Promise<OrchestrationTerminalResult | null> {
      observe("result", request.dispatchId, request.threadId);
      return results.get(request.dispatchId) ?? null;
    },
    async close(): Promise<void> {
      observe("close", null, null);
      closed = true;
    },
  });
  return Object.freeze({
    adapter,
    get observations(): readonly FakeAgentObservation[] { return Object.freeze([...observations]); },
    setStatus(dispatchId: string, status: AgentAdapterStatus): void { statuses.set(dispatchId, status); },
    setResult(dispatchId: string, result: OrchestrationTerminalResult | null): void { results.set(dispatchId, result); },
    setUsage(dispatchId: string, usage: NormalizedUsage | null): void { usages.set(dispatchId, usage); },
  });
}
