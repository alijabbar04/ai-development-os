/**
 * Narrow structured observation hook for adapter-specific telemetry.
 *
 * Observations are bounded structural records: counts, categories, stable
 * codes, model names, and converted durations. Prompts, generated text,
 * reasoning, tool arguments, raw backend responses, headers, URLs, and
 * environment values never appear here. Standard per-operation records
 * additionally flow through the @ai-dev-os/providers ProviderObserver.
 */
export type OllamaObservation =
  | {
      readonly kind: "discovery";
      readonly installedModelCount: number;
      readonly eligibleModelCount: number;
      readonly runningModelCount: number;
      readonly skippedInvalidEntries: number;
      readonly digestMismatchCount: number;
      readonly catalogFingerprint: string;
    }
  | {
      readonly kind: "health-check";
      readonly category:
        | "healthy"
        | "degraded"
        | "overloaded"
        | "unavailable"
        | "incompatible"
        | "closed";
      readonly serverReachable: boolean;
      readonly apiCompatible: boolean;
    }
  | {
      readonly kind: "admission";
      readonly category: "admitted" | "rejected";
      readonly model: string;
      readonly errorCode: string | null;
    }
  | {
      readonly kind: "operation";
      readonly model: string;
      readonly outcome: "succeeded" | "failed" | "cancelled";
      readonly errorCode: string | null;
      readonly inputTokens: number;
      readonly outputTokens: number;
      /**
       * Converted from provider-reported nanosecond counters (derived, not
       * provider-reported milliseconds); null when the server omitted them.
       */
      readonly totalDurationMs: number | null;
      readonly loadDurationMs: number | null;
      readonly promptEvalDurationMs: number | null;
      readonly evalDurationMs: number | null;
    }
  | {
      readonly kind: "residency";
      readonly action: "load" | "unload";
      readonly model: string;
      readonly category: "applied" | "failed";
    };

export type OllamaObserver = (observation: OllamaObservation) => void;

/** Safe nanosecond -> millisecond conversion (floor); null passes through. */
export function nanosToMillis(nanos: number | null): number | null {
  if (nanos === null) {
    return null;
  }
  return Math.floor(nanos / 1_000_000);
}
