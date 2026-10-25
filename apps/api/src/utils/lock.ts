/**
 * Minimal FIFO async mutex. CovaFlux runs as a single process on SQLite, so an
 * in-process lock is enough to give a section a single writer.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * Serializes generate+apply of the Headscale policy so an older snapshot of
 * the database can never be applied after a newer one (e.g. re-granting a
 * share that was just revoked).
 */
export const policyLock = new Mutex();

/**
 * Serializes node ownership reads/writes: Headscale -> DB sync, owner
 * transfer and owner-guarded node mutations. Prevents a sync that read a
 * stale Headscale snapshot from overwriting a newer owner, and an old owner
 * from acting on a node mid-transfer.
 */
export const nodeLock = new Mutex();
