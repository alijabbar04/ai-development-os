/**
 * The memory store.
 *
 * Reconciliation rules, all of them deterministic under an injected clock and
 * an injected identifier source:
 *
 * - **Append is idempotent by key.** The same key with the same record returns
 *   the existing entry; the same key with a different record is a conflict,
 *   never a silent overwrite.
 * - **State changes are compare-and-set.** A caller must present the exact
 *   version it read; a stale writer loses and is told so.
 * - **Explicit beats inferred, always.** An inferred candidate can never
 *   supersede a user-stated preference. It is still recorded — as visibly
 *   unconfirmed evidence — because discarding it would lose information, but
 *   it cannot become the answer.
 * - **Missing stays missing.** Expired, revoked, and tombstoned records do not
 *   fall back to a broader scope, an older version, or a weaker guarantee.
 * - **A tombstone is a record.** It replicates, so a stale replica carrying
 *   the pre-deletion state cannot resurrect anything without an explicit,
 *   attributed conflict decision.
 * - **Unauditable changes are not made.** The audit observer runs before the
 *   write; if it fails, nothing is written.
 */

import { createHash } from "node:crypto";
import {
  compareDataClassification,
  toCanonicalJson,
  ValidationError,
  type DataClassification,
} from "@ai-dev-os/domain";
import {
  DEFAULT_MEMORY_CONFIGURATION,
  type MemoryConfiguration,
} from "./config.js";
import {
  causeCategory,
  failed,
  memoryFailure,
  ok,
  type MemoryFailure,
  type MemoryResult,
} from "./errors.js";
import {
  type ApplyOutcome,
  type CancellationSignal,
  type ConfirmationState,
  type MemoryAuditObserver,
  type MemoryClock,
  type MemoryEntry,
  type MemoryEvent,
  type MemoryEventKind,
  type MemoryIdSource,
  type MemoryStorePort,
} from "./port.js";
import {
  createMemoryRecord,
  isExpiredAt,
  parseMemoryRecord,
  MEMORY_RECORD_VARIANTS,
  type CreateMemoryRecordInput,
  type MemoryRecord,
  type MemoryRecordVariant,
} from "./record.js";
import {
  memoryScopeEquals,
  memoryScopeKey,
  parseMemoryScope,
  requireAuthorization,
  type MemoryAuthorizer,
  type MemoryOperation,
  type MemoryPurpose,
  type MemoryScope,
} from "./scope.js";

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

export interface AppendMemoryInput {
  readonly record: CreateMemoryRecordInput | MemoryRecord;
  readonly purpose: MemoryPurpose;
  readonly idempotencyKey?: string;
  /**
   * Required to append a record whose id was previously tombstoned. Deletion
   * is a decision; undoing it must be a decision too, and an attributed one.
   */
  readonly resurrection?: { readonly acknowledgeTombstone: true; readonly decidedBy: string };
  readonly signal?: CancellationSignal;
}

export interface MemoryQuery {
  readonly scope: MemoryScope;
  readonly purpose: MemoryPurpose;
  readonly variants?: readonly MemoryRecordVariant[];
  readonly subjectDigest?: string;
  readonly labels?: readonly string[];
  readonly confirmation?: readonly ConfirmationState[];
  readonly maxClassification?: DataClassification;
  readonly includeExpired?: boolean;
  readonly includeSuperseded?: boolean;
  readonly includeTombstoned?: boolean;
  readonly limit?: number;
  readonly signal?: CancellationSignal;
}

export interface MemoryQueryResult {
  readonly entries: readonly MemoryEntry[];
  readonly totalMatched: number;
  readonly truncated: boolean;
  /** Bodies were withheld because the decision did not permit disclosure. */
  readonly bodiesWithheld: boolean;
  readonly fingerprint: string;
}

export interface MemorySnapshotEntry {
  readonly recordId: string;
  readonly variant: MemoryRecordVariant;
  readonly subjectDigest: string;
  readonly authorClass: string;
  readonly classification: DataClassification;
  readonly disclosure: string;
  readonly confirmation: ConfirmationState;
  readonly version: number;
  readonly createdAt: string;
  readonly observedAt: string;
  readonly expiresAt: string | null;
  readonly supersedes: string | null;
  readonly supersededBy: string | null;
  readonly tombstonedAt: string | null;
  readonly revokedAt: string | null;
  readonly contentDigest: string;
  readonly recordFingerprint: string;
}

export interface MemorySnapshot {
  readonly scopeKey: string;
  readonly takenAt: string;
  readonly entries: readonly MemorySnapshotEntry[];
  readonly counts: Readonly<Record<MemoryRecordVariant, number>>;
  readonly truncated: boolean;
  readonly fingerprint: string;
}

export interface MemoryStore {
  readonly configuration: MemoryConfiguration;
  append(input: AppendMemoryInput): Promise<MemoryResult<MemoryEntry>>;
  read(input: {
    readonly scope: MemoryScope;
    readonly recordId: string;
    readonly purpose: MemoryPurpose;
    readonly signal?: CancellationSignal;
  }): Promise<MemoryResult<MemoryEntry>>;
  decideCandidate(input: {
    readonly scope: MemoryScope;
    readonly recordId: string;
    readonly expectedVersion: number;
    readonly decision: "confirm" | "reject";
    readonly purpose: MemoryPurpose;
    readonly signal?: CancellationSignal;
  }): Promise<MemoryResult<MemoryEntry>>;
  supersede(input: {
    readonly scope: MemoryScope;
    readonly supersededRecordId: string;
    readonly expectedVersion: number;
    readonly replacement: CreateMemoryRecordInput | MemoryRecord;
    readonly purpose: MemoryPurpose;
    readonly signal?: CancellationSignal;
  }): Promise<MemoryResult<MemoryEntry>>;
  tombstone(input: {
    readonly scope: MemoryScope;
    readonly recordId: string;
    readonly expectedVersion: number;
    readonly tombstoneRecordId: string;
    readonly purpose: MemoryPurpose;
    readonly recordedBy: string;
    readonly signal?: CancellationSignal;
  }): Promise<MemoryResult<MemoryEntry>>;
  query(query: MemoryQuery): Promise<MemoryResult<MemoryQueryResult>>;
  snapshot(input: {
    readonly scope: MemoryScope;
    readonly purpose: MemoryPurpose;
    readonly signal?: CancellationSignal;
  }): Promise<MemoryResult<MemorySnapshot>>;
  /** Resolves the effective preference for a subject; explicit always wins. */
  resolvePreference(input: {
    readonly scope: MemoryScope;
    readonly subjectDigest: string;
    readonly purpose: MemoryPurpose;
    readonly signal?: CancellationSignal;
  }): Promise<MemoryResult<{ readonly explicit: MemoryEntry | null; readonly candidates: readonly MemoryEntry[] }>>;
  events(input: {
    readonly scope: MemoryScope;
    readonly purpose: MemoryPurpose;
    readonly limit?: number;
  }): Promise<MemoryResult<readonly MemoryEvent[]>>;
  close(): Promise<void>;
}

export interface CreateMemoryStoreOptions {
  readonly port: MemoryStorePort;
  readonly authorizer: MemoryAuthorizer;
  readonly clock: MemoryClock;
  readonly idSource: MemoryIdSource;
  readonly configuration?: MemoryConfiguration;
  readonly auditObserver?: MemoryAuditObserver;
}

export function createMemoryStore(options: CreateMemoryStoreOptions): MemoryStore {
  const configuration = options.configuration ?? DEFAULT_MEMORY_CONFIGURATION;
  const { port, authorizer, clock, idSource } = options;
  let closed = false;

  function guard(signal: CancellationSignal | undefined): MemoryFailure | null {
    if (closed) {
      return memoryFailure("STORE_CLOSED", "The memory store is closed.");
    }
    if (signal?.aborted === true) {
      return memoryFailure("CANCELLED", "The operation was cancelled.");
    }
    return null;
  }

  async function authorize(
    operation: MemoryOperation,
    scope: MemoryScope,
    purpose: MemoryPurpose,
    classification: DataClassification,
    subjectDigest: string | null,
    disclosesBody: boolean,
  ): Promise<
    { readonly ok: true; readonly bodyDisclosureAllowed: boolean } | { readonly ok: false; readonly failure: MemoryFailure }
  > {
    const outcome = await requireAuthorization(authorizer, {
      operation,
      scope,
      subjectDigest,
      classification,
      purpose,
      disclosesBody,
    });
    if (!outcome.ok) {
      return outcome;
    }
    return Object.freeze({
      ok: true as const,
      bodyDisclosureAllowed: outcome.decision.bodyDisclosureAllowed,
    });
  }

  /**
   * Phase one of a two-phase authorization: may this caller touch this scope
   * at all?
   *
   * It runs *before* the record is loaded, so an unauthorized caller cannot
   * learn whether a record exists by comparing `NOT_FOUND` against a denial.
   * Because the record's classification is not known yet, the gate asks about
   * the least sensitive classification and about metadata only; phase two
   * re-authorizes against the record's actual classification once it is in
   * hand, and that is the check that governs body disclosure.
   */
  async function scopeGate(
    operation: MemoryOperation,
    scope: MemoryScope,
    purpose: MemoryPurpose,
  ): Promise<MemoryFailure | null> {
    const gate = await authorize(operation, scope, purpose, "public", null, false);
    return gate.ok ? null : gate.failure;
  }

  /**
   * Notifies the observer and then applies. A throwing observer means the
   * change cannot be audited, so it is not made at all.
   */
  async function applyChange(
    scopeKey: string,
    entry: MemoryEntry,
    expectedVersion: number | null,
    kind: MemoryEventKind,
  ): Promise<{ readonly outcome: ApplyOutcome } | { readonly failure: MemoryFailure }> {
    const event: Omit<MemoryEvent, "sequence"> = Object.freeze({
      eventId: idSource.next("event"),
      scopeKey,
      recordId: entry.record.recordId,
      kind,
      occurredAt: entry.updatedAt,
      recordFingerprint: entry.record.fingerprint,
      version: entry.version,
    });
    if (options.auditObserver !== undefined) {
      try {
        options.auditObserver(event);
      } catch (error) {
        return Object.freeze({
          failure: memoryFailure(
            "AUDIT_FAILURE",
            "The change was refused because it could not be audited.",
            { kind, cause: causeCategory(error) },
          ),
        });
      }
    }
    try {
      return Object.freeze({ outcome: await port.apply({ scopeKey, entry, expectedVersion, event }) });
    } catch (error) {
      return Object.freeze({
        failure: memoryFailure("STORE_FAILURE", "The memory store adapter failed.", {
          operation: "apply",
          cause: causeCategory(error),
        }),
      });
    }
  }

  function buildRecord(
    input: CreateMemoryRecordInput | MemoryRecord,
    scope: MemoryScope,
    now: Date,
  ): { readonly record: MemoryRecord } | { readonly failure: MemoryFailure } {
    try {
      const record =
        "fingerprint" in input && typeof input.fingerprint === "string"
          ? parseMemoryRecord(input)
          : createMemoryRecord(applyCandidateExpiry(input as CreateMemoryRecordInput, now));
      if (!memoryScopeEquals(record.scope, scope)) {
        return Object.freeze({
          failure: memoryFailure("SCOPE_MISMATCH", "The record scope does not match the request scope."),
        });
      }
      if (record.body.kind === "text" && record.body.text.length > configuration.limits.maxBodyTextLength) {
        return Object.freeze({
          failure: memoryFailure("LIMIT_EXCEEDED", "The record body exceeds the configured bound.", {
            maxBodyTextLength: configuration.limits.maxBodyTextLength,
          }),
        });
      }
      if (
        record.variant === "inferred-preference-candidate" &&
        configuration.requireExpiryForInferredCandidates &&
        record.expiresAt === null
      ) {
        return Object.freeze({
          failure: memoryFailure("INVALID_RECORD", "An inferred candidate must carry an expiry."),
        });
      }
      return Object.freeze({ record });
    } catch (error) {
      if (error instanceof ValidationError) {
        const secretIssue = error.issues.some(
          (issue) => issue.code === "secret_material" || issue.code === "secret_in_display",
        );
        return Object.freeze({
          failure: memoryFailure(
            secretIssue ? "SECRET_MATERIAL_REJECTED" : "INVALID_RECORD",
            secretIssue
              ? "The record body resembles authentication material and was refused."
              : "The record is invalid.",
            {
              issueCount: error.issues.length,
              issueCodes: Object.freeze([...new Set(error.issues.map((issue) => issue.code))].sort()),
            },
          ),
        });
      }
      return Object.freeze({
        failure: memoryFailure("INVALID_RECORD", "The record could not be built.", {
          cause: causeCategory(error),
        }),
      });
    }
  }

  function applyCandidateExpiry(
    input: CreateMemoryRecordInput,
    now: Date,
  ): CreateMemoryRecordInput {
    if (
      input.variant !== "inferred-preference-candidate" ||
      (input.expiresAt !== undefined && input.expiresAt !== null) ||
      configuration.inferredCandidateTtlMs === null
    ) {
      return input;
    }
    const base = new Date(input.observedAt ?? input.createdAt).valueOf();
    const anchor = Number.isNaN(base) ? now.valueOf() : base;
    return {
      ...input,
      expiresAt: new Date(anchor + configuration.inferredCandidateTtlMs).toISOString(),
    };
  }

  function initialConfirmation(record: MemoryRecord): ConfirmationState {
    return record.variant === "inferred-preference-candidate" ? "unconfirmed" : "not-applicable";
  }

  async function loadEntry(
    scopeKey: string,
    scope: MemoryScope,
    recordId: string,
  ): Promise<{ readonly entry: MemoryEntry } | { readonly failure: MemoryFailure }> {
    let entry: MemoryEntry | null;
    try {
      entry = await port.get(scopeKey, recordId);
    } catch (error) {
      return Object.freeze({
        failure: memoryFailure("STORE_FAILURE", "The memory store adapter failed.", {
          operation: "get",
          cause: causeCategory(error),
        }),
      });
    }
    if (entry === null) {
      return Object.freeze({ failure: memoryFailure("NOT_FOUND", "No such memory record in this scope.") });
    }
    // Defence in depth: the key already isolates scopes, and this catches an
    // adapter that returns the wrong bucket.
    if (!memoryScopeEquals(entry.record.scope, scope)) {
      return Object.freeze({
        failure: memoryFailure("SCOPE_MISMATCH", "The stored record belongs to another scope."),
      });
    }
    return Object.freeze({ entry });
  }

  async function listEntries(
    scopeKey: string,
    scope: MemoryScope,
  ): Promise<{ readonly entries: readonly MemoryEntry[] } | { readonly failure: MemoryFailure }> {
    let entries: readonly MemoryEntry[];
    try {
      entries = await port.list(scopeKey);
    } catch (error) {
      return Object.freeze({
        failure: memoryFailure("STORE_FAILURE", "The memory store adapter failed.", {
          operation: "list",
          cause: causeCategory(error),
        }),
      });
    }
    const foreign = entries.filter((entry) => !memoryScopeEquals(entry.record.scope, scope));
    if (foreign.length > 0) {
      return Object.freeze({
        failure: memoryFailure("SCOPE_MISMATCH", "The store returned records from another scope.", {
          foreignCount: foreign.length,
        }),
      });
    }
    return Object.freeze({ entries });
  }

  function withheldBody(entry: MemoryEntry): MemoryEntry {
    if (entry.record.body.kind === "withheld") {
      return entry;
    }
    // The record's own fingerprint is preserved so a caller can still verify
    // which record this is; only the body is replaced.
    return Object.freeze({
      ...entry,
      record: Object.freeze({
        ...entry.record,
        body: Object.freeze({ kind: "withheld" as const, reason: "unauthorized" as const }),
      }),
    });
  }

  const store: MemoryStore = {
    configuration,

    async append(input: AppendMemoryInput): Promise<MemoryResult<MemoryEntry>> {
      const blocked = guard(input.signal);
      if (blocked !== null) {
        return failed(blocked);
      }
      let scope: MemoryScope;
      try {
        scope = parseMemoryScope(
          "scope" in input.record ? input.record.scope : undefined,
          "record.scope",
        );
      } catch {
        return failed(memoryFailure("INVALID_RECORD", "The record scope is invalid."));
      }
      const now = clock.now();
      const built = buildRecord(input.record, scope, now);
      if ("failure" in built) {
        return failed(built.failure);
      }
      const record = built.record;
      const scopeKey = memoryScopeKey(scope);

      const decision = await authorize(
        "append",
        scope,
        input.purpose,
        record.classification,
        record.subject.digest,
        true,
      );
      if (!decision.ok) {
        return failed(decision.failure);
      }

      if (input.idempotencyKey !== undefined) {
        let existing: MemoryEntry | null;
        try {
          existing = await port.findByIdempotencyKey(scopeKey, input.idempotencyKey);
        } catch (error) {
          return failed(
            memoryFailure("STORE_FAILURE", "The memory store adapter failed.", {
              operation: "findByIdempotencyKey",
              cause: causeCategory(error),
            }),
          );
        }
        if (existing !== null) {
          return existing.record.fingerprint === record.fingerprint
            ? ok(existing)
            : failed(
                memoryFailure(
                  "IDEMPOTENCY_CONFLICT",
                  "The idempotency key was already used for a different record.",
                ),
              );
        }
      }

      const prior = await port.get(scopeKey, record.recordId).catch(() => undefined);
      if (prior === undefined) {
        return failed(
          memoryFailure("STORE_FAILURE", "The memory store adapter failed.", { operation: "get" }),
        );
      }
      if (prior !== null) {
        if (prior.tombstonedAt !== null && input.resurrection === undefined) {
          return failed(
            memoryFailure(
              "TOMBSTONED",
              "This record was deleted; resurrecting it requires an explicit conflict decision.",
              { recordId: record.recordId },
            ),
          );
        }
        if (prior.tombstonedAt === null) {
          return failed(
            memoryFailure("VERSION_CONFLICT", "A record with this identifier already exists.", {
              recordId: record.recordId,
            }),
          );
        }
      }

      const precedence = await checkPrecedence(scopeKey, scope, record);
      if (precedence !== null) {
        return failed(precedence);
      }

      const overCapacity = await capacityExceeded(scopeKey, scope);
      if (overCapacity !== null) {
        return failed(overCapacity);
      }

      const entry: MemoryEntry = Object.freeze({
        record,
        version: prior === null ? 1 : prior.version + 1,
        confirmation: initialConfirmation(record),
        supersededBy: null,
        tombstonedAt: null,
        revokedAt: null,
        idempotencyKey: input.idempotencyKey ?? null,
        updatedAt: now.toISOString(),
      });

      const applied = await applyChange(
        scopeKey,
        entry,
        prior === null ? null : prior.version,
        "appended",
      );
      if ("failure" in applied) {
        return failed(applied.failure);
      }
      if (applied.outcome !== "applied") {
        return failed(
          memoryFailure("VERSION_CONFLICT", "A concurrent writer changed this record.", {
            outcome: applied.outcome,
          }),
        );
      }

      if (record.supersedes !== null) {
        const marked = await markSuperseded(scopeKey, scope, record.supersedes, record.recordId, now);
        if (marked !== null) {
          return failed(marked);
        }
      }
      return ok(entry);
    },

    async read(input): Promise<MemoryResult<MemoryEntry>> {
      const blocked = guard(input.signal);
      if (blocked !== null) {
        return failed(blocked);
      }
      const scope = parseMemoryScope(input.scope);
      const scopeKey = memoryScopeKey(scope);
      const gate = await scopeGate("read", scope, input.purpose);
      if (gate !== null) {
        return failed(gate);
      }
      const loaded = await loadEntry(scopeKey, scope, input.recordId);
      if ("failure" in loaded) {
        return failed(loaded.failure);
      }
      const entry = loaded.entry;
      const decision = await authorize(
        "read",
        scope,
        input.purpose,
        entry.record.classification,
        entry.record.subject.digest,
        true,
      );
      if (!decision.ok) {
        return failed(decision.failure);
      }
      if (entry.tombstonedAt !== null) {
        return failed(memoryFailure("TOMBSTONED", "This record was deleted."));
      }
      if (entry.revokedAt !== null) {
        return failed(memoryFailure("REVOKED", "This record was revoked."));
      }
      if (isExpiredAt(entry.record, clock.now())) {
        return failed(memoryFailure("EXPIRED", "This record has expired."));
      }
      return ok(decision.bodyDisclosureAllowed ? entry : withheldBody(entry));
    },

    async decideCandidate(input): Promise<MemoryResult<MemoryEntry>> {
      const blocked = guard(input.signal);
      if (blocked !== null) {
        return failed(blocked);
      }
      const scope = parseMemoryScope(input.scope);
      const scopeKey = memoryScopeKey(scope);
      const gate = await scopeGate("confirm", scope, input.purpose);
      if (gate !== null) {
        return failed(gate);
      }
      const loaded = await loadEntry(scopeKey, scope, input.recordId);
      if ("failure" in loaded) {
        return failed(loaded.failure);
      }
      const entry = loaded.entry;
      const decision = await authorize(
        "confirm",
        scope,
        input.purpose,
        entry.record.classification,
        entry.record.subject.digest,
        false,
      );
      if (!decision.ok) {
        return failed(decision.failure);
      }
      if (entry.record.variant !== "inferred-preference-candidate") {
        return failed(
          memoryFailure("PRECEDENCE_VIOLATION", "Only an inferred candidate can be confirmed or rejected.", {
            variant: entry.record.variant,
          }),
        );
      }
      if (entry.tombstonedAt !== null) {
        return failed(memoryFailure("TOMBSTONED", "This record was deleted."));
      }
      if (entry.version !== input.expectedVersion) {
        return failed(
          memoryFailure("VERSION_CONFLICT", "The record changed since it was read.", {
            expected: input.expectedVersion,
            actual: entry.version,
          }),
        );
      }
      if (entry.confirmation !== "unconfirmed") {
        return failed(
          memoryFailure("VERSION_CONFLICT", "This candidate has already been decided.", {
            confirmation: entry.confirmation,
          }),
        );
      }
      const next: MemoryEntry = Object.freeze({
        ...entry,
        version: entry.version + 1,
        confirmation: input.decision === "confirm" ? "confirmed" : "rejected",
        updatedAt: clock.now().toISOString(),
      });
      const applied = await applyChange(
        scopeKey,
        next,
        entry.version,
        input.decision === "confirm" ? "confirmed" : "rejected",
      );
      if ("failure" in applied) {
        return failed(applied.failure);
      }
      if (applied.outcome !== "applied") {
        return failed(
          memoryFailure("VERSION_CONFLICT", "A concurrent writer changed this record.", {
            outcome: applied.outcome,
          }),
        );
      }
      return ok(next);
    },

    async supersede(input): Promise<MemoryResult<MemoryEntry>> {
      const blocked = guard(input.signal);
      if (blocked !== null) {
        return failed(blocked);
      }
      const scope = parseMemoryScope(input.scope);
      const scopeKey = memoryScopeKey(scope);
      const gate = await scopeGate("supersede", scope, input.purpose);
      if (gate !== null) {
        return failed(gate);
      }
      const loaded = await loadEntry(scopeKey, scope, input.supersededRecordId);
      if ("failure" in loaded) {
        return failed(loaded.failure);
      }
      const target = loaded.entry;
      if (target.version !== input.expectedVersion) {
        return failed(
          memoryFailure("VERSION_CONFLICT", "The superseded record changed since it was read.", {
            expected: input.expectedVersion,
            actual: target.version,
          }),
        );
      }
      if (target.tombstonedAt !== null) {
        return failed(memoryFailure("TOMBSTONED", "A deleted record cannot be superseded."));
      }
      if (target.supersededBy !== null) {
        return failed(
          memoryFailure("VERSION_CONFLICT", "This record was already superseded.", {
            supersededBy: target.supersededBy,
          }),
        );
      }
      const depth = await supersessionDepth(scopeKey, target.record.recordId);
      if (depth >= configuration.limits.maxSupersessionChainDepth) {
        return failed(
          memoryFailure("LIMIT_EXCEEDED", "The supersession chain is too deep.", {
            maxSupersessionChainDepth: configuration.limits.maxSupersessionChainDepth,
          }),
        );
      }
      const replacement =
        "fingerprint" in input.replacement && typeof input.replacement.fingerprint === "string"
          ? input.replacement
          : { ...(input.replacement as CreateMemoryRecordInput), supersedes: input.supersededRecordId };
      const appended = await store.append({
        record: replacement,
        purpose: input.purpose,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      return appended;
    },

    async tombstone(input): Promise<MemoryResult<MemoryEntry>> {
      const blocked = guard(input.signal);
      if (blocked !== null) {
        return failed(blocked);
      }
      const scope = parseMemoryScope(input.scope);
      const scopeKey = memoryScopeKey(scope);
      const gate = await scopeGate("tombstone", scope, input.purpose);
      if (gate !== null) {
        return failed(gate);
      }
      const loaded = await loadEntry(scopeKey, scope, input.recordId);
      if ("failure" in loaded) {
        return failed(loaded.failure);
      }
      const target = loaded.entry;
      const decision = await authorize(
        "tombstone",
        scope,
        input.purpose,
        target.record.classification,
        target.record.subject.digest,
        false,
      );
      if (!decision.ok) {
        return failed(decision.failure);
      }
      if (target.version !== input.expectedVersion) {
        return failed(
          memoryFailure("VERSION_CONFLICT", "The record changed since it was read.", {
            expected: input.expectedVersion,
            actual: target.version,
          }),
        );
      }
      if (target.tombstonedAt !== null) {
        return failed(memoryFailure("TOMBSTONED", "This record was already deleted."));
      }
      const now = clock.now();
      const marker = buildRecord(
        {
          recordId: input.tombstoneRecordId,
          variant: "tombstone",
          scope,
          subject: target.record.subject,
          authorClass: "user-explicit",
          provenance: Object.freeze({
            captureMethod: "system" as const,
            sources: Object.freeze([]),
            recordedBy: input.recordedBy,
          }),
          body: Object.freeze({ kind: "withheld" as const, reason: "tombstoned" as const }),
          classification: target.record.classification,
          disclosure: target.record.disclosure,
          createdAt: now.toISOString(),
          tombstoneOf: input.recordId,
        },
        scope,
        now,
      );
      if ("failure" in marker) {
        return failed(marker.failure);
      }

      // The marker is written first: a replica that receives only part of this
      // pair must end up with the tombstone, never with a live record whose
      // deletion was lost.
      const markerEntry: MemoryEntry = Object.freeze({
        record: marker.record,
        version: 1,
        confirmation: "not-applicable",
        supersededBy: null,
        tombstonedAt: null,
        revokedAt: null,
        idempotencyKey: null,
        updatedAt: now.toISOString(),
      });
      const markerApplied = await applyChange(scopeKey, markerEntry, null, "tombstoned");
      if ("failure" in markerApplied) {
        return failed(markerApplied.failure);
      }
      if (markerApplied.outcome !== "applied") {
        return failed(
          memoryFailure("VERSION_CONFLICT", "A tombstone with this identifier already exists.", {
            outcome: markerApplied.outcome,
          }),
        );
      }

      const next: MemoryEntry = Object.freeze({
        ...target,
        record: Object.freeze({
          ...target.record,
          body: Object.freeze({ kind: "withheld" as const, reason: "tombstoned" as const }),
        }),
        version: target.version + 1,
        tombstonedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      const applied = await applyChange(scopeKey, next, target.version, "tombstoned");
      if ("failure" in applied) {
        return failed(applied.failure);
      }
      if (applied.outcome !== "applied") {
        return failed(
          memoryFailure("VERSION_CONFLICT", "A concurrent writer changed this record.", {
            outcome: applied.outcome,
          }),
        );
      }
      return ok(next);
    },

    async query(query: MemoryQuery): Promise<MemoryResult<MemoryQueryResult>> {
      const blocked = guard(query.signal);
      if (blocked !== null) {
        return failed(blocked);
      }
      const limit = query.limit ?? configuration.limits.maxQueryResults;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > configuration.limits.maxQueryResults) {
        return failed(memoryFailure("INVALID_QUERY", "The query limit is out of range."));
      }
      if (
        query.variants !== undefined &&
        query.variants.some((variant) => !MEMORY_RECORD_VARIANTS.includes(variant))
      ) {
        return failed(memoryFailure("INVALID_QUERY", "The query names an unknown record variant."));
      }
      const scope = parseMemoryScope(query.scope);
      const scopeKey = memoryScopeKey(scope);
      const decision = await authorize(
        "query",
        scope,
        query.purpose,
        query.maxClassification ?? "secret",
        query.subjectDigest ?? null,
        true,
      );
      if (!decision.ok) {
        return failed(decision.failure);
      }
      const listed = await listEntries(scopeKey, scope);
      if ("failure" in listed) {
        return failed(listed.failure);
      }
      const now = clock.now();
      const variants = query.variants === undefined ? null : new Set(query.variants);
      const confirmations = query.confirmation === undefined ? null : new Set(query.confirmation);
      const labels = query.labels ?? [];

      const matched = listed.entries.filter((entry) => {
        const record = entry.record;
        if (variants !== null && !variants.has(record.variant)) {
          return false;
        }
        if (query.subjectDigest !== undefined && record.subject.digest !== query.subjectDigest) {
          return false;
        }
        if (labels.length > 0 && !labels.every((label) => record.labels.includes(label))) {
          return false;
        }
        if (confirmations !== null && !confirmations.has(entry.confirmation)) {
          return false;
        }
        if (
          query.maxClassification !== undefined &&
          compareDataClassification(record.classification, query.maxClassification) > 0
        ) {
          return false;
        }
        if (entry.tombstonedAt !== null && query.includeTombstoned !== true) {
          return false;
        }
        if (entry.revokedAt !== null) {
          return false;
        }
        if (entry.supersededBy !== null && query.includeSuperseded !== true) {
          return false;
        }
        if (isExpiredAt(record, now) && query.includeExpired !== true) {
          return false;
        }
        return true;
      });

      const sorted = [...matched].sort((a, b) => compare(a.record.recordId, b.record.recordId));
      const limited = sorted.slice(0, limit);
      const projected = decision.bodyDisclosureAllowed ? limited : limited.map(withheldBody);
      return ok(
        Object.freeze({
          entries: Object.freeze(projected),
          totalMatched: sorted.length,
          truncated: sorted.length > limited.length,
          bodiesWithheld: !decision.bodyDisclosureAllowed,
          fingerprint: createHash("sha256")
            .update(
              toCanonicalJson(projected.map((entry) => entry.record.fingerprint), "queryResult"),
              "utf8",
            )
            .digest("hex"),
        }),
      );
    },

    async snapshot(input): Promise<MemoryResult<MemorySnapshot>> {
      const blocked = guard(input.signal);
      if (blocked !== null) {
        return failed(blocked);
      }
      const scope = parseMemoryScope(input.scope);
      const scopeKey = memoryScopeKey(scope);
      // A snapshot is metadata only, so it asks for metadata authorization and
      // never for body disclosure. Bodies simply are not in the result type.
      const decision = await authorize("snapshot", scope, input.purpose, "internal", null, false);
      if (!decision.ok) {
        return failed(decision.failure);
      }
      const listed = await listEntries(scopeKey, scope);
      if ("failure" in listed) {
        return failed(listed.failure);
      }
      const sorted = [...listed.entries].sort((a, b) => compare(a.record.recordId, b.record.recordId));
      const truncated = sorted.length > configuration.limits.maxSnapshotRecords;
      const bounded = sorted.slice(0, configuration.limits.maxSnapshotRecords);
      const counts: Record<string, number> = {};
      for (const variant of MEMORY_RECORD_VARIANTS) {
        counts[variant] = 0;
      }
      const entries = bounded.map((entry) => {
        counts[entry.record.variant] = (counts[entry.record.variant] ?? 0) + 1;
        return Object.freeze({
          recordId: entry.record.recordId,
          variant: entry.record.variant,
          subjectDigest: entry.record.subject.digest,
          authorClass: entry.record.authorClass,
          classification: entry.record.classification,
          disclosure: entry.record.disclosure,
          confirmation: entry.confirmation,
          version: entry.version,
          createdAt: entry.record.createdAt,
          observedAt: entry.record.observedAt,
          expiresAt: entry.record.expiresAt,
          supersedes: entry.record.supersedes,
          supersededBy: entry.supersededBy,
          tombstonedAt: entry.tombstonedAt,
          revokedAt: entry.revokedAt,
          contentDigest: entry.record.contentDigest,
          recordFingerprint: entry.record.fingerprint,
        });
      });
      const snapshot = {
        scopeKey,
        takenAt: clock.now().toISOString(),
        entries: Object.freeze(entries),
        counts: Object.freeze(counts) as Readonly<Record<MemoryRecordVariant, number>>,
        truncated,
      };
      return ok(
        Object.freeze({
          ...snapshot,
          // Excludes `takenAt`: two snapshots of the same state agree.
          fingerprint: createHash("sha256")
            .update(
              toCanonicalJson(
                { scopeKey, entries: snapshot.entries, counts: snapshot.counts, truncated },
                "memorySnapshot",
              ),
              "utf8",
            )
            .digest("hex"),
        }),
      );
    },

    async resolvePreference(input): Promise<
      MemoryResult<{ readonly explicit: MemoryEntry | null; readonly candidates: readonly MemoryEntry[] }>
    > {
      const result = await store.query({
        scope: input.scope,
        purpose: input.purpose,
        subjectDigest: input.subjectDigest,
        variants: ["explicit-preference", "inferred-preference-candidate"],
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (!result.ok) {
        return failed(result.failure);
      }
      const explicit =
        result.value.entries.find((entry) => entry.record.variant === "explicit-preference") ?? null;
      const candidates = Object.freeze(
        result.value.entries.filter(
          (entry) => entry.record.variant === "inferred-preference-candidate",
        ),
      );
      return ok(Object.freeze({ explicit, candidates }));
    },

    async events(input): Promise<MemoryResult<readonly MemoryEvent[]>> {
      if (closed) {
        return failed(memoryFailure("STORE_CLOSED", "The memory store is closed."));
      }
      const scope = parseMemoryScope(input.scope);
      const decision = await authorize("snapshot", scope, input.purpose, "internal", null, false);
      if (!decision.ok) {
        return failed(decision.failure);
      }
      const limit = Math.min(input.limit ?? configuration.limits.maxEventsReturned, configuration.limits.maxEventsReturned);
      try {
        return ok(await port.listEvents(memoryScopeKey(scope), limit));
      } catch (error) {
        return failed(
          memoryFailure("STORE_FAILURE", "The memory store adapter failed.", {
            operation: "listEvents",
            cause: causeCategory(error),
          }),
        );
      }
    },

    async close(): Promise<void> {
      closed = true;
      await port.close();
    },
  };

  /**
   * An inferred candidate may never displace a user-stated preference on the
   * same subject. It is still stored, visibly unconfirmed, because throwing
   * evidence away is its own failure mode.
   */
  async function checkPrecedence(
    scopeKey: string,
    scope: MemoryScope,
    record: MemoryRecord,
  ): Promise<MemoryFailure | null> {
    if (record.variant !== "inferred-preference-candidate" || record.supersedes === null) {
      return null;
    }
    const loaded = await loadEntry(scopeKey, scope, record.supersedes);
    if ("failure" in loaded) {
      return loaded.failure;
    }
    if (loaded.entry.record.variant === "explicit-preference") {
      return memoryFailure(
        "PRECEDENCE_VIOLATION",
        "An inferred candidate cannot supersede an explicit user preference.",
        { supersedes: record.supersedes },
      );
    }
    return null;
  }

  async function capacityExceeded(
    scopeKey: string,
    scope: MemoryScope,
  ): Promise<MemoryFailure | null> {
    const listed = await listEntries(scopeKey, scope);
    if ("failure" in listed) {
      return listed.failure;
    }
    if (listed.entries.length >= configuration.limits.maxRecordsPerScope) {
      return memoryFailure("LIMIT_EXCEEDED", "The scope holds the maximum number of records.", {
        maxRecordsPerScope: configuration.limits.maxRecordsPerScope,
      });
    }
    return null;
  }

  async function markSuperseded(
    scopeKey: string,
    scope: MemoryScope,
    supersededId: string,
    replacementId: string,
    now: Date,
  ): Promise<MemoryFailure | null> {
    const loaded = await loadEntry(scopeKey, scope, supersededId);
    if ("failure" in loaded) {
      return loaded.failure;
    }
    const target = loaded.entry;
    if (target.supersededBy !== null) {
      return memoryFailure("VERSION_CONFLICT", "The superseded record was already superseded.", {
        supersededBy: target.supersededBy,
      });
    }
    const next: MemoryEntry = Object.freeze({
      ...target,
      version: target.version + 1,
      supersededBy: replacementId,
      updatedAt: now.toISOString(),
    });
    const applied = await applyChange(scopeKey, next, target.version, "superseded");
    if ("failure" in applied) {
      return applied.failure;
    }
    if (applied.outcome !== "applied") {
      return memoryFailure("VERSION_CONFLICT", "A concurrent writer changed the superseded record.", {
        outcome: applied.outcome,
      });
    }
    return null;
  }

  async function supersessionDepth(scopeKey: string, recordId: string): Promise<number> {
    let depth = 0;
    let current: string | null = recordId;
    const seen = new Set<string>();
    while (current !== null && depth < configuration.limits.maxSupersessionChainDepth + 1) {
      if (seen.has(current)) {
        return configuration.limits.maxSupersessionChainDepth;
      }
      seen.add(current);
      const entry: MemoryEntry | null = await port.get(scopeKey, current).catch(() => null);
      current = entry?.record.supersedes ?? null;
      depth += 1;
    }
    return depth;
  }

  return Object.freeze(store);
}

/* ------------------------------------------------------------------ *
 * Free-function facade
 * ------------------------------------------------------------------ */

export function appendMemoryRecord(
  store: MemoryStore,
  input: AppendMemoryInput,
): Promise<MemoryResult<MemoryEntry>> {
  return store.append(input);
}

export function confirmMemoryCandidate(
  store: MemoryStore,
  input: {
    readonly scope: MemoryScope;
    readonly recordId: string;
    readonly expectedVersion: number;
    readonly purpose: MemoryPurpose;
  },
): Promise<MemoryResult<MemoryEntry>> {
  return store.decideCandidate({ ...input, decision: "confirm" });
}

export function rejectMemoryCandidate(
  store: MemoryStore,
  input: {
    readonly scope: MemoryScope;
    readonly recordId: string;
    readonly expectedVersion: number;
    readonly purpose: MemoryPurpose;
  },
): Promise<MemoryResult<MemoryEntry>> {
  return store.decideCandidate({ ...input, decision: "reject" });
}

export function supersedeMemoryRecord(
  store: MemoryStore,
  input: Parameters<MemoryStore["supersede"]>[0],
): Promise<MemoryResult<MemoryEntry>> {
  return store.supersede(input);
}

export function tombstoneMemoryRecord(
  store: MemoryStore,
  input: Parameters<MemoryStore["tombstone"]>[0],
): Promise<MemoryResult<MemoryEntry>> {
  return store.tombstone(input);
}

export function queryMemory(
  store: MemoryStore,
  query: MemoryQuery,
): Promise<MemoryResult<MemoryQueryResult>> {
  return store.query(query);
}

export function memorySnapshot(
  store: MemoryStore,
  input: Parameters<MemoryStore["snapshot"]>[0],
): Promise<MemoryResult<MemorySnapshot>> {
  return store.snapshot(input);
}
