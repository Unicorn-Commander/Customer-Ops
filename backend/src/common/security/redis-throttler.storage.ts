import { Logger } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { RedisService } from '../redis/redis.service';

/**
 * RedisThrottlerStorage — a shared, cross-replica rate-limit counter.
 *
 * @nestjs/throttler defaults to an in-process counter, so each replica limits
 * independently: N replicas => N× the intended budget, and a restart forgets
 * every window. This storage keeps the counter in shared Redis with a
 * fixed-window `INCR` + `PEXPIRE`, so every replica shares one budget.
 *
 * ttl is MILLISECONDS (the guard passes the throttler's resolved ttl, and the
 * stock storage divides it by 1000 — we mirror that). `timeToExpire` is seconds.
 *
 * DEGRADE-CLEAN: on any Redis error it falls back to a tiny in-process
 * fixed-window map so limiting still happens (per-replica) and the request path
 * never fails because of the limiter — fail-safe, never fail-open to unlimited.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  /** In-process fallback window: key → { count, resetAt(ms) }. */
  private readonly local = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly redis: RedisService) {}

  async increment(key: string, ttl: number): Promise<ThrottlerStorageRecord> {
    const ttlMs = Math.max(1, Math.floor(ttl));
    const client = this.redis.client;
    const storageKey = `throttle:${key}`;

    if (client) {
      try {
        // Fixed window: INCR the counter; the FIRST hit in a window (result === 1)
        // stamps the window's TTL. A pipeline keeps it to one round-trip.
        const results = await client.multi().incr(storageKey).pTTL(storageKey).exec();
        const totalHits = Number(results?.[0] ?? 1);
        let pttl = Number(results?.[1] ?? -1);

        // First hit (or a key with no expiry — e.g. a prior crash mid-window):
        // (re)apply the window TTL so it can never live forever.
        if (totalHits === 1 || pttl < 0) {
          await client.pExpire(storageKey, ttlMs);
          pttl = ttlMs;
        }
        return { totalHits, timeToExpire: Math.ceil(pttl / 1000) };
      } catch (err) {
        this.logger.warn(
          `RedisThrottlerStorage error (falling back to in-memory window): ${(err as Error).message}`,
        );
      }
    }

    return this.incrementLocal(storageKey, ttlMs);
  }

  /** In-process fixed-window fallback. */
  private incrementLocal(key: string, ttlMs: number): ThrottlerStorageRecord {
    const now = Date.now();
    let entry = this.local.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + ttlMs };
      this.local.set(key, entry);
    }
    entry.count++;
    return { totalHits: entry.count, timeToExpire: Math.ceil((entry.resetAt - now) / 1000) };
  }
}
