/**
 * A per-TOKEN fixed-window counter, and a bounded replay cache.
 *
 * The Nest `@Throttle` guard counts per IP. That is the wrong axis for a share
 * link: the thing worth defending is one quote's six-digit code, and a grind
 * against it comes from many addresses. These two counters are the per-token
 * axis, kept deliberately small and dependency-free so L1 can swap the storage
 * for the shared Redis plane without touching a call site.
 *
 * Both structures are BOUNDED. An in-memory map keyed by attacker-supplied
 * input is a memory-exhaustion bug wearing a rate-limiter costume: every entry
 * here expires, and the map is swept (and, past a hard cap, evicted
 * oldest-first) on write.
 */

export interface RateVerdict {
  ok: boolean;
  /** Seconds until the window rolls — sent as `Retry-After`. */
  retry_after_s: number;
  remaining: number;
}

interface Window {
  count: number;
  resets_at: number;
}

const MAX_TOKENS_TRACKED = 5_000;

export class TokenRateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Charge `weight` against this token's window. */
  hit(token: string, weight = 1): RateVerdict {
    const t = this.now();
    this.sweep(t);
    const existing = this.windows.get(token);
    const win =
      existing && existing.resets_at > t ? existing : { count: 0, resets_at: t + this.windowMs };
    win.count += weight;
    // Re-insert so the map's insertion order tracks recency for eviction.
    this.windows.delete(token);
    this.windows.set(token, win);
    const retry_after_s = Math.max(1, Math.ceil((win.resets_at - t) / 1000));
    return {
      ok: win.count <= this.limit,
      retry_after_s,
      remaining: Math.max(0, this.limit - win.count),
    };
  }

  private sweep(t: number): void {
    if (this.windows.size < MAX_TOKENS_TRACKED) {
      // Cheap opportunistic expiry: only pay for a full pass when it matters.
      if (this.windows.size % 64 !== 0) return;
      for (const [key, win] of this.windows) if (win.resets_at <= t) this.windows.delete(key);
      return;
    }
    for (const [key, win] of this.windows) if (win.resets_at <= t) this.windows.delete(key);
    // Still over the cap after expiry: drop the oldest entries. Losing a live
    // window lets a few extra requests through; unbounded growth loses the node.
    while (this.windows.size >= MAX_TOKENS_TRACKED) {
      const oldest = this.windows.keys().next();
      if (oldest.done) break;
      this.windows.delete(oldest.value);
    }
  }

  /** Test seam. */
  clear(): void {
    this.windows.delete('');
    this.windows.clear();
  }
}

/**
 * A bounded `Idempotency-Key` → outcome cache (A10). Entries expire, and the
 * map never exceeds `maxEntries` — a replay cache keyed by a client-supplied
 * header is exactly the sort of map that grows until the process dies.
 */
export class ReplayCache<T> {
  private readonly entries = new Map<string, { value: T; expires_at: number }>();

  constructor(
    private readonly ttlMs = 15 * 60_000,
    private readonly maxEntries = 2_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expires_at <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T): void {
    const t = this.now();
    for (const [k, v] of this.entries) {
      if (v.expires_at > t) break; // insertion order ⇒ the rest are younger
      this.entries.delete(k);
    }
    this.entries.delete(key);
    this.entries.set(key, { value, expires_at: t + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
