import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ValidationError, jsonEquals } from "@ai-dev-os/domain";
import { PersistenceError } from "../errors.js";
import type {
  Clock,
  OperationRecord,
  PersistenceAdapter,
  TransactionContext,
} from "../ports.js";
import type { AggregateEnvelope, OutboxMessage } from "../records.js";

/** Deterministic, manually advanced clock for contract tests. */
export interface ManualClock extends Clock {
  advance(milliseconds: number): void;
  set(iso: string): void;
}

export const CONTRACT_EPOCH = "2026-08-02T12:00:00.000Z";

export function createManualClock(startIso: string = CONTRACT_EPOCH): ManualClock {
  let current = new Date(startIso).valueOf();
  return {
    now: () => new Date(current),
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
    set: (iso: string) => {
      current = new Date(iso).valueOf();
    },
  };
}

/**
 * Capabilities a concrete adapter's test harness provides to the shared
 * behavioral suite. Optional members gate the tests that need them; every
 * adapter must still pass the full core set.
 */
export interface ContractHarness {
  readonly adapter: PersistenceAdapter;
  readonly clock: ManualClock;
  /** Operation records captured through the adapter's observer option. */
  readonly observed: readonly OperationRecord[];
  /** Opens a NEW adapter over the same underlying storage (durable adapters). */
  readonly reopen?: () => Promise<PersistenceAdapter>;
  /** Corrupts the stored payload text of an aggregate without updating its checksum. */
  readonly corruptAggregatePayload?: (
    aggregateType: string,
    aggregateId: string,
  ) => Promise<void>;
  /** Corrupts the stored payload text of an event. */
  readonly corruptEventPayload?: (eventId: string) => Promise<void>;
  /** True when the adapter runs real migrations (SQLite). */
  readonly supportsMigrations: boolean;
  /** Releases temp resources after the test. */
  readonly dispose?: () => Promise<void>;
}

const SECRET = "sk-live-CONTRACT-CANARY-4242";

function isoAt(base: string, offsetMs: number): string {
  return new Date(new Date(base).valueOf() + offsetMs).toISOString();
}

async function expectPersistenceError(
  work: Promise<unknown> | (() => Promise<unknown>),
  code: string,
): Promise<PersistenceError> {
  try {
    await (typeof work === "function" ? work() : work);
  } catch (error) {
    expect(error).toBeInstanceOf(PersistenceError);
    expect((error as PersistenceError).code).toBe(code);
    return error as PersistenceError;
  }
  expect.unreachable(`expected PersistenceError ${code}`);
}

export function runPersistenceContractSuite(
  suiteName: string,
  createHarness: () => Promise<ContractHarness>,
): void {
  describe(`persistence contract: ${suiteName}`, () => {
    let harness: ContractHarness;
    let adapter: PersistenceAdapter;

    beforeEach(async () => {
      harness = await createHarness();
      adapter = harness.adapter;
    });

    afterEach(async () => {
      await adapter.close();
      await harness.dispose?.();
    });

    const createAggregate = (
      tx: TransactionContext,
      id: string,
      payload: unknown = { name: "alpha", tags: ["a", "b"] },
    ): Promise<AggregateEnvelope> =>
      tx.aggregates.create({
        aggregateType: "project",
        aggregateId: id,
        schemaVersion: 1,
        payload,
        traceId: "trace-1",
      });

    const enqueueMessage = (
      tx: TransactionContext,
      id: string,
      extra: Partial<{ availableAt: string; idempotencyKey: string }> = {},
    ): Promise<OutboxMessage> =>
      tx.outbox.enqueue({
        messageId: id,
        topic: "events.publish",
        schemaVersion: 1,
        payload: { ref: id },
        idempotencyKey: extra.idempotencyKey ?? `key-${id}`,
        availableAt: extra.availableAt ?? null,
      });

    describe("aggregates", () => {
      it("creates version-1 envelopes with canonical frozen payloads and clock timestamps", async () => {
        const envelope = await adapter.transact((tx) =>
          createAggregate(tx, "proj-1", { b: 2, a: 1 }),
        );
        expect(envelope.aggregateVersion).toBe(1);
        expect(envelope.schemaVersion).toBe(1);
        expect(envelope.createdAt).toBe(CONTRACT_EPOCH);
        expect(envelope.updatedAt).toBe(CONTRACT_EPOCH);
        expect(envelope.traceId).toBe("trace-1");
        expect(envelope.checksum.algorithm).toBe("sha-256");
        expect(Object.isFrozen(envelope)).toBe(true);
        expect(Object.isFrozen(envelope.payload)).toBe(true);
        expect(jsonEquals(envelope.payload, { a: 1, b: 2 })).toBe(true);
      });

      it("reads its own uncommitted writes inside a transaction and null for missing aggregates", async () => {
        await adapter.transact(async (tx) => {
          expect(await tx.aggregates.get("project", "proj-1")).toBeNull();
          await createAggregate(tx, "proj-1");
          const seen = await tx.aggregates.get("project", "proj-1");
          expect(seen?.aggregateId).toBe("proj-1");
        });
      });

      it("updates with the exact expected version and increments by one", async () => {
        await adapter.transact((tx) => createAggregate(tx, "proj-1"));
        harness.clock.advance(5_000);
        const updated = await adapter.transact((tx) =>
          tx.aggregates.update({
            aggregateType: "project",
            aggregateId: "proj-1",
            schemaVersion: 1,
            payload: { name: "beta" },
            expectedVersion: 1,
          }),
        );
        expect(updated.aggregateVersion).toBe(2);
        expect(updated.createdAt).toBe(CONTRACT_EPOCH);
        expect(updated.updatedAt).toBe(isoAt(CONTRACT_EPOCH, 5_000));
        expect(jsonEquals(updated.payload, { name: "beta" })).toBe(true);
      });

      it("rejects create of an existing aggregate with CONCURRENCY_CONFLICT", async () => {
        await adapter.transact((tx) => createAggregate(tx, "proj-1"));
        const error = await expectPersistenceError(
          adapter.transact((tx) => createAggregate(tx, "proj-1")),
          "CONCURRENCY_CONFLICT",
        );
        expect(error.details["aggregateId"]).toBe("proj-1");
      });

      it("rejects update of a missing aggregate with NOT_FOUND", async () => {
        await expectPersistenceError(
          adapter.transact((tx) =>
            tx.aggregates.update({
              aggregateType: "project",
              aggregateId: "ghost",
              schemaVersion: 1,
              payload: {},
              expectedVersion: 1,
            }),
          ),
          "NOT_FOUND",
        );
      });

      it("rejects stale and future expected versions", async () => {
        await adapter.transact(async (tx) => {
          await createAggregate(tx, "proj-1");
          await tx.aggregates.update({
            aggregateType: "project",
            aggregateId: "proj-1",
            schemaVersion: 1,
            payload: { v: 2 },
            expectedVersion: 1,
          });
        });
        for (const expectedVersion of [1, 3]) {
          const error = await expectPersistenceError(
            adapter.transact((tx) =>
              tx.aggregates.update({
                aggregateType: "project",
                aggregateId: "proj-1",
                schemaVersion: 1,
                payload: { v: 9 },
                expectedVersion,
              }),
            ),
            "CONCURRENCY_CONFLICT",
          );
          expect(error.details["expectedVersion"]).toBe(expectedVersion);
          expect(error.details["actualVersion"]).toBe(2);
        }
        const current = await adapter.transact((tx) => tx.aggregates.get("project", "proj-1"));
        expect(jsonEquals(current?.payload ?? null, { v: 2 })).toBe(true);
      });

      it("rejects hostile inputs without persisting anything", async () => {
        await expect(
          adapter.transact((tx) =>
            tx.aggregates.create({
              aggregateType: "warp-drive" as never,
              aggregateId: "x",
              schemaVersion: 1,
              payload: {},
            }),
          ),
        ).rejects.toThrow(ValidationError);
        await expect(
          adapter.transact((tx) => createAggregate(tx, "../escape")),
        ).rejects.toThrow(ValidationError);
        await expect(
          adapter.transact((tx) => createAggregate(tx, "proj-1", { bad: Number.NaN })),
        ).rejects.toThrow();
        await expect(
          adapter.transact((tx) =>
            createAggregate(tx, "proj-1", JSON.parse('{"__proto__": {"polluted": true}}')),
          ),
        ).rejects.toThrow();
        const page = await adapter.transact((tx) =>
          tx.aggregates.list({ aggregateType: "project" }),
        );
        expect(page.items).toHaveLength(0);
      });

      it("lists by type in ascending id order with stable keyset pagination", async () => {
        await adapter.transact(async (tx) => {
          for (const id of ["proj-c", "proj-a", "proj-e", "proj-b"]) {
            await createAggregate(tx, id);
          }
          await tx.aggregates.create({
            aggregateType: "task-run",
            aggregateId: "run-1",
            schemaVersion: 1,
            payload: {},
          });
        });

        const first = await adapter.transact((tx) =>
          tx.aggregates.list({ aggregateType: "project", limit: 2 }),
        );
        expect(first.items.map((item) => item.aggregateId)).toEqual(["proj-a", "proj-b"]);
        expect(first.nextCursor).not.toBeNull();

        // A record inserted between pages must not duplicate or skip others.
        await adapter.transact((tx) => createAggregate(tx, "proj-d"));

        const second = await adapter.transact((tx) =>
          tx.aggregates.list({
            aggregateType: "project",
            limit: 10,
            cursor: first.nextCursor,
          }),
        );
        expect(second.items.map((item) => item.aggregateId)).toEqual([
          "proj-c",
          "proj-d",
          "proj-e",
        ]);
        expect(second.nextCursor).toBeNull();
      });

      it("rejects malformed and wrong-kind cursors", async () => {
        await expectPersistenceError(
          adapter.transact((tx) =>
            tx.aggregates.list({ aggregateType: "project", cursor: "!!not-a-cursor!!" }),
          ),
          "INVALID_CURSOR",
        );
        const events = await adapter.transact(async (tx) => {
          await createAggregate(tx, "proj-1");
          for (const eventId of ["evt-1", "evt-2"]) {
            await tx.events.append({
              eventId,
              aggregateType: "project",
              aggregateId: "proj-1",
              aggregateVersion: 1,
              eventType: "project.created",
              eventSchemaVersion: 1,
              payload: {},
              occurredAt: CONTRACT_EPOCH,
            });
          }
          return tx.events.list({ limit: 1 });
        });
        expect(events.nextCursor).not.toBeNull();
        // A sequence cursor is not valid for a string-key listing.
        await expectPersistenceError(
          adapter.transact((tx) =>
            tx.aggregates.list({ aggregateType: "project", cursor: events.nextCursor }),
          ),
          "INVALID_CURSOR",
        );
      });
    });

    describe("transactions", () => {
      it("commits aggregate, event, outbox, and artifact writes atomically", async () => {
        await adapter.transact(async (tx) => {
          await createAggregate(tx, "proj-1");
          await tx.events.append({
            eventId: "evt-1",
            aggregateType: "project",
            aggregateId: "proj-1",
            aggregateVersion: 1,
            eventType: "project.created",
            eventSchemaVersion: 1,
            payload: { name: "alpha" },
            occurredAt: CONTRACT_EPOCH,
          });
          await enqueueMessage(tx, "msg-1");
        });
        const state = await adapter.transact(async (tx) => ({
          aggregate: await tx.aggregates.get("project", "proj-1"),
          events: await tx.events.list(),
          message: await tx.outbox.get("msg-1"),
        }));
        expect(state.aggregate?.aggregateVersion).toBe(1);
        expect(state.events.items).toHaveLength(1);
        expect(state.message?.status).toBe("pending");
      });

      it("rolls back every write when the callback throws, preserving the original error", async () => {
        const boom = new Error("boom");
        await expect(
          adapter.transact(async (tx) => {
            await createAggregate(tx, "proj-1");
            await tx.events.append({
              eventId: "evt-1",
              aggregateType: "project",
              aggregateId: "proj-1",
              aggregateVersion: 1,
              eventType: "project.created",
              eventSchemaVersion: 1,
              payload: {},
              occurredAt: CONTRACT_EPOCH,
            });
            await enqueueMessage(tx, "msg-1");
            throw boom;
          }),
        ).rejects.toBe(boom);

        const state = await adapter.transact(async (tx) => ({
          aggregate: await tx.aggregates.get("project", "proj-1"),
          events: await tx.events.list(),
          message: await tx.outbox.get("msg-1"),
        }));
        expect(state.aggregate).toBeNull();
        expect(state.events.items).toHaveLength(0);
        expect(state.message).toBeNull();
      });

      it("allows retrying with the same ids after a rollback without duplicates", async () => {
        const attempt = (fail: boolean): Promise<void> =>
          adapter.transact(async (tx) => {
            await createAggregate(tx, "proj-1");
            await tx.events.append({
              eventId: "evt-1",
              aggregateType: "project",
              aggregateId: "proj-1",
              aggregateVersion: 1,
              eventType: "project.created",
              eventSchemaVersion: 1,
              payload: {},
              occurredAt: CONTRACT_EPOCH,
            });
            await enqueueMessage(tx, "msg-1");
            if (fail) {
              throw new Error("first attempt fails");
            }
          });
        await expect(attempt(true)).rejects.toThrow("first attempt fails");
        await attempt(false);
        const state = await adapter.transact(async (tx) => ({
          events: await tx.events.list(),
          outbox: await tx.outbox.list(),
        }));
        expect(state.events.items).toHaveLength(1);
        expect(state.outbox.items).toHaveLength(1);
      });

      it("fails when the context escapes the callback", async () => {
        let escaped: TransactionContext | undefined;
        await adapter.transact((tx) => {
          escaped = tx;
        });
        await expectPersistenceError(
          () => escaped!.aggregates.get("project", "proj-1"),
          "TRANSACTION_COMPLETED",
        );
        await expectPersistenceError(
          () => escaped!.outbox.get("msg-1"),
          "TRANSACTION_COMPLETED",
        );
      });

      it("rejects nested transactions", async () => {
        await expectPersistenceError(
          adapter.transact(async () => {
            await adapter.transact(() => undefined);
          }),
          "NESTED_TRANSACTION",
        );
      });

      it("serializes concurrent transactions in submission order", async () => {
        const order: string[] = [];
        await Promise.all([
          adapter.transact(async (tx) => {
            order.push("first-start");
            await createAggregate(tx, "proj-1");
            order.push("first-end");
          }),
          adapter.transact(async (tx) => {
            order.push("second-start");
            const seen = await tx.aggregates.get("project", "proj-1");
            expect(seen).not.toBeNull();
            order.push("second-end");
          }),
        ]);
        expect(order).toEqual(["first-start", "first-end", "second-start", "second-end"]);
      });

      it("propagates the callback's return value", async () => {
        const result = await adapter.transact(() => ({ answer: 42 }));
        expect(result).toEqual({ answer: 42 });
      });
    });

    describe("events", () => {
      const appendEvent = (
        tx: TransactionContext,
        eventId: string,
        aggregateId = "proj-1",
        occurredAt = CONTRACT_EPOCH,
      ) =>
        tx.events.append({
          eventId,
          aggregateType: "project",
          aggregateId,
          aggregateVersion: 1,
          eventType: "project.updated",
          eventSchemaVersion: 1,
          payload: { eventId },
          occurredAt,
          traceId: "trace-9",
          causationId: "cause-1",
        });

      it("assigns a strictly increasing global sequence starting at 1", async () => {
        harness.clock.advance(1_000);
        const [first, second] = await adapter.transact(async (tx) => [
          await appendEvent(tx, "evt-1"),
          await appendEvent(tx, "evt-2"),
        ]);
        const third = await adapter.transact((tx) => appendEvent(tx, "evt-3"));
        expect(first!.globalSequence).toBe(1);
        expect(second!.globalSequence).toBe(2);
        expect(third.globalSequence).toBe(3);
        expect(first!.occurredAt).toBe(CONTRACT_EPOCH);
        expect(first!.recordedAt).toBe(isoAt(CONTRACT_EPOCH, 1_000));
        expect(first!.traceId).toBe("trace-9");
        expect(first!.causationId).toBe("cause-1");
      });

      it("rejects replayed event identifiers with DUPLICATE_ID", async () => {
        await adapter.transact((tx) => appendEvent(tx, "evt-1"));
        const error = await expectPersistenceError(
          adapter.transact((tx) => appendEvent(tx, "evt-1")),
          "DUPLICATE_ID",
        );
        expect(error.details["eventId"]).toBe("evt-1");
      });

      it("does not reuse sequence numbers after a rollback", async () => {
        await adapter.transact((tx) => appendEvent(tx, "evt-1"));
        await expect(
          adapter.transact(async (tx) => {
            await appendEvent(tx, "evt-2");
            throw new Error("abort");
          }),
        ).rejects.toThrow("abort");
        const third = await adapter.transact((tx) => appendEvent(tx, "evt-3"));
        // Gaps are permitted; ordering must remain strictly increasing.
        expect(third.globalSequence).toBeGreaterThan(1);
        const page = await adapter.transact((tx) => tx.events.list());
        expect(page.items.map((event) => event.eventId)).toEqual(["evt-1", "evt-3"]);
      });

      it("lists in global order with cursor pagination and aggregate filtering", async () => {
        await adapter.transact(async (tx) => {
          await appendEvent(tx, "evt-1", "proj-1");
          await appendEvent(tx, "evt-2", "proj-2");
          await appendEvent(tx, "evt-3", "proj-1");
        });
        const firstPage = await adapter.transact((tx) => tx.events.list({ limit: 2 }));
        expect(firstPage.items.map((event) => event.eventId)).toEqual(["evt-1", "evt-2"]);
        const secondPage = await adapter.transact((tx) =>
          tx.events.list({ limit: 2, cursor: firstPage.nextCursor }),
        );
        expect(secondPage.items.map((event) => event.eventId)).toEqual(["evt-3"]);
        expect(secondPage.nextCursor).toBeNull();

        const filtered = await adapter.transact((tx) =>
          tx.events.list({ aggregateType: "project", aggregateId: "proj-1" }),
        );
        expect(filtered.items.map((event) => event.eventId)).toEqual(["evt-1", "evt-3"]);
      });

      it("requires the aggregate type when filtering by aggregate id", async () => {
        await expect(
          adapter.transact((tx) => tx.events.list({ aggregateId: "proj-1" })),
        ).rejects.toThrow(ValidationError);
      });

      it("rejects invalid occurred-at timestamps and event types", async () => {
        await expect(
          adapter.transact((tx) =>
            tx.events.append({
              eventId: "evt-1",
              aggregateType: "project",
              aggregateId: "proj-1",
              aggregateVersion: 1,
              eventType: "project.created",
              eventSchemaVersion: 1,
              payload: {},
              occurredAt: "not-a-time",
            }),
          ),
        ).rejects.toThrow(ValidationError);
        await expect(
          adapter.transact((tx) =>
            tx.events.append({
              eventId: "evt-1",
              aggregateType: "project",
              aggregateId: "proj-1",
              aggregateVersion: 1,
              eventType: "DROP TABLE events;--",
              eventSchemaVersion: 1,
              payload: {},
              occurredAt: CONTRACT_EPOCH,
            }),
          ),
        ).rejects.toThrow(ValidationError);
      });
    });

    describe("outbox", () => {
      it("enqueues pending messages with sequence order and default availability", async () => {
        const message = await adapter.transact((tx) => enqueueMessage(tx, "msg-1"));
        expect(message.status).toBe("pending");
        expect(message.sequence).toBe(1);
        expect(message.attemptCount).toBe(0);
        expect(message.availableAt).toBe(CONTRACT_EPOCH);
        expect(message.createdAt).toBe(CONTRACT_EPOCH);
        expect(message.leaseOwner).toBeNull();
      });

      it("rejects duplicate message ids and duplicate idempotency keys", async () => {
        await adapter.transact((tx) => enqueueMessage(tx, "msg-1"));
        await expectPersistenceError(
          adapter.transact((tx) => enqueueMessage(tx, "msg-1")),
          "DUPLICATE_ID",
        );
        const error = await expectPersistenceError(
          adapter.transact((tx) =>
            enqueueMessage(tx, "msg-2", { idempotencyKey: "key-msg-1" }),
          ),
          "DUPLICATE_IDEMPOTENCY_KEY",
        );
        expect(error.details["idempotencyKey"]).toBe("key-msg-1");
      });

      it("claims oldest-first, leases exclusively, and increments attempts", async () => {
        await adapter.transact(async (tx) => {
          await enqueueMessage(tx, "msg-1");
          await enqueueMessage(tx, "msg-2");
          await enqueueMessage(tx, "msg-3");
        });
        const claimed = await adapter.transact((tx) =>
          tx.outbox.claim({ owner: "worker-a", leaseDurationMs: 60_000, limit: 2 }),
        );
        expect(claimed.map((message) => message.messageId)).toEqual(["msg-1", "msg-2"]);
        expect(claimed[0]!.status).toBe("leased");
        expect(claimed[0]!.attemptCount).toBe(1);
        expect(claimed[0]!.leaseOwner).toBe("worker-a");
        expect(claimed[0]!.leaseExpiresAt).toBe(isoAt(CONTRACT_EPOCH, 60_000));

        // A concurrent worker cannot claim the same messages.
        const other = await adapter.transact((tx) =>
          tx.outbox.claim({ owner: "worker-b", leaseDurationMs: 60_000, limit: 10 }),
        );
        expect(other.map((message) => message.messageId)).toEqual(["msg-3"]);
      });

      it("keeps future-scheduled messages unclaimable until the clock reaches them", async () => {
        await adapter.transact((tx) =>
          enqueueMessage(tx, "msg-1", { availableAt: isoAt(CONTRACT_EPOCH, 10_000) }),
        );
        const early = await adapter.transact((tx) =>
          tx.outbox.claim({ owner: "worker-a", leaseDurationMs: 1_000 }),
        );
        expect(early).toHaveLength(0);
        harness.clock.advance(10_000);
        const later = await adapter.transact((tx) =>
          tx.outbox.claim({ owner: "worker-a", leaseDurationMs: 1_000 }),
        );
        expect(later.map((message) => message.messageId)).toEqual(["msg-1"]);
      });

      it("reclaims expired leases and increments the attempt count", async () => {
        await adapter.transact((tx) => enqueueMessage(tx, "msg-1"));
        await adapter.transact((tx) =>
          tx.outbox.claim({ owner: "worker-a", leaseDurationMs: 5_000 }),
        );
        const beforeExpiry = await adapter.transact((tx) =>
          tx.outbox.claim({ owner: "worker-b", leaseDurationMs: 5_000 }),
        );
        expect(beforeExpiry).toHaveLength(0);
        harness.clock.advance(5_000);
        const reclaimed = await adapter.transact((tx) =>
          tx.outbox.claim({ owner: "worker-b", leaseDurationMs: 5_000 }),
        );
        expect(reclaimed).toHaveLength(1);
        expect(reclaimed[0]!.leaseOwner).toBe("worker-b");
        expect(reclaimed[0]!.attemptCount).toBe(2);
      });

      it("acknowledges idempotently and rejects foreign or invalid acknowledgements", async () => {
        await adapter.transact((tx) => enqueueMessage(tx, "msg-1"));
        await expectPersistenceError(
          adapter.transact((tx) => tx.outbox.acknowledge({ messageId: "msg-1", owner: "worker-a" })),
          "OUTBOX_STATE_CONFLICT",
        );
        await adapter.transact((tx) =>
          tx.outbox.claim({ owner: "worker-a", leaseDurationMs: 60_000 }),
        );
        await expectPersistenceError(
          adapter.transact((tx) => tx.outbox.acknowledge({ messageId: "msg-1", owner: "worker-b" })),
          "OUTBOX_STATE_CONFLICT",
        );
        harness.clock.advance(1_000);
        const acknowledged = await adapter.transact((tx) =>
          tx.outbox.acknowledge({ messageId: "msg-1", owner: "worker-a" }),
        );
        expect(acknowledged.status).toBe("acknowledged");
        expect(acknowledged.acknowledgedAt).toBe(isoAt(CONTRACT_EPOCH, 1_000));

        const again = await adapter.transact((tx) =>
          tx.outbox.acknowledge({ messageId: "msg-1", owner: "worker-a" }),
        );
        expect(again).toEqual(acknowledged);
        await expectPersistenceError(
          adapter.transact((tx) => tx.outbox.acknowledge({ messageId: "ghost", owner: "worker-a" })),
          "NOT_FOUND",
        );
      });

      it("schedules retries back to pending with a future availability", async () => {
        await adapter.transact((tx) => enqueueMessage(tx, "msg-1"));
        await adapter.transact((tx) =>
          tx.outbox.claim({ owner: "worker-a", leaseDurationMs: 60_000 }),
        );
        const retried = await adapter.transact((tx) =>
          tx.outbox.scheduleRetry({
            messageId: "msg-1",
            owner: "worker-a",
            retryAt: isoAt(CONTRACT_EPOCH, 30_000),
            failureCategory: "provider-timeout",
          }),
        );
        expect(retried.status).toBe("pending");
        expect(retried.availableAt).toBe(isoAt(CONTRACT_EPOCH, 30_000));
        expect(retried.lastFailureCategory).toBe("provider-timeout");
        expect(retried.leaseOwner).toBeNull();

        const early = await adapter.transact((tx) =>
          tx.outbox.claim({ owner: "worker-b", leaseDurationMs: 1_000 }),
        );
        expect(early).toHaveLength(0);
        harness.clock.advance(30_000);
        const reclaimed = await adapter.transact((tx) =>
          tx.outbox.claim({ owner: "worker-b", leaseDurationMs: 1_000 }),
        );
        expect(reclaimed.map((message) => message.messageId)).toEqual(["msg-1"]);
        expect(reclaimed[0]!.attemptCount).toBe(2);
      });

      it("dead-letters terminally and blocks further transitions", async () => {
        await adapter.transact((tx) => enqueueMessage(tx, "msg-1"));
        await adapter.transact((tx) =>
          tx.outbox.claim({ owner: "worker-a", leaseDurationMs: 60_000 }),
        );
        await expectPersistenceError(
          adapter.transact((tx) =>
            tx.outbox.deadLetter({ messageId: "msg-1", owner: "worker-b", failureCategory: "poison" }),
          ),
          "OUTBOX_STATE_CONFLICT",
        );
        harness.clock.advance(2_000);
        const dead = await adapter.transact((tx) =>
          tx.outbox.deadLetter({ messageId: "msg-1", owner: "worker-a", failureCategory: "poison" }),
        );
        expect(dead.status).toBe("dead-lettered");
        expect(dead.deadLetteredAt).toBe(isoAt(CONTRACT_EPOCH, 2_000));
        expect(dead.lastFailureCategory).toBe("poison");
        await expectPersistenceError(
          adapter.transact((tx) => tx.outbox.acknowledge({ messageId: "msg-1", owner: "worker-a" })),
          "OUTBOX_STATE_CONFLICT",
        );
        const claimable = await adapter.transact((tx) =>
          tx.outbox.claim({ owner: "worker-a", leaseDurationMs: 1_000 }),
        );
        expect(claimable).toHaveLength(0);
      });

      it("lists by status in enqueue order with pagination", async () => {
        await adapter.transact(async (tx) => {
          await enqueueMessage(tx, "msg-1");
          await enqueueMessage(tx, "msg-2");
          await enqueueMessage(tx, "msg-3");
        });
        await adapter.transact((tx) =>
          tx.outbox.claim({ owner: "worker-a", leaseDurationMs: 60_000, limit: 1 }),
        );
        const pending = await adapter.transact((tx) =>
          tx.outbox.list({ status: "pending", limit: 1 }),
        );
        expect(pending.items.map((message) => message.messageId)).toEqual(["msg-2"]);
        const rest = await adapter.transact((tx) =>
          tx.outbox.list({ status: "pending", cursor: pending.nextCursor }),
        );
        expect(rest.items.map((message) => message.messageId)).toEqual(["msg-3"]);
        const leased = await adapter.transact((tx) => tx.outbox.list({ status: "leased" }));
        expect(leased.items.map((message) => message.messageId)).toEqual(["msg-1"]);
      });
    });

    describe("artifact metadata", () => {
      const descriptor = (id: string): Record<string, unknown> => ({
        schemaVersion: 1,
        id,
        displayName: `artifact ${id}`,
        kind: "structured-data",
        role: "output",
        mediaType: "application/json",
        sizeBytes: 64,
        digest: { algorithm: "sha-256", hex: "a".repeat(64) },
        classification: "internal",
        location: { type: "content-addressed", store: "local" },
        provenance: {
          producedBy: { type: "user" },
          runId: null,
          taskId: null,
          taskRunId: null,
          traceId: null,
        },
        parents: [],
        createdAt: CONTRACT_EPOCH,
      });

      it("stores and round-trips validated descriptors and manifests", async () => {
        const stored = await adapter.transact((tx) => tx.artifacts.putDescriptor(descriptor("art-1")));
        expect(stored.id).toBe("art-1");
        expect(Object.isFrozen(stored)).toBe(true);
        const fetched = await adapter.transact((tx) => tx.artifacts.getDescriptor("art-1"));
        expect(fetched).toEqual(stored);
        expect(await adapter.transact((tx) => tx.artifacts.getDescriptor("ghost"))).toBeNull();

        const manifest = await adapter.transact((tx) =>
          tx.artifacts.putManifest({
            schemaVersion: 1,
            manifestId: "man-1",
            taskRunId: null,
            artifacts: [descriptor("art-9")],
            createdAt: CONTRACT_EPOCH,
          }),
        );
        expect(manifest.manifestId).toBe("man-1");
        const fetchedManifest = await adapter.transact((tx) => tx.artifacts.getManifest("man-1"));
        expect(fetchedManifest).toEqual(manifest);
        expect(await adapter.transact((tx) => tx.artifacts.getManifest("ghost"))).toBeNull();
      });

      it("rejects duplicate and invalid artifact records", async () => {
        await adapter.transact((tx) => tx.artifacts.putDescriptor(descriptor("art-1")));
        await expectPersistenceError(
          adapter.transact((tx) => tx.artifacts.putDescriptor(descriptor("art-1"))),
          "DUPLICATE_ID",
        );
        await expect(
          adapter.transact((tx) =>
            tx.artifacts.putDescriptor({ ...descriptor("art-2"), displayName: "../escape" }),
          ),
        ).rejects.toThrow(ValidationError);
        await expect(
          adapter.transact((tx) => tx.artifacts.putManifest({ manifestId: "man-2" })),
        ).rejects.toThrow(ValidationError);
      });

      it("lists descriptors in ascending id order with pagination", async () => {
        await adapter.transact(async (tx) => {
          for (const id of ["art-c", "art-a", "art-b"]) {
            await tx.artifacts.putDescriptor(descriptor(id));
          }
        });
        const first = await adapter.transact((tx) => tx.artifacts.listDescriptors({ limit: 2 }));
        expect(first.items.map((item) => item.id)).toEqual(["art-a", "art-b"]);
        const second = await adapter.transact((tx) =>
          tx.artifacts.listDescriptors({ limit: 2, cursor: first.nextCursor }),
        );
        expect(second.items.map((item) => item.id)).toEqual(["art-c"]);
        expect(second.nextCursor).toBeNull();
      });
    });

    describe("corruption detection", () => {
      it("rejects a tampered aggregate payload with CORRUPTION_DETECTED", async (context) => {
        if (harness.corruptAggregatePayload === undefined) {
          context.skip();
          return;
        }
        await adapter.transact((tx) => createAggregate(tx, "proj-1", { secret: SECRET }));
        await harness.corruptAggregatePayload("project", "proj-1");
        const error = await expectPersistenceError(
          adapter.transact((tx) => tx.aggregates.get("project", "proj-1")),
          "CORRUPTION_DETECTED",
        );
        const serialized = JSON.stringify(error.toJSON());
        expect(serialized).not.toContain(SECRET);
        expect(serialized).not.toContain("tampered");
      });

      it("rejects a tampered event payload with CORRUPTION_DETECTED", async (context) => {
        if (harness.corruptEventPayload === undefined) {
          context.skip();
          return;
        }
        await adapter.transact((tx) =>
          tx.events.append({
            eventId: "evt-1",
            aggregateType: "project",
            aggregateId: "proj-1",
            aggregateVersion: 1,
            eventType: "project.created",
            eventSchemaVersion: 1,
            payload: { secret: SECRET },
            occurredAt: CONTRACT_EPOCH,
          }),
        );
        await harness.corruptEventPayload("evt-1");
        await expectPersistenceError(
          adapter.transact((tx) => tx.events.list()),
          "CORRUPTION_DETECTED",
        );
      });
    });

    describe("lifecycle", () => {
      it("close is idempotent and later operations fail with ADAPTER_CLOSED", async () => {
        await adapter.transact((tx) => createAggregate(tx, "proj-1"));
        await adapter.close();
        await adapter.close();
        await expectPersistenceError(
          adapter.transact(() => undefined),
          "ADAPTER_CLOSED",
        );
        await expectPersistenceError(() => adapter.migrationStatus(), "ADAPTER_CLOSED");
      });

      it("waits for in-flight transactions before closing", async () => {
        const events: string[] = [];
        const inFlight = adapter.transact(async (tx) => {
          await createAggregate(tx, "proj-1");
          events.push("transaction-done");
        });
        const closing = adapter.close().then(() => {
          events.push("closed");
        });
        await Promise.all([inFlight, closing]);
        expect(events).toEqual(["transaction-done", "closed"]);
      });

      it("reopens durable storage with identical state", async (context) => {
        if (harness.reopen === undefined) {
          context.skip();
          return;
        }
        await adapter.transact(async (tx) => {
          await createAggregate(tx, "proj-1", { keep: true });
          await tx.events.append({
            eventId: "evt-1",
            aggregateType: "project",
            aggregateId: "proj-1",
            aggregateVersion: 1,
            eventType: "project.created",
            eventSchemaVersion: 1,
            payload: {},
            occurredAt: CONTRACT_EPOCH,
          });
          await enqueueMessage(tx, "msg-1");
        });
        await adapter.close();

        const reopened = await harness.reopen();
        try {
          const state = await reopened.transact(async (tx) => ({
            aggregate: await tx.aggregates.get("project", "proj-1"),
            events: await tx.events.list(),
            message: await tx.outbox.get("msg-1"),
          }));
          expect(jsonEquals(state.aggregate?.payload ?? null, { keep: true })).toBe(true);
          expect(state.events.items.map((event) => event.eventId)).toEqual(["evt-1"]);
          expect(state.events.items[0]!.globalSequence).toBe(1);
          expect(state.message?.status).toBe("pending");
          const status = await reopened.migrationStatus();
          expect(status.pending).toHaveLength(0);
          expect(status.databaseSchemaAhead).toBe(false);
        } finally {
          await reopened.close();
        }
      });

      it("reports migration status", async () => {
        const status = await adapter.migrationStatus();
        expect(status.pending).toHaveLength(0);
        expect(status.databaseSchemaAhead).toBe(false);
        if (harness.supportsMigrations) {
          expect(status.applied.length).toBeGreaterThan(0);
          expect(status.applied[0]!.ordinal).toBe(1);
        } else {
          expect(status.applied).toHaveLength(0);
        }
      });
    });

    describe("observability and secret hygiene", () => {
      it("reports structured operation records without payload data", async () => {
        await adapter.transact((tx) => createAggregate(tx, "proj-1", { secret: SECRET }));
        await expectPersistenceError(
          adapter.transact((tx) => createAggregate(tx, "proj-1")),
          "CONCURRENCY_CONFLICT",
        );
        const operations = harness.observed;
        expect(operations.length).toBeGreaterThan(0);
        const create = operations.find(
          (record) => record.operation === "aggregates.create" && record.outcome === "success",
        );
        const conflict = operations.find(
          (record) => record.operation === "aggregates.create" && record.outcome === "conflict",
        );
        expect(create?.aggregateType).toBe("project");
        expect(conflict).toBeDefined();
        for (const record of operations) {
          expect(record.durationMs).toBeGreaterThanOrEqual(0);
          expect(JSON.stringify(record)).not.toContain(SECRET);
        }
      });

      it("never leaks stored payload contents through validation errors", async () => {
        try {
          await adapter.transact((tx) =>
            tx.aggregates.create({
              aggregateType: "project",
              aggregateId: `bad id ${SECRET}`,
              schemaVersion: 1,
              payload: {},
            }),
          );
          expect.unreachable();
        } catch (error) {
          expect(JSON.stringify((error as ValidationError).toJSON())).not.toContain(SECRET);
        }
      });
    });
  });
}
