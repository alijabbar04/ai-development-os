/**
 * Direct exercise of the port contract and of the free-function facade.
 *
 * The store-level tests drive the port through happy paths; these drive the
 * outcomes a durable adapter has to get right under contention — a duplicate
 * create, a stale compare-and-set, an update to something that is gone — plus
 * the leak-safety of the error and entry types themselves.
 */

import { describe, expect, it } from "vitest";
import { ValidationError } from "@ai-dev-os/domain";
import { MemoryError, causeCategory } from "../src/errors.js";
import {
  createInMemoryMemoryStore,
  storeFailure,
  withInjectedFailure,
} from "../src/in-memory-port.js";
import { parseMemoryEntry, type MemoryApplyCommand, type MemoryEntry } from "../src/port.js";
import { createMemoryRecord } from "../src/record.js";
import {
  appendMemoryRecord,
  confirmMemoryCandidate,
  createMemoryStore,
  memorySnapshot,
  queryMemory,
  rejectMemoryCandidate,
  supersedeMemoryRecord,
  tombstoneMemoryRecord,
  type MemoryStore,
} from "../src/store.js";
import { createScopedAuthorizer, memoryScopeKey } from "../src/scope.js";
import { DEFAULT_MEMORY_CONFIGURATION, withMemoryOverrides } from "../src/config.js";
import type { MemoryResult } from "../src/errors.js";
import {
  createCountingIdSource,
  createManualMemoryClock,
  explicitPreference,
  inferredCandidate,
  MEMORY_EPOCH,
  OTHER_ORG_SCOPE,
  USER_SCOPE,
  verifiedFact,
} from "../src/testing/fixtures.js";

function unwrap<T>(result: MemoryResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected success: ${result.failure.code}`);
  }
  return result.value;
}

function code<T>(result: MemoryResult<T>): string {
  if (result.ok) {
    throw new Error("expected failure");
  }
  return result.failure.code;
}

function entryFor(recordId: string, version = 1): MemoryEntry {
  return Object.freeze({
    record: createMemoryRecord(
      verifiedFact({ recordId, subject: "Build", text: "npm run check" }),
    ),
    version,
    confirmation: "not-applicable" as const,
    supersededBy: null,
    tombstonedAt: null,
    revokedAt: null,
    idempotencyKey: null,
    updatedAt: MEMORY_EPOCH,
  });
}

function commandFor(entry: MemoryEntry, expectedVersion: number | null): MemoryApplyCommand {
  return {
    scopeKey: memoryScopeKey(USER_SCOPE),
    entry,
    expectedVersion,
    event: {
      eventId: `ev-${entry.record.recordId}-${entry.version}`,
      scopeKey: memoryScopeKey(USER_SCOPE),
      recordId: entry.record.recordId,
      kind: "appended",
      occurredAt: MEMORY_EPOCH,
      recordFingerprint: entry.record.fingerprint,
      version: entry.version,
    },
  };
}

describe("in-memory port", () => {
  it("reports every apply outcome distinctly", async () => {
    const port = createInMemoryMemoryStore();
    expect(await port.apply(commandFor(entryFor("f1"), null))).toBe("applied");
    expect(await port.apply(commandFor(entryFor("f1"), null))).toBe("already-exists");
    expect(await port.apply(commandFor(entryFor("f1", 2), 99))).toBe("version-conflict");
    expect(await port.apply(commandFor(entryFor("absent", 2), 1))).toBe("missing");
    expect(await port.apply(commandFor(entryFor("f1", 2), 1))).toBe("applied");
    expect(port.eventCount()).toBe(2);
  });

  it("lists entries in record-id order and isolates buckets", async () => {
    const port = createInMemoryMemoryStore();
    await port.apply(commandFor(entryFor("b"), null));
    await port.apply(commandFor(entryFor("a"), null));
    expect((await port.list(memoryScopeKey(USER_SCOPE))).map((entry) => entry.record.recordId)).toEqual(
      ["a", "b"],
    );
    expect(await port.list(memoryScopeKey(OTHER_ORG_SCOPE))).toHaveLength(0);
    expect(await port.get(memoryScopeKey(OTHER_ORG_SCOPE), "a")).toBeNull();
  });

  it("indexes by idempotency key only when one is present", async () => {
    const port = createInMemoryMemoryStore();
    const keyed: MemoryEntry = Object.freeze({ ...entryFor("f1"), idempotencyKey: "req-1" });
    await port.apply(commandFor(keyed, null));
    expect((await port.findByIdempotencyKey(memoryScopeKey(USER_SCOPE), "req-1"))?.record.recordId).toBe(
      "f1",
    );
    expect(await port.findByIdempotencyKey(memoryScopeKey(USER_SCOPE), "req-2")).toBeNull();
  });

  it("bounds and validates the event listing", async () => {
    const port = createInMemoryMemoryStore();
    await port.apply(commandFor(entryFor("f1"), null));
    expect(await port.listEvents(memoryScopeKey(USER_SCOPE), 0)).toHaveLength(0);
    expect(await port.listEvents(memoryScopeKey(USER_SCOPE), 10)).toHaveLength(1);
    await expect(port.listEvents(memoryScopeKey(USER_SCOPE), -1)).rejects.toBeInstanceOf(MemoryError);
  });

  it("refuses every operation once closed", async () => {
    const port = createInMemoryMemoryStore();
    await port.close();
    expect(port.isClosed()).toBe(true);
    await expect(port.get("k", "f1")).rejects.toBeInstanceOf(MemoryError);
    await expect(port.list("k")).rejects.toBeInstanceOf(MemoryError);
    await expect(port.findByIdempotencyKey("k", "r")).rejects.toBeInstanceOf(MemoryError);
    await expect(port.apply(commandFor(entryFor("f1"), null))).rejects.toBeInstanceOf(MemoryError);
    await expect(port.listEvents("k", 1)).rejects.toBeInstanceOf(MemoryError);
    // Closing twice is a no-op, not an error.
    await port.close();
  });

  it("injects failures on the chosen operation only, then recovers", async () => {
    const inner = createInMemoryMemoryStore();
    const flaky = withInjectedFailure(inner, { operation: "get", times: 1 });
    await expect(flaky.get("k", "f1")).rejects.toBeInstanceOf(MemoryError);
    expect(await flaky.get(memoryScopeKey(USER_SCOPE), "f1")).toBeNull();
    expect(await flaky.list(memoryScopeKey(USER_SCOPE))).toHaveLength(0);
    expect(await flaky.apply(commandFor(entryFor("f1"), null))).toBe("applied");
    expect(await flaky.findByIdempotencyKey(memoryScopeKey(USER_SCOPE), "r")).toBeNull();
    expect(await flaky.listEvents(memoryScopeKey(USER_SCOPE), 10)).toHaveLength(1);
    await flaky.close();

    const listFlaky = withInjectedFailure(createInMemoryMemoryStore(), {
      operation: "list",
      times: 1,
    });
    await expect(listFlaky.list("k")).rejects.toBeInstanceOf(MemoryError);
  });

  it("maps an adapter defect to a leak-free failure", () => {
    const failure = storeFailure("apply");
    expect(failure.code).toBe("STORE_FAILURE");
    expect(failure.details["operation"]).toBe("apply");
  });
});

describe("entry validation", () => {
  it("round-trips a stored entry", () => {
    const entry = entryFor("f1");
    const parsed = parseMemoryEntry(JSON.parse(JSON.stringify(entry)));
    expect(parsed.record.fingerprint).toBe(entry.record.fingerprint);
    expect(parsed.version).toBe(1);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("rejects malformed state", () => {
    const raw = JSON.parse(JSON.stringify(entryFor("f1"))) as Record<string, unknown>;
    expect(() => parseMemoryEntry({ ...raw, version: 0 })).toThrow(ValidationError);
    expect(() => parseMemoryEntry({ ...raw, confirmation: "maybe" })).toThrow(ValidationError);
    expect(() => parseMemoryEntry({ ...raw, tombstonedAt: "not-a-time" })).toThrow(ValidationError);
    expect(() => parseMemoryEntry({ ...raw, extra: true })).toThrow(ValidationError);
  });

  it("accepts a fully populated state", () => {
    const raw = JSON.parse(JSON.stringify(entryFor("f1"))) as Record<string, unknown>;
    const parsed = parseMemoryEntry({
      ...raw,
      confirmation: "confirmed",
      supersededBy: "f2",
      tombstonedAt: MEMORY_EPOCH,
      revokedAt: MEMORY_EPOCH,
      idempotencyKey: "req-1",
    });
    expect(parsed.supersededBy).toBe("f2");
    expect(parsed.idempotencyKey).toBe("req-1");
  });
});

describe("error type", () => {
  it("serializes without leaking and categorizes causes", () => {
    const error = new MemoryError("STORE_FAILURE", "adapter failed", { operation: "apply" });
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: "MemoryError",
      code: "STORE_FAILURE",
      message: "adapter failed",
      details: { operation: "apply" },
    });
    expect(Object.isFrozen(error.details)).toBe(true);
    expect(causeCategory(error)).toBe("STORE_FAILURE");
    expect(causeCategory(new TypeError("boom"))).toBe("TypeError");
    expect(causeCategory("just a string")).toBe("string");
    expect(causeCategory(undefined)).toBe("undefined");
  });
});

describe("free-function facade", () => {
  function open(): MemoryStore {
    return createMemoryStore({
      port: createInMemoryMemoryStore(),
      authorizer: createScopedAuthorizer({ scope: USER_SCOPE }),
      clock: createManualMemoryClock(),
      idSource: createCountingIdSource(),
    });
  }

  it("threads every operation through the store", async () => {
    const store = open();
    const candidate = unwrap(
      await appendMemoryRecord(store, {
        record: inferredCandidate({ recordId: "c1", subject: "Editor", text: "spaces" }),
        purpose: "context-assembly",
      }),
    );
    unwrap(
      await confirmMemoryCandidate(store, {
        scope: USER_SCOPE,
        recordId: "c1",
        expectedVersion: candidate.version,
        purpose: "user-review",
      }),
    );

    const second = unwrap(
      await appendMemoryRecord(store, {
        record: inferredCandidate({ recordId: "c2", subject: "Editor", text: "tabs" }),
        purpose: "context-assembly",
      }),
    );
    unwrap(
      await rejectMemoryCandidate(store, {
        scope: USER_SCOPE,
        recordId: "c2",
        expectedVersion: second.version,
        purpose: "user-review",
      }),
    );

    const preference = unwrap(
      await appendMemoryRecord(store, {
        record: explicitPreference({ recordId: "p1", subject: "Indentation", text: "tabs" }),
        purpose: "context-assembly",
      }),
    );
    unwrap(
      await supersedeMemoryRecord(store, {
        scope: USER_SCOPE,
        supersededRecordId: "p1",
        expectedVersion: preference.version,
        replacement: explicitPreference({ recordId: "p2", subject: "Indentation", text: "spaces" }),
        purpose: "context-assembly",
      }),
    );

    const query = unwrap(await queryMemory(store, { scope: USER_SCOPE, purpose: "context-assembly" }));
    // A rejected candidate stays visible as rejected rather than disappearing;
    // hiding it would make the same inference look new next time.
    expect(query.entries.map((entry) => entry.record.recordId)).toEqual(["c1", "c2", "p2"]);
    expect(query.entries.map((entry) => entry.confirmation)).toEqual([
      "confirmed",
      "rejected",
      "not-applicable",
    ]);

    const target = query.entries[0];
    if (target !== undefined) {
      unwrap(
        await tombstoneMemoryRecord(store, {
          scope: USER_SCOPE,
          recordId: target.record.recordId,
          expectedVersion: target.version,
          tombstoneRecordId: "t1",
          purpose: "maintenance",
          recordedBy: "memory-test",
        }),
      );
    }
    const snapshot = unwrap(await memorySnapshot(store, { scope: USER_SCOPE, purpose: "export" }));
    expect(snapshot.counts.tombstone).toBe(1);
    await store.close();
  });

  it("refuses a supersession that would exceed the chain bound", async () => {
    const store = createMemoryStore({
      port: createInMemoryMemoryStore(),
      authorizer: createScopedAuthorizer({ scope: USER_SCOPE }),
      clock: createManualMemoryClock(),
      idSource: createCountingIdSource(),
      configuration: unwrap(
        withMemoryOverrides(DEFAULT_MEMORY_CONFIGURATION, {
          limits: { maxSupersessionChainDepth: 2 },
        }),
      ),
    });
    let previous = unwrap(
      await store.append({
        record: explicitPreference({ recordId: "p0", subject: "Indentation", text: "v0" }),
        purpose: "context-assembly",
      }),
    );
    let refused = "";
    for (let index = 1; index <= 4; index += 1) {
      const result = await store.supersede({
        scope: USER_SCOPE,
        supersededRecordId: previous.record.recordId,
        expectedVersion: previous.version,
        replacement: explicitPreference({
          recordId: `p${index}`,
          subject: "Indentation",
          text: `v${index}`,
        }),
        purpose: "context-assembly",
      });
      if (!result.ok) {
        refused = result.failure.code;
        break;
      }
      previous = result.value;
    }
    expect(refused).toBe("LIMIT_EXCEEDED");
    await store.close();
  });

  it("refuses an append whose supersedes target is already superseded", async () => {
    const store = open();
    const first = unwrap(
      await store.append({
        record: explicitPreference({ recordId: "p1", subject: "Indentation", text: "tabs" }),
        purpose: "context-assembly",
      }),
    );
    unwrap(
      await store.supersede({
        scope: USER_SCOPE,
        supersededRecordId: "p1",
        expectedVersion: first.version,
        replacement: explicitPreference({ recordId: "p2", subject: "Indentation", text: "spaces" }),
        purpose: "context-assembly",
      }),
    );
    const result = await store.append({
      record: { ...explicitPreference({ recordId: "p3", subject: "Indentation", text: "mixed" }), supersedes: "p1" },
      purpose: "context-assembly",
    });
    expect(code(result)).toBe("VERSION_CONFLICT");
    await store.close();
  });

  it("refuses a sealed replacement that does not name the record it supersedes", async () => {
    const store = open();
    const first = unwrap(
      await store.append({
        record: explicitPreference({ recordId: "p1", subject: "Indentation", text: "tabs" }),
        purpose: "context-assembly",
      }),
    );
    // A sealed record cannot be rewritten without invalidating its
    // fingerprint, so the supersession link has to be in it already. Accepting
    // it silently would leave `p1` live with nothing pointing at `p2`.
    const detached = createMemoryRecord(
      explicitPreference({ recordId: "p2", subject: "Indentation", text: "spaces" }),
    );
    expect(
      code(
        await store.supersede({
          scope: USER_SCOPE,
          supersededRecordId: "p1",
          expectedVersion: first.version,
          replacement: detached,
          purpose: "context-assembly",
        }),
      ),
    ).toBe("INVALID_RECORD");
    const stillLive = unwrap(
      await store.read({ scope: USER_SCOPE, recordId: "p1", purpose: "context-assembly" }),
    );
    expect(stillLive.supersededBy).toBeNull();

    // A sealed replacement that does name its predecessor is accepted, and the
    // predecessor is marked.
    const linked = createMemoryRecord({
      ...explicitPreference({ recordId: "p3", subject: "Indentation", text: "spaces" }),
      supersedes: "p1",
    });
    unwrap(
      await store.supersede({
        scope: USER_SCOPE,
        supersededRecordId: "p1",
        expectedVersion: first.version,
        replacement: linked,
        purpose: "context-assembly",
      }),
    );
    const superseded = unwrap(await store.snapshot({ scope: USER_SCOPE, purpose: "export" }));
    expect(superseded.entries.find((entry) => entry.recordId === "p1")?.supersededBy).toBe("p3");
    await store.close();
  });

  it("refuses an append whose supersedes target does not exist", async () => {
    const store = open();
    const result = await store.append({
      record: { ...explicitPreference({ recordId: "p1", subject: "Indentation", text: "tabs" }), supersedes: "ghost" },
      purpose: "context-assembly",
    });
    expect(code(result)).toBe("NOT_FOUND");
    await store.close();
  });

  it("refuses an event listing the caller is not authorized for", async () => {
    const store = open();
    expect(code(await store.events({ scope: OTHER_ORG_SCOPE, purpose: "maintenance" }))).toBe(
      "AUTHORIZATION_DENIED",
    );
    await store.close();
  });

  it("refuses a record whose scope cannot even be parsed", async () => {
    const store = open();
    const result = await store.append({
      record: {
        ...verifiedFact({ recordId: "f1", subject: "Build", text: "x" }),
        scope: { userId: null, organizationId: null, projectId: null, workspaceId: null },
      },
      purpose: "context-assembly",
    });
    expect(code(result)).toBe("INVALID_RECORD");
    await store.close();
  });

  it("refuses a body that exceeds the configured bound", async () => {
    const store = createMemoryStore({
      port: createInMemoryMemoryStore(),
      authorizer: createScopedAuthorizer({ scope: USER_SCOPE }),
      clock: createManualMemoryClock(),
      idSource: createCountingIdSource(),
      configuration: unwrap(
        withMemoryOverrides(DEFAULT_MEMORY_CONFIGURATION, { limits: { maxBodyTextLength: 8 } }),
      ),
    });
    expect(
      code(
        await store.append({
          record: verifiedFact({ recordId: "f1", subject: "Build", text: "far too long for the bound" }),
          purpose: "context-assembly",
        }),
      ),
    ).toBe("LIMIT_EXCEEDED");
    await store.close();
  });

  it("accepts an already-sealed record without rebuilding it", async () => {
    const store = open();
    const sealed = createMemoryRecord(
      verifiedFact({ recordId: "f1", subject: "Build", text: "npm run check" }),
    );
    const entry = unwrap(await store.append({ record: sealed, purpose: "context-assembly" }));
    expect(entry.record.fingerprint).toBe(sealed.fingerprint);
    await store.close();
  });

  it("surfaces a read failure while checking for an existing record", async () => {
    const store = createMemoryStore({
      port: withInjectedFailure(createInMemoryMemoryStore(), { operation: "get", times: 1 }),
      authorizer: createScopedAuthorizer({ scope: USER_SCOPE }),
      clock: createManualMemoryClock(),
      idSource: createCountingIdSource(),
    });
    expect(
      code(
        await store.append({
          record: verifiedFact({ recordId: "f1", subject: "Build", text: "npm run check" }),
          purpose: "context-assembly",
        }),
      ),
    ).toBe("STORE_FAILURE");
    await store.close();
  });

  it("treats an unreadable supersession chain as maximally deep rather than shallow", async () => {
    const inner = createInMemoryMemoryStore();
    let reads = 0;
    // Fails only once the chain walk starts, after the target has been loaded.
    const flaky = {
      ...inner,
      get: async (scopeKey: string, recordId: string) => {
        reads += 1;
        if (reads > 2) {
          throw new MemoryError("STORE_FAILURE", "chain read failed");
        }
        return inner.get(scopeKey, recordId);
      },
    };
    const store = createMemoryStore({
      port: inner,
      authorizer: createScopedAuthorizer({ scope: USER_SCOPE }),
      clock: createManualMemoryClock(),
      idSource: createCountingIdSource(),
    });
    const first = unwrap(
      await store.append({
        record: explicitPreference({ recordId: "p1", subject: "Indentation", text: "tabs" }),
        purpose: "context-assembly",
      }),
    );
    const walking = createMemoryStore({
      port: flaky,
      authorizer: createScopedAuthorizer({ scope: USER_SCOPE }),
      clock: createManualMemoryClock(),
      idSource: createCountingIdSource(),
      configuration: unwrap(
        withMemoryOverrides(DEFAULT_MEMORY_CONFIGURATION, {
          limits: { maxSupersessionChainDepth: 1 },
        }),
      ),
    });
    expect(
      code(
        await walking.supersede({
          scope: USER_SCOPE,
          supersededRecordId: "p1",
          expectedVersion: first.version,
          replacement: explicitPreference({ recordId: "p2", subject: "Indentation", text: "spaces" }),
          purpose: "context-assembly",
        }),
      ),
    ).toBe("LIMIT_EXCEEDED");
    await store.close();
  });

  it("resets the deterministic identifier source", () => {
    const ids = createCountingIdSource("ev");
    expect(ids.next("event")).toBe("ev-event-000001");
    expect(ids.issued).toHaveLength(1);
    ids.reset();
    expect(ids.issued).toHaveLength(0);
    expect(ids.next("event")).toBe("ev-event-000001");
  });

  it("refuses an inferred candidate with no expiry when the policy requires one", async () => {
    const store = createMemoryStore({
      port: createInMemoryMemoryStore(),
      authorizer: createScopedAuthorizer({ scope: USER_SCOPE }),
      clock: createManualMemoryClock(),
      idSource: createCountingIdSource(),
    });
    const sealed = createMemoryRecord(
      inferredCandidate({ recordId: "c1", subject: "Editor", text: "spaces", expiresAt: null }),
    );
    expect(code(await store.append({ record: sealed, purpose: "context-assembly" }))).toBe(
      "INVALID_RECORD",
    );
    await store.close();
  });
});
