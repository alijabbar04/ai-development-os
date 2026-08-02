/**
 * Minimal FIFO async mutex used by adapters to serialize transactions and
 * closure. Not part of the persistence contract; exported for adapter
 * implementations only.
 */
export class AsyncMutex {
  #tail: Promise<void> = Promise.resolve();

  /** Runs `work` exclusively, in submission order. */
  async run<T>(work: () => Promise<T> | T): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}
