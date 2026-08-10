import type {
  NormalizedUsage,
  OrchestrationTaskEnvelope,
  OrchestrationTerminalResult,
  SelectedRoute,
} from "./types.js";

export const AGENT_ADAPTER_STATUSES = Object.freeze([
  "not-found",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "disconnected",
] as const);
export type AgentAdapterStatus = (typeof AGENT_ADAPTER_STATUSES)[number];

export type AgentAdapterSignal =
  | { readonly type: "progress"; readonly message: string; readonly percent: number | null }
  | { readonly type: "checkpoint"; readonly checkpointId: string; readonly kind: string; readonly artifactIds: readonly string[] }
  | { readonly type: "usage"; readonly usage: NormalizedUsage }
  | { readonly type: "approval-required"; readonly approvalId: string; readonly reason: string }
  | { readonly type: "policy-blocked"; readonly code: string; readonly reason: string; readonly humanResumable: boolean }
  | { readonly type: "completed"; readonly result: OrchestrationTerminalResult }
  | { readonly type: "failed"; readonly result: OrchestrationTerminalResult };

export interface AgentAdapterRequest {
  readonly dispatchId: string;
  /** One-based persisted scheduler attempt for exact provider evidence binding. */
  readonly attempt?: number;
  /** Durable usage accumulated by earlier attempts for this task. */
  readonly accumulatedUsage?: NormalizedUsage;
  readonly task: OrchestrationTaskEnvelope;
  readonly route: SelectedRoute;
  readonly deadline: string;
  readonly signal?: AbortSignal;
}

type LegacyAgentAdapterRequestShape = {
  readonly dispatchId: string;
  readonly task: OrchestrationTaskEnvelope;
  readonly route: SelectedRoute;
  readonly deadline: string;
  readonly signal?: AbortSignal;
};
type AssertAgentRequestAssignable<T extends AgentAdapterRequest> = T;
/** Compile-time fixture: pre-Stage-18B adapter requests remain source compatible. */
type LegacyAgentAdapterRequestCompatibility = AssertAgentRequestAssignable<LegacyAgentAdapterRequestShape>;

export interface AgentContinuationRequest {
  readonly dispatchId: string;
  readonly threadId: string;
  readonly providerRunId: string;
  readonly instruction: string;
  readonly deadline: string;
  readonly signal?: AbortSignal;
}

export interface AgentResumeRequest {
  readonly dispatchId: string;
  readonly threadId: string;
  readonly deadline: string;
  readonly signal?: AbortSignal;
}

export interface AgentAdapterSession {
  readonly threadId: string;
  readonly providerRunId: string;
  readonly events: AsyncIterable<AgentAdapterSignal>;
}

export interface AgentAdapter {
  readonly adapterId: string;
  readonly providerId: string;
  start(request: AgentAdapterRequest): Promise<AgentAdapterSession>;
  continue(request: AgentContinuationRequest): Promise<AgentAdapterSession>;
  resume(request: AgentResumeRequest): Promise<AgentAdapterSession>;
  cancel(request: { readonly dispatchId: string; readonly threadId: string | null; readonly reason: string }): Promise<void>;
  status(request: { readonly dispatchId: string; readonly threadId: string | null }): Promise<AgentAdapterStatus>;
  usage(request: { readonly dispatchId: string; readonly threadId: string }): Promise<NormalizedUsage | null>;
  result(request: { readonly dispatchId: string; readonly threadId: string }): Promise<OrchestrationTerminalResult | null>;
  close(): Promise<void>;
}

/** Only this marker is accepted by the non-exported testing scheduler factory. */
export interface DeterministicFakeAgentAdapter extends AgentAdapter {
  readonly testingOnly: true;
}
