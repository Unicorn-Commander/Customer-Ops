import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

/** One stored entry (value + absolute expiry) in the in-process fallback map. */
interface LocalEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * PendingActionStore — a shared, TTL'd, single-use store for small server-side
 * "pending confirm" records (the Relations Officer's confirm-gated writes are
 * the canonical consumer).
 *
 * The safety contract of a confirm-gated write is: mint a pending action →
 * return only a safe projection → the user confirms → CONSUME it exactly once
 * and execute. v1 kept these in a per-process Map, correct for a single replica
 * only (a confirm that lands on a different replica than the propose would miss
 * the pending record, and a restart dropped every in-flight confirm).
 *
 * This store moves that record to shared Redis when configured. `take` is an
 * ATOMIC get-and-delete (Redis GETDEL), so even two racing confirms can never
 * both execute the same action — exactly the single-use guarantee. Keys carry
 * the action's own TTL, so an unconfirmed action self-expires.
 *
 * DEGRADE-CLEAN: with no Redis (or a transient Redis error) it uses an
 * in-process Map with lazy TTL pruning — the v1 single-replica behavior.
 */
@Injectable()
export class PendingActionStore {
  private readonly logger = new Logger(PendingActionStore.name);

  private readonly local = new Map<string, LocalEntry<unknown>>();

  constructor(private readonly redis: RedisService) {}

  /** Store `value` under (namespace,id) for `ttlMs`. Overwrites an existing id. */
  async put<T>(namespace: string, id: string, value: T, ttlMs: number): Promise<void> {
    const key = `${namespace}:${id}`;
    const ttl = Math.max(1, Math.ceil(ttlMs));
    const client = this.redis.client;
    if (client) {
      try {
        await client.set(key, JSON.stringify(value), { PX: ttl });
        return;
      } catch (err) {
        this.logger.warn(
          `PendingActionStore Redis put failed for ${namespace} (using in-memory): ${(err as Error).message}`,
        );
      }
    }
    this.pruneLocal();
    this.local.set(key, { value, expiresAt: Date.now() + ttl });
  }

  /**
   * Atomically read AND remove the entry (single-use consume). Returns the
   * stored value, or `null` when it is missing / already consumed / expired.
   */
  async take<T>(namespace: string, id: string): Promise<T | null> {
    const key = `${namespace}:${id}`;
    const client = this.redis.client;
    if (client) {
      try {
        // GETDEL is atomic: the value is returned AND the key removed in one op,
        // so a racing second `take` gets null (can never double-execute).
        const raw = await client.getDel(key);
        return raw ? (JSON.parse(raw) as T) : null;
      } catch (err) {
        this.logger.warn(
          `PendingActionStore Redis take failed for ${namespace} (using in-memory): ${(err as Error).message}`,
        );
      }
    }
    this.pruneLocal();
    const entry = this.local.get(key) as LocalEntry<T> | undefined;
    if (!entry) return null;
    this.local.delete(key);
    if (entry.expiresAt <= Date.now()) return null;
    return entry.value;
  }

  /** Drop expired in-memory entries so the fallback map can't grow unbounded. */
  private pruneLocal(): void {
    const now = Date.now();
    for (const [k, e] of this.local) {
      if (e.expiresAt <= now) this.local.delete(k);
    }
  }
}
