import { describe, expect, it } from "vitest";
import {
  createManualClock,
  runPersistenceContractSuite,
  type ContractHarness,
} from "@ai-dev-os/persistence/testing";
import { PersistenceError, type OperationRecord } from "@ai-dev-os/persistence";
import { createMemoryPersistenceAdapter } from "../src/index.js";

runPersistenceContractSuite("persistence-memory", async (): Promise<ContractHarness> => {
  const clock = createManualClock();
  const observed: OperationRecord[] = [];
  const adapter = createMemoryPersistenceAdapter({
    clock,
    observer: (record) => {
      observed.push(record);
    },
  });
  return {
    adapter,
    clock,
    observed,
    corruptAggregatePayload: async (aggregateType, aggregateId) => {
      adapter.corruptAggregatePayload(aggregateType, aggregateId);
    },
    corruptEventPayload: async (eventId) => {
      adapter.corruptEventPayload(eventId);
    },
    supportsMigrations: false,
  };
});

describe("memory adapter specifics", () => {
  it("exposes fault injection for outbox and artifact records", async () => {
    const adapter = createMemoryPersistenceAdapter({ clock: createManualClock() });
    await adapter.transact(async (tx) => {
      await tx.outbox.enqueue({
        messageId: "msg-1",
        topic: "events.publish",
        schemaVersion: 1,
        payload: { x: 1 },
        idempotencyKey: "key-1",
      });
      await tx.artifacts.putDescriptor({
        schemaVersion: 1,
        id: "art-1",
        displayName: "artifact",
        kind: "log",
        role: "diagnostic",
        mediaType: "text/plain",
        sizeBytes: 1,
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
        createdAt: "2026-08-02T12:00:00.000Z",
      });
    });

    adapter.corruptOutboxPayload("msg-1");
    adapter.corruptArtifactPayload("art-1");

    await expect(adapter.transact((tx) => tx.outbox.get("msg-1"))).rejects.toMatchObject({
      code: "CORRUPTION_DETECTED",
    });
    await expect(
      adapter.transact((tx) => tx.artifacts.getDescriptor("art-1")),
    ).rejects.toMatchObject({ code: "CORRUPTION_DETECTED" });

    expect(() => adapter.corruptOutboxPayload("ghost")).toThrow(PersistenceError);
    expect(() => adapter.corruptEventPayload("ghost")).toThrow(PersistenceError);
    expect(() => adapter.corruptAggregatePayload("project", "ghost")).toThrow(PersistenceError);
    expect(() => adapter.corruptArtifactPayload("ghost")).toThrow(PersistenceError);
    await adapter.close();
    expect(() => adapter.corruptOutboxPayload("msg-1")).toThrow(PersistenceError);
  });

  it("rolls back corrupted-by-transaction state snapshots independently", async () => {
    const adapter = createMemoryPersistenceAdapter({ clock: createManualClock() });
    await adapter.transact((tx) =>
      tx.aggregates.create({
        aggregateType: "project",
        aggregateId: "proj-1",
        schemaVersion: 1,
        payload: { keep: true },
      }),
    );
    // Failing transaction must not disturb previously committed state.
    await expect(
      adapter.transact(async (tx) => {
        await tx.aggregates.update({
          aggregateType: "project",
          aggregateId: "proj-1",
          schemaVersion: 1,
          payload: { keep: false },
          expectedVersion: 1,
        });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    const envelope = await adapter.transact((tx) => tx.aggregates.get("project", "proj-1"));
    expect(envelope?.aggregateVersion).toBe(1);
    await adapter.close();
  });
});
