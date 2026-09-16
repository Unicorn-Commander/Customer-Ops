import { WorkspaceInvitationsService } from './workspace-invitations.service';
import { Module } from '@nestjs/common';
import { MembershipService } from './membership.service';
import { WorkspaceContextService } from './workspace-context.service';
import { WorkspaceMembershipGuard } from './workspace-membership.guard';
import { WorkspaceRoleGuard } from './workspace-role.guard';
import { WorkspaceProvisioningService } from './workspace-provisioning.service';
import { WorkspaceEntitlementsResolver } from './workspace-entitlements.resolver';
import { UcRegistryModule } from '../uc-registry/uc-registry.module';
import { EntitlementsModule } from '../../entitlements/entitlements.module';

/**
 * The tenancy seam (SUITE-IDENTITY §3/§5/§6). Bundles the membership gate, the
 * app-layer workspace resolver (the GUC chokepoint's app half), the opt-in route
 * guards (membership authz + role RBAC), and the self-serve provisioner
 * (open-signup onboarding). PrismaService is provided globally (PrismaModule), so
 * it is injectable here without an explicit import; the provisioner pulls in the
 * uc-registry mint seam.
 */
@Module({
  imports: [UcRegistryModule, EntitlementsModule],
  providers: [
    MembershipService,
    WorkspaceEntitlementsResolver,
    WorkspaceContextService,
    WorkspaceMembershipGuard,
    WorkspaceRoleGuard,
    WorkspaceProvisioningService,
    WorkspaceInvitationsService,
  ],
  exports: [
    MembershipService,
    WorkspaceEntitlementsResolver,
    WorkspaceContextService,
    WorkspaceMembershipGuard,
    WorkspaceRoleGuard,
    WorkspaceProvisioningService,
    WorkspaceInvitationsService,
  ],
})
export class WorkspaceModule {}
