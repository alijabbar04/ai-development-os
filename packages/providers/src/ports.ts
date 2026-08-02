import type { ModelCapabilities } from "@ai-dev-os/domain";
import type { ModelDescriptor, ProviderDescriptor, ProviderHealth } from "./common.js";
import type { CodingAgentRequest, CodingAgentResult } from "./coding-agent.js";
import type { CodingAgentEvent, InferenceEvent } from "./events.js";
import type { InferenceRequest, InferenceResult } from "./inference.js";
import type { ProviderOperation } from "./operation.js";

export type InferenceOperation = ProviderOperation<InferenceEvent, InferenceResult>;
export type CodingAgentOperation = ProviderOperation<CodingAgentEvent, CodingAgentResult>;

/**
 * Structural view of a WHATWG AbortSignal, declared here so the contracts
 * package needs no platform lib types. Real AbortSignals satisfy it.
 */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: { readonly once?: boolean },
  ): void;
}

export interface StartOperationOptions {
  /**
   * Optional integration mechanism: aborting the signal calls
   * operation.cancel("caller-aborted"). Operation-level semantics (single
   * terminal outcome, first-terminal-wins races, idempotent cancel) are
   * defined by ProviderOperation, not by the signal.
   */
  readonly signal?: AbortSignalLike;
}

/**
 * Lifecycle shared by both provider kinds:
 *
 * - constructing a provider performs no network or process work;
 * - describe() is synchronous and immutable;
 * - close() cancels active operations with reason "provider-closed",
 *   settles them, and is idempotent;
 * - start() after close() rejects with PROVIDER_CLOSED.
 */
export interface ProviderLifecycle {
  describe(): ProviderDescriptor;
  health(): Promise<ProviderHealth>;
  close(): Promise<void>;
}

export interface InferenceProvider extends ProviderLifecycle {
  readonly kind: "inference";
  listModels(): Promise<readonly ModelDescriptor[]>;
  start(request: InferenceRequest, options?: StartOperationOptions): Promise<InferenceOperation>;
}

export interface CodingAgentProvider extends ProviderLifecycle {
  readonly kind: "coding-agent";
  start(request: CodingAgentRequest, options?: StartOperationOptions): Promise<CodingAgentOperation>;
}

export type AnyProvider = InferenceProvider | CodingAgentProvider;

export type { ModelCapabilities };
