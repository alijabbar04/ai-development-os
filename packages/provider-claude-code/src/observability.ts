/**
 * Structured, secret-safe observations.
 *
 * Observations answer "what was attempted, against which installation, and how
 * did it end". They never answer "what was said": prompts, source content,
 * patches, raw Claude events, stderr, tool arguments, hidden reasoning, session
 * transcripts, secret values, environment bindings, authentication identifiers,
 * and full user paths are all absent by construction, because no field of any
 * observation can hold them.
 *
 * There is no console logging anywhere in this package. An observer that throws
 * is contained: the failure is swallowed, the operation is unaffected, and the
 * thrown value is never inspected or forwarded, so a hostile observer cannot
 * use its own exception as an exfiltration channel.
 */

import type { ClaudeCapacityStatus } from "./capacity.js";
import type { ClaudeCompatibilityTier } from "./compatibility.js";
import type { ClaudeCostSemantics } from "./usage.js";
import type { ClaudeDetailCode } from "./errors.js";
import type { ClaudeProbeStatus } from "./discovery.js";

export const CLAUDE_RECONCILIATION_OUTCOMES = Object.freeze([
  "clean",
  "changes-accepted",
  "no-changes",
  "violation",
  "unavailable",
] as const);
export type ClaudeReconciliationOutcome = (typeof CLAUDE_RECONCILIATION_OUTCOMES)[number];

export type ClaudeObservation =
  | {
      readonly kind: "probe";
      readonly status: ClaudeProbeStatus;
      readonly tier: ClaudeCompatibilityTier;
      readonly version: string | null;
      readonly platform: string;
      readonly architecture: string;
      readonly executableResolved: boolean;
      readonly digestPinned: boolean;
      readonly detailCode: ClaudeDetailCode | null;
    }
  | {
      readonly kind: "operation-started";
      readonly requestedModel: string | null;
      readonly requestedEffort: string | null;
      /** Category only: never a permission rule or a tool argument. */
      readonly permissionProfile: "read-only" | "edit" | "edit-and-command";
      readonly builtInToolCount: number;
      readonly deniedToolCount: number;
      readonly backendId: string;
      readonly securityClass: string;
      readonly sessionPersisted: boolean;
      readonly resumed: boolean;
    }
  | {
      readonly kind: "operation-terminal";
      readonly category: "succeeded" | "failed" | "cancelled";
      readonly errorCode: string | null;
      readonly detailCode: ClaudeDetailCode | null;
      readonly retryStrategy: string | null;
      readonly requestedModel: string | null;
      readonly observedModel: string | null;
      readonly requestedEffort: string | null;
      readonly observedEffort: string | null;
      readonly changedFileCount: number;
      readonly patchArtifactWritten: boolean;
      readonly commandLogArtifactWritten: boolean;
      readonly diagnosticsArtifactWritten: boolean;
      readonly testArtifactWritten: boolean;
      readonly sessionMetadataArtifactWritten: boolean;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cachedInputTokens: number;
      readonly toolCalls: number;
      readonly costSemantics: ClaudeCostSemantics;
      readonly reportedCostMicros: number | null;
      readonly capacityStatus: ClaudeCapacityStatus;
      readonly latencyMs: number;
      readonly deadlineExpired: boolean;
      readonly cancelled: boolean;
      readonly reconciliation: ClaudeReconciliationOutcome;
      readonly backendId: string;
      readonly securityClass: string;
      readonly terminationConfirmed: boolean;
    }
  | {
      readonly kind: "compatibility-warning";
      /** Stable category of the unrecognized record, never its payload. */
      readonly recordCategory: string;
      readonly occurrences: number;
    };

export type ClaudeObserver = (observation: ClaudeObservation) => void;

/**
 * Invokes an observer without letting its failure affect the operation. The
 * thrown value is deliberately not inspected: reading it would create a path
 * for an observer to influence adapter behaviour.
 */
export function notifyClaudeObserver(
  observer: ClaudeObserver | undefined,
  observation: ClaudeObservation,
): void {
  if (observer === undefined) {
    return;
  }
  try {
    observer(observation);
  } catch {
    // Deliberately swallowed. Observation delivery is best effort; the caller
    // owns the durable journal.
  }
}
