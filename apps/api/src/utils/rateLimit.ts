/**
 * Fixed-window failure counter for login attempts, kept in memory (single
 * process). A key is blocked once it reaches maxFailures within windowMs.
 * Callers count an attempt before the slow check and release() it on success,
 * so concurrent attempts cannot all slip past the limit.
 */
export class FailureLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly maxFailures: number, private readonly windowMs: number) {}

  /** Milliseconds until the key may try again, or 0 when not blocked. */
  retryAfterMs(key: string, now = Date.now()): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    if (entry.resetAt <= now) {
      this.entries.delete(key);
      return 0;
    }
    return entry.count >= this.maxFailures ? entry.resetAt - now : 0;
  }

  /** Record a failure; returns the failure count in the current window. */
  recordFailure(key: string, now = Date.now()): number {
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
      this.prune(now);
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }

  reset(key: string) {
    this.entries.delete(key);
  }

  /** Undo one recorded attempt (it turned out to be a success). */
  release(key: string) {
    const entry = this.entries.get(key);
    if (entry && entry.count > 0) entry.count -= 1;
  }

  private prune(now: number) {
    if (this.entries.size < 10_000) return;
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
  }
}
