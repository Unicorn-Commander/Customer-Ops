import { Module } from '@nestjs/common';
import { MembershipService } from './membership.service';
import { WorkspaceContextService } from './workspace-context.service';
import { WorkspaceMembershipGuard } from './workspace-membership.guard';
import { WorkspaceRoleGuard } from './workspace-role.guard';
import { WorkspaceProvisioningService } from './workspace-provisioning.service';
import { UcRegistryModule } from '../uc-registry/uc-registry.module';

/**
 * The tenancy seam (SUITE-IDENTITY §3/§5/§6). Bundles the membership gate, the
 * app-layer workspace resolver (the GUC chokepoint's app half), the opt-in route
 * guards (membership authz + role RBAC), and the self-serve provisioner
 * (open-signup onboarding). PrismaService is provided globally (PrismaModule), so
 * it is injectable here without an explicit import; the provisioner pulls in the
 * uc-registry mint seam.
 */
@Module({
  imports: [UcRegistryModule],
  providers: [
    MembershipService,
    WorkspaceContextService,
    WorkspaceMembershipGuard,
    WorkspaceRoleGuard,
    WorkspaceProvisioningService,
  ],
  exports: [
    MembershipService,
    WorkspaceContextService,
    WorkspaceMembershipGuard,
    WorkspaceRoleGuard,
    WorkspaceProvisioningService,
  ],
})
export class WorkspaceModule {}
