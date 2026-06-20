import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { AuthModule } from '../auth/auth.module';
import { ContactOpsModule } from '../contact-ops/contact-ops.module';
import { LeadIntakeModule } from '../lead-intake/lead-intake.module';
import { OverviewService } from './overview.service';
import { OverviewController } from './overview.controller';

/**
 * The command-center OVERVIEW module.
 *
 * Wires the OverviewService (workspace-wide rollups of the LOCAL invoice /
 * outreach / email link tables) + its REST surface. It REUSES the existing
 * tenancy + federation seams rather than forking any:
 *   - WorkspaceModule   — the GUC chokepoint + membership guard (RLS tenancy +
 *     RBAC); every aggregate read runs inside the workspace-bound transaction.
 *   - AuthModule        — the JwtAuthGuard for the workspace-scoped routes.
 *   - ContactOpsModule  — the contact federation port: the SAME batch contact
 *     name-resolution the Relationships list uses (contacts resolved at read
 *     time, never copied).
 *   - LeadIntakeModule  — provides LeadLabelResolver (consumed @Optional in the
 *     service) so an ingested lead on a link row renders a real provisional
 *     label while Contact-Ops is dormant — matching the Relationships list.
 *
 * No new scoped table, no new RLS policy, no federation fan-out: these are
 * read-only aggregations of links Customer-Ops already persists.
 */
@Module({
  imports: [WorkspaceModule, AuthModule, ContactOpsModule, LeadIntakeModule],
  providers: [OverviewService],
  controllers: [OverviewController],
  exports: [OverviewService],
})
export class OverviewModule {}
