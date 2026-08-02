import { describe, expect, it } from "vitest";
import { isProviderError } from "@ai-dev-os/providers";
import { createManualScheduler } from "@ai-dev-os/provider-testkit";
import {
  createOllamaCapacityManager,
  keepAliveWireValue,
  ollamaSchedulerFromManual,
  planOllamaResidency,
  type OllamaCapacityManager,
  type OllamaCapacityManagerOptions,
} from "../src/index.js";

function manager(
  overrides: Partial<OllamaCapacityManagerOptions> = {},
): { capacity: OllamaCapacityManager; manual: ReturnType<typeof createManualScheduler> } {
  const manual = createManualScheduler();
  const capacity = createOllamaCapacityManager({
    scheduler: ollamaSchedulerFromManual(manual),
    maxConcurrentOperations: 2,
    queueLimit: 4,
    defaultAdmissionTimeoutMs: null,
    ...overrides,
  });
  return { capacity, manual };
}

interface Settlement<T> {
  status: "pending" | "resolved" | "rejected";
  value?: T;
  error?: unknown;
}

function track<T>(promise: Promise<T>): Settlement<T> {
  const settlement: Settlement<T> = { status: "pending" };
  promise.then(
    (value) => {
      settlement.status = "resolved";
      settlement.value = value;
    },
    (error) => {
      settlement.status = "rejected";
      settlement.error = error;
    },
  );
  return settlement;
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("capacity admission", () => {
  it("admits under capacity and releases idempotently", async () => {
    const { capacity } = manager();
    const lease = await capacity.acquire({ model: "m", modelSizeBytes: 100 });
    expect(capacity.snapshot()).toMatchObject({
      activeOperations: 1,
      reservedBytes: 100,
      queuedOperations: 0,
    });
    expect(capacity.activeModels()).toEqual(["m"]);
    lease.release();
    lease.release();
    lease.release();
    expect(capacity.snapshot()).toMatchObject({ activeOperations: 0, reservedBytes: 0 });
    expect(Object.isFrozen(capacity.snapshot())).toBe(true);
  });

  it("enforces the global concurrency limit with a deterministic FIFO queue", async () => {
    const { capacity } = manager({ maxConcurrentOperations: 1 });
    const first = await capacity.acquire({ model: "a", modelSizeBytes: null });
    const second = track(capacity.acquire({ model: "b", modelSizeBytes: null }));
    const third = track(capacity.acquire({ model: "c", modelSizeBytes: null }));
    await flush();
    expect(second.status).toBe("pending");
    expect(capacity.snapshot().queuedOperations).toBe(2);
    expect(capacity.queuedModels()).toEqual(["b", "c"]);

    first.release();
    await flush();
    expect(second.status).toBe("resolved");
    expect(third.status).toBe("pending");
    second.value!.release();
    await flush();
    expect(third.status).toBe("resolved");
    third.value!.release();
    expect(capacity.snapshot()).toMatchObject({ activeOperations: 0, reservedBytes: 0 });
  });

  it("enforces per-model concurrency limits without blocking other models", async () => {
    const { capacity } = manager({
      maxConcurrentOperations: 4,
      perModelLimits: [{ model: "big", limit: 1 }],
    });
    const first = await capacity.acquire({ model: "big", modelSizeBytes: null });
    const blocked = track(capacity.acquire({ model: "big", modelSizeBytes: null }));
    await flush();
    expect(blocked.status).toBe("pending");
    // Strict FIFO: another model behind the blocked head must wait its turn.
    const other = track(capacity.acquire({ model: "small", modelSizeBytes: null }));
    await flush();
    expect(other.status).toBe("pending");
    first.release();
    await flush();
    expect(blocked.status).toBe("resolved");
    expect(other.status).toBe("resolved");
    blocked.value!.release();
    other.value!.release();
  });

  it("enforces the byte budget with its safety margin", async () => {
    const { capacity } = manager({
      maxConcurrentOperations: 8,
      capacityBudgetBytes: 1_000,
      capacitySafetyMarginBytes: 100,
    });
    const first = await capacity.acquire({ model: "a", modelSizeBytes: 500 });
    const second = track(capacity.acquire({ model: "b", modelSizeBytes: 450 }));
    await flush();
    expect(second.status).toBe("pending"); // 500 + 450 + 100 > 1000
    first.release();
    await flush();
    expect(second.status).toBe("resolved");
    second.value!.release();

    await expect(capacity.acquire({ model: "huge", modelSizeBytes: 950 })).rejects.toSatisfy(
      (error: unknown) =>
        isProviderError(error, "PROVIDER_OVERLOADED") &&
        (error as { retry: { strategy: string } }).retry.strategy === "never",
    );
  });

  it("rejects when the queue is full", async () => {
    const { capacity } = manager({ maxConcurrentOperations: 1, queueLimit: 1 });
    const lease = await capacity.acquire({ model: "a", modelSizeBytes: null });
    void capacity.acquire({ model: "b", modelSizeBytes: null }).then((queued) => queued.release());
    await expect(capacity.acquire({ model: "c", modelSizeBytes: null })).rejects.toSatisfy(
      (error: unknown) => isProviderError(error, "PROVIDER_OVERLOADED"),
    );
    lease.release();
  });

  it("expires queued admissions on their timeout deterministically", async () => {
    const { capacity, manual } = manager({ maxConcurrentOperations: 1, defaultAdmissionTimeoutMs: 5_000 });
    const lease = await capacity.acquire({ model: "a", modelSizeBytes: null });
    const queued = track(capacity.acquire({ model: "b", modelSizeBytes: null }));
    await flush();
    manual.advance(5_000);
    await flush();
    expect(queued.status).toBe("rejected");
    expect(isProviderError(queued.error, "TIMEOUT")).toBe(true);
    expect(capacity.snapshot().queuedOperations).toBe(0);
    lease.release();
    expect(capacity.snapshot().activeOperations).toBe(0);
  });

  it("expires queued admissions when their absolute deadline passes", async () => {
    const { capacity, manual } = manager({ maxConcurrentOperations: 1 });
    const lease = await capacity.acquire({ model: "a", modelSizeBytes: null });
    const deadline = new Date(manual.now().valueOf() + 60_000).toISOString();
    const queued = track(capacity.acquire({ model: "b", modelSizeBytes: null, deadline }));
    await flush();
    manual.advance(60_000);
    await flush();
    expect(queued.status).toBe("rejected");
    expect(isProviderError(queued.error, "DEADLINE_EXCEEDED")).toBe(true);
    lease.release();

    await expect(
      capacity.acquire({ model: "c", modelSizeBytes: null, deadline: manual.now().toISOString() }),
    ).rejects.toSatisfy((error: unknown) => isProviderError(error, "DEADLINE_EXCEEDED"));
  });

  it("supports cancellation while queued and pre-aborted admissions", async () => {
    const { capacity } = manager({ maxConcurrentOperations: 1 });
    const lease = await capacity.acquire({ model: "a", modelSizeBytes: null });

    let abort!: () => void;
    const listeners: Array<() => void> = [];
    const signal = {
      aborted: false,
      addEventListener: (_type: "abort", listener: () => void) => listeners.push(listener),
    };
    abort = () => {
      (signal as { aborted: boolean }).aborted = true;
      for (const listener of listeners) {
        listener();
      }
    };
    const queued = track(capacity.acquire({ model: "b", modelSizeBytes: null, signal }));
    await flush();
    abort();
    await flush();
    expect(queued.status).toBe("rejected");
    expect(isProviderError(queued.error, "CANCELLED")).toBe(true);
    expect(capacity.snapshot().queuedOperations).toBe(0);

    await expect(
      capacity.acquire({ model: "c", modelSizeBytes: null, signal: { aborted: true, addEventListener: () => undefined } }),
    ).rejects.toSatisfy((error: unknown) => isProviderError(error, "CANCELLED"));
    lease.release();
  });

  it("close rejects queued and future admissions but leaves active leases releasable", async () => {
    const { capacity } = manager({ maxConcurrentOperations: 1 });
    const lease = await capacity.acquire({ model: "a", modelSizeBytes: 10 });
    const queued = track(capacity.acquire({ model: "b", modelSizeBytes: null }));
    await flush();
    capacity.close();
    capacity.close();
    await flush();
    expect(queued.status).toBe("rejected");
    expect(isProviderError(queued.error, "PROVIDER_CLOSED")).toBe(true);
    await expect(capacity.acquire({ model: "c", modelSizeBytes: null })).rejects.toSatisfy(
      (error: unknown) => isProviderError(error, "PROVIDER_CLOSED"),
    );
    lease.release();
    expect(capacity.snapshot()).toMatchObject({ activeOperations: 0, reservedBytes: 0, closed: true });
  });

  it("never underflows or overflows accounting across mixed completion orders", async () => {
    const { capacity } = manager({
      maxConcurrentOperations: 3,
      capacityBudgetBytes: 10_000,
      queueLimit: 16,
    });
    const settlements = Array.from({ length: 9 }, (_, index) =>
      track(capacity.acquire({ model: `m${index % 3}`, modelSizeBytes: 1_000 })),
    );
    await flush();
    const resolvedFirst = settlements.filter((entry) => entry.status === "resolved");
    expect(resolvedFirst).toHaveLength(3);
    // Release in a scrambled order and drain the queue completely.
    for (let round = 0; round < 3; round += 1) {
      const resolved = settlements.filter((entry) => entry.status === "resolved" && entry.value !== undefined);
      for (const entry of resolved.reverse()) {
        entry.value!.release();
        entry.value = undefined;
        await flush();
      }
    }
    expect(settlements.every((entry) => entry.status === "resolved")).toBe(true);
    expect(capacity.snapshot()).toMatchObject({ activeOperations: 0, reservedBytes: 0, queuedOperations: 0 });
  });
});

describe("keep-alive and residency planning", () => {
  it("maps keep-alive policies to documented wire values", () => {
    expect(keepAliveWireValue({ policy: "unload-immediately" })).toBe(0);
    expect(keepAliveWireValue({ policy: "retain", durationMs: 90_000 })).toBe("90s");
    expect(keepAliveWireValue({ policy: "keep-loaded" })).toBe(-1);
  });

  it("never unloads models with active leases or queued work", () => {
    const plan = planOllamaResidency({
      keepAlive: { policy: "unload-immediately" },
      running: [
        { name: "active-model", digest: null, sizeBytes: 1, sizeVramBytes: null, expiresAt: null, contextLength: null },
        { name: "queued-model", digest: null, sizeBytes: 1, sizeVramBytes: null, expiresAt: null, contextLength: null },
        { name: "idle-model", digest: null, sizeBytes: 1, sizeVramBytes: null, expiresAt: null, contextLength: null },
      ],
      ownedModels: ["active-model", "queued-model", "idle-model"],
      activeModels: ["active-model"],
      queuedModels: ["queued-model"],
    });
    expect(plan.steps).toEqual([{ action: "unload", model: "idle-model", reasonCode: "keep-alive-policy" }]);
    expect(plan.skipped).toContainEqual({ model: "active-model", reasonCode: "active-lease" });
    expect(plan.skipped).toContainEqual({ model: "queued-model", reasonCode: "active-lease" });
  });

  it("never unloads externally observed models it does not own", () => {
    const plan = planOllamaResidency({
      keepAlive: { policy: "unload-immediately" },
      running: [
        { name: "external-model", digest: null, sizeBytes: 1, sizeVramBytes: null, expiresAt: null, contextLength: null },
      ],
      ownedModels: [],
      activeModels: [],
    });
    expect(plan.steps).toHaveLength(0);
    expect(plan.skipped).toEqual([{ model: "external-model", reasonCode: "not-owned" }]);
  });

  it("unloads owned idle models under capacity pressure and plans explicit preloads", () => {
    const plan = planOllamaResidency({
      keepAlive: { policy: "keep-loaded" },
      running: [
        { name: "owned-idle", digest: null, sizeBytes: 900, sizeVramBytes: null, expiresAt: null, contextLength: null },
      ],
      ownedModels: ["owned-idle"],
      activeModels: [],
      capacityBudgetBytes: 1_000,
      capacitySafetyMarginBytes: 200,
      preloadModels: ["wanted-model", "owned-idle"],
    });
    expect(plan.steps).toContainEqual({ action: "unload", model: "owned-idle", reasonCode: "capacity-pressure" });
    expect(plan.steps).toContainEqual({ action: "load", model: "wanted-model", reasonCode: "explicit-preload" });
    expect(plan.skipped).toContainEqual({ model: "owned-idle", reasonCode: "already-running" });
  });

  it("retains owned models within budget under a retain policy", () => {
    const plan = planOllamaResidency({
      keepAlive: { policy: "retain", durationMs: 60_000 },
      running: [
        { name: "owned-idle", digest: null, sizeBytes: 100, sizeVramBytes: null, expiresAt: null, contextLength: null },
      ],
      ownedModels: ["owned-idle"],
      activeModels: [],
      capacityBudgetBytes: 1_000,
    });
    expect(plan.steps).toHaveLength(0);
    expect(plan.skipped).toEqual([{ model: "owned-idle", reasonCode: "retained-by-policy" }]);
  });

  it("replays identical plans for identical inputs", () => {
    const input = {
      keepAlive: { policy: "unload-immediately" } as const,
      running: [
        { name: "b", digest: null, sizeBytes: 1, sizeVramBytes: null, expiresAt: null, contextLength: null },
        { name: "a", digest: null, sizeBytes: 1, sizeVramBytes: null, expiresAt: null, contextLength: null },
      ],
      ownedModels: ["a", "b"],
      activeModels: [],
    };
    const first = planOllamaResidency(input);
    const second = planOllamaResidency({ ...input, running: [...input.running].reverse() });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.steps.map((step) => step.model)).toEqual(["a", "b"]);
    expect(Object.isFrozen(first)).toBe(true);
  });
});
