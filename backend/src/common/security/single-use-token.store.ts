import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

/**
 * SingleUseTokenStore — the shared "has this single-use token been consumed?"
 * boundary.
 *
 * Some security tokens must be usable EXACTLY once (a replayed one is rejected):
 * the M365 OAuth `state` nonce is the canonical example. v1 tracked consumed
 * tokens in a per-process Map, which is only correct on a single replica — a
 * replayed token that lands on a 2nd replica would not be seen as consumed.
 *
 * This store moves that boundary to shared Redis when configured, using an
 * atomic `SET key value NX PX ttl`: the FIRST caller creates the key (→ "first
 * use"), any later caller finds it already present (→ "replay"). The key
 * self-expires at the token's own TTL so the set can never grow unbounded.
 *
 * DEGRADE-CLEAN: with no Redis (or on a transient Redis error) it falls back to
 * an in-process Map with lazy TTL pruning — the exact v1 single-replica
 * behavior. Fail-safe: a Redis error during consume is treated as "first use"
 * (allow) only after the local map also has no record, matching the prior
 * single-replica guarantee without hard-failing the user's flow.
 */
@Injectable()
export class SingleUseTokenStore {
  private readonly logger = new Logger(SingleUseTokenStore.name);

  /** In-process fallback: fully-qualified key → expiry epoch ms. */
  private readonly local = new Map<string, number>();

  constructor(private readonly redis: RedisService) {}

  /**
   * Atomically record `id` as consumed within `namespace`. Returns `true` when
   * this is the FIRST time the token is seen (the caller may proceed), `false`
   * when it was already consumed (a replay — reject).
   *
   * @param namespace  logical bucket, e.g. 'm365:oauth-state'.
   * @param id         the single-use token id (a nonce / jti).
   * @param ttlSeconds how long the consumed record must be retained (== the
   *                   token's own remaining lifetime; after that a replay is
   *                   impossible anyway because the token itself has expired).
   */
  async consume(namespace: string, id: string, ttlSeconds: number): Promise<boolean> {
    const key = `${namespace}:${id}`;
    const ttl = Math.max(1, Math.ceil(ttlSeconds));
    const client = this.redis.client;

    if (client) {
      try {
        // NX => only set if absent; the return is 'OK' on create, null on collision.
        const res = await client.set(key, '1', { NX: true, EX: ttl });
        return res === 'OK';
      } catch (err) {
        // Fall through to the in-memory guard (fail-safe: still single-use within
        // this replica; a cross-replica replay during a Redis outage is the same
        // exposure as the pre-Redis single-replica deploy).
        this.logger.warn(
          `SingleUseTokenStore Redis consume failed for ${namespace} (using in-memory guard): ${(err as Error).message}`,
        );
      }
    }

    // In-process fallback.
    this.pruneLocal();
    if (this.local.has(key)) return false;
    this.local.set(key, Date.now() + ttl * 1000);
    return true;
  }

  /** Drop expired in-memory records so the fallback set can't grow unbounded. */
  private pruneLocal(): void {
    const now = Date.now();
    for (const [k, exp] of this.local) {
      if (exp <= now) this.local.delete(k);
    }
  }
}
