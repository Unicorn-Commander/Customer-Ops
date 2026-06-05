import { Global, Module } from '@nestjs/common';
import { BrigadeTokenSource } from './brigade-token-source';

/**
 * The shared federation-auth module. Global so every federation client
 * (Contact-Ops, Meeting-Ops, Accounting-Ops, …) can inject the one
 * BrigadeTokenSource without each feature module re-importing it. ConfigModule is
 * already global (app.module), so BrigadeTokenSource resolves everywhere.
 */
@Global()
@Module({
  providers: [BrigadeTokenSource],
  exports: [BrigadeTokenSource],
})
export class FederationAuthModule {}
