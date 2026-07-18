import { Global, Module } from '@nestjs/common';
import { SingleUseTokenStore } from './single-use-token.store';
import { PendingActionStore } from './pending-action.store';

/**
 * Shared security-state stores — the single-use token guard (M365 OAuth nonce)
 * and the pending confirm-gated-action store (Relations Officer). Both back onto
 * the shared RedisService (RedisModule, global) and degrade to in-process when
 * Redis is unconfigured.
 *
 * Global so the M365 + Relations-Officer modules inject them without re-wiring.
 */
@Global()
@Module({
  providers: [SingleUseTokenStore, PendingActionStore],
  exports: [SingleUseTokenStore, PendingActionStore],
})
export class SecurityStoreModule {}
