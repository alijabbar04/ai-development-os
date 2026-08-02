import { describe, expect, it } from "vitest";
import { ValidationError } from "@ai-dev-os/domain";
import {
  PersistenceError,
  SessionGate,
  TransactionGuard,
  observeOperation,
  outcomeOfError,
  systemClock,
  type OperationRecord,
} from "../src/index.js";

describe("outcomeOfError", () => {
  it("maps error categories to structured outcomes", () => {
    expect(outcomeOfError(new PersistenceError("CONCURRENCY_CONFLICT", "x"))).toBe("conflict");
    expect(outcomeOfError(new PersistenceError("OUTBOX_STATE_CONFLICT", "x"))).toBe("conflict");
    expect(outcomeOfError(new PersistenceError("NOT_FOUND", "x"))).toBe("not-found");
    expect(outcomeOfError(new PersistenceError("DUPLICATE_ID", "x"))).toBe("duplicate");
    expect(outcomeOfError(new PersistenceError("DUPLICATE_IDEMPOTENCY_KEY", "x"))).toBe(
      "duplicate",
    );
    expect(outcomeOfError(new PersistenceError("CORRUPTION_DETECTED", "x"))).toBe("corruption");
    expect(outcomeOfError(new PersistenceError("STORAGE_FAILURE", "x"))).toBe("error");
    expect(outcomeOfError(new ValidationError("x", []))).toBe("validation-failed");
    expect(outcomeOfError(new Error("x"))).toBe("error");
  });
});

describe("observeOperation", () => {
  it("reports success and failure records and skips work-free when unobserved", async () => {
    const records: OperationRecord[] = [];
    const observer = (record: OperationRecord): void => {
      records.push(record);
    };
    const value = await observeOperation(observer, systemClock, "aggregates.get", "project", () => 7);
    expect(value).toBe(7);
    await expect(
      observeOperation(observer, systemClock, "aggregates.create", "project", () => {
        throw new PersistenceError("DUPLICATE_ID", "dup");
      }),
    ).rejects.toThrow(PersistenceError);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ operation: "aggregates.get", outcome: "success" });
    expect(records[1]).toMatchObject({ operation: "aggregates.create", outcome: "duplicate" });
    expect(records[0]!.durationMs).toBeGreaterThanOrEqual(0);

    expect(await observeOperation(undefined, systemClock, "noop", null, () => "ok")).toBe("ok");
  });
});

describe("TransactionGuard and SessionGate", () => {
  it("detects nesting across awaits but allows sequential runs", async () => {
    const guard = new TransactionGuard();
    await guard.run(async () => {
      await Promise.resolve();
      expect(() => guard.assertNotNested()).toThrow(PersistenceError);
    });
    expect(() => guard.assertNotNested()).not.toThrow();
    await guard.run(async () => undefined);
  });

  it("gates usage after completion with the configured code", () => {
    const gate = new SessionGate("TRANSACTION_COMPLETED", "done");
    expect(gate.active).toBe(true);
    gate.assertActive();
    gate.close();
    expect(gate.active).toBe(false);
    try {
      gate.assertActive();
      expect.unreachable();
    } catch (error) {
      expect((error as PersistenceError).code).toBe("TRANSACTION_COMPLETED");
    }
  });
});
