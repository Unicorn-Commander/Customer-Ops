import { Module } from '@nestjs/common';
import { UcRegistryClient } from './uc-registry.client';

/**
 * The uc-registry seam (SUITE-IDENTITY §0.1 / §4): the suite authority for
 * workspace ids. Bundles the mint client so self-serve onboarding can obtain a
 * canonical workspace id (degrade-clean to a local uuidv7 when the registry is
 * unconfigured/unreachable). ConfigModule is global, so ConfigService injects
 * without an explicit import.
 */
@Module({
  providers: [UcRegistryClient],
  exports: [UcRegistryClient],
})
export class UcRegistryModule {}
