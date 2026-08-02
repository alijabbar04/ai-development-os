import { ProviderError, createRetryDisposition, isDeadlineExpired } from "@ai-dev-os/providers";
import type { AbortSignalLike } from "@ai-dev-os/providers";
import { overloadedError, providerClosedError } from "./errors.js";
import type { OllamaAdapterConfiguration, OllamaKeepAlivePolicy } from "./config.js";
import type { OllamaScheduler } from "./scheduler.js";
import type { OllamaWireRunningModel } from "./wire.js";

/**
 * Deterministic local capacity manager.
 *
 * Admission holds three invariants at once: a global concurrency limit,
 * optional per-model concurrency limits, and (when configured) a byte
 * budget with a safety reserve. Waiters queue strictly FIFO — the head of
 * the queue admits before anything behind it, so ordering is deterministic
 * and starvation is impossible by construction. Capacity is evaluated when
 * an entry reaches the head of the queue and resources free up, not
 * snapshotted at enqueue time.
 */

export interface OllamaCapacityLease {
  readonly leaseId: string;
  readonly model: string;
  readonly reservedBytes: number;
  /** Idempotent; releasing twice is a no-op and can never underflow. */
  release(): void;
}

export interface OllamaCapacitySnapshot {
  readonly activeOperations: number;
  readonly queuedOperations: number;
  readonly activeByModel: readonly { readonly model: string; readonly count: number }[];
  readonly reservedBytes: number;
  readonly capacityBudgetBytes: number | null;
  readonly capacitySafetyMarginBytes: number;
  readonly closed: boolean;
}

export interface OllamaAdmissionRequest {
  readonly model: string;
  /** Reserved bytes for the admission; null reserves zero (documented). */
  readonly modelSizeBytes: number | null;
  /** Absolute deadline (canonical ISO); expiring while queued rejects. */
  readonly deadline?: string | null;
  /** Overrides the configured admission timeout; null disables it. */
  readonly admissionTimeoutMs?: number | null;
  readonly signal?: AbortSignalLike;
}

export interface OllamaCapacityManager {
  acquire(request: OllamaAdmissionRequest): Promise<OllamaCapacityLease>;
  snapshot(): OllamaCapacitySnapshot;
  /** Rejects all queued admissions and blocks new ones. Idempotent. */
  close(): void;
  /** Model names with at least one active lease. */
  activeModels(): readonly string[];
  /** Model names with at least one queued admission. */
  queuedModels(): readonly string[];
}

export interface OllamaCapacityManagerOptions {
  readonly scheduler: OllamaScheduler;
  readonly maxConcurrentOperations: number;
  readonly perModelLimits?: readonly { readonly model: string; readonly limit: number }[];
  readonly capacityBudgetBytes?: number | null;
  readonly capacitySafetyMarginBytes?: number;
  readonly queueLimit?: number;
  readonly defaultAdmissionTimeoutMs?: number | null;
}

interface Waiter {
  readonly model: string;
  readonly reservedBytes: number;
  readonly resolve: (lease: OllamaCapacityLease) => void;
  readonly reject: (error: ProviderError) => void;
  settled: boolean;
  cleanup: (() => void)[];
}

export function createOllamaCapacityManager(
  options: OllamaCapacityManagerOptions,
): OllamaCapacityManager {
  const scheduler = options.scheduler;
  const maxConcurrent = options.maxConcurrentOperations;
  const perModelLimits = new Map(
    (options.perModelLimits ?? []).map((entry) => [entry.model, entry.limit]),
  );
  const budgetBytes = options.capacityBudgetBytes ?? null;
  const marginBytes = options.capacitySafetyMarginBytes ?? 0;
  const queueLimit = options.queueLimit ?? 16;
  const defaultTimeoutMs = options.defaultAdmissionTimeoutMs ?? null;

  let activeCount = 0;
  let reservedBytes = 0;
  const activeByModel = new Map<string, number>();
  const queue: Waiter[] = [];
  let leaseCounter = 0;
  let closed = false;

  function admissible(model: string, bytes: number): boolean {
    if (activeCount >= maxConcurrent) {
      return false;
    }
    const modelLimit = perModelLimits.get(model);
    if (modelLimit !== undefined && (activeByModel.get(model) ?? 0) >= modelLimit) {
      return false;
    }
    if (budgetBytes !== null && reservedBytes + bytes + marginBytes > budgetBytes) {
      return false;
    }
    return true;
  }

  function grant(model: string, bytes: number): OllamaCapacityLease {
    activeCount += 1;
    reservedBytes += bytes;
    activeByModel.set(model, (activeByModel.get(model) ?? 0) + 1);
    leaseCounter += 1;
    let released = false;
    const leaseId = `lease-${leaseCounter.toString().padStart(6, "0")}`;
    return Object.freeze({
      leaseId,
      model,
      reservedBytes: bytes,
      release(): void {
        if (released) {
          return;
        }
        released = true;
        activeCount -= 1;
        reservedBytes -= bytes;
        const remaining = (activeByModel.get(model) ?? 1) - 1;
        if (remaining <= 0) {
          activeByModel.delete(model);
        } else {
          activeByModel.set(model, remaining);
        }
        if (activeCount < 0 || reservedBytes < 0) {
          // Defensive: the idempotent-release guard makes this unreachable,
          // but capacity underflow must never pass silently.
          activeCount = Math.max(0, activeCount);
          reservedBytes = Math.max(0, reservedBytes);
          throw new ProviderError("INTERNAL_FAILURE", "Capacity accounting underflowed.", {});
        }
        pump();
      },
    });
  }

  function settle(waiter: Waiter, action: () => void): void {
    if (waiter.settled) {
      return;
    }
    waiter.settled = true;
    const index = queue.indexOf(waiter);
    if (index >= 0) {
      queue.splice(index, 1);
    }
    for (const cleanup of waiter.cleanup.splice(0, waiter.cleanup.length)) {
      cleanup();
    }
    action();
  }

  /** Strict FIFO: only the queue head is considered. */
  function pump(): void {
    for (;;) {
      const head = queue[0];
      if (head === undefined || !admissible(head.model, head.reservedBytes)) {
        return;
      }
      settle(head, () => head.resolve(grant(head.model, head.reservedBytes)));
    }
  }

  return {
    async acquire(request: OllamaAdmissionRequest): Promise<OllamaCapacityLease> {
      if (closed) {
        throw providerClosedError();
      }
      const bytes = request.modelSizeBytes ?? 0;
      if (budgetBytes !== null && bytes + marginBytes > budgetBytes) {
        throw new ProviderError(
          "PROVIDER_OVERLOADED",
          "The model cannot fit within the configured capacity budget.",
          { detailCode: "model-exceeds-capacity" },
          { retry: createRetryDisposition({ strategy: "never" }), causeCategory: "model-exceeds-capacity" },
        );
      }
      if (request.deadline !== undefined && request.deadline !== null && isDeadlineExpired(request.deadline, scheduler.now())) {
        throw new ProviderError("DEADLINE_EXCEEDED", "The deadline passed before admission.", {});
      }
      if (request.signal?.aborted === true) {
        throw new ProviderError("CANCELLED", "The admission request was aborted.", {});
      }
      if (queue.length === 0 && admissible(request.model, bytes)) {
        return grant(request.model, bytes);
      }
      if (queue.length >= queueLimit) {
        throw overloadedError("queue-full");
      }

      return new Promise<OllamaCapacityLease>((resolve, reject) => {
        const waiter: Waiter = {
          model: request.model,
          reservedBytes: bytes,
          resolve,
          reject,
          settled: false,
          cleanup: [],
        };
        queue.push(waiter);

        const timeoutMs = request.admissionTimeoutMs === undefined ? defaultTimeoutMs : request.admissionTimeoutMs;
        if (timeoutMs !== null) {
          const delay = scheduler.delay(timeoutMs);
          waiter.cleanup.push(() => delay.cancel());
          void delay.promise.then(() => {
            settle(waiter, () =>
              reject(
                new ProviderError(
                  "TIMEOUT",
                  "The operation timed out waiting for local capacity.",
                  { detailCode: "admission-timeout", timeoutMs },
                  { causeCategory: "admission-timeout" },
                ),
              ),
            );
          });
        }
        if (request.deadline !== undefined && request.deadline !== null) {
          const remainingMs = Math.max(0, new Date(request.deadline).valueOf() - scheduler.now().valueOf());
          const delay = scheduler.delay(remainingMs);
          waiter.cleanup.push(() => delay.cancel());
          void delay.promise.then(() => {
            settle(waiter, () =>
              reject(new ProviderError("DEADLINE_EXCEEDED", "The deadline passed while queued for capacity.", {})),
            );
          });
        }
        if (request.signal !== undefined) {
          request.signal.addEventListener(
            "abort",
            () => {
              settle(waiter, () =>
                reject(new ProviderError("CANCELLED", "The admission request was aborted.", {})),
              );
            },
            { once: true },
          );
        }
        pump();
      });
    },

    snapshot(): OllamaCapacitySnapshot {
      return Object.freeze({
        activeOperations: activeCount,
        queuedOperations: queue.length,
        activeByModel: Object.freeze(
          [...activeByModel.entries()]
            .map(([model, count]) => Object.freeze({ model, count }))
            .sort((a, b) => (a.model < b.model ? -1 : 1)),
        ),
        reservedBytes,
        capacityBudgetBytes: budgetBytes,
        capacitySafetyMarginBytes: marginBytes,
        closed,
      });
    },

    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      for (const waiter of [...queue]) {
        settle(waiter, () => waiter.reject(providerClosedError()));
      }
    },

    activeModels(): readonly string[] {
      return Object.freeze([...activeByModel.keys()].sort());
    },

    queuedModels(): readonly string[] {
      return Object.freeze([...new Set(queue.map((waiter) => waiter.model))].sort());
    },
  };
}

// ---------------------------------------------------------------------------
// Keep-alive and residency (load/unload) planning
// ---------------------------------------------------------------------------

/**
 * Maps the configured keep-alive policy to the documented wire value:
 * 0 unloads immediately after use, "<seconds>s" retains for a bounded
 * duration, and -1 keeps the model loaded (subject to capacity policy).
 */
export function keepAliveWireValue(policy: OllamaKeepAlivePolicy): number | string {
  switch (policy.policy) {
    case "unload-immediately":
      return 0;
    case "retain":
      return `${Math.ceil(policy.durationMs / 1_000)}s`;
    case "keep-loaded":
      return -1;
  }
}

export type OllamaResidencyAction =
  | { readonly action: "unload"; readonly model: string; readonly reasonCode: string }
  | { readonly action: "load"; readonly model: string; readonly reasonCode: string };

export interface OllamaResidencyPlan {
  readonly steps: readonly OllamaResidencyAction[];
  readonly skipped: readonly { readonly model: string; readonly reasonCode: string }[];
}

/**
 * Deterministic unload/load planning.
 *
 * Only models this provider instance OWNS (loaded or preloaded through it)
 * are ever unload candidates: Ollama cannot attribute externally loaded
 * models to a client, so externally observed models are reported as
 * skipped rather than autonomously unloaded. Models with an active lease
 * or queued work are never unloaded. Explicit preloads become load steps
 * when the model is not already running.
 */
export function planOllamaResidency(options: {
  readonly keepAlive: OllamaKeepAlivePolicy;
  readonly running: readonly OllamaWireRunningModel[];
  readonly ownedModels: readonly string[];
  readonly activeModels: readonly string[];
  readonly queuedModels?: readonly string[];
  readonly preloadModels?: readonly string[];
  readonly capacityBudgetBytes?: number | null;
  readonly capacitySafetyMarginBytes?: number;
}): OllamaResidencyPlan {
  const owned = new Set(options.ownedModels);
  const active = new Set(options.activeModels);
  const queued = new Set(options.queuedModels ?? []);
  const steps: OllamaResidencyAction[] = [];
  const skipped: { readonly model: string; readonly reasonCode: string }[] = [];

  const runningSorted = [...options.running].sort((a, b) => (a.name < b.name ? -1 : 1));
  const budget = options.capacityBudgetBytes ?? null;
  const margin = options.capacitySafetyMarginBytes ?? 0;
  const totalRunningBytes = runningSorted.reduce((sum, model) => sum + (model.sizeBytes ?? 0), 0);
  const overBudget = budget !== null && totalRunningBytes + margin > budget;

  for (const model of runningSorted) {
    if (active.has(model.name) || queued.has(model.name)) {
      skipped.push(Object.freeze({ model: model.name, reasonCode: "active-lease" }));
      continue;
    }
    if (!owned.has(model.name)) {
      skipped.push(Object.freeze({ model: model.name, reasonCode: "not-owned" }));
      continue;
    }
    if (options.keepAlive.policy === "unload-immediately") {
      steps.push(Object.freeze({ action: "unload" as const, model: model.name, reasonCode: "keep-alive-policy" }));
    } else if (overBudget) {
      steps.push(Object.freeze({ action: "unload" as const, model: model.name, reasonCode: "capacity-pressure" }));
    } else {
      skipped.push(Object.freeze({ model: model.name, reasonCode: "retained-by-policy" }));
    }
  }

  const runningNames = new Set(runningSorted.map((model) => model.name));
  for (const model of [...(options.preloadModels ?? [])].sort()) {
    if (runningNames.has(model)) {
      skipped.push(Object.freeze({ model, reasonCode: "already-running" }));
    } else {
      steps.push(Object.freeze({ action: "load" as const, model, reasonCode: "explicit-preload" }));
    }
  }

  return Object.freeze({ steps: Object.freeze(steps), skipped: Object.freeze(skipped) });
}

/** Builds a manager from the validated adapter configuration. */
export function capacityManagerFromConfiguration(
  configuration: OllamaAdapterConfiguration,
  scheduler: OllamaScheduler,
): OllamaCapacityManager {
  return createOllamaCapacityManager({
    scheduler,
    maxConcurrentOperations: configuration.maxConcurrentOperations,
    perModelLimits: configuration.perModelConcurrency,
    capacityBudgetBytes: configuration.capacityBudgetBytes,
    capacitySafetyMarginBytes: configuration.capacitySafetyMarginBytes,
    queueLimit: configuration.queueLimit,
    defaultAdmissionTimeoutMs: configuration.admissionTimeoutMs,
  });
}
