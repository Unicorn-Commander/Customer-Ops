import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { AuthModule } from '../auth/auth.module';
import { ContactOpsModule } from '../contact-ops/contact-ops.module';
import { AccountingOpsModule } from '../accounting-ops/accounting-ops.module';
import { OutreachOpsModule } from '../outreach-ops/outreach-ops.module';
import { EmailOpsModule } from '../email-ops/email-ops.module';
import { MeetingOpsModule } from '../meeting-ops/meeting-ops.module';
import { ProjectOpsModule } from '../project-ops/project-ops.module';
import { LeadIntakeModule } from '../lead-intake/lead-intake.module';
import { CustomersService } from './customers.service';
import { CustomersController } from './customers.controller';

/**
 * The relationship cockpit module (Phase 2 + Phase 3 + Phase 4).
 *
 * Wires the CustomersService (relationship logic + funnel + customer-360 + the
 * Phase-3 invoicing surface + the Phase-4 outreach/email surfaces + the
 * engagement→stage hook) and its REST surface. Depends on:
 *   - WorkspaceModule — the GUC chokepoint + membership guard (RLS tenancy).
 *   - AuthModule — the JwtAuthGuard for the workspace-scoped routes.
 *   - ContactOpsModule — the contact federation port (contacts resolved, never copied).
 *   - AccountingOpsModule — the AR federation port (invoices created in AO, the
 *     ledger SoR; only a thin local link is kept).
 *   - OutreachOpsModule — the Outreach app federation port (campaigns/touches in
 *     the Outreach app; only a thin local link is kept).
 *   - EmailOpsModule — the Email-Ops app federation port (mailbox threads + send
 *     in the Email-Ops app; only a thin local link is kept).
 *   - MeetingOpsModule — the Phase-5 Meeting-Ops federation port (conversation
 *     signal: meetings/summaries/action-items federated at read time to fill the
 *     customer-360 meeting slot; never copied, no local table).
 *
 * The service is exported so the MCP cockpit tools (mcp.tools) + the Phase-5
 * relationship agents reuse the exact same relationship logic an HTTP caller hits
 * — one implementation, several surfaces.
 */
@Module({
  imports: [
    WorkspaceModule,
    AuthModule,
    ContactOpsModule,
    AccountingOpsModule,
    OutreachOpsModule,
    EmailOpsModule,
    MeetingOpsModule,
    ProjectOpsModule,
    // Phase 6: provides LeadLabelResolver (provisional cockpit labels). @Optional
    // in the service, but wired here so the dogfood renders ingested leads.
    LeadIntakeModule,
  ],
  providers: [CustomersService],
  controllers: [CustomersController],
  exports: [CustomersService],
})
export class CustomersModule {}
