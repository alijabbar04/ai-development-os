import type { Clock } from "@ai-dev-os/providers";

/**
 * Deterministic clock + timer scheduler. Fake providers wait through it, so
 * tests advance virtual time instead of sleeping. `advance` fires due
 * timers in time order (FIFO within the same instant) and moves the clock.
 */
export interface ManualScheduler extends Clock {
  advance(milliseconds: number): void;
  set(iso: string): void;
  /** Resolves after `milliseconds` of VIRTUAL time. */
  wait(milliseconds: number): Promise<void>;
  readonly pendingTimers: number;
}

export const TESTKIT_EPOCH = "2026-08-02T12:00:00.000Z";

interface PendingTimer {
  readonly dueAt: number;
  readonly order: number;
  readonly fire: () => void;
}

export function createManualScheduler(startIso: string = TESTKIT_EPOCH): ManualScheduler {
  let current = new Date(startIso).valueOf();
  let orderCounter = 0;
  const timers: PendingTimer[] = [];

  function fireDue(): void {
    for (;;) {
      const due = timers
        .filter((timer) => timer.dueAt <= current)
        .sort((a, b) => a.dueAt - b.dueAt || a.order - b.order)[0];
      if (due === undefined) {
        return;
      }
      timers.splice(timers.indexOf(due), 1);
      due.fire();
    }
  }

  return {
    now: () => new Date(current),
    set(iso: string): void {
      current = new Date(iso).valueOf();
      fireDue();
    },
    advance(milliseconds: number): void {
      current += milliseconds;
      fireDue();
    },
    wait(milliseconds: number): Promise<void> {
      if (milliseconds <= 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        orderCounter += 1;
        timers.push({ dueAt: current + milliseconds, order: orderCounter, fire: resolve });
      });
    },
    get pendingTimers(): number {
      return timers.length;
    },
  };
}

/**
 * Immediate scheduler: virtual waits resolve on the next microtask and the
 * clock ticks forward by the waited amount, keeping event timestamps
 * strictly deterministic without any real sleeping.
 */
export function createImmediateScheduler(startIso: string = TESTKIT_EPOCH): ManualScheduler {
  const inner = createManualScheduler(startIso);
  return {
    now: inner.now,
    set: inner.set,
    advance: inner.advance,
    async wait(milliseconds: number): Promise<void> {
      await Promise.resolve();
      inner.advance(Math.max(0, milliseconds));
    },
    get pendingTimers(): number {
      return inner.pendingTimers;
    },
  };
}

/** Deterministic id source: op-000001, op-000002, ... */
export function createSequentialIds(prefix = "op"): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-${counter.toString().padStart(6, "0")}`;
  };
}
