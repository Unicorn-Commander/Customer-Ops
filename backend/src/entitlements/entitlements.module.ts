import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EntitlementsService } from './entitlements.service';

/**
 * Entitlements source module. Exports EntitlementsService; the global
 * EntitlementsInterceptor (registered in AppModule as an APP_INTERCEPTOR) consumes
 * it to stamp endpoint-sourced entitlements onto the request after auth.
 */
@Module({
  imports: [ConfigModule],
  providers: [EntitlementsService],
  exports: [EntitlementsService],
})
export class EntitlementsModule {}
