/**
 * Injectable time source and cancellable delay used everywhere in this
 * package. Production code uses {@link systemOllamaScheduler}; deterministic
 * tests wrap a manual scheduler so cancellation, deadline, and queue races
 * run on virtual time without real sleeps.
 */
export interface OllamaDelayHandle {
  readonly promise: Promise<void>;
  /** Cancels the delay; the promise then never resolves. Idempotent. */
  cancel(): void;
}

export interface OllamaScheduler {
  now(): Date;
  delay(milliseconds: number): OllamaDelayHandle;
}

export const systemOllamaScheduler: OllamaScheduler = Object.freeze({
  now: (): Date => new Date(),
  delay(milliseconds: number): OllamaDelayHandle {
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

/**
 * Adapts a manual clock/waiter (for example the provider-testkit
 * ManualScheduler) to the scheduler contract. Cancelled delays simply leave
 * their virtual timer pending, which is harmless in tests.
 */
export function ollamaSchedulerFromManual(manual: {
  now(): Date;
  wait(milliseconds: number): Promise<void>;
}): OllamaScheduler {
  return Object.freeze({
    now: () => manual.now(),
    delay(milliseconds: number): OllamaDelayHandle {
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
