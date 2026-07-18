import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';

/**
 * RedisService — the single owner of the shared Redis connection + its lifecycle.
 *
 * DEGRADE-CLEAN (binding): Redis is OPTIONAL. When `REDIS_URL` is unset `.client`
 * is `null` and every consumer (single-use security state, pending-action store,
 * rate-limit storage) transparently falls back to its in-process implementation
 * — the exact single-replica behavior that shipped before. Redis is purely
 * additive: it is what lets a 2nd replica share single-use nonces / pending
 * confirms / rate-limit counters instead of each replica keeping its own.
 *
 * FAIL-SAFE: a Redis outage must NOT take the API down. The initial connect is
 * best-effort (log-and-continue) and node-redis keeps retrying in the
 * background; consumers wrap every command in try/catch and degrade to memory.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  /** The shared client, or `null` when Redis is not configured. Read AFTER
   *  onModuleInit (Nest guarantees init-before-use for injected consumers). */
  private _client: RedisClientType | null = null;

  constructor(private readonly config: ConfigService) {}

  /** The shared client, or `null` when Redis is not configured (in-memory mode). */
  get client(): RedisClientType | null {
    return this._client;
  }

  /** Whether the shared Redis plane is configured (a `REDIS_URL` was provided). */
  get enabled(): boolean {
    return this._client !== null;
  }

  async onModuleInit(): Promise<void> {
    const url = this.config.get<string>('REDIS_URL')?.trim();
    if (!url) {
      this.logger.log(
        'REDIS_URL not set — shared state (single-use nonces / pending confirms / rate ' +
          'limits) uses the in-process fallback (correct for a single replica).',
      );
      return;
    }

    const client: RedisClientType = createClient({
      url,
      socket: {
        // Bounded backoff so a persistent outage does not spin hot; consumers
        // degrade to in-memory while it reconnects.
        reconnectStrategy: (retries) => Math.min(retries * 200, 5_000),
      },
    });

    // REQUIRED: node-redis emits 'error' on every failed reconnect; an unhandled
    // 'error' event would crash the process. Swallow-and-log keeps the API up.
    client.on('error', (err: Error) => {
      this.logger.warn(`Redis client error (degrading to in-memory): ${err.message}`);
    });

    this._client = client;
    try {
      await client.connect();
      this.logger.log('Redis connected — shared state plane active (multi-replica safe).');
    } catch (err) {
      this.logger.warn(
        `Redis initial connect failed (${(err as Error).message}) — starting with the ` +
          'in-memory fallback; node-redis keeps retrying in the background.',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this._client) return;
    try {
      // Graceful close; force-disconnect if the server is unreachable.
      await this._client.quit();
    } catch {
      try {
        await this._client.disconnect();
      } catch {
        /* already gone */
      }
    }
  }
}
