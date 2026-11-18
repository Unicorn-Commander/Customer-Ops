import { DynamicModule, Module } from '@nestjs/common';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { UcRegistryModule } from '../common/uc-registry/uc-registry.module';
import { AuditModule } from '../audit/audit.module';
import { FederationAuthModule } from '../common/federation/federation-auth.module';
import { FederationWorkspaceMapModule } from '../common/federation/federation-workspace-map.module';
import { ContactOpsMapModule } from '../contact-ops/contact-ops-map.module';
import { MemberPauseController } from './member-pause.controller';
import { provisioningEnabled } from './provisioning.config';
import { ProvisioningController } from './provisioning.controller';
import { ProvisioningGuard } from './provisioning.guard';
import { ProvisioningJtiStore } from './provisioning-jti.store';
import { PROVISIONING_JTI_STORE, ProvisioningTokenService } from './provisioning-token.service';
import { ProvisioningService } from './provisioning.service';

/**
 * Control-plane provisioning (contract D). `register()` with the flag off
 * returns an empty module: no controller, no provider, and every provisioning
 * path answers the framework's own 404, exactly as before this module existed.
 */
@Module({})
export class ProvisioningModule {
  static register(enabled: boolean = provisioningEnabled()): DynamicModule {
    if (!enabled) return { module: ProvisioningModule };
    return {
      module: ProvisioningModule,
      imports: [
        WorkspaceModule,
        UcRegistryModule,
        AuditModule,
        FederationAuthModule,
        FederationWorkspaceMapModule,
        ContactOpsMapModule,
      ],
      controllers: [ProvisioningController, MemberPauseController],
      providers: [
        ProvisioningService,
        ProvisioningTokenService,
        ProvisioningGuard,
        { provide: PROVISIONING_JTI_STORE, useFactory: () => new ProvisioningJtiStore() },
      ],
    };
  }
}
