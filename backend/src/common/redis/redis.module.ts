import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * The shared Redis module. Global so the shared-state services (single-use
 * store, pending-action store, rate-limit storage) can inject the one
 * RedisService without every feature module re-importing this one.
 *
 * ConfigModule is already global (app.module), so RedisService resolves its
 * `REDIS_URL` everywhere. Degrade-clean: no `REDIS_URL` → in-process fallback.
 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
