/**
 * Injected time. Library code never reads the wall clock directly and never
 * calls the global timer functions, so deadline, lease, and cancellation
 * behaviour is deterministic under test.
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = Object.freeze({ now: (): Date => new Date() });

export interface ScheduledTask {
  cancel(): void;
}

export interface Scheduler {
  /** Runs `callback` after at least `delayMs`. Never throws for the caller. */
  schedule(delayMs: number, callback: () => void): ScheduledTask;
}

/**
 * Real timers. The handle is unref'd so a pending deadline never keeps a
 * host process alive on its own.
 */
export const systemScheduler: Scheduler = Object.freeze({
  schedule(delayMs: number, callback: () => void): ScheduledTask {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return Object.freeze({
      cancel(): void {
        clearTimeout(timer);
      },
    });
  },
});

export interface ManualTime extends Clock, Scheduler {
  /** Advances virtual time, firing every task whose deadline has passed. */
  advance(ms: number): void;
  /** Tasks still pending. Used to prove timers are released. */
  pendingCount(): number;
}

interface PendingTask {
  readonly at: number;
  readonly sequence: number;
  readonly callback: () => void;
  cancelled: boolean;
}

/**
 * A manual clock and scheduler pair. Timers fire in deadline order and, for
 * equal deadlines, in scheduling order, so tests replay identically.
 */
export function createManualTime(startIso = "2026-08-02T00:00:00.000Z"): ManualTime {
  let current = new Date(startIso).valueOf();
  if (!Number.isFinite(current)) {
    throw new TypeError("createManualTime requires a valid ISO-8601 instant.");
  }
  let sequence = 0;
  let tasks: PendingTask[] = [];

  return Object.freeze({
    now(): Date {
      return new Date(current);
    },
    schedule(delayMs: number, callback: () => void): ScheduledTask {
      const task: PendingTask = {
        at: current + Math.max(0, delayMs),
        sequence: (sequence += 1),
        callback,
        cancelled: false,
      };
      tasks.push(task);
      return Object.freeze({
        cancel(): void {
          task.cancelled = true;
        },
      });
    },
    advance(ms: number): void {
      const target = current + Math.max(0, ms);
      for (;;) {
        const due = tasks
          .filter((task) => !task.cancelled && task.at <= target)
          .sort((a, b) => (a.at === b.at ? a.sequence - b.sequence : a.at - b.at));
        const next = due[0];
        if (next === undefined) {
          break;
        }
        next.cancelled = true;
        current = Math.max(current, next.at);
        next.callback();
      }
      current = target;
      tasks = tasks.filter((task) => !task.cancelled);
    },
    pendingCount(): number {
      return tasks.filter((task) => !task.cancelled).length;
    },
  });
}
