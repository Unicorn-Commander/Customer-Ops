import { Module } from '@nestjs/common';
import { FederationWorkspaceMapModule } from '../common/federation/federation-workspace-map.module';
import { ContactOpsOrgLookupClient } from './contact-ops-org-lookup.client';
import { ContactOpsMapProvisioner } from './contact-ops-map.provisioner';

/**
 * The contact-ops map writer: Contact-Ops' org lookup (#42) + the one place a
 * `contact-ops` federation_workspace_map row is written from it. Imported by
 * contract-D provisioning and by the owner connection route (which checks the
 * same lookup before it writes); PrismaService and ConfigService are global.
 */
@Module({
  imports: [FederationWorkspaceMapModule],
  providers: [ContactOpsOrgLookupClient, ContactOpsMapProvisioner],
  exports: [ContactOpsMapProvisioner, ContactOpsOrgLookupClient],
})
export class ContactOpsMapModule {}
