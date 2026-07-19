import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FederationWorkspaceMapService } from './federation-workspace-map.service';

/**
 * Global so every sibling *-ops federation client can inject the map without each
 * client module re-importing it (PrismaModule is @Global the same way). Exports
 * the service; ConfigModule supplies the one-time FEDERATION_WORKSPACE_MAP_SEED.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [FederationWorkspaceMapService],
  exports: [FederationWorkspaceMapService],
})
export class FederationWorkspaceMapModule {}
