import { policyDeniedError, protocolViolationError } from "./errors.js";
import { parseOpenAiResponseId } from "./endpoint.js";
import { bindingFingerprint } from "./safety.js";
import type { OpenAiResponseStatus } from "./wire.js";

/**
 * Background-response handles and resume cursors.
 *
 * A raw response id is NOT a capability. Anyone who learns one could
 * otherwise poll, resume, or cancel work belonging to a different request,
 * policy decision, or classification. Every handle therefore carries a
 * binding fingerprint over the exact context that created it, plus an
 * expiry, and is refused when either fails to match.
 */

export interface BackgroundBindingInput {
  readonly providerInstanceId: string;
  readonly requestId: string;
  readonly modelId: string;
  readonly classification: string;
  /** Fingerprint of the recorded disclosure decision, when one exists. */
  readonly policyDecisionFingerprint: string | null;
}

export function computeBackgroundBinding(input: BackgroundBindingInput): string {
  return bindingFingerprint([
    "openai-background-v1",
    input.providerInstanceId,
    input.requestId,
    input.modelId,
    input.classification,
    input.policyDecisionFingerprint ?? "no-decision",
  ]);
}

export interface BackgroundHandle {
  readonly responseId: string;
  /**
   * Highest `sequence_number` already observed, used as the
   * `starting_after` cursor on resume. Null before any event arrives.
   */
  readonly cursor: number | null;
  readonly binding: string;
  readonly expiresAt: string;
}

export function createBackgroundHandle(input: {
  readonly responseId: string;
  readonly binding: string;
  readonly expiresAt: string;
  readonly cursor?: number | null;
}): BackgroundHandle {
  return Object.freeze({
    responseId: parseOpenAiResponseId(input.responseId),
    cursor: input.cursor ?? null,
    binding: input.binding,
    expiresAt: input.expiresAt,
  });
}

export function advanceCursor(handle: BackgroundHandle, sequence: number): BackgroundHandle {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw protocolViolationError("invalid-resume-cursor");
  }
  if (handle.cursor !== null && sequence <= handle.cursor) {
    return handle;
  }
  return Object.freeze({ ...handle, cursor: sequence });
}

/**
 * Refuses a handle whose binding does not match the current context or
 * whose continuation window has closed. A forged or borrowed response id
 * fails here, before any request is issued.
 */
export function assertHandleUsable(
  handle: BackgroundHandle,
  expectedBinding: string,
  now: Date,
): void {
  if (handle.binding !== expectedBinding) {
    throw policyDeniedError("resume-token-binding-mismatch");
  }
  if (now.toISOString() >= handle.expiresAt) {
    throw policyDeniedError("resume-token-expired");
  }
}

/**
 * Tracks which stream sequence numbers have already been surfaced so a
 * resumed stream can replay overlapping events without emitting duplicates
 * or reordering the provider-neutral stream.
 */
export interface SequenceGuard {
  /** True when the event is new and should be processed. */
  accept(sequence: number): boolean;
  readonly highest: number | null;
  readonly duplicatesDropped: number;
}

export function createSequenceGuard(initialCursor: number | null = null): SequenceGuard {
  let highest: number | null = initialCursor;
  let duplicates = 0;
  return {
    accept(sequence: number): boolean {
      if (!Number.isSafeInteger(sequence) || sequence < 0) {
        throw protocolViolationError("invalid-sequence-number");
      }
      if (highest !== null && sequence <= highest) {
        duplicates += 1;
        return false;
      }
      highest = sequence;
      return true;
    },
    get highest(): number | null {
      return highest;
    },
    get duplicatesDropped(): number {
      return duplicates;
    },
  };
}

/**
 * A resumed stream must continue from the requested cursor. If the first
 * new event skips ahead, events were lost and the operation fails closed
 * rather than silently returning a truncated result.
 */
export function assertResumeContinuity(requestedAfter: number | null, firstSequence: number): void {
  if (requestedAfter === null) {
    return;
  }
  if (firstSequence <= requestedAfter) {
    // Overlapping replay is expected and handled by the sequence guard.
    return;
  }
  if (firstSequence > requestedAfter + 1) {
    throw protocolViolationError("resume-cursor-gap", {
      requestedAfter,
      received: firstSequence,
    });
  }
}

export const ACTIVE_BACKGROUND_STATUSES: readonly OpenAiResponseStatus[] = Object.freeze([
  "queued",
  "in_progress",
]);

export function isActiveStatus(status: OpenAiResponseStatus): boolean {
  return ACTIVE_BACKGROUND_STATUSES.includes(status);
}
