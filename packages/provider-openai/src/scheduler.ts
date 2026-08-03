/**
 * Injectable time source, cancellable delay, and jitter source used
 * everywhere in this package. Production code uses
 * {@link systemOpenAiScheduler}; deterministic tests wrap a manual
 * scheduler so polling backoff, deadlines, and cancellation races run on
 * virtual time with no real sleeps and no real randomness.
 */
export interface OpenAiDelayHandle {
  readonly promise: Promise<void>;
  /** Cancels the delay; the promise then never resolves. Idempotent. */
  cancel(): void;
}

export interface OpenAiScheduler {
  now(): Date;
  delay(milliseconds: number): OpenAiDelayHandle;
}

/** Returns a value in [0, 1). Injected so backoff jitter stays deterministic. */
export type JitterSource = () => number;

export const systemOpenAiScheduler: OpenAiScheduler = Object.freeze({
  now: (): Date => new Date(),
  delay(milliseconds: number): OpenAiDelayHandle {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const promise = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timer = null;
        if (!cancelled) {
          resolve();
        }
      }, Math.max(0, milliseconds));
    });
    return {
      promise,
      cancel(): void {
        cancelled = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      },
    };
  },
});

/** Adapts a manual clock/waiter (for example the provider-testkit ManualScheduler). */
export function openAiSchedulerFromManual(manual: {
  now(): Date;
  wait(milliseconds: number): Promise<void>;
}): OpenAiScheduler {
  return Object.freeze({
    now: () => manual.now(),
    delay(milliseconds: number): OpenAiDelayHandle {
      let cancelled = false;
      const promise = new Promise<void>((resolve) => {
        void manual.wait(Math.max(0, milliseconds)).then(() => {
          if (!cancelled) {
            resolve();
          }
        });
      });
      return {
        promise,
        cancel(): void {
          cancelled = true;
        },
      };
    },
  });
}

/**
 * Deterministic jitter: a fixed sequence so tests observe exact delays.
 * Production callers pass a real entropy source.
 */
export function fixedJitterSource(values: readonly number[] = [0.5]): JitterSource {
  let index = 0;
  return () => {
    const value = values[index % values.length] ?? 0.5;
    index += 1;
    return Math.min(0.999_999, Math.max(0, value));
  };
}

export interface BackoffPlan {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

/**
 * Bounded exponential backoff with proportional jitter. `attempt` is
 * zero-based. The result never exceeds `maxDelayMs` and is always a
 * non-negative safe integer.
 */
export function computeBackoffMs(plan: BackoffPlan, attempt: number, jitter: JitterSource): number {
  const exponent = Math.min(attempt, 30);
  const uncapped = plan.baseDelayMs * 2 ** exponent;
  const capped = Math.min(uncapped, plan.maxDelayMs);
  const spread = capped * plan.jitterRatio;
  // Jitter is symmetric around the capped delay and then re-clamped, so a
  // hostile jitter source can never produce a negative or unbounded delay.
  const jittered = capped - spread / 2 + spread * jitter();
  const bounded = Math.min(plan.maxDelayMs, Math.max(0, jittered));
  return Number.isFinite(bounded) ? Math.floor(bounded) : plan.maxDelayMs;
}
