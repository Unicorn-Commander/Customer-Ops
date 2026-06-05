import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { AuthModule } from '../auth/auth.module';
import { ContactOpsModule } from '../contact-ops/contact-ops.module';
import { LeadIntakeService } from './lead-intake.service';
import { LeadLabelResolver } from './lead-label.port';
import { LeadIntakeController } from './lead-intake.controller';

/**
 * The lead-ingestion module (Phase 6 — the `ingest_lead` keystone).
 *
 * Owns the durable leadgen → Customer-Ops pipeline (the `lead_intakes` buffer +
 * the resolve/reconcile engine). Depends only on WorkspaceModule (the RLS
 * chokepoint) + ContactOpsModule (the identity-upsert write seam) — NOT on
 * CustomersModule: it writes the Customer projection directly via the
 * workspace-bound tx, so there is no module cycle.
 *
 * It also PROVIDES the `LeadLabelResolver` (bound to the same service instance),
 * which CustomersModule consumes @Optional to render provisional leads with a
 * real label while Contact-Ops is dormant. Exporting the service lets the MCP
 * module register the agent-facing ingest tools against one implementation.
 */
@Module({
  imports: [WorkspaceModule, AuthModule, ContactOpsModule],
  controllers: [LeadIntakeController],
  providers: [
    LeadIntakeService,
    { provide: LeadLabelResolver, useExisting: LeadIntakeService },
  ],
  exports: [LeadIntakeService, LeadLabelResolver],
})
export class LeadIntakeModule {}
