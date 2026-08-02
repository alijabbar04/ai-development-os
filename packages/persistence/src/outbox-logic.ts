import { validation } from "@ai-dev-os/domain";
import { PersistenceError } from "./errors.js";
import {
  parseFailureCategory,
  parsePersistedId,
  type OutboxStatus,
} from "./records.js";

const { ensureNullable, ensureTimestamp } = validation;

/**
 * Pure outbox state-machine transitions shared by every adapter so that
 * memory and SQLite behave identically. Transitions are generic over any
 * record shape carrying the transition fields, so adapters can apply them
 * to stored rows without materializing payloads. All functions either
 * return the next value (frozen) or throw a structured PersistenceError.
 * Idempotent acknowledgement returns the stored message unchanged.
 */
export interface OutboxTransitionState {
  readonly messageId: string;
  readonly status: OutboxStatus;
  readonly availableAt: string;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly attemptCount: number;
  readonly acknowledgedAt: string | null;
  readonly deadLetteredAt: string | null;
  readonly lastFailureCategory: string | null;
}

function stateConflict(
  operation: string,
  message: OutboxTransitionState,
  reason: string,
): PersistenceError {
  return new PersistenceError(
    "OUTBOX_STATE_CONFLICT",
    `Cannot ${operation} outbox message: ${reason}.`,
    { messageId: message.messageId, status: message.status },
  );
}

/** A message is claimable when pending and available, or when its lease expired. */
export function isClaimable(message: OutboxTransitionState, nowIso: string): boolean {
  if (message.status === "pending") {
    return message.availableAt <= nowIso;
  }
  if (message.status === "leased") {
    return message.leaseExpiresAt !== null && message.leaseExpiresAt <= nowIso;
  }
  return false;
}

export function applyClaim<T extends OutboxTransitionState>(
  message: T,
  claim: { readonly owner: string; readonly leaseExpiresAt: string },
): T {
  return Object.freeze({
    ...message,
    status: "leased" as const,
    leaseOwner: claim.owner,
    leaseExpiresAt: claim.leaseExpiresAt,
    attemptCount: message.attemptCount + 1,
  }) as T;
}

function requireLeasedByOwner(
  operation: string,
  message: OutboxTransitionState,
  owner: string,
): void {
  if (message.status !== "leased") {
    throw stateConflict(operation, message, `it is ${message.status}, not leased`);
  }
  if (message.leaseOwner !== owner) {
    throw stateConflict(operation, message, "it is leased by a different owner");
  }
}

/** Terminal success. Re-acknowledging an acknowledged message is a no-op. */
export function applyAcknowledge<T extends OutboxTransitionState>(
  message: T,
  input: { readonly owner: string; readonly nowIso: string },
): { readonly changed: boolean; readonly message: T } {
  const owner = parsePersistedId(input.owner, "acknowledge.owner");
  if (message.status === "acknowledged") {
    return Object.freeze({ changed: false, message });
  }
  requireLeasedByOwner("acknowledge", message, owner);
  return Object.freeze({
    changed: true,
    message: Object.freeze({
      ...message,
      status: "acknowledged" as const,
      acknowledgedAt: input.nowIso,
      leaseOwner: null,
      leaseExpiresAt: null,
    }) as T,
  });
}

/** Returns the message to pending with a future availability time. */
export function applyScheduleRetry<T extends OutboxTransitionState>(
  message: T,
  input: {
    readonly owner: string;
    readonly retryAt: string;
    readonly failureCategory?: string | null;
  },
): T {
  const owner = parsePersistedId(input.owner, "scheduleRetry.owner");
  const retryAt = ensureTimestamp(input.retryAt, "scheduleRetry.retryAt");
  const failureCategory = ensureNullable(input.failureCategory, (category) =>
    parseFailureCategory(category, "scheduleRetry.failureCategory"),
  );
  requireLeasedByOwner("retry", message, owner);
  return Object.freeze({
    ...message,
    status: "pending" as const,
    availableAt: retryAt,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastFailureCategory: failureCategory ?? message.lastFailureCategory,
  }) as T;
}

/** Terminal failure. */
export function applyDeadLetter<T extends OutboxTransitionState>(
  message: T,
  input: {
    readonly owner: string;
    readonly failureCategory: string;
    readonly nowIso: string;
  },
): T {
  const owner = parsePersistedId(input.owner, "deadLetter.owner");
  const failureCategory = parseFailureCategory(
    input.failureCategory,
    "deadLetter.failureCategory",
  );
  requireLeasedByOwner("dead-letter", message, owner);
  return Object.freeze({
    ...message,
    status: "dead-lettered" as const,
    deadLetteredAt: input.nowIso,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastFailureCategory: failureCategory,
  }) as T;
}

export function leaseExpiry(now: Date, leaseDurationMs: number): string {
  const expiry = new Date(now.valueOf() + leaseDurationMs);
  if (Number.isNaN(expiry.valueOf())) {
    throw new PersistenceError("STORAGE_FAILURE", "Lease expiry overflowed the valid time range.");
  }
  return expiry.toISOString();
}
