/**
 * Where the counters live.
 *
 * One method, because one is all a fixed window needs: count a hit and say
 * what the window looks like now. A Redis or a Postgres store implements
 * the same method and returns a promise — the hook awaits either.
 *
 * @module
 */

/** The state of one key's window after a hit was counted. */
export interface WindowState {
  /** Hits in the current window, this one included. */
  readonly count: number;

  /** When the window ends, as epoch milliseconds. */
  readonly resetAt: number;
}

/**
 * A counter store.
 *
 * Implement it to move the counters out of the process — a fleet of
 * servers behind a balancer needs a shared one, and this is the seam for
 * it. The framework never keeps a second copy of the state.
 *
 * @example
 * ```ts
 * const redisStore: RateLimitStore = {
 *   hit: async (key, windowMs) => {
 *     const count = await redis.incr(key);
 *     if (count === 1) await redis.pexpire(key, windowMs);
 *     return { count, resetAt: Date.now() + (await redis.pttl(key)) };
 *   },
 * };
 * ```
 */
export interface RateLimitStore {
  /**
   * Counts one hit against a key and returns the window it fell into.
   *
   * A key that has no window, or whose window has ended, starts a new one
   * of `windowMs` milliseconds.
   */
  hit: (key: string, windowMs: number) => WindowState | Promise<WindowState>;
}

/**
 * Counters in this process, in a plain `Map`.
 *
 * Enough for one server and for tests; a fleet needs a shared store, and
 * this is deliberately not pretending otherwise.
 *
 * Expired entries are dropped in an amortized sweep rather than by a
 * timer: a background interval would keep the process alive and would have
 * to be stopped by whoever created the store — a lifetime this package has
 * no way to own.
 */
export function memoryStore(): RateLimitStore {
  const windows = new Map<string, { count: number; resetAt: number }>();

  let sweepAt = 64;

  return {
    hit: (key, windowMs) => {
      const now = Date.now();
      const existing = windows.get(key);

      if (existing && existing.resetAt > now) {
        existing.count += 1;

        return { count: existing.count, resetAt: existing.resetAt };
      }

      if (windows.size >= sweepAt) {
        sweep(windows, now);
        sweepAt = Math.max(64, windows.size * 2);
      }

      const started = { count: 1, resetAt: now + windowMs };

      windows.set(key, started);

      return { count: started.count, resetAt: started.resetAt };
    },
  };
}

function sweep(windows: Map<string, { resetAt: number }>, now: number): void {
  for (const [key, window] of windows) {
    if (window.resetAt <= now) {
      windows.delete(key);
    }
  }
}
