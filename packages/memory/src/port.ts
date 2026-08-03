/**
 * The durable port.
 *
 * Deliberately provider-neutral: no SQL, no schema, no adapter-specific
 * options. A Stage 3 persistence adapter can implement it, and the in-memory
 * reference adapter in this package implements it exactly, which is what makes
 * the contract suite meaningful.
 *
 * The single mutating operation is `apply`, which writes an entry and its
 * journal event **atomically**. That is not a convenience: if the state could
 * advance without its audit event, or the reverse, the store would be able to
 * lose provenance silently. Adapters that cannot offer atomicity across those
 * two writes cannot implement this port honestly.
 */

import { validation } from "@ai-dev-os/domain";
import { parseMemoryRecord, type MemoryRecord } from "./record.js";

const {
  ensureEnum,
  ensureExactKeys,
  ensureNullable,
  ensureRecord,
  ensureSafeInteger,
  ensureString,
  ensureTimestamp,
} = validation;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const CONFIRMATION_STATES = Object.freeze([
  "not-applicable",
  "unconfirmed",
  "confirmed",
  "rejected",
] as const);

export type ConfirmationState = (typeof CONFIRMATION_STATES)[number];

/**
 * A record plus everything that can change about it after it was asserted.
 * The record itself is never rewritten.
 */
export interface MemoryEntry {
  readonly record: MemoryRecord;
  /** Starts at 1 and increments on every state transition. */
  readonly version: number;
  readonly confirmation: ConfirmationState;
  readonly supersededBy: string | null;
  readonly tombstonedAt: string | null;
  readonly revokedAt: string | null;
  readonly idempotencyKey: string | null;
  readonly updatedAt: string;
}

export const MEMORY_EVENT_KINDS = Object.freeze([
  "appended",
  "confirmed",
  "rejected",
  "superseded",
  "tombstoned",
  "revoked",
] as const);

export type MemoryEventKind = (typeof MEMORY_EVENT_KINDS)[number];

/**
 * An append-only audit event. It carries identifiers, fingerprints, and
 * timing — never a subject, a body, or a label, so the journal can be read by
 * a caller who is not authorized to see the records themselves.
 */
export interface MemoryEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly scopeKey: string;
  readonly recordId: string;
  readonly kind: MemoryEventKind;
  readonly occurredAt: string;
  readonly recordFingerprint: string;
  readonly version: number;
}

export interface MemoryApplyCommand {
  readonly scopeKey: string;
  readonly entry: MemoryEntry;
  /** `null` requires the record to be absent; a number requires that exact version. */
  readonly expectedVersion: number | null;
  readonly event: Omit<MemoryEvent, "sequence">;
}

export const APPLY_OUTCOMES = Object.freeze([
  "applied",
  "already-exists",
  "version-conflict",
  "missing",
] as const);

export type ApplyOutcome = (typeof APPLY_OUTCOMES)[number];

export interface MemoryStorePort {
  get(scopeKey: string, recordId: string): Promise<MemoryEntry | null>;
  /** Deterministic order: record id ascending. Never crosses scopes. */
  list(scopeKey: string): Promise<readonly MemoryEntry[]>;
  findByIdempotencyKey(scopeKey: string, key: string): Promise<MemoryEntry | null>;
  /** Atomically writes the entry and its event, subject to `expectedVersion`. */
  apply(command: MemoryApplyCommand): Promise<ApplyOutcome>;
  listEvents(scopeKey: string, limit: number): Promise<readonly MemoryEvent[]>;
  close(): Promise<void>;
}

/** Injectable time source; the store never reads the system clock. */
export interface MemoryClock {
  now(): Date;
}

/** Injectable identifier source; the store never generates randomness. */
export interface MemoryIdSource {
  next(purpose: "event"): string;
}

export interface CancellationSignal {
  readonly aborted: boolean;
}

/**
 * Notified before a mutation is applied. A throwing observer refuses the
 * mutation: an unauditable change is not made at all. The observer is called
 * once, before the write, so audit and state can never disagree.
 */
export type MemoryAuditObserver = (event: Omit<MemoryEvent, "sequence">) => void;

export function parseMemoryEntry(value: unknown, path = "memoryEntry"): MemoryEntry {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "record",
      "version",
      "confirmation",
      "supersededBy",
      "tombstonedAt",
      "revokedAt",
      "idempotencyKey",
      "updatedAt",
    ],
    path,
  );
  return Object.freeze({
    record: parseMemoryRecord(record["record"], `${path}.record`),
    version: ensureSafeInteger(record["version"], `${path}.version`, 1, 1_000_000_000),
    confirmation: ensureEnum(record["confirmation"], `${path}.confirmation`, CONFIRMATION_STATES),
    supersededBy: ensureNullable(record["supersededBy"], (raw) =>
      ensureString(raw, `${path}.supersededBy`, {
        maxLength: 128,
        pattern: ID_PATTERN,
        patternName: "record id",
      }),
    ),
    tombstonedAt: ensureNullable(record["tombstonedAt"], (raw) =>
      ensureTimestamp(raw, `${path}.tombstonedAt`),
    ),
    revokedAt: ensureNullable(record["revokedAt"], (raw) => ensureTimestamp(raw, `${path}.revokedAt`)),
    idempotencyKey: ensureNullable(record["idempotencyKey"], (raw) =>
      ensureString(raw, `${path}.idempotencyKey`, {
        maxLength: 128,
        pattern: ID_PATTERN,
        patternName: "idempotency key",
      }),
    ),
    updatedAt: ensureTimestamp(record["updatedAt"], `${path}.updatedAt`),
  });
}
