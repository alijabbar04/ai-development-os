/**
 * Narrow structured observation hook for adapter-specific telemetry.
 *
 * Observations are bounded structural records: counts, stable category
 * codes, model ids, and derived durations. Prompts, generated text,
 * reasoning, refusal text, tool arguments, raw response bodies, request
 * headers, URLs, API keys, and safety identifiers never appear here.
 * Standard per-operation records additionally flow through the
 * @ai-dev-os/providers ProviderObserver.
 *
 * This package performs no console logging of any kind; an observer is the
 * only way telemetry leaves it.
 */

/** How the response was executed, for retention-honest reporting. */
export type OpenAiExecutionMode = "synchronous" | "background" | "background-streaming";

/** What the upstream was actually asked to retain. */
export interface OpenAiRetentionObservation {
  /** Value sent as `store`; false unless policy authorized persistence. */
  readonly storeRequested: boolean;
  /** True when background mode placed content in temporary server storage. */
  readonly temporaryServerStateUsed: boolean;
  /** Documented temporary-storage window that applied, in milliseconds. */
  readonly temporaryStorageMs: number;
  /** True only when the operator declared a contractual ZDR arrangement. */
  readonly zeroDataRetentionEnrolled: boolean;
}

export type OpenAiObservation =
  | {
      readonly kind: "request";
      readonly modelId: string;
      readonly executionMode: OpenAiExecutionMode;
      readonly streaming: boolean;
      readonly toolCount: number;
      readonly structuredOutput: boolean;
      readonly reasoningRequested: boolean;
      readonly retention: OpenAiRetentionObservation;
      readonly safetyIdentifierPresent: boolean;
    }
  | {
      readonly kind: "http";
      readonly route: string;
      readonly status: number;
      readonly requestId: string | null;
      readonly rateLimitRemaining: number | null;
      readonly rateLimitResetMs: number | null;
      readonly retryAfterMs: number | null;
      readonly serviceTier: string | null;
      readonly attempt: number;
    }
  | {
      readonly kind: "background";
      readonly phase: "created" | "polled" | "resumed" | "cancelled" | "abandoned";
      readonly status: string | null;
      readonly pollAttempt: number;
      readonly resumeAttempt: number;
      readonly cursor: number | null;
      /** True when the remote operation may still be running. */
      readonly remoteMayStillRun: boolean;
    }
  | {
      readonly kind: "stream";
      readonly eventCount: number;
      readonly duplicateEventsDropped: number;
      readonly informationalEventsIgnored: number;
      readonly highestSequence: number | null;
    }
  | {
      readonly kind: "operation";
      readonly modelId: string;
      readonly outcome: "succeeded" | "failed" | "cancelled";
      readonly errorCode: string | null;
      readonly executionMode: OpenAiExecutionMode;
      readonly inputTokens: number;
      readonly cachedInputTokens: number;
      readonly cacheWriteTokens: number;
      readonly outputTokens: number;
      readonly reasoningTokens: number;
      readonly toolCalls: number;
      readonly costMicros: number | null;
      readonly costCurrency: string | null;
      readonly pricingSource: string | null;
      readonly totalMs: number;
    }
  | {
      readonly kind: "catalog";
      readonly catalogVersion: string;
      readonly catalogFingerprint: string;
      readonly offeredModelCount: number;
    };

export type OpenAiObserver = (observation: OpenAiObservation) => void;

/** Invokes an observer without letting a faulty hook break an operation. */
export function safelyObserve(
  observer: OpenAiObserver | undefined,
  observation: OpenAiObservation,
): void {
  if (observer === undefined) {
    return;
  }
  try {
    observer(observation);
  } catch {
    // An observer must never influence provider behavior.
  }
}
